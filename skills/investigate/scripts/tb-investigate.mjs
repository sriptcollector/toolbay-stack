#!/usr/bin/env node
/**
 * tb-investigate.mjs: the two mechanical steps of the /investigate workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow this supports (the Iron Law, the four phases, the
 * scope lock after hypothesis, the 3-strike rule, the DEBUG REPORT block and its
 * DONE / DONE_WITH_CONCERNS / BLOCKED vocabulary) comes from `investigate` in
 * gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's investigate is prose only. Two of its steps are load-bearing and both
 * of them fail open on Windows, silently.
 *
 * 1. THE SCOPE LOCK DOES NOT LOCK. gstack registers this PreToolUse hook on Edit
 *    and Write (investigate/SKILL.md.tmpl:33):
 *
 *      bash -c 'S="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh";
 *               [ -x "$S" ] || S="${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh";
 *               [ -x "$S" ] && bash "$S" || exit 0'
 *
 *    `|| exit 0` means: if the script is not found or not marked executable, ALLOW
 *    the edit. Reproduced on Windows 11 against gstack 1.60.1.0, 2026-08-13:
 *
 *      $ printf '{"tool_name":"Edit","tool_input":{"file_path":"C:/Users/orion/other/x.txt"}}' \
 *          | bash -c 'S="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"; ... || exit 0'
 *      exit=0        (no output at all, which Claude Code reads as allow)
 *
 *    The step tells the user "Edits restricted to <dir>/ for this debug session",
 *    and nothing is restricted. A safety claim that is not true is worse than no
 *    claim, because the user stops watching.
 *
 * 2. THE BOUNDARY IT WRITES IS UNUSABLE ON WINDOWS. gstack writes the raw string
 *    `echo "<detected-directory>/" > "$STATE_DIR/freeze-dir.txt"`, and its
 *    check-freeze decides absoluteness with `case "$FILE_PATH" in /*)`. A
 *    `C:\proj\src` boundary is therefore treated as RELATIVE and has the current
 *    directory pasted onto the front, so every edit is denied and the user runs
 *    /unfreeze, ending with no protection at all.
 *
 * 3. `Status: DONE` IS AN ASSERTION, NOT A RESULT. gstack's Phase 5 asks for a
 *    DEBUG REPORT with Evidence and a Regression test, then lets the agent write
 *    its own Status line. Nothing stops `Evidence: (none)` sitting above
 *    `Status: DONE`. That is exactly the failure the Iron Law exists to prevent.
 *
 * So: `scope` computes a real boundary and installs it through the Toolbay Stack
 * guard, which fails closed; `report` refuses a DONE that is not backed by cited
 * evidence and exits non-zero. Both are checkable, which is the point.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { checkCitations } from "./tb-citations.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.3.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

// Exit codes are part of the contract: a caller has to be able to tell
// "the input was bad" from "the input was fine and the answer is no".
const EXIT_OK = 0;
const EXIT_REJECTED = 1; // the thing being checked failed the check
const EXIT_UNUSABLE = 2; // the input could not be read or made sense of
const EXIT_REFUSED = 3; // the request was well-formed but must not be honoured

// ------------------------------------------------------------ path handling
//
// Same rules as the Toolbay Stack guard, kept here rather than imported because
// a Claude Code skill has to stand alone in its own directory.

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

const normCase = (p) => (isWindows ? p.toLowerCase() : p);

/** The root of the volume a path lives on: "C:\" on Windows, "/" elsewhere. */
function volumeRoot(p) {
  const parsed = path.parse(path.resolve(p));
  return parsed.root;
}

// -------------------------------------------------------------- scope lock

/**
 * The narrowest single directory that contains every affected file.
 *
 * Refuses rather than guesses in the three cases where a "lock" would be a lie:
 * nothing to lock, paths on different volumes (Windows only, no common ancestor
 * exists), and a common ancestor that is a volume root (locking C:\ restricts
 * nothing).
 */
function computeScope(inputs, cwd = process.cwd()) {
  if (!inputs.length) {
    return { ok: false, code: EXIT_UNUSABLE, error: "no affected paths were given, so there is nothing to scope" };
  }

  const dirs = [];
  for (const raw of inputs) {
    const abs = toAbsolute(raw, cwd);
    if (!abs) {
      return { ok: false, code: EXIT_UNUSABLE, error: `"${raw}" could not be resolved to an absolute path` };
    }
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      // A file the fix has not created yet is legitimate. Its directory is what
      // matters, and that has to exist.
      isDir = false;
    }
    dirs.push({ raw, abs, dir: isDir ? abs : path.dirname(abs) });
  }

  const roots = [...new Set(dirs.map((d) => normCase(volumeRoot(d.dir))))];
  if (roots.length > 1) {
    return {
      ok: false,
      code: EXIT_REFUSED,
      error:
        `the affected paths span ${roots.length} volumes (${roots.join(", ")}), so no single directory contains them. ` +
        "Narrow the hypothesis, or state that the bug is repo-wide and skip the lock.",
    };
  }

  const split = dirs.map((d) => path.resolve(d.dir).split(/[\\/]+/));
  const common = [];
  for (let i = 0; i < split[0].length; i += 1) {
    const seg = split[0][i];
    if (split.every((parts) => normCase(parts[i] ?? "\u0000") === normCase(seg))) common.push(seg);
    else break;
  }
  const dir = path.resolve(common.join(path.sep) || volumeRoot(dirs[0].dir));

  if (normCase(dir) === normCase(volumeRoot(dir))) {
    return {
      ok: false,
      code: EXIT_REFUSED,
      error:
        `the narrowest directory containing those paths is the volume root (${dir}). ` +
        "A boundary there restricts nothing, so it will not be set. Say the bug is repo-wide instead of pretending it is scoped.",
    };
  }

  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { ok: false, code: EXIT_UNUSABLE, error: `${dir} is not a directory that exists, so containment cannot be checked` };
  }

  return { ok: true, dir, inputs: dirs };
}

/**
 * Where the Toolbay Stack guard engine lives. The scope lock is worthless
 * without it, so not finding it is an error, never a silent skip. This is the
 * exact line gstack gets wrong: `[ -x "$S" ] && bash "$S" || exit 0`.
 */
function findGuard() {
  const candidates = [
    // This skill's own copy first: it registers the hook, so it carries the
    // engine, and nothing here depends on another skill being installed.
    path.resolve(SELF, "..", "tb-guard.mjs"),
    path.resolve(SELF, "..", "..", "..", "careful", "scripts", "tb-guard.mjs"),
    path.resolve(SELF, "..", "..", "..", "guard", "scripts", "tb-guard.mjs"),
    path.resolve(SELF, "..", "..", "..", "freeze", "scripts", "tb-guard.mjs"),
    path.resolve(SELF, "..", "..", "..", "..", "src", "guard", "tb-guard.mjs"),
    path.join(os.homedir(), ".claude", "skills", "careful", "scripts", "tb-guard.mjs"),
    path.join(os.homedir(), ".claude", "skills", "guard", "scripts", "tb-guard.mjs"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function cmdScope(args) {
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const paths = args.filter((a) => !a.startsWith("--"));
  const res = computeScope(paths);

  if (!res.ok) {
    if (json) out(JSON.stringify({ ok: false, error: res.error }, null, 2));
    else err(`  REFUSED  ${res.error}`);
    process.exitCode = res.code;
    return;
  }

  if (!apply) {
    if (json) out(JSON.stringify({ ok: true, dir: res.dir, applied: false }, null, 2));
    else {
      out(`  scope    ${res.dir}`);
      out(`  covers   ${res.inputs.length} path(s)`);
      // ABSOLUTE ON BOTH SIDES: the script, and the paths handed to it.
      //
      // This printed `node tb-investigate.mjs scope --apply <the relative paths
      // you typed>`. Neither half worked. The bare basename only resolves if
      // your working directory happens to be the skill's own scripts folder,
      // which it never is, so pasting it died with MODULE_NOT_FOUND; and the
      // relative arguments only resolve from the directory you originally ran
      // it in. A next-step command that has to be repaired before it runs is
      // worse than printing nothing, because it reads as a working one — this
      // is the same "looks wired in, is not" failure the whole skill is about.
      // res.inputs carries each path already resolved, so use that.
      const applyPaths = res.inputs.map((i) => JSON.stringify(i.abs)).join(" ");
      out(`  apply    node ${JSON.stringify(SELF)} scope --apply ${applyPaths}`);
    }
    return;
  }

  const guard = findGuard();
  if (!guard) {
    const message =
      "the Toolbay Stack guard engine (tb-guard.mjs) was not found next to this skill, so the boundary cannot be enforced. " +
      "Refusing to report a scope lock that would not exist. Install the careful/freeze/guard skills, or continue without the lock and say so.";
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`  REFUSED  ${message}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const set = spawnSync(process.execPath, [guard, "freeze", "--set", res.dir], { encoding: "utf8" });
  if (set.status !== 0) {
    const message = `the guard refused to set the boundary: ${(set.stderr || set.stdout || "").trim() || `exit ${set.status}`}`;
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`  REFUSED  ${message}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  // Do not take the write on trust. Ask the guard what it would actually do to
  // an edit outside the boundary, which is the only question that matters.
  const probePath = path.join(path.dirname(res.dir), `tb-scope-probe-${process.pid}.txt`);
  const probe = spawnSync(process.execPath, [guard, "freeze"], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: probePath } }),
    encoding: "utf8",
  });
  let decision = "unparseable";
  try {
    const parsed = JSON.parse((probe.stdout || "").trim() || "{}");
    decision = parsed.permissionDecision ?? parsed.hookSpecificOutput?.permissionDecision ?? "allow";
  } catch {
    decision = "unparseable";
  }
  const enforced = decision === "deny";

  if (json) {
    out(JSON.stringify({ ok: enforced, dir: res.dir, applied: true, probe: { path: probePath, decision } }, null, 2));
  } else {
    out(`  scope    ${res.dir}`);
    out(`  guard    ${guard}`);
    out(`  probe    an Edit to ${probePath} -> ${decision}`);
    out(enforced ? "  LOCKED   edits outside the boundary are blocked. Run /unfreeze to lift it." : "  NOT LOCKED");
  }
  if (!enforced) {
    err(
      "  The boundary was written but the guard did not block an edit outside it. " +
        "Do NOT tell the user their edits are scoped. Run: node <guard> selftest",
    );
    process.exitCode = EXIT_REJECTED;
  }
}

// ------------------------------------------------------------ report gating
//
// gstack's DEBUG REPORT is a block of prose the agent fills in, including its
// own Status. This turns the three rules that are already written in gstack's
// "Important Rules" into a check that can fail:
//   - "Never apply a fix you cannot verify."
//   - "Never say 'this should fix it.' Verify and prove it."
//   - DONE requires a regression test and passing tests.

const FIELD_KEYS = ["Symptom", "Root cause", "Fix", "Evidence", "Regression test", "Related", "Status"];

/** Phrases that mean "I did not actually check", wherever they appear. */
const HEDGES = [
  "should fix",
  "should work",
  "should be fixed",
  "probably",
  "likely",
  "seems to",
  "appears to",
  "i believe",
  "i'm confident",
  "im confident",
  "presumably",
  "assume",
  "assumed",
  "not verified",
  "unverified",
  "could not verify",
  "couldn't verify",
];

const EMPTY_MARKERS = ["", "-", "--", "n/a", "na", "none", "tbd", "todo", "unknown", "pending", "(none)", "[none]", "..."];

/** file.ts:42, src/a/b.py:9, C:\proj\x.rb:120 — a citation you can go and open. */
const FILE_LINE = /[\w./\\+-]+\.[A-Za-z0-9]{1,10}:\d+/;
/** A bare path with an extension, for fields where a line number is not expected. */
const FILE_REF = /[\w./\\+-]+\.[A-Za-z0-9]{1,10}\b/;

function parseReport(text) {
  const fields = {};
  const lines = String(text).split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = /^\s*([A-Z][A-Za-z ]{2,20}):\s*(.*)$/.exec(line);
    if (m && FIELD_KEYS.some((k) => k.toLowerCase() === m[1].trim().toLowerCase())) {
      current = FIELD_KEYS.find((k) => k.toLowerCase() === m[1].trim().toLowerCase());
      fields[current] = m[2].trim();
      continue;
    }
    if (current && line.trim() && !/^[═─=_-]{3,}$/.test(line.trim())) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

const isEmptyish = (v) => EMPTY_MARKERS.includes(String(v ?? "").trim().toLowerCase().replace(/\.$/, ""));
const hedgesIn = (v) => HEDGES.filter((h) => String(v ?? "").toLowerCase().includes(h));

function gateReport(text, root = process.cwd()) {
  const problems = [];
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return { status: null, claimed: null, problems: ["the report was empty, so nothing could be checked"], ok: false };
  }

  const f = parseReport(raw);
  const claimed = (f.Status || "").trim().toUpperCase().split(/\s/)[0] || null;

  if (!claimed) {
    problems.push("no Status line, so the report claims nothing and cannot be accepted as DONE");
  } else if (!["DONE", "DONE_WITH_CONCERNS", "BLOCKED"].includes(claimed)) {
    problems.push(`Status "${claimed}" is not one of DONE, DONE_WITH_CONCERNS, BLOCKED`);
  }

  // THE CITATIONS ARE CHECKED AGAINST THE DISK.
  //
  // This gate used to prove only that a citation was SHAPED like a citation. A
  // report citing src/quantum/warp-core.mjs:4021 — a path that has never existed
  // in this repository — with the evidence "ran the full suite, everything was
  // green, trust me" was ACCEPTED, exit 0. A regex cannot tell a reference from
  // an invention, and the whole job of this gate is telling those apart.
  //
  // The check itself is not written here: it is the same code `tb-spec.mjs lint
  // --check-paths` runs, shared through tb-citations.mjs and asserted
  // byte-identical by tools/sync-guard.mjs. Copying it would have made the
  // /spec linter and the /investigate gate two things that agree until one of
  // them is fixed.
  //
  // It runs for EVERY status, including BLOCKED: a BLOCKED report is allowed to
  // have no evidence, but it is not allowed to cite a file that is not there.
  for (const p of checkCitations(raw, root).problems) problems.push(p);

  // BLOCKED claims nothing, so it only has to name what was tried.
  if (claimed === "BLOCKED") {
    if (isEmptyish(f["Root cause"]) && isEmptyish(f.Symptom)) {
      problems.push("a BLOCKED report still has to say what the symptom was");
    }
    return { status: claimed, claimed, problems, ok: problems.length === 0, fields: f };
  }

  const need = (key, extra) => {
    const v = f[key];
    if (v === undefined) problems.push(`missing "${key}:" — required before a fix can be called ${claimed || "complete"}`);
    else if (isEmptyish(v)) problems.push(`"${key}: ${v || "(blank)"}" is not a finding`);
    else if (extra) extra(v);
  };

  need("Symptom");
  need("Root cause", (v) => {
    const h = hedgesIn(v);
    if (h.length) problems.push(`Root cause hedges ("${h[0]}") — a hedged root cause is a guess, not a root cause`);
  });
  need("Fix", (v) => {
    if (!FILE_LINE.test(v)) problems.push('Fix cites no file:line — gstack\'s own rule is "with file:line references"');
  });
  need("Evidence", (v) => {
    const h = hedgesIn(v);
    if (h.length) problems.push(`Evidence hedges ("${h[0]}") — that is a claim, not evidence`);
  });

  if (claimed === "DONE") {
    need("Regression test", (v) => {
      if (!FILE_REF.test(v)) {
        problems.push("Regression test names no file — DONE requires a test that fails without the fix and passes with it");
      }
    });
  } else if (claimed === "DONE_WITH_CONCERNS" && (f["Regression test"] === undefined || isEmptyish(f["Regression test"]))) {
    // Allowed, but the concern has to be stated somewhere.
    if (isEmptyish(f.Related) && !/concern|cannot|intermittent|staging|flake/i.test(raw)) {
      problems.push("DONE_WITH_CONCERNS with no regression test and no stated concern — say what could not be verified");
    }
  }

  return { status: claimed, claimed, problems, ok: problems.length === 0, fields: f };
}

function cmdReport(args) {
  const json = args.includes("--json");
  // What the cited paths are relative to. The repository being debugged by
  // default, which is where a DEBUG REPORT's citations point.
  const rootIdx = args.indexOf("--root");
  const root = rootIdx !== -1 && args[rootIdx + 1] ? toAbsolute(args[rootIdx + 1]) : process.cwd();
  const fileIdx = args.indexOf("--file");
  let text;
  if (fileIdx !== -1) {
    const file = args[fileIdx + 1];
    if (!file) {
      err("  UNUSABLE  --file needs a path");
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      // gstack-style prose would say "skip this step silently". A report that
      // cannot be read is not a passing report.
      const message = `${file} could not be read (${e.code || e.message}), so the fix is NOT verified`;
      if (json) out(JSON.stringify({ ok: false, problems: [message] }, null, 2));
      else err(`  UNUSABLE  ${message}`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
  } else {
    try {
      text = fs.readFileSync(0, "utf8");
    } catch {
      text = "";
    }
  }

  const g = gateReport(text, root);
  if (json) {
    out(JSON.stringify({ ok: g.ok, claimed: g.claimed, root, problems: g.problems }, null, 2));
  } else {
    out();
    out(`  claimed status   ${g.claimed ?? "(none)"}`);
    out(`  citations vs     ${root}`);
    if (g.ok) {
      out(`  verdict          ACCEPTED`);
      out();
    } else {
      out(`  verdict          REJECTED`);
      out();
      for (const p of g.problems) out(`    - ${p}`);
      out();
      out(`  A fix is not DONE because the report says DONE. Fix the gaps above, or`);
      out(`  downgrade the status to BLOCKED and say what is still unknown.`);
      out();
    }
  }
  if (!g.ok) process.exitCode = EXIT_REJECTED;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { stdin = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const REPORT_OK = `DEBUG REPORT
════════════════════════════════════════
Symptom:         500 on POST /orders when the cart is empty
Root cause:      OrderBuilder#total divides by items.size without guarding zero
Fix:             app/services/order_builder.rb:47 guard items.empty? before dividing
Evidence:        bin/rspec spec/services/order_builder_spec.rb -> 41 examples, 0 failures
Regression test: spec/services/order_builder_spec.rb:120
Related:         TODOS.md "empty cart 500"
Status:          DONE
════════════════════════════════════════`;

const swap = (line, replacement) => REPORT_OK.replace(new RegExp(`^${line}.*$`, "m"), replacement);

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-investigate-selftest-"));
  const proj = path.join(tmp, "proj");
  const src = path.join(proj, "src");
  const authDir = path.join(src, "auth");
  const apiDir = path.join(src, "api");
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "session.ts"), "// x", "utf8");
  fs.writeFileSync(path.join(apiDir, "login.ts"), "// x", "utf8");
  const stateDir = path.join(tmp, "state");

  // The files REPORT_OK cites, at the lengths it cites into. The gate now reads
  // the disk, so the report that is supposed to be accepted has to be true.
  const lines = (n) => Array.from({ length: n }, (_, i) => `# line ${i + 1}`).join("\n");
  fs.mkdirSync(path.join(proj, "app", "services"), { recursive: true });
  fs.mkdirSync(path.join(proj, "spec", "services"), { recursive: true });
  fs.writeFileSync(path.join(proj, "app", "services", "order_builder.rb"), lines(60), "utf8");
  fs.writeFileSync(path.join(proj, "spec", "services", "order_builder_spec.rb"), lines(130), "utf8");
  fs.writeFileSync(path.join(proj, "TODOS.md"), "- empty cart 500\n", "utf8");
  // Every report check runs against that project, because a citation is only
  // checkable relative to a tree.
  const reportArgs = (...extra) => ["report", "--root", proj, ...extra];

  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  // A THROW IS A NAMED FAILURE, NOT A STACK TRACE.
  //
  // A selftest that dies mid-run prints no "N/M passed" line, and the suite
  // runner then reports "cannot be shown to have asserted anything" — true, and
  // useless, because it buries the ONE assertion that actually failed under a
  // stack trace pointing at a line that is merely downstream of it. A test that
  // crashes is indistinguishable from a test that never ran. That is the exact
  // fail-open this package exists to delete, and it has no business living in
  // the harness that proves the package works.
  try {

  // ---- scope: it computes the right directory
  {
    const r = runSelf(["scope", "--json", path.join(authDir, "session.ts"), path.join(authDir, "token.ts")]);
    const j = JSON.parse(r.stdout || "{}");
    check("scope of two files in one dir is that dir", authDir, j.dir ?? "(none)");
  }
  {
    const r = runSelf(["scope", "--json", path.join(authDir, "session.ts"), path.join(apiDir, "login.ts")]);
    const j = JSON.parse(r.stdout || "{}");
    check("scope of two sibling dirs is their parent", src, j.dir ?? "(none)");
  }
  if (isWindows) {
    // gstack's `case "$FILE_PATH" in /*)` reads a Git Bash path as absolute and a
    // C:\ path as relative. Both have to land on the same directory here.
    const msys = `/${authDir[0].toLowerCase()}${authDir.slice(2).replace(/\\/g, "/")}/session.ts`;
    const r = runSelf(["scope", "--json", msys, path.join(authDir, "token.ts")]);
    const j = JSON.parse(r.stdout || "{}");
    check("scope understands a Git Bash /c/... path", authDir, j.dir ?? "(none)");
  }
  {
    const r = runSelf(["scope", "--json", path.join(authDir, "a.ts").replace(/\\/g, "/"), path.join(authDir, "b.ts")]);
    const j = JSON.parse(r.stdout || "{}");
    check("scope understands mixed separators", authDir, j.dir ?? "(none)");
  }

  // ---- scope: it refuses rather than pretending
  {
    const r = runSelf(["scope", "--json"]);
    check("scope with no paths is refused", 2, r.status);
  }
  {
    const r = runSelf(["scope", "--json", path.join(authDir, "a.ts"), isWindows ? "Z:\\elsewhere\\b.ts" : "/elsewhere/b.ts"]);
    const bad = isWindows ? 3 : 3; // cross-volume on Windows, volume root on POSIX
    check("scope refuses paths with no useful common ancestor", bad, r.status);
  }
  {
    const root = volumeRoot(tmp);
    const r = runSelf(["scope", "--json", path.join(root, "a.ts"), path.join(root, "b.ts")]);
    check("scope refuses to lock the volume root", 3, r.status);
  }
  {
    const r = runSelf(["scope", "--json", path.join(tmp, "does", "not", "exist", "a.ts")]);
    check("scope refuses a directory that does not exist", 2, r.status);
  }

  // ---- scope --apply: the lock is proved, not announced
  {
    const r = runSelf(["scope", "--apply", "--json", path.join(authDir, "session.ts")], {
      env: { TOOLBAY_STACK_STATE_DIR: stateDir },
    });
    let j = {};
    try {
      j = JSON.parse(r.stdout || "{}");
    } catch {
      j = {};
    }
    check("scope --apply reports success only when the guard was found", 0, r.status, r.stderr.trim());
    check("scope --apply proves the boundary by probing the guard", "deny", j.probe?.decision ?? "(no probe)");
    // And the state the guard actually reads must be an absolute real directory,
    // not gstack's bare "<detected-directory>/" string.
    let stateOk = "missing";
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, "freeze.json"), "utf8"));
      stateOk = path.isAbsolute(st.dir) && fs.statSync(st.dir).isDirectory() ? "absolute+exists" : `bad: ${st.dir}`;
    } catch (e) {
      stateOk = `unreadable: ${e.code || e.message}`;
    }
    check("the written boundary is an absolute existing directory", "absolute+exists", stateOk);
  }

  // ---- report: it accepts a real one
  check("report accepts a fully evidenced DONE", 0, runSelf(reportArgs(), { stdin: REPORT_OK }).status, runSelf(reportArgs(), { stdin: REPORT_OK }).stdout.slice(0, 400));

  // ---- report: the citations are checked against the disk, not against a regex.
  // This is the hole the first clean install fell straight into: the gate whose
  // entire job is refusing unevidenced claims accepted a citation to a file that
  // has never existed, because the file:line was correctly SHAPED.
  {
    const invented = swap("Fix:", "Fix:             src/quantum/warp-core.mjs:4021 clamp the flux ratio");
    const r = runSelf(reportArgs(), { stdin: invented });
    check("report rejects a DONE citing a file that does not exist", 1, r.status, r.stdout.slice(0, 400));
    check("...and names the invented path", true, /warp-core\.mjs:4021/.test(r.stdout), r.stdout.slice(0, 400));
  }
  {
    const pastEnd = swap("Regression test:", "Regression test: spec/services/order_builder_spec.rb:9999");
    const r = runSelf(reportArgs(), { stdin: pastEnd });
    check("report rejects a citation past the end of a real file", 1, r.status, r.stdout.slice(0, 400));
    check("...and says how long that file really is", true, /only 130 lines/.test(r.stdout), r.stdout.slice(0, 400));
  }
  {
    // BLOCKED is allowed to have no evidence. It is NOT allowed to invent one.
    const r = runSelf(reportArgs(), { stdin: "Symptom: 502s\nRelated: src/nope/missing.ts:12\nStatus: BLOCKED" });
    check("even a BLOCKED report may not cite a file that is not there", 1, r.status, r.stdout.slice(0, 400));
  }
  {
    // And the gate is not simply broken-closed: the same report, run against the
    // tree it is actually about, still passes.
    const r = runSelf(reportArgs(), { stdin: REPORT_OK });
    check("...while a truthful report against the right tree still passes", 0, r.status, r.stdout.slice(0, 300));
  }

  // ---- report: it rejects the ways a DONE gets faked
  const rejects = [
    ["report rejects DONE with Evidence: none", swap("Evidence:", "Evidence:        none")],
    ["report rejects DONE with a blank Evidence line", swap("Evidence:", "Evidence:")],
    ["report rejects DONE whose Fix cites no file:line", swap("Fix:", "Fix:             guarded the empty case in the order builder")],
    ["report rejects DONE with Regression test: N/A", swap("Regression test:", "Regression test: N/A")],
    ["report rejects DONE with no Regression test line at all", REPORT_OK.replace(/^Regression test:.*$\n/m, "")],
    ["report rejects a hedged root cause", swap("Root cause:", "Root cause:      probably the divide in OrderBuilder")],
    ["report rejects hedged evidence", swap("Evidence:", "Evidence:        should work now, the change looks right")],
    ["report rejects a missing Status line", REPORT_OK.replace(/^Status:.*$\n/m, "")],
    ["report rejects an invented status", swap("Status:", "Status:          SHIPPED")],
  ];
  for (const [name, payload] of rejects) {
    const r = runSelf(reportArgs(), { stdin: payload });
    check(name, 1, r.status, (r.stdout || "").split("\n").find((l) => l.trim().startsWith("- ")) ?? "");
  }

  // ---- report: fail closed on input it cannot use
  check("report rejects an empty report", 1, runSelf(reportArgs(), { stdin: "" }).status);
  check("report rejects prose with no fields", 1, runSelf(reportArgs(), { stdin: "I fixed it, all good now." }).status);
  check("report treats an unreadable file as NOT verified", 2, runSelf(reportArgs("--file", path.join(tmp, "nope.md"))).status);

  // ---- report: BLOCKED is allowed to be incomplete, because it claims nothing
  check(
    "report accepts BLOCKED without evidence",
    0,
    runSelf(reportArgs(), { stdin: "Symptom: intermittent 502 on deploy\nStatus: BLOCKED" }).status,
  );
  check(
    "report rejects BLOCKED that does not even name the symptom",
    1,
    runSelf(reportArgs(), { stdin: "Status: BLOCKED" }).status,
  );

  } catch (e) {
    check("the tb-investigate selftest ran to completion without throwing", true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-investigate", results);
}

// ------------------------------------------------------------------- output

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
  process.stdout.write("\n  Every rejection above is a case where the input claimed success and did not\n");
  process.stdout.write("  have it. The checks fail closed: a scope lock that cannot be enforced is\n");
  process.stdout.write("  refused rather than announced, and a DONE without cited evidence is not DONE.\n\n");
  return true;
}

function help() {
  out(`
  tb-investigate ${VERSION}  (Toolbay Stack)

  scope <path...>            narrowest directory containing the affected files
  scope <path...> --apply    set it as the edit boundary, then PROVE the guard
                             blocks an edit outside it (refuses if it cannot)
  report [--file <f>]        gate a DEBUG REPORT: a DONE without cited evidence
                             is rejected, exit 1. Reads stdin if no --file.
  selftest                   run every check above against deliberately broken
                             input; exits non-zero if any of them pass

  Options: --json

  Exit codes: 0 accepted, 1 rejected, 2 input unusable, 3 refused on purpose.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "scope") cmdScope(argv.slice(1));
else if (cmd === "report") cmdReport(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
