---
name: design-html
version: 0.2.0
description: Turn an approved design into production markup in the framework the repo actually uses. Detects the stack (Next App Router vs Pages vs Vite vs vanilla, Tailwind v3 vs v4, shadcn, token file) instead of guessing, generates against the existing design tokens, and refuses to call the work done until a real linter over the output exits clean.
triggers:
  - build the design
  - code the mockup
  - make the design real
  - turn this into a component
  - implement this design
provides:
  - design-implementation
  - markup-quality-gate
  - client-boundary-audit
  - local-preview-server
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

# design-html

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the step order (input detection, design
analysis, framework detection, generate, preview, refine, save), the AI slop
blacklist, the "real content, never lorem ipsum" rule, the surgical-edit
refinement loop, and the source-of-truth fidelity rule come from `design-html`
in [gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright
(c) 2026 Garry Tan). Not affiliated with or endorsed by Garry Tan. See NOTICE.

## What changed and why

gstack's version generates **Pretext-native standalone HTML**: one file, a 30KB
JS text-layout engine inlined, `contenteditable` on the copy, and layout
computed at runtime by JS. That is internally coherent, and it is not something
you can paste into a Next app. It has no components, no client boundary, no
Tailwind theme, and a server component cannot run its layout pass. gstack's own
Step 2.5 offers "React component" as an option and then hands back a file with
Pretext hooks in it either way.

This version keeps the workflow and retargets the output. Markup is generated
**into the repo's real stack**, against the tokens that already exist there, and
is not called finished until `check` exits 0.

Three specific gstack behaviours this fixes, each reproduced on Windows:

1. **The preview URL is malformed and reported as working.** gstack Step 3.5
   runs `python3 -m http.server 0` then reads the port back with `lsof`. On
   Windows `lsof` does not exist and `python3` is the Microsoft Store alias
   stub, so the skill prints `SERVER: http://localhost:/finalized.html` and
   tells the user it is live. The documented fallback, `open <path>`, is also
   absent. `preview` here binds the socket in-process and prints the port off
   `server.address()`, and its selftest fetches that URL and asserts 200.
2. **Framework detection cannot see Next or Tailwind.** gstack greps
   package.json for `"react"` and takes the first match, so every Next repo is
   classified "React" and Tailwind is never detected at all. `detect` reads the
   manifest as JSON and tells App Router from Pages Router by the directory.
3. **Every quality rule is prose aimed at the model about to break it.** The
   slop blacklist and the a11y requirements are bullets in a markdown file.
   Here they are 19 rules that run and exit non-zero.

## Setup check (run first)

```bash
node ~/.claude/skills/design-html/scripts/tb-design-html.mjs doctor
```

This needs node and nothing else. It also reports whether the POSIX tools
gstack's version depends on are real on this machine, which is how you know
this port was necessary rather than cosmetic.

---

## Step 0: What are we building from

Find the design context that already exists. Any of these may be present:

- an approved mockup PNG from `/design-shotgun`
- a plan from `/plan-ceo-review` or `/plan-design-review`
- `DESIGN.md` or a token file in the repo
- nothing at all

Ask only what you cannot read off disk. If there is no visual reference and no
plan, use AskUserQuestion to establish: what this screen is for, who lands on
it, what the one action is, and what it should feel like. Do not proceed on a
brief that names no decisions — that is the `ai-slop-detection` failure, and it
produces the purple-gradient page every time.

Record the mode: `approved-mockup` | `plan-driven` | `freeform` | `evolve`.

**Artifact paths.** Mockups, boards, and approved.json belong under
`~/.toolbay-stack/projects/<slug>/designs/`, never in the repo and never in a
temp directory. They outlive the branch and the conversation. Generated
COMPONENTS, by contrast, go in the repo where they belong — that is the whole
point of this version.

---

## Step 1: Detect the stack, do not guess it

```bash
node ~/.claude/skills/design-html/scripts/tb-design-html.mjs detect .
```

Reads: `STACK`, `LANG`, `TAILWIND`, `TOKENS`, `UI`, `PM`, `ROUTER_DIR`.

If `STACK: unknown` the command exits 2 and prints why. **Stop and ask.** Do not
default to vanilla HTML. Generating the wrong kind of file is not a small error
here: it is the entire deliverable, written to the wrong shape.

What each value changes:

| Value | What it decides |
|---|---|
| `next-app` | Server component by default. `"use client"` only on files that need it, and the linter enforces it. |
| `next-pages` | No server components. Data fetching via `getServerSideProps`/`getStaticProps`. |
| `react-vite` / `react` | Plain component, no boundary directives. |
| `vanilla` | A single self-contained `.html`. No external CDN references — the linter fails on them. |
| `TAILWIND: v4` | Tokens live in CSS under `@theme`. No `tailwind.config` edits. |
| `TAILWIND: v3` | Tokens live in `tailwind.config.*` under `theme.extend`. |
| `UI: shadcn` | Compose the existing primitives. Do not hand-roll a second Button. |
| `TOKENS: <path>` | Read it before writing a line. Every colour, radius, and step comes from here. |

---

## Step 2: Read the tokens before writing markup

Open the `TOKENS` file. Extract the real names — `--color-ink`, `bg-surface`,
whatever this project calls them. The generated markup uses those names.

If `TOKENS: none`, this project has no palette yet. Say so, and propose one
small set of tokens as part of this work rather than scattering hex values
through a component. A hex literal in a project that has a palette is caught by
`raw-hex-color`; a hex literal in a project with no palette is not, because
there is nothing better to point at yet.

---

## Step 3: Write the markup

Output location is the repo, at the natural path for the detected stack
(`app/<route>/page.tsx`, `src/components/<Name>.tsx`, `index.html`).

**Always:**

- Semantic elements, and a heading outline with no holes in it.
- Every image has `alt`, including `alt=""` when it is genuinely decorative —
  that is a decision, not an omission.
- Every interactive control has an accessible name. Icon-only buttons carry
  `aria-label` and are at least 44px on their smallest side.
- Focus is visible. If you remove an outline you replace it with
  `focus-visible`.
- Any animation is wrapped in `prefers-reduced-motion` / `motion-reduce:`.
- Real content, from the mockup or the plan. Never lorem ipsum, never "Your
  text here".
- Tokens, not literals. Scale steps, not arbitrary values.
- In `next-app`: server component unless the file genuinely needs state, effects
  or handlers, and `"use client"` at the top the moment it does.

**Never** (gstack's blacklist, now enforced by `check`):

- Purple-to-blue gradients as a default.
- Empty blurred absolutely-positioned blobs.
- "Get Started" / "Learn More" as CTA text. Say what happens on click.
- Emoji as icons.
- Generic three-column feature grids, centre-everything layouts, and
  rounded-card-with-shadow as the default component.

---

## Step 4: The gate

```bash
node ~/.claude/skills/design-html/scripts/tb-design-html.mjs check <path> --stack <detected> --tokens <detected>
```

Exit codes: `0` clean, `1` findings, `2` could not check.

**Exit 2 is not a pass.** It means a file was empty, unreadable, binary, or of a
type with no rules behind it. Fix the cause. Never report success on a 2 — an
unchecked file is not a clean file, and treating "the check broke" as "the check
passed" is the exact failure this whole stack exists to remove.

Fix findings and re-run until it exits 0. If a finding is genuinely wrong for
this file, suppress that one line and say why:

```jsx
// tb-check-disable img-no-alt -- alt is injected by the CMS image wrapper
```

A suppression with no reason is itself reported as `disable-without-reason`.

---

## Step 5: Look at it

```bash
node ~/.claude/skills/design-html/scripts/tb-design-html.mjs preview <dir>
```

Prints `PORT`, `URL`, and an `OPEN` line with the command that actually works on
this platform (`cmd /c start` on Windows, `open` on macOS, `xdg-open`
elsewhere). The port is the one the OS assigned, read off the bound socket.

For a Next app, run the project's own dev server instead — `preview` is for
standalone HTML and static output.

Then verify with your own eyes, per the repo's verify-before-reporting rule:
load it at 375px and at 1440px, screenshot both, and check text does not
overflow, nothing overlaps, and the layout adapts. If you could not run the
browser, say `NOT VERIFIED:` and what blocked it. Do not imply it works.

---

## Step 6: Refine

Loop with the user. Surgical `Edit` calls, never a `Write` that regenerates the
file — they may have edited it. Re-run `check` after each round; a fix that
introduces a finding is not a fix. Two to three lines of summary per round.

---

## Rules

- **Fidelity over elegance.** With an approved mockup, match it. `w-[312px]` to
  hit the mockup is correct even though `arbitrary-value-soup` starts counting;
  that rule fires at seven, which is the point where you have stopped matching a
  design and started guessing numbers.
- **Compose what exists.** A second Button component is a bug.
- **One screen per invocation.**
- **Never claim it works without loading it.** The gate proves the markup is
  sound. It does not prove the page looks right.

## Prove the engine still works

```bash
node ~/.claude/skills/design-html/scripts/tb-design-html.mjs selftest
```

44 assertions: every one of the 19 rules fired against a file built to break
exactly that rule, a clean file passed, every could-not-check path exited 2, the
preview URL was fetched and answered 200, and a percent-encoded traversal out of
the preview root was refused. Exits non-zero if any of that stops being true —
verified by tampering with a copy, where silencing one rule and making one
fail-closed path return success dropped it to 38/44 and exit 1.

Three of those assertions are regression fixtures for bugs this engine shipped
with and the selftest found. The worst was an attribute-matching bug where
`[^>]*` stopped at the `>` inside a `() =>` arrow function, so every rule that
reads a tag body went silent on any element with an event handler — which is
most of them — and reported clean. It was caught by running the linter against a
realistic generated page instead of only its own fixtures. That is worth
repeating whenever a rule is added.
