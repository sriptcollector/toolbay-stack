#!/usr/bin/env node
/**
 * tb-guard.mjs: the Toolbay Stack safety engine. One file, two guards:
 * `careful` (destructive Bash commands) and `freeze` (edit boundary).
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command names
 * /careful, /freeze, /guard, /unfreeze, the destructive-pattern list, the
 * safe-exception list, the freeze-boundary semantics, and the PreToolUse hook
 * shape) comes from gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY IT WAS REWRITTEN RATHER THAN FORKED LINE FOR LINE
 *
 * gstack implements both guards as POSIX shell that extracts fields from the
 * hook JSON with `grep -o '"command"...:.*"[^"]*"'` and falls back to
 * `python3 -c 'json.loads(...)'` when that returns nothing. Both halves fail
 * on Windows, and they fail in the one direction a safety feature must never
 * fail: open.
 *
 * Reproduced on Windows 11 with gstack 1.60.1.0 installed, 2026-08-13:
 *
 *   $ printf '{"tool_input":{"command":"echo \\"starting\\" && rm -rf /var/data"}}' \
 *       | bash ~/.claude/skills/gstack/careful/bin/check-careful.sh
 *   {}
 *
 * `{}` means allow. The `[^"]*` character class stops at the first escaped
 * quote, so the guard only ever sees `echo \` and the recursive delete after it
 * is invisible. The python3 fallback does not save it, because on Windows
 * `python3` is usually the Microsoft Store alias stub, which prints an advert
 * to stderr, exits 49, and writes nothing to stdout. `|| true` swallows that,
 * the variable stays empty, and line 21 runs `echo '{}'`.
 *
 * So the design rules here are:
 *
 *   1. FAIL CLOSED. Every path that cannot reach a confident "this is safe"
 *      ends in a block, with a message that says which check failed and why.
 *      There is exactly one deliberate allow-on-absence, documented at
 *      readFreezeState(): no state file at all means the user never ran
 *      /freeze, and blocking every edit in that case would be a bug, not
 *      caution.
 *   2. NO INTERPRETER BUT NODE. Node is already required by Claude Code, so
 *      this adds no dependency and there is no shell, python, or coreutils to
 *      be absent. JSON is parsed by JSON.parse, so the escaped-quote bypass
 *      cannot exist.
 *   3. PROVE IT. `selftest` runs the real executable as a child process with
 *      real hook payloads, including deliberately broken ones, and fails loudly
 *      if any of them are allowed. The whole point of this rewrite is that the
 *      gstack version looked active and was not.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.2.0";

// --------------------------------------------------------------- hook output
//
// Claude Code has changed the PreToolUse output shape over time: there is the
// current `hookSpecificOutput` envelope, the flat `permissionDecision` form
// gstack emits, and an older `decision`/`reason` pair. Emitting the union is
// free and means the guard does not quietly stop working after an upgrade,
// which is the same class of failure this file exists to remove.
//
// `allow` is deliberately expressed as `{}` (say nothing) rather than an
// explicit allow. An explicit allow OVERRIDES the user's own permission rules,
// so a guard that emitted it would be widening permissions in the name of
// safety. Silence lets the normal rules decide.

function emit(decision) {
  if (decision.action === "allow") {
    process.stdout.write("{}\n");
    return;
  }
  const reason = decision.message;
  const payload = {
    permissionDecision: decision.action,
    message: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.action,
      permissionDecisionReason: reason,
    },
  };
  if (decision.action === "deny") {
    payload.decision = "block";
    payload.reason = reason;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const allow = (why) => ({ action: "allow", why });
const ask = (message, why) => ({ action: "ask", message, why });
const deny = (message, why) => ({ action: "deny", message, why });

/**
 * The block used when the guard itself is broken.
 *
 * `careful` has no deny in its vocabulary by design (its whole contract is
 * "warn, and let the human override"), so its fail-closed state is `ask`: the
 * command stops and a human has to approve it. `freeze` blocks outright,
 * because that is what it does when it is working too.
 *
 * Set TOOLBAY_GUARD_STRICT=1 to upgrade careful's internal failures to deny as
 * well, for an unattended agent where there is nobody to answer an ask.
 */
function guardFailure(mode, detail) {
  const strict = process.env.TOOLBAY_GUARD_STRICT === "1";
  const msg =
    `[${mode}] Guard could not verify this operation, so it is blocked: ${detail}. ` +
    `This guard fails closed on purpose. Run "node ${path.basename(SELF)} selftest" to see what is wrong.`;
  if (mode === "careful" && !strict) return ask(msg, "guard-failure");
  return deny(msg, "guard-failure");
}

// ----------------------------------------------------------------- stdin read
//
// A hook is fed its payload on stdin. If stdin never arrives the guard must not
// hang the agent forever and must not give up and allow, so it bounds the wait
// and treats the timeout as a guard failure.

function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "no input on stdin within 5s" }), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      // A hook payload is one small JSON object. A gigantic stdin means
      // something is very wrong upstream; do not buffer it into an OOM.
      if (data.length > 8 * 1024 * 1024) finish({ ok: false, error: "input larger than 8MB" });
    });
    process.stdin.on("end", () => finish({ ok: true, data }));
    process.stdin.on("error", (err) => finish({ ok: false, error: `stdin error: ${err.message}` }));
  });
}

function parseHookInput(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: "no payload" };
  const text = String(raw).trim();
  if (!text) return { ok: false, error: "empty payload" };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `payload is not valid JSON (${err.message})` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "payload is not a JSON object" };
  }
  if (obj.tool_input !== undefined && (typeof obj.tool_input !== "object" || obj.tool_input === null)) {
    return { ok: false, error: "tool_input is present but is not an object" };
  }
  return { ok: true, value: obj };
}

// ------------------------------------------------------------- path handling
//
// Everything Windows-specific about this guard lives here. gstack's freeze hook
// tests `case "$FILE_PATH" in /*)` to decide whether a path is absolute, so
// `C:\Users\orion\proj\src\a.txt` is treated as RELATIVE and gets the current
// directory glued to the front. Reproduced on this machine: an edit INSIDE the
// boundary was denied, with the boundary printed as
// `/c/Users/orion/OneDrive/.../C:\Users\orion\proj\src/a.txt`. That is not a
// safe failure either, it just makes the feature unusable, and a user whose
// every edit is blocked runs /unfreeze and ends up with no protection at all.

const isWindows = process.platform === "win32";

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  const joined = looksAbsolute(s) ? s : path.join(cwd, s);
  return path.resolve(joined);
}

/**
 * Resolve symlinks and junctions as far as the path actually exists, then glue
 * the not-yet-existing tail back on. A plain realpath would throw for a Write
 * to a new file, and throwing here would block every legitimate file creation.
 */
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

const normCase = (p) => (isWindows ? p.toLowerCase() : p);

/** True when `target` is the boundary itself or lives underneath it. */
function isInside(boundary, target) {
  const b = normCase(path.resolve(boundary)).replace(/[\\/]+$/, "");
  const t = normCase(path.resolve(target));
  if (t === b) return true;
  // The separator is what stops /src from matching /src-old.
  return t.startsWith(b + path.sep) || t.startsWith(`${b}/`);
}

// ------------------------------------------------------------- freeze state

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function freezeFile() {
  return path.join(stateDir(), "freeze.json");
}

/**
 * @returns {{configured:false} | {configured:true, dir:string, setAt?:string} | {error:string}}
 *
 * THE ONE DELIBERATE ALLOW. `configured:false` (the state file does not exist)
 * means the user never set a boundary, and the correct behaviour is to allow.
 * Every other outcome, including a file that exists but cannot be read, parsed,
 * or resolved to a real directory, is an error and therefore a block. gstack
 * treats an empty or unparseable state file as "allow everything"; that is the
 * same class of bug as the python3 fallback.
 */
function readFreezeState() {
  const file = freezeFile();
  let raw;
  try {
    if (!fs.existsSync(file)) return { configured: false };
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { error: `freeze state at ${file} exists but could not be read (${err.code || err.message})` };
  }
  const text = raw.trim();
  if (!text) return { error: `freeze state at ${file} is empty, so the boundary is unknown` };

  let dir = null;
  let setAt;
  if (text.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      return { error: `freeze state at ${file} is not valid JSON (${err.message})` };
    }
    dir = typeof obj.dir === "string" ? obj.dir : null;
    setAt = typeof obj.setAt === "string" ? obj.setAt : undefined;
    if (!dir) return { error: `freeze state at ${file} has no "dir" field` };
  } else {
    // Accepts a bare path on one line, which is how gstack's freeze-dir.txt is
    // written, so someone migrating does not silently lose their boundary.
    dir = text.split(/\r?\n/)[0].trim();
    if (!dir) return { error: `freeze state at ${file} has no readable path` };
  }

  const abs = toAbsolute(dir);
  if (!abs) return { error: `freeze boundary "${dir}" could not be resolved to an absolute path` };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { error: `freeze boundary ${abs} does not exist on disk, so containment cannot be checked` };
  }
  if (!stat.isDirectory()) return { error: `freeze boundary ${abs} is not a directory` };
  return { configured: true, dir: realpathBest(abs), setAt };
}

function writeFreezeState(dir) {
  const abs = toAbsolute(dir);
  if (!abs) throw new Error(`could not resolve "${dir}"`);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`${abs} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`${abs} is not a directory`);
  const real = realpathBest(abs);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(
    freezeFile(),
    `${JSON.stringify({ dir: real, setAt: new Date().toISOString(), version: VERSION }, null, 2)}\n`,
    "utf8",
  );
  return real;
}

// ------------------------------------------------------- careful: the patterns
//
// The pattern list and the safe-exception list are gstack's, kept deliberately
// so that /careful behaves the same for anyone moving over. Three things are
// added, all of them cases gstack cannot see at all because its whole list
// assumes a POSIX shell: PowerShell's Remove-Item -Recurse -Force, cmd's
// rd /s /q and del /s, and git clean -fdx. On Windows those ARE the destructive
// commands an agent reaches for, so a Windows-correct guard that misses them is
// only pretending.

const SAFE_RM_TARGETS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  "target",
  "out",
]);

/** Split a command line into segments on shell operators, ignoring quoted text. */
function segments(cmd) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        cur += ch + (cmd[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      parts.push(cur);
      cur = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) {
      parts.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Strip one level of quoting from an argument token. */
function unquote(tok) {
  return tok.replace(/^['"]|['"]$/g, "");
}

/**
 * Every recursive-delete target in the segment, or null when the segment is not
 * a recursive delete. gstack sed-strips the flags off the whole command line at
 * once, so `rm -rf node_modules && rm -rf /var/data` can be judged on the wrong
 * arguments; this looks at one invocation at a time.
 */
function recursiveDeleteTargets(seg) {
  const tokens = seg.split(/\s+/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());

  const rmIdx = lower.findIndex((t) => t === "rm" || t.endsWith("/rm") || t.endsWith("\\rm.exe"));
  if (rmIdx !== -1) {
    const args = tokens.slice(rmIdx + 1);
    const recursive = args.some((a) => /^-[a-zA-Z]*r[a-zA-Z]*$/.test(a) || a === "--recursive");
    if (!recursive) return null;
    return args.filter((a) => !a.startsWith("-")).map(unquote);
  }

  const riIdx = lower.findIndex((t) => t === "remove-item" || t === "ri" || t === "rmdir" || t === "rd");
  if (riIdx !== -1) {
    const args = tokens.slice(riIdx + 1);
    const recursive =
      lower[riIdx] === "rd" ||
      lower[riIdx] === "rmdir" ||
      args.some((a) => /^-(recurse|r)$/i.test(a) || /^\/s$/i.test(a));
    if (!recursive) return null;
    return args.filter((a) => !a.startsWith("-") && !a.startsWith("/")).map(unquote);
  }

  return null;
}

function isSafeTarget(target) {
  const t = unquote(target).replace(/[\\/]+$/, "");
  if (!t) return false;
  const base = t.split(/[\\/]/).pop();
  // A bare or clearly project-relative build directory is safe. An absolute
  // path is never waved through, because `rm -rf /dist` is not `rm -rf dist`.
  if (looksAbsolute(t)) return false;
  if (t.includes("..")) return false;
  return SAFE_RM_TARGETS.has(base);
}

const PATTERNS = [
  {
    id: "rm_recursive",
    message: "recursive delete (rm -r). This permanently removes files.",
    test: (cmd) => segments(cmd).some((s) => /(^|[\s;=(])rm\s+(-[a-zA-Z]*r|--recursive)/.test(s)),
  },
  {
    id: "powershell_remove_recurse",
    message: "PowerShell Remove-Item -Recurse. This permanently removes a directory tree.",
    test: (cmd) => /\bRemove-Item\b[^\n;|]*\s-(Recurse|r)\b/i.test(cmd),
  },
  {
    id: "cmd_rd_del",
    message: "cmd recursive delete (rd /s or del /s). This permanently removes files.",
    test: (cmd) => /(^|[\s;&|])(rd|rmdir)\s+[^\n;|]*\/s\b/i.test(cmd) || /(^|[\s;&|])del\s+[^\n;|]*\/s\b/i.test(cmd),
  },
  {
    id: "drop_table",
    message: "SQL DROP detected. This permanently deletes database objects.",
    test: (cmd) => /\bdrop\s+(table|database|schema)\b/i.test(cmd),
  },
  {
    id: "truncate",
    message: "SQL TRUNCATE detected. This deletes all rows from a table.",
    test: (cmd) => /\btruncate\b/i.test(cmd),
  },
  {
    id: "git_force_push",
    message: "git force-push rewrites remote history. Other contributors may lose work.",
    test: (cmd) => /\bgit\s+push\b[^\n;|]*(\s-f\b|--force(?!-with-lease))/.test(cmd),
  },
  {
    id: "git_reset_hard",
    message: "git reset --hard discards all uncommitted changes.",
    test: (cmd) => /\bgit\s+reset\s+[^\n;|]*--hard\b/.test(cmd),
  },
  {
    id: "git_discard",
    message: "this discards all uncommitted changes in the working tree.",
    test: (cmd) => /\bgit\s+(checkout|restore)\s+\.(\s|$)/.test(cmd),
  },
  {
    id: "git_clean",
    message: "git clean -fd deletes untracked files, including ones never committed anywhere.",
    test: (cmd) => /\bgit\s+clean\b[^\n;|]*-[a-zA-Z]*f/.test(cmd),
  },
  {
    id: "kubectl_delete",
    message: "kubectl delete removes Kubernetes resources. This may affect production.",
    test: (cmd) => /\bkubectl\s+delete\b/.test(cmd),
  },
  {
    id: "docker_destructive",
    message: "Docker force-remove or prune. This may delete running containers or cached images.",
    test: (cmd) => /\bdocker\s+(rm\s+-f|system\s+prune|volume\s+prune)/.test(cmd),
  },
  {
    // FOUND BY tools/backtest.mjs, scenario careful-uncovered-destructive.
    //
    // The pattern list here was inherited from upstream and inherited its
    // shape: everything on it is something that deletes FILES. `dd` writing to
    // a block device, `mkfs`, and `wipefs` destroy the filesystem those files
    // were in, which is strictly worse and was strictly unguarded — the
    // backtest ran `dd if=/dev/zero of=/dev/sda` through both stacks and both
    // returned an unqualified allow.
    //
    // /dev/null, /dev/zero, /dev/stdout, /dev/stderr and /dev/tty are excluded
    // by name: `of=/dev/null` is an everyday idiom and a guard that warns about
    // it is a guard people switch off.
    id: "block_device_write",
    message: "a write straight to a block device (dd of=/dev/…, mkfs, wipefs). This destroys the filesystem on that device and nothing undoes it.",
    test: (cmd) =>
      /\bdd\b[^\n;|]*\bof=["']?\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|random\b|urandom\b)/.test(cmd) ||
      /(^|[\s;&|])mkfs(\.[a-z0-9]+)?\s/i.test(cmd) ||
      /(^|[\s;&|])wipefs\s/i.test(cmd),
  },
];

function inspectCommand(cmd) {
  // Safe exception first, and only when EVERY recursive delete in the line is
  // a build directory. One unsafe target anywhere makes the whole line unsafe.
  const deletes = segments(cmd).map(recursiveDeleteTargets).filter(Boolean);
  const everyDeleteIsSafe =
    deletes.length > 0 && deletes.every((targets) => targets.length > 0 && targets.every(isSafeTarget));

  for (const p of PATTERNS) {
    let hit = false;
    try {
      hit = p.test(cmd);
    } catch {
      // A pattern that throws must not become an allow.
      return { pattern: p.id, message: `pattern ${p.id} could not be evaluated` };
    }
    if (!hit) continue;
    const isDeletePattern = p.id === "rm_recursive" || p.id === "powershell_remove_recurse" || p.id === "cmd_rd_del";
    if (isDeletePattern && everyDeleteIsSafe) continue;
    return { pattern: p.id, message: p.message };
  }
  return null;
}

// ---------------------------------------------------------------- decisions

function decideCareful(input) {
  const toolName = input.tool_name ?? input.toolName;
  const ti = input.tool_input ?? input.toolInput;

  if (toolName && toolName !== "Bash" && toolName !== "BashOutput") {
    return allow("not a Bash call");
  }
  if (!ti || typeof ti !== "object") {
    return guardFailure("careful", "the payload had no tool_input object to inspect");
  }
  const cmd = ti.command;
  if (cmd === undefined || cmd === null) {
    return guardFailure("careful", "tool_input had no command field, so nothing could be checked");
  }
  if (typeof cmd !== "string") {
    return guardFailure("careful", `tool_input.command was ${typeof cmd}, not a string`);
  }
  if (!cmd.trim()) return allow("empty command");

  const hit = inspectCommand(cmd);
  if (!hit) return allow("no destructive pattern matched");
  return ask(`[careful] Destructive: ${hit.message}`, hit.pattern);
}

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);

function decideFreeze(input, cwd = process.cwd()) {
  const state = readFreezeState();
  if (state.error) return guardFailure("freeze", state.error);
  if (!state.configured) return allow("no freeze boundary set");

  const toolName = input.tool_name ?? input.toolName;
  const ti = input.tool_input ?? input.toolInput;

  // Unknown tool names are NOT waved through. The hook is only registered for
  // edit tools, so if something else arrives the registration is wrong and the
  // guard cannot know what it is being asked about.
  if (toolName && !EDIT_TOOLS.has(toolName)) {
    return guardFailure("freeze", `the freeze hook was invoked for tool "${toolName}", which it does not know how to check`);
  }
  if (!ti || typeof ti !== "object") {
    return guardFailure("freeze", "the payload had no tool_input object to inspect");
  }

  const key = PATH_KEYS.find((k) => typeof ti[k] === "string" && ti[k].trim());
  if (!key) {
    return guardFailure(
      "freeze",
      `tool_input carried no file path (looked for ${PATH_KEYS.join(", ")}), so containment could not be checked`,
    );
  }

  const abs = toAbsolute(ti[key], cwd);
  if (!abs) return guardFailure("freeze", `"${ti[key]}" could not be resolved to an absolute path`);
  const real = realpathBest(abs);

  if (isInside(state.dir, real)) return allow("inside the boundary");
  return deny(
    `[freeze] Blocked: ${real} is outside the freeze boundary (${state.dir}). ` +
      `Only edits inside the frozen directory are allowed. Run /unfreeze to lift it.`,
    "boundary_deny",
  );
}

// ----------------------------------------------------------------- self test
//
// This is the command that answers "is the guard actually doing anything".
// It runs THIS FILE as a child process with real hook payloads, because that is
// what Claude Code does, and an in-process assertion would not have caught the
// gstack bug either (their shell logic is correct; the plumbing around it is
// what fails).

function runGuard(mode, payload, env = {}) {
  const res = spawnSync(process.execPath, [SELF, mode], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout.trim() || "{}");
  } catch {
    parsed = null;
  }
  const action = parsed === null ? "unparseable" : (parsed.permissionDecision ?? "allow");
  return { action, stdout: res.stdout.trim(), status: res.status, message: parsed?.message ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-guard-selftest-"));
  const stateA = path.join(tmp, "state-ok");
  const stateBroken = path.join(tmp, "state-broken");
  const stateMissing = path.join(tmp, "state-missing");
  const boundary = path.join(tmp, "proj", "src");
  const outside = path.join(tmp, "proj", "other");
  fs.mkdirSync(boundary, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(stateA, { recursive: true });
  fs.mkdirSync(stateBroken, { recursive: true });
  fs.writeFileSync(path.join(stateA, "freeze.json"), JSON.stringify({ dir: boundary }), "utf8");
  fs.writeFileSync(path.join(stateBroken, "freeze.json"), "{ this is not json", "utf8");

  const cases = [
    // --- careful: it catches what it is supposed to catch
    ["careful catches rm -rf", "careful", { tool_name: "Bash", tool_input: { command: "rm -rf /var/data" } }, {}, "ask"],
    [
      "careful catches rm -rf hidden after an escaped quote (gstack allows this)",
      "careful",
      { tool_name: "Bash", tool_input: { command: 'echo "starting" && rm -rf /var/data' } },
      {},
      "ask",
    ],
    [
      "careful catches PowerShell Remove-Item -Recurse -Force",
      "careful",
      { tool_name: "Bash", tool_input: { command: "Remove-Item -Recurse -Force C:\\data" } },
      {},
      "ask",
    ],
    ["careful catches git push --force", "careful", { tool_name: "Bash", tool_input: { command: "git push -f origin main" } }, {}, "ask"],
    ["careful catches DROP TABLE", "careful", { tool_name: "Bash", tool_input: { command: 'psql -c "drop table users;"' } }, {}, "ask"],
    // Added after tools/backtest.mjs scored careful-uncovered-destructive as
    // BOTH-WRONG: the inherited list guarded files and not the device they
    // live on.
    ["careful catches dd to a block device", "careful", { tool_name: "Bash", tool_input: { command: "dd if=/dev/zero of=/dev/sda bs=1M" } }, {}, "ask"],
    ["careful catches mkfs", "careful", { tool_name: "Bash", tool_input: { command: "mkfs.ext4 /dev/sdb1" } }, {}, "ask"],
    ["careful catches wipefs", "careful", { tool_name: "Bash", tool_input: { command: "wipefs -a /dev/sdb" } }, {}, "ask"],
    // --- careful: it does not cry wolf
    ["careful allows rm -rf node_modules", "careful", { tool_name: "Bash", tool_input: { command: "rm -rf node_modules" } }, {}, "allow"],
    ["careful allows dd to /dev/null", "careful", { tool_name: "Bash", tool_input: { command: "dd if=big.iso of=/dev/null bs=1M" } }, {}, "allow"],
    ["careful allows a path that merely contains mkfs", "careful", { tool_name: "Bash", tool_input: { command: "cat ./docs/mkfs-notes.md" } }, {}, "allow"],
    ["careful allows a plain build", "careful", { tool_name: "Bash", tool_input: { command: "npm run build" } }, {}, "allow"],
    [
      "careful does NOT allow a safe delete used as cover for an unsafe one",
      "careful",
      { tool_name: "Bash", tool_input: { command: "rm -rf node_modules && rm -rf /var/data" } },
      {},
      "ask",
    ],
    // --- careful: fail closed
    ["careful blocks on non-JSON stdin", "careful", "not json at all", {}, "ask"],
    ["careful blocks on a payload with no tool_input", "careful", { tool_name: "Bash" }, {}, "ask"],
    ["careful blocks when command is missing", "careful", { tool_name: "Bash", tool_input: {} }, {}, "ask"],
    ["careful blocks when command is not a string", "careful", { tool_name: "Bash", tool_input: { command: 42 } }, {}, "ask"],
    // --- freeze: normal operation
    [
      "freeze allows an edit inside the boundary",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: path.join(boundary, "a.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "allow",
    ],
    [
      "freeze allows a Write to a file that does not exist yet",
      "freeze",
      { tool_name: "Write", tool_input: { file_path: path.join(boundary, "nested", "new.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "allow",
    ],
    [
      "freeze blocks an edit outside the boundary",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: path.join(outside, "b.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "deny",
    ],
    [
      "freeze blocks a sibling whose name merely starts with the boundary",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: `${boundary}-old${path.sep}c.txt` } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "deny",
    ],
    [
      "freeze blocks a traversal out of the boundary",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: path.join(boundary, "..", "other", "d.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "deny",
    ],
    [
      "freeze allows when no boundary was ever set",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: path.join(outside, "b.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateMissing },
      "allow",
    ],
    // --- freeze: fail closed
    [
      "freeze blocks when its state file is corrupt",
      "freeze",
      { tool_name: "Edit", tool_input: { file_path: path.join(boundary, "a.txt") } },
      { TOOLBAY_STACK_STATE_DIR: stateBroken },
      "deny",
    ],
    [
      "freeze blocks when the payload has no file path (gstack allows this)",
      "freeze",
      { tool_name: "Edit", tool_input: {} },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "deny",
    ],
    ["freeze blocks on non-JSON stdin", "freeze", "}{", { TOOLBAY_STACK_STATE_DIR: stateA }, "deny"],
    [
      "freeze blocks a tool it was not designed to check",
      "freeze",
      { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ ../other/b.txt" } },
      { TOOLBAY_STACK_STATE_DIR: stateA },
      "deny",
    ],
  ];

  const results = [];
  for (const [name, mode, payload, env, expected] of cases) {
    const got = runGuard(mode, payload, { TOOLBAY_STACK_STATE_DIR: stateMissing, ...env });
    results.push({ name, expected, got: got.action, pass: got.action === expected, detail: got.message });
  }

  // Run from inside a Cursor install, `doctor` must refuse to answer rather
  // than walking off to ~/.claude/skills and reporting INERT about an editor
  // the user was not asking about. Asserted by actually putting a copy at a
  // .cursor path and running it, because the check keys on its own location.
  {
    const cursorScripts = path.join(tmp, "proj", ".cursor", "skills", "freeze", "scripts");
    fs.mkdirSync(cursorScripts, { recursive: true });
    const copy = path.join(cursorScripts, "tb-guard.mjs");
    // Copy the siblings too: this engine imports tb-paths.mjs from beside
    // itself, exactly as the installed layout provides it.
    for (const f of fs.readdirSync(path.dirname(SELF))) {
      if (f.endsWith(".mjs")) fs.copyFileSync(path.join(path.dirname(SELF), f), path.join(cursorScripts, f));
    }
    fs.copyFileSync(SELF, copy);
    const r = spawnSync(process.execPath, [copy, "doctor"], { encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    const said = `${r.stdout || ""}`;
    results.push({
      name: "doctor run from a .cursor install refuses to answer for Claude Code",
      expected: "redirect",
      got: /installed for CURSOR/.test(said) && /tb-cursor\.mjs" doctor/.test(said) && !/INERT/.test(said) ? "redirect" : said.slice(0, 160),
      pass: /installed for CURSOR/.test(said) && /tb-cursor\.mjs" doctor/.test(said) && !/INERT/.test(said),
      detail: "otherwise a Cursor user asking whether their guard works is told INERT about ~/.claude",
    });
  }

  // The copies of this engine shipped inside each skill must be identical, or
  // "I fixed careful" would silently not fix freeze.
  results.push(...copyIntegrity());

  // A selftest whose total depends on where it was run from is a selftest that
  // can quietly stop asserting things. The expected count is stated here, and
  // failing to reach it is itself a failure, so no run can print the banner
  // below on the strength of assertions it never made.
  // cases + the Cursor-doctor redirect + one "can the copies be located"
  // + one per copy + this line itself.
  const EXPECTED = cases.length + GUARD_COPIES.length + 3;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-guard selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    process.stdout.write(`  ${tag}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write(`\n  The guard is NOT trustworthy in this state. Failures:\n`);
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  The guard blocks on every deliberately broken input above, which is the\n");
  process.stdout.write("  behaviour that matters: it fails closed rather than silently allowing.\n\n");
}

/**
 * The skills that ship a copy of this engine, in sync with tools/sync-guard.mjs.
 * Hard-coded on purpose: a directory listing can only tell you what IS there,
 * and the failure this check exists to catch is a copy that is NOT.
 */
const GUARD_COPIES = ["careful", "freeze", "guard", "investigate"];

/**
 * Where the other copies of this engine live, given where THIS copy lives.
 *
 * The previous version resolved `dirname(SELF)/../..` and listed it. From
 * `skills/<name>/scripts/` that happens to be `skills/`, so it worked; from
 * `src/guard/` it is the repository root, which has no `<name>/scripts` under
 * it, so the listing came back empty, zero assertions ran, and the selftest
 * printed its proof banner anyway. That is precisely the shape of bug this
 * whole project exists to point at, so the resolution is now explicit and its
 * failure is an assertion of its own rather than an empty array.
 */
function locateCopies() {
  const dir = path.dirname(SELF);
  // Layout A: the repository checkout, src/guard/tb-guard.mjs.
  if (path.basename(dir) === "guard" && path.basename(path.dirname(dir)) === "src") {
    const repo = path.resolve(dir, "..", "..");
    return { kind: "repo", skillsDir: path.join(repo, "skills"), canonical: SELF };
  }
  // Layout B: an installed or in-repo skill copy, <root>/<skill>/scripts/tb-guard.mjs.
  if (path.basename(dir) === "scripts") {
    const skillsDir = path.resolve(dir, "..", "..");
    const repoCanonical = path.join(skillsDir, "..", "src", "guard", "tb-guard.mjs");
    return {
      kind: fs.existsSync(repoCanonical) ? "repo" : "install",
      skillsDir,
      canonical: fs.existsSync(repoCanonical) ? path.resolve(repoCanonical) : SELF,
    };
  }
  return { kind: "unknown", skillsDir: null, canonical: SELF };
}

/**
 * Every copy of this engine must be byte-identical to the canonical one.
 *
 * Always returns exactly GUARD_COPIES.length + 1 results, whatever the layout,
 * so the selftest's total cannot silently shrink depending on which directory
 * it was run from. Anything this function cannot verify is reported as a
 * FAILING assertion, never as a missing one.
 */
function copyIntegrity() {
  const out = [];
  const loc = locateCopies();

  const locOk = loc.kind !== "unknown" && Boolean(loc.skillsDir) && fs.existsSync(loc.skillsDir);
  out.push({
    name: "the other copies of this engine can be located",
    expected: "located",
    got: locOk ? `located (${loc.kind})` : "NOT LOCATED",
    pass: locOk,
    detail: loc.skillsDir
      ? `${loc.skillsDir} ${locOk ? "" : "does not exist"}`
      : `${SELF} is in neither src/guard/ nor <skills>/<name>/scripts/, so sibling copies cannot be checked`,
  });

  let canonical = null;
  let canonicalErr = "";
  try {
    canonical = fs.readFileSync(loc.canonical);
  } catch (e) {
    canonicalErr = `${loc.canonical} could not be read (${e.code || e.message})`;
  }

  for (const skill of GUARD_COPIES) {
    const name = `engine copy in ${skill} is identical`;
    if (!locOk || !canonical) {
      out.push({
        name,
        expected: "identical",
        got: "UNCHECKED",
        pass: false,
        detail: canonicalErr || "the skills directory could not be located, so this copy was never compared",
      });
      continue;
    }
    const p = path.join(loc.skillsDir, skill, "scripts", "tb-guard.mjs");
    let buf = null;
    let readErr = "";
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      readErr = `${p} could not be read (${e.code || e.message})`;
    }
    if (!buf) {
      // In a checkout, a missing copy is a broken release: sync-guard is
      // supposed to have written it. In a bare install, a skill the user chose
      // not to install is legitimately absent, but the fact is still printed
      // rather than skipped.
      const installedElsewhere = loc.kind === "install" && !fs.existsSync(path.join(loc.skillsDir, skill));
      out.push({
        name,
        expected: "identical",
        got: installedElsewhere ? "not installed" : "MISSING",
        pass: installedElsewhere,
        detail: installedElsewhere ? `${skill} is not installed under ${loc.skillsDir}` : readErr,
      });
      continue;
    }
    const same = buf.equals(canonical);
    out.push({
      name,
      expected: "identical",
      got: same ? "identical" : "DIFFERENT",
      pass: same,
      detail: p,
    });
  }
  return out;
}

/**
 * `doctor` answers a different question from `selftest`: not "does the engine
 * work" but "is it wired into this machine". It runs the exact command string
 * written in each installed SKILL.md's hook frontmatter.
 */
function doctor() {
  // WRONG EDITOR, WRONG ANSWER, AND THE ANSWER IS ALARMING.
  //
  // This doctor reads Claude Code's `hooks:` frontmatter, which the Cursor
  // installer strips because Cursor does not read it. Run from inside a
  // .cursor/ install it therefore ignores the copy it is standing in, walks off
  // to ~/.claude/skills, finds whatever else is installed there, and reports
  // INERT — so a Cursor user asking "is my guard working" is told, in red, that
  // it is not, about an editor they were not asking about. Measured on a real
  // install: it reported three INERT/SKIP rows for a gstack install in
  // ~/.claude while the Cursor guards beside it were correctly denying.
  //
  // Being wrong in the safe direction is not a defence. A guard that cries
  // broken gets uninstalled just as fast as one that lies about working.
  const selfDir = path.dirname(SELF);
  if (selfDir.split(/[\\/]/).includes(".cursor")) {
    const cursorRoot = selfDir.slice(0, selfDir.toLowerCase().lastIndexOf(`${path.sep}.cursor`.toLowerCase()) + `${path.sep}.cursor`.length);
    const adapter = path.join(cursorRoot, "hooks", "tb-cursor.mjs");
    process.stdout.write(
      `\n  tb-guard doctor\n\n` +
        `  This copy is installed for CURSOR (${cursorRoot}).\n\n` +
        `  This command cannot answer for it. It reads Claude Code's \`hooks:\` frontmatter,\n` +
        `  which the Cursor installer removes on purpose because Cursor does not read it —\n` +
        `  Cursor wires guards through .cursor/hooks.json instead. Left to run, this would\n` +
        `  have walked off to ~/.claude/skills and reported on a DIFFERENT editor's install.\n\n` +
        `  Ask the Cursor adapter instead:\n\n` +
        `    node "${adapter.split(path.sep).join("/")}" doctor\n\n`,
    );
    process.exitCode = fs.existsSync(adapter) ? 0 : 1;
    return;
  }

  const roots = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(process.cwd(), ".claude", "skills"),
  ];

  // The freeze probe needs a boundary to exist, because "no boundary set" is a
  // legitimate allow and would read as INERT otherwise. So the probe runs
  // against a throwaway state directory with a real boundary in it, and asks
  // about a path outside that boundary. Nothing touches the user's own state.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-guard-doctor-"));
  const boundary = path.join(tmp, "inside");
  fs.mkdirSync(boundary, { recursive: true });
  fs.writeFileSync(path.join(tmp, "freeze.json"), JSON.stringify({ dir: boundary }), "utf8");
  const probeEnv = { ...process.env, TOOLBAY_STACK_STATE_DIR: tmp };

  process.stdout.write(`\n  tb-guard doctor\n\n`);
  let found = 0;
  for (const root of roots) {
    for (const skill of ["careful", "freeze", "guard"]) {
      const md = path.join(root, skill, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      found += 1;
      const text = fs.readFileSync(md, "utf8");
      const ours = /tb-guard\.mjs/.test(text);
      const cmds = [...new Set([...text.matchAll(/^\s*command:\s*(["'])(.+)\1\s*$/gm)].map((m) => m[2]))];
      process.stdout.write(`  ${skill}  ${path.dirname(md)}${ours ? "" : "   (not a Toolbay Stack skill)"}\n`);
      if (!cmds.length) {
        process.stdout.write(`        INERT   no PreToolUse hook command in the frontmatter, so nothing is checked\n`);
        process.exitCode = 1;
        continue;
      }
      for (const raw of cmds) {
        const expanded = raw
          .replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/g, os.homedir())
          .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, process.cwd());
        const argv = (expanded.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ""));
        if (!argv.length) continue;
        const isFreeze = /freeze/.test(raw);
        // A foreign freeze hook keeps its boundary somewhere this tool does not
        // know about, so an unconfigured allow would be a correct answer and
        // calling it INERT would be a false accusation. Say so instead.
        if (isFreeze && !ours) {
          process.stdout.write(`        SKIP    ${raw}\n`);
          process.stdout.write(`                 not checked: this hook stores its boundary somewhere this tool cannot set\n`);
          continue;
        }
        const probe = isFreeze
          ? { tool_name: "Edit", tool_input: { file_path: path.join(tmp, "outside", "x.txt") } }
          : { tool_name: "Bash", tool_input: { command: 'echo "go" && rm -rf /var/data' } };
        const res = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify(probe), encoding: "utf8", env: probeEnv });
        let action = "no output";
        try {
          const parsed = JSON.parse((res.stdout || "").trim() || "{}");
          action = parsed.permissionDecision ?? parsed.hookSpecificOutput?.permissionDecision ?? "allow";
        } catch {
          action = "unparseable output";
        }
        const ok = action === "ask" || action === "deny";
        process.stdout.write(`        ${ok ? "ACTIVE " : "INERT  "} ${raw}\n`);
        process.stdout.write(`                 ${isFreeze ? "edit outside a live boundary" : "rm -rf after an escaped quote"} -> ${action}\n`);
        if (!ok) {
          const err = (res.stderr || "").trim().slice(0, 160);
          process.stdout.write(`                 this hook would NOT have stopped it${err ? `. stderr: ${err}` : ""}\n`);
          // Only a Toolbay Stack guard failing is this tool's problem to fail
          // on. A third-party guard that allows is reported and left alone.
          if (ours) process.exitCode = 1;
        }
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!found) {
    process.stdout.write("  No careful/freeze/guard skill is installed in ~/.claude/skills or ./.claude/skills.\n");
    process.stdout.write("  Install with: npx toolbay-stack install --global\n");
    process.exitCode = 1;
  }
  process.stdout.write("\n");
}

// --------------------------------------------------------------------- entry

function help() {
  process.stdout.write(`
  tb-guard ${VERSION}, the Toolbay Stack safety engine

  Hook modes (read a PreToolUse payload on stdin, print a decision):
    careful              check a Bash command for destructive patterns
    freeze               check an Edit/Write path against the freeze boundary

  Boundary:
    freeze --set <dir>   set the boundary
    freeze --off         clear it
    state                print the current boundary

  Proof:
    selftest             run the guard against real and deliberately broken
                         payloads, including ones it must refuse to allow
    doctor               run the hook command written in each installed
                         SKILL.md and report ACTIVE or INERT

  This guard fails closed. If it cannot decide, it blocks and says why.
  Set TOOLBAY_GUARD_STRICT=1 to turn careful's internal failures into hard
  denies instead of prompts, for unattended runs.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "careful" || cmd === "freeze") {
    const isFlag = argv[1] && argv[1].startsWith("--");
    if (!isFlag) {
      const stdin = await readStdin();
      if (!stdin.ok) {
        emit(guardFailure(cmd, stdin.error));
        return;
      }
      const parsed = parseHookInput(stdin.data);
      if (!parsed.ok) {
        emit(guardFailure(cmd, parsed.error));
        return;
      }
      emit(cmd === "careful" ? decideCareful(parsed.value) : decideFreeze(parsed.value));
      return;
    }
  }

  if (cmd === "freeze" && argv[1] === "--set") {
    const dir = argv[2];
    if (!dir) {
      process.stderr.write("Usage: tb-guard freeze --set <dir>\n");
      process.exitCode = 1;
      return;
    }
    const real = writeFreezeState(dir);
    process.stdout.write(`Freeze boundary set: ${real}\nEdits outside it are blocked until /unfreeze.\n`);
    return;
  }

  if ((cmd === "freeze" && argv[1] === "--off") || cmd === "unfreeze") {
    const file = freezeFile();
    if (fs.existsSync(file)) {
      const prev = readFreezeState();
      fs.rmSync(file, { force: true });
      process.stdout.write(`Freeze boundary cleared (was: ${prev.dir ?? "unreadable"}). Edits are allowed everywhere again.\n`);
    } else {
      process.stdout.write("No freeze boundary was set.\n");
    }
    return;
  }

  if (cmd === "state") {
    const s = readFreezeState();
    if (s.error) {
      process.stdout.write(`freeze: BROKEN STATE, so every edit is blocked. ${s.error}\n`);
      process.exitCode = 1;
    } else if (!s.configured) process.stdout.write("freeze: no boundary set\n");
    else process.stdout.write(`freeze: ${s.dir}${s.setAt ? ` (set ${s.setAt})` : ""}\n`);
    process.stdout.write(`state dir: ${stateDir()}\n`);
    return;
  }

  if (cmd === "selftest") return selftest();
  if (cmd === "doctor") return doctor();
  help();
}

// Nothing below this line is allowed to turn a crash into an allow. If the
// process dies unexpectedly while acting as a hook, emit a block first.
const HOOK_MODES = new Set(["careful", "freeze"]);
const activeMode = HOOK_MODES.has(process.argv[2]) && !String(process.argv[3] ?? "").startsWith("--")
  ? process.argv[2]
  : null;

function crashGuard(err) {
  if (activeMode) emit(guardFailure(activeMode, `the guard crashed (${err?.message ?? err})`));
  else process.stderr.write(`tb-guard: ${err?.stack ?? err}\n`);
  process.exit(activeMode ? 0 : 1);
}

process.on("uncaughtException", crashGuard);
process.on("unhandledRejection", crashGuard);

main().catch(crashGuard);
