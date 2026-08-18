---
name: video
version: 0.1.0
description: Turn a plain sentence into a finished video. Say "make me a video showing off Toolbay" and this decides the platform, aspect ratio, length, shot list and pacing, writes a Diffusion Studio composition, drives the dapi CLI to render it, and refuses to call it a success unless the file that came out is genuinely video of genuinely the right duration and aspect. Explains every decision so a wrong guess costs one sentence instead of a render. Use when someone wants a video, reel, short, promo, demo, teaser, ad or launch clip and does not want to learn what a timeline is.
triggers:
  - make me a video
  - make a video
  - create a video
  - video showing off
  - make a reel
  - make a short
  - promo video
  - demo video
  - launch video
  - teaser
  - render a video
  - edit this footage
provides:
  - video-production
platforms:
  - win32
  - darwin
  - linux
cost: high
allowed-tools:
  - Bash
  - Read
  - Edit
---

# video

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

Original work. It ships inside the skill-per-directory layout of
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan) and sits alongside skills forked from it, but gstack has no
video layer and no code or contract here is derived from it. Not affiliated with
or endorsed by Garry Tan. See NOTICE.

It wraps [Diffusion Studio](https://github.com/diffusionstudio/editor)'s `dapi`
CLI, which is a separate MIT project and not part of this package.

## Use it

```bash
node ~/.claude/skills/video/scripts/tb-video.mjs make "make me a video showing off Toolbay"
```

That is the whole interface. You do not tell it the aspect ratio, the length,
the shot list or the pacing. It decides, tells you what it decided and why, and
then renders.

```
  Toolbay — Instagram Reels, 9:16, 22s

  What I decided, and why

  what it is about     Toolbay
                       The subject was read as "Toolbay". If that is not the name that
                       should be on screen, say the right one and everything else stays.

  aspect ratio         9:16
                       9:16, because you said Reels and Reels is a full-bleed vertical
                       surface. A 16:9 file there gets pillarboxed into a third of the
                       screen and reads as a repost before anyone has watched a frame.

  how long             22s
                       22 seconds, because that is just under the Reels drop-off cliff.

  the shot list        hook → proof → proof → close
                       4 shots filling the 22s exactly.
                         0-5.6s      hook   Opens on the subject alone, held large.
                         5.6-12s     proof  The shot that carries the video.
                         ...

  Any of that wrong? Say the one thing that is wrong and it re-plans; nothing else moves.
```

### The rest of the commands

```bash
tb-video.mjs plan "..."       decide and explain; write nothing, render nothing
tb-video.mjs compose "..."    also write the .jsx; render nothing
tb-video.mjs verify <file> --spec <spec.json>
tb-video.mjs remember "always end on the logo" --because "brand recall"
tb-video.mjs doctor           is dapi here, and can it render
```

Flags: `--assume` take the default instead of asking, `--line "..."` (once per
shot, in order), `--footage <file>` (repeatable), `--logo <file>`, `--out <dir>`,
`--json`, `--dry-run`.

Exit codes are part of the contract: **0** done, **1** refused, **2** one answer
needed before spending a render.

## What it decides for you

| It decides | From |
| ---------- | ---- |
| platform | words in your prompt ("reel", "tiktok", "landing page"), else the default in `video.json` |
| aspect ratio | the platform, unless you said "vertical" / "landscape" / "square" outright |
| duration | a number you typed beats everything; else the platform's, scaled by "quick" or "in depth" |
| shot list | the purpose it read: showcase, demo, launch, ad or teaser each have their own grammar |
| motion and colour | the tone it read: confident, energetic, calm or technical |
| subject | whatever survives after the lead-in phrases and the decisions above are stripped out |

## What it will not decide: the words

It writes no copy for you. A one-sentence brief does not say what the video
should *say*, and a plausible sentence nobody wrote is worse than an obvious
placeholder — it is the exact thing that makes generated video read as
generated. So every shot defaults to the subject, and the plan **points out the
repetition** rather than hiding it:

```
Every shot currently says "Toolbay", because nothing said what it should say.
Give it real lines with --line "..." once per shot.
```

```bash
tb-video.mjs make "22 second launch video for Toolbay on reels" \
  --line "Ship the thing" --line "Toolbay" --line "One command" --line "toolbay.ai"
```

Lines land in `spec.json` alongside the shot they belong to, so editing that file
and re-composing is also a supported way to change the words.

## What it asks

At most one question, and only when guessing wrong throws the render away.

That question is always about **where the video is going**, because aspect ratio
is the only decision on the list a re-render cannot fix: a 16:9 file is useless
on a vertical surface, while a wrong length, a wrong tone or wrong wording is a
re-run of a composition that already exists. If your prompt names a surface, an
aspect, or a purpose that implies one, it never asks. `--assume` answers it with
the default and says out loud that it did.

## Corrections stick

This skill keeps **no memory of its own**. It calls
[`skills/memory/`](../memory/SKILL.md), which already stores a correction with
the reason it was given, strips credentials before the write, and can be listed
and deleted.

```bash
tb-video.mjs remember "always end on the logo" --because "our brand recall depends on it"
```

After that, every plan gets a logo shot appended, and says why:
`Added a logo shot. Applied because you said so before: "always end on the logo"`.

The sentence is never matched by any code here. It goes through the very same
`match` tables in `video.json` that your prompt goes through, which is why a
correction phrased any of a dozen ways still lands on the right beat.

Two rules make it safe to leave on:

- **What you just said beats what you said last month.** A remembered preference
  only applies where the current prompt was silent, otherwise a preference
  recorded once could never be overruled without deleting it.
- **If memory is off or missing, it says so** and plans from `video.json` alone.
  It never pretends a correction was applied.

## It will not tell you it worked when it did not

A render is not a success because `dapi` exited 0. It is a success when the file
proves it. Every one of these is a refusal with a non-zero exit:

- `dapi` is not installed
- the render produced no file
- the file is 0 bytes
- the file is not MP4 or WebM by its own container bytes (a log saved as `.mp4`
  is not a video, however many bytes it is)
- the container has no frame payload — the shape an encoder leaves when it dies
  after writing its header
- the duration in the container is not the duration that was planned
- the aspect ratio in the container is not the aspect ratio that was planned
- the prompt says nothing about what the video is *about*

The bytes are read by `scripts/tb-video-evidence.mjs`, which sits on top of
`tb-artifact.mjs`, the same evidence gate `/qa`, `/browse` and `/devex-review`
use. It needs no ffmpeg: MP4 and WebM both print their duration and pixel
dimensions inside the file, so a fail-closed check is never the thing that is
missing. You can run it on any file, from any skill:

```bash
node scripts/tb-video-evidence.mjs check out.mp4 --seconds 22 --aspect 9:16
```

## Everything you would argue with is in `video.json`

Platforms, durations, aspect ratios, the phrases that mean each one, the shot
grammars, the palettes, the JSX for every shot, and the sentence said when
explaining a decision. `scripts/tb-video.mjs` contains none of it — it knows a
platform *has* a duration and a reason, not that Reels is 9:16 or that 22
seconds is the cliff.

So when 22 seconds turns out to be 19, that is a one-line edit by whoever
noticed, and no code changes. Same split as
[`modes.json`](../modes/modes.json) and [`memory.json`](../memory/memory.json).

## The engine

[Diffusion Studio](https://github.com/diffusionstudio/editor) is an open-source
video editor built for agents. Compositions are Solid components mounted
straight into the editor's ECS, so **every element this skill generates stays
editable** — after `dapi mount` you can drag, retime and restyle any of it by
hand. The mount is a starting point, not a black box, and re-running it rebuilds
the scene in place rather than stacking a second copy.

```
dapi mount composition.jsx      compile and mount the composition
dapi node render -o out.mp4     encode the scene to disk
```

Both are spelled out in `video.json`'s `engine` block, so a CLI change is a
config edit.

### Installing it, honestly

`dapi` **is not on npm** — `@diffusionstudio/cli` 404s on the registry. It ships
inside the Diffusion Studio desktop app, whose published download is **macOS
(Apple Silicon) only**. On Windows and Linux the only route is building the
editor from source, which wants Node 20+, an `npm install` of an Electron
monorepo, and a running app for the CLI to talk to:

```bash
git clone https://github.com/diffusionstudio/editor.git
cd editor && npm install
cp apps/web/.env.example apps/web/.env      # the app will not run without it
npm run dev:desktop
npm run symlink:create --workspace=@diffusionstudio/cli
```

`tb-video.mjs doctor` reports exactly which of these is true on the machine
you are on, and `make` refuses rather than pretending when `dapi` is absent.

**What needs an account:** the cloud features do — `dapi media transcribe`,
`dapi media listen`, and AI asset generation. A composition built from your own
footage and type does not; `dapi whoami` reports the account state and `doctor`
prints it. Nothing in this skill's default path calls a cloud feature.

## Test it

```bash
node scripts/tb-video.mjs selftest
node scripts/tb-video-evidence.mjs selftest
```

Both run under `npm test` at the repository root. The evidence selftest builds
real MP4 and WebM fixtures byte by byte from the container specs, so it proves
the parser against the format rather than against itself, and needs nothing
installed to run.
