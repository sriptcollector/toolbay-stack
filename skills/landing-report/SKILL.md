---
name: landing-report
version: 0.1.0
description: Read-only snapshot of the release queue — which VERSION slots are already claimed by open PRs, branches and worktrees, and which slot /ship would take next. Distinguishes an empty queue from an unread one and refuses to recommend a slot when the queue could not be read. Use to see the landing report, what is in the release queue, which version to claim next, or what is about to ship.
triggers:
  - landing report
  - release queue
  - whats in the queue
  - which version do I claim
  - what is about to ship
  - show me open PRs
  - next version slot
provides:
  - version-slot-queue
  - release-collision-avoidance
  - unknown-vs-empty-distinction
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# landing-report

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The skill name, the version-slot queue concept and the command
surface are gstack's, by Garry Tan (https://github.com/garrytan/gstack, MIT,
Copyright (c) 2026 Garry Tan). The code is a rewrite. See LICENSE and NOTICE.

## What it does

Prints who is holding which release slot, so two people do not bump `VERSION`
to the same number and turn a release into a merge conflict.

```bash
node skills/landing-report/scripts/tb-landing.mjs report
node skills/landing-report/scripts/tb-landing.mjs report --dir ../other-repo --json
node skills/landing-report/scripts/tb-landing.mjs next      # prints just the slot
```

**It mutates nothing.** No branches, no tags, no pushes, no VERSION writes.

## The distinction it exists to preserve

The dangerous output of a queue report is not a wrong number. It is a confident
empty one. If `gh` is missing, unauthenticated, or offline, the naive version
prints:

```
Open PRs:  (none)
```

…which is indistinguishable from *the coast is clear*, and you act on it.

So every source reports one of three states — `KNOWN_CLAIMED`, `KNOWN_EMPTY`,
`UNKNOWN` — and `UNKNOWN` is loud, is never collapsed into empty, and downgrades
the final answer to **CANNOT RECOMMEND A SLOT**. A slot suggested on top of an
unread queue is worse than no suggestion.

Real output from a repo with no git remote:

```
Open PRs
  UNKNOWN — `gh pr list` failed: no git remotes found
  This is not the same as "no PRs are open", and is not treated as such below.

Next slot
  CANNOT RECOMMEND A SLOT
```

`next` exits non-zero in that case, so a script cannot mistake silence for a slot.

## What counts as a claim

A version is only read out of a branch name or PR title when it *looks like* a
version. `release/1.2.3` claims a slot; `fix-issue-1.2` and
`security/audit-2026-07-29` do not. Being liberal here would have every dated
branch in the repo holding a release.

Sources, in order of authority:

| Source | Command | Authority |
|---|---|---|
| Open PRs | `gh pr list` | **Decides the recommendation.** It is the only source that can see a teammate's work. |
| Local branches | `git branch` | Hint only. Cannot see anyone else. |
| Worktrees | `git worktree list` | Hint only. The portable stand-in for gstack's Conductor-workspace scan — same fact, no editor dependency. |

Local hints appear in the table but never change the recommendation, because a
clean local checkout tells you nothing about what is already in flight.

## Version arithmetic

Three- and four-part versions are both supported (gstack ships four). `nextPatch`
keeps whatever arity it was given, and comparison is numeric — `0.2.0` sorts
before `0.10.0`, which string comparison gets backwards.

## Selftest

```bash
node skills/landing-report/scripts/tb-landing.mjs selftest
```

31 assertions. The load-bearing one asserts that `UNKNOWN` and `KNOWN_EMPTY`
produce *different* recommendations from otherwise identical inputs, and that
the rendered report for an unreadable queue never contains a bare next-version
number anywhere in its text.
