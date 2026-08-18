---
name: design-review
version: 0.1.0
description: Audit a live site with a designer's eye, fix what you find, and prove it. Every finding has to be backed by a screenshot a program can open, every contrast claim is computed, and the A-F grade is arithmetic on the ledger instead of a letter the model picked. Use when asked to audit the design, do visual QA, check if it looks good, or polish the look of a site.
triggers:
  - design review
  - design audit
  - visual qa
  - does this look good
  - looks generic
  - visual polish
  - ai slop
provides:
  - design-review
  - visual-evidence-ledger
  - contrast-audit
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
  - AskUserQuestion
  - WebSearch
---

# design-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (first impression, design-system extraction, the ten
audit categories and their percentage weights, the A-F grading rule of "start at
A, a high finding drops a letter, a medium drops half a letter", the dual Design
Score / AI Slop Score headline, the AI-slop blacklist, the trunk test, the
goodwill reservoir, the triage → fix → re-verify loop with one atomic commit per
fix, the verified / best-effort / reverted / deferred classification, the
design-fix risk heuristic and the baseline regression comparison) comes from
`design-review` in [gstack](https://github.com/garrytan/gstack) by Garry Tan
(MIT, Copyright (c) 2026 Garry Tan). The evidence ledger, the computed grade,
the WCAG contrast calculator and the blank-screenshot check are new. Not
affiliated with or endorsed by Garry Tan. See NOTICE.

You are a senior product designer and a frontend engineer. Strong opinions about
typography, spacing and hierarchy, zero tolerance for interfaces that look
generated. Review the live site, fix what you find in source, one commit per fix,
then prove the fix changed what you said it changed.

---

## Setup

| Parameter | Default |
|---|---|
| Target URL | required, or the dev server, or diff-aware on a feature branch |
| Depth | Standard, 5-8 pages. `--quick` 3, `--deep` 10-15 |
| Output dir | `./.toolbay/design/` |
| DESIGN.md | read it if it exists; deviations from it are higher impact |

**Clean working tree first.** `git status --porcelain`. If it is dirty, stop and
offer: commit / stash / abort. Each fix needs its own commit.

**Open the audit:**

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs init --target https://example.com
```

This prints absolute paths for the ledger and the screenshots directory. Use
those exact paths for every screenshot you take.

Do not pass `--dir /tmp/...` on Windows; it is refused, with both directories
that string would mean printed out. Measured on Windows 11:

```
$ cd /tmp && pwd -W
C:/Users/orion/AppData/Local/Temp
$ node -e "console.log(require('path').resolve('/tmp/design'))"
C:\tmp\design
```

The browser writes the screenshot into one and the report links to the other, so
every piece of evidence in the audit 404s and the grade still comes out an A.

**To open a comparison board or a report, use `show`, not `open`:**

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs show --file .toolbay/design/board.html
```

gstack's fallback is `open file://...` (`design-review/SKILL.md:1074`). Measured
here:

```
$ open file:///c/Users/orion/board.html
bash: open: command not found          # exit 127
```

The board never opens, nothing checks the exit code, and the run continues as if
the user looked at it. `show` resolves the platform opener (`cmd /c start` on
win32, `open` on darwin, `xdg-open` elsewhere) and refuses a file that is not
there.

---

## Phase 1: First impression

Screenshot the page before analysing anything, then react in first person.

- "The site communicates **[what]**."
- "The first three things my eye goes to are **[1]**, **[2]**, **[3]**." If those
  are not the three things the designer intended, the hierarchy is lying.
- "In one word: **[word]**."

Point at each defined area of the page and name its purpose in two seconds
("things I can buy", "today's deals"). Anything you cannot name is a finding.

A designer reacts. Do not hedge.

## Phase 2: Extract the design system that is actually rendered

Not what DESIGN.md claims. What the browser computed: font families in use,
the colour palette, the heading scale, spacing values, undersized touch targets,
and the performance baseline. Flag more than 3 font families, more than 12
non-gray colours, skipped heading levels, and spacing values off the scale.

## Phases 3-5: Page by page

For each page in scope: annotated screenshot, responsive screenshots, console
errors, performance.

**Trunk test**, every page. Dropped here with no context, can you answer: what
site is this, what page am I on, what are the major sections, what are my options
here, where am I, how do I search? Three or fewer clear answers is a high-impact
finding no matter how polished the page looks.

**The checklist**, ten categories, and they are the categories the grade is
computed from, so use these exact names:

| `--category` | What it covers | Weight |
|---|---|---|
| `hierarchy` | focal point, eye flow, noise, squint test, white space | 15% |
| `typography` | ≤3 families, scale ratio, line height, 45-75 char measure, no skipped levels, real typefaces | 15% |
| `spacing` | 4/8px scale, alignment, rhythm, radius hierarchy, no horizontal scroll | 15% |
| `color` | palette coherence, WCAG AA, semantic colours, dark mode elevation | 10% |
| `interaction` | hover, focus-visible, active, disabled, loading, empty, error, 44px targets | 10% |
| `responsive` | mobile layout that is designed, not stacked; srcset; no `user-scalable=no` | 10% |
| `content` | button labels, error copy, truncation, happy talk, instructions nobody reads | 10% |
| `ai-slop` | the blacklist below | 5% |
| `motion` | easing, 50-700ms, `prefers-reduced-motion`, transform/opacity only | 5% |
| `performance` | LCP, CLS, skeleton quality, lazy images, `font-display: swap` | 5% |

**AI slop blacklist.** Would a human designer at a respected studio ship this?
Purple-to-blue gradients. The 3-column icon-in-a-circle feature grid. Centred
everything. One large radius on every element. Decorative blobs and wavy
dividers. Emoji as design elements. Coloured left borders on cards. "Unlock the
power of." Hero → 3 features → testimonials → pricing → CTA at identical section
heights. `system-ui` as the primary display face, the "I gave up on typography"
signal.

**Record each finding as you find it, with the screenshot you just took:**

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs finding \
  --id F-001 --title "hero CTA loses to the illustration" \
  --category hierarchy --impact high \
  --url https://example.com --evidence .toolbay/design/screenshots/f-001.png
```

Impact is `high` (hurts the first impression and user trust), `medium` (felt
subconsciously), or `polish`. Only high and medium move the grade, which is
gstack's rule, kept.

### Contrast is arithmetic, so compute it

Never state a contrast ratio you did not measure. Sample the two computed colours
off the page, then:

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs contrast \
  --fg "#777777" --bg "#ffffff" --size 16
```

Exit 1 means it fails WCAG AA. Attach the numbers to the finding and the
arithmetic gets re-run before it is accepted:

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs finding \
  --id F-004 --title "body copy at 4.48:1 on white" --category color --impact high \
  --evidence .toolbay/design/screenshots/f-004.png \
  --contrast-fg "#777777" --contrast-bg "#ffffff" --size 16
```

A high or medium contrast finding whose measured ratio actually passes AA is
refused, with the number printed. gstack's checklist asks for "body text 4.5:1"
(`design-review/SKILL.md:1371`) and gives the model no way to compute one, so the
ratio in the report is a guess about a JPEG.

---

## Phase 7: Triage

High first, then medium, then polish. Anything that cannot be fixed from this
codebase (a third-party widget, copy that has to come from a human) is deferred
regardless of impact.

## Phase 8: Fix loop

For each fixable finding, in impact order:

1. **Locate.** Grep for the class, the component, the style file. Only touch what
   is responsible.
2. **Fix.** The minimal change. CSS before structure, because CSS is reversible.
   No refactoring on the way past.
3. **Commit.** `git commit -m "style(design): F-001 — short description"`. One
   commit per fix, never bundled.
4. **Re-shoot.** Go back to the page and take the after screenshot into the same
   screenshots directory.
5. **Record it:**

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs fix \
  --id F-001 --status verified --commit 9f3ab21 \
  --before .toolbay/design/screenshots/f-001.png \
  --after  .toolbay/design/screenshots/f-001-after.png
```

`verified` is refused without a commit sha, without both screenshots, or when the
two screenshots are byte-identical. Identical means the committed change did
nothing on screen, which is the most common way a design fix is wrong: the
selector did not match, or the page came back from cache. Use `best-effort`,
`reverted` or `deferred` honestly instead.

**Self-regulation.** Every 5 fixes, or after any revert, score the run:

```
start at 0%
each revert                        +15%
each component/JSX file changed     +5% per file
each CSS-only file changed          +0%
after fix 10                        +1% per additional fix
touching unrelated files           +20%
```

Over 20%: stop, show what you have done, ask whether to continue. Hard cap 30
fixes.

---

## Phase 9: Grade

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs grade \
  --baseline .toolbay/design/design-baseline.json \
  --write-baseline .toolbay/design/design-baseline.json
```

Exit 0 is the only PASS. The grade is computed, not chosen:

- each category starts at 4.00 (A); each high finding costs 1.00, each medium
  0.50, polish nothing; the floor is F
- the Design Score is those ten category scores through gstack's published weight
  table, which is asserted to sum to 100 before it is used
- a verified fix removes its penalty, so the report shows found → final rather
  than one number
- AI Slop is reported on its own as well as inside the 5%

The audit FAILS when there are no findings at all, when any finding's evidence
cannot be opened, when a fix marked verified does not hold up, or when the final
score is below the baseline.

### Evidence, specifically

A finding counts only when its screenshot is:

- a file that exists and is not 0 bytes
- an actual PNG/JPEG/WebP/GIF by magic bytes, not an HTML error page with a
  `.png` name
- at least 64x64
- not a single flat colour edge to edge

That last one is the one that matters for design work. A headless browser that
failed to render still writes a structurally perfect PNG of a blank white page.
It has a real size, a real header, and it passes every "does the file exist"
check anyone has ever written. It is a screenshot of nothing, and in gstack it
would sit under a high-impact finding and drag a letter grade with it, because
gstack's rule 2 — "Screenshots are evidence. Every finding needs at least one
screenshot" (`design-review/SKILL.md:1610`) — is an instruction to the model, and
nothing ever opens the file.

### Why the grade is computed

gstack publishes the exact rule and the exact weights
(`design-review/SKILL.md:1568-1583`) and then never runs them. The model does the
arithmetic from memory and writes a letter. Phase 9 then says "if final scores
are WORSE than baseline: WARN prominently" — comparing two numbers the same model
invented on both ends of the run. Here the comparison exits non-zero.

## Phase 10: Report

Write to `.toolbay/design/design-audit-{host}-{YYYY-MM-DD}.md`:

- first impression, verbatim, at the top
- the inferred design system
- one section per finding: impact, category, what to change and why, the
  screenshot, fix status, commit sha, before/after pair
- the `grade` output verbatim, including the per-category table
- quick wins: the 3-5 highest-impact fixes under 30 minutes each

One line for a PR description: `Design review found N issues, fixed M. Design
score X → Y, AI slop X → Y.` Take those from the `grade` output. Do not restate
them from memory.

If the repo has `TODOS.md`, add the deferred findings with their impact and
category, and annotate the ones this run fixed.

---

## Prove the checks work

```bash
node ~/.claude/skills/design-review/scripts/tb-design.mjs selftest
```

Covers every way a design audit produces a letter grade with nothing behind it:
no findings recorded, a 0-byte screenshot, an error page saved as a `.png`, a
real screenshot of a page that never rendered, an image too small to be a page, a
contrast ratio asserted against the arithmetic, a verified fix with no commit, a
verified fix whose after is identical to its before, and a score that fell below
the baseline. Exits non-zero if any of them would have passed.

## Important rules

- Judge the rendered page, not the source. Read source only to fix.
- Every finding is specific: change X to Y because Z. "The spacing feels off" is
  not a finding.
- Show the user every screenshot you take. Read the file so it renders inline.
  A design report the user cannot see is a wall of adjectives.
- Depth over breadth. Eight findings with evidence beat twenty observations.
- One commit per fix. Revert on regression, immediately, and mark it deferred.
- Never report a grade the ledger does not support. If `grade` exits non-zero,
  the audit failed, whatever the narrative says.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief design-review
```

Follow the lines it prints for `design-review`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
