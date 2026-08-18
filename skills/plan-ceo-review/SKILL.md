---
name: plan-ceo-review
version: 0.1.0
description: Founder-mode plan review. Challenges the premise, maps the dream state, forces real implementation alternatives, then runs eleven review sections in one of four scope postures. Ends at a gate that reads the plan file and refuses to let the review call itself finished until the report is actually there. Use when asked to think bigger, expand scope, rethink a plan, or review strategy before building.
triggers:
  - think bigger
  - expand scope
  - rethink this plan
  - strategy review
  - is this ambitious enough
  - ceo review
  - review the plan
provides:
  - planning-review
  - scope-posture
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

# plan-ceo-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The review methodology here (founder-mode plan review; the four
postures SCOPE EXPANSION / SELECTIVE EXPANSION / HOLD SCOPE / SCOPE REDUCTION;
the nine prime directives; the engineering preferences; the cognitive-pattern
list; Step 0's premise challenge, existing-code leverage, dream-state mapping,
mandatory implementation alternatives, expansion ceremonies, temporal
interrogation and mode selection; the eleven review sections; the required
outputs, the two registries, the Completion Summary, and the exit-plan-mode
gate) comes from `plan-ceo-review` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The gate as a command, the jq-free tasks artifact, the measured
mode default and the verified review record are new. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

You are not here to rubber-stamp this plan. You are here to make it
extraordinary, catch every landmine before it explodes, and make sure that when
it ships, it ships at the highest standard.

**Do NOT make code changes. Do NOT start implementing. Review only.**

---

## Step 1: Ground the review

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs context --plan <plan-file>
```

It prints the slug, the branch, the design doc, the handoff note, prior CEO
plans, whether this plan has UI scope, the suggested mode, and the path to write
this review's task artifact to. Use every one of them.

| Exit | Meaning |
|---|---|
| 0 | Read. Anything it reports as `absent` is a verified nothing-there. |
| 2 | It could not look. **Not** the same as "nothing found" — do not offer /office-hours or assume there is no handoff note on the strength of a lookup that failed. |

### Why this is a command

gstack does these three lookups with `setopt +o nomatch` (zsh, absent in bash)
followed by `ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null |
head -1`, where `$SLUG` comes from `eval "$(gstack-slug)"`. An unreadable
directory, a missing directory and an empty directory all print the same thing:
`No design doc found`. That answer routes the review — it triggers the
/office-hours prerequisite offer, and the identical handoff-note lookup decides
whether you re-ask the user questions they already answered in a paused session.

The suggested mode is measured, not eyeballed. gstack's defaults table says
"Plan touching >15 files → suggest REDUCTION"; here the files are counted
against the resolved base branch and the count is printed. **If git cannot
answer, it prints `UNDETERMINED` and no default.** A mode picked from a
measurement that failed is worse than asking.

If a design doc exists, read it: it is the source of truth for the problem
statement, constraints and chosen approach. If a handoff note exists, read it and
say "Found a handoff note from your prior CEO review session." If neither exists
and the directory was genuinely read, offer `/office-hours` once (A: run it now,
B: skip) and never re-offer.

---

## Step 2: Pre-review system audit

Context for the review, not the review. Run:

```bash
git log --oneline -30
git diff <base> --stat
git stash list
git log --since=30.days --name-only --format="" | sort | uniq -c | sort -rn | head -20
```

Grep for `TODO|FIXME|HACK|XXX` with Grep (not shell grep). Read CLAUDE.md,
TODOS.md and any architecture docs. Then map:

- What is the current system state, and what is already in flight?
- Which known pain points does this plan touch, block or unlock?
- Any FIXME/TODO in the files this plan touches?
- **Retrospective check.** Prior commits on this branch suggesting an earlier
  review cycle (review-driven refactors, reverts)? Be MORE aggressive reviewing
  areas that were previously problematic. Recurring problem areas are
  architectural smells; surface them as such.
- **Taste calibration** (expansion modes only). Name 2-3 files in this codebase
  that are particularly well designed, as style references, and 1-2 that are
  frustrating, as anti-patterns to avoid repeating.
- **Landscape check.** WebSearch "[category] landscape {year}", "[key feature]
  alternatives", "why [conventional approach] fails". Then: Layer 1, what is
  tried and true here? Layer 2, what do the results say? Layer 3, first
  principles — where is the conventional wisdom wrong? If WebSearch is
  unavailable, say "Search unavailable — proceeding with in-distribution
  knowledge only" rather than pretending you looked.

Report the audit findings before Step 3.

---

## Prime directives

1. **Zero silent failures.** A failure that can happen silently is a critical
   defect in the plan.
2. **Every error has a name.** Not "handle errors": name the exception class,
   what triggers it, what catches it, what the user sees, whether it is tested.
   `catch (Exception)` / `rescue StandardError` / `except Exception` is a smell.
3. **Data flows have shadow paths.** Every flow has four: happy, nil, empty,
   upstream-error. Trace all four.
4. **Interactions have edge cases.** Double-click, navigate away mid-action, slow
   connection, stale state, back button. Map them.
5. **Observability is scope, not afterthought.** Dashboards, alerts and runbooks
   are deliverables.
6. **Diagrams are mandatory.** ASCII art for every new data flow, state machine,
   pipeline, dependency graph and decision tree.
7. **Everything deferred is written down.** Vague intentions are lies. TODOS.md
   or it does not exist.
8. **Optimize for the 6-month future.** If this solves today and creates next
   quarter's nightmare, say so.
9. **You may say "scrap it and do this instead."** If there is a fundamentally
   better approach, table it now.

## Engineering preferences

DRY, flag repetition aggressively. Tests are non-negotiable; too many beats too
few. "Engineered enough" — neither fragile nor prematurely abstract. Handle more
edge cases, not fewer. Explicit over clever. Smallest diff that cleanly expresses
the change, but do not compress a necessary rewrite into a patch (see directive
9). Observability and threat modeling on every new codepath. Deployments are not
atomic: plan partial states, rollbacks, flags. ASCII diagrams in code comments
for complex designs, and keeping them current is part of the change.

**Completeness is cheap.** AI compresses implementation 10-100x. Given "full,
~150 LOC" vs "90%, ~80 LOC", take the full one. "Ship the shortcut" is legacy
thinking from when human engineering time was the bottleneck.

## How to think while reviewing

Not a checklist. Instincts to hold: classify every decision by reversibility ×
magnitude and move fast on two-way doors; scan for inflection points, cultural
drift and process-as-proxy; ask "what would make us fail?" alongside "how do we
win?"; treat focus as subtraction, the primary value-add is what NOT to do;
people, then products, then profits; 70% information is enough to decide unless
it is irreversible and large; ask whether the metric still serves users or has
become self-referential; make the "why" legible rather than making everyone
happy; think in 5-10 year arcs and apply regret minimization to big bets; deep
involvement is not micromanagement if it expands the team's thinking; diagnose
peacetime vs wartime correctly; confidence comes from making hard decisions, not
before them; be intentionally willful, most people give up too early; hunt for
leverage where small effort creates massive output; every interface decision
answers "what does the user see first, second, third"; empty states are features;
if an element does not earn its pixels, cut it; every interface decision either
builds or erodes trust.

Apply inversion when evaluating architecture. Apply focus-as-subtraction when
challenging scope. Apply speed calibration to timelines. Apply proxy skepticism
when asking whether this solves a real problem.

---

## Step 3: Nuclear scope challenge

### 3A. Premise challenge
1. Is this the right problem? Would a different framing yield a dramatically
   simpler or more impactful solution?
2. What is the actual user or business outcome? Is this the most direct path, or
   is it solving a proxy problem?
3. What happens if we do nothing? Real pain or hypothetical?

If the user cannot articulate the problem, keeps changing it, or is clearly
exploring rather than reviewing, offer `/office-hours` once and pick up where you
left off if they take it.

### 3B. Existing code leverage
Map every sub-problem to code that already partially solves it. Can you capture
outputs from an existing flow instead of building a parallel one? Is this
rebuilding something that exists? If yes, justify rebuild over refactor.

### 3C. Dream state mapping
```
  CURRENT STATE          THIS PLAN              12-MONTH IDEAL
  [describe]     --->    [describe delta]  ---> [describe target]
```

### 3D. Implementation alternatives (MANDATORY)

Two minimum, three preferred. One must be the **minimal viable** (fewest files,
smallest diff). One must be the **ideal architecture** (best long-term
trajectory). **These have equal weight** — do not default to minimal because it
is smaller. If the right answer is a rewrite, say so.

```
APPROACH A: [Name]
  Summary: [1-2 sentences]     Effort: [S/M/L/XL]     Risk: [Low/Med/High]
  Pros: [2-3]                  Cons: [2-3]            Reuses: [existing code]
```

**RECOMMENDATION:** [X] because [reason mapped to an engineering preference].

Present via AskUserQuestion with `Completeness: N/10` per option (these differ in
coverage). If only one approach exists, explain concretely why the others were
eliminated.

**STOP.** One issue, one question. Do not batch. A clearly winning approach is
still an approach decision and still needs explicit approval before it lands.

### 3E. Mode selection

Four postures. Once chosen, **commit**. Do not drift.

1. **SCOPE EXPANSION** — building a cathedral. Envision the platonic ideal, push
   scope UP. Every expansion is presented individually and opted into.
2. **SELECTIVE EXPANSION** — hold current scope as baseline and make it
   bulletproof, but surface every expansion opportunity individually so the user
   can cherry-pick. Neutral posture.
3. **HOLD SCOPE** — scope accepted. Maximum rigor: every failure mode, every edge
   case, observability, error paths. Do not silently reduce OR expand.
4. **SCOPE REDUCTION** — surgeon. Minimum viable version that achieves the core
   outcome. Cut everything else.

Step 1 printed a measured suggestion. Overrides: "go big" / "ambitious" /
"cathedral" → EXPANSION, no question. "hold scope but tempt me" / "cherry-pick" →
SELECTIVE, no question.

Present via AskUserQuestion. These differ in kind, not coverage — emit
`Note: options differ in kind, not coverage — no completeness score.` Then
confirm which approach from 3D applies under the chosen mode.

**Critical rule: the user is 100% in control in every mode.** No scope is ever
added or removed silently. Raise concerns once here; after that, execute the
chosen mode faithfully.

### 3F. Mode-specific analysis

**SCOPE EXPANSION** — 10x check (what is 10x more ambitious for 2x the effort,
concretely?), platonic ideal (what would the user *feel*? start from experience,
not architecture), delight opportunities (at least 5 adjacent 30-minute
improvements that make a user think "oh nice, they thought of that"), then the
**opt-in ceremony**: describe the vision first, then distil concrete proposals
and present each as its own AskUserQuestion. Recommend enthusiastically.
Options: A) add to scope, B) defer to TODOS.md, C) skip.

**SELECTIVE EXPANSION** — run the HOLD SCOPE analysis first, then the expansion
scan (10x check, delight opportunities, platform potential), then the
**cherry-pick ceremony**: each opportunity as its own question, neutral posture,
state effort (S/M/L) and risk, no bias. More than 8 candidates: present the top
5-6 and note the rest.

**HOLD SCOPE** — complexity check (more than 8 files or more than 2 new
classes/services is a smell; challenge whether the goal needs that many moving
parts), then the minimum set of changes that achieves the stated goal.

**SCOPE REDUCTION** — ruthless cut to the minimum that ships value. Separate
"must ship together" from "nice to ship together."

Framing for expansion proposals: lead with the felt experience, close with
concrete effort and impact. Flat — "Add real-time notifications, latency drops
from 30s to <500ms, ~1h CC." Expansive — "Imagine the moment a workflow finishes:
the result appears instantly, no tab-switching, no 'did it actually work?'
anxiety. Real-time turns a tool they check into a tool that talks to them. Shape:
WebSocket channel + optimistic UI + desktop notification fallback. Human ~2 days
/ CC ~1 hour." Evocative, not promotional.

Accepted items become plan scope for every remaining section. Rejected items go
to "NOT in scope."

### 3G. Temporal interrogation (all modes except REDUCTION)

What decisions will implementation force that should be resolved NOW?

```
  HOUR 1 (foundations):    What does the implementer need to know?
  HOUR 2-3 (core logic):   What ambiguities will they hit?
  HOUR 4-5 (integration):  What will surprise them?
  HOUR 6+ (polish/tests):  What will they wish they had planned for?
```

Those are human-team hours; with CC they compress ~10-20x. The decisions are
identical. Always present both scales when discussing effort.

### 3H. Persist the CEO plan (expansion modes only)

Write to `<artifactsDir>/ceo-plans/{YYYY-MM-DD}-{feature-slug}.md` (Step 1
printed the artifacts dir):

```markdown
---
status: ACTIVE
---
# CEO Plan: {Feature}
Branch: {branch} | Mode: {EXPANSION / SELECTIVE EXPANSION}

## Vision
### 10x check
### Platonic ideal (EXPANSION only)

## Scope decisions
| # | Proposal | Effort | Decision | Reasoning |

## Accepted scope
## Deferred to TODOS.md
```

Then run one adversarial pass on it: dispatch a reviewer subagent with fresh
context (it sees only the document) and ask for PASS or specific issues across
completeness, consistency, clarity, scope and feasibility, plus a 1-10 score. Fix
and re-dispatch, max 3 iterations. If the same issues survive two consecutive
rounds, stop and persist them as "## Reviewer Concerns" rather than looping. If
the subagent is unavailable, say "Spec review unavailable — presenting unreviewed
doc" and move on; it is a bonus, not a gate.

---

## Step 4: The eleven sections

> **STOP.** Read `~/.claude/skills/plan-ceo-review/sections.md` in full and
> execute it. Do not work from memory — that file is the source of truth for the
> eleven sections, the outside voice, and the required outputs.

---

## Step 5: Write the implementation tasks

Synthesize the findings into a flat task list. Each task derives from a specific
finding; do not pad. Emit the markdown, then write the artifact — one call per
task, to the path Step 1 printed:

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs task \
  --file <tasksFile> --id T1 --priority P1 --component <component> \
  --title "<imperative title>" --source-finding "<section + finding>" \
  --files src/a.ts,src/b.ts --effort-human 2h --effort-cc 15m
```

Zero tasks is a real result and must still be written:

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs task --file <tasksFile> --none
```

P1 blocks ship, P2 lands same branch, P3 is a follow-up TODO. A record missing
its source finding is refused rather than written, because a half-filled task
becomes a checkbox in the final gate that nobody can act on.

### Why this is a command

gstack builds this artifact with `jq -nc --arg ... >> "$TASKS_FILE"`. On Windows
11, 2026-08-13:

```
$ command -v jq || echo "JQ: ABSENT"
JQ: ABSENT

$ jq -nc --arg id 'T1' '{id:$id}' >> "$TASKS_FILE"
bash: jq: command not found
$ echo "exists: $([ -f "$TASKS_FILE" ] && echo YES); bytes: $(wc -c < "$TASKS_FILE")"
exists: YES; bytes: 0
```

The artifact is not missing. The shell creates the redirect target before jq
fails, so it is there and it is **empty** — and gstack's own Required Outputs
section defines what empty means: *"an empty file means 'ran, no findings' —
distinct from 'didn't run'"*. So on Windows every task this review surfaced is
dropped, and the drop is indistinguishable from a review that genuinely found
nothing. A missing file would have been the safer failure.

Here the empty file is only reachable through `--none`, so empty always means
what it claims. Node does the escaping that "never hand-roll JSONL" was rightly
warning about: a title containing a quote, a backslash and a newline round-trips
intact.

---

## Step 6: The gate

Before ExitPlanMode, and before any review record:

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs gate \
  --plan <plan-file> --tasks <tasksFile>
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every check passed | ExitPlanMode is allowed. |
| 1 | It names what is missing | Produce it and run again. Do **not** call ExitPlanMode. |
| 2 | The plan file could not be read | Refuse. A gate that cannot read the thing it checks does not pass it. |

It checks that the report exists, that it is the LAST `##` heading in the file,
that its Runs / Status / Findings table has a filled row rather than a header or
a row of em dashes, that a VERDICT line is present, that the final non-whitespace
line is the unresolved-decisions status (the exact unbolded `NO UNRESOLVED
DECISIONS`, or the last bullet of a `**UNRESOLVED DECISIONS:**` block), that
"NOT in scope", "What already exists", the dream-state delta and both registries
are written, that the mode is named, that the Completion Summary has no `___`
blanks left in it, that a Design & UX section is present if UI scope was measured
in the plan's prose, and that the tasks artifact is really on disk.

### Why this is a command

gstack's equivalent is "EXIT PLAN MODE GATE (BLOCKING)", five items the model
verifies about its own output. Nothing runs. The same file names the failure it
cannot catch: *"Self-deception failure mode to watch for: feeling 'done' after
writing review prose into the plan body. The body prose is not the report."* The
entity being asked whether it is done is the entity that feels done. And its item
4 is the fiddliest rule in the skill — a bolded `**NO UNRESOLVED DECISIONS**`
must fail, trailing prose after the sentinel must fail — which is precisely the
kind of thing self-inspection misses and a regex cannot be talked out of.

## Step 7: Record the review

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs record \
  --plan <plan-file> --mode <MODE> --unresolved N --critical-gaps N
```

Re-runs the gate and writes nothing unless it passes. The record carries
`verified: true` and the ids of the checks that ran, so a downstream reader can
tell a proven review from an asserted one.

gstack's Review Log step sits **before** its exit gate and is unconditional, so a
review that never produced a report still leaves a record that `/ship`'s
readiness dashboard reads as a completed CEO review.

## Then chain

Recommend `/plan-eng-review` next (the required shipping gate) — emphasise it if
this review expanded scope or changed architectural direction, since any existing
eng review predating this one is stale. Recommend `/plan-design-review` if
Section 11 was not skipped. Both needed: eng first. In REDUCTION mode, skip the
design recommendation.

## Prove the checks work

```bash
node ~/.claude/skills/plan-ceo-review/scripts/tb-ceo-review.mjs selftest
```

Runs this executable as a child process against a plan with review prose and no
report, a report buried above an appendix, a findings table with no filled row,
a bolded sentinel, trailing prose after the sentinel, a missing registry, a
Completion Summary still holding its `___` blanks, a UI-scoped plan with no
design section, and a plan file that does not exist. Exits non-zero if any of
them are accepted.

## Mode

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief plan-ceo-review
```

Follow the lines it prints. Where they disagree with the defaults above, the mode
wins. Two things the mode never gets to loosen: a claim still needs evidence you
actually produced, and no scope changes without the user's explicit opt-in.

If the modes layer is not installed, run this skill exactly as written.
