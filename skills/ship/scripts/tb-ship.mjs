#!/usr/bin/env node
/**
 * tb-ship.mjs: the preflight, the test runner and the verification gate for
 * the /ship workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (run straight through without asking, abort on the
 * base branch, merge the base before testing, run tests, review, bump VERSION,
 * update CHANGELOG, bisectable commits, the Step 16 verification gate and its
 * Iron Law, push, open or update the PR, and the re-run idempotency rules) comes
 * from `ship` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * 1. THE TEST STEP CANNOT SEE A FAILING TEST SUITE. gstack runs the suites like
 *    this (ship/sections/tests.md.tmpl:16-19):
 *
 *      bin/test-lane 2>&1 | tee /tmp/ship_tests.txt &
 *      npm run test   2>&1 | tee /tmp/ship_vitest.txt &
 *      wait
 *
 *    A pipeline's exit status is the status of its LAST stage, and the last
 *    stage is `tee`, which always succeeds. Measured on Windows 11, 2026-08-13:
 *
 *      $ false | tee /tmp/ship_tests.txt; echo $?
 *      0
 *
 *    There is no `set -o pipefail`, no `PIPESTATUS`, and `wait` without an
 *    argument returns the status of the last job only. So the only thing left
 *    that can notice a failure is the agent reading the transcript, which is
 *    the exact judgement call the step exists to remove. On top of that,
 *    `&`/`wait` is bash-only (the harness on this machine refuses backgrounding
 *    outright), and `/tmp` is `C:\Users\<u>\AppData\Local\Temp` to Git Bash but
 *    `C:\tmp` to Node and PowerShell, so the file written is not the file read.
 *
 *    `run` executes the command, records the REAL exit code, and writes the
 *    transcript to an absolute path every runtime agrees on.
 *
 * 2. "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" IS PROSE.
 *    gstack Step 16 says to re-run the suite if any code changed since Step 5,
 *    and lists the rationalisations to resist ("should work now", "I already
 *    tested earlier"). Nothing enforces it. `gate` binds every piece of evidence
 *    to the commit it was produced at and refuses when HEAD has moved since.
 *
 * Everything here is deterministic and offline. Nothing pushes, commits, or
 * talks to a remote; those stay in the agent's hands where a human can see them.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.3.0";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_FAILED = 1; // a check failed, or the command under test failed
const EXIT_UNUSABLE = 2; // not a repo, or arguments make no sense

// ---------------------------------------------------------------------- git

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: res.status === 0, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim(), missing: res.error?.code === "ENOENT" };
}

const BASE_CANDIDATES = ["main", "master", "develop", "trunk"];

function repoRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok ? path.resolve(r.stdout) : null;
}

function headSha(cwd) {
  const r = git(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

function detectBase(cwd, forced) {
  if (forced) return forced;
  const oh = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (oh.ok && oh.stdout) return oh.stdout.replace(/^origin\//, "");
  return BASE_CANDIDATES.find(
    (b) =>
      git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], cwd).ok ||
      git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd).ok,
  );
}

// ------------------------------------------------------------ evidence store

function evidenceDir(root) {
  return process.env.TOOLBAY_SHIP_DIR || path.join(root, ".toolbay", "ship");
}

function evidenceFile(root) {
  return path.join(evidenceDir(root), "evidence.json");
}

function readEvidence(root) {
  const file = evidenceFile(root);
  if (!fs.existsSync(file)) return { records: [], file, existed: false };
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || !Array.isArray(obj.records)) return { error: `${file} has no "records" array`, file };
    return { records: obj.records, file, existed: true };
  } catch (e) {
    return { error: `${file} is not valid JSON (${e.message})`, file };
  }
}

function writeEvidence(root, records) {
  const dir = evidenceDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = evidenceFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ _comment: "Toolbay Stack ship evidence. Each record is bound to the commit it was produced at.", records }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(tmp, file);
  return file;
}

// ------------------------------------------------------------------ preflight

const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;
const WHOLE_FILE_LIMIT = 2 * 1024 * 1024;
const SCAN_CHUNK = 1024 * 1024;

/**
 * Text of `abs` for the conflict-marker test, without ever holding a huge file
 * in memory and without ever skipping one.
 *
 * A size cap used to mean "assume it is fine", which is how a 3MB file starting
 * with `<<<<<<< HEAD` passed. Large files are streamed instead: each chunk
 * carries the tail of the one before it, so a marker landing on a chunk
 * boundary is still seen. Throws on a read error, which the caller records as
 * unscanned rather than as a pass.
 */
function scanForConflict(abs, size) {
  if (size <= WHOLE_FILE_LIMIT) return fs.readFileSync(abs, "utf8");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(SCAN_CHUNK);
    let carry = "";
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, SCAN_CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.subarray(0, n).toString("utf8");
      if (CONFLICT_RE.test(text)) return "<<<<<<< \n";
      carry = text.slice(-16);
    }
  } finally {
    fs.closeSync(fd);
  }
  return "";
}

function preflight(cwd, { base: forcedBase } = {}) {
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  const probe = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.missing) return { code: EXIT_UNUSABLE, checks: [{ ok: false, name: "git available", detail: "git is not on PATH" }] };
  if (!probe.ok || probe.stdout !== "true") {
    return { code: EXIT_UNUSABLE, checks: [{ ok: false, name: "inside a git work tree", detail: `${cwd} is not one` }] };
  }
  const root = repoRoot(cwd) ?? cwd;
  add(true, "inside a git work tree", root);

  const branch = git(["branch", "--show-current"], cwd).stdout;
  const base = detectBase(cwd, forcedBase);
  if (!base) {
    add(false, "base branch identified", `none of ${BASE_CANDIDATES.join(", ")} exist and refs/remotes/origin/HEAD is unset. Pass --base.`);
  } else {
    add(true, "base branch identified", base);
    add(branch !== base, "on a feature branch", branch ? `current branch: ${branch}` : "detached HEAD");
  }

  let mergeBase = null;
  let changed = [];
  // Whether the changed-file list is a fact or an assumption. An empty list
  // because git failed and an empty list because nothing changed are different
  // things, and every check downstream of this one depends on which it is.
  let changedKnown = false;
  if (base && branch !== base) {
    const ref = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], cwd).ok ? `origin/${base}` : base;
    const mb = git(["merge-base", ref, "HEAD"], cwd);
    if (!mb.ok || !mb.stdout) {
      add(false, "merge base resolves", `git merge-base ${ref} HEAD failed: ${mb.stderr.split("\n")[0] || "no output"}`);
    } else {
      mergeBase = mb.stdout;
      add(true, "merge base resolves", `${ref} at ${mergeBase.slice(0, 12)}`);
      const names = git(["diff", "--name-only", mergeBase], cwd);
      if (!names.ok) {
        add(false, "changed files enumerated", `git diff --name-only ${mergeBase.slice(0, 12)} failed: ${names.stderr.split("\n")[0] || "no output"}`);
      } else {
        changedKnown = true;
        changed = names.stdout ? names.stdout.split(/\r?\n/).filter(Boolean) : [];
        add(changed.length > 0, "there is something to ship", `${changed.length} changed file(s)`);
      }
    }
  }

  // Conflict markers in the files being shipped. A merged-but-unresolved file
  // compiles surprisingly often and is a genuinely awful thing to push.
  //
  // Every file in the list is either read to the end or named as unscanned.
  // The old version `continue`d past anything over 2MB and swallowed every read
  // error, then reported "none in the changed files" — a pass earned by not
  // looking. A 3MB file whose first line is a conflict marker went through.
  if (!changedKnown) {
    add(false, "no unresolved conflict markers", "not scanned: the changed-file list could not be built, so no file was read");
  } else {
    const conflicted = [];
    const unscanned = [];
    for (const rel of changed) {
      const abs = path.join(root, rel);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        // ENOENT is the ordinary case: the diff lists files deleted since the
        // merge base, and there is genuinely nothing to read. Anything else is
        // a file that exists and would not open, which is not the same thing.
        if (e.code !== "ENOENT") unscanned.push(`${rel} (${e.code || e.message})`);
        continue;
      }
      if (!st.isFile()) continue;
      try {
        if (CONFLICT_RE.test(scanForConflict(abs, st.size))) conflicted.push(rel);
      } catch (e) {
        unscanned.push(`${rel} (${e.code || e.message})`);
      }
    }
    if (unscanned.length) {
      add(false, "no unresolved conflict markers", `${unscanned.length} changed file(s) could not be read, so this check proves nothing: ${unscanned.slice(0, 5).join(", ")}`);
    } else {
      add(conflicted.length === 0, "no unresolved conflict markers", conflicted.length ? conflicted.join(", ") : `none in the ${changed.length} changed file(s)`);
    }
  }

  // VERSION and CHANGELOG have to agree, which is gstack's own Step 12/13
  // contract, checked here instead of assumed.
  const versionFile = path.join(root, "VERSION");
  let version = null;
  if (fs.existsSync(versionFile)) {
    version = fs.readFileSync(versionFile, "utf8").trim();
    add(VERSION_RE.test(version), "VERSION is well formed", version || "(empty)");
    const changelog = ["CHANGELOG.md", "CHANGELOG"].map((n) => path.join(root, n)).find((p) => fs.existsSync(p));
    if (changelog) {
      const text = fs.readFileSync(changelog, "utf8");
      const mentioned = text.includes(version);
      add(mentioned, "CHANGELOG mentions this version", mentioned ? `${path.basename(changelog)} contains ${version}` : `${path.basename(changelog)} has no entry for ${version}`);
    } else {
      add(true, "CHANGELOG present", "no CHANGELOG in this repo, skipping");
    }
  } else {
    add(true, "VERSION file", "no VERSION file in this repo, skipping");
  }

  const failed = checks.filter((c) => !c.ok);
  return { code: failed.length ? EXIT_FAILED : EXIT_OK, checks, root, base, branch, mergeBase, changed, version };
}

function cmdPreflight(args, cwd = process.cwd()) {
  const json = args.includes("--json");
  const bi = args.indexOf("--base");
  const r = preflight(cwd, { base: bi !== -1 ? args[bi + 1] : undefined });
  if (json) out(JSON.stringify({ ok: r.code === EXIT_OK, exit: r.code, ...r }, null, 2));
  else {
    out();
    for (const c of r.checks) out(`  ${c.ok ? "ok " : "NO "}  ${c.name.padEnd(32)} ${c.detail ?? ""}`);
    out();
    out(r.code === EXIT_OK ? "  preflight PASSED" : "  preflight FAILED — fix every NO above before shipping");
    out();
  }
  process.exitCode = r.code;
}

// ---------------------------------------------------------------- run tests

function cmdRun(args, cwd = process.cwd()) {
  const json = args.includes("--json");
  const sep = args.indexOf("--");
  if (sep === -1 || !args[sep + 1]) {
    err('  UNUSABLE  usage: tb-ship.mjs run --label <name> -- <command...>');
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const li = args.indexOf("--label");
  const label = li !== -1 && li < sep ? args[li + 1] : "tests";
  const command = args.slice(sep + 1);

  const root = repoRoot(cwd) ?? cwd;
  const head = headSha(cwd);

  // Read the ledger BEFORE running anything. A ledger that cannot be read
  // cannot be appended to: the old code turned a corrupt store into an empty
  // one, wrote this run's record into it, and the failing runs it used to hold
  // were gone. One passing test after a corrupted evidence.json was enough to
  // turn `gate` from GATE FAILED into "GATE PASSED. Every recorded run exited 0
  // at the current commit." Refuse instead, and leave the file exactly as it
  // is so `gate` keeps failing on it too.
  const existing = readEvidence(root);
  if (existing.error) {
    const message = `${existing.error}. Records already in it cannot be preserved, so this run will not be recorded. Fix or delete ${existing.file} — deleting it is an admission that nothing is verified, which is the honest state.`;
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`  UNUSABLE  ${message}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const dir = path.join(evidenceDir(root), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${label.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}.log`);

  const started = Date.now();
  // shell:true so "npm run test" and "bin/test-lane" work as written. The exit
  // code comes back from the process itself, not from a pipeline stage.
  const res = spawnSync(command.join(" "), {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const transcript = `$ ${command.join(" ")}\n\n${res.stdout ?? ""}${res.stderr ?? ""}`;
  fs.writeFileSync(logPath, transcript, "utf8");

  const exitCode = res.error ? null : res.status;
  const record = {
    label,
    command: command.join(" "),
    exitCode,
    spawnError: res.error ? `${res.error.code}: ${res.error.message}` : null,
    head,
    at: new Date().toISOString(),
    durationMs,
    log: logPath,
    logBytes: transcript.length,
  };

  // Re-read: the command under test may itself have written to the ledger. A
  // store that has become unreadable while the tests ran is still not something
  // to overwrite, for the same reason as above.
  const store = readEvidence(root);
  if (store.error) {
    const message = `${store.error}. It was readable before this run and is not now, so this run is NOT recorded and nothing already in it has been discarded.`;
    if (json) out(JSON.stringify({ ok: false, error: message, record }, null, 2));
    else err(`  UNUSABLE  ${message}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const records = store.records;
  records.push(record);
  writeEvidence(root, records);

  const passed = exitCode === 0;
  if (json) out(JSON.stringify({ ok: passed, record }, null, 2));
  else {
    out();
    out(`  command   ${record.command}`);
    out(`  exit      ${exitCode === null ? `could not start (${record.spawnError})` : exitCode}`);
    out(`  duration  ${durationMs}ms`);
    out(`  head      ${head ? head.slice(0, 12) : "(not a git repo)"}`);
    out(`  log       ${logPath}`);
    out();
    out(passed ? "  PASSED" : "  FAILED — this is the process's own exit code, not a pipeline's");
    out();
  }
  if (!passed) process.exitCode = EXIT_FAILED;
}

// --------------------------------------------------------------------- gate

function cmdGate(args, cwd = process.cwd()) {
  const json = args.includes("--json");
  const root = repoRoot(cwd);
  if (!root) {
    err(`  UNUSABLE  ${cwd} is not inside a git work tree, so evidence cannot be bound to a commit`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const head = headSha(cwd);
  const store = readEvidence(root);
  if (store.error) {
    if (json) out(JSON.stringify({ ok: false, problems: [store.error] }, null, 2));
    else err(`  UNUSABLE  ${store.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  const problems = [];
  if (!store.records.length) {
    problems.push(
      `no verification evidence at ${store.file}. Run the suite through "tb-ship.mjs run -- <command>" first. ` +
        "Nothing recorded is not the same as nothing failing.",
    );
  }
  for (const r of store.records) {
    if (r.exitCode === null) problems.push(`"${r.label}" never started (${r.spawnError})`);
    else if (r.exitCode !== 0) problems.push(`"${r.label}" exited ${r.exitCode} (${r.command}) — see ${r.log}`);
    else if (!r.head) problems.push(`"${r.label}" was not bound to a commit, so its freshness cannot be checked`);
    else if (r.head !== head) {
      problems.push(
        `"${r.label}" was run at ${r.head.slice(0, 12)} but HEAD is now ${String(head).slice(0, 12)}. ` +
          "Code changed after that run. Re-run it; stale output is not evidence.",
      );
    }
    if (r.exitCode === 0 && r.logBytes === 0) problems.push(`"${r.label}" exited 0 but produced no output at all, which is not a test run`);
  }

  if (json) out(JSON.stringify({ ok: problems.length === 0, head, records: store.records, problems }, null, 2));
  else {
    out();
    out(`  head      ${head ? head.slice(0, 12) : "(none)"}`);
    out(`  evidence  ${store.records.length} record(s) at ${store.file}`);
    for (const r of store.records) {
      out(`    ${r.exitCode === 0 ? "ok " : "NO "} ${String(r.label).padEnd(16)} exit ${r.exitCode ?? "-"}  at ${r.head ? r.head.slice(0, 12) : "(unbound)"}`);
    }
    out();
    if (problems.length) {
      out("  GATE FAILED. Do not push, do not claim this is done:");
      for (const p of problems) out(`    - ${p}`);
    } else {
      out("  GATE PASSED. Every recorded run exited 0 at the current commit.");
    }
    out();
  }
  if (problems.length) process.exitCode = EXIT_FAILED;
}

function cmdClear(args, cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (!root) {
    err("  UNUSABLE  not inside a git work tree");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  writeEvidence(root, []);
  out(`  cleared ${evidenceFile(root)}`);
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { cwd = process.cwd(), env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GIT_ID = ["-c", "user.email=selftest@toolbay.invalid", "-c", "user.name=tb selftest"];

// Quoted, because the interpreter lives under "C:\Program Files" on this machine
// and `run` hands the joined string to a shell exactly as a user would type it.
const NODE = `"${process.execPath}"`;

function makeRepo(dir, { base = "main", feature = true, files = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync("git", [...GIT_ID, ...a], { cwd: dir, encoding: "utf8", windowsHide: true });
  g("init", "-q", "--initial-branch", base, ".");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  if (feature) {
    g("checkout", "-q", "-b", "feature");
    for (const [name, body] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, "utf8");
    }
    if (!Object.keys(files).length) fs.writeFileSync(path.join(dir, "app.js"), "module.exports = 1\n", "utf8");
    g("add", "-A");
    g("commit", "-q", "-m", "work");
  }
  return dir;
}

const commitAll = (dir, msg) => {
  spawnSync("git", [...GIT_ID, "add", "-A"], { cwd: dir, windowsHide: true });
  spawnSync("git", [...GIT_ID, "commit", "-q", "-m", msg], { cwd: dir, windowsHide: true });
};

function selftest() {
  const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (gitProbe.error || gitProbe.status !== 0) {
    process.stdout.write("\n  tb-ship selftest: git is unavailable, so none of these checks can be proved.\n");
    process.stdout.write("  Failing rather than reporting a pass that was never run.\n\n");
    process.exitCode = 1;
    return false;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ship-selftest-"));

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // "preflight refuses outside a git work tree" needs a directory that is
  // genuinely outside one. os.tmpdir() lives under the user's home on Windows,
  // so a single stray `git init` in HOME — found on this machine 2026-08-16 —
  // puts every sandbox inside a work tree and the refusal under test never
  // fires. Worse for THIS engine than most: preflight then scans that ancestor
  // repository, which is the user's entire home directory.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // ---- preflight
  const clean = makeRepo(path.join(tmp, "clean"));
  check("preflight passes on a clean feature branch", 0, runSelf(["preflight", "--json"], { cwd: clean }).status);
  {
    const onBase = makeRepo(path.join(tmp, "onbase"), { feature: false });
    check("preflight fails on the base branch", 1, runSelf(["preflight", "--json"], { cwd: onBase }).status);
  }
  {
    const empty = makeRepo(path.join(tmp, "nochanges"), { feature: true, files: {} });
    // Branch off with no new commit content relative to base.
    spawnSync("git", [...GIT_ID, "checkout", "-q", "main"], { cwd: empty, windowsHide: true });
    spawnSync("git", [...GIT_ID, "checkout", "-q", "-b", "empty-branch"], { cwd: empty, windowsHide: true });
    check("preflight fails when there is nothing to ship", 1, runSelf(["preflight", "--json"], { cwd: empty }).status);
  }
  {
    const conflicted = makeRepo(path.join(tmp, "conflict"), {
      files: { "src/a.js": "<<<<<<< HEAD\nconst a = 1\n=======\nconst a = 2\n>>>>>>> origin/main\n" },
    });
    const r = runSelf(["preflight", "--json"], { cwd: conflicted });
    check("preflight fails on unresolved conflict markers", 1, r.status);
    check("...and names the file", true, /src\/a\.js/.test(r.stdout), r.stdout.slice(0, 200));
  }
  {
    const badver = makeRepo(path.join(tmp, "badver"), { files: { VERSION: "v1.2\n", "CHANGELOG.md": "# changes\n" } });
    check("preflight fails on a malformed VERSION", 1, runSelf(["preflight", "--json"], { cwd: badver }).status);
  }
  {
    const noentry = makeRepo(path.join(tmp, "noentry"), { files: { VERSION: "1.2.3.0\n", "CHANGELOG.md": "# changes\n\n## 1.2.2.0\n" } });
    check("preflight fails when CHANGELOG has no entry for VERSION", 1, runSelf(["preflight", "--json"], { cwd: noentry }).status);
  }
  {
    const okver = makeRepo(path.join(tmp, "okver"), { files: { VERSION: "1.2.3.0\n", "CHANGELOG.md": "# changes\n\n## 1.2.3.0 - today\n" } });
    check("preflight passes when VERSION and CHANGELOG agree", 0, runSelf(["preflight", "--json"], { cwd: okver }).status);
  }
  {
    const notrepo = path.join(tmp, "notrepo");
    fs.mkdirSync(notrepo, { recursive: true });
    check("preflight refuses outside a git work tree", 2, runSelf(["preflight", "--json"], { cwd: notrepo }).status);
  }

  // ---- gate before anything was run
  const g1 = makeRepo(path.join(tmp, "gate1"));
  check("gate fails when no evidence was recorded", 1, runSelf(["gate", "--json"], { cwd: g1 }).status);

  // ---- run captures the REAL exit code, which is the whole point
  {
    const r = runSelf(["run", "--json", "--label", "tests", "--", NODE, "-e", '"process.exit(0)"'], { cwd: g1 });
    check("run reports a passing command as 0", 0, r.status, r.stderr.trim());
    check("gate passes on fresh, green evidence", 0, runSelf(["gate", "--json"], { cwd: g1 }).status);
  }
  {
    const g2 = makeRepo(path.join(tmp, "gate2"));
    const r = runSelf(["run", "--json", "--label", "tests", "--", NODE, "-e", '"console.log(\'1 failing\'); process.exit(1)"'], { cwd: g2 });
    check("run reports a failing command as non-zero", 1, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...with the real exit code recorded", 1, j.record?.exitCode ?? "(none)");
    check("gate fails on recorded red evidence", 1, runSelf(["gate", "--json"], { cwd: g2 }).status);
  }
  {
    const g3 = makeRepo(path.join(tmp, "gate3"));
    runSelf(["run", "--label", "tests", "--", NODE, "-e", '"process.exit(42)"'], { cwd: g3 });
    const j = JSON.parse(runSelf(["gate", "--json"], { cwd: g3 }).stdout || "{}");
    check("gate reports the exact failing exit code", 42, j.records?.[0]?.exitCode ?? "(none)");
  }
  {
    const g4 = makeRepo(path.join(tmp, "gate4"));
    runSelf(["run", "--label", "tests", "--", NODE, "-e", '"console.log(\'ok\')"'], { cwd: g4 });
    check("gate passes right after a green run", 0, runSelf(["gate", "--json"], { cwd: g4 }).status);
    // Now change the code, exactly the case Step 16 warns about.
    fs.writeFileSync(path.join(g4, "app.js"), "module.exports = 2\n", "utf8");
    commitAll(g4, "change after testing");
    const r = runSelf(["gate", "--json"], { cwd: g4 });
    check("gate fails once HEAD moves past the evidence", 1, r.status);
    check("...and says the evidence is stale", true, /HEAD is now|Code changed after/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    const g5 = makeRepo(path.join(tmp, "gate5"));
    const r = runSelf(["run", "--json", "--label", "tests", "--", "tb-definitely-not-a-real-command-xyz"], { cwd: g5 });
    check("a command that cannot run is a failure, not a pass", 1, r.status);
    check("gate fails on a command that never ran", 1, runSelf(["gate", "--json"], { cwd: g5 }).status);
  }
  {
    const g6 = makeRepo(path.join(tmp, "gate6"));
    const dir = path.join(g6, ".toolbay", "ship");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "evidence.json"), "{ not json", "utf8");
    check("gate treats a corrupt evidence file as unusable, not a pass", 2, runSelf(["gate", "--json"], { cwd: g6 }).status);
  }
  {
    // The one that mattered: `run` used to replace an unreadable ledger with an
    // empty array, so a single green run after a corrupted evidence.json wiped
    // every recorded failure and `gate` printed GATE PASSED.
    const g7 = makeRepo(path.join(tmp, "gate7"));
    runSelf(["run", "--label", "tests", "--", NODE, "-e", '"process.exit(1)"'], { cwd: g7 });
    check("gate fails on the recorded failure", 1, runSelf(["gate", "--json"], { cwd: g7 }).status);
    const ledger = path.join(g7, ".toolbay", "ship", "evidence.json");
    const before = fs.readFileSync(ledger, "utf8");
    fs.writeFileSync(ledger, "{ not json", "utf8");
    const r = runSelf(["run", "--json", "--label", "tests", "--", NODE, "-e", '"process.exit(0)"'], { cwd: g7 });
    check("run refuses to record over a corrupt ledger", 2, r.status, r.stdout.slice(0, 200));
    check("...and leaves the corrupt file untouched", "{ not json", fs.readFileSync(ledger, "utf8"));
    check("...so gate still refuses", 2, runSelf(["gate", "--json"], { cwd: g7 }).status);
    fs.writeFileSync(ledger, before, "utf8");
    check("...and the recorded failure is still there afterwards", 1, runSelf(["gate", "--json"], { cwd: g7 }).status);
  }
  {
    // A file too large for the old 2MB cap was skipped and then counted as
    // clean. It is streamed now, so the marker on line 1 is found.
    const big = makeRepo(path.join(tmp, "bigconflict"), {
      files: { "big.js": `<<<<<<< HEAD\n${"// filler filler filler filler\n".repeat(110000)}` },
    });
    const r = runSelf(["preflight", "--json"], { cwd: big });
    check("preflight scans a file larger than the whole-file limit", 1, r.status, r.stdout.slice(0, 200));
    check("...and names it", true, /big\.js/.test(r.stdout), r.stdout.slice(0, 300));
  }
  check("run without a command is refused", 2, runSelf(["run", "--json", "--label", "x"], { cwd: g1 }).status);

  // ---- the gstack pipeline, run verbatim, cannot see the same failure
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!bash.error && bash.status === 0) {
    const logFile = path.join(tmp, "tee-demo.log").replace(/\\/g, "/");
    const pipe = spawnSync("bash", ["-c", `false | tee "${logFile}" >/dev/null; echo $?`], { encoding: "utf8", windowsHide: true });
    check(
      "gstack's `cmd | tee log` reports 0 for a failing command",
      "0",
      (pipe.stdout ?? "").trim(),
      "this is why the exit code is captured directly here",
    );
  }

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }
  return report("tb-ship", results);
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
  process.stdout.write("\n  The last case runs gstack's own test pipeline shape and shows it reporting 0\n");
  process.stdout.write("  for a command that failed. Here the exit code comes from the process itself,\n");
  process.stdout.write("  and evidence is bound to the commit it was produced at, so it goes stale.\n\n");
  return true;
}

function help() {
  out(`
  tb-ship ${VERSION}  (Toolbay Stack)

  preflight [--base <b>]              branch, merge base, conflict markers,
                                      VERSION format, CHANGELOG agreement
  run --label <name> -- <command...>  run it, record the REAL exit code and the
                                      transcript, bound to the current commit
  gate                                refuse unless every recorded run exited 0
                                      AT THE CURRENT COMMIT
  clear                               drop recorded evidence (starting over)
  selftest

  Options: --json

  Exit: 0 pass, 1 a check or a command failed, 2 unusable.

  This tool never commits, pushes, or contacts a remote.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "preflight") cmdPreflight(argv.slice(1));
else if (cmd === "run") cmdRun(argv.slice(1));
else if (cmd === "gate") cmdGate(argv.slice(1));
else if (cmd === "clear") cmdClear(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
