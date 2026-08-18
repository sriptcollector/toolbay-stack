---
name: router
version: 0.2.0
description: Decide which skill handles a request, using capabilities declared by the skills on disk rather than a hand-written keyword table. Use when a request is unspecific, when no obvious skill applies, or when you want to see why a particular skill was or was not picked. Ends in a marketplace tier instead of a dead end.
triggers:
  - which skill
  - what should i use
  - route this
  - which tool handles
provides:
  - skill-routing
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# router

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

The idea of a router skill comes from
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation here is original Toolbay work and is not
derived from its code. Not affiliated with or endorsed by Garry Tan. See NOTICE.

Route an unspecific request to the skill that actually covers it, and when
nothing does, go somewhere instead of stopping.

## Use it

```bash
ROUTE="$(ls ~/.claude/skills/router/scripts/route.mjs .claude/skills/router/scripts/route.mjs 2>/dev/null | head -1)"
node "$ROUTE" explain "the user's request, in their words"
```

`explain` prints the capabilities it read out of the request, every candidate
skill with its score broken down line by line, the marketplace gate with each
condition marked yes or no, and the chosen tier. Read it and act on it. Do not
paste it at the user unless they asked how the routing works.

```bash
node "$ROUTE" list      # every skill on disk and the capabilities it provides
```

## Routing happens inside a stance

The active mode (`/modes`) is part of the answer, not decoration around it. It
adds or subtracts weight per skill and can shut the marketplace tier off, so the
same sentence routes differently in SHIP and in LOCK.

```bash
node "$ROUTE" explain "review my changes" --mode wild
```

`explain` prints, in this order: the active mode and where it was resolved from,
the weighting it applied, the per-skill score with the mode's contribution on its
own line, and then **what the pick would have been with no mode at all**. If the
mode did not change the outcome it says so in one line, so a mode is never
credited with a decision it did not make.

Two rules hold in the scoring:

- **A positive boost cannot invent relevance.** A `+8` on `/freeze` does not win
  a request that never mentioned a boundary. The boost applies only to skills the
  request already matched, and when it is withheld the line says why.
- **A negative weight always applies.** A mode is allowed to push a skill down
  unconditionally, because "not now" needs no evidence.

If the modes layer is absent, routing behaves exactly as it did before the layer
existed. If it is present but broken, it resolves to a restrained built-in stance
and the marketplace tier goes quiet. Broken never means loose.

## The chain

| Tier | Condition | Action |
|---|---|---|
| 1 | A skill scores 10 or more | Invoke it |
| 2 | A skill scores 5 to 10 | Invoke it, and say it is a guess. If it is wrong, fall through |
| 3 | Nothing matches and there is no capability gap | Answer directly. Say nothing about the marketplace |
| 4 | Nothing matches and there is a real capability gap | Offer `find_tools`, then `post_request` |

Tier 3 is gstack's behaviour, kept unchanged, and it is the common case. Tier 4
exists only for the case gstack has no answer to: the user is genuinely blocked
on a capability that is not here and that a packaged artifact would finish.

## The gate on tier 4, which is the load-bearing part

An ungated marketplace tier is an advert. The gate is computed, not felt, and
`explain` prints every condition so a wrong offer can be traced to the line that
let it through. All four must hold:

1. No local skill scores above the strong threshold. If one does, there is no
   gap.
2. The request is artifact-shaped: it names a packaged thing (harness, parser,
   dataset, connector, and so on) or uses gap language ("is there a", "I need
   a", "rather not build").
3. No anti-signal is present. Debugging language, a trivial task, or a previous
   decline all veto the tier outright.
4. At least two specific terms survive stopword removal. The Toolbay matcher
   needs that many, so a vaguer query is guaranteed to return nothing and
   sending it would be theatre.

**If the gate says no, say nothing about the marketplace at all.** Not a hint,
not "there might be something out there". Silence is the correct output.

And when the gate says yes and `find_tools` comes back empty, that empty result
stands. Relay it, relay the server's `basis` string verbatim, build the thing
here, and offer `post_request` only if the user wants it. Never pad an empty
result with a near miss.

## The sell tier

`explain` also reports a sell verdict when the request carries a completion
signal and names a reusable artifact. That is the cue to offer, once:

> You just built X. Want me to check what it could list for on Toolbay?

Then `/toolbay` handles `evaluate_products` and `publish_evaluated`. Never
promise earnings, never quote a single figure, and take no for an answer the
first time.

## Why this is not gstack's routing table

gstack routes with a prose list of the form `User asks to ship, deploy, push ->
invoke /ship`. Three problems, all structural:

- It names skills, so a renamed or deleted skill leaves a stale rule.
- It has already drifted. gstack 1.60.1.0 carries two copies of the table in the
  same SKILL.md, one with 13 rules and one with 35, and they disagree.
- It is stamped into roughly 50 generated skill files, so the same knowledge
  exists 50 times.

Here the hand-maintained file is `capabilities.json`, which maps English phrases
to capability tokens and **names no skill at all**. The skill half of the
mapping is read off disk at route time. A skill that no longer exists cannot be
routed to, and a skill that was just added needs no edit anywhere.

Skills that declare `provides:` in their frontmatter are authoritative and score
higher. Skills that do not, which includes every upstream and third-party skill
on the machine, have their capabilities derived from their own description
through the same vocabulary, so nothing on disk is invisible to the router.

`catalog.json` is a generated snapshot for review and CI (`route.mjs catalog
--check`). Routing does not read it. Routing rescans disk, every time, which is
why it cannot drift.

## Limits, stated plainly

- The vocabulary in `capabilities.json` is hand-written. It cannot go stale when
  a skill changes, but it can miss a phrasing nobody thought of. When `explain`
  detects no capabilities and you can see the right skill yourself, use it and
  add the phrase.
- Derived capabilities are a guess from a description. They score below declared
  ones for that reason.
- The router scores. It does not invoke. You do.
