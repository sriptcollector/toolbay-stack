#!/usr/bin/env node
/**
 * tb-landing.mjs — which VERSION slots are already claimed, and which one
 * /ship would take next. Read only. Mutates nothing, ever.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * DERIVED WORK. The skill name, the version-slot queue concept and the
 * command surface are gstack's, by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * The code here is a rewrite. See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS, AND THE ONE ANSWER IT REFUSES TO GIVE.
 *
 * Two people ship at once. Both bump VERSION to the same number. The second
 * merge is a conflict at best and a silently overwritten release at worst.
 * This prints the queue so that does not happen.
 *
 * Which makes the dangerous output not a wrong number but a confident empty
 * one. If `gh` is missing, or not authenticated, or the network is down, the
 * naive implementation prints:
 *
 *     Open PRs claiming a slot:  (none)
 *
 * and that sentence is indistinguishable from "the coast is clear". It is the
 * exact defect this repository keeps finding: a check that reports success
 * while doing nothing. So every source of claims here returns one of three
 * states — KNOWN_CLAIMED, KNOWN_EMPTY, UNKNOWN — and UNKNOWN is loud, is never
 * collapsed into empty, and downgrades the final recommendation to
 * "cannot recommend a slot". A slot suggested on top of an unread queue is
 * worse than no suggestion, because you would act on it.
 *
 *   node tb-landing.mjs report [--dir <repo>] [--json]
 *   node tb-landing.mjs next   [--dir <repo>]
 *   node tb-landing.mjs selftest
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";

/* ------------------------------------------------------------------ *
 * Three-state knowledge. The whole point of the file.
 * ------------------------------------------------------------------ */
export const KNOWN_CLAIMED = "KNOWN_CLAIMED";
export const KNOWN_EMPTY = "KNOWN_EMPTY";
export const UNKNOWN = "UNKNOWN";

/* ------------------------------------------------------------------ *
 * Version arithmetic.
 * ------------------------------------------------------------------ */
export const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;

export function parseVersion(s) {
  const t = String(s || "").trim();
  if (!VERSION_RE.test(t)) return null;
  return t.split(".").map(Number);
}

export function formatVersion(parts) {
  return parts.join(".");
}

/** The next patch slot after a version. Keeps the same arity it was given. */
export function nextPatch(s) {
  const p = parseVersion(s);
  if (!p) return null;
  const out = p.slice();
  out[out.length - 1] += 1;
  return formatVersion(out);
}

/** Compare two version strings. Shorter arity sorts before longer at equality. */
export function compareVersions(a, b) {
  const pa = parseVersion(a) || [];
  const pb = parseVersion(b) || [];
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Pull a version out of a branch name or PR title.
 * Deliberately conservative: it must look like a version, not merely contain
 * digits, or every branch named `fix-issue-1.2` claims a release slot.
 */
export function versionIn(text) {
  const m = String(text || "").match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/);
  return m ? m[1] : null;
}

/**
 * THE RULE. Given the current VERSION and everything we know about claims,
 * decide what to recommend — or refuse to.
 */
export function recommendSlot({ current, claims, claimsState }) {
  if (!current) {
    return {
      ok: false,
      slot: null,
      reason: "this repo has no well-formed VERSION file, so there is no slot sequence to advance",
    };
  }
  if (claimsState === UNKNOWN) {
    return {
      ok: false,
      slot: null,
      reason:
        "the open-PR queue could not be read, so a free-looking slot cannot be distinguished from an unread one",
    };
  }
  const taken = new Set(claims.map((c) => c.version).filter(Boolean));
  let candidate = nextPatch(current);
  // Walk forward past anything already spoken for.
  const guard = 1000;
  let i = 0;
  while (candidate && taken.has(candidate) && i++ < guard) candidate = nextPatch(candidate);
  return {
    ok: true,
    slot: candidate,
    reason: taken.size
      ? `${taken.size} slot(s) already claimed: ${[...taken].sort(compareVersions).join(", ")}`
      : "no open PR claims a slot",
  };
}

/* ------------------------------------------------------------------ *
 * Reading the world. Each returns { state, items, why }.
 * ------------------------------------------------------------------ */

/**
 * Run a command without handing its argv to a shell.
 *
 * `shell: true` on Windows concatenates argv instead of escaping it (Node warns
 * about this as DEP0190), so anything user-controlled in an argument becomes
 * executable. Every argument this file passes is a fixed literal — `--dir`
 * arrives as `cwd`, never as argv — but "it happens to be safe today" is how
 * that class of bug gets introduced tomorrow, so the shell is simply not used.
 *
 * The fallback exists because npm-installed CLIs on Windows are `.cmd` shims
 * that cannot be spawned directly. It retries through the shell ONLY on ENOENT,
 * and only with the same fixed literals.
 */
function sh(cmd, args, cwd) {
  const opts = { cwd, encoding: "utf8", windowsHide: true, timeout: 20000 };
  try {
    let r = spawnSync(cmd, args, { ...opts, shell: false });
    if (r.error && r.error.code === "ENOENT" && IS_WINDOWS) {
      r = spawnSync(cmd, args, { ...opts, shell: true });
    }
    return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), failed: r.error != null };
  } catch (e) {
    return { code: null, out: "", err: String(e.message), failed: true };
  }
}

export function readVersionFile(dir) {
  const p = path.join(dir, "VERSION");
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    return { path: p, raw, valid: VERSION_RE.test(raw) };
  } catch {
    return { path: p, raw: null, valid: false };
  }
}

export function isGitRepo(dir) {
  const r = sh("git", ["rev-parse", "--is-inside-work-tree"], dir);
  return r.code === 0 && /true/.test(r.out);
}

/** Open PRs and the slots they claim. Three-state on purpose. */
export function readOpenPRs(dir) {
  const has = sh("gh", ["--version"], dir);
  if (has.code !== 0) {
    return { state: UNKNOWN, items: [], why: "gh CLI is not installed or not runnable, so open PRs could not be listed" };
  }
  const auth = sh("gh", ["auth", "status"], dir);
  if (auth.code !== 0) {
    return { state: UNKNOWN, items: [], why: "gh is installed but not authenticated (`gh auth login`), so open PRs could not be listed" };
  }
  const r = sh("gh", ["pr", "list", "--state", "open", "--json", "number,title,headRefName,author,isDraft", "--limit", "100"], dir);
  if (r.code !== 0) {
    return { state: UNKNOWN, items: [], why: `\`gh pr list\` failed: ${(r.err || "no stderr").slice(0, 200)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.out || "[]");
  } catch {
    return { state: UNKNOWN, items: [], why: "gh returned output that is not JSON" };
  }
  const items = parsed.map((p) => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    author: p.author?.login || "?",
    draft: !!p.isDraft,
    version: versionIn(p.headRefName) || versionIn(p.title),
  }));
  return { state: items.length ? KNOWN_CLAIMED : KNOWN_EMPTY, items, why: null };
}

/** Local branches that look like they are holding a slot. */
export function readLocalBranches(dir) {
  if (!isGitRepo(dir)) return { state: UNKNOWN, items: [], why: "not a git work tree" };
  const r = sh("git", ["branch", "--format=%(refname:short)"], dir);
  if (r.code !== 0) return { state: UNKNOWN, items: [], why: `git branch failed: ${r.err.slice(0, 120)}` };
  const items = r.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => ({ branch: b, version: versionIn(b) }))
    .filter((b) => b.version);
  return { state: items.length ? KNOWN_CLAIMED : KNOWN_EMPTY, items, why: null };
}

/**
 * Sibling worktrees / workspaces with work in flight.
 * gstack reads Conductor workspaces here; the portable equivalent that does not
 * assume one editor is `git worktree list`, which is the same fact without the
 * dependency.
 */
export function readWorktrees(dir) {
  if (!isGitRepo(dir)) return { state: UNKNOWN, items: [], why: "not a git work tree" };
  const r = sh("git", ["worktree", "list", "--porcelain"], dir);
  if (r.code !== 0) return { state: UNKNOWN, items: [], why: `git worktree failed: ${r.err.slice(0, 120)}` };
  const items = [];
  let cur = {};
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) items.push(cur);
      cur = { path: line.slice(9).trim() };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      cur.version = versionIn(cur.branch);
    }
  }
  if (cur.path) items.push(cur);
  return { state: items.length ? KNOWN_CLAIMED : KNOWN_EMPTY, items, why: null };
}

/* ------------------------------------------------------------------ *
 * Report.
 * ------------------------------------------------------------------ */

const bold = (s) => `[1m${s}[22m`;
const dim = (s) => `[2m${s}[22m`;
const red = (s) => `[31m${s}[39m`;
const yellow = (s) => `[33m${s}[39m`;

export function buildReport(dir) {
  const version = readVersionFile(dir);
  const prs = readOpenPRs(dir);
  const branches = readLocalBranches(dir);
  const worktrees = readWorktrees(dir);

  const claims = [
    ...prs.items.filter((i) => i.version).map((i) => ({ version: i.version, source: `PR #${i.number}`, who: i.author, what: i.title })),
    ...branches.items.map((i) => ({ version: i.version, source: "local branch", who: null, what: i.branch })),
    ...worktrees.items.filter((i) => i.version).map((i) => ({ version: i.version, source: "worktree", who: null, what: i.branch })),
  ];

  // The queue's authority is the PR list. Local branches are a hint; they
  // cannot tell you what a teammate is holding. So the recommendation's
  // knowledge state is the PR list's state, not the union's.
  const rec = recommendSlot({
    current: version.valid ? version.raw : null,
    claims,
    claimsState: prs.state,
  });

  return { dir, version, prs, branches, worktrees, claims, recommendation: rec };
}

export function renderReport(r) {
  const L = [];
  L.push("");
  L.push(`  ${bold("Landing report")}  ${dim(r.dir)}`);
  L.push(dim("  read only — this command changes nothing"));
  L.push("");

  L.push(`  ${bold("Current VERSION")}`);
  if (r.version.valid) L.push(`    ${r.version.raw}`);
  else if (r.version.raw != null) L.push(`    ${red(`"${r.version.raw}" is not a well-formed version`)}`);
  else L.push(`    ${dim("no VERSION file in this repo")}`);
  L.push("");

  L.push(`  ${bold("Open PRs")}`);
  if (r.prs.state === UNKNOWN) {
    L.push(`    ${red("UNKNOWN")} — ${r.prs.why}`);
    L.push(dim("    This is not the same as \"no PRs are open\", and is not treated as such below."));
  } else if (r.prs.state === KNOWN_EMPTY) {
    L.push(`    ${dim("none open")}`);
  } else {
    for (const p of r.prs.items) {
      const slot = p.version ? p.version : dim("no slot");
      L.push(`    #${String(p.number).padEnd(5)} ${slot.padEnd(12)} ${p.draft ? dim("[draft] ") : ""}${p.title.slice(0, 60)}  ${dim("@" + p.author)}`);
    }
  }
  L.push("");

  for (const [title, src] of [["Local branches holding a slot", r.branches], ["Worktrees", r.worktrees]]) {
    L.push(`  ${bold(title)}`);
    if (src.state === UNKNOWN) L.push(`    ${yellow("UNKNOWN")} — ${src.why}`);
    else if (src.state === KNOWN_EMPTY) L.push(`    ${dim("none")}`);
    else for (const i of src.items) L.push(`    ${(i.version || dim("—")).padEnd(12)} ${i.branch || i.path}`);
    L.push("");
  }

  L.push(`  ${bold("Next slot")}`);
  if (r.recommendation.ok) {
    L.push(`    ${bold(r.recommendation.slot)}  ${dim("— what /ship would take next")}`);
    L.push(dim(`    ${r.recommendation.reason}`));
  } else {
    L.push(`    ${red("CANNOT RECOMMEND A SLOT")}`);
    L.push(dim(`    ${r.recommendation.reason}`));
  }
  L.push("");
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Selftest.
 * ------------------------------------------------------------------ */

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") => {
    const pass = JSON.stringify(expected) === JSON.stringify(got);
    results.push({ name, pass, expected: JSON.stringify(expected), got: JSON.stringify(got), detail });
  };

  // --- version arithmetic
  check("a three-part version parses", [1, 2, 3], parseVersion("1.2.3"));
  check("a four-part version parses (gstack uses four)", [1, 60, 1, 0], parseVersion("1.60.1.0"));
  check("a v-prefix is not a version", null, parseVersion("v1.2.3"));
  check("two parts is not a version", null, parseVersion("1.2"));
  check("empty is not a version", null, parseVersion(""));
  check("next patch of 0.2.0", "0.2.1", nextPatch("0.2.0"));
  check("next patch keeps four-part arity", "1.60.1.1", nextPatch("1.60.1.0"));
  check("next patch of garbage is null", null, nextPatch("nope"));
  check("0.2.0 sorts before 0.10.0 (numeric, not lexical)", true, compareVersions("0.2.0", "0.10.0") < 0);
  check("equal versions compare equal", 0, compareVersions("1.0.0", "1.0.0"));
  check("1.0.0 sorts before 1.0.0.1", true, compareVersions("1.0.0", "1.0.0.1") < 0);

  // --- extraction is conservative
  check("a release branch claims its slot", "1.2.3", versionIn("release/1.2.3"));
  check("a version in a PR title is found", "0.4.0", versionIn("Ship 0.4.0 — memory decay"));
  check("a branch with two numbers does NOT claim a slot", null, versionIn("fix-issue-1.2"));
  check("a bare issue number does not claim a slot", null, versionIn("fix-1234"));
  check("a date does not claim a slot", null, versionIn("security/audit-2026-07-29"));

  // --- THE RULE
  const unknownRec = recommendSlot({ current: "0.2.0", claims: [], claimsState: UNKNOWN });
  check("an unreadable PR queue refuses to recommend", false, unknownRec.ok);
  check("...and returns no slot at all", null, unknownRec.slot);
  check("...and says why, naming the unread queue", true, /could not be read/.test(unknownRec.reason));

  const emptyRec = recommendSlot({ current: "0.2.0", claims: [], claimsState: KNOWN_EMPTY });
  check("a genuinely empty queue recommends the next patch", "0.2.1", emptyRec.slot);
  check("...and is ok", true, emptyRec.ok);

  const takenRec = recommendSlot({
    current: "0.2.0",
    claims: [{ version: "0.2.1" }, { version: "0.2.2" }],
    claimsState: KNOWN_CLAIMED,
  });
  check("a claimed slot is skipped", "0.2.3", takenRec.slot);
  check("...and the reason lists what was claimed", true, /0\.2\.1, 0\.2\.2/.test(takenRec.reason));

  check(
    "claims with no version do not block anything",
    "0.2.1",
    recommendSlot({ current: "0.2.0", claims: [{ version: null }], claimsState: KNOWN_CLAIMED }).slot
  );
  check(
    "a repo with no VERSION file refuses rather than guessing 0.0.1",
    false,
    recommendSlot({ current: null, claims: [], claimsState: KNOWN_EMPTY }).ok
  );

  // --- the distinction that the whole file is about
  check(
    "UNKNOWN and KNOWN_EMPTY produce DIFFERENT recommendations from identical claims",
    false,
    recommendSlot({ current: "0.2.0", claims: [], claimsState: UNKNOWN }).ok ===
      recommendSlot({ current: "0.2.0", claims: [], claimsState: KNOWN_EMPTY }).ok
  );

  // --- rendering the dangerous case
  const r = {
    dir: "/x",
    version: { raw: "0.2.0", valid: true },
    prs: { state: UNKNOWN, items: [], why: "gh CLI is not installed" },
    branches: { state: KNOWN_EMPTY, items: [] },
    worktrees: { state: KNOWN_EMPTY, items: [] },
    claims: [],
    recommendation: recommendSlot({ current: "0.2.0", claims: [], claimsState: UNKNOWN }),
  };
  const text = renderReport(r);
  check("an unreadable queue never renders as 'none open'", false, /none open/.test(text));
  check("...it renders as UNKNOWN", true, /UNKNOWN/.test(text));
  check("...and refuses a slot in the output", true, /CANNOT RECOMMEND A SLOT/.test(text));
  check("...and never prints a bare next-version number", false, /0\.2\.1/.test(text));
  check("the report states it mutates nothing", true, /changes nothing/.test(text));

  const width = Math.max(...results.map((x) => x.name.length));
  process.stdout.write(`\n  tb-landing selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const x of results) {
    process.stdout.write(`  ${x.pass ? "PASS" : "FAIL"}  ${x.name.padEnd(width)}  expected ${x.expected}, got ${x.got}\n`);
  }
  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  Failures:\n");
    for (const x of failed) process.stdout.write(`    - ${x.name}: expected ${x.expected}, got ${x.got}. ${x.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  A queue that could not be read is never reported as a queue that is empty.\n\n");
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = path.resolve(typeof args.dir === "string" ? args.dir : process.cwd());

  if (cmd === "selftest") {
    selftest();
  } else if (cmd === "report" || cmd === undefined) {
    const r = buildReport(dir);
    if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    else process.stdout.write(renderReport(r));
  } else if (cmd === "next") {
    const r = buildReport(dir);
    if (r.recommendation.ok) process.stdout.write(r.recommendation.slot + "\n");
    else {
      process.stderr.write(`cannot recommend a slot: ${r.recommendation.reason}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stdout.write("\n  usage: tb-landing.mjs report [--dir <repo>] [--json] | next | selftest\n\n");
    process.exitCode = 1;
  }
}
