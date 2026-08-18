#!/usr/bin/env node
/**
 * tb-diagram.mjs: the Toolbay Stack diagram engine.
 *
 * English (or mermaid) in; a .mmd source, an editable .excalidraw scene, an
 * .svg and a .png out, and every one of them verified before the run reports
 * success.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /diagram
 * command, the "triplet" idea of source + editable scene + rendered raster,
 * the mermaid flowchart source as the single source of truth, the
 * re-render-from-an-edited-scene round trip, the 1950px raster default, and
 * the flowchart-only limitation on the editable artifact) comes from
 * `diagram` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY IT WAS REWRITTEN RATHER THAN FORKED LINE FOR LINE
 *
 * gstack's diagram skill is nine bash steps that hard-depend on the browse
 * daemon and a 9,645,479-byte vendored render bundle, stage that bundle into
 * /tmp under a `shasum` digest, and ship the mermaid source into the page by
 * splicing base64 into a shell command line. On Windows, three of those four
 * mechanisms are wrong, and the fourth is wrong everywhere:
 *
 *   1. It fails OPEN on the render itself. Every artifact is produced by the
 *      pair
 *          $B js "window.__renderMermaid(...).then(s => { window.__svg = s })"
 *          $B js "window.__svg" --out out.svg
 *      If the first call throws (bad mermaid, bundle not ready, wrong tab),
 *      `window.__svg` is never assigned, and the second call cheerfully writes
 *      the string `undefined` into out.svg. Nothing in the skill reads the
 *      file back. A 9-byte "diagram" is delivered as a success.
 *
 *   2. atob() is Latin-1. The skill transports the source as base64 and
 *      decodes it in the page with atob(), which yields one char per BYTE, so
 *      every non-ASCII label arrives mojibaked. The skill knows (there is a
 *      note about decodeURIComponent(escape(...))) but the commands it tells
 *      you to run do not do it.
 *
 *   3. /tmp is not one place on Windows. The bundle is staged to
 *      /tmp/gstack-diagram-render-$SHA.html and the diagrams themselves go to
 *      /tmp/gstack-diagrams when the cwd is not a git repository. Measured on
 *      this machine:
 *
 *        $ node -e "console.log(require('path').resolve('/tmp'))"
 *        C:\tmp
 *        bash /tmp is: C:\Users\orion\AppData\Local\Temp
 *
 *      Two different directories, both of which exist, neither of which the
 *      user would think to look in. Nothing here writes to /tmp: output goes
 *      to ./diagrams unless told otherwise, and the only temporary files are
 *      the browser profile and the raster wrapper, both via os.tmpdir().
 *
 *   4. The bundle staging also depends on `shasum`, which is a perl script
 *      rather than a coreutil, so its presence in Git Bash is an install
 *      detail. If it is missing the digest is empty, the staged path collapses
 *      to /tmp/gstack-diagram-render-.html, and the version collision the
 *      content-addressing existed to prevent is guaranteed rather than
 *      prevented. There is no staging step here at all.
 *
 * So the design rules here are:
 *
 *   1. NO DAEMON, NO BUNDLE, NO NETWORK for the common case. Flowcharts are
 *      parsed, laid out and emitted by this file. Zero dependencies. A machine
 *      with no browser at all still gets .mmd + .svg + .excalidraw.
 *   2. FAIL CLOSED. Every artifact is read back off disk and checked before
 *      the run reports success. An SVG that says "Syntax error", an SVG that
 *      is missing a label that was in the source, a PNG that is one flat
 *      colour, a scene with no elements: all of them are failures with a
 *      non-zero exit, not files.
 *   3. DETERMINISTIC. Same source in, byte-identical artifacts out, so a
 *      diagram checked into a repository does not churn the diff.
 *   4. PROVE IT. `selftest` runs this engine as a child process against
 *      deliberately broken inputs and fails loudly if any of them is accepted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const EXIT = { OK: 0, ARGS: 1, RENDER: 2, VERIFY: 3, BROWSER: 4 };

class UserError extends Error {
  constructor(message, exitCode = EXIT.ARGS) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------- arguments
//
// Every flag declares its arity. gstack's sibling tools decide arity from
// whatever token happens to follow the flag, which is how `--cover out.pdf`
// silently eats the output path. Unknown flags are an error; a value flag with
// no value is an error. Both of those are refusals, not guesses.

const FLAGS = {
  "--out": "value",
  "--slug": "value",
  "--engine": "value",
  "--png-width": "value",
  "--browser": "value",
  "--timeout": "value",
  "--bundle": "value",
  "--no-png": "bool",
  "--dark": "bool",
  "--json": "bool",
  "--quiet": "bool",
  "--verbose": "bool",
  "--force": "bool",
};

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    let name = tok;
    let inlineValue = null;
    const eq = tok.indexOf("=");
    if (eq > 2) {
      name = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }
    const kind = FLAGS[name];
    if (!kind) {
      throw new UserError(
        `unknown flag ${name}\n\nKnown flags: ${Object.keys(FLAGS).join(" ")}\n` +
          `Refusing to ignore it: an ignored flag is a setting you think you applied and did not.`,
      );
    }
    if (kind === "bool") {
      if (inlineValue !== null) throw new UserError(`${name} takes no value (got ${name}=${inlineValue})`);
      flags[name] = true;
      continue;
    }
    const value = inlineValue !== null ? inlineValue : argv[++i];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      throw new UserError(`${name} needs a value (got ${value === undefined ? "end of arguments" : value})`);
    }
    flags[name] = value;
  }
  return { flags, positional };
}

function intFlag(flags, name, def, { min, max }) {
  if (flags[name] === undefined) return def;
  const raw = String(flags[name]);
  if (!/^\d+$/.test(raw)) throw new UserError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new UserError(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

// ------------------------------------------------------------------- mermaid
//
// A parser for mermaid flowcharts (`graph`/`flowchart`, every direction, every
// node shape, every link style, edge labels, subgraphs, chains, and `&`
// groups). It is not a mermaid implementation and does not pretend to be. What
// it must never do is accept nonsense: a statement it cannot read is an error
// with a line number, not a node called `-->`.

const DIAGRAM_HEADER =
  /^(graph|flowchart)(?:\s+(TB|TD|BT|RL|LR))?\s*$/i;

const OTHER_MERMAID_TYPES = [
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "C4Context",
  "sankey-beta",
  "block-beta",
  "xychart-beta",
];

/** Longest first, so `-.->` is never read as `-.-` plus a stray `>`. */
const LINK_TOKENS = [
  ["<-->", { arrowStart: true, arrowEnd: true, style: "solid" }],
  ["<==>", { arrowStart: true, arrowEnd: true, style: "thick" }],
  ["<-.->", { arrowStart: true, arrowEnd: true, style: "dotted" }],
  ["-.->", { arrowEnd: true, style: "dotted" }],
  ["-.-", { style: "dotted" }],
  ["==>", { arrowEnd: true, style: "thick" }],
  ["===", { style: "thick" }],
  ["--o", { arrowEnd: true, endShape: "circle", style: "solid" }],
  ["--x", { arrowEnd: true, endShape: "cross", style: "solid" }],
  ["-->", { arrowEnd: true, style: "solid" }],
  ["---", { style: "solid" }],
  ["--", { style: "solid" }],
];

const SHAPES = [
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "parallelogram"],
  ["[\\", "\\]", "parallelogram-alt"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "flag"],
];

function decodeLabel(raw) {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    s = s.slice(1, -1);
  }
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">")
    .replace(/#35;/g, "#")
    .replace(/&nbsp;/g, " ");
  return s;
}

/**
 * Split on `;` at the top level only. A plain `line.split(";")` cuts mermaid's
 * own entity codes in half, because `#quot;` and `#35;` both end in one.
 */
function splitStatements(line) {
  const out = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (const ch of line) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a statement into node specs and the links between them, without a
 * regex that can see inside brackets. Quoted labels and labels containing `-`
 * are exactly where a naive split breaks.
 */
function splitStatement(stmt, lineNo) {
  const parts = [];
  const links = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === "]" || ch === ")" || ch === "}") {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (depth === 0 && (ch === "-" || ch === "=" || ch === "<")) {
      const matched = matchLink(stmt, i);
      if (matched) {
        parts.push(buf);
        links.push(matched.link);
        buf = "";
        i = matched.next - 1;
        continue;
      }
    }
    buf += ch;
  }
  if (quote) throw new UserError(`line ${lineNo}: unclosed ${quote} quote in ${JSON.stringify(stmt)}`, EXIT.RENDER);
  parts.push(buf);
  return { parts, links };
}

/**
 * Match a link at position i, including both label spellings:
 *   A -->|text| B      pipe form
 *   A -- text --> B    infix form
 */
function matchLink(s, i) {
  const rest = s.slice(i);
  let head = null;
  for (const [tok, spec] of LINK_TOKENS) {
    if (rest.startsWith(tok)) {
      head = { tok, spec };
      break;
    }
  }
  if (!head) return null;
  let cursor = i + head.tok.length;
  let label = null;

  // Pipe form: -->|text|
  if (s[cursor] === "|") {
    const close = s.indexOf("|", cursor + 1);
    if (close === -1) return null;
    label = decodeLabel(s.slice(cursor + 1, close));
    cursor = close + 1;
    return { link: { ...head.spec, label }, next: cursor };
  }

  // Infix form: `-- text -->`, `== text ==>`, `-. text .->`. Only the plain
  // openers can carry one, and there must be a closing link token after it.
  if (head.tok === "--" || head.tok === "==" || head.tok === "-.") {
    const tail = s.slice(cursor);
    const m = tail.match(/^([^|]*?)\s*(-\.->|-\.-|-->|--o|--x|---|==>|===|\.->|\.-)/);
    if (m && m[1].trim()) {
      const closer = m[2];
      const closerSpec =
        LINK_TOKENS.find(([t]) => t === closer)?.[1] ??
        (closer === ".->" ? { arrowEnd: true, style: "dotted" } : { style: "dotted" });
      return {
        link: { ...head.spec, ...closerSpec, label: decodeLabel(m[1]) },
        next: cursor + m[0].length,
      };
    }
  }
  if (head.tok === "--" || head.tok === "-.") {
    // A bare `--` with no closer is not a link, it is the start of a longer
    // token we did not recognise. Refuse rather than invent an edge.
    return null;
  }
  return { link: { ...head.spec, label: null }, next: cursor };
}

function parseNodeSpec(spec, lineNo) {
  const s = spec.trim();
  if (!s) return null;
  for (const [open, close, shape] of SHAPES) {
    const at = s.indexOf(open);
    if (at > 0 && s.endsWith(close) && s.length > at + open.length + close.length - 1) {
      const id = s.slice(0, at).trim();
      const label = decodeLabel(s.slice(at + open.length, s.length - close.length));
      if (!/^[\w.\-]+$/.test(id)) throw new UserError(`line ${lineNo}: ${JSON.stringify(id)} is not a usable node id`, EXIT.RENDER);
      return { id, label, shape };
    }
  }
  if (!/^[\w.\-]+$/.test(s)) {
    throw new UserError(
      `line ${lineNo}: cannot read ${JSON.stringify(spec.trim())} as a node.\n` +
        `A node is an id, optionally followed by a label in brackets: A, A[Label], A{Choice}, A((Circle)).`,
      EXIT.RENDER,
    );
  }
  return { id: s, label: null, shape: null };
}

function parseMermaid(src) {
  const rawLines = String(src).split(/\r?\n/);
  const head = rawLines.find((l) => l.trim() && !l.trim().startsWith("%%"));
  if (!head) throw new UserError("the mermaid source is empty", EXIT.ARGS);

  const headTrim = head.trim();
  const other = OTHER_MERMAID_TYPES.find((t) => headTrim.toLowerCase().startsWith(t.toLowerCase()));
  if (other) return { kind: other, flowchart: null };

  const m = headTrim.match(DIAGRAM_HEADER);
  if (!m) {
    throw new UserError(
      `the first line is ${JSON.stringify(headTrim)}, which is not a diagram declaration.\n` +
        `Expected one of: graph TD, graph LR, flowchart TD, flowchart LR, or one of ${OTHER_MERMAID_TYPES.slice(0, 6).join(", ")}.`,
      EXIT.RENDER,
    );
  }
  const direction = (m[2] || "TD").toUpperCase();

  const nodes = new Map();
  const edges = [];
  const clusters = [];
  const clusterStack = [];
  let sawStatement = false;

  const touch = (spec) => {
    const existing = nodes.get(spec.id);
    if (existing) {
      if (spec.label !== null) existing.label = spec.label;
      if (spec.shape !== null) existing.shape = spec.shape;
    } else {
      nodes.set(spec.id, {
        id: spec.id,
        label: spec.label ?? spec.id,
        shape: spec.shape ?? "rect",
        cluster: clusterStack.length ? clusterStack[clusterStack.length - 1] : null,
      });
    }
    const n = nodes.get(spec.id);
    if (n.cluster === null && clusterStack.length) n.cluster = clusterStack[clusterStack.length - 1];
    return n;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let line = rawLines[i];
    const commentAt = line.indexOf("%%");
    if (commentAt !== -1) line = line.slice(0, commentAt);
    line = line.trim();
    if (!line) continue;
    if (i === rawLines.indexOf(head)) continue;

    for (const stmt of splitStatements(line)) {
      if (/^subgraph\b/i.test(stmt)) {
        const rest = stmt.replace(/^subgraph\s*/i, "").trim();
        const spec = rest ? parseNodeSpec(rest, lineNo) : { id: `sub${clusters.length}`, label: null };
        const cluster = { id: spec.id, label: spec.label ?? spec.id, index: clusters.length };
        clusters.push(cluster);
        clusterStack.push(cluster.id);
        continue;
      }
      if (/^end$/i.test(stmt)) {
        clusterStack.pop();
        continue;
      }
      if (/^(direction|classDef|class|style|linkStyle|click|accTitle|accDescr)\b/i.test(stmt)) continue;

      const { parts, links } = splitStatement(stmt, lineNo);
      if (links.length === 0) {
        const spec = parseNodeSpec(parts[0], lineNo);
        if (spec) {
          touch(spec);
          sawStatement = true;
        }
        continue;
      }
      // `A --> B --> C` and `A & B --> C`
      const groups = parts.map((p) => {
        const members = p.split("&").map((x) => x.trim()).filter(Boolean);
        if (!members.length) {
          throw new UserError(
            `line ${lineNo}: an edge in ${JSON.stringify(stmt)} has nothing on one side.\n` +
              `Every link needs a node at both ends. Refusing to invent one.`,
            EXIT.RENDER,
          );
        }
        return members.map((mm) => touch(parseNodeSpec(mm, lineNo)));
      });
      for (let k = 0; k < links.length; k++) {
        for (const from of groups[k]) {
          for (const to of groups[k + 1]) {
            edges.push({ from: from.id, to: to.id, ...links[k] });
          }
        }
      }
      sawStatement = true;
    }
  }

  if (!sawStatement || nodes.size === 0) {
    throw new UserError(
      `the source declares "${headTrim}" and then says nothing.\n` +
        `A diagram with no nodes is not a diagram. Refusing to render an empty canvas.`,
      EXIT.RENDER,
    );
  }
  if (clusterStack.length) throw new UserError(`a subgraph was opened and never closed with "end"`, EXIT.RENDER);

  return { kind: "flowchart", flowchart: { direction, nodes: [...nodes.values()], edges, clusters } };
}

// -------------------------------------------------------------------- layout
//
// Layered layout: rank by longest path over the acyclic part, order inside
// each rank by barycentre, then assign coordinates. Cycles are ranked with
// their back edges removed and drawn as back edges, so a source with a cycle
// lays out instead of hanging, which is asserted in the selftest.

const FONT_SIZE = 14;
const LINE_HEIGHT = 19;
const PAD_X = 18;
const PAD_Y = 12;
const RANK_GAP = 70;
const NODE_GAP = 26;

/** Helvetica-ish advance widths. Good to a few percent, which is all a box needs. */
function charWidth(ch, size) {
  const code = ch.codePointAt(0);
  if (code > 0x2e80) return size; // CJK and friends are full width
  if ("iljt.,:;'`|! ".includes(ch)) return size * 0.3;
  if ("fr()[]{}/\\".includes(ch)) return size * 0.36;
  if ("mMW@%".includes(ch)) return size * 0.87;
  if (ch >= "A" && ch <= "Z") return size * 0.69;
  if (ch >= "0" && ch <= "9") return size * 0.56;
  return size * 0.54;
}

function textWidth(line, size = FONT_SIZE) {
  let w = 0;
  for (const ch of line) w += charWidth(ch, size);
  return w;
}

function measure(node) {
  const lines = String(node.label).split("\n");
  const w = Math.max(...lines.map((l) => textWidth(l)));
  const shape = node.shape;
  let width = Math.max(64, Math.ceil(w + PAD_X * 2));
  let height = Math.max(38, lines.length * LINE_HEIGHT + PAD_Y * 2);
  if (shape === "diamond" || shape === "hexagon") width = Math.ceil(width * 1.35);
  if (shape === "diamond") height = Math.ceil(height * 1.3);
  if (shape === "circle") {
    const d = Math.max(width, height);
    width = d;
    height = d;
  }
  if (shape === "parallelogram" || shape === "parallelogram-alt") width += 24;
  return { width, height, lines };
}

function layout(fc) {
  const byId = new Map(fc.nodes.map((n) => [n.id, n]));
  for (const n of fc.nodes) Object.assign(n, measure(n));

  // --- rank
  const out = new Map(fc.nodes.map((n) => [n.id, []]));
  const indeg = new Map(fc.nodes.map((n) => [n.id, 0]));
  const backEdges = new Set();

  // Find back edges with a DFS so the ranking graph is acyclic.
  const state = new Map(fc.nodes.map((n) => [n.id, 0]));
  const adj = new Map(fc.nodes.map((n) => [n.id, []]));
  fc.edges.forEach((e, i) => adj.get(e.from).push({ i, to: e.to }));
  const dfs = (id) => {
    state.set(id, 1);
    for (const { i, to } of adj.get(id)) {
      if (to === id) {
        backEdges.add(i);
        continue;
      }
      const st = state.get(to);
      if (st === 1) backEdges.add(i);
      else if (st === 0) dfs(to);
    }
    state.set(id, 2);
  };
  for (const n of fc.nodes) if (state.get(n.id) === 0) dfs(n.id);

  fc.edges.forEach((e, i) => {
    if (backEdges.has(i)) return;
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  });

  const rank = new Map(fc.nodes.map((n) => [n.id, 0]));
  const queue = fc.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    for (const to of out.get(id)) {
      rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0 && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }

  const maxRank = Math.max(0, ...[...rank.values()]);
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of fc.nodes) layers[rank.get(n.id)].push(n);

  // --- order inside each layer: cluster-major, then barycentre of neighbours
  const clusterIndex = new Map(fc.clusters.map((c) => [c.id, c.index]));
  const orderKey = new Map(fc.nodes.map((n, i) => [n.id, i]));
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    for (const layer of layers) {
      for (const n of layer) {
        const neigh = fc.edges
          .filter((e) => (down ? e.to === n.id : e.from === n.id))
          .map((e) => orderKey.get(down ? e.from : e.to))
          .filter((v) => v !== undefined);
        if (neigh.length) orderKey.set(n.id, neigh.reduce((a, b) => a + b, 0) / neigh.length);
      }
      layer.sort((a, b) => {
        const ca = a.cluster ? clusterIndex.get(a.cluster) ?? -1 : -1;
        const cb = b.cluster ? clusterIndex.get(b.cluster) ?? -1 : -1;
        if (ca !== cb) return ca - cb;
        return orderKey.get(a.id) - orderKey.get(b.id);
      });
      layer.forEach((n, i) => orderKey.set(n.id, i));
    }
  }

  // --- coordinates
  const horizontal = fc.direction === "LR" || fc.direction === "RL";
  const margin = 24;
  let cursor = margin;
  const layerExtent = [];
  for (const layer of layers) {
    const thickness = Math.max(0, ...layer.map((n) => (horizontal ? n.width : n.height)));
    layerExtent.push({ start: cursor, thickness });
    cursor += thickness + RANK_GAP;
  }
  const totalCross = Math.max(
    ...layers.map((layer) => layer.reduce((a, n) => a + (horizontal ? n.height : n.width) + NODE_GAP, -NODE_GAP)),
    0,
  );
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const span = layer.reduce((a, n) => a + (horizontal ? n.height : n.width) + NODE_GAP, -NODE_GAP);
    let at = margin + (totalCross - span) / 2;
    for (const n of layer) {
      const cross = horizontal ? n.height : n.width;
      const along = layerExtent[li].start + (layerExtent[li].thickness - (horizontal ? n.width : n.height)) / 2;
      if (horizontal) {
        n.x = along;
        n.y = at;
      } else {
        n.x = at;
        n.y = along;
      }
      at += cross + NODE_GAP;
    }
  }
  if (fc.direction === "RL" || fc.direction === "BT") {
    const maxAlong = Math.max(...fc.nodes.map((n) => (horizontal ? n.x + n.width : n.y + n.height)));
    for (const n of fc.nodes) {
      if (horizontal) n.x = maxAlong - (n.x + n.width) + margin;
      else n.y = maxAlong - (n.y + n.height) + margin;
    }
  }

  // Round to whole pixels: determinism beats a half-pixel of precision.
  for (const n of fc.nodes) {
    n.x = Math.round(n.x);
    n.y = Math.round(n.y);
  }

  const clusterBoxes = fc.clusters
    .map((c) => {
      const members = fc.nodes.filter((n) => n.cluster === c.id);
      if (!members.length) return null;
      const pad = 22;
      const x = Math.min(...members.map((n) => n.x)) - pad;
      const y = Math.min(...members.map((n) => n.y)) - pad - 14;
      const x2 = Math.max(...members.map((n) => n.x + n.width)) + pad;
      const y2 = Math.max(...members.map((n) => n.y + n.height)) + pad;
      return { ...c, x, y, width: x2 - x, height: y2 - y };
    })
    .filter(Boolean);

  const all = [...fc.nodes, ...clusterBoxes];
  const minX = Math.min(...all.map((n) => n.x));
  const minY = Math.min(...all.map((n) => n.y));
  const dx = margin - minX;
  const dy = margin - minY;
  for (const n of all) {
    n.x += dx;
    n.y += dy;
  }
  const width = Math.ceil(Math.max(...all.map((n) => n.x + n.width)) + margin);
  const height = Math.ceil(Math.max(...all.map((n) => n.y + n.height)) + margin);

  return { ...fc, byId, layers, rank, backEdges, clusterBoxes, width, height, horizontal };
}

// ----------------------------------------------------------------- svg emit

const THEME = {
  light: {
    bg: "#ffffff",
    nodeFill: "#f1f5fb",
    nodeStroke: "#334e68",
    text: "#0f172a",
    edge: "#475569",
    edgeText: "#334155",
    clusterFill: "#f8fafc",
    clusterStroke: "#cbd5e1",
    clusterText: "#64748b",
  },
  dark: {
    bg: "#0b1220",
    nodeFill: "#182338",
    nodeStroke: "#93b4d8",
    text: "#e6edf6",
    edge: "#8fa6c0",
    edgeText: "#b6c6da",
    clusterFill: "#111a2b",
    clusterStroke: "#2b3a52",
    clusterText: "#8fa6c0",
  },
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function anchor(node, side) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  switch (side) {
    case "right":
      return [node.x + node.width, cy];
    case "left":
      return [node.x, cy];
    case "top":
      return [cx, node.y];
    default:
      return [cx, node.y + node.height];
  }
}

function edgeEnds(g, from, to) {
  if (g.horizontal) {
    const forward = from.x + from.width <= to.x;
    return forward ? [anchor(from, "right"), anchor(to, "left")] : [anchor(from, "left"), anchor(to, "right")];
  }
  const forward = from.y + from.height <= to.y;
  return forward ? [anchor(from, "bottom"), anchor(to, "top")] : [anchor(from, "top"), anchor(to, "bottom")];
}

function shapePath(n) {
  const { x, y, width: w, height: h, shape } = n;
  const r = 6;
  switch (shape) {
    case "diamond":
      return `M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} Z`;
    case "hexagon":
      return `M ${x + 18} ${y} L ${x + w - 18} ${y} L ${x + w} ${y + h / 2} L ${x + w - 18} ${y + h} L ${x + 18} ${y + h} L ${x} ${y + h / 2} Z`;
    case "parallelogram":
      return `M ${x + 20} ${y} L ${x + w} ${y} L ${x + w - 20} ${y + h} L ${x} ${y + h} Z`;
    case "parallelogram-alt":
      return `M ${x} ${y} L ${x + w - 20} ${y} L ${x + w} ${y + h} L ${x + 20} ${y + h} Z`;
    case "flag":
      return `M ${x} ${y} L ${x + w - 16} ${y} L ${x + w} ${y + h / 2} L ${x + w - 16} ${y + h} L ${x} ${y + h} Z`;
    default:
      return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
  }
}

function nodeShapeSvg(n, t) {
  const common = `fill="var(--tb-node-fill)" stroke="var(--tb-node-stroke)" stroke-width="1.5"`;
  if (n.shape === "circle" || n.shape === "stadium" || n.shape === "round") {
    const rx = n.shape === "circle" ? n.width / 2 : n.shape === "stadium" ? n.height / 2 : 14;
    return `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${rx}" ry="${n.shape === "circle" ? n.height / 2 : rx}" ${common}/>`;
  }
  if (n.shape === "cylinder") {
    const ry = 8;
    return (
      `<rect x="${n.x}" y="${n.y + ry}" width="${n.width}" height="${n.height - ry * 2}" ${common}/>` +
      `<ellipse cx="${n.x + n.width / 2}" cy="${n.y + ry}" rx="${n.width / 2}" ry="${ry}" ${common}/>` +
      `<ellipse cx="${n.x + n.width / 2}" cy="${n.y + n.height - ry}" rx="${n.width / 2}" ry="${ry}" ${common}/>`
    );
  }
  if (n.shape === "subroutine") {
    return (
      `<path d="${shapePath(n)}" ${common}/>` +
      `<line x1="${n.x + 8}" y1="${n.y}" x2="${n.x + 8}" y2="${n.y + n.height}" stroke="var(--tb-node-stroke)" stroke-width="1.5"/>` +
      `<line x1="${n.x + n.width - 8}" y1="${n.y}" x2="${n.x + n.width - 8}" y2="${n.y + n.height}" stroke="var(--tb-node-stroke)" stroke-width="1.5"/>`
    );
  }
  return `<path d="${shapePath(n)}" ${common}/>`;
}

function labelSvg(n) {
  const cx = n.x + n.width / 2;
  const total = n.lines.length * LINE_HEIGHT;
  const top = n.y + (n.height - total) / 2 + FONT_SIZE;
  return n.lines
    .map(
      (line, i) =>
        `<text x="${cx}" y="${Math.round(top + i * LINE_HEIGHT)}" text-anchor="middle" class="tb-label">${esc(line)}</text>`,
    )
    .join("");
}

function toSvg(g) {
  const t = THEME.light;
  const d = THEME.dark;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="diagram">`,
  );
  // A style block with a dark-mode block: the same file reads correctly on a
  // white README and on a dark one. Tokens are defined on :root FIRST so a
  // renderer with no media query support still gets every colour.
  parts.push(
    `<style>` +
      `svg{--tb-bg:${t.bg};--tb-node-fill:${t.nodeFill};--tb-node-stroke:${t.nodeStroke};--tb-text:${t.text};--tb-edge:${t.edge};--tb-edge-text:${t.edgeText};--tb-cluster-fill:${t.clusterFill};--tb-cluster-stroke:${t.clusterStroke};--tb-cluster-text:${t.clusterText}}` +
      `@media (prefers-color-scheme: dark){svg{--tb-bg:${d.bg};--tb-node-fill:${d.nodeFill};--tb-node-stroke:${d.nodeStroke};--tb-text:${d.text};--tb-edge:${d.edge};--tb-edge-text:${d.edgeText};--tb-cluster-fill:${d.clusterFill};--tb-cluster-stroke:${d.clusterStroke};--tb-cluster-text:${d.clusterText}}}` +
      `.tb-label{font-family:ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:${FONT_SIZE}px;fill:var(--tb-text)}` +
      `.tb-edge-label{font-family:ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;fill:var(--tb-edge-text)}` +
      `.tb-cluster-label{font-family:ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;fill:var(--tb-cluster-text)}` +
      `</style>`,
  );
  parts.push(
    `<defs><marker id="tb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--tb-edge)"/></marker>` +
      `<marker id="tb-circle" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto"><circle cx="5" cy="5" r="4" fill="var(--tb-edge)"/></marker>` +
      `<marker id="tb-cross" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 1 1 L 9 9 M 9 1 L 1 9" stroke="var(--tb-edge)" stroke-width="2"/></marker></defs>`,
  );
  parts.push(`<rect width="100%" height="100%" fill="var(--tb-bg)"/>`);

  for (const c of g.clusterBoxes) {
    parts.push(
      `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="10" fill="var(--tb-cluster-fill)" stroke="var(--tb-cluster-stroke)" stroke-width="1.25" stroke-dasharray="5 4"/>`,
    );
    parts.push(`<text x="${c.x + 12}" y="${c.y + 18}" class="tb-cluster-label">${esc(c.label)}</text>`);
  }

  g.edges.forEach((e, i) => {
    const from = g.byId.get(e.from);
    const to = g.byId.get(e.to);
    const dash = e.style === "dotted" ? ` stroke-dasharray="6 5"` : "";
    const wid = e.style === "thick" ? 3 : 1.6;
    const markers =
      (e.arrowEnd
        ? ` marker-end="url(#${e.endShape === "circle" ? "tb-circle" : e.endShape === "cross" ? "tb-cross" : "tb-arrow"})"`
        : "") + (e.arrowStart ? ` marker-start="url(#tb-arrow)"` : "");

    if (from === to) {
      const [sx, sy] = anchor(from, g.horizontal ? "top" : "right");
      const path = g.horizontal
        ? `M ${sx} ${sy} C ${sx + 40} ${sy - 46} ${sx - 40} ${sy - 46} ${sx - 1} ${sy}`
        : `M ${sx} ${sy} C ${sx + 46} ${sy - 40} ${sx + 46} ${sy + 40} ${sx} ${sy + 1}`;
      parts.push(`<path d="${path}" fill="none" stroke="var(--tb-edge)" stroke-width="${wid}"${dash}${markers}/>`);
      if (e.label) parts.push(edgeLabelSvg(sx, sy - 52, e.label));
      return;
    }

    const [[sx, sy], [tx, ty]] = edgeEnds(g, from, to);
    const path = g.horizontal
      ? `M ${sx} ${sy} C ${Math.round((sx + tx) / 2)} ${sy} ${Math.round((sx + tx) / 2)} ${ty} ${tx} ${ty}`
      : `M ${sx} ${sy} C ${sx} ${Math.round((sy + ty) / 2)} ${tx} ${Math.round((sy + ty) / 2)} ${tx} ${ty}`;
    parts.push(`<path d="${path}" fill="none" stroke="var(--tb-edge)" stroke-width="${wid}"${dash}${markers}/>`);
    if (e.label) parts.push(edgeLabelSvg(Math.round((sx + tx) / 2), Math.round((sy + ty) / 2), e.label));
  });

  for (const n of g.nodes) {
    parts.push(nodeShapeSvg(n, t));
    parts.push(labelSvg(n));
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

function edgeLabelSvg(cx, cy, label) {
  const w = Math.ceil(textWidth(label, 12)) + 10;
  return (
    `<rect x="${Math.round(cx - w / 2)}" y="${cy - 10}" width="${w}" height="18" rx="4" fill="var(--tb-bg)" opacity="0.92"/>` +
    `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="tb-edge-label">${esc(label)}</text>`
  );
}

// ---------------------------------------------------------- excalidraw emit
//
// Deterministic ids and seeds. excalidraw itself generates random ones, which
// means re-exporting an unchanged diagram produces a completely different file
// and a completely useless diff. Here the same source always produces the same
// bytes, which is asserted in the selftest.

function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
const idFor = (s) => `tb${hash32(s).toString(36)}${hash32(`${s}#2`).toString(36)}`.slice(0, 20);

const EXCALIDRAW_SHAPE = {
  diamond: "diamond",
  circle: "ellipse",
  round: "rectangle",
  stadium: "rectangle",
  rect: "rectangle",
  hexagon: "diamond",
  cylinder: "ellipse",
  subroutine: "rectangle",
  parallelogram: "rectangle",
  "parallelogram-alt": "rectangle",
  flag: "rectangle",
};

function baseElement(id, type, extra) {
  const seed = hash32(id) % 2147483647;
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : type === "arrow" ? { type: 2 } : null,
    seed,
    version: 1,
    versionNonce: hash32(`${id}:nonce`) % 2147483647,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

function toExcalidraw(g) {
  const elements = [];
  const containerOf = new Map();

  for (const c of g.clusterBoxes) {
    const id = idFor(`cluster:${c.id}`);
    elements.push(
      baseElement(id, "rectangle", {
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        strokeColor: "#868e96",
        backgroundColor: "#f8f9fa",
        fillStyle: "solid",
        strokeStyle: "dashed",
        strokeWidth: 1,
      }),
    );
    const labelId = idFor(`clusterlabel:${c.id}`);
    elements.push(
      baseElement(labelId, "text", {
        x: c.x + 12,
        y: c.y + 6,
        width: Math.ceil(textWidth(c.label, 16)),
        height: 20,
        text: c.label,
        originalText: c.label,
        fontSize: 16,
        fontFamily: 2,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
        strokeColor: "#868e96",
      }),
    );
  }

  for (const n of g.nodes) {
    const id = idFor(`node:${n.id}`);
    containerOf.set(n.id, id);
    const textId = idFor(`text:${n.id}`);
    const el = baseElement(id, EXCALIDRAW_SHAPE[n.shape] ?? "rectangle", {
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      backgroundColor: "#e7f5ff",
      boundElements: [{ id: textId, type: "text" }],
    });
    elements.push(el);
    elements.push(
      baseElement(textId, "text", {
        x: n.x + 8,
        y: n.y + Math.round((n.height - n.lines.length * 20) / 2),
        width: Math.max(1, n.width - 16),
        height: n.lines.length * 20,
        text: n.label,
        originalText: n.label,
        fontSize: 16,
        fontFamily: 2,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: id,
        lineHeight: 1.25,
      }),
    );
  }

  g.edges.forEach((e, i) => {
    const from = g.byId.get(e.from);
    const to = g.byId.get(e.to);
    const arrowId = idFor(`edge:${e.from}->${e.to}:${i}`);
    const [[sx, sy], [tx, ty]] = from === to ? [anchor(from, "top"), anchor(from, "right")] : edgeEnds(g, from, to);
    const el = baseElement(arrowId, "arrow", {
      x: sx,
      y: sy,
      width: Math.abs(tx - sx),
      height: Math.abs(ty - sy),
      points: [
        [0, 0],
        [tx - sx, ty - sy],
      ],
      lastCommittedPoint: null,
      startBinding: from === to ? null : { elementId: containerOf.get(e.from), focus: 0, gap: 4 },
      endBinding: from === to ? null : { elementId: containerOf.get(e.to), focus: 0, gap: 4 },
      startArrowhead: e.arrowStart ? "arrow" : null,
      endArrowhead: e.arrowEnd ? "arrow" : null,
      strokeStyle: e.style === "dotted" ? "dashed" : "solid",
      strokeWidth: e.style === "thick" ? 4 : 2,
      elbowed: false,
    });
    elements.push(el);
    if (e.label) {
      const labelId = idFor(`edgelabel:${e.from}->${e.to}:${i}`);
      el.boundElements = [{ id: labelId, type: "text" }];
      elements.push(
        baseElement(labelId, "text", {
          x: Math.round((sx + tx) / 2) - Math.ceil(textWidth(e.label, 14) / 2),
          y: Math.round((sy + ty) / 2) - 10,
          width: Math.max(1, Math.ceil(textWidth(e.label, 14))),
          height: 20,
          text: e.label,
          originalText: e.label,
          fontSize: 14,
          fontFamily: 2,
          textAlign: "center",
          verticalAlign: "middle",
          containerId: arrowId,
          lineHeight: 1.25,
        }),
      );
    }
  });

  // Bind the arrows back to the shapes they touch, which is what makes them
  // stay attached when you drag a box on excalidraw.com.
  const bound = new Map();
  for (const el of elements) {
    if (el.type !== "arrow") continue;
    for (const key of ["startBinding", "endBinding"]) {
      const b = el[key];
      if (!b) continue;
      if (!bound.has(b.elementId)) bound.set(b.elementId, []);
      bound.get(b.elementId).push({ id: el.id, type: "arrow" });
    }
  }
  for (const el of elements) {
    const extra = bound.get(el.id);
    if (!extra) continue;
    el.boundElements = [...(el.boundElements ?? []), ...extra];
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/orion/toolbay-stack",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

// ---------------------------------------------------------------- PNG decode
//
// Enough of a PNG reader to answer one question honestly: is there a picture
// in there. Structure alone is not enough, because the failure that matters
// (a browser that screenshotted before the page painted) produces a
// structurally perfect PNG of one flat colour.

function readPngChunks(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return { ok: false, error: "does not start with the PNG signature" };
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const start = off + 8;
    if (start + len + 4 > buf.length) return { ok: false, error: `truncated: chunk ${type} claims ${len} bytes and the file ends first` };
    chunks.push({ type, data: buf.subarray(start, start + len) });
    off = start + len + 4;
    if (type === "IEND") return { ok: true, chunks };
  }
  return { ok: false, error: "no IEND chunk: the file is truncated" };
}

function inspectPng(buf) {
  const parsed = readPngChunks(buf);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ihdr = parsed.chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return { ok: false, error: "no IHDR header chunk" };
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (!width || !height) return { ok: false, error: `IHDR says ${width}x${height}` };

  const idat = Buffer.concat(parsed.chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (!idat.length) return { ok: false, error: "no IDAT image data" };
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6, 0, 4].includes(colorType)) {
    return {
      ok: false,
      width,
      height,
      error: `cannot decode this PNG variant (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace}), so "is it blank" cannot be answered. Refusing to pass it unchecked.`,
    };
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch (e) {
    return { ok: false, width, height, error: `IDAT does not inflate (${e.message})` };
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    return { ok: false, width, height, error: `IDAT inflates to ${raw.length} bytes, ${(stride + 1) * height} expected` };
  }

  // Unfilter. Standard PNG filters 0-4.
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (v + pr) & 0xff;
          break;
        }
        default:
          return { ok: false, width, height, error: `unknown PNG row filter ${filter} on row ${y}` };
      }
    }
  }

  // How much of the image is not the background? The background is taken as
  // the most common colour rather than the corner pixel: a one-pixel seam at
  // the edge of a scaled image would otherwise make a blank picture look full.
  let total = 0;
  const stepY = Math.max(1, Math.floor(height / 400));
  const stepX = Math.max(1, Math.floor(width / 400));
  const counts = new Map();
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const at = y * stride + x * channels;
      const px = out.subarray(at, at + channels).toString("hex");
      counts.set(px, (counts.get(px) ?? 0) + 1);
      total++;
    }
  }
  const dominant = Math.max(...counts.values());
  return {
    ok: true,
    width,
    height,
    colorType,
    inkFraction: total ? (total - dominant) / total : 0,
    distinctColours: counts.size,
  };
}

// --------------------------------------------------------------- verifiers
//
// Everything here answers a question about a file that is already on disk.
// Nothing here trusts the thing that wrote it.

function verifySvg(text, expect = {}) {
  const problems = [];
  const t = String(text);
  if (!t.trim()) problems.push("the file is empty");
  else if (t.trim() === "undefined" || t.trim() === "null") {
    problems.push(
      `the file contains the literal text "${t.trim()}", which is what a renderer writes when the render it was supposed to await never assigned anything`,
    );
  }
  if (!/<svg[\s>]/i.test(t)) problems.push("there is no <svg> element in it");
  if (!/<\/svg>\s*$/i.test(t.trim())) problems.push("it does not end with </svg>, so it was cut off");
  // Size can come from width/height or from the viewBox. mermaid emits
  // width="100%" with the real geometry only in the viewBox, and an SVG whose
  // size is unknowable cannot be rasterised, so both are read.
  const wm = t.match(/<svg[^>]*?\bwidth="([\d.]+)(?:px)?"/i);
  const hm = t.match(/<svg[^>]*?\bheight="([\d.]+)(?:px)?"/i);
  const vb = t.match(/<svg[^>]*?\bviewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  const width = wm ? Number(wm[1]) : vb ? Number(vb[1]) : 0;
  const height = hm ? Number(hm[1]) : vb ? Number(vb[2]) : 0;
  if (!(width > 0) || !(height > 0)) {
    problems.push(`the svg element declares no usable size (width=${wm?.[1] ?? "-"}, height=${hm?.[1] ?? "-"}, viewBox=${vb ? `${vb[1]}x${vb[2]}` : "absent"})`);
  }
  const drawn = (t.match(/<(rect|path|ellipse|circle|polygon)\b/gi) ?? []).length;
  if (expect.minShapes && drawn < expect.minShapes) {
    problems.push(`only ${drawn} shapes were drawn, at least ${expect.minShapes} expected for this source`);
  }
  // The check that catches a silently-wrong render: every label in the source
  // has to be somewhere in the text of the SVG.
  const textContent = (t.match(/<text[^>]*>([\s\S]*?)<\/text>/gi) ?? [])
    .map((m) => m.replace(/<[^>]+>/g, ""))
    .join(" ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  // Is this mermaid's ERROR graphic wearing the shape of a diagram? Only two
  // signals are trustworthy: the role, and the words a human would SEE.
  // Matching the string "error-icon" is not: mermaid ships an `.error-icon`
  // rule inside the stylesheet of every healthy sequence diagram, so a check
  // that greps the whole file rejects perfectly good renders. Found by this
  // engine rejecting a real one.
  if (/aria-roledescription="error"/i.test(t) || /syntax error|parse error|mermaid version \d/i.test(textContent)) {
    problems.push('it is a mermaid ERROR graphic, not a diagram (the rendered text says so)');
  }
  const missing = (expect.labels ?? []).filter((l) => {
    const flat = String(l).split("\n").map((s) => s.trim()).filter(Boolean);
    return flat.some((piece) => !textContent.includes(piece));
  });
  if (missing.length) {
    problems.push(`${missing.length} label(s) from the source never made it into the rendered text: ${missing.slice(0, 3).map((m) => JSON.stringify(m)).join(", ")}`);
  }
  return { ok: problems.length === 0, problems, width, height, shapes: drawn, bytes: Buffer.byteLength(t) };
}

function verifyPng(buf, expect = {}) {
  const problems = [];
  const info = inspectPng(buf);
  if (!info.ok) problems.push(info.error);
  else {
    if (info.width < (expect.minWidth ?? 64) || info.height < 16) problems.push(`the image is ${info.width}x${info.height}, which is too small to be the diagram`);
    if (info.distinctColours < 2) problems.push(`every sampled pixel is the same colour: this is a blank image, not a diagram`);
    else if (info.inkFraction < 0.002) problems.push(`only ${(info.inkFraction * 100).toFixed(3)}% of sampled pixels differ from the background, which is a blank or nearly-blank image`);
  }
  // `info` is spread FIRST on purpose: it carries its own `ok` from the
  // decoder, and letting it land on top of the verdict is exactly the
  // fail-open this file exists to remove.
  return { ...info, ok: problems.length === 0, problems };
}

function verifyExcalidraw(text, expect = {}) {
  const problems = [];
  let scene = null;
  try {
    scene = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, problems: [`it is not valid JSON (${e.message})`] };
  }
  if (!scene || typeof scene !== "object") problems.push("the top level is not an object");
  else {
    if (scene.type !== "excalidraw") problems.push(`type is ${JSON.stringify(scene.type)}, expected "excalidraw" (excalidraw.com refuses anything else)`);
    if (!Array.isArray(scene.elements)) problems.push("elements is not an array");
    else {
      if (scene.elements.length === 0) problems.push("the scene has zero elements: it opens as a blank canvas");
      const bad = [];
      for (const el of scene.elements) {
        for (const k of ["x", "y", "width", "height"]) {
          if (!Number.isFinite(el?.[k])) bad.push(`${el?.id ?? "?"}.${k}=${el?.[k]}`);
        }
        if (!el?.id || !el?.type) bad.push(`an element has no id or type`);
      }
      if (bad.length) problems.push(`${bad.length} element field(s) are not finite numbers: ${bad.slice(0, 4).join(", ")}`);
      if (expect.minElements && scene.elements.length < expect.minElements) {
        problems.push(`${scene.elements.length} elements, at least ${expect.minElements} expected for this source`);
      }
      const texts = scene.elements.filter((e) => e.type === "text").map((e) => String(e.text ?? ""));
      const missing = (expect.labels ?? []).filter((l) => !texts.some((t) => t.includes(String(l).split("\n")[0].trim())));
      if (missing.length) problems.push(`${missing.length} label(s) are missing from the scene: ${missing.slice(0, 3).map((m) => JSON.stringify(m)).join(", ")}`);
      const arrows = scene.elements.filter((e) => e.type === "arrow");
      const unbound = arrows.filter((a) => a.startBinding === undefined || a.endBinding === undefined);
      if (unbound.length) problems.push(`${unbound.length} arrow(s) have no binding fields, so they detach when a box is moved`);
    }
  }
  return { ok: problems.length === 0, problems, elements: scene?.elements?.length ?? 0 };
}

// ------------------------------------------------------------------ browser
// Reused, deliberately, from tb-pdf.mjs: the same discovery order and the same
// CDP client. One mechanism to keep working on Windows, not two.

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  const PATH = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const c = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (isFile(c)) return c;
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

function browserCandidates(explicit) {
  const c = [];
  const add = (p, why) => {
    if (p) c.push({ path: p, why });
  };
  add(explicit, "--browser");
  add(process.env.TB_DIAGRAM_BROWSER, "$TB_DIAGRAM_BROWSER");
  add(process.env.TB_PDF_BROWSER, "$TB_PDF_BROWSER");
  add(process.env.CHROME_PATH, "$CHROME_PATH");
  if (process.platform === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean);
    for (const r of roots) {
      add(path.join(r, "Google\\Chrome\\Application\\chrome.exe"), "installed Chrome");
      add(path.join(r, "Microsoft\\Edge\\Application\\msedge.exe"), "installed Edge");
      add(path.join(r, "Chromium\\Application\\chrome.exe"), "installed Chromium");
      add(path.join(r, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), "installed Brave");
    }
    for (const p of newestPlaywrightChromium(path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"))) add(p, "Playwright download");
    for (const n of ["chrome", "msedge", "chromium"]) add(onPath(n), `${n} on PATH`);
  } else if (process.platform === "darwin") {
    add("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "installed Chrome");
    add("/Applications/Chromium.app/Contents/MacOS/Chromium", "installed Chromium");
    add("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "installed Edge");
    for (const p of newestPlaywrightChromium(path.join(os.homedir(), "Library/Caches/ms-playwright"))) add(p, "Playwright download");
  } else {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) add(onPath(n), `${n} on PATH`);
    add("/usr/bin/google-chrome", "distro package");
    add("/usr/bin/chromium", "distro package");
    for (const p of newestPlaywrightChromium(path.join(os.homedir(), ".cache/ms-playwright"))) add(p, "Playwright download");
  }
  return c;
}

function findBrowser(explicit) {
  // Same rule as --bundle: a browser you named and that is not there is an
  // error. Falling back to a different browser would silently ignore the one
  // setting you cared enough to type.
  if (explicit && !isFile(explicit)) throw new UserError(`--browser ${explicit} is not a file`);
  // Test hook, and an honest way to see the no-browser path on a machine that
  // has one. Reported by doctor so it can never be a mystery.
  if (process.env.TB_DIAGRAM_NO_BROWSER === "1") return null;
  for (const c of browserCandidates(explicit)) if (isFile(c.path)) return c;
  return null;
}

function waitFor(ms, what) {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(Object.assign(new Error(`timed out after ${ms}ms waiting for ${what}`), { exitCode: EXIT.RENDER })), ms);
    // Promise.race does not cancel the loser. Without this, every timeout that
    // never fired keeps the process alive to its full duration after the work
    // is finished, which turns a 3 second render into a 45 second one.
    t.unref?.();
  });
}

async function connectCdp(wsUrl, timeoutMs) {
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

/** Open a headless browser, hand the caller a page session, always clean up. */
async function withPage(browserPath, timeoutMs, log, fn) {
  if (typeof WebSocket === "undefined") {
    throw new UserError(`this node build has no global WebSocket (node ${process.version}); rasterising needs node 22+. The .svg and .excalidraw were still produced.`, EXIT.RENDER);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-diagram-profile-"));
  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderrBuf = "";
  try {
    const wsUrl = await Promise.race([
      new Promise((resolve, reject) => {
        child.on("error", (e) => reject(new UserError(`could not launch ${browserPath}: ${e.message}`, EXIT.BROWSER)));
        child.on("exit", (code) => reject(new UserError(`browser exited (${code}) before listening. stderr:\n${stderrBuf.slice(-600)}`, EXIT.RENDER)));
        child.stderr.on("data", (d) => {
          stderrBuf += d.toString();
          const m = stderrBuf.match(/ws:\/\/[^\s"]+/);
          if (m) resolve(m[0]);
        });
      }),
      waitFor(timeoutMs, "the browser's devtools endpoint"),
    ]);
    log(`devtools at ${wsUrl}`);
    const cdp = await connectCdp(wsUrl, timeoutMs);
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method, params) => cdp.send(method, params, sessionId);
      await s("Page.enable");
      return await fn({ s, cdp, sessionId });
    } finally {
      try {
        await cdp.send("Browser.close");
      } catch {}
      cdp.close();
    }
  } finally {
    try {
      child.kill();
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {}
  }
}

/**
 * Rasterise our own SVG. The SVG goes in as a file next to the html, so
 * nothing is spliced into a shell command line and nothing is base64'd
 * through atob(), which is where gstack loses every non-ASCII label.
 */
async function rasterize({ svgPath, width, browserPath, timeoutMs, log, svgWidth, svgHeight, dark }) {
  const scale = width / svgWidth;
  const outHeight = Math.max(1, Math.round(svgHeight * scale));
  const wrapper = path.join(path.dirname(svgPath), `.tb-raster-${path.basename(svgPath, ".svg")}.html`);
  const svgHref = path.basename(svgPath);
  fs.writeFileSync(
    wrapper,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:${width}px;height:${outHeight}px}</style><img id="d" src="${svgHref}">` +
      `<script>window.__ready=new Promise(r=>{const i=document.getElementById('d');if(i.complete)r(true);else{i.onload=()=>r(true);i.onerror=()=>r(false)}})</script>`,
    "utf8",
  );
  try {
    return await withPage(browserPath, timeoutMs, log, async ({ s }) => {
      // Headless Chrome reports prefers-color-scheme: dark, so an SVG with a
      // dark-mode block rasterises dark unless this is pinned. The .svg stays
      // adaptive; the .png has to commit to one, and light is the one that
      // works on a README.
      await s("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
      }).catch(() => {});
      const loaded = new Promise((r) => setTimeout(r, 0));
      await s("Page.navigate", { url: pathToFileURL(wrapper).href });
      await Promise.race([loaded, waitFor(timeoutMs, "navigation")]);
      const ready = await Promise.race([
        s("Runtime.evaluate", { expression: "window.__ready", awaitPromise: true, returnByValue: true }),
        waitFor(timeoutMs, "the svg to decode in the browser"),
      ]);
      if (ready?.result?.value !== true) {
        throw new UserError(`the browser could not decode the SVG we just wrote (${svgPath}). Not writing a PNG of nothing.`, EXIT.RENDER);
      }
      await s("Emulation.setDeviceMetricsOverride", { width, height: outHeight, deviceScaleFactor: 1, mobile: false });
      const shot = await Promise.race([
        s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: outHeight, scale: 1 } }),
        waitFor(timeoutMs, "Page.captureScreenshot"),
      ]);
      if (!shot?.data) throw new UserError("captureScreenshot returned no data", EXIT.RENDER);
      return Buffer.from(shot.data, "base64");
    });
  } finally {
    try {
      fs.rmSync(wrapper, { force: true });
    } catch {}
  }
}

// --------------------------------------------------------- the bundle engine
//
// For the mermaid types this file does not implement (sequence, state, gantt,
// class, pie...). If gstack's vendored render bundle is on disk we drive it
// DIRECTLY over CDP: no browse daemon, no /tmp staging, no shasum, and the
// source crosses into the page as a JSON string literal rather than base64
// through atob(), so a CJK label survives.

function findBundle(explicit) {
  // An explicit --bundle that is not a file is an error, not a reason to
  // quietly fall back to some other bundle: the caller named a file and is
  // entitled to be told it is not there.
  if (explicit && !isFile(explicit)) throw new UserError(`--bundle ${explicit} is not a file`);
  const cands = [
    explicit,
    process.env.TB_DIAGRAM_BUNDLE,
    path.join(os.homedir(), ".claude/skills/gstack/lib/diagram-render/dist/diagram-render.html"),
    path.join(os.homedir(), ".gstack/lib/diagram-render/dist/diagram-render.html"),
    path.join(path.dirname(SELF), "..", "lib", "diagram-render.html"),
  ].filter(Boolean);
  for (const c of cands) if (isFile(c)) return c;
  return null;
}

async function renderWithBundle({ bundle, source, browserPath, timeoutMs, log }) {
  return withPage(browserPath, timeoutMs, log, async ({ s }) => {
    await s("Page.navigate", { url: pathToFileURL(bundle).href });
    const ok = await Promise.race([
      s("Runtime.evaluate", {
        expression: `new Promise(r => { const t = setInterval(() => { if (document.querySelector('#done') || window.__renderMermaid) { clearInterval(t); r(true) } }, 50); setTimeout(() => { clearInterval(t); r(false) }, ${Math.max(1000, timeoutMs - 500)}) })`,
        awaitPromise: true,
        returnByValue: true,
      }),
      waitFor(timeoutMs, "the render bundle to become ready"),
    ]);
    if (ok?.result?.value !== true) throw new UserError(`the render bundle at ${bundle} never became ready`, EXIT.RENDER);
    const res = await Promise.race([
      s("Runtime.evaluate", {
        expression: `window.__renderMermaid('tb-1', ${JSON.stringify(source)}).then(x => ({ok:true, svg:x})).catch(e => ({ok:false, error:String(e && e.message || e)}))`,
        awaitPromise: true,
        returnByValue: true,
      }),
      waitFor(timeoutMs, "the bundle render"),
    ]);
    const value = res?.result?.value;
    if (!value || value.ok !== true || typeof value.svg !== "string" || !value.svg.trim()) {
      throw new UserError(`the render bundle refused this source: ${value?.error ?? "it returned nothing"}`, EXIT.RENDER);
    }
    return value.svg;
  });
}

// ------------------------------------------------------------------- render

function safeSlug(raw, fallback) {
  const s = String(raw ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!s) throw new UserError(`--slug ${JSON.stringify(raw)} reduces to nothing usable`);
  return s;
}

function readSource(p) {
  if (p === "-") {
    const data = fs.readFileSync(0, "utf8");
    if (!data.trim()) throw new UserError("nothing arrived on stdin");
    return data;
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new UserError(`input not found: ${p}`);
  }
  if (st.isDirectory()) throw new UserError(`${p} is a directory, not a mermaid source`);
  const text = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new UserError(`${p} is empty (${st.size} bytes)`);
  return text;
}

async function cmdRender(argv) {
  const { flags, positional } = parseArgv(argv);
  const quiet = !!flags["--quiet"];
  const verbose = !!flags["--verbose"];
  const log = (m) => {
    if (verbose) process.stderr.write(`  ${m}\n`);
  };
  const say = (m) => {
    if (!quiet) process.stderr.write(`${m}\n`);
  };

  if (!positional.length) throw new UserError("usage: tb-diagram.mjs render <source.mmd|-> [--out <dir>] [--slug <name>]");
  if (positional.length > 2) throw new UserError(`expected one input (and optionally one output directory), got ${positional.length}: ${positional.join(" ")}`);

  const input = positional[0];
  const source = readSource(input);
  const outDir = path.resolve(flags["--out"] ?? positional[1] ?? path.join(process.cwd(), "diagrams"));
  const slug = safeSlug(flags["--slug"] ?? (input === "-" ? "diagram" : path.basename(input).replace(/\.mmd$/i, "")), "diagram");
  const pngWidth = intFlag(flags, "--png-width", 1950, { min: 200, max: 12000 });
  const timeoutMs = intFlag(flags, "--timeout", 45000, { min: 1000, max: 600000 });
  const engineFlag = flags["--engine"] ?? "auto";
  if (!["auto", "native", "bundle"].includes(engineFlag)) throw new UserError(`--engine must be auto, native or bundle (got ${engineFlag})`);
  // Validate the paths a flag names up front, even on a run that will not
  // reach them. A typo'd --browser that only surfaces on the runs that happen
  // to need it is a setting you believe you have.
  if (flags["--browser"] !== undefined && !isFile(flags["--browser"])) throw new UserError(`--browser ${flags["--browser"]} is not a file`);
  if (flags["--bundle"] !== undefined && !isFile(flags["--bundle"])) throw new UserError(`--bundle ${flags["--bundle"]} is not a file`);

  fs.mkdirSync(outDir, { recursive: true });
  const p = {
    mmd: path.join(outDir, `${slug}.mmd`),
    svg: path.join(outDir, `${slug}.svg`),
    png: path.join(outDir, `${slug}.png`),
    excalidraw: path.join(outDir, `${slug}.excalidraw`),
  };

  const parsed = parseMermaid(source);
  const written = [];
  const failures = [];
  const report = { slug, outDir, engine: null, artifacts: {}, warnings: [] };

  fs.writeFileSync(p.mmd, source.endsWith("\n") ? source : `${source}\n`, "utf8");
  written.push(p.mmd);

  let svg;
  let expect = {};
  if (parsed.kind === "flowchart" && engineFlag !== "bundle") {
    const g = layout(parsed.flowchart);
    report.engine = "native";
    svg = toSvg(g);
    expect = {
      labels: g.nodes.map((n) => n.label),
      minShapes: g.nodes.length,
      minElements: g.nodes.length * 2,
    };
    const scene = toExcalidraw(g);
    fs.writeFileSync(p.excalidraw, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
    written.push(p.excalidraw);
    log(`native engine: ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.layers.length} ranks, ${g.width}x${g.height}`);
  } else {
    if (parsed.kind !== "flowchart" && engineFlag === "native") {
      throw new UserError(
        `this source is a ${parsed.kind} and --engine native draws flowcharts only.\n` +
          `Drop --engine to let the render bundle handle it, or rewrite it as a flowchart.`,
        EXIT.RENDER,
      );
    }
    const browser = findBrowser(flags["--browser"]);
    const bundle = findBundle(flags["--bundle"]);
    if (parsed.kind !== "flowchart") {
      report.warnings.push(
        `${parsed.kind} is not a flowchart, so there is no editable .excalidraw for it and the native engine cannot draw it.`,
      );
    }
    if (!bundle) {
      throw new UserError(
        `this source is a ${parsed.kind}, and the native engine draws flowcharts only.\n\n` +
          `Options:\n` +
          `  1. Rewrite it as a flowchart (graph TD / graph LR), which also gets you the editable .excalidraw.\n` +
          `  2. Point --bundle at gstack's render bundle (lib/diagram-render/dist/diagram-render.html) and it will be driven directly, no daemon.\n\n` +
          `Refusing to write a .svg that has nothing in it.`,
        EXIT.RENDER,
      );
    }
    if (!browser) throw new UserError(`the ${parsed.kind} path needs a browser to drive the render bundle, and none was found. Run "doctor" to see where I looked.`, EXIT.BROWSER);
    report.engine = `bundle (${bundle})`;
    svg = await renderWithBundle({ bundle, source, browserPath: browser.path, timeoutMs, log });
  }

  fs.writeFileSync(p.svg, svg.endsWith("\n") ? svg : `${svg}\n`, "utf8");
  written.push(p.svg);

  // ---- verify what is on disk, not what we think we wrote
  const svgCheck = verifySvg(fs.readFileSync(p.svg, "utf8"), expect);
  report.artifacts.svg = { path: p.svg, ...svgCheck };
  if (!svgCheck.ok) failures.push([p.svg, svgCheck.problems]);

  if (fs.existsSync(p.excalidraw) && report.engine === "native") {
    const exCheck = verifyExcalidraw(fs.readFileSync(p.excalidraw, "utf8"), expect);
    report.artifacts.excalidraw = { path: p.excalidraw, ...exCheck };
    if (!exCheck.ok) failures.push([p.excalidraw, exCheck.problems]);
  }

  // ---- raster
  if (flags["--no-png"]) {
    report.warnings.push("--no-png: no raster was produced");
  } else if (svgCheck.ok) {
    const browser = findBrowser(flags["--browser"]);
    if (!browser) {
      report.warnings.push("no Chromium-family browser found, so there is no .png. The .svg and .excalidraw are complete. Run doctor to see where I looked.");
      report.pngMissing = true;
    } else {
      log(`rasterising with ${browser.path} (${browser.why})`);
      const buf = await rasterize({
        svgPath: p.svg,
        width: pngWidth,
        browserPath: browser.path,
        timeoutMs,
        log,
        svgWidth: svgCheck.width,
        svgHeight: svgCheck.height,
        dark: !!flags["--dark"],
      });
      fs.writeFileSync(p.png, buf);
      written.push(p.png);
      const pngCheck = verifyPng(fs.readFileSync(p.png), { minWidth: Math.min(200, pngWidth) });
      report.artifacts.png = { path: p.png, ...pngCheck };
      if (!pngCheck.ok) failures.push([p.png, pngCheck.problems]);
    }
  }

  if (failures.length) {
    // Quarantine rather than leave in place. A file that failed verification
    // sitting at the name a README or a build step already points at is the
    // failure this whole engine exists to prevent, so it is moved aside and
    // the new name is printed. Nothing is deleted: you can still look at it.
    const lines = failures
      .map(([file, probs]) => {
        const parked = `${file.replace(/(\.[^.]+)$/, "")}.rejected${path.extname(file)}`;
        try {
          fs.rmSync(parked, { force: true });
          fs.renameSync(file, parked);
        } catch {}
        return `  ${file}\n    (moved to ${path.basename(parked)})\n${probs.map((x) => `    - ${x}`).join("\n")}`;
      })
      .join("\n");
    process.stderr.write(`\nVERIFICATION FAILED. These artifacts are not what they claim to be:\n${lines}\n\n`);
    if (flags["--json"]) process.stdout.write(`${JSON.stringify({ ok: false, ...report }, null, 2)}\n`);
    const e = new UserError("refusing to report a diagram that does not verify", EXIT.VERIFY);
    e.printed = true;
    throw e;
  }

  if (flags["--json"]) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(`${written.join("\n")}\n`);
  }
  for (const w of report.warnings) say(`note: ${w}`);
  const a = report.artifacts;
  say(
    `verified: svg ${a.svg?.width}x${a.svg?.height} with ${a.svg?.shapes} shapes` +
      (a.excalidraw ? `, scene ${a.excalidraw.elements} elements` : "") +
      (a.png ? `, png ${a.png.width}x${a.png.height} with ${(a.png.inkFraction * 100).toFixed(1)}% ink` : ", no png"),
  );
  if (report.pngMissing) return EXIT.BROWSER;
  return EXIT.OK;
}

// ------------------------------------------------------------------- verify

function cmdVerify(argv) {
  const { flags, positional } = parseArgv(argv);
  if (!positional.length) throw new UserError("usage: tb-diagram.mjs verify <file.svg|file.png|file.excalidraw> ...");
  const out = [];
  let bad = 0;
  for (const f of positional) {
    if (!isFile(f)) {
      out.push({ path: f, ok: false, problems: ["not a file"] });
      bad++;
      continue;
    }
    const ext = path.extname(f).toLowerCase();
    let r;
    if (ext === ".png") r = verifyPng(fs.readFileSync(f));
    else if (ext === ".excalidraw" || ext === ".json") r = verifyExcalidraw(fs.readFileSync(f, "utf8"));
    else if (ext === ".svg") r = verifySvg(fs.readFileSync(f, "utf8"));
    else if (ext === ".mmd") {
      try {
        parseMermaid(fs.readFileSync(f, "utf8"));
        r = { ok: true, problems: [] };
      } catch (e) {
        r = { ok: false, problems: [e.message] };
      }
    } else {
      r = { ok: false, problems: [`no verifier for ${ext || "a file with no extension"}`] };
    }
    if (!r.ok) bad++;
    out.push({ path: f, ...r });
  }
  if (flags["--json"]) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    for (const r of out) {
      process.stdout.write(`${r.ok ? "OK  " : "BAD "} ${r.path}\n`);
      for (const p of r.problems ?? []) process.stdout.write(`       - ${p}\n`);
    }
  }
  return bad ? EXIT.VERIFY : EXIT.OK;
}

// ------------------------------------------------------------------- doctor

function cmdDoctor() {
  const w = (s) => process.stdout.write(`${s}\n`);
  w(`tb-diagram ${VERSION}`);
  w(`  node        ${process.version} on ${process.platform} (${process.arch})`);
  w(`  WebSocket   ${typeof WebSocket === "undefined" ? "MISSING (node 22+ needed for the .png)" : "present"}`);
  if (process.env.TB_DIAGRAM_NO_BROWSER === "1") w(`  browser     DISABLED by TB_DIAGRAM_NO_BROWSER=1`);
  const b = findBrowser();
  w(`  browser     ${b ? `${b.path}  (${b.why})` : "NONE FOUND"}`);
  if (!b) for (const c of browserCandidates()) w(`                tried ${c.path}  (${c.why})`);
  const bundle = findBundle();
  w(`  bundle      ${bundle ? bundle : "not installed (flowcharts do not need it)"}`);
  w(`  out dir     ${path.join(process.cwd(), "diagrams")}`);
  w("");
  w("  Flowcharts render with no browser, no daemon and no network.");
  w("  A browser is needed only for the .png, and only to rasterise the .svg we wrote.");
  return b ? EXIT.OK : EXIT.OK;
}

// ----------------------------------------------------------------- selftest

function runSelf(args, opts = {}) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A minimal, valid PNG built here so the raster checks need no browser. */
function makePng(width, height, paint) {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const at = y * (stride + 1) + 1 + x * channels;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GOOD_SOURCE = `graph LR
  A[Client] -->|POST /connect| B{Has key?}
  B -->|yes| C[(Vault)]
  B -->|no| D[Reject]
  C --> E((Done))
  D --> E
`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-diagram-selftest-"));
  const f = (name) => path.join(tmp, name);
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail: String(detail ?? "").slice(0, 200) });

  fs.writeFileSync(f("good.mmd"), GOOD_SOURCE, "utf8");
  fs.writeFileSync(f("empty.mmd"), "", "utf8");
  fs.writeFileSync(f("blank.mmd"), "   \n\n\t\n", "utf8");
  fs.writeFileSync(f("dangling.mmd"), "graph TD\n  A[Start] -->\n", "utf8");
  fs.writeFileSync(f("nohead.mmd"), "grapf TD\n  A --> B\n", "utf8");
  fs.writeFileSync(f("declared-empty.mmd"), "graph TD\n%% nothing here\n", "utf8");
  fs.writeFileSync(f("seq.mmd"), "sequenceDiagram\n  A->>B: hi\n", "utf8");
  fs.writeFileSync(f("cycle.mmd"), "graph LR\n  A --> B\n  B --> C\n  C --> A\n  A --> A\n", "utf8");
  fs.writeFileSync(f("unicode.mmd"), 'graph LR\n  A["前端 client"] --> B["後端 données"]\n', "utf8");
  fs.writeFileSync(f("hostile.mmd"), 'graph LR\n  A["back`tick ${x} and \\ slash"] --> B["#quot;quoted#quot; ok"]\n', "utf8");
  fs.mkdirSync(f("adir"));

  const big = ["graph TD"];
  for (let i = 0; i < 150; i++) big.push(`  N${i}[Node number ${i}] --> N${i + 1}[Node number ${i + 1}]`);
  fs.writeFileSync(f("big.mmd"), `${big.join("\n")}\n`, "utf8");

  const O = ["--out", f("out"), "--no-png", "--quiet"];

  // ---------- refusals: bad input
  let r = runSelf(["render", f("empty.mmd"), ...O]);
  check("empty source is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("blank.mmd"), ...O]);
  check("whitespace-only source is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("adir"), ...O]);
  check("a directory as input is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("nope.mmd"), ...O]);
  check("a missing file is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("dangling.mmd"), ...O]);
  check("an edge with nothing on one side is refused", r.code === EXIT.RENDER, `exit ${r.code}`);
  r = runSelf(["render", f("nohead.mmd"), ...O]);
  check("an unreadable diagram header is refused", r.code === EXIT.RENDER, `exit ${r.code}`);
  r = runSelf(["render", f("declared-empty.mmd"), ...O]);
  check("a diagram declared and left empty is refused", r.code === EXIT.RENDER, `exit ${r.code}`);
  r = runSelf(["render", f("seq.mmd"), ...O, "--engine", "native"]);
  check("a sequenceDiagram the native engine cannot draw is refused, not half-written", r.code === EXIT.RENDER, `exit ${r.code}`);
  check("...and no .svg was left behind for it", !fs.existsSync(path.join(f("out"), "seq.svg")), "seq.svg");
  r = runSelf(["render", f("seq.mmd"), ...O, "--bundle", f("no-bundle-here.html")]);
  check("a --bundle path that is not a file is refused, not silently swapped", r.code === EXIT.ARGS, `exit ${r.code}`);

  // ---------- refusals: bad arguments
  r = runSelf(["render", f("good.mmd"), "--nonsense"]);
  check("an unknown flag is refused instead of ignored", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("good.mmd"), "--out"]);
  check("a value flag with no value is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("good.mmd"), "--png-width", "wide", ...O]);
  check("--png-width with a non-number is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("good.mmd"), "--png-width", "9", ...O]);
  check("--png-width below the usable range is refused", r.code === EXIT.ARGS, `exit ${r.code}`);
  r = runSelf(["render", f("good.mmd"), "--slug", "../../escape", ...O]);
  const escaped = fs.existsSync(path.join(tmp, "..", "escape.svg")) || fs.existsSync(path.resolve(f("out"), "..", "..", "escape.svg"));
  check("a slug that tries to traverse out of the output dir cannot", r.code === EXIT.OK && !escaped, `exit ${r.code}`);
  r = runSelf(["render", f("good.mmd"), f("out"), f("extra"), "--no-png"]);
  check("a third positional argument is refused", r.code === EXIT.ARGS, `exit ${r.code}`);

  // ---------- the happy path, and then proof it is real
  r = runSelf(["render", f("good.mmd"), ...O, "--json"]);
  check("a real flowchart renders with no browser and no daemon", r.code === EXIT.OK, `exit ${r.code} ${r.stderr.slice(0, 160)}`);
  const outSvg = path.join(f("out"), "good.svg");
  const outScene = path.join(f("out"), "good.excalidraw");
  check("it wrote an .svg", isFile(outSvg), outSvg);
  check("it wrote an .excalidraw", isFile(outScene), outScene);
  const svgText = isFile(outSvg) ? fs.readFileSync(outSvg, "utf8") : "";
  check("every node label from the source is in the svg text", ["Client", "Has key?", "Vault", "Reject", "Done"].every((l) => svgText.includes(l)), "labels");
  check("every edge label from the source is in the svg text", ["POST /connect", "yes", "no"].every((l) => svgText.includes(l)), "edge labels");
  check("the svg carries a dark-mode palette", svgText.includes("prefers-color-scheme: dark"), "media query");
  const scene = isFile(outScene) ? JSON.parse(fs.readFileSync(outScene, "utf8")) : { elements: [] };
  check("the scene is excalidraw-typed with bound arrows", scene.type === "excalidraw" && scene.elements.some((e) => e.type === "arrow" && e.startBinding), `${scene.elements.length} elements`);

  // determinism
  const first = fs.readFileSync(outSvg);
  const firstScene = fs.readFileSync(outScene);
  runSelf(["render", f("good.mmd"), ...O]);
  check("rendering twice produces byte-identical svg", first.equals(fs.readFileSync(outSvg)), "svg bytes");
  check("rendering twice produces byte-identical scene", firstScene.equals(fs.readFileSync(outScene)), "scene bytes");

  // hostile content that gstack transports through a shell command line
  r = runSelf(["render", f("hostile.mmd"), ...O]);
  const hostile = isFile(path.join(f("out"), "hostile.svg")) ? fs.readFileSync(path.join(f("out"), "hostile.svg"), "utf8") : "";
  check(
    "backticks, ${} and backslashes in a label survive",
    r.code === EXIT.OK && hostile.includes("back`tick ${x} and \\ slash") && hostile.includes("&quot;quoted&quot; ok"),
    `exit ${r.code}`,
  );
  r = runSelf(["render", f("unicode.mmd"), ...O]);
  const uni = isFile(path.join(f("out"), "unicode.svg")) ? fs.readFileSync(path.join(f("out"), "unicode.svg"), "utf8") : "";
  check("CJK labels survive the render (gstack's atob() mangles these)", r.code === EXIT.OK && uni.includes("前端 client") && uni.includes("後端"), `exit ${r.code}`);

  fs.writeFileSync(f("semis.mmd"), "graph TD\n  A[One]; B[Two]; A --> B\n", "utf8");
  r = runSelf(["render", f("semis.mmd"), ...O]);
  const semis = isFile(path.join(f("out"), "semis.svg")) ? fs.readFileSync(path.join(f("out"), "semis.svg"), "utf8") : "";
  check("semicolon-separated statements split, but #quot; is not cut in half", r.code === EXIT.OK && semis.includes("One") && semis.includes("Two"), `exit ${r.code}`);

  // cycles and scale
  r = runSelf(["render", f("cycle.mmd"), ...O]);
  check("a cycle and a self-loop lay out instead of hanging", r.code === EXIT.OK, `exit ${r.code}`);
  r = runSelf(["render", f("big.mmd"), ...O]);
  check("a 151-node diagram renders (no command-line length limit here)", r.code === EXIT.OK, `exit ${r.code}`);

  // ---------- the verifier itself, on files that are wrong in every way
  fs.writeFileSync(f("undefined.svg"), "undefined", "utf8");
  r = runSelf(["verify", f("undefined.svg")]);
  check('verify catches an .svg containing the literal "undefined" (gstack writes this)', r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("err.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" aria-roledescription="error"><text>Syntax error in text</text><rect/></svg>', "utf8");
  r = runSelf(["verify", f("err.svg")]);
  check("verify catches a mermaid error graphic posing as a diagram", r.code === EXIT.VERIFY, `exit ${r.code}`);
  // The other direction, which is how this check was found to be wrong: every
  // healthy mermaid sequence diagram carries an `.error-icon` rule in its
  // stylesheet, so a verifier that greps the file for that string rejects good
  // renders. Only the role and the VISIBLE text may condemn a diagram.
  fs.writeFileSync(
    f("healthy.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="450" height="259" aria-roledescription="sequence">' +
      "<style>.error-icon{fill:#552222}.error-text{fill:#552222}</style>" +
      '<rect width="450" height="259" fill="#fff"/><text>Client</text><text>Server</text></svg>',
    "utf8",
  );
  r = runSelf(["verify", f("healthy.svg")]);
  check("verify does NOT reject a healthy svg whose stylesheet mentions error-icon", r.code === EXIT.OK, `exit ${r.code} ${r.stdout.slice(0, 120)}`);
  fs.writeFileSync(f("cut.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect/>', "utf8");
  r = runSelf(["verify", f("cut.svg")]);
  check("verify catches an .svg that was cut off mid-file", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("nosize.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "utf8");
  r = runSelf(["verify", f("nosize.svg")]);
  check("verify catches an .svg with no usable width or height", r.code === EXIT.VERIFY, `exit ${r.code}`);
  r = runSelf(["verify", outSvg]);
  check("verify passes the .svg this engine actually produced", r.code === EXIT.OK, `exit ${r.code} ${r.stdout.slice(0, 120)}`);

  fs.writeFileSync(f("empty-scene.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: [] }), "utf8");
  r = runSelf(["verify", f("empty-scene.excalidraw")]);
  check("verify catches a scene with zero elements", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(
    f("nan-scene.excalidraw"),
    JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", type: "rectangle", x: null, y: 0, width: 10, height: 10 }] }),
    "utf8",
  );
  r = runSelf(["verify", f("nan-scene.excalidraw")]);
  check("verify catches a scene with a non-finite coordinate", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("notjson.excalidraw"), "{ nope", "utf8");
  r = runSelf(["verify", f("notjson.excalidraw")]);
  check("verify catches a scene that is not JSON", r.code === EXIT.VERIFY, `exit ${r.code}`);
  r = runSelf(["verify", outScene]);
  check("verify passes the scene this engine actually produced", r.code === EXIT.OK, `exit ${r.code} ${r.stdout.slice(0, 120)}`);

  // ---------- raster checks, built here so they need no browser
  const realPng = makePng(200, 80, (x, y) => (x > 40 && x < 160 && y > 20 && y < 60 ? [20, 30, 60] : [255, 255, 255]));
  fs.writeFileSync(f("real.png"), realPng);
  r = runSelf(["verify", f("real.png")]);
  check("verify passes a png with a picture in it", r.code === EXIT.OK, `exit ${r.code} ${r.stdout.slice(0, 140)}`);
  fs.writeFileSync(f("blank.png"), makePng(200, 80, () => [255, 255, 255]));
  r = runSelf(["verify", f("blank.png")]);
  check("verify catches an all-white png (the screenshot-before-paint failure)", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("black.png"), makePng(200, 80, () => [0, 0, 0]));
  r = runSelf(["verify", f("black.png")]);
  check("verify catches an all-black png", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("speck.png"), makePng(400, 400, (x, y) => (x === 1 && y === 1 ? [0, 0, 0] : [255, 255, 255])));
  r = runSelf(["verify", f("speck.png")]);
  check("verify catches a png that is blank apart from a speck", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("cut.png"), realPng.subarray(0, Math.floor(realPng.length * 0.6)));
  r = runSelf(["verify", f("cut.png")]);
  check("verify catches a truncated png", r.code === EXIT.VERIFY, `exit ${r.code}`);
  fs.writeFileSync(f("fake.png"), "this is not a png at all", "utf8");
  r = runSelf(["verify", f("fake.png")]);
  check("verify catches a text file wearing a .png extension", r.code === EXIT.VERIFY, `exit ${r.code}`);
  const corrupt = Buffer.from(realPng);
  corrupt[corrupt.length - 30] ^= 0xff;
  fs.writeFileSync(f("corrupt.png"), corrupt);
  r = runSelf(["verify", f("corrupt.png")]);
  check("verify catches a png whose pixel data does not inflate", r.code === EXIT.VERIFY, `exit ${r.code}`);

  r = runSelf(["verify", f("nothing-here.svg")]);
  check("verify refuses a file that does not exist", r.code === EXIT.VERIFY, `exit ${r.code}`);

  // ---------- the no-browser machine: deliver what is real, say what is not
  r = runSelf(["render", f("good.mmd"), "--out", f("nb"), "--quiet"], { env: { TB_DIAGRAM_NO_BROWSER: "1" } });
  check(
    "with no browser it still writes a verified svg and scene, and exits 4",
    r.code === EXIT.BROWSER && isFile(path.join(f("nb"), "good.svg")) && isFile(path.join(f("nb"), "good.excalidraw")) && !isFile(path.join(f("nb"), "good.png")),
    `exit ${r.code}`,
  );
  r = runSelf(["render", f("good.mmd"), "--browser", f("no-chrome-here.exe"), ...O]);
  check("a --browser path that is not a file is refused, not silently swapped", r.code === EXIT.ARGS, `exit ${r.code}`);

  // ---------- output directory handling (never /tmp, always created)
  const deep = path.join(tmp, "made", "up", "path");
  r = runSelf(["render", f("good.mmd"), "--out", deep, "--no-png", "--quiet"]);
  check("a missing output directory is created rather than an error", r.code === EXIT.OK && isFile(path.join(deep, "good.svg")), `exit ${r.code}`);

  // A selftest whose total depends on where it was run from is a selftest that
  // can quietly stop asserting things.
  const EXPECTED = 52;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    pass: results.length + 1 === EXPECTED,
    detail: `${results.length + 1} ran`,
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((x) => x.name.length));
  process.stdout.write(`\n  tb-diagram selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const x of results) process.stdout.write(`  ${x.pass ? "PASS" : "FAIL"}  ${x.name.padEnd(width)}  ${x.detail}\n`);
  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write(`\n  This engine is NOT trustworthy in this state. Failures:\n`);
    for (const x of failed) process.stdout.write(`    - ${x.name}: ${x.detail}\n`);
    process.stdout.write("\n");
    return 1;
  }
  process.stdout.write("\n  Every deliberately broken input above was refused, and every artifact this\n");
  process.stdout.write("  engine produced was read back off disk and checked. It fails closed.\n\n");
  return 0;
}

// --------------------------------------------------------------------- main

function usage() {
  return `tb-diagram ${VERSION} - mermaid in, verified diagram out. No daemon, no bundle, no network.

  render <source.mmd|-> [outdir]   write .mmd .svg .excalidraw .png and verify all of them
  verify <file> ...                check an .svg / .png / .excalidraw / .mmd on disk
  doctor                           what this machine can do
  selftest                         prove the refusals and the checks still work

Flags
  --out <dir>        output directory (default ./diagrams; never /tmp)
  --slug <name>      base name for the artifacts (sanitised, cannot escape --out)
  --engine <auto|native|bundle>
  --png-width <px>   raster width, default 1950 (300dpi at 6.5in)
  --no-png           skip the raster
  --browser <path>   Chromium-family binary to rasterise with
  --bundle <path>    gstack render bundle, for non-flowchart mermaid types
  --timeout <ms>     default 45000
  --json --quiet --verbose

Exit codes: 0 ok, 1 bad arguments or input, 2 render refused, 3 an artifact failed
verification, 4 no browser (the .svg and .excalidraw were still written).`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "render":
        process.exitCode = await cmdRender(rest);
        return;
      case "verify":
        process.exitCode = cmdVerify(rest);
        return;
      case "doctor":
        process.exitCode = cmdDoctor();
        return;
      case "selftest":
        process.exitCode = selftest();
        return;
      case "--version":
      case "version":
        process.stdout.write(`${VERSION}\n`);
        return;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exitCode = cmd === undefined ? EXIT.ARGS : EXIT.OK;
        return;
      default:
        process.stderr.write(`unknown command ${JSON.stringify(cmd)}\n\n${usage()}\n`);
        process.exitCode = EXIT.ARGS;
    }
  } catch (err) {
    if (!err.printed) process.stderr.write(`${err.message}\n`);
    process.exitCode = err.exitCode ?? EXIT.RENDER;
  }
}

main();
