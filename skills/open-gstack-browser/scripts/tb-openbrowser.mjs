#!/usr/bin/env node
/**
 * tb-openbrowser.mjs — open a VISIBLE gstack browser and prove it is actually
 * open, with the sidebar it was opened for.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The command this wraps, the headed-Chromium-with-sidebar
 * contract, the extension layout <root>/{.codex,.agents,.claude}/skills/gstack/
 * extension/, the state file .gstack/browse.json, the fixed port 34567, the
 * Side Panel walkthrough and the /connect-chrome alias all come from
 * `open-gstack-browser` in gstack (https://github.com/garrytan/gstack, MIT,
 * Copyright (c) 2026 Garry Tan). The browser itself is his and is run here
 * unmodified. What is new is the layer around it: a state reader that can read
 * the file the browser actually writes, an extension check that refuses instead
 * of shrugging, a stop that works on Windows, and a verdict computed from
 * /health rather than eyeballed off stdout. Not affiliated with or endorsed by
 * Garry Tan. See LICENSE and NOTICE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Measured on Windows 11, gstack 1.60.1.0, browse dist 7c9df1c5, 2026-08-17.
 * `browse connect` itself works here and is excellent. Every failure below is
 * in the shell contract wrapped around it, and every one fails OPEN: the check
 * breaks, nothing is printed, and the skill proceeds to "You're all set!".
 *
 * 1. THE STATE FILE IS NOT WHERE THE SKILL LOOKS.
 *    Upstream Step 0 and Step 2 both read
 *      "$(git rev-parse --show-toplevel)/.gstack/browse.json"
 *    The running server writes ~/.gstack/browse/browse.json. Measured:
 *      $ ls ~/.gstack/browse/browse.json      /c/Users/orion/.gstack/browse/browse.json
 *      $ ls <git root>/.gstack/browse.json    No such file or directory
 *
 * 2. AND THE REGEX CANNOT MATCH IT EVEN WHEN POINTED AT IT.
 *    Upstream parses with `grep -o '"port":[0-9]*'`. The file is pretty-printed,
 *    so every key is `"port": 34567` with a space. Against the bytes the server
 *    had just written:
 *      $ cat ~/.gstack/browse/browse.json | grep -o '"port":[0-9]*' | grep -o '[0-9]*'
 *      (no output)
 *      $ cat ~/.gstack/browse/browse.json | grep -o '"pid":[0-9]*'  | grep -o '[0-9]*'
 *      (no output)
 *    Upstream Step 2 then says "The port should be 34567", which is a guess
 *    printed as a reading. Here the port comes out of JSON.parse or the run
 *    fails.
 *
 * 3. THE PRE-FLIGHT KILL CANNOT REACH THE PROCESS, AND DELETES ITS ONLY RECORD.
 *    Git Bash `kill` speaks MSYS pids; browse.json holds a Windows pid.
 *    Measured against a live detached process, windows pid 1225768:
 *      $ kill    1225768   ->  kill: (1225768) - No such process   exit 1
 *      $ kill -9 1225768   ->  kill: (1225768) - No such process   exit 1
 *      $ node -e process.kill(1225768,0)  ->  STILL ALIVE
 *    Upstream swallows both failures (`2>/dev/null || true`) and then `rm -f`s
 *    browse.json. On Windows that is not a no-op, it is worse than one: the
 *    browser and its server keep running and their only record is gone. `close`
 *    here kills through Node, confirms death, and removes the state file only
 *    after the process is confirmed dead.
 *
 * 4. THE EXTENSION IS THE POINT AND IS NOT REQUIRED.
 *    Upstream looks in ONE marker directory (.claude), prints
 *    `EXTENSION_PATH: NOT FOUND` when it misses, and carries straight on to the
 *    Side Panel walkthrough and to "You're all set!". A visible browser with no
 *    sidebar is the entire feature missing. Here the extension is searched
 *    across .codex/.agents/.claude from git root, cwd and home, its manifest is
 *    parsed, its side_panel/service_worker/content-script files are checked on
 *    disk, and `open` REFUSES BEFORE LAUNCHING ANYTHING if it is not usable.
 *
 * 5. "CONFIRM YOU SEE Mode: headed" IS NOT A CHECK.
 *    It is stdout, read by eye. `$B connect` with B unset is
 *    `connect: command not found`, exit 127, and the next step prints nothing
 *    either. The verdict here is computed from three independent sources that
 *    must agree: the state file, process liveness, and GET /health on the port
 *    the state file names.
 *
 * 6. THE RECOVERY INSTRUCTION IS macOS-ONLY.
 *    "Press Cmd+Shift+G in the file picker dialog" is what upstream tells a
 *    user whose extension did not load. There is no Cmd key on this machine.
 *
 * ---------------------------------------------------------------------------
 *   node tb-openbrowser.mjs doctor      what this machine has, fail closed
 *   node tb-openbrowser.mjs open        launch and prove it, or refuse
 *   node tb-openbrowser.mjs verify      verdict on a session already running
 *   node tb-openbrowser.mjs close       stop it for real, then forget it
 *   node tb-openbrowser.mjs selftest    prove the checks catch the lies
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBrowse, gitRoot } from "./tb-browse-bin.mjs";

const IS_WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** gstack's own agent-tool marker directories, in gstack's order. */
export const EXT_MARKERS = [".codex", ".agents", ".claude"];

/** The port gstack pins so the extension can auto-connect. Used as a LABEL only. */
export const GSTACK_PORT = 34567;

// ---------------------------------------------------------------- small utils

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  // Atomics.wait rather than a spin loop, and rather than shelling out to
  // `sleep`, which the agent harness blocks and which Git Bash and PowerShell
  // spell differently anyway.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is this process alive, judged on the platform's own terms.
 *
 * process.kill(pid, 0) asks the OS, so a Windows pid is a Windows pid. EPERM
 * means the process exists and is not ours, which is still alive. Anything
 * else is treated as NOT alive, because a liveness check that cannot decide
 * must not answer "yes".
 */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

// ------------------------------------------------------------------ extension

/**
 * Read an extension directory and decide whether Chromium could actually load
 * it. Every problem is collected rather than thrown, so "not usable" arrives as
 * a list of reasons a person can act on.
 */
export function inspectExtension(dir) {
  const problems = [];
  const manifestPath = path.join(dir, "manifest.json");

  let st = null;
  try {
    st = fs.statSync(manifestPath);
  } catch {
    return { dir, manifestPath, manifest: null, usable: false, problems: [`no manifest.json in ${dir}`] };
  }
  if (!st.isFile()) {
    return { dir, manifestPath, manifest: null, usable: false, problems: [`${manifestPath} is not a file`] };
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { dir, manifestPath, manifest: null, usable: false, problems: [`manifest.json is not valid JSON: ${e.message}`] };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { dir, manifestPath, manifest: null, usable: false, problems: ["manifest.json is not a JSON object"] };
  }

  if (Number(manifest.manifest_version) !== 3) {
    problems.push(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, and Chromium loads this unpacked as MV3`);
  }

  const sidePanel = manifest.side_panel && manifest.side_panel.default_path;
  if (!sidePanel) {
    problems.push("no side_panel.default_path — the sidebar is the only reason to open a visible browser, so a build without one is not this skill's browser");
  } else if (!isFile(path.join(dir, sidePanel))) {
    problems.push(`side_panel.default_path "${sidePanel}" is not on disk`);
  }

  const worker = manifest.background && manifest.background.service_worker;
  if (worker && !isFile(path.join(dir, worker))) {
    problems.push(`background.service_worker "${worker}" is not on disk`);
  }

  for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    for (const j of Array.isArray(cs.js) ? cs.js : []) {
      if (!isFile(path.join(dir, j))) problems.push(`content script "${j}" is not on disk`);
    }
    for (const c of Array.isArray(cs.css) ? cs.css : []) {
      if (!isFile(path.join(dir, c))) problems.push(`content stylesheet "${c}" is not on disk`);
    }
  }

  return { dir, manifestPath, manifest, usable: problems.length === 0, problems };
}

/**
 * Find the gstack sidebar extension.
 *
 * Upstream checks exactly two paths, both under `.claude`. gstack installs
 * itself under `.codex`, `.agents` OR `.claude` depending on the agent tool, so
 * an install under either of the first two reads as NOT FOUND upstream and the
 * walkthrough then tells the user to paste the literal string "NOT FOUND" into
 * Chromium's folder picker.
 */
export function resolveExtension(cwd = process.cwd(), env = process.env) {
  const searched = [];

  const override = env.TOOLBAY_GSTACK_EXTENSION;
  if (override) {
    // An explicit override is taken literally and never falls back, same rule
    // as TOOLBAY_BROWSE_BIN: a user who named a directory wants that one or an
    // error, not a different one chosen quietly.
    searched.push(`TOOLBAY_GSTACK_EXTENSION=${override}`);
    const r = inspectExtension(path.resolve(override));
    return { ...r, via: "TOOLBAY_GSTACK_EXTENSION", searched };
  }

  const roots = [];
  const gr = gitRoot(cwd);
  if (gr) roots.push(gr);
  roots.push(path.resolve(cwd));
  roots.push(os.homedir());

  const seen = new Set();
  for (const root of roots) {
    for (const marker of EXT_MARKERS) {
      const dir = path.join(root, marker, "skills", "gstack", "extension");
      if (seen.has(dir)) continue;
      seen.add(dir);
      searched.push(dir);
      if (fs.existsSync(path.join(dir, "manifest.json"))) {
        const via = root === gr ? "git root" : root === os.homedir() ? "home" : "cwd";
        return { ...inspectExtension(dir), via, searched };
      }
    }
  }

  return {
    dir: null,
    manifestPath: null,
    manifest: null,
    usable: false,
    via: null,
    searched,
    problems: [`no gstack extension directory found in ${searched.length} locations`],
  };
}

// ----------------------------------------------------------------- state file

/**
 * Every place the browse state file is known to live, in the order upstream
 * documents them, with the place the binary actually writes it appended.
 */
export function stateCandidates(cwd = process.cwd(), env = process.env) {
  const out = [];
  if (env.TOOLBAY_BROWSE_STATE) out.push(env.TOOLBAY_BROWSE_STATE);
  const gr = gitRoot(cwd);
  if (gr) out.push(path.join(gr, ".gstack", "browse.json"));
  out.push(path.join(path.resolve(cwd), ".gstack", "browse.json"));
  const home = os.homedir();
  out.push(path.join(home, ".gstack", "browse", "browse.json"));
  out.push(path.join(home, ".gstack", "browse.json"));
  return [...new Set(out.map((p) => path.resolve(p)))];
}

/**
 * Read the state file with a JSON parser.
 *
 * A file that exists but does not parse is reported as UNREADABLE, never as
 * "no session running": those are opposite facts and only one of them means it
 * is safe to launch another browser.
 */
export function readState(cwd = process.cwd(), env = process.env) {
  const searched = [];
  for (const file of stateCandidates(cwd, env)) {
    searched.push(file);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let state = null;
    let error = null;
    try {
      state = JSON.parse(raw);
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        error = "state file is not a JSON object";
        state = null;
      }
    } catch (e) {
      error = e.message;
    }
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      /* the read succeeded, so a stat failure is not the story */
    }
    return { file, raw, state, error, mtimeMs, searched };
  }
  return { file: null, raw: null, state: null, error: null, mtimeMs: null, searched };
}

/** The port this session is really on. Never a default, never 34567 by hope. */
export function statePort(state) {
  const p = state && Number(state.port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
}

// ---------------------------------------------------------------- /health

/**
 * Ask the running server what it is.
 *
 * Fails closed in every direction: a timeout, a connection refusal, a non-200,
 * or a body that is not JSON all return ok:false with the reason. Upstream has
 * no equivalent — it reads `Mode: headed` off stdout, which a dead server that
 * printed it ten minutes ago satisfies just as well.
 */
export function fetchHealth(port, timeoutMs = 4000, host = "127.0.0.1") {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve({ ok: false, error: `not a usable port: ${port}` });
      return;
    }
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get({ host, port, path: "/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        if (body.length < 65536) body += d;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          done({ ok: false, code: res.statusCode, body: body.slice(0, 200), error: `HTTP ${res.statusCode}` });
          return;
        }
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          done({ ok: false, code: 200, body: body.slice(0, 200), error: `body is not JSON: ${e.message}` });
          return;
        }
        done({ ok: true, code: 200, mode: json.mode, status: json.status, tabs: json.tabs, json });
      });
    });
    req.on("error", (e) => done({ ok: false, error: e.code || String(e.message) }));
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, error: `no answer in ${timeoutMs}ms` });
    });
  });
}

// -------------------------------------------------------------------- verdict

/**
 * The computed verdict. Seven checks, each carrying the evidence it decided on.
 *
 * Nothing here is satisfied by a line of stdout. A pass needs a state file that
 * parses, a port read out of it, a process the OS says is alive, and a server
 * on that port that agrees with the file about being headed.
 */
export async function verifySession(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const timeoutMs = opts.healthTimeoutMs ?? 4000;
  const checks = [];
  const add = (name, pass, evidence) => checks.push({ name, pass: Boolean(pass), evidence: String(evidence) });

  const st = opts.state || readState(cwd, env);

  if (!st.file) {
    add("state file found", false, `looked in ${st.searched.length}: ${st.searched.join(", ")}`);
  } else if (st.error) {
    add("state file found", false, `${st.file} exists but does not parse: ${st.error}`);
  } else {
    add("state file found", true, `${st.file} (parsed as JSON, not grepped)`);
  }

  const state = st.state;
  const port = statePort(state);
  add(
    "state file names a port",
    port !== null,
    port !== null
      ? `port ${port}${port === GSTACK_PORT ? " (gstack's pinned port, read not assumed)" : " (NOT 34567 — the assumed value would be wrong)"}`
      : `no usable port in ${st.file || "no state file"}`,
  );

  const mode = state && typeof state.mode === "string" ? state.mode : null;
  add("state file says mode headed", mode === "headed", mode ? `mode = ${mode}` : "no mode in the state file");

  const pid = state ? Number(state.pid) : NaN;
  const alive = pidAlive(pid);
  add(
    "server process is alive",
    alive,
    Number.isInteger(pid) && pid > 0
      ? `pid ${pid} ${alive ? "alive" : "not running"} (asked the OS, not Git Bash)`
      : "no pid in the state file",
  );

  let health = { ok: false, error: "not attempted: no port" };
  if (port !== null) health = await fetchHealth(port, timeoutMs, opts.healthHost || "127.0.0.1");
  add("/health answers on that port", health.ok, health.ok ? `HTTP 200, status=${health.status}, tabs=${health.tabs}` : `no usable answer: ${health.error}`);
  add(
    "/health agrees the browser is headed",
    health.ok && health.mode === "headed",
    health.ok ? `/health mode = ${health.mode}` : "not asked: /health did not answer",
  );

  const ext = opts.extension || resolveExtension(cwd, env);
  if (opts.allowNoExtension) {
    add("sidebar extension is installed and valid", true, `SKIPPED by --allow-no-extension (${ext.usable ? "would have passed" : ext.problems.join("; ")})`);
  } else {
    add("sidebar extension is installed and valid", ext.usable, ext.usable ? `${ext.dir} (via ${ext.via}), manifest ok` : ext.problems.join("; "));
  }

  return { checks, pass: checks.every((c) => c.pass), state: st, health, extension: ext, port };
}

// ------------------------------------------------------------- running browse

/** Run the browse binary, script or exe, with a hard timeout. */
export function runBrowse(bin, args, timeoutMs = 90000) {
  const isScript = /\.(mjs|js|cjs)$/i.test(bin);
  const cmd = isScript ? process.execPath : bin;
  const argv = isScript ? [bin, ...args] : args;
  const r = spawnSync(cmd, argv, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return {
    status: r.status,
    timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
    spawnError: r.error && r.error.code !== "ETIMEDOUT" ? String(r.error.message) : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

/** Chromium leaves these behind after a crash and then refuses the profile. */
export const PROFILE_LOCKS = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];

export function cleanProfileLocks(profileDir) {
  const notes = [];
  for (const name of PROFILE_LOCKS) {
    const p = path.join(profileDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      fs.rmSync(p, { force: true, recursive: false });
    } catch (e) {
      notes.push(`${name} could not be removed: ${e.code || e.message}`);
      continue;
    }
    notes.push(fs.existsSync(p) ? `${name} SURVIVED removal` : `${name} removed`);
  }
  return notes;
}

function profileDir(env = process.env) {
  return env.GSTACK_CHROMIUM_PROFILE || path.join(os.homedir(), ".gstack", "chromium-profile");
}

// ----------------------------------------------------------------------- open

/**
 * Launch, then prove it.
 *
 * The order matters and is the opposite of upstream's. Upstream cleans up
 * (destructively), launches, and checks afterwards by eye. Here everything that
 * can refuse refuses BEFORE a browser window exists, because a visible browser
 * with no sidebar is a window the user has to close by hand for nothing.
 */
export async function openSession(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const lines = [];
  const say = (s) => lines.push(s);

  // -- preflight: the two things that make this skill possible at all
  const resolved = resolveBrowse(cwd);
  if (!resolved.bin) {
    say("REFUSED before launching anything: no browse binary.");
    for (const s of resolved.searched) say(`  looked: ${s}`);
    say("  install gstack's browse (cd <gstack>/browse && ./setup) or set TOOLBAY_BROWSE_BIN.");
    return { ok: false, refused: "no-browse-binary", spawned: false, lines };
  }
  say(`browse binary   ${resolved.bin}  (via ${resolved.via})`);

  const ext = resolveExtension(cwd, env);
  if (!ext.usable && !opts.allowNoExtension) {
    say("REFUSED before launching anything: the sidebar extension is not usable.");
    for (const p of ext.problems) say(`  ${p}`);
    for (const s of ext.searched) say(`  looked: ${s}`);
    say("  a visible browser without the sidebar is the feature missing, not a degraded version of it.");
    say("  pass --allow-no-extension if you genuinely want a plain visible Chromium.");
    return { ok: false, refused: "no-extension", spawned: false, lines, extension: ext };
  }
  say(ext.usable ? `sidebar         ${ext.dir}  (via ${ext.via})` : `sidebar         NOT USABLE, continuing on --allow-no-extension`);

  // -- reclaim: what is already here, and is it alive
  const before = readState(cwd, env);
  const beforePid = before.state ? Number(before.state.pid) : NaN;
  const beforeAlive = pidAlive(beforePid);

  if (before.file && before.error) {
    say(`stale state     ${before.file} does not parse (${before.error}); removing it`);
    try {
      fs.rmSync(before.file, { force: true });
    } catch (e) {
      say(`  could not remove it: ${e.message}`);
    }
  } else if (before.file && !beforeAlive) {
    say(`stale state     ${before.file} names pid ${before.state ? before.state.pid : "?"}, which is not running; removing it`);
    try {
      fs.rmSync(before.file, { force: true });
    } catch (e) {
      say(`  could not remove it: ${e.message}`);
    }
    const survived = cleanProfileLocks(profileDir(env));
    for (const s of survived) say(`  profile lock ${s}`);
  } else if (before.file && beforeAlive && !opts.restart) {
    say(`already running pid ${before.state.pid}, mode ${before.state.mode}; verifying rather than launching a second one`);
    const v = await verifySession({ ...opts, cwd, env, extension: ext });
    return { ok: v.pass, spawned: false, reused: true, lines, verdict: v };
  } else if (before.file && beforeAlive && opts.restart) {
    say(`--restart       stopping pid ${before.state.pid} first`);
    const c = closeSession({ cwd, env, bin: resolved.bin });
    for (const l of c.lines) say(`  ${l}`);
    if (!c.ok) {
      say("REFUSED: the running session would not stop, so a new one would fight it for the profile.");
      return { ok: false, refused: "stop-failed", spawned: false, lines };
    }
  }

  // -- launch
  const t0 = Date.now();
  const run = runBrowse(resolved.bin, ["connect"], opts.connectTimeoutMs ?? 90000);
  say(`connect         exit ${run.status === null ? "(none)" : run.status}${run.timedOut ? " TIMED OUT" : ""} in ${Date.now() - t0}ms`);
  for (const l of String(run.stdout).trim().split("\n").filter(Boolean)) say(`  | ${l}`);
  for (const l of String(run.stderr).trim().split("\n").filter(Boolean)) say(`  ! ${l}`);
  if (run.spawnError) say(`  ! spawn error: ${run.spawnError}`);

  // -- the stale-proof guard: a state file that did not change is not this run
  const after = readState(cwd, env);
  const afterPid = after.state ? Number(after.state.pid) : NaN;
  const unchanged =
    before.file &&
    after.file === before.file &&
    after.mtimeMs === before.mtimeMs &&
    Number.isFinite(beforePid) &&
    beforePid === afterPid;
  if (unchanged && !beforeAlive) {
    say("FAIL: connect produced no new session — the state file is untouched and its pid is dead.");
    return { ok: false, spawned: true, lines, verdict: { pass: false, checks: [], stale: true } };
  }

  const verdict = await verifySession({ ...opts, cwd, env, extension: ext, state: after });
  return { ok: verdict.pass, spawned: true, lines, verdict, run };
}

// ---------------------------------------------------------------------- close

/**
 * Stop the session and only then forget it.
 *
 * This is the direct fix for upstream Step 0. The kill goes through Node so it
 * reaches a Windows pid; death is confirmed by polling the OS; and the state
 * file is removed ONLY once the process is gone. If it will not die, the state
 * file stays, because the record of a process you could not kill is the most
 * useful thing on the disk at that moment.
 */
export function closeSession(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const lines = [];
  const say = (s) => lines.push(s);
  const graceMs = opts.graceMs ?? 4000;
  const stepMs = opts.stepMs ?? 200;
  // Injectable so the selftest can hold a process that refuses to die without
  // needing a real one, and without this function ever being pointed at itself.
  const alive = opts.alive || pidAlive;
  const sendSignal = opts.kill || ((p, sig) => (sig ? process.kill(p, sig) : process.kill(p)));

  const st = readState(cwd, env);
  if (!st.file) {
    say("no state file, so nothing claims to be running");
    for (const s of st.searched) say(`  looked: ${s}`);
    return { ok: true, lines, killed: false };
  }
  if (st.error) {
    say(`${st.file} does not parse (${st.error}); removing it, but no pid could be read from it`);
    try {
      fs.rmSync(st.file, { force: true });
    } catch (e) {
      say(`  could not remove it: ${e.message}`);
    }
    return { ok: true, lines, killed: false };
  }

  const pid = Number(st.state.pid);
  say(`${st.file} names pid ${st.state.pid}`);
  if (!alive(pid)) {
    say(`  pid ${pid} is not running; removing the state file`);
    try {
      fs.rmSync(st.file, { force: true });
    } catch (e) {
      say(`  could not remove it: ${e.message}`);
    }
    for (const s of cleanProfileLocks(profileDir(env))) say(`  profile lock ${s}`);
    return { ok: true, lines, killed: false };
  }

  // Graceful first, through the binary, if there is one.
  const bin = opts.bin || resolveBrowse(cwd).bin;
  if (bin && opts.graceful !== false) {
    const r = runBrowse(bin, ["stop"], 15000);
    say(`  browse stop -> exit ${r.status === null ? "(none)" : r.status}`);
  }

  const waitFor = (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      sleepSync(stepMs);
    }
    return !alive(pid);
  };

  if (!waitFor(graceMs)) {
    say(`  still alive; process.kill(${pid}) — this is the step Git Bash cannot do`);
    try {
      sendSignal(pid);
    } catch (e) {
      say(`  kill failed: ${e.code || e.message}`);
    }
    if (!waitFor(graceMs)) {
      say(`  still alive; process.kill(${pid}, "SIGKILL")`);
      try {
        sendSignal(pid, "SIGKILL");
      } catch (e) {
        say(`  SIGKILL failed: ${e.code || e.message}`);
      }
      waitFor(graceMs);
    }
  }

  if (alive(pid)) {
    say(`  FAILED TO STOP pid ${pid}. Keeping ${st.file} — deleting it now would orphan the browser.`);
    return { ok: false, lines, killed: false };
  }

  say(`  pid ${pid} is gone; removing ${st.file}`);
  try {
    fs.rmSync(st.file, { force: true });
  } catch (e) {
    say(`  could not remove it: ${e.message}`);
  }
  for (const s of cleanProfileLocks(profileDir(env))) say(`  profile lock ${s}`);
  return { ok: true, lines, killed: true };
}

// --------------------------------------------------------------------- doctor

async function doctor() {
  const cwd = process.cwd();
  const out = [];
  out.push("");
  out.push(`  open-gstack-browser doctor   (node ${process.version}, ${process.platform})`);
  out.push("");

  const bin = resolveBrowse(cwd);
  out.push(`  browse binary   ${bin.bin ? `${bin.bin}  (via ${bin.via})` : "NOT FOUND"}`);
  if (!bin.bin) for (const s of bin.searched) out.push(`      looked: ${s}`);

  const ext = resolveExtension(cwd);
  out.push(`  sidebar         ${ext.dir ? `${ext.dir}  (via ${ext.via})` : "NOT FOUND"}`);
  if (ext.dir) out.push(`      manifest      ${ext.usable ? "ok" : "PROBLEMS"}`);
  for (const p of ext.problems) out.push(`      ${p}`);
  if (!ext.dir) for (const s of ext.searched) out.push(`      looked: ${s}`);

  const st = readState(cwd);
  out.push(`  state file      ${st.file || "none"}`);
  if (!st.file) for (const s of st.searched) out.push(`      looked: ${s}`);
  if (st.file && st.error) out.push(`      UNREADABLE: ${st.error}`);
  if (st.state) {
    const port = statePort(st.state);
    out.push(`      pid ${st.state.pid}  ${pidAlive(st.state.pid) ? "alive" : "not running"}`);
    out.push(`      port ${port === null ? "MISSING" : port}   mode ${st.state.mode}`);
    // The delta, stated as a measurement rather than a claim.
    const grepPort = /"port":[0-9]+/.exec(st.raw || "");
    out.push(`      gstack's grep -o '"port":[0-9]*' on these bytes: ${grepPort ? grepPort[0] : "NO MATCH"}`);
    if (port !== null) {
      const h = await fetchHealth(port, 3000);
      out.push(`      /health       ${h.ok ? `200 status=${h.status} mode=${h.mode} tabs=${h.tabs}` : `unusable: ${h.error}`}`);
    }
  }

  const pd = profileDir(process.env);
  const locks = PROFILE_LOCKS.filter((n) => fs.existsSync(path.join(pd, n)));
  out.push(`  profile         ${pd}`);
  out.push(`      locks present ${locks.length ? locks.join(", ") : "none"}`);

  out.push("");
  const ok = Boolean(bin.bin) && ext.usable;
  out.push(ok ? "  READY. `open` can run." : "  NOT READY. `open` will refuse rather than show you a window that does nothing.");
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  process.exitCode = ok ? 0 : 1;
}

// -------------------------------------------------------------------- printing

function printVerdict(v) {
  const width = Math.max(...v.checks.map((c) => c.name.length));
  const out = ["", "  Verdict", ""];
  for (const c of v.checks) out.push(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.evidence}`);
  out.push("");
  out.push(v.pass ? "  VERDICT PASS. A visible browser is up, with the sidebar, on a port read off disk." : "  VERDICT FAIL. Do not tell anyone the browser is open.");
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
}

function sidePanelHelp(ext) {
  const dir = ext && ext.dir ? ext.dir : "<extension directory>";
  const paste = IS_WIN
    ? [
        "     - in the folder picker, click the address bar (or press Ctrl+L)",
        `     - paste: ${dir}`,
        "     - press Enter, then Select Folder",
      ]
    : [
        "     - press Cmd+Shift+G (macOS) or Ctrl+L (Linux) in the file picker",
        `     - paste: ${dir}`,
        "     - click Select",
      ];
  return [
    "",
    "  The Side Panel",
    "",
    "  1. click the puzzle-piece (Extensions) icon in the toolbar",
    "  2. find gstack browse, click the pin",
    "  3. click the pinned icon; the panel opens on the right with a live feed",
    "",
    "  If it is not listed at all, open chrome://extensions, turn on Developer",
    "  mode, click Load unpacked, and:",
    ...paste,
    "",
  ].join("\n");
}

// ------------------------------------------------------------------- selftest

function stubBrowse(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "browse.mjs");
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function healthServer(payload, { code = 200, raw = null } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (raw !== null) {
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(raw);
        return;
      }
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function writeExtension(dir, { manifest, files = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2), "utf8");
  }
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return dir;
}

const GOOD_MANIFEST = {
  manifest_version: 3,
  name: "gstack browse",
  version: "0.1.0",
  side_panel: { default_path: "sidepanel.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], css: ["content.css"] }],
};
const GOOD_FILES = {
  "sidepanel.html": "<!doctype html>",
  "background.js": "//",
  "content.js": "//",
  "content.css": "/**/",
};

/** The exact bytes the running browse server writes. Pretty-printed, spaces after colons. */
function realStateBytes({ pid, port = GSTACK_PORT, mode = "headed" }) {
  return JSON.stringify(
    {
      pid,
      port,
      token: "5a2399db-41cf-4f29-85d8-1f8a9a8ac443",
      startedAt: "2026-08-17T20:32:39.777Z",
      serverPath: "C:\\Users\\orion\\.claude\\skills\\gstack\\browse\\src\\server.ts",
      mode,
      configHash: "303a7eeccc03078b",
    },
    null,
    2,
  );
}

async function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-openbrowser-"));
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    TOOLBAY_BROWSE_BIN: process.env.TOOLBAY_BROWSE_BIN,
    TOOLBAY_GSTACK_EXTENSION: process.env.TOOLBAY_GSTACK_EXTENSION,
    TOOLBAY_BROWSE_STATE: process.env.TOOLBAY_BROWSE_STATE,
    GSTACK_CHROMIUM_PROFILE: process.env.GSTACK_CHROMIUM_PROFILE,
  };
  const servers = [];
  const spawned = [];

  try {
    // The same sandboxing the shared resolver's selftest needs, for the same
    // reason: this machine has a real gstack install in HOME and a stray git
    // repository above os.tmpdir(), and negative cases that only hold on a
    // machine without them prove nothing.
    const fakeHome = path.join(tmp, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.GIT_CEILING_DIRECTORIES = tmp;
    process.env.GSTACK_CHROMIUM_PROFILE = path.join(tmp, "profile");
    fs.mkdirSync(process.env.GSTACK_CHROMIUM_PROFILE, { recursive: true });
    delete process.env.TOOLBAY_BROWSE_BIN;
    delete process.env.TOOLBAY_GSTACK_EXTENSION;
    delete process.env.TOOLBAY_BROWSE_STATE;

    const work = path.join(tmp, "work");
    fs.mkdirSync(work, { recursive: true });

    // ---------------------------------------------------------- A. the parse
    const stateDir = path.join(fakeHome, ".gstack", "browse");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "browse.json");
    const bytes = realStateBytes({ pid: process.pid });
    fs.writeFileSync(stateFile, bytes, "utf8");

    const st1 = readState(work, process.env);
    check("the file the server really writes is found", path.resolve(stateFile), String(st1.file), JSON.stringify(st1.searched));
    check("...and its port is read", GSTACK_PORT, String(statePort(st1.state)));
    check("...and its pid is read", process.pid, String(st1.state.pid));

    // The documented delta, asserted rather than claimed.
    check("gstack's own grep -o '\"port\":[0-9]*' finds nothing in those bytes", "null", String(/"port":[0-9]+/.exec(bytes)));
    check("gstack's own grep -o '\"pid\":[0-9]*' finds nothing either", "null", String(/"pid":[0-9]+/.exec(bytes)));

    // That fixture names THIS process as the server. It has done its job, and a
    // later close() test that fell through to it would point a real kill at the
    // selftest itself, so it is removed the moment it is finished with.
    fs.rmSync(stateFile, { force: true });
    check("the home fixture is gone before anything can be killed", false, fs.existsSync(stateFile));

    // A repo-root state file, gstack's documented location, still wins.
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".gstack"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(path.join(repo, ".gstack", "browse.json"), realStateBytes({ pid: process.pid, port: 41111 }), "utf8");
    const st2 = readState(repo, process.env);
    check("a repo-root state file (gstack's location) wins when both exist", path.resolve(path.join(repo, ".gstack", "browse.json")), String(st2.file));
    check("...and the port comes from the FILE, not from 34567", "41111", String(statePort(st2.state)));

    // Unreadable is not the same fact as absent.
    const badDir = path.join(tmp, "badstate");
    fs.mkdirSync(path.join(badDir, ".gstack"), { recursive: true });
    fs.writeFileSync(path.join(badDir, ".gstack", "browse.json"), "{ this is not json", "utf8");
    const st3 = readState(badDir, process.env);
    check("a state file that does not parse is reported unreadable, not absent", true, Boolean(st3.file && st3.error), String(st3.error));

    check("a state object with no port yields null, never a default", "null", String(statePort({ pid: 1, mode: "headed" })));

    // ------------------------------------------------------- B. the extension
    const extGood = writeExtension(path.join(tmp, "ext-good"), { manifest: GOOD_MANIFEST, files: GOOD_FILES });
    check("a complete extension is usable", true, inspectExtension(extGood).usable, inspectExtension(extGood).problems.join("; "));

    const extBadJson = writeExtension(path.join(tmp, "ext-badjson"), { manifest: "{ nope", files: GOOD_FILES });
    check("a manifest that is not JSON is refused", false, inspectExtension(extBadJson).usable);

    const noPanel = { ...GOOD_MANIFEST };
    delete noPanel.side_panel;
    const extNoPanel = writeExtension(path.join(tmp, "ext-nopanel"), { manifest: noPanel, files: GOOD_FILES });
    check("a manifest with no side_panel is refused (the sidebar is the point)", false, inspectExtension(extNoPanel).usable);

    const filesNoPanelHtml = { ...GOOD_FILES };
    delete filesNoPanelHtml["sidepanel.html"];
    const extMissingHtml = writeExtension(path.join(tmp, "ext-missinghtml"), { manifest: GOOD_MANIFEST, files: filesNoPanelHtml });
    check("side_panel pointing at a file that is not on disk is refused", false, inspectExtension(extMissingHtml).usable);

    const filesNoWorker = { ...GOOD_FILES };
    delete filesNoWorker["background.js"];
    const extNoWorker = writeExtension(path.join(tmp, "ext-noworker"), { manifest: GOOD_MANIFEST, files: filesNoWorker });
    check("a missing service worker is refused", false, inspectExtension(extNoWorker).usable);

    const filesNoContent = { ...GOOD_FILES };
    delete filesNoContent["content.js"];
    const extNoContent = writeExtension(path.join(tmp, "ext-nocontent"), { manifest: GOOD_MANIFEST, files: filesNoContent });
    check("a missing content script is refused", false, inspectExtension(extNoContent).usable);

    const extMv2 = writeExtension(path.join(tmp, "ext-mv2"), { manifest: { ...GOOD_MANIFEST, manifest_version: 2 }, files: GOOD_FILES });
    check("an MV2 manifest is refused", false, inspectExtension(extMv2).usable);

    const extDirTrap = path.join(tmp, "ext-trap");
    fs.mkdirSync(path.join(extDirTrap, "manifest.json"), { recursive: true });
    check("a DIRECTORY named manifest.json is not a manifest", false, inspectExtension(extDirTrap).usable);

    check("no extension anywhere is not usable", false, inspectExtension(path.join(tmp, "nothing-here")).usable);

    // The marker gstack does not check.
    const agentsRoot = path.join(tmp, "agentsroot");
    const agentsExt = path.join(agentsRoot, ".agents", "skills", "gstack", "extension");
    writeExtension(agentsExt, { manifest: GOOD_MANIFEST, files: GOOD_FILES });
    const foundAgents = resolveExtension(agentsRoot, process.env);
    check("an extension under .agents is found (gstack only looks in .claude)", path.resolve(agentsExt), String(foundAgents.dir), JSON.stringify(foundAgents.searched));
    check("...and is reported usable", true, foundAgents.usable);

    const nowhere = resolveExtension(path.join(tmp, "empty-root"), process.env);
    check("a machine with no extension resolves to null", "null", String(nowhere.dir));
    check("...and still lists where it looked", true, nowhere.searched.length > 0);

    // ---------------------------------------------------------- C. the verdict
    const sess = path.join(tmp, "verdict");
    fs.mkdirSync(path.join(sess, ".gstack"), { recursive: true });
    const sessState = path.join(sess, ".gstack", "browse.json");
    const envWith = (file) => ({ ...process.env, TOOLBAY_BROWSE_STATE: file, TOOLBAY_GSTACK_EXTENSION: extGood });

    const good = await healthServer({ status: "healthy", mode: "headed", tabs: 1 });
    servers.push(good.srv);
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: good.port, mode: "headed" }), "utf8");
    const vGood = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("a genuinely healthy headed session PASSES (positive control)", true, vGood.pass, vGood.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.evidence}`).join(" | "));

    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: good.port, mode: "headless" }), "utf8");
    const vHeadless = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("a HEADLESS session fails the headed verdict", false, vHeadless.pass);

    // A dead pid. 2**31-1 is above the Windows and Linux pid ranges in use.
    fs.writeFileSync(sessState, realStateBytes({ pid: 2147483647, port: good.port, mode: "headed" }), "utf8");
    const vDead = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("mode headed with a DEAD pid fails", false, vDead.pass);
    check("...and the failing check is named", true, vDead.checks.some((c) => !c.pass && c.name === "server process is alive"));

    // Nothing listening at all.
    const dead = await healthServer({});
    const deadPort = dead.port;
    await new Promise((r) => dead.srv.close(r));
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: deadPort, mode: "headed" }), "utf8");
    const vNoHealth = await verifySession({ cwd: sess, env: envWith(sessState), healthTimeoutMs: 1500 });
    check("a state file that says headed with NOTHING listening fails", false, vNoHealth.pass);

    const un = await healthServer(null, { code: 401, raw: '{"error":"Unauthorized"}' });
    servers.push(un.srv);
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: un.port, mode: "headed" }), "utf8");
    const v401 = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("a 401 from /health is not treated as up", false, v401.pass);

    const html = await healthServer(null, { code: 200, raw: "<!doctype html><h1>hi</h1>" });
    servers.push(html.srv);
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: html.port, mode: "headed" }), "utf8");
    const vHtml = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("a 200 that is not JSON is not treated as up", false, vHtml.pass);

    const lying = await healthServer({ status: "healthy", mode: "headless", tabs: 1 });
    servers.push(lying.srv);
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: lying.port, mode: "headed" }), "utf8");
    const vDisagree = await verifySession({ cwd: sess, env: envWith(sessState) });
    check("state file and /health DISAGREEING about headed fails", false, vDisagree.pass);

    // The extension is part of the verdict.
    fs.writeFileSync(sessState, realStateBytes({ pid: process.pid, port: good.port, mode: "headed" }), "utf8");
    const vNoExt = await verifySession({ cwd: sess, env: { ...process.env, TOOLBAY_BROWSE_STATE: sessState, TOOLBAY_GSTACK_EXTENSION: extNoPanel } });
    check("a healthy headed browser with a BROKEN sidebar still fails", false, vNoExt.pass);
    const vNoExtAllowed = await verifySession({
      cwd: sess,
      env: { ...process.env, TOOLBAY_BROWSE_STATE: sessState, TOOLBAY_GSTACK_EXTENSION: extNoPanel },
      allowNoExtension: true,
    });
    check("...unless --allow-no-extension is passed explicitly", true, vNoExtAllowed.pass);

    // ------------------------------------------------------------- D. open()
    // resolveBrowse reads process.env directly (it is the shared, byte-identical
    // resolver and does not take an env argument), so these have to be set on
    // the real environment. Everything is restored in the finally block.
    const setEnv = (o) => {
      for (const [k, v] of Object.entries(o)) {
        if (v === null) delete process.env[k];
        else process.env[k] = v;
      }
    };

    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const marker = path.join(tmp, "STUB-RAN");

    // No binary at all: refuse, and never spawn.
    setEnv({ TOOLBAY_BROWSE_BIN: path.join(tmp, "no-such-browse"), TOOLBAY_GSTACK_EXTENSION: extGood, TOOLBAY_BROWSE_STATE: null });
    const rNoBin = await openSession({ cwd: path.join(tmp, "empty-root") });
    check("open REFUSES with no browse binary", "no-browse-binary", String(rNoBin.refused));
    check("...and never spawned anything", false, rNoBin.spawned);

    // Extension broken: refuse BEFORE launching. The stub writes a marker file
    // if it is ever run, so "never spawned" is a fact on disk, not a promise.
    const stubMarker = stubBrowse(
      binDir,
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran", "utf8");\nconsole.log("Mode: headed");\n`,
    );
    setEnv({ TOOLBAY_BROWSE_BIN: stubMarker, TOOLBAY_GSTACK_EXTENSION: extNoPanel });
    const rNoExt = await openSession({ cwd: work });
    check("open REFUSES when the sidebar extension is unusable", "no-extension", String(rNoExt.refused));
    check("...and the browser was never launched (no marker on disk)", false, fs.existsSync(marker));

    // stdout is not evidence: prints the magic line, writes no state file.
    const openState = path.join(tmp, "opendir-browse.json");
    const liar = stubBrowse(
      path.join(tmp, "bin-liar"),
      `console.log("Launching headed Chromium with extension + terminal agent...");\nconsole.log("Status: healthy");\nconsole.log("Mode: headed");\n`,
    );
    setEnv({ TOOLBAY_BROWSE_BIN: liar, TOOLBAY_GSTACK_EXTENSION: extGood, TOOLBAY_BROWSE_STATE: openState });
    const rLiar = await openSession({ cwd: work, connectTimeoutMs: 15000 });
    check('a stub that prints "Mode: headed" and writes no state file FAILS', false, rLiar.ok);

    // exit 127, the shape `$B connect` takes when B never survived the shell.
    const b127 = stubBrowse(path.join(tmp, "bin-127"), `console.error("connect: command not found");\nprocess.exit(127);\n`);
    setEnv({ TOOLBAY_BROWSE_BIN: b127 });
    const r127 = await openSession({ cwd: work, connectTimeoutMs: 15000 });
    check("a browse that exits 127 FAILS with a verdict, not silence", false, r127.ok);
    check("...and the verdict names checks", true, Boolean(r127.verdict && r127.verdict.checks.length > 0));

    // A hang must not become a pass by timing out quietly.
    const bHang = stubBrowse(path.join(tmp, "bin-hang"), `setTimeout(() => {}, 60000);\n`);
    setEnv({ TOOLBAY_BROWSE_BIN: bHang });
    const rHang = await openSession({ cwd: work, connectTimeoutMs: 1500 });
    check("a browse that hangs FAILS on the timeout", false, rHang.ok);

    // A stale state file from an earlier run is not this run's proof.
    const staleState = path.join(tmp, "stale-browse.json");
    fs.writeFileSync(staleState, realStateBytes({ pid: 2147483647, port: good.port, mode: "headed" }), "utf8");
    const noop = stubBrowse(path.join(tmp, "bin-noop"), `console.log("Mode: headed");\n`);
    setEnv({ TOOLBAY_BROWSE_BIN: noop, TOOLBAY_BROWSE_STATE: staleState });
    const rStale = await openSession({ cwd: work, connectTimeoutMs: 15000 });
    check("a STALE headed state file from an earlier run is not this run's proof", false, rStale.ok);

    // A stub that behaves: writes a real state file pointing at a live server.
    const okState = path.join(tmp, "ok-browse.json");
    const okStub = stubBrowse(
      path.join(tmp, "bin-ok"),
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(okState)}, JSON.stringify({ pid: ${process.pid}, port: ${good.port}, mode: "headed" }, null, 2), "utf8");\n` +
        `console.log("Mode: headed");\n`,
    );
    setEnv({ TOOLBAY_BROWSE_BIN: okStub, TOOLBAY_BROWSE_STATE: okState });
    const rOk = await openSession({ cwd: work, connectTimeoutMs: 15000 });
    check(
      "a browse that really does open a headed session PASSES (positive control)",
      true,
      rOk.ok,
      rOk.verdict ? rOk.verdict.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.evidence}`).join(" | ") : String(rOk.refused),
    );

    // ------------------------------------------------------------ E. close()
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { detached: true, stdio: "ignore" });
    child.unref();
    spawned.push(child.pid);
    const closeState = path.join(tmp, "close-browse.json");
    fs.writeFileSync(closeState, realStateBytes({ pid: child.pid, port: good.port, mode: "headed" }), "utf8");
    check("the process to be closed is alive to start with", true, pidAlive(child.pid));
    setEnv({ TOOLBAY_BROWSE_STATE: closeState });
    const closed = closeSession({ cwd: work, bin: null, graceful: false, graceMs: 6000, stepMs: 100 });
    check("close actually kills a live Windows pid (Git Bash kill cannot)", false, pidAlive(child.pid), closed.lines.join(" / "));
    check("...and removes the state file only after it is dead", false, fs.existsSync(closeState));

    // The orphan case. A process that refuses to die is simulated rather than
    // created, so this test can never point a real SIGKILL at anything: alive()
    // always says yes and kill() does nothing.
    const unkillable = path.join(tmp, "unkillable.json");
    fs.writeFileSync(unkillable, realStateBytes({ pid: 4242, port: good.port, mode: "headed" }), "utf8");
    setEnv({ TOOLBAY_BROWSE_STATE: unkillable });
    const stubborn = closeSession({
      cwd: work,
      bin: null,
      graceful: false,
      graceMs: 200,
      stepMs: 50,
      alive: () => true,
      kill: () => {},
    });
    check("a process that will not die is reported as a FAILURE to stop", false, stubborn.ok, stubborn.lines.join(" / "));
    check("...and its state file is KEPT, because deleting it is what orphans the browser", true, fs.existsSync(unkillable));

    setEnv({ TOOLBAY_BROWSE_STATE: path.join(tmp, "no-state.json") });
    const gone = closeSession({ cwd: work, bin: null });
    check("close with no state file says so and exits clean", true, gone.ok);
    setEnv({ TOOLBAY_BROWSE_BIN: null, TOOLBAY_GSTACK_EXTENSION: null, TOOLBAY_BROWSE_STATE: null });

    // ------------------------------------------------------ F. shared resolver
    const mine = path.join(HERE, "tb-browse-bin.mjs");
    const siblings = [
      path.resolve(HERE, "..", "..", "..", "src", "browse-bin", "tb-browse-bin.mjs"),
      path.resolve(HERE, "..", "..", "browse", "scripts", "tb-browse-bin.mjs"),
    ].filter((p) => fs.existsSync(p));
    const mineBytes = fs.readFileSync(mine);
    for (const s of siblings) {
      check(`tb-browse-bin.mjs is byte-identical to ${path.relative(path.resolve(HERE, "..", "..", ".."), s).replace(/\\/g, "/")}`, true, mineBytes.equals(fs.readFileSync(s)));
    }
    check("the shared resolver was found beside this engine", true, fs.existsSync(mine));
  } finally {
    for (const s of servers) {
      try {
        s.close();
      } catch {
        /* housekeeping */
      }
    }
    for (const pid of spawned) {
      try {
        if (pidAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        /* housekeeping */
      }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a leftover temp directory is not the story */
    }
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  open-gstack-browser selftest  (node ${process.version}, ${process.platform})\n\n`);
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
    return;
  }
  process.stdout.write(
    "\n  Every lie above is one this skill is told on a real machine: a state file\n" +
      "  in the other place, a port the regex cannot see, a pid Git Bash cannot\n" +
      "  reach, a sidebar that is not installed, and stdout that says headed after\n" +
      "  the browser is gone. None of them can produce a pass.\n\n",
  );
}

// ------------------------------------------------------------------------ CLI

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flag = (n) => rest.includes(n);

  if (cmd === "selftest") return selftest();
  if (cmd === "doctor") return doctor();

  if (cmd === "verify") {
    const v = await verifySession({ allowNoExtension: flag("--allow-no-extension") });
    printVerdict(v);
    process.exitCode = v.pass ? 0 : 1;
    return;
  }

  if (cmd === "open") {
    const r = await openSession({
      allowNoExtension: flag("--allow-no-extension"),
      restart: flag("--restart"),
    });
    process.stdout.write("\n" + r.lines.map((l) => `  ${l}`).join("\n") + "\n");
    if (r.verdict && r.verdict.checks && r.verdict.checks.length) printVerdict(r.verdict);
    if (r.ok) process.stdout.write(sidePanelHelp(r.verdict && r.verdict.extension) + "\n");
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (cmd === "close") {
    const r = closeSession({});
    process.stdout.write("\n" + r.lines.map((l) => `  ${l}`).join("\n") + "\n\n");
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  process.stdout.write("\n  usage: tb-openbrowser.mjs doctor | open [--restart] [--allow-no-extension] | verify | close | selftest\n\n");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`\n  tb-openbrowser failed: ${e && e.stack ? e.stack : e}\n\n`);
    process.exitCode = 1;
  });
}
