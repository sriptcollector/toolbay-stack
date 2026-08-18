#!/usr/bin/env node
/**
 * tb-artifact.mjs — one answer to "does this evidence file hold up".
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. "Every pass is backed by an artifact you can open" is
 * the sentence this whole package is selling, and the check behind it had been
 * written by hand in several engines to several different standards:
 *
 *   qa, qa-only      the file exists and is not 0 bytes. That is all.
 *   browse           the first eight bytes are the PNG signature.
 *   devex-review     PNG signature plus a byte floor.
 *
 * So how strict "evidence" was depended on which skill you happened to run.
 * The weakest of those is the one that matters: an HTML error page, a JSON
 * body from a 401, or a text file saved with a .png extension is a non-zero
 * file, so /qa graded a verified pass on it. A signature check is not enough
 * either — the first eight bytes of a truncated or corrupted capture are still
 * a valid signature.
 *
 * WHICH BEHAVIOUR WON, AND WHY: the strictest one, made stricter. An artifact
 * has to exist, be a regular file, be non-empty, and — when it is a PNG, or
 * when the caller asked for one — carry a valid IHDR and pass the CRC printed
 * inside every one of its own chunks. Rationale: this fork exists to delete
 * results that read as success without being one, so the tie-break between two
 * evidence standards is always the one that refuses more. Loosening `qa` to
 * match `browse` would have been the cheaper edit and the wrong one. The byte
 * floor stays optional, because it is a per-skill judgement about what a
 * painted page weighs, not a fact about the format.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not decide whether a valid
 * screenshot is BLANK. design-review, ios-design-review, ios-fix and diagram
 * each decode pixels for that, against rules specific to what they are looking
 * at, and folding those into one function would be a redesign of four skills
 * rather than the removal of a copy. This is the floor they all sit on.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory. Each skill carries the file;
 * tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-artifact.mjs check <file> [--min-bytes N] [--png]
 *   node tb-artifact.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Walk a PNG's chunks, verifying each one's own CRC.
 *
 * Returns {ok, chunks, reason}. A chunk whose CRC does not match its data is a
 * corrupt file, and a corrupt file is the exact case that opens as a broken
 * image in a viewer while every "the file exists" check passes.
 */
export function pngChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, chunks: [], reason: "does not start with the PNG signature" };
  }
  const chunks = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const dataEnd = pos + 8 + len;
    if (dataEnd + 4 > buf.length) {
      return { ok: false, chunks, reason: `is truncated inside its ${type} chunk` };
    }
    const declared = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(pos + 4, dataEnd)) !== declared) {
      return { ok: false, chunks, reason: `has a ${type} chunk that fails its own CRC, so the file is corrupt` };
    }
    chunks.push({ type, data: buf.subarray(pos + 8, dataEnd) });
    pos = dataEnd + 4;
    if (type === "IEND") break;
  }
  if (!chunks.length) return { ok: false, chunks, reason: "has no chunks after the signature" };
  // A PNG that never reaches IEND is a capture that was cut off mid-write. Its
  // earlier chunks are individually perfect, which is why a per-chunk check
  // alone reports it clean.
  if (chunks[chunks.length - 1].type !== "IEND") {
    return { ok: false, chunks, reason: "is truncated: it never reaches its IEND chunk" };
  }
  return { ok: true, chunks, reason: null };
}

/** {width, height, bitDepth, colorType, interlace} from a chunk list, or null. */
export function readIhdr(chunks) {
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    interlace: ihdr.data[12],
  };
}

/** Structural verdict on PNG bytes already in memory. */
export function inspectPng(buf) {
  const walked = pngChunks(buf);
  if (!walked.ok) return { ok: false, why: `the PNG ${walked.reason}`, ihdr: null };
  const ihdr = readIhdr(walked.chunks);
  if (!ihdr) return { ok: false, why: "the PNG has no usable IHDR chunk, so its dimensions are unknown", ihdr: null };
  if (!ihdr.width || !ihdr.height) {
    return { ok: false, why: `the PNG's IHDR says ${ihdr.width}x${ihdr.height}, which is not an image`, ihdr };
  }
  if (!walked.chunks.some((c) => c.type === "IDAT")) {
    return { ok: false, why: "the PNG has no IDAT chunk, so it carries no pixels at all", ihdr };
  }
  return { ok: true, why: `${ihdr.width}x${ihdr.height} PNG, all chunks pass their own CRC`, ihdr };
}

/**
 * The gate every skill in this package uses before calling a file evidence.
 *
 *   minBytes   optional floor; a PNG under it is refused with the size named
 *   requirePng the file MUST be a PNG (default: PNG rules apply only if the
 *              signature is there, so a .txt log is still checkable)
 *
 * Returns {ok, why, bytes, ihdr}.
 */
export function checkArtifact(file, { minBytes = 0, requirePng = false } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, why: `no file at ${file} (the run claims one was written)`, bytes: 0, ihdr: null };
  }
  if (!st.isFile()) return { ok: false, why: `${file} is not a file`, bytes: 0, ihdr: null };
  if (st.size === 0) {
    return { ok: false, why: `${file} is 0 bytes (a capture that failed writes an empty file)`, bytes: 0, ihdr: null };
  }

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, why: `${file} exists but could not be read (${e.code || e.message})`, bytes: st.size, ihdr: null };
  }

  const looksPng = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  if (requirePng && !looksPng) {
    return { ok: false, why: `${file} is ${st.size} bytes but is not a PNG`, bytes: st.size, ihdr: null };
  }
  if (looksPng) {
    const png = inspectPng(buf);
    if (!png.ok) return { ok: false, why: `${file}: ${png.why}`, bytes: st.size, ihdr: png.ihdr };
    if (st.size < minBytes) {
      return {
        ok: false,
        why:
          `${file} is a valid PNG of only ${st.size} bytes (floor ${minBytes}). A page that never painted ` +
          `captures as a structurally perfect PNG of one flat colour, which is what this size means.`,
        bytes: st.size,
        ihdr: png.ihdr,
      };
    }
    return { ok: true, why: `${file}, ${st.size} bytes, ${png.why}`, bytes: st.size, ihdr: png.ihdr };
  }

  if (st.size < minBytes) {
    return { ok: false, why: `${file} is only ${st.size} bytes (floor ${minBytes})`, bytes: st.size, ihdr: null };
  }
  return { ok: true, why: `${file}, ${st.size} bytes`, bytes: st.size, ihdr: null };
}

// ------------------------------------------------------------------ selftest

/**
 * A real, minimally valid PNG. Used by the selftest and by callers' fixtures.
 *
 * Fixtures matter here more than usual: a "screenshot" fixture made of the PNG
 * signature followed by filler is the exact artifact this module refuses, so a
 * selftest built on one is asserting against a file the product would reject.
 * Every fixture in this package is a real PNG now, made here.
 */
export function makeTinyPng(width = 2, height = 2) {
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A real PNG of at least `totalBytes`, padded with a tEXt comment chunk.
 *
 * For fixtures that need to sit either side of a byte floor. The padding is a
 * legal ancillary chunk with a correct CRC, so the file stays valid at any
 * size — unlike padding the tail with filler, which produces exactly the
 * corrupt artifact these checks exist to catch.
 */
export function makePngOfSize(totalBytes, width = 2, height = 2) {
  const base = makeTinyPng(width, height);
  const iend = base.subarray(base.length - 12);
  const head = base.subarray(0, base.length - 12);
  const overhead = 12 + "Comment\0".length; // chunk framing + keyword
  const pad = Math.max(0, totalBytes - head.length - iend.length - overhead);
  const data = Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from("tEXt", "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, len, body, crc, iend]);
}

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const os = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || ".", "tb-artifact-"));
  try {
    const p = (n) => path.join(os, n);

    check("a file that does not exist is not evidence", false, checkArtifact(p("nothing.png")).ok);
    check("...and the reason says the run claimed one", true, /claims one was written/.test(checkArtifact(p("nothing.png")).why));

    fs.writeFileSync(p("empty.png"), "");
    check("a 0-byte file is not evidence", false, checkArtifact(p("empty.png")).ok);

    fs.mkdirSync(p("adir.png"));
    check("a directory is not evidence", false, checkArtifact(p("adir.png")).ok);

    // The case /qa used to grade as a verified pass.
    fs.writeFileSync(p("error.png"), '{"error":"unauthorized"}');
    check("a JSON error body saved as .png is not evidence", false, checkArtifact(p("error.png"), { requirePng: true }).ok);
    fs.writeFileSync(p("page.png"), "<html><body>404</body></html>");
    check("an HTML error page saved as .png is not evidence", false, checkArtifact(p("page.png"), { requirePng: true }).ok);
    check("...and a non-zero size alone does NOT rescue it", true, fs.statSync(p("page.png")).size > 0);

    const good = makeTinyPng(64, 64);
    fs.writeFileSync(p("good.png"), good);
    check("a real PNG is evidence", true, checkArtifact(p("good.png")).ok);
    check("...and its dimensions are read from IHDR", "64x64", (() => {
      const r = checkArtifact(p("good.png"));
      return `${r.ihdr.width}x${r.ihdr.height}`;
    })());

    // Signature-only checks pass all of these. This module does not.
    fs.writeFileSync(p("truncated.png"), good.subarray(0, good.length - 6));
    check("a truncated PNG is not evidence", false, checkArtifact(p("truncated.png")).ok);

    const corrupt = Buffer.from(good);
    corrupt[30] ^= 0xff; // flip a byte inside IHDR's data, leaving the CRC stale
    fs.writeFileSync(p("corrupt.png"), corrupt);
    const cr = checkArtifact(p("corrupt.png"));
    check("a PNG whose chunk fails its own CRC is not evidence", false, cr.ok, cr.why);
    check("...and the reason names the CRC", true, /CRC/.test(cr.why), cr.why);

    const headerOnly = Buffer.concat([PNG_MAGIC, good.subarray(8, 8 + 25)]);
    fs.writeFileSync(p("sigonly.png"), Buffer.concat([PNG_MAGIC, Buffer.from("not really a png")]));
    check("the signature alone is not enough", false, checkArtifact(p("sigonly.png")).ok, String(headerOnly.length));

    check("a byte floor refuses a PNG under it", false, checkArtifact(p("good.png"), { minBytes: 10 ** 6 }).ok);
    check("...and the refusal names the floor", true, /floor 1000000/.test(checkArtifact(p("good.png"), { minBytes: 10 ** 6 }).why));
    check("no floor means no size opinion", true, checkArtifact(p("good.png"), { minBytes: 0 }).ok);

    // A log file is legitimate evidence and is not a PNG.
    fs.writeFileSync(p("run.log"), "GET / 200\n");
    check("a non-PNG file is evidence when a PNG was not required", true, checkArtifact(p("run.log")).ok);
    check("...and is refused when one was", false, checkArtifact(p("run.log"), { requirePng: true }).ok);

    check("pngChunks refuses a buffer with no signature", false, pngChunks(Buffer.from("hello")).ok);
    check("readIhdr returns null with no IHDR", "null", String(readIhdr([{ type: "IDAT", data: Buffer.alloc(0) }])));
    check("crc32 matches the known IEND value", 2923585666, crc32(Buffer.from("IEND", "latin1")));

    fs.writeFileSync(p("padded.png"), makePngOfSize(4096));
    const padded = checkArtifact(p("padded.png"), { requirePng: true, minBytes: 2048 });
    check("a padded fixture PNG is still a valid PNG", true, padded.ok, padded.why);
    check("...and really is the size that was asked for", true, padded.bytes >= 4096, String(padded.bytes));
  } finally {
    fs.rmSync(os, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-artifact selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  One evidence standard, so how strict a pass is does not depend on which\n  skill happened to run.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args[0] === "selftest") selftest();
  else if (args[0] === "check" && args[1]) {
    const i = args.indexOf("--min-bytes");
    const r = checkArtifact(args[1], {
      minBytes: i > -1 ? Number(args[i + 1]) : 0,
      requirePng: args.includes("--png"),
    });
    process.stdout.write(`\n  ${r.ok ? "ok" : "REFUSED"}  ${r.why}\n\n`);
    if (!r.ok) process.exitCode = 1;
  } else {
    process.stdout.write("\n  usage: tb-artifact.mjs check <file> [--min-bytes N] [--png] | selftest\n\n");
    process.exitCode = 1;
  }
}
