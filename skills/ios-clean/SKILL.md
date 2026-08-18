---
name: ios-clean
version: 0.1.0
description: Strip the gstack DebugBridge SPM package and its #if DEBUG wiring out of an iOS app, and prove none of it survived. The verification is static and runs on Windows and Linux as well as macOS, so the removal can be checked on the machine the removal was done on rather than only on a Mac with a Swift toolchain. Use when asked to remove DebugBridge, clean the iOS debug bridge, strip debug instrumentation before a security audit, or migrate an app off gstack.
triggers:
  - clean the ios debug bridge
  - remove debugbridge
  - strip the gstack ios instrumentation
  - remove the debug instrumentation
  - is there debug code left in the release build
  - did i break the #if debug block
provides:
  - debug-instrumentation-removal
  - conditional-compilation-integrity
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# ios-clean

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (the `/ios-clean` command, the five removal targets —
the DebugBridge SPM dependency, the `#if DEBUG` wiring in the app's `@main`
entry, the `@Snapshotable` codegen markers, generated `StateAccessor.swift`
files, and the `gstack-ios-qa.token` file on the device — the Inventory /
Remove / Verify phase split, the confirm-before-each-removal rule, and the
"every edit is a git operation, `git restore` undoes it" reversibility promise)
comes from `ios-clean` in [gstack](https://github.com/garrytan/gstack) by Garry
Tan (MIT, Copyright (c) 2026 Garry Tan). The verifier is new. Not affiliated
with or endorsed by Garry Tan. See NOTICE.

You are removing code whose whole purpose was to open a socket into a running
build of somebody's app. Getting it 90% out is not a partial success, and the
usual way to find out is a security audit.

---

## The question this skill exists to answer

Not "did I delete the DebugBridge files". **Is there anything left that puts the
bridge back into a Release build, and did taking it out break the file it came
out of.**

Those are two different failures and they hide in each other's blind spot. A
surviving `.product(name: "DebugBridgeUI", package: "DebugBridge")` in
`Package.swift` is invisible to a source grep for wiring. A `#if DEBUG` whose
`#endif` left with the block it was wrapping contains no DebugBridge text at all,
so a source grep says the app is clean while the file no longer compiles.

---

## Do it

```bash
node ~/.claude/skills/ios-clean/scripts/tb-ios-clean.mjs inventory --app ./Sources
```

Every artifact with a file and a line number, plus the thing gstack never
records: **which files were already unbalanced before you started**. That
baseline is what lets `verify` say "this file was broken when you got here"
instead of blaming the strip for it.

Then remove what the user approved, with Edit, one item at a time. Then:

```bash
node ~/.claude/skills/ios-clean/scripts/tb-ios-clean.mjs verify --app ./Sources
```

On a Mac, finish it:

```bash
node ~/.claude/skills/ios-clean/scripts/tb-ios-clean.mjs build-proof \
  --app ./Sources --package-dir . --binary .build/release/MyApp
```

`build-proof` records the command, its exit code and its captured output. It
never records a pass it did not earn: with no `swift` on PATH it writes
`unavailable` and exits non-zero, and `verify` treats a ledger entry with no
command or no output as a claim rather than evidence.

---

## What verify checks, and what happens when it cannot

| check | runs on | fails when |
|---|---|---|
| scope is real iOS source | everywhere | the path is missing, is a file, or holds no `.swift`/`.m`/`.mm` |
| residue in code | everywhere | wiring, imports, markers, resolvers, the token path survive |
| generated accessors | everywhere | a file carries the codegen header, whatever it is named |
| conditional compilation balance | everywhere | an `#if` lost its `#endif`, or an `#endif` lost its `#if` |
| Package.swift dependency | everywhere | DebugBridge is still declared, or linked with no debug-only condition |
| Package.swift references | everywhere | a `.product()` names a package whose `.package()` line is gone |
| release binary symbols | macOS only | `nm -j` finds a DebugBridge symbol |

Four exit codes, because three outcomes is one too few:

```
0  CLEAN          every static check passed and the binary was inspected
1  RESIDUE        something survived, or the strip broke a file
2  UNVERIFIABLE   the check could not run; nothing at all is claimed
3  SOURCE-CLEAN   static checks passed, the binary proof did not run here
```

3 is non-zero on purpose. `verify && ship` does not go green on half a
verification. Turning it into a pass takes typing `--accept-source-only`, which
is an acknowledgement, not a default.

---

## Why this is not gstack's Phase 3

gstack's entire verification is four shell lines (`ios-clean/SKILL.md:864-867`):

```
1. ! grep -r "DebugBridge" <app-source-dir>   (no matches).
2. ! grep -r "@Snapshotable" <app-source-dir> (no matches).
3. swift build -c release succeeds.
4. nm -j on the built binary doesn't show DebugBridge symbols.
```

**Checks 1 and 2 fail open.** `grep -r` exits 2 when its path does not exist, and
the leading `!` inverts that into success. Measured on Windows 11, Git Bash
2.51.2, 2026-08-13:

```
$ if ! grep -r "DebugBridge" /c/Users/orion/no/such/dir; then \
    echo "GSTACK PHASE3 CHECK1 => PASS (no matches)"; fi
grep: /c/Users/orion/no/such/dir: No such file or directory
GSTACK PHASE3 CHECK1 => PASS (no matches)
```

A typo, a relative path resolved from the wrong directory, or source one level
deeper than assumed all print what a clean app prints: nothing.

**The same two checks also fail closed, permanently.** `grep -r "DebugBridge"`
matches the comment a careful developer leaves behind. An app that is genuinely
clean can never satisfy gstack's own exit condition, so the check gets ignored,
which is worse than not having one. Here a match in code blocks and a match in a
comment is a note that does not.

**Checks 3 and 4 cannot run on Windows and the skill has no state for that.**
There is no third outcome between pass and fail, so "the two checks that mattered
could not execute" has nowhere to go, and the run reports on the strength of
checks 1 and 2 — the two that fail open.

**Nothing checks the edit Phase 2 actually botches.** Phase 2 says "strip the
import + the `#if DEBUG` block (keep the surrounding code intact)". When that goes
wrong it leaves a dangling `#if` or a stray `#endif`, and zero occurrences of
"DebugBridge", so checks 1 and 2 pass and only the compiler would catch it —
the check that cannot run on Windows.

**And the "safety-critical path" is not in the templates.** Both gstack skills
say this one is only a convenience wrapper because the real guard is structural:
"The app target depends on `DebugBridgeUI` with `.when(configuration: .debug)`"
(`ios-qa/SKILL.md.tmpl:117`, restated at `ios-clean/SKILL.md:806`). Grep the
templates that install it:

```
$ grep -n "when(configuration" ios-qa/templates/*.template
Package.swift.template:14:// The structural Release-build guard is the `.when(configuration: .debug)`
Package.swift.template:38:  .define("DEBUG", .when(configuration: .debug)),
Package.swift.template:58:  .define("DEBUG", .when(configuration: .debug)),
```

Line 14 is the comment claiming the guard. Lines 38 and 58 are the only two uses
and both are `swiftSettings` on DebugBridge's own targets, which is a
preprocessor define, not a dependency edge. No template attaches a configuration
condition to a consuming app target's dependency. So source residue here is
load-bearing, not cosmetic, and a surviving DebugBridge dependency carrying no
debug-only condition is the highest-severity finding this skill has.

### Side by side, same tree

An app where the strip removed the wiring body but took the `#endif` with it, and
deleted the `.package()` line while leaving the `.product()` reference:

```
########## gstack Phase 3, run exactly as written ##########
  check 1 => FAIL   (it matched the comment "// gstack DebugBridge wiring removed")
  check 2 => PASS
  check 3 => cannot run: swift: command not found
  check 4 => cannot run: nm not on PATH

########## tb-ios-clean verify, same tree ##########
  FAIL  source residue (code)                       1 reference(s)
  FAIL  conditional compilation balanced            1 file(s) unbalanced
  FAIL  Package.swift dependency removed            0 declared, 1 unguarded
  FAIL  Package.swift references resolve            1 orphan product reference(s)
  FAIL  release binary carries no DebugBridge       no build-proof record

  Sources\App.swift:6  #if opened at line 6 is never closed; its #endif went with the removed block
  Package.swift:8      .product(name: "DebugBridgeUI", package: "DebugBridge")  links in Release
  Package.swift:8      .product(name: "DebugBridgeUI", package: "DebugBridge")  the .package() line is gone
  RESIDUE  4 finding(s). The strip is not complete.  (exit 1)
```

gstack flagged one thing, and it was the comment. Everything that would actually
ship the bridge, or stop the app compiling, it did not look for.

## Windows

No shell, no grep, no find, no `swift`. Node reads the files itself, so the same
command gives the same verdict from Git Bash, PowerShell and cmd, on a path with
spaces, against CRLF files with a UTF-8 BOM. The directive parser handles nested
block comments, `"""multiline"""` strings and `#"raw"#` strings, so an `#endif`
inside a string is not counted and an `#endif` inside a comment does not rescue an
unbalanced file.

## Prove the checks work

```bash
node ~/.claude/skills/ios-clean/scripts/tb-ios-clean.mjs selftest
node ~/.claude/skills/ios-clean/scripts/tb-ios-clean.mjs doctor
```

46 assertions, each one a way a removal reports success without having removed
anything. It builds broken app trees on disk and drives the real CLI against them
as child processes. The count is asserted too, so a run cannot print the banner
on the strength of assertions it never made.

## What this never touches

App business logic, view models, view code, anything outside `#if DEBUG`, other
QA infrastructure. Every edit is a git operation, so `git restore` undoes the lot.
No force-push, no amend, no deleting the SPM cache. Those stay the user's call.

## Mode

This skill runs inside a stance. Read it before you start, because it changes what
this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief ios-clean
```

Follow the lines it prints for `ios-clean`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above.
