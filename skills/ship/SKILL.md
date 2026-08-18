---
name: ship
version: 0.3.0
description: Land a change. Preflight the branch, merge the base, run the tests and capture their real exit codes, review the diff, bump VERSION and CHANGELOG, commit in bisectable chunks, then a gate that refuses to push unless the green test run happened at the current commit. Use when asked to ship, land, deploy, push to main, cut a release, or open a PR.
triggers:
  - ship it
  - land this
  - create a pr
  - open a pr
  - push to main
  - cut a release
provides:
  - shipping-deploy
platforms:
  - win32
  - darwin
  - linux
cost: high
sensitive: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# ship

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (run straight through without asking, abort on the
base branch, merge the base before testing, test, review, bump VERSION, update
CHANGELOG, bisectable commits, the Step 16 verification gate and its Iron Law,
push, open or update the PR, and the re-run idempotency rules) comes from `ship`
in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The preflight, the test runner and the evidence gate are new.
Not affiliated with or endorsed by Garry Tan. See NOTICE.

`/ship` runs straight through. The user said ship, which means do it. Do not ask
for confirmation at each step.

**Stop only for:** being on the base branch, a merge conflict you cannot resolve
safely, a failing test that belongs to this branch, a review finding that needs
judgment, a MINOR or MAJOR version bump, or a failing gate.

**Never stop for:** uncommitted changes (include them), the CHANGELOG wording,
commit message approval, or "ready to push?".

**Re-running `/ship` re-runs the whole checklist.** Only the actions are
idempotent: skip a bump that already happened, skip a push that already
happened, update an existing PR instead of opening a second one. Never skip a
*verification* because a previous run did it.

---

## Step 1: Preflight

```bash
node ~/.claude/skills/ship/scripts/tb-ship.mjs preflight
```

Checks, and prints `ok` or `NO` for each:

- inside a git work tree
- a base branch can be identified, and you are not standing on it
- the merge base resolves
- there is actually something to ship
- **no unresolved conflict markers** in any changed file
- `VERSION`, if the repo has one, is `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH.MICRO`
- the CHANGELOG has an entry for that version

Exit 1 means fix the `NO` lines first. Exit 2 means this is not a repository.

---

## Step 2: Merge the base before testing

```bash
git fetch origin <base> && git merge origin/<base> --no-edit
```

So the tests run against the merged state. Auto-resolve only the mechanical
conflicts (VERSION, CHANGELOG ordering, a lockfile). Anything ambiguous: stop
and show it.

---

## Step 3: Run the tests

```bash
node ~/.claude/skills/ship/scripts/tb-ship.mjs run --label tests -- npm test
node ~/.claude/skills/ship/scripts/tb-ship.mjs run --label lint  -- npm run lint
```

Each run records the command, its **real exit code**, the full transcript at an
absolute path, and the commit it ran at. Exit 1 from `run` is a red suite.

Do not background these and do not pipe them into `tee`.

### Why not

gstack runs both suites like this (`ship/sections/tests.md.tmpl:16-19`):

```bash
bin/test-lane 2>&1 | tee /tmp/ship_tests.txt &
npm run test 2>&1 | tee /tmp/ship_vitest.txt &
wait
```

A pipeline exits with the status of its **last** stage, and the last stage is
`tee`, which always succeeds. Measured on Windows 11, 2026-08-13:

```
$ false | tee /tmp/ship_tests.txt; echo $?
0
```

No `set -o pipefail`, no `PIPESTATUS`, and a bare `wait` returns only the last
job's status. The only thing left that can notice a failing suite is the agent
reading the transcript — which is exactly the judgment call the step exists to
remove. Separately, `&` and `wait` are bash-only, and `/tmp` is
`C:\Users\<u>\AppData\Local\Temp` to Git Bash and `C:\tmp` to Node and
PowerShell, so the file written is not the file read.

**If a test fails:** triage it. A failure that this branch introduced must be
fixed before continuing. A pre-existing failure gets fixed, ticketed, or
explicitly skipped with a reason — and say which.

---

## Step 4: Review the diff

Run `/review`, or apply its checklist inline. Auto-fix the mechanical findings,
ask about the rest. Every fix made here means Step 7's gate will demand a fresh
test run, which is the point.

---

## Step 5: Version and CHANGELOG

Decide the bump from the diff:

- **MICRO** under 50 lines, config and trivia
- **PATCH** 50+ lines, no new capability
- **MINOR** — **ask** — a new route, a migration, a new module, or 500+ lines
- **MAJOR** — **ask** — a breaking change or a milestone

Write the new version to `VERSION` (and to `package.json` if the repo keeps them
in step), then add a CHANGELOG entry dated `YYYY-MM-DD` describing what changed,
generated from the diff. Re-run `preflight` afterwards; it checks the two agree.

---

## Step 6: Commit in bisectable chunks

Group the diff into logical commits, each one independently valid — no broken
imports, no reference to code that does not exist yet.

Order: infrastructure (migrations, config, routes), then models and services
with their tests, then controllers, views and components with their tests, then
VERSION + CHANGELOG + TODOS last, in the final commit.

A model and its test go together. A migration is its own commit. If the whole
diff is under 50 lines across fewer than 4 files, one commit is fine.

---

## Step 7: The gate

```bash
node ~/.claude/skills/ship/scripts/tb-ship.mjs gate
```

**IRON LAW: no completion claim without fresh verification evidence.**

The gate fails when: nothing was recorded, any recorded run exited non-zero, any
run failed to start, or **any run happened at a commit that is no longer HEAD**.
That last one is the case that matters — you fixed a review finding in Step 4,
committed it in Step 6, and the green test run is now describing different code.

Re-run the suite through `run` and try the gate again. Do not push while it
fails.

gstack has this rule in prose (Step 16) with the rationalisations spelled out —
"should work now", "I'm confident", "I already tested earlier", "it's a trivial
change" — and nothing that can act on them. This is the same rule as an exit
code.

---

## Step 8: Push and PR

```bash
git push -u origin <branch>
```

Never force push. If the branch is already pushed and up to date, skip it.

Then create the PR, or update its body if one exists. Title:
`v<VERSION> <type>: <summary>`. Body: what changed and why, the test results
from the gate output (not from memory), the review findings and what was done
with each, and `Closes #N` if this delivers a spec issue in full.

Output the PR URL. That is the end of the run.

---

## Prove the checks work

```bash
node ~/.claude/skills/ship/scripts/tb-ship.mjs selftest
```

Builds throwaway repositories for each failure mode: on the base branch, nothing
to ship, unresolved conflict markers, a malformed VERSION, a CHANGELOG with no
entry, a red suite, a command that cannot start, a corrupt evidence file, and a
green run that goes stale when HEAD moves. The last case runs gstack's own
`cmd | tee log` shape and shows it reporting 0 for a failing command.

## Important rules

- Never skip tests. A red suite stops the ship.
- Never force push.
- Never push on stale evidence. If code changed, run it again.
- Never ask for a trivial confirmation. Do ask about MINOR/MAJOR and about
  review findings that need judgment.
- The goal: the user types `/ship` and the next thing they see is the review,
  the PR URL, and green test output that describes the code that is actually
  in the PR.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief ship
```

Follow the lines it prints for `ship`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
