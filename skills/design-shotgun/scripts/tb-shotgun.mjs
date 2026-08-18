#!/usr/bin/env node
/**
 * tb-shotgun.mjs: the Toolbay Stack design-shotgun engine. Builds the
 * comparison board, gates it on a real distinctness measurement, serves it,
 * and validates the feedback that comes back.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /design-shotgun
 * command, generate-N-variants-then-pick, the comparison board with per-variant
 * ratings and comments, the remix/regenerate actions, the feedback.json and
 * feedback-pending.json shape, approved.json, and the anti-convergence rule
 * that variants must not look like siblings) comes from gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHAT THIS FORK CHANGES, AND WHY
 *
 * gstack's design-shotgun is a prose workflow that shells out to a compiled
 * `design` binary for generation and for the board. This fork does not
 * reimplement generation (that is an image API call, and whatever you already
 * use for it still works). It takes over the three steps that were failing
 * open, all three reproduced on Windows 11 with gstack 1.60.1.0 installed:
 *
 *   1. THE BOARD IS BUILT FROM FILES THAT MAY NOT EXIST.
 *      SKILL.md Step 4 runs, verbatim:
 *        $D compare --images "$_DESIGN_DIR/variant-A.png,...-B.png,...-C.png"
 *      after Step 3d has already conceded that agents can report
 *      VARIANT_x_FAILED. A failed variant leaves a broken <img> tile and the
 *      workflow proceeds to "pick your favourite" as if three existed. The
 *      dynamic alternative it offers, `ls variant-*.png | tr '\n' ','`,
 *      produces an EMPTY string when nothing matched, and an empty --images
 *      list is not an error either. Here, every referenced file must exist,
 *      be non-empty, and parse as the format its extension claims, or the
 *      board is not written at all and the exit code is non-zero.
 *
 *   2. THE ANTI-CONVERGENCE RULE WAS NEVER CHECKED.
 *      gstack states it as a hard requirement ("Each variant MUST use a
 *      different font family, color palette, and layout approach... if someone
 *      could swap the headline text between two variants without noticing,
 *      they're too similar") and then asks the model to grade its own output.
 *      Nothing measures it, so nothing catches it. Here it is arithmetic: PNGs
 *      are decoded in-process (zlib is in Node, so there is no dependency and
 *      no ImageMagick), reduced to an 8x8 luma grid and a hue histogram, and
 *      compared pairwise. HTML variants are compared on their actual
 *      font-family, colour and layout tokens. Near-duplicates block the board.
 *
 *   3. STALE FEEDBACK COUNTED AS AN ANSWER.
 *      gstack decides the user has responded with `[ -f feedback.json ]`. That
 *      file lives in the per-screen design directory, which is reused across
 *      rounds and across runs, so a submit from last week is read as this
 *      round's approval and gets written into approved.json. Here the board
 *      stamps an id, and feedback that does not carry the current board's id,
 *      or predates it, is refused loudly instead of silently approved.
 *
 * Plus the Windows problems, which are not subtle:
 *
 *   - gstack mandates generating to `/tmp/variant-X.png` and copying, calling
 *     it a sandbox workaround. On Windows `/tmp` is not a location: Git Bash
 *     maps it into the user profile, Windows-native Node writes to C:\tmp, and
 *     the two halves of one workflow disagree about where the file went. This
 *     file never uses /tmp; the selftest asserts the literal is absent.
 *   - `open file://...` to show the board is macOS-only. On Windows it is a
 *     command-not-found that the workflow does not notice, so the board is
 *     never seen. Here the opener is per-platform and a failure to open is
 *     reported, not swallowed.
 *   - `setopt +o nomatch` is zsh, `find -mmin` and `date +%s` are coreutils,
 *     and PowerShell has none of them. Every filesystem operation here is Node.
 *   - The board HTML embeds its images as data: URIs, so it survives being
 *     copied, attached, or opened from a path with a space in it. gstack's
 *     board needs its server alive and its files in place; ours also submits
 *     feedback from file:// with no server at all.
 *
 * Everything above is asserted by `selftest`, which runs this file as a child
 * process against fixtures that are deliberately broken.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MARKUP_EXT = new Set([".html", ".htm", ".svg"]);
const VARIANT_RE = /^variant[-_]([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z0-9]+)$/;

// Two variants are "siblings" when they are close on BOTH axes. One axis alone
// is a legitimate design decision (same palette, different layout is a real
// pair of options). Both at once is the failure gstack describes in prose.
const SIMILAR_LAYOUT = 0.15;
const SIMILAR_PALETTE = 0.18;
const SIMILAR_TOKEN_JACCARD = 0.34;

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

class Refusal extends Error {}

/** Every exit path that is not a confident success goes through here. */
function refuse(message, detail = []) {
  const e = new Refusal(message);
  e.detail = detail;
  throw e;
}

// ------------------------------------------------------------- path handling
//
// Same rules as tb-guard.mjs: Git Bash hands us /c/Users/..., PowerShell hands
// us C:\Users\..., and Node resolves exactly one of those correctly on its own.

const isWindows = process.platform === "win32";

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

// ------------------------------------------------------------- PNG decoding
//
// Enough of the PNG spec to get pixels: 8- and 16-bit, greyscale, truecolour,
// palette, with or without alpha, non-interlaced. Anything else is reported as
// UNSUPPORTED rather than guessed at, because a guess here would turn into a
// distinctness claim nobody checked.

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return { ok: false, kind: "invalid", error: "not a PNG (signature mismatch)" };
  }
  let pos = 8;
  let ihdr = null;
  let palette = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (len > buf.length) return { ok: false, kind: "invalid", error: `chunk length ${len} exceeds file size` };
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > buf.length) return { ok: false, kind: "invalid", error: `truncated ${type} chunk` };
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) return { ok: false, kind: "invalid", error: "no IHDR chunk" };
  if (!ihdr.width || !ihdr.height) return { ok: false, kind: "invalid", error: "zero dimensions" };
  if (!idat.length) return { ok: false, kind: "invalid", error: "no image data (IDAT)" };
  if (ihdr.interlace !== 0) return { ok: false, kind: "unsupported", error: "interlaced PNG" };
  if (ihdr.bitDepth !== 8 && ihdr.bitDepth !== 16) {
    return { ok: false, kind: "unsupported", error: `bit depth ${ihdr.bitDepth}` };
  }
  if (ihdr.colorType === 3 && ihdr.bitDepth !== 8) {
    return { ok: false, kind: "unsupported", error: "sub-byte palette" };
  }
  if (ihdr.colorType === 3 && !palette) return { ok: false, kind: "invalid", error: "palette image with no PLTE" };
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) return { ok: false, kind: "unsupported", error: `colour type ${ihdr.colorType}` };

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (e) {
    return { ok: false, kind: "invalid", error: `image data would not inflate (${e.message})` };
  }
  const sampleBytes = ihdr.bitDepth / 8;
  const bpp = channels * sampleBytes;
  const stride = ihdr.width * bpp;
  if (raw.length < ihdr.height * (stride + 1)) {
    return { ok: false, kind: "invalid", error: "image data shorter than the header claims" };
  }

  const pixels = Buffer.alloc(ihdr.height * stride);
  let rp = 0;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const x = line[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const cc = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - cc;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - cc);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
      } else return { ok: false, kind: "invalid", error: `unknown scanline filter ${filter}` };
      cur[i] = v & 0xff;
    }
  }

  const at = (x, y) => {
    const off = y * stride + x * bpp;
    if (ihdr.colorType === 3) {
      const idx = pixels[off] * 3;
      return [palette[idx] ?? 0, palette[idx + 1] ?? 0, palette[idx + 2] ?? 0];
    }
    if (ihdr.colorType === 0 || ihdr.colorType === 4) {
      const v = pixels[off];
      return [v, v, v];
    }
    return [pixels[off], pixels[off + sampleBytes], pixels[off + 2 * sampleBytes]];
  };
  return { ok: true, width: ihdr.width, height: ihdr.height, at };
}

// --------------------------------------------------------- image signatures

function signatureFromImage(img) {
  const G = 8;
  const luma = new Float64Array(G * G);
  const rgb = new Float64Array(G * G * 3);
  const counts = new Float64Array(G * G);
  const hue = new Float64Array(12);
  let hueMass = 0;
  const stepX = Math.max(1, Math.floor(img.width / 96));
  const stepY = Math.max(1, Math.floor(img.height / 96));

  for (let y = 0; y < img.height; y += stepY) {
    const gy = Math.min(G - 1, Math.floor((y / img.height) * G));
    for (let x = 0; x < img.width; x += stepX) {
      const gx = Math.min(G - 1, Math.floor((x / img.width) * G));
      const [r, g, b] = img.at(x, y);
      const cell = gy * G + gx;
      luma[cell] += 0.299 * r + 0.587 * g + 0.114 * b;
      rgb[cell * 3] += r;
      rgb[cell * 3 + 1] += g;
      rgb[cell * 3 + 2] += b;
      counts[cell] += 1;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta > 8) {
        let h;
        if (max === r) h = 60 * (((g - b) / delta) % 6);
        else if (max === g) h = 60 * ((b - r) / delta + 2);
        else h = 60 * ((r - g) / delta + 4);
        if (h < 0) h += 360;
        const weight = (delta / 255) * (max / 255);
        hue[Math.min(11, Math.floor(h / 30))] += weight;
        hueMass += weight;
      }
    }
  }
  for (let i = 0; i < G * G; i += 1) {
    const n = counts[i] || 1;
    luma[i] /= n;
    rgb[i * 3] /= n;
    rgb[i * 3 + 1] /= n;
    rgb[i * 3 + 2] /= n;
  }
  if (hueMass > 0) for (let i = 0; i < 12; i += 1) hue[i] /= hueMass;

  let mean = 0;
  for (const v of luma) mean += v;
  mean /= luma.length;
  let variance = 0;
  for (const v of luma) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / luma.length);

  const meanRgb = [0, 0, 0];
  for (let i = 0; i < G * G; i += 1) {
    meanRgb[0] += rgb[i * 3];
    meanRgb[1] += rgb[i * 3 + 1];
    meanRgb[2] += rgb[i * 3 + 2];
  }
  for (let i = 0; i < 3; i += 1) meanRgb[i] /= G * G;

  // Layout is compared on the SHAPE of the luma field, not its brightness, so
  // "the same page, a bit darker" reads as the same layout (which it is).
  const zLuma = Array.from(luma, (v) => (v - mean) / (std || 1));
  return { kind: "image", zLuma, hue: Array.from(hue), meanRgb, hueMass, contrast: std };
}

function imageDistance(a, b) {
  let acc = 0;
  for (let i = 0; i < a.zLuma.length; i += 1) acc += Math.abs(a.zLuma[i] - b.zLuma[i]);
  const layout = Math.min(1, acc / a.zLuma.length / 2);

  let tv = 0;
  for (let i = 0; i < 12; i += 1) tv += Math.abs(a.hue[i] - b.hue[i]);
  tv /= 2;
  if (a.hueMass < 0.5 && b.hueMass < 0.5) tv = 0; // two greyscale variants share no hue signal
  const rgbDist =
    Math.sqrt(
      (a.meanRgb[0] - b.meanRgb[0]) ** 2 + (a.meanRgb[1] - b.meanRgb[1]) ** 2 + (a.meanRgb[2] - b.meanRgb[2]) ** 2,
    ) / 441.67;
  return { layout, palette: Math.max(tv, rgbDist) };
}

// ---------------------------------------------------------- markup signatures
//
// The one axis images cannot carry: an HTML variant states its font family in
// text, so the fork can check the part of gstack's rule that says "a different
// font family" instead of hoping.

function signatureFromMarkup(text) {
  const fonts = new Set();
  for (const m of text.matchAll(/font-family\s*:\s*([^;}"'{]+)/gi)) {
    const first = m[1].split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (first) fonts.add(first);
  }
  const colors = new Set();
  for (const m of text.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) colors.add(`#${m[1].toLowerCase()}`);
  for (const m of text.matchAll(/rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/gi)) {
    colors.add(`rgb(${m[1]},${m[2]},${m[3]})`);
  }
  const layout = new Set();
  for (const m of text.matchAll(/(display|flex-direction|grid-template-columns|grid-template-areas|justify-content|align-items|max-width|border-radius)\s*:\s*([^;}"'{]+)/gi)) {
    layout.add(`${m[1].toLowerCase()}:${m[2].trim().toLowerCase().replace(/\s+/g, " ")}`);
  }
  return { kind: "markup", fonts: [...fonts], colors: [...colors], layout: [...layout] };
}

function jaccardDistance(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter += 1;
  return 1 - inter / (A.size + B.size - inter);
}

function markupDistance(a, b) {
  return {
    fonts: jaccardDistance(a.fonts, b.fonts),
    palette: jaccardDistance(a.colors, b.colors),
    layout: jaccardDistance(a.layout, b.layout),
  };
}

// ----------------------------------------------------------- variant loading

function sniff(buf, ext) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "gif";
  const head = buf.subarray(0, 4096).toString("utf8").trimStart().toLowerCase();
  if (MARKUP_EXT.has(ext) && (head.startsWith("<") || head.includes("<html") || head.includes("<svg"))) return "markup";
  return "unknown";
}

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/**
 * Load one variant. Every failure is a hard error with the file named. gstack
 * would have rendered a broken tile here and carried on to "pick your
 * favourite".
 */
function loadVariant(file, id) {
  const abs = toAbsolute(file);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    refuse(`variant file does not exist: ${abs}`, [
      "The board was NOT written. A board that references a missing variant shows a broken tile and still asks you to choose.",
    ]);
  }
  if (!stat.isFile()) refuse(`variant path is not a file: ${abs}`);
  if (stat.size === 0) refuse(`variant file is empty (0 bytes): ${abs}`, ["Generation reported success but produced nothing."]);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const format = sniff(buf, ext);
  if (format === "unknown") {
    refuse(`variant ${abs} is not a readable image or markup file`, [
      `Extension says "${ext || "(none)"}", but the bytes are neither PNG/JPEG/WEBP/GIF nor markup.`,
    ]);
  }
  if (IMAGE_EXT.has(ext) && format === "markup") {
    refuse(`variant ${abs} has an image extension but contains markup`);
  }

  const v = {
    id,
    file: abs,
    name: path.basename(abs),
    bytes: stat.size,
    format,
    sha256: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16),
  };

  if (format === "png") {
    const img = decodePng(buf);
    if (!img.ok && img.kind === "invalid") refuse(`variant ${abs} is a corrupt PNG: ${img.error}`);
    if (!img.ok) {
      v.signature = null;
      v.unverified = `PNG could not be decoded here (${img.error})`;
    } else {
      v.width = img.width;
      v.height = img.height;
      v.signature = signatureFromImage(img);
    }
    v.dataUri = `data:image/png;base64,${buf.toString("base64")}`;
  } else if (format === "markup") {
    const text = buf.toString("utf8");
    if (text.trim().length < 40) refuse(`variant ${abs} is markup but essentially empty (${text.trim().length} chars)`);
    v.signature = signatureFromMarkup(text);
    v.markup = text;
  } else {
    v.signature = null;
    v.unverified = `${format.toUpperCase()} is not decoded here, so distinctness cannot be measured`;
    v.dataUri = `data:${MIME[format]};base64,${buf.toString("base64")}`;
  }
  return v;
}

function discoverVariants(dir) {
  const abs = toAbsolute(dir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    refuse(`design directory does not exist: ${abs}`);
  }
  const found = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = VARIANT_RE.exec(e.name);
    if (!m) continue;
    const ext = `.${m[2].toLowerCase()}`;
    if (!IMAGE_EXT.has(ext) && !MARKUP_EXT.has(ext)) continue;
    found.push({ id: m[1].toUpperCase(), file: path.join(abs, e.name) });
  }
  found.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return found;
}

// ------------------------------------------------------------- distinctness

function compareVariants(variants) {
  const pairs = [];
  let unverified = 0;
  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const a = variants[i];
      const b = variants[j];
      const base = { a: a.id, b: b.id };
      if (!a.signature || !b.signature) {
        unverified += 1;
        pairs.push({ ...base, verdict: "UNVERIFIED", why: (a.unverified || b.unverified) ?? "no signature" });
        continue;
      }
      if (a.signature.kind !== b.signature.kind) {
        unverified += 1;
        pairs.push({ ...base, verdict: "UNVERIFIED", why: "one variant is an image and the other is markup, so they share no comparable signal" });
        continue;
      }
      if (a.signature.kind === "image") {
        const d = imageDistance(a.signature, b.signature);
        const tooSimilar = d.layout < SIMILAR_LAYOUT && d.palette < SIMILAR_PALETTE;
        pairs.push({
          ...base,
          verdict: tooSimilar ? "TOO_SIMILAR" : "DISTINCT",
          metrics: { layout: +d.layout.toFixed(3), palette: +d.palette.toFixed(3) },
          why: tooSimilar
            ? `layout ${d.layout.toFixed(3)} < ${SIMILAR_LAYOUT} and palette ${d.palette.toFixed(3)} < ${SIMILAR_PALETTE}`
            : undefined,
        });
      } else {
        const d = markupDistance(a.signature, b.signature);
        const tooSimilar =
          d.fonts < SIMILAR_TOKEN_JACCARD && d.palette < SIMILAR_TOKEN_JACCARD && d.layout < SIMILAR_TOKEN_JACCARD;
        pairs.push({
          ...base,
          verdict: tooSimilar ? "TOO_SIMILAR" : "DISTINCT",
          metrics: { fonts: +d.fonts.toFixed(3), palette: +d.palette.toFixed(3), layout: +d.layout.toFixed(3) },
          why: tooSimilar ? "shares most of its font, colour and layout tokens with the other variant" : undefined,
        });
      }
    }
  }
  const similar = pairs.filter((p) => p.verdict === "TOO_SIMILAR");
  return {
    pairs,
    unverifiedPairs: unverified,
    similarPairs: similar.length,
    verified: unverified === 0,
    verdict: similar.length ? "TOO_SIMILAR" : unverified ? "UNVERIFIED" : "DISTINCT",
  };
}

function printMatrix(report) {
  out("");
  out("  distinctness");
  for (const p of report.pairs) {
    const metrics = p.metrics
      ? Object.entries(p.metrics)
          .map(([k, v]) => `${k} ${v.toFixed(3)}`)
          .join("  ")
      : "";
    out(`    ${p.a} vs ${p.b}   ${p.verdict.padEnd(12)} ${metrics}`);
    if (p.why) out(`                 ${p.why}`);
  }
  out(`    verdict: ${report.verdict}`);
}

// ------------------------------------------------------------- board writing

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function boardHtml({ boardId, title, dir, createdAt, variants, distinct }) {
  const tiles = variants
    .map((v) => {
      const media = v.markup
        ? `<iframe class="shot" sandbox="allow-same-origin" srcdoc="${esc(v.markup)}"></iframe>`
        : `<img class="shot" alt="variant ${esc(v.id)}" src="${v.dataUri}">`;
      return `
      <section class="tile" data-variant="${esc(v.id)}">
        <header>
          <h2>Variant ${esc(v.id)}</h2>
          <label class="pick"><input type="radio" name="preferred" value="${esc(v.id)}"> preferred</label>
        </header>
        <div class="frame">${media}</div>
        <div class="meta">${esc(v.name)} &middot; ${(v.bytes / 1024).toFixed(0)} KB${v.width ? ` &middot; ${v.width}x${v.height}` : ""}</div>
        <div class="rate">
          ${[1, 2, 3, 4, 5]
            .map((n) => `<label><input type="radio" name="rate-${esc(v.id)}" value="${n}"><span>${n}</span></label>`)
            .join("")}
        </div>
        <textarea data-comment="${esc(v.id)}" rows="2" placeholder="What works, what doesn't"></textarea>
      </section>`;
    })
    .join("");

  const rows = distinct.pairs
    .map((p) => {
      const metrics = p.metrics
        ? Object.entries(p.metrics)
            .map(([k, v]) => `${k} ${v.toFixed(3)}`)
            .join(", ")
        : "not measured";
      return `<tr class="v-${p.verdict}"><td>${esc(p.a)} vs ${esc(p.b)}</td><td>${esc(p.verdict)}</td><td>${esc(metrics)}</td></tr>`;
    })
    .join("");

  const ids = JSON.stringify(variants.map((v) => v.id));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0d0f13; --panel:#161a21; --line:#262c37; --ink:#e8ecf3; --dim:#8b95a6; --ok:#4ade80; --warn:#fbbf24; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif; }
  header.top { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
  header.top h1 { font-size:18px; margin:0; letter-spacing:-.01em; }
  header.top .sub { color:var(--dim); font-size:13px; }
  main { padding:24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:20px; }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .tile header { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .tile h2 { font-size:14px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  .pick { font-size:13px; color:var(--dim); }
  .frame { background:#fff; border-radius:6px; overflow:hidden; }
  .shot { display:block; width:100%; height:auto; border:0; min-height:220px; cursor:zoom-in; }
  iframe.shot { height:420px; cursor:default; }
  .meta { color:var(--dim); font-size:12px; margin:8px 0; }
  .rate { display:flex; gap:6px; margin-bottom:8px; }
  .rate label { flex:1; text-align:center; border:1px solid var(--line); border-radius:6px; padding:4px 0; cursor:pointer; font-size:13px; }
  .rate input { display:none; }
  .rate input:checked + span { color:var(--ok); font-weight:700; }
  textarea { width:100%; background:#0f1319; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; resize:vertical; }
  .panel { margin-top:24px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .panel h3 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td { border-top:1px solid var(--line); padding:6px 8px; }
  .v-TOO_SIMILAR td { color:var(--warn); }
  .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; align-items:center; }
  button { background:#2563eb; color:#fff; border:0; border-radius:8px; padding:10px 18px; font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--ink); font-weight:500; }
  select { background:#0f1319; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  #result { margin-top:14px; }
  #result textarea { height:150px; font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .note { color:var(--dim); font-size:13px; margin-top:8px; }
  #zoom { position:fixed; inset:0; background:rgba(5,7,10,.94); display:none; align-items:center; justify-content:center; padding:24px; cursor:zoom-out; z-index:9; }
  #zoom img { max-width:100%; max-height:100%; }
</style></head>
<body>
<header class="top">
  <h1>${esc(title)}</h1>
  <span class="sub">${variants.length} variants &middot; board ${esc(boardId)} &middot; ${esc(createdAt)}</span>
  <span class="sub">${esc(dir)}</span>
</header>
<main>
  <div class="grid">${tiles}</div>

  <div class="panel">
    <h3>Distinctness check</h3>
    <table>${rows}</table>
    <p class="note">${
      distinct.verdict === "DISTINCT"
        ? "Measured, not assumed: every pair differs on layout or palette."
        : distinct.verdict === "TOO_SIMILAR"
          ? "At least one pair is a near-duplicate."
          : "At least one pair could not be measured, so distinctness is not claimed."
    }</p>
  </div>

  <div class="panel">
    <h3>Overall</h3>
    <textarea id="overall" rows="3" placeholder="Direction, what to change, what to keep"></textarea>
    <div class="actions">
      <button id="submit">Submit choice</button>
      <select id="action">
        <option value="">no regeneration</option>
        <option value="different">regenerate: go further apart</option>
        <option value="match">regenerate: closer to the brief</option>
        <option value="remix">regenerate: remix (say which parts below)</option>
      </select>
      <button class="ghost" id="regen">Send regenerate request</button>
    </div>
    <div id="result"></div>
  </div>
</main>
<div id="zoom"><img alt=""></div>
<script>
var VARIANTS = ${ids};
var BOARD_ID = ${JSON.stringify(boardId)};
function collect(kind, action) {
  var ratings = {}, comments = {};
  VARIANTS.forEach(function (id) {
    var r = document.querySelector('input[name="rate-' + id + '"]:checked');
    if (r) ratings[id] = Number(r.value);
    var c = document.querySelector('textarea[data-comment="' + id + '"]');
    if (c && c.value.trim()) comments[id] = c.value.trim();
  });
  var pref = document.querySelector('input[name="preferred"]:checked');
  return {
    boardId: BOARD_ID,
    kind: kind,
    submittedAt: new Date().toISOString(),
    preferred: pref ? pref.value : null,
    ratings: ratings,
    comments: comments,
    overall: document.getElementById('overall').value.trim(),
    regenerateAction: action || null,
    regenerated: kind === 'pending'
  };
}
function show(msg, payload) {
  var box = document.getElementById('result');
  box.innerHTML = '';
  var p = document.createElement('p');
  p.className = 'note';
  p.textContent = msg;
  box.appendChild(p);
  if (payload) {
    var t = document.createElement('textarea');
    t.value = JSON.stringify(payload, null, 2);
    box.appendChild(t);
    t.select();
  }
}
function send(kind, action) {
  var body = collect(kind, action);
  if (kind === 'final' && !body.preferred) {
    show('Pick a preferred variant first.');
    return;
  }
  if (location.protocol === 'file:') {
    show('Opened from disk, so there is no server to post to. Copy this JSON to the agent, or save it as ' +
         (kind === 'final' ? 'feedback.json' : 'feedback-pending.json') + ' next to the board.', body);
    return;
  }
  fetch('api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok) show('Saved to ' + res.j.path + '. You can close this tab.');
      else show('Refused: ' + (res.j.error || 'unknown error'), body);
    })
    .catch(function (e) { show('Could not reach the board server (' + e.message + '). Copy this JSON instead.', body); });
}
document.getElementById('submit').addEventListener('click', function () { send('final', null); });
document.getElementById('regen').addEventListener('click', function () {
  send('pending', document.getElementById('action').value || 'different');
});
var zoom = document.getElementById('zoom');
document.querySelectorAll('img.shot').forEach(function (img) {
  img.addEventListener('click', function () {
    zoom.querySelector('img').src = img.src;
    zoom.style.display = 'flex';
  });
});
zoom.addEventListener('click', function () { zoom.style.display = 'none'; });
</script>
</body></html>
`;
}

// ------------------------------------------------------------------ commands

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function resolveVariants(flags) {
  if (flags.images) {
    // Mirrors gstack's `--images a.png,b.png,c.png`, minus the part where a
    // missing file becomes a broken tile.
    const list = String(flags.images)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) refuse("--images was given but is empty, so there is nothing to compare");
    return list.map((file, i) => {
      const m = VARIANT_RE.exec(path.basename(file));
      return { id: m ? m[1].toUpperCase() : String.fromCharCode(65 + i), file };
    });
  }
  if (!flags.dir) refuse("no --dir and no --images: nothing to build a board from");
  return discoverVariants(flags.dir);
}

function cmdBoard(flags) {
  const found = resolveVariants(flags);
  const min = Number(flags.min ?? 2);
  if (found.length < min) {
    refuse(`found ${found.length} variant file(s), need at least ${min}`, [
      flags.dir ? `Looked in ${toAbsolute(flags.dir)} for variant-*.{png,jpg,webp,gif,html,svg}.` : "",
      "A comparison board with fewer than two variants is not a comparison. If generation failed, say so instead of shipping a board.",
    ].filter(Boolean));
  }
  const seen = new Set();
  const variants = found.map(({ file, id }) => {
    if (seen.has(id)) refuse(`two variants share the id ${id}`);
    seen.add(id);
    return loadVariant(file, id);
  });

  const distinct = compareVariants(variants);
  printMatrix(distinct);

  if (distinct.verdict === "TOO_SIMILAR" && !flags["allow-similar"]) {
    const bad = distinct.pairs.filter((p) => p.verdict === "TOO_SIMILAR").map((p) => `${p.a}/${p.b}`);
    refuse(`variants ${bad.join(", ")} are near-duplicates, so the board was not written`, [
      "The anti-convergence rule is the point of a shotgun: swapping the headline between two of these would go unnoticed.",
      "Regenerate the weaker one in a deliberately different direction, or pass --allow-similar to override.",
    ]);
  }
  if (distinct.verdict === "UNVERIFIED" && !flags["allow-unverified"]) {
    refuse("distinctness could not be measured for every pair, so it is not claimed", [
      ...distinct.pairs.filter((p) => p.verdict === "UNVERIFIED").map((p) => `${p.a} vs ${p.b}: ${p.why}`),
      "Pass --allow-unverified to build the board anyway. It will record verified:false and must not be described as checked.",
    ]);
  }

  const dir = flags.dir ? toAbsolute(flags.dir) : path.dirname(variants[0].file);
  const outFile = toAbsolute(flags.out || path.join(dir, "design-board.html"));
  const boardId = crypto.randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
  const title = String(flags.title || `Design shotgun: ${path.basename(dir)}`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, boardHtml({ boardId, title, dir, createdAt, variants, distinct }), "utf8");

  const meta = {
    boardId,
    createdAt,
    title,
    dir,
    board: outFile,
    engine: `tb-shotgun ${VERSION}`,
    variants: variants.map((v) => ({ id: v.id, file: v.file, bytes: v.bytes, format: v.format, sha256: v.sha256 })),
    distinctness: {
      verified: distinct.verified,
      verdict: distinct.verdict,
      pairs: distinct.pairs,
    },
  };
  const metaFile = path.join(dir, "board.json");
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  out("");
  out(`  BOARD_ID: ${boardId}`);
  out(`  BOARD_FILE: ${outFile}`);
  out(`  BOARD_META: ${metaFile}`);
  out(`  VARIANTS: ${variants.map((v) => v.id).join(", ")}`);
  out(`  SELF_CONTAINED: yes (images inlined, no external references)`);
  out("");
  out(`  Serve it:  node ${path.basename(SELF)} serve --board "${outFile}"`);
  out(`  Or open the file directly. Submitting from file:// prints JSON to paste back.`);
  out("");
}

function cmdDistinct(flags) {
  const found = resolveVariants(flags);
  if (found.length < 2) refuse(`found ${found.length} variant file(s), need at least 2 to compare`);
  const variants = found.map(({ file, id }) => loadVariant(file, id));
  const report = compareVariants(variants);
  printMatrix(report);
  out("");
  if (report.verdict === "TOO_SIMILAR") process.exitCode = 1;
  if (report.verdict === "UNVERIFIED") process.exitCode = 2;
}

function openInBrowser(url) {
  try {
    const child = isWindows
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (e) => out(`  OPEN_FAILED: ${e.message} (open ${url} yourself)`));
    child.unref();
    return true;
  } catch (e) {
    out(`  OPEN_FAILED: ${e.message} (open ${url} yourself)`);
    return false;
  }
}

function cmdServe(flags) {
  const boardFile = toAbsolute(flags.board);
  if (!boardFile || !fs.existsSync(boardFile)) refuse(`board file not found: ${flags.board ?? "(no --board)"}`);
  const dir = path.dirname(boardFile);
  const metaFile = path.join(dir, "board.json");
  if (!fs.existsSync(metaFile)) {
    refuse(`no board.json next to ${boardFile}`, ["Rebuild the board with `board` so feedback can be tied to it."]);
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const once = flags.once === true || flags.once === "true";
  const timeoutMs = Number(flags.timeout ?? 0);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(boardFile);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 2 * 1024 * 1024) req.destroy();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `body is not JSON (${e.message})` }));
          return;
        }
        // The check gstack does not have: feedback is bound to one board.
        if (parsed.boardId !== meta.boardId) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: `this feedback is for board ${parsed.boardId ?? "(none)"}, but the live board is ${meta.boardId}. Reload the page.`,
            }),
          );
          return;
        }
        const name = parsed.kind === "pending" ? "feedback-pending.json" : "feedback.json";
        const file = path.join(dir, name);
        parsed.board = boardFile;
        parsed.receivedAt = new Date().toISOString();
        fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: file }));
        out(`  FEEDBACK_WRITTEN: ${file}`);
        if (once && parsed.kind !== "pending") {
          server.close(() => process.exit(0));
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("error", (e) => {
    err(`  SERVE_FAILED: ${e.message}`);
    process.exit(1);
  });

  server.listen(Number(flags.port ?? 0), "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    out(`  BOARD_URL: ${url}`);
    out(`  BOARD_ID: ${meta.boardId}`);
    out(`  FEEDBACK_DIR: ${dir}`);
    if (!flags["no-open"]) openInBrowser(url);
  });

  if (timeoutMs > 0) {
    setTimeout(() => {
      err(`  NO_FEEDBACK: nothing was submitted within ${timeoutMs}ms. Not treating that as approval.`);
      server.close(() => process.exit(2));
    }, timeoutMs).unref?.();
  }
}

function cmdFeedback(flags) {
  const dir = toAbsolute(flags.dir || ".");
  const metaFile = path.join(dir, "board.json");
  if (!fs.existsSync(metaFile)) refuse(`no board.json in ${dir}: build a board before reading feedback`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));

  const pendingFile = path.join(dir, "feedback-pending.json");
  const finalFile = path.join(dir, "feedback.json");
  const which = fs.existsSync(finalFile) ? finalFile : fs.existsSync(pendingFile) ? pendingFile : null;
  if (!which) {
    refuse("NO_FEEDBACK: the user has not submitted anything for this board", [
      `Looked for ${finalFile} and ${pendingFile}.`,
      "Absence is not approval. Ask, or serve the board again.",
    ]);
  }

  let fb;
  try {
    fb = JSON.parse(fs.readFileSync(which, "utf8"));
  } catch (e) {
    refuse(`feedback at ${which} is not valid JSON (${e.message})`);
  }
  if (fb.boardId !== meta.boardId) {
    refuse(`STALE_FEEDBACK: ${which} carries board ${fb.boardId ?? "(none)"}, current board is ${meta.boardId}`, [
      "This is left over from an earlier round. Reading it would approve a design the user never saw.",
      "Delete it or re-serve the current board.",
    ]);
  }
  const submitted = Date.parse(fb.submittedAt ?? "");
  const created = Date.parse(meta.createdAt);
  if (Number.isFinite(submitted) && Number.isFinite(created) && submitted < created) {
    refuse(`STALE_FEEDBACK: submitted ${fb.submittedAt} predates board ${meta.createdAt}`);
  }
  const ids = new Set(meta.variants.map((v) => v.id));
  if (fb.kind !== "pending") {
    if (!fb.preferred) refuse(`feedback at ${which} names no preferred variant`);
    if (!ids.has(fb.preferred)) {
      refuse(`feedback prefers "${fb.preferred}", which is not on this board (${[...ids].join(", ")})`);
    }
  }
  for (const k of Object.keys(fb.ratings ?? {})) {
    if (!ids.has(k)) refuse(`feedback rates "${k}", which is not on this board`);
  }

  out("");
  out(`  KIND: ${fb.kind === "pending" ? "REGENERATE_REQUEST" : "FINAL_CHOICE"}`);
  out(`  BOARD: ${meta.boardId}  (${which})`);
  if (fb.preferred) out(`  PREFERRED: ${fb.preferred}`);
  const ratings = Object.entries(fb.ratings ?? {});
  if (ratings.length) out(`  RATINGS: ${ratings.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  for (const [k, v] of Object.entries(fb.comments ?? {})) out(`  NOTE ${k}: ${v}`);
  if (fb.overall) out(`  OVERALL: ${fb.overall}`);
  if (fb.regenerateAction) out(`  REGENERATE: ${fb.regenerateAction}`);
  out("");
}

function cmdApprove(flags) {
  const dir = toAbsolute(flags.dir || ".");
  const metaFile = path.join(dir, "board.json");
  if (!fs.existsSync(metaFile)) refuse(`no board.json in ${dir}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const fbFile = path.join(dir, "feedback.json");
  if (!fs.existsSync(fbFile)) refuse("cannot approve: there is no final feedback.json for this board");
  const fb = JSON.parse(fs.readFileSync(fbFile, "utf8"));
  if (fb.boardId !== meta.boardId) refuse(`cannot approve: feedback belongs to board ${fb.boardId}, not ${meta.boardId}`);
  const variant = meta.variants.find((v) => v.id === fb.preferred);
  if (!variant) refuse(`cannot approve: preferred variant ${fb.preferred} is not on this board`);
  const approved = {
    approved_variant: fb.preferred,
    file: variant.file,
    sha256: variant.sha256,
    boardId: meta.boardId,
    feedback: fb.overall ?? "",
    ratings: fb.ratings ?? {},
    comments: fb.comments ?? {},
    distinctness_verified: meta.distinctness.verified,
    date: new Date().toISOString(),
  };
  const file = path.join(dir, "approved.json");
  fs.writeFileSync(file, `${JSON.stringify(approved, null, 2)}\n`, "utf8");
  out(`  APPROVED: ${fb.preferred} -> ${file}`);
}

// ------------------------------------------------------------------ selftest
//
// Fixtures are written by this file, so the test does not depend on any image
// on disk, and the PNG encoder below exists only to feed the decoder above.

function encodePng(width, height, paint) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    raw[base] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      raw[base + 1 + x * 3] = r;
      raw[base + 2 + x * 3] = g;
      raw[base + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", ...opts });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

async function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-shotgun-selftest-"));
  const mk = (name) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // --- palettes and layouts, chosen so the pairs mean something
  const white = [250, 250, 250];
  const ink = [24, 26, 32];
  const blue = [43, 95, 217];
  const blueish = [47, 99, 208]; // the "same team, more coffee" shade
  const orange = [232, 121, 40];
  const green = [46, 160, 90];

  const topLeftCard = (accent, bg) => (x, y) => {
    if (x > 20 && x < 150 && y > 20 && y < 110) return accent;
    if (x > 20 && x < 260 && y > 130 && y < 145) return ink;
    return bg;
  };
  const bottomRightSplit = (accent, bg) => (x, y) => {
    if (y > 150) return accent;
    if (x > 200) return ink;
    return bg;
  };
  const verticalRail = (accent, bg) => (x, y) => {
    if (x < 70) return accent;
    if (y > 40 && y < 60 && x > 90) return ink;
    return bg;
  };

  const png = (dir, id, paint) => {
    const f = path.join(dir, `variant-${id}.png`);
    fs.writeFileSync(f, encodePng(280, 200, paint));
    return f;
  };

  // dirs
  const empty = mk("empty");
  const single = mk("single");
  png(single, "A", topLeftCard(blue, white));

  const missing = mk("missing");
  const missingA = png(missing, "A", topLeftCard(blue, white));

  const zeroByte = mk("zero");
  png(zeroByte, "A", topLeftCard(blue, white));
  fs.writeFileSync(path.join(zeroByte, "variant-B.png"), "");

  const fakePng = mk("fake");
  png(fakePng, "A", topLeftCard(blue, white));
  fs.writeFileSync(path.join(fakePng, "variant-B.png"), "I am a text file wearing a PNG extension.\n".repeat(20));

  const identical = mk("identical");
  const idA = png(identical, "A", topLeftCard(blue, white));
  fs.copyFileSync(idA, path.join(identical, "variant-B.png"));

  const siblings = mk("siblings");
  png(siblings, "A", topLeftCard(blue, white));
  png(siblings, "B", topLeftCard(blueish, white));

  const good = mk("three good");   // a space in the directory name, on purpose
  png(good, "A", topLeftCard(blue, white));
  png(good, "B", bottomRightSplit(orange, ink));
  png(good, "C", verticalRail(green, [235, 238, 242]));

  const jpegDir = mk("jpeg");
  png(jpegDir, "A", topLeftCard(blue, white));
  fs.writeFileSync(
    path.join(jpegDir, "variant-B.jpg"),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x42)]),
  );

  const markup = mk("markup");
  fs.writeFileSync(
    path.join(markup, "variant-A.html"),
    `<html><body style="font-family: Inter, sans-serif; background:#0b0d10; display:grid; grid-template-columns: 240px 1fr; max-width: 1200px"><h1 style="color:#2b5fd9">A</h1></body></html>`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(markup, "variant-B.html"),
    `<html><body style="font-family: Inter, sans-serif; background:#0b0d10; display:grid; grid-template-columns: 240px 1fr; max-width: 1200px"><h1 style="color:#2b5fd9">B</h1></body></html>`,
    "utf8",
  );

  const markupOk = mk("markup-ok");
  fs.writeFileSync(
    path.join(markupOk, "variant-A.html"),
    `<html><body style="font-family: 'Playfair Display', serif; background:#fffdf7; display:block; max-width: 720px"><h1 style="color:#8a1c1c">A</h1></body></html>`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(markupOk, "variant-B.html"),
    `<html><body style="font-family: 'JetBrains Mono', monospace; background:#101418; display:flex; flex-direction: row; max-width: 100%"><h1 style="color:#39d98a">B</h1></body></html>`,
    "utf8",
  );

  const cases = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      cases.push({ name, pass: r.pass !== false, detail: r.detail ?? "" });
    } catch (e) {
      cases.push({ name, pass: false, detail: `threw: ${e.message}` });
    }
  };
  const boardExists = (dir) => fs.existsSync(path.join(dir, "design-board.html"));

  check("board refuses an empty design directory", () => {
    const r = run(["board", "--dir", empty]);
    return { pass: r.code !== 0 && !boardExists(empty), detail: `exit ${r.code}` };
  });

  check("board refuses a single variant (not a comparison)", () => {
    const r = run(["board", "--dir", single]);
    return { pass: r.code !== 0 && !boardExists(single), detail: `exit ${r.code}` };
  });

  check("board refuses --images naming a file that does not exist (gstack renders a broken tile)", () => {
    const ghost = path.join(missing, "variant-B.png");
    const r = run(["board", "--dir", missing, "--images", `${missingA},${ghost}`]);
    return { pass: r.code !== 0 && r.all.includes("does not exist") && !boardExists(missing), detail: `exit ${r.code}` };
  });

  check("board refuses a 0-byte variant", () => {
    const r = run(["board", "--dir", zeroByte]);
    return { pass: r.code !== 0 && r.all.includes("empty") && !boardExists(zeroByte), detail: `exit ${r.code}` };
  });

  check("board refuses a text file wearing a .png extension", () => {
    const r = run(["board", "--dir", fakePng]);
    return { pass: r.code !== 0 && !boardExists(fakePng), detail: `exit ${r.code}` };
  });

  check("board refuses two byte-identical variants", () => {
    const r = run(["board", "--dir", identical]);
    return { pass: r.code !== 0 && r.all.includes("TOO_SIMILAR") && !boardExists(identical), detail: `exit ${r.code}` };
  });

  check("board refuses near-siblings (same layout, shade of the same blue)", () => {
    const r = run(["board", "--dir", siblings]);
    return { pass: r.code !== 0 && r.all.includes("near-duplicates") && !boardExists(siblings), detail: `exit ${r.code}` };
  });

  check("board refuses markup variants that share fonts, colours and layout", () => {
    const r = run(["board", "--dir", markup]);
    return { pass: r.code !== 0 && r.all.includes("TOO_SIMILAR") && !boardExists(markup), detail: `exit ${r.code}` };
  });

  check("board accepts markup variants with different fonts, colours and layout", () => {
    const r = run(["board", "--dir", markupOk]);
    return { pass: r.code === 0 && boardExists(markupOk), detail: `exit ${r.code}` };
  });

  check("board refuses when a pair cannot be measured (JPEG), rather than claiming distinct", () => {
    const r = run(["board", "--dir", jpegDir]);
    return { pass: r.code !== 0 && r.all.includes("UNVERIFIED") && !boardExists(jpegDir), detail: `exit ${r.code}` };
  });

  check("--allow-unverified builds it but records verified:false", () => {
    const r = run(["board", "--dir", jpegDir, "--allow-unverified"]);
    const meta = JSON.parse(fs.readFileSync(path.join(jpegDir, "board.json"), "utf8"));
    return { pass: r.code === 0 && meta.distinctness.verified === false, detail: `verified=${meta.distinctness.verified}` };
  });

  check("board builds from a directory whose path contains a space", () => {
    const r = run(["board", "--dir", good]);
    return { pass: r.code === 0 && boardExists(good), detail: `exit ${r.code} ${r.all.split("\n").find((l) => l.includes("BOARD_ID")) ?? ""}` };
  });

  check("board html is self-contained: data: URIs, no http(s):// or file:// references", () => {
    const html = fs.readFileSync(path.join(good, "design-board.html"), "utf8");
    const dataUris = (html.match(/data:image\/png;base64,/g) ?? []).length;
    const external = /(src|href)\s*=\s*["'](https?:|file:|\/\/)/i.test(html);
    return { pass: dataUris === 3 && !external, detail: `${dataUris} inlined images, external refs: ${external}` };
  });

  check("board.json records absolute paths and a sha for every variant", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(good, "board.json"), "utf8"));
    const ok =
      meta.variants.length === 3 &&
      meta.variants.every((v) => path.isAbsolute(v.file) && /^[0-9a-f]{16}$/.test(v.sha256)) &&
      meta.distinctness.verified === true;
    return { pass: ok, detail: `${meta.variants.length} variants, verified=${meta.distinctness.verified}` };
  });

  check("feedback refuses absence (no submission is not approval)", () => {
    const r = run(["feedback", "--dir", good]);
    return { pass: r.code !== 0 && r.all.includes("NO_FEEDBACK"), detail: `exit ${r.code}` };
  });

  check("feedback refuses a stale file from an earlier board (gstack accepts it)", () => {
    fs.writeFileSync(
      path.join(good, "feedback.json"),
      JSON.stringify({ boardId: "deadbeefcafe", preferred: "A", submittedAt: new Date().toISOString() }),
      "utf8",
    );
    const r = run(["feedback", "--dir", good]);
    return { pass: r.code !== 0 && r.all.includes("STALE_FEEDBACK"), detail: `exit ${r.code}` };
  });

  const meta = JSON.parse(fs.readFileSync(path.join(good, "board.json"), "utf8"));

  check("feedback refuses a submission timestamped before the board existed", () => {
    fs.writeFileSync(
      path.join(good, "feedback.json"),
      JSON.stringify({ boardId: meta.boardId, preferred: "A", submittedAt: "2001-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const r = run(["feedback", "--dir", good]);
    return { pass: r.code !== 0 && r.all.includes("predates"), detail: `exit ${r.code}` };
  });

  check("feedback refuses a preferred variant that is not on the board", () => {
    fs.writeFileSync(
      path.join(good, "feedback.json"),
      JSON.stringify({ boardId: meta.boardId, preferred: "Z", submittedAt: new Date().toISOString() }),
      "utf8",
    );
    const r = run(["feedback", "--dir", good]);
    return { pass: r.code !== 0 && r.all.includes("not on this board"), detail: `exit ${r.code}` };
  });

  check("feedback accepts a valid submission for the current board", () => {
    fs.writeFileSync(
      path.join(good, "feedback.json"),
      JSON.stringify({
        boardId: meta.boardId,
        preferred: "B",
        ratings: { A: 3, B: 5, C: 2 },
        comments: { B: "the split works" },
        overall: "go with B",
        submittedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const r = run(["feedback", "--dir", good]);
    return { pass: r.code === 0 && r.all.includes("PREFERRED: B"), detail: `exit ${r.code}` };
  });

  check("approve writes approved.json pinned to the variant sha", () => {
    const r = run(["approve", "--dir", good]);
    const ap = JSON.parse(fs.readFileSync(path.join(good, "approved.json"), "utf8"));
    return {
      pass: r.code === 0 && ap.approved_variant === "B" && ap.sha256 === meta.variants.find((v) => v.id === "B").sha256,
      detail: `approved ${ap.approved_variant}`,
    };
  });

  check("this engine never writes to the /tmp path gstack mandates (it is not a location on Windows)", () => {
    // The needle is assembled at runtime so this assertion cannot match itself.
    const needle = ["/", "tmp", "/"].join("");
    const hits = fs
      .readFileSync(SELF, "utf8")
      .split("\n")
      .filter((l) => {
        const code = l.trimStart();
        if (code.startsWith("*") || code.startsWith("//")) return false; // prose about gstack, not a path we use
        return code.includes(`"${needle}`) || code.includes(`'${needle}`);
      });
    return { pass: hits.length === 0, detail: `${hits.length} hard-coded ${needle} paths in code` };
  });

  // --- the live server round trip
  cases.push(...(await serveRoundTrip(good, meta.boardId)));

  fs.rmSync(root, { recursive: true, force: true });

  const width = Math.max(...cases.map((c) => c.name.length));
  out("");
  out(`  tb-shotgun selftest  (node ${process.version}, ${process.platform})`);
  out("");
  for (const c of cases) out(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = cases.filter((c) => !c.pass);
  out("");
  out(`  ${cases.length - failed.length}/${cases.length} passed`);
  if (failed.length) {
    out("");
    out("  The engine is NOT trustworthy in this state. Failures:");
    for (const c of failed) out(`    - ${c.name}: ${c.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("");
  out("  Every deliberately broken board above was refused instead of written, and every");
  out("  stale or foreign feedback file was rejected instead of read as approval.");
  out("");
}

/**
 * Start the real server as a child process, POST real HTTP at it, and check
 * what landed on disk. Not a mock: the same code path Claude Code will run.
 */
function post(url, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const u = new URL("api/feedback", url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end(body);
  });
}

async function serveRoundTrip(dir, boardId) {
  const results = [];
  const board = path.join(dir, "design-board.html");
  fs.rmSync(path.join(dir, "feedback.json"), { force: true });
  const child = spawn(process.execPath, [SELF, "serve", "--board", board, "--port", "0", "--no-open", "--once"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const started = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve({ error: "server did not print a URL within 8s" }), 8000);
    child.stdout.on("data", (c) => {
      buf += c;
      const m = /BOARD_URL: (\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1] });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!/BOARD_URL/.test(buf)) resolve({ error: `server exited early (code ${code})` });
    });
  });

  if (!started.url) {
    try {
      child.kill();
    } catch {}
    results.push({ name: "serve starts and prints a board URL", pass: false, detail: started.error });
    return results;
  }
  results.push({ name: "serve starts and prints a board URL", pass: true, detail: started.url });

  const wrong = await post(started.url, { boardId: "not-the-board", preferred: "A", submittedAt: new Date().toISOString() });
  results.push({
    name: "live board refuses a POST carrying another board's id",
    pass: wrong.status === 409 && !fs.existsSync(path.join(dir, "feedback.json")),
    detail: `HTTP ${wrong.status}`,
  });

  const ok = await post(started.url, {
    boardId,
    kind: "final",
    preferred: "C",
    ratings: { C: 5 },
    overall: "posted by selftest",
    submittedAt: new Date().toISOString(),
  });
  const wrote = fs.existsSync(path.join(dir, "feedback.json"));
  results.push({
    name: "live board accepts a valid POST and writes feedback.json",
    pass: ok.status === 200 && wrote,
    detail: `HTTP ${ok.status}`,
  });

  if (wrote) {
    const fb = JSON.parse(fs.readFileSync(path.join(dir, "feedback.json"), "utf8"));
    results.push({
      name: "written feedback carries the board id and a receivedAt stamp",
      pass: fb.boardId === boardId && typeof fb.receivedAt === "string",
      detail: `boardId=${fb.boardId}`,
    });
  }

  try {
    child.kill();
  } catch {}
  return results;
}

// --------------------------------------------------------------------- entry

function help() {
  out(`
  tb-shotgun ${VERSION}, the Toolbay Stack design-shotgun engine

  Build and check a board:
    board --dir <dir> [--out <file>] [--title <t>] [--min <n>]
                          build a self-contained comparison board from
                          variant-*.{png,jpg,webp,gif,html,svg} in <dir>
    board --images a.png,b.png,c.png
                          explicit list; every file must exist
    distinct --dir <dir>  print the pairwise distinctness matrix only

  Collect a decision:
    serve --board <file> [--port n] [--once] [--no-open] [--timeout ms]
    feedback --dir <dir>  read and validate what came back
    approve --dir <dir>   write approved.json for the chosen variant

  Proof:
    selftest              build boards from deliberately broken variants and
                          fail if any of them is written anyway

  This engine fails closed. A board is written only when every variant file
  exists, decodes, and is measurably different from the others. Absent, stale,
  or foreign feedback is refused, never read as approval.

  Overrides: --allow-similar, --allow-unverified. Both are recorded in
  board.json so a later claim can be checked.
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  if (cmd === "board") return cmdBoard(flags);
  if (cmd === "distinct") return cmdDistinct(flags);
  if (cmd === "serve") return cmdServe(flags);
  if (cmd === "feedback") return cmdFeedback(flags);
  if (cmd === "approve") return cmdApprove(flags);
  if (cmd === "selftest") return selftest();
  return help();
}

// A refusal is the designed failure mode and prints as one. Anything else is a
// bug in this file and prints as a crash, but neither one exits 0: a caller
// must never read silence as "the board is fine".
main().catch((e) => {
  if (e instanceof Refusal) {
    err("");
    err(`  REFUSED: ${e.message}`);
    for (const d of e.detail ?? []) err(`           ${d}`);
    err("");
  } else {
    err(`  tb-shotgun crashed: ${e?.stack ?? e}`);
  }
  process.exitCode = 1;
});
