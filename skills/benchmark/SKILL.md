---
name: benchmark
version: 0.1.0
description: Measure a page, store the numbers as a baseline, and fail the run when a change makes it slower or heavier. Every threshold lives in a file that is validated before use, so a metric with no rule, a baseline from another machine, a browser that returned nothing, or a bundle that collapsed because the build broke all stop the run instead of reading as "no regression". Use before and after a change, or when asked about page speed, bundle size, load time or a performance regression.
triggers:
  - benchmark
  - performance regression
  - did it get slower
  - bundle size
  - page speed
  - load time
  - performance budget
provides:
  - performance-benchmark
  - performance-regression-gate
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - AskUserQuestion
---

# benchmark

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (the `/benchmark` command and its arguments, baseline
capture before a change, before/after comparison per page, the metric set (TTFB,
paint, DOM timings, request count, transfer size, JS and CSS bundle size), the
REGRESSION/WARNING ladder and the numeric thresholds it uses, the budget check,
the slowest-resource list and the report layout) comes from `benchmark` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The executable measurement, the validated threshold contract and
the fail-closed verdict are new. Not affiliated with or endorsed by Garry Tan.
See NOTICE.

Performance does not die in one big regression. It dies at 50ms and 20KB per PR
until the app takes eight seconds to load and nobody knows when it happened. Your
job is to make each of those 20KB visible on the day it lands.

---

## The rule this skill is built on

**A measurement that did not happen is not a measurement that found nothing.**

Everything below follows from that. A missing baseline, a browser that returned
an empty string, a metric with no threshold, a baseline from a different laptop:
each of those is a state where the honest answer is "I do not know", and each of
them is one keystroke away from being reported as green.

---

## Before the change

```bash
node ~/.claude/skills/benchmark/scripts/tb-benchmark.mjs baseline \
  --url https://example.com/ --samples 5
```

Fetches the page, then fetches every script, stylesheet and image it references,
and records the median of N samples with the spread kept. It writes two files:

- `.toolbay/benchmark/baseline.json` — the numbers, plus the host, platform, arch,
  Node version, commit and branch they came from.
- `.toolbay/benchmark/thresholds.json` — the gate. Written once with defaults,
  yours to edit, and validated on every run.

Browser-only metrics (FCP, LCP, DOM timings) need a rendering engine, so they
come through the forked browse daemon and are folded into the next baseline:

```bash
node ~/.claude/skills/benchmark/scripts/tb-benchmark.mjs collect --browser \
  --url https://example.com/
```

## After the change

```bash
node ~/.claude/skills/benchmark/scripts/tb-benchmark.mjs compare --samples 5
```

Exit **0 only for PASS**, so it can gate a ship:

```bash
node ~/.claude/skills/benchmark/scripts/tb-benchmark.mjs compare || exit 1
```

---

## What stops the run

| finding | verdict | exit |
|---|---|---|
| a metric got worse past its fail threshold | REGRESSION | 1 |
| a deterministic metric **collapsed** (bundle lost half its weight) | REGRESSION | 1 |
| the baseline has a metric this run did not measure | UNMEASURED | 1 |
| the origin did not answer at all | UNMEASURED | 1 |
| the baseline is too noisy to tell a regression from the machine | INCONCLUSIVE | 1 |
| no baseline, corrupt baseline, no threshold contract, corrupt contract | UNUSABLE | 2 |
| a baseline metric with no rule in the contract | UNUSABLE | 2 |
| a contract where every rule is disabled | UNUSABLE | 2 |
| a baseline from another machine, or older than `--max-age` | REFUSED | 3 |
| overwriting an existing baseline without `--force` | REFUSED | 3 |

The collapse rule is worth stating twice. Every threshold in gstack's list fires
on an increase, so a deploy that breaks the bundler and serves a 4KB error page
in place of a 700KB app scores as six improvements in a row. Here that is
`suspect` and it fails.

---

## The threshold contract

The gate is a file, not a paragraph:

```json
"js_bytes": {
  "enabled": true, "kind": "deterministic",
  "warn_pct": 10, "fail_pct": 25, "fail_abs": null,
  "floor": 2048, "suspect_drop_pct": 50
}
```

Four rules it enforces about itself:

1. **Every metric in the baseline must have a rule.** No rule is not "no
   opinion", it is an unthresholded metric counted as a pass.
2. **Opting out is allowed and is written down.** `thresholds --disable ttfb_ms`
   sets `enabled: false`, which shows up in the diff and prints as DISABLED in
   every report. A skipped metric is never silent.
3. **A typo is refused, not ignored.** `fail_percent` instead of `fail_pct` stops
   the run and names the key. A threshold you think you set and did not is worse
   than no threshold.
4. **`floor` stops the crying wolf.** A 3ms metric cannot post a 200% regression,
   and a timing delta smaller than the baseline's own jitter is not a finding.

Timing metrics over the public internet are usually too noisy to gate on from a
few samples. That is a real answer, not a bug: raise `--samples`, or disable them
deliberately and gate on the byte metrics, which are deterministic. Measured on
`https://toolbay.ai/`, bytes matched to the byte across runs while TTFB varied
86%.

---

## Why any of this is executable

gstack's `/benchmark` is prose. Measured on Windows 11, gstack 1.60.1.0:

```
$ ls ~/.claude/skills/gstack/benchmark/
SKILL.md  SKILL.md.tmpl

$ grep -cE '^\s*(node|bun|python|\./)' benchmark/SKILL.md.tmpl
0
```

**Five of its seven measurement commands measure nothing, silently.** They are
`$B eval "<javascript>"`, where `$B` is a shell variable set in a SETUP block. In
Claude Code every Bash call is a fresh shell, so `$B` is empty by the next call,
and the command does not fail loudly. It becomes bash's own builtin `eval` and
tries to run the JavaScript as a shell command:

```
$ $B eval "JSON.stringify(performance.getEntriesByType('navigation')[0])"
bash: eval: line 1: syntax error near unexpected token `performance.getEntriesByType'
exit=2                                              <- and stdout is EMPTY

$ $B perf
bash: line 1: perf: command not found
exit=127                                            <- stdout EMPTY again
```

Empty stdout is indistinguishable, anywhere in that skill, from a page with
nothing to report. There is no state in the workflow for "the measurement did not
happen".

**The thresholds are sentences** (`SKILL.md.tmpl:168-172`), applied by a model
eyeballing two numbers, and the skill has no exit code anywhere, so nothing
downstream can gate on it.

**Re-baselining buries the regression.** `--baseline` overwrites
`baselines/baseline.json` with no guard, so running it once out of habit after
the slow change lands makes the slow numbers the reference point forever. Here
the overwrite is refused and the refusal prints the delta it would have buried.

**Nothing records where the numbers came from.** The file has a `branch` field
that nothing ever reads. A baseline captured on one machine and compared on
another is confident nonsense.

## Windows

No shell, no `$B`, no coreutils, no `date +%s`. Node makes the requests and times
them itself, so the same command produces the same numbers from Git Bash,
PowerShell and cmd, and there is no variable that has to survive a tool call.
`--dir /tmp/bench` is refused on win32 with both directories that string means
printed out.

## Prove the checks work

```bash
node ~/.claude/skills/benchmark/scripts/tb-benchmark.mjs selftest
```

77 cases. It stands up a real HTTP server, drives the real CLI against it as
child processes, and stubs the browse engine with six different ways of coming
back empty. Every case is a way a performance check reports no regression without
having established one. None of them reach PASS.

## Important rules

- **Measure, do not estimate.** Bytes are counted as they arrive, not read from
  `resource.transferSize`, which a browser is allowed to report as 0 for a cached
  or cross-origin resource.
- **Bundle size is the leading indicator.** Load time varies with the network;
  bytes do not. If you gate on one thing, gate on bytes.
- **Third-party scripts are context.** Flag them, but the user cannot make
  someone else's analytics fast. Recommend against first-party resources.
- **Read-only.** Produce the report. Do not change code unless asked.
- **Never report a page unchanged that the verdict does not support.** If
  `compare` says REGRESSION, it is a regression, whatever the narrative says.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief benchmark
```

Follow the lines it prints for `benchmark`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
