---
name: unfreeze
version: 0.2.0
description: Clear the freeze boundary set by /freeze so edits are allowed everywhere again. Use when you want to widen the edit scope without ending the session.
triggers:
  - unfreeze
  - unlock edits
  - remove freeze
  - allow all edits
  - remove edit restrictions
provides:
  - edit-boundary-release
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# unfreeze

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name and behaviour come from `unfreeze` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). Not affiliated with or endorsed by Garry Tan. See NOTICE.

Clears the boundary set by `/freeze`. This skill carries no engine of its own on
purpose: it calls the one `/freeze` or `/guard` already installed, so there is
no second copy of the boundary logic to drift.

```bash
TB_GUARD="$(ls ~/.claude/skills/freeze/scripts/tb-guard.mjs \
               ~/.claude/skills/guard/scripts/tb-guard.mjs \
               ~/.claude/skills/careful/scripts/tb-guard.mjs \
               .claude/skills/freeze/scripts/tb-guard.mjs 2>/dev/null | head -1)"
node "$TB_GUARD" freeze --off
```

It prints the boundary that was lifted, or says that none was set. Report that
result to the user verbatim.

If no engine is found, say so plainly rather than reporting success: nothing was
cleared, and if a boundary is live it is still live. Install with
`node bin/toolbay-stack.mjs install freeze --global`, from a Toolbay Stack clone.

## After clearing

The hooks stay registered for the session. With no boundary file they allow
every path, which is the intended state. Run `/freeze` again to set a new one.
