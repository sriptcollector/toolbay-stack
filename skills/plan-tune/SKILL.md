---
name: plan-tune
version: 0.1.0
description: Stop being asked the same question. Records which prompts you never want to see again as a policy file, and enforces it in a PreToolUse hook so the suppression happens whether or not the model cooperates. Irreversible questions are always asked, whatever the policy says. Use when the agent keeps asking something you have already answered, or when you want to see and change what it has stopped asking.
triggers:
  - stop asking me that
  - too many questions
  - you already asked me that
  - tune questions
  - never ask me about
  - stop confirming everything
  - what have you stopped asking me
provides:
  - question-suppression
  - question-policy-inspection
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
    - matcher: "(AskUserQuestion|mcp__.*__AskUserQuestion)"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs hook"
          statusMessage: "Checking your question policy"
---

# plan-tune

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the three preference values (`never-ask`,
`always-ask`, `ask-only-for-one-way`), the one-way-door safety override, the
question marker and `(recommended)` conventions, the refuse-on-ambiguous rule,
the split-chain carve-out, the all-or-nothing semantics for a multi-question
call, and the door-type classification of all 53 registered questions come from
`plan-tune`, `scripts/question-registry.ts` and
`hosts/claude/hooks/question-preference-hook.ts` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). Not affiliated with or endorsed by Garry Tan. See NOTICE.

The idea is his. What is new here is that it fails closed and that it can be
measured.

## What this is for

You answered a question. You answered it the same way the last four times. It
gets asked again. This skill records that answer as a policy and enforces the
policy in a hook, so the prompt stops arriving whether or not the model
remembers to check.

It refuses in one direction on purpose: **a question that cannot be undone is
always asked.** A rollback, a merge, a security fix applied to production
config, a fix applied without confirmation. Twelve of those are classified in
`registry.json`, and no preference silences any of them. If you want fewer
prompts, this is the part you do not get to turn off.

## Prove it does something before trusting it

```bash
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs measure
```

That runs twelve real AskUserQuestion payloads through the hook twice, once
with no policy and once with `never-ask` set on all twelve, and prints how many
prompts reached you each time. Eight stop. Four do not, and it names which
check refused for each one. If the number does not drop, the skill is not
working and the command exits non-zero rather than reporting success.

```bash
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs selftest
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs doctor
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs state
```

`selftest` runs the engine against deliberately broken inputs and fails if any
of them silenced a question. `doctor` runs the hook command written in the
installed frontmatter and reports ACTIVE or INERT, and separately checks that a
one-way door still asks. `state` prints where the registry and policy live and
how this project is named.

## Setting a policy

The user says something like "stop asking me about the version bump" or "you
already asked me that".

1. Find the question id. If a recent prompt carried a `<tbs-qid:...>` marker,
   use it. Otherwise show what is registered and let them point at one:

   ```bash
   node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs policy --list
   ```

2. Read the intent as exactly one of three:
   - `--never-ask` — "stop asking", "just decide", "I always say yes to this"
   - `--always-ask` — "ask me every time", "never decide this for me"
   - `--one-way-only` — "only when it matters", "only on the destructive stuff"

3. Write it:

   ```bash
   node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs policy --never-ask ship-version-bump-tier
   ```

   Add `--global` to apply it to every project rather than this one.

4. If the id is not in the registry, the write is **refused** and the error
   says why: this engine does not know whether that question is reversible, and
   it will not guess. Tell the user that, and if they confirm it is reversible,
   run it again with `--door two-way`. Never add `--door two-way` on their
   behalf. That flag is the whole safety boundary.

Undo:

```bash
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs policy --clear ship-version-bump-tier
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs policy --clear-all
```

## What the hook needs from a question to suppress it

The hook is deterministic, so it only acts on things it can see in the payload.
When you emit an AskUserQuestion:

- **Put the id in the question text** as `<tbs-qid:the-question-id>`. Without
  it the question cannot be identified and is always asked. (`<gstack-qid:...>`
  is also accepted, so a marker written for the original still works.)
- **Mark exactly one option `(recommended)`**, as a suffix on the label. Two
  marks, or none, and the hook refuses to choose. A `Recommendation: <label>`
  line in the question text is accepted as a fallback.
- **Do not set `multiSelect` on a question you want auto-decided.** A set
  cannot be represented by one recommended option, so multi-select questions
  are always asked.

When the hook suppresses, the tool call is denied and the denial reason names
the option that was auto-decided. Proceed with that option and do not re-ask.
Say one line: `Auto-decided <question> -> <option> (your policy). Change it
with /plan-tune.`

## Reading the policy back

```bash
node ~/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs policy --list
```

Every row prints its door type, and rows that cannot take effect are labelled
in place: a one-way door says it will be asked anyway, and a value the engine
does not recognise says it is being ignored rather than silently behaving like
`never-ask`.

## Which way it fails

Toward asking you. All of these mean the question reaches you:

- the door-type registry is missing, unreadable, or has an entry with no valid
  door type
- the policy file is missing, empty, or unparseable
- the stored preference is not exactly one of the three known values
- the question has no marker, or the id is not registered and the policy entry
  does not declare a door
- no option is marked `(recommended)`, or more than one is
- the question is `multiSelect`, or is a `-split-` per-option call
- the hook crashes, times out, or is handed something that is not JSON

Silencing a question you wanted is a bug you will never see. Asking one you did
not want is a bug you will complain about in one turn. The engine is built for
the second failure.

## Not in this version

No psychographic profile, no inferred-vs-declared gap, no dream cycle, no
telemetry. Those exist in the original and are the parts that observe rather
than act. This fork is only the enforcement half, because the enforcement half
is the part that was not working.
