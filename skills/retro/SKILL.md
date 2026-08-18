---
name: retro
version: 0.1.0
description: Weekly retrospective where every number is computed from git rather than estimated by the model. Reports real commit, LOC, test-ratio, session, tag and streak counts per repository, across every repository at once, and refuses to narrate a window it could not measure. Use for "weekly retro", "what did we ship", "what actually landed this week", "how'd we do across all my projects".
triggers:
  - weekly retro
  - retro
  - what did we ship
  - what actually landed
  - engineering retrospective
  - how'd we do this week
  - what did i ship across my projects
  - did i actually ship anything
provides:
  - retrospective
  - shipped-work-audit
  - cross-repo-activity
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - AskUserQuestion
---

# retro

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the weekly window with its `compare` and
`global` modes, the midnight-aligned window rule, the metric set (commits, LOC,
test LOC ratio, active days, sessions detected on a 45-minute commit gap, commit
type mix, hotspot analysis, focus score, shipping streak), the per-author
leaderboard with praise and a single growth area, the tweetable one-liner, the
saved JSON snapshot and the trend table against the previous snapshot all come
from `retro` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). The implementation is a rewrite. Not affiliated
with or endorsed by Garry Tan. See NOTICE.

## Use it

```bash
node ~/.claude/skills/retro/scripts/tb-retro.mjs run                 # this repo, last 7 days
node ~/.claude/skills/retro/scripts/tb-retro.mjs run 14d --fetch     # fetch origin first
node ~/.claude/skills/retro/scripts/tb-retro.mjs run --json          # every number + the argv that produced it
node ~/.claude/skills/retro/scripts/tb-retro.mjs global 7d --root ~/code
node ~/.claude/skills/retro/scripts/tb-retro.mjs scan --root ~/code
node ~/.claude/skills/retro/scripts/tb-retro.mjs trend
node ~/.claude/skills/retro/scripts/tb-retro.mjs gstack-repro        # the four bugs, live
node ~/.claude/skills/retro/scripts/tb-retro.mjs selftest
```

Exit codes: `0` measured, `2` usage error, `3` UNVERIFIED (a ref, a repo or the
clock could not be trusted), `4` NO DATA (the window is empty). gstack's /retro
has no exit code at all, because it is prose.

Windows are `Nh`, `Nd`, `Nw`; `d` and `w` start at local midnight, which is
gstack's rule kept unchanged so the numbers stay comparable. The resolved
absolute range is printed on every run, so a wrong window is visible instead of
inferred.

## The division of labour

**The tool owns the arithmetic. You own the narrative.** Run it, read the
numbers, then write the retro: what the week meant, what to praise, the one
thing to level up. Do not recompute, re-estimate or "roughly" restate any figure
the tool printed, and do not fill a section the tool marked absent.

That split is the whole point of this fork. gstack's /retro hands the agent
twelve shell pipelines and asks it to total 47 commits' worth of `--shortstat`
in its head. Nobody downstream can check that total, and four of those pipelines
are broken on Windows in ways that read as an ordinary week.

## What it will not do

- It never narrates a window it could not measure. Zero commits is `NO_DATA`
  with the newest commit date and the window start printed, exit 4.
- It never invents a ref. A ref that does not resolve is named as a fallback, or
  the run is UNVERIFIED. It never runs `git log origin/main` and lets the `fatal:`
  disappear into a pipeline.
- It never writes into the repository it is measuring. Snapshots go to
  `$TOOLBAY_STACK_STATE_DIR` (default `~/.toolbay-stack/retros/`), not to
  `.context/retros/` where the next `git status` reports them as untracked and
  the next retro counts them as changed files.
- It never fetches unless you pass `--fetch`. A retro should not silently touch
  the network.
- It never goes through a shell. Every git call is an argv array spawned
  directly, which is why a repo at `C:\Users\orion\OneDrive\Desktop\code\chemo game`
  is not a special case.

## Verdicts

| Verdict | Meaning | Exit |
|---|---|---|
| `OK` | every figure came from a git command that exited 0 | 0 |
| `NO_DATA` | the window is empty; no metrics are produced at all | 4 |
| `UNVERIFIED` | a ref, a repo or the clock could not be trusted | 3 |
| `PARTIAL` | global mode: at least one repo failed, and it is named | 3 |

`NO_DATA` and `UNVERIFIED` are deliberately different claims. "There was nothing
to measure" and "the measurement cannot be trusted" produce the same empty
narrative in gstack and must not.

## What is different from gstack, and how to check

Every claim below was reproduced on Windows 11, Git Bash (GNU bash 5.2), git
2.53.0.windows.3, against gstack retro v2.0.0. Run them yourself:

```bash
node ~/.claude/skills/retro/scripts/tb-retro.mjs gstack-repro
```

1. **The stale-window guard cannot fire on a repo with no remote.**
   `SKILL.md:935` is `_RETRO_HAS_REMOTE=$(git remote | grep -c '^origin$' || echo 0)`.
   `grep -c` prints `0` *and* exits 1, so `|| echo 0` runs too and the variable
   holds `0\n0`, which never equals `"0"`. The one branch that exists to say "do
   not trust this window" is unreachable, and the skill goes on to fetch and log
   a ref that cannot exist. Here the absence of `origin` is a printed reason on
   the run.
2. **And a ref that does not exist reads as a quiet week.**
   `git log origin/main ... | grep -v '^$' | sort | uniq -c` puts `fatal:` on
   stderr and exits 0, so all twelve queries return empty and gstack's own Step
   0.5 warns the retro "will fabricate a coherent-looking narrative from
   nothing". Here the ref is verified with `rev-parse --verify` before it is
   used, and a fallback is labelled `[FALLBACK]` in the output.
3. **The record separator is `|`, and commit subjects contain `|`.**
   `--format="%H|%aN|%ae|%ai|%s"` on `fix: handle a|b splitting in parser` yields
   six fields where five were promised, and the subject truncates to
   `fix: handle a`. Here records are NUL-separated and fields are US (0x1F)
   separated, neither of which git can emit inside a subject.
4. **Four of the shell snippets are zsh.** `setopt +o nomatch` at SKILL.md:1269,
   :1296, :1420, :1722 and :1740 is `command not found` (rc 127) in bash,
   silenced by `|| true`, so the `ls .context/retros/*.json` that follows gets
   its own unexpanded glob. The preamble adds `$PPID`, `find -mmin`, `date +%s`,
   `source <(...)` and `open`; global mode writes to `/tmp` and shells out to a
   `bun`-compiled discovery binary that does not exist unless you built gstack
   from source. None of that is on this path.
5. **Binary files are `-` in `git log --numstat`.** gstack's prose never
   mentions it, and an LLM summing a column that contains `-` produces whatever
   it produces. Binary files are counted separately here and excluded from LOC.
6. **One human with two emails is one contributor.** gstack keys authors on
   `%aN`, so changing your git name splits you into two people and halves both
   counts. Identities are merged here, and the merge is disclosed
   (`identities merged: N`, plus the alias emails).
7. **The streak survives a morning.** gstack counts consecutive days backwards
   *from today*, so running the retro before the day's first commit reports a
   32-day streak as 0. The streak is anchored on the last commit day and whether
   it reaches today is stated: `32d through 2026-08-13 (not today)`.
8. **"PRs merged" is called what it is.** gstack greps `#\d+` out of subjects
   and labels the count "PRs merged"; it also counts `fixes #12`. Here the row
   reads `#refs in subj` with the caveat printed next to it, and merge commits
   are counted separately.
9. **Global mode needs no `bun`, no `/tmp`, and no AI-session index.** It walks
   real directories for `.git`, and a repo that cannot be read appears as a
   named UNVERIFIED row that forces the whole run to `PARTIAL`, instead of
   gstack's prose footnote "N repos could not be reached."
10. **A trend across different windows is refused.** Comparing a 7d snapshot
    with a 14d one prints `NOT COMPARABLE` rather than a delta.

## Prove it on this machine

```bash
node ~/.claude/skills/retro/scripts/tb-retro.mjs selftest
```

50 assertions, run against the engine as a child process on real git
repositories built broken on purpose: no remote, no `origin/main`, a `|` and a
quote in the subject, a binary file in the diff, one human under two emails plus
a bot, a directory name with a space, a commit dated in the future, a window
with nothing in it, a `.git` that is not a repository, and a bad window string.
Each must produce the closed answer. It exits non-zero if any assertion fails,
including the assertion that all 50 ran.

## Workflow

1. `scan --root <dir>` if you want the cross-project view and do not know what
   is out there.
2. `run` in the repo (add `--fetch` if the remote matters and you are online).
   Read the verdict line before anything else.
3. On `NO_DATA`: say the window is empty, quote the newest commit date the tool
   printed, offer a wider window. Do not write a retro.
4. On `UNVERIFIED`: lead with the reason. Never present figures from an
   UNVERIFIED run as the week's results without that sentence attached.
5. On `OK`: write the narrative around the printed numbers.
   - **Summary** — the tweetable line, then the SHIPPED block as-is.
   - **Time and sessions** — what the hour histogram and session split mean.
     The tool gives counts; you give the interpretation.
   - **Velocity** — type mix, hotspots, focus score. Flag a fix ratio over 50%.
   - **Quality** — test ratio and its trend. Under 20% is a growth area.
   - **Your week / team breakdown** — from `BY AUTHOR`. For each person: what
     they shipped, 1-2 pieces of specific earned praise anchored in a real
     commit, and exactly one growth opportunity framed as investment.
   - **Top 3 wins**, **3 things to improve**, **3 habits for next week**.
6. `run --save` when the user wants trends, then `trend` next week.
7. Output goes to the conversation. The only file ever written is the snapshot,
   and only with `--save`.

## Tone

gstack's, unchanged: encouraging but candid, specific, anchored in actual
commits, no generic praise, growth framed as leveling up, never compare
teammates against each other. One addition: **do not round a number the tool
printed exactly, and do not soften a `NO_DATA` week into a good one.** A retro
that reports a quiet week honestly is the reason the next one is believable.
