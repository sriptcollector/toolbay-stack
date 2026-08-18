---
name: setup-gbrain
version: 0.1.0
description: Get from zero to "gbrain is running and this agent can actually call it", and prove each capability by running it rather than by reading config. Reports semantic search as DEGRADED when embeddings are disabled, because the query still exits 0 while doing keyword matching. Use to set up gbrain, connect gbrain, install gbrain, check whether gbrain is working, or configure gbrain for this machine.
triggers:
  - setup gbrain
  - connect gbrain
  - install gbrain
  - configure gbrain
  - is gbrain working
  - gbrain health
  - start gbrain
provides:
  - gbrain-capability-probe
  - configured-vs-working-distinction
  - secret-safe-config-report
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# setup-gbrain

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The `/setup-gbrain` skill name and command surface are gstack's,
and gbrain itself is Garry Tan's (https://github.com/garrytan/gstack, MIT,
Copyright (c) 2026 Garry Tan). This code drives the real `gbrain` CLI rather
than reimplementing any of it. See LICENSE and NOTICE.

## What it does

```bash
node skills/setup-gbrain/scripts/tb-gbrain-setup.mjs check     # probe everything, read only
node skills/setup-gbrain/scripts/tb-gbrain-setup.mjs doctor    # gbrain's own health check
node skills/setup-gbrain/scripts/tb-gbrain-setup.mjs init      # create a brain (separate verb, on purpose)
```

`check` and `doctor` **never write to your brain**. Creating one requires typing
`init`.

## The question it actually answers

"Is gbrain set up?" has three plausible answers and only one is useful:

- `gbrain --version` exits 0 → a binary exists
- `~/.gbrain/config.json` exists → someone once ran init
- **`gbrain query` returns rows for this repo** → the only fact worth acting on

A setup skill that checks the first two says "ready", the agent stops using
Grep, and every later answer comes from an index that may be empty.

So each capability gets one of three states, and a capability that was not
*run* is never `WORKS`:

| State | Meaning |
|---|---|
| `WORKS` | proven by running it and reading the output |
| `DEGRADED` | present but doing less than its name implies — and *what* it isn't doing is named |
| `ABSENT` | unavailable, with the reason |

`READY` requires nothing absent **and** nothing degraded.

## The trap this was written for

Measured on a real machine:

```
engine              = pglite      <- configured
database_path       = ~/.gbrain/  <- exists
embedding_disabled  = true        <- so `query` is NOT semantic
```

`gbrain query` still runs, still exits 0, still returns plausible rows — by
keyword matching with query expansion. Nothing about the exit code tells you
vector search never happened. So:

```
semantic search  DEGRADED  `embedding_disabled: true` in config — `gbrain query`
                           still works and still exits 0, but it is keyword
                           matching with query expansion, NOT vector similarity.
                           Re-enable with `gbrain config set embedding_disabled
                           false` then `gbrain embed --all`.
```

Semantic search is deliberately **not probed** when embeddings are off — the
probe would pass on keyword fallback and manufacture the exact false green the
skill exists to prevent.

## Secrets

Any config key matching `key|token|secret|password|credential|dsn|url|conn` is
printed as `<set, N chars, not shown>`. A selftest asserts a planted secret
never reaches rendered output.

## Shell safety

gbrain installs as a `.cmd` shim on Windows, which cannot be spawned without a
shell — and under a shell, argv is concatenated rather than escaped. Rather
than quoting around that, the fallback **fails closed**: an argument containing
shell metacharacters is refused with a reason. A refused search is recoverable;
an executed one is not.

## Selftest

```bash
node skills/setup-gbrain/scripts/tb-gbrain-setup.mjs selftest
```

41 assertions. The load-bearing ones: embeddings-off is `DEGRADED` and never
`WORKS`, an unprobed capability is never `WORKS`, and the rendered trap case
contains no standalone "READY".
