---
name: diagram
version: 0.1.0
description: Turn a description or mermaid source into a diagram you can trust and edit - the .mmd source, an .svg that adapts to light and dark, an .excalidraw scene you can open and move boxes in, and a .png - then read every one of them back off disk and prove it is the diagram before saying so. Flowcharts need no browser, no daemon and no network. Use for READMEs, architecture drawings, pitch artifacts, and anything a person will look at.
triggers:
  - make a diagram
  - draw a diagram
  - draw the architecture
  - create a flowchart
  - diagram this
  - visualize this flow
  - is that diagram right
provides:
  - diagramming
  - diagram-artifact-verification
  - editable-diagram-handoff
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
---

# diagram

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command, the triplet contract (source + editable scene +
rendered raster), mermaid flowchart source as the single source of truth, the
re-render-from-an-edited-scene round trip, the 1950px raster default, and the
flowchart-only limit on the editable artifact all come from `diagram` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation is a rewrite. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

## Use it

```bash
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs render flow.mmd
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs render flow.mmd --out docs/diagrams
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs render - --slug auth-flow < /dev/stdin
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs verify docs/diagrams/auth-flow.svg
```

Write the mermaid to a `.mmd` file with the Write tool, then run `render`.
`stdout` is the list of files written and nothing else. The verification line,
warnings and progress go to stderr.

Default output directory is `./diagrams`. Never `/tmp`: on Windows, node
resolves `/tmp` to `C:\tmp` while Git Bash resolves it to
`%LOCALAPPDATA%\Temp`, so a file written by one is invisible to the other.

Exit codes: `0` ok, `1` bad arguments or input, `2` the render was refused,
`3` an artifact was produced and failed verification, `4` no browser was found
(the `.svg` and `.excalidraw` were still written and verified).

## Prove it works on this machine

```bash
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs doctor
node ~/.claude/skills/diagram/scripts/tb-diagram.mjs selftest
```

`selftest` runs the engine as a child process against deliberately broken
input: an empty source, a whitespace-only source, a directory as the input, an
unknown flag, a value flag with no value, `--png-width wide`, a slug that tries
to `../` out of the output directory, an edge with nothing on one side, a
diagram declared and then left empty, a `sequenceDiagram` handed to the
flowchart engine, a `--bundle` path that is not a file, a `--browser` path that
is not a file. Each must be refused.
Then it checks the verifier itself against an `.svg` containing the literal
text `undefined`, a mermaid error graphic, a truncated `.svg`, an `.svg` with
no usable size, a scene with zero elements, a scene with a `null` coordinate, a
scene that is not JSON, an all-white PNG, an all-black PNG, a PNG that is blank
apart from one speck, a truncated PNG, a text file wearing a `.png` extension,
and a PNG whose pixel data does not inflate. Then it runs the whole thing once
with `TB_DIAGRAM_NO_BROWSER=1` and requires a verified `.svg` and `.excalidraw`
plus exit 4, because a machine with no browser must still get everything that
does not need one. It exits non-zero if any assertion fails, including the
assertion that all 52 assertions ran.

## What it verifies, on every render

There is no flag to skip this. Every file is read back off disk, not trusted
because the code that wrote it returned.

**The `.svg`**: it has an `<svg>` root, it ends with `</svg>`, it declares a
usable size in `width`/`height` or in the `viewBox`, it drew at least as many
shapes as the source has nodes, it is not a mermaid error graphic, and **every
node label and edge label in the source is present in the rendered text**. That
last one is the check that catches a render that silently produced the wrong
picture.

**The `.png`**: the signature, the chunk structure, and the pixels. The IDAT is
inflated with node's zlib and unfiltered, then the most common colour is taken
as the background and the rest is measured as ink. A screenshot taken before
the page painted is a structurally perfect PNG of one flat colour, and it is
refused here.

**The `.excalidraw`**: it parses, `type` is `excalidraw`, elements exist, every
`x`/`y`/`width`/`height` is a finite number, every label is in the scene, and
every arrow carries its binding fields so it stays attached when a box is
dragged.

An artifact that fails is **moved aside** to `<name>.rejected.<ext>` and the
run exits 3. A README that already points at `arch.svg` never silently starts
serving a broken one.

## What is different from gstack's diagram

Measured on Windows 11 against gstack 1.60.1.0.

**It failed open at the point of rendering.** gstack renders in two shell
steps:

```bash
$B js --tab-id "$TAB" "window.__renderMermaid('diagram-1', atob('...')).then(s => { window.__svg = s; ... })"
$B js --tab-id "$TAB" "window.__svg" --out <outdir>/<slug>.svg
```

If the first call throws (bad mermaid, bundle not ready, wrong tab, daemon
busy) `window.__svg` is never assigned and the second call writes the string
`undefined` into your `.svg`. Nothing in the skill reads the file back, so a
9-byte file is delivered as a diagram. Here that file is a hard failure:

```
$ tb-diagram.mjs verify undefined.svg
BAD  undefined.svg
       - the file contains the literal text "undefined", which is what a renderer
         writes when the render it was supposed to await never assigned anything
       - there is no <svg> element in it
```

**`atob()` is Latin-1, so non-ASCII labels arrive mojibaked.** gstack ships the
mermaid source into the page as base64 spliced into a shell command line and
decodes it with `atob()`, which yields one character per byte:

```
gstack  atob('Z3JhcGggTFIKICBBWyLkvb/n...') -> "  A[\"ä½¿ç¨è\"] --> B[\"donnÃ©es\"]"
toolbay JSON string literal                 -> "  A[\"使用者\"] --> B[\"données\"]"
identical to source: gstack NO | toolbay yes
```

gstack's own SKILL.md notes the fix (`decodeURIComponent(escape(...))`) beside
commands that do not do it. Here nothing crosses a shell at all: the source
goes to the parser in-process, and on the bundle path it crosses as a JSON
string literal over CDP. Backticks, `${...}` and backslashes in a label survive
for the same reason, and there is no command-line length ceiling, so a 151-node
diagram renders.

**It could not run without the browse daemon and a 9.6MB bundle.** gstack opens
a daemon tab, stages `lib/diagram-render/dist/diagram-render.html`
(9,645,479 bytes) into `/tmp` under a `shasum` digest, and shares that daemon
with whatever `/qa` or `/scrape` session is also using it. Here a flowchart is
parsed, laid out and emitted by one dependency-free `.mjs`: no daemon, no
bundle, no network, no `/tmp`, and it works on a machine with no browser at all
(you get `.mmd` + `.svg` + `.excalidraw`, and it says so). A browser is used
for one thing only: rasterising the `.svg` this engine just wrote.

**Non-flowchart mermaid still works, and still needs no daemon.** If gstack's
render bundle is on disk it is driven **directly over CDP**, so sequence, state,
class, gantt and pie diagrams render without the daemon, without `/tmp`
staging, and without `shasum`. If it is not on disk, that source is refused
with both ways forward printed rather than half-written.

**Output is deterministic.** Same source in, byte-identical `.svg` and
`.excalidraw` out. excalidraw's own exporter randomises element ids, seeds and
nonces, which makes a checked-in diagram churn its whole diff on every
re-render. Ids here are hashes of the node ids.

**The `.svg` adapts to dark mode.** Tokens on `:root` with a
`prefers-color-scheme: dark` block, so the same file reads on a white README
and a dark one. The `.png` has to commit to one, and it commits to light,
because headless Chrome reports `prefers-color-scheme: dark` and would
otherwise hand you a dark raster you did not ask for.

## What was deliberately kept

The triplet, and the reason for it: a diagram you cannot edit is a dead pixel
dump. Mermaid source as the interchange format and the single source of truth.
`graph LR` for pipelines, `graph TD` for hierarchies. 1950px raster (300dpi at
6.5in). Flowcharts convert to an editable scene and other diagram types do not,
which is stated rather than hidden. And the rule that a `.mmd` alone is not a
delivery.

## What is not ported, honestly

- **Non-flowchart types have no native renderer here.** sequence, state, class,
  gantt, pie and the rest need gstack's render bundle on disk (`--bundle`, or
  the default gstack install path). Without it they are refused. gstack renders
  them out of the box; that is a real thing it does that this does not.
- **excalidraw's hand-drawn look.** gstack uses the official
  mermaid-to-excalidraw converter with `roughness` sketchiness. The scenes here
  are clean geometry with bound arrows: fully editable, less charming.
- **Layout is layered, not dagre.** Ranks, barycentre ordering, bezier edges.
  It handles cycles, self-loops and subgraphs, and it does not route edges
  around obstacles the way dagre does. On a dense graph gstack's mermaid
  rendering is prettier.

If you need a gantt chart or the sketch aesthetic, use gstack's. It is upstream
and it is excellent.

## Workflow

1. Write the mermaid to `<outdir>/<slug>.mmd` (Write tool). Keep labels short,
   detail on the edges, 5-15 nodes.
2. `render` it. Read the exit code, not the vibe.
3. Read the `.png` with the Read tool so the user sees the diagram inline.
4. Tell them the `.excalidraw` opens at excalidraw.com (File -> Open) and that
   you can re-render from the edited scene.
5. Changes go into the `.mmd` and it gets re-rendered. The source is the source.

For a diagram destined for a PDF, `make-pdf` does not render mermaid fences, so
embed the `.png` or the `.svg` this produced.

## Completion status

- DONE - every artifact written and verified, exit 0, paths listed.
- BLOCKED - a render or a verification was refused; the reason and the exact
  failing check are in the output. Do not paper over it with a re-run.
