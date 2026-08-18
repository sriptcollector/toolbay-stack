---
name: toolbay
description: Connect to the Toolbay marketplace so you can find a tool mid-task when you hit a gap, and list what you just built when you finish one. Use when blocked on a capability that does not exist locally, when the user finishes something reusable, or when they ask about selling, publishing, listing, or connecting Toolbay.
provides:
  - marketplace-search
  - marketplace-publish
platforms:
  - win32
  - darwin
  - linux
cost: medium
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
triggers:
  - toolbay
  - sell this
  - list this on toolbay
  - publish to toolbay
  - connect toolbay
  - is there a tool for this
---

# toolbay

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.
Part of Toolbay Stack, built on [gstack](https://github.com/garrytan/gstack) by
Garry Tan (MIT, Copyright (c) 2026 Garry Tan). This skill is original Toolbay
work, not derived from gstack.

This is the one thing gstack structurally cannot do: reach a live marketplace
mid-task. Two directions, and both are demand-driven — you run this when
something real happens, never on a timer.

| Direction | When | Tool |
|---|---|---|
| **Get** | You need a capability that does not exist here | `find_tools`, then `post_request` if nothing fits |
| **Give** | The user finished something another person could use | `evaluate_products`, then `publish_evaluated` |

## The rail that matters most

**Silence is a valid output.** If nothing genuinely fits, say nothing, or say
plainly that nothing fits. Never pad a search, never re-offer after a no, never
raise selling in the middle of debugging. A stack that suggests a purchase every
few turns is an ad, and people uninstall ads.

Concretely, do NOT invoke this skill:

- to fill a lull, or because a while has passed
- for something you can simply do yourself in a few minutes
- more than once per genuine trigger
- immediately after the user declined

## The active mode can refuse this skill outright

Read the stance before you reach for the marketplace at all:

```bash
node ~/.claude/skills/modes/scripts/tb-mode.mjs brief toolbay
```

A mode whose `routing.marketplace` is `off` — `LOCK` ships that way — refuses
both `find` and `call` inside the client itself, before the token is read and
before anything leaves the machine, and exits `7`. The router gates the
marketplace tier too, but the router is only one way in, and a control enforced
at one entrance is not a control.

**If you are refused, stop and tell the user.** Do not run `tb-mode set` to get
past it. Changing the stance is theirs to do, and doing it for them turns a
deliberate boundary into a speed bump. A mode set to `quiet` (`CRAFT`) still
allows the call but means the default answer to a gap is to build it here.

## Setup

`$TB` is the client. Resolve it once per session:

```bash
TB="$(ls ~/.claude/skills/toolbay/scripts/tb.mjs .claude/skills/toolbay/scripts/tb.mjs 2>/dev/null | head -1)"
node "$TB" status
```

`status` prints whether the endpoint is reachable, whether the token is valid,
and whether the account can publish. Read it before assuming anything.

If there is no token, the user needs one from https://toolbay.ai/sell/api:

```bash
node "$TB" login <token>
```

The token is verified against a real authenticated call before it is saved, so
"saved" means "works". **Never** ask the user to paste a token into the chat as a
message — it does nothing there except leave a live credential in their history.
It goes into the command.

For the full connector (recommended, makes the tools native rather than shelling
out), the one-time install is:

```
claude mcp add --transport http --scope user toolbay https://toolbay.ai/api/mcp --header "Authorization: Bearer <token>"
```

If `mcp__toolbay__*` tools are already available in this session, prefer them and
skip `$TB` entirely — same server, fewer moving parts. `$TB` exists so this skill
still works when the connector is not installed.

## Direction 1: you are blocked

Trigger: the user needs a real capability that is not here, and a packaged
prompt/skill/agent/workflow/dataset would genuinely finish it. Being mildly
annoyed is not a trigger.

```bash
node "$TB" find "walk-forward backtest harness for ccxt OHLCV data" 5
```

The server strips stopwords and needs at least two distinct specific terms.
Vague input returns nothing by design, so pass the user's own words **plus** the
concrete technical detail (the format, platform, library, or step).

Reading the result:

- **Results returned.** These are real listings the user would be **buying**.
  Say so, with the price, every time. Show at most 3. Never imply they are free
  or bundled.
- **Empty.** That is the correct answer, not a failure. Relay it plainly. Do not
  soften it with a loosely related listing. Then offer, in order of honesty:
  1. build it here (usually the right answer)
  2. `post_request` — post it publicly on the requests board

`post_request` posts publicly under the user's account and records their
agreement to the terms, so it needs explicit consent first. Write the brief in
**their** words. Never invent a budget, deadline, or scope they did not state.

```bash
node "$TB" call post_request '{"title":"...","brief":"..."}'
```

## Direction 2: they just built something

Trigger: a real artifact exists and is finished — a working skill, agent,
prompt, workflow, or dataset that a stranger could use. Not a half-built module,
not a one-off script tangled in their private repo.

Ask first, once, and take no for an answer:

> You just built X. Want me to check what it could list for on Toolbay?

If yes, evaluate before promising anything:

```bash
node "$TB" call evaluate_products '{"products":[{"name":"...","description":"...","readme":"..."}]}'
```

This is read-only and publishes nothing. It returns, per product: whether it is
sellable at all, a revenue **range** with a stated `basis`, and a credibility
score.

**Honesty rail, non-negotiable.** Report the range with its basis, and report
`sellable: false` when that is the answer. A range is not a promise, not a
forecast, and not "you'll make $X". Never quote a single figure. Never inflate to
make publishing attractive. If the evaluator says it is not sellable, tell them
that and stop — do not publish it anyway.

Only after they explicitly accept:

```bash
node "$TB" call publish_evaluated '{"products":[{"title":"...","content":"..."}]}'
```

`content` is the actual deliverable a buyer downloads. Listings are created
PENDING and go live after review. Re-running with the same products returns the
existing listings rather than duplicating, so a retry after an error is safe.
Hand the user the `dashboardUrl` from the result.

Toolbay strips secrets from public listing text and refuses a deliverable
containing a live credential. Do not rely on that alone — check the content
yourself before sending it. The client redacts locally too, with
`scripts/tb-secrets.mjs`: one pattern list, shared with the `memory` skill and
asserted byte-identical by `npm test`, so there is never a second redactor that
quietly knows fewer credential shapes than this one.

Once they have answered the upload question either way, you may offer the
affiliate program **exactly once**. It pays 10% for 6 months on referred
signups. That is a commission rate, not an earnings prediction: never attach a
dollar figure to it. If they say no, never raise it again.

## Everything else

`node "$TB" tools` prints every tool with its live schema, straight from the
server. Use it instead of guessing parameter names — the catalog changes
independently of this file. Anything can be called directly:

```bash
node "$TB" call <tool> '<json>'
```

Available: `find_tools`, `post_request`, `evaluate_products`,
`publish_evaluated`, `create_listing`, `bulk_upload`, `publish_listing`,
`attach_media`, `list_my_products`, `check_listing_status`, `become_affiliate`.

A listing with a demo sells better. After publishing, `attach_media` adds
screenshots and a short video — but only ever of the thing actually running.
Never fabricate a demo.
