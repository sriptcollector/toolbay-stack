#!/usr/bin/env node
/**
 * tb-officehours.mjs: the state and the gates behind /office-hours.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (YC office hours framing, the startup/builder mode
 * split, the six forcing questions, the anti-sycophancy rules, premise
 * challenge, mandatory alternatives, the design-doc templates, the founder
 * signal list, the four relationship tiers and their thresholds, the closing
 * plea sub-tiers, and the 34-item founder resource pool) comes from
 * `office-hours` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * Everything below is a check gstack's /office-hours describes in prose and
 * then does not perform, or performs with a shell idiom that is absent or
 * lying on Windows. Each one was reproduced on Windows 11 / Git Bash /
 * PowerShell 5.1 on 2026-08-13 and each is a fixture in `selftest`.
 *
 * 1. THE TIER GATE FAILS OPEN, AND FAILING OPEN REPLAYS A SALES PITCH.
 *    gstack office-hours/sections/design-and-handoff.md:278-281:
 *
 *      PROFILE=$(~/.claude/skills/gstack/bin/gstack-builder-profile 2>/dev/null) \
 *        || PROFILE="SESSION_COUNT: 0
 *      TIER: introduction"
 *
 *    `gstack-builder-profile` is a shim over `gstack-developer-profile --read`,
 *    which parses ~/.gstack/developer-profile.json with Bun. Against a
 *    truncated profile file, measured:
 *
 *      $ HOME=$fixture gstack-builder-profile
 *      SyntaxError: JSON Parse error: Expected '}'
 *      [exit = 1]
 *
 *    Exit 1 fires the `||`, so an unreadable profile is reported as
 *    SESSION_COUNT 0 / TIER introduction. The skill then reads that as "first
 *    session ever" and runs the full introduction path: the signal reflection,
 *    the golden-age paragraph, and Garry Tan's personal YC plea, at a user who
 *    may be on session 40. RESOURCES_SHOWN comes back empty in the same
 *    breath, so the dedup log is gone too and already-seen resources are shown
 *    again. `profile --read` here returns TIER: unknown and exits 3 for that
 *    input. Not knowing which tier you are in is a real state and it gets its
 *    own exit code; it is never quietly rounded down to "we have never met".
 *
 * 2. THE DESIGN LINEAGE GLOB READS A VARIABLE THAT IS NEVER SET.
 *    design-and-handoff.md:16 resolves the Supersedes chain with:
 *
 *      PRIOR=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null | head -1)
 *
 *    `BRANCH` is exported by `eval "$(gstack-slug)"`, which the skill runs in a
 *    DIFFERENT fenced block (:8). Each fenced block is its own process, so:
 *
 *      call 1: export TB_PERSIST_PROBE=set-in-call-1
 *      call 2: echo "[${TB_PERSIST_PROBE:-<empty>}]"  ->  [<empty>]
 *
 *    Both $SLUG and $BRANCH expand empty, the glob becomes
 *    `~/.gstack/projects//*--design-*.md`, it matches nothing, `2>/dev/null`
 *    eats the error and `|| head -1` keeps the exit code at 0. Result: PRIOR is
 *    always empty, every design doc is written as if it were the first on the
 *    branch, and the revision chain gstack documents ("you can trace how a
 *    design evolved across office hours sessions") never links once.
 *
 * 3. THE BRANCH KEY COLLIDES TWO DIFFERENT BRANCHES.
 *    bin/gstack-slug:  BRANCH=$(printf '%s' "$RAW_BRANCH" | tr -cd 'a-zA-Z0-9._-')
 *
 *      feature/login    -> featurelogin
 *      featurelogin     -> featurelogin
 *
 *    Deleting the separator instead of replacing it maps distinct branches onto
 *    one lineage key, so a doc written on `feature/login` is offered as the
 *    ancestor of one written on `featurelogin`. `docpath` replaces rather than
 *    deletes and appends a short digest of the raw name whenever it had to
 *    change anything, so two branches cannot share a key.
 *
 * 4. THE FILENAME'S UNIQUENESS COMES FROM TWO THINGS POWERSHELL DOES NOT HAVE.
 *    design-and-handoff.md:9-10 builds it from `whoami` and
 *    `date +%Y%m%d-%H%M%S`; other phases add `$$`. Measured in PowerShell 5.1:
 *
 *      PS> date +%Y%m%d-%H%M%S
 *      Get-Date : Cannot bind parameter 'Date'. Cannot convert value
 *      "+%Y%m%d-%H%M%S" to type "System.DateTime".
 *      PS> "value: [$$]"
 *      value: []
 *
 *    Node supplies both on every platform.
 *
 * 5. "THE ASSIGNMENT IS MANDATORY" IS NEVER CHECKED, AND NEITHER IS THE
 *    TEMPLATE. gstack states the rule ("Every session ends with a concrete
 *    real-world action, not just 'go build it'"), then hands the doc to a
 *    subagent for a 1-10 vibe score and skips that entirely if the subagent is
 *    unavailable ("Spec review unavailable, presenting unreviewed doc").
 *    `lint` checks it deterministically, offline, and exits non-zero: template
 *    placeholders still in the body, an empty or non-actionable assignment, a
 *    `Cross-Model Perspective` section written when no second opinion ran, and
 *    a `Supersedes:` line naming a file that is not on disk.
 *
 * 6. `open` DOES NOT EXIST ON WINDOWS.
 *      $ open https://ycombinator.com/apply
 *      bash: open: command not found
 *
 *    gstack uses bare `open` for the YC apply link, all three founder
 *    resources, and the builder journey file. Every one of them silently does
 *    nothing here. `link` uses the platform's real opener and exits non-zero,
 *    with the URL printed, when it cannot open anything.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const VERSION = "0.1.0";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_REJECTED = 1; // it ran and the answer is no
const EXIT_UNUSABLE = 2; // it could not read or was asked something invalid
const EXIT_UNKNOWN = 3; // the check could not complete: state is UNKNOWN, not clean

// ------------------------------------------------------------------ helpers

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const has = (args, name) => args.includes(name);

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}
function ohDir() {
  return path.join(stateDir(), "office-hours");
}
function profilePath(args) {
  return flag(args, "--profile") || path.join(ohDir(), "profile.json");
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const digest = (s, n = 6) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, n);

/** Atomic write on every platform: same-volume temp then rename. */
function writeAtomic(dest, body) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, dest);
}

/**
 * Branch -> a filesystem-safe key that is INJECTIVE.
 * gstack deletes the offending characters (`tr -cd`), which merges branches.
 * Replacing keeps the shape, and the digest of the raw name keeps them apart
 * even when two raw names replace down to the same string.
 */
function branchKey(raw) {
  const s = String(raw || "").trim() || "unknown";
  const safe = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unknown";
  return safe === s ? safe : `${safe}~${digest(s)}`;
}

/** Repo slug from the git remote, else the directory name. Never shells out through a glob. */
function repoSlug(cwd = process.cwd()) {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  const url = r.status === 0 ? (r.stdout || "").trim() : "";
  if (url) {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (m) return m[1].replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  }
  return path.basename(path.resolve(cwd)).replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
}

function currentBranch(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() || "unknown" : "unknown";
}

// ------------------------------------------------------------------ profile
//
// The single source of truth for the closing. Read fails CLOSED.

const TIERS = [
  { tier: "introduction", min: 0, max: 1 },
  { tier: "welcome_back", min: 2, max: 3 },
  { tier: "regular", min: 4, max: 7 },
  { tier: "inner_circle", min: 8, max: Infinity },
];

/** gstack's Phase 4.5 founder signals, as ids. An unlisted signal is refused. */
const SIGNALS = [
  "real_problem",
  "named_users",
  "pushback",
  "others_need_it",
  "domain_expertise",
  "taste",
  "agency",
  "defended_premise",
];
/** Signals that make the closing plea top-tier when there are 3+ of them. */
const HARD_EVIDENCE = ["named_users", "real_problem", "others_need_it"];

function tierFor(count) {
  return TIERS.find((t) => count >= t.min && count <= t.max).tier;
}

/**
 * Returns one of three states and never blurs them:
 *   absent   - no profile exists. This user really is new. tier=introduction.
 *   ok       - parsed. tier computed.
 *   unknown  - a profile exists but could not be read or parsed. tier=unknown.
 */
function loadProfile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { state: "absent", sessions: [] };
    return { state: "unknown", reason: `${file} exists but could not be read (${e.code || e.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { state: "unknown", reason: `${file} is not valid JSON (${e.message}); the session history it holds cannot be trusted` };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
    return { state: "unknown", reason: `${file} parsed but has no "sessions" array; this is not an office-hours profile` };
  }
  return { state: "ok", sessions: parsed.sessions };
}

function summarize(p) {
  const design = p.sessions.filter((s) => s && s.mode !== "resources");
  const count = design.length;
  const last = design[design.length - 1] || {};
  const shown = [];
  for (const s of p.sessions) for (const u of s?.resources_shown ?? []) if (!shown.includes(u)) shown.push(u);
  const acc = {};
  for (const s of design) for (const sig of s?.signals ?? []) acc[sig] = (acc[sig] || 0) + 1;
  const projects = [...new Set(design.map((s) => s?.project_slug).filter(Boolean))];
  return {
    session_count: count,
    tier: tierFor(count),
    last_project: last.project_slug ?? "",
    last_assignment: last.assignment ?? "",
    last_design_doc: last.design_doc ?? "",
    design_count: design.filter((s) => s.design_doc).length,
    design_titles: design.map((s) => s.design_doc).filter(Boolean),
    accumulated_signals: acc,
    total_signal_count: Object.values(acc).reduce((a, b) => a + b, 0),
    cross_project: projects.length > 1,
    nudge_eligible: count >= 4 && (acc.named_users ?? 0) >= 2 && (acc.pushback ?? 0) >= 1,
    resources_shown: shown,
    resources_shown_count: shown.length,
    topics: [...new Set(design.flatMap((s) => s?.topics ?? []))],
  };
}

function cmdProfileRead(args) {
  const json = has(args, "--json");
  const file = profilePath(args);
  const p = loadProfile(file);

  if (p.state === "unknown") {
    const body = { ok: false, state: "unknown", tier: "unknown", reason: p.reason, profile: file };
    if (json) out(JSON.stringify(body, null, 2));
    else {
      out();
      out("  TIER: unknown");
      out(`  NOT READ: ${p.reason}`);
      out();
      out("  Do not run a tier path. Do not run the introduction path: a profile that");
      out("  cannot be read is not the same as a user you have never met, and the");
      out("  introduction path replays the first-session pitch and loses the dedup log.");
      out("  Say the history is unreadable, ask, or fix the file.");
      out();
    }
    process.exitCode = EXIT_UNKNOWN;
    return;
  }

  const s = summarize(p);
  const body = { ok: true, state: p.state, profile: file, ...s };
  if (json) {
    out(JSON.stringify(body, null, 2));
    return;
  }
  out(`SESSION_COUNT: ${s.session_count}`);
  out(`TIER: ${s.tier}`);
  out(`SOURCE: ${p.state === "absent" ? "no profile on disk (genuinely a first session)" : file}`);
  out(`LAST_PROJECT: ${s.last_project}`);
  out(`LAST_ASSIGNMENT: ${s.last_assignment}`);
  out(`DESIGN_COUNT: ${s.design_count}`);
  out(`ACCUMULATED_SIGNALS: ${Object.entries(s.accumulated_signals).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  out(`TOTAL_SIGNAL_COUNT: ${s.total_signal_count}`);
  out(`CROSS_PROJECT: ${s.cross_project}`);
  out(`NUDGE_ELIGIBLE: ${s.nudge_eligible}`);
  out(`RESOURCES_SHOWN_COUNT: ${s.resources_shown_count}`);
  out(`TOPICS: ${s.topics.join(", ")}`);
}

function cmdProfileLog(args) {
  const json = has(args, "--json");
  const payload = args.find((a) => !a.startsWith("--") && a !== flag(args, "--profile"));
  const file = profilePath(args);
  let entry;
  try {
    entry = JSON.parse(payload ?? "");
  } catch (e) {
    if (json) out(JSON.stringify({ ok: false, error: `session payload is not JSON (${e.message})` }, null, 2));
    else err(`  UNUSABLE  session payload is not JSON (${e.message})`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const bad = (entry.signals ?? []).filter((s) => !SIGNALS.includes(s));
  if (bad.length) {
    const msg = `unknown founder signal(s): ${bad.join(", ")}. Known: ${SIGNALS.join(", ")}`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  REJECTED  ${msg}`);
    process.exitCode = EXIT_REJECTED;
    return;
  }

  const p = loadProfile(file);
  if (p.state === "unknown") {
    // Appending to a file we cannot parse would destroy the history it holds.
    const msg = `refusing to append: ${p.reason}`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  BLOCKED  ${msg}`);
    process.exitCode = EXIT_UNKNOWN;
    return;
  }
  const sessions = [...p.sessions, { date: new Date().toISOString(), ...entry }];
  writeAtomic(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
  const s = summarize({ sessions });
  if (json) out(JSON.stringify({ ok: true, profile: file, session_count: s.session_count, tier: s.tier }, null, 2));
  else out(`  logged  session ${s.session_count} -> ${file}  (tier now: ${s.tier})`);
}

// ------------------------------------------------------------------ signals

function cmdSignals(args) {
  const json = has(args, "--json");
  const list = (flag(args, "--have") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !SIGNALS.includes(s));
  if (!list.length) {
    const msg = `--have is required, comma separated. Known signals: ${SIGNALS.join(", ")}`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  UNUSABLE  ${msg}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  if (bad.length) {
    const msg = `unknown founder signal(s): ${bad.join(", ")}. Known: ${SIGNALS.join(", ")}`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  REJECTED  ${msg}`);
    process.exitCode = EXIT_REJECTED;
    return;
  }
  const uniq = [...new Set(list)];
  const evidence = uniq.filter((s) => HARD_EVIDENCE.includes(s));
  let subtier = "base";
  if (uniq.length >= 3 && evidence.length >= 1) subtier = "top";
  else if (uniq.length >= 1) subtier = "middle";
  const body = { ok: true, signals: uniq, signal_count: uniq.length, hard_evidence: evidence, plea_subtier: subtier };
  if (json) out(JSON.stringify(body, null, 2));
  else {
    out(`  SIGNAL_COUNT: ${uniq.length}`);
    out(`  HARD_EVIDENCE: ${evidence.join(", ") || "none"}`);
    out(`  PLEA_SUBTIER: ${subtier}`);
  }
}

// ------------------------------------------------------------------ docpath

function cmdDocpath(args) {
  const json = has(args, "--json");
  const mode = (flag(args, "--mode") ?? "").toLowerCase();
  if (!["startup", "builder"].includes(mode)) {
    const msg = "--mode must be startup or builder (the two design-doc templates differ)";
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  UNUSABLE  ${msg}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const cwd = flag(args, "--cwd") || process.cwd();
  const slug = flag(args, "--slug") || repoSlug(cwd);
  const rawBranch = flag(args, "--branch") || currentBranch(cwd);
  const key = branchKey(rawBranch);
  const user = (flag(args, "--user") || os.userInfo().username || "user").replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = path.join(stateDir(), "projects", slug);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const msg = `cannot create ${dir} (${e.code || e.message}); the design doc has nowhere to land`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  UNUSABLE  ${msg}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  // Lineage: newest existing doc on THIS branch key. No glob, no unset variable,
  // no dependence on state from a previous shell.
  const marker = `-${key}-design-`;
  let prior = null;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f.includes(marker))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    prior = files.length ? path.join(dir, files[0].f) : null;
  } catch {
    prior = null;
  }

  const name = `${user}-${key}-design-${stamp()}-${process.pid}.md`;
  const dest = path.join(dir, name);
  const body = {
    ok: true,
    mode,
    slug,
    branch: rawBranch,
    branch_key: key,
    dir,
    path: dest,
    supersedes: prior,
  };
  if (json) {
    out(JSON.stringify(body, null, 2));
    return;
  }
  out(`  SLUG:       ${slug}`);
  out(`  BRANCH:     ${rawBranch}  (key: ${key})`);
  out(`  PATH:       ${dest}`);
  out(`  SUPERSEDES: ${prior ?? "(none: this is the first design on this branch)"}`);
}

// --------------------------------------------------------------------- lint

const REQUIRED_COMMON = ["Problem Statement", "Premises", "Approaches Considered", "Recommended Approach", "Open Questions", "Success Criteria"];
const REQUIRED_STARTUP = [...REQUIRED_COMMON, "Demand Evidence", "Status Quo", "Target User & Narrowest Wedge", "The Assignment", "What I noticed about how you think"];
const REQUIRED_BUILDER = [...REQUIRED_COMMON, "What Makes This Cool", "Next Steps", "What I noticed about how you think"];

/** "go build it" is exactly what gstack says an assignment must not be. */
const NON_ASSIGNMENTS = [
  "go build it",
  "build it",
  "start building",
  "keep building",
  "implement it",
  "ship it",
  "just do it",
  "get started",
  "continue",
  "tbd",
  "n/a",
  "none",
];

/**
 * Only `##` opens a section. `###` (the per-approach headings in
 * "Approaches Considered") is body, not a boundary, so a section whose whole
 * content is sub-headings does not read as empty.
 */
function sectionsOf(text) {
  const map = new Map();
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].replace(/[*_`]/g, "").trim();
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (current) map.get(current).push(line);
  }
  return map;
}
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function find(map, name) {
  const want = key(name);
  for (const [k, v] of map) if (key(k) === want) return v;
  return null;
}
const bodyText = (lines) => (lines ?? []).join("\n").trim();

function lintDoc(text, { file = "(stdin)", secondOpinion = false, root = null } = {}) {
  const problems = [];
  const notes = [];
  const map = sectionsOf(text);

  const modeLine = /^Mode:\s*(\w+)/im.exec(text);
  const mode = modeLine ? modeLine[1].toLowerCase() : null;
  if (!mode || !["startup", "builder"].includes(mode)) {
    problems.push('no "Mode: Startup" or "Mode: Builder" header line; the two templates require different sections, so this doc cannot be checked against either');
    return { ok: false, problems, notes, mode: null };
  }

  for (const name of mode === "startup" ? REQUIRED_STARTUP : REQUIRED_BUILDER) {
    const sec = find(map, name);
    if (!sec) problems.push(`missing required section "## ${name}" for Mode: ${mode}`);
    else if (!bodyText(sec)) problems.push(`section "## ${name}" is present but empty`);
  }

  // Template placeholders. gstack's templates are literally full of {from Phase 2A}.
  const holes = [];
  const re = /\{([^{}\n]{2,80})\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    if (/^[A-Za-z0-9_]+\s*:/.test(inner) && inner.includes('"')) continue; // JSON-ish, not a hole
    holes.push(inner);
  }
  if (holes.length) {
    problems.push(`${holes.length} unfilled template placeholder(s) left in the body: ${holes.slice(0, 3).map((h) => `{${h}}`).join(", ")}${holes.length > 3 ? ", ..." : ""}`);
  }

  // The assignment. gstack: "The assignment is mandatory ... not just 'go build it'."
  const assignName = mode === "startup" ? "The Assignment" : "Next Steps";
  const assign = bodyText(find(map, assignName));
  if (assign) {
    const flat = assign.toLowerCase().replace(/^[-*\d.)\s]+/gm, "").trim();
    const hit = NON_ASSIGNMENTS.find((n) => flat === n || flat === `${n}.` || flat.startsWith(`${n}.`) || flat.startsWith(`${n},`) || flat.startsWith(`${n}!`));
    if (hit) problems.push(`"## ${assignName}" is "${assign.trim().slice(0, 60)}", which is the non-assignment gstack names explicitly; it has to be an action the user can go do`);
    else if (flat.replace(/[^a-z0-9]/g, "").length < 25) {
      problems.push(`"## ${assignName}" is too short to be a real action: "${assign.trim().slice(0, 60)}"`);
    }
  }

  // A Cross-Model Perspective section is a claim that a second model read this.
  const xmodel = find(map, "Cross-Model Perspective");
  if (xmodel && bodyText(xmodel) && !secondOpinion) {
    problems.push('"## Cross-Model Perspective" has content but no second opinion was recorded (pass --second-opinion if one really ran); gstack says to omit the section entirely when it did not');
  }
  if (!xmodel && secondOpinion) {
    problems.push("--second-opinion was passed but the doc has no \"## Cross-Model Perspective\" section, so the second read is not in the deliverable");
  }

  // Supersedes is a claim about a file.
  const sup = /^Supersedes:\s*(.+?)\s*$/im.exec(text);
  if (sup) {
    const target = sup[1].trim();
    if (!target || /^\{.*\}$/.test(target)) {
      problems.push('"Supersedes:" is present but names nothing; omit the line when this is the first design on the branch');
    } else {
      const abs = path.isAbsolute(target) ? target : path.resolve(root || (file === "(stdin)" ? process.cwd() : path.dirname(file)), target);
      if (!fs.existsSync(abs)) problems.push(`"Supersedes: ${target}" names a design doc that is not on disk (looked at ${abs})`);
      else notes.push(`supersedes ${target}, which exists`);
    }
  }

  return { ok: problems.length === 0, problems, notes, mode };
}

function cmdLint(args) {
  const json = has(args, "--json");
  const skip = new Set(["--root"]);
  const file = args.find((a, i) => !a.startsWith("--") && !skip.has(args[i - 1]));
  let text;
  if (file) {
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      const msg = `${file} could not be read (${e.code || e.message})`;
      if (json) out(JSON.stringify({ ok: false, problems: [msg] }, null, 2));
      else err(`  UNUSABLE  ${msg}`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
  } else {
    try {
      text = fs.readFileSync(0, "utf8");
    } catch {
      err("  UNUSABLE  no design doc given and nothing on stdin");
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
  }
  const r = lintDoc(text, { file: file ?? "(stdin)", secondOpinion: has(args, "--second-opinion"), root: flag(args, "--root") });
  if (json) {
    out(JSON.stringify(r, null, 2));
  } else {
    out();
    if (r.ok) out(`  ok  the ${r.mode} design doc is complete: every required section is filled, the assignment is an action, and every claim it makes about another file resolves`);
    else {
      out(`  ${r.problems.length} problem(s):`);
      for (const p of r.problems) out(`    - ${p}`);
    }
    for (const n of r.notes) out(`  note  ${n}`);
    out();
  }
  if (!r.ok) process.exitCode = EXIT_REJECTED;
}

// ---------------------------------------------------------------- resources

function loadPool() {
  const file = path.join(HERE, "..", "data", "resources.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

function cmdResources(args) {
  const json = has(args, "--json");
  const want = Math.max(1, Number(flag(args, "--pick") ?? 3) || 3);
  const context = flag(args, "--context") || null;
  const file = profilePath(args);

  let data;
  try {
    data = loadPool();
  } catch (e) {
    const msg = `the resource pool could not be read (${e.code || e.message}); nothing may be recommended`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  UNUSABLE  ${msg}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  if (context && !Object.prototype.hasOwnProperty.call(data.contexts, context)) {
    const msg = `unknown --context "${context}". Known: ${Object.keys(data.contexts).join(", ")}`;
    if (json) out(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`  UNUSABLE  ${msg}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const p = loadProfile(file);
  if (p.state === "unknown") {
    const msg = `${p.reason}. The dedup log is part of that file, so recommending now would re-show resources this user has already seen.`;
    if (json) out(JSON.stringify({ ok: false, state: "unknown", error: msg }, null, 2));
    else err(`  UNKNOWN  ${msg}`);
    process.exitCode = EXIT_UNKNOWN;
    return;
  }
  const shown = new Set(p.state === "ok" ? summarize(p).resources_shown : []);
  const remaining = data.pool.filter((r) => !shown.has(r.url));

  if (!remaining.length) {
    const msg = `all ${data.pool.length} resources have been shown to this user; there is nothing left that would not be a repeat`;
    if (json) out(JSON.stringify({ ok: false, state: "exhausted", shown: shown.size, error: msg }, null, 2));
    else {
      out();
      out(`  EXHAUSTED  ${msg}`);
      out("  Skip the resources section. Do not re-show one.");
      out();
    }
    process.exitCode = EXIT_UNKNOWN;
    return;
  }

  // Context first, then round-robin across categories so the set is never three
  // of the same type while a different type is still available.
  const matched = context ? remaining.filter((r) => r.contexts.includes(context)) : [];
  const rest = remaining.filter((r) => !matched.includes(r));
  const byCat = new Map();
  for (const r of rest) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const picked = [];
  const catCount = new Map();
  const take = (r) => {
    picked.push(r);
    catCount.set(r.category, (catCount.get(r.category) || 0) + 1);
  };
  for (const r of matched) {
    if (picked.length >= want) break;
    if ((catCount.get(r.category) || 0) >= 2) continue;
    take(r);
  }
  const cats = [...byCat.keys()].sort((a, b) => (catCount.get(a) || 0) - (catCount.get(b) || 0) || a.localeCompare(b));
  let guard = 0;
  while (picked.length < want && guard++ < 500) {
    let progressed = false;
    for (const c of cats) {
      if (picked.length >= want) break;
      const list = byCat.get(c);
      const next = list.find((r) => !picked.includes(r));
      if (!next) continue;
      if ((catCount.get(c) || 0) >= Math.max(1, Math.ceil(want / 2))) continue;
      take(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  // Only if category mixing could not fill the ask do we relax the mix rule,
  // and never the no-repeat rule.
  for (const r of remaining) {
    if (picked.length >= want) break;
    if (!picked.includes(r)) take(r);
  }

  const short = picked.length < want;
  if (has(args, "--mark")) {
    const sessions = [
      ...(p.sessions ?? []),
      {
        date: new Date().toISOString(),
        mode: "resources",
        project_slug: flag(args, "--slug") ?? "",
        signal_count: 0,
        signals: [],
        design_doc: "",
        assignment: "",
        resources_shown: picked.map((r) => r.url),
        topics: [],
      },
    ];
    writeAtomic(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
  }

  if (json) {
    out(JSON.stringify({ ok: true, requested: want, returned: picked.length, remaining_after: remaining.length - picked.length, short, picked }, null, 2));
    return;
  }
  out();
  for (const r of picked) {
    out(`  > **${r.title}** (${r.duration})`);
    out(`  > ${r.blurb}`);
    out(`  > ${r.url}`);
    out();
  }
  out(`  ${picked.length}/${want} picked, ${remaining.length - picked.length} unseen resources remain.`);
  if (short) out("  Fewer than asked, because the alternative was showing one twice.");
  out();
}

// --------------------------------------------------------------------- link
//
// gstack calls bare `open`, which does not exist on Windows or on most Linux
// desktops. This uses the platform opener, refuses a scheme it will not vouch
// for, and never pretends to have opened something it did not.

const SAFE_SCHEME = /^(https?|file):/i;

function openOne(url) {
  if (!SAFE_SCHEME.test(url)) return { url, ok: false, reason: "refused: only http, https and file URLs are opened" };
  let r;
  if (process.platform === "win32") {
    // rundll32 takes the URL as an argv element, so there is no shell to inject
    // into. `cmd /c start` would need one.
    r = spawnSync("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    r = spawnSync("open", [url], { stdio: "ignore" });
  } else {
    r = spawnSync("xdg-open", [url], { stdio: "ignore" });
    if (r.error && r.error.code === "ENOENT") r = spawnSync("gio", ["open", url], { stdio: "ignore" });
  }
  if (r.error) return { url, ok: false, reason: `no working opener on ${process.platform} (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { url, ok: false, reason: `opener exited ${r.status}` };
  return { url, ok: true };
}

function cmdLink(args) {
  const json = has(args, "--json");
  const urls = args.filter((a) => !a.startsWith("--"));
  if (!urls.length) {
    err("  UNUSABLE  no url given");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const dry = has(args, "--dry-run");
  const results = urls.map((u) => (dry ? { url: u, ok: SAFE_SCHEME.test(u), reason: SAFE_SCHEME.test(u) ? "" : "refused: only http, https and file URLs are opened" } : openOne(u)));
  const failed = results.filter((r) => !r.ok);
  if (json) out(JSON.stringify({ ok: !failed.length, results }, null, 2));
  else {
    for (const r of results) out(r.ok ? `  opened  ${r.url}` : `  NOT OPENED  ${r.url}  (${r.reason})`);
    if (failed.length) out("\n  Paste the links above into a browser; nothing was opened for them.\n");
  }
  if (failed.length) process.exitCode = failed.some((f) => f.reason.startsWith("refused")) ? EXIT_UNUSABLE : EXIT_REJECTED;
}

// ----------------------------------------------------------------- selftest

function runSelf(args, { stdin = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GOOD_DOC = `# Design: Expire stale order links

Generated by /office-hours on 2026-08-13
Branch: main
Repo: toolbay/stack
Status: DRAFT
Mode: Startup

## Problem Statement

Fulfilled orders stay reachable by URL forever, so a support agent who shares a
link once has shared the customer's address permanently.

## Demand Evidence

Two customers called within 20 minutes of the last incident. One of them,
Dana at Northwind Logistics, asked for a written remediation before renewing.

## Status Quo

Support pastes order links into Slack and hopes the channel stays private.

## Target User & Narrowest Wedge

Dana, the ops manager who signs the renewal. Wedge: expire the link after 30
days, nothing else.

## Premises

1. Links are shared outside the product and that will not stop.
2. A 30-day window covers every real support case we have logged.

## Approaches Considered

### Approach A: expiry check in the API
Smallest diff, one file.

### Approach B: signed short-lived URLs
Better long term, needs a key rotation story.

## Recommended Approach

Approach A, because it ships this week and Dana's renewal is in three weeks.

## Open Questions

Whether finance needs a longer window for disputes.

## Success Criteria

Orders older than 30 days return HTTP 410 for all four roles.

## The Assignment

Call Dana on Thursday and ask what window she would have to sign off on before
we pick 30 days for her.

## What I noticed about how you think

- You said "Dana at Northwind", not "enterprise customers".
- You pushed back on premise 2 before agreeing to it.
`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-oh-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const profileAt = (n) => {
    const f = path.join(tmp, `p${n}-${Math.random().toString(36).slice(2)}.json`);
    const sessions = Array.from({ length: n }, (_, i) => ({
      date: new Date(2026, 0, i + 1).toISOString(),
      mode: "startup",
      project_slug: "acme-app",
      signal_count: 2,
      signals: ["named_users", "pushback"],
      design_doc: `doc-${i}.md`,
      assignment: `call someone ${i}`,
      resources_shown: [],
      topics: ["orders"],
    }));
    fs.writeFileSync(f, JSON.stringify({ version: 1, sessions }, null, 2), "utf8");
    return f;
  };

  // ---- 1. the tier gate fails CLOSED
  {
    const corrupt = path.join(tmp, "corrupt.json");
    fs.writeFileSync(corrupt, "{ this is not json ", "utf8");
    const r = runSelf(["profile", "--read", "--json", "--profile", corrupt]);
    check("an unreadable profile reports tier unknown, not introduction", 3, r.status);
    const parsed = JSON.parse(r.stdout || "{}");
    check("...and the tier really is 'unknown'", "unknown", parsed.tier ?? "", r.stdout.slice(0, 200));
    check("...and it is NOT the introduction tier gstack falls back to", false, parsed.tier === "introduction");

    const notAProfile = path.join(tmp, "notaprofile.json");
    fs.writeFileSync(notAProfile, JSON.stringify({ hello: "world" }), "utf8");
    check("valid JSON that is not a profile is unknown, not empty", 3, runSelf(["profile", "--read", "--json", "--profile", notAProfile]).status);

    const dirAsFile = path.join(tmp, "adir");
    fs.mkdirSync(dirAsFile, { recursive: true });
    check("a directory where the profile should be is unknown, not absent", 3, runSelf(["profile", "--read", "--json", "--profile", dirAsFile]).status);

    // Absence is a different state and must NOT be treated as an error.
    const r2 = runSelf(["profile", "--read", "--json", "--profile", path.join(tmp, "nope.json")]);
    check("an absent profile is a genuine first session", 0, r2.status);
    check("...with tier introduction", "introduction", JSON.parse(r2.stdout || "{}").tier ?? "");
  }

  // ---- 2. tier thresholds
  for (const [n, want] of [[1, "introduction"], [2, "welcome_back"], [3, "welcome_back"], [4, "regular"], [7, "regular"], [8, "inner_circle"], [12, "inner_circle"]]) {
    const r = runSelf(["profile", "--read", "--json", "--profile", profileAt(n)]);
    check(`${String(n).padStart(2)} session(s) -> ${want}`, want, JSON.parse(r.stdout || "{}").tier ?? "");
  }

  // ---- 3. appending never destroys an unreadable history
  {
    const corrupt = path.join(tmp, "corrupt2.json");
    fs.writeFileSync(corrupt, "{ truncated", "utf8");
    const before = fs.readFileSync(corrupt, "utf8");
    const r = runSelf(["profile", "--log-session", "--json", "--profile", corrupt, JSON.stringify({ mode: "startup", signals: ["taste"] })]);
    check("logging into an unparseable profile is refused", 3, r.status);
    check("...and the file on disk is untouched", before, fs.readFileSync(corrupt, "utf8"));
  }
  {
    const f = path.join(tmp, "sig.json");
    const r = runSelf(["profile", "--log-session", "--json", "--profile", f, JSON.stringify({ mode: "startup", signals: ["taste", "vibes_were_good"] })]);
    check("a signal name that is not in the list is rejected", 1, r.status);
    check("...and no profile was created by the rejected write", false, fs.existsSync(f));
  }

  // ---- 4. signals -> plea sub-tier
  check("unknown signal name rejected", 1, runSelf(["signals", "--json", "--have", "taste,charisma"]).status);
  check("no signals at all is unusable, not 'base'", 2, runSelf(["signals", "--json", "--have", ""]).status);
  check("3 signals with hard evidence -> top", "top", JSON.parse(runSelf(["signals", "--json", "--have", "named_users,pushback,taste"]).stdout || "{}").plea_subtier ?? "");
  check("3 signals without hard evidence -> middle", "middle", JSON.parse(runSelf(["signals", "--json", "--have", "taste,agency,pushback"]).stdout || "{}").plea_subtier ?? "");
  check("1 signal -> middle", "middle", JSON.parse(runSelf(["signals", "--json", "--have", "taste"]).stdout || "{}").plea_subtier ?? "");
  check("duplicates do not inflate the count", 1, JSON.parse(runSelf(["signals", "--json", "--have", "taste,taste,taste"]).stdout || "{}").signal_count ?? -1);

  // ---- 5. docpath: lineage, collisions, uniqueness
  {
    const state = path.join(tmp, "state1");
    const env = { TOOLBAY_STACK_STATE_DIR: state };
    const mk = (branch) =>
      JSON.parse(runSelf(["docpath", "--json", "--mode", "startup", "--slug", "acme-app", "--user", "orion", "--branch", branch], { env }).stdout || "{}");

    const a = mk("feature/login");
    check("docpath returns a path", true, Boolean(a.path), JSON.stringify(a).slice(0, 200));
    check("first doc on a branch has no ancestor", null, a.supersedes);
    fs.writeFileSync(a.path, GOOD_DOC, "utf8");

    const b = mk("feature/login");
    check("the second doc on the same branch supersedes the first", a.path, b.supersedes, `got ${b.supersedes}`);

    // gstack's `tr -cd 'a-zA-Z0-9._-'` maps both of these onto "featurelogin".
    const c = mk("featurelogin");
    check("a different branch that gstack collapses onto the same key is kept apart", null, c.supersedes, `branch_key ${c.branch_key} vs ${b.branch_key}`);
    check("...because the branch keys differ", true, b.branch_key !== c.branch_key, `${b.branch_key} / ${c.branch_key}`);

    // The name must carry a real timestamp and pid. In PowerShell gstack's
    // `date +%Y%m%d-%H%M%S` errors and `$$` is empty.
    check("the filename carries a real timestamp and pid", true, /^orion-.+-design-\d{8}-\d{6}-\d+\.md$/.test(path.basename(b.path)), path.basename(b.path));

    // A branch name with a slash must not become a nested directory.
    check("a slash in the branch does not become a subdirectory", true, path.dirname(b.path) === b.dir, `${path.dirname(b.path)} vs ${b.dir}`);

    check("an unknown mode is refused", 2, runSelf(["docpath", "--json", "--mode", "vibes"], { env }).status);
  }

  // ---- 6. lint
  check("lint accepts a complete startup doc", 0, runSelf(["lint", "--json"], { stdin: GOOD_DOC }).status);
  {
    const bad = [
      ["lint rejects an unfilled template placeholder", GOOD_DOC.replace("Support pastes order links into Slack and hopes the channel stays private.", "{from Q2 - concrete current workflow users live with today}")],
      ["lint rejects a missing assignment", GOOD_DOC.replace(/## The Assignment\n\n[\s\S]*?\n\n## What I noticed/, "## What I noticed")],
      ["lint rejects an empty assignment", GOOD_DOC.replace("Call Dana on Thursday and ask what window she would have to sign off on before\nwe pick 30 days for her.", "")],
      ["lint rejects 'go build it' as the assignment", GOOD_DOC.replace("Call Dana on Thursday and ask what window she would have to sign off on before\nwe pick 30 days for her.", "Go build it")],
      ["lint rejects a missing Demand Evidence section in startup mode", GOOD_DOC.replace(/## Demand Evidence\n\n[\s\S]*?\n\n## Status Quo/, "## Status Quo")],
      ["lint rejects a doc with no Mode header", GOOD_DOC.replace("Mode: Startup\n", "")],
      ["lint rejects an unknown Mode", GOOD_DOC.replace("Mode: Startup", "Mode: Freestyle")],
      ["lint rejects an empty section", GOOD_DOC.replace("Whether finance needs a longer window for disputes.", "")],
    ];
    for (const [name, payload] of bad) check(name, 1, runSelf(["lint", "--json"], { stdin: payload }).status);

    // A Cross-Model Perspective section is a claim that a second model read it.
    const fabricated = GOOD_DOC.replace("## Open Questions", "## Cross-Model Perspective\n\nCodex steelmanned the wedge and challenged premise 2.\n\n## Open Questions");
    check("lint rejects a cross-model section when no second opinion ran", 1, runSelf(["lint", "--json"], { stdin: fabricated }).status);
    check("...and accepts it when one did", 0, runSelf(["lint", "--json", "--second-opinion"], { stdin: fabricated }).status);
    check("lint rejects --second-opinion with no section to show for it", 1, runSelf(["lint", "--json", "--second-opinion"], { stdin: GOOD_DOC }).status);

    // Supersedes is a claim about a file.
    const ghost = GOOD_DOC.replace("Mode: Startup", "Mode: Startup\nSupersedes: orion-main-design-20260101-000000-1.md");
    check("lint rejects a Supersedes pointing at a file that is not there", 1, runSelf(["lint", "--json", "--root", tmp], { stdin: ghost }).status);
    fs.writeFileSync(path.join(tmp, "orion-main-design-20260101-000000-1.md"), "old", "utf8");
    check("...and accepts it once that file exists", 0, runSelf(["lint", "--json", "--root", tmp], { stdin: ghost }).status);

    check("lint treats an unreadable doc as unusable, not clean", 2, runSelf(["lint", "--json", path.join(tmp, "missing.md")]).status);

    // Builder mode has different required sections.
    const builder = `# Design: Weekend synth\n\nMode: Builder\n\n## Problem Statement\nA synth that draws itself.\n\n## What Makes This Cool\nThe waveform animates as it generates, so watching it is the demo.\n\n## Premises\n1. Web Audio is enough.\n\n## Approaches Considered\n### Approach A: canvas\nfast\n### Approach B: webgl\nprettier\n\n## Recommended Approach\nA, it ships tonight.\n\n## Open Questions\nWhether mobile Safari cooperates.\n\n## Success Criteria\nA shareable URL that replays the patch.\n\n## Next Steps\nBuild the oscillator and the canvas draw loop first, then the share URL.\n\n## What I noticed about how you think\n- You said "I want to show my brother", not "users".\n`;
    check("lint accepts a complete builder doc", 0, runSelf(["lint", "--json"], { stdin: builder }).status);
    check("lint rejects a builder doc missing What Makes This Cool", 1, runSelf(["lint", "--json"], { stdin: builder.replace(/## What Makes This Cool\n[\s\S]*?\n\n## Premises/, "## Premises") }).status);
  }

  // ---- 7. resources: never repeat, exhaust honestly, mix categories
  {
    const f = path.join(tmp, "res.json");
    fs.writeFileSync(f, JSON.stringify({ version: 1, sessions: [] }, null, 2), "utf8");
    const seen = new Set();
    let rounds = 0;
    let lastStatus = 0;
    let mixOk = true;
    for (let i = 0; i < 40; i++) {
      const r = runSelf(["resources", "--json", "--pick", "3", "--mark", "--profile", f]);
      lastStatus = r.status;
      if (r.status !== 0) break;
      const picked = JSON.parse(r.stdout || "{}").picked ?? [];
      const cats = {};
      for (const p of picked) {
        if (seen.has(p.url)) mixOk = false; // repeat
        seen.add(p.url);
        cats[p.category] = (cats[p.category] || 0) + 1;
      }
      if (picked.length === 3 && Object.values(cats).some((n) => n >= 3)) mixOk = false;
      rounds++;
    }
    check("resources never repeat a url across the whole pool", 34, seen.size);
    check("...and no round was three of the same category", true, mixOk);
    check("...and the pool exhausts in 12 rounds of 3", 12, rounds);
    check("an exhausted pool exits 3 rather than repeating", 3, lastStatus);

    // A profile that cannot be read means the dedup log cannot be read either.
    const corrupt = path.join(tmp, "res-corrupt.json");
    fs.writeFileSync(corrupt, "{ nope", "utf8");
    check("resources refuse to recommend when the dedup log is unreadable", 3, runSelf(["resources", "--json", "--pick", "3", "--profile", corrupt]).status);
    check("an unknown --context is refused, not ignored", 2, runSelf(["resources", "--json", "--context", "vibes", "--profile", path.join(tmp, "fresh.json")]).status);

    const ctx = runSelf(["resources", "--json", "--pick", "3", "--context", "quitting-job", "--profile", path.join(tmp, "fresh2.json")]);
    const ctxPicked = JSON.parse(ctx.stdout || "{}").picked ?? [];
    check("a context match leads the selection", true, ctxPicked.some((r) => r.contexts.includes("quitting-job")), ctxPicked.map((r) => r.id).join(","));
  }

  // ---- 8. link
  check("link refuses a javascript: url", 2, runSelf(["link", "--json", "--dry-run", "javascript:alert(1)"]).status);
  check("link refuses a bare shell word", 2, runSelf(["link", "--json", "--dry-run", "calc.exe"]).status);
  check("link accepts an https url", 0, runSelf(["link", "--json", "--dry-run", "https://ycombinator.com/apply?ref=toolbay-stack"]).status);
  check("link with no url is unusable", 2, runSelf(["link", "--json"]).status);

  // ---- 9. what gstack does with the same corrupt profile, recorded not asserted
  const probe = [];
  {
    const shim = path.join(os.homedir(), ".claude", "skills", "gstack", "bin", "gstack-builder-profile");
    if (fs.existsSync(shim)) {
      const fakeHome = path.join(tmp, "fakehome");
      fs.mkdirSync(path.join(fakeHome, ".gstack"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".gstack", "developer-profile.json"), "{ this is not json ", "utf8");
      const r = spawnSync("bash", [shim], { encoding: "utf8", env: { ...process.env, HOME: fakeHome } });
      probe.push(`gstack-builder-profile on the same corrupt profile: exit ${r.status}, ${(r.stdout || "").length} bytes of stdout`);
      probe.push(`  -> exit ${r.status} fires the '|| PROFILE="SESSION_COUNT: 0\\nTIER: introduction"' fallback at`);
      probe.push("     sections/design-and-handoff.md:278, so a session-40 user gets the first-session pitch.");
    } else {
      probe.push("gstack is not installed here, so the comparison probe was skipped (it is a probe, not an assertion).");
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-officehours", results, probe);
}

// ------------------------------------------------------------------- output

function report(label, results, probe = []) {
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
  if (probe.length) {
    process.stdout.write("\n  Upstream comparison:\n");
    for (const line of probe) process.stdout.write(`    ${line}\n`);
  }
  process.stdout.write("\n  Every check above is one /office-hours states as a rule and then leaves to\n");
  process.stdout.write("  a shell idiom that is absent on Windows, to a subagent it skips when the\n");
  process.stdout.write("  subagent is missing, or to the model's memory. These are deterministic and\n");
  process.stdout.write("  offline, and the unreadable cases exit 3 instead of reading as a clean slate.\n\n");
  return true;
}

function help() {
  out(`
  tb-officehours ${VERSION}  (Toolbay Stack)

  profile --read [--profile <f>]
        SESSION_COUNT / TIER / dedup log. Exit 3 with TIER: unknown when the
        profile exists but cannot be read. Never falls back to "introduction".
  profile --log-session '<json>' [--profile <f>]
        append a session. Refuses unknown founder signals; refuses to append to
        a profile it cannot parse.
  signals --have a,b,c
        founder signal count and the closing plea sub-tier (top/middle/base).
  docpath --mode startup|builder [--slug s] [--branch b] [--user u]
        the design-doc path, plus the prior doc on this branch for Supersedes.
        Branch keys are injective; the name carries a real timestamp and pid.
  lint [file] [--second-opinion] [--root <dir>]
        the design doc is complete for its mode, has no template holes, has a
        real assignment, and every claim about another file resolves. Exit 1.
  resources --pick N [--context <k>] [--mark] [--profile <f>]
        deduplicated founder resources. Exit 3 when the pool is out, rather
        than showing one twice.
  link <url...> [--dry-run]
        open a url with the platform's real opener. Exit non-zero, with the url
        printed, when nothing was opened.
  selftest

  Options: --json.  State lives in $TOOLBAY_STACK_STATE_DIR (default ~/.toolbay-stack).
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
if (cmd === "profile") {
  if (has(rest, "--log-session")) cmdProfileLog(rest.filter((a) => a !== "--log-session"));
  else cmdProfileRead(rest);
} else if (cmd === "signals") cmdSignals(rest);
else if (cmd === "docpath") cmdDocpath(rest);
else if (cmd === "lint") cmdLint(rest);
else if (cmd === "resources") cmdResources(rest);
else if (cmd === "link") cmdLink(rest);
else if (cmd === "selftest") selftest();
else help();
