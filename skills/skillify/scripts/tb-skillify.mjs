#!/usr/bin/env node
/**
 * tb-skillify.mjs: turn a working one-off scrape into a permanent, TESTED skill
 * on disk. Stage, check, commit, verify. Node only, no Bun, no shell.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The command name /skillify, the workflow it names (codify the
 * last successful /scrape into a permanent browser-skill), the iron contract
 * (stage to a temp dir, test there, rename into the tier path only on pass plus
 * explicit approval, otherwise remove it entirely), the two-tier global/project
 * skill layout, the pure-parser + fixture-replay test shape, the agent-authored
 * `trusted: false` / `source: agent` frontmatter, and the post-commit verify
 * step all come from `skillify` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 *
 * WHY THIS IS A REWRITE AND NOT A PORT
 * ====================================
 *
 * gstack's /skillify is a good idea whose enforcement lives in prose. Three
 * things were measured on Windows 11 against gstack 1.60.1.0 on 2026-08-13,
 * with the transcripts below.
 *
 * 1. IT CANNOT WRITE A FILE ON THIS MACHINE. Step 7 calls `stageSkill()` from
 *    `browse/src/browser-skill-write.ts`, which calls `mkdirSecure()` on the
 *    staging dir, which runs `icacls <dir> /inheritance:r /grant:r <user>:(F)`.
 *    icacls exits 0, so gstack's best-effort warning never fires, and the ACE it
 *    leaves behind names a trustee nobody holds. The next write dies:
 *
 *      run 1: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
 *      run 2: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
 *      run 3: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
 *
 *    Three for three, from the exact call sequence at browser-skill-write.ts
 *    lines 78, 79 and 90. The same mkdir without the icacls call writes fine.
 *    So /skillify does not have a Windows bug so much as it has no Windows.
 *    Nothing here restricts ACLs: a staged skill is a directory of source files
 *    the user is about to read, not a credential, and a hardening step that
 *    bricks the feature is not hardening.
 *
 * 2. THE TEST RESULT IS NOT AN INPUT TO THE COMMIT. Step 8 runs the generated
 *    test, step 10 calls `commitSkill()`. Nothing connects them. Staging a skill
 *    whose test fails and committing it directly, which is what a model does the
 *    moment it misreads step 8:
 *
 *      bun test in the staged dir -> exit 1   (1 fail)
 *      commitSkill  -> ...\browser-skills\broken-scraper
 *      on disk      -> script.test.ts, script.ts, SKILL.md
 *
 *    "There is no almost shipped state" is the file's own promise, and the only
 *    thing keeping it is the model's attention span. Here `commit` reads a
 *    verification marker that `check` writes, keyed to a SHA-256 of the staged
 *    tree, and refuses without one. Skipping the gate is no longer forgetting a
 *    step; it is forging a file.
 *
 * 3. THE TEST QUALITY RULE IS UNENFORCEABLE PROSE. Step 5 says the generated
 *    test "must include at least one *2 assertion ... Smoke tests that only
 *    check parseFromHtml doesn't throw are insufficient." Nothing checks that.
 *    A model that writes `assert.doesNotThrow(() => parseFromHtml(html))` gets a
 *    green run, an approval prompt that says "tests pass", and a permanent
 *    artifact that asserts nothing about the parse. This is the failure that
 *    matters, because it is the one that reads as success.
 *
 *    So `check` runs the test three times: once against the real fixture, where
 *    it must pass, and once against each of two mutants of that fixture, an
 *    empty file and the same page with every tag stripped, where it must FAIL.
 *    A test that still passes against a page with no HTML in it is not testing
 *    the parse, and it is rejected with that sentence.
 *
 * 4. THE NAME VALIDATOR ACCEPTS NAMES WINDOWS CANNOT HOLD.
 *
 *      validateSkillName("con")   -> ACCEPTED
 *      validateSkillName("aux")   -> ACCEPTED
 *      validateSkillName("nul")   -> ACCEPTED
 *      validateSkillName("com1")  -> ACCEPTED
 *      validateSkillName("prn")   -> ACCEPTED
 *
 *    Those are reserved device names. gstack's SKILL.md also tells the model the
 *    limit is 32 characters while the code enforces 64.
 *
 * 5. THE FIXTURE PATH IS UNKNOWABLE TO THE AGENT. Step 4 is
 *    `$B html > /tmp/skillify-fixture-$$.html`, then "Read the file you wrote".
 *    `$B` was never assigned in this skill, `/tmp` is two different directories
 *    on Windows, and `$$` is a fresh shell's PID that no later tool call can
 *    expand. Every path this tool prints is an absolute native path.
 *
 * DESIGN RULES
 * ------------
 *   1. FAIL CLOSED. A gate that cannot be evaluated is a failure, never a pass.
 *      Exit 1 means the skill is bad, exit 2 means this tool could not tell.
 *      Neither is success.
 *   2. THE GATE IS CODE. Every rule gstack states as prose that the model must
 *      honour is either enforced here or dropped. No rule is documented and
 *      unenforced, because that reads as a guarantee and is not one.
 *   3. NODE ONLY. gstack lists "Bun runtime required" as a known limit. The
 *      codified skill is .mjs, its test is node:test, and both run on the Node
 *      that Claude Code already needs.
 *   4. PROVE IT. `selftest` runs this CLI as a child process against skills that
 *      are broken in each of the ways above and fails if any of them is allowed
 *      through. `verify` measures the runtime it reports rather than quoting
 *      gstack's "~200ms".
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMsysPath, looksAbsolute, nativeAbs } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const IS_WIN = process.platform === "win32";
const VERSION = "0.1.0";

/** exit 0 = the thing is good. exit 1 = a gate failed. exit 2 = could not tell. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_CHECK = 2;

const MARKER = ".tbs-verified.json";
const STAGE_FILE = ".tbs-stage.json";
const REQUIRED_FILES = ["SKILL.md", "script.mjs", "script.test.mjs"];
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_FILES = 200;
const DEFAULT_TIMEOUT_MS = 60000;

// ------------------------------------------------------------------ printing

const out = (s) => process.stdout.write(s);
const errOut = (s) => process.stderr.write(s);

function cannotCheck(lines) {
  errOut(`\n  CANNOT CHECK\n`);
  for (const l of [].concat(lines)) errOut(`  ${l}\n`);
  errOut(`\n  This is a failure, not a pass. Nothing was verified.\n\n`);
  process.exit(EXIT_CANNOT_CHECK);
}

function refuse(lines) {
  errOut(`\n  REFUSED\n`);
  for (const l of [].concat(lines)) errOut(`  ${l}\n`);
  errOut("\n");
  process.exit(EXIT_FAILED);
}

// ------------------------------------------------------------- path handling
//
// Same three rules as tb-browse: one spelling per path, Git Bash's /c/Users is
// translated, and nothing under /tmp is ever accepted, because Node and the
// Read tool resolve it to C:\tmp while every shell resolves it to %TEMP%.

function refuseAmbiguousTmp(p) {
  if (!IS_WIN) return;
  if (!/^[\\/](tmp|temp)[\\/]/i.test(String(p))) return;
  cannotCheck([
    `"${p}" names two different directories on this machine:`,
    `  ${path.resolve(p)}   (Node, PowerShell, the Read tool)`,
    `  ${path.join(os.tmpdir(), path.basename(String(p)))}   (most shells)`,
    `Pass an absolute path instead.`,
  ]);
}

const normCase = (p) => (IS_WIN ? p.toLowerCase() : p);

function isInside(parent, child) {
  const b = normCase(path.resolve(parent)).replace(/[\\/]+$/, "");
  const t = normCase(path.resolve(child));
  return t === b || t.startsWith(b + path.sep) || t.startsWith(`${b}/`);
}

/**
 * rm -rf that actually reports whether it worked. Windows fails a delete when a
 * file carries the read-only attribute or an indexer has it open for a moment,
 * so this clears the attribute and retries. gstack's discardStaged() swallows
 * every error and the skill then tells the user "Discarded. No skill was written
 * to disk", which may not be true.
 */
function rmrf(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (e) {
      if (IS_WIN && (e.code === "EPERM" || e.code === "EACCES")) clearReadOnly(target);
    }
    if (!fs.existsSync(target)) return { ok: true };
  }
  return { ok: false, error: `${target} still exists after 5 delete attempts` };
}

function clearReadOnly(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    fs.chmodSync(target, 0o666);
  } catch {
    /* best effort, the retry loop is the real answer */
  }
  if (st.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(target);
    } catch {
      return;
    }
    for (const e of entries) clearReadOnly(path.join(target, e));
  }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// ------------------------------------------------------------------- naming
//
// Stricter than gstack's validator on the two axes that matter on Windows, and
// on the one that matters everywhere: the name becomes a directory.

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

function validateName(name) {
  if (typeof name !== "string" || !name) return "the name is empty";
  if (name.length > 48) return `the name is ${name.length} characters, the limit is 48`;
  if (!NAME_PATTERN.test(name)) {
    return `"${name}" is not a usable directory name. Lowercase letters, digits and single dashes only, starting with a letter`;
  }
  if (RESERVED.has(name)) {
    return `"${name}" is a reserved Windows device name, so the directory cannot be created there. gstack's validator accepts it`;
  }
  return null;
}

/**
 * Reject a relative path inside the staged tree that could escape it or that
 * Windows would resolve to something other than what it says.
 */
function validateRelPath(rel) {
  if (!rel) return "an entry has an empty path";
  if (path.isAbsolute(rel) || looksAbsolute(rel)) return `"${rel}" is an absolute path`;
  if (/^[a-zA-Z]:/.test(rel)) return `"${rel}" carries a drive letter`;
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (p === "" || p === "." ) return `"${rel}" contains an empty path segment`;
    if (p === "..") return `"${rel}" walks out of the skill directory`;
    if (RESERVED.has(p.split(".")[0].toLowerCase())) return `"${rel}" contains the reserved device name "${p}"`;
    if (/[ .]$/.test(p)) return `"${rel}" has a segment ending in a dot or space, which Windows silently strips`;
    if (/[<>:"|?*\u0000-\u001f]/.test(p)) return `"${rel}" contains a character Windows cannot put in a filename`;
  }
  return null;
}

// ------------------------------------------------------------------- state
//
// Staging lives on the SAME volume as the destination, by construction, so the
// commit is a rename on every layout. gstack stages under the home directory
// and commits to a tier root that may be on another drive, where renameSync
// raises EXDEV and there is no fallback. The fallback below exists anyway.

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function tierRoots(projectRoot) {
  const project = projectRoot ? path.join(nativeAbs(projectRoot), ".toolbay-stack") : null;
  return {
    global: { root: path.join(stateDir(), "browser-skills"), staging: path.join(stateDir(), "skillify-staging") },
    project: project ? { root: path.join(project, "browser-skills"), staging: path.join(project, "skillify-staging") } : null,
  };
}

function detectProjectRoot(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status === 0 && (r.stdout || "").trim()) return path.resolve(r.stdout.trim());
  return path.resolve(cwd);
}

// ------------------------------------------------------------------ hashing

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walkFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      acc.push({ rel: path.relative(base, full).split(path.sep).join("/"), symlink: true });
      continue;
    }
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) {
      acc.push({ rel: path.relative(base, full).split(path.sep).join("/"), symlink: false, full });
    }
  }
  return acc;
}

/**
 * A SHA-256 over the sorted (relative path, file hash) list. The verification
 * marker is excluded, because it is the thing being keyed. Everything else is
 * in, including .tbs-stage.json, so retargeting the skill at a different tier
 * after it passed invalidates the pass.
 */
function treeSha(dir) {
  const files = walkFiles(dir)
    .filter((f) => f.rel !== MARKER)
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const h = crypto.createHash("sha256");
  for (const f of files) {
    if (f.symlink) {
      h.update(`${f.rel}\u0000symlink\n`);
      continue;
    }
    h.update(`${f.rel}\u0000${sha256(fs.readFileSync(f.full))}\n`);
  }
  return { sha: h.digest("hex"), count: files.length };
}

// ------------------------------------------------------------- frontmatter
//
// A deliberately small YAML subset: scalars, one list level, one nested map.
// Anything it cannot parse is an error, never a silently missing field, because
// a missing field here is how an unverifiable claim gets into the artifact.

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return { error: "the file does not start with a --- frontmatter block" };
  const data = {};
  let listKey = null;
  let mapKey = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(rawLine);
    const line = rawLine.trim();
    if (indented && line.startsWith("- ") && listKey) {
      data[listKey].push(stripQuotes(line.slice(2).trim()));
      continue;
    }
    if (indented && mapKey) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!kv) return { error: `could not parse the frontmatter line "${line}"` };
      data[mapKey][kv[1]] = stripQuotes(kv[2]);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) return { error: `could not parse the frontmatter line "${line}"` };
    const [, key, rest] = kv;
    listKey = null;
    mapKey = null;
    if (rest === "") {
      // Ambiguous until the next line; decide by looking ahead is overkill, so
      // both containers are created and the used one wins.
      data[key] = [];
      Object.defineProperty(data, `__map_${key}`, { value: {}, enumerable: false, writable: true });
      listKey = key;
      mapKey = key;
      data[key] = [];
      continue;
    }
    data[key] = stripQuotes(rest);
  }
  return { data };
}

function stripQuotes(s) {
  return s.replace(/^["'](.*)["']$/, "$1").trim();
}

/** The nested-map case, handled explicitly so `fixture:` is not guesswork. */
function parseFixtureBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^fixture:\s*$/.test(l.trim()) && !/^\s/.test(l));
  if (idx === -1) return null;
  const obj = {};
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (!/^\s+\S/.test(lines[i])) break;
    const kv = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (kv) obj[kv[1]] = stripQuotes(kv[2]);
  }
  return obj;
}

function parseTriggers(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^triggers:\s*$/.test(l.trim()) && !/^\s/.test(l));
  if (idx === -1) return [];
  const outList = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (!/^\s+-\s+/.test(lines[i])) break;
    outList.push(stripQuotes(lines[i].replace(/^\s+-\s+/, "")));
  }
  return outList;
}

// --------------------------------------------------------- import hygiene
//
// A codified skill has to keep working on a machine that has never seen this
// repository. gstack solves that by copying its whole browse SDK into every
// skill; the cost is that each skill carries a frozen copy of a moving file.
// Here the rule is simpler and checkable: the parser, which is the tested part,
// may import node: builtins and its own siblings, and nothing else.

const IMPORT_RE =
  /(?:^|[^\w$])(?:import|export)\s[^;\n]*?from\s*["']([^"']+)["']|(?:^|[^\w$])import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(source) {
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    specs.push(m[1] || m[2] || m[3] || m[4]);
  }
  return specs;
}

function checkImports(skillDir, relFile) {
  const full = path.join(skillDir, relFile);
  const src = fs.readFileSync(full, "utf8");
  const problems = [];
  for (const spec of importSpecifiers(src)) {
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const resolved = path.resolve(path.dirname(full), spec);
      if (!isInside(skillDir, resolved)) {
        problems.push(`${relFile} imports "${spec}", which resolves outside the skill directory`);
      }
      continue;
    }
    if (/^[a-zA-Z]+:/.test(spec)) {
      problems.push(`${relFile} imports "${spec}", a URL or protocol specifier`);
      continue;
    }
    problems.push(
      `${relFile} imports "${spec}", a package that will not exist on another machine. ` +
        `Only node: builtins and files inside the skill are allowed`,
    );
  }
  return problems;
}

// ------------------------------------------------------------ child running

function runNode(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  return {
    status: timedOut ? null : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    timedOut,
    spawnError: r.error && !timedOut ? r.error.message : null,
  };
}

const PARSE_DRIVER = `
import fs from "node:fs";
const [, , scriptUrl, fixturePath] = process.argv;
const mod = await import(scriptUrl);
if (typeof mod.parseFromHtml !== "function") {
  process.stderr.write("script.mjs does not export a function named parseFromHtml\\n");
  process.exit(3);
}
const html = fs.readFileSync(fixturePath, "utf8");
const items = mod.parseFromHtml(html);
process.stdout.write(JSON.stringify(items));
`;

function runParse(skillDir, fixturePath, driverPath, timeoutMs) {
  const r = runNode([driverPath, pathToFileURL(path.join(skillDir, "script.mjs")).href, fixturePath], {
    cwd: skillDir,
    timeoutMs,
  });
  if (r.timedOut) return { error: `the parser did not return within ${timeoutMs}ms` };
  if (r.spawnError) return { error: `the parser could not be started: ${r.spawnError}` };
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" | ");
    return { error: `the parser exited ${r.status}: ${why || "no output"}` };
  }
  let value;
  try {
    value = JSON.parse(r.stdout);
  } catch (e) {
    return { error: `the parser printed something that is not JSON (${e.message})` };
  }
  return { value, raw: r.stdout };
}

// -------------------------------------------------------------------- gates

function gate(name, pass, evidence) {
  return { name, pass, evidence };
}

/**
 * Every gate returns a result. A gate that could not run returns pass:false with
 * the reason, never an omission, so the count of gates is fixed and a run cannot
 * quietly assert less than the previous one.
 */
function runGates(skillDir, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const gates = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-skillify-check-"));
  const driverPath = path.join(tmp, "_parse-driver.mjs");
  fs.writeFileSync(driverPath, PARSE_DRIVER, "utf8");

  const done = (list) => {
    rmrf(tmp);
    return list;
  };

  // 1. layout
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(skillDir, f)));
  const fixturesDir = path.join(skillDir, "fixtures");
  const fixtureFiles = fs.existsSync(fixturesDir)
    ? fs.readdirSync(fixturesDir).filter((f) => f.toLowerCase().endsWith(".html"))
    : [];
  gates.push(
    gate(
      "the skill has the files a skill needs",
      missing.length === 0 && fixtureFiles.length > 0,
      missing.length
        ? `missing: ${missing.join(", ")}`
        : fixtureFiles.length
          ? `${REQUIRED_FILES.join(", ")}, fixtures/${fixtureFiles[0]}`
          : "fixtures/ contains no .html file, so there is nothing to test the parser against",
    ),
  );
  if (missing.length || !fixtureFiles.length) {
    for (let i = gates.length; i < GATE_COUNT; i += 1) {
      gates.push(gate(GATE_NAMES[i], false, "not reached: the layout gate failed first"));
    }
    return done(gates);
  }

  // 2. frontmatter
  const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const fm = parseFrontmatter(skillMd);
  const fixture = parseFixtureBlock(skillMd);
  const triggers = parseTriggers(skillMd);
  const fmProblems = [];
  if (fm.error) fmProblems.push(fm.error);
  else {
    // A staged directory carries a random suffix so two runs can stage the same
    // skill at once, so the name it will be INSTALLED as is the one to compare
    // against. A committed directory has no stage file and is its own name.
    const stageInfo = readStageFile(skillDir);
    const expectedName = stageInfo.value?.name ?? path.basename(skillDir);
    const name = fm.data.name;
    if (name !== expectedName) {
      fmProblems.push(`frontmatter name "${name}" does not match the name this skill installs as, "${expectedName}"`);
    }
    if (!fm.data.description) fmProblems.push("no description");
    if (!fm.data.host) fmProblems.push("no host");
    if (fm.data.source !== "agent") fmProblems.push(`source is "${fm.data.source}", agent-authored skills must say agent`);
    if (fm.data.trusted !== "false") fmProblems.push("trusted must be false for an agent-authored skill");
    if (triggers.length < 3) fmProblems.push(`only ${triggers.length} trigger phrases, at least 3 are needed to be findable`);
    if (!fixture || !fixture.file || !fixture.sha256) fmProblems.push("no fixture block naming the file and its sha256");
  }
  gates.push(gate("the frontmatter says what this skill is", fmProblems.length === 0, fmProblems.join("; ") || "name, description, host, triggers, fixture all present"));

  // 3. fixture integrity
  let fixturePath = null;
  let fixtureProblem = null;
  if (fixture && fixture.file) {
    const relProblem = validateRelPath(fixture.file);
    if (relProblem) fixtureProblem = relProblem;
    else {
      fixturePath = path.join(skillDir, fixture.file);
      if (!fs.existsSync(fixturePath)) fixtureProblem = `${fixture.file} is named in the frontmatter but is not on disk`;
      else {
        const buf = fs.readFileSync(fixturePath);
        if (buf.length === 0) fixtureProblem = `${fixture.file} is zero bytes, so the test would be replaying nothing`;
        else if (sha256(buf) !== fixture.sha256) {
          fixtureProblem = `${fixture.file} does not match the sha256 in the frontmatter (recorded ${String(fixture.sha256).slice(0, 12)}, on disk ${sha256(buf).slice(0, 12)})`;
        }
      }
    }
  } else {
    fixtureProblem = "no fixture is declared";
  }
  gates.push(
    gate(
      "the fixture on disk is the fixture that was recorded",
      !fixtureProblem,
      fixtureProblem || `${fixture.file} matches sha256 ${String(fixture.sha256).slice(0, 12)}...`,
    ),
  );

  // 4. import hygiene
  let importProblems = [];
  try {
    importProblems = [...checkImports(skillDir, "script.mjs"), ...checkImports(skillDir, "script.test.mjs")];
  } catch (e) {
    importProblems = [`the sources could not be read: ${e.message}`];
  }
  gates.push(
    gate(
      "the skill depends on nothing but Node and itself",
      importProblems.length === 0,
      importProblems.join("; ") || "only node: builtins and files inside the skill",
    ),
  );

  if (fixtureProblem) {
    for (let i = gates.length; i < GATE_COUNT; i += 1) {
      gates.push(gate(GATE_NAMES[i], false, "not reached: there is no usable fixture to run against"));
    }
    return done(gates);
  }

  // 5. the parser returns something worth having
  const parsed = runParse(skillDir, fixturePath, driverPath, timeoutMs);
  let shapeOk = false;
  let shapeEvidence;
  if (parsed.error) {
    shapeEvidence = parsed.error;
  } else if (!Array.isArray(parsed.value)) {
    shapeEvidence = `parseFromHtml returned ${typeof parsed.value}, not an array`;
  } else if (parsed.value.length === 0) {
    shapeEvidence = "parseFromHtml returned 0 items from its own fixture";
  } else if (parsed.value.length > 10000) {
    shapeEvidence = `parseFromHtml returned ${parsed.value.length} items, which is not a parse, it is a page dump`;
  } else {
    const objects = parsed.value.every((v) => v && typeof v === "object" && !Array.isArray(v));
    if (!objects) shapeEvidence = "some items are not objects";
    else {
      const keys = Object.keys(parsed.value[0]);
      const solid = keys.filter((k) =>
        parsed.value.every((it) => {
          const v = it[k];
          return (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
        }),
      );
      shapeOk = solid.length > 0;
      shapeEvidence = shapeOk
        ? `${parsed.value.length} items, every one with a non-empty ${solid.slice(0, 3).join(", ")}`
        : `${parsed.value.length} items, but no field is non-empty on all of them (${keys.join(", ") || "no fields at all"})`;
    }
  }
  gates.push(gate("the parser returns real rows from its own fixture", shapeOk, shapeEvidence));

  // 6. the parser is deterministic
  let detOk = false;
  let detEvidence = "not run: the parser did not produce output";
  if (!parsed.error) {
    const second = runParse(skillDir, fixturePath, driverPath, timeoutMs);
    if (second.error) detEvidence = second.error;
    else {
      detOk = second.raw === parsed.raw;
      detEvidence = detOk
        ? "two runs over the same fixture produced identical output"
        : "two runs over the same fixture disagreed, so the parse depends on the clock, randomness or the environment";
    }
  }
  gates.push(gate("the parse is the same every time", detOk, detEvidence));

  // 7. the test passes on the real fixture
  const testRun = runNode(["--test", "script.test.mjs"], { cwd: skillDir, timeoutMs });
  const testOk = testRun.status === 0;
  gates.push(
    gate(
      "the bundled test passes against the real fixture",
      testOk,
      testRun.timedOut
        ? `node --test did not finish within ${timeoutMs}ms`
        : testRun.spawnError
          ? `node --test could not be started: ${testRun.spawnError}`
          : testOk
            ? "node --test script.test.mjs exited 0"
            : `node --test exited ${testRun.status}: ${firstFailure(testRun)}`,
    ),
  );

  // 8. THE ONE THAT MATTERS: the test fails when the page is gutted
  let mutantOk = false;
  let mutantEvidence = "not run: the test did not pass on the real fixture, so there is nothing to disprove";
  if (testOk) {
    const original = fs.readFileSync(fixturePath, "utf8");
    const mutants = [
      ["an empty page", ""],
      ["the same page with every tag stripped", original.replace(/<[^>]*>/g, " ")],
    ];
    const survived = [];
    for (const [label, content] of mutants) {
      const mdir = path.join(tmp, `mutant-${survived.length}-${crypto.randomBytes(3).toString("hex")}`);
      copyTree(skillDir, mdir);
      fs.writeFileSync(path.join(mdir, fixture.file), content, "utf8");
      const mr = runNode(["--test", "script.test.mjs"], { cwd: mdir, timeoutMs });
      if (mr.status === 0) survived.push(`${label} (the test still passed)`);
      else if (mr.timedOut) survived.push(`${label} (the test hung instead of failing)`);
      rmrf(mdir);
    }
    mutantOk = survived.length === 0;
    mutantEvidence = mutantOk
      ? "the test fails on an empty page and on a page with no tags, so it is asserting something about the parse"
      : `the test still passes against ${survived.join(" and ")}. A test that passes on a page with no HTML in it is not testing the parse`;
  }
  gates.push(gate("the test fails when the page is gutted", mutantOk, mutantEvidence));

  return done(gates);
}

const GATE_NAMES = [
  "the skill has the files a skill needs",
  "the frontmatter says what this skill is",
  "the fixture on disk is the fixture that was recorded",
  "the skill depends on nothing but Node and itself",
  "the parser returns real rows from its own fixture",
  "the parse is the same every time",
  "the bundled test passes against the real fixture",
  "the test fails when the page is gutted",
];
const GATE_COUNT = GATE_NAMES.length;

function firstFailure(run) {
  const lines = `${run.stdout}\n${run.stderr}`.split("\n");
  const hit = lines.find((l) => /not ok |AssertionError|Error:/.test(l));
  return (hit || lines.filter(Boolean).slice(-1)[0] || "no output").trim().slice(0, 160);
}

// ------------------------------------------------------------------ commands

function cmdStage(flags) {
  const nameProblem = validateName(flags.name);
  if (nameProblem) refuse([nameProblem, "", "A skill name becomes a directory name on three operating systems."]);

  if (!flags.from) cannotCheck(["--from <dir> is required: the directory holding the files you wrote"]);
  refuseAmbiguousTmp(flags.from);
  const from = nativeAbs(flags.from);
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    cannotCheck([`--from ${from} is not a directory`]);
  }

  const tier = flags.tier || "global";
  if (tier !== "global" && tier !== "project") refuse([`--tier must be global or project, got "${tier}"`]);
  const roots = tierRoots(tier === "project" ? flags["project-root"] || detectProjectRoot() : null);
  const target = roots[tier];
  if (!target) refuse(["project tier was asked for but no project root could be resolved"]);

  // Validate the source tree before a single byte is copied.
  const files = walkFiles(from);
  const problems = [];
  let bytes = 0;
  for (const f of files) {
    if (f.symlink) {
      problems.push(`${f.rel} is a symlink; a skill must be plain files so it survives being copied`);
      continue;
    }
    const p = validateRelPath(f.rel);
    if (p) problems.push(p);
    if (f.rel === MARKER || f.rel === STAGE_FILE) {
      problems.push(`${f.rel} is written by this tool and may not be supplied. Staging a pre-made verification marker is how an unchecked skill would get committed`);
    }
    if (!f.symlink) bytes += fs.statSync(f.full).size;
  }
  if (files.length === 0) problems.push("the source directory is empty");
  if (files.length > MAX_TREE_FILES) problems.push(`${files.length} files, the limit is ${MAX_TREE_FILES}`);
  if (bytes > MAX_TREE_BYTES) problems.push(`${(bytes / 1048576).toFixed(1)}MB, the limit is ${MAX_TREE_BYTES / 1048576}MB`);
  for (const req of REQUIRED_FILES) {
    if (!files.some((f) => f.rel === req)) problems.push(`there is no ${req}`);
  }
  if (problems.length) refuse(["The source tree was not staged:", ...problems.map((p) => `  - ${p}`)]);

  // Same volume as the destination, always, so commit is a rename.
  fs.mkdirSync(target.staging, { recursive: true });
  const stageId = crypto.randomBytes(16).toString("hex");
  const staged = path.join(target.staging, `${flags.name}-${stageId.slice(0, 12)}`);
  if (fs.existsSync(staged)) refuse([`${staged} already exists`]);
  copyTree(from, staged);
  fs.writeFileSync(
    path.join(staged, STAGE_FILE),
    `${JSON.stringify({ name: flags.name, tier, tierRoot: target.root, stageId, stagedAt: new Date().toISOString(), version: VERSION }, null, 2)}\n`,
    "utf8",
  );

  out(`\n  STAGED  ${staged}\n`);
  out(`  tier    ${tier} -> ${path.join(target.root, flags.name)}\n`);
  out(`  files   ${files.length} (${(bytes / 1024).toFixed(1)} KB)\n`);
  out(`\n  Nothing is installed yet. Next:\n`);
  out(`    node ${path.basename(SELF)} check --dir "${staged}"\n\n`);
}

function readStageFile(dir) {
  const p = path.join(dir, STAGE_FILE);
  if (!fs.existsSync(p)) return { error: `${p} is missing, so this directory was not produced by "stage"` };
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!obj.name || !obj.tier || !obj.tierRoot || !obj.stageId) return { error: `${p} is missing required fields` };
    return { value: obj };
  } catch (e) {
    return { error: `${p} is not valid JSON (${e.message})` };
  }
}

function cmdCheck(flags) {
  if (!flags.dir) cannotCheck(["--dir <stagedDir> is required"]);
  refuseAmbiguousTmp(flags.dir);
  const dir = nativeAbs(flags.dir);
  if (!fs.existsSync(dir)) cannotCheck([`${dir} does not exist`]);
  const timeoutMs = Number(flags["timeout-ms"] || DEFAULT_TIMEOUT_MS);

  const gates = runGates(dir, { timeoutMs });
  const width = Math.max(...gates.map((g) => g.name.length));
  out(`\n  tb-skillify check  ${dir}\n\n`);
  for (const g of gates) {
    out(`  ${g.pass ? "PASS" : "FAIL"}  ${g.name.padEnd(width)}  ${g.evidence}\n`);
  }
  const failed = gates.filter((g) => !g.pass);
  out(`\n  ${gates.length - failed.length}/${gates.length} gates passed\n`);

  if (gates.length !== GATE_COUNT) {
    out(`\n  This run made ${gates.length} of the ${GATE_COUNT} checks it is supposed to make, which is itself a failure.\n\n`);
    process.exit(EXIT_CANNOT_CHECK);
  }
  if (failed.length) {
    out(`\n  Not verified. No marker was written, so "commit" will refuse this directory.\n\n`);
    process.exit(EXIT_FAILED);
  }

  const stage = readStageFile(dir);
  const { sha, count } = treeSha(dir);
  fs.writeFileSync(
    path.join(dir, MARKER),
    `${JSON.stringify(
      {
        version: VERSION,
        treeSha256: sha,
        fileCount: count,
        stageId: stage.value?.stageId ?? null,
        verifiedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        gates: gates.map((g) => ({ name: g.name, pass: g.pass })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  out(`\n  Verified. Marker written for tree ${sha.slice(0, 12)} (${count} files).\n`);
  out(`  Any edit to the staged files after this point invalidates it.\n`);
  out(`\n    node ${path.basename(SELF)} commit --dir "${dir}"\n\n`);
}

function cmdCommit(flags) {
  if (!flags.dir) cannotCheck(["--dir <stagedDir> is required"]);
  refuseAmbiguousTmp(flags.dir);
  const dir = nativeAbs(flags.dir);
  if (!fs.existsSync(dir)) cannotCheck([`${dir} does not exist`]);

  const stage = readStageFile(dir);
  if (stage.error) refuse([stage.error]);

  const markerPath = path.join(dir, MARKER);
  if (!fs.existsSync(markerPath)) {
    refuse([
      `${dir} has never passed "check".`,
      "",
      'gstack\'s commitSkill takes no test result as input, so a staged skill whose test failed',
      "commits exactly as easily as one whose test passed. This one will not move until check has",
      "written a marker for the exact bytes being committed.",
      "",
      `  node ${path.basename(SELF)} check --dir "${dir}"`,
    ]);
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (e) {
    refuse([`${markerPath} is not valid JSON (${e.message}), so the verification cannot be trusted`]);
  }
  const current = treeSha(dir);
  if (marker.treeSha256 !== current.sha) {
    refuse([
      "The staged files changed after they passed check.",
      `  verified  ${marker.treeSha256}`,
      `  on disk   ${current.sha}`,
      "",
      "Run check again. A pass belongs to a set of bytes, not to a directory name.",
    ]);
  }
  if (marker.stageId && stage.value.stageId !== marker.stageId) {
    refuse(["The verification marker was produced for a different staging run."]);
  }

  const destRoot = nativeAbs(stage.value.tierRoot);
  const dest = path.join(destRoot, stage.value.name);
  if (isInside(dir, destRoot) || isInside(dest, dir)) {
    refuse([`the destination ${dest} overlaps the staging directory ${dir}`]);
  }
  fs.mkdirSync(destRoot, { recursive: true });

  // Case-insensitive collision. On Windows "Lobsters" and "lobsters" are the
  // same directory, so an existsSync on the exact spelling is not the question.
  const existing = fs.readdirSync(destRoot).find((e) => normCase(e) === normCase(stage.value.name));
  if (existing) {
    refuse([
      `a skill named "${existing}" already lives at ${path.join(destRoot, existing)}`,
      IS_WIN && existing !== stage.value.name
        ? `  It differs from "${stage.value.name}" only in case, which is the same directory on this filesystem.`
        : "  Pick a different name, or remove the existing skill first.",
    ]);
  }

  try {
    fs.renameSync(dir, dest);
  } catch (e) {
    if (e.code !== "EXDEV") {
      refuse([`the staged skill could not be moved into place: ${e.code || e.message}`]);
    }
    // Different volume: copy beside the destination, then rename within it, so
    // the directory still appears at its final path in one step.
    const tmpDest = `${dest}.tbs-incoming-${crypto.randomBytes(4).toString("hex")}`;
    copyTree(dir, tmpDest);
    fs.renameSync(tmpDest, dest);
    const gone = rmrf(dir);
    if (!gone.ok) out(`  note: the staging copy could not be removed (${gone.error})\n`);
  }

  const after = treeSha(dest);
  if (after.sha !== marker.treeSha256) {
    refuse([
      "The committed tree does not hash to what was verified. Something changed in transit.",
      `  verified  ${marker.treeSha256}`,
      `  at rest   ${after.sha}`,
      `  location  ${dest}`,
    ]);
  }

  out(`\n  COMMITTED  ${dest}\n`);
  out(`  tier       ${stage.value.tier}\n`);
  out(`  tree       ${after.sha.slice(0, 12)} (${after.count} files), identical to the tree that passed check\n`);
  out(`\n  Prove it runs, with a measured number rather than an estimate:\n`);
  out(`    node ${path.basename(SELF)} verify --dir "${dest}"\n\n`);
}

function cmdDiscard(flags) {
  if (!flags.dir) cannotCheck(["--dir <stagedDir> is required"]);
  const dir = nativeAbs(flags.dir);
  if (!fs.existsSync(dir)) {
    out(`\n  Nothing to discard: ${dir} does not exist.\n\n`);
    return;
  }
  const stage = readStageFile(dir);
  if (stage.error) {
    refuse([stage.error, "discard only removes directories this tool staged, so it cannot be pointed at anything else"]);
  }
  const r = rmrf(dir);
  if (!r.ok) {
    errOut(`\n  NOT DISCARDED\n  ${r.error}\n\n  The staged files are still on disk. gstack reports this case as discarded.\n\n`);
    process.exit(EXIT_FAILED);
  }
  out(`\n  Discarded ${dir}. Nothing was written to disk.\n\n`);
}

function cmdVerify(flags) {
  if (!flags.dir) cannotCheck(["--dir <skillDir> is required"]);
  const dir = nativeAbs(flags.dir);
  if (!fs.existsSync(dir)) cannotCheck([`${dir} does not exist`]);
  const runs = Math.max(1, Number(flags.runs || 3));
  const timeoutMs = Number(flags["timeout-ms"] || DEFAULT_TIMEOUT_MS);

  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) cannotCheck([`${skillMd} does not exist, so this is not a codified skill`]);
  const text = fs.readFileSync(skillMd, "utf8");
  const fixture = parseFixtureBlock(text);
  if (!fixture?.file) cannotCheck(["SKILL.md declares no fixture, so there is nothing to replay"]);
  const fixturePath = path.join(dir, fixture.file);
  if (!fs.existsSync(fixturePath)) cannotCheck([`${fixturePath} is missing`]);

  const lines = [];
  let failed = false;

  // Is this still the tree that passed check?
  const markerPath = path.join(dir, MARKER);
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      const now = treeSha(dir);
      const same = now.sha === marker.treeSha256;
      if (!same) failed = true;
      lines.push([same, "the files are the ones that passed check", same ? `tree ${now.sha.slice(0, 12)}` : `tree is now ${now.sha.slice(0, 12)}, verified as ${String(marker.treeSha256).slice(0, 12)}`]);
    } catch (e) {
      failed = true;
      lines.push([false, "the verification marker is readable", e.message]);
    }
  } else {
    failed = true;
    lines.push([false, "the verification marker is present", `${MARKER} is missing, so nothing here was ever checked`]);
  }

  // Fixture integrity and age.
  const buf = fs.readFileSync(fixturePath);
  const shaOk = !fixture.sha256 || sha256(buf) === fixture.sha256;
  if (!shaOk) failed = true;
  lines.push([shaOk, "the fixture is the one that was captured", shaOk ? `${fixture.file}, ${buf.length} bytes` : "the fixture has been edited since capture"]);

  let ageDays = null;
  if (fixture.capturedAt) {
    const t = Date.parse(fixture.capturedAt);
    if (!Number.isNaN(t)) ageDays = Math.floor((Date.now() - t) / 86400000);
  }
  const maxAge = flags["max-age-days"] ? Number(flags["max-age-days"]) : null;
  if (ageDays !== null) {
    const ok = maxAge === null ? true : ageDays <= maxAge;
    if (!ok) failed = true;
    lines.push([
      ok,
      "the fixture is not stale",
      maxAge === null
        ? `captured ${ageDays} days ago. A passing test only proves the parser still reads that snapshot`
        : `captured ${ageDays} days ago, limit ${maxAge}`,
    ]);
  } else {
    lines.push([false, "the fixture records when it was captured", "no capturedAt in the frontmatter, so staleness cannot be judged"]);
    failed = true;
  }

  // Measured replay.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-skillify-verify-"));
  const driverPath = path.join(tmp, "_parse-driver.mjs");
  fs.writeFileSync(driverPath, PARSE_DRIVER, "utf8");
  const times = [];
  let last = null;
  let parseErr = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = runParse(dir, fixturePath, driverPath, timeoutMs);
    const t1 = process.hrtime.bigint();
    if (r.error) {
      parseErr = r.error;
      break;
    }
    times.push(Number(t1 - t0) / 1e6);
    last = r;
  }
  if (parseErr) {
    failed = true;
    lines.push([false, "the codified parser runs", parseErr]);
  } else {
    const best = Math.min(...times);
    lines.push([
      true,
      "the codified parser runs",
      `${last.value.length} items, ${best.toFixed(0)}ms best of ${times.length} (measured now, including Node startup)`,
    ]);
  }

  // Optional comparison against what the prototype produced.
  if (flags.expect) {
    const ep = nativeAbs(flags.expect);
    if (!fs.existsSync(ep)) {
      failed = true;
      lines.push([false, "the output matches the prototype", `${ep} does not exist`]);
    } else if (!last) {
      failed = true;
      lines.push([false, "the output matches the prototype", "the parser produced nothing to compare"]);
    } else {
      let expected;
      try {
        expected = JSON.parse(fs.readFileSync(ep, "utf8"));
      } catch (e) {
        expected = undefined;
        failed = true;
        lines.push([false, "the output matches the prototype", `${ep} is not valid JSON (${e.message})`]);
      }
      if (expected !== undefined) {
        const a = JSON.stringify(expected);
        const b = JSON.stringify(last.value);
        const same = a === b;
        if (!same) failed = true;
        lines.push([
          same,
          "the output matches the prototype",
          same ? `${last.value.length} items, byte-identical to ${path.basename(ep)}` : firstDifference(expected, last.value),
        ]);
      }
    }
  }
  rmrf(tmp);

  const width = Math.max(...lines.map((l) => l[1].length));
  out(`\n  tb-skillify verify  ${dir}\n\n`);
  for (const [ok, name, evidence] of lines) out(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${evidence}\n`);
  out(`\n  ${failed ? "VERDICT FAIL. Do not report this skill as working." : "VERDICT PASS."}\n\n`);
  process.exit(failed ? EXIT_FAILED : EXIT_OK);
}

function firstDifference(expected, got) {
  if (!Array.isArray(expected) || !Array.isArray(got)) return `expected ${typeof expected}, got ${typeof got}`;
  if (expected.length !== got.length) return `the prototype produced ${expected.length} items, this produces ${got.length}`;
  for (let i = 0; i < expected.length; i += 1) {
    const a = JSON.stringify(expected[i]);
    const b = JSON.stringify(got[i]);
    if (a !== b) return `item ${i} differs: prototype ${a.slice(0, 70)} vs now ${b.slice(0, 70)}`;
  }
  return "the arrays differ in key order only";
}

function cmdList() {
  const roots = tierRoots(detectProjectRoot());
  out(`\n  tb-skillify skills\n\n`);
  let found = 0;
  for (const tier of ["global", "project"]) {
    const t = roots[tier];
    if (!t || !fs.existsSync(t.root)) continue;
    for (const name of fs.readdirSync(t.root)) {
      const dir = path.join(t.root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      found += 1;
      const md = path.join(dir, "SKILL.md");
      const fixture = fs.existsSync(md) ? parseFixtureBlock(fs.readFileSync(md, "utf8")) : null;
      const verified = fs.existsSync(path.join(dir, MARKER));
      let age = "?";
      if (fixture?.capturedAt) {
        const t0 = Date.parse(fixture.capturedAt);
        if (!Number.isNaN(t0)) age = `${Math.floor((Date.now() - t0) / 86400000)}d`;
      }
      out(`  ${tier.padEnd(8)} ${name.padEnd(28)} ${verified ? "verified" : "UNVERIFIED"}  fixture ${age} old\n`);
      out(`           ${dir}\n`);
    }
  }
  if (!found) out(`  none yet. Codify one with /skillify after a scrape that worked.\n`);
  out("\n");
}

// ---------------------------------------------------------------- capture
//
// The fixture comes from the browser through the browse skill, resolved here so
// there is no $B to be empty, written to an absolute path that is printed. A
// capture that produced nothing is a failure, not an empty fixture: gstack's
// `$B html > /tmp/...` leaves a zero-byte file behind when $B is unset, and a
// zero-byte fixture is exactly what makes a smoke test look green.

function resolveBrowseSkill() {
  const override = process.env.TOOLBAY_SKILLIFY_BROWSE;
  const candidates = override
    ? [nativeAbs(override)]
    : [
        path.join(path.dirname(path.dirname(path.dirname(SELF))), "browse", "scripts", "tb-browse.mjs"),
        path.join(os.homedir(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
        path.join(process.cwd(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
      ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return { path: c, searched: candidates };
    } catch {
      /* keep looking */
    }
  }
  return { path: null, searched: candidates };
}

function cmdCapture(flags) {
  if (!flags.url) cannotCheck(["--url <url> is required"]);
  if (!flags.out) cannotCheck(["--out <dir> is required: where to write the fixture"]);
  refuseAmbiguousTmp(flags.out);
  const outDir = nativeAbs(flags.out);
  const b = resolveBrowseSkill();
  if (!b.path) {
    cannotCheck([
      "The browse skill was not found, so no page could be fetched. Looked at:",
      ...b.searched.map((s) => `  ${s}`),
      "",
      "No fixture was written. An empty fixture is worse than none: a weak test passes against it.",
    ]);
  }

  let host;
  try {
    host = new URL(flags.url).hostname;
  } catch {
    cannotCheck([`"${flags.url}" is not a URL`]);
  }

  const goto = runNode([b.path, "run", "--", "goto", flags.url], { timeoutMs: 120000 });
  if (goto.status !== 0) {
    cannotCheck([`browse goto exited ${goto.status ?? "on a timeout"}: ${(goto.stderr || goto.stdout).trim().slice(0, 200)}`]);
  }
  const html = runNode([b.path, "run", "--", "html"], { timeoutMs: 120000 });
  if (html.status !== 0) cannotCheck([`browse html exited ${html.status ?? "on a timeout"}`]);
  const body = html.stdout.replace(/^--- BEGIN UNTRUSTED[^\n]*\n/, "").replace(/\n--- END UNTRUSTED[^\n]*\n?$/, "");
  if (!body.trim() || !body.includes("<")) {
    cannotCheck([`the page returned ${body.length} bytes and no markup, so there is nothing to codify`]);
  }

  const date = new Date().toISOString().slice(0, 10);
  const file = `${host.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${date}.html`;
  fs.mkdirSync(path.join(outDir, "fixtures"), { recursive: true });
  const full = path.join(outDir, "fixtures", file);
  fs.writeFileSync(full, body, "utf8");
  const digest = sha256(fs.readFileSync(full));

  out(`\n  CAPTURED  ${full}\n`);
  out(`  bytes     ${Buffer.byteLength(body)}\n`);
  out(`  sha256    ${digest}\n`);
  out(`\n  Put this in SKILL.md so the fixture can be checked later:\n\n`);
  out(`    fixture:\n      file: fixtures/${file}\n      sha256: ${digest}\n      bytes: ${Buffer.byteLength(body)}\n      capturedAt: ${date}\n\n`);
}

// ------------------------------------------------------------------- doctor

function cmdDoctor() {
  const roots = tierRoots(detectProjectRoot());
  const b = resolveBrowseSkill();
  out(`\n  tb-skillify doctor  (node ${process.version}, ${process.platform})\n\n`);
  out(`  state dir         ${stateDir()}\n`);
  out(`  global skills     ${roots.global.root}\n`);
  out(`  global staging    ${roots.global.staging}\n`);
  out(`  same volume       ${sameVolume(roots.global.root, roots.global.staging) ? "yes, commit is a rename" : "NO, commit will fall back to copy"}\n`);
  out(`  project skills    ${roots.project ? roots.project.root : "-"}\n`);
  out(`  browse skill      ${b.path ?? "NOT FOUND (capture will refuse rather than write an empty fixture)"}\n`);
  out(`  node --test       ${runNode(["--test", "--help"], { timeoutMs: 15000 }).status === 0 ? "available" : "UNAVAILABLE"}\n`);
  if (IS_WIN) {
    out(`  os.tmpdir()       ${os.tmpdir()}\n`);
    out(`  node "/tmp/x"     ${path.resolve("/tmp/x")}\n`);
  }
  out("\n");
  if (!b.path) process.exit(EXIT_CANNOT_CHECK);
}

function sameVolume(a, b) {
  if (!IS_WIN) return true;
  return normCase(path.parse(path.resolve(a)).root) === normCase(path.parse(path.resolve(b)).root);
}

// ----------------------------------------------------------------- selftest
//
// Every case below is a skill that is broken in a way this tool is supposed to
// refuse, run through the real CLI as a child process. The two that matter most
// are "a smoke test is rejected" and "commit refuses a directory that never
// passed check", because those are the two gstack behaviours measured at the top
// of this file.

const FIXTURE_HTML = `<!doctype html>
<html><body>
<ol class="stories">
  <li class="story"><a class="u-url" href="https://example.com/one">First story</a><span class="score">42</span></li>
  <li class="story"><a class="u-url" href="https://example.com/two">Second story</a><span class="score">17</span></li>
  <li class="story"><a class="u-url" href="https://example.com/three">Third story</a><span class="score">3</span></li>
</ol>
</body></html>
`;

const GOOD_SCRIPT = `import fs from "node:fs";

export const TARGET_URL = "https://example.com/";

export function parseFromHtml(html) {
  const items = [];
  const re = /<li class="story"><a class="u-url" href="([^"]+)">([^<]+)<\\/a><span class="score">(\\d+)<\\/span><\\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({ url: m[1], title: m[2], score: Number(m[3]) });
  }
  return items;
}

if (process.argv[1] && process.argv[1].endsWith("script.mjs")) {
  const html = fs.readFileSync(new URL("./fixtures/example-com-2026-08-13.html", import.meta.url), "utf8");
  process.stdout.write(JSON.stringify({ items: parseFromHtml(html) }) + "\\n");
}
`;

const REAL_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFromHtml } from "./script.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "fixtures", "example-com-2026-08-13.html"), "utf8");
const items = parseFromHtml(html);

test("returns rows from the bundled fixture", () => {
  assert.ok(items.length > 0, "no items parsed");
});

test("every row has a title, a url and a numeric score", () => {
  for (const it of items) {
    assert.equal(typeof it.title, "string");
    assert.ok(it.title.length > 0);
    assert.ok(it.url.startsWith("http"));
    assert.equal(typeof it.score, "number");
  }
});
`;

const SMOKE_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFromHtml } from "./script.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "fixtures", "example-com-2026-08-13.html"), "utf8");

test("the parser does not throw", () => {
  assert.doesNotThrow(() => parseFromHtml(html));
});
`;

function skillMd(name, { sha, bytes, capturedAt = "2026-01-01", extra = {} } = {}) {
  const f = {
    name,
    description: "Top stories from the example front page, as JSON.",
    host: "example.com",
    version: "1.0.0",
    source: "agent",
    trusted: "false",
    ...extra,
  };
  return `---
name: ${f.name}
description: ${f.description}
host: ${f.host}
version: ${f.version}
source: ${f.source}
trusted: ${f.trusted}
triggers:
  - scrape example front page
  - top stories on example.com
  - example frontpage
fixture:
  file: fixtures/example-com-2026-08-13.html
  sha256: ${sha}
  bytes: ${bytes}
  capturedAt: ${capturedAt}
---

# ${name}

Reads the example front page and returns one row per story.
`;
}

/**
 * Write a complete, passing example skill. This is what /skillify starts from:
 * copy it, replace the parser and the fixture, keep the shape. It is also what
 * the selftest mutates, so the template and the thing under test cannot drift
 * apart.
 */
function writeExample(dir, name = "lobsters-frontpage") {
  fs.mkdirSync(path.join(dir, "fixtures"), { recursive: true });
  const fixtureRel = path.join("fixtures", "example-com-2026-08-13.html");
  fs.writeFileSync(path.join(dir, fixtureRel), FIXTURE_HTML, "utf8");
  fs.writeFileSync(path.join(dir, "script.mjs"), GOOD_SCRIPT, "utf8");
  fs.writeFileSync(path.join(dir, "script.test.mjs"), REAL_TEST, "utf8");
  const buf = fs.readFileSync(path.join(dir, fixtureRel));
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd(name, { sha: sha256(buf), bytes: buf.length }), "utf8");
  return dir;
}

function cmdScaffold(flags) {
  if (!flags.out) cannotCheck(["--out <dir> is required"]);
  refuseAmbiguousTmp(flags.out);
  const dir = nativeAbs(flags.out);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) refuse([`${dir} is not empty`]);
  writeExample(dir, flags.name && !validateName(flags.name) ? flags.name : "lobsters-frontpage");
  out(`\n  SCAFFOLDED  ${dir}\n`);
  out(`  A complete skill that passes every gate. Replace the parser, the fixture and\n`);
  out(`  the frontmatter, keep the shape, then stage it.\n\n`);
}

function makeSource(tmp, label, mutate = () => {}) {
  const dir = writeExample(path.join(tmp, `src-${label}`));
  mutate(dir);
  return dir;
}

function cli(args, env, cwd) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 180000,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-skillify-selftest-"));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  const env = { TOOLBAY_STACK_STATE_DIR: state };
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const stageOf = (dir, name = "lobsters-frontpage") => {
    const r = cli(["stage", "--name", name, "--from", dir], env, tmp);
    const m = /STAGED\s+(.+)/.exec(r.out);
    return { status: r.status, path: m ? m[1].trim() : null, out: r.out };
  };

  // ---- naming: what gstack accepts and this refuses
  for (const [bad, why] of [
    ["../evil", "a path traversal"],
    ["Lobsters", "an uppercase name"],
    ["con", "the reserved device name con"],
    ["com1", "the reserved device name com1"],
    ["a".repeat(60), "a 60-character name"],
    ["-leading", "a leading dash"],
  ]) {
    const src = makeSource(tmp, `name-${crypto.randomBytes(3).toString("hex")}`);
    const r = cli(["stage", "--name", bad, "--from", src], env, tmp);
    check(`stage refuses ${why}`, r.status === EXIT_FAILED, `exit ${r.status}`);
  }

  // ---- staging hygiene
  {
    const src = makeSource(tmp, "no-script", (d) => fs.rmSync(path.join(d, "script.mjs")));
    const r = stageOf(src);
    check("stage refuses a tree with no script.mjs", r.status === EXIT_FAILED, `exit ${r.status}`);
  }
  {
    const src = makeSource(tmp, "planted-marker", (d) =>
      fs.writeFileSync(path.join(d, MARKER), JSON.stringify({ treeSha256: "deadbeef" }), "utf8"),
    );
    const r = stageOf(src);
    check("stage refuses a pre-planted verification marker", r.status === EXIT_FAILED, `exit ${r.status}`);
  }

  // ---- a good skill goes all the way through
  const goodSrc = makeSource(tmp, "good");
  const good = stageOf(goodSrc);
  check("stage accepts a well-formed skill", good.status === EXIT_OK && Boolean(good.path) && fs.existsSync(good.path ?? ""), `exit ${good.status}`);

  const goodCheck = cli(["check", "--dir", good.path], env, tmp);
  check("check passes a skill with a real test", goodCheck.status === EXIT_OK, `exit ${goodCheck.status}`);
  check(
    "check runs all 8 gates",
    (goodCheck.out.match(/^\s{2}(PASS|FAIL)\s{2}/gm) || []).length === GATE_COUNT,
    `${(goodCheck.out.match(/^\s{2}(PASS|FAIL)\s{2}/gm) || []).length} gate lines`,
  );

  // ---- THE headline: a smoke test is not a test
  {
    const src = makeSource(tmp, "smoke", (d) => fs.writeFileSync(path.join(d, "script.test.mjs"), SMOKE_TEST, "utf8"));
    const s = stageOf(src);
    const r = cli(["check", "--dir", s.path], env, tmp);
    const named = /still passes against an empty page/.test(r.out);
    check("check REJECTS a smoke test that passes on a gutted page", r.status === EXIT_FAILED && named, `exit ${r.status}, named the reason: ${named}`);
    const bunWouldPass = cli(["--test", path.join(s.path, "script.test.mjs")], {}, s.path);
    check("...even though the test itself passes, which is all gstack checks", bunWouldPass.status === 0, `node --test exit ${bunWouldPass.status}`);
  }

  // ---- parser and fixture gates
  const failCases = [
    [
      "check fails a parser that returns nothing",
      (d) => fs.writeFileSync(path.join(d, "script.mjs"), "export function parseFromHtml() { return []; }\n", "utf8"),
    ],
    [
      "check fails a parser whose rows are all empty",
      (d) =>
        fs.writeFileSync(
          path.join(d, "script.mjs"),
          'export function parseFromHtml() { return [{ title: "" }, { title: "" }]; }\n',
          "utf8",
        ),
    ],
    [
      "check fails a non-deterministic parser",
      (d) =>
        fs.writeFileSync(
          path.join(d, "script.mjs"),
          "export function parseFromHtml() { return [{ title: String(Math.random()) }]; }\n",
          "utf8",
        ),
    ],
    [
      "check fails a script that imports an npm package",
      (d) => fs.writeFileSync(path.join(d, "script.mjs"), `import cheerio from "cheerio";\n${GOOD_SCRIPT}`, "utf8"),
    ],
    [
      "check fails a script that imports from outside the skill",
      (d) => fs.writeFileSync(path.join(d, "script.mjs"), `import x from "../../secrets.mjs";\n${GOOD_SCRIPT}`, "utf8"),
    ],
    [
      "check fails a fixture that does not match its recorded hash",
      (d) => fs.appendFileSync(path.join(d, "fixtures", "example-com-2026-08-13.html"), "<!-- edited -->", "utf8"),
    ],
    [
      "check fails a zero-byte fixture",
      (d) => fs.writeFileSync(path.join(d, "fixtures", "example-com-2026-08-13.html"), "", "utf8"),
    ],
    [
      "check fails a script with a syntax error rather than calling it unknown",
      (d) => fs.writeFileSync(path.join(d, "script.mjs"), "export function parseFromHtml( { return [ }\n", "utf8"),
    ],
    [
      "check fails when SKILL.md has no fixture block",
      (d) => fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: lobsters-frontpage\nsource: agent\ntrusted: false\n---\n", "utf8"),
    ],
    [
      "check fails when the frontmatter name does not match the directory",
      (d) => {
        const buf = fs.readFileSync(path.join(d, "fixtures", "example-com-2026-08-13.html"));
        fs.writeFileSync(path.join(d, "SKILL.md"), skillMd("something-else", { sha: sha256(buf), bytes: buf.length }), "utf8");
      },
    ],
  ];
  for (const [name, mutate] of failCases) {
    const src = makeSource(tmp, `f-${crypto.randomBytes(3).toString("hex")}`, mutate);
    const s = stageOf(src);
    if (s.status !== EXIT_OK) {
      check(name, s.status === EXIT_FAILED, `refused at stage (exit ${s.status})`);
      continue;
    }
    const r = cli(["check", "--dir", s.path], env, tmp);
    check(name, r.status === EXIT_FAILED, `exit ${r.status}`);
  }

  // ---- a hanging test is a failure, not a pass
  {
    const src = makeSource(tmp, "hang", (d) =>
      fs.writeFileSync(
        path.join(d, "script.test.mjs"),
        `${REAL_TEST}\nconst until = Date.now() + 30000;\nwhile (Date.now() < until) {}\n`,
        "utf8",
      ),
    );
    const s = stageOf(src);
    const r = cli(["check", "--dir", s.path, "--timeout-ms", "4000"], env, tmp);
    check("check fails a test that hangs", r.status === EXIT_FAILED, `exit ${r.status}`);
  }

  // ---- commit gating
  {
    const src = makeSource(tmp, "uncommitted");
    const s = stageOf(src);
    const r = cli(["commit", "--dir", s.path], env, tmp);
    const named = /never passed "check"/.test(r.out);
    check("commit refuses a skill that never passed check (gstack commits it)", r.status === EXIT_FAILED && named, `exit ${r.status}`);
  }
  {
    const src = makeSource(tmp, "tampered");
    const s = stageOf(src);
    cli(["check", "--dir", s.path], env, tmp);
    fs.appendFileSync(path.join(s.path, "script.mjs"), "\n// slipped in after the check\n", "utf8");
    const r = cli(["commit", "--dir", s.path], env, tmp);
    check("commit refuses files edited after they passed", r.status === EXIT_FAILED && /changed after they passed/.test(r.out), `exit ${r.status}`);
  }

  // ---- the happy path lands
  const commit = cli(["commit", "--dir", good.path], env, tmp);
  const dest = /COMMITTED\s+(.+)/.exec(commit.out)?.[1]?.trim() ?? null;
  check(
    "commit installs a checked skill",
    commit.status === EXIT_OK && Boolean(dest) && fs.existsSync(path.join(dest ?? "", "script.mjs")),
    dest ?? `exit ${commit.status}`,
  );
  check("the staging directory is gone afterwards", !fs.existsSync(good.path), good.path);

  // ---- collisions
  {
    const src = makeSource(tmp, "collide");
    const s = stageOf(src);
    cli(["check", "--dir", s.path], env, tmp);
    const r = cli(["commit", "--dir", s.path], env, tmp);
    check("commit refuses to clobber an installed skill of the same name", r.status === EXIT_FAILED && /already lives at/.test(r.out), `exit ${r.status}`);
  }
  {
    // The installed skill is renamed to a different case. On Windows that is
    // still the same directory, so the commit must be refused; on a
    // case-sensitive filesystem it is a different skill and must be allowed.
    const installed = path.join(state, "browser-skills", "lobsters-frontpage");
    const upper = path.join(state, "browser-skills", "LOBSTERS-FRONTPAGE");
    const src = makeSource(tmp, "case");
    const s = stageOf(src);
    cli(["check", "--dir", s.path], env, tmp);
    fs.renameSync(installed, upper);
    const r = cli(["commit", "--dir", s.path], env, tmp);
    const expected = IS_WIN ? EXIT_FAILED : EXIT_OK;
    check(
      IS_WIN
        ? "commit refuses an installed name that differs only in case"
        : "commit allows an installed name that differs only in case (posix)",
      r.status === expected,
      `exit ${r.status}, expected ${expected}`,
    );
    if (!IS_WIN && fs.existsSync(installed)) rmrf(installed);
    fs.renameSync(upper, installed);
    if (fs.existsSync(s.path)) rmrf(s.path);
  }

  // ---- verify
  const committed = path.join(state, "browser-skills", "lobsters-frontpage");
  {
    const r = cli(["verify", "--dir", committed], env, tmp);
    const measured = /\d+ms best of/.test(r.out);
    check("verify passes a committed skill and prints a measured runtime", r.status === EXIT_OK && measured, `exit ${r.status}, measured: ${measured}`);
  }
  {
    const expectFile = path.join(tmp, "prototype-wrong.json");
    fs.writeFileSync(expectFile, JSON.stringify([{ url: "https://example.com/one", title: "Different", score: 42 }]), "utf8");
    const r = cli(["verify", "--dir", committed, "--expect", expectFile], env, tmp);
    check("verify fails when the output drifted from the prototype", r.status === EXIT_FAILED, `exit ${r.status}`);
  }
  {
    const expectFile = path.join(tmp, "prototype-right.json");
    fs.writeFileSync(
      expectFile,
      JSON.stringify([
        { url: "https://example.com/one", title: "First story", score: 42 },
        { url: "https://example.com/two", title: "Second story", score: 17 },
        { url: "https://example.com/three", title: "Third story", score: 3 },
      ]),
      "utf8",
    );
    const r = cli(["verify", "--dir", committed, "--expect", expectFile], env, tmp);
    check("verify passes when the output matches the prototype", r.status === EXIT_OK, `exit ${r.status}`);
  }
  {
    const r = cli(["verify", "--dir", committed, "--max-age-days", "30"], env, tmp);
    check("verify fails a fixture older than the age limit", r.status === EXIT_FAILED, `exit ${r.status}`);
  }
  {
    fs.appendFileSync(path.join(committed, "script.mjs"), "\n// edited in place after install\n", "utf8");
    const r = cli(["verify", "--dir", committed], env, tmp);
    check("verify notices an installed skill edited after it was checked", r.status === EXIT_FAILED, `exit ${r.status}`);
  }

  // ---- discard
  {
    const src = makeSource(tmp, "discard");
    const s = stageOf(src);
    const r = cli(["discard", "--dir", s.path], env, tmp);
    check("discard removes the staged directory and proves it", r.status === EXIT_OK && !fs.existsSync(s.path), `exit ${r.status}`);
  }
  {
    const r = cli(["discard", "--dir", path.join(tmp, "src-good")], env, tmp);
    check("discard refuses a directory it did not stage", r.status === EXIT_FAILED && fs.existsSync(path.join(tmp, "src-good")), `exit ${r.status}`);
  }

  // ---- capture fails closed
  {
    const r = cli(["capture", "--url", "https://example.com/", "--out", path.join(tmp, "cap")], { ...env, TOOLBAY_SKILLIFY_BROWSE: path.join(tmp, "no-such-browse.mjs") }, tmp);
    const wroteNothing = !fs.existsSync(path.join(tmp, "cap", "fixtures"));
    check("capture writes no fixture when the browser cannot be reached", r.status === EXIT_CANNOT_CHECK && wroteNothing, `exit ${r.status}, wrote nothing: ${wroteNothing}`);
  }

  // ---- the count guard, same idea as tb-guard's
  const EXPECTED = 39;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    pass: results.length + 1 === EXPECTED,
    detail: `${results.length + 1} ran; a selftest whose size depends on where it was run from can quietly stop asserting`,
  });

  rmrf(tmp);

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-skillify selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}\n`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    out(`\n  Not trustworthy in this state:\n`);
    for (const r of failed) out(`    - ${r.name}: ${r.detail}\n`);
    out("\n");
    process.exit(EXIT_FAILED);
  }
  out(`\n  Every skill above is broken in a way gstack's /skillify would have written to disk,\n`);
  out(`  and every one of them was refused before anything was installed.\n\n`);
}

// -------------------------------------------------------------------- entry

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function help() {
  out(`
  tb-skillify ${VERSION}, codify a working scrape into a skill that stays working

    stage    --name <n> --from <dir> [--tier global|project]
             validate the files you wrote and copy them next to their destination
    check    --dir <staged> [--timeout-ms N]
             8 gates, including: the test must FAIL against a gutted fixture.
             Writes the verification marker that commit requires.
    commit   --dir <staged>
             move it into place. Refuses anything that did not pass check as
             these exact bytes.
    discard  --dir <staged>
             remove it, and prove it is gone.
    verify   --dir <skill> [--expect <json>] [--runs N] [--max-age-days N]
             replay the bundled fixture, measure the runtime, and compare against
             what the prototype produced.
    capture  --url <u> --out <dir>
             fetch a fixture through the browse skill. Refuses to write an empty
             one.
    list, doctor, selftest

  Exit 0 good, 1 a gate failed, 2 the check could not run. 1 and 2 are both
  failures. Nothing is ever installed on a check this tool could not perform.
`);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags } = parseFlags(argv);
  switch (cmd) {
    case "stage":
      return cmdStage(flags);
    case "check":
      return cmdCheck(flags);
    case "commit":
      return cmdCommit(flags);
    case "discard":
      return cmdDiscard(flags);
    case "verify":
      return cmdVerify(flags);
    case "capture":
      return cmdCapture(flags);
    case "scaffold":
      return cmdScaffold(flags);
    case "list":
      return cmdList();
    case "doctor":
      return cmdDoctor();
    case "selftest":
      return selftest();
    default:
      return help();
  }
}

try {
  main();
} catch (e) {
  // A crash is never a pass. Anything unhandled exits as "could not check".
  errOut(`\n  CANNOT CHECK\n  tb-skillify crashed: ${e?.stack ?? e}\n\n`);
  process.exit(EXIT_CANNOT_CHECK);
}
