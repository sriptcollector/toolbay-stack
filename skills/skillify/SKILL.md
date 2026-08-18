---
name: skillify
version: 0.1.0
description: Turn a scrape that worked once into a permanent skill that still works next month. Writes the parser, the test and the page snapshot to disk, then refuses to install any of it until the test has been proven to actually test something: it must pass against the real page and FAIL against a gutted copy of it. Nothing lands that has not passed, and the pass is keyed to the exact bytes being installed. Use after a scrape, extraction or one-off script that you want to keep.
triggers:
  - skillify
  - codify this scrape
  - save this scrape
  - make this permanent
  - turn this into a skill
  - make this reusable
  - i do not want to figure this out again
provides:
  - skill-codification
  - generated-test-quality-gate
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# skillify

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command, the workflow, and the promise all come from
`skillify` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan): codify the last successful scrape into a
permanent browser-skill, stage it to a temp directory, test it there, and rename
it into the tier path only on a pass plus explicit approval, otherwise remove it
entirely. The two-tier global/project layout, the pure-parser plus
fixture-replay test shape, the `source: agent` / `trusted: false` frontmatter,
and the post-commit verify step are his design. What is new here is that the
iron contract is enforced by the tool instead of described to the model, and
that the test is itself tested. Not affiliated with or endorsed by Garry Tan.
See NOTICE.

A skill on disk is a promise that something works. This one is not allowed to
make that promise on the strength of a test that would pass on an empty page.

---

## The one thing to know

`check` runs the generated test **three times**: once against the real page
snapshot, where it must pass, and once against each of two mutants of that
snapshot, an empty file and the same page with every tag stripped, where it must
**fail**.

A test that still passes when the page has no HTML in it is not testing the
parse. It is rejected, by name, before anything is installed.

gstack states this rule in prose ("the test must include at least one **
assertion ... Smoke tests that only check `parseFromHtml` doesn't throw are
insufficient") and nothing checks it. That is the difference this skill exists
for.

---

## The flow

```bash
SK=~/.claude/skills/skillify/scripts/tb-skillify.mjs
```

**1. Start from something that passes.**

```bash
node $SK scaffold --out ./.toolbay/skillify/lobsters-frontpage
```

A complete four-file skill that clears every gate. Replace the parser, the
fixture and the frontmatter. Keep the shape.

**2. Capture the page.**

```bash
node $SK capture --url https://lobste.rs/ --out ./.toolbay/skillify/lobsters-frontpage
```

Fetches through the browse skill, resolved here, so there is no `$B` to be
empty. It prints the absolute path it wrote and the `fixture:` block to paste
into `SKILL.md`. If the browser cannot be reached it writes **nothing** and
exits non-zero, because an empty fixture is worse than no fixture: a weak test
passes against it.

**3. Write the parser and the test.**

`script.mjs` exports `parseFromHtml(html)`, a pure function, HTML in, rows out.
`script.test.mjs` uses `node:test` and asserts on the rows, not on the absence
of an exception. Node, not Bun. Imports may be `node:` builtins and files inside
the skill, nothing else, so the skill still runs on a machine that has never
seen this repository.

**4. Stage it.** Nothing is installed by this step.

```bash
node $SK stage --name lobsters-frontpage --from ./.toolbay/skillify/lobsters-frontpage
```

**5. Check it.** This is the gate.

```bash
node $SK check --dir "<the path stage printed>"
```

**6. Ask the user, then commit.** Show them what passed. Then:

```bash
node $SK commit --dir "<the same path>"     # or: discard --dir "<...>"
```

**7. Prove it, with a number you measured.**

```bash
node $SK verify --dir "<the path commit printed>" --expect ./prototype-output.json
```

`verify` replays the bundled fixture, times it, and compares the output against
the JSON the original scrape produced. Report the milliseconds it prints. Do not
report gstack's "~200ms"; that figure is an estimate about a different machine.

---

## The eight gates

| Gate | Passes only when |
|---|---|
| files | `SKILL.md`, `script.mjs`, `script.test.mjs` and a fixture all exist |
| frontmatter | name matches, description, host, 3+ triggers, `source: agent`, `trusted: false`, a fixture block with a sha256 |
| fixture integrity | the file on disk hashes to the sha256 that was recorded |
| self-containment | nothing is imported but `node:` builtins and files inside the skill |
| rows | the parser returns 1+ objects and some field is non-empty on every one |
| determinism | two runs over the same fixture produce identical output |
| test passes | `node --test script.test.mjs` exits 0 against the real fixture |
| **test fails on a gutted page** | the same test FAILS on an empty page and on the page with its tags stripped |

Exit 0 means all eight passed. Exit 1 means one did not. Exit 2 means a gate
could not be evaluated, which is also not a pass. A gate that cannot run is
never skipped; it is reported as failing, so a run cannot quietly assert less
than the last one.

---

## What commit refuses

`check` writes a marker holding a SHA-256 of the staged tree. `commit` recomputes
that hash and refuses if it is missing or different. In practice:

- a directory that never passed check
- a directory that passed and was then edited, including by you
- a name already installed, including one that differs only in case, which is
  the same directory on Windows
- a name Windows cannot hold: `con`, `aux`, `nul`, `com1`, `prn`
- a source tree that arrived carrying its own verification marker

`discard` removes the staged directory and then checks that it is gone. If it is
not, it says so and exits non-zero, rather than reporting a cleanup that did not
happen.

---

## Prove the gates work

```bash
node ~/.claude/skills/skillify/scripts/tb-skillify.mjs selftest
```

39 assertions. Every one of them is a skill that is broken in a specific way,
run through the real CLI as a child process: a smoke test, a parser that returns
nothing, a parser whose rows are all empty, a non-deterministic parser, a script
that imports an npm package, a script that imports out of its own directory, an
edited fixture, a zero-byte fixture, a syntax error, a hanging test, a commit
with no check, a commit of files edited after the check, two kinds of name
collision, a fixture past its age limit, and output that drifted from the
prototype. The selftest fails if any of them is allowed through, and it fails if
it made fewer than 39 assertions.

```bash
node ~/.claude/skills/skillify/scripts/tb-skillify.mjs doctor
```

---

## Why this fork exists

Four things measured on Windows 11 against gstack 1.60.1.0, 2026-08-13. The full
transcripts are in the header of `scripts/tb-skillify.mjs`.

**1. It cannot write a file on this machine.** Step 7 calls `stageSkill()`, which
calls `mkdirSecure()`, which runs
`icacls <dir> /inheritance:r /grant:r <user>:(F)`. icacls exits 0, so the
best-effort warning never fires, and the ACE left behind names a trustee nobody
holds. Running that exact call sequence three times:

```
run 1: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
run 2: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
run 3: EPERM writing SKILL.md      ACL: orion\:(OI)(CI)(F)
```

The same `mkdir` without the icacls call writes fine. Nothing here restricts
ACLs: a staged skill is a directory of source files the user is about to read,
not a credential, and hardening that bricks the feature is not hardening.

**2. The test result is not an input to the commit.** Step 8 runs the test, step
10 calls `commitSkill()`, and nothing connects them. Staging a skill whose test
fails and committing it, which is what happens the moment a model misreads step
8:

```
bun test in the staged dir -> exit 1   (1 fail)
commitSkill  -> ...\browser-skills\broken-scraper
on disk      -> script.test.ts, script.ts, SKILL.md
```

**3. The test-quality rule is unenforceable prose.** See "The one thing to know".

**4. The name validator accepts names Windows cannot hold.**

```
validateSkillName("con")   -> ACCEPTED
validateSkillName("aux")   -> ACCEPTED
validateSkillName("nul")   -> ACCEPTED
validateSkillName("com1")  -> ACCEPTED
validateSkillName("prn")   -> ACCEPTED
```

gstack's own SKILL.md also tells the model the length limit is 32 while the code
enforces 64.

And the fixture path in step 4, `$B html > /tmp/skillify-fixture-$$.html`
followed by "Read the file you wrote": `$B` is never assigned in that skill,
`/tmp` is two different directories on Windows, and `$$` is a shell PID that no
later tool call can expand. Every path this tool prints is an absolute native
path.

None of this is a criticism of the idea, which is the best one in gstack. It is
what happens when the contract lives in the prose instead of in the code.

---

## Limits, honestly

- **The fixture is a snapshot.** A passing test proves the parser still reads
  that snapshot, not that the site has not changed. `verify` prints the
  fixture's age and `--max-age-days` turns it into a failure, but only a fresh
  `capture` tells you the truth.
- **The live path is not tested by the gates.** The gates test the pure parser
  against the fixture. Fetching still depends on the browse skill and the
  network, and can break without any gate noticing.
- **The marker is a guard, not a signature.** It stops a skill from being
  committed unchecked or edited-then-committed. A caller that deliberately
  forges the marker file can defeat it; that is forgery, not an oversight, which
  is the whole change from gstack, where skipping the gate is simply forgetting
  a step.
- **One page per skill.** Multi-page crawls are out of scope. Write one skill
  per target.

## After it lands

A codified skill is a reusable artifact with a test that proves it works, which
is exactly what the marketplace tier wants. If the user wants it listed:

```bash
node ~/.claude/skills/toolbay/scripts/tb.mjs --help
```

Say what it does and what the verify run measured. Do not describe it as
battle-tested on the strength of one fixture.

## Mode

This skill runs inside a stance. Read it before you start:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief skillify
```

Follow the lines it prints for `skillify`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: the eight gates,
and the rule that an artifact is not installed until it has passed them.
