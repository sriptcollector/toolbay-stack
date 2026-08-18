#!/usr/bin/env node
/**
 * tb-context-restore.mjs: the saved-context verifier behind /context-restore.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the
 * /context-restore command, resuming the most recent saved context across all
 * branches by default, selecting a specific one by title fragment, the
 * save-side file format with its `status` / `branch` / `timestamp` /
 * `session_duration_s` / `files_modified` frontmatter, the on-disk layout
 * <state>/projects/<slug>/checkpoints/YYYYMMDD-HHMMSS-<title>.md, the rule that
 * "most recent" means the filename timestamp prefix rather than mtime, and the
 * RESUMING CONTEXT report layout) comes from `context-restore` in gstack by
 * Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's /context-restore is prose. Its entire executable surface is one
 * shell block that lists a directory (context-restore/SKILL.md.tmpl:63-84);
 * everything after that is an instruction to the model: "Read the chosen file
 * and present a summary", with a template of fields to fill in. Nothing checks
 * that the file it picked is a saved context, that the state directory it
 * looked in is the right one, or that the work the file describes still exists.
 *
 * Restoring context is the one operation where that matters most, because the
 * output IS context: whatever this step prints becomes what the model believes
 * about the project. A restore that quietly gets it wrong does not fail, it
 * misleads, and it misleads for the rest of the session.
 *
 * Four failures, all reproduced on Windows 11 with gstack 1.60.1.0 installed,
 * 2026-08-13.
 *
 * 1. IT REPORTS "NOTHING SAVED" WHEN THE LOOKUP ITSELF BROKE.
 *
 *    Step 1 is `eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"`
 *    followed by `eval "$(~/.claude/skills/gstack/bin/gstack-paths)"`. Both are
 *    hard-coded paths under `~/.claude`. When either is absent — a plugin-style
 *    install, a different HOME, a copied dotfile tree, gstack installed
 *    per-project instead of globally — the command substitution is empty,
 *    `eval ""` succeeds, and $SLUG and $GSTACK_STATE_ROOT are simply never set:
 *
 *      $ export HOME=<a home with saved contexts but no ~/.claude/skills/gstack>
 *      $ find "$HOME/.gstack/projects" -name '*.md'
 *      .../fakehome/.gstack/projects/myproj/checkpoints/20260813-101010-real-work.md
 *      $ <gstack context-restore Step 1, verbatim>
 *      resolved CHECKPOINT_DIR=[/projects//checkpoints]
 *      NO_CHECKPOINTS
 *      --- exit status: 0
 *
 *    The skill's own instruction for that token is to tell the user "No saved
 *    contexts yet. Run /context-save first". The context is right there on
 *    disk. Exit status 0. This is a lookup failure wearing the face of an empty
 *    result, and the empty-result answer is the one that makes the user redo
 *    the work.
 *
 *    Worse, the collapsed path is project-independent: with $SLUG empty every
 *    project resolves to the SAME directory, so wherever that bucket does
 *    exist, one project's saved context is served to another with nothing in
 *    the flow to notice.
 *
 * 2. "MOST RECENT" IS AN UNENFORCED CLAIM. The skill says the newest is the
 *    first line of `find | sort -r`, "that is the newest YYYYMMDD-HHMMSS
 *    prefix, which is the canonical most recent". `sort -r` is lexicographic
 *    over whatever .md files are in the directory, and every letter sorts above
 *    every digit:
 *
 *      $ find "$D" -maxdepth 1 -name "*.md" -type f | sort -r | head -20
 *      .../zz-scratch.md
 *      .../20260813-101010-real-newest.md
 *
 *    So the file it loads is `zz-scratch.md`, which is not a saved context at
 *    all. It has no frontmatter, so Title / Branch / Saved / Status have no
 *    source, and the next instruction is to present them. That is the shape of
 *    the failure this whole skill has to avoid: fields invented to fill a
 *    template, presented as recovered state.
 *
 * 3. THE SLUG DEPENDS ON THE DIRECTORY YOU HAPPEN TO BE IN. gstack-slug falls
 *    back to `basename "$PWD"` whenever there is no git remote, and caches per
 *    absolute path, so the same project answers differently from a
 *    subdirectory:
 *
 *      $ cd .../proj     && gstack-slug   ->  SLUG=proj
 *      $ cd .../proj/src && gstack-slug   ->  SLUG=src
 *
 *    Save from the repo root, restore from src/, and you get NO_CHECKPOINTS
 *    again. Here the slug is computed from the repository root (or the git
 *    remote), so it is the same from anywhere inside the project, and how it
 *    was derived is printed.
 *
 * 4. NOTHING CHECKS THAT THE SAVED WORK STILL EXISTS. The saved file lists
 *    `files_modified` and a `branch`. grep the upstream template for any use of
 *    them beyond printing:
 *
 *      $ grep -n "files_modified" context-restore/SKILL.md.tmpl
 *      (no output)
 *
 *    A context from six weeks ago, on a branch that was deleted after merge,
 *    naming files that no longer exist, restores exactly like one from ten
 *    minutes ago: same banner, same "Remaining Work", same confident tone. The
 *    model then starts editing files that are gone. Here every recorded path is
 *    checked against the working tree, the branch is looked up, the age and the
 *    commits since the save are counted, and the run is REFUSED outright when
 *    the tree the context describes no longer exists.
 *
 * DESIGN RULES
 *
 *   1. FAIL CLOSED, AND SAY WHICH CHECK FAILED. "I could not verify this" and
 *      "there is nothing here" are different answers with different exit codes
 *      (4 and 3). No path returns a context it could not verify while implying
 *      it did.
 *   2. NEVER SILENTLY SUBSTITUTE. A title query that matches nothing is a
 *      refusal, not a fallback to the newest. A query that matches two is a
 *      refusal, not a coin flip. A file that does not parse is named and
 *      skipped, never presented.
 *   3. NODE ONLY. No bash, no find, no sort, no date, no /tmp, no symlink
 *      assumptions. Same behaviour from Git Bash, PowerShell and cmd.
 *   4. PROVE IT. `selftest` runs this CLI as a child process against
 *      deliberately broken saved-context directories and fails loudly if any of
 *      them produce a confident restore.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { TIME_FIELD, readSavedTime, savedTimeField, saveProjectSlug } from "./tb-context-format.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

// Exit codes are the contract. A caller that only looks at the exit status
// still learns the right thing, which is why the verdict is not just a word in
// a sentence the way gstack's is.
const EXIT = {
  OK: 0, // verified, safe to resume from
  USAGE: 2, // the CLI was called wrong
  NONE: 3, // the lookup worked and there is genuinely nothing saved
  REFUSED: 4, // something could not be verified, so nothing is presented
  STALE: 5, // loadable and real, but the world moved on; presented WITH the caveats
};

const MAX_AGE_DAYS_DEFAULT = 30;
const BODY_LIMIT_DEFAULT = 20000;
// How far the frontmatter timestamp may disagree with the filename timestamp
// before the file's provenance is treated as disputed. The two are written by
// different layers on the save side (shell `date` vs. the model), so small
// drift is normal; an hour is not.
const TIMESTAMP_DISPUTE_MS = 60 * 60 * 1000;

// --------------------------------------------------------------- path helpers
//
// Everything here exists because a saved context records paths as text and this
// tool has to decide whether that text points at a file that exists, from any
// of the three shells on Windows plus POSIX.

const isWindows = process.platform === "win32";

function toAbsolute(input, base = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  return path.resolve(looksAbsolute(s) ? s : path.join(base, s));
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- project identity
//
// gstack's slug is `basename $PWD` when there is no git remote, cached per
// absolute directory, so it changes as you move around inside one project (see
// failure 3 in the header). The slug decides which directory is searched, so
// that bug reads as "you never saved anything".

function git(args, cwd) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (r.error) return { ok: false, error: r.error.code || r.error.message };
    if (r.status !== 0) return { ok: false, error: (r.stderr || "").trim() || `git exited ${r.status}` };
    return { ok: true, out: (r.stdout || "").trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Directories git itself refuses to search above, read from
 * GIT_CEILING_DIRECTORIES (`;`-separated on Windows, `:` elsewhere, a leading
 * `!` meaning "do not resolve symlinks" and carrying no meaning for us).
 *
 * This is here because findDotGit below is a SECOND OPINION about a question
 * git has already answered, and a second opinion that ignores the boundary git
 * was given does not disagree politely — it wins. See the comment there.
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
 * Walk up looking for a .git entry, so "is this a repo" is answerable without git.
 *
 * THE WALK STOPS WHERE GIT STOPS. This function overrides git's own verdict:
 * when `rev-parse --show-toplevel` fails but this finds a .git somewhere above,
 * the directory is recorded as "repo-git-broken" and the project slug is taken
 * from that ancestor's basename. So an ancestor repository this walk finds and
 * git deliberately ignored does not merely produce a wrong message — it renames
 * the project, which sends the whole lookup to a drawer nothing ever wrote to
 * and prints NO SAVED CONTEXTS over a full one. That is the exact
 * empty-result-wearing-the-face-of-a-lookup-failure this engine exists to
 * remove, arriving from the inside.
 *
 * Reproduced 2026-08-16: a stray `git init` in the HOME directory put every
 * temp directory on the machine "inside a repository", and 20 of this engine's
 * 26 selftests failed with "genuinely nothing saved" over drawers that were
 * right there.
 */
function findDotGit(startDir) {
  const ceilings = gitCeilings();
  let cur = path.resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    if (statOrNull(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (ceilings.some((c) => samePath(c, parent))) return null;
    cur = parent;
  }
  return null;
}

function sanitizeSlug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * @returns {{slug:string|null, how:string, repoRoot:string|null, gitState:"repo"|"repo-git-broken"|"not-a-repo", branch:string|null, legacySlug:string, problem?:string}}
 *
 * `gitState` matters later: "not-a-repo" makes the git-dependent checks
 * legitimately not applicable, while "repo-git-broken" means a check that
 * should have run could not, which is never allowed to read as a pass.
 */
function projectIdentity(cwd = process.cwd()) {
  const legacySlug = sanitizeSlug(path.basename(path.resolve(cwd)));
  const dotGit = findDotGit(cwd);
  const remote = git(["remote", "get-url", "origin"], cwd);
  const top = git(["rev-parse", "--show-toplevel"], cwd);

  let gitState = "not-a-repo";
  if (dotGit) gitState = top.ok ? "repo" : "repo-git-broken";
  else if (top.ok) gitState = "repo";

  const repoRoot = top.ok ? path.resolve(fromMsysPath(top.out)) : dotGit;
  const branchRes = gitState === "repo" ? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) : { ok: false };
  // The drawer /context-save writes to, computed by the helper save itself uses.
  // Carried on every return below, because candidateDirs has to search it.
  const saveSlug = saveProjectSlug(repoRoot, cwd);

  if (remote.ok && remote.out) {
    // owner/repo from either git@host:owner/repo.git or https://host/owner/repo
    const cleaned = remote.out.replace(/\.git$/, "");
    const m = /[:/]([^/:]+)\/([^/]+)$/.exec(cleaned);
    if (m) {
      const slug = sanitizeSlug(`${m[1]}-${m[2]}`);
      if (slug) {
        return {
          slug,
          how: `git remote origin (${remote.out})`,
          repoRoot,
          gitState,
          branch: branchRes.ok ? branchRes.out : null,
          legacySlug,
          saveSlug,
        };
      }
    }
  }

  if (repoRoot) {
    const slug = sanitizeSlug(path.basename(repoRoot));
    if (slug) {
      return {
        slug,
        how: `repository root basename (${repoRoot}), so it does not change inside the project`,
        repoRoot,
        gitState,
        branch: branchRes.ok ? branchRes.out : null,
        legacySlug,
        saveSlug,
      };
    }
  }

  const slug = legacySlug;
  if (!slug) {
    return {
      slug: null,
      how: "no git remote, no repository root, and the directory name has no usable characters",
      repoRoot: null,
      gitState,
      branch: null,
      legacySlug,
      saveSlug,
      // The failure gstack turns into a shared bucket. Here it stops the run.
      problem: `no project identity could be computed for ${path.resolve(cwd)}, so there is no directory to search`,
    };
  }
  return {
    slug,
    how: `current directory basename (${path.resolve(cwd)}); not a git repository`,
    repoRoot: null,
    gitState,
    branch: null,
    legacySlug,
    saveSlug,
  };
}

// ------------------------------------------------------------------- the roots

function tbsStateDir() {
  const env = process.env.TOOLBAY_STACK_STATE_DIR;
  if (env && env.trim()) return path.resolve(fromMsysPath(env.trim()));
  return path.join(os.homedir(), ".toolbay-stack");
}

function gstackStateDir() {
  const env = process.env.GSTACK_HOME;
  if (env && env.trim()) return path.resolve(fromMsysPath(env.trim()));
  return path.join(os.homedir(), ".gstack");
}

/**
 * Every directory that could hold a saved context for this project, with the
 * reason it is on the list. Printed by `where` and by every refusal, because
 * "nothing found" is only believable next to the list of places looked.
 *
 * The gstack legacy directory is included on purpose: /context-save wrote there
 * for every gstack user, and a restore that cannot see those files would be a
 * migration that silently loses history.
 */
function candidateDirs(id) {
  const dirs = [];
  if (!id.slug) return dirs;
  dirs.push({
    dir: path.join(tbsStateDir(), "projects", id.slug, "contexts"),
    origin: "toolbay-stack",
    slug: id.slug,
  });
  // WHERE /context-save ACTUALLY WRITES.
  //
  // This entry is not a nicety, it is the other half of the save/restore seam.
  // The slug above prefers `owner-repo` off `git remote get-url origin` and
  // keeps its case; /context-save files under a lower-cased repo-root basename
  // and always has. In any repository with a remote those are two different
  // directories, so without this line the lookup succeeds, finds an empty
  // directory, and reports NO SAVED CONTEXTS over a full drawer — the exact
  // "empty result wearing the face of a lookup failure" this engine exists to
  // remove, arriving from the inside. The slug is computed by the shared helper
  // both engines import, so it cannot drift from what save does.
  if (id.saveSlug && id.saveSlug !== id.slug) {
    dirs.push({
      dir: path.join(tbsStateDir(), "projects", id.saveSlug, "contexts"),
      origin: "toolbay-stack-save-slug",
      slug: id.saveSlug,
    });
  }
  dirs.push({
    dir: path.join(gstackStateDir(), "projects", id.slug, "checkpoints"),
    origin: "gstack-legacy",
    slug: id.slug,
  });
  if (id.legacySlug && id.legacySlug !== id.slug) {
    dirs.push({
      dir: path.join(gstackStateDir(), "projects", id.legacySlug, "checkpoints"),
      origin: "gstack-legacy-cwd-slug",
      slug: id.legacySlug,
    });
  }
  return dirs;
}

// -------------------------------------------------------------- file parsing

const NAME_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.md$/;

/**
 * The filename stamp, or null when it is not a real date (20261345-999999 and
 * friends). Two readings come back, and the difference between them is the
 * reason this is a function and not a regex:
 *
 *   ms       the instant that wall-clock reading names in THIS machine's zone,
 *            which is what age and ordering need;
 *   wallUTC  the digits themselves, pinned to UTC, which is what a comparison
 *            against the frontmatter timestamp needs. The two stamps are wall
 *            clocks written in whatever zone the machine was in at save time,
 *            so comparing instants would flag every context saved in another
 *            timezone as tampered with.
 */
function parseNameStamp(base) {
  const m = NAME_RE.exec(base);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi ||
    dt.getSeconds() !== s
  ) {
    return null;
  }
  return { ms: dt.getTime(), wallUTC: Date.UTC(y, mo - 1, d, h, mi, s), title: m[7] };
}

/**
 * The small YAML subset the save side actually writes: `key: value` and
 * `key:` followed by `  - item` lines. Deliberately not a YAML engine — an
 * unexpected shape returns an error instead of a lenient guess, because a
 * lenient guess here becomes a confident sentence in the restore banner.
 */
function parseFrontmatter(text) {
  const norm = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { ok: false, error: "the file does not start with a --- frontmatter block" };
  const end = norm.indexOf("\n---", 3);
  if (end === -1) return { ok: false, error: "the frontmatter block is never closed with ---" };
  const block = norm.slice(4, end + 1);
  const body = norm.slice(end + 4).replace(/^\n/, "");
  const fm = {};
  let currentKey = null;
  for (const rawLine of block.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(rawLine);
    if (item) {
      if (!currentKey) return { ok: false, error: `list item "${item[1].trim()}" appears before any key` };
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      const v = item[1].trim().replace(/^["']|["']$/g, "");
      if (v) fm[currentKey].push(v);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!kv) return { ok: false, error: `frontmatter line is not "key: value": ${rawLine.trim().slice(0, 60)}` };
    currentKey = kv[1];
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    fm[currentKey] = value === "" ? [] : value;
  }
  return { ok: true, fm, body };
}

/**
 * The instant an ISO-8601 stamp names, plus its wall-clock reading pinned to
 * UTC so it can be compared against the filename's digits (see parseNameStamp).
 */
function parseIsoStamp(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  if (/[zZ]$/.test(t)) return { ms, wallUTC: ms };
  const off = /([+-])(\d{2}):?(\d{2})$/.exec(t);
  if (off) {
    const sign = off[1] === "-" ? -1 : 1;
    const minutes = sign * (Number(off[2]) * 60 + Number(off[3]));
    return { ms, wallUTC: ms + minutes * 60000 };
  }
  // No offset at all: Date.parse read the digits as local time, so undoing this
  // machine's offset recovers the digits themselves.
  return { ms, wallUTC: ms - new Date(ms).getTimezoneOffset() * 60000 };
}

function classify(dirEntry, file) {
  const full = path.join(dirEntry.dir, file);
  const c = {
    file: full,
    base: file,
    origin: dirEntry.origin,
    slug: dirEntry.slug,
    status: "ok",
    nameOk: false,
    problems: [],
    stamp: null,
    title: null,
    fm: null,
    body: "",
    size: 0,
  };
  // The FIRST thing wrong with a file is what it is filed under; later problems
  // are recorded but do not rename it. A file whose name has no timestamp is
  // reported as malformed-name even after it also turns out to be unparseable,
  // because the name is what let it sort above a real saved context.
  const fail = (status, message) => {
    if (c.status === "ok") c.status = status;
    c.problems.push(message);
  };

  const st = statOrNull(full);
  if (!st || !st.isFile()) {
    fail("unreadable", "not a regular file");
    return c;
  }
  c.size = st.size;
  const named = parseNameStamp(file);
  if (!named) {
    fail(
      "malformed-name",
      "the filename is not YYYYMMDD-HHMMSS-<title>.md with a real date, so it has no position in the saved-context order",
    );
  } else {
    c.nameOk = true;
    c.stamp = named.ms;
    c.nameWallUTC = named.wallUTC;
    c.title = named.title;
  }
  if (st.size === 0) {
    fail("unreadable", "the file is 0 bytes");
    return c;
  }
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (e) {
    fail("unreadable", `could not be read (${e.code || e.message})`);
    return c;
  }
  const fmRes = parseFrontmatter(text);
  if (!fmRes.ok) {
    fail("unparseable", fmRes.error);
    return c;
  }
  c.fm = fmRes.fm;
  c.body = fmRes.body;
  // What a saved context has to carry to be restorable. The save time is read
  // through the shared reader in tb-context-format.mjs rather than by naming a
  // key here: this line used to require `timestamp` literally while the save
  // engine wrote `saved_at`, so every file /context-save produced was classified
  // as "not a saved context" and the drawer read as empty.
  const savedTime = readSavedTime(fmRes.fm);
  const missingKeys = [];
  if (!fmRes.fm.branch || typeof fmRes.fm.branch !== "string") missingKeys.push("branch");
  if (!savedTime) missingKeys.push(TIME_FIELD);
  if (missingKeys.length) {
    fail("unparseable", `frontmatter has no ${missingKeys.join(" and no ")}, so this is not a saved context`);
    return c;
  }
  c.timeField = savedTimeField(fmRes.fm);
  const iso = parseIsoStamp(savedTime);
  if (!iso) {
    fail("unparseable", `frontmatter ${c.timeField} "${savedTime}" is not a date`);
    return c;
  }
  c.savedTime = savedTime;
  c.iso = iso;
  if (c.nameOk) {
    const delta = Math.abs(iso.wallUTC - c.nameWallUTC);
    if (delta > TIMESTAMP_DISPUTE_MS) {
      c.disputed = { delta };
      c.problems.push(
        `the filename says ${fmtStamp(c.stamp)} and the frontmatter says ${savedTime}; they disagree by ${fmtDuration(delta / 1000)}, so when this context was written is not established`,
      );
    }
  }
  return c;
}

// ------------------------------------------------------------------ formatting

function two(n) {
  return String(n).padStart(2, "0");
}

function fmtStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAge(ms) {
  return fmtDuration(ms / 1000);
}

// -------------------------------------------------------------- gathering

/**
 * @returns {{ok:false, error:string, looked:string[]} | {ok:true, usable:object[], rejected:object[], looked:object[]}}
 *
 * A directory that exists but is not a directory, or cannot be listed, is an
 * ERROR, not an empty result. That distinction is the whole of gstack failure 1.
 */
function gather(id) {
  const dirs = candidateDirs(id);
  const looked = [];
  const usable = [];
  const rejected = [];

  // Validate the roots BEFORE looking for the leaf directories. A state root
  // that is a file, or a `projects` entry that is a file, makes every leaf path
  // under it non-existent, and "does not exist" would then be reported as "you
  // have nothing saved" — which is exactly gstack's failure 1 arriving by a
  // different route. An unusable root is an error, not an empty result.
  for (const root of [
    { p: tbsStateDir(), label: "TOOLBAY_STACK_STATE_DIR" },
    { p: gstackStateDir(), label: "GSTACK_HOME" },
  ]) {
    for (const probe of [root.p, path.join(root.p, "projects")]) {
      const st = statOrNull(probe);
      if (st && !st.isDirectory()) {
        return {
          ok: false,
          error: `${probe} exists but is not a directory, so saved contexts cannot be listed under it (${root.label})`,
          looked,
        };
      }
    }
  }

  for (const d of dirs) {
    const st = statOrNull(d.dir);
    if (!st) {
      looked.push({ ...d, state: "absent" });
      continue;
    }
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `${d.dir} exists but is not a directory, so saved contexts cannot be listed there`,
        looked,
      };
    }
    let names;
    try {
      names = fs.readdirSync(d.dir);
    } catch (e) {
      return { ok: false, error: `${d.dir} could not be listed (${e.code || e.message})`, looked };
    }
    const mds = names.filter((n) => n.toLowerCase().endsWith(".md"));
    looked.push({ ...d, state: "present", files: mds.length });
    for (const n of mds) {
      const c = classify(d, n);
      if (c.status === "ok") usable.push(c);
      else rejected.push(c);
    }
  }
  // Newest first, by the filename stamp, which is what the format promises.
  // Ties break on the filename so the order is total and reproducible.
  usable.sort((a, b) => b.stamp - a.stamp || (a.base < b.base ? 1 : -1));
  rejected.sort((a, b) => (a.base < b.base ? -1 : 1));
  return { ok: true, usable, rejected, looked };
}

// ------------------------------------------------------------- verification

/**
 * The part gstack does not have. Each check reports pass / fail / n-a, and an
 * n-a is only allowed when the check genuinely does not apply (not a git repo),
 * never when it could not be run.
 */
function verify(ctx, id, opts) {
  const checks = [];
  const add = (name, state, detail) => checks.push({ name, state, detail });

  add("saved context parsed", "pass", `${ctx.file} (${ctx.size} bytes)`);

  if (ctx.disputed) {
    add("timestamp provenance", "fail", ctx.problems[ctx.problems.length - 1]);
  } else {
    add("timestamp provenance", "pass", `filename and frontmatter agree (${fmtStamp(ctx.stamp)})`);
  }

  // Age. An old context is not wrong, but presenting it in the same voice as a
  // ten-minute-old one is how a restore misleads.
  const ageMs = Date.now() - ctx.stamp;
  const ageDays = ageMs / 86400000;
  if (ageMs < 0) {
    add("age", "fail", `the saved timestamp ${fmtStamp(ctx.stamp)} is in the future relative to this machine's clock`);
  } else if (ageDays > opts.maxAgeDays) {
    add("age", "fail", `saved ${fmtAge(ageMs)} ago, older than the ${opts.maxAgeDays}-day limit (--max-age-days)`);
  } else {
    add("age", "pass", `saved ${fmtAge(ageMs)} ago`);
  }

  // Files. This is the check that decides whether the work described still
  // exists at all.
  const rawFiles = Array.isArray(ctx.fm.files_modified) ? ctx.fm.files_modified : [];
  const base = id.repoRoot || process.cwd();
  const present = [];
  const missing = [];
  const changedSince = [];
  for (const rel of rawFiles) {
    const abs = toAbsolute(rel, base);
    const st = abs ? statOrNull(abs) : null;
    // A directory counts as present. `git status --porcelain` with the default
    // untracked mode collapses a wholly-untracked directory into one entry,
    // `src/`, so saved contexts exist that record directories — including every
    // one written before /context-save started asking git for the files. This
    // check answers "does the work this context describes still exist", and a
    // directory that is still there answers yes. Requiring isFile() here turned
    // a ten-second-old context into "all 1 recorded files are gone", which is
    // both wrong and the loudest refusal this engine has.
    if (st && (st.isFile() || st.isDirectory())) {
      present.push(rel);
      if (st.isFile() && st.mtimeMs > ctx.stamp + 1000) changedSince.push(rel);
    } else {
      missing.push(rel);
    }
  }
  if (!rawFiles.length) {
    add(
      "recorded files still exist",
      "fail",
      "the saved context records no files_modified, so nothing in it could be checked against the working tree",
    );
  } else if (missing.length === rawFiles.length) {
    add(
      "recorded files still exist",
      "fail",
      `all ${rawFiles.length} recorded files are gone from ${base}: ${missing.join(", ")}`,
    );
  } else if (missing.length) {
    add(
      "recorded files still exist",
      "fail",
      `${missing.length} of ${rawFiles.length} recorded files are gone: ${missing.join(", ")}`,
    );
  } else {
    add("recorded files still exist", "pass", `all ${rawFiles.length} recorded files are present under ${base}`);
  }

  // Branch and drift.
  if (id.gitState === "not-a-repo") {
    add("saved branch exists", "n-a", "not a git repository, so there is no branch to look up");
    add("commits since the save", "n-a", "not a git repository");
  } else if (id.gitState === "repo-git-broken") {
    add("saved branch exists", "fail", "this is a git repository but git could not be run, so the branch was NOT checked");
    add("commits since the save", "fail", "git could not be run, so drift was NOT measured");
  } else {
    const savedBranch = String(ctx.fm.branch || "").trim();
    const ref = git(["rev-parse", "--verify", "--quiet", `refs/heads/${savedBranch}`], base);
    if (!savedBranch) add("saved branch exists", "fail", "the saved context names no branch");
    else if (ref.ok) {
      add(
        "saved branch exists",
        "pass",
        savedBranch === id.branch ? `${savedBranch} (currently checked out)` : `${savedBranch} (you are on ${id.branch})`,
      );
    } else {
      add("saved branch exists", "fail", `branch "${savedBranch}" no longer exists in this repository`);
    }
    const iso = new Date(ctx.stamp).toISOString();
    const count = git(["rev-list", "--count", `--since=${iso}`, "HEAD"], base);
    if (!count.ok) add("commits since the save", "fail", `git rev-list failed (${count.error}), so drift was NOT measured`);
    else {
      const n = Number(count.out);
      add(
        "commits since the save",
        "pass",
        n === 0 ? "no commits landed since this context was saved" : `${n} commit(s) landed since this context was saved`,
      );
    }
  }

  const failed = checks.filter((c) => c.state === "fail");
  const hardRefusal =
    (rawFiles.length > 0 && missing.length === rawFiles.length) ||
    checks.some((c) => c.name === "age" && c.state === "fail" && /future/.test(c.detail));

  return {
    checks,
    present,
    missing,
    changedSince,
    ageMs,
    verdict: hardRefusal ? "REFUSED" : failed.length ? "STALE" : "OK",
    hardRefusal,
  };
}

// ------------------------------------------------------------------- output

function line(ch = "═", n = 66) {
  return ch.repeat(n);
}

function printRejected(rejected, out) {
  if (!rejected.length) return;
  out(`\nFILES IN THE SAVED-CONTEXT DIRECTORIES THAT ARE NOT SAVED CONTEXTS (${rejected.length})`);
  for (const r of rejected) {
    out(`  ${r.base}  [${r.status}]`);
    for (const p of r.problems) out(`      ${p}`);
  }
  out("  None of these were loaded. A file that cannot be parsed is never presented as context.");
}

function printLooked(looked, out) {
  out("\nDIRECTORIES SEARCHED");
  for (const l of looked) {
    const state = l.state === "absent" ? "does not exist" : `${l.files} .md file(s)`;
    out(`  [${l.origin}] ${l.dir}  -> ${state}`);
  }
}

function printIdentity(id, out) {
  out(`Project slug: ${id.slug ?? "(none)"}`);
  out(`  derived from: ${id.how}`);
  out(`  git: ${id.gitState}${id.branch ? `, on branch ${id.branch}` : ""}`);
  out(`  state dirs: ${tbsStateDir()} | ${gstackStateDir()}`);
}

// -------------------------------------------------------------- the commands

function cmdWhere(argv, out) {
  const id = projectIdentity(process.cwd());
  out(`\n  tb-context-restore ${VERSION}  where\n`);
  printIdentity(id, out);
  if (id.problem) {
    out(`\nPROBLEM: ${id.problem}`);
    return EXIT.OK;
  }
  const g = gather(id);
  if (!g.ok) {
    printLooked(g.looked, out);
    out(`\nPROBLEM: ${g.error}`);
    return EXIT.OK;
  }
  printLooked(g.looked, out);
  out(`\nUsable saved contexts: ${g.usable.length}`);
  printRejected(g.rejected, out);
  return EXIT.OK;
}

function cmdList(argv, out) {
  const id = projectIdentity(process.cwd());
  if (id.problem) {
    out(`REFUSED: ${id.problem}`);
    return EXIT.REFUSED;
  }
  const g = gather(id);
  if (!g.ok) {
    out(`REFUSED: ${g.error}`);
    printLooked(g.looked, out);
    out("\nThis is a lookup failure, not an empty result. Nothing is being reported as \"no saved contexts\".");
    return EXIT.REFUSED;
  }
  out(`\nSAVED CONTEXTS (${g.usable.length}) for ${id.slug}`);
  out(line());
  if (!g.usable.length) {
    out("  none");
  } else {
    for (let i = 0; i < g.usable.length; i += 1) {
      const c = g.usable[i];
      const branch = typeof c.fm.branch === "string" ? c.fm.branch : "?";
      const status = typeof c.fm.status === "string" ? c.fm.status : "?";
      out(
        `  ${String(i + 1).padStart(2)}. ${fmtStamp(c.stamp)}  ${c.title.padEnd(28)}  ${branch.padEnd(18)}  ${status}  [${c.origin}]`,
      );
    }
  }
  out(line());
  printRejected(g.rejected, out);
  printLooked(g.looked, out);
  return g.usable.length ? EXIT.OK : EXIT.NONE;
}

function cmdRestore(argv, out) {
  // Hand-rolled because the value of a flag must NOT fall through into the
  // title query. `restore --max-age-days 1000` searching for a context called
  // "1000" and then refusing because nothing matches is a real bug this
  // selftest caught, and the refusal made it look like a policy decision.
  const parsed = parseArgs(argv, { value: ["--max-age-days", "--body-limit"], bool: ["--json"] });
  if (parsed.error) {
    out(`REFUSED: ${parsed.error}`);
    return EXIT.REFUSED;
  }
  const opts = {
    maxAgeDays: parsed.flags["--max-age-days"] === undefined ? MAX_AGE_DAYS_DEFAULT : Number(parsed.flags["--max-age-days"]),
    bodyLimit: parsed.flags["--body-limit"] === undefined ? BODY_LIMIT_DEFAULT : Number(parsed.flags["--body-limit"]),
    json: Boolean(parsed.flags["--json"]),
  };
  if (!Number.isFinite(opts.maxAgeDays) || opts.maxAgeDays < 0) {
    out(`REFUSED: --max-age-days must be a non-negative number, got "${parsed.flags["--max-age-days"]}"`);
    return EXIT.REFUSED;
  }
  if (!Number.isFinite(opts.bodyLimit) || opts.bodyLimit < 1) {
    out(`REFUSED: --body-limit must be a positive number, got "${parsed.flags["--body-limit"]}"`);
    return EXIT.REFUSED;
  }
  const query = parsed.rest.join(" ").trim();

  const id = projectIdentity(process.cwd());
  if (id.problem) {
    out(`REFUSED: ${id.problem}`);
    out("Nothing was loaded. A restore that cannot identify the project would be reading another project's notes.");
    return EXIT.REFUSED;
  }

  const g = gather(id);
  if (!g.ok) {
    out(`REFUSED: ${g.error}`);
    printIdentity(id, out);
    printLooked(g.looked, out);
    out(
      '\nThis is a lookup failure, not an empty result. It is NOT reported as "no saved contexts yet", because the difference between "you never saved" and "I could not look" is the whole question.',
    );
    return EXIT.REFUSED;
  }

  if (!g.usable.length) {
    if (g.rejected.length) {
      out(`REFUSED: ${g.rejected.length} file(s) are sitting in the saved-context directories and none of them is a loadable saved context.`);
      printRejected(g.rejected, out);
      printLooked(g.looked, out);
      out("\nNothing was presented. Inventing a Title / Branch / Saved line for an unparseable file is the failure this refusal exists to prevent.");
      return EXIT.REFUSED;
    }
    out("NO SAVED CONTEXTS");
    printIdentity(id, out);
    printLooked(g.looked, out);
    out("\nThe lookup worked and there is genuinely nothing saved for this project. Run /context-save first.");
    return EXIT.NONE;
  }

  let chosen;
  if (query) {
    const q = query.toLowerCase();
    const asIndex = /^\d+$/.test(q) ? Number(q) : null;
    let matches;
    if (asIndex !== null && asIndex >= 1 && asIndex <= g.usable.length) {
      matches = [g.usable[asIndex - 1]];
    } else {
      matches = g.usable.filter((c) => c.base.toLowerCase().includes(q) || String(c.fm.branch ?? "").toLowerCase().includes(q));
    }
    if (!matches.length) {
      out(`REFUSED: nothing saved for this project matches "${query}".`);
      out("\nThe most recent context was NOT loaded instead. Substituting a different context for the one that was asked for is how a restore ends up describing work nobody asked about.");
      out(`\n${g.usable.length} saved context(s) exist. Run "list" to see them.`);
      return EXIT.REFUSED;
    }
    if (matches.length > 1) {
      out(`REFUSED: "${query}" matches ${matches.length} saved contexts, and picking one of them would be a guess:`);
      for (const m of matches) out(`  ${fmtStamp(m.stamp)}  ${m.title}  [${m.origin}]`);
      out("\nRe-run with a longer fragment, or the number from \"list\".");
      return EXIT.REFUSED;
    }
    chosen = matches[0];
  } else {
    // "Most recent" is only honoured if it can be honoured. A file that sorts
    // above the real newest but has no timestamp is not silently promoted the
    // way `sort -r` promotes it.
    chosen = g.usable[0];
    const junkOnTop = g.rejected.filter((r) => !r.nameOk && r.base > chosen.base);
    if (junkOnTop.length) {
      out(
        `NOTE: ${junkOnTop.length} file(s) here sort ABOVE the newest saved context under \`sort -r\` but carry no timestamp (${junkOnTop.map((j) => j.base).join(", ")}). They were skipped, not loaded.`,
      );
    }
  }

  const v = verify(chosen, id, opts);

  if (opts.json) {
    out(
      JSON.stringify(
        {
          verdict: v.verdict,
          file: chosen.file,
          origin: chosen.origin,
          title: chosen.title,
          savedAt: fmtStamp(chosen.stamp),
          ageSeconds: Math.round(v.ageMs / 1000),
          branch: chosen.fm.branch,
          currentBranch: id.branch,
          checks: v.checks,
          missingFiles: v.missing,
          changedSinceSave: v.changedSince,
        },
        null,
        2,
      ),
    );
    return v.verdict === "OK" ? EXIT.OK : v.verdict === "STALE" ? EXIT.STALE : EXIT.REFUSED;
  }

  const dur = chosen.fm.session_duration_s;

  out("");
  out(`RESUMING CONTEXT  [${v.verdict}]`);
  out(line());
  out(`Title:       ${chosen.title}`);
  out(`File:        ${chosen.file}`);
  out(`Source:      ${chosen.origin}${chosen.slug !== id.slug ? `  (found under slug "${chosen.slug}", not "${id.slug}")` : ""}`);
  out(`Branch:      ${chosen.fm.branch}${id.branch && id.branch !== chosen.fm.branch ? `   <-- you are on ${id.branch}` : ""}`);
  out(`Saved:       ${fmtStamp(chosen.stamp)}  (${fmtAge(v.ageMs)} ago)`);
  if (dur) out(`Duration:    last session ran ${fmtDuration(dur)}`);
  out(`Status:      ${chosen.fm.status ?? "unrecorded"}`);
  out(line());

  out("\nVERIFICATION");
  for (const c of v.checks) {
    const tag = c.state === "pass" ? "PASS" : c.state === "fail" ? "FAIL" : "N/A ";
    out(`  ${tag}  ${c.name}`);
    out(`         ${c.detail}`);
  }

  if (v.changedSince.length) {
    out(
      `\n  NOTE  ${v.changedSince.length} recorded file(s) have been modified since the save: ${v.changedSince.join(", ")}`,
    );
    out("        Some of the remaining work below may already be done.");
  }

  // Always name what was skipped, even on a clean restore. A file sitting in
  // the saved-context directory that this tool refused to read is something the
  // user should hear about while the restore is on screen, not only when
  // everything fails.
  printRejected(g.rejected, out);

  if (v.verdict === "REFUSED") {
    out(`\n${line()}`);
    out("REFUSED. The saved content is NOT printed below, because the tree it describes is gone.");
    out("Reading its remaining-work list would mean planning edits to files that no longer exist.");
    out(`Open it yourself if you want it: ${chosen.file}`);
    out(line());
    return EXIT.REFUSED;
  }

  out(`\n${line()}`);
  if (v.verdict === "STALE") {
    out("STALE. This is a real saved context, but at least one check above failed.");
    out("Present it WITH the failed checks. Do not describe the remaining work as if it");
    out("were still true, and do not fill in any field the file does not contain.");
  } else {
    out("OK. Every check above passed. The content below is the file as written at save time.");
  }
  out(line());

  const body = chosen.body;
  if (body.length > opts.bodyLimit) {
    out(body.slice(0, opts.bodyLimit));
    out(
      `\n[TRUNCATED: ${body.length - opts.bodyLimit} more characters. This is a truncation, not the end of the file. Read ${chosen.file} for the rest, or re-run with --body-limit ${body.length}.]`,
    );
  } else {
    out(body);
  }

  return v.verdict === "STALE" ? EXIT.STALE : EXIT.OK;
}

function parseArgs(argv, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (spec.bool.includes(a)) {
      flags[a] = true;
      continue;
    }
    if (spec.value.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || spec.bool.includes(v) || spec.value.includes(v)) {
        return { error: `${a} needs a value`, flags, rest };
      }
      flags[a] = v;
      i += 1;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown option ${a}`, flags, rest };
    rest.push(a);
  }
  return { flags, rest };
}

// ------------------------------------------------------------------ selftest

function runCli(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { status: r.status, stdout: `${r.stdout || ""}${r.stderr || ""}` };
}

function stampParts(d) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`;
}

function writeContext(dir, when, title, { branch = "main", files = [], status = "in-progress", isoOverride, body } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${stampParts(when)}-${title}.md`;
  const fm = [
    "---",
    `status: ${status}`,
    `branch: ${branch}`,
    `timestamp: ${isoOverride ?? isoLocal(when)}`,
    "files_modified:",
    ...files.map((f) => `  - ${f}`),
    "---",
    "",
    body ?? `## Working on: ${title}\n\n### Summary\n\nBody of ${title}.\n`,
  ].join("\n");
  const full = path.join(dir, name);
  fs.writeFileSync(full, fm, "utf8");
  return full;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ctx-restore-selftest-"));
  // Declared before the try below, so a throw mid-run still has somewhere to
  // record itself and the report at the bottom still has something to print.
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail: String(detail) });
  // A THROW IS A NAMED FAILURE, NOT A STACK TRACE. A selftest that dies mid-run
  // prints no "N/M passed" line, and the suite runner then says it "cannot be
  // shown to have asserted anything" — which buries the one assertion that
  // really failed under a stack trace from a line merely downstream of it. A
  // test that crashes is indistinguishable from a test that never ran.
  try {

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // Every scenario below is a plain directory whose project slug must come from
  // its own basename. os.tmpdir() lives under the user's home on Windows, so one
  // stray `git init` in HOME puts every sandbox "inside a repository" — found on
  // this machine 2026-08-16, an empty repo with no commits — and then
  // projectIdentity takes the slug from THAT repo's basename for every scenario
  // at once. All of them collapse onto one drawer name that nothing wrote to,
  // and 20 of the 26 assertions below failed with "genuinely nothing saved"
  // while the saved contexts sat in the directory next door.
  //
  // Set here rather than in the test runner, so running this file directly
  // proves exactly what `npm test` proves. findDotGit honours the same boundary,
  // so the engine's own second opinion stops where git stops.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const mk = (...p) => {
    const d = path.join(tmp, ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // Each scenario is a (project dir, state dir) pair. The project dir is the
  // cwd the CLI runs in, so the slug is its basename; the state dir holds the
  // saved contexts. Nothing here touches the user's real state.
  const scen = (name) => {
    const proj = mk("projects", name);
    const state = mk("state", name);
    const contexts = path.join(state, "projects", name, "contexts");
    fs.mkdirSync(contexts, { recursive: true });
    return { name, proj, state, contexts, env: { TOOLBAY_STACK_STATE_DIR: state, GSTACK_HOME: path.join(state, "nogstack") } };
  };

  const now = new Date();
  const minutesAgo = (m) => new Date(now.getTime() - m * 60000);
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000);

  // --- happy path: every recorded file present, saved minutes ago
  const good = scen("good");
  fs.writeFileSync(path.join(good.proj, "a.ts"), "a", "utf8");
  fs.mkdirSync(path.join(good.proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(good.proj, "src", "b.ts"), "b", "utf8");
  writeContext(good.contexts, minutesAgo(20), "auth-refactor", { files: ["a.ts", "src/b.ts"] });

  // --- an older one, so a query can select something that is not the newest
  writeContext(good.contexts, minutesAgo(400), "api-pagination", { files: ["a.ts"] });

  // --- empty: directories resolve, nothing saved
  const empty = scen("empty");

  // --- broken root: the state dir is a FILE
  const brokenRootDir = mk("state", "brokenroot-parent");
  const brokenRootFile = path.join(brokenRootDir, "state-file");
  fs.writeFileSync(brokenRootFile, "not a directory", "utf8");
  const brokenProj = mk("projects", "brokenroot");

  // --- junk that sorts above the newest (the gstack sort -r case)
  const junk = scen("junk");
  fs.writeFileSync(path.join(junk.proj, "a.ts"), "a", "utf8");
  writeContext(junk.contexts, minutesAgo(5), "real-newest", { files: ["a.ts"] });
  fs.writeFileSync(path.join(junk.contexts, "zz-scratch.md"), "scratch notes, not a saved context\n", "utf8");

  // --- only junk
  const junkOnly = scen("junkonly");
  fs.writeFileSync(path.join(junkOnly.contexts, "zz-scratch.md"), "scratch notes\n", "utf8");

  // --- impossible date in the filename
  const baddate = scen("baddate");
  fs.writeFileSync(path.join(baddate.contexts, "20261345-999999-impossible.md"), "---\nbranch: main\ntimestamp: 2026-13-45T99:99:99Z\n---\nbody\n", "utf8");

  // --- zero-byte newest
  const zero = scen("zero");
  fs.writeFileSync(path.join(zero.proj, "a.ts"), "a", "utf8");
  writeContext(zero.contexts, minutesAgo(500), "older-real", { files: ["a.ts"] });
  fs.writeFileSync(path.join(zero.contexts, `${stampParts(minutesAgo(3))}-empty.md`), "", "utf8");

  // --- no frontmatter at all, but a valid filename
  const nofm = scen("nofm");
  fs.writeFileSync(path.join(nofm.contexts, `${stampParts(minutesAgo(4))}-nofm.md`), "## Working on: something\n", "utf8");

  // --- frontmatter without the required keys
  const nokeys = scen("nokeys");
  fs.writeFileSync(path.join(nokeys.contexts, `${stampParts(minutesAgo(4))}-nokeys.md`), "---\nstatus: in-progress\n---\nbody\n", "utf8");

  // --- every recorded file gone
  const gone = scen("gone");
  writeContext(gone.contexts, minutesAgo(30), "deleted-tree", { files: ["src/gone-a.ts", "src/gone-b.ts"] });

  // --- some recorded files gone
  const partial = scen("partial");
  fs.writeFileSync(path.join(partial.proj, "here.ts"), "x", "utf8");
  writeContext(partial.contexts, minutesAgo(30), "half-gone", { files: ["here.ts", "vanished.ts"] });

  // --- no files_modified recorded at all
  const nofiles = scen("nofiles");
  writeContext(nofiles.contexts, minutesAgo(10), "no-files", { files: [] });

  // --- too old
  const old = scen("old");
  fs.writeFileSync(path.join(old.proj, "a.ts"), "a", "utf8");
  writeContext(old.contexts, daysAgo(400), "ancient", { files: ["a.ts"] });

  // --- filename and frontmatter timestamps disagree
  const disputed = scen("disputed");
  fs.writeFileSync(path.join(disputed.proj, "a.ts"), "a", "utf8");
  writeContext(disputed.contexts, minutesAgo(15), "disputed-stamp", {
    files: ["a.ts"],
    isoOverride: isoLocal(daysAgo(21)),
  });

  // --- windows-shaped and dot-prefixed paths inside files_modified
  const winpaths = scen("winpaths");
  fs.mkdirSync(path.join(winpaths.proj, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(winpaths.proj, "src", "deep", "c.ts"), "c", "utf8");
  fs.writeFileSync(path.join(winpaths.proj, "d.ts"), "d", "utf8");
  writeContext(winpaths.contexts, minutesAgo(6), "win-paths", { files: ["src\\deep\\c.ts", "./d.ts"] });

  // --- a context that only exists in the gstack legacy location
  const legacy = scen("legacy");
  fs.writeFileSync(path.join(legacy.proj, "a.ts"), "a", "utf8");
  const legacyDir = path.join(legacy.state, "gstack", "projects", "legacy", "checkpoints");
  writeContext(legacyDir, minutesAgo(9), "from-gstack", { files: ["a.ts"] });
  const legacyEnv = { TOOLBAY_STACK_STATE_DIR: legacy.state, GSTACK_HOME: path.join(legacy.state, "gstack") };

  const cases = [
    // ---------------------------------------------------------- happy paths
    {
      name: "a verified context restores",
      args: ["restore"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.OK,
      includes: ["[OK]", "auth-refactor", "PASS  recorded files still exist"],
    },
    {
      name: "a query selects an older context, not the newest",
      args: ["restore", "pagination"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.OK,
      includes: ["api-pagination"],
      excludes: ["auth-refactor"],
    },
    {
      name: "list prints both saved contexts",
      args: ["list"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.OK,
      includes: ["auth-refactor", "api-pagination"],
    },
    {
      name: "where exits 0 and names every directory it looked in",
      args: ["where"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.OK,
      includes: ["DIRECTORIES SEARCHED", "toolbay-stack", "gstack-legacy"],
    },
    {
      name: "a context saved only in the gstack location is found",
      args: ["restore"],
      cwd: legacy.proj,
      env: legacyEnv,
      exit: EXIT.OK,
      includes: ["from-gstack", "gstack-legacy"],
    },
    {
      name: "windows-shaped and ./-prefixed recorded paths resolve",
      args: ["restore"],
      cwd: winpaths.proj,
      env: winpaths.env,
      exit: EXIT.OK,
      includes: ["all 2 recorded files are present"],
    },
    // ------------------------------------------------- empty vs. broken lookup
    {
      name: "genuinely nothing saved exits 3, not 0 and not 4",
      args: ["restore"],
      cwd: empty.proj,
      env: empty.env,
      exit: EXIT.NONE,
      includes: ["NO SAVED CONTEXTS", "genuinely nothing saved"],
    },
    {
      name: "a broken state root REFUSES instead of reporting nothing saved (gstack prints NO_CHECKPOINTS)",
      args: ["restore"],
      cwd: brokenProj,
      env: { TOOLBAY_STACK_STATE_DIR: brokenRootFile, GSTACK_HOME: path.join(tmp, "nope") },
      exit: EXIT.REFUSED,
      includes: ["REFUSED", "is not a directory"],
      excludes: ["NO SAVED CONTEXTS"],
    },
    // ------------------------------------------------------ ordering integrity
    {
      name: "a junk file that sorts above the newest is skipped, not loaded (gstack loads it)",
      args: ["restore"],
      cwd: junk.proj,
      env: junk.env,
      exit: EXIT.OK,
      includes: ["real-newest", "zz-scratch.md"],
      excludes: ["Title:       zz-scratch"],
    },
    {
      name: "a directory of nothing but junk REFUSES",
      args: ["restore"],
      cwd: junkOnly.proj,
      env: junkOnly.env,
      exit: EXIT.REFUSED,
      includes: ["REFUSED", "zz-scratch.md"],
    },
    {
      name: "an impossible date in the filename is not treated as a timestamp",
      args: ["restore"],
      cwd: baddate.proj,
      env: baddate.env,
      exit: EXIT.REFUSED,
      includes: ["malformed-name", "20261345-999999-impossible.md"],
    },
    {
      name: "a 0-byte newest file does not shadow the real one",
      args: ["restore"],
      cwd: zero.proj,
      env: zero.env,
      exit: EXIT.OK,
      includes: ["older-real", "0 bytes"],
    },
    // ------------------------------------------------------- unparseable files
    {
      name: "a file with no frontmatter is never presented",
      args: ["restore"],
      cwd: nofm.proj,
      env: nofm.env,
      exit: EXIT.REFUSED,
      includes: ["does not start with a --- frontmatter block"],
      excludes: ["RESUMING CONTEXT"],
    },
    {
      name: "frontmatter without branch or timestamp is not a saved context",
      args: ["restore"],
      cwd: nokeys.proj,
      env: nokeys.env,
      exit: EXIT.REFUSED,
      includes: ["not a saved context"],
      excludes: ["RESUMING CONTEXT"],
    },
    // --------------------------------------------------------- staleness gates
    {
      name: "a context whose files are all gone is REFUSED, and its body is withheld",
      args: ["restore"],
      cwd: gone.proj,
      env: gone.env,
      exit: EXIT.REFUSED,
      includes: ["all 2 recorded files are gone", "the tree it describes is gone"],
      excludes: ["Body of deleted-tree"],
    },
    {
      name: "a context with some files gone is STALE and names them",
      args: ["restore"],
      cwd: partial.proj,
      env: partial.env,
      exit: EXIT.STALE,
      includes: ["[STALE]", "vanished.ts", "1 of 2 recorded files are gone"],
    },
    {
      name: "a context recording no files can never be OK, because nothing in it is checkable",
      args: ["restore"],
      cwd: nofiles.proj,
      env: nofiles.env,
      exit: EXIT.STALE,
      includes: ["records no files_modified"],
    },
    {
      name: "a context older than the age limit is STALE",
      args: ["restore"],
      cwd: old.proj,
      env: old.env,
      exit: EXIT.STALE,
      includes: ["older than the 30-day limit"],
    },
    {
      name: "--max-age-days can widen the limit, and then the same context is OK",
      args: ["restore", "--max-age-days", "1000"],
      cwd: old.proj,
      env: old.env,
      exit: EXIT.OK,
      includes: ["[OK]"],
    },
    {
      name: "filename and frontmatter timestamps that disagree are never OK",
      args: ["restore"],
      cwd: disputed.proj,
      env: disputed.env,
      exit: EXIT.STALE,
      includes: ["they disagree by", "FAIL  timestamp provenance"],
    },
    // ------------------------------------------------------- query discipline
    {
      name: "a query that matches nothing REFUSES instead of falling back to the newest",
      args: ["restore", "nonexistent-topic"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.REFUSED,
      includes: ["matches"],
      excludes: ["RESUMING CONTEXT", "auth-refactor"],
    },
    {
      name: "an ambiguous query REFUSES and lists the candidates",
      args: ["restore", "a"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.REFUSED,
      includes: ["matches 2 saved contexts", "auth-refactor", "api-pagination"],
      excludes: ["RESUMING CONTEXT"],
    },
    {
      name: "--json carries the verdict and the failed checks",
      args: ["restore", "--json"],
      cwd: partial.proj,
      env: partial.env,
      exit: EXIT.STALE,
      includes: ['"verdict": "STALE"', '"missingFiles"', "vanished.ts"],
    },
    // ------------------------------------------------------------- CLI hygiene
    {
      name: "an unknown subcommand exits non-zero and restores nothing",
      args: ["frobnicate"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.USAGE,
      excludes: ["RESUMING CONTEXT"],
    },
    {
      name: "a bad --max-age-days is refused rather than silently defaulted",
      args: ["restore", "--max-age-days", "banana"],
      cwd: good.proj,
      env: good.env,
      exit: EXIT.REFUSED,
      includes: ["--max-age-days"],
      excludes: ["RESUMING CONTEXT"],
    },
  ];

  for (const c of cases) {
    const r = runCli(c.args, { cwd: c.cwd, env: c.env });
    const missing = (c.includes ?? []).filter((s) => !r.stdout.includes(s));
    const leaked = (c.excludes ?? []).filter((s) => r.stdout.includes(s));
    const exitOk = r.status === c.exit;
    const pass = exitOk && !missing.length && !leaked.length;
    const detail = [
      exitOk ? "" : `exit ${r.status} (wanted ${c.exit})`,
      missing.length ? `missing from output: ${missing.map((s) => JSON.stringify(s)).join(", ")}` : "",
      leaked.length ? `should NOT have printed: ${leaked.map((s) => JSON.stringify(s)).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    results.push({ name: c.name, expected: `exit ${c.exit}`, got: `exit ${r.status}`, pass, detail });
  }

  // Same guard rule: a selftest whose assertion count depends on where it ran
  // can quietly stop asserting things.
  const EXPECTED = cases.length + 1;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict. An EPERM from a handle Windows
  // has not released yet must not take the report down with it — a selftest that
  // dies before printing "N/M passed" is indistinguishable from one that never
  // ran, which is the fail-open this engine exists to delete.
  } catch (e) {
    check("the tb-context-restore selftest ran to completion without throwing", true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-context-restore selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  Restore is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken saved-context directory above ends in a refusal or a\n");
  process.stdout.write("  labelled STALE, never in a confident restore. That is the behaviour that matters:\n");
  process.stdout.write("  a restore that cannot verify itself says so instead of inventing the context.\n\n");
}

// --------------------------------------------------------------------- entry

function help(out) {
  out(`
  tb-context-restore ${VERSION}, the saved-context verifier for Toolbay Stack

    restore [query] [--json] [--max-age-days N] [--body-limit N]
        Load the most recent saved context for this project, verify it, and
        print it. [query] selects one by title fragment, branch, or list number.

    list        every loadable saved context, plus every file that is not one
    where       the project slug, how it was derived, and every directory searched
    selftest    run this CLI against deliberately broken saved-context
                directories and fail if any of them produce a confident restore

  Exit codes:  0 verified   3 nothing saved   4 refused (could not verify)
               5 stale (real, but the world moved on)   2 usage

  "Nothing saved" and "I could not look" are different answers here, and they
  have different exit codes. A context that cannot be verified is never printed
  as though it were.
`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const out = (s) => process.stdout.write(`${s}\n`);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help(out);
    return EXIT.OK;
  }
  if (cmd === "restore" || cmd === "resume") return cmdRestore(argv.slice(1), out);
  if (cmd === "list" || cmd === "ls") return cmdList(argv.slice(1), out);
  if (cmd === "where" || cmd === "doctor") return cmdWhere(argv.slice(1), out);
  if (cmd === "selftest") {
    selftest();
    return process.exitCode ?? EXIT.OK;
  }
  out(`Unknown command "${cmd}".`);
  help(out);
  return EXIT.USAGE;
}

// A crash must never look like a successful restore.
try {
  process.exitCode = main();
} catch (err) {
  process.stdout.write(`REFUSED: tb-context-restore crashed (${err?.message ?? err}). Nothing was restored.\n`);
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = EXIT.REFUSED;
}
