#!/usr/bin/env node
/**
 * tb-qaonly.mjs: the evidence ledger and the read-only seal behind /qa-only.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (report-only QA, the mode set full / quick /
 * regression, the eight weighted health-score categories and their deduction
 * bands, the per-issue screenshot evidence rule, the baseline.json regression
 * contract and the report layout) comes from `qa-only` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * /qa-only is the safe one. You point it at a client's app, it looks and it
 * writes a report, it does not touch anything. Everything in that sentence is
 * enforced in gstack by asking the model nicely.
 *
 * 1. "NEVER FIX ANYTHING" IS A SENTENCE, NOT A CONTROL. gstack qa-only says it
 *    in bold in the first paragraph and again in rule 11
 *    (qa-only/SKILL.md.tmpl:30, :113). Nothing looks at the working tree. A
 *    model that gets curious, or a hook, or a formatter that runs on save, can
 *    edit a client's source in the middle of a "read-only" audit and the report
 *    still says report-only at the top. Here `init` fingerprints the tree and
 *    `verdict` re-checks it: any changed, added or deleted file is a
 *    REPORT-ONLY VIOLATION, named, exit 4.
 *
 * 2. THE HEALTH SCORE OF AN APP THAT WAS NEVER OPENED IS 100. The rubric
 *    (qa-only/SKILL.md.tmpl -> QA_METHODOLOGY, "Health Score Rubric") is: 0
 *    console errors -> 100, 0 broken links -> 100, "each category starts at 100"
 *    and you deduct per finding. A run where the browser never launched has no
 *    findings, so every category stays at 100 and the weighted score is 100.0.
 *    That number goes in the report and in the PR. Here the score is computed
 *    from the ledger and refuses to exist below a coverage floor; `score` prints
 *    what the gstack rubric would have returned for the same empty run, so the
 *    difference is visible rather than argued.
 *
 * 3. EVERY ISSUE NEEDS A SCREENSHOT, "NO EXCEPTIONS" (rule 1 of the
 *    methodology) and no step ever opens one. A finding whose evidence file is
 *    missing, or is the 0 bytes that a failed headless screenshot leaves
 *    behind, still reads as evidenced in the report. Here it is `unevidenced`
 *    and it invalidates the report.
 *
 * 4. REGRESSION MODE FAILS OPEN. `--regression <baseline>` loads a baseline
 *    written by a previous run. If that file is missing, truncated, or from a
 *    different app, gstack defines no behaviour, and the natural degradation is
 *    a regression section that lists no new issues -- which reads as good news.
 *    Here a baseline that cannot be trusted exits non-zero and prints nothing
 *    that could be mistaken for a comparison.
 *
 * 5. `/tmp` IS TWO DIRECTORIES ON WINDOWS. gstack's setup table offers `Output
 *    to /tmp/qa` (qa-only/SKILL.md.tmpl:40). Git Bash resolves that under
 *    %LOCALAPPDATA%\Temp; Node, Python and PowerShell resolve it to C:\tmp. The
 *    browser writes the screenshot into one and the report links to the other.
 *    `init` refuses it and prints both directories.
 *
 * The ledger is a plain JSON file. Nothing here is clever; the point is that
 * the verdict, the score and the read-only claim are computed from recorded
 * facts instead of asserted in prose.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
    hint: 'Run "tb-qaonly.mjs init --target <url>" first. An unrecorded audit is not an audit.',
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
    defaultDir: defaultDir(),
    consequence: "The screenshots would land in one and the report would link to the other.",
  });
}

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_INVALID = 1; // the report cannot be trusted
const EXIT_UNUSABLE = 2; // the ledger or the arguments could not be used
const EXIT_REFUSED = 3; // a request that must not be honoured
const EXIT_VIOLATION = 4; // something was written during a read-only audit

const STATUSES = new Set(["pass", "fail", "blocked"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** gstack's eight categories and their weights, kept exactly. */
const WEIGHTS = {
  console: 0.15,
  links: 0.1,
  visual: 0.1,
  functional: 0.2,
  ux: 0.15,
  performance: 0.1,
  content: 0.05,
  accessibility: 0.15,
};
const CATEGORIES = new Set(Object.keys(WEIGHTS));
const DEDUCTION = { critical: 25, high: 15, medium: 8, low: 3 };

/** A report on fewer pages than this is not a report, it is a glance. */
const COVERAGE_FLOOR = 1;

// ------------------------------------------------------------------- paths

/** POSIX system directories that mean two different things on Windows. */

const defaultDir = () => path.resolve(process.env.TOOLBAY_QAONLY_DIR || path.join(process.cwd(), ".toolbay", "qa-only"));


// ------------------------------------------------------- the read-only seal
//
// The reason a client lets you run this at all.

const WALK_SKIP = new Set([
  ".git", "node_modules", ".toolbay", ".gstack", "dist", "build", "out",
  ".next", ".nuxt", ".svelte-kit", "coverage", "vendor", ".venv", "venv",
  "__pycache__", ".cache", ".turbo", ".parcel-cache", "target",
]);
const WALK_CAP = 20000;

function gitTop(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const top = (r.stdout || "").trim();
  return top ? path.resolve(fromMsysPath(top)) : null;
}

/**
 * { hash } or { skip } — never a bare null. A dirty file that could not be
 * hashed used to be dropped from the fingerprint entirely (`if (h) hashes[..]`),
 * and the diff needs a hash on BOTH sides, so rewriting a large already-dirty
 * file during the audit was invisible and the seal still read INTACT.
 */
function sha1File(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    // git lists deleted paths as dirty; there is genuinely nothing to hash.
    return e.code === "ENOENT" ? { hash: null, absent: true } : { skip: `cannot be read (${e.code || e.message})` };
  }
  if (!st.isFile()) return { hash: null, absent: true };
  if (st.size > 8 * 1024 * 1024) return { skip: `is ${st.size} bytes, over the 8MB hashing limit` };
  try {
    return { hash: crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex") };
  } catch (e) {
    return { skip: `cannot be read (${e.code || e.message})` };
  }
}

/** Strip the porcelain status prefix and any rename arrow. */
function statusPath(line) {
  const p = line.slice(3).trim();
  const after = p.includes(" -> ") ? p.split(" -> ").pop() : p;
  return after.replace(/^"|"$/g, "");
}

/**
 * A directory or file that could not be read lands in `unreadable`, not in the
 * bin. Both used to `continue`, which put those paths in neither the before nor
 * the after fingerprint: anything the audit did under them produced
 * `sealed: true, changes: []` and the report said the tree was INTACT. The seal
 * is the reason a client lets this run at all, so it now states what it could
 * not see, and the comparison refuses to call that sealed.
 */
function walkFingerprint(root) {
  const entries = {};
  const unreadable = [];
  let count = 0;
  let overflow = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      unreadable.push(`${path.relative(root, dir).split(path.sep).join("/") || "."}/ (${e.code || e.message})`);
      continue;
    }
    for (const it of items) {
      if (WALK_SKIP.has(it.name)) continue;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!it.isFile()) continue;
      if (++count > WALK_CAP) {
        overflow = true;
        break;
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        unreadable.push(`${path.relative(root, abs).split(path.sep).join("/")} (${e.code || e.message})`);
        continue;
      }
      entries[path.relative(root, abs).split(path.sep).join("/")] = `${st.size}:${Math.floor(st.mtimeMs)}`;
    }
    if (overflow) break;
  }
  if (overflow) {
    return { mode: "none", reason: `more than ${WALK_CAP} files under ${root}, so no read-only seal could be taken` };
  }
  return { mode: "walk", root, entries, unreadable };
}

/**
 * A fingerprint of everything the audit is not allowed to touch.
 * git mode is cheap and exact; the walk is the fallback; "none" means we could
 * not seal the tree, and that fails closed rather than passing quietly.
 */
function fingerprint(root) {
  let abs;
  try {
    abs = path.resolve(root);
    if (!fs.statSync(abs).isDirectory()) return { mode: "none", reason: `${abs} is not a directory` };
  } catch {
    return { mode: "none", reason: `${root} does not exist, so no read-only seal could be taken` };
  }
  const top = gitTop(abs);
  if (top) {
    const head = spawnSync("git", ["-C", top, "rev-parse", "HEAD"], { encoding: "utf8" });
    const st = spawnSync("git", ["-C", top, "status", "--porcelain", "-uall"], { encoding: "utf8" });
    if (!st.error && st.status === 0) {
      const lines = (st.stdout || "").split(/\r?\n/).filter(Boolean).sort();
      const hashes = {};
      const unhashed = {};
      for (const line of lines) {
        const rel = statusPath(line);
        const h = sha1File(path.join(top, rel));
        if (h.hash) hashes[rel] = h.hash;
        else if (h.skip) unhashed[rel] = h.skip;
      }
      return {
        mode: "git",
        root: top,
        head: !head.error && head.status === 0 ? (head.stdout || "").trim() : null,
        status: lines,
        hashes,
        unhashed,
        unreadable: [],
      };
    }
  }
  return walkFingerprint(abs);
}

function isIgnored(rel, ignore) {
  return ignore.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/** Returns the list of things that changed between two fingerprints. */
function diffFingerprints(before, after, ignore = []) {
  if (!before || before.mode === "none") {
    return { sealed: false, reason: before?.reason || "no fingerprint was taken at init", changes: [] };
  }
  if (after.mode === "none") return { sealed: false, reason: after.reason, changes: [] };
  if (before.mode !== after.mode) {
    return { sealed: false, reason: `the tree was sealed in ${before.mode} mode and re-read in ${after.mode} mode, so the two cannot be compared`, changes: [] };
  }

  const changes = [];
  if (before.mode === "git") {
    if (before.head !== after.head) changes.push(`HEAD moved ${before.head ?? "(none)"} -> ${after.head ?? "(none)"} (the audit committed something)`);
    const b = new Set(before.status.map(statusPath).filter((p) => !isIgnored(p, ignore)));
    const a = new Set(after.status.map(statusPath).filter((p) => !isIgnored(p, ignore)));
    for (const p of a) if (!b.has(p)) changes.push(`${p} was created or modified during the audit`);
    for (const p of b) if (!a.has(p)) changes.push(`${p} was reverted or deleted during the audit`);
    for (const p of b) {
      if (!a.has(p) || isIgnored(p, ignore)) continue;
      if (before.hashes[p] && after.hashes[p] && before.hashes[p] !== after.hashes[p]) {
        changes.push(`${p} was already dirty and its contents changed again during the audit`);
      } else if (!before.hashes[p] || !after.hashes[p]) {
        // One side has no hash, so "unchanged" is an assumption. Only claim it
        // when both sides agree the file is genuinely absent.
        const why = (before.unhashed ?? {})[p] || (after.unhashed ?? {})[p];
        if (why) changes.push(`${p} was already dirty and ${why}, so a change to it during the audit cannot be ruled out`);
      }
    }
  } else {
    const b = before.entries;
    const a = after.entries;
    for (const p of Object.keys(a)) {
      if (isIgnored(p, ignore)) continue;
      if (!(p in b)) changes.push(`${p} was created during the audit`);
      else if (b[p] !== a[p]) changes.push(`${p} was modified during the audit (${b[p]} -> ${a[p]})`);
    }
    for (const p of Object.keys(b)) {
      if (isIgnored(p, ignore)) continue;
      if (!(p in a)) changes.push(`${p} was deleted during the audit`);
    }
  }

  // A seal covers what it read. Paths that could not be read on either side are
  // in neither fingerprint, so nothing under them could ever show up as a
  // change: reporting INTACT over them is the fail-open this seal exists to
  // prevent. Say what was not covered and refuse to call it sealed.
  const blind = [
    ...(before.unreadable ?? []).map((u) => `at init: ${u}`),
    ...(after.unreadable ?? []).filter((u) => !(before.unreadable ?? []).includes(u)).map((u) => `at verify: ${u}`),
  ];
  if (blind.length) {
    return {
      sealed: false,
      reason: `${blind.length} path(s) could not be read, so they are in neither fingerprint and any change under them would be invisible: ${blind.slice(0, 5).join("; ")}`,
      changes,
    };
  }
  return { sealed: true, reason: null, changes };
}

// -------------------------------------------------------------- evidence

/**
 * A relative artifact path is written by whatever tool took the screenshot, from
 * whatever directory it was run in. `.toolbay/qa-only/screenshots/x.png` is the
 * obvious thing to type and it means the project root, not the output dir. Try
 * every base that is legitimately in play and say which ones were tried, rather
 * than reporting "does not exist" about a path nobody meant.
 */
function evidenceCandidates(raw, dir, root) {
  const s = fromMsysPath(String(raw));
  if (looksAbsolute(s)) return [path.resolve(s)];
  const c = [path.resolve(process.cwd(), s), path.resolve(dir, s)];
  if (root) c.push(path.resolve(root, s));
  return [...new Set(c)];
}

function resolveEvidence(raw, dir, root) {
  const tried = evidenceCandidates(raw, dir, root);
  for (const c of tried) {
    try {
      if (fs.statSync(c).isFile()) return { abs: c, tried };
    } catch {
      /* next */
    }
  }
  return { abs: tried[0], tried };
}

function verifyEvidence(check, dir, root) {
  const reasons = [];
  let verified = false;

  if (check.evidence) {
    const r = resolveEvidence(check.evidence, dir, root);
    const abs = r.abs;
    // One evidence standard for the whole package (src/artifact/tb-artifact.mjs).
    const art = checkArtifact(abs, { requirePng: /\.png$/i.test(abs) });
    if (!art.ok) reasons.push(fs.existsSync(abs) ? art.why : `evidence file does not exist (tried ${r.tried.join(", ")})`);
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

// ----------------------------------------------------------------- scoring

/**
 * gstack's rubric, computed. `gate` off reproduces gstack exactly, including
 * the part where a run that tested nothing scores 100.
 */
function computeScore(checks, dir, root) {
  const cats = {};
  for (const name of Object.keys(WEIGHTS)) cats[name] = { score: 100, deductions: [] };

  const findings = checks.filter((c) => c.status === "fail");
  const consoleFindings = findings.filter((c) => c.category === "console");
  const linkFindings = findings.filter((c) => c.category === "links");

  const n = consoleFindings.length;
  const band = n === 0 ? 100 : n <= 3 ? 70 : n <= 10 ? 40 : 10;
  cats.console.score = band;
  cats.console.deductions.push(`${n} console finding(s) -> band ${band}`);

  cats.links.score = Math.max(0, 100 - 15 * linkFindings.length);
  cats.links.deductions.push(`${linkFindings.length} broken link finding(s) x -15`);

  for (const f of findings) {
    if (f.category === "console" || f.category === "links") continue;
    const cat = cats[f.category];
    if (!cat) continue;
    const d = DEDUCTION[f.severity] ?? 0;
    cat.score -= d;
    cat.deductions.push(`${f.id} ${f.severity} -${d}`);
  }
  for (const name of Object.keys(cats)) cats[name].score = Math.max(0, cats[name].score);

  let weighted = 0;
  for (const [name, w] of Object.entries(WEIGHTS)) weighted += cats[name].score * w;

  const pages = new Set();
  for (const c of checks) {
    if (!c.url) continue;
    if (verifyEvidence(c, dir, root).verified) pages.add(c.url);
  }

  return { categories: cats, weighted: Math.round(weighted * 10) / 10, findings: findings.length, pages: [...pages] };
}

// ------------------------------------------------------------------ commands

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function flagAll(args, name) {
  const vals = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) vals.push(args[i + 1]);
  return vals;
}

const LABEL = { [EXIT_INVALID]: "INVALID", [EXIT_UNUSABLE]: "UNUSABLE", [EXIT_REFUSED]: "REFUSED", [EXIT_VIOLATION]: "VIOLATION" };

function fail(json, code, message) {
  if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
  else err(`  ${LABEL[code] ?? "ERROR"}  ${message}`);
  process.exitCode = code;
}

function cmdInit(args) {
  const json = args.includes("--json");
  const target = flag(args, "--target");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  if (!target) return fail(json, EXIT_UNUSABLE, "--target is required: an audit has to say what it looked at");

  const root = path.resolve(flag(args, "--root") || process.cwd());
  const seal = fingerprint(root);

  // Anything we write ourselves is not a violation.
  const sealRoot = seal.root || root;
  const rel = (p) => path.relative(sealRoot, p).split(path.sep).join("/");
  const ignore = [".toolbay", ".gstack"];
  const dirRel = rel(res.dir);
  if (dirRel && !dirRel.startsWith("..")) ignore.push(dirRel);

  const ledger = {
    _comment: "Toolbay Stack /qa-only ledger. Written by tb-qaonly.mjs. The health score, the report verdict and the read-only claim are computed from these records, not asserted.",
    target,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} node ${process.version}`,
    dir: res.dir,
    root: sealRoot,
    ignore,
    seal,
    checks: [],
  };
  fs.mkdirSync(path.join(res.dir, "screenshots"), { recursive: true });
  const file = writeLedger(res.dir, ledger);

  if (json) {
    out(JSON.stringify({ ok: true, dir: res.dir, ledger: file, seal: seal.mode, root: sealRoot }, null, 2));
    return;
  }
  out(`  target      ${target}`);
  out(`  dir         ${res.dir}`);
  out(`  screenshots ${path.join(res.dir, "screenshots")}`);
  out(`  ledger      ${file}`);
  out(`  read-only   sealed ${sealRoot} in ${seal.mode} mode${seal.mode === "none" ? ` (${seal.reason})` : ""}`);
  out();
  out("  Every path above is absolute, so a shell, a browser and this script all mean");
  out("  the same directory by them. Write nothing outside the dir above: verdict");
  out("  re-reads the tree and any change to it fails the audit.");
  if (seal.mode === "none") {
    out();
    out("  No seal was taken. verdict will refuse to certify this run as read-only");
    out("  unless you pass --allow-unsealed and say so in the report.");
  }
}

function cmdRecord(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const id = flag(args, "--id");
  const desc = flag(args, "--check");
  const status = (flag(args, "--status") || "").toLowerCase();
  const severity = (flag(args, "--severity") || "").toLowerCase();
  const category = (flag(args, "--category") || "").toLowerCase();
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
  if (status === "fail") {
    if (!SEVERITIES.has(severity)) bad.push(`a finding needs --severity (${[...SEVERITIES].join(", ")}); the score is computed from it`);
    if (!CATEGORIES.has(category)) bad.push(`a finding needs --category (${[...CATEGORIES].join(", ")}); the score is computed from it`);
  } else if (category && !CATEGORIES.has(category)) {
    bad.push(`--category ${category} is not one of ${[...CATEGORIES].join(", ")}`);
  }
  if (bad.length) {
    if (json) out(JSON.stringify({ ok: false, errors: bad }, null, 2));
    else for (const b of bad) err(`  UNUSABLE  ${b}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const existing = state.ledger.checks.findIndex((c) => c.id === id);
  if (existing !== -1 && !force) {
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
    severity: status === "fail" ? severity : null,
    category: category || null,
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

  const ev = verifyEvidence(check, res.dir, state.ledger.root);
  if (json) out(JSON.stringify({ ok: true, check, evidence: ev }, null, 2));
  else {
    out(`  recorded  ${id}  ${status}${severity ? `/${severity}` : ""}  ${desc}`);
    if (!ev.verified) for (const r of ev.reasons) out(`            ! ${r}`);
  }
}

function evaluate(dir, args = []) {
  const state = readLedger(dir);
  if (state.error) return { error: state.error };
  const ledger = state.ledger;

  const checks = ledger.checks.map((c) => {
    const ev = verifyEvidence(c, dir, ledger.root);
    return { ...c, evidenced: ev.verified, evidenceReasons: ev.reasons };
  });

  const problems = [];
  if (checks.length === 0) problems.push("no checks were recorded. An audit that recorded nothing is not a report.");
  for (const c of checks) {
    if (!c.evidenced) problems.push(`${c.id} (${c.status}) has no usable evidence: ${c.evidenceReasons.join("; ")}`);
  }

  const score = computeScore(checks, dir, ledger.root);
  if (score.pages.length < COVERAGE_FLOOR) {
    problems.push(`${score.pages.length} page(s) were visited with evidence, below the floor of ${COVERAGE_FLOOR}. A score computed over nothing is not a score.`);
  }

  const after = fingerprint(ledger.root || process.cwd());
  const seal = diffFingerprints(ledger.seal, after, ledger.ignore || []);
  const extraAllowed = flagAll(args, "--allow");
  const changes = seal.changes.filter((c) => !extraAllowed.some((p) => c.startsWith(p)));

  return { ledger, dir, checks, problems, score, seal: { ...seal, changes }, allowUnsealed: args.includes("--allow-unsealed") };
}

function cmdScore(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const v = evaluate(res.dir, args);
  if (v.error) return fail(json, EXIT_UNUSABLE, v.error);

  const short = v.score.pages.length < COVERAGE_FLOOR;
  if (json) {
    out(JSON.stringify({ ok: !short, score: short ? null : v.score.weighted, gstackRubricWouldSay: v.score.weighted, pages: v.score.pages, categories: v.score.categories, findings: v.score.findings }, null, 2));
  } else {
    out();
    out(`  pages with evidence  ${v.score.pages.length}`);
    out(`  findings             ${v.score.findings}`);
    out();
    for (const [name, w] of Object.entries(WEIGHTS)) {
      const c = v.score.categories[name];
      out(`  ${name.padEnd(14)} ${String(c.score).padStart(3)} x ${String(w).padEnd(5)} = ${(c.score * w).toFixed(1).padStart(5)}   ${c.deductions.join(", ")}`);
    }
    out();
    if (short) {
      out(`  NO SCORE  ${v.score.pages.length} page(s) were visited with evidence, below the floor of ${COVERAGE_FLOOR}.`);
      out(`            The same rubric, ungated, returns ${v.score.weighted.toFixed(1)} for this run: every category`);
      out("            starts at 100 and nothing was found because nothing was tested. That");
      out("            number is what goes in the report if no one checks the coverage.");
    } else {
      out(`  HEALTH SCORE  ${v.score.weighted.toFixed(1)} / 100  over ${v.score.pages.length} page(s)`);
    }
    out();
  }
  if (short) process.exitCode = EXIT_UNUSABLE;
}

function cmdVerdict(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const v = evaluate(res.dir, args);
  if (v.error) return fail(json, EXIT_UNUSABLE, v.error);

  const violated = v.seal.changes.length > 0;
  const unsealed = !v.seal.sealed && !v.allowUnsealed;
  const valid = v.problems.length === 0 && !violated && !unsealed;
  const findings = v.checks.filter((c) => c.status === "fail");

  if (json) {
    out(JSON.stringify({
      ok: valid,
      target: v.ledger.target,
      readOnly: violated ? "VIOLATED" : v.seal.sealed ? "INTACT" : "UNSEALED",
      readOnlyReason: v.seal.reason,
      changes: v.seal.changes,
      problems: v.problems,
      findings: findings.length,
      pages: v.score.pages.length,
      score: v.problems.length ? null : v.score.weighted,
    }, null, 2));
  } else {
    out();
    out(`  target    ${v.ledger.target}`);
    out(`  checks    ${v.checks.length}  (${findings.length} finding(s), ${v.score.pages.length} page(s) with evidence)`);
    out(`  read-only ${violated ? "VIOLATED" : v.seal.sealed ? "INTACT" : "UNSEALED"}`);
    for (const c of v.seal.changes) out(`            ! ${c}`);
    if (!v.seal.sealed) out(`            ! ${v.seal.reason}`);
    out();
    for (const c of v.checks) {
      const label = c.status === "fail" ? `FINDING/${c.severity}` : c.status.toUpperCase();
      out(`    ${label.padEnd(16)} ${c.id.padEnd(12)} ${c.check}`);
      if (!c.evidenced) for (const r of c.evidenceReasons) out(`                     ! ${r}`);
    }
    out();
    if (violated) {
      out("  VIOLATION  files changed during a read-only audit. The report is not");
      out("             report-only and must not be presented as one.");
    } else if (unsealed) {
      out(`  UNSEALED   ${v.seal.reason}`);
      out("             Nothing can certify that this audit changed nothing. Re-run from");
      out("             inside the project, or pass --allow-unsealed and say so in the report.");
    } else if (v.problems.length) {
      out("  INVALID    the report cannot be trusted:");
      for (const p of v.problems) out(`             - ${p}`);
    } else {
      out(`  VALID      ${findings.length} finding(s) over ${v.score.pages.length} page(s), health score ${v.score.weighted.toFixed(1)}/100, nothing was modified.`);
    }
    out();
  }

  if (violated) process.exitCode = EXIT_VIOLATION;
  else if (unsealed) process.exitCode = EXIT_VIOLATION;
  else if (!valid) process.exitCode = EXIT_INVALID;
}

function cmdBaseline(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const v = evaluate(res.dir, args);
  if (v.error) return fail(json, EXIT_UNUSABLE, v.error);

  if (v.problems.length || v.seal.changes.length || (!v.seal.sealed && !v.allowUnsealed)) {
    const message = "this run is not a valid report, so it cannot become the baseline everything else is measured against. Run verdict and fix what it names.";
    if (json) out(JSON.stringify({ ok: false, error: message, problems: v.problems, changes: v.seal.changes }, null, 2));
    else err(`  REFUSED  ${message}`);
    process.exitCode = EXIT_INVALID;
    return;
  }

  const file = path.resolve(flag(args, "--out") || path.join(res.dir, "baseline.json"));
  const baseline = {
    _comment: "Toolbay Stack /qa-only baseline. Compare with: tb-qaonly.mjs regression --baseline <this file>",
    target: v.ledger.target,
    date: new Date().toISOString(),
    healthScore: v.score.weighted,
    pages: v.score.pages,
    findings: v.checks.filter((c) => c.status === "fail").map((c) => ({ id: c.id, check: c.check, severity: c.severity, category: c.category, url: c.url })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  if (json) out(JSON.stringify({ ok: true, file, healthScore: baseline.healthScore, findings: baseline.findings.length }, null, 2));
  else {
    out(`  baseline  ${file}`);
    out(`  score     ${baseline.healthScore.toFixed(1)}  over ${baseline.pages.length} page(s), ${baseline.findings.length} finding(s)`);
  }
}

function cmdRegression(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const baseFile = flag(args, "--baseline");
  if (!baseFile) return fail(json, EXIT_UNUSABLE, "--baseline is required");

  const abs = path.resolve(fromMsysPath(baseFile));
  if (!fs.existsSync(abs)) {
    return fail(json, EXIT_UNUSABLE, `baseline ${abs} does not exist. Without it there is nothing to compare against, and "no new issues" would be a guess, not a result.`);
  }
  let base;
  try {
    base = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    return fail(json, EXIT_UNUSABLE, `baseline ${abs} is not valid JSON (${e.message}). A comparison against an unreadable baseline is not a comparison.`);
  }
  if (!base || typeof base !== "object" || !Array.isArray(base.findings) || typeof base.healthScore !== "number" || !base.target) {
    return fail(json, EXIT_UNUSABLE, `baseline ${abs} is missing target, healthScore or findings, so no regression can be computed from it`);
  }

  const v = evaluate(res.dir, args);
  if (v.error) return fail(json, EXIT_UNUSABLE, v.error);
  if (base.target !== v.ledger.target) {
    return fail(json, EXIT_REFUSED, `baseline is for ${base.target} and this run tested ${v.ledger.target}. Comparing two different apps produces a number that means nothing.`);
  }
  if (v.problems.length || v.seal.changes.length) {
    return fail(json, EXIT_INVALID, "this run is not a valid report yet, so a regression diff against it would be misleading. Run verdict first.");
  }

  const key = (f) => `${f.id}::${f.check}`;
  const baseKeys = new Map(base.findings.map((f) => [key(f), f]));
  const now = v.checks.filter((c) => c.status === "fail");
  const nowKeys = new Map(now.map((f) => [key(f), f]));
  const fixed = [...baseKeys.values()].filter((f) => !nowKeys.has(key(f)));
  const introduced = [...nowKeys.values()].filter((f) => !baseKeys.has(key(f)));
  const persisting = [...nowKeys.values()].filter((f) => baseKeys.has(key(f)));
  const delta = Math.round((v.score.weighted - base.healthScore) * 10) / 10;

  if (json) {
    out(JSON.stringify({ ok: true, baseline: abs, target: base.target, was: base.healthScore, now: v.score.weighted, delta, fixed, introduced, persisting }, null, 2));
  } else {
    out();
    out(`  baseline  ${abs}  (${base.date ?? "no date"})`);
    out(`  score     ${base.healthScore.toFixed(1)} -> ${v.score.weighted.toFixed(1)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);
    out(`  fixed     ${fixed.length}`);
    for (const f of fixed) out(`            - ${f.id} ${f.check}`);
    out(`  new       ${introduced.length}`);
    for (const f of introduced) out(`            - ${f.id} ${f.severity} ${f.check}`);
    out(`  still     ${persisting.length}`);
    out();
  }
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { env = {}, cwd } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env }, cwd });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const base = process.env.TOOLBAY_SELFTEST_DIR ? path.resolve(process.env.TOOLBAY_SELFTEST_DIR) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(base, "tb-qaonly-selftest-"));

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // The pretend projects below are plain directories. When one of them resolves
  // to a repository root outside the sandbox, `verdict` runs
  // `git status --porcelain -uall` against THAT root — and if the root is the
  // user's home directory, that is a walk of every file the user owns. Found on
  // this machine 2026-08-16: a stray `git init` in HOME turned this selftest
  // into a full-drive scan that never finished, so `npm test` did not fail, it
  // simply hung, which is the worst of the three possible outcomes.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const artifact = (n, bytes) => {
    const p = path.join(tmp, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes > 0 && /\.png$/i.test(p) ? makePngOfSize(bytes) : Buffer.alloc(bytes));
    return p;
  };
  /** A pretend project to audit, outside the output dir. */
  const project = (n, files) => {
    const root = path.join(tmp, n);
    fs.mkdirSync(root, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      const abs = path.join(root, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, "utf8");
    }
    return root;
  };
  const goodFinding = (dir, id, extra = []) => [
    "record", ...D(dir), "--id", id, "--check", `${id} repro`, "--status", "fail",
    "--severity", "high", "--category", "functional", "--url", "http://localhost:3000/x",
    "--evidence", artifact(`${dir}/screenshots/${id}.png`, 4096), ...extra,
  ];

  // ---- init
  {
    const root = project("proj1", { "app.js": "console.log(1)\n" });
    const r = runSelf(["init", "--json", "--target", "http://localhost:3000", "--root", root, ...D("run1")]);
    check("init creates a ledger", 0, r.status, r.stderr.trim());
    const j = JSON.parse(r.stdout || "{}");
    check("init reports an absolute directory", true, Boolean(j.dir) && path.isAbsolute(j.dir), j.dir);
    check("init seals the project tree", true, j.seal === "git" || j.seal === "walk", j.seal);
  }
  check("init requires a target", 2, runSelf(["init", "--json", ...D("run-notarget")]).status);
  if (isWindows) {
    const r = runSelf(["init", "--target", "http://x", "--dir", "/tmp/qa"]);
    check("init refuses /tmp on Windows, where it means two directories", 3, r.status);
    const said = `${r.stdout}${r.stderr}`;
    check("...and names both of them", true, /AppData[\\/]Local[\\/]Temp/.test(said) && /C:[\\/]tmp[\\/]qa/.test(said), said.trim().slice(0, 200));
  }

  // ---- an empty audit is not a clean bill of health
  check("verdict with no ledger is unusable, not clean", 2, runSelf(["verdict", "--json", ...D("never-inited")]).status);
  {
    const dir = path.join(tmp, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.json"), "{ not json", "utf8");
    check("verdict on a corrupt ledger is unusable, not clean", 2, runSelf(["verdict", "--json", "--dir", dir]).status);
  }
  check("verdict on an audit that recorded nothing is INVALID", 1, runSelf(["verdict", "--json", ...D("run1")]).status);
  {
    // The headline gstack behaviour: its rubric scores an untested app 100.
    const r = runSelf(["score", "--json", ...D("run1")]);
    check("score refuses to score an audit with no coverage", 2, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...and names the 100 that the ungated rubric would have printed", 100, j.gstackRubricWouldSay, JSON.stringify(j.categories?.console ?? {}));
    check("...and returns no score of its own", "null", JSON.stringify(j.score));
  }

  // ---- every finding needs an artifact that exists and is not empty
  {
    const root = project("proj2", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run2")]);
    runSelf(["record", ...D("run2"), "--id", "ISSUE-001", "--check", "checkout 500s", "--status", "fail", "--severity", "critical", "--category", "functional", "--url", "http://localhost:3000/checkout"]);
    check("a finding with no evidence at all makes the report INVALID", 1, runSelf(["verdict", "--json", ...D("run2")]).status);
  }
  {
    const root = project("proj3", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run3")]);
    runSelf([...goodFinding("run3", "ISSUE-001").slice(0, -1), artifact("run3/screenshots/empty.png", 0)]);
    const r = runSelf(["verdict", "--json", ...D("run3")]);
    check("a finding backed by a 0-byte screenshot makes it INVALID", 1, r.status);
    check("...and says the file is 0 bytes", true, /0 bytes/.test(r.stdout), r.stdout.slice(0, 160));
  }
  {
    const root = project("proj4", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run4")]);
    runSelf(["record", ...D("run4"), "--id", "A", "--check", "x", "--status", "fail", "--severity", "low", "--category", "visual", "--evidence", path.join(tmp, "run4", "gone.png")]);
    check("a finding pointing at a missing artifact makes it INVALID", 1, runSelf(["verdict", "--json", ...D("run4")]).status);
  }

  // ---- a finding without a severity cannot be scored, so it is refused
  {
    const root = project("proj5", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run5")]);
    check("record rejects a finding with no severity", 2, runSelf(["record", "--json", ...D("run5"), "--id", "A", "--check", "x", "--status", "fail", "--category", "functional"]).status);
    check("record rejects a finding with no category", 2, runSelf(["record", "--json", ...D("run5"), "--id", "A", "--check", "x", "--status", "fail", "--severity", "high"]).status);
    check("record rejects an invented category", 2, runSelf(["record", "--json", ...D("run5"), "--id", "A", "--check", "x", "--status", "fail", "--severity", "high", "--category", "vibes"]).status);
    check("record rejects an unknown status", 2, runSelf(["record", "--json", ...D("run5"), "--id", "A", "--check", "x", "--status", "probably"]).status);
    check("record before init is unusable", 2, runSelf(["record", "--json", ...D("run-never"), "--id", "A", "--check", "x", "--status", "pass"]).status);
  }

  // ---- the read-only seal
  {
    const root = project("proj6", { "src/app.js": "const a = 1\n", "README.md": "hi\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run6")]);
    runSelf(goodFinding("run6", "ISSUE-001"));
    check("a clean read-only audit is VALID", 0, runSelf(["verdict", "--json", ...D("run6")]).status, JSON.stringify(runSelf(["verdict", "--json", ...D("run6")]).stdout).slice(0, 300));

    fs.writeFileSync(path.join(root, "src/app.js"), "const a = 2 // 'fixed' it\n", "utf8");
    const r = runSelf(["verdict", "--json", ...D("run6")]);
    check("editing a source file during the audit is a VIOLATION", 4, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...and the file is named", true, JSON.stringify(j.changes || []).includes("src/app.js"), JSON.stringify(j.changes));
    check("...and readOnly is reported VIOLATED", "VIOLATED", j.readOnly);
  }
  {
    const root = project("proj7", { "src/app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run7")]);
    runSelf(goodFinding("run7", "ISSUE-001"));
    fs.writeFileSync(path.join(root, "src/new-file.js"), "// added\n", "utf8");
    check("creating a file during the audit is a VIOLATION", 4, runSelf(["verdict", "--json", ...D("run7")]).status);
  }
  {
    const root = project("proj8", { "src/app.js": "x\n", "gone.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run8")]);
    runSelf(goodFinding("run8", "ISSUE-001"));
    fs.rmSync(path.join(root, "gone.js"));
    check("deleting a file during the audit is a VIOLATION", 4, runSelf(["verdict", "--json", ...D("run8")]).status);
  }
  {
    // Writing the report and the screenshots must NOT trip the seal.
    const root = project("proj9", { "src/app.js": "x\n" });
    const dir = path.join(root, ".toolbay", "qa-only");
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, "--dir", dir]);
    const shot = path.join(dir, "screenshots", "ISSUE-001.png");
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, makePngOfSize(2048));
    runSelf(["record", "--dir", dir, "--id", "ISSUE-001", "--check", "x", "--status", "fail", "--severity", "high", "--category", "ux", "--url", "http://localhost:3000/", "--evidence", shot]);
    fs.writeFileSync(path.join(dir, "qa-report-localhost-2026-01-01.md"), "# report\n", "utf8");
    const r = runSelf(["verdict", "--json", "--dir", dir]);
    check("writing the report and screenshots is not a violation", 0, r.status, r.stdout.slice(0, 300));
  }
  {
    // The seal used to `continue` past anything it could not read, which put
    // those paths in neither fingerprint: a mutation under them was invisible
    // and the report still said INTACT. These two run against the comparison
    // directly, because a directory that genuinely refuses to be read cannot be
    // created portably, and the behaviour has to be asserted somewhere.
    const blindBefore = { mode: "walk", root: "/p", entries: { "a.js": "1:1" }, unreadable: ["locked/ (EACCES)"] };
    const blindAfter = { mode: "walk", root: "/p", entries: { "a.js": "1:1" }, unreadable: ["locked/ (EACCES)"] };
    const d1 = diffFingerprints(blindBefore, blindAfter);
    check("a directory the seal could not read is not sealed", false, d1.sealed);
    check("...and the reason names it", true, /locked\//.test(d1.reason || ""), d1.reason || "");
    const clean = { mode: "walk", root: "/p", entries: { "a.js": "1:1" }, unreadable: [] };
    check("...while a fully readable tree still seals", true, diffFingerprints(clean, clean).sealed);
  }
  {
    // Same shape in git mode: a dirty file too large to hash was dropped from
    // both sides, so rewriting it during the audit produced no change at all.
    const big = ["?? big.bin"];
    const gBefore = { mode: "git", root: "/p", head: "abc", status: big, hashes: {}, unhashed: { "big.bin": "is 99999999 bytes, over the 8MB hashing limit" }, unreadable: [] };
    const gAfter = { mode: "git", root: "/p", head: "abc", status: big, hashes: {}, unhashed: { "big.bin": "is 99999999 bytes, over the 8MB hashing limit" }, unreadable: [] };
    const d2 = diffFingerprints(gBefore, gAfter);
    check("a dirty file that could not be hashed is reported, not dropped", 1, d2.changes.length, JSON.stringify(d2.changes));
    check("...and says a change to it cannot be ruled out", true, /cannot be ruled out/.test(d2.changes[0] || ""), d2.changes[0] || "");
  }
  {
    // A 4xx recorded as a pass with nothing else behind it.
    const root = project("proj404", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run404")]);
    runSelf(["record", ...D("run404"), "--id", "A", "--check", "dashboard loads", "--status", "pass", "--http", "404", "--url", "http://localhost:3000/dashboard"]);
    const r = runSelf(["verdict", "--json", ...D("run404")]);
    check("a 404 recorded as a pass makes the report INVALID", 1, r.status, r.stdout.slice(0, 200));
    check("...and the reason names the status", true, /404/.test(r.stdout), r.stdout.slice(0, 300));
    const ok = runSelf(["record", "--json", ...D("run404"), "--force", "--id", "A", "--check", "unknown route serves the 404 page", "--status", "pass", "--http", "404", "--expect-http", "404", "--url", "http://localhost:3000/nope"]);
    check("...unless 404 is declared as the expected outcome", 0, ok.status, ok.stderr.trim());
    check("...and then the report is valid again", 0, runSelf(["verdict", "--json", ...D("run404")]).status);
  }
  {
    // No seal could be taken -> fail closed, not quietly certify.
    const root = project("proj10", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run10")]);
    runSelf(goodFinding("run10", "ISSUE-001"));
    fs.rmSync(root, { recursive: true, force: true });
    const r = runSelf(["verdict", "--json", ...D("run10")]);
    check("an audit whose tree cannot be re-read fails CLOSED", 4, r.status);
    check("...and says it is UNSEALED rather than clean", "UNSEALED", JSON.parse(r.stdout || "{}").readOnly);
    check("...and --allow-unsealed is the only way past it", 0, runSelf(["verdict", "--json", "--allow-unsealed", ...D("run10")]).status);
  }

  // ---- relative artifact paths, which is what a person actually types
  {
    const root = project("proj16", { "src/app.js": "x\n" });
    const dir = path.join(root, ".toolbay", "qa-only");
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, "--dir", dir]);
    const shot = path.join(dir, "screenshots", "issue-001.png");
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, makePngOfSize(1024));
    const rel = ".toolbay/qa-only/screenshots/issue-001.png";
    const r = runSelf(["record", "--json", "--dir", dir, "--id", "ISSUE-001", "--check", "cart total", "--status", "fail", "--severity", "high", "--category", "functional", "--url", "http://localhost:3000/cart", "--evidence", rel], { cwd: root });
    check("a project-relative artifact path is accepted", true, JSON.parse(r.stdout || "{}").evidence?.verified === true, r.stdout.slice(0, 240));
    // verdict runs from somewhere else entirely, as it will in a real session
    check("...and still resolves from a different working directory", 0, runSelf(["verdict", "--json", "--dir", dir]).status);
  }
  {
    const root = project("proj17", { "src/app.js": "x\n" });
    const dir = path.join(root, ".toolbay", "qa-only");
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, "--dir", dir]);
    runSelf(["record", "--dir", dir, "--id", "A", "--check", "x", "--status", "fail", "--severity", "low", "--category", "visual", "--url", "http://x/", "--evidence", "screenshots/never-taken.png"], { cwd: root });
    const r = runSelf(["verdict", "--json", "--dir", dir]);
    check("a relative path that exists nowhere still FAILS", 1, r.status);
    check("...and the error lists every base it tried", true, /tried .*never-taken\.png, .*never-taken\.png/.test(r.stdout), r.stdout.slice(0, 300));
  }

  // ---- the score, computed
  {
    const root = project("proj11", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run11")]);
    runSelf(goodFinding("run11", "ISSUE-001")); // high, functional -> -15 on a 20% category
    const r = runSelf(["score", "--json", ...D("run11")]);
    check("one high functional finding scores 97.0, not 100", 97, JSON.parse(r.stdout || "{}").score, r.stdout.slice(0, 200));
    check("score exits 0 when it has coverage", 0, r.status);
  }
  {
    const root = project("proj12", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run12")]);
    for (const id of ["C1", "C2", "C3", "C4"]) {
      runSelf(["record", ...D("run12"), "--id", id, "--check", `${id} console error`, "--status", "fail", "--severity", "medium", "--category", "console", "--url", "http://localhost:3000/", "--evidence", artifact(`run12/screenshots/${id}.png`, 512)]);
    }
    const j = JSON.parse(runSelf(["score", "--json", ...D("run12")]).stdout || "{}");
    check("4 console errors hit the 40 band, per gstack's rubric", 40, j.categories?.console?.score);
    check("...which is 91.0 overall", 91, j.score);
  }

  // ---- duplicate records
  {
    const root = project("proj13", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run13")]);
    runSelf(goodFinding("run13", "ISSUE-001"));
    check("re-recording an existing id is refused", 3, runSelf(["record", "--json", ...goodFinding("run13", "ISSUE-001").slice(1)]).status);
    check("--force allows a deliberate re-record", 0, runSelf([...goodFinding("run13", "ISSUE-001"), "--force"]).status);
  }

  // ---- regression fails closed
  {
    const root = project("proj14", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run14")]);
    runSelf(goodFinding("run14", "ISSUE-001"));
    const baseFile = path.join(tmp, "run14", "baseline.json");
    check("baseline is written from a valid run", 0, runSelf(["baseline", "--json", ...D("run14"), "--out", baseFile]).status);

    check("regression against a baseline that does not exist FAILS", 2, runSelf(["regression", "--json", ...D("run14"), "--baseline", path.join(tmp, "nope.json")]).status);
    const corrupt = path.join(tmp, "corrupt-baseline.json");
    fs.writeFileSync(corrupt, "{ half a file", "utf8");
    check("regression against a corrupt baseline FAILS", 2, runSelf(["regression", "--json", ...D("run14"), "--baseline", corrupt]).status);
    const partial = path.join(tmp, "partial-baseline.json");
    fs.writeFileSync(partial, JSON.stringify({ target: "http://localhost:3000" }), "utf8");
    check("regression against a baseline with no findings array FAILS", 2, runSelf(["regression", "--json", ...D("run14"), "--baseline", partial]).status);
    const other = path.join(tmp, "other-baseline.json");
    fs.writeFileSync(other, JSON.stringify({ target: "https://someone-elses-app.com", healthScore: 90, findings: [] }), "utf8");
    check("regression against another app's baseline is refused", 3, runSelf(["regression", "--json", ...D("run14"), "--baseline", other]).status);

    // and the happy path still works
    runSelf(["record", ...D("run14"), "--id", "ISSUE-002", "--check", "new bug", "--status", "fail", "--severity", "low", "--category", "visual", "--url", "http://localhost:3000/y", "--evidence", artifact("run14/screenshots/ISSUE-002.png", 900)]);
    const r = runSelf(["regression", "--json", ...D("run14"), "--baseline", baseFile]);
    check("regression against a real baseline works", 0, r.status, r.stderr.trim());
    const j = JSON.parse(r.stdout || "{}");
    check("...and reports the newly introduced finding", 1, (j.introduced || []).length, JSON.stringify(j.introduced));
  }
  {
    // A baseline minted from a broken run would poison every later comparison.
    const root = project("proj15", { "app.js": "x\n" });
    runSelf(["init", "--target", "http://localhost:3000", "--root", root, ...D("run15")]);
    runSelf(["record", ...D("run15"), "--id", "A", "--check", "x", "--status", "fail", "--severity", "high", "--category", "ux"]);
    check("a baseline cannot be minted from an invalid run", 1, runSelf(["baseline", "--json", ...D("run15"), "--out", path.join(tmp, "bad-baseline.json")]).status);
  }

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }
  return report("tb-qaonly", results);
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
  process.stdout.write("\n  Those are the ways a report-only audit lies: an app that was never opened\n");
  process.stdout.write("  scoring 100, a finding with no screenshot behind it, a regression diff against\n");
  process.stdout.write("  a baseline that is missing or belongs to another app, and source files edited\n");
  process.stdout.write("  in the middle of an audit that still calls itself read-only. All fail here.\n\n");
  return true;
}

function help() {
  out(`
  tb-qaonly ${VERSION}  (Toolbay Stack)

  init --target <url> [--root <project>] [--dir <d>]
        start an audit, seal the tree, print absolute paths
  record --id <id> --check "<what>" --status pass|fail|blocked
        [--severity critical|high|medium|low] [--category <c>]
        [--url <u>] [--http <code>] [--expect-http <code>]
        [--evidence <file>] [--force]
  score [--dir <d>]                      the eight-category health score, computed
  verdict [--dir <d>] [--allow <path>] [--allow-unsealed]
        is this report trustworthy, and did the audit touch anything
  baseline --out <file>                  freeze a valid run for later comparison
  regression --baseline <file>           diff against a baseline, or fail
  selftest                               prove it against audits that should fail

  Options: --json

  Categories: ${[...CATEGORIES].join(", ")}

  A finding needs an artifact that exists and is non-empty, or a real HTTP status.
  A score needs at least ${COVERAGE_FLOOR} page visited with evidence. A read-only audit
  needs a tree that is byte-identical afterwards.

  Exit: 0 valid, 1 invalid report, 2 ledger/arguments unusable, 3 refused,
        4 read-only violated or unsealed.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "init") cmdInit(argv.slice(1));
else if (cmd === "record") cmdRecord(argv.slice(1));
else if (cmd === "score") cmdScore(argv.slice(1));
else if (cmd === "verdict") cmdVerdict(argv.slice(1));
else if (cmd === "baseline") cmdBaseline(argv.slice(1));
else if (cmd === "regression") cmdRegression(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
