#!/usr/bin/env node
/**
 * tb-memory.mjs — the Toolbay Stack memory layer.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no memory layer and this file is not derived from its code; the
 * skill-per-directory layout it sits in is Garry's design. See LICENSE, NOTICE.
 *
 * THE THESIS, WHICH IS THE ONLY REASON THIS EXISTS
 *
 * Claude's own memory already saves facts, and saves them forever. Adding a
 * second store of facts would be pointless. What is missing is not a place to
 * put things, it is a rule about WHEN TO WRITE.
 *
 * The highest-signal moment in any session is the one where the user says
 * "no, not like that." That sentence contains the actual preference, and the
 * clause after it contains the reason, which is the part that transfers to the
 * next task. So this layer writes on four triggers, not on facts:
 *
 *   corrections   the user rejecting or redirecting the work. Captured WITH the
 *                 why, and refused without it, because a correction with no
 *                 reason is a rule you cannot apply anywhere else.
 *   frustration   repeats, "I already told you". That is not feedback, that is
 *                 an alarm on this system: it means we failed to remember.
 *   frequency     what gets asked for over and over, so it can be loaded before
 *                 it is asked for again.
 *   decay+supersede  newer corrections outrank older ones and take them out of
 *                 recall. A memory that only accumulates is a memory that rots.
 *
 * FOUR RULES, ALL LOAD-BEARING
 *
 *   1. THE CONFIG IS THE PRODUCT. memory.json is one hand-edited file and this
 *      code knows none of the kinds in it. Adding a kind is adding a key.
 *
 *   2. OPT-IN, AND A REAL ONE. Off until `enable --yes` on this machine. Before
 *      then `record` writes NOTHING — not a queue, not a draft, not a file.
 *      Consent lives in the state directory, never in the shipped config, so
 *      reinstalling cannot turn it on for you.
 *
 *   3. PREFERENCES AND PATTERNS, NEVER SECRETS AND NEVER SOURCE. Every field is
 *      run through the shared credential stripper BEFORE it is written and
 *      BEFORE it is sent, and text that reads as code is refused outright.
 *
 *   4. SYNC FAILS CLOSED AND NEVER BLOCKS. No token, no network, or a 5xx means
 *      memory keeps working locally and says so. A sync can never lose a local
 *      entry, and a sync response that does not parse is ignored rather than
 *      merged.
 *
 * If memory.json is missing, empty, corrupt, or defines no kinds, this layer
 * turns ITSELF OFF and says why. For a stance layer, failing closed means
 * falling back to a careful stance. For a memory layer it means capturing
 * nothing at all.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stripSecrets, PLACEHOLDER_PREFIX } from "./tb-secrets.mjs";

const VERSION = "0.1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const STORE_VERSION = 1;

/**
 * The three scope levels, narrowest last. These are structural: recall has to
 * KNOW that "global" means everywhere and "project" means one repo, so unlike
 * the kinds these names live in the code and only their labels come from
 * memory.json. Ordered widest-first so `SCOPE_LEVELS.indexOf` is the rank.
 */
const SCOPE_LEVELS = ["global", "project", "path"];

/**
 * Where an entry came from, in descending authority. `stated` is the only value
 * `record` ever writes and `imported` the only value `import` ever writes;
 * `inferred` exists so that a derived trait can be compared against an entry and
 * always lose. Nothing in this engine can write an `inferred` ENTRY at all.
 */
const SOURCES = ["stated", "imported", "inferred"];

/** Exit codes. 0 = fine, 2 = refused on purpose, 1 = this engine broke. */
const OK = 0;
const REFUSED = 2;

// ------------------------------------------------------------------- plumbing

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

export function configPath() {
  return process.env.TOOLBAY_STACK_MEMORY_FILE || path.join(SKILL_DIR, "memory.json");
}

function stateDir() {
  // The same root the guard and the modes layer use, so one env var relocates
  // every piece of Toolbay Stack state.
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

const memoryDir = () => path.join(stateDir(), "memory");
const consentPath = () => path.join(memoryDir(), "consent.json");
const storePath = () => path.join(memoryDir(), "store.json");

/** Where the Toolbay token lives. Same file and same env var as the tb client. */
function tokenConfigPath() {
  return path.join(process.env.TOOLBAY_STACK_CONFIG_DIR || path.join(os.homedir(), ".toolbay-stack"), "config.json");
}

const nowISO = () => new Date().toISOString();
const newId = (prefix = "m") => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const hash = (v) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const communityCachePath = () => path.join(memoryDir(), "community.json");

/**
 * Which project you are in, as a plain slug of the repo's directory name.
 *
 * Deliberately NOT a hash of the absolute path, for two reasons that pull the
 * same way: an absolute path is private (it carries a username) and must never
 * reach the sync wire, and a path hash would make the same repo checked out at
 * two different paths look like two different projects, so a project-scoped rule
 * would stop applying the moment you cloned it somewhere else. A folder-name
 * collision between two unrelated repos called `api` is the cost, and it is the
 * cheap side of that trade: the failure is one preference showing up in a repo
 * where it is merely irrelevant, not a private path in a payload.
 */
function projectRoot(from = process.cwd()) {
  let d;
  try {
    d = path.resolve(from);
  } catch {
    return null;
  }
  for (;;) {
    for (const marker of [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
      if (fs.existsSync(path.join(d, marker))) return d;
    }
    const up = path.dirname(d);
    if (up === d) return path.resolve(from);
    d = up;
  }
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function projectKey(from = process.cwd()) {
  if (process.env.TOOLBAY_STACK_PROJECT) return slug(process.env.TOOLBAY_STACK_PROJECT);
  const root = projectRoot(from);
  return root ? slug(path.basename(root)) : "";
}

// -------------------------------------------------------------- config loading

const asLines = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];

/**
 * A phrase matched as words rather than as a substring. `\b` is not enough on
 * its own here because these phrases end in things like "don't" and "gold-plate"
 * where the boundary lands in the middle of the idea, so the edges are asserted
 * against the character classes that would continue a word.
 */
const phraseRe = (phrase) =>
  new RegExp(`(?:^|[^a-z0-9])${String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i");
const num = (v, dflt, { min = -Infinity, max = Infinity } = {}) => {
  // null, undefined and "" are ABSENT, not zero. Number(null) is 0, which is
  // finite, so the obvious version of this helper silently turns "no --weight
  // given" into "weight 0" — an entry that is recorded, looks fine in `list`,
  // and never surfaces in recall again.
  if (v === null || v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

function normalizeKind(name, raw, warnings) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`kind "${name}" in memory.json is not an object, so it was dropped`);
    return null;
  }
  return {
    name,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : name,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    weight: num(raw.weight, 5, { min: 0, max: 100 }),
    halfLifeDays: num(raw.halfLifeDays, 365, { min: 1, max: 100000 }),
    requireWhy: Boolean(raw.requireWhy),
    supersedes: raw.supersedes !== false,
    signals: asLines(raw.signals),
  };
}

/**
 * Read memory.json. Never throws. `ok:false` means the layer is OFF, and every
 * route to off carries the reason, because a memory that silently stopped
 * recording is indistinguishable from one that had nothing to record.
 */
export function loadConfig(file = configPath()) {
  const warnings = [];
  const fail = (reason) => ({ ok: false, reason, warnings, path: file, cfg: null });

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return fail(
      err.code === "ENOENT"
        ? `memory.json not found at ${file}`
        : `memory.json at ${file} could not be read (${err.code || err.message})`,
    );
  }
  if (!text.trim()) return fail(`memory.json at ${file} is empty`);

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return fail(`memory.json at ${file} is not valid JSON (${err.message})`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail(`memory.json at ${file} is not a JSON object`);
  if (!doc.kinds || typeof doc.kinds !== "object" || Array.isArray(doc.kinds)) {
    return fail(`memory.json at ${file} has no "kinds" object, so there is nothing it could record`);
  }

  const kinds = new Map();
  for (const [name, raw] of Object.entries(doc.kinds)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      warnings.push(`kind name "${name}" is not a plain identifier, so it was dropped`);
      continue;
    }
    const k = normalizeKind(name.toLowerCase(), raw, warnings);
    if (k) kinds.set(k.name, k);
  }
  if (kinds.size === 0) return fail(`memory.json at ${file} defines no usable kinds, so there is nothing it could record`);

  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const never = obj(doc.never);
  const decay = obj(doc.decay);
  const recall = obj(doc.recall);
  const limits = obj(doc.limits);
  const sync = obj(doc.sync);
  const endpoints = obj(sync.endpoints);
  const sources = obj(doc.sources);
  const scopes = obj(doc.scopes);
  const conflicts = obj(doc.conflicts);
  const traits = obj(doc.traits);
  const imports = obj(doc.import);
  const community = obj(doc.community);

  // Scope LEVELS and source RANKS are structural, not vocabulary: "global means
  // everywhere" is a rule this code implements, unlike the kinds, which it only
  // reads. So the names are fixed here and their labels come from the file. A
  // level invented in memory.json would have no meaning for recall to apply, and
  // silently ignoring it would be worse than not offering it.
  const levelCfg = obj(scopes.levels);
  const levels = new Map(
    SCOPE_LEVELS.map((name) => {
      const raw = obj(levelCfg[name]);
      return [name, { name, label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : name, rank: num(raw.rank, SCOPE_LEVELS.indexOf(name), { min: 0, max: 99 }) }];
    }),
  );
  for (const name of Object.keys(levelCfg)) {
    if (!levels.has(name)) warnings.push(`scope level "${name}" in memory.json is not one of ${SCOPE_LEVELS.join(", ")}, so it was ignored`);
  }
  const rankCfg = obj(sources.ranks);
  const sourceRanks = {};
  for (const s of SOURCES) sourceRanks[s] = num(rankCfg[s], SOURCES.length - SOURCES.indexOf(s), { min: 0, max: 99 });
  const sourceLabels = {};
  for (const s of SOURCES) sourceLabels[s] = typeof obj(sources.labels)[s] === "string" ? obj(sources.labels)[s] : s;

  const traitCatalog = new Map();
  for (const [key, raw] of Object.entries(obj(traits.catalog))) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) {
      warnings.push(`trait key "${key}" is not a plain identifier, so it was dropped`);
      continue;
    }
    const t = obj(raw);
    const signals = asLines(t.signals).map((s) => s.toLowerCase());
    if (!signals.length || typeof t.statement !== "string" || !t.statement.trim()) {
      // A trait with no signals would match everything or nothing, and a trait
      // with no statement has nothing to say. Either way it is not derivable.
      warnings.push(`trait "${key}" has no signals or no statement, so it can never be derived and was dropped`);
      continue;
    }
    traitCatalog.set(key.toLowerCase(), {
      key: key.toLowerCase(),
      label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : key,
      statement: t.statement.trim(),
      signals,
      contradictedBy: asLines(t.contradictedBy).map((s) => s.toLowerCase()),
      // Compiled ONCE, and bounded. Substring matching looked fine on invented
      // fixtures and fell over on a real CLAUDE.md: "prove" matched "the safe
      // or proven play", and "ship" matched a list of slash-commands containing
      // "/ship", so a claim about how somebody works was being built out of
      // coincidences. A trait is a claim about a person; the evidence for it has
      // to be a word they used, not a fragment of one.
      signalRes: signals.map(phraseRe),
      contradictRes: asLines(t.contradictedBy).map((s) => phraseRe(s.toLowerCase())),
    });
  }

  const kindMap = {};
  for (const [k, v] of Object.entries(obj(imports.kindMap))) if (typeof v === "string" && v.trim()) kindMap[k.toLowerCase()] = v.trim().toLowerCase();

  return {
    ok: true,
    reason: "",
    warnings,
    path: file,
    cfg: {
      version: num(doc.version, 1),
      kinds,
      never: {
        maxTextChars: num(never.maxTextChars, 500, { min: 20, max: 5000 }),
        maxLines: num(never.maxLines, 6, { min: 1, max: 200 }),
        codeMarkers: asLines(never.codeMarkers),
        codeMarkerThreshold: num(never.codeMarkerThreshold, 2, { min: 1, max: 20 }),
        pathMarkers: asLines(never.pathMarkers),
        categoriesShownToUser: asLines(never.categoriesShownToUser),
      },
      decay: {
        floor: num(decay.floor, 0.2, { min: 0, max: 0.95 }),
        reinforceBonus: num(decay.reinforceBonus, 0.15, { min: 0, max: 5 }),
        maxReinforceMultiplier: num(decay.maxReinforceMultiplier, 2, { min: 1, max: 20 }),
      },
      recall: {
        limit: num(recall.limit, 8, { min: 1, max: 100 }),
        alwaysIncludeKinds: asLines(recall.alwaysIncludeKinds).map((s) => s.toLowerCase()),
      },
      limits: { maxEntries: num(limits.maxEntries, 400, { min: 1, max: 100000 }) },
      sync: {
        baseUrl: String(process.env.TOOLBAY_BASE_URL || sync.baseUrl || "https://toolbay.ai").replace(/\/+$/, ""),
        endpoints: {
          sync: typeof endpoints.sync === "string" ? endpoints.sync : "/api/v1/memory/sync",
          list: typeof endpoints.list === "string" ? endpoints.list : "/api/v1/memory",
          delete: typeof endpoints.delete === "string" ? endpoints.delete : "/api/v1/memory/:id",
          export: typeof endpoints.export === "string" ? endpoints.export : "/api/v1/memory/export",
        },
        timeoutMs: num(sync.timeoutMs, 8000, { min: 250, max: 120000 }),
      },
      sources: { ranks: sourceRanks, labels: sourceLabels },
      scopes: {
        default: SCOPE_LEVELS.includes(String(scopes.default || "").toLowerCase()) ? String(scopes.default).toLowerCase() : "project",
        levels,
        globalSignals: asLines(scopes.globalSignals).map((s) => s.toLowerCase()),
        projectSignals: asLines(scopes.projectSignals).map((s) => s.toLowerCase()),
        pathSignals: asLines(scopes.pathSignals).map((s) => s.toLowerCase()),
        languages: asLines(scopes.languages).map((s) => s.toLowerCase()),
      },
      conflicts: {
        similarityThreshold: num(conflicts.similarityThreshold, 0.5, { min: 0.05, max: 1 }),
        maxRivalsPerEntry: num(conflicts.maxRivalsPerEntry, 3, { min: 1, max: 20 }),
        resolutions: obj(conflicts.resolutions),
      },
      traits: {
        minEvidence: num(traits.minEvidence, 2, { min: 1, max: 100 }),
        maxShown: num(traits.maxShown, 3, { min: 1, max: 50 }),
        high: num(obj(traits.confidence).high, 4, { min: 1, max: 1000 }),
        medium: num(obj(traits.confidence).medium, 3, { min: 1, max: 1000 }),
        catalog: traitCatalog,
      },
      import: {
        maxPerImport: num(imports.maxPerImport, 60, { min: 1, max: 5000 }),
        minTextChars: num(imports.minTextChars, 12, { min: 1, max: 500 }),
        globalWhenUnderHome: imports.globalWhenUnderHome !== false,
        ruleMarkers: asLines(imports.ruleMarkers).map((s) => s.toLowerCase()),
        constraintMarkers: asLines(imports.constraintMarkers).map((s) => s.toLowerCase()),
        kindMap,
      },
      community: {
        endpoint: typeof community.endpoint === "string" && community.endpoint.trim() ? community.endpoint.trim() : "/api/v1/memory/common",
        settingsEndpoint:
          typeof community.settingsEndpoint === "string" && community.settingsEndpoint.trim() ? community.settingsEndpoint.trim() : "/api/v1/memory/settings",
        minK: num(community.minK, 5, { min: 2, max: 100000 }),
        adoptionBands: asLines(community.adoptionBands).map((s) => s.toLowerCase()),
        max: num(community.max, 5, { min: 1, max: 100 }),
        cacheHours: num(community.cacheHours, 24, { min: 0, max: 8760 }),
      },
      disclosure: obj(doc.disclosure),
      onboarding: obj(doc.onboarding),
    },
  };
}

// --------------------------------------------------------------------- consent
//
// Kept in the state directory rather than in memory.json on purpose. The shipped
// config is replaced on upgrade; consent must not be.

/**
 * Three independent switches live in this one file, and they are independent on
 * purpose:
 *
 *   optedIn               capture anything at all
 *   community.receive     accept defaults derived from other people
 *   community.contribute  let your entries feed those defaults
 *
 * Receiving does not require contributing and never will. A "share to see" toggle
 * is not consent, it is a toll.
 */
const NO_COMMUNITY = { receive: false, contribute: false, at: null };

function communityOf(doc) {
  const c = doc && doc.community && typeof doc.community === "object" && !Array.isArray(doc.community) ? doc.community : {};
  return { receive: c.receive === true, contribute: c.contribute === true, at: typeof c.at === "string" ? c.at : null };
}

function readConsent() {
  const file = consentPath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { on: false, reason: "never enabled on this machine", file, community: { ...NO_COMMUNITY } };
    return { on: false, reason: `consent file could not be read (${err.code || err.message}), so memory stays OFF`, file, community: { ...NO_COMMUNITY } };
  }
  try {
    const doc = JSON.parse(text);
    const community = communityOf(doc);
    if (!doc || doc.optedIn !== true) return { on: false, reason: "consent file does not say optedIn:true", file, community };
    return { on: true, at: doc.at || null, disclosureHash: doc.disclosureHash || null, file, community };
  } catch (err) {
    // A consent file that will not parse is NOT consent, and it is not community
    // consent either. Fail closed on every switch it was supposed to hold.
    return { on: false, reason: `consent file is not valid JSON (${err.message}), so memory stays OFF`, file, community: { ...NO_COMMUNITY } };
  }
}

/**
 * Merge rather than replace: turning community defaults on must not silently
 * re-stamp the date you opted in, and re-reading the disclosure must not wipe a
 * community choice you already made.
 */
function writeConsent(cfg, patch = {}) {
  fs.mkdirSync(memoryDir(), { recursive: true });
  let existing = {};
  try {
    const doc = JSON.parse(fs.readFileSync(consentPath(), "utf8"));
    if (doc && typeof doc === "object" && !Array.isArray(doc)) existing = doc;
  } catch {
    /* absent or unreadable: start from nothing rather than inventing consent */
  }
  const next = {
    ...existing,
    optedIn: patch.optedIn === undefined ? existing.optedIn === true : patch.optedIn === true,
    at: existing.optedIn === true && typeof existing.at === "string" && patch.optedIn !== false ? existing.at : nowISO(),
    by: "tb-memory",
    version: VERSION,
    community: { ...communityOf(existing), ...(patch.community || {}) },
  };
  if (cfg) next.disclosureHash = hash(cfg.disclosure);
  fs.writeFileSync(consentPath(), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}

// ----------------------------------------------------------------------- store

const emptyStore = () => ({
  version: STORE_VERSION,
  entries: [],
  forgotten: [],
  // Open contradictions, kept OUTSIDE the entries so that neither side of a
  // conflict has to be mutated to record that it is disputed. A conflict is a
  // relationship, and storing it on one of the two entries makes that entry the
  // implicit loser.
  conflicts: [],
  // Rejected trait keys are permanent: a derivation you threw out must not come
  // back the next time the evidence count ticks over.
  traitState: { rejected: [], accepted: {} },
  imports: [],
  lastSyncAt: null,
  lastSyncNote: null,
});

/**
 * Read the local store. A store that will not parse is reported, never
 * replaced: the same rule the Toolbay client applies to its config file. An
 * engine that "recovers" by overwriting an unreadable file has destroyed the
 * only copy of the thing the user asked it to keep.
 */
function readStore() {
  const file = storePath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, store: emptyStore(), existed: false, file };
    return { ok: false, reason: `${file} could not be read (${err.code || err.message})`, file };
  }
  if (!text.trim()) return { ok: false, reason: `${file} is empty, which is not the same as having no memories`, file };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${file} is not valid JSON (${err.message})`, file };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.entries)) {
    return { ok: false, reason: `${file} has no "entries" array`, file };
  }
  const traitState = doc.traitState && typeof doc.traitState === "object" && !Array.isArray(doc.traitState) ? doc.traitState : {};
  return {
    ok: true,
    existed: true,
    file,
    store: {
      version: num(doc.version, STORE_VERSION),
      entries: doc.entries.filter((e) => e && typeof e === "object" && typeof e.id === "string"),
      forgotten: Array.isArray(doc.forgotten) ? doc.forgotten.filter((x) => typeof x === "string") : [],
      conflicts: (Array.isArray(doc.conflicts) ? doc.conflicts : []).filter(
        (x) => x && typeof x === "object" && typeof x.id === "string" && typeof x.newId === "string" && typeof x.oldId === "string",
      ),
      traitState: {
        rejected: Array.isArray(traitState.rejected) ? traitState.rejected.filter((x) => typeof x === "string") : [],
        accepted: traitState.accepted && typeof traitState.accepted === "object" && !Array.isArray(traitState.accepted) ? traitState.accepted : {},
      },
      imports: (Array.isArray(doc.imports) ? doc.imports : []).filter((x) => x && typeof x === "object" && typeof x.id === "string"),
      lastSyncAt: typeof doc.lastSyncAt === "string" ? doc.lastSyncAt : null,
      lastSyncNote: typeof doc.lastSyncNote === "string" ? doc.lastSyncNote : null,
    },
  };
}

function writeStore(store) {
  fs.mkdirSync(memoryDir(), { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, storePath());
}

const STORE_HINT = "Nothing was written over it. Inspect it, or quarantine it and start clean:  tb-memory repair";

// ------------------------------------------------------------------- scoring

const DAY = 86400000;

function ageDays(entry) {
  const t = Date.parse(entry.createdAt || "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / DAY);
}

/** Newer beats older; reinforcement pushes back against the decay. */
function effectiveWeight(entry, cfg) {
  const kind = cfg.kinds.get(entry.kind);
  const base = Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : kind ? kind.weight : 1;
  const halfLife = kind ? kind.halfLifeDays : 365;
  const decayed = base * Math.pow(0.5, ageDays(entry) / halfLife);
  const hits = Math.max(0, num(entry.hits, 0));
  const mult = Math.min(cfg.decay.maxReinforceMultiplier, 1 + hits * cfg.decay.reinforceBonus);
  return decayed * mult;
}

/** Is this entry replaced by a newer one that names it. */
function supersededBy(entry, entries) {
  const later = entries.find((e) => e.id !== entry.id && e.supersedes === entry.id);
  return later ? later.id : null;
}

function isFaded(entry, cfg) {
  const kind = cfg.kinds.get(entry.kind);
  const base = kind ? kind.weight : Number(entry.weight) || 1;
  return base > 0 && effectiveWeight(entry, cfg) / base < cfg.decay.floor;
}

const STOPWORDS = new Set("the a an and or but to of in on for with is are was were do does did i you it this that not no".split(" "));
const terms = (s) =>
  String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9+#._-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

function matchScore(entry, query) {
  const q = terms(query);
  if (q.length === 0) return 0;
  const hay = new Set(terms(`${entry.text} ${entry.why} ${entry.about || ""}`));
  let hitCount = 0;
  for (const t of q) if (hay.has(t)) hitCount += 1;
  return hitCount / q.length;
}

// ------------------------------------------------------------- capture filters

/**
 * The never-capture rules, applied AFTER stripping. Returns null if the text is
 * allowed, or a reason naming the rule that caught it — a refusal that does not
 * say which rule fired is a refusal nobody can act on.
 */
function refuseReason(text, cfg) {
  const n = cfg.never;
  if (!text.trim()) return "there is nothing in it";
  if (text.length > n.maxTextChars) {
    return `it is ${text.length} characters and the limit is ${n.maxTextChars}. This stores preferences, not documents. Say the rule in one line.`;
  }
  const lines = text.split(/\r?\n/).length;
  if (lines > n.maxLines) return `it is ${lines} lines and the limit is ${n.maxLines}. Say the rule, not the transcript.`;
  const markersHit = n.codeMarkers.filter((m) => text.includes(m));
  if (markersHit.length >= n.codeMarkerThreshold) {
    return `it reads as source code (${markersHit.slice(0, 4).map((m) => JSON.stringify(m)).join(", ")}). This stores what you like, never what you wrote.`;
  }
  const pathHit = n.pathMarkers.find((m) => text.includes(m));
  if (pathHit) return `it contains ${JSON.stringify(pathHit)}, which points at a private path or a credentials file.`;
  return null;
}

// ---------------------------------------------------------------------- scope
//
// "No em dashes" is true everywhere. "Use tabs" is true in one repo. A flat
// store cannot tell those apart, so the second one leaks into the first one's
// projects and the agent quietly changes behaviour somewhere nobody is looking.

/** An entry's scope, with the legacy case named rather than guessed at. */
function entryScope(e) {
  const s = e && e.scope;
  if (s && typeof s === "object" && SCOPE_LEVELS.includes(s.level)) {
    return { level: s.level, value: typeof s.value === "string" && s.value ? s.value : null, assumed: false };
  }
  // Entries written before scoping existed, and entries merged from an account
  // that does not send a scope. They behaved as global, so they stay global
  // rather than being silently narrowed into never applying again — and `status`
  // counts them out loud so they can be narrowed with `rescope`.
  return { level: "global", value: null, assumed: true };
}

function scopeLabel(scope, cfg) {
  const lvl = cfg && cfg.scopes.levels.get(scope.level);
  const label = lvl ? lvl.label : scope.level;
  return scope.value ? `${label} (${scope.value})` : label;
}

const wordRe = (body, flags = "i") => new RegExp(body, flags);

/** A language or file pattern named with a preposition, so a rule ABOUT python
 *  is caught and a passing mention of python is not. */
function detectPathScope(hay, cfg) {
  const glob = /(?:^|\s)\*(\.[a-z0-9]{1,6})\b/.exec(hay);
  if (glob) return glob[1];
  const ext = /\b(?:in|for|inside)\s+\*?(\.[a-z0-9]{1,6})\s+files?\b/.exec(hay);
  if (ext) return ext[1];
  const bare = /\b(\.[a-z0-9]{1,6})\s+files?\b/.exec(hay);
  if (bare) return bare[1];
  if (cfg.scopes.languages.length) {
    const langs = cfg.scopes.languages.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const lang = wordRe(`\\b(?:in|for|when writing|when i write)\\s+(${langs})\\b`).exec(hay);
    if (lang) return lang[1].toLowerCase();
  }
  if (/\b(?:in|for)\s+(?:the\s+)?tests?\b|\btest files?\b/.test(hay)) return "test";
  return null;
}

/**
 * Work out how far a new entry reaches.
 *
 * THE TIE-BREAK IS ALWAYS NARROWER. Nothing here can return `global` unless the
 * user said something that means everywhere, or passed `--scope global`. The
 * asymmetry is the whole point: a global rule wrongly kept local just fails to
 * fire, and you notice within a session. A local rule wrongly made global
 * changes behaviour in projects you are not looking at, and you notice in a
 * week, if at all.
 */
function inferScope(text, why, flags, cfg) {
  if (flags.scope) {
    const level = String(flags.scope).toLowerCase();
    if (!SCOPE_LEVELS.includes(level)) return { error: `"${level}" is not a scope. Use: ${SCOPE_LEVELS.join(", ")}` };
    let value = flags.scopeValue ? String(flags.scopeValue).trim().toLowerCase() : null;
    if (level === "global") value = null;
    if (level === "project" && !value) value = projectKey() || "unknown-project";
    if (level === "path" && !value) return { error: "--scope path needs --scope-value (a language, an extension like .ts, or a pattern like *.tsx)" };
    return { scope: { level, value }, inferred: false, reason: "you set it explicitly" };
  }

  const hay = `${text} ${why || ""}`.toLowerCase();
  const g = cfg.scopes.globalSignals.find((s) => hay.includes(s));
  if (g) return { scope: { level: "global", value: null }, inferred: true, reason: `you said "${g}", which means everywhere` };

  const p = detectPathScope(hay, cfg);
  if (p) return { scope: { level: "path", value: p }, inferred: true, reason: `you named ${p}, so it is kept to those files` };

  const proj = cfg.scopes.projectSignals.find((s) => hay.includes(s));
  const level = cfg.scopes.default;
  const value = level === "project" ? projectKey() || "unknown-project" : null;
  return {
    scope: { level, value },
    inferred: true,
    narrowedByDefault: !proj,
    reason: proj
      ? `you said "${proj}"`
      : "nothing in what you said says how far this goes, so it was kept to this project rather than applied everywhere",
  };
}

/** Where recall is being asked FROM. */
function scopeContext(flags) {
  const file = flags.path ? String(flags.path) : null;
  return {
    project: flags.project ? slug(flags.project) : projectKey() || null,
    path: file ? file.toLowerCase().replace(/\\/g, "/") : null,
    lang: flags.lang ? String(flags.lang).toLowerCase() : null,
  };
}

function scopeApplies(entry, ctx) {
  const s = entryScope(entry);
  if (s.level === "global") return true;
  if (s.level === "project") return Boolean(ctx.project) && Boolean(s.value) && s.value === ctx.project;
  // path: with no file and no language named, a path rule does NOT apply. That
  // is the narrow answer again — recall says how many it held back rather than
  // guessing that a .ts rule was wanted for whatever you are doing.
  const v = String(s.value || "").toLowerCase();
  if (!v) return false;
  if (ctx.lang && ctx.lang === v) return true;
  if (!ctx.path) return false;
  if (v.startsWith(".")) return ctx.path.endsWith(v);
  if (v.includes("*")) {
    const re = new RegExp(`^${v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i");
    return re.test(ctx.path.split("/").pop() || ctx.path);
  }
  return ctx.path.includes(v);
}

// ------------------------------------------------------------------- sources

const entrySource = (e) => (e && SOURCES.includes(e.source) ? e.source : "stated");
const sourceRank = (e, cfg) => cfg.sources.ranks[entrySource(e)] ?? 0;

// ------------------------------------------------------------------ conflicts
//
// The rule this replaces: "a newer entry with the same subject wins, silently".
// That is how a preference set in one project breaks another, and it is also how
// a memory layer starts asserting things you would not agree with if you were
// shown them side by side. So a contradiction is now DETECTED and SURFACED, both
// entries stay, NEITHER is applied, and only you can say which of the three
// possible things is true.

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

function sameSubject(a, b, cfg) {
  if (a.about && b.about && a.about === b.about) return true;
  return jaccard(terms(`${a.text} ${a.about || ""}`), terms(`${b.text} ${b.about || ""}`)) >= cfg.conflicts.similarityThreshold;
}

const isRetracted = (e) => Boolean(e && e.retracted);

function liveEntries(entries) {
  return entries.filter((e) => !supersededBy(e, entries) && !isRetracted(e));
}

/**
 * Everything the new entry might be contradicting. Deliberately generous: a
 * candidate that cannot be classified is surfaced, never dropped. Being asked
 * about a pair that turned out to be compatible costs one command; picking a
 * side without asking costs a behaviour change nobody can trace.
 */
function findRivals(candidate, entries, cfg) {
  return liveEntries(entries)
    .filter((e) => e.id !== candidate.id)
    .filter((e) => e.text.toLowerCase() !== String(candidate.text).toLowerCase())
    .filter((e) => sameSubject(e, candidate, cfg))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, cfg.conflicts.maxRivalsPerEntry);
}

const openConflicts = (store) => (store.conflicts || []).filter((c) => c.status === "open");

/** Ids on either side of an unresolved contradiction. Neither side is applied. */
function disputedIds(store) {
  const s = new Set();
  for (const c of openConflicts(store)) {
    s.add(c.newId);
    s.add(c.oldId);
  }
  return s;
}

function printConflict(c, store, cfg) {
  const byId = new Map(store.entries.map((e) => [e.id, e]));
  const a = byId.get(c.newId);
  const b = byId.get(c.oldId);
  const line = (e, tag) => {
    if (!e) return;
    out(`    ${bold(tag)}  ${dim(e.id)}  ${cyan(`[${e.kind}]`)} ${e.text}`);
    if (e.why) out(dim(`            why: ${e.why}`));
    out(dim(`            said ${String(e.createdAt || "").slice(0, 10)}  ·  scope: ${scopeLabel(entryScope(e), cfg)}  ·  ${cfg.sources.labels[entrySource(e)]}`));
  };
  out(yellow(`  UNRESOLVED  ${c.id}`));
  line(a, "new ");
  line(b, "old ");
  out();
  out(dim("    Neither of these is being applied until you say which is true:"));
  out(`      ${cyan(`tb-memory resolve ${c.id} --replace`)}        ${dim(cfg.conflicts.resolutions.replace || "the new one replaces it")}`);
  out(`      ${cyan(`tb-memory resolve ${c.id} --both`)}           ${dim(cfg.conflicts.resolutions.contexts || "both true, in different contexts")}`);
  out(`      ${cyan(`tb-memory resolve ${c.id} --old-was-wrong`)}  ${dim(cfg.conflicts.resolutions["old-was-wrong"] || "the old one was wrong")}`);
}

// --------------------------------------------------------------------- traits
//
// A list of facts does not transfer. "They dislike X" tells you nothing about Y.
// "They optimise for shipping speed, therefore X" tells you about everything.
// That generalisation is the actual product — and it is also a guess about a
// person, so it is fenced: linked to its evidence, labelled as inferred wherever
// it appears, killed outright by anything the user actually stated against it,
// and rejectable forever in one command.

const traitHay = (e) => `${e.text} ${e.why || ""}`.toLowerCase();

function deriveTraits(store, cfg) {
  const entries = store.entries;
  const live = liveEntries(entries);
  const rejected = new Set(store.traitState.rejected);
  const traits = [];
  const suppressed = [];
  for (const t of cfg.traits.catalog.values()) {
    if (rejected.has(t.key)) continue;
    // RULE: an inference never overrides a statement. One thing the user
    // actually said against this trait ends it, however much circumstantial
    // evidence there is for it.
    const against = live.find((e) => entrySource(e) !== "inferred" && t.contradictRes.some((re) => re.test(traitHay(e))));
    const evidence = live.filter((e) => t.signalRes.some((re) => re.test(traitHay(e))));
    if (against) {
      suppressed.push({ key: t.key, label: t.label, becauseOf: against.id, becauseOfText: against.text, becauseOfSource: entrySource(against), evidenceCount: evidence.length });
      continue;
    }
    if (evidence.length < cfg.traits.minEvidence) continue;
    traits.push({
      key: t.key,
      label: t.label,
      statement: t.statement,
      // Never "stated". Never mixed into entries. Every consumer of this object
      // is told, in the object itself, that the user did not say it.
      source: "inferred",
      authority: "inferred",
      statedByUser: false,
      note: cfg.sources.labels.inferred,
      confidence: evidence.length >= cfg.traits.high ? "high" : evidence.length >= cfg.traits.medium ? "medium" : "low",
      evidenceCount: evidence.length,
      evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, text: e.text, source: entrySource(e) })),
      acknowledged: Boolean(store.traitState.accepted[t.key]),
    });
  }
  traits.sort((a, b) => b.evidenceCount - a.evidenceCount);
  return { traits, suppressed };
}

// ------------------------------------------------- community defaults (client)
//
// The server half aggregates many users and enforces k-anonymity. This half has
// exactly three jobs and no others: ask only if the user opted in to receiving,
// refuse anything under the k floor a second time on this side, and never let a
// community default outrank something the user said. Plus the standing rule of
// this whole engine: if it is not there, memory behaves as it does today.

/**
 * Read the aggregate response.
 *
 * THE WHOLE-RESPONSE CHECK COMES FIRST, and it is the one that matters. The
 * patterns carry no contributor count — by design, because a number you can
 * watch move is a number you can use to work out who moved it — so there is no
 * per-item popularity to second-guess. What there IS, is the k the response was
 * computed at, published at the top level. If that is missing, unparseable, or
 * below this client's floor, NOTHING from the response is used. Refusing the
 * whole thing is the only honest answer: a response that cannot state its own
 * k-anonymity has not demonstrated it, and adopting "most" of it would be
 * pretending the check happened.
 */
function communityDefaultsUsable(doc, cfg) {
  const skipped = [];
  const kept = [];
  const raw = Array.isArray(doc) ? doc : doc && Array.isArray(doc.patterns) ? doc.patterns : doc && Array.isArray(doc.defaults) ? doc.defaults : null;
  if (!raw) return { kept, skipped, fatal: "the body has no patterns array" };

  const k = Number(doc && !Array.isArray(doc) ? doc.kAnonymity : NaN);
  if (!Number.isFinite(k)) {
    return { kept, skipped, fatal: `the response does not say what k-anonymity it was computed at, so none of it was used` };
  }
  if (k < cfg.community.minK) {
    return { kept, skipped, fatal: `the response was computed at k=${k}, below this client's floor of ${cfg.community.minK}, so none of it was used` };
  }

  for (const d of raw) {
    if (!d || typeof d !== "object" || typeof d.text !== "string" || !d.text.trim()) {
      skipped.push({ reason: "malformed" });
      continue;
    }
    // Breadth arrives as a band, not a number. An item with no recognised band
    // has no evidence of breadth attached to it at all.
    const adoption = String(d.adoption || "").toLowerCase();
    if (cfg.community.adoptionBands.length && !cfg.community.adoptionBands.includes(adoption)) {
      skipped.push({ text: d.text.slice(0, 60), reason: `adoption "${d.adoption}" is not one of ${cfg.community.adoptionBands.join(", ")}` });
      continue;
    }
    // Stripped and rule-checked like everything else. The server states it only
    // ever emits its own canonical sentences; this side does not take that on
    // trust, because "the other end promised" is not a control.
    const st = stripSecrets(d.text);
    const sw = stripSecrets(String(d.why || ""));
    const refusal = refuseReason(st.text, cfg);
    if (refusal) {
      skipped.push({ text: d.text.slice(0, 60), reason: refusal });
      continue;
    }
    kept.push({
      id: typeof d.id === "string" ? d.id : `c_${hash(st.text)}`,
      kind: typeof d.kind === "string" ? d.kind.toLowerCase() : "pattern",
      topic: typeof d.topic === "string" ? d.topic : null,
      directive: typeof d.directive === "string" ? d.directive : null,
      text: st.text,
      why: sw.text,
      adoption,
      weight: num(d.weight, 0.5, { min: 0, max: 1 }),
      computedAtK: k,
      scope: "community",
      source: "community",
      authority: "community-default",
      statedByUser: false,
      note: "a default many people converged on. Anything you told me yourself beats it.",
      strippedLabels: [...new Set([...st.labels, ...sw.labels])],
    });
  }
  kept.sort((a, b) => b.weight - a.weight);
  return { kept: kept.slice(0, cfg.community.max), skipped, kAnonymity: k };
}

async function loadCommunity(r, { force = false } = {}) {
  const cfg = r.cfg;
  if (!cfg) return { ok: false, on: false, reason: "memory.json is unusable", defaults: [], skipped: [] };
  if (!r.consent.community.receive) {
    return { ok: false, on: false, reason: "receiving community defaults is off. Turn it on with: tb-memory community on", defaults: [], skipped: [] };
  }
  const url = `${cfg.sync.baseUrl}${cfg.community.endpoint}`;
  const cacheFile = communityCachePath();
  let cache = null;
  try {
    const doc = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (doc && Array.isArray(doc.defaults) && typeof doc.fetchedAt === "string") cache = doc;
  } catch {
    /* no cache, or an unusable one. Either way it is refetched, never repaired. */
  }
  const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < cfg.community.cacheHours * 3600000;
  if (cache && fresh && !force) return { ok: true, on: true, cached: true, source: url, fetchedAt: cache.fetchedAt, defaults: cache.defaults, skipped: [] };

  const { token } = getToken();
  const res = await httpJSON(url, { method: "GET", token: token || undefined, timeoutMs: cfg.sync.timeoutMs });
  const degrade = (reason) =>
    cache
      ? { ok: true, on: true, cached: true, stale: true, source: url, fetchedAt: cache.fetchedAt, defaults: cache.defaults, skipped: [], reason: `${reason}; using the copy fetched ${cache.fetchedAt}` }
      : { ok: false, on: true, reason, source: url, defaults: [], skipped: [] };

  if (!res.ok) {
    // Two failures are worth naming rather than lumping in with "it broke",
    // because the fix is different and the user can act on it.
    if (res.status === 401 || res.status === 403) {
      let why = `HTTP ${res.status}`;
      try {
        const e = JSON.parse(res.text);
        if (e && typeof e.error === "string") why = e.error;
      } catch {
        /* keep the status */
      }
      return degrade(
        res.status === 401
          ? `${url} needs a Toolbay token and this machine has none. Shared defaults are an account feature; everything else here works without one.`
          : `${url} says this account has shared defaults switched off (${why})`,
      );
    }
    return degrade(`${url} answered ${res.status === 0 ? res.error : `HTTP ${res.status}`}`);
  }
  let doc = null;
  try {
    doc = JSON.parse(res.text);
  } catch {
    /* handled next */
  }
  if (!doc) return degrade(`${url} answered 200 but not with JSON`);

  const { kept, skipped, fatal, kAnonymity } = communityDefaultsUsable(doc, cfg);
  if (fatal) {
    // NOT a degrade. A server that cannot demonstrate its k-anonymity is not
    // having an outage, it is failing the one check this side exists to make —
    // so the cached copy goes too. Serving yesterday's answers from a source
    // that has stopped proving itself is exactly the quiet failure the whole
    // feature is supposed to be incapable of.
    try {
      fs.rmSync(cacheFile, { force: true });
    } catch {
      /* the refusal below stands either way */
    }
    return { ok: false, on: true, refused: true, reason: `${url} answered 200 but ${fatal}`, source: url, defaults: [], skipped: [] };
  }
  try {
    fs.mkdirSync(memoryDir(), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ fetchedAt: nowISO(), source: url, kAnonymity, defaults: kept }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* a cache that will not write is not a reason to fail a recall */
  }
  return { ok: true, on: true, cached: false, source: url, fetchedAt: nowISO(), kAnonymity, defaults: kept, skipped };
}

/**
 * The account's copy of the two consents. Best effort in both directions: this
 * machine's local consent is the authority for what this machine does, and the
 * account setting is pushed as a convenience and shown so the two can be seen to
 * disagree. Nothing here can fail a command.
 */
async function accountSettings(r, patch = null) {
  const cfg = r.cfg;
  if (!cfg) return { ok: false, reason: "memory.json is unusable" };
  const { token } = getToken();
  if (!token) return { ok: false, reason: "no Toolbay token on this machine, so the account's copy was not touched" };
  const url = `${cfg.sync.baseUrl}${cfg.community.settingsEndpoint}`;
  const res = await httpJSON(url, {
    method: patch ? "PUT" : "GET",
    token,
    ...(patch ? { body: patch } : {}),
    timeoutMs: cfg.sync.timeoutMs,
  });
  if (!res.ok) return { ok: false, reason: `${url} answered ${res.status === 0 ? res.error : `HTTP ${res.status}`}` };
  try {
    const doc = JSON.parse(res.text);
    if (!doc || typeof doc !== "object") throw new Error("not an object");
    return { ok: true, url, receive: doc.receive === true, contribute: doc.contribute === true, kAnonymity: num(doc.kAnonymity, null) };
  } catch (err) {
    return { ok: false, reason: `${url} answered 200 but not with a settings body (${err.message})` };
  }
}

/** The user's own ALWAYS wins. A community default about something they have
 *  their own rule on is dropped, and the drop is reported, not hidden. */
function applyCommunity(defaults, userEntries, cfg) {
  const apply = [];
  const overridden = [];
  for (const d of defaults) {
    const mine = userEntries.find((e) => sameSubject(e, { text: d.text, about: null }, cfg));
    if (mine) overridden.push({ ...d, overriddenBy: mine.id, overriddenByText: mine.text });
    else apply.push(d);
  }
  return { apply, overridden };
}

// ------------------------------------------------------------------ resolution

/**
 * Everything a command needs, resolved once, with the reasons attached. `on` is
 * the single question the commands ask: is this layer allowed to write.
 */
function resolve({ needStore = true } = {}) {
  const conf = loadConfig();
  const consent = readConsent();
  const r = {
    conf,
    cfg: conf.cfg,
    consent,
    on: conf.ok && consent.on,
    offReason: !conf.ok ? conf.reason : !consent.on ? consent.reason : null,
    store: null,
    storeError: null,
    storeFile: storePath(),
  };
  if (needStore) {
    const s = readStore();
    if (s.ok) r.store = s.store;
    else r.storeError = s.reason;
  }
  return r;
}

function printOff(r) {
  out();
  if (!r.conf.ok) {
    out(`  ${yellow("Memory is OFF")} — ${r.conf.reason}`);
    out(dim("  A memory layer that cannot read its own policy records nothing. It does not"));
    out(dim("  guess a policy and start writing against it."));
  } else {
    out(`  ${yellow("Memory is OFF")} — ${r.consent.reason}`);
    out(dim("  Nothing has been recorded, and nothing will be until you turn it on:"));
    out();
    out(cyan("      tb-memory enable"));
    out(dim("  That prints exactly what would be captured, what never is, where it goes,"));
    out(dim("  and how to delete it. Turning it on takes a second, explicit yes."));
  }
  out();
}

// -------------------------------------------------------------------- commands

function cmdEnable(flags) {
  const conf = loadConfig();
  if (!conf.ok) {
    out();
    out(`  ${red("Cannot enable memory")}: ${conf.reason}`);
    out(dim("  Fix that file first. Nothing was written."));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const cfg = conf.cfg;
  const d = cfg.disclosure;

  if (readConsent().on && !flags.yes) {
    out();
    out(`  ${green("Memory is already on")} for this machine.  ${dim(`consent: ${consentPath()}`)}`);
    out(dim("  See everything it holds:  tb-memory status    Turn it off:  tb-memory disable"));
    out();
    return;
  }

  out();
  out(bold(`  ${d.title || "Before you turn this on"}`));
  out();
  const section = (heading, lines, colour = out) => {
    if (!asLines(lines).length) return;
    out(bold(`  ${heading}`));
    for (const l of asLines(lines)) colour(`    ${l}`);
    out();
  };
  section("WHAT GETS CAPTURED", d.captured);
  section("WHAT IS NEVER CAPTURED", d.neverCaptured);
  section("WHERE IT GOES", d.whereItGoes);
  section("HOW TO SEE IT AND DELETE IT", d.howToDelete);

  if (!flags.yes) {
    out(bold("  This is off right now, and stays off until you say so."));
    out();
    out(`  Turn it on:   ${cyan("tb-memory enable --yes")}`);
    out(`  Read the prompting guide first (60 seconds, worth it):  ${cyan("tb-memory onboard")}`);
    out();
    out(dim("  Nothing was written. `record` stores nothing while this is off."));
    out();
    return;
  }

  writeConsent(cfg, { optedIn: true });
  out(`  ${green("Memory is ON")} for this machine.  ${dim(consentPath())}`);
  out();
  printOnboarding(cfg, { compact: true });
  out(dim(`  Check what it holds at any time:  tb-memory status`));
  out(dim(`  Turn it off and wipe it:          tb-memory disable --forget-everything`));
  out();
}

function cmdDisable(flags) {
  const had = readConsent().on;
  let wiped = 0;
  try {
    if (fs.existsSync(consentPath())) fs.rmSync(consentPath());
  } catch (err) {
    out(yellow(`\n  Could not remove ${consentPath()} (${err.code || err.message})\n`));
    process.exitCode = 1;
    return;
  }
  if (flags.forgetEverything) {
    const s = readStore();
    wiped = s.ok ? s.store.entries.length : -1;
    try {
      if (fs.existsSync(storePath())) fs.rmSync(storePath());
    } catch (err) {
      out(yellow(`\n  Consent removed, but ${storePath()} could not be deleted (${err.code || err.message})\n`));
      process.exitCode = 1;
      return;
    }
  }
  out();
  out(`  ${had ? green("Memory is OFF") : dim("Memory was already off")}. Nothing further will be recorded.`);
  if (flags.forgetEverything) {
    out(`  ${green("Local store deleted")}${wiped >= 0 ? dim(` (${wiped} entr${wiped === 1 ? "y" : "ies"})`) : ""}.`);
    out(dim("  Anything already synced to your Toolbay account is not deleted by this."));
    out(dim("  Delete those with `tb-memory forget <id>` before disabling, or from your account."));
  } else {
    out(dim(`  The local store is untouched (${storePath()}).`));
    out(dim("  Delete it too with:  tb-memory disable --forget-everything"));
  }
  out();
}

function printOnboarding(cfg, { compact = false } = {}) {
  const o = cfg.onboarding || {};
  const lessons = Array.isArray(o.lessons) ? o.lessons : [];
  out(bold(`  ${o.title || "How to get better work out of the agent"}`));
  if (o.subtitle) out(dim(`  ${o.subtitle}`));
  out();
  for (const l of lessons) {
    if (!l || typeof l !== "object") continue;
    out(`  ${bold(l.heading || "")}`);
    if (l.weak) out(`      ${dim("weak  ")} ${dim(String(l.weak))}`);
    if (l.strong) out(`      ${green("strong")} ${String(l.strong)}`);
    if (l.note && !compact) out(`      ${dim(String(l.note))}`);
    out();
  }
  // Not asLines(): a blank string in `closing` is a deliberate paragraph break,
  // and filtering it out runs the two paragraphs together.
  for (const line of Array.isArray(o.closing) ? o.closing : []) out(typeof line === "string" && line.trim() ? `  ${line}` : "");
  out();
}

function cmdOnboard() {
  const conf = loadConfig();
  if (!conf.ok) {
    out();
    out(`  ${yellow("The prompting guide lives in memory.json, and that file is unusable")}: ${conf.reason}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  out();
  printOnboarding(conf.cfg);
  const on = readConsent().on;
  out(on ? dim("  Memory is ON. Every correction you say out loud is being kept.") : dim("  Memory is OFF. Turn it on with: tb-memory enable"));
  out();
}

function cmdRecord(args, flags) {
  const r = resolve();
  if (!r.on) {
    printOff(r);
    // A config this engine cannot read is a broken install and says so with a
    // refusal code. "Not opted in" is a normal, chosen state, not an error.
    process.exitCode = r.conf.ok ? OK : REFUSED;
    return;
  }
  if (r.storeError) {
    out();
    out(`  ${red("Refusing to record")}: ${r.storeError}`);
    out(dim(`  ${STORE_HINT}`));
    out();
    process.exitCode = REFUSED;
    return;
  }

  const cfg = r.cfg;
  const kindName = String(flags.kind || "correction").toLowerCase();
  const kind = cfg.kinds.get(kindName);
  if (!kind) {
    out();
    out(`  ${red("Refusing to record")}: "${kindName}" is not a kind in ${r.conf.path}`);
    out(`  Defined: ${[...cfg.kinds.keys()].join(", ")}`);
    out(dim("  Add it to that file if you want it. Nothing was written."));
    out();
    process.exitCode = REFUSED;
    return;
  }

  const rawText = args.join(" ").trim();
  const rawWhy = String(flags.why || "").trim();
  if (!rawText) {
    out(`\n  Usage: tb-memory record "<what they said>" --kind ${[...cfg.kinds.keys()].join("|")} --why "<why it matters>"\n`);
    process.exitCode = REFUSED;
    return;
  }

  // STRIPPING RUNS FIRST, on every field, before any decision is made about
  // storing. There is no path through this function where an unstripped string
  // reaches the store, and no path where an unstripped string reaches sync,
  // because sync only ever reads what this wrote.
  const st = stripSecrets(rawText);
  const sw = stripSecrets(rawWhy);
  const strippedLabels = [...new Set([...st.labels, ...sw.labels])];
  const text = st.text;
  const why = sw.text;

  if (kind.requireWhy && !why) {
    out();
    out(`  ${red("Refusing to record")}: a ${kind.label} needs a --why.`);
    out(dim("  The reason is the part that transfers to the next task. Without it this is"));
    out(dim('  a rule you cannot apply anywhere else. Not "no, redo it" — "no, shared code'));
    out(dim('  goes in src/lib so the bundler can tree-shake it".'));
    out();
    process.exitCode = REFUSED;
    return;
  }

  // Checked against BOTH the raw input and the stripped version. Redaction
  // makes text shorter, so checking only the stripped form lets a 900-character
  // paste through whenever most of it happened to look like a credential.
  const refusal =
    refuseReason(rawText, cfg) || refuseReason(text, cfg) || (why ? refuseReason(rawWhy, cfg) || refuseReason(why, cfg) : null);
  if (refusal) {
    out();
    out(`  ${red("Refusing to record")}: ${refusal}`);
    out(dim("  Nothing was written."));
    out();
    process.exitCode = REFUSED;
    return;
  }

  const entries = r.store.entries;
  const about = String(flags.about || "").trim().toLowerCase() || null;

  // `record` writes STATED and nothing else. `import` writes IMPORTED. Nothing
  // in this engine can write an entry the user never said and never imported:
  // derived beliefs are traits, they live outside the entry list, and this is
  // the door that keeps them there.
  const wantSource = String(flags.source || "stated").toLowerCase();
  if (wantSource !== "stated" && wantSource !== "imported") {
    out();
    out(`  ${red("Refusing to record")}: --source ${JSON.stringify(String(flags.source))} is not something \`record\` can write.`);
    out(dim("  `record` writes what you SAID. `import` writes what was imported. An"));
    out(dim("  inference is never an entry at all — see `tb-memory traits`, where a"));
    out(dim("  derivation stays labelled as a derivation and can be rejected."));
    out();
    process.exitCode = REFUSED;
    return;
  }

  const sc = inferScope(text, why, flags, cfg);
  if (sc.error) {
    out();
    out(`  ${red("Refusing to record")}: ${sc.error}`);
    out(dim("  Nothing was written."));
    out();
    process.exitCode = REFUSED;
    return;
  }

  let supersedes = null;
  if (flags.supersedes) {
    const target = entries.find((e) => e.id === flags.supersedes);
    if (!target) {
      out();
      out(`  ${red("Refusing to record")}: no entry with id ${bold(String(flags.supersedes))}`);
      out(dim("  Nothing was written. See the ids with:  tb-memory list"));
      out();
      process.exitCode = REFUSED;
      return;
    }
    if ((cfg.sources.ranks[wantSource] ?? 0) < sourceRank(target, cfg)) {
      out();
      out(`  ${red("Refusing to record")}: a ${wantSource} entry cannot supersede ${bold(target.id)}, which is ${entrySource(target)}.`);
      out(dim(`    ${target.text}`));
      out(dim("  Something you actually said outranks something derived or imported."));
      out(dim("  Nothing was written."));
      out();
      process.exitCode = REFUSED;
      return;
    }
    supersedes = target.id;
  }

  const sameScopeAs = (e) => {
    const s = entryScope(e);
    return s.level === sc.scope.level && (s.value || null) === (sc.scope.value || null);
  };

  // Saying the same thing again is reinforcement, not a duplicate row — but only
  // within the same scope. The same sentence said about one project and about
  // everything is two different rules, and collapsing them would quietly widen
  // the first one, which is the exact failure scoping exists to stop.
  const twin = entries.find(
    (e) => e.kind === kindName && e.text.toLowerCase() === text.toLowerCase() && !supersededBy(e, entries) && !isRetracted(e) && sameScopeAs(e),
  );
  if (twin && !supersedes) {
    twin.hits = num(twin.hits, 0) + 1;
    twin.lastSeenAt = nowISO();
    writeStore(r.store);
    out();
    out(`  ${green("reinforced")} ${dim(twin.id)}  ${twin.text}`);
    out(dim(`  said ${twin.hits + 1} times now, so it outranks things said once.`));
    out();
    return;
  }

  const entry = {
    id: newId(),
    kind: kindName,
    text,
    why: why || "",
    weight: num(flags.weight, kind.weight, { min: 0, max: 100 }),
    createdAt: nowISO(),
    supersedes,
    scope: sc.scope,
    source: wantSource,
    // Local-only fields. These are deliberately NOT part of the sync contract.
    about,
    scopeInferred: sc.inferred,
    scopeReason: sc.reason,
    retracted: null,
    hits: 0,
    lastSeenAt: nowISO(),
    strippedLabels,
    synced: false,
  };
  entries.push(entry);

  // CONFLICT DETECTION, which replaces the old silent auto-supersede. Anything
  // this new entry might be contradicting is raised as an open conflict; until
  // the user resolves it, NEITHER side is applied to any work. An explicit
  // --supersedes is the user having already decided, so it raises nothing.
  const raised = [];
  if (!supersedes) {
    for (const rival of findRivals(entry, entries, cfg)) {
      const conflict = {
        id: newId("k"),
        newId: entry.id,
        oldId: rival.id,
        status: "open",
        createdAt: nowISO(),
        detectedBy: entry.about && rival.about && entry.about === rival.about ? `both are about "${entry.about}"` : "they say close to the same thing, differently",
        resolution: null,
      };
      r.store.conflicts.push(conflict);
      raised.push(conflict);
    }
  }

  // Overflow drops the lowest-scoring entry, and says which. A silent eviction
  // is the same failure as a silent capture.
  let evicted = null;
  if (entries.length > cfg.limits.maxEntries) {
    const ranked = [...entries].sort((a, b) => effectiveWeight(a, cfg) - effectiveWeight(b, cfg));
    evicted = ranked[0];
    r.store.entries = entries.filter((e) => e.id !== evicted.id);
    // A conflict with a missing side cannot be shown or resolved, so it goes
    // with the entry rather than becoming an unresolvable prompt forever.
    r.store.conflicts = r.store.conflicts.filter((c) => c.newId !== evicted.id && c.oldId !== evicted.id);
  }
  writeStore(r.store);

  if (flags.json) {
    out(
      JSON.stringify(
        {
          recorded: entry,
          scope: { ...sc.scope, inferred: sc.inferred, reason: sc.reason, narrowedByDefault: Boolean(sc.narrowedByDefault) },
          conflicts: raised,
          evicted: evicted ? evicted.id : null,
          stripped: strippedLabels,
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  out(`  ${green("recorded")} ${dim(entry.id)}  ${bold(kind.label)}  ${dim(`· ${cfg.sources.labels[wantSource]}`)}`);
  out(`    ${entry.text}`);
  if (entry.why) out(dim(`    why: ${entry.why}`));
  out(dim(`    scope: ${scopeLabel(sc.scope, cfg)} — ${sc.reason}`));
  if (sc.narrowedByDefault) out(dim(`    widen it if it is true everywhere:  tb-memory rescope ${entry.id} --scope global`));
  if (supersedes) out(yellow(`    supersedes ${supersedes}, which will no longer be recalled`));
  if (raised.length) {
    out();
    out(yellow(`  ${raised.length} contradiction${raised.length === 1 ? "" : "s"} with what you already told me. Nothing was overwritten.`));
    out();
    for (const c of raised) {
      printConflict(c, r.store, cfg);
      out();
    }
  }
  if (strippedLabels.length) {
    out();
    out(yellow(`  ${strippedLabels.length} credential${strippedLabels.length === 1 ? "" : "s"} removed before this was written: ${strippedLabels.join(", ")}`));
    out(dim("  The preference was kept, the credential was not. It is not on disk and it"));
    out(dim("  cannot be synced, because sync only ever sends what is on disk."));
  }
  out();
}

async function cmdRecall(args, flags) {
  const r = resolve();
  if (r.storeError) {
    out();
    out(`  ${red("Cannot recall")}: ${r.storeError}`);
    out(dim(`  ${STORE_HINT}`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  if (!r.on) {
    // Recall over a store that exists but is switched off would be using data
    // the user withdrew consent for.
    if (flags.json) out(JSON.stringify({ on: false, reason: r.offReason, entries: [] }, null, 2));
    else printOff(r);
    process.exitCode = r.conf.ok ? OK : REFUSED;
    return;
  }
  const cfg = r.cfg;
  const query = args.join(" ").trim();
  const all = r.store.entries;
  const ctx = scopeContext(flags);

  const live = liveEntries(all);
  const inScope = live.filter((e) => scopeApplies(e, ctx));
  const outOfScope = live.length - inScope.length;

  // Both halves of an unresolved contradiction are held back. Applying either
  // one would be resolving it, and resolving it is not this command's call.
  const disputed = disputedIds(r.store);
  const applicable = inScope.filter((e) => !disputed.has(e.id));

  const scored = applicable
    .map((e) => ({
      entry: e,
      faded: isFaded(e, cfg),
      always: cfg.recall.alwaysIncludeKinds.includes(e.kind),
      match: matchScore(e, query),
      score: effectiveWeight(e, cfg) * (1 + 2 * matchScore(e, query)),
    }))
    .filter((s) => !s.faded)
    .filter((s) => (query ? s.match > 0 || s.always : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, num(flags.limit, cfg.recall.limit, { min: 1, max: 100 }));

  const openHere = openConflicts(r.store).filter((c) => {
    const a = all.find((e) => e.id === c.newId);
    const b = all.find((e) => e.id === c.oldId);
    return a && b && (scopeApplies(a, ctx) || scopeApplies(b, ctx));
  });

  const { traits } = deriveTraits(r.store, cfg);
  const shownTraits = traits.slice(0, cfg.traits.maxShown);

  // Community defaults are fetched LAST and are never allowed to fail a recall:
  // every route through loadCommunity returns an object, including "the endpoint
  // does not exist yet".
  const community = await loadCommunity(r);
  const applied = community.ok ? applyCommunity(community.defaults, inScope, cfg) : { apply: [], overridden: [] };

  if (flags.json) {
    out(
      JSON.stringify(
        {
          on: true,
          query: query || null,
          scope: ctx,
          count: scored.length,
          entries: scored.map((s) => ({
            ...contractEntry(s.entry),
            about: s.entry.about,
            hits: s.entry.hits,
            statedByUser: entrySource(s.entry) === "stated",
            authority: entrySource(s.entry),
            score: Number(s.score.toFixed(3)),
          })),
          outOfScope,
          heldBackByConflict: [...disputed].filter((id) => inScope.some((e) => e.id === id)).length,
          conflicts: openHere.map((c) => ({
            id: c.id,
            detectedBy: c.detectedBy,
            resolutions: cfg.conflicts.resolutions,
            sides: [c.newId, c.oldId].map((id) => {
              const e = all.find((x) => x.id === id);
              return e
                ? { id: e.id, which: id === c.newId ? "new" : "old", kind: e.kind, text: e.text, why: e.why || "", createdAt: e.createdAt, scope: entryScope(e), source: entrySource(e) }
                : { id, missing: true };
            }),
          })),
          // Deliberately NOT in `entries`. A derived trait is not something the
          // user said, and a consumer that iterates `entries` must never get one.
          inferred: {
            note: "derived from the entries below each one. The user never said these. They never override anything stated.",
            traits: shownTraits,
          },
          community: {
            on: community.on,
            ok: community.ok,
            reason: community.reason || null,
            source: community.source || null,
            note: "community defaults are other people's, not yours. Anything you told me yourself wins.",
            defaults: applied.apply,
            overriddenByYou: applied.overridden.map((d) => ({ text: d.text, overriddenBy: d.overriddenBy })),
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  if (openHere.length) {
    out(bold(yellow(`  ${openHere.length} unresolved contradiction${openHere.length === 1 ? "" : "s"} — neither side is being applied`)));
    out();
    for (const c of openHere) {
      printConflict(c, r.store, cfg);
      out();
    }
  }
  if (scored.length === 0) {
    out(`  ${dim("Nothing recalled")}${query ? dim(` for "${query}"`) : ""}.`);
    out(dim(`  ${live.length} live entr${live.length === 1 ? "y" : "ies"} held; none of them apply here.`));
    if (outOfScope) out(dim(`  ${outOfScope} of those are scoped to somewhere else and were not widened to fit.`));
    out(dim("  An empty recall is a correct answer. It is not padded with something adjacent."));
  } else {
    out(bold(`  ${scored.length} thing${scored.length === 1 ? "" : "s"} worth knowing before you start${query ? ` on "${query}"` : ""}`));
    out(dim(`  scope: ${ctx.project ? `project ${ctx.project}` : "no project detected"}${ctx.path ? `, path ${ctx.path}` : ""}${ctx.lang ? `, ${ctx.lang}` : ""}`));
    out();
    for (const s of scored) {
      const e = s.entry;
      out(`  ${cyan(`[${e.kind}]`)} ${e.text}`);
      if (e.why) out(dim(`      why: ${e.why}`));
      out(
        dim(
          `      ${e.id}  ${Math.round(ageDays(e))}d old  weight ${effectiveWeight(e, cfg).toFixed(1)}${e.hits ? `  said ${e.hits + 1}x` : ""}  ${scopeLabel(entryScope(e), cfg)}${entrySource(e) === "stated" ? "" : `  ${entrySource(e)}`}`,
        ),
      );
    }
    if (outOfScope) out(dim(`\n  ${outOfScope} more held, scoped to somewhere other than here.`));
  }
  if (shownTraits.length) {
    out();
    out(bold(`  Inferred about you — ${yellow("you never said these")}`));
    out(dim("  Derived from the entries named under each. Reject one and it stops being derived."));
    out();
    for (const t of shownTraits) {
      out(`  ${yellow("~")} ${t.statement}`);
      out(dim(`      inferred · ${t.confidence} confidence · from ${t.evidence.map((e) => e.id).join(", ")}`));
      out(dim(`      wrong?  tb-memory reject-trait ${t.key}`));
    }
  }
  if (applied.apply.length) {
    out();
    out(bold("  Community defaults") + dim("  — other people's, not yours. Yours always win."));
    out();
    for (const d of applied.apply) out(`  ${dim(`[${d.adoption}]`)} ${d.text}`);
  }
  if (applied.overridden.length) {
    out(dim(`\n  ${applied.overridden.length} community default${applied.overridden.length === 1 ? "" : "s"} dropped: you have your own rule about ${applied.overridden.length === 1 ? "it" : "them"}.`));
  }
  if (community.on && !community.ok) out(dim(`\n  Community defaults unavailable (${community.reason}). Everything above is yours and is unaffected.`));
  out();
}

function cmdList(flags) {
  const r = resolve();
  if (r.storeError) {
    out();
    out(`  ${red("Cannot list")}: ${r.storeError}`);
    out(dim(`  ${STORE_HINT}`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const all = r.store.entries;
  if (flags.json) {
    out(
      JSON.stringify(
        {
          on: r.on,
          count: all.length,
          entries: all.map((e) => ({
            ...contractEntry(e),
            about: e.about ?? null,
            hits: num(e.hits, 0),
            supersededBy: supersededBy(e, all),
            retracted: e.retracted || null,
            scopeAssumed: entryScope(e).assumed,
            scopeReason: e.scopeReason || null,
            inConflict: (r.store.conflicts || []).filter((c) => c.status === "open" && (c.newId === e.id || c.oldId === e.id)).map((c) => c.id),
            importBatch: e.importBatch || null,
            importedFrom: e.importedFrom || null,
            faded: r.cfg ? isFaded(e, r.cfg) : null,
            effectiveWeight: r.cfg ? Number(effectiveWeight(e, r.cfg).toFixed(3)) : null,
            strippedLabels: e.strippedLabels || [],
          })),
          conflicts: r.store.conflicts,
          imports: r.store.imports,
          traitState: r.store.traitState,
          forgotten: r.store.forgotten,
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  if (all.length === 0) {
    out(`  ${dim("Nothing stored.")}  ${dim(r.storeFile)}`);
    if (!r.on) out(dim(`  Memory is off: ${r.offReason}`));
    out();
    return;
  }
  out(bold(`  ${all.length} entr${all.length === 1 ? "y" : "ies"}`) + dim(`  ${r.storeFile}`));
  out(dim("  Everything is here, including entries that no longer surface in recall."));
  out();
  const open = (r.store.conflicts || []).filter((c) => c.status === "open");
  for (const e of all) {
    const sup = supersededBy(e, all);
    const disputed = open.some((c) => c.newId === e.id || c.oldId === e.id);
    const faded = r.cfg && isFaded(e, r.cfg);
    const tag = isRetracted(e)
      ? yellow("  retracted: you said this was wrong")
      : sup
        ? yellow(`  superseded by ${sup}`)
        : disputed
          ? yellow("  disputed, not applied until you resolve it")
          : faded
            ? dim("  faded out of recall")
            : "";
    out(`  ${dim(e.id)}  ${cyan(`[${e.kind}]`)} ${e.text}${tag}`);
    if (e.why) out(dim(`             why: ${e.why}`));
    out(dim(`             ${r.cfg ? scopeLabel(entryScope(e), r.cfg) : entryScope(e).level}${entrySource(e) === "stated" ? "" : ` · ${entrySource(e)}${e.importedFrom ? ` from ${e.importedFrom}` : ""}`}`));
    if ((e.strippedLabels || []).length) out(dim(`             (stripped before this was written: ${e.strippedLabels.join(", ")})`));
  }
  out();
  if (open.length) out(yellow(`  ${open.length} unresolved contradiction${open.length === 1 ? "" : "s"}:  tb-memory conflicts`));
  out(dim(`  Delete one:  tb-memory forget <id>       Everything, as JSON:  tb-memory export`));
  out(dim(`  Change a scope:  tb-memory rescope <id> --scope global|project|path`));
  out();
}

// ------------------------------------------------------------ scope correction

function cmdRescope(args, flags) {
  const r = resolve();
  if (!r.conf.ok || r.storeError) {
    out();
    out(`  ${red("Cannot rescope")}: ${r.storeError || r.conf.reason}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  const id = String(args[0] || "").trim();
  const target = r.store.entries.find((e) => e.id === id) || r.store.entries.filter((e) => e.id.startsWith(id) && id)[0];
  if (!id || !target) {
    out();
    out(`  ${red("Usage")}: tb-memory rescope <id> --scope global|project|path [--scope-value <lang|.ext|project>]`);
    if (id) out(dim(`  No entry with id ${id}. See them with:  tb-memory list`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  if (!flags.scope) {
    out();
    out(`  ${red("Refusing to rescope")}: say which scope. ${SCOPE_LEVELS.join(", ")}`);
    out(dim(`  It is currently ${scopeLabel(entryScope(target), r.cfg)}.`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const sc = inferScope("", "", flags, r.cfg);
  if (sc.error) {
    out(`\n  ${red("Refusing to rescope")}: ${sc.error}\n`);
    process.exitCode = REFUSED;
    return;
  }
  const was = scopeLabel(entryScope(target), r.cfg);
  target.scope = sc.scope;
  target.scopeInferred = false;
  target.scopeReason = "you set it explicitly with rescope";
  writeStore(r.store);
  out();
  out(`  ${green("rescoped")} ${dim(target.id)}  ${target.text}`);
  out(dim(`    was ${was} → now ${scopeLabel(sc.scope, r.cfg)}`));
  out();
}

// ------------------------------------------------------------------ conflicts

function cmdConflicts(flags) {
  const r = resolve();
  if (!r.conf.ok || r.storeError) {
    out();
    out(`  ${red("Cannot read conflicts")}: ${r.storeError || r.conf.reason}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  const all = r.store.conflicts || [];
  const open = all.filter((c) => c.status === "open");
  if (flags.json) {
    const byId = new Map(r.store.entries.map((e) => [e.id, e]));
    out(
      JSON.stringify(
        {
          open: open.length,
          resolutions: r.cfg.conflicts.resolutions,
          conflicts: all.map((c) => ({
            ...c,
            sides: [c.newId, c.oldId].map((id) => {
              const e = byId.get(id);
              return e ? { id, which: id === c.newId ? "new" : "old", text: e.text, why: e.why || "", createdAt: e.createdAt, scope: entryScope(e), source: entrySource(e) } : { id, missing: true };
            }),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  if (open.length === 0) {
    out(`  ${dim("Nothing is in dispute.")}${all.length ? dim(`  ${all.length} resolved.`) : ""}`);
    out();
    return;
  }
  out(bold(`  ${open.length} unresolved contradiction${open.length === 1 ? "" : "s"}`));
  out(dim("  Neither side of any of these is being applied to your work."));
  out();
  for (const c of open) {
    printConflict(c, r.store, r.cfg);
    out();
  }
}

function cmdResolve(args, flags) {
  const r = resolve();
  if (!r.conf.ok || r.storeError) {
    out();
    out(`  ${red("Cannot resolve")}: ${r.storeError || r.conf.reason}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  const cfg = r.cfg;
  const id = String(args[0] || "").trim();
  const conflicts = r.store.conflicts || [];
  const c = conflicts.find((x) => x.id === id) || (id ? conflicts.filter((x) => x.id.startsWith(id))[0] : null);
  if (!c) {
    out();
    out(`  ${red("No conflict with id")} ${bold(id || "(none given)")}. Nothing was changed.`);
    out(dim("  See them with:  tb-memory conflicts"));
    out();
    process.exitCode = REFUSED;
    return;
  }
  if (c.status !== "open") {
    out(`\n  ${yellow(`${c.id} was already resolved`)} as "${c.resolution}". Nothing was changed.\n`);
    process.exitCode = REFUSED;
    return;
  }
  const byId = new Map(r.store.entries.map((e) => [e.id, e]));
  const fresh = byId.get(c.newId);
  const old = byId.get(c.oldId);
  if (!fresh || !old) {
    out(`\n  ${red("One side of this conflict is gone")}, so it cannot be resolved. Closing it.\n`);
    c.status = "closed";
    c.resolution = "an entry was deleted";
    writeStore(r.store);
    process.exitCode = REFUSED;
    return;
  }

  const chosen = [flags.replace && "replace", flags.both && "contexts", flags.oldWasWrong && "old-was-wrong"].filter(Boolean);
  if (chosen.length !== 1) {
    // THE POINT OF THE WHOLE FEATURE. There is no default, there is no "pick the
    // newer one", and there is no timeout after which it decides for you.
    out();
    if (chosen.length > 1) out(`  ${red("Two resolutions at once is not a resolution.")} Pick one.`);
    else out(`  ${bold("Which of these is true?")} Nothing changes until you say.`);
    out();
    printConflict(c, r.store, cfg);
    out();
    process.exitCode = REFUSED;
    return;
  }

  if (chosen[0] === "replace") {
    // Authority: something derived or imported cannot end something you said.
    if (sourceRank(fresh, cfg) < sourceRank(old, cfg)) {
      out();
      out(`  ${red("Refusing")}: the newer entry is ${entrySource(fresh)} and the older one is ${entrySource(old)}.`);
      out(dim("  Something you actually said is not replaced by something imported or derived."));
      out(dim(`  If you do mean it, say it yourself:  tb-memory record "<the rule>" --kind ${fresh.kind} --supersedes ${old.id}`));
      out();
      process.exitCode = REFUSED;
      return;
    }
    fresh.supersedes = old.id;
    c.status = "resolved";
    c.resolution = "replace";
  } else if (chosen[0] === "contexts") {
    const setScope = (entry, level, value) => {
      if (!level) return null;
      const sc = inferScope("", "", { scope: level, scopeValue: value }, cfg);
      if (sc.error) return sc.error;
      entry.scope = sc.scope;
      entry.scopeInferred = false;
      entry.scopeReason = "you said these are both true, in different contexts";
      return null;
    };
    const e1 = setScope(fresh, flags.newScope, flags.newScopeValue);
    const e2 = setScope(old, flags.oldScope, flags.oldScopeValue);
    if (e1 || e2) {
      out(`\n  ${red("Refusing")}: ${e1 || e2}\n`);
      process.exitCode = REFUSED;
      return;
    }
    const a = entryScope(fresh);
    const b = entryScope(old);
    if (a.level === b.level && (a.value || null) === (b.value || null)) {
      out();
      out(`  ${red("Refusing")}: "both true, in different contexts" needs two different contexts.`);
      out(dim(`  Both of these are scoped ${scopeLabel(a, cfg)}, so this is the contradiction restated, not a resolution.`));
      out(dim("  Give each one its context, for example:"));
      out(dim(`    tb-memory resolve ${c.id} --both --new-scope project --old-scope global`));
      out();
      process.exitCode = REFUSED;
      return;
    }
    c.status = "resolved";
    c.resolution = "contexts";
  } else {
    old.retracted = { at: nowISO(), because: "you said this one was wrong", byEntry: fresh.id };
    c.status = "resolved";
    c.resolution = "old-was-wrong";
  }
  c.resolvedAt = nowISO();
  writeStore(r.store);

  out();
  out(`  ${green("resolved")} ${dim(c.id)}  ${bold(cfg.conflicts.resolutions[c.resolution] || c.resolution)}`);
  if (c.resolution === "replace") out(dim(`    ${old.id} is superseded and will not be recalled. It stays in \`list\`.`));
  if (c.resolution === "contexts") out(dim(`    ${scopeLabel(entryScope(fresh), cfg)}: ${fresh.text}\n    ${scopeLabel(entryScope(old), cfg)}: ${old.text}`));
  if (c.resolution === "old-was-wrong") {
    out(dim(`    ${old.id} is retracted. Not superseded — it was never right.`));
    // Deliberate asymmetry, said out loud rather than left to be discovered.
    // `--replace` is refused when it would make a lower-authority entry the
    // SUCCESSOR of something you said, because that rewrites the record.
    // Retracting your own entry is always yours to do — but if what is left
    // standing is imported, you are told, because you did not say that either.
    if (sourceRank(old, cfg) > sourceRank(fresh, cfg)) {
      out(yellow(`    note: what stays live is ${entrySource(fresh)}, not something you said.`));
      out(dim(`    You retracted the stated one yourself just now; nothing did that for you.`));
    }
  }
  out();
}

// --------------------------------------------------------------------- traits

function cmdTraits(flags) {
  const r = resolve();
  if (!r.conf.ok || r.storeError) {
    out();
    out(`  ${red("Cannot derive traits")}: ${r.storeError || r.conf.reason}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  const { traits, suppressed } = deriveTraits(r.store, r.cfg);
  if (flags.json) {
    out(
      JSON.stringify(
        {
          note: "Every one of these is INFERRED. The user did not say any of them. They never override a stated entry.",
          minEvidence: r.cfg.traits.minEvidence,
          traits,
          suppressedBySomethingYouSaid: suppressed,
          rejected: r.store.traitState.rejected,
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  out(bold("  What this adds up to") + dim("  — inferred, not stated"));
  out(dim("  A list of facts does not transfer to a new situation. A model of how you"));
  out(dim("  work does. None of this was said by you, so all of it is rejectable."));
  out();
  if (traits.length === 0) {
    out(dim(`  Nothing derived yet. A trait needs ${r.cfg.traits.minEvidence} entries pointing the same way.`));
  }
  for (const t of traits) {
    out(`  ${yellow("~")} ${bold(t.label)}${t.acknowledged ? green("  (you accepted this)") : ""}`);
    out(`      ${t.statement}`);
    out(dim(`      ${t.confidence} confidence, from ${t.evidenceCount} entr${t.evidenceCount === 1 ? "y" : "ies"}:`));
    for (const e of t.evidence.slice(0, 5)) out(dim(`        ${e.id}  ${e.text}`));
    out(dim(`      not true?  tb-memory reject-trait ${t.key}      right?  tb-memory accept-trait ${t.key}`));
    out();
  }
  for (const s of suppressed) {
    out(dim(`  (not shown: "${s.label}" — you said "${s.becauseOfText}", and what you said beats what was inferred)`));
  }
  out();
}

function cmdTraitVerdict(args, reject) {
  const r = resolve();
  if (!r.conf.ok || r.storeError) {
    out(`\n  ${red("Cannot change traits")}: ${r.storeError || r.conf.reason}\n`);
    process.exitCode = REFUSED;
    return;
  }
  const key = String(args[0] || "").trim().toLowerCase();
  if (!key || !r.cfg.traits.catalog.has(key)) {
    out();
    out(`  ${red("No trait")} ${bold(key || "(none given)")}. Defined: ${[...r.cfg.traits.catalog.keys()].join(", ") || "(none)"}`);
    out();
    process.exitCode = REFUSED;
    return;
  }
  const st = r.store.traitState;
  if (reject) {
    if (!st.rejected.includes(key)) st.rejected.push(key);
    delete st.accepted[key];
  } else {
    st.rejected = st.rejected.filter((k) => k !== key);
    st.accepted[key] = nowISO();
  }
  writeStore(r.store);
  out();
  if (reject) {
    out(`  ${green("rejected")} ${bold(key)} — it will not be derived again, however much evidence accumulates.`);
    out(dim("  Nothing you actually said was deleted. Only the guess about it."));
  } else {
    out(`  ${green("accepted")} ${bold(key)} — and it is still labelled inferred everywhere it appears.`);
    out(dim("  Agreeing with a guess does not turn it into something you said."));
  }
  out();
}

function cmdForget(args) {
  const r = resolve();
  if (r.storeError) {
    out();
    out(`  ${red("Cannot forget")}: ${r.storeError}`);
    out(dim(`  ${STORE_HINT}`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const id = String(args[0] || "").trim();
  if (!id) {
    out(`\n  Usage: tb-memory forget <id>    (see the ids with: tb-memory list)\n`);
    process.exitCode = REFUSED;
    return;
  }
  const all = r.store.entries;
  const exact = all.filter((e) => e.id === id);
  const prefixed = exact.length ? exact : all.filter((e) => e.id.startsWith(id));
  if (prefixed.length === 0) {
    out();
    out(`  ${red("No entry with id")} ${bold(id)}. Nothing was changed.`);
    out(dim(`  ${all.length} entr${all.length === 1 ? "y is" : "ies are"} stored. See them:  tb-memory list`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  if (prefixed.length > 1) {
    out();
    out(`  ${yellow(`"${id}" matches ${prefixed.length} entries`)}. Nothing was changed.`);
    for (const e of prefixed) out(dim(`    ${e.id}  ${e.text.slice(0, 60)}`));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const victim = prefixed[0];
  r.store.entries = all.filter((e) => e.id !== victim.id);
  // The tombstone is what stops the next sync merging it straight back in.
  if (!r.store.forgotten.includes(victim.id)) r.store.forgotten.push(victim.id);
  writeStore(r.store);
  out();
  out(`  ${green("forgotten")} ${dim(victim.id)}  ${victim.text}`);
  out(dim("  Removed here, and tombstoned so a sync cannot bring it back."));
  out(dim(`  It is queued for deletion from your Toolbay account on the next:  tb-memory sync`));
  out();
}

// --------------------------------------------------------------------- import
//
// A fresh install starting from zero when the person already wrote all of this
// down is waste. A CLAUDE.md, a gstack learnings store and a plain markdown
// context file are three places somebody already stated their preferences.
//
// Everything imported is marked IMPORTED forever: it was not said in a session,
// nobody gave a reason for it, and it must never be quoted back as "you told me
// this". It goes through the same stripper and the same never-capture rules as
// anything else, nothing is written until the whole list has been shown, and one
// command puts it all back.

const cleanMarkdown = (s) =>
  String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/<[^<>]{1,80}>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const hasMarker = (text, markers) => {
  const t = ` ${text.toLowerCase()} `;
  return markers.some((m) => t.includes(m.toLowerCase()));
};

function pickKind(text, cfg) {
  const want = hasMarker(text, cfg.import.constraintMarkers) ? "constraint" : "preference";
  if (cfg.kinds.has(want)) return want;
  // The config is the product: if someone renamed or removed those kinds, fall
  // back to any kind that does not demand a --why, because an import can never
  // supply one honestly. If every kind demands one, importing is impossible and
  // says so rather than inventing reasons.
  for (const k of cfg.kinds.values()) if (!k.requireWhy) return k.name;
  return null;
}

/** Bullets and numbered lines, outside code fences, with their heading. */
function parseMarkdownRules(text, cfg, { requireRule = true } = {}) {
  const candidates = [];
  const skipped = [];
  let heading = "";
  let fenced = false;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.+)$/.exec(raw);
    if (h) {
      heading = cleanMarkdown(h[2]);
      continue;
    }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!b) continue;
    const line = cleanMarkdown(b[1]);
    if (line.length < cfg.import.minTextChars) {
      skipped.push({ line: i + 1, text: line, reason: `shorter than ${cfg.import.minTextChars} characters` });
      continue;
    }
    if (requireRule && !hasMarker(line, cfg.import.ruleMarkers)) {
      skipped.push({ line: i + 1, text: line, reason: "does not read as a rule (--all imports it anyway)" });
      continue;
    }
    candidates.push({ text: line, why: "", about: slug(heading).slice(0, 40) || null, line: i + 1, kindHint: pickKind(line, cfg) });
  }
  return { candidates, skipped };
}

/** gstack / tb-learn rows: one JSON object per line. */
function parseLearnings(text, cfg) {
  const candidates = [];
  const skipped = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim().replace(/^﻿/, "");
    if (!raw) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      skipped.push({ line: i + 1, text: raw.slice(0, 60), reason: "not valid JSON, so it was left alone rather than guessed at" });
      continue;
    }
    if (!row || typeof row !== "object" || typeof row.insight !== "string" || !row.insight.trim()) {
      skipped.push({ line: i + 1, text: raw.slice(0, 60), reason: "no insight field" });
      continue;
    }
    const mapped = cfg.import.kindMap[String(row.type || "").toLowerCase()];
    const kindHint = mapped && cfg.kinds.has(mapped) ? mapped : pickKind(row.insight, cfg);
    candidates.push({ text: cleanMarkdown(row.insight), why: "", about: typeof row.key === "string" ? slug(row.key).slice(0, 40) : null, line: i + 1, kindHint });
  }
  return { candidates, skipped };
}

function learningsFiles(target) {
  const st = fs.statSync(target);
  if (!st.isDirectory()) return [target];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p, depth + 1);
      else if (it.name === "learnings.jsonl" || it.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(target, 0);
  return found.sort();
}

/**
 * Where an imported line applies. A CLAUDE.md in your home directory or under
 * ~/.claude is the file that governs every session, so it imports global; one
 * inside a repo governs that repo, so it imports scoped to it. Everything else
 * takes the narrow answer, and `--scope` overrides all of it.
 */
function importScopeFor(file, cfg, flags) {
  if (flags.scope) return inferScope("", "", flags, cfg);
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const home = os.homedir();
  const underHome = dir === home || abs.toLowerCase().startsWith(path.join(home, ".claude").toLowerCase());
  if (cfg.import.globalWhenUnderHome && underHome) {
    // The BASENAME, not the path. This string is stored on every entry the
    // import creates, and there is no reason for the store to hold the user's
    // home directory thirty-eight times to explain a scope.
    return { scope: { level: "global", value: null }, inferred: true, reason: `${path.basename(abs)} in your home directory governs every session, not one project` };
  }
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(abs);
  const key = m ? slug(m[1]) : projectKey(dir) || "unknown-project";
  return { scope: { level: "project", value: key }, inferred: true, reason: `imported from inside ${key}, so it was kept to it` };
}

const IMPORT_SOURCES = ["claude-md", "gstack-learnings", "markdown"];

function cmdImport(args, flags) {
  const r = resolve();
  if (!r.on) {
    printOff(r);
    process.exitCode = r.conf.ok ? OK : REFUSED;
    return;
  }
  if (r.storeError) {
    out(`\n  ${red("Refusing to import")}: ${r.storeError}\n  ${dim(STORE_HINT)}\n`);
    process.exitCode = REFUSED;
    return;
  }
  const cfg = r.cfg;
  const what = String(args[0] || "").toLowerCase();
  const from = flags.from || args[1];
  if (!IMPORT_SOURCES.includes(what) || !from) {
    out();
    out(`  ${red("Usage")}: tb-memory import <${IMPORT_SOURCES.join("|")}> --from <path> [--yes]`);
    out(dim("    claude-md         a CLAUDE.md, yours or a project's"));
    out(dim("    gstack-learnings  a learnings.jsonl, or a directory of them"));
    out(dim("    markdown          any notes file where you wrote your preferences down"));
    out(dim("  Without --yes it shows you every line and writes nothing."));
    out();
    process.exitCode = REFUSED;
    return;
  }

  let files;
  try {
    files = what === "gstack-learnings" ? learningsFiles(from) : [from];
    for (const f of files) fs.accessSync(f, fs.constants.R_OK);
  } catch (err) {
    out(`\n  ${red("Cannot import")}: ${from} could not be read (${err.code || err.message}). Nothing was written.\n`);
    process.exitCode = REFUSED;
    return;
  }
  if (files.length === 0) {
    out(`\n  ${yellow("Nothing to import")}: no .jsonl store under ${from}. Nothing was written.\n`);
    return;
  }

  const existing = new Set(r.store.entries.map((e) => e.text.toLowerCase()));
  const accepted = [];
  const rejected = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      rejected.push({ file, text: "", reason: `could not be read (${err.code || err.message})` });
      continue;
    }
    const parsedOne = what === "gstack-learnings" ? parseLearnings(text, cfg) : parseMarkdownRules(text, cfg, { requireRule: !flags.all });
    for (const s of parsedOne.skipped) rejected.push({ file, ...s });
    const scoped = importScopeFor(file, cfg, flags);
    if (scoped.error) {
      rejected.push({ file, text: "", reason: scoped.error });
      continue;
    }
    for (const cand of parsedOne.candidates) {
      if (accepted.length >= cfg.import.maxPerImport) {
        rejected.push({ file, ...cand, reason: `over the ${cfg.import.maxPerImport}-line cap for one import` });
        continue;
      }
      if (!cand.kindHint) {
        rejected.push({ file, ...cand, reason: "every kind in memory.json requires a --why, and an import cannot honestly supply one" });
        continue;
      }
      // THE SAME STRIPPER AND THE SAME NEVER-CAPTURE RULES AS EVERYTHING ELSE.
      // A file on disk is not more trusted than something typed in a session.
      const st = stripSecrets(cand.text);
      const refusal = refuseReason(cand.text, cfg) || refuseReason(st.text, cfg);
      if (refusal) {
        rejected.push({ file, ...cand, reason: refusal });
        continue;
      }
      if (existing.has(st.text.toLowerCase())) {
        rejected.push({ file, ...cand, reason: "already in your memory" });
        continue;
      }
      existing.add(st.text.toLowerCase());
      accepted.push({
        file,
        line: cand.line,
        kind: cand.kindHint,
        text: st.text,
        about: cand.about,
        scope: scoped.scope,
        scopeReason: scoped.reason,
        strippedLabels: st.labels,
      });
    }
  }

  // ONE gate, and everything that does not write is inside it. Two gates for the
  // same decision is how a --json dry run and a prose dry run end up disagreeing
  // about whether "dry" meant it.
  if (!flags.yes) {
    if (flags.json) {
      out(JSON.stringify({ wouldImport: accepted.length, skipped: rejected, candidates: accepted, wroteAnything: false }, null, 2));
      return;
    }
    out();
    out(bold(`  ${accepted.length} line${accepted.length === 1 ? "" : "s"} would be imported from ${files.length} file${files.length === 1 ? "" : "s"}`));
    out(dim("  Nothing has been written. This is the whole list."));
    out();
    for (const a of accepted) {
      out(`  ${cyan(`[${a.kind}]`)} ${a.text}`);
      out(dim(`      ${scopeLabel(a.scope, cfg)} · ${path.basename(a.file)}:${a.line}${a.strippedLabels.length ? yellow(`  · ${a.strippedLabels.join(", ")} stripped`) : ""}`));
    }
    if (rejected.length) {
      out();
      out(dim(`  ${rejected.length} skipped:`));
      for (const s of rejected.slice(0, 12)) out(dim(`    - ${String(s.text || "").slice(0, 54)}  (${s.reason})`));
      if (rejected.length > 12) out(dim(`    ... and ${rejected.length - 12} more`));
    }
    out();
    out(`  Import them:  ${cyan(`tb-memory import ${what} --from ${from} --yes`)}`);
    out(dim("  Every one of them is marked as imported, not as something you said, and"));
    out(dim("  the whole batch comes back out with one command."));
    out();
    return;
  }

  const batch = { id: newId("imp"), at: nowISO(), source: what, from: String(from), files: files.length, ids: [] };
  for (const a of accepted) {
    const entry = {
      id: newId(),
      kind: a.kind,
      text: a.text,
      why: "",
      weight: cfg.kinds.get(a.kind).weight,
      createdAt: nowISO(),
      supersedes: null,
      scope: a.scope,
      // Never "stated". Nobody said this in a session and nothing may pretend
      // they did — including this engine, six months from now.
      source: "imported",
      about: a.about,
      scopeInferred: true,
      scopeReason: a.scopeReason,
      retracted: null,
      hits: 0,
      lastSeenAt: nowISO(),
      strippedLabels: a.strippedLabels,
      importBatch: batch.id,
      importedFrom: `${path.basename(a.file)}:${a.line}`,
      synced: false,
    };
    r.store.entries.push(entry);
    batch.ids.push(entry.id);
  }
  r.store.imports.push(batch);
  writeStore(r.store);

  if (flags.json) {
    out(JSON.stringify({ batch: batch.id, imported: batch.ids.length, skipped: rejected.length, undo: `tb-memory unimport ${batch.id}` }, null, 2));
    return;
  }
  out();
  out(`  ${green("imported")} ${batch.ids.length} line${batch.ids.length === 1 ? "" : "s"} ${dim(`from ${from}`)}`);
  out(dim(`  batch ${batch.id}${rejected.length ? `, ${rejected.length} skipped` : ""}`));
  out(dim(`  All of them are marked "${cfg.sources.labels.imported}".`));
  out();
  out(`  Undo the whole thing:  ${cyan(`tb-memory unimport ${batch.id}`)}`);
  out();
}

function cmdImports(flags) {
  const r = resolve();
  if (r.storeError) {
    out(`\n  ${red("Cannot list imports")}: ${r.storeError}\n`);
    process.exitCode = REFUSED;
    return;
  }
  const batches = r.store.imports || [];
  if (flags.json) {
    out(JSON.stringify({ count: batches.length, batches }, null, 2));
    return;
  }
  out();
  if (!batches.length) {
    out(dim("  Nothing has been imported."));
    out(dim(`  Seed from what you already wrote down:  tb-memory import claude-md --from ./CLAUDE.md`));
    out();
    return;
  }
  for (const b of batches) {
    const live = b.ids.filter((id) => r.store.entries.some((e) => e.id === id)).length;
    out(`  ${dim(b.id)}  ${b.source}  ${dim(b.from)}`);
    out(dim(`      ${live}/${b.ids.length} still present, imported ${b.at}    undo:  tb-memory unimport ${b.id}`));
  }
  out();
}

function cmdUnimport(args) {
  const r = resolve();
  if (r.storeError) {
    out(`\n  ${red("Cannot unimport")}: ${r.storeError}\n`);
    process.exitCode = REFUSED;
    return;
  }
  const id = String(args[0] || "").trim();
  const batches = r.store.imports || [];
  const batch = batches.find((b) => b.id === id) || (id ? batches.filter((b) => b.id.startsWith(id))[0] : null);
  if (!batch) {
    out();
    out(`  ${red("No import batch")} ${bold(id || "(none given)")}. Nothing was changed.`);
    out(dim("  See them with:  tb-memory imports"));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const ids = new Set(batch.ids);
  const before = r.store.entries.length;
  r.store.entries = r.store.entries.filter((e) => !ids.has(e.id));
  // Conflicts raised against something that no longer exists cannot be shown or
  // resolved, so they go too. Anything the user STATED is untouched.
  r.store.conflicts = (r.store.conflicts || []).filter((c) => !ids.has(c.newId) && !ids.has(c.oldId));
  r.store.imports = batches.filter((b) => b.id !== batch.id);
  writeStore(r.store);
  out();
  out(`  ${green("unimported")} ${before - r.store.entries.length} entr${before - r.store.entries.length === 1 ? "y" : "ies"} ${dim(`(batch ${batch.id}, from ${batch.from})`)}`);
  out(dim("  Nothing you said yourself was touched."));
  out();
}

// ---------------------------------------------------------- community defaults

async function cmdCommunity(args, flags) {
  const r = resolve();
  const sub = String(args[0] || "status").toLowerCase();
  const cur = r.consent.community;

  // Local consent is written FIRST and is what governs this machine; the account
  // is told afterwards, best effort. That order matters: if the network is down,
  // "stop sharing" must still take effect here immediately rather than failing.
  const setFlag = async (patch, said) => {
    if (!r.conf.ok) {
      out(`\n  ${red("Cannot change this")}: ${r.conf.reason}`);
      out();
      process.exitCode = REFUSED;
      return;
    }
    writeConsent(r.cfg, { community: { ...patch, at: nowISO() } });
    out(`\n  ${green(said)}`);
    const remote = await accountSettings(r, patch);
    if (remote.ok) out(dim(`  Your account agrees: receive ${remote.receive ? "on" : "off"}, contribute ${remote.contribute ? "on" : "off"}.`));
    else out(dim(`  This machine is set. The account's copy was not updated (${remote.reason}), which changes nothing here.`));
    out();
  };

  if (sub === "on") {
    return setFlag({ receive: true }, "Community defaults will now be received. Nothing is sent by this — sending is a separate switch you have not touched.");
  }
  if (sub === "off") return setFlag({ receive: false }, "Community defaults will no longer be received or applied.");
  if (sub === "contribute") {
    const v = String(args[1] || "").toLowerCase();
    if (v !== "on" && v !== "off") {
      out(`\n  ${red("Usage")}: tb-memory community contribute on|off\n`);
      process.exitCode = REFUSED;
      return;
    }
    return setFlag(
      { contribute: v === "on" },
      v === "on"
        ? "Your entries may now feed the shared defaults. Turning this off again does not turn off receiving."
        : "Your entries will not feed the shared defaults. You still receive them if receiving is on.",
    );
  }

  if (sub === "fetch" || sub === "status") {
    const res = sub === "fetch" ? await loadCommunity(r, { force: true }) : await loadCommunity(r);
    const remote = await accountSettings(r);
    if (flags.json) {
      out(JSON.stringify({ receive: cur.receive, contribute: cur.contribute, account: remote, ...res }, null, 2));
      return;
    }
    out();
    out(`  ${bold("COMMUNITY DEFAULTS")}`);
    out(`    receiving    ${cur.receive ? green("on") : yellow("off")}   ${dim("tb-memory community on|off")}`);
    out(`    contributing ${cur.contribute ? green("on") : yellow("off")}  ${dim("tb-memory community contribute on|off")}`);
    out(dim("    These are independent. Receiving has never required contributing."));
    if (remote.ok) {
      const mismatch = remote.receive !== cur.receive || remote.contribute !== cur.contribute;
      out(dim(`    your account says: receive ${remote.receive ? "on" : "off"}, contribute ${remote.contribute ? "on" : "off"}${remote.kAnonymity ? `, k=${remote.kAnonymity}` : ""}`));
      if (mismatch) out(yellow(`    these disagree. This machine follows the local setting; re-run the command to push it up.`));
    } else out(dim(`    your account's copy was not read (${remote.reason})`));
    out();
    if (!cur.receive) {
      out(dim("    Nothing is being fetched or applied."));
    } else if (res.ok) {
      out(`    ${green(`${res.defaults.length} default${res.defaults.length === 1 ? "" : "s"} held`)} ${dim(`${res.cached ? "from cache" : "fetched"} ${res.fetchedAt}${res.kAnonymity ? `, computed at k=${res.kAnonymity}` : ""}`)}`);
      if (res.reason) out(yellow(`    ${res.reason}`));
      for (const d of res.defaults) out(dim(`      [${d.adoption}] ${d.text}`));
      if (res.skipped && res.skipped.length) out(dim(`      ${res.skipped.length} refused by this client (unrecognised adoption band, or unusable)`));
    } else {
      out(yellow(`    unavailable — ${res.reason}`));
      out(dim("    Memory is working exactly as it does with this switched off. Nothing is blocked,"));
      out(dim("    nothing is degraded, and none of your own entries are affected."));
    }
    out();
    return;
  }

  out(`\n  ${red("Unknown")}: tb-memory community [status|on|off|contribute on|off|fetch]\n`);
  process.exitCode = REFUSED;
}

/**
 * EXACTLY the nine fields in the sync contract. Nothing local rides along.
 *
 * `scope` and `source` are on the wire because they change what an entry MEANS,
 * and an entry that arrives on a second machine without them would be read as
 * "true everywhere, and you said it" — which is the widest and the most
 * authoritative reading of something that may be neither.
 *
 * `scope.value` for a project is a folder-name slug and never an absolute path,
 * so nothing here carries a username or a directory layout. `about`, `hits`,
 * `strippedLabels`, `scopeReason`, conflicts and import provenance stay local.
 */
function contractEntry(e) {
  const s = entryScope(e);
  return {
    id: e.id,
    kind: e.kind,
    text: e.text,
    why: e.why || "",
    weight: Number(e.weight),
    createdAt: e.createdAt,
    supersedes: e.supersedes ?? null,
    scope: { level: s.level, value: s.value },
    source: entrySource(e),
  };
}

async function cmdExport(flags) {
  const r = resolve();
  if (r.storeError) {
    out(JSON.stringify({ ok: false, error: r.storeError, hint: STORE_HINT }, null, 2));
    process.exitCode = REFUSED;
    return;
  }

  // `export --remote` asks the account for ITS copy, which is the honest way to
  // answer "what does Toolbay have on me" as opposed to "what does this laptop
  // have on me". It fails the same way everything else here does: you still get
  // your local export, with the reason the remote one is missing attached.
  let remoteNote = null;
  if (flags.remote && r.cfg) {
    const { token, reason } = getToken();
    if (!token) remoteNote = { ok: false, reason: `not fetched: ${reason}` };
    else {
      const url = `${r.cfg.sync.baseUrl}${r.cfg.sync.endpoints.export}`;
      const res = await httpJSON(url, { method: "GET", token, timeoutMs: r.cfg.sync.timeoutMs });
      if (res.ok) {
        try {
          out(JSON.stringify({ source: url, remote: JSON.parse(res.text) }, null, 2));
          return;
        } catch (err) {
          remoteNote = { ok: false, reason: `${url} returned 200 but not JSON (${err.message})` };
        }
      } else remoteNote = { ok: false, reason: `${url} answered ${res.status === 0 ? res.error : `HTTP ${res.status}`}` };
    }
  }
  const doc = {
    exportedAt: nowISO(),
    on: r.on,
    offReason: r.offReason,
    ...(remoteNote ? { remote: remoteNote } : {}),
    consent: r.consent.on ? { optedIn: true, at: r.consent.at } : { optedIn: false, reason: r.consent.reason },
    storeFile: r.storeFile,
    configFile: r.conf.path,
    count: r.store.entries.length,
    entries: r.store.entries,
    forgotten: r.store.forgotten,
    lastSyncAt: r.store.lastSyncAt,
    lastSyncNote: r.store.lastSyncNote,
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (flags.outFile) {
    fs.writeFileSync(flags.outFile, text, "utf8");
    out(`\n  ${green("exported")} ${r.store.entries.length} entr${r.store.entries.length === 1 ? "y" : "ies"} to ${flags.outFile}\n`);
    return;
  }
  process.stdout.write(text);
}

// ---------------------------------------------------------------------- sync

function getToken() {
  if (process.env.TOOLBAY_TOKEN) return { token: process.env.TOOLBAY_TOKEN, source: "TOOLBAY_TOKEN" };
  const file = tokenConfigPath();
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc && typeof doc.token === "string" && doc.token) return { token: doc.token, source: file };
    return { token: null, source: null, reason: `${file} has no token` };
  } catch (err) {
    return { token: null, source: null, reason: err.code === "ENOENT" ? "no Toolbay token on this machine" : `${file} could not be read (${err.code || err.message})` };
  }
}

async function httpJSON(url, { method = "GET", token, body, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push local memory to the account and merge back what it returns.
 *
 * FAILS CLOSED AND NEVER BLOCKS. Every failure path here — no token, DNS gone,
 * connection refused, timeout, 5xx, a 200 whose body is not the agreed shape —
 * ends the same way: the local store is exactly as it was, the reason is
 * printed, and the exit code is 0. Memory is not allowed to become a thing that
 * stops you working because a server is having a bad day.
 */
async function cmdSync(flags) {
  const r = resolve();
  if (!r.conf.ok) {
    printOff(r);
    process.exitCode = REFUSED;
    return;
  }
  if (r.storeError) {
    out();
    out(`  ${red("Refusing to sync")}: ${r.storeError}`);
    out(dim("  Syncing over a store this cannot read would push a guess and merge the"));
    out(dim(`  answer back on top of it. ${STORE_HINT}`));
    out();
    process.exitCode = REFUSED;
    return;
  }

  const cfg = r.cfg;
  // `contribute` is the third, independent switch. It is false unless the user
  // turned it on, it is visible in --dry-run, and receiving community defaults
  // has never required it to be true.
  const payload = { entries: r.store.entries.map(contractEntry), contribute: r.consent.community.contribute === true };

  // Belt and braces: the entries were stripped before they were written, and
  // the payload is stripped again on the way out. If a store file were edited
  // by hand to contain a key, it still would not reach the wire.
  for (const e of payload.entries) {
    e.text = stripSecrets(e.text).text;
    e.why = stripSecrets(e.why).text;
  }

  if (flags.dryRun) {
    out(JSON.stringify({ url: `${cfg.sync.baseUrl}${cfg.sync.endpoints.sync}`, method: "POST", body: payload, deletes: r.store.forgotten }, null, 2));
    return;
  }

  const { token, source, reason } = getToken();
  if (!token) {
    out();
    out(`  ${yellow("Not synced")} — ${reason}.`);
    out(dim(`  Memory is working locally and holds ${r.store.entries.length} entr${r.store.entries.length === 1 ? "y" : "ies"}. Nothing was lost.`));
    out(dim("  Local-only is a supported way to run this. If you want it on every machine:"));
    out(dim("    node ~/.claude/skills/toolbay/scripts/tb.mjs login <token>"));
    out();
    noteSync(r.store, `local only: ${reason}`);
    return;
  }

  // `--pull` is the read-only half: ask the account what it has and merge it in
  // without pushing. It exists for a fresh machine, where sending an empty
  // store first is a pointless round trip.
  const url = flags.pull ? `${cfg.sync.baseUrl}${cfg.sync.endpoints.list}` : `${cfg.sync.baseUrl}${cfg.sync.endpoints.sync}`;
  const res = flags.pull
    ? await httpJSON(url, { method: "GET", token, timeoutMs: cfg.sync.timeoutMs })
    : await httpJSON(url, { method: "POST", token, body: payload, timeoutMs: cfg.sync.timeoutMs });

  if (!res.ok) {
    const what = res.status === 0 ? res.error : `HTTP ${res.status}`;
    out();
    out(`  ${yellow("Not synced")} — ${url} answered ${what}.`);
    out(dim(`  Your ${r.store.entries.length} local entr${r.store.entries.length === 1 ? "y is" : "ies are"} untouched and memory keeps working.`));
    out(dim("  Nothing is queued for retry and nothing is dropped: the next sync sends the"));
    out(dim("  same entries again, because the local store is the source of truth."));
    out();
    noteSync(r.store, `failed: ${what}`);
    if (flags.strict) process.exitCode = 1;
    return;
  }

  let doc = null;
  try {
    doc = JSON.parse(res.text);
  } catch {
    /* handled below */
  }
  const remote = Array.isArray(doc) ? doc : doc && Array.isArray(doc.entries) ? doc.entries : null;
  if (!remote) {
    out();
    out(`  ${yellow("Not merged")} — the server answered 200 but not with an { entries: [...] } body.`);
    out(dim("  Ignored rather than merged. A response this cannot understand is not allowed"));
    out(dim(`  to rewrite what you have. ${r.store.entries.length} local entr${r.store.entries.length === 1 ? "y" : "ies"} kept.`));
    out();
    noteSync(r.store, "server response was not usable; kept local");
    if (flags.strict) process.exitCode = 1;
    return;
  }

  const before = r.store.entries.length;
  const byId = new Map(r.store.entries.map((e) => [e.id, e]));
  const mergedIds = new Set();
  let added = 0;
  let skipped = 0;
  for (const raw of remote) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.text !== "string" || typeof raw.kind !== "string") {
      skipped += 1;
      continue;
    }
    if (r.store.forgotten.includes(raw.id)) {
      skipped += 1; // tombstoned here; the account is asked to delete it below
      continue;
    }
    if (byId.has(raw.id)) continue; // local wins: never overwrite what is here
    const st = stripSecrets(raw.text);
    const sw = stripSecrets(String(raw.why || ""));
    const kind = cfg.kinds.has(raw.kind) ? raw.kind : null;
    if (!kind) {
      skipped += 1; // a kind this install does not define cannot be scored
      continue;
    }
    const entry = {
      id: raw.id,
      kind,
      text: st.text,
      why: sw.text,
      weight: num(raw.weight, cfg.kinds.get(kind).weight, { min: 0, max: 100 }),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowISO(),
      supersedes: typeof raw.supersedes === "string" ? raw.supersedes : null,
      // A scope that does not arrive is NOT invented as a project scope, because
      // a made-up project key would silently switch the entry off forever. It
      // falls back to the pre-scope behaviour and `status` counts it out loud.
      scope: raw.scope && typeof raw.scope === "object" && SCOPE_LEVELS.includes(raw.scope.level) ? { level: raw.scope.level, value: typeof raw.scope.value === "string" && raw.scope.value ? raw.scope.value : null } : null,
      source: SOURCES.includes(raw.source) ? raw.source : "stated",
      about: null,
      retracted: null,
      hits: 0,
      lastSeenAt: nowISO(),
      strippedLabels: [...new Set([...st.labels, ...sw.labels])],
      synced: true,
    };
    r.store.entries.push(entry);
    byId.set(entry.id, entry);
    mergedIds.add(entry.id);
    added += 1;
  }
  for (const e of r.store.entries) e.synced = true;

  // An entry arriving from another machine is still a new entry, so it gets the
  // same treatment: if it contradicts something already here, that is surfaced,
  // not silently merged into a store that now says two opposite things.
  const preexisting = r.store.entries.filter((e) => !mergedIds.has(e.id));
  let raisedByMerge = 0;
  for (const id of mergedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    for (const rival of findRivals(entry, preexisting, cfg)) {
      r.store.conflicts.push({
        id: newId("k"),
        newId: entry.id,
        oldId: rival.id,
        status: "open",
        createdAt: nowISO(),
        detectedBy: "it arrived from your account and contradicts something already here",
        resolution: null,
      });
      raisedByMerge += 1;
    }
  }

  // Deletions are best effort and never gate the sync. The tombstone stays
  // either way, so a failed delete cannot resurrect the entry here.
  let deleted = 0;
  const deleteFailures = [];
  for (const id of flags.pull ? [] : r.store.forgotten) {
    const dres = await httpJSON(`${cfg.sync.baseUrl}${cfg.sync.endpoints.delete.replace(":id", encodeURIComponent(id))}`, {
      method: "DELETE",
      token,
      timeoutMs: cfg.sync.timeoutMs,
    });
    if (dres.ok) deleted += 1;
    else deleteFailures.push(id);
  }

  noteSync(r.store, `ok: ${flags.pull ? 0 : before} sent, ${added} merged in`);
  out();
  out(`  ${green(flags.pull ? "pulled" : "synced")} ${dim(url)}`);
  out(`    sent      ${flags.pull ? `${dim("0 (--pull is read-only)")}` : before}`);
  out(`    merged in ${added}${skipped ? dim(`  (${skipped} from the server ignored: unknown kind, malformed, or forgotten here)`) : ""}`);
  out(`    deleted   ${deleted}${deleteFailures.length ? yellow(`  (${deleteFailures.length} could not be deleted remotely; still gone locally)`) : ""}`);
  out(`    holding   ${r.store.entries.length}`);
  if (raisedByMerge) out(yellow(`    conflicts ${raisedByMerge} merged entr${raisedByMerge === 1 ? "y" : "ies"} contradict something already here:  tb-memory conflicts`));
  out(`    sharing   ${payload.contribute ? "on — your entries may feed the shared defaults" : dim("off — nothing of yours feeds the shared defaults")}`);
  out(dim(`    token from ${source}`));
  out();
}

function noteSync(store, note) {
  store.lastSyncAt = nowISO();
  store.lastSyncNote = note;
  try {
    writeStore(store);
  } catch {
    /* a note about a sync is never worth failing a command over */
  }
}

// --------------------------------------------------------------------- status

function cmdStatus(flags) {
  const r = resolve();
  const cfg = r.cfg;
  const counts = {};
  if (r.store) for (const e of r.store.entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const live = r.store ? liveEntries(r.store.entries) : [];
  const tokenInfo = getToken();
  const byScope = {};
  const bySource = {};
  let assumedGlobal = 0;
  if (r.store) {
    for (const e of r.store.entries) {
      const s = entryScope(e);
      const key = s.value ? `${s.level}:${s.value}` : s.level;
      byScope[key] = (byScope[key] || 0) + 1;
      bySource[entrySource(e)] = (bySource[entrySource(e)] || 0) + 1;
      if (s.assumed) assumedGlobal += 1;
    }
  }
  const open = r.store ? openConflicts(r.store) : [];
  const derived = r.store && cfg ? deriveTraits(r.store, cfg) : { traits: [], suppressed: [] };

  if (flags.json) {
    out(
      JSON.stringify(
        {
          on: r.on,
          offReason: r.offReason,
          configOk: r.conf.ok,
          configPath: r.conf.path,
          configReason: r.conf.reason,
          consent: r.consent.on ? { optedIn: true, at: r.consent.at } : { optedIn: false, reason: r.consent.reason },
          storeFile: r.storeFile,
          storeError: r.storeError,
          total: r.store ? r.store.entries.length : null,
          live: r.store ? live.length : null,
          byKind: counts,
          byScope,
          bySource,
          scopeAssumedGlobal: assumedGlobal,
          project: projectKey() || null,
          openConflicts: open.length,
          traits: derived.traits.map((t) => ({ key: t.key, confidence: t.confidence, evidence: t.evidence.map((e) => e.id), source: "inferred", statedByUser: false })),
          traitsRejected: r.store ? r.store.traitState.rejected : [],
          imports: r.store ? r.store.imports.map((b) => ({ id: b.id, source: b.source, from: b.from, count: b.ids.length })) : [],
          community: {
            receive: r.consent.community.receive,
            contribute: r.consent.community.contribute,
            endpoint: cfg ? `${cfg.sync.baseUrl}${cfg.community.endpoint}` : null,
          },
          forgotten: r.store ? r.store.forgotten.length : null,
          lastSyncAt: r.store ? r.store.lastSyncAt : null,
          lastSyncNote: r.store ? r.store.lastSyncNote : null,
          syncTarget: cfg ? `${cfg.sync.baseUrl}${cfg.sync.endpoints.sync}` : null,
          tokenPresent: Boolean(tokenInfo.token),
          kinds: cfg ? [...cfg.kinds.keys()] : [],
          neverCaptured: cfg ? cfg.never.categoriesShownToUser : [],
        },
        null,
        2,
      ),
    );
    return;
  }

  out();
  out(`  ${bold("MEMORY")}  ${r.on ? green("ON") : yellow("OFF")}${r.on ? "" : dim(`  — ${r.offReason}`)}`);
  out();
  out(`  ${dim("config ")} ${r.conf.path}${r.conf.ok ? "" : red("  UNUSABLE")}`);
  if (!r.conf.ok) out(red(`           ${r.conf.reason}`));
  out(`  ${dim("store  ")} ${r.storeFile}${r.storeError ? red("  UNREADABLE") : ""}`);
  if (r.storeError) out(red(`           ${r.storeError}`));
  if (r.consent.on) out(`  ${dim("consent")} given ${r.consent.at || "(no date recorded)"}`);
  else out(`  ${dim("consent")} ${yellow("not given")} — ${r.consent.reason}`);

  if (r.consent.on && cfg && r.consent.disclosureHash && r.consent.disclosureHash !== hash(cfg.disclosure)) {
    out(yellow(`           the disclosure has changed since you agreed to it; re-read it with: tb-memory enable`));
  }

  if (r.store) {
    out();
    out(bold("  What I have on you"));
    if (r.store.entries.length === 0) {
      out(dim("    nothing at all"));
    } else {
      out(`    ${r.store.entries.length} entr${r.store.entries.length === 1 ? "y" : "ies"}, ${live.length} still live${r.store.entries.length - live.length ? dim(`, ${r.store.entries.length - live.length} superseded`) : ""}`);
      for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) out(dim(`      ${String(n).padStart(4)}  ${k}`));
      const stripped = r.store.entries.filter((e) => (e.strippedLabels || []).length).length;
      if (stripped) out(dim(`      ${String(stripped).padStart(4)}  had a credential stripped out before being written`));
      out();
      out(`    ${dim("where each applies")}`);
      for (const [k, n] of Object.entries(byScope).sort((a, b) => b[1] - a[1])) out(dim(`      ${String(n).padStart(4)}  ${k}`));
      out(`    ${dim("where each came from")}`);
      for (const [k, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) out(dim(`      ${String(n).padStart(4)}  ${k}${k === "stated" ? "" : "  (never quoted back as something you said)"}`));
      if (assumedGlobal) {
        out(yellow(`      ${String(assumedGlobal).padStart(4)}  arrived without a scope and are being treated as global`));
        out(dim(`            narrow one with:  tb-memory rescope <id> --scope project`));
      }
    }
    if (r.store.forgotten.length) out(dim(`    ${r.store.forgotten.length} forgotten (tombstoned so a sync cannot bring them back)`));
    out();
    out(`  ${bold("Contradictions")}  ${open.length ? yellow(`${open.length} unresolved — neither side is being applied`) : dim("none")}`);
    if (open.length) out(dim(`    See both sides and choose:  tb-memory conflicts`));
    out(`  ${bold("Inferred")}        ${derived.traits.length ? `${derived.traits.length} trait${derived.traits.length === 1 ? "" : "s"} derived` : dim("nothing derived yet")}${r.store.traitState.rejected.length ? dim(`, ${r.store.traitState.rejected.length} rejected`) : ""}`);
    out(dim(`    Derived, not stated. See the evidence for each:  tb-memory traits`));
    out(`  ${bold("Project")}         ${projectKey() || dim("none detected here")}`);
  }

  if (cfg) {
    out();
    out(bold("  Never captured"));
    for (const l of cfg.never.categoriesShownToUser) out(dim(`    - ${l}`));
    out();
    out(bold("  Sync"));
    out(`    target   ${dim(`${cfg.sync.baseUrl}${cfg.sync.endpoints.sync}`)}`);
    out(`    token    ${tokenInfo.token ? green("present") : yellow(`none — local only (${tokenInfo.reason})`)}`);
    if (r.store && r.store.lastSyncAt) out(`    last     ${r.store.lastSyncAt} ${dim(r.store.lastSyncNote || "")}`);
    else out(dim("    last     never"));
    out();
    out(bold("  Community defaults"));
    out(`    receiving     ${r.consent.community.receive ? green("on") : yellow("off")}`);
    out(`    contributing  ${r.consent.community.contribute ? green("on") : yellow("off")}   ${dim("independent of receiving, in both directions")}`);
    out(dim(`    ${cfg.sync.baseUrl}${cfg.community.endpoint} — if it is not there, everything above is unaffected`));
  }

  out();
  out(dim("  Everything:  tb-memory list      Full copy:  tb-memory export"));
  out(dim("  Delete one:  tb-memory forget <id>          Stop and wipe:  tb-memory disable --forget-everything"));
  out();
}

function cmdRepair(flags) {
  const s = readStore();
  if (s.ok) {
    out(`\n  ${green("The store is readable")}; there is nothing to repair. ${dim(s.file)}\n`);
    return;
  }
  if (!flags.yes) {
    out();
    out(`  ${yellow("The store is unreadable")}: ${s.reason}`);
    out(dim("  Nothing has been written over it. `repair --yes` renames it out of the way"));
    out(dim("  and starts a clean store. The damaged file is kept, not deleted."));
    out();
    process.exitCode = REFUSED;
    return;
  }
  const quarantine = `${s.file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(s.file, quarantine);
  } catch (err) {
    out(`\n  ${red("Could not move")} ${s.file} (${err.code || err.message})\n`);
    process.exitCode = 1;
    return;
  }
  writeStore(emptyStore());
  out();
  out(`  ${green("repaired")}. The damaged file is at ${dim(quarantine)} and a clean store is in place.`);
  out(dim("  Nothing was deleted. If you can salvage entries from that file, paste them back in."));
  out();
}

// -------------------------------------------------------------------- selftest
//
// Every case below is a way this engine could betray the person using it: by
// recording when it was never turned on, by writing a key to disk, by putting a
// key on the wire, by losing an entry because a server was down, by overwriting
// a store it could not read, or by still acting on advice the user has since
// overruled.

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", TOOLBAY_TOKEN: "", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function runSelfAsync(args, env = {}) {
  return new Promise((resolve2) => {
    const p = spawn(process.execPath, [SELF, ...args], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", TOOLBAY_TOKEN: "", ...env },
    });
    let so = "";
    let se = "";
    p.stdout.on("data", (d) => (so += d));
    p.stderr.on("data", (d) => (se += d));
    p.on("close", (status) => resolve2({ status, stdout: so, stderr: se }));
  });
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-memory-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const GOOD = path.join(SKILL_DIR, "memory.json");
  const write = (name, body) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, body, "utf8");
    return f;
  };
  const CORRUPT = write("corrupt.json", '{ "kinds": { "correction": ');
  const BLANK = write("blank.json", "   \n");
  const NO_KINDS = write("no-kinds.json", '{ "version": 1, "kinds": {} }\n');
  const MISSING = path.join(tmp, "does-not-exist.json");

  let n = 0;
  const freshState = () => {
    const d = path.join(tmp, `state-${(n += 1)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const env = (sd, file = GOOD, extra = {}) => ({
    TOOLBAY_STACK_STATE_DIR: sd,
    TOOLBAY_STACK_MEMORY_FILE: file,
    TOOLBAY_STACK_CONFIG_DIR: path.join(sd, "no-token-here"),
    ...extra,
  });
  const storeFileOf = (sd) => path.join(sd, "memory", "store.json");
  const storeText = (sd) => (fs.existsSync(storeFileOf(sd)) ? fs.readFileSync(storeFileOf(sd), "utf8") : "");
  const entriesOf = (sd) => {
    const t = storeText(sd);
    return t ? JSON.parse(t).entries : [];
  };
  const enable = (sd, file = GOOD) => runSelf(["enable", "--yes"], env(sd, file));

  const SECRET = "sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUUTTTT";

  // ---- REQUIRED: no config at all. Records nothing, says why.
  for (const [label, file] of [
    ["missing config", MISSING],
    ["corrupt config", CORRUPT],
    ["blank config", BLANK],
    ["config with no kinds", NO_KINDS],
  ]) {
    const sd = freshState();
    // Consent is deliberately granted first, so the ONLY thing stopping the
    // write is the broken config.
    fs.mkdirSync(path.join(sd, "memory"), { recursive: true });
    fs.writeFileSync(path.join(sd, "memory", "consent.json"), JSON.stringify({ optedIn: true, at: nowISO() }), "utf8");
    const r = runSelf(["record", "no, not like that", "--why", "because"], env(sd, file));
    check(`${label}: refuses to record`, REFUSED, r.status, r.stdout.slice(0, 160));
    check(`${label}: writes no store file at all`, false, fs.existsSync(storeFileOf(sd)), storeText(sd).slice(0, 120));
    check(`${label}: says memory is OFF`, true, /Memory is OFF/.test(r.stdout), r.stdout.slice(0, 160));
    check(`${label}: says why`, true, /not found|not valid JSON|is empty|no usable kinds/.test(r.stdout), r.stdout.slice(0, 200));
    const st = runSelf(["status", "--json"], env(sd, file));
    check(`${label}: status still answers`, 0, st.status, st.stderr.slice(0, 120));
    check(`${label}: status reports off`, false, JSON.parse(st.stdout || "{}").on);
  }

  // ---- REQUIRED: opt-in never given. Records NOTHING.
  {
    const sd = freshState();
    const r = runSelf(["record", "no, not like that", "--why", "shared code goes in src/lib"], env(sd));
    check("no opt-in: exits 0 (off is a chosen state, not an error)", 0, r.status, r.stdout.slice(0, 160));
    check("no opt-in: writes NOTHING to disk", false, fs.existsSync(storeFileOf(sd)), storeText(sd).slice(0, 120));
    check("no opt-in: says nothing was recorded", true, /Nothing has been recorded/.test(r.stdout), r.stdout.slice(0, 200));
    check("no opt-in: tells you how to turn it on", true, /tb-memory enable/.test(r.stdout));

    // `enable` without --yes is a disclosure, not consent.
    const shown = runSelf(["enable"], env(sd));
    check("enable without --yes: exits 0", 0, shown.status, shown.stderr.slice(0, 120));
    check("enable without --yes: does NOT opt you in", false, fs.existsSync(path.join(sd, "memory", "consent.json")));
    check("enable without --yes: discloses what is captured", true, /WHAT GETS CAPTURED/.test(shown.stdout));
    check("enable without --yes: discloses what never is", true, /WHAT IS NEVER CAPTURED/.test(shown.stdout));
    check("enable without --yes: says where it goes", true, /WHERE IT GOES/.test(shown.stdout));
    check("enable without --yes: says how to delete it", true, /HOW TO SEE IT AND DELETE IT/.test(shown.stdout));
    const after = runSelf(["record", "no, not like that", "--why", "x"], env(sd));
    check("...and after reading the disclosure, still records nothing", false, fs.existsSync(storeFileOf(sd)), after.stdout.slice(0, 120));

    // A consent file that will not parse is not consent.
    fs.mkdirSync(path.join(sd, "memory"), { recursive: true });
    fs.writeFileSync(path.join(sd, "memory", "consent.json"), "{ not json", "utf8");
    const broken = runSelf(["record", "no, not like that", "--why", "x"], env(sd));
    check("a corrupt consent file is NOT consent", false, fs.existsSync(storeFileOf(sd)), broken.stdout.slice(0, 160));
    fs.writeFileSync(path.join(sd, "memory", "consent.json"), JSON.stringify({ optedIn: false }), "utf8");
    const denied = runSelf(["record", "no, not like that", "--why", "x"], env(sd));
    check("optedIn:false is NOT consent", false, fs.existsSync(storeFileOf(sd)), denied.stdout.slice(0, 160));
  }

  // ---- REQUIRED: a secret in the input never reaches the store OR the wire.
  const secretState = freshState();
  {
    const sd = secretState;
    enable(sd);
    const r = runSelf(
      ["record", `no, do not hardcode ${SECRET} in the client`, "--why", `keys like ${SECRET} belong in the env, not the repo`],
      env(sd),
    );
    check("secret in a correction: still records the preference", 0, r.status, r.stdout.slice(0, 200));
    check("secret in a correction: says a credential was removed", true, /credential.* removed/i.test(r.stdout), r.stdout.slice(0, 300));
    const raw = storeText(sd);
    check("secret is NOT in the store file", false, raw.includes(SECRET), raw.slice(0, 200));
    check("secret is NOT in the store, even in the why field", false, raw.includes("sk-ant-"), raw.slice(0, 200));
    check("the placeholder IS in the store, so the redaction is auditable", true, raw.includes(PLACEHOLDER_PREFIX));
    check("the preference itself survived", true, /do not hardcode/.test(raw));
    const dry = runSelf(["sync", "--dry-run"], env(sd));
    check("secret is NOT in the sync payload", false, dry.stdout.includes(SECRET), dry.stdout.slice(0, 300));
    check("secret is NOT in the sync payload in any form", false, /sk-ant-/.test(dry.stdout), dry.stdout.slice(0, 300));
    const exported = runSelf(["export"], env(sd));
    check("secret is NOT in the export either", false, exported.stdout.includes(SECRET));

    // The payload carries the nine contract fields and nothing else.
    const body = JSON.parse(dry.stdout).body;
    const keys = Object.keys(body.entries[0]).sort().join(",");
    check("sync payload carries exactly the contract fields", "createdAt,id,kind,scope,source,supersedes,text,weight,why", keys, keys);
    check("sync payload does not leak local-only fields", false, /"about"|"hits"|"strippedLabels"|"synced"|"scopeReason"|"importBatch"/.test(dry.stdout));
    check("sync payload carries no absolute path in the scope", false, /[A-Za-z]:\\\\|\/Users\/|\/home\//.test(dry.stdout), dry.stdout.slice(0, 200));
    check("sync payload says contributing is OFF unless it was turned on", false, body.contribute, dry.stdout.slice(0, 200));
  }

  // ---- A hand-edited store containing a key still cannot reach the wire.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "keep tables terse", "--kind", "preference"], env(sd));
    const doc = JSON.parse(storeText(sd));
    doc.entries[0].text = `use ${SECRET} for auth`;
    fs.writeFileSync(storeFileOf(sd), JSON.stringify(doc), "utf8");
    const dry = runSelf(["sync", "--dry-run"], env(sd));
    check("a key hand-edited into the store is stripped on the way out", false, dry.stdout.includes(SECRET), dry.stdout.slice(0, 200));
  }

  // ---- Never capture source, paths, or documents.
  {
    const sd = freshState();
    enable(sd);
    const code = runSelf(["record", "function foo() { const x = 1; }", "--kind", "preference"], env(sd));
    check("code is refused", REFUSED, code.status, code.stdout.slice(0, 160));
    check("...and says which rule caught it", true, /reads as source code/.test(code.stdout), code.stdout.slice(0, 200));
    const long = runSelf(["record", "x".repeat(900), "--kind", "preference"], env(sd));
    check("a document-length entry is refused", REFUSED, long.status, long.stdout.slice(0, 160));
    const pathy = runSelf(["record", "the key is in /home/bob/.env", "--kind", "preference"], env(sd));
    check("a private path is refused", REFUSED, pathy.status, pathy.stdout.slice(0, 160));
    check("...and nothing was stored by any of them", 0, entriesOf(sd).length, storeText(sd).slice(0, 120));

    const noWhy = runSelf(["record", "no, not like that"], env(sd));
    check("a correction with no why is refused", REFUSED, noWhy.status, noWhy.stdout.slice(0, 160));
    check("...because the why is the part that transfers", true, /transfers to the next task/.test(noWhy.stdout));
    const badKind = runSelf(["record", "something", "--kind", "vibes"], env(sd));
    check("an undefined kind is refused", REFUSED, badKind.status, badKind.stdout.slice(0, 160));
    check("...and lists the kinds that ARE defined", true, /correction, frustration/.test(badKind.stdout), badKind.stdout.slice(0, 200));
    check("still nothing stored", 0, entriesOf(sd).length);
  }

  // ---- REQUIRED: a contradiction is DETECTED and SURFACED, never resolved
  //      silently, and neither side is applied until the user picks.
  const supersedeState = freshState();
  {
    const sd = supersedeState;
    enable(sd);
    runSelf(["record", "put shared helpers in utils.js", "--kind", "correction", "--why", "one place for helpers", "--about", "helpers"], env(sd));
    const first = entriesOf(sd)[0].id;
    const second = runSelf(
      ["record", "put shared helpers in src/lib, not utils.js", "--kind", "correction", "--why", "so the bundler can tree-shake them", "--about", "helpers"],
      env(sd),
    );
    const secondId = entriesOf(sd)[1].id;
    check("a newer correction about the same subject does NOT silently win", false, /supersedes m_/.test(second.stdout), second.stdout.slice(0, 400));
    check("...it is raised as a contradiction instead", true, /UNRESOLVED/.test(second.stdout), second.stdout.slice(0, 400));
    check("...showing both entries", true, second.stdout.includes(first) && second.stdout.includes(secondId), second.stdout.slice(0, 400));
    check("...with the why of each", true, /one place for helpers/.test(second.stdout) && /tree-shake/.test(second.stdout));
    check("...with the date of each", true, (second.stdout.match(/said \d{4}-\d{2}-\d{2}/g) || []).length >= 2, second.stdout.slice(0, 400));
    check("...and all three resolutions offered", true, /--replace/.test(second.stdout) && /--both/.test(second.stdout) && /--old-was-wrong/.test(second.stdout));
    check("...and NOTHING was overwritten", true, /Nothing was overwritten/.test(second.stdout));
    check("...and the older entry is not superseded in the store", null, entriesOf(sd)[0].supersedes);

    const recall = JSON.parse(runSelf(["recall", "where do shared helpers go", "--json"], env(sd)).stdout);
    const ids = recall.entries.map((e) => e.id);
    check("neither side of an open contradiction is applied", false, ids.includes(first) || ids.includes(secondId), JSON.stringify(ids));
    check("...but recall surfaces the contradiction itself", 1, recall.conflicts.length, JSON.stringify(recall.conflicts).slice(0, 200));
    check("...with both sides in it", 2, recall.conflicts[0].sides.length);
    check("...each side carrying its own why", true, recall.conflicts[0].sides.every((s) => typeof s.why === "string" && s.why.length > 0));
    check("...each side carrying its own date", true, recall.conflicts[0].sides.every((s) => /^\d{4}-\d{2}-\d{2}/.test(String(s.createdAt))));
    check("...and the three resolutions named", 3, Object.keys(recall.conflicts[0].resolutions).length, JSON.stringify(recall.conflicts[0].resolutions));

    const listed = JSON.parse(runSelf(["list", "--json"], env(sd)).stdout);
    check("`list` still shows both, because 'what do you have on me' must be complete", 2, listed.entries.length);
    check("...and marks them as in conflict", true, listed.entries.every((e) => e.inConflict.length === 1), JSON.stringify(listed.entries.map((e) => e.inConflict)));

    const noChoice = runSelf(["resolve", recall.conflicts[0].id], env(sd));
    check("`resolve` with no choice REFUSES rather than picking one", REFUSED, noChoice.status, noChoice.stdout.slice(0, 200));
    check("...and asks which is true", true, /Which of these is true/.test(noChoice.stdout), noChoice.stdout.slice(0, 200));
    const twoChoices = runSelf(["resolve", recall.conflicts[0].id, "--replace", "--both"], env(sd));
    check("two resolutions at once is refused", REFUSED, twoChoices.status, twoChoices.stdout.slice(0, 200));
    check("...and the conflict is still open", 1, JSON.parse(runSelf(["conflicts", "--json"], env(sd)).stdout).open);

    const done = runSelf(["resolve", recall.conflicts[0].id, "--replace"], env(sd));
    check("resolving with --replace works", 0, done.status, done.stdout.slice(0, 200));
    const after = JSON.parse(runSelf(["recall", "where do shared helpers go", "--json"], env(sd)).stdout);
    check("after resolving, the winner IS recalled", true, after.entries.some((e) => /src\/lib/.test(e.text)), JSON.stringify(after.entries.map((e) => e.text)));
    check("...and the loser is not", false, after.entries.some((e) => e.id === first), JSON.stringify(after.entries.map((e) => e.id)));
    check("...and no conflict is left open", 0, after.conflicts.length);
    const listed2 = JSON.parse(runSelf(["list", "--json"], env(sd)).stdout);
    check("...and `list` still has the superseded one", true, Boolean(listed2.entries.find((e) => e.id === first).supersededBy));
    check("resolving an already-resolved conflict is refused", REFUSED, runSelf(["resolve", recall.conflicts[0].id, "--replace"], env(sd)).status);
    check("resolving an unknown conflict id is refused", REFUSED, runSelf(["resolve", "k_nope", "--replace"], env(sd)).status);

    const badSupersede = runSelf(["record", "x", "--kind", "preference", "--supersedes", "m_nope"], env(sd));
    check("--supersedes with an unknown id is refused", REFUSED, badSupersede.status, badSupersede.stdout.slice(0, 160));
    check("...and nothing was written", 2, entriesOf(sd).length);
  }

  // ---- The other two resolutions, and the guard on "both, in different contexts".
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "use spaces for indentation", "--kind", "preference"], env(sd));
    runSelf(["record", "use tabs for indentation", "--kind", "preference"], env(sd));
    const open = JSON.parse(runSelf(["conflicts", "--json"], env(sd)).stdout);
    check("two opposite preferences are detected as a contradiction", 1, open.open, JSON.stringify(open).slice(0, 300));
    const sameScope = runSelf(["resolve", open.conflicts[0].id, "--both"], env(sd));
    check("'both, in different contexts' with the SAME context is refused", REFUSED, sameScope.status, sameScope.stdout.slice(0, 240));
    check("...and says why it is not a resolution", true, /needs two different contexts/.test(sameScope.stdout), sameScope.stdout.slice(0, 240));
    const ok = runSelf(["resolve", open.conflicts[0].id, "--both", "--new-scope", "path", "--new-scope-value", ".go", "--old-scope", "global"], env(sd));
    check("...and works once each side has its own context", 0, ok.status, ok.stdout.slice(0, 240));
    const inGo = JSON.parse(runSelf(["recall", "indentation", "--json", "--path", "main.go"], env(sd)).stdout);
    check("in a .go file, the .go rule applies", true, inGo.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(inGo.entries.map((e) => e.text)));
    check("...and both are live, neither superseded", 2, JSON.parse(runSelf(["list", "--json"], env(sd)).stdout).entries.filter((e) => !e.supersededBy && !e.retracted).length);
    const inTs = JSON.parse(runSelf(["recall", "indentation", "--json", "--path", "app.ts"], env(sd)).stdout);
    check("in a .ts file, the .go rule does NOT apply", false, inTs.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(inTs.entries.map((e) => e.text)));
    check("...and the global one still does", true, inTs.entries.some((e) => /spaces/.test(e.text)), JSON.stringify(inTs.entries.map((e) => e.text)));
  }
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "deploy this to vercel", "--kind", "constraint"], env(sd));
    const wrongId = entriesOf(sd)[0].id;
    runSelf(["record", "deploy this to railway not vercel", "--kind", "constraint"], env(sd));
    const open = JSON.parse(runSelf(["conflicts", "--json"], env(sd)).stdout);
    check("a contradicting constraint is detected", 1, open.open, JSON.stringify(open).slice(0, 300));
    const r2 = runSelf(["resolve", open.conflicts[0].id, "--old-was-wrong"], env(sd));
    check("'the old one was wrong' works", 0, r2.status, r2.stdout.slice(0, 200));
    const listed = JSON.parse(runSelf(["list", "--json"], env(sd)).stdout);
    const victim = listed.entries.find((e) => e.id === wrongId);
    check("...and retracts rather than supersedes it", true, Boolean(victim.retracted), JSON.stringify(victim).slice(0, 200));
    check("...so it is distinguishable from an entry that merely got old", null, victim.supersededBy);
    check("...and it is still in `list`", 2, listed.entries.length);
    const rec = JSON.parse(runSelf(["recall", "where does this deploy", "--json"], env(sd)).stdout);
    check("...and never recalled again", false, rec.entries.some((e) => e.id === wrongId), JSON.stringify(rec.entries.map((e) => e.id)));
  }

  // ---- REQUIRED: an unknown `forget` id changes nothing.
  {
    const sd = supersedeState;
    const before = storeText(sd);
    const r = runSelf(["forget", "m_doesnotexist"], env(sd));
    check("forget with an unknown id is refused", REFUSED, r.status, r.stdout.slice(0, 160));
    check("...and says so plainly", true, /No entry with id/.test(r.stdout), r.stdout.slice(0, 200));
    check("...and the store is byte-identical afterwards", before, storeText(sd));
    const empty = runSelf(["forget"], env(sd));
    check("forget with no id at all is refused", REFUSED, empty.status);

    const real = entriesOf(sd)[0].id;
    const done = runSelf(["forget", real], env(sd));
    check("forget with a real id works", 0, done.status, done.stdout.slice(0, 160));
    check("...and the entry is gone", false, entriesOf(sd).some((e) => e.id === real));
    const doc = JSON.parse(storeText(sd));
    check("...and is tombstoned so a sync cannot bring it back", true, doc.forgotten.includes(real));
  }

  // ---- REQUIRED: a corrupt local store is never written over.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "keep tables terse", "--kind", "preference"], env(sd));
    const corrupt = '{ "entries": [ {"id": "m_a" ';
    fs.writeFileSync(storeFileOf(sd), corrupt, "utf8");
    const rec = runSelf(["record", "no, not like that", "--why", "reason"], env(sd));
    check("corrupt store: record is refused", REFUSED, rec.status, rec.stdout.slice(0, 160));
    check("corrupt store: the file is NOT overwritten", corrupt, storeText(sd));
    check("corrupt store: says what is wrong", true, /not valid JSON/.test(rec.stdout), rec.stdout.slice(0, 200));
    const rec2 = runSelf(["recall", "--json"], env(sd));
    check("corrupt store: recall refuses rather than answering 'nothing'", REFUSED, rec2.status, rec2.stdout.slice(0, 160));
    check("corrupt store: recall does not claim an empty memory", false, /"entries": \[\]/.test(rec2.stdout));
    const syncRes = runSelf(["sync"], env(sd));
    check("corrupt store: sync refuses rather than pushing a guess", REFUSED, syncRes.status, syncRes.stdout.slice(0, 160));
    check("corrupt store: the file is STILL not overwritten", corrupt, storeText(sd));
    const st = runSelf(["status", "--json"], env(sd));
    check("corrupt store: status still answers", 0, st.status, st.stderr.slice(0, 120));
    check("corrupt store: and reports the store error", true, Boolean(JSON.parse(st.stdout).storeError));
    const repairNo = runSelf(["repair"], env(sd));
    check("repair without --yes does not touch it", corrupt, storeText(sd), repairNo.stdout.slice(0, 120));
    const repair = runSelf(["repair", "--yes"], env(sd));
    check("repair --yes exits 0", 0, repair.status, repair.stdout.slice(0, 160));
    check("repair --yes quarantines the damaged file rather than deleting it", true, fs.readdirSync(path.join(sd, "memory")).some((f) => f.includes(".corrupt-")));
    check("repair --yes leaves a clean store", 0, entriesOf(sd).length);
  }

  // ---- Empty store file: not the same as "no memories".
  {
    const sd = freshState();
    enable(sd);
    fs.mkdirSync(path.join(sd, "memory"), { recursive: true });
    fs.writeFileSync(storeFileOf(sd), "", "utf8");
    const r = runSelf(["record", "no, not like that", "--why", "reason"], env(sd));
    check("an empty store file is refused, not treated as empty memory", REFUSED, r.status, r.stdout.slice(0, 160));
    check("...and is not overwritten", "", storeText(sd));
  }

  // ---- REQUIRED: sync with no token. Local memory keeps working.
  const noTokenState = freshState();
  {
    const sd = noTokenState;
    enable(sd);
    runSelf(["record", "no, not like that", "--why", "shared code goes in src/lib"], env(sd));
    const before = entriesOf(sd).length;
    const r = runSelf(["sync"], env(sd));
    check("sync with no token: exits 0 and never blocks", 0, r.status, r.stdout.slice(0, 200));
    check("sync with no token: says it is local only", true, /Not synced/.test(r.stdout), r.stdout.slice(0, 200));
    check("sync with no token: says nothing was lost", true, /Nothing was lost/.test(r.stdout));
    check("sync with no token: keeps every local entry", before, entriesOf(sd).length);
    const st = JSON.parse(runSelf(["status", "--json"], env(sd)).stdout);
    check("sync with no token: status still reports memory ON", true, st.on);
    check("sync with no token: status says there is no token", false, st.tokenPresent);
  }

  // ---- REQUIRED: an unreachable endpoint. Same rule.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "no, not like that", "--why", "reason"], env(sd));
    const before = storeText(sd);
    const r = runSelf(["sync"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_fake", TOOLBAY_BASE_URL: "http://127.0.0.1:1" }));
    check("sync against a dead port: exits 0", 0, r.status, r.stdout.slice(0, 200));
    check("sync against a dead port: says it did not sync", true, /Not synced/.test(r.stdout), r.stdout.slice(0, 200));
    check("sync against a dead port: keeps every entry", JSON.parse(before).entries.length, entriesOf(sd).length);
  }

  // ---- The live server cases: a real HTTP server, a real payload on the wire.
  const received = [];
  let mode = "ok";
  // The stub KEEPS what it is sent, because a stateless echo server cannot
  // exercise the case that matters most here: you forget something, and the
  // account still has it and offers it back on the next sync. Only a server
  // with a memory of its own can prove the tombstone is what keeps it out.
  // Deletion happens on DELETE, exactly as the real one will.
  const serverStore = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ url: req.url, method: req.method, auth: req.headers.authorization || "", body });
      if (mode === "500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"internal"}');
        return;
      }
      if (mode === "garbage") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("<html>not json</html>");
        return;
      }
      if (req.method === "DELETE") {
        serverStore.delete(decodeURIComponent(String(req.url).split("/").pop()));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* the assertions below read `received`, not this */
      }
      for (const e of parsed.entries || []) if (e && typeof e.id === "string") serverStore.set(e.id, { ...e });
      const entries = [...serverStore.values()].map((e) => ({ ...e }));
      entries.push({
        id: "m_fromanothermachine",
        kind: "constraint",
        text: "this laptop has no docker",
        why: "corporate image",
        weight: 8,
        createdAt: nowISO(),
        supersedes: null,
      });
      entries.push({ id: "m_unknownkind", kind: "not-a-kind-here", text: "ignore me", why: "", weight: 5, createdAt: nowISO(), supersedes: null });
      entries.push({ id: "m_malformed" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  // unref, and this is not a nicety. If an assertion below throws, the catch at
  // the bottom of this file reports it — but a listening server keeps the event
  // loop alive, so the process would HANG instead of exiting non-zero, and a
  // test runner cannot tell a hang from a slow pass. A test harness that fails
  // open is the exact defect this package exists to remove. Unreffed, the
  // server still answers for as long as the awaited children keep the loop
  // alive, and stops holding the process up the moment they do not.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;

  // 5xx: fails closed, loses nothing.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "no, not like that", "--why", "reason"], env(sd));
    const before = entriesOf(sd).length;
    mode = "500";
    const r = await runSelfAsync(["sync"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_fake", TOOLBAY_BASE_URL: base }));
    check("sync 5xx: exits 0 and never blocks", 0, r.status, r.stdout.slice(0, 200));
    check("sync 5xx: says the server answered 500", true, /HTTP 500/.test(r.stdout), r.stdout.slice(0, 200));
    check("sync 5xx: keeps every local entry", before, entriesOf(sd).length);
    check("sync 5xx: says the entries are untouched", true, /untouched/.test(r.stdout));
    check("sync 5xx --strict exits non-zero for CI", 1, (await runSelfAsync(["sync", "--strict"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_fake", TOOLBAY_BASE_URL: base }))).status);
  }

  // A 200 that is not the agreed shape is ignored, not merged.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "keep tables terse", "--kind", "preference"], env(sd));
    const before = storeText(sd);
    mode = "garbage";
    const r = await runSelfAsync(["sync"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_fake", TOOLBAY_BASE_URL: base }));
    check("sync with an unusable 200 body: exits 0", 0, r.status, r.stdout.slice(0, 200));
    check("sync with an unusable 200 body: is not merged", true, /Not merged/.test(r.stdout), r.stdout.slice(0, 200));
    check("sync with an unusable 200 body: keeps local entries", JSON.parse(before).entries.length, entriesOf(sd).length);
  }

  // The happy path, and what actually goes over the wire.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", `no, never commit ${SECRET}`, "--why", "it belongs in the env"], env(sd));
    received.length = 0;
    mode = "ok";
    const r = await runSelfAsync(["sync"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_realish", TOOLBAY_BASE_URL: base }));
    check("sync: exits 0", 0, r.status, `${r.stdout}${r.stderr}`.slice(0, 300));
    const post = received.find((x) => x.method === "POST");
    check("sync: POSTs to the contract path", "/api/v1/memory/sync", post ? post.url : "(no request)");
    check("sync: sends the bearer token", "Bearer tb_live_realish", post ? post.auth : "(none)");
    check("sync: the wire payload contains NO credential", false, post ? post.body.includes(SECRET) : true, (post ? post.body : "").slice(0, 200));
    check("sync: the wire payload contains no sk-ant fragment at all", false, post ? /sk-ant-/.test(post.body) : true);
    const sent = JSON.parse(post.body);
    check("sync: body is { entries: [...] }", true, Array.isArray(sent.entries));
    check("sync: every entry on the wire has exactly the contract fields", true, sent.entries.every((e) => Object.keys(e).sort().join(",") === "createdAt,id,kind,scope,source,supersedes,text,weight,why"), JSON.stringify(Object.keys(sent.entries[0] || {})));
    check("sync: the wire payload carries no absolute path", false, /[A-Za-z]:\\\\|\/Users\/|\/home\//.test(post.body), post.body.slice(0, 200));
    check("sync: a merged entry with no scope is treated as global, not as a project that never matches", true, entriesOf(sd).filter((e) => e.id === "m_fromanothermachine").every((e) => !e.scope), JSON.stringify(entriesOf(sd).find((e) => e.id === "m_fromanothermachine")));
    check("sync: and a merged entry with no source reads as stated rather than nothing", "stated", (entriesOf(sd).find((e) => e.id === "m_fromanothermachine") || {}).source);
    check("sync: merges in the entry from the other machine", true, entriesOf(sd).some((e) => e.id === "m_fromanothermachine"));
    check("sync: ignores an entry of a kind this install does not define", false, entriesOf(sd).some((e) => e.id === "m_unknownkind"));
    check("sync: ignores a malformed entry", false, entriesOf(sd).some((e) => e.id === "m_malformed"));
    const kept = entriesOf(sd).find((e) => /never commit/.test(e.text));
    check("sync: keeps the local entry too", true, Boolean(kept), JSON.stringify(entriesOf(sd).map((e) => e.id)));

    // A forgotten entry is deleted remotely and must not come back. Guarded,
    // because a merge that DROPPED the local entry would otherwise crash this
    // selftest here — and a crash reports as "something went wrong" rather than
    // naming the guard that broke, which is the whole point of the exercise.
    const victim = kept ? kept.id : "m_local_entry_was_lost_by_the_merge";
    runSelf(["forget", victim], env(sd));
    received.length = 0;
    await runSelfAsync(["sync"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_realish", TOOLBAY_BASE_URL: base }));
    check("sync: a forgotten entry is DELETEd from the account", true, received.some((x) => x.method === "DELETE" && x.url.includes(victim)), JSON.stringify(received.map((x) => `${x.method} ${x.url}`)));
    check("sync: and the server echoing it back does not resurrect it", false, entriesOf(sd).some((e) => e.id === victim));
  }

  // The read-only half of the contract: GET the list, GET the export.
  {
    const sd = freshState();
    enable(sd);
    received.length = 0;
    mode = "ok";
    const serverEnv = env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_realish", TOOLBAY_BASE_URL: base });
    const pull = await runSelfAsync(["sync", "--pull"], serverEnv);
    check("sync --pull: exits 0", 0, pull.status, `${pull.stdout}${pull.stderr}`.slice(0, 200));
    const got = received.find((x) => x.method === "GET");
    check("sync --pull: GETs the list endpoint", "/api/v1/memory", got ? got.url : "(no GET)");
    check("sync --pull: sends nothing", false, received.some((x) => x.method === "POST"));
    check("sync --pull: merges what the account had", true, entriesOf(sd).some((e) => e.id === "m_fromanothermachine"));

    received.length = 0;
    const remote = await runSelfAsync(["export", "--remote"], serverEnv);
    check("export --remote: exits 0", 0, remote.status, remote.stderr.slice(0, 160));
    check("export --remote: GETs the export endpoint", true, received.some((x) => x.url === "/api/v1/memory/export"), JSON.stringify(received.map((x) => x.url)));
    check("export --remote: prints the account's copy", true, /"remote"/.test(remote.stdout), remote.stdout.slice(0, 160));

    const offline = await runSelfAsync(["export", "--remote"], env(sd, GOOD, { TOOLBAY_TOKEN: "tb_live_fake", TOOLBAY_BASE_URL: "http://127.0.0.1:1" }));
    check("export --remote with no server: still hands you your local copy", 0, offline.status, offline.stdout.slice(0, 160));
    check("...with the reason the remote copy is missing", true, /"remote"/.test(offline.stdout) && /ECONNREFUSED|fetch failed|answered/.test(offline.stdout), offline.stdout.slice(0, 300));
    check("...and the local entries are all still there", true, JSON.parse(offline.stdout).count > 0);
  }

  await new Promise((res) => server.close(res));

  // ---- Decay, reinforcement, and the ordinary round trip.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "always run the tests before pushing", "--kind", "frequency"], env(sd));
    const twice = runSelf(["record", "always run the tests before pushing", "--kind", "frequency"], env(sd));
    check("saying the same thing again reinforces rather than duplicates", 1, entriesOf(sd).length, twice.stdout.slice(0, 160));
    check("...and says it is now reinforced", true, /reinforced/.test(twice.stdout), twice.stdout.slice(0, 160));
    check("...and counts the repeat", 1, entriesOf(sd)[0].hits);

    // An entry old enough to fall below the floor stops being recalled, but is
    // never deleted: `list` still has it.
    const doc = JSON.parse(storeText(sd));
    doc.entries[0].createdAt = new Date(Date.now() - 4000 * DAY).toISOString();
    doc.entries[0].hits = 0;
    fs.writeFileSync(storeFileOf(sd), JSON.stringify(doc), "utf8");
    const recalled = JSON.parse(runSelf(["recall", "--json"], env(sd)).stdout);
    check("an entry decayed below the floor drops out of recall", 0, recalled.entries.length, JSON.stringify(recalled).slice(0, 200));
    const listed = JSON.parse(runSelf(["list", "--json"], env(sd)).stdout);
    check("...but is still in `list`, marked faded", true, listed.entries[0].faded);
    check("...so it was never silently deleted", 1, listed.count);
  }

  // ---- Recall respects the off switch, and export always answers.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "no, not like that", "--why", "reason"], env(sd));
    const off = runSelf(["disable"], env(sd));
    check("disable exits 0", 0, off.status, off.stdout.slice(0, 160));
    const afterOff = runSelf(["recall", "--json"], env(sd));
    check("recall after disable returns nothing", 0, JSON.parse(afterOff.stdout).entries.length);
    check("...and reports itself off rather than empty", false, JSON.parse(afterOff.stdout).on);
    check("...and in prose says memory is OFF", true, /Memory is OFF/.test(runSelf(["recall"], env(sd)).stdout));
    const rec = runSelf(["record", "another one", "--kind", "preference"], env(sd));
    check("record after disable stores nothing", 1, entriesOf(sd).length, rec.stdout.slice(0, 160));
    const exported = JSON.parse(runSelf(["export"], env(sd)).stdout);
    check("export still answers 'what do you have on me' after disable", 1, exported.count);
    check("...and reports that consent is withdrawn", false, exported.consent.optedIn);
    const wipe = runSelf(["disable", "--forget-everything"], env(sd));
    check("disable --forget-everything deletes the store", false, fs.existsSync(storeFileOf(sd)), wipe.stdout.slice(0, 160));
  }

  // ---- The onboarding is part of the product, so it is asserted like one.
  {
    const sd = freshState();
    const o = runSelf(["onboard"], env(sd));
    check("onboard exits 0", 0, o.status, o.stderr.slice(0, 120));
    check("onboard teaches what 'done' means", true, /done/i.test(o.stdout));
    check("onboard teaches saying what you do NOT want", true, /do NOT want/i.test(o.stdout));
    check("onboard teaches correcting out loud, with the why", true, /Correct it out loud/i.test(o.stdout));
    check("onboard teaches stating constraints up front", true, /constraints up front/i.test(o.stdout));
    check("onboard says corrections are what make the stack better", true, /makes this stack better for you/i.test(o.stdout), o.stdout.slice(-400));
    check("onboard says corrections are fuel, not friction", true, /not friction/i.test(o.stdout));
    check("onboard is short enough to read (<= 60 lines)", true, o.stdout.split("\n").length <= 60, String(o.stdout.split("\n").length));
    const enabled = runSelf(["enable", "--yes"], env(sd));
    check("opting in prints the prompting guide too", true, /Correct it out loud/i.test(enabled.stdout), enabled.stdout.slice(0, 200));
  }

  // ---- REQUIRED: an uncertain scope defaults NARROW, and scope is respected.
  {
    const sd = freshState();
    enable(sd);
    const here = { ...env(sd), TOOLBAY_STACK_PROJECT: "alpha" };
    const there = { ...env(sd), TOOLBAY_STACK_PROJECT: "beta" };

    const vague = runSelf(["record", "indent with tabs", "--kind", "preference", "--json"], here);
    const vagueDoc = JSON.parse(vague.stdout);
    check("a scope that cannot be read off what you said defaults to PROJECT, not global", "project", vagueDoc.scope.level, JSON.stringify(vagueDoc.scope));
    check("...to the project you are in", "alpha", vagueDoc.scope.value);
    check("...and says it was narrowed rather than leaving you to guess", true, vagueDoc.scope.narrowedByDefault, JSON.stringify(vagueDoc.scope));
    check("...and the reason names the tie-break", true, /kept to this project rather than applied everywhere/.test(vagueDoc.scope.reason), vagueDoc.scope.reason);

    const inAlpha = JSON.parse(runSelf(["recall", "indent", "--json"], here).stdout);
    check("the narrow rule applies in the project it was recorded in", true, inAlpha.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(inAlpha.entries.map((e) => e.text)));
    const inBeta = JSON.parse(runSelf(["recall", "indent", "--json"], there).stdout);
    check("...and does NOT leak into another project", false, inBeta.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(inBeta.entries.map((e) => e.text)));
    check("...and recall says how many it held back rather than hiding it", 1, inBeta.outOfScope);

    const global = JSON.parse(runSelf(["record", "never use em dashes in every project", "--kind", "preference", "--json"], here).stdout);
    check("saying 'in every project' DOES infer global", "global", global.scope.level, JSON.stringify(global.scope));
    check("...and says which words did it", true, /in every project/.test(global.scope.reason), global.scope.reason);
    const globalElsewhere = JSON.parse(runSelf(["recall", "em dashes", "--json"], there).stdout);
    check("...and a global rule applies in every project", true, globalElsewhere.entries.some((e) => /em dashes/.test(e.text)), JSON.stringify(globalElsewhere.entries.map((e) => e.text)));

    const lang = JSON.parse(runSelf(["record", "no semicolons in .ts files", "--kind", "preference", "--json"], here).stdout);
    check("naming a file type infers the PATH scope, which is narrower still", "path", lang.scope.level, JSON.stringify(lang.scope));
    check("...with the extension it named", ".ts", lang.scope.value);
    const noPath = JSON.parse(runSelf(["recall", "semicolons", "--json"], here).stdout);
    check("a path rule does not apply when no file is named", false, noPath.entries.some((e) => /semicolons/.test(e.text)), JSON.stringify(noPath.entries.map((e) => e.text)));
    const withPath = JSON.parse(runSelf(["recall", "semicolons", "--json", "--path", "src/app.ts"], here).stdout);
    check("...and does apply when one is", true, withPath.entries.some((e) => /semicolons/.test(e.text)), JSON.stringify(withPath.entries.map((e) => e.text)));

    // A constraint is force-included by memory.json. It is still not force-widened.
    runSelf(["record", "this project deploys to railway", "--kind", "constraint"], here);
    const cInAlpha = JSON.parse(runSelf(["recall", "something unrelated entirely", "--json"], here).stdout);
    check("a constraint is recalled whether or not the words match", true, cInAlpha.entries.some((e) => /railway/.test(e.text)), JSON.stringify(cInAlpha.entries.map((e) => e.text)));
    const cInBeta = JSON.parse(runSelf(["recall", "something unrelated entirely", "--json"], there).stdout);
    check("...but an always-included kind is STILL not leaked across projects", false, cInBeta.entries.some((e) => /railway/.test(e.text)), JSON.stringify(cInBeta.entries.map((e) => e.text)));

    const explicit = JSON.parse(runSelf(["record", "keep commits small", "--kind", "preference", "--scope", "global", "--json"], here).stdout);
    check("--scope global is honoured when you ask for it explicitly", "global", explicit.scope.level);
    check("...and is not marked as inferred", false, explicit.scope.inferred);
    check("--scope path with no value is refused", REFUSED, runSelf(["record", "x y z", "--kind", "preference", "--scope", "path"], here).status);
    check("--scope with a made-up level is refused", REFUSED, runSelf(["record", "x y z", "--kind", "preference", "--scope", "universe"], here).status);

    const target = vagueDoc.recorded.id;
    const widened = runSelf(["rescope", target, "--scope", "global"], here);
    check("rescope widens a rule afterwards", 0, widened.status, widened.stdout.slice(0, 200));
    check("...and says what changed", true, /was this project.*now everywhere/s.test(widened.stdout), widened.stdout.slice(0, 240));
    const nowEverywhere = JSON.parse(runSelf(["recall", "indent", "--json"], there).stdout);
    check("...so it now applies in the other project too", true, nowEverywhere.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(nowEverywhere.entries.map((e) => e.text)));
    check("rescope with no --scope is refused", REFUSED, runSelf(["rescope", target], here).status);
    check("rescope of an unknown id is refused", REFUSED, runSelf(["rescope", "m_nope", "--scope", "global"], here).status);

    // The same sentence about one project and about everything is two rules.
    const twinScoped = runSelf(["record", "keep commits small", "--kind", "preference", "--scope", "project", "--json"], here);
    check("the same text in a different scope is a new entry, not a reinforcement", true, /"recorded"/.test(twinScoped.stdout), twinScoped.stdout.slice(0, 200));
  }

  // ---- REQUIRED: an inferred trait can never override a stated one.
  const traitState = freshState();
  {
    const sd = traitState;
    enable(sd);
    check("`record --source inferred` is refused outright", REFUSED, runSelf(["record", "they like shipping fast", "--kind", "preference", "--source", "inferred"], env(sd)).status);
    check("...and says an inference is never an entry", true, /never an entry at all/.test(runSelf(["record", "they like shipping fast", "--kind", "preference", "--source", "inferred"], env(sd)).stdout));
    check("...and nothing was written", 0, entriesOf(sd).length);

    runSelf(["record", "no, ship the smallest thing that works", "--why", "I would rather launch than polish", "--scope", "global"], env(sd));
    const one = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("one piece of evidence is not a trait", 0, one.traits.length, JSON.stringify(one.traits));

    runSelf(["record", "stop polishing it and ship", "--kind", "preference", "--scope", "global"], env(sd));
    const two = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    const shipsFast = two.traits.find((t) => t.key === "ships-fast");
    check("two pieces of evidence derive a trait", true, Boolean(shipsFast), JSON.stringify(two.traits.map((t) => t.key)));
    check("...which GENERALISES rather than restating the correction", true, /smallest slice/.test(shipsFast.statement), shipsFast.statement);
    check("...linked to the exact entries that produced it", 2, shipsFast.evidence.length, JSON.stringify(shipsFast.evidence.map((e) => e.id)));
    check("...and every one of those ids really exists", true, shipsFast.evidence.every((e) => entriesOf(sd).some((x) => x.id === e.id)));
    check("a trait is marked as NOT stated by the user", false, shipsFast.statedByUser);
    // Found by running this against a REAL CLAUDE.md: substring matching turned
    // "the safe or proven play" into evidence for "prove", and a list of slash
    // commands containing "/ship" into evidence for "ship".
    runSelf(["record", "prefer the safe or proven play here", "--kind", "preference", "--scope", "global"], env(sd));
    runSelf(["record", "the skills are /office-hours, /ship, /review and /qa", "--kind", "constraint", "--scope", "global"], env(sd));
    const noisy = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("a word merely CONTAINING a signal is not evidence", 2, noisy.traits.find((t) => t.key === "ships-fast").evidenceCount, JSON.stringify(noisy.traits.find((t) => t.key === "ships-fast").evidence.map((e) => e.text)));
    check("...so a coincidence never becomes a claim about the person", false, noisy.traits.some((t) => t.key === "verifies-before-believing"), JSON.stringify(noisy.traits.map((t) => t.key)));
    check("...and carries the inferred authority", "inferred", shipsFast.authority);
    check("...and the payload says so at the top too", true, /INFERRED/.test(one.note), one.note);

    const rec = JSON.parse(runSelf(["recall", "how should I build this", "--json", "--scope-value", "x"], env(sd)).stdout);
    check("a trait NEVER appears in recall's entries array", false, JSON.stringify(rec.entries).includes("smallest slice"), JSON.stringify(rec.entries).slice(0, 200));
    check("...it appears only under `inferred`", true, JSON.stringify(rec.inferred).includes("smallest slice"), JSON.stringify(rec.inferred).slice(0, 200));
    check("...and every entry says whether the user actually said it", true, rec.entries.every((e) => typeof e.statedByUser === "boolean"));
    const prose = runSelf(["recall", "how should I build this"], env(sd)).stdout;
    check("in prose, the inferred section says you never said it", true, /you never said these/.test(prose), prose.slice(-600));

    // THE GUARD: one thing the user actually SAID beats any amount of inference.
    runSelf(["record", "no, take your time on this one", "--why", "the last rushed one had to be redone", "--scope", "global"], env(sd));
    const suppressed = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("a stated entry that contradicts a trait KILLS the trait", false, suppressed.traits.some((t) => t.key === "ships-fast"), JSON.stringify(suppressed.traits.map((t) => t.key)));
    check("...and the derivation is not silently dropped, it says what overruled it", true, suppressed.suppressedBySomethingYouSaid.some((s) => s.key === "ships-fast"), JSON.stringify(suppressed.suppressedBySomethingYouSaid));
    check("...naming the entry that did it", true, suppressed.suppressedBySomethingYouSaid.some((s) => /take your time/.test(s.becauseOfText)));
    const rec2 = JSON.parse(runSelf(["recall", "how should I build this", "--json"], env(sd)).stdout);
    check("...and the trait is gone from recall entirely", false, JSON.stringify(rec2.inferred).includes("smallest slice"), JSON.stringify(rec2.inferred).slice(0, 200));
    check("...while everything the user said is still there", true, entriesOf(sd).length >= 3, String(entriesOf(sd).length));
  }
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "keep it terse", "--kind", "preference", "--scope", "global"], env(sd));
    runSelf(["record", "no preamble, just the answer", "--kind", "preference", "--scope", "global"], env(sd));
    const before = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("a second trait derives from its own evidence", true, before.traits.some((t) => t.key === "wants-it-terse"), JSON.stringify(before.traits.map((t) => t.key)));
    const rejected = runSelf(["reject-trait", "wants-it-terse"], env(sd));
    check("reject-trait exits 0", 0, rejected.status, rejected.stdout.slice(0, 200));
    const after = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("...and the trait is gone", false, after.traits.some((t) => t.key === "wants-it-terse"), JSON.stringify(after.traits.map((t) => t.key)));
    check("...and is remembered as rejected", true, after.rejected.includes("wants-it-terse"));
    runSelf(["record", "shorter, this is a wall of text", "--kind", "preference", "--scope", "global"], env(sd));
    const later = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    check("...and more evidence does NOT bring a rejected trait back", false, later.traits.some((t) => t.key === "wants-it-terse"), JSON.stringify(later.traits.map((t) => t.key)));
    check("rejecting a guess deletes nothing the user said", 3, entriesOf(sd).length);
    runSelf(["accept-trait", "wants-it-terse"], env(sd));
    const accepted = JSON.parse(runSelf(["traits", "--json"], env(sd)).stdout);
    const t = accepted.traits.find((x) => x.key === "wants-it-terse");
    check("accept-trait brings it back", true, Boolean(t), JSON.stringify(accepted.traits.map((x) => x.key)));
    check("...and agreeing with a guess still does not make it something you said", false, t.statedByUser);
    check("...it is still inferred", "inferred", t.source);
    check("reject-trait with an unknown key is refused", REFUSED, runSelf(["reject-trait", "not-a-trait"], env(sd)).status);
  }

  // ---- REQUIRED: authority. Imported and inferred never overrule stated.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "always use pnpm", "--kind", "constraint", "--scope", "global"], env(sd));
    const stated = entriesOf(sd)[0].id;
    const attempt = runSelf(["record", "always use yarn", "--kind", "constraint", "--source", "imported", "--supersedes", stated, "--scope", "global"], env(sd));
    check("an imported entry cannot supersede something you stated", REFUSED, attempt.status, attempt.stdout.slice(0, 240));
    check("...and says why", true, /outranks something derived or imported/.test(attempt.stdout), attempt.stdout.slice(0, 240));
    check("...and nothing was written", 1, entriesOf(sd).length);
    const ok = runSelf(["record", "always use bun", "--kind", "constraint", "--supersedes", stated, "--scope", "global"], env(sd));
    check("...but a stated entry may supersede a stated entry", 0, ok.status, ok.stdout.slice(0, 200));
  }
  {
    // The same rule on the OTHER route into supersede: resolving a conflict.
    const sd = freshState();
    enable(sd);
    runSelf(["record", "always deploy with the vercel cli", "--kind", "constraint", "--scope", "global"], env(sd));
    const statedId = entriesOf(sd)[0].id;
    runSelf(["record", "always deploy with the railway cli", "--kind", "constraint", "--source", "imported", "--scope", "global"], env(sd));
    const open = JSON.parse(runSelf(["conflicts", "--json"], env(sd)).stdout);
    check("an imported entry contradicting a stated one is still surfaced", 1, open.open, JSON.stringify(open).slice(0, 300));
    const attempt = runSelf(["resolve", open.conflicts[0].id, "--replace"], env(sd));
    check("...but resolving it in the imported entry's favour is REFUSED", REFUSED, attempt.status, attempt.stdout.slice(0, 300));
    check("...and says which is which", true, /is imported and the older one is stated/.test(attempt.stdout), attempt.stdout.slice(0, 300));
    check("...and tells you the honest way to do it, which is to say it yourself", true, /say it yourself/.test(attempt.stdout), attempt.stdout.slice(0, 300));
    check("...and the stated entry is untouched", null, entriesOf(sd).find((e) => e.id === statedId).supersedes);
    check("...and the conflict is still open, not quietly closed", 1, JSON.parse(runSelf(["conflicts", "--json"], env(sd)).stdout).open);
    // Retracting your OWN entry is always yours to do, so `--old-was-wrong` is
    // allowed here — but it leaves an imported line standing, and you are told.
    const other = runSelf(["resolve", open.conflicts[0].id, "--old-was-wrong"], env(sd));
    check("...while retracting your own entry is still yours to do", 0, other.status, other.stdout.slice(0, 200));
    check("...and it says out loud that what is left standing is not something you said", true, /what stays live is imported, not something you said/.test(other.stdout), other.stdout.slice(0, 400));
  }

  // ---- REQUIRED: importing, and an imported secret never landing in the store.
  const importState = freshState();
  {
    const sd = importState;
    enable(sd);
    const md = write(
      "CLAUDE.md",
      [
        "# How I work",
        "- Never use em dashes in generated copy.",
        "- Always run npm test before pushing.",
        `- The key is ${SECRET}, always use it for auth.`,
        "- The env file must never be committed: /home/bob/.env",
        "- Always call function foo() { const x = 1; }",
        "- ok",
        "Prose that is not a bullet and should never be imported.",
        "```",
        "- Never import a bullet that is inside a code fence.",
        "```",
        "",
      ].join("\n"),
    );

    const off = runSelf(["import", "claude-md", "--from", md, "--yes"], env(sd, GOOD, { TOOLBAY_STACK_STATE_DIR: freshState() }));
    check("import writes nothing when memory was never turned on", true, /Memory is OFF/.test(off.stdout), off.stdout.slice(0, 200));

    const prose = runSelf(["import", "claude-md", "--from", md], env(sd));
    check("an import with no --yes writes NOTHING", false, fs.existsSync(storeFileOf(sd)), storeText(sd).slice(0, 200));
    check("...and says so", true, /Nothing has been written/.test(prose.stdout), prose.stdout.slice(0, 300));
    check("...and shows you the list it would have written", true, /would be imported/.test(prose.stdout), prose.stdout.slice(0, 300));

    const dry = runSelf(["import", "claude-md", "--from", md, "--json"], env(sd));
    const dryDoc = JSON.parse(dry.stdout);
    check("a dry-run import writes NOTHING", false, dryDoc.wroteAnything);
    check("...and nothing is in the store", 0, entriesOf(sd).length, storeText(sd).slice(0, 120));
    check("...and it shows you the whole list first", true, dryDoc.candidates.length >= 3, JSON.stringify(dryDoc.candidates.map((c) => c.text)));
    check("a bullet inside a code fence is not imported", false, JSON.stringify(dryDoc.candidates).includes("inside a code fence"));
    check("prose that is not a bullet is not imported", false, JSON.stringify(dryDoc.candidates).includes("Prose that is not"));
    check("a line pointing at a credentials file is refused", true, dryDoc.skipped.some((s) => /private path|credentials file/.test(s.reason)), JSON.stringify(dryDoc.skipped.map((s) => s.reason)));
    check("a line that reads as source is refused", true, dryDoc.skipped.some((s) => /reads as source code/.test(s.reason)), JSON.stringify(dryDoc.skipped.map((s) => s.reason)));

    const done = runSelf(["import", "claude-md", "--from", md, "--yes"], env(sd));
    check("import --yes exits 0", 0, done.status, done.stdout.slice(0, 240));
    const raw = storeText(sd);
    check("AN IMPORTED SECRET NEVER LANDS IN THE STORE", false, raw.includes(SECRET), raw.slice(0, 400));
    check("...in any form", false, /sk-ant-/.test(raw), raw.slice(0, 400));
    check("...and the redaction is auditable", true, raw.includes(PLACEHOLDER_PREFIX));
    check("an imported private path never lands either", false, /\/home\/bob/.test(raw), raw.slice(0, 400));
    check("imported code never lands either", false, /function foo/.test(raw), raw.slice(0, 400));
    const listed = JSON.parse(runSelf(["list", "--json"], env(sd)).stdout);
    check("every imported entry is marked imported, not stated", true, listed.entries.every((e) => e.source === "imported"), JSON.stringify(listed.entries.map((e) => e.source)));
    check("...and says which file and line it came from", true, listed.entries.every((e) => /CLAUDE\.md:\d+/.test(String(e.importedFrom))), JSON.stringify(listed.entries.map((e) => e.importedFrom)));
    check("...and none of them invented a reason the user never gave", true, listed.entries.every((e) => e.why === ""), JSON.stringify(listed.entries.map((e) => e.why)));
    check("a repo-local CLAUDE.md imports scoped to that project, not globally", true, listed.entries.every((e) => e.scope.level === "project"), JSON.stringify(listed.entries.map((e) => e.scope)));
    const nothingNew = runSelf(["import", "claude-md", "--from", md, "--json"], env(sd));
    check("importing the same file twice adds nothing", 0, JSON.parse(nothingNew.stdout).wouldImport, nothingNew.stdout.slice(0, 200));
    // Found by importing a real CLAUDE.md: the scope EXPLANATION was quoting the
    // full path back, so the store held the user's home directory once per line.
    check("no entry field carries the absolute path the import came from", false, /[A-Za-z]:\\\\|[A-Za-z]:\/|\/home\/|\/Users\//.test(JSON.stringify(entriesOf(sd))), JSON.stringify(entriesOf(sd)[0]).slice(0, 300));

    const batches = JSON.parse(runSelf(["imports", "--json"], env(sd)).stdout);
    check("the import is listed as a batch", 1, batches.count, JSON.stringify(batches));
    runSelf(["record", "no, I said terse", "--why", "long answers waste my time", "--scope", "global"], env(sd));
    const beforeUndo = entriesOf(sd).length;
    const undo = runSelf(["unimport", batches.batches[0].id], env(sd));
    check("unimport reverses the whole batch in one command", 0, undo.status, undo.stdout.slice(0, 200));
    check("...leaving only what the user said themselves", 1, entriesOf(sd).length, String(beforeUndo));
    check("...and that survivor is the stated one", "stated", entriesOf(sd)[0].source);
    check("...and the batch is gone from the list", 0, JSON.parse(runSelf(["imports", "--json"], env(sd)).stdout).count);
    check("unimport of an unknown batch is refused", REFUSED, runSelf(["unimport", "imp_nope"], env(sd)).status);
  }
  {
    const sd = freshState();
    enable(sd);
    const jsonl = write(
      "learnings.jsonl",
      [
        JSON.stringify({ skill: "learn", type: "pitfall", key: "windows-tmp", insight: "Never use /tmp on Windows, it does not resolve", confidence: 8, source: "observed" }),
        JSON.stringify({ skill: "ship", type: "preference", key: "tables", insight: "Always keep tables terse, three columns max", confidence: 7, source: "user-stated" }),
        "{ truncated",
        JSON.stringify({ skill: "x", type: "tool", key: "pkg", insight: "Always use pnpm, never npm" }),
        "",
      ].join("\n"),
    );
    const dry = JSON.parse(runSelf(["import", "gstack-learnings", "--from", jsonl, "--json"], env(sd)).stdout);
    check("a gstack learnings store imports its insights", 3, dry.wouldImport, JSON.stringify(dry.candidates.map((c) => c.text)));
    check("...and a truncated row is skipped rather than guessed at", true, dry.skipped.some((s) => /not valid JSON/.test(s.reason)), JSON.stringify(dry.skipped));
    check("...mapping the learning type onto a kind from memory.json", true, dry.candidates.some((c) => c.kind === "constraint") && dry.candidates.some((c) => c.kind === "preference"), JSON.stringify(dry.candidates.map((c) => c.kind)));
    runSelf(["import", "gstack-learnings", "--from", jsonl, "--yes"], env(sd));
    check("...and they land marked imported", true, entriesOf(sd).every((e) => e.source === "imported"), JSON.stringify(entriesOf(sd).map((e) => e.source)));

    const notes = write("notes.md", ["# Context", "- I always deploy on Fridays because nobody else does.", "- My dog is called Rex.", ""].join("\n"));
    const mdDry = JSON.parse(runSelf(["import", "markdown", "--from", notes, "--json"], env(sd)).stdout);
    check("a plain markdown file imports the lines that read as rules", 1, mdDry.wouldImport, JSON.stringify(mdDry.candidates.map((c) => c.text)));
    check("...and leaves the ones that do not", true, mdDry.skipped.some((s) => /does not read as a rule/.test(s.reason)), JSON.stringify(mdDry.skipped));
    const mdAll = JSON.parse(runSelf(["import", "markdown", "--from", notes, "--json", "--all"], env(sd)).stdout);
    check("...unless you ask for all of it", 2, mdAll.wouldImport, JSON.stringify(mdAll.candidates.map((c) => c.text)));
    const globalMd = JSON.parse(runSelf(["import", "markdown", "--from", notes, "--json", "--scope", "global"], env(sd)).stdout);
    check("--scope overrides where an import lands", "global", globalMd.candidates[0].scope.level, JSON.stringify(globalMd.candidates[0].scope));
    check("importing a file that is not there is refused", REFUSED, runSelf(["import", "markdown", "--from", path.join(tmp, "nope.md")], env(sd)).status);
    check("importing an unknown kind of source is refused", REFUSED, runSelf(["import", "brainwaves", "--from", notes], env(sd)).status);
  }

  // ---- REQUIRED: community defaults. A real server, then no server at all.
  {
    const sd = freshState();
    enable(sd);
    runSelf(["record", "use tabs for indentation", "--kind", "preference", "--scope", "global"], env(sd));

    const offByDefault = JSON.parse(runSelf(["recall", "indentation", "--json"], env(sd)).stdout);
    check("community defaults are OFF until asked for", false, offByDefault.community.on, JSON.stringify(offByDefault.community));
    check("...and recall works exactly as before", true, offByDefault.entries.some((e) => /tabs/.test(e.text)));

    // This stub answers in the REAL server's shape: a `patterns` array of
    // canonical sentences with an adoption BAND and no contributor count, plus
    // the `kAnonymity` the whole response was computed at.
    let cmode = "ok";
    const seen = [];
    const settingsSeen = [];
    let account = { contribute: false, receive: true };
    const cserver = http.createServer((req, res) => {
      const path0 = String(req.url).split("?")[0];
      if (path0 === "/api/v1/memory/settings") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          settingsSeen.push({ method: req.method, body });
          if (req.method === "PUT") {
            try {
              const p = JSON.parse(body);
              if (typeof p.receive === "boolean") account.receive = p.receive;
              if (typeof p.contribute === "boolean") account.contribute = p.contribute;
            } catch {
              /* asserted through `account` below */
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...account, kAnonymity: 8 }));
        });
        return;
      }
      seen.push(path0);
      if (cmode === "404") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      if (cmode === "401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Missing or invalid token."}');
        return;
      }
      if (cmode === "garbage") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>nope</html>");
        return;
      }
      const patterns = [
        { id: "code:pull-requests:prefer", kind: "code", topic: "pull-requests", directive: "prefer", text: "prefer small pull requests", adoption: "widespread", weight: 0.9 },
        { id: "code:indentation:prefer", kind: "code", topic: "indentation", directive: "prefer", text: "use spaces for indentation", adoption: "common", weight: 0.75 },
        { id: "x:band:unknown", kind: "code", topic: "band", directive: "prefer", text: "always deploy on a friday", adoption: "rumoured", weight: 0.9 },
        { id: "x:secret:leak", kind: "code", topic: "secret", directive: "prefer", text: `paste ${SECRET} into the header`, adoption: "widespread", weight: 0.9 },
      ];
      const doc =
        cmode === "no-k"
          ? { patterns, count: patterns.length, source: "toolbay-stack-common" }
          : cmode === "low-k"
            ? { patterns, count: patterns.length, kAnonymity: 2, source: "toolbay-stack-common" }
            : { patterns, count: patterns.length, computedAt: nowISO(), kAnonymity: 8, source: "toolbay-stack-common" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(doc));
    });
    await new Promise((res) => cserver.listen(0, "127.0.0.1", res));
    cserver.unref();
    const cbase = `http://127.0.0.1:${cserver.address().port}`;
    const cenv = (extra = {}) => env(sd, GOOD, { TOOLBAY_BASE_URL: cbase, TOOLBAY_TOKEN: "tb_live_communitytest", ...extra });

    const stillOff = await runSelfAsync(["recall", "indentation", "--json"], cenv());
    check("a reachable endpoint is still not used until you opt in", false, JSON.parse(stillOff.stdout).community.on);
    check("...and nothing was requested", 0, seen.length, JSON.stringify(seen));

    const on = await runSelfAsync(["community", "on"], cenv());
    check("`community on` exits 0", 0, on.status, on.stdout.slice(0, 200));
    check("...and says it does not start sending anything", true, /Nothing is sent by this/.test(on.stdout), on.stdout.slice(0, 240));
    const st = JSON.parse((await runSelfAsync(["status", "--json"], cenv())).stdout);
    check("RECEIVING DOES NOT REQUIRE CONTRIBUTING", true, st.community.receive && !st.community.contribute, JSON.stringify(st.community));
    check("...and memory itself is still on", true, st.on);

    const withCommunity = JSON.parse((await runSelfAsync(["recall", "indentation", "--json"], cenv())).stdout);
    check("community defaults arrive", true, withCommunity.community.ok, JSON.stringify(withCommunity.community).slice(0, 240));
    check("...in their own section, never mixed into your entries", false, JSON.stringify(withCommunity.entries).includes("small pull requests"), JSON.stringify(withCommunity.entries).slice(0, 200));
    check("...and are marked as not yours", true, withCommunity.community.defaults.every((d) => d.statedByUser === false), JSON.stringify(withCommunity.community.defaults.map((d) => d.text)));
    check("A USER PREFERENCE BEATS A COMMUNITY DEFAULT", false, withCommunity.community.defaults.some((d) => /spaces for indentation/.test(d.text)), JSON.stringify(withCommunity.community.defaults.map((d) => d.text)));
    check("...and the drop is reported, not hidden", true, withCommunity.community.overriddenByYou.some((d) => /spaces for indentation/.test(d.text)), JSON.stringify(withCommunity.community.overriddenByYou));
    check("...naming the entry of yours that won", true, withCommunity.community.overriddenByYou.every((d) => /^m_/.test(String(d.overriddenBy))), JSON.stringify(withCommunity.community.overriddenByYou));
    check("...and your own rule is what is actually recalled", true, withCommunity.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(withCommunity.entries.map((e) => e.text)));
    check("a pattern with an unrecognised adoption band is dropped", false, JSON.stringify(withCommunity.community.defaults).includes("friday"), JSON.stringify(withCommunity.community.defaults.map((d) => d.text)));
    check("A CREDENTIAL IN A COMMUNITY DEFAULT NEVER LANDS", false, JSON.stringify(withCommunity).includes(SECRET), JSON.stringify(withCommunity.community.defaults).slice(0, 200));
    check("...nor in the cache on disk", false, fs.readFileSync(path.join(sd, "memory", "community.json"), "utf8").includes(SECRET));
    check("a community default is never written into your store", false, storeText(sd).includes("small pull requests"), storeText(sd).slice(0, 200));
    check("the endpoint asked for is the agreed one", true, seen.every((u) => u === "/api/v1/memory/common"), JSON.stringify(seen));

    check("...and every default names the k the whole response was computed at", true, withCommunity.community.defaults.every((d) => d.computedAtK >= 5), JSON.stringify(withCommunity.community.defaults.map((d) => d.computedAtK)));

    // THE CLIENT-SIDE PRIVACY CHECK. The patterns deliberately carry no
    // contributor count, so the only thing this side can verify is that the
    // response states its own k and that it clears the floor. Both failures
    // refuse the WHOLE response: adopting "most" of it would be pretending.
    cmode = "no-k";
    const noK = JSON.parse((await runSelfAsync(["community", "fetch", "--json"], cenv())).stdout);
    check("a response that does not say what k it was computed at is refused WHOLE", 0, noK.defaults.length, JSON.stringify(noK).slice(0, 260));
    check("...and says that is why", true, /does not say what k-anonymity/.test(String(noK.reason)), String(noK.reason));
    cmode = "low-k";
    const lowK = JSON.parse((await runSelfAsync(["community", "fetch", "--json"], cenv())).stdout);
    check("a response computed below this client's k floor is refused WHOLE", 0, lowK.defaults.length, JSON.stringify(lowK).slice(0, 260));
    check("...naming both the server's k and this client's floor", true, /k=2.*floor of 5/.test(String(lowK.reason)), String(lowK.reason));
    cmode = "ok";

    // Contributing is a third switch, it moves independently in both directions,
    // and it is pushed to the ACCOUNT as well as held locally.
    const dryOff = JSON.parse(runSelf(["sync", "--dry-run"], cenv()).stdout);
    check("contributing is off while receiving is on", false, dryOff.body.contribute);
    check("the account was told receiving is on, and told nothing about contributing", true, settingsSeen.some((s) => s.method === "PUT" && /"receive":true/.test(s.body) && !/contribute/.test(s.body)), JSON.stringify(settingsSeen.slice(0, 3)));
    check("...so the account's own contribute flag is still off", false, account.contribute, JSON.stringify(account));

    settingsSeen.length = 0;
    await runSelfAsync(["community", "contribute", "on"], cenv());
    const dryOn = JSON.parse(runSelf(["sync", "--dry-run"], cenv()).stdout);
    check("...and turning it on is what puts it on the wire", true, dryOn.body.contribute);
    check("...and is pushed to the account on its own", true, settingsSeen.some((s) => s.method === "PUT" && /"contribute":true/.test(s.body) && !/receive/.test(s.body)), JSON.stringify(settingsSeen));
    check("...which leaves the account's receive flag exactly as it was", true, account.receive && account.contribute, JSON.stringify(account));

    await runSelfAsync(["community", "contribute", "off"], cenv());
    const stillReceiving = JSON.parse((await runSelfAsync(["status", "--json"], cenv())).stdout);
    check("turning contributing off does not turn receiving off", true, stillReceiving.community.receive && !stillReceiving.community.contribute, JSON.stringify(stillReceiving.community));
    check("...on the account either", true, account.receive && !account.contribute, JSON.stringify(account));
    const afterOffFetch = JSON.parse((await runSelfAsync(["community", "fetch", "--json"], cenv())).stdout);
    check("RECEIVING STILL WORKS WITH CONTRIBUTING OFF", true, afterOffFetch.ok && afterOffFetch.defaults.length > 0, JSON.stringify(afterOffFetch).slice(0, 240));

    // REQUIRED: degrade cleanly. 401, 404, garbage, and no server at all.
    cmode = "401";
    const unauth = await runSelfAsync(["community", "fetch", "--json"], cenv());
    check("a 401 from the endpoint exits 0", 0, unauth.status, unauth.stdout.slice(0, 200));
    check("...and names the token, not a generic failure", true, /needs a Toolbay token/.test(unauth.stdout), unauth.stdout.slice(0, 400));
    check("...and says the rest of memory works without one", true, /everything else here works without one/.test(unauth.stdout), unauth.stdout.slice(0, 400));
    cmode = "404";
    const forced404 = await runSelfAsync(["community", "fetch", "--json"], cenv());
    check("a 404 from the endpoint exits 0", 0, forced404.status, forced404.stdout.slice(0, 200));
    check("...and says HTTP 404 rather than pretending", true, /404/.test(forced404.stdout), forced404.stdout.slice(0, 300));
    cmode = "garbage";
    const garbage = await runSelfAsync(["community", "fetch", "--json"], cenv());
    check("a 200 that is not JSON at all is not merged", 0, garbage.status, garbage.stdout.slice(0, 200));
    check("...and says so", true, /answered 200 but not with JSON/.test(garbage.stdout), garbage.stdout.slice(0, 300));
    await new Promise((res) => cserver.close(res));

    const dead = { TOOLBAY_BASE_URL: "http://127.0.0.1:1" };
    fs.rmSync(path.join(sd, "memory", "community.json"), { force: true });
    const unreachable = await runSelfAsync(["recall", "indentation", "--json"], env(sd, GOOD, dead));
    check("AN UNREACHABLE ENDPOINT NEVER BLOCKS OR FAILS A RECALL", 0, unreachable.status, unreachable.stdout.slice(0, 200));
    const udoc = JSON.parse(unreachable.stdout);
    check("...your own entries come back exactly as before", true, udoc.entries.some((e) => /tabs/.test(e.text)), JSON.stringify(udoc.entries.map((e) => e.text)));
    check("...it reports that community defaults are unavailable", false, udoc.community.ok);
    check("...AND SAYS WHY", true, /ECONNREFUSED|fetch failed|timed out|answered/.test(String(udoc.community.reason)), String(udoc.community.reason));
    const uprose = await runSelfAsync(["recall", "indentation"], env(sd, GOOD, dead));
    check("...and in prose says your own entries are unaffected", true, /Everything above is yours and is unaffected/.test(uprose.stdout), uprose.stdout.slice(-400));
    const cstatus = await runSelfAsync(["community"], env(sd, GOOD, dead));
    check("`community` with no server exits 0", 0, cstatus.status, cstatus.stdout.slice(0, 200));
    check("...and says memory is working exactly as it does with this off", true, /working exactly as it does with this switched off/.test(cstatus.stdout), cstatus.stdout.slice(0, 400));
    const offAgain = await runSelfAsync(["community", "off"], env(sd, GOOD, dead));
    check("`community off` exits 0", 0, offAgain.status, offAgain.stdout.slice(0, 160));
    check("...and stops it being applied", false, JSON.parse((await runSelfAsync(["recall", "indentation", "--json"], env(sd, GOOD, dead))).stdout).community.on);
    check("community defaults never touched the store through any of that", 1, entriesOf(sd).length, storeText(sd).slice(0, 200));
    check("`community` with an unknown subcommand is refused", REFUSED, (await runSelfAsync(["community", "sideways"], env(sd, GOOD, dead))).status);
  }
  {
    // Turning receiving on before memory itself is on must not turn memory on.
    const sd = freshState();
    const r = runSelf(["community", "on"], env(sd));
    check("`community on` before opting in exits 0", 0, r.status, r.stdout.slice(0, 160));
    check("...and does NOT opt you in to capture", false, JSON.parse(runSelf(["status", "--json"], env(sd)).stdout).on);
    check("...and records nothing", false, fs.existsSync(storeFileOf(sd)), storeText(sd).slice(0, 120));
    enable(sd);
    check("...and enabling later keeps the community choice", true, JSON.parse(runSelf(["status", "--json"], env(sd)).stdout).community.receive);
  }

  // ---- Unknown input.
  {
    const sd = freshState();
    check("an unknown command is refused", REFUSED, runSelf(["not-a-command"], env(sd)).status);
    check("help exits 0", 0, runSelf(["help"], env(sd)).status);
    check("an unknown option is refused", REFUSED, runSelf(["status", "--nope"], env(sd)).status);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-memory", results);
}

function report(label, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  ${label} selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return false;
  }
  process.stdout.write("\n  No config, a corrupt config, a config with no kinds, and consent never given\n");
  process.stdout.write("  all record NOTHING and say why. An API key pasted into a correction is absent\n");
  process.stdout.write("  from the store file, the export, and the bytes on the wire, checked against a\n");
  process.stdout.write("  real HTTP server. No token, a dead port, a 500, and an unusable 200 body all\n");
  process.stdout.write("  leave every local entry in place and exit 0. A corrupt store is never written\n");
  process.stdout.write("  over. An unknown forget id changes nothing. A superseded entry never returns.\n");
  process.stdout.write("\n  A contradiction is never resolved silently: both sides are shown with both\n");
  process.stdout.write("  dates and both reasons, neither is applied, and `resolve` with no choice\n");
  process.stdout.write("  refuses. An unclear scope goes NARROW, and a project rule is proved not to\n");
  process.stdout.write("  leak into another project even when its kind is force-included. A derived\n");
  process.stdout.write("  trait never enters the entry list, is killed outright by one thing the user\n");
  process.stdout.write("  actually said, and cannot be resurrected once rejected. An imported entry\n");
  process.stdout.write("  cannot supersede a stated one. A key inside an imported CLAUDE.md is absent\n");
  process.stdout.write("  from the store. A community default loses to the user's own rule, and a\n");
  process.stdout.write("  missing, 404, unreachable or unparseable community endpoint leaves recall\n");
  process.stdout.write("  working exactly as it does without the feature, and says so.\n\n");
  return true;
}

// ----------------------------------------------------------------------- entry

function help() {
  out(`
${bold("tb-memory")} ${VERSION} ${dim("(Toolbay Stack memory layer)")}

  ${cyan("tb-memory enable")}                  read the disclosure, then opt in with --yes
  ${cyan("tb-memory onboard")}                 the 60-second guide to prompting this stack
  ${cyan("tb-memory record \"<what>\"")}         keep a correction, and the reason for it
  ${cyan("tb-memory recall [query]")}          what is worth knowing before starting work
  ${cyan("tb-memory list")}                    everything held, including what no longer applies
  ${cyan("tb-memory forget <id>")}             delete one entry, here and on your account
  ${cyan("tb-memory export")}                  the whole store, as JSON
  ${cyan("tb-memory sync")}                    push to your Toolbay account and merge back
  ${cyan("tb-memory status")}                  what is on, what is held, where it goes
  ${cyan("tb-memory disable")}                 stop capturing (--forget-everything wipes it)
  ${cyan("tb-memory repair")}                  quarantine an unreadable store and start clean
  ${cyan("tb-memory selftest")}                prove it fails closed on broken input

${bold("when two things you said disagree")}
  ${cyan("tb-memory conflicts")}               every unresolved contradiction, both sides
  ${cyan("tb-memory resolve <id> --replace")}         the new one replaces the old
  ${cyan("tb-memory resolve <id> --both")}            both true, in different contexts
  ${cyan("tb-memory resolve <id> --old-was-wrong")}   the old one was never right
  ${dim("Nothing is applied from either side until you pick. There is no default.")}

${bold("scope")}
  ${cyan("tb-memory rescope <id> --scope global|project|path")}
  ${dim("Recorded scope is inferred from what you said, and when that is unclear it")}
  ${dim("goes NARROW: this project, not everywhere. Widening is one command.")}

${bold("the model of you, which you can reject")}
  ${cyan("tb-memory traits")}                  what your corrections add up to, with evidence
  ${cyan("tb-memory reject-trait <key>")}      wrong. Never derive it again.
  ${cyan("tb-memory accept-trait <key>")}      right — and still labelled inferred

${bold("seeding from what you already wrote")}
  ${cyan("tb-memory import claude-md --from <path>")}
  ${cyan("tb-memory import gstack-learnings --from <path>")}
  ${cyan("tb-memory import markdown --from <path>")}
  ${cyan("tb-memory imports")} / ${cyan("tb-memory unimport <batch>")}
  ${dim("Shows every line and writes nothing until --yes. One command undoes a batch.")}

${bold("community defaults")}
  ${cyan("tb-memory community")}               receiving, contributing, and what is held
  ${cyan("tb-memory community on|off")}        receive defaults many people converged on
  ${cyan("tb-memory community contribute on|off")}   independent. Receiving never needs it.

${bold("record options")}
  --kind <name>       which kind, from memory.json. Default: correction
  --why "<reason>"    REQUIRED for a correction. The reason is what transfers.
  --about <topic>     group by subject, so contradictions about it are detected
  --scope <level>     global | project | path. Default is inferred, and narrow.
  --scope-value <v>   the project, language, extension or pattern for that scope
  --source <s>        stated (default) or imported. Never inferred.
  --supersedes <id>   replace a specific entry, when you already know
  --weight <n>        override the kind's weight

${bold("Other options")}
  --json     machine-readable, for a skill to consume
  --limit    recall: how many
  --path / --lang / --project   recall: where you are, so scope can be applied
  --all      import: include lines that do not read as rules
  --dry-run  sync: print the exact payload instead of sending it
  --pull     sync: read-only. Take what the account has, send nothing.
  --remote   export: ask the account for ITS copy, not this machine's
  --strict   sync: exit non-zero if it did not sync (CI). Default is exit 0.

${bold("The rules")}
  Off until you turn it on. Credentials are stripped before anything is written
  and before anything is sent, including out of anything you import. Source code
  is refused. A missing, corrupt, or empty config means this layer records
  NOTHING rather than guessing a policy. Sync failures never lose a local entry
  and never block you. A contradiction is never resolved for you. An inference
  is never presented as something you said and can never overrule one. If the
  community endpoint is missing, everything above works exactly as it does now.

${bold("You edit")}  ${dim(configPath())}
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = {
    json: false,
    yes: false,
    dryRun: false,
    pull: false,
    remote: false,
    strict: false,
    all: false,
    forgetEverything: false,
    replace: false,
    both: false,
    oldWasWrong: false,
    kind: null,
    why: null,
    about: null,
    source: null,
    supersedes: null,
    weight: null,
    limit: null,
    outFile: null,
    scope: null,
    scopeValue: null,
    newScope: null,
    newScopeValue: null,
    oldScope: null,
    oldScopeValue: null,
    project: null,
    path: null,
    lang: null,
    from: null,
  };
  const args = [];
  let bad = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--pull") flags.pull = true;
    else if (a === "--remote") flags.remote = true;
    else if (a === "--strict") flags.strict = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--forget-everything") flags.forgetEverything = true;
    else if (a === "--replace") flags.replace = true;
    else if (a === "--both") flags.both = true;
    else if (a === "--old-was-wrong") flags.oldWasWrong = true;
    else if (a === "--kind" && argv[i + 1]) flags.kind = argv[(i += 1)];
    else if (a === "--why" && argv[i + 1]) flags.why = argv[(i += 1)];
    else if (a === "--about" && argv[i + 1]) flags.about = argv[(i += 1)];
    else if (a === "--source" && argv[i + 1]) flags.source = argv[(i += 1)];
    else if (a === "--supersedes" && argv[i + 1]) flags.supersedes = argv[(i += 1)];
    else if (a === "--weight" && argv[i + 1]) flags.weight = argv[(i += 1)];
    else if (a === "--limit" && argv[i + 1]) flags.limit = argv[(i += 1)];
    else if (a === "--out" && argv[i + 1]) flags.outFile = argv[(i += 1)];
    else if (a === "--scope" && argv[i + 1]) flags.scope = argv[(i += 1)];
    else if (a === "--scope-value" && argv[i + 1]) flags.scopeValue = argv[(i += 1)];
    else if (a === "--new-scope" && argv[i + 1]) flags.newScope = argv[(i += 1)];
    else if (a === "--new-scope-value" && argv[i + 1]) flags.newScopeValue = argv[(i += 1)];
    else if (a === "--old-scope" && argv[i + 1]) flags.oldScope = argv[(i += 1)];
    else if (a === "--old-scope-value" && argv[i + 1]) flags.oldScopeValue = argv[(i += 1)];
    else if (a === "--project" && argv[i + 1]) flags.project = argv[(i += 1)];
    else if (a === "--path" && argv[i + 1]) flags.path = argv[(i += 1)];
    else if (a === "--lang" && argv[i + 1]) flags.lang = argv[(i += 1)];
    else if (a === "--from" && argv[i + 1]) flags.from = argv[(i += 1)];
    else if (a.startsWith("--")) bad = a;
    else args.push(a);
  }
  if (bad) {
    out(`\n  Unknown option ${bad}. Try: tb-memory help\n`);
    process.exitCode = REFUSED;
    return;
  }
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") help();
  else if (cmd === "enable" || cmd === "on") cmdEnable(flags);
  else if (cmd === "disable" || cmd === "off") cmdDisable(flags);
  else if (cmd === "onboard" || cmd === "teach") cmdOnboard();
  else if (cmd === "record" || cmd === "remember") cmdRecord(rest, flags);
  else if (cmd === "recall" || cmd === "load") await cmdRecall(rest, flags);
  else if (cmd === "list") cmdList(flags);
  else if (cmd === "forget") cmdForget(rest);
  else if (cmd === "rescope") cmdRescope(rest, flags);
  else if (cmd === "conflicts") cmdConflicts(flags);
  else if (cmd === "resolve") cmdResolve(rest, flags);
  else if (cmd === "traits") cmdTraits(flags);
  else if (cmd === "reject-trait") cmdTraitVerdict(rest, true);
  else if (cmd === "accept-trait") cmdTraitVerdict(rest, false);
  else if (cmd === "import" || cmd === "seed") cmdImport(rest, flags);
  else if (cmd === "imports") cmdImports(flags);
  else if (cmd === "unimport") cmdUnimport(rest);
  else if (cmd === "community") await cmdCommunity(rest, flags);
  else if (cmd === "export") await cmdExport(flags);
  else if (cmd === "sync") await cmdSync(flags);
  else if (cmd === "status") cmdStatus(flags);
  else if (cmd === "repair") cmdRepair(flags);
  else if (cmd === "config" || cmd === "path") out(configPath());
  else if (cmd === "selftest") await selftest();
  else {
    out(`\n  Unknown command ${cmd}. Try: tb-memory help\n`);
    process.exitCode = REFUSED;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    // This layer is never allowed to take a session down with it, and it is
    // never allowed to fail in the direction of recording something.
    process.stdout.write(`\n  tb-memory hit an unexpected error and recorded nothing.\n`);
    process.stdout.write(`  ${err && err.stack ? err.stack.split("\n")[0] : String(err)}\n\n`);
    process.exitCode = 1;
  }
}

export { effectiveWeight, supersededBy, refuseReason, contractEntry };
