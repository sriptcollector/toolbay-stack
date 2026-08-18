---
name: context-restore
version: 0.1.0
description: Reload the working context saved earlier by /context-save, and verify it before believing it. Checks that the files the context names still exist, that its branch still exists, how much landed since, and how old it is, then refuses rather than presenting a context it could not verify. Use to resume, restore context, pick up where you left off, or ask where you were.
triggers:
  - resume where i left off
  - restore context
  - where was i
  - pick up where i left off
  - context restore
  - reload my context
  - catch me up on this project
provides:
  - context-read
  - context-restore-verification
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - AskUserQuestion
---

# context-restore

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command and its contract (`/context-restore`, resuming the
most recent saved context across all branches by default, selecting one by title
fragment, the save-side file format and its `status` / `branch` / `timestamp` /
`session_duration_s` / `files_modified` frontmatter, the
`projects/<slug>/checkpoints/YYYYMMDD-HHMMSS-<title>.md` layout, the rule that
"most recent" means the filename prefix and not mtime, and the RESUMING CONTEXT
report) comes from `context-restore` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The verification pass, the exit-code verdicts and the refusals
are new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

**HARD GATE: this skill never edits code.** It reads saved context and reports.

## Run it

```bash
node ~/.claude/skills/context-restore/scripts/tb-context-restore.mjs restore
```

That is the whole flow. Read what it prints. Do not add fields it did not print.

| | |
|---|---|
| `restore` | newest saved context for this project, verified |
| `restore <fragment>` | one specific context, by title fragment, branch, or list number |
| `restore --json` | the same verdict as data |
| `list` | every loadable context, and every file in those directories that is not one |
| `where` | the project slug, how it was derived, and every directory searched |
| `selftest` | run the CLI against deliberately broken saved-context directories |

Exit codes, because "nothing saved" and "I could not look" are different answers:

| code | verdict | what you say |
|---|---|---|
| 0 | OK | present it normally |
| 5 | STALE | present it **with** the failed checks, verbatim |
| 4 | REFUSED | say what could not be verified. Do **not** describe the context |
| 3 | NONE | "nothing saved for this project yet, run /context-save" |
| 2 | usage | the command was called wrong |

## The rule that matters

**Print only what the tool printed.** Every field in the banner comes from the
file. If the tool refused, the answer to "where was I" is "I could not verify the
saved context, here is why" — not a reconstruction from the conversation, not a
plausible summary, not a title inferred from a filename.

This is the whole reason there is code here. The output of a restore *becomes*
the model's belief about the project, so a restore that guesses does not fail
loudly, it misleads quietly for the rest of the session.

On STALE, read the failed checks out. A context whose branch was deleted and
whose files are gone still contains a Remaining Work list, and that list is the
most dangerous thing on the screen.

## What it verifies, and why gstack cannot

gstack's `/context-restore` is prose with one shell block in it: list a
directory, then "Read the chosen file and present a summary" into a template of
fields. Four things follow, all reproduced on Windows 11 with gstack 1.60.1.0,
2026-08-13.

**1. A broken lookup reports as an empty result.** Step 1 hard-codes
`~/.claude/skills/gstack/bin/gstack-slug` and `gstack-paths`. When either is
missing — plugin install, different HOME, per-project install — the command
substitution is empty, `eval ""` succeeds, and both variables are simply never
set:

```
$ export HOME=<a home with saved contexts but no ~/.claude/skills/gstack>
$ find "$HOME/.gstack/projects" -name '*.md'
.../fakehome/.gstack/projects/myproj/checkpoints/20260813-101010-real-work.md
$ <gstack context-restore Step 1, verbatim>
resolved CHECKPOINT_DIR=[/projects//checkpoints]
NO_CHECKPOINTS
--- exit status: 0
```

The instruction for `NO_CHECKPOINTS` is to tell the user "No saved contexts yet.
Run `/context-save` first". The context is on disk. And with `$SLUG` empty the
path is project-independent, so wherever that bucket exists, one project's notes
are served to another. Here an unusable state root is exit 4 with the reason, and
exit 3 means the search worked and found nothing.

**2. "Most recent" is an unenforced claim.** The skill says the newest is the
first line of `find | sort -r`. Every letter sorts above every digit:

```
$ find "$D" -maxdepth 1 -name "*.md" -type f | sort -r | head -20
.../zz-scratch.md
.../20260813-101010-real-newest.md
```

So it loads `zz-scratch.md`, which has no frontmatter, and then fills in Title /
Branch / Saved / Status from nothing. Here the timestamp is parsed and validated
as a real date, files that do not conform are named and skipped, and a directory
holding nothing loadable is a refusal.

**3. The slug depends on which directory you are standing in.** gstack falls back
to `basename $PWD` with no git remote:

```
$ cd .../proj     && gstack-slug   ->  SLUG=proj
$ cd .../proj/src && gstack-slug   ->  SLUG=src
```

Save from the root, restore from `src/`, get NO_CHECKPOINTS. Here the slug comes
from the git remote or the repository root, so it is the same anywhere inside the
project, and `where` prints how it was derived.

**4. Nothing checks that the saved work still exists.**

```
$ grep -n "files_modified" ~/.claude/skills/gstack/context-restore/SKILL.md.tmpl
(no output)
```

The save side records `files_modified` and `branch`; the restore side prints
them. A six-week-old context, on a branch deleted at merge, naming files that no
longer exist, restores exactly like one from ten minutes ago. Here:

```
RESUMING CONTEXT  [STALE]
Branch:      feat/auth   <-- you are on master
Saved:       2026-08-13 20:56:51  (2h 0m ago)

VERIFICATION
  PASS  timestamp provenance
  PASS  age
  FAIL  recorded files still exist
         1 of 2 recorded files are gone: src/deleted.ts
  FAIL  saved branch exists
         branch "feat/auth" no longer exists in this repository
  PASS  commits since the save
         1 commit(s) landed since this context was saved

  NOTE  1 recorded file(s) have been modified since the save: src/one.ts
        Some of the remaining work below may already be done.
```

Every recorded file gone is exit 4 and the body is **withheld**, because reading
its remaining-work list means planning edits to a tree that no longer exists.

## Fail closed, everywhere

- A check that could not run is never a check that passed. In a git repository
  where `git` will not execute, the branch and drift checks report FAIL ("was NOT
  checked"), not N/A. N/A is reserved for a project that is genuinely not a repo.
- A context recording no `files_modified` can never be OK, because nothing in it
  could be checked against the tree. It is STALE with that as the reason.
- A title query that matches nothing is a refusal, not a fallback to the newest.
  A query matching two is a refusal listing both, not a coin flip.
- A filename timestamp and a frontmatter timestamp that disagree by more than an
  hour mean the file's provenance is unestablished: FAIL, never OK. The
  comparison is wall-clock against wall-clock, so a context saved in another
  timezone is not accused of being tampered with.
- A crash prints `REFUSED` and exits 4. Nothing about this tool turns an error
  into a restore.

## Windows

No bash, no `find`, no `sort`, no `date`, no `/tmp`, no symlink assumptions —
Node only, so Git Bash, PowerShell and cmd give the same answer. Recorded paths
are resolved whether they were written `src/a.ts`, `src\a.ts`, `./a.ts` or
`/c/Users/...`, and they resolve against the repository root rather than whatever
directory you happen to be in.

## Prove the checks work

```bash
node ~/.claude/skills/context-restore/scripts/tb-context-restore.mjs selftest
```

26 assertions, each one a way a restore reports success without having
established anything: a broken state root, junk that outsorts the real newest, an
impossible date, a 0-byte file, missing frontmatter, a deleted tree, a query that
matches nothing. It drives the real CLI as child processes and exits non-zero if
any of them produce a confident restore.

## Pairs with

`/context-save` writes the files this reads. This skill also reads gstack's
legacy `~/.gstack/projects/<slug>/checkpoints/` directory, so a context saved
before the move is still restorable, and the report says which directory it came
from.

## Mode

This skill runs inside a stance. Read it before you start:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief context-restore
```

Follow the lines it prints for `context-restore`. Where they disagree with the
defaults above, the mode wins — except for one thing no stance gets to loosen: a
context that was not verified is never presented as though it were.
