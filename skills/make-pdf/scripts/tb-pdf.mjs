#!/usr/bin/env node
/**
 * tb-pdf.mjs: the Toolbay Stack markdown-to-PDF engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /make-pdf
 * skill, the `generate <in.md> [out.pdf]` command shape, the flag vocabulary
 * --cover/--toc/--watermark/--margins/--page-size/--strict/--allow-network,
 * the "stdout is only the output path" output contract, the print stylesheet
 * -- 1in margins, flush-left 12pt Helvetica body, running header, "N of M"
 * page numbers, CONFIDENTIAL footer, diagonal watermark -- and the
 * smartypants transform and its preserved-zone rules) comes from `make-pdf`
 * in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY IT WAS REWRITTEN RATHER THAN FORKED LINE FOR LINE
 *
 * Measured on Windows 11, gstack 1.60.1.0, make-pdf dist built 2026-07-10,
 * against $HOME/.claude/skills/gstack/make-pdf/dist/pdf.exe. Every claim
 * below is a command that was run, not a reading of the source.
 *
 * 1. A BOOLEAN FLAG EATS THE FILENAME AFTER IT, AND THE FAILURE IS SILENT.
 *    src/cli.ts parses argv with "if the next token does not start with --,
 *    it is this flag's value" and no arity table. So a boolean flag consumes
 *    the positional that follows it. Two of the four examples printed in
 *    gstack's own make-pdf/SKILL.md do not run:
 *
 *      $ pdf.exe generate --cover --toc essay.md essay.pdf
 *      $P: input file not found: ...\essay.pdf              (exit 2)
 *
 *      $ pdf.exe generate --strict docs.md
 *      $P generate: missing <input.md>                      (exit 1)
 *
 *    The dangerous one exits 0:
 *
 *      $ pdf.exe generate t.md --cover out-cover.pdf
 *      Done in 4.5s. 23 words - C:\Users\orion\AppData\Local\Temp\t.pdf
 *      (exit 0; out-cover.pdf was never written, and there is no cover page)
 *
 *    --cover swallowed the output path, so the flag silently did nothing and
 *    the document went to the temp directory under a name the user never
 *    typed. That is the worst kind of wrong: a success exit, a printed path,
 *    and neither the layout nor the location that was asked for.
 *
 *    Here every flag is declared with an arity in FLAGS. A boolean flag never
 *    consumes a positional, a value flag with a missing value is an error,
 *    and an unknown flag is an error instead of being silently ignored.
 *
 * 2. NOTHING EVER LOOKS AT THE PDF THAT WAS PRODUCED.
 *    src/orchestrator.ts calls fs.statSync(outputPath) to print a KB number
 *    and returns. There is no page count, no font check, no text check. So:
 *
 *      $ printf '' > empty.md
 *      $ pdf.exe generate empty.md empty-out.pdf
 *      Done in 1.0s. 0 words - 1KB - ...\empty-out.pdf      (exit 0)
 *      $ pdftotext empty-out.pdf -                          (no output at all)
 *
 *    757 bytes, zero pages of content, zero extractable text, exit 0, and a
 *    path on stdout that a caller will treat as a delivered document.
 *
 *    Here `generate` refuses an empty document before rendering, and after
 *    rendering it opens the PDF it just wrote and proves four things: the
 *    file is a PDF, the page tree has at least one page, at least one font
 *    program is embedded, and words from the source markdown come back out
 *    of the text layer. Any of those failing is exit 3 with the reason.
 *    Verification runs on every generate; there is no flag to skip it.
 *
 * 3. IT CANNOT RENDER WITHOUT A 100MB BINARY AND A RUNNING DAEMON.
 *    src/browseClient.ts shells out to gstack's `browse` binary for every
 *    step, so make-pdf inherits its whole install: bun to compile it, a
 *    100,749,312-byte dist/pdf.exe, a browse daemon, and a Chromium that
 *    browse manages. If browse is missing the answer is exit 4 and no PDF.
 *    The gate is also stricter than the user's intent: an output path that
 *    is not inside cwd or TEMP is refused by browse's safe-dir allowlist
 *    ("Path must be within: ..."), and a missing parent directory is fatal.
 *
 *    This file is one .mjs with no dependencies. It drives whatever Chromium
 *    is already installed (Chrome, Edge, Brave, Chromium, or a Playwright
 *    download) over CDP on a random loopback port, and it creates the output
 *    directory if it does not exist. The verifier decodes FlateDecode streams
 *    and ToUnicode CMaps with node's built-in zlib, so there is no poppler,
 *    no pdftotext, and no LaTeX anywhere in the chain.
 *
 * WHAT IS KEPT FROM GSTACK, DELIBERATELY
 *
 *   - The print stylesheet. It is good, it was design-reviewed, and the
 *     output looks right. printCss() below is a port of src/print-css.ts.
 *   - smartypants and its preserved-zone rules (code, tags, URLs untouched).
 *   - The output contract: stdout is only the output path, progress on
 *     stderr, --quiet suppresses progress.
 *   - The flag names, so muscle memory and existing docs carry over.
 *
 * WHAT IS NOT PORTED, HONESTLY
 *
 *   - mermaid/excalidraw fence rendering. gstack ships a vendored offline
 *     bundle for it. Fences stay code blocks here and `doctor` says so.
 *   - --to docx. gstack uses the html-to-docx package; this file has no
 *     dependencies, so docx is refused with a message instead of faked.
 *   - Raster downscaling to 300dpi. Images are inlined at their original
 *     size and capped to the content box by CSS, never truncated.
 *
 * COMMANDS
 *
 *   generate <in.md> [out.pdf] [flags]   render, then verify, then print path
 *   verify <file.pdf> [--json]           verify a PDF this or anything wrote
 *   doctor                               what this machine can and cannot do
 *   explain-args <argv...>               how the parser read your command line
 *   selftest                             run the engine against broken input
 *
 * EXIT CODES
 *
 *   0 ok / 1 bad args or bad input / 2 render error / 3 verification failed
 *   / 4 no usable browser found
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const EXIT = { OK: 0, ARGS: 1, RENDER: 2, VERIFY: 3, BROWSER: 4 };

// ------------------------------------------------------------------ argv
//
// The whole point of this table. gstack has no equivalent: it decides a
// flag's arity from what happens to follow it, which is why `--cover a.md`
// makes a.md the value of --cover. Arity is a property of the flag, not of
// the token after it.

const FLAGS = {
  // structure
  cover: "bool",
  toc: "bool",
  "chapter-breaks": "bool",
  "no-chapter-breaks": "bool",
  // branding
  watermark: "str",
  confidential: "bool",
  "no-confidential": "bool",
  "page-numbers": "bool",
  "no-page-numbers": "bool",
  "running-header": "str",
  // layout
  margins: "str",
  "page-size": "str",
  // metadata
  title: "str",
  author: "str",
  date: "str",
  // output
  to: "str",
  strict: "bool",
  "allow-network": "bool",
  quiet: "bool",
  verbose: "bool",
  json: "bool",
  // engine
  browser: "str",
  timeout: "str",
};

class ArgError extends Error {}

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--")) {
      if (tok.startsWith("-") && tok.length > 1) {
        throw new ArgError(`unknown flag: ${tok} (this tool has no short flags)`);
      }
      positional.push(tok);
      continue;
    }
    let key = tok.slice(2);
    let inlineValue = null;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      inlineValue = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const arity = FLAGS[key];
    if (!arity) {
      throw new ArgError(
        `unknown flag: --${key}\n` +
          `known flags: ${Object.keys(FLAGS).map((k) => "--" + k).join(", ")}`,
      );
    }
    if (arity === "bool") {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        throw new ArgError(`--${key} takes no value (got --${key}=${inlineValue})`);
      }
      flags[key] = inlineValue === "false" ? false : true;
      continue;
    }
    // value flag: the value is the NEXT token, and only if it is not a flag.
    if (inlineValue !== null) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new ArgError(`--${key} needs a value (e.g. --${key} <value>)`);
    }
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

/** Booleans that come in on/off pairs, resolved once so the rest reads clean. */
function pairedBool(flags, name, def) {
  if (flags[`no-${name}`] === true) return false;
  if (flags[name] === true) return true;
  return def;
}

// ------------------------------------------------------- browser discovery
//
// fs.accessSync(p, X_OK) is a lie on Windows (it degrades to an existence
// check), and `which` only exists in Git Bash. So: stat for a regular file,
// and walk PATH by hand honoring PATHEXT.

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  const PATH = process.env.PATH ?? process.env.Path ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function newestPlaywrightChromium(root) {
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root).filter((d) => d.startsWith("chromium"));
  } catch {
    return [];
  }
  // Highest build number first: chromium-1228 beats chromium-1208.
  entries.sort((a, b) => (parseInt(b.replace(/\D+/g, ""), 10) || 0) - (parseInt(a.replace(/\D+/g, ""), 10) || 0));
  const out = [];
  for (const e of entries) {
    out.push(
      path.join(root, e, "chrome-win", "chrome.exe"),
      path.join(root, e, "chrome-linux", "chrome"),
      path.join(root, e, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    );
  }
  return out;
}

/** Every path we would try, in order, with why each one is on the list. */
function browserCandidates(explicit) {
  const c = [];
  const add = (p, why) => {
    if (p) c.push({ path: p, why });
  };
  add(explicit, "--browser");
  add(process.env.TB_PDF_BROWSER, "$TB_PDF_BROWSER");
  add(process.env.CHROME_PATH, "$CHROME_PATH");

  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ].filter(Boolean);
    for (const r of roots) {
      add(path.join(r, "Google\\Chrome\\Application\\chrome.exe"), "installed Chrome");
      add(path.join(r, "Microsoft\\Edge\\Application\\msedge.exe"), "installed Edge");
      add(path.join(r, "Chromium\\Application\\chrome.exe"), "installed Chromium");
      add(path.join(r, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), "installed Brave");
    }
    for (const p of newestPlaywrightChromium(path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"))) {
      add(p, "Playwright download");
    }
  } else if (process.platform === "darwin") {
    add("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "installed Chrome");
    add("/Applications/Chromium.app/Contents/MacOS/Chromium", "installed Chromium");
    add("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "installed Edge");
    add("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "installed Brave");
    for (const p of newestPlaywrightChromium(path.join(os.homedir(), "Library/Caches/ms-playwright"))) {
      add(p, "Playwright download");
    }
  } else {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      add(onPath(n), `${n} on PATH`);
    }
    add("/usr/bin/google-chrome", "distro package");
    add("/usr/bin/chromium", "distro package");
    add("/snap/bin/chromium", "snap");
    for (const p of newestPlaywrightChromium(path.join(os.homedir(), ".cache/ms-playwright"))) {
      add(p, "Playwright download");
    }
  }
  if (process.platform === "win32") {
    for (const n of ["chrome", "msedge", "chromium"]) add(onPath(n), `${n} on PATH`);
  }
  return c;
}

function findBrowser(explicit) {
  const cands = browserCandidates(explicit);
  for (const c of cands) {
    if (isFile(c.path)) return c;
  }
  const tried = cands.map((c) => `  - ${c.path}  (${c.why})`).join("\n");
  const err = new Error(
    "no Chromium-family browser found.\n\n" +
      "make-pdf drives a browser you already have. Tried:\n" +
      (tried || "  (nothing: not even a PATH entry)") +
      "\n\nFix: install Chrome or Edge, or point at one:\n" +
      (process.platform === "win32"
        ? '  setx TB_PDF_BROWSER "C:\\path\\to\\chrome.exe"'
        : "  export TB_PDF_BROWSER=/path/to/chrome"),
  );
  err.exitCode = EXIT.BROWSER;
  throw err;
}

// ------------------------------------------------------------- markdown
//
// A small CommonMark subset: headings, paragraphs, fenced and indented code,
// lists (nested), blockquotes, tables, rules, images, links, emphasis. Not a
// full parser and does not pretend to be. What it must never do is silently
// drop content, so anything it does not recognise falls through as a
// paragraph rather than being discarded.

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "section"
  );
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // images before links: ![alt](src) is a link pattern too
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(\{[^}]*\})?/g, (_, alt, src, dir) => {
    const cls = dir && /page=landscape/.test(dir) ? ' class="wide"' : "";
    const style = dir && /width=(\d+%|full)/.test(dir) ? ` style="width:${/width=full/.test(dir) ? "100%" : dir.match(/width=(\d+%)/)[1]}"` : "";
    return `<img src="${src}" alt="${alt}"${cls}${style}>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>');
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];
  const headings = [];
  let i = 0;

  const listStack = []; // {tag, indent}
  const closeLists = (toIndent) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) {
      out.push(`</${listStack.pop().tag}>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^(\s*)(```+|~~~+)\s*(\S*)/);
    if (fence) {
      closeLists(0);
      const marker = fence[2][0].repeat(3);
      const lang = fence[3] || "";
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}\n</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      closeLists(0);
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists(0);
      const level = h[1].length;
      const text = h[2].replace(/\s+#+\s*$/, "");
      const id = slugify(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeLists(0);
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      closeLists(0);
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(body.join("\n")).html}</blockquote>`);
      continue;
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists(0);
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      continue;
    }

    // list item
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        listStack.push({ tag, indent });
        out.push(`<${tag}>`);
      } else {
        while (listStack.length > 1 && listStack[listStack.length - 1].indent > indent) {
          out.push(`</${listStack.pop().tag}>`);
        }
        if (listStack.length && listStack[listStack.length - 1].tag !== tag) {
          out.push(`</${listStack.pop().tag}>`);
          listStack.push({ tag, indent });
          out.push(`<${tag}>`);
        }
      }
      out.push(`<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }

    // paragraph (greedy until blank line or a block starter)
    closeLists(0);
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join("\n"))}</p>`);
    else i++;
  }
  closeLists(0);
  return { html: out.join("\n"), headings };
}

// ------------------------------------------------------------ smartypants
//
// Ported from gstack src/smartypants.ts (Garry Tan, MIT). Same preserved
// zones, same transform order: code/pre/script/style blocks, HTML tags, and
// URLs are carved out before any substitution runs.

const CODE_ZONE_RE = /<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const URL_RE = /\bhttps?:\/\/\S+/g;

function smartypants(html) {
  const preserved = [];
  const carve = (source, pattern) =>
    source.replace(pattern, (m) => {
      preserved.push(m);
      return `\u0000SP${preserved.length - 1}\u0000`;
    });
  let s = html;
  s = carve(s, CODE_ZONE_RE);
  s = carve(s, TAG_RE);
  s = carve(s, URL_RE);
  // The body text reaching this point has been HTML-escaped, so a typed
  // double quote is already &quot; and gstack's `"` rules would never fire on
  // it. Attribute values are safe: TAG_RE carved every tag out above, so the
  // only entities left are in text position. (gstack runs smartypants over
  // marked's output, which leaves text-position quotes as raw characters, so
  // it never had to handle this.)
  s = s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
  s = s.replace(/\.\s?\.\s?\./g, "\u2026");
  s = s.replace(/(\w|\s)--(\w|\s)/g, "$1\u2014$2");
  s = s.replace(/^--\s/gm, "\u2014 ");
  s = s.replace(/\s--$/gm, " \u2014");
  s = s.replace(/(\w)'(\w)/g, "$1\u2019$2");
  s = s.replace(/(^|[\s([{\-])"/g, "$1\u201c");
  s = s.replace(/"/g, "\u201d");
  s = s.replace(/(^|[\s([{\-])'/g, "$1\u2018");
  s = s.replace(/'/g, "\u2019");
  return s.replace(/\u0000SP(\d+)\u0000/g, (_, idx) => preserved[Number(idx)] ?? "");
}

// ------------------------------------------------------------- print CSS
//
// Ported from gstack src/print-css.ts (Garry Tan, MIT), including the design
// decisions recorded in that file's header: Helvetica with Liberation Sans as
// the metric-compatible Linux fallback, flush-left 12pt body with no
// hyphenation (auto-hyphenation puts real "dif-\nferent" breaks into the text
// layer and breaks copy-paste), @page :first suppressing running header and
// footer, and the emoji family group placed before generic sans-serif.

const SANS = `Helvetica, "Liberation Sans", Arial`;
const CJK = `"Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Microsoft YaHei"`;
const EMOJI = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;

function cssEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function printCss(o) {
  const size = o.pageSize ?? "letter";
  const margin = o.margins ?? "1in";
  return `
@page {
  size: ${size};
  margin: ${margin};
${o.runningHeader ? `  @top-center { content: "${cssEscape(o.runningHeader)}"; font-family: ${SANS}, ${EMOJI}, sans-serif; font-size: 9pt; color: #666; }` : ""}
${o.pageNumbers ? `  @bottom-center { content: counter(page) " of " counter(pages); font-family: ${SANS}, sans-serif; font-size: 9pt; color: #666; }` : ""}
${o.confidential ? `  @bottom-right { content: "CONFIDENTIAL"; font-family: ${SANS}, sans-serif; font-size: 8pt; color: #aaa; letter-spacing: 0.05em; }` : ""}
}
@page :first { @top-center { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }
@page wide { size: ${size} landscape; margin: ${margin}; }
.page-wide { page: wide; text-align: center; break-before: page; break-after: page; }
.page-wide img { width: 100%; height: auto; max-width: none; }
html { lang: en; }
img { max-width: 100%; height: auto; }
body {
  font-family: ${SANS}, ${CJK}, ${EMOJI}, sans-serif;
  font-size: 12pt; line-height: 1.5; color: #111; background: white;
  hyphens: manual; font-variant-ligatures: common-ligatures; font-kerning: normal;
  text-rendering: geometricPrecision; margin: 0; padding: 0;
}
${
  o.cover
    ? `.cover { page: first; break-after: page; text-align: left; padding-top: 1.4in; }
.cover .eyebrow { font-size: 11pt; letter-spacing: 0.2em; text-transform: uppercase; color: #666; margin: 0 0 36pt; }
.cover h1.cover-title { font-size: 56pt; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 24pt; max-width: 6in; }
.cover hr.rule { width: 2.5in; height: 0; border: 0; border-top: 1.5px solid #111; margin: 0 0 24pt 0; }
.cover .cover-meta { font-size: 13pt; line-height: 1.6; color: #333; }
.cover .cover-meta strong { font-weight: 700; }`
    : ""
}
${
  o.toc
    ? `.toc { break-after: page; }
.toc h2 { font-size: 16pt; text-transform: uppercase; letter-spacing: 0.15em; color: #444; font-weight: 700; margin: 0 0 0.4in; }
.toc ol { list-style: none; padding: 0; margin: 0; }
.toc li { display: flex; align-items: baseline; font-size: 12pt; line-height: 1.7; padding: 3pt 0; }
.toc li .toc-title { flex: 0 0 auto; }
.toc li .toc-dots { flex: 1 1 auto; border-bottom: 1px dotted #aaa; margin: 0 6pt; transform: translateY(-4pt); }
.toc li.level-2 { padding-left: 0.35in; font-size: 11pt; }
.toc li a { color: inherit; text-decoration: none; }`
    : ""
}
${
  o.chapterBreaks
    ? `.chapter { break-before: page; }
.chapter:first-of-type { break-before: auto; }`
    : ""
}
h1 { font-size: 26pt; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 0.25in; break-after: avoid; }
h2 { font-size: 18pt; line-height: 1.3; font-weight: 700; margin: 26pt 0 8pt; break-after: avoid; }
h3 { font-size: 13.5pt; line-height: 1.4; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #333; margin: 20pt 0 5pt; break-after: avoid; }
h4 { font-size: 12pt; font-weight: 700; margin: 14pt 0 5pt; break-after: avoid; }
p { margin: 0 0 12pt; text-align: left; widows: 3; orphans: 3; }
p:first-child { margin-top: 0; }
a { color: #0055cc; text-decoration: underline; text-decoration-thickness: 0.5pt; text-underline-offset: 1.5pt; }
strong { font-weight: 700; }
em { font-style: italic; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 10.5pt; background: #f4f4f4; padding: 1pt 3pt; border-radius: 2pt; border: 0.5pt solid #e4e4e4; }
pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 10pt; line-height: 1.4; background: #f7f7f5; padding: 10pt 12pt; border: 0.5pt solid #e0e0e0; border-radius: 3pt; margin: 12pt 0; overflow: hidden; white-space: pre-wrap; }
pre code { background: none; border: 0; padding: 0; font-size: inherit; }
blockquote { margin: 12pt 0; padding: 0 0 0 18pt; border-left: 2pt solid #111; color: #333; }
blockquote p { margin-bottom: 6pt; }
figure { margin: 12pt 0; }
figcaption { font-size: 10pt; color: #666; margin-top: 6pt; font-style: italic; }
.image-missing { display: inline-block; border: 1pt dashed #b00020; color: #b00020; padding: 4pt 8pt; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; margin: 12pt 0; font-size: 11pt; }
th, td { border-bottom: 0.5pt solid #ccc; padding: 5pt 8pt; text-align: left; vertical-align: top; }
th { font-weight: 700; border-bottom: 1pt solid #111; }
ul, ol { margin: 0 0 12pt 0; padding-left: 20pt; }
li { margin-bottom: 3pt; line-height: 1.45; }
li > ul, li > ol { margin-top: 3pt; margin-bottom: 0; }
${
  o.watermark
    ? `.watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 140pt; font-weight: 700; color: rgba(200,0,0,0.06); letter-spacing: 0.08em; pointer-events: none; z-index: 9999; white-space: nowrap; }`
    : ""
}
blockquote, pre, table, figure, li { break-inside: avoid; }
@media screen { body { max-width: 42em; margin: 0 auto; padding: 2.5em 1.5em; } .chapter { break-before: auto; } .watermark { display: none; } }
`.trim();
}

// ---------------------------------------------------------------- images

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function inlineImages(html, { inputDir, strict, allowNetwork, warn }) {
  const problems = [];
  const out = html.replace(/<img src="([^"]+)"([^>]*)>/g, (whole, src, rest) => {
    const alt = (rest.match(/alt="([^"]*)"/) || [, ""])[1];
    const bad = (why) => {
      problems.push(`${why}: ${src}`);
      warn(`${why}: ${src}`);
      return `<span class="image-missing">[${escapeHtml(why)}: ${escapeHtml(alt || src)}]</span>`;
    };
    if (/^data:/i.test(src)) return whole;
    if (/^https?:/i.test(src)) {
      if (allowNetwork) return whole;
      return bad("remote image blocked (pass --allow-network)");
    }
    const decoded = decodeURIComponent(src);
    const abs = path.resolve(inputDir, decoded);
    if (!abs.startsWith(path.resolve(inputDir) + path.sep) && path.dirname(abs) !== path.resolve(inputDir)) {
      problems.push(`image resolves outside the document directory: ${src}`);
      warn(`image resolves outside the document directory: ${src}`);
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return bad("image not found");
    }
    if (!st.isFile()) return bad("image is not a regular file");
    if (st.size > MAX_IMAGE_BYTES) return bad("image over 64MB");
    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) return bad("unsupported image type");
    const b64 = fs.readFileSync(abs).toString("base64");
    return `<img src="data:${mime};base64,${b64}"${rest}>`;
  });
  if (strict && problems.length) {
    const e = new Error(`--strict: ${problems.length} image problem(s):\n  ` + problems.join("\n  "));
    e.exitCode = EXIT.ARGS;
    throw e;
  }
  return out;
}

// ------------------------------------------------------------- document

function buildDocument(md, opts) {
  const { html: body, headings } = mdToHtml(md);
  const title = opts.title ?? (headings.find((h) => h.level === 1)?.text ?? "Document");
  const parts = [];

  if (opts.cover) {
    parts.push(
      `<section class="cover">`,
      opts.author ? `<p class="eyebrow">${inline(opts.author)}</p>` : "",
      `<h1 class="cover-title">${inline(title)}</h1>`,
      `<hr class="rule">`,
      `<div class="cover-meta">${opts.author ? `<strong>${inline(opts.author)}</strong><br>` : ""}${escapeHtml(opts.date ?? new Date().toISOString().slice(0, 10))}</div>`,
      `</section>`,
    );
  }
  if (opts.toc) {
    const items = headings
      .filter((h) => h.level <= 2)
      .map((h) => `<li class="level-${h.level}"><a href="#${h.id}"><span class="toc-title">${inline(h.text)}</span></a><span class="toc-dots"></span></li>`)
      .join("\n");
    parts.push(`<nav class="toc"><h2>Contents</h2><ol>${items}</ol></nav>`);
  }
  if (opts.watermark) parts.push(`<div class="watermark">${escapeHtml(opts.watermark)}</div>`);

  // Chapter wrapping: each H1 starts a new page unless disabled.
  let main = body;
  if (opts.chapterBreaks) {
    const chunks = body.split(/(?=<h1 )/);
    main = chunks.map((c) => (c.trim().startsWith("<h1 ") ? `<section class="chapter">${c}</section>` : c)).join("\n");
  }
  parts.push(`<main>${main}</main>`);

  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>` +
    `<meta name="author" content="${escapeHtml(opts.author ?? "")}">` +
    `<style>\n${printCss(opts)}\n</style></head><body>\n` +
    smartypants(parts.filter(Boolean).join("\n")) +
    `\n</body></html>\n`;
  return { html, title, headings };
}

// --------------------------------------------------------------- CDP/print

function cdpUnavailable() {
  const e = new Error(
    `this node build has no global WebSocket (node ${process.version}).\n` +
      `make-pdf drives the browser over CDP, which needs node 22 or newer.\n` +
      `Fix: run this with a newer node. Refusing to pretend a PDF was produced.`,
  );
  e.exitCode = EXIT.RENDER;
  return e;
}

function waitFor(ms, what) {
  return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`timed out after ${ms}ms waiting for ${what}`), { exitCode: EXIT.RENDER })), ms));
}

async function renderPdf({ htmlPath, browser, allowNetwork, timeoutMs, log }) {
  if (typeof WebSocket === "undefined") throw cdpUnavailable();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pdf-profile-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  if (!allowNetwork) args.splice(1, 0, "--host-resolver-rules=MAP * ~NOTFOUND");

  log(`launching ${browser}`);
  const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  const cleanup = () => {
    try {
      child.kill();
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {}
  };

  try {
    const wsUrl = await Promise.race([
      new Promise((resolve, reject) => {
        child.on("error", (e) => reject(Object.assign(new Error(`could not launch ${browser}: ${e.message}`), { exitCode: EXIT.BROWSER })));
        child.on("exit", (code) => reject(Object.assign(new Error(`browser exited (${code}) before listening. stderr:\n${stderrBuf.slice(-800)}`), { exitCode: EXIT.RENDER })));
        child.stderr.on("data", (d) => {
          stderrBuf += d.toString();
          const m = stderrBuf.match(/ws:\/\/[^\s"]+/);
          if (m) resolve(m[0]);
        });
      }),
      waitFor(timeoutMs, "the browser's devtools endpoint"),
    ]);

    log(`devtools at ${wsUrl}`);
    const cdp = await connect(wsUrl, timeoutMs);
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method, params) => cdp.send(method, params, sessionId);
      await s("Page.enable");
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      await s("Page.navigate", { url: pathToFileURL(htmlPath).href });
      await Promise.race([loaded, waitFor(timeoutMs, "the page load event")]);
      await s("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true }).catch(() => {});
      const printParams = {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        transferMode: "ReturnAsBase64",
        generateTaggedPDF: true,
        generateDocumentOutline: true,
      };
      let res;
      try {
        res = await Promise.race([s("Page.printToPDF", printParams), waitFor(timeoutMs, "Page.printToPDF")]);
      } catch (e) {
        // Older Chromium rejects generateTaggedPDF / generateDocumentOutline.
        log(`printToPDF retry without tagging: ${e.message}`);
        delete printParams.generateTaggedPDF;
        delete printParams.generateDocumentOutline;
        res = await Promise.race([s("Page.printToPDF", printParams), waitFor(timeoutMs, "Page.printToPDF")]);
      }
      if (!res?.data) throw Object.assign(new Error("printToPDF returned no data"), { exitCode: EXIT.RENDER });
      return Buffer.from(res.data, "base64");
    } finally {
      try {
        await cdp.send("Browser.close");
      } catch {}
      cdp.close();
    }
  } finally {
    cleanup();
  }
}

async function connect(wsUrl, timeoutMs) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const waiters = [];
  let nextId = 1;
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(`${msg.error.message} (CDP ${msg.error.code})`), { exitCode: EXIT.RENDER }));
      else resolve(msg.result);
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
        waiters.splice(i, 1);
        w.resolve(msg.params);
      }
    }
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(Object.assign(new Error("devtools websocket refused the connection"), { exitCode: EXIT.RENDER })), { once: true });
    }),
    waitFor(timeoutMs, "the devtools websocket"),
  ]);
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
      });
    },
    once(method, sessionId) {
      return new Promise((resolve) => waiters.push({ method, sessionId, resolve }));
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

// ------------------------------------------------------------- PDF verify
//
// The part gstack does not have. No poppler, no pdftotext: node's zlib
// inflates the streams, and the ToUnicode CMap turns Chrome's Identity-H
// glyph ids back into the characters a human would copy out of the page.

function pdfObjects(buf) {
  const raw = buf.toString("latin1");
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = raw.indexOf("endobj", start);
    if (end === -1) continue;
    const body = raw.slice(start, end);
    const sIdx = body.search(/\bstream\r?\n/);
    let dict = body;
    let stream = null;
    if (sIdx !== -1) {
      dict = body.slice(0, sIdx);
      const after = body.slice(sIdx).match(/\bstream\r?\n/);
      const dataStart = start + sIdx + after[0].length;
      const dataEnd = raw.indexOf("endstream", dataStart);
      if (dataEnd !== -1) stream = buf.subarray(dataStart, dataEnd);
    }
    objs.set(num, { dict, stream });
  }
  return objs;
}

function inflate(objs, num) {
  const o = objs.get(num);
  if (!o?.stream) return null;
  if (!/FlateDecode/.test(o.dict)) return Buffer.from(o.stream);
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(o.stream);
    } catch {}
  }
  return null;
}

function parseToUnicode(text) {
  const map = new Map();
  const hex = (h) => {
    const s = [];
    for (let i = 0; i + 3 < h.length + 1; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (!Number.isNaN(code)) s.push(code);
    }
    return String.fromCharCode(...s);
  };
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) ?? []) {
      const m = pair.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      map.set(parseInt(m[1], 16), hex(m[2]));
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let m;
    while ((m = re.exec(block))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else {
        const items = m[4].match(/<([0-9A-Fa-f]+)>/g) ?? [];
        items.forEach((it, k) => map.set(lo + k, hex(it.replace(/[<>]/g, ""))));
      }
    }
  }
  return map;
}

/** Ordered page objects, walked through the page tree so text comes out in reading order. */
function pageOrder(objs) {
  const refs = (s) => [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  let root = null;
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Pages/.test(o.dict) && !/\/Parent/.test(o.dict)) root = num;
  }
  const pages = [];
  const seen = new Set();
  const walk = (num) => {
    if (seen.has(num)) return;
    seen.add(num);
    const o = objs.get(num);
    if (!o) return;
    if (/\/Type\s*\/Page(?![sA-Za-z])/.test(o.dict)) {
      pages.push(num);
      return;
    }
    const kids = o.dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
    if (kids) for (const k of refs(kids[1])) walk(k);
  };
  if (root !== null) walk(root);
  if (!pages.length) {
    for (const [num, o] of objs) if (/\/Type\s*\/Page(?![sA-Za-z])/.test(o.dict)) pages.push(num);
  }
  return pages;
}

function extractText(objs, pages) {
  let text = "";
  let showOps = 0;
  for (const pnum of pages) {
    const page = objs.get(pnum);
    if (!page) continue;
    // fonts for this page: /Font << /F1 12 0 R >> possibly behind a /Resources ref
    let resDict = page.dict;
    const resRef = page.dict.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (resRef) resDict = objs.get(Number(resRef[1]))?.dict ?? resDict;
    const fontBlock = resDict.match(/\/Font\s*<<([\s\S]*?)>>/);
    const fonts = new Map();
    if (fontBlock) {
      for (const m of fontBlock[1].matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
        const fobj = objs.get(Number(m[2]));
        if (!fobj) continue;
        const tu = fobj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
        const wide = /\/Identity/.test(fobj.dict) || /\/Type0/.test(fobj.dict);
        const cmap = tu ? parseToUnicode(inflate(objs, Number(tu[1]))?.toString("latin1") ?? "") : new Map();
        fonts.set(m[1], { cmap, wide });
      }
    }
    const contentRefs = [];
    const cm = page.dict.match(/\/Contents\s+(?:(\d+)\s+\d+\s+R|\[([\s\S]*?)\])/);
    if (cm) {
      if (cm[1]) contentRefs.push(Number(cm[1]));
      else for (const r of cm[2].matchAll(/(\d+)\s+\d+\s+R/g)) contentRefs.push(Number(r[1]));
    }
    for (const cref of contentRefs) {
      const content = inflate(objs, cref)?.toString("latin1");
      if (!content) continue;
      let font = null;
      const tokens = content.match(/\/\w+\s+[\d.]+\s+Tf|<[0-9A-Fa-f\s]*>\s*Tj|\([^)]*\)\s*Tj|\[[\s\S]*?\]\s*TJ|\bT\*|\bET\b/g) ?? [];
      for (const t of tokens) {
        const tf = t.match(/^\/(\w+)\s/);
        if (tf && /Tf$/.test(t)) {
          font = fonts.get(tf[1]) ?? null;
          continue;
        }
        // Only end-of-text-object and explicit next-line count as a break.
        // Td/TD are also how Chromium positions each glyph of a letter-spaced
        // heading, so treating them as separators produces "T e s t D o c".
        if (/^(T\*|ET)$/.test(t)) {
          if (!text.endsWith(" ") && !text.endsWith("\n")) text += " ";
          continue;
        }
        const decodeHex = (h) => {
          const clean = h.replace(/[^0-9A-Fa-f]/g, "");
          let out = "";
          const step = font?.wide === false ? 2 : 4;
          for (let i = 0; i + step <= clean.length; i += step) {
            const code = parseInt(clean.slice(i, i + step), 16);
            out += font?.cmap.get(code) ?? "";
          }
          return out;
        };
        if (/Tj$/.test(t) && t.trim().startsWith("<")) {
          showOps++;
          text += decodeHex(t.slice(t.indexOf("<") + 1, t.lastIndexOf(">")));
        } else if (/Tj$/.test(t)) {
          showOps++;
          text += t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"));
        } else if (/TJ$/.test(t)) {
          showOps++;
          for (const part of t.match(/<[0-9A-Fa-f\s]*>|\([^)]*\)|-?[\d.]+/g) ?? []) {
            if (part.startsWith("<")) text += decodeHex(part);
            else if (part.startsWith("(")) text += part.slice(1, -1);
            // No space-from-kerning heuristic here on purpose. Chromium emits
            // real space glyphs between words and uses TJ adjustments for
            // per-glyph kerning, so treating a negative adjustment as a space
            // turns a letter-spaced heading into "T e s t D o c".
          }
        }
      }
      text += "\n";
    }
  }
  return { text, showOps };
}

function inspectPdf(buf) {
  const issues = [];
  const raw = buf.toString("latin1");
  if (!raw.startsWith("%PDF-")) issues.push("file does not start with %PDF-");
  if (!raw.slice(-2048).includes("%%EOF")) issues.push("file has no %%EOF trailer (truncated?)");
  const objs = pdfObjects(buf);
  const pages = pageOrder(objs);
  const fontFiles = (raw.match(/\/FontFile[23]?\b/g) ?? []).length;
  let text = "";
  let showOps = 0;
  if (pages.length) {
    try {
      const r = extractText(objs, pages);
      text = r.text;
      showOps = r.showOps;
    } catch (e) {
      issues.push(`text layer could not be decoded: ${e.message}`);
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const alnum = normalized.replace(/[^A-Za-z0-9]/g, "");
  if (!pages.length) issues.push("page tree contains zero pages");
  if (!fontFiles) issues.push("no embedded font program (/FontFile*) - text will reflow on other machines");
  if (showOps > 20 && alnum.length / showOps < 1.2) {
    issues.push(`text is fragmented (${alnum.length} chars over ${showOps} show operations) - copy-paste will produce "S a i l i n g"`);
  }
  return {
    bytes: buf.length,
    pages: pages.length,
    embeddedFonts: fontFiles,
    textChars: alnum.length,
    showOps,
    text: normalized,
    issues,
    ok: issues.length === 0,
  };
}

// ----------------------------------------------------------------- source

function sourceWords(md) {
  const stripped = md.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return stripped.match(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g) ?? [];
}

/**
 * A CONTIGUOUS run of source characters that must survive the round trip.
 *
 * Contiguity is the whole trick. An earlier version stitched together the
 * first six words of three or more letters, which skipped "is" and "a" and
 * so could never match the real text layer. Here the line is reduced to
 * letters and digits and a prefix of that is taken, so smartypants, curly
 * quotes, em dashes, hyphenation and line wrapping all fall out on both
 * sides of the comparison.
 *
 * Lines carrying a markdown link are skipped: the URL is in the source but
 * not in the printed text.
 */
const PROBE_LEN = 24;

function probePhrase(md) {
  const lines = md.replace(/```[\s\S]*?```/g, "").split(/\n/);
  let best = "";
  for (const line of lines) {
    if (line.includes("](") || line.includes("<")) continue;
    const flat = line
      .replace(/^#+\s*/, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase();
    if (flat.length >= PROBE_LEN) return flat.slice(0, PROBE_LEN);
    if (flat.length > best.length) best = flat;
  }
  return best;
}

// ---------------------------------------------------------------- commands

function readInput(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw Object.assign(new Error(`input file not found: ${p}`), { exitCode: EXIT.ARGS });
  }
  if (st.isDirectory()) throw Object.assign(new Error(`input is a directory, not a markdown file: ${p}`), { exitCode: EXIT.ARGS });
  return fs.readFileSync(p, "utf8");
}

async function cmdGenerate(argv) {
  const { positional, flags } = parseArgv(argv);
  if (positional.length === 0) throw new ArgError("generate: missing <input.md>\nUsage: generate <input.md> [output.pdf] [flags]");
  if (positional.length > 2) throw new ArgError(`generate: too many paths (${positional.join(", ")}). Expected <input.md> [output.pdf]`);

  const quiet = flags.quiet === true;
  const verbose = flags.verbose === true;
  const progress = (m) => {
    if (!quiet) process.stderr.write(`${m}\n`);
  };
  const log = (m) => {
    if (verbose && !quiet) process.stderr.write(`  [tb-pdf] ${m}\n`);
  };
  const warn = (m) => process.stderr.write(`[tb-pdf] warning: ${m}\n`);

  const to = (flags.to ?? "pdf").toLowerCase();
  if (to === "docx") {
    throw Object.assign(
      new Error("--to docx is not implemented here. gstack's make-pdf does it with the html-to-docx package;\nthis engine has no dependencies, so it refuses rather than writing something that is not a .docx."),
      { exitCode: EXIT.ARGS },
    );
  }
  if (to !== "pdf" && to !== "html") throw new ArgError(`--to must be pdf or html (got ${to})`);

  const input = path.resolve(positional[0]);
  const md = readInput(input);

  // Fail closed on an empty document. gstack renders a 757-byte PDF with no
  // text and exits 0; a caller cannot tell that from a delivered document.
  const words = sourceWords(md);
  if (words.length === 0) {
    throw Object.assign(new Error(`refusing to render an empty document: ${input} has no words.\n(gstack exits 0 here and writes a blank PDF. That is the bug this check exists for.)`), {
      exitCode: EXIT.ARGS,
    });
  }

  const base = path.basename(input).replace(/\.[^.]+$/, "") || "document";
  const output = path.resolve(positional[1] ?? path.join(process.cwd(), `${base}.${to}`));
  if (fs.existsSync(output) && fs.statSync(output).isDirectory()) {
    throw Object.assign(new Error(`output path is a directory: ${output}`), { exitCode: EXIT.ARGS });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const opts = {
    title: flags.title,
    author: flags.author,
    date: flags.date,
    cover: flags.cover === true,
    toc: flags.toc === true,
    chapterBreaks: pairedBool(flags, "chapter-breaks", true),
    confidential: pairedBool(flags, "confidential", true),
    pageNumbers: pairedBool(flags, "page-numbers", true),
    watermark: flags.watermark,
    margins: flags.margins,
    pageSize: flags["page-size"],
    runningHeader: flags["running-header"],
  };

  progress(`Rendering ${words.length} words from ${path.basename(input)}`);
  let doc = buildDocument(md, opts);
  let html = inlineImages(doc.html, {
    inputDir: path.dirname(input),
    strict: flags.strict === true,
    allowNetwork: flags["allow-network"] === true,
    warn,
  });

  if (to === "html") {
    fs.writeFileSync(output, html, "utf8");
    const probe = probePhrase(md);
    const flat = html
      .replace(/<[^>]+>/g, " ")
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase();
    if (probe && !flat.includes(probe)) {
      throw Object.assign(new Error(`verification failed: the HTML does not contain the opening words of the source ("${probe}")`), { exitCode: EXIT.VERIFY });
    }
    progress(`Verified: ${Math.round(fs.statSync(output).size / 1024)}KB, self-contained, source text present`);
    process.stdout.write(output + "\n");
    return;
  }

  const browser = findBrowser(flags.browser);
  log(`browser: ${browser.path} (${browser.why})`);
  const htmlTmp = path.join(os.tmpdir(), `tb-pdf-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(htmlTmp, html, "utf8");
  let buf;
  try {
    progress("Printing with Chromium");
    buf = await renderPdf({
      htmlPath: htmlTmp,
      browser: browser.path,
      allowNetwork: flags["allow-network"] === true,
      timeoutMs: Number(flags.timeout ?? 60000) || 60000,
      log,
    });
  } finally {
    try {
      fs.unlinkSync(htmlTmp);
    } catch {}
  }

  fs.writeFileSync(output, buf);

  // ---- verification. Always. There is no flag to turn this off.
  const report = inspectPdf(buf);
  const probe = probePhrase(md);
  const flat = report.text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (probe && !flat.includes(probe)) {
    report.ok = false;
    report.issues.push(`the source's opening words ("${probe}") are not in the PDF text layer`);
  }
  if (!report.ok) {
    const e = new Error(
      `the PDF was written to ${output} but it does not verify:\n  - ` +
        report.issues.join("\n  - ") +
        `\n(pages ${report.pages}, embedded fonts ${report.embeddedFonts}, text chars ${report.textChars})`,
    );
    e.exitCode = EXIT.VERIFY;
    throw e;
  }
  progress(
    `Verified: ${report.pages} page(s), ${report.embeddedFonts} embedded font program(s), ` +
      `${report.textChars} extractable characters, ${Math.round(report.bytes / 1024)}KB`,
  );
  process.stdout.write(output + "\n");
}

function cmdVerify(argv) {
  const { positional, flags } = parseArgv(argv);
  if (positional.length !== 1) throw new ArgError("verify: expected exactly one <file.pdf>");
  const p = path.resolve(positional[0]);
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw Object.assign(new Error(`not readable: ${p}`), { exitCode: EXIT.ARGS });
  }
  const report = inspectPdf(buf);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ file: p, ...report, text: report.text.slice(0, 400) }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `${p}\n` +
        `  bytes            ${report.bytes}\n` +
        `  pages            ${report.pages}\n` +
        `  embedded fonts   ${report.embeddedFonts}\n` +
        `  extractable text ${report.textChars} chars over ${report.showOps} show ops\n` +
        `  first words      ${report.text.slice(0, 80)}\n`,
    );
    for (const i of report.issues) process.stdout.write(`  PROBLEM          ${i}\n`);
  }
  if (!report.ok) {
    const e = new Error(`${report.issues.length} problem(s)`);
    e.exitCode = EXIT.VERIFY;
    e.quiet = true;
    throw e;
  }
}

function cmdDoctor() {
  const out = [];
  out.push(`  tb-pdf doctor  (node ${process.version}, ${process.platform})\n`);
  let browserOk = false;
  try {
    const b = findBrowser(process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser") + 1] : undefined);
    out.push(`  OK    browser        ${b.path}`);
    out.push(`                       found via ${b.why}`);
    browserOk = true;
  } catch (e) {
    out.push(`  FAIL  browser        ${e.message.split("\n")[0]}`);
  }
  const wsOk = typeof WebSocket !== "undefined";
  out.push(`  ${wsOk ? "OK  " : "FAIL"}  CDP transport   ${wsOk ? "global WebSocket present" : `node ${process.version} has no global WebSocket (need node 22+)`}`);
  out.push(`  OK    verifier        zlib built in - no poppler, no pdftotext, no LaTeX needed`);
  out.push(`  NOTE  diagrams        mermaid/excalidraw fences stay code blocks (not ported from gstack)`);
  out.push(`  NOTE  docx            --to docx is refused, not faked (no dependencies here)`);
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  if (!browserOk || !wsOk) {
    const e = new Error("doctor found a blocker");
    e.exitCode = browserOk ? EXIT.RENDER : EXIT.BROWSER;
    e.quiet = true;
    throw e;
  }
}

function cmdExplainArgs(argv) {
  const parsed = parseArgv(argv);
  process.stdout.write(JSON.stringify(parsed) + "\n");
}

// ---------------------------------------------------------------- selftest

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", timeout: 120000, ...opts });
  return { status: res.status, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim() };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-pdf-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") => results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const doc = path.join(tmp, "memo.md");
  fs.writeFileSync(
    doc,
    [
      "# Quarterly Memo",
      "",
      'Toolbay Stack renders this memo without a daemon. It has "curly quotes" and -- an em dash.',
      "",
      "## Numbers",
      "",
      "- first item",
      "- second item",
      "",
      "```js",
      "const x = 1; // this must not become an em dash: --",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );

  // ---- 1. the gstack argv bug, asserted directly on the parser
  const parse = (args) => {
    const r = run(["explain-args", ...args]);
    try {
      return { ...JSON.parse(r.stdout), status: r.status };
    } catch {
      return { status: r.status, positional: [], flags: {} };
    }
  };
  const a = parse(["--cover", "--toc", "essay.md", "essay.pdf"]);
  check("a boolean flag does not eat the input path (gstack: it does)", "essay.md", a.positional[0] ?? "(nothing)", "gstack reads essay.md as the value of --toc");
  check("...and does not eat the output path either", "essay.pdf", a.positional[1] ?? "(nothing)");
  check("...and both booleans are still true", "true,true", `${a.flags.cover},${a.flags.toc}`);
  const b = parse(["memo.md", "--cover", "out.pdf"]);
  check("a flag after the input path does not steal the output path", "out.pdf", b.positional[1] ?? "(nothing)", "gstack exits 0 here and writes to TEMP instead");
  const c = parse(["--margins", "0.75in", "memo.md"]);
  check("a value flag still takes its value", "0.75in", c.flags.margins ?? "(nothing)");
  check("...without swallowing the path after it", "memo.md", c.positional[0] ?? "(nothing)");

  // ---- 2. bad command lines fail closed
  check("unknown flag is rejected", EXIT.ARGS, run(["generate", "--colour", doc]).status, "gstack silently ignores unknown flags");
  check("value flag with no value is rejected", EXIT.ARGS, run(["generate", doc, "--margins"]).status);
  check("value flag followed by another flag is rejected", EXIT.ARGS, run(["generate", "--margins", "--cover", doc]).status);
  check("three positionals is rejected", EXIT.ARGS, run(["generate", doc, "a.pdf", "b.pdf"]).status);
  check("missing input file is rejected", EXIT.ARGS, run(["generate", path.join(tmp, "nope.md")]).status);
  check("a directory as input is rejected", EXIT.ARGS, run(["generate", tmp]).status);
  check("--to docx is refused rather than faked", EXIT.ARGS, run(["generate", doc, path.join(tmp, "o.docx"), "--to", "docx"]).status);

  // ---- 3. empty and whitespace-only documents fail closed
  const emptyMd = path.join(tmp, "empty.md");
  fs.writeFileSync(emptyMd, "", "utf8");
  const emptyOut = path.join(tmp, "empty.pdf");
  check("empty markdown is refused (gstack exits 0 with a blank PDF)", EXIT.ARGS, run(["generate", emptyMd, emptyOut]).status);
  check("...and no file is left behind", "false", String(fs.existsSync(emptyOut)));
  const wsMd = path.join(tmp, "ws.md");
  fs.writeFileSync(wsMd, "\n\n   \n\t\n", "utf8");
  check("whitespace-only markdown is refused", EXIT.ARGS, run(["generate", wsMd, path.join(tmp, "ws.pdf")]).status);

  // ---- 4. the verifier catches deliberately broken PDFs
  const notPdf = path.join(tmp, "not-really.pdf");
  fs.writeFileSync(notPdf, "this is a text file wearing a .pdf extension\n", "utf8");
  check("a text file named .pdf fails verification", EXIT.VERIFY, run(["verify", notPdf]).status);
  check("a missing file fails verification", EXIT.ARGS, run(["verify", path.join(tmp, "ghost.pdf")]).status);

  // ---- 5. a real render, then the real verifier on it
  const outPdf = path.join(tmp, "deep", "sub dir", "memo out.pdf");
  const gen = run(["generate", doc, outPdf, "--cover", "--toc", "--author", "Toolbay"]);
  check("generate exits 0 on a real document", EXIT.OK, gen.status, gen.stderr.slice(-300));
  check("...into a directory that did not exist (gstack: exit 4)", "true", String(fs.existsSync(outPdf)));
  check("...and stdout is exactly the output path", outPdf, gen.stdout);
  let report = { pages: 0, embeddedFonts: 0, textChars: 0, text: "" };
  if (fs.existsSync(outPdf)) report = inspectPdf(fs.readFileSync(outPdf));
  check("the PDF has a cover page plus content", "true", String(report.pages >= 2), `pages=${report.pages}`);
  check("the PDF embeds its fonts", "true", String(report.embeddedFonts > 0), `fontfiles=${report.embeddedFonts}`);
  check("the source text survives into the PDF text layer", "true", String(report.text.replace(/[^A-Za-z0-9]/g, "").toLowerCase().includes("toolbaystackrendersthismemo")), report.text.slice(0, 90));
  check("copy-paste is not fragmented per glyph", "true", String(!report.issues?.some((i) => i.startsWith("text is fragmented"))));
  check("smartypants ran (curly quotes in the text layer)", "true", String(/[\u201c\u201d]/.test(report.text)), report.text.slice(0, 120));
  check("smartypants left the code block alone", "true", String(report.text.includes("--") || report.text.includes("em dash: --")), "the `--` inside ```js must stay two hyphens");
  check("verify exits 0 on that same PDF", EXIT.OK, run(["verify", outPdf]).status);

  // ---- 6. truncating that real PDF must be caught
  if (fs.existsSync(outPdf)) {
    const truncated = path.join(tmp, "truncated.pdf");
    const full = fs.readFileSync(outPdf);
    fs.writeFileSync(truncated, full.subarray(0, Math.floor(full.length * 0.6)));
    check("a truncated PDF fails verification", EXIT.VERIFY, run(["verify", truncated]).status);
  } else {
    check("a truncated PDF fails verification", EXIT.VERIFY, "skipped (no PDF)");
  }

  // ---- 7. image policy
  const imgMd = path.join(tmp, "img.md");
  fs.writeFileSync(imgMd, "# Report\n\nThe chart below explains the quarter.\n\n![chart](missing-chart.png)\n", "utf8");
  check("a missing image is fatal under --strict", EXIT.ARGS, run(["generate", imgMd, path.join(tmp, "img.pdf"), "--strict"]).status);
  const remoteMd = path.join(tmp, "remote.md");
  fs.writeFileSync(remoteMd, "# Report\n\nThe remote chart is blocked by default.\n\n![chart](https://example.com/c.png)\n", "utf8");
  check("a remote image is fatal under --strict", EXIT.ARGS, run(["generate", remoteMd, path.join(tmp, "r.pdf"), "--strict"]).status);
  const htmlOut = path.join(tmp, "remote.html");
  const rh = run(["generate", remoteMd, htmlOut, "--to", "html"]);
  check("without --strict the remote image becomes a visible placeholder", EXIT.OK, rh.status, rh.stderr.slice(-200));
  const htmlText = fs.existsSync(htmlOut) ? fs.readFileSync(htmlOut, "utf8") : "";
  check("...and the exported HTML has no remote reference left", "false", String(/https:\/\/example\.com/.test(htmlText)));

  // ---- 8. the machine can actually do this
  check("doctor exits 0 on a machine that can render", EXIT.OK, run(["doctor"]).status);

  const EXPECTED = 35;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {}

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-pdf selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  This engine is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken input above was refused, and the one real render\n");
  process.stdout.write("  was proved page by page: pages, embedded fonts, and the source text read\n");
  process.stdout.write("  back out of the PDF. No poppler, no daemon, no bundled binary.\n\n");
}

// -------------------------------------------------------------------- main

function usage() {
  return [
    "tb-pdf - markdown to a PDF you can prove is a document",
    "",
    "  generate <in.md> [out.pdf] [flags]   render, verify, print the path",
    "  verify <file.pdf> [--json]           check any PDF: pages, fonts, text",
    "  doctor                               what this machine can do",
    "  explain-args <argv...>               how the parser read your flags",
    "  selftest                             run against deliberately broken input",
    "",
    "Structure:  --cover  --toc  --no-chapter-breaks",
    "Branding:   --watermark <text>  --no-confidential  --no-page-numbers  --running-header <text>",
    "Layout:     --margins <1in|72pt|2.54cm>  --page-size <letter|a4|legal>",
    "Metadata:   --title <t>  --author <a>  --date <d>",
    "Output:     --to <pdf|html>  --strict  --allow-network  --quiet  --verbose",
    "Engine:     --browser <path to chrome>  --timeout <ms>",
    "",
    "stdout is only the output path. Progress and warnings go to stderr.",
    "exit 0 ok / 1 bad args / 2 render error / 3 verification failed / 4 no browser",
  ].join("\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "generate":
        await cmdGenerate(rest);
        break;
      case "verify":
        cmdVerify(rest);
        break;
      case "doctor":
        cmdDoctor();
        break;
      case "explain-args":
        cmdExplainArgs(rest);
        break;
      case "selftest":
        selftest();
        break;
      case undefined:
      case "--help":
      case "help":
        process.stdout.write(usage() + "\n");
        break;
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${usage()}\n`);
        process.exitCode = EXIT.ARGS;
    }
  } catch (e) {
    if (!e.quiet) process.stderr.write(`tb-pdf: ${e.message}\n`);
    process.exitCode = e instanceof ArgError ? EXIT.ARGS : (e.exitCode ?? EXIT.RENDER);
  }
}

main();
