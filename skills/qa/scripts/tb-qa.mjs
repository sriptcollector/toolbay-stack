#!/usr/bin/env node
/**
 * tb-qa.mjs: the evidence ledger behind the /qa workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (tiers, the clean-tree precondition, the
 * test -> triage -> fix -> re-verify loop, one atomic commit per fix, the
 * verified / best-effort / reverted classification, the WTF-likelihood
 * self-regulation heuristic, the before/after health score and the report
 * layout) comes from `qa` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * /qa exists to answer "does it work". gstack lets the agent answer that
 * question about its own work, from memory, with nothing checking.
 *
 * 1. "VERIFIED" IS SELF-ASSIGNED. gstack Phase 8d takes a screenshot, and 8e
 *    then classifies the fix (qa/SKILL.md.tmpl:210-221):
 *
 *      $B screenshot "$REPORT_DIR/screenshots/issue-NNN-after.png"
 *      ...
 *      - **verified**: re-test confirms the fix works, no new errors introduced
 *
 *    Nothing looks at that PNG. If the browse daemon was not running, the
 *    screenshot command fails or writes a zero-byte file, and the issue is still
 *    classified `verified` and still counted in the "health score X -> Y" line
 *    that goes in the PR body. Here a `pass` is downgraded to `unverified`
 *    unless its evidence is a file that exists and is non-empty, or a real HTTP
 *    status from a real URL, and one `unverified` fails the whole run.
 *
 * 2. AN EMPTY RUN SCORES THE SAME AS A CLEAN RUN. There is no step in gstack
 *    that distinguishes "every check passed" from "no checks ran". `verdict` on
 *    an empty ledger exits 1 and says so.
 *
 * 3. `/tmp` IS TWO DIFFERENT DIRECTORIES ON WINDOWS. gstack's setup table offers
 *    `Output to /tmp/qa` (qa/SKILL.md.tmpl:52). Measured on Windows 11:
 *
 *      $ cd /tmp && pwd -W                       -> C:/Users/orion/AppData/Local/Temp
 *      $ node -e "console.log(path.resolve('/tmp/qa'))" -> C:\tmp\qa
 *
 *    So the browser writes the screenshot to one directory and the report links
 *    to another, and every piece of evidence 404s. `init` refuses a POSIX
 *    system path on win32 and says which two directories it would have meant.
 *
 * The ledger is a plain JSON file. Everything here is deliberately boring; the
 * value is that the verdict is computed from recorded facts instead of asserted.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { checkArtifact, makePngOfSize } from "./tb-artifact.mjs";
import { AMBIGUOUS_ON_WINDOWS, resolveOutDir as resolveOutDirShared } from "./tb-outdir.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger; shared reader/writer in src/ledger/tb-ledger.mjs.
const ledgerPath = (dir) => ledgerPathShared(dir);
function readLedger(dir) {
  return readLedgerShared(dir, {
    what: "QA ledger",
    hint: 'Run "tb-qa.mjs init --target <url>" first. An unrecorded run is not a passing run.',
    require: ["checks"],
  });
}
function writeLedger(dir, ledger) {
  return writeLedgerShared(dir, ledger);
}


/**
 * This skill's output directory. The refusal and the resolution are shared
 * (src/outdir/tb-outdir.mjs); only the default and the consequence sentence
 * are this skill's.
 */
function resolveOutDir(raw) {
  return resolveOutDirShared(raw, {
    defaultDir: process.env.TOOLBAY_QA_DIR || path.join(process.cwd(), ".toolbay", "qa"),
    consequence: "Screenshots would land in one and the report would link to the other.",
  });
}

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.3.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_FAILED = 1; // the run did not pass
const EXIT_UNUSABLE = 2; // the ledger or the arguments could not be used
const EXIT_REFUSED = 3; // a request that must not be honoured

const STATUSES = new Set(["pass", "fail", "blocked"]);

// ------------------------------------------------------------------- paths

/** POSIX system directories that mean two different things on Windows. */


// -------------------------------------------------------------- evidence
//
// The whole point. A check is only as good as the artifact behind it.

function verifyEvidence(check, dir) {
  const reasons = [];
  let verified = false;

  if (check.evidence) {
    const abs = path.isAbsolute(check.evidence) ? check.evidence : path.resolve(dir, check.evidence);
    // One evidence standard for the whole package. This used to be "the file
    // exists and is not 0 bytes", which graded an HTML error page or a JSON
    // 401 body saved as .png as a verified pass.
    const art = checkArtifact(abs, { requirePng: /\.png$/i.test(abs) });
    if (!art.ok) reasons.push(art.why);
    else verified = true;
  }

  if (typeof check.http === "number") {
    if (!Number.isInteger(check.http) || check.http < 100 || check.http > 599) {
      reasons.push(`recorded HTTP status ${check.http} is not a real status code`);
    } else if (check.status === "pass" && check.http >= 400 && check.expectHttp !== check.http) {
      // 4xx used to be evidence FOR a pass: only >= 500 blocked one, so
      // `record --status pass --http 404` with no artifact produced
      // "1/1 verified pass (100%)". A 404 is a page that is not there. It can
      // still back a pass when the test is that the status is exactly what was
      // expected — a 404 page, an auth wall returning 401 — but that has to be
      // said out loud with --expect-http, not inferred.
      reasons.push(
        `recorded HTTP ${check.http} is an error response and cannot support a pass. ` +
          `If ${check.http} is the expected outcome of this check, record it with --expect-http ${check.http}`,
      );
    } else {
      verified = true;
    }
  }

  if (!check.evidence && typeof check.http !== "number") {
    reasons.push("no evidence recorded: no artifact file and no HTTP status");
  }

  return { verified: verified && reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ commands

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function cmdInit(args) {
  const json = args.includes("--json");
  const target = flag(args, "--target");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) {
    if (json) out(JSON.stringify({ ok: false, error: res.error }, null, 2));
    else err(`  REFUSED  ${res.error}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  if (!target) {
    const message = "--target is required: a QA run has to say what it tested";
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`  UNUSABLE  ${message}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const ledger = {
    _comment: "Toolbay Stack QA ledger. Written by tb-qa.mjs. The verdict is computed from these records, not asserted.",
    target,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} node ${process.version}`,
    dir: res.dir,
    checks: [],
  };
  fs.mkdirSync(path.join(res.dir, "screenshots"), { recursive: true });
  const file = writeLedger(res.dir, ledger);
  if (json) out(JSON.stringify({ ok: true, dir: res.dir, ledger: file }, null, 2));
  else {
    out(`  target      ${target}`);
    out(`  dir         ${res.dir}`);
    out(`  screenshots ${path.join(res.dir, "screenshots")}`);
    out(`  ledger      ${file}`);
    out();
    out("  Both paths above are absolute, so a shell, a browser and this script all");
    out("  mean the same directory by them.");
  }
}

function cmdRecord(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) {
    err(`  REFUSED  ${res.error}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const state = readLedger(res.dir);
  if (state.error) {
    if (json) out(JSON.stringify({ ok: false, error: state.error }, null, 2));
    else err(`  UNUSABLE  ${state.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const id = flag(args, "--id");
  const desc = flag(args, "--check");
  const status = (flag(args, "--status") || "").toLowerCase();
  const evidence = flag(args, "--evidence");
  const httpRaw = flag(args, "--http");
  const expectRaw = flag(args, "--expect-http");
  const url = flag(args, "--url");
  const force = args.includes("--force");

  const bad = [];
  if (!id) bad.push("--id is required");
  if (!desc) bad.push("--check is required (what was actually exercised)");
  if (!STATUSES.has(status)) bad.push(`--status must be one of ${[...STATUSES].join(", ")}`);
  if (httpRaw !== undefined && !/^\d{3}$/.test(httpRaw)) bad.push("--http must be a three digit status code");
  if (expectRaw !== undefined && !/^\d{3}$/.test(expectRaw)) bad.push("--expect-http must be a three digit status code");
  if (expectRaw !== undefined && httpRaw === undefined) bad.push("--expect-http means nothing without --http");
  if (expectRaw !== undefined && httpRaw !== undefined && expectRaw !== httpRaw) {
    bad.push(`--expect-http ${expectRaw} does not match the observed --http ${httpRaw}, so this check did not do what it says`);
  }
  if (bad.length) {
    if (json) out(JSON.stringify({ ok: false, errors: bad }, null, 2));
    else for (const b of bad) err(`  UNUSABLE  ${b}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const existing = state.ledger.checks.findIndex((c) => c.id === id);
  if (existing !== -1 && !force) {
    // Overwriting a recorded fail with a pass is how a run turns green by
    // accident. Make it explicit.
    const message = `${id} is already recorded as "${state.ledger.checks[existing].status}". Pass --force to overwrite, and say why in the report.`;
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`  REFUSED  ${message}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const check = {
    id,
    check: desc,
    status,
    url: url ?? null,
    evidence: evidence ?? null,
    http: httpRaw !== undefined ? Number(httpRaw) : null,
    expectHttp: expectRaw !== undefined ? Number(expectRaw) : null,
    at: new Date().toISOString(),
  };
  if (check.http === null) delete check.http;
  if (check.expectHttp === null) delete check.expectHttp;
  if (existing !== -1) state.ledger.checks[existing] = check;
  else state.ledger.checks.push(check);
  writeLedger(res.dir, state.ledger);

  const ev = verifyEvidence(check, res.dir);
  if (json) out(JSON.stringify({ ok: true, check, evidence: ev }, null, 2));
  else {
    out(`  recorded  ${id}  ${status}  ${desc}`);
    if (!ev.verified) for (const r of ev.reasons) out(`            ! ${r}`);
  }
}

function computeVerdict(dir) {
  const state = readLedger(dir);
  if (state.error) return { error: state.error };
  const checks = state.ledger.checks.map((c) => {
    const ev = verifyEvidence(c, dir);
    // A pass that cannot be backed up is not a pass.
    const effective = c.status === "pass" && !ev.verified ? "unverified" : c.status;
    return { ...c, effective, evidenceReasons: ev.reasons };
  });
  const counts = checks.reduce((acc, c) => ({ ...acc, [c.effective]: (acc[c.effective] ?? 0) + 1 }), {});
  const passed = counts.pass ?? 0;
  const total = checks.length;
  const verdict = total === 0 ? "FAIL" : passed === total ? "PASS" : "FAIL";
  return {
    target: state.ledger.target,
    dir,
    checks,
    counts,
    total,
    passed,
    score: total ? Math.round((passed / total) * 1000) / 10 : 0,
    verdict,
    empty: total === 0,
  };
}

function cmdVerdict(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) {
    err(`  REFUSED  ${res.error}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const v = computeVerdict(res.dir);
  if (v.error) {
    if (json) out(JSON.stringify({ ok: false, error: v.error }, null, 2));
    else err(`  UNUSABLE  ${v.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  if (json) {
    out(JSON.stringify(v, null, 2));
  } else {
    out();
    out(`  target   ${v.target}`);
    out(`  checks   ${v.total}`);
    for (const c of v.checks) {
      out(`    ${c.effective.toUpperCase().padEnd(10)} ${c.id.padEnd(12)} ${c.check}`);
      if (c.effective === "unverified") for (const r of c.evidenceReasons) out(`               ! ${r}`);
    }
    out();
    if (v.empty) {
      out("  FAIL  no checks were recorded. An empty QA run is not a passing QA run.");
    } else {
      out(`  ${v.verdict}  ${v.passed}/${v.total} verified pass (${v.score}%)`);
      if (v.verdict === "FAIL" && (v.counts.unverified ?? 0) > 0) {
        out(`        ${v.counts.unverified} check(s) claimed pass with no usable evidence.`);
        out("        Re-run them and capture the artifact, or record them as blocked.");
      }
    }
    out();
  }
  if (v.verdict !== "PASS") process.exitCode = EXIT_FAILED;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-qa-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const shot = (n, bytes) => {
    const p = path.join(tmp, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A real PNG, because a fixture the product would refuse proves nothing.
    fs.writeFileSync(p, bytes > 0 && /\.png$/i.test(n) ? makePngOfSize(bytes) : Buffer.alloc(bytes));
    return p;
  };

  // ---- init
  {
    const r = runSelf(["init", "--json", "--target", "http://localhost:3000", ...D("run1")]);
    check("init creates a ledger", 0, r.status, r.stderr.trim());
    const j = JSON.parse(r.stdout || "{}");
    check("init reports an absolute directory", true, Boolean(j.dir) && path.isAbsolute(j.dir), j.dir);
    check("init actually wrote the ledger", true, fs.existsSync(path.join(tmp, "run1", "ledger.json")));
  }
  check("init requires a target", 2, runSelf(["init", "--json", ...D("run-notarget")]).status);
  if (isWindows) {
    const r = runSelf(["init", "--target", "http://x", "--dir", "/tmp/qa"]);
    check("init refuses /tmp on Windows, where it means two directories", 3, r.status);
    const said = `${r.stdout}${r.stderr}`;
    check(
      "...and names both of them",
      true,
      /AppData[\\/]Local[\\/]Temp/.test(said) && /C:[\\/]tmp[\\/]qa/.test(said),
      said.trim().slice(0, 200),
    );
  }

  // ---- verdict fails closed before anything is recorded
  check("verdict on an empty run FAILS", 1, runSelf(["verdict", "--json", ...D("run1")]).status);
  check("verdict with no ledger at all is unusable, not a pass", 2, runSelf(["verdict", "--json", ...D("never-inited")]).status);
  {
    const dir = path.join(tmp, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.json"), "{ not json", "utf8");
    check("verdict on a corrupt ledger is unusable, not a pass", 2, runSelf(["verdict", "--json", "--dir", dir]).status);
  }

  // ---- a pass has to be backed by something
  runSelf(["init", "--target", "http://localhost:3000", ...D("run2")]);
  {
    const good = shot("run2/screenshots/issue-001-after.png", 2048);
    const r = runSelf(["record", "--json", ...D("run2"), "--id", "ISSUE-001", "--check", "checkout submits", "--status", "pass", "--evidence", good]);
    check("record accepts a pass with a real artifact", 0, r.status, r.stderr.trim());
    check("verdict passes when the artifact is real", 0, runSelf(["verdict", "--json", ...D("run2")]).status);
  }
  {
    // This is the gstack failure: the browse daemon was down, the screenshot
    // command wrote nothing, and the fix was still classified "verified".
    const empty = shot("run2/screenshots/issue-002-after.png", 0);
    runSelf(["record", ...D("run2"), "--id", "ISSUE-002", "--check", "cart badge updates", "--status", "pass", "--evidence", empty]);
    const r = runSelf(["verdict", "--json", ...D("run2")]);
    check("a pass backed by a 0-byte screenshot FAILS the run", 1, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...and is reported as unverified, not pass", "unverified", j.checks?.find((c) => c.id === "ISSUE-002")?.effective ?? "(none)");
  }
  {
    runSelf(["init", "--target", "http://localhost:3000", ...D("run3")]);
    runSelf(["record", ...D("run3"), "--id", "A", "--check", "page loads", "--status", "pass", "--evidence", path.join(tmp, "run3", "gone.png")]);
    check("a pass pointing at a missing artifact FAILS the run", 1, runSelf(["verdict", "--json", ...D("run3")]).status);
  }
  {
    runSelf(["init", "--target", "http://localhost:3000", ...D("run4")]);
    runSelf(["record", ...D("run4"), "--id", "A", "--check", "page loads", "--status", "pass"]);
    check("a pass with no evidence at all FAILS the run", 1, runSelf(["verdict", "--json", ...D("run4")]).status);
  }
  {
    runSelf(["init", "--target", "http://localhost:3000", ...D("run5")]);
    runSelf(["record", ...D("run5"), "--id", "A", "--check", "health endpoint", "--status", "pass", "--http", "200", "--url", "http://localhost:3000/health"]);
    check("an HTTP 200 is acceptable evidence", 0, runSelf(["verdict", "--json", ...D("run5")]).status);
  }
  {
    runSelf(["init", "--target", "http://localhost:3000", ...D("run6")]);
    runSelf(["record", ...D("run6"), "--id", "A", "--check", "health endpoint", "--status", "pass", "--http", "500"]);
    check("an HTTP 500 cannot back a pass", 1, runSelf(["verdict", "--json", ...D("run6")]).status);
  }
  {
    // Only >= 500 used to block a pass, so a 404 with no artifact produced
    // "1/1 verified pass (100%)" and exit 0. A page that is not there is not
    // evidence that a page works.
    runSelf(["init", "--target", "http://localhost:3000", ...D("run6b")]);
    runSelf(["record", ...D("run6b"), "--id", "A", "--check", "dashboard loads", "--status", "pass", "--http", "404"]);
    const r = runSelf(["verdict", "--json", ...D("run6b")]);
    check("an HTTP 404 cannot back a pass either", 1, r.status);
    check("...and the reason names the status", true, /404/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    // Unless the 404 IS the thing under test, said out loud.
    runSelf(["init", "--target", "http://localhost:3000", ...D("run6c")]);
    const rec = runSelf(["record", "--json", ...D("run6c"), "--id", "A", "--check", "unknown route serves the 404 page", "--status", "pass", "--http", "404", "--expect-http", "404"]);
    check("a 404 declared as the expected outcome records", 0, rec.status, rec.stderr.trim());
    check("...and backs a pass", 0, runSelf(["verdict", "--json", ...D("run6c")]).status);
    const bad = runSelf(["record", "--json", ...D("run6c"), "--id", "B", "--check", "x", "--status", "pass", "--http", "500", "--expect-http", "404"]);
    check("an --expect-http that contradicts --http is refused", 2, bad.status);
  }

  // ---- recorded failures cannot be quietly overwritten
  {
    runSelf(["init", "--target", "http://x", ...D("run7")]);
    runSelf(["record", ...D("run7"), "--id", "A", "--check", "login", "--status", "fail"]);
    const r = runSelf(["record", "--json", ...D("run7"), "--id", "A", "--check", "login", "--status", "pass", "--evidence", shot("run7/a.png", 10)]);
    check("re-recording an existing check id is refused", 3, r.status);
    check("a recorded fail still fails the run", 1, runSelf(["verdict", "--json", ...D("run7")]).status);
    const f = runSelf(["record", "--json", ...D("run7"), "--force", "--id", "A", "--check", "login", "--status", "pass", "--evidence", shot("run7/a.png", 10)]);
    check("--force allows a deliberate re-record", 0, f.status, f.stderr.trim());
    check("and then the run passes", 0, runSelf(["verdict", "--json", ...D("run7")]).status);
  }

  // ---- argument validation
  runSelf(["init", "--target", "http://x", ...D("run8")]);
  check("record rejects an unknown status", 2, runSelf(["record", "--json", ...D("run8"), "--id", "A", "--check", "x", "--status", "probably"]).status);
  check("record rejects a missing check description", 2, runSelf(["record", "--json", ...D("run8"), "--id", "A", "--status", "pass"]).status);
  check("record rejects a non-status HTTP code", 2, runSelf(["record", "--json", ...D("run8"), "--id", "A", "--check", "x", "--status", "pass", "--http", "20"]).status);
  check("record before init is unusable", 2, runSelf(["record", "--json", ...D("run-never"), "--id", "A", "--check", "x", "--status", "pass"]).status);

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-qa", results);
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
  process.stdout.write("\n  The cases above are the ways a QA run goes green without testing anything:\n");
  process.stdout.write("  no checks recorded, a screenshot that is 0 bytes because the browser was\n");
  process.stdout.write("  down, an artifact path that does not exist, a 500 recorded as a pass, and a\n");
  process.stdout.write("  recorded failure overwritten. All of them fail here.\n\n");
  return true;
}

function help() {
  out(`
  tb-qa ${VERSION}  (Toolbay Stack)

  init --target <url> [--dir <d>]        start a run, print absolute paths
  record --id <id> --check "<what>" --status pass|fail|blocked
         [--evidence <file>] [--http <code>] [--expect-http <code>]
         [--url <u>] [--force]
  verdict [--dir <d>]                    compute PASS/FAIL from the evidence
  selftest                               prove it against runs that should fail

  Options: --json

  A "pass" needs an artifact that exists and is non-empty, or a real HTTP status
  from a real request. Without one it is recorded as unverified, and one
  unverified check fails the run. An empty ledger fails too.

  A 4xx or 5xx cannot back a pass. If the error status IS the expected result
  (a 404 page, a 401 auth wall), say so with --expect-http <same code>.

  Exit: 0 pass, 1 fail, 2 ledger/arguments unusable, 3 refused.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "init") cmdInit(argv.slice(1));
else if (cmd === "record") cmdRecord(argv.slice(1));
else if (cmd === "verdict") cmdVerdict(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
