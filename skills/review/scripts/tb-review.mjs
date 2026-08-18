#!/usr/bin/env node
/**
 * tb-review.mjs: the mechanical parts of the /review workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (diff against the merge base with the base branch,
 * a two-pass CRITICAL/INFORMATIONAL checklist, the Fix-First heuristic, the
 * suppression list, and the terse `[file:line] problem -> fix` output format)
 * comes from `review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * Two things in gstack's /review turn a failure into a pass.
 *
 * 1. A BROKEN DIFF BASE READS AS "NOTHING TO REVIEW". gstack Step 1 and Step 3
 *    (review/SKILL.md.tmpl:41, :71-79):
 *
 *      git fetch origin <base> --quiet && DIFF_BASE=$(git merge-base origin/<base> HEAD) \
 *        && git diff "$DIFF_BASE" --stat
 *      ... "If no diff, output 'Nothing to review' and stop."
 *
 *    Every link in that chain is an `&&`. If `git fetch` fails — no remote, no
 *    network, a token that expired, a shallow clone — nothing after it runs, the
 *    stat output is empty, and the documented reaction to empty output is to
 *    declare there is nothing to review and stop. Reproduced on Windows 11,
 *    2026-08-13, in a fresh repo with a real commit on a feature branch and no
 *    `origin`:
 *
 *      fatal: 'origin' does not appear to be a git repository
 *      chain exit = 128   DIFF_BASE=''   stat output: (empty)
 *
 *    A reviewer that answers "no issues" because it could not find the diff is
 *    worse than no reviewer. `basis` separates "there are no changes" (exit 4,
 *    and it proves it) from "I could not work out what to compare against"
 *    (exit 3, and it says which step failed).
 *
 * 2. THE CHECKLIST IS NOT WHERE THE SKILL LOOKS FOR IT. gstack Step 2 says:
 *
 *      Read `.claude/skills/review/checklist.md`.
 *      **If the file cannot be read, STOP and report the error.**
 *
 *    That path is project-relative, but the skill installs to
 *    `~/.claude/skills/review/`, and the installer ships only SKILL.md.
 *    Verified on this machine against gstack 1.60.1.0:
 *
 *      $ ls ~/.claude/skills/review/
 *      SKILL.md
 *
 *    So in any repo that does not happen to have its own checked-in copy, the
 *    core step of /review cannot be performed, and the file it names is not in
 *    the install at all. `checklist` resolves the file relative to this script,
 *    which is where the skill actually lives, and exits 2 if it is missing.
 *
 * `claims` is the third piece: gstack's "Verification of claims" section is a
 * rule written in prose ("Never say 'likely handled' or 'probably tested'"), and
 * this makes breaking it exit non-zero.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(SELF, "..", "..");
const VERSION = "0.3.0";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // there is a reviewable diff / the check passed
const EXIT_REJECTED = 1; // the check ran and failed
const EXIT_UNUSABLE = 2; // input could not be read
const EXIT_UNDETERMINED = 3; // could not work out what to compare against
const EXIT_NO_CHANGES = 4; // verified: there is genuinely nothing to review

// ---------------------------------------------------------------------- git

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    missing: res.error?.code === "ENOENT",
  };
}

const BASE_CANDIDATES = ["main", "master", "develop", "trunk"];

/**
 * Work out the base branch and the commit to diff against, reporting every step.
 *
 * The rule that makes this different from gstack's: no step is allowed to fail
 * quietly into an empty diff. Either a comparison point is established, or the
 * caller is told which step failed and gets a non-zero exit.
 */
function findBasis(cwd, { base: forcedBase, fetch = false } = {}) {
  const steps = [];
  const note = (ok, text) => steps.push({ ok, text });

  const probe = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.missing) {
    return { code: EXIT_UNUSABLE, steps: [{ ok: false, text: "git is not on PATH, so nothing can be compared" }] };
  }
  if (!probe.ok || probe.stdout !== "true") {
    return { code: EXIT_UNUSABLE, steps: [{ ok: false, text: `${cwd} is not inside a git work tree` }] };
  }
  note(true, "inside a git work tree");

  const head = git(["rev-parse", "HEAD"], cwd);
  if (!head.ok) {
    note(false, "HEAD does not resolve (an empty repository has nothing to review)");
    return { code: EXIT_UNDETERMINED, steps };
  }

  const branch = git(["branch", "--show-current"], cwd).stdout || "(detached HEAD)";
  note(true, `current branch: ${branch}`);

  // 1. Base branch name.
  let base = forcedBase;
  if (base) {
    note(true, `base branch given explicitly: ${base}`);
  } else {
    const originHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (originHead.ok && originHead.stdout) {
      base = originHead.stdout.replace(/^origin\//, "");
      note(true, `base branch from refs/remotes/origin/HEAD: ${base}`);
    } else {
      base = BASE_CANDIDATES.find(
        (b) =>
          git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], cwd).ok ||
          git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd).ok,
      );
      if (base) note(true, `base branch found by name: ${base}`);
    }
  }
  if (!base) {
    note(
      false,
      `no base branch could be identified. refs/remotes/origin/HEAD is unset and none of ${BASE_CANDIDATES.join(", ")} exist ` +
        "locally or on origin. Pass --base <branch>. This is NOT the same as having no changes.",
    );
    return { code: EXIT_UNDETERMINED, steps, branch };
  }

  if (branch === base) {
    // STANDING ON THE BASE BRANCH WITH UNCOMMITTED WORK IS REVIEWABLE.
    //
    // This used to return UNDETERMINED, full stop. That state — edits in the
    // working tree, still on main, nothing committed yet — is the single most
    // common state a solo developer is in when they think "review this before I
    // go further", and it is exactly the state /suggest routes here from. There
    // is no BRANCH diff, which is true, but there is a diff: the working tree
    // against HEAD. Refusing to look at it made the two skills contradict each
    // other, and made /review useless precisely when it was asked for.
    //
    // So: review what actually exists, and SAY which comparison it is. What is
    // never allowed is presenting a working-tree review as a branch review, or
    // reporting "nothing to review" when the answer is "not that way".
    const dirty = git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd);
    if (dirty.ok && dirty.stdout) {
      note(true, `you are on the base branch (${base}), so there is no branch diff`);
      const names = git(["diff", "--name-only", "HEAD"], cwd);
      const tracked = names.ok && names.stdout ? names.stdout.split(/\r?\n/).filter(Boolean) : [];
      const untracked = dirty.stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith("??"))
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      const files = [...new Set([...tracked, ...untracked])];
      if (files.length) {
        note(true, `reviewing the WORKING TREE against HEAD instead: ${files.length} changed file(s)`);
        return {
          code: EXIT_OK,
          steps,
          base,
          branch,
          ref: "HEAD",
          mergeBase: "HEAD",
          files,
          commits: "0",
          comparison: "working-tree",
        };
      }
    }
    note(
      false,
      `you are on the base branch (${base}) and the working tree is clean, so there is no diff to review at all. ` +
        "Make a change, or check out the branch you meant to review.",
    );
    return { code: EXIT_UNDETERMINED, steps, base, branch };
  }

  // 2. A ref for that base. Remote is preferred, local is a stated fallback.
  if (fetch) {
    const f = git(["fetch", "origin", base, "--quiet"], cwd);
    note(f.ok, f.ok ? `fetched origin/${base}` : `could not fetch origin/${base} (${f.stderr.split("\n")[0] || "no origin"}), continuing with local refs`);
  }
  let ref = null;
  if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], cwd).ok) {
    ref = `origin/${base}`;
    note(true, `comparison ref: ${ref}`);
  } else if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], cwd).ok) {
    ref = base;
    note(true, `comparison ref: local ${base} (origin/${base} does not exist here)`);
  } else {
    note(false, `neither origin/${base} nor a local ${base} exists, so there is nothing to compute a merge base against`);
    return { code: EXIT_UNDETERMINED, steps, base, branch };
  }

  // 3. The merge base itself.
  const mb = git(["merge-base", ref, "HEAD"], cwd);
  if (!mb.ok || !mb.stdout) {
    note(
      false,
      `git merge-base ${ref} HEAD failed (${mb.stderr.split("\n")[0] || `exit ${mb.status}`}). ` +
        "Unrelated histories or a shallow clone will do this. Refusing to diff against an empty ref.",
    );
    return { code: EXIT_UNDETERMINED, steps, base, branch, ref };
  }
  const mergeBase = mb.stdout;
  note(true, `merge base: ${mergeBase.slice(0, 12)}`);

  // 4. What actually changed. Working tree included, as gstack does.
  const names = git(["diff", "--name-only", mergeBase], cwd);
  if (!names.ok) {
    note(false, `git diff against ${mergeBase.slice(0, 12)} failed: ${names.stderr.split("\n")[0]}`);
    return { code: EXIT_UNDETERMINED, steps, base, branch, ref, mergeBase };
  }
  const files = names.stdout ? names.stdout.split(/\r?\n/).filter(Boolean) : [];
  const commits = git(["rev-list", "--count", `${mergeBase}..HEAD`], cwd).stdout || "0";
  const comparison = "branch";

  if (!files.length) {
    note(true, `git diff ran and returned 0 changed files across ${commits} commit(s)`);
    return { code: EXIT_NO_CHANGES, steps, base, branch, ref, mergeBase, files, commits, comparison };
  }
  note(true, `${files.length} changed file(s) across ${commits} commit(s)`);
  return { code: EXIT_OK, steps, base, branch, ref, mergeBase, files, commits, comparison };
}

function cmdBasis(args, cwd = process.cwd()) {
  const json = args.includes("--json");
  const fetch = args.includes("--fetch");
  const bi = args.indexOf("--base");
  const base = bi !== -1 ? args[bi + 1] : undefined;
  const r = findBasis(cwd, { base, fetch });

  const verdict =
    r.code === EXIT_OK
      ? "REVIEWABLE"
      : r.code === EXIT_NO_CHANGES
        ? "NO CHANGES (verified)"
        : r.code === EXIT_UNDETERMINED
          ? "UNDETERMINED"
          : "UNUSABLE";

  if (json) {
    out(
      JSON.stringify(
        {
          verdict,
          exit: r.code,
          base: r.base ?? null,
          branch: r.branch ?? null,
          // "branch" = merge-base diff; "working-tree" = uncommitted work
          // against HEAD, which is what you get on the base branch. A caller
          // that does not know which one it got would describe the wrong thing.
          comparison: r.comparison ?? null,
          ref: r.ref ?? null,
          mergeBase: r.mergeBase ?? null,
          files: r.files ?? [],
          commits: r.commits ?? null,
          steps: r.steps,
        },
        null,
        2,
      ),
    );
  } else {
    out();
    for (const s of r.steps) out(`  ${s.ok ? "ok " : "no "}  ${s.text}`);
    out();
    out(`  ${verdict}`);
    if (r.code === EXIT_OK) {
      if (r.comparison === "working-tree") {
        out("  This is your UNCOMMITTED work against HEAD, not a branch diff.");
        out("  Say so in the review: nothing here has been committed yet.");
      }
      out(`  diff command: git diff ${r.mergeBase}`);
      for (const f of r.files.slice(0, 20)) out(`    ${f}`);
      if (r.files.length > 20) out(`    ... and ${r.files.length - 20} more`);
    }
    if (r.code === EXIT_UNDETERMINED) {
      out();
      out("  This is NOT 'nothing to review'. The comparison point could not be");
      out("  established, so any review written now would be reviewing nothing.");
      out("  Fix the step marked 'no' above, or pass --base <branch>.");
    }
    out();
  }
  process.exitCode = r.code;
}

// ----------------------------------------------------------------- checklist

function checklistPath() {
  // Resolved relative to this script, because that is where the skill actually
  // is. A project-relative path only works in the one repo that has a copy.
  const candidates = [
    path.join(SKILL_DIR, "checklist.md"),
    path.join(process.cwd(), ".claude", "skills", "review", "checklist.md"),
    path.join(os.homedir(), ".claude", "skills", "review", "checklist.md"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function cmdChecklist(args) {
  const p = checklistPath();
  if (!p) {
    err(
      "  UNUSABLE  no checklist.md found next to this skill, in ./.claude/skills/review/, or in ~/.claude/skills/review/.\n" +
        "            The review cannot run without it. Do not substitute a remembered checklist.",
    );
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  if (args.includes("--path")) {
    out(p);
    return;
  }
  out(fs.readFileSync(p, "utf8"));
}

// -------------------------------------------------------------- claim check
//
// gstack's own rule, made enforceable:
//   "If you claim 'this is handled elsewhere' -> read and cite the handling code"
//   "If you claim 'tests cover this' -> name the test file and method"
//   "Never say 'likely handled' or 'probably tested' - verify or flag as unknown"
//   "'This looks fine' is not a finding."

const HEDGE_PATTERNS = [
  { re: /\blikely (handled|safe|fine|covered|tested)\b/i, why: "hedged claim" },
  { re: /\bprobably (handled|safe|fine|covered|tested|ok)\b/i, why: "hedged claim" },
  { re: /\b(should|seems? to|appears? to) be (fine|safe|ok|correct)\b/i, why: "hedged claim" },
  { re: /\blooks (fine|good|correct|ok)\b/i, why: "'looks fine' is not a finding" },
  { re: /\bpresumably\b/i, why: "hedged claim" },
  { re: /\bi assume\b/i, why: "assumption stated as a result" },
  { re: /\bno (obvious|apparent) (issues|problems)\b/i, why: "absence of an obvious problem is not verification" },
  { re: /\bhandled elsewhere\b/i, why: "cite the file:line that handles it" },
];

/** A claim about test coverage has to name a file. */
const COVERAGE_CLAIM = /\b(tests? cover|covered by tests?|is tested|are tested|test coverage exists)\b/i;
const FILE_REF = /[\w./\\+-]+\.[A-Za-z0-9]{1,10}(:\d+)?/;

function scanClaims(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    for (const p of HEDGE_PATTERNS) {
      if (p.re.test(line)) findings.push({ line: i + 1, why: p.why, text: line.trim().slice(0, 120) });
    }
    if (COVERAGE_CLAIM.test(line) && !FILE_REF.test(line)) {
      findings.push({ line: i + 1, why: "claims test coverage without naming a test file", text: line.trim().slice(0, 120) });
    }
  });
  return findings;
}

function cmdClaims(args) {
  const json = args.includes("--json");
  const fi = args.indexOf("--file");
  let text;
  if (fi !== -1) {
    const file = args[fi + 1];
    if (!file) {
      err("  UNUSABLE  --file needs a path");
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      // Not readable is not "clean". A review nobody can read has not been done.
      const message = `${file} could not be read (${e.code || e.message}), so the review output is unchecked`;
      if (json) out(JSON.stringify({ ok: false, findings: [{ line: 0, why: message, text: "" }] }, null, 2));
      else err(`  UNUSABLE  ${message}`);
      process.exitCode = EXIT_UNUSABLE;
      return;
    }
  } else {
    try {
      text = fs.readFileSync(0, "utf8");
    } catch {
      text = "";
    }
  }

  if (!String(text).trim()) {
    if (json) out(JSON.stringify({ ok: false, findings: [{ line: 0, why: "the review output was empty", text: "" }] }, null, 2));
    else err("  REJECTED  the review output was empty, which is not the same as finding nothing");
    process.exitCode = EXIT_REJECTED;
    return;
  }

  const findings = scanClaims(text);
  if (json) {
    out(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  } else if (!findings.length) {
    out("  ok  every claim in this review is stated as a fact or an explicit unknown");
  } else {
    out();
    out(`  ${findings.length} unverifiable claim(s):`);
    for (const f of findings) out(`    line ${f.line}: ${f.why}\n      ${f.text}`);
    out();
    out("  Verify each one and cite file:line, or restate it as an explicit unknown.");
    out();
  }
  if (findings.length) process.exitCode = EXIT_REJECTED;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { cwd = process.cwd(), stdin = "" } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { cwd, input: stdin, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GIT_ID = ["-c", "user.email=selftest@toolbay.invalid", "-c", "user.name=tb selftest"];

function makeRepo(dir, { baseBranch = "main", withFeature = true, changes = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => spawnSync("git", [...GIT_ID, ...args], { cwd: dir, encoding: "utf8", windowsHide: true });
  g("init", "-q", "--initial-branch", baseBranch, ".");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  if (withFeature) {
    g("checkout", "-q", "-b", "feature");
    if (changes) {
      fs.writeFileSync(path.join(dir, "danger.js"), "eval(userInput)\n", "utf8");
      g("add", "-A");
      g("commit", "-q", "-m", "add danger");
    }
  }
  return dir;
}

function selftest() {
  const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (gitProbe.error || gitProbe.status !== 0) {
    process.stdout.write("\n  tb-review selftest: git is not available, so the diff-base checks cannot be proved.\n");
    process.stdout.write("  Failing rather than reporting a pass that was never run.\n\n");
    process.exitCode = 1;
    return false;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-review-selftest-"));

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // "basis refuses outside a git work tree" needs a directory that is genuinely
  // outside one. os.tmpdir() lives under the user's home on Windows, so a single
  // stray `git init` in HOME — found on this machine 2026-08-16 — puts every
  // sandbox inside a work tree and the refusal under test never fires. git's own
  // boundary variable is set here rather than in the test runner, so running this
  // file directly proves what `npm test` proves.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  // A THROW IS A NAMED FAILURE, NOT A STACK TRACE.
  //
  // A selftest that dies mid-run prints no "N/M passed" line, and the suite
  // runner then reports "cannot be shown to have asserted anything" — true, and
  // useless, because it buries the ONE assertion that actually failed under a
  // stack trace pointing at a line that is merely downstream of it. A test that
  // crashes is indistinguishable from a test that never ran. That is the exact
  // fail-open this package exists to delete, and it has no business living in
  // the harness that proves the package works.
  try {

  // Fixture A: a normal feature branch, local base only, NO origin. This is the
  // exact shape that breaks gstack's `git fetch && merge-base && diff` chain.
  const repoA = makeRepo(path.join(tmp, "a"));
  {
    const r = runSelf(["basis", "--json"], { cwd: repoA });
    const j = JSON.parse(r.stdout || "{}");
    check("basis works with a local base branch and no origin", 0, r.status, r.stderr.trim());
    check("basis names the base branch it used", "main", j.base ?? "(none)");
    check("basis finds the changed file", "danger.js", (j.files ?? []).join(","));

    // And the gstack chain, run verbatim in the same repo, finds nothing.
    const chain = spawnSync(
      "bash",
      ["-c", 'git fetch origin main --quiet && DIFF_BASE=$(git merge-base origin/main HEAD) && git diff "$DIFF_BASE" --stat'],
      { cwd: repoA, encoding: "utf8", windowsHide: true },
    );
    check(
      "gstack's diff-base chain produces an empty diff here (its rule: stop, 'nothing to review')",
      "",
      (chain.stdout ?? "").trim(),
      (chain.stderr ?? "").trim().split("\n")[0],
    );
  }

  // Fixture B: no base branch exists at all under any known name, no origin.
  const repoB = path.join(tmp, "b");
  {
    makeRepo(repoB, { baseBranch: "wip-only" });
    const r = runSelf(["basis", "--json"], { cwd: repoB });
    check("basis refuses when no base branch can be identified", 3, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...and says so rather than reporting no changes", "UNDETERMINED", j.verdict ?? "(none)");
  }

  // Fixture C: standing on the base branch with a CLEAN tree. There is no
  // branch diff and no working-tree diff, so there is genuinely nothing.
  const repoC = makeRepo(path.join(tmp, "c"), { withFeature: false });
  check("basis refuses when you are on the base branch with a clean tree", 3, runSelf(["basis", "--json"], { cwd: repoC }).status);

  // Fixture C2: standing on the base branch with UNCOMMITTED work. This is the
  // state /suggest routes here from, and the state /review used to refuse: it
  // returned UNDETERMINED because there was no BRANCH diff, while a perfectly
  // reviewable working-tree diff sat in front of it.
  const repoC2 = makeRepo(path.join(tmp, "c2"), { withFeature: false });
  {
    fs.writeFileSync(path.join(repoC2, "README.md"), "base\nedited in place\n", "utf8");
    fs.writeFileSync(path.join(repoC2, "new-file.js"), "eval(userInput)\n", "utf8");
    const r = runSelf(["basis", "--json"], { cwd: repoC2 });
    const j = JSON.parse(r.stdout || "{}");
    check("uncommitted work on the base branch is reviewable, not UNDETERMINED", 0, r.status, r.stdout.slice(0, 400));
    check("...and it says which comparison it made", "working-tree", j.comparison ?? "(none)");
    check("...listing the edited tracked file", true, (j.files ?? []).includes("README.md"), (j.files ?? []).join(","));
    check("...and the untracked one, which `git diff` alone never shows", true, (j.files ?? []).includes("new-file.js"), (j.files ?? []).join(","));
    const human = runSelf(["basis"], { cwd: repoC2 });
    check("...and warns a reader it is NOT a branch diff", true, /UNCOMMITTED work against HEAD/.test(human.stdout), human.stdout.slice(0, 500));
  }
  {
    // A real branch review must still say it is a branch review.
    const j = JSON.parse(runSelf(["basis", "--json"], { cwd: repoA }).stdout || "{}");
    check("a feature-branch review is still labelled a branch comparison", "branch", j.comparison ?? "(none)");
  }

  // Fixture D: a feature branch with genuinely nothing on it.
  const repoD = makeRepo(path.join(tmp, "d"), { changes: false });
  {
    const r = runSelf(["basis", "--json"], { cwd: repoD });
    check("basis reports a verified empty diff with its own exit code", 4, r.status);
    const j = JSON.parse(r.stdout || "{}");
    check("...distinguishable from 'undetermined'", "NO CHANGES (verified)", j.verdict ?? "(none)");
  }

  // Fixture E: not a repository.
  const repoE = path.join(tmp, "e");
  fs.mkdirSync(repoE, { recursive: true });
  check("basis refuses outside a git work tree", 2, runSelf(["basis", "--json"], { cwd: repoE }).status);

  // Fixture F: an explicitly named base that does not exist.
  check("basis refuses a --base that does not exist", 3, runSelf(["basis", "--json", "--base", "nope"], { cwd: repoA }).status);

  // ---- checklist resolution
  {
    const r = runSelf(["checklist", "--path"]);
    const p = r.stdout.trim();
    check("checklist resolves to a file that exists", true, Boolean(p) && fs.existsSync(p), p);
    check("checklist resolves next to the skill, not to the cwd", true, path.resolve(p) === path.join(SKILL_DIR, "checklist.md"), p);
    const body = runSelf(["checklist"]).stdout;
    check("the checklist actually contains the critical categories", true, /SQL & Data Safety/.test(body) && /Enum & Value Completeness/.test(body));
  }

  // ---- claim scanning
  const claimCases = [
    ["claims accepts a cited finding", "- [src/a.ts:42] SQL built by interpolation -> use a parameterized query", 0],
    ["claims rejects 'likely handled'", "The race is likely handled by the unique index.", 1],
    ["claims rejects 'probably tested'", "This path is probably tested upstream.", 1],
    ["claims rejects 'looks fine'", "The migration looks fine.", 1],
    ["claims rejects 'should be safe'", "Interpolating the id should be safe since it is an integer.", 1],
    ["claims rejects 'handled elsewhere' with no citation", "Validation is handled elsewhere.", 1],
    ["claims rejects a coverage claim with no test file", "This behavior is tested.", 1],
    ["claims accepts a coverage claim that names the test", "This behavior is tested in spec/order_spec.rb:88.", 0],
    ["claims rejects empty review output", "", 1],
  ];
  for (const [name, payload, expected] of claimCases) {
    check(name, expected, runSelf(["claims"], { stdin: payload }).status);
  }
  check("claims treats an unreadable file as unchecked, not clean", 2, runSelf(["claims", "--file", path.join(tmp, "nope.md")]).status);

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }
  } catch (e) {
    check("the tb-review selftest ran to completion without throwing", true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
  }
  return report("tb-review", results);
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
  process.stdout.write("\n  The fixtures above include a repository where gstack's own diff-base chain\n");
  process.stdout.write("  returns an empty diff, which its Step 1 reads as 'nothing to review'. Here\n");
  process.stdout.write("  that case exits 3 and names the step that failed.\n\n");
  return true;
}

function help() {
  out(`
  tb-review ${VERSION}  (Toolbay Stack)

  basis [--base <b>] [--fetch]   establish what to diff against, or refuse
  checklist [--path]             print the review checklist, or its path
  claims [--file <f>]            reject unverifiable claims in review output
  selftest                       prove all of the above against broken inputs

  Options: --json

  Exit codes for basis:
    0  a reviewable diff exists
    2  not a git work tree, or git is missing
    3  the comparison point could NOT be established (never report this as
       "nothing to review")
    4  verified: the diff ran and there are genuinely no changes
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "basis") cmdBasis(argv.slice(1));
else if (cmd === "checklist") cmdChecklist(argv.slice(1));
else if (cmd === "claims") cmdClaims(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
