#!/usr/bin/env node
/**
 * tb-outdir.mjs — where a run's artifacts go, and the paths that are refused.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. Sixteen engines carried their own copy of the same
 * refusal and six carried their own `resolveOutDir`, each with its own env
 * variable and its own wording. Measured on Windows 11:
 *
 *   $ cd /tmp && pwd -W                        C:/Users/<you>/AppData/Local/Temp
 *   $ node -p "path.resolve('/tmp/qa')"        C:\tmp\qa
 *
 * So `--dir /tmp/qa` means one directory to a shell or a browser and another
 * to Node, PowerShell and the Read tool. A run writes its evidence to one and
 * links to the other, and the report is a page of paths that open nothing.
 * gstack's own setup table recommends exactly that path. It is refused here,
 * with both candidates printed, rather than silently half-working.
 *
 * WHICH VARIANT WON: the widest refusal on disk. Eight copies matched
 * /tmp|var|usr|home|opt|etc|mnt and one also matched /dev and /proc and was
 * case-insensitive. The wider one is kept, because between two versions of a
 * refusal the honest tie-break is the one that refuses more: every path it
 * adds is a POSIX system directory that means something different on Windows.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory. Each skill carries the file;
 * tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-outdir.mjs check <path>
 *   node tb-outdir.mjs selftest
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, nativeAbs } from "./tb-paths.mjs";

/** POSIX roots that name a different directory to a shell than to Node on Windows. */
export const AMBIGUOUS_ON_WINDOWS = /^\/(tmp|var|usr|home|opt|etc|mnt|dev|proc)(\/|$)/i;

/** Is this path one whose meaning depends on who is asking. Windows only. */
export function isAmbiguousPath(p) {
  return IS_WINDOWS && AMBIGUOUS_ON_WINDOWS.test(String(p).trim().replace(/^["']|["']$/g, ""));
}

/**
 * The refusal text: both directories the string could mean, then the way out.
 *
 * `consequence` is the one clause that is genuinely per-skill — what gets lost
 * when half the run writes to one directory and half reads from the other.
 */
export function ambiguityError(s, { consequence, fallback }) {
  const viaShell = path.join(os.tmpdir(), s.replace(/^\/(tmp|var|usr|home|opt|etc|mnt|dev|proc)\/?/i, ""));
  return (
    `"${s}" means two different directories on this machine. Git Bash resolves it under ${os.tmpdir()} ` +
    `(so a shell or a browser writes to ${viaShell}), and Node, Python, PowerShell and the Read tool resolve ` +
    `it to ${path.resolve(s)}. ${consequence} ` +
    `Pass a real path, or omit --dir to use ${fallback}.`
  );
}

/**
 * Resolve a user-supplied output directory.
 *
 *   raw          the --dir value, or null/undefined for the default
 *   defaultDir   what to use when raw is empty (already env-resolved by the
 *                caller, because the env variable name is per-skill)
 *   consequence  one sentence naming what breaks if the path is ambiguous
 *
 * Returns {ok: true, dir} or {ok: false, error}.
 */
export function resolveOutDir(raw, { defaultDir, consequence = "Half the run would be written where the other half does not look." } = {}) {
  if (!raw) return { ok: true, dir: path.resolve(defaultDir) };
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (isAmbiguousPath(s)) return { ok: false, error: ambiguityError(s, { consequence, fallback: defaultDir }) };
  return { ok: true, dir: nativeAbs(s) };
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const fallback = path.join(process.cwd(), ".toolbay", "example");
  const opts = { defaultDir: fallback, consequence: "Screenshots would land in one and the report would link to the other." };

  check("no --dir uses the default", path.resolve(fallback), resolveOutDir(null, opts).dir);
  check("an empty --dir uses the default too", path.resolve(fallback), resolveOutDir("", opts).dir);
  check("a relative --dir resolves against cwd", path.resolve(process.cwd(), "out"), resolveOutDir("out", opts).dir);
  check("quotes are stripped", path.resolve(process.cwd(), "out"), resolveOutDir('"out"', opts).dir);

  if (IS_WINDOWS) {
    check("/tmp is refused", false, resolveOutDir("/tmp/qa", opts).ok);
    check("...and both directories are named", true, /Git Bash resolves it under/.test(resolveOutDir("/tmp/qa", opts).error));
    check("...and the refusal says what would break", true, /Screenshots would land/.test(resolveOutDir("/tmp/qa", opts).error));
    check("...and offers the fallback", true, resolveOutDir("/tmp/qa", opts).error.includes(fallback));
    check("/var is refused", false, resolveOutDir("/var/folders/x", opts).ok);
    check("/dev is refused (the wider variant)", false, resolveOutDir("/dev/shm/x", opts).ok);
    check("/proc is refused (the wider variant)", false, resolveOutDir("/proc/self", opts).ok);
    check("/TMP is refused case-insensitively", false, resolveOutDir("/TMP/qa", opts).ok);
    check("a bare /tmp with no child is refused", false, resolveOutDir("/tmp", opts).ok);
    check("/tmpfoo is NOT refused, it is not /tmp", true, resolveOutDir("/tmpfoo", opts).ok);
    check("an MSYS drive path is accepted and converted", path.resolve("C:/work/out"), resolveOutDir("/c/work/out", opts).dir);
    check("a native Windows path is accepted", path.resolve("C:/work/out"), resolveOutDir("C:\\work\\out", opts).dir);
  } else {
    check("/tmp is fine off Windows, where it means one directory", true, resolveOutDir("/tmp/qa", opts).ok);
    check("...and resolves to itself", path.resolve("/tmp/qa"), resolveOutDir("/tmp/qa", opts).dir);
  }

  check("isAmbiguousPath agrees with the resolver", IS_WINDOWS, isAmbiguousPath("/tmp/x"));
  check("a project-relative path is never ambiguous", false, isAmbiguousPath("./.toolbay/qa"));

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-outdir selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  One refusal list and one resolver, so a path one skill writes to is a path\n  every other skill can find.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "selftest") selftest();
  else if (cmd === "check" && arg) {
    const r = resolveOutDir(arg, { defaultDir: path.join(process.cwd(), ".toolbay", "example"), consequence: "The run would be split across two directories." });
    process.stdout.write(`\n  ${r.ok ? `ok  ${r.dir}` : `REFUSED  ${r.error}`}\n\n`);
    if (!r.ok) process.exitCode = 1;
  } else {
    process.stdout.write("\n  usage: tb-outdir.mjs check <path> | selftest\n\n");
    process.exitCode = 1;
  }
}
