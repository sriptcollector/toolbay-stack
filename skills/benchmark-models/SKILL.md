---
name: benchmark-models
version: 0.1.0
description: Run the same prompt through Claude, GPT (Codex CLI) and Gemini side by side and compare latency, tokens and cost. Refuses to name a winner unless at least two models actually ran, reports a model that is not installed as UNAVAILABLE rather than as zero, and voids the comparison if the runs did not all see the same prompt. Use to benchmark models, compare models, run a model shootout, or ask which model is best for a task.
triggers:
  - benchmark models
  - compare models
  - model shootout
  - which model is best
  - cross-model comparison
  - claude vs gpt
  - claude vs gemini
provides:
  - cross-model-latency-comparison
  - model-availability-detection
  - refusal-to-score-what-did-not-run
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Write
---

# benchmark-models

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The skill name, the command surface and the idea of a cross-model
shootout inside the skill suite are gstack's, by Garry Tan
(https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan). The
code is a rewrite. See LICENSE and NOTICE.

Separate from `/benchmark`, which measures web page performance.

## What it does

Runs one prompt through every model CLI it can find, one at a time, and prints
latency, tokens and cost in a table.

```bash
node skills/benchmark-models/scripts/tb-model-bench.mjs detect
node skills/benchmark-models/scripts/tb-model-bench.mjs run --prompt "Explain a race condition to a new hire."
node skills/benchmark-models/scripts/tb-model-bench.mjs run --prompt "..." --models claude,gpt --timeout 180 --out .toolbay/bench.json
```

## Run it first, before you promise a comparison

`detect` exits non-zero when fewer than two CLIs are available. Run it before
telling anyone you benchmarked anything:

```
Claude (claude CLI)  available      2.1.229 (Claude Code)
GPT (codex CLI)      not available  not installed (`codex` is not on PATH)
Gemini (gemini CLI)  not available  not installed (`gemini` is not on PATH)

1 of 3 available. A comparison needs at least two.
```

Install what is missing (`npm i -g @openai/codex`, `npm i -g @google/gemini-cli`)
or accept that the run is a measurement of one model, not a comparison.

## The four rules it enforces

A scoreboard is worth exactly as much as its refusal to score what it could not
measure. `decideOutcome` is the only function that turns results into a verdict,
and it is tested directly:

1. **A model that did not run is `UNAVAILABLE`** — never `0ms`, never `$0.00`,
   never "slowest", and never quietly dropped from the table.
2. **Fewer than two models ran ⇒ `NO COMPARISON`.** Not a winner with an
   asterisk. The single result is still printed, labelled a measurement.
3. **`ERROR` ≠ `UNAVAILABLE`.** "We asked it and it broke" and "we never asked
   it" are different facts about a model, and only one of them is about the model.
4. **Every compared run must have seen the same prompt.** The prompt is hashed;
   a mismatch voids the comparison. Otherwise the table still has a number in
   every cell and the error is invisible.

## What it does not claim

- **Latency is not quality.** The report says so on the line under the winner.
  For quality you need a judge, and a judge you did not run is not a result.
- **Tokens read `not reported`** unless a CLI reports its own accounting in a
  stable documented shape. None of the three currently do. An estimate printed
  in a measurement column is a wrong number wearing the right clothes.
- **Prices are a dated snapshot** (see `PRICE_TABLE_DATE`), not a live lookup.
  Models whose CLI does not say which model it billed read `no price`, not `$0`.
  `--no-cost` removes the column.

## Why runs are sequential

Three CLIs racing for the same CPU makes the latency column measure contention
rather than the models. It is slower on purpose.

## Selftest

```bash
node skills/benchmark-models/scripts/tb-model-bench.mjs selftest
```

33 assertions, including the ones that matter most: two-unavailable-plus-one-ran
names no winner, a timeout is not an unavailability, and two runs on different
prompts are not comparable.
