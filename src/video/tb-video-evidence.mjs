#!/usr/bin/env node
/**
 * tb-video-evidence.mjs — one answer to "did that render actually produce the
 * video that was asked for".
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. src/artifact/tb-artifact.mjs already decided what a
 * file has to be before this package will call it evidence: it must exist, be a
 * regular file, be non-empty, be readable, and — for a PNG — pass the CRC
 * printed inside every one of its own chunks. That gate is imported here and
 * runs first. This file does not restate any of it.
 *
 * What it adds is the part a render can fail that a screenshot cannot. A video
 * is asked for with a duration and a shape, and both of those are claims the
 * container itself can be made to answer:
 *
 *   - an encoder that died mid-write leaves a file with a header and no mdat,
 *     which is non-zero, opens in nothing, and passes every "the file exists"
 *     check ever written;
 *   - a 22-second brief that renders 1.4 seconds is the single most common way
 *     a composition is wrong, because a clip with no `end` silently takes its
 *     own natural length;
 *   - a 9:16 brief that renders 1920x1080 is the second most common, because
 *     the aspect lives on the scene root and nowhere else, so getting it wrong
 *     produces a perfectly valid video of the wrong video.
 *
 * None of those three is visible to a byte count. All three are printed inside
 * the container, so all three are checked here, and a mismatch is a REFUSAL and
 * never a warning. The rule this package runs on is that a result which reads
 * as success without being one gets deleted, and "rendered!" over a 1.4-second
 * landscape file is exactly that result.
 *
 * WHY NOT JUST EXTEND tb-artifact.mjs. That was the first instinct and it is
 * the wrong shape twice over. Mechanically, tools/sync-guard.mjs copies that
 * file byte-identical into browse/, devex-review/, qa/ and qa-only/, so a video
 * parser added there ships inside four skills that will never open a video.
 * Conceptually, tb-artifact answers "is this file real"; this answers "is this
 * the video that was specified", which needs the spec as an argument and can
 * refuse a completely valid file. Those are two questions, so they are two
 * modules, and the second one calls the first rather than repeating a word of
 * it.
 *
 * WHY THE CONTAINER AND NOT ffmpeg. ffprobe would answer all of this in one
 * line, and this package cannot depend on it: the gate has to work on a machine
 * that has none of it installed, because the whole point of a fail-closed check
 * is that it is never the part that is missing. MP4 and WebM both print
 * duration and pixel dimensions in fixed positions near the front of the file,
 * so reading them is a hundred lines of arithmetic and no dependency at all.
 * (The parser was written against files ffmpeg produced, then checked against
 * fixtures built here from the spec, so both directions have been walked.)
 *
 *   node tb-video-evidence.mjs check <file> [--seconds N] [--tolerance N]
 *                                           [--aspect W:H] [--min-bytes N]
 *   node tb-video-evidence.mjs probe <file>
 *   node tb-video-evidence.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkArtifact } from "./tb-artifact.mjs";

// --------------------------------------------------------------- MP4 / ISOBMFF

/** Boxes that hold other boxes. Anything else is a leaf and gets skipped. */
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"]);

/**
 * Walk an ISO base media file, calling `visit(type, payload)` for every box.
 *
 * Returns {ok, reason}. A box whose declared size runs past the end of the file
 * is the signature of a truncated encode, and it is reported as such rather
 * than being clamped, because clamping is how a half-written file gets read as
 * a whole one.
 */
export function walkMp4(buf, visit, start = 0, end = buf.length, depth = 0) {
  if (depth > 8) return { ok: true, reason: null };
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return { ok: false, reason: `is truncated inside its ${type} box header` };
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - pos; // "to end of file"
    }
    if (size < header) return { ok: false, reason: `declares a ${type} box of ${size} bytes, which is impossible` };
    if (pos + size > end) {
      return { ok: false, reason: `is truncated: its ${type} box claims ${size} bytes but the file ends first` };
    }
    const payloadStart = pos + header;
    const payloadEnd = pos + size;
    visit(type, buf.subarray(payloadStart, payloadEnd));
    if (MP4_CONTAINERS.has(type)) {
      const inner = walkMp4(buf, visit, payloadStart, payloadEnd, depth + 1);
      if (!inner.ok) return inner;
    }
    pos = payloadEnd;
  }
  return { ok: true, reason: null };
}

/** 16.16 fixed point, the format tkhd stores width and height in. */
const fixed1616 = (buf, off) => buf.readUInt32BE(off) / 65536;

/**
 * {ok, why, format, durationSec, width, height, hasMedia} for MP4 bytes.
 *
 * Dimensions come from the track header of a track whose handler is `vide`.
 * Taking the first tkhd instead would report 0x0 on any file whose audio track
 * is written first, which is most of them.
 */
export function inspectMp4(buf) {
  const no = (why) => ({ ok: false, why, format: "mp4", durationSec: null, width: null, height: null, hasMedia: false });

  let movieTimescale = null;
  let movieDuration = null;
  let hasMedia = false;
  let sawMoov = false;
  // tkhd and hdlr arrive in that order inside each trak, so the pending
  // dimensions are claimed by whichever handler type shows up next.
  let pendingTrack = null;
  const videoTracks = [];

  const walked = walkMp4(buf, (type, payload) => {
    if (type === "moov") sawMoov = true;
    if (type === "mdat" && payload.length > 0) hasMedia = true;
    if (type === "mvhd" && payload.length >= 20) {
      const version = payload[0];
      if (version === 1 && payload.length >= 32) {
        movieTimescale = payload.readUInt32BE(20);
        movieDuration = Number(payload.readBigUInt64BE(24));
      } else {
        movieTimescale = payload.readUInt32BE(12);
        movieDuration = payload.readUInt32BE(16);
      }
    }
    if (type === "tkhd") {
      const version = payload[0];
      const off = version === 1 ? 88 : 76;
      if (payload.length >= off + 8) {
        pendingTrack = { width: fixed1616(payload, off), height: fixed1616(payload, off + 4) };
      }
    }
    if (type === "hdlr" && payload.length >= 12) {
      const handler = payload.toString("latin1", 8, 12);
      if (handler === "vide" && pendingTrack) videoTracks.push(pendingTrack);
      pendingTrack = null;
    }
  });

  if (!walked.ok) return no(`the MP4 ${walked.reason}`);
  if (!sawMoov) return no("the MP4 has no moov box, so it carries no index and plays in nothing");
  if (movieTimescale === null) return no("the MP4 has no mvhd box, so its duration is unknown");
  if (!movieTimescale) return no("the MP4's mvhd declares a timescale of 0, so its duration cannot be read");
  if (!hasMedia) {
    return no("the MP4 has no mdat payload: it is a header for a video whose frames were never written");
  }

  const durationSec = movieDuration / movieTimescale;
  const track = videoTracks.find((t) => t.width > 0 && t.height > 0);
  if (!track) {
    return no("the MP4 declares no video track with real dimensions, so it is audio or an empty container, not a video");
  }
  return {
    ok: true,
    why: `${track.width}x${track.height} MP4, ${durationSec.toFixed(2)}s by its own mvhd`,
    format: "mp4",
    durationSec,
    width: track.width,
    height: track.height,
    hasMedia,
  };
}

// ------------------------------------------------------------- WebM / Matroska

const EBML_ID = {
  header: 0x1a45dfa3,
  docType: 0x4282,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
};

// Cluster is deliberately NOT here. It is a master element, but its children
// are frame payloads, and nothing this module reports is inside one. Descending
// into it would mean parsing megabytes of compressed video as if it were EBML,
// which is slow when the frames happen to parse and a false "truncated" verdict
// when they do not.
const EBML_MASTERS = new Set([
  EBML_ID.header, EBML_ID.segment, EBML_ID.info, EBML_ID.tracks,
  EBML_ID.trackEntry, EBML_ID.video,
]);

/** Read an EBML variable-length integer. `keepMarker` is how element IDs are read. */
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null; // 5+ leading zero bytes: not a length we support
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
    if (length > 8) return null;
  }
  if (pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + buf[pos + i];
    if (!keepMarker && buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

/** Walk EBML elements, calling visit(id, payload, isMaster). */
export function walkEbml(buf, visit, start = 0, end = buf.length, depth = 0) {
  if (depth > 8) return { ok: true, reason: null };
  let pos = start;
  while (pos < end) {
    const id = readVint(buf, pos, true);
    if (!id) return { ok: false, reason: `has an unreadable element id at byte ${pos}` };
    const size = readVint(buf, pos + id.length, false);
    if (!size) return { ok: false, reason: `has an unreadable element size at byte ${pos + id.length}` };
    const payloadStart = pos + id.length + size.length;
    // An unknown-size master (live-muxed Segment) runs to the end of its parent.
    const payloadEnd = size.unknown ? end : payloadStart + size.value;
    if (payloadEnd > end) {
      return { ok: false, reason: `is truncated: an element claims ${size.value} bytes but the file ends first` };
    }
    const isMaster = EBML_MASTERS.has(id.value);
    visit(id.value, buf.subarray(payloadStart, payloadEnd), isMaster);
    if (isMaster) {
      const inner = walkEbml(buf, visit, payloadStart, payloadEnd, depth + 1);
      if (!inner.ok) return inner;
    }
    if (payloadEnd <= pos) return { ok: false, reason: "contains a zero-length element and cannot be walked" };
    pos = payloadEnd;
  }
  return { ok: true, reason: null };
}

const ebmlUint = (b) => {
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  return v;
};
const ebmlFloat = (b) => (b.length === 4 ? b.readFloatBE(0) : b.length === 8 ? b.readDoubleBE(0) : null);

/** {ok, why, format, durationSec, width, height, hasMedia} for WebM bytes. */
export function inspectWebm(buf) {
  const no = (why) => ({ ok: false, why, format: "webm", durationSec: null, width: null, height: null, hasMedia: false });

  let docType = null;
  let timecodeScale = 1e6; // Matroska's default: nanoseconds per tick
  let scaledDuration = null;
  let hasMedia = false;
  let pendingVideo = null;
  const videoTracks = [];

  const walked = walkEbml(buf, (id, payload) => {
    if (id === EBML_ID.docType) docType = payload.toString("latin1").replace(/\0+$/, "");
    if (id === EBML_ID.timecodeScale) timecodeScale = ebmlUint(payload) || 1e6;
    if (id === EBML_ID.duration) scaledDuration = ebmlFloat(payload);
    if (id === EBML_ID.cluster && payload.length > 0) hasMedia = true;
    if (id === EBML_ID.pixelWidth) pendingVideo = { ...(pendingVideo || {}), width: ebmlUint(payload) };
    if (id === EBML_ID.pixelHeight) pendingVideo = { ...(pendingVideo || {}), height: ebmlUint(payload) };
    if (id === EBML_ID.video) {
      // The Video master is visited before its children, so flush on the next
      // TrackEntry boundary instead: TrackType arrives after Video in practice.
    }
    if (id === EBML_ID.trackType && ebmlUint(payload) === 1 && pendingVideo) {
      videoTracks.push(pendingVideo);
      pendingVideo = null;
    }
  });

  if (!walked.ok) return no(`the WebM ${walked.reason}`);
  if (!docType) return no("the WebM has no DocType, so it is not a readable Matroska file");
  if (docType !== "webm" && docType !== "matroska") return no(`the file declares DocType "${docType}", which is not a video container`);
  if (scaledDuration === null) return no("the WebM's Info segment declares no Duration, so its length is unknown");
  if (!hasMedia) return no("the WebM has no Cluster payload: it is a header for a video whose frames were never written");

  // Track order is muxer-dependent; a video track written without a TrackType
  // is still a video track, so an unflushed pending entry counts.
  const track = [...videoTracks, pendingVideo].find((t) => t && t.width > 0 && t.height > 0);
  if (!track) return no("the WebM declares no video track with real dimensions, so it is audio, not video");

  const durationSec = (scaledDuration * timecodeScale) / 1e9;
  return {
    ok: true,
    why: `${track.width}x${track.height} WebM, ${durationSec.toFixed(2)}s by its own Info segment`,
    format: "webm",
    durationSec,
    width: track.width,
    height: track.height,
    hasMedia,
  };
}

// ------------------------------------------------------------------ the gate

export const MP4_BRANDS = ["ftyp"];
export const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** Which container these bytes are, by signature rather than by file extension. */
export function sniffContainer(buf) {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (buf.length >= 4 && buf.subarray(0, 4).equals(WEBM_MAGIC)) return "webm";
  return null;
}

/** Structural verdict on video bytes already in memory. */
export function inspectVideo(buf) {
  const container = sniffContainer(buf);
  if (container === "mp4") return inspectMp4(buf);
  if (container === "webm") return inspectWebm(buf);
  return {
    ok: false,
    why: "the file is not an MP4 or WebM: it carries no container signature at all",
    format: null,
    durationSec: null,
    width: null,
    height: null,
    hasMedia: false,
  };
}

/** "9:16" -> 0.5625. Returns null for anything that is not a ratio. */
export function parseAspect(spec) {
  if (typeof spec === "number" && spec > 0) return spec;
  if (typeof spec !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(spec);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  return w / h;
}

/**
 * The gate a render has to pass before this package will call it a video.
 *
 *   expectSeconds   the duration the spec asked for; refused if the container
 *                   disagrees by more than `toleranceSeconds`
 *   toleranceSeconds  how far off is still the right video (encoders land a
 *                   frame or two either side of an exact request)
 *   expectAspect    "9:16", "16:9", or a number; refused on a mismatch
 *   aspectTolerance relative slack on the ratio, for 1080x1920 vs 1082x1920
 *   minBytes        floor, passed straight through to tb-artifact
 *
 * Returns {ok, why, checks[], info}. Every check is reported, not just the
 * first failure, because "it is the wrong length AND the wrong shape" is one
 * fix and two separate re-renders.
 */
export function checkVideoArtifact(file, {
  expectSeconds = null,
  toleranceSeconds = 0.5,
  expectAspect = null,
  aspectTolerance = 0.02,
  minBytes = 0,
} = {}) {
  const checks = [];
  const add = (ok, label) => checks.push({ ok, label });

  // The floor every artifact in this package sits on: exists, is a file, is not
  // 0 bytes, is readable, clears the byte floor. Not restated here.
  const base = checkArtifact(file, { minBytes });
  add(base.ok, base.why);
  if (!base.ok) return { ok: false, why: base.why, checks, info: null };

  const buf = fs.readFileSync(file);
  const info = inspectVideo(buf);
  add(info.ok, info.ok ? info.why : `${file}: ${info.why}`);
  if (!info.ok) return { ok: false, why: `${file}: ${info.why}`, checks, info: null };

  if (!(info.durationSec > 0)) {
    const why = `${file} is a structurally valid ${info.format} of ${info.durationSec}s, which is not a video anyone can watch`;
    add(false, why);
    return { ok: false, why, checks, info };
  }

  const problems = [];

  if (expectSeconds !== null && expectSeconds !== undefined) {
    const drift = Math.abs(info.durationSec - expectSeconds);
    const ok = drift <= toleranceSeconds;
    add(ok, ok
      ? `duration ${info.durationSec.toFixed(2)}s matches the ${expectSeconds}s that was specified`
      : `duration is ${info.durationSec.toFixed(2)}s but the spec asked for ${expectSeconds}s (off by ${drift.toFixed(2)}s, tolerance ${toleranceSeconds}s)`);
    if (!ok) {
      problems.push(`it runs ${info.durationSec.toFixed(2)}s instead of the ${expectSeconds}s that was specified`);
    }
  }

  if (expectAspect !== null && expectAspect !== undefined) {
    const want = parseAspect(expectAspect);
    if (want === null) {
      const why = `"${expectAspect}" is not an aspect ratio, so nothing could be checked against it`;
      add(false, why);
      return { ok: false, why: `${file}: ${why}`, checks, info };
    }
    const got = info.width / info.height;
    const ok = Math.abs(got - want) / want <= aspectTolerance;
    add(ok, ok
      ? `${info.width}x${info.height} matches the ${expectAspect} that was specified`
      : `${info.width}x${info.height} is ${got.toFixed(4)}:1 but the spec asked for ${expectAspect} (${want.toFixed(4)}:1)`);
    if (!ok) problems.push(`it is ${info.width}x${info.height}, which is not ${expectAspect}`);
  }

  if (problems.length) {
    return {
      ok: false,
      why: `${file} is a real video, but not the one that was asked for: ${problems.join(", and ")}`,
      checks,
      info,
    };
  }
  return { ok: true, why: `${file}, ${base.bytes} bytes, ${info.why}`, checks, info };
}

// ----------------------------------------------------------------- fixtures

const box = (type, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};

/**
 * A real, minimally valid MP4. Used by the selftest and available to callers.
 *
 * Built from the ISO BMFF spec rather than copied out of an encoder, so the
 * selftest asserts against the format this module claims to read, and runs on a
 * machine with no ffmpeg on it. The parser was separately walked over files
 * ffmpeg produced; both fixtures agree.
 */
export function makeTinyMp4({ width = 1080, height = 1920, seconds = 3, timescale = 600, withMdat = true, mdatBytes = 2048 } = {}) {
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("isom", "latin1"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2avc1mp41", "latin1"),
  ]));

  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 0); // version 0 + flags
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 16);

  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(0, 0);
  tkhd.writeUInt32BE(1, 12); // track_ID
  tkhd.writeUInt32BE(Math.round(seconds * timescale), 20);
  tkhd.writeUInt32BE(Math.round(width * 65536), 76);
  tkhd.writeUInt32BE(Math.round(height * 65536), 80);

  const hdlr = Buffer.concat([
    Buffer.alloc(8), // version/flags + pre_defined
    Buffer.from("vide", "latin1"),
    Buffer.alloc(12),
    Buffer.from("VideoHandler\0", "latin1"),
  ]);

  const trak = box("trak", Buffer.concat([box("tkhd", tkhd), box("mdia", box("hdlr", hdlr))]));
  const moov = box("moov", Buffer.concat([box("mvhd", mvhd), trak]));
  const parts = [ftyp, moov];
  // mdatBytes exists so a fixture can be made to clear a caller's byte floor.
  // A real 22-second render is megabytes; a fixture that is always 2KB would
  // make every floor look like a bug in the floor.
  if (withMdat) parts.push(box("mdat", Buffer.alloc(Math.max(1, mdatBytes), 0x11)));
  return Buffer.concat(parts);
}

const vint = (value) => {
  // Shortest encoding whose marker bit leaves room for the value.
  for (let len = 1; len <= 8; len += 1) {
    const max = 2 ** (7 * len) - 1;
    if (value < max) {
      const b = Buffer.alloc(len);
      let v = value;
      for (let i = len - 1; i >= 0; i -= 1) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      b[0] |= 0x80 >> (len - 1);
      return b;
    }
  }
  throw new Error("value too large for a vint");
};

const idBytes = (id) => {
  const out = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
};

const el = (id, payload) => Buffer.concat([idBytes(id), vint(payload.length), payload]);
const uintEl = (id, n) => {
  const b = [];
  let v = n;
  do {
    b.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, Buffer.from(b));
};
const floatEl = (id, n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return el(id, b);
};

/** A real, minimally valid WebM, built from the Matroska spec. */
export function makeTinyWebm({ width = 1920, height = 1080, seconds = 5, withCluster = true, docType = "webm" } = {}) {
  const timecodeScale = 1e6; // ns per tick, so Duration is in milliseconds
  const header = el(EBML_ID.header, Buffer.concat([
    uintEl(0x4286, 1), // EBMLVersion
    el(EBML_ID.docType, Buffer.from(docType, "latin1")),
    uintEl(0x4287, 2), // DocTypeVersion
  ]));
  const info = el(EBML_ID.info, Buffer.concat([
    uintEl(EBML_ID.timecodeScale, timecodeScale),
    floatEl(EBML_ID.duration, (seconds * 1e9) / timecodeScale),
  ]));
  const trackEntry = el(EBML_ID.trackEntry, Buffer.concat([
    el(EBML_ID.video, Buffer.concat([
      uintEl(EBML_ID.pixelWidth, width),
      uintEl(EBML_ID.pixelHeight, height),
    ])),
    uintEl(EBML_ID.trackType, 1),
  ]));
  const tracks = el(EBML_ID.tracks, trackEntry);
  const body = [info, tracks];
  if (withCluster) body.push(el(EBML_ID.cluster, Buffer.alloc(512, 0x22)));
  return Buffer.concat([header, el(EBML_ID.segment, Buffer.concat(body))]);
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || ".", "tb-video-"));
  try {
    const p = (n) => path.join(dir, n);

    // ---- the floor, inherited from tb-artifact and not restated
    check("a render that produced no file is refused", false, checkVideoArtifact(p("nothing.mp4")).ok);
    check("...and the reason says the run claimed one", true,
      /claims one was written/.test(checkVideoArtifact(p("nothing.mp4")).why));

    fs.writeFileSync(p("empty.mp4"), "");
    check("a 0-byte render is refused", false, checkVideoArtifact(p("empty.mp4")).ok);

    fs.mkdirSync(p("adir.mp4"));
    check("a directory named .mp4 is refused", false, checkVideoArtifact(p("adir.mp4")).ok);

    // ---- not a video
    fs.writeFileSync(p("log.mp4"), "ffmpeg: Invalid data found when processing input\n");
    const notVideo = checkVideoArtifact(p("log.mp4"));
    check("a text file named .mp4 is refused", false, notVideo.ok);
    check("...and the reason names the container", true, /not an MP4 or WebM/.test(notVideo.why), notVideo.why);
    check("...and a non-zero size does NOT rescue it", true, fs.statSync(p("log.mp4")).size > 0);

    fs.writeFileSync(p("frame.mp4"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    check("a PNG saved with a .mp4 extension is refused", false, checkVideoArtifact(p("frame.mp4")).ok);

    // ---- a real MP4
    const good = makeTinyMp4({ width: 1080, height: 1920, seconds: 22 });
    fs.writeFileSync(p("reel.mp4"), good);
    const ok = checkVideoArtifact(p("reel.mp4"), { expectSeconds: 22, expectAspect: "9:16" });
    check("a real 9:16 MP4 of the specified length passes", true, ok.ok, ok.why);
    check("...and its duration is read from mvhd", "22.00", ok.info.durationSec.toFixed(2));
    check("...and its dimensions from the video track's tkhd", "1080x1920", `${ok.info.width}x${ok.info.height}`);

    // ---- the three failures a byte count cannot see
    const short = checkVideoArtifact(p("reel.mp4"), { expectSeconds: 5, expectAspect: "9:16" });
    check("a valid video of the WRONG DURATION is refused", false, short.ok);
    check("...and the reason names both lengths", true, /22.00s instead of the 5s/.test(short.why), short.why);

    const wrongShape = checkVideoArtifact(p("reel.mp4"), { expectSeconds: 22, expectAspect: "16:9" });
    check("a valid video of the WRONG ASPECT is refused", false, wrongShape.ok);
    check("...and the reason names the real dimensions", true, /1080x1920, which is not 16:9/.test(wrongShape.why), wrongShape.why);

    const bothWrong = checkVideoArtifact(p("reel.mp4"), { expectSeconds: 5, expectAspect: "16:9" });
    check("both wrong at once reports both, not just the first", true,
      /instead of the 5s/.test(bothWrong.why) && /not 16:9/.test(bothWrong.why), bothWrong.why);

    const headerOnly = makeTinyMp4({ seconds: 22, withMdat: false });
    fs.writeFileSync(p("died.mp4"), headerOnly);
    const died = checkVideoArtifact(p("died.mp4"), { expectSeconds: 22 });
    check("an encode that wrote a header and no frames is refused", false, died.ok);
    check("...and the reason says the frames were never written", true, /never written/.test(died.why), died.why);

    fs.writeFileSync(p("cut.mp4"), good.subarray(0, good.length - 900));
    const cut = checkVideoArtifact(p("cut.mp4"), { expectSeconds: 22 });
    check("a truncated MP4 is refused", false, cut.ok, cut.why);
    check("...and the reason says truncated", true, /truncated/.test(cut.why), cut.why);

    const zero = makeTinyMp4({ seconds: 0 });
    fs.writeFileSync(p("zero.mp4"), zero);
    check("a structurally valid 0-second video is refused", false, checkVideoArtifact(p("zero.mp4")).ok);

    // ---- tolerance is a real number, not an excuse
    check("a frame of encoder drift still passes", true,
      checkVideoArtifact(p("reel.mp4"), { expectSeconds: 21.97, toleranceSeconds: 0.5 }).ok);
    check("...but half a second past the tolerance does not", false,
      checkVideoArtifact(p("reel.mp4"), { expectSeconds: 21.4, toleranceSeconds: 0.5 }).ok);

    // ---- WebM, the other container dapi can be asked for
    const webm = makeTinyWebm({ width: 1920, height: 1080, seconds: 8 });
    fs.writeFileSync(p("clip.webm"), webm);
    const w = checkVideoArtifact(p("clip.webm"), { expectSeconds: 8, expectAspect: "16:9" });
    check("a real 16:9 WebM passes", true, w.ok, w.why);
    check("...and its duration comes from Info/Duration", "8.00", w.info.durationSec.toFixed(2));
    check("...and a WebM of the wrong shape is refused", false,
      checkVideoArtifact(p("clip.webm"), { expectAspect: "9:16" }).ok);

    fs.writeFileSync(p("noframes.webm"), makeTinyWebm({ seconds: 8, withCluster: false }));
    check("a WebM with no Cluster payload is refused", false, checkVideoArtifact(p("noframes.webm")).ok);

    // ---- the extension is not evidence of anything
    fs.writeFileSync(p("mislabeled.webm"), good);
    check("an MP4 named .webm is read as the MP4 it is", true,
      checkVideoArtifact(p("mislabeled.webm"), { expectSeconds: 22 }).ok);

    // ---- aspect parsing
    check("9:16 parses to the portrait ratio", "0.5625", String(parseAspect("9:16")));
    check("16x9 parses too", "1.7778", parseAspect("16x9").toFixed(4));
    check("nonsense is not an aspect ratio", "null", String(parseAspect("tall")));
    const badAspect = checkVideoArtifact(p("reel.mp4"), { expectAspect: "tall" });
    check("an unparseable aspect is a refusal, not a skipped check", false, badAspect.ok, badAspect.why);

    // ---- the byte floor still applies
    check("a byte floor refuses a video under it", false,
      checkVideoArtifact(p("reel.mp4"), { minBytes: 10 ** 7 }).ok);

    // ---- no spec means structure only, and it still refuses rubbish
    check("with no spec, a real video passes on structure alone", true, checkVideoArtifact(p("reel.mp4")).ok);
    check("...and rubbish still does not", false, checkVideoArtifact(p("log.mp4")).ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-video-evidence selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A render is only a success if the file is real, is video, is the length\n  that was asked for, and is the shape that was asked for.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i > -1 ? args[i + 1] : null;
  };
  if (args[0] === "selftest") selftest();
  else if (args[0] === "probe" && args[1]) {
    let buf;
    try {
      buf = fs.readFileSync(args[1]);
    } catch (e) {
      process.stdout.write(`\n  REFUSED  ${args[1]} could not be read (${e.code || e.message})\n\n`);
      process.exitCode = 1;
      buf = null;
    }
    if (buf) {
      const info = inspectVideo(buf);
      process.stdout.write(`\n  ${info.ok ? "ok" : "REFUSED"}  ${info.why}\n\n`);
      if (!info.ok) process.exitCode = 1;
    }
  } else if (args[0] === "check" && args[1]) {
    const seconds = flag("--seconds");
    const tolerance = flag("--tolerance");
    const r = checkVideoArtifact(args[1], {
      expectSeconds: seconds === null ? null : Number(seconds),
      toleranceSeconds: tolerance === null ? 0.5 : Number(tolerance),
      expectAspect: flag("--aspect"),
      minBytes: Number(flag("--min-bytes") || 0),
    });
    process.stdout.write("\n");
    for (const c of r.checks) process.stdout.write(`  ${c.ok ? "ok " : "NO "}  ${c.label}\n`);
    process.stdout.write(`\n  ${r.ok ? "ok" : "REFUSED"}  ${r.why}\n\n`);
    if (!r.ok) process.exitCode = 1;
  } else {
    process.stdout.write("\n  usage: tb-video-evidence.mjs check <file> [--seconds N] [--tolerance N] [--aspect W:H] [--min-bytes N]\n         tb-video-evidence.mjs probe <file> | selftest\n\n");
    process.exitCode = 1;
  }
}
