---
name: land-and-deploy
version: 0.1.0
description: Merge the PR, watch the deploy, and refuse to call it shipped until the production URL is proved to be serving the merge commit. A build that exits 0 without aliasing, a netlify draft URL, and a paused account still answering 200 all fail here instead of scoring green. Use when asked to merge, land, deploy, ship to production, roll back, or check whether a deploy actually went live.
triggers:
  - land and deploy
  - merge and deploy
  - land the pr
  - ship to production
  - did it deploy
  - is it live
  - did it alias
provides:
  - shipping-deploy
  - merge-landing-proof
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
  - Glob
  - Grep
  - AskUserQuestion
---

# land-and-deploy

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The workflow (pick up where /ship left off, detect the base branch
and the platform, gate the merge behind a readiness report, handle merge queues,
never call `gh pr merge` twice after a failure, canary the live site, offer a
revert at every failure point, print a land-and-deploy report, teacher mode on
the first run and efficient mode after) comes from `land-and-deploy` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The landing ledger, the deploy-log classifier, the live-commit
probe, and the deploy fingerprint are new. Not affiliated with or endorsed by
Garry Tan. See NOTICE.

You are a release engineer. Merge efficiently, wait intelligently, and then
prove the change is live. The last part is the job. Everything before it is
setup.

---

## The rule this skill exists for

**A deploy is not verified until the production URL says which commit it is
serving, and that commit is the merge commit.**

Not: the command exited 0. Not: the workflow was green. Not: the page loads and
looks fine. Those are all true of a deploy that never landed.

Measured on `https://toolbay.ai`, 2026-08-13, applying gstack Step 7's four
health criteria verbatim:

```
  200 status                PASS (200)
  no critical console errs  PASS
  page has real content     PASS (135175 bytes)
  under 10 seconds          PASS (1.35s)

  gstack Step 7 verdict:  HEALTHY -> DEPLOYED AND VERIFIED
  (nothing above asked what commit this is)
```

All four pass whether the merge landed or the alias never moved. That is the
failure mode: green, fast, clean, and a build behind.

---

## Setup

| Parameter | Default |
|---|---|
| PR | auto-detected from the current branch |
| Production URL | from the ledger, `--url`, or CLAUDE.md |
| Output dir | `./.toolbay/land/` |
| Engine | `node <skill>/scripts/tb-land.mjs` |

```bash
node ~/.claude/skills/land-and-deploy/scripts/tb-land.mjs selftest
```

Run that once. It proves the engine refuses the deploys that must not pass.

---

## Step 0: Platform and base branch

```bash
git remote get-url origin
```

GitHub if the URL contains `github.com`, or if `gh auth status` succeeds.
GitLab if it contains `gitlab`, or `glab auth status` succeeds.

Base branch, first answer wins:

1. `gh pr view --json baseRefName -q .baseRefName`
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
3. `git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`
4. `git rev-parse --verify origin/main`, then `origin/master`

Print it. Substitute it everywhere below.

**GitLab or unknown platform:** stop. Say so, and say that `/ship` plus a manual
merge in the web UI is the path. Do not improvise a merge.

---

## Step 1: Pre-flight

```bash
gh auth status
gh pr view --json number,state,title,url,mergeStateStatus,mergeable,baseRefName,headRefName
```

- Not authenticated: stop. `gh auth login`.
- No PR: stop. `/ship` creates it.
- `MERGED`: nothing to merge. Skip to Step 5 and verify the deploy instead.
- `CLOSED`: stop.
- `CONFLICTING`: stop. Resolve and push.

Say what you found: `Found PR #NNN — "<title>" (<head> -> <base>).`

---

## Step 2: Deploy configuration, and whether it moved

```bash
node <skill>/scripts/tb-land.mjs fingerprint --repo .
```

This hashes the files that actually decide where a deploy goes: `vercel.json`,
`.vercel/project.json`, `netlify.toml`, `railway.json`/`.toml`, `fly.toml`,
`render.yaml`, `Procfile`, `Dockerfile`, `wrangler.toml`, `CLAUDE.md`, and every
file under `.github/workflows/`. Line endings are normalised, so a CRLF checkout
is not a config change.

Compare against the stored hash from the last verified landing:

```bash
node <skill>/scripts/tb-land.mjs fingerprint --repo . --compare <stored-hash>
```

Non-zero means the deploy setup changed since the last time this was verified.
Re-check the platform, the production URL, and the deploy command before merging
rather than after.

Store the new hash in `.toolbay/land/fingerprint` after a verified landing.

**Why this is not gstack's check.** gstack fingerprints
`sed -n '/## Deploy Configuration/,/^## /p' CLAUDE.md | shasum` plus workflow
files whose *name* contains `deploy` or `cd`. In a repo that deploys with
`railway up` and has no such heading, measured in Git Bash on Windows 11:

```
COMBINED=[e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855-
          e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855]
```

Both halves are the SHA-256 of the empty string. That value never changes, so
the promised "your deploy config changed, let me re-validate" never fires.

---

## Step 3: Pre-merge readiness gate

The merge is the irreversible step. Gather evidence, then ask once.

**Reviews.** For each review on record, compare the reviewed commit against HEAD:

```bash
git rev-list --count <reviewed-sha>..HEAD
git log --oneline <reviewed-sha>..HEAD
```

0 commits CURRENT, 1-3 RECENT, 4+ STALE. Any commit since the review whose
subject says fix, refactor, rewrite, or overhaul, or that touches more than 5
files, is STALE regardless of count: the review was of different code.

If STALE or never run, offer `/review` before merging. It is two minutes against
a deploy you cannot un-ship.

**Tests.** Run the project's test command from CLAUDE.md. Failing tests are a
blocker, not a warning.

**Docs.** If the diff adds files, commands, or routes and neither `CHANGELOG.md`
nor `VERSION` moved, that is a warning.

**PR body.** Compare it against `git log --oneline <base>..HEAD`. A body that
does not describe the diff is a warning.

Then one AskUserQuestion with the report inline:

- A) Merge it, everything is green
- B) Hold, fix the warnings first
- C) Merge anyway, warnings understood

On B, name the specific next command for each warning.

---

## Step 4: Merge, and record the merge commit

```bash
gh pr merge --auto --delete-branch    # respects merge queues
gh pr merge --squash --delete-branch  # if auto-merge is not enabled
```

**After ANY non-zero exit from `gh pr merge`, do not run it again.** Ask the
server what happened:

```bash
gh pr view --json state,mergeCommit,mergedAt,mergedBy
```

- `MERGED`: it landed, the local cleanup is what failed. Say "PR is merged on
  GitHub", not "the merge succeeded" — a concurrent merge looks identical.
- `OPEN` with a non-null `autoMergeRequest`: it is queued. Expected. Wait.
- `OPEN` with a null `autoMergeRequest`: real failure. Surface the stderr and the
  PR state together, then stop.
- `CLOSED`: stop.

Merge queue: poll `gh pr view --json state -q .state` every 30s up to 30 minutes.
Removed from the queue means a check failed on the merge commit; stop and say so.

Capture the SHA and open the ledger:

```bash
MERGE_SHA=$(gh pr view --json mergeCommit -q .mergeCommit.oid)
node <skill>/scripts/tb-land.mjs init --pr <n> --sha "$MERGE_SHA" --url <prod-url> --base <base>
```

`init` refuses anything that is not a 7-40 character hex SHA. `HEAD`, `latest`,
and an empty string are all rejected, because a verdict computed against them
would mean "unchecked" while printing "verified".

If this landing genuinely has no deploy (a library, a CLI, a docs-only change):

```bash
node <skill>/scripts/tb-land.mjs init --pr <n> --sha "$MERGE_SHA" --no-deploy --why "npm package, nothing deploys"
```

The reason is required and is recorded *before* the outcome is known. That is the
only honest place to declare it.

---

## Step 5: Deploy, and classify the output

Whatever runs the deploy, keep its output. The output is the evidence.

```bash
vercel --prod        > .toolbay/land/deploy.log 2>&1 ; echo "exit=$?"
railway up           > .toolbay/land/deploy.log 2>&1 ; echo "exit=$?"
netlify deploy --prod > .toolbay/land/deploy.log 2>&1 ; echo "exit=$?"
gh run view <id> --log > .toolbay/land/deploy.log
```

Then:

```bash
node <skill>/scripts/tb-land.mjs scan --log .toolbay/land/deploy.log
```

Five classifications, and only one of them is a success:

| Class | What it means | Exit |
|---|---|---|
| `aliased` | a line in the log says a deployment became live | 0 |
| `built-not-aliased` | something built, nothing went live | 1 |
| `billing` | the platform is refusing on billing | 4 |
| `failed` | the deploy reported a failure | 1 |
| `unknown` | nothing in the log matches a known outcome | 1 |

Ordering is the safety property: billing beats failure, failure beats success. A
log that carries a stale success line from an earlier attempt and ends in a 402
reads as `billing`.

**`built-not-aliased` is the one to know.** It is what a Vercel deploy on a
paused account prints: `Inspect:`, `Build Completed`, `Uploading build outputs`,
exit 0, and no `Production:` or `Aliased to` line anywhere. It is also
`netlify deploy` without `--prod` (a Draft URL is not production) and
`railway up` that uploaded and never reported a deployment. In all three the
command succeeds and production keeps serving the previous build.

**On exit 4, stop.** Do not retry, do not deploy again, do not "try once more in
case it was transient". A blocked account fails every deploy identically until
the balance is cleared. Hand over the billing URL and keep building locally so
one deploy ships everything the moment it clears.

---

## Step 6: Ask the live site what it is running

```bash
node <skill>/scripts/tb-land.mjs probe --url https://<prod>/api/version
```

The probe fetches the URL and looks through the response headers and body for
the merge SHA (7+ hex characters, prefix-compatible).

| Class | Meaning | Exit |
|---|---|---|
| `match` | the response carries the merge SHA | 0 |
| `stale` | it carries a *different* build id | 1 |
| `unproven` | 200, but nothing identifies the build | 1 |
| `error` / `unreachable` | 4xx, 5xx, or no answer | 1 |
| `billing` | 402, or `DEPLOYMENT_DISABLED` in the body | 4 |

`stale` is the green-but-dead case stated out loud: the site is up, fast, and
serving the wrong commit.

`unproven` is not a pass. Real output against a real production site:

```
  live     UNPROVEN  (https://toolbay.ai, HTTP 200)
  because  the live response answered 200 but carries no build identifier, so it
           cannot be tied to any commit. A 200 proves the URL is up, not that it
           is running this change.
```

If a project cannot answer this, that is a gap worth closing once: a
`/api/version` route returning `{"commit": process.env.VERCEL_GIT_COMMIT_SHA}`,
a `<meta name="commit">` tag, or an `x-commit` response header. One line of code
converts every future deploy from narrated to proved.

Where the response is already captured, or a second request against production
is unwelcome, feed it in instead of fetching:

```bash
node <skill>/scripts/tb-land.mjs probe --status 200 --body-file resp.txt
```

---

## Step 7: Verdict

```bash
node <skill>/scripts/tb-land.mjs verdict
```

Computed from what was recorded, in this order:

1. `BILLING BLOCKED` (exit 4) — deploy log or live site says billing. Stop.
2. `NO DEPLOY EXPECTED` (exit 0) — declared at init, with the reason.
3. `NOT PROVEN` (exit 1) — no deploy log was ever examined.
4. `DEPLOY FAILED` (exit 1).
5. `BUILT BUT NOT LIVE` (exit 1) — built, never aliased.
6. `NOT PROVEN` (exit 1) — the log is unclassifiable.
7. `NOT PROVEN` (exit 1) — aliased, but nobody checked the live URL.
8. `NOT LIVE` (exit 1) — the site errors or does not answer.
9. `STALE` (exit 1) — the site serves a different commit.
10. `UNPROVEN` (exit 1) — the site cannot say what it serves.
11. `LIVE AND VERIFIED` (exit 0) — aliased, and the URL serves the merge commit.

One path exits 0 with a deploy. There is no flag that turns any other outcome
into a pass, because the flag would be used on the day it mattered.

Report to the user with the numbers filled in:

```
LAND & DEPLOY REPORT
PR:        #<n> — <title>
Branch:    <head> -> <base>
Merge SHA: <sha>   (<auto-merge | direct | merge queue>)
Deploy:    <aliased | built-not-aliased | billing | failed | unknown>
Live:      <match | stale | unproven | error | billing>  (HTTP <n>, serving <sha>)
Timing:    CI <d>  queue <d>  deploy <d>  probe <d>  total <d>
VERDICT:   <verdict>
```

Say the verdict in plain words. "Merged and live, `toolbay.ai` is serving
`9f2c1ab`" or "Merged, built, and NOT live: the build exited 0 and never
aliased, so production is still on the previous version."

---

## Step 8: Revert

Offer it at every failure point, and explain what it does before doing it.

```bash
git fetch origin <base>
git checkout <base>
git revert <merge-sha> --no-edit
git push origin <base>
```

Conflicts on the revert mean other work landed after the merge. Stop and hand
over the SHA. Branch protection means a revert PR instead:
`gh pr create --title "revert: <original title>"`.

After the revert deploys, run Step 6 again against the reverted SHA. A revert
that was not verified is the same unverified deploy in the other direction.

---

## Rules

- Never force push. Never skip CI. Never call `gh pr merge` twice.
- Exit 0 from a deploy command is not evidence of anything.
- Narrate: what happened, what is happening, what happens next.
- Poll at 30s. 15 min for CI, 30 for a merge queue, 20 for a deploy.
- Single pass. Continuous monitoring is a different job.
- Never report a deploy as verified without the `verdict` output in front of you.
  If it was not proved, say `NOT VERIFIED` and say which step is missing.

## Windows

Every command in this skill runs the same in Git Bash and PowerShell, because
the engine is Node and the shell only ever pipes a file into it.

Deliberately not used: `shasum` and `sha256sum` (hashing is Node's), `find
-mmin` and `$PPID` (no session-file scan), `source <(...)` (no process
substitution), `setopt` (a zsh builtin that gstack calls to make a glob work),
`open` (does not exist here), `ls -t <glob>` (an unmatched glob in bash is
passed through literally and `ls` then errors on it).

`/tmp` is refused outright for `--dir` on Windows. Git Bash resolves it under
`%LOCALAPPDATA%\Temp` and Node resolves it to `C:\tmp`, so a deploy log written
by one and read by the other verifies nothing.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief land-and-deploy
```

Follow the lines it prints for `land-and-deploy`. Where they disagree with the defaults
above, the mode wins. Two things the mode never gets to loosen: a claim still
needs evidence you actually produced, and an irreversible or destructive action
still needs its exact target stated before it runs.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
