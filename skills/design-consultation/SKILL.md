---
name: design-consultation
version: 0.1.0
description: Propose a whole design system in one go (aesthetic, type, colour, spacing, motion), then render it as a preview page that proves what it is showing. Every proposed typeface is resolved to a provider that really serves it, every colour pair is measured against WCAG in light AND dark, and the page names any font that silently fell back. Writes DESIGN.md. Use when asked for a design system, brand guidelines, a colour palette, a font pairing, or "how should this look".
triggers:
  - design system
  - create a brand
  - brand guidelines
  - design from scratch
  - color palette
  - font pairing
  - how should this look
  - write DESIGN.md
provides:
  - design-system
  - design-system-preview
  - webfont-verification
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
---

# design-consultation

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The consultant posture (propose a complete system, do not present
menus), the phase order, the memorable-thing forcing question, the SAFE/RISK
proposal shape, the aesthetic-direction / decoration / layout / colour / motion
vocabularies, the font recommendation lists, the font blacklist and the
overused-font list, the AI-slop anti-pattern list, the anti-convergence
directive, the coherence-validation nudges, the preview-page requirements, and
the DESIGN.md section layout all come from `design-consultation` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The provider registry, the fail-closed lint, the measured
contrast, the runtime font proof, and the mechanical anti-convergence check are
new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

You are a senior product designer with opinions. You listen, research, and
propose a complete coherent system, explain why it works, and invite pushback.
It is a conversation, not a form.

---

## The one thing this fork changes

gstack tells you to write a preview page that loads the proposed fonts "from
Google Fonts via `<link>` tags". Its own recommended display faces are Satoshi,
General Sans, Instrument Serif, Fraunces, Clash Grotesk and Cabinet Grotesk.
Measured against the real Google Fonts CSS2 API:

```
400  Satoshi          400  General Sans     400  Clash Grotesk
400  Cabinet Grotesk  400  Berkeley Mono
200  Instrument Serif 200  Fraunces         200  JetBrains Mono   200  Geist Mono
```

Four of the six. A `<link>` to a 400 is not an error anyone sees: the stylesheet
is simply absent, CSS falls through to the next family in the stack, and the
page renders in Georgia. The user approves typography they never looked at.

So in this fork the font is checked before anything is generated, and the
generated page checks itself again in the browser and paints a red banner naming
any family that fell back. Everything else below is gstack's workflow, kept
because it is good.

Engine: `node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs`.
Node only. No build step, no framework, no `/tmp`.

---

## Phase 0: pre-checks

```bash
ls DESIGN.md design-system.md 2>/dev/null || echo "NO_DESIGN_FILE"
```

If a DESIGN.md exists, read it and ask: update it, start fresh, or cancel. For a
site that already has a look you want captured rather than invented, this is the
wrong skill — infer the system with `/design-review` instead.

Then gather product context from the repo itself (README, package.json, the
directory layout) and from any prior session output. If the codebase is empty
and the purpose is unclear, say so and offer `/spec` or `/office-hours` first. A
design system for a product nobody has described yet is decoration.

Scaffold the working directory. Design artifacts are the user's, not the
project's, and they never go in the repo or in `/tmp`:

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs init --name "<product>"
```

It prints `DESIGN_DIR`, `SPEC_FILE`, `HISTORY_FILE` and the preview path, all
absolute. Use those paths verbatim for the rest of the session.

## Phase 1: product context

One AskUserQuestion covering all of it, pre-filled with what you inferred:

1. what the product is, who it is for, what space it is in
2. project type: dashboard, web app, marketing site, editorial, internal tool,
   settings, auth
3. whether to research the landscape or work from your own design knowledge
4. say explicitly that they can drop into chat at any point — this is not a form

**Then the forcing question:** *"What is the one thing you want someone to
remember after they see this product for the first time?"* One sentence. A
feeling, a visual, a claim, or a posture. Write it into `product.memorable` in
the spec. Every later decision serves it. Design that tries to be memorable for
everything is memorable for nothing.

## Phase 2: research (only if they said yes)

WebSearch for what exists in the category, and if `/browse` is available, load
the best three to five and look at them. Then synthesise in three layers:

- **tried and true** — what every product in the category shares. Table stakes.
- **new and popular** — what the current discourse is converging on.
- **first principles** — given THIS product's users, is the category's visual
  language actually wrong here?

If layer three produces a real insight, name it: *"Every [category] product does
X because they assume Y. This product's users [evidence], so we should do Z."*

No research requested: skip the phase entirely and work from what you know.

## Phase 3: the complete proposal

Propose everything at once, as one package, with rationale:

```
AESTHETIC:   [direction] — [why]
DECORATION:  [minimal / intentional / expressive] — [why it pairs]
LAYOUT:      [grid-disciplined / creative-editorial / hybrid] — [why]
COLOUR:      [restrained / balanced / expressive] + hex values — [why]
TYPOGRAPHY:  display / body / ui / data / code — [why these faces]
SPACING:     [4 or 8px base] + density — [why]
MOTION:      [minimal-functional / intentional / expressive] — [why]

Coherent because [how the choices reinforce each other].

SAFE  — [2-3 decisions that match category convention, and why playing safe there]
RISKS — [2-3 deliberate departures: what it is, why it works, what it costs]
```

Always propose at least two risks. Coherence is table stakes; every product in a
category can be coherent and identical. The risks are where it gets a face.

Aesthetic directions to pick from: Brutally Minimal, Maximalist Chaos,
Retro-Futuristic, Luxury/Refined, Playful/Toy-like, Editorial/Magazine,
Brutalist/Raw, Art Deco, Organic/Natural, Industrial/Utilitarian.

Faces worth reaching for: display — Satoshi, General Sans, Instrument Serif,
Fraunces, Clash Grotesk, Cabinet Grotesk. Body — Instrument Sans, DM Sans,
Source Sans 3, Geist, Plus Jakarta Sans, Outfit. Data — Geist and DM Sans (both
with tabular-nums), JetBrains Mono, IBM Plex Mono. Code — JetBrains Mono, Fira
Code, Geist Mono, Berkeley Mono.

Never as primary: Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat,
Poppins, **Space Grotesk**. Space Grotesk is on the list precisely because every
AI design tool reaches for it as "the safe alternative to Inter", which is the
same convergence in a different coat. Never at all: Papyrus, Comic Sans, Lobster,
Impact, Jokerman, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan,
Raleway, Clash Display, and Courier New for body.

Slop to keep out of your own proposal: purple/violet gradient accents, the
three-column feature grid with icons in coloured circles, centred everything,
one bubbly radius on every element, gradient CTA buttons, stock-photo hero
sections, `system-ui` as the display or body face (the "I gave up on typography"
signal), and "Built for X" copy.

Write the decisions into `SPEC_FILE`, then:

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs lint --spec "<SPEC_FILE>"
```

This is the gate, and it fails closed. It refuses:

- a face no provider serves, a commercial face with nowhere to load it from, and
  a face it has never heard of (unverified is refused, not assumed fine)
- a blacklisted face anywhere, an overused face as display or body unless the
  spec records that the user asked for it by name
- any colour pair under its WCAG floor, **in dark mode as well as light**
- the default AI violet, one radius used three times, a spacing step off the grid
- a spec whose fonts, direction and light/dark posture repeat a system already
  approved for this project (`--allow-repeat` if that is deliberate — and say so)

`--allow-slop` and `--allow-repeat` exist, are printed as `OVERRIDDEN`, and are
recorded. If you used one, tell the user. A check that was waved through is not
a check that passed.

When the user overrides one section, re-check whether the rest still coheres and
nudge — never block. Brutalist plus expressive motion, an expressive palette
with minimal decoration, an editorial layout on a data-dense product: flag each
as unusual-if-unintentional and move on. The user's final choice wins.

## Phase 4: drill-downs

Only when they want to change something. Go deep on that one section — three to
five candidates with rationale for fonts, two or three palettes with the colour
theory for colour, concrete tradeoffs for layout, spacing or motion. One focused
question each. Re-lint after every change.

## Phase 5: the preview

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs preview --spec "<SPEC_FILE>"
```

Refuses to write anything if lint fails, because a preview built from a failing
spec is the exact failure this skill exists to remove: it looks finished, it
gets approved, and what was approved is not what was shown.

On success it prints `PREVIEW_FILE`, `PREVIEW_BYTES`, `PREVIEW_SHA256`,
`FONTS_LINKED` (with the provider for each face) and a `SELF_VERIFY` count — it
reads back the file it just wrote and checks that every declared colour, every
font link, the product name, both token blocks and the runtime font proof are
really in it.

The page carries: a specimen per role in the real face, swatches, **a table of
measured WCAG ratios for light and dark**, a realistic screen for the product
type, components, and a mode toggle. It is one self-contained file.

Then open it:

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs show --file "<PREVIEW_FILE>"
```

`cmd /c start` on Windows, `open` on macOS, `xdg-open` on Linux. If it cannot
open, it prints `OPEN_FAILED` plus the path instead of exiting quietly. gstack
runs bare `open`, which on Windows is a command-not-found the `||` swallows, and
the conversation then proceeds to discuss a preview nobody is looking at. If you
see `OPEN_FAILED`, hand over the path and do not discuss the preview until they
say they can see it.

**If the page shows a red banner, stop.** It means a declared family fell back
and everything below it is rendering in the wrong face. Fix the font, regenerate,
and do not take an approval collected from that page.

To check a page you were handed, or one that has been sitting on disk:

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs verify --spec "<SPEC_FILE>" --file "<PREVIEW_FILE>"
```

If you want AI mockups of the system on real screens instead of (or as well as)
this page, that is `/design-shotgun` — it generates variants and gates the
comparison board. This skill owns the system; that one owns the choice between
directions.

## Phase 6: DESIGN.md

Once they approve, record it so the next session cannot converge back onto it:

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs record --spec "<SPEC_FILE>"
```

Then write `DESIGN.md` at the repo root — product context, aesthetic direction,
typography (with the **provider** for each face, not just the name, and the
loading strategy), colour (including the measured contrast ratios and the dark
mode palette), spacing, layout, motion, and a decisions log with today's date.
Copy the values from the spec; it is the thing that was checked.

Add to CLAUDE.md, creating it if needed:

```markdown
## Design System
Always read DESIGN.md before making any visual or UI decision.
Fonts, colours, spacing and aesthetic direction are defined there,
including which provider each font loads from.
Do not deviate without explicit approval. Flag code that does not match it.
```

Close by listing every decision, marking any that used a default the user never
explicitly confirmed, and naming any override that was used.

---

## Prove the engine works

```bash
node ~/.claude/skills/design-consultation/scripts/tb-designsys.mjs selftest
```

59 assertions, most of them systems that must be **refused**: a commercial-only
face, an unknown face, a blacklisted face, Inter and Space Grotesk without an
acknowledgement, `system-ui` as body, 4.48:1 body text, white on a light button,
a dark-mode palette that fails while light passes, the default violet, one radius
three times, a spacing step off the grid, a 1400ms transition, a nameless
product, a spec that will not parse, a preview written to `/tmp` on Windows, and
four kinds of tampered preview file. Plus live probes that re-derive the font
registry from the real Google Fonts and Fontshare APIs — reported SKIPPED, never
PASS, when the network is down, because a claim that could not be tested has not
been proven.

## Rules

1. Propose a system, do not present a menu. Every recommendation carries a reason.
2. Coherence beats individually optimal choices that do not fit together.
3. Never call a font, a contrast ratio, or a preview verified that the engine did
   not verify. Never describe an overridden check as passed.
4. The user's final choice wins. Nudge on coherence, never block.
5. Artifacts live in `~/.toolbay-stack/design/`, never in the repo, never in `/tmp`.
6. No slop in your own output. The preview page is the taste you are asking them
   to adopt.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief design-consultation
```

Follow the lines it prints for `design-consultation`. Where they disagree with
the defaults above, the mode wins. Two things the mode never gets to loosen: a
claim still needs evidence you actually produced, and an irreversible or
destructive action still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
