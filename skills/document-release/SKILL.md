---
name: document-release
version: 0.1.0
description: Update the docs to match what actually shipped, then prove it. Snapshots every doc file before the run, extracts the public surface out of the release diff, greps the docs for each entity, and ends at a gate that refuses any report claiming a file was updated when its bytes never changed. Use after /ship, before the PR merges, or when asked to sync docs, update the README, or write the release notes.
triggers:
  - update the docs
  - sync documentation
  - post-ship docs
  - document what changed
  - update the readme
  - release notes
provides:
  - documentation
  - post-ship-documentation
  - doc-claim-verification
  - changelog-preservation
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
---

# document-release

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (run after `/ship` and before the PR merges, discover
every doc file, cross-reference it against the release diff, build a Diataxis
coverage map, auto-apply the factual corrections and ask about the rest, polish
CHANGELOG voice without ever clobbering entries, check cross-doc consistency and
discoverability, clean up TODOS, ask before bumping VERSION, then commit and post
a documentation section to the PR body) comes from `document-release` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The baseline, the claims gate, the CHANGELOG preservation check,
the surface extractor and the PR-body refusal are new. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

Runs after `/ship`: the code is committed and the PR exists or is about to.
Mostly automated. Make the obvious factual corrections directly; stop only for
the judgement calls.

**Stop only for:** narrative or philosophy changes, security-model wording,
removing a section, a rewrite over ~10 lines in one place, a VERSION bump, new
TODOS items, and narrative contradictions between docs.

**Never stop for:** factual corrections that fall out of the diff, adding a row
to a table, updating a path, a count or a version number, fixing a stale
cross-reference, minor CHANGELOG wording, or marking a TODO complete.

**Never do:** regenerate a CHANGELOG entry, `Write` over CHANGELOG.md, or bump
VERSION without asking. Step 7 enforces the first two and fails the run if they
happened.

---

## Step 1: Take the before-picture

Do this **first**, before reading or editing anything. Nothing later can be
checked without it.

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs baseline
```

Hashes every documentation file in the repo and records the branch, HEAD, the
base branch and the merge base. Exit 2 means this is not a git work tree.

If you skip this, Step 7 fails closed and the run cannot report success. That is
deliberate.

---

## Step 2: What shipped

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs scan
node ~/.claude/skills/document-release/scripts/tb-docs.mjs surface
git diff <merge-base>...HEAD --stat
git log <base>..HEAD --oneline
```

`scan` walks the tree with node:fs and includes the extension-less docs
(`VERSION`, `CHANGELOG`, `TODOS`, `NOTICE`) that a `*.md` glob misses, which
matters because two of the steps below are about exactly those files.

`surface` reads the release diff and lists what a user could newly type: exported
symbols, CLI flags, env vars, new skills. It is the input to the coverage map,
and it is read off the diff rather than recalled.

### Why not `find`

gstack discovers docs with `find . -maxdepth 2 -name "*.md" -not -path "./.git/*"`.
In PowerShell `find` is `C:\Windows\System32\find.exe`. Measured on Windows 11,
2026-08-14:

```
PS> find . -maxdepth 2 -name "*.md"
FIND: Parameter format not correct
exit=2
```

An agent that reads that as "no documentation files here" audits nothing and
reports everything current.

Classify the changes: new features, changed behaviour, removed functionality,
infrastructure. Say how many files changed across how many commits, and how many
doc files are in scope.

---

## Step 3: Coverage map

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs coverage
```

Prints `MENTIONED <file>:<line>` or `UNDOCUMENTED` for every entity from Step 2.
That is the factual half. The Diataxis half is yours: for each entity decide
which of reference / how-to / tutorial / explanation the mention actually
satisfies.

- **Reference** — what it is, its options (README tables, API docs)
- **How-to** — "how to do X with this" (README examples, CONTRIBUTING)
- **Tutorial** — step-by-step for a newcomer
- **Explanation** — why it works this way (ARCHITECTURE, design rationale)

`UNDOCUMENTED` entities are **critical gaps**. Mentioned-but-reference-only are
**common gaps**. Both go in the PR body at Step 8. Do NOT auto-generate missing
documentation pages here; flag them, and suggest `/document-generate`.

**Diagram drift.** If any doc has ASCII or Mermaid diagrams, pull the entity
names out of them and check the diff for renames, splits, moves and removals.
Flag them in the PR body. Do not auto-edit diagrams; they need human judgement.

---

## Step 4: Audit each doc, then edit

Read each file in full before touching it. Cross-reference against the diff.

- **README.md** — does it describe everything in the diff? Are install steps,
  examples and troubleshooting still true?
- **ARCHITECTURE.md** — do the diagrams and component descriptions match the
  code? Be conservative: only what the diff clearly contradicts.
- **CONTRIBUTING.md** — walk it as a brand new contributor. Would every listed
  command actually succeed? Flag anything that would fail or confuse.
- **CLAUDE.md / project instructions** — does the structure section match the
  real tree? Are the commands and build/test instructions accurate?
- **Anything else** — work out its purpose and audience, then check the diff
  against what it claims.

Apply the factual corrections with `Edit`. Ask about the rest (Step 4's stop
list at the top of this file). Never auto-update the README introduction or
positioning, ARCHITECTURE philosophy, or the security model, and never remove a
section.

For each edit, note **what specifically changed** — "added `/document-release`
to the skills table, skill count 9 to 10", not "updated README.md". Step 7
rejects a summary that is only the filename, so this is not optional.

---

## Step 5: CHANGELOG voice

**Only wording, only inside the newest entry.** Use `Edit` with exact
`old_string` matches. Never `Write` this file. Never delete, reorder or
regenerate an entry.

If the CHANGELOG was not touched on this branch, skip.

Sell test, 0-3 per entry: 1 point for what changed, 1 for why the reader cares,
1 for how to use it. Under 2 needs a rewrite; ask before rewriting, because a
rewrite alters meaning. Lead with what someone can now do. "You can now..." not
"Refactored the...". Contributor-only changes belong under
`### For contributors`.

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs changelog-check
```

Every heading present at baseline must still be there, in the same order, and
every line under every entry **older** than the newest must survive verbatim.
Polish on the newest entry passes. Exit 1 means an entry was rewritten.

gstack records the reason this check exists, in its own words: "A real incident
occurred where an agent replaced existing CHANGELOG entries when it should have
preserved them." The countermeasure it ships for that is five bullet points
addressed to the same agent. This one is arithmetic.

---

## Step 6: Cross-doc consistency, TODOS, VERSION

**Consistency.** README's capability list against CLAUDE.md's. ARCHITECTURE's
components against CONTRIBUTING's structure. CHANGELOG's latest version against
`VERSION` (`changelog-check` does this one). **Discoverability:** every doc file
should be reachable from README.md or CLAUDE.md; flag any that is not. Auto-fix
clear factual mismatches, ask about narrative ones.

**TODOS.md**, if it exists. Mark items the diff clearly completes, with
`**Completed:** vX.Y.Z.W (YYYY-MM-DD)` — only with clear evidence. Ask before
updating a TODO whose subject changed. Check the diff for new `TODO`, `FIXME`,
`HACK`, `XXX` comments and ask whether each real one should be captured.

**VERSION.** Never bump without asking. If the file does not exist, skip. If it
was not bumped on this branch, ask (recommend skipping: docs-only changes rarely
warrant one). If it **was** already bumped, do not skip silently — read the
CHANGELOG entry for that version and the full diff, and if something substantial
shipped that the entry does not mention, ask whether it deserves its own version
rather than being absorbed.

---

## Step 7: The gate

Write what you did to a claims file, then submit it.

```json
{
  "files": [
    { "path": "README.md", "status": "updated", "summary": "added /document-release to the skills table and moved the count from 9 to 10" },
    { "path": "CHANGELOG.md", "status": "voice-polished", "summary": "led the 1.4.0 entry with what a reader can now do instead of the refactor" },
    { "path": "ARCHITECTURE.md", "status": "current" },
    { "path": "TODOS.md", "status": "skipped" }
  ],
  "coverage": [
    { "entity": "--emit-csv", "documented_in": "README.md" }
  ]
}
```

`updated` and `voice-polished` mean the bytes changed. `current` means they did
not. `skipped` means the file is not there.

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs verify --claims doc-claims.json
```

**IRON LAW: no documentation claim without a byte difference behind it.**

The gate fails when a file is reported updated and is byte-identical to the
baseline, when a doc was edited and left out of the report, when something
reported as `current` was edited, when a summary says nothing beyond the
filename, when a coverage claim names a file that does not contain the string,
when a CHANGELOG entry was rewritten — and when there is **no baseline at all**,
because a run with nothing to compare against cannot be reported as clean.

Fix the docs or fix the report, then run it again. Do not commit while it fails.

### Why this exists

gstack ends its run with a "Documentation health" table of Updated / Current /
Voice polished statuses, each with "a description of what changed". Nothing
computes any of it. The model that decided to edit README.md is the model that
reports README.md as edited, out of the same context window, with no read-back
in between. A run where the edit was planned and never applied prints the same
table as a run where it landed.

---

## Step 8: Commit, PR body, output

Run `git status` (never `-uall`). If no doc file changed, say "All documentation
is up to date" and stop without committing.

Stage the doc files **by name**. Never `git add -A`. One commit:

```bash
git commit -m "docs: update project documentation for vX.Y.Z.W"
```

Then push, and put the Documentation section on the PR:

```bash
gh pr view --json body -q .body > pr-body-current.md || echo "NO PR"
node ~/.claude/skills/document-release/scripts/tb-docs.mjs pr-section \
  --body pr-body-current.md --content doc-section.md --title Documentation
gh pr edit --body-file "<the path it printed>"
```

`pr-section` replaces an existing `## Documentation` section or appends one, and
running it twice is byte-identical. It **refuses** a body file that is missing or
empty, because that is what a failed read leaves behind. Pass
`--allow-empty-body` only if the PR body really is blank.

The section carries: one line per modified file naming what specifically
changed, then `### Documentation Debt` with the critical gaps (new surface, zero
coverage), the common gaps (reference only, no how-to), and any drifted
diagrams. If there is any debt, suggest a `docs-debt` label.

### Why not a redirect straight into `gh pr edit`

gstack does exactly that, via `/tmp/gstack-pr-body-$$.md`. Three problems, all
measured on Windows 11, 2026-08-14:

```
$ (exit 7) > prbody.md; echo "cmd exit=$?"; wc -c < prbody.md
cmd exit=7
0
```

A redirect creates its target whether or not the command succeeded, so a failed
or unauthenticated `gh pr view` hands the next step an empty file to write over
a PR body somebody typed by hand.

```
PS> Write-Output "pid: [$$]"
pid: []
```

`$$` is a shell PID. PowerShell expands it to nothing, so every concurrent
session collides on one filename.

```
$ echo hi > /tmp/tbs-probe.txt
$ node -e "console.log(require('fs').existsSync('/tmp/tbs-probe.txt'))"
false
$ node -e "console.log(require('path').resolve('/tmp'))"
C:\tmp
```

Git Bash wrote it under `AppData\Local\Temp`; Node looked in `C:\tmp`. Nothing
here uses `/tmp`.

**Final output.** The doc health table, same shape as gstack's, except every row
is now backed by the `verify` run above rather than by recollection. Then the
coverage map with file:line for each mentioned entity, and the diagram drift
list. If nothing is missing: "Coverage: every shipped entity is mentioned in the
docs" — which is a claim about strings in files, not about quality.

---

## Prove the checks work

```bash
node ~/.claude/skills/document-release/scripts/tb-docs.mjs selftest
```

Builds throwaway git repositories that are each wrong in one specific way: a doc
claimed updated that nobody edited, a doc edited and left out of the report, a
file claimed current that changed, a summary that only restates the filename, a
claim about a file outside the repo, a coverage claim for a string that is not in
the file, a missing baseline, a corrupt baseline, a baseline from another branch,
a CRLF-only rewrite passed off as a doc change, a CHANGELOG line deleted from an
older entry, entries reordered, a VERSION with no CHANGELOG entry, and a PR body
assembled from a failed read. Exit 1 if any of them is allowed through.

## Important rules

- Read a file in full before editing it.
- Never clobber the CHANGELOG. Polish wording only, in the newest entry.
- Never bump VERSION silently.
- Every edit gets a one-line summary naming what specifically changed.
- The coverage map informs; it never generates. Gaps go to
  `/document-generate`.
- Diagram drift is advisory. Flag it, do not auto-edit it.
- Voice: friendly and user-forward. Write for a smart person who has not seen
  the code.
- The heuristics here are generic. They work on any repo, not just this one.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief document-release
```

Follow the lines it prints. Where they disagree with the defaults above, the
mode wins. Two things the mode never gets to loosen: a claim still needs
evidence you actually produced, and an irreversible action still needs its exact
target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above.
