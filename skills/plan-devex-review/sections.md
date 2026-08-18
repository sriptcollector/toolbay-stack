# plan-devex-review: the eight passes

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The eight passes, their evaluation criteria, the anti-skip rule,
the question rules, the required outputs, the DX Scorecard, the DX Implementation
Checklist and the Claude Code skill appendix come from
`plan-devex-review/sections/review-sections.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The measured inputs each pass is required to quote, and the gate
that reads the outputs off disk, are new. Not affiliated with or endorsed by
Garry Tan. See NOTICE.

**Anti-skip rule.** Never condense, abbreviate or skip a pass, whatever the plan
type. "This is a strategy doc so the DX passes do not apply" is always wrong: DX
gaps are exactly where adoption breaks down. A pass with nothing in it says "no
issues found" and moves on — but it gets evaluated.

**No shortcut clause.** Do not summarise a pass you did not run. Do not write a
score you did not derive. If a measurement in Step 3 failed, say the score is
UNSCORED and say why; an UNSCORED dimension is a real answer and a guessed one is
not.

**Load the reference per pass, do not recall it:**

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs ref --pass N
```

Exit 2 means the reference could not be read. Stop the pass and say so rather
than scoring against remembered gold standards.

---

## Pass 1: Getting started (zero friction)

**Rate 0-10: can this developer go from zero to hello world inside the tier
chosen in 4C?**

Required inputs, quoted not remembered: the `tthw` output from Step 3B, the tier
from 4C, the vehicle from 4D, and the Install / Hello World friction from 4F.

**If `tthw` exited 1, this pass cannot score above 3.** A documented path with a
step that does not run has a TTHW of infinity for every developer who tries it in
the state the repo is actually in. Fix the blocking findings first, then rate.

Evaluate:
- **Installation** — one command? one click? prerequisites that nothing checks for?
- **First run** — does the first command produce visible, meaningful output?
- **Sandbox** — can they try before installing?
- **Free tier** — no credit card, no sales call, no company email? (`tthw` flags these as `gs.access-gate`)
- **Quick start** — copy-paste complete? shows real output? (`tthw` flags `gs.placeholder` when it is not pasteable)
- **Credential bootstrapping** — how many steps between "I want to try" and "it works"?
- **Magical moment** — is 4D's vehicle actually in the plan, or just admired?
- **Competitive gap** — how far is the measured step count from 4C's tier?

FIX TO 10: write the ideal sequence. Exact commands, expected output, a time
budget per step. Target three steps or fewer, under 4C's tier.

**The Stripe test:** can the persona go from "never heard of this" to "it worked"
in one terminal session without leaving the terminal?

**STOP.** One AskUserQuestion per issue. Recommend, and say why, naming the persona.

## Pass 2: API / CLI / SDK design (usable and useful)

**Rate 0-10: is the interface intuitive, consistent and complete?**

Evidence recall: does the surface match the persona's mental model? A YC founder
expects `tool.do(thing)`. A platform engineer expects
`tool.configure(options).execute(thing)`.

Evaluate:
- **Naming** — guessable without docs? consistent grammar?
- **Defaults** — every parameter has one? does the simplest call give a useful result?
- **Consistency** — the same patterns across the whole surface?
- **Completeness** — full coverage, or do developers drop to raw HTTP for edge cases?
- **Discoverability** — can they explore from the CLI or a playground without docs?
- **Reliability** — latency, retries, rate limits, idempotency, offline behaviour?
- **Progressive disclosure** — the simple case is production-ready, complexity arrives gradually?
- **Cross-platform** — if the interface is shell, has it been run anywhere but macOS?

**The test:** can the persona use this correctly after seeing one example?

**STOP.** One AskUserQuestion per issue.

## Pass 3: Error messages and debugging (fight uncertainty)

**Rate 0-10: when something goes wrong, does the developer learn what happened,
why, and what to do?**

Required input: the `errors` census from Step 3C. **Trace the three that scored
0**, by file and line, not three you chose. For each, show what the developer
sees now and what they should see, against the three tiers in the reference.

Also evaluate:
- **Permission / sandbox / safety model** — what can go wrong, and how clear is the blast radius?
- **Debug mode** — is verbose output available, and documented?
- **Stack traces** — useful, or internal framework noise?
- **Failure direction** — when a check in this product cannot run, does it fail closed and say so, or return an empty result that the next step treats as fact? A silent `|| echo "none found"` is a DX defect, not an implementation detail.

**STOP.** One AskUserQuestion per issue.

## Pass 4: Documentation and learning (findable, learn by doing)

**Rate 0-10: can a developer find what they need and learn by doing?**

Evidence recall: does the docs architecture match the persona's learning style? A
YC founder needs copy-paste examples first. A platform engineer needs
architecture docs and a reference.

Evaluate: information architecture (found in under two minutes?), progressive
disclosure, code examples that are copy-paste complete and work as-is (Step 3B
already told you whether the README's do), interactive elements, versioning, and
whether both tutorials and references exist.

**STOP.** One AskUserQuestion per issue.

## Pass 5: Upgrade and migration path (credible)

**Rate 0-10: can developers upgrade without fear?**

Evaluate: backward compatibility and blast radius, deprecation warnings that are
actionable ("use newMethod() instead"), a migration guide per breaking change,
codemods, and a stated versioning policy.

**STOP.** One AskUserQuestion per issue.

## Pass 6: Developer environment and tooling (valuable, accessible)

**Rate 0-10: does this fit into the workflows developers already have?**

Evaluate: editor integration (language server, autocomplete, inline docs), CI/CD
with a non-interactive mode, TypeScript types, testing and mocking support, local
development feedback loop, **cross-platform reality (macOS, Linux, Windows —
Git Bash and PowerShell are different shells and neither is zsh)**, container and
proxy reproducibility, and observability (dry-run, verbose, fixtures, sample apps).

**STOP.** One AskUserQuestion per issue.

## Pass 7: Community and ecosystem (findable, desirable)

**Rate 0-10: is there a community, and does the plan invest in it?**

Evaluate: open source and license, where developers ask questions and who
answers, runnable real-world examples beyond hello world, an extension story, a
contributing guide, and pricing transparency.

**STOP.** One AskUserQuestion per issue.

## Pass 8: DX measurement and feedback loops (implement, refine)

**Rate 0-10: does the plan include ways to measure and improve DX over time?**

Evaluate: TTHW instrumentation, journey analytics and drop-off, feedback
mechanisms, planned friction audits, and boomerang readiness — will `/devex-review`
be able to measure reality against this plan's claims?

**The trend is part of this pass.** Step 1 printed every prior DX review for this
project. If it printed none *and the directory was read*, this plan should say how
the next review will find this one.

**STOP.** One AskUserQuestion per issue.

## Appendix: Claude Code skill DX checklist

Only when Step 3A found a Claude Code skill or MCP surface. Not a scored pass.
Load it with `ref --pass "Claude Code Skill"` and check each item, explaining the
fix for anything unchecked.

---

## How to ask questions

- **One issue, one AskUserQuestion.** Never combine.
- **Ground every question in evidence.** The persona, the benchmark, the narrative, the `tthw` finding, the error census. Never ask in the abstract.
- **Frame the pain from the persona's side.** Not "developers would be frustrated" but "[persona] hits this at minute 4 and [abandons / files an issue / hacks around it]".
- Two or three options each, with effort to fix and impact on adoption.
- One sentence connecting the recommendation to a DX principle.
- Zero findings is a legitimate answer: say "no issues, moving on".
- A gap with an obvious fix is still a gap and still needs approval before it lands in the plan.
- Assume the user has not looked at this window in twenty minutes. Re-ground every question.

Number the issues, letter the options, label them together ("3B").

---

## Required outputs

These are what the gate reads. Write them into the plan file.

1. **Developer Persona Card** (4A) — the `TARGET DEVELOPER PERSONA` block, filled.
2. **Developer Perspective** (4B) — the first-person narrative, 150-250 words, corrected by the user.
3. **Competitive DX Benchmark** (4C) — at least two real competitors and a YOUR PRODUCT row.
4. **Magical Moment** (4D) — the chosen vehicle and what implementing it requires.
5. **Developer Journey Map** (4F) — six stages, real actions, every friction point resolved or deferred.
6. **First-Time Developer Confusion Report** (4G) — at least three T+ observations, annotated with what was addressed.
7. **"NOT in scope"** — DX work considered and deferred, one line of rationale each.
8. **"What already exists"** — docs, examples, error handling and DX patterns the plan should reuse.
9. **DX Scorecard** — below.
10. **DX Implementation Checklist** — below, with the values filled in.
11. **TOOLBAY DX REVIEW REPORT** — the last `##` section in the file.
12. The final line: `NO UNRESOLVED DECISIONS`, unbolded, or an `UNRESOLVED DECISIONS` block.

### TODOS.md

After the passes, present each candidate TODO as its own AskUserQuestion. Never
batch. Each gets: what, why (the concrete developer pain), pros, cons, enough
context for someone picking it up in three months, and what it depends on.
Options: add to TODOS.md / skip / build it now.

### DX Scorecard

Fill every cell. The gate rejects `__/10`, `__ min`, and the `[a/b]` option lists.

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                            |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
| Getting Started      | 8/10   | 4/10   | +4     |
| API/CLI/SDK          | .../10 | .../10 | ...    |
| Error Messages       | .../10 | .../10 | ...    |
| Documentation        | .../10 | .../10 | ...    |
| Upgrade Path         | .../10 | .../10 | ...    |
| Dev Environment      | .../10 | .../10 | ...    |
| Community            | .../10 | .../10 | ...    |
| DX Measurement       | .../10 | .../10 | ...    |
+--------------------------------------------------------------------+
| TTHW                 | 2 min  | 6 min  | -4     |
| Competitive Rank     | Competitive                                 |
| Magical Moment       | designed via copy-paste demo command        |
| Product Type         | Library/SDK  (from surface, with evidence)  |
| Mode                 | DX POLISH                                   |
| Overall DX           | 8/10   | 6/10   | +2     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                              |
| Zero Friction      | covered                                       |
| Learn by Doing     | covered                                       |
| Fight Uncertainty  | covered                                       |
| Opinionated + Escape Hatches | covered                             |
| Code in Context    | covered                                       |
| Magical Moments    | covered                                       |
+====================================================================+
```

**Prior and Trend come from Step 1's output, not from memory.** If Step 1 exited
2, leave both columns empty and write one line saying the history could not be
read. A dash in a Trend column reads as "unchanged", which is a claim.

All passes 8+: "DX plan is solid." Anything below 6: critical DX debt, name the
adoption impact. TTHW over 10 minutes: blocking.

### DX Implementation Checklist

Fill the bracketed values in. The gate rejects a checklist still saying
"[target from 0C]" or "[vehicle from 0D]".

```
DX IMPLEMENTATION CHECKLIST
[ ] Time to hello world < <the tier chosen in 4C>
[ ] Installation is one command
[ ] First run produces meaningful output
[ ] Magical moment delivered via <the vehicle chosen in 4D>
[ ] Every documented command resolves (tthw exits 0)
[ ] Every error message has: problem + cause + fix + docs link
[ ] API/CLI naming is guessable without docs
[ ] Every parameter has a sensible default
[ ] Docs have copy-paste examples that actually work
[ ] Examples show real use cases, not just hello world
[ ] Upgrade path documented with a migration guide
[ ] Breaking changes have deprecation warnings and codemods
[ ] Types included (if applicable)
[ ] Works in CI/CD without special configuration
[ ] Works on Windows, verified by running it there
[ ] Free tier available, no credit card required
[ ] Changelog exists and is maintained
[ ] Docs search works
[ ] Community channel exists and is monitored
```

### Unresolved decisions

Any AskUserQuestion that went unanswered goes here. Never silently default.

---

## Then

Run the gate (Step 6), then record (Step 7). In that order: the record is refused
while the gate fails, on purpose.
