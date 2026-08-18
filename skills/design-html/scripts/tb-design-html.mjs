#!/usr/bin/env node
/**
 * tb-design-html.mjs: the Toolbay Stack design-implementation engine.
 *
 * Four commands, one file:
 *   detect   what stack this repo actually is, so the markup targets it
 *   check    a real linter over generated markup (a11y, tokens, slop, boundaries)
 *   preview  a static server that prints the port it ACTUALLY bound
 *   selftest proof that all of the above catch what they claim to catch
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /design-html, the step order input-detection -> analysis -> framework
 * detection -> generate -> preview -> refine -> save, the "AI slop blacklist"
 * of things never to emit, the "real content, never lorem ipsum" rule, the
 * surgical-edit refinement loop, and the design-artifact path convention)
 * comes from `design-html` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS IS A REWRITE AND NOT A FORK
 *
 * gstack's design-html is a Pretext-native HTML generator. Every page it emits
 * is a single standalone .html file with a 30KB text-layout engine inlined and
 * `contenteditable` on the copy. That is a coherent product, but it is not a
 * thing you can paste into a Next app: the output has no components, no client
 * boundary, no Tailwind theme, and its layout is computed by JS that a server
 * component cannot run. Its own Step 2.5 asks "React component or vanilla
 * HTML?" and then hands back a file either way. So the port had to retarget the
 * OUTPUT (Next/React/Tailwind) while keeping the INPUT (the step order, the
 * slop blacklist, the fidelity rules), which is what this file does.
 *
 * Three concrete gstack behaviours it fixes, each reproduced on this machine
 * (Windows 11, Git Bash, gstack 1.60.1.0, 2026-08-14):
 *
 * 1. THE PREVIEW URL IS MALFORMED ON WINDOWS AND IS REPORTED AS WORKING.
 *    gstack Step 3.5 runs, verbatim:
 *
 *      python3 -m http.server 0 --bind 127.0.0.1 &
 *      _SERVER_PID=$!
 *      _PORT=$(lsof -i -P -n | grep "$_SERVER_PID" | grep LISTEN | awk '{print $9}' | cut -d: -f2 | head -1)
 *      echo "SERVER: http://localhost:$_PORT/finalized.html"
 *
 *    Observed output:
 *
 *      repro.sh: line 4: lsof: command not found
 *      Python was not found; run without arguments to install from the Microsoft Store...
 *      SERVER: http://localhost:/finalized.html
 *      PID: 893968
 *
 *    Port 0 means "kernel, pick a port", so the port is only knowable by asking
 *    the socket. gstack asks `lsof`, which does not exist on Windows, so $_PORT
 *    is empty and the skill then instructs the agent to tell the user "Live
 *    preview running at http://localhost:/finalized.html". Nothing is running:
 *    python3 on Windows is the Microsoft Store alias stub, which prints an
 *    advert and exits 49. The documented fallback is `open <path>`, which is
 *    also `command not found` here. Both the primary and the fallback fail, and
 *    the failure is announced as a success.
 *
 *    `preview` here binds the socket in-process and prints
 *    `server.address().port` — the port the OS actually assigned. There is no
 *    lsof, no python, and no shell. If the bind fails the command exits
 *    non-zero and prints nothing that looks like a URL.
 *
 * 2. FRAMEWORK DETECTION CANNOT SEE NEXT.JS OR TAILWIND. gstack Step 2.5 is:
 *
 *      cat package.json | grep -o '"react"\|"svelte"\|"vue"\|"@angular/core"\|"solid-js"\|"preact"' | head -1
 *
 *    Every Next.js project depends on react, and `head -1` takes the first
 *    match, so a Next 15 App Router + Tailwind v4 repo is classified "React"
 *    and offered "React component with Pretext hooks". Tailwind is not in the
 *    pattern at all, so the generated markup invents its own colours next to a
 *    theme that already exists. `detect` here reads package.json as JSON, tells
 *    App Router from Pages Router by looking for the router directory, and
 *    reports the Tailwind major version and the token file.
 *
 * 3. EVERY QUALITY RULE IS PROSE ADDRESSED TO THE MODEL THAT IS ABOUT TO BREAK
 *    IT. gstack's "Never include (AI slop blacklist)" and its accessibility
 *    requirements are a bullet list in SKILL.md. Nothing executes them, so
 *    "done" is asserted by the same model that wrote the file. `check` here
 *    turns that list into rules that run and exit non-zero, and Step 5 of the
 *    skill will not let the work be called finished until it exits 0.
 *
 * DESIGN RULES, same as the rest of Toolbay Stack:
 *
 *   1. FAIL CLOSED. `check` exits 2 — could not check — when it was handed
 *      nothing, handed a file it cannot read, handed an empty file, or handed
 *      an extension it has no rules for. gstack's degraded paths all continue
 *      ("skip verification and note...", "fall back to CDN"), which is the
 *      direction a quality gate must never fail. The one deliberate allow is
 *      documented at ruleRawHexColor(): with no token source in the repo there
 *      is no token to prefer, so the rule does not fire.
 *   2. NO INTERPRETER BUT NODE. No python, no lsof, no open, no bash. Those are
 *      the four things gstack's version needs and Windows does not have.
 *   3. PROVE IT. `selftest` runs the real linter over fixtures that are
 *      deliberately broken one rule at a time, asserts each specific rule id
 *      fires, asserts a clean fixture passes, asserts every could-not-check
 *      path exits 2, and starts the real preview server and fetches the URL it
 *      printed. A claim about a port is worth nothing until something has
 *      answered on it.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const NAME = path.basename(SELF);

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_CANNOT_CHECK = 2;

// ---------------------------------------------------------------- small utils

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

const CHECKABLE = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".css", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "out", ".turbo", "coverage", ".vercel"]);

function readJsonSafe(file) {
  // Returns {ok, value, reason}. Never throws, never guesses. A package.json
  // that exists but does not parse is NOT the same as one that is absent, and
  // collapsing the two is how gstack's grep reports "React" for a repo whose
  // manifest is broken.
  if (!fs.existsSync(file)) return { ok: false, value: null, reason: "absent" };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, value: null, reason: `unreadable: ${e.code || e.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw), reason: "" };
  } catch (e) {
    return { ok: false, value: null, reason: `malformed JSON: ${e.message}` };
  }
}

function walk(dir, acc = [], depth = 0) {
  if (depth > 12) return acc;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc, depth + 1);
    } else if (e.isFile() && CHECKABLE.has(path.extname(e.name).toLowerCase())) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

// ------------------------------------------------------------------- detect

/**
 * What stack is this, really.
 *
 * Every value printed here is read from a file, and anything that could not be
 * read is printed as `unknown` rather than as a default. `unknown` makes the
 * skill stop and ask; a default makes it generate the wrong kind of file
 * confidently, which is the gstack behaviour being replaced.
 */
function detectStack(root) {
  const r = {
    root,
    stack: "unknown",
    lang: "unknown",
    tailwind: "none",
    tokens: "none",
    ui: "none",
    pm: "npm",
    routerDir: "",
    problems: [],
  };

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    r.problems.push(`not a directory: ${root}`);
    return r;
  }

  const pkgPath = path.join(root, "package.json");
  const pkg = readJsonSafe(pkgPath);

  if (!pkg.ok && pkg.reason === "absent") {
    // No manifest at all is a real, correct answer: a folder of .html files.
    r.stack = "vanilla";
    r.lang = "js";
  } else if (!pkg.ok) {
    // Exists and is broken. gstack greps the raw text here and still answers
    // "React". We refuse, because a wrong answer costs a whole generated file.
    r.problems.push(`${pkgPath} ${pkg.reason}, so the stack cannot be determined`);
    return r;
  } else {
    const deps = { ...(pkg.value.dependencies || {}), ...(pkg.value.devDependencies || {}) };
    const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);

    if (has("next")) {
      // App Router vs Pages Router is the single most consequential fact about
      // a Next repo — it decides whether the file needs "use client" — and it
      // is invisible to a dependency grep. It is a directory, so look for one.
      const appDirs = [path.join(root, "app"), path.join(root, "src", "app")];
      const pagesDirs = [path.join(root, "pages"), path.join(root, "src", "pages")];
      const appDir = appDirs.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
      const pagesDir = pagesDirs.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
      if (appDir) {
        r.stack = "next-app";
        r.routerDir = appDir;
      } else if (pagesDir) {
        r.stack = "next-pages";
        r.routerDir = pagesDir;
      } else {
        r.stack = "next-app";
        r.problems.push("next is a dependency but neither app/ nor pages/ exists; assuming App Router");
      }
    } else if (has("@angular/core")) r.stack = "angular";
    else if (has("svelte")) r.stack = "svelte";
    else if (has("vue")) r.stack = "vue";
    else if (has("astro")) r.stack = "astro";
    else if (has("solid-js")) r.stack = "solid";
    else if (has("react")) r.stack = has("vite") ? "react-vite" : "react";
    else r.stack = "vanilla";

    r.lang = has("typescript") || fs.existsSync(path.join(root, "tsconfig.json")) ? "ts" : "js";

    const tw = deps.tailwindcss;
    if (tw) {
      const major = String(tw).replace(/^[^0-9]*/, "").split(".")[0];
      r.tailwind = major === "4" ? "v4" : major === "3" ? "v3" : `v${major || "unknown"}`;
    }
    if (fs.existsSync(path.join(root, "components.json"))) r.ui = "shadcn";
  }

  // Tailwind can also be present with no dependency entry yet (fresh scaffold),
  // and v4 moved configuration out of tailwind.config into CSS, so the config
  // file is no longer proof of anything on its own. Look at the CSS.
  const cssFiles = walk(root).filter((f) => f.endsWith(".css")).slice(0, 60);
  for (const f of cssFiles) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (/@import\s+["']tailwindcss["']/.test(text) && r.tailwind === "none") r.tailwind = "v4";
    if (/@tailwind\s+(base|components|utilities)/.test(text) && r.tailwind === "none") r.tailwind = "v3";
    if (r.tokens === "none" && (/@theme\s*\{/.test(text) || /:root\s*\{[^}]*--[a-z0-9-]+\s*:/i.test(text))) {
      r.tokens = path.relative(root, f) || f;
    }
  }
  if (r.tokens === "none") {
    for (const c of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"]) {
      if (fs.existsSync(path.join(root, c))) {
        r.tokens = c;
        break;
      }
    }
  }
  if (r.tokens === "none" && fs.existsSync(path.join(root, "DESIGN.md"))) r.tokens = "DESIGN.md";

  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) r.pm = "bun";
  else if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) r.pm = "pnpm";
  else if (fs.existsSync(path.join(root, "yarn.lock"))) r.pm = "yarn";

  return r;
}

function cmdDetect(args) {
  const root = path.resolve(args[0] || process.cwd());
  const r = detectStack(root);
  out(`ROOT: ${r.root}\n`);
  out(`STACK: ${r.stack}\n`);
  out(`LANG: ${r.lang}\n`);
  out(`TAILWIND: ${r.tailwind}\n`);
  out(`TOKENS: ${r.tokens}\n`);
  out(`UI: ${r.ui}\n`);
  out(`PM: ${r.pm}\n`);
  out(`ROUTER_DIR: ${r.routerDir ? path.relative(r.root, r.routerDir) || "." : "none"}\n`);
  for (const p of r.problems) out(`PROBLEM: ${p}\n`);
  if (r.stack === "unknown") {
    err(`\n${NAME}: the stack could not be determined, so no markup should be generated yet.\n`);
    err(`Stop and ask which framework this is rather than defaulting to one.\n`);
    return EXIT_CANNOT_CHECK;
  }
  return EXIT_OK;
}

// --------------------------------------------------------------------- check
//
// Below, every rule is a function that takes a prepared file context and
// returns findings. Rules are pure and independent so the selftest can prove
// each one fires on its own fixture, rather than proving "something failed".

const EMOJI = /\p{Extended_Pictographic}/u;

/** Strip HTML/JSX comments so a rule cannot fire on commented-out example code. */
function stripComments(text, ext) {
  let t = text.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  if (ext !== ".html" && ext !== ".htm") {
    t = t.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  }
  return t;
}

/** Line number for a character offset. 1-indexed, like every editor. */
function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

/**
 * Visible text inside a tag body, or null when it cannot be known statically.
 * Returning null on a JSX expression is deliberate: `<button>{label}</button>`
 * has an accessible name this linter cannot see, and a rule that guesses would
 * be turned off within a day.
 */
function visibleText(body) {
  if (/\{/.test(body)) return null;
  const stripped = body
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(EMOJI, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

/**
 * Find the `>` that actually closes an opening tag.
 *
 * The obvious implementation is `<button([^>]*)>` and it is wrong for JSX, in a
 * way that fails OPEN and is therefore worth the extra thirty lines. An arrow
 * function in a prop contains a greater-than sign:
 *
 *     <button className="h-9 w-9" onClick={() => setAnnual(!annual)}>
 *
 * `[^>]*` stops at the `>` inside `=>`, the tag never matches, and every rule
 * built on tag bodies goes quiet. That is not a missed edge case: an onClick
 * handler is present on essentially every interactive element in a React
 * codebase, so the accessible-name and tap-target rules would have reported
 * clean on the exact files they exist to check. Found by running this linter on
 * a realistic generated page rather than on its own fixtures, which is why the
 * fixture set now includes one.
 *
 * So: walk the characters, and only accept a `>` that is outside every string
 * and outside every JSX brace expression.
 */
function scanOpenTag(text, start) {
  let i = start;
  let quote = "";
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ">" && depth === 0) {
      return { end: i, selfClosing: text[i - 1] === "/" };
    }
  }
  return null;
}

/**
 * Every occurrence of one tag, with its attribute text and its body.
 * Non-nested bodies only, which is correct for button, a, img and heading tags.
 */
function findTagBodies(text, tag) {
  const hits = [];
  const open = new RegExp(`<${tag}(?=[\\s/>])`, "gi");
  let m;
  while ((m = open.exec(text)) !== null) {
    const scanned = scanOpenTag(text, m.index + tag.length + 1);
    if (!scanned) break;
    const attrs = text.slice(m.index + tag.length + 1, scanned.end).replace(/\/$/, "");
    if (scanned.selfClosing) {
      hits.push({ attrs, body: "", index: m.index, selfClosing: true });
      open.lastIndex = scanned.end;
      continue;
    }
    const close = text.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, scanned.end);
    hits.push({
      attrs,
      body: close === -1 ? "" : text.slice(scanned.end + 1, close),
      index: m.index,
      selfClosing: false,
    });
    open.lastIndex = scanned.end;
  }
  return hits;
}

// --- a11y and correctness rules

function ruleHtmlNoLang(c) {
  if (!c.isHtmlDoc) return [];
  const m = /<html(\s[^>]*)?>/i.exec(c.text);
  if (!m) return [];
  if (/\slang\s*=/i.test(m[1] || "")) return [];
  return [f(c, "html-no-lang", m.index, "<html> has no lang attribute; screen readers pick the wrong voice and hyphenation")];
}

function ruleHtmlNoViewport(c) {
  if (!c.isHtmlDoc) return [];
  if (/name\s*=\s*["']viewport["']/i.test(c.text)) return [];
  return [f(c, "html-no-viewport", 0, "no viewport meta tag; the page renders at desktop width on phones regardless of the CSS")];
}

function ruleImgNoAlt(c) {
  const findings = [];
  for (const tag of ["img", "Image"]) {
    for (const hit of findTagBodies(c.text, tag)) {
      if (/\salt\s*=/.test(hit.attrs)) continue;
      if (/\{\.\.\./.test(hit.attrs)) continue; // a spread prop may carry alt
      findings.push(f(c, "img-no-alt", hit.index, `<${tag}> has no alt attribute (use alt="" if it is decorative, which is a decision, not an omission)`));
    }
  }
  return findings;
}

function ruleHeadingSkip(c) {
  const findings = [];
  const re = /<h([1-6])[\s>]/g;
  let m;
  let prev = 0;
  while ((m = re.exec(c.text)) !== null) {
    const level = Number(m[1]);
    if (prev && level > prev + 1) {
      findings.push(f(c, "heading-skip", m.index, `heading jumps h${prev} to h${level}; the outline has a hole in it`));
    }
    prev = level;
  }
  return findings;
}

function ruleControlNoName(c) {
  const findings = [];
  for (const tag of ["button", "a"]) {
    for (const hit of findTagBodies(c.text, tag)) {
      if (/aria-label|aria-labelledby|\stitle\s*=/i.test(hit.attrs)) continue;
      const vis = visibleText(hit.body);
      if (vis === null) continue; // dynamic content, cannot know
      if (vis.length > 0) continue;
      findings.push(f(c, "control-no-name", hit.index, `<${tag}> has no accessible name: its content is icon-only and it carries no aria-label`));
    }
  }
  return findings;
}

function rulePositiveTabindex(c) {
  const findings = [];
  const re = /tab[iI]ndex\s*=\s*(?:["'](\d+)["']|\{\s*(\d+)\s*\})/g;
  let m;
  while ((m = re.exec(c.text)) !== null) {
    const v = Number(m[1] ?? m[2]);
    if (v > 0) findings.push(f(c, "positive-tabindex", m.index, `tabindex=${v} rewrites the tab order of the whole page; only 0 and -1 are safe`));
  }
  return findings;
}

function ruleFocusRemoved(c) {
  const re = /outline\s*:\s*(none|0)\b|focus:outline-none/g;
  const m = re.exec(c.text);
  if (!m) return [];
  if (/focus-visible|:focus-visible|focus-visible:/.test(c.text)) return [];
  return [f(c, "focus-removed", m.index, "the focus ring is removed with no focus-visible replacement; the page becomes unusable by keyboard")];
}

function ruleMotionUnguarded(c) {
  const re = /@keyframes\s|animation\s*:|transition\s*:|\banimate-[a-z]/g;
  const m = re.exec(c.text);
  if (!m) return [];
  if (/prefers-reduced-motion|motion-reduce:|motion-safe:/.test(c.text)) return [];
  return [f(c, "motion-unguarded", m.index, "animation with no prefers-reduced-motion guard; this triggers nausea for vestibular users and there is no way to turn it off")];
}

function ruleTapTargetSmall(c) {
  const findings = [];
  for (const hit of findTagBodies(c.text, "button")) {
    const vis = visibleText(hit.body);
    if (vis === null || vis.length > 0) continue; // icon-only buttons only
    const cls = /class(?:Name)?\s*=\s*["']([^"']*)["']/.exec(hit.attrs);
    if (!cls) continue;
    const h = /\bh-(\d+)\b/.exec(cls[1]);
    if (!h) continue;
    const px = Number(h[1]) * 4;
    if (px >= 44) continue;
    findings.push(f(c, "tap-target-small", hit.index, `icon-only button is ${px}px tall (h-${h[1]}); the minimum reliable touch target is 44px`));
  }
  return findings;
}

// --- the AI slop blacklist, made executable
//
// This is gstack's "Never include" bullet list, one rule per bullet. The list
// is his; the enforcement is the point of the rewrite. A blacklist written to
// the model that is about to generate the file is a suggestion. A blacklist
// that exits 1 is a rule.

const SLOP_PURPLE_HEX = ["#8b5cf6", "#6366f1", "#a855f7", "#7c3aed", "#4f46e5", "#818cf8", "#c084fc"];
const SLOP_BLUE_HEX = ["#3b82f6", "#2563eb", "#60a5fa", "#0ea5e9", "#1d4ed8"];

function ruleSlopGradient(c) {
  const findings = [];
  const classRe = /class(?:Name)?\s*=\s*["']([^"']*)["']/g;
  let m;
  while ((m = classRe.exec(c.text)) !== null) {
    const cls = m[1];
    if (!/\bbg-gradient|\bbg-linear/.test(cls)) continue;
    const from = /\bfrom-(purple|violet|indigo|fuchsia|blue|sky)-\d+/.exec(cls);
    const to = /\bto-(purple|violet|indigo|fuchsia|blue|sky|pink)-\d+/.exec(cls);
    if (from && to) {
      findings.push(f(c, "slop-gradient", m.index, `the default generated-website gradient (${from[0]} ${to[0]}); if the mockup did not ask for it, it is filler`));
    }
  }
  const gradRe = /linear-gradient\(([^)]*)\)/gi;
  while ((m = gradRe.exec(c.text)) !== null) {
    const body = m[1].toLowerCase();
    const p = SLOP_PURPLE_HEX.some((h) => body.includes(h));
    const b = SLOP_BLUE_HEX.some((h) => body.includes(h));
    if (p && b) findings.push(f(c, "slop-gradient", m.index, "purple-to-blue linear-gradient in raw hex; this is the house style of every generated landing page"));
  }
  return findings;
}

const SLOP_CTAS = new Set(["get started", "learn more", "get started free", "start free trial", "try it free", "sign up free"]);

function ruleSlopCta(c) {
  const findings = [];
  for (const tag of ["button", "a"]) {
    for (const hit of findTagBodies(c.text, tag)) {
      const vis = visibleText(hit.body);
      if (!vis) continue;
      if (SLOP_CTAS.has(vis.toLowerCase())) {
        findings.push(f(c, "slop-cta", hit.index, `"${vis}" is a placeholder CTA, not a decision; say what happens when it is clicked`));
      }
    }
  }
  return findings;
}

function ruleSlopEmojiIcon(c) {
  const findings = [];
  const tags = ["button", "a", "h1", "h2", "h3"];
  for (const tag of tags) {
    for (const hit of findTagBodies(c.text, tag)) {
      if (!EMOJI.test(hit.body)) continue;
      findings.push(f(c, "slop-emoji-icon", hit.index, `emoji used as a visual element inside <${tag}>; it renders differently on every platform and reads as filler`));
    }
  }
  return findings;
}

const PLACEHOLDER_COPY = [
  /lorem\s+ipsum/i,
  /your\s+(text|content|headline|title)\s+here/i,
  /description\s+goes\s+here/i,
  /\bplaceholder\s+text\b/i,
  /\bTODO:?\s*copy\b/i,
  /\bcompany\s+name\s+here\b/i,
];

function rulePlaceholderCopy(c) {
  const findings = [];
  for (const re of PLACEHOLDER_COPY) {
    const m = re.exec(c.text);
    if (m) findings.push(f(c, "placeholder-copy", m.index, `placeholder copy left in the markup ("${m[0].trim()}"); real content is part of the design, not a later step`));
  }
  return findings;
}

function ruleSlopBlob(c) {
  const findings = [];
  for (const hit of findTagBodies(c.text, "div")) {
    if (hit.body.trim().length) continue; // an empty div is the whole tell
    if (!/\babsolute\b/.test(hit.attrs)) continue;
    if (!/\bblur-(2xl|3xl)\b/.test(hit.attrs)) continue;
    if (!/\brounded-full\b/.test(hit.attrs)) continue;
    findings.push(f(c, "slop-blob", hit.index, "an empty absolutely-positioned blurred circle; decorative blobs are the default output of a model with nothing to say"));
  }
  return findings;
}

// --- token discipline

function ruleRawHexColor(c) {
  // DELIBERATE ALLOW-ON-ABSENCE: with no token source anywhere in the repo,
  // there is no token to prefer and every colour has to be written literally
  // somewhere. This rule only fires once the project HAS a palette, which is
  // exactly when a stray hex is a real inconsistency rather than a style
  // opinion. This is the only rule in the file that does nothing when it
  // cannot decide, and it is the only one where doing nothing is correct.
  if (!c.hasTokens || c.isTokenFile) return [];
  // Two carve-outs, both found by the selftest's clean-file assertion rather
  // than by imagination. Inline SVG icons legitimately carry literal fills, and
  // a custom-property DECLARATION (`--ink: #101014`) is the one place a literal
  // hex is not a stray: it is the token itself. A rule that fires on the
  // definition of the thing it wants you to use gets switched off in a day.
  let text = c.text.replace(/<svg[\s\S]*?<\/svg>/gi, (m) => " ".repeat(m.length));
  text = text.replace(/--[a-z0-9-]+\s*:\s*[^;}\n]+/gi, (m) => " ".repeat(m.length));
  const findings = [];
  const re = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    findings.push(f(c, "raw-hex-color", m.index, `hardcoded ${m[0]} while the project defines tokens in ${c.tokensPath}; the palette stops being one palette`));
  }
  return findings;
}

function ruleArbitraryValueSoup(c) {
  const re = /\b(?:w|h|p|m|px|py|mx|my|gap|top|left|right|bottom|text|rounded|max-w|min-h)-\[[^\]]+\]/g;
  const hits = [...c.text.matchAll(re)];
  if (hits.length <= 6) return [];
  return [f(c, "arbitrary-value-soup", hits[0].index, `${hits.length} Tailwind arbitrary values in one file; these are magic numbers wearing a class name, and they will not stay in step with the scale`)];
}

// --- React / Next correctness

const CLIENT_ONLY = /\buse(State|Effect|Reducer|Ref|LayoutEffect|Context|Callback|Memo)\s*\(|\bon(Click|Change|Submit|Input|KeyDown|Focus|Blur)\s*=|framer-motion|window\.|document\./;

function ruleMissingClientBoundary(c) {
  if (c.stack !== "next-app") return [];
  if (c.ext !== ".tsx" && c.ext !== ".jsx") return [];
  const head = c.text.slice(0, 400);
  if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(head)) return [];
  const m = CLIENT_ONLY.exec(c.text);
  if (!m) return [];
  return [
    f(
      c,
      "missing-client-boundary",
      m.index,
      `uses ${m[0].replace(/\s*[=(]$/, "")} but has no "use client" directive; in the App Router this is a server component and this fails at build time, not in review`,
    ),
  ];
}

function ruleDangerousHtml(c) {
  const i = c.text.indexOf("dangerouslySetInnerHTML");
  if (i === -1) return [];
  return [f(c, "dangerous-html", i, "dangerouslySetInnerHTML in generated markup; unless the source is provably trusted this is an XSS sink introduced by a design task")];
}

// --- self-containment

function ruleExternalAsset(c) {
  if (!c.isHtmlDoc) return [];
  const findings = [];
  const re = /<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(c.text)) !== null) {
    findings.push(f(c, "external-asset", m.index, `<${m[1]}> loads ${m[2]} from the network; a file described as a self-contained preview must not go dark when the CDN does`));
  }
  const imp = /import\s[^;]*?["'](https?:\/\/[^"']+)["']/g;
  while ((m = imp.exec(c.text)) !== null) {
    findings.push(f(c, "external-asset", m.index, `ES import from ${m[1]}; same problem, and it fails silently with no console error the user will read`));
  }
  return findings;
}

const RULES = [
  ruleHtmlNoLang,
  ruleHtmlNoViewport,
  ruleImgNoAlt,
  ruleHeadingSkip,
  ruleControlNoName,
  rulePositiveTabindex,
  ruleFocusRemoved,
  ruleMotionUnguarded,
  ruleTapTargetSmall,
  ruleSlopGradient,
  ruleSlopCta,
  ruleSlopEmojiIcon,
  rulePlaceholderCopy,
  ruleSlopBlob,
  ruleRawHexColor,
  ruleArbitraryValueSoup,
  ruleMissingClientBoundary,
  ruleDangerousHtml,
  ruleExternalAsset,
];

function f(c, rule, index, message) {
  return { file: c.file, rule, line: lineAt(c.rawText, index), message };
}

/**
 * Suppressions must carry a reason.
 *
 * `tb-check-disable <rule> -- <reason>` on the line above or the same line
 * silences one rule on that line. A disable with no reason is itself reported,
 * because an unexplained suppression is how a gate becomes decoration.
 */
function collectSuppressions(rawText) {
  const byLine = new Map();
  const bare = [];
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /tb-check-disable\s+([a-z-]+)(?:\s*--\s*(.*))?/.exec(lines[i]);
    if (!m) continue;
    const reason = (m[2] || "").replace(/\*\/|-->|\}/g, "").trim();
    if (reason.length < 8) {
      bare.push({ line: i + 1, rule: m[1] });
      continue;
    }
    for (const target of [i + 1, i + 2]) {
      if (!byLine.has(target)) byLine.set(target, new Set());
      byLine.get(target).add(m[1]);
    }
  }
  return { byLine, bare };
}

function checkFile(file, opts) {
  const ext = path.extname(file).toLowerCase();
  let rawText;
  try {
    rawText = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { fatal: `cannot read ${file} (${e.code || e.message})` };
  }
  if (rawText.trim().length === 0) {
    // An empty file is the single most common way a generation step fails, and
    // it passes every content rule ever written. Treat it as could-not-check.
    return { fatal: `${file} is empty, so nothing was checked; an empty output file is a failed generation, not a clean one` };
  }
  if (rawText.includes(" ")) {
    return { fatal: `${file} contains NUL bytes and is not text, so no rule could run on it` };
  }

  const c = {
    file,
    ext,
    rawText,
    text: stripComments(rawText, ext),
    isHtmlDoc: (ext === ".html" || ext === ".htm") && /<html/i.test(rawText),
    isTokenFile:
      /(^|[\\/])(globals?|theme|tokens|variables)\.css$/i.test(file) ||
      /tailwind\.config\./i.test(file) ||
      /DESIGN\.md$/i.test(file),
    stack: opts.stack,
    hasTokens: opts.tokens !== "none" && opts.tokens !== "",
    tokensPath: opts.tokens,
  };

  const { byLine, bare } = collectSuppressions(rawText);
  let findings = [];
  for (const rule of RULES) findings.push(...rule(c));
  findings = findings.filter((fd) => !(byLine.get(fd.line)?.has(fd.rule)));
  for (const b of bare) {
    findings.push({ file, rule: "disable-without-reason", line: b.line, message: `tb-check-disable ${b.rule} with no reason after "--"; an unexplained suppression turns the gate off without saying so` });
  }
  if (opts.only.size) findings = findings.filter((fd) => opts.only.has(fd.rule));
  if (opts.ignore.size) findings = findings.filter((fd) => !opts.ignore.has(fd.rule));
  return { findings };
}

function cmdCheck(args) {
  const opts = { only: new Set(), ignore: new Set(), json: false, stack: "", tokens: "" };
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--only") opts.only = new Set((args[++i] || "").split(",").filter(Boolean));
    else if (a === "--ignore") opts.ignore = new Set((args[++i] || "").split(",").filter(Boolean));
    else if (a === "--stack") opts.stack = args[++i] || "";
    else if (a === "--tokens") opts.tokens = args[++i] || "";
    else if (a.startsWith("--")) {
      err(`${NAME}: unknown option ${a}\n`);
      return EXIT_CANNOT_CHECK;
    } else targets.push(a);
  }

  if (!targets.length) {
    // Fail closed on an empty invocation. `check` with no arguments printing
    // "0 problems" would be the most dangerous line this file could emit.
    err(`${NAME} check: no files given, so nothing was checked. This is a failure, not a pass.\n`);
    err(`Usage: node ${NAME} check <file-or-dir>... [--stack next-app] [--tokens app/globals.css]\n`);
    return EXIT_CANNOT_CHECK;
  }

  // Fill in stack/tokens from the repo when not stated, so the caller cannot
  // accidentally disable the Next-specific and token-specific rules by
  // forgetting a flag.
  if (!opts.stack || !opts.tokens) {
    const probe = detectStack(process.cwd());
    if (!opts.stack) opts.stack = probe.stack;
    if (!opts.tokens) opts.tokens = probe.tokens;
  }

  const files = [];
  const fatals = [];
  for (const t of targets) {
    const p = path.resolve(t);
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      fatals.push(`${t} does not exist or cannot be stat'd (${e.code || e.message})`);
      continue;
    }
    if (st.isDirectory()) {
      const found = walk(p);
      if (!found.length) fatals.push(`${t} contains no checkable files (${[...CHECKABLE].join(", ")})`);
      files.push(...found);
    } else if (!CHECKABLE.has(path.extname(p).toLowerCase())) {
      // Explicitly named and not checkable: refuse. Silently skipping a file
      // the caller asked about is how "all checks passed" gets printed for a
      // file that has no rules behind it.
      fatals.push(`${t} has extension ${path.extname(p) || "(none)"}, which this linter has no rules for, so it was NOT checked`);
    } else files.push(p);
  }

  const allFindings = [];
  for (const file of files) {
    const r = checkFile(file, opts);
    if (r.fatal) fatals.push(r.fatal);
    else allFindings.push(...r.findings);
  }

  if (opts.json) {
    out(JSON.stringify({ platform: process.platform, stack: opts.stack, tokens: opts.tokens, checked: files.length, fatals, findings: allFindings }, null, 2) + "\n");
  } else {
    out(`\n  tb-design-html check  (${files.length} file${files.length === 1 ? "" : "s"}, stack ${opts.stack}, tokens ${opts.tokens})\n\n`);
    if (fatals.length) {
      for (const x of fatals) out(`  CANNOT CHECK  ${x}\n`);
      out("\n");
    }
    const byFile = new Map();
    for (const fd of allFindings) {
      if (!byFile.has(fd.file)) byFile.set(fd.file, []);
      byFile.get(fd.file).push(fd);
    }
    for (const [file, fds] of byFile) {
      out(`  ${path.relative(process.cwd(), file) || file}\n`);
      for (const fd of fds.sort((a, b) => a.line - b.line)) {
        out(`    ${String(fd.line).padStart(4)}  ${fd.rule.padEnd(24)} ${fd.message}\n`);
      }
      out("\n");
    }
  }

  if (fatals.length) {
    if (!opts.json) err(`  ${fatals.length} thing(s) could not be checked. Exiting 2: an unchecked file is not a clean file.\n\n`);
    return EXIT_CANNOT_CHECK;
  }
  if (allFindings.length) {
    if (!opts.json) err(`  ${allFindings.length} finding(s). Exiting 1: this markup is not ready to be called done.\n\n`);
    return EXIT_FINDINGS;
  }
  if (!opts.json) out(`  Clean. ${files.length} file(s) checked against ${RULES.length} rules.\n\n`);
  return EXIT_OK;
}

// ------------------------------------------------------------------- preview

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** The platform-correct way to open a URL. There is no `open` on Windows. */
function openCommand(url) {
  if (process.platform === "win32") return `cmd /c start "" "${url}"`;
  if (process.platform === "darwin") return `open "${url}"`;
  return `xdg-open "${url}"`;
}

function cmdOpenCmd(args) {
  out(openCommand(args[0] || "http://127.0.0.1:0/") + "\n");
  return EXIT_OK;
}

function cmdPreview(args) {
  let dir = "";
  let port = 0;
  let entry = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]) || 0;
    else if (args[i] === "--file") entry = args[++i] || "";
    else if (!args[i].startsWith("--")) dir = args[i];
  }
  const root = path.resolve(dir || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    err(`${NAME} preview: ${root} is not a directory. Nothing was served.\n`);
    return EXIT_CANNOT_CHECK;
  }
  if (!entry) {
    const candidates = ["index.html", "finalized.html", "preview.html"];
    entry = candidates.find((n) => fs.existsSync(path.join(root, n))) || "";
    if (!entry) {
      const html = fs.readdirSync(root).filter((n) => n.endsWith(".html"));
      entry = html[0] || "";
    }
  }
  if (!entry) {
    err(`${NAME} preview: no .html file in ${root}. Refusing to print a URL that would 404.\n`);
    return EXIT_CANNOT_CHECK;
  }

  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end("bad path");
      return;
    }
    if (rel === "/") rel = `/${entry}`;
    // Resolve first, then prove the result is still inside the root. Comparing
    // strings before resolving is how directory traversal gets through.
    const target = path.resolve(root, "." + rel);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (target !== root && !target.startsWith(rootWithSep)) {
      res.writeHead(403).end("outside the preview root");
      return;
    }
    fs.readFile(target, (e, buf) => {
      if (e) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404 ${rel}`);
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(buf);
    });
  });

  server.on("error", (e) => {
    // Fail loudly and print nothing URL-shaped. gstack's version prints a URL
    // whether or not anything is listening.
    err(`${NAME} preview: could not bind (${e.code || e.message}). No server is running.\n`);
    process.exitCode = EXIT_CANNOT_CHECK;
  });

  server.listen(port, "127.0.0.1", () => {
    // The authoritative port, straight off the bound socket. No lsof, no
    // parsing of another process's output, nothing that can come back empty
    // and leave "http://localhost:/" in its place.
    const actual = server.address().port;
    const url = `http://127.0.0.1:${actual}/${entry}`;
    out(`ROOT: ${root}\n`);
    out(`PORT: ${actual}\n`);
    out(`URL: ${url}\n`);
    out(`OPEN: ${openCommand(url)}\n`);
    out(`PID: ${process.pid}\n`);
    out(`STOP: taskkill /PID ${process.pid} /F\n`.replace("taskkill /PID", process.platform === "win32" ? "taskkill /PID" : "kill"));
  });
  return null; // stay alive
}

// -------------------------------------------------------------------- doctor

/**
 * Whether a command is on PATH is the wrong question, and asking it is the same
 * class of mistake this whole file exists to remove.
 *
 * On this machine `where python3` succeeds: there is a file called python3.exe
 * in WindowsApps. Running it prints "Python was not found; run without
 * arguments to install from the Microsoft Store" and exits non-zero (49 when
 * launched through Git Bash, 9009 when spawned directly). A doctor that
 * reports that as "present" has told the caller the opposite of the truth, and
 * it is precisely how gstack's `python3 -m http.server ... || true` ends up
 * silently doing nothing. So: run the thing, and judge it by whether it worked.
 */
function probeBinary(bin, args) {
  const res = spawnSync(bin, args, { encoding: "utf8", shell: false, timeout: 8000 });
  if (res.error) return { state: "ABSENT ", note: res.error.code === "ENOENT" ? "not on PATH" : String(res.error.code || res.error.message) };
  const text = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (res.status !== 0) {
    if (/Microsoft Store|App execution alias/i.test(text)) {
      return { state: "STUB   ", note: `on PATH but not real: exits ${res.status} with the Microsoft Store alias advert` };
    }
    return { state: "BROKEN ", note: `on PATH but exited ${res.status}` };
  }
  return { state: "present", note: text.split(/\r?\n/)[0].slice(0, 48) };
}

function cmdDoctor() {
  out(`\n  tb-design-html doctor  (node ${process.version}, ${process.platform})\n\n`);
  const needed = [
    ["node", ["--version"], "required by this engine", true],
    ["python3", ["--version"], "gstack design-html Step 3.5 preview server", false],
    ["lsof", ["-v"], "gstack design-html Step 3.5 port discovery", false],
    ["open", ["--help"], "gstack design-html preview fallback and comparison boards", false],
  ];
  let engineOk = true;
  for (const [bin, args, why, required] of needed) {
    const p = probeBinary(bin, args);
    if (required && p.state !== "present") engineOk = false;
    out(`  ${p.state}  ${bin.padEnd(9)} ${required ? why : `needed by: ${why}`}\n`);
    out(`            ${p.note}\n`);
  }
  out(`\n  This engine needs only node. Every line above that is not "present" is a\n`);
  out(`  dependency of the gstack version that this port removed rather than worked\n`);
  out(`  around. Note that PATH membership is not the test: a binary is reported\n`);
  out(`  present only if running it succeeded.\n\n`);
  return engineOk ? EXIT_OK : EXIT_CANNOT_CHECK;
}

// ------------------------------------------------------------------ selftest
//
// Same contract as tb-guard: run the REAL executable as a child process over
// fixtures that are deliberately broken, one rule at a time, and fail loudly if
// any of them come back clean. An in-process assertion would not prove the
// exit codes, and the exit codes are what a caller gates on.

function runCheck(args, cwd) {
  const res = spawnSync(process.execPath, [SELF, "check", ...args], { encoding: "utf8", cwd });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, stdout: res.stdout, stderr: res.stderr };
}

const CLEAN_TSX = `"use client";
import Image from "next/image";

export function PricingPanel({ plans }) {
  return (
    <section aria-labelledby="pricing-heading" className="bg-surface text-ink">
      <h1 id="pricing-heading" className="text-3xl">What a seat costs</h1>
      <h2 className="text-xl">Billed monthly, cancel from the dashboard</h2>
      <Image src="/seat-diagram.svg" alt="One seat covers one broker and unlimited viewers" width={480} height={240} />
      <button onClick={() => plans.select("team")} className="bg-accent focus-visible:ring-2">
        Put four brokers on this
      </button>
      <a href="/billing">See the invoice this generates</a>
    </section>
  );
}
`;

const CLEAN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seat pricing</title>
<style>
  :root { --ink: #101014; }
  body { color: var(--ink); }
  .fade { transition: opacity 120ms ease; }
  @media (prefers-reduced-motion: reduce) { .fade { transition: none; } }
  a:focus-visible { outline: 2px solid var(--ink); }
</style>
</head>
<body>
<h1>What a seat costs</h1>
<h2>Billed monthly</h2>
<p>Four brokers, one invoice, cancelled from the dashboard in two clicks.</p>
<a href="/billing">See the invoice this generates</a>
</body>
</html>
`;

/**
 * One fixture per rule. The point of one-rule-per-fixture is that a passing
 * selftest proves each rule fires on its own, rather than proving that a file
 * full of problems produced some problems.
 */
const FIXTURES = [
  ["html-no-lang", "a.html", `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>Rates</h1></body></html>`],
  ["html-no-viewport", "b.html", `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>Rates</h1></body></html>`],
  ["img-no-alt", "c.tsx", `export const A = () => <div><img src="/floorplan.png" /></div>;`],
  ["heading-skip", "d.html", `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body><h1>A</h1><h3>B</h3></body></html>`],
  ["control-no-name", "e.tsx", `export const A = () => <button className="p-2"><svg viewBox="0 0 1 1"></svg></button>;`],
  ["positive-tabindex", "f.tsx", `export const A = () => <input tabIndex={3} aria-label="Search listings" />;`],
  ["focus-removed", "g.css", `.btn { outline: none; }`],
  ["motion-unguarded", "h.css", `.card { transition: transform 200ms ease; }`],
  ["tap-target-small", "i.tsx", `export const A = () => <button className="h-8 w-8"><svg viewBox="0 0 1 1"></svg></button>;`],
  ["slop-gradient", "j.tsx", `export const A = () => <div className="bg-gradient-to-r from-purple-500 to-blue-500">x</div>;`],
  ["slop-cta", "k.tsx", `export const A = () => <button>Get Started</button>;`],
  ["slop-emoji-icon", "l.tsx", `export const A = () => <h2>\u{1F680} Fast leasing</h2>;`],
  ["placeholder-copy", "m.html", `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body><p>Lorem ipsum dolor sit amet</p></body></html>`],
  ["slop-blob", "n.tsx", `export const A = () => <div className="absolute blur-3xl rounded-full bg-accent"></div>;`],
  ["raw-hex-color", "o.tsx", `export const A = () => <div style={{ color: "#ff0055" }}>Rent roll</div>;`],
  [
    "arbitrary-value-soup",
    "p.tsx",
    `export const A = () => <div className="w-[317px] h-[42px] p-[13px] m-[7px] gap-[11px] text-[13.5px] rounded-[9px]">Rent roll</div>;`,
  ],
  ["missing-client-boundary", "q.tsx", `import { useState } from "react";\nexport function A(){ const [v,setV] = useState(0); return <p>{v}</p>; }`],
  ["dangerous-html", "r.tsx", `export const A = ({h}) => <div dangerouslySetInnerHTML={{ __html: h }} />;`],
  [
    "external-asset",
    "s.html",
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><script src="https://cdn.example.com/x.js"></script></head><body><h1>A</h1></body></html>`,
  ],
  ["disable-without-reason", "t.tsx", `// tb-check-disable img-no-alt\nexport const A = () => <img src="/x.png" />;`],
  // --- regression fixtures, one per bug this linter actually shipped with.
  // The arrow-function one is the important one: `[^>]*` attribute matching
  // stopped at the `>` in `=>`, so every rule that reads a tag body went silent
  // on any element with an event handler, which is most of them. It reported
  // clean. These three keep that specific silence from returning.
  [
    "control-no-name",
    "u.tsx",
    `export const A = ({on}) => <button className="p-2" onClick={() => on(!open)}><svg viewBox="0 0 24 24"></svg></button>;`,
  ],
  [
    "tap-target-small",
    "v.tsx",
    `export const A = ({on}) => <button className="h-9 w-9" onClick={() => on(1 > 0)}><svg viewBox="0 0 24 24"></svg></button>;`,
  ],
  ["img-no-alt", "w.tsx", `export const A = ({go}) => <Image src="/a.png" width={2} height={1} onLoad={() => go(a > b)} />;`],
];

function fetchOnce(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.code || e.message) }));
  });
}

async function previewProbe(dir) {
  // Start the real server as a child, read the URL it printed, and fetch it.
  // This is the assertion gstack's Step 3.5 cannot make: it never learns
  // whether anything is listening on the port it announced.
  const child = spawn(process.execPath, [SELF, "preview", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), 6000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /^URL: (\S+)$/m.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
  let result = { url, status: 0, body: "", openLine: /^OPEN: (.*)$/m.exec(buf)?.[1] || "" };
  if (url) {
    const r = await fetchOnce(url);
    result.status = r.status;
    result.body = r.body;
  }
  child.kill();
  return result;
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-design-html-selftest-"));
  const fixDir = path.join(tmp, "fixtures");
  const cleanDir = path.join(tmp, "clean");
  const emptyDir = path.join(tmp, "empty");
  const serveDir = path.join(tmp, "serve");
  for (const d of [fixDir, cleanDir, emptyDir, serveDir]) fs.mkdirSync(d, { recursive: true });

  // A token source, so the token-discipline rules are live. Written as
  // globals.css because that is what the linter treats as a token file.
  fs.writeFileSync(path.join(tmp, "globals.css"), ":root { --ink: #101014; --accent: #b2542f; }\n", "utf8");
  const TOKENS = path.join(tmp, "globals.css");

  for (const [, file, body] of FIXTURES) fs.writeFileSync(path.join(fixDir, file), body, "utf8");
  fs.writeFileSync(path.join(cleanDir, "clean.tsx"), CLEAN_TSX, "utf8");
  fs.writeFileSync(path.join(cleanDir, "clean.html"), CLEAN_HTML, "utf8");
  fs.writeFileSync(path.join(tmp, "empty.tsx"), "   \n\n", "utf8");
  fs.writeFileSync(path.join(tmp, "notes.md"), "# not markup\n", "utf8");
  fs.writeFileSync(path.join(tmp, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  fs.renameSync(path.join(tmp, "logo.bin"), path.join(tmp, "logo.html"));
  fs.writeFileSync(path.join(serveDir, "finalized.html"), "<!doctype html><html lang=en><title>x</title><body><h1>SERVED-OK</h1>", "utf8");

  // A repo whose package.json exists but is corrupt. gstack greps it and still
  // answers "React"; detect must refuse.
  const brokenRepo = path.join(tmp, "broken-repo");
  fs.mkdirSync(brokenRepo, { recursive: true });
  fs.writeFileSync(path.join(brokenRepo, "package.json"), '{ "dependencies": { "next": ', "utf8");

  // A real-shaped Next App Router repo, to prove detect tells it from React.
  const nextRepo = path.join(tmp, "next-repo");
  fs.mkdirSync(path.join(nextRepo, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(nextRepo, "package.json"),
    JSON.stringify({ dependencies: { next: "15.1.0", react: "19.0.0", "react-dom": "19.0.0" }, devDependencies: { tailwindcss: "^4.0.0", typescript: "^5" } }),
    "utf8",
  );
  fs.writeFileSync(path.join(nextRepo, "app", "globals.css"), '@import "tailwindcss";\n@theme { --color-ink: #101014; }\n', "utf8");

  const results = [];
  const add = (name, expected, got, detail = "") => results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // --- 1. every rule fires on its own fixture
  for (const [rule, file] of FIXTURES) {
    const r = runCheck(["--json", "--tokens", TOKENS, "--stack", "next-app", path.join(fixDir, file)], tmp);
    const fired = r.json && r.json.findings.some((x) => x.rule === rule);
    add(`catches ${rule}`, "1 + rule fires", `${r.status} + ${fired ? "rule fires" : "SILENT"}`, r.stderr.trim().slice(0, 160));
    if (r.status !== EXIT_FINDINGS || !fired) {
      results[results.length - 1].pass = false;
      results[results.length - 1].got = `${r.status} + ${fired ? "rule fires" : "SILENT"}`;
    } else {
      results[results.length - 1].pass = true;
      results[results.length - 1].expected = "1 + rule fires";
    }
  }

  // --- 2. the clean fixture is genuinely clean
  // Without this, a linter that flagged every line would pass everything above.
  {
    const r = runCheck(["--json", "--tokens", TOKENS, "--stack", "next-app", cleanDir], tmp);
    const names = r.json ? r.json.findings.map((x) => `${x.rule}@${x.line}`).join(",") : "no json";
    add("clean markup passes with exit 0", 0, r.status, names);
  }

  // --- 3. fail closed: every path where the check could not be performed
  add("no arguments exits 2, not 0", EXIT_CANNOT_CHECK, runCheck([], tmp).status, "check with no files must never print a pass");
  add("missing file exits 2", EXIT_CANNOT_CHECK, runCheck(["--json", path.join(tmp, "nope.tsx")], tmp).status, "");
  add("empty file exits 2", EXIT_CANNOT_CHECK, runCheck(["--json", path.join(tmp, "empty.tsx")], tmp).status, "an empty generated file passes every content rule");
  add("binary file exits 2", EXIT_CANNOT_CHECK, runCheck(["--json", path.join(tmp, "logo.html")], tmp).status, "");
  add("unsupported extension exits 2", EXIT_CANNOT_CHECK, runCheck(["--json", path.join(tmp, "notes.md")], tmp).status, "silently skipping a named file is a false pass");
  add("directory with nothing checkable exits 2", EXIT_CANNOT_CHECK, runCheck(["--json", emptyDir], tmp).status, "");
  add("unknown option exits 2", EXIT_CANNOT_CHECK, runCheck(["--bogus", cleanDir], tmp).status, "");

  // --- 4. suppression needs a reason
  {
    const withReason = path.join(tmp, "supp.tsx");
    fs.writeFileSync(withReason, `// tb-check-disable img-no-alt -- decorative rule, alt is set by the CMS wrapper\nexport const A = () => <img src="/x.png" />;\n`, "utf8");
    const r = runCheck(["--json", "--tokens", TOKENS, "--stack", "next-app", withReason], tmp);
    add("a suppression with a reason silences the rule", 0, r.status, r.json ? JSON.stringify(r.json.findings) : "");
  }

  // --- 5. detect: the two things gstack's grep gets wrong
  {
    const r = spawnSync(process.execPath, [SELF, "detect", nextRepo], { encoding: "utf8" });
    const stack = /^STACK: (.*)$/m.exec(r.stdout)?.[1] || "";
    const tw = /^TAILWIND: (.*)$/m.exec(r.stdout)?.[1] || "";
    add("detect says next-app, not react", "next-app", stack, "gstack greps package.json and matches \"react\" first, so Next is invisible to it");
    add("detect finds tailwind v4", "v4", tw, "tailwind is not in gstack's detection pattern at all");
  }
  {
    const r = spawnSync(process.execPath, [SELF, "detect", brokenRepo], { encoding: "utf8" });
    add("detect refuses a corrupt package.json", EXIT_CANNOT_CHECK, r.status, "a wrong stack answer costs an entire generated file");
  }

  // --- 6. preview prints a port something actually answers on
  {
    const p = await previewProbe(serveDir);
    const portOk = /^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(p.url);
    add("preview URL contains a real port", "yes", portOk ? "yes" : `no (${p.url || "no URL printed"})`, "gstack prints http://localhost:/ here because lsof is absent");
    add("preview actually serves the file", 200, p.status, p.body.slice(0, 60));
    add("preview body is the file on disk", "yes", p.body.includes("SERVED-OK") ? "yes" : "no", "");
    const wantsStart = process.platform === "win32" ? /cmd \/c start/.test(p.openLine) : /open |xdg-open /.test(p.openLine);
    add("preview prints a platform-correct opener", "yes", wantsStart ? "yes" : `no (${p.openLine})`, "gstack documents `open`, which does not exist on Windows");
  }
  {
    const r = spawnSync(process.execPath, [SELF, "preview", path.join(tmp, "not-a-dir")], { encoding: "utf8" });
    const printedUrl = /URL:/.test(r.stdout);
    add("preview on a bad directory exits 2", EXIT_CANNOT_CHECK, r.status, "");
    add("preview on a bad directory prints NO url", "no url", printedUrl ? "PRINTED A URL" : "no url", "announcing a URL for a server that is not running is the gstack bug");
  }
  {
    // A directory with no .html must not get a URL either.
    const r = spawnSync(process.execPath, [SELF, "preview", emptyDir], { encoding: "utf8" });
    add("preview with no html exits 2", EXIT_CANNOT_CHECK, r.status, "");
  }

  // --- 7. path traversal out of the preview root is refused
  {
    const child = spawn(process.execPath, [SELF, "preview", serveDir], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const port = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(0), 6000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        buf += d;
        const m = /^PORT: (\d+)$/m.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    // The SLASH is what has to be encoded, and working that out took two runs
    // of this selftest. `/../globals.css` and `/%2e%2e/globals.css` are both
    // normalised away by the WHATWG URL parser before the handler sees them
    // (it decodes %2e for the purpose of dot-segment removal), so asserting on
    // either shape proves the parser works and says nothing about the guard.
    // %2f is preserved by the parser and only becomes a separator at
    // decodeURIComponent, so this is the request that actually arrives at the
    // containment check with `..` still in it.
    let status = 0;
    if (port) status = (await fetchOnce(`http://127.0.0.1:${port}/%2e%2e%2fglobals.css`)).status;
    child.kill();
    add("preview refuses traversal above its root", 403, status, "the file exists one level up, so a 404 here would mean the read was attempted");
  }

  // A selftest whose total depends on where it ran is a selftest that can
  // quietly stop asserting things. State the number, and make missing it a
  // failure in its own right.
  const EXPECTED = FIXTURES.length + 21;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly; the temp dir is not the assertion */
  }

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-design-html selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    out(`\n  This engine is NOT trustworthy in this state. Failures:\n`);
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    out("\n");
    process.exitCode = 1;
    return;
  }
  out(`\n  Every rule above fired on a file built to break exactly that rule, the clean\n`);
  out(`  file passed, every could-not-check path exited 2 rather than 0, and the\n`);
  out(`  preview URL was fetched and answered 200. Nothing here is asserted by\n`);
  out(`  description.\n\n`);
}

// ---------------------------------------------------------------------- main

function usage() {
  out(`
${NAME} — Toolbay Stack design implementation engine

  detect [dir]                     what stack this repo is, honestly
  check <file|dir>... [options]    lint generated markup (0 clean, 1 findings, 2 could not check)
      --stack <id>                 override detected stack (next-app enables client-boundary rules)
      --tokens <path>              token source; enables token-discipline rules
      --only a,b / --ignore a,b    filter rules
      --json                       machine-readable output
  preview <dir> [--port N] [--file f]   static server; prints the port it ACTUALLY bound
  open-cmd <url>                   the platform-correct command to open a URL
  doctor                           what this engine needs vs what gstack's needs
  selftest                         prove all of the above

Suppress one rule on one line with:  tb-check-disable <rule> -- <reason of 8+ chars>
`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "detect") process.exitCode = cmdDetect(rest);
else if (cmd === "check") process.exitCode = cmdCheck(rest);
else if (cmd === "preview") {
  // cmdPreview returns null when it is staying alive to serve, and an exit code
  // when it refused to start. Discarding that return value was a real bug in
  // this file: `preview <not-a-directory>` printed the refusal to stderr and
  // then exited 0, so a caller gating on the exit code would have carried on as
  // though a server were running. The selftest caught it. That is the entire
  // failure mode being ported away from, reintroduced by hand at the last line.
  const rc = cmdPreview(rest);
  if (rc !== null) process.exitCode = rc;
}
else if (cmd === "open-cmd") process.exitCode = cmdOpenCmd(rest);
else if (cmd === "doctor") process.exitCode = cmdDoctor();
else if (cmd === "selftest") await selftest();
else {
  usage();
  process.exitCode = cmd ? EXIT_CANNOT_CHECK : EXIT_OK;
}
