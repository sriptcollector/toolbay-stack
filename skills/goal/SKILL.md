---
name: goal
version: 0.1.0
description: Say what you are trying to achieve and get back an ordered plan of skills to run, each one offered rather than performed. Reports the parts of the goal nothing covers as gaps instead of dropping them, labels weak matches as guesses and never lets one lead the plan, and refuses a goal too vague to plan rather than returning steps that would fit any project. Use to plan a goal, decide what to run, or ask what should I do to achieve something.
triggers:
  - what should I run
  - plan this
  - how do I get this done
  - I want to
  - my goal is
  - figure out what to do
  - what skills do I need
provides:
  - goal-decomposition
  - multi-skill-planning
  - coverage-gap-reporting
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# goal

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original Toolbay work. [gstack](https://github.com/garrytan/gstack) by Garry Tan
(MIT, Copyright (c) 2026 Garry Tan) has no equivalent skill, and no code here is
derived from it — but this skill routes through `/router`, whose *idea* is
gstack's, so the package-level credit applies. Not affiliated with or endorsed
by Garry Tan. See NOTICE.

## What it does

```bash
node skills/goal/scripts/tb-goal.mjs plan --goal "the checkout page 500s on submit then ship it"
node skills/goal/scripts/tb-goal.mjs plan --goal "..." --json --mode SHIP
node skills/goal/scripts/tb-goal.mjs show
```

`/router` answers *which one skill handles this request*. `/suggest` answers
*given the repo, what is worth doing next*. Neither answers the question people
actually arrive with: **here is what I want — what do I run, in what order?**

```
Plan  nothing below has been run
  1. /investigate
      for: the checkout page throws a 500 on submit
  2. /ship
      for: ship it to production

Not covered  (1)
  translate the docs into Farsi
      no skill covers this. Closest was document-generate at 0.5,
      which the router did not consider a match
```

## The four ways a planner lies

1. **It invents steps.** A plan is a persuasive shape and the temptation is to
   fill it out. Every step here comes from `route.mjs explain --json`, which
   names a skill only when the router actually chose one. This skill cannot
   name a skill the router did not return.
2. **It drops what it could not plan.** Silently omitting the third of your
   three asks turns partial coverage into what reads as a finished plan.
   Unmatched pieces are printed as **gaps**, at the same size as the steps.
3. **It presents a guess as a decision.** Weak matches are labelled `(a guess)`
   and are sorted *behind* every strong step, because step 1 is the one most
   likely to be run without being read.
4. **It runs things.** `plan` executes nothing — no skill, no shell, no write
   outside its own record. Running is a separate verb with an explicit index.

A goal too vague to decompose is **refused**, with what's missing:

```
NOT PLANNABLE — "just make it better please" is all filler words, so any plan
built from it would fit any project equally well.
```

## Why a bare "and" does not split

`fix the login and signup flow` is one job about two pages. Splitting on `and`
invents a second step out of a noun phrase. Only explicit sequence markers
split: `then`, `and then`, `after that`, `followed by`, `and also`, `;`, and a
newline.

## Known limitation, measured

The router's weak tier means *invoke it and say it is a guess*, and this skill
honours that — so a weak match still becomes a labelled step. That can be
plausibly wrong. Real example: **"translate the docs into Farsi"** becomes a
guess at `/document-generate`, because *docs* matches the documentation
capability. `/document-generate` does not translate.

The label is doing real work there, and it is not a substitute for reading the
step. If a guess looks wrong, it is wrong — skip it.

## Selftest

```bash
node skills/goal/scripts/tb-goal.mjs selftest
```

39 assertions, including an end-to-end pass through the real router. The
load-bearing ones: an unroutable intent becomes a gap rather than vanishing, a
guess never sorts to position 1, the same skill twice collapses to one step,
and a router failure is reported as a router failure rather than as "no skill
covers this".
