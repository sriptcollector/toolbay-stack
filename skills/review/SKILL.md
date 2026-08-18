---
name: review
version: 0.3.0
description: Pre-landing code review. Establishes the diff base deterministically or refuses, then reviews the change against a checklist for SQL safety, race conditions, LLM trust boundaries, shell injection, enum completeness, and fail-open or POSIX-only code. Fixes the mechanical findings, asks about the rest. Use before merging, before opening a PR, or when asked to check a diff.
triggers:
  - review this pr
  - code review
  - check my diff
  - review my changes
  - pre-landing review
provides:
  - code-review
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---

# review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (merge-base diff, two-pass CRITICAL/INFORMATIONAL
checklist, Fix-First classification, the suppression list, and the terse
`[file:line] problem -> fix` output) comes from `review` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The diff-base resolver, the claim scanner, and the Portability
& Fail-Open category are new. Not affiliated with or endorsed by Garry Tan.
See NOTICE.

Reviews the current branch against its base for the structural problems tests do
not catch. Fixes what is mechanical, asks about what is not. Never commits,
never pushes, never opens a PR — that is `/ship`.

---

## Step 1: Establish what you are comparing against

```bash
node ~/.claude/skills/review/scripts/tb-review.mjs basis
```

Do not skip this and do not hand-roll it. The exit code is the instruction:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | A reviewable diff exists | Continue. The command prints the exact `git diff <sha>` to run. |
| 4 | Verified: no changes | Say "Nothing to review — no changes against `<base>`." and stop. |
| 3 | The comparison point could not be established | **STOP and say so.** Report the step marked `no`. Do not review, and do not call this "no issues". |
| 2 | Not a git work tree, or git is missing | Stop and say which. |

### Which comparison you got

`basis` reviews a **branch** by default: your feature branch against its merge
base with `main`. That is the normal case, and `--json` reports
`"comparison": "branch"`.

You do not need a feature branch. Standing on the base branch with uncommitted
work, `basis` reviews the **working tree against HEAD** instead, reports
`"comparison": "working-tree"`, and prints a line saying so. Say so in your
review too — nothing in it has been committed yet, so "this should not land"
means something different.

This used to be exit 3, UNDETERMINED. It was wrong twice over: uncommitted work
on `main` is the most common state anyone asks for a review from, and it is the
state `/suggest` routes here from — so the two skills contradicted each other,
one recommending a command the other refused. There was a diff sitting in front
of it the whole time; there was just no *branch* diff.

Exit 3 now means what it says: no branch diff **and** a clean working tree, or a
base branch that could not be identified at all. Those really are nothing to
review.

### Why this is a command and not three lines of shell

gstack does it inline (`review/SKILL.md.tmpl:41`, `:71-79`):

```bash
git fetch origin <base> --quiet && DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff "$DIFF_BASE" --stat
```

with the rule "If no diff, output *Nothing to review* and stop." Every link is
`&&`. A failed fetch — offline, no remote, expired token, shallow clone — means
`git diff` never runs, the output is empty, and the documented response to empty
output is to declare the branch clean. Reproduced on Windows 11, 2026-08-13, in
a fresh repo holding a real commit on a feature branch and no `origin`:

```
fatal: 'origin' does not appear to be a git repository
chain exit = 128    DIFF_BASE=''    stat output: (empty)
```

A review that passes because it could not find the diff is worse than no review.
`basis` gives "there are genuinely no changes" its own exit code (4, and it
proves it by running the diff), separate from "I could not work out what to
compare against" (3, with the failing step named). It also works with a local
base branch when there is no remote at all, which the gstack chain cannot.

---

## Step 2: Read the checklist

```bash
node ~/.claude/skills/review/scripts/tb-review.mjs checklist
```

**If it exits 2, STOP and report it.** Do not review from a remembered
checklist.

gstack's Step 2 says to read `.claude/skills/review/checklist.md` and to stop if
it cannot be read. That path is project-relative, and the file is not part of
the install. Verified on this machine against gstack 1.60.1.0:

```
$ ls ~/.claude/skills/review/
SKILL.md
```

So on a clean install the file the skill stops without does not exist anywhere.
Here the checklist ships inside the skill directory and is resolved relative to
the script, so it is found wherever the skill was installed.

---

## Step 3: Critical pass

Apply the Pass 1 categories from the checklist to the diff: SQL & Data Safety,
Race Conditions & Concurrency, LLM Output Trust Boundary, Shell Injection, Enum
& Value Completeness, Portability & Fail-Open.

Then the Pass 2 informational categories.

Two categories need work outside the diff:

- **Enum & Value Completeness.** Grep for sibling values, then *read* each
  consumer. A new value that the backend never persists is the common miss.
- **Portability & Fail-Open.** New to this fork. `|| true` on a guard line,
  `[ -x "$S" ] && "$S" || exit 0`, a `cmd | tee log` pipeline whose exit status
  is `tee`'s, `/tmp` in a path another runtime will open, `$$`, `date +%s`,
  `case "$p" in /*)`. These are how a check stops checking without anyone
  noticing, and they are the most common defect class in this codebase's own
  history.

When you recommend a framework-specific fix, check it is still current practice
for the version in use rather than reciting a remembered pattern.

---

## Step 4: Fix-first

Every finding gets an action.

**AUTO-FIX** the mechanical ones and print one line each:
`[AUTO-FIXED] [file:line] Problem -> what you did`

**ASK** about the rest, batched into a single question with a numbered list, a
recommended fix per item, A) Fix / B) Skip, and one overall recommendation.
Critical findings lean ASK, informational lean AUTO-FIX. The full heuristic is
in the checklist.

Then apply what was approved.

---

## Step 5: Verify your own claims

```bash
node ~/.claude/skills/review/scripts/tb-review.mjs claims --file <your review output>
```

Exit 1 means the review contains something the reader cannot check. It rejects
"likely handled", "probably tested", "should be safe", "looks fine", "handled
elsewhere" with no citation, and "this is tested" with no test file named. Fix
each by citing `file:line`, or restate it as an explicit unknown.

An empty review output is also rejected, because "I wrote nothing" and "I found
nothing" are not the same result.

gstack has the same rule in prose ("Never say 'likely handled' or 'probably
tested' — verify or flag as unknown"). This makes it exit non-zero.

---

## Step 6: Cross-references

- `TODOS.md`, if present: does this close any open item? Does it create work
  that should become one?
- Documentation: if the diff changes behavior a root `.md` file describes and
  that file was not touched, flag it as informational.

---

## Prove the checks work

```bash
node ~/.claude/skills/review/scripts/tb-review.mjs selftest
```

Builds throwaway git repositories covering: a feature branch with no remote, a
repository with no identifiable base branch, standing on the base branch, a
branch with genuinely no changes, and a directory that is not a repository. One
fixture runs gstack's own diff-base chain and asserts it comes back empty, which
is the failure this skill exists to stop reporting as a pass.

## Important rules

- Read the whole diff before commenting. Do not flag what the diff already fixed.
- Fix-first, not read-only. Never commit, push, or open a PR.
- Be terse. One line for the problem, one for the fix.
- Only flag real problems.
- If you could not establish the diff base, say that. Never report it as clean.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief review
```

Follow the lines it prints for `review`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
