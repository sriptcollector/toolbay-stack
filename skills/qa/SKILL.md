---
name: qa
version: 0.3.0
description: QA test a running web application like a real user, then fix what breaks and re-verify. Every pass has to be backed by an artifact that exists, so an empty run or a failed screenshot fails instead of scoring green. Use when asked to QA something, test the site, find bugs, check a deploy, or answer does this work.
triggers:
  - qa this
  - qa test
  - test the site
  - test the app
  - find bugs
  - does this work
provides:
  - qa-testing
platforms:
  - win32
  - darwin
  - linux
cost: high
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# qa

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (three tiers, the clean-tree precondition, the
test → triage → fix → re-verify loop, one atomic commit per fix, the
verified / best-effort / reverted classification, the WTF-likelihood
self-regulation heuristic, the 50-fix cap, and the report layout) comes from
`qa` in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT,
Copyright (c) 2026 Garry Tan). The evidence ledger is new. Not affiliated with
or endorsed by Garry Tan. See NOTICE.

You are a QA engineer and a bug-fix engineer. Click everything, fill every form,
check every state. Fix what you find, in source, one commit per fix, then prove
the fix.

---

## Setup

| Parameter | Default |
|---|---|
| Target URL | required, or auto-detected from the dev server |
| Tier | Standard |
| Output dir | `./.toolbay/qa/` |
| Scope | whole app, or the diff if you are on a feature branch |

Tiers decide what gets fixed: **Quick** fixes critical and high, **Standard**
adds medium, **Exhaustive** adds cosmetic.

**Clean working tree first.** `git status --porcelain`. If it is dirty, stop and
offer: commit / stash / abort. Each fix needs its own commit.

**Open the run:**

```bash
node ~/.claude/skills/qa/scripts/tb-qa.mjs init --target http://localhost:3000
```

This prints absolute paths for the ledger and the screenshots directory. Use
those exact paths for every artifact.

Do not pass `--dir /tmp/...` on Windows; it will be refused, with both of the
directories that string would mean printed out. gstack's setup table offers
`Output to /tmp/qa` (`qa/SKILL.md.tmpl:52`). Measured on Windows 11:

```
$ cd /tmp && pwd -W
C:/Users/orion/AppData/Local/Temp
$ node -e "console.log(require('path').resolve('/tmp/qa'))"
C:\tmp\qa
```

The browser writes the screenshot into one of those and the report links to the
other, so every piece of evidence in the report 404s and nobody notices, because
nothing checks.

---

## Phases 1-6: Explore and find

Walk the app the way a user would.

- Load every page in scope. Record the HTTP status.
- Click every interactive element. Submit every form, empty and full and
  oversized and with the wrong type.
- Check the console for errors and the network tab for failed requests.
- Check the responsive layout at a mobile width as well as desktop.
- Check the states that are easy to skip: empty, loading, error, unauthorized,
  and the second visit with a warm cache.

Record every finding as you go:

```bash
node ~/.claude/skills/qa/scripts/tb-qa.mjs record \
  --id ISSUE-001 --check "checkout submits with an empty cart" \
  --status fail --url http://localhost:3000/checkout \
  --evidence .toolbay/qa/screenshots/issue-001.png
```

Severity: **critical** (data loss, security, total breakage), **high** (a core
flow is unusable), **medium** (a flow is degraded or confusing), **low**
(cosmetic).

---

## Phase 7: Triage

Sort by severity, fix what the tier covers, mark the rest deferred. Anything
that cannot be fixed from this codebase — a third-party widget, an
infrastructure problem — is deferred regardless of tier.

---

## Phase 8: Fix loop

For each fixable issue, in severity order:

1. **Locate.** Grep for the error text, the component name, the route. Only
   touch files that are actually responsible.
2. **Fix.** The minimal change. Do not refactor around it.
3. **Commit.** `git commit -m "fix(qa): ISSUE-NNN — short description"`. One
   commit per fix, never bundled.
4. **Re-test.** Go back to the page, exercise the same path, capture a fresh
   screenshot, check the console.
5. **Record the re-test:**

```bash
node ~/.claude/skills/qa/scripts/tb-qa.mjs record --force \
  --id ISSUE-001 --check "checkout submits with an empty cart" \
  --status pass --evidence .toolbay/qa/screenshots/issue-001-after.png
```

`--force` is required to overwrite a recorded failure, so a run cannot turn
green by accident.

6. **Regression test.** Match the project's existing test style exactly. The
   test must set up the precondition that triggered the bug, perform the action,
   and assert the correct behavior — not "it renders". Run only the new file. If
   it passes, commit it. If it fails twice, delete it and defer the issue.

**Self-regulation.** Every 5 fixes, or after any revert, score the run:

```
start at 0%
each revert                 +15%
each fix touching >3 files   +5%
after fix 15                 +1% per additional fix
all remaining are low        +10%
touching unrelated files    +20%
```

Over 20%: stop, show what you have done, ask whether to continue. Hard cap 50
fixes.

---

## Phase 9: Verdict

```bash
node ~/.claude/skills/qa/scripts/tb-qa.mjs verdict
```

Exit 0 is the only PASS, and it is computed, not asserted. A recorded `pass` is
downgraded to `unverified` unless it is backed by:

- an artifact file that exists and is **not zero bytes**, or
- a real HTTP status code from a real URL (and a 5xx cannot back a pass)

One unverified check fails the run. So does an empty ledger, a missing ledger,
and a corrupt one.

### Why the verdict is computed

gstack's Phase 8d takes the screenshot and Phase 8e classifies the fix
(`qa/SKILL.md.tmpl:210-221`):

```bash
$B screenshot "$REPORT_DIR/screenshots/issue-NNN-after.png"
...
- **verified**: re-test confirms the fix works, no new errors introduced
```

Nothing ever opens that PNG. If the browse daemon was not running, the command
fails or leaves a zero-byte file, and the issue is still `verified` and still
counted in the "health score X → Y" line that goes into the PR body. There is
also no step anywhere in gstack's /qa that distinguishes "every check passed"
from "no checks ran".

---

## Phase 10: Report

Write to `.toolbay/qa/qa-report-{host}-{YYYY-MM-DD}.md`:

- one section per issue: severity, repro steps, fix status, commit SHA, files
  changed, before/after artifacts
- summary: found, fixed (verified / best-effort / reverted), deferred
- the verdict output verbatim, including the score

One line for a PR description: `QA found N issues, fixed M, verdict PASS|FAIL
(X/Y verified).` Use the verdict command's numbers. Do not restate them from
memory.

If the repo has `TODOS.md`, add the deferred bugs to it with repro steps, and
annotate any it fixed.

---

## Prove the checks work

```bash
node ~/.claude/skills/qa/scripts/tb-qa.mjs selftest
```

Covers every way a QA run goes green without testing anything: nothing recorded,
a zero-byte screenshot, an artifact path that does not exist, a 500 recorded as
a pass, and a recorded failure quietly overwritten.

## Important rules

- Clean tree before starting. One commit per fix.
- Never modify existing tests. Only add new ones.
- Revert on regression, immediately, and mark the issue deferred.
- Never report a pass the ledger does not support. If the verdict says FAIL, the
  run failed, whatever the narrative says.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief qa
```

Follow the lines it prints for `qa`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
