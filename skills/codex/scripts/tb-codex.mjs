#!/usr/bin/env node
/**
 * tb-codex.mjs: the Toolbay Stack outside-voice engine.
 *
 * Four commands, one file:
 *   preflight  can the OpenAI Codex CLI actually run and authenticate here
 *   run        invoke codex, stream it, and capture the output as evidence
 *   gate       turn a captured review into PASS / FAIL / UNVERIFIED
 *   selftest   proof that all of the above refuse to pass on broken input
 *   doctor     what this machine really has, including the tools gstack assumes
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /codex, the three modes review / challenge / consult, the "brutally honest
 * outside voice" persona, the [P1] / [P2] finding markers and the pass/fail
 * review gate, the filesystem-boundary preamble sent to Codex, session
 * continuity for consult follow-ups, and the verbatim "CODEX SAYS" presentation)
 * comes from `codex` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS IS AN ENGINE AND NOT 1596 LINES OF PROSE
 *
 * gstack's /codex is a markdown file. Every check in it is an instruction to
 * the model ("If NOT_FOUND: stop and tell the user"), and every decision that
 * matters is a sentence rather than an exit code. Two of those decisions fail
 * OPEN, and both were reproduced on this machine (Windows 11, Git Bash,
 * gstack 1.60.1.0, 2026-08-14).
 *
 * 1. THE REVIEW GATE RETURNS PASS WHEN THE REVIEWER NEVER SPOKE.
 *
 *    gstack SKILL.md:1049-1051, verbatim:
 *
 *      4. Determine gate verdict by checking the review output for critical
 *         findings. If the output contains [P1] — the gate is FAIL.
 *         If no [P1] markers are found (only [P2] or no findings) — PASS.
 *
 *    "No [P1] markers found" and "no output at all" are the same state to that
 *    rule, and on Windows the second one is the normal case. Challenge and
 *    Consult mode pipe codex's JSONL through:
 *
 *      PYTHON_CMD=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)
 *      if [ -z "$PYTHON_CMD" ]; then echo "ERROR: Python 3 is required..."; exit 1; fi
 *      ... codex exec ... --json | PYTHONUNBUFFERED=1 "$PYTHON_CMD" -u -c "<parser>"
 *      _CODEX_EXIT=${PIPESTATUS[0]}
 *
 *    On a default Windows install `python3` IS on PATH — it is the Microsoft
 *    Store alias stub — so `command -v python3` succeeds and gstack's own
 *    "Python 3 is required" guard never fires. The stub then prints an advert
 *    to stderr, exits 49, and writes nothing to stdout. Reproduced against a
 *    stand-in codex emitting the exact JSONL the parser expects, including a
 *    [P1] SQL-injection finding:
 *
 *      GUARD PASSES. PYTHON_CMD=/c/Users/orion/AppData/Local/Microsoft/WindowsApps/python3
 *      PIPESTATUS[0] (what gstack reads) = 0
 *      bytes of codex output that reached the user: 0
 *      --- python stderr (silently dropped by gstack) ---
 *      Python was not found; run without arguments to install from the Microsoft Store...
 *      === gstack gate rule applied to that output ===
 *      GATE: PASS
 *
 *    PIPESTATUS[0] is codex's status, not the parser's, so nothing anywhere in
 *    the pipeline notices. A critical finding became a green gate.
 *
 *    `gate` here has three verdicts, not two. Empty output, whitespace, a file
 *    that is only error noise, and prose that never used the marker contract
 *    all return UNVERIFIED and exit 2. PASS requires positive evidence that a
 *    review ran to completion: the REVIEW_COMPLETE sentinel the prompt asks
 *    for. Absence of evidence is never scored as evidence of absence.
 *
 * 2. THE AUTH PROBE PASSES ON A CREDENTIAL FILE WITH NOTHING IN IT.
 *
 *    gstack bin/gstack-codex-probe checks `[ -f "$_codex_home/auth.json" ]`.
 *    Existence, not contents. Reproduced:
 *
 *      $ ls -l fakecodexhome/auth.json
 *      -rw-r--r-- 1 orion 197609 0 Aug 14 09:09 fakecodexhome/auth.json
 *      $ CODEX_HOME="$PWD/fakecodexhome" _gstack_codex_auth_probe
 *      AUTH_OK
 *      probe exit=0
 *
 *    A logged-out, half-written, or truncated auth.json reports ready, the
 *    skill builds the expensive prompt, and the failure lands minutes later as
 *    unparsed stderr. `preflight` here parses the file and requires an actual
 *    credential, and it also EXECUTES the binary rather than trusting that a
 *    name on PATH is a working program.
 *
 * 3. THE PREFLIGHT DOES NOT EXIST AS A THING THAT CAN FAIL.
 *
 *    gstack Step 0.4 is `command -v codex` and a sentence telling the model to
 *    stop. There is no exit code, so nothing downstream can be conditioned on
 *    it, and the same skill then runs `codex review` whose absence produces an
 *    empty capture, which item 1 scores as PASS. `preflight` returns 0 READY,
 *    3 NOT INSTALLED, 4 NOT AUTHENTICATED, 5 UNUSABLE, so a caller can branch
 *    and a CI job can fail.
 *
 * DESIGN RULES, same as the rest of Toolbay Stack:
 *
 *   1. FAIL CLOSED. Every path that cannot reach a confident verdict exits
 *      non-zero and names the check that could not be made. There is no
 *      deliberate allow-on-absence anywhere in this file: unlike a freeze
 *      boundary, an absent review has no benign reading.
 *   2. NO INTERPRETER BUT NODE. gstack's codex path needs python3 for the
 *      JSONL parser, mktemp for captures, and gtimeout/timeout for the hang
 *      wrapper. The JSONL parser here is 30 lines of JavaScript, the captures
 *      are fs.writeFileSync, and the timeout is setTimeout. The selftest runs
 *      every command with PATH pointed at an empty directory to prove it.
 *   3. PROVE IT. `selftest` runs this executable as a child process against
 *      deliberately broken inputs — an empty review, a truncated review, a
 *      review that is only the Store advert, a 0-byte auth.json, a codex that
 *      hangs, a codex that says nothing — and fails loudly if any of them is
 *      scored as a pass.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const NAME = path.basename(SELF);
const VERSION = "0.1.0";

// Exit codes. Distinct on purpose: a caller has to be able to tell "the
// reviewer said the change is bad" (1) from "there was no reviewer" (3/4/5)
// from "the reviewer's answer cannot be trusted" (2). gstack collapses all of
// these into prose and, on the paths that matter, into PASS.
const EXIT_OK = 0;
const EXIT_FINDINGS = 1; // gate: a [P1] exists
const EXIT_UNVERIFIED = 2; // gate: no trustworthy verdict is available
const EXIT_NOT_INSTALLED = 3;
const EXIT_NOT_AUTHENTICATED = 4;
const EXIT_UNUSABLE = 5; // installed, but it does not run
const EXIT_TIMEOUT = 6;
const EXIT_EMPTY = 7; // codex ran and produced nothing
const EXIT_CODEX_FAILED = 8; // codex exited non-zero

const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Git Bash reports C:\Users as /c/Users, and this skill's own bash blocks run
 * there on Windows, so an MSYS path is what a caller will actually pass. Node
 * on Windows would resolve /c/Users to C:\c\Users, which does not exist, and
 * the resulting "does not exist" is true and useless. Applied to every path
 * this tool accepts from a caller.
 */
function winPath(p) {
  if (!isWindows || typeof p !== "string") return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p.trim());
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// ------------------------------------------------------------ codex location
//
// gstack resolves the binary with `command -v codex`, which answers a question
// nobody asked: whether a NAME exists on PATH. On Windows npm installs three
// shims side by side (codex, codex.cmd, codex.ps1) and only two of them are
// runnable by a process that is not a shell; the extensionless one is a POSIX
// sh script that cmd.exe cannot execute. Resolution here walks PATH with
// PATHEXT and returns an argv, so the caller never has to guess how to run it.

/**
 * Windows-runnable form of a path a shell handed us.
 *
 * `command -v codex` in Git Bash answers `/c/Users/…/npm/codex` — the
 * EXTENSIONLESS sh shim, which cmd.exe cannot execute and which Node cannot
 * spawn. The runnable siblings are codex.cmd and codex.exe, so an
 * extension-free Windows path is resolved to one of those before it is called
 * missing. Returns null when nothing runnable is there.
 */
function runnableFile(file) {
  if (!isWindows) return fs.existsSync(file) ? file : null;
  const hasExt = path.extname(file) !== "";
  const candidates = hasExt ? [file] : [`${file}.exe`, `${file}.cmd`, `${file}.bat`, file];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

function resolveCodex(override) {
  // The test seam: a JSON array is an argv prefix, which is how the selftest
  // stands a plain .mjs file in for a compiled binary on every platform.
  if (override) {
    if (override.trim().startsWith("[")) {
      let argv;
      try {
        argv = JSON.parse(override);
      } catch (e) {
        return { ok: false, reason: `--codex-bin is not valid JSON (${e.message})` };
      }
      if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) {
        return { ok: false, reason: "--codex-bin JSON must be a non-empty array of strings" };
      }
      const head = runnableFile(winPath(argv[0]));
      if (!head) return { ok: false, reason: `${winPath(argv[0])} is not a runnable file` };
      return { ok: true, argv: [head, ...argv.slice(1)], source: "override" };
    }
    const file = runnableFile(winPath(override));
    if (!file) return { ok: false, reason: `${winPath(override)} is not a runnable file` };
    return { ok: true, argv: [file], source: "override" };
  }

  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = isWindows
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [""];
  // .exe and .cmd first: a .ps1 needs a PowerShell host and an extensionless
  // sh script needs a POSIX shell, and pretending either is directly runnable
  // is how "installed" turns into a spawn error three steps later.
  const ordered = isWindows ? [".exe", ".cmd", ".bat", ...exts] : [""];
  const seen = new Set();
  for (const dir of dirs) {
    for (const ext of ordered) {
      const p = path.join(dir, `codex${ext}`);
      if (seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (!isWindows) fs.accessSync(p, fs.constants.X_OK);
        return { ok: true, argv: [p], source: "PATH" };
      } catch {
        /* keep looking */
      }
    }
  }
  // A more useful "no" than gstack's. On Windows an npm install leaves an
  // extensionless sh shim next to codex.cmd; if only the shim is there, the
  // problem is a broken install, not a missing one, and saying "not found"
  // sends the user to reinstall something that is already present.
  if (isWindows) {
    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir, "codex"))) {
        return { ok: false, reason: `${path.join(dir, "codex")} exists but is the POSIX shim; no codex.exe or codex.cmd is next to it, so nothing here is runnable outside a shell` };
      }
    }
  }
  return { ok: false, reason: "no codex executable on PATH" };
}

/**
 * Spawn a resolved codex argv. On Windows a .cmd or .bat cannot be spawned
 * directly by Node 20+ (it refuses, for CVE-2024-27980), so it is handed to
 * cmd.exe explicitly rather than by setting shell:true — shell:true would also
 * re-expose the argument string to cmd's parser, which is the thing being
 * avoided.
 */
function codexSpawnArgs(argv, args) {
  const file = argv[0];
  const rest = [...argv.slice(1), ...args];
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...rest].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", line],
      opts: { windowsVerbatimArguments: true },
    };
  }
  return { file, args: rest, opts: {} };
}

// -------------------------------------------------------------------- auth
//
// The whole of gstack's check is `[ -f auth.json ]`. Everything below exists
// because a file can be there and be worthless.

const CRED_KEYS = ["OPENAI_API_KEY", "openai_api_key", "api_key", "access_token", "id_token", "refresh_token"];

function hasCredential(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (CRED_KEYS.includes(k) && typeof v === "string" && v.trim()) return true;
    if (v && typeof v === "object" && hasCredential(v, depth + 1)) return true;
  }
  return false;
}

function checkAuth(env = process.env) {
  const envKey = ["CODEX_API_KEY", "OPENAI_API_KEY"].find((k) => (env[k] || "").trim());
  if (envKey) return { ok: true, how: `$${envKey} is set` };

  const home = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
  const file = path.join(home, "auth.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      return { ok: false, how: `no $CODEX_API_KEY, no $OPENAI_API_KEY, and no ${file}` };
    }
    return { ok: false, how: `${file} could not be read (${e.code || e.message})` };
  }
  if (!raw.trim()) {
    // The reproduced gstack fail-open, in one line.
    return { ok: false, how: `${file} exists but is empty, so there is no credential in it` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, how: `${file} is not valid JSON (${e.message})` };
  }
  if (!hasCredential(obj)) {
    return { ok: false, how: `${file} parsed, but carries none of ${CRED_KEYS.join(", ")}` };
  }
  return { ok: true, how: `${file} carries a credential` };
}

// ---------------------------------------------------------------- preflight

const KNOWN_BAD = [/(^|[^0-9.])0\.120\.(0|1|2)([^0-9.]|$)/];

function preflight(opts) {
  const reasons = [];
  const resolved = resolveCodex(opts.codexBin);
  if (!resolved.ok) {
    return finishPreflight("NOT_INSTALLED", EXIT_NOT_INSTALLED, [
      resolved.reason,
      "Install it: npm install -g @openai/codex  (or see https://github.com/openai/codex)",
    ], opts);
  }
  reasons.push(`binary: ${resolved.argv.join(" ")} (${resolved.source})`);

  // Execute it. A name on PATH is not a working program: it can be a broken
  // shim, a wrapper that needs a runtime that is gone, or an alias stub of the
  // kind that makes `command -v python3` succeed on every Windows machine.
  const sp = codexSpawnArgs(resolved.argv, ["--version"]);
  const res = spawnSync(sp.file, sp.args, {
    encoding: "utf8",
    timeout: opts.versionTimeoutMs,
    killSignal: "SIGKILL",
    ...sp.opts,
  });
  if (res.error && res.error.code === "ETIMEDOUT") {
    return finishPreflight("UNUSABLE", EXIT_UNUSABLE, [
      ...reasons,
      `codex --version did not answer within ${opts.versionTimeoutMs}ms, so the binary is present but not usable`,
    ], opts);
  }
  if (res.error) {
    return finishPreflight("UNUSABLE", EXIT_UNUSABLE, [...reasons, `codex --version could not be spawned (${res.error.message})`], opts);
  }
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || "").trim().split(/\r?\n/)[0] || "no output";
    return finishPreflight("UNUSABLE", EXIT_UNUSABLE, [...reasons, `codex --version exited ${res.status}: ${tail}`], opts);
  }
  const version = (res.stdout || "").trim().split(/\r?\n/)[0] || "";
  if (!version) {
    return finishPreflight("UNUSABLE", EXIT_UNUSABLE, [...reasons, "codex --version exited 0 but printed nothing, so the version is unknown"], opts);
  }
  reasons.push(`version: ${version}`);

  const auth = checkAuth(opts.env);
  if (!auth.ok) {
    return finishPreflight("NOT_AUTHENTICATED", EXIT_NOT_AUTHENTICATED, [
      ...reasons,
      auth.how,
      "Run `codex login`, or set $CODEX_API_KEY / $OPENAI_API_KEY, then re-run preflight.",
    ], opts);
  }
  reasons.push(`auth: ${auth.how}`);

  // Non-blocking, and printed as WARN so a caller grepping for state is not
  // confused by it. The list is gstack's; the stdin deadlock it points at is real.
  const warnings = KNOWN_BAD.some((re) => re.test(version))
    ? [`WARN: Codex CLI ${version} has known stdin deadlock bugs. npm install -g @openai/codex@latest`]
    : [];
  return finishPreflight("READY", EXIT_OK, reasons, opts, warnings);
}

function finishPreflight(state, code, reasons, opts, warnings = []) {
  if (opts.json) {
    out(JSON.stringify({ state, exit: code, reasons, warnings }, null, 2));
  } else {
    out(`PREFLIGHT: ${state}`);
    for (const r of reasons) out(`  ${r}`);
    for (const w of warnings) out(`  ${w}`);
    if (code !== EXIT_OK) out(`  Nothing was sent to Codex, because a second opinion nobody gave is not a second opinion.`);
  }
  process.exitCode = code;
  return code;
}

// --------------------------------------------------------------------- gate
//
// The heart of the port. gstack: "no [P1] found -> PASS". Here a PASS has to be
// earned, and the third verdict exists so that "I could not tell" stops being
// spelled the same way as "all clear".

const NOISE = [
  /^\s*\[codex (exit|auth error)[^\]]*\]/i,
  /^\s*Codex stalled past/i,
  /^\s*\[codex warning\]/i,
  /^Python was not found/i,
  /^\s*ERROR: Python 3 is required/i,
  /^\s*tokens used:/i,
  /^\s*={5,}\s*$/,
  /^\s*-{5,}\s*$/,
];

const MIN_SUBSTANTIVE = 40;
const SENTINEL = /^\s*REVIEW_COMPLETE:\s*(\d+)\s*P1\s*,\s*(\d+)\s*P2\s*$/im;

function gate(file, opts) {
  const verdict = computeGate(file, opts);
  if (opts.json) {
    out(JSON.stringify(verdict, null, 2));
  } else {
    out("");
    out(`  GATE: ${verdict.verdict}`);
    out(`  ${verdict.why}`);
    out("");
    out(`  reviewed:  ${verdict.file ?? "(none)"}`);
    out(`  bytes:     ${verdict.bytes}`);
    out(`  sha256:    ${verdict.sha256 ?? "(none)"}`);
    out(`  markers:   ${verdict.p1} x [P1], ${verdict.p2} x [P2]`);
    out(`  sentinel:  ${verdict.sentinel ?? "absent"}`);
    out("");
    if (verdict.verdict === "UNVERIFIED") {
      out("  UNVERIFIED is not PASS. Nothing was reviewed that can be relied on, so");
      out("  this must not be reported as an outside voice having signed off.");
      out("");
    }
  }
  process.exitCode = verdict.exit;
  return verdict;
}

function computeGate(file, opts = {}) {
  const base = { file: file ?? null, bytes: 0, sha256: null, p1: 0, p2: 0, sentinel: null };
  const unverified = (why) => ({ ...base, verdict: "UNVERIFIED", exit: EXIT_UNVERIFIED, why });

  if (!file) return unverified("no capture file was given, so there is nothing to judge");
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return unverified(`${file} could not be read (${e.code || e.message}), so the review is missing, not clean`);
  }
  base.bytes = buf.length;
  base.sha256 = sha256(buf);
  const text = buf.toString("utf8");
  if (!text.trim()) {
    return { ...base, verdict: "UNVERIFIED", exit: EXIT_UNVERIFIED, why: "the capture is empty. Codex produced no output, which is not the same as no findings (this is the exact input gstack scores as PASS)" };
  }

  const substantive = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !NOISE.some((re) => re.test(l)))
    .join("\n");
  if (substantive.replace(/\s/g, "").length < MIN_SUBSTANTIVE) {
    return { ...base, verdict: "UNVERIFIED", exit: EXIT_UNVERIFIED, why: `the capture holds ${substantive.replace(/\s/g, "").length} characters of review once error noise is removed, which is not a review` };
  }

  base.p1 = (text.match(/\[P1\]/g) || []).length;
  base.p2 = (text.match(/\[P2\]/g) || []).length;
  const m = SENTINEL.exec(text);
  if (m) base.sentinel = `${m[1]} P1, ${m[2]} P2`;

  // A finding is a finding. Fail toward blocking even when the run was
  // truncated before its sentinel, and even when the sentinel disagrees.
  if (base.p1 > 0) {
    const contradicts = m && Number(m[1]) === 0;
    return {
      ...base,
      verdict: "FAIL",
      exit: EXIT_FINDINGS,
      why: contradicts
        ? `${base.p1} x [P1] present although the sentinel claims 0 P1. A disagreeing report is judged on the findings, not on its own summary`
        : `${base.p1} critical finding${base.p1 === 1 ? "" : "s"} marked [P1]`,
    };
  }
  if (m && Number(m[1]) > 0) {
    return { ...base, verdict: "FAIL", exit: EXIT_FINDINGS, why: `the sentinel reports ${m[1]} P1 findings even though no [P1] marker survived in the capture, so the capture is incomplete and cannot clear the change` };
  }

  if (!m) {
    // Both of the ways to get here are the same bug in gstack, one of them
    // silent: a truncated stream drops the findings that came after the cut,
    // and a prose review never had markers to drop.
    if (base.p2 > 0) {
      return { ...base, verdict: "UNVERIFIED", exit: EXIT_UNVERIFIED, why: `${base.p2} x [P2] present but no REVIEW_COMPLETE line, so the stream may have been cut before a later [P1] was written` };
    }
    return { ...base, verdict: "UNVERIFIED", exit: EXIT_UNVERIFIED, why: "the reviewer answered in prose and never used the marker contract, so the absence of [P1] says nothing about whether critical findings exist" };
  }

  return { ...base, verdict: "PASS", exit: EXIT_OK, why: `the review ran to completion and reported 0 P1${base.p2 ? ` (${base.p2} advisory)` : ""}` };
}

// ---------------------------------------------------------------------- run
//
// Replaces: mktemp for the captures, gtimeout/timeout for the hang wrapper,
// python3 for the JSONL parser, `< /dev/null` for the stdin deadlock, and
// ${PIPESTATUS[0]} for the exit status. None of those five exist reliably on
// Windows, and four of them fail silently when they are missing.

function parseEvent(line, sink) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  const t = obj.type || "";
  if (t === "thread.started" && obj.thread_id) sink.threadId = obj.thread_id;
  else if (t === "item.completed" && obj.item) {
    const item = obj.item;
    const text = item.text || "";
    if (item.type === "reasoning" && text) sink.write(`[codex thinking] ${text}\n`);
    else if (item.type === "agent_message" && text) sink.write(`${text}\n`);
    else if (item.type === "command_execution" && item.command) sink.write(`[codex ran] ${item.command}\n`);
  } else if (t === "turn.completed") {
    sink.turns += 1;
    const u = obj.usage || {};
    const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
    if (tokens) sink.tokens = tokens;
  }
}

// gstack greps stderr for /auth|login|unauthorized/i, which matches any review
// of a file called login.ts. These are the strings an auth failure actually
// produces.
const AUTH_ERR = /\b(401|403 forbidden|unauthorized|not logged in|invalid api key|authentication failed|please run `?codex login|token (has )?expired)\b/i;

async function run(opts) {
  const resolved = resolveCodex(opts.codexBin);
  if (!resolved.ok) {
    err(`RUN: NOT_INSTALLED — ${resolved.reason}`);
    process.exitCode = EXIT_NOT_INSTALLED;
    return;
  }
  let prompt = opts.prompt;
  if (opts.promptFile) {
    try {
      prompt = fs.readFileSync(opts.promptFile, "utf8");
    } catch (e) {
      err(`RUN: the prompt file ${opts.promptFile} could not be read (${e.code || e.message})`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
  }
  if (!prompt || !prompt.trim()) {
    err("RUN: refusing to invoke Codex with an empty prompt");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const outDir = opts.outDir || path.join(stateDir(), "codex-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "codex-output.txt");
  const rawFile = path.join(outDir, "codex-stdout.jsonl");
  const errFile = path.join(outDir, "codex-stderr.txt");

  const args = [...opts.codexArgs, prompt];
  const sp = codexSpawnArgs(resolved.argv, args);
  const started = Date.now();

  let human = "";
  const sink = {
    turns: 0,
    tokens: 0,
    threadId: null,
    write: (s) => {
      human += s;
      if (!opts.quiet) process.stdout.write(s);
    },
  };

  const child = spawn(sp.file, sp.args, {
    // stdin is closed rather than inherited. gstack writes `< /dev/null` for
    // the same reason; there is no /dev/null to redirect from on Windows when
    // the caller is not a POSIX shell.
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    ...sp.opts,
  });

  let rawOut = "";
  let rawErr = "";
  let pending = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
  }, opts.timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rawOut += chunk;
    if (!opts.jsonl) {
      sink.write(chunk);
      return;
    }
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) parseEvent(line, sink);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    rawErr += chunk;
  });

  const code = await new Promise((resolve) => {
    child.on("error", (e) => resolve({ spawnError: e }));
    child.on("close", (c) => resolve({ status: c }));
  });
  clearTimeout(timer);
  if (opts.jsonl && pending.trim()) parseEvent(pending, sink);

  fs.writeFileSync(outFile, human, "utf8");
  fs.writeFileSync(rawFile, rawOut, "utf8");
  fs.writeFileSync(errFile, rawErr, "utf8");

  const decide = () => {
    if (code.spawnError) return [EXIT_UNUSABLE, `codex could not be spawned (${code.spawnError.message})`];
    if (timedOut) return [EXIT_TIMEOUT, `codex was killed after ${Math.round(opts.timeoutMs / 1000)}s without finishing`];
    if (AUTH_ERR.test(rawErr)) return [EXIT_NOT_AUTHENTICATED, `codex reported an authentication failure: ${firstLine(rawErr)}`];
    if (code.status !== 0) return [EXIT_CODEX_FAILED, `codex exited ${code.status}: ${firstLine(rawErr) || "no stderr captured"}`];
    if (human.replace(/\s/g, "").length < MIN_SUBSTANTIVE) {
      return [EXIT_EMPTY, "codex exited 0 but produced no usable output. This is the state gstack's pipeline reaches on Windows and scores as a passing review"];
    }
    if (opts.jsonl && sink.turns === 0) {
      return [EXIT_EMPTY, "no turn.completed event arrived, so the stream ended mid-answer and the capture is incomplete"];
    }
    return [EXIT_OK, "codex answered"];
  };
  const [exit, why] = decide();

  const evidence = {
    tool: `${NAME} ${VERSION}`,
    mode: opts.mode,
    exit,
    why,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    codex: resolved.argv,
    threadId: sink.threadId,
    tokens: sink.tokens || null,
    outputBytes: Buffer.byteLength(human),
    outputSha256: sha256(Buffer.from(human)),
    stderrBytes: Buffer.byteLength(rawErr),
    files: { output: outFile, raw: rawFile, stderr: errFile },
  };
  fs.writeFileSync(path.join(outDir, "codex-run.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  out("");
  out(`  RUN: ${exit === EXIT_OK ? "OK" : "PROBLEM"} — ${why}`);
  out(`  output:   ${outFile}  (${evidence.outputBytes} bytes, sha256 ${evidence.outputSha256.slice(0, 16)}…)`);
  out(`  evidence: ${path.join(outDir, "codex-run.json")}`);
  if (sink.threadId) out(`  thread:   ${sink.threadId}`);
  if (rawErr.trim() && exit !== EXIT_OK) out(`  stderr:   ${firstLine(rawErr)}`);
  out("");
  process.exitCode = exit;
}

const firstLine = (s) => (s || "").trim().split(/\r?\n/)[0] || "";

// ------------------------------------------------------------------- doctor

function doctor() {
  out(`\n  tb-codex doctor  (node ${process.version}, ${process.platform})\n`);
  const resolved = resolveCodex(null);
  out(`  codex        ${resolved.ok ? resolved.argv.join(" ") : `NOT FOUND — ${resolved.reason}`}`);
  if (resolved.ok) {
    const sp = codexSpawnArgs(resolved.argv, ["--version"]);
    const r = spawnSync(sp.file, sp.args, { encoding: "utf8", timeout: 10000, ...sp.opts });
    out(`  version      ${r.status === 0 ? firstLine(r.stdout) : `did not run (status ${r.status})`}`);
  }
  const auth = checkAuth();
  out(`  auth         ${auth.ok ? "OK" : "NOT USABLE"} — ${auth.how}`);

  out(`\n  The POSIX tools gstack's /codex depends on, on this machine:\n`);
  for (const [tool, args] of [["python3", ["--version"]], ["python", ["--version"]], ["timeout", ["--version"]], ["gtimeout", ["--version"]], ["mktemp", ["--version"]]]) {
    const r = spawnSync(tool, args, { encoding: "utf8", timeout: 8000, shell: false });
    if (r.error) out(`  ${tool.padEnd(12)} absent (${r.error.code})`);
    else if (r.status !== 0) out(`  ${tool.padEnd(12)} ON PATH BUT BROKEN — exit ${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout)}`);
    else out(`  ${tool.padEnd(12)} ${firstLine(r.stdout)}`);
  }
  out(`\n  A tool listed "ON PATH BUT BROKEN" is the dangerous case: gstack tests it`);
  out(`  with \`command -v\`, which succeeds, and then pipes Codex's entire answer`);
  out(`  into it. This engine spawns none of them.\n`);
}

// ----------------------------------------------------------------- selftest

function runSelf(args, env = {}, input) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

const FAKE_CODEX = {
  // Emits exactly the JSONL shape gstack's python parser consumes, including a
  // [P1]. On Windows gstack loses all of it; this engine must not.
  findings: `
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "th_selftest" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "reading the diff" } }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "git diff main...HEAD" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "[P1] SQL injection in users_controller.rb:42 lets any caller read the sessions table.\\nREVIEW_COMPLETE: 1 P1, 0 P2" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 300 } }),
];
for (const l of lines) process.stdout.write(l + "\\n");
`,
  silent: `process.exit(0);`,
  failing: `process.stderr.write("codex: unexpected argument '--base'\\n"); process.exit(2);`,
  unauthed: `process.stderr.write("stream error: 401 Unauthorized\\n"); process.exit(1);`,
  hang: `setTimeout(() => process.exit(0), 30000);`,
  version: `process.stdout.write("codex-cli 0.140.0\\n");`,
  versionBad: `process.stdout.write("codex-cli 0.120.1\\n");`,
  versionBroken: `process.stderr.write("cannot open shared object file\\n"); process.exit(127);`,
  versionHang: `setTimeout(() => process.stdout.write("codex-cli 1.0.0\\n"), 20000);`,
};

function writeFake(dir, name, body) {
  const p = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(p, body, "utf8");
  return JSON.stringify([process.execPath, p]);
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-codex-selftest-"));
  const F = (name) => writeFake(tmp, name, FAKE_CODEX[name]);
  const cap = (name, body) => {
    const p = path.join(tmp, `${name}.txt`);
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  // An empty directory used as PATH. Every command below has to keep working
  // with no python, no timeout, no mktemp, no shell — which is the whole claim.
  const emptyPath = path.join(tmp, "empty-path");
  fs.mkdirSync(emptyPath, { recursive: true });

  const authOk = path.join(tmp, "auth-ok");
  const authEmpty = path.join(tmp, "auth-empty");
  const authBadJson = path.join(tmp, "auth-badjson");
  const authNoCred = path.join(tmp, "auth-nocred");
  const authMissing = path.join(tmp, "auth-missing");
  for (const d of [authOk, authEmpty, authBadJson, authNoCred]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(authOk, "auth.json"), JSON.stringify({ tokens: { access_token: "sk-real-looking" } }), "utf8");
  fs.writeFileSync(path.join(authEmpty, "auth.json"), "", "utf8");
  fs.writeFileSync(path.join(authBadJson, "auth.json"), "{ not json", "utf8");
  fs.writeFileSync(path.join(authNoCred, "auth.json"), JSON.stringify({ last_refresh: "2026-01-01" }), "utf8");

  // Auth env has to be cleared for every case, or a real key on the developer's
  // machine would make the negative auth cases pass for the wrong reason.
  const noAuth = { CODEX_API_KEY: "", OPENAI_API_KEY: "", CODEX_HOME: authMissing };

  const runDir = path.join(tmp, "runs");

  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  // ---- gate: the states gstack scores as PASS ----------------------------
  add("gate: an empty capture is UNVERIFIED, not PASS (gstack: PASS)", () => {
    const r = runSelf(["gate", cap("empty", "")], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}, wanted ${EXIT_UNVERIFIED}`];
  });
  add("gate: whitespace-only capture is UNVERIFIED", () => {
    const r = runSelf(["gate", cap("ws", "\n\n   \r\n\t\n")], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });
  add("gate: a missing capture file is UNVERIFIED", () => {
    const r = runSelf(["gate", path.join(tmp, "does-not-exist.txt")], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });
  add("gate: no argument at all is UNVERIFIED", () => {
    const r = runSelf(["gate"], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });
  add("gate: a capture holding only the Python stub advert is UNVERIFIED", () => {
    const r = runSelf(["gate", cap("advert", "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps.\n")], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });
  add("gate: a capture holding only codex error noise is UNVERIFIED", () => {
    const body = "[codex exit 2] codex: unexpected argument '--base'\n============================================================\ntokens used: 0\n";
    const r = runSelf(["gate", cap("noise", body)], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });
  add("gate: prose with no marker contract is UNVERIFIED (gstack: PASS)", () => {
    const body = "Looks good overall. The refactor is clean, the naming is consistent, and I did not see anything that worried me in the diff.\n";
    const r = runSelf(["gate", cap("prose", body)], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED && /never used the marker contract/.test(r.stdout), `exit ${r.status}: ${firstLine(r.stdout)}`];
  });
  add("gate: [P2] findings with no REVIEW_COMPLETE line are UNVERIFIED (possible truncation)", () => {
    const body = "[P2] the retry loop has no jitter, which will synchronise clients after an outage.\n[P2] the log line at cache.ts:88 prints the whole request body.\n";
    const r = runSelf(["gate", cap("p2only", body)], { PATH: emptyPath });
    return [r.status === EXIT_UNVERIFIED, `exit ${r.status}`];
  });

  // ---- gate: the states that must NOT be softened -------------------------
  add("gate: a [P1] finding is FAIL", () => {
    const body = "[P1] SQL injection in users_controller.rb:42 lets any caller read the sessions table.\nREVIEW_COMPLETE: 1 P1, 0 P2\n";
    const r = runSelf(["gate", cap("p1", body)], { PATH: emptyPath });
    return [r.status === EXIT_FINDINGS, `exit ${r.status}`];
  });
  add("gate: a [P1] with no sentinel is still FAIL", () => {
    const body = "[P1] the token comparison at auth.ts:31 is not constant time, so the session token leaks byte by byte.\n";
    const r = runSelf(["gate", cap("p1nosent", body)], { PATH: emptyPath });
    return [r.status === EXIT_FINDINGS, `exit ${r.status}`];
  });
  add("gate: a sentinel claiming 0 P1 cannot overrule a [P1] in the body", () => {
    const body = "[P1] the migration drops the column before the backfill runs, so rows written in that window are lost.\nREVIEW_COMPLETE: 0 P1, 0 P2\n";
    const r = runSelf(["gate", cap("contradiction", body)], { PATH: emptyPath });
    return [r.status === EXIT_FINDINGS && /judged on the findings/.test(r.stdout), `exit ${r.status}`];
  });
  add("gate: a sentinel claiming P1 with no marker left in the capture is FAIL", () => {
    const body = "The diff is mostly the storage rewrite; I read every hunk and traced the write path end to end.\nREVIEW_COMPLETE: 2 P1, 1 P2\n";
    const r = runSelf(["gate", cap("sentinelonly", body)], { PATH: emptyPath });
    return [r.status === EXIT_FINDINGS, `exit ${r.status}`];
  });

  // ---- gate: a PASS has to remain reachable ------------------------------
  add("gate: a completed review with 0 P1 is PASS", () => {
    const body = "[P2] the helper at util.ts:12 is only used once and could be inlined, which would make the retry path easier to read.\nREVIEW_COMPLETE: 0 P1, 1 P2\n";
    const r = runSelf(["gate", cap("pass", body)], { PATH: emptyPath });
    return [r.status === EXIT_OK, `exit ${r.status}`];
  });
  add("gate: a completed review with no findings at all is PASS", () => {
    const body = "I read the whole diff against main, traced the two new branches in the scheduler, and found nothing worth raising.\nREVIEW_COMPLETE: 0 P1, 0 P2\n";
    const r = runSelf(["gate", cap("clean", body)], { PATH: emptyPath });
    return [r.status === EXIT_OK, `exit ${r.status}`];
  });

  // ---- preflight ---------------------------------------------------------
  add("preflight: no codex on PATH exits NOT_INSTALLED", () => {
    const r = runSelf(["preflight"], { ...noAuth, PATH: emptyPath });
    return [r.status === EXIT_NOT_INSTALLED && /NOT_INSTALLED/.test(r.stdout), `exit ${r.status}`];
  });
  add("preflight: a codex that cannot run exits UNUSABLE, not READY", () => {
    const r = runSelf(["preflight", "--codex-bin", F("versionBroken")], { ...noAuth, CODEX_HOME: authOk, PATH: emptyPath });
    return [r.status === EXIT_UNUSABLE, `exit ${r.status}`];
  });
  add("preflight: a codex that hangs on --version exits UNUSABLE", () => {
    const r = runSelf(["preflight", "--codex-bin", F("versionHang"), "--version-timeout-ms", "1500"], { ...noAuth, CODEX_HOME: authOk, PATH: emptyPath });
    return [r.status === EXIT_UNUSABLE, `exit ${r.status}`];
  });
  add("preflight: a 0-byte auth.json is NOT_AUTHENTICATED (gstack: AUTH_OK)", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, CODEX_HOME: authEmpty, PATH: emptyPath });
    return [r.status === EXIT_NOT_AUTHENTICATED && /is empty/.test(r.stdout), `exit ${r.status}: ${firstLine(r.stdout)}`];
  });
  add("preflight: an unparseable auth.json is NOT_AUTHENTICATED (gstack: AUTH_OK)", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, CODEX_HOME: authBadJson, PATH: emptyPath });
    return [r.status === EXIT_NOT_AUTHENTICATED, `exit ${r.status}`];
  });
  add("preflight: an auth.json with no credential in it is NOT_AUTHENTICATED (gstack: AUTH_OK)", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, CODEX_HOME: authNoCred, PATH: emptyPath });
    return [r.status === EXIT_NOT_AUTHENTICATED, `exit ${r.status}`];
  });
  add("preflight: a whitespace-only API key is not a key", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, CODEX_API_KEY: "   ", CODEX_HOME: authMissing, PATH: emptyPath });
    return [r.status === EXIT_NOT_AUTHENTICATED, `exit ${r.status}`];
  });
  add("preflight: a real auth.json and a working binary is READY", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, CODEX_HOME: authOk, PATH: emptyPath });
    return [r.status === EXIT_OK && /PREFLIGHT: READY/.test(r.stdout), `exit ${r.status}: ${firstLine(r.stdout)}`];
  });
  add("preflight: an env key alone is READY", () => {
    const r = runSelf(["preflight", "--codex-bin", F("version")], { ...noAuth, OPENAI_API_KEY: "sk-test", CODEX_HOME: authMissing, PATH: emptyPath });
    return [r.status === EXIT_OK, `exit ${r.status}`];
  });
  add("preflight: a known-bad CLI version is READY but warns", () => {
    const r = runSelf(["preflight", "--codex-bin", F("versionBad")], { ...noAuth, CODEX_HOME: authOk, PATH: emptyPath });
    return [r.status === EXIT_OK && /WARN: Codex CLI/.test(r.stdout), `exit ${r.status}: ${r.stdout.trim().split(/\r?\n/).pop()}`];
  });

  add("preflight: a Git Bash /c/ path with no file extension still resolves", () => {
    // The skill's own bash blocks run in Git Bash on Windows, so an MSYS path
    // is what a caller actually passes. Node would resolve /c/Users to
    // C:\c\Users and report a true, useless "does not exist".
    const argv = JSON.parse(F("version"));
    // Only argv[0] — the executable — is a path the shell hands over. The rest
    // are arguments to codex and must be passed through untouched.
    const msys = isWindows
      ? [argv[0].replace(/\\/g, "/").replace(/^([a-zA-Z]):\//, (_, d) => `/${d.toLowerCase()}/`), ...argv.slice(1)]
      : argv;
    const r = runSelf(["preflight", "--codex-bin", JSON.stringify(msys)], { ...noAuth, CODEX_HOME: authOk, PATH: emptyPath });
    return [r.status === EXIT_OK, `exit ${r.status} for ${msys[0]}`];
  });

  // ---- run ---------------------------------------------------------------
  add("run: JSONL is parsed without python, and the [P1] survives", () => {
    const dir = path.join(runDir, "findings");
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("findings"), "--jsonl", "--prompt", "review the diff", "--out", dir], { PATH: emptyPath });
    const file = path.join(dir, "codex-output.txt");
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return [r.status === EXIT_OK && /\[P1\] SQL injection/.test(body) && /\[codex thinking\]/.test(body), `exit ${r.status}, ${body.length} bytes captured`];
  });
  add("run: that capture then FAILs the gate end to end", () => {
    const file = path.join(runDir, "findings", "codex-output.txt");
    const r = runSelf(["gate", file], { PATH: emptyPath });
    return [r.status === EXIT_FINDINGS, `exit ${r.status}`];
  });
  add("run: a codex that says nothing exits EMPTY, never 0", () => {
    const dir = path.join(runDir, "silent");
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("silent"), "--jsonl", "--prompt", "review", "--out", dir], { PATH: emptyPath });
    return [r.status === EXIT_EMPTY, `exit ${r.status}`];
  });
  add("run: a non-zero codex surfaces its stderr and exits CODEX_FAILED", () => {
    const dir = path.join(runDir, "failing");
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("failing"), "--prompt", "review", "--out", dir], { PATH: emptyPath });
    return [r.status === EXIT_CODEX_FAILED && /unexpected argument/.test(r.stdout + r.stderr), `exit ${r.status}`];
  });
  add("run: a 401 on stderr exits NOT_AUTHENTICATED", () => {
    const dir = path.join(runDir, "unauthed");
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("unauthed"), "--prompt", "review", "--out", dir], { PATH: emptyPath });
    return [r.status === EXIT_NOT_AUTHENTICATED, `exit ${r.status}`];
  });
  add("run: a hung codex is killed and exits TIMEOUT", () => {
    const dir = path.join(runDir, "hang");
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("hang"), "--prompt", "review", "--timeout-s", "2", "--out", dir], { PATH: emptyPath });
    return [r.status === EXIT_TIMEOUT, `exit ${r.status}`];
  });
  add("run: an empty prompt is refused before codex is invoked", () => {
    const r = runSelf(["run", "--mode", "review", "--codex-bin", F("findings"), "--prompt", "   ", "--out", path.join(runDir, "noprompt")], { PATH: emptyPath });
    return [r.status === EXIT_UNUSABLE, `exit ${r.status}`];
  });
  add("run: every run writes machine-readable evidence next to the capture", () => {
    const p = path.join(runDir, "findings", "codex-run.json");
    if (!fs.existsSync(p)) return [false, "codex-run.json was not written"];
    const ev = JSON.parse(fs.readFileSync(p, "utf8"));
    const okSha = ev.outputSha256 === sha256(fs.readFileSync(path.join(runDir, "findings", "codex-output.txt")));
    return [okSha && ev.exit === 0 && ev.threadId === "th_selftest", `sha match ${okSha}, thread ${ev.threadId}`];
  });

  // ---- portability -------------------------------------------------------
  add("portability: every command above ran with PATH set to an empty directory", () => {
    const entries = fs.readdirSync(emptyPath);
    return [entries.length === 0, `${entries.length} entries in the PATH used by this run`];
  });

  const results = [];
  for (const c of cases) {
    let pass = false;
    let detail = "";
    try {
      [pass, detail] = c.fn();
    } catch (e) {
      pass = false;
      detail = `threw: ${e.message}`;
    }
    results.push({ name: c.name, pass, detail });
  }

  // The same guard the tb-guard selftest carries: a run that quietly asserts
  // fewer things than it should must not be able to print the banner.
  const EXPECTED = cases.length + 1;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    pass: results.length + 1 === EXPECTED,
    detail: `${results.length + 1} of ${EXPECTED}`,
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows can hold a handle briefly; the temp dir is not the assertion */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-codex selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write(`\n  The gate is NOT trustworthy in this state. Failures:\n`);
    for (const r of failed) process.stdout.write(`    - ${r.name}: ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken review above came back UNVERIFIED rather than PASS,\n");
  process.stdout.write("  every unusable Codex came back with a reason instead of an empty capture, and\n");
  process.stdout.write("  all of it ran with no python, no timeout, no mktemp and no shell on PATH.\n\n");
}

// -------------------------------------------------------------------- entry

function help() {
  out(`
  tb-codex ${VERSION} — the Toolbay Stack outside-voice engine

  Before anything is sent:
    preflight [--json]          can Codex run and authenticate here
                                exit 0 READY, 3 NOT INSTALLED, 4 NOT AUTHENTICATED,
                                5 INSTALLED BUT UNUSABLE

  Invoking it:
    run --mode <review|challenge|consult> (--prompt <s> | --prompt-file <f>)
        [--jsonl] [--timeout-s N] [--out <dir>] [--codex-arg <arg>]...
                                streams Codex, captures the answer, writes
                                codex-run.json evidence beside it
                                exit 0 ok, 4 auth, 6 timeout, 7 empty, 8 failed

  Judging it:
    gate <capture> [--json]     exit 0 PASS, 1 FAIL ([P1] present),
                                2 UNVERIFIED (no review to judge)

  Proof:
    selftest                    run every command against deliberately broken
                                input, including the inputs gstack scores PASS
    doctor                      what this machine has, including the POSIX tools
                                gstack's /codex assumes

  UNVERIFIED is a verdict, not an error. An outside voice that did not speak
  must never be reported as an outside voice that approved.
`);
}

function parseArgs(argv) {
  const o = {
    codexBin: null,
    codexArgs: [],
    prompt: null,
    promptFile: null,
    outDir: null,
    mode: "review",
    timeoutMs: 600000,
    versionTimeoutMs: 15000,
    jsonl: false,
    json: false,
    quiet: false,
    positional: [],
    env: process.env,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--codex-bin") o.codexBin = next();
    else if (a === "--prompt") o.prompt = next();
    else if (a === "--prompt-file") o.promptFile = winPath(next());
    else if (a === "--out") o.outDir = winPath(next());
    else if (a === "--mode") o.mode = next();
    else if (a === "--arg" || a === "--codex-arg") o.codexArgs.push(next());
    else if (a === "--timeout-s") o.timeoutMs = Math.max(1, Number(next()) || 600) * 1000;
    else if (a === "--version-timeout-ms") o.versionTimeoutMs = Math.max(100, Number(next()) || 15000);
    else if (a === "--jsonl") o.jsonl = true;
    else if (a === "--json") o.json = true;
    else if (a === "--quiet") o.quiet = true;
    else o.positional.push(winPath(a));
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === "preflight") return void preflight(opts);
  if (cmd === "gate") return void gate(opts.positional[0], opts);
  if (cmd === "run") return void (await run(opts));
  if (cmd === "selftest") return void selftest();
  if (cmd === "doctor") return void doctor();
  help();
}

// A crash must never read as a clean review. Anything unhandled exits
// UNVERIFIED, which is the same thing every other unknown state here does.
function crash(e) {
  err(`${NAME}: ${e?.stack ?? e}`);
  process.exit(EXIT_UNVERIFIED);
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

main().catch(crash);
