#!/usr/bin/env node
/**
 * tb-context.mjs: the Toolbay Stack working-context engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /context-save
 * command, its save and list modes, the frontmatter fields status / branch /
 * timestamp / files_modified, the Summary / Decisions Made / Remaining Work /
 * Notes body sections, the append-only saved-file rule, the timestamped
 * `YYYYMMDD-HHMMSS-title.md` filename, and the pairing with /context-restore)
 * comes from `context-save` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY IT WAS REWRITTEN RATHER THAN FORKED LINE FOR LINE
 *
 * gstack's context-save is a page of bash plus an instruction to the model to
 * write a file and then print a "CONTEXT SAVED" banner. Nothing between those
 * two steps checks that the file landed. On Windows three of its steps do not
 * work at all, and every one of them fails in the direction that matters least
 * on a Mac and most here: it fails OPEN, reporting success.
 *
 * Reproduced on Windows 11, gstack 1.60.1.0, Git Bash + PowerShell, 2026-08-13:
 *
 *   1. THE SAVE PATH POINTS AT THE WRONG DRIVE LOCATION.
 *      gstack computes the destination with `eval "$(gstack-paths)"`, which on
 *      this machine prints:
 *          GSTACK_STATE_ROOT=/c/Users/orion/.gstack
 *      and the skill then says "Write the file to the $FILE path printed above
 *      (use the exact string)". That string is an MSYS path. Every Windows-native
 *      writer resolves it against the current drive root:
 *          node -e "path.resolve('/c/Users/orion/.gstack/...')"
 *          -> C:\c\Users\orion\.gstack\...
 *      So the save lands in C:\c\Users\..., the list step looks in
 *      C:\Users\orion\.gstack\..., and the user is told their work was saved.
 *
 *   2. THE LIST STEP SILENTLY REPORTS "NO SAVED CONTEXTS".
 *      Its list command is `find "$DIR" -maxdepth 1 -name "*.md" -type f`. Run
 *      through PowerShell, which is the primary shell on this platform, `find`
 *      is Windows' find.exe:
 *          FIND: Parameter format not correct
 *      exit 2, nothing on stdout. The skill's own else-branch only prints
 *      NO_CHECKPOINTS when the directory is missing, so the model sees an empty
 *      list next to an existing directory and says "No saved contexts yet."
 *      The saves are right there on disk.
 *
 *   3. SESSION DURATION IS DEAD CODE HERE.
 *      `ps -o lstart= -p $PPID | xargs -I{} date -jf "%c" "{}" "+%s"` uses BSD
 *      flags. On this machine:
 *          ps: unknown option -- o
 *          date: unknown option -- j
 *      and $PPID is 1 in the tool's Git Bash. The `$_TEL_START` branch above it
 *      cannot fire either, because that variable is set in the preamble's shell
 *      and each tool call is a fresh shell. Duration is therefore always unknown,
 *      which is not itself harmful; printing a field nobody measured would be.
 *
 * So the design rules here are:
 *
 *   1. THE BANNER IS EVIDENCE, NOT A CLAIM. Nothing prints "CONTEXT SAVED"
 *      until the file has been re-read off disk, its frontmatter re-parsed, and
 *      the sha256 of its body recomputed and matched. If any of that fails the
 *      exit code is non-zero and the message says the save did NOT land.
 *   2. FAIL CLOSED ON AN EMPTY CAPTURE. A context file with no remaining work
 *      and no summary is worse than no file: /context-restore will read it and
 *      resume from nothing. A payload that captures nothing is refused.
 *   3. NO INTERPRETER BUT NODE, AND NO POSIX ASSUMPTIONS. No find, no ps, no
 *      date, no /dev/urandom, no eval of a shell fragment, no MSYS paths handed
 *      to a Windows writer. Paths are resolved here, absolute and native.
 *   4. PROVE IT. `selftest` runs this executable as a child process against
 *      deliberately broken inputs, including the two Windows failures above,
 *      and fails loudly if any of them is allowed to read as success.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import {
  TIME_FIELD,
  readSavedTime,
  isoLocal,
  fileStamp,
  contextSlug,
  saveProjectSlug,
} from "./tb-context-format.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const SCHEMA = "toolbay-stack/context@1";
const isWindows = process.platform === "win32";

/**
 * Exit codes, because callers script this.
 *   0  the thing asked for happened
 *   1  a check failed (verify, selftest, an unreadable saved file)
 *   2  unusable: bad usage, or an environment this cannot write to
 *   3  refused: the payload does not carry enough context to be worth saving
 *   4  the save did not land: the write or the read-back failed
 */
const EXIT = { OK: 0, CHECK_FAILED: 1, UNUSABLE: 2, REFUSED: 3, NOT_LANDED: 4 };

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

// ------------------------------------------------------------- path handling
//
// Everything platform-specific lives here. `/c/Users/...` is what Git Bash and
// gstack-paths print; handing it to any Windows-native writer produces
// C:\c\Users\..., which is failure #1 at the top of this file.

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  s = fromMsysPath(s);
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

/** True when `target` is the boundary itself or lives underneath it. */
function isInside(boundary, target) {
  const norm = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
  const b = norm(boundary).replace(/[\\/]+$/, "");
  const t = norm(target);
  return t === b || t.startsWith(b + path.sep) || t.startsWith(`${b}/`);
}

// ------------------------------------------------------------- state layout

function stateDir(override) {
  const raw = override || process.env.TOOLBAY_STACK_STATE_DIR;
  if (raw) {
    const abs = toAbsolute(raw);
    if (!abs) return { error: `state dir "${raw}" could not be resolved to an absolute path` };
    return { dir: abs };
  }
  return { dir: path.join(os.homedir(), ".toolbay-stack") };
}

/**
 * Filesystem-safe, lowercase, ASCII. Never empty, never a path fragment.
 *
 * Shared with /context-restore through tb-context-format.mjs, because the drawer
 * name it produces is the directory the restore side has to look in. Two private
 * copies of this rule meant restore searched a directory nothing ever wrote to.
 */
const slugify = contextSlug;

/**
 * Which project this context belongs to.
 *
 * The git toplevel when there is one, so the same project keeps one drawer from
 * any subdirectory or worktree; the working directory's name otherwise. gstack
 * shells out to `gstack-slug`, which returned SLUG=orion when run from the home
 * directory on this machine, i.e. everything saved outside a repo shares one
 * drawer named after the user.
 */
const projectSlug = saveProjectSlug;

function contextsDir(state, slug) {
  return path.join(state, "projects", slug, "contexts");
}

// ------------------------------------------------------------------ git read
//
// Run by this process and reported as fact or as unavailable. Never inferred,
// never transcribed by a model from scrollback.

function git(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" },
  });
  if (res.error) return { ok: false, reason: `git could not be run (${res.error.code || res.error.message})` };
  if (res.status !== 0) {
    return { ok: false, status: res.status, stderr: (res.stderr || "").trim(), stdout: (res.stdout || "").trim() };
  }
  return { ok: true, stdout: (res.stdout || "").replace(/\r\n/g, "\n") };
}

/** Parse `git status --porcelain=v1 -z`, which is the only quoting-proof form. */
function parsePorcelainZ(raw) {
  const fields = raw.split("\0").filter((s) => s.length > 0);
  const files = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const origin = fields[i + 1];
      i += 1;
      files.push({ status: `${x}${y}`.trim(), path: p, from: origin });
    } else {
      files.push({ status: `${x}${y}`.trim(), path: p });
    }
  }
  return files;
}

/**
 * @returns {{state:"ok"|"none"|"unreadable", ...}}
 *
 * "none" means this is simply not a repository, which is a legitimate place to
 * save context from. "unreadable" means there IS a repository and git could not
 * answer about it; that is recorded as unreadable rather than written out as
 * `branch: unknown`, because a saved file that states a branch nobody read is
 * how /context-restore ends up resuming the wrong work.
 */
/**
 * Directories git itself refuses to search above, read from
 * GIT_CEILING_DIRECTORIES (`;`-separated on Windows, `:` elsewhere; a leading
 * `!` only affects symlink resolution and carries no meaning for us).
 */
function gitCeilings() {
  const raw = process.env.GIT_CEILING_DIRECTORIES;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(isWindows ? ";" : ":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(fromMsysPath(s.replace(/^!/, ""))));
}

const samePath = (a, b) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * THE WALK STOPS WHERE GIT STOPS. This exists only to second-guess git's "not a
 * git repository", and a second opinion that ignores the boundary git was given
 * turns a directory git correctly called un-tracked into "there IS a .git here
 * that git could not read" — an alarming sentence about somebody else's
 * repository, written into a saved context as fact.
 */
function hasDotGitAbove(start) {
  const ceilings = gitCeilings();
  let cur = path.resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(path.join(cur, ".git"))) return path.join(cur, ".git");
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (ceilings.some((c) => samePath(c, parent))) return null;
    cur = parent;
  }
  return null;
}

function gitState(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) {
    if (top.reason) return { state: "unreadable", detail: top.reason };
    // git says "not a git repository" both when there is no repository and when
    // there IS a .git that it cannot follow (a gitfile pointing nowhere, a
    // corrupt HEAD). Those are different facts and only one of them is safe to
    // write down as "no repository", so the presence of .git decides, not the
    // wording of the error.
    const dotgit = hasDotGitAbove(cwd);
    if (dotgit) return { state: "unreadable", detail: `${dotgit} exists but git could not read it: ${top.stderr || `git exited ${top.status}`}` };
    const msg = `${top.stderr || ""}`.toLowerCase();
    if (/not a git repository|no such file or directory/.test(msg)) return { state: "none", detail: "not a git repository" };
    return { state: "unreadable", detail: top.stderr || `git exited ${top.status}` };
  }
  const root = path.resolve(fromMsysPath(top.stdout.trim()));

  const sym = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  const branch = sym.ok && sym.stdout.trim() ? sym.stdout.trim() : "(detached)";

  const head = git(["rev-parse", "--short", "HEAD"], cwd);
  const headSha = head.ok ? head.stdout.trim() : "(no commits yet)";

  // THE SURVEY IS LAZY, AND THAT IS A CORRECTNESS-NEUTRAL SPEED FIX.
  //
  // Everything above is three cheap git calls. Everything below walks the whole
  // working tree, and how long that takes is a property of the tree, not of this
  // program: measured by tools/backtest.mjs at 7.8 SECONDS on a checkout whose
  // enclosing repository was a home directory. It was being paid by every save,
  // including the ones refused two statements later for a payload that captures
  // nothing — a refusal that writes no file and reads none of these fields.
  //
  // So they are getters. Any reader gets exactly the values it got before, and a
  // caller that never touches them never starts the processes. The four commands
  // that only want `branch` (`where`, `list`, the post-write branch check) and
  // every refusal path now cost three git calls instead of a tree walk.
  let survey = null;
  const runSurvey = () => {
    if (survey) return survey;
    // `--untracked-files=all`, not `normal`. With `normal`, git collapses an
    // entirely-untracked directory into a single entry `src/`, and that is what
    // landed in files_modified. /context-restore then checks every recorded path
    // against the working tree and requires a FILE, so a context saved ten
    // seconds earlier came back REFUSED: "all 1 recorded files are gone: src/".
    // The frontmatter field is called files_modified and a future session reads
    // it to know what was touched; `src/` does not answer that question either.
    const st = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    const files = st.status === 0 ? parsePorcelainZ(st.stdout || "") : null;
    const unstaged = git(["diff", "--shortstat"], cwd);
    const staged = git(["diff", "--cached", "--shortstat"], cwd);
    const log = git(["log", "--oneline", "-10", "--no-decorate"], cwd);
    survey = {
      files: files ?? [],
      filesReadable: files !== null,
      unstaged: unstaged.ok ? unstaged.stdout.trim() : "",
      staged: staged.ok ? staged.stdout.trim() : "",
      log: log.ok ? log.stdout.trim() : "",
    };
    return survey;
  };

  const g = { state: "ok", root, branch, head: headSha };
  for (const key of ["files", "filesReadable", "unstaged", "staged", "log"]) {
    Object.defineProperty(g, key, { enumerable: true, configurable: true, get: () => runSurvey()[key] });
  }
  return g;
}

// ---------------------------------------------------------------- the payload
//
// The model supplies the part only the model knows. Everything else on the page
// is measured. A payload that captures nothing is refused: see rule 2.

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (e) {
    return { error: `stdin could not be read (${e.code || e.message})` };
  }
}

function loadPayload(spec) {
  let raw;
  if (!spec || spec === "-") {
    if (process.stdin.isTTY) {
      return { error: "no payload: pass --payload <file>, or pipe JSON on stdin" };
    }
    raw = readStdinSync();
    if (raw && raw.error) return { error: raw.error };
  } else {
    const abs = toAbsolute(spec);
    if (!abs) return { error: `payload path "${spec}" could not be resolved` };
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch (e) {
      return { error: `payload file ${abs} could not be read (${e.code || e.message})` };
    }
  }
  const text = String(raw).replace(/^\uFEFF/, "").trim();
  if (!text) return { error: "the payload was empty" };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { error: `the payload is not valid JSON (${e.message})` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "the payload is not a JSON object" };
  return { payload: obj };
}

const asLines = (v) => {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean);
  }
  return [];
};

const STATUSES = new Set(["in-progress", "blocked", "completed"]);

/**
 * The refusal rule, stated once so it can be argued with.
 *
 * A save is worth writing when a future session could act on it: it has to say
 * what the work IS, and it has to say what is left (or say plainly that nothing
 * is, by being marked completed). gstack writes whatever the model produces,
 * including a file whose four sections are all empty, and then prints the same
 * success banner over it.
 */
function validatePayload(p) {
  const problems = [];
  const summary = String(p.summary ?? "").trim();
  const decisions = asLines(p.decisions);
  const remaining = asLines(p.remaining);
  const notes = asLines(p.notes);
  const status = String(p.status ?? "in-progress").trim() || "in-progress";

  if (summary.length < 20) {
    problems.push(`summary is ${summary.length} characters; a context worth restoring needs at least 20`);
  }
  if (!STATUSES.has(status)) {
    problems.push(`status "${status}" is not one of ${[...STATUSES].join(", ")}`);
  }
  if (status !== "completed" && remaining.length === 0) {
    problems.push('remaining is empty and status is not "completed"; a restore would have nothing to pick up');
  }
  return { problems, value: { summary, decisions, remaining, notes, status, title: String(p.title ?? "").trim() } };
}

// ------------------------------------------------------------- frontmatter IO

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** One line, no control characters, always emitted quoted so a colon is safe. */
function scalar(v) {
  const s = String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `"${s}"`;
}

function renderFrontmatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${scalar(item)}`);
    } else {
      lines.push(`${k}: ${scalar(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Split a saved file into its first frontmatter block and everything after.
 *
 * Deliberately non-greedy and first-block-only: a body containing a `---` line,
 * or a summary that a model pasted a whole frontmatter block into, cannot
 * redefine the fields. The selftest asserts that.
 */
function splitDocument(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { error: "the file has no frontmatter block" };
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const inline = kv[2].trim();
    if (inline) {
      fields[key] = inline.replace(/^["']|["']$/g, "");
      continue;
    }
    const items = [];
    let j = i + 1;
    while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
      items.push(lines[j].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
      j += 1;
    }
    if (items.length) {
      fields[key] = items;
      i = j - 1;
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

const REQUIRED_FIELDS = ["status", "branch", "title"];

/**
 * Is this file a saved context that /context-restore can actually act on.
 *
 * "Can actually act on" is now checked against what /context-restore really
 * requires, because this function used to accept `saved_at` OR `timestamp`
 * while restore accepted only `timestamp` — so this verify certified its own
 * engine's output as restorable when no restore had ever read one. The shared
 * reader in tb-context-format.mjs is the same reader restore uses.
 *
 * Files already on disk carrying `saved_at` (this engine wrote it until the
 * field was unified) and legacy gstack files carrying `timestamp` and no
 * checksum are both accepted; refusing them would strand saves someone already
 * has. What is never accepted is a file missing a field a restore needs, or a
 * body that no longer matches the checksum recorded with it.
 */
function verifyDocument(text, file) {
  const problems = [];
  const doc = splitDocument(text);
  if (doc.error) return { ok: false, problems: [doc.error], fields: {}, body: "" };
  const f = doc.fields;

  for (const key of REQUIRED_FIELDS) {
    if (!f[key] || !String(f[key]).trim()) problems.push(`frontmatter has no "${key}"`);
  }
  const when = readSavedTime(f);
  if (!when) problems.push(`frontmatter has no "${TIME_FIELD}", so /context-restore would reject this file`);
  else if (Number.isNaN(Date.parse(when))) problems.push(`"${when}" is not a parseable timestamp`);

  if (f.status && !STATUSES.has(String(f.status))) {
    problems.push(`status "${f.status}" is not one of ${[...STATUSES].join(", ")}`);
  }
  if (!doc.body.trim()) problems.push("the file has frontmatter but no body, so it records nothing");

  let checksum = "not recorded";
  if (f.body_sha256) {
    const actual = sha256(doc.body);
    if (actual === f.body_sha256) {
      checksum = "ok";
    } else {
      checksum = "MISMATCH";
      problems.push(
        `the body does not match the checksum saved with it (recorded ${String(f.body_sha256).slice(0, 12)}, actual ${actual.slice(0, 12)}); the file was truncated or edited after saving`,
      );
    }
  }
  if (f.files_modified_count !== undefined) {
    const declared = Number(f.files_modified_count);
    const listed = Array.isArray(f.files_modified) ? f.files_modified.length : 0;
    const truncated = Number(f.files_modified_truncated || 0);
    if (Number.isFinite(declared) && declared !== listed + truncated) {
      problems.push(`files_modified_count says ${declared} but ${listed} are listed and ${truncated} were dropped`);
    }
  }
  return { ok: problems.length === 0, problems, fields: f, body: doc.body, checksum, file };
}

// ---------------------------------------------------------------- session age

function sessionId() {
  return (
    process.env.TOOLBAY_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    "default"
  );
}

function sessionFile(state) {
  return path.join(state, "sessions", `${slugify(sessionId(), "default", 80)}.json`);
}

/**
 * Session length, or an honest statement that nobody measured it.
 *
 * gstack's BSD `ps`/`date` pipeline cannot run on Windows or Linux, so its field
 * is always absent there with no explanation. Here the number comes from a
 * marker this tool wrote itself, and when there is no marker the file says so in
 * words instead of leaving a reader to guess whether the session took no time.
 */
function sessionAge(state, explicitStart) {
  const now = Date.now();
  if (explicitStart) {
    const asNum = Number(explicitStart);
    const started = Number.isFinite(asNum) && asNum > 0 ? asNum * (asNum > 1e11 ? 1 : 1000) : Date.parse(explicitStart);
    if (!Number.isFinite(started)) return { seconds: null, source: `--session-start "${explicitStart}" is not a time` };
    return { seconds: Math.max(0, Math.round((now - started) / 1000)), source: "--session-start" };
  }
  const file = sessionFile(state);
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    const started = Date.parse(obj.started_at);
    if (!Number.isFinite(started)) return { seconds: null, source: `session marker ${file} has no readable start time` };
    return { seconds: Math.max(0, Math.round((now - started) / 1000)), source: `session marker (${sessionId()})` };
  } catch {
    return { seconds: null, source: "not measured: no session marker, run `tb-context session begin`" };
  }
}

function humanDuration(s) {
  if (s === null || s === undefined) return "unknown";
  const n = Number(s);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m}m ${n % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ------------------------------------------------------------- file discovery

function listFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return { files: [], missing: true };
    return { files: [], error: `${dir} could not be read (${e.code || e.message})` };
  }
  const files = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
    .map((d) => path.join(dir, d.name))
    // The YYYYMMDD-HHMMSS prefix is the canonical order: stable across copies,
    // rsync, and restores from backup, where mtime is not.
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return { files };
}

/**
 * Legacy gstack saves, so migrating does not mean losing the drawer.
 * `~/.gstack/projects/<slug>/checkpoints` is where gstack writes when its own
 * path plumbing works.
 */
function legacyDirs(slug) {
  const home = os.homedir();
  const roots = [process.env.GSTACK_HOME, path.join(home, ".gstack")].filter(Boolean);
  const dirs = [];
  for (const r of roots) {
    const abs = toAbsolute(r);
    if (!abs) continue;
    const d = path.join(abs, "projects", slug, "checkpoints");
    if (fs.existsSync(d) && !dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

// -------------------------------------------------------------------- commands

function resolveContext(opts) {
  const cwd = opts.cwd ? toAbsolute(opts.cwd) : process.cwd();
  const st = stateDir(opts.stateDir);
  if (st.error) return { error: st.error };
  const g = gitState(cwd);
  const slug = opts.slug ? slugify(opts.slug, "unknown", 48) : projectSlug(g.state === "ok" ? g.root : null, cwd);
  return { cwd, state: st.dir, git: g, slug, dir: contextsDir(st.dir, slug) };
}

function cmdSave(opts) {
  const ctx = resolveContext(opts);
  if (ctx.error) {
    err(`  UNUSABLE  ${ctx.error}`);
    return EXIT.UNUSABLE;
  }

  const loaded = loadPayload(opts.payload);
  if (loaded.error) {
    err(`  REFUSED  ${loaded.error}`);
    err(`  Nothing was written. A save is only worth printing a banner over if it captured something.`);
    return EXIT.REFUSED;
  }
  const { problems, value } = validatePayload(loaded.payload);
  if (problems.length) {
    err(`  REFUSED  this payload would produce a context file a restore cannot act on:`);
    for (const p of problems) err(`    - ${p}`);
    err(`  Nothing was written.`);
    return EXIT.REFUSED;
  }

  const titleRaw = (opts.title || value.title || "untitled").trim();
  const titleSlug = slugify(titleRaw, "untitled", 60);

  // Create the directory before anything else, so a state root that cannot be
  // written to fails here rather than after the model has been told it saved.
  try {
    fs.mkdirSync(ctx.dir, { recursive: true });
  } catch (e) {
    err(`  UNUSABLE  ${ctx.dir} could not be created (${e.code || e.message})`);
    return EXIT.UNUSABLE;
  }

  const now = new Date();
  // Local wall clock, from the shared helper. The frontmatter stamp below comes
  // from the same helper on the same clock: /context-restore compares the two
  // readings and calls an hour of disagreement disputed provenance, so a
  // filename in local time beside a frontmatter time in UTC would have made
  // every save restore as STALE on any machine that is not on UTC.
  const stamp = fileStamp(now);

  // Append-only, deterministically. gstack reaches for /dev/urandom here, which
  // does not exist outside a POSIX shell.
  let file = path.join(ctx.dir, `${stamp}-${titleSlug}.md`);
  for (let n = 2; fs.existsSync(file) && n < 1000; n += 1) {
    file = path.join(ctx.dir, `${stamp}-${titleSlug}-${n}.md`);
  }
  if (fs.existsSync(file)) {
    err(`  UNUSABLE  a thousand saves already share ${stamp}-${titleSlug}; refusing to overwrite one`);
    return EXIT.UNUSABLE;
  }
  // Windows still refuses most paths past 260 characters, and the failure mode
  // is an ENOENT that reads like a missing directory.
  if (isWindows && file.length > 250) {
    const shorter = slugify(titleSlug, "untitled", Math.max(8, 60 - (file.length - 250)));
    file = path.join(ctx.dir, `${stamp}-${shorter}.md`);
    if (file.length > 250) {
      err(`  UNUSABLE  the destination path is ${file.length} characters, past what Windows will open. Set TOOLBAY_STACK_STATE_DIR to something shorter.`);
      return EXIT.UNUSABLE;
    }
  }

  const g = ctx.git;
  const modified = g.state === "ok" ? g.files.map((f) => f.path) : [];
  const MAX_LISTED = 200;
  const listed = modified.slice(0, MAX_LISTED);
  const dropped = modified.length - listed.length;

  const age = sessionAge(ctx.state, opts.sessionStart);
  const previous = listFiles(ctx.dir).files[0] ?? null;
  let sincePrev = null;
  if (previous) {
    const prevDoc = splitDocument(fs.readFileSync(previous, "utf8"));
    const prevWhen = prevDoc.fields ? readSavedTime(prevDoc.fields) : null;
    const parsed = prevWhen ? Date.parse(prevWhen) : NaN;
    if (Number.isFinite(parsed)) sincePrev = Math.max(0, Math.round((now.getTime() - parsed) / 1000));
  }

  const bodyParts = [
    `## Working on: ${titleRaw}`,
    "",
    "### Summary",
    "",
    value.summary,
    "",
    "### Decisions Made",
    "",
    value.decisions.length ? value.decisions.map((d) => `- ${d}`).join("\n") : "- (none recorded)",
    "",
    "### Remaining Work",
    "",
    value.remaining.length ? value.remaining.map((d, i) => `${i + 1}. ${d}`).join("\n") : "(none: this work is finished)",
    "",
    "### Notes",
    "",
    value.notes.length ? value.notes.map((d) => `- ${d}`).join("\n") : "- (none recorded)",
    "",
    // Real command output, captured by this process. The point of putting it in
    // the file is that a future session reads evidence rather than a model's
    // recollection of what the tree looked like.
    "### Git state at save (captured by tb-context, not recalled)",
    "",
  ];
  if (g.state === "ok") {
    bodyParts.push("```");
    bodyParts.push(`branch   ${g.branch}`);
    bodyParts.push(`HEAD     ${g.head}`);
    bodyParts.push(`root     ${g.root}`);
    if (g.staged) bodyParts.push(`staged   ${g.staged}`);
    if (g.unstaged) bodyParts.push(`unstaged ${g.unstaged}`);
    bodyParts.push("");
    bodyParts.push(g.filesReadable ? "git status --porcelain:" : "git status could not be read");
    for (const f of g.files.slice(0, MAX_LISTED)) {
      bodyParts.push(`  ${f.status.padEnd(2)} ${f.path}${f.from ? `  (from ${f.from})` : ""}`);
    }
    if (!g.files.length && g.filesReadable) bodyParts.push("  (clean)");
    if (dropped > 0) bodyParts.push(`  ... and ${dropped} more`);
    if (g.log) {
      bodyParts.push("");
      bodyParts.push("git log --oneline -10:");
      for (const line of g.log.split("\n")) bodyParts.push(`  ${line}`);
    }
    bodyParts.push("```");
  } else if (g.state === "none") {
    bodyParts.push("Not a git repository, so there is no branch or diff to record.");
  } else {
    bodyParts.push(`Git is present but could not be read: ${g.detail}`);
    bodyParts.push("No branch or file list is claimed here, because none was measured.");
  }
  bodyParts.push("");
  const body = `${bodyParts.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;

  const frontmatter = renderFrontmatter({
    schema: SCHEMA,
    status: value.status,
    title: titleRaw,
    title_slug: titleSlug,
    project: ctx.slug,
    branch: g.state === "ok" ? g.branch : g.state === "none" ? "(no repository)" : "(git unreadable)",
    git: g.state,
    git_detail: g.state === "unreadable" ? g.detail : undefined,
    head: g.state === "ok" ? g.head : undefined,
    repo_root: g.state === "ok" ? g.root : undefined,
    // The field /context-restore reads. Local wall clock WITH its offset, so it
    // names the same instant AND the same digits as the filename stamp above.
    [TIME_FIELD]: isoLocal(now),
    session_duration_s: age.seconds === null ? "unknown" : String(age.seconds),
    session_duration_source: age.source,
    since_previous_save_s: sincePrev === null ? undefined : String(sincePrev),
    files_modified_count: String(modified.length),
    files_modified_truncated: dropped > 0 ? String(dropped) : undefined,
    files_modified: listed.length ? listed : undefined,
    body_sha256: sha256(body),
    tool: `tb-context ${VERSION}`,
    platform: `${process.platform} node ${process.version}`,
  });

  const text = `${frontmatter}\n${body}`;

  // Atomic: a half-written context file that still parses is the worst outcome
  // available, because it looks restorable.
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the temp file is not the story */
    }
    err(`  SAVE DID NOT LAND  ${file} could not be written (${e.code || e.message})`);
    return EXIT.NOT_LANDED;
  }

  // THE BANNER IS EVIDENCE. Everything below is read back off disk.
  let onDisk;
  try {
    onDisk = fs.readFileSync(file, "utf8");
  } catch (e) {
    err(`  SAVE DID NOT LAND  ${file} was written but could not be read back (${e.code || e.message})`);
    return EXIT.NOT_LANDED;
  }
  const check = verifyDocument(onDisk, file);
  if (!check.ok) {
    err(`  SAVE DID NOT LAND  ${file} is on disk but does not verify:`);
    for (const p of check.problems) err(`    - ${p}`);
    return EXIT.NOT_LANDED;
  }
  const bytes = Buffer.byteLength(onDisk, "utf8");

  const rule = "=".repeat(64);
  out("");
  out(`  CONTEXT SAVED   verified by re-reading the file, not by assuming the write worked`);
  out(`  ${rule}`);
  out(`  Title        ${check.fields.title}`);
  out(`  Status       ${check.fields.status}`);
  out(
    `  Branch       ${check.fields.branch}${
      g.state === "ok" ? `   (HEAD ${g.head})` : g.state === "unreadable" ? `   (git unreadable: ${g.detail})` : ""
    }`,
  );
  out(`  Project      ${ctx.slug}`);
  out(`  File         ${file}`);
  out(`  Size         ${bytes.toLocaleString("en-US")} bytes, body checksum ${check.checksum}`);
  out(`  Modified     ${modified.length} file(s)${dropped ? `, ${dropped} not listed` : ""}`);
  out(`  Session      ${age.seconds === null ? `unknown (${age.source})` : `${humanDuration(age.seconds)} (${age.source})`}`);
  if (sincePrev !== null) out(`  Since last   ${humanDuration(sincePrev)}`);
  out(`  ${rule}`);
  out("");
  out(`  Restore with:  node "${SELF}" show latest`);
  out(`  Re-check with: node "${SELF}" verify "${file}"`);
  out("");
  return EXIT.OK;
}

function cmdList(opts) {
  const ctx = resolveContext(opts);
  if (ctx.error) {
    err(`  UNUSABLE  ${ctx.error}`);
    return EXIT.UNUSABLE;
  }
  const sources = [{ label: "toolbay", dir: ctx.dir }];
  for (const d of legacyDirs(ctx.slug)) sources.push({ label: "gstack", dir: d });

  const rows = [];
  const troubles = [];
  for (const src of sources) {
    const res = listFiles(src.dir);
    if (res.error) {
      troubles.push(res.error);
      continue;
    }
    for (const f of res.files) {
      let text;
      try {
        text = fs.readFileSync(f, "utf8");
      } catch (e) {
        rows.push({ file: f, src: src.label, date: "?", title: path.basename(f), branch: "?", status: "UNREADABLE" });
        troubles.push(`${f} could not be read (${e.code || e.message})`);
        continue;
      }
      const v = verifyDocument(text, f);
      const when = readSavedTime(v.fields) || "";
      const date = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString().slice(0, 10) : path.basename(f).slice(0, 8);
      rows.push({
        file: f,
        src: src.label,
        date,
        title: v.fields.title || path.basename(f).replace(/^\d{8}-\d{6}-/, "").replace(/\.md$/, ""),
        branch: v.fields.branch || "?",
        status: v.ok ? v.fields.status || "?" : "UNREADABLE",
        problems: v.problems,
      });
      if (!v.ok) troubles.push(`${f}: ${v.problems[0]}`);
    }
  }

  const branchNow = ctx.git.state === "ok" ? ctx.git.branch : null;
  const visible = opts.all || !branchNow ? rows : rows.filter((r) => r.branch === branchNow);

  if (opts.json) {
    out(JSON.stringify({ dir: ctx.dir, project: ctx.slug, branch: branchNow, rows: visible, troubles }, null, 2));
    return troubles.length ? EXIT.CHECK_FAILED : EXIT.OK;
  }

  out("");
  out(`  SAVED CONTEXTS  ${opts.all ? "(all branches)" : branchNow ? `(${branchNow} branch)` : "(no repository here)"}`);
  out(`  project ${ctx.slug}   dir ${ctx.dir}`);
  out("");
  if (!visible.length) {
    if (rows.length) {
      out(`  none on this branch. ${rows.length} saved on other branches; pass --all to see them.`);
    } else {
      out("  none yet. Save one with: tb-context save --payload <file>");
    }
    out("");
    return troubles.length ? EXIT.CHECK_FAILED : EXIT.OK;
  }
  const w = (k, min) => Math.max(min, ...visible.map((r) => String(r[k]).length));
  const wt = Math.min(40, w("title", 5));
  const wb = Math.min(28, w("branch", 6));
  out(`  #   Date        ${"Title".padEnd(wt)}  ${"Branch".padEnd(wb)}  Status       Source`);
  out(`  ${"-".repeat(3)} ${"-".repeat(10)}  ${"-".repeat(wt)}  ${"-".repeat(wb)}  ${"-".repeat(11)}  ------`);
  visible.forEach((r, i) => {
    out(
      `  ${String(i + 1).padStart(2)}  ${r.date.padEnd(10)}  ${String(r.title).slice(0, wt).padEnd(wt)}  ${String(r.branch).slice(0, wb).padEnd(wb)}  ${String(r.status).padEnd(11)}  ${r.src}`,
    );
  });
  out("");
  if (troubles.length) {
    out("  Files that did not verify (listed above rather than hidden):");
    for (const t of troubles) out(`    ! ${t}`);
    out("");
    return EXIT.CHECK_FAILED;
  }
  return EXIT.OK;
}

function cmdShow(target, opts) {
  const ctx = resolveContext(opts);
  if (ctx.error) {
    err(`  UNUSABLE  ${ctx.error}`);
    return EXIT.UNUSABLE;
  }
  let file = null;
  if (!target || target === "latest") {
    const mine = listFiles(ctx.dir).files;
    const legacy = legacyDirs(ctx.slug).flatMap((d) => listFiles(d).files);
    const all = [...mine, ...legacy].sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    file = all[0] ?? null;
    if (!file) {
      err(`  NOTHING SAVED  no context files under ${ctx.dir}`);
      return EXIT.CHECK_FAILED;
    }
  } else {
    file = toAbsolute(target);
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    err(`  UNREADABLE  ${file} (${e.code || e.message})`);
    return EXIT.CHECK_FAILED;
  }
  const v = verifyDocument(text, file);
  out(`# ${file}`);
  if (!v.ok) {
    out("");
    out("> WARNING: this file does not verify. Treat what follows as unreliable:");
    for (const p of v.problems) out(`>   - ${p}`);
  }
  out("");
  out(text);
  return v.ok ? EXIT.OK : EXIT.CHECK_FAILED;
}

function cmdVerify(target, opts) {
  const files = [];
  if (target && target !== "all") {
    const abs = toAbsolute(target);
    if (!abs) {
      err(`  UNUSABLE  "${target}" could not be resolved`);
      return EXIT.UNUSABLE;
    }
    files.push(abs);
  } else {
    const ctx = resolveContext(opts);
    if (ctx.error) {
      err(`  UNUSABLE  ${ctx.error}`);
      return EXIT.UNUSABLE;
    }
    files.push(...listFiles(ctx.dir).files);
    if (!files.length) {
      out(`  nothing to verify under ${ctx.dir}`);
      return EXIT.OK;
    }
  }
  let bad = 0;
  out("");
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      out(`  FAIL  ${f}`);
      out(`        could not be read (${e.code || e.message})`);
      bad += 1;
      continue;
    }
    const v = verifyDocument(text, f);
    out(`  ${v.ok ? "OK  " : "FAIL"}  ${f}`);
    out(`        checksum ${v.checksum}, status ${v.fields.status || "?"}, branch ${v.fields.branch || "?"}`);
    for (const p of v.problems) out(`        - ${p}`);
    if (!v.ok) bad += 1;
  }
  out("");
  out(`  ${files.length - bad}/${files.length} verified`);
  out("");
  return bad ? EXIT.CHECK_FAILED : EXIT.OK;
}

function cmdSession(sub, opts) {
  const st = stateDir(opts.stateDir);
  if (st.error) {
    err(`  UNUSABLE  ${st.error}`);
    return EXIT.UNUSABLE;
  }
  const file = sessionFile(st.dir);
  if (sub === "begin") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && !opts.force) {
      const age = sessionAge(st.dir);
      out(`  session ${sessionId()} already running for ${humanDuration(age.seconds)}  (${file})`);
      return EXIT.OK;
    }
    fs.writeFileSync(file, `${JSON.stringify({ id: sessionId(), started_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    out(`  session ${sessionId()} started  (${file})`);
    return EXIT.OK;
  }
  if (sub === "end") {
    fs.rmSync(file, { force: true });
    out(`  session ${sessionId()} cleared`);
    return EXIT.OK;
  }
  const age = sessionAge(st.dir);
  out(`  session   ${sessionId()}`);
  out(`  duration  ${age.seconds === null ? "unknown" : humanDuration(age.seconds)}`);
  out(`  source    ${age.source}`);
  return EXIT.OK;
}

function cmdWhere(opts) {
  const ctx = resolveContext(opts);
  if (ctx.error) {
    err(`  UNUSABLE  ${ctx.error}`);
    return EXIT.UNUSABLE;
  }
  out("");
  out(`  cwd          ${ctx.cwd}`);
  out(`  git          ${ctx.git.state}${ctx.git.state === "ok" ? `  ${ctx.git.branch} @ ${ctx.git.head}` : ctx.git.detail ? `  ${ctx.git.detail}` : ""}`);
  out(`  project      ${ctx.slug}`);
  out(`  state dir    ${ctx.state}`);
  out(`  contexts     ${ctx.dir}`);
  for (const d of legacyDirs(ctx.slug)) out(`  legacy       ${d}  (gstack saves, read-only)`);
  out(`  saved files  ${listFiles(ctx.dir).files.length}`);
  out("");
  out(`  Every path above is absolute and native to ${process.platform}. Hand them to any tool as-is.`);
  out("");
  return EXIT.OK;
}

// ------------------------------------------------------------------ selftest

function run(args, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, TOOLBAY_SESSION_ID: "selftest", ...env },
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function writePayload(dir, name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return f;
}

const GOOD_PAYLOAD = {
  title: "auth refactor",
  summary: "Moving session handling off cookies and onto short-lived tokens so the mobile client stops getting logged out.",
  decisions: ["Tokens live 15 minutes, refresh in an httpOnly cookie", "No migration for existing sessions; they expire naturally"],
  remaining: ["Wire the refresh endpoint", "Delete the legacy cookie parser", "Add an expiry test"],
  notes: ["Tried a sliding-window cookie first; it broke Safari ITP"],
};

/**
 * Thrown by `required` when a precondition fails, so the rest of the selftest is
 * skipped instead of running on top of a fact that is not true.
 *
 * WHY THIS EXISTS. `check("...and the file is on disk", 1, saved().length)` used
 * to fail and then the very next line did `path.join(ctxDir(), saved()[0])` on
 * the empty array, so the engine died with a TypeError and a stack trace and
 * never printed "N/M passed" at all. The suite runner reads that line to decide
 * whether anything was asserted, so a selftest that CRASHES is indistinguishable
 * from a selftest that never ran — which is precisely the fail-open this whole
 * package exists to delete, sitting in our own test harness.
 */
class SelftestAborted extends Error {
  constructor(precondition) {
    super(`precondition failed: ${precondition}`);
    this.name = "SelftestAborted";
    this.precondition = precondition;
  }
}

function selftestBody({ tmp, check, required }) {
  const work = path.join(tmp, "work");
  fs.mkdirSync(work, { recursive: true });
  const state = path.join(tmp, "state");
  const ENV = { TOOLBAY_STACK_STATE_DIR: state, GSTACK_HOME: path.join(tmp, "no-gstack") };
  const ctxDir = () => path.join(state, "projects", "work", "contexts");
  const saved = () => (fs.existsSync(ctxDir()) ? fs.readdirSync(ctxDir()).filter((f) => f.endsWith(".md")) : []);

  // ---------------------------------------------------------- it works at all
  {
    const p = writePayload(tmp, "good.json", GOOD_PAYLOAD);
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    check("a real payload saves", EXIT.OK, r.status, r.all);
    // REQUIRED, not checked: every assertion below reads the file this one says
    // is there. Without a saved file they cannot be evaluated at all, and a
    // wrong answer is worse than a named refusal to answer.
    required("...and the file is on disk", 1, saved().length, `${ctxDir()} holds: ${saved().join(",") || "(nothing)"}`);
    check("...and the banner names a path that exists", true, (() => {
      const m = /File\s+(.+\.md)\s*$/m.exec(r.stdout);
      return Boolean(m && fs.existsSync(m[1].trim()));
    })(), r.stdout);
    const f = path.join(ctxDir(), saved()[0]);
    check("...and it verifies", EXIT.OK, run(["verify", f], { cwd: work, env: ENV }).status);
    const text = fs.readFileSync(f, "utf8");
    check("...and the body carries the remaining work", true, /Wire the refresh endpoint/.test(text));
    check("...and records that git was unreadable or absent rather than inventing a branch", true, /branch: "\(no repository\)"|branch: "\(git unreadable\)"/.test(text), text.slice(0, 400));
  }

  // ------------------------------- the file the OTHER engine has to be able to read
  //
  // These assert the three things /context-restore requires of this file. They
  // are not a substitute for the round trip in tools/seam-tests.mjs — a fixture
  // this engine wrote, checked by this engine, is exactly the shape of test that
  // let a 0%-functional feature ship green. They are here so that breaking the
  // contract fails HERE too, with the reason named, rather than only in a test
  // someone might run less often.
  {
    const p = writePayload(tmp, "contract.json", { ...GOOD_PAYLOAD, title: "restore contract" });
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    const file = /File\s+(.+\.md)\s*$/m.exec(r.stdout)[1].trim();
    const text = fs.readFileSync(file, "utf8");
    check("the save time is written under the field /context-restore requires", true, /^timestamp: /m.test(text), text.slice(0, 700));
    check("...and not under the old saved_at name, which restore never read", false, /^saved_at/m.test(text), text.slice(0, 700));
    // The filename stamp and the frontmatter stamp are two readings of one
    // clock. If they drift, restore reports disputed provenance and downgrades
    // an otherwise perfect restore to STALE.
    const nameStamp = /(\d{8})-(\d{6})-/.exec(path.basename(file));
    const fmStamp = /^timestamp: "([^"]+)"/m.exec(text);
    const iso = fmStamp ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(fmStamp[1]) : null;
    check(
      "the filename stamp and the frontmatter stamp read the same wall clock",
      nameStamp ? `${nameStamp[1]}-${nameStamp[2]}` : "(no filename stamp)",
      iso ? `${iso[1]}${iso[2]}${iso[3]}-${iso[4]}${iso[5]}${iso[6]}` : "(no frontmatter stamp)",
      fmStamp ? fmStamp[1] : text.slice(0, 400),
    );
    check("...and the frontmatter stamp states its UTC offset", true, Boolean(fmStamp) && /[+-]\d{2}:\d{2}$|Z$/.test(fmStamp[1]), fmStamp ? fmStamp[1] : "(none)");
    // A file written by the previous release carries saved_at. It is still a
    // real saved context and must not be orphaned by the rename.
    const legacyFile = path.join(ctxDir(), "20260101-090000-old-release.md");
    fs.writeFileSync(legacyFile, text.replace(/^timestamp: /m, "saved_at: "), "utf8");
    const lv = run(["verify", legacyFile], { cwd: work, env: ENV });
    check("a file saved by the previous release still verifies", EXIT.OK, lv.status, lv.stdout.slice(0, 400));
    fs.rmSync(legacyFile, { force: true });
  }

  // ------------------------------------------ fail closed on an empty capture
  {
    const cases = [
      ["an empty payload is refused", {}],
      ["a payload with only a title is refused", { title: "stuff" }],
      ["a one-word summary is refused", { summary: "wip", remaining: ["finish it"] }],
      ["a payload with no remaining work is refused", { summary: GOOD_PAYLOAD.summary, decisions: ["a"] }],
      ["an unknown status is refused", { ...GOOD_PAYLOAD, status: "probably-fine" }],
    ];
    const before = saved().length;
    for (const [name, obj] of cases) {
      const p = writePayload(tmp, `bad-${slugify(name)}.json`, obj);
      const r = run(["save", "--payload", p], { cwd: work, env: ENV });
      check(name, EXIT.REFUSED, r.status, r.all);
    }
    const r2 = run(["save", "--payload", writePayload(tmp, "notjson.json", "{ not json")], { cwd: work, env: ENV });
    check("a payload that is not JSON is refused", EXIT.REFUSED, r2.status, r2.all);
    const r3 = run(["save", "--payload", path.join(tmp, "does-not-exist.json")], { cwd: work, env: ENV });
    check("a missing payload file is refused", EXIT.REFUSED, r3.status, r3.all);
    check("...and none of those wrote a file", before, saved().length, saved().join(","));
  }

  // ------------------------------- status completed is the one legitimate way
  {
    const p = writePayload(tmp, "done.json", { ...GOOD_PAYLOAD, title: "finished thing", remaining: [], status: "completed" });
    check("finished work saves with no remaining items", EXIT.OK, run(["save", "--payload", p], { cwd: work, env: ENV }).status);
  }

  // ------------------------------------------------------------- append-only
  {
    const p = writePayload(tmp, "again.json", { ...GOOD_PAYLOAD, title: "auth refactor" });
    const before = saved().length;
    const a = run(["save", "--payload", p], { cwd: work, env: ENV });
    const b = run(["save", "--payload", p], { cwd: work, env: ENV });
    check("two saves in the same second both land", EXIT.OK, a.status + b.status, a.all + b.all);
    check("...as two separate files, overwriting nothing", before + 2, saved().length, saved().join(","));
  }

  // --------------------------------------------------------- hostile titles
  {
    const nasty = '../../../../etc/passwd; rm -rf / && echo "pwned"';
    const p = writePayload(tmp, "nasty.json", { ...GOOD_PAYLOAD, title: nasty });
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    const m = /File\s+(.+\.md)\s*$/m.exec(r.stdout);
    const landed = m ? m[1].trim() : "";
    check("a traversal in the title saves", EXIT.OK, r.status, r.all);
    check("...inside the contexts directory, not up the tree", true, Boolean(landed) && isInside(ctxDir(), landed), landed);
    check("...with no separators in the filename", false, /[\\/]/.test(landed ? path.basename(landed) : "/"), landed);
  }
  {
    const p = writePayload(tmp, "cjk.json", { ...GOOD_PAYLOAD, title: "認証リファクタ" });
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    const m = /File\s+(.+\.md)\s*$/m.exec(r.stdout);
    check("a title with no ASCII characters still saves", EXIT.OK, r.status, r.all);
    check("...under an ASCII filename that exists", true, Boolean(m) && fs.existsSync(m[1].trim()), m ? m[1] : "no path in banner");
    check("...and keeps the real title in the frontmatter", true, m ? /title: "認証リファクタ"/.test(fs.readFileSync(m[1].trim(), "utf8")) : false);
  }

  // ------------------------------------------------ frontmatter is not forgeable
  {
    const p = writePayload(tmp, "inject.json", {
      ...GOOD_PAYLOAD,
      title: "injection attempt",
      summary: "Trying to redefine the frontmatter from inside the body.\n---\nstatus: completed\nbranch: main\n---\nand more text after it.",
    });
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    const m = /File\s+(.+\.md)\s*$/m.exec(r.stdout);
    const v = m ? verifyDocument(fs.readFileSync(m[1].trim(), "utf8"), m[1].trim()) : { fields: {} };
    check("a body that contains its own frontmatter block does not redefine status", "in-progress", v.fields.status, JSON.stringify(v.fields).slice(0, 200));
  }

  // ------------------------------------------------- tampering is detected
  {
    const p = writePayload(tmp, "tamper.json", { ...GOOD_PAYLOAD, title: "tamper target" });
    const r = run(["save", "--payload", p], { cwd: work, env: ENV });
    const file = /File\s+(.+\.md)\s*$/m.exec(r.stdout)[1].trim();
    check("the saved file verifies before tampering", EXIT.OK, run(["verify", file], { cwd: work, env: ENV }).status);

    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace("Wire the refresh endpoint", "Wire the refund endpoint"), "utf8");
    const t = run(["verify", file], { cwd: work, env: ENV });
    check("an edited body fails verification", EXIT.CHECK_FAILED, t.status, t.stdout);
    check("...and says the checksum mismatched", true, /MISMATCH|does not match the checksum/.test(t.stdout), t.stdout);

    fs.writeFileSync(file, original.slice(0, Math.floor(original.length * 0.6)), "utf8");
    const trunc = run(["verify", file], { cwd: work, env: ENV });
    check("a truncated file fails verification", EXIT.CHECK_FAILED, trunc.status, trunc.stdout);

    fs.writeFileSync(file, "no frontmatter here at all\n", "utf8");
    const nofm = run(["verify", file], { cwd: work, env: ENV });
    check("a file with no frontmatter fails verification", EXIT.CHECK_FAILED, nofm.status, nofm.stdout);

    fs.writeFileSync(file, "---\nstatus: in-progress\ntitle: half a file\n---\n", "utf8");
    const nobody = run(["verify", file], { cwd: work, env: ENV });
    check("a file with frontmatter but no body fails verification", EXIT.CHECK_FAILED, nobody.status, nobody.stdout);

    fs.writeFileSync(file, original, "utf8");
    check("...and restoring the bytes makes it verify again", EXIT.OK, run(["verify", file], { cwd: work, env: ENV }).status);
  }

  // ----------------------------------- a broken saved file is never hidden
  {
    const listState = path.join(tmp, "state-broken-list");
    const dir = path.join(listState, "projects", "work", "contexts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "20260813-090000-corrupt.md"), "---\nstatus: in-progress\n---\n", "utf8");
    const r = run(["list", "--all"], { cwd: work, env: { ...ENV, TOOLBAY_STACK_STATE_DIR: listState } });
    check("list still shows a saved file that does not verify", true, /corrupt/.test(r.stdout), r.stdout);
    check("...and exits non-zero rather than pretending it is fine", EXIT.CHECK_FAILED, r.status, r.stdout);
  }

  // ----------------------------------------------- list without any shell tools
  {
    const r = run(["list", "--all"], { cwd: work, env: ENV });
    check("list finds the saves this run made", true, /auth refactor/.test(r.stdout), r.stdout.slice(0, 600));
    const j = run(["list", "--all", "--json"], { cwd: work, env: ENV });
    let parsed = null;
    try {
      parsed = JSON.parse(j.stdout);
    } catch {
      /* stays null */
    }
    check("list --json is machine readable", true, Boolean(parsed && Array.isArray(parsed.rows) && parsed.rows.length >= saved().length), j.stdout.slice(0, 300));
  }
  {
    const empty = path.join(tmp, "state-empty");
    const r = run(["list"], { cwd: work, env: { ...ENV, TOOLBAY_STACK_STATE_DIR: empty } });
    check("an empty drawer says so and exits clean", EXIT.OK, r.status, r.all);
    check("...in words, not as an empty screen", true, /none yet/.test(r.stdout), r.stdout);
  }

  // ------------------------------- the gstack Windows bugs, asserted directly
  {
    // Bug 1: an MSYS state path. gstack hands `/c/Users/...` straight to a
    // Windows writer, which resolves it against the drive root.
    const msys = isWindows
      ? `/${state[0].toLowerCase()}/${state.slice(3).replace(/\\/g, "/")}`
      : state;
    const p = writePayload(tmp, "msys.json", { ...GOOD_PAYLOAD, title: "msys path" });
    const r = run(["save", "--payload", p, "--state-dir", msys], { cwd: work, env: { ...ENV, TOOLBAY_STACK_STATE_DIR: "" } });
    const m = /File\s+(.+\.md)\s*$/m.exec(r.stdout);
    check("an MSYS-style state path saves", EXIT.OK, r.status, r.all);
    check("...into the real directory, not a drive-root copy of it", true, Boolean(m) && isInside(state, m[1].trim()), `${m ? m[1] : "no path"} should be under ${state}`);
    check("...and nothing appeared at the drive root", false, isWindows ? fs.existsSync(path.join(path.parse(state).root, "c")) : false, path.join(path.parse(state).root, "c"));
  }
  {
    // Bug 3: duration. Never a number nobody measured.
    const r = run(["save", "--payload", writePayload(tmp, "nosession.json", { ...GOOD_PAYLOAD, title: "no session marker" })], {
      cwd: work,
      env: { ...ENV, TOOLBAY_SESSION_ID: "no-marker-here" },
    });
    const file = /File\s+(.+\.md)\s*$/m.exec(r.stdout)[1].trim();
    const text = fs.readFileSync(file, "utf8");
    check("with no session marker the duration is written as unknown", true, /session_duration_s: "unknown"/.test(text), text.slice(0, 600));
    check("...with the reason recorded next to it", true, /session_duration_source: "not measured/.test(text), text.slice(0, 800));

    run(["session", "begin"], { cwd: work, env: { ...ENV, TOOLBAY_SESSION_ID: "measured" } });
    const r2 = run(["save", "--payload", writePayload(tmp, "session.json", { ...GOOD_PAYLOAD, title: "with session marker" })], {
      cwd: work,
      env: { ...ENV, TOOLBAY_SESSION_ID: "measured" },
    });
    const file2 = /File\s+(.+\.md)\s*$/m.exec(r2.stdout)[1].trim();
    check("with a session marker the duration is a number", true, /session_duration_s: "\d+"/.test(fs.readFileSync(file2, "utf8")), fs.readFileSync(file2, "utf8").slice(0, 600));
  }

  // ------------------------------------- an unwritable destination is not a save
  {
    const blocked = path.join(tmp, "state-is-a-file");
    fs.writeFileSync(blocked, "this is a file, not a directory\n", "utf8");
    const r = run(["save", "--payload", writePayload(tmp, "blocked.json", GOOD_PAYLOAD)], {
      cwd: work,
      env: { ...ENV, TOOLBAY_STACK_STATE_DIR: blocked },
    });
    check("a state dir that is really a file fails the save", EXIT.UNUSABLE, r.status, r.all);
    check("...loudly, on stderr", true, /UNUSABLE/.test(r.stderr), r.all.slice(0, 300));
  }

  // ------------------------------------------------------ git is read, not told
  {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const gitOk = spawnSync("git", ["init", "-q", "-b", "tb-test-branch"], { cwd: repo, encoding: "utf8", windowsHide: true }).status === 0;
    if (gitOk) {
      fs.writeFileSync(path.join(repo, "a file with spaces.txt"), "hello\n", "utf8");
      fs.writeFileSync(path.join(repo, "plain.txt"), "hi\n", "utf8");
      const r = run(["save", "--payload", writePayload(tmp, "repo.json", { ...GOOD_PAYLOAD, title: "in a repo" })], { cwd: repo, env: ENV });
      const file = /File\s+(.+\.md)\s*$/m.exec(r.stdout)?.[1].trim();
      const text = file ? fs.readFileSync(file, "utf8") : "";
      check("a save inside a repo records the real branch", true, /branch: "tb-test-branch"/.test(text), text.slice(0, 500));
      check("...and lists a path containing spaces unmangled", true, /a file with spaces\.txt/.test(text), text.slice(0, 1200));
      check("...and files_modified_count matches what git reported", true, /files_modified_count: "2"/.test(text), text.slice(0, 900));
    } else {
      check("a save inside a repo records the real branch", "git available", "git not on PATH", "skipped: git init failed");
      check("...and lists a path containing spaces unmangled", "git available", "git not on PATH", "skipped");
      check("...and files_modified_count matches what git reported", "git available", "git not on PATH", "skipped");
    }
  }
  {
    // A .git that git cannot make sense of. The save must still happen (losing
    // the user's context because git is broken would be the worse bug) but it
    // must not print a branch nobody read.
    const broken = path.join(tmp, "broken-repo");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, ".git"), "gitdir: nowhere-at-all\n", "utf8");
    const r = run(["save", "--payload", writePayload(tmp, "brokenrepo.json", { ...GOOD_PAYLOAD, title: "broken repo" })], { cwd: broken, env: ENV });
    const file = /File\s+(.+\.md)\s*$/m.exec(r.stdout)?.[1].trim();
    const text = file ? fs.readFileSync(file, "utf8") : "";
    check("a corrupt repository still saves the context", EXIT.OK, r.status, r.all.slice(0, 300));
    check("...but claims no branch", true, /branch: "\(git unreadable\)"/.test(text), text.slice(0, 500));
    check("...and says why in the file", true, /git_detail:/.test(text), text.slice(0, 700));
  }

  // ------------------------------------------------------------------ usage
  {
    check("an unknown command is refused", EXIT.UNUSABLE, run(["nonsense"], { cwd: work, env: ENV }).status);
    check("save with no payload at all is refused", EXIT.REFUSED, run(["save"], { cwd: work, env: ENV }).status);
    check("verify on a missing file fails", EXIT.CHECK_FAILED, run(["verify", path.join(tmp, "nope.md")], { cwd: work, env: ENV }).status);
    const w = run(["where"], { cwd: work, env: ENV });
    check("where prints an absolute native contexts path", true, isWindows ? /[A-Za-z]:\\/.test(w.stdout) : /^\s+contexts\s+\//m.test(w.stdout), w.stdout);
    const s = run(["show", "latest"], { cwd: work, env: ENV });
    check("show latest returns a saved context", EXIT.OK, s.status, s.all.slice(0, 300));
  }
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-context-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") => {
    const pass = String(expected) === String(got);
    results.push({ name, expected: String(expected), got: String(got), pass, detail: String(detail).slice(0, 400) });
    return pass;
  };
  const required = (name, expected, got, detail = "") => {
    if (!check(name, expected, got, detail)) throw new SelftestAborted(name);
  };

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // Every assertion below is about a directory that is deliberately NOT a git
  // repository: the drawer name comes from the working directory's basename
  // only when there is no repo root to take it from. But os.tmpdir() is under
  // the user's home on Windows, so a single stray `git init` in HOME — which is
  // exactly what was found on this machine on 2026-08-16, an empty repo with no
  // commits — silently makes every sandbox "inside a repository". The drawer
  // then lands under the HOME directory's name and the assertions here look for
  // it under the sandbox's, so the save "vanishes".
  //
  // A selftest whose result depends on whether the developer's home directory
  // happens to be a repository is not proving anything about this engine. git's
  // own boundary variable is the fix, and it is set here rather than in the test
  // runner so that running this file directly proves the same thing `npm test`
  // does.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  try {
    selftestBody({ tmp, check, required });
  } catch (e) {
    // A crash here is a RESULT, not an exception. Reported as a named failure so
    // the "N/M passed" line still prints and the suite runner can tell this
    // engine apart from one that was never run.
    if (e instanceof SelftestAborted) {
      results.push({
        name: `selftest stopped early after "${e.precondition}"`,
        expected: "the remaining assertions run",
        got: "they did not run",
        pass: false,
        detail: "a precondition failed, so everything downstream of it would have been measuring nothing",
      });
    } else {
      results.push({
        name: "the selftest itself threw",
        expected: "no crash",
        got: `${e?.name || "Error"}: ${e?.message || e}`,
        pass: false,
        detail: String(e?.stack || "").split("\n").slice(0, 4).join(" | ").slice(0, 400),
      });
    }
  } finally {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    // Cleanup is housekeeping, never the verdict. On Windows a just-exited child
    // can still hold a handle for a moment, and an EPERM here used to take the
    // whole report down with it.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a leftover temp directory is not the story */
    }
  }

  // A selftest whose total depends on where it ran is a selftest that can
  // quietly stop asserting things.
  const EXPECTED = 62;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-context selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("");
  out("  Every refusal above is a save that gstack's version would have reported as");
  out("  succeeded: an empty capture, a payload that never parsed, a destination that");
  out("  could not be written, a file edited after the fact, an MSYS path that would");
  out("  have landed on C:\\c\\. The banner here is printed from the file read back off");
  out("  disk, so a save that did not land cannot announce that it did.");
  out("");
}

// --------------------------------------------------------------------- entry

function help() {
  out(`
  tb-context ${VERSION}, the Toolbay Stack working-context engine

  Save:
    save --payload <file.json>   write a context file, then verify it landed
         --title "<title>"       override the payload's title
         --state-dir <dir>       where the drawer lives (default ~/.toolbay-stack)
         --session-start <t>     epoch seconds or ISO, if you know when this started

  Read:
    list [--all] [--json]        saved contexts for this branch, or every branch
    show [latest|<file>]         print one saved context
    verify [<file>|all]          re-check the checksum and required fields
    where                        every path this tool would use, absolute and native

  Session:
    session begin | end | show   the marker session_duration_s is measured from

  Proof:
    selftest                     run this engine against deliberately broken input

  The payload is JSON: { "title", "summary", "decisions": [], "remaining": [],
  "notes": [], "status": "in-progress" | "blocked" | "completed" }. Write it with
  a file tool rather than piping it through a shell; quoting JSON through
  PowerShell or Git Bash is how payloads arrive corrupted.

  Exit codes: 0 ok, 1 a check failed, 2 unusable, 3 refused (payload captured
  nothing), 4 the save did not land.
`);
}

const argv = process.argv.slice(2);
const opts = { all: argv.includes("--all"), json: argv.includes("--json"), force: argv.includes("--force") };
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
opts.payload = flag("payload");
opts.title = flag("title");
opts.stateDir = flag("state-dir");
opts.sessionStart = flag("session-start");
opts.cwd = flag("cwd");
opts.slug = flag("project");

const VALUE_FLAGS = new Set(["payload", "title", "state-dir", "session-start", "cwd", "project"]);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith("--")) {
    if (VALUE_FLAGS.has(a.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith("--")) i += 1;
    continue;
  }
  positional.push(a);
}
const [cmd, ...rest] = positional;

function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      help();
      return EXIT.OK;
    case "save":
      return cmdSave(opts);
    case "list":
      return cmdList(opts);
    case "show":
      return cmdShow(rest[0], opts);
    case "verify":
      return cmdVerify(rest[0], opts);
    case "session":
      return cmdSession(rest[0] || "show", opts);
    case "where":
    case "paths":
      return cmdWhere(opts);
    case "selftest":
      selftest();
      return process.exitCode || EXIT.OK;
    default:
      err(`  Unknown command "${cmd}". Try: tb-context help`);
      return EXIT.UNUSABLE;
  }
}

// A crash must never look like a completed save.
try {
  process.exitCode = main();
} catch (e) {
  err(`\n  tb-context crashed, so nothing here should be treated as saved:\n  ${e?.stack ?? e}\n`);
  process.exitCode = EXIT.NOT_LANDED;
}
