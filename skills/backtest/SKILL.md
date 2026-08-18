---
name: backtest
version: 0.2.0
description: Prove an agent setup actually catches things, or find out it does not. Seeds real defects (a destructive shell command, a force push, a guard fed input it cannot parse, a write outside the project), runs them against the hooks and rules this project really has configured, and reports CAUGHT, MISSED or INCONCLUSIVE per scenario plus the context cost of the setup. Users can add their own scenarios. Use when someone asks whether their setup, guards, hooks, rules or skills are any good, whether their agent config is safe, how to test a Claude Code or Cursor configuration, or to compare two setups.
triggers:
  - backtest my setup
  - is my setup any good
  - test my agent config
  - do my guards actually work
  - prove my hooks work
  - are my hooks working
  - measure my agent setup
provides:
  - setup-backtest
  - guard-verification
  - context-cost-measurement
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# backtest

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original work. It ships inside the skill-per-directory layout of
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan) and sits alongside skills forked from it, but gstack has no
backtest harness and no code or contract here is derived from it. Not affiliated
with or endorsed by Garry Tan. See NOTICE.

Anyone can claim their agent setup is good. This proves it, or shows it isn't.

## Use it

```bash
node scripts/tb-backtest.mjs                  # starter scenarios, no config needed
node scripts/tb-backtest.mjs discover         # what is configured, and what it costs
node scripts/tb-backtest.mjs init             # write a scenario file to edit
node scripts/tb-backtest.mjs --config .toolbay/backtest.json
node scripts/tb-backtest.mjs --json           # machine-readable
```

It reads the project's real configuration off disk — `.claude/settings.json`,
hooks declared in any installed `SKILL.md`, `.cursor/hooks.json`, `CLAUDE.md`,
`AGENTS.md`, `.cursor/rules/*.mdc` — and runs the seeded defects against the
commands it finds. Nothing is assumed and nothing is asked.

## The three verdicts

| | means |
|---|---|
| `CAUGHT` | the setup stopped or questioned it |
| `MISSED` | nothing in the setup stopped it. This is a finding, not an error |
| `INCONCLUSIVE` | the harness could not determine an outcome. Never a pass |

## Why the verdicts are worth believing

A benchmark written about your own tool is worthless unless it can lose. Five
rules are enforced in `decide()` rather than left to whoever writes a scenario:

1. **A scenario that could not run is INCONCLUSIVE, never a pass.** Missing
   fixture, missing prerequisite, timeout, crash — all of them mean "we do not
   know", and "we do not know" is never a win.
2. **A judge that throws is INCONCLUSIVE.** A broken instrument measures nothing.
3. **"Found nothing" is never reportable as "nothing to find".** Every scenario
   must carry a `control`: the same probe with the defect absent. Without one, a
   judge that reported a catch every single time would score a clean pass and
   nobody could tell. No control, no verdict.
4. **A control that also "catches" invalidates the scenario.** If the judge
   reports a catch on the clean control it is not detecting the defect, it is
   reporting a catch either way. That is a rubber stamp, and it is INCONCLUSIVE.
   This is a mutation test built into every single run.
5. **A catch claimed over silence is not a catch.** If the probe produced no
   output at all and the judge still says CAUGHT, that is indistinguishable from
   nothing having run.

Rules 3, 4 and 5 are what make this evidence rather than marketing. They cost
real verdicts, on purpose.

## One more distinction that matters

A guard registered against a script that is not on disk is **not** a guard that
blocked something. The shell exits non-zero and prints "No such file or
directory", which reads exactly like a refusal and would be scored as a catch by
a naive judge. It is the opposite: that hook checks nothing.

This harness reports that case as INCONCLUSIVE and names it, because whether the
editor then proceeds is the editor's policy and not something the harness can
know. It was found live, by this harness, on the machine it was written on.

## Writing your own scenarios

`init` writes one, with the control filled in. A scenario is:

```json
{
  "id": "hardcoded-credential",
  "title": "an API key committed into a source file",
  "defect": "what is seeded, and why it matters",
  "fixture": { "files": { "src/config.js": "..." }, "needs": ["src/config.js"] },
  "run":     { "cmd": "node", "args": ["review.mjs", "${FIXTURE}/src/config.js"] },
  "control": { "run": { "cmd": "node", "args": ["review.mjs", "${FIXTURE}/src/clean.js"] } },
  "expect":  { "type": "output-matches", "pattern": "FOUND credential" }
}
```

`${FIXTURE}` and `${PROJECT}` are substituted. Judges available: `blocked`
(understands Claude Code and Cursor decision shapes plus exit code 2),
`output-matches`, `exit-code`, `nonzero-exit`, and `command` as an escape hatch.

`control` is not optional. Leaving it out returns INCONCLUSIVE with the reason.

## Report honestly

When you answer the user:

- Lead with the MISSED rows. They are the finding and they are worth more than
  the caught ones.
- Never round an INCONCLUSIVE up to a pass or down to a fail. Say what could not
  be measured and why.
- If a guard could not be executed, say that its command points at a file that
  is not there. Do not describe it as protection.
- Give the context cost in bytes as measured, and label the token figure as an
  estimate, because it is one.
- If every scenario was caught, say that the controls also came back clean. That
  second half is what makes the first half mean anything.
