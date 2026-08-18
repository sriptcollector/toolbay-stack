#!/usr/bin/env node
/**
 * tb-land.mjs: the landing ledger behind the /land-and-deploy workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow this supports (merge the PR, wait for CI, watch
 * the merge queue, detect the deploy platform, canary the live site, offer a
 * revert, print a land-and-deploy report) comes from `land-and-deploy` in
 * gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's land-and-deploy ends by printing `VERDICT: DEPLOYED AND VERIFIED`.
 * Nothing in the skill ever compares the merge commit against what the live URL
 * is actually serving, so that verdict survives every way a deploy dies green:
 *
 * 1. NOBODY CHECKS THE ALIAS. Step 6 Strategy C is the whole Vercel/Netlify
 *    path: "Vercel and Netlify deploy automatically on merge. No explicit
 *    deploy trigger needed. Wait 60 seconds for the deploy to propagate, then
 *    proceed directly to canary verification." Step 7's canary then asks four
 *    questions: 200 status, no console errors, non-blank page, under 10s. A
 *    paused Vercel account keeps serving the PREVIOUS deployment on the alias.
 *    It answers 200, clean console, real content, fast. All four checks pass,
 *    and the skill reports the new code as verified while prod is a build
 *    behind. Here a live probe that cannot find the merge SHA is `stale` or
 *    `unproven`, never `pass`, and both exit non-zero.
 *
 * 2. EXIT 0 IS TREATED AS EVIDENCE. A `vercel --prod` run against an account
 *    with an overdue balance builds, prints its Inspect URL, exits 0, and never
 *    aliases. `scan` refuses to call any deploy log a success unless an explicit
 *    alias/live line is present, and classifies that exact shape as
 *    `built-not-aliased`.
 *
 * 3. BILLING BLOCKS ARE NOT A DEPLOY FAILURE, THEY ARE A STOP. gstack's Step 6
 *    failure branch offers "look at the logs / revert / continue anyway" and
 *    otherwise loops. Retrying a 402 fails identically forever. `billing` is its
 *    own classification with its own exit code (4) so a caller can stop instead
 *    of retrying.
 *
 * 4. THE "CONFIG CHANGED, RE-VALIDATE" PROMISE DOES NOT FIRE. gstack Step 1.5
 *    fingerprints the deploy setup as
 *      sed -n '/## Deploy Configuration/,/^## /p' CLAUDE.md | shasum -a 256
 *      find .github/workflows -maxdepth 1 \( -name '*deploy*' -o -name '*cd*' \) | xargs cat | shasum -a 256
 *    Measured in Git Bash on Windows 11 in a repo that deploys with
 *    `railway up`, 2026-08-13:
 *      COMBINED=[e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855-
 *                e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855]
 *    Both halves are the SHA-256 of the empty string. Every project whose deploy
 *    config is not a `## Deploy Configuration` heading in CLAUDE.md plus a
 *    workflow file named "deploy" or "cd" has a CONSTANT fingerprint: rewrite
 *    vercel.json, swap Vercel for Railway, change the production domain, and it
 *    still compares equal, so the re-validation never triggers. `fingerprint`
 *    hashes the files that actually decide where a deploy goes.
 *
 * The ledger is a plain JSON file, and every command is deterministic and
 * offline-testable. The value is not the code, it is that the verdict is
 * computed from recorded facts instead of narrated.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS } from "./tb-outdir.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger; shared reader/writer in src/ledger/tb-ledger.mjs. The
// merge SHA check is this skill's: without one there is nothing to compare the
// live site against.
const LEDGER_FILE = "landing.json";
const ledgerPath = (dir) => ledgerPathShared(dir, LEDGER_FILE);
function readLedger(dir) {
  return readLedgerShared(dir, {
    file: LEDGER_FILE,
    what: "landing ledger",
    hint: 'Run "tb-land.mjs init --pr <n> --sha <merge-sha>" before the merge. A landing nobody recorded is a landing nobody can verify.',
    validate: (obj, file) =>
      typeof obj.sha === "string" && /^[0-9a-f]{7,40}$/i.test(obj.sha)
        ? null
        : `${file} has no usable merge SHA, so there is nothing to compare the live site against`,
  });
}
function writeLedger(dir, ledger) {
  return writeLedgerShared(dir, ledger, { file: LEDGER_FILE });
}


const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_NOT_LIVE = 1; // the change is not provably live
const EXIT_UNUSABLE = 2; // arguments or ledger cannot be used
const EXIT_REFUSED = 3; // a request that must not be honoured
const EXIT_BILLING = 4; // the platform is blocking on billing: do not retry

// ------------------------------------------------------------------- paths
//
// Same Windows path handling as the rest of Toolbay Stack. /tmp is two
// different directories on this platform, so a run that writes a deploy log to
// one and reads it from the other silently verifies nothing.

function resolveDir(raw, fallbackName) {
  if (!raw) {
    return {
      ok: true,
      dir: path.resolve(process.env.TOOLBAY_LAND_DIR || path.join(process.cwd(), ".toolbay", fallbackName)),
    };
  }
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (isWindows && AMBIGUOUS_ON_WINDOWS.test(s)) {
    return {
      ok: false,
      error:
        `"${s}" means two different directories on this machine. Git Bash resolves it under ${os.tmpdir()}, ` +
        `and Node, Python and PowerShell resolve it to ${path.resolve(s)}. A deploy log written to one and ` +
        `read from the other verifies nothing. Pass a real path, or omit --dir to use ` +
        `${path.join(process.cwd(), ".toolbay", fallbackName)}.`,
    };
  }
  const msys = fromMsysPath(s);
  return { ok: true, dir: path.resolve(looksAbsolute(msys) ? msys : path.join(process.cwd(), msys)) };
}


// --------------------------------------------------------- deploy log scanner
//
// Every pattern below is a line a real deploy CLI prints. The rule that makes
// this different from reading an exit code: NOTHING is a success unless the log
// says, in so many words, that a deployment became the live one. Silence is not
// success, and a build that finished is not a deploy that landed.

const BILLING = [
  { id: "vercel_deployment_disabled", re: /DEPLOYMENT_DISABLED/i, note: "Vercel serves 402 DEPLOYMENT_DISABLED while the account is paused" },
  { id: "payment_method", re: /add a valid payment method|payment method (?:is )?(?:required|declined|invalid)/i, note: "the platform is refusing to deploy until billing is fixed" },
  { id: "account_paused", re: /account (?:is |has been )?(?:paused|suspended|locked|disabled|on hold)/i, note: "the account itself is paused" },
  { id: "past_due", re: /past due|overdue (?:balance|invoice)|unpaid invoice|outstanding balance|billing issue/i, note: "there is an unpaid balance" },
  { id: "http_402", re: /\b402\b[^\n]{0,40}payment required|payment required[^\n]{0,40}\b402\b/i, note: "HTTP 402 Payment Required" },
  { id: "usage_limit", re: /(?:exceeded|reached)[^\n]{0,30}(?:usage|spend(?:ing)?|resource) limit|free (?:tier|plan) limit reached/i, note: "a plan limit is blocking the deploy" },
];

const FAILED = [
  { id: "build_failed", re: /\bbuild failed\b|\bbuild error\b/i },
  { id: "deploy_failed", re: /\bdeploy(?:ment)? failed\b|failed to deploy/i },
  { id: "command_exited", re: /command "[^"]*" exited with \d+/i },
  { id: "error_line", re: /^\s*(?:Error|error):\s+\S/m },
  { id: "fatal", re: /^\s*fatal:\s+\S/m },
];

// A live line: the deployment is now the thing the world sees.
const LIVE = [
  { id: "vercel_aliased", re: /\baliased?\s+to\s+(\S+)/i, platform: "vercel" },
  { id: "vercel_production", re: /^\s*(?:[^\sA-Za-z0-9]*\s*)?Production:\s*(https?:\/\/\S+)/mi, platform: "vercel" },
  { id: "vercel_domains_assigned", re: /(?:assigned|assigning) (?:custom )?domains?[^\n]*?(https?:\/\/\S+|\S+\.\S+)/i, platform: "vercel" },
  { id: "netlify_live", re: /deploy is live!?[\s\S]{0,400}?^\s*Website URL:\s*(https?:\/\/\S+)/mi, platform: "netlify" },
  { id: "netlify_website_url", re: /^\s*Website URL:\s*(https?:\/\/\S+)/mi, platform: "netlify" },
  { id: "railway_live", re: /deployment (?:is )?(?:live|successful|succeeded)|deploy complete[\s\S]{0,80}?(https?:\/\/\S+)?/i, platform: "railway" },
  { id: "fly_deployed", re: /\bv\d+ deployed successfully\b|visit your newly deployed app at\s+(https?:\/\/\S+)/i, platform: "fly" },
  { id: "generic_deployment_ok", re: /deployment (?:succeeded|was successful|promoted to production)/i, platform: "generic" },
];

// A built line: something finished, and nothing says it went live. This is the
// exact shape of a Vercel deploy on a paused account.
const BUILT = [
  { id: "vercel_inspect", re: /^\s*(?:[^\sA-Za-z0-9]*\s*)?Inspect:\s*(https?:\/\/\S+)/mi },
  { id: "vercel_build_completed", re: /build completed|compiled successfully|uploading build outputs/i },
  { id: "netlify_draft", re: /^\s*Website Draft URL:\s*(https?:\/\/\S+)/mi },
  { id: "railway_uploaded", re: /\b(?:indexed|uploaded|compressed)\b[\s\S]{0,200}?build logs:\s*(https?:\/\/\S+)|build logs:\s*(https?:\/\/\S+)/i },
  { id: "generic_build_ok", re: /build (?:succeeded|complete|finished)/i },
];

/**
 * @returns {{class:"billing"|"failed"|"aliased"|"built-not-aliased"|"unknown",
 *            reason:string, marker:string|null, target:string|null}}
 *
 * Order is the safety property. Billing beats everything, because a log can
 * contain a cached success line from an earlier attempt and still end in a 402.
 * Failure beats success for the same reason. Only then can a live line win, and
 * a build line alone can never win.
 */
function classifyDeployLog(text) {
  const s = String(text ?? "");
  if (!s.trim()) {
    return { class: "unknown", reason: "the deploy log is empty, so nothing about this deploy was observed", marker: null, target: null };
  }

  for (const p of BILLING) {
    const m = p.re.exec(s);
    if (m) {
      return {
        class: "billing",
        reason: `${p.note} (matched "${firstLine(m[0])}"). Every further deploy fails identically until the balance is cleared. Do not retry.`,
        marker: p.id,
        target: null,
      };
    }
  }

  for (const p of FAILED) {
    const m = p.re.exec(s);
    if (m) {
      return { class: "failed", reason: `the deploy reported a failure: "${firstLine(m[0])}"`, marker: p.id, target: null };
    }
  }

  for (const p of LIVE) {
    const m = p.re.exec(s);
    if (m) {
      const target = (m.slice(1).find((g) => typeof g === "string" && g) ?? null);
      return {
        class: "aliased",
        reason: `the log says the deployment went live: "${firstLine(m[0])}"`,
        marker: p.id,
        target,
      };
    }
  }

  for (const p of BUILT) {
    const m = p.re.exec(s);
    if (m) {
      const target = (m.slice(1).find((g) => typeof g === "string" && g) ?? null);
      return {
        class: "built-not-aliased",
        reason:
          `the build ran ("${firstLine(m[0])}") but no line in this log says a deployment became live. ` +
          `A build that exits 0 without aliasing leaves production on the previous version.`,
        marker: p.id,
        target,
      };
    }
  }

  return {
    class: "unknown",
    reason:
      "no line in this log matches any known deploy outcome, so the deploy is unclassified. " +
      "An unclassified deploy is not a successful deploy.",
    marker: null,
    target: null,
  };
}

const firstLine = (s) => String(s).split(/\r?\n/).find((l) => l.trim()) ?? String(s).trim();

// --------------------------------------------------------------- live probe
//
// The question the whole skill exists to answer: is the URL a human will open
// serving the commit that was just merged?

function hexRuns(text) {
  return String(text).match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
}

function shaCompatible(expected, candidate) {
  const a = expected.toLowerCase();
  const b = candidate.toLowerCase();
  const n = Math.min(a.length, b.length);
  if (n < 7) return false;
  return a.slice(0, n) === b.slice(0, n);
}

/** A hex run that sits next to a word suggesting it identifies a build. */
function servingShaGuess(text) {
  const re = /(commit|sha|revision|rev|build[_ -]?id|version|gitsha|git_sha|source[_ -]?version)\W{0,12}([0-9a-f]{7,40})\b/i;
  const m = re.exec(String(text));
  return m ? m[2].toLowerCase() : null;
}

function classifyLive(expectedSha, status, text) {
  const body = String(text ?? "");
  if (status === 402 || /DEPLOYMENT_DISABLED/i.test(body)) {
    return {
      class: "billing",
      reason: `the live URL itself answered ${status}${/DEPLOYMENT_DISABLED/i.test(body) ? " DEPLOYMENT_DISABLED" : ""}. The site is off, not stale.`,
      servingSha: null,
    };
  }
  if (!status || status === 0) {
    return { class: "unreachable", reason: "the live URL could not be reached at all", servingSha: null };
  }
  if (status >= 500) return { class: "error", reason: `the live URL answered ${status}`, servingSha: null };
  if (status >= 400) return { class: "error", reason: `the live URL answered ${status}`, servingSha: null };

  const runs = hexRuns(body);
  if (runs.some((r) => shaCompatible(expectedSha, r))) {
    return { class: "match", reason: `the live response carries ${expectedSha.slice(0, 12)}`, servingSha: expectedSha };
  }
  const guess = servingShaGuess(body);
  if (guess) {
    return {
      class: "stale",
      reason:
        `the live response identifies its build as ${guess.slice(0, 12)}, not ${expectedSha.slice(0, 12)}. ` +
        `Production is serving a different commit than the one that was merged.`,
      servingSha: guess,
    };
  }
  return {
    class: "unproven",
    reason:
      `the live response answered ${status} but carries no build identifier, so it cannot be tied to any commit. ` +
      `A 200 proves the URL is up, not that it is running this change. Expose the commit ` +
      `(a /api/version route, a <meta name="commit"> tag, or an x-commit header) and probe that.`,
    servingSha: null,
  };
}

async function fetchProbe(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "cache-control": "no-cache" } });
    const headerText = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    let body = "";
    try {
      body = (await res.text()).slice(0, 512 * 1024);
    } catch {
      body = "";
    }
    return { ok: true, status: res.status, text: `${headerText}\n\n${body}` };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------- deploy fingerprint
//
// The files that actually decide where a deploy goes. gstack hashes a CLAUDE.md
// heading and workflow files whose NAME contains deploy or cd; on every other
// project that is the hash of nothing, forever.

const FINGERPRINT_FILES = [
  "vercel.json",
  ".vercel/project.json",
  "netlify.toml",
  "railway.json",
  "railway.toml",
  "fly.toml",
  "render.yaml",
  "render.json",
  "Procfile",
  "app.json",
  "Dockerfile",
  "docker-compose.yml",
  "wrangler.toml",
  "now.json",
  "deploy.sh",
  "Makefile",
  "CLAUDE.md",
];

/**
 * Which deploy-config files exist here, and which ones exist in a form this
 * cannot hash. "Absent" and "there but unreadable" are different answers and
 * only the first one is safe to pass over: the second means the fingerprint
 * does not cover a file that decides where a deploy goes.
 */
function listFingerprintFiles(root) {
  const found = [];
  const unreadable = [];
  for (const rel of FINGERPRINT_FILES) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    try {
      if (fs.statSync(abs).isFile()) found.push(rel);
      else unreadable.push(`${rel} (exists but is not a regular file)`);
    } catch (e) {
      if (e.code !== "ENOENT") unreadable.push(`${rel} (${e.code || e.message})`);
    }
  }
  const wf = path.join(root, ".github", "workflows");
  try {
    for (const name of fs.readdirSync(wf).sort()) {
      if (/\.(ya?ml)$/i.test(name)) found.push(`.github/workflows/${name}`);
    }
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") unreadable.push(`.github/workflows/ (${e.code || e.message})`);
  }
  return { files: found.sort(), unreadable };
}

function fingerprint(root) {
  const listed = listFingerprintFiles(root);
  const files = listed.files;
  const h = crypto.createHash("sha256");
  const per = [];
  const unreadable = [...listed.unreadable];
  for (const rel of files) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      // A config file that is listed and will not open is not a file that is
      // "the same as last time". Skipping it silently meant the hash still
      // came out, --compare still said UNCHANGED, and a changed deploy config
      // went unnoticed. It is named now and the comparison refuses.
      unreadable.push(`${rel} (${e.code || e.message})`);
      continue;
    }
    // Normalise line endings so a CRLF checkout on Windows and an LF checkout
    // on CI do not read as a changed deploy configuration.
    const norm = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    const fileHash = crypto.createHash("sha256").update(norm).digest("hex");
    per.push({ file: rel, sha256: fileHash });
    h.update(`${rel}\0${fileHash}\n`);
  }
  return {
    hash: per.length ? h.digest("hex") : "none",
    files: per,
    count: per.length,
    unreadable,
  };
}

// ------------------------------------------------------------------ commands

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function fail(json, code, message) {
  if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
  else err(`  ${code === EXIT_REFUSED ? "REFUSED " : "UNUSABLE"}  ${message}`);
  process.exitCode = code;
}

function cmdInit(args) {
  const json = args.includes("--json");
  const res = resolveDir(flag(args, "--dir"), "land");
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);

  const sha = (flag(args, "--sha") || "").trim();
  const pr = flag(args, "--pr");
  const noDeploy = args.includes("--no-deploy");
  const why = flag(args, "--why");

  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return fail(
      json,
      EXIT_UNUSABLE,
      `--sha must be the merge commit SHA (7-40 hex chars); got "${sha || "(nothing)"}". ` +
        `Without it there is nothing to compare the live site against, and "verified" would mean "unchecked".`,
    );
  }
  if (noDeploy && !why) {
    return fail(json, EXIT_UNUSABLE, `--no-deploy requires --why "<reason>". Declaring up front that nothing deploys is honest; discovering it after a failed check is not.`);
  }

  const ledger = {
    _comment: "Toolbay Stack landing ledger. Written by tb-land.mjs. The verdict is computed from these records, not asserted.",
    pr: pr ? String(pr).replace(/^#/, "") : null,
    sha: sha.toLowerCase(),
    base: flag(args, "--base") || null,
    url: flag(args, "--url") || null,
    platform: flag(args, "--platform") || null,
    noDeploy: noDeploy ? { why } : null,
    startedAt: new Date().toISOString(),
    host: `${process.platform} node ${process.version}`,
    dir: res.dir,
    deploy: null,
    live: null,
  };
  const file = writeLedger(res.dir, ledger);
  if (json) out(JSON.stringify({ ok: true, ledger: file, ...ledger }, null, 2));
  else {
    out(`  pr        ${ledger.pr ?? "(none)"}`);
    out(`  merge sha ${ledger.sha}`);
    out(`  url       ${ledger.url ?? "(none yet)"}`);
    out(`  ledger    ${file}`);
    out();
    out("  Nothing is verified yet. Record the deploy output with `scan` and the live");
    out("  site with `probe`, then `verdict`.");
  }
}

function readLogArg(args) {
  const logFile = flag(args, "--log");
  if (args.includes("--stdin")) {
    try {
      return { ok: true, text: fs.readFileSync(0, "utf8"), source: "<stdin>" };
    } catch (e) {
      return { ok: false, error: `could not read the deploy log from stdin (${e.message})` };
    }
  }
  if (!logFile) return { ok: false, error: `--log <file> or --stdin is required: there is nothing to classify` };
  const abs = path.resolve(fromMsysPath(logFile));
  try {
    return { ok: true, text: fs.readFileSync(abs, "utf8"), source: abs };
  } catch (e) {
    return { ok: false, error: `deploy log ${abs} could not be read (${e.code || e.message})` };
  }
}

function cmdScan(args) {
  const json = args.includes("--json");
  const log = readLogArg(args);
  if (!log.ok) return fail(json, EXIT_UNUSABLE, log.error);

  const verdict = classifyDeployLog(log.text);
  const record = { ...verdict, source: log.source, at: new Date().toISOString() };

  // Recording is not optional unless it was opted out of. `scan` used to print
  // "deploy ALIASED", exit 0, and write nothing at all when the ledger was
  // corrupt or the directory did not resolve — the one line that would have
  // said so (`recorded`) is simply absent, which nobody reads as a failure.
  let recorded = null;
  if (!args.includes("--no-record")) {
    const res = resolveDir(flag(args, "--dir"), "land");
    if (!res.ok) return fail(json, EXIT_UNUSABLE, `${res.error}. The deploy was classified ${verdict.class.toUpperCase()} but nothing could be recorded, so verdict would judge on stale evidence. Pass --no-record if that is genuinely what you want.`);
    const state = readLedger(res.dir);
    if (state.error) return fail(json, EXIT_UNUSABLE, `${state.error}. The deploy was classified ${verdict.class.toUpperCase()} but it could not be recorded.`);
    state.ledger.deploy = record;
    writeLedger(res.dir, state.ledger);
    recorded = state.file;
  }

  if (json) out(JSON.stringify({ ok: verdict.class === "aliased", ...record, recorded }, null, 2));
  else {
    out();
    out(`  deploy   ${verdict.class.toUpperCase()}`);
    out(`  because  ${verdict.reason}`);
    if (verdict.target) out(`  target   ${verdict.target}`);
    out(`  log      ${log.source}`);
    if (recorded) out(`  recorded ${recorded}`);
    out();
  }

  if (verdict.class === "billing") process.exitCode = EXIT_BILLING;
  else if (verdict.class !== "aliased") process.exitCode = EXIT_NOT_LIVE;
}

async function cmdProbe(args) {
  const json = args.includes("--json");
  const res = resolveDir(flag(args, "--dir"), "land");
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const url = flag(args, "--url") || state.ledger.url;
  if (!url) return fail(json, EXIT_UNUSABLE, `--url is required (and none was recorded at init): there is no live site to check`);

  const expected = flag(args, "--expect-sha") || state.ledger.sha;
  const bodyFile = flag(args, "--body-file");
  const statusArg = flag(args, "--status");

  let status = 0;
  let text = "";
  let transport = null;

  if (bodyFile !== undefined || statusArg !== undefined) {
    // Offline mode. Used by the selftest, and by anyone who already captured
    // the response and does not want a second request against production.
    if (statusArg !== undefined && !/^\d{3}$/.test(String(statusArg))) {
      return fail(json, EXIT_UNUSABLE, `--status must be a three digit HTTP status code`);
    }
    status = statusArg !== undefined ? Number(statusArg) : 200;
    if (bodyFile !== undefined) {
      const abs = path.resolve(fromMsysPath(bodyFile));
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch (e) {
        return fail(json, EXIT_UNUSABLE, `--body-file ${abs} could not be read (${e.code || e.message})`);
      }
    }
  } else {
    const timeout = Number(flag(args, "--timeout") || 15000);
    const r = await fetchProbe(url, timeout);
    status = r.status;
    text = r.text;
    transport = r.ok ? null : r.error;
  }

  const cls = classifyLive(expected, status, text);
  const record = {
    url,
    status,
    class: cls.class,
    reason: transport ? `${cls.reason} (${transport})` : cls.reason,
    expectedSha: expected.toLowerCase(),
    servingSha: cls.servingSha,
    offline: bodyFile !== undefined || statusArg !== undefined,
    at: new Date().toISOString(),
  };
  state.ledger.live = record;
  writeLedger(res.dir, state.ledger);

  if (json) out(JSON.stringify({ ok: cls.class === "match", ...record }, null, 2));
  else {
    out();
    out(`  live     ${cls.class.toUpperCase()}  (${url}, HTTP ${status})`);
    out(`  because  ${record.reason}`);
    out();
  }

  if (cls.class === "billing") process.exitCode = EXIT_BILLING;
  else if (cls.class !== "match") process.exitCode = EXIT_NOT_LIVE;
}

/**
 * The verdict. Ordered so that the loudest true statement wins, and so that
 * every path that is not a proof ends non-zero.
 */
function computeVerdict(ledger) {
  const d = ledger.deploy;
  const l = ledger.live;
  const sha = ledger.sha.slice(0, 12);

  if (d?.class === "billing") {
    return { verdict: "BILLING BLOCKED", exit: EXIT_BILLING, why: d.reason, next: "Clear the balance on the platform's billing page, then deploy once. Do not re-run the deploy before that: it fails identically every time." };
  }
  if (l?.class === "billing") {
    return { verdict: "BILLING BLOCKED", exit: EXIT_BILLING, why: l.reason, next: "The live site is off because the account is blocked. Clear billing first; nothing you deploy will be visible until then." };
  }
  if (ledger.noDeploy) {
    return { verdict: "NO DEPLOY EXPECTED", exit: EXIT_OK, why: `declared at init: ${ledger.noDeploy.why}`, next: "Nothing to verify. This was declared before the outcome was known, which is the only honest place to declare it." };
  }
  if (!d) {
    return { verdict: "NOT PROVEN", exit: EXIT_NOT_LIVE, why: "no deploy output was ever examined", next: "Capture the deploy command's output to a file and run `scan --log <file>`." };
  }
  if (d.class === "failed") {
    return { verdict: "DEPLOY FAILED", exit: EXIT_NOT_LIVE, why: d.reason, next: "Fix the build, or revert the merge commit if production is broken." };
  }
  if (d.class === "built-not-aliased") {
    return {
      verdict: "BUILT BUT NOT LIVE",
      exit: EXIT_NOT_LIVE,
      why: d.reason,
      next: "Production is still on the previous build. Check the platform dashboard for the alias/promote step. A green build is not a live deploy.",
    };
  }
  if (d.class === "unknown") {
    return { verdict: "NOT PROVEN", exit: EXIT_NOT_LIVE, why: d.reason, next: "Pass the real deploy output, or verify by hand and say so in the report." };
  }
  if (!l) {
    return { verdict: "NOT PROVEN", exit: EXIT_NOT_LIVE, why: "the deploy log says it went live, but nothing checked the live URL", next: "Run `probe --url <production url>`." };
  }
  if (l.class === "unreachable" || l.class === "error") {
    return { verdict: "NOT LIVE", exit: EXIT_NOT_LIVE, why: l.reason, next: "The deploy claims success and the site does not answer. Treat production as down until this is explained." };
  }
  if (l.class === "stale") {
    return {
      verdict: "STALE",
      exit: EXIT_NOT_LIVE,
      why: l.reason,
      next: "The alias did not move to the new deployment. This is the failure that reads as healthy: 200, no console errors, wrong code.",
    };
  }
  if (l.class === "unproven") {
    return { verdict: "UNPROVEN", exit: EXIT_NOT_LIVE, why: l.reason, next: "Expose the commit at a versioned endpoint and probe that, or verify by hand and record how." };
  }
  if (l.class === "match") {
    return { verdict: "LIVE AND VERIFIED", exit: EXIT_OK, why: `the deploy log aliased, and ${l.url} is serving ${sha}`, next: "Done. This is the only path here that exits 0 with a deploy." };
  }
  return { verdict: "NOT PROVEN", exit: EXIT_NOT_LIVE, why: `unrecognised live classification "${l.class}"`, next: "This is a bug in tb-land; treat the deploy as unverified." };
}

function cmdVerdict(args) {
  const json = args.includes("--json");
  const res = resolveDir(flag(args, "--dir"), "land");
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const v = computeVerdict(state.ledger);
  const payload = {
    ok: v.exit === EXIT_OK,
    verdict: v.verdict,
    why: v.why,
    next: v.next,
    pr: state.ledger.pr,
    sha: state.ledger.sha,
    url: state.ledger.url,
    deploy: state.ledger.deploy,
    live: state.ledger.live,
  };

  if (json) out(JSON.stringify(payload, null, 2));
  else {
    out();
    out("  LAND & DEPLOY VERDICT");
    out("  =====================");
    out(`  pr        ${state.ledger.pr ? `#${state.ledger.pr}` : "(none)"}`);
    out(`  merge sha ${state.ledger.sha}`);
    out(`  url       ${state.ledger.url ?? "(none)"}`);
    out(`  deploy    ${state.ledger.deploy ? state.ledger.deploy.class : "(never scanned)"}`);
    out(`  live      ${state.ledger.live ? `${state.ledger.live.class} (HTTP ${state.ledger.live.status})` : "(never probed)"}`);
    out();
    out(`  ${v.verdict}`);
    out(`    ${v.why}`);
    out(`    ${v.next}`);
    out();
  }
  process.exitCode = v.exit;
}

function cmdFingerprint(args) {
  const json = args.includes("--json");
  const res = resolveDir(flag(args, "--repo") || ".", "land");
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const fp = fingerprint(res.dir);
  const compare = flag(args, "--compare");

  // Two ways this comparison used to answer a question it had not asked.
  // "none" is what the hash is when there are NO config files, so
  // `--compare none` printed UNCHANGED and exited 0 over a repo it had never
  // fingerprinted. And a config file it could not read was skipped, so the
  // hash was computed over a subset and still called equal. Both refuse now.
  const problems = [];
  if (fp.unreadable.length) {
    problems.push(`${fp.unreadable.length} deploy config file(s) could not be read, so this fingerprint does not cover them: ${fp.unreadable.join(", ")}`);
  }
  if (compare && !fp.count) {
    problems.push('no deploy configuration files were found here, so "none" is the absence of a fingerprint, not a fingerprint that matches');
  }

  if (json) {
    out(JSON.stringify({ ok: problems.length === 0 && (!compare || compare === fp.hash), root: res.dir, ...fp, compare: compare ?? null, problems }, null, 2));
  } else {
    out();
    out(`  root   ${res.dir}`);
    out(`  hash   ${fp.hash}`);
    for (const f of fp.files) out(`         ${f.sha256.slice(0, 12)}  ${f.file}`);
    if (!fp.count) out(`         (no deploy configuration files found; "none" is a distinct value, not the hash of an empty string)`);
    for (const p of problems) out(`  UNUSABLE ${p}`);
    if (compare && !problems.length) out(`  ${compare === fp.hash ? "UNCHANGED" : "CHANGED"} against ${compare}`);
    out();
  }
  if (problems.length) process.exitCode = EXIT_UNUSABLE;
  else if (compare && compare !== fp.hash) process.exitCode = EXIT_NOT_LIVE;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-land-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const write = (rel, text) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, "utf8");
    return p;
  };
  const SHA = "9f2c1ab4d7e6501122334455667788990011aabb";

  // ---------------------------------------------------------------- init
  {
    const r = runSelf(["init", "--json", "--pr", "123", "--sha", SHA, "--url", "https://example.test", ...D("ok")]);
    check("init records the merge sha", 0, r.status, r.stderr.trim());
  }
  check("init refuses a missing merge sha", 2, runSelf(["init", "--json", "--pr", "1", ...D("nosha")]).status);
  check("init refuses a merge sha that is not a sha", 2, runSelf(["init", "--json", "--sha", "HEAD", ...D("badsha")]).status);
  check("init refuses --no-deploy without a stated reason", 2, runSelf(["init", "--json", "--sha", SHA, "--no-deploy", ...D("nowhy")]).status);
  if (isWindows) {
    const r = runSelf(["init", "--sha", SHA, "--dir", "/tmp/land"]);
    check("init refuses /tmp on Windows, where it means two directories", 3, r.status);
  }

  // -------------------------------------------------- the deploy log scanner
  //
  // Every log below is the shape a real CLI prints. The ones that must NOT
  // pass are the point.

  const VERCEL_PAUSED = `Vercel CLI 41.7.3
Retrieving project...
Deploying orion/toolbay
Inspect: https://vercel.com/orion/toolbay/9Qk3d2 [2s]
Building
Installing dependencies...
Build Completed in /vercel/output [58s]
Uploading build outputs...
`;
  const VERCEL_LIVE = `${VERCEL_PAUSED}Production: https://toolbay.ai [1m]
Aliased to toolbay.ai
`;
  const VERCEL_402 = `Vercel CLI 41.7.3
Error: The deployment has been disabled for this account.
Code: DEPLOYMENT_DISABLED
To continue deploying, add a valid payment method at https://vercel.com/account/billing
`;
  const VERCEL_OVERDUE = `Vercel CLI 41.7.3
Error: Your account has an overdue balance. Please add a valid payment method to continue.
`;
  const NETLIFY_DRAFT = `Deploy path: /repo/dist
Deploying to draft URL...
Website Draft URL: https://69f1--toolbay.netlify.app
If everything looks good on your draft URL, deploy it to your main site URL with the --prod flag.
`;
  const NETLIFY_PROD = `Deploy path: /repo/dist
Deploy is live!
Unique Deploy URL: https://69f1--toolbay.netlify.app
Website URL: https://toolbay.netlify.app
`;
  const RAILWAY_UPLOAD = `Indexed
Compressed [====================] 100%
Uploaded
Build Logs: https://railway.app/project/abc/service/def
`;
  const RAILWAY_LIVE = `${RAILWAY_UPLOAD}Deployment successful
`;
  const BUILD_FAILED = `Vercel CLI 41.7.3
Inspect: https://vercel.com/orion/toolbay/9Qk3d2 [2s]
Error: Command "npm run build" exited with 1
`;

  const scanClass = (name, text, expected, expectedExit) => {
    const p = write(`logs/${name}.log`, text);
    const r = runSelf(["scan", "--json", "--no-record", "--log", p]);
    let cls = "(unparseable)";
    try {
      cls = JSON.parse(r.stdout || "{}").class ?? "(none)";
    } catch {
      /* leave */
    }
    check(`scan: ${name}`, expected, cls, r.stderr.trim());
    if (expectedExit !== undefined) check(`scan exit: ${name}`, expectedExit, r.status);
  };

  scanClass("vercel deploy that built and never aliased", VERCEL_PAUSED, "built-not-aliased", 1);
  scanClass("vercel deploy that actually aliased", VERCEL_LIVE, "aliased", 0);
  scanClass("vercel DEPLOYMENT_DISABLED", VERCEL_402, "billing", 4);
  scanClass("vercel overdue balance", VERCEL_OVERDUE, "billing", 4);
  scanClass("netlify draft deploy (not production)", NETLIFY_DRAFT, "built-not-aliased", 1);
  scanClass("netlify production deploy", NETLIFY_PROD, "aliased", 0);
  scanClass("railway upload with no deployment result", RAILWAY_UPLOAD, "built-not-aliased", 1);
  scanClass("railway deployment successful", RAILWAY_LIVE, "aliased", 0);
  scanClass("build failure", BUILD_FAILED, "failed", 1);
  scanClass("empty log", "", "unknown", 1);
  scanClass("log with nothing recognisable in it", "hello\nworld\n", "unknown", 1);
  // A log that carries a stale success line and ends in a 402 must read as
  // billing, not as success.
  scanClass("success line followed by a billing block", `${VERCEL_LIVE}\n${VERCEL_402}`, "billing", 4);
  check("scan without a log is unusable", 2, runSelf(["scan", "--json"]).status);
  check("scan of a log file that does not exist is unusable", 2, runSelf(["scan", "--json", "--log", path.join(tmp, "nope.log")]).status);

  // ------------------------------------------------------------ live probe
  const probeInit = (n) => runSelf(["init", "--sha", SHA, "--pr", "7", "--url", "https://toolbay.ai", ...D(n)]);
  const seedDeploy = (n, text) => {
    const p = write(`logs/seed-${n}.log`, text);
    return runSelf(["scan", ...D(n), "--log", p]);
  };

  {
    probeInit("p-match");
    const body = write("bodies/match.json", `{"commit":"${SHA.slice(0, 7)}","builtAt":"now"}`);
    const r = runSelf(["probe", "--json", ...D("p-match"), "--status", "200", "--body-file", body]);
    check("probe: a live response carrying the merge sha matches", 0, r.status, r.stderr.trim());
  }
  {
    probeInit("p-stale");
    const body = write("bodies/stale.json", `{"commit":"deadbee1234567","builtAt":"yesterday"}`);
    const r = runSelf(["probe", "--json", ...D("p-stale"), "--status", "200", "--body-file", body]);
    check("probe: a healthy 200 serving a DIFFERENT commit is stale, not pass", 1, r.status);
    let cls = "";
    try {
      cls = JSON.parse(r.stdout || "{}").class;
    } catch {
      /* leave */
    }
    check("...and is reported as stale", "stale", cls, r.stdout.slice(0, 200));
  }
  {
    probeInit("p-unproven");
    const body = write("bodies/plain.html", "<html><body><h1>Toolbay</h1><p>everything is fine</p></body></html>");
    const r = runSelf(["probe", "--json", ...D("p-unproven"), "--status", "200", "--body-file", body]);
    check("probe: a 200 with no build identifier is unproven, not pass", 1, r.status);
  }
  {
    probeInit("p-402");
    const body = write("bodies/disabled.html", "DEPLOYMENT_DISABLED");
    const r = runSelf(["probe", "--json", ...D("p-402"), "--status", "402", "--body-file", body]);
    check("probe: a 402 live site is a billing block, exit 4", 4, r.status);
  }
  {
    probeInit("p-500");
    const r = runSelf(["probe", "--json", ...D("p-500"), "--status", "500"]);
    check("probe: a 500 live site fails", 1, r.status);
  }
  check("probe before init is unusable", 2, runSelf(["probe", "--json", ...D("p-never"), "--status", "200"]).status);

  // --------------------------------------------------------------- verdict
  {
    probeInit("v-green");
    seedDeploy("v-green", VERCEL_LIVE);
    const body = write("bodies/green.json", `{"commit":"${SHA}"}`);
    runSelf(["probe", ...D("v-green"), "--status", "200", "--body-file", body]);
    const r = runSelf(["verdict", "--json", ...D("v-green")]);
    check("verdict: aliased deploy + live sha match is the only pass", 0, r.status, r.stdout.slice(0, 300));
  }
  {
    // THE gstack CASE. Deploy exited 0, site is up, fast, clean, 200. gstack
    // prints DEPLOYED AND VERIFIED. Production is a build behind.
    probeInit("v-greenbutdead");
    seedDeploy("v-greenbutdead", VERCEL_PAUSED);
    const body = write("bodies/old.html", "<html><body>Toolbay</body></html>");
    runSelf(["probe", ...D("v-greenbutdead"), "--status", "200", "--body-file", body]);
    const r = runSelf(["verdict", "--json", ...D("v-greenbutdead")]);
    check("verdict: build with no alias + healthy 200 does NOT pass", 1, r.status);
    let v = "";
    try {
      v = JSON.parse(r.stdout || "{}").verdict;
    } catch {
      /* leave */
    }
    check("...and names it BUILT BUT NOT LIVE", "BUILT BUT NOT LIVE", v, r.stdout.slice(0, 200));
  }
  {
    probeInit("v-nodeploy");
    const r = runSelf(["verdict", "--json", ...D("v-nodeploy")]);
    check("verdict: nothing scanned at all does not pass", 1, r.status);
  }
  {
    probeInit("v-noprobe");
    seedDeploy("v-noprobe", VERCEL_LIVE);
    const r = runSelf(["verdict", "--json", ...D("v-noprobe")]);
    check("verdict: aliased log but nobody checked the live URL does not pass", 1, r.status);
  }
  {
    probeInit("v-billing");
    seedDeploy("v-billing", VERCEL_402);
    const body = write("bodies/green2.json", `{"commit":"${SHA}"}`);
    runSelf(["probe", ...D("v-billing"), "--status", "200", "--body-file", body]);
    const r = runSelf(["verdict", "--json", ...D("v-billing")]);
    check("verdict: a billing block wins even when the old site answers 200", 4, r.status);
  }
  {
    const r = runSelf(["init", "--json", "--sha", SHA, "--no-deploy", "--why", "CLI package, nothing deploys", ...D("v-lib")]);
    check("init accepts --no-deploy with a reason", 0, r.status, r.stderr.trim());
    check("verdict: a declared no-deploy landing passes", 0, runSelf(["verdict", "--json", ...D("v-lib")]).status);
  }
  {
    const dir = path.join(tmp, "v-corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "landing.json"), "{ not json", "utf8");
    check("verdict on a corrupt ledger is unusable, not a pass", 2, runSelf(["verdict", "--json", "--dir", dir]).status);
  }
  {
    const dir = path.join(tmp, "v-nosha");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "landing.json"), JSON.stringify({ deploy: null, live: null }), "utf8");
    check("verdict on a ledger with no merge sha is unusable, not a pass", 2, runSelf(["verdict", "--json", "--dir", dir]).status);
  }
  check("verdict with no ledger at all is unusable, not a pass", 2, runSelf(["verdict", "--json", ...D("v-never")]).status);

  // ----------------------------------------------------------- fingerprint
  //
  // gstack's fingerprint of each of these repos is the same constant, because
  // none of them has a "## Deploy Configuration" heading in CLAUDE.md or a
  // workflow file named *deploy*/*cd*.
  {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const fpOf = (extra = []) => {
      const r = runSelf(["fingerprint", "--json", "--repo", repo, ...extra]);
      try {
        return JSON.parse(r.stdout || "{}");
      } catch {
        return {};
      }
    };
    const empty = fpOf();
    check("fingerprint of a repo with no deploy config is \"none\", not a hash of nothing", "none", empty.hash);

    fs.writeFileSync(path.join(repo, "vercel.json"), `{"regions":["iad1"]}`, "utf8");
    const a = fpOf();
    check("adding vercel.json changes the fingerprint", true, a.hash !== "none" && a.hash !== empty.hash, a.hash);

    fs.writeFileSync(path.join(repo, "vercel.json"), `{"regions":["sfo1"]}`, "utf8");
    const b = fpOf();
    check("editing vercel.json changes it (gstack: unchanged)", true, b.hash !== a.hash, `${a.hash} -> ${b.hash}`);

    fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
    const cWf = fpOf();
    check("a workflow NOT named *deploy* still counts (gstack: ignored)", true, cWf.hash !== b.hash, `${b.hash} -> ${cWf.hash}`);

    fs.writeFileSync(path.join(repo, "railway.json"), `{"deploy":{"startCommand":"node server.js"}}`, "utf8");
    const d = fpOf();
    check("switching platforms by adding railway.json changes it (gstack: unchanged)", true, d.hash !== cWf.hash, `${cWf.hash} -> ${d.hash}`);

    check("--compare exits non-zero when the deploy config moved", 1, runSelf(["fingerprint", "--repo", repo, "--compare", b.hash]).status);
    check("--compare exits 0 when it did not", 0, runSelf(["fingerprint", "--repo", repo, "--compare", d.hash]).status);

    // CRLF is a checkout artefact, not a config change.
    fs.writeFileSync(path.join(repo, "railway.json"), `{"deploy":{"startCommand":"node server.js"}}`.replace(/\n/g, "\r\n"), "utf8");
    check("a CRLF checkout does not read as a changed deploy config", d.hash, fpOf().hash);
  }
  {
    // "none" is the ABSENCE of a fingerprint. Comparing against it used to
    // print UNCHANGED and exit 0 over a repo with no deploy config at all.
    const bare = path.join(tmp, "bare-repo");
    fs.mkdirSync(bare, { recursive: true });
    const r = runSelf(["fingerprint", "--json", "--repo", bare, "--compare", "none"]);
    check("--compare none over a repo with no deploy config is unusable, not UNCHANGED", 2, r.status, r.stdout.slice(0, 200));
    check("...and says why", true, /absence of a fingerprint/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    // A config file that will not open used to be skipped, and the hash over
    // the remaining files still compared equal.
    // The repo keeps a SECOND, readable config, so the fingerprint is not
    // empty: this case has to fail on the unreadable file specifically, not on
    // "there was nothing to fingerprint".
    const partial = path.join(tmp, "partial-repo");
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, "railway.json"), `{"deploy":{"startCommand":"node s.js"}}`, "utf8");
    fs.writeFileSync(path.join(partial, "vercel.json"), `{"regions":["iad1"]}`, "utf8");
    const good = JSON.parse(runSelf(["fingerprint", "--json", "--repo", partial]).stdout || "{}");
    check("a readable deploy config fingerprints cleanly", 0, good.unreadable?.length ?? -1, JSON.stringify(good.unreadable));
    check("...and produces a real hash", true, good.hash !== "none" && good.count === 2, JSON.stringify(good.hash));
    // Replace one file with a directory of the same name: it is listed and
    // cannot be read, on every platform, which is the portable "unreadable".
    fs.rmSync(path.join(partial, "vercel.json"));
    fs.mkdirSync(path.join(partial, "vercel.json"));
    const after = JSON.parse(runSelf(["fingerprint", "--json", "--repo", partial]).stdout || "{}");
    check("...and one unreadable file still leaves a hashable one behind", 1, after.count, JSON.stringify(after));
    const r = runSelf(["fingerprint", "--json", "--repo", partial, "--compare", good.hash]);
    check("a deploy config that cannot be read makes the comparison unusable", 2, r.status, r.stdout.slice(0, 200));
    check("...and names the file", true, /vercel\.json/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    // scan used to classify the deploy, print no `recorded` line, exit 0, and
    // leave a corrupt ledger in place with nobody told. The directory is a real
    // initialised one, so this exercises the LEDGER path and not the earlier
    // "that is not a land directory" refusal.
    const dir = path.join(tmp, "scan-corrupt");
    check("a land dir for the corrupt-ledger case initialises", 0, runSelf(["init", "--sha", SHA, "--pr", "9", "--url", "https://toolbay.ai", "--dir", dir]).status);
    const ledger = path.join(dir, "landing.json");
    check("...and the ledger it wrote is where it says", true, fs.existsSync(ledger), ledger);
    fs.writeFileSync(ledger, "{ not json", "utf8");
    const log = write("logs/aliased-for-corrupt.log", VERCEL_LIVE);
    const r = runSelf(["scan", "--json", "--dir", dir, "--log", log]);
    check("scan refuses when it cannot record the result", 2, r.status, r.stdout.slice(0, 200));
    check("...and says the deploy was classified but not recorded", true, /could not be recorded|not valid JSON/.test(r.stdout), r.stdout.slice(0, 300));
    check("...and leaves the corrupt ledger alone", "{ not json", fs.readFileSync(ledger, "utf8"));
    check("...and --no-record is the way to say you meant it", 0, runSelf(["scan", "--json", "--no-record", "--log", log]).status);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-land", results);
}

// -------------------------------------------------------------------- output

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
  process.stdout.write("\n  The cases above are the ways a deploy reports success and is not live: a\n");
  process.stdout.write("  build that exits 0 and never aliases, a netlify draft URL, a railway upload\n");
  process.stdout.write("  with no deployment result, a paused account still serving the old build at\n");
  process.stdout.write("  200, and a deploy config that changed under a fingerprint that cannot see it.\n");
  process.stdout.write("  None of them exits 0 here.\n\n");
  return true;
}

function help() {
  out(`
  tb-land ${VERSION}  (Toolbay Stack)

  init --sha <merge-sha> [--pr N] [--url U] [--base B] [--platform P]
       [--no-deploy --why "<reason>"] [--dir D]
  scan --log <file> | --stdin [--no-record] [--dir D]
       classify a deploy log: aliased / built-not-aliased / billing / failed / unknown
  probe [--url U] [--expect-sha S] [--status N --body-file F] [--timeout ms]
       ask the live URL what commit it is serving
  verdict [--dir D]                    compute the verdict from what was recorded
  fingerprint [--repo R] [--compare H] hash the files that decide where a deploy goes
  selftest                             prove it against deploys that must not pass

  Options: --json

  A deploy is only LIVE AND VERIFIED when the log says a deployment went live
  AND the production URL is serving the merge commit. A build that exits 0, a
  draft URL, an upload with no result, and a 200 from a paused account all fail.

  Exit: 0 verified, 1 not live, 2 unusable, 3 refused, 4 billing blocked (stop,
  do not retry the deploy).
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

async function main() {
  if (cmd === "init") return cmdInit(rest);
  if (cmd === "scan") return cmdScan(rest);
  if (cmd === "probe") return cmdProbe(rest);
  if (cmd === "verdict") return cmdVerdict(rest);
  if (cmd === "fingerprint") return cmdFingerprint(rest);
  if (cmd === "selftest") return selftest();
  return help();
}

main().catch((e) => {
  err(`tb-land: ${e?.stack ?? e}`);
  process.exit(EXIT_UNUSABLE);
});
