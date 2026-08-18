#!/usr/bin/env node
/**
 * tb-ios-clean.mjs: the DebugBridge removal verifier behind /ios-clean.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (the /ios-clean command, the five removal targets
 * — the DebugBridge SPM dependency, the `#if DEBUG` wiring in the app's @main
 * entry, the `@Snapshotable` codegen markers, generated `StateAccessor.swift`
 * files, and the `gstack-ios-qa.token` file on the device — the Inventory /
 * Remove / Verify phase split, the confirm-before-each-removal rule, and the
 * "every edit is a git operation, `git restore` undoes it" reversibility
 * promise) comes from `ios-clean` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS CODE HERE AT ALL
 * ---------------------------------------------------------------------------
 *
 * gstack's ios-clean is prose. Its entire Phase 3 verification is four shell
 * lines (ios-clean/SKILL.md:864-867, SKILL.md.tmpl:93-96):
 *
 *     1. ! grep -r "DebugBridge" <app-source-dir>   (no matches).
 *     2. ! grep -r "@Snapshotable" <app-source-dir> (no matches).
 *     3. swift build -c release succeeds.
 *     4. nm -j on the built binary doesn't show DebugBridge symbols.
 *
 * Four checks, four ways to report a clean strip that never happened.
 *
 * 1. CHECKS 1 AND 2 FAIL OPEN. `grep -r` exits 2 when the path it was given
 *    does not exist, and the leading `!` inverts that into success. Measured on
 *    Windows 11, Git Bash 2.51.2, 2026-08-13:
 *
 *      $ if ! grep -r "DebugBridge" /c/Users/orion/no/such/dir; then \
 *          echo "GSTACK PHASE3 CHECK1 => PASS (no matches)"; fi
 *      grep: /c/Users/orion/no/such/dir: No such file or directory
 *      GSTACK PHASE3 CHECK1 => PASS (no matches)
 *
 *    A typo in the source directory, a relative path resolved from the wrong
 *    cwd, or a repo whose Swift lives one level deeper than assumed all print
 *    the same thing a genuinely clean app prints: nothing. `verify` here
 *    resolves the scope FIRST and refuses to render any verdict at all if it
 *    did not read real iOS source — a check that scanned nothing is not a check
 *    that passed.
 *
 * 2. THE SAME TWO CHECKS ALSO FAIL CLOSED, FOREVER. `grep -r "DebugBridge"`
 *    matches the string anywhere, including in the comment a careful developer
 *    leaves behind ("// DebugBridge wiring removed 2026-08-13, see PR #412").
 *    An app that is genuinely clean can never satisfy gstack's own exit
 *    condition, so the check gets ignored, which is worse than not having it.
 *    Here a match in code BLOCKS and a match in a comment is reported as a note
 *    that does not block, and the verdict says which is which.
 *
 * 3. CHECKS 3 AND 4 CANNOT RUN ON WINDOWS, AND THE SKILL HAS NO STATE FOR THAT.
 *    `swift` and `nm` are not on a Windows box and `xcodebuild` never will be.
 *    gstack's Phase 3 offers no third outcome between pass and fail, so the
 *    honest result — "the two checks that mattered could not execute here" —
 *    has nowhere to go, and the run reports on the strength of checks 1 and 2,
 *    which are the two that fail open. This tool has four exit codes: 0 CLEAN,
 *    1 RESIDUE, 2 UNVERIFIABLE, 3 SOURCE-CLEAN (static checks passed, the
 *    binary proof did not run here). 3 is non-zero on purpose, so
 *    `verify && ship` does not go green on half a verification, and turning it
 *    into a pass requires typing --accept-source-only.
 *
 * 4. NOTHING CHECKS THE EDIT THAT PHASE 2 ACTUALLY BOTCHES. Phase 2 says "strip
 *    the import + the `#if DEBUG` block (keep the surrounding code intact)".
 *    The failure mode of that edit is a `#if DEBUG` whose `#endif` went with the
 *    body, or an `#endif` whose `#if` did. Both leave ZERO occurrences of
 *    "DebugBridge" in the file, so gstack's checks 1 and 2 pass, and the only
 *    thing that would have caught it is check 3, the compiler, which is exactly
 *    the check that cannot run on Windows. `verify` here parses conditional
 *    compilation directives out of every Swift file (nesting, block comments,
 *    string literals, raw strings, CRLF, BOM) and reports an unbalanced file
 *    with the line number of the directive that was left dangling.
 *
 * 5. THE "SAFETY-CRITICAL PATH" IS NOT IN THE TEMPLATES. Both gstack skills say
 *    this one is only a convenience wrapper because the real guard is
 *    structural: "The app target depends on `DebugBridgeUI` with
 *    `.when(configuration: .debug)`" (ios-qa/SKILL.md.tmpl:117), restated at
 *    ios-clean/SKILL.md:806. Grep the templates that install it:
 *
 *      $ grep -n "when(configuration" ios-qa/templates/*.template
 *      Package.swift.template:14:// The structural Release-build guard is ...
 *      Package.swift.template:38:  .define("DEBUG", .when(configuration: .debug)),
 *      Package.swift.template:58:  .define("DEBUG", .when(configuration: .debug)),
 *
 *    Line 14 is the comment claiming the guard. Lines 38 and 58 are the only
 *    two uses, and both are `swiftSettings` on DebugBridge's OWN targets, which
 *    is a preprocessor define, not a dependency edge. No template anywhere
 *    attaches a configuration condition to a consuming app target's dependency.
 *    So the structural guard that makes this skill "just a convenience" is not
 *    installed by the skill that is supposed to install it. `verify` therefore
 *    treats source residue as load-bearing rather than cosmetic, and reports a
 *    surviving DebugBridge dependency that carries no debug-only condition as
 *    the highest-severity finding it has.
 *
 * ---------------------------------------------------------------------------
 * DESIGN RULES
 * ---------------------------------------------------------------------------
 *
 *   1. FAIL CLOSED. Every path that cannot reach a confident "this app is
 *      clean" ends in a non-zero exit naming the check that could not run.
 *      There is exactly one deliberate allow-on-absence, documented at
 *      readLedger(): no ledger file at all means the user never ran
 *      `inventory`, which is a missing baseline, not a broken one.
 *   2. NO INTERPRETER BUT NODE. No grep, no find, no shell. The same command
 *      produces the same verdict from Git Bash, PowerShell and cmd, on a path
 *      with spaces, against CRLF files with a BOM.
 *   3. EVIDENCE OR IT DID NOT HAPPEN. A build-proof record is honoured only if
 *      it carries the command that was run, its exit code, its captured output,
 *      and a timestamp newer than every source file it claims to cover. A
 *      ledger that says "passed" and shows nothing is treated as not run.
 *   4. PROVE IT. `selftest` builds deliberately broken app trees on disk and
 *      drives this file as a child process against them. Every case is a way a
 *      removal reports success without having removed anything.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

/**
 * The evidence ledger; shared reader/writer in src/ledger/tb-ledger.mjs.
 *
 * THE ONE DELIBERATE ALLOW-ON-ABSENCE IN THIS FILE. No ledger means the user
 * never ran `inventory`. Treating that as a failure would make `verify`
 * unusable as a standalone check, which is the main way it gets used ("is this
 * app clean?" on a repo nobody instrumented). A ledger that EXISTS and cannot
 * be parsed is the opposite case: something wrote it, and we have no idea what
 * it said, so every claim downstream of it is unfounded. That one fails closed,
 * which is what missingIsError: false buys and nothing more.
 */
const LEDGER_FILE = "ios-clean-ledger.json";
function ledgerPath() {
  return ledgerPathShared(stateDir(), LEDGER_FILE);
}
function readLedger() {
  const r = readLedgerShared(stateDir(), { file: LEDGER_FILE, missingIsError: false });
  if (r.error) return r;
  return { ledger: r.ledger, missing: Boolean(r.missing) };
}
function writeLedger(next) {
  writeLedgerShared(stateDir(), next, { file: LEDGER_FILE, atomic: false });
}


const SELF = fileURLToPath(import.meta.url);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

// Exit codes. These are the interface; the words are for humans.
const EXIT_CLEAN = 0;
const EXIT_RESIDUE = 1;
const EXIT_UNVERIFIABLE = 2;
const EXIT_SOURCE_CLEAN = 3;

const SOURCE_EXT = new Set([".swift", ".m", ".mm", ".h", ".hpp", ".pbxproj", ".plist", ".entitlements"]);
const IOS_SOURCE_EXT = new Set([".swift", ".m", ".mm"]);
const SKIP_DIRS = new Set([
  ".git", ".build", ".swiftpm", "DerivedData", "Pods", "Carthage",
  "node_modules", ".toolbay", ".gstack", "build", "dist", ".next",
]);
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// --------------------------------------------------------------------- state

function stateDir() {
  if (process.env.TOOLBAY_STACK_STATE_DIR) return process.env.TOOLBAY_STACK_STATE_DIR;
  return path.join(process.cwd(), ".toolbay", "ios-clean");
}

// ---------------------------------------------------------------- scope

/**
 * Resolve what is about to be checked, and refuse to continue if the answer is
 * "nothing". This is the whole fix for gstack Phase 3 checks 1 and 2: the
 * verdict is not allowed to exist until real iOS source has been read.
 */
function resolveScope(appArg) {
  if (!appArg || typeof appArg !== "string" || !appArg.trim()) {
    return { error: "--app <dir> was not given, so there is no source directory to check. Refusing to report on an unnamed scope." };
  }
  const dir = path.resolve(appArg);
  const parsedRoot = path.parse(dir).root;
  if (dir === parsedRoot) {
    return { error: `--app resolved to the filesystem root (${dir}). Refusing: that is not an app source directory.` };
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    return {
      error:
        `--app ${appArg} resolved to ${dir}, which could not be read (${e.code || e.message}).\n` +
        `    gstack's "! grep -r ... <app-source-dir>" reports PASS for exactly this input, because grep exits 2 and the leading ! inverts it.`,
    };
  }
  if (!st.isDirectory()) {
    return { error: `--app ${appArg} resolved to ${dir}, which is a file, not a directory. A file is not an app source tree.` };
  }

  const files = [];
  const problems = [];
  const seenReal = new Set();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let real;
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
    } catch {
      real = cur;
    }
    if (seenReal.has(real)) continue; // junctions and symlink loops on win32
    seenReal.add(real);
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      problems.push(`${cur} could not be listed (${e.code || e.message}), so anything inside it is invisible to this check`);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.endsWith(".xcworkspace")) continue;
        if (ent.isSymbolicLink()) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!SOURCE_EXT.has(ext)) continue;
      if (files.length >= MAX_FILES) {
        problems.push(`more than ${MAX_FILES} source files under ${dir}; the scope is too broad to verify honestly`);
        break;
      }
      files.push(full);
    }
  }

  if (problems.length) {
    return { error: `the scope could not be read completely:\n    - ${problems.join("\n    - ")}` };
  }
  const iosFiles = files.filter((f) => IOS_SOURCE_EXT.has(path.extname(f).toLowerCase()));
  if (iosFiles.length === 0) {
    return {
      error:
        `no .swift, .m or .mm files were found under ${dir}.\n` +
        `    A check that scanned nothing is not a check that passed. Point --app at the app's source directory.`,
    };
  }
  return { dir, files, iosFiles };
}

// ------------------------------------------------------------- reading files

function readSource(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { error: `${file} could not be read (${e.code || e.message})` };
  }
  if (buf.length > MAX_FILE_BYTES) return { error: `${file} is larger than ${MAX_FILE_BYTES} bytes; refusing to guess at its contents` };
  if (buf.includes(0)) return { binary: true, text: "" };
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM, common on files touched on Windows
  return { text };
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ------------------------------------------------------------------ the lexer

/**
 * A Swift lexer small enough to trust and big enough to be right about the four
 * things that decide whether a `#endif` is real:
 *
 *   - line comments and NESTING block comments (Swift's slash-star comments nest)
 *   - string literals, including """multiline""" ones
 *   - raw strings (#"..."#, ##"""..."""##), where a leading # is not a directive
 *   - CRLF and a leading BOM, because this has to be right on Windows
 *
 * Returns the directive sequence with line numbers, the balance errors, and the
 * comment ranges, which the residue scan uses to tell a live reference apart
 * from a note somebody left behind.
 */
function lexSwift(text) {
  const directives = [];
  const errors = [];
  const commentRanges = [];
  const stack = [];
  let i = 0;
  let line = 1;
  let atLineStart = true;

  const skipString = (quoteIdx, pounds) => {
    // quoteIdx points at the first `"`.
    const multiline = text.startsWith('"""', quoteIdx);
    const close = multiline ? '"""' : '"';
    let j = quoteIdx + close.length;
    const closeDelim = close + "#".repeat(pounds);
    while (j < text.length) {
      if (text[j] === "\\") {
        // In a raw string the escape is \ followed by `pounds` #s. Anything
        // else is a literal backslash.
        const escaped = pounds === 0 ? true : text.startsWith("#".repeat(pounds), j + 1);
        if (escaped) {
          const skip = pounds === 0 ? 2 : 2 + pounds;
          for (let k = j; k < Math.min(j + skip, text.length); k++) if (text[k] === "\n") line++;
          j += skip;
          continue;
        }
      }
      if (text.startsWith(closeDelim, j)) return j + closeDelim.length;
      if (text[j] === "\n") {
        line++;
        if (!multiline && pounds === 0) return j; // an unterminated single-line string ends at EOL
      }
      j++;
    }
    return text.length;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      line++;
      i++;
      atLineStart = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue; // whitespace preserves "still at the start of the line"
    }
    if (ch === "/" && text[i + 1] === "/") {
      const start = i;
      while (i < text.length && text[i] !== "\n") i++;
      commentRanges.push([start, i]);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (text[i] === "\n") line++;
          i++;
        }
      }
      commentRanges.push([start, i]);
      atLineStart = false;
      continue;
    }
    if (ch === "#") {
      let j = i;
      let pounds = 0;
      while (text[j] === "#") {
        pounds++;
        j++;
      }
      if (text[j] === '"') {
        i = skipString(j, pounds);
        atLineStart = false;
        continue;
      }
      if (atLineStart && pounds === 1) {
        const m = /^#(if|elseif|else|endif)(?![A-Za-z0-9_])/.exec(text.slice(i, i + 12));
        if (m) {
          const kind = m[1];
          directives.push({ kind, line });
          if (kind === "if") stack.push(line);
          else if (kind === "endif") {
            if (!stack.length) {
              errors.push({ line, kind: "endif", message: `#endif at line ${line} closes nothing; its #if is gone` });
            } else stack.pop();
          } else if (!stack.length) {
            errors.push({ line, kind, message: `#${kind} at line ${line} has no open #if above it` });
          }
          i += m[0].length;
          atLineStart = false;
          continue;
        }
      }
      i = j;
      atLineStart = false;
      continue;
    }
    if (ch === '"') {
      i = skipString(i, 0);
      atLineStart = false;
      continue;
    }
    i++;
    atLineStart = false;
  }

  for (const openLine of stack) {
    errors.push({ line: openLine, kind: "if", message: `#if opened at line ${openLine} is never closed; its #endif went with the removed block` });
  }
  errors.sort((a, b) => a.line - b.line);
  return { directives, errors, commentRanges, balanced: errors.length === 0 };
}

function inRanges(ranges, offset) {
  for (const [a, b] of ranges) if (offset >= a && offset < b) return true;
  return false;
}

// ------------------------------------------------------------ residue patterns

const RESIDUE = [
  { id: "import", re: /\bimport\s+DebugBridge[A-Za-z0-9_]*/g, what: "DebugBridge import" },
  { id: "manager", re: /\bDebugBridgeManager\b/g, what: "DebugBridgeManager reference" },
  { id: "wiring", re: /\bstartGstackDebugBridge\b/g, what: "the @main wiring function" },
  { id: "snapshotable", re: /@Snapshotable\b/g, what: "@Snapshotable codegen marker" },
  { id: "stateserver", re: /\bStateServer\s*\.\s*shared\b/g, what: "StateServer reference" },
  { id: "overlay", re: /\bDebugOverlay\b/g, what: "DebugOverlay reference" },
  { id: "resolver", re: /\b(?:Elements|Screenshot|Mutation)Bridge\s*\.\s*resolver\b/g, what: "bridge resolver assignment" },
  { id: "token", re: /gstack-ios-qa\.token/g, what: "the on-device token path" },
  { id: "recflag", re: /--gstack-recording/g, what: "the recording launch flag" },
  { id: "debugbridge", re: /\bDebugBridge[A-Za-z0-9_]*\b/g, what: "DebugBridge reference" },
];

// The header gstack's codegen stamps into every generated accessor. Matching on
// the header rather than the filename catches the copy somebody renamed, which
// gstack's "delete generated StateAccessor.swift files" instruction walks past.
const GENERATED_ACCESSOR = /Auto-generated state accessor|Regenerated by `swift run gen-accessors`|gstack\/ios-qa\/templates\/StateAccessor\.swift\.template/;

function scanFile(file, relTo) {
  const rel = path.relative(relTo, file) || path.basename(file);
  const r = readSource(file);
  if (r.error) return { rel, error: r.error };
  if (r.binary) return { rel, skipped: "binary" };
  const text = r.text;
  const lex = lexSwift(text);
  const starts = lineIndex(text);
  const ext = path.extname(file).toLowerCase();

  const hits = [];
  const notes = [];
  const seen = new Set();
  for (const pat of RESIDUE) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(text))) {
      const line = lineOf(starts, m.index);
      // Two keys, because the catch-all pattern re-finds what the specific ones
      // already found (offset key), and a single line can carry the same kind of
      // reference twice (`.product(name: "DebugBridgeUI", package: "DebugBridge")`),
      // which is one finding to fix, not two to count.
      const key = `${line}:${m.index}`;
      const dupe = `${line}:${pat.what}`;
      if (seen.has(key) || seen.has(dupe)) continue;
      seen.add(key);
      seen.add(dupe);
      const rec = { rel, line, what: pat.what, id: pat.id, text: text.slice(starts[line - 1], starts[line] ?? text.length).replace(/\r?\n$/, "").trim().slice(0, 120) };
      if (inRanges(lex.commentRanges, m.index)) notes.push(rec);
      else hits.push(rec);
    }
  }

  const generated = GENERATED_ACCESSOR.test(text)
    ? { rel, line: lineOf(starts, text.search(GENERATED_ACCESSOR)), what: "generated StateAccessor output" }
    : null;

  // Directive balance only means anything for files the Swift compiler reads.
  const balanceRelevant = ext === ".swift" || ext === ".m" || ext === ".mm" || ext === ".h";
  return {
    rel,
    file,
    hits,
    notes,
    generated,
    balanced: balanceRelevant ? lex.balanced : true,
    balanceErrors: balanceRelevant ? lex.errors : [],
    directiveCount: lex.directives.length,
  };
}

// ----------------------------------------------------------- Package.swift

/**
 * SwiftPM manifests are Swift, not data, so this reads them the way a reviewer
 * does: find the dependency declarations, find the product references, and
 * report the ones that no longer point at anything.
 *
 * The finding that matters is `.product(name:package:)` naming a package whose
 * `.package(...)` line was deleted. On macOS that is a build error. On Windows
 * nothing catches it at all, which is where every removal in this stack gets
 * done.
 */
function scanPackageManifest(file) {
  const r = readSource(file);
  if (r.error) return { error: r.error };
  const text = r.text;
  const starts = lineIndex(text);
  const lex = lexSwift(text);
  const code = (idx) => !inRanges(lex.commentRanges, idx);

  const declared = new Map(); // lowercased identity -> {identity, line, raw}
  const declRe = /\.package\s*\(/g;
  let m;
  while ((m = declRe.exec(text))) {
    if (!code(m.index)) continue;
    const entry = balancedSlice(text, m.index + m[0].length - 1);
    if (!entry) continue;
    const inner = entry.body;
    const line = lineOf(starts, m.index);
    let identity = null;
    const nameM = /\bname\s*:\s*"([^"]+)"/.exec(inner);
    const urlM = /\b(?:url|path)\s*:\s*"([^"]+)"/.exec(inner);
    if (nameM) identity = nameM[1];
    else if (urlM) identity = urlM[1].replace(/\.git$/, "").replace(/\/+$/, "").split(/[\\/]/).pop();
    if (identity) declared.set(identity.toLowerCase(), { identity, line, raw: inner });
  }

  const refs = [];
  const prodRe = /\.product\s*\(/g;
  while ((m = prodRe.exec(text))) {
    if (!code(m.index)) continue;
    const entry = balancedSlice(text, m.index + m[0].length - 1);
    if (!entry) continue;
    const inner = entry.body;
    const nameM = /\bname\s*:\s*"([^"]+)"/.exec(inner);
    const pkgM = /\bpackage\s*:\s*"([^"]+)"/.exec(inner);
    if (!nameM || !pkgM) continue;
    refs.push({
      product: nameM[1],
      pkg: pkgM[1],
      line: lineOf(starts, m.index),
      guarded: /\.when\s*\(\s*configuration\s*:\s*\.debug\s*\)/.test(inner),
      raw: inner,
    });
  }

  const orphans = refs.filter((ref) => !declared.has(ref.pkg.toLowerCase()));
  const debugDeclared = [...declared.values()].filter((d) => /debugbridge/i.test(d.identity) || /debugbridge/i.test(d.raw));
  const debugRefs = refs.filter((ref) => /debugbridge/i.test(ref.product) || /debugbridge/i.test(ref.pkg));
  const unguarded = debugRefs.filter((ref) => !ref.guarded);

  return { file, declared: [...declared.values()], refs, orphans, debugDeclared, debugRefs, unguarded, balanced: lex.balanced, balanceErrors: lex.errors };
}

/** Slice a parenthesised call body starting at the index of its `(`. */
function balancedSlice(text, openIdx) {
  if (text[openIdx] !== "(") return null;
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

// ------------------------------------------------------------- the toolchain

function probeTool(name, args) {
  const res = spawnSync(name, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 20000 });
  if (res.error) return { name, present: false, why: res.error.code || res.error.message };
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim();
  return { name, present: res.status === 0 || Boolean(output), status: res.status, output: output.split(/\r?\n/)[0] || "" };
}

function toolchain() {
  return {
    platform: process.platform,
    swift: probeTool("swift", ["--version"]),
    xcodebuild: probeTool("xcodebuild", ["-version"]),
    nm: probeTool("nm", ["--version"]),
  };
}

// -------------------------------------------------------------- the commands

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function findManifests(files) {
  return files.filter((f) => path.basename(f) === "Package.swift");
}

function collect(scope) {
  const results = [];
  for (const f of scope.files) results.push(scanFile(f, scope.dir));
  const readErrors = results.filter((r) => r.error);
  return { results, readErrors };
}

function cmdInventory(flags) {
  const scope = resolveScope(flags.app);
  if (scope.error) return fail(scope.error);
  const { results, readErrors } = collect(scope);
  if (readErrors.length) return fail(`some files in scope could not be read, so the inventory would be incomplete:\n    - ${readErrors.map((r) => r.error).join("\n    - ")}`);

  const hits = results.flatMap((r) => r.hits || []);
  const notes = results.flatMap((r) => r.notes || []);
  const generated = results.filter((r) => r.generated).map((r) => r.generated);
  const unbalancedBefore = results.filter((r) => r.balanced === false).map((r) => ({ rel: r.rel, errors: r.balanceErrors }));
  const manifests = findManifests(scope.files).map(scanPackageManifest);

  const baseline = {};
  for (const r of results) if (r.file) baseline[r.rel] = { balanced: r.balanced, directives: r.directiveCount, mtimeMs: safeMtime(r.file) };

  const prev = readLedger();
  if (prev.error) return fail(prev.error);
  const ledger = prev.ledger || {};
  ledger.inventory = {
    app: scope.dir,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    fileCount: scope.files.length,
    iosFileCount: scope.iosFiles.length,
    residue: hits.length,
    comments: notes.length,
    generated: generated.length,
    unbalancedBefore,
    baseline,
  };
  writeLedger(ledger);

  out();
  out(`  ${bold("tb-ios-clean inventory")}  ${dim(`${scope.iosFiles.length} iOS source files under ${scope.dir}`)}`);
  out();
  if (!hits.length && !generated.length && !manifests.some((mf) => mf.debugDeclared?.length)) {
    out(`  ${green("nothing to remove")}  no DebugBridge wiring, no @Snapshotable markers, no generated accessors.`);
  }
  printFindings(hits, generated, notes, manifests, unbalancedBefore);
  out();
  out(`  ${dim(`baseline written to ${ledgerPath()}`)}`);
  out(`  ${dim("verify will compare against it, so a file this run found already unbalanced")}`);
  out(`  ${dim("is not later reported as damage the removal caused.")}`);
  out();
  out(`  Next: remove what you approved, then`);
  out(`    ${cyan(`node ${path.basename(SELF)} verify --app "${scope.dir}"`)}`);
  out();
  return EXIT_CLEAN;
}

function safeMtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

function printFindings(hits, generated, notes, manifests, unbalanced) {
  if (hits.length) {
    out(`  ${red("residue in code")}  ${hits.length}`);
    for (const h of hits.slice(0, 40)) out(`    ${h.rel}:${h.line}  ${dim(h.what)}  ${h.text}`);
    if (hits.length > 40) out(`    ${dim(`... and ${hits.length - 40} more`)}`);
    out();
  }
  if (generated.length) {
    out(`  ${red("generated accessor files")}  ${generated.length}`);
    for (const g of generated) out(`    ${g.rel}:${g.line}  ${dim(g.what)}`);
    out();
  }
  for (const mf of manifests) {
    if (mf.error) continue;
    if (mf.unguarded?.length) {
      out(`  ${red("DebugBridge dependency with no debug-only condition")}  ${mf.unguarded.length}`);
      for (const u of mf.unguarded) out(`    ${path.basename(mf.file)}:${u.line}  .product(name: "${u.product}", package: "${u.pkg}")  ${dim("links in Release")}`);
      out();
    }
    if (mf.debugDeclared?.length) {
      out(`  ${yellow("DebugBridge package still declared")}  ${mf.debugDeclared.length}`);
      for (const d of mf.debugDeclared) out(`    ${path.basename(mf.file)}:${d.line}  ${d.identity}`);
      out();
    }
    if (mf.orphans?.length) {
      out(`  ${red("product references with no package declaring them")}  ${mf.orphans.length}`);
      for (const o of mf.orphans) out(`    ${path.basename(mf.file)}:${o.line}  .product(name: "${o.product}", package: "${o.pkg}")  ${dim("the .package() line is gone")}`);
      out();
    }
  }
  if (unbalanced.length) {
    out(`  ${red("unbalanced conditional compilation")}  ${unbalanced.length} file(s)`);
    for (const u of unbalanced) for (const e of u.errors) out(`    ${u.rel}:${e.line}  ${e.message}`);
    out();
  }
  if (notes.length) {
    out(`  ${dim(`mentions in comments (not residue, does not block): ${notes.length}`)}`);
    for (const n of notes.slice(0, 8)) out(`    ${dim(`${n.rel}:${n.line}  ${n.text}`)}`);
    out();
  }
}

function cmdVerify(flags) {
  const scope = resolveScope(flags.app);
  if (scope.error) return fail(scope.error);

  const prev = readLedger();
  if (prev.error) return fail(prev.error);
  const ledger = prev.ledger || {};

  const { results, readErrors } = collect(scope);
  if (readErrors.length) return fail(`some files in scope could not be read, so no verdict is possible:\n    - ${readErrors.map((r) => r.error).join("\n    - ")}`);

  const hits = results.flatMap((r) => r.hits || []);
  const notes = results.flatMap((r) => r.notes || []);
  const generated = results.filter((r) => r.generated).map((r) => r.generated);
  const manifests = findManifests(scope.files).map(scanPackageManifest);
  const manifestErr = manifests.find((mf) => mf.error);
  if (manifestErr) return fail(`Package.swift could not be read (${manifestErr.error}), so its dependency state is unknown.`);

  const priorUnbalanced = new Set((ledger.inventory?.unbalancedBefore || []).map((u) => u.rel));
  const unbalancedAll = results.filter((r) => r.balanced === false);
  const unbalancedNew = unbalancedAll.filter((r) => !priorUnbalanced.has(r.rel));
  const unbalancedPre = unbalancedAll.filter((r) => priorUnbalanced.has(r.rel));

  const orphans = manifests.flatMap((mf) => mf.orphans || []);
  const debugDeclared = manifests.flatMap((mf) => mf.debugDeclared || []);
  const unguarded = manifests.flatMap((mf) => mf.unguarded || []);
  const manifestUnbalanced = manifests.filter((mf) => mf.balanced === false);

  const blocking =
    hits.length + generated.length + unbalancedAll.length + orphans.length + debugDeclared.length + unguarded.length + manifestUnbalanced.length;

  const proof = evaluateBuildProof(ledger, scope);

  out();
  out(`  ${bold("tb-ios-clean verify")}  ${dim(`${scope.iosFiles.length} iOS source files, node ${process.version}, ${process.platform}`)}`);
  out(`  ${dim(scope.dir)}`);
  out();

  printFindings(
    hits,
    generated,
    notes,
    manifests,
    unbalancedNew.map((r) => ({ rel: r.rel, errors: r.balanceErrors })),
  );
  if (unbalancedPre.length) {
    out(`  ${yellow("unbalanced before this removal started")}  ${unbalancedPre.length} file(s)`);
    out(`  ${dim("recorded by inventory, so this is pre-existing, not damage from the strip")}`);
    for (const u of unbalancedPre) for (const e of u.balanceErrors) out(`    ${u.rel}:${e.line}  ${e.message}`);
    out();
  }

  out(`  ${bold("checks")}`);
  line("source residue (code)", hits.length === 0, `${hits.length} reference(s)`);
  line("generated accessors", generated.length === 0, `${generated.length} file(s)`);
  line("conditional compilation balanced", unbalancedAll.length === 0, `${unbalancedAll.length} file(s) unbalanced`);
  line("Package.swift dependency removed", debugDeclared.length === 0 && unguarded.length === 0, `${debugDeclared.length} declared, ${unguarded.length} unguarded`);
  line("Package.swift references resolve", orphans.length === 0, `${orphans.length} orphan product reference(s)`);
  line("release binary carries no DebugBridge", proof.ok, proof.detail);
  out();

  if (blocking > 0) {
    out(`  ${red("RESIDUE")}  ${blocking} finding(s). The strip is not complete.`);
    out(`  ${dim("Each line above is a file and a line number. gstack's `! grep -r` reports none of the")}`);
    out(`  ${dim("balance, orphan or Release-guard findings at all, and reports PASS if the path is wrong.")}`);
    out();
    return EXIT_RESIDUE;
  }

  if (proof.ok) {
    out(`  ${green("CLEAN")}  every static check passed and the release binary was inspected.`);
    out();
    return EXIT_CLEAN;
  }

  out(`  ${yellow("SOURCE-CLEAN")}  every check that can run here passed. The binary proof did not run.`);
  out(`  ${dim(`  reason: ${proof.detail}`)}`);
  out(`  ${dim("  This exits 3, not 0, on purpose: a verification missing its last step is not a pass.")}`);
  if (flags["accept-source-only"]) {
    out();
    out(`  ${green("ACCEPTED")}  --accept-source-only was passed, so this exits 0.`);
    out(`  ${dim("  Run the binary proof on a macOS box or in CI before the release goes out:")}`);
    out(`  ${dim(`    node ${path.basename(SELF)} build-proof --app "${scope.dir}" --binary <path-to-built-binary>`)}`);
    out();
    return EXIT_CLEAN;
  }
  out();
  out(`  ${dim("  Either run it:")}`);
  out(`  ${dim(`    node ${path.basename(SELF)} build-proof --app "${scope.dir}" --binary <path-to-built-binary>`)}`);
  out(`  ${dim("  or accept the gap explicitly:")}`);
  out(`  ${dim(`    node ${path.basename(SELF)} verify --app "${scope.dir}" --accept-source-only`)}`);
  out();
  return EXIT_SOURCE_CLEAN;
}

function line(name, ok, detail) {
  const tag = ok ? green("ok  ") : red("FAIL");
  out(`  ${tag}  ${name.padEnd(42)}  ${dim(detail)}`);
}

/**
 * A build-proof record is believed only if it shows its work.
 *
 * gstack's Phase 3 steps 3 and 4 are two sentences an agent reports having
 * satisfied. Here the ledger has to carry the command, the exit code, captured
 * output, and a timestamp later than every source file it covers. Anything less
 * is treated as not run, which is the difference between evidence and a claim.
 */
function evaluateBuildProof(ledger, scope) {
  const rec = ledger.buildProof;
  if (!rec) return { ok: false, detail: "no build-proof record; run build-proof, or accept the gap" };
  if (rec.status !== "passed") return { ok: false, detail: `last build-proof recorded "${rec.status || "unknown"}"` };
  if (path.resolve(rec.app || "") !== scope.dir) return { ok: false, detail: `the recorded proof covers ${rec.app || "an unnamed app"}, not this scope` };
  if (!rec.command || typeof rec.command !== "string") return { ok: false, detail: "the recorded proof names no command, so it is a claim, not evidence" };
  if (typeof rec.exitCode !== "number") return { ok: false, detail: "the recorded proof has no exit code" };
  if (!rec.output || !String(rec.output).trim()) return { ok: false, detail: "the recorded proof captured no output, so nothing backs it" };
  const at = Date.parse(rec.recordedAt || "");
  if (!Number.isFinite(at)) return { ok: false, detail: "the recorded proof has no usable timestamp" };
  let newest = 0;
  for (const f of scope.iosFiles) newest = Math.max(newest, safeMtime(f));
  if (newest > at) return { ok: false, detail: "source changed after the proof was recorded, so the proof is stale" };
  return { ok: true, detail: `${rec.command} exit ${rec.exitCode}, recorded ${rec.recordedAt}` };
}

function cmdBuildProof(flags) {
  const scope = resolveScope(flags.app);
  if (scope.error) return fail(scope.error);
  const tc = toolchain();
  const prev = readLedger();
  if (prev.error) return fail(prev.error);
  const ledger = prev.ledger || {};

  out();
  out(`  ${bold("tb-ios-clean build-proof")}  ${dim(`${process.platform}`)}`);
  out();

  if (!tc.swift.present) {
    ledger.buildProof = {
      app: scope.dir,
      status: "unavailable",
      platform: process.platform,
      recordedAt: new Date().toISOString(),
      probe: `swift --version -> ${tc.swift.why || tc.swift.status}`,
    };
    writeLedger(ledger);
    out(`  ${yellow("UNAVAILABLE")}  swift is not on PATH here (${tc.swift.why || `exit ${tc.swift.status}`}).`);
    out(`  ${dim("  Recorded as unavailable. It is never recorded as passed, because a compiler that")}`);
    out(`  ${dim("  did not run cannot have found anything.")}`);
    out(`  ${dim("  Run this step on macOS, or in CI, and commit the ledger.")}`);
    out();
    return EXIT_SOURCE_CLEAN;
  }

  const pkgDir = flags["package-dir"] ? path.resolve(flags["package-dir"]) : scope.dir;
  const args = ["build", "-c", "release"];
  const res = spawnSync("swift", args, { cwd: pkgDir, encoding: "utf8", windowsHide: true, timeout: 30 * 60 * 1000 });
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim();
  const command = `swift ${args.join(" ")}  (cwd ${pkgDir})`;
  if (res.status !== 0) {
    ledger.buildProof = { app: scope.dir, status: "failed", command, exitCode: res.status, output: output.slice(-8000), recordedAt: new Date().toISOString() };
    writeLedger(ledger);
    out(`  ${red("FAILED")}  ${command} exited ${res.status}`);
    out(output.split(/\r?\n/).slice(-20).map((l) => `    ${l}`).join("\n"));
    out();
    return EXIT_RESIDUE;
  }

  let symbolOutput = "";
  let symbolCommand = null;
  if (flags.binary) {
    if (!tc.nm.present) {
      ledger.buildProof = { app: scope.dir, status: "unavailable", command, exitCode: res.status, output: output.slice(-4000), recordedAt: new Date().toISOString(), probe: "nm is not on PATH" };
      writeLedger(ledger);
      out(`  ${yellow("UNAVAILABLE")}  the release build succeeded but nm is not on PATH, so the binary was never inspected.`);
      out();
      return EXIT_SOURCE_CLEAN;
    }
    const bin = path.resolve(flags.binary);
    const nmRes = spawnSync("nm", ["-j", bin], { encoding: "utf8", windowsHide: true, timeout: 5 * 60 * 1000 });
    symbolCommand = `nm -j ${bin}`;
    symbolOutput = `${nmRes.stdout || ""}${nmRes.stderr || ""}`;
    if (nmRes.status !== 0) {
      ledger.buildProof = { app: scope.dir, status: "failed", command: symbolCommand, exitCode: nmRes.status, output: symbolOutput.slice(-4000), recordedAt: new Date().toISOString() };
      writeLedger(ledger);
      out(`  ${red("FAILED")}  ${symbolCommand} exited ${nmRes.status}; the binary could not be inspected.`);
      out();
      return EXIT_RESIDUE;
    }
    const bad = symbolOutput.split(/\r?\n/).filter((l) => /DebugBridge/i.test(l));
    if (bad.length) {
      ledger.buildProof = { app: scope.dir, status: "failed", command: symbolCommand, exitCode: 0, output: bad.slice(0, 50).join("\n"), recordedAt: new Date().toISOString() };
      writeLedger(ledger);
      out(`  ${red("FAILED")}  the release binary still exports ${bad.length} DebugBridge symbol(s):`);
      for (const b of bad.slice(0, 15)) out(`    ${b}`);
      out();
      return EXIT_RESIDUE;
    }
  } else {
    out(`  ${yellow("note")}  no --binary given, so only the release build was proven, not the symbol table.`);
  }

  ledger.buildProof = {
    app: scope.dir,
    status: symbolCommand ? "passed" : "unavailable",
    command: symbolCommand || command,
    exitCode: 0,
    output: (symbolCommand ? `${symbolOutput.split(/\r?\n/).length} symbols inspected, none matching DebugBridge\n` : "") + output.slice(-4000),
    recordedAt: new Date().toISOString(),
    probe: symbolCommand ? undefined : "release build passed but no binary was inspected",
  };
  writeLedger(ledger);
  if (!symbolCommand) {
    out(`  ${yellow("PARTIAL")}  release build passed. Pass --binary to inspect the symbol table.`);
    out();
    return EXIT_SOURCE_CLEAN;
  }
  out(`  ${green("PASSED")}  release build succeeded and no DebugBridge symbol is in the binary.`);
  out();
  return EXIT_CLEAN;
}

function cmdDoctor() {
  const tc = toolchain();
  out();
  out(`  ${bold("tb-ios-clean doctor")}  ${dim(`node ${process.version}, ${process.platform} ${process.arch}`)}`);
  out();
  out(`  ${bold("what can be proven here")}`);
  line("source residue scan", true, "pure node, works everywhere");
  line("conditional compilation balance", true, "pure node, works everywhere");
  line("Package.swift dependency analysis", true, "pure node, works everywhere");
  line("swift build -c release", tc.swift.present, tc.swift.present ? tc.swift.output : `swift not on PATH (${tc.swift.why || tc.swift.status})`);
  line("nm -j symbol inspection", tc.nm.present, tc.nm.present ? tc.nm.output : `nm not on PATH (${tc.nm.why || tc.nm.status})`);
  line("xcodebuild Release install", tc.xcodebuild.present, tc.xcodebuild.present ? tc.xcodebuild.output : `xcodebuild not on PATH (${tc.xcodebuild.why || tc.xcodebuild.status})`);
  out();
  if (!tc.swift.present) {
    out(`  ${yellow("On this machine the binary proof cannot run.")}`);
    out(`  ${dim("  That is a fact about the platform, not a failure. What matters is that it is")}`);
    out(`  ${dim("  reported: verify exits 3 (SOURCE-CLEAN) rather than 0, so nothing downstream")}`);
    out(`  ${dim("  reads a half-finished verification as a pass.")}`);
    out();
  }
  out(`  ${dim(`ledger: ${ledgerPath()}`)}`);
  const l = readLedger();
  if (l.error) {
    out(`  ${red("ledger unreadable")}  ${l.error}`);
    out();
    return EXIT_UNVERIFIABLE;
  }
  out(`  ${dim(l.missing ? "  (none yet; run inventory)" : `  inventory ${l.ledger.inventory?.recordedAt || "none"}, buildProof ${l.ledger.buildProof?.status || "none"}`)}`);
  out();
  return EXIT_CLEAN;
}

function fail(message) {
  out();
  out(`  ${red("UNVERIFIABLE")}  ${message}`);
  out();
  out(`  ${dim("Nothing is reported clean on the strength of a check that did not run.")}`);
  out();
  return EXIT_UNVERIFIABLE;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    windowsHide: true,
    timeout: 120000,
  });
  return { status: res.status, stdout: `${res.stdout || ""}${res.stderr || ""}` };
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}
function writeRaw(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

const CLEAN_APP = `import SwiftUI

@main
struct MyApp: App {
    @State private var appState = MyAppState()
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
`;

const CLEAN_PACKAGE = `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MyApp",
    dependencies: [
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.0.0"),
    ],
    targets: [
        .target(name: "MyApp", dependencies: [
            .product(name: "Collections", package: "swift-collections"),
        ]),
    ]
)
`;

function makeApp(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    if (Buffer.isBuffer(body)) writeRaw(path.join(root, rel), body);
    else write(path.join(root, rel), body);
  }
  return root;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ios-clean-selftest-"));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  const env = { TOOLBAY_STACK_STATE_DIR: state };
  const app = (name, files) => makeApp(path.join(tmp, name), files);
  const results = [];
  const check = (name, expected, got, detail = "") => results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // ---- scope: the gstack `! grep -r` fail-open, four ways
  check(
    "a source dir that does not exist is UNVERIFIABLE (gstack reports PASS)",
    EXIT_UNVERIFIABLE,
    runSelf(["verify", "--app", path.join(tmp, "no-such-dir")], env).status,
  );
  const filePath = path.join(tmp, "notadir.swift");
  write(filePath, CLEAN_APP);
  check("a file passed as --app is UNVERIFIABLE", EXIT_UNVERIFIABLE, runSelf(["verify", "--app", filePath], env).status);
  check("an empty directory is UNVERIFIABLE, not clean", EXIT_UNVERIFIABLE, runSelf(["verify", "--app", app("empty", {})], env).status);
  check(
    "a directory with no iOS source is UNVERIFIABLE, not clean",
    EXIT_UNVERIFIABLE,
    runSelf(["verify", "--app", app("nosource", { "README.md": "# hi", "app.js": "console.log(1)" })], env).status,
  );
  check("--app omitted entirely is UNVERIFIABLE", EXIT_UNVERIFIABLE, runSelf(["verify"], env).status);
  check(
    "--app pointing at the filesystem root is refused",
    EXIT_UNVERIFIABLE,
    runSelf(["verify", "--app", path.parse(process.cwd()).root], env).status,
  );

  // ---- the happy path, and what it exits
  const clean = app("clean", { "Sources/App.swift": CLEAN_APP, "Package.swift": CLEAN_PACKAGE });
  const cleanRun = runSelf(["verify", "--app", clean], env);
  check("a genuinely clean app is SOURCE-CLEAN, not CLEAN, with no binary proof", EXIT_SOURCE_CLEAN, cleanRun.status, cleanRun.stdout.slice(-200));
  check("SOURCE-CLEAN says which step did not run", true, /binary proof did not run/i.test(cleanRun.stdout));
  check(
    "--accept-source-only turns SOURCE-CLEAN into a pass",
    EXIT_CLEAN,
    runSelf(["verify", "--app", clean, "--accept-source-only"], env).status,
  );

  // ---- residue in code
  check(
    "a surviving `import DebugBridge` is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("res-import", { "Sources/App.swift": `import DebugBridge\n${CLEAN_APP}` })], env).status,
  );
  check(
    "a surviving DebugBridgeManager.shared.start() is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("res-mgr", { "Sources/App.swift": `${CLEAN_APP}\n#if DEBUG\nDebugBridgeManager.shared.start(appState: s)\n#endif\n` })], env).status,
  );
  check(
    "a surviving @Snapshotable marker is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("res-snap", { "Sources/State.swift": "class S {\n  @Snapshotable var count = 0\n}\n" })], env).status,
  );
  check(
    "a surviving on-device token path is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("res-token", { "Sources/App.swift": `${CLEAN_APP}\nlet p = "gstack-ios-qa.token"\n` })], env).status,
  );
  check(
    "a generated StateAccessor.swift is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("res-gen", { "Sources/StateAccessor.swift": "// Auto-generated state accessor\n#if DEBUG\nlet x = 1\n#endif\n" })], env).status,
  );
  const renamed = runSelf(
    ["verify", "--app", app("res-renamed", { "Sources/AppStateAccessors.swift": "// Regenerated by `swift run gen-accessors`. DO NOT EDIT.\n#if DEBUG\nlet x = 1\n#endif\n" })],
    env,
  );
  check("a RENAMED generated accessor is still RESIDUE (gstack matches the filename)", EXIT_RESIDUE, renamed.status);

  // ---- residue in a comment must NOT block (gstack's grep blocks forever)
  const commented = runSelf(
    ["verify", "--app", app("comment-only", { "Sources/App.swift": `// DebugBridge wiring removed 2026-08-13, see PR #412\n${CLEAN_APP}` })],
    env,
  );
  check("a DebugBridge mention in a comment does NOT block (gstack's grep does)", EXIT_SOURCE_CLEAN, commented.status, commented.stdout.slice(-200));
  check("...but it is still reported as a note", true, /mentions in comments/i.test(commented.stdout));

  // ---- Windows encodings: the residue must still be found
  check(
    "residue in a CRLF file is found",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("crlf-res", { "Sources/App.swift": "import DebugBridge\r\nstruct A {}\r\n" })], env).status,
  );
  check(
    "residue in a UTF-8 BOM file is found",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("bom-res", { "Sources/App.swift": Buffer.from("﻿import DebugBridge\n", "utf8") })], env).status,
  );
  const crlfClean = runSelf(["verify", "--app", app("crlf-clean", { "Sources/App.swift": "#if DEBUG\r\nlet x = 1\r\n#endif\r\n" })], env);
  check("a balanced CRLF file is not falsely reported unbalanced", EXIT_SOURCE_CLEAN, crlfClean.status, crlfClean.stdout.slice(-200));
  check(
    "a path containing a space still verifies",
    EXIT_SOURCE_CLEAN,
    runSelf(["verify", "--app", app("with space dir", { "Sources/App.swift": CLEAN_APP })], env).status,
  );

  // ---- the edit gstack's Phase 2 actually botches
  const dangling = runSelf(["verify", "--app", app("bal-open", { "Sources/App.swift": "struct A {}\n#if DEBUG\nlet debugOnly = 1\n" })], env);
  check("an #if left open by the strip is RESIDUE (gstack's grep finds nothing)", EXIT_RESIDUE, dangling.status);
  check("...and it names the line the #if was opened on", true, /#if opened at line 2 is never closed/.test(dangling.stdout), dangling.stdout.slice(-300));
  check(
    "a stray #endif whose #if was removed is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("bal-stray", { "Sources/App.swift": "struct A {}\n#endif\n" })], env).status,
  );
  check(
    "a #else with no #if is RESIDUE",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("bal-else", { "Sources/App.swift": "struct A {}\n#else\nlet y = 2\n#endif\n" })], env).status,
  );
  check(
    "an #endif commented out during the strip is caught",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("bal-commented", { "Sources/App.swift": "#if DEBUG\nlet x = 1\n/* #endif */\n" })], env).status,
  );
  const falsePos = runSelf(
    ["verify", "--app", app("bal-nofalse", { "Sources/App.swift": '#if DEBUG\nlet x = 1\n#endif\n// #endif\nlet s = """\n#endif\n"""\nlet r = #"#endif"#\n' })],
    env,
  );
  check("an #endif in a comment, a multiline string, or a raw string is not counted", EXIT_SOURCE_CLEAN, falsePos.status, falsePos.stdout.slice(-300));
  check(
    "nested #if blocks balance correctly",
    EXIT_SOURCE_CLEAN,
    runSelf(["verify", "--app", app("bal-nested", { "Sources/App.swift": "#if DEBUG\n#if os(iOS)\nlet x = 1\n#else\nlet x = 2\n#endif\n#endif\n" })], env).status,
  );

  // ---- Package.swift, where the removal leaves a hole nothing on Windows sees
  const orphan = runSelf(
    [
      "verify",
      "--app",
      app("pkg-orphan", {
        "Sources/App.swift": CLEAN_APP,
        "Package.swift": CLEAN_PACKAGE.replace(
          '.product(name: "Collections", package: "swift-collections"),',
          '.product(name: "Collections", package: "swift-collections"),\n            .product(name: "DebugBridgeUI", package: "DebugBridge"),',
        ),
      }),
    ],
    env,
  );
  check("a product reference whose .package() line was deleted is RESIDUE", EXIT_RESIDUE, orphan.status);
  check("...and it says the .package() line is gone", true, /the \.package\(\) line is gone/.test(orphan.stdout), orphan.stdout.slice(-400));
  const unguarded = runSelf(
    [
      "verify",
      "--app",
      app("pkg-unguarded", {
        "Sources/App.swift": CLEAN_APP,
        "Package.swift": CLEAN_PACKAGE.replace(
          '.package(url: "https://github.com/apple/swift-collections.git", from: "1.0.0"),',
          '.package(url: "https://github.com/apple/swift-collections.git", from: "1.0.0"),\n        .package(path: "../DebugBridge"),',
        ).replace(
          '.product(name: "Collections", package: "swift-collections"),',
          '.product(name: "Collections", package: "swift-collections"),\n            .product(name: "DebugBridgeUI", package: "DebugBridge"),',
        ),
      }),
    ],
    env,
  );
  check("a DebugBridge dependency with no debug-only condition is RESIDUE", EXIT_RESIDUE, unguarded.status);
  check("...and it says it links in Release", true, /links in Release/.test(unguarded.stdout), unguarded.stdout.slice(-400));
  check(
    "a Package.swift with no DebugBridge and no orphans passes",
    EXIT_SOURCE_CLEAN,
    runSelf(["verify", "--app", app("pkg-ok", { "Sources/App.swift": CLEAN_APP, "Package.swift": CLEAN_PACKAGE })], env).status,
  );

  // ---- the ledger: evidence, not claims
  const evState = path.join(tmp, "state-evidence");
  fs.mkdirSync(evState, { recursive: true });
  const evApp = app("ledger-app", { "Sources/App.swift": CLEAN_APP });
  const bare = { buildProof: { app: evApp, status: "passed", recordedAt: new Date(Date.now() + 60000).toISOString() } };
  write(path.join(evState, "ios-clean-ledger.json"), JSON.stringify(bare));
  const claimed = runSelf(["verify", "--app", evApp], { TOOLBAY_STACK_STATE_DIR: evState });
  check('a ledger claiming "passed" with no command or output is not believed', EXIT_SOURCE_CLEAN, claimed.status, claimed.stdout.slice(-300));
  check("...and it says why", true, /names no command|captured no output/.test(claimed.stdout), claimed.stdout.slice(-300));

  const staleState = path.join(tmp, "state-stale");
  fs.mkdirSync(staleState, { recursive: true });
  write(
    path.join(staleState, "ios-clean-ledger.json"),
    JSON.stringify({
      buildProof: {
        app: evApp,
        status: "passed",
        command: "nm -j /build/MyApp",
        exitCode: 0,
        output: "12000 symbols inspected, none matching DebugBridge",
        recordedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
      },
    }),
  );
  const stale = runSelf(["verify", "--app", evApp], { TOOLBAY_STACK_STATE_DIR: staleState });
  check("a build proof older than the source it covers is stale, not a pass", EXIT_SOURCE_CLEAN, stale.status, stale.stdout.slice(-300));

  const corruptState = path.join(tmp, "state-corrupt");
  fs.mkdirSync(corruptState, { recursive: true });
  write(path.join(corruptState, "ios-clean-ledger.json"), "{ this is not json");
  check(
    "a corrupt ledger is UNVERIFIABLE, not silently ignored",
    EXIT_UNVERIFIABLE,
    runSelf(["verify", "--app", evApp], { TOOLBAY_STACK_STATE_DIR: corruptState }).status,
  );

  // ---- --accept-source-only must never launder a dirty tree
  check(
    "--accept-source-only does NOT turn RESIDUE into a pass",
    EXIT_RESIDUE,
    runSelf(["verify", "--app", app("dirty-accept", { "Sources/App.swift": "import DebugBridge\n" }), "--accept-source-only"], env).status,
  );

  // ---- inventory baselines pre-existing damage so verify does not misattribute it
  const preState = path.join(tmp, "state-pre");
  fs.mkdirSync(preState, { recursive: true });
  const preApp = app("pre-broken", { "Sources/Legacy.swift": "#if FOO\nlet x = 1\n", "Sources/App.swift": "import DebugBridge\n" });
  const inv = runSelf(["inventory", "--app", preApp], { TOOLBAY_STACK_STATE_DIR: preState });
  check("inventory records a file that was already unbalanced", EXIT_CLEAN, inv.status, inv.stdout.slice(-300));
  fs.writeFileSync(path.join(preApp, "Sources", "App.swift"), CLEAN_APP, "utf8");
  const after = runSelf(["verify", "--app", preApp], { TOOLBAY_STACK_STATE_DIR: preState });
  check("verify calls pre-existing damage pre-existing, not caused by the strip", true, /unbalanced before this removal started/.test(after.stdout), after.stdout.slice(-400));
  check("...and it still blocks, because the file is still broken", EXIT_RESIDUE, after.status);

  // ---- build-proof never records a pass it did not earn
  const bpState = path.join(tmp, "state-bp");
  fs.mkdirSync(bpState, { recursive: true });
  const bp = runSelf(["build-proof", "--app", clean], { TOOLBAY_STACK_STATE_DIR: bpState, PATH: process.platform === "win32" ? "" : "/nonexistent" });
  const bpLedger = JSON.parse(fs.readFileSync(path.join(bpState, "ios-clean-ledger.json"), "utf8"));
  check("build-proof with no swift on PATH exits non-zero", true, bp.status !== 0, `status ${bp.status}`);
  check("build-proof with no swift records unavailable, never passed", "unavailable", bpLedger.buildProof.status);

  // ---- doctor tells the truth about this machine
  const doc = runSelf(["doctor"], env);
  check("doctor exits 0 and names the platform", EXIT_CLEAN, doc.status);
  check("doctor reports the static checks as available everywhere", true, /works everywhere/.test(doc.stdout));

  // A selftest whose total depends on where it ran is a selftest that can
  // quietly stop asserting things. State the number, and make missing it a
  // failure of its own.
  const EXPECTED = 46;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly; the temp dir is disposable */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-ios-clean selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    process.stdout.write(`  ${tag}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  This verifier is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    return 1;
  }
  process.stdout.write("\n  Every case above is a removal that reports success without having removed\n");
  process.stdout.write("  anything, or a check that could not run reporting as a check that passed.\n");
  process.stdout.write("  None of them reach a clean verdict here.\n\n");
  return 0;
}

// ---------------------------------------------------------------------- main

const HELP = `
  ${bold("tb-ios-clean")}  strip the gstack DebugBridge out of an iOS app, and prove it is gone

  ${cyan("inventory --app <dir>")}      list every DebugBridge artifact with file:line evidence,
                             and record which files were ALREADY unbalanced, so damage
                             from the strip can be told apart from damage that predates it

  ${cyan("verify --app <dir>")}         the fail-closed replacement for gstack's Phase 3
      ${dim("--accept-source-only")}   accept a run with no binary proof as a pass (exit 0)

  ${cyan("build-proof --app <dir>")}    run swift build -c release and nm -j, and record the
      ${dim("--binary <path>")}        real command output. Never records a pass it did not earn.
      ${dim("--package-dir <dir>")}

  ${cyan("doctor")}                     what can and cannot be proven on this machine
  ${cyan("selftest")}                   drive this file against deliberately broken app trees

  ${bold("exit codes")}
    0  CLEAN          every static check passed and the binary was inspected
    1  RESIDUE        something survived, or the strip broke a file
    2  UNVERIFIABLE   the check could not run; nothing is claimed
    3  SOURCE-CLEAN   static checks passed, binary proof did not run here
`;

function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags } = parseArgs(rest);
  switch (cmd) {
    case "inventory":
      return cmdInventory(flags);
    case "verify":
      return cmdVerify(flags);
    case "build-proof":
      return cmdBuildProof(flags);
    case "doctor":
      return cmdDoctor();
    case "selftest":
      return selftest();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return EXIT_CLEAN;
    default:
      out(HELP);
      out(`  ${red(`unknown command: ${cmd}`)}`);
      return EXIT_UNVERIFIABLE;
  }
}

process.exitCode = main();
