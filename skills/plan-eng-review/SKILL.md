---
name: plan-eng-review
version: 0.1.0
description: Eng manager-mode plan review. Locks the execution plan before anyone writes code — architecture, code quality, tests, performance — then lints the review's own claims against the working tree, so a citation to a file that was renamed last week fails instead of reading as the most convincing line in the report. Use when asked to review the architecture, run an engineering review, or lock in the plan.
triggers:
  - eng review
  - engineering review
  - review the architecture
  - architecture review
  - check the implementation plan
  - lock in the plan
  - technical review
provides:
  - planning-review
  - plan-report-gate
  - review-claim-lint
  - test-coverage-gap-audit
  - parallel-work-planning
platforms:
  - win32
  - darwin
  - linux
cost: high
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Write
  - WebSearch
  - AskUserQuestion
---

# plan-eng-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The review methodology here (eng-manager plan review; the scope
gate; the priority hierarchy; the engineering preferences; the fifteen cognitive
patterns; the documentation-and-diagrams rules; Step 0's scope challenge,
complexity check, search check, TODOS cross-reference, completeness check and
distribution check; the four review sections Architecture / Code Quality / Tests
/ Performance; the test-coverage diagram and its quality rubric; the required
outputs including "NOT in scope", "What already exists", the failure-modes table
and the worktree parallelization strategy; the Completion Summary; the review
log and the exit-plan-mode gate) comes from `plan-eng-review` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The claim lint, the jq-free tasks artifact, the read-the-
directory framework detection, the measured complexity gate and the verified
review record are new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

You are not here to approve this plan. You are here to catch the landmine before
it goes off, while it is still cheap — the plan is the last place a bad
architecture costs an afternoon instead of a quarter.

**Do NOT make code changes. Do NOT start implementing. Review only.**

---

## Scope gate (FIRST — a hard STOP, overrides everything below)

Before anything else in this skill — before Step 1, before any `git`, `Read`,
`Grep`, `Glob` or `Bash` call — your VERY FIRST tool call is AskUserQuestion,
confirming what to review:

> What should I review?
> A) The current branch diff — the work in progress on this branch.
> B) A plan or design doc I'll paste or point you to.
> C) A specific file, directory, or path.

Recommend A when a branch diff exists, otherwise B. If AskUserQuestion is
unavailable, render those three lines as plain prose, each at column 0, then
STOP and wait. Do not explore the repo before the user answers.

## Priority hierarchy

If context compresses: Step 0 > the test diagram > opinionated recommendations >
everything else. Never skip Step 0 or the test diagram. Do not warn about
context limits; compaction is handled for you.

## Engineering preferences

DRY — flag repetition aggressively. Well-tested code is non-negotiable; too many
tests beats too few. "Engineered enough": neither fragile and hacky nor
prematurely abstract. Handle more edge cases, not fewer; thoughtfulness over
speed. Explicit over clever. Right-sized diff — the smallest diff that cleanly
expresses the change, but do not compress a necessary rewrite into a patch. If
the foundation is broken, say "scrap it and do this instead."

**Completeness is cheap.** AI compresses implementation 10-100x. A shortcut that
saves human-hours but saves minutes with CC is not a shortcut worth taking.

## How to think while reviewing

Not a checklist — the instincts. Diagnose which state the work is in (falling
behind, treading water, repaying debt, innovating) because each wants a
different intervention. Judge every decision by blast radius. **Boring by
default**: a company gets about three innovation tokens, everything else should
be proven. Incremental over revolutionary — strangler fig, not big bang; canary,
not global rollout. Systems over heroes: design for a tired human at 3am, not
your best engineer on their best day. Prefer reversibility — flags, A/B,
incremental rollout, so being wrong is cheap. Failure is information, not blame.
Org structure IS architecture (Conway). DX is product quality: slow CI and
painful deploys become worse software. Ask Brooks's question before adding
anything — essential complexity or complexity we created? The two-week smell
test: if a competent engineer cannot ship a small feature in two weeks, that is
an onboarding problem wearing an architecture costume. Make the change easy,
then make the easy change — never structural and behavioural edits at once. Own
your code in production. Error budgets, not uptime targets.

When evaluating architecture, think "boring by default." When reviewing tests,
think "systems over heroes." When a plan introduces new infrastructure, ask
whether it is spending an innovation token wisely.

## Documentation and diagrams

ASCII diagrams are highly valued — data flow, state machines, dependency graphs,
pipelines, decision trees. Use them liberally in the plan, and embed them in code
comments for complex behaviour (models, controllers, services, non-obvious test
setup). **Diagram maintenance is part of the change**: when touching code near an
ASCII diagram, check whether it is still true and update it in the same commit.
Stale diagrams are worse than none — they actively mislead. Flag stale ones you
find even outside this change's scope.

---

## Step 1: Ground the review

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs context --plan <plan-file>
```

It prints the slug, the branch, the design doc, the detected runtime / test
framework / test directories, the measured diff size for Step 0's complexity
gate, and the path to write this review's task artifact to.

| Exit | Meaning |
|---|---|
| 0 | It looked. Anything reported `absent` or `none detected` is a verified nothing-there. |
| 2 | It could not look. **Not** the same as "nothing found" — do not skip test generation, and do not assume there is no design doc, on the strength of a lookup that failed. |

If a design doc exists, read it: it is the source of truth for the problem
statement, constraints and chosen approach. If it has a `Supersedes:` field, this
is a revision — check the prior version for what changed and why.

### Why this is a command

gstack detects the test framework with a block that opens `setopt +o nomatch`
(a zsh builtin; bash answers `setopt: command not found`) and then asks
`ls jest.config.* vitest.config.* … 2>/dev/null` and `ls -d test/ tests/ spec/ …
2>/dev/null`. On a no-match that prints nothing, with the error thrown away —
byte-identical to a directory it had no permission to read. The very next
instruction branches on the result: *"If no framework detected: still produce the
coverage diagram, but skip test generation."* So a failed listing silently
downgrades the review. Measured on Windows 11, 2026-08-14, in bash:

```
$ bash gstack-detect.sh    # in a tree with no framework
(no output)
$ bash gstack-detect.sh    # first line, on this machine
setopt: command not found
```

Step 0's complexity check has the same shape: gstack says "if the plan touches
more than 8 files … treat that as a smell", and the count comes from eyeballing
the plan's prose. Here it is `git diff --name-only <base>...HEAD`, counted, with
the base branch resolved — and when git cannot answer it prints `UNDETERMINED`
rather than a number the review would then act on.

---

## Step 0: Scope challenge

> The Scope gate above is a hard STOP. Do not run Step 0 until the user has
> answered it, and run it against the target they chose.

1. **What already solves this?** Which existing code partially or fully solves
   each sub-problem? Can you capture outputs from an existing flow instead of
   building a parallel one?
2. **What is the minimum set of changes** that achieves the stated goal? Be
   ruthless about scope creep; flag anything deferrable.
3. **Complexity check.** More than 8 files, or more than 2 new
   classes/services, is a smell. Step 1 printed the measured file count.
4. **Search check.** For each architectural pattern, infrastructure component or
   concurrency approach the plan introduces: does the runtime have a built-in
   ("{framework} {pattern} built-in")? Is this current best practice
   ("{pattern} best practice {year}")? Known footguns ("{framework} {pattern}
   pitfalls")? A custom solution where a built-in exists is a scope reduction
   opportunity. If WebSearch is unavailable, say "Search unavailable —
   proceeding with in-distribution knowledge only" rather than implying you
   looked.
5. **TODOS cross-reference.** Read `TODOS.md` if present. Anything deferred that
   blocks this plan? Anything bundleable without expanding scope? Any new work
   this plan creates that should be captured?
6. **Completeness check.** Is this the complete version or a shortcut? See
   "Completeness is cheap".
7. **Distribution check.** New artifact type (CLI binary, package, container,
   mobile app)? Then the build/publish pipeline, the target platforms and the
   install path are part of the plan, or they go in "NOT in scope" explicitly.
   Code without distribution is code nobody can use.

**If the complexity check triggers, STOP before any review section.** Call
AskUserQuestion: name what is overbuilt, propose a minimal version that achieves
the core goal, ask whether to reduce or proceed as-is. That is a tool_use, not
prose. Do not proceed to Section 1, do not edit the plan with a proposed
reduction, and do not call ExitPlanMode until the user responds. Naming the 80%
solution in chat and continuing is exactly the failure this gate exists for.

Once the user accepts or rejects a scope reduction, **commit fully**. Do not
re-argue for smaller scope in later sections, and never silently reduce scope or
drop a planned component.

---

## Step 2: The four review sections

> **STOP.** Read `~/.claude/skills/plan-eng-review/sections.md` in full and
> execute it. Do not work from memory — that file is the source of truth for the
> four sections, the test-coverage diagram, the required outputs and the
> Completion Summary.

---

## Step 3: Write the implementation tasks

Synthesize the findings into a flat task list. Each task derives from a specific
finding; do not pad. Emit the markdown, then write the artifact — one call per
task, to the path Step 1 printed:

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs task \
  --file <tasksFile> --id T1 --priority P1 --component <component> \
  --title "<imperative title>" --source-finding "<section + finding>" \
  --files src/a.ts,src/b.ts --effort-human 2h --effort-cc 15m
```

Zero tasks is a real result and must still be written:

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs task --file <tasksFile> --none
```

P1 blocks ship, P2 lands same branch, P3 is a follow-up TODO. A record missing
its source finding is refused rather than written: a half-filled task becomes a
checkbox in the final gate that nobody can act on.

### Why this is a command

gstack builds this artifact with `jq -nc --arg … >> "$TASKS_FILE"`, and its
documented fallback is to skip the write. On Windows 11, 2026-08-14:

```
$ command -v jq || echo "JQ: ABSENT"
JQ: ABSENT

$ jq -nc --arg id 'T1' '{id:$id}' >> "$TASKS_FILE"
bash: jq: command not found
$ echo "exists: $([ -f "$TASKS_FILE" ] && echo YES); bytes: $(wc -c < "$TASKS_FILE")"
exists: YES; bytes: 0
```

The artifact is not missing. The shell creates the redirect target before jq
fails, so it exists and is **empty** — and gstack's own text defines what empty
means: *"an empty file means 'ran, no findings' — distinct from 'didn't run'"*.
Every task this review surfaced is dropped, and the drop is indistinguishable
from a review that found nothing. Here empty is only reachable through `--none`,
and Node's `JSON.stringify` does the escaping that "never hand-roll JSONL" was
rightly warning about.

---

## Step 4: Lint the review's own claims

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs lint \
  --plan <plan-file> --root <repo-root>
```

| Exit | Meaning |
|---|---|
| 0 | Every claim holds. Citations resolved; the notes say how many. |
| 1 | It names the unsupported claims. Fix them — usually by opening the file you cited. |
| 2 | The plan or the repo root could not be read. A citation check that could not look is not a citation check that passed. |

It checks four things, none of which gstack checks anywhere:

1. **Every `file.ext:NN` the review cites resolves** — the file exists in the
   tree and has at least NN lines.
2. **The test-coverage diagram is a diagram**, not a paragraph describing one.
3. **The critical-gap count matches the body.** "Failure modes: 0 critical gaps
   flagged" over a body that flags one fails, and so does a count with no flag
   anywhere.
4. **The lane count matches the lanes written**, and two lanes called parallel
   while naming the same module directory fail unless a conflict is flagged.

### Why this is a command

An eng review's output is almost entirely claims about code that exists right
now: "N+1 in `app/models/order.rb:88`", "already covered by
`spec/billing_spec.rb:214`", "Lane A and Lane B are independent", "0 critical
gaps". A citation is the most persuasive sentence in the report and the cheapest
one to invent, because nothing downstream ever opens the file. Line 214 of a
140-line spec reads exactly like line 214 of a 400-line one.

gstack's rule 4 for the parallelization strategy is *"if two parallel lanes touch
the same module directory, flag it"* — asked of the model, about lanes the model
wrote a paragraph earlier. The lanes are labelled and the modules are written as
directories, so both halves of that rule are arithmetic.

---

## Step 5: The gate

Before ExitPlanMode, and before any review record:

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs gate \
  --plan <plan-file> --tasks <tasksFile> --root <repo-root>
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every check passed | ExitPlanMode is allowed. |
| 1 | It names what is missing | Produce it and run again. Do **not** call ExitPlanMode. |
| 2 | The plan file could not be read | Refuse. A gate that cannot read the thing it checks does not pass it. |

It checks that the report exists, that it is the LAST `##` heading, that its
Runs / Status / Findings table has a filled row rather than a header or a row of
em dashes, that a VERDICT line is present, that the final non-whitespace line is
the unresolved-decisions status (the exact unbolded `NO UNRESOLVED DECISIONS`,
or the last bullet of a `**UNRESOLVED DECISIONS:**` block), that "NOT in scope",
"What already exists", the failure modes and a real test-coverage diagram are on
the page, that the Completion Summary has no `___` blanks left, that the tasks
artifact is really on disk, and the four claim checks from Step 4.

### Why this is a command

gstack's equivalent is "EXIT PLAN MODE GATE (BLOCKING)": five items the model
verifies about its own output. Nothing runs. The same file names the failure it
cannot catch — *"Self-deception failure mode to watch for: feeling 'done' after
writing review prose into the plan body. The body prose is not the report."* The
entity being asked whether it is done is the entity that feels done. Its item 4
is the fiddliest rule in the skill (a bolded `**NO UNRESOLVED DECISIONS**` must
fail; trailing prose after the sentinel must fail), which is precisely what
self-inspection waves through and a regex cannot be talked out of.

## Step 6: Record the review

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs record \
  --plan <plan-file> --root <repo-root> --mode FULL_REVIEW \
  --unresolved N --critical-gaps N --issues-found N
```

Re-runs the gate and writes nothing unless it passes. The record carries
`verified: true`, `citations_checked`, and the ids of the checks that ran, so a
downstream reader can tell a proven review from an asserted one.

gstack's Review Log step sits **before** its exit gate and is unconditional, so a
review that never produced a report still leaves a record that `/ship`'s
readiness dashboard reads as the completed eng review — the one /ship treats as
required.

## Then chain

Recommend `/plan-design-review` if any section touched frontend components, CSS,
views or user-facing flows and no design review exists. Mention
`/plan-ceo-review` only if this introduces new user-facing features or changes
product direction — a soft suggestion, not a push. Note staleness if this review
found assumptions that contradict an existing CEO or design review. Otherwise:
"All relevant reviews complete. Run /ship when ready."

## Prove the checks work

```bash
node ~/.claude/skills/plan-eng-review/scripts/tb-eng-review.mjs selftest
```

Runs this executable as a child process against a plan with review prose and no
report, a report buried above an appendix, a findings table with no filled row,
a bolded sentinel, trailing prose after the sentinel, a missing required output,
a Completion Summary still holding its `___` blanks, a prose paragraph standing
in for the test diagram, a citation to a file that was renamed, a citation past
end-of-file, a "0 critical gaps" summary over a body that flags one, a lane
count that does not match the lanes, two "parallel" lanes editing the same
directory, and a plan file that does not exist. Exits non-zero if any of them is
accepted.

## Mode

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief plan-eng-review
```

Follow the lines it prints. Where they disagree with the defaults above, the mode
wins. Two things the mode never gets to loosen: a claim still needs evidence you
actually produced, and no scope changes without the user's explicit opt-in.

If the modes layer is not installed, run this skill exactly as written.
