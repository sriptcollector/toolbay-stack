#!/usr/bin/env node
/**
 * tb-retro.mjs: the engine behind /retro.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow implemented here (the `/retro` command, the weekly
 * window with `compare` and `global` modes, the metric set — commits, LOC, test
 * LOC ratio, active days, sessions detected on a 45-minute commit gap, commit
 * type mix, hotspot analysis, focus score, shipping streak, per-author
 * leaderboard with praise and one growth area, the tweetable one-liner, the
 * saved JSON snapshot and the trend table against the previous snapshot) comes
 * from `retro` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT PROSE
 * ---------------------------------------------------------------------------
 *
 * gstack's /retro is a 92KB markdown file that hands the agent twelve shell
 * pipelines and asks it to do the arithmetic in its head. The output is a
 * narrative, and a narrative cannot be checked. Worse, four of those pipelines
 * fail on this machine, and every one of them fails in the direction that reads
 * as a normal week. Measured on Windows 11, Git Bash (GNU bash 5.2), git
 * 2.53.0.windows.3, gstack retro v2.0.0, 2026-08-14. Every reproduction below
 * is verbatim output. Re-run them yourself: `node tb-retro.mjs gstack-repro`.
 *
 * 1. THE STALE-WINDOW GUARD NEVER FIRES ON A REPO WITH NO REMOTE.
 *    SKILL.md:935 is the first line of the pre-flight guard:
 *
 *        _RETRO_HAS_REMOTE=$(git remote 2>/dev/null | grep -c '^origin$' || echo 0)
 *        if [ "$_RETRO_HAS_REMOTE" = "0" ]; then ... skip ... fi
 *
 *    `grep -c` prints `0` AND exits 1 when nothing matches, so `|| echo 0` runs
 *    too and the variable holds two lines:
 *
 *      $ git init -q norepo && cd norepo
 *      $ _RETRO_HAS_REMOTE=$(git remote 2>/dev/null | grep -c '^origin$' || echo 0)
 *      $ printf 'value=[%s]\n' "$_RETRO_HAS_REMOTE"
 *      value=[0
 *      0]
 *      GUARD DID NOT FIRE -> proceeds to git fetch origin on a repo with no origin
 *
 *    The one branch that exists to say "there is no origin, do not trust the
 *    window" is unreachable. The skill then runs `git fetch origin <default>`
 *    and `git log origin/<default>` against a ref that cannot exist.
 *
 * 2. AND WHEN THAT REF DOES NOT EXIST, THE ERROR IS SWALLOWED AS "A QUIET WEEK".
 *    SKILL.md:1011 is data command 4:
 *
 *      $ git log origin/main --since="7 days ago" --format="" --name-only \
 *          | grep -v '^$' | sort | uniq -c | sort -rn
 *      fatal: ambiguous argument 'origin/main': unknown revision or path not in
 *      the working tree.
 *      pipeline exit=0
 *
 *    `fatal:` goes to stderr, the pipeline exits 0 because `sort` succeeded, and
 *    the agent is handed an empty result set for every one of the twelve
 *    queries. Nothing in the skill distinguishes "this ref is wrong" from "you
 *    shipped nothing", and gstack's own Step 0.5 admits what happens next: the
 *    retro "will fabricate a coherent-looking narrative from nothing".
 *
 * 3. THE RECORD SEPARATOR IS `|`, AND COMMIT SUBJECTS CONTAIN `|`.
 *    SKILL.md:1000 is data command 1: `--format="%H|%aN|%ae|%ai|%s"`.
 *
 *      $ git commit -m 'fix: handle a|b splitting in parser'
 *      $ git log -1 --format="%H|%aN|%ae|%ai|%s" | awk -F'|' '{print "NF="NF; print $5}'
 *      NF=6
 *      fix: handle a
 *
 *    Five fields were promised, six arrived, and the subject is truncated at the
 *    pipe. Commit type classification, "ship of the week" and the PR-title
 *    features all read that field. Here the record separator is NUL and the
 *    field separator is US (0x1F), neither of which can occur in git output.
 *
 * 4. FOUR OF THE SHELL SNIPPETS ARE zsh. SKILL.md:1269, :1296, :1420, :1722 and
 *    :1740 all open with `setopt +o nomatch 2>/dev/null || true`. In bash:
 *
 *      $ setopt +o nomatch
 *      bash: setopt: command not found      (rc=127)
 *
 *    Silenced by `|| true`, so the glob guard those lines exist to install is
 *    simply absent, and the `ls .context/retros/*.json` that follows passes its
 *    own unexpanded glob to `ls`. The preamble adds `$PPID`, `find -mmin`,
 *    `date +%s`, `source <(...)` and `open`; global mode writes to `/tmp` and
 *    shells out to a `bun`-compiled discovery binary. Nothing in this file goes
 *    through a shell at all: every git call is an argv array spawned directly,
 *    which is also why a repo under `C:\Users\orion\OneDrive\Desktop\...` with a
 *    space in the path is not a special case here.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THIS FILE FOLLOWS
 * ---------------------------------------------------------------------------
 *
 *   EVERY NUMBER IS COMPUTED, NOT ESTIMATED. The agent's job is the narrative.
 *   The counts, the LOC, the ratios, the sessions and the streak come out of
 *   this file, and `--json` carries the argv and exit code of every git command
 *   that produced them, so any figure in the retro can be re-derived by hand.
 *
 *   FAIL CLOSED. A ref that does not resolve, a git that is not installed, a
 *   commit dated in the future, a repo that cannot be read: each is UNVERIFIED
 *   with a named reason and a non-zero exit, never an empty section. A window
 *   with no commits is NO_DATA and exits 4 — it never renders as a retro.
 *
 *   PROVE IT. `selftest` builds real git repositories that are broken on
 *   purpose — no remote, no origin/main, a `|` and a quote in the subject, a
 *   binary file in the diff, one human under two emails, a directory name with
 *   a space, a commit dated in the future, a window with nothing in it — and
 *   asserts the closed answer for each. It exits non-zero if any assertion
 *   fails, including the assertion that all of them ran.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

/** 45 minutes, gstack's session-gap threshold, kept so numbers stay comparable. */
const SESSION_GAP_MS = 45 * 60 * 1000;
/** A commit authored more than this far ahead of the clock means one of them lies. */
const FUTURE_TOLERANCE_MS = 26 * 60 * 60 * 1000;
const STREAK_LOOKBACK_DAYS = 400;

// ------------------------------------------------------------------ provenance

/** Every git invocation, in order, with its real exit status. Emitted by --json. */
let COMMANDS = [];
function resetCommands() {
  COMMANDS = [];
}

function git(repo, args, opts = {}) {
  const argv = ["-C", repo, "--no-pager", ...args];
  const t0 = Date.now();
  const res = spawnSync("git", argv, {
    encoding: "utf8",
    timeout: opts.timeout ?? 90000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ...(opts.env || {}),
    },
  });
  const err = res.error ? String(res.error.message) : null;
  const rec = {
    argv: ["git", ...argv],
    exit: res.status === null || res.status === undefined ? -1 : res.status,
    ms: Date.now() - t0,
    error: err,
  };
  COMMANDS.push(rec);
  return {
    ok: !err && res.status === 0,
    status: rec.exit,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: err,
  };
}

function gitVersion() {
  const res = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || "").trim();
}

// ------------------------------------------------------------------ time/window

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local ISO-8601 WITH offset. git parses this unambiguously; a bare date does not. */
function localISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
  );
}

function localDay(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * gstack's window semantics, kept exactly: `7d` means local midnight seven days
 * back, not "168 hours ago". Difference is that the resolved absolute range is
 * printed, so a wrong window is visible instead of inferred.
 */
function parseWindow(spec, now) {
  const s = String(spec || "7d").trim().toLowerCase();
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) return { error: `bad window "${spec}" — use N followed by h, d or w (7d, 24h, 2w)` };
  const n = Number(m[1]);
  if (n <= 0) return { error: `bad window "${spec}" — must be greater than zero` };
  const unit = m[2];
  if (unit === "h") {
    const start = new Date(now.getTime() - n * 3600 * 1000);
    return { label: s, unit, n, days: n / 24, start, end: now, midnightAligned: false };
  }
  const days = unit === "w" ? n * 7 : n;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
  return { label: s, unit, n, days, start, end: now, midnightAligned: true };
}

// ------------------------------------------------------------------ classifiers

const TEST_PATH_RE =
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress)\/|(\.|_|-)(test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$/i;

function isTestPath(p) {
  return TEST_PATH_RE.test(p);
}

const BOT_EMAIL_RE = /noreply@anthropic\.com$|noreply@openai\.com$|@users\.noreply\.github\.com$/i;
const BOT_NAME_RE = /\[bot\]$|^dependabot|^github-actions|^renovate/i;
const AI_TRAILER_RE = /co-authored-by:[^\n]*(anthropic|claude|copilot|openai|codex|gemini)/i;
const AI_FOOTER_RE = /generated with \[?(claude|codex|copilot)/i;

function isBotIdentity(name, email) {
  // A @users.noreply.github.com address is a HUMAN hiding their email, so it is
  // only a bot when the name says so. Getting this backwards deletes people.
  if (BOT_NAME_RE.test(name)) return true;
  return /noreply@anthropic\.com$|noreply@openai\.com$/i.test(email);
}

function commitType(subject) {
  if (/^merge\b/i.test(subject)) return "merge";
  if (/^revert\b/i.test(subject)) return "revert";
  const m = /^([a-z]+)(\([^)]*\))?!?:\s/i.exec(subject);
  return m ? m[1].toLowerCase() : "other";
}

function normalizeName(n) {
  return String(n).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** numstat renames: `src/{a => b}.js` and `old => new` both name the NEW path. */
function normalizePath(raw) {
  let p = raw;
  const brace = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(p);
  if (brace) p = `${brace[1]}${brace[3]}${brace[4]}`;
  else if (p.includes(" => ")) p = p.slice(p.indexOf(" => ") + 4);
  return p.replace(/\/{2,}/g, "/");
}

function topDir(p) {
  const i = p.indexOf("/");
  return i === -1 ? "(root)" : p.slice(0, i) + "/";
}

// ------------------------------------------------------------------ ref resolve

/**
 * Resolve the ref to report on, and REFUSE to return one that does not exist.
 * gstack substitutes `<default>` into `git log origin/<default>` and lets the
 * fatal land on stderr where a pipeline eats it (reproduction 2 in the header).
 */
function resolveRef(repo) {
  const tried = [];
  const verify = (ref, how) => {
    const r = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    tried.push({ ref, how, ok: r.ok });
    return r.ok;
  };

  const sym = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.ok) {
    const short = sym.stdout.trim().replace(/^refs\/remotes\//, "");
    if (short && verify(short, "refs/remotes/origin/HEAD")) {
      return { ref: short, how: "refs/remotes/origin/HEAD", fallback: false, tried };
    }
  } else {
    tried.push({ ref: "refs/remotes/origin/HEAD", how: "symbolic-ref", ok: false });
  }

  for (const cand of ["origin/main", "origin/master"]) {
    if (verify(cand, "well-known remote branch")) {
      return { ref: cand, how: "well-known remote branch", fallback: false, tried };
    }
  }

  const cur = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const curName = cur.ok ? cur.stdout.trim() : "";
  if (curName && curName !== "HEAD" && verify(curName, "current local branch")) {
    return {
      ref: curName,
      how: "current local branch",
      fallback: true,
      reason: "no origin/HEAD, origin/main or origin/master resolves in this repo",
      tried,
    };
  }

  if (verify("HEAD", "detached HEAD")) {
    return {
      ref: "HEAD",
      how: "detached HEAD",
      fallback: true,
      reason: "no named branch resolves; reporting on HEAD",
      tried,
    };
  }

  return { ref: null, how: null, fallback: true, reason: "no ref in this repository resolves to a commit (empty repo?)", tried };
}

// ------------------------------------------------------------------ collection

const US = "\u001f";

function collectCommits(repo, ref, win) {
  const since = `--since=${localISO(win.start)}`;
  const until = `--until=${localISO(win.end)}`;

  const meta = git(repo, [
    "log",
    ref,
    since,
    until,
    "-z",
    `--format=%H${US}%aN${US}%aE${US}%aI${US}%cI${US}%P${US}%s${US}%B`,
  ]);
  if (!meta.ok) {
    return { error: `git log (metadata) exited ${meta.status}: ${(meta.stderr || meta.error || "").trim().split("\n")[0]}` };
  }

  const commits = [];
  const byHash = new Map();
  for (const rec of meta.stdout.split("\0")) {
    if (!rec.trim()) continue;
    const f = rec.split(US);
    if (f.length < 7) continue;
    const [hash, name, email, aISO, cISO, parents, subject] = f;
    const body = f.slice(7).join(US);
    const c = {
      hash,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      authoredISO: aISO,
      authoredMs: Date.parse(aISO),
      committedMs: Date.parse(cISO),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      subject,
      type: commitType(subject),
      aiAssisted: AI_TRAILER_RE.test(body) || AI_FOOTER_RE.test(body),
      insertions: 0,
      deletions: 0,
      testInsertions: 0,
      testDeletions: 0,
      binaryFiles: 0,
      files: [],
    };
    c.merge = c.parents.length > 1;
    commits.push(c);
    byHash.set(hash, c);
  }

  // Second pass for the diffstat. `--numstat` reports binary files as `-`, which
  // is why binary counts are tracked separately instead of coerced to a number.
  const stat = git(repo, ["log", ref, since, until, "--format=%x01%H", "--numstat"]);
  if (!stat.ok) {
    return { error: `git log (numstat) exited ${stat.status}: ${(stat.stderr || stat.error || "").trim().split("\n")[0]}` };
  }
  let cur = null;
  for (const line of stat.stdout.split("\n")) {
    if (line.startsWith("\u0001")) {
      cur = byHash.get(line.slice(1).trim()) || null;
      continue;
    }
    if (!cur || !line.trim()) continue;
    const m = /^(\S+)\t(\S+)\t(.*)$/.exec(line);
    if (!m) continue;
    const p = normalizePath(m[3]);
    const binary = m[1] === "-" || m[2] === "-";
    const add = binary ? 0 : Number(m[1]);
    const del = binary ? 0 : Number(m[2]);
    if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
    cur.files.push({ path: p, add, del, binary, test: isTestPath(p) });
    if (binary) cur.binaryFiles += 1;
    cur.insertions += add;
    cur.deletions += del;
    if (isTestPath(p)) {
      cur.testInsertions += add;
      cur.testDeletions += del;
    }
  }

  return { commits };
}

function collectTags(repo, win) {
  const r = git(repo, [
    "tag",
    "--list",
    `--format=%(creatordate:iso8601-strict)${US}%(refname:short)${US}%(objecttype)`,
  ]);
  if (!r.ok) return { tags: [], error: `git tag exited ${r.status}` };
  const tags = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [d, name, kind] = line.split(US);
    const ms = Date.parse(d);
    if (!Number.isFinite(ms)) continue;
    if (ms >= win.start.getTime() && ms <= win.end.getTime()) {
      tags.push({ name, date: d, kind, ms });
    }
  }
  tags.sort((a, b) => a.ms - b.ms);
  return { tags };
}

function collectStreak(repo, ref, now) {
  const r = git(repo, [
    "log",
    ref,
    `--since=${STREAK_LOOKBACK_DAYS} days ago`,
    "--format=%ad",
    "--date=format:%Y-%m-%d",
  ]);
  if (!r.ok) return { days: 0, error: `git log (streak) exited ${r.status}` };
  const set = new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  if (!set.size) return { days: 0, anchor: null, throughToday: false, lookbackDays: STREAK_LOOKBACK_DAYS };

  const dates = [...set].sort().reverse();
  const anchor = dates[0];
  let days = 1;
  let cursor = new Date(`${anchor}T00:00:00`);
  for (;;) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
    if (set.has(localDay(cursor))) days += 1;
    else break;
  }
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return {
    days,
    anchor,
    // gstack counts back from TODAY, so running the retro before the day's first
    // commit reports a 32-day streak as 0. The streak is anchored at the last
    // commit day instead, and whether it reaches today is stated rather than
    // silently folded into the number.
    throughToday: anchor === today,
    live: anchor === today || anchor === yesterday,
    lookbackDays: STREAK_LOOKBACK_DAYS,
    capped: days >= STREAK_LOOKBACK_DAYS,
  };
}

function newestCommit(repo, ref) {
  const r = git(repo, ["log", ref, "-1", "--format=%aI"]);
  if (!r.ok || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

// ------------------------------------------------------------------ aggregation

function buildIdentities(commits) {
  const byEmail = new Map();
  for (const c of commits) {
    const key = c.email || `name:${normalizeName(c.name)}`;
    if (!byEmail.has(key)) byEmail.set(key, { emails: new Set(), names: new Set(), commits: [] });
    const e = byEmail.get(key);
    e.emails.add(c.email);
    e.names.add(c.name);
    e.commits.push(c);
  }

  // Merge by normalized name across emails. gstack keys authors on %aN alone, so
  // it merges these too; the difference is that the merge is DISCLOSED here, and
  // the reverse case (one email, two spellings of the name) is also merged
  // instead of being reported as two contributors.
  const groups = new Map();
  for (const [key, e] of byEmail) {
    const nk = normalizeName([...e.names][0] || key);
    if (!groups.has(nk)) groups.set(nk, []);
    groups.get(nk).push([key, e]);
  }

  const identities = [];
  for (const [, members] of groups) {
    const emails = new Set();
    const names = new Set();
    const cs = [];
    for (const [, e] of members) {
      for (const x of e.emails) emails.add(x);
      for (const x of e.names) names.add(x);
      cs.push(...e.commits);
    }
    const primaryName = [...names].sort((a, b) => b.length - a.length)[0];
    const primaryEmail = [...emails].sort()[0];
    identities.push({
      name: primaryName,
      email: primaryEmail,
      aliases: [...emails].filter((x) => x !== primaryEmail),
      nameVariants: [...names],
      bot: isBotIdentity(primaryName, primaryEmail),
      commits: cs,
    });
  }
  identities.sort((a, b) => b.commits.length - a.commits.length);
  return identities;
}

function sessionsOf(commits) {
  const ts = commits.map((c) => c.authoredMs).filter(Number.isFinite).sort((a, b) => a - b);
  const sessions = [];
  let start = null;
  let prev = null;
  let count = 0;
  for (const t of ts) {
    if (start === null) {
      start = t;
      prev = t;
      count = 1;
      continue;
    }
    if (t - prev > SESSION_GAP_MS) {
      sessions.push({ start, end: prev, commits: count, minutes: Math.round((prev - start) / 60000) });
      start = t;
      count = 1;
    } else count += 1;
    prev = t;
  }
  if (start !== null) sessions.push({ start, end: prev, commits: count, minutes: Math.round((prev - start) / 60000) });
  const deep = sessions.filter((s) => s.minutes >= 50).length;
  const micro = sessions.filter((s) => s.minutes < 20).length;
  return {
    count: sessions.length,
    deep,
    medium: sessions.length - deep - micro,
    micro,
    totalMinutes: sessions.reduce((a, s) => a + s.minutes, 0),
    gapRuleMinutes: SESSION_GAP_MS / 60000,
    sessions,
  };
}

function aggregate(commits, now) {
  const totals = {
    commits: commits.length,
    merges: commits.filter((c) => c.merge).length,
    insertions: 0,
    deletions: 0,
    testInsertions: 0,
    testDeletions: 0,
    binaryFiles: 0,
    filesChanged: 0,
    aiAssisted: commits.filter((c) => c.aiAssisted).length,
  };
  const fileCounts = new Map();
  const dirCounts = new Map();
  const types = new Map();
  const hours = new Array(24).fill(0);
  const days = new Set();
  const future = [];

  for (const c of commits) {
    totals.insertions += c.insertions;
    totals.deletions += c.deletions;
    totals.testInsertions += c.testInsertions;
    totals.testDeletions += c.testDeletions;
    totals.binaryFiles += c.binaryFiles;
    types.set(c.type, (types.get(c.type) || 0) + 1);
    for (const f of c.files) {
      fileCounts.set(f.path, (fileCounts.get(f.path) || 0) + 1);
      dirCounts.set(topDir(f.path), (dirCounts.get(topDir(f.path)) || 0) + 1);
    }
    if (Number.isFinite(c.authoredMs)) {
      // The commit's own UTC offset is the author's wall clock. Rendering it in
      // the reader's timezone answers a different question than "when do they work".
      const off = /([+-])(\d{2}):(\d{2})$/.exec(c.authoredISO);
      let local = new Date(c.authoredMs);
      if (off) {
        const mins = (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
        local = new Date(c.authoredMs + (mins + new Date(c.authoredMs).getTimezoneOffset()) * 60000);
      }
      hours[local.getHours()] += 1;
      days.add(localDay(local));
      if (c.authoredMs > now.getTime() + FUTURE_TOLERANCE_MS) future.push(c);
    }
  }
  totals.filesChanged = fileCounts.size;
  totals.netLoc = totals.insertions - totals.deletions;
  totals.testRatio = totals.insertions > 0 ? totals.testInsertions / totals.insertions : null;

  const hotspots = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, n]) => ({ path: p, changes: n }));
  const dirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
  const focus = dirs.length ? { dir: dirs[0][0], pct: dirs[0][1] / [...dirCounts.values()].reduce((a, b) => a + b, 0) } : null;

  // gstack calls this "PRs merged". It is every `#123` in a subject line, which
  // includes issue references and "fixes #12", so it is named for what it is.
  const prRefs = new Set();
  for (const c of commits) for (const m of c.subject.matchAll(/[#!](\d+)/g)) prRefs.add(m[0]);

  return {
    totals,
    types: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ type: t, count: n, pct: n / commits.length })),
    hours,
    activeDays: days.size,
    hotspots,
    focus,
    prRefs: [...prRefs].sort(),
    futureCommits: future.map((c) => ({ hash: c.hash.slice(0, 8), authored: c.authoredISO, subject: c.subject })),
    sessions: sessionsOf(commits),
  };
}

// ------------------------------------------------------------------ per repo

function retroForRepo(repoPath, win, now, opts = {}) {
  const out = {
    repo: path.basename(path.resolve(repoPath)),
    path: path.resolve(repoPath),
    verdict: "OK",
    reasons: [],
    metrics: null,
    window: {
      label: win.label,
      start: localISO(win.start),
      end: localISO(win.end),
      midnightAligned: win.midnightAligned,
    },
  };

  const inside = git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    out.verdict = "UNVERIFIED";
    out.reasons.push(`not a git work tree: ${(inside.stderr || inside.error || "").trim().split("\n")[0] || "git rev-parse said no"}`);
    return out;
  }

  const remotes = git(repoPath, ["remote"]);
  out.remotes = remotes.ok ? remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  out.hasOrigin = out.remotes.includes("origin");
  // Reproduction 1: gstack's `grep -c || echo 0` makes this branch unreachable.
  if (!out.hasOrigin) out.reasons.push("no 'origin' remote — reporting on local refs only, nothing was fetched");

  if (opts.fetch && out.hasOrigin) {
    const f = git(repoPath, ["fetch", "origin", "--quiet"], { timeout: 120000 });
    out.fetched = f.ok;
    if (!f.ok) out.reasons.push(`git fetch origin failed (${f.status}) — window measured against the last known origin refs`);
  } else {
    out.fetched = false;
  }

  const ref = resolveRef(repoPath);
  out.ref = ref.ref;
  out.refHow = ref.how;
  out.refFallback = ref.fallback;
  if (!ref.ref) {
    out.verdict = "UNVERIFIED";
    out.reasons.push(ref.reason);
    return out;
  }
  if (ref.fallback) out.reasons.push(`${ref.reason}; measured ${ref.ref} instead`);

  const newest = newestCommit(repoPath, ref.ref);
  out.newestCommit = newest;
  // Clock sanity BEFORE the window is applied. A future-dated commit outside the
  // window would otherwise be invisible, and it is the single clearest sign that
  // the window arithmetic (which is derived from this machine's clock) is wrong.
  if (newest && Date.parse(newest) > now.getTime() + FUTURE_TOLERANCE_MS) {
    out.verdict = "UNVERIFIED";
    out.clockSkew = true;
    out.reasons.push(
      `newest commit on ${ref.ref} is authored ${newest}, which is in the future relative to this machine's clock (${localISO(now)}) — the clock or the commit dates are wrong, so window arithmetic cannot be trusted`
    );
  }

  const got = collectCommits(repoPath, ref.ref, win);
  if (got.error) {
    out.verdict = "UNVERIFIED";
    out.reasons.push(got.error);
    return out;
  }
  const commits = got.commits;

  if (!commits.length) {
    // UNVERIFIED outranks NO_DATA: "we could not trust the measurement" is not
    // the same claim as "there was nothing to measure".
    if (out.verdict === "OK") out.verdict = "NO_DATA";
    out.metrics = null;
    if (newest && Date.parse(newest) < win.start.getTime()) {
      out.reasons.push(
        `zero commits in the window; newest commit on ${ref.ref} is ${newest}, which is BEFORE the window start ${localISO(win.start)}. Either the window is wrong or this ref is behind.`
      );
    } else {
      out.reasons.push(`zero commits on ${ref.ref} between ${localISO(win.start)} and ${localISO(win.end)}`);
    }
    return out;
  }

  const agg = aggregate(commits, now);
  const identities = buildIdentities(commits);
  const humans = identities.filter((i) => !i.bot);
  const tagInfo = collectTags(repoPath, win);
  const streak = collectStreak(repoPath, ref.ref, now);

  if (agg.futureCommits.length) {
    out.verdict = "UNVERIFIED";
    out.reasons.push(
      `${agg.futureCommits.length} commit(s) authored in the future relative to this machine's clock (newest ${agg.futureCommits[0].authored}) — the clock or the commit dates are wrong, so window arithmetic cannot be trusted`
    );
  }

  const merged = identities.filter((i) => i.aliases.length || i.nameVariants.length > 1);

  out.metrics = {
    ...agg.totals,
    activeDays: agg.activeDays,
    windowDays: Math.max(1, Math.ceil((win.end - win.start) / 86400000)),
    contributors: humans.length,
    botContributors: identities.length - humans.length,
    identitiesMerged: merged.length,
    tags: tagInfo.tags.length,
    tagNames: tagInfo.tags.map((t) => t.name),
    prRefs: agg.prRefs.length,
    sessions: agg.sessions.count,
    deepSessions: agg.sessions.deep,
    mediumSessions: agg.sessions.medium,
    microSessions: agg.sessions.micro,
    activeMinutes: agg.sessions.totalMinutes,
    focusDir: agg.focus?.dir ?? null,
    focusPct: agg.focus?.pct ?? null,
    streakDays: streak.days,
    streakAnchor: streak.anchor,
    streakThroughToday: streak.throughToday,
  };
  out.types = agg.types;
  out.hours = agg.hours;
  out.hotspots = agg.hotspots;
  out.prRefList = agg.prRefs;
  out.tags = tagInfo.tags;
  out.streak = streak;
  out.sessionDetail = agg.sessions;
  out.authors = identities.map((i) => {
    const a = aggregate(i.commits, now);
    return {
      name: i.name,
      email: i.email,
      aliases: i.aliases,
      nameVariants: i.nameVariants,
      bot: i.bot,
      commits: i.commits.length,
      insertions: a.totals.insertions,
      deletions: a.totals.deletions,
      testRatio: a.totals.testRatio,
      aiAssisted: a.totals.aiAssisted,
      topArea: a.focus?.dir ?? null,
      sessions: a.sessions.count,
      types: a.types.slice(0, 5),
      biggest: i.commits
        .slice()
        .sort((x, y) => y.insertions + y.deletions - (x.insertions + x.deletions))
        .slice(0, 1)
        .map((c) => ({ hash: c.hash.slice(0, 8), subject: c.subject, insertions: c.insertions, deletions: c.deletions, files: c.files.length }))[0] ?? null,
    };
  });
  out.commits = opts.includeCommits
    ? commits.map((c) => ({ hash: c.hash.slice(0, 8), name: c.name, email: c.email, authored: c.authoredISO, subject: c.subject, type: c.type, insertions: c.insertions, deletions: c.deletions, merge: c.merge, aiAssisted: c.aiAssisted }))
    : undefined;

  out.tweetable =
    `${win.label}: ${agg.totals.commits} commits` +
    `${humans.length > 1 ? ` (${humans.length} contributors)` : ""}` +
    `, +${agg.totals.insertions}/-${agg.totals.deletions}` +
    `${agg.totals.testRatio !== null ? `, ${Math.round(agg.totals.testRatio * 100)}% tests` : ""}` +
    `${tagInfo.tags.length ? `, ${tagInfo.tags.length} tag${tagInfo.tags.length > 1 ? "s" : ""}` : ""}` +
    ` | streak ${streak.days}d`;

  return out;
}

// ------------------------------------------------------------------ discovery

function findRepos(roots, maxDepth) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", "__pycache__", ".venv", "venv", ".cache"]);
  const found = [];
  const unreadable = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      unreadable.push({ path: dir, reason: String(e.code || e.message) });
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      found.push(path.resolve(dir));
      return; // do not descend into a repo looking for more repos
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(path.resolve(r), 0);
  return { found, unreadable };
}

// ------------------------------------------------------------------ rendering

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function pct(x) {
  return x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`;
}
function bar(n, max, width = 24) {
  if (!max) return "";
  return "#".repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)));
}

function renderRepo(r, w = process.stdout) {
  const p = (s) => w.write(s + "\n");
  p("");
  p(`  tb-retro ${VERSION}   ${r.repo}   ${r.verdict}`);
  p(`  path    ${r.path}`);
  p(`  ref     ${r.ref ?? "(none)"}${r.ref ? `  via ${r.refHow}${r.refFallback ? "  [FALLBACK]" : ""}` : ""}`);
  p(`  window  ${r.window.label}  =  ${r.window.start}  ..  ${r.window.end}${r.window.midnightAligned ? "  (start is local midnight)" : ""}`);
  for (const reason of r.reasons) p(`  NOTE    ${reason}`);

  if (!r.metrics) {
    p("");
    p(`  No metrics. ${r.verdict === "NO_DATA" ? "The window is empty; nothing is being narrated from nothing." : "This repo could not be measured."}`);
    p("");
    return;
  }

  const m = r.metrics;
  p("");
  p("  SHIPPED");
  p(`    commits         ${padL(m.commits, 7)}   merges ${m.merges}, AI co-authored ${m.aiAssisted}`);
  p(`    contributors    ${padL(m.contributors, 7)}   ${m.botContributors ? `bots excluded ${m.botContributors}, ` : ""}identities merged ${m.identitiesMerged}`);
  p(`    files changed   ${padL(m.filesChanged, 7)}   binary ${m.binaryFiles} (excluded from LOC, git reports them as "-")`);
  p(`    lines           ${padL(`+${m.insertions}/-${m.deletions}`, 7)}   net ${m.netLoc >= 0 ? "+" : ""}${m.netLoc}`);
  p(`    test lines      ${padL(`+${m.testInsertions}`, 7)}   ${pct(m.testRatio)} of insertions`);
  p(`    tags in window  ${padL(m.tags, 7)}   ${m.tagNames.join(", ") || "none"}`);
  p(`    #refs in subj   ${padL(m.prRefs, 7)}   PR *and* issue references, not merged PRs`);
  p(`    active days     ${padL(m.activeDays, 7)}   of ${m.windowDays} in window`);
  p(`    sessions        ${padL(m.sessions, 7)}   deep ${m.deepSessions} / medium ${m.mediumSessions} / micro ${m.microSessions}, ${r.sessionDetail.gapRuleMinutes}m gap rule, ${m.activeMinutes}m active`);
  p(`    focus           ${padL(pct(m.focusPct), 7)}   ${m.focusDir ?? "n/a"}`);
  p(`    streak          ${padL(`${m.streakDays}d`, 7)}   through ${m.streakAnchor}${m.streakThroughToday ? " (today)" : " (not today — last commit day anchors it)"}`);

  p("");
  p("  BY AUTHOR");
  const nameW = Math.max(6, ...r.authors.map((a) => a.name.length));
  for (const a of r.authors) {
    p(`    ${pad(a.name, nameW)}  ${padL(a.commits, 4)} commits  ${padL(`+${a.insertions}/-${a.deletions}`, 14)}  tests ${padL(pct(a.testRatio), 4)}  ${a.topArea ?? ""}${a.bot ? "  [bot]" : ""}${a.aliases.length ? `  [+${a.aliases.length} alias]` : ""}`);
    if (a.biggest) p(`    ${" ".repeat(nameW)}  biggest: ${a.biggest.subject.slice(0, 68)} (+${a.biggest.insertions}/-${a.biggest.deletions}, ${a.biggest.files} files)`);
  }

  p("");
  p("  TYPES");
  const tmax = Math.max(...r.types.map((t) => t.count));
  for (const t of r.types) p(`    ${pad(t.type, 10)} ${padL(t.count, 4)}  ${padL(pct(t.pct), 4)}  ${bar(t.count, tmax)}`);

  p("");
  p("  HOURS (author local time)");
  const hmax = Math.max(...r.hours);
  for (let h = 0; h < 24; h += 1) {
    if (!r.hours[h]) continue;
    p(`    ${pad2(h)}:00 ${padL(r.hours[h], 4)}  ${bar(r.hours[h], hmax)}`);
  }

  p("");
  p("  HOTSPOTS");
  for (const h of r.hotspots) p(`    ${padL(h.changes, 4)}x  ${h.path}`);

  p("");
  p(`  TWEETABLE  ${r.tweetable}`);
  p("");
  p(`  PROVENANCE  ${COMMANDS.length} git commands, ${COMMANDS.filter((c) => c.exit !== 0).length} non-zero. --json prints every argv and exit code.`);
  p("");
}

function renderGlobal(g, w = process.stdout) {
  const p = (s) => w.write(s + "\n");
  p("");
  p(`  tb-retro ${VERSION}   ${g.repos.length} repositories   ${g.verdict}`);
  p(`  window  ${g.window.label}  =  ${g.window.start}  ..  ${g.window.end}`);
  p("");
  const nameW = Math.max(4, ...g.repos.map((r) => r.repo.length));
  p(`    ${pad("repo", nameW)}  ${padL("commits", 8)}  ${padL("+/-", 16)}  ${padL("tags", 5)}  ${padL("auth", 5)}  verdict`);
  for (const r of g.repos) {
    const m = r.metrics;
    p(
      `    ${pad(r.repo, nameW)}  ${padL(m ? m.commits : "-", 8)}  ${padL(m ? `+${m.insertions}/-${m.deletions}` : "-", 16)}  ${padL(m ? m.tags : "-", 5)}  ${padL(m ? m.contributors : "-", 5)}  ${r.verdict}`
    );
    for (const reason of r.reasons) p(`    ${" ".repeat(nameW)}  ! ${reason}`);
  }
  p("");
  p("  TOTALS (only repos that produced metrics)");
  p(`    commits ${g.totals.commits}   lines +${g.totals.insertions}/-${g.totals.deletions}   tags ${g.totals.tags}   repos measured ${g.totals.reposMeasured}/${g.repos.length}`);
  if (g.unreachable.length) {
    p("");
    p("  NOT MEASURED");
    for (const u of g.unreachable) p(`    ${u.path}: ${u.reason}`);
  }
  p("");
  p(`  PROVENANCE  ${COMMANDS.length} git commands, ${COMMANDS.filter((c) => c.exit !== 0).length} non-zero.`);
  p("");
}

// ------------------------------------------------------------------ history

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}
function slugFor(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-80).toLowerCase();
}
function saveSnapshot(r) {
  // Written OUTSIDE the repository on purpose: gstack writes .context/retros/
  // into the project, where it becomes an untracked file the next `git status`
  // reports and the next retro then counts as changed files.
  const dir = path.join(stateDir(), "retros", slugFor(r.path));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${localDay(new Date())}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), window: r.window, metrics: r.metrics, verdict: r.verdict }, null, 2), "utf8");
  return file;
}
function loadSnapshots(repoPath) {
  const dir = path.join(stateDir(), "retros", slugFor(repoPath));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push({ file: path.join(dir, f), ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
    } catch {
      out.push({ file: path.join(dir, f), corrupt: true });
    }
  }
  return out;
}

// ------------------------------------------------------------------ commands

function cmdRun(args) {
  const dir = path.resolve(args.flags.dir === true || !args.flags.dir ? "." : String(args.flags.dir));
  const now = new Date();
  const win = parseWindow(args._[1] || args.flags.window || "7d", now);
  if (win.error) {
    process.stderr.write(`tb-retro: ${win.error}\n`);
    return 2;
  }
  const r = retroForRepo(dir, win, now, { fetch: !!args.flags.fetch, includeCommits: !!args.flags.commits });
  if (args.flags.save && r.metrics) r.snapshot = saveSnapshot(r);
  if (args.flags.json) process.stdout.write(JSON.stringify({ ...r, commands: COMMANDS }, null, 2) + "\n");
  else renderRepo(r);
  return r.verdict === "OK" ? 0 : r.verdict === "NO_DATA" ? 4 : 3;
}

function cmdGlobal(args) {
  const now = new Date();
  const win = parseWindow(args._[1] || args.flags.window || "7d", now);
  if (win.error) {
    process.stderr.write(`tb-retro: ${win.error}\n`);
    return 2;
  }
  const roots = (args.flags.root === true || !args.flags.root ? "." : String(args.flags.root)).split(",").map((s) => s.trim()).filter(Boolean);
  const depth = Number(args.flags.depth || 3);
  const disc = findRepos(roots, Number.isFinite(depth) ? depth : 3);
  const repos = [];
  for (const p of disc.found) repos.push(retroForRepo(p, win, now, { fetch: !!args.flags.fetch }));
  repos.sort((a, b) => (b.metrics?.commits ?? -1) - (a.metrics?.commits ?? -1));

  const measured = repos.filter((r) => r.metrics);
  const totals = {
    commits: measured.reduce((a, r) => a + r.metrics.commits, 0),
    insertions: measured.reduce((a, r) => a + r.metrics.insertions, 0),
    deletions: measured.reduce((a, r) => a + r.metrics.deletions, 0),
    tags: measured.reduce((a, r) => a + r.metrics.tags, 0),
    reposMeasured: measured.length,
  };
  const broken = repos.filter((r) => r.verdict === "UNVERIFIED");
  const g = {
    verdict: broken.length || disc.unreadable.length ? "PARTIAL" : measured.length ? "OK" : "NO_DATA",
    window: { label: win.label, start: localISO(win.start), end: localISO(win.end) },
    roots: roots.map((r) => path.resolve(r)),
    repos,
    totals,
    unreachable: disc.unreadable,
  };
  if (args.flags.json) process.stdout.write(JSON.stringify({ ...g, commands: COMMANDS }, null, 2) + "\n");
  else renderGlobal(g);
  return g.verdict === "OK" ? 0 : g.verdict === "NO_DATA" ? 4 : 3;
}

function cmdScan(args) {
  const roots = (args.flags.root === true || !args.flags.root ? "." : String(args.flags.root)).split(",").map((s) => s.trim()).filter(Boolean);
  const depth = Number(args.flags.depth || 3);
  const disc = findRepos(roots, Number.isFinite(depth) ? depth : 3);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(disc, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  ${disc.found.length} git repositories under ${roots.map((r) => path.resolve(r)).join(", ")} (depth ${depth})\n\n`);
    for (const f of disc.found) process.stdout.write(`    ${f}\n`);
    for (const u of disc.unreadable) process.stdout.write(`    UNREADABLE ${u.path}: ${u.reason}\n`);
    process.stdout.write("\n");
  }
  return disc.found.length ? 0 : 4;
}

function cmdTrend(args) {
  const dir = path.resolve(args.flags.dir === true || !args.flags.dir ? "." : String(args.flags.dir));
  const snaps = loadSnapshots(dir);
  const good = snaps.filter((s) => !s.corrupt && s.metrics);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ dir, snapshots: snaps }, null, 2) + "\n");
    return good.length >= 2 ? 0 : 4;
  }
  process.stdout.write(`\n  tb-retro trend  ${dir}\n  ${snaps.length} snapshot(s), ${snaps.filter((s) => s.corrupt).length} unreadable\n\n`);
  if (good.length < 2) {
    process.stdout.write("  Need two readable snapshots with the same window to compare. Run `run --save` again next week.\n\n");
    return 4;
  }
  const b = good[good.length - 1];
  const a = good[good.length - 2];
  if (a.window.label !== b.window.label) {
    process.stdout.write(`  NOT COMPARABLE: last snapshot used window ${a.window.label}, this one ${b.window.label}.\n`);
    process.stdout.write("  A different window is a different question, not a trend.\n\n");
    return 3;
  }
  const rows = ["commits", "insertions", "deletions", "testInsertions", "activeDays", "sessions", "tags", "contributors"];
  for (const k of rows) {
    const x = a.metrics[k] ?? 0;
    const y = b.metrics[k] ?? 0;
    process.stdout.write(`    ${pad(k, 16)} ${padL(x, 7)} -> ${padL(y, 7)}   ${y - x >= 0 ? "+" : ""}${y - x}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

/** Runs the four reproductions from this file's header, live, and prints them. */
function cmdRepro() {
  const bash = findBash();
  process.stdout.write(`\n  tb-retro gstack-repro  (${process.platform}, ${gitVersion() || "git NOT FOUND"})\n`);
  if (!bash) {
    process.stdout.write("\n  bash was not found on this machine, so the three shell reproductions cannot\n  be run here. They are quoted verbatim at the top of this file.\n\n");
    return 3;
  }
  const script = `
set +e
T=$(mktemp -d); cd "$T" || exit 1
git init -q norepo; cd norepo || exit 1
git config user.name TB; git config user.email tb@example.com
echo "--- 1. gstack SKILL.md:935 pre-check A, verbatim ---"
_RETRO_HAS_REMOTE=$(git remote 2>/dev/null | grep -c '^origin$' || echo 0)
printf 'value=[%s]\\n' "$_RETRO_HAS_REMOTE"
if [ "$_RETRO_HAS_REMOTE" = "0" ]; then echo "guard fired"; else echo "GUARD DID NOT FIRE -> fetches origin on a repo with no origin"; fi
echo "--- 2. gstack SKILL.md:1011 against a ref that does not exist ---"
echo x > f.txt; git add f.txt; git commit -q -m 'fix: handle a|b splitting in parser'
git log origin/main --since="7 days ago" --format="" --name-only | grep -v '^$' | sort | uniq -c | sort -rn
echo "pipeline exit=$?"
echo "--- 3. gstack SKILL.md:1000 pipe-delimited format ---"
git log -1 --format="%H|%aN|%ae|%ai|%s" | awk -F'|' '{print "NF="NF" (5 promised)"; print "subject="$5}'
echo "--- 4. gstack SKILL.md:1269,1296,1420,1722,1740 ---"
setopt +o nomatch; echo "setopt rc=$?"
cd /; rm -rf "$T"
`;
  const res = spawnSync(bash, ["-c", script], { encoding: "utf8", timeout: 60000, windowsHide: true });
  process.stdout.write("\n" + (res.stdout || "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : "") + "\n");
  return 0;
}

function findBash() {
  for (const c of ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "/usr/bin/bash", "/bin/bash"]) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

// ------------------------------------------------------------------- selftest

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

const EXPECTED_ASSERTIONS = 50;

function selftest() {
  const gv = gitVersion();
  if (!gv) {
    process.stdout.write("\n  tb-retro selftest: git is not installed, so nothing here can be proven.\n  That is itself the fail-closed answer: exiting non-zero.\n\n");
    process.exitCode = 1;
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-retro-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({
      name,
      expected: String(expected),
      got: String(got),
      pass: String(expected) === String(got),
      detail: String(detail).slice(0, 300),
    });
  const val = (v) => (v === undefined ? "(missing)" : v === null ? "null" : String(v));

  // --- fixture helpers -------------------------------------------------------
  const g = (dir, argv, env = {}) =>
    spawnSync("git", ["-C", dir, ...argv], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });

  const mkRepo = (name) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    spawnSync("git", ["init", "-q", d], { encoding: "utf8", timeout: 60000, windowsHide: true });
    g(d, ["config", "user.name", "Fixture"]);
    g(d, ["config", "user.email", "fixture@example.com"]);
    g(d, ["config", "commit.gpgsign", "false"]);
    g(d, ["config", "core.autocrlf", "false"]);
    return d;
  };

  /** daysAgo/hour are LOCAL, so they land inside a midnight-aligned window. */
  const at = (daysAgo, hour, minute = 0) => {
    const n = new Date();
    return localISO(new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, hour, minute, 0, 0));
  };

  const commit = (dir, { msg, when, name = "Fixture", email = "fixture@example.com", files = {}, binary = null }) => {
    for (const [f, content] of Object.entries(files)) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    if (binary) fs.writeFileSync(path.join(dir, binary), Buffer.from([0, 1, 2, 3, 0, 255, 7, 0]));
    g(dir, ["add", "-A"]);
    const r = g(
      dir,
      ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--no-verify", "-m", msg],
      { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email }
    );
    return r;
  };

  const runIn = (dir, extra = []) => runSelf(["run", "--dir", dir, "--json", ...extra]);

  try {
    // === 1. gstack REPRODUCTION 3: A PIPE IN THE SUBJECT ====================
    // `--format="%H|%aN|%ae|%ai|%s"` split on `|` yields NF=6 and a subject
    // truncated to "fix: handle a". Nothing here may lose a character.
    {
      const d = mkRepo("pipes");
      commit(d, { msg: 'fix: handle a|b splitting in "the" parser', when: at(2, 14), files: { "src/parse.js": "let a = 1;\nlet b = 2;\n" } });
      const r = runIn(d, ["--commits"]);
      check("a subject containing | round-trips exactly", 'fix: handle a|b splitting in "the" parser', r.json?.commits?.[0]?.subject ?? "(none)", r.stderr.slice(0, 200));
      check("...and the commit is still counted once", 1, r.json?.metrics?.commits ?? "(none)");
      check("...and its conventional type is read from the whole subject", "fix", r.json?.commits?.[0]?.type ?? "(none)");
      check("...verdict OK", "OK", r.json?.verdict ?? "(none)");
      check("...exit 0", 0, r.status);
    }

    // === 2. gstack REPRODUCTION 1+2: NO REMOTE, NO origin/main ==============
    // gstack's guard cannot fire, then `git log origin/main` is fatal and the
    // pipeline exits 0 with empty output: a real week reads as a dead one.
    {
      const d = mkRepo("no-remote");
      commit(d, { msg: "feat: something real", when: at(1, 9), files: { "app/x.js": "x\n" } });
      commit(d, { msg: "fix: something else", when: at(1, 10), files: { "app/y.js": "y\n" } });
      const r = runIn(d);
      check("a repo with no origin still produces real counts", 2, r.json?.metrics?.commits ?? "(none)", r.stderr.slice(0, 200));
      check("...the missing origin is DISCLOSED, not silently skipped", true, (r.json?.reasons || []).some((x) => /no 'origin' remote/.test(x)), JSON.stringify(r.json?.reasons));
      check("...hasOrigin is false", "false", val(r.json?.hasOrigin));
      check("...the ref used is named", true, typeof r.json?.ref === "string" && r.json.ref.length > 0, val(r.json?.ref));
      check("...and it is flagged as a fallback rather than passed off as origin", "true", val(r.json?.refFallback));
      check("...nothing was fetched", "false", val(r.json?.fetched));
    }

    // === 3. AN EMPTY WINDOW IS NO_DATA, NOT A NARRATIVE ====================
    {
      const d = mkRepo("stale");
      commit(d, { msg: "feat: ancient history", when: at(60, 12), files: { "a.js": "a\n" } });
      const r = runIn(d, ["--window", "7d"]);
      check("zero commits in the window yields NO_DATA", "NO_DATA", r.json?.verdict ?? "(none)", r.stderr.slice(0, 200));
      check("...metrics are null, not zeroes that can be narrated", "null", val(r.json?.metrics));
      check("...exit 4, distinguishable from success", 4, r.status);
      check("...and the reason names the newest commit and the window start", true, (r.json?.reasons || []).some((x) => /BEFORE the window start/.test(x)), JSON.stringify(r.json?.reasons));
      const wide = runIn(d, ["--window", "90d"]);
      check("...the same repo over 90d is OK, proving the window was the problem", "OK", wide.json?.verdict ?? "(none)");
      check("...with the one commit", 1, wide.json?.metrics?.commits ?? "(none)");
    }

    // === 4. BINARY FILES ARE `-` IN numstat, NOT A NUMBER ==================
    {
      const d = mkRepo("binary");
      commit(d, { msg: "feat: add logo and code", when: at(1, 11), files: { "src/a.js": "1\n2\n3\n" }, binary: "logo.png" });
      const r = runIn(d);
      check("a binary file does not poison the LOC total", 3, r.json?.metrics?.insertions ?? "(none)", r.stderr.slice(0, 200));
      check("...insertions is a finite number", true, Number.isFinite(r.json?.metrics?.insertions), val(r.json?.metrics?.insertions));
      check("...and binaries are counted on their own", 1, r.json?.metrics?.binaryFiles ?? "(none)");
      check("...both files still count as changed", 2, r.json?.metrics?.filesChanged ?? "(none)");
    }

    // === 5. ONE HUMAN, TWO EMAILS / TWO SPELLINGS ==========================
    // gstack keys authors on %aN, so a name change splits one person into two
    // contributors and halves both their commit counts.
    {
      const d = mkRepo("identity");
      commit(d, { msg: "feat: one", when: at(2, 9), name: "Orion Jones", email: "orion@personal.example", files: { "a.js": "a\n" } });
      commit(d, { msg: "feat: two", when: at(2, 10), name: "orion jones", email: "orion@work.example", files: { "b.js": "b\n" } });
      commit(d, { msg: "chore: bot", when: at(2, 11), name: "dependabot[bot]", email: "support@dependabot.example", files: { "c.js": "c\n" } });
      const r = runIn(d);
      check("one human under two emails is one contributor", 1, r.json?.metrics?.contributors ?? "(none)", JSON.stringify((r.json?.authors || []).map((a) => a.name)));
      check("...the merge is disclosed, not hidden", 1, r.json?.metrics?.identitiesMerged ?? "(none)");
      check("...their commits are summed, not halved", 2, (r.json?.authors || []).find((a) => !a.bot)?.commits ?? "(none)");
      check("...the alias email is listed", 1, (r.json?.authors || []).find((a) => !a.bot)?.aliases?.length ?? "(none)");
      check("...a bot is excluded from the contributor count", 1, r.json?.metrics?.botContributors ?? "(none)");
    }

    // === 6. A PATH WITH A SPACE (i.e. OneDrive\Desktop, i.e. this machine) ==
    {
      const d = mkRepo("my repo with spaces");
      commit(d, { msg: "feat: works under a spaced path", when: at(1, 13), files: { "src/x.js": "x\n" } });
      const r = runIn(d);
      check("a repo path containing spaces is measured normally", 1, r.json?.metrics?.commits ?? "(none)", r.stderr.slice(0, 200));
      check("...verdict OK", "OK", r.json?.verdict ?? "(none)");
      // Probes for refs that do not exist are SUPPOSED to exit non-zero; a
      // spawn error, or a log/tag/rev-parse that failed, would mean the path
      // itself broke the invocation.
      const badCmds = (r.json?.commands || []).filter(
        (c) => c.error || (/--no-pager (log|tag|rev-parse --is-inside)/.test(c.argv.join(" ")) && c.exit !== 0)
      );
      check("...no data command was broken by the space in the path", 0, badCmds.length, JSON.stringify(badCmds.map((c) => c.argv.join(" "))));
    }

    // === 7. A COMMIT DATED IN THE FUTURE BREAKS THE WINDOW =================
    {
      const d = mkRepo("skew");
      commit(d, { msg: "feat: normal", when: at(1, 10), files: { "a.js": "a\n" } });
      commit(d, { msg: "feat: from tomorrow", when: at(-3, 10), files: { "b.js": "b\n" } });
      const r = runIn(d);
      check("a commit authored in the future forces UNVERIFIED", "UNVERIFIED", r.json?.verdict ?? "(none)", JSON.stringify(r.json?.reasons));
      check("...exit 3", 3, r.status);
      check("...and the in-window counts are still shown so the user can judge", 1, r.json?.metrics?.commits ?? "(none)");
    }

    // === 8. TAGS ARE THE DEPLOY SIGNAL, AND THEY ARE COUNTED IN-WINDOW =====
    {
      const d = mkRepo("tags");
      commit(d, { msg: "feat: release me", when: at(2, 9), files: { "a.js": "a\n" } });
      g(d, ["tag", "v1.0.0"], { GIT_COMMITTER_DATE: at(2, 9) });
      commit(d, { msg: "fix: patch", when: at(1, 9), files: { "b.js": "b\n" } });
      g(d, ["tag", "v1.0.1"], { GIT_COMMITTER_DATE: at(1, 9) });
      const r = runIn(d);
      check("tags created inside the window are counted", 2, r.json?.metrics?.tags ?? "(none)", JSON.stringify(r.json?.metrics?.tagNames));
      check("...and named", "v1.0.0,v1.0.1", (r.json?.metrics?.tagNames || []).sort().join(","));
    }

    // === 9. SESSIONS AND TEST RATIO ARE ARITHMETIC, NOT IMPRESSIONS ========
    {
      const d = mkRepo("sessions");
      commit(d, { msg: "feat: s1a", when: at(3, 9, 0), files: { "src/a.js": "1\n2\n3\n4\n" } });
      commit(d, { msg: "feat: s1b", when: at(3, 9, 20), files: { "src/b.js": "1\n2\n3\n4\n" } });
      commit(d, { msg: "test: s2", when: at(3, 14, 0), files: { "src/__tests__/a.test.js": "1\n2\n" } });
      const r = runIn(d);
      check("two commits 20m apart and one 4h later is 2 sessions", 2, r.json?.metrics?.sessions ?? "(none)", JSON.stringify(r.json?.sessionDetail?.sessions));
      check("...the 45m gap rule is stated in the output", 45, r.json?.sessionDetail?.gapRuleMinutes ?? "(none)");
      check("...test insertions are separated from production ones", 2, r.json?.metrics?.testInsertions ?? "(none)");
      check("...giving an exact test ratio", 0.2, r.json?.metrics?.testRatio ?? "(none)");
      check("...active days counts distinct authored days", 1, r.json?.metrics?.activeDays ?? "(none)");
    }

    // === 10. A DIRECTORY THAT IS NOT A REPO IS REPORTED, NOT DROPPED =======
    {
      const notRepo = path.join(tmp, "not-a-repo");
      fs.mkdirSync(notRepo, { recursive: true });
      fs.writeFileSync(path.join(notRepo, "readme.txt"), "hi\n", "utf8");
      const r = runIn(notRepo);
      check("a non-repo directory is UNVERIFIED with a reason", "UNVERIFIED", r.json?.verdict ?? "(none)", JSON.stringify(r.json?.reasons));
      check("...exit 3", 3, r.status);
      check("...and no metrics are invented", "null", val(r.json?.metrics));
    }

    // === 11. GLOBAL MODE: ONE BROKEN REPO MAKES THE WHOLE RUN PARTIAL ======
    {
      const root = path.join(tmp, "globalroot");
      fs.mkdirSync(root, { recursive: true });
      const a = path.join(root, "alpha");
      fs.mkdirSync(a, { recursive: true });
      spawnSync("git", ["init", "-q", a], { encoding: "utf8", timeout: 60000, windowsHide: true });
      g(a, ["config", "user.name", "Fixture"]);
      g(a, ["config", "user.email", "fixture@example.com"]);
      g(a, ["config", "commit.gpgsign", "false"]);
      commit(a, { msg: "feat: alpha ships", when: at(1, 10), files: { "a.js": "a\n" } });
      // A directory with a .git that is not a repository: discovery finds it,
      // and it must survive as a NAMED failure rather than a missing row.
      const b = path.join(root, "beta");
      fs.mkdirSync(path.join(b, ".git"), { recursive: true });
      fs.writeFileSync(path.join(b, ".git", "config"), "not really a git dir\n", "utf8");
      const r = runSelf(["global", "--root", root, "--json", "--depth", "3"]);
      check("global mode finds both repositories", 2, r.json?.repos?.length ?? "(none)", r.stderr.slice(0, 200));
      check("...the working one reports real commits", 1, (r.json?.repos || []).find((x) => x.repo === "alpha")?.metrics?.commits ?? "(none)");
      check("...the broken one is UNVERIFIED, not omitted", "UNVERIFIED", (r.json?.repos || []).find((x) => x.repo === "beta")?.verdict ?? "(none)");
      check("...so the whole run is PARTIAL", "PARTIAL", r.json?.verdict ?? "(none)");
      check("...and exits 3", 3, r.status);
      check("...totals count only the repos that were actually measured", 1, r.json?.totals?.reposMeasured ?? "(none)");
    }

    // === 12. USAGE ERRORS EXIT 2 ==========================================
    {
      const r = runSelf(["run", "--dir", tmp, "--window", "7 days", "--json"]);
      check("an unparseable window exits 2 rather than defaulting", 2, r.status, r.stderr.slice(0, 200));
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may still hold a handle on a .git pack; the temp dir is not the point */
    }
  }

  results.push({
    name: `all ${EXPECTED_ASSERTIONS} assertions ran`,
    expected: String(EXPECTED_ASSERTIONS),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED_ASSERTIONS,
    detail: "the count is fixed so a silently skipped block cannot pass unnoticed",
  });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-retro selftest  (node ${process.version}, ${process.platform}, ${gv})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${pad(r.name, width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  This retro engine is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken repository above produced the CLOSED answer: a\n");
  process.stdout.write("  named reason, a non-zero exit, and no metric that was not actually counted.\n\n");
}

// ------------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function help() {
  process.stdout.write(`
  tb-retro ${VERSION}, the Toolbay Stack retrospective engine

    run    [WINDOW] [--dir D] [--json] [--fetch] [--save] [--commits]
    global [WINDOW] [--root A,B] [--depth N] [--json] [--fetch]
    scan   [--root A,B] [--depth N] [--json]
    trend  [--dir D] [--json]
    gstack-repro                     run the four gstack reproductions live
    selftest                         prove this engine on broken repositories

  WINDOW is N followed by h, d or w (default 7d). Day and week windows start at
  local midnight, gstack's rule, and the resolved absolute range is printed.

  Exit codes:  0 measured    2 usage error
               3 UNVERIFIED (a ref, a repo, or the clock could not be trusted)
               4 NO DATA (the window is empty — nothing is narrated from nothing)

  Nothing here goes through a shell. Every number in the output came out of a
  git command whose argv and exit code are in --json.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  resetCommands();

  if (!cmd || cmd === "help" || args.flags.help) {
    help();
    return 0;
  }
  if (cmd === "selftest") {
    selftest();
    return process.exitCode ?? 0;
  }
  if (cmd === "gstack-repro") return cmdRepro();

  if (!gitVersion()) {
    process.stderr.write("tb-retro: git is not installed or not on PATH. Nothing can be measured; refusing to print a retro.\n");
    return 3;
  }

  if (cmd === "run") return cmdRun(args);
  if (cmd === "global") return cmdGlobal(args);
  if (cmd === "scan") return cmdScan(args);
  if (cmd === "trend") return cmdTrend(args);

  process.stderr.write(`tb-retro: unknown command "${cmd}"\n`);
  help();
  return 2;
}

const code = main();
if (typeof code === "number" && code !== 0) process.exitCode = code;
