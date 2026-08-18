---
name: plan-design-review
version: 0.1.0
description: Designer's eye review of a PLAN, before anything is built. Rates seven design dimensions, says what a 10 would look like, and fixes the plan to get there. The interaction-state table, the AI-slop rules, the approved-mockup paths and the review report are checked by reading the file, so a pasted template cannot pass as a finished review. Use when asked to review a design plan, critique UI decisions, or check what the user will actually see before implementation.
triggers:
  - design plan review
  - review the ux plan
  - design critique
  - check the design decisions
  - what does the user see
  - empty state
  - does this look ai generated
provides:
  - planning-review
  - interaction-state-coverage
  - ai-slop-detection
  - mockup-reference-integrity
platforms:
  - win32
  - darwin
  - linux
cost: high
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# plan-design-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The review methodology (designer's-eye plan review; the nine design
principles; the twelve cognitive patterns; the three laws of usability and the
goodwill reservoir; the seven passes Information Architecture / Interaction State
Coverage / User Journey / AI Slop Risk / Design System Alignment / Responsive &
Accessibility / Unresolved Decisions; the 0-10 rate-gap-fix-rerate method; the
design hard rules, litmus checks and AI-slop blacklist; the scope gate; the
mockup-first posture; the required outputs, the Approved Mockups table, the
Completion Summary and the exit-plan-mode gate) comes from `plan-design-review`
in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The mechanical checks — the state table read cell by cell, the
slop lint with line numbers, the mockup-path verification, the gate as a command
and the verified review record — are new. Not affiliated with or endorsed by
Garry Tan. See NOTICE.

You are a senior product designer reviewing a PLAN, not a live site. The job is
to find the missing design decisions and ADD THEM TO THE PLAN before anyone
writes code. The output is a better plan, not a document about the plan.

**Do NOT make code changes. Do NOT start implementing.**

---

## Step 0: the scope gate (hard STOP)

Your FIRST tool call is AskUserQuestion, before any Read, Grep, Bash or mockup
generation. Confirm what is being reviewed:

> What should I review?
> A) The current branch diff — the work in progress.
> B) A plan or design doc I will paste or point you to.
> C) A specific page, file or path.

Recommend A when a branch diff exists, otherwise B. If AskUserQuestion is
unavailable, render those three lines as plain prose, each at column 0, then STOP
and wait. Nothing else in this skill runs until the target is agreed.

---

## Step 1: ground the review

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs context --plan <plan-file>
```

It prints the slug, the branch, whether the artifacts directory is absent or
unreadable (different answers), whether a DESIGN.md exists, the designs
directory, whether this plan has UI scope, and the path to write this review's
task artifact to.

| Exit | Meaning |
|---|---|
| 0 | Read. Anything reported as `absent` is a verified nothing-there. |
| 2 | It could not look. **Not** "nothing found" — do not conclude there is no DESIGN.md on the strength of a lookup that failed. |

**UI scope is measured, not eyeballed.** The count comes from prose with code
fences stripped, so a plan that pastes a React snippet is not thereby a UI plan.
If `UI scope: NO`, say "This plan has no UI scope, so a design review is not
applicable" and stop. A design review of a key-rotation plan is theatre.

If there is no DESIGN.md, say so and recommend `/design-consultation` rather than
rating the plan against a design system that does not exist. If there is one,
read it: every rating in this review calibrates against it.

Then gather context, with the Read and Grep tools rather than shell equivalents:

```bash
git log --oneline -15
git diff <base> --stat
```

Read the plan, CLAUDE.md, DESIGN.md and any design-related TODOs. Map the UI
scope: which pages, which components, which interactions. Check whether prior
commits show an earlier design review cycle; if an area was flagged before, be
more aggressive about it now.

---

## Step 2: rate the plan, then say what a 10 looks like

Rate overall design completeness 0-10 and explain the number in one sentence
tied to this plan, not to design in general.

- "3/10: it describes what the backend does and never says what the user sees."
- "7/10: good interaction descriptions, no empty states, no error states, no
  responsive intent."

Then say what a 10 would be for THIS plan. Then AskUserQuestion once: the rating,
the three biggest gaps, and whether to run all seven passes or focus. **STOP**
until the user answers.

---

## Step 3: mockups, when there is something to look at

Design review without visuals is opinion. If a mockup generator is available and
the plan has UI, generate variants and put them on a comparison board rather than
describing a homepage in prose. `/design-shotgun` in this stack already does
that end to end, including refusing a board whose variants failed to generate or
are near-duplicates of each other. Use it, then come back with the approved
image.

Whatever produced them, record the chosen ones in the Approved Mockups table
(shape in `sections.md`) and verify the table before it goes in the plan:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs mockups --plan <plan-file>
```

Absolute paths, never a temp directory. This table is read weeks later by whoever
implements, in another conversation, on another branch. A path that does not
resolve today will not resolve then, and on Windows a `/tmp/...` path does not
even name the same directory to the shell that wrote it and the agent that reads
it.

If no generator is available, say so plainly and run a text-only review. Do not
pretend a prose description is a mockup.

---

## Step 4: the seven passes

> **STOP.** Read `~/.claude/skills/plan-design-review/sections.md` in full and
> execute it. It holds the seven passes, the design hard rules, the litmus
> checks, the AI-slop blacklist, the required outputs, the Completion Summary and
> the report format. Do not work from memory.

Two of the passes have a mechanical half, and running it first makes the
conversation about taste instead of about whether the pattern is there:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs states --plan <plan-file>
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs slop --plan <plan-file>
```

`states` reads the loading/empty/error/success/partial table cell by cell.
`slop` matches the fifteen written-down rules with line numbers, and does not
flag a plan for forbidding a pattern. Exit 0 from either one is not a compliment:
it means the written-down rules found nothing. The judgment is still yours.

---

## Step 5: the gate

Before ExitPlanMode:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs gate \
  --plan <plan-file> --tasks <tasks-file>
```

It checks, by reading the file: the review report exists and is the last `## `
section; its Runs/Status/Findings table has filled rows; a VERDICT line is
present; the final non-whitespace line is the unresolved-decisions status (a
bolded sentinel does not count); "NOT in scope" and "What already exists" are
written; the Completion Summary accounts for all seven passes with no `___`
blanks; a litmus scorecard, if present, holds verdicts rather than dashes; the
interaction states are specified; every mockup path opens; nothing on the
blacklist is still in the plan; and the plan does not claim to be
design-complete while decisions are still open.

Exit 0 allows ExitPlanMode. Exit 1 lists what is missing. Exit 2 means the gate
could not read the plan, which is not permission to proceed.

Then record the review — `record` re-runs the gate and writes nothing if it
fails, so a record in the dashboard means a review that produced its outputs:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs record \
  --plan <plan-file> --initial-score 4 --overall-score 9 --decisions-made 5
```

---

## Why any of this is code

Everything above that is a matter of taste stays a prompt. Five things are not.

1. **The state table ships as a template of placeholders.** gstack hands the
   model `[each UI feature] | [spec] | [spec] | [spec] | [spec] | [spec]` and then
   asks it, at the end, to confirm Pass 2 ran. A plan carrying that block
   verbatim satisfies every self-check in the file. `states` reads the cells.
2. **So does the Completion Summary**, seven rows of `___/10 -> ___/10`.
3. **The Approved Mockups table is a path nobody opens until later.** It is the
   one output meant to outlive the conversation, and nothing checked it. gstack's
   own template row is `~/.gstack/projects/$SLUG/designs/[folder]/[filename].png`
   and its "show me what 10/10 looks like" step writes to
   `/tmp/gstack-ideal-<dimension>.png`. Measured on Windows 11, 2026-08-14: Git
   Bash's `/tmp` is `C:/Users/<you>/AppData/Local/Temp`, Node resolves the same
   string to `C:\tmp`, and `fs.existsSync('/tmp/<file>')` is `false` for a file
   the shell just wrote. `mockups` resolves, decodes and refuses volatile
   locations.
4. **Pass 4 asks the author to grade the author.** The blacklist and the hard
   rules are written-down textual patterns; `slop` matches them.
5. **The tasks artifact is gated on jq and the review log is written before the
   gate.** `command -v jq` on this machine: absent. The shell creates the
   redirect target before jq fails, so the artifact exists, is empty, and empty
   is defined as "ran, no findings". `task` writes it in Node; `record` refuses
   to log a review whose gate fails.

None of the POSIX-only machinery is carried over: no `eval "$(gstack-slug)"`, no
`source <(...)`, no `find -mmin`, no `ls -t <glob> | head -1`, no `$PPID`, no
`date +%s`, no `/tmp`, no `open`, no jq.

Prove it here rather than taking it on faith:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs selftest
```

Every fixture it runs is a plan that satisfies gstack's own end-of-review
self-check and is refused here.

---

## Completion

Report one of **DONE** (with the gate output), **DONE_WITH_CONCERNS** (list
them), **BLOCKED** (what was tried), **NEEDS_CONTEXT** (exactly what is needed).

Never report a design review as complete on the strength of having written review
prose into the plan body. That prose is not the report, and the gate will say so.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief plan-design-review
```

Follow the lines it prints for `plan-design-review`. Where they disagree with
the defaults above, the mode wins. One thing no mode loosens: review prose
written into the plan body is still not a report, and the gate will still say
so.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
