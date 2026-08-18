#!/usr/bin/env node
/**
 * tb-context-format.mjs — the saved-context file format, written once, so the
 * save side and the restore side cannot disagree about it.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * The file format this describes is derived from gstack's context-save /
 * context-restore pair; this module is not derived from gstack's code.
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. /context-save and /context-restore are one feature
 * spread over two engines, and each of them had its own private answer to three
 * questions. Every answer disagreed, and no test in this package crossed the
 * seam, so all 119 selftests passed over a feature that had never once round
 * tripped. Reproduced 2026-08-14 against the shipped code:
 *
 *   1. WHICH FRONTMATTER FIELD HOLDS THE SAVE TIME.
 *      save wrote      `saved_at: 2026-08-14T20:31:07.442Z`
 *      restore required `["branch","timestamp"]` (tb-context-restore.mjs:487)
 *      and never looked at saved_at. Every file save produced was rejected as
 *      "frontmatter has no timestamp, so this is not a saved context".
 *      save's own `verify` accepted either name, so it certified its own output.
 *
 *   2. WHICH CLOCK THE TIME IS ON. The filename stamp is LOCAL wall clock
 *      (`20260814-133107`). save wrote the frontmatter time as UTC with no
 *      offset from the filename's point of view, and restore compares the two
 *      wall-clock readings and calls a disagreement over an hour disputed
 *      provenance. So on any machine more than an hour off UTC, simply renaming
 *      the field would have turned every save into a STALE restore with
 *      "FAIL timestamp provenance". One helper writes the stamp now, with its
 *      offset, so the two readings are the same reading.
 *
 *   3. WHICH DIRECTORY THE DRAWER IS IN. save filed under
 *      slugify(basename(repoRoot)) — lower-cased, ASCII. restore looked under
 *      `owner-repo` derived from `git remote get-url origin`, falling back to
 *      basename with its case intact. In any repository with a remote those are
 *      different directories, so restore reported NO SAVED CONTEXTS over a
 *      drawer full of saves.
 *
 * So the format lives here: the field name, the clock, and the drawer name. The
 * seam test in tools/seam-tests.mjs runs the real save engine and feeds its real
 * output to the real restore engine, which is the test that would have caught
 * all three.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a skill
 * as a self-contained directory, so a skill importing across skill boundaries
 * breaks the moment someone installs only one of them. Each skill carries the
 * whole file; tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-context-format.mjs stamp     print today's stamp in both spellings
 *   node tb-context-format.mjs selftest
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one frontmatter key that holds when a context was saved.
 *
 * `timestamp` won over `saved_at` because it is the name in gstack's format,
 * which is the format of every file a migrating user already has on disk, and
 * because the restore side and both SKILL.md documents already said `timestamp`.
 * Renaming three of those to match one of them would have orphaned real files.
 */
export const TIME_FIELD = "timestamp";

/**
 * Field names a saved-context time may appear under, newest spelling first.
 *
 * `saved_at` is here because Toolbay Stack shipped it: anyone who ran
 * /context-save before this fix has files carrying it, and those files are
 * perfectly good contexts. They are read, not orphaned. Nothing WRITES saved_at
 * any more.
 */
export const TIME_FIELD_ALIASES = [TIME_FIELD, "saved_at"];

/** The save time out of a parsed frontmatter object, or null. */
export function readSavedTime(fields) {
  if (!fields || typeof fields !== "object") return null;
  for (const key of TIME_FIELD_ALIASES) {
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Which alias a file actually used, for messages that have to name it. */
export function savedTimeField(fields) {
  if (!fields || typeof fields !== "object") return null;
  for (const key of TIME_FIELD_ALIASES) {
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return key;
  }
  return null;
}

const two = (n) => String(n).padStart(2, "0");

/**
 * A local wall-clock ISO-8601 stamp WITH its offset: 2026-08-14T13:31:07-07:00.
 *
 * The offset is the whole point. The filename stamp is local wall clock, and the
 * restore side compares the two by wall clock; a bare `toISOString()` reads as
 * UTC and disagrees with the filename by this machine's offset, which restore
 * reports as disputed provenance. With the offset attached, both spellings name
 * the same instant AND the same digits.
 */
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`
  );
}

/** The `YYYYMMDD-HHMMSS` filename prefix, on the same clock as isoLocal. */
export function fileStamp(d = new Date()) {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/**
 * Filesystem-safe, lower-case, ASCII. Never empty, never a path fragment.
 *
 * Used for both the project drawer name and the title portion of a filename, so
 * a title of `../../../etc/passwd` cannot become a path.
 */
export function contextSlug(raw, fallback = "untitled", max = 60) {
  const s = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .slice(0, max)
    .replace(/[.\-]+$/, "");
  return s || fallback;
}

/**
 * The drawer a context is filed under: the repository root's name when there is
 * one, so the same project keeps one drawer from any subdirectory or worktree,
 * and the working directory's name otherwise.
 *
 * This is the name the SAVE side writes to. The restore side derives its own
 * preferred slug from the git remote as well, and looks in both — but it has to
 * look here, or it is searching a directory nothing ever wrote to.
 */
export function saveProjectSlug(repoRoot, cwd) {
  const base = repoRoot ? path.basename(path.resolve(repoRoot)) : path.basename(path.resolve(cwd));
  return contextSlug(base, "unknown", 48);
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // ---- the field name, and the files that already exist
  check("the canonical time field is timestamp", "timestamp", TIME_FIELD);
  check("a file written with the canonical field is read", "2026-08-14T13:00:00-07:00", readSavedTime({ timestamp: "2026-08-14T13:00:00-07:00" }));
  check("a file already on disk carrying saved_at is still read", "2026-08-01T09:00:00Z", readSavedTime({ saved_at: "2026-08-01T09:00:00Z" }));
  check("...and is reported under the name it actually used", "saved_at", savedTimeField({ saved_at: "2026-08-01T09:00:00Z" }));
  check("timestamp wins when a file somehow carries both", "new", readSavedTime({ timestamp: "new", saved_at: "old" }));
  check("frontmatter with neither field has no time", "null", String(readSavedTime({ branch: "main" })));
  check("a blank timestamp is not a time", "null", String(readSavedTime({ timestamp: "   " })));
  check("a list value is not a time", "null", String(readSavedTime({ timestamp: ["a"] })));
  check("a non-object is not frontmatter", "null", String(readSavedTime(null)));

  // ---- the clock. This is the check that fails if anyone reaches for
  // toISOString() again: the filename and the frontmatter must read the same
  // wall clock, whatever zone this machine is in.
  {
    const d = new Date(2026, 7, 14, 13, 31, 7);
    const iso = isoLocal(d);
    const name = fileStamp(d);
    check("the filename stamp is local wall clock", "20260814-133107", name);
    check("the frontmatter stamp is the same wall clock", true, iso.startsWith("2026-08-14T13:31:07"), iso);
    check("...and carries an explicit offset", true, /[+-]\d{2}:\d{2}$/.test(iso), iso);
    check("...so both spellings name the same instant", d.getTime(), Date.parse(iso), iso);
    // The comparison restore actually makes: wall-clock digits, pinned to UTC.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
    const isoWallUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const nameWallUTC = Date.UTC(2026, 7, 14, 13, 31, 7);
    check("...and restore's provenance comparison sees no drift", 0, Math.abs(isoWallUTC - nameWallUTC), `iso ${iso}, name ${name}`);
  }
  {
    // A UTC-spelled stamp, which is what the broken save side wrote. Off a
    // UTC machine its wall clock disagrees with the filename by the offset,
    // which is the failure this helper exists to make impossible.
    const d = new Date(2026, 7, 14, 13, 31, 7);
    const utc = d.toISOString();
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(utc);
    const utcWallUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const nameWallUTC = Date.UTC(2026, 7, 14, 13, 31, 7);
    const drift = Math.abs(utcWallUTC - nameWallUTC);
    check(
      "a UTC-spelled stamp drifts from the filename by exactly this machine's offset",
      Math.abs(d.getTimezoneOffset()) * 60000,
      drift,
      `${utc} vs 20260814-133107`,
    );
  }

  // ---- the drawer name
  check("a repo root name becomes the drawer name", "toolbay-stack", saveProjectSlug("/home/x/toolbay-stack", "/anywhere"));
  check("case is folded, so Linux and Windows agree", "widget", saveProjectSlug("/home/x/Widget", "/anywhere"));
  check("a subdirectory of the repo still names the repo", "myproj", saveProjectSlug("/home/x/myproj", "/home/x/myproj/src/deep"));
  check("with no repo root the working directory names the drawer", "scratch", saveProjectSlug(null, "/home/x/scratch"));
  check("a name with spaces becomes one slug", "my-project", contextSlug("My Project"));
  check("a traversal cannot become a path", "etc-passwd", contextSlug("../../../etc passwd"));
  check("...with no separators left in it", false, /[\\/]/.test(contextSlug("../../../etc passwd")));
  check("a title with no ASCII falls back rather than emptying", "untitled", contextSlug("認証リファクタ"));
  check("a fallback can be chosen", "unknown", contextSlug("", "unknown"));
  check("length is capped", 8, contextSlug("abcdefghijklmnop", "x", 8).length);

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-context-format selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  The save side and the restore side now read one field, off one clock, in\n");
  process.stdout.write("  one directory. tools/seam-tests.mjs proves it end to end with both real\n  engines, because a module that agrees with itself is not the thing that broke.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "selftest") selftest();
  else if (cmd === "stamp") {
    const now = new Date();
    process.stdout.write(`\n  filename     ${fileStamp(now)}\n  frontmatter  ${TIME_FIELD}: ${isoLocal(now)}\n\n`);
  } else {
    process.stdout.write("\n  usage: tb-context-format.mjs stamp | selftest\n\n");
    process.exitCode = 1;
  }
}
