# SUPERPOWERS

Recommendation for Orion. 2026-08-14. Based on a 38-skill duplication audit and three independent judge passes (product fit, provability, differentiation).

Headline: **the repo is cleaner than expected.** One skill is genuinely dead. Everything else that looked like duplication turned out to be sequenced jobs with one shared token misrouting them. The real cost is not too many skills, it is one engine written eight times by hand.

---

## 1. CUT / MERGE

Ordered by clutter removed.

**1. CUT `autoplan` from the shipped set.**
It calls `plan-eng-review`, `plan-design-review`, `plan-devex-review`. None of the three exist in TBS. Its own SKILL.md documents the outcome: exit 3, "STOP. Name the missing skill." So the flagship "one command, fully reviewed plan" is a guaranteed failure on any clean install. Either port the three reviews or make preflight degrade to a CEO-only pipeline. Do not ship it as-is. (It also carries a byte-identical copy of `expand`/`prose`/`termHits` from `plan-ceo-review`.)

**2. Promote the six hand-copied modules to `src/` and add them to `SPECS` in `tools/sync-guard.mjs`.**
This is the single biggest reduction in the repo and the mechanism is already written and already green for two files. Adding rows to a list converts silent drift into a red `npm test`:
- `fromMsysPath` (21 engines), `looksAbsolute` (21, only 6 identical)
- the evidence ledger, `ledgerPath`/`readLedger`/`writeLedger`, written **8 times** (this is the project's differentiator, hand-copied)
- the artifact check, 9 copies that are **not equivalent**: `qa` checks file size, `browse`/`design-review`/`ios-*` check PNG magic and CRC. How strict "evidence" is currently depends on which skill you ran. That is the one thing this fork cannot afford.
- the `/tmp` refusal + out-dir resolver (16 engines, 16 env vars)
- the browse-daemon adapter, **already a live bug**: `tb-browse.mjs resolveBrowse` searches git root then cwd then home; `tb-scrape.mjs findBrowseBinary` searches cwd then home only. Run `/scrape` from a subdirectory and it reports "browse binary not found" while `/browse` finds it from the same cwd.
- colour helpers, `parseColor` (the WCAG contrast arithmetic, twice)

**3. Fix `catalog.json` and the four half-landed skills.**
`route.mjs catalog --check` prints STALE and exits 1 right now, so `npm test` is red. `benchmark/`, `make-pdf/`, `setup-browser-cookies/` have engines and no SKILL.md, so they are unroutable. Finish them or delete them, but do not leave them. `setup-browser-cookies` is 1,818 lines with no caller anywhere: either `/scrape` invokes it or it goes.

**4. Delete committed selftest output and add a `.gitignore`.**
`skills/scrape/.toolbay/scrape/stdin.*` and `skills/setup-browser-cookies/scripts/.toolbay/cookies/example.com.json` are under `skills/`, which `package.json` ships to npm. A published `toolbay-stack` currently carries a fake cookie jar.

**5. Five token fixes in `capabilities.json` (one line each, all measured).**
- Drop `design-system` from `design-shotgun`'s `provides`. Its own docs say consultation owns the system. It currently collects +12 for a job it says it does not do.
- Remove `"verify the deploy"` / `"check the deploy"` from `qa-testing`. One phrase, three tokens, and a read-only question routes to the skill that runs `gh pr merge`.
- Give `canary` sole ownership of `deploy-verification`; `land-and-deploy` keeps `shipping-deploy` plus a narrower merge-proof token.
- Split `context-checkpoint` into `context-write` / `context-read`. Save and restore are separated today by one verbatim trigger string.
- Remove `"where did i leave off"` from either `next-step-suggestion` or `context-restore-verification`. A 1-point gap decides between "what should I work on" and "reload my state".

**6. Installer conflict check for `careful` + `guard`.**
Both register the same `PreToolUse` Bash hook running byte-identical engines. Install both and every destructive command prompts twice, which teaches the user to click through, which is the exact failure `/careful` exists to prevent. `bin/toolbay-stack.mjs` knows the trio exists and only prints selftest advice. Make it refuse or warn.

**7. MERGE `ios-qa`'s preflight into `ios-fix`.**
Its one universally useful question ("do I need a Mac for this") already loses its own route to `ios-fix`, 23 to 10. Give "can this machine build iOS" one owner. Its `remote-agent-authorization` tailnet grader is not QA, has no caller, and composes with nothing: split it out with a named caller or cut it.

**8. MERGE the shared method in `office-hours` and `plan-ceo-review`.**
Roughly 90 lines of the same 3-layer landscape synthesis, premise challenge, and mandatory-alternatives block, written twice. Both skills already have a `sections/` mechanism. Point both at one file.

**KEEP, explicitly, despite looking duplicated:** `qa`/`qa-only` (the read-only seal is a mechanism, not a doc), `context-save`/`context-restore`, `ship`/`land-and-deploy`/`canary` (pre-merge, merge-proof, proof-over-duration), all four of `careful`/`freeze`/`guard`/`unfreeze`, `office-hours`/`plan-ceo-review`, `design-consultation`/`design-shotgun`.

**Where the repo is already right, leave it alone:** the guard family (one authored engine, four synced copies, an engine-less `unfreeze`, selftest and doctor asserting the copies match) is textbook. So is the secrets stripper, `modes.json`, and the `./.toolbay/` vs `~/.toolbay-stack/` state convention, which has no violation across 30+ engines.

---

## 2. BUILD NOW

Three, in order. They share one substrate, so build them in this order or you build it twice.

### 1. Undo Line
**What.** One command puts the repo back exactly where it was before you said go, including everything the agent's bash commands did, and it tells you straight what it could not take back.

**Why it wins.** Claude Code, Cursor and Windsurf all ship rewind, and one judge scored this a 6 for exactly that reason. That judge is right about the mechanism and wrong about the boundary. Every shipped rewind covers files the assistant edited through its own file tools, inside the live session. None of them cover what a bash command did (installs, codemods, formatters, a script that deleted something), none cover untracked files, and none survive the session ending. That is precisely the 1am Windows failure you actually hit. And the honest half, the ledger of what did **not** get undone (a sent email, a `prisma db push`, a live deploy), exists nowhere at all. Do not pitch this as undo. Pitch it as the only undo that admits what it could not reach.

**Correction to the proposal, load-bearing.** `src/guard/tb-guard.mjs` is a destructive-pattern **denylist**: it returns allow on "no destructive pattern matched". There is no read-only certifier to reuse. The honest default is snapshot-everything, with a printed cost downgrade when the tree is too big, never a silent one.

**First slice, provable.** The journal only. `SessionStart` baseline plus `PostToolUse` on Edit/Write/MultiEdit plus `PreToolUse` on Bash, writing snapshots as `git commit-tree` chains under `refs/toolbay/undo/<session>` via a private `GIT_INDEX_FILE`. Nothing user-visible moves: not HEAD, not the index, not the stash, not `git log`. Then `tb-undo list` and `tb-undo to <step>`.
**The test that fails when it breaks:** `tb-undo selftest` restores fixture repos containing an untracked file, a deleted file, a file replaced by a directory, a detached HEAD, and a non-repo, and exits non-zero on any incomplete restore. That is a real red test, not a vibe.

**Bonus that decides the ordering.** This journal is also the edit ledger. Once it exists with byte-exact pre-images, **Edit Bisect** (all three judges scored 7, the most consistent number in the whole set) becomes a small addition rather than a project. Ship the ledger gitignored and gc'd on a short clock from day one, because pre-images must be byte-exact and therefore cannot go through the secrets stripper.

### 2. Proof of Undo
**What.** It will not deploy until it has actually run the rollback and shown you it works.

**Why it wins.** Highest agreement across all three lenses (7 / 8 / 8) and it is the thesis in one word. `modes.json` currently promises "reversible beats complete, if it can be rolled back in one command it is allowed to be rough" and nothing in the package checks that. That is a promise on trust, in the fork whose whole identity is not doing that. Nobody assembles the rollback across code, deploy target, schema and already-sent side effects and grades each leg by the proof it actually earned. Terraform previews, migration frameworks ask for a down migration and never run it, Vercel has instant rollback and nothing checks a target exists.

**First slice, provable.** Two legs, and be explicit that the other two are advisory.
- **Code leg:** `git revert --no-commit <range>` into a scratch index via `GIT_INDEX_FILE`, then discard. PROVEN if clean, UNPROVEN with the named conflicting file if not.
- **Data leg:** scan the diff for `prisma db push`, raw SQL, drops, renames, type narrowing, overwriting backfills. Nullable or defaulted column add is reversible and says so. Everything else is ONE-WAY with the statement quoted.
This slice alone would already have saved you at least twice (live Neon pushes, and the Vercel billing block that fails every deploy identically).
**The test that fails when it breaks:** selftest against a conflicting revert, a drop-column migration, a repo with no previous deployment, and a paused billing account, failing if any returns a clean green.
**Discipline that must survive:** `PROVEN-TARGET` is not `PROVEN`. The deploy leg identifies a rollback target and prints the literal command. It does not execute a rollback, so it never claims one. The second that word gets rounded up, the fork is gstack.

### 3. /split
**What.** Run the investigation three times independently, get one **shorter** report: unanimous claims stated as fact, majority claims with the dissent quoted, splits surfaced as the only question worth your attention, and the agreement rate printed as the confidence number.

**Why it wins.** Self-reported confidence is worth nothing and it is currently the only confidence signal in the entire stack. Agreement across independent runs is measurable. Uniquely among the parallel family, this one produces *less* to read, not more, and on read-only skills (`investigate`, `review`, `cso`, `spec`, qa triage) there is no merge problem to solve. It is also the best use of modes anywhere in the proposal set: SHIP acts on unanimous only, CRAFT surfaces majority, LOCK treats any split as a blocker. Same command, four different reports, which is what modes are for.

**First slice, provable.** `investigate` only, N=3. Each run emits a structured claim list (claim, `file:line`, proposed fix), a format the `spec` and `review` engines already lint. Bucket by normalised target, print three tiers, and print SPLIT as a disagreement rather than as a finding.
**The test that fails when it breaks:** fixture claim lists where the correct bucketing is known, plus the negative cases, a 1/1/1 must never appear in the findings list and an unmatchable claim must come back UNMATCHED rather than force-merged.
**Say out loud in the output:** agreement measures consistency, not truth. Three runs of one model can share one blind spot. Seed divergence from modes and the codex CLI so it is at least structural.

---

## 3. LATER / CUT

Nothing here is dead unless marked CUT.

- **Edit Bisect** (7/7/7) — LATER, and cheap once Undo Line's ledger exists. "It broke twenty minutes ago" against one uncommitted blob is the state `git bisect` structurally cannot touch. Phase two.
- **Scar Tissue (/scars)** (8/5/9) — LATER, and it is the strongest idea in the set on differentiation. See the disagreement note below.
- **Parked** (7/6/7) — LATER. Build only the refuse-by-default queue plus the "here is what I did not do" report. Never the Twilio tier.
- **Unleash** (5/7/7) — LATER. Deferring one-way actions into a replayable queue is genuinely unclaimed, but the worktree half fights OneDrive and node_modules, and the one-way classifier is worth building on its own inside Undo Line first.
- **Watch** (5/6/7) — LATER. Interruption as a finite per-mode budget and frustration-driven auto-mute exist nowhere. But you already run Telegram, a dashboard, a morning agent and a phone line. Its real justification is being the delivery channel for Edit Bisect, so build it then.
- **/away** (5/3/6) — LATER, and re-scope it. The insight (your constraint is presence, not compute) is the best emotional read in the set. The build is stacked on `/race`, which I would cut. Put the board on `/split` or a two-attempt comparison instead.
- **/race** (4/6/4) — **CUT for now.** The referee is a correct insight bought at 4x spend, with convergence as the default outcome, four builds racing inside OneDrive, and per-worktree guard boundaries (the freeze state is one global file today) as the hardest single piece of engineering proposed. You would run it twice for the demo.
- **Rehearsal (/rehearse)** (3/4/6) — **CUT.** It defeats itself: a worktree cannot sandbox a deploy, a Twilio call or an iOS install, so every procedure you actually repeat is capped at propose-only.
- **Understudy (the trust ladder)** (3/3/4) — **CUT.** Nothing to ladder until Rehearsal exists, and it promotes to AUTO on runs whose assertion may be vacuous, which is the exact self-assigned-verified failure this fork was built to delete.

### Where the judges split hard, and who I think is right

**Scar Tissue: 8 / 5 / 9.** The differentiation judge called it the single most defensible idea in the set, and the argument is strong: every rules file everywhere is hand-written, TBS memory only learns from corrections said out loud, and nothing anywhere mines *silent repair pairs* (the agent did X, then immediately undid it) into evidence-backed rules that retire on contradiction. Your own 100-line CLAUDE.md is the proof of demand. The provability judge scored it 5 for one reason only: whether the miner learns real rules or superstition cannot be proven by any selftest, only by months of real traces. Both are right, and that is the whole tension. My call: it is not build-now **because** it cannot be proven by a failing test, and "we only ship what we can prove" is the sentence this entire project is selling. Build the trace layer inside Undo Line (you need the PostToolUse trace anyway), collect real traces for a month while shipping the other three, then mine them. It becomes build-now the moment there is data to falsify it against.

**Undo Line: 8 / 9 / 6.** The 6 is a novelty objection, not a value objection: the vendor ships rewind and will keep extending it. Correct, and the answer is scope. Do not compete on rewind. Compete on the boundary nobody covers (bash side effects, untracked files, after the session ends) and on the ledger of what could not be undone, which is not a checkpoint feature at all. If the pitch is "our undo", the judge wins. If the pitch is "it tells you what it could not take back", he does not.

**Proof of Undo: 7 / 8 / 8.** The only dissent is friction ("adds seconds and occasionally a refusal at the exact second a builder has least patience"). That is real, which is why the first slice is code + data only and why SHIP mode prints the rollback command and lets you go instead of blocking.

---

## 4. THE ONE-LINE PITCH

**Toolbay Stack is the agent stack that fails closed, proves every claim it makes with an artifact you can open, and can put your machine back the way it was, including telling you exactly what it could not take back.**

Short version, for the marketplace: **it never tells you it worked without showing you the receipt.**
