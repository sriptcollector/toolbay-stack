# Pre-Landing Review Checklist

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. This checklist is adapted from `review/checklist.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The category list, the two-pass structure, the Fix-First
heuristic and the suppression list are his. The "Portability & Fail-Open" pass
is new. Not affiliated with or endorsed by Garry Tan. See NOTICE.

This file ships **inside the skill directory**, and `tb-review.mjs checklist`
resolves it relative to the script. gstack's `/review` tells you to read
`.claude/skills/review/checklist.md` and to STOP if you cannot — but its
installer ships only SKILL.md, so on a clean install that file does not exist.

## Instructions

Review the diff established by `tb-review.mjs basis` for the issues below. Cite
`file:line` and give the fix. Skip anything that is fine. Only flag real
problems.

- **Pass 1 (CRITICAL):** SQL & Data Safety, Race Conditions, LLM Output Trust
  Boundary, Shell Injection, Enum Completeness, Portability & Fail-Open.
- **Pass 2 (INFORMATIONAL):** everything else below.

Output format:

```
Pre-Landing Review: N issues (X critical, Y informational)

**AUTO-FIXED:**
- [file:line] Problem -> fix applied

**NEEDS INPUT:**
- [file:line] Problem description
  Recommended fix: suggested fix
```

If nothing is found: `Pre-Landing Review: No issues found.` Be terse. One line
for the problem, one for the fix. No preamble, no "looks good overall" (and
`tb-review.mjs claims` will reject that phrase anyway).

---

## Pass 1 — CRITICAL

### SQL & Data Safety
- String interpolation in SQL, even when the value is cast to a number. Use
  parameterized queries (Rails `sanitize_sql_array`/Arel, Node prepared
  statements, Python parameter binding).
- TOCTOU: check-then-set that should be one atomic `WHERE` + update.
- Writes that bypass model validation (`update_column`, `QuerySet.update()`,
  raw Prisma).
- N+1: an association used in a loop or a view with no eager load.

### Race Conditions & Concurrency
- Read-check-write with no unique constraint and no duplicate-key retry.
- find-or-create with no unique index: concurrent calls duplicate.
- Status transitions without `WHERE old_status = ?`, so a concurrent update
  skips or double-applies.
- Unsafe HTML on user-controlled data (`html_safe`, `raw`,
  `dangerouslySetInnerHTML`, `v-html`, `|safe`).

### LLM Output Trust Boundary
- Model-generated values (emails, URLs, names) persisted or mailed without
  format validation.
- Structured tool output written to the database without a shape check.
- Model-generated URLs fetched without an allowlist (SSRF).
- Model output stored in a vector DB or knowledge base unsanitized (stored
  prompt injection).

### Shell Injection
- `subprocess.run/call/Popen` with `shell=True` and an f-string or `.format()`
  in the command. Use an argument array.
- `os.system()` with interpolation.
- `eval()` / `exec()` on generated code with no sandbox.
- Node `child_process.exec` with a template literal; use `execFile`/`spawn` with
  an array.

### Enum & Value Completeness
When the diff adds an enum value, status, tier, or type constant: **read** every
consumer, not just grep it. Check allowlist arrays that contain sibling values.
Check `case`/`if-elsif` chains for a wrong default. This is the one category
that requires reading code outside the diff.

### Portability & Fail-Open (not in gstack's checklist)
This stack runs on Windows under Git Bash and PowerShell as a first-class target,
and these are the two ways a change quietly stops working there.

**Fails open** — a check that permits the thing it exists to stop, when the check
itself breaks:
- `|| true`, `|| exit 0`, `2>/dev/null` on the line that performs a guard.
- `[ -x "$SCRIPT" ] && "$SCRIPT" || exit 0`: a missing or non-executable file
  becomes an allow. A `.sh` checked out on Windows routinely has no exec bit.
- `try { check() } catch { return true }`, or a `catch` that returns "allowed".
- A pipeline whose exit status comes from the last stage: `cmd | tee log` reports
  0 even when `cmd` failed. Verified: `false | tee f; echo $?` prints `0`.
  Use `set -o pipefail`, `PIPESTATUS`, or capture the code directly.
- An empty result treated as a pass. "The query returned nothing" and "the query
  did not run" must not take the same branch.

**Not portable** — works on the author's machine only:
- `/tmp` in a path that Node, Python, or PowerShell will also open. Git Bash
  maps `/tmp` to `C:\Users\<u>\AppData\Local\Temp`; Node resolves the same
  string to `C:\tmp`. Use `os.tmpdir()` / `$env:TEMP`.
- `$$` for a PID, `$PPID`, `date +%s`, `date +%Y%m%d`: none exist in PowerShell.
- `case "$p" in /*)` to test absoluteness: `C:\proj` is read as relative.
- `find -mmin`, `stat -c`, `readlink -f`, `mktemp -d` assumed present.
- Hardcoded `/` separators compared against paths a tool returned with `\`.
- Symlink assumptions: creating one on Windows needs Developer Mode or elevation.
- Case-sensitive path comparison on a case-insensitive filesystem.

---

## Pass 2 — INFORMATIONAL

### Async/Sync Mixing
Blocking `subprocess.run`, `open()`, `requests.get`, or `time.sleep` inside
`async def`. Sync DB calls in async context with no executor.

### Column/Field Name Safety
ORM column names checked against the real schema. A wrong name silently returns
empty rather than raising.

### Version & Changelog Consistency
PR title, VERSION file, and CHANGELOG agree. CHANGELOG entries describe what
actually changed.

### LLM Prompt Issues
0-indexed lists in prompts (models return 1-indexed). Prompt text listing tools
that are not wired up. Token limits stated in two places that can drift.

### Completeness Gaps
Shortcuts where finishing is under half an hour. Partial enum handling.
Missing negative-path tests that mirror an existing happy path.

### Time Window Safety
Date-key lookups that assume a key covers 24h. Two related features using
different bucket sizes for the same data.

### Type Coercion at Boundaries
Values crossing a serialization boundary where the type can change. Hash and
digest inputs that are not normalized first (`{cores: 8}` vs `{cores: "8"}`).

### View / Frontend
Inline `<style>` in a partial. O(n*m) lookups in a loop. Filtering in
application code what the database could filter.

### Distribution & CI/CD
Workflow changes: tool versions, artifact paths, secrets referenced properly.
A new distributable artifact with no publish workflow. Cross-platform matrix
covers the platforms claimed (if the README says Windows, CI must run Windows).
Version tag format consistent. Publish steps idempotent on re-run.

**Do not flag:** web services with an existing auto-deploy, internal-only tools,
test-only CI changes.

---

## Fix-First Heuristic

```
AUTO-FIX (apply it):                    ASK (needs judgment):
  dead code, unused variables             security: auth, XSS, injection
  N+1 (missing eager load)                race conditions
  stale comments contradicting code       design decisions
  magic numbers -> named constants        fixes over ~20 lines
  missing LLM output validation           enum completeness
  version/path mismatches                 removing functionality
  inline styles, O(n*m) view lookups      anything user-visible
  a POSIX-only path or idiom with an
  obvious portable equivalent
```

If a senior engineer would apply it without discussion, AUTO-FIX. If reasonable
engineers could disagree, ASK. Critical findings lean ASK, informational lean
AUTO-FIX.

---

## Verification of claims

Before writing the review out:

- "this pattern is safe" -> cite the line that makes it safe
- "handled elsewhere" -> read and cite the handling code
- "tests cover this" -> name the test file and the test
- never "likely handled", "probably tested", "looks fine"

Then run it:

```bash
node ~/.claude/skills/review/scripts/tb-review.mjs claims --file review-output.md
```

Exit 1 means a claim in the review cannot be checked by the person reading it.

---

## Suppressions — do NOT flag

- Redundancy that is harmless and aids readability.
- "Add a comment explaining this threshold" — thresholds get tuned, comments rot.
- "This assertion could be tighter" when it already covers the behavior.
- Consistency-only changes.
- "Regex misses edge case X" when the input is constrained and X cannot occur.
- "This test exercises several guards at once" — that is fine.
- Empirically tuned thresholds.
- Harmless no-ops.
- **Anything already addressed in the diff.** Read the whole diff first.
