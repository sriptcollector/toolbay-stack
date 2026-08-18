---
name: freeze
version: 0.2.0
description: Restrict file edits to one directory for the session. Blocks any Edit, Write, MultiEdit, or NotebookEdit whose target is outside the boundary. Fails closed, so a broken or unreadable boundary blocks instead of silently allowing. Use when debugging to stop the agent fixing unrelated code, or to scope a change to one module.
triggers:
  - freeze edits
  - freeze this directory
  - restrict edits
  - only edit this folder
  - lock editing scope
  - lock down edits
provides:
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
    - matcher: "Edit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "Write"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "MultiEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
    - matcher: "NotebookEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking freeze boundary"
---

# freeze

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the boundary semantics, the trailing-separator
rule, and the deny-on-outside contract come from `freeze` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation is a rewrite. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

Locks file edits to one directory. Any Edit, Write, MultiEdit, or NotebookEdit
outside it is blocked outright, not warned about.

## Setting the boundary

Ask the user which directory to restrict edits to (AskUserQuestion, free text,
not a menu), then:

```bash
node ~/.claude/skills/freeze/scripts/tb-guard.mjs freeze --set "<path>"
```

The path is resolved to an absolute real path and checked to be an existing
directory before it is written. A boundary that does not exist is refused at
this point rather than becoming a mystery block later.

Tell the user the resolved path and that `/unfreeze` lifts it.

To see the current state at any time:

```bash
node ~/.claude/skills/freeze/scripts/tb-guard.mjs state
```

## Clearing it

```bash
node ~/.claude/skills/freeze/scripts/tb-guard.mjs freeze --off
```

`/unfreeze` runs exactly this.

## Prove it is actually running

```bash
node ~/.claude/skills/freeze/scripts/tb-guard.mjs selftest
node ~/.claude/skills/freeze/scripts/tb-guard.mjs doctor
```

`selftest` runs the guard as a real child process against real and deliberately
broken payloads. `doctor` runs the hook command written in the installed
frontmatter and prints ACTIVE or INERT.

## What blocks and what does not

| Situation | Result |
|---|---|
| Path inside the boundary | Allowed |
| Write to a file that does not exist yet, inside the boundary | Allowed |
| Path outside the boundary | Blocked |
| Sibling directory whose name starts with the boundary (`/src` vs `/src-old`) | Blocked |
| `..` traversal that lands outside | Blocked |
| No boundary ever set | Allowed |
| Boundary file exists but is empty, corrupt, or unreadable | Blocked |
| Boundary points at a directory that no longer exists | Blocked |
| Payload has no file path in it | Blocked |
| Hook fires for a tool it was not designed to check | Blocked |

The one deliberate allow is "no boundary ever set". Everything else that cannot
be verified is a block. gstack treats an unreadable payload and an empty state
file as allow-everything, which is the same class of bug as a guard that is not
installed.

## Why this is a rewrite and not a fork

Two separate defects, both reproduced on Windows 11 against gstack 1.60.1.0.

**It blocks the edits it is supposed to allow.** `check-freeze.sh` decides
whether a path is absolute with `case "$FILE_PATH" in /*)`. A Windows path does
not start with `/`, so it is treated as relative and the current directory is
glued to the front:

```
$ printf '{"tool_name":"Edit","tool_input":{"file_path":"C:\\Users\\orion\\proj\\src\\a.txt"}}' \
    | CLAUDE_PLUGIN_DATA=... bash ~/.claude/skills/gstack/freeze/bin/check-freeze.sh
{"permissionDecision":"deny","message":"[freeze] Blocked: /c/Users/orion/OneDrive/Desktop/code/orionsassistantmanager/C:\Users\orion\proj\src/a.txt is outside the freeze boundary (C:\Users\orion\proj/src)..."}
```

That file is inside the boundary. A user whose every edit is blocked runs
`/unfreeze` and ends up with no protection at all, which is how a
fails-annoying bug becomes a fails-open one.

**And it has the same python3 fallback.** When field extraction comes back
empty it allows:

```
$ printf '{"tool_name":"Edit","tool_input":{}}' | bash .../check-freeze.sh
{}
```

This version resolves drive letters, UNC paths, MSYS `/c/...` paths, symlinks,
junctions, and `..` segments, compares case-insensitively on Windows only, and
treats an unextractable path as a block.

## Notes

- The boundary is stored in `~/.toolbay-stack/freeze.json`. Override the
  location with `TOOLBAY_STACK_STATE_DIR`. A bare path on one line is also
  accepted, so a gstack `freeze-dir.txt` can be moved across.
- This prevents accidental edits. It is not a security boundary: a Bash command
  such as `sed -i` can still write outside it. Run `/careful` alongside, or
  `/guard` for both.

## Related

- `/unfreeze` clears the boundary. `/careful` warns on destructive commands.
  `/guard` turns on both.
