---
name: careful
version: 0.2.0
description: Safety guardrails for destructive commands. Warns before rm -rf, Remove-Item -Recurse, DROP TABLE, TRUNCATE, force-push, git reset --hard, git clean, kubectl delete, docker prune, and writes to a block device (dd, mkfs, wipefs). Fails closed, so a broken guard blocks instead of silently allowing. Use when touching prod, debugging a live system, or working in a shared repo.
triggers:
  - be careful
  - careful mode
  - safety mode
  - prod mode
  - warn before destructive
provides:
  - destructive-command-guard
  - safety-hook-verification
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/careful/scripts/tb-guard.mjs careful"
          statusMessage: "Checking for destructive commands"
---

# careful

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the destructive-pattern list, the safe-exception
list, and the warn-and-override contract come from `careful` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation is a rewrite. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

Safety mode is active for this session. Every Bash command is inspected before
it runs. A destructive command stops and asks; you can always override and
proceed.

## What is protected

| Pattern | Example | Risk |
|---|---|---|
| `rm -r` / `rm -rf` / `rm --recursive` | `rm -rf /var/data` | Recursive delete |
| `Remove-Item -Recurse` (PowerShell) | `Remove-Item -Recurse -Force C:\data` | Recursive delete |
| `rd /s` / `rmdir /s` / `del /s` (cmd) | `rd /s /q C:\data` | Recursive delete |
| `DROP TABLE` / `DROP DATABASE` / `DROP SCHEMA` | `DROP TABLE users;` | Data loss |
| `TRUNCATE` | `TRUNCATE orders;` | Data loss |
| `git push --force` / `-f` | `git push -f origin main` | History rewrite |
| `git reset --hard` | `git reset --hard HEAD~3` | Uncommitted work lost |
| `git checkout .` / `git restore .` | `git checkout .` | Uncommitted work lost |
| `git clean -fd` | `git clean -fdx` | Untracked files lost |
| `kubectl delete` | `kubectl delete pod api-0` | Production impact |
| `docker rm -f` / `docker system prune` | `docker system prune -a` | Containers and images lost |
| `dd of=/dev/…` / `mkfs` / `wipefs` | `dd if=/dev/zero of=/dev/sda` | Filesystem destroyed |

`--force-with-lease` is not treated as a force push, because the lease is the
safe form and warning on it trains people to click through warnings.
`of=/dev/null`, `/dev/zero`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`,
`/dev/random` and `/dev/urandom` are excluded from the block-device rule: those
are everyday idioms and a guard that warns about them is a guard people switch
off.

### What is NOT protected, and is not pretended to be

The list above is a list of patterns, and a pattern list is not a model of
danger. `tools/backtest.mjs` runs commands through this guard and through
gstack's; both stacks currently return an unqualified allow for
`terraform destroy`, `aws s3 rm s3://bucket --recursive`, `chmod -R 777 /`, and
`find . -delete`. The block-device rule above was added because the backtest
found it missing; the rest are still missing and this paragraph exists so that
is on the record rather than discovered in production.

## Safe exceptions

A recursive delete of a build directory runs without a warning:
`node_modules`, `.next`, `dist`, `build`, `out`, `target`, `coverage`,
`__pycache__`, `.cache`, `.turbo`, `.parcel-cache`, `.pytest_cache`.

Two limits on that exception, both deliberate:

- It only applies to a relative path. `rm -rf dist` is safe, `rm -rf /dist` is not.
- Every delete on the line has to be safe. `rm -rf node_modules && rm -rf /var/data`
  still warns, because the safe half is exactly how the unsafe half gets through.

## Prove it is actually running

This is the part that matters, so run it rather than trusting the header:

```bash
node ~/.claude/skills/careful/scripts/tb-guard.mjs selftest
```

That spawns the guard as a real child process with real hook payloads,
including deliberately broken ones, and fails if any of them are allowed.

```bash
node ~/.claude/skills/careful/scripts/tb-guard.mjs doctor
```

`doctor` reads the hook command out of the installed SKILL.md frontmatter, runs
that exact string, and prints ACTIVE or INERT. Use it when the hook command
depends on an environment variable your shell may not expand.

## Why this is a rewrite and not a fork

gstack's version extracts the command from the hook payload with
`grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"'` and falls back to
`python3 -c 'json.loads(...)'`. Both halves fail on Windows, and they fail open.
Reproduced on Windows 11 against gstack 1.60.1.0:

```
$ printf '{"tool_input":{"command":"echo \"starting\" && rm -rf /var/data"}}' \
    | bash ~/.claude/skills/gstack/careful/bin/check-careful.sh
{}
```

`{}` means allow. The character class stops at the first escaped quote, so the
guard only ever sees `echo \` and never sees the recursive delete. The python3
fallback does not save it, because on Windows `python3` is normally the
Microsoft Store alias stub: it prints an advert to stderr, exits 49, and writes
nothing. `|| true` swallows that and the script reaches its "could not extract a
command, allow" branch.

This version parses the payload with `JSON.parse`, so that bypass cannot exist,
and every path that cannot reach a confident "safe" ends in a block.

## Fail-closed behaviour

If the guard cannot decide, it stops the command and says which check failed.
`careful` blocks by asking, because ask-and-override is its whole contract. For
an unattended agent with nobody to answer, set `TOOLBAY_GUARD_STRICT=1` and
internal failures become hard denies instead.

## Turning it off

Hooks are session-scoped. End the conversation or start a new one.

## Related

- `/freeze` restricts which files can be edited. `/guard` turns on both.
- This guard does not inspect what a command does at runtime. `rm -rf` inside a
  shell script it invokes is not visible to it. It is a seatbelt, not a sandbox.
