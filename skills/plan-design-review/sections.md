# plan-design-review — the seven passes

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The seven passes, the design hard rules, the litmus checks, the
AI-slop blacklist, the one-issue-one-question rule, the required outputs, the
Approved Mockups table and the Completion Summary come from
`plan-design-review/sections/review-sections.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The mechanical checks (`states`, `slop`, `mockups`, `gate`) and
the fail-closed posture are new. Not affiliated with or endorsed by Garry Tan.
See NOTICE.

Read this file in full before running the passes. Do not work from memory.

**Anti-skip rule.** Never condense or skip a pass. "It's a strategy doc so the
design passes don't apply" is always wrong: design gaps are where implementation
breaks down. If a pass genuinely has zero findings, say "No issues found" and
move on, but evaluate it.

**Anti-shortcut rule.** The plan file is the OUTPUT of an interactive review, not
a substitute for it. Writing every finding into one plan edit and exiting is the
failure this skill exists to prevent. If you have any non-trivial finding, the
path from finding to ExitPlanMode goes THROUGH AskUserQuestion.

## The nine design principles

Every rating below traces to one of these. "This feels wrong" is not a finding
until it names the principle it breaks; taste is debuggable or it is just an
opinion someone senior happens to hold.

1. Empty states are features. "No items found." is not a design. Every empty state needs warmth, a primary action and context.
2. Every screen has a hierarchy. First, second, third. If everything competes, nothing wins.
3. Specificity over vibes. "Clean, modern UI" is not a design decision. Name the typeface, the spacing scale, the interaction.
4. Edge cases are user experiences. A 47-character name, zero results, an expired session, first run versus the thousandth.
5. AI slop is the enemy. If it looks like every other generated site, it fails, whatever the components are called.
6. Responsive is not "stacked on mobile". Each viewport gets intentional design.
7. Accessibility is not optional. Keyboard order, screen readers, contrast, touch targets. Specify them or they will not exist.
8. Subtraction default. If an element does not earn its pixels, cut it.
9. Trust is earned at the pixel level. Every interface decision builds or erodes it.

Running underneath them: empathy as simulation (bad signal, one hand free, boss
watching), constraint worship (if only three things fit, which three), the
question reflex (who is this for, what did they try before), edge-case paranoia,
and the "would I notice?" test — invisible is the highest compliment.

---

### Pass 1: Information Architecture

Rate 0-10: does the plan define what the user sees first, second, third?

FIX TO 10: add the hierarchy to the plan. An ASCII sketch of screen structure and
navigation flow. Apply constraint worship: if you can only show three things,
which three?

**STOP.** One AskUserQuestion per issue. Never batch. Recommendation plus why.

### Pass 2: Interaction State Coverage

Rate 0-10: does the plan specify loading, empty, error, success and partial?

FIX TO 10: write the table into the plan, one row per UI feature, five state
columns. Describe what the user SEES, not what the backend does. Empty states are
features: warmth, a primary action, context.

```
| FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| Saved list | three skeleton rows, no spinner | "Nothing saved yet" + Save this search | inline banner, list stays visible | rows fade in over 120ms | older rows dim while newer load |
```

Then check it, because this is the pass most likely to end up as a filled-shaped
table of placeholders:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs states --plan <plan-file>
```

Exit 1 names every cell holding `[spec]`, a dash, `TBD` or nothing, with its line
number and column. Exit 2 means the plan could not be read: fix that first, it is
not a pass. An unfilled cell is the empty state an engineer will invent, which is
how "No items found." ships.

**STOP.** One AskUserQuestion per issue.

### Pass 3: User Journey & Emotional Arc

Rate 0-10: does the plan consider what the user feels, not just what they click?

FIX TO 10: storyboard it.

```
| STEP | USER DOES | USER FEELS | PLAN SPECIFIES? |
```

Time-horizon design: the first 5 seconds (visceral), 5 minutes (behavioural),
5-year relationship (reflective). Design for all three at once.

**STOP.** One AskUserQuestion per issue.

### Pass 4: AI Slop Risk

Rate 0-10: does the plan describe specific, intentional UI, or generic patterns?

Run the mechanical half first, so the argument is about taste and not about
whether the pattern is there:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs slop --plan <plan-file>
```

It matches the blacklist and hard rules below, line by line, and does NOT flag a
plan that forbids a pattern. Exit 1 with line numbers means the plan still
specifies something this pass rejects. Exit 0 means the fifteen written-down
rules found nothing; it says nothing about whether the design is any good. That
judgment is yours and it is the reason the pass is not just a script.

**Classifier — pick the rule set before evaluating.** MARKETING/LANDING (hero
driven, brand forward) → landing rules. APP UI (workspace, data dense, task
focused) → app rules. HYBRID → landing rules for the marketing sections, app
rules for the functional ones.

**Hard rejection criteria** (instant fail if any apply):
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating the same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of a layout

**Litmus checks** (answer YES or NO for each; these are the rows of the outside-
voices scorecard, and a row of dashes is not an answer):
1. Brand/product unmistakable in the first screen?
2. One strong visual anchor present?
3. Understandable by scanning headlines only?
4. Does each section have one job?
5. Are the cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would it feel premium with every decorative shadow removed?

**Landing page rules:** first viewport reads as one composition, not a dashboard.
Brand-first hierarchy: brand > headline > body > CTA. Expressive typography, no
default stacks. No flat single-colour backgrounds. Full-bleed hero, no inset or
tiled variants. Hero budget: brand, one headline, one supporting sentence, one
CTA group, one image. No cards in the hero. One job per section. Two or three
intentional motions. CSS variables for colour, one accent. Product language, not
design commentary: if deleting 30% of the copy improves it, keep deleting.

**App UI rules:** calm surface hierarchy, strong typography, few colours. Dense
but readable, minimal chrome. Primary workspace, navigation, secondary context,
one accent. Avoid dashboard-card mosaics, thick borders, decorative gradients,
ornamental icons. Utility language: orientation, status, action.

**Universal rules:** CSS variables for the colour system. No default font stacks
(Inter, Roboto, Arial, system-ui). One job per section. Cards earn their
existence. Never body text under 16px or under 4.5:1 contrast. Never use a
placeholder as the only label. Preserve the visited/unvisited link distinction.
Never float a heading between paragraphs.

**AI slop blacklist** — the patterns that scream "generated":
1. Purple/violet/indigo gradients
2. The 3-column feature grid: icon in a coloured circle, bold title, two lines,
   three times, symmetrically. The most recognisable AI layout there is.
3. Icons in coloured circles as section decoration
4. Centred everything
5. The same large border-radius on every element
6. Decorative blobs, floating circles, wavy dividers
7. Emoji as design elements
8. Coloured left border on cards
9. Generic hero copy ("Welcome to X", "Unlock the power of…")
10. Cookie-cutter rhythm: hero → 3 features → testimonials → pricing → CTA
11. system-ui or -apple-system as the primary display face — the "I gave up on
    typography" signal

Source: OpenAI, "Designing Delightful Frontends with GPT-5.4" (Mar 2026), plus
gstack design methodology.

FIX TO 10: replace each vague description with an actual decision. "Cards with
icons" → what differentiates these from every SaaS template? "Clean, modern UI" →
meaningless, name the typeface, the scale and the interaction.

**STOP.** One AskUserQuestion per issue.

### Pass 5: Design System Alignment

Rate 0-10: does the plan align with DESIGN.md?

FIX TO 10: annotate with specific tokens and components. If there is no
DESIGN.md, say so plainly and recommend /design-consultation rather than rating
the plan against a system that does not exist. Flag every new component: does it
fit the existing vocabulary, or is it a second way to do something?

**STOP.** One AskUserQuestion per issue.

### Pass 6: Responsive & Accessibility

Rate 0-10: does the plan specify mobile and tablet, keyboard navigation, screen
readers, contrast, touch targets?

FIX TO 10: per-viewport layout intent, not "stacked on mobile". Keyboard order
and focus states. ARIA landmarks. 44px minimum touch targets. Contrast
requirements as numbers. Anything not written here does not get built.

**STOP.** One AskUserQuestion per issue.

### Pass 7: Unresolved Design Decisions

Surface the ambiguities that will haunt implementation.

```
| DECISION NEEDED | IF DEFERRED, WHAT HAPPENS |
| Empty state for Saved? | engineer ships "No items found." |
| Mobile nav pattern? | desktop nav hides behind a hamburger |
```

Each decision is one AskUserQuestion with a recommendation, the reason, and the
alternatives. Edit the plan as each is answered. Never silently default.

---

## The 0-10 method

For each pass: rate, then say **what would make it a 10** for THIS plan, then do
the work, then re-rate. A rating with no gap statement is a number, not a review.

1. "Information Architecture: 4/10"
2. "It is a 4 because no screen defines primary/secondary/tertiary. A 10 has that
   for every screen, including the 640px layout."
3. Edit the plan.
4. "Now 8/10 — still missing mobile nav hierarchy."
5. AskUserQuestion where there is a genuine design choice.

## How to ask

* **One issue = one AskUserQuestion.** Never combine.
* Describe the gap concretely: what is missing, what the user will experience.
* Two or three options; for each, the effort to specify now and the risk if
  deferred.
* Tie the recommendation to a named principle in one sentence. Taste is
  debuggable: "this feels wrong" always traces to a broken principle.
* Label issue number + option letter (3A, 3B).
* A gap with an obvious fix is still a gap and still needs approval before it
  lands in the plan.

## Required outputs

**"What already exists"** — the DESIGN.md, patterns and components this plan
should reuse instead of reinventing.

**"NOT in scope"** — design decisions considered and deliberately deferred, one
line of rationale each. An intention that is not written down is not a decision.

**Approved Mockups** — if mockups were generated and chosen, record them so the
implementer can build from them in a later session:

```markdown
## Approved Mockups

| Screen | Mockup Path | Direction | Notes |
|---|---|---|---|
| Drawer | C:/Users/you/.gstack/projects/<slug>/designs/drawer-20260814/variant-B.png | quiet surface, one accent | no cards |
```

Then verify it, because this table is the whole handoff:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs mockups --plan <plan-file>
```

Absolute paths only. Never a temp directory: gstack's own "show me what 10/10
looks like" step writes to `/tmp/gstack-ideal-<dimension>.png`, and on Windows
that string does not even name the same directory to the shell that wrote it and
the agent that reads it. `mockups` refuses placeholders, dangling paths, temp
locations, files that are not decodable images, and images too small to be a
screen.

**Implementation tasks** — a flat list, each derived from a specific finding, no
padding. P1 blocks ship, P2 lands on the same branch, P3 is a follow-up.

```markdown
- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — <component> — <imperative title>
  - Surfaced by: <pass> — <the finding>
  - Files: <paths>
  - Verify: <command or manual check>
```

And the JSONL artifact /autoplan aggregates, written without jq:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs task \
  --file <tasks-file-from-context> --id T1 --priority P1 --component saved-drawer \
  --title "specify the empty state for Saved" \
  --source-finding "Pass 2: EMPTY cell was blank" --files src/ui/Drawer.tsx
```

If this review found nothing actionable, write the empty artifact on purpose:
`task --file <tasks-file> --none`. Empty means "ran, no findings". Missing means
"never ran". They are different and the aggregator reads the difference.

**Completion Summary** — fill every cell. A row still reading `___/10` is the
review impersonating itself.

```
| DESIGN PLAN REVIEW — COMPLETION SUMMARY                |
| Pass 1 (Info Arch)  | 4/10 -> 9/10 after fixes         |
| Pass 2 (States)     | 2/10 -> 9/10 after fixes         |
| Pass 3 (Journey)    | 6/10 -> 8/10 after fixes         |
| Pass 4 (AI Slop)    | 7/10 -> 9/10 after fixes         |
| Pass 5 (Design Sys) | 8/10 -> 9/10 after fixes         |
| Pass 6 (Responsive) | 3/10 -> 8/10 after fixes         |
| Pass 7 (Decisions)  | 4 resolved, 1 deferred           |
| NOT in scope        | written (3 items)                |
| What already exists | written                          |
| Approved mockups    | 3 generated, 1 approved          |
| Overall             | 4/10 -> 9/10                     |
```

If every pass is 8+ and nothing is open, say so and recommend /design-review
after implementation for the visual QA pass. If anything is below 8, name what is
unresolved and why the user chose to defer it.

## The review report

The report is the LAST `## ` section of the plan file. Delete any existing one
first, then append; never replace in place, or an older report keeps its position
mid-file.

```markdown
## TOOLBAY REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Design Review | /plan-design-review | UI/UX gaps | 1 | CLEAR | score 4/10 -> 9/10, 5 decisions |

**VERDICT:** DESIGN CLEARED — ready for eng review.

NO UNRESOLVED DECISIONS
```

The final non-whitespace line of the file is the unresolved-decisions status:
either the exact unbolded `NO UNRESOLVED DECISIONS`, or the last bullet of a
`**UNRESOLVED DECISIONS:**` block. A bolded sentinel does not count. Trailing
prose after it does not count. `gate` checks this by reading the file, which is
the only way it gets checked at all.

## Then run the gate

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs gate \
  --plan <plan-file> --tasks <tasks-file>
```

Exit 0 allows ExitPlanMode. Exit 1 lists what is missing; fix it and run again.
Exit 2 means the gate could not read the plan, which is not permission to
proceed. Then, and only then:

```bash
node ~/.claude/skills/plan-design-review/scripts/tb-plan-design.mjs record \
  --plan <plan-file> --initial-score 4 --overall-score 9 --decisions-made 5
```

`record` re-runs the gate and writes nothing if it fails, so a review record in
the dashboard means a review that actually produced its outputs.

## Next steps

Recommend /plan-eng-review (the required gate) whenever this review added
interaction specifications, new flows, or changed the information architecture.
Recommend /plan-ceo-review only if the design review revealed a product-direction
gap: the initial score was below 4, the information architecture had structural
problems, or the review raised whether the right problem is being solved. Most
design reviews should not trigger a CEO review. Recommend /design-shotgun when
the plan needs directions explored rather than gaps closed, and /design-review
after implementation for the live visual audit.
