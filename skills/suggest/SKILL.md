---
name: suggest
version: 0.1.0
description: Look at the project as it is right now (what changed, what is uncommitted, whether there are tests, whether it is a fresh repo, what the last commit said) and say what is worth doing next, in plain language, with the reason. Names the command to run but never runs it, and says "nothing worth suggesting" when that is the truth. Use when someone asks what to do next, where to start, what needs doing, or opens a project cold.
triggers:
  - what should i do next
  - what next
  - where do i start
  - what needs doing
  - suggest something
  - what would you do next
provides:
  - next-step-suggestion
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# suggest

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original work. It ships inside the skill-per-directory layout of
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan) and sits alongside skills forked from it, but gstack has no
suggestion layer and no code or contract here is derived from it. Not affiliated
with or endorsed by Garry Tan. See NOTICE.

Reads the project's actual state and tells you what is worth doing next. It does
not do it.

## Use it

```bash
node ~/.claude/skills/suggest/scripts/tb-suggest.mjs
```

That is the whole thing. No arguments, no setup, no config file. Run it in any
directory, including one that is not a repository.

```
  Where this project is right now

    branch       main (no upstream)
    changes      1 modified, 4 new, +1/-0 lines
    last thing   "add the first test" just now
    tests        1 test file(s)

  What I would do next

  1  Look over the 5 changed files before this grows
     /review
     1 tracked file modified, 4 new, +1/-0 lines, all since "add the first
     test" just now. A diff is cheapest to read while you still remember why
     you wrote it.

  2  Look at what the UI actually does now (1 interface file changed)
     /browse
     src/panel.tsx changed. Interface changes are the ones that compile
     perfectly and still look wrong, and the only way to know is to open the
     page.
```

Add `--json` for the same thing machine-readable, `--quiet` to drop the state
summary, `state` to see only what it can observe, `selftest` to prove the
degraded paths.

## The mode decides what comes out of here

This is the skill where the stance is most visible. Same repository, same
uncommitted files, four different answers:

```bash
node ~/.claude/skills/suggest/scripts/tb-suggest.mjs --mode ship   # preview a stance
node ~/.claude/skills/suggest/scripts/tb-suggest.mjs              # use the active one
```

| Mode | What it offers |
|---|---|
| `SHIP` | One thing to do, and it is the one that gets this deployed |
| `CRAFT` | What is unfinished: the untested path, the unreviewed diff |
| `WILD` | The fastest way to find out if it works. Nothing about tests or structure |
| `LOCK` | What is unverified, first, every time |

Each rule carries a **kind** (`blocked`, `safety`, `review`, `test`, `verify`,
`ship`, `hygiene`, `docs`), and each mode weights the kinds it cares about in
`skills/modes/modes.json`. Nothing about those weights is in this file, so
retuning what your stack suggests is an edit to one JSON block, not a code
change.

Every drop is printed under the suggestions with the kind and the weight that
caused it. A layer that quietly deletes suggestions is indistinguishable from a
layer that had nothing to say.

**Two kinds cannot be suppressed by any mode at any weight:** `blocked` (a
conflict you are standing in, a repository git will not open) and `safety` (a
credential about to be committed, work no branch can reach). A stance is a
preference about work. A leaking secret is not a preference. Those two print on
top of the mode's cap rather than consuming it, so asking SHIP for one thing to do
never means the alarm is the one thing and the actual advice went unprinted. A
`modes.json` that tries to weight them down is read, reported, and ignored.

With no modes layer installed, or with a broken one, suggestions rank exactly as
they did before the layer existed. Broken never silently means loose.

## What it will not do

**It never runs anything.** Not the commands it suggests, not a formatter, not
a test. The only commands it executes are read-only git queries, all of them
through `git --no-optional-locks` so that observing the project cannot even
rewrite the index, and it prints the exact list at the bottom of every run so
the claim is checkable rather than promised:

```
git --no-optional-locks rev-parse --is-inside-work-tree
git --no-optional-locks rev-parse --absolute-git-dir
git --no-optional-locks status --porcelain=v1 --branch --untracked-files=all
git --no-optional-locks log -1 --format=%H%x00%s%x00%ct%x00%an
git --no-optional-locks diff --numstat HEAD
git --no-optional-locks stash list
```

No writes. No network. Suggesting and acting are different jobs with different
blast radii, and this is the harmless one.

**It will tell you there is nothing.** A clean tree, nothing unpushed, nothing
pending:

```
  Nothing worth suggesting

    I checked:
      - uncommitted and untracked files
      - conflicts and half-finished merges, rebases and cherry-picks
      - unpushed and un-pulled commits
      - credential-shaped files about to be committed
      - whether a test suite exists, and whether this change touches it
      - when the last commit was, and what it said
      - stashes

    None of it turned up anything that needs doing. Inventing a task here
    would waste your time, so: nothing.
```

That case exits `4`, so a script can tell "nothing to do" from "I had
suggestions". Every "what should I do next" feature dies the same way: it always
has an answer, because always having an answer looks smart, and a week later
nobody reads it. Every suggestion here carries the observation that produced it,
and anything that cannot show its evidence is dropped rather than padded out.
Three suggestions is the hard maximum. A list of eight is a backlog.

## It does not keep a list of skills

The suggestions are written in English, *"review my changes before I merge
them"*, and `/router` turns them into commands, using the same catalog read off
the same disk in the same mode as any other routed request. `suggest` imports
the router; it does not copy it.

So it cannot recommend a skill you have not installed, cannot miss one you have,
and cannot go stale when a skill is renamed. If a suggestion comes back with no
command attached, that is the honest outcome: the thing is worth doing and no
installed skill covers it. If the router is missing entirely, the suggestions
still print, without command names, and the footer says so.

## Reading it

| Exit | Meaning |
|---|---|
| 0 | There is something worth doing, and it is printed |
| 2 | The working directory itself could not be read |
| 3 | Observation was incomplete. It said so and printed what it had |
| 4 | Verified: nothing worth suggesting |

Exit 3 is the one that matters. It means git could not be trusted here, so
anything you read below it is partial. **Never report exit 3 as "the project
looks fine."** It is the difference between *nothing is wrong* and *I could not
see*.

## The states it has to survive

A suggestion engine gets opened at the worst moment: a fresh clone, a broken
repo, a folder that is not a repo at all. Those are not error paths, they are
Tuesday. All four are covered by the selftest:

```bash
node ~/.claude/skills/suggest/scripts/tb-suggest.mjs selftest
```

| State | What it does |
|---|---|
| Not a git repository | Says the folder is untracked, and that nothing can be compared or undone. Empty folder: says nothing. |
| Repository with no commits | Suggests the first commit, and does not try to diff against a HEAD that does not exist |
| Repository with no changes | "Nothing worth suggesting", with the list of what it checked |
| Repository git will not open | Quotes git's own error, refuses to report a branch or a last commit it never read, and says everything else is unknown |

Also covered: a half-finished merge, a `.git` that is a dangling pointer file,
a missing object store, an untracked `.env`, and a new directory of files. git
collapses that last one to a single `src/` entry by default, which silently
hides four files from every rule that reads file names.

## What it notices

Roughly in the order it will bring them up: unresolved conflicts, an operation
git is halfway through, credential-shaped files about to be committed, a change
big enough to want a second pair of eyes, unpushed commits on a clean tree, an
upstream that has moved on, interface files changed with no one having looked at
the page, a source change with no test in it, a project with no test suite at
all, a branch that has sat untouched for weeks, and forgotten stashes.

The weights are in `scripts/tb-suggest.mjs`, near the top of `suggestions()`,
one `add(weight, headline, reason, ask)` per rule. Change them, delete the rules
you disagree with, add your own. A rule is four arguments, and the `ask` is the
English sentence the router routes.
