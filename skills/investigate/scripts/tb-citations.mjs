#!/usr/bin/env node
/**
 * tb-citations.mjs — "does the file:line this claim cites actually exist", asked
 * once, for every engine in this package that gates on cited evidence.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This module is not derived from gstack's code. See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. /investigate's report gate is the thing that decides
 * whether a fix may be called DONE. It checked the field names, it checked that
 * a `Fix:` line matched a `file:line` regex, and it checked a wordlist of
 * hedges — and it never touched the filesystem. Reproduced 2026-08-14 against
 * the shipped gate:
 *
 *   Fix:             src/quantum/warp-core.mjs:4021 clamp the flux ratio
 *   Evidence:        ran the full suite, everything was green, trust me
 *   Regression test: test/warp-core.test.mjs:88
 *   Status:          DONE
 *   -> verdict ACCEPTED, exit 0
 *
 * There is no src/quantum/ in that repository and there never was. The gate
 * whose entire job is refusing unevidenced claims accepted a citation to a file
 * that does not exist, because a regex only proves that a string is SHAPED like
 * a citation.
 *
 * `tb-spec.mjs lint --check-paths` was already doing this check correctly, in
 * this same package, thirty lines of it. Copying those thirty lines into the
 * investigate gate would have been the ninth hand-written copy of a shared idea
 * in this repository, and this repo has already been through what that costs
 * (see tools/sync-guard.mjs). So the check moved here, both callers import it,
 * and the copies are asserted byte-identical.
 *
 * WHAT COUNTS AS A CITATION. `path/to/file.ext:42` only. A bare filename with no
 * line number is NOT checked: "see TODOS.md" is a pointer, not a claim about a
 * specific line, and failing a report over prose would train people to stop
 * writing the pointer. A `file:line` IS a claim, and it is checkable.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a skill
 * as a self-contained directory, so a skill importing across skill boundaries
 * breaks the moment someone installs only one of them. Each skill carries the
 * whole file; tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-citations.mjs check <file> [--root <dir>]
 *   node tb-citations.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `path/to/file.ext:42` — a citation that asserts the line exists today.
 *
 * The extension must START WITH A LETTER, which is what keeps version numbers
 * out. The pattern inherited from tb-spec.mjs allowed `[A-Za-z0-9]{1,10}`, so
 * `gstack 1.60.1.0:12` parsed as a citation to a file called `1.60.1.0` — and
 * once this check is wired into /investigate's DONE gate, a version number in a
 * report becomes a rejection for citing a file that does not exist. Nobody had
 * noticed because /spec's linter only ran the check behind an opt-in flag and
 * never tested a version string. No real source extension starts with a digit.
 *
 * The leading boundary keeps the match anchored at a word start. The pattern is
 * exported as a source string so callers can build their own flagged copy
 * without sharing lastIndex with anyone.
 */
export const CITED_LINE_SOURCE = "(?:^|[\\s`(\"'\\[])([A-Za-z0-9_./\\\\+-]+\\.[A-Za-z][A-Za-z0-9]{0,9}):(\\d+)";

/** Every file:line citation in a block of text, in the order they appear. */
export function findCitations(text) {
  const re = new RegExp(CITED_LINE_SOURCE, "g");
  const cites = [];
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    // A URL carries a scheme, and `https://host:8080/x` is a port, not a line.
    if (/^https?$/i.test(m[1])) continue;
    cites.push({ file: m[1], line: Number(m[2]) });
  }
  return cites;
}

/**
 * Check every citation in `text` against real files under `root`.
 *
 * @returns {{cites: {file:string,line:number}[], problems: string[]}}
 *
 * A citation fails in exactly two ways, and both of them are the same lie in
 * different clothes: the file is not there, or it is there and is too short to
 * have the line that was cited.
 */
export function checkCitations(text, root = process.cwd()) {
  const cites = findCitations(text);
  const problems = [];
  const lineCounts = new Map();
  for (const c of cites) {
    const abs = path.resolve(root, c.file.replace(/\\/g, path.sep));
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      problems.push(`cites ${c.file}:${c.line} but that file does not exist under ${root}`);
      continue;
    }
    let count = lineCounts.get(abs);
    if (count === undefined) {
      try {
        count = fs.readFileSync(abs, "utf8").split(/\r?\n/).length;
      } catch (e) {
        problems.push(`cites ${c.file}:${c.line} but that file could not be read (${e.code || e.message})`);
        continue;
      }
      lineCounts.set(abs, count);
    }
    if (c.line > count) problems.push(`cites ${c.file}:${c.line} but that file has only ${count} lines`);
  }
  return { cites, problems };
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const os = { tmpdir: () => (process.env.TMPDIR || process.env.TEMP || process.env.TMP || ".") };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-citations-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const root = path.join(tmp, "proj");
  fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  // 10 lines exactly.
  fs.writeFileSync(path.join(root, "src", "auth", "session.ts"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
  fs.writeFileSync(path.join(root, "test", "session.test.ts"), "a\nb\nc\n", "utf8");

  // ---- what it finds
  check("a plain citation is found", "src/auth/session.ts:4", findCitations("Fix: src/auth/session.ts:4 guard the null").map((c) => `${c.file}:${c.line}`).join(","));
  check("a backticked citation is found", "src/auth/session.ts:4", findCitations("see `src/auth/session.ts:4`").map((c) => `${c.file}:${c.line}`).join(","));
  check("a parenthesised citation is found", "src/auth/session.ts:9", findCitations("(src/auth/session.ts:9)").map((c) => `${c.file}:${c.line}`).join(","));
  check("two citations on one line are both found", 2, findCitations("a.ts:1 and b.ts:2").length);
  check("a bare filename with no line is not a citation", 0, findCitations("see TODOS.md for the list").length);
  check("a version number is not a citation", 0, findCitations("gstack 1.60.1.0:12").length, JSON.stringify(findCitations("gstack 1.60.1.0:12")));
  check("a URL with a port is not a citation", 0, findCitations("http://localhost:3000/x").length, JSON.stringify(findCitations("http://localhost:3000/x")));

  // ---- what it accepts
  check("a citation to a real line passes", 0, checkCitations("Fix: src/auth/session.ts:4", root).problems.length, JSON.stringify(checkCitations("Fix: src/auth/session.ts:4", root).problems));
  check("the last line of a file is a real line", 0, checkCitations("src/auth/session.ts:10", root).problems.length);
  check("a windows-spelled path resolves", 0, checkCitations("src\\auth\\session.ts:4", root).problems.length, JSON.stringify(checkCitations("src\\auth\\session.ts:4", root).problems));
  check("text with no citations at all passes", 0, checkCitations("I fixed it, honestly", root).problems.length);

  // ---- what it refuses. These are the two shapes of the same lie.
  {
    const r = checkCitations("Fix: src/quantum/warp-core.mjs:4021 clamp the flux ratio", root);
    check("a citation to a file that does not exist is refused", 1, r.problems.length, JSON.stringify(r.problems));
    check("...and the message names the file", true, /warp-core\.mjs:4021/.test(r.problems[0] ?? ""), r.problems[0] ?? "");
    check("...and says it does not exist", true, /does not exist/.test(r.problems[0] ?? ""), r.problems[0] ?? "");
  }
  {
    const r = checkCitations("Regression test: src/auth/session.ts:4021", root);
    check("a line past the end of a real file is refused", 1, r.problems.length, JSON.stringify(r.problems));
    check("...and the message says how long the file really is", true, /only 10 lines/.test(r.problems[0] ?? ""), r.problems[0] ?? "");
  }
  {
    const r = checkCitations("a.ts:1 src/auth/session.ts:4 b.ts:2", root);
    check("every bad citation is reported, not just the first", 2, r.problems.length, JSON.stringify(r.problems));
    check("...and the good one is not", false, r.problems.join(" ").includes("session.ts"), JSON.stringify(r.problems));
  }
  {
    // A directory is not a file, and citing a line in one is not evidence.
    const r = checkCitations("src/auth:4", root);
    check("a citation to a directory is refused", 0, r.problems.length, "src/auth has no extension, so it is not read as a citation at all");
    const r2 = checkCitations("session.ts:1", path.join(root, "src"));
    check("--root decides what the citation is relative to", 1, r2.problems.length, JSON.stringify(r2.problems));
    const r3 = checkCitations("session.ts:1", path.join(root, "src", "auth"));
    check("...and the same citation passes under the right root", 0, r3.problems.length, JSON.stringify(r3.problems));
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-citations selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A citation is a claim about a file on disk. This is the only place in the\n");
  process.stdout.write("  package that decides whether the claim is true, so /spec and /investigate\n  cannot disagree about what counts as evidence.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const [cmd, target] = argv.filter((a) => !a.startsWith("--"));
  const ri = argv.indexOf("--root");
  const root = ri !== -1 && argv[ri + 1] ? path.resolve(argv[ri + 1]) : process.cwd();
  if (cmd === "selftest") selftest();
  else if (cmd === "check" && target) {
    let text = "";
    try {
      text = fs.readFileSync(target, "utf8");
    } catch (e) {
      process.stderr.write(`\n  ${target} could not be read (${e.code || e.message})\n\n`);
      process.exitCode = 2;
    }
    if (process.exitCode !== 2) {
      const r = checkCitations(text, root);
      process.stdout.write(`\n  ${r.cites.length} citation(s) checked against ${root}\n`);
      for (const p of r.problems) process.stdout.write(`    - ${p}\n`);
      process.stdout.write(r.problems.length ? "\n" : "  all of them resolve\n\n");
      if (r.problems.length) process.exitCode = 1;
    }
  } else {
    process.stdout.write("\n  usage: tb-citations.mjs check <file> [--root <dir>] | selftest\n\n");
    process.exitCode = 1;
  }
}
