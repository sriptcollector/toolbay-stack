#!/usr/bin/env node
/**
 * tb-paths.mjs — one answer to "what file does this string mean", for every
 * engine in the package.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. `fromMsysPath` was hand-copied into 26 engines and
 * `looksAbsolute` into 22, and the copies had already drifted. That matters
 * more here than it looks, because these two functions decide WHERE every
 * artifact this package promises as evidence gets written and read back:
 *
 *   - A Windows agent shell hands over `/c/Users/orion/x`. Node reads that as
 *     `C:\c\Users\orion\x`, a directory that does not exist, so a run writes
 *     its ledger somewhere nobody looks and the next command reports "no saved
 *     context" beside a file that is right there. fromMsysPath is the fix, and
 *     a skill missing it is a skill that loses the user's work silently.
 *   - `path.isAbsolute` is not enough on Windows: it is false for `/foo` in
 *     some hosts and says nothing about `\\server\share`. looksAbsolute is the
 *     test that decides whether a user-supplied `--dir` is joined onto cwd or
 *     taken as given, and getting it wrong writes outside the project.
 *
 * WHICH VARIANT WON. fromMsysPath keeps the bare-drive-letter case (`/c` ->
 * `C:/`) that only two of the 26 copies had. `/c` IS a real path a shell hands
 * over, the other 24 copies returned it unchanged, and unchanged means Node
 * resolves it against the current drive root — a different directory, silently.
 * The wider behaviour is a superset: every input the narrow copies handled is
 * handled identically here.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory, so a skill importing across skill
 * boundaries breaks the moment someone installs only one of them. Each skill
 * carries the whole file; tools/sync-guard.mjs asserts the copies are
 * byte-identical, so fixing this in one place cannot leave the others behind.
 *
 *   node tb-paths.mjs resolve <path>   show what this string resolves to
 *   node tb-paths.mjs selftest
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WINDOWS = process.platform === "win32";

/**
 * `/c/Users/x` -> `C:/Users/x`, and `/c` -> `C:/`, on Windows only.
 *
 * On every other platform the string is already correct and is returned
 * untouched, so this is safe to call on any input.
 */
export function fromMsysPath(p) {
  if (!IS_WINDOWS) return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  // A bare drive letter directory, `/c`, is the root of that drive.
  const d = /^\/([a-zA-Z])$/.exec(p);
  return d ? `${d[1].toUpperCase()}:/` : p;
}

/**
 * Is this string rooted, by any spelling this stack can be handed.
 *
 * Deliberately wider than path.isAbsolute: `C:\`, `C:/`, a UNC share, and a
 * POSIX or rooted-Windows leading slash all count.
 */
export function looksAbsolute(p) {
  return (
    /^[a-zA-Z]:[\\/]/.test(p) || // C:\ or C:/
    /^[\\/]{2}[^\\/]/.test(p) || // \\server\share UNC
    /^[\\/]/.test(p) // POSIX, or a rooted Windows path
  );
}

/** `~` and `~/x` -> the home directory. Anything else is returned as given. */
export function expandHome(p) {
  const s = String(p);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || (IS_WINDOWS && s.startsWith("~\\"))) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * A user-supplied path as an absolute native path every host agrees on:
 * quotes stripped, `~` expanded, MSYS spelling converted, then resolved
 * against `base` (cwd by default) if it is still relative.
 */
export function nativeAbs(p, base = process.cwd()) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  s = expandHome(s);
  s = fromMsysPath(s);
  return path.resolve(looksAbsolute(s) ? s : path.join(base, s));
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  if (IS_WINDOWS) {
    check("an MSYS path becomes a drive path", "C:/Users/x", fromMsysPath("/c/Users/x"));
    check("the drive letter is upper-cased", "D:/tmp/a", fromMsysPath("/d/tmp/a"));
    check("an upper-case drive letter is kept", "C:/x", fromMsysPath("/C/x"));
    check("a bare drive letter is the drive root", "C:/", fromMsysPath("/c"));
    check("a POSIX path with no drive letter is left alone", "/usr/local", fromMsysPath("/usr/local"));
    check("a two-letter first segment is not a drive", "/ab/c", fromMsysPath("/ab/c"));
    check("an already-native path is untouched", "C:\\Users\\x", fromMsysPath("C:\\Users\\x"));
    check("a relative path is untouched", "src/a.mjs", fromMsysPath("src/a.mjs"));
    check("C:\\ is absolute", true, looksAbsolute("C:\\Users"));
    check("a UNC share is absolute", true, looksAbsolute("\\\\server\\share"));
  } else {
    check("fromMsysPath is a no-op off Windows", "/c/Users/x", fromMsysPath("/c/Users/x"));
    check("a bare /c is a no-op off Windows", "/c", fromMsysPath("/c"));
  }

  check("C:/ is absolute", true, looksAbsolute("C:/Users"));
  check("a leading slash is absolute", true, looksAbsolute("/tmp/x"));
  check("a bare name is not absolute", false, looksAbsolute("notes.md"));
  check("a dot-relative path is not absolute", false, looksAbsolute("./out"));
  check("a parent-relative path is not absolute", false, looksAbsolute("../out"));
  check("an empty string is not absolute", false, looksAbsolute(""));
  check("a lone drive letter with no separator is not absolute", false, looksAbsolute("C:"));

  check("~ expands to home", os.homedir(), expandHome("~"));
  check("~/x expands under home", path.join(os.homedir(), "x"), expandHome("~/x"));
  check("a tilde mid-string is not expanded", "a~/b", expandHome("a~/b"));

  check("nativeAbs strips quotes", path.resolve("/tmp/x"), nativeAbs('"/tmp/x"'));
  check("nativeAbs resolves a relative path against the base", path.resolve("/base", "out"), nativeAbs("out", "/base"));
  check("nativeAbs leaves an absolute path where it is", path.resolve("/other/out"), nativeAbs("/other/out", "/base"));
  if (IS_WINDOWS) check("nativeAbs converts MSYS spelling", path.resolve("C:/Users/x"), nativeAbs("/c/Users/x"));

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-paths selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  Every engine in this package now resolves a path the same way, so an\n  artifact written by one is an artifact another can find.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "selftest") selftest();
  else if (cmd === "resolve" && arg) {
    process.stdout.write(`\n  ${arg}\n    fromMsysPath  ${fromMsysPath(arg)}\n    looksAbsolute ${looksAbsolute(arg)}\n    nativeAbs     ${nativeAbs(arg)}\n\n`);
  } else {
    process.stdout.write("\n  usage: tb-paths.mjs resolve <path> | selftest\n\n");
    process.exitCode = 1;
  }
}
