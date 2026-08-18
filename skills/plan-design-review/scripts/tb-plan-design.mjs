#!/usr/bin/env node
/**
 * tb-plan-design.mjs: the mechanical parts of /plan-design-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The review methodology this supports (designer's-eye plan review;
 * the nine design principles; the twelve cognitive patterns; the UX laws; the
 * seven review passes Information Architecture / Interaction State Coverage /
 * User Journey / AI Slop Risk / Design System Alignment / Responsive &
 * Accessibility / Unresolved Decisions; the 0-10 rate-gap-fix-rerate method; the
 * design hard rules, litmus checks and AI-slop blacklist; the required outputs,
 * the Approved Mockups table, the Completion Summary and the exit-plan-mode
 * gate) comes from `plan-design-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or endorsed
 * by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * The review is a prompt and stays a prompt. Taste does not compile. What is
 * code here is only the handful of places where gstack's version asks the model
 * to certify its own output, or asks a POSIX shell for something Windows does
 * not have. Each one fails in the same direction: the review reports itself
 * finished having left the plan no better than it found it.
 *
 * 1. THE STATE TABLE SHIPS AS A TEMPLATE OF PLACEHOLDERS. Pass 2 is the single
 *    highest-value pass in the skill: loading, empty, error, success, partial.
 *    gstack hands the model this to fill in
 *      FEATURE              | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
 *      ---------------------|---------|-------|-------|---------|--------
 *      [each UI feature]    | [spec]  | [spec]| [spec]| [spec]  | [spec]
 *    and then asks it, at the end, to confirm it did the pass. A plan carrying
 *    that block verbatim satisfies every self-check in the file: the table is
 *    there, the pass is named, the Completion Summary can honestly say Pass 2
 *    ran. `states` reads the cells. A cell holding `[spec]`, a dash or nothing
 *    is not a specification, and the engineer who implements from it ships
 *    "No items found." — which is the exact outcome the pass exists to prevent.
 *
 * 2. THE COMPLETION SUMMARY SHIPS WITH ITS BLANKS IN. Same failure one level up:
 *    `| Pass 1  (Info Arch)  | ___/10 -> ___/10 after fixes |`, seven times.
 *    Pasted verbatim it looks exactly like a finished review.
 *
 * 3. THE APPROVED MOCKUPS TABLE IS A PATH NOBODY OPENS UNTIL LATER. This is the
 *    one output of the whole skill that is meant to outlive the conversation:
 *    "Include the full path to each approved mockup... These persist across
 *    conversations and workspaces. The implementer reads this to know exactly
 *    which visual to build from." Nothing checks the path. gstack's own template
 *    row is `~/.gstack/projects/$SLUG/designs/[folder]/[filename].png`, and its
 *    "Show me what 10/10 looks like" step writes mockups to
 *    `/tmp/gstack-ideal-<dimension>.png`. On Windows 11, 2026-08-14:
 *
 *      $ echo x > /tmp/tbs-probe-mockup.png            # Git Bash
 *      $ cd /tmp && pwd -W
 *      C:/Users/orion/AppData/Local/Temp
 *      $ node -e "console.log(require('fs').existsSync('/tmp/tbs-probe-mockup.png'))"
 *      false
 *
 *    Git Bash's /tmp is the user's AppData Temp; Node's (and therefore the Read
 *    tool's, and the implementer's) /tmp is C:\tmp, which does not exist. So the
 *    mockup the plan tells someone to build from cannot be opened by the agent
 *    that wrote the line, on the machine that wrote it, in the same session. Add
 *    a temp directory that Windows empties and the durable artifact is gone
 *    before anyone reads the plan. `mockups` resolves every path in the table,
 *    decodes the image, reads its real dimensions, and refuses a location that
 *    is volatile by construction.
 *
 * 4. PASS 4 ASKS THE AUTHOR TO GRADE THE AUTHOR. The AI-slop blacklist and the
 *    universal hard rules are a list of textual patterns ("no default font
 *    stacks (Inter, Roboto, Arial, system)", "generic hero copy", "3-column
 *    feature grid", "clean, modern UI is meaningless"), and the model asked to
 *    find them in the plan is usually the model that wrote the plan. `slop`
 *    greps for them and prints line numbers. It is not taste, it is the part of
 *    taste that was already written down as a rule.
 *
 * 5. THE TASKS ARTIFACT IS GATED ON jq, AND FAILS TO A LIE. The Required Outputs
 *    section builds `tasks-design-review-*.jsonl` with `jq -nc --arg ... >>
 *    "$TASKS_FILE"`, and documents the fallback as "skip the JSONL write". On
 *    Windows 11, 2026-08-14: `command -v jq || echo "JQ: ABSENT"` -> JQ: ABSENT.
 *    The shell creates the redirect target before jq fails, so the file exists
 *    and is empty, and the same section defines empty as "ran, no findings —
 *    distinct from didn't run". So every task this review surfaced is dropped,
 *    and the drop is indistinguishable from a review that found nothing.
 *
 * 6. THE REVIEW LOG IS WRITTEN BEFORE THE GATE. gstack's Review Log step runs
 *    unconditionally and sits ahead of the exit gate, so a review that never
 *    produced its report still logs `status: clean` into the dashboard /ship
 *    reads. `record` re-runs the gate and writes nothing unless it passes.
 *
 * Design rules, same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. No path returns "fine" because a check could not run. An
 *     unreadable plan is exit 2, never "no findings".
 *   - NO INTERPRETER BUT NODE. No jq, no `eval "$(gstack-slug)"`, no
 *     `source <(...)`, no `find -mmin`, no `ls -t <glob> | head -1`, no `/tmp`,
 *     no `date +%s`, no `$PPID`, no `open`. Every one of those is in the gstack
 *     version of this skill and none of them are Windows-safe.
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

const isWindows = process.platform === "win32";

// --------------------------------------------------------------------- paths

function expand(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^["'`]|["'`]$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
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
    if (base) return { slug: sanitizeSlug(base), source: "origin remote" };
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (top.ok && top.text) return { slug: sanitizeSlug(path.basename(top.text)), source: "repository directory name" };
  const abs = expand(repo) ?? process.cwd();
  return { slug: sanitizeSlug(path.basename(abs)), source: "working directory name (not a git repository)" };
}

function currentBranch(repo) {
  const b = git(repo, ["branch", "--show-current"]);
  if (b.ok && b.text) return { ok: true, branch: b.text, safe: b.text.replace(/\//g, "-") };
  const d = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (d.ok && d.text) return { ok: true, branch: d.text, safe: d.text.replace(/\//g, "-") };
  return { ok: false, error: b.error ?? "no branch" };
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
  if (!text.trim()) return { ok: false, error: `plan file ${abs} is empty, so there is nothing to review` };
  return { ok: true, path: abs, text };
}

// ------------------------------------------------------------------ UI scope
//
// Two different readings of the same file, on purpose:
//
//   detectUiScope  strips fenced and indented code before matching, because a
//                  plan that pastes a React snippet is not thereby a UI plan,
//                  and this decides whether the whole review runs at all
//                  ("This plan has no UI scope. A design review isn't
//                  applicable.").
//   slop lint      does NOT strip code, because `font-family: Inter` inside a
//                  fence is the specification, not an illustration. That is the
//                  one place the rule bites hardest.

function prose(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^( {4}|\t).*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ");
}

const UI_TERMS = [
  "ui", "ux", "screen", "page", "component", "button", "form", "modal", "dialog",
  "layout", "dashboard", "sidebar", "nav", "navigation", "responsive", "mobile",
  "design system", "empty state", "onboarding flow", "frontend", "viewport",
];

const MIN_DISTINCT_TERMS = 2;

function detectUiScope(text) {
  const hay = prose(text).toLowerCase();
  const terms = [];
  for (const t of UI_TERMS) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`, "i").test(hay)) terms.push(t);
  }
  return { detected: terms.length >= MIN_DISTINCT_TERMS, terms };
}

// --------------------------------------------------------------- slop lint
//
// Every rule below is a rule gstack already wrote down, in "Design Hard Rules",
// "Universal rules" and the "AI Slop blacklist". The only change is that these
// are matched instead of recalled, and each hit carries a line number so the
// finding can be argued with.

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/**
 * A plan that says "avoid purple gradients" must not be flagged for saying
 * "purple gradient". This is the difference between a lint someone keeps and a
 * lint someone disables on day two, so the negation guard is tested.
 */
const NEGATORS = /\b(avoid|avoids|avoiding|no|not|never|without|instead of|rather than|reject|rejects|rejected|rejection|forbid|forbidden|ban|banned|blacklist|anti-pattern|antipattern|slop|do not|don't|dont|free of|nothing like|checked for|flag(ged)? if|violat\w*)\b/i;

const SLOP_RULES = [
  {
    id: "font.default-stack",
    label: "a default font stack is named as the typeface",
    why: 'gstack universal rule: "No default font stacks (Inter, Roboto, Arial, system)". Blacklist 11 calls system-ui the "I gave up on typography" signal.',
    test: (l) => /\b(font|typeface|type\s*stack|font-family|typography)\b/i.test(l)
      && /\b(inter|roboto|arial|helvetica(\s+neue)?|system-ui|-apple-system|system\s+font|default\s+(sans|font))\b/i.test(l),
  },
  {
    id: "color.purple-gradient",
    label: "a purple/violet/indigo gradient is specified",
    why: "Blacklist 1: the single most recognisable AI-generated colour scheme.",
    test: (l) => /(purple|violet|indigo)[^.\n]{0,40}(gradient|background|hero)/i.test(l)
      || /gradient[^.\n]{0,40}(purple|violet|indigo)/i.test(l)
      || /#(6366f1|8b5cf6|7c3aed|a855f7|4f46e5)\b/i.test(l),
  },
  {
    id: "layout.three-column-features",
    label: "a 3-column feature grid is specified",
    why: "Blacklist 2: icon-in-circle + bold title + two lines, three times, symmetrically. THE most recognisable AI layout.",
    test: (l) => /\b(3|three)[-\s]?column[^.\n]{0,30}(feature|grid|card)/i.test(l)
      || /\bfeature\s+grid\b/i.test(l)
      || /\b(3|three)\s+feature\s+cards?\b/i.test(l),
  },
  {
    id: "layout.centered-everything",
    label: "everything is centred",
    why: "Blacklist 4: text-align:center on every heading, description and card.",
    test: (l) => /text-align:\s*center/i.test(l) || /\b(centou?r|center|centre|centred|centered)\s+(everything|all\s+(the\s+)?(headings|text|content))/i.test(l),
  },
  {
    id: "decor.icon-circles",
    label: "icons in coloured circles as decoration",
    why: "Blacklist 3: the SaaS starter-template look.",
    test: (l) => /icons?\s+in\s+(a\s+)?(colou?red\s+)?circles?/i.test(l) || /\bicon\s+badges?\b/i.test(l),
  },
  {
    id: "decor.blobs",
    label: "decorative blobs, floating circles or wavy dividers",
    why: "Blacklist 6: if a section feels empty it needs better content, not decoration.",
    test: (l) => /\bblobs?\b/i.test(l) || /floating circles?/i.test(l) || /\b(wavy|wave)\s+(svg\s+)?dividers?/i.test(l),
  },
  {
    id: "decor.emoji",
    label: "emoji used as a design element",
    why: "Blacklist 7: rockets in headings, emoji as bullet points.",
    test: (l) => /^\s*(#{1,6}\s|[-*+]\s)/.test(l) && EMOJI.test(l),
  },
  {
    id: "decor.left-border-cards",
    label: "coloured left border on cards",
    why: "Blacklist 8.",
    test: (l) => /border-left:\s*\d+px/i.test(l) || /colou?red\s+left\s+border/i.test(l),
  },
  {
    id: "copy.generic-hero",
    label: "generic hero copy",
    why: 'Blacklist 9: "Welcome to X", "Unlock the power of", "Your all-in-one solution for".',
    test: (l) => /welcome to (our|the|my|\[|<)/i.test(l)
      || /unlock the power/i.test(l)
      || /all[- ]in[- ]one solution/i.test(l)
      || /take your [^.\n]{0,30} to the next level/i.test(l)
      || /supercharge your/i.test(l),
  },
  {
    id: "copy.vibes",
    label: "a vibe is standing in for a design decision",
    why: 'Design Principle 3, specificity over vibes: "Clean, modern UI" is not a design decision. Name the font, the spacing scale, the interaction pattern.',
    test: (l) => /\bclean,?\s+(and\s+)?modern\b/i.test(l)
      || /\bmodern,?\s+(and\s+)?clean\b/i.test(l)
      || /\bsleek\s+(and|,)/i.test(l)
      || /\bbeautiful,?\s+modern\b/i.test(l)
      || /\b(clean|modern|polished|slick|elegant)\s+(ui|ux|interface|design|look)\b/i.test(l)
      || /\bminimalist aesthetic\b/i.test(l),
  },
  {
    id: "type.tiny-body",
    label: "body type below 16px",
    why: 'Universal rule: "NEVER use small, low-contrast type (body text < 16px)".',
    test: (l) => {
      const m = /font-size:\s*(\d{1,2})px/i.exec(l) || /body[^.\n]{0,24}?\b(\d{1,2})px/i.exec(l);
      return Boolean(m) && Number(m[1]) < 16;
    },
  },
  {
    id: "form.placeholder-as-label",
    label: "placeholder used as the only label",
    why: "Universal rule: labels must stay visible when the field has content.",
    test: (l) => /placeholder[- ]as[- ]label/i.test(l)
      || /placeholders?\s+(as|for)\s+(the\s+)?labels?/i.test(l)
      || /labels?\s+inside\s+the\s+(field|input)/i.test(l),
  },
  {
    id: "rhythm.cookie-cutter",
    label: "cookie-cutter section rhythm",
    why: "Blacklist 10: hero → 3 features → testimonials → pricing → CTA, every section the same height.",
    test: (l) => /hero\s*(->|→|,|then|\/)\s*(3|three)?\s*features?\s*(->|→|,|then|\/)\s*(testimonials?|social proof|pricing)/i.test(l),
  },
  {
    id: "cards.unearned",
    label: "a card grid is the layout",
    why: 'Universal rule: "Cards earn their existence". Hard rejection 1 and 7: a generic SaaS card grid as first impression, an app UI made of stacked cards instead of a layout.',
    test: (l) => /\bcard grid\b/i.test(l) || /\bgrid of cards\b/i.test(l) || /\bstacked cards\b/i.test(l) || /\bdashboard[- ]card mosaic\b/i.test(l),
  },
];

function slopHits(text) {
  const lines = String(text).split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (NEGATORS.test(line)) continue; // a plan that forbids the pattern is not committing it
    for (const rule of SLOP_RULES) {
      if (rule.test(line)) hits.push({ id: rule.id, label: rule.label, why: rule.why, line: i + 1, text: truncate(line, 100) });
    }
  }
  return hits;
}

// ------------------------------------------------------- interaction states
//
// gstack's Pass 2 template is a fenced ASCII table with no leading pipe, so rows
// are detected by pipe count rather than by a leading `|`. That is deliberate:
// the pasted template is exactly the input this has to catch.

const STATE_WORDS = ["loading", "empty", "error", "success", "partial"];
const PLACEHOLDER_CELL = /^\s*(|[-—–]{1,}|\?+|tbd|n\/?a|_{2,}|\.{2,}|\[[^\]]*\]|<[^>]*>|todo|spec)\s*$/i;

function tableRows(text) {
  const lines = String(text).split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if ((l.match(/\|/g) || []).length >= 2) rows.push({ i: i + 1, raw: l, cells: splitCells(l) });
  }
  return rows;
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^[-:\s]+$/.test(c) && c.length > 0);
}

/** The state table, found by its header rather than by where it sits in the file. */
function findStateTable(text) {
  const rows = tableRows(text);
  for (let r = 0; r < rows.length; r += 1) {
    const lower = rows[r].cells.map((c) => c.toLowerCase());
    const covered = STATE_WORDS.filter((w) => lower.some((c) => c.includes(w)));
    if (covered.length >= 3) {
      const header = rows[r];
      const body = [];
      for (let k = r + 1; k < rows.length; k += 1) {
        if (rows[k].i !== rows[k - 1].i + 1) break; // table ended at a blank line
        if (isSeparatorRow(rows[k].cells)) continue;
        body.push(rows[k]);
      }
      return { header, body, covered, missing: STATE_WORDS.filter((w) => !covered.includes(w)) };
    }
  }
  return null;
}

function checkStates(text) {
  const ui = detectUiScope(text);
  const table = findStateTable(text);
  if (!table) {
    return {
      ok: !ui.detected,
      uiScope: ui,
      table: null,
      detail: ui.detected
        ? `the plan is UI-scoped (${ui.terms.length} distinct term(s): ${ui.terms.join(", ")}) but carries no loading/empty/error/success/partial table. Pass 2 is the pass that stops an engineer shipping "No items found." as the empty state.`
        : "no UI scope measured in this plan, so no interaction-state table is required",
      blanks: [],
    };
  }
  const blanks = [];
  for (const row of table.body) {
    row.cells.forEach((cell, idx) => {
      if (PLACEHOLDER_CELL.test(cell)) {
        blanks.push({ line: row.i, column: table.header.cells[idx] ?? `col${idx + 1}`, cell: cell || "(empty)", row: truncate(row.raw, 70) });
      }
    });
  }
  const ok = table.body.length > 0 && blanks.length === 0 && table.missing.length === 0;
  return {
    ok,
    uiScope: ui,
    table: { line: table.header.i, rows: table.body.length, covered: table.covered, missing: table.missing },
    blanks,
    detail: !table.body.length
      ? `a state table header at line ${table.header.i} with no rows under it`
      : table.missing.length
        ? `the state table is missing column(s): ${table.missing.join(", ")}`
        : blanks.length
          ? `${blanks.length} unfilled cell(s), first at line ${blanks[0].line} under "${blanks[0].column}": ${blanks[0].cell}`
          : `${table.body.length} feature row(s), all five states filled`,
  };
}

// ------------------------------------------------------------------ mockups
//
// The Approved Mockups table is the only artifact of this skill that is meant to
// be opened by someone else, later, from a different conversation. So it is the
// only one where a path that does not resolve is not a cosmetic problem.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageInfo(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, error: `could not be read (${e.code || e.message})` };
  }
  if (!buf.length) return { ok: false, error: "is 0 bytes" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return { ok: false, error: "claims to be a PNG but has no IHDR header" };
    return { ok: true, format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let pos = 2;
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xff) { pos += 1; continue; }
      const marker = buf[pos + 1];
      const len = buf.readUInt16BE(pos + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ok: true, format: "jpeg", height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7), bytes: buf.length };
      }
      pos += 2 + len;
    }
    return { ok: false, error: "claims to be a JPEG but carries no frame header" };
  }
  const head = buf.subarray(0, 80).toString("utf8").replace(/\s+/g, " ").trim();
  return { ok: false, error: `is not a PNG or JPEG. First bytes read as text: ${truncate(head, 60)}` };
}

/** Directories whose contents the operating system is allowed to delete without asking. */
function volatileRoots() {
  const roots = [os.tmpdir()];
  if (isWindows) {
    roots.push("C:\\tmp", "C:\\temp");
    for (const v of [process.env.TEMP, process.env.TMP]) if (v) roots.push(v);
  } else {
    roots.push("/tmp", "/var/tmp", "/private/tmp");
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

function isVolatile(abs) {
  const norm = isWindows ? abs.toLowerCase() : abs;
  return volatileRoots().some((r) => {
    const root = isWindows ? r.toLowerCase() : r;
    return norm === root || norm.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

const MIN_MOCKUP_EDGE = 200;

function looksLikePath(cell) {
  return /[\\/]/.test(cell) && /\.(png|jpe?g|webp|gif|html?)\b/i.test(cell);
}

function mockupRows(text) {
  const rows = tableRows(text);
  const found = [];
  for (const row of rows) {
    if (isSeparatorRow(row.cells)) continue;
    const cell = row.cells.find((c) => looksLikePath(stripMd(c)));
    if (cell) found.push({ line: row.i, path: stripMd(cell), row: truncate(row.raw, 90) });
  }
  return found;
}

/**
 * Unwrap a table cell down to the path it holds.
 *
 * THE BUG THIS REPLACES. The previous line was
 *
 *     .replace(/[`*_]/g, "")
 *
 * which strips those characters EVERYWHERE, not just where they wrap the cell.
 * `_` and `*` are legal filename characters and `_` is an extremely common one
 * — `my_project`, `src_old`, `_drafts`. So a plan citing
 *
 *     C:/Users/me/code/_clonecheck/mockups/drawer.png
 *
 * was silently rewritten to  .../code/clonecheck/...  and then reported as
 * `dangling`, i.e. "this file does not exist". The file existed. The parser had
 * renamed it. The verdict blamed the artifact, which is the worst place to
 * point, because the person goes looking for a mockup that is sitting right
 * where they left it.
 *
 * Found when a fresh clone into a directory whose name began with an underscore
 * failed seven assertions that pass in the directory this was developed in.
 *
 * So: strip emphasis only when it genuinely WRAPS the cell, longest delimiter
 * first, repeatedly (`**\`x\`**`), and never touch the interior.
 */
function stripMd(cell) {
  let s = String(cell)
    .replace(/!?\[[^\]]*\]\(([^)]+)\)/, "$1") // markdown link/image -> its target
    .trim();
  const DELIMS = ["***", "___", "**", "__", "*", "_", "``", "`"];
  for (let guard = 0; guard < 8; guard += 1) {
    const d = DELIMS.find((x) => s.length > 2 * x.length && s.startsWith(x) && s.endsWith(x));
    if (!d) break;
    s = s.slice(d.length, -d.length).trim();
  }
  return s;
}

function checkMockups(text) {
  const rows = mockupRows(text);
  const results = [];
  for (const row of rows) {
    const raw = row.path;
    // gstack's own template row is
    //   ~/.gstack/projects/$SLUG/designs/[folder]/[filename].png
    // A path holding an unexpanded shell variable or a bracket placeholder is not
    // a path, and it is the single most likely thing to end up in a plan.
    if (/[$[\]<>]|\{\{|\.\.\./.test(raw)) {
      results.push({ ...row, ok: false, kind: "placeholder", detail: "still holds a template placeholder or an unexpanded shell variable, so no file was ever named" });
      continue;
    }
    const abs = expand(raw);
    if (!abs) {
      results.push({ ...row, ok: false, kind: "unresolvable", detail: "could not be resolved to a path at all" });
      continue;
    }
    const posixTmp = /^\/tmp\//.test(raw.replace(/\\/g, "/"));
    if (!fs.existsSync(abs)) {
      const note = posixTmp && isWindows
        ? `does not exist. Node resolves "${raw}" to ${abs}; Git Bash writes /tmp to ${expand(os.tmpdir())}. A mockup written by the shell and cited by this path cannot be opened by the agent that wrote the line.`
        : `does not exist (resolved to ${abs}). The implementer this table is written for opens nothing.`;
      results.push({ ...row, abs, ok: false, kind: "dangling", detail: note });
      continue;
    }
    if (isVolatile(abs)) {
      results.push({ ...row, abs, ok: false, kind: "volatile", detail: `lives under a temp directory (${abs}). The plan outlives it, so this reference is dangling by construction — gstack's own "show me what 10/10 looks like" step writes mockups to /tmp.` });
      continue;
    }
    const img = imageInfo(abs);
    if (!img.ok) {
      results.push({ ...row, abs, ok: false, kind: "undecodable", detail: `${img.error}` });
      continue;
    }
    if (img.width < MIN_MOCKUP_EDGE || img.height < MIN_MOCKUP_EDGE) {
      results.push({ ...row, abs, ok: false, kind: "too-small", detail: `is ${img.width}x${img.height}, which is not a screen mockup` });
      continue;
    }
    results.push({ ...row, abs, ok: true, kind: "verified", detail: `${img.format} ${img.width}x${img.height}, ${img.bytes} bytes` });
  }
  return { rows: results, present: rows.length > 0, failed: results.filter((r) => !r.ok) };
}

// ------------------------------------------------------------- report checks

const REPORT_HEADING = /^##\s+(TOOLBAY|GSTACK)\s+REVIEW REPORT\s*$/im;

function headings(text) {
  return text.split(/\r?\n/).map((line, i) => ({ line, i })).filter((h) => /^##\s+\S/.test(h.line) && !/^###/.test(h.line));
}

function reportSection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (REPORT_HEADING.test(lines[i])) start = i;
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break; }
  }
  return { start, end, body: lines.slice(start, end).join("\n") };
}

function lastNonBlankLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].trim()) return { text: lines[i].trim(), index: i };
  return null;
}

/**
 * gstack gate item 4, the fiddliest rule in the file: the FINAL non-whitespace
 * line is the unresolved-decisions status, the exact unbolded sentinel or the
 * last bullet of an UNRESOLVED DECISIONS block, and "a bolded sentinel does NOT
 * count". Asking a model whether it accidentally bolded its own sentinel is
 * asking the wrong entity.
 */
function unresolvedStatus(text) {
  const last = lastNonBlankLine(text);
  if (!last) return { pass: false, detail: "the plan file has no content" };
  if (last.text === "NO UNRESOLVED DECISIONS") return { pass: true, detail: "sentinel present, unbolded", clean: true };
  if (/^\*+\s*NO UNRESOLVED DECISIONS\s*\*+$/.test(last.text)) {
    return { pass: false, detail: `the final line is "${last.text}" — a BOLDED sentinel, which gstack's own rule says does not count` };
  }
  if (/^[-*+]\s+\S/.test(last.text)) {
    const before = text.split(/\r?\n/).slice(0, last.index);
    if (before.some((l) => /\*\*UNRESOLVED DECISIONS:?\*\*/i.test(l))) {
      return { pass: true, detail: "final line is the last bullet of an UNRESOLVED DECISIONS block", clean: false };
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
    .filter((l) => splitCells(l).some((c) => c && !PLACEHOLDER_CELL.test(c)));
  if (!dataRows.length) return { pass: false, detail: "the Runs / Status / Findings table has a header but no filled row" };
  return { pass: true, detail: `${dataRows.length} filled row(s)` };
}

/**
 * The seven-pass Completion Summary. gstack ships it with `___/10 -> ___/10` in
 * every row; pasted verbatim it looks exactly like a finished review and carries
 * nothing. Both halves are checked: that the seven passes are named at all, and
 * that no row still holds its blanks.
 */
function completionSummary(text) {
  const idx = text.search(/COMPLETION SUMMARY/i);
  if (idx === -1) return { present: false, blanks: [], passes: 0 };
  const body = text.slice(idx);
  const lines = body.split(/\r?\n/);
  const blanks = [];
  const passes = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const m = /Pass\s*([1-7])\b/i.exec(l);
    if (m) passes.add(m[1]);
    if (/_{3,}/.test(l) || /\|\s*(—|–|-{1,2}|\?)\s*\|/.test(l) || /\[\s*(each|what|brief description|screen name|list|spec)[^\]]*\]/i.test(l)) {
      blanks.push({ line: i + 1, text: truncate(l, 80) });
    }
  }
  return { present: true, blanks, passes: passes.size };
}

/**
 * The Design Outside Voices litmus scorecard ships as seven rows of em dashes
 * with "Fill in each cell from the Codex and subagent outputs" underneath. A
 * scorecard of dashes asserts a cross-model consensus that never happened.
 */
function litmusScorecard(text) {
  const idx = text.search(/LITMUS SCORECARD/i);
  if (idx === -1) return { present: false };
  const lines = text.slice(idx).split(/\r?\n/).slice(0, 20);
  const checks = lines.filter((l) => /^\s*\d\.\s+\S/.test(l));
  if (!checks.length) return { present: true, rows: 0, filled: 0, empty: [] };
  const empty = checks.filter((l) => {
    const cells = l.replace(/^\s*\d\.\s+/, "").split(/\s{2,}|\|/).map((c) => c.trim()).filter(Boolean);
    const verdicts = cells.slice(1);
    return !verdicts.length || verdicts.every((c) => PLACEHOLDER_CELL.test(c));
  });
  return { present: true, rows: checks.length, filled: checks.length - empty.length, empty: empty.map((l) => truncate(l, 70)) };
}

function checks(plan, opts = {}) {
  const text = plan.text;
  const ui = detectUiScope(text);
  const section = reportSection(text);
  const R = [];
  const add = (id, label, pass, detail = "") => R.push({ id, label, pass: Boolean(pass), detail });

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

  const status = unresolvedStatus(text);
  add("report.unresolved-status", "the FINAL non-whitespace line is the unresolved-decisions status", status.pass, status.detail);

  // Required outputs the skill calls non-skippable.
  add("output.not-in-scope", '"NOT in scope" section is written', /not\s+in\s+scope/i.test(text),
    "design decisions considered and deferred have to be written down, or they were not decisions");
  add("output.already-exists", '"What already exists" section is written', /what\s+already\s+exists/i.test(text),
    "the existing DESIGN.md, patterns and components this plan should reuse rather than reinvent");

  // The seven passes, and the template that looks like all seven ran.
  const summary = completionSummary(text);
  add("summary.present", "a Completion Summary is written", summary.present,
    summary.present ? "" : "no COMPLETION SUMMARY block found");
  add("summary.seven-passes", "the Completion Summary accounts for all seven passes", summary.present && summary.passes >= 7,
    summary.present ? `${summary.passes}/7 passes named` : "no summary to count");
  add("summary.filled", "no row of the Completion Summary still holds its ___ blanks", summary.blanks.length === 0,
    summary.blanks.length ? `${summary.blanks.length} unfilled line(s), first: ${summary.blanks[0].text}` : "filled");

  const litmus = litmusScorecard(text);
  if (litmus.present) {
    add("litmus.filled", "the litmus scorecard has verdicts in it, not placeholder dashes", litmus.filled > 0 && litmus.empty.length === 0,
      litmus.empty.length ? `${litmus.empty.length}/${litmus.rows} row(s) still all dashes, first: ${litmus.empty[0]}` : `${litmus.filled}/${litmus.rows} rows carry verdicts`);
  }

  // Pass 2, read rather than recalled.
  const st = checkStates(text);
  add("states.covered", "interaction states are specified for the UI this plan adds", st.ok, st.detail);

  // The one artifact meant to outlive the conversation.
  const mk = checkMockups(text);
  if (mk.present || opts.mockupsRequired) {
    add("mockups.resolve", "every mockup path in the plan opens as a real image outside a temp directory",
      mk.present && mk.failed.length === 0,
      mk.present
        ? mk.failed.length ? `${mk.failed.length}/${mk.rows.length} bad, first (line ${mk.failed[0].line}, ${mk.failed[0].kind}): ${mk.failed[0].path} — ${mk.failed[0].detail}` : `${mk.rows.length} mockup(s) verified`
        : "mockups were required for this review but the plan names none");
  }

  // Pass 4, as far as it can be mechanised.
  const hits = slopHits(text);
  add("slop.clean", "the plan does not still specify patterns its own Pass 4 rejects", hits.length === 0,
    hits.length ? `${hits.length} hit(s), first: line ${hits[0].line} [${hits[0].id}] ${hits[0].text}` : "no blacklist or hard-rule hits");

  // A review cannot be design-complete and carry unresolved decisions.
  if (/design[- ]complete/i.test(text)) {
    const clean = status.pass && status.clean === true;
    add("claim.consistent", 'the "design-complete" claim matches the unresolved-decisions status', clean,
      clean ? "" : 'the plan claims design-complete while its final line is an UNRESOLVED DECISIONS block');
  }

  return { results: R, ui, states: st, mockups: mk, slop: hits };
}

// ------------------------------------------------------------------ commands

function fail(json, code, message) {
  if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: code, error: message }, null, 2));
  else err(`\n  UNUSABLE  ${message}\n`);
  process.exitCode = code;
}

function loadOrFail(args, json, extra = "") {
  const plan = readPlan(valueOf(args, "--plan"));
  if (!plan.ok) {
    if (json) out(JSON.stringify({ verdict: "UNUSABLE", exit: EXIT_UNUSABLE, error: plan.error }, null, 2));
    else {
      err(`\n  UNUSABLE  ${plan.error}`);
      if (extra) err(`            ${extra}`);
      err("");
    }
    process.exitCode = EXIT_UNUSABLE;
    return null;
  }
  return plan;
}

function cmdContext(args) {
  const json = args.includes("--json");
  const repo = expand(valueOf(args, "--repo") ?? ".");
  const slugInfo = repoSlug(repo);
  const branchInfo = currentBranch(repo);
  const dir = expand(valueOf(args, "--dir") ?? path.join(os.homedir(), ".gstack", "projects", slugInfo.slug));

  let artifactsState = "read";
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") artifactsState = "absent";
    else {
      fail(json, EXIT_UNUSABLE, `${dir} exists but could not be listed (${e.code || e.message}). This is NOT "no prior design reviews".`);
      return;
    }
  }

  // DESIGN.md is the calibration source for every rating in this review. gstack
  // asks "Does a DESIGN.md exist? If not, flag as a gap" and answers it by
  // eyeballing the repo.
  let designMd = null;
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  const root = top.ok && top.text ? expand(top.text) : repo;
  for (const c of ["DESIGN.md", "docs/DESIGN.md", ".claude/DESIGN.md", "design/DESIGN.md"]) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) { designMd = p; break; }
  }

  let ui = null;
  let planPath = null;
  const planArg = valueOf(args, "--plan");
  if (planArg) {
    const plan = readPlan(planArg);
    if (!plan.ok) { fail(json, EXIT_UNUSABLE, plan.error); return; }
    planPath = plan.path;
    ui = detectUiScope(plan.text);
  }

  const designsDir = path.join(dir, "designs");
  const tasksFile = path.join(dir, `tasks-design-review-${stamp()}.jsonl`);
  const payload = {
    verdict: "READY",
    exit: EXIT_OK,
    slug: slugInfo.slug,
    slugSource: slugInfo.source,
    branch: branchInfo.ok ? branchInfo.branch : null,
    artifactsDir: dir,
    artifactsState,
    designMd,
    priorDesignReviews: names.filter((n) => /design/i.test(n)).slice(0, 5),
    designsDir,
    ui,
    plan: planPath,
    tasksFile,
  };

  if (json) { out(JSON.stringify(payload, null, 2)); return; }
  out();
  out(`  slug:        ${payload.slug}   (${slugInfo.source})`);
  out(`  branch:      ${payload.branch ?? "UNKNOWN"}`);
  out(`  artifacts:   ${dir}   [${artifactsState}]`);
  out(`  DESIGN.md:   ${designMd ?? "none found — say so, and recommend /design-consultation before rating anything against a system that does not exist"}`);
  out(`  designs dir: ${designsDir}`);
  if (ui) {
    out();
    out(`  UI scope: ${ui.detected ? "YES" : "NO"}  (${ui.terms.length} distinct term(s) in prose${ui.terms.length ? `: ${ui.terms.join(", ")}` : ""})`);
    if (!ui.detected) out("            No UI scope measured. Say so and stop; a design review of a backend change is theatre.");
  }
  out();
  out(`  write this review's tasks to: ${tasksFile}`);
  out();
}

function cmdSlop(args) {
  const json = args.includes("--json");
  const plan = loadOrFail(args, json);
  if (!plan) return;
  const hits = slopHits(plan.text);
  if (json) {
    out(JSON.stringify({ verdict: hits.length ? "SLOP_FOUND" : "CLEAN", exit: hits.length ? EXIT_REJECTED : EXIT_OK, plan: plan.path, hits }, null, 2));
    process.exitCode = hits.length ? EXIT_REJECTED : EXIT_OK;
    return;
  }
  out();
  out(`  ${plan.path}`);
  out();
  if (!hits.length) {
    out(`  CLEAN  ${SLOP_RULES.length} rules checked, no hits. This is Pass 4's mechanical half only:`);
    out("  the blacklist and the hard rules. It says nothing about whether the design is good.");
    out();
    return;
  }
  for (const h of hits) {
    out(`  line ${String(h.line).padStart(4)}  [${h.id}]  ${h.label}`);
    out(`             ${h.text}`);
    out(`             ${h.why}`);
    out();
  }
  out(`  ${hits.length} hit(s). Each one is a pattern this skill's own Pass 4 rejects, still in the plan.`);
  out();
  process.exitCode = EXIT_REJECTED;
}

function cmdStates(args) {
  const json = args.includes("--json");
  const plan = loadOrFail(args, json);
  if (!plan) return;
  const st = checkStates(plan.text);
  if (json) {
    out(JSON.stringify({ verdict: st.ok ? "COVERED" : "INCOMPLETE", exit: st.ok ? EXIT_OK : EXIT_REJECTED, plan: plan.path, ...st }, null, 2));
    process.exitCode = st.ok ? EXIT_OK : EXIT_REJECTED;
    return;
  }
  out();
  out(`  ${plan.path}`);
  out();
  out(`  ${st.ok ? "COVERED" : "INCOMPLETE"}  ${st.detail}`);
  for (const b of st.blanks.slice(0, 12)) out(`      line ${b.line}  ${b.column}: ${b.cell}   in  ${b.row}`);
  if (st.blanks.length > 12) out(`      ... ${st.blanks.length - 12} more`);
  out();
  if (!st.ok) {
    out("  An unfilled state cell is the empty state an engineer will invent, which is");
    out('  how "No items found." ships. Fill it or delete the row.');
    out();
  }
  process.exitCode = st.ok ? EXIT_OK : EXIT_REJECTED;
}

function cmdMockups(args) {
  const json = args.includes("--json");
  const plan = loadOrFail(args, json);
  if (!plan) return;
  const required = args.includes("--require");
  const mk = checkMockups(plan.text);
  const bad = mk.failed.length > 0 || (required && !mk.present);
  if (json) {
    out(JSON.stringify({ verdict: bad ? "UNVERIFIED" : "VERIFIED", exit: bad ? EXIT_REJECTED : EXIT_OK, plan: plan.path, present: mk.present, rows: mk.rows }, null, 2));
    process.exitCode = bad ? EXIT_REJECTED : EXIT_OK;
    return;
  }
  out();
  out(`  ${plan.path}`);
  out();
  if (!mk.present) {
    out(required ? "  UNVERIFIED  no Approved Mockups table in this plan, and one was required." : "  no Approved Mockups table in this plan, so there is nothing to verify.");
    out();
    process.exitCode = bad ? EXIT_REJECTED : EXIT_OK;
    return;
  }
  for (const r of mk.rows) {
    out(`  ${r.ok ? "ok " : "no "}  line ${String(r.line).padStart(4)}  ${r.path}`);
    out(`               ${r.kind}: ${r.detail}`);
  }
  out();
  if (bad) {
    out("  This table is the handoff. Someone opens it in another conversation, on another");
    out("  branch, weeks from now, to build from. A path that does not resolve today will");
    out("  not resolve then.");
    out();
  }
  process.exitCode = bad ? EXIT_REJECTED : EXIT_OK;
}

const PRIORITIES = new Set(["P1", "P2", "P3"]);
const REQUIRED_TASK_FIELDS = ["id", "priority", "component", "title", "source_finding"];

function cmdTask(args) {
  const json = args.includes("--json");
  const file = expand(valueOf(args, "--file"));
  if (!file) { fail(json, EXIT_UNUSABLE, "--file <tasks-design-review-*.jsonl> is required"); return; }

  if (args.includes("--none")) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "", "utf8");
    } catch (e) { fail(json, EXIT_UNUSABLE, `could not create ${file} (${e.code || e.message})`); return; }
    if (json) out(JSON.stringify({ verdict: "EMPTY_ARTIFACT_WRITTEN", exit: EXIT_OK, file }, null, 2));
    else {
      out();
      out(`  wrote an EMPTY task artifact: ${file}`);
      out('  Empty means "this review ran and found nothing actionable". Missing means "it');
      out("  never ran\". On Windows gstack's jq-gated writer always says the second.");
      out();
    }
    return;
  }

  const rec = {
    phase: "design-review",
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
    fail(json, EXIT_UNUSABLE, `refusing to write a task record missing ${missing.join(", ")}. A design task with no source finding is a preference someone will argue with in review.`);
    return;
  }
  if (!PRIORITIES.has(rec.priority)) { fail(json, EXIT_UNUSABLE, `--priority must be one of P1, P2, P3 (got "${rec.priority}")`); return; }

  const line = JSON.stringify(rec);
  try { JSON.parse(line); } catch (e) { fail(json, EXIT_UNUSABLE, `the record did not serialize to valid JSON (${e.message})`); return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch (e) { fail(json, EXIT_UNUSABLE, `could not append to ${file} (${e.code || e.message})`); return; }

  if (json) out(JSON.stringify({ verdict: "TASK_WRITTEN", exit: EXIT_OK, file, record: rec }, null, 2));
  else { out(); out(`  ${rec.id} (${rec.priority}) -> ${file}`); out(); }
}

function cmdGate(args) {
  const json = args.includes("--json");
  const plan = loadOrFail(args, json, "The gate could not read the thing it is supposed to check, so it refuses rather than passing. Do not call ExitPlanMode.");
  if (!plan) return;

  const { results, ui } = checks(plan, { mockupsRequired: args.includes("--mockups-required") });

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
        : `${t} was named but is not on disk. gstack's writer is jq-gated and jq is absent here; use \`task --file ... --none\` if this review genuinely produced no tasks.`,
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
    out(`  GATE PASSED  ${results.length}/${results.length} checks. The report exists and is last, the`);
    out("  seven passes are accounted for with no blanks left, the interaction states are");
    out("  specified, every mockup path opens, and nothing on the blacklist is still in the");
    out("  plan. ExitPlanMode is allowed.");
  } else {
    out(`  GATE FAILED  ${failed.length} of ${results.length} checks:`);
    for (const r of failed) {
      out(`    ${r.id}: ${r.label}`);
      if (r.detail) out(`      ${r.detail}`);
    }
    out();
    out("  Do NOT call ExitPlanMode. Do NOT write a review record. Review prose in the plan");
    out("  body is not the report, and a pasted template is not a pass.");
  }
  out();
  process.exitCode = code;
}

function cmdRecord(args) {
  const json = args.includes("--json");
  const plan = loadOrFail(args, json);
  if (!plan) return;
  const { results } = checks(plan, { mockupsRequired: args.includes("--mockups-required") });
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    const msg = `refusing to write a review record: ${failed.length} gate check(s) failed (${failed.map((r) => r.id).join(", ")})`;
    if (json) out(JSON.stringify({ verdict: "REFUSED", exit: EXIT_REJECTED, error: msg, failed: failed.map((r) => r.id) }, null, 2));
    else {
      err(`\n  REFUSED  ${msg}`);
      err("           Nothing was written. gstack logs this record BEFORE its exit gate and");
      err("           unconditionally, so a design review that produced no report still shows");
      err("           up in /ship's dashboard as CLEAR.\n");
    }
    process.exitCode = EXIT_REJECTED;
    return;
  }
  const repo = expand(valueOf(args, "--repo") ?? path.dirname(plan.path));
  const outFile = expand(valueOf(args, "--out") ?? path.join(stateDir(), "reviews.jsonl"));
  const b = currentBranch(repo);
  const c = git(repo, ["rev-parse", "--short", "HEAD"]);
  const rec = {
    skill: "plan-design-review",
    timestamp: new Date().toISOString(),
    status: valueOf(args, "--status") ?? "clean",
    verified: true,
    verified_by: `tb-plan-design ${VERSION}`,
    checks_passed: results.map((r) => r.id),
    initial_score: Number(valueOf(args, "--initial-score") ?? 0),
    overall_score: Number(valueOf(args, "--overall-score") ?? 0),
    unresolved: Number(valueOf(args, "--unresolved") ?? 0),
    decisions_made: Number(valueOf(args, "--decisions-made") ?? 0),
    plan: plan.path,
    branch: b.ok ? b.branch : null,
    commit: c.ok ? c.text : null,
  };
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, `${JSON.stringify(rec)}\n`, "utf8");
  } catch (e) { fail(json, EXIT_UNUSABLE, `could not append to ${outFile} (${e.code || e.message})`); return; }
  if (json) out(JSON.stringify({ verdict: "RECORDED", exit: EXIT_OK, file: outFile, record: rec }, null, 2));
  else {
    out();
    out(`  RECORDED  ${outFile}`);
    out("  The record carries verified:true and the ids of the checks that actually ran, so a");
    out("  downstream reader can tell a proven review from an asserted one.");
    out();
  }
}

// ------------------------------------------------------------------ selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** gstack's Implementation Tasks writer for this phase, verbatim but for the values. */
const GSTACK_TASK_WRITER = String.raw`
jq -nc \
  --arg phase 'design-review' \
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

/** gstack's Pass 2 template, verbatim, as it appears in sections/review-sections.md. */
const GSTACK_STATE_TEMPLATE = `  FEATURE              | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
  ---------------------|---------|-------|-------|---------|--------
  [each UI feature]    | [spec]  | [spec]| [spec]| [spec]  | [spec]`;

/** gstack's Approved Mockups template row, verbatim. */
const GSTACK_MOCKUP_ROW = "| [screen name]  | ~/.gstack/projects/$SLUG/designs/[folder]/[filename].png | [brief description] | [constraints from review] |";

const GOOD_PLAN = `# Plan: the saved-searches drawer

## What already exists
DESIGN.md defines the type scale and the two surfaces. The list row component in
src/ui/Row.tsx is reused as-is.

## NOT in scope
Re-theming the marketing site. Deferred to TODOS.md.

## Pass 2 — interaction states

| FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| Saved list | three skeleton rows, no spinner | "Nothing saved yet" + Save this search button | inline red banner, list stays visible | rows fade in over 120ms | older rows dim while newer load |
| Rename | field disabled, caret kept | unreachable, rename needs a row | field turns red, prior name restored | name updates in place | unreachable, single field |

## Design & UX
Typeface is Söhne Buch 15/22 for rows, Söhne Kräftig 20/28 for the drawer title.
Sidebar collapses to a bottom sheet at 640px with 44px touch targets.

## Approved Mockups

| Screen | Mockup Path | Direction | Notes |
|---|---|---|---|
| Drawer | MOCKUP_PATH | quiet surface, one accent | no cards |

## DESIGN PLAN REVIEW — COMPLETION SUMMARY
| Pass 1 (Info Arch)  | 4/10 -> 9/10 after fixes |
| Pass 2 (States)     | 2/10 -> 9/10 after fixes |
| Pass 3 (Journey)    | 6/10 -> 8/10 after fixes |
| Pass 4 (AI Slop)    | 7/10 -> 9/10 after fixes |
| Pass 5 (Design Sys) | 8/10 -> 9/10 after fixes |
| Pass 6 (Responsive) | 3/10 -> 8/10 after fixes |
| Pass 7 (Decisions)  | 4 resolved, 1 deferred |

## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Design Review | /plan-design-review | UI/UX gaps | 1 | CLEAR | score 4/10 -> 9/10, 5 decisions |

**VERDICT:** DESIGN CLEARED — ready for eng review.

NO UNRESOLVED DECISIONS`;

function makePng(width, height) {
  // A real, minimally valid PNG: signature + IHDR + IDAT + IEND. Only the header
  // is ever read here, but writing a whole file keeps the fixture honest.
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0))]);
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-plan-design-selftest-"));
  // The durable half of the fixture set must NOT be under a temp root, or the
  // volatility check would (correctly) reject the good plan too.
  const durable = path.join(SKILL_DIR, ".selftest-artifacts");
  fs.mkdirSync(durable, { recursive: true });
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

  const goodMockup = path.join(durable, "drawer-approved.png");
  fs.writeFileSync(goodMockup, makePng(1440, 900));
  const good = GOOD_PLAN.replace("MOCKUP_PATH", goodMockup.replace(/\\/g, "/"));
  const goodPlan = write("good.md", good);

  // ------------------------------------------------------------------- gate
  {
    const r = gate(goodPlan);
    check("gate passes a design review that actually did the work", 0, r.status, failedIds(r).join(","));
  }

  {
    const p = write("prose-only.md", good.replace(/## TOOLBAY REVIEW REPORT[\s\S]*$/, "The design review went well; I rated everything and fixed it.\n"));
    const r = gate(p);
    check("gate REJECTS review prose in the body with no report section", 1, r.status);
    check("...naming report.present", true, failedIds(r).includes("report.present"));
  }
  {
    const p = write("report-midfile.md", `${good}\n\n## Appendix\n\nnotes\n`);
    const r = gate(p);
    check("gate REJECTS a report that is present but not the last section", 1, r.status);
    check("...naming report.is-last-section", true, failedIds(r).includes("report.is-last-section"));
  }
  {
    const p = write("bold-sentinel.md", good.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**"));
    const r = gate(p);
    check("gate REJECTS a BOLDED unresolved-decisions sentinel", 1, r.status);
    check("...naming report.unresolved-status", true, failedIds(r).includes("report.unresolved-status"));
  }
  {
    const p = write("no-verdict.md", good.replace("**VERDICT:** DESIGN CLEARED — ready for eng review.", "Everything looks good."));
    const r = gate(p);
    check("gate REJECTS a report with no VERDICT line", 1, r.status);
  }

  // ---- the seven-pass Completion Summary, and the template that impersonates it
  {
    const p = write("blank-summary.md", good.replace("| Pass 2 (States)     | 2/10 -> 9/10 after fixes |", "| Pass 2 (States)     | ___/10 -> ___/10 after fixes |"));
    const r = gate(p);
    check("gate REJECTS a Completion Summary still holding its ___ blanks", 1, r.status);
    check("...naming summary.filled", true, failedIds(r).includes("summary.filled"));
  }
  {
    const p = write("four-passes.md", good.replace(/\| Pass [567][^\n]*\n/g, ""));
    const r = gate(p);
    check("gate REJECTS a summary that accounts for fewer than all seven passes", 1, r.status);
    check("...naming summary.seven-passes", true, failedIds(r).includes("summary.seven-passes"));
  }

  // ---- Pass 2, the highest-value pass, read rather than recalled
  {
    const p = write("state-template.md", good.replace(/\| FEATURE \|[\s\S]*?\n\n/, `${GSTACK_STATE_TEMPLATE}\n\n`));
    const r = gate(p);
    check("gate REJECTS gstack's Pass 2 template pasted verbatim", 1, r.status);
    check("...naming states.covered", true, failedIds(r).includes("states.covered"));
    const s = runSelf(["states", "--plan", p, "--json"]);
    const j = JSON.parse(s.stdout || "{}");
    check("...and states names every unfilled cell, not just the table", true, (j.blanks ?? []).length >= 6, `${(j.blanks ?? []).length} blanks`);
  }
  {
    const p = write("no-state-table.md", good.replace(/\| FEATURE \|[\s\S]*?\n\n/, ""));
    const r = runSelf(["states", "--plan", p, "--json"]);
    check("states REJECTS a UI-scoped plan with no interaction-state table at all", 1, r.status);
  }
  {
    const p = write("dash-states.md", good.replace("| Rename | field disabled, caret kept | unreachable, rename needs a row | field turns red, prior name restored | name updates in place | unreachable, single field |", "| Rename | — | — | — | — | — |"));
    const r = runSelf(["states", "--plan", p, "--json"]);
    check("states REJECTS a row of em dashes standing in for five specifications", 1, r.status);
  }
  {
    const p = write("four-states.md", good.replace("| FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |", "| FEATURE | LOADING | EMPTY | ERROR | SUCCESS |"));
    const r = runSelf(["states", "--plan", p, "--json"]);
    check("states REJECTS a table missing the PARTIAL column", 1, r.status);
  }
  {
    const p = write("backend-only.md", "# Plan: rotate the webhook signing key\n\nAdd a second HMAC key, accept both for 24h, then retire the old one.\n");
    const r = runSelf(["states", "--plan", p, "--json"]);
    check("states does NOT demand a state table from a plan with no UI scope", 0, r.status);
  }

  // ---- the Approved Mockups table: the one output meant to outlive the session
  {
    const p = write("mockup-template.md", good.replace(/\| Drawer \|[^\n]*\n/, `${GSTACK_MOCKUP_ROW}\n`));
    const r = runSelf(["mockups", "--plan", p, "--json"]);
    check("mockups REJECTS gstack's template row with $SLUG and [filename] still in it", 1, r.status);
    check("...classifying it as a placeholder, not a missing file", "placeholder", (JSON.parse(r.stdout || "{}").rows ?? [])[0]?.kind ?? "");
  }
  {
    const p = write("mockup-dangling.md", good.replace(goodMockup.replace(/\\/g, "/"), path.join(durable, "never-generated.png").replace(/\\/g, "/")));
    const r = runSelf(["mockups", "--plan", p, "--json"]);
    check("mockups REJECTS a path in the table that is not on disk", 1, r.status);
    check("...naming it dangling", "dangling", (JSON.parse(r.stdout || "{}").rows ?? [])[0]?.kind ?? "");
  }
  {
    // gstack's own instruction: `$D generate --output /tmp/gstack-ideal-<dim>.png`.
    const volatilePng = path.join(os.tmpdir(), "gstack-ideal-hierarchy.png");
    fs.writeFileSync(volatilePng, makePng(1200, 800));
    const p = write("mockup-volatile.md", good.replace(goodMockup.replace(/\\/g, "/"), volatilePng.replace(/\\/g, "/")));
    const r = runSelf(["mockups", "--plan", p, "--json"]);
    check("mockups REJECTS a mockup that exists but lives in a temp directory", 1, r.status);
    check("...naming it volatile, with the file genuinely present", "volatile", (JSON.parse(r.stdout || "{}").rows ?? [])[0]?.kind ?? "");
    fs.rmSync(volatilePng, { force: true });
  }
  {
    // PATHS ARE NOT PROSE. `_` and `*` are legal filename characters, and the
    // parser used to strip them everywhere rather than only where they wrap the
    // cell — turning /code/_clonecheck/x.png into /code/clonecheck/x.png and
    // then calling the file dangling. These assert the interior survives while
    // real wrapping emphasis is still removed.
    check("an underscore inside a path is preserved", "/a/_b/c_d.png", stripMd("/a/_b/c_d.png"));
    check("a leading-underscore directory survives", "C:/x/_drafts/m.png", stripMd("C:/x/_drafts/m.png"));
    check("an asterisk inside a path is preserved", "/a/b*c.png", stripMd("/a/b*c.png"));
    check("wrapping bold is still removed", "/a/b.png", stripMd("**/a/b.png**"));
    check("wrapping italics is still removed", "/a/b.png", stripMd("*/a/b.png*"));
    check("wrapping underscore emphasis is still removed", "/a/b.png", stripMd("_/a/b.png_"));
    check("wrapping backticks are still removed", "/a/b.png", stripMd("`/a/b.png`"));
    check("bold AND backticks unwrap together", "/a/b.png", stripMd("**`/a/b.png`**"));
    check("wrapping emphasis around an underscored path keeps the underscore", "/a/_b.png", stripMd("**/a/_b.png**"));
    check("a markdown link still resolves to its target", "/a/_b.png", stripMd("[mockup](/a/_b.png)"));
    check("a bare underscore-only cell is left alone", "_", stripMd("_"));

    // The API error body written to a .png. Every path that only checks existence
    // passes this, and the Read tool shows the user nothing.
    const errPng = path.join(durable, "variant-A.png");
    fs.writeFileSync(errPng, '{"error":{"type":"rate_limit_error","message":"overloaded"}}', "utf8");
    const p = write("mockup-not-an-image.md", good.replace(goodMockup.replace(/\\/g, "/"), errPng.replace(/\\/g, "/")));
    const r = runSelf(["mockups", "--plan", p, "--json"]);
    check("mockups REJECTS a JSON error body saved with a .png extension", 1, r.status);
    check("...naming it undecodable", "undecodable", (JSON.parse(r.stdout || "{}").rows ?? [])[0]?.kind ?? "");
    fs.rmSync(errPng, { force: true });
  }
  {
    const tiny = path.join(durable, "tiny.png");
    fs.writeFileSync(tiny, makePng(1, 1));
    const p = write("mockup-tiny.md", good.replace(goodMockup.replace(/\\/g, "/"), tiny.replace(/\\/g, "/")));
    check("mockups REJECTS a 1x1 image as a screen mockup", 1, runSelf(["mockups", "--plan", p, "--json"]).status);
    fs.rmSync(tiny, { force: true });
  }
  {
    const p = write("no-mockups.md", good.replace(/## Approved Mockups[\s\S]*?(?=\n## )/, ""));
    check("mockups is silent when the plan has no mockup table", 0, runSelf(["mockups", "--plan", p, "--json"]).status);
    check("...but REFUSES the same plan when mockups were required", 1, runSelf(["mockups", "--plan", p, "--require", "--json"]).status);
  }

  // ---- the /tmp divergence this whole check exists for, measured on this machine
  if (isWindows) {
    const bashPath = "/tmp/tb-plan-design-probe.png";
    const real = path.join(os.tmpdir(), "tb-plan-design-probe.png");
    fs.writeFileSync(real, makePng(800, 600));
    const nodeSees = fs.existsSync(bashPath);
    check(
      "a /tmp path written by Git Bash is NOT visible to Node at the same string",
      false,
      nodeSees,
      `Git Bash /tmp is ${expand(os.tmpdir())}; Node resolves "${bashPath}" to ${expand(bashPath)}`,
    );
    const p = write("mockup-posix-tmp.md", good.replace(goodMockup.replace(/\\/g, "/"), bashPath));
    const r = runSelf(["mockups", "--plan", p, "--json"]);
    check("...and a plan citing that path is refused rather than trusted", 1, r.status);
    fs.rmSync(real, { force: true });
  } else {
    skip("a /tmp path written by Git Bash is NOT visible to Node at the same string", "not Windows; /tmp is one directory here");
    skip("...and a plan citing that path is refused rather than trusted", "not Windows");
  }

  // ---- Pass 4, mechanised
  {
    const cases = [
      ["font.default-stack", "Body font: Inter, 16px, with a system-ui fallback."],
      ["color.purple-gradient", "Hero background: a purple gradient fading into indigo."],
      ["layout.three-column-features", "Below the fold, a 3-column feature grid."],
      ["copy.generic-hero", "Headline: Unlock the power of your data."],
      ["copy.vibes", "The result should feel like a clean, modern UI."],
      ["decor.blobs", "Add floating circles behind the pricing table."],
      ["type.tiny-body", "Table cells use font-size: 13px."],
      ["cards.unearned", "The dashboard is a card grid of six widgets."],
      ["decor.left-border-cards", "Each alert uses border-left: 3px solid var(--accent)."],
    ];
    for (const [id, line] of cases) {
      const p = write(`slop-${id}.md`, `# Plan\n\n${line}\n`);
      const r = runSelf(["slop", "--plan", p, "--json"]);
      const hits = JSON.parse(r.stdout || "{}").hits ?? [];
      check(`slop catches ${id}`, true, hits.some((h) => h.id === id), `hits: ${hits.map((h) => h.id).join(",") || "none"}`);
    }
  }
  {
    // The lint has to survive a plan that DISCUSSES the blacklist, or nobody keeps it.
    const p = write("slop-negated.md", `# Plan\n\nAvoid the 3-column feature grid.\nNo purple gradients anywhere.\nWe are not using Inter as the display typeface.\nRejected: floating circles and wavy dividers.\nThe brief must never say "clean, modern UI".\n`);
    const r = runSelf(["slop", "--plan", p, "--json"]);
    check("slop does NOT flag a plan that forbids the patterns", 0, r.status, (JSON.parse(r.stdout || "{}").hits ?? []).map((h) => h.id).join(","));
  }
  {
    const p = write("slop-in-code.md", "# Plan\n\n```css\nbody { font-family: Inter, sans-serif; }\n```\n");
    const r = runSelf(["slop", "--plan", p, "--json"]);
    check("slop DOES flag a default font stack inside a code fence, where the spec lives", 1, r.status);
  }
  {
    const p = write("slop-gate.md", good.replace("Typeface is Söhne Buch 15/22 for rows,", "Typeface is Inter for rows,"));
    const r = gate(p);
    check("gate REJECTS a finished-looking plan that still specifies a default font stack", 1, r.status);
    check("...naming slop.clean", true, failedIds(r).includes("slop.clean"));
  }

  // ---- required outputs
  for (const [name, cut, id] of [
    ['gate REJECTS a review with no "NOT in scope" section', /## NOT in scope[\s\S]*?(?=\n## )/, "output.not-in-scope"],
    ['gate REJECTS a review with no "What already exists" section', /## What already exists[\s\S]*?(?=\n## )/, "output.already-exists"],
  ]) {
    const p = write(`${id}.md`, good.replace(cut, ""));
    const r = gate(p);
    check(name, 1, r.status);
    check(`...naming ${id}`, true, failedIds(r).includes(id));
  }

  // ---- the litmus scorecard of dashes
  {
    const scorecard = `
DESIGN OUTSIDE VOICES — LITMUS SCORECARD:
  Check                                    Claude  Codex  Consensus
  1. Brand unmistakable in first screen?   —       —      —
  2. One strong visual anchor?             —       —      —
  3. Scannable by headlines only?          —       —      —
`;
    const p = write("litmus-dashes.md", good.replace("## Design & UX", `## Outside voices\n${scorecard}\n## Design & UX`));
    const r = gate(p);
    check("gate REJECTS a litmus scorecard that is still all em dashes", 1, r.status);
    check("...naming litmus.filled", true, failedIds(r).includes("litmus.filled"));
  }
  {
    const scorecard = `
DESIGN OUTSIDE VOICES — LITMUS SCORECARD:
  1. Brand unmistakable in first screen?   YES     YES    CONFIRMED
  2. One strong visual anchor?             NO      YES    DISAGREE
`;
    const p = write("litmus-filled.md", good.replace("## Design & UX", `## Outside voices\n${scorecard}\n## Design & UX`));
    check("gate ACCEPTS a litmus scorecard that carries real verdicts", 0, gate(p).status, failedIds(gate(p)).join(","));
  }

  // ---- the self-contradiction a summary can carry without noticing
  {
    const p = write("complete-but-unresolved.md",
      good.replace("NO UNRESOLVED DECISIONS", "**UNRESOLVED DECISIONS:**\n\n- mobile nav pattern for the drawer")
        .replace("**VERDICT:** DESIGN CLEARED — ready for eng review.", "**VERDICT:** DESIGN CLEARED. Plan is design-complete."));
    const r = gate(p);
    check("gate REJECTS a plan claiming design-complete while decisions are still open", 1, r.status);
    check("...naming claim.consistent", true, failedIds(r).includes("claim.consistent"));
  }

  // ---- fail closed
  check("gate REFUSES a plan file that does not exist (never passes)", 2, gate(path.join(tmp, "nope.md")).status);
  check("gate REFUSES an empty plan file", 2, gate(write("empty.md", "   \n")).status);
  check("gate REFUSES a directory handed to it as a plan", 2, gate(tmp).status);
  check("slop REFUSES an unreadable plan instead of reporting CLEAN", 2, runSelf(["slop", "--plan", path.join(tmp, "nope.md"), "--json"]).status);
  check("states REFUSES an unreadable plan instead of reporting COVERED", 2, runSelf(["states", "--plan", path.join(tmp, "nope.md"), "--json"]).status);
  check("mockups REFUSES an unreadable plan instead of reporting VERIFIED", 2, runSelf(["mockups", "--plan", path.join(tmp, "nope.md"), "--json"]).status);

  // ---- record
  {
    const recFile = path.join(tmp, "refused.jsonl");
    const bad = write("bad-for-record.md", good.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**"));
    const r = runSelf(["record", "--plan", bad, "--out", recFile, "--json"]);
    check("record REFUSES to log a design review whose gate fails", 1, r.status);
    check("...and writes no file at all", false, fs.existsSync(recFile));
  }
  {
    const recFile = path.join(tmp, "ok.jsonl");
    const r = runSelf(["record", "--plan", goodPlan, "--out", recFile, "--json"]);
    check("record logs a design review whose gate passes", 0, r.status, r.stderr.trim());
    const first = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8").trim().split("\n")[0]) : {};
    check("...carrying verified:true", true, first.verified === true);
    check("...and the ids of the checks that ran", true, Array.isArray(first.checks_passed) && first.checks_passed.length >= 10, `${first.checks_passed?.length ?? 0} ids`);
  }

  // ---- tasks artifact, and the A/B against gstack's writer
  const tasksFile = path.join(tmp, "artifacts", "tasks-design-review-20260814-000000.jsonl");
  const nastyTitle = 'specify the empty state for "Saved" on C:\\ui\nand the 44px target';
  {
    const r = runSelf([
      "task", "--file", tasksFile, "--id", "T1", "--priority", "P1", "--component", "saved-drawer",
      "--title", nastyTitle, "--source-finding", 'Pass 2 said: "empty cell under EMPTY"',
      "--files", "src/ui/Drawer.tsx", "--effort-human", "2h", "--effort-cc", "10m", "--json",
    ]);
    check("task writes the Implementation Tasks artifact without jq", 0, r.status, r.stderr.trim());
    const line = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, "utf8").trim() : "";
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* stays null */ }
    check("...as one parseable JSON line", true, parsed !== null, line.slice(0, 80));
    check("...with quotes, backslashes and newlines in the title surviving intact", nastyTitle, parsed?.title ?? "(unparseable)");
    check("...tagged with the design-review phase so /autoplan can aggregate it", "design-review", parsed?.phase ?? "");
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
          ...process.env,
          TASKS_FILE: gstackFile, RUN_ID: "20260814-000000", BRANCH: "feature", COMMIT: "abc123",
          TASK_ID: "T1", PRIORITY: "P1", COMPONENT: "saved-drawer", EFFORT_HUMAN: "2h", EFFORT_CC: "10m",
          TITLE: nastyTitle, SOURCE_FINDING: "empty cell under EMPTY", FILES_JSON: '["src/ui/Drawer.tsx"]',
        },
      });
      const bytes = fs.existsSync(gstackFile) ? fs.statSync(gstackFile).size : -1;
      const wrote = bytes > 0 && fs.readFileSync(gstackFile, "utf8").trim().length > 0;
      check(
        'gstack\'s jq writer records NO task, leaving an artifact that reads as "ran, no findings"',
        false, wrote,
        `jq absent; the shell still created the file: exists=${bytes >= 0}, bytes=${bytes}. bash said: ${(res.stderr || "").trim().split("\n")[0] || "(nothing)"}`,
      );
    }
    check("...while this one produced a real record for the same task", true, fs.existsSync(tasksFile));
  }
  {
    const emptyFile = path.join(tmp, "artifacts", "tasks-design-review-empty.jsonl");
    const r = runSelf(["task", "--file", emptyFile, "--none", "--json"]);
    check('task --none writes an EMPTY artifact for "ran, found nothing"', 0, r.status);
    check("...which is zero bytes, a state reachable here only on purpose", 0, fs.existsSync(emptyFile) ? fs.statSync(emptyFile).size : -1);
  }
  check("task REFUSES a record missing its source finding", 2,
    runSelf(["task", "--file", path.join(tmp, "bad.jsonl"), "--id", "T9", "--priority", "P1", "--component", "x", "--title", "y", "--json"]).status);
  check("...and wrote nothing when it refused", false, fs.existsSync(path.join(tmp, "bad.jsonl")));

  {
    check("gate REJECTS a plan whose named tasks artifact is not on disk", 1,
      gate(goodPlan, ["--tasks", path.join(tmp, "never-written.jsonl")]).status);
    check("gate ACCEPTS the same plan when the artifact really exists", 0, gate(goodPlan, ["--tasks", tasksFile]).status);
  }

  // ---- context
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
    const p = write("backend-context.md", "# Plan: rotate the webhook signing key\n\nAdd a second HMAC key.\n");
    const r = runSelf(["context", "--plan", p, "--json"]);
    check("context measures UI scope rather than assuming it", false, JSON.parse(r.stdout || "{}").ui?.detected ?? true);
  }

  // ---- the context tax
  {
    const files = ["SKILL.md", "sections.md"].map((f) => path.join(SKILL_DIR, f));
    const bytes = files.filter((f) => fs.existsSync(f)).reduce((n, f) => n + fs.statSync(f).size, 0);
    check("the fork's prompt files are all present", true, bytes > 0, `${bytes} bytes under ${SKILL_DIR}`);
    const skillFile = path.join(SKILL_DIR, "SKILL.md");
    check("...and the always-loaded SKILL.md stays under 32KB", true,
      fs.existsSync(skillFile) && fs.statSync(skillFile).size < 32768,
      `${fs.existsSync(skillFile) ? fs.statSync(skillFile).size : -1} bytes (gstack's is 63KB before its sections file)`);

    const all = files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const passCount = [...all.matchAll(/^###\s+Pass\s+([1-7]):/gim)].length;
    check("all seven review passes survived the trim", 7, passCount);
    for (const [label, re] of [
      ["the nine design principles", /empty states are features/i],
      ["the AI slop blacklist", /slop blacklist/i],
      ["the design hard rules", /hard rejection/i],
      ["the litmus checks", /litmus/i],
      ["the 0-10 rate-gap-fix-rerate method", /what would make it a 10/i],
      ["the one-issue-one-question rule", /one issue = one/i],
      ["the Approved Mockups handoff table", /approved mockups/i],
    ]) check(`${label} survived the trim`, true, re.test(all));
  }

  // 92 -> 103: eleven assertions added when stripMd was found to be deleting
  // `_` and `*` from the interior of paths, not just from wrapping emphasis.
  const EXPECTED = 103;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(durable, { recursive: true, force: true });
  return report("tb-plan-design", results);
}

function report(label, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  ${label} selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    if (r.skip) { process.stdout.write(`  SKIP  ${r.name.padEnd(width)}  ${r.detail}\n`); continue; }
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
  process.stdout.write("\n  Every rejection above is a plan that satisfies gstack's own end-of-review\n");
  process.stdout.write("  self-check: the passes are named, the tables are there, the summary is filled\n");
  process.stdout.write("  in shape. The cells hold [spec], the mockup path holds $SLUG or points into a\n");
  process.stdout.write("  temp directory, and the typeface is Inter. Each one exits non-zero here.\n\n");
  return true;
}

// ----------------------------------------------------------------------- cli

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}

function help() {
  out(`
  tb-plan-design ${VERSION}  (Toolbay Stack)

  context [--repo <d>] [--dir <d>] [--plan <f>]
        resolve slug and branch without a shell, find DESIGN.md, report whether
        the artifacts directory is absent or unreadable (different answers), and
        MEASURE whether this plan has UI scope at all.

  slop --plan <f>
        Pass 4's mechanical half: the AI-slop blacklist and the universal hard
        rules, matched against the plan with line numbers. A plan that FORBIDS a
        pattern is not flagged for naming it.

  states --plan <f>
        Pass 2: the loading / empty / error / success / partial table. Reads the
        cells. [spec], an em dash and a blank are not specifications.

  mockups --plan <f> [--require]
        every path in the Approved Mockups table: resolves, decodes as a real
        image, big enough to be a screen, and NOT in a directory the OS empties.

  task --file <jsonl> --id T1 --priority P1 --component <c> --title <t>
       --source-finding <f> [--files a,b] [--effort-human 2h] [--effort-cc 10m]
  task --file <jsonl> --none
        write the Implementation Tasks artifact. No jq.

  gate --plan <f> [--tasks <jsonl>] [--mockups-required]
        the exit-plan-mode gate, run against the file instead of asked of the
        model: report present and last, table filled, VERDICT present, final line
        is the unresolved-decisions status, seven passes accounted for with no
        blanks, litmus scorecard filled, states covered, mockups resolve, slop
        clean, and no design-complete claim over open decisions.

  record --plan <f> [--out <f>] [--initial-score N] [--overall-score N]
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
  else if (cmd === "slop") cmdSlop(argv.slice(1));
  else if (cmd === "states") cmdStates(argv.slice(1));
  else if (cmd === "mockups") cmdMockups(argv.slice(1));
  else if (cmd === "task") cmdTask(argv.slice(1));
  else if (cmd === "gate") cmdGate(argv.slice(1));
  else if (cmd === "record") cmdRecord(argv.slice(1));
  else if (cmd === "selftest") selftest();
  else help();
} catch (e) {
  // A crash is not a pass.
  err(`\n  tb-plan-design crashed: ${e?.stack ?? e}\n`);
  process.exitCode = EXIT_UNUSABLE;
}
