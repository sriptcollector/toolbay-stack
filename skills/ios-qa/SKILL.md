---
name: ios-qa
version: 0.1.0
description: Live-device QA for a SwiftUI iPhone app, gated on a preflight that proves the machine can actually do it. Checks macOS, Xcode, devicectl, the Swift toolchain and a paired device with real command output before any app source is touched, and refuses outright on a host that cannot build, install or launch the result. Also grades tailnet routes and remote-agent grants, fail-closed, without a device attached. Use when asked to QA an iOS app on a real iPhone, or to check whether this machine could.
triggers:
  - ios qa
  - qa the ios app
  - test my iphone app
  - test the ios app on device
  - find bugs on the device
  - can this machine do ios qa
provides:
  - ios-device-qa
  - device-toolchain-preflight
  - remote-agent-authorization
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
  - AskUserQuestion
---

# ios-qa

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow, the endpoint names, the observe/interact/mutate/
restore capability ladder, the tailnet route allowlist and the allowlist file
format come from `ios-qa` in [gstack](https://github.com/garrytan/gstack) by
Garry Tan (MIT, Copyright (c) 2026 Garry Tan). The on-device Swift bridge is
his and stays his: this fork does not reimplement it. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

## Read this before running anything

**This skill needs a Mac.** macOS, Xcode, `xcrun devicectl`, a Swift 5.9+
toolchain, and a paired iPhone on USB. There is no Windows or Linux path, with
or without a device attached, and this fork does not pretend otherwise.

What this fork adds is that the refusal is **executable and comes first**:

```bash
node ~/.claude/skills/ios-qa/scripts/tb-ios-qa.mjs preflight
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every probe returned real output | Continue |
| 1 | Host is a Mac, something is missing | Fix the FAIL lines, rerun |
| 3 | `HOST_UNSUPPORTED` | **Stop.** Say so and stop. Change nothing |

On exit 3, do not add the SPM dependency, do not edit `Package.swift`, do not
wire anything into the `@main` App, and do not run the codegen. Those are real
edits to a real repository, and a host that cannot build, sign, install or
launch the result cannot test its way back out of them.

## What this fork ports, and what it does not

**Ported and made executable** — the host-side control plane, in one Node file
with no bun, python or shell dependency:

- `preflight` — the host gate above.
- `classify <GET|POST> <path>` — the minimum capability tier for a tailnet
  route, plus the normalized path a daemon should forward.
- `allowlist-check <file> <identity> <capability>` — may this remote identity
  hold that tier right now.
- `selftest` — all of the above against deliberately broken input.

**Not ported** — the on-device half: the DebugBridge SPM package, the Swift and
Objective-C bridge templates, `StateServer.swift`, the swift-syntax accessor
codegen, and the Mac daemon that owns the CoreDevice tunnel. Every one of those
needs a Mac to compile and an iPhone to exercise. Copying them here would mean
shipping code nobody in this repository has ever run, which is the exact
failure this fork exists to remove. When preflight passes, use gstack's
`~/.claude/skills/gstack/ios-qa/` for that half. This is a smaller skill on
purpose.

## The three fixes, and how to see them

Everything below is a pure function over text, so it is checkable on any host:

```bash
node ~/.claude/skills/ios-qa/scripts/tb-ios-qa.mjs selftest
```

65 assertions, exit non-zero on any failure.

### 1. An unparseable expiry meant "never expires"

gstack's `findEntry` skips the expiry comparison when `Date.parse` returns NaN
and returns the entry as live. The check broke, so it allowed:

| `expires_at` | `Date.parse` | gstack | here |
|---|---|---|---|
| `1700000000000` (epoch ms) | NaN | grant is live | `DENY expiry_unparseable` |
| `1700000000` (epoch s) | NaN | grant is live | `DENY expiry_unparseable` |
| `"expired"` | NaN | grant is live | `DENY expiry_unparseable` |
| `"2026-13-45T00:00:00Z"` | NaN | grant is live | `DENY expiry_unparseable` |
| `"2020-01-01T00:00:00Z"` | valid | denied | `DENY grant_expired` |

The epoch-ms row is the one that matters. gstack's own `types.ts` declares
`AllowlistEntry.expires_at: string | null` twelve lines above
`SessionToken.expires_at: number` — two fields, one name, one file, different
units. Writing the number into the wrong one produces a `restore`-tier grant
that never lapses and looks correctly time-boxed in the file.

Only a strict ISO-8601 instant counts as an expiry here. Anything else is a
denial that names the field and the format it wanted.

### 2. The route classifier graded the unnormalized path

gstack matches `path !== '/state/restore'` against
`url.parse(req.url).pathname`, which strips the query string and nothing else.
Every other spelling of the restore endpoint falls through to the `/state/*`
wildcard and is graded one tier lower:

| Route | gstack | here |
|---|---|---|
| `POST /state/restore` | restore | restore |
| `POST /state/restore/` | **mutate** | restore |
| `POST /state//restore` | **mutate** | restore |
| `POST /state/./restore` | **mutate** | restore |

Whether an iPhone at the far end honours those spellings is not something this
repository can answer and it is not claimed. The narrower claim is enough: a
capability ladder whose top rung answers to four spellings and defends one is
wrong at the classifier, and the classifier is meant to be the answer.

Here the path is normalized first — collapse `//`, drop `.` segments — then
matched against a closed table with no wildcard row. Anything the normalizer
will not vouch for is denied rather than repaired: `..` segments, percent
escapes, backslashes, control bytes, queries, fragments, non-absolute paths.
`/state/<key>` keys must be Swift identifiers, which is an allowlist; gstack's
"not snapshot and not restore" is a blocklist exactly two spellings wide.

`classify` prints the normalized path so a daemon forwards **that**, not the
bytes it was handed. Grading one string and sending another is how a
normalizer becomes the bug.

### 3. Nothing stopped the workflow on a machine that cannot run it

gstack's prerequisites are prose. The first thing that touches the host is the
Phase 0 warm-start snippet, which shells out to `python3`. Run verbatim on
Windows 11, 2026-08-13:

```
$ bash phase0.sh
Python was not found; run without arguments to install from the Microsoft Store...
Python was not found; run without arguments to install from the Microsoft Store...
CACHED_UDID=[]
CACHED_PORT=[]
exit-status-of-block=0
```

Exit 0, both variables empty, nothing an agent is obliged to notice — and the
next instruction is to start editing `Package.swift`. `preflight` is the gate
that snippet is not, and it fails closed on a probe that times out, errors, is
killed, or returns output it cannot read. A broken check is never a passed
check, and a skipped check is printed `SKIP`, never `PASS`.

## Also hardened

- A malformed allowlist denies **everyone**, not just the malformed entry. An
  access-control file that is not entirely readable is not a source of truth,
  and answering from the readable half answers a question nobody asked.
  Covered: non-array `capabilities` (a `TypeError` out of gstack's handler),
  unknown tier names, empty capability arrays, duplicate identities, wrong
  `version`, corrupt JSON, a top-level array.
- Allowlist identities must be canonical tailnet identities. gstack compares
  with `!==` against a WhoIs result that is always lowercased, so an entry
  written `Tag:CI` silently never matches and the owner sees a grant that does
  nothing. Here it is a named denial.
- The capability ladder is a `Map`, not an object literal, so inherited
  property names cannot take part in a lookup. gstack survives that by
  accident — comparing a function to a number is false — and an accident is
  not a control.
- Methods are exact: `GET` and `POST` only, uppercase. Anything else is denied
  before the path is even looked at.
- Git Bash on Windows rewrites `/state/restore` into
  `C:/Program Files/Git/state/restore` before node ever sees the argument.
  Denying it is right; calling it "not absolute" is confusing enough that the
  operator retries instead of fixing it, so the reason is named
  `path_mangled_by_msys_path_conversion` and the fix (`MSYS_NO_PATHCONV=1`, a
  doubled leading slash, or PowerShell) is printed with it.

## When preflight passes

The device workflow is gstack's and is unchanged; read
`~/.claude/skills/gstack/ios-qa/SKILL.md` for it. In short: read the Swift
source for `@Observable` classes, generate typed accessors, install the
Debug-only `DebugBridge` SPM package, wire `StateServer.shared.start()` under
`#if DEBUG`, build and install to the device, then run the loop —
screenshot → elements → snapshot → decide → act → re-screenshot → record.

Two rules from gstack worth restating because they are the ones that get
skipped:

- **Demo mode drives everything through visible UI.** No `POST /state/*`
  shortcuts. If a viewer cannot see the tap, it did not happen.
- **Release builds must not link the bridge.** The `.when(configuration:
  .debug)` guard plus a `swift build -c release` check in CI is the
  safety-critical path; `/ios-clean` is a convenience on top of it.

## Why the frontmatter says win32 too

The skill runs everywhere; its verdict does not. `preflight`, `classify`,
`allowlist-check` and `selftest` are Node and run on any host, and the whole
design point is that the refusal is executable **on the host that cannot do the
work**. Declaring `platforms: [darwin]` would score this skill -20 on Windows
and hide the one thing on disk that can answer "do I need a Mac for this" from
the only person who ever asks it. A skill that knows the answer is no should
still be the skill that says so.

## Limits, stated plainly

- The on-device half has never been run from this repository. Preflight has
  never returned 0 here, because no Mac has run it. What has been run, on every
  commit, is the selftest: 65 assertions, all of them off-device.
- `preflight` proves the tools are present and a device is paired. It does not
  prove the app builds or that the tunnel carries traffic. Those need the Mac.
- The route table is a snapshot of gstack's endpoint list. If upstream adds an
  endpoint, this table denies it until it is added here. That is the correct
  direction to be wrong in.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief ios-qa
```

Follow the lines it prints for `ios-qa`. Where they disagree with the defaults
above, the mode wins. One thing no mode loosens: a pass claimed without a
device artifact is a fail, in every stance.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
