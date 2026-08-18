#!/usr/bin/env node
/**
 * tb-eng-review.mjs: the mechanical parts of /plan-eng-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The review methodology this supports (eng-manager plan review;
 * the engineering preferences; the fifteen cognitive patterns; the scope gate;
 * Step 0's scope challenge, complexity check, search check, TODOS
 * cross-reference, completeness check and distribution check; the four review
 * sections Architecture / Code Quality / Tests / Performance; the test-coverage
 * diagram; the required outputs including "NOT in scope", "What already
 * exists", the failure-modes table and the worktree parallelization strategy;
 * the Completion Summary; the review log and the exit-plan-mode gate) comes
 * from `plan-eng-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * The review is a prompt and stays a prompt. What is code here is only the
 * places gstack's version asks the model to certify its own work, or asks a
 * POSIX shell for something Windows does not have. They all fail in the same
 * direction: the review reports itself finished having produced nothing, or
 * having produced claims nobody checked.
 *
 * 1. THE EXIT GATE IS A SELF-CHECK. gstack plan-eng-review/SKILL.md:1022-1049
 *    ends with "EXIT PLAN MODE GATE (BLOCKING)": five items the model verifies
 *    about its own output before calling ExitPlanMode, including "confirm the
 *    LAST `## ` heading in the file is `## GSTACK REVIEW REPORT`" and "confirm
 *    the report's FINAL non-whitespace line is the unresolved-decisions
 *    status". Nothing runs. The same file names the failure it cannot catch:
 *    "Self-deception failure mode to watch for: feeling 'done' after writing
 *    review prose into the plan body." The entity asked whether it is done is
 *    the entity that feels done.
 *
 * 2. NOBODY CHECKS THE REVIEW'S OWN CLAIMS. This is the delta that matters for
 *    an ENG review specifically, and it is the one thing this fork does that
 *    gstack's version has no equivalent of anywhere. An eng review's output is
 *    almost entirely claims about code that exists right now:
 *
 *      "N+1 in `app/models/order.rb:88`"
 *      "already covered by `spec/billing_spec.rb:214`"
 *      "Lane A: models/ → services/ (sequential); Lane B: cli/ (independent)"
 *      "Failure modes: 0 critical gaps flagged"
 *
 *    Every one of those is falsifiable offline, and gstack falsifies none of
 *    them. A citation to a file that was renamed last week, or to line 214 of a
 *    140-line spec, reads exactly like a citation that resolves — it is the
 *    most convincing sentence in the report and the cheapest one to invent.
 *    `lint` resolves every `file:line` claim against the working tree, checks
 *    that the Completion Summary's "0 critical gaps" is not contradicted by a
 *    `**critical gap**` flag in the body it summarises, checks the lane count
 *    it claims against the lanes actually labelled, and refuses to call two
 *    lanes parallel when they name the same module directory and no conflict is
 *    flagged — which is gstack's own rule 4 of the parallelization strategy,
 *    left to the model to apply to itself.
 *
 * 3. THE IMPLEMENTATION-TASKS ARTIFACT IS GATED ON jq, AND FAILS TO A LIE.
 *    gstack plan-eng-review/sections/review-sections.md:605-626 builds it with
 *    `jq -nc --arg ... >> "$TASKS_FILE"`. On Windows 11, 2026-08-14:
 *
 *      $ command -v jq || echo "JQ: ABSENT"
 *      JQ: ABSENT
 *
 *      $ jq -nc --arg id 'T1' '{id:$id}' >> "$TASKS_FILE"
 *      bash: jq: command not found
 *      $ echo "exists: $([ -f "$TASKS_FILE" ] && echo YES); bytes: $(wc -c < "$TASKS_FILE")"
 *      exists: YES; bytes: 0
 *
 *    The shell creates the redirect target before jq fails, so the artifact is
 *    not missing, it is EMPTY — and the same section defines what empty means:
 *    "an empty file means 'ran, no findings' — distinct from 'didn't run'". So
 *    on Windows every task the eng review surfaced is dropped, and the drop is
 *    indistinguishable from a review that genuinely found nothing.
 *
 * 4. THE REVIEW LOG IS WRITTEN BEFORE THE GATE. gstack's Review Log step runs
 *    `gstack-review-log '{"skill":"plan-eng-review", ... "status":"STATUS" ...}'`
 *    unconditionally, ahead of the exit gate, so a review that never produced a
 *    report still shows up in /ship's readiness dashboard as the completed eng
 *    review — and the eng review is the one /ship treats as REQUIRED.
 *
 * 5. THE TEST-FRAMEWORK DETECTOR IS zsh AND GLOBS. Its first line is
 *    `setopt +o nomatch` (a zsh builtin; bash prints "setopt: command not
 *    found"), and it detects with `ls jest.config.* vitest.config.* ... 2>/dev/null`,
 *    whose entire output on a no-match is nothing, with stderr swallowed —
 *    identical to "there is no test framework here". `context` reports the two
 *    states separately.
 *
 * Design rules, same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. No path returns "fine" because a check could not run. A
 *     citation root that cannot be read is exit 2, never "citations look fine".
 *   - NO INTERPRETER BUT NODE. No jq, no zsh `setopt`, no `ls -t <glob> | head`,
 *     no `eval "$(...)"`, no `source <(...)`, no `find -mmin`, no `/tmp`, no
 *     `date +%s`, no `$PPID`. Every one of those is in the gstack version of
 *     this skill and none of them are Windows-safe.
 *   - PROVE IT. `selftest` runs this executable as a child process against
 *     deliberately broken plans and exits non-zero if any is accepted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(SELF, "..", "..");
const VERSION = "0.1.0";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // the check ran and passed
const EXIT_REJECTED = 1; // the check ran and FAILED
const EXIT_UNUSABLE = 2; // the input could not be read

// --------------------------------------------------------------------- paths

const isWindows = process.platform === "win32";

function expand(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

// ----------------------------------------------------------------- git facts

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) {
    return { ok: false, error: (res.stderr || res.error?.message || `git ${args[0]} exited ${res.status}`).split("\n")[0].trim() };
  }
  return { ok: true, text: res.stdout.trim() };
}

function sanitizeSlug(s) {
  const cleaned = String(s).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function repoSlug(repo) {
  const remote = git(repo, ["remote", "get-url", "origin"]);
  if (remote.ok && remote.text) {
    const base = remote.text.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
    if (base) return { ok: true, slug: sanitizeSlug(base), source: "origin remote" };
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (top.ok && top.text) return { ok: true, slug: sanitizeSlug(path.basename(top.text)), source: "repository directory name" };
  const abs = expand(repo) ?? process.cwd();
  return { ok: true, slug: sanitizeSlug(path.basename(abs)), source: "working directory name (not a git repository)" };
}

function currentBranch(repo) {
  const b = git(repo, ["branch", "--show-current"]);
  if (b.ok && b.text) return { ok: true, branch: b.text, safe: b.text.replace(/\//g, "-") };
  const d = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (d.ok && d.text) return { ok: true, branch: d.text, safe: d.text.replace(/\//g, "-") };
  return { ok: false, error: b.error ?? "no branch" };
}

function baseBranch(repo) {
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.text) return head.text.replace(/^origin\//, "");
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", ref]).ok) return ref.replace(/^origin\//, "");
  }
  return null;
}

/**
 * gstack's Step 0 complexity check: "If the plan touches more than 8 files or
 * introduces more than 2 new classes/services, treat that as a smell." The file
 * count is eyeballed from the plan's prose. Here it is counted against the
 * resolved base branch, and when git cannot answer it says so instead of
 * producing a number the review will then act on.
 */
function complexitySignal(repo) {
  const base = baseBranch(repo);
  if (!base) return { files: null, why: "no base branch could be resolved, so the diff size is unknown", base: null };
  let changed = git(repo, ["diff", "--name-only", `${base}...HEAD`]);
  if (!changed.ok) changed = git(repo, ["diff", "--name-only", base]);
  if (!changed.ok) return { files: null, why: `git diff against ${base} failed (${changed.error})`, base };
  const files = changed.text.split(/\r?\n/).filter(Boolean);
  return {
    files: files.length,
    base,
    why: files.length > 8
      ? `${files.length} file(s) vs ${base} — over gstack's 8-file smell threshold, so Step 0's complexity gate TRIGGERS`
      : `${files.length} file(s) vs ${base} — under the 8-file smell threshold`,
    triggers: files.length > 8,
  };
}

// ------------------------------------------------------- test framework scan
//
// gstack's detector (sections/review-sections.md:148-159) opens with a zsh
// builtin and then asks `ls` about globs with stderr redirected to /dev/null.
// No match and no permission to look produce the same empty output, and the
// skill's next instruction branches on it: "If no framework detected: still
// produce the coverage diagram, but skip test generation."

const FRAMEWORK_FILES = [
  [/^jest\.config\./i, "jest"],
  [/^vitest\.config\./i, "vitest"],
  [/^playwright\.config\./i, "playwright"],
  [/^cypress\.config\./i, "cypress"],
  [/^\.rspec$/i, "rspec"],
  [/^pytest\.ini$/i, "pytest"],
  [/^phpunit\.xml/i, "phpunit"],
  [/^karma\.conf\./i, "karma"],
  [/^\.mocharc\./i, "mocha"],
];

const RUNTIME_FILES = [
  ["Gemfile", "ruby"],
  ["package.json", "node"],
  ["requirements.txt", "python"],
  ["pyproject.toml", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
];

const TEST_DIRS = ["test", "tests", "spec", "__tests__", "cypress", "e2e"];

function detectTestSetup(repo) {
  let names;
  try {
    names = fs.readdirSync(repo);
  } catch (e) {
    return { state: "unreadable", error: `${repo} could not be listed (${e.code || e.message})` };
  }
  const set = new Set(names);
  const runtimes = RUNTIME_FILES.filter(([f]) => set.has(f)).map(([, r]) => r);
  const frameworks = [];
  for (const n of names) {
    for (const [re, label] of FRAMEWORK_FILES) if (re.test(n) && !frameworks.includes(label)) frameworks.push(label);
  }
  const dirs = TEST_DIRS.filter((d) => {
    try {
      return fs.statSync(path.join(repo, d)).isDirectory();
    } catch {
      return false;
    }
  });
  return { state: "read", runtimes: [...new Set(runtimes)], frameworks, testDirs: dirs };
}

// -------------------------------------------------------------- plan reading

function readPlan(file) {
  const abs = expand(file);
  if (!abs) return { ok: false, error: "no plan file given (--plan <file>)" };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    return { ok: false, error: `plan file ${abs} could not be opened (${e.code || e.message})` };
  }
  if (!stat.isFile()) return { ok: false, error: `${abs} is not a file` };
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { ok: false, error: `plan file ${abs} could not be read (${e.code || e.message})` };
  }
  if (!text.trim()) return { ok: false, error: `plan file ${abs} is empty, so there is nothing to gate` };
  return { ok: true, path: abs, text };
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// -------------------------------------------------------- claim verification
//
// THE PART GSTACK HAS NO EQUIVALENT OF. Everything below reads a claim the
// review made and checks it against something that is not the review.

/** `path/to/file.ext:42` — a claim that this line exists in the tree today. */
const CITED_LINE = /(?:^|[\s`("'[])([A-Za-z0-9_./\\+-]+\.[A-Za-z0-9]{1,10}):(\d+)/g;

function citations(text) {
  const found = [];
  const re = new RegExp(CITED_LINE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const file = m[1];
    // A URL carries a scheme; a version reads as 1.2:3 with no separator.
    if (/^https?$/i.test(file)) continue;
    if (!/[/\\]/.test(file) && !/\.[A-Za-z]{1,10}$/.test(file)) continue;
    found.push({ file, line: Number(m[2]) });
  }
  return found;
}

/**
 * Resolve every cited line against the working tree.
 *
 * A citation is the single most persuasive sentence an eng review produces and
 * the cheapest one to invent, because nothing downstream opens the file. This
 * refuses to report "checked" when the root itself could not be read.
 */
function checkCitations(text, root) {
  let st;
  try {
    st = fs.statSync(root);
  } catch (e) {
    return { ok: false, unusable: `citation root ${root} could not be opened (${e.code || e.message})` };
  }
  if (!st.isDirectory()) return { ok: false, unusable: `citation root ${root} is not a directory` };

  const cites = citations(text);
  const problems = [];
  for (const c of cites) {
    const abs = path.resolve(root, c.file.replace(/[\\/]+/g, path.sep));
    let s = null;
    try {
      s = fs.statSync(abs);
    } catch {
      s = null;
    }
    if (!s || !s.isFile()) {
      problems.push(`cites ${c.file}:${c.line}, but no such file exists under ${root}`);
      continue;
    }
    let count = 0;
    try {
      count = fs.readFileSync(abs, "utf8").split(/\r?\n/).length;
    } catch (e) {
      problems.push(`cites ${c.file}:${c.line}, but that file could not be read (${e.code || e.message})`);
      continue;
    }
    if (c.line > count) problems.push(`cites ${c.file}:${c.line}, but that file has only ${count} line(s)`);
  }
  return { ok: problems.length === 0, checked: cites.length, problems };
}

/**
 * gstack: "If any failure mode has no test AND no error handling AND would be
 * silent, flag it as a **critical gap**", and the Completion Summary then says
 * "Failure modes: ___ critical gaps flagged". The summary is written by the
 * same pass that decided how many there were, from memory, at the end of a long
 * review. This compares the number against the flags in the body.
 */
function criticalGapClaim(text) {
  const claim = /failure modes?\s*:?[^\n]*?(\d+)\s*critical gaps?/i.exec(text)
    ?? /(\d+)\s*critical gaps?\s*(?:flagged|found|identified)/i.exec(text);
  const flags = [...text.matchAll(/\*\*\s*critical gaps?\s*\*\*/gi)].length;
  if (!claim) return { state: "no-claim", flags };
  return { state: "claimed", claimed: Number(claim[1]), flags, line: truncate(claim[0], 70) };
}

/**
 * gstack's worktree parallelization strategy, rule 4: "if two parallel lanes
 * touch the same module directory, flag it". Asked of the model, about lanes
 * the model just wrote. The lanes are labelled and the modules are written as
 * directories, so both halves of that rule are computable.
 */
const LANE_RE = /^\s*(?:[-*+]\s*)?(?:\*\*)?Lane\s+([A-Za-z0-9]+)\b\s*:?(.*)$/gim;
const MODULE_RE = /(?:^|[\s`("'[|])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/)/g;

function parallelClaim(text) {
  const lanes = new Map();
  let m;
  const re = new RegExp(LANE_RE.source, "gim");
  while ((m = re.exec(text)) !== null) {
    const label = m[1].toUpperCase();
    const mods = new Set();
    let mm;
    const mre = new RegExp(MODULE_RE.source, "g");
    while ((mm = mre.exec(m[2] ?? "")) !== null) mods.add(mm[1]);
    if (!lanes.has(label)) lanes.set(label, new Set());
    for (const x of mods) lanes.get(label).add(x);
  }
  const sequential = /sequential implementation,\s*no parallelization opportunity/i.test(text);
  const claim = /parallelization\s*:?[^\n]*?(\d+)\s*lanes?/i.exec(text);
  const conflictFlagged = /conflict/i.test(text);

  const collisions = [];
  const labels = [...lanes.keys()];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      for (const mod of lanes.get(labels[i])) {
        if (lanes.get(labels[j]).has(mod)) collisions.push({ a: labels[i], b: labels[j], mod });
      }
    }
  }
  return { lanes, labels, sequential, claimed: claim ? Number(claim[1]) : null, conflictFlagged, collisions };
}

/**
 * The test-coverage diagram. gstack's Priority Hierarchy: "Step 0 > Test
 * diagram > Opinionated recommendations > Everything else. Never skip Step 0 or
 * the test diagram." A prose paragraph describing the branches satisfies every
 * self-check and is not a diagram.
 */
const DIAGRAM_GLYPH = /(-->|->|→|│|├|└|┌|┐|\+--|\|--|\\_)/;

function hasDiagram(text) {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((b) => b[1]);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length >= 3 && lines.some((l) => DIAGRAM_GLYPH.test(l))) return { pass: true, detail: `${lines.length}-line diagram block` };
  }
  // An unfenced ASCII diagram still counts if three consecutive lines carry
  // branch glyphs — plenty of plans indent them instead of fencing them.
  const lines = text.split(/\r?\n/);
  let run = 0;
  for (const l of lines) {
    run = DIAGRAM_GLYPH.test(l) ? run + 1 : 0;
    if (run >= 3) return { pass: true, detail: "unfenced ASCII diagram (3+ consecutive branch lines)" };
  }
  return { pass: false, detail: "no fenced or unfenced diagram with branch/arrow glyphs anywhere in the plan" };
}

// ---------------------------------------------------------------------- gate

const REPORT_HEADING = /^##\s+(TOOLBAY|GSTACK)\s+REVIEW REPORT\s*$/im;

function headings(text) {
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ line: l, i }))
    .filter((h) => /^##\s+\S/.test(h.line) && !/^###/.test(h.line));
}

function reportSection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (REPORT_HEADING.test(lines[i])) start = i;
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start, end).join("\n") };
}

function lastNonBlankLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].trim()) return { text: lines[i].trim(), index: i };
  return null;
}

/**
 * gstack gate item 4, the fiddliest rule in the skill: "the exact unbolded
 * NO UNRESOLVED DECISIONS (a bolded one does NOT count), or a bullet of a final
 * **UNRESOLVED DECISIONS:** block ... a bolded sentinel, any trailing prose, or
 * a missing status each FAILS the gate." Asking a model whether it accidentally
 * bolded its own sentinel is asking the wrong entity.
 */
function unresolvedStatus(text) {
  const last = lastNonBlankLine(text);
  if (!last) return { pass: false, detail: "the plan file has no content" };
  if (last.text === "NO UNRESOLVED DECISIONS") return { pass: true, detail: "sentinel present, unbolded" };
  if (/^\*+\s*NO UNRESOLVED DECISIONS\s*\*+$/.test(last.text)) {
    return { pass: false, detail: `the final line is "${last.text}" — a BOLDED sentinel, which gstack's own rule says does not count` };
  }
  if (/^[-*+]\s+\S/.test(last.text)) {
    const before = text.split(/\r?\n/).slice(0, last.index);
    if (before.some((l) => /\*\*UNRESOLVED DECISIONS:?\*\*/i.test(l))) {
      return { pass: true, detail: "final line is the last bullet of an UNRESOLVED DECISIONS block" };
    }
    return { pass: false, detail: "the final line is a bullet but no **UNRESOLVED DECISIONS:** header precedes it" };
  }
  return { pass: false, detail: `the final non-whitespace line is "${truncate(last.text, 70)}", which is neither the sentinel nor an unresolved-decisions bullet` };
}

function hasFindingsTable(body) {
  const rows = body.split(/\r?\n/).filter((l) => /^\s*\|/.test(l));
  const header = rows.find((l) => /runs/i.test(l) && /status/i.test(l) && /findings/i.test(l));
  if (!header) return { pass: false, detail: "no table header carrying Runs / Status / Findings" };
  const dataRows = rows
    .filter((l) => l !== header)
    .filter((l) => !/^\s*\|[\s|:-]*\|?\s*$/.test(l))
    .filter((l) => l.split("|").slice(1, -1).some((c) => c.trim() && !/^(—|-{1,2}|–|_+|TBD|N\/A)$/.test(c.trim())));
  if (!dataRows.length) return { pass: false, detail: "the Runs / Status / Findings table has a header but no filled row" };
  return { pass: true, detail: `${dataRows.length} filled row(s)` };
}

/** gstack's Completion Summary ships with `___` in every value. Emitted verbatim it looks finished and says nothing. */
function unfilledSummary(text) {
  const idx = text.search(/COMPLETION SUMMARY/i);
  if (idx === -1) return { present: false, blanks: [] };
  const body = text.slice(idx);
  const blanks = body
    .split(/\r?\n/)
    .filter((l) => /_{3,}/.test(l) || /\|\s*(—|–)\s*\|/.test(l))
    .map((l) => truncate(l, 70));
  return { present: true, blanks };
}

function checks(plan, { root = null } = {}) {
  const text = plan.text;
  const section = reportSection(text);
  const R = [];
  const add = (id, label, pass, detail = "") => R.push({ id, label, pass: Boolean(pass), detail });

  // ---- gstack gate items 1 & 2
  add("report.present", "the plan file contains a review report section", Boolean(section),
    section ? `at line ${section.start + 1}` : "no `## TOOLBAY REVIEW REPORT` (or `## GSTACK REVIEW REPORT`) heading anywhere in the file");

  if (section) {
    const hs = headings(text);
    const lastHeading = hs[hs.length - 1];
    const isLast = lastHeading && lastHeading.i === section.start;
    add("report.is-last-section", "the review report is the LAST ## heading in the file", isLast,
      isLast ? "" : `the last ## heading is "${truncate(lastHeading?.line ?? "(none)", 60)}" at line ${(lastHeading?.i ?? 0) + 1}`);
    const table = hasFindingsTable(section.body);
    add("report.findings-table", "the report carries a filled Runs / Status / Findings table", table.pass, table.detail);
    const verdict = /\*\*VERDICT:?\*\*|^VERDICT:/im.test(section.body);
    add("report.verdict", "the report carries a VERDICT line", verdict, verdict ? "" : "no VERDICT line in the report section");
  } else {
    add("report.is-last-section", "the review report is the LAST ## heading in the file", false, "there is no report to place");
    add("report.findings-table", "the report carries a filled Runs / Status / Findings table", false, "there is no report");
    add("report.verdict", "the report carries a VERDICT line", false, "there is no report");
  }

  // ---- gstack gate item 4
  const status = unresolvedStatus(text);
  add("report.unresolved-status", "the FINAL non-whitespace line is the unresolved-decisions status", status.pass, status.detail);

  // ---- required outputs (gstack's "Required outputs" + Priority Hierarchy)
  add("output.not-in-scope", '"NOT in scope" section is written', /not\s+in\s+scope/i.test(text),
    "deferred work has to be written down, with a one-line rationale each");
  add("output.already-exists", '"What already exists" section is written', /what\s+already\s+exists/i.test(text));
  // A heading, not the phrase. The Completion Summary says "Failure modes: N
  // critical gaps flagged" whether or not the section it summarises exists, so a
  // bare substring test passes on a review that deleted the output and kept the
  // line that counts it.
  add("output.failure-modes", "the failure-modes output is written as its own section",
    /^#{2,4}\s+.*failure\s*modes?/im.test(text),
    "gstack requires one realistic production failure per new codepath, with test / rescue / user-visible columns");

  // ---- Priority Hierarchy: "Never skip Step 0 or the test diagram."
  const diagram = hasDiagram(text);
  add("output.test-diagram", "a test-coverage diagram is actually in the plan", diagram.pass, diagram.detail);

  // ---- the pasted-template failure
  const summary = unfilledSummary(text);
  add("summary.filled", "the Completion Summary has no unfilled ___ blanks left in it", summary.blanks.length === 0,
    summary.present
      ? summary.blanks.length ? `${summary.blanks.length} unfilled line(s), first: ${summary.blanks[0]}` : "filled"
      : "no Completion Summary block found, so nothing to check here");

  // ---- claim checks: the review's own numbers, against its own body
  const gaps = criticalGapClaim(text);
  if (gaps.state === "no-claim") {
    add("claim.critical-gaps", "the critical-gap count is consistent with the flags in the body", true,
      "no critical-gap count claimed, so there is nothing to contradict");
  } else {
    const consistent = (gaps.claimed === 0 && gaps.flags === 0) || (gaps.claimed > 0 && gaps.flags > 0);
    add("claim.critical-gaps", "the critical-gap count is consistent with the flags in the body", consistent,
      consistent
        ? `claims ${gaps.claimed}, body carries ${gaps.flags} **critical gap** flag(s)`
        : gaps.claimed === 0
          ? `the summary says 0 critical gaps but the body flags ${gaps.flags} of them ("${gaps.line}")`
          : `the summary claims ${gaps.claimed} critical gap(s) but the body flags none — nothing downstream can act on a count with no flag`);
  }

  const par = parallelClaim(text);
  if (par.sequential && !par.labels.length) {
    add("claim.parallel-lanes", "the parallelization claim matches the lanes actually written", par.claimed === null || par.claimed <= 1,
      par.claimed === null || par.claimed <= 1
        ? "declared sequential, no lanes, consistent"
        : `declared "sequential implementation, no parallelization opportunity" while also claiming ${par.claimed} lanes`);
  } else if (!par.labels.length && par.claimed === null) {
    add("claim.parallel-lanes", "the parallelization claim matches the lanes actually written", false,
      'no lanes, no lane count, and no "Sequential implementation, no parallelization opportunity." — the worktree parallelization strategy is a required output and one of those two shapes has to be on the page');
  } else {
    const countOk = par.claimed === null || par.claimed === par.labels.length;
    const collisionOk = par.collisions.length === 0 || par.conflictFlagged;
    add("claim.parallel-lanes", "the parallelization claim matches the lanes actually written", countOk && collisionOk,
      !countOk
        ? `the summary claims ${par.claimed} lane(s) but ${par.labels.length} lane(s) are labelled (${par.labels.join(", ") || "none"})`
        : !collisionOk
          ? `lanes ${par.collisions[0].a} and ${par.collisions[0].b} both touch ${par.collisions[0].mod} and nothing in the plan flags a conflict — that is gstack's own rule 4, applied to the lanes as written`
          : `${par.labels.length} lane(s), ${par.collisions.length} shared-module collision(s)${par.collisions.length ? ", flagged" : ""}`);
  }

  // ---- citations: only when a root is given, and never "fine" when unreadable
  if (root) {
    const c = checkCitations(text, root);
    if (c.unusable) {
      add("cite.resolves", "every file:line the review cites resolves in the working tree", false, `${c.unusable} — refusing to report citations as checked`);
    } else {
      add("cite.resolves", "every file:line the review cites resolves in the working tree", c.ok,
        c.ok ? `${c.checked} citation(s) resolved against ${root}` : c.problems.join("; "));
    }
  }

  return { results: R };
}

function cmdGate(args) {
  const json = args.includes("--json");
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else {
      err(`\n  UNUSABLE  ${plan.error}`);
      err("            The gate could not read the thing it is supposed to check, so it");
      err("            refuses rather than passing. Do not call ExitPlanMode.\n");
    }
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const rootArg = valueOf(args, "--root");
  const { results } = checks(plan, { root: rootArg ? expand(rootArg) : null });

  const tasksArg = valueOf(args, "--tasks");
  if (tasksArg) {
    const t = expand(tasksArg);
    const exists = Boolean(t) && fs.existsSync(t);
    results.push({
      id: "tasks.artifact",
      label: "the Implementation Tasks JSONL artifact exists on disk",
      pass: exists,
      detail: exists
        ? `${t} (${fs.statSync(t).size} bytes; empty is a valid "ran, no findings")`
        : `${t} was named but is not on disk. gstack's writer is jq-gated and jq is absent here; use \`task --file ... --none\` if the review genuinely produced no tasks.`,
    });
  }

  const failed = results.filter((r) => !r.pass);
  const code = failed.length ? EXIT_REJECTED : EXIT_OK;

  if (json) {
    out(JSON.stringify({
      verdict: code === EXIT_OK ? "GATE_PASSED" : "GATE_FAILED",
      exit: code,
      plan: plan.path,
      checked: results.map((r) => ({ id: r.id, label: r.label, pass: r.pass, detail: r.detail })),
      failed: failed.map((r) => r.id),
    }, null, 2));
    process.exitCode = code;
    return;
  }

  out();
  out(`  ${plan.path}`);
  out();
  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) out(`  ${r.pass ? "ok " : "no "}  ${r.id.padEnd(width)}  ${r.label}`);
  out();
  if (code === EXIT_OK) {
    out(`  GATE PASSED  ${results.length}/${results.length} checks. The report exists, it is the last`);
    out("  section, it carries a filled table and a VERDICT, its final line is the");
    out("  unresolved-decisions status, the test diagram is really on the page, and the");
    out("  numbers it claims match the body it claims them about. ExitPlanMode is allowed.");
  } else {
    out(`  GATE FAILED  ${failed.length} of ${results.length} checks:`);
    for (const r of failed) {
      out(`    ${r.id}: ${r.label}`);
      if (r.detail) out(`      ${r.detail}`);
    }
    out();
    out("  Do NOT call ExitPlanMode. Do NOT write a review record. Fix these and run this");
    out("  again. Review prose in the plan body is not the report.");
  }
  out();
  process.exitCode = code;
}

// ---------------------------------------------------------------------- lint

function cmdLint(args) {
  const json = args.includes("--json");
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else err(`\n  UNUSABLE  ${plan.error}\n`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const problems = [];
  const notes = [];
  const text = plan.text;

  const cites = citations(text);
  const wantPaths = args.includes("--check-paths") || Boolean(valueOf(args, "--root"));
  if (wantPaths) {
    const root = expand(valueOf(args, "--root") ?? ".");
    const c = checkCitations(text, root);
    if (c.unusable) {
      if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: c.unusable }, null, 2));
      else {
        err(`\n  UNUSABLE  ${c.unusable}`);
        err("            A citation check that could not look is not a citation check that");
        err("            passed. Fix the root or drop --check-paths.\n");
      }
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
    problems.push(...c.problems);
    notes.push(`${c.checked} file:line citation(s) checked against ${root}, ${c.checked - c.problems.length} resolved`);
  } else if (cites.length) {
    notes.push(`${cites.length} file:line citation(s) present; re-run with --root <repo> to verify them`);
  }

  const diagram = hasDiagram(text);
  if (!diagram.pass) problems.push(`no test-coverage diagram in the plan (${diagram.detail})`);
  else notes.push(diagram.detail);

  const gaps = criticalGapClaim(text);
  if (gaps.state === "claimed" && gaps.claimed === 0 && gaps.flags > 0) {
    problems.push(`the summary says 0 critical gaps but the body flags ${gaps.flags}`);
  }
  if (gaps.state === "claimed" && gaps.claimed > 0 && gaps.flags === 0) {
    problems.push(`the summary claims ${gaps.claimed} critical gap(s) but no **critical gap** flag appears in the body`);
  }

  const par = parallelClaim(text);
  if (par.claimed !== null && par.labels.length && par.claimed !== par.labels.length) {
    problems.push(`the summary claims ${par.claimed} lane(s) but ${par.labels.length} are labelled`);
  }
  for (const col of par.collisions) {
    if (!par.conflictFlagged) problems.push(`lanes ${col.a} and ${col.b} both touch ${col.mod} with no conflict flagged`);
  }

  const ok = problems.length === 0;
  if (json) {
    out(JSON.stringify({ verdict: ok ? "CLAIMS_HOLD" : "CLAIMS_FAILED", exit: ok ? EXIT_OK : EXIT_REJECTED, plan: plan.path, problems, notes }, null, 2));
  } else {
    out();
    if (ok) out("  ok  every claim this review makes about the tree and about itself holds up");
    else {
      out(`  ${problems.length} unsupported claim(s):`);
      for (const p of problems) out(`    - ${p}`);
    }
    for (const n of notes) out(`  note  ${n}`);
    out();
  }
  if (!ok) process.exitCode = EXIT_REJECTED;
}

// ------------------------------------------------------------------- context

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function artifactsDirFor(slug) {
  const override = process.env.TOOLBAY_ENG_ARTIFACTS_DIR;
  if (override) return expand(override);
  // ~/.gstack/projects/<slug> on purpose: where gstack already writes and where
  // /autoplan's aggregator already looks, so a mixed install stays whole.
  return path.join(os.homedir(), ".gstack", "projects", slug);
}

function listArtifacts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return { state: "absent", names: [], note: `${dir} does not exist yet, so this project has no stored artifacts` };
    return { state: "unreadable", names: [], error: `${dir} exists but could not be listed (${e.code || e.message})` };
  }
  return { state: "read", names };
}

function newestMatching(dir, names, re) {
  const stamped = [];
  for (const n of names.filter((x) => re.test(x))) {
    const p = path.join(dir, n);
    try {
      stamped.push({ file: p, mtime: fs.statSync(p).mtimeMs });
    } catch {
      /* vanished between readdir and stat: not a candidate */
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped;
}

function cmdContext(args) {
  const json = args.includes("--json");
  const repo = expand(valueOf(args, "--repo") ?? ".");
  const planArg = valueOf(args, "--plan");

  const slugInfo = repoSlug(repo);
  const branchInfo = currentBranch(repo);
  const dir = expand(valueOf(args, "--dir") ?? artifactsDirFor(slugInfo.slug));

  const listing = listArtifacts(dir);
  if (listing.state === "unreadable") {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: listing.error }, null, 2));
    else {
      err(`\n  UNUSABLE  ${listing.error}`);
      err("            This is NOT 'no design doc'. Do not offer /office-hours or start the");
      err("            review from scratch on the strength of a lookup that failed.\n");
    }
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const branchSafe = branchInfo.ok ? branchInfo.safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  const designBranch = branchSafe ? newestMatching(dir, listing.names, new RegExp(`-${branchSafe}-design-.*\\.md$`)) : [];
  const designAny = newestMatching(dir, listing.names, /-design-.*\.md$/);

  let planPath = null;
  if (planArg) {
    const p = readPlan(planArg);
    if (!p.ok) {
      if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: p.error }, null, 2));
      else err(`\n  UNUSABLE  ${p.error}\n`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
    planPath = p.path;
  }

  const tests = detectTestSetup(repo);
  const complexity = complexitySignal(repo);
  const tasksFile = path.join(dir, `tasks-eng-review-${stamp()}.jsonl`);

  const payload = {
    verdict: "READY",
    exit: EXIT_OK,
    slug: slugInfo.slug,
    slugSource: slugInfo.source,
    branch: branchInfo.ok ? branchInfo.branch : null,
    artifactsDir: dir,
    artifactsState: listing.state,
    designDoc: (designBranch[0] ?? designAny[0])?.file ?? null,
    designDocScope: designBranch.length ? "this branch" : designAny.length ? "another branch" : null,
    plan: planPath,
    tests,
    complexity,
    tasksFile,
  };

  if (json) {
    out(JSON.stringify(payload, null, 2));
    return;
  }

  out();
  out(`  slug:      ${payload.slug}   (${slugInfo.source})`);
  out(`  branch:    ${payload.branch ?? `UNKNOWN (${branchInfo.error})`}`);
  out(`  artifacts: ${dir}   [${listing.state}]`);
  out();
  out(`  design doc: ${payload.designDoc ?? "none found"}${payload.designDocScope === "another branch" ? "   (from another branch)" : ""}`);
  out();
  if (tests.state === "unreadable") {
    out(`  test setup: UNREADABLE — ${tests.error}`);
    out("              That is not 'no test framework'. Say so rather than skipping test");
    out("              generation on the strength of a listing that failed.");
  } else {
    out(`  runtime:    ${tests.runtimes.join(", ") || "none detected"}`);
    out(`  frameworks: ${tests.frameworks.join(", ") || "none detected"}`);
    out(`  test dirs:  ${tests.testDirs.join(", ") || "none"}`);
    if (!tests.frameworks.length && !tests.testDirs.length) {
      out("              Verified empty: the directory WAS read and holds no test config or");
      out("              test directory. Produce the coverage diagram anyway.");
    }
  }
  out();
  if (complexity.files === null) out(`  complexity: UNDETERMINED — ${complexity.why}`);
  else out(`  complexity: ${complexity.why}`);
  out();
  out(`  write this review's tasks to: ${tasksFile}`);
  out();
}

// ---------------------------------------------------------------- task write

const PRIORITIES = new Set(["P1", "P2", "P3"]);
const REQUIRED_TASK_FIELDS = ["id", "priority", "component", "title", "source_finding"];

function fail(json, code, message) {
  if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: code, error: message }, null, 2));
  else err(`\n  UNUSABLE  ${message}\n`);
  process.exitCode = code;
}

function cmdTask(args) {
  const json = args.includes("--json");
  const file = expand(valueOf(args, "--file"));
  if (!file) {
    fail(json, EXIT_UNUSABLE, "--file <tasks-eng-review-*.jsonl> is required");
    return;
  }

  if (args.includes("--none")) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "", "utf8");
    } catch (e) {
      fail(json, EXIT_UNUSABLE, `could not create ${file} (${e.code || e.message})`);
      return;
    }
    if (json) out(JSON.stringify({ verdict: "EMPTY_ARTIFACT_WRITTEN", exit: EXIT_OK, file }, null, 2));
    else {
      out();
      out(`  wrote an EMPTY task artifact: ${file}`);
      out("  An empty file means 'this review ran and found nothing actionable'. A missing");
      out("  file means 'this review never ran'. The aggregator reads the difference.");
      out();
    }
    return;
  }

  const rec = {
    phase: "eng-review",
    run_id: valueOf(args, "--run-id") ?? stamp(),
    branch: valueOf(args, "--branch") ?? null,
    commit: valueOf(args, "--commit") ?? null,
    id: valueOf(args, "--id"),
    priority: valueOf(args, "--priority"),
    component: valueOf(args, "--component"),
    files: (valueOf(args, "--files") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    effort_human: valueOf(args, "--effort-human") ?? null,
    effort_cc: valueOf(args, "--effort-cc") ?? null,
    title: valueOf(args, "--title"),
    source_finding: valueOf(args, "--source-finding"),
  };

  const missing = REQUIRED_TASK_FIELDS.filter((f) => !rec[f] || !String(rec[f]).trim());
  if (missing.length) {
    fail(json, EXIT_UNUSABLE,
      `refusing to write a task record missing ${missing.join(", ")}. A half-filled task is not a task; ` +
      "it becomes a checkbox in the final gate that nobody can act on.");
    return;
  }
  if (!PRIORITIES.has(rec.priority)) {
    fail(json, EXIT_UNUSABLE, `--priority must be one of P1, P2, P3 (got "${rec.priority}")`);
    return;
  }

  const line = JSON.stringify(rec);
  try {
    JSON.parse(line);
  } catch (e) {
    fail(json, EXIT_UNUSABLE, `the record did not serialize to valid JSON (${e.message})`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch (e) {
    fail(json, EXIT_UNUSABLE, `could not append to ${file} (${e.code || e.message})`);
    return;
  }

  if (json) out(JSON.stringify({ verdict: "TASK_WRITTEN", exit: EXIT_OK, file, record: rec }, null, 2));
  else {
    out();
    out(`  ${rec.id} (${rec.priority}) -> ${file}`);
    out();
  }
}

// -------------------------------------------------------------------- record

function cmdRecord(args) {
  const json = args.includes("--json");
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else err(`\n  UNUSABLE  ${plan.error}\n`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const rootArg = valueOf(args, "--root");
  const { results } = checks(plan, { root: rootArg ? expand(rootArg) : null });
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    const msg = `refusing to write a review record: ${failed.length} gate check(s) failed (${failed.map((r) => r.id).join(", ")})`;
    if (json) out(JSON.stringify({ verdict: "REFUSED", exit: EXIT_REJECTED, error: msg, failed: failed.map((r) => r.id) }, null, 2));
    else {
      err(`\n  REFUSED  ${msg}`);
      err("           Nothing was written. gstack logs this record BEFORE its exit gate and");
      err("           unconditionally, so a review that never produced a report still shows");
      err("           up in /ship's readiness dashboard as the completed ENG review — the");
      err("           one /ship treats as required.\n");
    }
    process.exitCode = EXIT_REJECTED;
    return;
  }

  const repo = expand(valueOf(args, "--repo") ?? path.dirname(plan.path));
  const outFile = expand(valueOf(args, "--out") ?? path.join(stateDir(), "reviews.jsonl"));
  const b = currentBranch(repo);
  const c = git(repo, ["rev-parse", "--short", "HEAD"]);
  const rec = {
    skill: "plan-eng-review",
    timestamp: new Date().toISOString(),
    status: valueOf(args, "--status") ?? "clean",
    verified: true,
    verified_by: `tb-eng-review ${VERSION}`,
    checks_passed: results.map((r) => r.id),
    citations_checked: Boolean(rootArg),
    mode: valueOf(args, "--mode") ?? null,
    unresolved: Number(valueOf(args, "--unresolved") ?? 0),
    critical_gaps: Number(valueOf(args, "--critical-gaps") ?? 0),
    issues_found: Number(valueOf(args, "--issues-found") ?? 0),
    plan: plan.path,
    branch: b.ok ? b.branch : null,
    commit: c.ok ? c.text : null,
  };
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, `${JSON.stringify(rec)}\n`, "utf8");
  } catch (e) {
    fail(json, EXIT_UNUSABLE, `could not append to ${outFile} (${e.code || e.message})`);
    return;
  }
  if (json) out(JSON.stringify({ verdict: "RECORDED", exit: EXIT_OK, file: outFile, record: rec }, null, 2));
  else {
    out();
    out(`  RECORDED  ${outFile}`);
    out("  The record carries verified:true, whether the citations were resolved, and the");
    out("  ids of the checks that actually ran, so a downstream reader can tell a proven");
    out("  review from an asserted one.");
    out();
  }
}

// ------------------------------------------------------------------ selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** gstack's Implementation Tasks writer, verbatim except for the substituted values. */
const GSTACK_TASK_WRITER = String.raw`
jq -nc \
  --arg phase 'eng-review' \
  --arg run_id "$RUN_ID" \
  --arg branch "$BRANCH" \
  --arg commit "$COMMIT" \
  --arg id "$TASK_ID" \
  --arg priority "$PRIORITY" \
  --arg component "$COMPONENT" \
  --arg effort_human "$EFFORT_HUMAN" \
  --arg effort_cc "$EFFORT_CC" \
  --arg title "$TITLE" \
  --arg source_finding "$SOURCE_FINDING" \
  --argjson files "$FILES_JSON" \
  '{phase:$phase, run_id:$run_id, branch:$branch, commit:$commit, id:$id, priority:$priority, component:$component, files:$files, effort_human:$effort_human, effort_cc:$effort_cc, title:$title, source_finding:$source_finding}' \
  >> "$TASKS_FILE"
`;

/** gstack's test-framework detector, verbatim from sections/review-sections.md:148-159. */
const GSTACK_FRAMEWORK_DETECT = String.raw`
setopt +o nomatch 2>/dev/null || true  # zsh compat
[ -f Gemfile ] && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f requirements.txt ] || [ -f pyproject.toml ] && echo "RUNTIME:python"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
ls jest.config.* vitest.config.* playwright.config.* cypress.config.* .rspec pytest.ini phpunit.xml 2>/dev/null
ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
`;

const GOOD_PLAN = `# Plan: retry the webhook sender

## What already exists
\`src/hooks.ts:12\` already has a queue; the retry loop is the missing piece.

## NOT in scope
Rewriting the queue. Deferred to TODOS.md.

## Test coverage diagram

\`\`\`
  Sender#call ──> validate ──> enqueue ──> POST
        │             │            │         └─> 5xx ──> retry (NO TEST)
        │             └─> invalid ──> raise ValidationError
        └─> nil payload ──> early return
\`\`\`

## Failure modes
| Codepath | Failure | Test | Rescued | User sees |
|---|---|---|---|---|
| Sender#call | receiver 5xx | Y | Y | retry banner |

## Worktree parallelization strategy
Lane A: retry loop (src/hooks/) → backoff (src/hooks/)
Lane B: CLI reporting (cli/)

Launch A + B in parallel worktrees, then merge.

## COMPLETION SUMMARY
- Architecture Review: 2 issues found
- Test Review: diagram produced, 1 gaps identified
- Failure modes: 0 critical gaps flagged
- Parallelization: 2 lanes, 2 parallel / 0 sequential

## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | /plan-eng-review | Architecture & tests | 1 | CLEAR | 2 findings, 2 folded |

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-eng-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  const skip = (name, why) => results.push({ name, skip: true, detail: why });
  const write = (name, body) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    return p;
  };
  const gate = (p, extra = []) => runSelf(["gate", "--plan", p, "--json", ...extra]);
  const failedIds = (r) => JSON.parse(r.stdout || "{}").failed ?? [];

  const goodPlan = write("good.md", GOOD_PLAN);

  // ------------------------------------------------------------------- gate
  check("gate passes a plan that actually carries a finished eng review", 0, gate(goodPlan).status, gate(goodPlan).stdout.slice(0, 200));

  {
    const p = write("prose-only.md", GOOD_PLAN.replace(/## TOOLBAY REVIEW REPORT[\s\S]*$/, "The review went well; I found two issues and both are handled.\n"));
    const r = gate(p);
    check("gate REJECTS review prose in the body with no report section", 1, r.status);
    check("...naming report.present", true, failedIds(r).includes("report.present"));
  }
  {
    const r = gate(write("midfile.md", `${GOOD_PLAN}\n\n## Appendix\n\nnotes\n`));
    check("gate REJECTS a report that is present but not the last section", 1, r.status);
    check("...naming report.is-last-section", true, failedIds(r).includes("report.is-last-section"));
  }
  {
    const r = gate(write("empty-table.md", GOOD_PLAN.replace(/\| Eng Review \|.*\n/, "")));
    check("gate REJECTS a findings table with a header and no filled row", 1, r.status);
    check("...naming report.findings-table", true, failedIds(r).includes("report.findings-table"));
  }
  {
    const r = gate(write("dash-table.md", GOOD_PLAN.replace(/\| Eng Review \|.*\n/, "| — | — | — | — | — | — |\n")));
    check("gate REJECTS a findings table whose only row is em dashes", 1, r.status);
  }
  {
    const r = gate(write("no-verdict.md", GOOD_PLAN.replace(/\*\*VERDICT:\*\*.*\n/, "")));
    check("gate REJECTS a report with no VERDICT line", 1, r.status);
    check("...naming report.verdict", true, failedIds(r).includes("report.verdict"));
  }
  {
    const r = gate(write("bold-sentinel.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**")));
    check("gate REJECTS a BOLDED unresolved-decisions sentinel", 1, r.status);
    check("...naming report.unresolved-status", true, failedIds(r).includes("report.unresolved-status"));
  }
  {
    const r = gate(write("trailing.md", `${GOOD_PLAN}\n\nOne more thought: cache the receiver lookup.\n`));
    check("gate REJECTS trailing prose after the sentinel", 1, r.status);
  }
  {
    const p = write("unresolved-block.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**UNRESOLVED DECISIONS:**\n\n- whether to keep the admin page"));
    check("gate ACCEPTS a proper UNRESOLVED DECISIONS block", 0, gate(p).status);
  }
  for (const [name, cut, id] of [
    ['gate REJECTS a review with no "NOT in scope" section', /## NOT in scope[\s\S]*?(?=\n## )/, "output.not-in-scope"],
    ['gate REJECTS a review with no "What already exists" section', /## What already exists[\s\S]*?(?=\n## )/, "output.already-exists"],
    ["gate REJECTS a review with no failure-modes output", /## Failure modes[\s\S]*?(?=\n## )/, "output.failure-modes"],
  ]) {
    const r = gate(write(`${id}.md`, GOOD_PLAN.replace(cut, "")));
    check(name, 1, r.status);
    check(`...naming ${id}`, true, failedIds(r).includes(id));
  }
  {
    // The Priority Hierarchy calls the test diagram unskippable. Prose that
    // DESCRIBES the branches passes every self-check and is not a diagram.
    const p = write("prose-diagram.md", GOOD_PLAN.replace(/## Test coverage diagram[\s\S]*?(?=\n## )/,
      "## Test coverage diagram\n\nThe sender validates, enqueues, posts, and retries on 5xx; the nil payload path returns early.\n\n"));
    const r = gate(p);
    check("gate REJECTS a prose paragraph standing in for the test diagram", 1, r.status);
    check("...naming output.test-diagram", true, failedIds(r).includes("output.test-diagram"));
  }
  {
    const r = gate(write("blank-summary.md", GOOD_PLAN.replace("- Architecture Review: 2 issues found", "- Architecture Review: ___ issues found")));
    check("gate REJECTS a Completion Summary still holding its ___ blanks", 1, r.status);
    check("...naming summary.filled", true, failedIds(r).includes("summary.filled"));
  }

  // ------------------------------------- claim checks (no gstack equivalent)
  {
    // Body flags a critical gap; summary says zero. Both written by the same
    // pass, minutes apart. gstack checks neither against the other.
    const p = write("gap-contradiction.md", GOOD_PLAN.replace("| Sender#call | receiver 5xx | Y | Y | retry banner |",
      "| Sender#call | receiver 5xx | N | N | nothing — **critical gap** |"));
    const r = gate(p);
    check("gate REJECTS '0 critical gaps' contradicted by a flag in the body", 1, r.status);
    check("...naming claim.critical-gaps", true, failedIds(r).includes("claim.critical-gaps"));
  }
  {
    const p = write("gap-phantom.md", GOOD_PLAN.replace("Failure modes: 0 critical gaps flagged", "Failure modes: 3 critical gaps flagged"));
    const r = gate(p);
    check("gate REJECTS a critical-gap count with no flag anywhere in the body", 1, r.status);
    check("...naming claim.critical-gaps", true, failedIds(r).includes("claim.critical-gaps"));
  }
  {
    const p = write("lane-count.md", GOOD_PLAN.replace("Parallelization: 2 lanes", "Parallelization: 4 lanes"));
    const r = gate(p);
    check("gate REJECTS a lane count that does not match the lanes written", 1, r.status);
    check("...naming claim.parallel-lanes", true, failedIds(r).includes("claim.parallel-lanes"));
  }
  {
    // gstack's own rule 4, applied to the lanes as written: two parallel lanes
    // naming the same module directory with no conflict flagged.
    const p = write("lane-collision.md", GOOD_PLAN.replace("Lane B: CLI reporting (cli/)", "Lane B: reporting (src/hooks/)"));
    const r = gate(p);
    check("gate REJECTS two parallel lanes sharing a module with no conflict flagged", 1, r.status);
    check("...naming claim.parallel-lanes", true, failedIds(r).includes("claim.parallel-lanes"));
  }
  {
    const p = write("lane-collision-flagged.md",
      GOOD_PLAN.replace("Lane B: CLI reporting (cli/)", "Lane B: reporting (src/hooks/)")
        .replace("Launch A + B in parallel worktrees, then merge.", "Lanes A and B both touch src/hooks/ — merge conflict risk, run sequentially."));
    check("gate ACCEPTS the same collision once the conflict IS flagged", 0, gate(p).status, gate(p).stdout.slice(0, 160));
  }
  {
    const p = write("no-parallel-output.md", GOOD_PLAN
      .replace(/## Worktree parallelization strategy[\s\S]*?(?=\n## )/, "")
      .replace("- Parallelization: 2 lanes, 2 parallel / 0 sequential\n", ""));
    const r = gate(p);
    check("gate REJECTS a review that never produced the parallelization output", 1, r.status);
    check("...naming claim.parallel-lanes", true, failedIds(r).includes("claim.parallel-lanes"));
  }
  {
    const p = write("sequential.md", GOOD_PLAN
      .replace(/## Worktree parallelization strategy[\s\S]*?(?=\n## )/,
        "## Worktree parallelization strategy\n\nSequential implementation, no parallelization opportunity.\n\n")
      .replace("- Parallelization: 2 lanes, 2 parallel / 0 sequential", "- Parallelization: sequential"));
    check("gate ACCEPTS the explicit sequential escape hatch", 0, gate(p).status, gate(p).stdout.slice(0, 160));
  }

  // ------------------------------------------- citations against a real tree
  const projRoot = path.join(tmp, "proj");
  fs.mkdirSync(path.join(projRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projRoot, "src", "hooks.ts"), `${Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join("\n")}\n`, "utf8");
  {
    const r = runSelf(["lint", "--plan", goodPlan, "--root", projRoot, "--json"]);
    check("lint ACCEPTS a citation that resolves to a real line", 0, r.status, r.stdout.slice(0, 200));
  }
  {
    const p = write("cite-missing.md", GOOD_PLAN.replace("`src/hooks.ts:12`", "`src/renamed-last-week.ts:12`"));
    const r = runSelf(["lint", "--plan", p, "--root", projRoot, "--json"]);
    check("lint REJECTS a citation to a file that is not there", 1, r.status);
    check("...saying which citation", true, /renamed-last-week/.test(r.stdout));
  }
  {
    const p = write("cite-past-eof.md", GOOD_PLAN.replace("`src/hooks.ts:12`", "`src/hooks.ts:4120`"));
    const r = runSelf(["lint", "--plan", p, "--root", projRoot, "--json"]);
    check("lint REJECTS a citation past the end of a real file", 1, r.status);
    check("...naming the real line count", true, /only 41 line/.test(r.stdout));
  }
  {
    const p = write("cite-url.md", GOOD_PLAN.replace("`src/hooks.ts:12`", "see https://example.com:8080/docs and node 20.11:1"));
    const r = runSelf(["lint", "--plan", p, "--root", projRoot, "--json"]);
    check("lint does NOT mistake a URL or a version number for a citation", 0, r.status, r.stdout.slice(0, 200));
  }
  {
    // FAIL CLOSED: asked to check citations against a root it cannot read.
    const r = runSelf(["lint", "--plan", goodPlan, "--root", path.join(tmp, "no-such-root"), "--json"]);
    check("lint REFUSES when the citation root cannot be read (never 'looks fine')", 2, r.status);
  }
  {
    const r = runSelf(["lint", "--plan", goodPlan, "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("lint without --root passes but says the citations are UNCHECKED", 0, r.status);
    check("...in its notes", true, (j.notes ?? []).some((n) => /re-run with --root/.test(n)));
  }
  {
    const p = write("cite-in-gate.md", GOOD_PLAN.replace("`src/hooks.ts:12`", "`src/gone.ts:9`"));
    const r = gate(p, ["--root", projRoot]);
    check("gate --root REJECTS a plan whose citation does not resolve", 1, r.status);
    check("...naming cite.resolves", true, failedIds(r).includes("cite.resolves"));
  }
  {
    const r = gate(goodPlan, ["--root", path.join(tmp, "no-such-root")]);
    check("gate --root FAILS CLOSED when the tree cannot be read", 1, r.status);
    check("...naming cite.resolves", true, failedIds(r).includes("cite.resolves"));
  }

  // -------------------------------------------------------- fail closed I/O
  check("gate REFUSES a plan file that does not exist (never passes)", 2, gate(path.join(tmp, "nope.md")).status);
  check("gate REFUSES an empty plan file", 2, gate(write("empty.md", "   \n")).status);
  check("gate REFUSES a directory handed to it as a plan", 2, gate(tmp).status);

  // ----------------------------------------------------------------- record
  {
    const recFile = path.join(tmp, "refused.jsonl");
    const bad = write("bad-for-record.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**"));
    const r = runSelf(["record", "--plan", bad, "--out", recFile, "--json"]);
    check("record REFUSES to log a review whose gate fails", 1, r.status);
    check("...and writes no file at all", false, fs.existsSync(recFile));
  }
  {
    const recFile = path.join(tmp, "ok.jsonl");
    const r = runSelf(["record", "--plan", goodPlan, "--out", recFile, "--root", projRoot, "--json"]);
    check("record logs a review whose gate passes", 0, r.status, r.stderr.trim());
    const first = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8").trim().split("\n")[0]) : {};
    check("...carrying verified:true", true, first.verified === true);
    check("...and citations_checked, so an unproven review cannot pass as a proven one", true, first.citations_checked === true);
  }

  // ------------------------------------------------------------------ tasks
  const tasksFile = path.join(tmp, "artifacts", "tasks-eng-review-20260814-000000.jsonl");
  const nastyTitle = 'add "retry" to C:\\hooks\nand log it';
  {
    const r = runSelf(["task", "--file", tasksFile, "--id", "T1", "--priority", "P1", "--component", "webhooks",
      "--title", nastyTitle, "--source-finding", 'Test review said: "5xx retry has no test"',
      "--files", "src/hooks.ts,src/queue.ts", "--effort-human", "2h", "--effort-cc", "10m", "--json"]);
    check("task writes the Implementation Tasks artifact without jq", 0, r.status, r.stderr.trim());
    const line = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8").trim() : "";
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* stays null */ }
    check("...as one parseable JSON line", true, parsed !== null, line.slice(0, 80));
    check("...with quotes, backslashes and newlines in the title surviving intact", nastyTitle, parsed?.title ?? "(unparseable)");
  }
  {
    const jqPresent = spawnSync(isWindows ? "where" : "which", ["jq"], { encoding: "utf8", windowsHide: true }).status === 0;
    const bashOk = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
    if (!bashOk) skip("gstack's jq task writer on the same task", "bash is not available to run it");
    else if (jqPresent) skip("gstack's jq task writer on the same task", "jq IS installed here, so gstack's writer works too and there is no delta to show");
    else {
      const gstackFile = path.join(tmp, "gstack-tasks.jsonl");
      const script = path.join(tmp, "gstack-writer.sh");
      fs.writeFileSync(script, GSTACK_TASK_WRITER, "utf8");
      const res = spawnSync("bash", [script], {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env, TASKS_FILE: gstackFile, RUN_ID: "20260814-000000", BRANCH: "feature", COMMIT: "abc123",
          TASK_ID: "T1", PRIORITY: "P1", COMPONENT: "webhooks", EFFORT_HUMAN: "2h", EFFORT_CC: "10m",
          TITLE: nastyTitle, SOURCE_FINDING: "5xx retry has no test", FILES_JSON: '["src/hooks.ts"]',
        },
      });
      const bytes = fs.existsSync(gstackFile) ? fs.statSync(gstackFile).size : -1;
      const wrote = bytes > 0 && fs.readFileSync(gstackFile, "utf8").trim().length > 0;
      check('gstack\'s jq writer records NO task, leaving an artifact that reads as "ran, no findings"', false, wrote,
        `jq absent; the shell still created the file: exists=${bytes >= 0}, bytes=${bytes}. bash said: ${(res.stderr || "").trim().split("\n")[0] || "(nothing)"}`);
    }
    check("...while this one produced a real record for the same task", true, fs.existsSync(tasksFile));
  }
  {
    const emptyFile = path.join(tmp, "artifacts", "tasks-eng-review-empty.jsonl");
    const r = runSelf(["task", "--file", emptyFile, "--none", "--json"]);
    check('task --none writes an EMPTY artifact for "ran, found nothing"', 0, r.status);
    check("...which is zero bytes, a state reachable here only on purpose", 0, fs.existsSync(emptyFile) ? fs.statSync(emptyFile).size : -1);
  }
  check("task REFUSES a record missing its source finding rather than writing a half-task", 2,
    runSelf(["task", "--file", path.join(tmp, "bad.jsonl"), "--id", "T9", "--priority", "P1", "--component", "x", "--title", "y", "--json"]).status);
  check("task REFUSES an unknown priority", 2,
    runSelf(["task", "--file", path.join(tmp, "bad.jsonl"), "--id", "T9", "--priority", "URGENT", "--component", "x", "--title", "y", "--source-finding", "z", "--json"]).status);
  check("...and wrote nothing when it refused", false, fs.existsSync(path.join(tmp, "bad.jsonl")));
  check("gate REJECTS a plan whose named tasks artifact is not on disk", 1,
    runSelf(["gate", "--plan", goodPlan, "--tasks", path.join(tmp, "never-written.jsonl"), "--json"]).status);
  check("gate ACCEPTS the same plan when the artifact really exists", 0,
    runSelf(["gate", "--plan", goodPlan, "--tasks", tasksFile, "--json"]).status);

  // ---------------------------------------------------------------- context
  {
    const r = runSelf(["context", "--dir", path.join(tmp, "no-such-artifacts"), "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("context reports an absent artifacts dir as a verified empty result", 0, r.status);
    check("...labelled absent, not confused with a failed lookup", "absent", j.artifactsState ?? "");
  }
  {
    const notADir = write("not-a-dir.txt", "x\n");
    check("context REFUSES an artifacts path it cannot list instead of reporting none", 2,
      runSelf(["context", "--dir", notADir, "--json"]).status);
  }
  {
    // The framework detector, on a tree that really has one.
    fs.writeFileSync(path.join(projRoot, "package.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(projRoot, "vitest.config.ts"), "export default {}\n", "utf8");
    fs.mkdirSync(path.join(projRoot, "tests"), { recursive: true });
    const r = runSelf(["context", "--repo", projRoot, "--dir", path.join(tmp, "arts"), "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("context detects the test framework without a shell glob", true, (j.tests?.frameworks ?? []).includes("vitest"), JSON.stringify(j.tests ?? {}));
    check("...and the test directory", true, (j.tests?.testDirs ?? []).includes("tests"));
    check("...and the runtime", true, (j.tests?.runtimes ?? []).includes("node"));
  }
  {
    // gstack's detector, verbatim, in bash: its first line is a zsh builtin and
    // its globs report "no match" and "could not look" identically.
    const bashOk = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
    if (!bashOk) skip("gstack's framework detector in bash", "bash is not available to run it");
    else {
      const script = path.join(tmp, "gstack-detect.sh");
      fs.writeFileSync(script, GSTACK_FRAMEWORK_DETECT, "utf8");
      const bare = path.join(tmp, "bare-repo");
      fs.mkdirSync(bare, { recursive: true });
      const res = spawnSync("bash", [script], { cwd: bare, encoding: "utf8", windowsHide: true });
      check("gstack's framework detector prints NOTHING for a tree with no framework", "", (res.stdout || "").trim(),
        `stderr: ${(res.stderr || "").trim().split("\n")[0] || "(none)"}`);
      const r = runSelf(["context", "--repo", bare, "--dir", path.join(tmp, "arts2"), "--json"]);
      const j = JSON.parse(r.stdout || "{}");
      check("...while this one says the directory WAS read and is genuinely empty", "read", j.tests?.state ?? "");
    }
  }

  // ------------------------------------------------------- the prompt itself
  {
    const skillFile = path.join(SKILL_DIR, "SKILL.md");
    const sectionsFile = path.join(SKILL_DIR, "sections.md");
    const skillText = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf8") : "";
    const sectionsText = fs.existsSync(sectionsFile) ? fs.readFileSync(sectionsFile, "utf8") : "";
    const all = `${skillText}\n${sectionsText}`;
    check("the fork's prompt files are both present", true, skillText.length > 0 && sectionsText.length > 0, SKILL_DIR);
    check("...and the always-loaded SKILL.md stays under 32KB", true, skillText.length > 0 && skillText.length < 32768, `${skillText.length} bytes`);
    check("the attribution to Garry Tan survived", true, /Garry Tan/.test(skillText) && /Garry Tan/.test(sectionsText));
    const sectionCount = [...all.matchAll(/^###\s+\d\.\s+/gim)].length;
    check("all four review sections survived the trim", 4, sectionCount);
    for (const [label, re] of [
      ["the scope gate", /scope gate/i],
      ["the engineering preferences", /engineering preferences/i],
      ["the cognitive patterns", /boring by default/i],
      ["Step 0's complexity check", /complexity check/i],
      ["the test-coverage diagram", /coverage diagram/i],
      ["the failure modes output", /failure modes/i],
      ["the worktree parallelization strategy", /parallelization/i],
      ["one issue = one AskUserQuestion", /one issue.*one askuserquestion/i],
    ]) {
      check(`${label} survived the trim`, true, re.test(all));
    }
  }

  // A count that cannot silently shrink. The two A/B blocks contribute exactly
  // one entry each either way, so the total does not depend on this machine.
  const EXPECTED = 90;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-eng-review", results);
}

function report(label, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  ${label} selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    if (r.skip) {
      process.stdout.write(`  SKIP  ${r.name.padEnd(width)}  ${r.detail}\n`);
      continue;
    }
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const ran = results.filter((r) => !r.skip);
  const failed = ran.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skip);
  process.stdout.write(`\n  ${ran.length - failed.length}/${ran.length} passed${skipped.length ? `, ${skipped.length} skipped` : ""}\n`);
  if (failed.length) {
    process.stdout.write("\n  Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return false;
  }
  process.stdout.write("\n  Every rejection above is something gstack's eng review asks the model to judge\n");
  process.stdout.write("  about its own output, or never checks at all: a report missing or buried, a\n");
  process.stdout.write("  bolded sentinel, prose standing in for the test diagram, a citation to a file\n");
  process.stdout.write("  that was renamed, a '0 critical gaps' summary over a body that flags one, and\n");
  process.stdout.write("  two 'parallel' lanes editing the same directory. Each exits non-zero here.\n\n");
  return true;
}

// ----------------------------------------------------------------------- cli

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}

function help() {
  out(`
  tb-eng-review ${VERSION}  (Toolbay Stack)

  context [--repo <d>] [--dir <d>] [--plan <f>]
        resolve slug and branch without a shell, find the design doc, detect the
        test framework by reading the directory (not by globbing with stderr
        thrown away), and count the diff against the resolved base branch for
        Step 0's complexity gate. "Could not look" and "nothing there" are
        different answers.

  lint --plan <f> [--root <repo>] [--check-paths]
        check the review's own claims. Every file:line it cites must resolve in
        the working tree, the test diagram must actually be a diagram, the
        critical-gap count must match the **critical gap** flags in the body,
        and the lane count must match the lanes written — with two "parallel"
        lanes touching one module refused unless a conflict is flagged.

  gate --plan <f> [--tasks <jsonl>] [--root <repo>]
        the exit-plan-mode gate, run against the file instead of asked of the
        model, with the claim checks folded in.

  task --file <jsonl> --id T1 --priority P1 --component <c> --title <t>
       --source-finding <f> [--files a,b] [--effort-human 2h] [--effort-cc 10m]
  task --file <jsonl> --none
        write the Implementation Tasks artifact. No jq.

  record --plan <f> [--out <f>] [--root <repo>] [--mode M] [--unresolved N]
         [--critical-gaps N] [--issues-found N]
        write the review record, but only if the gate passes.

  selftest
        run all of the above against deliberately broken plans.

  Options: --json

  Exit codes:
    0  the check ran and passed
    1  the check ran and FAILED
    2  the input could not be read (never the same as "nothing found")
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
try {
  if (cmd === "context") cmdContext(argv.slice(1));
  else if (cmd === "lint") cmdLint(argv.slice(1));
  else if (cmd === "gate") cmdGate(argv.slice(1));
  else if (cmd === "task") cmdTask(argv.slice(1));
  else if (cmd === "record") cmdRecord(argv.slice(1));
  else if (cmd === "selftest") selftest();
  else help();
} catch (e) {
  // A crash is not a pass.
  err(`\n  tb-eng-review crashed: ${e?.stack ?? e}\n`);
  process.exitCode = EXIT_UNUSABLE;
}
