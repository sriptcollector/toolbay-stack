---
name: memory
version: 0.2.0
description: Keep the corrections. When the user says "no, not like that", records what they actually wanted and WHY, scoped to where it is true, so it is loaded back before the next piece of work instead of being relearned. Surfaces contradictions instead of overwriting, derives a model of how they work that stays labelled as a guess, seeds from a CLAUDE.md or notes they already wrote, and strips credentials before anything is stored or synced. Opt-in. Use when the user corrects you, repeats themselves, states a constraint or a preference, contradicts something they said before, or asks what you remember about them.
triggers:
  - no, not like that
  - i already told you
  - remember that
  - what do you remember
  - what do you know about me
  - stop doing that
  - forget that
  - that contradicts
  - only in this project
  - memory
provides:
  - user-memory
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# memory

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original work. It ships inside the skill-per-directory layout of
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). gstack has no memory layer and nothing here is derived from its
code. See LICENSE and NOTICE.

## The one idea

Claude's own memory saves **facts** and keeps them forever. A second store of
facts would be pointless. What is missing is not a place to put things, it is a
rule about **when to write**.

The highest-signal moment in any session is the one where the user says
*"no, not like that."* That sentence carries the real preference, and the clause
after it carries the reason, which is the only part that transfers to the next
task. So this layer writes on triggers, not on facts:

| Trigger | What it means | What gets written |
|---|---|---|
| **Correction** | They rejected or redirected the work | The preference **and the why**. Refused without a why. |
| **Frustration** | They repeated themselves | What we should already have known. This kind filling up means the memory is not working. |
| **Frequency** | They ask for it over and over | So it can be loaded *before* they ask again |
| **Constraint** | A fixed fact that bounds everything | Windows, node 18, no docker |
| **Preference** | A stated like or dislike | Lighter than a correction, on purpose |

And **decay**, because a memory that only accumulates is a memory that rots. Old
entries fade below a floor and stop surfacing. Nothing is ever deleted quietly:
`list` and `export` still show everything, so *"what do you have on me"* always
has a complete answer.

Five things make it a model of the person rather than a pile of facts:

| | |
|---|---|
| **Conflicts, not silent supersede** | A newer entry never quietly wins. A contradiction is surfaced with both dates and both reasons, neither side is applied, and only you resolve it. |
| **Scope** | Every entry is global, one project, or one language/path. Recall respects it. When it cannot be read off what you said, it goes **narrow**. |
| **Stated vs inferred** | Traits are derived from your corrections, linked to the exact entries behind them, labelled as derived everywhere, and rejectable. An inference can never overrule a statement. |
| **Seeding** | A CLAUDE.md, a gstack learnings store, or a notes file becomes a starting memory, marked imported and reversible in one command. |
| **Community defaults** | Optional, in their own section, and always beaten by the user's own. Receiving and contributing are separate opt-ins; a response that will not prove its k-anonymity, or no endpoint at all, changes nothing. |

## Setup

`$MEM` is the engine. Resolve it once per session:

```bash
MEM="$(ls ~/.claude/skills/memory/scripts/tb-memory.mjs .claude/skills/memory/scripts/tb-memory.mjs 2>/dev/null | head -1)"
node "$MEM" status
```

**It is off until the user turns it on, and you must not talk them into it.**
`node "$MEM" enable` prints the disclosure — what is captured, what never is,
where it goes, how to delete it — and stops. It takes a second, explicit
`enable --yes` to actually opt in. Until then `record` writes nothing at all.

If they have never seen it, offer it **once**, in one line, at a moment when it
would obviously have helped (right after they corrected you twice about the same
thing). Declined means dropped for the session.

## When to record

Record when something real happened. Never on a timer, never to fill a lull.

```bash
node "$MEM" record "put shared helpers in src/lib, not utils.js" \
  --kind correction --why "so the bundler can tree-shake them" --about helpers
```

- `--why` is **required** for a correction and a frustration, and the refusal
  message says why: *"no, redo it"* is not a rule you can apply anywhere else.
  Write the reason **they** gave. If they did not give one, ask, or do not record.
- `--about <topic>` groups by subject, which is how contradictions are found.
- Use **their words**, one line. Not your summary of them, not the transcript.
- `--source` is `stated` and you never pass anything else. `import` writes
  `imported`; nothing may write an entry the user neither said nor imported.

Do NOT record: anything you inferred, anything they said once in passing, praise
you fished for, or the content of a file. This stores preferences and patterns.
It refuses source code, private paths, and anything longer than a few lines,
and it says which rule caught it. If you think you have spotted a pattern in
them, that is a **trait**, not an entry — see below.

### Scope, which you almost never set by hand

The engine reads it off what they said. "in every project" is global, ".ts
files" is a path, and **anything unclear is kept to the current project**, on
purpose: a global rule wrongly kept local just fails to fire and you notice in a
minute; a local rule wrongly made global changes behaviour in repos nobody is
looking at. If they clearly meant everywhere and it did not catch that, fix it
after the fact — `tb-memory rescope <id> --scope global` — do not pre-empt it.

Pass where you are when you recall, so scope can actually be applied:

```bash
node "$MEM" recall "refactor the checkout page" --json --path src/checkout.ts
```

### When it says two things you told them disagree

`record` prints an `UNRESOLVED` block instead of overwriting. **Do not pick for
them and do not pick for yourself.** Show them the two lines with their dates and
their reasons, and ask which of the three it is:

```bash
node "$MEM" resolve <id> --replace          # the new one replaces the old
node "$MEM" resolve <id> --both --new-scope project --old-scope global
node "$MEM" resolve <id> --old-was-wrong    # retracted, not superseded
```

Until then neither side is recalled, and `recall` keeps showing the pair.

### Traits: the part that transfers

```bash
node "$MEM" traits            # what it adds up to, with the evidence for each
node "$MEM" reject-trait <key>
```

Everything here is **inferred**. Never quote one back as *"you told me"*, never
let one override an entry, and offer the rejection whenever you use one. One
thing they actually said against a trait deletes it, which is the correct order
of authority and is enforced in code, not by good manners.

### Seeding a new install

Do not start from zero if they already wrote it down.

```bash
node "$MEM" import claude-md        --from ~/CLAUDE.md
node "$MEM" import gstack-learnings --from ~/.gstack/projects
node "$MEM" import markdown         --from ./data/context.md
```

Without `--yes` it prints every line it would take and writes nothing. Show them
that list. Everything imported is marked `imported`, carries no invented reason,
and `tb-memory unimport <batch>` puts it all back in one command.

### Community defaults

Two separate opt-ins, and receiving has never required contributing:

```bash
node "$MEM" community on                 # receive
node "$MEM" community contribute on      # send (independent, off by default)
```

Each flag is written locally first, then pushed to the account on its own
(`PUT /api/v1/memory/settings` with just that key), so flipping one never
restates the other. Local consent governs this machine; if the push fails, the
local setting still took effect and the command says so.

What comes back from `GET /api/v1/memory/common` is **Toolbay's own sentences**,
not anyone's words, with a coarse adoption band and **no contributor count** —
a number you could watch move is a number you could de-anonymise with. So the
client's privacy check is not per-item popularity, which the response cannot
answer. It is: does this response state the `kAnonymity` it was computed at, and
does that clear our floor. If not, the whole response is refused and the cache is
dropped with it.

Defaults arrive in their own section of `recall`, are never mixed into their
entries, are never written to the store, and any default they already have their
own rule about is dropped. **No token means no shared defaults** — it is an
account feature — and that, a 404, a timeout, or an unusable body all leave
memory working exactly as it does without the feature. Never treat it as an
error.

## When to recall

At the start of real work, before you write anything:

```bash
node "$MEM" recall "refactor the checkout page" --json
```

Constraints come back whether or not they match the query, because a constraint
is true of every request **in the scope they set it in** — force-included is not
the same as force-widened. An empty recall is a correct answer and is not padded.

Read the sections apart, because they carry different authority:

| Section | What it is | How to treat it |
|---|---|---|
| `entries` | Things they said, in scope, undisputed | Instructions. They said it; you are being reminded. |
| `conflicts` | Two things they said that disagree | Show them and ask. Apply neither. |
| `inferred.traits` | Derived, never said | Use it to generalise, say it is a guess, offer the veto. |
| `community.defaults` | Other people's | The weakest thing here. Theirs already beat it. |

## What the user runs

| Command | What it does |
|---|---|
| `enable` / `enable --yes` | Disclosure, then opt in |
| `onboard` | The 60-second guide to prompting this stack |
| `status` | Exactly what is held, where it applies, where it came from, where it goes |
| `list` | Every entry with its id, including superseded, retracted and faded |
| `forget <id>` | Delete one, here and on their account |
| `conflicts` / `resolve <id>` | Every unresolved contradiction, and the three ways out |
| `rescope <id> --scope …` | Widen or narrow where a rule applies |
| `traits` / `reject-trait` / `accept-trait` | The derived model of them, and the veto |
| `import` / `imports` / `unimport` | Seed from files they already have, reversibly |
| `community [on\|off\|contribute on\|off\|fetch]` | Defaults from many users, both opt-ins |
| `export` | The whole store as JSON |
| `sync` | Push to their Toolbay account and merge back (`--pull` takes without sending, `--dry-run` prints the exact payload) |
| `disable [--forget-everything]` | Stop capturing, optionally wipe |

## The rails, which are not optional

- **Never capture a credential.** Every field is run through the shared Toolbay
  credential stripper before it is written and again before it is sent — and
  that includes every line of anything imported and every community default that
  comes back. The preference survives, the key does not. If something was
  stripped, the output says so out loud.
- **Never capture code.** This stores what they like, never what they wrote.
- **Never record without consent.** Not a queue, not a draft, not "I will save
  it when they enable it later". Off means nothing is written.
- **Never resolve a contradiction for them.** There is no default, no "newest
  wins", and no timeout after which it decides. `resolve` with no choice refuses.
- **Never present an inference as a statement.** Traits are labelled inferred
  everywhere, live outside the entry list, and lose to anything they said.
- **Default to the narrower scope.** Widening later is one command; a rule that
  silently went global is a week of wondering what changed.
- **Sync never blocks.** No token, no network, or a server error leaves memory
  working locally and says so. A sync cannot lose a local entry, and a response
  that does not parse is ignored rather than merged. The community endpoint is
  held to the same rule: absent or broken means memory works as it does today.
- **If they ask what you have on them, run `status` and `list` and show them all
  of it.** Never summarise it from what you remember of the session.

## The file they edit

```
skills/memory/memory.json
```

The kinds, their weights, their half-lives, what is never captured, how scope is
inferred, what counts as a contradiction, the whole trait catalogue, what an
import will take, the community k floor, the disclosure, and the prompting guide
live in that one file. The code knows none of the kind names or trait keys in
it: add one by adding a key, retire one by deleting it. Traits in particular are
the point of that file — a trait is a claim about a person, so the claims this
package is willing to make are a list you can read and edit in one place.

Three things cannot be edited away from that file, and all three are deliberate:
the opt-in (consent lives in the state directory, so reinstalling can never turn
it on), the stripping (the never-capture rules can be made tighter there and
cannot be made looser), and the resolution of a contradiction, which has no
setting anywhere because it is not a policy, it is a question for the user.

If that file is missing, empty, corrupt, or defines no kinds, the layer turns
**itself off**, says why, and exits zero. For a stance layer, failing closed
means falling back to a careful stance. For a memory layer it means capturing
nothing.

```bash
node ~/.claude/skills/memory/scripts/tb-memory.mjs selftest
```

360 assertions: no config, a corrupt config, consent never given, a key pasted
into a correction (checked absent from the store, the export, and the actual
bytes on the wire against a real HTTP server), sync with no token, a dead port,
a 500, a 200 whose body is unusable, a corrupt local store, an unknown `forget`
id, and a superseded entry trying to resurface.

And, for each of the guards above: a contradiction proved never to be resolved
silently and `resolve` proved to refuse without a choice; an unclear scope proved
to land narrow and a project rule proved not to leak into another project even
when its kind is force-included; a derived trait proved absent from the entry
list and killed by one thing the user stated; an imported entry proved unable to
supersede a stated one; an API key inside an imported CLAUDE.md proved absent
from the store bytes; a community default proved to lose to the user's own rule,
a response that will not state its k-anonymity and one computed below the floor
both proved refused whole, and each consent proved to be pushed to the account on
its own without restating the other; and a 401, a 404, an unparseable body, and a
dead port all proved to leave recall working exactly as it does with the feature
off, while still receiving with contributing switched off.

## Mode

This skill runs inside a stance, and the stance changes what is worth keeping:

```bash
MODE="$(ls ~/.claude/skills/modes/scripts/tb-mode.mjs .claude/skills/modes/scripts/tb-mode.mjs 2>/dev/null | head -1)"
[ -n "$MODE" ] && node "$MODE" brief memory
```

Follow the lines it prints for `memory`. Where they disagree with the defaults
above, the mode wins. Three things no mode gets to loosen: memory stays off
until the user opts in, credentials never get stored, and in LOCK you never
record anything about the client — their data, their systems, their people. A
preference about the user's own work is theirs to keep. A note about someone
else's is not.

If the modes layer is not installed, or it reports a degraded stance, run this
skill exactly as written above. The command always exits 0 and always names a
stance, so there is nothing to handle.

## Teach them, once

The best thing this skill can do for someone is not remembering — it is getting
them to say the thing worth remembering. `node "$MEM" onboard` prints it, and
opting in prints it automatically. The short version, in their words not yours:

> Tell it what you like and what you don't. That is what makes the stack better
> for you. Corrections are the input, not friction.
