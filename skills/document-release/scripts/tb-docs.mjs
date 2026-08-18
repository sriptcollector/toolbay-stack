#!/usr/bin/env node
/**
 * tb-docs.mjs: the evidence engine for /document-release.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow this serves (run after /ship and before the PR
 * merges, discover every doc file, cross-reference it against the release diff,
 * build a Diataxis coverage map, auto-apply the factual corrections and ask
 * about the rest, polish CHANGELOG voice without ever clobbering entries, check
 * cross-doc consistency, clean up TODOS, ask before bumping VERSION, then commit
 * and post a documentation section to the PR body) comes from `document-release`
 * in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * 1. THE FINAL REPORT IS WRITTEN FROM MEMORY, NOT FROM THE FILES.
 *
 *    gstack ends the run with a "Documentation health" table
 *    (sections/release-body.md:326-346) whose statuses are Updated / Current /
 *    Voice polished / Already bumped, each with "a description of what changed".
 *    Nothing computes any of it. The model that decided to edit README.md is the
 *    same model that reports README.md as edited, from the same context window,
 *    with no read-back in between. So the one failure that matters here -- a doc
 *    reported as updated that nobody actually wrote a byte to -- produces a
 *    report identical to the successful run. The same is true in the other
 *    direction: a file quietly modified and left out of the table is invisible.
 *
 *    `baseline` hashes every doc file before the run. `verify` re-hashes them
 *    afterwards and checks the claims against the bytes. A claim of "updated"
 *    with an unchanged hash is a FAILURE, not a line in a table.
 *
 * 2. "NEVER CLOBBER THE CHANGELOG" IS A PARAGRAPH IN ALL CAPS.
 *
 *    gstack's own section records the reason (release-body.md:75-89): "A real
 *    incident occurred where an agent replaced existing CHANGELOG entries when
 *    it should have preserved them." The countermeasure shipped for it is five
 *    bullet points of instruction to the same agent that caused it.
 *    `changelog-check` makes it arithmetic: every heading present before the run
 *    must still be present, in the same relative order, and every body line
 *    under every entry OLDER than the newest one must survive verbatim. Voice
 *    polish on the newest entry stays allowed, because that is the actual step.
 *
 * 3. THE DISCOVERY STEP DOES NOT RUN ON WINDOWS.
 *
 *    gstack Step 1.3 discovers docs with
 *      find . -maxdepth 2 -name "*.md" -not -path "./.git/*" ...
 *    In PowerShell `find` is `C:\Windows\System32\find.exe`, a different
 *    program. Measured on Windows 11, 2026-08-14:
 *
 *      PS> find . -maxdepth 2 -name "*.md"
 *      FIND: Parameter format not correct
 *      exit=2
 *
 *    An agent that reads that as "no documentation files in this repo" audits
 *    nothing and reports everything current. `scan` walks the tree with node:fs.
 *
 * 4. THE PR BODY UPDATE FAILS OPEN, ONTO THE PR BODY.
 *
 *    gstack reads the body with a plain redirect
 *    (release-body.md:212-222, 256):
 *      gh pr view --json body -q .body > /tmp/gstack-pr-body-$$.md
 *      ... gh pr edit --body-file /tmp/gstack-pr-body-$$.md
 *    A redirect creates its target whether or not the command succeeds.
 *    Measured on Windows 11, 2026-08-14:
 *
 *      $ (exit 7) > prbody.md; echo "cmd exit=$?"; wc -c < prbody.md
 *      cmd exit=7
 *      0
 *
 *    So a failed or unauthenticated read leaves a 0-byte file, and the next
 *    command writes that emptiness over a PR body somebody wrote by hand. The
 *    instruction "if gh pr view fails, skip" is a request, not a gate.
 *    `pr-section` refuses to assemble a body from a missing or empty read unless
 *    told in as many words that the body really is empty.
 *
 *    The path is wrong on Windows too, twice over. `$$` is a shell PID; in
 *    PowerShell it expands to nothing, so every concurrent session shares one
 *    file. And `/tmp` is not one directory:
 *
 *      $ echo hi > /tmp/tbs-probe.txt
 *      $ node -e "console.log(require('fs').existsSync('/tmp/tbs-probe.txt'))"
 *      false
 *      $ node -e "console.log(require('path').resolve('/tmp'))"
 *      C:\tmp
 *
 *    Git Bash wrote it under AppData\Local\Temp. Node looked in C:\tmp. Nothing
 *    here uses /tmp; scratch files live in the state directory.
 *
 * 5. THE COVERAGE MAP IS ASSERTED, NOT LOOKED UP.
 *
 *    Step 1.5 asks for a table of entity vs reference/how-to/tutorial/
 *    explanation with checkmarks. The checkmarks are the model's recollection of
 *    files it read earlier. `surface` extracts the entities from the diff and
 *    `coverage` greps the docs for each one, so "documented" means a file and a
 *    line number. Which Diataxis quadrant a mention satisfies is a judgement and
 *    stays with the agent; whether the string appears in the file at all is not,
 *    and it is now checked.
 *
 * DESIGN RULES
 *
 *   FAIL CLOSED. Every check that cannot reach a confident answer FAILS. A
 *   missing baseline, an unreadable baseline, a baseline taken on another
 *   branch, a claim naming a file that is not there: all are failures, never
 *   "nothing to compare, looks fine". There is exactly one deliberate pass on
 *   absence, at changelogCheck(): a repository with no CHANGELOG cannot have
 *   clobbered one.
 *
 *   NODE ONLY. No shell, no find, no python3, no /tmp, no $$.
 *
 *   PROVE IT. `selftest` runs this file as a child process against throwaway
 *   git repositories built to be wrong in one specific way each, and fails if
 *   any of them is allowed through.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

/** Details often carry a captured child transcript. Keep the failure list one line per failure. */
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

const EXIT_OK = 0;
const EXIT_FAILED = 1; // a check failed, or a claim was not backed by the bytes
const EXIT_UNUSABLE = 2; // not a repo, or the arguments make no sense

// --------------------------------------------------------------------- git

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    missing: res.error?.code === "ENOENT",
  };
}

function repoRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  if (!r.ok) return null;
  // Git prints POSIX separators even on Windows; path.resolve fixes that, and
  // realpath collapses the OneDrive junctions this machine is full of so that
  // the same repo reached two ways hashes to one baseline.
  return realpathBest(path.resolve(r.stdout));
}

function currentBranch(cwd) {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

function headCommit(cwd) {
  const r = git(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

const BASE_CANDIDATES = ["main", "master", "develop", "trunk"];

/**
 * The base branch, and how it was decided, so a wrong answer is visible rather
 * than silent. gstack asks `gh`/`glab` first and falls back through four git
 * commands; the ordering here is the same idea with the network calls dropped,
 * because a doc audit that cannot run offline is a doc audit that does not run.
 */
function detectBase(cwd, override) {
  if (override) return { base: override, how: "given on the command line" };
  const sym = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (sym.ok && sym.stdout) {
    const name = sym.stdout.replace(/^refs\/remotes\/origin\//, "");
    if (name) return { base: name, how: "origin/HEAD" };
  }
  for (const cand of BASE_CANDIDATES) {
    if (git(["rev-parse", "--verify", `refs/remotes/origin/${cand}`], cwd).ok) {
      return { base: cand, how: `origin/${cand} exists` };
    }
  }
  for (const cand of BASE_CANDIDATES) {
    if (git(["rev-parse", "--verify", `refs/heads/${cand}`], cwd).ok) {
      return { base: cand, how: `local ${cand} exists` };
    }
  }
  return { base: null, how: "no base branch could be identified" };
}

function mergeBase(cwd, base) {
  if (!base) return null;
  for (const ref of [`origin/${base}`, base]) {
    const r = git(["merge-base", ref, "HEAD"], cwd);
    if (r.ok && r.stdout) return r.stdout;
  }
  return null;
}

// ------------------------------------------------------------ path handling

const isWindows = process.platform === "win32";

function realpathBest(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 256; i += 1) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.resolve(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

/**
 * A repo-relative key for a doc file that is stable across the three ways this
 * machine spells a path. An agent writing claims will produce `README.md`,
 * `./README.md`, `docs\guide.md` and `docs/guide.md` interchangeably; all four
 * have to land on one entry or the "was it really edited" check compares a file
 * against nothing and passes.
 */
function relKey(root, p) {
  const abs = path.resolve(root, String(p).trim().replace(/^["']|["']$/g, ""));
  let rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..")) return null; // outside the repository
  rel = rel.split(path.sep).join("/");
  return isWindows ? rel.toLowerCase() : rel;
}

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function baselinePath(root) {
  const id = crypto.createHash("sha256").update(isWindows ? root.toLowerCase() : root).digest("hex").slice(0, 16);
  return path.join(stateDir(), "document-release", `${id}.json`);
}

// -------------------------------------------------------------- doc discovery

const DOC_EXT = new Set([".md", ".mdx", ".markdown", ".rst", ".txt"]);
const NAMED_DOCS = new Set(["VERSION", "CHANGELOG", "TODOS", "AUTHORS", "NOTICE", "LICENSE"]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "target",
  "__pycache__", ".venv", "venv", "tmp", "temp",
]);

/**
 * Documentation files, found without shelling out. `.txt` is included because a
 * plain README.txt is still the file a reader opens, and NAMED_DOCS catches the
 * extension-less ones (VERSION, CHANGELOG) that gstack's `-name "*.md"` misses
 * even on a machine where its `find` runs -- which matters, since VERSION and
 * CHANGELOG are the two files its own Steps 5 and 8 are about.
 */
function scanDocs(root, depth = 2) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (level >= depth) continue;
        if (e.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walk(full, level + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      const stem = e.name.replace(/\.[^.]*$/, "").toUpperCase();
      if (DOC_EXT.has(ext) || NAMED_DOCS.has(e.name.toUpperCase()) || NAMED_DOCS.has(stem)) {
        found.push(relKey(root, full));
      }
    }
  };
  walk(root, 0);
  return [...new Set(found.filter(Boolean))].sort();
}

/** Newlines are normalised so that a tool rewriting CRLF is not reported as a documentation change. */
function hashFile(abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const norm = buf.replace(/\r\n/g, "\n");
  return { sha: crypto.createHash("sha256").update(norm).digest("hex"), bytes: Buffer.byteLength(norm, "utf8") };
}

function readTextOrNull(abs) {
  try {
    return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ baseline

function takeBaseline(root, opts) {
  const branch = currentBranch(root);
  const head = headCommit(root);
  const { base, how } = detectBase(root, opts.base);
  const mb = mergeBase(root, base);
  const files = {};
  for (const rel of scanDocs(root, opts.depth)) {
    const h = hashFile(path.join(root, rel));
    if (h) files[rel] = h;
  }
  const changelogRel = files["changelog.md"] ? "changelog.md" : Object.keys(files).find((k) => /(^|\/)changelog(\.md|\.markdown)?$/i.test(k));
  const record = {
    tool: "tb-docs",
    version: VERSION,
    root,
    branch,
    head,
    base,
    baseHow: how,
    mergeBase: mb,
    takenAt: new Date().toISOString(),
    files,
    changelog: changelogRel ? parseChangelog(readTextOrNull(path.join(root, changelogRel)) ?? "") : null,
    changelogPath: changelogRel ?? null,
  };
  const p = baselinePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { record, path: p };
}

/**
 * @returns {{ok:true, record:object, path:string} | {ok:false, error:string, path:string}}
 *
 * Every unhappy outcome is an error. A verify with nothing to compare against
 * must not print a clean table; that is the exact shape of the failure this
 * whole file exists to remove.
 */
function loadBaseline(root) {
  const p = baselinePath(root);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      path: p,
      error: `no baseline at ${p}. Nothing was recorded before the run, so no claim about what changed can be checked. Run "tb-docs baseline" first (Step 1), then re-run the workflow.`,
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    return { ok: false, path: p, error: `baseline at ${p} could not be read (${e.code || e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, path: p, error: `baseline at ${p} is not valid JSON (${e.message}), so it cannot be trusted as a before-picture` };
  }
  if (!obj || typeof obj !== "object" || obj.tool !== "tb-docs" || !obj.files || typeof obj.files !== "object") {
    return { ok: false, path: p, error: `baseline at ${p} is not a tb-docs baseline record` };
  }
  return { ok: true, record: obj, path: p };
}

// ----------------------------------------------------------------- changelog

/**
 * Headings and their bodies, in file order. Anything at h2 or deeper that names
 * a version, or any h2, counts as an entry heading; that covers Keep a Changelog
 * (`## [1.2.3] - 2026-01-01`), the bare `## 1.2.3` style, and `### v1.2.3`.
 */
function parseChangelog(text) {
  const lines = String(text ?? "").split("\n");
  const entries = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^(#{2,6})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      cur = { heading: m[2].trim(), level: m[1].length, line: i + 1, body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) entries.push(cur);
  return entries.map((e) => ({
    heading: e.heading,
    level: e.level,
    line: e.line,
    version: (/(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(e.heading) ?? [])[1] ?? null,
    body: e.body.map((l) => l.trim()).filter(Boolean),
  }));
}

/**
 * @returns {{name:string, pass:boolean, expected:string, got:string, detail:string}[]}
 *
 * THE ONE DELIBERATE PASS ON ABSENCE: a repository with no CHANGELOG, before or
 * after, cannot have had one clobbered. A CHANGELOG that existed at baseline and
 * is gone now is a failure, not an absence.
 */
function changelogCheck(root, baseline) {
  const results = [];
  const rel = baseline?.changelogPath ?? scanDocs(root, 2).find((k) => /(^|\/)changelog(\.md|\.markdown)?$/i.test(k)) ?? null;
  const before = baseline?.changelog ?? null;

  if (!rel) {
    results.push({
      name: "CHANGELOG preservation",
      pass: true,
      expected: "preserved",
      got: "no CHANGELOG",
      detail: "this repository has no CHANGELOG, so there is nothing to clobber",
    });
    return results;
  }

  const text = readTextOrNull(path.join(root, rel));
  if (text === null) {
    results.push({
      name: "CHANGELOG still exists",
      pass: false,
      expected: "readable",
      got: "MISSING",
      detail: `${rel} was recorded at baseline and cannot be read now`,
    });
    return results;
  }
  const after = parseChangelog(text);

  if (!before) {
    // A CHANGELOG that appeared during the run is new content, not lost content.
    results.push({
      name: "CHANGELOG preservation",
      pass: true,
      expected: "preserved",
      got: "new file",
      detail: `${rel} did not exist at baseline`,
    });
  } else {
    const afterHeadings = after.map((e) => e.heading);
    const missing = before.map((e) => e.heading).filter((h) => !afterHeadings.includes(h));
    results.push({
      name: "no CHANGELOG entry was deleted",
      pass: missing.length === 0,
      expected: "0 deleted",
      got: `${missing.length} deleted`,
      detail: missing.length ? `gone: ${missing.slice(0, 4).map((h) => JSON.stringify(h)).join(", ")}` : `${before.length} entries still present in ${rel}`,
    });

    // Relative order of the survivors. Reordering history is a rewrite even when
    // every line survives it.
    const survivors = before.map((e) => e.heading).filter((h) => afterHeadings.includes(h));
    const positions = survivors.map((h) => afterHeadings.indexOf(h));
    const ordered = positions.every((v, i) => i === 0 || positions[i - 1] < v);
    results.push({
      name: "CHANGELOG entry order is unchanged",
      pass: ordered,
      expected: "same order",
      got: ordered ? "same order" : "REORDERED",
      detail: ordered ? "surviving entries appear in their original sequence" : `order now: ${afterHeadings.slice(0, 5).join(" | ")}`,
    });

    // Everything below the newest entry is history. The newest one is what
    // /ship just wrote and what this workflow is allowed to polish.
    const protectedEntries = before.slice(1);
    const lost = [];
    for (const e of protectedEntries) {
      const now = after.find((a) => a.heading === e.heading);
      if (!now) continue; // already reported as deleted
      for (const line of e.body) {
        if (!now.body.includes(line)) lost.push(`${e.heading}: ${line.slice(0, 60)}`);
      }
    }
    results.push({
      name: "older CHANGELOG entries are byte-for-byte intact",
      pass: lost.length === 0,
      expected: "0 lines lost",
      got: `${lost.length} lines lost`,
      detail: lost.length
        ? `rewritten history: ${lost.slice(0, 3).join(" / ")}`
        : `${protectedEntries.length} entries older than the newest were left alone; voice polish on the newest entry is allowed`,
    });
  }

  // VERSION and CHANGELOG have to agree, which gstack asks the agent to eyeball
  // (Step 6.3). It is a string comparison.
  const versionRel = scanDocs(root, 1).find((k) => k === "version");
  const versionText = versionRel ? readTextOrNull(path.join(root, versionRel)) : null;
  const v = versionText ? versionText.trim().split("\n")[0].trim() : null;
  if (v && /^\d+\.\d+\.\d+(\.\d+)?$/.test(v)) {
    const hit = after.find((e) => e.version === v || e.heading.includes(v));
    results.push({
      name: "VERSION has a CHANGELOG entry",
      pass: Boolean(hit),
      expected: `an entry for ${v}`,
      got: hit ? `line ${hit.line}` : "NONE",
      detail: hit ? hit.heading : `VERSION says ${v} and no ${rel} heading mentions it`,
    });
  }
  return results;
}

// ------------------------------------------------------------ public surface

/**
 * Public surface added by this branch, read off the diff rather than recalled.
 * Deliberately conservative: a name that appears here is one somebody could type
 * into their own code or terminal, so a missing mention in the docs is a real
 * gap rather than an internal rename.
 */
const SURFACE_RULES = [
  { kind: "export", re: /^\+\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: "export", re: /^\+\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: "export", re: /^\+\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/, group: 1 },
  { kind: "function", re: /^\+(?:def|class)\s+([A-Za-z_][\w]*)/, group: 1 },
  { kind: "env", re: /^\+.*process\.env\.([A-Z][A-Z0-9_]{2,})/, group: 1 },
  { kind: "env", re: /^\+.*(?:os\.environ\[|os\.getenv\()["']([A-Z][A-Z0-9_]{2,})["']/, group: 1 },
];
const FLAG_RE = /(--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;

function extractSurface(root, range) {
  const diff = git(["diff", range, "--unified=0"], root);
  if (!diff.ok) return { ok: false, error: diff.stderr || "git diff failed" };
  const items = new Map();
  let file = null;
  for (const line of diff.stdout.split("\n")) {
    const fm = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fm) {
      file = fm[1];
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (!file || /\.(md|mdx|markdown|lock|snap)$/i.test(file)) continue;
    for (const rule of SURFACE_RULES) {
      const m = rule.re.exec(line);
      if (m && m[rule.group] && !m[rule.group].startsWith("_")) {
        const key = `${rule.kind}:${m[rule.group]}`;
        if (!items.has(key)) items.set(key, { name: m[rule.group], kind: rule.kind, evidence: file });
      }
    }
    let fm2;
    FLAG_RE.lastIndex = 0;
    while ((fm2 = FLAG_RE.exec(line)) !== null) {
      const key = `flag:${fm2[1]}`;
      if (!items.has(key)) items.set(key, { name: fm2[1], kind: "flag", evidence: file });
    }
  }
  // Whole new files that a user could reach, e.g. a new skill directory.
  const names = git(["diff", range, "--name-status"], root);
  if (names.ok) {
    for (const line of names.stdout.split("\n")) {
      const m = /^A\t(.+)$/.exec(line.trim());
      if (!m) continue;
      const p = m[1];
      const skill = /^(?:.*\/)?skills\/([^/]+)\/SKILL\.md$/.exec(p);
      if (skill) items.set(`skill:${skill[1]}`, { name: skill[1], kind: "skill", evidence: p });
    }
  }
  return { ok: true, items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function coverageOf(root, items, depth = 2) {
  const docs = scanDocs(root, depth);
  const texts = new Map();
  for (const rel of docs) {
    const t = readTextOrNull(path.join(root, rel));
    if (t !== null) texts.set(rel, t.split("\n"));
  }
  return items.map((it) => {
    const hits = [];
    for (const [rel, lines] of texts) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(it.name)) {
          hits.push(`${rel}:${i + 1}`);
          break;
        }
      }
    }
    return { ...it, mentions: hits };
  });
}

// -------------------------------------------------------------------- claims

const VALID_STATUS = new Set(["updated", "voice-polished", "current", "skipped"]);
const CHANGED_STATUS = new Set(["updated", "voice-polished"]);

/**
 * Summaries that describe nothing. gstack asks for "not just 'Updated
 * README.md' but 'README.md: added /new-skill to skills table, updated skill
 * count from 9 to 10'" and then accepts whatever arrives. A summary that is only
 * the filename, or only the word updated, is rejected here so that the PR body
 * cannot fill up with rows that say nothing.
 */
function summaryProblem(summary, rel) {
  const s = String(summary ?? "").trim();
  if (!s) return "no summary given";
  const bare = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const fileWords = rel.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const stripped = bare.replace(new RegExp(`\\b${fileWords.split(" ").join("\\s+")}\\b`, "g"), "").trim();
  const filler = new Set(["updated", "update", "updates", "changed", "changes", "edited", "revised", "polished", "fixed", "docs", "documentation", "the", "a", "and", "for", "to", "in", "of", "minor", "various", "some", "general", "misc"]);
  const meaningful = stripped.split(/\s+/).filter((w) => w && !filler.has(w));
  if (meaningful.length < 2) {
    return `summary "${s}" says nothing beyond the filename; name what specifically changed`;
  }
  return null;
}

function loadClaims(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `claims file ${file} could not be read (${e.code || e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `claims file ${file} is not valid JSON (${e.message})` };
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.files)) {
    return { ok: false, error: `claims file ${file} has no "files" array` };
  }
  return { ok: true, value: obj };
}

function verify(root, claimsFile, opts) {
  const results = [];
  const push = (name, pass, expected, got, detail) => results.push({ name, pass, expected, got, detail });

  const bl = loadBaseline(root);
  if (!bl.ok) {
    push("a before-picture exists", false, "baseline", "MISSING", bl.error);
    return results;
  }
  push("a before-picture exists", true, "baseline", "loaded", `${bl.path} (taken ${bl.record.takenAt})`);

  const branch = currentBranch(root);
  const sameBranch = !bl.record.branch || !branch || bl.record.branch === branch;
  push(
    "the baseline was taken on this branch",
    sameBranch,
    bl.record.branch ?? "unknown",
    branch ?? "unknown",
    sameBranch ? "the before and after describe the same branch" : `the baseline describes ${bl.record.branch}; comparing it to ${branch} would report another branch's edits as this run's work`,
  );

  const claims = loadClaims(claimsFile);
  if (!claims.ok) {
    push("the claims file is readable", false, "valid JSON", "UNREADABLE", claims.error);
    return results;
  }
  push("the claims file is readable", true, "valid JSON", "loaded", `${claims.value.files.length} file claims`);

  const claimed = new Map();
  let claimShapeOk = true;
  const shapeProblems = [];
  for (const c of claims.value.files) {
    const rel = c && typeof c.path === "string" ? relKey(root, c.path) : null;
    if (!rel) {
      claimShapeOk = false;
      shapeProblems.push(`${JSON.stringify(c?.path ?? c)} is not a path inside ${root}`);
      continue;
    }
    const status = String(c.status ?? "").toLowerCase();
    if (!VALID_STATUS.has(status)) {
      claimShapeOk = false;
      shapeProblems.push(`${rel} has status ${JSON.stringify(c.status)}, not one of ${[...VALID_STATUS].join("/")}`);
      continue;
    }
    claimed.set(rel, { rel, status, summary: c.summary ?? "" });
  }
  push(
    "every claim names a real path and a known status",
    claimShapeOk,
    "well formed",
    claimShapeOk ? "well formed" : `${shapeProblems.length} bad`,
    claimShapeOk ? "all claims parse" : shapeProblems.slice(0, 3).join(" / "),
  );

  // --- the two checks the whole file exists for -----------------------------

  const nowFiles = new Map();
  for (const rel of scanDocs(root, opts.depth)) {
    const h = hashFile(path.join(root, rel));
    if (h) nowFiles.set(rel, h);
  }
  const beforeFiles = new Map(Object.entries(bl.record.files));
  const allRels = new Set([...beforeFiles.keys(), ...nowFiles.keys()]);

  const phantom = []; // claimed as edited, bytes identical
  const silent = []; // bytes changed, not claimed
  const wrongCurrent = []; // claimed unchanged, bytes changed
  const ghost = []; // claimed, file not present and not claimed skipped

  for (const rel of allRels) {
    const before = beforeFiles.get(rel);
    const after = nowFiles.get(rel);
    const changed = !before || !after ? Boolean(before) !== Boolean(after) : before.sha !== after.sha;
    const c = claimed.get(rel);
    if (c && c.status !== "skipped" && !after) {
      ghost.push(`${rel} is claimed ${c.status} but no such file exists`);
      continue;
    }
    if (c && CHANGED_STATUS.has(c.status) && !changed) {
      phantom.push(`${rel} claimed "${c.status}" (${String(c.summary).slice(0, 48)}) but its bytes are identical to the baseline (sha ${before?.sha.slice(0, 12) ?? "n/a"})`);
    }
    if (c && c.status === "current" && changed) {
      wrongCurrent.push(`${rel} claimed "current" but its bytes changed during this run`);
    }
    if (!c && changed) {
      silent.push(`${rel} changed during this run and appears in no claim`);
    }
  }

  push(
    "every file reported as updated actually changed",
    phantom.length === 0,
    "0 phantom updates",
    `${phantom.length} phantom`,
    phantom.length ? phantom.slice(0, 3).join(" / ") : `${[...claimed.values()].filter((c) => CHANGED_STATUS.has(c.status)).length} edit claims are backed by a byte difference`,
  );
  push(
    "every file that changed was reported",
    silent.length === 0,
    "0 silent edits",
    `${silent.length} silent`,
    silent.length ? silent.slice(0, 3).join(" / ") : "no documentation file was modified without being named in the report",
  );
  push(
    "nothing reported as unchanged was edited",
    wrongCurrent.length === 0,
    "0 mislabelled",
    `${wrongCurrent.length} mislabelled`,
    wrongCurrent.length ? wrongCurrent.slice(0, 3).join(" / ") : "current means current",
  );
  push(
    "every claimed file is on disk",
    ghost.length === 0,
    "0 missing",
    `${ghost.length} missing`,
    ghost.length ? ghost.slice(0, 3).join(" / ") : "every claim points at a file that exists",
  );

  const summaryProblems = [];
  for (const c of claimed.values()) {
    if (!CHANGED_STATUS.has(c.status)) continue;
    const p = summaryProblem(c.summary, c.rel);
    if (p) summaryProblems.push(`${c.rel}: ${p}`);
  }
  push(
    "every edit says what specifically changed",
    summaryProblems.length === 0,
    "0 empty summaries",
    `${summaryProblems.length} empty`,
    summaryProblems.length ? summaryProblems.slice(0, 3).join(" / ") : "each edit carries a summary that names the change",
  );

  // --- coverage claims ------------------------------------------------------

  const covClaims = Array.isArray(claims.value.coverage) ? claims.value.coverage : [];
  const covMisses = [];
  for (const c of covClaims) {
    const entity = String(c?.entity ?? "").trim();
    const where = c?.documented_in ?? c?.documentedIn;
    if (!entity || !where) {
      covMisses.push(`${JSON.stringify(c)} needs both "entity" and "documented_in"`);
      continue;
    }
    const rel = relKey(root, where);
    const text = rel ? readTextOrNull(path.join(root, rel)) : null;
    if (text === null) {
      covMisses.push(`${entity} is claimed documented in ${where}, which cannot be read`);
      continue;
    }
    if (!text.includes(entity)) {
      covMisses.push(`${entity} is claimed documented in ${where}, and the string does not appear in that file`);
    }
  }
  push(
    "every coverage claim is in the file it names",
    covMisses.length === 0,
    "0 unsupported",
    `${covMisses.length} unsupported`,
    covMisses.length ? covMisses.slice(0, 3).join(" / ") : covClaims.length ? `${covClaims.length} coverage claims found in the named files` : "no coverage claims were made",
  );

  results.push(...changelogCheck(root, bl.record));
  return results;
}

// ------------------------------------------------------------ PR body section

/**
 * Merge a section into a PR body, idempotently, and refuse to do it on nothing.
 * The refusal is the point: gstack pipes `gh pr view` into a file with `>`, and
 * a redirect creates its target whether the command worked or not, so a failed
 * read hands the next step an empty body to write over the real one.
 */
function prSection(bodyFile, contentFile, title, allowEmpty) {
  if (!bodyFile || !fs.existsSync(bodyFile)) {
    return { ok: false, error: `the current PR body was never read (${bodyFile ?? "no --body given"}). Refusing to assemble a body from nothing: writing it back would erase whatever is on the PR now.` };
  }
  let body;
  try {
    body = fs.readFileSync(bodyFile, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    return { ok: false, error: `${bodyFile} could not be read (${e.code || e.message})` };
  }
  if (!body.trim() && !allowEmpty) {
    return {
      ok: false,
      error: `${bodyFile} is empty. That is what a FAILED "gh pr view" leaves behind, because ">" creates the file either way, so this is indistinguishable from a PR whose body really is blank. Re-read the body and check the exit code. If the body genuinely is blank, pass --allow-empty-body.`,
    };
  }
  let content;
  try {
    content = fs.readFileSync(contentFile, "utf8").replace(/\r\n/g, "\n").trim();
  } catch (e) {
    return { ok: false, error: `section content ${contentFile} could not be read (${e.code || e.message})` };
  }
  if (!content) return { ok: false, error: `section content ${contentFile} is empty; there is nothing to add` };

  const lines = body.split("\n");
  const headRe = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((l) => headRe.test(l));
  const block = `## ${title}\n\n${content}`;
  let merged;
  if (start === -1) {
    merged = `${body.replace(/\n+$/, "")}\n\n${block}\n`;
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,2}\s+\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    merged = `${[...lines.slice(0, start), ...block.split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
  }
  return { ok: true, body: merged, replaced: start !== -1 };
}

// ------------------------------------------------------------------ printing

function report(title, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  ${title}  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out(`\n  These claims are not backed by the files. Fix the docs or fix the report:`);
    for (const r of failed) out(`    - ${r.name}: ${flat(r.detail)}`);
    out("");
    return EXIT_FAILED;
  }
  out("");
  return EXIT_OK;
}

// ------------------------------------------------------------------ selftest

function run(args, env = {}, cwd = process.cwd()) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function mkrepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  const g = (a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", windowsHide: true });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "selftest@toolbay.invalid"]);
  g(["config", "user.name", "tb-docs selftest"]);
  g(["config", "commit.gpgsign", "false"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  g(["checkout", "-q", "-b", "feature"]);
  return dir;
}

function writeJson(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return p;
}

const CHANGELOG_BASE = `# Changelog

## 1.2.0 - 2026-08-01

- You can now export a report as CSV.
- Fixed the crash on an empty project.

## 1.1.0 - 2026-07-01

- First public release.
- Added the login screen.
`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-docs-selftest-"));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  const ENV = { TOOLBAY_STACK_STATE_DIR: state };
  const results = [];
  const assert = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
  assert("git is available to build the fixtures", "yes", gitAvailable ? "yes" : "NO", "the selftest cannot assert anything without git");
  if (!gitAvailable) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return finish(results, 0);
  }

  // ---------------------------------------------------------------- scan
  const repo = mkrepo(path.join(tmp, "repo"), {
    "README.md": "# Project\n\nRuns the thing.\n",
    "ARCHITECTURE.md": "# Architecture\n\nOne process.\n",
    "CHANGELOG.md": CHANGELOG_BASE,
    VERSION: "1.2.0\n",
    "docs/guide.md": "# Guide\n",
    "node_modules/pkg/README.md": "# noise\n",
    "src/index.js": "export function alpha() {}\n",
  });
  const scan = run(["scan", "--json"], ENV, repo);
  let scanned = [];
  try {
    scanned = JSON.parse(scan.stdout).files;
  } catch {
    scanned = [];
  }
  assert("scan finds docs at depth 1 and 2 without shelling out to find", "yes", scanned.includes("readme.md") && scanned.includes("docs/guide.md") ? "yes" : "NO", `found: ${scanned.join(", ")}`);
  assert("scan skips node_modules", "yes", scanned.some((f) => f.includes("node_modules")) ? "NO" : "yes", `found: ${scanned.join(", ")}`);
  assert("scan finds the extension-less docs gstack's *.md glob misses", "yes", scanned.includes("version") && scanned.includes("changelog.md") ? "yes" : "NO", `found: ${scanned.join(", ")}`);

  // ------------------------------------------------- verify with no baseline
  const claimsHonest = writeJson(path.join(tmp, "claims-honest.json"), {
    files: [{ path: "README.md", status: "updated", summary: "added the CSV export flag to the usage table" }],
  });
  const noBaseline = run(["verify", "--claims", claimsHonest], { TOOLBAY_STACK_STATE_DIR: path.join(tmp, "empty-state") }, repo);
  assert("verify fails closed when no baseline was ever taken", 1, noBaseline.status, "with nothing to compare against it must refuse, not print a clean table");

  // ---------------------------------------------------------- take a baseline
  const bl = run(["baseline"], ENV, repo);
  assert("baseline records the before-picture", 0, bl.status, bl.stderr.trim());

  // ------------------------------------------- the phantom update (headline)
  const phantom = run(["verify", "--claims", claimsHonest], ENV, repo);
  assert("verify catches a doc reported as updated that nobody edited", 1, phantom.status, "this is the run gstack's health table prints as success");
  assert("the phantom failure names the file and the reason", "yes", /README\.md.*identical/is.test(phantom.stdout) ? "yes" : "NO", phantom.stdout.slice(-300));

  // ------------------------------------------------------- the honest update
  fs.writeFileSync(path.join(repo, "README.md"), "# Project\n\nRuns the thing.\n\n## Usage\n\n`--csv` exports a report.\n", "utf8");
  const honest = run(["verify", "--claims", claimsHonest], ENV, repo);
  assert("verify passes once the file really was edited", 0, honest.status, honest.stdout.slice(-400));

  // ------------------------------------------------------------ silent edits
  fs.writeFileSync(path.join(repo, "ARCHITECTURE.md"), "# Architecture\n\nTwo processes.\n", "utf8");
  const silent = run(["verify", "--claims", claimsHonest], ENV, repo);
  assert("verify catches a doc edited but left out of the report", 1, silent.status, "a modified file that appears in no claim is a silent edit");

  // ------------------------------------------------- claimed current, edited
  const claimsWrongCurrent = writeJson(path.join(tmp, "claims-wrong-current.json"), {
    files: [
      { path: "README.md", status: "updated", summary: "added the CSV export flag to the usage table" },
      { path: "ARCHITECTURE.md", status: "current" },
    ],
  });
  const wrongCurrent = run(["verify", "--claims", claimsWrongCurrent], ENV, repo);
  assert("verify catches a file reported as unchanged that was edited", 1, wrongCurrent.status, "current has to mean current");

  // ----------------------------------------------------- path spelling forms
  const claimsBackslash = writeJson(path.join(tmp, "claims-backslash.json"), {
    files: [
      { path: ".\\README.md", status: "updated", summary: "added the CSV export flag to the usage table" },
      { path: "ARCHITECTURE.md", status: "updated", summary: "corrected the process count from one to two" },
    ],
  });
  const backslash = run(["verify", "--claims", claimsBackslash], ENV, repo);
  assert("a claim spelled .\\README.md resolves to the same file", 0, backslash.status, backslash.stdout.slice(-400));

  // ------------------------------------------------------- useless summaries
  const claimsBare = writeJson(path.join(tmp, "claims-bare.json"), {
    files: [
      { path: "README.md", status: "updated", summary: "Updated README.md" },
      { path: "ARCHITECTURE.md", status: "updated", summary: "corrected the process count from one to two" },
    ],
  });
  const bare = run(["verify", "--claims", claimsBare], ENV, repo);
  assert("verify rejects a summary that only restates the filename", 1, bare.status, "the PR body has to say what changed");

  // ------------------------------------------------------- a claim off-tree
  const claimsOutside = writeJson(path.join(tmp, "claims-outside.json"), {
    files: [{ path: "../elsewhere/README.md", status: "updated", summary: "added a section about the new flag" }],
  });
  const outside = run(["verify", "--claims", claimsOutside], ENV, repo);
  assert("verify rejects a claim about a file outside the repository", 1, outside.status, "");

  // ------------------------------------------------------- corrupt baseline
  const corruptState = path.join(tmp, "state-corrupt");
  fs.mkdirSync(path.join(corruptState, "document-release"), { recursive: true });
  const blPath = run(["baseline", "--print-path"], { TOOLBAY_STACK_STATE_DIR: corruptState }, repo).stdout.trim().split("\n").pop();
  fs.writeFileSync(blPath, "{ not json", "utf8");
  const corrupt = run(["verify", "--claims", claimsHonest], { TOOLBAY_STACK_STATE_DIR: corruptState }, repo);
  assert("verify fails closed on an unreadable baseline", 1, corrupt.status, "a broken before-picture is not an empty one");

  // ------------------------------------------------------ wrong-branch baseline
  const branchState = path.join(tmp, "state-branch");
  run(["baseline"], { TOOLBAY_STACK_STATE_DIR: branchState }, repo);
  spawnSync("git", ["checkout", "-q", "-b", "other"], { cwd: repo, encoding: "utf8", windowsHide: true });
  const wrongBranch = run(["verify", "--claims", claimsBackslash], { TOOLBAY_STACK_STATE_DIR: branchState }, repo);
  assert("verify fails when the baseline was taken on another branch", 1, wrongBranch.status, "otherwise another branch's edits are reported as this run's work");
  spawnSync("git", ["checkout", "-q", "feature"], { cwd: repo, encoding: "utf8", windowsHide: true });

  // ------------------------------------------------------------- coverage claims
  const claimsCoverage = writeJson(path.join(tmp, "claims-coverage.json"), {
    files: [
      { path: "README.md", status: "updated", summary: "added the CSV export flag to the usage table" },
      { path: "ARCHITECTURE.md", status: "updated", summary: "corrected the process count from one to two" },
    ],
    coverage: [{ entity: "--csv", documented_in: "README.md" }],
  });
  const covOk = run(["verify", "--claims", claimsCoverage], ENV, repo);
  assert("a coverage claim whose string is really in the file passes", 0, covOk.status, covOk.stdout.slice(-400));

  const claimsCoverageBad = writeJson(path.join(tmp, "claims-coverage-bad.json"), {
    files: [
      { path: "README.md", status: "updated", summary: "added the CSV export flag to the usage table" },
      { path: "ARCHITECTURE.md", status: "updated", summary: "corrected the process count from one to two" },
    ],
    coverage: [{ entity: "--ndjson", documented_in: "README.md" }],
  });
  const covBad = run(["verify", "--claims", claimsCoverageBad], ENV, repo);
  assert("a coverage claim for a string that is not in the file fails", 1, covBad.status, "documented has to mean it is in there");

  // ------------------------------------- line endings, and honest absences
  //
  // On Windows a formatter, an editor, or git's own autocrlf will rewrite every
  // line ending in a file it was pointed at. That is not a documentation
  // change, and it must not be able to launder a phantom update into a pass.
  const crlfRepo = mkrepo(path.join(tmp, "crlfrepo"), { "README.md": "# r\n\nOne line.\n", "GUIDE.md": "# g\n" });
  const crlfState = path.join(tmp, "state-crlf");
  run(["baseline"], { TOOLBAY_STACK_STATE_DIR: crlfState }, crlfRepo);
  fs.writeFileSync(path.join(crlfRepo, "README.md"), "# r\r\n\r\nOne line.\r\n", "utf8");
  const claimsCrlf = writeJson(path.join(tmp, "claims-crlf.json"), {
    files: [{ path: "README.md", status: "updated", summary: "documented the new retry behaviour in the usage section" }],
  });
  const crlf = run(["verify", "--claims", claimsCrlf], { TOOLBAY_STACK_STATE_DIR: crlfState }, crlfRepo);
  assert("rewriting only the line endings does not count as documenting anything", 1, crlf.status, "a CRLF rewrite must not launder a phantom update into a pass");

  const claimsSkipped = writeJson(path.join(tmp, "claims-skipped.json"), {
    files: [
      { path: "GUIDE.md", status: "current" },
      { path: "TODOS.md", status: "skipped" },
    ],
  });
  fs.writeFileSync(path.join(crlfRepo, "README.md"), "# r\n\nOne line.\n", "utf8");
  const skipped = run(["verify", "--claims", claimsSkipped], { TOOLBAY_STACK_STATE_DIR: crlfState }, crlfRepo);
  assert("a file reported skipped because it does not exist is accepted", 0, skipped.status, skipped.stdout.slice(-400));

  // ------------------------------------------------------------- CHANGELOG
  const clRepo = mkrepo(path.join(tmp, "clrepo"), { "CHANGELOG.md": CHANGELOG_BASE, VERSION: "1.2.0\n", "README.md": "# r\n" });
  const clState = path.join(tmp, "state-cl");
  run(["baseline"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);

  const clOk = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("changelog-check passes on an untouched CHANGELOG", 0, clOk.status, clOk.stdout.slice(-300));

  fs.writeFileSync(path.join(clRepo, "CHANGELOG.md"), CHANGELOG_BASE.replace("- You can now export a report as CSV.", "- You can now export any report as a CSV file."), "utf8");
  const clPolish = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("voice polish on the newest entry is allowed", 0, clPolish.status, clPolish.stdout.slice(-400));

  fs.writeFileSync(path.join(clRepo, "CHANGELOG.md"), CHANGELOG_BASE.replace("- Added the login screen.\n", ""), "utf8");
  const clLost = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("a line deleted from an older entry fails", 1, clLost.status, "this is the incident gstack documents and answers with a paragraph");

  fs.writeFileSync(path.join(clRepo, "CHANGELOG.md"), CHANGELOG_BASE.replace("## 1.1.0 - 2026-07-01", "## 1.1.0 - 2026-07-02"), "utf8");
  const clHeading = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("an older entry's heading being rewritten fails", 1, clHeading.status, "");

  const swapped = ["# Changelog", "", "## 1.1.0 - 2026-07-01", "", "- First public release.", "- Added the login screen.", "", "## 1.2.0 - 2026-08-01", "", "- You can now export a report as CSV.", "- Fixed the crash on an empty project.", ""].join("\n");
  fs.writeFileSync(path.join(clRepo, "CHANGELOG.md"), swapped, "utf8");
  const clOrder = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("reordering entries fails even though every line survives", 1, clOrder.status, "");

  fs.writeFileSync(path.join(clRepo, "CHANGELOG.md"), CHANGELOG_BASE, "utf8");
  fs.writeFileSync(path.join(clRepo, "VERSION"), "1.3.0\n", "utf8");
  const clVersion = run(["changelog-check"], { TOOLBAY_STACK_STATE_DIR: clState }, clRepo);
  assert("a VERSION with no CHANGELOG entry fails", 1, clVersion.status, "gstack asks the agent to eyeball this; it is a string comparison");

  // -------------------------------------------------------------- surface
  const srepo = mkrepo(path.join(tmp, "srepo"), { "README.md": "# s\n", "src/a.js": "// start\n" });
  fs.writeFileSync(path.join(srepo, "src/a.js"), "// start\nexport function exportReport() {}\nconst k = process.env.REPORT_TOKEN;\n// run with --emit-csv\n", "utf8");
  fs.mkdirSync(path.join(srepo, "skills", "brandnew"), { recursive: true });
  fs.writeFileSync(path.join(srepo, "skills", "brandnew", "SKILL.md"), "# brandnew\n", "utf8");
  const sg = (a) => spawnSync("git", a, { cwd: srepo, encoding: "utf8", windowsHide: true });
  sg(["add", "-A"]);
  sg(["commit", "-q", "-m", "add surface"]);
  const surf = run(["surface", "--json"], ENV, srepo);
  let items = [];
  try {
    items = JSON.parse(surf.stdout).surface;
  } catch {
    items = [];
  }
  const names = items.map((i) => i.name);
  assert("surface extracts a new export from the diff", "yes", names.includes("exportReport") ? "yes" : "NO", names.join(", "));
  assert("surface extracts a new CLI flag from the diff", "yes", names.includes("--emit-csv") ? "yes" : "NO", names.join(", "));
  assert("surface extracts a new env var from the diff", "yes", names.includes("REPORT_TOKEN") ? "yes" : "NO", names.join(", "));
  assert("surface extracts a newly added skill from the diff", "yes", names.includes("brandnew") ? "yes" : "NO", names.join(", "));

  const cov = run(["coverage", "--json"], ENV, srepo);
  let covItems = [];
  try {
    covItems = JSON.parse(cov.stdout).coverage;
  } catch {
    covItems = [];
  }
  const flag = covItems.find((c) => c.name === "--emit-csv");
  assert("coverage reports an undocumented entity as undocumented", "yes", flag && flag.mentions.length === 0 ? "yes" : "NO", JSON.stringify(flag ?? null));
  fs.writeFileSync(path.join(srepo, "README.md"), "# s\n\nRun with `--emit-csv` to write a CSV.\n", "utf8");
  const cov2 = run(["coverage", "--json"], ENV, srepo);
  let covItems2 = [];
  try {
    covItems2 = JSON.parse(cov2.stdout).coverage;
  } catch {
    covItems2 = [];
  }
  const flag2 = covItems2.find((c) => c.name === "--emit-csv");
  assert("coverage names the file and line once it is documented", "readme.md:3", flag2 ? flag2.mentions[0] : "none", JSON.stringify(flag2 ?? null));

  // ------------------------------------------------------------- pr-section
  const bodyReal = path.join(tmp, "body.md");
  const bodyEmpty = path.join(tmp, "body-empty.md");
  const content = path.join(tmp, "section.md");
  fs.writeFileSync(bodyReal, "## Summary\n\nAdds CSV export.\n\n## Test plan\n\nRan the suite.\n", "utf8");
  fs.writeFileSync(bodyEmpty, "", "utf8");
  fs.writeFileSync(content, "- README.md: added the `--csv` flag to the usage table.\n", "utf8");
  const outA = path.join(tmp, "merged-a.md");

  const prEmpty = run(["pr-section", "--body", bodyEmpty, "--content", content, "--out", path.join(tmp, "nope.md")], ENV, tmp);
  assert("pr-section refuses an empty body read, which is what a failed gh pr view leaves", 1, prEmpty.status, "gstack would write that emptiness over the PR");
  assert("the refusal explains the redirect trap", "yes", /created the file either way|creates the file/i.test(prEmpty.stdout + prEmpty.stderr) ? "yes" : "NO", (prEmpty.stdout + prEmpty.stderr).slice(0, 200));
  const prMissing = run(["pr-section", "--body", path.join(tmp, "does-not-exist.md"), "--content", content, "--out", path.join(tmp, "nope.md")], ENV, tmp);
  assert("pr-section refuses a body file that was never written", 1, prMissing.status, "");

  const pr1 = run(["pr-section", "--body", bodyReal, "--content", content, "--out", outA], ENV, tmp);
  assert("pr-section appends the section when it is absent", 0, pr1.status, pr1.stderr.trim());
  const merged1 = fs.readFileSync(outA, "utf8");
  assert("the appended body keeps the sections that were already there", "yes", merged1.includes("## Summary") && merged1.includes("## Test plan") && merged1.includes("## Documentation") ? "yes" : "NO", merged1);
  const outB = path.join(tmp, "merged-b.md");
  run(["pr-section", "--body", outA, "--content", content, "--out", outB], ENV, tmp);
  const merged2 = fs.readFileSync(outB, "utf8");
  assert("running pr-section twice is byte-identical", "yes", merged1 === merged2 ? "yes" : "NO", "the section is replaced, not stacked");
  fs.writeFileSync(content, "- README.md: added the `--csv` flag AND the `--ndjson` flag.\n", "utf8");
  const outC = path.join(tmp, "merged-c.md");
  run(["pr-section", "--body", outA, "--content", content, "--out", outC], ENV, tmp);
  const merged3 = fs.readFileSync(outC, "utf8");
  assert("re-running with new content replaces the old section", "yes", merged3.includes("--ndjson") && !merged3.includes("added the `--csv` flag to the usage table") && merged3.includes("## Test plan") ? "yes" : "NO", merged3);

  fs.rmSync(tmp, { recursive: true, force: true });
  return finish(results, 40);
}

/**
 * A selftest whose total depends on where it ran is a selftest that can quietly
 * stop asserting things, so the expected count is stated and falling short of it
 * is itself a failure. Same rule as tb-guard.
 */
function finish(results, expectedCount) {
  if (expectedCount) {
    results.push({
      name: `all ${expectedCount} assertions ran`,
      expected: String(expectedCount),
      got: String(results.length + 1),
      pass: results.length + 1 === expectedCount,
      detail: "the selftest must assert the same number of things wherever it is run from",
    });
  }
  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-docs selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out(`\n  tb-docs is NOT trustworthy in this state. Failures:`);
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${flat(r.detail)}`);
    out("");
    process.exitCode = 1;
    return EXIT_FAILED;
  }
  out("\n  Every deliberately dishonest report above was refused: a doc claimed as");
  out("  updated that nobody edited, a doc edited and left out of the report, a");
  out("  CHANGELOG entry quietly rewritten, and a PR body assembled from a failed");
  out("  read. That refusal is the whole feature.\n");
  return EXIT_OK;
}

// --------------------------------------------------------------------- entry

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
}

function help() {
  out(`
  tb-docs ${VERSION}, the evidence engine for /document-release

    scan [--depth N] [--json]         every documentation file, found with
                                      node:fs (gstack's "find -maxdepth 2"
                                      is find.exe in PowerShell)
    baseline [--base <branch>]        hash every doc file BEFORE the run
    surface [--json]                  public surface added by this branch,
                                      read off the diff
    coverage [--json]                 which docs mention each of those, by
                                      file and line
    verify --claims <file.json>       check the report against the bytes.
                                      Exit 1 if any doc is claimed updated
                                      and is not, or was edited and not
                                      reported
    changelog-check                   no entry deleted, reordered, or
                                      rewritten below the newest one
    pr-section --body <f> --content <f> [--out <f>] [--title Documentation]
                                      merge a section into a PR body,
                                      idempotently, refusing to build one
                                      out of a failed read
    selftest                          run all of the above against repos
                                      built to be wrong

  Every check fails closed. A missing or unreadable baseline is a failure,
  never "nothing to compare".
`);
}

function needRepo() {
  const root = repoRoot(process.cwd());
  if (!root) {
    err("tb-docs: not inside a git work tree, so there is no release to document.");
    process.exit(EXIT_UNUSABLE);
  }
  return root;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes("--json");
  const depth = Number(flag(argv, "--depth", "2")) || 2;

  if (cmd === "scan") {
    const root = needRepo();
    const files = scanDocs(root, depth);
    if (json) out(JSON.stringify({ root, files }, null, 2));
    else {
      out(`\n  ${files.length} documentation files under ${root} (depth ${depth})\n`);
      for (const f of files) out(`  ${f}`);
      out("");
    }
    return EXIT_OK;
  }

  if (cmd === "baseline") {
    const root = needRepo();
    const { record, path: p } = takeBaseline(root, { base: flag(argv, "--base"), depth });
    if (argv.includes("--print-path")) {
      out(p);
      return EXIT_OK;
    }
    out(`\n  baseline taken for ${root}`);
    out(`  branch ${record.branch ?? "unknown"} at ${record.head?.slice(0, 12) ?? "unknown"}`);
    out(`  base   ${record.base ?? "none"} (${record.baseHow})`);
    out(`  files  ${Object.keys(record.files).length} documentation files hashed`);
    out(`  written to ${p}`);
    out("\n  Now do the work. Then report it with:  tb-docs verify --claims <file>\n");
    return EXIT_OK;
  }

  if (cmd === "surface" || cmd === "coverage") {
    const root = needRepo();
    const { base } = detectBase(root, flag(argv, "--base"));
    const mb = mergeBase(root, base);
    const range = flag(argv, "--range", mb ? `${mb}...HEAD` : "HEAD~1...HEAD");
    const s = extractSurface(root, range);
    if (!s.ok) {
      err(`tb-docs: ${s.error}`);
      return EXIT_UNUSABLE;
    }
    if (cmd === "surface") {
      if (json) out(JSON.stringify({ range, surface: s.items }, null, 2));
      else {
        out(`\n  public surface added in ${range}\n`);
        if (!s.items.length) out("  none found");
        for (const i of s.items) out(`  ${i.kind.padEnd(9)} ${i.name.padEnd(28)} ${i.evidence}`);
        out("");
      }
      return EXIT_OK;
    }
    const cov = coverageOf(root, s.items, depth);
    if (json) out(JSON.stringify({ range, coverage: cov }, null, 2));
    else {
      out(`\n  documentation coverage for ${range}\n`);
      if (!cov.length) out("  no new public surface in this range");
      for (const c of cov) {
        out(`  ${c.mentions.length ? "MENTIONED  " : "UNDOCUMENTED"} ${c.name.padEnd(28)} ${c.mentions.join(", ") || `(added in ${c.evidence})`}`);
      }
      out("\n  MENTIONED means the string is in that file at that line. Which Diataxis");
      out("  quadrant it satisfies is still your call; that the string is there is not.\n");
    }
    const gaps = cov.filter((c) => !c.mentions.length).length;
    return argv.includes("--fail-on-gap") && gaps ? EXIT_FAILED : EXIT_OK;
  }

  if (cmd === "verify") {
    const root = needRepo();
    const claimsFile = flag(argv, "--claims");
    if (!claimsFile) {
      err("tb-docs: verify needs --claims <file.json>. See the SKILL.md for the shape.");
      return EXIT_UNUSABLE;
    }
    return report("tb-docs verify", verify(root, claimsFile, { depth }));
  }

  if (cmd === "changelog-check") {
    const root = needRepo();
    const bl = loadBaseline(root);
    if (!bl.ok) {
      return report("tb-docs changelog-check", [
        { name: "a before-picture exists", pass: false, expected: "baseline", got: "MISSING", detail: bl.error },
      ]);
    }
    return report("tb-docs changelog-check", changelogCheck(root, bl.record));
  }

  if (cmd === "pr-section") {
    const res = prSection(flag(argv, "--body"), flag(argv, "--content"), flag(argv, "--title", "Documentation"), argv.includes("--allow-empty-body"));
    if (!res.ok) {
      out(`\n  REFUSED: ${res.error}\n`);
      return EXIT_FAILED;
    }
    const dest = flag(argv, "--out") || path.join(stateDir(), "document-release", "pr-body.md");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, res.body, "utf8");
    out(`\n  ${res.replaced ? "replaced" : "appended"} the section. Body written to:\n  ${dest}\n`);
    out(`  Post it with:  gh pr edit --body-file "${dest}"\n`);
    return EXIT_OK;
  }

  if (cmd === "selftest") return selftest();
  help();
  return EXIT_OK;
}

try {
  const code = main();
  if (typeof code === "number" && code !== EXIT_OK && !process.exitCode) process.exitCode = code;
} catch (e) {
  err(`tb-docs: ${e?.stack ?? e}`);
  process.exit(EXIT_UNUSABLE);
}
