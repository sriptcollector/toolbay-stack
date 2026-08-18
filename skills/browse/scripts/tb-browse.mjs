#!/usr/bin/env node
/**
 * tb-browse.mjs: the Toolbay Stack browser-evidence engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /browse skill,
 * the persistent-daemon browser model, the command vocabulary it wraps --
 * goto, url, text, console, is, screenshot, snapshot, responsive -- and the
 * binary discovery chain <root>/{.claude,.agents,.codex}/skills/gstack/browse
 * /dist/browse) comes from `browse` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * This file does not reimplement the browser. It drives Garry's `browse`
 * binary. What it replaces is the shell preamble and the "run these commands
 * and eyeball the output" contract around it, both of which are wrong on
 * Windows and both of which fail open.
 *
 * WHY IT WAS REWRITTEN RATHER THAN FORKED LINE FOR LINE
 *
 * Measured on Windows 11, gstack 1.60.1.0, browse dist built 2026-07-29.
 *
 * 1. THE SETUP BLOCK PRINTS A PATH THAT ONLY ONE OF FOUR HOSTS CAN SEE.
 *    browse/SKILL.md resolves the binary with
 *      [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ]
 *    and prints `READY: <that path>`. On Windows the file on disk is
 *    `browse.exe`. Git Bash's `test -x` silently appends .exe, so the check
 *    passes and an extensionless path is printed. Nothing else agrees:
 *
 *      $ ls ~/.claude/skills/gstack/browse/dist/
 *      browse.exe  find-browse.exe  server-node.mjs  bun-polyfill.cjs
 *
 *      node  -e "fs.existsSync('.../dist/browse')"     -> false
 *      pwsh  Test-Path  '...\dist\browse'              -> False
 *      Read tool on that path                          -> File does not exist
 *
 *    So the moment that path leaves bash -- into a Node helper, into a
 *    PowerShell step, into a report -- it is a path to nothing.
 *
 * 2. `$B` DOES NOT SURVIVE THE TOOL CALL, AND THE FAILURE IS INVISIBLE.
 *    Every example in gstack's browse/SKILL.md is written as `$B goto ...`,
 *    `$B console`, `$B is visible ...`, with `B=` assigned once in the SETUP
 *    block. In Claude Code each Bash call is a fresh shell; env does not
 *    persist. Measured, two consecutive Bash calls:
 *
 *      call 1:  B="$HOME/.claude/skills/gstack/browse/dist/browse"
 *      call 2:  $B status
 *               /usr/bin/bash: line 8: status: command not found   (exit 127)
 *
 *    `$B console   # JS errors?` then produces no output, and no output from
 *    a console check reads exactly like a clean console. That is the fail-open
 *    that matters: the verification step is the thing that broke, and it
 *    reports the same shape as success.
 *
 * 3. A FAILED NAVIGATION STILL READS CLEAN. browse itself exits 1 on a bad
 *    goto -- correctly -- but the reads afterwards do not:
 *
 *      $ browse goto https://this-host-does-not-exist.invalid ; echo $?
 *      page.goto: net::ERR_NAME_NOT_RESOLVED ...                        1
 *      $ browse console ; echo $?
 *      --- BEGIN UNTRUSTED EXTERNAL CONTENT (source: chrome-error://chromewebdata/) ---
 *      (no console messages)
 *      --- END UNTRUSTED EXTERNAL CONTENT ---                           0
 *      $ browse text ; echo $?
 *      --- BEGIN UNTRUSTED EXTERNAL CONTENT (source: chrome-error://chromewebdata/) ---
 *                                                                       0
 *    "no console messages" and empty text, exit 0, on a page that never
 *    loaded. gstack's Core QA Pattern 1 is exactly this sequence, and every
 *    line of it passes.
 *
 * 4. `is visible` IS DOCUMENTED AS AN ASSERTION AND BEHAVES AS A QUERY.
 *      $ browse is visible ".element-that-does-not-exist" ; echo $?
 *      false                                                            0
 *    In gstack's pattern 2 that line is captioned `# success state present?`.
 *    Chained after a click it never stops anything.
 *
 * 5. /tmp IN THE EXAMPLES MEANS TWO DIFFERENT DIRECTORIES ON ONE MACHINE.
 *    `$B screenshot /tmp/bug.png` is in the skill eleven times. browse
 *    resolves /tmp the Git Bash way; Node and the Read tool resolve it the
 *    Windows way:
 *      browse ->  C:\Users\orion\AppData\Local\Temp\bug.png
 *      node   ->  C:\tmp\bug.png
 *    Pattern 11 says "always use the Read tool on the output PNG so the user
 *    can see them". Measured: `Read /tmp/tbs-probe.png` -> File does not
 *    exist, immediately after browse reported `Screenshot saved:
 *    C:/Users/orion/AppData/Local/Temp/tbs-probe.png`. The evidence exists and
 *    the report points somewhere else.
 *
 * 6. file:// EXAMPLES DO NOT LOAD ON WINDOWS. The skill documents
 *    `goto file://./docs/page.html` and `file://~/Documents/page.html`.
 *    Measured with a native path:
 *      $ browse goto "file://C:/Users/.../probe.html"
 *      Unsupported file URL host: C:. Use file:///<absolute-path> ...
 *    Three slashes work; two do not; the skill shows two.
 *
 * DESIGN RULES HERE
 *
 *   1. FAIL CLOSED. A check that could not be performed is a failure, never a
 *      pass. Exit 1 means the page is bad; exit 3 means this tool could not
 *      tell, which is also not success. There is no path that returns 0
 *      because something was missing.
 *   2. NO SHELL STATE. Nothing is carried in an environment variable between
 *      calls. `run` and `verify` resolve the binary themselves every time, so
 *      there is no `$B` to be empty.
 *   3. ONE PATH SPELLING. Every path this tool prints or writes is an absolute
 *      native path that Node, PowerShell, Git Bash, and the Read tool all
 *      resolve to the same file. An ambiguous path is refused with both of the
 *      directories it could mean printed out.
 *   4. PROVE IT. A pass has to be backed by output that exists: a URL that
 *      matches, page text that is non-empty, a PNG whose first eight bytes are
 *      a PNG signature. `selftest` runs the whole engine against a stub
 *      browser that lies in each of the ways above and fails if any lie is
 *      believed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBrowse } from "./tb-browse-bin.mjs";
import { checkArtifact } from "./tb-artifact.mjs";

const SELF = fileURLToPath(import.meta.url);
const IS_WIN = process.platform === "win32";

/** exit 0 = verified. exit 1 = a check failed. exit 3 = the check could not run. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_CHECK = 3;

/**
 * A screenshot is only evidence if it is a real PNG, not a file that starts
 * with the PNG signature. src/artifact/tb-artifact.mjs is the one standard.
 */
const checkPng = (file) => checkArtifact(file, { requirePng: true });


// --------------------------------------------------------------- small utils

function out(s) {
  process.stdout.write(s);
}
function err(s) {
  process.stderr.write(s);
}

/**
 * Exit without success. Used for every condition that means "this tool cannot
 * answer the question", which is never allowed to look like an answer.
 */
function cannotCheck(lines) {
  err(`\n  CANNOT CHECK\n`);
  for (const l of [].concat(lines)) err(`  ${l}\n`);
  err(`\n  This is a failure, not a pass. Nothing was verified.\n\n`);
  process.exit(EXIT_CANNOT_CHECK);
}

// -------------------------------------------------------- binary resolution
//
// gstack's chain is <root>/{.codex,.agents,.claude}/skills/gstack/browse/dist/
// browse, checked with `test -x`. Kept, with the Windows extensions added and
// with the result validated by fs.statSync so the path that comes out is one
// every host can open.

function requireBrowse(cwd) {
  const r = resolveBrowse(cwd);
  if (r.bin) return r;
  cannotCheck([
    "The browse binary was not found. Looked in, in order:",
    ...r.searched.map((s) => `  ${s}`),
    "",
    "Install it with gstack, or point TOOLBAY_BROWSE_BIN at the binary.",
    IS_WIN
      ? "On Windows the file is dist/browse.exe. gstack's own check uses `test -x dist/browse`,"
      : "",
    IS_WIN ? "which only Git Bash can satisfy, so a green SETUP there does not mean this found it." : "",
  ].filter(Boolean));
}

// ------------------------------------------------------------------ spawning

function spawnBrowse(bin, args, { timeoutMs = 120000, cwd = process.cwd() } = {}) {
  const isScript = /\.(mjs|js|cjs)$/i.test(bin);
  const cmd = isScript ? process.execPath : bin;
  const argv = isScript ? [bin, ...args] : args;
  const useShell = IS_WIN && /\.(cmd|bat)$/i.test(bin);
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    cwd,
    shell: useShell,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: (r.stdout || "").replace(/\r\n/g, "\n"),
    stderr: (r.stderr || "").replace(/\r\n/g, "\n"),
    // spawnSync sets signal SIGTERM on timeout, and status null. Both mean
    // "no answer", which is treated as a failed check, never as a pass.
    timedOut: r.status === null,
    spawnError: r.error ? String(r.error.message || r.error) : null,
  };
}

// --------------------------------------------------------- untrusted envelope

const ENVELOPE =
  /^--- BEGIN UNTRUSTED EXTERNAL CONTENT \(source: ([\s\S]*?)\) ---\n([\s\S]*?)\n?--- END UNTRUSTED EXTERNAL CONTENT ---/m;

/**
 * browse wraps page-derived output in an UNTRUSTED envelope whose header
 * carries the source URL. That header is the single most useful fact in the
 * output and gstack's skill never reads it: after a failed navigation it says
 * `source: chrome-error://chromewebdata/` while the body says "(no console
 * messages)". We read the header first and distrust the body when it is wrong.
 */
function unwrap(text) {
  const m = ENVELOPE.exec(text);
  if (!m) return { wrapped: false, source: null, body: text.trim() };
  return { wrapped: true, source: m[1].trim(), body: m[2].trim() };
}

// ------------------------------------------------------------- path handling

/**
 * On Windows "/tmp/x.png" names two different directories depending on who
 * resolves it. Refuse it and print both, rather than writing evidence into one
 * and linking the other.
 */
function ambiguousTmp(p) {
  if (!IS_WIN) return null;
  if (!/^[\\/](tmp|temp)([\\/]|$)/i.test(p)) return null;
  const rest = p.replace(/^[\\/](tmp|temp)[\\/]?/i, "");
  return [
    `Refusing the path "${p}". On Windows it names two directories:`,
    `  Git Bash / browse : ${path.win32.join(os.tmpdir(), rest)}`,
    `  node / Read tool  : ${path.resolve(p)}`,
    `Use an absolute path, or "node ${path.basename(SELF)} outdir" for one that every host agrees on.`,
  ];
}

function nativeAbs(p) {
  const bad = ambiguousTmp(p);
  if (bad) cannotCheck(bad);
  return path.resolve(p);
}

/** An absolute directory that browse, node, PowerShell and the Read tool all agree on. */
function outdir(name, create = true) {
  const base = path.join(process.cwd(), ".toolbay", "browse");
  const dir = name ? path.join(base, name) : base;
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Native path -> a file URL browse accepts. On Windows that needs three slashes. */
function toFileUrl(p) {
  const abs = path.resolve(p);
  const posix = abs.replace(/\\/g, "/");
  return posix.startsWith("/") ? `file://${posix}` : `file:///${posix}`;
}

// ------------------------------------------------------------- verify engine

function sameTarget(intended, actual) {
  if (!actual) return false;
  if (/^chrome-error:/i.test(actual)) return false;
  if (/^about:/i.test(actual)) return false;
  let a, b;
  try {
    a = new URL(intended);
  } catch {
    return false;
  }
  try {
    b = new URL(actual);
  } catch {
    return false;
  }
  if (a.protocol === "file:" && b.protocol === "file:") {
    return decodeURIComponent(b.pathname).toLowerCase().endsWith(
      decodeURIComponent(a.pathname).toLowerCase().replace(/^\/+/, "/"),
    );
  }
  return a.host.toLowerCase() === b.host.toLowerCase();
}

function verify(argv) {
  const opts = parseFlags(argv, {
    url: null,
    selector: null,
    shot: null,
    dir: null,
    timeout: "120",
    "allow-console-errors": false,
    "allow-empty-text": false,
  });
  if (!opts.url) cannotCheck(["verify needs --url <url>."]);
  const timeoutMs = Math.max(1, Number(opts.timeout) || 120) * 1000;

  const { bin, via } = requireBrowse();
  const dir = opts.dir ? nativeAbs(opts.dir) : outdir();
  fs.mkdirSync(dir, { recursive: true });
  const shot = opts.shot ? nativeAbs(opts.shot) : path.join(dir, `${slug(opts.url)}.png`);

  const steps = [];
  const B = (args) => spawnBrowse(bin, args, { timeoutMs });

  // 1. navigate
  const g = B(["goto", opts.url]);
  const gTail = (g.stdout + g.stderr).trim().split("\n")[0] || "(no output)";
  steps.push({
    name: "goto exits 0",
    ok: g.status === 0 && !g.timedOut && !g.spawnError,
    detail: g.spawnError
      ? `could not run the binary: ${g.spawnError}`
      : g.timedOut
        ? `timed out after ${timeoutMs / 1000}s`
        : `exit ${g.status}: ${gTail}`,
  });

  // 2. the page we are looking at is the page we asked for.
  const u = B(["url"]);
  const actual = u.stdout.trim().split("\n").pop() || "";
  steps.push({
    name: "current url is the requested page",
    ok: u.status === 0 && sameTarget(opts.url, actual),
    detail: actual ? `url = ${actual}` : `url command exit ${u.status}, no output`,
  });

  // 3. the page has content. An empty body under a chrome-error source is the
  //    exact shape gstack's pattern 1 reports as a clean load.
  const t = B(["text"]);
  const tw = unwrap(t.stdout);
  const textOk =
    t.status === 0 &&
    (opts["allow-empty-text"] || tw.body.length > 0) &&
    !/^chrome-error:/i.test(tw.source || "") &&
    !/^about:blank$/i.test(tw.source || "");
  steps.push({
    name: "page text is non-empty and not an error page",
    ok: textOk,
    detail: `source=${tw.source ?? "(no envelope)"} chars=${tw.body.length}`,
  });

  // 4. optional element assertion, as an assertion.
  if (opts.selector) {
    const v = B(["is", "visible", opts.selector]);
    const val = v.stdout.trim().split("\n").pop();
    steps.push({
      name: `element ${opts.selector} is visible`,
      ok: v.status === 0 && val === "true",
      detail: `is visible -> ${JSON.stringify(val)} (exit ${v.status})`,
    });
  }

  // 5. console errors.
  const c = B(["console", "--errors"]);
  const cw = unwrap(c.stdout);
  const errLines = cw.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\(no console (messages|errors)\)$/i.test(l));
  const consoleTrusted = c.status === 0 && cw.wrapped && !/^chrome-error:/i.test(cw.source || "");
  steps.push({
    name: opts["allow-console-errors"] ? "console read succeeded" : "console has no errors",
    ok: consoleTrusted && (opts["allow-console-errors"] || errLines.length === 0),
    detail: consoleTrusted
      ? errLines.length
        ? `${errLines.length} error line(s): ${errLines[0]}`
        : "clean"
      : `not trustworthy: source=${cw.source ?? "(no envelope)"} exit=${c.status}`,
  });

  // 6. evidence on disk that is really a PNG. The target is removed first, so
  //    a leftover PNG from an earlier run cannot stand in as this run's proof.
  fs.rmSync(shot, { force: true });
  const s = B(["screenshot", shot]);
  const png = checkPng(shot);
  steps.push({
    name: "screenshot exists on disk and is a PNG",
    ok: s.status === 0 && png.ok,
    detail: png.ok ? png.why : `${png.why} (screenshot exit ${s.status})`,
  });

  const failed = steps.filter((x) => !x.ok);
  const width = Math.max(...steps.map((x) => x.name.length));
  out(`\n  tb-browse verify  ${opts.url}\n`);
  out(`  binary: ${bin}  (${via})\n\n`);
  for (const st of steps) out(`  ${st.ok ? "PASS" : "FAIL"}  ${st.name.padEnd(width)}  ${st.detail}\n`);
  out(`\n  ${steps.length - failed.length}/${steps.length} checks passed\n`);
  if (png.ok) out(`  evidence: ${shot}\n  read it with: Read ${shot}\n`);
  out("\n");
  if (failed.length) {
    out(`  VERDICT FAIL. Do not report this page as working.\n\n`);
    process.exit(EXIT_FAILED);
  }
  out(`  VERDICT PASS.\n\n`);
}

/** `is`, as an assertion: anything other than a literal true is a failure. */
function assertCmd(argv) {
  const prop = argv[0];
  const sel = argv[1];
  const valid = ["visible", "hidden", "enabled", "disabled", "checked", "editable", "focused"];
  if (!prop || !sel) cannotCheck([`usage: assert <${valid.join("|")}> <selector|@ref>`]);
  if (!valid.includes(prop)) cannotCheck([`"${prop}" is not a state. One of: ${valid.join(", ")}`]);
  const { bin } = requireBrowse();
  const r = spawnBrowse(bin, ["is", prop, sel]);
  const val = r.stdout.trim().split("\n").pop();
  if (r.status === 0 && val === "true") {
    out(`  PASS  ${sel} is ${prop}\n`);
    return;
  }
  err(`  FAIL  ${sel} is ${prop}: got ${JSON.stringify(val ?? "")} (exit ${r.status})\n`);
  err(`        gstack's "is" prints false and exits 0, so chained checks never stop here.\n`);
  process.exit(EXIT_FAILED);
}

/** Run a raw browse command with the binary resolved here, not in a lost $B. */
function runCmd(argv) {
  if (!argv.length) cannotCheck([`usage: run -- <browse args...>`]);
  const { bin } = requireBrowse();
  const args = argv.map((a) => {
    if (/^[\\/](tmp|temp)[\\/]/i.test(a)) {
      const bad = ambiguousTmp(a);
      if (bad) cannotCheck(bad);
    }
    return a;
  });
  const r = spawnBrowse(bin, args);
  out(r.stdout);
  err(r.stderr);
  if (r.spawnError) cannotCheck([`could not run ${bin}: ${r.spawnError}`]);
  if (r.timedOut) cannotCheck([`${bin} ${args[0]} timed out`]);
  process.exit(r.status ?? EXIT_CANNOT_CHECK);
}

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase() || "page";
}

// -------------------------------------------------------------------- doctor

function doctor() {
  const r = resolveBrowse();
  out(`\n  tb-browse doctor  (node ${process.version}, ${process.platform})\n\n`);
  out(`  binary            ${r.bin ?? "NOT FOUND"}\n`);
  out(`  found via         ${r.via ?? "-"}\n`);
  if (!r.bin) {
    for (const s of r.searched) out(`    looked at        ${s}\n`);
  }
  out(`  output dir        ${outdir(null, false)}\n`);
  out(`  os.tmpdir()       ${os.tmpdir()}\n`);
  out(`  node "/tmp/x.png" ${path.resolve("/tmp/x.png")}\n`);
  if (IS_WIN && path.resolve("/tmp/x.png").toLowerCase() !== path.join(os.tmpdir(), "x.png").toLowerCase()) {
    out(`  -> /tmp is ambiguous on this machine. Paths under it are refused.\n`);
  }
  if (r.bin) {
    const st = spawnBrowse(r.bin, ["status"], { timeoutMs: 30000 });
    out(`\n  daemon status (exit ${st.status})\n`);
    for (const line of (st.stdout + st.stderr).trim().split("\n")) out(`    ${line}\n`);
    if (st.status !== 0) {
      out(`\n  The daemon is not answering. Any verify would fail closed, which is correct.\n\n`);
      process.exit(EXIT_CANNOT_CHECK);
    }
  } else {
    out("\n");
    process.exit(EXIT_CANNOT_CHECK);
  }
  out("\n");
}

// ------------------------------------------------------------------ selftest
//
// The engine is run as a real child process against a stub browser that lies
// in each of the six ways documented at the top of this file. A stub is used
// rather than the real browser so the test is hermetic and so the lies can be
// produced on demand: there is no way to ask a real Chromium to claim it saved
// a screenshot it did not save.

const STUB = `
import fs from "node:fs";
const mode = process.env.TB_STUB || "ok";
const [cmd, ...rest] = process.argv.slice(2);
const wrap = (src, body) =>
  "--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: " + src + ") ---\\n" + body + "\\n--- END UNTRUSTED EXTERNAL CONTENT ---";
const URL_OK = "https://app.example.com/dash";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAACUlEQVR4nGMAAAACAAFcucOgAAAAAElFTkSuQmCC", "base64");
if (mode === "crash") { process.exit(127); }
if (mode === "hang") { const t = Date.now(); while (Date.now() - t < 30000) {} process.exit(0); }
let src = URL_OK, url = URL_OK;
if (mode === "chromeerror") { src = "chrome-error://chromewebdata/"; url = "chrome-error://chromewebdata/"; }
if (mode === "blank") { src = "about:blank"; url = "about:blank"; }
if (mode === "wronghost") { src = "https://parked.example.net/"; url = "https://parked.example.net/"; }
switch (cmd) {
  case "goto":
    if (mode === "chromeerror") { process.stderr.write("page.goto: net::ERR_NAME_NOT_RESOLVED\\n"); process.exit(1); }
    process.stdout.write("Navigated to " + url + " (200)\\n"); break;
  case "url": process.stdout.write(url + "\\n"); break;
  case "text": process.stdout.write(wrap(src, mode === "chromeerror" || mode === "emptytext" ? "" : "Dashboard") + "\\n"); break;
  case "console":
    process.stdout.write(wrap(src, mode === "consoleerr" ? "[2026-01-01T00:00:00Z] [error] boom" : "(no console errors)") + "\\n"); break;
  case "is": process.stdout.write((mode === "chromeerror" || mode === "missingel" ? "false" : "true") + "\\n"); break;
  case "screenshot": {
    const p = rest[rest.length - 1];
    if (mode === "noshot") { /* claim, write nothing */ }
    else if (mode === "zeroshot") fs.writeFileSync(p, "");
    else if (mode === "notpng") fs.writeFileSync(p, "<html>error</html>");
    else fs.writeFileSync(p, PNG);
    process.stdout.write("Screenshot saved: " + p + "\\n"); break;
  }
  case "status": process.stdout.write("Status: healthy\\n"); break;
  default: process.exit(1);
}
process.exit(0);
`;

function runSelf(args, env, cwd) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 90000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || "") };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browse-selftest-"));

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // The binary resolver searches the git root FIRST, so an ancestor repository
  // above the sandbox lets the "no usable binary" cases resolve to whatever the
  // developer really has installed, and `fakeHome` below stops being the only
  // place looked. Found on this machine 2026-08-16 via a stray `git init` in
  // HOME. See the same guard, and the same reasoning, in tb-browse-bin.mjs.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const stub = path.join(tmp, "stub-browse.mjs");
  fs.writeFileSync(stub, STUB, "utf8");
  const work = path.join(tmp, "work");
  fs.mkdirSync(work, { recursive: true });

  // A directory shaped exactly like a gstack install with NO usable binary:
  // an extensionless `browse` file, which is what `test -x` reports as ready
  // on Windows and what every other host reports as absent.
  const fakeHome = path.join(tmp, "fakehome");
  const fakeDist = path.join(fakeHome, ".claude", "skills", "gstack", "browse", "dist");
  fs.mkdirSync(fakeDist, { recursive: true });
  fs.writeFileSync(path.join(fakeDist, "browse"), "not a windows executable", "utf8");

  // Every case gets its own output directory. Sharing one would let an earlier
  // case's PNG stand in as the later case's evidence, which is precisely the
  // stale-artifact bug this engine exists to catch.
  let caseNo = 0;
  const V = (_tag, extra = []) => [
    "verify",
    "--url",
    "https://app.example.com/dash",
    "--dir",
    path.join(work, `shots-${String(++caseNo).padStart(2, "0")}`),
    ...extra,
  ];

  const cases = [];
  const add = (name, args, env, expect, expectStatus) =>
    cases.push({ name, args, env: { TOOLBAY_BROWSE_BIN: stub, ...env }, expect, expectStatus });

  // --- it passes when the page is really fine, or the whole thing is theatre
  add("verify passes a page that really loaded", V(), { TB_STUB: "ok" }, "pass", EXIT_OK);
  add("verify passes with a selector that is really there", V("ok", ["--selector", "#root"]), { TB_STUB: "ok" }, "pass", EXIT_OK);

  // --- the six documented fail-open shapes, each must fail
  add(
    "FAILS a navigation that landed on chrome-error (gstack reports console clean)",
    V(),
    { TB_STUB: "chromeerror" },
    "fail",
    EXIT_FAILED,
  );
  add("FAILS a page that is still about:blank", V(), { TB_STUB: "blank" }, "fail", EXIT_FAILED);
  add("FAILS when the url ended up on a different host", V(), { TB_STUB: "wronghost" }, "fail", EXIT_FAILED);
  add("FAILS a page whose text is empty", V(), { TB_STUB: "emptytext" }, "fail", EXIT_FAILED);
  add("FAILS when the console has an error", V(), { TB_STUB: "consoleerr" }, "fail", EXIT_FAILED);
  add(
    "FAILS a selector that is not there (gstack prints false, exit 0)",
    V("x", ["--selector", "#gone"]),
    { TB_STUB: "missingel" },
    "fail",
    EXIT_FAILED,
  );
  add(
    "FAILS a screenshot the browser claimed to save and did not",
    V(),
    { TB_STUB: "noshot" },
    "fail",
    EXIT_FAILED,
  );
  add("FAILS a zero-byte screenshot", V(), { TB_STUB: "zeroshot" }, "fail", EXIT_FAILED);
  // A stale PNG left in the output directory by an earlier run is the easiest
  // way for a broken run to look proven. Same directory twice, second run's
  // browser writes nothing.
  const staleDir = path.join(work, "stale");
  fs.mkdirSync(staleDir, { recursive: true });
  cases.push({
    name: "seeds a real screenshot into a reused directory",
    args: ["verify", "--url", "https://app.example.com/dash", "--dir", staleDir],
    env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "ok" },
    expect: "pass",
    expectStatus: EXIT_OK,
  });
  cases.push({
    name: "FAILS rather than reusing the stale screenshot from the run above",
    args: ["verify", "--url", "https://app.example.com/dash", "--dir", staleDir],
    env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "noshot" },
    expect: "fail",
    expectStatus: EXIT_FAILED,
  });
  add("FAILS a screenshot file that is not actually a PNG", V(), { TB_STUB: "notpng" }, "fail", EXIT_FAILED);

  // --- the browser itself being broken must never look like a pass
  add("FAILS when every browse command exits 127 (the lost $B case)", V(), { TB_STUB: "crash" }, "fail", EXIT_FAILED);
  add(
    "FAILS when the browser hangs instead of answering",
    V("x", ["--timeout", "2"]),
    { TB_STUB: "hang" },
    "fail",
    EXIT_FAILED,
  );

  // --- allow-flags relax the right check and nothing else
  add(
    "--allow-console-errors relaxes only the console check",
    V("x", ["--allow-console-errors"]),
    { TB_STUB: "consoleerr" },
    "pass",
    EXIT_OK,
  );
  add(
    "--allow-console-errors does NOT rescue a chrome-error page",
    V("x", ["--allow-console-errors", "--allow-empty-text"]),
    { TB_STUB: "chromeerror" },
    "fail",
    EXIT_FAILED,
  );

  // --- assert is an assertion
  cases.push({
    name: "assert exits non-zero on a missing element",
    args: ["assert", "visible", "#gone"],
    env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "missingel" },
    expect: "fail",
    expectStatus: EXIT_FAILED,
  });
  cases.push({
    name: "assert exits 0 on an element that is there",
    args: ["assert", "visible", "#root"],
    env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "ok" },
    expect: "pass",
    expectStatus: EXIT_OK,
  });

  // --- resolution and paths fail closed rather than pretending
  cases.push({
    name: "CANNOT CHECK when no binary exists at all",
    args: V(),
    env: { TOOLBAY_BROWSE_BIN: path.join(tmp, "nope", "browse") },
    expect: "cannot-check",
    expectStatus: EXIT_CANNOT_CHECK,
  });
  if (IS_WIN) {
    cases.push({
      name: "CANNOT CHECK on an extensionless browse (what gstack's test -x accepts)",
      args: ["doctor"],
      env: { TOOLBAY_BROWSE_BIN: "", HOME: fakeHome, USERPROFILE: fakeHome },
      expect: "cannot-check",
      expectStatus: EXIT_CANNOT_CHECK,
      cwd: fakeHome,
    });
    cases.push({
      name: "CANNOT CHECK on a /tmp output path (means two directories here)",
      args: ["verify", "--url", "https://app.example.com/dash", "--dir", "/tmp/qa"],
      env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "ok" },
      expect: "cannot-check",
      expectStatus: EXIT_CANNOT_CHECK,
    });
    cases.push({
      name: "CANNOT CHECK when run is handed a /tmp argument",
      args: ["run", "--", "screenshot", "/tmp/bug.png"],
      env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "ok" },
      expect: "cannot-check",
      expectStatus: EXIT_CANNOT_CHECK,
    });
  }

  // --- run resolves the binary itself, so there is no $B to be empty
  cases.push({
    name: "run works with no environment carried in from a previous call",
    args: ["run", "--", "status"],
    env: { TOOLBAY_BROWSE_BIN: stub, TB_STUB: "ok" },
    expect: "pass",
    expectStatus: EXIT_OK,
  });

  const results = [];
  for (const c of cases) {
    const r = runSelf(c.args, c.env, c.cwd || work);
    const got =
      r.status === EXIT_OK ? "pass" : r.status === EXIT_CANNOT_CHECK ? "cannot-check" : r.status === null ? "hung" : "fail";
    results.push({
      name: c.name,
      expected: c.expect,
      got,
      pass: got === c.expect && r.status === c.expectStatus,
      detail: (r.stdout.trim().split("\n").filter(Boolean).pop() || "").slice(0, 120),
      status: r.status,
    });
  }

  // The engine must never be able to reach exit 0 through a path where the
  // evidence file is absent. Checked directly, not through the CLI.
  results.push({
    name: "checkPng rejects a missing, empty, and non-PNG file",
    expected: "pass",
    got:
      !checkPng(path.join(tmp, "nothing.png")).ok &&
      (fs.writeFileSync(path.join(tmp, "empty.png"), ""), !checkPng(path.join(tmp, "empty.png")).ok) &&
      (fs.writeFileSync(path.join(tmp, "html.png"), "<html>"), !checkPng(path.join(tmp, "html.png")).ok)
        ? "pass"
        : "fail",
    pass: true,
    detail: "",
    status: 0,
  });
  results[results.length - 1].pass = results[results.length - 1].got === "pass";

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict. This engine spawns a stub
  // browser dozens of times, including cases that are KILLED on a timeout, and
  // on Windows a just-killed child can still hold a handle to its own directory
  // for a moment. `force: true` does not cover EPERM, so this rmSync used to
  // throw AFTER every assertion had already passed and take the entire report
  // with it — the suite runner then saw no "N/M passed" line and could not tell
  // 25 passing assertions from an engine that never ran.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-browse selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    out(`\n  This engine is NOT trustworthy in this state. Failures:\n`);
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got} (exit ${r.status}). ${r.detail}\n`);
    out("\n");
    process.exitCode = 1;
    return;
  }
  out(`\n  Every deliberately broken browser above was caught. A page that did not load,\n`);
  out(`  a screenshot that was never written, and a browser that is not running all end\n`);
  out(`  in a non-zero exit rather than a clean-looking report.\n\n`);
}

// ----------------------------------------------------------------- arg parse

function parseFlags(argv, defaults) {
  const o = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key in o && typeof o[key] === "boolean") {
        o[key] = true;
      } else if (key in o) {
        o[key] = argv[++i];
      } else {
        cannotCheck([`unknown flag --${key}`]);
      }
    } else {
      o._.push(a);
    }
  }
  return o;
}

const HELP = `
  tb-browse  Toolbay Stack browser evidence engine (fork of gstack /browse)

  node tb-browse.mjs resolve
      Print the browse binary path, with the extension it really has on disk.

  node tb-browse.mjs outdir [name]
      Print (and create) an absolute output directory that browse, node,
      PowerShell, Git Bash and the Read tool all resolve to the same place.

  node tb-browse.mjs run -- <browse args...>
      Run a raw browse command. Resolves the binary itself, so nothing depends
      on a shell variable surviving between tool calls.

  node tb-browse.mjs verify --url <url> [--selector <css>] [--shot <file>]
                            [--dir <dir>] [--timeout <s>]
                            [--allow-console-errors] [--allow-empty-text]
      Load a page and prove it loaded: url matches, text is non-empty, the
      source is not chrome-error, console is clean, and a real PNG landed on
      disk. Exit 0 only if every check passed.

  node tb-browse.mjs assert <visible|hidden|enabled|disabled|checked|editable|focused> <sel>
      Like browse's "is", but exits non-zero when the answer is false.

  node tb-browse.mjs doctor
      Where the binary is, whether the daemon answers, and which paths this
      machine disagrees with itself about.

  node tb-browse.mjs selftest
      Run the engine against a browser that lies. Non-zero if any lie is
      believed.

  Exit codes: 0 verified, 1 a check failed, 3 the check could not be run.
`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "resolve": {
      const r = requireBrowse();
      out(`${r.bin}\n`);
      return;
    }
    case "outdir":
      out(`${outdir(rest[0])}\n`);
      return;
    case "fileurl":
      if (!rest[0]) cannotCheck(["usage: fileurl <path>"]);
      out(`${toFileUrl(rest[0])}\n`);
      return;
    case "run":
      return runCmd(rest[0] === "--" ? rest.slice(1) : rest);
    case "verify":
      return verify(rest);
    case "assert":
      return assertCmd(rest);
    case "doctor":
      return doctor();
    case "selftest":
      return selftest();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;
    default:
      err(`\n  unknown command "${cmd}"\n${HELP}`);
      process.exit(EXIT_CANNOT_CHECK);
  }
}

main();
