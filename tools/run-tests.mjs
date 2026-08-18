#!/usr/bin/env node
/**
 * run-tests.mjs: run every engine's selftest, and refuse to pass if an engine
 * has no selftest to run.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This build tool is not derived from gstack's code, but the engines it runs
 * include files that are. See LICENSE and NOTICE.
 *
 * WHY THIS EXISTS. `npm test` used to be a hand-written `&&` chain naming seven
 * engines. Eight more had passing selftests that nothing ever ran, and two had
 * no selftest at all, so the suite went green over more than half the package.
 * A list of tests maintained by hand drifts the same way gstack's routing table
 * drifted, and for the same reason: nothing checks it against the disk.
 *
 * So the engines are DISCOVERED:
 *
 *   src/guard/tb-guard.mjs      the canonical safety engine
 *   bin/toolbay-stack.mjs       the installer
 *   skills/<name>/scripts/*.mjs every skill engine, including the copies of the
 *                               guard shipped inside careful/freeze/guard/
 *                               investigate, because those are separate files
 *                               that ship separately and can drift separately
 *
 * and an engine with no `selftest` command FAILS the run rather than being
 * skipped. Adding a skill without a selftest is therefore a broken build, not a
 * silent hole.
 *
 * Every selftest here prints "N/M passed". That line is parsed and required to
 * balance, so a selftest that runs zero assertions and exits 0 cannot pass this
 * runner either — the same fail-open the guard's copy check had.
 *
 * AND THE LIMIT OF ALL OF THAT. Discovering every engine and refusing to skip
 * one still leaves a hole you cannot see from inside an engine: every selftest
 * here checks an engine against fixtures THAT ENGINE WROTE. A pair of engines
 * can each be perfectly self-consistent and completely unable to talk to each
 * other, and this runner would report 119/119. It did: /context-save wrote
 * `saved_at:` and /context-restore required `timestamp:`, and the feature
 * shipped 0% functional under a green suite. tools/seam-tests.mjs exists for
 * exactly that hole and runs first among the repo-wide checks below.
 *
 *   node tools/run-tests.mjs           run everything
 *   node tools/run-tests.mjs --list    just say what would run
 *   node tools/run-tests.mjs --syntax  node --check every discovered engine
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/** Every executable this package ships, read off disk. */
function discoverEngines() {
  const engines = [];
  const add = (p) => {
    if (fs.existsSync(p)) engines.push(p);
  };
  // Every canonical shared module in src/, read off disk rather than named
  // here. This used to be a single hard-coded line for the guard engine, which
  // meant the modules promoted out of the skills later were the only files in
  // the package nothing ever ran.
  const srcDir = path.join(ROOT, "src");
  const walkSrc = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkSrc(p);
      else if (e.name.endsWith(".mjs")) add(p);
    }
  };
  if (fs.existsSync(srcDir)) walkSrc(srcDir);
  add(path.join(ROOT, "bin", "toolbay-stack.mjs"));

  const skillsDir = path.join(ROOT, "skills");
  for (const name of fs.readdirSync(skillsDir).sort()) {
    const scripts = path.join(skillsDir, name, "scripts");
    let entries;
    try {
      entries = fs.readdirSync(scripts);
    } catch (e) {
      // A skill with no scripts directory is a documentation-only skill, which
      // is legitimate. Anything else is a directory we were meant to read.
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
        throw new Error(`${rel(scripts)} could not be read (${e.code || e.message}); refusing to report a pass over it`);
      }
      continue;
    }
    for (const f of entries.sort()) {
      if (f.endsWith(".mjs")) engines.push(path.join(scripts, f));
    }
  }
  return engines;
}

/**
 * Does this file dispatch a `selftest` command at all. Both dispatch shapes in
 * use here are recognised: `cmd === "selftest"` and `case "selftest":`.
 */
function declaresSelftest(file) {
  const src = fs.readFileSync(file, "utf8");
  return /(?:===|case)\s*["']selftest["']/.test(src);
}

function run(label, argv, { expect = 0 } = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const ms = Date.now() - started;
  const problems = [];
  if (res.error) problems.push(`could not start: ${res.error.message}`);
  if (res.status !== expect) problems.push(`exited ${res.status}, expected ${expect}`);
  return { label, problems, stdout, stderr, ms, status: res.status };
}

const listOnly = process.argv.includes("--list");
const syntaxOnly = process.argv.includes("--syntax");

let engines;
try {
  engines = discoverEngines();
} catch (e) {
  out(red(`\n  ${e.message}\n`));
  process.exit(2);
}

const missing = engines.filter((e) => !declaresSelftest(e));
if (listOnly) {
  out();
  out(bold(`  ${engines.length} engines discovered`));
  for (const e of engines) out(`  ${declaresSelftest(e) ? green("ok ") : red("NO ")}  ${rel(e)}`);
  out();
  process.exit(missing.length ? 1 : 0);
}

if (syntaxOnly) {
  // The same discovered list, parsed rather than run. Fast enough for a
  // pre-commit hook, and it cannot fall behind the files on disk.
  let bad = 0;
  out();
  for (const e of engines) {
    const r = spawnSync(process.execPath, ["--check", e], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) {
      bad += 1;
      out(`  ${red("FAIL")}  ${rel(e)}`);
      out(dim(`        ${(r.stderr ?? "").trim().split("\n")[0]}`));
    } else out(`  ${green("ok  ")}  ${rel(e)}`);
  }
  out();
  process.exit(bad ? 1 : 0);
}

const failures = [];

// An engine with no selftest is a failure of the SUITE, stated before anything
// runs, so it cannot be lost in the scroll of a long green run.
for (const e of missing) {
  failures.push({ label: rel(e), problems: ["has no `selftest` command, so nothing about it is ever proved"] });
  out(`  ${red("NO SELFTEST")}  ${rel(e)}`);
}
if (missing.length) out();

// ---- repo-wide checks that are not any one engine's job
const repoChecks = [
  // THE SEAM TESTS RUN FIRST, deliberately.
  //
  // Everything below this line is an engine checking itself against fixtures it
  // wrote. That is worth having and it is not sufficient: all 119 of them passed
  // over a /context-save + /context-restore pair that had never once
  // round-tripped, because no test in this suite ever crossed from one engine
  // into another. These do. When one fails, the engine selftests underneath it
  // will very likely all still pass, and the seam is still the thing that is
  // broken. See tools/seam-tests.mjs.
  ["seam tests (engine to engine)", [path.join(ROOT, "tools", "seam-tests.mjs")]],
  ["sync-guard --check", [path.join(ROOT, "tools", "sync-guard.mjs"), "--check"]],
  ["router catalog --check", [path.join(ROOT, "skills", "router", "scripts", "route.mjs"), "catalog", "--bundled", "--check"]],
  // This is a credited fork, and the credit is a hand-maintained list. A hand
  // maintained list drifts, and nothing else in this suite would notice: a skill
  // added without its attribution header breaks no test.
  ["attribution --quiet", [path.join(ROOT, "tools", "check-attribution.mjs"), "--quiet"]],
  // The backtest harness compares this package against upstream and prints a
  // scoreboard. A scoreboard is worth exactly as much as its refusal to score
  // what it could not measure, so the rule that turns two verdicts into an
  // outcome, and every path that reaches it with a fixture that did not build,
  // an upstream that is not installed, a skill only one side has, or a process
  // that timed out, has its own selftest. It runs here for the same reason
  // every engine's does: a harness with no test is a claim with no evidence.
  ["backtest selftest", [path.join(ROOT, "tools", "backtest.mjs"), "selftest"]],
];

// Counted from the list rather than written into the banner, because the banner
// said "the two repo-wide consistency checks" for exactly as long as it took to
// add a third.
out();
out(bold(`  Toolbay Stack test suite`));
out(dim(`  ${engines.length} engines discovered on disk, plus ${repoChecks.length} repo-wide consistency checks`));
out();

for (const [label, argv] of repoChecks) {
  const r = run(label, argv);
  if (r.problems.length) failures.push(r);
  out(`  ${r.problems.length ? red("FAIL") : green("ok  ")}  ${label.padEnd(46)} ${dim(`${r.ms}ms`)}`);
  if (r.problems.length) for (const line of `${r.stdout}${r.stderr}`.trim().split("\n").slice(0, 12)) out(dim(`          ${line}`));
}

// ---- every engine's own selftest
for (const engine of engines) {
  if (!declaresSelftest(engine)) continue;
  const r = run(rel(engine), [engine, "selftest"]);
  // "N/M passed" is the shared shape of every selftest in this package.
  // Requiring it, and requiring it to balance, means a selftest that quietly
  // asserted nothing is a failure here even though it exited 0.
  const m = /(\d+)\/(\d+) passed/.exec(r.stdout);
  if (!m) r.problems.push('printed no "N/M passed" line, so it cannot be shown to have asserted anything');
  else if (m[1] !== m[2]) r.problems.push(`${m[1]} of ${m[2]} assertions passed`);
  else if (Number(m[2]) === 0) r.problems.push("ran 0 assertions");
  if (r.problems.length) failures.push(r);
  out(`  ${r.problems.length ? red("FAIL") : green("ok  ")}  ${rel(engine).padEnd(46)} ${dim(`${m ? `${m[2]} assertions, ` : ""}${r.ms}ms`)}`);
  if (r.problems.length) {
    for (const p of r.problems) out(red(`          ${p}`));
    for (const line of `${r.stdout}${r.stderr}`.trim().split("\n").slice(-14)) out(dim(`          ${line}`));
  }
}

out();
if (failures.length) {
  out(red(bold(`  ${failures.length} failure(s):`)));
  for (const f of failures) out(red(`    - ${f.label}: ${f.problems.join("; ")}`));
  out();
  process.exit(1);
}
out(green(bold(`  All ${engines.length} engines passed their own selftest, and every engine on disk has one.`)));
out();
