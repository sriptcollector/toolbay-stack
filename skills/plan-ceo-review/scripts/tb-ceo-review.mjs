#!/usr/bin/env node
/**
 * tb-ceo-review.mjs: the mechanical parts of /plan-ceo-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The review methodology this supports (founder-mode plan review;
 * the four postures SCOPE EXPANSION / SELECTIVE EXPANSION / HOLD SCOPE / SCOPE
 * REDUCTION; the nine prime directives; the cognitive-pattern list; Step 0's
 * premise challenge, existing-code leverage, dream-state mapping, mandatory
 * implementation alternatives, temporal interrogation and mode selection; the
 * eleven review sections; the required outputs, the registries, the Completion
 * Summary and the exit-plan-mode gate) comes from `plan-ceo-review` in gstack by
 * Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or endorsed
 * by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * The review itself is a prompt and stays a prompt. What is code here is only
 * the three places gstack's version asks the model to certify its own work, or
 * asks a POSIX shell for something Windows does not have. All three fail in the
 * same direction: the review reports itself finished having produced nothing.
 *
 * 1. THE EXIT GATE IS A SELF-CHECK. gstack plan-ceo-review/SKILL.md:1448-1476
 *    ends with "EXIT PLAN MODE GATE (BLOCKING)": five items the model verifies
 *    about its own output before calling ExitPlanMode, including "confirm the
 *    LAST `## ` heading in the file is `## GSTACK REVIEW REPORT`" and "confirm
 *    the report's FINAL non-whitespace line is the unresolved-decisions status".
 *    Nothing runs. The same file names the failure mode it cannot catch:
 *    "Self-deception failure mode to watch for: feeling 'done' after writing
 *    review prose into the plan body." A model that feels done is exactly the
 *    model being asked whether it is done. `gate` reads the plan off disk and
 *    exits non-zero, and it catches the fiddly cases a self-check waves through:
 *    a bolded `**NO UNRESOLVED DECISIONS**` (gstack says a bolded one does not
 *    count), a report that is present but not last, a Completion Summary pasted
 *    with its `___` blanks still in it.
 *
 * 2. THE IMPLEMENTATION-TASKS ARTIFACT IS GATED ON jq, AND FAILS TO A LIE.
 *    gstack's Required Outputs build the per-task JSONL with
 *    `jq -nc --arg ... >> "$TASKS_FILE"`. On Windows 11, 2026-08-13:
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
 *    not missing — it is there, and it is EMPTY. That matters because the same
 *    gstack section defines what empty means: "still touch the JSONL file so the
 *    aggregator sees that the phase produced output this run (an empty file
 *    means 'ran, no findings' — distinct from 'didn't run')." So on Windows
 *    every task this review surfaced is dropped, and the drop is indistinguish-
 *    able from a review that genuinely found nothing. A missing file would have
 *    been the safer failure. `task` writes the record in Node, which is already
 *    required by Claude Code, with JSON.stringify doing the escaping that
 *    "never hand-roll JSONL" was rightly warning about, and `--none` is the only
 *    way to get the empty file, so empty always means what it claims.
 *
 * 3. THE REVIEW LOG IS WRITTEN BEFORE THE GATE. gstack runs `gstack-review-log
 *    '{"skill":"plan-ceo-review", ... "status":"STATUS" ...}'` in its Review Log
 *    step, which sits BEFORE the exit gate and is unconditional. So a review
 *    that never produced its report still leaves a record that /ship's readiness
 *    dashboard reads as a completed CEO review. `record` re-runs the gate and
 *    writes nothing unless it passes.
 *
 * Design rules, same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. No path returns "fine" because a check could not run.
 *     Unreadable input is its own exit code and is never reported as "nothing
 *     found". A precondition that cannot be established refuses rather than
 *     guessing.
 *   - NO INTERPRETER BUT NODE. No jq, no zsh `setopt`, no `ls -t <glob> | head`,
 *     no `eval "$(...)"`, no `source <(...)`, no `find -mmin`, no `/tmp`, no
 *     `date +%s`, no `$PPID`. Every one of those is in the gstack version of
 *     this skill and none of them are Windows-safe.
 *   - PROVE IT. `selftest` runs this executable as a child process against
 *     deliberately broken plans and asserts each one is refused.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const EXIT_UNDETERMINED = 3; // a precondition could not be established: refuse

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
//
// gstack derives the slug with `eval "$(gstack-slug)"` and the branch with a
// pipeline ending `| tr '/' '-'`, then globs with `ls -t ... | head -1` after a
// zsh `setopt +o nomatch`. Every one of those is a shell feature. These are the
// same three facts, obtained without a shell, and each one reports failure as
// failure rather than as an empty string that reads like "nothing there".

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) {
    return { ok: false, error: (res.stderr || res.error?.message || `git ${args[0]} exited ${res.status}`).split("\n")[0].trim() };
  }
  return { ok: true, text: res.stdout.trim() };
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

function sanitizeSlug(s) {
  const cleaned = String(s).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
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

// ------------------------------------------------------------- prose + scope
//
// Fenced blocks and inline code are stripped before any term matching. A plan
// that pastes a React snippet is not thereby a UI plan.

function prose(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^( {4}|\t).*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** gstack's Frontend/UI Scope Detection list, applied the same way twice. */
const UI_TERMS = [
  "ui", "ux", "screen", "page", "component", "button", "form", "modal", "dialog",
  "layout", "dashboard", "sidebar", "nav", "navigation", "responsive", "mobile",
  "design system", "empty state", "onboarding flow", "frontend",
];

const MIN_DISTINCT_TERMS = 2;

function termHits(text, terms) {
  const hay = prose(text).toLowerCase();
  const hits = [];
  for (const t of terms) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`, "i");
    if (re.test(hay)) hits.push(t);
  }
  return hits;
}

function detectUiScope(text) {
  const terms = termHits(text, UI_TERMS);
  return { detected: terms.length >= MIN_DISTINCT_TERMS, terms };
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

// ------------------------------------------------------------------- context
//
// gstack's design-doc check, handoff check and prior-plan lookup are three
// copies of `ls -t ~/.gstack/projects/$SLUG/<glob> 2>/dev/null | head -1`, each
// preceded by a zsh `setopt +o nomatch` and each printing the empty result as
// "No design doc found". A directory that cannot be listed and a directory with
// nothing in it produce the identical answer, and the answer routes the review:
// "no design doc" triggers the /office-hours prerequisite offer, and "no handoff
// note" means re-asking the user questions they already answered in a prior
// session. Here the two states are different states.

function artifactsDirFor(slug) {
  const override = process.env.TOOLBAY_CEO_ARTIFACTS_DIR;
  if (override) return expand(override);
  // ~/.gstack/projects/<slug> on purpose: it is where gstack already writes and
  // where /autoplan's aggregator already looks, so a mixed install stays whole.
  return path.join(os.homedir(), ".gstack", "projects", slug);
}

function listArtifacts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { state: "absent", names: [], note: `${dir} does not exist yet, so this project has no stored artifacts` };
    }
    return { state: "unreadable", names: [], error: `${dir} exists but could not be listed (${e.code || e.message})` };
  }
  return { state: "read", names };
}

function newestMatching(dir, names, re) {
  const hits = names.filter((n) => re.test(n));
  const stamped = [];
  for (const n of hits) {
    const p = path.join(dir, n);
    try {
      stamped.push({ file: p, mtime: fs.statSync(p).mtimeMs });
    } catch {
      /* a file that vanished between readdir and stat is simply not a candidate */
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped;
}

/**
 * gstack's "Context-dependent defaults" table (SKILL.md:1417-1424) asks the
 * model to eyeball things like "Plan touching >15 files -> suggest REDUCTION".
 * Here the count is counted. When git cannot answer, this returns null and the
 * skill asks instead of defaulting: a mode picked from a failed measurement is
 * worse than no default at all.
 */
function modeDefault(repo, branchInfo) {
  const base = baseBranch(repo);
  if (!base) {
    return { mode: null, why: "no base branch could be resolved, so the file count is unknown", undetermined: true };
  }
  let changed = git(repo, ["diff", "--name-only", `${base}...HEAD`]);
  if (!changed.ok) changed = git(repo, ["diff", "--name-only", base]);
  if (!changed.ok) {
    return { mode: null, why: `git diff against ${base} failed (${changed.error})`, undetermined: true, base };
  }
  const files = changed.text.split(/\r?\n/).filter(Boolean);
  const branch = branchInfo.ok ? branchInfo.branch : "";
  const evidence = `${files.length} file(s) changed vs ${base}; branch "${branch || "unknown"}"`;

  if (/^(fix|hotfix|bug|bugfix)[/-]/i.test(branch)) {
    return { mode: "HOLD SCOPE", why: `branch name says this is a fix. ${evidence}`, base, files: files.length };
  }
  if (/^(refactor|chore|cleanup)[/-]/i.test(branch)) {
    return { mode: "HOLD SCOPE", why: `branch name says this is a refactor or chore. ${evidence}`, base, files: files.length };
  }
  if (files.length > 15) {
    return { mode: "SCOPE REDUCTION", why: `more than 15 files are in the diff. ${evidence}`, base, files: files.length };
  }
  if (files.length === 0) {
    return { mode: "SCOPE EXPANSION", why: `nothing has been built yet, so this is greenfield. ${evidence}`, base, files: 0 };
  }
  return { mode: "SELECTIVE EXPANSION", why: `an iteration on existing code. ${evidence}`, base, files: files.length };
}

function cmdContext(args) {
  const json = args.includes("--json");
  const repo = expand(valueOf(args, "--repo") ?? ".");
  const planArg = valueOf(args, "--plan");

  const slugInfo = repoSlug(repo);
  const branchInfo = currentBranch(repo);
  const slug = slugInfo.slug;
  const branchSafe = branchInfo.ok ? branchInfo.safe : null;
  const dir = expand(valueOf(args, "--dir") ?? artifactsDirFor(slug));

  const listing = listArtifacts(dir);
  if (listing.state === "unreadable") {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: listing.error }, null, 2));
    else {
      err(`\n  UNUSABLE  ${listing.error}`);
      err("            This is NOT 'no prior artifacts'. Do not offer /office-hours on the");
      err("            strength of a lookup that failed, and do not assume there is no");
      err("            handoff note from a paused session.\n");
    }
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const names = listing.names;
  const branchPart = branchSafe ? branchSafe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  const designBranch = branchPart ? newestMatching(dir, names, new RegExp(`-${branchPart}-design-.*\\.md$`)) : [];
  const designAny = newestMatching(dir, names, /-design-.*\.md$/);
  const handoff = branchPart ? newestMatching(dir, names, new RegExp(`-${branchPart}-ceo-handoff-.*\\.md$`)) : [];
  const priorPlans = (() => {
    const sub = path.join(dir, "ceo-plans");
    const l = listArtifacts(sub);
    if (l.state !== "read") return [];
    return newestMatching(sub, l.names, /\.md$/).slice(0, 5);
  })();

  let ui = null;
  let planPath = null;
  if (planArg) {
    const plan = readPlan(planArg);
    if (!plan.ok) {
      if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
      else err(`\n  UNUSABLE  ${plan.error}\n`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
    planPath = plan.path;
    ui = detectUiScope(plan.text);
  }

  const md = modeDefault(repo, branchInfo);
  const tasksFile = path.join(dir, `tasks-ceo-review-${stamp()}.jsonl`);

  const payload = {
    verdict: "READY",
    exit: EXIT_OK,
    slug,
    slugSource: slugInfo.source,
    branch: branchInfo.ok ? branchInfo.branch : null,
    branchError: branchInfo.ok ? null : branchInfo.error,
    artifactsDir: dir,
    artifactsState: listing.state,
    designDoc: (designBranch[0] ?? designAny[0])?.file ?? null,
    designDocScope: designBranch.length ? "this branch" : designAny.length ? "another branch" : null,
    handoffNote: handoff[0]?.file ?? null,
    priorCeoPlans: priorPlans.map((p) => p.file),
    ui,
    modeDefault: md.mode,
    modeWhy: md.why,
    tasksFile,
  };

  if (json) {
    out(JSON.stringify(payload, null, 2));
    return;
  }

  out();
  out(`  slug:      ${slug}   (${slugInfo.source})`);
  out(`  branch:    ${branchInfo.ok ? branchInfo.branch : `UNKNOWN (${branchInfo.error})`}`);
  out(`  artifacts: ${dir}   [${listing.state}]`);
  if (listing.state === "absent") out(`             ${listing.note}`);
  out();
  out(`  design doc:   ${payload.designDoc ?? "none found"}${payload.designDocScope === "another branch" ? "   (from another branch)" : ""}`);
  out(`  handoff note: ${payload.handoffNote ?? "none found"}`);
  out(`  prior CEO plans: ${priorPlans.length ? "" : "none"}`);
  for (const p of priorPlans) out(`    ${p.file}`);
  if (ui) {
    out();
    out(`  UI scope (Section 11): ${ui.detected ? "YES" : "no"}  (${ui.terms.length} distinct term(s)${ui.terms.length ? `: ${ui.terms.join(", ")}` : ""})`);
    out(`  plan: ${planPath}`);
  }
  out();
  if (md.mode) {
    out(`  suggested mode: ${md.mode}`);
    out(`                  ${md.why}`);
  } else {
    out(`  suggested mode: UNDETERMINED — ${md.why}`);
    out(`                  Ask the user in 0F rather than defaulting. A mode picked from a`);
    out(`                  measurement that failed is worse than no default.`);
  }
  out();
  out(`  write this review's tasks to: ${tasksFile}`);
  out();
  if (listing.state === "absent" && !payload.designDoc) {
    out("  There is no stored artifact directory for this project yet, which is why");
    out("  there is no design doc. That is a verified 'nothing here', not a failed");
    out("  lookup, so the /office-hours offer is the right next step.");
    out();
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// ---------------------------------------------------------------- task write
//
// gstack builds this artifact with `jq -nc --arg ... >> "$TASKS_FILE"` and
// documents the fallback as: skip the write. jq is absent on Windows, so the
// fallback is the only path, and the artifact the Required Outputs section calls
// mandatory ("always write, even if zero tasks") never exists.

const PRIORITIES = new Set(["P1", "P2", "P3"]);
const REQUIRED_TASK_FIELDS = ["id", "priority", "component", "title", "source_finding"];

function cmdTask(args) {
  const json = args.includes("--json");
  const fileArg = valueOf(args, "--file");
  const file = expand(fileArg);
  if (!file) {
    fail(json, EXIT_UNUSABLE, "--file <tasks-ceo-review-*.jsonl> is required");
    return;
  }

  if (args.includes("--none")) {
    // "ran, no findings" is a real result and has to be distinguishable from
    // "the phase never ran". An empty file says the first; no file says the
    // second, and on Windows gstack always says the second.
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
      out("  An empty file means 'this review ran and found nothing actionable'.");
      out("  A missing file means 'this review never ran'. They are not the same and");
      out("  the aggregator reads the difference.");
      out();
    }
    return;
  }

  const rec = {
    phase: "ceo-review",
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
    fail(
      json,
      EXIT_UNUSABLE,
      `refusing to write a task record missing ${missing.join(", ")}. A half-filled task is not a task; ` +
        `it becomes a checkbox in the final gate that nobody can act on.`,
    );
    return;
  }
  if (!PRIORITIES.has(rec.priority)) {
    fail(json, EXIT_UNUSABLE, `--priority must be one of P1, P2, P3 (got "${rec.priority}")`);
    return;
  }

  // JSON.stringify is the whole reason "never hand-roll JSONL" was good advice.
  // A title containing a quote, a backslash or a newline survives this intact.
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

function fail(json, code, message) {
  if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: code, error: message }, null, 2));
  else err(`\n  UNUSABLE  ${message}\n`);
  process.exitCode = code;
}

// ---------------------------------------------------------------------- gate
//
// Every check below is one gstack asks the model to confirm about its own work,
// in "EXIT PLAN MODE GATE (BLOCKING)" and in the Required Outputs / Priority
// Hierarchy sections. The difference is that these read the file.

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
  for (let i = 0; i < lines.length; i += 1) {
    if (REPORT_HEADING.test(lines[i])) start = i;
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start, end).join("\n"), lines };
}

function lastNonBlankLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return { text: lines[i].trim(), index: i };
  }
  return null;
}

/**
 * gstack's gate item 4, which is the single fiddliest thing in the file:
 *
 *   "Confirm the report's FINAL non-whitespace line is the unresolved-decisions
 *    status: the exact unbolded NO UNRESOLVED DECISIONS, or a bullet of a final
 *    **UNRESOLVED DECISIONS:** block. BLOCKING, no 'if applicable' escape - a
 *    bolded sentinel, any trailing CODEX/CROSS-MODEL/VERDICT/prose, or a missing
 *    status each FAILS the gate."
 *
 * Asking a model to check whether its own sentinel was accidentally bolded is
 * asking the wrong entity. Six lines of code cannot be talked out of it.
 */
function unresolvedStatus(text) {
  const last = lastNonBlankLine(text);
  if (!last) return { pass: false, detail: "the plan file has no content" };
  if (last.text === "NO UNRESOLVED DECISIONS") return { pass: true, detail: "sentinel present, unbolded" };
  if (/^\*+\s*NO UNRESOLVED DECISIONS\s*\*+$/.test(last.text)) {
    return {
      pass: false,
      detail: `the final line is "${last.text}" — a BOLDED sentinel, which gstack's own rule says does not count`,
    };
  }
  if (/^[-*+]\s+\S/.test(last.text)) {
    const before = text.split(/\r?\n/).slice(0, last.index);
    const hasHeader = before.some((l) => /\*\*UNRESOLVED DECISIONS:?\*\*/i.test(l));
    if (hasHeader) return { pass: true, detail: "final line is the last bullet of an UNRESOLVED DECISIONS block" };
    return { pass: false, detail: `the final line is a bullet but no **UNRESOLVED DECISIONS:** header precedes it` };
  }
  return { pass: false, detail: `the final non-whitespace line is "${truncate(last.text, 70)}", which is neither the sentinel nor an unresolved-decisions bullet` };
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
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

/**
 * gstack's Completion Summary template ships with `___` in every value cell.
 * A model that emits it verbatim produces something that looks exactly like a
 * finished review and carries no information, and every self-check for it
 * ("Completion Summary produced") is satisfied.
 */
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

function checks(plan) {
  const text = plan.text;
  const ui = detectUiScope(text);
  const section = reportSection(text);
  const R = [];
  const add = (id, label, pass, detail = "") => R.push({ id, label, pass: Boolean(pass), detail });

  // ---- gstack gate item 1 & 2
  add("report.present", "the plan file contains a review report section", Boolean(section),
    section ? `at line ${section.start + 1}` : "no `## TOOLBAY REVIEW REPORT` (or `## GSTACK REVIEW REPORT`) heading anywhere in the file");

  if (section) {
    const hs = headings(text);
    const lastHeading = hs[hs.length - 1];
    const isLast = lastHeading && lastHeading.i === section.start;
    add("report.is-last-section", "the review report is the LAST ## heading in the file", isLast,
      isLast ? "" : `the last ## heading is "${truncate(lastHeading?.line ?? "(none)", 60)}" at line ${(lastHeading?.i ?? 0) + 1}. A report buried mid-file is the state gstack's own gate says the user will (correctly) reject.`);

    // ---- gstack gate item 3
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

  // ---- Priority Hierarchy: "Never skip the system audit, the error/rescue map,
  //      or the failure modes section. These are the highest-leverage outputs."
  add("output.not-in-scope", '"NOT in scope" section is written', /not\s+in\s+scope/i.test(text),
    "the deferred work has to be written down; gstack's directive 7 is 'vague intentions are lies'");
  add("output.already-exists", '"What already exists" section is written', /what\s+already\s+exists/i.test(text));
  add("output.dream-state", '"Dream state delta" section is written', /dream\s*state/i.test(text));
  add("output.rescue-registry", "Error & Rescue Registry is written", /error\s*(&|and)\s*rescue\s*(registry|map)/i.test(text));
  add("output.failure-modes", "Failure Modes Registry is written", /failure\s*modes?\s*(registry|table)?/i.test(text));

  // ---- mode discipline: "Once selected, COMMIT to it."
  const modes = ["SCOPE EXPANSION", "SELECTIVE EXPANSION", "HOLD SCOPE", "SCOPE REDUCTION"];
  const named = modes.filter((m) => new RegExp(m.replace(/ /g, "\\s+"), "i").test(text));
  add("mode.recorded", "the review names the mode it ran in", named.length > 0,
    named.length ? `mode(s) named: ${named.join(", ")}` : "none of the four modes appears anywhere in the plan");

  // ---- the pasted-template failure
  const summary = unfilledSummary(text);
  add("summary.filled", "the Completion Summary has no unfilled ___ blanks left in it", summary.blanks.length === 0,
    summary.present
      ? summary.blanks.length
        ? `${summary.blanks.length} unfilled line(s), first: ${summary.blanks[0]}`
        : "filled"
      : "no Completion Summary block found, so nothing to check (the report table above is the binding requirement)");

  // ---- Section 11, gated on measured UI scope rather than recollection
  if (ui.detected) {
    const covered = /design\s*&?\s*ux|section\s*11|information architecture|interaction state/i.test(text);
    add("section11.design", "UI scope was detected, so the Design & UX section must appear", covered,
      covered ? "" : `the plan uses ${ui.terms.length} UI term(s) in prose (${ui.terms.join(", ")}) but carries no Design & UX review`);
  }

  return { results: R, ui };
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

  const { results, ui } = checks(plan);

  // The tasks artifact is checked only when a path is given, because the caller
  // is the only one who knows which run this is. Given a path, a missing file is
  // a failure: gstack calls that artifact mandatory and Windows never writes it.
  const tasksArg = valueOf(args, "--tasks");
  if (tasksArg) {
    const t = expand(tasksArg);
    const exists = Boolean(t) && fs.existsSync(t);
    results.push({
      id: "tasks.artifact",
      label: "the Implementation Tasks JSONL artifact exists on disk",
      pass: exists,
      detail: exists
        ? `${t} (${fs.statSync(t).size} bytes; empty is a valid 'ran, no findings')`
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
      uiScope: ui,
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
    out(`  GATE PASSED  ${results.length}/${results.length} checks. The report exists, it is the`);
    out(`  last section, it carries a filled table and a VERDICT, and its final line is the`);
    out(`  unresolved-decisions status. ExitPlanMode is allowed.`);
  } else {
    out(`  GATE FAILED  ${failed.length} of ${results.length} checks:`);
    for (const r of failed) {
      out(`    ${r.id}: ${r.label}`);
      if (r.detail) out(`      ${r.detail}`);
    }
    out();
    out("  Do NOT call ExitPlanMode. Do NOT write a review record. Fix these and run");
    out("  this again. Review prose in the plan body is not the report.");
  }
  out();
  process.exitCode = code;
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
  const { results } = checks(plan);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    const msg = `refusing to write a review record: ${failed.length} gate check(s) failed (${failed.map((r) => r.id).join(", ")})`;
    if (json) out(JSON.stringify({ verdict: "REFUSED", exit: EXIT_REJECTED, error: msg, failed: failed.map((r) => r.id) }, null, 2));
    else {
      err(`\n  REFUSED  ${msg}`);
      err("           Nothing was written. gstack logs this record BEFORE its exit gate and");
      err("           unconditionally, so a review that never produced a report still shows");
      err("           up in /ship's readiness dashboard as a completed CEO review.\n");
    }
    process.exitCode = EXIT_REJECTED;
    return;
  }

  const repo = expand(valueOf(args, "--repo") ?? path.dirname(plan.path));
  const outFile = expand(valueOf(args, "--out") ?? path.join(stateDir(), "reviews.jsonl"));
  const b = currentBranch(repo);
  const c = git(repo, ["rev-parse", "--short", "HEAD"]);
  const rec = {
    skill: "plan-ceo-review",
    timestamp: new Date().toISOString(),
    status: valueOf(args, "--status") ?? "clean",
    verified: true,
    verified_by: `tb-ceo-review ${VERSION}`,
    checks_passed: results.map((r) => r.id),
    mode: valueOf(args, "--mode") ?? null,
    unresolved: Number(valueOf(args, "--unresolved") ?? 0),
    critical_gaps: Number(valueOf(args, "--critical-gaps") ?? 0),
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
    out(`  The record carries verified:true and the ids of the checks that actually ran,`);
    out(`  so a downstream reader can tell a proven review from an asserted one.`);
    out();
  }
}

// ------------------------------------------------------------------ selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * gstack's Implementation Tasks writer, from plan-ceo-review's Required Outputs
 * section. Only the values are substituted; the `jq -nc --arg ...` invocation
 * and the redirect are verbatim.
 */
const GSTACK_TASK_WRITER = String.raw`
jq -nc \
  --arg phase 'ceo-review' \
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

const GOOD_PLAN = `# Plan: retry the webhook sender

Mode: HOLD SCOPE.

## What already exists
src/hooks.ts already has a queue; the retry loop is the missing piece.

## NOT in scope
Rewriting the queue. Deferred to TODOS.md.

## Dream state delta
CURRENT -> THIS PLAN -> 12-MONTH IDEAL: at-least-once delivery everywhere.

## Error & Rescue Registry
| Method | Exception | Rescued | User sees |
|---|---|---|---|
| Sender#call | TimeoutError | Y | "Service temporarily unavailable" |

## Failure Modes Registry
| Codepath | Failure | Rescued | Test | User sees | Logged |
|---|---|---|---|---|---|
| Sender#call | receiver 5xx | Y | Y | retry banner | Y |

## MEGA PLAN REVIEW — COMPLETION SUMMARY
| Mode selected | HOLD SCOPE |
| Section 2 (Errors) | 5 error paths mapped, 0 GAPS |

## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | /plan-ceo-review | Scope & strategy | 1 | CLEAR | 3 findings, 3 resolved |

**VERDICT:** CEO CLEARED — ready for eng review.

NO UNRESOLVED DECISIONS`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ceo-selftest-"));
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
  const gate = (p) => runSelf(["gate", "--plan", p, "--json"]);
  const failedIds = (r) => JSON.parse(r.stdout || "{}").failed ?? [];

  // ------------------------------------------------------------------- gate
  const goodPlan = write("good.md", GOOD_PLAN);
  {
    const r = gate(goodPlan);
    check("gate passes a plan that actually carries a finished report", 0, r.status, failedIds(r).join(","));
  }

  // gstack gate item 1: the report exists at all. The named failure mode is a
  // model that wrote review prose into the body and felt finished.
  {
    const p = write("prose-only.md", GOOD_PLAN.replace(/## TOOLBAY REVIEW REPORT[\s\S]*$/, "The review went well and I found three issues, all now addressed.\n"));
    const r = gate(p);
    check("gate REJECTS review prose in the body with no report section", 1, r.status);
    check("...naming report.present", true, failedIds(r).includes("report.present"));
  }

  // gstack gate item 2: the report must be the LAST ## heading.
  {
    const p = write("report-midfile.md", `${GOOD_PLAN}\n\n## Appendix\n\nSome notes.\n`);
    const r = gate(p);
    check("gate REJECTS a report that is present but not the last section", 1, r.status);
    check("...naming report.is-last-section", true, failedIds(r).includes("report.is-last-section"));
  }

  // gstack gate item 3: a table with real rows, not a header alone.
  {
    const p = write("empty-table.md", GOOD_PLAN.replace(/\| CEO Review \|.*\n/, ""));
    const r = gate(p);
    check("gate REJECTS a findings table with a header and no filled row", 1, r.status);
    check("...naming report.findings-table", true, failedIds(r).includes("report.findings-table"));
  }
  {
    const p = write("dash-table.md", GOOD_PLAN.replace(/\| CEO Review \|.*\n/, "| — | — | — | — | — | — |\n"));
    const r = gate(p);
    check("gate REJECTS a findings table whose only row is em dashes", 1, r.status);
    check("...naming report.findings-table", true, failedIds(r).includes("report.findings-table"));
  }

  // gstack gate item 4, the fiddliest rule in the file, and the one a model
  // checking its own output is least able to see.
  {
    const p = write("bold-sentinel.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**"));
    const r = gate(p);
    check("gate REJECTS a BOLDED unresolved-decisions sentinel", 1, r.status);
    check("...naming report.unresolved-status", true, failedIds(r).includes("report.unresolved-status"));
  }
  {
    const p = write("trailing-prose.md", `${GOOD_PLAN}\n\nOne more thought: we should also cache the receiver lookup.\n`);
    const r = gate(p);
    check("gate REJECTS trailing prose after the sentinel", 1, r.status);
    check("...naming report.unresolved-status", true, failedIds(r).includes("report.unresolved-status"));
  }
  {
    const p = write("bullet-no-header.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "- whether to keep the admin page"));
    const r = gate(p);
    check("gate REJECTS a trailing bullet with no UNRESOLVED DECISIONS header", 1, r.status);
  }
  {
    const p = write("bullet-with-header.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**UNRESOLVED DECISIONS:**\n\n- whether to keep the admin page"));
    check("gate ACCEPTS a proper UNRESOLVED DECISIONS block", 0, gate(p).status);
  }

  // Required outputs the Priority Hierarchy says are never skippable.
  for (const [name, cut, id] of [
    ['gate REJECTS a review with no "NOT in scope" section', /## NOT in scope[\s\S]*?(?=\n## )/, "output.not-in-scope"],
    ['gate REJECTS a review with no "What already exists" section', /## What already exists[\s\S]*?(?=\n## )/, "output.already-exists"],
    ["gate REJECTS a review with no Error & Rescue Registry", /## Error & Rescue Registry[\s\S]*?(?=\n## )/, "output.rescue-registry"],
    ["gate REJECTS a review with no Failure Modes Registry", /## Failure Modes Registry[\s\S]*?(?=\n## )/, "output.failure-modes"],
  ]) {
    const p = write(`${id}.md`, GOOD_PLAN.replace(cut, ""));
    const r = gate(p);
    check(name, 1, r.status);
    check(`...naming ${id}`, true, failedIds(r).includes(id));
  }

  // The pasted template. Looks exactly like a finished review; carries nothing.
  {
    const p = write("blank-summary.md", GOOD_PLAN.replace("| Section 2 (Errors) | 5 error paths mapped, 0 GAPS |", "| Section 2 (Errors) | ___ error paths mapped, ___ GAPS |"));
    const r = gate(p);
    check("gate REJECTS a Completion Summary still holding its ___ blanks", 1, r.status);
    check("...naming summary.filled", true, failedIds(r).includes("summary.filled"));
  }

  // Section 11 is gated on measured UI scope, not on recollection.
  {
    const p = write("ui-no-design.md", GOOD_PLAN.replace("## What already exists", "## What already exists\n\nThis adds a dashboard screen with a modal and a responsive sidebar.\n\n## Placeholder"));
    const r = gate(p);
    check("gate REJECTS a UI-scoped plan with no Design & UX section", 1, r.status);
    check("...naming section11.design", true, failedIds(r).includes("section11.design"));
  }
  {
    const p = write("code-only-ui.md", GOOD_PLAN.replace("## What already exists", "## What already exists\n\n```jsx\n<Sidebar><Modal/><Button/></Sidebar>\n```\n\n## Placeholder"));
    const r = gate(p);
    check("gate does NOT infer UI scope from terms that only appear in a code block", 0, r.status, failedIds(r).join(","));
  }

  // Fail closed: the gate cannot read the plan.
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
    const r = runSelf(["record", "--plan", goodPlan, "--out", recFile, "--json"]);
    check("record logs a review whose gate passes", 0, r.status, r.stderr.trim());
    const first = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8").trim().split("\n")[0]) : {};
    check("...carrying verified:true", true, first.verified === true);
    check("...and the ids of the checks that ran", true, Array.isArray(first.checks_passed) && first.checks_passed.length >= 10);
  }

  // ------------------------------------------------------------------ tasks
  const tasksFile = path.join(tmp, "artifacts", "tasks-ceo-review-20260813-000000.jsonl");
  const nastyTitle = 'add "retry" to C:\\hooks\nand log it';
  {
    const r = runSelf([
      "task", "--file", tasksFile, "--id", "T1", "--priority", "P1",
      "--component", "webhooks", "--title", nastyTitle,
      "--source-finding", 'Section 2 said: "no rescue for 5xx"',
      "--files", "src/hooks.ts,src/queue.ts", "--effort-human", "2h", "--effort-cc", "10m", "--json",
    ]);
    check("task writes the Implementation Tasks artifact without jq", 0, r.status, r.stderr.trim());
    const line = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8").trim() : "";
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* stays null */ }
    check("...as one parseable JSON line", true, parsed !== null, line.slice(0, 80));
    check("...with quotes, backslashes and newlines in the title surviving intact", nastyTitle, parsed?.title ?? "(unparseable)");
  }
  {
    // The A/B: gstack's own writer, verbatim, on the same task.
    const jqPresent = spawnSync(isWindows ? "where" : "which", ["jq"], { encoding: "utf8", windowsHide: true }).status === 0;
    const bashOk = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
    // Whatever happens to the A/B, exactly two entries are pushed here, so the
    // assertion count below cannot depend on what is installed on this machine.
    if (!bashOk) {
      skip("gstack's jq task writer on the same task", "bash is not available to run it");
    } else if (jqPresent) {
      skip("gstack's jq task writer on the same task", "jq IS installed here, so gstack's writer works too and there is no delta to show");
    } else {
      const gstackFile = path.join(tmp, "gstack-tasks.jsonl");
      const script = path.join(tmp, "gstack-writer.sh");
      fs.writeFileSync(script, GSTACK_TASK_WRITER, "utf8");
      const res = spawnSync("bash", [script], {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          TASKS_FILE: gstackFile,
          RUN_ID: "20260813-000000",
          BRANCH: "feature",
          COMMIT: "abc123",
          TASK_ID: "T1",
          PRIORITY: "P1",
          COMPONENT: "webhooks",
          EFFORT_HUMAN: "2h",
          EFFORT_CC: "10m",
          TITLE: nastyTitle,
          SOURCE_FINDING: "no rescue for 5xx",
          FILES_JSON: '["src/hooks.ts"]',
        },
      });
      const gstackBytes = fs.existsSync(gstackFile) ? fs.statSync(gstackFile).size : -1;
      const gstackWroteATask = gstackBytes > 0 && fs.readFileSync(gstackFile, "utf8").trim().length > 0;
      check(
        'gstack\'s jq writer records NO task, leaving an artifact that reads as "ran, no findings"',
        false,
        gstackWroteATask,
        `jq absent; the shell still created the file: exists=${gstackBytes >= 0}, bytes=${gstackBytes}. bash said: ${
          (res.stderr || "").trim().split("\n")[0] || "(nothing)"
        }`,
      );
    }
    check("...while this one produced a real record for the same task", true, fs.existsSync(tasksFile));
  }
  {
    const emptyFile = path.join(tmp, "artifacts", "tasks-ceo-review-empty.jsonl");
    const r = runSelf(["task", "--file", emptyFile, "--none", "--json"]);
    check('task --none writes an EMPTY artifact for "ran, found nothing"', 0, r.status);
    // Zero bytes is the same state gstack's jq writer fails into. The difference
    // is that here it is only reachable on purpose, so empty means what it says.
    check("...which is zero bytes, a state reachable here only on purpose", 0, fs.existsSync(emptyFile) ? fs.statSync(emptyFile).size : -1);
  }
  check(
    "task REFUSES a record missing its source finding rather than writing a half-task",
    2,
    runSelf(["task", "--file", path.join(tmp, "bad.jsonl"), "--id", "T9", "--priority", "P1", "--component", "x", "--title", "y", "--json"]).status,
  );
  check(
    "task REFUSES an unknown priority",
    2,
    runSelf(["task", "--file", path.join(tmp, "bad.jsonl"), "--id", "T9", "--priority", "URGENT", "--component", "x", "--title", "y", "--source-finding", "z", "--json"]).status,
  );
  check("...and wrote nothing when it refused", false, fs.existsSync(path.join(tmp, "bad.jsonl")));

  // ---- the gate ties the artifact in: a named artifact that is not on disk fails.
  check(
    "gate REJECTS a plan whose named tasks artifact is not on disk",
    1,
    runSelf(["gate", "--plan", goodPlan, "--tasks", path.join(tmp, "never-written.jsonl"), "--json"]).status,
  );
  check(
    "gate ACCEPTS the same plan when the artifact really exists",
    0,
    runSelf(["gate", "--plan", goodPlan, "--tasks", tasksFile, "--json"]).status,
  );

  // ---------------------------------------------------------------- context
  {
    const missingDir = path.join(tmp, "no-such-artifacts");
    const r = runSelf(["context", "--dir", missingDir, "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("context reports an absent artifacts dir as a verified empty result", 0, r.status);
    check("...labelled absent, not confused with a failed lookup", "absent", j.artifactsState ?? "");
  }
  {
    const artDir = path.join(tmp, "artifacts-live");
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, "2026-08-13-feature-x-ceo-handoff-1.md"), "handoff\n", "utf8");
    const r = runSelf(["context", "--dir", artDir, "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("context reads a real artifacts dir", "read", j.artifactsState ?? "");
    check("...and names a slug rather than an empty string", true, Boolean(j.slug));
  }
  {
    // A file where a directory is expected: readdir fails with ENOTDIR, which is
    // "could not look", not "nothing there".
    const notADir = write("not-a-dir.txt", "x\n");
    const r = runSelf(["context", "--dir", notADir, "--json"]);
    check("context REFUSES an artifacts path it cannot list instead of reporting none", 2, r.status);
  }

  // ------------------------------------------------------- the context tax
  //
  // The reason this fork exists at all. gstack's plan-ceo-review is 1476 lines
  // of SKILL.md that every invocation loads before it reads a word of the plan.
  {
    const ours = ["SKILL.md", "sections.md"]
      .map((f) => path.join(SKILL_DIR, f))
      .filter((f) => fs.existsSync(f))
      .reduce((n, f) => n + fs.statSync(f).size, 0);
    check("the fork's prompt files are all present", true, ours > 0, `${ours} bytes under ${SKILL_DIR}`);
    check("...and the always-loaded SKILL.md stays under 32KB", true,
      fs.existsSync(path.join(SKILL_DIR, "SKILL.md")) && fs.statSync(path.join(SKILL_DIR, "SKILL.md")).size < 32768,
      `${fs.existsSync(path.join(SKILL_DIR, "SKILL.md")) ? fs.statSync(path.join(SKILL_DIR, "SKILL.md")).size : -1} bytes`);

    // Trimming is only a win if the review survived the trim. These are the
    // load-bearing parts: the four modes, the eleven sections, the registries.
    const skillText = fs.existsSync(path.join(SKILL_DIR, "SKILL.md")) ? fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8") : "";
    const sectionsText = fs.existsSync(path.join(SKILL_DIR, "sections.md")) ? fs.readFileSync(path.join(SKILL_DIR, "sections.md"), "utf8") : "";
    const all = `${skillText}\n${sectionsText}`;
    const modes = ["SCOPE EXPANSION", "SELECTIVE EXPANSION", "HOLD SCOPE", "SCOPE REDUCTION"];
    check("all four review modes survived the trim", 4, modes.filter((m) => all.includes(m)).length);
    const sectionCount = [...all.matchAll(/^###\s+Section\s+(\d{1,2}):/gim)].length;
    check("all eleven review sections survived the trim", 11, sectionCount);
    for (const [label, re] of [
      ["the premise challenge", /premise challenge/i],
      ["the mandatory implementation alternatives", /implementation alternatives/i],
      ["the error & rescue map", /error\s*&\s*rescue/i],
      ["the failure modes registry", /failure modes registry/i],
      ["the nine prime directives", /prime directives/i],
      ["the dream state mapping", /dream state/i],
    ]) {
      check(`${label} survived the trim`, true, re.test(all));
    }
  }

  // A count that cannot silently shrink. If a case is dropped, this fails. The
  // jq A/B contributes exactly one entry either way (a check or a skip), so the
  // total does not depend on what happens to be installed on this machine.
  const EXPECTED = 64;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-ceo-review", results);
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
  process.stdout.write("\n  Every rejection above is a plan gstack's exit gate asks the model to judge\n");
  process.stdout.write("  about its own output: a report that is missing, buried mid-file, tabled but\n");
  process.stdout.write("  unfilled, or ended with a bolded sentinel. Here each one exits non-zero\n");
  process.stdout.write("  before ExitPlanMode, and the review record is refused with it.\n\n");
  return true;
}

// ----------------------------------------------------------------------- cli

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}

function help() {
  out(`
  tb-ceo-review ${VERSION}  (Toolbay Stack)

  context [--repo <d>] [--dir <d>] [--plan <f>]
        resolve the slug and branch without a shell, find the design doc,
        handoff note and prior CEO plans, measure UI scope for Section 11, and
        compute the suggested mode from the real diff. "Could not look" and
        "nothing there" are different answers.

  task --file <jsonl> --id T1 --priority P1 --component <c> --title <t>
       --source-finding <f> [--files a,b] [--effort-human 2h] [--effort-cc 10m]
  task --file <jsonl> --none
        write the Implementation Tasks artifact. No jq.

  gate --plan <f> [--tasks <jsonl>]
        the exit-plan-mode gate, run against the file instead of asked of the
        model. Report present, report last, table filled, VERDICT present,
        final line is the unresolved-decisions status, required outputs written,
        Completion Summary filled, Section 11 present if UI scope was measured.

  record --plan <f> [--out <f>] [--mode M] [--unresolved N] [--critical-gaps N]
        write the review record, but only if the gate passes.

  selftest
        run all of the above against deliberately broken plans.

  Options: --json

  Exit codes:
    0  the check ran and passed
    1  the check ran and FAILED
    2  the input could not be read (never the same as "nothing found")
    3  a precondition could not be established
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
try {
  if (cmd === "context") cmdContext(argv.slice(1));
  else if (cmd === "task") cmdTask(argv.slice(1));
  else if (cmd === "gate") cmdGate(argv.slice(1));
  else if (cmd === "record") cmdRecord(argv.slice(1));
  else if (cmd === "selftest") selftest();
  else help();
} catch (e) {
  // A crash is not a pass.
  err(`\n  tb-ceo-review crashed: ${e?.stack ?? e}\n`);
  process.exitCode = EXIT_UNUSABLE;
}
