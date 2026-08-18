# DX Hall of Fame

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The gold standards, anti-patterns, the three tiers of error
quality, the error formula, the measurement frameworks and the Claude Code skill
checklist below come from `plan-devex-review/dx-hall-of-fame.md` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). Not affiliated with or endorsed by Garry Tan. See NOTICE.

Read ONLY the section for the current pass. Do not load the whole file, and do
not work from memory — if this file cannot be read, the pass is scored against
nothing:

```bash
node ~/.claude/skills/plan-devex-review/scripts/tb-devex-review.mjs ref --pass 3
```

That prints one section and exits 2 if the section or the file is unreadable, so
a missing reference stops the pass instead of being replaced by recollection.

## Pass 1: Getting Started

**Gold standards:**
- **Stripe**: 7 lines of code to charge a card. Docs pre-fill YOUR test API keys when logged in. Stripe Shell runs the CLI inside the docs page. No local install needed.
- **Vercel**: `git push` = live site on a global CDN with HTTPS. Every PR gets a preview URL. One CLI command: `vercel`.
- **Clerk**: `<SignIn />`, `<SignUp />`, `<UserButton />`. Three JSX components, working auth with email, social and MFA out of the box.
- **Supabase**: create a Postgres table, get a REST API + Realtime + self-documenting docs instantly.
- **Firebase**: `onSnapshot()`. Three lines for real-time sync across all clients with offline persistence built in.
- **Twilio**: Virtual Phone in the console. Send and receive SMS without buying a number, no credit card. Result: 62% improvement in activation.

**Anti-patterns:**
- Email verification before any value (breaks flow)
- Credit card required before sandbox
- "Choose your own adventure" with multiple paths (decision fatigue; one golden path wins)
- API keys hidden in settings (Stripe pre-fills them into code examples)
- Static code examples without language switching
- A docs site separate from the dashboard (context switching)

**Measure it before you score it.** `tthw --dir <repo>` runs the README's own
getting-started commands against the repository: a `npm run dev` with no `dev`
script, a `cp .env.example .env` with no `.env.example`, a copy-paste line still
holding `YOUR_API_KEY`. All three read perfectly in a README and none of them
work. Pass 1 cannot score above 3 while one of them is open.

## Pass 2: API/CLI/SDK Design

**Gold standards:**
- **Stripe prefixed IDs**: `ch_` for charges, `cus_` for customers. Self-documenting. Impossible to pass the wrong ID type.
- **Stripe expandable objects**: default returns ID strings; `expand[]` gets full objects inline, nested up to four levels.
- **Stripe idempotency keys**: pass `Idempotency-Key` on mutations. Safe retries. No "did I double-charge?" anxiety.
- **Stripe API versioning**: the first call pins the account to that day's version. Test new versions per-request via `Stripe-Version`.
- **GitHub CLI**: auto-detects terminal vs pipe. Human-readable in a terminal, tab-delimited when piped. `gh pr <tab>` shows all PR actions.
- **SwiftUI progressive disclosure**: `Button("Save") { save() }` up to full customization, same API at every level.
- **htmx**: HTML attributes replace JS. 14KB total. `hx-get="/search" hx-trigger="keyup changed delay:300ms"`. Zero build step.
- **shadcn/ui**: copy the source into your project. You own every line. No dependency, no version conflicts.

**Anti-patterns:**
- Chatty API: five calls for one user-visible action
- Inconsistent naming: `/users` vs `/user/123` vs `/create-order`
- Implicit failure: 200 OK with the error nested in the body
- God endpoint: 47 parameter combinations with different behaviour per subset
- Documentation-required API: three pages of docs before the first call

## Pass 3: Error Messages & Debugging

**Three tiers of error quality:**

**Tier 1, Elm (conversational compiler):**
```
-- TYPE MISMATCH ---- src/Main.elm
I cannot do addition with String values like this one:
42|   "hello" + 1
     ^^^^^^^
Hint: To put strings together, use the (++) operator instead.
```
First person, complete sentences, exact location, suggested fix, further reading.

**Tier 2, Rust (annotated source):**
```
error[E0308]: mismatched types
 --> src/main.rs:4:20
help: consider borrowing here
  |
4 |     let name: &str = &get_name();
  |                       +
```
Error code links to a tutorial. Primary + secondary labels. Help section shows the exact edit.

**Tier 3, Stripe API (structured with doc_url):**
```json
{"error":{"type":"invalid_request_error","code":"resource_missing","message":"No such customer: 'cus_nonexistent'","param":"customer","doc_url":"https://stripe.com/docs/error-codes/resource-missing"}}
```
Five fields, zero ambiguity.

**The formula:** what happened + why + how to fix + where to learn more + the actual values that caused it.

**Anti-pattern:** TypeScript buries "Did you mean?" at the BOTTOM of long error chains. The most actionable information should come FIRST.

**Pick the three by census, not by taste.** `errors --dir <repo>` scores every
error string in the codebase against the three limbs of the formula (does it name
the offending value, does it say what to do next, does it link anywhere) and
prints the ones that score zero. Trace those. A model choosing its own three
examples chooses the three it can talk about.

## Pass 4: Documentation & Learning

**Gold standards:**
- **Stripe docs**: three-column layout (nav / content / live code). API keys injected when logged in. Language switcher persists across every page. Hover-to-highlight. Stripe Shell for in-browser API calls. They built and open-sourced Markdoc. Features do not ship until the docs are finalized. Docs contributions affect performance reviews.
- 52% of developers are blocked by a lack of documentation (Postman, 2023)
- Companies with world-class docs see a 2.5x increase in adoption
- "Docs as product": it ships with the feature or the feature does not ship

## Pass 5: Upgrade & Migration Path

**Gold standards:**
- **Next.js**: `npx @next/codemod upgrade major`. One command upgrades Next.js, React and React DOM and runs every relevant codemod.
- **AG Grid**: every release from v31 includes a codemod.
- **Stripe API versioning**: one codebase internally, version pinning per account, breaking changes never surprise you.
- **Martin Fowler's pipeline pattern**: compose small testable transformations rather than one monolithic codemod.
- 21.9% of breaking changes in Maven Central were undocumented (Ochoa et al., 2021)

## Pass 6: Developer Environment & Tooling

**Gold standards:**
- **Bun**: 100x faster than `npm install`, 4x faster than the Node runtime. Speed IS DX.
- 87 interruptions per day on average; 25 minutes to recover from each. Developers code only 2-4 hours a day.
- Each 1-point DXI improvement = 13 minutes saved per developer per week.
- **GitHub Copilot**: 55.8% faster task completion. PR time from 9.6 days to 2.4 days.

**Cross-platform is not a checkbox on this rubric.** A quickstart that assumes a
POSIX shell is a quickstart that half the evaluators cannot run, and the failure
is silent: `find -mmin`, `ls -t <glob> | head -1`, `source <(...)`, `open`,
`eval "$(...)"` and `$PPID` do not error usefully on Windows, they return nothing
and the surrounding `|| echo` turns nothing into a confident wrong answer. If the
plan ships shell, score whether it was ever run anywhere but macOS.

## Pass 7: Community & Ecosystem

- Dev tools require ~14 exposures before purchase (Matt Biilmann, Netlify). Incompatible with quarterly OKR cycles.
- 4-5x performance multiplier for teams with strong developer experience (DevEx framework).

## Pass 8: DX Measurement

**Three academic frameworks:**
1. **SPACE** (Microsoft Research, 2021): Satisfaction, Performance, Activity, Communication, Efficiency. Measure at least three dimensions.
2. **DevEx** (ACM Queue, 2023): feedback loops, cognitive load, flow state. Combine perceptual and workflow data.
3. **Fagerholm & Münch** (IEEE, 2012): cognition, affect, conation. The psychological "trilogy of mind".

**The trend is a measurement too.** A scorecard column headed `Prior` that was
filled from memory is worse than an empty one. `context` prints every prior DX
review for this project across every branch; write the trend from that output or
leave it blank and say why.

## Claude Code Skill DX Checklist

Use when reviewing plans for Claude Code skills, MCP servers or AI agent tools.

- [ ] **AskUserQuestion design**: one issue per call. Re-ground context (project, branch, task). Browser handoff for visual feedback.
- [ ] **State storage**: global vs per-project vs per-session, chosen deliberately. Append-only JSONL for audit trails. **Not keyed by branch** unless the state is genuinely branch-scoped: a history keyed by branch is a history nobody ever reads twice.
- [ ] **Progressive consent**: one-time prompts with marker files. Never re-ask. Reversible.
- [ ] **Auto-upgrade**: version check with cache + snooze backoff. Migration scripts. Inline offer.
- [ ] **Skill composition**: benefits-from chains. Review chaining. Inline invocation with section skipping.
- [ ] **Error recovery**: resume from failure. Partial results preserved. Checkpoint-safe.
- [ ] **Session continuity**: timeline events. Compaction recovery. Cross-session learnings.
- [ ] **Bounded autonomy**: clear operational limits. Mandatory escalation for destructive actions. Audit trails.
- [ ] **Every check fails closed.** A check that cannot run must say so in its own words and in its own exit code. `cmd 2>/dev/null || echo "NONE_FOUND"` is the single most common DX defect in agent tooling: it turns a broken lookup into a confident empty answer that the next step treats as fact.
- [ ] **Runs on Windows.** Not "should work" — run it there once. Git Bash and PowerShell are different shells and neither is zsh.
