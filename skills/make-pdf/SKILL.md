---
name: make-pdf
version: 0.1.0
description: Turn a markdown file into a publication-quality PDF, then prove it is a document. Drives whatever Chrome or Edge is already installed, with no daemon, no bundled binary, and no LaTeX. Every render is verified before it is reported: page count, embedded fonts, and the source text read back out of the PDF. Use for client one-pagers, memos, specs, and anything that gets sent to a person.
triggers:
  - make a pdf
  - make this a pdf
  - export to pdf
  - turn this markdown into a pdf
  - one-pager
  - is this pdf ok
provides:
  - pdf-generation
  - markdown-document-export
  - pdf-output-verification
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
---

# make-pdf

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command name, the `generate <in.md> [out.pdf]` shape, the
flag vocabulary, the "stdout is only the output path" contract, the print
stylesheet, and the smartypants transform come from `make-pdf` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan). The implementation is a rewrite. Not affiliated with or
endorsed by Garry Tan. See NOTICE.

## Use it

```bash
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs generate memo.md memo.pdf
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs generate essay.md essay.pdf --cover --toc --author "Orion Jones"
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs generate memo.md draft.pdf --watermark DRAFT
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs generate readme.md readme.html --to html
```

`stdout` is the output path and nothing else, so `PDF=$(... generate memo.md)`
works. Progress, warnings, and the verification line go to stderr.

Exit codes: `0` ok, `1` bad args or bad input, `2` render error,
`3` the PDF was written but does not verify, `4` no usable browser.

## Prove it works on this machine

```bash
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs doctor
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs selftest
```

`selftest` runs the engine as a child process against deliberately broken
input: empty markdown, a whitespace-only file, a directory passed as the
input, an unknown flag, a value flag with no value, a missing image under
`--strict`, a text file wearing a `.pdf` extension, and a real PDF truncated
to 60%. Each must be refused. It then does one real render and proves the
result page by page. It exits non-zero if any assertion fails, including the
assertion that all 35 assertions ran.

## What it verifies, on every generate

There is no flag to skip this.

- the file starts with `%PDF-` and ends with a `%%EOF` trailer
- the page tree contains at least one page
- at least one font program is embedded (`/FontFile*`), so the document does
  not reflow on someone else's machine
- the text layer decodes, and a contiguous run of the source's own opening
  words comes back out of it
- the text is not fragmented per glyph, which is what turns a copy-paste into
  `S a i l i n g`

Decoding is done with node's built-in zlib plus the PDF's own ToUnicode CMap.
No poppler, no `pdftotext`, no LaTeX.

You can point it at a PDF anything produced:

```bash
node ~/.claude/skills/make-pdf/scripts/tb-pdf.mjs verify whatever.pdf --json
```

## Flags

```
Structure   --cover  --toc  --no-chapter-breaks
Branding    --watermark <text>  --no-confidential  --no-page-numbers  --running-header <text>
Layout      --margins <1in|72pt|2.54cm>  --page-size <letter|a4|legal>
Metadata    --title <t>  --author <a>  --date <d>
Output      --to <pdf|html>  --strict  --allow-network  --quiet  --verbose
Engine      --browser <path to chrome>  --timeout <ms>
```

Flags may go before or after the paths. That sounds like a non-feature; it is
the main fix. See below.

## What is different from gstack's make-pdf

Measured on Windows 11 against gstack 1.60.1.0, `make-pdf/dist/pdf.exe`.

**A boolean flag ate the path after it.** gstack decides a flag's arity from
whatever token follows it, so `--cover` consumes the next filename. Two of the
four examples in gstack's own make-pdf SKILL.md do not run:

```
$ pdf.exe generate --cover --toc essay.md essay.pdf
$P: input file not found: ...\essay.pdf                        (exit 2)

$ pdf.exe generate --strict docs.md
$P generate: missing <input.md>                                (exit 1)
```

The one that does not error is worse:

```
$ pdf.exe generate t.md --cover out-cover.pdf
Done in 4.5s. 23 words - C:\Users\orion\AppData\Local\Temp\t.pdf   (exit 0)
```

`--cover` swallowed the output path, so the flag silently did nothing and the
document landed in the temp directory under a name nobody typed. Here every
flag has a declared arity, unknown flags are an error instead of being
ignored, and a value flag with no value is an error.

**Nothing looked at the PDF.** gstack calls `statSync` for a KB number and
returns. So `printf '' > empty.md && pdf.exe generate empty.md out.pdf` exits
0, prints a path, and hands back 757 bytes with zero extractable text. Here an
empty document is refused before rendering, and every render is verified after
it.

**It needed a daemon and a 100MB binary.** gstack's make-pdf shells out to the
`browse` daemon for every step and ships a 100,749,312-byte `pdf.exe`. If
browse is missing the answer is exit 4 and no PDF, and browse's safe-directory
allowlist refuses output paths outside cwd or TEMP. This is one dependency-free
`.mjs` that drives an already-installed Chrome, Edge, Brave, Chromium, or
Playwright download over CDP, and it creates the output directory if it is
missing.

## What was deliberately kept

The print stylesheet, unchanged in substance: 1in margins, flush-left 12pt
Helvetica with Liberation Sans for Linux, 26pt/18pt/13.5pt heading scale, the
56pt poster cover, running header and `N of M` page numbers and the
CONFIDENTIAL footer in `@page` margin boxes, `@page :first` suppressing both on
the cover, and no auto-hyphenation because hyphenation puts real `dif-\nferent`
breaks into the text layer. It was design-reviewed upstream and it looks right.
Also kept: smartypants and its preserved zones (code, tags, and URLs are never
touched), and the flag names, so muscle memory carries over.

## What is not ported, honestly

- **mermaid / excalidraw fences.** gstack ships a vendored offline renderer
  bundle for these. Here a fence stays a code block. `doctor` says so.
- **`--to docx`.** gstack uses the `html-to-docx` package. This engine has no
  dependencies, so docx is refused with a message rather than faked.
- **Raster downscaling to 300dpi.** Images are inlined at their original size
  and capped to the content box by CSS. Never truncated, sometimes heavier
  than gstack's output.

If you need diagrams or Word output, use gstack's. It is upstream and it is
excellent.
