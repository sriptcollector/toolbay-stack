#!/usr/bin/env node
/**
 * tb-iosfix.mjs: the evidence engine behind /ios-fix. It holds a ledger for one
 * bug, and it is the thing that decides whether that bug is fixed.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow implemented here (the `/ios-fix` command, the Iron
 * Law "no fix without a reproducing snapshot", the five phases, the pre/post
 * screenshot comparison, the three-iteration escalation cap, the
 * `<bug-slug>-pre.json` / `<bug-slug>-pre.png` / `<bug-slug>-post.png` fixture
 * layout, the regression test in `test/fixtures/ios-fix/`, and the failure-mode
 * table) comes from `ios-fix` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack   MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS EXISTS AT ALL
 *
 * gstack's /ios-fix ships two files and neither of them runs:
 *
 *   $ ls ~/.claude/skills/gstack/ios-fix/
 *   SKILL.md  SKILL.md.tmpl
 *
 * Everything the skill promises is prose addressed to the model. That is fine
 * for the parts that are judgement (read the Swift, find the root cause) and
 * fatal for the parts that are facts, because the two failure modes of this
 * particular loop are both invisible from inside the conversation:
 *
 *   1. THE IRON LAW IS ENFORCED BY NOTHING. "NO FIX WITHOUT A REPRODUCING
 *      SNAPSHOT" is a sentence in a markdown file. An agent that skips Phase 1
 *      entirely, edits the Swift, and reports the bug fixed produces a
 *      transcript identical to one that did the work. There is no artifact
 *      anywhere that separates them.
 *
 *   2. PHASE 4 IS AN EYEBALL. "Take a fresh screenshot. Compare against
 *      <bug-slug>-pre.png. If the bug visibly persists, the fix didn't work."
 *      No number is computed and no file is required to exist, so every way
 *      that comparison can be meaningless reads as a pass:
 *
 *        - the device was asleep and the screenshot is a black rectangle
 *        - the bridge answered 401/503 and curl saved the JSON error body to
 *          post.png, which is not an image at all
 *        - nothing was written and the model is comparing pre.png to itself
 *        - the screenshot was taken before the rebuild finished, so it is a
 *          picture of the old binary
 *
 *      Each of those looks like "I took a screenshot and the bug is gone".
 *
 * So this engine does the checkable half and refuses to be optimistic about it.
 * The design rules are the ones the rest of Toolbay Stack uses:
 *
 *   1. FAIL CLOSED. Every path that cannot reach a confident answer ends in
 *      UNVERIFIED, never in a pass. "The comparison could not be made" and "the
 *      comparison passed" are different states here and they exit with
 *      different codes.
 *   2. NO INTERPRETER BUT NODE. No shell, no python, no coreutils, no
 *      ImageMagick. The PNGs are decoded in-process, so the same command
 *      produces the same numbers from Git Bash, PowerShell and cmd.
 *   3. PROVE IT. `selftest` builds real PNG files, including the broken ones
 *      above, drives this CLI against them as child processes, and fails if any
 *      of them reach a pass.
 *
 * ON WINDOWS, which is where this fork is used: the device half of /ios-fix
 * cannot run and never will. There is no xcodebuild, no devicectl, no Swift
 * toolchain and no CoreDevice tunnel. `preflight` says so in one command, names
 * every missing piece, and exits non-zero, instead of gstack's behaviour, which
 * is to hand the model an `xcodebuild` command line and let it discover the
 * truth as a shell error somewhere in Phase 3. The evidence half of the loop
 * (validate the snapshot, compare the screenshots, gate the verdict) is pure
 * file work and runs everywhere, which is what makes the fix reviewable from a
 * machine that is not the Mac that produced it.
 *
 * Exit codes, so this can gate a script:
 *   0  the thing asked about is true
 *   1  a real negative verdict (NOT_FIXED, ESCALATE)
 *   2  usage, or the ledger cannot be read
 *   3  UNVERIFIED, or the device loop is unavailable here
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS } from "./tb-outdir.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger, one file per bug; shared reader/writer in
// src/ledger/tb-ledger.mjs.
const ledgerPath = (dir, bug) => ledgerPathShared(dir, `${bug}.json`);
function readLedger(dir, bug) {
  const r = readLedgerShared(dir, {
    file: `${bug}.json`,
    what: "fix ledger",
    hint: `Run: tb-iosfix open --bug ${bug} --summary "..." --expected "..."`,
    validate: (obj, file) => (obj.bug === bug ? null : `${file} is a ledger for "${obj.bug}", not "${bug}"`),
  });
  if (r.error) return r;
  if (!Array.isArray(r.ledger.verifications)) r.ledger.verifications = [];
  return r;
}
function writeLedger(dir, ledger) {
  return writeLedgerShared(dir, ledger, { file: `${ledger.bug}.json`, atomic: false });
}


const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";

const EXIT_OK = 0;
const EXIT_NEGATIVE = 1;
const EXIT_USAGE = 2;
const EXIT_UNVERIFIED = 3;

const out = (s = "") => process.stdout.write(`${s}\n`);

/** Fraction of compared pixels that must differ before a screen counts as changed. */
const DEFAULT_MIN_CHANGE = 0.001;
/** Above this share of one colour, a screenshot is a blank screen, not a UI. */
const BLANK_THRESHOLD = 0.995;
/** Per-channel delta that counts a pixel as different. Below this is compression noise. */
const CHANNEL_DELTA = 16;
/** gstack's cap: three verify attempts, then stop and tell the human. */
const MAX_ATTEMPTS = 3;

// --------------------------------------------------------------------- paths

function resolvePath(raw, base = process.cwd()) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  const msys = fromMsysPath(s);
  return path.resolve(looksAbsolute(msys) ? msys : path.join(base, msys));
}

function resolveLedgerDir(raw) {
  if (!raw) {
    return {
      ok: true,
      dir: path.resolve(process.env.TOOLBAY_IOSFIX_DIR || path.join(process.cwd(), ".toolbay", "ios-fix")),
    };
  }
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (isWindows && AMBIGUOUS_ON_WINDOWS.test(s)) {
    return {
      ok: false,
      error:
        `"${s}" means two different directories on this machine. Git Bash resolves it under ` +
        `${os.tmpdir()} (so a shell writes to ${path.join(os.tmpdir(), s.replace(/^\/tmp\/?/, ""))}), and Node, ` +
        `Python and PowerShell resolve it to ${path.resolve(s)}. The ledger would be written to one and read ` +
        `from the other, and a fix ledger that reads back empty is indistinguishable from a bug nobody worked ` +
        `on. Pass a real path, or omit --dir to use ${path.join(process.cwd(), ".toolbay", "ios-fix")}.`,
    };
  }
  return { ok: true, dir: resolvePath(s) };
}

function slugify(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// ------------------------------------------------------------------- ledger


function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------- PNG decode
//
// Enough of the PNG spec to answer "are these two screenshots the same picture"
// and "is this picture blank". Anything outside that subset is reported as
// undecodable, which is UNVERIFIED, never a pass. A screenshot this engine
// cannot read is not a screenshot that agrees with you.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What a file that is not a PNG actually is, for an error message worth reading. */
function sniff(buf) {
  if (buf.length === 0) return "an empty file";
  const head = buf.subarray(0, 16);
  if (head.subarray(0, 8).equals(PNG_MAGIC)) return "a PNG";
  if (head[0] === 0xff && head[1] === 0xd8) return "a JPEG";
  if (head.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "a GIF";
  const text = buf.subarray(0, 512).toString("utf8");
  if (/^\s*[[{]/.test(text)) return `a JSON document (starts: ${JSON.stringify(text.trim().slice(0, 60))})`;
  if (/^\s*<(!doctype|html|\?xml)/i.test(text)) return `an HTML or XML document (starts: ${JSON.stringify(text.trim().slice(0, 60))})`;
  if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(text.slice(0, 64))) return `plain text (starts: ${JSON.stringify(text.trim().slice(0, 60))})`;
  return `${buf.length} bytes of unrecognised binary`;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const BYTES_PER_PIXEL = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * @returns {{ok:true,width,height,pixels:Uint8Array}|{ok:false,reason:string}}
 * `pixels` is RGBA, 4 bytes per pixel, whatever the source colour type was.
 */
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, reason: `the file is not a PNG, it is ${sniff(buf)}` };
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return { ok: false, reason: `the PNG is truncated inside its ${type} chunk` };
    const data = buf.subarray(dataStart, dataEnd);
    const declared = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(pos + 4, dataEnd)) !== declared) {
      return { ok: false, reason: `the PNG ${type} chunk fails its own CRC, so the file is corrupt` };
    }
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos = dataEnd + 4;
  }
  if (!ihdr) return { ok: false, reason: "the PNG has no IHDR chunk, so its dimensions are unknown" };
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (!width || !height) return { ok: false, reason: `the PNG declares ${width}x${height}, which is not an image` };
  if (interlace !== 0) return { ok: false, reason: "the PNG is interlaced, which this comparison does not decode" };
  if (bitDepth !== 8) return { ok: false, reason: `the PNG is ${bitDepth}-bit, and only 8-bit is decoded here` };
  const bpp = BYTES_PER_PIXEL[colorType];
  if (!bpp) return { ok: false, reason: `the PNG uses colour type ${colorType}, which this comparison does not decode` };
  if (!idat.length) return { ok: false, reason: "the PNG carries no image data (no IDAT chunk)" };

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (e) {
    return { ok: false, reason: `the PNG image data could not be decompressed (${e.message})` };
  }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    return { ok: false, reason: `the PNG says ${width}x${height} but carries only ${raw.length} bytes of scanline data` };
  }

  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = v + a;
          break;
        case 2:
          v = v + b;
          break;
        case 3:
          v = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return { ok: false, reason: `the PNG uses scanline filter ${filter}, which is not in the spec` };
      }
      cur[x] = v & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * bpp;
    const d = i * 4;
    if (colorType === 0) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = lines[s];
      pixels[d + 3] = 255;
    } else if (colorType === 4) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = lines[s];
      pixels[d + 3] = lines[s + 1];
    } else if (colorType === 2) {
      pixels[d] = lines[s];
      pixels[d + 1] = lines[s + 1];
      pixels[d + 2] = lines[s + 2];
      pixels[d + 3] = 255;
    } else {
      pixels[d] = lines[s];
      pixels[d + 1] = lines[s + 1];
      pixels[d + 2] = lines[s + 2];
      pixels[d + 3] = lines[s + 3];
    }
  }
  return { ok: true, width, height, pixels };
}

/** Every Nth pixel, capped, so a 3-megapixel screenshot does not cost a second. */
function sampleStride(total, max = 200000) {
  return Math.max(1, Math.ceil(total / max));
}

/**
 * Share of the picture taken by its single most common colour. A device that was
 * asleep, a view that never rendered, and a screenshot taken of a launch screen
 * all come back at ~1.0, and all three look like a successful capture to
 * anything that only checks the file exists.
 */
function uniformity(img) {
  const total = img.width * img.height;
  const stride = sampleStride(total);
  const buckets = new Map();
  let sampled = 0;
  for (let i = 0; i < total; i += stride) {
    const d = i * 4;
    // 5 bits per channel: a gradient or dither still reads as one colour, which
    // is the honest answer for "is anything on this screen".
    const key = ((img.pixels[d] >> 3) << 10) | ((img.pixels[d + 1] >> 3) << 5) | (img.pixels[d + 2] >> 3);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    sampled += 1;
  }
  let max = 0;
  for (const v of buckets.values()) if (v > max) max = v;
  return { ratio: sampled ? max / sampled : 1, sampled, colours: buckets.size };
}

/** Share of compared pixels that differ by more than compression noise. */
function diffRatio(a, b) {
  const total = a.width * a.height;
  const stride = sampleStride(total);
  let differing = 0;
  let sampled = 0;
  for (let i = 0; i < total; i += stride) {
    const d = i * 4;
    const dr = Math.abs(a.pixels[d] - b.pixels[d]);
    const dg = Math.abs(a.pixels[d + 1] - b.pixels[d + 1]);
    const db = Math.abs(a.pixels[d + 2] - b.pixels[d + 2]);
    if (Math.max(dr, dg, db) > CHANNEL_DELTA) differing += 1;
    sampled += 1;
  }
  return { ratio: sampled ? differing / sampled : 0, sampled, differing };
}

/**
 * Read a screenshot and say everything checkable about it in one object.
 * `ok:false` is always UNVERIFIED at the caller, never a pass.
 */
function inspectScreenshot(file, label) {
  const abs = resolvePath(file);
  if (!abs) return { ok: false, reason: `no ${label} path was given` };
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, path: abs, reason: `the ${label} ${abs} does not exist (${e.code || e.message}), so nothing was captured` };
  }
  if (!st.isFile()) return { ok: false, path: abs, reason: `the ${label} ${abs} is not a file` };
  if (st.size === 0) {
    return { ok: false, path: abs, reason: `the ${label} ${abs} is 0 bytes. A screenshot nobody can open is not evidence` };
  }
  const buf = fs.readFileSync(abs);
  const img = decodePng(buf);
  if (!img.ok) return { ok: false, path: abs, bytes: st.size, reason: `the ${label} ${abs} could not be read as an image: ${img.reason}` };
  const uni = uniformity(img);
  return {
    ok: true,
    path: abs,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    sha256: sha256(buf),
    width: img.width,
    height: img.height,
    uniformity: Number(uni.ratio.toFixed(4)),
    colours: uni.colours,
    img,
  };
}

/**
 * A snapshot has to describe state. gstack writes whatever the bridge returned
 * to `<slug>-pre.json` and moves on, so a 401 body, a 503 body, an HTML error
 * page and `{}` all become the regression fixture. None of them reproduce
 * anything, and the failure only surfaces months later when the test is run.
 */
function inspectSnapshot(file) {
  const abs = resolvePath(file);
  if (!abs) return { ok: false, reason: "no snapshot path was given" };
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, path: abs, reason: `the snapshot ${abs} does not exist (${e.code || e.message})` };
  }
  if (st.size === 0) return { ok: false, path: abs, reason: `the snapshot ${abs} is 0 bytes` };
  const buf = fs.readFileSync(abs);
  const text = buf.toString("utf8");
  if (/^\s*</.test(text)) {
    return { ok: false, path: abs, reason: `the snapshot ${abs} is an HTML document, not state. The bridge answered with an error page` };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, path: abs, reason: `the snapshot ${abs} is not valid JSON (${e.message})` };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, path: abs, reason: `the snapshot ${abs} is a ${Array.isArray(obj) ? "JSON array" : typeof obj}, not a state object` };
  }
  // The bridge's error envelopes. A 401/403/409/503 body is valid JSON and would
  // otherwise pass every check above.
  const errKey = ["error", "err", "message", "reason"].find((k) => typeof obj[k] === "string" && !("state" in obj));
  if (errKey && Object.keys(obj).length <= 3) {
    return {
      ok: false,
      path: abs,
      reason: `the snapshot ${abs} is an error response from the bridge, not device state (${errKey}: ${JSON.stringify(obj[errKey]).slice(0, 80)})`,
    };
  }
  const body = obj.state && typeof obj.state === "object" && !Array.isArray(obj.state) ? obj.state : obj;
  const fields = Object.keys(body);
  if (!fields.length) {
    return {
      ok: false,
      path: abs,
      reason: `the snapshot ${abs} is an empty object. An empty snapshot restores nothing, so it cannot reproduce the bug`,
    };
  }
  return { ok: true, path: abs, bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha256(buf), fields: fields.length, fieldNames: fields.slice(0, 12) };
}

// ---------------------------------------------------------------- preflight
//
// gstack hands the model `xcodebuild -scheme ... build install` in Phase 3 and
// finds out whether that exists by running it. This asks first, once, and names
// every missing piece rather than surfacing the first one as a shell error.

function probeTool(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (res.error) {
    if (res.error.code === "ENOENT") return { present: false, why: `${cmd} is not on PATH` };
    // Anything else (EACCES, timeout, spawn failure) is a check that did not
    // complete. That is not evidence the tool is there.
    return { present: false, why: `${cmd} could not be run (${res.error.code || res.error.message}), so its presence is unknown` };
  }
  if (res.status !== 0) return { present: false, why: `${cmd} exited ${res.status}` };
  const first = `${res.stdout || res.stderr || ""}`.trim().split("\n")[0] ?? "";
  return { present: true, why: first.slice(0, 100) };
}

function preflight(argv) {
  const json = argv.includes("--json");
  const checks = [];

  if (isWindows) {
    // Stated flatly rather than probed, because probing on Windows produces four
    // identical "not on PATH" lines that read like a fixable configuration
    // problem. It is not fixable: the toolchain is macOS-only.
    checks.push({ id: "platform", ok: false, detail: "win32. Xcode, xcodebuild, devicectl and the CoreDevice USB tunnel are macOS-only, so the device half of this loop cannot run here at all" });
  } else {
    checks.push({ id: "platform", ok: true, detail: process.platform });
    for (const [id, cmd, args] of [
      ["xcodebuild", "xcodebuild", ["-version"]],
      ["swift", "swift", ["--version"]],
      ["devicectl", "xcrun", ["devicectl", "--version"]],
    ]) {
      const p = probeTool(cmd, args);
      checks.push({ id, ok: p.present, detail: p.why });
    }
  }

  const deviceLoop = checks.every((c) => c.ok);
  const result = {
    platform: process.platform,
    deviceLoop,
    evidenceEngine: true,
    checks,
    note: deviceLoop
      ? "The full find -> fix -> verify loop can run here."
      : "The device half cannot run here. The evidence half (validate the snapshot, compare the screenshots, gate the verdict) is pure file work and still runs, so a fix produced on a Mac can be checked from this machine.",
  };

  if (json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out();
    out(`  tb-iosfix preflight  (node ${process.version}, ${process.platform})`);
    out();
    for (const c of checks) out(`  ${c.ok ? "ok     " : "MISSING"}  ${c.id.padEnd(11)} ${c.detail}`);
    out();
    out(`  device loop:     ${deviceLoop ? "AVAILABLE" : "UNAVAILABLE"}`);
    out(`  evidence engine: AVAILABLE`);
    out();
    out(`  ${result.note}`);
    out();
  }
  process.exitCode = deviceLoop ? EXIT_OK : EXIT_UNVERIFIED;
}

// ------------------------------------------------------------------ commands

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
function flagAll(argv, name) {
  const vals = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name && argv[i + 1]) vals.push(argv[i + 1]);
  return vals;
}

function fail(msg, code = EXIT_USAGE) {
  out();
  out(`  BLOCKED  ${msg}`);
  out();
  process.exitCode = code;
  return null;
}

function ctx(argv) {
  const d = resolveLedgerDir(flag(argv, "--dir"));
  if (!d.ok) return { error: d.error };
  const bug = slugify(flag(argv, "--bug"));
  if (!bug) return { error: 'a bug slug is required: --bug "<short-slug>"' };
  return { dir: d.dir, bug };
}

function cmdOpen(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const summary = flag(argv, "--summary");
  const expected = flag(argv, "--expected");
  // gstack Phase 1 step 5 says "persist a one-line description of what's wrong +
  // expected behavior" and then persists it nowhere. Without both halves the
  // later verdict has no definition of fixed to check against, so both are
  // required here rather than encouraged.
  if (!summary || !summary.trim()) return fail('--summary "<what is wrong>" is required. A fix with no recorded symptom cannot be verified by anyone but the person who wrote it');
  if (!expected || !expected.trim()) return fail('--expected "<what should happen instead>" is required. Without it there is no definition of fixed');

  const existing = fs.existsSync(ledgerPath(c.dir, c.bug));
  const ledger = existing
    ? readLedger(c.dir, c.bug).ledger
    : { version: VERSION, bug: c.bug, openedAt: new Date().toISOString(), repro: null, fix: null, verifications: [], regression: null };
  if (!ledger) return fail(`the existing ledger for "${c.bug}" could not be read`);
  ledger.summary = summary.trim();
  ledger.expected = expected.trim();
  const file = writeLedger(c.dir, ledger);
  out();
  out(`  ${existing ? "updated" : "opened"}  ${file}`);
  out(`  bug:      ${c.bug}`);
  out(`  symptom:  ${ledger.summary}`);
  out(`  expected: ${ledger.expected}`);
  out();
  out(`  Next: capture the reproducing snapshot BEFORE editing any Swift.`);
  out(`    tb-iosfix repro --bug ${c.bug} --snapshot <pre.json> --screenshot <pre.png>`);
  out();
  return null;
}

function cmdRepro(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const r = readLedger(c.dir, c.bug);
  if (r.error) return fail(r.error);

  const snap = inspectSnapshot(flag(argv, "--snapshot"));
  const shot = inspectScreenshot(flag(argv, "--screenshot"), "pre screenshot");
  const problems = [];
  if (!snap.ok) problems.push(snap.reason);
  if (!shot.ok) problems.push(shot.reason);
  if (shot.ok && shot.uniformity >= BLANK_THRESHOLD) {
    problems.push(
      `the pre screenshot ${shot.path} is ${(shot.uniformity * 100).toFixed(1)}% one colour, which is a blank screen, not the bug. The device was probably asleep or the view never rendered`,
    );
  }
  if (problems.length) {
    out();
    out(`  NOT RECORDED  the reproducing evidence did not check out, so the Iron Law is not satisfied:`);
    for (const p of problems) out(`    - ${p}`);
    out();
    out(`  Nothing was written to the ledger. Capture the bug state again before editing any Swift.`);
    out();
    process.exitCode = EXIT_UNVERIFIED;
    return null;
  }

  r.ledger.repro = {
    recordedAt: new Date().toISOString(),
    snapshot: { path: snap.path, bytes: snap.bytes, sha256: snap.sha256, fields: snap.fields, fieldNames: snap.fieldNames },
    screenshot: {
      path: shot.path,
      bytes: shot.bytes,
      sha256: shot.sha256,
      width: shot.width,
      height: shot.height,
      uniformity: shot.uniformity,
      mtimeMs: shot.mtimeMs,
    },
  };
  writeLedger(c.dir, r.ledger);
  out();
  out(`  recorded  reproducing evidence for ${c.bug}`);
  out(`    snapshot    ${snap.path}  (${snap.fields} state fields, sha256 ${snap.sha256.slice(0, 12)})`);
  out(`    screenshot  ${shot.path}  (${shot.width}x${shot.height}, ${shot.colours} colours, sha256 ${shot.sha256.slice(0, 12)})`);
  out();
  out(`  The Iron Law is satisfied. You may now edit Swift.`);
  out();
  return null;
}

function cmdFix(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const r = readLedger(c.dir, c.bug);
  if (r.error) return fail(r.error);

  // THE IRON LAW, enforced rather than stated.
  if (!r.ledger.repro) {
    return fail(
      `no reproducing snapshot has been recorded for "${c.bug}", so no fix can be recorded against it. ` +
        `This is the Iron Law: a fix that lands without a snapshot that reproduces the bug is a fix you will be ` +
        `re-fixing in three months, and nothing afterwards can tell the two apart. Run: tb-iosfix repro --bug ${c.bug} ` +
        `--snapshot <pre.json> --screenshot <pre.png>`,
      EXIT_UNVERIFIED,
    );
  }

  const files = flagAll(argv, "--file").map((f) => resolvePath(f));
  if (!files.length) return fail("--file <path> is required (repeatable): the source files the fix touched");
  const rows = [];
  const missing = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      rows.push({ path: f, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch (e) {
      missing.push(`${f} (${e.code || e.message})`);
    }
  }
  if (missing.length) return fail(`these edited files do not exist: ${missing.join(", ")}`);

  const cause = flag(argv, "--cause");
  if (!cause || !cause.trim()) {
    return fail('--cause "<the root cause in one line>" is required. /investigate\'s Iron Law applies here too: no fix without a root cause');
  }

  r.ledger.fix = { recordedAt: new Date().toISOString(), cause: cause.trim(), files: rows };
  writeLedger(c.dir, r.ledger);
  out();
  out(`  recorded  fix for ${c.bug}`);
  out(`    cause   ${cause.trim()}`);
  for (const f of rows) out(`    edited  ${f.path}  (${f.bytes} bytes, mtime ${new Date(f.mtimeMs).toISOString()})`);
  out();
  out(`  Rebuild and redeploy, THEN capture the post screenshot. A screenshot older than the`);
  out(`  newest edit above is refused, because it is a picture of the previous binary.`);
  out();
  return null;
}

function cmdVerify(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const json = argv.includes("--json");
  const r = readLedger(c.dir, c.bug);
  if (r.error) return fail(r.error);
  const L = r.ledger;
  const minChange = Number(flag(argv, "--min-change") ?? DEFAULT_MIN_CHANGE);
  if (!Number.isFinite(minChange) || minChange < 0 || minChange > 1) return fail("--min-change must be a fraction between 0 and 1");

  if (!L.repro) return fail(`no reproducing evidence recorded for "${c.bug}", so there is nothing to compare against`, EXIT_UNVERIFIED);
  if (!L.fix) return fail(`no fix recorded for "${c.bug}". Record what changed and why before claiming it worked`, EXIT_UNVERIFIED);

  const post = inspectScreenshot(flag(argv, "--screenshot"), "post screenshot");
  const pre = inspectScreenshot(L.repro.screenshot.path, "pre screenshot");

  const record = (status, reason, extra = {}) => {
    L.verifications.push({ at: new Date().toISOString(), screenshot: post.path ?? flag(argv, "--screenshot") ?? null, status, reason, ...extra });
    writeLedger(c.dir, L);
    const attempts = L.verifications.length;
    const payload = { bug: c.bug, status, reason, attempts, maxAttempts: MAX_ATTEMPTS, ...extra };
    if (json) out(JSON.stringify(payload, null, 2));
    else {
      out();
      out(`  ${status}  ${c.bug}   (attempt ${attempts} of ${MAX_ATTEMPTS})`);
      out(`  ${reason}`);
      for (const [k, v] of Object.entries(extra)) out(`    ${k}: ${v}`);
      if (status !== "VERIFIED" && attempts >= MAX_ATTEMPTS) {
        out();
        out(`  ESCALATE. ${attempts} attempts have not produced a verified fix. Stop and hand the`);
        out(`  human the current best hypothesis rather than trying a fourth variant.`);
      }
      out();
    }
    process.exitCode = status === "VERIFIED" ? EXIT_OK : status === "NOT_FIXED" ? EXIT_NEGATIVE : EXIT_UNVERIFIED;
  };

  if (!post.ok) return record("UNVERIFIED", post.reason);
  if (!pre.ok) return record("UNVERIFIED", `the recorded pre screenshot can no longer be read: ${pre.reason}`);

  // The one the eyeball never catches: nothing was written, and the "new"
  // screenshot is the old one.
  if (post.sha256 === pre.sha256) {
    return record("UNVERIFIED", "the post screenshot is byte-for-byte identical to the pre screenshot, so no new capture was taken. Comparing a file to itself proves nothing", {
      sha256: post.sha256.slice(0, 16),
    });
  }
  if (post.uniformity >= BLANK_THRESHOLD) {
    return record("UNVERIFIED", `the post screenshot is ${(post.uniformity * 100).toFixed(1)}% one colour, which is a blank screen. A locked or sleeping device produces exactly this, and it differs from the pre screenshot, so a byte comparison would have passed it`, {
      colours: post.colours,
    });
  }
  if (post.width !== pre.width || post.height !== pre.height) {
    return record("UNVERIFIED", `the screenshots are different sizes (pre ${pre.width}x${pre.height}, post ${post.width}x${post.height}), so they are not pictures of the same screen and cannot be compared`);
  }
  const newestEdit = Math.max(...L.fix.files.map((f) => f.mtimeMs));
  if (post.mtimeMs < newestEdit) {
    return record("UNVERIFIED", `the post screenshot was written ${new Date(post.mtimeMs).toISOString()}, before the newest recorded source edit at ${new Date(newestEdit).toISOString()}. It is a picture of the binary from before the fix`);
  }

  const d = diffRatio(pre.img, post.img);
  const ratio = Number(d.ratio.toFixed(5));
  if (d.ratio < minChange) {
    return record("NOT_FIXED", `the screen did not change: ${(d.ratio * 100).toFixed(3)}% of compared pixels differ, below the ${(minChange * 100).toFixed(3)}% floor. The rebuild either did not deploy or did not affect this screen`, {
      diffRatio: ratio,
      comparedPixels: d.sampled,
    });
  }
  return record("VERIFIED", `the screen changed: ${(d.ratio * 100).toFixed(2)}% of ${d.sampled} compared pixels differ from the reproducing capture`, {
    diffRatio: ratio,
    comparedPixels: d.sampled,
    postSha256: post.sha256.slice(0, 16),
  });
}

function cmdRegression(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const r = readLedger(c.dir, c.bug);
  if (r.error) return fail(r.error);
  if (!r.ledger.repro) return fail(`no reproducing snapshot recorded for "${c.bug}", so a regression test has no fixture to load`, EXIT_UNVERIFIED);

  const t = resolvePath(flag(argv, "--test"));
  if (!t) return fail("--test <path> is required: the regression test that loads the snapshot fixture");
  let st;
  try {
    st = fs.statSync(t);
  } catch (e) {
    return fail(`the regression test ${t} does not exist (${e.code || e.message})`, EXIT_UNVERIFIED);
  }
  if (!st.size) return fail(`the regression test ${t} is 0 bytes`, EXIT_UNVERIFIED);
  const src = fs.readFileSync(t, "utf8");
  const fixture = path.basename(r.ledger.repro.snapshot.path);
  // A test file that never names the fixture cannot be loading it, and a
  // regression test that does not restore the reproducing state is a test that
  // would have passed before the fix too.
  if (!src.includes(fixture)) {
    return fail(
      `the regression test ${t} never mentions ${fixture}, so it does not load the snapshot that reproduces this bug. ` +
        `A test that does not restore the pre-fix state would have passed before the fix as well, which makes it worth nothing`,
      EXIT_UNVERIFIED,
    );
  }
  r.ledger.regression = { path: t, bytes: st.size, fixture, recordedAt: new Date().toISOString() };
  writeLedger(c.dir, r.ledger);
  out();
  out(`  recorded  regression test ${t}  (loads ${fixture})`);
  out();
  return null;
}

function cmdVerdict(argv) {
  const c = ctx(argv);
  if (c.error) return fail(c.error);
  const json = argv.includes("--json");
  const r = readLedger(c.dir, c.bug);
  if (r.error) return fail(r.error);
  const L = r.ledger;

  const gates = [];
  const gate = (name, ok, detail) => gates.push({ name, ok, detail });

  gate("a symptom and an expected behaviour are recorded", Boolean(L.summary && L.expected), L.summary ? `${L.summary} -> ${L.expected}` : "nothing recorded");
  gate("a reproducing snapshot exists (the Iron Law)", Boolean(L.repro), L.repro ? `${L.repro.snapshot.path} (${L.repro.snapshot.fields} fields)` : "none captured");
  gate("a root cause and the edited files are recorded", Boolean(L.fix), L.fix ? `${L.fix.cause} (${L.fix.files.length} file(s))` : "none recorded");

  const verified = L.verifications.filter((v) => v.status === "VERIFIED");
  const last = L.verifications[L.verifications.length - 1] ?? null;
  gate(
    "the post-fix screen was measured against the reproducing capture",
    verified.length > 0,
    last ? `${L.verifications.length} attempt(s), last ${last.status}: ${last.reason}` : "never verified",
  );
  gate("a regression test loads the snapshot fixture", Boolean(L.regression), L.regression ? `${L.regression.path} loads ${L.regression.fixture}` : "none recorded");

  const failed = gates.filter((g) => !g.ok);
  let verdict;
  let code;
  if (!failed.length) {
    verdict = "FIXED";
    code = EXIT_OK;
  } else if (last && last.status === "NOT_FIXED" && L.verifications.length >= MAX_ATTEMPTS) {
    verdict = "ESCALATE";
    code = EXIT_NEGATIVE;
  } else if (last && last.status === "NOT_FIXED") {
    verdict = "NOT_FIXED";
    code = EXIT_NEGATIVE;
  } else {
    verdict = "UNVERIFIED";
    code = EXIT_UNVERIFIED;
  }

  if (json) {
    out(JSON.stringify({ bug: c.bug, verdict, gates, attempts: L.verifications.length, ledger: r.file }, null, 2));
  } else {
    out();
    out(`  tb-iosfix verdict  ${c.bug}`);
    out();
    for (const g of gates) out(`  ${g.ok ? "ok  " : "MISS"}  ${g.name}`);
    for (const g of gates) if (!g.ok) out(`        - ${g.name}: ${g.detail}`);
    out();
    out(`  VERDICT: ${verdict}`);
    if (verdict !== "FIXED") {
      out();
      out(`  ${verdict === "UNVERIFIED" ? "Not a claim that the bug is still there. A claim that nothing here establishes it is gone." : "The measurement says the screen did not change."}`);
    }
    out(`  ledger: ${r.file}`);
    out();
  }
  process.exitCode = code;
  return null;
}

// ----------------------------------------------------------------- selftest

/** A real PNG, so the selftest exercises the same decoder the CLI uses. */
function encodePng(width, height, pixelFn) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelFn(x, y);
      const d = rowStart + 1 + x * 4;
      raw[d] = r;
      raw[d + 1] = g;
      raw[d + 2] = b;
      raw[d + 3] = a ?? 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-iosfix-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const W = (name, buf) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  };

  // --- fixtures: a "UI" screen, the same screen with a visible change, and
  // every way a capture can be worthless.
  const ui = (shift) => (x, y) => {
    if (y < 12) return [20, 20, 30, 255]; // status bar
    if (y > 40 && y < 56 && x > 8 + shift && x < 56 + shift) return [230, 60, 60, 255]; // the buggy row
    return [250, 250, 252, 255];
  };
  const prePng = W("pre.png", encodePng(64, 96, ui(0)));
  const postChanged = W("post-changed.png", encodePng(64, 96, ui(4)));
  // A genuine RE-capture of an unchanged screen: different bytes, different
  // sha256, same picture to within capture noise. This is the case a checksum
  // comparison waves through and an eyeball calls "looks the same to me".
  const postSame = W("post-same.png", encodePng(64, 96, (x, y) => {
    const [r, g, b, a] = ui(0)(x, y);
    return [Math.min(255, r + 5), g, Math.max(0, b - 5), a];
  }));
  const postBlank = W("post-blank.png", encodePng(64, 96, () => [0, 0, 0, 255]));
  const postSmaller = W("post-small.png", encodePng(32, 48, ui(4)));
  const postNotPng = W("post-json.png", Buffer.from('{"error":"unauthorized","code":401}\n', "utf8"));
  const postEmpty = W("post-empty.png", Buffer.alloc(0));
  const postTruncated = W("post-trunc.png", encodePng(64, 96, ui(4)).subarray(0, 40));

  const goodSnap = W("pre.json", Buffer.from(JSON.stringify({ cart: { items: 3, total: 42 }, screen: "checkout" }), "utf8"));
  const emptySnap = W("empty.json", Buffer.from("{}", "utf8"));
  const errSnap = W("err.json", Buffer.from(JSON.stringify({ error: "session_expired" }), "utf8"));
  const htmlSnap = W("html.json", Buffer.from("<!doctype html><html><body>503</body></html>", "utf8"));
  const badSnap = W("bad.json", Buffer.from("{ not json", "utf8"));
  const swift = W("src/CartView.swift", Buffer.from("struct CartView {}\n", "utf8"));

  const D = (n) => ["--dir", path.join(tmp, "ledgers", n)];
  const open = (n, bug) => runSelf(["open", "--bug", bug, "--summary", "row is red", "--expected", "row is green", ...D(n)]);

  // ---------------------------------------------------------------- preflight
  {
    const r = runSelf(["preflight", "--json"]);
    let j = {};
    try {
      j = JSON.parse(r.stdout);
    } catch {
      j = {};
    }
    check("preflight answers in JSON", true, typeof j.deviceLoop === "boolean", r.all.slice(0, 160));
    check("preflight always reports the evidence engine as usable", true, j.evidenceEngine === true);
    if (isWindows) {
      check("preflight exits non-zero on Windows, where the device loop cannot run", EXIT_UNVERIFIED, r.status);
      check("preflight says the device loop is unavailable here", false, j.deviceLoop);
      check("...and names the reason rather than a missing PATH entry", true, /macOS-only/.test(JSON.stringify(j)), JSON.stringify(j.checks));
    } else {
      check("preflight exit code matches its own verdict", j.deviceLoop ? EXIT_OK : EXIT_UNVERIFIED, r.status);
    }
  }

  // -------------------------------------------------------------------- open
  check("open requires a bug slug", EXIT_USAGE, runSelf(["open", "--summary", "a", "--expected", "b", ...D("x")]).status);
  check("open requires a recorded symptom", EXIT_USAGE, runSelf(["open", "--bug", "b1", "--expected", "b", ...D("x")]).status);
  check("open requires a definition of fixed", EXIT_USAGE, runSelf(["open", "--bug", "b1", "--summary", "a", ...D("x")]).status);
  check("open writes a ledger", EXIT_OK, open("happy", "cart-row-red").status);

  // ------------------------------------------------------------- the Iron Law
  {
    const r = runSelf(["fix", "--bug", "cart-row-red", "--file", swift, "--cause", "wrong colour token", ...D("happy")]);
    check("fix without a reproducing snapshot is REFUSED (gstack only asks nicely)", EXIT_UNVERIFIED, r.status);
    check("...and says why, naming the Iron Law", true, /Iron Law/.test(r.all), r.all.trim().slice(0, 120));
  }
  check("verify before anything is recorded cannot pass", EXIT_UNVERIFIED, runSelf(["verify", "--bug", "cart-row-red", "--screenshot", postChanged, ...D("happy")]).status);
  check("verdict on an untouched bug is UNVERIFIED, not FIXED", EXIT_UNVERIFIED, runSelf(["verdict", "--bug", "cart-row-red", ...D("happy")]).status);

  // ------------------------------------------------------------------- repro
  const repro = (dir, snap, shot) => runSelf(["repro", "--bug", "cart-row-red", "--snapshot", snap, "--screenshot", shot, ...D(dir)]);
  check("repro rejects an empty {} snapshot", EXIT_UNVERIFIED, repro("happy", emptySnap, prePng).status);
  check("repro rejects a bridge error body saved as the snapshot", EXIT_UNVERIFIED, repro("happy", errSnap, prePng).status);
  check("repro rejects an HTML error page saved as the snapshot", EXIT_UNVERIFIED, repro("happy", htmlSnap, prePng).status);
  check("repro rejects a snapshot that is not JSON", EXIT_UNVERIFIED, repro("happy", badSnap, prePng).status);
  check("repro rejects a 0-byte screenshot", EXIT_UNVERIFIED, repro("happy", goodSnap, postEmpty).status);
  check("repro rejects a JSON error body named .png", EXIT_UNVERIFIED, repro("happy", goodSnap, postNotPng).status);
  check("repro rejects a blank screen as the reproducing capture", EXIT_UNVERIFIED, repro("happy", goodSnap, postBlank).status);
  {
    const r = repro("happy", goodSnap, prePng);
    check("repro accepts a real snapshot and a real screenshot", EXIT_OK, r.status, r.all.trim().slice(0, 160));
    check("...and says the Iron Law is satisfied", true, /Iron Law is satisfied/.test(r.all));
  }
  check(
    "a rejected repro writes NOTHING to the ledger",
    false,
    /empty\.json|err\.json|html\.json/.test(fs.readFileSync(path.join(tmp, "ledgers", "happy", "cart-row-red.json"), "utf8")),
  );

  // --------------------------------------------------------------------- fix
  check("fix requires the edited files", EXIT_USAGE, runSelf(["fix", "--bug", "cart-row-red", "--cause", "x", ...D("happy")]).status);
  check("fix requires a root cause", EXIT_USAGE, runSelf(["fix", "--bug", "cart-row-red", "--file", swift, ...D("happy")]).status);
  check("fix rejects an edited file that does not exist", EXIT_USAGE, runSelf(["fix", "--bug", "cart-row-red", "--file", path.join(tmp, "nope.swift"), "--cause", "x", ...D("happy")]).status);
  check("fix records a real edit", EXIT_OK, runSelf(["fix", "--bug", "cart-row-red", "--file", swift, "--cause", "colour token read from the wrong state", ...D("happy")]).status);

  // ------------------------------------------------------------------ verify
  //
  // Every fixture above was written before `fix` ran, which makes them all
  // older than the recorded source edit. That is the staleness rule doing its
  // job, and it is checked deliberately further down with its own fixture, so
  // the captures that are meant to reach the comparison are re-stamped as
  // taken AFTER the rebuild, which is the order the real loop runs in.
  const now = Date.now() / 1000 + 1;
  for (const f of [postChanged, postSame, postBlank, postSmaller]) fs.utimesSync(f, now, now);

  const verify = (dir, shot, extra = []) => runSelf(["verify", "--bug", "cart-row-red", "--screenshot", shot, "--json", ...extra, ...D(dir)]);
  const clone = (name) => {
    // Each fail-closed case gets its own ledger, because verify counts attempts
    // and three of them force an escalation.
    const src = path.join(tmp, "ledgers", "happy");
    const dst = path.join(tmp, "ledgers", name);
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, "cart-row-red.json"), path.join(dst, "cart-row-red.json"));
    return name;
  };

  check("verify refuses a post screenshot that does not exist", EXIT_UNVERIFIED, verify(clone("v-missing"), path.join(tmp, "nope.png")).status);
  check("verify refuses a 0-byte post screenshot", EXIT_UNVERIFIED, verify(clone("v-empty"), postEmpty).status);
  {
    const r = verify(clone("v-json"), postNotPng);
    check("verify refuses a JSON error body named .png", EXIT_UNVERIFIED, r.status);
    check("...and says what the file actually is", true, /JSON document/.test(r.all), r.all.trim().slice(0, 160));
  }
  check("verify refuses a truncated PNG", EXIT_UNVERIFIED, verify(clone("v-trunc"), postTruncated).status);
  {
    const r = verify(clone("v-same"), prePng);
    check("verify refuses a post screenshot identical to the pre one", EXIT_UNVERIFIED, r.status);
    check("...calling out that nothing was captured", true, /byte-for-byte identical/.test(r.all), r.all.trim().slice(0, 160));
  }
  {
    const r = verify(clone("v-blank"), postBlank);
    check("verify refuses a blank screen even though it DIFFERS from the pre one", EXIT_UNVERIFIED, r.status);
    check("...naming the sleeping device", true, /blank screen/.test(r.all), r.all.trim().slice(0, 160));
  }
  check("verify refuses screenshots of different sizes", EXIT_UNVERIFIED, verify(clone("v-size"), postSmaller).status);
  {
    // A screenshot written before the source edit is a picture of the old binary.
    const stale = W("post-stale.png", encodePng(64, 96, ui(4)));
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(stale, old, old);
    const r = verify(clone("v-stale"), stale);
    check("verify refuses a screenshot older than the fix", EXIT_UNVERIFIED, r.status);
    check("...saying it pictures the previous binary", true, /before the fix|previous binary|before the newest recorded source edit/.test(r.all), r.all.trim().slice(0, 200));
  }
  {
    const r = verify(clone("v-nochange"), postSame);
    check("verify reports NOT_FIXED when the screen did not change", EXIT_NEGATIVE, r.status);
    check("...as a measured number, not an opinion", true, /"diffRatio"/.test(r.stdout), r.stdout.trim().slice(0, 160));
  }
  {
    const dir = clone("v-good");
    const r = verify(dir, postChanged);
    check("verify passes a real, changed, freshly captured screen", EXIT_OK, r.status, r.all.trim().slice(0, 200));
    const j = JSON.parse(r.stdout || "{}");
    check("...and prints the measured difference", true, typeof j.diffRatio === "number" && j.diffRatio > 0, r.stdout.slice(0, 160));
    check("...having compared real pixels", true, (j.comparedPixels ?? 0) > 1000, String(j.comparedPixels));
  }
  {
    // gstack's three-iteration cap, counted rather than remembered.
    const dir = clone("v-escalate");
    verify(dir, postSame);
    verify(dir, postSame);
    const r = runSelf(["verify", "--bug", "cart-row-red", "--screenshot", postSame, ...D(dir)]);
    check("the third failed attempt escalates", true, /ESCALATE/.test(r.all), r.all.trim().slice(-160));
    check("...and verdict agrees", EXIT_NEGATIVE, runSelf(["verdict", "--bug", "cart-row-red", ...D(dir)]).status);
  }

  // -------------------------------------------------------------- regression
  {
    const dir = "v-good";
    const emptyTest = W("t-empty.test.ts", Buffer.alloc(0));
    const vacuous = W("t-vacuous.test.ts", Buffer.from("test('cart', () => { expect(true).toBe(true); });\n", "utf8"));
    const real = W("t-real.test.ts", Buffer.from(`import snap from "./pre.json";\ntest('cart', async () => { await restore(snap); });\n`, "utf8"));
    check("regression refuses a 0-byte test", EXIT_UNVERIFIED, runSelf(["regression", "--bug", "cart-row-red", "--test", emptyTest, ...D(dir)]).status);
    const r = runSelf(["regression", "--bug", "cart-row-red", "--test", vacuous, ...D(dir)]);
    check("regression refuses a test that never loads the snapshot fixture", EXIT_UNVERIFIED, r.status);
    check("...explaining it would have passed before the fix too", true, /passed before the fix/.test(r.all), r.all.trim().slice(0, 200));
    check("regression accepts a test that loads the fixture", EXIT_OK, runSelf(["regression", "--bug", "cart-row-red", "--test", real, ...D(dir)]).status);
  }

  // ----------------------------------------------------------------- verdict
  {
    const r = runSelf(["verdict", "--bug", "cart-row-red", "--json", ...D("v-good")]);
    check("verdict is FIXED only with every gate satisfied", EXIT_OK, r.status, r.all.trim().slice(0, 200));
    const j = JSON.parse(r.stdout || "{}");
    check("...and it is FIXED", "FIXED", j.verdict);
    check("...over five named gates", 5, (j.gates ?? []).length);
  }
  {
    // Same fix, minus the regression test: gstack's Phase 5 is a paragraph, so
    // this is the state most real fixes actually end in.
    const dir = clone("v-notest");
    verify(dir, postChanged);
    const r = runSelf(["verdict", "--bug", "cart-row-red", "--json", ...D(dir)]);
    check("a verified fix with no regression test is UNVERIFIED, not FIXED", EXIT_UNVERIFIED, r.status);
    check("...and names the missing gate", true, /regression test/.test(r.stdout), r.stdout.slice(0, 200));
  }

  // ------------------------------------------------------- ledger fails closed
  {
    const dir = path.join(tmp, "ledgers", "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cart-row-red.json"), "{ truncated", "utf8");
    check("a corrupt ledger blocks instead of reading as a clean slate", EXIT_USAGE, runSelf(["verdict", "--bug", "cart-row-red", "--dir", dir]).status);
    fs.writeFileSync(path.join(dir, "cart-row-red.json"), "", "utf8");
    check("an empty ledger blocks too", EXIT_USAGE, runSelf(["verdict", "--bug", "cart-row-red", "--dir", dir]).status);
    check("a missing ledger blocks rather than inventing one", EXIT_USAGE, runSelf(["verdict", "--bug", "never-opened", "--dir", dir]).status);
  }
  if (isWindows) {
    const r = runSelf(["open", "--bug", "b", "--summary", "a", "--expected", "b", "--dir", "/tmp/ios-fix"]);
    check("a /tmp ledger dir is refused on Windows, where it means two directories", EXIT_USAGE, r.status);
    check("...naming both directories", true, /AppData[\\/]Local[\\/]Temp/.test(r.all) && /C:[\\/]tmp[\\/]ios-fix/.test(r.all), r.all.trim().slice(0, 200));
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-iosfix selftest  (node ${process.version}, ${process.platform})\n\n`);
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
    return;
  }
  process.stdout.write("\n  Every case above is a way an iOS fix reports itself verified without anything\n");
  process.stdout.write("  having been established: no reproducing snapshot at all, an empty or error-body\n");
  process.stdout.write("  snapshot standing in for device state, a 0-byte screenshot, a 401 JSON body saved\n");
  process.stdout.write("  as post.png, a black screen from a sleeping phone, a screenshot taken before the\n");
  process.stdout.write("  rebuild, the pre screenshot compared to itself, and a regression test that loads\n");
  process.stdout.write("  no fixture. None of them can reach FIXED here.\n\n");
}

// -------------------------------------------------------------------- entry

function help() {
  out(`
  tb-iosfix ${VERSION}, the evidence engine behind /ios-fix

  Can this even run here:
    preflight [--json]              probe the iOS toolchain and say which half
                                    of the loop is available on this machine

  The loop, in the order the Iron Law requires:
    open      --bug <slug> --summary "<what is wrong>" --expected "<what should happen>"
    repro     --bug <slug> --snapshot <pre.json> --screenshot <pre.png>
    fix       --bug <slug> --cause "<root cause>" --file <path> [--file ...]
    verify    --bug <slug> --screenshot <post.png> [--min-change 0.001] [--json]
    regression --bug <slug> --test <path>
    verdict   --bug <slug> [--json]

  Proof:
    selftest                        run the loop against deliberately broken
                                    captures and fail if any of them pass

  Options: --dir <ledger dir>   (default ./.toolbay/ios-fix, or $TOOLBAY_IOSFIX_DIR)

  Exit codes: 0 true, 1 NOT_FIXED/ESCALATE, 2 usage or unreadable ledger,
  3 UNVERIFIED or the device loop is unavailable here.

  This engine fails closed. A comparison it cannot make is UNVERIFIED, which is
  a different answer from "the bug is still there" and a different answer again
  from "fixed".
`);
}

function main() {
  const argv = process.argv.slice(2);
  switch (argv[0]) {
    case "preflight":
      return preflight(argv);
    case "open":
      return cmdOpen(argv);
    case "repro":
      return cmdRepro(argv);
    case "fix":
      return cmdFix(argv);
    case "verify":
      return cmdVerify(argv);
    case "regression":
      return cmdRegression(argv);
    case "verdict":
      return cmdVerdict(argv);
    case "selftest":
      return selftest();
    default:
      help();
      if (argv[0]) process.exitCode = EXIT_USAGE;
      return null;
  }
}

try {
  main();
} catch (e) {
  out();
  out(`  BLOCKED  tb-iosfix crashed: ${e?.message ?? e}`);
  out(`  A crash is not a pass. Nothing about this fix has been established.`);
  out();
  if (process.env.TOOLBAY_DEBUG) process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = EXIT_USAGE;
}
