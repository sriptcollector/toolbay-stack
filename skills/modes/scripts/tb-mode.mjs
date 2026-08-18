#!/usr/bin/env node
/**
 * tb-mode.mjs: the Toolbay Stack modes layer.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no modes layer and this file is not derived from its code; the
 * skill-per-directory layout it sits in is Garry's design. See LICENSE, NOTICE.
 *
 * WHAT A MODE IS
 *
 * Not a skill. A stance. Every skill in the stack reads the active mode and
 * changes what it does: the same /review is four different reviews, and the
 * router picks a different skill for the same sentence.
 *
 * THREE DESIGN RULES, ALL OF THEM LOAD-BEARING
 *
 *   1. THE CONFIG IS THE PRODUCT. modes.json is one hand-edited file and the
 *      code knows none of the mode names in it. Adding a mode is adding a key.
 *      Nothing here special-cases "ship" or "lock".
 *
 *   2. PER PROJECT, NOT PER MACHINE. A stance belongs to a piece of work. State
 *      is keyed to the project root, so LOCK on a client repo does not follow
 *      you into a prototype in the next terminal tab. A repo can additionally
 *      pin a mode by committing a `.toolbay-mode` file, and when the pin and the
 *      local setting disagree the TIGHTER of the two wins.
 *
 *   3. EVERY FAILURE RESOLVES DOWN, NEVER UP. No mode set, an unknown name, a
 *      corrupt modes.json, an empty modes.json, a missing modes.json, a config
 *      whose own default points at the loosest mode: all of them land on a
 *      built-in CRAFT stance, print why, and exit zero. A configuration layer
 *      that crashes gets deleted; one that silently resolves to the most
 *      permissive stance is worse than not existing, because it fails in the
 *      direction of doing damage.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);

/** The floor. A mode may only become the IMPLICIT default if it is at least this restrained. */
export const MIN_SAFE_RESTRAINT = 2;

const PIN_FILE = ".toolbay-mode";
const MARKETPLACE_POLICIES = new Set(["on", "quiet", "off"]);

/**
 * The two suggestion kinds a stance may not silence.
 *
 * A mode is allowed to say tests are not today's priority. It is not allowed to
 * stop the stack from mentioning a credential about to be committed, or a
 * conflict you are standing in. Those are conditions, not preferences, and a
 * configuration file should not be able to switch them off by accident or on
 * purpose. Negative weights against these kinds are read, reported, and dropped
 * here, so every consumer of the mode gets an already-safe number.
 */
export const UNSUPPRESSABLE_KINDS = Object.freeze(["blocked", "safety"]);
const UNSUPPRESSABLE = new Set(UNSUPPRESSABLE_KINDS);

/**
 * The stance used when modes.json cannot be trusted at all. Defined here, in
 * code, because a fallback that lives in the file it is a fallback for is not a
 * fallback. Deliberately restrained: this is what an unconfigured or broken
 * install behaves like, and that behaviour has to be safe by default.
 */
const BUILTIN = Object.freeze({
  name: "craft",
  label: "CRAFT",
  restraint: 2,
  builtin: true,
  summary: "Finish it properly. Edge cases, tests, no shortcuts. (built-in fallback stance)",
  feel: "The thing is actually done. Nobody has to come back to it.",
  directives: [
    "Complete the work: edge cases, empty states, error paths.",
    "No TODOs left behind, and no silent gaps. State what you did not cover.",
    "Verify before reporting done, and say what you verified.",
  ],
  skills: {
    review: ["Flag everything. Separate critical from informational, suppress neither."],
    qa: ["Happy path plus edges, both viewports, evidence for every claimed pass."],
    "*": ["Do it completely, or state exactly which part you did not do."],
  },
  routing: { boost: {}, marketplace: "quiet", note: "built-in fallback stance: no routing preferences, marketplace tier quiet" },
  // No preferences at all: a broken config must not reorder what gets suggested,
  // in either direction. Absent is neutral; it is never permissive.
  suggest: { max: null, prefer: {}, note: "built-in fallback stance: suggestions are not reweighted" },
  guard: { careful: true, freeze: false },
});

// ------------------------------------------------------------------- plumbing

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

export function configPath() {
  return process.env.TOOLBAY_STACK_MODES_FILE || path.join(SKILL_DIR, "modes.json");
}

function stateDir() {
  // Same root the guard uses, so one env var relocates all Toolbay Stack state.
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

/**
 * The project this stance belongs to. Walks up for a repo or package marker and
 * falls back to the working directory, which is always a defensible answer:
 * worst case the stance is scoped tighter than the user expected, never wider.
 */
export function projectRoot(start = process.cwd()) {
  const markers = [".git", ".claude", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json"];
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(start));
  } catch {
    dir = path.resolve(start);
  }
  let cur = dir;
  for (;;) {
    for (const m of markers) {
      if (fs.existsSync(path.join(cur, m))) return cur;
    }
    const up = path.dirname(cur);
    if (up === cur) return dir;
    cur = up;
  }
}

export function statePathFor(root) {
  // Case-folded on Windows so C:\Repo and c:\repo are one project, not two.
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
  const slug = (path.basename(root) || "root").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return path.join(stateDir(), "modes", `${slug}-${hash}.json`);
}

// -------------------------------------------------------------- config loading

function normalizeMode(name, raw, warnings) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`mode "${name}" in modes.json is not an object, so it was dropped`);
    return null;
  }
  const asLines = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];

  let restraint = Number(raw.restraint);
  if (!Number.isFinite(restraint)) {
    // Unscored modes are treated as the loosest. That keeps them selectable by
    // hand while making them ineligible to become the implicit default.
    warnings.push(`mode "${name}" has no numeric "restraint", so it is treated as 0 (loosest) and cannot be the implicit default`);
    restraint = 0;
  }
  restraint = Math.max(0, Math.min(9, restraint));

  const routingRaw = raw.routing && typeof raw.routing === "object" && !Array.isArray(raw.routing) ? raw.routing : {};
  const boost = {};
  if (routingRaw.boost && typeof routingRaw.boost === "object" && !Array.isArray(routingRaw.boost)) {
    for (const [k, v] of Object.entries(routingRaw.boost)) {
      const n = Number(v);
      if (Number.isFinite(n)) boost[k] = Math.max(-50, Math.min(50, n));
      else warnings.push(`mode "${name}" routing.boost["${k}"] is not a number, so it was ignored`);
    }
  }
  let marketplace = typeof routingRaw.marketplace === "string" ? routingRaw.marketplace.toLowerCase() : "quiet";
  if (!MARKETPLACE_POLICIES.has(marketplace)) {
    warnings.push(`mode "${name}" has routing.marketplace "${routingRaw.marketplace}", which is not on/quiet/off; using "quiet"`);
    marketplace = "quiet";
  }

  // What this mode does to the suggestion engine's own ranking. Every field is
  // optional and every invalid field degrades to "no preference", never to a
  // stronger one.
  const suggestRaw = raw.suggest && typeof raw.suggest === "object" && !Array.isArray(raw.suggest) ? raw.suggest : {};
  const prefer = {};
  if (suggestRaw.prefer && typeof suggestRaw.prefer === "object" && !Array.isArray(suggestRaw.prefer)) {
    for (const [k, v] of Object.entries(suggestRaw.prefer)) {
      const kind = String(k).toLowerCase();
      const n = Number(v);
      if (!Number.isFinite(n)) {
        warnings.push(`mode "${name}" suggest.prefer["${k}"] is not a number, so it was ignored`);
        continue;
      }
      if (UNSUPPRESSABLE.has(kind) && n < 0) {
        warnings.push(
          `mode "${name}" tries to weight "${kind}" suggestions down by ${n}; ` +
            `"${UNSUPPRESSABLE_KINDS.join('" and "')}" cannot be suppressed by any mode, so it was dropped`,
        );
        continue;
      }
      prefer[kind] = Math.max(-100, Math.min(100, n));
    }
  }
  let max = null;
  if (suggestRaw.max !== undefined) {
    const n = Number(suggestRaw.max);
    if (!Number.isFinite(n) || n < 1) warnings.push(`mode "${name}" suggest.max is not a number >= 1, so no cap is applied`);
    else max = Math.min(20, Math.floor(n));
  }
  const suggest = { max, prefer, note: typeof suggestRaw.note === "string" ? suggestRaw.note : "" };

  const skills = {};
  if (raw.skills && typeof raw.skills === "object" && !Array.isArray(raw.skills)) {
    for (const [k, v] of Object.entries(raw.skills)) {
      const lines = asLines(v);
      if (lines.length) skills[k] = lines;
    }
  }

  return {
    name,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : name.toUpperCase(),
    restraint,
    builtin: false,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    feel: typeof raw.feel === "string" ? raw.feel.trim() : "",
    directives: asLines(raw.directives),
    skills,
    suggest,
    routing: { boost, marketplace, note: typeof routingRaw.note === "string" ? routingRaw.note : "" },
    guard: {
      careful: raw.guard && typeof raw.guard === "object" ? raw.guard.careful !== false : true,
      freeze: Boolean(raw.guard && typeof raw.guard === "object" && raw.guard.freeze),
    },
  };
}

/**
 * Read modes.json. Never throws. `ok:false` means "unusable", and every route to
 * unusable is reported with the reason, because a config that quietly does
 * nothing is indistinguishable from a config that is working.
 */
export function loadConfig(file = configPath()) {
  const warnings = [];
  const fail = (reason) => ({ ok: false, reason, modes: new Map(), safeDefaultName: null, warnings, path: file });

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return fail(err.code === "ENOENT" ? `modes.json not found at ${file}` : `modes.json at ${file} could not be read (${err.code || err.message})`);
  }
  if (!text.trim()) return fail(`modes.json at ${file} is empty`);

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return fail(`modes.json at ${file} is not valid JSON (${err.message})`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail(`modes.json at ${file} is not a JSON object`);
  if (!doc.modes || typeof doc.modes !== "object" || Array.isArray(doc.modes)) {
    return fail(`modes.json at ${file} has no "modes" object`);
  }

  const modes = new Map();
  for (const [name, raw] of Object.entries(doc.modes)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      warnings.push(`mode name "${name}" is not a plain identifier, so it was dropped`);
      continue;
    }
    const m = normalizeMode(name.toLowerCase(), raw, warnings);
    if (m) modes.set(m.name, m);
  }
  if (modes.size === 0) return fail(`modes.json at ${file} defines no usable modes`);

  return {
    ok: true,
    reason: "",
    modes,
    safeDefaultName: typeof doc.safeDefault === "string" ? doc.safeDefault.toLowerCase() : null,
    warnings,
    path: file,
  };
}

// ----------------------------------------------------------------- state files

function readPin(root, warnings) {
  const file = path.join(root, PIN_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`${PIN_FILE} at ${file} could not be read (${err.code || err.message}), so it was ignored`);
    return { file, value: null };
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) {
    warnings.push(`${PIN_FILE} at ${file} names no mode, so it was ignored`);
    return { file, value: null };
  }
  return { file, value: line.split(/\s+/)[0].toLowerCase() };
}

function readState(file, warnings) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`mode state at ${file} could not be read (${err.code || err.message}), so it was ignored`);
    return { file, value: null, setAt: null };
  }
  if (!text.trim()) {
    warnings.push(`mode state at ${file} is empty, so it was ignored`);
    return { file, value: null, setAt: null };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    warnings.push(`mode state at ${file} is not valid JSON (${err.message}), so it was ignored`);
    return { file, value: null, setAt: null };
  }
  if (!doc || typeof doc !== "object" || typeof doc.mode !== "string" || !doc.mode.trim()) {
    warnings.push(`mode state at ${file} has no "mode" string, so it was ignored`);
    return { file, value: null, setAt: null };
  }
  return { file, value: doc.mode.trim().toLowerCase(), setAt: typeof doc.setAt === "string" ? doc.setAt : null };
}

// ------------------------------------------------------------------- resolving

/**
 * Resolve the stance for a directory. Never throws, always returns a mode.
 *
 * @param {{cwd?:string, override?:string|null}} opts
 */
export function resolveMode({ cwd = process.cwd(), override = null } = {}) {
  const warnings = [];
  const sources = [];
  const root = projectRoot(cwd);
  const statePath = statePathFor(root);
  const cfg = loadConfig();
  warnings.push(...cfg.warnings);

  const base = {
    projectRoot: root,
    configPath: cfg.path,
    statePath,
    pinPath: path.join(root, PIN_FILE),
    available: cfg.ok ? [...cfg.modes.keys()] : [BUILTIN.name],
    sources,
    warnings,
  };

  // Route 1: the config itself is unusable. Nothing else can be trusted either,
  // because "lock" resolving against a broken file would be a name with no
  // meaning behind it.
  if (!cfg.ok) {
    warnings.push(cfg.reason);
    if (override) warnings.push(`--mode "${override}" ignored: the modes config is unusable`);
    return { ...base, mode: BUILTIN, source: "builtin-fallback", degraded: true, safeDefaultName: BUILTIN.name };
  }

  // The implicit default, and the floor that protects it.
  let fallback = null;
  if (cfg.safeDefaultName) {
    const cand = cfg.modes.get(cfg.safeDefaultName);
    if (!cand) {
      warnings.push(`safeDefault "${cfg.safeDefaultName}" is not a defined mode`);
    } else if (cand.restraint < MIN_SAFE_RESTRAINT) {
      warnings.push(
        `safeDefault "${cand.name}" has restraint ${cand.restraint}, below the floor of ${MIN_SAFE_RESTRAINT}; ` +
          `refusing to make a permissive stance the implicit default`,
      );
    } else {
      fallback = cand;
    }
  } else {
    warnings.push(`modes.json names no "safeDefault"`);
  }
  if (!fallback) fallback = BUILTIN;

  // Route 2: an explicit one-shot override (--mode). Still validated.
  if (override) {
    const wanted = String(override).trim().toLowerCase();
    const m = cfg.modes.get(wanted);
    if (m) {
      sources.push({ kind: "override", value: wanted, accepted: true });
      return { ...base, mode: m, source: "override", degraded: false, safeDefaultName: fallback.name };
    }
    warnings.push(`--mode "${override}" is not a defined mode (have: ${[...cfg.modes.keys()].join(", ")}); using the default`);
    sources.push({ kind: "override", value: wanted, accepted: false, reason: "unknown mode name" });
  }

  // Route 3: the repo pin and the local setting, each validated independently.
  const candidates = [];
  const pin = readPin(root, warnings);
  if (pin.value) {
    const m = cfg.modes.get(pin.value);
    if (m) {
      candidates.push({ kind: "repo-pin", mode: m, path: pin.file });
      sources.push({ kind: "repo-pin", value: pin.value, path: pin.file, accepted: true });
    } else {
      warnings.push(`${PIN_FILE} names "${pin.value}", which is not a defined mode, so it was ignored`);
      sources.push({ kind: "repo-pin", value: pin.value, path: pin.file, accepted: false, reason: "unknown mode name" });
    }
  }
  const st = readState(statePath, warnings);
  if (st.value) {
    const m = cfg.modes.get(st.value);
    if (m) {
      candidates.push({ kind: "project", mode: m, path: st.file, setAt: st.setAt });
      sources.push({ kind: "project", value: st.value, path: st.file, accepted: true, setAt: st.setAt });
    } else {
      warnings.push(`the mode set for this project is "${st.value}", which is not a defined mode, so it was ignored`);
      sources.push({ kind: "project", value: st.value, path: st.file, accepted: false, reason: "unknown mode name" });
    }
  }

  if (candidates.length === 0) {
    return {
      ...base,
      mode: fallback,
      source: fallback === BUILTIN ? "builtin-fallback" : "default",
      degraded: fallback === BUILTIN,
      safeDefaultName: fallback.name,
    };
  }

  // Disagreement resolves to the TIGHTER stance, and the pin breaks a tie. A
  // repo that committed LOCK cannot be quietly loosened by a local setting.
  candidates.sort((a, b) => b.mode.restraint - a.mode.restraint || (a.kind === "repo-pin" ? -1 : 1));
  const winner = candidates[0];
  if (candidates.length > 1 && candidates[0].mode.name !== candidates[1].mode.name) {
    warnings.push(
      `the repo pin and the local setting disagree (${candidates.map((x) => `${x.kind}=${x.mode.name}`).join(", ")}); ` +
        `the more restrained one wins`,
    );
  }
  return { ...base, mode: winner.mode, source: winner.kind, degraded: false, safeDefaultName: fallback.name };
}

/** The lines a named skill should follow in this stance. */
export function briefFor(mode, skill) {
  const specific = skill ? mode.skills[skill] || mode.skills[String(skill).toLowerCase()] : null;
  const generic = mode.skills["*"] || [];
  return {
    skill: skill || null,
    matched: Boolean(specific),
    lines: specific && specific.length ? specific : generic,
  };
}

// -------------------------------------------------------------------- printing

function printResolution(r, { verbose = true } = {}) {
  const m = r.mode;
  out();
  out(`  ${bold("MODE")}  ${cyan(m.label)}${m.builtin ? dim("  (built-in fallback)") : ""}`);
  if (m.summary) out(`        ${m.summary}`);
  if (m.feel) out(dim(`        ${m.feel}`));
  out();
  out(`  ${dim("source ")} ${sourceLine(r)}`);
  out(`  ${dim("project")} ${r.projectRoot}`);
  out(`  ${dim("config ")} ${r.configPath}`);
  if (!verbose) {
    out();
    return;
  }
  if (m.directives.length) {
    out();
    out(bold("  Stance"));
    for (const d of m.directives) out(`    - ${d}`);
  }
  const boosts = Object.entries(m.routing.boost);
  out();
  out(bold("  Routing"));
  out(`    marketplace tier  ${m.routing.marketplace}`);
  if (boosts.length) {
    out(`    skill weighting   ${boosts.map(([k, v]) => `${k} ${v > 0 ? `+${v}` : v}`).join(", ")}`);
  } else {
    out(dim("    skill weighting   none"));
  }
  if (m.routing.note) out(dim(`    ${m.routing.note}`));
  const sug = m.suggest || { max: null, prefer: {}, note: "" };
  const prefs = Object.entries(sug.prefer || {});
  out();
  out(bold("  Suggestions"));
  out(`    at most          ${sug.max ? `${sug.max} at a time` : dim("no cap from this mode")}`);
  if (prefs.length) out(`    kind weighting   ${prefs.map(([k, v]) => `${k} ${v > 0 ? `+${v}` : v}`).join(", ")}`);
  else out(dim("    kind weighting   none"));
  out(dim(`    never suppressed  ${UNSUPPRESSABLE_KINDS.join(", ")}`));
  if (sug.note) out(dim(`    ${sug.note}`));
  out();
  out(bold("  Guard expectations"));
  out(`    careful ${m.guard.careful ? green("on") : dim("off")}    freeze ${m.guard.freeze ? green("on") : dim("off")}`);
  if (r.warnings.length) {
    out();
    out(bold(yellow("  Warnings")));
    for (const w of r.warnings) out(yellow(`    ! ${w}`));
    if (r.degraded) {
      out(yellow(`    ! resolved DOWN to the built-in ${BUILTIN.label} stance rather than failing or guessing loose`));
    }
  }
  out();
  out(dim(`  available: ${r.available.join(", ")}    change them: ${r.configPath}`));
  out();
}

function sourceLine(r) {
  switch (r.source) {
    case "override":
      return `--mode on this invocation`;
    case "project":
      return `set for this project (${r.statePath})`;
    case "repo-pin":
      return `pinned by the repo (${r.pinPath})`;
    case "default":
      return `nothing set here, so the configured safeDefault "${r.safeDefaultName}"`;
    case "builtin-fallback":
      return yellow(`nothing usable, so the built-in fallback stance`);
    default:
      return r.source;
  }
}

function toJSON(r) {
  return {
    mode: r.mode.name,
    label: r.mode.label,
    restraint: r.mode.restraint,
    builtin: Boolean(r.mode.builtin),
    summary: r.mode.summary,
    feel: r.mode.feel,
    directives: r.mode.directives,
    skills: r.mode.skills,
    suggest: r.mode.suggest || { max: null, prefer: {}, note: "" },
    unsuppressableKinds: UNSUPPRESSABLE_KINDS,
    routing: r.mode.routing,
    guard: r.mode.guard,
    source: r.source,
    degraded: r.degraded,
    safeDefault: r.safeDefaultName,
    available: r.available,
    projectRoot: r.projectRoot,
    configPath: r.configPath,
    statePath: r.statePath,
    pinPath: r.pinPath,
    sources: r.sources,
    warnings: r.warnings,
  };
}

// -------------------------------------------------------------------- commands

function cmdShow(flags) {
  const r = resolveMode({ cwd: process.cwd(), override: flags.mode });
  if (flags.json) out(JSON.stringify(toJSON(r), null, 2));
  else printResolution(r, { verbose: !flags.short });
  // `show` is the call every skill makes at the top of its run. It exits 0 even
  // when degraded, because a skill must never be blocked by the stance layer.
  // --strict is for CI, where a degraded config IS the failure.
  if (flags.strict && (r.degraded || r.warnings.length)) process.exitCode = 3;
}

function cmdBrief(flags, args) {
  const skill = args[0] || flags.skill || null;
  const r = resolveMode({ cwd: process.cwd(), override: flags.mode });
  const b = briefFor(r.mode, skill);
  if (flags.json) {
    out(JSON.stringify({ ...toJSON(r), brief: b }, null, 2));
    return;
  }
  out();
  out(`  ${bold("MODE")} ${cyan(r.mode.label)}${r.mode.builtin ? dim(" (built-in fallback)") : ""}  ${dim(r.mode.summary)}`);
  if (r.mode.directives.length) {
    out();
    for (const d of r.mode.directives) out(`    - ${d}`);
  }
  if (skill) {
    out();
    out(`  ${bold(`In this mode, /${skill}`)}${b.matched ? "" : dim("  (no rule for this skill; the mode's default applies)")}`);
    for (const l of b.lines) out(`    - ${l}`);
  }
  if (r.warnings.length) {
    out();
    for (const w of r.warnings) out(yellow(`    ! ${w}`));
  }
  out();
}

function cmdSet(args, flags) {
  const wanted = String(args[0] || "").trim().toLowerCase();
  const cfg = loadConfig();
  if (!cfg.ok) {
    out(yellow(`  Cannot set a mode: ${cfg.reason}`));
    out(dim(`  Until that file is fixed, everything runs on the built-in ${BUILTIN.label} stance.`));
    process.exitCode = 3;
    return;
  }
  if (!wanted) {
    out(`  Usage: tb-mode set <${[...cfg.modes.keys()].join("|")}>`);
    process.exitCode = 2;
    return;
  }
  if (!cfg.modes.has(wanted)) {
    out(yellow(`  "${wanted}" is not a mode in ${cfg.path}`));
    out(`  Defined: ${[...cfg.modes.keys()].join(", ")}`);
    out(dim(`  Nothing was changed. Add "${wanted}" to that file if you want it.`));
    process.exitCode = 2;
    return;
  }
  const root = projectRoot();
  const file = statePathFor(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ mode: wanted, projectRoot: root, setAt: new Date().toISOString(), by: "tb-mode" }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    out(yellow(`  Could not write ${file} (${err.code || err.message})`));
    process.exitCode = 1;
    return;
  }
  const r = resolveMode();
  out();
  out(`  ${green("set")} ${cyan(cfg.modes.get(wanted).label)} for ${bold(path.basename(root))}  ${dim(root)}`);
  if (r.mode.name !== wanted) {
    out(yellow(`  ...but ${r.mode.label} is what actually applies here: ${sourceLine(r)}`));
  }
  out(dim(`  state: ${file}`));
  out();
}

function cmdClear() {
  const root = projectRoot();
  const file = statePathFor(root);
  let existed = false;
  try {
    existed = fs.existsSync(file);
    if (existed) fs.rmSync(file);
  } catch (err) {
    out(yellow(`  Could not clear ${file} (${err.code || err.message})`));
    process.exitCode = 1;
    return;
  }
  const r = resolveMode();
  out();
  out(`  ${existed ? green("cleared") : dim("nothing set")} for ${bold(path.basename(root))}`);
  out(`  now: ${cyan(r.mode.label)}  ${dim(sourceLine(r))}`);
  out();
}

function cmdList(flags) {
  const cfg = loadConfig();
  const r = resolveMode();
  if (flags.json) {
    out(
      JSON.stringify(
        {
          configPath: cfg.path,
          usable: cfg.ok,
          reason: cfg.reason,
          active: r.mode.name,
          modes: cfg.ok
            ? [...cfg.modes.values()].map((m) => ({ name: m.name, label: m.label, restraint: m.restraint, summary: m.summary, marketplace: m.routing.marketplace }))
            : [{ name: BUILTIN.name, label: BUILTIN.label, restraint: BUILTIN.restraint, summary: BUILTIN.summary, marketplace: BUILTIN.routing.marketplace }],
        },
        null,
        2,
      ),
    );
    return;
  }
  out();
  if (!cfg.ok) {
    out(yellow(`  ${cfg.reason}`));
    out(dim(`  Running on the built-in ${BUILTIN.label} stance until that is fixed.`));
    out();
    return;
  }
  const modes = [...cfg.modes.values()].sort((a, b) => a.restraint - b.restraint);
  const w = Math.max(...modes.map((m) => m.label.length));
  out(bold(`  ${modes.length} modes in ${cfg.path}`));
  out();
  for (const m of modes) {
    const active = m.name === r.mode.name ? green(" <- active") : "";
    out(`  ${cyan(m.label.padEnd(w))}  ${dim(`restraint ${m.restraint}`)}  ${m.summary}${active}`);
  }
  out();
  out(dim("  Loosest first. Edit that file to rename, retire, or add a mode. Nothing in the"));
  out(dim("  code knows these names. Then: tb-mode set <name>"));
  out();
}

// -------------------------------------------------------------------- coverage
//
// "A mode changes every skill" is a claim that quietly stops being true the
// moment someone adds a skill and forgets the Mode block. So it is counted off
// disk on demand rather than written down in a doc and left to rot.

function coverageScan() {
  const skillsDir = path.resolve(SKILL_DIR, "..");
  const reads = [];
  const silent = [];
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: `could not read ${skillsDir}`, skillsDir, reads, silent };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = path.join(skillsDir, e.name, "SKILL.md");
    let body;
    try {
      body = fs.readFileSync(md, "utf8");
    } catch {
      continue;
    }
    (body.includes("tb-mode.mjs") ? reads : silent).push(e.name);
  }
  reads.sort();
  silent.sort();
  return { ok: true, reason: null, skillsDir, reads, silent };
}

function cmdCoverage(flags) {
  const scan = coverageScan();
  const total = scan.reads.length + scan.silent.length;
  if (flags.json) {
    out(JSON.stringify({ ok: scan.ok, reason: scan.reason, total, reading: scan.reads.length, silent: scan.silent.length, reads: scan.reads, doesNotRead: scan.silent }, null, 2));
    return;
  }
  out();
  if (!scan.ok) {
    out(yellow(`  ${scan.reason}`));
    out();
    return;
  }
  out(bold(`  ${scan.reads.length} of ${total} skills read the mode`) + dim("  (counted off disk just now)"));
  out();
  out(`  ${dim("does not read it:")} ${scan.silent.join(", ")}`);
  out();
  out(dim("  Safety hooks never read it on purpose: a stance that could tighten a hook"));
  out(dim("  could also loosen one. router and suggest read it in code, not as prose."));
  out(dim("  The rest are setup, measurement, or deterministic output. To wire one up,"));
  out(dim("  add the Mode block to its SKILL.md and a key under \"skills\" in modes.json."));
  out();
}

// -------------------------------------------------------------------- selftest
//
// The four required failure shapes, plus the ones that turned up while writing
// it. Every case asserts three things: it did not crash, it did not resolve to
// the loosest stance, and it said why.

function runSelf(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mode-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const GOOD = path.join(SKILL_DIR, "modes.json");
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), "{}\n", "utf8");

  const write = (name, body) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, body, "utf8");
    return f;
  };
  const CORRUPT = write("corrupt.json", '{ "modes": { "ship": ');
  const EMPTY_OBJ = write("empty-object.json", "{}\n");
  const EMPTY_MODES = write("empty-modes.json", '{ "version": 1, "safeDefault": "craft", "modes": {} }\n');
  const BLANK = write("blank.json", "   \n");
  const LOOSE_DEFAULT = write(
    "loose-default.json",
    JSON.stringify({
      safeDefault: "wild",
      modes: {
        wild: { label: "WILD", restraint: 0, summary: "loose", routing: { marketplace: "on" } },
        craft: { label: "CRAFT", restraint: 2, summary: "tight" },
      },
    }),
  );
  const MISSING = path.join(tmp, "does-not-exist.json");

  // A fresh state dir per case, so nothing leaks between them.
  let n = 0;
  const freshState = () => {
    const d = path.join(tmp, `state-${(n += 1)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  /**
   * The contract every failure case must satisfy. Split out because "it did not
   * crash" and "it did not silently go loose" are separate claims and a case
   * that passes one and fails the other must show which.
   */
  const failsClosed = (label, { modesFile, stateDirPath, expectMode = "craft", expectDegraded = true }) => {
    const r = runSelf(["show", "--json"], {
      cwd: proj,
      env: { TOOLBAY_STACK_MODES_FILE: modesFile, TOOLBAY_STACK_STATE_DIR: stateDirPath },
    });
    check(`${label}: exits 0 instead of crashing`, 0, r.status, r.stderr.trim().split("\n")[0]);
    check(`${label}: writes nothing to stderr`, "", r.stderr.trim().split("\n")[0]);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch (err) {
      check(`${label}: emits parseable JSON`, true, false, err.message);
      return null;
    }
    check(`${label}: emits parseable JSON`, true, true);
    check(`${label}: resolves to the safe default`, expectMode, j.mode);
    check(`${label}: is NOT the most permissive mode`, false, j.mode === "wild" || j.restraint < MIN_SAFE_RESTRAINT, `restraint ${j.restraint}`);
    check(`${label}: does not silently enable the marketplace tier`, false, j.routing.marketplace === "on");
    check(`${label}: says why`, true, j.warnings.length > 0, (j.warnings || [])[0] || "(no warning)");
    if (expectDegraded !== null) check(`${label}: reports degraded=${expectDegraded}`, expectDegraded, j.degraded);
    return j;
  };

  // ---- REQUIRED CASE 1: no mode set anywhere.
  {
    const sd = freshState();
    const r = runSelf(["show", "--json"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd } });
    check("no mode set: exits 0", 0, r.status, r.stderr.trim().split("\n")[0]);
    const j = JSON.parse(r.stdout || "{}");
    check("no mode set: resolves to the configured safeDefault", "craft", j.mode);
    check("no mode set: source says so plainly", "default", j.source);
    check("no mode set: not degraded (a working config with nothing set is normal)", false, j.degraded);
    check("no mode set: not the most permissive mode", false, j.mode === "wild");
  }

  // ---- REQUIRED CASE 2: an unknown mode name.
  {
    // 2a: asked for on the command line.
    const sd = freshState();
    const r = runSelf(["set", "yolo"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd } });
    check("unknown name via `set`: refused with exit 2", 2, r.status);
    check("unknown name via `set`: lists what is actually defined", true, /ship, craft, wild, lock/.test(r.stdout));
    check("unknown name via `set`: wrote no state file", 0, fs.existsSync(path.join(sd, "modes")) ? fs.readdirSync(path.join(sd, "modes")).length : 0);

    // 2b: already sitting in the state file, e.g. a mode deleted from modes.json
    // after someone set it. This is the one that matters, because nobody is
    // watching when it happens.
    const sd2 = freshState();
    const dir = path.join(sd2, "modes");
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = JSON.parse(
      runSelf(["show", "--json"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd2 } }).stdout,
    ).statePath;
    fs.writeFileSync(stateFile, JSON.stringify({ mode: "yolo" }), "utf8");
    const j = failsClosed("unknown name in the state file", { modesFile: GOOD, stateDirPath: sd2, expectDegraded: false });
    if (j) check("unknown name in the state file: still reports the source it rejected", "project", (j.sources[0] || {}).kind);

    // 2c: an unknown --mode override.
    const r3 = runSelf(["show", "--json", "--mode", "yolo"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: freshState() } });
    check("unknown --mode override: exits 0", 0, r3.status);
    const j3 = JSON.parse(r3.stdout || "{}");
    check("unknown --mode override: falls back to the default", "craft", j3.mode);
    check("unknown --mode override: warns", true, (j3.warnings || []).some((w) => /not a defined mode/.test(w)));
  }

  // ---- REQUIRED CASE 3: a corrupt mode config.
  failsClosed("corrupt modes.json", { modesFile: CORRUPT, stateDirPath: freshState() });
  failsClosed("blank modes.json", { modesFile: BLANK, stateDirPath: freshState() });
  failsClosed("missing modes.json", { modesFile: MISSING, stateDirPath: freshState() });

  // ---- REQUIRED CASE 4: valid JSON, but empty.
  failsClosed("valid but empty modes.json ({})", { modesFile: EMPTY_OBJ, stateDirPath: freshState() });
  failsClosed('valid modes.json with "modes": {}', { modesFile: EMPTY_MODES, stateDirPath: freshState() });

  // ---- The case that is easy to get wrong: a VALID config that points its own
  // default at the loosest mode. Honouring it would mean an unset project runs
  // WILD, which is exactly the silent-most-permissive failure.
  {
    const j = failsClosed("safeDefault points at the loosest mode", { modesFile: LOOSE_DEFAULT, stateDirPath: freshState() });
    if (j) {
      check("loose safeDefault: refused with the floor named", true, (j.warnings || []).some((w) => /below the floor/.test(w)));
      check("loose safeDefault: wild is still selectable by hand", true, (j.available || []).includes("wild"));
    }
    // ...and setting it by hand still works. The floor guards the DEFAULT only.
    const sd = freshState();
    const set = runSelf(["set", "wild"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: LOOSE_DEFAULT, TOOLBAY_STACK_STATE_DIR: sd } });
    check("loose safeDefault: an explicit `set wild` is still allowed", 0, set.status);
    const after = JSON.parse(runSelf(["show", "--json"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: LOOSE_DEFAULT, TOOLBAY_STACK_STATE_DIR: sd } }).stdout);
    check("loose safeDefault: and it takes effect when asked for explicitly", "wild", after.mode);
  }

  // ---- Corrupt and empty STATE files (the config is fine, the state is not).
  {
    for (const [label, body] of [
      ["corrupt state file", "{ not json"],
      ["empty state file", ""],
      ["state file with no mode field", '{"foo":1}'],
      ["state file with a non-string mode", '{"mode":42}'],
    ]) {
      const sd = freshState();
      const dir = path.join(sd, "modes");
      fs.mkdirSync(dir, { recursive: true });
      const sp = JSON.parse(runSelf(["show", "--json"], { cwd: proj, env: { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd } }).stdout).statePath;
      fs.writeFileSync(sp, body, "utf8");
      failsClosed(label, { modesFile: GOOD, stateDirPath: sd, expectDegraded: false });
    }
  }

  // ---- Round trip, and per-project isolation.
  {
    const sd = freshState();
    const env = { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd };
    check("set ship: exits 0", 0, runSelf(["set", "ship"], { cwd: proj, env }).status);
    const j = JSON.parse(runSelf(["show", "--json"], { cwd: proj, env }).stdout);
    check("set ship: reads back", "ship", j.mode);
    check("set ship: source is the project", "project", j.source);

    const other = path.join(tmp, "other-project");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "package.json"), "{}\n", "utf8");
    const k = JSON.parse(runSelf(["show", "--json"], { cwd: other, env }).stdout);
    check("mode is per project, not per machine", "craft", k.mode);

    // A subdirectory of the project inherits the project's stance.
    const sub = path.join(proj, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const s = JSON.parse(runSelf(["show", "--json"], { cwd: sub, env }).stdout);
    check("a subdirectory resolves to the same project stance", "ship", s.mode);

    check("clear: exits 0", 0, runSelf(["clear"], { cwd: proj, env }).status);
    check("clear: returns to the default", "craft", JSON.parse(runSelf(["show", "--json"], { cwd: proj, env }).stdout).mode);
  }

  // ---- Repo pin, including the disagreement rule.
  {
    const sd = freshState();
    const env = { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: sd };
    fs.writeFileSync(path.join(proj, PIN_FILE), "# this repo is client work\nlock\n", "utf8");
    check("a repo pin applies with nothing set locally", "lock", JSON.parse(runSelf(["show", "--json"], { cwd: proj, env }).stdout).mode);

    runSelf(["set", "wild"], { cwd: proj, env });
    const j = JSON.parse(runSelf(["show", "--json"], { cwd: proj, env }).stdout);
    check("a local setting cannot loosen a repo pin", "lock", j.mode);
    check("...and the disagreement is reported, not hidden", true, (j.warnings || []).some((w) => /disagree/.test(w)));

    fs.writeFileSync(path.join(proj, PIN_FILE), "not-a-mode\n", "utf8");
    const k = JSON.parse(runSelf(["show", "--json"], { cwd: proj, env }).stdout);
    check("a garbage repo pin is ignored, and the local setting stands", "wild", k.mode);
    check("...with the rejected pin still reported", true, (k.sources || []).some((s) => s.kind === "repo-pin" && s.accepted === false));

    fs.writeFileSync(path.join(proj, PIN_FILE), "   \n#comment only\n", "utf8");
    check("an empty repo pin is ignored rather than fatal", 0, runSelf(["show", "--json"], { cwd: proj, env }).status);
    fs.rmSync(path.join(proj, PIN_FILE));
    runSelf(["clear"], { cwd: proj, env });
  }

  // ---- The brief: what a skill actually consumes.
  {
    const env = { TOOLBAY_STACK_MODES_FILE: GOOD, TOOLBAY_STACK_STATE_DIR: freshState() };
    const wild = JSON.parse(runSelf(["brief", "review", "--json", "--mode", "wild"], { cwd: proj, env }).stdout);
    const lock = JSON.parse(runSelf(["brief", "review", "--json", "--mode", "lock"], { cwd: proj, env }).stdout);
    check("brief: /review is told to stay quiet in WILD", true, /quiet/i.test(wild.brief.lines.join(" ")));
    check("brief: /review is told to flag everything in LOCK", true, /everything/i.test(lock.brief.lines.join(" ")));
    check("brief: the same skill gets different instructions per mode", false, wild.brief.lines.join("|") === lock.brief.lines.join("|"));
    const unknownSkill = JSON.parse(runSelf(["brief", "no-such-skill", "--json"], { cwd: proj, env }).stdout);
    check("brief: an unknown skill falls back to the mode default, not empty", true, unknownSkill.brief.lines.length > 0);
    check("brief: and says the fallback was used", false, unknownSkill.brief.matched);
    const degraded = runSelf(["brief", "review", "--json"], { cwd: proj, env: { ...env, TOOLBAY_STACK_MODES_FILE: CORRUPT } });
    check("brief: still answers with a corrupt config", 0, degraded.status);
    check("brief: and the answer is the built-in stance", true, JSON.parse(degraded.stdout).brief.lines.length > 0);
  }

  // ---- --strict, for CI.
  {
    const env = { TOOLBAY_STACK_MODES_FILE: CORRUPT, TOOLBAY_STACK_STATE_DIR: freshState() };
    check("--strict turns a degraded config into a non-zero exit", 3, runSelf(["show", "--json", "--strict"], { cwd: proj, env }).status);
    check("...while plain show still exits 0", 0, runSelf(["show", "--json"], { cwd: proj, env }).status);
  }

  // ---- The router, which is the first real consumer.
  {
    const route = path.resolve(SKILL_DIR, "..", "router", "scripts", "route.mjs");
    if (fs.existsSync(route)) {
      const runReq = (req, env, extra = []) =>
        spawnSync(process.execPath, [route, "explain", req, "--root", SKILL_DIR + path.sep + "..", ...extra], {
          cwd: proj,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, NO_COLOR: "1", TOOLBAY_STACK_STATE_DIR: freshState(), ...env },
        });
      const run = (env, extra = []) => runReq("review my changes", env, extra);

      // A mode may reorder skills the request already pointed at. It may not
      // manufacture one: an +8 on /freeze must not win a request about a
      // webhook harness that never mentioned freezing anything.
      const unrelated = runReq("is there a stripe webhook replay harness I could use, I would rather not build one", { TOOLBAY_STACK_MODES_FILE: GOOD }, ["--mode", "lock"]);
      check("router: a positive mode boost cannot invent relevance", false, /invoke \/freeze/.test(unrelated.stdout), (unrelated.stdout.match(/action.*/) || [""])[0].trim());
      // The withheld skills score at or below zero, so they never appear in the
      // printed candidate list. The claim is that explain says so ANYWAY, in the
      // mode block, naming the skill and the boost it did not get. A withheld
      // boost that is invisible is indistinguishable from one that was applied.
      check("router: and it says why the boost did not apply", true, /withheld.*freeze \+8/.test(unrelated.stdout));
      check("router: naming what was withheld, where the reader will see it", true, /nothing in the request matched them/.test(unrelated.stdout));
      check("router: a negative mode weight still applies unconditionally", true, /-8 mode WILD|-6 mode LOCK|-3 mode SHIP/.test(run({ TOOLBAY_STACK_MODES_FILE: GOOD }, ["--mode", "wild"]).stdout));

      const ok = run({ TOOLBAY_STACK_MODES_FILE: GOOD });
      check("router: explain exits 0", 0, ok.status, (ok.stderr || "").trim().split("\n")[0]);
      check("router: explain reports the active mode", true, /Mode/.test(ok.stdout) && /CRAFT/.test(ok.stdout));
      const wild = run({ TOOLBAY_STACK_MODES_FILE: GOOD }, ["--mode", "wild"]);
      check("router: a mode changes the score, and the change is printed", true, /mode WILD/.test(wild.stdout));
      const lock = run({ TOOLBAY_STACK_MODES_FILE: GOOD }, ["--mode", "lock"]);
      check("router: LOCK vetoes the marketplace tier with a printed reason", true, /forbids the marketplace tier/.test(lock.stdout));
      const broken = run({ TOOLBAY_STACK_MODES_FILE: CORRUPT });
      check("router: still routes with a corrupt modes config", 0, broken.status, (broken.stderr || "").trim().split("\n")[0]);
      check("router: and says it fell back", true, /built-in|fallback/i.test(broken.stdout));
    } else {
      check("router: found next to the modes skill", true, false, route);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-mode", results);
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
  process.stdout.write("\n  No mode set, an unknown mode name, a corrupt config, an empty config, a missing\n");
  process.stdout.write("  config, a corrupt state file, and a config whose own default points at the\n");
  process.stdout.write(`  loosest mode all resolve DOWN to ${BUILTIN.label}, exit 0, and print the reason.\n`);
  process.stdout.write("  None of them crashes and none of them reaches the most permissive stance.\n\n");
  return true;
}

// ----------------------------------------------------------------------- entry

function help() {
  out(`
${bold("tb-mode")} ${VERSION} ${dim("(Toolbay Stack modes layer)")}

  ${cyan("tb-mode show")}                  the active stance and everything it changes
  ${cyan("tb-mode brief <skill>")}         the lines that skill should follow right now
  ${cyan("tb-mode set <name>")}            set the stance for THIS project
  ${cyan("tb-mode clear")}                 unset it, back to the safe default
  ${cyan("tb-mode list")}                  every mode defined, loosest first
  ${cyan("tb-mode config")}                print the file you edit to change your modes
  ${cyan("tb-mode coverage")}              which skills read the mode, counted off disk
  ${cyan("tb-mode selftest")}              prove the layer fails closed on broken input

${bold("Options")}
  --json          machine-readable, for a skill to consume
  --mode <name>   resolve as if this mode were active, without setting it
  --short         show: header only
  --strict        show: exit 3 if anything about the resolution was degraded (CI)

${bold("How it resolves")}
  1. --mode on this invocation
  2. a ${PIN_FILE} file committed in the project root
  3. the mode set for this project
  4. the configured safeDefault
  5. the built-in fallback stance

  When 2 and 3 disagree, the more restrained one wins. Anything missing, unknown,
  corrupt, or empty resolves DOWN, prints the reason, and exits 0.
`);
}

function main() {
  const argv = process.argv.slice(2);
  const flags = { json: false, strict: false, short: false, mode: null, skill: null };
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--strict") flags.strict = true;
    else if (a === "--short") flags.short = true;
    else if (a === "--mode" && argv[i + 1]) flags.mode = argv[(i += 1)];
    else if (a === "--skill" && argv[i + 1]) flags.skill = argv[(i += 1)];
    else if (a.startsWith("--")) {
      out(`Unknown option ${a}. Try: tb-mode help`);
      process.exitCode = 2;
      return;
    } else args.push(a);
  }
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") help();
  else if (cmd === "show" || cmd === "status" || cmd === "current") cmdShow(flags);
  else if (cmd === "brief" || cmd === "for") cmdBrief(flags, rest);
  else if (cmd === "set" || cmd === "use") cmdSet(rest, flags);
  else if (cmd === "clear" || cmd === "unset") cmdClear();
  else if (cmd === "list" || cmd === "modes") cmdList(flags);
  else if (cmd === "config" || cmd === "path") out(configPath());
  else if (cmd === "coverage") cmdCoverage(flags);
  else if (cmd === "selftest") selftest();
  else {
    out(`Unknown command ${cmd}. Try: tb-mode help`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // The layer is not allowed to take a skill down with it. Anything that got
    // this far is a bug here, so it is reported loudly and the caller is told
    // what stance is in force regardless.
    process.stdout.write(`\n  tb-mode hit an unexpected error and is falling back to the built-in ${BUILTIN.label} stance.\n`);
    process.stdout.write(`  ${err && err.stack ? err.stack.split("\n")[0] : String(err)}\n\n`);
    process.exitCode = 1;
  }
}

export { BUILTIN, PIN_FILE };
