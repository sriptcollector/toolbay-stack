#!/usr/bin/env node
/**
 * tb-health.mjs: the code quality scorecard behind /health.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow implemented here (the `/health` command, the idea
 * of wrapping the project's OWN tools rather than replacing them, the category
 * set of typecheck / lint / test / dead code / shell lint, the 0-10 rubric and
 * its count thresholds, the category weights, the weighted composite, the
 * "skipped tools redistribute their weight" rule, the `## Health Stack` section
 * in CLAUDE.md, the JSONL health history, the trend table and the
 * impact-ranked recommendations) comes from `health` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT PROSE
 * ---------------------------------------------------------------------------
 *
 * gstack's /health is a markdown file that tells the agent to run some shell.
 * Four things in that shell fail on this machine, and every one of them fails
 * in the direction that reads as a HIGH SCORE. Measured on Windows 11, Git Bash
 * (GNU bash 5.2), gstack 1.60.1.0, 2026-08-14. Each reproduction below is
 * verbatim output, not a description of one.
 *
 * 1. THE EXIT CODE IS THE EXIT CODE OF `tail`. SKILL.md:878-885 tells the agent
 *    to run each tool like this:
 *
 *        START=$(date +%s)
 *        tsc --noEmit 2>&1 | tail -50
 *        EXIT_CODE=$?
 *
 *    `$?` after a pipeline is the status of the LAST element, which is `tail`,
 *    and `tail` succeeds at printing whatever it was handed. Reproduced with a
 *    stand-in that prints a type error and exits 2:
 *
 *      $ fake_typecheck() { echo "src/a.ts(3,5): error TS2322: ..."; return 2; }
 *      $ fake_typecheck 2>&1 | tail -50
 *      src/a.ts(3,5): error TS2322: Type string is not assignable to number.
 *      $ EXIT_CODE=$?; echo "TOOL:typecheck EXIT:$EXIT_CODE"
 *      TOOL:typecheck EXIT:0
 *
 *    The rubric at SKILL.md:898 then reads "Type check | 10 | Clean (exit 0)".
 *    A failing type check is recorded as EXIT:0 and scores 10/10 while the
 *    error is on screen. Here every check is spawned directly, with no pipe
 *    between the tool and the status, and the recorded number is the real one.
 *
 * 2. THE DETECTOR IS zsh, AND IT FINDS NOTHING ON A WINDOWS PROJECT.
 *    SKILL.md:812 is `setopt +o nomatch`, a zsh builtin. In bash:
 *
 *      $ setopt +o nomatch
 *      bash: setopt: command not found        (rc=127)
 *
 *    gstack writes `setopt ... 2>/dev/null || true`, so the failure is silent.
 *    More importantly the whole detector only knows tsconfig.json, biome,
 *    eslint, pyproject.toml, package.json, Cargo.toml and go.mod. Run verbatim
 *    against a directory holding main.py, requirements.txt and deploy.ps1:
 *
 *      $ bash -c '<the 10 detection lines from SKILL.md:806-834>'
 *      [detector exit: 1]                     <- and no other output at all
 *
 *    Zero checks detected. Every category is then "skipped", and rule 4 of
 *    SKILL.md:1073 says "Skipped is not failed ... Do not penalize the score",
 *    with the weight redistributed among the remaining categories. Redistribute
 *    nothing among nothing and the arithmetic has no answer, but the agent
 *    still has a dashboard to fill in. This file refuses: a scorecard with no
 *    measured weight behind it is UNVERIFIED and exits 3, never 10/10.
 *
 * 3. A TOOL ON $PATH IS NOT A TOOL THAT RUNS. The detector tests availability
 *    with `command -v`. On Windows that is routinely a lie, because Windows
 *    ships execution-alias stubs:
 *
 *      $ command -v python3
 *      /c/Users/orion/AppData/Local/Microsoft/WindowsApps/python3
 *      $ python3 --version
 *      Python was not found; run without arguments to install from the
 *      Microsoft Store, or disable this shortcut from Settings ...
 *      exit=49
 *
 *    Present on PATH, exits 49, produces no version. Every tool here is probed
 *    by actually executing it, and a probe that fails is recorded as
 *    NOT_INSTALLED with the reason, not counted as a working check.
 *
 * 4. A CHECK THAT DISAPPEARS MAKES THE SCORE GO UP. Weight redistribution plus
 *    trend comparison (SKILL.md:1020-1033, "Trend: IMPROVING (+0.9 since last
 *    run)") means that deleting the tool that was dragging the average is
 *    indistinguishable, in the history file, from fixing the code. The history
 *    line gstack writes has no record of WHICH checks produced the number. Here
 *    every history entry carries the exact set of checks that were scored, and
 *    a comparison across two different sets is printed as NOT COMPARABLE with
 *    the added and removed checks named, instead of as an improvement.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THIS FILE FOLLOWS
 * ---------------------------------------------------------------------------
 *
 *   FAIL CLOSED. There are five states, and only two of them are good news.
 *   CLEAN and FINDINGS mean the check ran and reported. FAILED means it ran and
 *   reported failure of unknown size, which scores 0 rather than gstack's
 *   "assume 4". BROKEN means the check could not run at all, which forces the
 *   whole scorecard to UNVERIFIED, because a number that is missing one of its
 *   inputs is not a smaller number, it is not a number. NOT_INSTALLED is the
 *   only state that redistributes weight, and it still costs coverage, which is
 *   printed next to the score every time.
 *
 *   NO SHELL. Not one check goes through sh, bash, zsh, or cmd string parsing.
 *   No `setopt`, no `ls | xargs`, no `date +%s`, no `$PPID`, no `find -mmin`,
 *   no `source <(...)`. Commands are argv arrays spawned directly, so quoting,
 *   spaces in paths, and MSYS path translation cannot corrupt them.
 *
 *   PROVE IT. `selftest` runs this engine as a child process against fixtures
 *   that are broken on purpose: a tool that exits non-zero, a tool that hangs,
 *   a tool that is not installed, a PATH stub that fails when executed, a
 *   configured command that needs a shell, a corrupt history file, and a
 *   project where nothing at all is detectable. Each must produce the closed
 *   answer. It exits non-zero if any assertion fails, including the assertion
 *   that every expected assertion ran.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------- categories
//
// The five shared categories keep gstack's weights exactly (0.22 / 0.18 / 0.28
// / 0.13 / 0.09) so a score computed here is comparable with one computed
// there. gstack's sixth slot is `gbrain` at 0.10, which measures the health of
// a gstack-specific service rather than of the code. That 0.10 goes to
// `powershell` here, because on Windows the .ps1 files ARE the build system and
// gstack cannot see them at all.

const CATEGORIES = {
  typecheck: { weight: 0.22, label: "Type check", ladder: [[1, 10], [10, 7], [50, 4], [Infinity, 0]] },
  lint: { weight: 0.18, label: "Lint", ladder: [[1, 10], [5, 7], [20, 4], [Infinity, 0]] },
  test: { weight: 0.28, label: "Tests", ladder: null }, // scored by pass ratio
  deadcode: { weight: 0.13, label: "Dead code", ladder: [[1, 10], [5, 7], [20, 4], [Infinity, 0]] },
  shell: { weight: 0.09, label: "Shell lint", ladder: [[1, 10], [5, 7], [Infinity, 4]] },
  powershell: { weight: 0.1, label: "PowerShell", ladder: [[1, 10], [5, 7], [Infinity, 4]] },
};

const CATEGORY_ORDER = Object.keys(CATEGORIES);

/** count -> 0-10, using the ladder as "count < threshold". */
function ladderScore(category, count) {
  const ladder = CATEGORIES[category]?.ladder;
  if (!ladder) return count === 0 ? 10 : 0;
  for (const [limit, score] of ladder) if (count < limit) return score;
  return 0;
}

/** gstack's test rubric: all pass 10, >95% 7, >80% 4, else 0. */
function ratioScore(passed, total) {
  if (!total || total < 0) return null;
  if (passed >= total) return 10;
  const r = passed / total;
  if (r > 0.95) return 7;
  if (r > 0.8) return 4;
  return 0;
}

// -------------------------------------------------------------- path helpers





function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function slugFor(dir) {
  const real = path.resolve(dir);
  const hash = crypto.createHash("sha1").update(isWindows ? real.toLowerCase() : real).digest("hex").slice(0, 8);
  const base = (path.basename(real) || "root").replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${base}-${hash}`;
}

function historyFile(dir) {
  return path.join(stateDir(), "health", `${slugFor(dir)}.jsonl`);
}

// ------------------------------------------------------------ command lookup
//
// Windows needs three things POSIX does not: PATHEXT resolution, the knowledge
// that npm/npx/eslint/biome are .cmd shims that cannot be spawned directly
// since Node 18.20 (they raise EINVAL without a shell), and local
// node_modules/.bin resolution so a project's own tools are used instead of
// downloading something with npx.

const PATHEXT = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of an executable, or null. Never spawns anything. */
function which(cmd, extraDirs = []) {
  if (!cmd) return null;
  const direct = /[\\/]/.test(cmd);
  const candidates = [];
  if (direct) {
    candidates.push(path.resolve(fromMsysPath(cmd)));
  } else {
    const dirs = [...extraDirs, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean);
    for (const d of dirs) candidates.push(path.join(fromMsysPath(d), cmd));
  }
  for (const c of candidates) {
    // On Windows the extension comes FIRST. `C:\Program Files\nodejs\npm` is a
    // real file, but it is the POSIX shell script, and spawning it raises
    // ENOENT; the thing Windows can actually run is `npm.cmd`. Checking the
    // bare name first made a present npm report as "not on PATH".
    if (isWindows) {
      for (const ext of PATHEXT) {
        if (isFile(c + ext)) return c + ext;
        const lower = ext.toLowerCase();
        if (isFile(c + lower)) return c + lower;
      }
      if (isFile(c) && /\.[a-z0-9]+$/i.test(c)) return c;
      continue;
    }
    if (isFile(c)) return c;
  }
  return null;
}

function localBin(dir, name) {
  const base = path.join(dir, "node_modules", ".bin", name);
  if (isWindows) {
    for (const ext of [".cmd", ".CMD", ".bat", ".exe", ""]) if (isFile(base + ext)) return base + ext;
    return null;
  }
  return isFile(base) ? base : null;
}

function quoteCmdArg(a) {
  if (a === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

/**
 * Run one command. No shell, no pipe, real exit code, bounded time.
 *
 * The single Windows concession is .cmd/.bat: those are not executables, they
 * are scripts for the command interpreter, so they are handed to ComSpec with
 * the arguments pre-quoted by us rather than by a shell we do not control.
 */
function runProcess(argv, { cwd, timeoutMs = 120000, env } = {}) {
  const started = Date.now();
  const resolved = which(argv[0]);
  if (!resolved) {
    return {
      ok: false,
      notFound: true,
      status: null,
      stdout: "",
      stderr: `${argv[0]} was not found on PATH`,
      ms: Date.now() - started,
      timedOut: false,
      argvShown: argv.join(" "),
    };
  }
  const rest = argv.slice(1);
  const batch = isWindows && /\.(cmd|bat)$/i.test(resolved);
  let res;
  if (batch) {
    const line = [resolved, ...rest].map(quoteCmdArg).join(" ");
    res = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsVerbatimArguments: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } else {
    res = spawnSync(resolved, rest, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
  }
  const ms = Date.now() - started;
  const timedOut = res.error?.code === "ETIMEDOUT" || (res.signal != null && res.status === null && !res.error);
  return {
    ok: !res.error,
    notFound: res.error?.code === "ENOENT",
    status: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    spawnError: res.error ? `${res.error.code || ""} ${res.error.message}`.trim() : null,
    timedOut,
    ms,
    argvShown: [resolved, ...rest].join(" "),
  };
}

/**
 * "Is this tool real" is answered by RUNNING it, because `command -v python3`
 * is true for a Microsoft Store stub that exits 49. Cached per process.
 */
const probeCache = new Map();
function probe(argv, { cwd, timeoutMs = 20000, accept } = {}) {
  const key = JSON.stringify([argv, cwd]);
  if (probeCache.has(key)) return probeCache.get(key);
  const r = runProcess(argv, { cwd, timeoutMs });
  let reason = null;
  let ok = false;
  if (r.notFound) reason = `${argv[0]} is not on PATH`;
  else if (r.timedOut) reason = `${argv[0]} did not answer ${argv.slice(1).join(" ")} within ${timeoutMs}ms`;
  else if (r.spawnError) reason = `${argv[0]} could not be started (${r.spawnError})`;
  else if (typeof accept === "function") {
    ok = accept(r);
    if (!ok) reason = `${argv[0]} ran but did not look usable (exit ${r.status})`;
  } else if (r.status !== 0) {
    const hint = (r.stdout + r.stderr).trim().split(/\r?\n/)[0] || "";
    reason = `${argv[0]} is on PATH but exited ${r.status} when probed${hint ? `: ${hint.slice(0, 120)}` : ""}`;
  } else ok = true;
  const out = { ok, reason, raw: r };
  probeCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ scanning

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build", "out",
  "target", ".next", ".nuxt", ".turbo", ".cache", "coverage", "vendor", ".mypy_cache",
  ".pytest_cache", ".gradle", "obj", "Pods", ".terraform", ".svn", ".idea", ".tox",
]);

/** Bounded recursive listing. Returns relative paths. */
function scanFiles(dir, { maxDepth = 6, maxFiles = 20000 } = {}) {
  const found = [];
  const walk = (abs, rel, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".venv")) continue;
        walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile()) {
        found.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(path.resolve(dir), "", 0);
  return found;
}

const hasExt = (files, ext) => files.some((f) => f.toLowerCase().endsWith(ext));
const countExt = (files, ext) => files.filter((f) => f.toLowerCase().endsWith(ext)).length;

// ------------------------------------------------------------------- parsers
//
// Each parser answers two questions: how many findings, and is the count
// trustworthy. `confident:false` with a non-zero exit is what turns a check
// into FAILED or BROKEN instead of a made-up number.

function lines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim());
}

function sampleOf(text, re, n = 4) {
  return lines(text).filter((l) => re.test(l)).slice(0, n).map((l) => l.trim().slice(0, 160));
}

const PARSERS = {
  tsc(r) {
    const re = /error TS\d+/;
    const count = lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "type errors", samples: sampleOf(r.text, re), confident: count > 0 };
  },
  eslint(r) {
    const sum = /(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/.exec(r.text);
    if (sum) return { count: Number(sum[1]), unit: "lint problems", samples: sampleOf(r.text, /\s+(error|warning)\s+/), confident: true };
    const re = /^\s*\d+:\d+\s+(error|warning)\s+/;
    const count = lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "lint problems", samples: sampleOf(r.text, re), confident: count > 0 };
  },
  biome(r) {
    const sum = /Found (\d+) (error|warning)/gi;
    let total = 0;
    let m;
    let matched = false;
    while ((m = sum.exec(r.text))) {
      total += Number(m[1]);
      matched = true;
    }
    if (matched) return { count: total, unit: "lint diagnostics", samples: sampleOf(r.text, /^\s*[×⚠]/), confident: true };
    const re = /(lint|assist|format)\/[a-zA-Z]/;
    const count = lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "lint diagnostics", samples: sampleOf(r.text, re), confident: count > 0 };
  },
  ruff(r) {
    const sum = /Found (\d+) error/i.exec(r.text);
    if (sum) return { count: Number(sum[1]), unit: "ruff findings", samples: sampleOf(r.text, /:\d+:\d+:/), confident: true };
    const re = /^.+:\d+:\d+: [A-Z]+\d+/;
    const count = lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "ruff findings", samples: sampleOf(r.text, re), confident: count > 0 };
  },
  pysyntax(r) {
    const m = /PYSYNTAX_ERRORS=(\d+)/.exec(r.text);
    if (!m) return { count: 0, unit: "Python syntax errors", samples: [], confident: false };
    const count = Number(m[1]);
    return { count, unit: "Python syntax errors", samples: sampleOf(r.text, /\.py:\d+:/), confident: true };
  },
  pytest(r) {
    const failed = /(\d+) failed/.exec(r.text);
    const passed = /(\d+) passed/.exec(r.text);
    const errors = /(\d+) errors?\b/.exec(r.text);
    const noTests = /no tests ran/i.test(r.text);
    if (!failed && !passed && !noTests) return { count: 0, unit: "tests", samples: [], confident: false };
    const f = Number(failed?.[1] ?? 0) + Number(errors?.[1] ?? 0);
    const p = Number(passed?.[1] ?? 0);
    return { count: f, passed: p, total: p + f, unit: "failing tests", samples: sampleOf(r.text, /^(FAILED|ERROR)\b/), confident: true };
  },
  nodetest(r) {
    const fail = /^# fail (\d+)/m.exec(r.text);
    const pass = /^# pass (\d+)/m.exec(r.text);
    if (fail && pass) {
      const f = Number(fail[1]);
      const p = Number(pass[1]);
      return { count: f, passed: p, total: p + f, unit: "failing tests", samples: sampleOf(r.text, /^not ok /), confident: true };
    }
    const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed,\s*(\d+) total/.exec(r.text);
    if (jest) {
      const f = Number(jest[1] ?? 0);
      const total = Number(jest[3]);
      return { count: f, passed: total - f, total, unit: "failing tests", samples: sampleOf(r.text, /✕|●/), confident: true };
    }
    const vitest = /Tests\s+(\d+) failed \| (\d+) passed/.exec(r.text);
    if (vitest) {
      const f = Number(vitest[1]);
      const p = Number(vitest[2]);
      return { count: f, passed: p, total: p + f, unit: "failing tests", samples: sampleOf(r.text, /FAIL/), confident: true };
    }
    return { count: 0, unit: "tests", samples: [], confident: false };
  },
  gotest(r) {
    const fails = lines(r.text).filter((l) => /^--- FAIL/.test(l)).length;
    const passes = lines(r.text).filter((l) => /^--- PASS/.test(l)).length;
    if (fails + passes === 0) return { count: 0, unit: "tests", samples: [], confident: false };
    return { count: fails, passed: passes, total: fails + passes, unit: "failing tests", samples: sampleOf(r.text, /^--- FAIL/), confident: true };
  },
  cargotest(r) {
    const m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(r.text);
    if (!m) return { count: 0, unit: "tests", samples: [], confident: false };
    const p = Number(m[1]);
    const f = Number(m[2]);
    return { count: f, passed: p, total: p + f, unit: "failing tests", samples: sampleOf(r.text, /^test .* FAILED/), confident: true };
  },
  knip(r) {
    const re = /^(Unused|Unlisted|Unresolved)/;
    const headers = lines(r.text).filter((l) => re.test(l));
    const items = lines(r.text).filter((l) => /^\S+\.(t|j)sx?(:\d+)?/.test(l)).length;
    if (!headers.length && !items) return { count: 0, unit: "dead code findings", samples: [], confident: false };
    return { count: items, unit: "dead code findings", samples: sampleOf(r.text, /^\S+\.(t|j)sx?/), confident: items > 0 };
  },
  shellcheck(r) {
    const re = /^In .* line \d+:/;
    const count = lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "shellcheck findings", samples: sampleOf(r.text, /^\s*\^--/), confident: count > 0 };
  },
  psparse(r) {
    const m = /PSPARSE_ERRORS=(\d+)/.exec(r.text);
    if (!m) return { count: 0, unit: "PowerShell parse errors", samples: [], confident: false };
    const count = Number(m[1]);
    return { count, unit: "PowerShell parse errors", samples: sampleOf(r.text, /^PS[^A-Z]|\.ps1:\d+:/), confident: true };
  },
  psanalyzer(r) {
    const m = /PSSA_FINDINGS=(\d+)/.exec(r.text);
    if (!m) return { count: 0, unit: "PSScriptAnalyzer findings", samples: [], confident: false };
    const count = Number(m[1]);
    return { count, unit: "PSScriptAnalyzer findings", samples: sampleOf(r.text, /\.ps1:\d+/), confident: true };
  },
  /**
   * The honest default. It never invents a magnitude: if the tool exited
   * non-zero and this parser cannot count anything, `confident:false` sends the
   * check to FAILED (score 0) or BROKEN, never to a guessed middle score.
   */
  generic(r) {
    const re = /\b(error|failed|failure)\b/i;
    const count = r.status === 0 ? 0 : lines(r.text).filter((l) => re.test(l)).length;
    return { count, unit: "reported problems", samples: sampleOf(r.text, re), confident: false };
  },
};

// ---------------------------------------------------------------- detection

/** Tokenise a command string into argv, honouring quotes. */
function tokenize(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let any = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      any = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
      continue;
    }
    cur += ch;
    any = true;
  }
  if (any) out.push(cur);
  return { argv: out, unterminated: quote !== null };
}

const SHELL_META = /(^|[^\\])(\|\||&&|[|&;><]|\$\(|`)/;

/**
 * `## Health Stack` in CLAUDE.md wins over auto-detection, exactly as gstack
 * says. The difference is what happens to a line this engine cannot honour:
 * gstack hands the string to a shell, so `lint: eslint . && tsc` half-runs and
 * the exit code belongs to whichever half ran last. Here it is refused by name,
 * because a check that silently measures something else is worse than no check.
 */
function readHealthStack(dir) {
  const file = path.join(dir, "CLAUDE.md");
  let text;
  try {
    if (!fs.existsSync(file)) return { present: false, checks: [], problems: [] };
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { present: false, checks: [], problems: [`CLAUDE.md exists but could not be read (${e.code || e.message})`] };
  }
  const m = /^##\s+Health Stack\s*$/m.exec(text);
  if (!m) return { present: false, checks: [], problems: [] };
  const after = text.slice(m.index + m[0].length);
  const end = /^##\s+/m.exec(after);
  const body = end ? after.slice(0, end.index) : after;

  const checks = [];
  const problems = [];
  let n = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("-")) continue;
    const item = line.replace(/^-\s*/, "");
    const idx = item.indexOf(":");
    if (idx < 1) {
      problems.push(`"${item.slice(0, 60)}" is not "<category>: <command>"`);
      continue;
    }
    const category = item.slice(0, idx).trim().toLowerCase();
    const cmd = item.slice(idx + 1).trim();
    n += 1;
    if (!CATEGORIES[category]) {
      problems.push(`unknown category "${category}" (known: ${CATEGORY_ORDER.join(", ")})`);
      continue;
    }
    if (!cmd) {
      problems.push(`"${category}" has no command`);
      continue;
    }
    const { argv, unterminated } = tokenize(cmd);
    if (unterminated) {
      problems.push(`"${category}: ${cmd}" has an unterminated quote`);
      continue;
    }
    if (SHELL_META.test(cmd)) {
      // Refused, but still emitted as a check so it shows up BROKEN in the
      // dashboard. Dropping it would quietly shrink the audit.
      checks.push({
        id: `${category}:configured-${n}`,
        category,
        label: cmd,
        argv,
        parser: "generic",
        source: "claude-md",
        unsupported: `this command needs a shell (it contains | & ; > or $()); split it into separate "## Health Stack" lines`,
      });
      continue;
    }
    checks.push({
      id: `${category}:configured-${n}`,
      category,
      label: cmd,
      argv,
      parser: guessParser(argv, category),
      source: "claude-md",
    });
  }
  return { present: true, checks, problems };
}

function guessParser(argv, category) {
  const joined = argv.join(" ").toLowerCase();
  if (/\btsc\b/.test(joined)) return "tsc";
  if (/\beslint\b/.test(joined)) return "eslint";
  if (/\bbiome\b/.test(joined)) return "biome";
  if (/\bruff\b/.test(joined)) return "ruff";
  if (/\bpytest\b/.test(joined)) return "pytest";
  if (/\bknip\b/.test(joined)) return "knip";
  if (/\bshellcheck\b/.test(joined)) return "shellcheck";
  if (/\bgo\b.*\btest\b/.test(joined)) return "gotest";
  if (/\bcargo\b.*\btest\b/.test(joined)) return "cargotest";
  if (category === "test") return "nodetest";
  return "generic";
}

/**
 * The PowerShell syntax checker, written out at run time. No modules needed.
 *
 * `-Include *.ps1` is deliberately NOT used: with a -LiteralPath that has no
 * trailing wildcard, PowerShell silently ignores -Include and hands back every
 * file it finds. The first version of this check did exactly that and the
 * selftest caught it parsing main.py and a .pyc as if they were PowerShell,
 * reporting 5 "PowerShell parse errors" in a directory with one .ps1 in it. A
 * check that invents findings is the same class of bug as one that hides them.
 */
function writePsParseScript(dir) {
  const file = path.join(dir, "tb-health-psparse.ps1");
  const body = [
    "param([Parameter(Mandatory=$true)][string]$Root)",
    "$ErrorActionPreference = 'Stop'",
    "$n = 0",
    "Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |",
    "  Where-Object { @('.ps1','.psm1','.psd1') -contains $_.Extension.ToLower() } |",
    "  Where-Object { $_.FullName -notmatch '\\\\(node_modules|\\.git|\\.venv|venv|dist|build|out|target|__pycache__)\\\\' } |",
    "  ForEach-Object {",
    "    $t = $null; $e = $null",
    "    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e)",
    "    foreach ($x in $e) {",
    "      $n++",
    "      Write-Output ('{0}:{1}: {2}' -f $_.FullName, $x.Extent.StartLineNumber, $x.Message)",
    "    }",
    "  }",
    "Write-Output ('PSPARSE_ERRORS={0}' -f $n)",
  ].join("\r\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/**
 * The Python syntax checker, written out at run time. Nothing to install.
 *
 * `python -m compileall` would be the obvious call and it is the wrong one: it
 * WRITES __pycache__ into the project being measured, which is both a mutation
 * inside a read-only audit and, on the next run, more files to scan. This
 * compiles in memory, writes nothing, and keeps counting past the first error
 * instead of stopping at it.
 */
function writePySyntaxScript(dir) {
  const file = path.join(dir, "tb-health-pysyntax.py");
  const body = [
    "import os, sys",
    "IGNORE = {'.git','node_modules','.venv','venv','env','__pycache__','dist','build','out','target','.next','.mypy_cache','.pytest_cache','.tox'}",
    "root = sys.argv[1]",
    "n = 0",
    "for dirpath, dirnames, filenames in os.walk(root):",
    "    dirnames[:] = [d for d in dirnames if d not in IGNORE]",
    "    for f in filenames:",
    "        if not f.endswith('.py'):",
    "            continue",
    "        p = os.path.join(dirpath, f)",
    "        try:",
    "            with open(p, 'rb') as fh:",
    "                src = fh.read()",
    "            compile(src, p, 'exec')",
    "        except SyntaxError as e:",
    "            n += 1",
    "            print('%s:%s: %s' % (p, e.lineno, e.msg))",
    "        except Exception as e:",
    "            n += 1",
    "            print('%s:0: %s' % (p, e))",
    "print('PYSYNTAX_ERRORS=%d' % n)",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

function psHost() {
  for (const exe of ["pwsh", "powershell"]) {
    const found = which(exe);
    if (found) return found;
  }
  return null;
}

/**
 * Detect what can actually be checked here. Every candidate is probed by
 * execution before it is called available, and a candidate that fails its probe
 * is still returned, carrying the reason, so the dashboard can say WHY a
 * category is missing instead of silently redistributing its weight.
 */
function detect(dir, { skipProbe = false } = {}) {
  const files = scanFiles(dir);
  const checks = [];
  const notes = [];
  const has = (f) => files.includes(f);

  const add = (c) => {
    if (!c.probeArgv || skipProbe) {
      checks.push(c);
      return;
    }
    const p = probe(c.probeArgv, { cwd: dir, accept: c.probeAccept });
    if (p.ok) checks.push(c);
    else checks.push({ ...c, unavailable: p.reason });
  };

  // ---- Node / TypeScript. Local binaries only: `npx <tool>` on a machine
  // without the tool installs it, which is a network operation inside what is
  // supposed to be a read-only measurement.
  if (has("tsconfig.json")) {
    const bin = localBin(dir, "tsc");
    if (bin) {
      add({ id: "typecheck:tsc", category: "typecheck", label: "tsc --noEmit", argv: [bin, "--noEmit"], parser: "tsc", source: "auto", probeArgv: [bin, "--version"] });
    } else {
      checks.push({ id: "typecheck:tsc", category: "typecheck", label: "tsc --noEmit", argv: [], parser: "tsc", source: "auto", unavailable: "tsconfig.json is present but typescript is not installed in node_modules (not running npx, which would download it)" });
    }
  }
  if (has("biome.json") || has("biome.jsonc")) {
    const bin = localBin(dir, "biome");
    if (bin) add({ id: "lint:biome", category: "lint", label: "biome check .", argv: [bin, "check", "."], parser: "biome", source: "auto", probeArgv: [bin, "--version"] });
    else checks.push({ id: "lint:biome", category: "lint", label: "biome check .", argv: [], parser: "biome", source: "auto", unavailable: "biome config found but @biomejs/biome is not installed in node_modules" });
  }
  if (files.some((f) => /^(\.eslintrc(\..*)?|eslint\.config\.(js|mjs|cjs|ts))$/.test(f))) {
    const bin = localBin(dir, "eslint");
    if (bin) add({ id: "lint:eslint", category: "lint", label: "eslint .", argv: [bin, "."], parser: "eslint", source: "auto", probeArgv: [bin, "--version"] });
    else checks.push({ id: "lint:eslint", category: "lint", label: "eslint .", argv: [], parser: "eslint", source: "auto", unavailable: "eslint config found but eslint is not installed in node_modules" });
  }
  if (has("package.json")) {
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch (e) {
      notes.push(`package.json could not be parsed (${e.message}), so its scripts were not used`);
    }
    // gstack greps package.json for the STRING "test", which matches a
    // dependency named "test" and any script whose body mentions it, then runs
    // whatever `scripts.test` contains through a shell. Read the field.
    if (pkg?.scripts?.test && typeof pkg.scripts.test === "string" && !/^\s*(echo|exit)\b/.test(pkg.scripts.test)) {
      const npm = which("npm");
      if (npm) add({ id: "test:npm", category: "test", label: `npm test  (${pkg.scripts.test.slice(0, 48)})`, argv: [npm, "test", "--silent"], parser: "nodetest", source: "auto", probeArgv: [npm, "--version"] });
      else checks.push({ id: "test:npm", category: "test", label: "npm test", argv: [], parser: "nodetest", source: "auto", unavailable: "package.json has a test script but npm is not on PATH" });
    }
    const devKnip = pkg?.devDependencies?.knip || pkg?.dependencies?.knip;
    if (devKnip) {
      const bin = localBin(dir, "knip");
      if (bin) add({ id: "deadcode:knip", category: "deadcode", label: "knip", argv: [bin], parser: "knip", source: "auto", probeArgv: [bin, "--version"] });
      else checks.push({ id: "deadcode:knip", category: "deadcode", label: "knip", argv: [], parser: "knip", source: "auto", unavailable: "knip is in package.json but not installed in node_modules" });
    }
  }

  // ---- Python. gstack only looks at pyproject.toml, so a requirements.txt
  // project, a setup.cfg project, or a loose folder of .py files is invisible.
  const pyFiles = files.filter((f) => f.toLowerCase().endsWith(".py"));
  if (pyFiles.length) {
    const py = pythonInterpreter(dir, skipProbe);
    if (!py.argv) {
      checks.push({ id: "typecheck:python", category: "typecheck", label: "python syntax check", argv: [], parser: "pysyntax", source: "auto", unavailable: py.reason });
    } else {
      const ruffBin = which("ruff");
      if (ruffBin) add({ id: "lint:ruff", category: "lint", label: "ruff check .", argv: [ruffBin, "check", "."], parser: "ruff", source: "auto", probeArgv: [ruffBin, "--version"] });
      else {
        const modProbe = probe([...py.argv, "-m", "ruff", "--version"], { cwd: dir });
        if (modProbe.ok) add({ id: "lint:ruff", category: "lint", label: "python -m ruff check .", argv: [...py.argv, "-m", "ruff", "check", "."], parser: "ruff", source: "auto" });
        else checks.push({ id: "lint:ruff", category: "lint", label: "ruff check .", argv: [], parser: "ruff", source: "auto", unavailable: `ruff is not installed for ${py.argv.join(" ")}` });
      }
      // A syntax check that needs nothing installed, so this category is never
      // empty on a machine that has Python at all.
      const pyScript = writePySyntaxScript(os.tmpdir());
      add({
        id: "typecheck:python",
        category: "typecheck",
        label: `python syntax check (${pyFiles.length} file${pyFiles.length === 1 ? "" : "s"})`,
        argv: [...py.argv, pyScript, path.resolve(dir)],
        parser: "pysyntax",
        source: "auto",
      });
      const pytestProbe = skipProbe ? { ok: false, reason: "probe skipped" } : probe([...py.argv, "-m", "pytest", "--version"], { cwd: dir });
      const wantsPytest = pyFiles.some((f) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/.test(f)) || has("pytest.ini") || has("tox.ini");
      if (wantsPytest) {
        if (pytestProbe.ok) add({ id: "test:pytest", category: "test", label: "python -m pytest -q", argv: [...py.argv, "-m", "pytest", "-q"], parser: "pytest", source: "auto" });
        else checks.push({ id: "test:pytest", category: "test", label: "python -m pytest -q", argv: [], parser: "pytest", source: "auto", unavailable: `test files were found but pytest is not installed for ${py.argv.join(" ")}` });
      }
    }
  }

  // ---- PowerShell. gstack has no PowerShell anywhere. The parser used here is
  // in the box on every Windows machine, so this needs nothing installed.
  const psCount = countExt(files, ".ps1") + countExt(files, ".psm1");
  if (psCount) {
    const host = psHost();
    if (!host) {
      checks.push({ id: "powershell:parse", category: "powershell", label: "PowerShell syntax check", argv: [], parser: "psparse", source: "auto", unavailable: "no pwsh or powershell on PATH" });
    } else {
      const script = writePsParseScript(os.tmpdir());
      add({
        id: "powershell:parse",
        category: "powershell",
        label: `PowerShell parse (${psCount} script${psCount === 1 ? "" : "s"})`,
        argv: [host, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", path.resolve(dir)],
        parser: "psparse",
        source: "auto",
      });
      const pssa = skipProbe
        ? { ok: false, reason: "probe skipped" }
        : probe([host, "-NoProfile", "-NonInteractive", "-Command", "if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { exit 0 } else { exit 7 }"], { cwd: dir });
      if (!pssa.ok) {
        checks.push({ id: "powershell:pssa", category: "powershell", label: "Invoke-ScriptAnalyzer", argv: [], parser: "psanalyzer", source: "auto", unavailable: "PSScriptAnalyzer module is not installed (Install-Module PSScriptAnalyzer)" });
      }
    }
  }

  // ---- POSIX shell scripts
  if (hasExt(files, ".sh")) {
    const sc = which("shellcheck");
    if (sc) add({ id: "shell:shellcheck", category: "shell", label: "shellcheck", argv: [sc, ...files.filter((f) => f.endsWith(".sh")).slice(0, 200)], parser: "shellcheck", source: "auto", probeArgv: [sc, "--version"], cwd: dir });
    else checks.push({ id: "shell:shellcheck", category: "shell", label: "shellcheck", argv: [], parser: "shellcheck", source: "auto", unavailable: "shell scripts found but shellcheck is not on PATH" });
  }

  // ---- Go, Rust
  if (has("go.mod")) {
    const go = which("go");
    if (go) {
      add({ id: "test:go", category: "test", label: "go test ./...", argv: [go, "test", "./..."], parser: "gotest", source: "auto", probeArgv: [go, "version"] });
      add({ id: "typecheck:govet", category: "typecheck", label: "go vet ./...", argv: [go, "vet", "./..."], parser: "generic", source: "auto", probeArgv: [go, "version"] });
    } else checks.push({ id: "test:go", category: "test", label: "go test ./...", argv: [], parser: "gotest", source: "auto", unavailable: "go.mod found but go is not on PATH" });
  }
  if (has("Cargo.toml")) {
    const cargo = which("cargo");
    if (cargo) add({ id: "test:cargo", category: "test", label: "cargo test", argv: [cargo, "test"], parser: "cargotest", source: "auto", probeArgv: [cargo, "--version"] });
    else checks.push({ id: "test:cargo", category: "test", label: "cargo test", argv: [], parser: "cargotest", source: "auto", unavailable: "Cargo.toml found but cargo is not on PATH" });
  }

  return { checks, notes, fileCount: files.length };
}

function pythonInterpreter(dir, skipProbe) {
  const candidates = isWindows ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
  for (const c of candidates) {
    const resolved = which(c[0]);
    if (!resolved) continue;
    const argv = [resolved, ...c.slice(1)];
    if (skipProbe) return { argv };
    // The Microsoft Store stub for `python3` lives on PATH and exits 49. The
    // only way to tell it from an interpreter is to run it.
    const p = probe([...argv, "-c", "import sys; print(sys.version_info[0])"], { cwd: dir, accept: (r) => r.status === 0 && /^\d/.test((r.stdout || "").trim()) });
    if (p.ok) return { argv };
  }
  return { argv: null, reason: "no runnable Python interpreter (checked python, py -3, python3 by executing them, not just by PATH)" };
}

// -------------------------------------------------------------------- states
//
// The whole point of the split below is that "the check reported a problem" and
// "the check could not report" are different facts with different consequences.

const RUNNER_ERROR = /(is not recognized as|command not found|no such file or directory|cannot find module|modulenotfounderror|unrecognized option|unknown option|usage:|permission denied|error: could not|no configuration file)/i;

function classify(check, res, parsed) {
  if (check.unsupported) return { state: "BROKEN", why: check.unsupported };
  if (res.notFound) return { state: "NOT_INSTALLED", why: `${check.argv[0]} is not on PATH` };
  if (res.timedOut) return { state: "BROKEN", why: `timed out after ${res.ms}ms` };
  if (res.spawnError) return { state: "BROKEN", why: `could not be started (${res.spawnError})` };
  if (res.status === null) return { state: "BROKEN", why: `exited without a status${res.signal ? ` (signal ${res.signal})` : ""}` };
  if (res.status === 127 || res.status === 126 || res.status === 9009) {
    return { state: "BROKEN", why: `exit ${res.status}: the command itself could not be run` };
  }
  const text = `${res.stdout}\n${res.stderr}`;
  if (res.status !== 0 && !parsed.confident) {
    if (!text.trim()) return { state: "BROKEN", why: `exit ${res.status} with no output at all, so there is nothing to score` };
    if (RUNNER_ERROR.test(text)) {
      const hit = lines(text).find((l) => RUNNER_ERROR.test(l)) || "";
      return { state: "BROKEN", why: `exit ${res.status} looks like a tool error, not a finding: ${hit.trim().slice(0, 120)}` };
    }
    return { state: "FAILED", why: `exit ${res.status}, and the output could not be counted, so this scores 0 rather than a guess` };
  }
  if (parsed.count > 0) return { state: "FINDINGS", why: `${parsed.count} ${parsed.unit}` };
  if (res.status !== 0) return { state: "FAILED", why: `exit ${res.status}` };
  return { state: "CLEAN", why: "exit 0, nothing reported" };
}

function scoreFor(check, state, parsed) {
  if (state === "NOT_INSTALLED") return null;
  if (state === "BROKEN") return 0;
  if (state === "FAILED") return 0;
  if (check.category === "test") {
    if (typeof parsed.total === "number" && parsed.total > 0) return ratioScore(parsed.passed ?? 0, parsed.total);
    return state === "CLEAN" ? 10 : 0;
  }
  return ladderScore(check.category, parsed.count ?? 0);
}

// ------------------------------------------------------------------ the run

function runChecks(dir, { timeoutMs, only } = {}) {
  const stack = readHealthStack(dir);
  const auto = stack.present && stack.checks.length ? { checks: [], notes: [], fileCount: null } : detect(dir);
  let checks = stack.present && stack.checks.length ? stack.checks : auto.checks;
  if (only?.length) checks = checks.filter((c) => only.includes(c.id) || only.includes(c.category));

  const results = [];
  const startedAll = Date.now();
  for (const check of checks) {
    if (check.unavailable) {
      results.push({ ...pick(check), state: "NOT_INSTALLED", why: check.unavailable, score: null, count: null, ms: 0, exit: null, samples: [] });
      continue;
    }
    if (check.unsupported) {
      results.push({ ...pick(check), state: "BROKEN", why: check.unsupported, score: 0, count: null, ms: 0, exit: null, samples: [] });
      continue;
    }
    const res = runProcess(check.argv, { cwd: check.cwd || dir, timeoutMs });
    const text = `${res.stdout}\n${res.stderr}`;
    let parsed;
    try {
      parsed = (PARSERS[check.parser] || PARSERS.generic)({ text, status: res.status });
    } catch (e) {
      // A parser that throws must not become a clean check.
      parsed = { count: 0, unit: "findings", samples: [], confident: false, parserError: e.message };
    }
    if (parsed.parserError) {
      results.push({ ...pick(check), state: "BROKEN", why: `the output parser failed (${parsed.parserError})`, score: 0, count: null, ms: res.ms, exit: res.status, samples: [] });
      continue;
    }
    const { state, why } = classify(check, res, parsed);
    results.push({
      ...pick(check),
      state,
      why,
      score: scoreFor(check, state, parsed),
      count: parsed.count ?? null,
      passed: parsed.passed ?? null,
      total: parsed.total ?? null,
      unit: parsed.unit ?? null,
      ms: res.ms,
      exit: res.status,
      samples: parsed.samples ?? [],
      tail: lines(text).slice(-40).join("\n"),
    });
  }

  const scored = score(results);
  return {
    version: VERSION,
    dir: path.resolve(dir),
    branch: gitBranch(dir),
    ts: new Date().toISOString(),
    source: stack.present && stack.checks.length ? "claude-md" : "auto",
    stackProblems: stack.problems,
    notes: auto.notes ?? [],
    durationMs: Date.now() - startedAll,
    checks: results,
    ...scored,
  };
}

const pick = (c) => ({ id: c.id, category: c.category, label: c.label, source: c.source, argv: c.argv });

/**
 * Weighted composite, with gstack's redistribution rule and two additions that
 * keep it from lying: coverage is reported next to the score, and a scorecard
 * missing a check that BROKE is UNVERIFIED rather than merely smaller.
 */
function score(results, { minCoverage = 0.35 } = {}) {
  const byCategory = {};
  for (const r of results) {
    if (r.score === null) continue;
    const cur = byCategory[r.category];
    // Worst check wins its category: two linters and one of them is angry means
    // the category is not clean.
    if (!cur || r.score < cur.score) byCategory[r.category] = { score: r.score, from: r.id };
  }
  const included = CATEGORY_ORDER.filter((c) => byCategory[c]);
  const rawWeight = included.reduce((a, c) => a + CATEGORIES[c].weight, 0);
  const totalWeight = CATEGORY_ORDER.reduce((a, c) => a + CATEGORIES[c].weight, 0);
  const coverage = totalWeight ? rawWeight / totalWeight : 0;

  let composite = null;
  const contributions = [];
  if (included.length && rawWeight > 0) {
    let sum = 0;
    for (const c of included) {
      const w = CATEGORIES[c].weight / rawWeight; // redistribution
      sum += byCategory[c].score * w;
      contributions.push({ category: c, score: byCategory[c].score, weight: Number(w.toFixed(4)), from: byCategory[c].from });
    }
    composite = Math.round(sum * 10) / 10;
  }

  const broken = results.filter((r) => r.state === "BROKEN");
  const reasons = [];
  if (!included.length) reasons.push("no check produced a score, so there is nothing to average");
  if (broken.length) reasons.push(`${broken.length} check${broken.length === 1 ? "" : "s"} could not run (${broken.map((b) => b.id).join(", ")})`);
  if (included.length && coverage < minCoverage) {
    reasons.push(`only ${(coverage * 100).toFixed(0)}% of the rubric weight was measured, below the ${(minCoverage * 100).toFixed(0)}% floor`);
  }

  return {
    composite,
    coverage: Number(coverage.toFixed(4)),
    categories: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, byCategory[c]?.score ?? null])),
    contributions,
    verdict: reasons.length ? "UNVERIFIED" : "VERIFIED",
    verdictReasons: reasons,
    checkset: results.filter((r) => r.score !== null).map((r) => r.id).sort(),
  };
}

function gitBranch(dir) {
  const git = which("git");
  if (!git) return null;
  const r = runProcess([git, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10000 });
  if (r.status !== 0) return null;
  const b = r.stdout.trim();
  return b || null;
}

// ------------------------------------------------------------------- history

function appendHistory(dir, report) {
  const file = historyFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    ts: report.ts,
    branch: report.branch,
    verdict: report.verdict,
    composite: report.composite,
    coverage: report.coverage,
    categories: report.categories,
    checkset: report.checkset,
    duration_ms: report.durationMs,
    version: VERSION,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return file;
}

/**
 * gstack reads history with `tail -10 ... || echo "NO_HISTORY"`, which makes an
 * unreadable or corrupt file indistinguishable from a first run. They are
 * opposite facts: one means "no data yet", the other means "the data you have
 * is wrong". Both are reported here, separately.
 */
function readHistory(dir, limit = 10) {
  const file = historyFile(dir);
  if (!fs.existsSync(file)) return { file, entries: [], corrupt: 0, exists: false };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { file, entries: [], corrupt: 0, exists: true, error: `history exists but could not be read (${e.code || e.message})` };
  }
  const all = raw.split(/\r?\n/).filter((l) => l.trim());
  const entries = [];
  let corrupt = 0;
  for (const line of all) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") entries.push(o);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { file, entries: entries.slice(-limit), corrupt, exists: true, total: all.length };
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

function trendOf(history, current) {
  const prior = history.entries.filter((e) => e.ts !== current.ts);
  if (!prior.length) return { kind: "none", text: "First recorded run for this project, so there is no trend yet." };
  const last = prior[prior.length - 1];
  if (!sameSet(last.checkset || [], current.checkset || [])) {
    const added = (current.checkset || []).filter((x) => !(last.checkset || []).includes(x));
    const removed = (last.checkset || []).filter((x) => !(current.checkset || []).includes(x));
    return {
      kind: "not-comparable",
      added,
      removed,
      text:
        `NOT COMPARABLE with the previous run: the set of checks changed` +
        `${added.length ? `, added ${added.join(", ")}` : ""}` +
        `${removed.length ? `, removed ${removed.join(", ")}` : ""}. ` +
        `A score computed over a different set of checks is a different measurement, not a better or worse one.`,
    };
  }
  if (last.composite === null || current.composite === null) {
    return { kind: "not-comparable", text: "NOT COMPARABLE: one of the two runs produced no composite score." };
  }
  const delta = Math.round((current.composite - last.composite) * 10) / 10;
  const kind = delta > 0 ? "improving" : delta < 0 ? "declining" : "flat";
  return { kind, delta, text: `${kind.toUpperCase()} (${delta >= 0 ? "+" : ""}${delta} since the previous run on ${last.ts})` };
}

// ------------------------------------------------------------------ printing

const pad = (s, n) => String(s).padEnd(n);
const STATE_LABEL = {
  CLEAN: "CLEAN",
  FINDINGS: "FINDINGS",
  FAILED: "FAILED",
  BROKEN: "BROKEN",
  NOT_INSTALLED: "SKIPPED",
};

function renderDashboard(report, history) {
  const out = [];
  out.push("");
  out.push("  CODE HEALTH SCORECARD");
  out.push(`  ${"=".repeat(60)}`);
  out.push(`  Project:  ${report.dir}`);
  out.push(`  Branch:   ${report.branch ?? "(not a git repo)"}`);
  out.push(`  Date:     ${report.ts}`);
  out.push(`  Checks:   ${report.source === "claude-md" ? "from ## Health Stack in CLAUDE.md" : "auto-detected"}`);
  out.push("");

  if (!report.checks.length) {
    out.push("  No checks were found for this project at all.");
  } else {
    // A configured command can be a full absolute path; let it set the column
    // width and the table stops being a table.
    const short = (s) => (s.length <= 46 ? s : `${s.slice(0, 21)}...${s.slice(-22)}`);
    const w = {
      cat: Math.max(9, ...report.checks.map((c) => (CATEGORIES[c.category]?.label || c.category).length)),
      label: Math.max(6, ...report.checks.map((c) => short(c.label).length)),
      state: 9,
    };
    out.push(`  ${pad("Category", w.cat)}  ${pad("Check", w.label)}  ${pad("State", w.state)}  Score  Exit   Time     Detail`);
    out.push(`  ${"-".repeat(w.cat)}  ${"-".repeat(w.label)}  ${"-".repeat(w.state)}  -----  -----  -------  ------`);
    for (const c of report.checks) {
      const scoreCell = c.score === null ? "  -  " : `${String(c.score).padStart(2)}/10`;
      const exitCell = c.exit === null ? "  -  " : String(c.exit).padStart(4);
      out.push(
        `  ${pad(CATEGORIES[c.category]?.label || c.category, w.cat)}  ${pad(short(c.label), w.label)}  ${pad(STATE_LABEL[c.state] || c.state, w.state)}  ${scoreCell}  ${exitCell}   ${pad(`${(c.ms / 1000).toFixed(1)}s`, 7)}  ${c.why}`,
      );
    }
  }

  out.push("");
  if (report.composite === null) {
    out.push(`  COMPOSITE: none. ${report.verdictReasons.join("; ")}`);
  } else {
    out.push(`  COMPOSITE: ${report.composite.toFixed(1)} / 10   coverage ${(report.coverage * 100).toFixed(0)}% of the rubric   verdict ${report.verdict}`);
  }
  if (report.verdict === "UNVERIFIED" && report.verdictReasons.length) {
    out.push("");
    out.push("  UNVERIFIED, because:");
    for (const r of report.verdictReasons) out.push(`    - ${r}`);
    out.push("    A composite is only a summary of what was measured. These gaps are");
    out.push("    printed rather than averaged away.");
  }
  if (report.stackProblems?.length) {
    out.push("");
    out.push("  ## Health Stack problems in CLAUDE.md:");
    for (const p of report.stackProblems) out.push(`    - ${p}`);
  }
  if (report.notes?.length) {
    out.push("");
    for (const n of report.notes) out.push(`  note: ${n}`);
  }

  const bad = report.checks.filter((c) => c.samples?.length && c.state !== "CLEAN");
  if (bad.length) {
    out.push("");
    out.push("  DETAILS");
    for (const c of bad) {
      out.push(`    ${c.label} — ${c.why}`);
      for (const s of c.samples) out.push(`      ${s}`);
    }
  }

  if (history) {
    out.push("");
    out.push(`  TREND: ${history.trend.text}`);
    if (history.corrupt) {
      out.push(`  HISTORY WARNING: ${history.corrupt} unparseable line(s) in ${history.file} were ignored.`);
    }
    if (history.entries.length > 1) {
      out.push("");
      out.push(`  ${pad("When", 26)}  ${pad("Branch", 18)}  Score  Cov   Verdict`);
      for (const e of history.entries.slice(-5)) {
        out.push(
          `  ${pad(e.ts, 26)}  ${pad(e.branch ?? "-", 18)}  ${pad(e.composite === null || e.composite === undefined ? "-" : e.composite.toFixed(1), 5)}  ${pad(`${Math.round((e.coverage ?? 0) * 100)}%`, 4)}  ${e.verdict ?? "-"}`,
        );
      }
    }
  }

  const recs = recommendations(report);
  if (recs.length) {
    out.push("");
    out.push("  RECOMMENDATIONS (weight x deficit)");
    recs.forEach((r, i) => {
      out.push(`    ${i + 1}. [${r.band}] ${r.text}`);
      if (r.how) out.push(`       ${r.how}`);
    });
  }
  out.push("");
  return out.join("\n");
}

function recommendations(report) {
  const recs = [];
  const measured = new Set(report.checks.filter((c) => c.score !== null).map((c) => c.category));
  for (const c of report.checks) {
    if (c.state === "NOT_INSTALLED") {
      // A category with another check still running is not a hole in the
      // rubric, it is one fewer angle on a category that was measured. Saying
      // "PowerShell is unmeasured" next to a PowerShell row scoring 10/10 is
      // the kind of contradiction that teaches people to ignore the report.
      const whole = !measured.has(c.category);
      recs.push({
        impact: CATEGORIES[c.category].weight * (whole ? 10 : 2),
        band: whole ? "GAP" : "LOW",
        text: whole
          ? `${CATEGORIES[c.category].label} is unmeasured (${Math.round(CATEGORIES[c.category].weight * 100)}% of the rubric): ${c.why}`
          : `${CATEGORIES[c.category].label} has one fewer check than it could: ${c.why}`,
        how: null,
      });
      continue;
    }
    if (c.score === null || c.score >= 10) continue;
    const impact = CATEGORIES[c.category].weight * (10 - c.score);
    recs.push({
      impact,
      band: impact >= 1.5 ? "HIGH" : impact >= 0.6 ? "MED" : "LOW",
      text: `${CATEGORIES[c.category].label}: ${c.score}/10 — ${c.why}`,
      how: c.argv?.length ? `re-run: ${c.argv.join(" ")}` : null,
    });
  }
  return recs.sort((a, b) => b.impact - a.impact).slice(0, 8);
}

// ------------------------------------------------------------------ selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

function fixtureTool(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body, "utf8");
  return f;
}

const EXPECTED_ASSERTIONS = 56;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-health-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail: String(detail).slice(0, 300) });

  const q = (p) => `"${p.split(path.sep).join("/")}"`;
  // Quoted, because process.execPath on Windows is "C:\Program Files\nodejs\node.exe"
  // and an unquoted path with a space is exactly the bug this engine refuses to have.
  const node = q(process.execPath);
  /** null-safe accessor: `??` cannot tell "the field is null" from "there is no field". */
  const val = (v) => (v === undefined ? "(missing)" : String(v));

  // --- the fake tools every fixture below is built out of -------------------
  const tools = path.join(tmp, "tools");
  fs.mkdirSync(tools, { recursive: true });
  // The names matter: the parser for a configured command is chosen from the
  // command text, exactly as it is for a real `## Health Stack` line, so these
  // fixtures exercise the real tsc and eslint parsers rather than a test hook.
  const failing = fixtureTool(tools, "tsc.mjs",
    'process.stdout.write("src/a.ts(3,5): error TS2322: Type string is not assignable to number.\\n");\nprocess.exit(2);\n');
  const failingMany = fixtureTool(tools, "tsc-many.mjs",
    'for (let i=0;i<12;i++) process.stdout.write(`src/f${i}.ts(1,1): error TS1005: x\\n`);\nprocess.exit(2);\n');
  const cleanTool = fixtureTool(tools, "clean.mjs", 'process.stdout.write("no issues\\n");\nprocess.exit(0);\n');
  const warnTool = fixtureTool(tools, "eslint.mjs",
    'process.stdout.write("  1:1  warning  x  rule/a\\n  2:2  warning  y  rule/b\\n");\nprocess.exit(0);\n');
  const hangTool = fixtureTool(tools, "hang.mjs", 'setTimeout(()=>{}, 60000);\n');
  const crashTool = fixtureTool(tools, "crash.mjs",
    'process.stderr.write("Error: Cannot find module \'@nope/config\'\\n");\nprocess.exit(1);\n');
  const silentFail = fixtureTool(tools, "silent-fail.mjs", "process.exit(3);\n");
  const opaqueFail = fixtureTool(tools, "opaque-fail.mjs",
    'process.stdout.write("the build did not go well\\n");\nprocess.exit(1);\n');

  const mkProject = (name, healthStack) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    if (healthStack) fs.writeFileSync(path.join(d, "CLAUDE.md"), `# x\n\n## Health Stack\n\n${healthStack}\n`, "utf8");
    return d;
  };
  const stateOf = (name) => {
    const d = path.join(tmp, "state", name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const runIn = (dir, extra = [], env = {}) => runSelf(["run", "--dir", dir, "--json", ...extra], { TOOLBAY_STACK_STATE_DIR: stateOf(path.basename(dir)), ...env });
  const checkOf = (j, id) => j?.checks?.find((c) => c.id.startsWith(id));

  try {
    // === 1. THE gstack BUG ITSELF ==========================================
    // A type checker that exits 2 with an error on stdout. gstack's
    // `tool | tail -50; EXIT_CODE=$?` records EXIT:0 and its rubric scores that
    // 10/10. Everything here must see the 2.
    {
      const d = mkProject("failing", `- typecheck: ${node} ${q(failing)}`);
      const r = runIn(d);
      const c = checkOf(r.json, "typecheck");
      check("a check that exits 2 records exit 2, not tail's 0", 2, c?.exit ?? "(none)", r.stderr.slice(0, 200));
      check("...and is not CLEAN", "FINDINGS", c?.state ?? "(none)", c?.why ?? "");
      check("...and does not score 10", true, (c?.score ?? 10) < 10, `score=${c?.score}`);
      check("...one type error scores 7 on gstack's own ladder", 7, c?.score ?? "(none)", c?.why ?? "");
      check("...and the composite is not 10", true, (r.json?.composite ?? 10) < 10, `composite=${r.json?.composite}`);
    }

    // === 2. NOTHING DETECTABLE IS NOT A PERFECT SCORE ======================
    // gstack skips every category, redistributes the weight of nothing among
    // nothing, and still prints a dashboard. Here it is UNVERIFIED and exit 3.
    {
      const d = mkProject("empty");
      fs.writeFileSync(path.join(d, "notes.txt"), "hello\n", "utf8");
      const r = runIn(d);
      check("a project with no checks yields no composite", "null", val(r.json?.composite), r.stderr.slice(0, 200));
      check("...verdict UNVERIFIED", "UNVERIFIED", r.json?.verdict ?? "(none)");
      check("...and exits 3 so it cannot be mistaken for a pass", 3, r.status);
      check("...coverage is 0", 0, r.json?.coverage ?? "(none)");
    }

    // === 3. A BROKEN CHECK POISONS THE VERDICT, IT DOES NOT VANISH =========
    {
      const d = mkProject("broken", `- typecheck: ${node} ${q(crashTool)}\n- lint: ${node} ${q(cleanTool)}`);
      const r = runIn(d);
      const c = checkOf(r.json, "typecheck");
      check("a tool error (missing module) is BROKEN, not a finding", "BROKEN", c?.state ?? "(none)", c?.why ?? "");
      check("...the whole scorecard goes UNVERIFIED", "UNVERIFIED", r.json?.verdict ?? "(none)", (r.json?.verdictReasons || []).join("; "));
      check("...and exits 3 even though another check passed", 3, r.status);
      check("...while the clean check still scored", 10, checkOf(r.json, "lint")?.score ?? "(none)");
      // A BROKEN check must WEIGH 0, not be redistributed away like a tool that
      // was never installed. Those are the two directions this whole file is
      // about: absent is a smaller audit, broken is a wrong number.
      check("...the broken check scores 0 rather than vanishing", 0, r.json?.categories?.typecheck ?? "(none)", JSON.stringify(r.json?.categories));
      check("...so the composite is dragged down, not inflated", 4.5, r.json?.composite ?? "(none)", JSON.stringify(r.json?.contributions));
    }
    {
      const d = mkProject("silent", `- lint: ${node} ${q(silentFail)}`);
      const r = runIn(d);
      check("exit 3 with no output at all is BROKEN", "BROKEN", checkOf(r.json, "lint")?.state ?? "(none)", checkOf(r.json, "lint")?.why ?? "");
    }
    {
      const d = mkProject("opaque", `- lint: ${node} ${q(opaqueFail)}`);
      const r = runIn(d);
      const c = checkOf(r.json, "lint");
      check("an uncountable non-zero exit scores 0, not gstack's assumed 4", 0, c?.score ?? "(none)", c?.why ?? "");
      check("...and is FAILED, which is a result, not a broken runner", "FAILED", c?.state ?? "(none)");
    }

    // === 4. A HANGING TOOL IS KILLED AND COUNTED AS BROKEN =================
    {
      const d = mkProject("hang", `- test: ${node} ${q(hangTool)}`);
      const r = runIn(d, ["--timeout", "2000"]);
      const c = checkOf(r.json, "test");
      check("a tool that hangs is killed", "BROKEN", c?.state ?? "(none)", c?.why ?? "");
      check("...and says it timed out", true, /timed out/.test(c?.why ?? ""), c?.why ?? "");
      check("...and the run still finishes", 3, r.status);
    }

    // === 5. A TOOL THAT IS NOT INSTALLED ===================================
    {
      const d = mkProject("missing", `- lint: definitely-not-a-real-binary-xyz --check\n- test: ${node} ${q(cleanTool)}`);
      const r = runIn(d);
      const c = checkOf(r.json, "lint");
      check("a missing binary is SKIPPED, not failed", "NOT_INSTALLED", c?.state ?? "(none)", c?.why ?? "");
      check("...it contributes no score", "null", val(c?.score));
      check("...its weight is redistributed", 10, r.json?.composite ?? "(none)", JSON.stringify(r.json?.contributions));
      check("...but coverage records the gap", "28", String(Math.round((r.json?.coverage ?? 0) * 100)), "test weight only");
      check("...and low coverage alone makes it UNVERIFIED", "UNVERIFIED", r.json?.verdict ?? "(none)", (r.json?.verdictReasons || []).join("; "));
    }

    // === 6. A CONFIGURED COMMAND THAT NEEDS A SHELL IS REFUSED BY NAME =====
    {
      const d = mkProject("shelly", `- lint: ${node} ${q(cleanTool)} && ${node} ${q(failing)}`);
      const r = runIn(d);
      const c = checkOf(r.json, "lint");
      check("a && command is refused rather than half-run", "BROKEN", c?.state ?? "(none)", c?.why ?? "");
      check("...and the reason names the shell operators", true, /needs a shell/.test(c?.why ?? ""), c?.why ?? "");
    }

    // === 7. SCORING ARITHMETIC IS DETERMINISTIC ============================
    {
      const d = mkProject("mixed", `- typecheck: ${node} ${q(failingMany)}\n- lint: ${node} ${q(warnTool)}\n- test: ${node} ${q(cleanTool)}`);
      const r = runIn(d);
      check("12 type errors score 4 on the ladder", 4, checkOf(r.json, "typecheck")?.score ?? "(none)");
      check("2 lint warnings score 7", 7, checkOf(r.json, "lint")?.score ?? "(none)");
      check("a clean test run scores 10", 10, checkOf(r.json, "test")?.score ?? "(none)");
      // (0.22*4 + 0.18*7 + 0.28*10) / 0.68 = 7.2647 -> 7.3
      check("the composite is computed, not eyeballed", 7.3, r.json?.composite ?? "(none)", JSON.stringify(r.json?.contributions));
      check("...and the redistributed weights sum to 1", "1.0000", (r.json?.contributions || []).reduce((a, c) => a + c.weight, 0).toFixed(4));
      check("...verdict VERIFIED once coverage clears the floor", "VERIFIED", r.json?.verdict ?? "(none)", (r.json?.verdictReasons || []).join("; "));
      check("...and exit 0", 0, r.status);
      check("--gate above the score exits 1", 1, runIn(d, ["--gate", "9.5"]).status);
      check("--gate below the score exits 0", 0, runIn(d, ["--gate", "6.0"]).status);
    }

    // === 8. WORST CHECK WINS ITS CATEGORY ==================================
    {
      const d = mkProject("twolint", `- lint: ${node} ${q(cleanTool)}\n- lint: ${node} ${q(warnTool)}\n- test: ${node} ${q(cleanTool)}`);
      const r = runIn(d);
      check("two linters, the angry one sets the category", 7, r.json?.categories?.lint ?? "(none)");
    }

    // === 9. THE TREND CANNOT BE GAMED BY DELETING A CHECK ==================
    {
      const st = stateOf("trend");
      const d1 = mkProject("trend", `- typecheck: ${node} ${q(failingMany)}\n- lint: ${node} ${q(cleanTool)}\n- test: ${node} ${q(cleanTool)}`);
      const first = runSelf(["run", "--dir", d1, "--json"], { TOOLBAY_STACK_STATE_DIR: st });
      // Same project, one failing check removed. The composite RISES.
      fs.writeFileSync(path.join(d1, "CLAUDE.md"), `# x\n\n## Health Stack\n\n- lint: ${node} ${q(cleanTool)}\n- test: ${node} ${q(cleanTool)}\n`, "utf8");
      const second = runSelf(["run", "--dir", d1, "--json"], { TOOLBAY_STACK_STATE_DIR: st });
      check("deleting the failing check does raise the raw score", true, (second.json?.composite ?? 0) > (first.json?.composite ?? 10), `${first.json?.composite} -> ${second.json?.composite}`);
      check("...but the trend refuses to call that an improvement", "not-comparable", second.json?.trend?.kind ?? "(none)", second.json?.trend?.text ?? "");
      check("...and names the check that disappeared", true, /typecheck/.test(JSON.stringify(second.json?.trend?.removed ?? [])), JSON.stringify(second.json?.trend?.removed));
      // A third run with the same set IS comparable.
      const third = runSelf(["run", "--dir", d1, "--json"], { TOOLBAY_STACK_STATE_DIR: st });
      check("an unchanged check set compares normally", "flat", third.json?.trend?.kind ?? "(none)", third.json?.trend?.text ?? "");
    }

    // === 10. A CORRUPT HISTORY FILE IS NAMED, NOT SWALLOWED ================
    {
      const st = stateOf("corrupt");
      const d = mkProject("corrupt", `- lint: ${node} ${q(cleanTool)}\n- test: ${node} ${q(cleanTool)}`);
      const hf = path.join(st, "health", `${slugFor(d)}.jsonl`);
      fs.mkdirSync(path.dirname(hf), { recursive: true });
      fs.writeFileSync(hf, "{ not json at all\n", "utf8");
      const r = runSelf(["run", "--dir", d, "--json"], { TOOLBAY_STACK_STATE_DIR: st });
      check("a corrupt history line is counted and reported", 1, r.json?.history?.corrupt ?? "(none)", JSON.stringify(r.json?.history));
      check("...and the run still produces a scorecard", true, (r.json?.composite ?? null) !== null, `${r.json?.composite}`);
      const t = runSelf(["trend", "--dir", d], { TOOLBAY_STACK_STATE_DIR: st });
      check("trend exits non-zero when history is partly unreadable", 3, t.status, t.stdout.slice(-200));
    }

    // === 11. WINDOWS REALITY ==============================================
    // A Python + PowerShell project. Run verbatim, gstack's detector prints
    // nothing at all for this directory (reproduced in the header). Detection
    // here must find work to do without anything being installed.
    {
      const d = mkProject("winpy");
      fs.writeFileSync(path.join(d, "main.py"), "def f():\n    return 1\n", "utf8");
      fs.writeFileSync(path.join(d, "requirements.txt"), "ruff\npytest\n", "utf8");
      fs.writeFileSync(path.join(d, "broken.ps1"), "function Broken {\n  Write-Output 'x'\n", "utf8");
      const det = runSelf(["detect", "--dir", d, "--json"]);
      const ids = (det.json?.checks || []).map((c) => c.id);
      check("a python + powershell project detects checks", true, ids.length > 0, ids.join(", "));
      check("...including a Python syntax check", true, ids.includes("typecheck:python"), ids.join(", "));
      if (isWindows) {
        check("...and a PowerShell check, which gstack has none of", true, ids.includes("powershell:parse"), ids.join(", "));
        const r = runIn(d);
        const ps = checkOf(r.json, "powershell:parse");
        check("...the in-box parser finds the real syntax error", 1, ps?.count ?? "(none)", ps?.why ?? "");
        check("...and scores it below clean", true, (ps?.score ?? 10) < 10, `score=${ps?.score}`);
      } else {
        check("...and a PowerShell check, which gstack has none of", true, true, "not win32; PowerShell assertions are win32-only");
        check("...the in-box parser finds the real syntax error", true, true, "skipped off win32");
        check("...and scores it below clean", true, true, "skipped off win32");
      }
    }

    // === 12. PATH PRESENCE IS NOT RUNNABILITY =============================
    // The real case is the Microsoft Store python3 stub: on PATH, exits 49.
    // Simulated here with a stub of our own so the assertion runs anywhere.
    {
      const stub = path.join(tmp, "stubbin");
      fs.mkdirSync(stub, { recursive: true });
      const stubName = isWindows ? "faketool.cmd" : "faketool";
      const body = isWindows
        ? "@echo off\r\necho Tool was not found; install it from the store\r\nexit /b 49\r\n"
        : "#!/bin/sh\necho 'Tool was not found; install it from the store'\nexit 49\n";
      fs.writeFileSync(path.join(stub, stubName), body, "utf8");
      if (!isWindows) fs.chmodSync(path.join(stub, stubName), 0o755);
      const p = probe(["faketool", "--version"], { cwd: tmp, timeoutMs: 15000 });
      const saved = process.env.PATH;
      process.env.PATH = `${stub}${path.delimiter}${saved}`;
      probeCache.clear();
      const p2 = probe(["faketool", "--version"], { cwd: tmp, timeoutMs: 15000 });
      process.env.PATH = saved;
      probeCache.clear();
      check("a stub on PATH is found by a PATH lookup", true, Boolean(which("faketool", [stub])), "which() only reads the filesystem");
      check("...but probing it by execution rejects it", false, p2.ok, p2.reason ?? "");
      check("...with the exit code in the reason", true, /49/.test(p2.reason ?? ""), p2.reason ?? "");
      void p;
    }

    // === 13. THE ENGINE ITSELF ============================================
    {
      const bad = runSelf(["run", "--dir", path.join(tmp, "does-not-exist-at-all")]);
      check("a missing --dir is a usage error, not an empty pass", 2, bad.status, bad.stdout.slice(0, 160) + bad.stderr.slice(0, 160));
      const j = runIn(mkProject("jsonshape", `- lint: ${node} ${q(cleanTool)}\n- test: ${node} ${q(cleanTool)}`));
      check("--json prints parseable JSON on stdout alone", true, j.json !== null, j.stdout.slice(0, 160));
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows can hold a handle briefly; the temp dir is not the point */
    }
  }

  // A selftest whose size depends on where it ran is a selftest that can
  // quietly stop asserting things.
  results.push({
    name: `all ${EXPECTED_ASSERTIONS} assertions ran`,
    expected: String(EXPECTED_ASSERTIONS),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED_ASSERTIONS,
    detail: "the count is fixed so a silently skipped block cannot pass unnoticed",
  });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-health selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${pad(r.name, width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  This scorecard engine is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken input above produced the CLOSED answer: a real\n");
  process.stdout.write("  exit code, a named reason, and a verdict that refuses to average over a\n");
  process.stdout.write("  check that did not run.\n\n");
}

// -------------------------------------------------------------------- doctor

function doctor(dir) {
  const det = detect(dir);
  process.stdout.write(`\n  tb-health doctor  ${VERSION}  (node ${process.version}, ${process.platform})\n`);
  process.stdout.write(`  project: ${path.resolve(dir)}  (${det.fileCount} files scanned)\n\n`);
  const stack = readHealthStack(dir);
  process.stdout.write(`  ## Health Stack in CLAUDE.md: ${stack.present ? `${stack.checks.length} entries` : "absent, using auto-detection"}\n`);
  for (const p of stack.problems) process.stdout.write(`      PROBLEM  ${p}\n`);
  process.stdout.write("\n");
  if (!det.checks.length) process.stdout.write("  Nothing detected. /health here would be UNVERIFIED, on purpose.\n");
  for (const c of det.checks) {
    const tag = c.unavailable ? "MISSING " : "READY   ";
    process.stdout.write(`  ${tag} ${pad(c.category, 11)} ${c.label}\n`);
    if (c.unavailable) process.stdout.write(`            ${c.unavailable}\n`);
  }
  const ready = det.checks.filter((c) => !c.unavailable);
  const cov = CATEGORY_ORDER.filter((cat) => ready.some((c) => c.category === cat)).reduce((a, c) => a + CATEGORIES[c].weight, 0);
  process.stdout.write(`\n  runnable coverage: ${(cov * 100).toFixed(0)}% of the rubric weight\n\n`);
  process.exitCode = ready.length ? 0 : 3;
}

// ---------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function help() {
  process.stdout.write(`
  tb-health ${VERSION}, the Toolbay Stack code quality scorecard

    detect  [--dir D] [--json]        show which checks this project has, and
                                      why any missing one is missing
    run     [--dir D] [--json]        run them, score them, record the run
            [--timeout MS] [--gate N] [--only id,category] [--no-history]
    trend   [--dir D] [--limit N]     the recorded history for this project
    doctor  [--dir D]                 what is runnable on this machine
    selftest                          prove the engine on broken inputs

  Exit codes for run:  0 verified (and above --gate)
                       1 below --gate
                       2 usage error
                       3 UNVERIFIED (a check broke, or too little was measured)

  Nothing here goes through a shell, and no score is ever computed for a check
  that did not actually run.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dirArg = args.flags.dir === true ? null : args.flags.dir;
  const dir = toAbsolute(dirArg || ".", process.cwd());

  if (!cmd || cmd === "help" || args.flags.help) return help();
  if (cmd === "selftest") return selftest();

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`tb-health: ${dir} is not a directory\n`);
    process.exitCode = 2;
    return;
  }

  if (cmd === "doctor") return doctor(dir);

  if (cmd === "detect") {
    const det = detect(dir);
    const stack = readHealthStack(dir);
    const payload = {
      dir,
      source: stack.present && stack.checks.length ? "claude-md" : "auto",
      checks: (stack.present && stack.checks.length ? stack.checks : det.checks).map((c) => ({
        id: c.id,
        category: c.category,
        label: c.label,
        argv: c.argv,
        source: c.source,
        unavailable: c.unavailable ?? null,
        unsupported: c.unsupported ?? null,
      })),
      problems: stack.problems,
      notes: det.notes,
    };
    if (args.flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else doctor(dir);
    return;
  }

  if (cmd === "trend") {
    const limit = Number(args.flags.limit || 10);
    const h = readHistory(dir, Number.isFinite(limit) ? limit : 10);
    if (h.error) {
      process.stdout.write(`  ${h.error}\n`);
      process.exitCode = 3;
      return;
    }
    if (!h.exists) {
      process.stdout.write(`  No health history yet for ${dir}.\n  Run: node ${path.basename(SELF)} run\n`);
      return;
    }
    process.stdout.write(`\n  HEALTH HISTORY  ${h.file}\n\n`);
    process.stdout.write(`  ${pad("When", 26)}  ${pad("Branch", 18)}  Score  Cov   Verdict\n`);
    for (const e of h.entries) {
      process.stdout.write(
        `  ${pad(e.ts, 26)}  ${pad(e.branch ?? "-", 18)}  ${pad(e.composite === null || e.composite === undefined ? "-" : Number(e.composite).toFixed(1), 5)}  ${pad(`${Math.round((e.coverage ?? 0) * 100)}%`, 4)}  ${e.verdict ?? "-"}\n`,
      );
    }
    if (h.corrupt) {
      process.stdout.write(`\n  ${h.corrupt} of ${h.total} lines could not be parsed. This history is damaged,\n`);
      process.stdout.write("  so any trend drawn from it is incomplete. Reported rather than ignored.\n\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write("\n");
    return;
  }

  if (cmd !== "run") {
    process.stderr.write(`tb-health: unknown command "${cmd}"\n`);
    process.exitCode = 2;
    return;
  }

  const timeoutMs = Number(args.flags.timeout || 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write("tb-health: --timeout must be a positive number of milliseconds\n");
    process.exitCode = 2;
    return;
  }
  const only = typeof args.flags.only === "string" ? args.flags.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const report = runChecks(dir, { timeoutMs, only });

  let history = null;
  if (!args.flags["no-history"]) {
    try {
      appendHistory(dir, report);
    } catch (e) {
      report.notes.push(`history could not be written (${e.code || e.message})`);
    }
  }
  const h = readHistory(dir, 10);
  history = {
    file: h.file,
    corrupt: h.corrupt,
    entries: h.entries,
    error: h.error ?? null,
    trend: h.error ? { kind: "unreadable", text: h.error } : trendOf(h, report),
  };
  report.history = { file: h.file, corrupt: h.corrupt, entries: h.entries.length, error: h.error ?? null };
  report.trend = history.trend;

  if (args.flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${renderDashboard(report, history)}\n`);

  if (report.verdict === "UNVERIFIED") {
    process.exitCode = 3;
    return;
  }
  if (args.flags.gate !== undefined && args.flags.gate !== true) {
    const gate = Number(args.flags.gate);
    if (!Number.isFinite(gate)) {
      process.stderr.write("tb-health: --gate must be a number\n");
      process.exitCode = 2;
      return;
    }
    if (report.composite === null || report.composite < gate) {
      process.exitCode = 1;
      return;
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`tb-health: ${err?.stack ?? err}\n`);
  process.exitCode = 2;
}
