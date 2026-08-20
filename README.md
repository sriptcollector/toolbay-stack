<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Toolbay Stack">
</p>

<h1 align="center">Toolbay Stack</h1>

<p align="center">
  <strong>61 skills for Claude Code. 146 engines. Every one carries its own test, or the suite fails.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-fafafa?style=flat-square&labelColor=101010"></a>
  <img alt="skills" src="https://img.shields.io/badge/skills-60-fafafa?style=flat-square&labelColor=101010">
  <img alt="engines" src="https://img.shields.io/badge/engines-145%20green-fafafa?style=flat-square&labelColor=101010">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-fafafa?style=flat-square&labelColor=101010">
</p>

---

Toolbay Stack is a fork of [gstack](https://github.com/garrytan/gstack) by Garry
Tan, with one thing gstack structurally cannot ship: a live connection to a
marketplace. When your agent hits a capability it does not have, it can look for
one. When you finish building something reusable, it can list it for you.

---

## Credit where it is due

**This is built on [gstack](https://github.com/garrytan/gstack) by
[Garry Tan](https://github.com/garrytan). MIT licensed, Copyright (c) 2026 Garry
Tan.**

gstack is the origin of the core idea and of most of the workflow skills: the
persistent browser daemon, the skill-per-directory layout, the multi-host
distribution model, and the plan/review/ship workflow family. It is genuinely
excellent software and a large amount of what makes Toolbay Stack useful is
Garry's work, not ours. Every forked skill carries an attribution header naming
gstack, the full MIT notice is preserved in [LICENSE](./LICENSE), and the
relationship is spelled out in [NOTICE](./NOTICE).

Toolbay Stack is **not affiliated with or endorsed by** Garry Tan. Do not report
Toolbay Stack issues to the gstack project.

**If you want the original, use the original — it is upstream and it is very
good.** Use this fork if you specifically want the marketplace loop.

---

## Install

**Toolbay Stack is not on npm yet.** Install it from a clone — that is the only
path that works today, and it is the path described here. When the package is
published this section will gain an `npx` line; until then, do not trust one you
find anywhere else, because it 404s.

```bash
git clone https://github.com/sriptcollector/toolbay-stack.git
cd toolbay-stack
node bin/toolbay-stack.mjs install --global
```

Requires Node 18+. There is nothing to build and there are no dependencies to
install: `npm install` is not a step, because this package has zero runtime
dependencies. No account is needed, nothing phones home, and the installer opens
zero sockets.

`--global` installs into `~/.claude/skills`, for every project on the machine.
Leave it off to install into `./.claude/skills` for the current project only:

```bash
node bin/toolbay-stack.mjs install                 # all skills, this project
node bin/toolbay-stack.mjs install careful review  # just these two
node bin/toolbay-stack.mjs list                    # what is in the box
node bin/toolbay-stack.mjs status                  # what is installed, and whether it works
```

### Cursor

```bash
node bin/toolbay-stack.mjs install --cursor        # into ./.cursor for Cursor
```

Then **restart Cursor**. It watches `hooks.json` and reloads on save, but a
fresh install is worth a restart, and hooks are still beta.

Cursor can genuinely deny an edit or a shell command before it happens. That is
not read off a blog post: exit code 2 blocking, the `allow`/`deny`/`ask`
permission enum, and the fact that a matcher is an unanchored regex test against
the tool name are all read out of the Cursor build itself
(`resources/app/out/vs/workbench/workbench.desktop.main.js`, the modules under
`packages/hooks/src/`). So the guards port. Four things are worth knowing before
you rely on it.

**How you use a skill here.** Cursor has no slash commands for skills. Where
this README says `/freeze`, in Cursor you name the skill instead — "use the
freeze skill on src/api". Every installed `SKILL.md` carries a banner saying so,
and its script paths are rewritten from `.claude/skills/...` to
`.cursor/skills/...` so the agent runs a file that is actually there.

**What is refused.** A skill whose guard Cursor cannot enforce is not installed
at all, and the installer names the capability that is missing. `/plan-tune`
works by intercepting the agent's question tool. Cursor *does* have one — its
tool enum calls it `AskQuestion` — but nothing establishes that `preToolUse`
fires for it, and `/plan-tune` matches on Claude's spelling `AskUserQuestion`,
which Cursor's own Claude Code importer map does not translate. An unproven
guard is refused on the same rule as an absent one: it would install cleanly,
read as protection, and never fire.

**What the guards do not cover here.** These gaps do not exist in Claude Code,
so the skill text was not written with them in mind, and they are printed at the
top of every installed copy rather than left for you to discover:

- **Tab does not go through `/freeze`.** Cursor's inline autocomplete writes
  files on its own path, and its only edit event (`afterTabFileEdit`) fires
  after the write and cannot refuse it. Turn Tab off if the boundary has to
  hold.
- **A file written by a shell command** reaches `beforeShellExecution` and is
  judged as a command by `/careful`, not against the freeze boundary.
- **Your own typing is never guarded.** Hooks gate the agent, not the editor.

**What is not proven.** That Cursor *calls* these hooks in your build cannot be
proven without Cursor running an agent turn, so it is measured instead. Every
real invocation is recorded, and `doctor` reports `UNPROVEN` until the editor
has actually called it — then names the tool names Cursor really sent and
whether the write matcher covers them:

```bash
node src/cursor/tb-cursor.mjs capabilities   # what Cursor can and cannot do, with evidence
node src/cursor/tb-cursor.mjs doctor         # real payloads in, real decisions out
node src/cursor/tb-cursor.mjs status         # installed? wired? observed?
```

The Cursor CLI (`cursor-agent`) is out of scope: its docs describe rules,
`AGENTS.md` and `mcp.json` as shared with the editor and say nothing about
hooks, and it is a separate download from the editor. Assume terminal sessions
are unguarded until you prove otherwise.

### Prove your setup actually works

```bash
node skills/backtest/scripts/tb-backtest.mjs        # no config needed
node skills/backtest/scripts/tb-backtest.mjs discover
```

Seeds real defects — a destructive shell command, a force push, a guard fed
input it cannot parse — and runs them against the hooks this project really has
configured, whether they are ours or not. Verdicts are `CAUGHT`, `MISSED`, or
`INCONCLUSIVE`, and `INCONCLUSIVE` is never a pass.

Every scenario must carry a **control**: the same probe with the defect absent.
A judge that reports a catch on the control too is a rubber stamp, and the
scenario is thrown out rather than scored. That rule is what stops "found
nothing" being reported as "nothing to find", and it is enforced in the harness
rather than left to whoever writes the scenario. `init` writes one you can edit.

Every command the installer prints back to you is a command you can paste from
wherever you ran it — from a clone it prints `node bin/toolbay-stack.mjs ...`,
and it will print `npx toolbay-stack ...` only once that is a real thing.

After installing, check it: `status` does not answer from directory names. It
re-reads each installed SKILL.md, resolves every hook command in it, and exits
non-zero if any of them points at a file that is not there.

```bash
node bin/toolbay-stack.mjs status
```

Then prove the safety hooks are actually running, which is the whole point of
them:

```bash
node ~/.claude/skills/careful/scripts/tb-guard.mjs selftest
node ~/.claude/skills/careful/scripts/tb-guard.mjs doctor
```

`selftest` runs the guard against real and deliberately broken payloads and
fails if any of them are allowed. `doctor` runs the exact hook command in each
installed SKILL.md and prints ACTIVE or INERT.

Then, optionally, connect your Toolbay account so the stack can sell what you
build:

```bash
# 1. Get a token at https://toolbay.ai/sell/api
node ~/.claude/skills/toolbay/scripts/tb.mjs login <token>
# 2. Print the one-time connector install, with your token already in it
node ~/.claude/skills/toolbay/scripts/tb.mjs connect
```

Step 2 prints this, which makes the marketplace tools native MCP tools rather
than shell calls:

```bash
claude mcp add --transport http --scope user toolbay https://toolbay.ai/api/mcp \
  --header "Authorization: Bearer <token>"
```

Skipping all of it is fine. Nothing here is gated on an account. Do not paste a
token into a chat message: Claude cannot use it there, and it stays in your
history.

---

## What is actually different

Not a rename. Six things, in order of how much they matter.

### 1. Modes

**A mode is a stance, and it changes how every other skill behaves.** `/review`
in SHIP flags blockers and nothing else. The same `/review` in LOCK flags
everything and rejects any claim without a citation. Same command, same diff,
different output, because the work is different.

```bash
node ~/.claude/skills/modes/scripts/tb-mode.mjs set ship
node ~/.claude/skills/modes/scripts/tb-mode.mjs show
```

Four ship in the box:

| Mode | Stance |
|---|---|
| `SHIP` | Smallest reversible slice, deployed now. Review flags blockers only, QA checks the happy path |
| `CRAFT` | Finish it properly. Edge cases, tests, no shortcuts. Review flags everything |
| `WILD` | Try the weird idea. Prototype speed, no ceremony. Review mostly stays quiet |
| `LOCK` | Touch nothing outside the boundary, every operation verified, fails closed. For near-real-money and client work |

**These four are a starting set, and they are yours to change.** They live in one
hand-edited file:

```
skills/modes/modes.json
```

The code knows none of those names. Add a mode by adding a key, retire one by
deleting it. That file also holds what each mode tells each skill, and how each
mode weights the router, so a stance is a thing you edit rather than a thing you
argue with the agent about.

It also changes what gets **offered**, not just how a skill behaves once you run
it. Same repository, same uncommitted files, `/suggest` in three stances:

```
in CRAFT   1  Check this file before they get committed: .env      /cso
           2  Look over the 6 changed files before this grows      /review
           3  This change has no test in it, and this project has tests

in SHIP    1  Check this file before they get committed: .env      /cso
           2  Look at what the UI actually does now                /browse
           SHIP asks for at most 1 thing to do at a time.
           Held back by the SHIP cap: "Look over the 6 changed files..." (review)

in WILD    1  Check this file before they get committed: .env      /cso
           2  Look at what the UI actually does now                /browse
           Dropped in WILD: "This change has no test in it..." (test -40)
```

Every drop is printed with the weight that caused it, so you can disagree with
the mode and go change it. And that `.env` line is in all three on purpose: a mode
may decide tests are not today's priority, but no mode at any weight can suppress
a conflict you are standing in or a credential about to be committed. Those print
on top of the mode's cap instead of using it up, and a `modes.json` that tries to
weight them down is read, reported, and ignored.

Modes are set **per project**, so LOCK on a client repo does not follow you into
a prototype in the next tab, and a repo can pin its own mode by committing a
`.toolbay-mode` file. When a repo pin and a local setting disagree, the more
restrained one wins.

Everything about it fails closed. No mode set, an unknown mode name, a corrupt
`modes.json`, an empty one, a missing one, or a config whose own default points
at the loosest mode: all of them land on a restrained built-in stance, print the
reason, and exit zero. An unset or broken configuration never resolves to the
most permissive stance, which is the failure that would do damage quietly.

```bash
node ~/.claude/skills/modes/scripts/tb-mode.mjs selftest
```

### 2. The marketplace loop (the reason this fork exists)

gstack, like every other agent stack, dead-ends when it hits a capability gap.
Its router's last line is literally *"If no skill matches, answer directly."*
Toolbay Stack has somewhere to go:

- **Blocked mid-task?** It searches the live catalog for something that would
  genuinely finish the job. If nothing fits it says so — and can post a public
  request for someone to build it.
- **Just finished something?** It can evaluate what it might list for, honestly,
  and publish it without you opening a single form.

The connector is present for the whole session, not a one-time setup step. It
stays quiet until there is a real signal: an actual blocker, or an actual
finished artifact.

**Honesty rails, which are not optional:**

- Search results are **paid listings you would be buying**, and are always
  presented with the price.
- An empty result stays empty. It is never padded with a loosely-related listing.
- Revenue figures are **ranges with a stated basis**, from a grounded evaluator.
  Never a single number, never a promise, never a forecast.
- Offered once. Declined means dropped.
- **The mode can switch it off entirely.** `LOCK` sets `marketplace: "off"`, and
  the client itself refuses `find` and `call` before a token is read or a packet
  is sent, exiting `7`. The router gates the marketplace tier as well, but the
  router is only one way in, and a control enforced at one entrance is not a
  control. There is no bypass flag: changing the stance is the human's to do.

### 3. Memory that writes when you push back

Claude's own memory saves **facts**, and keeps them forever. A second store of
facts would be pointless. What is missing is not a place to put things, it is a
rule about **when to write** — and the highest-signal moment in any session is
the one where you say *"no, not like that."* That sentence carries the real
preference, and the clause after it carries the reason, which is the only part
that transfers to the next task.

So this layer writes on triggers, not on facts:

| Trigger | What it is | What it does |
|---|---|---|
| **Correction** | You rejected or redirected the work | Kept **with the why**, and refused without one |
| **Frustration** | You had to repeat yourself | Treated as an alarm on the memory, not as feedback |
| **Frequency** | You ask for it over and over | Loaded *before* you ask again |
| **Decay** | Quiet beats loud | An entry nobody reinforced in a year stops steering the work |

```bash
node ~/.claude/skills/memory/scripts/tb-memory.mjs enable      # the disclosure, then stop
node ~/.claude/skills/memory/scripts/tb-memory.mjs status      # exactly what it has on you
```

**A newer entry never silently wins.** The obvious design — newest correction
overrides the old one — is how a preference you set in one project quietly
breaks another. So a contradiction is *detected*, both entries are kept, and
**neither is applied** until you say which of the only three things is true: the
new one replaces it, they are both true in different contexts, or the old one
was wrong. `resolve` with no answer refuses; there is no default and no timeout
after which it decides for you.

```bash
tb-memory conflicts                         # both sides, both dates, both reasons
tb-memory resolve <id> --replace | --both | --old-was-wrong
```

**Every rule knows how far it reaches.** "No em dashes" is global; "use tabs" is
one repo; "no semicolons" is one file type. Scope is inferred from what you
actually said, and **when that is unclear it goes narrow** — a global rule
wrongly kept local just fails to fire, while a local rule wrongly made global
changes behaviour in projects nobody is looking at. `rescope` widens it in one
command, which is the cheap direction.

**It builds a model of you, and tells you it is guessing.** Six corrections about
shipping become *"you optimise for shipping over completeness, so prefer the
smallest slice that works"* — a generalisation transfers to a task it has never
seen; "they dislike X" does not. Every trait links to the exact entries behind
it, is labelled inferred everywhere it appears, never enters the entry list, and
is deleted outright by one thing you actually said against it. `reject-trait`
kills it for good.

**It starts from what you already wrote down.** A `CLAUDE.md`, a gstack learnings
store, or any notes file seeds a new install. Nothing is written until you have
seen every line, everything imported is marked *imported* rather than *stated*,
nothing invents a reason you never gave, the same stripper and the same
never-capture rules apply, and `unimport <batch>` undoes all of it in one
command.

**Defaults from other people are separate, and always lose to yours.** Receiving
community defaults and contributing to them are two independent opt-ins, each
pushed to your account on its own so flipping one never restates the other, and
receiving has never required contributing. What arrives is Toolbay's own wording
for a pattern many people converged on — never anyone's sentence — with a coarse
adoption band and no contributor count, because a number you can watch move is a
number you can de-anonymise with. The client's own check is therefore the one the
response can actually answer: it must state the k-anonymity it was computed at,
and clear our floor, or the whole response is refused and the cache goes with it.
Defaults land in their own section, never in your store, and any default you have
your own rule about is dropped and the drop is reported. No token, a 404, a
timeout, or an unusable body all leave memory behaving exactly as it does with
the feature off, and say which — it is never allowed to block a recall.

**Off until you turn it on, and turning it on takes an explicit second step.**
`enable` prints what is captured, what never is, where it goes, and how to
delete it, and then does nothing until you run `enable --yes`. Until then
`record` writes nothing at all: not a queue, not a draft.

**Credentials never reach the disk or the wire.** Every field goes through the
same stripper the Toolbay Connect client uses — one pattern list in the whole
package, copied into both skills and asserted byte-identical by `npm test` —
before anything is stored and again before anything is sent. Source code is
refused outright, and the refusal names the rule. Paste an API key into a
correction and the preference is kept, the key is not, and the tool says so.
The same applies to text that never came from you: a key sitting in the
`CLAUDE.md` you import, or in a default the community endpoint hands back, is
gone before either one reaches the store, and the selftest checks the bytes.

**It syncs to your Toolbay account, and a sync can never cost you an entry.**
No token, no network, a 500, or a 200 whose body is not the agreed shape all
leave local memory working, print the reason, and exit zero. The store on your
machine is the source of truth; the server is a mirror.

The kinds, their weights, their half-lives, the never-capture rules, how scope is
inferred, what counts as a contradiction, **the entire catalogue of traits this
package is willing to infer about a person**, the disclosure and the prompting
guide are all in one hand-edited file (`skills/memory/memory.json`), and the code
knows none of the kind names or trait keys in it. If that file is missing, empty,
corrupt, or defines no kinds, memory turns **itself off** and says why. For a
stance layer, failing closed means a careful default. For a memory layer it means
capturing nothing.

Install prints five lines on how to prompt, because the most valuable thing this
can do is get you saying the thing worth remembering: say what "done" means, say
what you do **not** want, correct it out loud **and say why**, state constraints
up front, and say what you like as well as what is wrong. Telling the agent what
you like and dislike is what makes the stack better for you. Corrections are the
fuel, not friction.

### 4. Safety hooks that fail closed, and prove it

gstack's `/careful` and `/freeze` hooks extract fields from the hook payload
with `grep`, fall back to `python3`, and when neither works they allow the
operation they exist to stop. Reproduced on Windows 11 against gstack 1.60.1.0:

```
$ printf '{"tool_input":{"command":"echo \"starting\" && rm -rf /var/data"}}' \
    | bash ~/.claude/skills/gstack/careful/bin/check-careful.sh
{}
```

`{}` means allow. The character class stops at the first escaped quote, so the
guard never sees the recursive delete. On Windows `python3` is normally the
Microsoft Store alias stub, which writes nothing and exits 49, so the fallback
does not save it. `/freeze` has the same fallback, and separately treats a
Windows drive-letter path as relative, so it blocks the edits it should allow.

Toolbay Stack's guard is one Node file. It parses the payload with `JSON.parse`,
so that bypass cannot exist, and every path that cannot reach a confident "safe"
ends in a block that says which check failed. `selftest` proves it against
deliberately broken input, and `doctor` proves the hook is really wired in. It
also covers `Remove-Item -Recurse`, `rd /s`, and `del /s`, which are what a
destructive command looks like on Windows and which gstack's POSIX-only pattern
list cannot see at all.

### 5. Routing that cannot go stale, and does not dead-end

gstack routes with a hand-written keyword table of the form `User asks to ship,
deploy, push -> invoke /ship`. It names skills, so a rename leaves a stale rule,
and it has already drifted: gstack 1.60.1.0 carries two copies of that table in
the same file, one with 13 rules and one with 35, disagreeing with each other.

Toolbay Stack's router reads skill capabilities off disk at route time. The only
hand-maintained file maps English phrases to capability tokens and names no
skill at all. A deleted skill cannot be routed to, and a new one needs no edit.
`route.mjs explain "<request>"` prints the whole decision, including the
marketplace gate condition by condition, the active mode, and what the pick would
have been without that mode, so a wrong answer can be traced. It also prints the
mode weights it **withheld**: a mode's positive boost only applies to a skill the
request already pointed at, so a stance reorders relevant skills rather than
inventing one, and the boosts that did not land are named rather than left
invisible.

### 6. Less context tax, measured rather than asserted

A `SKILL.md` is injected into the conversation when its skill is invoked, so its
size is a per-invocation cost. `node tools/backtest.mjs` reads both stacks off
disk and pairs them by skill name. On this machine, against gstack at
`~/.claude/skills/gstack`:

| | Toolbay Stack | gstack |
|---|---:|---:|
| 47 skills present in both | 520 KB | 2,846 KB |
| `/review` | 8.8 KB | 103.3 KB |
| `/spec` | 9.2 KB | 124.0 KB |
| `/qa` | 8.1 KB | 81.2 KB |
| one session: `investigate` → `review` → `ship` → `context-restore` | 38 KB (~10k est. tokens) | 290 KB (~74k est. tokens) |

Bytes are measured. Tokens are an estimate at 4 bytes/token and are labelled as
one everywhere they appear. Of gstack's 290 KB in that four-skill session, 134 KB
is lines an earlier skill in the same session already injected — an
auto-generated preamble stamped into every skill and paid for again on every
invocation.

**Three skills are BIGGER here, and the tool prints that too:** `careful`
(6.1 KB vs 2.5 KB), `freeze` (5.7 KB vs 3.1 KB) and `unfreeze` (1.7 KB vs
1.5 KB). Those are the guard skills, and the extra bytes are the documented
failure modes and the list of what the guard does *not* cover. Trimming them to
win a byte count would be gaming the number this section exists to report.

Twelve skills are not compared at all, six on each side, because only one stack
has them. `node tools/backtest.mjs` names them.

---

## Skills

| Skill | What it does | Origin |
|---|---|---|
| `modes` | The stance layer. Set a mode per project and every other skill changes what it does. Fails closed to a safe default. | New |
| `memory` | Keeps the corrections, not the facts. Writes when you push back, records the why, scopes every rule so one project cannot break another, surfaces contradictions instead of overwriting, derives a model of you that stays labelled as a guess, seeds from files you already have, and strips credentials before storing or syncing. Opt-in, and off until you say otherwise. | New |
| `toolbay` | Find a tool on the marketplace when you are blocked; list what you just built when you finish. | New |
| `router` | Pick the skill that covers a request, from capabilities read off disk. Ends in the marketplace tier instead of a dead end. | New (the idea of a router skill is gstack's) |
| `suggest` | Read the project's actual state and say what is worth doing next, with the reason. Names the command, never runs it, and says "nothing worth suggesting" when that is true. | New |
| `careful` | Warn before destructive commands. Fails closed. | Contract from gstack, rewritten |
| `freeze` | Restrict edits to one directory. Fails closed. | Contract from gstack, rewritten |
| `guard` | Both of the above in one step, same engine. | Contract from gstack, rewritten |
| `unfreeze` | Lift the freeze boundary. | Contract from gstack, rewritten |
| `investigate` | Debug to a root cause. Scope-locks edits through the guard and proves the lock holds; rejects a DEBUG REPORT that claims DONE without cited evidence. | Forked from gstack, improved |
| `review` | Pre-landing review. Establishes the diff base or refuses, instead of reading a failed `git fetch` as "nothing to review". Ships its own checklist. | Forked from gstack, improved |
| `qa` | Test a running app and fix what breaks. A pass needs an artifact that exists and is non-empty, so an empty run or a failed screenshot cannot score green. | Forked from gstack, improved |
| `spec` | Interrogate intent into an executable spec. Lints acceptance criteria for falsifiability offline, and checks `file:line` citations against real code. | Forked from gstack, improved |
| `ship` | Land a change. Captures the real test exit code instead of a pipeline's, and refuses to push on evidence produced at a commit that is no longer HEAD. | Forked from gstack, improved |

Every engine in this package carries a `selftest` that runs its checks against
deliberately broken input and exits non-zero if any of it passes. `npm test`
discovers them from disk and runs all of them, so there is no list to keep:

```bash
npm test                        # every engine, plus the two repo-wide checks
npm run engines                 # what would run, and whether each has a selftest
node skills/qa/scripts/tb-qa.mjs selftest   # or any single engine
```

An engine with no selftest FAILS the suite. That rule exists because the suite
used to be a hand-written chain naming seven engines while fifteen shipped: the
other eight had passing selftests that nothing ever ran, and two had none at
all. A test list maintained by hand drifts exactly the way gstack's routing
table drifted, so this one is read off the filesystem instead.

`suggest`'s selftest is the same idea pointed at the states a suggestion engine
actually gets opened in: a folder that is not a repository, a repository with no
commits, a repository with nothing to do, and a repository git itself refuses to
open. Each one has to answer with a suggestion that shows its evidence or an
explicit "nothing worth suggesting". None of them may throw, and none of them
may fill the silence with busywork.

More arriving as the fork proceeds. The build plan carries the full inventory:
every gstack skill with an explicit disposition (forked as-is, forked and
improved, replaced, or dropped, with reasons), the phasing, and the iOS and
routing designs.

---

## Development

```bash
npm test          # discover every engine on disk and run its selftest,
                  # plus the guard-copy sync check and the catalog drift check
npm run engines   # list the discovered engines without running them
npm run check     # node --check every discovered engine (syntax only)
npm run sync      # copy every canonical shared module into each skill
npm run catalog   # regenerate skills/router/catalog.json
npm run backtest  # run the same scenarios through this stack and through gstack
```

### The backtest

`npm test` runs 132 engine selftests, and every one of them checks an engine
against fixtures that engine wrote. That says nothing about the claim this
project actually makes. `tools/backtest.mjs` measures it: it builds fixtures
with a known defect, runs the equivalent command from **both** stacks against
them, and records CAUGHT or MISSED per side, plus per-skill context cost and
wall clock.

```bash
npm run backtest                             # everything
node tools/backtest.mjs --list               # the scenarios
node tools/backtest.mjs --only <id>          # one of them
node tools/backtest.mjs --family context     # just the size measurement
node tools/backtest.mjs --gstack <dir>       # point it at another install
```

It never writes inside gstack's directory; it reads it and runs its scripts
unmodified. Every process it starts is logged verbatim — argv, cwd, env
overrides, exit status, stdout, stderr, duration — under
`.toolbay/backtest/raw/`, next to `report.md` and `results.json`.

**It fails closed.** A scenario whose fixture did not build, whose upstream is
not installed, whose skill exists in only one stack, or which timed out, is
INCONCLUSIVE or NOT-COMPARABLE and is scored for nobody. That rule has its own
selftest and it runs inside `npm test`, because a scoreboard that turns "could
not measure" into "we won" is worse than no scoreboard. The suite currently
reports scenarios this fork loses or ties on, including one where **both** stacks
wave through a destructive command, and one capability gstack has that this fork
never ported.

A Claude Code skill has to be self contained — a skill that imports across
skill boundaries breaks the moment someone installs only one of them — so
anything used by more than one skill is authored once under `src/` and copied
in, and `tools/sync-guard.mjs` asserts every copy is byte-identical. `npm test`
fails if a copy diverges, if one is missing, or if the check cannot find them
to compare.

| Authored once at | What it is | Copies |
|---|---|---|
| `src/guard/tb-guard.mjs` | the fail-closed safety engine | 4 |
| `src/secrets/tb-secrets.mjs` | the credential stripper | 2 |
| `src/paths/tb-paths.mjs` | MSYS path conversion, the absolute-path test | 28 |
| `src/outdir/tb-outdir.mjs` | the `/tmp` refusal, the output-directory resolver | 10 |
| `src/ledger/tb-ledger.mjs` | the evidence ledger: read, write, refuse | 8 |
| `src/artifact/tb-artifact.mjs` | the evidence gate (PNG signature, IHDR, per-chunk CRC) | 4 |
| `src/color/tb-color.mjs` | the WCAG contrast arithmetic | 2 |
| `src/browse-bin/tb-browse-bin.mjs` | finding the gstack browse binary | 2 |

Each of those was hand-copied before, and each had already drifted — a browse
lookup that searched different directories in two skills, a contrast ratio that
rounded into a WCAG pass in one and not the other, and an evidence check that
accepted any non-zero file in `/qa` while `/browse` read the PNG signature. A
copy is fine. A copy nothing compares is not.

Every shared module has its own `selftest` too, so `tb-guard selftest` asserts
the same things wherever it is run from and says so on the last line, because a
proof banner printed over assertions that never ran is the failure this whole
package is about.

---

## Status

**v0.2.0, early.** The modes layer, the marketplace connector, the router, the
safety skills, and five forked workflow skills, all runnable today. The safety skills
and the router are verified on Windows. The remaining forked workflow skills and
the iOS work are planned, not yet shipped, and the README does not claim
otherwise.

## License

MIT. See [LICENSE](./LICENSE) — it preserves Garry Tan's copyright as required,
alongside Toolbay's for new work.
