---
name: ios-fix
version: 0.1.0
description: Fix an iOS bug and prove the fix, with the proof computed rather than eyeballed. Holds a ledger per bug that refuses a fix without a reproducing snapshot, measures the post-fix screen against the pre-fix capture in real pixels, and refuses to call anything fixed on a blank screen, an unchanged screen, an error body saved as a PNG, or a screenshot taken before the rebuild. Use when a device bug needs fixing, or when someone asks whether an iOS fix actually worked.
triggers:
  - fix this ios bug
  - patch the iphone app
  - auto-fix the ios issue
  - did the ios fix work
  - verify the fix on the device
  - iphone bug is back
provides:
  - ios-development
  - device-fix-evidence
  - device-toolchain-preflight
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
  - Grep
  - Glob
  - AskUserQuestion
---

# ios-fix

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (the `/ios-fix` command, the Iron Law "no fix without
a reproducing snapshot", the five phases, capturing the pre-bug state as a
regression fixture, the pre/post screenshot comparison, the three-iteration
escalation cap, the `<bug-slug>-pre.json` / `-pre.png` / `-post.png` fixture
layout, the `test/fixtures/ios-fix/` location and the failure-mode table) comes
from `ios-fix` in [gstack](https://github.com/garrytan/gstack) by Garry Tan
(MIT, Copyright (c) 2026 Garry Tan). The evidence engine, the computed verdict
and the preflight are new. Not affiliated with or endorsed by Garry Tan. See
NOTICE.

You are closing a loop: find the bug, fix the bug, **prove** the bug is gone. The
third part is the one that quietly does not happen.

---

## Before anything, ask whether this can run here

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs preflight
```

It probes `xcodebuild`, `swift` and `xcrun devicectl` and prints one line each.
On Windows it does not probe at all, it states the fact: Xcode, devicectl and the
CoreDevice USB tunnel are macOS-only, so the device half of this loop cannot run
here and never will. Exit 3.

That is a different answer from "broken". The loop has two halves and only one of
them needs a Mac:

| half | what it is | runs on Windows |
|---|---|---|
| device | build, install, drive the phone, capture | no |
| evidence | validate the snapshot, compare the captures, gate the verdict | yes |

So a fix produced on a Mac can be checked from any machine, which is the point of
having the evidence live in files instead of in the transcript.

---

## The loop

Every step writes to a ledger at `.toolbay/ios-fix/<bug-slug>.json`. The order is
enforced: the commands refuse to run out of sequence.

**1. Open the bug.** Both halves are required, because "fixed" has no meaning
without the second one.

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs open \
  --bug cart-row-red \
  --summary  "the cart row renders red after removing the last item" \
  --expected "the row renders in the empty-state grey"
```

**2. Reproduce it, before touching any Swift.** Drive the device into the bug
state, then capture `GET /state/snapshot` and `GET /screenshot` and hand both to
the ledger.

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs repro \
  --bug cart-row-red --snapshot test/fixtures/ios-fix/cart-row-red-pre.json \
  --screenshot test/fixtures/ios-fix/cart-row-red-pre.png
```

Refused, and nothing written, if the snapshot is `{}`, an error envelope from the
bridge, an HTML error page, or not JSON; or if the screenshot is 0 bytes, not
actually a PNG, or a blank screen. Those are all things the bridge hands you on a
bad day, and all of them are things gstack writes to the fixture file and calls
Phase 1 complete.

**3. Find the root cause, then record the fix.**

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs fix \
  --bug cart-row-red --cause "the colour token is read from the pre-removal state" \
  --file Sources/Cart/CartRow.swift
```

Without a recorded repro this command **refuses**. That is the Iron Law, moved
out of prose and into an exit code.

**4. Rebuild, redeploy, recapture, and measure.**

```bash
xcodebuild -scheme MyApp -destination "platform=iOS,id=$UDID" build install
# ...restore the snapshot, take the new screenshot...
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs verify \
  --bug cart-row-red --screenshot test/fixtures/ios-fix/cart-row-red-post.png
```

`verify` decodes both PNGs in-process and answers with a number. It returns
UNVERIFIED, never a pass, when the post capture is missing, 0 bytes, not a PNG,
truncated, byte-identical to the pre capture, a blank screen, a different size, or
older than the newest file the fix touched. It returns NOT_FIXED when the screen
measurably did not change. Attempts are counted; the third failure prints
ESCALATE, which is gstack's three-iteration rule with something actually counting.

**5. Leave a regression test that loads the fixture.**

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs regression \
  --bug cart-row-red --test test/fixtures/ios-fix/cart-row-red.test.ts
```

A test file that never mentions the snapshot fixture is refused: it cannot be
restoring the pre-fix state, so it would have passed before the fix as well.

**6. Ask for the verdict.**

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs verdict --bug cart-row-red
```

Five gates, each printed with what satisfied it. Exit 0 only for FIXED, so this
can gate a commit:

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs verdict --bug cart-row-red \
  && git commit -am "fix: cart row colour after last-item removal"
```

---

## Three answers, not two

| verdict | means |
|---|---|
| FIXED | every gate satisfied, and the screen measurably changed |
| NOT_FIXED | the comparison ran and says the bug is still there |
| UNVERIFIED | the comparison could not be made, so nothing is established |

UNVERIFIED is the one gstack has no room for, and it is the common case. It is not
a claim that the bug is still there. It is a refusal to claim anything.

---

## Why this exists

gstack's `/ios-fix` ships two files, and neither of them runs:

```
$ ls ~/.claude/skills/gstack/ios-fix/
SKILL.md  SKILL.md.tmpl
```

69 lines of body prose, addressed to the model. That is right for the judgement
half (read the Swift, trace the state mutation) and fatal for the evidence half,
because both ways this loop fails are invisible from inside the conversation.

**The Iron Law is enforced by nothing.** "NO FIX WITHOUT A REPRODUCING SNAPSHOT"
is a sentence in a markdown file. An agent that skips Phase 1, edits the Swift and
reports success produces a transcript identical to one that did the work. There is
no artifact anywhere that separates them.

**Phase 4 is an eyeball.** "Take a fresh screenshot. Compare against
`<bug-slug>-pre.png`. If the bug visibly persists, the fix didn't work." No number
is computed and no file is required to exist, so every way that comparison can be
meaningless reads as a pass:

- the device was asleep, and the capture is a black rectangle
- the bridge answered 401 or 503, and curl wrote the JSON error body to `post.png`
- nothing was captured at all, and the model is comparing `pre.png` to itself
- the capture predates the rebuild, so it pictures the previous binary

Each of those is, from the transcript, "I took a screenshot and the bug is gone".
All four are refused here, and the selftest below is built out of them.

**And it never asks whether it can run.** gstack hands the model
`xcodebuild -scheme <SchemeName> ... build install` in Phase 3 and discovers the
answer as a shell error. `preflight` asks first, once, and names every missing
piece.

## Windows

The preamble gstack attaches to this skill is POSIX-only in ten places (`$PPID`,
`find -mmin`, `source <(...)`, `date +%s`, `open`), and the skill body assumes a
Mac outright. This fork's engine is one Node file: no shell, no python, no
coreutils, no ImageMagick. The PNGs are decoded in-process, so `verify` prints the
same numbers from Git Bash, PowerShell and cmd. `--dir /tmp/...` is refused on
win32 with both directories that string means printed out, because a ledger
written to one and read from the other reads back as a bug nobody worked on.

## Prove the checks work

```bash
node ~/.claude/skills/ios-fix/scripts/tb-iosfix.mjs selftest
```

60 assertions, each one a way an iOS fix reports itself verified without anything
having been established. It builds real PNG files (including the black screen, the
JSON body named `.png`, the truncated one, and a genuine re-capture of an
unchanged screen), drives this CLI against them as child processes, and fails
loudly if any of them reach FIXED.

## Important rules

- **No fix without a reproducing snapshot.** The engine enforces it; do not work
  around it by editing the ledger.
- **A screenshot is not evidence until something decoded it.** `verify` did. You
  did not.
- **Three attempts, then stop.** Hand the human the current best hypothesis
  instead of a fourth variant.
- **Never report a fix the ledger does not support.** If `verdict` says
  UNVERIFIED, the fix is unverified, whatever the narrative says.

## Mode

This skill runs inside a stance. Read it before you start, because it changes what
this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief ios-fix
```

Follow the lines it prints for `ios-fix`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still needs
evidence you actually produced, and an irreversible or destructive action still
needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above.
