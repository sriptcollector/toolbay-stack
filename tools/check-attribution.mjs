#!/usr/bin/env node
/**
 * check-attribution.mjs: prove the credit in this repository still matches the
 * files on disk.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This build tool is not derived from gstack's code, but the skills it checks
 * include files that are. See LICENSE and NOTICE.
 *
 * WHY THIS EXISTS. This project is a credited fork, and the credit is a hand
 * maintained list in NOTICE. A hand maintained list drifts: a skill gets added
 * and nobody adds the line, a header gets rewritten and the word DERIVED goes
 * with it, and the fork quietly turns into the thing it promised not to be. The
 * failure is silent and nothing else in the suite would catch it, because a
 * missing attribution header breaks no test.
 *
 * So the lists are checked AGAINST THE DISK, the same way run-tests.mjs
 * discovers engines rather than trusting a table:
 *
 *   - every skills/<name>/SKILL.md exists and names gstack, Garry Tan, and MIT
 *   - a header saying DERIVED WORK appears in NOTICE's derived list
 *   - a header saying Original work appears in NOTICE's new-work list
 *   - NOTICE names no skill directory that is not there
 *   - the count NOTICE claims in prose is the count on disk
 *   - LICENSE still carries Garry Tan's copyright line
 *
 *   node tools/check-attribution.mjs            report and exit non-zero on drift
 *   node tools/check-attribution.mjs --quiet     print only on drift
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

const UPSTREAM = "garrytan/gstack";
const AUTHOR = "Garry Tan";

const problems = [];
const fail = (s) => problems.push(s);

// ---- NOTICE, split into its two lists
let notice;
try {
  notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
} catch {
  out(red("\n  NOTICE is missing. That file is the record of what this fork credits.\n"));
  process.exit(2);
}

const newWorkStart = notice.indexOf("New work in this repository");
const derivedStart = notice.indexOf("Files derived from gstack");
if (newWorkStart === -1 || derivedStart === -1 || derivedStart < newWorkStart) {
  out(red("\n  NOTICE no longer has both attribution sections; refusing to report a pass over it.\n"));
  process.exit(2);
}

// Only the indented list lines count as a listing. Both sections also discuss
// skills in prose ("skills/router/ is original work, but..."), and reading that
// prose as a list entry would put router in both lists and report a conflict
// that is not there.
const skillsIn = (text) =>
  new Set(
    text
      .split("\n")
      .filter((l) => /^ {4}skills\/[a-z0-9-]+\/\s*(?:$|\S)/.test(l))
      .flatMap((l) => [...l.matchAll(/skills\/([a-z0-9-]+)\//g)].map((m) => m[1])),
  );
const newWork = skillsIn(notice.slice(newWorkStart, derivedStart));
const derived = skillsIn(notice.slice(derivedStart));
const named = new Set([...newWork, ...derived]);

for (const name of [...newWork].filter((n) => derived.has(n))) {
  fail(`skills/${name}/ is named as BOTH new work and derived in NOTICE`);
}

// ---- the disk
const skillsDir = path.join(ROOT, "skills");
const dirs = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let derivedOnDisk = 0;
let originalOnDisk = 0;

for (const name of dirs) {
  const file = path.join(skillsDir, name, "SKILL.md");
  let md;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    fail(`skills/${name}/ has no SKILL.md`);
    continue;
  }

  // The header is the authoritative record, so it is checked first and in full.
  // Headers are hard-wrapped prose, so the copyright line is matched against a
  // whitespace-collapsed copy: "(MIT, Copyright (c)\n2026 Garry Tan)" is the
  // credit intact, not a credit removed.
  const flat = md.replace(/\s+/g, " ");
  if (!md.includes(UPSTREAM)) fail(`skills/${name}/SKILL.md does not link ${UPSTREAM}`);
  if (!md.includes(AUTHOR)) fail(`skills/${name}/SKILL.md does not name ${AUTHOR}`);
  if (!/MIT/.test(md)) fail(`skills/${name}/SKILL.md does not state the MIT license`);
  if (!/Copyright \(c\) 2026 Garry Tan/.test(flat)) {
    fail(`skills/${name}/SKILL.md drops Garry Tan's copyright line`);
  }

  const isDerived = /DERIVED WORK\./.test(md);
  if (isDerived) derivedOnDisk += 1;
  else originalOnDisk += 1;

  if (isDerived && newWork.has(name)) fail(`skills/${name}/ says DERIVED WORK but NOTICE lists it as new work`);
  if (isDerived && !derived.has(name)) fail(`skills/${name}/ says DERIVED WORK but is absent from NOTICE's derived list`);
  if (!isDerived && !newWork.has(name)) {
    fail(`skills/${name}/ claims original work but is not in NOTICE's new-work list`);
  }
}

for (const name of named) {
  if (!dirs.includes(name)) fail(`NOTICE names skills/${name}/, which is not on disk`);
}

// The number written in the prose is checked too, because a stale number reads
// as a maintained list while being exactly as wrong as a missing line.
const claimed = /complete set as of this version,\s*(\d+)\s*skill directories/.exec(notice);
if (!claimed) fail("NOTICE no longer states how many derived skill directories it is listing");
else if (Number(claimed[1]) !== derivedOnDisk) {
  fail(`NOTICE claims ${claimed[1]} derived skill directories; ${derivedOnDisk} are on disk`);
}

// ---- LICENSE
try {
  const lic = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  if (!/Copyright \(c\) 2026 Garry Tan/.test(lic)) fail("LICENSE no longer carries Garry Tan's copyright line");
  if (!lic.includes(UPSTREAM)) fail(`LICENSE no longer points at ${UPSTREAM}`);
} catch {
  fail("LICENSE is missing");
}

if (!quiet || problems.length) {
  out();
  out(bold("  Attribution check"));
  out(dim(`  ${dirs.length} skill directories: ${derivedOnDisk} derived from gstack, ${originalOnDisk} original`));
  out(dim(`  NOTICE names ${named.size}, LICENSE and every SKILL.md header checked`));
  out();
}

if (problems.length) {
  out(red(bold(`  ${problems.length} attribution problem(s):`)));
  for (const p of problems) out(red(`    - ${p}`));
  out();
  out(dim("  This is a credited fork. Restore the credit rather than the list."));
  out();
  process.exit(1);
}

if (!quiet) {
  out(green(bold("  ok  every skill's header, NOTICE, and LICENSE agree with the disk.")));
  out();
}
