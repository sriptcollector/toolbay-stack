# Making Toolbay Stack genuinely ours

Working document. Written 2026-08-17 after Orion asked for the stack to be
"ours, and better than gstack."

## What is actually derived, measured

| | Size | Status |
|---|---|---|
| Engine code (`skills/*/scripts/*.mjs`, `src/`) | 4,175 KB | **Written by us.** Our JavaScript, our failure models, our selftests. |
| `SKILL.md` files | 624 KB | **The derived surface.** Skill names, command contracts, decomposition, docs. |
| Original skills (modes, memory, suggest, router, toolbay, video, backtest) | — | Ours outright. |

53 of 60 skills carry a `DERIVED WORK` header. Those headers are honest: we took
the *design* — what a skill is called, what it promises, how the work is split
up — and wrote our own code against it.

So this is not a code-laundering job. The code is already ours. The thing that
reads as someone else's is the shape.

## The mistake to avoid

Renaming `/investigate` to `/dig` across 53 skills would take a night, produce a
worse product, and change nothing real. It would still be gstack's decomposition
wearing different labels, and everyone who knows gstack would see that
immediately.

**A rename is not a redesign.**

## What we actually do

Redesign the surface around the two things that are already ours and that gstack
structurally cannot copy:

1. **Modes** — the stance layer. gstack has no equivalent. Every skill's
   behaviour changes with the mode, which means the mode is the product and the
   skills are its expression. That inverts gstack's model, where skills are the
   product.
2. **The marketplace** — an agent that can acquire a capability it lacks and
   publish one it just built. gstack cannot ship this; it has nothing to
   connect to.

Concretely:

- **Cut what Orion does not use.** gstack carries iOS (`ios-clean`, `ios-fix`,
  `ios-qa`, `ios-sync`, `ios-design-review`), Conductor hosts, and gbrain
  plumbing. We ported them for parity. Parity was the wrong goal — it is why we
  look like a clone. A tighter set that does more is better than a wider set
  that matches.
- **Group by intent, not by tool.** gstack's set is a list of commands. Ours
  should be a small number of intents (understand / build / prove / ship /
  learn) that dispatch to engines, with `suggest` and `router` — both ours —
  doing the dispatch. This is also what Orion asked for separately: describe a
  goal, get asked "want me to run X?", have it happen.
- **Keep every engine.** They are ours, they are tested, and they are the part
  that is genuinely better. 145 of them, each with a selftest.

## On the attribution, plainly

Once the surface is genuinely our own design rather than a port of his, the
`DERIVED WORK` headers stop being true and come off honestly — because the thing
they describe will no longer be what we shipped.

Until that is actually done, they stay. Not as a legal opinion — I am not
qualified to give one, and this is a public repo under Orion's real name — but
because right now those headers describe the code accurately, and removing a
true statement to make a product look more original is the same class of thing
this entire project exists to refuse.

The order matters: **redesign first, then the credit question answers itself.**
Doing it the other way round is just deleting a true sentence.

## Order of work

1. Define the intent surface (this doc, then a spec).
2. Cut the skills that exist only for parity.
3. Rewrite the remaining `SKILL.md` files against our own design.
4. Wire `router` + `suggest` + `modes` as the front door.
5. Re-run `npm run backtest`. The comparison stops being "same skills, smaller"
   and becomes "different product" — at which point the backtest needs new
   scenarios, because paired-skill comparison stops being meaningful.

Step 5 is worth saying out loud: **this redesign will invalidate our headline
number.** "83% less context across 53 paired skills" only means something while
the skills are paired. When they stop being paired, that claim has to be retired
rather than quietly carried forward.
