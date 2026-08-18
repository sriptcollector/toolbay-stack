# plan-eng-review — the four review sections

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. These sections, the test-coverage audit and its quality rubric, the
required outputs and the Completion Summary come from
`plan-eng-review/sections/review-sections.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The claim lint and the jq-free tasks artifact are new. Not
affiliated with or endorsed by Garry Tan. See NOTICE.

**Anti-skip rule.** Never condense, abbreviate or skip a section, whatever kind
of plan this is. "It's a strategy doc, so the implementation sections don't
apply" is always wrong — implementation detail is where strategy breaks. A
section with genuinely nothing in it says "No issues found" and moves on, but it
gets evaluated.

**No shortcuts.** Do not sample. Do not review "the interesting files". If the
plan touches it, it is in scope for the section that covers it.

---

## How to ask questions

* **One issue = one AskUserQuestion call.** Never combine two issues into one
  question. The call is a tool_use, not prose.
* Describe the problem concretely, with file and line references — and expect
  those references to be resolved against the tree by `lint` before this review
  can close. Cite what you opened.
* Present 2-3 options, including "do nothing" where that is reasonable.
* Per option, one line: effort (human ~X / CC ~Y), risk, maintenance burden. If
  the complete option is only marginally more effort with CC, recommend it.
* Map the recommendation to a named engineering preference in one sentence.
* Label issue NUMBER + option LETTER ("3A", "3B"). One sentence per option —
  pickable in under five seconds.
* **Coverage vs kind.** If the options differ in coverage (more tests vs fewer,
  full error handling vs happy path), put `Completeness: N/10` on each. If they
  differ in kind (two different architectures), skip the score and write
  `Note: options differ in kind, not coverage — no completeness score.` Never
  fabricate a score; filler scores are worse than none.
* **Zero findings**: say "No issues, moving on" and proceed.

**STOP after each issue.** Do not proceed to the next section, edit the plan
with the proposed fix, or call ExitPlanMode until the user responds. An issue
with an obvious fix is still an issue. Loading the AskUserQuestion schema and
then writing the recommendation as chat prose is the failure mode this gate
exists to prevent.

---

### 1. Architecture review

Evaluate:

* Overall system design and component boundaries.
* Dependency graph and coupling.
* Data flow patterns and bottlenecks.
* Scaling characteristics and single points of failure.
* Security architecture: auth, data access, API boundaries.
* Which flows deserve an ASCII diagram, in the plan or in code comments.
* For each new codepath or integration point, one realistic production failure
  scenario, and whether the plan accounts for it.
* **Distribution architecture.** New binary, package or container? How does it
  get built, published and updated? Is CI/CD in the plan or deferred?

Confidence calibration: state findings at the confidence you actually have.
"`src/queue.ts:88` re-enqueues without a backoff" is a fact you can point at.
"This will probably not scale" is a hypothesis — label it as one, and say what
measurement would settle it.

### 2. Code quality review

Evaluate:

* Organisation and module structure.
* DRY violations — be aggressive.
* Error handling patterns and missing edge cases, called out explicitly. Every
  error gets a name: which exception class, what triggers it, what catches it,
  what the user sees, whether it is tested. Bare `catch (Exception)` /
  `rescue StandardError` / `except Exception` is a smell.
* Technical debt hotspots.
* Anything over- or under-engineered against the stated preferences.
* Existing ASCII diagrams in the touched files — are they still true after this
  change? Update them in the same commit or flag them.

### 3. Test review

100% coverage is the goal. Every codepath in the plan gets a test in the plan.
If tests are missing, add them — the plan should be complete enough that
implementation ships with full coverage from the start.

**Framework.** Read CLAUDE.md's `## Testing` section first; it is authoritative.
Otherwise Step 1 already printed the detected runtime, config files and test
directories, and it distinguished "read the directory, found nothing" from
"could not read the directory". If it could not read, say so — do not silently
downgrade to "skip test generation".

**Step 1 — trace every codepath.** For each planned component, follow the data,
do not list the functions. Where does input come from (params, props, DB, API)?
What transforms it? Where does it go? What can go wrong at each step (null,
invalid, network, empty collection)?

**Step 2 — draw the coverage diagram.** ASCII, in the plan. Every added or
modified function, every conditional branch (if/else, switch, ternary, guard,
early return), every error path (try/catch, rescue, error boundary, fallback),
every call into another function that has its own untested branches, and every
edge: null input, empty array, wrong type.

```
  Sender#call ──> validate ──> enqueue ──> POST
        │             │            │         └─> 5xx ──> retry (NO TEST)
        │             └─> invalid ──> raise ValidationError
        └─> nil payload ──> early return
```

The gate requires this to be an actual diagram. A paragraph describing the
branches satisfies a self-check and is not a map. This is the one output the
priority hierarchy says never to skip.

**Step 3 — map user flows, interactions and error states.** The journey a user
takes through this code, step by step. Then the unexpected: double-click and
rapid resubmit, navigating away mid-operation, stale form after 30 minutes, slow
connection, two tabs on the same form. Then what the user actually SEES for every
handled error: a clear message or a silent failure, recoverable or stuck. Then
empty / zero / boundary: no results, 10,000 results, one character, max length.
A user flow with no test is as much a gap as an untested branch.

**Step 4 — check each branch against existing tests.** Search for the test that
exercises it. Both sides of every if/else. A test that triggers each specific
error condition. An integration test for each journey. Score what you find:

* ★★★ behaviour plus edge cases plus error paths
* ★★ correct behaviour, happy path only
* ★ smoke test, existence check, trivial assertion ("it renders")

**For LLM/prompt changes**, check the prompt/LLM file patterns in CLAUDE.md. If
this plan touches any of them, state which eval suites must run, which cases to
add, and what baselines to compare against, then confirm the eval scope with
AskUserQuestion.

### 4. Performance review

Evaluate: N+1 queries and DB access patterns, memory usage, caching
opportunities, slow or high-complexity paths. Cite the file and line for each —
those citations are checked.

---

## Outside voice

If you ran a second model over this plan, its findings are INFORMATIONAL until
the user approves each one. Do not fold an outside-voice recommendation into the
plan without presenting it via AskUserQuestion, even when you agree with it.
Cross-model consensus is a strong signal; present it as one. The user decides.

---

## Required outputs

### "NOT in scope"

Work considered and explicitly deferred, one line of rationale each. Vague
intentions are lies; if it is not written down it does not exist.

### "What already exists"

Existing code and flows that already partially solve sub-problems here, and
whether this plan reuses them or rebuilds them unnecessarily.

### TODOS.md updates

After all sections, present each potential TODO as its own AskUserQuestion.
Never batch, never silently skip. For each: **What** (one line), **Why** (the
concrete problem it solves), **Pros**, **Cons**, **Context** (enough that
someone picking it up in three months understands the motivation, the current
state and where to start), **Depends on / blocked by**. Options: A) add to
TODOS.md, B) skip, not valuable enough, C) build it now in this PR. A TODO
without context is worse than no TODO — it creates false confidence the idea was
captured while losing the reasoning.

### Diagrams

The plan uses ASCII diagrams for every non-trivial data flow, state machine and
pipeline. Additionally, name the implementation files that should get inline
ASCII diagram comments — models with complex state transitions, services with
multi-step pipelines, mixins with non-obvious behaviour.

### Failure modes

For each new codepath in the coverage diagram, one realistic production failure
(timeout, nil reference, race, stale data) and whether: (1) a test covers it,
(2) error handling exists, (3) the user sees a clear error or nothing at all.

If a failure mode has no test AND no error handling AND would be silent, flag it
as a **critical gap** — in bold, exactly like that. The Completion Summary's
critical-gap count is checked against these flags, in both directions: a summary
claiming zero over a body that flags one fails, and so does a count with no flag
behind it.

| Codepath | Failure | Test | Rescued | User sees |
|---|---|---|---|---|
| … | … | Y/N | Y/N | … |

### Worktree parallelization strategy

**Skip only** if every step touches the same primary module or there are fewer
than two independent workstreams — and then write exactly:
`Sequential implementation, no parallelization opportunity.`

Otherwise:

1. **Dependency table**, at module/directory level, not file level (plans
   describe intent, so file-level is guesswork):

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| … | `models/`, `services/` | — |

2. **Lanes.** Steps with no shared module and no dependency go in separate
   lanes; steps sharing a module directory go in the same lane, sequentially;
   dependent steps go in later lanes. Write them labelled and with the module
   directories in the line, because that is what gets checked:

```
Lane A: retry loop (src/hooks/) → backoff (src/hooks/)
Lane B: CLI reporting (cli/)
```

3. **Execution order.** Which lanes launch in parallel, which wait.
4. **Conflict flags.** Two parallel lanes touching the same module directory get
   an explicit conflict line. The gate refuses the collision otherwise — this is
   the one rule here that is arithmetic rather than judgement.

### Implementation tasks

Markdown first:

```markdown
## Implementation Tasks
- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — <component> — <imperative title>
  - Surfaced by: <section> — <specific finding>
  - Files: <paths to touch>
  - Verify: <test command or manual check>
```

Then the artifact, one `task` call each (Step 3 of SKILL.md). P1 blocks ship, P2
lands same branch, P3 is a follow-up TODO. If a finding produced no actionable
task, do not invent one. Zero tasks still writes the artifact, with `--none`.

### Completion Summary

```
- Step 0: Scope Challenge — (accepted as-is / reduced per recommendation)
- Architecture Review: N issues found
- Code Quality Review: N issues found
- Test Review: diagram produced, N gaps identified
- Performance Review: N issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: N items proposed
- Failure modes: N critical gaps flagged
- Outside voice: ran (codex/claude) / skipped
- Parallelization: N lanes, N parallel / N sequential
- Citations: N file:line references, all resolved
```

Fill every value. A summary emitted with its blanks still in it looks exactly
like a finished review and carries nothing; the gate rejects `___`.

### Retrospective learning

Check the git log for this branch. Prior commits suggesting an earlier review
cycle (review-driven refactors, reverts) mean those areas were problematic
before — review them MORE aggressively, and say so. Recurring problem areas are
architectural smells; surface them as such.

---

## The review report

The last `##` section of the plan file, always. Build it by deleting any existing
report section wherever it sits and appending the new one at the end — never
replace in place, which is how reports end up mid-file.

```markdown
## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 findings, 4 folded |

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
```

`**CODEX:**` and `**CROSS-MODEL:**` lines go above VERDICT when they apply.
`**VERDICT:**` is always present.

The **final non-whitespace line of the file** is the unresolved-decisions status:
either the exact unbolded `NO UNRESOLVED DECISIONS`, or a `**UNRESOLVED
DECISIONS:**` header followed by one bullet per open item, the last bullet being
the last line. A bolded sentinel does not count. Trailing prose after it does not
count. Never silently default an unanswered AskUserQuestion to an option — it
goes here, as "decisions left unresolved that may bite you later".

Then run the gate (SKILL.md Step 5). It reads the file.
