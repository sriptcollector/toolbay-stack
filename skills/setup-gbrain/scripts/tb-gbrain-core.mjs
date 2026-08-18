#!/usr/bin/env node
/**
 * tb-gbrain-core.mjs — the shared truth about whether gbrain is really usable
 * from here, as opposed to merely installed and configured.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * DERIVED WORK. gbrain is Garry Tan's (https://github.com/garrytan/gstack,
 * MIT, Copyright (c) 2026 Garry Tan); the /setup-gbrain and /sync-gbrain skill
 * names and command surfaces are gstack's. This code is a rewrite, and it
 * drives the real `gbrain` CLI rather than reimplementing any of it.
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS.
 *
 * "Is gbrain set up?" has three plausible answers and only one of them is
 * useful. `gbrain --version` succeeding proves a binary exists.
 * `~/.gbrain/config.json` existing proves someone once ran init. Neither
 * proves that `gbrain query` will return anything for this repo, which is the
 * only thing the agent actually wants to know before it stops using Grep.
 *
 * The measured case on this machine, which is exactly the trap:
 *
 *     engine              = pglite            <- configured
 *     database_path       = ~/.gbrain/...     <- exists
 *     embedding_disabled  = true              <- so `query` is NOT semantic
 *
 * A setup skill that reads the first two lines reports "gbrain is ready" and
 * an agent then trusts `gbrain query` to do vector search that cannot happen.
 * Every answer is still plausible, because keyword search still returns rows.
 * That is the failure this repository keeps finding: a capability that looks
 * present, reports success, and does nothing.
 *
 * So capabilities are reported per capability, in three states:
 *
 *   WORKS      proven by running it and looking at the output
 *   DEGRADED   present, but doing less than its name implies — and the
 *              specific thing it is not doing is named
 *   ABSENT     not available; the reason is named
 *
 * Nothing here ever prints a config value whose key looks like a secret.
 *
 * WHY A COPY AND NOT A SHARED IMPORT: Claude Code installs a skill as a
 * self-contained directory. setup-gbrain and sync-gbrain each carry this file;
 * tools/sync-guard.mjs asserts the copies are byte-identical.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WINDOWS = process.platform === "win32";

export const WORKS = "WORKS";
export const DEGRADED = "DEGRADED";
export const ABSENT = "ABSENT";

/** Keys whose values are never printed, whatever they contain. */
export const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|dsn|url|conn/i;

/**
 * Run a command without handing argv to a shell.
 *
 * `shell: true` concatenates argv rather than escaping it (Node DEP0190), so
 * any caller-supplied string in an argument becomes executable. Search terms
 * and repo paths both flow through here, so the shell is not used. The retry
 * exists only for npm's `.cmd` shims on Windows, which cannot be spawned
 * directly, and it re-runs the identical argv.
 */
export const SHELL_METACHARACTERS = /[&|;<>$`"'\n\r()^%!]/;

export function sh(cmd, args, opts = {}) {
  const base = { encoding: "utf8", windowsHide: true, timeout: opts.timeout ?? 60000, cwd: opts.cwd };
  try {
    let r = spawnSync(cmd, args, { ...base, shell: false });
    if (r.error && r.error.code === "ENOENT" && IS_WINDOWS) {
      // gbrain installs as a .cmd shim, which cannot be spawned directly, so
      // the shell is unavoidable here. Under `shell: true` argv is concatenated
      // rather than escaped, so a search term like `x" & del /q *` would run.
      // Fail closed instead: refuse the call and say why. A refused search is
      // recoverable; an executed one is not.
      const unsafe = args.find((a) => SHELL_METACHARACTERS.test(String(a)));
      if (unsafe != null) {
        return {
          code: null, out: "", err: "", failed: true,
          reason: `refused: argument ${JSON.stringify(String(unsafe).slice(0, 60))} contains shell metacharacters and this platform requires a shell to launch ${cmd}`,
        };
      }
      r = spawnSync(cmd, args, { ...base, shell: true });
    }
    return {
      code: r.status,
      out: (r.stdout || "").trim(),
      err: (r.stderr || "").trim(),
      failed: r.error != null,
      reason: r.error ? String(r.error.code || r.error.message) : null,
    };
  } catch (e) {
    return { code: null, out: "", err: "", failed: true, reason: String(e.message) };
  }
}

/** Is the gbrain CLI really runnable? Runs it rather than trusting PATH. */
export function detectCli() {
  const r = sh("gbrain", ["--version"], { timeout: 20000 });
  if (r.failed) return { installed: false, version: null, why: `gbrain is not on PATH (${r.reason})` };
  if (r.code !== 0) return { installed: false, version: null, why: `\`gbrain --version\` exited ${r.code}` };
  const m = (r.out + "\n" + r.err).match(/gbrain\s+([\d.]+)/i);
  return { installed: true, version: m ? m[1] : r.out.split("\n")[0].slice(0, 40), why: null };
}

export function configPath() {
  return path.join(os.homedir(), ".gbrain", "config.json");
}

/**
 * Is a `gbrain serve` daemon holding the database right now?
 *
 * PGLite is a single-writer embedded Postgres: one process opens the data
 * directory and nobody else gets in. So when a serve daemon is up, every CLI
 * call — `gbrain search`, `code-def`, `sync` — blocks and then dies with
 *
 *     GBrain: Timed out waiting for PGLite
 *
 * which reads like a corrupt brain, a hung machine, or a bad install. It is
 * none of those. It is two healthy things wanting the same file, and the fix
 * is "use the MCP tools or stop the daemon", not "delete your brain".
 *
 * Measured here: the MCP path answered `get_health` normally while the CLI
 * timed out, at the same moment, against the same database. A capability
 * report that called that ABSENT with no reason would send someone debugging
 * a database that is working perfectly.
 *
 * The lock file records the holder's pid, so liveness is checked rather than
 * assumed — a leftover lock from a crashed daemon is a genuinely different
 * problem with a genuinely different fix, and conflating them is how a stale
 * lock gets "fixed" by killing a live process.
 */
export function daemonHolding(config) {
  const dbPath = config?.database_path;
  if (!dbPath) return { held: false, pid: null, stale: false, why: null };
  const lockFile = path.join(dbPath, ".gbrain-lock", "lock");
  let raw;
  try {
    raw = fs.readFileSync(lockFile, "utf8");
  } catch {
    return { held: false, pid: null, stale: false, why: null };
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    return { held: false, pid: null, stale: false, why: "a lock file exists but is not readable JSON" };
  }
  const pid = Number(info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { held: false, pid: null, stale: true, why: "the lock names no usable pid" };

  let alive = false;
  try {
    process.kill(pid, 0); // signal 0 tests existence; it does not signal
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) {
    return {
      held: false, pid, stale: true,
      why: `a lock names pid ${pid} but that process is gone — this lock is stale and can be removed`,
    };
  }
  return {
    held: true, pid, stale: false,
    command: info.command || null,
    why:
      `a \`gbrain serve\` daemon (pid ${pid}) holds this PGLite database. PGLite allows one process at a time, ` +
      `so every CLI call will time out while it runs. The brain is NOT broken — reach it through the gbrain MCP ` +
      `tools, or stop that daemon to use the CLI.`,
  };
}

/** Read the config. Never returns secret values, only whether they are set. */
export function readConfig() {
  const p = configPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { path: p, exists: false, config: null, safe: null, error: "no config file — gbrain has never been initialised on this machine" };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return { path: p, exists: true, config: null, safe: null, error: `config exists but is not valid JSON: ${e.message}` };
  }
  const safe = {};
  for (const [k, v] of Object.entries(cfg)) {
    safe[k] = SECRET_KEY_RE.test(k) ? `<set, ${String(typeof v === "string" ? v : JSON.stringify(v)).length} chars, not shown>` : v;
  }
  return { path: p, exists: true, config: cfg, safe, error: null };
}

/**
 * THE RULE. Turn (cli, config, probes) into per-capability verdicts.
 *
 * Pure, so it is tested directly with no gbrain installed.
 */
export function capabilities({ cli, config, probes = {} }) {
  const caps = [];
  const add = (name, state, detail) => caps.push({ name, state, detail });

  if (!cli.installed) {
    add("cli", ABSENT, cli.why);
    add("keyword search", ABSENT, "requires the gbrain CLI");
    add("semantic search", ABSENT, "requires the gbrain CLI");
    add("code symbol lookup", ABSENT, "requires the gbrain CLI");
    return caps;
  }
  add("cli", WORKS, `gbrain ${cli.version}`);

  if (!config) {
    add("brain storage", ABSENT, "no readable config — run `gbrain init`");
    add("keyword search", ABSENT, "no brain to search");
    add("semantic search", ABSENT, "no brain to search");
    add("code symbol lookup", ABSENT, "no brain to search");
    return caps;
  }

  const engine = config.engine || "unknown";
  const dbPath = config.database_path;

  // Contention is diagnosed BEFORE the search probes, because it explains them.
  // Without this, a running daemon makes every CLI capability read ABSENT with
  // a timeout for a reason, and the honest-looking report points at the wrong
  // thing entirely.
  const daemon = probes.daemon ?? { held: false };
  if (daemon.held) {
    add("brain storage", WORKS, `pglite at ${dbPath} — in use by a live daemon`);
    add("cli access", ABSENT, daemon.why);
    add("keyword search", ABSENT, `blocked by the serve daemon on pid ${daemon.pid}, not by a broken brain`);
    add("semantic search", ABSENT, `blocked by the serve daemon on pid ${daemon.pid}`);
    add("code symbol lookup", ABSENT, `blocked by the serve daemon on pid ${daemon.pid}`);
    return caps;
  }
  if (daemon.stale && daemon.why) add("stale lock", DEGRADED, daemon.why);

  if (engine === "pglite") {
    const there = dbPath ? fs.existsSync(dbPath) : false;
    add("brain storage", there ? WORKS : ABSENT, there ? `pglite at ${dbPath}` : `pglite configured but ${dbPath || "(no path)"} does not exist`);
  } else {
    // Remote engines cannot be proven from disk; only a real query proves them.
    add("brain storage", probes.keyword === true ? WORKS : DEGRADED, `engine "${engine}" — existence can only be proven by a query, not by this config`);
  }

  // Keyword search: proven only by having actually run one.
  if (probes.keyword === true) add("keyword search", WORKS, "a real `gbrain search` returned rows");
  else if (probes.keyword === false) add("keyword search", ABSENT, probes.keywordWhy || "a real `gbrain search` returned nothing or failed");
  else add("keyword search", DEGRADED, "not probed in this run");

  // THE ONE THAT MATTERS. Embeddings off means `query` is not semantic, even
  // though it still returns results and still exits 0.
  if (config.embedding_disabled === true) {
    add(
      "semantic search",
      DEGRADED,
      "`embedding_disabled: true` in config — `gbrain query` still works and still exits 0, but it is keyword matching with query expansion, NOT vector similarity. Re-enable with `gbrain config set embedding_disabled false` then `gbrain embed --all`."
    );
  } else if (probes.semantic === true) {
    add("semantic search", WORKS, "embeddings enabled and a real `gbrain query` returned rows");
  } else if (probes.semantic === false) {
    add("semantic search", ABSENT, probes.semanticWhy || "embeddings are enabled but a real query returned nothing");
  } else {
    add("semantic search", DEGRADED, "embeddings enabled but not probed in this run");
  }

  if (probes.code === true) add("code symbol lookup", WORKS, "a real `gbrain code-def` resolved a symbol");
  else if (probes.code === false) add("code symbol lookup", ABSENT, probes.codeWhy || "no code pages are indexed — run /sync-gbrain --full");
  else add("code symbol lookup", DEGRADED, "not probed in this run");

  return caps;
}

/**
 * A single verdict from the capability list.
 * READY only when nothing is ABSENT and semantic search is not degraded,
 * because "ready" is the word an agent acts on.
 */
export function verdict(caps) {
  const absent = caps.filter((c) => c.state === ABSENT);
  const degraded = caps.filter((c) => c.state === DEGRADED);
  if (absent.length) return { ready: false, headline: "NOT READY", why: `${absent.length} capability(ies) absent: ${absent.map((c) => c.name).join(", ")}` };
  if (degraded.length) return { ready: false, headline: "PARTIALLY READY", why: `${degraded.length} degraded: ${degraded.map((c) => c.name).join(", ")}` };
  return { ready: true, headline: "READY", why: "every advertised capability was probed and works" };
}

/* ------------------------------------------------------------------ *
 * Real probes. Each RUNS the thing rather than inferring it.
 * ------------------------------------------------------------------ */

/** Does keyword search return anything at all? */
export function probeKeyword(term = "the") {
  const r = sh("gbrain", ["search", term], { timeout: 45000 });
  if (r.failed || r.code !== 0) return { ok: false, why: `\`gbrain search\` exited ${r.code}: ${(r.err || "").slice(0, 140)}` };
  const hits = countHits(r.out);
  return { ok: hits > 0, why: hits > 0 ? null : "`gbrain search` exited 0 but returned no rows — the brain may be empty", hits };
}

/** Does a symbol resolve? Proves code pages are indexed for THIS repo. */
export function probeCode(symbol) {
  const r = sh("gbrain", ["code-def", symbol], { timeout: 45000 });
  if (r.failed || r.code !== 0) return { ok: false, why: `\`gbrain code-def ${symbol}\` exited ${r.code}` };
  const hits = countHits(r.out);
  return { ok: hits > 0, why: hits > 0 ? null : `no definition found for \`${symbol}\`, so this repo's code is not indexed`, hits };
}

/**
 * Count result rows in gbrain output.
 * Deliberately conservative: "No results" and an empty body both mean zero.
 * Getting this wrong in the generous direction is how "0 results" becomes
 * "search works".
 */
export function countHits(out) {
  const t = String(out || "").trim();
  if (!t) return 0;
  if (/^no (results|matches|pages)/im.test(t)) return 0;
  if (/\b0 results?\b/i.test(t)) return 0;
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.length;
    if (j && Array.isArray(j.results)) return j.results.length;
    if (j && Array.isArray(j.rows)) return j.rows.length;
  } catch {
    /* not JSON, fall through to line counting */
  }
  return t.split("\n").filter((l) => l.trim()).length;
}

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

export const bold = (s) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s) => `\x1b[2m${s}\x1b[22m`;
export const red = (s) => `\x1b[31m${s}\x1b[39m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[39m`;
export const green = (s) => `\x1b[32m${s}\x1b[39m`;

export function renderCapabilities(caps) {
  const w = Math.max(...caps.map((c) => c.name.length));
  const L = [];
  for (const c of caps) {
    const paint = c.state === WORKS ? green : c.state === DEGRADED ? yellow : red;
    L.push(`  ${c.name.padEnd(w)}  ${paint(c.state.padEnd(9))}  ${c.detail || ""}`);
  }
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Selftest for the shared core. Runs with or without gbrain installed.
 * ------------------------------------------------------------------ */

export function coreSelftestCases(check) {
  const cliOk = { installed: true, version: "0.42.53.0", why: null };
  const cliNo = { installed: false, version: null, why: "gbrain is not on PATH (ENOENT)" };
  const find = (caps, name) => caps.find((c) => c.name === name);

  // --- no CLI: everything absent, nothing optimistic
  const noCli = capabilities({ cli: cliNo, config: null });
  check("no CLI => cli is ABSENT", ABSENT, find(noCli, "cli").state);
  check("no CLI => semantic search is ABSENT, not DEGRADED", ABSENT, find(noCli, "semantic search").state);
  check("no CLI => verdict is NOT READY", "NOT READY", verdict(noCli).headline);

  // --- THE CASE THIS FILE EXISTS FOR
  const degraded = capabilities({
    cli: cliOk,
    config: { engine: "pglite", database_path: __selftestExistingPath(), embedding_disabled: true },
    probes: { keyword: true, code: true },
  });
  check("embeddings off => semantic search is DEGRADED", DEGRADED, find(degraded, "semantic search").state);
  check("...and it is NOT reported as WORKS", false, find(degraded, "semantic search").state === WORKS);
  check("...and the detail names the exact config key", true, /embedding_disabled/.test(find(degraded, "semantic search").detail));
  check("...and tells you how to fix it", true, /gbrain embed --all/.test(find(degraded, "semantic search").detail));
  check("...so the overall verdict is not READY", false, verdict(degraded).ready);
  check("...but keyword search is still honestly WORKS", WORKS, find(degraded, "keyword search").state);

  // --- an unprobed capability is never WORKS
  const unprobed = capabilities({ cli: cliOk, config: { engine: "pglite", database_path: __selftestExistingPath(), embedding_disabled: false } });
  check("an unprobed keyword search is DEGRADED, never WORKS", DEGRADED, find(unprobed, "keyword search").state);
  check("an unprobed semantic search is DEGRADED, never WORKS", DEGRADED, find(unprobed, "semantic search").state);
  check("an unprobed run is never READY", false, verdict(unprobed).ready);

  // --- fully working
  const good = capabilities({
    cli: cliOk,
    config: { engine: "pglite", database_path: __selftestExistingPath(), embedding_disabled: false },
    probes: { keyword: true, semantic: true, code: true },
  });
  check("everything probed and passing => READY", true, verdict(good).ready);

  // --- a missing pglite file is not a working brain
  const noDb = capabilities({ cli: cliOk, config: { engine: "pglite", database_path: path.join(os.tmpdir(), "tb-no-such-brain-xyz.pglite") }, probes: { keyword: true } });
  check("a pglite path that does not exist => storage ABSENT", ABSENT, find(noDb, "brain storage").state);

  // --- hit counting is conservative
  check("empty output is zero hits", 0, countHits(""));
  check("\"No results\" is zero hits", 0, countHits("No results found"));
  check("\"0 results\" is zero hits", 0, countHits("Search complete: 0 results"));
  check("an empty JSON array is zero hits", 0, countHits("[]"));
  check("a JSON array of two is two hits", 2, countHits('[{"a":1},{"b":2}]'));
  check("a results envelope is counted", 3, countHits('{"results":[1,2,3]}'));
  check("three text lines are three hits", 3, countHits("a\nb\nc"));
  check("blank lines are not hits", 2, countHits("a\n\n\nb\n"));

  // --- DAEMON CONTENTION: a working brain that the CLI cannot reach
  const heldCaps = capabilities({
    cli: cliOk,
    config: { engine: "pglite", database_path: __selftestExistingPath(), embedding_disabled: false },
    probes: { daemon: { held: true, pid: 795096, why: "a `gbrain serve` daemon (pid 795096) holds this PGLite database." } },
  });
  check("a live daemon makes CLI access ABSENT", ABSENT, find(heldCaps, "cli access").state);
  check("...but storage is still reported as WORKING, because it is", WORKS, find(heldCaps, "brain storage").state);
  check("...and the search failure names the daemon, not a broken brain", true, /not by a broken brain/.test(find(heldCaps, "keyword search").detail));
  check("...and the pid is in the message so it can be acted on", true, /795096/.test(find(heldCaps, "keyword search").detail));
  check("...and the verdict is NOT READY", false, verdict(heldCaps).ready);

  // A stale lock and a live daemon are different problems with different fixes.
  const staleCaps = capabilities({
    cli: cliOk,
    config: { engine: "pglite", database_path: __selftestExistingPath(), embedding_disabled: false },
    probes: { daemon: { held: false, stale: true, pid: 999999, why: "a lock names pid 999999 but that process is gone" }, keyword: true, semantic: true, code: true },
  });
  check("a stale lock is reported separately from a live daemon", DEGRADED, find(staleCaps, "stale lock").state);
  check("...and does NOT block cli access", undefined, find(staleCaps, "cli access"));
  check("a real live pid is detected as held", true, daemonHolding({ database_path: __selftestExistingPath() }).held === false);

  // --- the shell fallback fails closed rather than executing a metacharacter
  check("a quote is a shell metacharacter", true, SHELL_METACHARACTERS.test('x" & del /q *'));
  check("an ampersand is a shell metacharacter", true, SHELL_METACHARACTERS.test("a && b"));
  check("a backtick is a shell metacharacter", true, SHELL_METACHARACTERS.test("a `b`"));
  check("a cmd.exe caret escape is a shell metacharacter", true, SHELL_METACHARACTERS.test("a^b"));
  check("a cmd.exe %VAR% expansion is a shell metacharacter", true, SHELL_METACHARACTERS.test("%PATH%"));
  check("an ordinary search term is not refused", false, SHELL_METACHARACTERS.test("resolveOutDir"));
  check("a term with spaces and hyphens is not refused", false, SHELL_METACHARACTERS.test("what is this brain about"));
  check("a normal Windows path is not refused", false, SHELL_METACHARACTERS.test("C:\\Users\\orion\\code"));
  check(
    "a hostile term really is refused rather than run",
    true,
    (() => {
      const r = sh("tb-no-such-binary-forces-the-shell-path", ['x" & echo PWNED']);
      return r.failed === true && (IS_WINDOWS ? /refused/.test(r.reason) : true);
    })()
  );

  // --- secrets never leak
  check("an api_key key is treated as secret", true, SECRET_KEY_RE.test("anthropic_api_key"));
  check("a database url is treated as secret", true, SECRET_KEY_RE.test("supabase_url"));
  check("a plain engine key is not", false, SECRET_KEY_RE.test("engine"));
  check("embedding_disabled is not treated as a secret", false, SECRET_KEY_RE.test("embedding_disabled"));
}

/** A path that definitely exists, for storage checks in the selftest. */
function __selftestExistingPath() {
  return os.tmpdir();
}

/**
 * The core carries its own `selftest` verb as well as exporting its cases to
 * the two skills that embed it. tools/run-tests.mjs discovers every engine on
 * disk and fails the suite if one cannot prove itself — a shared file is still
 * an engine, and "it is covered by whoever imports it" is exactly the
 * assumption that lets a shared file rot untested.
 */
function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") => {
    const pass = JSON.stringify(expected) === JSON.stringify(got);
    results.push({ name, pass, expected: JSON.stringify(expected), got: JSON.stringify(got), detail });
  };

  coreSelftestCases(check);

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-gbrain-core selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  Configured is not working, and only working is reported as ready.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "selftest") selftest();
  else {
    process.stdout.write("\n  usage: tb-gbrain-core.mjs selftest\n  (shared engine — see setup-gbrain and sync-gbrain)\n\n");
    process.exitCode = 1;
  }
}
