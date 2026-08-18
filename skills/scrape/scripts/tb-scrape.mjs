#!/usr/bin/env node
/**
 * tb-scrape.mjs: the Toolbay Stack extraction engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /scrape, the read-only-by-contract rule, the refuse-mutating-intents rule,
 * the match-path / prototype-path split, the "one JSON document on stdout so
 * callers can pipe to jq" output discipline, and the skillify nudge) comes
 * from `scrape` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * gstack's scrape is 949 lines of SKILL.md and zero executable code. Measured
 * on Windows 11 against gstack 1.60.1.0, 2026-08-13:
 *
 *   PS> Get-ChildItem -Recurse ~\.claude\skills\gstack\scrape | select Name,Length
 *   SKILL.md        52928
 *   SKILL.md.tmpl    5220
 *
 * That is the whole skill. Extraction is a paragraph of prose telling the model
 * to run `$B html`, look at it, and "emit the result as JSON on stdout ...
 * typically { "items": [...], "count": N }". The JSON is therefore *narrated*,
 * not computed. Nothing on disk can tell the difference between:
 *
 *   - six rows read off the page,
 *   - six rows the model remembered from the last page,
 *   - zero rows, reported as `{"items":[],"count":0}` and called a clean scrape,
 *   - a Cloudflare interstitial, which is a perfectly valid HTML page that
 *     parses fine and contains no products.
 *
 * Every one of those reads as success. That is failing OPEN, and it is the same
 * failure direction the rest of this stack exists to remove.
 *
 * The 949 lines are also not free on Windows. The "Preamble (run first)" block
 * is POSIX shell and the skill says to run it first, every time. Three of its
 * lines, run verbatim in PowerShell on this machine:
 *
 *   PS> _TEL_START=$(date +%s)
 *   The term '_TEL_START=$(date +%s)' is not recognized as the name of a cmdlet
 *
 *   PS> open https://garryslist.org/posts/boil-the-ocean
 *   The term 'open' is not recognized as the name of a cmdlet
 *
 *   PS> source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
 *   The '<' operator is reserved for future use.
 *   The token '||' is not a valid statement separator in this version.
 *
 * plus `touch ~/.gstack/sessions/"$PPID"` (PPID is a bash variable; empty
 * elsewhere, so the touch targets the directory itself) and `find -mmin`
 * (GNU find only). None of that is scraping. All of it is between the user and
 * the data.
 *
 * DESIGN RULES HERE
 *
 *   1. EXTRACTION IS COMPUTED, NOT NARRATED. A deterministic HTML parser and
 *      CSS selector engine produce the rows. The model chooses selectors; it
 *      does not author results.
 *   2. FAIL CLOSED. Twelve checks run on every extraction. A run that cannot
 *      reach a confident "these rows came off this page" exits non-zero and
 *      writes NO artifact, so there is never a file that looks like a result
 *      and is not one. Each `--allow-*` flag relaxes exactly one named check
 *      and rescues nothing else.
 *   3. LEAVE EVIDENCE. Every pass writes the rows (.json/.ndjson/.csv), the
 *      exact source bytes (.raw.html), and a sha256 over both. `verify` recomputes
 *      them, so "I scraped 200 rows" is a claim someone else can check later.
 *   4. NO INTERPRETER BUT NODE. No shell, no python, no dependencies, no
 *      network at parse time. Node is already required by Claude Code.
 *   5. PROVE IT. `selftest` runs this executable as a child process against
 *      fixtures that lie the way real pages lie, and fails loudly if any lie is
 *      believed.
 *
 * Not a criticism of the browser gstack ships, which is excellent and which this
 * skill drives unmodified. It is the layer above it that never had a body.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowseBinary } from "./tb-browse-bin.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const SCHEMA = 1;

// ===========================================================================
// SECTION 1 — HTML tokenizer and DOM
//
// Written by hand for one reason: a regex cannot do this correctly, and the
// places it goes wrong are exactly the places a scraper silently loses rows.
// `<a[^>]*>` ends at the first `>` — including one inside an attribute value.
// `<script>` bodies contain `</div>` and unbalanced quotes. Both are in the
// selftest fixtures.
// ===========================================================================

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT = new Set(["script", "style"]);
const ESCAPABLE_RAW_TEXT = new Set(["textarea", "title"]);

// Tags whose end tag is optional, and what opening them implicitly closes.
const IMPLIED_CLOSE = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  option: ["option"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  thead: ["tbody", "thead", "tfoot"],
  tbody: ["tbody", "thead", "tfoot"],
  tfoot: ["tbody", "thead", "tfoot"],
  p: ["p"],
};
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±",
  frac12: "½", times: "×", divide: "÷", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§",
  para: "¶", dagger: "†", permil: "‰", prime: "′",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
  uuml: "ü", ouml: "ö", auml: "ä", ntilde: "ñ",
  szlig: "ß", aacute: "á", iacute: "í", oacute: "ó",
  uacute: "ú", shy: "­", ensp: " ", emsp: " ",
  thinsp: " ", zwnj: "‌", zwj: "‍",
};

function decodeEntities(text) {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (full, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      try { return String.fromCodePoint(code); } catch { return full; }
    }
    const hit = NAMED_ENTITIES[body] || NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? full : hit;
  });
}

function makeElement(tag, attrs, openStart) {
  return {
    type: "element", tag, attrs, children: [], parent: null,
    openStart, contentStart: -1, contentEnd: -1, end: -1,
  };
}

/**
 * Parse HTML into a DOM. Returns { root, truncated } where `truncated` is a
 * string reason (the input ended in the middle of a construct) or null.
 * Truncation is reported, never guessed around: half a page is not a page.
 */
function parseHTML(html) {
  const root = makeElement("#root", {}, 0);
  root.contentStart = 0;
  const stack = [root];
  let i = 0;
  let truncated = null;

  const top = () => stack[stack.length - 1];
  const attach = (node) => { node.parent = top(); top().children.push(node); };
  const addText = (raw, start) => {
    if (!raw) return;
    const parent = top();
    parent.children.push({ type: "text", raw, start, parent, rawText: RAW_TEXT.has(parent.tag) });
  };
  const closeTo = (idx, contentEnd, end) => {
    for (let k = stack.length - 1; k >= idx; k--) {
      const n = stack[k];
      if (n.contentEnd === -1) n.contentEnd = contentEnd;
      if (n.end === -1) n.end = end;
    }
    stack.length = idx;
  };
  const closeTag = (name, contentEnd, end) => {
    for (let k = stack.length - 1; k >= 1; k--) {
      if (stack[k].tag === name) { closeTo(k, contentEnd, end); return true; }
    }
    return false; // stray end tag: ignored, same as a browser
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { addText(html.slice(i), i); break; }
    if (lt > i) addText(html.slice(i, lt), i);

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) { truncated = "unterminated comment"; break; }
      i = end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      if (end === -1) { truncated = "unterminated declaration"; break; }
      i = end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt + 2);
      if (end === -1) { truncated = "unterminated end tag"; break; }
      const name = html.slice(lt + 2, end).trim().toLowerCase().split(/[\s/]/)[0];
      if (name) closeTag(name, lt, end + 1);
      i = end + 1;
      continue;
    }

    const parsed = parseOpenTag(html, lt);
    if (parsed === "truncated") { truncated = "unterminated start tag"; break; }
    if (parsed === null) { addText("<", lt); i = lt + 1; continue; }

    const { tag, attrs, selfClosing, end } = parsed;

    // implied end tags
    const closers = IMPLIED_CLOSE[tag];
    if (closers) {
      while (stack.length > 1 && closers.includes(top().tag)) closeTo(stack.length - 1, lt, lt);
    }
    if (CLOSES_P.has(tag)) {
      while (stack.length > 1 && top().tag === "p") closeTo(stack.length - 1, lt, lt);
    }

    const node = makeElement(tag, attrs, lt);
    node.contentStart = end;
    attach(node);

    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      node.contentEnd = end;
      node.end = end;
      i = end;
      continue;
    }

    if (RAW_TEXT.has(tag) || ESCAPABLE_RAW_TEXT.has(tag)) {
      const closeIdx = findRawClose(html, end, tag);
      if (closeIdx === -1) { truncated = `unterminated <${tag}>`; break; }
      stack.push(node);
      addText(html.slice(end, closeIdx), end);
      stack.pop();
      node.contentEnd = closeIdx;
      const gt = html.indexOf(">", closeIdx);
      node.end = gt === -1 ? html.length : gt + 1;
      i = node.end;
      continue;
    }

    stack.push(node);
    i = end;
  }

  // anything still open at EOF closes at EOF
  closeTo(1, html.length, html.length);

  // A document that announced <html> and never closed it, with no </body>
  // either, is a body that stopped arriving.
  if (!truncated && /<html[\s>]/i.test(html) && !/<\/html\s*>/i.test(html) && !/<\/body\s*>/i.test(html)) {
    truncated = "document declares <html> but never closes it or <body>";
  }

  return { root, truncated };
}

function findRawClose(html, from, tag) {
  const needle = `</${tag}`;
  const lower = html.toLowerCase();
  return lower.indexOf(needle, from);
}

/**
 * Parse one start tag beginning at `lt`. Returns an object, null (this `<` is
 * literal text), or the string "truncated".
 */
function parseOpenTag(html, lt) {
  let i = lt + 1;
  if (!/[a-zA-Z]/.test(html[i] || "")) return null;
  let j = i;
  while (j < html.length && /[^\s/>]/.test(html[j])) j++;
  const tag = html.slice(i, j).toLowerCase();
  const attrs = {};
  i = j;

  for (;;) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return "truncated";
    if (html[i] === ">") return { tag, attrs, selfClosing: false, end: i + 1 };
    if (html[i] === "/") {
      const gt = html.indexOf(">", i);
      if (gt === -1) return "truncated";
      return { tag, attrs, selfClosing: true, end: gt + 1 };
    }
    // attribute name
    let ns = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
    if (i >= html.length) return "truncated";
    const name = html.slice(ns, i).toLowerCase();
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return "truncated";
    if (html[i] !== "=") { if (name) attrs[name] = ""; continue; }
    i++;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return "truncated";
    const q = html[i];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, i + 1);
      if (close === -1) return "truncated";
      attrs[name] = decodeEntities(html.slice(i + 1, close));
      i = close + 1;
    } else {
      let vs = i;
      while (i < html.length && !/[\s>]/.test(html[i])) i++;
      if (i >= html.length) return "truncated";
      attrs[name] = decodeEntities(html.slice(vs, i));
    }
  }
}

function walkElements(node, fn) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    fn(child);
    walkElements(child, fn);
  }
}

function allElements(root) {
  const out = [];
  walkElements(root, (el) => out.push(el));
  return out;
}

function textOf(node) {
  const parts = [];
  const rec = (n) => {
    if (n.type === "text") {
      if (!n.rawText) parts.push(decodeEntities(n.raw));
      return;
    }
    if (RAW_TEXT.has(n.tag)) return; // never leak script/style bodies into rows
    for (const c of n.children) rec(c);
  };
  rec(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function innerHTMLOf(html, node) {
  const a = node.contentStart >= 0 ? node.contentStart : 0;
  const b = node.contentEnd >= 0 ? node.contentEnd : html.length;
  return b > a ? html.slice(a, b) : "";
}

function outerHTMLOf(html, node) {
  const a = node.openStart;
  const b = node.end >= 0 ? node.end : html.length;
  return b > a ? html.slice(a, b) : "";
}

// ===========================================================================
// SECTION 2 — CSS selector engine
// ===========================================================================

function parseSelectorList(input) {
  return String(input)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseComplexSelector);
}

function parseComplexSelector(sel) {
  const parts = [];
  let rest = sel.trim();
  let combinator = null;
  while (rest.length) {
    const { compound, remainder } = parseCompound(rest);
    parts.push({ combinator, compound });
    let r = remainder;
    const m = /^\s*([>+~])\s*/.exec(r);
    if (m) { combinator = m[1]; r = r.slice(m[0].length); }
    else if (/^\s+\S/.test(r)) { combinator = " "; r = r.replace(/^\s+/, ""); }
    else { r = ""; }
    rest = r;
  }
  if (!parts.length) throw new Error(`empty selector: ${JSON.stringify(sel)}`);
  return parts;
}

function parseCompound(input) {
  const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let s = input;
  let matchedSomething = false;
  for (;;) {
    let m;
    if ((m = /^(\*|[a-zA-Z][\w-]*)/.exec(s))) {
      compound.tag = m[1] === "*" ? null : m[1].toLowerCase();
      s = s.slice(m[0].length); matchedSomething = true; continue;
    }
    if ((m = /^#([\w-]+)/.exec(s))) {
      compound.id = m[1]; s = s.slice(m[0].length); matchedSomething = true; continue;
    }
    if ((m = /^\.([\w-]+)/.exec(s))) {
      compound.classes.push(m[1]); s = s.slice(m[0].length); matchedSomething = true; continue;
    }
    if ((m = /^\[\s*([\w:.-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]/.exec(s))) {
      compound.attrs.push({
        name: m[1].toLowerCase(),
        op: m[2] || null,
        value: m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : null,
      });
      s = s.slice(m[0].length); matchedSomething = true; continue;
    }
    if ((m = /^:{1,2}([\w-]+)(\(([^)]*)\))?/.exec(s))) {
      compound.pseudos.push({ name: m[1].toLowerCase(), arg: m[3] === undefined ? null : m[3].trim() });
      s = s.slice(m[0].length); matchedSomething = true; continue;
    }
    break;
  }
  if (!matchedSomething) throw new Error(`cannot parse selector at ${JSON.stringify(input)}`);
  return { compound, remainder: s };
}

function classListOf(el) {
  const raw = el.attrs.class || el.attrs.classname || "";
  return raw.split(/\s+/).filter(Boolean);
}

function attrMatches(el, spec) {
  const have = el.attrs[spec.name];
  if (have === undefined) return false;
  if (!spec.op) return true;
  const v = spec.value === null ? "" : spec.value;
  switch (spec.op) {
    case "=": return have === v;
    case "^=": return have.startsWith(v);
    case "$=": return have.endsWith(v);
    case "*=": return have.includes(v);
    case "~=": return have.split(/\s+/).includes(v);
    case "|=": return have === v || have.startsWith(v + "-");
    default: return false;
  }
}

function siblingsOf(el) {
  if (!el.parent) return [el];
  return el.parent.children.filter((c) => c.type === "element");
}

function matchCompound(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const list = classListOf(el);
    for (const cl of c.classes) if (!list.includes(cl)) return false;
  }
  for (const a of c.attrs) if (!attrMatches(el, a)) return false;
  for (const p of c.pseudos) {
    const sibs = siblingsOf(el);
    const idx = sibs.indexOf(el);
    switch (p.name) {
      case "first-child": if (idx !== 0) return false; break;
      case "last-child": if (idx !== sibs.length - 1) return false; break;
      case "nth-child": {
        const n = parseInt(p.arg, 10);
        if (Number.isFinite(n)) { if (idx + 1 !== n) return false; }
        else if (p.arg === "even") { if ((idx + 1) % 2 !== 0) return false; }
        else if (p.arg === "odd") { if ((idx + 1) % 2 !== 1) return false; }
        break;
      }
      case "nth-of-type": {
        const same = sibs.filter((s) => s.tag === el.tag);
        const n = parseInt(p.arg, 10);
        if (Number.isFinite(n) && same.indexOf(el) + 1 !== n) return false;
        break;
      }
      case "first-of-type": {
        const same = sibs.filter((s) => s.tag === el.tag);
        if (same.indexOf(el) !== 0) return false;
        break;
      }
      case "not": {
        if (!p.arg) break;
        const inner = parseSelectorList(p.arg);
        if (inner.some((cx) => matchFrom(el, cx, cx.length - 1))) return false;
        break;
      }
      default:
        // Unknown pseudo (:hover, ::before, ...). Refuse rather than pretend:
        // silently ignoring it is how a selector "matches" things it should not.
        throw new Error(`unsupported pseudo-class ":${p.name}" in selector`);
    }
  }
  return true;
}

function prevElement(el) {
  const sibs = siblingsOf(el);
  const idx = sibs.indexOf(el);
  return idx > 0 ? sibs[idx - 1] : null;
}

function matchFrom(el, parts, idx) {
  if (!matchCompound(el, parts[idx].compound)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].combinator;
  if (comb === ">") {
    const p = el.parent;
    return !!p && p.type === "element" && p.tag !== "#root" && matchFrom(p, parts, idx - 1);
  }
  if (comb === " ") {
    let p = el.parent;
    while (p && p.tag !== "#root") {
      if (matchFrom(p, parts, idx - 1)) return true;
      p = p.parent;
    }
    return false;
  }
  if (comb === "+") {
    const p = prevElement(el);
    return !!p && matchFrom(p, parts, idx - 1);
  }
  if (comb === "~") {
    let s = prevElement(el);
    while (s) { if (matchFrom(s, parts, idx - 1)) return true; s = prevElement(s); }
    return false;
  }
  return false;
}

function queryAll(root, selector) {
  const list = parseSelectorList(selector);
  return allElements(root).filter((el) => list.some((cx) => matchFrom(el, cx, cx.length - 1)));
}

function queryOne(root, selector) {
  const hits = queryAll(root, selector);
  return hits.length ? hits[0] : null;
}

// ===========================================================================
// SECTION 3 — bytes to text
//
// Windows-specific, and the reason it is here: a page served as windows-1252
// decoded as UTF-8 does not throw, it produces "cafÃ©", and that lands in the
// artifact as data. So the charset is read, the decode is checked, and mojibake
// is a failed check rather than a row.
// ===========================================================================

function sniffCharset(buf, contentType) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { charset: "utf-8", bom: true };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { charset: "utf-16le", bom: true };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { charset: "utf-16be", bom: true };
  if (contentType) {
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
    if (m) return { charset: m[1].toLowerCase(), bom: false };
  }
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("latin1");
  let m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (m) return { charset: m[1].toLowerCase(), bom: false };
  m = /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head);
  if (m) return { charset: m[1].toLowerCase(), bom: false };
  return { charset: "utf-8", bom: false };
}

const CHARSET_ALIASES = {
  "iso-8859-1": "windows-1252", latin1: "windows-1252", "cp1252": "windows-1252",
  "us-ascii": "utf-8", ascii: "utf-8", utf8: "utf-8",
};

function decodeBuffer(buf, contentType) {
  const sniff = sniffCharset(buf, contentType);
  const label = CHARSET_ALIASES[sniff.charset] || sniff.charset;
  let text;
  let used = label;
  try {
    text = new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    used = "utf-8";
    text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM is not content
  const replacements = (text.match(/�/g) || []).length;
  const mojibake = (text.match(/[ÃÂ][-¿]/g) || []).length;
  return { text, charset: used, declared: sniff.charset, bom: sniff.bom, replacements, mojibake };
}

// ===========================================================================
// SECTION 4 — page-shape detection (the checks that make this fail closed)
// ===========================================================================

const STRONG_BLOCK_SIGNALS = [
  "just a moment...",
  "checking your browser before accessing",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "enable javascript and cookies to continue",
  "our systems have detected unusual traffic",
  "verify you are a human",
  "please verify you are human",
  "ddos protection by cloudflare",
  "request unsuccessful. incapsula incident id",
  "pardon our interruption",
];
const WEAK_BLOCK_SIGNALS = [
  "captcha", "recaptcha", "hcaptcha", "access denied",
  "you don't have permission to access", "403 forbidden", "bot detection",
  "rate limit exceeded", "too many requests",
];
const NOT_FOUND_SIGNALS = [
  "page not found", "404 not found", "not found - 404", "this page does not exist",
  "the page you are looking for", "the page you were looking for",
  "no longer exists", "page doesn't exist", "page does not exist",
];

function detectBlocked(lowerText, lowerHTML, textLen) {
  for (const s of STRONG_BLOCK_SIGNALS) {
    if (lowerHTML.includes(s)) return { blocked: true, signal: s, strength: "strong" };
  }
  if (textLen < 3000) {
    for (const s of WEAK_BLOCK_SIGNALS) {
      if (lowerText.includes(s)) return { blocked: true, signal: s, strength: "weak (page is thin)" };
    }
  }
  return { blocked: false, signal: null, strength: null };
}

function detectSoftNotFound(doc, lowerText, textLen) {
  const titleEl = queryOne(doc, "title");
  const h1 = queryOne(doc, "h1");
  const title = (titleEl ? textOf(titleEl) : "").toLowerCase();
  const heading = (h1 ? textOf(h1) : "").toLowerCase();
  const hay = `${title} | ${heading}`;
  for (const s of NOT_FOUND_SIGNALS) {
    if (hay.includes(s)) return { soft404: true, where: `title/h1 says "${s}"` };
  }
  if (/(^|\W)404(\W|$)/.test(hay)) return { soft404: true, where: `title/h1 says "404" (${JSON.stringify(hay.slice(0, 80))})` };
  if (textLen < 4000) {
    for (const s of NOT_FOUND_SIGNALS) {
      if (lowerText.includes(s)) return { soft404: true, where: `thin page body says "${s}"` };
    }
  }
  return { soft404: false, where: null };
}

function bodyTextOf(doc) {
  const body = queryOne(doc, "body");
  return textOf(body || doc);
}

// ===========================================================================
// SECTION 5 — record extraction
// ===========================================================================

function parseFieldSpec(spec) {
  const eq = spec.indexOf("=");
  if (eq === -1) throw new Error(`--field needs name=selector, got ${JSON.stringify(spec)}`);
  let name = spec.slice(0, eq).trim();
  let rest = spec.slice(eq + 1).trim();
  let optional = false;
  if (name.endsWith("?")) { optional = true; name = name.slice(0, -1); }
  if (!name) throw new Error(`--field has an empty name: ${JSON.stringify(spec)}`);
  let selector = rest;
  let attr = "text";
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    selector = rest.slice(0, at).trim();
    attr = rest.slice(at + 1).trim().toLowerCase() || "text";
  }
  return { name, selector, attr, optional };
}

function resolveUrl(value, baseUrl) {
  if (!value || !baseUrl) return value;
  try { return new URL(value, baseUrl).toString(); } catch { return value; }
}

function readField(html, record, field, baseUrl) {
  let node = record;
  if (field.selector) {
    node = queryOne(record, field.selector);
    if (!node) return "";
  }
  let value;
  if (field.attr === "text") value = textOf(node);
  else if (field.attr === "html") value = innerHTMLOf(html, node).trim();
  else if (field.attr === "outerhtml") value = outerHTMLOf(html, node).trim();
  else value = node.attrs[field.attr] !== undefined ? node.attrs[field.attr] : "";
  if (["href", "src", "action", "data-src", "poster"].includes(field.attr)) {
    value = resolveUrl(value, baseUrl);
  }
  return value;
}

/**
 * Auto mode: find the largest group of structurally identical siblings.
 * Deterministic, and it reports what it chose so the choice is reviewable.
 */
function autoDetectRecords(doc) {
  const candidates = [];
  const consider = (parent) => {
    const kids = parent.children.filter((c) => c.type === "element");
    if (kids.length < 3) return;
    const groups = new Map();
    for (const k of kids) {
      const sig = `${k.tag}${classListOf(k).slice().sort().map((c) => "." + c).join("")}`;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(k);
    }
    for (const [sig, nodes] of groups) {
      if (nodes.length < 3) continue;
      const lens = nodes.map((n) => textOf(n).length);
      const nonEmpty = lens.filter((l) => l > 0).length;
      if (nonEmpty < 3) continue;
      const total = lens.reduce((a, b) => a + b, 0);
      candidates.push({ sig, nodes, score: total * Math.log2(nodes.length + 1), depth: depthOf(parent) });
    }
  };
  consider(doc);
  walkElements(doc, consider);
  candidates.sort((a, b) => b.score - a.score || b.depth - a.depth);
  return candidates[0] || null;
}

function depthOf(el) {
  let d = 0, p = el.parent;
  while (p) { d++; p = p.parent; }
  return d;
}

function autoFields(html, record, baseUrl) {
  const heading = queryOne(record, "h1, h2, h3, h4");
  const link = queryOne(record, "a[href]");
  const img = queryOne(record, "img[src]");
  const title = heading ? textOf(heading) : link ? textOf(link) : textOf(record).slice(0, 120);
  return {
    title,
    url: link ? resolveUrl(link.attrs.href, baseUrl) : "",
    image: img ? resolveUrl(img.attrs.src, baseUrl) : "",
    text: textOf(record),
  };
}

// ===========================================================================
// SECTION 6 — source acquisition
// ===========================================================================

const ENVELOPE_BEGIN = /^-{3,}\s*BEGIN UNTRUSTED EXTERNAL CONTENT\s*\(source:\s*([^)]*)\)\s*-{3,}\s*$/m;
const ENVELOPE_END = /^-{3,}\s*END UNTRUSTED EXTERNAL CONTENT\s*-{3,}\s*$/m;

/**
 * gstack's browse wraps page output in an UNTRUSTED envelope whose header names
 * the URL the content actually came from. That header is the single most useful
 * fact in the output and upstream never checks it: a failed navigation prints
 * `source: chrome-error://chromewebdata/` and an empty body, and reads clean.
 * Here it is unwrapped, kept, and checked.
 */
function unwrapEnvelope(text) {
  const begin = ENVELOPE_BEGIN.exec(text);
  if (!begin) return { text, declaredSource: null, wrapped: false };
  const startAt = begin.index + begin[0].length;
  const tail = text.slice(startAt);
  const end = ENVELOPE_END.exec(tail);
  const body = end ? tail.slice(0, end.index) : tail;
  return { text: body.replace(/^\r?\n/, ""), declaredSource: begin[1].trim(), wrapped: true };
}

function isDeadSource(url) {
  if (!url) return null;
  const u = url.trim().toLowerCase();
  if (u.startsWith("chrome-error:")) return "chrome-error (navigation failed)";
  if (u === "about:blank" || u.startsWith("about:blank")) return "about:blank (nothing was loaded)";
  if (u.startsWith("data:text/html,chromewebdata")) return "chrome error page";
  return null;
}

function fetchViaBrowse(url, timeoutMs) {
  const bin = findBrowseBinary();
  if (!bin) return { ok: false, error: "browse binary not found (set TOOLBAY_BROWSE_BIN)" };
  const goto = spawnSync(bin, ["goto", url], { encoding: "utf8", timeout: timeoutMs });
  if (goto.error) return { ok: false, error: `browse goto failed: ${goto.error.message}` };
  if (goto.status !== 0) {
    return { ok: false, error: `browse goto exited ${goto.status}: ${(goto.stderr || goto.stdout || "").trim().slice(0, 300)}` };
  }
  const html = spawnSync(bin, ["html"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (html.error) return { ok: false, error: `browse html failed: ${html.error.message}` };
  if (html.status !== 0) return { ok: false, error: `browse html exited ${html.status}` };
  return { ok: true, text: html.stdout, via: `browse (${bin})` };
}

async function fetchViaHttp(url, timeoutMs) {
  if (typeof fetch !== "function") return { ok: false, error: "this node has no global fetch; use --via browse" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) toolbay-stack/tb-scrape",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true, buffer: buf, status: res.status,
      contentType: res.headers.get("content-type") || "",
      finalUrl: res.url || url, via: "fetch",
    };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// SECTION 7 — output paths
// ===========================================================================

/**
 * `/tmp` is two different directories on this machine depending on who is
 * asking, so an artifact written there is an artifact nobody can reliably find
 * again. Refused, with both candidates printed.
 */
function refuseAmbiguousPath(p, label) {
  const s = String(p).replace(/\\/g, "/");
  if (/^\/tmp(\/|$)/.test(s) || /^\/var\/folders(\/|$)/.test(s)) {
    const posix = s;
    const win = path.resolve(p);
    throw new UserError(
      `${label} ${JSON.stringify(p)} is ambiguous on this platform and is refused.\n` +
      `  Git Bash / MSYS reads it as: ${posix}\n` +
      `  node path.resolve reads it as: ${win}\n` +
      `  os.tmpdir() is actually:       ${os.tmpdir()}\n` +
      `  Pass an explicit path instead, e.g. --out ./.toolbay/scrape`
    );
  }
  return path.resolve(p);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "scrape";
}

function slugForSource(src) {
  if (src.kind === "url") {
    try {
      const u = new URL(src.ref);
      const p = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("-");
      return slugify(`${u.hostname}${p ? "-" + p : ""}`);
    } catch { return slugify(src.ref); }
  }
  if (src.kind === "file") return slugify(path.basename(src.ref).replace(/\.[a-z0-9]+$/i, ""));
  return "stdin";
}

// ===========================================================================
// SECTION 8 — the extract pipeline
// ===========================================================================

class UserError extends Error {}

const BOOLEAN_FLAGS = new Set([
  "json", "auto", "quiet", "no_raw", "help", "version",
  "allow_blocked", "allow_thin", "allow_sparse", "allow_duplicates",
  "allow_soft_404", "allow_missing_raw", "allow_truncated", "allow_dead_source",
  "refetch",
]);

function parseArgs(argv) {
  const out = { _: [], field: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let key = a.slice(2);
    let val = null;
    const eq = key.indexOf("=");
    if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    const k = key.replace(/-/g, "_");
    if (BOOLEAN_FLAGS.has(k)) { out[k] = val === null ? true : val !== "false" && val !== "0"; continue; }
    if (val === null) { val = argv[++i]; }
    if (val === undefined) throw new UserError(`--${key} needs a value`);
    if (k === "field") out.field.push(val);
    else out[k] = val;
  }
  return out;
}

function num(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError(`expected a number, got ${JSON.stringify(v)}`);
  return n;
}

function check(name, ok, evidence, relaxedBy) {
  return { name, ok: !!ok, evidence, relaxedBy: relaxedBy || null, relaxed: false };
}

async function acquire(args) {
  const timeout = num(args.timeout, 30000);
  if (args.url) {
    const via = args.via || "fetch";
    if (via === "browse") {
      const r = fetchViaBrowse(args.url, timeout);
      if (!r.ok) throw new UserError(r.error);
      return { buffer: Buffer.from(r.text, "utf8"), kind: "url", ref: args.url, status: null, contentType: "text/html", finalUrl: args.url, via: r.via };
    }
    const r = await fetchViaHttp(args.url, timeout);
    if (!r.ok) throw new UserError(r.error);
    return { buffer: r.buffer, kind: "url", ref: args.url, status: r.status, contentType: r.contentType, finalUrl: r.finalUrl, via: r.via };
  }
  if (args.file) {
    const p = refuseAmbiguousPath(args.file, "--file");
    let buffer;
    try {
      buffer = fs.readFileSync(p);
    } catch (e) {
      // Fails CLOSED: an unreadable source is a failed check with a name, not a
      // stack trace and not an empty result.
      return { buffer: Buffer.alloc(0), kind: "file", ref: p, status: null, contentType: "", finalUrl: null, via: "file", readError: e.message };
    }
    return { buffer, kind: "file", ref: p, status: null, contentType: "", finalUrl: null, via: "file" };
  }
  if (args.stdin || args._.includes("-")) {
    const buffer = fs.readFileSync(0);
    return { buffer, kind: "stdin", ref: "<stdin>", status: null, contentType: "", finalUrl: null, via: "stdin" };
  }
  throw new UserError("give me a source: --url <u>, --file <path>, or --stdin");
}

async function cmdExtract(argv) {
  const args = parseArgs(argv);
  const checks = [];
  const minItems = num(args.min_items, 1);
  const minText = num(args.min_text, 200);
  const minFill = num(args.min_fill, 0.6);
  const minDistinct = num(args.min_distinct, 0.5);
  const limit = num(args.limit, 0);

  const src = await acquire(args);
  const bytes = src.buffer.length;

  checks.push(check(
    "source-readable",
    !src.readError && bytes > 0,
    src.readError ? `unreadable: ${src.readError}` : `${bytes.toLocaleString("en-US")} bytes from ${src.ref}`
  ));

  const sourceSha = crypto.createHash("sha256").update(src.buffer).digest("hex");

  let decoded = { text: "", charset: "n/a", declared: "n/a", bom: false, replacements: 0, mojibake: 0 };
  if (bytes > 0) decoded = decodeBuffer(src.buffer, src.contentType);

  const env = unwrapEnvelope(decoded.text);
  const rawText = env.text;
  const declaredSource = env.declaredSource || src.finalUrl || (src.kind === "url" ? src.ref : null);
  const baseUrl = declaredSource && /^https?:/i.test(declaredSource) ? declaredSource : args.base || null;

  const dead = isDeadSource(declaredSource);
  checks.push(check(
    "source-is-a-real-page",
    !dead,
    dead ? `content came from ${declaredSource} -> ${dead}` : `source: ${declaredSource || "(local input)"}`,
    "--allow-dead-source"
  ));

  const badBytes = decoded.replacements + decoded.mojibake;
  checks.push(check(
    "decoded-cleanly",
    bytes === 0 ? false : badBytes < Math.max(3, rawText.length * 0.0005),
    bytes === 0
      ? "nothing to decode"
      : `charset=${decoded.charset} (declared ${decoded.declared})${decoded.bom ? " +BOM" : ""}, ` +
        `${decoded.replacements} replacement chars, ${decoded.mojibake} mojibake pairs`
  ));

  let parsed = { root: makeElement("#root", {}, 0), truncated: bytes === 0 ? "empty input" : null };
  if (bytes > 0) parsed = parseHTML(rawText);
  const doc = parsed.root;

  checks.push(check(
    "not-truncated",
    !parsed.truncated,
    parsed.truncated ? `source ends mid-document: ${parsed.truncated}` : `${rawText.length.toLocaleString("en-US")} chars parsed to ${allElements(doc).length.toLocaleString("en-US")} elements`,
    "--allow-truncated"
  ));

  const bodyText = bytes > 0 ? bodyTextOf(doc) : "";
  const lowerText = bodyText.toLowerCase();
  const lowerHTML = rawText.toLowerCase();

  const blocked = detectBlocked(lowerText, lowerHTML, bodyText.length);
  checks.push(check(
    "not-blocked",
    !blocked.blocked,
    blocked.blocked ? `bot wall / challenge page: matched ${JSON.stringify(blocked.signal)} [${blocked.strength}]` : "no challenge or block signature",
    "--allow-blocked"
  ));

  const nf = detectSoftNotFound(doc, lowerText, bodyText.length);
  checks.push(check(
    "not-a-404",
    !nf.soft404 && src.status !== 404,
    src.status === 404 ? "HTTP 404" : nf.soft404 ? `looks like a not-found page: ${nf.where}` : "not a not-found page",
    "--allow-soft-404"
  ));

  const scriptCount = queryAll(doc, "script").length;
  const thin = bodyText.length < minText;
  checks.push(check(
    "has-rendered-content",
    !thin,
    thin
      ? `body text is ${bodyText.length} chars (min ${minText})` +
        (scriptCount > 0 ? `, with ${scriptCount} <script> tags: this looks like a JS shell, try --via browse` : "")
      : `${bodyText.length.toLocaleString("en-US")} chars of body text`,
    "--allow-thin"
  ));

  // ------------------------------------------------------------ extraction
  let records = [];
  let usedSelector = args.select || null;
  let autoNote = null;
  let fields = args.field.map(parseFieldSpec);
  let selectorError = null;

  if (bytes > 0) {
    try {
      if (args.select) {
        records = queryAll(doc, args.select);
      } else if (args.auto || !fields.length) {
        const hit = autoDetectRecords(doc);
        if (hit) {
          records = hit.nodes;
          usedSelector = `(auto) ${hit.sig}`;
          autoNote = `auto-detected ${hit.nodes.length} sibling nodes matching ${hit.sig}`;
        } else {
          usedSelector = "(auto) none found";
        }
      } else {
        throw new UserError("--field given without --select; pass --select <css> or --auto");
      }
    } catch (e) {
      if (e instanceof UserError) throw e;
      selectorError = e.message;
    }
  }

  checks.push(check(
    "selector-is-valid",
    !selectorError,
    selectorError ? `selector rejected: ${selectorError}` : `selector: ${usedSelector || "(none)"}`
  ));

  if (limit > 0) records = records.slice(0, limit);

  const auto = !args.select && (args.auto || !fields.length);
  const items = records.map((rec, i) => {
    const row = auto && !fields.length
      ? autoFields(rawText, rec, baseUrl)
      : Object.fromEntries(fields.map((f) => [f.name, readField(rawText, rec, f, baseUrl)]));
    return { _index: i, ...row };
  });

  checks.push(check(
    "items-found",
    items.length >= minItems,
    `${items.length} item(s) from ${JSON.stringify(usedSelector || "(none)")}${items.length < minItems ? ` (min ${minItems})` : ""}${autoNote ? ` — ${autoNote}` : ""}`
  ));

  // required fields must actually be populated; an artifact of empty columns is
  // a wrong selector reported as a successful scrape
  const required = fields.filter((f) => !f.optional);
  let fillEvidence = required.length ? [] : ["no required fields declared"];
  let fillOk = true;
  if (required.length && items.length) {
    for (const f of required) {
      const filled = items.filter((it) => String(it[f.name] ?? "").trim() !== "").length;
      const rate = filled / items.length;
      fillEvidence.push(`${f.name} ${filled}/${items.length} (${(rate * 100).toFixed(0)}%)`);
      if (rate < minFill) fillOk = false;
    }
  } else if (required.length && !items.length) {
    fillOk = false;
    fillEvidence = ["no items to fill"];
  }
  checks.push(check(
    "fields-populated",
    fillOk,
    `${fillEvidence.join(", ")}${!fillOk ? ` (min fill ${(minFill * 100).toFixed(0)}%)` : ""}`,
    "--allow-sparse"
  ));

  const bodies = items.map((it) => JSON.stringify(Object.fromEntries(Object.entries(it).filter(([k]) => k !== "_index"))));
  const distinct = new Set(bodies).size;
  const distinctRate = items.length ? distinct / items.length : 0;
  const distinctOk = items.length < 3 ? true : distinctRate >= minDistinct;
  checks.push(check(
    "items-distinct",
    distinctOk,
    items.length < 3
      ? `${items.length} item(s), distinctness not assessed`
      : `${distinct}/${items.length} distinct (${(distinctRate * 100).toFixed(0)}%${distinctOk ? "" : `, min ${(minDistinct * 100).toFixed(0)}%`})`,
    "--allow-duplicates"
  ));

  // apply --allow-* relaxations: each flag clears exactly the one check it names
  const relax = {
    "--allow-blocked": args.allow_blocked,
    "--allow-thin": args.allow_thin,
    "--allow-sparse": args.allow_sparse,
    "--allow-duplicates": args.allow_duplicates,
    "--allow-soft-404": args.allow_soft_404,
    "--allow-truncated": args.allow_truncated,
    "--allow-dead-source": args.allow_dead_source,
  };
  for (const c of checks) {
    if (!c.ok && c.relaxedBy && relax[c.relaxedBy]) { c.ok = true; c.relaxed = true; }
  }

  const structuralPass = checks.every((c) => c.ok);

  // ------------------------------------------------------------- artifacts
  const outDir = refuseAmbiguousPath(args.out || path.join(process.cwd(), ".toolbay", "scrape"), "--out");
  const slug = slugify(args.name || slugForSource(src));
  const itemsSha = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");

  const meta = {
    engine: "tb-scrape", engineVersion: VERSION, schema: SCHEMA,
    scrapedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
    source: {
      kind: src.kind, ref: src.ref, via: src.via, status: src.status,
      contentType: src.contentType || null, declaredSource: declaredSource || null,
      envelope: env.wrapped,
    },
    bytes, sourceSha256: sourceSha, charset: decoded.charset,
    selector: usedSelector, fields: fields.map((f) => ({ name: f.name, selector: f.selector, attr: f.attr, optional: f.optional })),
    count: items.length, itemsSha256: itemsSha,
    rawFile: args.no_raw ? null : `${slug}.raw.html`,
  };

  let written = [];
  let artifactCheck;
  if (structuralPass) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const jsonPath = path.join(outDir, `${slug}.json`);
      const ndPath = path.join(outDir, `${slug}.ndjson`);
      const csvPath = path.join(outDir, `${slug}.csv`);
      fs.writeFileSync(jsonPath, JSON.stringify({ meta, checks: checks.map(stripCheck), items }, null, 2), "utf8");
      fs.writeFileSync(ndPath, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""), "utf8");
      fs.writeFileSync(csvPath, toCSV(items), "utf8");
      written = [jsonPath, ndPath, csvPath];
      if (!args.no_raw) {
        const rawPath = path.join(outDir, `${slug}.raw.html`);
        fs.writeFileSync(rawPath, src.buffer);
        written.push(rawPath);
      }
      // Read it back. "I wrote the file" and "the file is there and parses"
      // are different claims and only the second one is worth anything.
      const back = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const okBack = back.items.length === items.length &&
        crypto.createHash("sha256").update(JSON.stringify(back.items)).digest("hex") === itemsSha;
      const csvRows = fs.readFileSync(csvPath, "utf8").split("\r\n").filter(Boolean).length - 1;
      artifactCheck = check(
        "artifact-verifiable",
        okBack && csvRows === items.length,
        okBack && csvRows === items.length
          ? `re-read ${jsonPath}: ${back.items.length} items, sha ${itemsSha.slice(0, 12)}…, csv ${csvRows} data rows`
          : `re-read mismatch: json ${back.items.length} items, csv ${csvRows} rows, expected ${items.length}`
      );
    } catch (e) {
      artifactCheck = check("artifact-verifiable", false, `could not write or re-read artifact: ${e.message}`);
    }
  } else {
    artifactCheck = check("artifact-verifiable", false, "not written: an earlier check failed, so there is no result to save");
  }
  checks.push(artifactCheck);

  const ok = checks.every((c) => c.ok);
  const result = { ok, count: items.length, items, checks: checks.map(stripCheck), meta, artifacts: written };

  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    printChecks(checks, args.quiet);
    if (ok) {
      process.stdout.write(`\nVERDICT PASS. ${items.length} item(s).\n`);
      for (const w of written) process.stdout.write(`  ${w}\n`);
      process.stdout.write(`\nVerify later:  node ${path.basename(SELF)} verify --artifact ${path.join(outDir, slug + ".json")}\n`);
    } else {
      const failed = checks.filter((c) => !c.ok);
      process.stdout.write(`\nVERDICT FAIL. ${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.name).join(", ")}.\n`);
      process.stdout.write("No artifact was written. Do not report this page as scraped.\n");
    }
  }
  return ok ? 0 : 1;
}

function stripCheck(c) {
  return { name: c.name, ok: c.ok, evidence: c.evidence, relaxed: c.relaxed };
}

function printChecks(checks, quiet) {
  if (quiet) return;
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const tag = c.ok ? (c.relaxed ? "PASS*" : "PASS ") : "FAIL ";
    process.stdout.write(`${tag} ${c.name.padEnd(w)}  ${c.evidence}\n`);
  }
  if (checks.some((c) => c.relaxed)) {
    process.stdout.write("PASS* = check failed and was relaxed by an --allow flag you passed.\n");
  }
}

function toCSV(items) {
  const cols = [];
  for (const it of items) for (const k of Object.keys(it)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const it of items) lines.push(cols.map((c) => esc(it[c])).join(","));
  // BOM + CRLF: this is the difference between Excel on Windows opening the
  // file correctly and opening it as one column of mojibake.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ===========================================================================
// SECTION 9 — verify
// ===========================================================================

function cmdVerify(argv) {
  const args = parseArgs(argv);
  if (!args.artifact) throw new UserError("verify needs --artifact <path to .json>");
  const p = refuseAmbiguousPath(args.artifact, "--artifact");
  const checks = [];

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    process.stdout.write(`FAIL  artifact-readable  ${e.message}\n\nVERDICT FAIL.\n`);
    return 1;
  }
  checks.push(check("artifact-readable", true, `${p} parsed as JSON`));
  checks.push(check(
    "schema-known",
    doc.meta && doc.meta.schema === SCHEMA && doc.meta.engine === "tb-scrape",
    doc.meta ? `engine=${doc.meta.engine} schema=${doc.meta.schema} (expected tb-scrape/${SCHEMA})` : "no meta block"
  ));

  const items = Array.isArray(doc.items) ? doc.items : null;
  checks.push(check("items-present", !!items, items ? `${items.length} items` : "items is not an array"));

  if (items) {
    checks.push(check(
      "count-matches-meta",
      doc.meta && doc.meta.count === items.length,
      `meta.count=${doc.meta && doc.meta.count} items.length=${items.length}`
    ));
    const sha = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
    checks.push(check(
      "items-hash-matches",
      doc.meta && doc.meta.itemsSha256 === sha,
      `recomputed ${sha.slice(0, 16)}… stored ${(doc.meta && doc.meta.itemsSha256 || "(none)").slice(0, 16)}…`
    ));
  }

  const dir = path.dirname(p);
  const rawName = doc.meta && doc.meta.rawFile;
  if (rawName) {
    const rawPath = path.join(dir, rawName);
    let rawOk = false, rawEvidence;
    try {
      const buf = fs.readFileSync(rawPath);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      rawOk = sha === doc.meta.sourceSha256 && buf.length === doc.meta.bytes;
      rawEvidence = rawOk
        ? `${rawPath} ${buf.length} bytes, sha ${sha.slice(0, 16)}… matches`
        : `${rawPath} sha ${sha.slice(0, 16)}… vs stored ${String(doc.meta.sourceSha256).slice(0, 16)}…, bytes ${buf.length} vs ${doc.meta.bytes}`;
    } catch (e) {
      rawEvidence = `source evidence missing: ${e.message}`;
    }
    checks.push(check("raw-evidence", rawOk, rawEvidence));
  } else {
    // Fails CLOSED on purpose: an artifact with no source bytes cannot be
    // checked against anything, so it cannot be called verified.
    checks.push(check(
      "raw-evidence",
      false,
      "artifact was written with --no-raw, so there is nothing to check the rows against",
      "--allow-missing-raw"
    ));
  }

  const sidecars = [
    [".ndjson", (t) => t.split("\n").filter(Boolean).length],
    [".csv", (t) => t.split("\r\n").filter(Boolean).length - 1],
  ];
  for (const [ext, counter] of sidecars) {
    const sp = p.replace(/\.json$/, ext);
    let ok = false, evidence;
    try {
      const t = fs.readFileSync(sp, "utf8");
      const n = counter(t);
      ok = items ? n === items.length : false;
      evidence = `${path.basename(sp)}: ${n} rows vs ${items ? items.length : "?"} items`;
    } catch (e) {
      evidence = `${path.basename(sp)} unreadable: ${e.message}`;
    }
    checks.push(check(`sidecar${ext}`, ok, evidence));
  }

  if (args.allow_missing_raw) {
    for (const c of checks) if (!c.ok && c.relaxedBy === "--allow-missing-raw") { c.ok = true; c.relaxed = true; }
  }

  printChecks(checks, args.quiet);
  const ok = checks.every((c) => c.ok);
  process.stdout.write(ok
    ? `\nVERDICT PASS. ${items.length} rows still match the page bytes they came from.\n`
    : `\nVERDICT FAIL. ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}.\n`);
  return ok ? 0 : 1;
}

// ===========================================================================
// SECTION 10 — doctor
// ===========================================================================

function cmdDoctor() {
  const lines = [];
  const bin = findBrowseBinary();
  lines.push(`tb-scrape          ${VERSION} (schema ${SCHEMA})`);
  lines.push(`node               ${process.version} on ${process.platform} ${process.arch}`);
  lines.push(`cwd                ${process.cwd()}`);
  lines.push(`default --out      ${path.join(process.cwd(), ".toolbay", "scrape")}`);
  lines.push(`os.tmpdir()        ${os.tmpdir()}`);
  lines.push(`"/tmp" resolves to ${path.resolve("/tmp")}   <- refused as a target, it means two things here`);
  lines.push(`global fetch       ${typeof fetch === "function" ? "available" : "MISSING (use --via browse)"}`);
  lines.push(`browse binary      ${bin || "not found (only needed for --via browse)"}`);
  const smoke = spawnSync(process.execPath, [SELF, "extract", "--stdin", "--select", "li", "--json", "--min-text", "0"], {
    input: "<html><body><ul><li>a</li><li>b</li><li>c</li></ul><p>" + "x".repeat(50) + "</p></body></html>",
    encoding: "utf8",
  });
  let smokeOk = false;
  try { smokeOk = JSON.parse(smoke.stdout).count === 3; } catch { /* stays false */ }
  lines.push(`engine smoke test  ${smokeOk ? "ok (3 rows parsed out of a stdin document)" : "FAILED — the engine cannot parse a trivial page"}`);
  process.stdout.write(lines.join("\n") + "\n");
  return smokeOk ? 0 : 1;
}

// ===========================================================================
// SECTION 11 — selftest
//
// Every fixture below is a page that lies. The engine has to catch each one.
// A test "passes" when the engine reaches the verdict the fixture deserves,
// which for most of these is FAIL.
// ===========================================================================

const GOOD_PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Widgets — Example Store</title>',
  "<script>var trap = \"</div><div class='card'>fake</div>\"; if (1 > 0) { console.log('</li>'); }</script>",
  "<style>.card > h2 { color: red } /* } .card { */</style>",
  "</head><body>",
  "<header><div class='card'><h2>Not a product</h2></div></header>",
  "<main><div class='grid'>",
];
for (let n = 1; n <= 6; n++) {
  GOOD_PAGE.push(
    `<div class="card" data-id="${n}">` +
    `<h2>Widget ${n} &amp; Co</h2>` +
    `<a href="/p/${n}?a=1&amp;b=2" data-note="a &gt; b &quot;quoted&quot;">buy</a>` +
    `<span class="price">$${n}0</span>` +
    `<div class="card inner"><span class="price">$999</span></div>` +
    `</div>`
  );
}
GOOD_PAGE.push(
  "</div></main>",
  "<footer><span class='price'>$0</span><p>" + "Footer prose. ".repeat(20) + "</p></footer>",
  "</body></html>"
);
const GOOD_HTML = GOOD_PAGE.join("\r\n");

const FIXTURES = {
  "good-list.html": GOOD_HTML,

  "cloudflare.html":
    "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>" +
    "<div class='cf-browser-verification cf-im-under-attack'>" +
    "<h1>Checking your browser before accessing example.com</h1>" +
    "<p>This process is automatic. Your browser will redirect to your requested content shortly.</p>" +
    "<p>Please allow up to 5 seconds. DDoS protection by Cloudflare. Ray ID: 8a1f2c3d4e5f6789</p>" +
    "</div></body></html>",

  "soft404.html":
    "<!DOCTYPE html><html><head><title>404 &mdash; Page not found</title></head><body>" +
    "<h1>Page not found</h1><p>" + "The page you are looking for has moved or no longer exists. ".repeat(6) + "</p>" +
    "<div class='card'><h2>Suggested</h2><span class='price'>$1</span></div>" +
    "<div class='card'><h2>Popular</h2><span class='price'>$2</span></div>" +
    "<div class='card'><h2>Home</h2><span class='price'>$3</span></div>" +
    "</body></html>",

  "jsshell.html":
    "<!DOCTYPE html><html><head><title>App</title></head><body>" +
    "<div id=\"root\"></div><div id=\"__next\"></div>" +
    "<script src=\"/static/app.9f2c.js\"></script><script>window.__DATA__={products:[]}</script>" +
    "</body></html>",

  "sparse.html":
    "<!DOCTYPE html><html><head><title>Store</title></head><body><main>" +
    Array.from({ length: 5 }, (_, i) => `<div class="card"><h2>Item ${i + 1}</h2><em>no price element here</em></div>`).join("") +
    "<p>" + "Long enough body prose to clear the thin-page check. ".repeat(8) + "</p>" +
    "</main></body></html>",

  "identical.html":
    "<!DOCTYPE html><html><head><title>Store</title></head><body><main>" +
    Array.from({ length: 5 }, () => '<div class="card"><h2>Loading…</h2><span class="price">--</span></div>').join("") +
    "<p>" + "Long enough body prose to clear the thin-page check. ".repeat(8) + "</p>" +
    "</main></body></html>",

  "truncated.html": GOOD_HTML.slice(0, GOOD_HTML.indexOf('data-id="4"') + 6),

  "empty.html": "",

  "envelope-ok.txt":
    "--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: https://store.example.com/widgets) ---\n" +
    GOOD_HTML + "\n" +
    "--- END UNTRUSTED EXTERNAL CONTENT ---\n",

  "envelope-dead.txt":
    "--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: chrome-error://chromewebdata/) ---\n" +
    GOOD_HTML + "\n" +
    "--- END UNTRUSTED EXTERNAL CONTENT ---\n",
};

function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  // windows-1252 page: the bytes a European store actually serves
  const latin = "<!DOCTYPE html><html><head><meta charset=\"windows-1252\"><title>Caf\xe9</title></head><body><main>" +
    "<div class=\"card\"><h2>Caf\xe9 cr\xe8me</h2><span class=\"price\">3,50\xa0€</span></div>".replace("€", "\x80") +
    "<div class=\"card\"><h2>Th\xe9 vert</h2><span class=\"price\">2,90\x80</span></div>" +
    "<div class=\"card\"><h2>Chocolat</h2><span class=\"price\">4,10\x80</span></div>" +
    "<p>" + "Assez de texte pour passer le controle de page mince. ".repeat(8) + "</p>" +
    "</main></body></html>";
  fs.writeFileSync(path.join(dir, "latin1.html"), Buffer.from(latin, "latin1"));
  // same page, utf-8 with a BOM
  const bomHtml = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Café</title></head><body><main>" +
    "<div class=\"card\"><h2>Café crème</h2><span class=\"price\">3,50 €</span></div>" +
    "<div class=\"card\"><h2>Thé vert</h2><span class=\"price\">2,90 €</span></div>" +
    "<div class=\"card\"><h2>Chocolat</h2><span class=\"price\">4,10 €</span></div>" +
    "<p>" + "Assez de texte pour passer le controle de page mince. ".repeat(8) + "</p>" +
    "</main></body></html>";
  fs.writeFileSync(path.join(dir, "bom.html"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bomHtml, "utf8")]));
}

function runSelf(argv, input) {
  const r = spawnSync(process.execPath, [SELF, ...argv], {
    encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

function cmdSelftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-scrape-selftest-"));
  const fx = path.join(root, "fixtures");
  const out = path.join(root, "out");
  writeFixtures(fx);
  const F = (n) => path.join(fx, n);

  const results = [];
  const t = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail || "" });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const CARD = ["--select", ".grid > .card", "--field", "title=h2", "--field", "url=a@href", "--field", "price=.price", "--field", "note=a@data-note"];

  // ---------------------------------------------------------------- happy path
  t("a real listing page extracts 6 rows and writes an artifact", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--out", out, "--name", "good"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    expect(/VERDICT PASS/.test(r.out), `no PASS verdict:\n${r.out}`);
    const a = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    expect(a.items.length === 6, `expected 6 items, got ${a.items.length}`);
    return `6 rows, artifact ${path.join(out, "good.json")}`;
  });

  t("an attribute containing > and &quot; survives (a regex scraper loses this row)", () => {
    const a = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    const note = a.items[0].note;
    expect(note === 'a > b "quoted"', `note came back as ${JSON.stringify(note)}`);
    expect(a.items[0].title === "Widget 1 & Co", `title came back as ${JSON.stringify(a.items[0].title)}`);
    expect(a.items[0].url === "/p/1?a=1&b=2", `url came back as ${JSON.stringify(a.items[0].url)}`);
    return `note=${JSON.stringify(note)} title=${JSON.stringify(a.items[0].title)}`;
  });

  t("script and style bodies never leak into rows", () => {
    const a = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    const blob = JSON.stringify(a.items);
    expect(!blob.includes("var trap"), "script body leaked into items");
    expect(!blob.includes("color: red"), "style body leaked into items");
    expect(!a.items.some((i) => i.title === "fake"), "the fake card inside the <script> string was extracted as a row");
    return "no script/style text in items";
  });

  t("field selectors stay scoped to their own row", () => {
    const a = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    const prices = a.items.map((i) => i.price);
    expect(JSON.stringify(prices) === JSON.stringify(["$10", "$20", "$30", "$40", "$50", "$60"]),
      `prices came back as ${JSON.stringify(prices)}`);
    expect(!prices.includes("$999") && !prices.includes("$0"), "picked up a price from a nested or footer element");
    return prices.join(" ");
  });

  t("the csv is Excel-readable on Windows: BOM, CRLF, one row per item", () => {
    const buf = fs.readFileSync(path.join(out, "good.csv"));
    expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "csv has no UTF-8 BOM");
    const text = buf.toString("utf8").replace(/^﻿/, "");
    expect(text.includes("\r\n"), "csv is not CRLF");
    expect(text.split("\r\n").filter(Boolean).length - 1 === 6, "csv row count does not match item count");
    return "BOM + CRLF + 6 data rows";
  });

  t("--auto finds the repeating structure with no selector given", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), "--auto", "--out", out, "--name", "auto", "--json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const j = JSON.parse(r.stdout);
    expect(j.count === 6, `auto found ${j.count} rows, expected 6`);
    return `auto selector: ${j.meta.selector}`;
  });

  // ------------------------------------------------------------- pages that lie
  t("a Cloudflare challenge page FAILS instead of scraping its markup", () => {
    const r = runSelf(["extract", "--file", F("cloudflare.html"), "--select", ".card", "--field", "price=.price", "--out", out, "--name", "cf"]);
    expect(r.code !== 0, `challenge page returned exit 0:\n${r.out}`);
    expect(/FAIL\s+not-blocked/.test(r.out), `not-blocked did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("--allow-blocked relaxes exactly one check and rescues nothing else", () => {
    const r = runSelf(["extract", "--file", F("cloudflare.html"), "--select", ".card", "--field", "price=.price", "--allow-blocked", "--out", out, "--name", "cf2"]);
    expect(r.code !== 0, `--allow-blocked turned a bot wall into a pass:\n${r.out}`);
    expect(/PASS\*\s+not-blocked/.test(r.out), "the relaxed check is not marked as relaxed");
    expect(/VERDICT FAIL/.test(r.out), "verdict should still be FAIL");
    expect(/FAIL\s+items-found/.test(r.out), "the interstitial still has to fail on having no rows");
    expect(!fs.existsSync(path.join(out, "cf2.json")), "an artifact was written for a relaxed-but-still-failing run");
    return firstFail(r.out);
  });

  t("a soft 404 that serves 200 and real markup FAILS", () => {
    const r = runSelf(["extract", "--file", F("soft404.html"), "--select", ".card", "--field", "title=h2", "--out", out, "--name", "nf"]);
    expect(r.code !== 0, `soft 404 returned exit 0:\n${r.out}`);
    expect(/FAIL\s+not-a-404/.test(r.out), `not-a-404 did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("a JS shell with an empty #root FAILS and says to use the browser", () => {
    const r = runSelf(["extract", "--file", F("jsshell.html"), "--auto", "--out", out, "--name", "js"]);
    expect(r.code !== 0, `JS shell returned exit 0:\n${r.out}`);
    expect(/FAIL\s+has-rendered-content/.test(r.out), `has-rendered-content did not fire:\n${r.out}`);
    expect(/--via browse/.test(r.out), "the remedy is not named in the evidence");
    return firstFail(r.out);
  });

  t("a selector that matches nothing FAILS and writes no artifact", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), "--select", ".does-not-exist", "--field", "title=h2", "--out", out, "--name", "nothing"]);
    expect(r.code !== 0, `zero rows returned exit 0:\n${r.out}`);
    expect(/FAIL\s+items-found/.test(r.out), `items-found did not fire:\n${r.out}`);
    expect(!fs.existsSync(path.join(out, "nothing.json")), "an artifact was written for a failed run");
    return "0 rows, no nothing.json on disk";
  });

  t("rows whose required column is empty everywhere FAIL", () => {
    const r = runSelf(["extract", "--file", F("sparse.html"), "--select", ".card", "--field", "title=h2", "--field", "price=.price", "--out", out, "--name", "sparse"]);
    expect(r.code !== 0, `empty column returned exit 0:\n${r.out}`);
    expect(/FAIL\s+fields-populated/.test(r.out), `fields-populated did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("marking that column optional is enough, and only that", () => {
    const r = runSelf(["extract", "--file", F("sparse.html"), "--select", ".card", "--field", "title=h2", "--field", "price?=.price", "--out", out, "--name", "sparse-ok"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const a = JSON.parse(fs.readFileSync(path.join(out, "sparse-ok.json"), "utf8"));
    expect(a.items.length === 5 && a.items.every((i) => i.price === ""), "optional field did not behave");
    return "5 rows, price empty and declared optional";
  });

  t("five identical placeholder rows FAIL as a still-loading page", () => {
    const r = runSelf(["extract", "--file", F("identical.html"), "--select", ".card", "--field", "title=h2", "--out", out, "--name", "dupes"]);
    expect(r.code !== 0, `identical rows returned exit 0:\n${r.out}`);
    expect(/FAIL\s+items-distinct/.test(r.out), `items-distinct did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("--allow-duplicates rescues only the distinctness check", () => {
    const r = runSelf(["extract", "--file", F("identical.html"), "--select", ".card", "--field", "title=h2", "--allow-duplicates", "--out", out, "--name", "dupes2"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    expect(/PASS\*\s+items-distinct/.test(r.out), "relaxed check not marked");
    return "5 identical rows, explicitly allowed";
  });

  t("a page that stops mid-tag FAILS instead of scraping the half it got", () => {
    const r = runSelf(["extract", "--file", F("truncated.html"), "--select", ".card", "--field", "title=h2", "--out", out, "--name", "trunc"]);
    expect(r.code !== 0, `truncated page returned exit 0:\n${r.out}`);
    expect(/FAIL\s+not-truncated/.test(r.out), `not-truncated did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("a zero-byte source FAILS as unreadable, not as an empty result", () => {
    const r = runSelf(["extract", "--file", F("empty.html"), "--auto", "--out", out, "--name", "empty"]);
    expect(r.code !== 0, `empty file returned exit 0:\n${r.out}`);
    expect(/FAIL\s+source-readable/.test(r.out), `source-readable did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("a missing file FAILS closed with a named check, not a stack trace", () => {
    const r = runSelf(["extract", "--file", path.join(fx, "no-such-file.html"), "--auto", "--out", out, "--name", "missing"]);
    expect(r.code !== 0, `missing file returned exit 0:\n${r.out}`);
    expect(/FAIL\s+source-readable/.test(r.out), `source-readable did not fire:\n${r.out}`);
    expect(!/at Object\.<anonymous>|at Module\._compile/.test(r.out), "leaked a node stack trace instead of a verdict");
    return firstFail(r.out);
  });

  // ---------------------------------------------------- browse output envelope
  t("browse's UNTRUSTED envelope is unwrapped and its source URL recorded", () => {
    const r = runSelf(["extract", "--file", F("envelope-ok.txt"), ...CARD, "--out", out, "--name", "env", "--json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const j = JSON.parse(r.stdout);
    expect(j.count === 6, `expected 6 rows, got ${j.count}`);
    expect(j.meta.source.declaredSource === "https://store.example.com/widgets", `declaredSource=${j.meta.source.declaredSource}`);
    expect(j.items[0].url === "https://store.example.com/p/1?a=1&b=2", `relative url not resolved: ${j.items[0].url}`);
    return `source ${j.meta.source.declaredSource}, urls absolutised`;
  });

  t("an envelope that says chrome-error FAILS even though the markup parses", () => {
    const r = runSelf(["extract", "--file", F("envelope-dead.txt"), ...CARD, "--out", out, "--name", "envdead"]);
    expect(r.code !== 0, `chrome-error content returned exit 0:\n${r.out}`);
    expect(/FAIL\s+source-is-a-real-page/.test(r.out), `source-is-a-real-page did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  // -------------------------------------------------------------- encodings
  t("a windows-1252 page decodes to real accents, not mojibake", () => {
    const r = runSelf(["extract", "--file", F("latin1.html"), "--select", ".card", "--field", "title=h2", "--out", out, "--name", "latin", "--json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const j = JSON.parse(r.stdout);
    expect(j.items[0].title === "Café crème", `got ${JSON.stringify(j.items[0].title)}`);
    expect(j.meta.charset === "windows-1252", `charset recorded as ${j.meta.charset}`);
    return `charset ${j.meta.charset}, title ${JSON.stringify(j.items[0].title)}`;
  });

  t("a UTF-8 BOM does not end up inside the first row", () => {
    const r = runSelf(["extract", "--file", F("bom.html"), "--select", ".card", "--field", "title=h2", "--out", out, "--name", "bom", "--json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const j = JSON.parse(r.stdout);
    expect(!JSON.stringify(j.items).includes("﻿"), "BOM leaked into the rows");
    expect(j.items[0].title === "Café crème", `got ${JSON.stringify(j.items[0].title)}`);
    return "BOM stripped, accents intact";
  });

  // ------------------------------------------------------------------ paths
  t("--out /tmp/... is refused, naming both directories it could mean", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--out", "/tmp/tb-scrape-out"]);
    expect(r.code !== 0, `/tmp target was accepted:\n${r.out}`);
    expect(/ambiguous on this platform/.test(r.out), `no ambiguity message:\n${r.out}`);
    expect(/os\.tmpdir\(\) is actually/.test(r.out), "did not print the real tmpdir");
    return r.out.split("\n").filter((l) => l.includes("reads it as")).join(" | ");
  });

  // ----------------------------------------------------------------- verify
  t("verify passes on an untouched artifact", () => {
    const r = runSelf(["verify", "--artifact", path.join(out, "good.json")]);
    expect(r.code === 0, `verify failed on a clean artifact:\n${r.out}`);
    expect(/VERDICT PASS/.test(r.out), "no PASS verdict");
    return "all hashes match";
  });

  t("verify catches a row added to the artifact after the fact", () => {
    const p = path.join(out, "tampered.json");
    fs.copyFileSync(path.join(out, "good.json"), p);
    fs.copyFileSync(path.join(out, "good.ndjson"), path.join(out, "tampered.ndjson"));
    fs.copyFileSync(path.join(out, "good.csv"), path.join(out, "tampered.csv"));
    fs.copyFileSync(path.join(out, "good.raw.html"), path.join(out, "good.raw.html")); // no-op, keeps intent explicit
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    doc.items.push({ _index: 6, title: "Widget 7 (invented)", url: "/p/7", price: "$70", note: "" });
    fs.writeFileSync(p, JSON.stringify(doc, null, 2), "utf8");
    const r = runSelf(["verify", "--artifact", p]);
    expect(r.code !== 0, `an invented row verified clean:\n${r.out}`);
    expect(/FAIL\s+items-hash-matches/.test(r.out), `items-hash-matches did not fire:\n${r.out}`);
    expect(/FAIL\s+count-matches-meta/.test(r.out), "count check did not fire");
    return firstFail(r.out);
  });

  t("verify catches the source page being edited under the artifact", () => {
    const dir = path.join(root, "out2");
    const r0 = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--out", dir, "--name", "g"]);
    expect(r0.code === 0, `setup extract failed:\n${r0.out}`);
    fs.appendFileSync(path.join(dir, "g.raw.html"), "\n<!-- edited after the fact -->\n");
    const r = runSelf(["verify", "--artifact", path.join(dir, "g.json")]);
    expect(r.code !== 0, `edited source verified clean:\n${r.out}`);
    expect(/FAIL\s+raw-evidence/.test(r.out), `raw-evidence did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("an artifact with no source bytes cannot be verified, and says so", () => {
    const dir = path.join(root, "out3");
    const r0 = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--out", dir, "--name", "g", "--no-raw"]);
    expect(r0.code === 0, `setup extract failed:\n${r0.out}`);
    expect(!fs.existsSync(path.join(dir, "g.raw.html")), "--no-raw still wrote the raw file");
    const r = runSelf(["verify", "--artifact", path.join(dir, "g.json")]);
    expect(r.code !== 0, `unverifiable artifact verified clean:\n${r.out}`);
    expect(/FAIL\s+raw-evidence/.test(r.out), "raw-evidence did not fire");
    const r2 = runSelf(["verify", "--artifact", path.join(dir, "g.json"), "--allow-missing-raw"]);
    expect(r2.code === 0, `--allow-missing-raw did not let it through:\n${r2.out}`);
    expect(/PASS\*\s+raw-evidence/.test(r2.out), "relaxed check not marked");
    return "fails closed without the bytes, passes only when told to";
  });

  t("verify rejects a file that is not one of ours", () => {
    const p = path.join(root, "junk.json");
    fs.writeFileSync(p, JSON.stringify({ items: [{ a: 1 }] }), "utf8");
    const r = runSelf(["verify", "--artifact", p]);
    expect(r.code !== 0, `a foreign json verified clean:\n${r.out}`);
    expect(/FAIL\s+schema-known/.test(r.out), "schema-known did not fire");
    return firstFail(r.out);
  });

  // ------------------------------------------------------------- json contract
  t("--json emits exactly one parseable document on stdout, on pass and on fail", () => {
    const good = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--out", out, "--name", "j1", "--json"]);
    const jg = JSON.parse(good.stdout);
    expect(jg.ok === true && jg.count === 6, "pass-path json is wrong");
    const bad = runSelf(["extract", "--file", F("cloudflare.html"), "--select", ".card", "--field", "price=.price", "--out", out, "--name", "j2", "--json"]);
    expect(bad.code !== 0, "fail-path exited 0");
    const jb = JSON.parse(bad.stdout);
    expect(jb.ok === false, "fail-path json says ok:true");
    expect(jb.checks.some((c) => c.name === "not-blocked" && !c.ok), "fail-path json does not name the failed check");
    return "one document each way, ok flag matches the exit code";
  });

  t("an invalid selector is rejected, not silently matched", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), "--select", ".card:hover", "--field", "title=h2", "--out", out, "--name", "badsel"]);
    expect(r.code !== 0, `unsupported pseudo returned exit 0:\n${r.out}`);
    expect(/FAIL\s+selector-is-valid/.test(r.out), `selector-is-valid did not fire:\n${r.out}`);
    return firstFail(r.out);
  });

  t("--limit caps the rows and the artifact agrees", () => {
    const r = runSelf(["extract", "--file", F("good-list.html"), ...CARD, "--limit", "2", "--out", out, "--name", "lim", "--json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
    const j = JSON.parse(r.stdout);
    expect(j.count === 2, `expected 2, got ${j.count}`);
    const a = JSON.parse(fs.readFileSync(path.join(out, "lim.json"), "utf8"));
    expect(a.meta.count === 2 && a.items.length === 2, "artifact disagrees with stdout");
    return "2 rows in stdout and on disk";
  });

  t("doctor exits 0 and proves the parser runs on this machine", () => {
    const r = runSelf(["doctor"]);
    expect(r.code === 0, `doctor exited ${r.code}:\n${r.out}`);
    expect(/engine smoke test  ok/.test(r.out), `smoke test line missing:\n${r.out}`);
    return r.out.split("\n").find((l) => l.startsWith("engine smoke test")) || "";
  });

  // ------------------------------------------------------------------ report
  const failed = results.filter((r) => !r.ok);
  const w = Math.min(72, Math.max(...results.map((r) => r.name.length)));
  process.stdout.write(`tb-scrape ${VERSION} selftest — ${results.length} cases\nfixtures: ${fx}\n\n`);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}\n`);
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed.\n`);
  if (failed.length) {
    process.stdout.write(`\nFAILURES:\n`);
    for (const f of failed) process.stdout.write(`  ${f.name}\n    ${f.detail.replace(/\n/g, "\n    ")}\n`);
    process.stdout.write(`\nSELFTEST FAILED. The engine believed something it should have refused.\n`);
    return 1;
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* fixtures are disposable */ }
  process.stdout.write(`SELFTEST PASSED. Every fixture that lies was caught, and every honest one extracted.\n`);
  return 0;
}

function firstFail(out) {
  const line = out.split("\n").find((l) => l.startsWith("FAIL "));
  return line ? line.replace(/\s+/g, " ").trim().slice(0, 130) : "";
}

// ===========================================================================
// SECTION 12 — entry point
// ===========================================================================

const USAGE = `tb-scrape ${VERSION} — pull structured data off a page and leave evidence.

  extract  --url <u> | --file <p> | --stdin
           --select <css>            row selector (repeat container)
           --field name=<css>[@attr] column; name? = optional; @attr may be
                                     text (default), html, outerhtml, href, src, ...
           --auto                    infer the repeating structure instead
           --out <dir>               default ./.toolbay/scrape
           --name <slug>             artifact basename
           --limit N  --min-items N  --min-text N  --min-fill 0..1  --min-distinct 0..1
           --via fetch|browse        how to load --url (browse renders JS)
           --json                    one JSON document on stdout
           --no-raw                  do not keep the source bytes (makes verify fail closed)
           --allow-blocked --allow-soft-404 --allow-thin --allow-sparse
           --allow-duplicates --allow-truncated --allow-dead-source
                                     each relaxes exactly one named check

  verify   --artifact <path.json> [--allow-missing-raw]
  doctor
  selftest

Exit 0 means every check passed. Nothing else does.`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "extract": return await cmdExtract(rest);
      case "verify": return cmdVerify(rest);
      case "doctor": return cmdDoctor();
      case "selftest": return cmdSelftest();
      case "version": case "--version": process.stdout.write(`${VERSION}\n`); return 0;
      case undefined: case "help": case "--help": case "-h":
        process.stdout.write(USAGE + "\n");
        return cmd === undefined ? 1 : 0;
      default:
        process.stdout.write(`unknown command ${JSON.stringify(cmd)}\n\n${USAGE}\n`);
        return 1;
    }
  } catch (e) {
    if (e instanceof UserError) {
      process.stdout.write(`FAIL  ${e.message}\n\nVERDICT FAIL. Nothing was scraped.\n`);
      return 2;
    }
    // Even an unexpected crash exits non-zero with a named reason. A scraper
    // that dies must never look like a scraper that found nothing.
    process.stdout.write(`FAIL  tb-scrape crashed: ${e && e.stack ? e.stack.split("\n")[0] : e}\n\nVERDICT FAIL.\n`);
    return 3;
  }
}

main().then((code) => { process.exitCode = code; });
