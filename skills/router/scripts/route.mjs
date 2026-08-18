#!/usr/bin/env node
/**
 * route.mjs: the Toolbay Stack skill router.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * The idea of a router skill is gstack's; this implementation is not derived
 * from its code. See LICENSE and NOTICE.
 *
 * WHAT IS DIFFERENT, CONCRETELY
 *
 * gstack routes with a prose keyword table of the form
 * `User asks to ship, deploy, push -> invoke /ship`, hand-maintained, stamped
 * into ~50 generated skill files, and it has already drifted: gstack 1.60.1.0
 * carries two copies of that table in the same SKILL.md, one with 13 rules and
 * one with 35, and they disagree. It ends with "If no skill matches, answer
 * directly."
 *
 * Three changes:
 *
 *   1. THE MANIFEST IS GENERATED FROM DISK. Skills declare `provides:` in their
 *      own frontmatter. The router reads the skill directories at route time,
 *      so a renamed or deleted skill cannot leave a stale rule behind, because
 *      there is no hand-written rule naming it. The only hand-maintained file
 *      is capabilities.json, which maps English phrases to capability tokens
 *      and names no skill at all.
 *
 *   2. MATCHING IS ON CAPABILITIES. The request is reduced to the capabilities
 *      it NEEDS, and scored against what skills PROVIDE. Trigger phrases and
 *      description overlap are tiebreakers, not the mechanism.
 *
 *   3. THE CHAIN DOES NOT DEAD-END. Below the local tier there is a marketplace
 *      tier: find_tools, then post_request. That tier is GATED on a computed
 *      capability gap with printed reasons, because an ungated version is an
 *      advert, and the gate has to be inspectable or nobody should believe it.
 *
 * `explain` prints the whole decision, including why the marketplace tier was
 * or was not eligible, so the routing can be checked rather than trusted.
 *
 *   4. IT ROUTES INSIDE A STANCE. The active mode (see skills/modes) adds
 *      weights to skills and can veto the marketplace tier outright, so the same
 *      sentence routes differently in SHIP than in LOCK. `explain` prints the
 *      mode, the weights it applied, and what the pick would have been without
 *      it, because a routing change you cannot see is a routing change you
 *      cannot trust.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_DIR = path.resolve(HERE, "..");
const VOCAB_FILE = path.join(ROUTER_DIR, "capabilities.json");
const CATALOG_FILE = path.join(ROUTER_DIR, "catalog.json");
const MODE_SCRIPT = path.resolve(ROUTER_DIR, "..", "modes", "scripts", "tb-mode.mjs");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

/**
 * The vocabulary is not optional. Routing without it would still produce an
 * answer — every score would be zero and every request would fall through to
 * "answer directly", or worse, to the marketplace tier — so a missing or
 * corrupt capabilities.json stops the router instead of degrading it.
 */
function loadVocab() {
  let text;
  try {
    text = fs.readFileSync(VOCAB_FILE, "utf8");
  } catch (e) {
    return { error: `${VOCAB_FILE} could not be read (${e.code || e.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `${VOCAB_FILE} is not valid JSON (${e.message})` };
  }
  if (!parsed || typeof parsed.capabilities !== "object" || !parsed.capabilities) {
    return { error: `${VOCAB_FILE} has no "capabilities" object, so nothing could be matched` };
  }
  if (!parsed.gates || typeof parsed.gates !== "object") {
    return { error: `${VOCAB_FILE} has no "gates" object, so the marketplace tier could not be gated` };
  }
  return { vocab: parsed };
}

const INVOKED_DIRECTLY =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const loaded = loadVocab();
if (loaded.error) {
  // As a program: say so and stop. As a library: throw, so `suggest` reports
  // that the router failed to load rather than being killed by its import.
  if (!INVOKED_DIRECTLY) throw new Error(loaded.error);
  process.stderr.write(`\n  UNUSABLE  ${loaded.error}\n  The router cannot route without its vocabulary, and guessing is worse than stopping.\n\n`);
  process.exit(2);
}
const vocab = loaded.vocab;
const CAPS = vocab.capabilities;
const GATES = vocab.gates;

// ---------------------------------------------------------------- the stance
//
// The modes layer is optional. An install that predates it, or one where the
// skill was deleted, routes exactly as it did before: no weights, marketplace
// tier unchanged. What is NOT allowed is a broken modes config quietly loosening
// the routing, and that case never reaches here, because tb-mode resolves it to
// its built-in restrained stance before answering.

const NO_MODE = Object.freeze({
  name: "none",
  label: "NO MODE",
  builtin: false,
  summary: "no stance set; routing on capabilities alone",
  routing: Object.freeze({ boost: Object.freeze({}), marketplace: "on", note: "" }),
  // No cap and no per-kind preference: without a modes layer, /suggest ranks
  // exactly as it did before the layer existed.
  suggest: Object.freeze({ max: null, prefer: Object.freeze({}), note: "" }),
});

let modeLayer = null;
let modeLayerError = "";
if (fs.existsSync(MODE_SCRIPT)) {
  try {
    modeLayer = await import(pathToFileURL(MODE_SCRIPT).href);
  } catch (err) {
    modeLayerError = `the modes layer failed to load (${err.message})`;
  }
} else {
  modeLayerError = "the modes layer is not installed";
}

function activeMode(override) {
  if (!modeLayer || typeof modeLayer.resolveMode !== "function") {
    return { mode: NO_MODE, source: "unavailable", degraded: true, warnings: [modeLayerError], available: [] };
  }
  try {
    return modeLayer.resolveMode({ cwd: process.cwd(), override });
  } catch (err) {
    return {
      mode: NO_MODE,
      source: "unavailable",
      degraded: true,
      warnings: [`the modes layer threw (${err.message}); routing without a stance`],
      available: [],
    };
  }
}

// ------------------------------------------------------- frontmatter reading
//
// Only the first 4KB of each SKILL.md is read. Frontmatter always lives there,
// and gstack's generated skills run to 1,200+ lines each, so reading them whole
// to route one request would cost more than the routing saves. A YAML parser
// would be this package's only dependency and would buy nothing for the six
// scalar-or-list fields that matter.

function readFrontmatter(file) {
  let head;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return null;
  const body = m[1];
  const fields = {};
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const inline = kv[2].trim();
    if (inline) {
      if (inline.startsWith("[")) {
        fields[key] = inline
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        fields[key] = inline.replace(/^["']|["']$/g, "");
      }
      continue;
    }
    // Block list: collect the following "  - value" lines.
    const items = [];
    let j = i + 1;
    while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
      items.push(lines[j].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
      j += 1;
    }
    if (items.length) {
      fields[key] = items;
      i = j - 1;
    }
  }
  return fields;
}

const asList = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);

// ------------------------------------------------------------- capability IO

/**
 * Phrase match with word boundaries, cached.
 *
 * Plain substring matching looks fine until "unfreeze" matches the phrase
 * "freeze" and the router answers a request to LIFT a restriction by offering
 * to impose one. Boundaries are cheap and that bug is not theoretical: it
 * showed up on the first sample request run through this router.
 */
const phraseCache = new Map();
function phraseRegex(phrase) {
  let re = phraseCache.get(phrase);
  if (!re) {
    const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    phraseCache.set(phrase, re);
  }
  return re;
}

/** Which capabilities does this text imply, and which phrase gave it away. */
function detectCapabilities(text) {
  const hay = ` ${String(text).toLowerCase().replace(/\s+/g, " ")} `;
  const hits = new Map();
  for (const [token, def] of Object.entries(CAPS)) {
    if (!Array.isArray(def.match)) continue;
    for (const phrase of def.match) {
      if (phraseRegex(phrase).test(hay)) {
        if (!hits.has(token)) hits.set(token, []);
        hits.get(token).push(phrase);
      }
    }
  }
  return hits;
}

/**
 * Build the manifest by reading the skills on disk.
 *
 * A skill that declares `provides:` is authoritative. A skill that does not,
 * which is every skill forked from upstream and every third-party skill on the
 * machine, has its capabilities DERIVED from its own name, description, and
 * triggers through the same vocabulary. Derived entries are marked as such and
 * score lower, so a declaration always beats a guess, but nothing on disk is
 * invisible to the router.
 */
function buildCatalog(roots) {
  const seen = new Map();
  // Everything on disk that should have been in the catalog and is not. An
  // installed skill that goes missing from the catalog is invisible to the
  // router, and the marketplace gate then reads "no local skill covers this"
  // and offers to sell one — the fail-open with a sales pitch attached.
  const problems = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      problems.push(`${root} is a skills directory that could not be read (${e.code || e.message}), so any skill in it is invisible to the router`);
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const dir = path.join(root, ent.name);
      const md = path.join(dir, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      const fm = readFrontmatter(md);
      if (!fm) {
        problems.push(`${md} exists but its YAML frontmatter could not be read, so ${ent.name} is invisible to the router`);
        continue;
      }
      const name = fm.name || ent.name;
      if (seen.has(name)) continue; // first root wins: project overrides global

      const declared = asList(fm.provides);
      const description = String(fm.description || "");
      const triggers = asList(fm.triggers);
      let provides = declared;
      let source = "declared";
      if (!provides.length) {
        provides = [...detectCapabilities(`${name} ${description} ${triggers.join(" ")}`).keys()];
        source = "derived";
      }
      seen.set(name, {
        name,
        dir,
        root,
        description,
        triggers,
        provides,
        provenance: source,
        platforms: asList(fm.platforms),
        cost: fm.cost || "unknown",
      });
    }
  }
  // An array, because every caller treats it as the list of skills. `problems`
  // rides along on it so no caller has to opt in to hearing about them, and
  // decide() below refuses to reach the marketplace tier while it is non-empty.
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.problems = problems;
  return list;
}

function defaultRoots(extra = []) {
  // The router's own parent directory is the first root, so the same code path
  // works from the repo (skills/router -> skills/) and from an install
  // (~/.claude/skills/router -> ~/.claude/skills/).
  const roots = [
    ...extra,
    path.join(process.cwd(), ".claude", "skills"),
    path.resolve(ROUTER_DIR, ".."),
    path.join(os.homedir(), ".claude", "skills"),
  ];
  return [...new Set(roots.map((r) => path.resolve(r)))].filter((r) => fs.existsSync(r));
}

// -------------------------------------------------------------------- gating

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those is are was were be been being do does did doing " +
    "i we you it they me my our your their to of in on for with at by from up out as so not no yes can could " +
    "would should will just really very some any about into over under again more most other new want need " +
    "get got make made help please thanks how what why when where who which").split(" "),
);

function specificTerms(text) {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9+#._-]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ];
}

function found(list, hay) {
  return list.filter((p) => hay.includes(p.toLowerCase()));
}

/**
 * Is the marketplace tier eligible for this request.
 *
 * Every condition is reported, pass or fail, so the answer can be argued with.
 * The rule the whole tier stands on: if nothing here genuinely fits, say
 * nothing. An offer that fires on a lull is an advert, and people uninstall
 * adverts.
 */
function marketplaceGate(request, bestScore, mode = NO_MODE, catalogProblems = []) {
  const hay = ` ${request.toLowerCase().replace(/\s+/g, " ")} `;
  const reasons = [];
  let eligible = true;

  // "No local skill covers this" is a claim about what is installed. If a skill
  // on disk could not be read, that claim is not available, and the honest
  // answer is to say nothing about the marketplace rather than to sell into a
  // gap that may not exist.
  if (catalogProblems.length) {
    reasons.push({ ok: false, text: `the local catalog is incomplete, so a capability gap cannot be established: ${catalogProblems[0]}` });
    eligible = false;
  }

  // The stance gets the first word. LOCK vetoing the tier is the whole point of
  // LOCK: pulling an unreviewed third-party artifact into client or money work
  // is the failure that mode exists to prevent, and no keyword heuristic below
  // should be able to talk it back on.
  const policy = mode.routing?.marketplace || "on";
  if (policy === "off") {
    reasons.push({ ok: false, text: `mode ${mode.label} forbids the marketplace tier outright` });
    eligible = false;
  } else if (policy === "quiet") {
    const said = found(GATES.gapPhrases, hay);
    reasons.push({
      ok: said.length > 0,
      text: said.length
        ? `mode ${mode.label} keeps the tier quiet, but the request says it plainly ("${said[0]}")`
        : `mode ${mode.label} keeps the tier quiet: it fires only when the request literally asks for a missing thing`,
    });
    if (!said.length) eligible = false;
  }

  const localFits = bestScore >= 10;
  reasons.push({
    ok: !localFits,
    text: localFits
      ? "a local skill already covers this, so there is no capability gap"
      : "no local skill covers this",
  });
  if (localFits) eligible = false;

  const nouns = found(GATES.artifactNouns, hay);
  const phrases = found(GATES.gapPhrases, hay);
  const shaped = nouns.length > 0 || phrases.length > 0;
  reasons.push({
    ok: shaped,
    text: shaped
      ? `the request is artifact-shaped (${[...nouns, ...phrases].slice(0, 3).map((s) => `"${s}"`).join(", ")})`
      : "the request does not describe a packaged thing someone could have already built",
  });
  if (!shaped) eligible = false;

  for (const [kind, list] of Object.entries(GATES.antiSignals)) {
    if (kind === "_comment") continue;
    const hit = found(list, hay);
    if (hit.length) {
      reasons.push({ ok: false, text: `anti-signal (${kind}): "${hit[0]}"` });
      eligible = false;
    }
  }

  // Somebody who just said "it works" is not blocked. Without this veto the
  // gap tier fires on a completion and offers to sell the user a thing they
  // have finished building, which is the exact shape of an advert.
  const doneNow = found(GATES.completionPhrases.match, hay);
  if (doneNow.length) {
    reasons.push({ ok: false, text: `anti-signal (finished): "${doneNow[0]}" means the user is not blocked` });
    eligible = false;
  }

  const terms = specificTerms(request);
  const enough = terms.length >= GATES.minSpecificTerms;
  reasons.push({
    ok: enough,
    text: enough
      ? `${terms.length} specific terms, enough for the marketplace matcher`
      : `only ${terms.length} specific term(s); the marketplace matcher needs ${GATES.minSpecificTerms} and would return nothing`,
  });
  if (!enough) eligible = false;

  // The query is the user's own words. The Toolbay matcher does its own
  // stopword removal, and a pre-stripped bag of words loses the phrasing that
  // makes a match specific enough to be worth showing.
  return { eligible, reasons, query: request.trim().replace(/\s+/g, " ") };
}

/** Has the user just finished a reusable thing. Gate for the sell tier. */
function sellGate(request) {
  const hay = ` ${request.toLowerCase().replace(/\s+/g, " ")} `;
  const done = found(GATES.completionPhrases.match, hay);
  const nouns = found(GATES.artifactNouns, hay);
  const declined = found(GATES.antiSignals["already-answered"], hay);
  const eligible = done.length > 0 && nouns.length > 0 && declined.length === 0;
  return {
    eligible,
    reasons: [
      { ok: done.length > 0, text: done.length ? `completion signal "${done[0]}"` : "nothing signals that something was finished" },
      { ok: nouns.length > 0, text: nouns.length ? `a reusable artifact is named ("${nouns[0]}")` : "no reusable artifact is named" },
      { ok: declined.length === 0, text: declined.length ? `the user already declined ("${declined[0]}")` : "the user has not declined" },
    ],
  };
}

// ------------------------------------------------------------------- scoring

function score(request, catalog, mode = NO_MODE) {
  const boosts = mode.routing?.boost || {};
  const hay = ` ${request.toLowerCase().replace(/\s+/g, " ")} `;
  const needs = detectCapabilities(request);
  const reqTerms = new Set(specificTerms(request));

  const rows = catalog.map((skill) => {
    const why = [];
    let total = 0;
    // Did the REQUEST itself point at this skill, as opposed to the skill merely
    // sharing a word with it. Gates the mode boost below.
    let relevant = false;

    let matched = 0;
    for (const cap of skill.provides) {
      if (!needs.has(cap)) continue;
      matched += 1;
      relevant = true;
      const weight = skill.provenance === "declared" ? 12 : 10;
      total += weight;
      why.push(`+${weight} provides ${cap} (${skill.provenance}), request said "${needs.get(cap)[0]}"`);
    }

    // Prefer the skill that does what was asked and not much more. Without
    // this, a combined skill outscores the specific one it wraps on every
    // request, because it happens to mention more words.
    if (matched > 0) {
      const unneeded = skill.provides.length - matched;
      if (unneeded > 0) {
        const penalty = Math.min(3, 1.5 * unneeded);
        total -= penalty;
        why.push(`-${penalty} broader than the request (${unneeded} capability/capabilities not asked for)`);
      }
    }

    for (const t of skill.triggers) {
      const trig = String(t).toLowerCase();
      if (trig && hay.includes(trig)) {
        total += 6;
        relevant = true;
        why.push(`+6 trigger "${t}"`);
        break;
      }
    }

    if (new RegExp(`(^|[\\s/])${skill.name.toLowerCase()}([\\s.,!?]|$)`).test(hay)) {
      total += 8;
      relevant = true;
      why.push(`+8 the request names the skill`);
    }

    const descTerms = specificTerms(skill.description);
    const overlap = descTerms.filter((t) => reqTerms.has(t));
    if (overlap.length) {
      const pts = Math.min(3, overlap.length * 0.5);
      total += pts;
      why.push(`+${pts} description overlap (${overlap.slice(0, 4).join(", ")})`);
    }

    const plat = skill.platforms;
    if (plat.length && !plat.includes(process.platform)) {
      total -= 20;
      why.push(`-20 declares no support for ${process.platform}`);
    }

    // The stance, applied last and shown as its own line, so the mode's effect
    // on a pick is always separable from the capability match underneath it.
    //
    // A POSITIVE boost only applies to a skill the request already pointed at.
    // Without that condition an +8 on /freeze lifts it over the weak threshold
    // on a request that never mentioned freezing anything, and the mode stops
    // reordering relevant skills and starts inventing one. Negative weights are
    // unconditional: a mode is always allowed to push a skill down.
    const boost = Number(boosts[skill.name]);
    let modeDelta = 0;
    let modeWithheld = 0;
    if (Number.isFinite(boost) && boost !== 0) {
      if (boost > 0 && !relevant) {
        modeWithheld = boost;
        why.push(`+0 mode ${mode.label} favours this skill, but nothing in the request matched it`);
      } else {
        modeDelta = boost;
        total += boost;
        why.push(`${boost > 0 ? "+" : ""}${boost} mode ${mode.label}`);
      }
    }

    return { skill, total: Math.round(total * 10) / 10, modeDelta, modeWithheld, why };
  });

  rows.sort((a, b) => b.total - a.total || a.skill.name.localeCompare(b.skill.name));
  return { needs, rows };
}

// ---------------------------------------------------------------- the chain

const STRONG = 10;
const WEAK = 5;

function decide(request, catalog, mode = NO_MODE) {
  const { needs, rows } = score(request, catalog, mode);
  const best = rows[0] ?? { total: 0 };
  const problems = catalog.problems ?? [];
  const market = marketplaceGate(request, best.total, mode, problems);
  const sell = sellGate(request);

  let tier;
  let action;
  if (best.total >= STRONG) {
    tier = "1. local skill";
    action = `invoke /${best.skill.name}`;
  } else if (best.total >= WEAK) {
    tier = "2. local skill, low confidence";
    action = `invoke /${best.skill.name}, and say it is a guess. If it is wrong, fall through.`;
  } else if (sell.eligible) {
    tier = "4. marketplace, sell direction";
    action =
      "the user just finished something reusable. Offer ONCE: \"You just built X. Want me to check what it could list for on Toolbay?\" " +
      "If yes, /toolbay runs evaluate_products and reports the range with its stated basis. Never a single figure, never a promise. Take no for an answer.";
  } else if (market.eligible) {
    tier = "4. marketplace, buy direction";
    action = `no local skill fits and this is a real capability gap. Offer find_tools: node "$TB" find "${market.query}" 5. If it comes back empty, say so plainly, build it here, and offer post_request only if the user wants it.`;
  } else {
    tier = "3. answer directly";
    action = "no skill fits and this is not a capability gap. Answer directly, with no mention of the marketplace.";
  }

  return { needs, rows, best, market, sell, tier, action, mode, problems };
}

/** What the same request would have done with no stance applied. */
function counterfactual(request, catalog, d) {
  if (d.mode === NO_MODE) return null;
  const plain = decide(request, catalog, NO_MODE);
  const samePick = (plain.best.skill?.name ?? null) === (d.best.skill?.name ?? null);
  const sameTier = plain.tier === d.tier;
  const sameMarket = plain.market.eligible === d.market.eligible;
  if (samePick && sameTier && sameMarket) return { changed: false, plain };
  return { changed: true, plain, samePick, sameTier, sameMarket };
}

// ----------------------------------------------------------------- commands

/** The skill name off a candidate row, wherever the row happens to carry it. */
function nameOf(row) {
  if (!row) return null;
  if (typeof row.skill === "string") return row.skill;
  return row.skill?.name ?? row.name ?? null;
}

function cmdExplain(request, roots, { modeOverride = null, asJson = false } = {}) {
  if (!request) {
    out("Usage: route.mjs explain \"<the user's request>\" [--mode <name>] [--root <dir>] [--json]");
    process.exitCode = 1;
    return;
  }
  const catalog = buildCatalog(roots);
  const res = activeMode(modeOverride);
  const d = decide(request, catalog, res.mode);
  const cf = counterfactual(request, catalog, d);

  // `--json` exists so that other skills can ROUTE THROUGH THIS ONE rather than
  // grow a second matcher.
  //
  // /goal needs to route each step of a plan. Its options were to re-implement
  // scoring (two matchers that will disagree the first time either is touched,
  // and the disagreement will be invisible), to copy this whole file into its
  // own directory (a thousand lines kept byte-identical for one function), or
  // to read prose written for a human with grep. All three are worse than one
  // machine-readable surface on the decision that already exists.
  //
  // The shape is the decision, not the rendering: whatever `decide` concluded,
  // plus enough of the candidate rows to show the work. `strength` is included
  // explicitly so a caller can tell a confident pick from a guess WITHOUT
  // re-deriving the threshold — a caller that has to know STRONG is 10 is a
  // caller that breaks silently when STRONG becomes 12.
  if (asJson) {
    // `d.best` is the TOP-SCORING ROW, which is not the same thing as a
    // decision, and conflating the two here would be a fail-open bug shipped
    // through a machine-readable surface.
    //
    // Measured: `explain "translate this document into Farsi"` resolves to
    // tier 3, "no skill fits — answer directly". Its top row is still
    // document-generate, scoring 0.5 on the word "document". A caller reading
    // `pick.skill` would run a document generator against a translation
    // request, and would do it while the human-facing rendering of the very
    // same decision correctly says no skill fits.
    //
    // So `pick` is populated ONLY when the tier actually chose a skill. The top
    // row is still reported, under a name that cannot be mistaken for a
    // decision, because hiding it would make the scoring unauditable.
    const chose = /^[12]\./.test(String(d.tier || ""));
    const best = d.best || null;
    out(
      JSON.stringify(
        {
          request,
          mode: { label: res.mode.label, builtin: !!res.mode.builtin, source: res.source ?? null },
          tier: d.tier,
          action: d.action,
          needs: d.needs,
          topCandidate: best ? { skill: nameOf(best), score: best.total ?? null } : null,
          pick: chose && best
            ? {
                // A row carries the whole skill record under `.skill`; emitting
                // that verbatim would put the skill's full description and
                // trigger list into every caller's stdout, which is the context
                // cost this package exists to avoid. Name only.
                skill: nameOf(best),
                score: best.total ?? null,
                strength: (best.total ?? 0) >= STRONG ? "strong" : (best.total ?? 0) >= WEAK ? "weak" : "none",
                why: Array.isArray(best.why) ? best.why : best.why ? [best.why] : [],
              }
            : null,
          thresholds: { strong: STRONG, weak: WEAK },
          candidates: (d.rows || []).slice(0, 8).map((r) => ({
            skill: nameOf(r),
            score: r.total ?? null,
            declared: r.declared ?? null,
          })),
          marketplace: { offered: !!d.market, sell: !!d.sell },
          problems: d.problems || [],
        },
        null,
        2
      )
    );
    return;
  }

  out();
  out(bold("  Request"));
  out(`    ${request}`);
  out();
  out(bold("  Mode") + dim("  (the stance every skill reads; skills/modes/modes.json)"));
  out(`    ${cyan(res.mode.label)}${res.mode.builtin ? dim("  built-in fallback") : ""}  ${dim(res.mode.summary || "")}`);
  out(`    ${dim("source")}  ${modeSourceText(res)}`);
  const boosts = Object.entries(res.mode.routing?.boost || {});
  out(
    `    ${dim("effect")}  ${
      boosts.length
        ? `${boosts.map(([k, v]) => `${k} ${v > 0 ? `+${v}` : v}`).join(", ")}; marketplace tier ${res.mode.routing.marketplace}`
        : `no skill weighting; marketplace tier ${res.mode.routing?.marketplace || "on"}`
    }`,
  );
  // A positive boost that was withheld is the mode's most important non-event:
  // it is the difference between a stance that reorders relevant skills and one
  // that invents a relevant skill. The withheld rows score at or below zero, so
  // they never reach the candidate list below and this is the only place the
  // reader can be told. Printed here, in the mode block, where the claim belongs.
  const withheld = d.rows.filter((r) => r.modeWithheld > 0);
  if (withheld.length) {
    out(
      `    ${dim("withheld")}  ${withheld
        .map((r) => `${r.skill.name} +${r.modeWithheld}`)
        .join(", ")}  ${dim(`(${res.mode.label} favours these, but nothing in the request matched them, so the boost did not apply)`)}`,
    );
  }
  for (const w of res.warnings || []) out(yellow(`    !  ${w}`));
  if (d.problems.length) {
    out();
    out(bold(yellow("  Skills on disk the router could not read")));
    for (const p of d.problems) out(yellow(`    !  ${p}`));
    out(dim("    Until these are fixed the router may not know about an installed skill,"));
    out(dim("    so the marketplace tier is held shut."));
  }
  out();
  out(bold("  Capabilities needed") + dim(`  (from capabilities.json, ${Object.keys(CAPS).length} in the vocabulary)`));
  if (d.needs.size === 0) out(dim("    none detected"));
  for (const [cap, phrases] of d.needs) out(`    ${cyan(cap)}  ${dim(`matched "${phrases[0]}"`)}`);
  out();
  out(bold("  Candidates") + dim(`  (${catalog.length} skills read off disk just now)`));
  const top = d.rows.filter((r) => r.total > 0).slice(0, 5);
  if (!top.length) out(dim("    nothing scored above zero"));
  for (const r of top) {
    out(`    ${String(r.total).padStart(5)}  ${cyan(r.skill.name.padEnd(20))} ${dim(r.skill.provenance)}`);
    for (const w of r.why) out(dim(`             ${w}`));
  }
  out();
  out(bold("  Marketplace tier"));
  for (const r of d.market.reasons) out(`    ${r.ok ? green("yes") : yellow("no ")}  ${dim(r.text)}`);
  out(`    ${d.market.eligible ? green("ELIGIBLE") : yellow("NOT ELIGIBLE")}${d.market.eligible ? dim(`  query: ${d.market.query}`) : dim("  say nothing about the marketplace")}`);
  out();
  if (d.sell.eligible) {
    out(bold("  Sell tier"));
    for (const r of d.sell.reasons) out(`    ${r.ok ? green("yes") : yellow("no ")}  ${dim(r.text)}`);
    out(`    ${green("ELIGIBLE")} ${dim("offer evaluate_products once, take no for an answer")}`);
    out();
  }
  out(bold("  Decision"));
  out(`    tier    ${d.tier}`);
  out(`    action  ${d.action}`);
  if (cf) {
    out();
    if (!cf.changed) {
      out(dim(`    the mode did not change this pick: ${res.mode.label} and no mode both land on ${d.tier}`));
    } else {
      out(bold(yellow("    the mode changed this")));
      if (!cf.samePick) {
        out(`      without a mode:  ${cf.plain.best.skill ? `/${cf.plain.best.skill.name} (${cf.plain.best.total})` : "nothing scored"}`);
        out(`      in ${res.mode.label}:${" ".repeat(Math.max(1, 14 - res.mode.label.length))}${d.best.skill ? `/${d.best.skill.name} (${d.best.total})` : "nothing scored"}`);
      }
      if (!cf.sameTier) out(`      tier:            ${cf.plain.tier}  ->  ${d.tier}`);
      if (!cf.sameMarket) {
        out(`      marketplace:     ${cf.plain.market.eligible ? "eligible" : "not eligible"}  ->  ${d.market.eligible ? "eligible" : "not eligible"}`);
      }
    }
  }
  out();
}

function modeSourceText(res) {
  switch (res.source) {
    case "override":
      return "--mode on this invocation";
    case "project":
      return `set for this project  ${dim(res.statePath || "")}`;
    case "repo-pin":
      return `pinned by the repo  ${dim(res.pinPath || "")}`;
    case "default":
      return `nothing set here, so the configured default "${res.safeDefaultName}"`;
    case "builtin-fallback":
      return yellow("nothing usable, so the built-in fallback stance");
    case "unavailable":
      return dim("no modes layer; routing on capabilities alone");
    default:
      return res.source;
  }
}

function cmdCatalog(roots, { check, bundledOnly }) {
  const scanRoots = bundledOnly ? [path.resolve(ROUTER_DIR, "..")] : roots;
  const catalog = buildCatalog(scanRoots);
  // A catalog written from a partial read is a manifest that says a skill does
  // not exist. Refuse to write one, and refuse to certify one.
  if (catalog.problems.length) {
    for (const p of catalog.problems) out(`  UNUSABLE  ${p}`);
    out(`  The catalog was neither written nor checked, because it would have been incomplete.`);
    process.exitCode = 2;
    return;
  }
  const doc = {
    _comment:
      "GENERATED by route.mjs catalog. Do not hand-edit. Regenerate: node skills/router/scripts/route.mjs catalog. " +
      "The router does not read this file to route; it rescans disk every time, so routing cannot drift from reality. " +
      "This file exists so the manifest is reviewable in a diff and checkable in CI.",
    generator: "toolbay-stack route.mjs",
    skills: catalog.map((s) => ({
      name: s.name,
      description: s.description,
      provides: s.provides,
      provenance: s.provenance,
      triggers: s.triggers,
      platforms: s.platforms,
      cost: s.cost,
    })),
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;

  if (check) {
    const current = fs.existsSync(CATALOG_FILE) ? fs.readFileSync(CATALOG_FILE, "utf8") : "";
    if (current === text) {
      out(`  ok  catalog.json matches the ${catalog.length} skills on disk`);
      return;
    }
    out(`  STALE  catalog.json does not match the skills on disk. Run: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} catalog`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(CATALOG_FILE, text, "utf8");
  out(`  wrote ${path.relative(process.cwd(), CATALOG_FILE)}  (${catalog.length} skills)`);
}

function cmdList(roots) {
  const catalog = buildCatalog(roots);
  out();
  out(bold(`  ${catalog.length} skills visible to the router`));
  out();
  for (const p of catalog.problems) out(yellow(`  !  ${p}`));
  if (catalog.problems.length) {
    out();
    process.exitCode = 2;
  }
  const w = Math.max(...catalog.map((s) => s.name.length));
  for (const s of catalog) {
    out(`  ${cyan(s.name.padEnd(w))}  ${dim(s.provenance.padEnd(9))} ${s.provides.join(", ") || dim("no capabilities matched")}`);
  }
  out();
  out(dim("  declared = the skill states its own capabilities. derived = inferred from its"));
  out(dim("  description through capabilities.json, which is how upstream and third-party"));
  out(dim("  skills stay routable without editing them."));
  out();
}

// ------------------------------------------------------------------ selftest
//
// The router had no selftest at all, which is how it kept two fail-open paths:
// a skills directory or a SKILL.md it could not read was dropped in silence, so
// an installed skill became invisible and the marketplace tier then reported
// "no local skill covers this" and offered to sell one. Everything below runs
// the real executable against deliberately broken inputs.

function runSelf(args, { cwd, script } = {}) {
  const res = spawnSync(process.execPath, [script ?? fileURLToPath(import.meta.url), ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** A standalone copy of the router, so its capabilities.json can be broken. */
function plantRouter(dir, vocabText) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const script = path.join(dir, "scripts", "route.mjs");
  fs.copyFileSync(fileURLToPath(import.meta.url), script);
  fs.writeFileSync(path.join(dir, "capabilities.json"), vocabText, "utf8");
  return script;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-route-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const goodVocab = fs.readFileSync(VOCAB_FILE, "utf8");
  const skills = (root, spec) => {
    for (const [name, body] of Object.entries(spec)) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "SKILL.md"), body, "utf8");
    }
    return root;
  };

  // ---- it works at all
  {
    const r = runSelf(["explain", "ship this branch and open a PR"]);
    check("explain routes a request the bundled skills cover", 0, r.status, r.stderr.slice(0, 200));
    check("...and picks a local skill rather than the marketplace", true, /1\. local skill/.test(r.stdout), r.stdout.slice(-400));
  }

  // ---- the --json surface, which other skills route THROUGH
  //
  // These exist because `d.best` is the top-scoring row whether or not the
  // router actually chose anything. Emitting it as `pick` shipped a fail-open
  // bug through a machine-readable API: `explain "translate this document into
  // Farsi"` lands on tier 3 ("no skill fits, answer directly") while its top
  // row is document-generate at 0.5, matched on the word "document". The prose
  // rendering said no skill fits. The JSON said run document-generate.
  {
    const parse = (args) => {
      const r = runSelf(args);
      try {
        return { ok: r.status === 0, json: JSON.parse(r.stdout || "{}") };
      } catch {
        return { ok: false, json: null };
      }
    };

    const covered = parse(["explain", "the tests are failing and I dont know why", "--json"]);
    check("explain --json emits parseable JSON", true, covered.ok);
    check("...and picks a skill when one genuinely covers the request", "investigate", covered.json?.pick?.skill ?? null);
    check("...reporting the pick as a NAME, not the whole skill record", "string", typeof (covered.json?.pick?.skill ?? null));
    check("...with a real score rather than null", true, typeof covered.json?.pick?.score === "number" && covered.json.pick.score > 0);
    check("...labelled strong so a caller need not re-derive the threshold", "strong", covered.json?.pick?.strength ?? null);
    check("...and publishes the thresholds it used", true, covered.json?.thresholds?.strong === STRONG);

    const uncovered = parse(["explain", "translate this document into Farsi", "--json"]);
    check("a request no skill covers lands on answer-directly", true, /^3\./.test(uncovered.json?.tier ?? ""));
    // Asserted as an explicit `=== null`, not via `?? "MISSING"`: `??` treats
    // null as nullish, so the fallback fires on exactly the value under test
    // and the assertion reports a failure whether the field is null or absent.
    // The first version of this line did that and failed against correct code.
    check("...and pick is NULL, never the top-scoring near-miss", true, uncovered.json?.pick === null);
    check("...with the key present rather than omitted", true, uncovered.json != null && "pick" in uncovered.json);
    check("...while the near-miss is still visible for auditing", true, typeof uncovered.json?.topCandidate?.skill === "string");
    check("...and the near-miss is NOT presented as a decision", true, uncovered.json?.topCandidate?.skill !== (uncovered.json?.pick?.skill ?? null));
    check(
      "the JSON tier and the pick can never disagree",
      true,
      (() => {
        for (const req of ["ship this branch", "translate into Farsi", "why is this 500ing", "make me a sandwich"]) {
          const j = parse(["explain", req, "--json"]).json;
          if (!j) return false;
          const chose = /^[12]\./.test(j.tier || "");
          if (chose !== (j.pick !== null)) return false;
        }
        return true;
      })()
    );
  }
  check("explain with no request is refused", 1, runSelf(["explain"]).status);
  check("an unknown command is refused", 1, runSelf(["nonsense"]).status);
  // A stray argument on a subcommand that takes none used to be dropped in
  // silence, exit 0, while the installer next door correctly exits 1 on the
  // same class of mistake.
  check("a stray argument on a no-argument subcommand is refused", 1, runSelf(["catalog", "nonsense"]).status);
  check("...and says nothing was run", true, /Nothing was run/.test(runSelf(["catalog", "nonsense"]).stdout), runSelf(["catalog", "nonsense"]).stdout.slice(0, 200));
  check("...while the subcommand itself still works with no argument", 0, runSelf(["catalog", "--bundled", "--check"]).status);
  check("catalog --check is clean against the bundled skills", 0, runSelf(["catalog", "--bundled", "--check"]).status);

  // ---- a corrupt vocabulary stops the router instead of routing on nothing
  {
    const script = plantRouter(path.join(tmp, "broken-vocab"), "{ not json at all");
    const r = runSelf(["explain", "build me a thing"], { script });
    check("a corrupt capabilities.json is UNUSABLE, not a silent no-match", 2, r.status, r.stdout.slice(0, 200));
    check("...and says which file", true, /capabilities\.json/.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    const script = plantRouter(path.join(tmp, "empty-vocab"), JSON.stringify({ capabilities: {} }));
    const r = runSelf(["list"], { script });
    check("a capabilities.json with no gates is UNUSABLE", 2, r.status, r.stderr.slice(0, 200));
  }
  {
    const dir = path.join(tmp, "no-vocab");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const script = path.join(dir, "scripts", "route.mjs");
    fs.copyFileSync(fileURLToPath(import.meta.url), script);
    check("a missing capabilities.json is UNUSABLE", 2, runSelf(["list"], { script }).status);
  }

  // ---- a skill on disk the router cannot read
  {
    const home = path.join(tmp, "unreadable-fm");
    const root = skills(path.join(home, ".claude", "skills"), {
      // No frontmatter delimiters at all: readFrontmatter returns null, and
      // this skill used to vanish from the catalog without a word.
      "secret-scanner": "# secret-scanner\n\nScans for leaked credentials.\n",
      good: "---\nname: good\ndescription: a readable skill\n---\nbody\n",
    });
    const r = runSelf(["list", "--root", root], { cwd: home });
    check("a SKILL.md with no readable frontmatter is reported", 2, r.status, r.stdout.slice(0, 300));
    check("...and names the skill it had to drop", true, /secret-scanner/.test(r.stdout), r.stdout.slice(0, 400));

    const e = runSelf(["explain", "I need a tool that scans a repo for leaked API keys and credentials", "--root", root], { cwd: home });
    check("...and the marketplace tier is held shut while the catalog is incomplete", true, /NOT ELIGIBLE/.test(e.stdout), e.stdout.slice(-600));
    check("...for the stated reason", true, /catalog is incomplete/.test(e.stdout), e.stdout.slice(-600));

    const c = runSelf(["catalog", "--root", root], { cwd: home });
    check("catalog refuses to write a manifest it knows is incomplete", 2, c.status, c.stdout.slice(0, 300));
  }
  {
    const home = path.join(tmp, "unreadable-root");
    fs.mkdirSync(home, { recursive: true });
    // A path that is a file, not a directory: readdirSync throws ENOTDIR on
    // every platform, which is the portable "this root cannot be read".
    const notADir = path.join(home, "skills-file");
    fs.writeFileSync(notADir, "not a directory\n", "utf8");
    const r = runSelf(["list", "--root", notADir], { cwd: home });
    check("a skills root that cannot be read is reported, not skipped", 2, r.status, r.stdout.slice(0, 300));
    check("...and says the skills in it are invisible", true, /invisible to the router/.test(r.stdout), r.stdout.slice(0, 400));
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  route selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("\n  A skill the router cannot read is a skill the router would otherwise report");
  out("  as absent, one line before offering to sell you one. Every case above ends in");
  out("  a refusal instead.\n");
}

function help() {
  out(`
${bold("route")} ${dim("(Toolbay Stack skill router)")}

  ${cyan('route.mjs explain "<request>"')}   show what the router would pick and why
  ${cyan("route.mjs list")}                   every skill on disk and its capabilities
  ${cyan("route.mjs catalog")}                regenerate catalog.json from the bundled skills
  ${cyan("route.mjs catalog --check")}        fail if catalog.json is stale (CI)
  ${cyan("route.mjs selftest")}               prove it against deliberately broken input

${bold("Options")}
  --mode <name>   explain only: route as if this mode were active
  --root <dir>    add a skills directory to scan (repeatable)
  --bundled       catalog only: scan only the skills shipped with this package

The routing chain:
  1. a local skill matches on capability          invoke it
  2. a local skill matches weakly                 invoke it, say it is a guess
  3. nothing matches, no capability gap           answer directly
  4. nothing matches, real capability gap         offer find_tools, then post_request

Tier 4 is gated. ${bold("explain")} prints every gate condition, so an offer that should
not have fired can be traced to the line that let it through.

Routing happens inside the active mode. A mode adds weight to skills and can shut
the marketplace tier off entirely, and ${bold("explain")} prints what the pick would have
been without it. ${cyan("tb-mode show")} for the stance itself.
`);
}

// --------------------------------------------------------------------- entry

/**
 * The router is also a library.
 *
 * `suggest` has to name skills, and the one thing it must never do is name a
 * skill that is not installed, or miss one that is. So it does not keep its own
 * table of skills: it imports these four functions and asks the same question
 * the router asks, against the same catalog read off the same disk, inside the
 * same mode. One routing implementation, two callers.
 *
 * That is only safe if importing this file does nothing. Everything below the
 * export runs only when this file is the program, so `import` never parses
 * argv, never prints help, and never sets an exit code on its importer.
 */
export { buildCatalog, defaultRoots, decide, activeMode, detectCapabilities, NO_MODE, STRONG, WEAK };

if (!INVOKED_DIRECTLY) {
  // Imported. Do nothing else.
} else {

const argv = process.argv.slice(2);
const extraRoots = [];
let modeOverride = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--root" && argv[i + 1]) {
    extraRoots.push(argv[i + 1]);
    argv.splice(i, 2);
    i -= 1;
  } else if (argv[i] === "--mode" && argv[i + 1]) {
    modeOverride = argv[i + 1];
    argv.splice(i, 2);
    i -= 1;
  }
}
const check = argv.includes("--check");
const bundledOnly = argv.includes("--bundled");
const asJson = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("--"));
const roots = defaultRoots(extraRoots);
const [cmd, ...rest] = positional;

// A subcommand that takes no arguments must REFUSE the ones it was given rather
// than ignore them. `route.mjs catalog nonsense` used to exit 0 having quietly
// dropped the word — the same fail-open the installer gets right by exiting 1 on
// an unknown command. Silently ignoring an argument is how a typo in a script
// becomes a command that reports success while doing something else.
const NO_ARGS = new Set(["catalog", "list", "selftest", "help"]);
if (NO_ARGS.has(cmd) && rest.length) {
  out(`${cmd} takes no arguments, but got: ${rest.join(" ")}. Try: route.mjs help`);
  out("Nothing was run. An argument this command does not understand is not an argument it may ignore.");
  process.exitCode = 1;
} else if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") help();
else if (cmd === "explain" || cmd === "why") cmdExplain(rest.join(" "), roots, { modeOverride, asJson });
else if (cmd === "catalog") cmdCatalog(roots, { check, bundledOnly });
else if (cmd === "list") cmdList(roots);
else if (cmd === "selftest") selftest();
else {
  out(`Unknown command ${cmd}. Try: route.mjs help`);
  process.exitCode = 1;
}

}
