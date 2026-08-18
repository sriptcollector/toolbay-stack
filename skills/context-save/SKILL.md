---
name: context-save
version: 0.1.0
description: Save the working context of this session to a file a later session can actually resume from, and prove the file landed. The engine reads git state itself, refuses a capture that records nothing, writes atomically, then re-reads the file and checks its body checksum before anything prints SAVED. Use when asked to save progress, save state, checkpoint, or note where things stand before compaction.
triggers:
  - save progress
  - save state
  - save my work
  - context save
  - checkpoint
  - note where i am
  - before we lose context
provides:
  - context-write
  - context-save-verification
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# context-save

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (the `/context-save` command, its save and list
modes, the frontmatter fields `status` / `branch` / `timestamp` /
`files_modified`, the Summary / Decisions Made / Remaining Work / Notes body
sections, the append-only rule, the `YYYYMMDD-HHMMSS-title.md` filename, and the
pairing with `/context-restore`) comes from `context-save` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The verification pass, the fail-closed refusal, the body
checksum, and the Windows path handling are new. Not affiliated with or endorsed
by Garry Tan. See NOTICE.

**HARD GATE: this skill does not change code.** It reads state and writes one
file under the state directory. Nothing in the repository is touched.

---

## The question this skill exists to answer

Not "did I write a summary". **Is there a file on disk, right now, that a
session with none of this context could pick the work up from.**

Those come apart constantly, and the failure is silent. A save that never landed
looks exactly like a save that did: the banner is the same, and nobody finds out
until the session that needed it opens an empty drawer. So here the banner is
printed from the file after it has been read back off disk and its body checksum
recomputed. If that fails, the exit code is non-zero and the words say the save
did NOT land.

---

## Save

**Step 1. Write the payload with the Write tool, not through a shell.**

The payload is the part only you know: what the work is, what was decided, what
is left. Write it to a scratch file as JSON:

```json
{
  "title": "auth refactor",
  "status": "in-progress",
  "summary": "Moving session handling off cookies onto short-lived tokens so the mobile client stops getting logged out.",
  "decisions": [
    "Tokens live 15 minutes, refresh token in an httpOnly cookie",
    "No migration for existing sessions; they expire naturally"
  ],
  "remaining": [
    "Wire the refresh endpoint",
    "Delete the legacy cookie parser",
    "Add an expiry test"
  ],
  "notes": ["Tried a sliding-window cookie first; it broke under Safari ITP"]
}
```

`status` is `in-progress`, `blocked`, or `completed`. Everything else about the
save (branch, HEAD, the modified-file list, timestamps, durations) is measured by
the engine. Do not put it in the payload and do not transcribe it from
scrollback; a file that states a branch nobody read is how a restore resumes the
wrong work.

Use the Write tool for this file. Quoting a JSON object through PowerShell or
Git Bash is how payloads arrive corrupted, and a corrupted payload is refused
rather than half-saved.

**Step 2. Run the save.**

```bash
node ~/.claude/skills/context-save/scripts/tb-context.mjs save --payload <payload.json>
```

**Step 3. Report what the engine printed, and nothing more.**

It prints the file path, byte count, checksum result, branch, and modified-file
count, all read back off disk. Show that to the user. Do not write your own
"saved!" line, and never claim a path the banner did not print.

Exit codes:

| code | meaning | what to do |
| --- | --- | --- |
| 0 | saved and verified | report the banner |
| 3 | refused: the payload captures nothing a restore could act on | fix the payload (see below) and rerun |
| 2 | unusable: the destination cannot be written | report the path and the error; do not retry blindly |
| 4 | the save did NOT land | say so plainly. There is no saved context. |

### What gets refused, and why that is the point

A save is refused when the summary is under 20 characters, when `remaining` is
empty on work that is not marked `completed`, when the status is not one of the
three, or when the payload is not JSON. gstack writes those files anyway, over
the same success banner, and the cost lands on the session that trusts it.

If a refusal is right (there genuinely is nothing to record), say so instead of
padding the payload to get past the check.

---

## List

```bash
node ~/.claude/skills/context-save/scripts/tb-context.mjs list          # this branch
node ~/.claude/skills/context-save/scripts/tb-context.mjs list --all    # every branch
node ~/.claude/skills/context-save/scripts/tb-context.mjs list --json   # for another tool
```

The engine reads the directory and parses the frontmatter itself. There is no
`find`, no `ls -t`, no `sort`, so the list works identically from PowerShell,
Git Bash, and a Mac terminal.

A saved file that does not verify is **listed, marked UNREADABLE, and the
command exits 1**. It is never hidden. Saves made by gstack, under
`~/.gstack/projects/<slug>/checkpoints`, are listed too, marked `gstack`.

---

## Verify and show

```bash
node ~/.claude/skills/context-save/scripts/tb-context.mjs verify all
node ~/.claude/skills/context-save/scripts/tb-context.mjs verify "<file>"
node ~/.claude/skills/context-save/scripts/tb-context.mjs show latest
node ~/.claude/skills/context-save/scripts/tb-context.mjs where
```

`verify` recomputes the sha256 of each file's body and compares it with the one
saved in its frontmatter, so a file that was truncated by a full disk, mangled by
a sync client, or edited after the fact fails instead of reading clean. `where`
prints every path the tool would use, absolute and native to this platform, which
is the answer to "where did that actually go".

---

## Session duration

`session_duration_s` is only a number when something measured it:

```bash
node ~/.claude/skills/context-save/scripts/tb-context.mjs session begin   # at session start
```

Without a marker the field is written as `unknown` with the reason beside it.
gstack computes duration with `ps -o lstart= -p $PPID | date -jf`, which is BSD
syntax; on Windows and Linux both halves error out, so the field is silently
absent and a reader cannot tell an unmeasured session from an instant one.

---

## Rules

- **Never modify code.** This skill reads state and writes one file.
- **Never claim a save the engine did not print.** Exit 4 means there is no
  saved context, whatever the conversation felt like.
- **Saved files are append-only.** A name collision gets `-2`, `-3`; nothing is
  ever overwritten.
- **Infer, do not interrogate.** Build the payload from the conversation and the
  repository. Ask only if the title genuinely cannot be inferred.
- **The branch belongs to git.** It is read by the engine or recorded as
  unavailable. It is never guessed.

---

## Proving the engine still works

```bash
node ~/.claude/skills/context-save/scripts/tb-context.mjs selftest
```

57 assertions, run against this executable as a child process: empty payloads,
non-JSON payloads, a state directory that is really a file, a title containing
`../../../../etc/passwd; rm -rf /`, a title with no ASCII characters at all, a
body carrying its own forged frontmatter block, a file edited after saving, a
truncated file, an MSYS `/c/Users/...` destination, and a corrupt `.git`. Every
one of them must end in a refusal or a failed verification. Exit 1 if any does
not.
