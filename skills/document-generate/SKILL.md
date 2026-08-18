---
name: document-generate
version: 0.1.0
description: Write the documentation that does not exist yet, partitioned by which reader needs it, and prove every name in it is real. Extracts the public surface out of the source with a file and a line for each item, then resolves every path, symbol, flag, link and line citation in the finished document against that index and refuses a document that cites nothing at all. Use when asked to write docs, generate documentation, document a feature or module, create a tutorial, or explain how someone else would use this.
triggers:
  - write docs for this
  - generate documentation
  - document this feature
  - create a tutorial
  - write a how-to
  - explain this module
  - docs for this project
  - nobody else can run this
  - how would someone else use this
provides:
  - documentation
  - documentation-authoring
  - citation-verification
  - api-surface-extraction
  - doc-discoverability
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

# document-generate

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (research the whole codebase before writing a line,
partition the work across the four Diataxis quadrants, write reference first
because it establishes the vocabulary, then explanation, then how-to, then
tutorial, cross-link the quadrants, make every document reachable from the
README, self-review against accuracy, completeness and voice gates, then commit)
and the four document templates come from `document-generate` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The surface extractor, the citation gate, the reachability
computation and the fail-closed credential scan are new. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

Diataxis is four kinds of document, each for a reader in a different mode:

- **Tutorial** — learning. Walks a newcomer to a first working result.
- **How-to** — a task. Assumes the basics, gets one specific thing done.
- **Reference** — the facts. Complete, accurate, boring on purpose.
- **Explanation** — the why. Design rationale and trade-offs.

**Research the whole, then write the parts.** Read the full surface before
writing any of it. That is what stops documentation that describes half a
feature.

**The rule that makes this different:** every name you write gets resolved
against the source before you are done. Not re-read, not re-checked by you.
Resolved, by `cite`, which does not share your context window.

---

## Step 1: Map the project

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs map
```

Lists every file with `node:fs`, names the project type, and points at the entry
points to read first.

### Why not `find`

gstack Step 1.1 runs:

```
find . -type f -not -path "./.git/*" -not -path "./node_modules/*" ... | head -200
```

In PowerShell `find` is `C:\Windows\System32\find.exe`, and `head` does not
exist. Measured on Windows 11, 2026-08-14, in this repository:

```
PS> find . -type f -not -path "./.git/*" -not -path "./node_modules/*"
FIND: Parameter format not correct
exit=2
```

This is the step gstack itself calls "the most important step... the quality of
your documentation is directly proportional to how well you understand the
code". On Windows it returns one line of error text and the run continues,
documenting a project it never listed.

---

## Step 2: Read the entry points

Read them yourself. `map` tells you which exist; it cannot tell you what they
mean.

- README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md / AGENTS.md
- the manifest (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`)
- the main entry files
- the tests, which are where intended behaviour and edge cases are written down
- inline `NOTE:` / `DESIGN:` / `WHY:` comments, which are where the trade-offs are

---

## Step 3: Extract the public surface

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs surface
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs surface --path src/widgets
```

Every export, function, class, type, CLI flag, env var and package script the
code really declares, each with the file and line it was read from. Exit 2 if it
finds nothing, because a reference document written against an empty surface is
written from memory.

This is the input to Step 5. A reference document is an answer to "what could
somebody type", and this is the only trustworthy version of that list.

---

## Step 4: Partition

Decide which quadrants each entity needs. Not everything needs four.

| Entity type | Tutorial? | How-to? | Reference? | Explanation? |
|---|---|---|---|---|
| New feature a user interacts with | yes | yes | yes | maybe |
| CLI command or flag | maybe | yes | yes | no |
| Internal module / architecture | no | no | yes | yes |
| Config option | no | yes | yes | no |
| Design pattern / philosophy | no | no | no | yes |
| API endpoint | maybe | yes | yes | no |
| Workflow (multi-step process) | yes | yes | no | maybe |

Print the plan. If it is more than 5 documents, confirm the scope before
writing. Below that, keep going.

---

## Step 5: Reference first

Reference establishes the vocabulary every other quadrant borrows.

```markdown
# [Entity Name]

[One paragraph: what it is, what it does, when you would use it.]

## API / Interface

[Every public item, with types, defaults and constraints. Pull from the
`surface` output, not from memory. Cite the file and line.]

## Options / Configuration

[Every option: type, default, effect.]

## Examples

[2-3 examples that would actually run if pasted.]

## Related

[Links to the how-to and the explanation for the same thing.]
```

Rules: accuracy over elegance; every claim traceable to code. "Accepts a string"
is not reference-grade, "accepts a string (max 256 chars, must match
`^[a-z-]+$`)" is. Do not explain *why* here.

**Cite the source.** Write `src/example.js:42`, not "in the widget module". Step 9
resolves those, so a wrong one is caught rather than believed.

---

## Step 6: Explanation

```markdown
# [Concept / Design Decision]

[The problem this design solves, in terms a smart reader who has not seen the
code would understand.]

## The problem

[What goes wrong without this. Real failure modes, not abstract risks.]

## The approach

[How it solves that. ASCII or Mermaid diagrams for architecture: greppable,
diffable, render everywhere.]

## Trade-offs

[What was given up. Every design decision trades something. Name it.]

## Alternatives considered

[From code comments, ADRs or git history: what was tried or rejected, and why.]
```

Lead with the problem. "We chose X over Y because Z" is the gold standard. Do
not repeat reference material, link to it.

---

## Step 7: How-to, then tutorial

**How-to** is task-oriented and assumes the basics:

```markdown
# How to [specific task]

[One sentence: what you will accomplish.]

## Prerequisites
[Versions, installed tools, config state. Be specific.]

## Steps
1. [Action verb] [specific instruction]
   ```bash
   [exact command]
   ```
   [Expected output, if non-obvious.]

## Verification
[The command, URL or test that proves it worked.]

## Troubleshooting
[Failure modes and fixes, pulled from the error handling code and the tests.]
```

Title starts with "How to". Every step actionable: "Run X", never "consider
whether". Verification is not optional; the reader should never wonder whether it
worked.

**Tutorial** is learning-oriented and the hardest to write:

```markdown
# [What you will build]

[What you will build, why it is useful, what you will understand at the end.
Concrete: "You will build a working X that does Y".]

## What you will need
## Step 1: [Set up]
## Step 2: [First working piece]
...
## What you built
```

Time to first result under 3 steps. If the reader has not seen something work by
step 3, restructure. Every step produces a visible change. Exact commands, no
"run the appropriate command". End by connecting back to the real use case.

---

## Step 8: Cross-link and place

Every reference links to its how-to. Every how-to links to its reference.
Tutorials link to both. Then add the new documents to README, to the docs index,
and to any sidebar config.

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs discoverability docs/tutorial-widgets.md docs/reference-widgets.md
```

Breadth-first over the real link graph, from README.md by default. Prints the
actual click depth of each document. Unreachable is a failure, and a missing
entry point is a failure rather than "everything looks reachable".

gstack states this rule in Step 7.3 and asks the agent to confirm it about the
files it just wrote. This computes it.

---

## Step 9: The gate

**This is the step that makes the documentation worth shipping.**

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs cite --strict docs/reference-widgets.md docs/tutorial-widgets.md
```

Resolves every anchor in each document against the source: markdown links,
heading anchors, `file.ts:120` citations, paths in prose and in fenced commands,
function names in code voice, flags and env vars. Everything carries a file and
a line.

**Use `--strict` on documents you just wrote.** A document you generated about
this repository has no excuse for naming something this repository does not
contain. Plain `cite` is the audit mode for documents that legitimately discuss
other projects; it splits findings into two severities:

- **FAIL** — what the document promises the reader can find: a link that 404s, a
  line citation past the end of a real file, a path under a directory this repo
  really has with nothing at it, an off-by-one API name next to a real one.
- **NOTE** — what the document merely names: a flag that could belong to another
  tool, an env var that might be an output field, a bare filename a tutorial asks
  the reader to create. Reported, not failed. `--strict` promotes them.

A document whose anchor count is zero **fails**. Fluent prose that names no file,
no symbol and no path asserts nothing that can be wrong, and that is also exactly
what gets produced when the code was never really read.

### Why this exists

gstack's accuracy gate is Step 8:

```
- [ ] Every API description matches the actual code signature
- [ ] No stale references to renamed/removed entities
```

Those boxes are ticked by the same context window that wrote the descriptions,
with no read-back of the source in between. Documentation is the one artifact
graded on plausibility by a reader who cannot check it: a `createWidgets()` next
to a real `createWidget()` produces exactly the report a correct run produces,
and stays wrong until somebody pastes it.

Measured on 2026-08-14: run over all 48 SKILL.md files in this repository plus
the README, `cite` checked 731 anchors and reported **zero** false failures,
while its 54-assertion selftest proves it still refuses every fabrication mode.

---

## Step 10: Commit

Stage the new documents by name. Never `git add -A`, never `git add .`.

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs secrets
```

Scans the staged content for credentials. Generated documentation is full of
example configuration, which is exactly where a real key gets pasted by accident.

Exit 1 means a live-format secret is staged: unstage it, remove the secret,
re-stage. Exit 2 means the scan could not run (not a git tree, nothing staged,
git failed) and is a refusal, not a pass.

### Why not the pipeline

gstack Step 9 scans with:

```bash
git diff --cached --no-color | grep '^+' | sed 's/^+//' | gstack-redact --json
```

A pipeline exits with the status of its *last* command, so every upstream
failure arrives at the redactor as an empty stream, which is indistinguishable
from clean input. Measured on Windows 11, 2026-08-14, outside a git work tree:

```
$ git diff --cached --no-color | grep '^+' | sed 's/^+//' | wc -c
error: unknown option `cached'
0
pipeline exit=0
```

git printed a usage error, zero bytes were scanned, and the pipeline exited 0.
Under the documented rule ("exit 3 (HIGH) → do NOT commit") that is a pass. In
PowerShell it is worse: `grep` and `sed` do not exist at all.

Then commit:

```bash
git commit -m "docs: generate [scope] documentation (Diataxis)"
```

---

## Prove the engine still works

```bash
node ~/.claude/skills/document-generate/scripts/tb-generate.mjs selftest
```

Builds throwaway projects and documents that are each wrong in exactly one way —
an off-by-one export name, a flag nothing parses, an env var nothing reads, a
line citation past the end of the file, a dead link, a dead heading anchor, an
orphaned document, fluent prose that cites nothing, and a staged AWS key — and
fails if any of them is allowed through. Exits non-zero on any failure.

---

## Rules

- **Research before writing.** Step 1 through 3 are not optional.
- **Cite, do not characterise.** `src/example.js:42`, not "in the widget module".
  A citation can be checked; a characterisation cannot.
- **Quadrants do not mix.** Tutorial content in a reference doc serves neither
  reader.
- **Cross-link everything.** An isolated document is an undiscoverable one.
- **Voice: friendly, concrete, user-forward.** Write for a smart person who has
  not seen the code. "You can now..." beats "The system provides...".
- **Completeness over minimalism.** Comprehensive documentation is cheap now.
  Write the whole thing.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief document-generate
```

Follow the lines it prints for `document-generate`. Where they disagree with
the defaults above, the mode wins. One thing no mode loosens: cite, do not
characterise. A looser stance may cut scope; it does not get to describe code
nobody read.

`modes.json` does not name this skill, so it gets that mode's `"*"` stance line
rather than a bespoke one. If you want it to behave differently per mode, give it
its own key under `skills` in that file.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
