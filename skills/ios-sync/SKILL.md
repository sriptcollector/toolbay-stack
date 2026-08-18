---
name: ios-sync
version: 0.1.0
description: Resync an iOS app's debug bridge against the upstream gstack ios-qa templates. Every file is classified by content hash into up-to-date, upstream-changed, locally-edited, conflicted, missing or never-stamped, so an app that has never been verified is reported as unknown instead of current, and a generator-owned file is never overwritten with a raw template. Use when asked to resync the iOS debug bridge, regenerate iOS accessors, or update the gstack iOS instrumentation.
triggers:
  - resync the ios debug bridge
  - regenerate ios accessors
  - update the gstack ios instrumentation
  - resync the debug bridge
  - is the ios bridge up to date
  - did my swift accessors get regenerated
  - the debug overlay is out of date
provides:
  - ios-debug-bridge-sync
  - generated-code-drift
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

# ios-sync

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the four-phase workflow (detect version,
regenerate accessors, update templated files in place, verify), the
`DebugBridgeGenerated/` layout, the `gen-accessors` invocation and the
`GSTACK-EDIT-LINE` fold-forward idea all come from `ios-sync` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The templates this skill syncs from are gstack's, read out of
your gstack install; this skill ships no copy of them. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

The upstream skill is 94 lines of prose with no executable part. That is fine
for a workflow a human drives, and it is the wrong shape for this one, because
every judgment it delegates has a failure that reads as success. This fork keeps
the workflow and moves the six decisions that can be computed into
`scripts/tb-ios-sync.mjs`.

## Run it

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs doctor
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs plan --app <app-dir>
```

`<app-dir>` is the directory that contains `DebugBridgeGenerated/`.

Exit codes are the report: `0` nothing to do, `1` mechanical work to do, `2` this
host cannot build an iOS app, `3` the upstream templates could not be located,
`4` a human has to decide. Unknown state is `4`. It is never `0`.

## Workflow

**Step 1. Resolve and preflight.**

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs doctor
```

`resolve` probes an ordered candidate list for gstack's `ios-qa/templates` and
prints every path it tried. `preflight` checks the host can build an iOS app at
all. On Windows or Linux preflight exits 2, and that is the honest answer: you
can still plan and inspect drift, but you cannot verify a sync, so do not report
one as done.

**Step 2. Plan.**

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs plan --app <app-dir>
```

Each bridge file lands in exactly one bucket, decided by SHA-256 of normalised
content against the baseline in `DebugBridgeGenerated/.tbs-sync.json`:

| Status | Means | Who acts |
|---|---|---|
| `UP-TO-DATE` | installed content matches the stamp and upstream has not moved | nobody |
| `UPSTREAM-CHANGED` | the template moved, the install did not | `apply` |
| `LOCALLY-EDITED` | the install was edited after the stamp | you, deliberately |
| `CONFLICT` | both moved | you, by merging |
| `MISSING` | the file is not installed | `apply` |
| `UNSTAMPED` | no baseline, so drift cannot be told from local edits | you, by reviewing then `stamp` |
| `ERROR` | something could not be read or parsed | you |

**Step 3. Check accessor coverage.** This is the actual trigger for a resync:
a new `@Observable` class or a new `@Snapshotable` property with no accessor.

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs coverage --app <app-dir> --source <src-dir>
```

Gaps mean re-run `gen-accessors` (Step 4). If the generated file is absent or
still holds `{{PLACEHOLDER}}` tokens the verdict is `UNVERIFIABLE`, not "no
gaps".

**Step 4. Regenerate the accessors.** This part needs macOS and Swift.

```bash
swift run --package-path "$(node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs resolve --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(require("path").resolve(r.root,"..","scripts","gen-accessors-tool"))})')" \
  gen-accessors --input <src-dir> --output <app-dir>/DebugBridgeGenerated
```

The generator takes `--input` and `--output` and nothing else. It does not have
an `--exclude` flag; to keep test fixtures out, point `--input` at a directory
that does not contain them.

**Step 5. Apply the mechanical updates.**

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs apply --app <app-dir>
```

Copies only `UPSTREAM-CHANGED` and `MISSING` files that carry no
`{{PLACEHOLDER}}` tokens, then re-stamps. It refuses to write anything at all
while any file is `CONFLICT`, `LOCALLY-EDITED` or `UNSTAMPED`. Resolve those by
hand first, then `stamp --app <app-dir>` to set the new baseline.

**Step 6. Verify, and only claim what you ran.** On macOS: `swift build`, then
`xcodebuild -scheme <Scheme>`, then relaunch on device and `GET /state/snapshot`.
Re-run `plan` afterwards; it must come back `0`. If preflight exited 2 you did
not verify anything, so say that instead of listing the steps as done.

## Prove the engine works

```bash
node ~/.claude/skills/ios-sync/scripts/tb-ios-sync.mjs selftest
```

26 assertions against fixtures built to look fine and not be: an app that was
never synced, a stamp that will not parse, a template directory that exists and
is empty, a generator-owned file offered up for overwriting, an accessors file
that is missing entirely. None of them may exit 0. The last assertion is the
count itself, so the suite cannot silently shrink.

## What changed from gstack, and why

Each of these was measured against gstack 1.60.1.0 on 2026-08-13. The commands
that produced them are in the header comment of `scripts/tb-ios-sync.mjs`.

1. **The template path in upstream does not resolve.** Every command in gstack's
   ios-sync (and ios-qa) points at `$GSTACK_HOME/ios-qa/...`. `GSTACK_HOME` is
   not exported by gstack; the preamble only uses it as
   `${GSTACK_HOME:-$HOME/.gstack}` for state. Unset, the path becomes
   `/ios-qa/templates`; with the default it becomes `~/.gstack/ios-qa/templates`.
   Neither exists. `resolve` probes candidates in order, skips environment
   variables that are set but empty, prints what it tried, and exits 3 rather
   than guessing.

2. **The documented early exit fails open.** gstack Phase 1 compares the app's
   `.gstack-version` to upstream's and exits early on a match. Neither file
   exists anywhere in the install, so two absent values compare equal and the
   happy path is to declare the bridge current without looking at it. Here the
   version is printed and never used for that decision; drift is content hashes
   against a stamp, and no stamp means `UNSTAMPED`, exit 4.

3. **Phase 3 would break the build.** It says to replace each installed file
   "outright with the new template". `StateAccessor.swift.template` holds six
   `{{PLACEHOLDER}}` tokens because it is rendered by `gen-accessors`; copying it
   verbatim writes `{{ACCESSORS}}` into the app. `apply` refuses any template
   containing placeholders and says why.

4. **Phase 3 names the wrong files.** It maps every template to
   `DebugBridgeGenerated/<Name>.swift`, but two of the nine are
   `DebugBridgeTouch.h` and `DebugBridgeTouch.m`. Installed names here come from
   stripping `.template`, so ObjC files keep their extensions.

5. **The failure table cites a flag that does not exist.** It advises excluding
   test fixtures with `--exclude`. Both generators accept only
   `--input`/`--output`, and the Swift tool ignores unknown arguments, so that
   advice fails silently.

6. **No host check on a macOS-only workflow.** `swift` and `xcodebuild` exist
   only on macOS. `preflight` exits 2 and names the missing tool, so a sync
   cannot be reported as complete on a machine that could never have compiled
   it.

7. **Windows correctness.** Git Bash paths (`/c/Users/...`) are translated
   rather than resolved to `C:\c\Users\...`; comparisons are case-insensitive on
   win32; content hashes normalise CRLF, lone CR, the UTF-8 BOM and trailing
   whitespace, so a checkout with `core.autocrlf=true` does not report every
   file as locally edited on every run. There is no shell, no `find -mmin`, no
   `date +%s`, no `$PPID`, no `source <(...)`, no symlink assumption and no
   `open`.

8. **Coverage is computed, not recalled.** gstack gates the workflow on "no new
   `@Observable` classes were added". `coverage` scans the Swift sources for
   `@Observable` classes and `@Snapshotable` properties and checks each one
   against the generated accessors, and reports `UNVERIFIABLE` when it cannot
   read them.

## Limits

The Swift half is not verified here. On this Windows machine `preflight` exits 2
and steps 4 and 6 cannot run at all, so the `swift run` and `xcodebuild`
invocations above are carried over from gstack unchanged and are not claimed as
tested. What is tested is everything that decides whether those commands should
run, what they should run against, and whether their output can be trusted
afterwards.
