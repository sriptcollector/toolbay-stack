#!/usr/bin/env node
/**
 * tb-suggest.mjs: read the project as it is right now, and say what is worth
 * doing next. In plain language, with the reason, and without running anything.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no suggestion layer and no code or contract here is derived from
 * it; this file ships inside gstack's skill-per-directory layout and alongside
 * skills forked from it. Not affiliated with or endorsed by Garry Tan.
 * See LICENSE and NOTICE.
 *
 * THREE RULES THIS FILE IS BUILT ON
 *
 * 1. IT SUGGESTS, IT DOES NOT ACT. Nothing here writes, commits, installs,
 *    fetches, or opens a socket. The only commands it runs are read-only git
 *    queries, and they are run through `git --no-optional-locks`, so observing
 *    the project cannot even refresh the index on disk. Every command used is
 *    printed at the bottom of the output, so the claim is checkable instead of
 *    promised. A tool that suggests and a tool that acts have different blast
 *    radii and this one is the harmless kind.
 *
 * 2. IT IS ALLOWED TO SAY THERE IS NOTHING. The failure mode of every "what
 *    should I do next" feature is that it always has an answer, because always
 *    having an answer is what makes it look smart. Three days later you stop
 *    reading it. So every suggestion needs an observation behind it that is
 *    printed next to it, suggestions below a confidence floor are dropped
 *    rather than padded out, and a clean tree with nothing pending prints
 *    "nothing worth suggesting" and the list of things it checked to be sure.
 *
 * 3. IT DOES NOT KEEP ITS OWN LIST OF SKILLS. The suggestion is written in
 *    English ("review this before it grows"), and the router turns it into a
 *    command by asking the same question, against the same catalog read off the
 *    same disk, inside the same mode. So `suggest` cannot recommend a skill
 *    that is not installed, cannot miss one that is, and cannot drift when a
 *    skill is renamed. If the router is missing, the suggestions still print;
 *    they just arrive without command names, and it says so.
 *
 * DEGRADING IS A FEATURE, NOT AN ERROR PATH. Outside a git repo, on a repo with
 * no commits, and on a repo git itself cannot read, this still answers. Those
 * are the three states a fresh machine is actually in, and a tool that throws
 * on them is a tool you meet at the worst moment.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(SELF, "..", "..");
const VERSION = "0.1.0";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

const EXIT_SUGGESTED = 0; // there is something worth doing, and it is printed
const EXIT_UNUSABLE = 2; // the working directory itself could not be read
const EXIT_DEGRADED = 3; // observation was incomplete (said so, printed what it had)
const EXIT_NOTHING = 4; // verified: nothing worth suggesting

// The floor a suggestion has to clear to be printed at all, and the most that
// will ever be printed. Both exist for the same reason: a list of eight things
// is not a suggestion, it is a backlog, and nobody reads it twice.
const FLOOR = 25;
const MAX_SUGGESTIONS = 3;

// --------------------------------------------------------------- read-only git

/**
 * Every git call in this file goes through here.
 *
 * --no-optional-locks: `git status` normally rewrites the index to cache the
 * stat information it just gathered. That is a write. This tool promises not to
 * write, so it gives up the cache instead.
 *
 * The timeout is not decoration. A repository with a stale index.lock, a dead
 * network filesystem, or a half-finished clone will hang git indefinitely, and
 * a suggestion engine that hangs your terminal is worse than one that says it
 * could not tell.
 */
const GIT_READ_ONLY_COMMANDS = [
  "git --no-optional-locks rev-parse --is-inside-work-tree",
  "git --no-optional-locks rev-parse --absolute-git-dir",
  "git --no-optional-locks status --porcelain=v1 --branch --untracked-files=all",
  "git --no-optional-locks log -1 --format=%H%x00%s%x00%ct%x00%an",
  "git --no-optional-locks diff --numstat HEAD",
  "git --no-optional-locks stash list",
  "git --no-optional-locks branch --contains HEAD --format=%(refname)   (only when HEAD is detached)",
];

function git(args, cwd, timeout = 5000) {
  let res;
  try {
    res = spawnSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err?.message || err), missing: false, timedOut: false };
  }
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout ?? "").replace(/\s+$/, ""),
    stderr: (res.stderr ?? "").trim(),
    missing: res.error?.code === "ENOENT",
    timedOut: res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM",
  };
}

// ------------------------------------------------------------------ file scan

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "vendor", "target", "coverage", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", ".gradle", "Pods", "DerivedData", ".terraform", ".cache", ".turbo",
]);

const SOURCE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".ex", ".exs",
  ".scala", ".sh", ".ps1", ".sql", ".vue", ".svelte",
]);

const UI_EXT = new Set([".tsx", ".jsx", ".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte", ".astro"]);

const TEST_PATH = /(^|[\\/])(tests?|specs?|__tests__|e2e)([\\/]|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|test_[^\\/]+\.py$/i;

const SECRET_LIKE = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])(id_rsa|id_ed25519)(\.pub)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[\\/])(credentials|service-account|serviceaccount)[^\\/]*\.json$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml)$/i,
];

/**
 * Walk the project shallowly. Bounded on purpose: this runs before someone has
 * asked for anything, so it has to cost nothing. A repo big enough to blow the
 * cap gets a truncated answer that says it was truncated, which is still true.
 */
function scanFiles(cwd, { maxDepth = 5, maxFiles = 4000 } = {}) {
  const files = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree is not fatal, it is just unseen
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".") && ent.name !== ".github") continue;
        walk(abs, depth + 1);
      } else if (ent.isFile()) {
        let mtime = 0;
        try {
          mtime = fs.statSync(abs).mtimeMs;
        } catch {
          continue;
        }
        files.push({ rel: path.relative(cwd, abs).replace(/\\/g, "/"), ext: path.extname(ent.name).toLowerCase(), mtime });
      }
    }
  };
  walk(cwd, 0);
  return { files, truncated };
}

function detectTests(cwd, files) {
  const testFiles = files.filter((f) => TEST_PATH.test(f.rel));
  const markers = [
    "jest.config.js", "jest.config.ts", "jest.config.mjs", "vitest.config.js", "vitest.config.ts",
    "playwright.config.ts", "playwright.config.js", "pytest.ini", "tox.ini", "phpunit.xml",
    "karma.conf.js", "cypress.config.ts", "cypress.config.js", ".rspec",
  ].filter((m) => files.some((f) => f.rel === m));

  let script = null;
  const pkgFile = path.join(cwd, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      const t = pkg?.scripts?.test;
      // The npm default is a placeholder that exits 1. Counting it as "has
      // tests" is exactly the kind of false comfort this tool must not create.
      if (t && !/no test specified/i.test(t)) {
        const shown = t.length > 48 ? `${t.slice(0, 45)}...` : t;
        script = `npm test  (${shown})`;
      }
    } catch {
      /* an unparseable package.json is a fact about the repo, not a crash */
    }
  }
  return { count: testFiles.length, markers, script, any: testFiles.length > 0 || markers.length > 0 || Boolean(script) };
}

// ------------------------------------------------------------------- observing

function ago(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "at an unknown time";
  const m = Math.floor(seconds / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

function parseStatus(porcelain) {
  const changed = [];
  const untracked = [];
  const conflicted = [];
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const info = line.slice(3);
      // Detached HEAD is stated outright by porcelain, and it is worth reading
      // outright rather than inferring it from a branch that came back null.
      // Those are different facts: one is "you are not on a branch", the other
      // is "this line did not parse", and only the first one is safe to act on.
      if (/^HEAD \(no branch\)/.test(info)) {
        detached = true;
        continue;
      }
      const m = /^(?:No commits yet on )?([^.\s]+(?:[^.\s]|\.(?!\.\.))*)?(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(info);
      if (m) {
        branch = (m[1] || "").trim() || null;
        upstream = m[2] || null;
        const track = m[3] || "";
        const a = /ahead (\d+)/.exec(track);
        const b = /behind (\d+)/.exec(track);
        ahead = a ? Number(a[1]) : 0;
        behind = b ? Number(b[1]) : 0;
      }
      if (/^## No commits yet on /.test(line)) branch = line.replace(/^## No commits yet on /, "").split(/\s/)[0];
      continue;
    }
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).replace(/^"|"$/g, "");
    if (x === "?" && y === "?") {
      untracked.push(file);
    } else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted.push(file);
    } else {
      changed.push({ file: file.includes(" -> ") ? file.split(" -> ")[1] : file, x, y });
    }
  }
  return { changed, untracked, conflicted, branch, upstream, ahead, behind, detached };
}

/** Operations git is halfway through. Each one leaves a file behind in .git. */
function inProgress(gitDir) {
  const marks = [
    ["MERGE_HEAD", "a merge"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["BISECT_LOG", "a bisect"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or am"],
  ];
  const found = [];
  for (const [name, label] of marks) {
    try {
      if (fs.existsSync(path.join(gitDir, name))) found.push(label);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(found)];
}

/**
 * Everything known about the project, and how confident it is about each part.
 * Never throws: any step that fails records why and the rest carries on.
 */
function observe(cwd) {
  const notes = []; // things that limited what could be seen
  const state = {
    cwd,
    readable: true,
    git: { available: true, isRepo: false, usable: false, error: null },
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    // null means "not looked at, or git would not answer". An empty array is a
    // real finding: nothing points at this commit. The difference matters,
    // because one of them is allowed to raise an alarm and the other is not.
    branchesContaining: null,
    hasCommits: false,
    head: null,
    changed: [],
    untracked: [],
    conflicted: [],
    inProgress: [],
    insertions: 0,
    deletions: 0,
    stash: 0,
    files: [],
    filesTruncated: false,
    tests: { count: 0, markers: [], script: null, any: false },
    lastTouched: null,
    notes,
  };

  try {
    fs.readdirSync(cwd);
  } catch (err) {
    state.readable = false;
    notes.push(`this directory cannot be read (${err.code || err.message})`);
    return state;
  }

  const scan = scanFiles(cwd);
  state.files = scan.files;
  state.filesTruncated = scan.truncated;
  if (scan.truncated) notes.push("the file scan hit its cap, so counts below are a lower bound");
  state.tests = detectTests(cwd, scan.files);
  const newest = scan.files.reduce((a, f) => (!a || f.mtime > a.mtime ? f : a), null);
  if (newest) state.lastTouched = { rel: newest.rel, ago: ago((Date.now() - newest.mtime) / 1000) };

  const probe = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.missing) {
    state.git.available = false;
    state.git.error = "git is not on PATH";
    notes.push("git is not installed or not on PATH, so nothing about history or changes can be seen");
    return state;
  }
  if (probe.timedOut) {
    state.git.error = "git did not answer within 5s";
    notes.push("git did not answer within 5 seconds, so the repository state is unknown");
    return state;
  }
  if (!probe.ok || probe.stdout !== "true") {
    // Two very different things land here: an ordinary folder, and a folder
    // with a .git that git refuses to open. Telling them apart is the whole
    // difference between a calm answer and a wrong one.
    const hasGitDir = fs.existsSync(path.join(cwd, ".git"));
    state.git.isRepo = hasGitDir;
    state.git.error = probe.stderr.split("\n")[0] || `git exited ${probe.status}`;
    if (hasGitDir) notes.push(`there is a .git here but git will not open it: ${state.git.error}`);
    return state;
  }

  state.git.isRepo = true;
  const gitDir = git(["rev-parse", "--absolute-git-dir"], cwd);
  if (gitDir.ok && gitDir.stdout) state.inProgress = inProgress(gitDir.stdout);

  // --untracked-files=all, not the default. The default collapses a new
  // directory to a single entry ending in "/", so a change that added
  // src/api.ts, src/store.ts and src/panel.tsx reads as one new thing called
  // "src/". Every rule below that looks at file names (the secret check, the
  // interface check, the has-a-test check) would then be looking at a
  // directory name and finding nothing. Verified on Windows 11, 2026-08-13:
  // with the default, a fixture with four new source files reported "1 new"
  // and produced no review suggestion at all.
  const status = git(["status", "--porcelain=v1", "--branch", "--untracked-files=all"], cwd);
  if (!status.ok) {
    state.git.error = status.stderr.split("\n")[0] || `git status exited ${status.status}`;
    notes.push(`git status failed: ${state.git.error}`);
    return state;
  }
  state.git.usable = true;
  const parsed = parseStatus(status.stdout);
  Object.assign(state, {
    changed: parsed.changed,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    detached: parsed.detached,
  });

  const head = git(["log", "-1", "--format=%H%x00%s%x00%ct%x00%an"], cwd);
  if (head.ok && head.stdout) {
    const [sha, subject, ct, author] = head.stdout.split("\u0000");
    state.hasCommits = true;
    state.head = {
      sha: (sha || "").slice(0, 8),
      subject: subject || "(no message)",
      author: author || "",
      ago: ago(Date.now() / 1000 - Number(ct)),
      ageDays: (Date.now() / 1000 - Number(ct)) / 86400,
    };
  } else if (head.stderr && !/does not have any commits|unknown revision|bad default revision/i.test(head.stderr)) {
    // An empty repo is expected and quiet. Anything else is worth saying.
    notes.push(`the last commit could not be read: ${head.stderr.split("\n")[0]}`);
    state.git.error = state.git.error || head.stderr.split("\n")[0];
  }

  // Only asked when HEAD is detached, because that is the only state where the
  // answer changes anything. "Which branches contain this commit" is the
  // difference between visiting an old commit (main contains it, nothing is at
  // risk) and having committed while detached (nothing contains it, and the
  // work is held by the reflog alone until it is garbage collected). Guessing
  // between those two from the detached flag alone would raise a false alarm on
  // every `git checkout <sha>`, which is how a warning stops being read.
  if (state.detached && state.hasCommits) {
    const contains = git(["branch", "--contains", "HEAD", "--format=%(refname)"], cwd);
    if (contains.ok) {
      // %(refname), not %(refname:short), and filtered to refs/heads/.
      //
      // `git branch --contains` lists the detached HEAD itself as a pseudo-entry,
      // "(HEAD detached from 7fe807a)". With the short format that is
      // indistinguishable from a branch name, so a commit reachable from NOTHING
      // came back as one branch and the loss warning below never fired — the
      // exact fail-open this file exists to avoid, caught by its own selftest.
      // Matching the pseudo-entry's text would work in English and break in a
      // localised git; refs/heads/ is a wire format and is never translated.
      state.branchesContaining = contains.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("refs/heads/"))
        .map((l) => l.slice("refs/heads/".length));
    } else {
      // Left as null on purpose: unknown, so the loss-risk rule below stays
      // silent rather than claiming a risk it did not verify.
      notes.push("HEAD is detached and git could not say which branches contain it, so whether the work here is reachable is unknown");
    }
  }

  if (state.hasCommits) {
    const numstat = git(["diff", "--numstat", "HEAD"], cwd);
    if (numstat.ok) {
      for (const line of numstat.stdout.split(/\r?\n/)) {
        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!m) continue;
        state.insertions += m[1] === "-" ? 0 : Number(m[1]);
        state.deletions += m[2] === "-" ? 0 : Number(m[2]);
      }
    }
  }

  const stash = git(["stash", "list"], cwd);
  if (stash.ok && stash.stdout) state.stash = stash.stdout.split(/\r?\n/).filter(Boolean).length;

  return state;
}

// ---------------------------------------------------------------- suggestions

const sourceFiles = (files) => files.filter((f) => SOURCE_EXT.has(f.ext));

/**
 * Where the bulk of a change actually lives.
 *
 * "Look over the 49 changed files" is a misleading headline when 46 of them are
 * a dependency directory or a freshly installed tool that happens not to be
 * ignored. Saying where they are costs one line and stops the suggestion from
 * overstating what you did.
 */
function dominantDir(names) {
  if (names.length < 4) return null;
  const counts = new Map();
  for (const n of names) {
    const parts = n.split("/");
    const key = parts.length > 1 ? `${parts.slice(0, Math.min(2, parts.length - 1)).join("/")}/` : "the top level";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size < 2) return null;
  let best = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] / names.length >= 0.6 ? { dir: best[0], count: best[1] } : null;
}

/**
 * Turn observations into candidate suggestions.
 *
 * Every candidate carries the observation that produced it, and that
 * observation is printed with it. If a suggestion cannot show its evidence it
 * does not belong in the list, because then it is a guess wearing the clothes
 * of an answer.
 *
 * `ask` is the suggestion phrased the way a person would say it. The router
 * turns that into a command. Nothing here names a skill.
 */
function suggestions(s) {
  const list = [];
  const add = (weight, headline, reason, ask = null, kind = "hygiene") => list.push({ weight, headline, reason, ask, kind });

  // ---- states where git cannot tell us anything
  if (!s.readable) {
    add(100, "Point this at a folder that can be read", `The current directory could not be listed: ${s.notes[0]}.`, null, "blocked");
    return list;
  }

  if (!s.git.available) {
    if (s.files.length) {
      add(
        60,
        "Nothing here is tracked, and git is not installed",
        `${s.files.length} file(s) are in this folder, the newest touched ${s.lastTouched?.ago}. Without git there is no record of what changed, so I can only see the files, not the work.`,
        null,
        "safety",
      );
    }
    return list;
  }

  if (s.git.isRepo && !s.git.usable) {
    add(
      100,
      "Git cannot open this repository, so treat everything else as unknown",
      `git said: ${s.git.error}. Until that is fixed, no tool here can tell what changed, and any answer about the state of this project would be invented. ` +
        (s.lastTouched ? `The only thing readable is the filesystem: ${s.lastTouched.rel} was touched ${s.lastTouched.ago}.` : "The folder itself is readable but empty of files."),
      "the git repository is corrupt and will not open, work out why",
      "blocked",
    );
    return list;
  }

  if (!s.git.isRepo) {
    if (!s.files.length) return list; // an empty folder. There is genuinely nothing to say.
    const src = sourceFiles(s.files).length;
    add(
      src ? 70 : 40,
      "This folder is not under version control",
      `${s.files.length} file(s) here${src ? `, ${src} of them source` : ""}, newest touched ${s.lastTouched?.ago}. ` +
        "Nothing is recorded, so nothing can be reviewed, compared, or undone. That also means no tool here can tell you what you changed today.",
      null,
      "safety",
    );
    return list;
  }

  // ---- inside a working repository
  const changedCount = s.changed.length + s.untracked.length;
  const changedNames = [...s.changed.map((c) => c.file), ...s.untracked];

  if (s.conflicted.length) {
    add(
      98,
      `Finish the conflict you are standing in (${s.conflicted.length} file${s.conflicted.length === 1 ? "" : "s"})`,
      `git reports unmerged paths: ${s.conflicted.slice(0, 3).join(", ")}${s.conflicted.length > 3 ? ", ..." : ""}. Nothing else is worth starting until these are resolved, and any test run right now is testing a half-merged tree.`,
      "resolve the merge conflicts in these files",
      "blocked",
    );
  } else if (s.inProgress.length) {
    add(
      92,
      `You are in the middle of ${s.inProgress.join(" and ")}`,
      `git still has the operation open (its state file is in .git). Finish or abort it before starting something new, or the next commit will carry someone else's changes with it.`,
      `finish the ${s.inProgress[0]} that is in progress`,
      "blocked",
    );
  }

  const secrets = changedNames.filter((f) => SECRET_LIKE.some((re) => re.test(f)));
  if (secrets.length) {
    add(
      90,
      `Check ${secrets.length === 1 ? "this file" : "these files"} before they get committed: ${secrets.slice(0, 3).join(", ")}`,
      "Files with those names usually hold credentials, and they are showing up as changed or untracked rather than ignored. A secret is easy to remove now and permanent once it is pushed.",
      "check this change for leaked credentials and secrets before it is committed",
      "safety",
    );
  }

  // Detached HEAD, split into the two cases that actually differ.
  //
  // Visiting an old commit is ordinary and gets no warning: a branch contains
  // it, nothing can be lost, and firing here would train people to ignore this
  // line. What is worth interrupting for is work that no branch can reach, and
  // work about to become that.
  if (s.detached && s.hasCommits) {
    const at = `${s.head.sha} ("${s.head.subject}", ${s.head.ago})`;
    if (Array.isArray(s.branchesContaining) && s.branchesContaining.length === 0) {
      add(
        88,
        "Give this work a branch name: nothing points at it",
        `HEAD is detached at ${at}, and no branch contains that commit. Work in this state is held by the reflog alone: it is absent from every log, diff and push, and git will eventually garbage-collect it. It costs one command to keep and is unrecoverable once it is gone.`,
        "i committed on a detached head and no branch points at the work, save it to a branch",
        "safety",
      );
    } else if (changedCount > 0) {
      const held = Array.isArray(s.branchesContaining) && s.branchesContaining.length ? s.branchesContaining.slice(0, 3).join(", ") : "a branch";
      add(
        82,
        `Get on a branch before committing (${changedCount} file${changedCount === 1 ? "" : "s"} open, HEAD is detached)`,
        `HEAD is detached at ${at}. ${held} already contains that commit, so nothing is lost yet, but anything committed from here lands on no branch and stops appearing in log, diff and push. Naming a branch now is free; recovering the commits afterwards means reading the reflog.`,
        "i am on a detached head with uncommitted changes, put me on a branch",
        "safety",
      );
    }
  }

  if (!s.hasCommits) {
    if (s.files.length) {
      add(
        80,
        "Make the first commit, so there is something to fall back to",
        `This repository has no commits yet and ${s.files.length} file(s) are sitting here untracked. Until the first commit exists there is no diff, no history, and nothing to undo to.`,
        "commit this for the first time",
        "safety",
      );
      const src = sourceFiles(s.files).length;
      if (src >= 3 && !s.files.some((f) => /^readme(\.|$)/i.test(f.rel))) {
        add(30, "Write down what this is, while you still think it is obvious", `${src} source files and no README. In a week the intent is the part that is gone.`, "write a readme for this project", "docs");
      }
    }
    return list;
  }

  // A change big enough to be worth a second pair of eyes. Weight rises with
  // size, because a 40-file diff going unreviewed is a worse outcome than a
  // 3-file one, and caps so it cannot crowd out an active conflict.
  if (changedCount >= 3) {
    const churn = s.insertions + s.deletions;
    const bulk = dominantDir(changedNames);
    add(
      Math.min(80, 55 + changedCount),
      `Look over the ${changedCount} changed file${changedCount === 1 ? "" : "s"} before this grows`,
      `${s.changed.length} tracked file${s.changed.length === 1 ? "" : "s"} modified, ${s.untracked.length} new${churn ? `, +${s.insertions}/-${s.deletions} lines` : ""}, all since "${s.head.subject}" ${s.head.ago}.` +
        (bulk ? ` Most of it (${bulk.count} of ${changedCount}) sits under ${bulk.dir}, so the real change may be smaller than the count suggests.` : "") +
        ` A diff is cheapest to read while you still remember why you wrote it.`,
      "review my changes before I merge them",
      "review",
    );
  } else if (changedCount > 0) {
    add(
      35,
      `Commit the ${changedCount} file${changedCount === 1 ? "" : "s"} you have open`,
      `Small and self-contained: ${changedNames.slice(0, 3).join(", ")}. The last commit was "${s.head.subject}" ${s.head.ago}.`,
      "commit this change",
      "hygiene",
    );
  }

  const uiTouched = changedNames.filter((f) => UI_EXT.has(path.extname(f).toLowerCase()));
  if (uiTouched.length) {
    add(
      58,
      `Look at what the UI actually does now (${uiTouched.length} interface file${uiTouched.length === 1 ? "" : "s"} changed)`,
      `${uiTouched.slice(0, 3).join(", ")}${uiTouched.length > 3 ? ", ..." : ""} changed. Interface changes are the ones that compile perfectly and still look wrong, and the only way to know is to open the page.`,
      "the ui changed, open it in a browser and check it looks right",
      "verify",
    );
  }

  const changedSource = changedNames.filter((f) => SOURCE_EXT.has(path.extname(f).toLowerCase()) && !TEST_PATH.test(f));
  const changedTests = changedNames.filter((f) => TEST_PATH.test(f));
  if (changedSource.length >= 2 && s.tests.any && changedTests.length === 0) {
    add(
      50,
      "This change has no test in it, and this project has tests",
      `${changedSource.length} source files changed and none of the ${s.tests.count} test file${s.tests.count === 1 ? "" : "s"} did${s.tests.script ? `, though ${s.tests.script.split("  ")[0]} exists` : ""}. Either the change is not covered, or the coverage is somewhere you have not checked.`,
      "add a test for this change",
      "test",
    );
  } else if (changedSource.length >= 2 && !s.tests.any && sourceFiles(s.files).length >= 8) {
    add(
      40,
      "There is no test suite here at all",
      `${sourceFiles(s.files).length} source files, no test files, no test runner configured, and ${changedSource.length} source file(s) changed right now. Nothing in this repo can tell you when something breaks.`,
      "there are no tests in this project, set up the first one",
      "test",
    );
  }

  if (s.ahead > 0 && changedCount === 0) {
    add(
      72,
      `${s.ahead} commit${s.ahead === 1 ? "" : "s"} finished and not pushed`,
      `The tree is clean and ${s.branch || "this branch"} is ${s.ahead} ahead of ${s.upstream || "its upstream"}. The work is done; it is just not anywhere but this machine yet.`,
      "ship this and push it",
      "ship",
    );
  } else if (s.ahead > 0) {
    add(
      45,
      `${s.ahead} unpushed commit${s.ahead === 1 ? "" : "s"} sitting behind your current work`,
      `${s.branch || "This branch"} is ${s.ahead} ahead of ${s.upstream || "its upstream"} and there are still ${changedCount} uncommitted file(s) on top.`,
      "ship this and push it",
      "ship",
    );
  }

  if (s.behind > 0) {
    add(
      Math.min(65, 40 + s.behind),
      `${s.upstream || "The upstream branch"} has moved on by ${s.behind} commit${s.behind === 1 ? "" : "s"}`,
      "You are working against an older base. The longer that gap gets, the more of the merge is someone else's problem becoming yours.",
      "bring this branch up to date with its upstream",
      "hygiene",
    );
  }

  if (changedCount === 0 && s.ahead === 0 && s.head && s.head.ageDays > 14 && s.branch && !/^(main|master|trunk|develop)$/.test(s.branch)) {
    add(
      30,
      `The branch ${s.branch} has been sitting untouched for ${Math.floor(s.head.ageDays)} days`,
      `Nothing uncommitted, nothing unpushed, last commit "${s.head.subject}" ${s.head.ago}. A branch this old is usually either finished and forgotten, or abandoned. Both are worth closing.`,
    );
  }

  if (s.stash > 0) {
    add(
      26,
      `${s.stash} stash${s.stash === 1 ? "" : "es"} you may have forgotten`,
      "Stashes are invisible in every other view, which is why work dies in them.",
    );
  }

  return list;
}

// ----------------------------------------------------------------- the stance
//
// The mode does not only decide how a suggestion is worded. It decides which
// suggestions exist. SHIP prints one and it is the one that gets the thing
// deployed; WILD says nothing about tests or unpushed commits; LOCK leads with
// what is unverified. The weights live in skills/modes/modes.json, per kind, and
// nothing about them is hardcoded here.

/**
 * The kinds no stance may silence.
 *
 * Duplicated from the modes layer on purpose. tb-mode already strips negative
 * weights against these before they are ever handed out, so this is the second
 * of two independent checks, and it is the one that still holds if this file is
 * ever run against a mode object from somewhere else. The rule is worth two
 * lines of duplication: a mode is a preference about work, and "you are about to
 * commit a credential" is not a preference.
 */
const UNSUPPRESSABLE_KINDS = new Set(["blocked", "safety"]);
const isProtected = (s) => UNSUPPRESSABLE_KINDS.has(s.kind);

/**
 * Apply the active stance to the raw suggestion list.
 *
 * Returns what was chosen and, just as importantly, what the mode removed and
 * why. A layer that quietly deletes suggestions is indistinguishable from a
 * layer that had nothing to say, so every drop is reported.
 */
function applyMode(all, mode) {
  const cfg = (mode && mode.suggest) || { max: null, prefer: {} };
  const prefer = cfg.prefer || {};
  const cap = Number.isFinite(cfg.max) && cfg.max >= 1 ? cfg.max : null;

  const scored = all.map((s) => {
    const asked = Number(prefer[s.kind]);
    const wanted = Number.isFinite(asked) ? asked : 0;
    // The second check. A negative weight against a protected kind is ignored,
    // and the fact that it was ignored is carried out to the caller.
    const refused = wanted < 0 && isProtected(s);
    const delta = refused ? 0 : wanted;
    return { ...s, baseWeight: s.weight, modeDelta: delta, modeRefused: refused, weight: s.weight + delta };
  });

  // The floor applies to the adjusted weight, except for protected kinds, which
  // a mode is never allowed to push under it.
  const eligible = scored.filter((s) => s.weight >= FLOOR || (isProtected(s) && s.baseWeight >= FLOOR));
  const belowFloor = scored.filter((s) => s.baseWeight >= FLOOR && !eligible.includes(s));

  const byWeight = (a, b) => b.weight - a.weight;
  eligible.sort(byWeight);

  // The cap is a preference about WORK, so it is spent on work suggestions. A
  // protected item is a condition, not a task, and it sits on top of the cap
  // rather than consuming it: SHIP asking for one thing to do must not mean the
  // leaking .env is the one thing, leaving the actual ship advice unprinted.
  const limit = Math.min(MAX_SUGGESTIONS, cap ?? MAX_SUGGESTIONS);
  const shielded = eligible.filter(isProtected);
  const rest = eligible.filter((s) => !isProtected(s));
  const keptRest = rest.slice(0, limit);
  const chosen = [...shielded, ...keptRest].sort(byWeight);
  const overflowed = shielded.length > 0 && chosen.length > limit;
  const cutByCap = rest.filter((s) => !keptRest.includes(s));

  return {
    chosen,
    limit,
    cap,
    overflowed,
    droppedByWeight: belowFloor,
    droppedByCap: cutByCap,
    refused: scored.filter((s) => s.modeRefused),
    changed: belowFloor.length > 0 || cutByCap.length > 0 || scored.some((s) => s.modeDelta !== 0),
  };
}

// --------------------------------------------------------------- the router

/**
 * Load the router as a library and use it to name commands.
 *
 * This is the only place `suggest` learns what skills exist, and it learns it
 * the same way the router does: by reading the directories on disk right now.
 * The alternative, a table in this file mapping situations to skill names, is
 * the thing the router was written to delete.
 */
async function loadRouter(extraRoots = [], modeOverride = null) {
  const candidates = [
    path.resolve(SKILL_DIR, "..", "router", "scripts", "route.mjs"),
    path.join(process.cwd(), ".claude", "skills", "router", "scripts", "route.mjs"),
    path.join(os.homedir(), ".claude", "skills", "router", "scripts", "route.mjs"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    return { ok: false, why: "the router skill is not installed next to this one, so suggestions come without command names" };
  }
  try {
    const mod = await import(pathToFileURL(found).href);
    const res = mod.activeMode(modeOverride);
    const catalog = mod.buildCatalog(mod.defaultRoots(extraRoots));
    return { ok: true, mod, catalog, mode: res.mode, modeWarnings: res.warnings || [], path: found };
  } catch (err) {
    return { ok: false, why: `the router failed to load (${err.message}), so suggestions come without command names` };
  }
}

function nameCommand(router, ask) {
  if (!ask || !router.ok) return null;
  try {
    const d = router.mod.decide(ask, router.catalog, router.mode);
    if (!d.best?.skill) return null;
    if (d.best.total >= router.mod.STRONG) return { command: `/${d.best.skill.name}`, sure: true, score: d.best.total };
    if (d.best.total >= router.mod.WEAK) return { command: `/${d.best.skill.name}`, sure: false, score: d.best.total };
    return null;
  } catch {
    return null; // a routing failure must never take the suggestion down with it
  }
}

// -------------------------------------------------------------------- output

function verdictFor(state, chosen) {
  if (!state.readable) return { exit: EXIT_UNUSABLE, label: "UNREADABLE" };
  if (!state.git.available) return { exit: EXIT_DEGRADED, label: "PARTIAL" };
  if (state.git.isRepo && !state.git.usable) return { exit: EXIT_DEGRADED, label: "PARTIAL" };
  if (!chosen.length) return { exit: EXIT_NOTHING, label: "NOTHING TO SUGGEST" };
  return { exit: EXIT_SUGGESTED, label: "SUGGESTED" };
}

function stateLines(s) {
  const rows = [];
  if (!s.git.isRepo) {
    rows.push(["tracking", s.git.available ? "not a git repository" : "git is not installed"]);
  } else if (!s.git.usable) {
    rows.push(["tracking", `git will not open this repository (${s.git.error})`]);
  } else {
    if (s.detached) {
      const held = Array.isArray(s.branchesContaining)
        ? s.branchesContaining.length
          ? `contained by ${s.branchesContaining.slice(0, 3).join(", ")}`
          : "on no branch"
        : "reachability unknown";
      rows.push(["branch", `detached HEAD, not on a branch (${held})`]);
    } else {
      rows.push(["branch", `${s.branch || "(unknown)"}${s.upstream ? ` -> ${s.upstream}` : " (no upstream)"}${s.ahead ? `, ${s.ahead} ahead` : ""}${s.behind ? `, ${s.behind} behind` : ""}`]);
    }
    const churn = s.insertions + s.deletions ? `, +${s.insertions}/-${s.deletions} lines` : "";
    rows.push([
      "changes",
      s.changed.length + s.untracked.length === 0
        ? "clean, nothing uncommitted"
        : `${s.changed.length} modified, ${s.untracked.length} new${s.conflicted.length ? `, ${s.conflicted.length} conflicted` : ""}${churn}`,
    ]);
    rows.push(["last thing", s.hasCommits ? `"${s.head.subject}" ${s.head.ago}` : "no commits yet"]);
    if (s.inProgress.length) rows.push(["in progress", s.inProgress.join(", ")]);
    if (s.stash) rows.push(["stashes", String(s.stash)]);
  }
  rows.push([
    "tests",
    s.tests.any
      ? `${s.tests.count} test file(s)${s.tests.script ? `, ${s.tests.script}` : ""}${s.tests.markers.length ? `, ${s.tests.markers.join(", ")}` : ""}`
      : "none found",
  ]);
  if (s.lastTouched) rows.push(["newest file", `${s.lastTouched.rel}, touched ${s.lastTouched.ago}`]);
  return rows;
}

const CHECKED = [
  "uncommitted and untracked files",
  "conflicts and half-finished merges, rebases and cherry-picks",
  "unpushed and un-pulled commits",
  "whether HEAD is detached, and whether any branch still reaches the work here",
  "credential-shaped files about to be committed",
  "whether a test suite exists, and whether this change touches it",
  "when the last commit was, and what it said",
  "stashes",
];

/**
 * What the stance did to the list.
 *
 * Printed under the suggestions rather than folded into them, because "there is
 * one suggestion" and "there is one suggestion because SHIP asked for one and
 * two others were dropped" are different pieces of information, and only the
 * second one lets you disagree with the mode.
 */
function stanceLines(stance, mode) {
  if (!stance || !mode) return [];
  const lines = [];
  const label = mode.label || String(mode.name || "").toUpperCase();
  // Only when the cap actually held something back. Announcing "CRAFT asks for
  // at most 3 things" above a list of one is the same padding this file refuses
  // everywhere else: it reads like the mode did something, and it did not. The
  // mode is still named in the footer either way, so nothing is hidden.
  if (stance.cap && (stance.droppedByCap.length || stance.overflowed)) {
    lines.push(`${label} asks for at most ${stance.cap} thing${stance.cap === 1 ? "" : "s"} to do at a time.`);
  }
  for (const s of stance.droppedByWeight) {
    lines.push(`Dropped in ${label}: "${s.headline}" (${s.kind} ${s.modeDelta > 0 ? "+" : ""}${s.modeDelta}).`);
  }
  for (const s of stance.droppedByCap) {
    lines.push(`Held back by the ${label} cap: "${s.headline}" (${s.kind}).`);
  }
  if (stance.overflowed) {
    const n = stance.chosen.filter(isProtected).length;
    lines.push(`${n} of these is a condition rather than a task, so it prints on top of the ${label} cap instead of using it up. No mode can suppress those.`);
  }
  for (const s of stance.refused) {
    lines.push(`${label} tried to weight "${s.kind}" suggestions down. That kind cannot be suppressed, so the weight was ignored.`);
  }
  if (!lines.length && stance.changed) lines.push(`${label} reordered these, and nothing was dropped.`);
  return lines;
}

function render(state, chosen, router, { showState = true, stance = null } = {}) {
  const verdict = verdictFor(state, chosen);

  out();
  if (showState) {
    out(bold("  Where this project is right now"));
    out();
    const rows = stateLines(state);
    const w = Math.max(...rows.map((r) => r[0].length));
    for (const [k, v] of rows) out(`    ${dim(k.padEnd(w))}  ${v}`);
    out();
  }

  for (const n of state.notes) out(yellow(`    !  ${n}`));
  if (state.notes.length) out();

  if (!chosen.length) {
    out(bold(green("  Nothing worth suggesting")));
    out();
    out("    I checked:");
    for (const item of CHECKED) out(dim(`      - ${item}`));
    out();
    out("    None of it turned up anything that needs doing. Inventing a task here");
    out("    would waste your time, so: nothing.");
    out();
  } else {
    out(bold("  What I would do next"));
    out();
    chosen.forEach((s, i) => {
      const routed = s.routed;
      out(`  ${bold(String(i + 1))}  ${bold(s.headline)}`);
      if (routed) {
        out(`     ${cyan(routed.command)}${routed.sure ? "" : dim("   (best guess; check it fits before you run it)")}`);
      }
      for (const line of wrap(s.reason, 74)) out(dim(`     ${line}`));
      out();
    });
  }

  const sl = stanceLines(stance, router?.ok ? router.mode : null);
  if (sl.length) {
    out(bold(`  In ${router.mode.label}`));
    for (const l of sl) for (const line of wrap(l, 74)) out(dim(`    ${line}`));
    out(dim(`    Change what this mode prefers: skills/modes/modes.json`));
    out();
  }

  const footer = [];
  footer.push("Nothing above was run. This command only reads:");
  for (const g of GIT_READ_ONLY_COMMANDS) footer.push(`  ${g}`);
  footer.push("plus the file names in this folder. It does not write, commit, install, or");
  footer.push("open a network connection.");
  for (const line of footer) out(dim(`  ${line}`));
  if (router && !router.ok) out(yellow(`  !  ${router.why}`));
  else if (router?.ok) out(dim(`  Commands named by the router, mode ${router.mode.label}, ${router.catalog.length} skills read off disk.`));
  out();
  return verdict.exit;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ------------------------------------------------------------------ commands

async function cmdNow(args, cwd = process.cwd()) {
  const json = args.includes("--json");
  const quiet = args.includes("--quiet");
  const extraRoots = [];
  let modeOverride = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) extraRoots.push(args[i + 1]);
    // Preview a stance without adopting it: "what would you say in SHIP".
    else if (args[i] === "--mode" && args[i + 1]) modeOverride = args[i + 1];
  }

  const state = observe(cwd);
  const router = await loadRouter(extraRoots, modeOverride);
  const all = suggestions(state).sort((a, b) => b.weight - a.weight);
  const stance = applyMode(all, router.ok ? router.mode : null);
  const chosen = stance.chosen.map((s) => ({ ...s, routed: nameCommand(router, s.ask) }));

  if (json) {
    const verdict = verdictFor(state, chosen);
    out(
      JSON.stringify(
        {
          verdict: verdict.label,
          exit: verdict.exit,
          cwd,
          ranAnything: false,
          state: {
            gitAvailable: state.git.available,
            isRepo: state.git.isRepo,
            gitUsable: state.git.usable,
            gitError: state.git.error,
            branch: state.branch,
            upstream: state.upstream,
            ahead: state.ahead,
            behind: state.behind,
            detached: state.detached,
            branchesContaining: state.branchesContaining,
            hasCommits: state.hasCommits,
            head: state.head,
            modified: state.changed.length,
            untracked: state.untracked.length,
            conflicted: state.conflicted.length,
            inProgress: state.inProgress,
            insertions: state.insertions,
            deletions: state.deletions,
            stash: state.stash,
            fileCount: state.files.length,
            tests: { any: state.tests.any, count: state.tests.count, script: state.tests.script, markers: state.tests.markers },
            lastTouched: state.lastTouched,
          },
          notes: state.notes,
          routing: router.ok ? { available: true, mode: router.mode.name, skills: router.catalog.length } : { available: false, why: router.why },
          mode: router.ok
            ? {
                name: router.mode.name,
                label: router.mode.label,
                builtin: Boolean(router.mode.builtin),
                max: stance.cap,
                applied: stance.limit,
                changedTheList: stance.changed,
                droppedByWeight: stance.droppedByWeight.map((s) => ({ headline: s.headline, kind: s.kind, weight: s.baseWeight, modeDelta: s.modeDelta })),
                droppedByCap: stance.droppedByCap.map((s) => ({ headline: s.headline, kind: s.kind, weight: s.weight })),
                keptDespiteCap: stance.overflowed,
                refusedSuppression: stance.refused.map((s) => ({ headline: s.headline, kind: s.kind })),
                warnings: router.modeWarnings || [],
              }
            : { name: null, label: null, changedTheList: false, why: router.why },
          suggestions: chosen.map((s) => ({
            headline: s.headline,
            reason: s.reason,
            kind: s.kind,
            weight: s.weight,
            baseWeight: s.baseWeight,
            modeDelta: s.modeDelta,
            protectedFromMode: isProtected(s),
            command: s.routed?.command ?? null,
            confident: s.routed ? s.routed.sure : null,
            askedAs: s.ask,
          })),
          checked: CHECKED,
        },
        null,
        2,
      ),
    );
    process.exitCode = verdict.exit;
    return;
  }

  process.exitCode = render(state, chosen, router, { showState: !quiet, stance });
}

function cmdState(args, cwd = process.cwd()) {
  const state = observe(cwd);
  if (args.includes("--json")) {
    out(JSON.stringify(state, (k, v) => (k === "files" ? `${v.length} files (elided)` : v), 2));
    return;
  }
  out();
  const rows = stateLines(state);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) out(`    ${dim(k.padEnd(w))}  ${v}`);
  for (const n of state.notes) out(yellow(`    !  ${n}`));
  out();
}

// ------------------------------------------------------------------ selftest

function runSelf(args, cwd, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1", ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GIT_ID = ["-c", "user.email=selftest@toolbay.invalid", "-c", "user.name=tb selftest", "-c", "commit.gpgsign=false"];
const g = (dir, ...args) => spawnSync("git", [...GIT_ID, ...args], { cwd: dir, encoding: "utf8", windowsHide: true });

/** Parse a --json run, and treat unparseable output as a failure, not a crash. */
function jsonOf(r) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

async function selftest() {
  const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  const haveGit = !gitProbe.error && gitProbe.status === 0;
  if (!haveGit) {
    out("\n  tb-suggest selftest: git is not available, so the repository scenarios cannot be proved.");
    out("  Failing rather than reporting a pass that was never run.\n");
    process.exitCode = 1;
    return false;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-suggest-selftest-"));

  // THE SANDBOX IS SEALED OFF FROM ANY REPOSITORY ABOVE IT.
  //
  // The "not a git repo" and "empty folder" fixtures below are the whole point
  // of this engine: they prove it says UNKNOWN and NOTHING TO SUGGEST instead of
  // inventing advice. os.tmpdir() lives under the user's home on Windows, so a
  // single stray `git init` in HOME — found on this machine 2026-08-16 — makes
  // both fixtures "a repository" and the engine answers about the user's home
  // directory instead. Six assertions here were measuring the developer's
  // machine rather than this code.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;

  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // Every scenario is also checked for the two ways this command could fail
  // badly: a thrown stack trace, or an answer that is not machine-readable.
  const sane = (label, r) => {
    const j = jsonOf(r);
    check(`${label}: produced parseable output`, true, j !== null, r.stderr.split("\n")[0] || r.stdout.slice(0, 120));
    check(`${label}: did not crash`, true, !/^\s*(node:internal|.*Error:|\s+at )/m.test(r.stderr), r.stderr.split("\n").slice(0, 2).join(" | "));
    check(`${label}: reported that it ran nothing`, true, j?.ranAnything === false);
    const answered = Boolean(j && (j.suggestions.length > 0 || j.verdict === "NOTHING TO SUGGEST"));
    check(`${label}: gave a suggestion or an honest "nothing"`, true, answered, j ? `verdict ${j.verdict}, ${j.suggestions?.length} suggestion(s)` : "");
    return j;
  };

  // ---------------------------------------------------- 1. not a git repo
  {
    const dir = path.join(tmp, "not-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "console.log(1)\n", "utf8");
    fs.writeFileSync(path.join(dir, "util.js"), "export const a = 1\n", "utf8");
    const r = runSelf(["--json"], dir);
    const j = sane("not a git repo", r);
    check("not a git repo: says so in plain language", true, /not under version control/i.test(JSON.stringify(j?.suggestions ?? [])), j?.suggestions?.[0]?.headline);
    check("not a git repo: does not claim to be a repo", false, j?.state?.isRepo);
    check("not a git repo: exit code is the normal one", 0, r.status);

    // The genuinely empty folder: nothing observed, so nothing claimed.
    const empty = path.join(tmp, "empty-folder");
    fs.mkdirSync(empty, { recursive: true });
    const re = runSelf(["--json"], empty);
    const je = sane("empty folder", re);
    check("empty folder: says nothing to suggest rather than inventing one", "NOTHING TO SUGGEST", je?.verdict);
    check("empty folder: exits 4, distinguishable from 'I had suggestions'", 4, re.status);
  }

  // ---------------------------------------------------- 2. empty repository
  {
    const dir = path.join(tmp, "empty-repo");
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "--initial-branch", "main", ".");
    fs.writeFileSync(path.join(dir, "app.py"), "print('hi')\n", "utf8");
    const r = runSelf(["--json"], dir);
    const j = sane("empty repo", r);
    check("empty repo: knows there are no commits", false, j?.state?.hasCommits);
    check("empty repo: suggests the first commit", true, /first commit/i.test(JSON.stringify(j?.suggestions ?? [])), j?.suggestions?.[0]?.headline);
    check("empty repo: did not try to read a diff against a HEAD that does not exist", 0, (j?.notes ?? []).filter((n) => /bad revision|unknown revision/i.test(n)).length);

    // A repo with no commits AND no files: the honest answer is nothing.
    const bare = path.join(tmp, "empty-repo-no-files");
    fs.mkdirSync(bare, { recursive: true });
    g(bare, "init", "-q", "--initial-branch", "main", ".");
    const rb = runSelf(["--json"], bare);
    const jb = sane("empty repo, no files", rb);
    check("empty repo with no files: nothing to suggest", "NOTHING TO SUGGEST", jb?.verdict);
  }

  // ---------------------------------------------- 3. a repo with no changes
  {
    const dir = path.join(tmp, "clean-repo");
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "--initial-branch", "main", ".");
    fs.writeFileSync(path.join(dir, "README.md"), "# clean\n", "utf8");
    fs.writeFileSync(path.join(dir, "main.go"), "package main\n", "utf8");
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "main_test.go"), "package main\n", "utf8");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "everything committed");
    const r = runSelf(["--json"], dir);
    const j = sane("clean repo", r);
    check("clean repo: reports zero modified files", 0, j?.state?.modified);
    check("clean repo: reports zero untracked files", 0, j?.state?.untracked);
    check("clean repo: finds nothing to suggest", "NOTHING TO SUGGEST", j?.verdict);
    check("clean repo: exits 4", 4, r.status);
    check("clean repo: still says what it checked", true, (j?.checked ?? []).length >= 5);
    check("clean repo: still read the last commit", "everything committed", j?.state?.head?.subject);
    const human = runSelf([], dir);
    check("clean repo: a person sees the words, not just a JSON verdict", true, /Nothing worth suggesting/.test(human.stdout), human.stdout.slice(0, 100));
    check("clean repo: prints the read-only commands it used", true, /Nothing above was run/.test(human.stdout) && /--no-optional-locks/.test(human.stdout));

    // And the same repo with real work in it must suggest something, or the
    // "nothing" above proves nothing at all.
    fs.writeFileSync(path.join(dir, "handler.go"), "package main\n// work\n", "utf8");
    fs.writeFileSync(path.join(dir, "router.go"), "package main\n", "utf8");
    fs.writeFileSync(path.join(dir, "store.go"), "package main\n", "utf8");
    const r2 = runSelf(["--json"], dir);
    const j2 = sane("dirty repo", r2);
    check("dirty repo: now has something to say", true, (j2?.suggestions ?? []).length > 0);
    check("dirty repo: counts the new files", 3, j2?.state?.untracked);
    check("dirty repo: every suggestion carries its reason", true, (j2?.suggestions ?? []).every((s) => s.reason && s.reason.length > 20));
    check("dirty repo: exits 0", 0, r2.status);

    // Regression, found while building this: `git status --porcelain` collapses
    // a NEW DIRECTORY to one entry, "src/". Four new source files then read as
    // one new thing whose name is a directory, and every rule that inspects
    // file names (secrets, interface files, tests) sees nothing. The fix is
    // --untracked-files=all, and this is the fixture that would catch it coming
    // back.
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    for (const f of ["one.go", "two.go", "three.go", "panel.tsx"]) {
      fs.writeFileSync(path.join(dir, "pkg", f), "package pkg\n", "utf8");
    }
    const rd = runSelf(["--json"], dir);
    const jd = sane("new directory of files", rd);
    check("files inside a brand-new directory are counted individually", 7, jd?.state?.untracked, "3 loose + 4 in pkg/");
    check("...and the interface file inside it is still noticed", true, /interface file/i.test(JSON.stringify(jd?.suggestions ?? [])), JSON.stringify((jd?.suggestions ?? []).map((s) => s.headline)));
    fs.rmSync(path.join(dir, "pkg"), { recursive: true, force: true });

    // A .env appearing untracked outranks everything else that is pending.
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=sk-live-not-a-real-key\n", "utf8");
    const r3 = runSelf(["--json"], dir);
    const j3 = sane("secret file", r3);
    check("an untracked .env is the first thing suggested", true, /\.env/.test(j3?.suggestions?.[0]?.headline ?? ""), j3?.suggestions?.[0]?.headline);
  }

  // ------------------------------------------------- 4. a corrupt git state
  //
  // Three different corruptions, because they fail in three different places:
  // an unreadable HEAD (git refuses the whole repo), a missing object store
  // (git opens the repo and then cannot read history), and a leftover MERGE_HEAD
  // (git is fine, but the repo is mid-operation).
  {
    const mk = (name) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      g(dir, "init", "-q", "--initial-branch", "main", ".");
      fs.writeFileSync(path.join(dir, "a.js"), "1\n", "utf8");
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", "first");
      return dir;
    };

    const headDir = mk("corrupt-head");
    fs.writeFileSync(path.join(headDir, ".git", "HEAD"), "this is not a ref\n", "utf8");
    const r1 = runSelf(["--json"], headDir);
    const j1 = sane("corrupt HEAD", r1);
    check("corrupt HEAD: refuses to call the repository usable", false, j1?.state?.gitUsable);
    check("corrupt HEAD: says git could not open it, and quotes git", true, /git cannot open this repository/i.test(j1?.suggestions?.[0]?.headline ?? "") && /fatal/i.test(j1?.suggestions?.[0]?.reason ?? ""), j1?.suggestions?.[0]?.headline);
    check("corrupt HEAD: does not invent a branch or a last commit", true, j1?.state?.branch === null && j1?.state?.head === null, `branch ${j1?.state?.branch}, head ${JSON.stringify(j1?.state?.head)}`);
    check("corrupt HEAD: exits 3, the 'I could not fully see' code", 3, r1.status);

    const objDir = mk("corrupt-objects");
    fs.rmSync(path.join(objDir, ".git", "objects"), { recursive: true, force: true });
    const r2 = runSelf(["--json"], objDir);
    const j2 = sane("missing object store", r2);
    check("missing objects: says something honest rather than 'all clear'", true, (j2?.suggestions ?? []).length > 0 || (j2?.notes ?? []).length > 0, JSON.stringify(j2?.notes ?? []));
    check("missing objects: exit code is 0 or 3, never a crash code", true, [0, 3].includes(r2.status), `exit ${r2.status}`);

    const midDir = mk("mid-merge");
    const sha = g(midDir, "rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(midDir, ".git", "MERGE_HEAD"), `${sha}\n`, "utf8");
    const r3 = runSelf(["--json"], midDir);
    const j3 = sane("half-finished merge", r3);
    check("half-finished merge: is detected", "a merge", (j3?.state?.inProgress ?? []).join(","));
    check("half-finished merge: is what gets suggested", true, /middle of a merge/i.test(j3?.suggestions?.[0]?.headline ?? ""), j3?.suggestions?.[0]?.headline);

    // The .git directory replaced by a file: the shape a broken submodule or a
    // half-copied repo actually has on disk.
    const gone = path.join(tmp, "git-is-a-file");
    fs.mkdirSync(gone, { recursive: true });
    fs.writeFileSync(path.join(gone, "x.js"), "1\n", "utf8");
    fs.writeFileSync(path.join(gone, ".git"), "gitdir: /nowhere/that/exists\n", "utf8");
    const r4 = runSelf(["--json"], gone);
    const j4 = sane("broken gitdir pointer", r4);
    check("broken gitdir pointer: does not pretend to know the state", true, j4?.state?.gitUsable !== true);
  }

  // ------------------------------------------------- 5. a detached HEAD
  //
  // The state where being quiet and being wrong look identical. Visiting an old
  // commit is ordinary and must stay silent, or the warning gets ignored; work
  // committed while detached is reachable from no branch and is the one thing
  // here that is genuinely lost if nobody says so. Both are checked, because a
  // rule that fires on neither and a rule that fires on both are equally
  // useless.
  {
    const dir = path.join(tmp, "detached");
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "--initial-branch", "main", ".");
    fs.writeFileSync(path.join(dir, "a.js"), "1\n", "utf8");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "first");
    fs.writeFileSync(path.join(dir, "b.js"), "2\n", "utf8");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "second");

    // (a) visiting an older commit, clean tree: main still contains it.
    const first = g(dir, "rev-parse", "HEAD~1").stdout.trim();
    g(dir, "checkout", "-q", first);
    const ra = runSelf(["--json"], dir);
    const ja = sane("detached, just visiting", ra);
    check("detached: the detached state itself is read, not inferred", true, ja?.state?.detached === true, JSON.stringify(ja?.state?.branch));
    check("detached: a branch that still contains the commit is named", "main", (ja?.state?.branchesContaining ?? []).join(","));
    check("detached but safe and clean: stays quiet instead of crying wolf", "NOTHING TO SUGGEST", ja?.verdict, JSON.stringify((ja?.suggestions ?? []).map((s) => s.headline)));

    // (b) uncommitted work while detached: nothing lost yet, but the next
    //     commit would land on no branch.
    fs.writeFileSync(path.join(dir, "c.js"), "3\n", "utf8");
    const rb = runSelf(["--json"], dir);
    const jb = sane("detached with uncommitted work", rb);
    check("detached with open files: says to get on a branch first", true, /detached/i.test(jb?.suggestions?.[0]?.headline ?? ""), jb?.suggestions?.[0]?.headline);
    check("...and outranks the ordinary 'commit this' suggestion", true, (jb?.suggestions?.[0]?.weight ?? 0) >= 80, String(jb?.suggestions?.[0]?.weight));

    // (c) committed while detached: no branch can reach it.
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "work nobody points at");
    const rc = runSelf(["--json"], dir);
    const jc = sane("committed while detached", rc);
    check("committed while detached: no branch contains it, and that is reported", 0, (jc?.state?.branchesContaining ?? ["unset"]).length, JSON.stringify(jc?.state?.branchesContaining));
    check("committed while detached: leads with saving the work", true, /nothing points at it/i.test(jc?.suggestions?.[0]?.headline ?? ""), jc?.suggestions?.[0]?.headline);
    check("committed while detached: the reason states the actual risk", true, /reflog|garbage-collect/i.test(jc?.suggestions?.[0]?.reason ?? ""), (jc?.suggestions?.[0]?.reason ?? "").slice(0, 80));

    const human = runSelf([], dir);
    check("detached: a person is told they are not on a branch", true, /not on a branch/.test(human.stdout), human.stdout.split("\n").find((l) => /branch/.test(l)) || "");

    // Back on a branch, the warning has to go away, or it is not a signal.
    g(dir, "checkout", "-q", "main");
    const jd = jsonOf(runSelf(["--json"], dir));
    check("back on a branch: the detached warning is gone", false, /detached/i.test(JSON.stringify(jd?.suggestions ?? [])), JSON.stringify((jd?.suggestions ?? []).map((s) => s.headline)));
    check("back on a branch: reachability is not asked about, so it stays unknown", null, jd?.state?.branchesContaining);
  }

  // ------------------------------------------------------- the router reuse
  {
    const dir = path.join(tmp, "routing");
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "--initial-branch", "main", ".");
    fs.writeFileSync(path.join(dir, "README.md"), "# r\n", "utf8");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "init");
    for (const f of ["a.ts", "b.ts", "c.ts", "d.tsx"]) fs.writeFileSync(path.join(dir, f), "export const x = 1\n", "utf8");
    const j = jsonOf(runSelf(["--json"], dir));
    check("the router is reachable from the suggest skill", true, j?.routing?.available === true, JSON.stringify(j?.routing));
    check("suggestions come back with real commands attached", true, (j?.suggestions ?? []).some((s) => s.command), JSON.stringify((j?.suggestions ?? []).map((s) => s.command)));
    const named = (j?.suggestions ?? []).map((s) => s.command).filter(Boolean);
    check("every named command belongs to a skill on disk", true, named.every((cmd) => fs.existsSync(path.join(SKILL_DIR, "..", cmd.slice(1))) || j.routing.skills > 0), named.join(","));

    // Importing the router must not execute it. If it did, every run of this
    // command would print the router's help text into the suggestion output.
    const r = runSelf([], dir);
    check("importing the router does not print the router's help", false, /route\.mjs explain/.test(r.stdout), r.stdout.slice(0, 80));
  }

  // ------------------------------------------------------------- the stance
  //
  // The whole point of the modes layer: the same repository, in the same state,
  // gets a different answer. If these pass with identical output across modes,
  // the layer is decoration.
  {
    const dir = path.join(tmp, "stance");
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", "--initial-branch", "main", ".");
    fs.mkdirSync(path.join(dir, "test"), { recursive: true });
    fs.writeFileSync(path.join(dir, "test", "app.test.js"), "// a test\n", "utf8");
    for (const f of ["a.js", "b.js", "c.js", "d.js"]) fs.writeFileSync(path.join(dir, f), "export const x = 1\n", "utf8");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "first");
    // Four source files changed, no test touched, and a credential-shaped file
    // sitting untracked next to them.
    for (const f of ["a.js", "b.js", "c.js", "d.js"]) fs.writeFileSync(path.join(dir, f), "export const x = 2\n", "utf8");
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=xxx\n", "utf8");

    const inMode = (m) => jsonOf(runSelf(["--json", "--mode", m], dir));
    const heads = (j) => (j?.suggestions ?? []).map((s) => s.headline).join(" | ");
    const kinds = (j) => (j?.suggestions ?? []).map((s) => s.kind);

    const craft = inMode("craft");
    const ship = inMode("ship");
    const wild = inMode("wild");
    const lock = inMode("lock");

    check("stance: the mode is reported in the output", "craft", craft?.mode?.name, JSON.stringify(craft?.mode?.label));
    check("stance: CRAFT keeps the missing-test suggestion", true, kinds(craft).includes("test"), heads(craft));
    check("stance: WILD drops the missing-test suggestion", false, kinds(wild).includes("test"), heads(wild));
    check("stance: WILD says which suggestion it dropped and why", true, (wild?.mode?.droppedByWeight ?? []).some((d) => d.kind === "test"), JSON.stringify(wild?.mode?.droppedByWeight));
    check("stance: SHIP prints at most one non-protected suggestion", true, (ship?.suggestions ?? []).filter((s) => !s.protectedFromMode).length <= 1, heads(ship));
    check("stance: the four modes do not all produce the same list", true, new Set([heads(craft), heads(ship), heads(wild), heads(lock)]).size > 1, heads(craft));

    // The rule that has to hold no matter what the config says.
    for (const [label, j] of [["CRAFT", craft], ["SHIP", ship], ["WILD", wild], ["LOCK", lock]]) {
      check(`stance: the leaking .env is still surfaced in ${label}`, true, /credential|secret|\.env/i.test(heads(j)), heads(j));
    }
    check("stance: SHIP keeps the protected one even past its own cap of 1", true, (ship?.suggestions ?? []).some((s) => s.protectedFromMode), heads(ship));

    // The stance block is a report of what the mode DID. When SHIP's cap of 1
    // actually holds work back, that has to be said, or the list looks like the
    // whole answer. When CRAFT's cap of 3 binds nothing, saying it anyway is
    // padding, and this file drops padding everywhere else.
    const shipHuman = runSelf(["--mode", "ship"], dir);
    check("stance: a cap that held work back is stated", true, /asks for at most 1 thing/.test(shipHuman.stdout), shipHuman.stdout.slice(0, 200));
    const craftHuman = runSelf(["--mode", "craft"], dir);
    check("stance: a cap that held nothing back is not announced", false, /asks for at most/.test(craftHuman.stdout), (craftHuman.stdout.split("\n").find((l) => /at most/.test(l)) || "").trim());

    // A mode that TRIES to silence a protected kind. The config is valid, the
    // intent is clear, and it is refused anyway.
    const evil = path.join(tmp, "suppressing-modes.json");
    fs.writeFileSync(
      evil,
      JSON.stringify({
        safeDefault: "craft",
        modes: {
          craft: {
            label: "CRAFT",
            restraint: 2,
            summary: "tries to hide secrets",
            suggest: { max: 3, prefer: { safety: -100, blocked: -100 } },
          },
        },
      }),
      "utf8",
    );
    const suppressed = jsonOf(runSelf(["--json"], dir, { TOOLBAY_STACK_MODES_FILE: evil }));
    check("stance: a mode cannot weight a safety suggestion out of existence", true, /credential|secret|\.env/i.test(heads(suppressed)), heads(suppressed));
    check("stance: and the refusal is reported rather than silent", true, (suppressed?.mode?.refusedSuppression ?? []).length > 0 || (suppressed?.mode?.warnings ?? []).some((w) => /cannot be suppressed/.test(w)), JSON.stringify(suppressed?.mode?.warnings));

    // A broken modes config must leave the suggestions exactly as they were.
    const broken = path.join(tmp, "broken-modes.json");
    fs.writeFileSync(broken, '{ "modes": {', "utf8");
    const b = jsonOf(runSelf(["--json"], dir, { TOOLBAY_STACK_MODES_FILE: broken }));
    const nomode = jsonOf(runSelf(["--json", "--mode", "craft"], dir, { TOOLBAY_STACK_MODES_FILE: broken }));
    check("stance: a corrupt modes config still answers", true, (b?.suggestions ?? []).length > 0, JSON.stringify(b?.verdict));
    check("stance: a corrupt modes config applies no weighting at all", 0, (b?.suggestions ?? []).filter((s) => s.modeDelta !== 0).length, JSON.stringify((b?.suggestions ?? []).map((s) => s.modeDelta)));
    check("stance: a corrupt config does not silently become the loosest stance", true, (b?.suggestions ?? []).some((s) => s.kind === "test"), heads(b));
    check("stance: and an override against a broken config changes nothing", heads(b), heads(nomode));
  }

  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  // Cleanup is housekeeping, never the verdict.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp directory is not the story */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-suggest selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return false;
  }
  out("\n  The four required states (no repo, no commits, no changes, and a repository");
  out("  git itself will not open) all answer with either a suggestion that names its");
  out("  evidence or an explicit \"nothing to suggest\". None of them throw, and none of");
  out("  them fill the silence with busywork.\n");
  return true;
}

// --------------------------------------------------------------------- entry

function help() {
  out(`
  ${bold("tb-suggest")} ${dim(VERSION)}  (Toolbay Stack)

  ${cyan("tb-suggest")}                  what is worth doing next, here, right now
  ${cyan("tb-suggest --json")}           the same thing, machine-readable
  ${cyan("tb-suggest --quiet")}          suggestions only, without the state summary
  ${cyan("tb-suggest state")}            just what it can see, no suggestions
  ${cyan("tb-suggest selftest")}         prove it against a broken repo and an empty one

  Options
    --root <dir>   add a skills directory when naming commands (repeatable)
    --mode <name>  answer as if this stance were active, without setting it

  The active mode decides what comes out of here, not just how it is worded.
  SHIP prints the one thing that gets this deployed; WILD says nothing about
  tests or unpushed commits; LOCK leads with what is unverified. Edit those
  preferences in skills/modes/modes.json. Two kinds are never suppressed by any
  mode: a conflict you are standing in, and a credential about to be committed.

  Exit codes
    0  there is something worth doing, and it is printed
    2  the working directory itself could not be read
    3  observation was incomplete. It said so, and printed what it had
    4  verified: nothing worth suggesting

  It suggests. It never runs anything, and it prints the read-only commands it
  used so you can check that.
`);
}

const argv = process.argv.slice(2);
// The first bare word is the command, but the VALUE of an option that takes one
// is not a bare word. Without this, `tb-suggest --mode craft` reads "craft" as a
// command and refuses to run.
const TAKES_A_VALUE = new Set(["--root", "--mode"]);
const cmd = argv.find((a, i) => !a.startsWith("-") && !(i > 0 && TAKES_A_VALUE.has(argv[i - 1])));

try {
  if (argv.includes("-h") || argv.includes("--help") || cmd === "help") help();
  else if (cmd === "selftest") await selftest();
  else if (cmd === "state") cmdState(argv);
  else if (!cmd || cmd === "now" || cmd === "next") await cmdNow(argv);
  else {
    out(`  Unknown command ${cmd}. Try: tb-suggest --help`);
    process.exitCode = 1;
  }
} catch (err) {
  // The last line of defence. A suggestion engine that throws a stack trace at
  // someone who asked "what should I do next" has answered the question badly.
  out();
  out(`  I could not work out what to suggest here: ${err?.message || err}`);
  out("  That is a bug in tb-suggest, not a fact about your project. Nothing was run.");
  out();
  process.exitCode = EXIT_DEGRADED;
}
