#!/usr/bin/env node
/**
 * tb-design.mjs: the evidence ledger and grade calculator behind /design-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (first impression, design-system extraction, the
 * ten audit categories and their percentage weights, the A-F per-category
 * grading rule of "start at A, a high finding drops a letter, a medium drops
 * half a letter", the dual Design Score / AI Slop Score headline, the
 * triage -> fix -> re-verify loop with one atomic commit per fix, the
 * verified / best-effort / reverted / deferred classification, the design-fix
 * risk heuristic and the baseline regression comparison) comes from
 * `design-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * /design-review is the skill whose entire output is visual claims, and it is
 * the skill with the least machinery for checking them.
 *
 * 1. THE HEADLINE GRADE IS ASSERTED, NOT COMPUTED. gstack publishes an exact
 *    rule and an exact weight table (design-review/SKILL.md:1568-1582):
 *
 *      "Each category starts at A. Each High-impact finding drops one letter
 *       grade. Each Medium-impact finding drops half a letter grade."
 *      | Visual Hierarchy | 15% | ... | Performance Feel | 5% |
 *
 *    and then nothing anywhere runs it. The model does that arithmetic from
 *    memory and writes a letter. Phase 9 then says "if final scores are WORSE
 *    than baseline: WARN prominently" -- a comparison of two numbers the same
 *    model invented on both ends. Here `grade` computes both scores from the
 *    recorded findings and exits non-zero on a regression.
 *
 * 2. "SCREENSHOTS ARE EVIDENCE" IS AN INSTRUCTION, NOT A CHECK. Rule 2 says
 *    every finding needs at least one screenshot (SKILL.md:1610) and Phase 8d
 *    takes a before/after pair (SKILL.md:1862-1867). Nothing ever opens those
 *    PNGs. Four ways a design audit goes green with no evidence behind it, all
 *    of which this file catches:
 *      - the file is 0 bytes, because the browser was not running
 *      - the file is an HTML error page with a .png name
 *      - the file is a valid PNG of a completely blank page, because the app
 *        never rendered. This is the one that matters most for design work: it
 *        is a real screenshot, of nothing, and it looks fine in a file listing.
 *      - the "after" screenshot is byte-identical to the "before", so the fix
 *        that was committed and classified `verified` changed nothing on
 *        screen.
 *
 * 3. CONTRAST IS ARITHMETIC AND IT IS BEING EYEBALLED. The checklist asks for
 *    "WCAG AA: body text 4.5:1, large text 3:1" (SKILL.md:1371) with no way to
 *    compute a ratio, so the model reads a screenshot and states a number.
 *    `contrast` computes the real WCAG 2.1 ratio, and recording a contrast
 *    finding that the arithmetic contradicts is refused outright.
 *
 * 4. WINDOWS. Two POSIX assumptions in the skill body that do not survive here,
 *    both measured on Windows 11 / Git Bash:
 *      $ open file:///c/Users/orion/board.html
 *      bash: open: command not found            (exit 127)
 *    gstack's comparison-board fallback is "use `open file://...`"
 *    (SKILL.md:1074). It exits 127, the board never opens, and nothing checks.
 *    `show` resolves the platform opener instead.
 *      $ cd /tmp && pwd -W          -> C:/Users/orion/AppData/Local/Temp
 *      $ node -p "path.resolve('/tmp/x')" -> C:\tmp\x
 *    so a POSIX system path in --dir means one directory to the browser and a
 *    different one to the report. `init` refuses it and names both.
 *
 * The ledger is a plain JSON file. The value is that the grade is arithmetic on
 * recorded facts, and a fact needs an artifact that a program could open.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseColor, contrastRatio, contrastVerdict, isLargeText, relativeLuminance, round2 } from "./tb-color.mjs";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS, resolveOutDir as resolveOutDirShared } from "./tb-outdir.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger; shared reader/writer in src/ledger/tb-ledger.mjs.
const ledgerPath = (dir) => ledgerPathShared(dir);
function readLedger(dir) {
  return readLedgerShared(dir, {
    what: "design ledger",
    hint: 'Run "tb-design.mjs init --target <url>" first. An unrecorded audit is not a graded audit.',
    require: ["findings"],
  });
}
function writeLedger(dir, ledger) {
  return writeLedgerShared(dir, ledger);
}


/**
 * This skill's output directory. The refusal and the resolution are shared
 * (src/outdir/tb-outdir.mjs); only the default and the consequence sentence
 * are this skill's.
 */
function resolveOutDir(raw) {
  return resolveOutDirShared(raw, {
    defaultDir: process.env.TOOLBAY_DESIGN_DIR || path.join(process.cwd(), ".toolbay", "design"),
    consequence: "The audit would link to one and the evidence would sit in the other.",
  });
}

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_FAILED = 1; // the audit did not pass
const EXIT_UNUSABLE = 2; // the ledger or the arguments could not be used
const EXIT_REFUSED = 3; // a request that must not be honoured

/**
 * gstack's category weight table, design-review/SKILL.md:1570-1583. Kept
 * verbatim, including the 5% for AI slop, so the number this prints is the
 * number gstack's own rule produces. `grade` asserts the column sums to 100
 * before it uses it, because a weight table that does not sum to 100 silently
 * rescales every score.
 */
const CATEGORIES = {
  hierarchy: { label: "Visual Hierarchy", weight: 15 },
  typography: { label: "Typography", weight: 15 },
  spacing: { label: "Spacing & Layout", weight: 15 },
  color: { label: "Color & Contrast", weight: 10 },
  interaction: { label: "Interaction States", weight: 10 },
  responsive: { label: "Responsive", weight: 10 },
  content: { label: "Content Quality", weight: 10 },
  "ai-slop": { label: "AI Slop", weight: 5 },
  motion: { label: "Motion", weight: 5 },
  performance: { label: "Performance Feel", weight: 5 },
};

const IMPACTS = { high: 1.0, medium: 0.5, polish: 0.0 };
const FIX_STATUSES = new Set(["verified", "best-effort", "reverted", "deferred"]);
const LETTERS = ["F", "D", "C", "B", "A"];

// ------------------------------------------------------------------- paths

/** POSIX system directories that mean two different things on Windows. */


// ------------------------------------------------------------------- colour
//
// WCAG 2.1 relative luminance and contrast ratio. Arithmetic, not opinion.

// ----------------------------------------------------------------- evidence
//
// A design finding is a claim about pixels. The artifact behind it has to be
// something a program can open and find pixels in.

const MAGIC = [
  { kind: "png", test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: "jpeg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "gif", test: (b) => b.length >= 6 && b.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/) },
  { kind: "webp", test: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Smallest thing anyone would call a screenshot of a page. */
const MIN_DIM = 64;

function pngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * True when every pixel in the image is the same colour. A headless browser
 * that failed to render still writes a structurally perfect PNG of a blank
 * page, and that PNG passes every "does the file exist and is it non-empty"
 * check ever written. Returns null when the PNG variant is not one we decode,
 * so an unsupported file is reported as unchecked rather than silently blessed.
 */
function pngIsBlank(buf, ihdr) {
  const { bitDepth, colorType, interlace } = ihdr;
  // 8- and 16-bit samples of any colour type, palette included: the filter
  // algorithm below is defined on bytes, and "every pixel is the same" holds
  // just as well for palette indices as for colour samples. Sub-byte depths
  // (1/2/4) and interlaced files are still undecoded here, and the caller now
  // treats that as unverified rather than as a pass.
  if (interlace !== 0 || !(colorType in CHANNELS)) return null;
  if (bitDepth !== 8 && bitDepth !== 16) return null;
  if (colorType === 3 && bitDepth !== 8) return null;
  const chunks = pngChunks(buf);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (!idat.length) return null;
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch {
    return null;
  }
  const bpp = CHANNELS[colorType] * (bitDepth === 16 ? 2 : 1);
  const stride = ihdr.width * bpp;
  if (raw.length < (stride + 1) * ihdr.height) return null;

  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let first = null;
  for (let y = 0; y < ihdr.height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    raw.copy(cur, 0, base + 1, base + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      cur[i] = v & 255;
    }
    for (let x = 0; x < stride; x += bpp) {
      const px = cur.subarray(x, x + bpp).toString("hex");
      if (first === null) first = px;
      else if (px !== first) return false;
    }
    cur.copy(prev);
  }
  return true;
}

function inspectImage(rawPath, dir) {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(dir, rawPath);
  const info = { path: abs, ok: false, kind: null, width: null, height: null, blank: null, sha256: null, reasons: [] };

  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    st = null;
  }
  if (!st) {
    info.reasons.push(`${abs} does not exist`);
    return info;
  }
  if (!st.isFile()) {
    info.reasons.push(`${abs} is not a file`);
    return info;
  }
  if (st.size === 0) {
    info.reasons.push(`${abs} is 0 bytes (a screenshot command that failed writes an empty file)`);
    return info;
  }

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    info.reasons.push(`${abs} could not be read (${e.code || e.message})`);
    return info;
  }
  info.sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  const head = buf.subarray(0, 64).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml") || head.startsWith("{")) {
    info.reasons.push(`${abs} is not an image, it is text (${head.slice(0, 24).replace(/\s+/g, " ")}...). A capture tool wrote an error page under an image name.`);
    return info;
  }

  const hit = MAGIC.find((m) => m.test(buf));
  if (!hit) {
    info.reasons.push(`${abs} has no recognised image header (first bytes ${buf.subarray(0, 8).toString("hex")})`);
    return info;
  }
  info.kind = hit.kind;

  if (hit.kind === "png") {
    if (buf.length < 33 || buf.subarray(12, 16).toString("latin1") !== "IHDR") {
      info.reasons.push(`${abs} is a PNG with no IHDR header, so it is truncated`);
      return info;
    }
    const ihdr = {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bitDepth: buf[24],
      colorType: buf[25],
      interlace: buf[28],
    };
    info.width = ihdr.width;
    info.height = ihdr.height;
    if (ihdr.width < MIN_DIM || ihdr.height < MIN_DIM) {
      info.reasons.push(`${abs} is ${ihdr.width}x${ihdr.height}, too small to be a screenshot of a page`);
      return info;
    }
    const blank = pngIsBlank(buf, ihdr);
    info.blank = blank;
    if (blank === true) {
      info.reasons.push(`${abs} is ${ihdr.width}x${ihdr.height} of a single flat colour: the page never rendered, so this image shows nothing`);
      return info;
    }
    if (blank === null) {
      // The comment on pngIsBlank has always said an undecodable variant is
      // "reported as unchecked rather than silently blessed". It was not: this
      // fell through to info.ok = true with no reason attached, the grade
      // counted the finding, and the only trace was one human-readable line
      // that never reached the JSON or the exit code. An image whose blankness
      // cannot be established is not evidence.
      info.reasons.push(
        `${abs} is a PNG variant this checker cannot decode (bit depth ${ihdr.bitDepth}, colour type ${ihdr.colorType}` +
          `${ihdr.interlace ? ", interlaced" : ""}), so it cannot be shown to be anything other than a blank page. ` +
          "Re-take it as a normal 8-bit screenshot.",
      );
      return info;
    }
  }

  info.ok = true;
  return info;
}

// ------------------------------------------------------------------ grading

function letterFor(points) {
  const clamped = Math.max(0, Math.min(4, points));
  return LETTERS[Math.min(4, Math.floor(clamped + 1e-9))];
}

function assertWeights() {
  const sum = Object.values(CATEGORIES).reduce((a, c) => a + c.weight, 0);
  return sum === 100 ? null : `category weights sum to ${sum}, not 100, so every score would be silently rescaled`;
}

function gradeLedger(ledger, dir) {
  const findings = ledger.findings.map((f) => {
    const ev = f.evidence ? inspectImage(f.evidence, dir) : { ok: false, reasons: ["no evidence recorded: a design finding with no screenshot is an assertion"] };
    const fix = f.fix ?? null;
    let outstanding = true;
    const fixReasons = [];
    if (fix && fix.status === "verified") {
      const before = fix.before ? inspectImage(fix.before, dir) : { ok: false, reasons: ["verified fix has no before screenshot"] };
      const after = fix.after ? inspectImage(fix.after, dir) : { ok: false, reasons: ["verified fix has no after screenshot"] };
      if (!before.ok) fixReasons.push(...before.reasons);
      if (!after.ok) fixReasons.push(...after.reasons);
      if (before.ok && after.ok && before.sha256 === after.sha256) {
        fixReasons.push("the after screenshot is byte-identical to the before screenshot, so the committed fix changed nothing on screen");
      }
      if (!fix.commit) fixReasons.push("verified fix has no commit sha");
      outstanding = fixReasons.length > 0;
    }
    return { ...f, evidenceOk: ev.ok, evidenceReasons: ev.reasons, fixReasons, outstanding, counted: ev.ok };
  });

  const unevidenced = findings.filter((f) => !f.evidenceOk);
  const brokenFixes = findings.filter((f) => f.fix?.status === "verified" && f.fixReasons.length);

  const penalty = (list) =>
    list.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] ?? 0) + (IMPACTS[f.impact] ?? 0);
      return acc;
    }, {});

  const counted = findings.filter((f) => f.counted);
  const foundPenalties = penalty(counted);
  const finalPenalties = penalty(counted.filter((f) => f.outstanding));

  const scoreFor = (pen) => {
    const perCategory = {};
    let weighted = 0;
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      const pts = Math.max(0, 4 - (pen[key] ?? 0));
      perCategory[key] = { label: meta.label, weight: meta.weight, points: Math.round(pts * 100) / 100, grade: letterFor(pts) };
      weighted += pts * meta.weight;
    }
    const overall = weighted / 100;
    return { perCategory, points: Math.round(overall * 100) / 100, grade: letterFor(overall), aiSlop: perCategory["ai-slop"].grade };
  };

  return {
    target: ledger.target,
    dir,
    findings,
    unevidenced,
    brokenFixes,
    baseline: scoreFor(foundPenalties),
    final: scoreFor(finalPenalties),
    total: findings.length,
    fixed: findings.filter((f) => f.fix && !f.outstanding).length,
  };
}

// ----------------------------------------------------------------- commands

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function fail(json, code, message) {
  if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
  else err(`  ${code === EXIT_REFUSED ? "REFUSED" : "UNUSABLE"}  ${message}`);
  process.exitCode = code;
}

function cmdInit(args) {
  const json = args.includes("--json");
  const target = flag(args, "--target");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  if (!target) return fail(json, EXIT_UNUSABLE, "--target is required: a design audit has to say what it looked at");

  const ledger = {
    _comment: "Toolbay Stack design ledger. Written by tb-design.mjs. The grade is computed from these findings, not asserted.",
    target,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} node ${process.version}`,
    dir: res.dir,
    findings: [],
  };
  fs.mkdirSync(path.join(res.dir, "screenshots"), { recursive: true });
  const file = writeLedger(res.dir, ledger);
  if (json) out(JSON.stringify({ ok: true, dir: res.dir, ledger: file, screenshots: path.join(res.dir, "screenshots") }, null, 2));
  else {
    out(`  target      ${target}`);
    out(`  dir         ${res.dir}`);
    out(`  screenshots ${path.join(res.dir, "screenshots")}`);
    out(`  ledger      ${file}`);
    out();
    out("  Every path above is absolute, so a shell, a browser and this script all");
    out("  mean the same directory by them.");
  }
}

function cmdContrast(args) {
  const json = args.includes("--json");
  const fg = parseColor(flag(args, "--fg"));
  const bg = parseColor(flag(args, "--bg"));
  const bad = [];
  if (!fg) bad.push(`--fg is required and must be #rgb, #rrggbb or rgb(r,g,b) (got ${JSON.stringify(flag(args, "--fg") ?? null)})`);
  if (!bg) bad.push(`--bg is required and must be #rgb, #rrggbb or rgb(r,g,b) (got ${JSON.stringify(flag(args, "--bg") ?? null)})`);
  if (bad.length) return fail(json, EXIT_UNUSABLE, bad.join("; "));

  const sizeRaw = flag(args, "--size");
  const size = sizeRaw === undefined ? 16 : Number(sizeRaw);
  if (!Number.isFinite(size) || size <= 0) return fail(json, EXIT_UNUSABLE, `--size must be a positive number of px (got ${JSON.stringify(sizeRaw)})`);
  const bold = args.includes("--bold");

  const v = contrastVerdict(contrastRatio(fg, bg), size, bold);
  if (json) out(JSON.stringify({ ok: true, fg: fg.src, bg: bg.src, size, bold, ...v }, null, 2));
  else {
    out();
    out(`  ${fg.src} on ${bg.src} at ${size}px${bold ? " bold" : ""}`);
    out(`  ratio        ${v.ratio}:1`);
    out(`  text class   ${v.large ? "large" : "normal"} (AA needs ${v.thresholdAA}:1, AAA needs ${v.thresholdAAA}:1)`);
    out(`  ${v.passesAA ? "PASS" : "FAIL"}  WCAG AA`);
    out(`  ${v.passesAAA ? "PASS" : "FAIL"}  WCAG AAA`);
    out();
  }
  if (!v.passesAA) process.exitCode = EXIT_FAILED;
}

function cmdFinding(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const id = flag(args, "--id");
  const title = flag(args, "--title");
  const category = (flag(args, "--category") || "").toLowerCase();
  const impact = (flag(args, "--impact") || "").toLowerCase();
  const evidence = flag(args, "--evidence");
  const url = flag(args, "--url");
  const force = args.includes("--force");

  const bad = [];
  if (!id) bad.push("--id is required");
  if (!title) bad.push("--title is required (what a reader would see)");
  if (!(category in CATEGORIES)) bad.push(`--category must be one of: ${Object.keys(CATEGORIES).join(", ")}`);
  if (!(impact in IMPACTS)) bad.push(`--impact must be one of: ${Object.keys(IMPACTS).join(", ")}`);
  if (!evidence) bad.push("--evidence is required: a design finding with no screenshot is an assertion");
  if (bad.length) return fail(json, EXIT_UNUSABLE, bad.join("; "));

  // A contrast claim that the arithmetic contradicts must not enter the ledger.
  let contrast = null;
  const cfg = flag(args, "--contrast-fg");
  const cbg = flag(args, "--contrast-bg");
  if (cfg || cbg) {
    const fg = parseColor(cfg);
    const bg = parseColor(cbg);
    if (!fg || !bg) return fail(json, EXIT_UNUSABLE, "--contrast-fg and --contrast-bg must both be valid colours");
    const size = flag(args, "--size") === undefined ? 16 : Number(flag(args, "--size"));
    const v = contrastVerdict(contrastRatio(fg, bg), size, args.includes("--bold"));
    contrast = { fg: fg.src, bg: bg.src, size, bold: args.includes("--bold"), ...v };
    if (v.passesAA && impact !== "polish") {
      return fail(
        json,
        EXIT_REFUSED,
        `${id} claims a ${impact}-impact contrast problem, but ${fg.src} on ${bg.src} at ${size}px measures ${v.ratio}:1 and WCAG AA needs ${v.thresholdAA}:1. The arithmetic says this passes. Re-check the sampled colours or record it as polish.`,
      );
    }
  }

  const existing = state.ledger.findings.findIndex((f) => f.id === id);
  if (existing !== -1 && !force) {
    return fail(json, EXIT_REFUSED, `${id} is already recorded ("${state.ledger.findings[existing].title}"). Pass --force to overwrite.`);
  }

  const ev = inspectImage(evidence, res.dir);
  const finding = {
    id,
    title,
    category,
    impact,
    url: url ?? null,
    evidence,
    note: flag(args, "--note") ?? null,
    contrast,
    fix: existing !== -1 ? (state.ledger.findings[existing].fix ?? null) : null,
    at: new Date().toISOString(),
  };
  if (existing !== -1) state.ledger.findings[existing] = finding;
  else state.ledger.findings.push(finding);
  writeLedger(res.dir, state.ledger);

  if (json) out(JSON.stringify({ ok: true, finding, evidence: ev }, null, 2));
  else {
    out(`  recorded  ${id}  ${impact.padEnd(6)} ${category.padEnd(11)} ${title}`);
    if (contrast) out(`            contrast ${contrast.ratio}:1 vs AA ${contrast.thresholdAA}:1 -> ${contrast.passesAA ? "passes" : "fails"}`);
    if (!ev.ok) for (const r of ev.reasons) out(`            ! ${r}`);
    else out(`            evidence ${ev.kind}${ev.width ? ` ${ev.width}x${ev.height}` : ""}, ${ev.blank === null ? "blankness unchecked" : "not blank"}`);
  }
}

function cmdFix(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);
  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const id = flag(args, "--id");
  const status = (flag(args, "--status") || "").toLowerCase();
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const commit = flag(args, "--commit");

  const bad = [];
  if (!id) bad.push("--id is required");
  if (!FIX_STATUSES.has(status)) bad.push(`--status must be one of: ${[...FIX_STATUSES].join(", ")}`);
  if (bad.length) return fail(json, EXIT_UNUSABLE, bad.join("; "));

  const idx = state.ledger.findings.findIndex((f) => f.id === id);
  if (idx === -1) return fail(json, EXIT_UNUSABLE, `no finding ${id} in ${ledgerPath(res.dir)}. Record the finding before recording its fix.`);

  if (status === "verified") {
    const problems = [];
    if (!commit) problems.push("--commit is required for a verified fix: one atomic commit per fix, and the sha is what makes it checkable");
    else if (!/^[0-9a-f]{7,40}$/i.test(commit)) problems.push(`--commit ${commit} is not a git sha`);
    if (!before) problems.push("--before is required for a verified fix");
    if (!after) problems.push("--after is required for a verified fix");
    if (problems.length) return fail(json, EXIT_REFUSED, problems.join("; "));

    const b = inspectImage(before, res.dir);
    const a = inspectImage(after, res.dir);
    const reasons = [...b.reasons, ...a.reasons];
    if (b.ok && a.ok && b.sha256 === a.sha256) {
      reasons.push(`the after screenshot is byte-identical to the before screenshot (sha256 ${a.sha256.slice(0, 12)}), so the fix in ${commit} changed nothing on screen`);
    }
    if (reasons.length) return fail(json, EXIT_REFUSED, `${id} cannot be recorded as verified: ${reasons.join("; ")}`);
  }

  state.ledger.findings[idx].fix = {
    status,
    commit: commit ?? null,
    before: before ?? null,
    after: after ?? null,
    at: new Date().toISOString(),
  };
  writeLedger(res.dir, state.ledger);
  if (json) out(JSON.stringify({ ok: true, id, fix: state.ledger.findings[idx].fix }, null, 2));
  else out(`  ${id}  fix ${status}${commit ? ` (${commit})` : ""}`);
}

function cmdGrade(args) {
  const json = args.includes("--json");
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) return fail(json, EXIT_REFUSED, res.error);

  const weightError = assertWeights();
  if (weightError) return fail(json, EXIT_UNUSABLE, weightError);

  const state = readLedger(res.dir);
  if (state.error) return fail(json, EXIT_UNUSABLE, state.error);

  const g = gradeLedger(state.ledger, res.dir);

  let regression = null;
  const baselineFile = flag(args, "--baseline");
  if (baselineFile) {
    const abs = path.isAbsolute(baselineFile) ? baselineFile : path.resolve(res.dir, baselineFile);
    try {
      const prev = JSON.parse(fs.readFileSync(abs, "utf8"));
      const prevPoints = Number(prev.finalPoints ?? prev.points);
      if (!Number.isFinite(prevPoints)) {
        return fail(json, EXIT_UNUSABLE, `${abs} has no numeric finalPoints, so no regression comparison can be made from it`);
      }
      regression = {
        file: abs,
        previousPoints: prevPoints,
        previousGrade: prev.finalGrade ?? letterFor(prevPoints),
        currentPoints: g.final.points,
        currentGrade: g.final.grade,
        regressed: g.final.points < prevPoints - 1e-9,
        delta: Math.round((g.final.points - prevPoints) * 100) / 100,
      };
    } catch (e) {
      return fail(json, EXIT_UNUSABLE, `baseline ${abs} could not be read (${e.code || e.message}). A missing baseline is not a passing comparison.`);
    }
  }

  const problems = [];
  if (g.total === 0) problems.push("no findings were recorded. An empty design audit is not an A.");
  for (const f of g.unevidenced) problems.push(`${f.id} has no usable evidence: ${f.evidenceReasons.join("; ")}`);
  for (const f of g.brokenFixes) problems.push(`${f.id} is marked verified but ${f.fixReasons.join("; ")}`);
  if (regression?.regressed) problems.push(`the design score fell from ${regression.previousPoints} (${regression.previousGrade}) to ${regression.currentPoints} (${regression.currentGrade}) against ${regression.file}`);

  const verdict = problems.length ? "FAIL" : "PASS";

  const payload = {
    target: g.target,
    dir: g.dir,
    verdict,
    problems,
    findings: g.total,
    fixedVerified: g.fixed,
    baselineGrade: g.baseline.grade,
    baselinePoints: g.baseline.points,
    baselineAiSlop: g.baseline.aiSlop,
    finalGrade: g.final.grade,
    finalPoints: g.final.points,
    finalAiSlop: g.final.aiSlop,
    categories: g.final.perCategory,
    regression,
    at: new Date().toISOString(),
  };

  const writeBaseline = flag(args, "--write-baseline");
  if (writeBaseline) {
    const abs = path.isAbsolute(writeBaseline) ? writeBaseline : path.resolve(res.dir, writeBaseline);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    payload.baselineWrittenTo = abs;
  }

  if (json) out(JSON.stringify(payload, null, 2));
  else {
    out();
    out(`  target        ${g.target}`);
    out(`  findings      ${g.total} (${g.fixed} verified fixed)`);
    out();
    for (const [key, c] of Object.entries(g.final.perCategory)) {
      const before = g.baseline.perCategory[key].grade;
      const arrow = before === c.grade ? "  " : "->";
      out(`    ${c.label.padEnd(18)} ${String(c.weight + "%").padStart(4)}   ${before} ${arrow} ${c.grade}`);
    }
    out();
    out(`  Design Score  ${g.baseline.grade} -> ${g.final.grade}  (${g.baseline.points} -> ${g.final.points} of 4.00)`);
    out(`  AI Slop       ${g.baseline.aiSlop} -> ${g.final.aiSlop}`);
    if (regression) out(`  vs baseline   ${regression.previousGrade} (${regression.previousPoints}) delta ${regression.delta >= 0 ? "+" : ""}${regression.delta}`);
    out();
    if (problems.length) {
      out(`  FAIL  ${problems.length} problem(s) with this audit:`);
      for (const p of problems) out(`        ! ${p}`);
      out();
      out("  Every grade above is arithmetic on the findings in the ledger. A finding");
      out("  whose screenshot cannot be opened is not in the arithmetic, so the grade");
      out("  it produced would have been wrong.");
    } else {
      out(`  PASS  every finding is backed by an image a program could open`);
    }
    out();
  }
  if (verdict !== "PASS") process.exitCode = EXIT_FAILED;
}

/**
 * Cross-platform file opener. gstack falls back to `open file://...` for the
 * comparison board; on Windows that is exit 127 and no board.
 */
function platformOpener() {
  if (isWindows) return { cmd: "cmd", args: ["/c", "start", ""], display: 'cmd /c start "" <file>' };
  if (process.platform === "darwin") return { cmd: "open", args: [], display: "open <file>" };
  return { cmd: "xdg-open", args: [], display: "xdg-open <file>" };
}

function cmdShow(args) {
  const json = args.includes("--json");
  const file = flag(args, "--file");
  const opener = platformOpener();
  if (args.includes("--print-only")) {
    if (json) out(JSON.stringify({ ok: true, platform: process.platform, opener: opener.display }, null, 2));
    else out(`  ${process.platform}: ${opener.display}`);
    return;
  }
  if (!file) return fail(json, EXIT_UNUSABLE, "--file is required");
  const abs = path.resolve(fromMsysPath(file));
  if (!fs.existsSync(abs)) return fail(json, EXIT_UNUSABLE, `${abs} does not exist, so there is nothing to open`);
  const r = spawnSync(opener.cmd, [...opener.args, abs], { stdio: "ignore" });
  if (r.error) return fail(json, EXIT_UNUSABLE, `could not run "${opener.display}" (${r.error.code || r.error.message})`);
  if (json) out(JSON.stringify({ ok: true, opened: abs, via: opener.display }, null, 2));
  else out(`  opened ${abs} via ${opener.display}`);
}

// ------------------------------------------------------------------ selftest
//
// Real PNGs, encoded here, so the blank-page check is exercised against an
// actual image rather than a stub.

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A PNG with an arbitrary IHDR, for the variants a real headless browser can
 * produce and the old checker quietly waved through. `rows` is the already
 * unfiltered pixel data for one scanline, in bytes.
 */
function makePngVariant(width, height, { bitDepth = 8, colorType = 0, interlace = 0 }, scanline) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const row = Buffer.from(scanline);
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function runSelf(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-design-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const write = (n, buf) => {
    const p = path.join(tmp, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  };
  const realShot = (n, seed = 1) =>
    write(n, makePng(320, 200, (x, y) => [(x * seed) % 256, (y * 3 + seed) % 256, (x + y + seed) % 256]));
  const blankShot = (n) => write(n, makePng(320, 200, () => [255, 255, 255]));

  // ---- the weight table has to be the one gstack published
  check("category weights sum to 100", null, assertWeights());

  // ---- init
  {
    const r = runSelf(["init", "--json", "--target", "http://localhost:3000", ...D("run1")]);
    check("init creates a ledger", 0, r.status, r.stderr.trim());
    const j = JSON.parse(r.stdout || "{}");
    check("init reports an absolute directory", true, Boolean(j.dir) && path.isAbsolute(j.dir), j.dir);
  }
  check("init requires a target", 2, runSelf(["init", "--json", ...D("run-notarget")]).status);
  if (isWindows) {
    const r = runSelf(["init", "--target", "http://x", "--dir", "/tmp/design"]);
    check("init refuses /tmp on Windows, where it means two directories", 3, r.status);
    const said = `${r.stdout}${r.stderr}`;
    check("...and names both of them", true, /AppData[\\/]Local[\\/]Temp/.test(said) && /C:[\\/]tmp[\\/]design/.test(said), said.trim().slice(0, 160));
  }

  // ---- grade fails closed before anything is recorded
  check("grade on an empty audit FAILS", 1, runSelf(["grade", "--json", ...D("run1")]).status);
  check("grade with no ledger is unusable, not an A", 2, runSelf(["grade", "--json", ...D("never-inited")]).status);
  {
    const dir = path.join(tmp, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.json"), "{ not json", "utf8");
    check("grade on a corrupt ledger is unusable, not an A", 2, runSelf(["grade", "--json", "--dir", dir]).status);
  }

  // ---- WCAG contrast is arithmetic, checked against known reference pairs
  check("black on white is 21:1", 21, JSON.parse(runSelf(["contrast", "--json", "--fg", "#000000", "--bg", "#ffffff"]).stdout).ratio);
  check("white on white is 1:1", 1, JSON.parse(runSelf(["contrast", "--json", "--fg", "#fff", "--bg", "#fff"]).stdout).ratio);
  {
    const r = runSelf(["contrast", "--json", "--fg", "#767676", "--bg", "#ffffff", "--size", "16"]);
    check("#767676 on white passes AA at 16px", 0, r.status);
    check("...and measures 4.54:1", 4.54, JSON.parse(r.stdout).ratio);
  }
  {
    const r = runSelf(["contrast", "--json", "--fg", "#777777", "--bg", "#ffffff", "--size", "16"]);
    check("#777777 on white FAILS AA at 16px", 1, r.status);
    check("...and measures 4.48:1", 4.48, JSON.parse(r.stdout).ratio);
  }
  check("the same grey passes at 24px, where AA is 3:1", 0, runSelf(["contrast", "--json", "--fg", "#777777", "--bg", "#fff", "--size", "24"]).status);
  check("19px bold counts as large text", true, JSON.parse(runSelf(["contrast", "--json", "--fg", "#777", "--bg", "#fff", "--size", "19", "--bold"]).stdout).large);
  check("contrast rejects a colour it cannot parse", 2, runSelf(["contrast", "--json", "--fg", "darkish grey", "--bg", "#fff"]).status);

  // ---- a finding has to be backed by an image a program can open
  runSelf(["init", "--target", "http://localhost:3000", ...D("run2")]);
  const F = (n, extra = []) => ["finding", "--json", ...D("run2"), "--id", n, "--title", `finding ${n}`, ...extra];
  {
    const r = runSelf(F("OK-1", ["--category", "typography", "--impact", "high", "--evidence", realShot("run2/screenshots/ok-1.png")]));
    check("a finding with a real screenshot records", 0, r.status, r.stderr.trim());
    check("grade passes on a real screenshot", 0, runSelf(["grade", "--json", ...D("run2")]).status);
    const g = JSON.parse(runSelf(["grade", "--json", ...D("run2")]).stdout);
    check("one high typography finding drops typography A -> B", "B", g.categories.typography.grade);
    check("...and the weighted Design Score is 3.85 of 4", 3.85, g.finalPoints);
  }
  {
    // gstack's exact failure: the browser was down, the PNG is 0 bytes, the
    // finding still carries a screenshot path and still moves the grade.
    runSelf(["init", "--target", "http://x", ...D("zero")]);
    runSelf(["finding", ...D("zero"), "--id", "Z", "--title", "t", "--category", "spacing", "--impact", "high", "--evidence", write("zero/s.png", Buffer.alloc(0))]);
    const r = runSelf(["grade", "--json", ...D("zero")]);
    check("a 0-byte screenshot FAILS the audit", 1, r.status);
    check("...and is named as the reason", true, /0 bytes/.test(JSON.parse(r.stdout).problems.join(" ")));
  }
  {
    runSelf(["init", "--target", "http://x", ...D("html")]);
    runSelf(["finding", ...D("html"), "--id", "H", "--title", "t", "--category", "color", "--impact", "high", "--evidence", write("html/s.png", Buffer.from("<!doctype html><title>502 Bad Gateway</title>"))]);
    check("an HTML error page named .png FAILS the audit", 1, runSelf(["grade", "--json", ...D("html")]).status);
  }
  {
    runSelf(["init", "--target", "http://x", ...D("blank")]);
    runSelf(["finding", ...D("blank"), "--id", "B", "--title", "hero has no focal point", "--category", "hierarchy", "--impact", "high", "--evidence", blankShot("blank/s.png")]);
    const r = runSelf(["grade", "--json", ...D("blank")]);
    check("a valid PNG of a blank page FAILS the audit", 1, r.status);
    check("...and says the page never rendered", true, /never rendered/.test(JSON.parse(r.stdout).problems.join(" ")));
  }
  {
    // 16-bit greyscale, every sample 0xFFFF. The old decoder bailed on any bit
    // depth but 8, returned null, and inspectImage then set ok = true with no
    // reason: a blank page passed as evidence. It is decoded now.
    runSelf(["init", "--target", "http://x", ...D("blank16")]);
    const png = makePngVariant(320, 200, { bitDepth: 16, colorType: 0 }, Buffer.alloc(320 * 2, 0xff));
    runSelf(["finding", ...D("blank16"), "--id", "B16", "--title", "t", "--category", "hierarchy", "--impact", "high", "--evidence", write("blank16/s.png", png)]);
    const r = runSelf(["grade", "--json", ...D("blank16")]);
    check("a 16-bit blank PNG FAILS the audit", 1, r.status);
    check("...and says the page never rendered", true, /never rendered/.test(JSON.parse(r.stdout).problems.join(" ")), r.stdout.slice(0, 300));
  }
  {
    // 16-bit greyscale that actually varies is still perfectly good evidence.
    runSelf(["init", "--target", "http://x", ...D("real16")]);
    const line = Buffer.alloc(320 * 2);
    for (let i = 0; i < 320; i++) line.writeUInt16BE((i * 197) % 65536, i * 2);
    runSelf(["finding", ...D("real16"), "--id", "R16", "--title", "t", "--category", "hierarchy", "--impact", "high", "--evidence", write("real16/s.png", makePngVariant(320, 200, { bitDepth: 16, colorType: 0 }, line))]);
    const r = runSelf(["grade", "--json", ...D("real16")]);
    check("a 16-bit PNG that is not flat still passes", 0, r.status, r.stdout.slice(0, 300));
  }
  {
    // 4-bit greyscale is a variant this checker genuinely cannot decode. That
    // is now an UNVERIFIED evidence file, not a silent pass.
    runSelf(["init", "--target", "http://x", ...D("undec")]);
    runSelf(["finding", ...D("undec"), "--id", "U", "--title", "t", "--category", "hierarchy", "--impact", "high", "--evidence", write("undec/s.png", makePngVariant(320, 200, { bitDepth: 4, colorType: 0 }, Buffer.alloc(160, 0xff)))]);
    const r = runSelf(["grade", "--json", ...D("undec")]);
    check("a PNG variant the checker cannot decode FAILS the audit", 1, r.status);
    check("...and says so instead of blessing it", true, /cannot decode/.test(JSON.parse(r.stdout).problems.join(" ")), r.stdout.slice(0, 300));
  }
  {
    runSelf(["init", "--target", "http://x", ...D("tiny")]);
    runSelf(["finding", ...D("tiny"), "--id", "T", "--title", "t", "--category", "motion", "--impact", "medium", "--evidence", write("tiny/s.png", makePng(16, 16, () => [1, 2, 3]))]);
    check("a 16x16 image is not a screenshot of a page", 1, runSelf(["grade", "--json", ...D("tiny")]).status);
  }
  check("a finding with no evidence at all is refused", 2, runSelf(F("NOEV", ["--category", "spacing", "--impact", "high"])).status);
  check("a finding in an invented category is refused", 2, runSelf(F("BADCAT", ["--category", "vibes", "--impact", "high", "--evidence", realShot("run2/screenshots/x.png")])).status);
  check("a finding with an invented impact is refused", 2, runSelf(F("BADIMP", ["--category", "spacing", "--impact", "catastrophic", "--evidence", realShot("run2/screenshots/y.png")])).status);
  check("re-recording an existing finding id is refused", 3, runSelf(F("OK-1", ["--category", "spacing", "--impact", "polish", "--evidence", realShot("run2/screenshots/z.png")])).status);

  // ---- a contrast claim the arithmetic contradicts cannot enter the ledger
  {
    const r = runSelf(F("CONTRAST-FAKE", ["--category", "color", "--impact", "high", "--evidence", realShot("run2/screenshots/c.png"), "--contrast-fg", "#767676", "--contrast-bg", "#ffffff", "--size", "16"]));
    check("a contrast finding that actually passes AA is refused", 3, r.status);
    check("...and the refusal states the measured ratio", true, /4\.54/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`.trim().slice(0, 160));
    const ok = runSelf(F("CONTRAST-REAL", ["--category", "color", "--impact", "high", "--evidence", realShot("run2/screenshots/c2.png"), "--contrast-fg", "#777777", "--contrast-bg", "#ffffff", "--size", "16"]));
    check("a contrast finding the arithmetic supports records", 0, ok.status, ok.stderr.trim());
  }

  // ---- a verified fix has to show a change
  {
    runSelf(["init", "--target", "http://x", ...D("fix")]);
    const beforeShot = realShot("fix/before.png", 5);
    runSelf(["finding", ...D("fix"), "--id", "F-1", "--title", "cta is invisible", "--category", "hierarchy", "--impact", "high", "--evidence", beforeShot]);
    check("a fix for a finding that does not exist is refused", 2, runSelf(["fix", "--json", ...D("fix"), "--id", "NOPE", "--status", "verified", "--commit", "abc1234", "--before", beforeShot, "--after", beforeShot]).status);
    check("a verified fix with no commit sha is refused", 3, runSelf(["fix", "--json", ...D("fix"), "--id", "F-1", "--status", "verified", "--before", beforeShot, "--after", realShot("fix/after.png", 9)]).status);
    check("a verified fix with a non-sha commit is refused", 3, runSelf(["fix", "--json", ...D("fix"), "--id", "F-1", "--status", "verified", "--commit", "the last one", "--before", beforeShot, "--after", realShot("fix/after.png", 9)]).status);
    {
      // The screenshot was retaken and came back identical: the committed CSS
      // change did nothing. gstack still classifies this `verified`.
      const same = write("fix/after-same.png", fs.readFileSync(beforeShot));
      const r = runSelf(["fix", "--json", ...D("fix"), "--id", "F-1", "--status", "verified", "--commit", "9f3ab21", "--before", beforeShot, "--after", same]);
      check("a verified fix whose after == before is refused", 3, r.status);
      check("...and says the fix changed nothing on screen", true, /changed nothing on screen/.test(`${r.stdout}${r.stderr}`));
    }
    {
      const r = runSelf(["fix", "--json", ...D("fix"), "--id", "F-1", "--status", "verified", "--commit", "9f3ab21", "--before", beforeShot, "--after", realShot("fix/after.png", 9)]);
      check("a verified fix with a real visible change records", 0, r.status, r.stderr.trim());
      const g = JSON.parse(runSelf(["grade", "--json", ...D("fix")]).stdout);
      check("the fix lifts hierarchy back to A", "A", g.categories.hierarchy.grade);
      check("...but the found-state grade still records the B it was", "B", g.baselineGrade);
      check("...and the final Design Score is a clean 4.00", 4, g.finalPoints);
    }
  }

  // ---- regression against a baseline is computed, not warned about
  {
    runSelf(["init", "--target", "http://x", ...D("reg")]);
    runSelf(["finding", ...D("reg"), "--id", "R1", "--title", "t", "--category", "typography", "--impact", "medium", "--evidence", realShot("reg/a.png", 2)]);
    const base = path.join(tmp, "reg", "design-baseline.json");
    check("writing a baseline succeeds", 0, runSelf(["grade", "--json", ...D("reg"), "--write-baseline", base]).status);
    runSelf(["finding", ...D("reg"), "--id", "R2", "--title", "t2", "--category", "spacing", "--impact", "high", "--evidence", realShot("reg/b.png", 3)]);
    const r = runSelf(["grade", "--json", ...D("reg"), "--baseline", base]);
    check("a worse score than the baseline FAILS", 1, r.status);
    const j = JSON.parse(r.stdout);
    check("...and the regression is a number, not a warning", true, j.regression.regressed === true && j.regression.delta < 0, JSON.stringify(j.regression));
    check("a missing baseline file is unusable, not a pass", 2, runSelf(["grade", "--json", ...D("reg"), "--baseline", path.join(tmp, "reg", "gone.json")]).status);
  }

  // ---- the Windows opener
  {
    const r = runSelf(["show", "--json", "--print-only"]);
    check("show knows the platform opener", 0, r.status);
    const expected = isWindows ? 'cmd /c start "" <file>' : process.platform === "darwin" ? "open <file>" : "xdg-open <file>";
    check("...and on this platform it is not bare `open`", expected, JSON.parse(r.stdout).opener);
    check("show refuses a file that does not exist", 2, runSelf(["show", "--json", "--file", path.join(tmp, "no-such-board.html")]).status);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-design", results);
}

// -------------------------------------------------------------------- output

function report(label, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  ${label} selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return false;
  }
  process.stdout.write("\n  The cases above are the ways a design audit produces a letter grade with\n");
  process.stdout.write("  nothing behind it: no findings at all, a 0-byte screenshot, an error page\n");
  process.stdout.write("  saved as a .png, a real screenshot of a page that never rendered, a\n");
  process.stdout.write("  contrast ratio asserted against the arithmetic, and an \"after\" screenshot\n");
  process.stdout.write("  identical to the \"before\". All of them fail here.\n\n");
  return true;
}

function help() {
  out(`
  tb-design ${VERSION}  (Toolbay Stack)

  init --target <url> [--dir <d>]        start an audit, print absolute paths
  contrast --fg <c> --bg <c> [--size <px>] [--bold]
                                         WCAG 2.1 ratio, exit 1 if it fails AA
  finding --id <id> --title "<what>" --category <k> --impact high|medium|polish
          --evidence <image> [--url <u>] [--note "<x>"] [--force]
          [--contrast-fg <c> --contrast-bg <c> [--size <px>] [--bold]]
  fix --id <id> --status verified|best-effort|reverted|deferred
          [--before <img>] [--after <img>] [--commit <sha>]
  grade [--baseline <file>] [--write-baseline <file>]
                                         compute the grades from the findings
  show --file <path> | --print-only      open a file with this platform's opener
  selftest                               prove it against audits that should fail

  Options: --json

  Categories: ${Object.keys(CATEGORIES).join(", ")}

  Every grade is arithmetic on the ledger. A finding counts only when its
  evidence is an image that opens, is bigger than ${MIN_DIM}x${MIN_DIM}, and is not a flat
  blank page. A fix counts as verified only with a commit sha and a before/after
  pair that actually differ.

  Exit: 0 pass, 1 fail, 2 ledger/arguments unusable, 3 refused.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "init") cmdInit(argv.slice(1));
else if (cmd === "contrast") cmdContrast(argv.slice(1));
else if (cmd === "finding") cmdFinding(argv.slice(1));
else if (cmd === "fix") cmdFix(argv.slice(1));
else if (cmd === "grade") cmdGrade(argv.slice(1));
else if (cmd === "show") cmdShow(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
