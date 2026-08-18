---
name: modes
version: 0.1.0
description: The stance layer. A mode changes how every other skill behaves, so the same /review is a blocker-only pass in SHIP and an everything pass in LOCK. Set one per project, read it at the top of any skill, and it changes what gets flagged, what gets tested, what gets shipped, and which skill the router picks. Use when starting work, when the kind of work changes, or when a skill needs to know how careful to be.
triggers:
  - what mode
  - set mode
  - switch mode
  - ship mode
  - craft mode
  - wild mode
  - lock mode
  - current stance
provides:
  - work-mode
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Edit
---

# modes

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original work. It ships inside the skill-per-directory layout of
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan) and lives alongside skills forked from it, but gstack has no
modes layer and no code here is derived from it. Not affiliated with or endorsed
by Garry Tan. See NOTICE.

A mode is not a skill. It is a **stance**, and it changes what every other skill
does. `/review` in SHIP flags blockers and nothing else. The same `/review` in
LOCK flags everything and rejects any claim without a citation. Same command,
same diff, different output, because the work is different.

## The one file you edit

```
skills/modes/modes.json
```

Everything is in there: the mode names, what each one tells each skill, how each
one weights the router. The code knows none of the names. Add a mode by adding a
key. Retire one by deleting it.

**The four that ship are a starting set, not the answer.** They are a guess at
four ways of working, put there so the layer has something in it. Rename them,
throw them out, write your own.

## Use it

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"

node "$MODE" show              # the active stance and everything it changes
node "$MODE" set lock          # set it for THIS project
node "$MODE" clear             # back to the default
node "$MODE" list              # every mode defined, loosest first
node "$MODE" config            # print the file to edit
```

### What a skill calls

At the top of any skill's run, before deciding how much to do:

```bash
node "$MODE" brief review        # human readable
node "$MODE" brief review --json # for a script
```

It prints the stance, the general directives, and the lines for that specific
skill. Follow them. If the mode has no rule for your skill you get the mode's
`"*"` default, never nothing. **Never fail because the mode could not be read.**
The command always exits 0 and always names a stance, so there is nothing to
handle.

`--json` gives you `mode`, `label`, `restraint`, `directives`, `skills`,
`routing`, `guard`, `source`, `degraded`, and `warnings`.

## Setting it

Per project, never globally. A stance belongs to a piece of work, so LOCK on a
client repo does not follow you into a prototype in the next terminal tab. State
lives in `~/.toolbay-stack/modes/`, keyed to the project root, so nothing is
written into your repository.

A repo can also **pin** a mode by committing a `.toolbay-mode` file at its root:

```
# this repo is client work
lock
```

When a pin and a local setting disagree, **the more restrained one wins** and the
disagreement is printed. A committed LOCK cannot be quietly loosened by whoever
cloned it.

Resolution order:

| | Source |
|---|---|
| 1 | `--mode` on this invocation |
| 2 | `.toolbay-mode` committed in the project root |
| 3 | the mode set for this project |
| 4 | the configured `safeDefault` |
| 5 | the built-in fallback stance |

## Fail closed, which is the part that matters

Every one of these lands on a restrained built-in stance, prints why, and exits
zero:

- no mode set
- a mode name that is not defined (on the command line, in the state file, or in
  a repo pin)
- `modes.json` corrupt, blank, or missing
- `modes.json` valid JSON but empty, or with `"modes": {}`
- a state file that is corrupt, empty, or has no `mode` field
- a valid config whose own `safeDefault` names the loosest mode
- a valid config that tries to weight a `blocked` or `safety` suggestion down

That last one is the interesting one. `safeDefault` must name a mode with
`restraint >= 2`, and if it does not the layer refuses it and says so. You can
still select a loose mode by hand any time you like. What you cannot do is have
an **unset** project quietly running the most permissive stance, because that is
the failure that does damage while nobody is looking.

Prove it:

```bash
node ~/.claude/skills/modes/scripts/tb-mode.mjs selftest
```

The selftest builds each broken configuration for real and asserts three things
per case: it did not crash, it did not resolve loose, and it said why.

## It changes what gets suggested, not only how it is worded

`skills.suggest` is the English the agent reads. The `suggest` block next to it is
what the suggestion **engine** applies, so a mode changes which suggestions exist:

```json
"suggest": {
  "max": 1,
  "prefer": { "ship": 30, "verify": 10, "review": -15, "test": -25 }
}
```

Every rule in `/suggest` carries a kind (`blocked`, `safety`, `review`, `test`,
`verify`, `ship`, `hygiene`, `docs`). `prefer` adds points to a kind; a negative
number pushes it under the floor and out of the list. `max` caps how many things
to do get printed. Same repo, same files: SHIP offers one thing and it is the one
that deploys, WILD says nothing about tests, LOCK leads with what is unverified.

Every drop is printed with the kind and the weight that caused it, because a
layer that silently deletes suggestions looks exactly like one that had nothing
to say.

**Two kinds are not suppressible from this file.** `blocked` and `safety` (a
conflict you are standing in, a credential about to be committed, work no branch
can reach) print in every mode, at any weight, and they sit on top of the mode's
cap rather than consuming it. A negative weight against them is read, reported,
and ignored. A stance decides what work matters today. It does not get to decide
whether you are told about a leaking secret.

## The router reads it

`route.mjs explain` prints the active mode, the weights it applied, the weights
it **withheld**, and what the pick would have been without it:

```bash
node ~/.claude/skills/router/scripts/route.mjs explain "review my changes" --mode wild
```

A mode can weight any skill up or down, and can set the marketplace tier to `on`,
`quiet`, or `off`. LOCK sets it `off`: pulling an unreviewed third-party artifact
into client or money work is exactly what that mode exists to prevent.

A **positive** weight only lands on a skill the request already pointed at, so a
`+8` on `/freeze` cannot make the router invoke `/freeze` on a request that never
mentioned freezing anything. A mode reorders relevant skills; it does not invent
one. Negative weights are unconditional, because pushing a skill down is always
the stance's call. The boosts that were withheld are printed on their own
`withheld` line, since those skills score at or below zero and never reach the
candidate list. A boost you cannot see being withheld looks exactly like one that
was applied.

## The marketplace client reads it too, not just the router

`marketplace: "off"` is checked in two places, because the router is only one way
in and a command typed by hand does not pass through it:

```bash
node ~/.claude/skills/toolbay/scripts/tb.mjs find "..."   # exits 7 under LOCK
```

The refusal happens before the token is read and before anything is sent, and it
names the mode that refused. There is deliberately **no bypass flag** — the only
way past is for the human to change the stance, which is a visible act. A
`--force` would be reached for within one turn of being told no, and a stance you
can argue your way past is not a stance.

Absent is not the same as forbidding: an install with no modes layer reaches the
marketplace exactly as it did before the layer existed. But a modes layer that is
*installed and broken* resolves to `quiet`, never to `on`.

## Which skills actually read it

Most of them, but not all, and "a mode changes every skill" is exactly the kind
of claim that quietly stops being true the moment somebody adds a skill and
forgets the Mode block. So it is counted off disk instead of written down here:

```bash
node ~/.claude/skills/modes/scripts/tb-mode.mjs coverage
```

At the time of writing that reports **38 of 60**. The rest deliberately do not
read it, and it is worth knowing which:

- **The safety hooks** — `careful`, `freeze`, `guard`, `unfreeze`. A stance is
  never allowed to change what a hook does. If LOCK could tighten them, some
  other mode could loosen them, and a safety control you can talk out of is not
  one. Modes only say which hooks they *expect on*, in the `guard` block.
- **The two layers that read it in code** — `router` and `suggest` import the
  resolver rather than following the stance as prose.
- **Setup and maintenance** — `gstack-upgrade`, `ios-sync`,
  `setup-browser-cookies`, `context-save`, `plan-tune`, `setup-gbrain`,
  `sync-gbrain`. These configure the stack. They do not do the work the stance is
  about.
- **Measurement** — `backtest`, `benchmark-models`, `landing-report`. These
  report what is true right now. A stance that could change the number would make
  the number worthless.
- **Deterministic output** — `diagram`, `make-pdf`, `design-html`, `learn`,
  `retro`. A retro of last week does not change because of the stance you are in
  today, and a PDF either renders or it does not.
- **`video`, which is an open question rather than a decision.** It is creative
  work with a real evidence bar, so a stance arguably belongs in it. It is not
  wired up yet, and saying so is better than filing it under a category it does
  not fit.

If one of those should read the stance in your setup, add the `Mode` block to its
SKILL.md and give it a key under `skills` in `modes.json`. Then re-run `coverage`
and the list above stops matching, which is the point of having the command.

## What a mode does not do

- It does not enforce anything. It is a stance the agent reads and follows, the
  same way it follows the rest of a SKILL.md. The hard enforcement lives in
  `/careful` and `/freeze`, which are hooks.
- It never loosens a safety hook. A mode's `guard` block says which hooks that
  stance expects to be **on**. LOCK expects both.
- It does not lower the evidence bar. WILD is allowed to skip tests. It is not
  allowed to claim something works without looking at it.
