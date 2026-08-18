---
name: gstack-upgrade
version: 0.1.0
description: Upgrade Toolbay Stack to the latest published release and prove it landed. Backs up what it is about to overwrite, installs, then compares every installed file against the release by SHA-256, and rolls back if the comparison fails. A failed update check reports CHECK_FAILED and exits non-zero instead of being cached as "up to date". Use when asked to upgrade, update, or check the version of the stack.
triggers:
  - upgrade toolbay stack
  - update toolbay stack
  - upgrade the stack
  - update the stack
  - upgrade gstack
  - get the latest version
  - am i on the latest version
  - check for updates
  - did the upgrade work
  - verify the install
provides:
  - stack-self-upgrade
  - upgrade-verification
  - update-check-integrity
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

# gstack-upgrade

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name and the upgrade contract implemented here — the
`UP_TO_DATE` / `UPGRADE_AVAILABLE` / `JUST_UPGRADED` output vocabulary, the
snooze ladder with escalating backoff, the auto-upgrade setting, the
just-upgraded marker, the 60 and 720 minute cache TTLs, and the "show what's
new after upgrading" step — come from `gstack-upgrade` and
`bin/gstack-update-check` in [gstack](https://github.com/garrytan/gstack) by
Garry Tan (MIT, Copyright (c) 2026 Garry Tan). Not affiliated with or endorsed
by Garry Tan. See NOTICE.

A fork that ships over npx has to own its own upgrade path, and this one is
built around a single rule gstack's is not: **an upgrade is not finished when
the installer exits, it is finished when the bytes on disk match the release.**

```bash
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs check
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs upgrade
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs verify
```

## Checking

```bash
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs check
```

One line, or nothing:

| output | meaning | exit |
| --- | --- | --- |
| *(nothing)* | current, or snoozed | 0 |
| `UPGRADE_AVAILABLE <old> <new>` | a newer release is published | 0 |
| `JUST_UPGRADED <old> <new>` | the last upgrade verified; said once | 0 |
| `CHECK_FAILED <reason>` | **the check could not complete** | 2 |

That last row is the one that does not exist upstream. gstack answers a failed
network probe by writing `UP_TO_DATE <local>` into its cache and exiting 0, so a
version sixty releases behind reports itself current for the next hour because
the probe broke. Reproduced against the installed gstack on this machine:

```
$ GSTACK_DIR=<fake, VERSION 1.0.0.0> GSTACK_STATE_DIR=<tmp> \
  GSTACK_REMOTE_URL=http://127.0.0.1:9/VERSION \
  bash ~/.claude/skills/gstack/bin/gstack-update-check ; echo "exit=$?"
exit=0
$ cat <tmp>/last-update-check
UP_TO_DATE 1.0.0.0
```

Here a probe that did not resolve a version writes **nothing** to the cache and
exits 2. Only a probe that actually got an answer is allowed to leave a verdict
behind, and the cache records `probe: "ok"` to say so — a cache entry without it
is not a verdict and gets re-probed.

## Upgrading

```bash
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs upgrade
```

In order:

1. Resolve the target version. If the update check failed, **stop** — refuse to
   upgrade toward a version nobody established. Nothing on disk is touched.
2. Fetch the release into a temp directory (`npm install --prefix`, no tarball
   tool, so no `tar` and no `mktemp`).
3. Back up every skill about to be overwritten, and SHA-256 each file.
4. Run the release's own installer at each install site, and report its exit
   code rather than discarding it.
5. **Verify.** Compare every installed file against the release by hash.
6. Pass → write the version marker, clear the cache, delete the backup.
   Fail → restore the backup, re-hash the restore to confirm it came back, and
   exit non-zero. If the restore is itself incomplete, the working directory is
   kept and its path printed.

The backup is deleted only at step 6, after the verify passed. gstack deletes it
on the line immediately after the setup that may have failed, which makes the
recovery its own SKILL.md prescribes impossible. Run verbatim:

```
mv "$INSTALL_DIR" "$INSTALL_DIR.bak"
mv "$TMP_DIR/gstack" "$INSTALL_DIR"
cd "$INSTALL_DIR" && ./setup          # fails
rm -rf "$INSTALL_DIR.bak" "$TMP_DIR"  # runs anyway: separate statement
```
```
setup: FAILED
ls: cannot access '.../install.bak': No such file or directory
```

## Verifying

```bash
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs verify
```

Compares each installed skill against the release, file by file, by SHA-256.
Two kinds of difference are expected and exempted, each for a stated reason:
the `command:` line in a `SKILL.md`, which the installer rewrites to an absolute
path on purpose, and the files a user is told to edit (`modes/modes.json`,
`memory/memory.json`, anything `*.shipped`). Everything else must match exactly,
which is what catches the failure mode Windows actually has: a locked file
skipped during a copy, leaving a tree that is present, plausible, and partial.

If no release can be located to compare against, the answer is `UNVERIFIED` and
a non-zero exit. It is never a pass. gstack has no verify step at all — its
final message, `gstack v{new} — upgraded from v{old}!`, is assembled from the
version the agent read *before* the upgrade ran, so a half-finished install and
a clean one print the same sentence.

## Windows

The whole engine is Node, because every POSIX assumption in the upstream flow is
a place this quietly breaks:

- **`find -mmin`** decides cache freshness upstream. Windows `find.exe` is on
  the Git Bash PATH too, has no `-mmin`, writes its complaint to stderr, and
  gstack's `2>/dev/null || true` turns that into an empty result — which it
  reads as "the cache is fresh". Whenever System32 precedes `/usr/bin`, the
  cache never expires again. Staleness here is `Date.now() - at`.
- **`sort -V`** orders versions upstream, with a documented string-compare
  fallback that puts `1.9.0` above `1.10.0`. Compared numerically here.
- **`date +%s`, `mktemp`, `mv`, `rm -rf`, `./setup`** — none are invoked.
- **File locks.** OneDrive, an indexer, or Claude Code itself holding a file
  makes rename and unlink throw `EBUSY`/`EPERM` for a moment. Those are retried
  with backoff and then reported honestly, never assumed to have worked.

## Prove it

```bash
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs selftest
node ~/.claude/skills/gstack-upgrade/scripts/tb-upgrade.mjs status
```

`selftest` runs the real executable as a child process against deliberately
broken inputs: an unreachable registry, a captive-portal HTML page, JSON with no
version, a corrupt cache, a forged cache entry with no recorded probe, a
ten-year-old cache entry, a truncated file, and a release whose installer drops
one file the way a locked file gets dropped on Windows. It asserts the rollback
happened and that the restored bytes hash to what was there before.

It is checked against being vacuous by mutation. Against the 59 assertions:

| reintroduce this gstack behaviour | assertions that go red |
| --- | --- |
| a failed probe caches `UP_TO_DATE` and exits 0 | 18 |
| trust the installer's exit code, no verify step | 7 |
| delete the backup unconditionally | 2 |

With the verify step removed, the run prints `Toolbay Stack v99.0.0 — upgraded
from v0.2.0, and verified against the release on disk` over a file that is not
there. That sentence is the upstream behaviour, and it is what the verify step
exists to stop.

## What to tell the user after upgrading

Read `CHANGELOG.md` from the release and summarise 5-7 user-facing bullets. Do
not describe the upgrade as successful on the strength of the installer's
output — quote the verify line, which is the only part that looked at the disk.
