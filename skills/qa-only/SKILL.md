---
name: qa-only
version: 0.1.0
description: Audit a running web application and write a report, changing nothing. The read-only claim is sealed and re-checked, so an audit that edited a file fails instead of calling itself report-only, and the health score is computed from evidence instead of asserted. Use when asked to just report bugs, QA without fixing, audit a client app, or produce a bug report.
triggers:
  - report only
  - just report
  - test but dont fix
  - don't fix
  - without fixing
  - bug report
  - just check for bugs
  - audit the app
provides:
  - qa-report-only
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
  - AskUserQuestion
---

# qa-only

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (report-only QA, the modes full / quick /
regression, the eight weighted health-score categories with their deduction
bands, the per-issue screenshot evidence rule, the `baseline.json` regression
contract, the per-page exploration checklist and the report layout) comes from
`qa-only` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). The read-only seal, the coverage floor and the
computed score are new. Not affiliated with or endorsed by Garry Tan. See
NOTICE.

You are a QA engineer with your hands tied behind your back. Click everything,
fill every form, check every state, write down what is broken with evidence
attached. Change nothing. Not the source, not the config, not a "harmless"
formatting fix.

For the test-fix-verify loop, use `/qa` instead. This one is what you point at
someone else's app.

---

## Setup

| Parameter | Default |
|---|---|
| Target URL | required, or auto-detected from the dev server |
| Mode | full |
| Output dir | `./.toolbay/qa-only/` |
| Scope | whole app, or the diff if you are on a feature branch |

**Open the audit:**

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs init \
  --target http://localhost:3000 --root .
```

`init` prints absolute paths for the ledger and the screenshots directory, and
seals the project tree. Use those exact paths for every artifact. Write nothing
outside them.

Do not pass `--dir /tmp/qa` on Windows; it is refused, with both of the
directories that string would mean printed out. gstack's setup table offers
`Output to /tmp/qa` (`qa-only/SKILL.md.tmpl:40`). Measured on Windows 11:

```
$ cd /tmp && pwd -W
C:/Users/orion/AppData/Local/Temp
$ node -e "console.log(require('path').resolve('/tmp/qa'))"
C:\tmp\qa
```

The browser writes the screenshot into one and the report links to the other,
so every piece of evidence in the report 404s and nobody notices, because
nothing checks.

---

## The seal

`init` fingerprints the project: git mode records HEAD, the full porcelain
status and a hash of every file that was already dirty; outside a repo it walks
the tree and records size and mtime for every file. Everything under the output
dir, `.toolbay/` and `.gstack/` is exempt, because that is where you are
supposed to be writing.

`verdict` re-reads it. Any file created, modified or deleted is a **read-only
violation**: the run exits 4 and names the file. If the tree cannot be re-read
at all, the audit is **UNSEALED** and still fails; there is no path where a
broken check quietly certifies the audit.

This is the entire reason to reach for `/qa-only` over `/qa`, so it is the one
thing that is not left to good intentions.

---

## Modes

**Full** (default): visit every reachable page. Depth over breadth: 5-10 well
evidenced findings beat 20 vague ones.

**Quick**: homepage plus the top 5 navigation targets. Does it load, are there
console errors, are there broken links.

**Regression**: run full, then diff against a baseline from a previous audit.

---

## Walk the app

At every page: load it, screenshot it, read the console, then work the
checklist.

1. **Visual** — layout, overflow, alignment, anything that looks wrong in the
   screenshot.
2. **Interactive** — click every button and control. Does it do the thing?
3. **Forms** — submit them empty, invalid, oversized, and with the wrong type.
4. **Navigation** — every path in and every path out, including the back button.
5. **States** — empty, loading, error, unauthorized, and the second visit with a
   warm cache.
6. **Console and network** — errors after each interaction, failed requests.
7. **Responsive** — a mobile width as well as desktop.

Record findings as you go, one command per finding, never batched at the end:

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs record \
  --id ISSUE-001 --check "checkout submits with an empty cart" \
  --status fail --severity critical --category functional \
  --url http://localhost:3000/checkout \
  --evidence .toolbay/qa-only/screenshots/issue-001.png
```

Record what worked too, with `--status pass` and the page URL: coverage is
computed from checks that carry evidence, and an audit with no passing pages
has no coverage.

**Severity**: `critical` (data loss, security, total breakage), `high` (a core
flow is unusable), `medium` (degraded or confusing), `low` (cosmetic).

**Category**: `console`, `links`, `visual`, `functional`, `ux`, `performance`,
`content`, `accessibility`. Both are required on a finding, because the score is
computed from them rather than estimated.

Rules that are actually enforced: a finding needs an artifact that exists and is
not zero bytes (or a real HTTP status from a real URL), an id cannot be
re-recorded without `--force`, and a 5xx cannot back a pass.

Rules that are on you: never write a real password into the report, verify a
finding twice before recording it so you are not reporting a fluke, and read the
screenshot back with the Read tool so the user can see it.

---

## Score

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs score
```

gstack's rubric, unchanged: eight categories, each starting at 100, weighted
console 15, links 10, visual 10, functional 20, ux 15, performance 10, content
5, accessibility 15. Console bands on error count (0 → 100, 1-3 → 70, 4-10 →
40, 10+ → 10), links lose 15 each, everything else loses 25 / 15 / 8 / 3 by
severity.

What is different is the gate. Below the coverage floor there is no score at
all, and the command prints what the ungated rubric would have returned so the
difference is visible:

```
NO SCORE  0 page(s) were visited with evidence, below the floor of 1.
          The same rubric, ungated, returns 100.0 for this run: every category
          starts at 100 and nothing was found because nothing was tested.
```

That 100.0 is gstack's answer for an app the browser never opened, and it is the
number that ends up in the report and the PR body.

---

## Verdict

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs verdict
```

VALID is the only clean outcome and it is computed. It requires: at least one
check recorded, every check backed by an artifact that exists and is non-empty
or a real HTTP status, at least one page with evidence, and a tree that is
unchanged since `init`.

Exit codes: `0` valid, `1` the report cannot be trusted, `2` the ledger or the
arguments are unusable, `3` refused, `4` read-only violated or unsealed.

If the report was written somewhere outside the output dir on purpose, pass
`--allow <path>` for it. Do not use `--allow` to wave through a source file.

---

## Regression

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs baseline --out baseline.json
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs regression --baseline baseline.json
```

`baseline` refuses to freeze a run the verdict called invalid, so a bad audit
cannot become the thing every later audit is measured against.

`regression` fails closed. A baseline that is missing, truncated, missing its
fields, or belonging to a different target exits non-zero and prints nothing.
gstack leaves this undefined, and the natural degradation there is a regression
section listing no new issues, which reads as good news.

---

## Report

Write to `.toolbay/qa-only/qa-report-{host}-{YYYY-MM-DD}.md`:

- one section per finding: id, severity, category, the page, repro steps, what
  you expected, what happened, the screenshot
- the top 3 things to fix, in severity order
- console health across the whole app
- the `score` output verbatim, including the per-category arithmetic
- the `verdict` output verbatim, including the read-only line

One line for a PR or a client email: `QA found N issues across P pages, health
score X/100, nothing was modified.` Take those numbers from the commands. Do not
restate them from memory.

No fixes in the report. Not a patch, not a diff, not "the fix is probably a null
check in auth.ts". You did not read the source, and a fix you did not test is a
guess wearing a suit. Findings only; `/qa` fixes things.

---

## Prove the checks work

```bash
node ~/.claude/skills/qa-only/scripts/tb-qaonly.mjs selftest
```

Covers every way a report-only audit lies: an app that was never opened scoring
100, a finding with no screenshot behind it, a screenshot that is 0 bytes
because the browser was down, a regression diff against a baseline that is
missing or belongs to another app, a baseline minted from a broken run, and
source files edited mid-audit by a report that still calls itself read-only.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief qa-only
```

Follow the lines it prints for `qa-only`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
