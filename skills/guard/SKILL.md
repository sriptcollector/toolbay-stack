---
name: guard
version: 0.2.0
description: Full safety mode. Turns on both the destructive-command warning from /careful and the edit boundary from /freeze in one step, using the same fail-closed engine. Use when working against production, on a shared repo, or on anything you cannot easily undo.
triggers:
  - guard mode
  - full safety mode
  - lock everything down
  - protect this repo
provides:
  - destructive-command-guard
  - edit-boundary-guard
  - safety-hook-verification
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs careful"
          statusMessage: "Checking for destructive commands"
    - matcher: "Edit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "Write"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "MultiEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "NotebookEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
---

# guard

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name and the "both guards at once" contract come from
`guard` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). Not affiliated with or endorsed by Garry Tan.
See NOTICE.

Both guards, one step. This skill is not a third implementation: it registers
the same hooks and runs the same engine as `/careful` and `/freeze`, and the
selftest asserts all three copies of that engine are byte-identical.

## Turning it on

1. Ask which directory edits should be restricted to.
2. Set it:

```bash
node ~/.claude/skills/guard/scripts/tb-guard.mjs freeze --set "<path>"
```

Destructive Bash commands start warning immediately, with no configuration.

## Prove it is actually running

```bash
node ~/.claude/skills/guard/scripts/tb-guard.mjs selftest
node ~/.claude/skills/guard/scripts/tb-guard.mjs doctor
```

## What each half does

- Destructive commands: see `/careful`.
- Edit boundary: see `/freeze`.

Both fail closed. If either guard cannot decide, the operation is blocked and
the message names the check that failed.

## Turning it off

```bash
node ~/.claude/skills/guard/scripts/tb-guard.mjs freeze --off
```

Command warnings are hook-registered and session-scoped, so they end with the
conversation.
