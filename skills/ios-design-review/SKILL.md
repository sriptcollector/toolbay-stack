---
name: ios-design-review
version: 0.1.0
description: Designer's-eye audit of a SwiftUI app across gstack's ten dimensions, where every score is arithmetic over findings that carry a file and a line number or a screenshot the tool has opened. Runs the source half on any machine, including Windows. Refuses to score the half that needs a rendered screen when no device was reached. Use when asked to review the iOS design, audit an iPhone app's visuals, or design QA a SwiftUI app.
triggers:
  - ios design review
  - review the ios design
  - audit the iphone app visuals
  - design qa the ios app
  - swiftui design audit
  - does my ios app look
provides:
  - ios-design-audit
  - ios-development
  - device-evidence-gate
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
---

# ios-design-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The ten review dimensions and their definitions (typography
hierarchy, spacing rhythm, colour hierarchy, touch targets, loading/empty/error
states, accessibility, animation discipline, iOS idiom alignment, information
density, AI-slop check), the 0-10 per-dimension scale with the "what would make
it a 10" framing, the read-only `observe` posture on the device session, the
per-screen loop and the one-report-per-run output come from `ios-design-review`
in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The SwiftUI linter, the evidence ledger, the computed scores,
the screenshot verifier and the UNSCORED rule are new. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

You are a senior iOS designer reviewing someone's app. Strong opinions about the
HIG, zero tolerance for a screen that looks generated. The rubric below is
gstack's. What is different is that nothing here is scored on your say-so.

---

## What changed, and why

gstack's version of this skill is two files and no code:

```
$ ls ~/.claude/skills/gstack/ios-design-review/
SKILL.md  SKILL.md.tmpl
```

Ten dimensions, each scored 0-10 by the model after looking at a screenshot.
Nothing opens the screenshot, nothing checks the arithmetic, and nothing checks
that an iPhone was ever involved. Four consequences, all of which read as a
finished audit:

**1. No device, same report.** The skill's premise is "on real hardware" and it
has no branch for hardware that is not there. On this machine:

```
$ which xcrun xcodebuild swift
which: no xcrun in (...)
which: no xcodebuild in (...)
which: no swift in (...)
```

There is no simulator and no daemon to acquire a session from, and the rubric is
still ten questions a model can answer plausibly from source it just read. Here
`init` records what the host can reach and prints it, and the dimension that
genuinely needs a rendered screen comes out **UNSCORED** rather than as a number.

**2. The blank screenshot is a documented failure mode with no check behind it.**
gstack's own table says: *"Screenshot is black/blank → App may be in foreground
but not rendering; AskUserQuestion to confirm."* That hands the detection to the
model, which is being handed the same image. A backgrounded iOS app screenshots
as a structurally perfect PNG of solid black. `evidence` inflates the IDAT,
unfilters it, and refuses an image whose every pixel is one colour.

**3. The scores are asserted.** Each dimension here starts at 10 and every
recorded finding subtracts its severity, so the number is arithmetic over a
ledger.

**4. Most of the rubric never needed the device.** Fixed-size type that ignores
Dynamic Type, padding off the 4pt grid, a 28x28 tap target, an icon-only Button
with no VoiceOver label, a hard-coded `Color(red:green:blue:)` with no dark-mode
variant, a 1.5s UI animation, `NavigationView` after iOS 16, lorem ipsum still in
a `Text`. All of that is in the source, none of it is a judgement call, and
`scan` finds it with a file and a line on a machine that has never seen an
iPhone.

---

## Phase 0: Open the audit

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs init --app ./MyApp
```

It prints where the ledger is, and whether device evidence is possible here at
all. Read that line before you plan the rest of the run: it decides whether this
is a full audit or a source audit, and saying so up front is the whole point.

Do not pass `--dir /tmp/...` on Windows. It is refused, with both directories
that string would mean printed out, because Node resolves it to `C:\tmp\...` and
Git Bash resolves it to `%TEMP%`, both exist, and the evidence would land in one
while the report linked the other.

## Phase 1: Scan the source

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs scan
```

This is a lint, not a compiler. Comments and string bodies are stripped before
the code rules run, brace depth is tracked so "inside a Button" is a fact, and
every finding carries `file:line` plus the text of that line. What it checks, by
dimension:

| Dimension | What the lint decides from source |
|---|---|
| typography | `.system(size:)` without `relativeTo:` (ignores Dynamic Type); anything ≤12pt |
| spacing | `padding`/`spacing` values off the 4pt grid |
| color | `Color(red:...)`, `UIColor(...)`, `#colorLiteral`: no dark-mode variant |
| touch-targets | a `.frame` under 44pt inside a Button/NavigationLink/Menu/Toggle |
| states | `ForEach` with no `isEmpty` anywhere; `await`/`.task` with no `ProgressView`; a `catch` with no error UI |
| accessibility | an icon-only control with no `.accessibilityLabel` |
| animation | durations outside the 200-300ms band; `.repeatForever` with no Reduce Motion branch |
| idiom | `NavigationView` (deprecated iOS 16); the system nav bar hidden |
| ai-slop | lorem ipsum, placeholder copy, the purple-to-blue gradient |
| density | nothing. It needs a rendered screen. |

A line can opt out with `// tb-ios-design: ignore`, and the number of
suppressions is printed, so an opt-out cannot hide.

The lint will miss things a type checker would catch. It does not report things
it did not see, and `score` re-reads every cited line before it counts.

## Phase 2: The device half, if there is a device

Same connection as `/ios-qa`: acquire a session with capability `observe`, which
is read-only, then `GET /screenshot` and `GET /elements` per screen. Record each
screenshot before you say anything about it:

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs evidence \
  --screen Home --shot ./.toolbay/ios-design/home.png
```

Refused, with the reason named: a 0-byte file (the capture errored), a daemon
error page saved under a `.png` name, an image smaller than any iOS screen, a
solid-colour image (the backgrounded-app case), and any size that is not a known
iPhone or iPad screen, which is what a desktop window grab or a crop looks like.
An unknown device is one flag away, `--allow-size 1206x2622`, and the override is
recorded and printed on the report.

Then judge the rendered screen against the dimensions the source cannot answer:
information density, whether the hierarchy actually reads, whether dark mode
renders, whether the layout survives Dynamic Type at XXL.

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs finding \
  --id D-001 --dimension density --severity medium \
  --title "the header crowds the list on a 6.1 inch screen" --screen Home \
  --fix "Cut the header to one line above the fold."
```

## Phase 3: Your own findings, cited

Anything you see that the lint did not is welcome, and it is recorded the same
way as everything else:

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs finding \
  --id D-002 --dimension idiom --severity high \
  --title "a hamburger menu on iPhone, which is an Android pattern" \
  --file Sources/RootView.swift --line 42 --quote "Button { showDrawer = true }" \
  --fix "Use a TabView, or put the destinations in the navigation bar."
```

`--quote` is checked against the line before the finding is accepted. A citation
that does not check out is refused, with the line printed as it actually reads.
A finding with no `--file`/`--line` and no `--screen` is refused outright.

Severities: `high` costs 3.0, `medium` 1.5, `polish` 0.5, out of 10.

## Phase 4: Score

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs score
```

Exit 0 is the only pass. It fails, loudly and specifically, when:

- a finding's cited line no longer contains what it quoted (the file moved on)
- a screenshot changed after it was verified (the hash is re-taken here)
- nothing was ever observed: no scan, no screens. An audit with no observations
  is not a pass.
- any dimension is UNSCORED

That last one is the rule this whole fork exists for. If you could not see it,
you do not get to score it. When the missing evidence is genuinely unavailable
(no Mac, no device, and the user wants the source audit anyway), accept it on
purpose:

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs score --accept-unscored
```

The acceptance is recorded with the exact dimensions it covers, the report is
stamped **PARTIAL AUDIT**, and a later run that is short a *different* dimension
fails again rather than riding on the old stamp.

## Phase 5: Report

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs report
```

Writes `.toolbay/ios-design/ios-design-review-YYYY-MM-DD.md`, and refuses to
write at all if the score did not pass. The report leads with provenance, host,
whether device evidence was possible, files scanned, screens verified, then the
PARTIAL section if there is one, then the score table with "what would make it a
10" per dimension, then every finding with its file:line or its screen.

Show the user the screenshots you took. Read the files so they render inline. A
design report nobody looks at is a wall of adjectives.

## Prove the checks work

```bash
node ~/.claude/skills/ios-design-review/scripts/tb-ios-design.mjs selftest
```

61 assertions, every one a case where gstack's version produces a clean
ten-dimension report: no device on the machine, a solid-black screenshot, a
desktop window grab, a citation that is not on the line, a screenshot swapped
after the fact, a corrupt ledger. Exits non-zero if any of them would have
passed.

## Important rules

- Judge the rendered screen where you have one, the source where you do not, and
  never blur which is which. The report already prints the difference.
- Every finding is specific: change X to Y because Z. "The spacing feels off" is
  not a finding, it is a mood.
- Never state a score the ledger does not support. If `score` exits non-zero the
  audit failed, whatever the narrative says.
- `observe` capability only. This skill does not tap, type, or mutate app state.
  If you need to drive the app to reach a screen, that is `/ios-qa`.
- A dimension you could not see is UNSCORED. Not 7/10, not "looks fine".

## Mode

This skill runs inside a stance. Read it before you start:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief ios-design-review
```

Where the mode disagrees with the defaults above, the mode wins. Two things it
never gets to loosen: a claim still needs evidence you actually produced, and an
UNSCORED dimension is never reported as a number.
