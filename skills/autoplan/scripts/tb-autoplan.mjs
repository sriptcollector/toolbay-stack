#!/usr/bin/env node
/**
 * tb-autoplan.mjs: the mechanical parts of the /autoplan pipeline.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow implemented here (a single command that runs the
 * CEO -> Design -> Eng -> DX plan reviews in sequence, auto-deciding the
 * intermediate questions with six named principles, classifying each decision
 * as mechanical / taste / user-challenge, the conditional UI and DX phases and
 * the term lists that gate them, the per-phase required-output checklists, the
 * cross-phase task aggregation, and the final approval gate) comes from
 * `autoplan` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * /autoplan is the highest-leverage skill in the suite and the one with the
 * least evidence behind its output. It wraps four other reviews, removes the
 * human from every intermediate decision, and then writes review-log records
 * that /ship's dashboard reads as "this plan was reviewed". Three of its steps
 * fail open, so the pipeline can produce that record having done none of the
 * work. All three are fixed here, and the fixes are all of the same shape: a
 * step that could silently produce nothing becomes a command with an exit code.
 *
 * 1. THE METHODOLOGY SOURCES ARE READ WITH NO FAILURE PATH. gstack Phase 0
 *    Step 3 (autoplan/SKILL.md:1071-1077) says:
 *
 *      Read each file using the Read tool:
 *      - ~/.claude/skills/gstack/plan-ceo-review/SKILL.md
 *      - ~/.claude/skills/gstack/plan-design-review/SKILL.md (only if UI scope)
 *      - ~/.claude/skills/gstack/plan-eng-review/SKILL.md
 *      - ~/.claude/skills/gstack/plan-devex-review/SKILL.md (only if DX scope)
 *
 *    and says nothing about what to do when one is not there. The only place
 *    the same SKILL.md handles an unreadable skill file it says (:872):
 *    "If unreadable: Skip with 'Could not load /office-hours - skipping.' and
 *    continue." A partial install, a renamed skill, a project-local override, a
 *    vendored copy: any of those and a phase runs with no methodology loaded,
 *    the model reviews from memory, and Phase 4 still prints "Eng: [summary]"
 *    and writes `{"skill":"plan-eng-review","status":"clean"}` to the review
 *    log. `preflight` resolves every required source and exits 3 naming the
 *    ones it could not find, before any review starts.
 *
 * 2. THE TASK AGGREGATOR DROPS EVERYTHING IT CANNOT PROCESS. gstack Phase 4
 *    (autoplan/SKILL.md:1647-1701) aggregates the four phases' task lists with
 *    a jq pipeline in which every jq call ends `2>/dev/null || true`, and the
 *    whole block is gated on `command -v jq`. On this machine, Windows 11,
 *    2026-08-13:
 *
 *      $ command -v jq || echo "JQ: ABSENT"
 *      JQ: ABSENT
 *
 *    so the entire Implementation Tasks section of the final gate degrades to
 *    "_jq not installed - install jq to aggregate per-phase task lists.
 *    Skipping._" and every task the four reviews surfaced is dropped from the
 *    deliverable. `tasks` does the same aggregation in Node, which is already
 *    required by Claude Code, and separates "there are no task files" (0, and
 *    it says which directory it looked in) from "the task files could not be
 *    read" (2). A malformed line is reported, never silently skipped.
 *
 * 3. THE PRE-GATE CHECKLIST IS ADVISORY. gstack's Pre-Gate Verification
 *    (autoplan/SKILL.md:1584-1636) is 25 checkboxes the model ticks about its
 *    own work, ending: "If still missing after retrying twice, proceed to the
 *    gate with a warning noting which items are incomplete." So the documented
 *    behaviour on a failed verification is to pass anyway, and the Completion
 *    step after it writes the review-log records regardless. `verify` reads the
 *    plan file off disk and exits 1 naming what is absent, `record` refuses to
 *    write a review record unless `verify` passed, and the record it writes
 *    carries the ids of the requirements that were actually checked.
 *
 * Design rules, same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. No path returns "fine" because a check could not run.
 *     Unreadable input is its own exit code, distinct from "checked, empty".
 *   - NO INTERPRETER BUT NODE. No jq, no mktemp, no `find -mmin`, no process
 *     substitution, no `source <(...)`. All of those are in the gstack version
 *     of this workflow and none of them are Windows-safe.
 *   - PROVE IT. `selftest` runs this executable as a child process against
 *     deliberately broken plans, missing methodology sources, placeholder
 *     review tables and unreadable directories, and fails loudly if any of
 *     them are accepted.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(SELF, "..", "..");
const SKILLS_ROOT = path.resolve(SKILL_DIR, "..");
const VERSION = "0.1.0";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // the check ran and passed
const EXIT_REJECTED = 1; // the check ran and failed
const EXIT_UNUSABLE = 2; // the input could not be read
const EXIT_UNDETERMINED = 3; // a precondition could not be established: refuse

// ------------------------------------------------------------------- paths

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

/**
 * Where a plan-review skill might legitimately live, most specific first.
 *
 * TOOLBAY_AUTOPLAN_SKILL_ROOTS REPLACES this list rather than extending it, so
 * "resolve against exactly these directories" is expressible. The selftest
 * depends on that: a resolution test that can fall through to whatever happens
 * to be installed on the machine running it is not a test.
 */
function skillRoots(extra = []) {
  const fromEnv = (process.env.TOOLBAY_AUTOPLAN_SKILL_ROOTS || "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = fromEnv.length
    ? fromEnv
    : [
        SKILLS_ROOT,
        path.join(process.cwd(), ".claude", "skills"),
        path.join(process.cwd(), ".claude", "skills", "gstack"),
        path.join(os.homedir(), ".claude", "skills"),
        path.join(os.homedir(), ".claude", "skills", "gstack"),
      ];
  return [...extra, ...defaults].map((r) => expand(r)).filter(Boolean);
}

function findSkillFile(name, extraRoots = []) {
  for (const root of skillRoots(extraRoots)) {
    const p = path.join(root, name, "SKILL.md");
    try {
      if (fs.statSync(p).isFile() && fs.statSync(p).size > 0) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
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
  if (!text.trim()) {
    return { ok: false, error: `plan file ${abs} is empty, so there is nothing to review` };
  }
  return { ok: true, path: abs, text };
}

/**
 * Prose only: fenced blocks and inline code are removed before scope detection.
 *
 * gstack greps the whole plan for terms like `import`, `require`, `command` and
 * `package`. Any plan that pastes a snippet of JavaScript therefore reads as
 * developer-facing and pulls in a whole extra review phase. The terms are
 * evidence when the plan says them, not when a code sample happens to contain
 * them.
 */
function prose(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^( {4}|\t).*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ");
}

// ------------------------------------------------------------ scope detection
//
// The term lists are gstack's, from autoplan Phase 0 Step 2. What changed is
// that "require 2+ matches" is now a rule a machine applies the same way twice:
// 2 or more DISTINCT terms, matched on word boundaries, in prose only, and the
// matched terms are printed so the verdict can be argued with.

const UI_TERMS = [
  "component", "screen", "form", "button", "modal", "layout",
  "dashboard", "sidebar", "nav", "navigation", "dialog",
];

const DX_TERMS = [
  "api", "endpoint", "rest", "graphql", "grpc", "webhook", "cli", "command",
  "flag", "argument", "terminal", "shell", "sdk", "library", "package", "npm",
  "pip", "import", "require", "skill.md", "skill template", "claude code",
  "mcp", "agent", "openclaw", "developer docs", "getting started", "onboarding",
  "integration", "debug", "error message",
];

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

const MIN_DISTINCT_TERMS = 2;

function detectScope(text) {
  const ui = termHits(text, UI_TERMS);
  const dx = termHits(text, DX_TERMS);
  return {
    ui: { terms: ui, detected: ui.length >= MIN_DISTINCT_TERMS },
    dx: { terms: dx, detected: dx.length >= MIN_DISTINCT_TERMS },
  };
}

// ------------------------------------------------------------------ preflight

const PHASES = {
  ceo: { skill: "plan-ceo-review", label: "CEO review (strategy & scope)", always: true },
  design: { skill: "plan-design-review", label: "Design review (UI/UX)", always: false },
  eng: { skill: "plan-eng-review", label: "Eng review (architecture & tests)", always: true },
  dx: { skill: "plan-devex-review", label: "DX review (developer experience)", always: false },
};

const STAMP_RE = /<!--\s*tb-autoplan\s+([^>]*?)-->/;

function readStamp(text) {
  const m = STAMP_RE.exec(text);
  if (!m) return null;
  const fields = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const i = pair.indexOf("=");
    if (i > 0) fields[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (!fields.phases) return null;
  return { phases: fields.phases.split(",").filter(Boolean), fields, raw: m[0] };
}

function cmdPreflight(args) {
  const json = args.includes("--json");
  const stamp = args.includes("--stamp");
  const planArg = valueOf(args, "--plan");
  const extraRoots = allValuesOf(args, "--skills-root");

  const plan = readPlan(planArg);
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else err(`\n  UNUSABLE  ${plan.error}\n`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const scope = detectScope(plan.text);
  const wanted = ["ceo"];
  if (scope.ui.detected) wanted.push("design");
  wanted.push("eng");
  if (scope.dx.detected) wanted.push("dx");

  const sources = wanted.map((key) => {
    const spec = PHASES[key];
    const file = findSkillFile(spec.skill, extraRoots);
    return { phase: key, skill: spec.skill, label: spec.label, file };
  });
  const missing = sources.filter((s) => !s.file);
  const code = missing.length ? EXIT_UNDETERMINED : EXIT_OK;

  if (stamp && code === EXIT_OK) {
    writeStamp(plan, wanted, scope);
  }

  if (json) {
    out(
      JSON.stringify(
        {
          verdict: code === EXIT_OK ? "READY" : "MISSING_METHODOLOGY",
          exit: code,
          plan: plan.path,
          phases: wanted,
          ui: { detected: scope.ui.detected, terms: scope.ui.terms },
          dx: { detected: scope.dx.detected, terms: scope.dx.terms },
          sources: sources.map((s) => ({ phase: s.phase, skill: s.skill, file: s.file })),
          missing: missing.map((s) => s.skill),
          stamped: Boolean(stamp && code === EXIT_OK),
        },
        null,
        2,
      ),
    );
  } else {
    out();
    out(`  plan: ${plan.path}`);
    out(
      `  UI scope:  ${scope.ui.detected ? "yes" : "no"}  (${scope.ui.terms.length} distinct term(s)${
        scope.ui.terms.length ? `: ${scope.ui.terms.join(", ")}` : ""
      })`,
    );
    out(
      `  DX scope:  ${scope.dx.detected ? "yes" : "no"}  (${scope.dx.terms.length} distinct term(s)${
        scope.dx.terms.length ? `: ${scope.dx.terms.join(", ")}` : ""
      })`,
    );
    out();
    out("  phases and the methodology each one must be run from:");
    for (const s of sources) out(`  ${s.file ? "ok " : "no "}  ${s.phase.padEnd(7)} ${s.skill.padEnd(20)} ${s.file ?? "NOT FOUND"}`);
    out();
    if (code === EXIT_OK) {
      out(`  READY  ${wanted.length} phase(s): ${wanted.join(" -> ")}`);
      if (stamp) out(`  stamped the plan file with the phase set, so verify can check the right list`);
    } else {
      out(`  MISSING METHODOLOGY  ${missing.map((s) => s.skill).join(", ")}`);
      out();
      out("  Refusing to start. A phase whose review skill was never loaded is not");
      out("  a review, and the pipeline would still print a summary for it and write");
      out("  a passing review-log record. Install the missing skill, or pass");
      out("  --skills-root <dir>. Searched:");
      for (const r of skillRoots(extraRoots)) out(`    ${r}`);
    }
    out();
  }
  process.exitCode = code;
}

function writeStamp(plan, phases, scope) {
  const line = `<!-- tb-autoplan v${VERSION} phases=${phases.join(",")} ui=${scope.ui.detected ? "yes" : "no"} dx=${
    scope.dx.detected ? "yes" : "no"
  } -->`;
  const existing = readStamp(plan.text);
  const next = existing ? plan.text.replace(existing.raw, line) : `${line}\n${plan.text}`;
  fs.writeFileSync(plan.path, next, "utf8");
  plan.text = next;
}

// ------------------------------------------------------------ task aggregation

const PHASE_FILE_ORDER = ["ceo-review", "design-review", "eng-review", "devex-review"];
const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2 };
const TASK_FIELDS = ["id", "title", "phase", "priority", "component", "files"];

function collectTaskFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { ok: false, error: `${dir} could not be listed (${e.code || e.message})` };
  }
  const files = [];
  for (const phase of PHASE_FILE_ORDER) {
    const prefix = `tasks-${phase}-`;
    for (const n of names.filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl")).sort()) {
      files.push({ phase, file: path.join(dir, n) });
    }
  }
  return { ok: true, files };
}

function loadTasks(dir, { branch, commits } = {}) {
  const found = collectTaskFiles(dir);
  if (!found.ok) return { code: EXIT_UNUSABLE, error: found.error };
  if (!found.files.length) {
    return { code: EXIT_OK, tasks: [], files: [], empty: true, badLines: [], unreadable: [] };
  }

  const records = [];
  const badLines = [];
  const unreadable = [];
  for (const { file } of found.files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      // Not readable is NOT zero tasks. gstack's `2>/dev/null || true` makes
      // these the same answer; here the caller is told and gets exit 2.
      unreadable.push(`${file} (${e.code || e.message})`);
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        badLines.push(`${file}:${i + 1} is not valid JSON (${e.message})`);
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        badLines.push(`${file}:${i + 1} is not a JSON object`);
        return;
      }
      obj._file = file;
      records.push(obj);
    });
  }

  if (unreadable.length) {
    return { code: EXIT_UNUSABLE, error: `task list(s) could not be read: ${unreadable.join("; ")}`, unreadable };
  }
  if (records.length === 0 && badLines.length > 0) {
    return { code: EXIT_UNUSABLE, error: `every line in the task lists was unparseable`, badLines };
  }

  let kept = records;
  const filters = [];
  if (branch) {
    kept = kept.filter((r) => r.branch === undefined || r.branch === branch);
    filters.push(`branch == ${branch} (records with no branch field are kept, not dropped)`);
  }
  if (commits && commits.length) {
    kept = kept.filter((r) => r.commit === undefined || commits.includes(r.commit));
    filters.push(`commit in the last ${commits.length} commit(s)`);
  }

  // Latest run_id per phase.
  const byPhase = new Map();
  for (const r of kept) {
    const p = r.phase || "unknown";
    const cur = byPhase.get(p);
    if (cur === undefined || String(r.run_id ?? "") > cur) byPhase.set(p, String(r.run_id ?? ""));
  }
  kept = kept.filter((r) => String(r.run_id ?? "") === byPhase.get(r.phase || "unknown"));

  // Exact-match dedupe on (component, sorted files, title).
  const groups = new Map();
  for (const r of kept) {
    const files = Array.isArray(r.files) ? [...r.files].sort() : [];
    const key = JSON.stringify([r.component ?? "", files, r.title ?? ""]);
    const prev = groups.get(key);
    if (!prev || rank(r) < rank(prev)) groups.set(key, r);
  }
  const tasks = [...groups.values()].sort((a, b) => rank(a) - rank(b));

  const incomplete = tasks.filter((t) => TASK_FIELDS.some((f) => t[f] === undefined || t[f] === null));
  return { code: EXIT_OK, tasks, files: found.files, badLines, filters, incomplete };
}

function rank(r) {
  const p = PRIORITY_ORDER[r.priority] ?? 99;
  const ph = PHASE_FILE_ORDER.indexOf(r.phase);
  return p * 100 + (ph === -1 ? 99 : ph);
}

function renderTasks(tasks) {
  return tasks
    .map((t) => {
      const missing = TASK_FIELDS.filter((f) => t[f] === undefined || t[f] === null);
      const mark = missing.length ? ` _[incomplete record: missing ${missing.join(", ")}]_` : "";
      const files = Array.isArray(t.files) && t.files.length ? t.files.join(", ") : "(none listed)";
      return (
        `- [ ] **${t.id ?? "(no id)"} (${t.priority ?? "?"}, human: ${t.effort_human ?? "?"} / CC: ${t.effort_cc ?? "?"}) — ${
          t.component ?? "(no component)"
        }** — ${t.title ?? "(no title)"}${mark}\n` +
        `  - Surfaced by: ${t.phase ?? "(unknown phase)"} — ${t.source_finding ?? "(no finding cited)"}\n` +
        `  - Files: ${files}`
      );
    })
    .join("\n");
}

function commitWindow(repo, n) {
  if (!repo || !n) return { commits: null, note: "no commit window applied (pass --repo <dir> to scope to recent commits)" };
  const res = spawnSync("git", ["log", "--format=%H", "-n", String(n)], { cwd: repo, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) {
    // Widening, not narrowing: a git failure must not make tasks disappear.
    return {
      commits: null,
      note: `git log failed in ${repo} (${(res.stderr || res.error?.message || "").split("\n")[0]}), so NO commit filter was applied and every task is shown`,
    };
  }
  const commits = res.stdout.split(/\r?\n/).filter(Boolean);
  return { commits, note: `commit window: ${commits.length} most recent commit(s)` };
}

function cmdTasks(args) {
  const json = args.includes("--json");
  const dirArg = valueOf(args, "--dir");
  const branch = valueOf(args, "--branch");
  const repo = valueOf(args, "--repo");
  const windowN = Number(valueOf(args, "--commit-window") ?? 5);

  const dir = expand(dirArg);
  if (!dir) {
    err("  UNUSABLE  --dir <directory of tasks-<phase>-*.jsonl> is required");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const cw = commitWindow(repo, windowN);
  const r = loadTasks(dir, { branch, commits: cw.commits });

  if (r.code === EXIT_UNUSABLE) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: r.code, error: r.error, badLines: r.badLines ?? [] }, null, 2));
    else {
      err(`\n  UNUSABLE  ${r.error}`);
      for (const b of r.badLines ?? []) err(`            ${b}`);
      err("            This is NOT 'no tasks'. Fix the input or say the tasks are unknown.\n");
    }
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  if (json) {
    out(
      JSON.stringify(
        {
          verdict: r.empty ? "NO_TASK_FILES" : "OK",
          exit: EXIT_OK,
          dir,
          files: (r.files ?? []).map((f) => f.file),
          filters: r.filters ?? [],
          commitWindow: cw.note,
          badLines: r.badLines ?? [],
          incomplete: (r.incomplete ?? []).length,
          count: r.tasks.length,
          tasks: r.tasks.map(({ _file, ...t }) => t),
          markdown: r.tasks.length ? renderTasks(r.tasks) : "",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (r.empty) {
    out();
    out(`  No per-phase task lists exist in ${dir}.`);
    out("  The directory was read successfully and contains no tasks-<phase>-*.jsonl files,");
    out("  so this is a verified empty result, not a failed lookup.");
    out();
    return;
  }
  out();
  out(renderTasks(r.tasks));
  out();
  out(`  ${r.tasks.length} task(s) from ${r.files.length} file(s). ${cw.note}.`);
  for (const f of r.filters ?? []) out(`  filter: ${f}`);
  if (r.badLines?.length) {
    out();
    out(`  ${r.badLines.length} line(s) could not be parsed and are NOT included above:`);
    for (const b of r.badLines) out(`    ${b}`);
  }
  if (r.incomplete?.length) out(`  ${r.incomplete.length} record(s) are missing required fields and are marked inline.`);
  out();
}

// --------------------------------------------------------------- verification
//
// Every requirement below is something gstack's own Pre-Gate Verification
// checklist asks the model to confirm about itself. The difference is that this
// reads the plan file on disk and exits non-zero.

function fenced(text) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * A dependency diagram, not a sentence with an arrow in it.
 *
 * HTML comments are stripped first. `-->` is the end of every HTML comment, and
 * both gstack and this fork write comments into the plan file (the restore-point
 * marker, the audit-trail marker, this fork's preflight stamp), so counting them
 * would let three bookkeeping comments stand in for the architecture section.
 * Markdown table rows are excluded for the same reason: `|---|---|` is not a
 * graph.
 */
function hasDiagram(text) {
  const clean = String(text).replace(/<!--[\s\S]*?-->/g, " ");
  const arrow = /(-->|->|│|└|┌|├|┬|┼|\+--)/;
  const isTableRow = (l) => /^\s*\|/.test(l);
  for (const b of [...fenced(clean), clean]) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim() && !isTableRow(l));
    if (lines.length >= 3 && lines.filter((l) => arrow.test(l)).length >= 2) return true;
  }
  return false;
}

/**
 * A consensus table left as the template.
 *
 * gstack ships the CEO / Eng / DX consensus tables with an em dash in every
 * data cell (autoplan/SKILL.md:1219-1232 and friends). A model that emits the
 * template verbatim produces something that looks exactly like a completed
 * review and contains no information at all, and every one of gstack's
 * checkboxes for it ("consensus table produced") is satisfied.
 */
function placeholderRows(text) {
  const dashCell = "(?:—|--|–|_+|TBD|N\\/A\\?)";
  const spaced = new RegExp(`^\\s*\\d+\\.\\s+\\S.*?\\s+${dashCell}\\s+${dashCell}\\s+${dashCell}\\s*$`, "gm");
  const piped = new RegExp(`^\\s*\\|.*\\|\\s*${dashCell}\\s*\\|\\s*${dashCell}\\s*\\|\\s*${dashCell}\\s*\\|\\s*$`, "gm");
  return (text.match(spaced) ?? []).concat(text.match(piped) ?? []);
}

function auditRows(text) {
  const idx = text.search(/Decision Audit Trail/i);
  if (idx === -1) return 0;
  const after = text.slice(idx);
  return after
    .split(/\r?\n/)
    .filter((l) => /^\s*\|/.test(l))
    .filter((l) => !/^\s*\|[\s|:-]*\|?\s*$/.test(l)) // separator rows
    .filter((l) => !/\bPhase\b.*\bDecision\b.*\bPrinciple\b/i.test(l)) // header row
    .length;
}

function namedArtifactsExist(text) {
  // Any path the plan claims it wrote a test plan to must actually be there.
  const re = /([~\w./\\:+-]*test[-_]plan[\w./\\+-]*\.md)/gi;
  const seen = new Set();
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (/\$SLUG|\{|\}|<|>/.test(raw)) continue; // an un-substituted template, handled separately
    const abs = expand(raw);
    results.push({ raw, abs, exists: Boolean(abs) && fs.existsSync(abs) });
  }
  return results;
}

function unbackedNoIssues(text) {
  const bad = [];
  const paras = text.split(/\r?\n\s*\r?\n/);
  for (const p of paras) {
    if (!/no issues? (found|flagged)|nothing (was )?flagged|looks good\b/i.test(p)) continue;
    const backed = /examin|check|read|review|inspect|grep|ran |trace/i.test(p) && p.trim().length >= 120;
    if (!backed) bad.push(p.trim().replace(/\s+/g, " ").slice(0, 120));
  }
  return bad;
}

function requirements(phases) {
  const R = [];
  const add = (id, phase, label, test) => R.push({ id, phase, label, test });

  add("ceo.premises", "ceo", "premise challenge names the premises it evaluated", (t) =>
    /premise/i.test(t) && /\bpremise[s]?\b[\s\S]{0,400}?(valid|assumed|challenge|accept|reject)/i.test(t));
  add("ceo.not-in-scope", "ceo", '"NOT in scope" section', (t) => /not\s+in\s+scope/i.test(t));
  add("ceo.already-exists", "ceo", '"What already exists" section', (t) => /what\s+already\s+exists/i.test(t));
  add("ceo.rescue-registry", "ceo", "Error & Rescue Registry", (t) => /error\s*(&|and)\s*rescue\s*registry/i.test(t));
  add("ceo.failure-modes", "ceo", "Failure Modes Registry", (t) => /failure\s*modes/i.test(t));
  add("ceo.dream-state", "ceo", "dream state delta", (t) => /dream\s*state/i.test(t));
  add("ceo.voices", "ceo", "CEO dual voices ran or were explicitly unavailable", (t) =>
    /CEO DUAL VOICES|CODEX SAYS \(CEO|CLAUDE SUBAGENT \(CEO|codex-unavailable|single-reviewer|subagent-only|codex-only/i.test(t));

  add("eng.architecture", "eng", "architecture diagram (Section 1)", (t) => hasDiagram(t));
  add("eng.test-diagram", "eng", "test diagram mapping codepaths to coverage", (t) =>
    /test\s*(diagram|coverage\s*map)/i.test(t));
  add("eng.test-plan-artifact", "eng", "test plan artifact named AND present on disk", (t) => {
    const found = namedArtifactsExist(t);
    return found.length > 0 && found.every((f) => f.exists);
  });
  add("eng.not-in-scope", "eng", '"NOT in scope" section', (t) => /not\s+in\s+scope/i.test(t));
  add("eng.voices", "eng", "Eng dual voices ran or were explicitly unavailable", (t) =>
    /ENG DUAL VOICES|CODEX SAYS \(eng|CLAUDE SUBAGENT \(eng|codex-unavailable|single-reviewer|subagent-only|codex-only/i.test(t));

  if (phases.includes("design")) {
    add("design.dimensions", "design", "all 7 design dimensions scored", (t) => (t.match(/\b(10|[0-9])\s*\/\s*10\b/g) ?? []).length >= 7);
    add("design.voices", "design", "design dual voices ran or were explicitly unavailable", (t) =>
      /design\s*(litmus|dual voices|consensus)|CODEX SAYS \(design|CLAUDE SUBAGENT \(design|codex-unavailable|single-reviewer/i.test(t));
  }

  if (phases.includes("dx")) {
    add("dx.journey", "dx", "developer journey map", (t) => /developer\s*journey/i.test(t));
    add("dx.tthw", "dx", "TTHW assessment with a number", (t) => /tthw[^\n]{0,80}\d/i.test(t));
    add("dx.scorecard", "dx", "all 8 DX dimensions scored", (t) => (t.match(/\b(10|[0-9])\s*\/\s*10\b/g) ?? []).length >= 8);
    add("dx.voices", "dx", "DX dual voices ran or were explicitly unavailable", (t) =>
      /DX DUAL VOICES|CODEX SAYS \(DX|CLAUDE SUBAGENT \(DX|codex-unavailable|single-reviewer|subagent-only|codex-only/i.test(t));
  }

  add("audit.trail", "all", "Decision Audit Trail has at least one real row", (t) => auditRows(t) >= 1);
  add("gate.no-placeholder-tables", "all", "no consensus table left as the unfilled template", (t) => placeholderRows(t).length < 3);
  add("gate.no-unbacked-clean", "all", '"no issues found" is backed by what was examined', (t) => unbackedNoIssues(t).length === 0);

  return R;
}

function verifyPlan(planText, phases) {
  const reqs = requirements(phases);
  const results = reqs.map((r) => {
    let pass = false;
    try {
      pass = Boolean(r.test(planText));
    } catch {
      pass = false; // a check that throws is a check that did not pass
    }
    return { ...r, pass };
  });
  return results;
}

function phasesFor(args, plan) {
  const explicit = valueOf(args, "--phases");
  if (explicit) return { phases: explicit.split(",").map((s) => s.trim()).filter(Boolean), source: "--phases" };
  const stamp = readStamp(plan.text);
  if (stamp) return { phases: stamp.phases, source: "the preflight stamp in the plan file" };
  return { phases: null, source: null };
}

function cmdVerify(args) {
  const json = args.includes("--json");
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else err(`\n  UNUSABLE  ${plan.error}\n`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const { phases, source } = phasesFor(args, plan);
  if (!phases) {
    const msg =
      "the plan carries no tb-autoplan stamp and --phases was not given, so the set of " +
      "phases that were supposed to run is unknown. Run `preflight --plan <file> --stamp` first. " +
      "Refusing to certify a review whose required scope cannot be established.";
    if (json) out(JSON.stringify({ verdict: "UNDETERMINED", exit: EXIT_UNDETERMINED, error: msg }, null, 2));
    else err(`\n  UNDETERMINED  ${msg}\n`);
    process.exitCode = EXIT_UNDETERMINED;
    return;
  }

  const results = verifyPlan(plan.text, phases);
  const missing = results.filter((r) => !r.pass);
  const code = missing.length ? EXIT_REJECTED : EXIT_OK;

  if (json) {
    out(
      JSON.stringify(
        {
          verdict: code === EXIT_OK ? "COMPLETE" : "INCOMPLETE",
          exit: code,
          plan: plan.path,
          phases,
          phaseSource: source,
          checked: results.map((r) => ({ id: r.id, phase: r.phase, label: r.label, pass: r.pass })),
          missing: missing.map((r) => r.id),
        },
        null,
        2,
      ),
    );
  } else {
    out();
    out(`  ${plan.path}`);
    out(`  phases (${source}): ${phases.join(", ")}`);
    out();
    const width = Math.max(...results.map((r) => r.id.length));
    for (const r of results) out(`  ${r.pass ? "ok " : "no "}  ${r.id.padEnd(width)}  ${r.label}`);
    out();
    if (code === EXIT_OK) {
      out(`  COMPLETE  ${results.length}/${results.length} required outputs are present in the plan file.`);
    } else {
      out(`  INCOMPLETE  ${missing.length} of ${results.length} required outputs are missing:`);
      for (const r of missing) out(`    ${r.id}: ${r.label}`);
      out();
      out("  Produce them and run this again. Do not present the final approval gate");
      out("  and do not write a review record until this exits 0.");
    }
    out();
  }
  process.exitCode = code;
}

// ------------------------------------------------------------------- record

function cmdRecord(args) {
  const json = args.includes("--json");
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else err(`\n  UNUSABLE  ${plan.error}\n`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const { phases, source } = phasesFor(args, plan);
  if (!phases) {
    const msg = "no tb-autoplan stamp and no --phases: run `preflight --plan <file> --stamp` first";
    if (json) out(JSON.stringify({ verdict: "UNDETERMINED", exit: EXIT_UNDETERMINED, error: msg }, null, 2));
    else err(`\n  UNDETERMINED  ${msg}\n`);
    process.exitCode = EXIT_UNDETERMINED;
    return;
  }

  const results = verifyPlan(plan.text, phases);
  const missing = results.filter((r) => !r.pass);
  if (missing.length) {
    const msg = `refusing to write a review record: ${missing.length} required output(s) are missing (${missing
      .map((r) => r.id)
      .join(", ")})`;
    if (json) out(JSON.stringify({ verdict: "REFUSED", exit: EXIT_REJECTED, error: msg, missing: missing.map((r) => r.id) }, null, 2));
    else {
      err(`\n  REFUSED  ${msg}`);
      err("           Nothing was written. A review record is a claim that the review");
      err("           happened; it is not the model's to assert.\n");
    }
    process.exitCode = EXIT_REJECTED;
    return;
  }

  const outFile = expand(valueOf(args, "--out") ?? path.join(stateDir(), "reviews.jsonl"));
  const commit = gitShort(path.dirname(plan.path));
  const branch = valueOf(args, "--branch") ?? gitBranch(path.dirname(plan.path));
  const ts = new Date().toISOString();
  const checked = results.map((r) => r.id);
  const lines = phases.map((p) =>
    JSON.stringify({
      skill: `plan-${p === "dx" ? "devex" : p}-review`,
      via: "autoplan",
      timestamp: ts,
      status: "clean",
      verified: true,
      verified_by: `tb-autoplan ${VERSION}`,
      requirements_checked: checked.filter((id) => id.startsWith(`${p}.`) || id.startsWith("gate.") || id.startsWith("audit.")),
      plan: plan.path,
      branch,
      commit,
    }),
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, `${lines.join("\n")}\n`, "utf8");

  if (json) out(JSON.stringify({ verdict: "RECORDED", exit: EXIT_OK, file: outFile, phases, phaseSource: source, records: lines.length }, null, 2));
  else {
    out();
    out(`  RECORDED  ${lines.length} verified review record(s) -> ${outFile}`);
    out(`  Every one carries verified:true and the requirement ids that were checked,`);
    out(`  so a downstream reader can tell a proven review from an asserted one.`);
    out();
  }
}

function gitShort(cwd) {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
function gitBranch(cwd) {
  const r = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { cwd = process.cwd(), env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * gstack's Implementation Tasks aggregator, from autoplan/SKILL.md:1647-1701.
 *
 * Only the three variable initialisations at the top are substituted (the
 * original derives them from `gstack-slug`, `git branch --show-current` and
 * `git log`). The jq pipeline, the `command -v jq` gate, the `2>/dev/null ||
 * true` on every call, and the fallback string are verbatim.
 */
const GSTACK_AGGREGATOR = String.raw`
TASKS_DIR="$TB_FIXTURE_DIR"
BRANCH="$TB_FIXTURE_BRANCH"
COMMITS_RECENT="$TB_FIXTURE_COMMITS"

AGGREGATED_TASKS=""
if command -v jq >/dev/null 2>&1; then
  ALL_JSONL=$(mktemp -t autoplan-tasks.XXXXXXXX)
  for phase in ceo-review design-review eng-review devex-review; do
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      jq -c --arg branch "$BRANCH" --arg commits "$COMMITS_RECENT" \
        'select(.branch == $branch and ($commits | split("|") | index(.commit) != null))' \
        "$f" 2>/dev/null >> "$ALL_JSONL" || true
    done < <(find "$TASKS_DIR" -maxdepth 1 -name "tasks-$phase-*.jsonl" 2>/dev/null | sort)
    if [ -s "$ALL_JSONL" ]; then
      jq -sc --arg phase "$phase" \
        '[.[] | select(.phase == $phase)] | (max_by(.run_id) // null) as $latest_run | if $latest_run then map(select(.run_id == $latest_run.run_id)) else [] end | .[]' \
        "$ALL_JSONL" > "$ALL_JSONL.phase" 2>/dev/null || true
      jq -c --arg phase "$phase" 'select(.phase != $phase)' "$ALL_JSONL" > "$ALL_JSONL.other" 2>/dev/null || true
      cat "$ALL_JSONL.other" "$ALL_JSONL.phase" > "$ALL_JSONL"
      rm -f "$ALL_JSONL.phase" "$ALL_JSONL.other"
    fi
  done
  AGGREGATED_TASKS=$(jq -s \
    'group_by([.component, (.files | sort), .title])
     | map(
         sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99) | .[0]
       )
     | sort_by({P1:0,P2:1,P3:2}[.priority] // 99, {"ceo-review":0,"design-review":1,"eng-review":2,"devex-review":3}[.phase] // 99)
     | if length == 0 then "_No actionable tasks emitted from any phase._" else
         map("- [ ] **\(.id) (\(.priority), human: \(.effort_human) / CC: \(.effort_cc)) — \(.component)** — \(.title)\n  - Surfaced by: \(.phase) — \(.source_finding)\n  - Files: \(.files | join(", "))") | join("\n")
       end' "$ALL_JSONL" 2>/dev/null | sed 's/^"//;s/"$//;s/\\n/\n/g')
  rm -f "$ALL_JSONL"
else
  AGGREGATED_TASKS="_jq not installed — install jq to aggregate per-phase task lists. Skipping._"
fi
printf '%s\n' "$AGGREGATED_TASKS"
`;

function task(overrides) {
  return JSON.stringify({
    id: "T1",
    title: "add a retry to the webhook sender",
    phase: "eng-review",
    priority: "P1",
    component: "webhooks",
    files: ["src/hooks.ts"],
    effort_human: "2h",
    effort_cc: "10m",
    source_finding: "no retry on 5xx",
    run_id: "2026-08-13T00-00-00",
    branch: "feature",
    commit: "abc123",
    ...overrides,
  });
}

const COMPLETE_PLAN = `<!-- tb-autoplan v${VERSION} phases=ceo,eng ui=no dx=no -->
# Plan: retry the webhook sender

## Premises
Premise 1: senders drop 5xx responses. Evaluated and accepted, the access log
shows 41 dropped deliveries this week.

## What already exists
src/hooks.ts already has a queue; the retry loop is the missing piece.

## NOT in scope
Rewriting the queue. Deferred to TODOS.md.

## Error & Rescue Registry
| Error | Rescue |
|---|---|
| 5xx from the receiver | requeue with backoff |

## Failure Modes
| Mode | Impact | Mitigation |
|---|---|---|
| poison message | queue stalls | dead-letter after 5 tries |

## Dream state
CURRENT -> THIS PLAN -> 12-MONTH IDEAL: at-least-once delivery everywhere.

## CEO DUAL VOICES — CONSENSUS TABLE
  1. Premises valid?            YES     YES    CONFIRMED
  2. Right problem to solve?    YES     YES    CONFIRMED

## Architecture
\`\`\`
sender.ts --> queue.ts --> hooks.ts
              |               |
              +--> retry.ts --+
\`\`\`

## Test diagram
| Codepath | Test type | Exists? |
|---|---|---|
| retry on 5xx | unit | no, added by this plan |

Test plan artifact: __TEST_PLAN__

## ENG DUAL VOICES — CONSENSUS TABLE
  1. Architecture sound?        YES     YES    CONFIRMED

## Decision Audit Trail
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | eng | add dead-letter queue | mechanical | P1 completeness | covers the poison case | defer it |
`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-autoplan-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  const skip = (name, why) => results.push({ name, skip: true, detail: why });

  // A skills root that contains all four review skills, and one that is missing
  // the eng review. Only SKILL.md's presence matters to preflight.
  const goodRoot = path.join(tmp, "skills-good");
  const partialRoot = path.join(tmp, "skills-partial");
  for (const [root, skills] of [
    [goodRoot, ["plan-ceo-review", "plan-design-review", "plan-eng-review", "plan-devex-review"]],
    [partialRoot, ["plan-ceo-review", "plan-design-review", "plan-devex-review"]],
  ]) {
    for (const s of skills) {
      fs.mkdirSync(path.join(root, s), { recursive: true });
      fs.writeFileSync(path.join(root, s, "SKILL.md"), `---\nname: ${s}\n---\nmethodology\n`, "utf8");
    }
  }
  const ROOTS = { TOOLBAY_AUTOPLAN_SKILL_ROOTS: goodRoot };
  const PARTIAL = { TOOLBAY_AUTOPLAN_SKILL_ROOTS: partialRoot };

  const write = (name, body) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  // ---------------------------------------------------------------- preflight
  const plainPlan = write("plain.md", "# Plan\n\nMake the invoice total round to two decimals.\n");
  const uiPlan = write("ui.md", "# Plan\n\nAdd a dashboard screen with a modal and a save button.\n");
  const dxPlan = write("dx.md", "# Plan\n\nShip a CLI and a REST endpoint for partners.\n");
  const codeOnlyDxPlan = write(
    "codeonly.md",
    "# Plan\n\nRound the invoice total.\n\n```js\nimport fs from 'fs';\nconst pkg = require('./package.json');\n```\n",
  );

  {
    const r = runSelf(["preflight", "--plan", plainPlan, "--json"], { env: ROOTS });
    check("preflight accepts a plan whose methodology is all present", 0, r.status, r.stderr.trim());
    const j = JSON.parse(r.stdout || "{}");
    check("...and runs only the two mandatory phases", "ceo,eng", (j.phases ?? []).join(","));
  }
  {
    const j = JSON.parse(runSelf(["preflight", "--plan", uiPlan, "--json"], { env: ROOTS }).stdout || "{}");
    check("preflight adds the design phase for a UI plan", "ceo,design,eng", (j.phases ?? []).join(","));
    check("...and names the terms that made it decide", true, (j.ui?.terms ?? []).length >= 2, (j.ui?.terms ?? []).join(","));
  }
  {
    const j = JSON.parse(runSelf(["preflight", "--plan", dxPlan, "--json"], { env: ROOTS }).stdout || "{}");
    check("preflight adds the DX phase for a developer-facing plan", "ceo,eng,dx", (j.phases ?? []).join(","));
  }
  {
    const j = JSON.parse(runSelf(["preflight", "--plan", codeOnlyDxPlan, "--json"], { env: ROOTS }).stdout || "{}");
    check(
      "preflight does NOT infer DX scope from terms that only appear inside a code block",
      false,
      Boolean(j.dx?.detected),
      (j.dx?.terms ?? []).join(","),
    );
  }
  {
    const r = runSelf(["preflight", "--plan", plainPlan, "--json"], { env: PARTIAL });
    check("preflight REFUSES when a required review skill is not installed", 3, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...and names the one it could not find", "plan-eng-review", (j.missing ?? []).join(","));
  }
  check("preflight refuses a plan file that does not exist", 2, runSelf(["preflight", "--plan", path.join(tmp, "nope.md"), "--json"], { env: ROOTS }).status);
  check("preflight refuses an empty plan file", 2, runSelf(["preflight", "--plan", write("empty.md", "   \n"), "--json"], { env: ROOTS }).status);

  // --------------------------------------------------------------------- tasks
  const tasksDir = path.join(tmp, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, "tasks-eng-review-2026.jsonl"),
    `${task({})}\n${task({ id: "T2", title: "add dead-letter queue", priority: "P2" })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(tasksDir, "tasks-ceo-review-2026.jsonl"),
    `${task({ id: "C1", phase: "ceo-review", title: "cut the admin page", priority: "P1", component: "scope" })}\n`,
    "utf8",
  );
  {
    const r = runSelf(["tasks", "--dir", tasksDir, "--branch", "feature", "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("tasks aggregates every phase's list without jq", 3, j.count ?? 0, r.stderr.trim());
    check("...highest priority first, CEO before Eng inside a priority", "C1", (j.tasks ?? [])[0]?.id ?? "(none)");
    check("...and renders the gate's markdown", true, /^- \[ \] \*\*C1 \(P1/.test(j.markdown ?? ""));
  }
  {
    // The A/B: gstack's own aggregator, verbatim, on the same fixture.
    const bash = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true });
    if (bash.error || bash.status !== 0) {
      skip("gstack's jq aggregator on the same fixture", "bash is not available to run it");
    } else {
      const script = path.join(tmp, "gstack-agg.sh");
      fs.writeFileSync(script, GSTACK_AGGREGATOR, "utf8");
      const res = spawnSync("bash", [script], {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          TB_FIXTURE_DIR: tasksDir,
          TB_FIXTURE_BRANCH: "feature",
          TB_FIXTURE_COMMITS: "abc123",
        },
      });
      const gstackLines = (res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().startsWith("- [ ]")).length;
      const ours = JSON.parse(runSelf(["tasks", "--dir", tasksDir, "--branch", "feature", "--json"]).stdout || "{}").count ?? 0;
      check(
        "tb tasks surfaces more tasks than gstack's jq pipeline on the same fixture",
        true,
        ours > gstackLines,
        `ours=${ours} gstack=${gstackLines}; gstack said: ${(res.stdout ?? "").trim().split("\n")[0]}`,
      );
    }
  }
  {
    const emptyDir = path.join(tmp, "tasks-empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const r = runSelf(["tasks", "--dir", emptyDir, "--json"]);
    check("tasks reports a verified empty directory as exit 0", 0, r.status);
    check("...labelled so it cannot be confused with a failed lookup", "NO_TASK_FILES", JSON.parse(r.stdout || "{}").verdict ?? "");
  }
  check(
    "tasks refuses a directory it cannot list, instead of reporting no tasks",
    2,
    runSelf(["tasks", "--dir", path.join(tmp, "does-not-exist"), "--json"]).status,
  );
  {
    const badDir = path.join(tmp, "tasks-bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "tasks-eng-review-x.jsonl"), "{not json\n{also not json\n", "utf8");
    const r = runSelf(["tasks", "--dir", badDir, "--json"]);
    check("tasks refuses when every task line is unparseable", 2, r.status);
  }
  {
    const mixedDir = path.join(tmp, "tasks-mixed");
    fs.mkdirSync(mixedDir, { recursive: true });
    fs.writeFileSync(path.join(mixedDir, "tasks-eng-review-x.jsonl"), `${task({})}\n{broken\n`, "utf8");
    const j = JSON.parse(runSelf(["tasks", "--dir", mixedDir, "--json"]).stdout || "{}");
    check("tasks reports a bad line rather than dropping it silently", 1, (j.badLines ?? []).length, (j.badLines ?? [])[0] ?? "");
  }

  // -------------------------------------------------------------------- verify
  const testPlanArtifact = write("branch-test-plan-2026.md", "# test plan\n");
  const goodPlanBody = COMPLETE_PLAN.replace("__TEST_PLAN__", testPlanArtifact.replace(/\\/g, "/"));
  const goodPlan = write("good-plan.md", goodPlanBody);
  {
    const r = runSelf(["verify", "--plan", goodPlan, "--json"]);
    const j = JSON.parse(r.stdout || "{}");
    check("verify passes a plan that contains every required output", 0, r.status, (j.missing ?? []).join(","));
    check("...taking the phase list from the stamp, not from a guess", "the preflight stamp in the plan file", j.phaseSource ?? "");
  }
  {
    const p = write("no-stamp.md", goodPlanBody.replace(/<!-- tb-autoplan[^>]*-->\n/, ""));
    check("verify REFUSES a plan with no preflight stamp rather than assuming the phases", 3, runSelf(["verify", "--plan", p, "--json"]).status);
  }
  {
    const p = write("missing-artifact.md", goodPlanBody.replace(testPlanArtifact.replace(/\\/g, "/"), path.join(tmp, "never-written-test-plan.md").replace(/\\/g, "/")));
    const r = runSelf(["verify", "--plan", p, "--json"]);
    check("verify catches a test plan artifact the plan claims but never wrote", 1, r.status);
    check("...naming that requirement", true, (JSON.parse(r.stdout || "{}").missing ?? []).includes("eng.test-plan-artifact"));
  }
  {
    const p = write("no-diagram.md", goodPlanBody.replace(/```\n[\s\S]*?```/, "Architecture: looks fine."));
    check("verify catches a missing architecture diagram", 1, runSelf(["verify", "--plan", p, "--json"]).status);
  }
  {
    const placeholder = `<!-- tb-autoplan v${VERSION} phases=ceo,eng ui=no dx=no -->
## CEO DUAL VOICES — CONSENSUS TABLE
  1. Premises valid?                   —       —      —
  2. Right problem to solve?           —       —      —
  3. Scope calibration correct?        —       —      —
  4. Alternatives explored?            —       —      —
`;
    const r = runSelf(["verify", "--plan", write("placeholder.md", placeholder), "--json"]);
    check("verify rejects a consensus table left as the unfilled template", 1, r.status);
    check("...by that name", true, (JSON.parse(r.stdout || "{}").missing ?? []).includes("gate.no-placeholder-tables"));
  }
  {
    const p = write(
      "unbacked.md",
      `${goodPlanBody}\n\n## Section 4 (Performance)\n\nNo issues found.\n`,
    );
    const r = runSelf(["verify", "--plan", p, "--json"]);
    check('verify rejects a bare "no issues found" with nothing examined', 1, r.status);
    check("...by that name", true, (JSON.parse(r.stdout || "{}").missing ?? []).includes("gate.no-unbacked-clean"));
  }
  {
    const p = write(
      "backed.md",
      `${goodPlanBody}\n\n## Section 4 (Performance)\n\nNo issues found. I read src/hooks.ts:40-120 and the queue consumer, checked for N+1 reads around the delivery loop, and traced the batch fetch; every send is already batched by receiver id.\n`,
    );
    check('verify accepts "no issues found" when it says what was examined', 0, runSelf(["verify", "--plan", p, "--json"]).status);
  }
  {
    const p = write("no-audit.md", goodPlanBody.replace(/## Decision Audit Trail[\s\S]*$/, ""));
    check("verify catches an empty decision audit trail", 1, runSelf(["verify", "--plan", p, "--json"]).status);
  }
  {
    const uiStamped = write(
      "ui-stamped.md",
      goodPlanBody.replace("phases=ceo,eng", "phases=ceo,design,eng"),
    );
    const r = runSelf(["verify", "--plan", uiStamped, "--json"]);
    check("verify demands the design outputs when the design phase was in scope", 1, r.status);
    check("...listing the design requirements", true, (JSON.parse(r.stdout || "{}").missing ?? []).some((m) => m.startsWith("design.")));
  }

  // -------------------------------------------------------------------- record
  {
    const recFile = path.join(tmp, "reviews-refused.jsonl");
    const badPlan = write("bad-for-record.md", goodPlanBody.replace(/## Decision Audit Trail[\s\S]*$/, ""));
    const r = runSelf(["record", "--plan", badPlan, "--out", recFile, "--json"]);
    check("record REFUSES to log a review whose outputs are missing", 1, r.status);
    check("...and writes no file at all", false, fs.existsSync(recFile));
  }
  {
    const recFile = path.join(tmp, "reviews-ok.jsonl");
    const r = runSelf(["record", "--plan", goodPlan, "--out", recFile, "--json"]);
    check("record logs a verified review", 0, r.status, r.stderr.trim());
    const lines = fs.existsSync(recFile) ? fs.readFileSync(recFile, "utf8").trim().split("\n") : [];
    check("...one record per phase", 2, lines.length);
    const first = lines.length ? JSON.parse(lines[0]) : {};
    check("...carrying verified:true", true, first.verified === true);
    check("...and the requirement ids that were actually checked", true, Array.isArray(first.requirements_checked) && first.requirements_checked.length > 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-autoplan", results);
}

// -------------------------------------------------------------------- output

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
  process.stdout.write("\n  Every case above that involves a broken input is a case gstack's /autoplan\n");
  process.stdout.write("  passes through: a review skill that is not installed, a task list it cannot\n");
  process.stdout.write("  read, a consensus table still full of template dashes, an artifact the plan\n");
  process.stdout.write("  claims to have written that is not on disk. Here each one exits non-zero\n");
  process.stdout.write("  before the pipeline can call itself done.\n\n");
  return true;
}

// ---------------------------------------------------------------------- entry

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}
function allValuesOf(args, flag) {
  const found = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] && !args[i + 1].startsWith("--")) found.push(args[i + 1]);
  });
  return found;
}

function help() {
  out(`
  tb-autoplan ${VERSION}  (Toolbay Stack)

  preflight --plan <f> [--stamp]   resolve the plan, detect UI/DX scope, and
                                   locate the review methodology for every phase
                                   that must run. Refuses if any is missing.
  tasks --dir <d> [--branch <b>]   aggregate the per-phase task lists into the
        [--repo <r>] [--commit-window N]   final gate's markdown. No jq.
  verify --plan <f> [--phases ...] check the plan file for every required output
                                   of every phase that was in scope
  record --plan <f> [--out <f>]    write review records, but only if verify passes
  selftest                         prove all of the above against broken inputs

  Options: --json

  Exit codes:
    0  the check ran and passed
    1  the check ran and FAILED (verify found missing outputs, record refused)
    2  the input could not be read (never the same as "nothing found")
    3  a precondition could not be established: a required review skill is not
       installed, or the plan carries no preflight stamp
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
try {
  if (cmd === "preflight") cmdPreflight(argv.slice(1));
  else if (cmd === "tasks") cmdTasks(argv.slice(1));
  else if (cmd === "verify") cmdVerify(argv.slice(1));
  else if (cmd === "record") cmdRecord(argv.slice(1));
  else if (cmd === "selftest") selftest();
  else help();
} catch (e) {
  // A crash is not a pass.
  err(`\n  tb-autoplan crashed: ${e?.stack ?? e}\n`);
  process.exitCode = EXIT_UNUSABLE;
}
