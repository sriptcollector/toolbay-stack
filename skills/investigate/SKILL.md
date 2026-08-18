---
name: investigate
version: 0.3.0
description: Systematic debugging with root cause investigation. Four phases, and one Iron Law - no fix without a confirmed root cause. Locks edits to the affected directory while you work, and refuses to call a fix DONE unless the report cites the evidence. Use when something is broken, throwing, 500ing, failing, crashing, or was working yesterday.
triggers:
  - debug this
  - fix this bug
  - why is this broken
  - root cause
  - investigate this error
provides:
  - debugging
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - WebSearch
hooks:
  PreToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/investigate/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking debug scope boundary"
    - matcher: "Write"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/investigate/scripts/tb-guard.mjs freeze"
          statusMessage: "Checking debug scope boundary"
---

# investigate

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow, the Iron Law, the four phases, the pattern table, the
3-strike rule, the blast-radius question, and the DEBUG REPORT block come from
`investigate` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). The scope-lock and report-gate implementations are
new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Fixing symptoms is whack-a-mole. Every fix that does not address the root cause
makes the next bug harder to find.

---

## Phase 1: Investigate

1. **Collect symptoms.** Read the error, the stack trace, the reproduction steps.
   If there is not enough to go on, ask ONE question at a time.
2. **Read the code.** Trace from the symptom back toward causes. Grep for
   references, Read to understand.
3. **Check recent changes.** `git log --oneline -20 -- <affected-files>`. Was it
   working before? A regression means the root cause is in the diff.
4. **Reproduce.** Can you trigger it deterministically? If not, gather more
   evidence before going further.

Output: **"Root cause hypothesis: ..."** — a specific, testable claim.

---

## Scope lock

Once you have a hypothesis, restrict edits to the directory it implicates, so
the debug session cannot quietly turn into a refactor.

```bash
node ~/.claude/skills/investigate/scripts/tb-investigate.mjs scope <affected files...>
node ~/.claude/skills/investigate/scripts/tb-investigate.mjs scope --apply <affected files...>
```

`scope` computes the narrowest single directory containing every affected file.
`--apply` sets it as the boundary and then **probes the guard with an edit
outside it**, printing the guard's actual decision. It reports LOCKED only when
that probe came back `deny`.

### Include the test directory in the scope. Every time.

Phase 4 requires a regression test and Phase 5 refuses `DONE` without one. Tests
live in `test/`, `spec/`, `__tests__/`. The affected source files live in `src/`.
If you scope to the source files alone, the boundary is `src/`, and **the guard
will correctly deny the one edit this skill requires you to make.** That is not
the guard misfiring, it is the scope being wrong: writing the regression test is
part of the fix, so the test file is an affected path.

So pass the test path along with the source paths, before you have written it:

```bash
node ~/.claude/skills/investigate/scripts/tb-investigate.mjs scope --apply \
  src/services/order_builder.ts test/services/order_builder.test.ts
```

`scope` accepts a path that does not exist yet — it scopes to the containing
directory — so name the test file you are about to write. The boundary becomes
the narrowest directory holding both, which is usually the repo's top level. If
that widens the lock to something meaningless (`scope` refuses a volume root
outright), say the bug is repo-wide and work unscoped rather than locking to
`src/` and then fighting the guard.

The dry run prints the exact `--apply` command for the paths you gave it. Paste
that.

It refuses, with exit 3, rather than announce a lock that would not hold:

- the paths span two volumes, so no directory contains them
- the narrowest common directory is a volume root, which restricts nothing
- the guard engine is not installed, so nothing would be enforcing the boundary

On a refusal, say the bug is repo-wide and work unscoped. Do not claim edits are
restricted. Lift the boundary at the end with `/unfreeze`.

### Why this exists

gstack registers this hook for the same step
(`investigate/SKILL.md.tmpl:33`):

```
bash -c 'S="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh";
         [ -x "$S" ] || S="${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh";
         [ -x "$S" ] && bash "$S" || exit 0'
```

`|| exit 0` is an allow. If the script is missing, or is not marked executable —
which is the normal state of a `.sh` file checked out on Windows — every edit is
permitted while the skill tells the user "Edits restricted to `<dir>/` for this
debug session." Reproduced on Windows 11 against gstack 1.60.1.0:

```
$ printf '{"tool_name":"Edit","tool_input":{"file_path":"C:/Users/orion/other/x.txt"}}' \
    | bash -c 'S="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"; [ -x "$S" ] || S="${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh"; [ -x "$S" ] && bash "$S" || exit 0'
exit=0
```

No output, exit 0. Claude Code reads that as allow.

Separately, gstack writes the boundary as the literal string
`echo "<detected-directory>/" > "$STATE_DIR/freeze-dir.txt"`, and its
`check-freeze` decides absoluteness with `case "$FILE_PATH" in /*)`. A
`C:\proj\src` boundary is therefore read as relative and has the current
directory glued to the front, so on Windows the lock either allows everything or
denies everything. This version resolves the boundary to a real absolute
directory, checks it exists, and hands it to a guard that fails closed.

---

## Phase 2: Pattern analysis

| Pattern | Signature | Where to look |
|---|---|---|
| Race condition | Intermittent, timing-dependent | Concurrent access to shared state |
| Null propagation | TypeError, NoMethodError | Missing guards on optional values |
| State corruption | Inconsistent or partial data | Transactions, callbacks, hooks |
| Integration failure | Timeout, unexpected response | External calls, service boundaries |
| Configuration drift | Works locally, fails in prod | Env vars, feature flags, DB state |
| Stale cache | Old data, fixed by a cache clear | Redis, CDN, browser, build cache |
| Path assumption | Works on macOS, fails on Windows | `/tmp`, `$PPID`, `$$`, `date +%s`, `[ -x ]`, symlinks, `/`-rooted checks |

The last row is not in gstack's table and is the single most common cause of a
"works on my machine" bug in an agent stack. Check it before anything exotic.

Also check `TODOS.md` for known issues, and `git log` for prior fixes in the same
files. **Recurring bugs in the same area are an architectural smell.**

---

## Phase 3: Hypothesis testing

1. **Confirm before fixing.** Add a temporary log, assertion, or debug print at
   the suspected cause. Run the reproduction. Does the evidence match?
2. **If the hypothesis is wrong,** go back to Phase 1 and gather more. Do not
   guess. If you search the web for the error, sanitize it first: strip
   hostnames, IPs, absolute paths, SQL, and customer data.
3. **3-strike rule.** If three hypotheses fail, STOP and ask:
   - A) Keep investigating — new hypothesis: [describe]
   - B) Escalate — this needs someone who knows the system
   - C) Instrument and wait — add logging, catch it next time

**Red flags:** "quick fix for now" (there is no for now), proposing a fix before
tracing the data flow (that is guessing), each fix revealing a new problem
(wrong layer, not wrong code).

---

## Phase 4: Implementation

1. Fix the root cause, not the symptom.
2. Minimal diff. Fewest files, fewest lines. Do not refactor adjacent code.
3. Write a regression test that **fails without the fix** and **passes with it**.
4. Run the full suite and paste the output.
5. If the fix touches more than 5 files, stop and ask about the blast radius:
   proceed / split / rethink.

---

## Phase 5: Verify and report

Reproduce the original scenario and confirm it is fixed. Then write the report:

```
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what the user observed]
Root cause:      [what was actually wrong]
Fix:             [what changed, with file:line]
Evidence:        [test output, reproduction showing the fix works]
Regression test: [file:line of the new test]
Related:         [TODOS items, prior bugs here, architectural notes]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
════════════════════════════════════════
```

Then gate it:

```bash
node ~/.claude/skills/investigate/scripts/tb-investigate.mjs report --file debug-report.md
```

Exit 1 means the report claims more than it proved. It rejects, among others:

- `Status: DONE` with `Evidence: none`, blank, `N/A`, or `TBD`
- a `Fix:` line that cites no `file:line`
- **any `file:line` that is not real** — the file must exist and must have at
  least that many lines. This is checked against the disk, for every status,
  including `BLOCKED`
- `Status: DONE` with no regression test named
- a root cause or evidence line that hedges — "probably", "should work",
  "seems to", "I'm confident"
- a report file that cannot be read (that is unverified, not skipped)

Citations are resolved against the current directory. Pass `--root <dir>` if you
are reporting on a tree you are not standing in. The check is the same code
`/spec`'s `lint --check-paths` runs, shared rather than copied, so the two cannot
drift into disagreeing about what counts as evidence.

Why it is here: this gate used to check only that a citation was *shaped* like a
citation. A report citing `src/quantum/warp-core.mjs:4021` — a path that never
existed — with `Evidence: ran the full suite, everything was green` was
ACCEPTED, exit 0. A regex cannot tell a reference from an invention.

`BLOCKED` is accepted without evidence, because it claims nothing. That is the
honest exit, and it is always available.

gstack asks for the same block and lets the agent write its own `Status` line
underneath `Evidence: (none)`. Its own Important Rules say "Never say 'this
should fix it.' Verify and prove it" — this turns that rule into something that
can fail.

---

## Prove the checks work

```bash
node ~/.claude/skills/investigate/scripts/tb-investigate.mjs selftest
```

Runs every check above against deliberately broken input and exits non-zero if
any of it is accepted.

## Important rules

- 3+ failed attempts means the architecture is wrong, not the hypothesis.
- Never apply a fix you cannot verify.
- Never say "this should fix it." Run it.
- DONE means root cause found, fix applied, regression test written, suite green.
  DONE_WITH_CONCERNS means fixed but not fully verifiable, and you say why.
  BLOCKED means escalated. Those are the only three.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief investigate
```

Follow the lines it prints for `investigate`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
