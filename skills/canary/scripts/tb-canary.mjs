#!/usr/bin/env node
/**
 * tb-canary.mjs: the post-deploy evidence engine behind /canary.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (the /canary command, baseline capture before the
 * deploy, the monitoring loop over a page list, alert on CHANGE rather than on
 * absolutes, the transient-tolerance rule, the CRITICAL/HIGH/MEDIUM/LOW alert
 * ladder, the HEALTHY/DEGRADED/BROKEN verdict and the report layout) comes from
 * `canary` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's canary is 232 lines of prose and zero executable checks:
 *
 *     $ ls ~/.claude/skills/gstack/canary/
 *     SKILL.md  SKILL.md.tmpl
 *
 * Everything it reports is the agent's own account of what it saw. That breaks
 * in four ways this file is built to close.
 *
 * 1. IT NEVER ASKS WHICH BUILD IS SERVING. A canary exists to answer "is the
 *    thing I just deployed actually live". gstack's never checks:
 *
 *      $ grep -inE "commit|sha|build id|deployment|alias" canary/SKILL.md.tmpl
 *      4:version: 1.0.0
 *
 *    That is the whole match set, and it is the frontmatter. So the most common
 *    real deploy failure is invisible to it: the build goes green, the alias
 *    never moves, and the domain keeps serving the previous build. Every page
 *    loads, console is clean, latency is normal, and gstack prints
 *    "VERDICT: DEPLOY IS HEALTHY" about code that was never shipped. Here,
 *    `probe --build <marker>` fails the run when the origin answers 200 without
 *    carrying the build you deployed, and `verdict` refuses to say HEALTHY if
 *    you named a build and nothing ever confirmed it was served.
 *
 * 2. A CHECK THAT COULD NOT RUN LOOKS LIKE A CHECK THAT PASSED. gstack's loop is
 *    `$B goto`, `$B console --errors`, `$B perf` (canary/SKILL.md.tmpl:139-144).
 *    If the browse daemon is down, `$B` is empty or errors, the agent gets no
 *    console errors back, and "no new console errors" is exactly what the
 *    HEALTHY branch reads. There is no state in the whole skill for "the check
 *    did not run". Here every transport failure (refused, DNS, timeout, TLS) is
 *    a RECORDED CRITICAL FAILURE, and a run with no checks in it is BROKEN.
 *
 * 3. SCREENSHOTS ARE CALLED EVIDENCE AND NOTHING OPENS THEM. Same bug as gstack
 *    /qa. `record` here downgrades any observation whose artifact is missing or
 *    zero bytes, and one downgraded observation stops the run being HEALTHY.
 *
 * 4. THE VERDICT IS A SENTENCE. `VERDICT: [DEPLOY IS HEALTHY / DEPLOY HAS
 *    ISSUES]` (canary/SKILL.md.tmpl:192). Nothing downstream can gate on a
 *    sentence. `verdict` here exits 0 only for HEALTHY, so it can sit in front
 *    of a rollback.
 *
 * And one gstack rule is a hole worth naming, because it is load-bearing prose:
 * "Only alert on patterns that persist across 2 or more consecutive checks"
 * (:147, :222) combined with "--quick: single-pass health check, no continuous
 * monitoring" (:43) means a --quick run can never satisfy its own alert
 * condition. A single-pass canary that finds the site down is instructed not to
 * call it. Here severity decides, not repetition: unreachable, 5xx and a stale
 * build are BROKEN on the first observation, while latency needs `--consecutive`
 * confirmations before it counts, which is what that rule was actually for.
 *
 * WINDOWS
 *
 * No shell, no browse daemon, no coreutils, no `date +%s`, no `open`. Node makes
 * the HTTP request itself, so the same command produces the same evidence from
 * Git Bash, PowerShell and cmd. `--dir /tmp/canary` is refused on win32 for the
 * measured reason that it names two different directories there. And `watch`
 * does its own waiting in-process, so a 10-minute canary is one command with
 * timestamped rounds instead of an agent trying to pace `sleep` across turns.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS, resolveOutDir as resolveOutDirShared } from "./tb-outdir.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger. Reading, writing and refusing it is shared
// (src/ledger/tb-ledger.mjs); only the filename and the wording are this
// skill's.
const LEDGER_FILE = "canary.json";
const ledgerPath = (dir) => ledgerPathShared(dir, LEDGER_FILE);
function readLedger(dir) {
  return readLedgerShared(dir, {
    file: LEDGER_FILE,
    what: "canary ledger",
    hint: 'Run "tb-canary.mjs init --url <url>" first. An unmonitored deploy is not a verified deploy.',
    require: ["checks"],
  });
}


/**
 * This skill's output directory. The refusal and the resolution are shared
 * (src/outdir/tb-outdir.mjs); only the default and the consequence sentence
 * are this skill's.
 */
function resolveOutDir(raw) {
  return resolveOutDirShared(raw, {
    defaultDir: process.env.TOOLBAY_CANARY_DIR || path.join(process.cwd(), ".toolbay", "canary"),
    consequence: "The canary would write its ledger to one and the report would link to the other.",
  });
}

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // HEALTHY
const EXIT_UNHEALTHY = 1; // DEGRADED or BROKEN
const EXIT_UNUSABLE = 2; // ledger or arguments unusable
const EXIT_REFUSED = 3; // a request that must not be honoured

const SEVERITIES = ["critical", "high", "medium", "low"];

// ------------------------------------------------------------------- paths

/** POSIX system directories that mean two different things on Windows. */

const baselinePath = (dir) => path.join(dir, "baseline.json");

function readJsonFile(file, what) {
  if (!fs.existsSync(file)) return { missing: true };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: `${file} could not be read (${e.code || e.message})` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `${what} at ${file} is not valid JSON (${e.message}), so nothing can be computed from it` };
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function readBaseline(dir) {
  const r = readJsonFile(baselinePath(dir), "baseline");
  if (r.missing) return { entries: {} };
  if (r.error) return { error: r.error };
  const v = r.value;
  if (!v || typeof v !== "object" || typeof v.entries !== "object" || v.entries === null) {
    return { error: `${baselinePath(dir)} has no "entries" object` };
  }
  return { entries: v.entries, capturedAt: v.capturedAt };
}

// ------------------------------------------------------------------ arguments

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function flagAll(args, name) {
  const vals = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) vals.push(args[i + 1]);
  return vals;
}

/** "90s", "10m", "1h", "45" (seconds). Returns ms, or null. */
function parseDuration(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return Math.round(n * mult);
}

function parseUrl(raw) {
  if (!raw) return { error: "a URL is required" };
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: `"${raw}" is not a URL. Include the scheme, for example https://example.com` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: `"${raw}" is not an http(s) URL (${u.protocol}), so it cannot be probed` };
  }
  return { url: u };
}

// -------------------------------------------------------------------- probing
//
// The whole point of doing this in Node: the process that reports the number is
// the process that measured it. There is no daemon in between that can be down
// while the report still reads clean.

const BUILD_SEARCH_LIMIT = 2 * 1024 * 1024;

async function httpProbe(rawUrl, { timeoutMs = 15000, build, headerOnly = false } = {}) {
  const parsed = parseUrl(rawUrl);
  if (parsed.error) return { transport: "bad-url", error: parsed.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

  try {
    const res = await fetch(parsed.url.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": `toolbay-stack-canary/${VERSION}`,
        // A canary that reads the CDN's copy of yesterday cannot see today's
        // deploy at all, which is the failure it is here to catch.
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    const buf = headerOnly ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
    const ms = Math.round(elapsed() * 10) / 10;

    const headerPairs = [];
    for (const [k, v] of res.headers.entries()) headerPairs.push(`${k}: ${v}`);
    const headerText = headerPairs.join("\n");
    const bodyText = buf.subarray(0, BUILD_SEARCH_LIMIT).toString("utf8");

    let buildMarker = "not-checked";
    let buildWhere = null;
    if (build) {
      if (headerText.includes(build)) {
        buildMarker = "found";
        buildWhere = "response header";
      } else if (bodyText.includes(build)) {
        buildMarker = "found";
        buildWhere = "response body";
      } else {
        buildMarker = "absent";
      }
    }

    let finalOrigin = null;
    try {
      finalOrigin = new URL(res.url || parsed.url.href).origin;
    } catch {
      finalOrigin = null;
    }

    return {
      transport: "ok",
      http: res.status,
      ms,
      bytes: buf.length,
      requestedOrigin: parsed.url.origin,
      finalUrl: res.url || parsed.url.href,
      finalOrigin,
      redirected: Boolean(res.redirected),
      buildMarker,
      buildWhere,
      bodyText,
      headerText,
    };
  } catch (e) {
    const ms = Math.round(elapsed() * 10) / 10;
    const aborted = e?.name === "AbortError" || controller.signal.aborted;
    const cause = e?.cause?.code || e?.code || null;
    return {
      transport: aborted ? "timeout" : "error",
      ms,
      error: aborted
        ? `no response within ${timeoutMs}ms`
        : `request failed${cause ? ` (${cause})` : ""}: ${e?.message ?? String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a transport result into a canary check. Every branch that cannot reach a
 * confident "this is the deploy I asked about, and it is serving" produces a
 * failure with a severity. There is no branch that produces silence.
 */
function judge(probe, opts) {
  const { expectStatus, bodyContains, build, allowRedirect, baseline, slowFactor } = opts;

  if (probe.transport === "bad-url") {
    return { status: "fail", severity: "critical", reason: "bad-url", detail: probe.error };
  }
  if (probe.transport === "timeout") {
    return {
      status: "fail",
      severity: "critical",
      reason: "timeout",
      detail: `${probe.error}. A canary that gets no answer has not observed a healthy deploy, it has observed nothing.`,
    };
  }
  if (probe.transport === "error") {
    return { status: "fail", severity: "critical", reason: "unreachable", detail: probe.error };
  }

  if (expectStatus !== undefined) {
    if (probe.http !== expectStatus) {
      return {
        status: "fail",
        severity: probe.http >= 500 ? "critical" : "high",
        reason: "status",
        detail: `expected HTTP ${expectStatus}, got ${probe.http}`,
      };
    }
  } else if (probe.http >= 500) {
    return { status: "fail", severity: "critical", reason: "server-error", detail: `HTTP ${probe.http}` };
  } else if (probe.http >= 400) {
    return { status: "fail", severity: "high", reason: "client-error", detail: `HTTP ${probe.http}` };
  }

  // A 200 that is really a login wall or an interstitial. Deployment protection
  // and auth redirects are how a "healthy" canary ends up describing a page the
  // deploy does not contain.
  if (probe.redirected && !allowRedirect && probe.finalOrigin && probe.finalOrigin !== probe.requestedOrigin) {
    return {
      status: "fail",
      severity: "high",
      reason: "redirected-off-origin",
      detail: `${probe.requestedOrigin} redirected to ${probe.finalUrl}. The body that answered is not from the origin under test. Pass --allow-redirect if that is expected.`,
    };
  }

  // The one gstack cannot see at all.
  if (build && probe.buildMarker !== "found") {
    return {
      status: "fail",
      severity: "critical",
      reason: "stale-build",
      detail:
        `HTTP ${probe.http} in ${probe.ms}ms, and the response does not contain "${build}". ` +
        `The origin is up and serving a DIFFERENT build than the one you deployed. ` +
        `This is what a build that went green and never aliased looks like from outside.`,
    };
  }

  if (bodyContains && !probe.bodyText.includes(bodyContains)) {
    return {
      status: "fail",
      severity: "high",
      reason: "content",
      detail: `HTTP ${probe.http} but the body does not contain "${bodyContains}" (${probe.bytes} bytes read)`,
    };
  }

  if (probe.bytes === 0 && !opts.headerOnly) {
    return {
      status: "fail",
      severity: "high",
      reason: "empty-body",
      detail: `HTTP ${probe.http} with a zero byte body`,
    };
  }

  if (baseline && typeof baseline.ms === "number" && baseline.ms > 0) {
    const ratio = probe.ms / baseline.ms;
    if (ratio >= slowFactor) {
      return {
        status: "fail",
        severity: "medium",
        reason: "latency",
        detail: `${probe.ms}ms against a ${baseline.ms}ms baseline (${Math.round(ratio * 10) / 10}x, threshold ${slowFactor}x)`,
      };
    }
  }

  return {
    status: "ok",
    severity: null,
    reason: "served",
    detail:
      `HTTP ${probe.http} in ${probe.ms}ms, ${probe.bytes} bytes` +
      (probe.buildMarker === "found" ? `, build marker found in the ${probe.buildWhere}` : ""),
  };
}

// ------------------------------------------------------------------- commands

function fail(json, message, code) {
  if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
  else err(`  ${code === EXIT_REFUSED ? "REFUSED" : "UNUSABLE"}  ${message}`);
  process.exitCode = code;
}

function openDir(args, json) {
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) {
    fail(json, res.error, EXIT_REFUSED);
    return null;
  }
  return res.dir;
}

function cmdInit(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const url = flag(args, "--url");
  const parsed = parseUrl(url);
  if (parsed.error) return fail(json, `--url is required: ${parsed.error}`, EXIT_UNUSABLE);

  const build = flag(args, "--build") ?? null;
  const ledger = {
    _comment:
      "Toolbay Stack canary ledger. Written by tb-canary.mjs. The verdict is computed from these records, not asserted.",
    target: parsed.url.href,
    expectBuild: build,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} node ${process.version}`,
    dir,
    checks: [],
  };
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  const file = writeJsonAtomic(ledgerPath(dir), ledger);
  if (json) return out(JSON.stringify({ ok: true, dir, ledger: file, expectBuild: build }, null, 2));
  out(`  target       ${ledger.target}`);
  out(`  build marker ${build ?? "(none given)"}`);
  out(`  dir          ${dir}`);
  out(`  screenshots  ${path.join(dir, "screenshots")}`);
  out(`  ledger       ${file}`);
  out();
  if (build) {
    out("  verdict will refuse HEALTHY until a probe proves that marker is being");
    out("  served. A deploy nobody confirmed reached the origin is not verified.");
  } else {
    out("  No --build marker given, so this run can prove the site answers but NOT");
    out("  that it is serving what you just deployed. Pass --build <commit|version>");
    out("  and make sure the app exposes it (a header, /version, or a meta tag).");
  }
}

async function doProbe(dir, args, { round = null, silent = false } = {}) {
  const state = readLedger(dir);
  if (state.error) return { error: state.error, code: EXIT_UNUSABLE };

  const url = flag(args, "--url") ?? state.ledger.target;
  const build = flag(args, "--build") ?? state.ledger.expectBuild ?? null;
  const timeoutMs = parseDuration(flag(args, "--timeout") ?? "15s") ?? 15000;
  const expectStatusRaw = flag(args, "--expect-status");
  if (expectStatusRaw !== undefined && !/^\d{3}$/.test(expectStatusRaw)) {
    return { error: "--expect-status must be a three digit status code", code: EXIT_UNUSABLE };
  }
  const slowFactor = Number(flag(args, "--slow-factor") ?? 2);
  if (!Number.isFinite(slowFactor) || slowFactor <= 1) {
    return { error: "--slow-factor must be a number greater than 1", code: EXIT_UNUSABLE };
  }

  const base = readBaseline(dir);
  if (base.error) return { error: base.error, code: EXIT_UNUSABLE };

  const opts = {
    expectStatus: expectStatusRaw === undefined ? undefined : Number(expectStatusRaw),
    bodyContains: flag(args, "--body-contains"),
    build,
    allowRedirect: args.includes("--allow-redirect"),
    baseline: base.entries[url],
    slowFactor,
    headerOnly: args.includes("--head"),
  };

  const probe = await httpProbe(url, { timeoutMs, build, headerOnly: opts.headerOnly });
  const verdict = judge(probe, opts);

  const id = flag(args, "--id") ?? `probe-${state.ledger.checks.length + 1}`;
  const check = {
    id,
    kind: "http",
    url,
    round,
    status: verdict.status,
    severity: verdict.severity,
    reason: verdict.reason,
    detail: verdict.detail,
    http: probe.http ?? null,
    ms: probe.ms ?? null,
    bytes: probe.bytes ?? null,
    finalUrl: probe.finalUrl ?? null,
    buildMarker: probe.buildMarker ?? (build ? "absent" : "not-checked"),
    at: new Date().toISOString(),
  };
  state.ledger.checks.push(check);
  writeJsonAtomic(ledgerPath(dir), state.ledger);

  if (!silent) {
    const tag = verdict.status === "ok" ? "OK  " : `${(verdict.severity || "fail").toUpperCase().slice(0, 4)}`;
    out(`  ${tag.padEnd(5)} ${id.padEnd(12)} ${url}`);
    out(`        ${verdict.detail}`);
  }
  return { check };
}

async function cmdProbe(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const r = await doProbe(dir, args, { silent: json });
  if (r.error) return fail(json, r.error, r.code);
  if (json) out(JSON.stringify({ ok: true, check: r.check }, null, 2));
  // A single probe does not decide the run; verdict does. But a critical
  // failure here should not exit 0, or a shell chain reads it as fine.
  if (r.check.status !== "ok") process.exitCode = EXIT_UNHEALTHY;
}

async function cmdBaseline(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const urls = flagAll(args, "--url");
  if (!urls.length) return fail(json, "--url is required (repeat it for more pages)", EXIT_UNUSABLE);
  const timeoutMs = parseDuration(flag(args, "--timeout") ?? "15s") ?? 15000;

  const entries = {};
  const rows = [];
  for (const u of urls) {
    const probe = await httpProbe(u, { timeoutMs });
    if (probe.transport !== "ok") {
      rows.push({ url: u, ok: false, detail: probe.error });
      continue;
    }
    entries[u] = { ms: probe.ms, http: probe.http, bytes: probe.bytes, at: new Date().toISOString() };
    rows.push({ url: u, ok: true, detail: `HTTP ${probe.http} in ${probe.ms}ms, ${probe.bytes} bytes` });
  }
  // A baseline built from pages that did not answer would make the post-deploy
  // comparison meaningless, so it is refused rather than written half-empty.
  const dead = rows.filter((r) => !r.ok);
  if (dead.length) {
    for (const d of dead) err(`  UNUSABLE  baseline for ${d.url} could not be captured: ${d.detail}`);
    err("  A baseline is the thing every later comparison is measured against. Refusing to write a partial one.");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const file = writeJsonAtomic(baselinePath(dir), {
    _comment: "Pre-deploy baseline. Captured by tb-canary.mjs baseline. Compared against by probe/watch.",
    capturedAt: new Date().toISOString(),
    entries,
  });
  if (json) return out(JSON.stringify({ ok: true, file, entries }, null, 2));
  for (const r of rows) out(`  ok    ${r.url}  ${r.detail}`);
  out(`\n  baseline ${file}`);
  out("  Deploy, then run: tb-canary.mjs init --url <url> --build <commit> && tb-canary.mjs watch");
}

function cmdRecord(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const state = readLedger(dir);
  if (state.error) return fail(json, state.error, EXIT_UNUSABLE);

  const id = flag(args, "--id");
  const desc = flag(args, "--check");
  const status = (flag(args, "--status") || "").toLowerCase();
  const severity = (flag(args, "--severity") || "high").toLowerCase();
  const evidence = flag(args, "--evidence");
  const force = args.includes("--force");

  const bad = [];
  if (!id) bad.push("--id is required");
  if (!desc) bad.push("--check is required (what was actually observed)");
  if (status !== "ok" && status !== "fail") bad.push("--status must be ok or fail");
  if (!SEVERITIES.includes(severity)) bad.push(`--severity must be one of ${SEVERITIES.join(", ")}`);
  if (bad.length) {
    if (json) out(JSON.stringify({ ok: false, errors: bad }, null, 2));
    else for (const b of bad) err(`  UNUSABLE  ${b}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const existing = state.ledger.checks.findIndex((c) => c.id === id);
  if (existing !== -1 && !force) {
    return fail(
      json,
      `${id} is already recorded as "${state.ledger.checks[existing].status}". Pass --force to overwrite, and say why in the report.`,
      EXIT_REFUSED,
    );
  }

  const check = {
    id,
    kind: "observation",
    check: desc,
    url: flag(args, "--url") ?? null,
    status,
    severity: status === "fail" ? severity : null,
    evidence: evidence ?? null,
    note: flag(args, "--note") ?? null,
    at: new Date().toISOString(),
  };
  if (existing !== -1) state.ledger.checks[existing] = check;
  else state.ledger.checks.push(check);
  writeJsonAtomic(ledgerPath(dir), state.ledger);

  const ev = verifyObservation(check, dir);
  if (json) return out(JSON.stringify({ ok: true, check, evidence: ev }, null, 2));
  out(`  recorded  ${id}  ${status}  ${desc}`);
  if (!ev.verified) for (const r of ev.reasons) out(`            ! ${r}`);
}

async function cmdWatch(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const state = readLedger(dir);
  if (state.error) return fail(json, state.error, EXIT_UNUSABLE);

  const duration = parseDuration(flag(args, "--duration") ?? "10m");
  const interval = parseDuration(flag(args, "--interval") ?? "60s");
  if (duration === null || interval === null) {
    return fail(json, "--duration and --interval take values like 90s, 10m, 1h", EXIT_UNUSABLE);
  }
  if (duration < 1000 || duration > 30 * 60000) {
    return fail(json, "--duration must be between 1s and 30m", EXIT_UNUSABLE);
  }
  if (interval < 100) return fail(json, "--interval must be at least 100ms", EXIT_UNUSABLE);

  const urls = flagAll(args, "--url");
  const targets = urls.length ? urls : [state.ledger.target];
  const rounds = Math.max(1, Math.floor(duration / interval) + 1);

  if (!json) {
    out(`  watching ${targets.length} url(s) for ${Math.round(duration / 1000)}s, every ${Math.round(interval / 1000)}s (${rounds} rounds)`);
    out("  the wait happens in this process, so there is no shell timer to get wrong");
    out();
  }
  const startedAt = Date.now();
  for (let round = 1; round <= rounds; round += 1) {
    for (const u of targets) {
      const perUrl = args.filter((a) => a !== "--json");
      const stripped = [];
      for (let i = 0; i < perUrl.length; i += 1) {
        if (perUrl[i] === "--url") {
          i += 1;
          continue;
        }
        stripped.push(perUrl[i]);
      }
      const r = await doProbe(dir, [...stripped, "--url", u, "--id", `round${round}-${targets.indexOf(u) + 1}`], {
        round,
        silent: json,
      });
      if (r.error) return fail(json, r.error, r.code);
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, interval));
  }
  const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
  if (json) out(JSON.stringify({ ok: true, rounds, targets, elapsedSeconds: elapsed }, null, 2));
  else out(`\n  ${rounds} round(s) over ${elapsed}s recorded. Now run: tb-canary.mjs verdict`);
}

// ------------------------------------------------------------------- evidence

function verifyObservation(check, dir) {
  const reasons = [];
  if (check.status === "fail") return { verified: true, reasons };
  if (!check.evidence) {
    reasons.push("no artifact recorded, so this observation is one sentence with nothing behind it");
    return { verified: false, reasons };
  }
  const abs = path.isAbsolute(check.evidence) ? check.evidence : path.resolve(dir, check.evidence);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    st = null;
  }
  if (!st) reasons.push(`evidence file ${abs} does not exist`);
  else if (!st.isFile()) reasons.push(`evidence path ${abs} is not a file`);
  else if (st.size === 0) reasons.push(`evidence file ${abs} is 0 bytes (a failed screenshot writes an empty file)`);
  return { verified: reasons.length === 0, reasons };
}

// -------------------------------------------------------------------- verdict

function computeVerdict(dir, { consecutive = 2 } = {}) {
  const state = readLedger(dir);
  if (state.error) return { error: state.error };
  const dirAbs = dir;

  const checks = state.ledger.checks.map((c) => {
    if (c.kind === "observation") {
      const ev = verifyObservation(c, dirAbs);
      if (c.status === "ok" && !ev.verified) {
        return { ...c, effective: "unverified", effectiveSeverity: "high", evidenceReasons: ev.reasons };
      }
      return { ...c, effective: c.status, effectiveSeverity: c.severity, evidenceReasons: [] };
    }
    return { ...c, effective: c.status, effectiveSeverity: c.severity, evidenceReasons: [] };
  });

  // gstack's transient-tolerance rule, applied where it belongs. A slow page
  // once is noise. A page that is GONE once is not noise, and demoting that to
  // "wait and see" is how a --quick run can never alert on anything.
  const latencyByUrl = new Map();
  for (const c of checks) {
    if (c.kind !== "http") continue;
    const seq = latencyByUrl.get(c.url) ?? [];
    seq.push(c.reason === "latency");
    latencyByUrl.set(c.url, seq);
  }
  const confirmedLatencyUrls = new Set();
  for (const [url, seq] of latencyByUrl) {
    let run = 0;
    for (const isSlow of seq) {
      run = isSlow ? run + 1 : 0;
      if (run >= consecutive) confirmedLatencyUrls.add(url);
    }
  }
  for (const c of checks) {
    if (c.effective === "fail" && c.reason === "latency" && !confirmedLatencyUrls.has(c.url)) {
      c.effective = "tolerated";
      c.effectiveSeverity = null;
      c.toleratedBecause = `slow once, and a latency alert needs ${consecutive} consecutive slow rounds on the same url`;
    }
  }

  const problems = checks.filter((c) => c.effective === "fail" || c.effective === "unverified");
  const critical = problems.filter((c) => c.effectiveSeverity === "critical");
  const httpChecks = checks.filter((c) => c.kind === "http");
  const buildVerified = httpChecks.some((c) => c.buildMarker === "found");

  const reasons = [];
  let verdict = "HEALTHY";

  if (checks.length === 0) {
    verdict = "BROKEN";
    reasons.push("no checks were recorded. An empty canary run is not a healthy deploy, it is an unobserved one.");
  }
  if (critical.length) {
    verdict = "BROKEN";
    for (const c of critical) reasons.push(`${c.id}: ${c.reason} — ${c.detail ?? c.check}`);
  }
  // The rule gstack has no equivalent of: you named the build you deployed, and
  // nothing ever saw it being served.
  if (checks.length && state.ledger.expectBuild && !buildVerified) {
    verdict = "BROKEN";
    reasons.push(
      `no check ever confirmed build marker "${state.ledger.expectBuild}" was served by ${state.ledger.target}. ` +
        `The site may be perfectly healthy on the PREVIOUS build. Run: tb-canary.mjs probe --build ${state.ledger.expectBuild}`,
    );
  }
  if (verdict === "HEALTHY" && problems.length) {
    verdict = "DEGRADED";
    for (const c of problems) {
      reasons.push(
        c.effective === "unverified"
          ? `${c.id}: claimed ok with no usable artifact — ${c.evidenceReasons.join("; ")}`
          : `${c.id}: ${c.reason} — ${c.detail ?? c.check}`,
      );
    }
  }

  return {
    target: state.ledger.target,
    expectBuild: state.ledger.expectBuild ?? null,
    buildVerified,
    dir: dirAbs,
    checks,
    total: checks.length,
    ok: checks.filter((c) => c.effective === "ok" || c.effective === "tolerated").length,
    problems: problems.length,
    critical: critical.length,
    verdict,
    reasons,
    healthy: verdict === "HEALTHY",
  };
}

function cmdVerdict(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const consecutive = Number(flag(args, "--consecutive") ?? 2);
  if (!Number.isInteger(consecutive) || consecutive < 1) {
    return fail(json, "--consecutive must be a positive integer", EXIT_UNUSABLE);
  }
  const v = computeVerdict(dir, { consecutive });
  if (v.error) return fail(json, v.error, EXIT_UNUSABLE);

  if (json) {
    out(JSON.stringify(v, null, 2));
  } else {
    out();
    out(`  target        ${v.target}`);
    out(`  build marker  ${v.expectBuild ?? "(none)"}  ${v.expectBuild ? (v.buildVerified ? "SERVED" : "NEVER SEEN") : ""}`);
    out(`  checks        ${v.total}`);
    for (const c of v.checks) {
      const label = c.effective.toUpperCase().padEnd(11);
      out(`    ${label} ${String(c.id).padEnd(14)} ${c.url ?? ""} ${c.kind === "http" ? "" : c.check}`);
      if (c.effective !== "ok") {
        if (c.detail) out(`                 ${c.detail}`);
        if (c.toleratedBecause) out(`                 ${c.toleratedBecause}`);
        for (const r of c.evidenceReasons) out(`                 ! ${r}`);
      }
    }
    out();
    out(`  ${v.verdict}${v.verdict === "HEALTHY" ? `  ${v.ok}/${v.total} checks clean` : ""}`);
    for (const r of v.reasons) out(`     - ${r}`);
    out();
  }
  if (!v.healthy) process.exitCode = EXIT_UNHEALTHY;
}

// ------------------------------------------------------------------ selftest
//
// The selftest runs a real HTTP server in this process and drives the real CLI
// against it as child processes, because that is how it is actually used. Every
// case below is a way a post-deploy check reports success without having
// established anything.

/**
 * The fixture web server, run as its OWN process (`tb-canary.mjs __fixture`).
 *
 * It cannot live in the selftest process. The selftest drives the real CLI with
 * spawnSync, and spawnSync blocks the caller's event loop for the whole life of
 * the child, so a server in that process could never answer the request the
 * child is making. Measured: every probe sat until its 15s timeout and the
 * suite hung. Same class of mistake as the ones this skill exists to catch, so
 * it is written down rather than quietly fixed.
 */
function runFixture() {
  const state = { delay: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body, headers = {}) => {
      const finish = () => {
        res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
        res.end(body);
      };
      if (state.delay > 0) setTimeout(finish, state.delay);
      else finish();
    };
    switch (url.pathname) {
      case "/":
        return send(200, '<html><head><meta name="build" content="GOOD123"></head><body>home</body></html>');
      case "/stale":
        return send(200, '<html><head><meta name="build" content="OLD456"></head><body>home</body></html>');
      case "/header-build":
        return send(200, "<html><body>no marker in the body</body></html>", { "x-build-id": "GOOD123" });
      case "/boom":
        return send(500, "internal error");
      case "/gone":
        return send(404, "not found");
      case "/empty":
        return send(200, "");
      case "/hang":
        return; // never responds, on purpose
      case "/protected":
        // A different host string is a different origin, which is what a
        // deployment-protection wall looks like from the outside.
        return send(302, "", { location: `http://localhost:${server.address().port}/login` });
      case "/login":
        return send(200, "<html><body>sign in</body></html>");
      case "/set-delay":
        state.delay = Number(url.searchParams.get("ms") || 0);
        return send(200, `delay=${state.delay}`);
      default:
        return send(404, "not found");
    }
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`PORT ${server.address().port}\n`);
  });
}

function startFixtureServer() {
  const child = spawn(process.execPath, [SELF, "__fixture"], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the selftest fixture server did not report a port within 10s"));
    }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /^PORT (\d+)/m.exec(buf);
      if (!m) return;
      clearTimeout(timer);
      const port = Number(m[1]);
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        setDelay: async (ms) => {
          const res = await fetch(`http://127.0.0.1:${port}/set-delay?ms=${ms}`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`fixture would not accept a delay of ${ms}ms`);
        },
        close: () => child.kill(),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (!/^PORT /m.test(buf)) {
        clearTimeout(timer);
        reject(new Error(`the selftest fixture server exited with code ${code} before serving`));
      }
    });
  });
}

function runSelf(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function findClosedPort() {
  // Bind, read the port, close it. Nothing is listening there afterwards, which
  // is the cheapest honest way to produce a refused connection.
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function selftest() {
  const fixture = await startFixtureServer();
  const deadPort = await findClosedPort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-canary-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const shot = (n, bytes) => {
    const p = path.join(tmp, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  const verdictOf = (run) => {
    const r = runSelf(["verdict", "--json", ...D(run)]);
    let parsed = {};
    try {
      parsed = JSON.parse(r.stdout || "{}");
    } catch {
      parsed = {};
    }
    return { status: r.status, verdict: parsed.verdict ?? "(unparseable)", json: parsed, raw: `${r.stdout}${r.stderr}` };
  };

  try {
    // ---- init
    {
      const r = runSelf(["init", "--json", "--url", fixture.base, "--build", "GOOD123", ...D("run1")]);
      check("init creates a ledger", 0, r.status, r.stderr.trim());
      const j = JSON.parse(r.stdout || "{}");
      check("init reports an absolute directory", true, Boolean(j.dir) && path.isAbsolute(j.dir), j.dir);
    }
    check("init requires a url", 2, runSelf(["init", "--json", ...D("run-nourl")]).status);
    check("init rejects a non-http url", 2, runSelf(["init", "--json", "--url", "ftp://x/y", ...D("run-ftp")]).status);
    if (isWindows) {
      const r = runSelf(["init", "--url", fixture.base, "--dir", "/tmp/canary"]);
      check("init refuses /tmp on Windows, where it means two directories", 3, r.status);
      const said = `${r.stdout}${r.stderr}`;
      check(
        "...and names both of them",
        true,
        /AppData[\\/]Local[\\/]Temp/.test(said) && /C:[\\/]tmp[\\/]canary/.test(said),
        said.trim().slice(0, 160),
      );
    }

    // ---- the run has to contain something
    check("verdict before any check is BROKEN, not healthy", 1, verdictOf("run1").status);
    check("...and says so", "BROKEN", verdictOf("run1").verdict);
    check("verdict with no ledger at all is unusable, not a pass", 2, runSelf(["verdict", "--json", ...D("never-inited")]).status);
    {
      const dir = path.join(tmp, "corrupt");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ledgerPath(dir), "{ not json", "utf8");
      check("verdict on a corrupt ledger is unusable, not a pass", 2, runSelf(["verdict", "--json", "--dir", dir]).status);
    }
    check("probe before init is unusable", 2, runSelf(["probe", "--json", "--url", fixture.base, ...D("never-inited")]).status);

    // ---- the happy path really passes, or nothing below means anything
    {
      runSelf(["init", "--url", fixture.base, "--build", "GOOD123", ...D("good")]);
      const p = runSelf(["probe", "--json", ...D("good")]);
      check("probe against a live origin serving the right build succeeds", 0, p.status, p.stderr.trim());
      const j = JSON.parse(p.stdout || "{}");
      check("...and records a real measured latency", true, typeof j.check?.ms === "number" && j.check.ms >= 0, JSON.stringify(j.check?.ms));
      check("...and finds the build marker", "found", j.check?.buildMarker ?? "(none)");
      const v = verdictOf("good");
      check("verdict is HEALTHY and exits 0", 0, v.status, v.raw.slice(0, 200));
      check("...with verdict HEALTHY", "HEALTHY", v.verdict);
    }

    // ---- THE ONE gstack CANNOT SEE: up, fast, clean, and serving the old build
    {
      runSelf(["init", "--url", `${fixture.base}/stale`, "--build", "GOOD123", ...D("stale")]);
      const p = runSelf(["probe", "--json", ...D("stale")]);
      const j = JSON.parse(p.stdout || "{}");
      check("a 200 that does not carry the deployed build marker FAILS", "fail", j.check?.status ?? "(none)");
      check("...as critical, not a warning", "critical", j.check?.severity ?? "(none)");
      check("...for the stated reason", "stale-build", j.check?.reason ?? "(none)");
      const v = verdictOf("stale");
      check("...and the whole run is BROKEN despite HTTP 200", "BROKEN", v.verdict);
      check("...exit 1", 1, v.status);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/header-build`, "--build", "GOOD123", ...D("hdr")]);
      runSelf(["probe", ...D("hdr")]);
      check("a build marker in a response HEADER counts", "HEALTHY", verdictOf("hdr").verdict);
    }
    {
      // You named the build and then never checked it. Silence is not health.
      runSelf(["init", "--url", fixture.base, "--build", "GOOD123", ...D("unchecked")]);
      runSelf(["record", ...D("unchecked"), "--id", "OBS-1", "--check", "console is clean", "--status", "ok", "--evidence", shot("unchecked/shot.png", 4096)]);
      const v = verdictOf("unchecked");
      check("a run that never confirmed the deployed build cannot be HEALTHY", "BROKEN", v.verdict);
      check("...exit 1", 1, v.status);
    }

    // ---- a check that could not run is a failure, never silence
    {
      runSelf(["init", "--url", `http://127.0.0.1:${deadPort}/`, ...D("refused")]);
      const p = runSelf(["probe", "--json", ...D("refused")]);
      const j = JSON.parse(p.stdout || "{}");
      check("a refused connection is recorded as a failure", "fail", j.check?.status ?? "(none)");
      check("...as critical", "critical", j.check?.severity ?? "(none)");
      check("...and the run is BROKEN", "BROKEN", verdictOf("refused").verdict);
      check("...probe itself exits non-zero", 1, p.status);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/hang`, ...D("timeout")]);
      const p = runSelf(["probe", "--json", ...D("timeout"), "--timeout", "400ms"]);
      const j = JSON.parse(p.stdout || "{}");
      check("a request that never answers times out as a failure", "timeout", j.check?.reason ?? "(none)");
      check("...and the run is BROKEN", "BROKEN", verdictOf("timeout").verdict);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/boom`, ...D("boom")]);
      runSelf(["probe", ...D("boom")]);
      check("a 500 is BROKEN on the FIRST observation (gstack waits for a second)", "BROKEN", verdictOf("boom").verdict);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/gone`, ...D("gone")]);
      runSelf(["probe", ...D("gone")]);
      check("a 404 is not healthy", "DEGRADED", verdictOf("gone").verdict);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/empty`, ...D("empty")]);
      runSelf(["probe", ...D("empty")]);
      check("a 200 with a zero byte body is not healthy", "DEGRADED", verdictOf("empty").verdict);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/protected`, ...D("prot")]);
      runSelf(["probe", ...D("prot")]);
      check("a 200 reached by redirect to another origin is not healthy", "DEGRADED", verdictOf("prot").verdict);
      runSelf(["init", "--url", `${fixture.base}/protected`, ...D("prot2")]);
      runSelf(["probe", ...D("prot2"), "--allow-redirect"]);
      check("...unless --allow-redirect says it is expected", "HEALTHY", verdictOf("prot2").verdict);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/`, ...D("expect")]);
      runSelf(["probe", ...D("expect"), "--expect-status", "204"]);
      check("--expect-status mismatch fails", "DEGRADED", verdictOf("expect").verdict);
      check("--expect-status rejects a non-status value", 2, runSelf(["probe", "--json", ...D("expect"), "--expect-status", "20"]).status);
    }
    {
      runSelf(["init", "--url", `${fixture.base}/`, ...D("content")]);
      runSelf(["probe", ...D("content"), "--body-contains", "checkout button"]);
      check("--body-contains that is absent fails", "DEGRADED", verdictOf("content").verdict);
    }

    // ---- screenshots are only evidence if they exist
    {
      runSelf(["init", "--url", fixture.base, ...D("obs")]);
      runSelf(["probe", ...D("obs")]);
      runSelf(["record", ...D("obs"), "--id", "OBS-1", "--check", "no console errors", "--status", "ok", "--evidence", shot("obs/zero.png", 0)]);
      const v = verdictOf("obs");
      check("an observation backed by a 0-byte screenshot is not healthy", "DEGRADED", v.verdict);
      check("...and is marked unverified, not ok", "unverified", v.json.checks?.find((c) => c.id === "OBS-1")?.effective ?? "(none)");
    }
    {
      runSelf(["init", "--url", fixture.base, ...D("obs2")]);
      runSelf(["probe", ...D("obs2")]);
      runSelf(["record", ...D("obs2"), "--id", "OBS-1", "--check", "no console errors", "--status", "ok", "--evidence", path.join(tmp, "obs2", "missing.png")]);
      check("an observation pointing at a missing artifact is not healthy", "DEGRADED", verdictOf("obs2").verdict);
    }
    {
      runSelf(["init", "--url", fixture.base, ...D("obs3")]);
      runSelf(["probe", ...D("obs3")]);
      runSelf(["record", ...D("obs3"), "--id", "OBS-1", "--check", "no console errors", "--status", "ok"]);
      check("an observation with no artifact at all is not healthy", "DEGRADED", verdictOf("obs3").verdict);
    }
    {
      runSelf(["init", "--url", fixture.base, ...D("obs4")]);
      runSelf(["record", ...D("obs4"), "--id", "OBS-1", "--check", "layout intact", "--status", "fail", "--severity", "high"]);
      const r = runSelf(["record", "--json", ...D("obs4"), "--id", "OBS-1", "--check", "layout intact", "--status", "ok", "--evidence", shot("obs4/a.png", 64)]);
      check("silently overwriting a recorded failure is refused", 3, r.status);
      check("...and --force is required to change it", 0, runSelf(["record", "--json", ...D("obs4"), "--force", "--id", "OBS-1", "--check", "layout intact", "--status", "ok", "--evidence", shot("obs4/a.png", 64)]).status);
    }

    // ---- baseline and the transient rule
    {
      const dir = D("base");
      const b = runSelf(["baseline", "--json", ...dir, "--url", `${fixture.base}/`]);
      check("baseline captures a pre-deploy latency", 0, b.status, b.stderr.trim());
      const dead = runSelf(["baseline", "--json", "--dir", path.join(tmp, "base-dead"), "--url", `http://127.0.0.1:${deadPort}/`]);
      check("a baseline whose page did not answer is refused, not written half-empty", 2, dead.status);
      check("...and no baseline file was left behind", false, fs.existsSync(baselinePath(path.join(tmp, "base-dead"))));

      runSelf(["init", "--url", `${fixture.base}/`, ...dir]);
      await fixture.setDelay(350);
      runSelf(["probe", ...dir, "--timeout", "5s"]);
      const one = verdictOf("base");
      check("one slow round alone does not fire a latency alert", "HEALTHY", one.verdict);
      check("...and says why it was tolerated", true, /consecutive/.test(JSON.stringify(one.json)), "");
      runSelf(["probe", ...dir, "--timeout", "5s"]);
      check("two consecutive slow rounds do", "DEGRADED", verdictOf("base").verdict);
      await fixture.setDelay(0);
    }

    // ---- watch does its own waiting
    {
      runSelf(["init", "--url", fixture.base, "--build", "GOOD123", ...D("watch")]);
      const started = Date.now();
      const w = runSelf(["watch", "--json", ...D("watch"), "--duration", "2s", "--interval", "1s"]);
      const elapsed = Date.now() - started;
      check("watch runs its own timer", 0, w.status, w.stderr.trim());
      const j = JSON.parse(w.stdout || "{}");
      check("...for the requested number of rounds", 3, j.rounds ?? 0);
      check("...and really waited (>=2s of wall clock)", true, elapsed >= 2000, `${elapsed}ms`);
      const v = verdictOf("watch");
      check("...recording one check per round", 3, v.json.total ?? 0);
      check("...and the watched deploy is HEALTHY", "HEALTHY", v.verdict);
      check("watch refuses a duration over 30m", 2, runSelf(["watch", "--json", ...D("watch"), "--duration", "45m"]).status);
      check("watch refuses a duration it cannot parse", 2, runSelf(["watch", "--json", ...D("watch"), "--duration", "soon"]).status);
    }
  } finally {
    fixture.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return report("tb-canary", results);
}

// --------------------------------------------------------------------- output

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
  process.stdout.write("\n  Every case above is a way a post-deploy check reports success without\n");
  process.stdout.write("  having established anything: nothing checked, the origin unreachable, the\n");
  process.stdout.write("  request never answered, a 500, a login wall behind a redirect, a screenshot\n");
  process.stdout.write("  that is 0 bytes, and the big one, a fast clean 200 serving the build you\n");
  process.stdout.write("  did NOT just deploy. None of them can reach HEALTHY here.\n\n");
  return true;
}

function help() {
  out(`
  tb-canary ${VERSION}  (Toolbay Stack)

  Before the deploy:
    baseline --url <u> [--url <u2>]      record pre-deploy latency to compare against

  After the deploy:
    init --url <u> [--build <marker>]    start a run. --build is the commit, version
                                         or asset hash the live site must expose
    probe [--url <u>] [--build <m>]      one real HTTP request, judged and recorded
           [--expect-status N] [--body-contains "<s>"] [--timeout 15s]
           [--allow-redirect] [--slow-factor 2] [--head] [--id <id>]
    watch  [--duration 10m] [--interval 60s] [--url <u>]...
                                         repeat probe on its own timer, in process
    record --id <id> --check "<what>" --status ok|fail [--evidence <file>]
                                         a browser observation (console, screenshot)
    verdict [--consecutive 2]            HEALTHY / DEGRADED / BROKEN, computed

  Options: --json, --dir <d>

  BROKEN on the first observation: unreachable, timeout, 5xx, and a 200 that does
  not carry the build marker you deployed. Latency needs --consecutive rounds
  before it counts. An empty run is BROKEN. If you passed --build and no check
  ever saw it served, the run is BROKEN even if every page loads, because a site
  happily serving the PREVIOUS build is exactly what a deploy that never aliased
  looks like from outside.

  Exit: 0 healthy, 1 degraded or broken, 2 ledger/arguments unusable, 3 refused.
`);
}

// ---------------------------------------------------------------------- entry

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

if (cmd === "init") cmdInit(rest);
else if (cmd === "baseline") await cmdBaseline(rest);
else if (cmd === "probe") await cmdProbe(rest);
else if (cmd === "watch") await cmdWatch(rest);
else if (cmd === "record") cmdRecord(rest);
else if (cmd === "verdict") cmdVerdict(rest);
else if (cmd === "selftest") await selftest();
else if (cmd === "__fixture") runFixture(); // selftest support, not a user command
else help();
