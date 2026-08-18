#!/usr/bin/env node
/**
 * seam-tests.mjs: the tests that cross from one engine into another.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This build tool is not derived from gstack's code. See LICENSE and NOTICE.
 *
 * WHY THIS EXISTS — and it is the most important file in tools/.
 *
 * Every engine in this package has a selftest, all of them pass, and the suite
 * has been green over three shipped defects that a stranger hit inside ten
 * minutes of the first clean install. The reason is structural, not sloppy:
 *
 *   EVERY ENGINE TESTS AGAINST FIXTURES IT WROTE ITSELF.
 *
 * tb-context.mjs proves it can save a file and read that file back. It passes.
 * tb-context-restore.mjs proves it can read a saved context — one that its own
 * selftest hand-wrote, in its own idea of the format. It passes. Neither of them
 * ever ran the other, so /context-save and /context-restore shipped as a paired
 * feature that had NEVER ONCE round-tripped: the saver wrote `saved_at:` and the
 * restorer required `timestamp:`, and save's own `verify` accepted either name,
 * so it certified its own output. 119 green selftests over a feature that was
 * 0% functional.
 *
 * That is this project's own thesis failing one level up. The whole argument of
 * Toolbay Stack is that a claim must be checked against reality rather than
 * asserted — and a fixture an engine wrote for itself is not reality, it is the
 * engine's assertion in a different font.
 *
 * So the rule here: NO HAND-WRITTEN FIXTURES ON EITHER SIDE OF A SEAM. Each test
 * below runs the REAL producer, takes its REAL output, and feeds it to the REAL
 * consumer. If a test needs a saved context, it saves one with the save engine.
 * If it needs an installed skill, it installs one with the installer.
 *
 * Each test states the defect it would have caught, so it can be re-pointed
 * rather than deleted when the code moves.
 *
 *   node tools/seam-tests.mjs           run them
 *   node tools/seam-tests.mjs --list    name them without running
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (s = "") => process.stdout.write(`${s}\n`);

const SAVE = path.join(ROOT, "skills", "context-save", "scripts", "tb-context.mjs");
const RESTORE = path.join(ROOT, "skills", "context-restore", "scripts", "tb-context-restore.mjs");
const INVESTIGATE = path.join(ROOT, "skills", "investigate", "scripts", "tb-investigate.mjs");
const INSTALLER = path.join(ROOT, "bin", "toolbay-stack.mjs");

const results = [];
const check = (name, expected, got, detail = "") =>
  results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail: String(detail).slice(0, 600) });

function node(args, { cwd, env, input } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    input,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const GIT_ID = ["-c", "user.email=seam@toolbay.invalid", "-c", "user.name=tb seam"];
function git(args, cwd) {
  return spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8", windowsHide: true });
}

// ===========================================================================
// SEAM 1  /context-save  ->  /context-restore
//
// THE DEFECT THIS CATCHES. Save wrote `saved_at:` into the frontmatter. Restore
// required `["branch","timestamp"]` (tb-context-restore.mjs:487) and never
// looked at `saved_at`, so it classified every file save produced as "not a
// saved context" and reported NO SAVED CONTEXTS over a full drawer. Two further
// disagreements sat behind that one and would have surfaced the moment the field
// was renamed: save wrote the time in UTC while the filename stamp is local wall
// clock (restore calls an hour of disagreement disputed provenance), and save
// filed the drawer under a lower-cased repo-root basename while restore looked
// under `owner-repo` from the git remote.
//
// NOTE THE SHAPE: nothing below writes a context file. The save engine writes
// it. That is the entire point.
// ===========================================================================

function seamSaveRestore(tmp) {
  const gitOk = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
  if (!gitOk) {
    check("git is available, so the save/restore seam can be crossed in a repo", true, false, "git is not on PATH");
    return;
  }

  // A repository shaped like a real one: a remote, a branch, committed history,
  // and uncommitted work. The remote matters — it is what makes the save side
  // and the restore side derive different project slugs.
  const repo = path.join(tmp, "Widget");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["remote", "add", "origin", "https://github.com/acme/Widget.git"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "widget\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["checkout", "-q", "-b", "auth-refactor"], repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "session.ts"), "// session\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "tokens.ts"), "// tokens\n", "utf8");

  const state = path.join(tmp, "state");
  const env = { TOOLBAY_STACK_STATE_DIR: state, GSTACK_HOME: path.join(tmp, "no-gstack"), TOOLBAY_SESSION_ID: "seam" };

  const payload = path.join(tmp, "payload.json");
  fs.writeFileSync(
    payload,
    JSON.stringify({
      title: "auth refactor",
      summary: "Moving session handling off cookies and onto short-lived tokens so the mobile client stops getting logged out.",
      decisions: ["Tokens live 15 minutes", "No migration for existing sessions"],
      remaining: ["Wire the refresh endpoint", "Delete the legacy cookie parser"],
      notes: ["Sliding-window cookies broke Safari ITP"],
    }),
    "utf8",
  );

  // ---- the REAL save engine
  const saved = node([SAVE, "save", "--payload", payload], { cwd: repo, env });
  check("the real save engine saves into a real repository", 0, saved.status, saved.all.slice(0, 400));
  const m = /File\s+(.+\.md)\s*$/m.exec(saved.stdout);
  const file = m ? m[1].trim() : null;
  check("...and the banner names a file that exists on disk", true, Boolean(file) && fs.existsSync(file), file || saved.stdout.slice(0, 400));
  if (!file || !fs.existsSync(file)) return;

  // ---- the REAL restore engine, on the REAL file the save engine just wrote
  const restored = node([RESTORE, "restore", "--json"], { cwd: repo, env });
  let j = {};
  try {
    j = JSON.parse(restored.stdout || "{}");
  } catch {
    j = {};
  }
  check(
    "the real restore engine loads the file the real save engine wrote",
    0,
    restored.status,
    `${restored.stdout.slice(0, 500)}${restored.stderr.slice(0, 200)}`,
  );
  check("...with verdict OK, not STALE and not REFUSED", "OK", j.verdict ?? "(no verdict)", JSON.stringify(j.checks ?? []).slice(0, 500));
  check("...and it is the same file, not some other one", path.resolve(file), j.file ? path.resolve(j.file) : "(none)", restored.stdout.slice(0, 300));
  check("...on the branch the save recorded", "auth-refactor", j.branch ?? "(none)");
  check(
    "...with the timestamp check passing, so the two clocks agree",
    "pass",
    (j.checks ?? []).find((c) => c.name === "timestamp provenance")?.state ?? "(no such check)",
    JSON.stringify((j.checks ?? []).find((c) => c.name === "timestamp provenance") ?? {}),
  );
  check(
    "...and the files the save recorded are found in the tree",
    "pass",
    (j.checks ?? []).find((c) => c.name === "recorded files still exist")?.state ?? "(no such check)",
    JSON.stringify((j.checks ?? []).find((c) => c.name === "recorded files still exist") ?? {}),
  );
  // And `files_modified` has to mean files. With git's default untracked mode a
  // wholly-untracked directory collapses to one entry, `src/`, so the field the
  // restore side checks against the tree said "src/" where two files were
  // touched — useless to a future session, and refused outright by a restore
  // that requires a file. This asserts what the save actually recorded, not
  // merely that restore was willing to accept it.
  {
    const fm = fs.readFileSync(file, "utf8").split("\n---")[0];
    const listed = [...fm.matchAll(/^ {2}- "(.+)"$/gm)].map((x) => x[1]).filter((p) => /session\.ts|tokens\.ts|^src\//.test(p));
    check("the save recorded the individual files, not the directory holding them", "src/session.ts,src/tokens.ts", listed.sort().join(","), fm.slice(0, 800));
  }

  // The human-readable path carries the actual work, which is the payload of the
  // whole feature. A restore that exits 0 and prints no remaining work is still
  // a broken restore.
  const human = node([RESTORE, "restore"], { cwd: repo, env });
  check("...and the restored body carries the remaining work", true, /Wire the refresh endpoint/.test(human.stdout), human.stdout.slice(-600));

  // `list` is the other half of the lookup, and it fails the same way for the
  // same reason: a drawer it cannot classify reads as an empty drawer.
  const listed = node([RESTORE, "list"], { cwd: repo, env });
  check("restore's list sees the save, rather than reporting an empty drawer", true, /auth-refactor/.test(listed.stdout), listed.stdout.slice(0, 600));

  // A restore run from a SUBDIRECTORY has to find the same drawer. This is the
  // slug half of the seam, isolated: same repo, different cwd.
  const fromSub = node([RESTORE, "restore", "--json"], { cwd: path.join(repo, "src"), env });
  let js = {};
  try {
    js = JSON.parse(fromSub.stdout || "{}");
  } catch {
    js = {};
  }
  check("a restore from a subdirectory finds the same saved context", 0, fromSub.status, fromSub.stdout.slice(0, 400));
  check("...and it is the same file", path.resolve(file), js.file ? path.resolve(js.file) : "(none)");
}

// ===========================================================================
// SEAM 2  /investigate's report gate  ->  the filesystem
//
// THE DEFECT THIS CATCHES. The gate that decides whether a fix may be called
// DONE checked field names, a file:line REGEX, and a hedge wordlist, and never
// touched the disk. A report citing src/quantum/warp-core.mjs:4021 — a path that
// has never existed in this repository — with the evidence "ran the full suite,
// everything was green, trust me" was ACCEPTED, exit 0.
//
// The check it needed was already in this package: `tb-spec.mjs lint
// --check-paths`. This seam asserts the capability is actually wired into the
// gate, not merely present somewhere in the repo.
// ===========================================================================

function seamInvestigateEvidence(tmp) {
  const proj = path.join(tmp, "gated-proj");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.mkdirSync(path.join(proj, "test"), { recursive: true });
  // A real file with a known length, so "past the end" is a fact and not a guess.
  fs.writeFileSync(path.join(proj, "src", "order_builder.mjs"), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join("\n"), "utf8");
  fs.writeFileSync(path.join(proj, "test", "order_builder.test.mjs"), Array.from({ length: 130 }, (_, i) => `// line ${i + 1}`).join("\n"), "utf8");

  const report = (fix, regression) => `DEBUG REPORT
════════════════════════════════════════
Symptom:         500 on POST /orders when the cart is empty
Root cause:      OrderBuilder#total divides by items.size without guarding zero
Fix:             ${fix}
Evidence:        node --test -> 41 tests, 0 failures
Regression test: ${regression}
Related:         TODOS.md "empty cart 500"
Status:          DONE
════════════════════════════════════════`;

  // ---- the fabricated report from the install report, near enough verbatim
  const fabricated = `DEBUG REPORT
════════════════════════════════════════
Symptom:         intermittent 500s under load
Root cause:      the flux ratio is unclamped in the warp core
Fix:             src/quantum/warp-core.mjs:4021 clamp the flux ratio
Evidence:        ran the full suite, everything was green
Regression test: test/warp-core.test.mjs:88
Status:          DONE
════════════════════════════════════════`;
  const fake = node([INVESTIGATE, "report", "--root", proj], { cwd: proj, input: fabricated });
  check("a report citing a file that does not exist is REJECTED", 1, fake.status, fake.all.slice(0, 500));
  check("...and the rejection names the fabricated path", true, /warp-core\.mjs/.test(fake.all), fake.all.slice(0, 500));
  check("...and does not print ACCEPTED anywhere", false, /ACCEPTED/.test(fake.all), fake.all.slice(0, 300));

  // ---- a real file, a line it does not have
  const pastEnd = node([INVESTIGATE, "report", "--root", proj], {
    cwd: proj,
    input: report("src/order_builder.mjs:4021 guard items.empty?", "test/order_builder.test.mjs:120"),
  });
  check("a citation past the end of a real file is REJECTED", 1, pastEnd.status, pastEnd.all.slice(0, 500));
  check("...and the rejection says how long the file really is", true, /only 60 lines/.test(pastEnd.all), pastEnd.all.slice(0, 500));

  // ---- and the gate still accepts a report that is telling the truth. A gate
  // that rejects everything is not a gate, it is an outage.
  const honest = node([INVESTIGATE, "report", "--root", proj], {
    cwd: proj,
    input: report("src/order_builder.mjs:47 guard items.empty? before dividing", "test/order_builder.test.mjs:120"),
  });
  check("a report whose citations all resolve is still ACCEPTED", 0, honest.status, honest.all.slice(0, 500));

  // ---- the report gate and the spec linter must agree about what a citation is,
  // because they are now the same code. Same text, same root, same answer.
  const SPEC = path.join(ROOT, "skills", "spec", "scripts", "tb-spec.mjs");
  const specDoc = `# Spec

## Problem
The empty cart 500s, cited at src/quantum/warp-core.mjs:4021.

## Acceptance Criteria
1. POST /orders with an empty cart returns 200 and an empty total
2. The order builder never divides by a zero item count

## Out of Scope
- the checkout redesign
`;
  const specRun = node([SPEC, "lint", "--json", "--check-paths", "--root", proj], { cwd: proj, input: specDoc });
  check("the spec linter refuses the same fabricated citation", 1, specRun.status, specRun.all.slice(0, 400));
  check("...for the same stated reason", true, /warp-core\.mjs:4021.*does not exist/.test(specRun.all.replace(/\s+/g, " ")), specRun.all.slice(0, 400));
}

// ===========================================================================
// SEAM 3  the installer  ->  its own `status`
//
// THE DEFECT THIS CATCHES. `pinHookPaths` matched only `tb-guard\.mjs`, so
// plan-tune's hook (tb-plan-tune.mjs) was never pinned to an absolute path and
// the skill installed INERT. The installer printed "+ plan-tune" and "22/22
// passed" under a banner about inert skills. Running `status` in the very same
// directory, one second later, printed "plan-tune BROKEN" and exited 1 — using
// inspectInstalled(), which sits about forty lines below cmdInstall in the same
// file and which cmdInstall never called.
//
// HOME and USERPROFILE are redirected so this never reads or writes the real
// ~/.claude/skills, and so `status`'s global scope is a directory this test owns.
// ===========================================================================

function seamInstallStatus(tmp) {
  const home = path.join(tmp, "home");
  const proj = path.join(tmp, "installed-proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const env = { HOME: home, USERPROFILE: home };

  const inst = node([INSTALLER, "install", "plan-tune"], { cwd: proj, env });
  check("installing a hook-registering skill project-scoped succeeds", 0, inst.status, inst.all.slice(0, 500));

  // The claim the installer makes, checked by the tool that checks it.
  const st = node([INSTALLER, "status"], { cwd: proj, env });
  check("...and `status` in the same directory agrees the install is usable", 0, st.status, st.stdout.slice(0, 500));
  check("...without calling anything BROKEN", false, /BROKEN/.test(st.stdout), st.stdout.slice(0, 500));
  check("...and it names the skill it installed", true, /plan-tune/.test(st.stdout), st.stdout.slice(0, 400));

  // And the mechanism, directly: the hook must point at a file that is there.
  const md = path.join(proj, ".claude", "skills", "plan-tune", "SKILL.md");
  const text = fs.existsSync(md) ? fs.readFileSync(md, "utf8") : "";
  const cmd = (text.match(/^\s*command:\s*.*$/m) || [""])[0];
  check("the installed hook command carries no unexpanded $HOME", false, /\$HOME|\$\{HOME\}|%USERPROFILE%/.test(cmd), cmd);
  const target = (cmd.match(/"([^"]+\.mjs)"/) || cmd.match(/(\S+\.mjs)/) || [])[1];
  check("...and points at an engine that exists", true, Boolean(target) && fs.existsSync(target), target || cmd);

  // The guard skills are the ones that were already pinned. They must not have
  // regressed while the pin was generalised.
  const proj2 = path.join(tmp, "installed-proj-2");
  fs.mkdirSync(proj2, { recursive: true });
  const inst2 = node([INSTALLER, "install", "careful"], { cwd: proj2, env });
  check("the guard skills still install", 0, inst2.status, inst2.all.slice(0, 400));
  const st2 = node([INSTALLER, "status"], { cwd: proj2, env });
  check("...and still pass status", 0, st2.status, st2.stdout.slice(0, 400));
}

// ===========================================================================

const TESTS = [
  ["context-save -> context-restore", seamSaveRestore],
  ["investigate report gate -> the filesystem", seamInvestigateEvidence],
  ["installer -> status", seamInstallStatus],
];

if (process.argv.includes("--list")) {
  out();
  out(`  ${TESTS.length} seams`);
  for (const [name] of TESTS) out(`    ${name}`);
  out();
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-seam-"));
try {
  // Each seam is caught INDIVIDUALLY. A seam test that throws — a missing git, a
  // regex that did not match, an engine that changed its banner — must become a
  // named failure on the report, not a stack trace where the report should be.
  // A test that dies instead of reporting is indistinguishable from a test that
  // never ran, which is the exact fail-open this package exists to delete; it
  // has no business living in the harness that proves the package works. And
  // catching per-seam rather than once around the loop means one broken seam
  // does not hide the answer for the other two.
  for (const [name, fn] of TESTS) {
    try {
      fn(tmp);
    } catch (e) {
      check(`the "${name}" seam ran to completion`, true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
    }
  }
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not the story */
  }
}

// And a run that asserted nothing is a failed run, not a passed one. Without
// this, deleting the body of every test above would print "0/0 passed" and exit
// 0 — green, over nothing.
if (!results.length) {
  check("the seam tests asserted something", true, false, "no assertions ran at all, so nothing was proved");
}

const width = Math.max(...results.map((r) => r.name.length));
out(`\n  Toolbay Stack seam tests  (node ${process.version}, ${process.platform})`);
out("  Every fixture below was produced by a real engine in this package.\n");
for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
const failed = results.filter((r) => !r.pass);
out(`\n  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  out("\n  Failures:");
  for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}.\n      ${r.detail.replace(/\n/g, "\n      ")}`);
  out("");
  process.exit(1);
}
out("\n  Each of these crosses a boundary that both sides' own selftests pass over.");
out("  That is where all three shipped defects lived.\n");
