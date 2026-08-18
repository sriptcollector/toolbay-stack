---
name: setup-deploy
version: 0.1.0
description: Work out what actually deploys this project, then write it down in a form later deploys can be checked against. Ranks every platform that has evidence on disk instead of naming two and picking neither, proves from the repository whether a git push can deploy anything at all, and refuses to record a production URL, a trigger, or a deploy command that the repo contradicts. Use when asked to set up deploys, configure deployment, or work out how a project ships.
triggers:
  - setup deploy
  - set up deploy
  - set up deployment
  - configure deployment
  - deploy config
  - what deploys this
  - does pushing deploy this
  - set deploy platform
provides:
  - deploy-configuration
  - deploy-target-detection
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# setup-deploy

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name and the contract (detect the deploy platform,
the production URL, the health check and the deploy status command, then persist
them to CLAUDE.md so `/land-and-deploy` never has to detect anything again) come
from `setup-deploy` in [gstack](https://github.com/garrytan/gstack) by Garry Tan
(MIT, Copyright (c) 2026 Garry Tan). The evidence ranking, the trigger proof,
the parseable config block, and `verify` are new. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

You are writing down a claim about the future. Everything below exists to stop
you writing down one the repository already contradicts.

---

## The rule this skill exists for

**Every field in the deploy config must come from a file that exists, and no
field may contradict one.**

The field that matters most is not the platform. It is the trigger: does
merging actually deploy this, or does a human still have to run a command.
Get that wrong and `/land-and-deploy` merges the PR, waits, verifies nothing,
and production never moves.

Measured in a repo that deploys with `railway up`, Windows 11, 2026-08-13,
running gstack Step 2 verbatim:

```
$ [ -f vercel.json ] || [ -d .vercel ] && echo "PLATFORM:vercel"
  [ -f railway.json ] || [ -f railway.toml ] && echo "PLATFORM:railway"
PLATFORM:vercel
PLATFORM:railway

$ git rev-parse --is-inside-work-tree ; git remote
true
(no output: zero remotes)
```

Two platforms, no tie-break anywhere in Step 3, and gstack's Vercel section
then asserts "Vercel deploys automatically on push". There is no remote. The
config it writes is false in the one field that decides whether the next deploy
happens at all.

---

## Setup

| Parameter | Default |
|---|---|
| Repo | the current directory |
| Config file | `CLAUDE.md` in the repo root |
| Engine | `node <skill>/scripts/tb-deploy.mjs` |

```bash
node ~/.claude/skills/setup-deploy/scripts/tb-deploy.mjs selftest
```

Run that once. It proves the engine refuses the configurations that must not
be written.

---

## Step 1: What is already recorded

```bash
node <skill>/scripts/tb-deploy.mjs read --repo .
```

- Exit 0: a config exists and parses. Show it and ask whether to keep it,
  change one field, or start again. If the user is happy, stop here.
- Exit 2 naming gstack's prose format: the repo has a `## Deploy Configuration`
  heading of markdown bullets. Nothing can parse that back, so it is not
  configuration. Say so, and reconfigure.
- Exit 2 for any other reason: the block is corrupt. Reconfigure.

---

## Step 2: Detect

```bash
node <skill>/scripts/tb-deploy.mjs detect --repo .
```

Reads `railway.json`/`.toml`, `vercel.json`, `.vercel/project.json`,
`netlify.toml`, `.netlify/state.json`, `fly.toml`, `render.yaml`, `Procfile`,
`wrangler.toml`/`.json`, `package.json` deploy scripts, every workflow under
`.github/workflows/`, and `.git/config`.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | exactly one platform has evidence | proceed with it |
| 1 | zero platforms, or two or more | ASK. Never pick for the user |
| 2 | a deploy config file exists and could not be read or parsed | stop, name the file, fix it first |

**Exit 1 with candidates is the common case and it is not a failure.** The
output ranks them with the evidence for each, so the question you ask has a
recommendation attached:

```
PLATFORM   Railway     score 7   (best guess, NOT decided)
           - railway.json (declares a deploy block)
           health path from config: /api/health
also       Vercel      score 2
           - .vercel/project.json (local link to prj_..., which survives switching platforms)
```

A committed platform config outranks a link directory a CLI dropped, because
`vercel link` writes that directory once and nothing ever removes it.

Four fields come out of the files rather than out of a question:

- **health path** — `railway.json` `deploy.healthcheckPath`, `render.yaml`
  `healthCheckPath`, `fly.toml` check `path`.
- **production URL** — `fly.toml` `app` gives `https://<app>.fly.dev`,
  `render.yaml` `name` gives `https://<name>.onrender.com`. Everything else has
  to be confirmed by the user; a custom domain is not on disk.
- **build id route** — an `/api/version` route that can name the running
  commit. Its absence is reported as absent.
- **trigger**, below.

---

## Step 3: The trigger, which is the field that decides everything

`detect` prints one of four, with `proved` true or false:

| Trigger | Proved from | Meaning |
|---|---|---|
| `cli` | the repo has zero git remotes | nothing can deploy on push. A person runs a command |
| `ci-workflow` | a workflow that deploys | the workflow deploys, and it can fail on its own |
| `git-push` | never proved | probable only. The platform-to-branch link lives in a dashboard |
| `unknown` | no platform config, or not a git repo | ask |

`git-push` is the only one this cannot prove, so it is never reported as
proved, and the skill says so out loud rather than writing a confident line
into CLAUDE.md.

When a workflow is what deploys, say which file. "Netlify deploys on push" and
"`.github/workflows/build.yml` deploys to Netlify" behave differently the day
the workflow fails.

If there is no build id route, raise it once, here:

> Nothing on this site can say which commit it is serving, so every deploy
> check from now on can only report UNPROVEN. One route returning
> `{"commit": process.env.VERCEL_GIT_COMMIT_SHA}` fixes that permanently.

---

## Step 4: Confirm, then write

Ask once, with the detection in front of the user: platform, production URL,
trigger, deploy command, health path. Then:

```bash
node <skill>/scripts/tb-deploy.mjs write --repo . \
  --platform railway --url https://toolbay.ai --trigger cli \
  --deploy-cmd "railway up" --status-cmd "railway status" \
  --health-path /api/health --build-id-path /api/version
```

It writes a delimited JSON block into CLAUDE.md, replaces any earlier one in
place, and reads it straight back before reporting success.

Refusals, all exit 3:

- `--trigger git-push` in a repository with zero remotes. `--force` does not
  apply. This is not a judgement call.
- A value still carrying gstack's template braces (`{url}`, `{platform}`).
- A URL that is not absolute `http(s)`.
- A platform with no evidence on disk, unless `--force --why "<reason>"`, and
  the reason is recorded in the config.
- `--trigger none` (a library, a CLI, nothing deploys) without `--why`.
- The same flag given twice; the first would silently have won.
- A deploy config file that cannot be read, unless forced.

The block looks like this, and `read` gets back exactly what `write` put in:

```markdown
<!-- toolbay-stack:deploy:begin v1 -->

**railway**, and pushing to git does NOT deploy it.
The deploy is `railway up`, run by a person or a job. A merge alone changes nothing in production.

```json
{ "version": 1, "platform": "railway", "trigger": "cli", ... }
```

<!-- toolbay-stack:deploy:end -->
```

---

## Step 5: Verify

```bash
node <skill>/scripts/tb-deploy.mjs verify --repo .
```

Four checks, and each one fails closed:

1. **The deploy and status commands resolve.** Against PATH and PATHEXT, in
   Node. A command that is not installed is `MISSING` and exits 1.
2. **The trigger is still possible.** Re-read from `.git/config` now, not from
   what was true when the config was written. `git-push` with no remote is
   `IMPOSSIBLE`.
3. **The URL is a URL.**
4. **The live URL names a build.** 402 or `DEPLOYMENT_DISABLED` is
   `BILLING BLOCKED`. Non-2xx is `NOT OK`. A 200 that carries no commit
   identifier anywhere is `NO BUILD ID` and does **not** pass, because that is
   the state in which every future deploy check can only report UNPROVEN.

`--config-only` skips check 4 and says so in the output. It is the only way to
skip it, and a config-only run can never be reported as a live one.

Offline, for a response you already have:

```bash
node <skill>/scripts/tb-deploy.mjs verify --repo . --status 200 --body-file resp.json
```

---

## Step 6: Report

```
DEPLOY CONFIGURATION
Repo:       <path>
Platform:   <platform>   (evidence: <files>)
Trigger:    <trigger>    (<proved | probable>)
Deploy:     <command or "on push">
URL:        <url>
Health:     <path or none>
Build id:   <path or NONE — deploy checks will report UNPROVEN>
Verify:     <ok | the checks that failed>
```

Say the trigger in plain words. "Merging deploys this" or "Merging does not
deploy this: someone runs `railway up`."

---

## Rules

- Never write a field you did not get from a file or from the user.
- Never resolve an ambiguous platform yourself. Rank it and ask.
- Never report the config as verified without `verify` output in front of you.
  If check 4 was skipped, say `NOT VERIFIED LIVE` and why.
- Never print a full API key, token, or site secret read out of a config file.
- The config block is the source of truth. `/land-and-deploy` reads it.

## Windows

Every command runs the same in Git Bash and PowerShell, because the engine is
Node and the shell only ever passes it a path.

Deliberately not used: `find` (in PowerShell this is Windows FIND.EXE, a text
search tool: `find .github/workflows -maxdepth 1 -name '*.yml'` answers
`File not found - '*.yml'` and exits 2, so gstack's workflow scan silently finds
nothing), `which` and `command -v` (neither exists in PowerShell), POSIX `[ -f
x ]` tests (`Missing type name after '['` — gstack's whole Step 2 fails at parse
time before a single line runs), `curl`, `sed`, `grep`, `shasum`.

Nor any pipeline as a check. gstack Step 5 verifies the deploy status command
with `{cmd} 2>/dev/null | head -5 || echo "COMMAND_FAILED"`. In a pipeline the
exit status is `head`'s, and `head` succeeds whenever it can write:

```
$ vercel-that-does-not-exist ls --prod 2>/dev/null | head -5 || echo "COMMAND_FAILED"
[exit=0]
```

No output, no `COMMAND_FAILED`, exit 0. A deploy status command that is not
installed verifies clean.

`/tmp` is refused outright for `--repo` on Windows: Git Bash resolves it under
`%LOCALAPPDATA%\Temp` and Node resolves it to `C:\tmp`.

**Route paths in Git Bash.** MSYS rewrites a leading-slash argument into a
Windows path before the program starts, so `--health-path /api/health` arrives
as `C:/Program Files/Git/api/health`. Measured here while writing this skill:

```
$ tb-deploy write ... --health-path /api/health
  health     C:/Program Files/Git/api/health
```

That is a shell behaviour no program can see through, so it is refused rather
than stored. Pass `--health-path //api/health` (the double slash is collapsed
back to one), or set `MSYS_NO_PATHCONV=1`, or run it from PowerShell.

## Mode

This skill runs inside a stance. Read it before you start, because it changes
what this skill should do:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief setup-deploy
```

Follow the lines it prints for `setup-deploy`. Where they disagree with the
defaults above, the mode wins. Two things the mode never gets to loosen: a
claim still needs evidence you actually produced, and a field still may not
contradict the repository it describes.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.
