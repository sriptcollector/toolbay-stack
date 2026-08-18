#!/usr/bin/env node
/**
 * tb-browse-bin.mjs — find the gstack `browse` daemon binary, the same way,
 * from every skill that needs it.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * The search chain <root>/{.codex,.agents,.claude}/skills/gstack/browse/dist/
 * browse comes from gstack. The statSync validation, the Windows extensions and
 * the git-root step are new. See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. This lookup was written twice by hand and the two
 * copies did not agree, which was a live bug rather than a tidiness problem:
 *
 *   tb-browse.mjs  resolveBrowse      searched git root, then cwd, then home
 *   tb-scrape.mjs  findBrowseBinary   searched cwd, then home
 *
 * so running /scrape from a subdirectory of a repo reported "browse binary not
 * found" while /browse, from the identical cwd, found it and worked. Two
 * skills disagreeing about whether the machine has a browser is exactly the
 * class of failure this package exists to delete, so the lookup is one file
 * now and tools/sync-guard.mjs asserts every copy of it is byte-identical.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory, so a skill that imports across skill
 * boundaries breaks the moment someone installs only one of them. Each skill
 * carries the whole file; the sync guard keeps the copies identical.
 *
 *   node tb-browse-bin.mjs resolve     print what this cwd resolves to
 *   node tb-browse-bin.mjs selftest    prove the search order and the refusals
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";

/**
 * Candidate extensions, in preference order.
 *
 * gstack tests the extensionless path with `test -x`, which on Windows can only
 * be satisfied from Git Bash, so a green SETUP under Git Bash does not mean a
 * Node process will find the same file. `.mjs`/`.js` are here because a browse
 * script is a legitimate stand-in for the compiled binary and the selftests of
 * the skills that consume this use exactly that.
 */
export const BIN_EXTS = IS_WIN ? [".exe", ".cmd", ".bat", ".mjs", ".js"] : ["", ".mjs", ".js"];

/** The agent-tool directories gstack installs skills under, in gstack's order. */
export const MARKERS = [".codex", ".agents", ".claude"];

export function gitRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const top = (r.stdout || "").trim();
  return top ? path.resolve(top) : null;
}

/**
 * The first extension of `base` that is a real, openable file.
 *
 * Returns an absolute path or null. Never returns a path fs.statSync cannot
 * see, which is the whole difference from `test -x`.
 */
export function usableBinary(base) {
  for (const ext of BIN_EXTS) {
    const p = base + ext;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!IS_WIN && !ext) {
      // On POSIX an extensionless candidate has to actually be executable.
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        continue;
      }
    }
    return path.resolve(p);
  }
  return null;
}

/**
 * Resolve the browse binary for a working directory.
 *
 * Returns {bin, via, searched}. `searched` is every location tried, in order,
 * so a "not found" can be printed as evidence rather than as an assertion.
 *
 * SEARCH ORDER, and why git root comes first: the binary is installed once per
 * repository, at the repository root, and agents routinely run from a
 * subdirectory. Searching cwd first and stopping at home means a tool run from
 * `repo/packages/web` never sees `repo/.claude/...`. That was the bug.
 */
export function resolveBrowse(cwd = process.cwd()) {
  const searched = [];

  const envBin = process.env.TOOLBAY_BROWSE_BIN;
  if (envBin) {
    // An explicit override is taken literally first, then with extensions.
    let hit = null;
    try {
      if (fs.statSync(envBin).isFile()) hit = path.resolve(envBin);
    } catch {
      hit = usableBinary(envBin);
    }
    searched.push(`TOOLBAY_BROWSE_BIN=${envBin}`);
    if (hit) return { bin: hit, via: "TOOLBAY_BROWSE_BIN", searched };
    return { bin: null, via: null, searched };
  }

  const roots = [];
  const gr = gitRoot(cwd);
  if (gr) roots.push(gr);
  roots.push(path.resolve(cwd));
  roots.push(os.homedir());

  const seen = new Set();
  for (const root of roots) {
    for (const marker of MARKERS) {
      const base = path.join(root, marker, "skills", "gstack", "browse", "dist", "browse");
      if (seen.has(base)) continue;
      seen.add(base);
      searched.push(base + (IS_WIN ? "{.exe,.cmd,.bat}" : ""));
      const hit = usableBinary(base);
      if (hit) return { bin: hit, via: root === gr ? "git root" : root === os.homedir() ? "home" : "cwd", searched };
    }
  }
  return { bin: null, via: null, searched };
}

/** The path only, for callers that do their own error reporting. */
export function findBrowseBinary(cwd = process.cwd()) {
  return resolveBrowse(cwd).bin;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browse-bin-"));
  const saved = process.env.TOOLBAY_BROWSE_BIN;
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere. The machine
  // running this may genuinely have a browse binary in its home directory, and
  // a selftest whose negative cases pass only on machines without one is a
  // selftest that proves nothing. So home is pointed at an empty fixture.
  //
  // AND THE SAME APPLIES TO THE GIT ROOT, which is the other place resolveBrowse
  // looks and the one this test forgot. Redirecting home is not enough: the
  // search order is git root, then cwd, then home, so an ancestor repository
  // above the sandbox hands back a root OUTSIDE the fixture and the negative
  // cases resolve to the developer's real gstack install. Found on this machine
  // 2026-08-16 — a stray `git init` in HOME put os.tmpdir() inside a repository,
  // and "a machine with no binary resolves to null" returned
  // C:\Users\<user>\.claude\skills\gstack\browse\dist\browse.exe. git's own
  // boundary variable keeps the whole search inside the fixture.
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
  };
  try {
    const fakeHome = path.join(tmp, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.GIT_CEILING_DIRECTORIES = tmp;
    // A repo with the binary at its ROOT and a working directory two levels
    // down. This is the exact shape the drifted copy got wrong.
    const repo = path.join(tmp, "repo");
    const deep = path.join(repo, "packages", "web");
    fs.mkdirSync(deep, { recursive: true });
    const distDir = path.join(repo, ".claude", "skills", "gstack", "browse", "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const binFile = path.join(distDir, IS_WIN ? "browse.exe" : "browse");
    fs.writeFileSync(binFile, "#!/bin/sh\n", "utf8");
    if (!IS_WIN) fs.chmodSync(binFile, 0o755);
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });

    delete process.env.TOOLBAY_BROWSE_BIN;

    const fromRoot = resolveBrowse(repo);
    check("found from the repository root", true, Boolean(fromRoot.bin), JSON.stringify(fromRoot.searched));

    const fromDeep = resolveBrowse(deep);
    check("found from a subdirectory too", true, Boolean(fromDeep.bin), JSON.stringify(fromDeep.searched));
    check("...and it is the same binary", path.resolve(binFile), String(fromDeep.bin));
    check("...reached via the git root", "git root", String(fromDeep.via), JSON.stringify(fromDeep.searched));

    // Not found has to report where it looked, not just say no.
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const miss = resolveBrowse(empty);
    check("a machine with no binary resolves to null", "null", String(miss.bin));
    check("...and still lists the places it looked", true, miss.searched.length > 0, JSON.stringify(miss.searched));

    // A directory named like the binary is not a binary.
    const dirTrap = path.join(tmp, "trap");
    const trapDist = path.join(dirTrap, ".claude", "skills", "gstack", "browse", "dist");
    fs.mkdirSync(path.join(trapDist, "browse"), { recursive: true });
    check("a DIRECTORY called browse is not accepted as the binary", "null", String(resolveBrowse(dirTrap).bin));

    // The env override wins, and a bad override fails rather than falling back
    // to a binary the user did not ask for.
    process.env.TOOLBAY_BROWSE_BIN = binFile;
    check("TOOLBAY_BROWSE_BIN is honoured", path.resolve(binFile), String(resolveBrowse(empty).bin));
    check("...and is reported as the source", "TOOLBAY_BROWSE_BIN", String(resolveBrowse(empty).via));
    process.env.TOOLBAY_BROWSE_BIN = path.join(tmp, "no-such-browse");
    check("a TOOLBAY_BROWSE_BIN that does not exist does NOT fall back", "null", String(resolveBrowse(repo).bin));
    delete process.env.TOOLBAY_BROWSE_BIN;

    check("findBrowseBinary returns the same path", path.resolve(binFile), String(findBrowseBinary(deep)));
    check("usableBinary refuses a base with no real file", "null", String(usableBinary(path.join(tmp, "nothing"))));
  } finally {
    if (saved === undefined) delete process.env.TOOLBAY_BROWSE_BIN;
    else process.env.TOOLBAY_BROWSE_BIN = saved;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Cleanup is housekeeping, never the verdict: an EPERM from a handle Windows
    // has not released yet must not take the report down with it.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a leftover temp directory is not the story */
    }
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-browse-bin selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  One resolver, so /browse and /scrape cannot disagree about whether this\n  machine has a browser.\n\n");
}

// Only act as a CLI when run directly, never when imported by an engine.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  if (cmd === "selftest") selftest();
  else if (cmd === "resolve") {
    const r = resolveBrowse(process.cwd());
    process.stdout.write(`\n  ${r.bin ? `${r.bin}  (via ${r.via})` : "not found"}\n`);
    for (const s of r.searched) process.stdout.write(`    looked: ${s}\n`);
    process.stdout.write("\n");
    if (!r.bin) process.exitCode = 1;
  } else {
    process.stdout.write("\n  usage: tb-browse-bin.mjs resolve | selftest\n\n");
    process.exitCode = 1;
  }
}
