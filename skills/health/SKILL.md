---
name: health
version: 0.1.0
description: One command that runs every quality check this project actually has, records the real exit code of each, and prints a scored dashboard with the coverage it was computed from. Detects Node, Python, PowerShell, Go and Rust stacks by executing the tools rather than trusting PATH, refuses to average over a check that did not run, and exits non-zero so it can gate a ship. Use for "health check", "code quality", "how healthy is this codebase".
triggers:
  - health check
  - code health
  - code quality
  - how healthy is this codebase
  - quality dashboard
  - run all the checks
  - is the score real
provides:
  - code-health
  - check-runner-integrity
  - quality-trend
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# health

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the "wrap the project's own tools, never
replace them" contract, the typecheck / lint / test / dead code / shell lint
category set, the 0-10 rubric and its count thresholds, the category weights,
the weighted composite, the skipped-tool weight redistribution rule, the
`## Health Stack` section in CLAUDE.md, the JSONL health history and the
impact-ranked recommendations come from `health` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation is a rewrite. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

## Use it

```bash
node ~/.claude/skills/health/scripts/tb-health.mjs doctor      # what is runnable here
node ~/.claude/skills/health/scripts/tb-health.mjs run         # the scorecard
node ~/.claude/skills/health/scripts/tb-health.mjs run --gate 8.5
node ~/.claude/skills/health/scripts/tb-health.mjs trend
```

Exit codes for `run`: `0` verified (and at or above `--gate`), `1` below the
gate, `2` bad arguments, `3` UNVERIFIED. UNVERIFIED is the one that matters: it
means a check could not run, or too little of the rubric was measured to call
the number a health score. gstack's /health has no exit code at all, so nothing
downstream can gate on it.

Other flags: `--dir <path>`, `--json`, `--timeout <ms>` (per check, default
120000), `--only <ids or categories>`, `--no-history`.

## What it will not do

- It never fixes anything. Read-only, same as gstack's rule 2.
- It never runs `npx <tool>` for a tool you do not have, because that downloads
  a package during what is supposed to be a measurement. A missing tool is
  reported as missing.
- It never goes through a shell. Every check is an argv array spawned directly,
  so a path with a space, an MSYS `/c/...` path, or a quote in an argument
  cannot silently change what ran.
- It never writes into the project it is measuring. The Python check compiles in
  memory rather than calling `compileall`, which would leave `__pycache__`
  behind.

## The five states, and why there are five

| State | Meaning | Score | Effect on the verdict |
|---|---|---|---|
| `CLEAN` | ran, exit 0, nothing reported | 10 | none |
| `FINDINGS` | ran, findings counted | by rubric | none |
| `FAILED` | ran, reported failure that could not be counted | 0 | none |
| `BROKEN` | could not run: crash, timeout, tool error, needs a shell | 0 | forces UNVERIFIED |
| `SKIPPED` | not installed | none, weight redistributed | costs coverage |

The split between `FAILED` and `BROKEN` is the whole design. A tool that says
"you have problems" is data. A tool that could not start is a hole in the
measurement, and a number with a hole in it is not a smaller number.

`SKIPPED` is the only state that redistributes weight, exactly as gstack
specifies, and the price is printed next to the score as coverage. A 10.0 at 28%
coverage is one check with an opinion, not a healthy codebase.

## What is different from gstack, and how to check

Every claim below was reproduced on Windows 11 with gstack 1.60.1.0. The
reproductions are quoted in full at the top of `scripts/tb-health.mjs`.

1. **The exit code is real.** gstack (SKILL.md:878-885) tells the agent to run
   `tsc --noEmit 2>&1 | tail -50` and then read `EXIT_CODE=$?`, which is the
   status of `tail`, not of the type checker. A failing check records `EXIT:0`
   and scores 10/10 under gstack's own rubric. Here nothing sits between the
   tool and its status.
2. **The detector sees Windows.** gstack's detector is zsh (`setopt +o nomatch`
   is not a bash builtin) and knows only tsconfig/biome/eslint/pyproject/
   package.json/Cargo/go.mod. Run verbatim against a folder holding `main.py`,
   `requirements.txt` and `deploy.ps1` it prints nothing at all. This one finds
   a Python syntax check and a PowerShell syntax check there with nothing
   installed, using the in-box `System.Management.Automation.Language.Parser`.
3. **PATH is not proof.** gstack tests tools with `command -v`. On Windows
   `command -v python3` succeeds and the thing it found is a Microsoft Store
   stub that exits 49. Every tool here is probed by executing it, and the
   failure reason is printed.
4. **An empty audit cannot score 10.** With nothing detected, gstack skips every
   category, redistributes the weight of nothing among nothing, and still has a
   dashboard to fill in. Here that is `COMPOSITE: none`, verdict UNVERIFIED,
   exit 3.
5. **Deleting a check is not an improvement.** gstack's history line records
   only the scores, so removing the tool that was dragging the average looks
   exactly like fixing the code: "Trend: IMPROVING (+0.9)". Every entry here
   carries the exact set of checks that produced it, and a comparison across two
   different sets prints NOT COMPARABLE with the added and removed checks named.

## Prove it on this machine

```bash
node ~/.claude/skills/health/scripts/tb-health.mjs selftest
```

56 assertions, run against the engine as a child process on fixtures that are
broken on purpose: a tool that exits 2, a tool that hangs, a tool that is not
installed, a PATH stub that fails when executed, a configured command that needs
a shell, a tool whose failure cannot be counted, a corrupt history file, and a
project where nothing is detectable. Each must produce the closed answer. It
exits non-zero if any assertion fails, including the assertion that all 56 ran.

## Configuring the checks

If CLAUDE.md has a `## Health Stack` section it wins over auto-detection, same
as gstack:

```markdown
## Health Stack

- typecheck: tsc --noEmit
- lint: biome check .
- test: npm test
- deadcode: knip
- shell: shellcheck scripts/deploy.sh
- powershell: pwsh -File tools/lint.ps1
```

One command per line, no `&&`, no pipes, no redirects. A line that needs a shell
is reported BROKEN by name rather than half-run, because a check that quietly
measures the wrong half of a command line is worse than no check.

Categories and weights: `typecheck` 22%, `lint` 18%, `test` 28%, `deadcode` 13%,
`shell` 9%, `powershell` 10%. The first five are gstack's numbers unchanged, so
a score here is comparable with a score there. gstack's sixth slot is `gbrain`
at 10%, which measures a gstack service rather than the code; that 10% is
PowerShell here.

## Workflow

1. `doctor` first if this is a new project: it shows what is runnable and what
   is missing, and costs nothing.
2. `run`. Read the coverage before the score.
3. Show the DETAILS block for anything below 10, and the RECOMMENDATIONS list,
   ranked by weight x deficit.
4. Do not fix anything. Report, and let the user pick.
5. On UNVERIFIED, say so first and say which check broke. Never present a
   composite from an UNVERIFIED run as the project's health score.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief health
```

Follow the lines it prints for `health`. Where they disagree with the defaults
above, the mode wins. One thing no mode loosens: an UNVERIFIED run is reported
as UNVERIFIED. A composite from a broken run is never presented as the
project's score.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
