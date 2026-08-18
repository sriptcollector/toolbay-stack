---
name: sync-gbrain
version: 0.1.0
description: Index this repo into gbrain, pin the worktree, and prove the result is searchable by resolving a symbol that only exists in this repo. Reports NOT SEARCHABLE when the sync exits 0 over an empty index, so an agent never abandons Grep for an index that does not contain the code. Use to sync gbrain, refresh gbrain, re-index this repo, or when gbrain search is not finding things.
triggers:
  - sync gbrain
  - refresh gbrain
  - reindex this repo
  - gbrain search isnt finding things
  - index this repo
  - gbrain not finding
provides:
  - repo-to-brain-sync
  - post-sync-searchability-proof
  - worktree-scoping-pin
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

# sync-gbrain

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The `/sync-gbrain` skill name, the `.gbrain-source` worktree pin
and the command surface are gstack's; gbrain is Garry Tan's
(https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan). This
code drives the real CLI. See LICENSE and NOTICE.

## What it does

```bash
node skills/sync-gbrain/scripts/tb-gbrain-sync.mjs sync --full
node skills/sync-gbrain/scripts/tb-gbrain-sync.mjs verify
node skills/sync-gbrain/scripts/tb-gbrain-sync.mjs status
```

Three steps, and the third is the reason the skill exists:

1. run `gbrain sync`
2. write `.gbrain-source` so queries are scoped to this worktree
3. **verify** — ask gbrain for a symbol this repo definitely contains, and
   report `NOT SEARCHABLE` if it comes back empty, *whatever step 1 exited with*

## Why exit 0 is not evidence

`gbrain sync` exiting 0 proves a sync process ran. It does not prove anything
is searchable, and the two come apart constantly: an empty file list, a filter
that matched nothing, a skipped embedding step, a brain that timed out on open.
In every one of those the exit code is 0 and the log says `sync complete`.

The agent then stops using Grep, because it was told the repo is indexed. Every
later answer is drawn from an index without the code in it — a confident wrong
answer where there would have been a correct slow one.

So `syncVerdict` is pure, tested directly, and `syncExitCode === 0` alone never
reaches `SEARCHABLE`:

| Sync | Verified | Hits | Verdict |
|---|---|---|---|
| exit 0 | yes | >0 | `SEARCHABLE` |
| exit 0 | yes | 0 | **`SYNC EXITED 0 BUT THIS REPO IS NOT SEARCHABLE`** |
| exit 0 | skipped | — | `UNVERIFIED` |
| exit 0 | no symbol found | — | `UNVERIFIED` |
| exit ≠0 | any | any | `SYNC FAILED` |

The zero-hit verdict ends with *"Do not rely on gbrain for code questions here —
use Grep."* — an instruction, because the agent reading it needs to change
behaviour, not just be informed.

## The verification symbol is chosen, not hardcoded

A hardcoded symbol is a fixture, and a fixture proves the fixture. So the symbol
is read out of the repo's own source, preferring long distinctive identifiers
and rejecting generic ones — `main`, `run`, `get`, `init`, `handler` and friends
exist in every brain, so resolving them proves nothing about *this* repo.
Minimum length is 12 characters; candidates sort longest first.

Supported: JS/TS exports, classes, functions, and Python `def`. Discovery skips
`node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, `__pycache__`.

## The pin

`.gbrain-source` in the git top level holds a slugged source id. Without it,
queries are not scoped to this repo, so a hit may come from a sibling project —
which looks like success and is a different kind of wrong answer. `status`
shows whether the current worktree is pinned.

## Selftest

```bash
node skills/sync-gbrain/scripts/tb-gbrain-sync.mjs selftest
```

62 assertions, including the whole shared gbrain core. The load-bearing ones:
exit-0-with-zero-hits is `NOT_SEARCHABLE`, `UNVERIFIED` is a distinct state from
`SEARCHABLE`, `main` is never chosen as a verification symbol, and the rendered
report for a zero-hit run says `NOT SEARCHABLE` even though the sync output it
quotes says `sync complete`.
