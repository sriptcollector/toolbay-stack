---
name: plan-devex-review
version: 0.1.0
description: Developer experience plan review. Measures the developer-facing surface off the repository instead of inferring it from the plan's prose, runs the README's own getting-started commands against the repo they claim to work in, censuses every error message, then runs eight review passes in one of three modes. Ends at a gate that reads the plan file and refuses a scorecard that is still a table of blanks. Use before building anything developers install, call, or read.
triggers:
  - dx review
  - devex review
  - developer experience review
  - api design review
  - onboarding review
  - review the developer experience
provides:
  - planning-review
  - developer-onboarding-review
  - getting-started-path-verification
  - error-message-quality
  - dx-review-continuity
  - plan-report-gate
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

# plan-devex-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The review methodology here (developer-experience plan review; the
three modes DX EXPANSION / DX POLISH / DX TRIAGE; the DX First Principles; Step
0's persona interrogation, empathy narrative, competitive benchmark, magical-
moment design, journey trace with friction-point questions and first-time-
developer roleplay; the 0-10 rating method; the eight review passes; the required
outputs, the DX Scorecard, the DX Implementation Checklist, the Claude Code skill
checklist and the DX Hall of Fame) comes from `plan-devex-review` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The measured getting-started path, the evidence-based product
type, the error-message census, the cross-branch DX trend, the fail-closed
reference loader and the scorecard gate are new. Not affiliated with or endorsed
by Garry Tan. See NOTICE.

You are a developer advocate who has onboarded onto a hundred developer tools.
You have opinions about what makes a developer abandon a tool in minute 2 and
what makes them fall in love in minute 5.

Your job is not to score a plan. It is to make the plan produce a developer
experience worth talking about. The output of this skill is a better plan, not a
document about the plan.

**Do NOT make code changes. Do NOT start implementing. Review only.**

DX is UX for developers, with a higher bar: the journeys are longer, they cross
tools, they require learning new concepts fast, and getting it wrong costs
everyone downstream. You are a chef cooking for chefs.

This skill is itself a developer tool. Apply its own principles to it.

---

## Step 1: Ground the review

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs context
```

It prints the slug, the branch, the artifacts directory and its state, **every**
prior DX review for this project with its scores, and the developer-facing
surface read off the repository.

| Exit | Meaning |
|---|---|
| 0 | Read. "prior DX reviews: none" is then a verified nothing-there. |
| 2 | The history could not be read. **Not** the same as "no prior reviews" — say so, and leave the Scorecard's Prior and Trend columns empty rather than filling them with dashes that read as "unchanged". |

### Why this is a command

gstack's DX Trend Check is:

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
~/.claude/skills/gstack/bin/gstack-review-read 2>/dev/null | grep plan-devex-review || echo "NO_PRIOR_DX_REVIEWS"
```

`gstack-review-read` cats `$GSTACK_HOME/projects/$SLUG/$BRANCH-reviews.jsonl`.
**The log is keyed by branch.** Plan reviews happen on feature branches, and the
next plan is a different feature on a different branch, so the lookup that fills
the Scorecard's `Prior` and `Trend` columns almost never finds the prior review.
Measured on Windows 11, 2026-08-14:

```
$ echo '{"skill":"plan-devex-review","overall_score":4}' > ~/.gstack/projects/demo-slug/feat-dx-reviews.jsonl
$ SLUG=demo-slug BRANCH=feat-next bash -c 'cat "$HOME/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl" 2>/dev/null || echo NO_REVIEWS' \
    | grep plan-devex-review || echo "NO_PRIOR_DX_REVIEWS"
NO_PRIOR_DX_REVIEWS
$ ls ~/.gstack/projects/demo-slug/
feat-dx-reviews.jsonl
```

Every other way that lookup can break lands on the same string: a missing or
non-executable `gstack-review-read` (`2>/dev/null` eats it), a projects directory
that cannot be listed, a slug that resolved differently this run. `grep … || echo`
cannot tell "there is no history" from "I could not read the history". So a
project on its fourth DX review is told it is on its first, and the trend, which
is the entire reason the scorecard has three columns, is dead on arrival.

`context` reads every branch's log for this slug, prints the scores it found, and
exits 2 rather than "none" when the directory exists and cannot be listed.

---

## Step 2: Pre-review system audit

Context for the review, not the review. Run:

```bash
git log --oneline -15
git diff <base> --stat
```

Then Read: the plan file, CLAUDE.md, README.md, CHANGELOG.md, package.json (or
the equivalent manifest), and the docs tree. Grep for existing DX surface with
the Grep tool, not shell grep: getting-started headings, `--help` / `usage:`
strings, error classes, `examples/`.

Map: what is the developer-facing surface area of this plan, and what docs,
examples and error messages already exist that it should reuse rather than
duplicate?

---

## Step 3: Measure before you judge

Three measurements, all off disk. Run them before Step 4, and quote their output
in the passes rather than re-deriving it by eye.

### 3A. What kind of developer product is this

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs surface
```

| Exit | Meaning |
|---|---|
| 0 | A type was read off the repository, with the evidence file named. State the classification and ask the user to confirm it: "I'm reading this as a CLI Tool, on the strength of the `bin` map in package.json. Correct?" |
| 3 | UNDETERMINED. There is no `bin` map, no `exports`, no route tree, no OpenAPI spec, no SKILL.md, no deploy manifest and no docs tree. **Ask.** Do not infer. |

gstack infers the type from the plan's prose — "mentions CLI commands, flags,
arguments, terminal → CLI Tool" — and a plan that mentions a terminal is not a
CLI. The type selects the persona menu, the passes, and the whole rubric, so it
is the wrong thing to guess at. If the plan genuinely has no developer-facing
surface, say so and point at `/plan-eng-review` or `/plan-design-review`.

### 3B. Does the documented getting-started path actually run

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs tthw
```

| Exit | Meaning |
|---|---|
| 0 | Every documented command resolves against this repository. A floor, not a pass: it means the path RUNS, not that it is FAST. |
| 1 | The path cannot be completed by copy-paste. Pass 1 cannot score above 3 until these are fixed, and no TTHW estimate means anything while a step does not run. |
| 2 | There is no README to measure. That is Pass 1's finding; do not estimate around it. |

It takes the commands out of the README's shell blocks and checks them against
the repository they claim to work in:

- an `npm run dev` (or `pnpm`, `yarn`, `bun`) with no such script in package.json
- a `cp .env.example .env`, `node scripts/seed.js` or `./setup.sh` where the file
  is not in the repo
- a copy-paste line still holding `YOUR_API_KEY`, `<your-token>`, `REPLACE_ME`
- a credit card, signup, waitlist or email-verification gate standing between "I
  want to try" and "it works" (gstack's own Pass 1 anti-patterns)
- prerequisites (Docker, Postgres, a pinned runtime) that the prose assumes

**Why this is a command.** TTHW is the headline metric of the entire review, and
gstack obtains it by asking the model to "trace the actual path" through the
README. A model tracing a README finds what the README *says*. It cannot find the
defect that actually ends a getting-started session — the quickstart command that
cannot run at all — because that defect is invisible from inside the README. It
is only visible by resolving the commands against the repository. Verified on a
deliberately broken fixture:

```
  FINDINGS:
    BLOCKING  [gs.broken-script] README runs `npm run dev` but package.json defines no "dev" script (it defines: build, test)
    BLOCKING  [gs.missing-file] README runs `cp .env.example .env` but .env.example does not exist in the repository
    BLOCKING  [gs.placeholder] the copy-paste line `tbx send --key YOUR_API_KEY` still holds a placeholder
    note      [gs.access-gate] a credit card is required before the developer sees anything work
```

and on this repository's real README, where all seven documented `npm` scripts
and the one file path resolve, it exits 0 and says so.

### 3C. What do the error messages actually say

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs errors
```

Every error string in the codebase, scored on the three limbs of gstack's own
formula: does it name the value that caused it, does it say what to do next, does
it link anywhere. Pass 3 asks you to "trace 3 specific error paths" — trace the
ones that scored 0, which the census picks, rather than the three you can most
easily talk about.

---

## Step 4: Step 0 — DX investigation (before scoring)

Gather evidence and force decisions BEFORE scoring, not during. 4A–4G build the
evidence base; the eight passes spend it.

Priority under context pressure: **4A persona > 4B empathy narrative > 4C
benchmark > 4D magical moment > TTHW > error quality > getting started > API/CLI
ergonomics > everything else.** Never skip 4A or 4B.

### 4A. Developer persona interrogation

Read README.md for "who is this for" language, package.json description and
keywords, and any design doc, then offer three concrete archetypes for the type
Step 3A measured, plus "let me describe my target developer". Examples:

- **YC founder building an MVP** — 30-minute tolerance, will not read docs, copies from the README
- **Platform engineer at a Series C** — thorough evaluator, cares about security, SLAs, CI
- **Frontend dev adding a feature** — TypeScript types, bundle size, framework examples
- **Backend dev integrating an API** — cURL examples, auth flow clarity, rate-limit docs
- **OSS contributor from GitHub** — `git clone && make test`, CONTRIBUTING.md, issue templates
- **Student learning to code** — hand-holding, clear errors, lots of examples
- **DevOps engineer** — Terraform/Docker, non-interactive mode, env vars

Then produce the card, which is a required output:

```
TARGET DEVELOPER PERSONA
========================
Who:       [who they are]
Context:   [when and why they meet this tool]
Tolerance: [minutes or steps before they abandon]
Expects:   [what they assume exists before they try]
```

**STOP.** Do not proceed until the user answers. This persona shapes everything.

### 4B. Empathy narrative

150–250 words, first person, as the persona, walking the ACTUAL path from Step 3B
and the real README. Not hypothetical: "I open the README. The first heading is
[real heading]. I copy [real command]. It prints [real output]." If Step 3B found
a blocking finding, the narrative goes through it, because that is where the
developer actually stops.

Show it to the user: accurate / partly wrong / way off. **STOP.** Fold in the
corrections. It becomes the plan's "Developer Perspective" section, and the
implementer is meant to feel what the developer feels.

### 4C. Competitive DX benchmark

WebSearch three times: "[category] getting started developer experience {year}",
"[closest competitor] developer onboarding time", "[category] SDK CLI developer
experience best practices {year}". If WebSearch is unavailable, say "Search
unavailable — using reference benchmarks (Stripe 30s, Vercel 2min, Firebase
3min, Docker 5min)" rather than implying you looked.

Build the table (at least two real competitors plus a YOUR PRODUCT row — the gate
enforces that count, because a benchmark of one is not something you can land a
tier against), then ask which tier to aim at: Champion (<2 min), Competitive
(2–5 min), or the current trajectory. **STOP.** The chosen tier is Pass 1's bar.

### 4D. Magical moment

Every good developer tool has the instant where "is this worth my time?" becomes
"oh, this is real". Load the reference:

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs ref --pass 1
```

Name the moment for this product type, then offer delivery vehicles with real
tradeoffs and both effort scales: interactive playground (human ~1 week / CC ~2h),
copy-paste demo command (~2 days / ~30 min), video walkthrough (~1 day / ~1h),
guided tutorial on their own data (~1 week / ~2h), or something else. Recommend
one and say why, naming what a competitor does. **STOP.**

### 4E. Mode

- **DX EXPANSION** — DX could be a competitive advantage. Ambitious proposals beyond the plan, each opt-in individually.
- **DX POLISH** — scope is right; make every touchpoint bulletproof. No additions, maximum rigor. *(recommended for most reviews)*
- **DX TRIAGE** — only the gaps that would block adoption. Fast, surgical.

Defaults: new developer-facing product → EXPANSION; enhancement → POLISH; bug fix
or urgent ship → TRIAGE. Once chosen, commit; do not drift. **STOP.**

### 4F. Journey trace with friction-point questions

For each stage — Discover, Install, Hello World, Real Usage, Debug, Upgrade —
trace the actual path (real files, real commands, real output), identify friction
with evidence, and ask **one AskUserQuestion per friction point**. Never batch.

Not "installation might be hard" but "step 3 requires Docker to be running,
nothing checks for it, and a [persona] without Docker sees [the specific error]".
Step 3B's findings are friction points that are already evidenced; start there.

TRIAGE traces Install and Hello World only. POLISH traces all six. EXPANSION
traces all six and asks "what would make this stage best-in-class?" per stage.

Then the map, which is a required output:

```
1. Discover     | [what they do] | [friction: resolved/deferred] | [fixed/ok/deferred]
2. Install      | ...
3. Hello World  | ...
4. Real Usage   | ...
5. Debug        | ...
6. Upgrade      | ...
```

### 4G. First-time developer roleplay

A confusion log with a clock on it, grounded in the real docs and code:

```
T+0:00  [what they do first, what they see]
T+0:30  [next action, what surprised them]
T+1:00  [what they tried, what happened]
T+2:00  [where they got stuck or succeeded]
T+3:00  [gave up / succeeded / asked for help]
```

Ask which items to address: all, let me pick, the critical ones, or "this is
unrealistic because our developers already know X". **STOP.**

---

## The 0-10 rating method

Rate each dimension 0-10. If it is not a 10, say what a 10 would be *for this
product*, then do the work to get there.

**Every rating must cite evidence from Step 3 or Step 4.** Not "Getting Started:
4/10" but "Getting Started: 4/10 — `tthw` exits 1 on `npm run dev`, so the
persona from 4A hits a dead end at step 3, and the tier chosen in 4C is 2 min."

1. Recall the evidence that applies to this dimension
2. Rate
3. Name the gap concretely
4. Load the Hall of Fame section for this pass with `ref --pass N`
5. Edit the plan to close it
6. Re-rate, naming what is still missing
7. AskUserQuestion when there is a genuine DX choice
8. Repeat until 10 or the user says good enough

EXPANSION additionally asks "what would make this best-in-class?" per dimension.
POLISH fixes every gap. TRIAGE only flags below 5.

---

## Step 5: The eight passes

> **STOP.** Read `~/.claude/skills/plan-devex-review/sections.md` in full and
> execute it. Do not work from memory — that file is the source of truth for the
> eight passes, the required outputs, the scorecard and the checklist.

---

## Step 6: The gate

Before ExitPlanMode, and before any review record:

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs gate --plan <plan-file>
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every check passed | ExitPlanMode is allowed. |
| 1 | It names what is missing | Produce it and run again. Do **not** call ExitPlanMode. |
| 2 | The plan could not be read | Refuse. A gate that cannot read the thing it checks does not pass it. |

It checks that the review report exists and is the LAST `##` section, that the
persona card has a persona in it, that the empathy narrative is at least 100
words and written in the first person, that the benchmark has two real
competitors and a YOUR PRODUCT row, that the magical moment names a vehicle, that
the journey map is not `[action]` rows, that the confusion report has at least
three T+ observations, that "NOT in scope" and "What already exists" are written,
that the scorecard has no `__/10`, no `__ min` and none of its `[a/b]` option
lists left, that the implementation checklist no longer says `[target from 0C]`,
and that the file's final non-whitespace line is the unbolded `NO UNRESOLVED
DECISIONS` or the last bullet of an `UNRESOLVED DECISIONS` block.

### Why this is a command

gstack's required output is a template of blanks — `__/10` in every cell, `__
min`, `[Champion/Competitive/Needs Work/Red Flag]`, `[covered/gap]` — and nothing
checks it. Pasted unfilled it renders as a completed review, and the only thing
gstack asks about whether the review is done is the model that just pasted it.
The same is true one level up: an "empathy narrative" of one third-person
sentence, a journey map of `[action]` rows, a persona card of `[description]`.
All of them are structurally perfect and carry nothing.

---

## Step 7: Record it

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs record \
  --plan <plan-file> --overall <N> --tthw "<current>" --tthw-target "<target>" \
  --mode <EXPANSION|POLISH|TRIAGE> --persona "<persona>" --unresolved <N>
```

It re-runs the gate and writes nothing if the gate fails. gstack runs its
`gstack-review-log` line *before* its exit gate and unconditionally, so a DX
review that never produced its report still leaves a record that /ship's
readiness dashboard reads as a completed DX review.

The record goes to `dx-reviews.jsonl` — one file per project, with the branch as
a **field** rather than as the filename. That is the whole fix from Step 1: the
next DX review, on the next branch, can read it.

---

## Next steps

- **/plan-eng-review** — DX findings usually have architectural implications; API design and error-handling fixes should be validated there.
- **/plan-design-review** — only if the plan also has end-user-facing UI.
- **/devex-review after shipping** — the boomerang. The plan said TTHW would be the tier chosen in 4C. Re-run `tthw` against the shipped repo and find out.

## Mode quick reference

```
             | DX EXPANSION      | DX POLISH        | DX TRIAGE
Scope        | push up (opt-in)  | maintain         | critical only
Posture      | enthusiastic      | rigorous         | surgical
Benchmark    | full              | full             | skip
Magical      | full design       | verify it exists | skip
Journey      | all 6 + best-in-  | all 6            | Install + Hello
             | class per stage   |                  | World only
Passes       | all 8, expanded   | all 8, standard  | Pass 1 + 3 only
```

## Prove this skill works

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs selftest
```

59 assertions against deliberately broken plans and repositories: a scorecard of
blanks, a narrative that is not a narrative, a journey map of template rows, a
README whose commands cannot run, a product type with no evidence, and a review
history that exists on another branch. Non-zero exit if any of them is reported
as fine.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief plan-devex-review
```

Follow the lines it prints for `plan-devex-review`. Where they disagree with
the defaults above, the mode wins. One thing no mode loosens: a blank
scorecard cell is blank in every stance, and a template row is never a journey
map.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
