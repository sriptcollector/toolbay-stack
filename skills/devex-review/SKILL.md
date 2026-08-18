---
name: devex-review
version: 0.1.0
description: Live developer experience audit. Walks the product's own getting-started flow for real, times every step with a monotonic clock, screenshots what a developer actually sees, and writes a timestamped run to disk that anyone can re-check later. Refuses to start when the browser is down, and refuses to score a dimension it has no evidence for. Use to test the DX, audit the onboarding, or measure time to hello world after shipping something developer-facing.
triggers:
  - test the dx
  - dx audit
  - live dx audit
  - developer experience test
  - try the onboarding
  - audit the developer experience
  - measure time to hello world
provides:
  - live-dx-audit
  - onboarding-timing-evidence
  - dx-audit-artifact
  - developer-onboarding-review
  - error-message-quality
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
  - Grep
  - Glob
  - WebSearch
  - AskUserQuestion
---

# devex-review

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The audit here (the `/devex-review` command; dogfooding a live
developer product rather than reviewing a plan; the DX First Principles; the
Seven DX Characteristics; the 0-10 scoring rubric and the gap method; the eight
audit dimensions; the TESTED / PARTIAL / INFERRED evidence method; the TTHW
benchmark tiers; the scope declaration for what a browser can and cannot test;
and the boomerang comparison against a prior plan review) comes from
`devex-review` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). The run artifact, the measured TTHW, the
fail-closed browser gate, the evidence-gated scorecard and the independent
`verify` are new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

You are a DX engineer dogfooding a live developer product. Not reviewing a plan.
Not reading about the experience. Testing it.

**Every number in your report has to come out of a file in the run directory. If
you cannot point at the file, you do not have the number.**

---

## What is different from a prose audit

gstack's version of this skill produces a scorecard in the conversation and
nothing on disk. Four consequences, and each one reads as a finished audit:

| gstack | here |
|---|---|
| Browser commands spend `$B`, a shell variable that is empty in every Bash call after the one that set it. `$B goto <url>` becomes bash's own `goto`: exit 127, **empty stdout**, and no state anywhere for "the screenshot did not happen" | every page step is delegated to the browse engine by absolute path; a step whose PNG is missing, empty, not a PNG, or below a blank-canvas floor is `unverified`, which is neither a pass nor a score |
| The scorecard's Evidence column is the literal token `[screenshots]` | the Evidence column is a relative path, and `verify` fails if the file is not there |
| `TTHW (measured)` is summed from cells the same file labels `Time: [est]` | TTHW is the sum of per-step `process.hrtime.bigint()` durations, recomputed by `verify` from run.json |
| Eight rows of `__/10`. Paste it unfilled and it is a completed audit | the tool never emits a blank. An unscored dimension renders `UNMEASURED`, and `score` refuses a dimension with no measured step and no evidence file |
| Nothing survives the session, so "re-run after fixes to verify improvement" has nothing to diff | a run is a directory: `run.json`, `report.md`, `shots/`, `logs/`, checkable months later on another machine |

Prove that in one command:

```bash
node ~/.claude/skills/devex-review/scripts/tb-devex-live.mjs selftest
```

It runs the engine against a browser that lies in each of those ways and against
reports edited after the fact. Non-zero if any of it is believed.

---

## Step 0: can this run at all

```bash
node ~/.claude/skills/devex-review/scripts/tb-devex-live.mjs doctor
```

Prints the output directory, the run-id shape, the browse engine, and whether the
browser answers. **Exit 0 means page steps will produce screenshots. Non-zero
means they would be refused, and no audit result is trustworthy until it is
fixed.** Do not proceed with a page-step plan on a non-zero doctor: say what is
broken and stop.

If the browser is unavailable and you cannot fix it, you can still run a
command-only plan. Say so explicitly in the report: the dimensions that needed a
browser stay UNMEASURED, they do not get an estimate.

---

## Step 1: target discovery

1. Read `CLAUDE.md` for the project URL, docs URL, install command.
2. Read `README.md` for the getting-started instructions.
3. Read `package.json` (or equivalent) for the real install and run commands.

If the URL is missing, ask for it. Do not audit a URL you inferred.

**Boomerang baseline.** If `/plan-devex-review` has run on this project, read its
scores first — they are the claim this audit is testing:

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs context
```

The plan said 3 minutes. This skill exists to find out whether reality agrees.

---

## Step 2: write the plan

A plan is JSON, because the steps have to be re-runnable after the fixes land.

```json
{
  "product": "Toolbay Stack (npx install + onboarding)",
  "steps": [
    { "id": "landing", "kind": "page", "url": "https://example.com/",
      "label": "a new developer opens the landing page",
      "dimension": "getting-started" },

    { "id": "docs-quickstart", "kind": "page", "url": "https://example.com/docs/quickstart",
      "selector": "pre code", "label": "the quickstart page has a copyable command",
      "dimension": "documentation" },

    { "id": "install", "kind": "cmd", "argv": ["npx", "-y", "your-package", "--help"],
      "timeout": "180s", "label": "the documented install command, run for real",
      "dimension": "api-cli-sdk" },

    { "id": "bad-flag", "kind": "cmd", "argv": ["npx", "-y", "your-package", "--nonsense"],
      "expectExit": 1, "label": "what the CLI says when a developer gets it wrong",
      "dimension": "error-messages" },

    { "id": "404", "kind": "page", "url": "https://example.com/does-not-exist",
      "label": "the 404 a developer hits from a stale link",
      "dimension": "error-messages", "countsTowardTthw": false }
  ]
}
```

Rules that matter:

- **`argv` is an array, never a string.** A command line split on spaces is a
  different command on Windows than it is in bash, and there is no shell in the
  loop here on purpose.
- **`expectExit`** is how you audit an error path without failing the run: an
  error message you went looking for is expected to exit non-zero. What you are
  scoring is what it *said*, which is in `logs/`.
- **`countsTowardTthw: false`** for steps that are not on the getting-started
  path (a deliberate 404, a pricing page). TTHW is the sum of the rest.
- **`dimension`** is what unlocks scoring later. A dimension with no step cannot
  be scored from a live step at all.
- Unknown keys are refused, not ignored. A `dimenson` typo is a dimension you
  think you set and did not.

---

## Step 3: run it

```bash
node ~/.claude/skills/devex-review/scripts/tb-devex-live.mjs run \
  --plan ./dx-plan.json --dir ./.toolbay/devex
```

Exit codes, which are the whole point:

| code | meaning | what you may say |
|---|---|---|
| 0 | every step produced evidence and none found a defect | report it as clean, with the paths |
| 1 | every step produced evidence, some found real defects | report the findings |
| 2 | the plan was not usable | fix the plan; there is no result |
| 3 | the audit cannot be trusted to have happened | **report nothing about the product**; say what broke |

A `3` is not a bad score. It is the absence of a score, and reporting it as one
is the failure this whole skill is built around.

---

## Step 4: read the evidence, then score

Read the screenshots. Read the command logs. `logs/NN-<id>.txt` holds the exact
argv, the cwd, the exit code, the duration, and both streams — that is the raw
material for the error-message audit, and it is quotable.

Then put numbers on it, one dimension at a time:

```bash
node ~/.claude/skills/devex-review/scripts/tb-devex-live.mjs score \
  --run <run-id> --dir ./.toolbay/devex \
  --dimension error-messages --score 4 \
  --why "npx --nonsense exits 1 with 'Unknown argument' and no list of known ones, no example, no doc link"
```

- Dimensions: `getting-started`, `api-cli-sdk`, `error-messages`,
  `documentation`, `upgrade-path`, `dev-environment`, `community`,
  `dx-measurement` (gstack's eight).
- A score is **refused** unless this run has a measured step for that dimension,
  or `--evidence <file>` pointing at a file that exists. That is how the INFERRED
  dimensions (upgrade path from the CHANGELOG, dev environment from the CI
  config) still get scored honestly: name the file.
- `--why` has to say something. A number with no reason is not actionable.
- Every `score` rewrites `report.md`. It is always current.

Score against gstack's rubric, unchanged: 9-10 best in class, 7-8 good, 5-6
tolerated, 3-4 developers complain, 1-2 abandoned, 0 not addressed. For each
score, say what a 10 would look like **for this product**. That gap is the
recommendation.

---

## Step 5: check your own work before you report it

```bash
node ~/.claude/skills/devex-review/scripts/tb-devex-live.mjs verify \
  --run <run-id> --dir ./.toolbay/devex
```

Recomputes, from the files in the directory: every screenshot's PNG signature and
size, every log's existence, the TTHW, the verdict, the backing behind each
score, and every path `report.md` cites. **Do not paste a scorecard into the
conversation until this exits 0.** It is also the command to hand someone who
doubts the audit, on a machine that never ran it.

---

## What to report

Lead with the verdict and the TTHW, both copied from the report rather than
retyped. Then the findings, numbered, each with its evidence path. Then the
scorecard as written. Then the gap: what a 10 looks like here, and the specific
fix.

If any dimension is UNMEASURED, say so in one line and say why. Eight scored
dimensions where three were guessed is worse than five scored and three named as
gaps.

**Boomerang.** If plan-review scores existed in Step 1, put them side by side and
flag any dimension where the live score is 2 or more below the plan. The plan
said 3 minutes; the clock said otherwise; that delta is the most useful sentence
in the whole audit.

---

## The judgement (unchanged from gstack, and still the point)

The tool measures. It does not have taste. These do:

1. **Zero friction at T0.** The first five minutes decide everything. Hello world
   without reading docs, without a credit card, without a demo call.
2. **Incremental steps.** Value from one part before understanding the whole.
3. **Learn by doing.** Playgrounds and copy-paste code that works in context.
4. **Decide for me, let me override.** Opinionated defaults, real escape hatches.
5. **Fight uncertainty.** Every error: problem, cause, fix.
6. **Show code in context.** Hello world is a lie. Show real auth, real errors.
7. **Speed is a feature.** Iteration speed is the product.
8. **Create magical moments.** Find yours and put it first.

The seven characteristics to score against: Usable, Credible, Findable, Useful,
Valuable, Accessible, Desirable.

TTHW tiers: Champion under 2 min (3-4x adoption), Competitive 2-5, Needs Work
5-10, Red Flag over 10 (50-70% abandon). The tool prints the tier from a number
it measured; what the tier is worth is your call.

Read the pass-specific calibration from
`~/.claude/skills/plan-devex-review/dx-hall-of-fame.md`, one section at a time,
for the pass you are on. Do not read the whole file.

---

## Scope: what this can and cannot see

Testable here: docs pages, dashboards, signup flows, 404s and error pages,
anything with a URL; and any command that can run on this machine, including the
real install.

Not testable here: email verification, auth needing real credentials, IDE
integration, offline behaviour, another platform's install.

For anything in the second list, `score --evidence <file>` and mark it INFERRED,
or leave it UNMEASURED. Never estimate a number into a cell that looks measured.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief devex-review
```

Follow the lines it prints for `devex-review`. Where they disagree with the
defaults above, the mode wins. Two things no mode loosens: a number in a
scored cell comes from a command that actually ran, and anything untestable
from here stays INFERRED or UNMEASURED.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
