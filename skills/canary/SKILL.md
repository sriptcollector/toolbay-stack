---
name: canary
version: 0.1.0
description: Watch production after a deploy and prove the thing you deployed is the thing being served. Every claim is backed by a request this skill made itself, so an unreachable origin, a timeout, or a domain still serving the previous build fails the run instead of reading as healthy. Use after shipping, or when asked to monitor a deploy, watch production, or check whether something is actually live.
triggers:
  - canary
  - monitor the deploy
  - post-deploy check
  - watch production
  - verify the deploy
  - check the deploy
  - is it actually live
  - did the deploy go out
provides:
  - deploy-verification
  - uptime-monitoring
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

# canary

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (the `/canary` command and its arguments, baseline
capture before the deploy, the monitoring loop across a page list, alert on
CHANGE rather than on absolutes, the transient-tolerance rule, the
CRITICAL/HIGH/MEDIUM/LOW ladder, the HEALTHY/DEGRADED/BROKEN verdict and the
report layout) comes from `canary` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). Build-identity verification and the computed verdict are new.
Not affiliated with or endorsed by Garry Tan. See NOTICE.

You are the safety net between "shipped" and "verified". A deploy that passes CI
can still miss production: a stale CDN edge, a missing env var, an alias that
never moved. Catch it in the first ten minutes.

---

## The question this skill exists to answer

Not "does the site load". **Is the site serving the commit I just deployed.**

A build can go green, exit 0, and never alias. The domain keeps serving the
previous build: every page loads, the console is clean, latency is normal. Ask
"is it healthy" and the answer is yes. Ask "is it MINE" and there is no answer at
all unless something checked.

So the first thing you need is a marker the live site exposes, and there are only
three places it can be: a response header (`x-build-id`, `x-commit`), a version
endpoint (`/version`, `/api/health`), or something in the HTML (a `<meta>` tag, a
hashed asset filename). If the app exposes none of them, say so — this run can
prove the site answers but not that it is yours, and that is a gap worth one line
in the app before the next deploy.

---

## Before the deploy

```bash
node ~/.claude/skills/canary/scripts/tb-canary.mjs baseline \
  --url https://example.com/ --url https://example.com/dashboard
```

Records latency and size per page. A baseline whose pages did not answer is
refused rather than written half-empty, because everything afterwards is measured
against it.

## After the deploy

```bash
node ~/.claude/skills/canary/scripts/tb-canary.mjs init \
  --url https://example.com --build "$(git rev-parse --short HEAD)"

node ~/.claude/skills/canary/scripts/tb-canary.mjs probe
node ~/.claude/skills/canary/scripts/tb-canary.mjs watch --duration 10m --interval 60s
node ~/.claude/skills/canary/scripts/tb-canary.mjs verdict
```

`watch` does its own waiting in-process, so a ten-minute canary is one command
with timestamped rounds, not an agent trying to pace a shell timer across turns.

Anything the browser sees and this script cannot — console errors, a visual
regression — goes in as an observation with the artifact attached:

```bash
node ~/.claude/skills/canary/scripts/tb-canary.mjs record \
  --id OBS-1 --check "no new console errors on /dashboard" --status ok \
  --evidence .toolbay/canary/screenshots/dashboard-check3.png
```

An observation claiming `ok` whose artifact is missing or zero bytes is recorded
as **unverified**, and one unverified observation stops the run being HEALTHY.
Screenshots are only evidence if something opened them.

---

## What fails, and how fast

BROKEN on the **first** observation, no confirmation round needed:

| finding | why it is instant |
|---|---|
| unreachable (refused, DNS, TLS) | a check that could not run is not a check that passed |
| no response inside the timeout | same |
| 5xx | the deploy is serving errors |
| **200 without your build marker** | the origin is up on somebody else's build, probably the previous one |
| you passed `--build` and nothing ever confirmed it | silence is not health |
| nothing recorded at all | an empty canary run is an unobserved deploy |

DEGRADED: 4xx, an empty body, a 200 reached by redirect to a different origin (a
login wall or deployment protection answering for the app), a missing
`--body-contains` string, an unverified observation.

Latency is the one finding that waits: a page needs `--consecutive` (default 2)
slow rounds in a row before it counts, which is what gstack's transient-tolerance
rule was actually for.

`verdict` exits **0 only for HEALTHY**, so it can gate a rollback:

```bash
node ~/.claude/skills/canary/scripts/tb-canary.mjs verdict || vercel rollback
```

---

## Why the verdict is computed

gstack's canary is 232 lines of prose and zero executable checks:

```
$ ls ~/.claude/skills/gstack/canary/
SKILL.md  SKILL.md.tmpl
```

Three consequences, and they compound:

**It never asks which build is serving.**

```
$ grep -inE "commit|sha|build id|deployment|alias" canary/SKILL.md.tmpl
4:version: 1.0.0
```

That is the entire match set, and it is the frontmatter. The most common real
deploy failure is invisible to it.

**A check that could not run reads as a check that passed.** The loop is
`$B goto`, `$B console --errors`, `$B perf` (`canary/SKILL.md.tmpl:139-144`). If
the browse daemon is down, the agent gets no console errors back, and "no new
console errors" is exactly what the HEALTHY branch is looking for. There is no
state anywhere in the skill for "the check did not happen".

**A single-pass run can never alert.** `--quick` is "single-pass health check, no
continuous monitoring" (`:43`), and the alert rule is "only alert on patterns
that persist across 2 or more consecutive checks" (`:147`, `:222`). A `--quick`
canary that finds production down is instructed to hold its fire.

And the output is `VERDICT: [DEPLOY IS HEALTHY / DEPLOY HAS ISSUES]` (`:192`) —
a sentence, which nothing downstream can gate on.

## Windows

No shell, no browse daemon, no coreutils. Node makes the request itself, so the
same command produces the same evidence from Git Bash, PowerShell and cmd.
`--dir /tmp/canary` is refused on win32 with both directories that string means
printed out, for the same measured reason as `/qa`.

## Prove the checks work

```bash
node ~/.claude/skills/canary/scripts/tb-canary.mjs selftest
```

57 cases, each one a way a post-deploy check reports success without having
established anything. It stands up a real HTTP server, drives the real CLI
against it as child processes, and fails loudly if any of them reach HEALTHY.

## Important rules

- **Alert on changes, not absolutes.** A page with 3 console errors before the
  deploy and 3 after has not regressed.
- **A screenshot nobody opened is not evidence.** Record it with `--evidence` or
  do not claim it.
- **Read-only.** Observe and report. Fix only if the user asks.
- **Never report a deploy healthy that the ledger does not support.** If
  `verdict` says BROKEN, the deploy is broken, whatever the narrative says.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief canary
```

Follow the lines it prints for `canary`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
