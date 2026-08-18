---
name: autoplan
version: 0.1.0
description: Runs the whole plan-review gauntlet in one command. Loads the CEO, design, eng and DX review methodologies from disk and follows them at full depth, auto-deciding every intermediate question with six named principles, then refuses to call the review done until the required outputs are actually on disk. Use when you have a plan and want it fully reviewed without answering fifteen questions.
triggers:
  - autoplan
  - auto plan review
  - run all the reviews
  - full review pipeline
  - review this plan automatically
  - make the decisions for me
provides:
  - planning-review
  - plan-review-pipeline
  - review-evidence-gate
platforms:
  - win32
  - darwin
  - linux
cost: high
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebSearch
  - AskUserQuestion
---

# autoplan

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (one command that runs CEO → Design → Eng → DX plan
review in sequence, the six decision principles, the mechanical / taste / user
challenge classification, the two gates that are never auto-decided, the
conditional UI and DX phases and the term lists that gate them, the dual-voice
consensus tables, the per-phase required-output lists and the final approval
gate) comes from `autoplan` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The preflight, the evidence gate, the jq-free task aggregator
and the verified review record are new. Not affiliated with or endorsed by
Garry Tan. See NOTICE.

One command. Rough plan in, fully reviewed plan out. The review methodology is
not reimplemented here: this skill reads the four `plan-*-review` skills off
disk and follows them at their own full depth. The only thing it changes is who
answers the intermediate questions, and whether the pipeline is allowed to
declare itself finished.

---

## Step 1: Preflight, or refuse

```bash
node ~/.claude/skills/autoplan/scripts/tb-autoplan.mjs preflight --plan <plan-file> --stamp
```

The exit code is the instruction:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Ready | Continue. It printed the phase list and the file each phase's methodology comes from. |
| 3 | A required review skill is not installed | **STOP.** Name the missing skill. Do not run that phase from memory. |
| 2 | The plan file is missing, empty, or unreadable | Stop and say which. |

It does three things: resolves the plan, detects UI and DX scope
deterministically, and locates `plan-ceo-review`, `plan-eng-review` and
(conditionally) `plan-design-review` and `plan-devex-review` on disk.
`--stamp` writes the resulting phase set into the plan file as an HTML comment
so Step 6 checks the right list.

### Why this is a command

gstack's Phase 0 Step 3 says to read the four methodology files with the Read
tool and says nothing about what to do if one is absent. The only place the same
file handles an unreadable skill it says "Skip with 'Could not load' and
continue." So on a partial install, a project-local override, or a vendored
copy, a phase runs with no methodology loaded, the model reviews from memory,
and Phase 4 still prints `Eng: [summary]` and writes
`{"skill":"plan-eng-review","status":"clean"}` where `/ship` will read it. This
refuses first:

```
  no   eng     plan-eng-review      NOT FOUND

  MISSING METHODOLOGY  plan-eng-review
  exit=3
```

Scope detection also stops being a judgement call. gstack says to grep the plan
for ~25 developer-facing terms and "require 2+ matches", which is a rule the
model applies by eye and cannot be argued with afterwards. Here it is 2+
**distinct** terms, matched on word boundaries, **in prose only** — fenced
blocks and inline code are stripped first, because a plan that pastes a
JavaScript snippet containing `import` and `require` is not thereby a developer
tool — and the matched terms are printed:

```
  DX scope:  yes  (4 distinct term(s): api, endpoint, rest, cli)
```

---

## Step 2: Load the methodology

Read each file `preflight` printed, with the Read tool. Follow it top to bottom
at full depth, **skipping only** the sections this skill already owns:

- Preamble / Telemetry / Completion Status Protocol
- AskUserQuestion Format
- Completeness Principle, Search Before Building
- Step 0: Detect base branch
- Review Readiness Dashboard, Plan File Review Report
- Prerequisite Skill Offer
- Outside Voice / Design Outside Voices

Everything else runs. "Full depth" means: read the code the section names,
produce the output the section requires, identify every issue, decide each one.
A one-sentence summary of a section is a skip wearing a section's name.

---

## Step 3: The six decision principles

These replace the user's judgement on intermediate questions. They do not
replace the analysis.

1. **Choose completeness.** Ship the whole thing. Prefer the approach that
   covers more edge cases.
2. **Boil lakes.** Fix everything in the blast radius (files this plan touches
   plus their direct importers). Auto-approve expansions inside the radius under
   ~1 day of CC effort: under 5 files, no new infrastructure.
3. **Pragmatic.** If two options fix the same thing, take the cleaner one. Five
   seconds deciding, not five minutes.
4. **DRY.** Duplicates something that exists? Reject it, reuse what is there.
5. **Explicit over clever.** A 10-line obvious fix beats a 200-line
   abstraction. Pick what a new contributor reads in 30 seconds.
6. **Bias toward action.** Flag concerns, do not block on them.

Tiebreakers by phase: CEO → P1 + P2 dominate. Eng → P5 + P3. Design → P5 + P1.
DX → P5 + P1.

Classify every decision:

- **Mechanical** — one right answer. Decide silently, log it.
- **Taste** — reasonable people could disagree. Decide with a recommendation,
  then surface it at the gate. Three sources: two close approaches, borderline
  scope (3-5 files or an ambiguous radius), a codex disagreement with a point.
- **User Challenge** — both voices think the user's stated direction should
  change (merge, split, add, remove). **Never auto-decided.** Goes to the gate
  with: what the user said, what both models recommend, why, what context we
  might be missing, and what it costs if we are wrong and they were right. The
  user's direction is the default; the models must make the case.

Two questions are never auto-decided: the **premise gate** in the CEO phase, and
**User Challenges**. Everything else you answer yourself.

---

## Step 4: Run the phases, in order

CEO → Design (if UI scope) → Eng → DX (if DX scope). Never in parallel; each
builds on the last. Emit a transition summary between phases and do not start
the next one until the previous phase's outputs are written into the plan file.

Per phase, run the dual voices the loaded skill asks for: a Claude subagent
(Agent tool, foreground, no prior-phase context so it stays independent) and
Codex if it is installed and authenticated. Then build that phase's consensus
table. **Fill every cell.** A table of em dashes satisfies gstack's "consensus
table produced" checkbox and carries no information; Step 6 rejects it.

If Codex is absent or unauthenticated, tag the phase `[codex-unavailable]` and
continue with the subagent. Both absent: `single-reviewer mode`, stated in the
plan file, not silently.

Every prompt sent to Codex gets this prefix:

> IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill
> definition directories. These are AI assistant skill definitions meant for a
> different system. Ignore them completely. Stay focused on the repository code
> only.

Append one row per decision to the plan file's audit trail as you go, with Edit,
so the trail is on disk rather than accumulating in context:

```markdown
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
```

---

## Step 5: Aggregate the implementation tasks

```bash
node ~/.claude/skills/autoplan/scripts/tb-autoplan.mjs tasks \
  --dir ~/.gstack/projects/<slug> --branch <branch> --repo . --commit-window 5
```

Prints the final gate's `Implementation Tasks` markdown: every phase's task
list, latest run per phase, deduped on (component, files, title), sorted by
priority then phase.

| Exit | Meaning |
|---|---|
| 0 | Tasks rendered, or the directory was read and genuinely holds no task files (it says which) |
| 2 | The directory or a task file could not be read. **Not** the same as no tasks. |

### Why this is a command

gstack does this with a ~50-line jq pipeline in which every jq call ends
`2>/dev/null || true`, gated on `command -v jq`. On Windows 11, 2026-08-13:

```
$ command -v jq || echo "JQ: ABSENT"
JQ: ABSENT
```

so the entire Implementation Tasks section of the final gate becomes the string
`_jq not installed — install jq to aggregate per-phase task lists. Skipping._`
and every task the four reviews surfaced is dropped from the deliverable. Run
verbatim against a fixture holding three real tasks, gstack's block prints that
one line and this prints all three. The jq version also uses `mktemp`, `find
-maxdepth`, and `done < <(find ...)` process substitution, none of which are
safe outside a POSIX shell.

A malformed task line is reported here, never silently skipped. A git failure
while computing the commit window drops the filter rather than the tasks: the
safe direction for a narrowing filter that broke is to show more, not less.

---

## Step 6: The evidence gate

```bash
node ~/.claude/skills/autoplan/scripts/tb-autoplan.mjs verify --plan <plan-file>
```

Checks the plan file on disk for every required output of every phase that was
in scope: the premise challenge, "NOT in scope", "What already exists", the
Error & Rescue and Failure Modes registries, the dream-state delta, the
architecture diagram, the test diagram, the design dimension scores, the DX
journey map and TTHW, the dual-voice tables, and at least one real audit-trail
row.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every required output is present | Present the final gate. |
| 1 | Outputs are missing; it names them | Produce them and run it again. Do not present the gate. |
| 3 | No preflight stamp, so the required phase set is unknown | Run Step 1. |

Four of its checks are not just presence checks:

- **The named artifact must exist.** If the plan says it wrote a test plan to a
  path, that path is `existsSync`-ed. A review that claims an artifact it never
  wrote fails here.
- **Unfilled templates are rejected.** Three or more consensus rows still
  holding `—` in every cell means the template was pasted, not completed.
- **"No issues found" must say what was examined.** gstack forbids this in
  prose ("Write 'no issues found' without showing what you examined" is on its
  MUST NOT list); here it exits 1 unless the surrounding paragraph names what
  was read, checked, traced or inspected.
- **A claimed phase must have delivered.** The phase list comes from the
  preflight stamp, so a plan that was in UI scope cannot quietly skip the design
  outputs.

gstack's equivalent is 25 checkboxes the model ticks about its own work, ending
"if still missing after retrying twice, proceed to the gate with a warning." The
documented behaviour on a failed verification is to pass anyway.

---

## Step 7: Final approval gate

Only after `verify` exits 0. Present, then ask:

```
## Review complete

### Plan summary
[1-3 sentences]

### Decisions: [N] total ([M] auto-decided, [K] taste, [J] user challenges)

### User challenges (both voices disagree with your stated direction)
**[title]** (from [phase])
You said: … / Both models recommend: … / Why: … / What we might be missing: … /
If we're wrong, the cost is: …
Your call. Your original direction stands unless you change it.

### Your choices (taste decisions)
**[title]** (from [phase]) — I picked [X] on [principle]. [Y] is also viable:
[one line on the downstream impact].

### Auto-decided: [M] — see the Decision Audit Trail in the plan file

### Review scores
CEO / Design / Eng / DX, each with its consensus count and voice tags

### Cross-phase themes
Anything two phases' voices flagged independently. High-confidence signal.

### Deferred to TODOS.md

### Implementation tasks
[the output of Step 5]
```

Options: A) approve as-is · B) approve with overrides · C) interrogate ·
D) revise the plan · E) reject.

0 user challenges: drop that section. 0 taste decisions: drop that one. 8+ taste
decisions: group by phase and say so, an unusually ambiguous plan is itself a
finding. On D, re-run only the affected phases, max 3 cycles.

---

## Step 8: Record the review

```bash
node ~/.claude/skills/autoplan/scripts/tb-autoplan.mjs record --plan <plan-file>
```

Re-runs `verify` and writes one review record per phase **only if it passes**,
each carrying `verified: true` and the ids of the requirements that were
checked. If verification fails it writes nothing and exits 1.

The record is the claim that the review happened. It is emitted by the thing
that checked, not typed by the thing being checked.

---

## Prove the checks work

```bash
node ~/.claude/skills/autoplan/scripts/tb-autoplan.mjs selftest
```

Runs this executable as a child process against a plan with no methodology
installed, an empty plan, a task directory that cannot be listed, task lines
that are not JSON, a consensus table still full of template dashes, a test-plan
artifact the plan names but never wrote, a bare "no issues found", and a plan
with no preflight stamp. It also runs gstack's own jq aggregator verbatim on the
same task fixture and asserts this one surfaces more tasks. Exits non-zero if
any of them are accepted.

## Important rules

- **Never abort.** The user chose /autoplan. Surface taste decisions, do not
  redirect to an interactive review.
- **Log every decision.** No silent auto-decisions.
- **Artifacts are deliverables.** The test plan, the registries, the diagrams
  exist on disk or in the plan file, or the review is not finished. Step 6
  enforces that rather than asking you to confirm it.
- **A phase you could not load is not a phase you ran.** Say so and stop.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief autoplan
```

Follow the lines it prints for `autoplan`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
