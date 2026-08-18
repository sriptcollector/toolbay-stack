---
name: design-shotgun
version: 0.1.0
description: Generate several genuinely different design variants, put them side by side on one comparison board, and pick by eye. The board is refused unless every variant file exists, decodes, and measurably differs from the others, so a half-failed generation cannot be presented as a choice. Use when exploring design directions, asking for options, or saying you do not like how something looks.
triggers:
  - design shotgun
  - explore design variants
  - show me design options
  - visual brainstorm
  - i don't like how this looks
  - generate mockups
provides:
  - design-exploration
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# design-shotgun

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (generate N variants in parallel, the anti-convergence
rule, the concept-confirmation step before spending API credits, the comparison
board with per-variant ratings and comments, the remix and regenerate actions,
the `feedback.json` / `feedback-pending.json` / `approved.json` contract, taste
memory across sessions, and the design-artifacts-are-user-data path rule) comes
from `design-shotgun` in [gstack](https://github.com/garrytan/gstack) by Garry
Tan (MIT, Copyright (c) 2026 Garry Tan). The distinctness measurement, the
fail-closed board, and the board-bound feedback contract are new. Not affiliated
with or endorsed by Garry Tan. See NOTICE.

You are a design brainstorming partner. Generate several directions, show them
side by side, and let the eye decide. This is brainstorming, not review.

---

## What this skill owns, and what it does not

It does **not** generate images. Whatever you already use for that (an image
API, gstack's `design` binary, a coding agent writing HTML mockups) still does
the generating. This skill owns the three steps that decide whether the result
can be trusted:

| Step | Command |
|---|---|
| Measure that the variants are actually different | `tb-shotgun distinct` |
| Build the comparison board | `tb-shotgun board` |
| Serve it and validate what comes back | `tb-shotgun serve`, `feedback`, `approve` |

Engine: `node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs`.
Node only, no install, no Bun binary, no ImageMagick, and no `/tmp`.

---

## Step 0: where the artifacts go

Design artifacts are the user's, not the project's. One directory per screen per
day, outside the repo:

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs --help
```

Put variants in `~/.toolbay-stack/designs/<screen-name>-<yyyymmdd>/` and name
them `variant-A.png`, `variant-B.png`, `variant-C.png` (`.jpg`, `.webp`,
`.html`, `.svg` all work). Never `.context/`, never `docs/`, never `/tmp` —
on Windows `/tmp` resolves to `C:\tmp` for Node and to
`C:\Users\<you>\AppData\Local\Temp` for Git Bash, so half your files go missing
between two lines of the same workflow.

Check for previous explorations before starting a new one:

```bash
node -e "const fs=require('fs'),p=require('path'),d=p.join(require('os').homedir(),'.toolbay-stack','designs');for(const n of (fs.existsSync(d)?fs.readdirSync(d):[])){const a=p.join(d,n,'approved.json');if(fs.existsSync(a))console.log(n,JSON.parse(fs.readFileSync(a,'utf8')).approved_variant)}"
```

If there are prior approvals, read them, summarise them, and ask whether to
revisit that direction or start fresh. They are taste memory: bias new concepts
toward what was approved before, and say so out loud.

## Step 1: context, two rounds maximum

Five dimensions, and you can infer most of them: **who** it is for, the **job to
be done** on this screen, **what exists** already in the codebase, the **flow**
in and out, and the **edge cases** (long names, zero results, errors, mobile,
first run). Read `DESIGN.md` if the repo has one, and follow it by default; say
plainly that you are following it and that you will go off it only if asked.

Pre-fill what you inferred, ask only for the gaps, and ask how many variants
(3 is the default, up to 8 for a screen that matters). Two rounds, then proceed
on stated assumptions.

## Step 2: concepts before credits

Write the N directions as text first:

```
A) "Name" — one line on the visual direction
B) "Name" — one line on the visual direction
C) "Name" — one line on the visual direction
```

**Anti-convergence.** Each variant gets a different font family, a different
palette, and a different layout. If you could swap the headline between two of
them and nobody would notice, one of them failed. They should look like three
design teams, not one team at three caffeine levels.

In this fork that sentence is not advice. `board` measures it and refuses to
write a board of near-duplicates, so a converged set costs you a rerun.

Confirm the concepts with AskUserQuestion before spending anything: generate all
N, change some, add more, or drop some.

## Step 3: generate

Launch one agent per variant in a single message so they run in parallel. Each
agent writes **straight to the final path** — there is no copy-through-temp step,
because the temp step is what loses files on Windows:

```
Generate design variant {letter} and save it.

Brief: {variant-specific brief}
Output: {design dir}/variant-{letter}.png    (absolute path, write here directly)

1. Generate.
2. On a 429 or rate-limit error, wait 5s and retry, up to 3 times.
3. Verify the file exists and is non-empty. If not, retry once.
4. Report exactly one of:
   VARIANT_{letter}_DONE: {bytes}
   VARIANT_{letter}_FAILED: {error}
```

Report every failure explicitly. Do not quietly proceed with four of six.

## Step 4: measure, then build the board

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs board --dir "<design dir>"
```

This is the gate. It exits non-zero and writes nothing when:

- a variant file is missing, empty, or is not the format its extension claims
- there are fewer than two variants
- two variants are near-duplicates on both layout and palette
- distinctness could not be measured for a pair (an undecodable image), in which
  case it is reported UNVERIFIED rather than assumed fine

Overrides exist (`--allow-similar`, `--allow-unverified`) and are recorded in
`board.json`. If you used one, say so; do not describe the set as checked.

On success it prints `BOARD_ID`, `BOARD_FILE`, `BOARD_META` and writes a
self-contained `design-board.html` (images inlined as data URIs, so it survives
being moved, attached, or opened from a path with a space in it).

Show the variants inline with the Read tool as well. The terminal is where the
user sees them first; the board is for the detailed comparison.

## Step 5: collect the decision

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs serve --board "<board file>"
```

Run it in the background. It prints `BOARD_URL: http://127.0.0.1:<port>/` and
opens the default browser (`cmd /c start` on Windows, `open` on macOS,
`xdg-open` on Linux). A failure to open prints `OPEN_FAILED` with the URL, which
is the point: gstack's `open file://...` is a command-not-found on Windows and
nothing notices that the board was never seen.

Then use AskUserQuestion purely as the blocking wait, with the URL in the text.
**Do not ask which variant they prefer.** The board is the chooser.

When they come back:

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs feedback --dir "<design dir>"
```

This refuses, loudly and non-zero:

- `NO_FEEDBACK` when nothing was submitted. Absence is not approval.
- `STALE_FEEDBACK` when the file belongs to another board or predates this one.
  The per-screen directory is reused, so last week's submit is sitting right
  there; reading it would approve a design the user never saw.
- a preferred or rated variant that is not on this board.

If it prints `KIND: REGENERATE_REQUEST`, generate the next round into the same
directory, rebuild the board (new `BOARD_ID`), and serve again. If the user
typed their preference in chat instead of using the board, take the chat answer
and skip straight to Step 6.

The board also works with no server at all: opened from `file://`, Submit prints
the same JSON for the user to paste back.

## Step 6: save the choice

Read the summary back to the user and confirm it, then:

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs approve --dir "<design dir>"
```

`approved.json` pins the variant id, its absolute path, its sha256, the board id,
and whether distinctness was verified. Next session's taste memory reads it.

Then offer: iterate on the approved direction, build it in production HTML/CSS,
attach it to the current plan, or stop here.

---

## Prove the engine works

```bash
node ~/.claude/skills/design-shotgun/scripts/tb-shotgun.mjs selftest
```

25 cases, each one a board or a feedback file that must be **refused**: missing
variants, 0-byte variants, a text file wearing a `.png` extension, byte-identical
variants, two shades of the same blue in the same layout, an unmeasurable pair,
stale feedback, feedback for another board, feedback that predates the board.
Plus a live HTTP round trip against the real server. It exits non-zero if any
broken input gets through.

## Rules

1. Artifacts live in `~/.toolbay-stack/designs/`, never in the repo, never in `/tmp`.
2. Show the variants inline before opening the board.
3. Confirm the feedback summary before saving.
4. Prior approvals bias new concepts. Say when they do.
5. Two rounds of context gathering, then proceed on assumptions.
6. `DESIGN.md` is the default constraint unless the user says otherwise.
7. Never call a set distinct that the engine did not verify.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief design-shotgun
```

Follow the lines it prints for `design-shotgun`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
