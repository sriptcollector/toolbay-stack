# plan-ceo-review — the eleven sections

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The eleven review sections, the anti-skip and anti-shortcut rules,
the error/rescue and failure-mode registries, the outside-voice pass, the
required outputs, the Completion Summary and the mode comparison come from
`plan-ceo-review/sections/review-sections.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). Not affiliated with or endorsed by Garry Tan. See NOTICE.

Read this only after Step 3 — scope and mode are agreed.

---

**Anti-skip rule.** Never condense, abbreviate or skip a section, whatever the
plan type. "This is a strategy doc so implementation sections do not apply" is
always wrong; implementation detail is where strategy breaks down. A section with
genuinely nothing in it gets "No issues found" **plus what you examined** — the
gate rejects a bare one.

**Anti-shortcut rule.** The plan file is the OUTPUT of an interactive review, not
a substitute for it. Writing every finding into one plan write and calling
ExitPlanMode is the failure mode this skill exists to prevent. If you have any
non-trivial finding, the path from finding to ExitPlanMode goes THROUGH
AskUserQuestion. Zero findings everywhere is the only path that bypasses it.

**After every section: STOP.** One issue, one AskUserQuestion. Never batch.
Always recommend, always say why, always map the reasoning to a named engineering
preference. Label issues by NUMBER and options by LETTER (3A, 3B). Present 2-3
options including "do nothing" where reasonable, each with effort, risk and
maintenance burden on one line. A finding with an obvious fix is still a finding
and still needs approval before it lands in the plan. **Make no code changes.**

---

### Section 1: Architecture Review

- Overall design and component boundaries. Draw the dependency graph.
- Data flow, all four paths, ASCII-diagrammed: happy, nil, empty, upstream error.
- State machines. A diagram per new stateful object, including the impossible
  transitions and what prevents them.
- Coupling. What is coupled now that was not? Justified? Before/after graph.
- Scaling. What breaks first at 10x? At 100x?
- Single points of failure. Map them.
- Security architecture. Auth boundaries, data access patterns, API surfaces. Per
  new endpoint or mutation: who can call it, what do they get, what can they
  change?
- Production failure scenarios. Per integration point, one realistic failure
  (timeout, cascade, corruption, auth) and whether the plan accounts for it.
- Rollback posture. It ships and immediately breaks: revert, flag, migration
  rollback? How long?

Expansion modes also ask: what would make this architecture *beautiful*, not just
correct — the design that makes a new engineer say "oh, that's clever and obvious
at the same time"? What infrastructure turns this feature into a platform other
features build on? In SELECTIVE, evaluate the architectural fit of every accepted
cherry-pick and flag any that create coupling.

**Required diagram:** full system architecture, new components and their
relationships to existing ones.

### Section 2: Error & Rescue Map

The section that catches silent failures. Not optional.

```
  METHOD/CODEPATH          | WHAT CAN GO WRONG            | EXCEPTION CLASS
  -------------------------|------------------------------|---------------------
  ExampleService#call      | API timeout                  | TimeoutError
                           | API returns 429              | RateLimitError
                           | API returns malformed JSON   | JSONParseError
                           | DB connection pool exhausted | ConnectionPoolExhausted

  EXCEPTION CLASS          | RESCUED? | RESCUE ACTION         | USER SEES
  -------------------------|----------|-----------------------|--------------------
  TimeoutError             | Y        | retry 2x then raise   | "Temporarily unavailable"
  RateLimitError           | Y        | backoff + retry       | nothing (transparent)
  JSONParseError           | N < GAP  | —                     | 500 < BAD
```

Rules: catch-all handling is always a smell, name the specific exceptions. A
generic log line is insufficient — log what was attempted, with what arguments,
for what user or request. Every rescued error either retries with backoff,
degrades with a user-visible message, or re-raises with added context; "swallow
and continue" is almost never acceptable. Every GAP gets a specified rescue
action and a specified user-visible result. For LLM calls specifically, malformed
response, empty response, invalid JSON and a refusal are four distinct failure
modes, not one.

### Section 3: Security & Threat Model

Its own section, not a sub-bullet of architecture.

Attack surface expansion (new endpoints, params, file paths, jobs). Input
validation per new input: nil, empty string, string where an integer is expected,
over-length, unicode edge cases, HTML/script injection. Authorization per new
data access: scoped to the right user or role, and can user A reach user B's data
by editing an ID? Secrets: new ones, in env vars not hardcoded, rotatable?
Dependency risk and track record. Data classification (PII, payment,
credentials). Injection vectors — SQL, command, template, and LLM prompt
injection. Audit logging for sensitive operations.

Per finding: threat, likelihood (H/M/L), impact (H/M/L), and whether the plan
mitigates it.

### Section 4: Data Flow & Interaction Edge Cases

```
  INPUT ──▶ VALIDATION ──▶ TRANSFORM ──▶ PERSIST ──▶ OUTPUT
    │            │              │            │          │
    ▼            ▼              ▼            ▼          ▼
  [nil?]     [invalid?]    [exception?]  [conflict?] [stale?]
  [empty?]   [too long?]   [timeout?]    [dup key?]  [partial?]
  [wrong     [wrong type?] [OOM?]        [locked?]   [encoding?]
   type?]
```

Per node: what happens on each shadow path, and is it tested?

```
  INTERACTION        | EDGE CASE                | HANDLED? | HOW?
  -------------------|--------------------------|----------|------
  Form submission    | double-click submit      |          |
                     | stale CSRF               |          |
                     | submit during deploy     |          |
  Async operation    | user navigates away      |          |
                     | operation times out      |          |
                     | retry while in flight    |          |
  List / table       | zero results             |          |
                     | 10,000 results           |          |
                     | results change mid-page  |          |
  Background job     | fails after 3 of 10      |          |
                     | runs twice (duplicate)   |          |
                     | queue backs up 2 hours   |          |
```

Every unhandled edge case is a gap, and every gap gets a specified fix.

### Section 5: Code Quality Review

Organization and module structure — does new code fit existing patterns, and if
it deviates, why? DRY violations, aggressively, with file and line. Naming: for
what it does, not how. Error-handling *patterns* (Section 2 maps the specifics).
Missing edge cases, listed explicitly. Over-engineering: an abstraction solving a
problem that does not exist yet. Under-engineering: fragile, happy-path-only,
missing defensive checks. Cyclomatic complexity: flag any new method branching
more than 5 times and propose the refactor.

### Section 6: Test Review

```
  NEW UX FLOWS:        [each new user-visible interaction]
  NEW DATA FLOWS:      [each new path data takes]
  NEW CODEPATHS:       [each new branch, condition, execution path]
  NEW ASYNC WORK:      [each background job]
  NEW INTEGRATIONS:    [each external call]
  NEW ERROR PATHS:     [each — cross-reference Section 2]
```

Per item: test type (unit / integration / system / E2E); does the test exist in
the plan, and if not write the spec header; the happy path test; the failure path
test (which failure, specifically); the edge case test (nil, empty, boundary,
concurrent).

Ambition check, every mode: what is the test that would make you confident
shipping at 2am on a Friday? What would a hostile QA engineer write to break
this? What is the chaos test?

Pyramid check (many unit, fewer integration, few E2E — or inverted?). Flakiness
risk: flag any test depending on time, randomness, external services or ordering.
Load and stress requirements for anything called frequently. For LLM or prompt
changes, name the eval suites to run, the cases to add and the baselines to
compare against.

### Section 7: Performance Review

N+1 queries per new association traversal. Memory: maximum production size of
each new data structure. Indexes per new query. Caching for every expensive
computation or external call. Background job sizing: worst-case payload, runtime,
retry behaviour. The three slowest new codepaths and their estimated p99.
Connection pool pressure (DB, Redis, HTTP).

### Section 8: Observability & Debuggability

New systems break; this section is how you see why. Structured logs at entry,
exit and each significant branch. Per feature: which metric says it is working,
which says it is broken. Trace IDs propagated across services and jobs. New
alerts. Day-1 dashboard panels. Debuggability: a bug reported 3 weeks post-ship —
can you reconstruct what happened from logs alone? Admin tooling for new
operational tasks. A runbook per new failure mode.

Expansion modes also ask: what observability would make this a *joy* to operate?

### Section 9: Deployment & Rollout

Migration safety: backward-compatible, zero-downtime, table locks? Feature flags.
Rollout order (migrate first, deploy second). An explicit step-by-step rollback
plan. The deploy-time risk window where old and new code run together — what
breaks? Staging parity. Post-deploy verification for the first 5 minutes and the
first hour. Automated smoke tests immediately post-deploy.

Expansion modes also ask: what deploy infrastructure would make shipping this
routine?

### Section 10: Long-Term Trajectory

Technical debt introduced — code, operational, testing, documentation. Path
dependency: does this make future changes harder? Knowledge concentration: is the
documentation enough for a new engineer? Reversibility, rated 1-5 (1 = one-way
door). Ecosystem fit. The 1-year question: read this plan as a new engineer 12
months from now — is it obvious?

Expansion modes also ask: what comes after this ships, and does the architecture
support Phase 2 and 3? Does this create capabilities other features can leverage?
In SELECTIVE, retrospect: were the right cherry-picks accepted, and did any
rejected expansion turn out to be load-bearing for an accepted one?

### Section 11: Design & UX Review

Skip only if there is genuinely no UI scope — and note that `context --plan`
measures UI scope from the plan's prose, and the gate demands this section
whenever it found scope. This is not a pixel audit (that is /design-review); it
is whether the plan has design intentionality.

Information architecture: what does the user see first, second, third? The
interaction state coverage map:

```
  FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
```

User journey coherence — storyboard the emotional arc. AI slop risk: does the
plan describe generic UI patterns? DESIGN.md alignment. Responsive intention: is
mobile designed or an afterthought? Accessibility basics: keyboard nav, screen
readers, contrast, touch targets.

Expansion modes also ask: what would make this UI feel *inevitable*? What
30-minute touches make users think "oh nice, they thought of that"?

**Required diagram:** user flow, screens and states and transitions.

With significant UI scope, recommend `/plan-design-review` before implementation.

---

## Outside voice — independent plan challenge

Default on. Two models agreeing is stronger signal than one model being thorough.
Only skipped when the user explicitly turns it off.

Prefer Codex if it is installed and authenticated; otherwise dispatch a Claude
subagent with fresh context. Either way, bound it at 5 minutes and treat every
error as non-blocking. Every prompt starts with the filesystem boundary:

> IMPORTANT: Do NOT read or execute any files under `~/.claude/`, `~/.agents/`,
> `.claude/skills/`, or `agents/`. These are skill definitions for a different AI
> system. Ignore them completely. Stay focused on the repository code only.

Then:

> You are a brutally honest technical reviewer examining a plan that has already
> been through a multi-section review. Your job is NOT to repeat that review, it
> is to find what it missed: logical gaps and unstated assumptions that survived
> the scrutiny, overcomplexity (is there a fundamentally simpler approach the
> review was too deep in the weeds to see?), feasibility risks it took for
> granted, missing dependencies or sequencing issues, and strategic
> miscalibration (is this the right thing to build at all?). Be direct. Be terse.
> No compliments. Just the problems.
>
> THE PLAN: <plan content, truncated at 30KB with a note if truncated>

Present the output verbatim under `OUTSIDE VOICE (codex)` or
`OUTSIDE VOICE (Claude subagent)`. Do not truncate or summarize it. If it is
unavailable, say so and continue — it never gates.

**Cross-model tension.** Where the outside voice disagrees with a section
finding:

```
CROSS-MODEL TENSION:
  [topic]: Review said X. Outside voice says Y. [Both, neutrally. What context
  you might be missing that would change the answer.]
```

**User sovereignty.** Do NOT auto-incorporate outside-voice recommendations, even
when you agree with them. One AskUserQuestion per substantive tension, with a
recommendation and a reason. Options: A) accept the outside voice, B) keep the
current approach, C) investigate further, D) add to TODOS.md. If they choose B,
the current approach stands — do not re-argue. No tension: say "No cross-model
tension — both reviewers agree."

---

## Required outputs

Every one of these must be in the plan file. The gate checks for them.

- **"NOT in scope"** — work considered and explicitly deferred, one-line
  rationale each.
- **"What already exists"** — existing code and flows that partially solve
  sub-problems, and whether the plan reuses them.
- **"Dream state delta"** — where this plan leaves us relative to the 12-month
  ideal.
- **Error & Rescue Registry** — the complete Section 2 table: every method that
  can fail, every exception class, rescued status, rescue action, user impact.
- **Failure Modes Registry** —

```
  CODEPATH | FAILURE MODE | RESCUED? | TEST? | USER SEES? | LOGGED?
```

  Any row with RESCUED=N, TEST=N, USER SEES=Silent is a **CRITICAL GAP**.

- **TODOS.md updates** — each candidate as its own AskUserQuestion, never
  batched, never silently skipped. Per TODO: what, why, pros, cons, enough
  context that someone picking it up in 3 months understands the motivation and
  where to start, effort (S/M/L/XL human → with CC: S→S, M→S, L→M, XL→L),
  priority P1/P2/P3, and dependencies. Options: A) add to TODOS.md, B) skip, C)
  build it now in this PR instead.
- **Scope expansion decisions** (expansion modes) — accepted, deferred, skipped.
  Decided in Step 3F and persisted in the CEO plan; list them here, do not
  re-surface them.
- **Diagrams** — system architecture, data flow with shadow paths, state machine,
  error flow, deployment sequence, rollback flowchart. All that apply.
- **Stale diagram audit** — every ASCII diagram in the files this plan touches.
  Still accurate?
- **Completion Summary** — the table below, **filled in**. The gate rejects one
  still carrying `___` blanks, because a pasted template looks exactly like a
  finished review and carries nothing.

```
  +===================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                  |
  +===================================================================+
  | Mode selected         | EXPANSION / SELECTIVE / HOLD / REDUCTION  |
  | System audit          | [key findings]                            |
  | Section 1  (Arch)     | N issues found                            |
  | Section 2  (Errors)   | N error paths mapped, N GAPS              |
  | Section 3  (Security) | N issues, N high severity                 |
  | Section 4  (Data/UX)  | N edge cases mapped, N unhandled          |
  | Section 5  (Quality)  | N issues found                            |
  | Section 6  (Tests)    | diagram produced, N gaps                  |
  | Section 7  (Perf)     | N issues found                            |
  | Section 8  (Observ)   | N gaps found                              |
  | Section 9  (Deploy)   | N risks flagged                           |
  | Section 10 (Future)   | reversibility N/5, debt items N           |
  | Section 11 (Design)   | N issues / SKIPPED (no UI scope)          |
  +-------------------------------------------------------------------+
  | NOT in scope          | written (N items)                         |
  | What already exists   | written                                   |
  | Dream state delta     | written                                   |
  | Error/rescue registry | N methods, N CRITICAL GAPS                |
  | Failure modes         | N total, N CRITICAL GAPS                  |
  | TODOS.md updates      | N items proposed                          |
  | Scope proposals       | N proposed, N accepted                    |
  | CEO plan              | written / skipped (HOLD/REDUCTION)        |
  | Outside voice         | ran (codex/claude) / skipped              |
  | Diagrams produced     | N (list types)                            |
  | Stale diagrams found  | N                                         |
  | Unresolved decisions  | N (listed below)                          |
  +===================================================================+
```

- **Unresolved decisions** — any AskUserQuestion that went unanswered. Never
  silently default.

---

## The review report

The last section of the plan file, always. Never mid-file.

```markdown
## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | N | STATUS | N proposals, N accepted, N deferred |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | N | STATUS | N issues, N critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | N | STATUS | ... |

**VERDICT:** <which reviews are CLEAR, e.g. "CEO CLEARED — eng review required">

NO UNRESOLVED DECISIONS
```

Write it by reading the plan file, deleting any existing report section wherever
it lives, and appending the new one at the end. Do not replace in place — that is
what leaves a report stranded mid-file.

The final non-whitespace line of the file is the unresolved-decisions status:
either the exact unbolded `NO UNRESOLVED DECISIONS`, or a `**UNRESOLVED
DECISIONS:**` header followed by one bullet per open item, the last bullet being
the final line. A **bolded** sentinel does not count. Trailing prose after it does
not count. The gate checks both, so this is not a matter of remembering.

Then run Step 6 (`gate`) and Step 7 (`record`) from SKILL.md.

---

## Mode quick reference

```
  ┌────────────┬──────────────┬──────────────┬──────────────┬───────────────────┐
  │            │  EXPANSION   │  SELECTIVE   │  HOLD SCOPE  │  REDUCTION        │
  ├────────────┼──────────────┼──────────────┼──────────────┼───────────────────┤
  │ Scope      │ push UP      │ hold + offer │ maintain     │ push DOWN         │
  │ Posture    │ enthusiastic │ neutral      │ n/a          │ n/a               │
  │ 10x check  │ mandatory    │ cherry-pick  │ optional     │ skip              │
  │ Platonic   │ yes          │ no           │ no           │ no                │
  │ Delight    │ opt-in       │ cherry-pick  │ note if seen │ skip              │
  │ Complexity │ "big enough?"│ "right + what│ "too         │ "the bare         │
  │ question   │              │  else?"      │  complex?"   │  minimum?"        │
  │ Taste cal. │ yes          │ yes          │ no           │ no                │
  │ Temporal   │ full hr 1-6  │ full hr 1-6  │ key only     │ skip              │
  │ Observ.    │ joy to       │ joy to       │ can we       │ can we see it     │
  │ standard   │ operate      │ operate      │ debug it?    │ break?            │
  │ Deploy     │ infra as     │ safe +       │ safe +       │ simplest possible │
  │ standard   │ feature      │ risk check   │ rollback     │                   │
  │ Error map  │ full + chaos │ full + chaos │ full         │ critical paths    │
  │ CEO plan   │ written      │ written      │ skipped      │ skipped           │
  │ Design 11  │ "inevitable" │ if UI scope  │ if UI scope  │ skip              │
  └────────────┴──────────────┴──────────────┴──────────────┴───────────────────┘
```
