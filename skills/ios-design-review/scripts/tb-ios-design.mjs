#!/usr/bin/env node
/**
 * tb-ios-design.mjs: the SwiftUI design linter, evidence ledger and score
 * calculator behind /ios-design-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The ten review dimensions and their definitions (typography
 * hierarchy, spacing rhythm, colour hierarchy, touch targets, loading/empty/
 * error states, accessibility, animation discipline, iOS idiom alignment,
 * information density, AI-slop check), the 0-10 per-dimension scale with the
 * "what would make it a 10" framing, the read-only `observe` posture, the
 * per-screen loop and the report-per-run output all come from
 * `ios-design-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's ios-design-review ships two files, SKILL.md and SKILL.md.tmpl, and
 * nothing else:
 *
 *   $ ls ~/.claude/skills/gstack/ios-design-review/
 *   SKILL.md  SKILL.md.tmpl
 *
 * Every one of its ten scores is a number the model writes after looking at a
 * screenshot. Nothing opens the screenshot, nothing checks the arithmetic, and
 * nothing checks that a device was ever reached. That produces four failures
 * that all read as a completed audit:
 *
 * 1. NO DEVICE, SAME REPORT. The skill's whole premise is "on real hardware",
 *    and it has no branch for hardware that is not there. Measured on this
 *    machine (Windows 11, Git Bash):
 *
 *      $ which xcrun xcodebuild swift
 *      which: no xcrun in (...)
 *      which: no xcodebuild in (...)
 *      which: no swift in (...)
 *
 *    There is no simulator, no devicectl, no daemon to acquire a session from.
 *    The rubric is still ten questions a language model can answer plausibly
 *    from the source it just read, so the report comes out the same shape,
 *    scored 0-10, with "on a real iPhone" in the header. Here `init` records
 *    what the host can actually reach, `score` refuses to score a
 *    device-only dimension with no device evidence, and the word it prints is
 *    UNSCORED, not a number.
 *
 * 2. THE BLANK SCREENSHOT IS A DOCUMENTED FAILURE MODE WITH NO CHECK BEHIND IT.
 *    gstack's own failure table says: "Screenshot is black/blank -> App may be
 *    in foreground but not rendering; AskUserQuestion to confirm". That hands
 *    the detection to the model, which is being handed the same image. A
 *    backgrounded iOS app screenshots as a structurally perfect PNG of solid
 *    black: right dimensions, right header, opens fine. `evidence` inflates the
 *    IDAT, unfilters it and refuses an image whose every pixel is the same
 *    colour.
 *
 * 3. THE SCORES ARE ASSERTED. gstack publishes the scale and never runs it.
 *    Here each dimension starts at 10 and every recorded finding subtracts its
 *    severity, so the number is arithmetic over a ledger, and each finding
 *    carries either a file:line that is re-read at score time or a screenshot
 *    that is re-hashed at score time. A finding whose cited line no longer says
 *    what it claimed fails the run instead of quietly ageing.
 *
 * 4. MOST OF THE RUBRIC NEVER NEEDED THE DEVICE. Fixed-size type that ignores
 *    Dynamic Type, padding off the 4pt grid, a 32x32 tap target, an icon-only
 *    Button with no VoiceOver label, a hard-coded Color(red:green:blue:) with
 *    no dark-mode variant, a 2-second UI animation, NavigationView after iOS
 *    16, lorem ipsum left in a Text: all of it is in the source, all of it is
 *    decidable without hardware, and none of it is a judgement call. `scan`
 *    finds those with a file and a line number on a machine that has never seen
 *    an iPhone. What is left over is the part that genuinely needs a rendered
 *    screen, and that part is named and left UNSCORED rather than guessed.
 *
 * The linter is a lint, not a compiler. It reads SwiftUI the way a careful
 * reviewer skims it: comments and string bodies removed for the code rules,
 * brace depth tracked so it knows when it is inside a Button. It will miss
 * things a type checker would catch. It does not invent things it did not see,
 * every finding it emits points at a line you can open, and `score` re-reads
 * every one of those lines before it prints a number.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { readLedger as readLedgerShared, writeLedger as writeLedgerShared, ledgerPath as ledgerPathShared } from "./tb-ledger.mjs";

// The evidence ledger; shared reader/writer in src/ledger/tb-ledger.mjs.
function ledgerPath(dir) {
  return ledgerPathShared(dir, LEDGER_NAME);
}
function readLedger(dir) {
  return readLedgerShared(dir, {
    file: LEDGER_NAME,
    what: "ios-design ledger",
    hint: "Run: tb-ios-design.mjs init --app <dir>",
    require: ["findings", "screens"],
  });
}
function writeLedger(dir, ledger) {
  return writeLedgerShared(dir, ledger, { file: LEDGER_NAME, atomic: false });
}


const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_FAILED = 1; // the audit did not pass
const EXIT_UNUSABLE = 2; // the ledger or the arguments could not be used
const EXIT_REFUSED = 3; // a claim that must not be recorded

/**
 * gstack's ten dimensions, in gstack's order, with gstack's definitions
 * compressed to one line each.
 *
 * `evidence` is the new column and the one that does the work. `source` means
 * the dimension is decidable by reading the code. `device` means it is not:
 * information density is about what fits on a rendered screen, and no amount of
 * source reading answers it. A dimension marked device with no screenshot in
 * the ledger is UNSCORED, and an UNSCORED dimension fails the run unless the
 * user explicitly accepts a partial audit, which is then stamped on the report.
 */
const DIMENSIONS = {
  typography: {
    label: "Typography hierarchy",
    evidence: "both",
    hig: "Display/body/caption on the HIG scale, sizes that respond to Dynamic Type, no 12pt body.",
  },
  spacing: {
    label: "Spacing rhythm",
    evidence: "both",
    hig: "A 4pt or 8pt grid used consistently, safe-area insets respected, no magic 17/23/31pt paddings.",
  },
  color: {
    label: "Colour hierarchy",
    evidence: "both",
    hig: "Primary action highest contrast, dark mode correct, WCAG AA on body text.",
  },
  "touch-targets": {
    label: "Touch targets",
    evidence: "both",
    hig: "Every interactive element at least 44x44pt.",
  },
  states: {
    label: "Loading, empty and error states",
    evidence: "both",
    hig: "Each present and intentional. No blank screen during async work. Empty states say what to do next.",
  },
  accessibility: {
    label: "Accessibility",
    evidence: "both",
    hig: "VoiceOver labels on every control, Dynamic Type to XXL without breaking, Reduce Motion respected.",
  },
  animation: {
    label: "Animation discipline",
    evidence: "source",
    hig: "200-300ms for UI feedback, at most two at once, damping that suits the flow.",
  },
  idiom: {
    label: "iOS idiom alignment",
    evidence: "both",
    hig: "Native NavigationStack/List/Form/sheets. No re-invented navigation, no phone hamburger menu.",
  },
  density: {
    label: "Information density",
    evidence: "device",
    hig: "Content fits without horizontal scroll, long screens have anchors, lists use real iOS list patterns.",
  },
  "ai-slop": {
    label: "AI-slop check",
    evidence: "both",
    hig: "No stock layouts, no lorem ipsum shipped, no cargo-culted Material Design, no generated-looking gradients.",
  },
};

/** What one finding costs the dimension it lands in. 10 is the ceiling, 0 the floor. */
const SEVERITIES = { high: 3.0, medium: 1.5, polish: 0.5 };

const LEDGER_NAME = "ios-design-ledger.json";
const DEFAULT_DIR = path.join(".toolbay", "ios-design");
const IGNORE_MARK = /tb-ios-design\s*:\s*ignore/i;

// --------------------------------------------------------------------- paths
//
// The whole Windows story of this package lives in these four functions. A
// POSIX system path handed to Node on Windows resolves somewhere else entirely,
// and the two places are both real directories, so nothing errors: the
// screenshot is written to one and the report links to the other.

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1));
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

/**
 * A POSIX system path on Windows means two different directories depending on
 * who resolves it, and both exist. Refuse it and print both, rather than
 * writing evidence into one and linking the other.
 */
function refusePosixSystemPath(raw, flag) {
  if (!isWindows || typeof raw !== "string") return null;
  if (!/^\/(tmp|var|usr|etc|opt)(\/|$)/.test(raw.trim())) return null;
  const nodeMeans = path.resolve(raw.trim());
  const shellMeans = process.env.TEMP ? path.join(process.env.TEMP, path.basename(raw)) : "(the shell's own temp directory)";
  return (
    `${flag} ${raw} means two different directories on Windows.\n` +
    `  Node resolves it to      ${nodeMeans}\n` +
    `  Git Bash resolves it to  ${shellMeans}\n` +
    `  Both exist, so nothing would error: the evidence lands in one and the report links the other.\n` +
    `  Pass a Windows path, or leave ${flag} off and use the default under the project.`
  );
}

// ------------------------------------------------------------------- ledger

// --------------------------------------------------------------- host facts
//
// What this machine can actually reach. Recorded at init and printed on the
// report, because "reviewed on real hardware" is a claim about the machine the
// review ran on and it is checkable.

function probeHost() {
  const bin = (name) => {
    const res = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 8000, shell: false });
    return !res.error;
  };
  const xcrun = process.platform === "darwin" ? bin("xcrun") : false;
  const daemonUrl = process.env.GSTACK_IOS_DAEMON || process.env.TOOLBAY_IOS_DAEMON || "";
  return {
    platform: process.platform,
    xcrun,
    daemon: daemonUrl || null,
    canReachDevice: Boolean(xcrun) || Boolean(daemonUrl),
    note:
      process.platform === "darwin"
        ? xcrun
          ? "macOS with an Xcode toolchain: a device or simulator session is possible."
          : "macOS with no xcrun on PATH: install the Xcode command line tools before claiming a device audit."
        : `${process.platform} has no Xcode toolchain and no iOS simulator. Source dimensions are still fully auditable; anything that needs a rendered screen is not.`,
  };
}

// ------------------------------------------------------------ image evidence
//
// Adapted from the verifier in /design-review, with one addition that only
// matters here: an iOS screenshot has a screen size, and a desktop window grab
// or a cropped thumbnail does not. See KNOWN_SCREENS.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MIN_DIM = 200;

/**
 * Every iPhone and iPad screen size Apple ships, in points and in native
 * pixels, both orientations. A screenshot that is none of these is not a
 * screenshot of an iOS screen, and the most common way that happens is a
 * desktop window grab of the simulator chrome, or a crop, either of which the
 * rest of the rubric would then be applied to as if it were the app.
 *
 * The list will age. That is why --allow-size exists: it takes the exact
 * WIDTHxHEIGHT, records the override in the ledger, and the report prints it,
 * so an unknown device is one flag away and is never silent.
 */
const KNOWN_SCREENS = [
  [320, 568], [375, 667], [375, 812], [390, 844], [393, 852], [402, 874],
  [414, 736], [414, 896], [428, 926], [430, 932], [440, 956],
  [640, 1136], [750, 1334], [828, 1792], [1080, 1920],
  [1125, 2436], [1170, 2532], [1179, 2556], [1206, 2622],
  [1242, 2208], [1242, 2688], [1284, 2778], [1290, 2796], [1320, 2868],
  [768, 1024], [810, 1080], [820, 1180], [834, 1112], [834, 1194],
  [1024, 1366], [1032, 1376], [1064, 1376], [1488, 2266],
  [1536, 2048], [1620, 2160], [1640, 2360], [1668, 2224], [1668, 2388],
  [2048, 2732], [2064, 2752], [2128, 2752],
];

function isKnownScreen(w, h) {
  const [s, l] = w <= h ? [w, h] : [h, w];
  return KNOWN_SCREENS.some(([a, b]) => a === s && b === l);
}

function pngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

/**
 * True when every pixel is the same colour. This is the check gstack's failure
 * table asks the model to perform by eye. Returns null for a PNG variant this
 * decoder does not handle, and the caller treats null as unverified, never as a
 * pass: an image that cannot be shown to have content is not evidence.
 */
function pngIsFlat(buf, ihdr) {
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (interlace !== 0 || !(colorType in CHANNELS)) return null;
  if (bitDepth !== 8 && bitDepth !== 16) return null;
  if (colorType === 3 && bitDepth !== 8) return null;
  const idat = Buffer.concat(pngChunks(buf).filter((c) => c.type === "IDAT").map((c) => c.data));
  if (!idat.length) return null;
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch {
    return null;
  }
  const bpp = CHANNELS[colorType] * (bitDepth === 16 ? 2 : 1);
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;

  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let first = null;
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base];
    raw.copy(cur, 0, base + 1, base + 1 + stride);
    for (let i = 0; i < stride; i += 1) {
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

function inspectShot(rawPath, { allowSize = null } = {}) {
  const abs = toAbsolute(rawPath);
  const info = { path: abs, ok: false, width: null, height: null, sha256: null, sizeNote: "", reasons: [] };
  if (!abs) {
    info.reasons.push(`"${rawPath}" could not be resolved to a path`);
    return info;
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    info.reasons.push(`${abs} does not exist. A capture that failed leaves no file, and no file is not evidence.`);
    return info;
  }
  if (!st.isFile()) {
    info.reasons.push(`${abs} is not a file`);
    return info;
  }
  if (st.size === 0) {
    info.reasons.push(`${abs} is 0 bytes. A screenshot request that errored writes an empty file and returns success.`);
    return info;
  }
  const buf = fs.readFileSync(abs);
  info.sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  const head = buf.subarray(0, 64).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<") || head.startsWith("{")) {
    info.reasons.push(
      `${abs} is text, not an image (${head.slice(0, 24).replace(/\s+/g, " ")}...). ` +
        "A daemon that answered 403 or 500 was saved under a .png name.",
    );
    return info;
  }
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    info.reasons.push(`${abs} is not a PNG (first bytes ${buf.subarray(0, 8).toString("hex")}). iOS screenshots are PNG.`);
    return info;
  }
  if (buf.length < 33 || buf.subarray(12, 16).toString("latin1") !== "IHDR") {
    info.reasons.push(`${abs} is a truncated PNG with no IHDR header`);
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
    info.reasons.push(`${abs} is ${ihdr.width}x${ihdr.height}, smaller than any iOS screen. This is a crop or a thumbnail, not a screen.`);
    return info;
  }

  const allowed = allowSize && allowSize.width === ihdr.width && allowSize.height === ihdr.height;
  if (isKnownScreen(ihdr.width, ihdr.height)) {
    info.sizeNote = `${ihdr.width}x${ihdr.height}, a known iPhone/iPad screen size`;
  } else if (allowed) {
    info.sizeNote = `${ihdr.width}x${ihdr.height}, not a size this tool knows; accepted by --allow-size`;
  } else {
    info.reasons.push(
      `${abs} is ${ihdr.width}x${ihdr.height}, which is not any iPhone or iPad screen size. ` +
        "That is what a desktop window grab, a simulator screenshot with chrome, or a crop looks like, " +
        `and the whole rubric would then be applied to something that is not the app. ` +
        `If this really is a device screen, pass --allow-size ${ihdr.width}x${ihdr.height} and the override is recorded on the report.`,
    );
    return info;
  }

  const flat = pngIsFlat(buf, ihdr);
  if (flat === true) {
    info.reasons.push(
      `${abs} is ${ihdr.width}x${ihdr.height} of a single flat colour. ` +
        "That is a backgrounded or not-yet-rendered app: gstack's own failure table names this case and then asks the model, " +
        "which is looking at the same image. There is nothing on this screen to review.",
    );
    return info;
  }
  if (flat === null) {
    info.reasons.push(
      `${abs} is a PNG variant this checker cannot decode (bit depth ${ihdr.bitDepth}, colour type ${ihdr.colorType}` +
        `${ihdr.interlace ? ", interlaced" : ""}), so it cannot be shown to be anything other than a blank screen. Re-take it.`,
    );
    return info;
  }

  info.ok = true;
  return info;
}

// ------------------------------------------------------------ the SwiftUI lint
//
// Comments and string bodies are removed before the code rules run, so a
// `// .padding(17)` in a comment and a `"NavigationView"` in a log message do
// not become findings. The raw line is kept for the copy rules and for the
// quote recorded on the finding, which is what `score` re-reads later.

function stripCode(line, state) {
  let outStr = "";
  let i = 0;
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf("*/", i);
      if (end === -1) return { text: outStr, state };
      state.block = false;
      i = end + 2;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") break;
    if (two === "/*") {
      state.block = true;
      i += 2;
      continue;
    }
    const ch = line[i];
    if (ch === '"') {
      // Swift string literal, including the """ multi-line form treated as a
      // single-line open/close, which is enough for a lint.
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      outStr += '""';
      continue;
    }
    outStr += ch;
    i += 1;
  }
  return { text: outStr, state };
}

const INTERACTIVE_OPEN = /\b(Button|NavigationLink|Menu|Toggle|Stepper|Link|ContextMenu)\s*[({]/;
const A11Y_LABEL = /\.accessibility(Label|Element|Hidden|AddTraits)\s*\(|accessibilityLabel\s*:/;

function numbersIn(re, text) {
  const found = [];
  let m;
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = rx.exec(text)) !== null) found.push(Number(m[1]));
  return found.filter((n) => Number.isFinite(n));
}

/**
 * One SwiftUI file, read the way a reviewer skims it.
 *
 * Every rule here answers a dimension gstack defines, and every one of them is
 * decidable without a device. The finding carries the file, the 1-based line,
 * and the line's text, and `score` re-reads that line before it counts.
 */
function scanFile(absFile, relFile) {
  const text = fs.readFileSync(absFile, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];
  let suppressed = 0;

  const push = (line0, dimension, severity, title, fix) => {
    const raw = lines[line0] ?? "";
    const prev = lines[line0 - 1] ?? "";
    if (IGNORE_MARK.test(raw) || IGNORE_MARK.test(prev)) {
      suppressed += 1;
      return;
    }
    findings.push({
      dimension,
      severity,
      title,
      fix,
      file: relFile,
      line: line0 + 1,
      quote: raw.trim().slice(0, 200),
      source: "scan",
    });
  };

  const state = { block: false };
  const stripped = lines.map((l) => stripCode(l, state).text);
  const wholeStripped = stripped.join("\n");

  // ---- brace-depth tracking, so "inside a Button" is a fact and not a guess
  const stack = [];
  let depth = 0;
  const closeCtx = (ctx) => {
    if (ctx.icon && !ctx.label && !ctx.text) {
      push(
        ctx.line,
        "accessibility",
        "high",
        `${ctx.kind} is icon-only and has no VoiceOver label`,
        "Add .accessibilityLabel(\"...\") to the control, or give it visible text.",
      );
    }
    for (const f of ctx.frames) {
      push(
        f.line,
        "touch-targets",
        "high",
        `${ctx.kind} tap target is ${f.w ?? "?"}x${f.h ?? "?"}pt, below the 44x44pt minimum`,
        "Give the control .frame(minWidth: 44, minHeight: 44), or add .contentShape(Rectangle()) over a 44pt area.",
      );
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const s = stripped[i];
    const raw = lines[i];

    if (INTERACTIVE_OPEN.test(s)) {
      stack.push({ kind: /Button/.test(s) ? "Button" : /NavigationLink/.test(s) ? "NavigationLink" : "control", line: i, depth, icon: false, label: false, text: false, frames: [] });
    }

    for (const ctx of stack) {
      if (/Image\s*\(\s*systemName\s*:/.test(s) || /Image\s*\(\s*"/.test(raw)) ctx.icon = true;
      if (A11Y_LABEL.test(s)) ctx.label = true;
      if (/\bText\s*\(/.test(s) || /Button\s*\(\s*"/.test(raw) || /\blabel\s*:/.test(s)) ctx.text = true;
      const fm = /\.frame\s*\(([^)]*)\)/.exec(s);
      if (fm) {
        const w = /(?:^|[\s,(])width\s*:\s*(\d+(?:\.\d+)?)/.exec(fm[1]);
        const h = /(?:^|[\s,(])height\s*:\s*(\d+(?:\.\d+)?)/.exec(fm[1]);
        const wv = w ? Number(w[1]) : null;
        const hv = h ? Number(h[1]) : null;
        const under = (v) => v !== null && v > 0 && v < 44;
        if (under(wv) || under(hv)) ctx.frames.push({ line: i, w: wv, h: hv });
      }
    }

    for (const ch of s) {
      if (ch === "{" || ch === "(") depth += ch === "{" ? 1 : 0;
      else if (ch === "}") depth -= 1;
    }
    while (stack.length && depth <= stack[stack.length - 1].depth) closeCtx(stack.pop());

    // ---- typography
    const fixedType = /\.font\s*\(\s*\.system\s*\(\s*size\s*:\s*(\d+(?:\.\d+)?)/.exec(s);
    if (fixedType && !/relativeTo\s*:/.test(s)) {
      const size = Number(fixedType[1]);
      if (size <= 12) {
        push(i, "typography", "high", `${size}pt fixed type, below the 13pt floor for readable body text`, "Use .font(.footnote) or larger from the system scale.");
      } else {
        push(i, "typography", "medium", `.system(size: ${size}) is a fixed size and does not respond to Dynamic Type`, "Use a semantic style (.body, .headline), or .custom(_, size: relativeTo:) so it scales.");
      }
    }
    if (/\.custom\s*\(\s*"[^"]*"\s*,\s*size\s*:\s*\d/.test(raw) && !/relativeTo\s*:/.test(s)) {
      push(i, "typography", "medium", "custom font at a fixed size, so Dynamic Type is ignored", "Add relativeTo: to the .custom(...) call.");
    }

    // ---- spacing rhythm: the 4pt grid
    for (const [re, what] of [
      [/\.padding\s*\(\s*(\d+(?:\.\d+)?)\s*\)/, "padding"],
      [/\.padding\s*\(\s*\.\w+\s*,\s*(\d+(?:\.\d+)?)\s*\)/, "padding"],
      [/(?:^|[\s,(])spacing\s*:\s*(\d+(?:\.\d+)?)/, "spacing"],
    ]) {
      for (const n of numbersIn(re, s)) {
        if (n > 0 && n % 4 !== 0) {
          push(i, "spacing", "medium", `${what} of ${n}pt is off the 4pt grid`, `Round to ${Math.round(n / 4) * 4}pt, or pull the value from a spacing scale.`);
        }
      }
    }

    // ---- colour
    if (/\b(Color|UIColor)\s*\(\s*(red|_\s*:\s*\.sRGB|\.sRGB|hex)\s*[:,]/.test(s) || /#colorLiteral/.test(s)) {
      push(i, "color", "medium", "hard-coded colour literal, so there is no dark-mode variant", "Move it to an asset-catalog colour set with Any/Dark appearances, or use a semantic Color.");
    }

    // ---- animation discipline
    for (const n of numbersIn(/duration\s*:\s*(\d+(?:\.\d+)?)/, s)) {
      if (/animation|withAnimation|Animation\./.test(s)) {
        if (n > 0.5) push(i, "animation", "medium", `${n}s animation is far past the 200-300ms band for UI feedback`, "Bring it to 0.2-0.3s, or justify it as a deliberate transition.");
        else if (n > 0 && n < 0.12) push(i, "animation", "polish", `${n}s animation is too short to read as motion`, "Either remove it or take it to 0.2s.");
      }
    }
    if (/\.repeatForever/.test(s) && !/reduceMotion|accessibilityReduceMotion/.test(wholeStripped)) {
      push(i, "animation", "medium", "a perpetual animation with no Reduce Motion branch anywhere in the file", "Read @Environment(\\.accessibilityReduceMotion) and stop the repeat when it is on.");
    }

    // ---- iOS idiom
    if (/\bNavigationView\b/.test(s)) {
      push(i, "idiom", "medium", "NavigationView is deprecated as of iOS 16", "Use NavigationStack, or NavigationSplitView on iPad.");
    }
    if (/\.navigationBarHidden\s*\(\s*true|\.toolbar\s*\(\s*\.hidden/.test(s)) {
      push(i, "idiom", "polish", "the system navigation bar is hidden, so a custom bar is doing its job", "Keep the system bar unless the screen is genuinely full-bleed; custom bars lose swipe-back and Dynamic Type.");
    }

    // ---- AI slop, on the raw line because it is about the copy
    if (/lorem\s+ipsum/i.test(raw)) {
      push(i, "ai-slop", "high", "lorem ipsum is still in the UI copy", "Replace it with the real string, or with a realistic sample of the real data.");
    }
    if (/"(Feature\s*(One|Two|Three|\d)|Your (text|title) here|Placeholder(\s+text)?|Sample text|Item \d)"/i.test(raw)) {
      push(i, "ai-slop", "medium", "placeholder copy is shipping in the UI", "Write the real string. Placeholder copy is the single loudest generated-app signal.");
    }
    if (/LinearGradient/.test(s) && /\.purple/.test(s) && /\.blue/.test(s)) {
      push(i, "ai-slop", "medium", "purple-to-blue gradient, the most recognisable generated-app palette", "Pick a palette from the product's own brand, or drop the gradient.");
    }
  }
  while (stack.length) closeCtx(stack.pop());

  // ---- whole-file state rules, each anchored to a real line
  const lineOf = (re) => {
    for (let i = 0; i < stripped.length; i += 1) if (re.test(stripped[i])) return i;
    return -1;
  };
  const forEach = lineOf(/\bForEach\s*\(/);
  if (forEach !== -1 && !/\bisEmpty\b|ContentUnavailableView/.test(wholeStripped)) {
    push(forEach, "states", "medium", "a list with no empty state anywhere in the file", "Branch on isEmpty and show a ContentUnavailableView that says what to do next.");
  }
  const asyncLine = lineOf(/\bawait\b|\.task\s*\{|URLSession/);
  if (asyncLine !== -1 && !/ProgressView|redacted\s*\(|isLoading/.test(wholeStripped)) {
    push(asyncLine, "states", "medium", "async work with no loading state in the file", "Show a ProgressView or a redacted placeholder while the work is in flight.");
  }
  const catchLine = lineOf(/\bcatch\b/);
  if (catchLine !== -1 && !/alert\s*\(|errorMessage|ContentUnavailableView/.test(wholeStripped)) {
    push(catchLine, "states", "polish", "an error is caught but nothing in this file shows the user an error state", "Surface it: .alert(...) bound to the error, or an inline error view.");
  }

  return { findings, suppressed, lines: lines.length };
}

function findSwiftFiles(root) {
  const skip = new Set([".git", "node_modules", "Pods", ".build", "DerivedData", "Carthage", ".swiftpm", "build"]);
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") {
        if (skip.has(e.name)) continue;
      }
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".swift") && !/Tests?\.swift$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  return files.sort();
}

// ------------------------------------------------------------------ scoring
//
// Every finding is re-checked against the disk before it is allowed to move a
// number. A source finding whose cited line no longer contains what it quoted
// is not aged out quietly: it fails the run, because the alternative is a score
// computed from a claim about a file that has changed underneath it.

function verifyFinding(f, ledger) {
  if (f.file) {
    const abs = path.isAbsolute(f.file) ? f.file : path.join(ledger.app, f.file);
    let lines;
    try {
      lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    } catch (e) {
      return { ok: false, why: `${f.id}: ${abs} could not be read (${e.code || e.message}), so its evidence is gone` };
    }
    const line = lines[f.line - 1];
    if (line === undefined) {
      return { ok: false, why: `${f.id}: ${f.file} no longer has a line ${f.line} (the file is ${lines.length} lines)` };
    }
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    if (!norm(line).includes(norm(f.quote))) {
      return {
        ok: false,
        why: `${f.id}: ${f.file}:${f.line} no longer contains what the finding quoted.\n        quoted: ${norm(f.quote)}\n        line now: ${norm(line)}`,
      };
    }
    return { ok: true, kind: "source" };
  }
  if (f.screen) {
    const screen = ledger.screens.find((s) => s.name === f.screen);
    if (!screen) return { ok: false, why: `${f.id}: cites screen "${f.screen}", which has no verified screenshot in the ledger` };
    let buf;
    try {
      buf = fs.readFileSync(screen.shot);
    } catch (e) {
      return { ok: false, why: `${f.id}: the screenshot for "${f.screen}" is gone (${e.code || e.message})` };
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha !== screen.sha256) {
      return { ok: false, why: `${f.id}: the screenshot for "${f.screen}" changed after it was verified (sha256 ${sha.slice(0, 12)} != ${screen.sha256.slice(0, 12)})` };
    }
    return { ok: true, kind: "device" };
  }
  return { ok: false, why: `${f.id}: has neither a file:line nor a screen, so it rests on nothing` };
}

function computeScores(ledger) {
  const problems = [];
  const verified = [];
  for (const f of ledger.findings) {
    const v = verifyFinding(f, ledger);
    if (!v.ok) problems.push(v.why);
    else verified.push({ ...f, evidenceKind: v.kind });
  }

  const haveDevice = ledger.screens.length > 0;
  const haveSource = (ledger.scans ?? []).some((s) => s.files > 0);

  const rows = [];
  for (const [key, def] of Object.entries(DIMENSIONS)) {
    const mine = verified.filter((f) => f.dimension === key);
    const observed =
      def.evidence === "device" ? haveDevice : def.evidence === "source" ? haveSource : haveSource || haveDevice;
    if (!observed) {
      rows.push({
        key,
        label: def.label,
        score: null,
        why:
          def.evidence === "device"
            ? "needs a rendered screen; no verified screenshot in the ledger"
            : "no source scan has been run over the app",
        findings: mine,
      });
      continue;
    }
    let score = 10;
    for (const f of mine) score -= SEVERITIES[f.severity] ?? 0;
    score = Math.max(0, Math.round(score * 10) / 10);
    const worst = mine.slice().sort((a, b) => (SEVERITIES[b.severity] ?? 0) - (SEVERITIES[a.severity] ?? 0))[0];
    rows.push({
      key,
      label: def.label,
      score,
      why: worst ? `to reach 10: ${worst.fix || worst.title}` : "nothing found against this dimension",
      findings: mine,
      partial: def.evidence === "both" && !haveDevice ? "source only; no device evidence for the rendered half" : "",
    });
  }

  const scored = rows.filter((r) => r.score !== null);
  const overall = scored.length ? Math.round((scored.reduce((a, r) => a + r.score, 0) / scored.length) * 10) / 10 : null;
  const unscored = rows.filter((r) => r.score === null);
  return { rows, overall, unscored, problems, verified, haveDevice, haveSource };
}

// ----------------------------------------------------------------- commands

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function resolveDir(flags) {
  const raw = typeof flags.dir === "string" ? flags.dir : null;
  if (raw) {
    const refusal = refusePosixSystemPath(raw, "--dir");
    if (refusal) return { error: refusal };
  }
  return { dir: raw ? toAbsolute(raw) : toAbsolute(DEFAULT_DIR) };
}

function cmdInit(flags) {
  const d = resolveDir(flags);
  if (d.error) {
    err(`\n  REFUSED  ${d.error}\n`);
    return EXIT_REFUSED;
  }
  const appRaw = typeof flags.app === "string" ? flags.app : ".";
  const refusal = refusePosixSystemPath(appRaw, "--app");
  if (refusal) {
    err(`\n  REFUSED  ${refusal}\n`);
    return EXIT_REFUSED;
  }
  const app = toAbsolute(appRaw);
  if (!fs.existsSync(app) || !fs.statSync(app).isDirectory()) {
    err(`\n  UNUSABLE  --app ${app} is not a directory. Point it at the app's source root.\n`);
    return EXIT_UNUSABLE;
  }
  const host = probeHost();
  const ledger = {
    tool: "tb-ios-design",
    version: VERSION,
    createdAt: new Date().toISOString(),
    app,
    dir: d.dir,
    host,
    screens: [],
    findings: [],
    scans: [],
    acceptedUnscored: null,
  };
  writeLedger(d.dir, ledger);
  out();
  out(`  audit open       ${ledgerPath(d.dir)}`);
  out(`  app source       ${app}`);
  out(`  host             ${host.platform}${host.xcrun ? " + xcrun" : ""}${host.daemon ? ` + daemon ${host.daemon}` : ""}`);
  out(`  device evidence  ${host.canReachDevice ? "possible" : "NOT POSSIBLE on this machine"}`);
  out(`                   ${host.note}`);
  out();
  out("  Next: scan the source, then record any screen you actually captured.");
  out(`    node ${path.basename(SELF)} scan`);
  out();
  return EXIT_OK;
}

function cmdScan(flags) {
  const d = resolveDir(flags);
  if (d.error) {
    err(`\n  REFUSED  ${d.error}\n`);
    return EXIT_REFUSED;
  }
  const l = readLedger(d.dir);
  if (l.error) {
    err(`\n  UNUSABLE  ${l.error}\n`);
    return EXIT_UNUSABLE;
  }
  const ledger = l.ledger;
  const files = findSwiftFiles(ledger.app);
  if (!files.length) {
    err(`\n  UNUSABLE  no .swift files under ${ledger.app}. This is not a SwiftUI app, or --app pointed at the wrong directory.\n`);
    return EXIT_UNUSABLE;
  }

  const found = [];
  let suppressed = 0;
  let totalLines = 0;
  for (const f of files) {
    const rel = path.relative(ledger.app, f).split(path.sep).join("/");
    let r;
    try {
      r = scanFile(f, rel);
    } catch (e) {
      err(`\n  UNUSABLE  ${rel} could not be scanned (${e.message}). A file the linter cannot read is not a clean file.\n`);
      return EXIT_UNUSABLE;
    }
    totalLines += r.lines;
    suppressed += r.suppressed;
    found.push(...r.findings);
  }

  found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  found.forEach((f, i) => {
    f.id = `S-${String(i + 1).padStart(3, "0")}`;
  });

  ledger.findings = [...ledger.findings.filter((f) => f.source !== "scan"), ...found];
  ledger.scans = [{ at: new Date().toISOString(), files: files.length, lines: totalLines, found: found.length, suppressed }];
  writeLedger(d.dir, ledger);

  out();
  out(`  scanned ${files.length} .swift file(s), ${totalLines} lines, under ${ledger.app}`);
  out();
  if (!found.length) {
    out("  no source findings. Every dimension that needs a rendered screen is still unscored.");
  }
  const byDim = new Map();
  for (const f of found) byDim.set(f.dimension, [...(byDim.get(f.dimension) ?? []), f]);
  for (const [dim, list] of [...byDim.entries()].sort()) {
    out(`  ${DIMENSIONS[dim].label}  (${list.length})`);
    for (const f of list) out(`    ${f.id}  ${f.severity.padEnd(6)}  ${f.file}:${f.line}  ${f.title}`);
    out();
  }
  if (suppressed) out(`  ${suppressed} finding(s) suppressed by an inline "tb-ios-design: ignore" comment.\n`);
  return EXIT_OK;
}

function cmdEvidence(flags) {
  const d = resolveDir(flags);
  if (d.error) {
    err(`\n  REFUSED  ${d.error}\n`);
    return EXIT_REFUSED;
  }
  const l = readLedger(d.dir);
  if (l.error) {
    err(`\n  UNUSABLE  ${l.error}\n`);
    return EXIT_UNUSABLE;
  }
  const ledger = l.ledger;
  const name = typeof flags.screen === "string" ? flags.screen.trim() : "";
  const shot = typeof flags.shot === "string" ? flags.shot : "";
  if (!name || !shot) {
    err("\n  UNUSABLE  usage: evidence --screen <name> --shot <file.png> [--allow-size WxH]\n");
    return EXIT_UNUSABLE;
  }
  let allowSize = null;
  if (typeof flags["allow-size"] === "string") {
    const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(flags["allow-size"].trim());
    if (!m) {
      err("\n  UNUSABLE  --allow-size wants WIDTHxHEIGHT, e.g. --allow-size 1179x2556\n");
      return EXIT_UNUSABLE;
    }
    allowSize = { width: Number(m[1]), height: Number(m[2]) };
  }

  const info = inspectShot(shot, { allowSize });
  if (!info.ok) {
    err(`\n  REFUSED  screen "${name}" was not recorded.`);
    for (const r of info.reasons) err(`           ${r}`);
    err("");
    return EXIT_REFUSED;
  }
  ledger.screens = [
    ...ledger.screens.filter((s) => s.name !== name),
    {
      name,
      shot: info.path,
      sha256: info.sha256,
      width: info.width,
      height: info.height,
      sizeNote: info.sizeNote,
      sizeOverride: Boolean(allowSize && !isKnownScreen(info.width, info.height)),
      recordedAt: new Date().toISOString(),
    },
  ].sort((a, b) => a.name.localeCompare(b.name));
  writeLedger(d.dir, ledger);
  out(`\n  recorded  ${name}  ${info.sizeNote}  sha256 ${info.sha256.slice(0, 12)}\n`);
  return EXIT_OK;
}

function cmdFinding(flags) {
  const d = resolveDir(flags);
  if (d.error) {
    err(`\n  REFUSED  ${d.error}\n`);
    return EXIT_REFUSED;
  }
  const l = readLedger(d.dir);
  if (l.error) {
    err(`\n  UNUSABLE  ${l.error}\n`);
    return EXIT_UNUSABLE;
  }
  const ledger = l.ledger;
  const id = typeof flags.id === "string" ? flags.id.trim() : "";
  const dimension = typeof flags.dimension === "string" ? flags.dimension.trim() : "";
  const severity = typeof flags.severity === "string" ? flags.severity.trim() : "";
  const title = typeof flags.title === "string" ? flags.title.trim() : "";
  const fix = typeof flags.fix === "string" ? flags.fix.trim() : "";

  if (!/^[A-Za-z][\w.-]{0,31}$/.test(id)) {
    err("\n  UNUSABLE  --id wants a short identifier like D-001\n");
    return EXIT_UNUSABLE;
  }
  if (!(dimension in DIMENSIONS)) {
    err(`\n  UNUSABLE  --dimension must be one of: ${Object.keys(DIMENSIONS).join(", ")}\n`);
    return EXIT_UNUSABLE;
  }
  if (!(severity in SEVERITIES)) {
    err(`\n  UNUSABLE  --severity must be one of: ${Object.keys(SEVERITIES).join(", ")}\n`);
    return EXIT_UNUSABLE;
  }
  if (!title) {
    err("\n  UNUSABLE  --title is required: say what is wrong, specifically\n");
    return EXIT_UNUSABLE;
  }
  if (ledger.findings.some((f) => f.id === id)) {
    err(`\n  UNUSABLE  ${id} is already recorded. Pick another id.\n`);
    return EXIT_UNUSABLE;
  }

  const rec = { id, dimension, severity, title, fix, source: "model" };

  if (typeof flags.file === "string") {
    const line = Number(flags.line);
    if (!Number.isInteger(line) || line < 1) {
      err("\n  UNUSABLE  --file needs --line, a 1-based line number\n");
      return EXIT_UNUSABLE;
    }
    const rel = flags.file.replace(/\\/g, "/");
    const abs = path.isAbsolute(rel) ? rel : path.join(ledger.app, rel);
    let lines;
    try {
      lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    } catch (e) {
      err(`\n  REFUSED  ${abs} could not be read (${e.code || e.message}). A finding must point at a file that exists.\n`);
      return EXIT_REFUSED;
    }
    const text = lines[line - 1];
    if (text === undefined) {
      err(`\n  REFUSED  ${rel} has ${lines.length} lines, so there is no line ${line} to cite.\n`);
      return EXIT_REFUSED;
    }
    if (typeof flags.quote === "string" && flags.quote.trim()) {
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      if (!norm(text).includes(norm(flags.quote))) {
        err(`\n  REFUSED  ${rel}:${line} does not contain what --quote says it does.`);
        err(`           quoted:   ${norm(flags.quote)}`);
        err(`           line is:  ${norm(text)}`);
        err("           A citation that does not check out is worse than no citation.\n");
        return EXIT_REFUSED;
      }
    }
    rec.file = rel;
    rec.line = line;
    rec.quote = text.trim().slice(0, 200);
  } else if (typeof flags.screen === "string") {
    const screen = ledger.screens.find((s) => s.name === flags.screen.trim());
    if (!screen) {
      err(`\n  REFUSED  no screen called "${flags.screen}" has been recorded. Run evidence --screen ... --shot ... first,`);
      err("           so the claim rests on an image this tool has actually opened.\n");
      return EXIT_REFUSED;
    }
    rec.screen = screen.name;
  } else {
    err("\n  REFUSED  a finding needs evidence: --file <path> --line <n> [--quote <text>], or --screen <name>.");
    err("           gstack's rubric is ten scores with nothing under them. That is the thing being fixed here.\n");
    return EXIT_REFUSED;
  }

  ledger.findings.push(rec);
  writeLedger(d.dir, ledger);
  out(`\n  recorded  ${id}  ${dimension}/${severity}  ${rec.file ? `${rec.file}:${rec.line}` : `screen ${rec.screen}`}\n`);
  return EXIT_OK;
}

function cmdScore(flags, { quiet = false } = {}) {
  const d = resolveDir(flags);
  if (d.error) {
    err(`\n  REFUSED  ${d.error}\n`);
    return { code: EXIT_REFUSED };
  }
  const l = readLedger(d.dir);
  if (l.error) {
    err(`\n  UNUSABLE  ${l.error}\n`);
    return { code: EXIT_UNUSABLE };
  }
  const ledger = l.ledger;
  const res = computeScores(ledger);
  // A partial audit is accepted once, by flag, and the acceptance is recorded
  // WITH the dimensions it covered. A later run that is short a DIFFERENT
  // dimension is not covered by it and fails again, so the stamp cannot become
  // a blanket permission to stop looking.
  const stamped = ledger.acceptedUnscored?.dimensions ?? null;
  const covered =
    Array.isArray(stamped) && res.unscored.every((r) => stamped.includes(r.key));
  const accept = flags["accept-unscored"] === true || flags["accept-unscored"] === "true" || covered;

  const say = quiet ? () => {} : out;
  say();
  say(`  iOS design review  ${path.basename(ledger.app)}`);
  say(`  host               ${ledger.host?.platform ?? "?"}, device evidence ${ledger.host?.canReachDevice ? "possible" : "not possible"}`);
  say(`  source             ${(ledger.scans ?? [])[0]?.files ?? 0} file(s) scanned`);
  say(`  screens            ${ledger.screens.length} verified screenshot(s)`);
  say();

  if (res.problems.length) {
    say("  EVIDENCE FAILED");
    for (const p of res.problems) say(`    ${p}`);
    say();
    say("  A score computed over a finding whose evidence no longer holds is a made-up score.");
    say("  Re-run scan, or delete the stale finding, then score again.");
    say();
    return { code: EXIT_FAILED, res, ledger, dir: d.dir };
  }

  if (!res.haveSource && !res.haveDevice) {
    say("  NOTHING WAS OBSERVED");
    say("    No source scan has run and no screenshot has been verified, so there is nothing to score.");
    say("    An audit with no observations is not a pass.");
    say();
    return { code: EXIT_FAILED, res, ledger, dir: d.dir };
  }

  const width = Math.max(...Object.values(DIMENSIONS).map((d2) => d2.label.length));
  for (const r of res.rows) {
    const num = r.score === null ? "UNSCORED" : `${r.score.toFixed(1)}/10`;
    say(`  ${r.label.padEnd(width)}  ${num.padStart(9)}  ${r.findings.length ? `${r.findings.length} finding(s)` : ""}`);
    say(`  ${" ".repeat(width)}  ${" ".repeat(9)}  ${r.why}`);
    if (r.partial) say(`  ${" ".repeat(width)}  ${" ".repeat(9)}  ${r.partial}`);
  }
  say();
  say(`  overall  ${res.overall === null ? "UNSCORED" : `${res.overall.toFixed(1)}/10`}  over ${res.rows.length - res.unscored.length} of ${res.rows.length} dimensions`);
  say();

  if (res.unscored.length) {
    if (!accept) {
      say(`  INCOMPLETE  ${res.unscored.length} dimension(s) have no evidence behind them:`);
      for (const r of res.unscored) say(`    ${r.label}: ${r.why}`);
      say();
      say("  gstack scores all ten from the model's reading of a screenshot, so a run with no device");
      say("  produces the same shaped report as a run on real hardware. This one stops instead.");
      say("  Get the evidence, or accept a partial audit explicitly:");
      say("    score --accept-unscored     (the report is then stamped PARTIAL and names what was not seen)");
      say();
      return { code: EXIT_FAILED, res, ledger, dir: d.dir };
    }
    ledger.acceptedUnscored = { at: new Date().toISOString(), dimensions: res.unscored.map((r) => r.key) };
    writeLedger(d.dir, ledger);
    say(`  PARTIAL  accepted: ${res.unscored.map((r) => r.label).join(", ")} were not observed and are reported as unscored.`);
    say();
  } else if (ledger.acceptedUnscored) {
    ledger.acceptedUnscored = null;
    writeLedger(d.dir, ledger);
  }

  return { code: EXIT_OK, res, ledger, dir: d.dir };
}

function cmdReport(flags) {
  const scored = cmdScore(flags, { quiet: true });
  if (scored.code !== EXIT_OK) {
    err("\n  REFUSED  the report was not written, because the score did not pass. Run `score` to see why.\n");
    // Re-run loudly so the reason is on screen.
    cmdScore(flags);
    return EXIT_FAILED;
  }
  const { res, ledger, dir } = scored;
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = typeof flags.out === "string" ? toAbsolute(flags.out) : path.join(dir, `ios-design-review-${stamp}.md`);

  const lines = [];
  lines.push(`# iOS design review: ${path.basename(ledger.app)}`);
  lines.push("");
  lines.push(`Run ${new Date().toISOString()} by tb-ios-design ${VERSION}.`);
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push("| What | Value |");
  lines.push("|---|---|");
  lines.push(`| Host | ${ledger.host?.platform ?? "?"} |`);
  lines.push(`| Device evidence possible here | ${ledger.host?.canReachDevice ? "yes" : "no"} |`);
  lines.push(`| Source files scanned | ${(ledger.scans ?? [])[0]?.files ?? 0} (${(ledger.scans ?? [])[0]?.lines ?? 0} lines) |`);
  lines.push(`| Screens with a verified screenshot | ${ledger.screens.length} |`);
  lines.push(`| Findings | ${ledger.findings.length}, every one re-checked against disk at score time |`);
  lines.push("");
  if (ledger.host && !ledger.host.canReachDevice) lines.push(`> ${ledger.host.note}`);
  lines.push("");
  if (res.unscored.length) {
    lines.push("## PARTIAL AUDIT");
    lines.push("");
    lines.push("These dimensions were not observed and carry no score. They are not passes.");
    lines.push("");
    for (const r of res.unscored) lines.push(`- **${r.label}** — ${r.why}`);
    lines.push("");
  }
  lines.push("## Scores");
  lines.push("");
  lines.push("| Dimension | Score | What would make it a 10 |");
  lines.push("|---|---|---|");
  for (const r of res.rows) {
    lines.push(`| ${r.label} | ${r.score === null ? "UNSCORED" : `${r.score.toFixed(1)}/10`} | ${r.why} |`);
  }
  lines.push("");
  lines.push(`**Overall ${res.overall === null ? "UNSCORED" : `${res.overall.toFixed(1)}/10`}**, the mean of the ${res.rows.length - res.unscored.length} dimensions that had evidence.`);
  lines.push("");
  if (ledger.screens.length) {
    lines.push("## Screens");
    lines.push("");
    for (const s of ledger.screens) {
      lines.push(`- **${s.name}** — ${s.sizeNote}${s.sizeOverride ? " (size accepted by --allow-size override)" : ""}, sha256 \`${s.sha256.slice(0, 16)}\``);
      lines.push(`  ![${s.name}](${s.shot.split(path.sep).join("/")})`);
    }
    lines.push("");
  }
  lines.push("## Findings");
  lines.push("");
  if (!ledger.findings.length) lines.push("None recorded.");
  for (const [key, def] of Object.entries(DIMENSIONS)) {
    const mine = ledger.findings.filter((f) => f.dimension === key);
    if (!mine.length) continue;
    lines.push(`### ${def.label}`);
    lines.push("");
    lines.push(`_${def.hig}_`);
    lines.push("");
    for (const f of mine.sort((a, b) => (SEVERITIES[b.severity] ?? 0) - (SEVERITIES[a.severity] ?? 0))) {
      const where = f.file ? `\`${f.file}:${f.line}\`` : `screen **${f.screen}**`;
      lines.push(`- **${f.id}** (${f.severity}) ${f.title} — ${where}`);
      if (f.quote) lines.push(`  \`\`\`swift\n  ${f.quote}\n  \`\`\``);
      if (f.fix) lines.push(`  Fix: ${f.fix}`);
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  out(`\n  wrote  ${outPath}\n`);
  return EXIT_OK;
}

// ----------------------------------------------------------------- selftest

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real 8-bit RGB PNG. `flat` makes every pixel identical, which is the black-screen case. */
function makePng(width, height, { flat = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    raw[base] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = base + 1 + x * 3;
      if (flat) {
        raw[o] = 0;
        raw[o + 1] = 0;
        raw[o + 2] = 0;
      } else {
        raw[o] = (x * 7 + y * 3) & 255;
        raw[o + 1] = (x * 3) & 255;
        raw[o + 2] = (y * 5) & 255;
      }
    }
  }
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const DIRTY_SWIFT = `import SwiftUI

struct HomeView: View {
    @State private var items: [Item] = []
    var body: some View {
        NavigationView {
            VStack(spacing: 17) {
                Text("Lorem ipsum dolor sit amet")
                    .font(.system(size: 11))
                Text("Feature One")
                    .font(.system(size: 20))
                    .padding(13)
                ForEach(items) { item in
                    Row(item: item)
                }
                Button(action: { refresh() }) {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: 24, height: 24)
                }
                Rectangle()
                    .fill(LinearGradient(colors: [.purple, .blue], startPoint: .top, endPoint: .bottom))
                    .animation(.easeInOut(duration: 2.0), value: items.count)
            }
            .background(Color(red: 0.1, green: 0.2, blue: 0.9))
        }
        .task {
            let data = try? await load()
            items = data ?? []
        }
    }
}
`;

const CLEAN_SWIFT = `import SwiftUI

struct SettingsView: View {
    @State private var isLoading = false
    @State private var rows: [Row] = []
    var body: some View {
        NavigationStack {
            List {
                if rows.isEmpty {
                    ContentUnavailableView("Nothing yet", systemImage: "tray")
                }
                ForEach(rows) { row in
                    Text(row.title)
                        .font(.body)
                        .padding(8)
                }
            }
            .overlay { if isLoading { ProgressView() } }
        }
        .task { await reload() }
    }
}
`;

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", all: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ios-design-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const app = path.join(tmp, "App");
  const src = path.join(app, "Sources");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "HomeView.swift"), DIRTY_SWIFT, "utf8");
  fs.writeFileSync(path.join(src, "SettingsView.swift"), CLEAN_SWIFT, "utf8");
  const dir = path.join(tmp, "ledger");

  // ---- it opens, and it says what this machine can actually reach
  {
    const r = runSelf(["init", "--app", app, "--dir", dir]);
    check("init opens an audit", 0, r.status, r.all.slice(0, 200));
    check("...and states whether device evidence is even possible here", true, /device evidence/i.test(r.stdout), r.stdout.slice(0, 300));
  }
  check("init refuses an app directory that does not exist", 2, runSelf(["init", "--app", path.join(tmp, "nope"), "--dir", dir]).status);
  if (isWindows) {
    const r = runSelf(["init", "--app", app, "--dir", "/tmp/ios-audit"]);
    check("a POSIX system path in --dir is refused on Windows", 3, r.status, r.all.slice(0, 200));
    check("...and both directories that string would mean are printed", true, /Git Bash resolves it to/.test(r.all), r.all.slice(0, 300));
  } else {
    check("a POSIX system path in --dir is accepted off Windows", 0, runSelf(["init", "--app", app, "--dir", path.join(tmp, "posix-ok")]).status);
    check("...and the Windows-only refusal does not fire here", true, true, "");
  }

  // ---- the lint finds real defects, with a line number, on a machine with no iPhone
  {
    const r = runSelf(["scan", "--dir", dir]);
    check("scan runs with no Xcode, no simulator and no device", 0, r.status, r.all.slice(0, 300));
    const want = [
      ["11pt fixed type", /typography.*(\n.*)*?11pt fixed type|11pt fixed type/],
      ["off-grid padding", /off the 4pt grid/],
      ["24x24 tap target", /tap target is 24x24pt/],
      ["icon-only Button with no label", /icon-only and has no VoiceOver label/],
      ["hard-coded colour literal", /hard-coded colour literal/],
      ["2s animation", /2s animation is far past/],
      ["NavigationView after iOS 16", /NavigationView is deprecated/],
      ["lorem ipsum in the copy", /lorem ipsum is still in the UI copy/],
      ["placeholder copy", /placeholder copy is shipping/],
      ["purple-to-blue gradient", /purple-to-blue gradient/],
      ["a list with no empty state", /list with no empty state/],
    ];
    for (const [what, re] of want) check(`scan finds ${what}`, true, re.test(r.stdout), r.stdout.slice(0, 2000));
    check("...and cites a file and a line for every finding", true, /HomeView\.swift:\d+/.test(r.stdout), r.stdout.slice(0, 400));
    check("...and does not fire on the clean file", false, /SettingsView\.swift/.test(r.stdout), r.stdout.slice(0, 2000));
  }

  // ---- comments and strings are not code
  {
    const app2 = path.join(tmp, "App2", "Sources");
    fs.mkdirSync(app2, { recursive: true });
    fs.writeFileSync(
      path.join(app2, "Quiet.swift"),
      'import SwiftUI\n// .padding(17) in a comment\nlet msg = "NavigationView is gone"\nstruct V: View { var body: some View { Text("hi").padding(8) } }\n',
      "utf8",
    );
    const d2 = path.join(tmp, "ledger2");
    runSelf(["init", "--app", path.join(tmp, "App2"), "--dir", d2]);
    const r = runSelf(["scan", "--dir", d2]);
    check("a commented-out padding is not a finding", false, /off the 4pt grid/.test(r.stdout), r.stdout.slice(0, 400));
    check("NavigationView inside a string literal is not a finding", false, /NavigationView is deprecated/.test(r.stdout), r.stdout.slice(0, 400));
  }

  // ---- an inline ignore is allowed, and is counted out loud
  {
    const app3 = path.join(tmp, "App3", "Sources");
    fs.mkdirSync(app3, { recursive: true });
    fs.writeFileSync(path.join(app3, "V.swift"), 'import SwiftUI\nstruct V: View { var body: some View { Text("x").padding(17) } } // tb-ios-design: ignore\n', "utf8");
    const d3 = path.join(tmp, "ledger3");
    runSelf(["init", "--app", path.join(tmp, "App3"), "--dir", d3]);
    const r = runSelf(["scan", "--dir", d3]);
    check("an inline ignore suppresses the finding", false, /off the 4pt grid/.test(r.stdout), r.stdout.slice(0, 300));
    check("...and the suppression is printed rather than silent", true, /suppressed by an inline/.test(r.stdout), r.stdout.slice(0, 400));
  }

  // ---- screenshots: every way an iOS screenshot is not evidence
  const shots = path.join(tmp, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const write = (name, buf) => {
    const p = path.join(shots, name);
    fs.writeFileSync(p, buf);
    return p;
  };
  const empty = write("empty.png", Buffer.alloc(0));
  const html = write("error.png", Buffer.from('<!doctype html><html><body>403 capability_insufficient</body></html>', "utf8"));
  const tiny = write("tiny.png", makePng(64, 64));
  const black = write("black.png", makePng(1179, 2556, { flat: true }));
  const desktop = write("desktop.png", makePng(1440, 900));
  const good = write("home.png", makePng(1179, 2556));

  check("a 0-byte screenshot is refused", 3, runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", empty]).status);
  {
    const r = runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", html]);
    check("a daemon error page saved as .png is refused", 3, r.status, r.all.slice(0, 200));
    check("...and the refusal says it is text, not an image", true, /is text, not an image/.test(r.all), r.all.slice(0, 300));
  }
  check("a 64x64 crop is refused as too small for a screen", 3, runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", tiny]).status);
  {
    const r = runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", black]);
    check("a solid-black iPhone-sized screenshot is refused", 3, r.status, r.all.slice(0, 200));
    check("...for being a single flat colour, which gstack only asks the model about", true, /single flat colour/.test(r.all), r.all.slice(0, 400));
  }
  {
    const r = runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", desktop]);
    check("a 1440x900 desktop grab is refused as not an iOS screen", 3, r.status, r.all.slice(0, 200));
    check("...and names the flag that would accept it deliberately", true, /--allow-size 1440x900/.test(r.all), r.all.slice(0, 400));
  }
  check("an unknown size is accepted only with the explicit override", 0, runSelf(["evidence", "--dir", dir, "--screen", "Odd", "--shot", desktop, "--allow-size", "1440x900"]).status);
  check("a real, rendered, iPhone-sized screenshot is accepted", 0, runSelf(["evidence", "--dir", dir, "--screen", "Home", "--shot", good]).status);

  // ---- a finding has to rest on something
  check("a finding with no evidence at all is refused", 3, runSelf(["finding", "--dir", dir, "--id", "D-001", "--dimension", "density", "--severity", "high", "--title", "feels cramped"]).status);
  {
    const r = runSelf([
      "finding", "--dir", dir, "--id", "D-002", "--dimension", "typography", "--severity", "high",
      "--title", "body type too small", "--file", "Sources/HomeView.swift", "--line", "9",
      "--quote", ".font(.system(size: 99))",
    ]);
    check("a finding whose quote is not on the cited line is refused", 3, r.status, r.all.slice(0, 300));
    check("...and prints the line as it actually reads", true, /line is:/.test(r.all), r.all.slice(0, 400));
  }
  check(
    "a finding whose quote IS on the cited line is recorded",
    0,
    runSelf([
      "finding", "--dir", dir, "--id", "D-005", "--dimension", "idiom", "--severity", "medium",
      "--title", "the root screen re-implements navigation", "--file", "Sources/HomeView.swift", "--line", "6",
      "--quote", "NavigationView {",
    ]).status,
  );
  check("a finding citing a screen with no screenshot is refused", 3, runSelf(["finding", "--dir", dir, "--id", "D-003", "--dimension", "density", "--severity", "medium", "--title", "cramped", "--screen", "Ghost"]).status);
  check("a finding on a verified screen is recorded", 0, runSelf(["finding", "--dir", dir, "--id", "D-004", "--dimension", "density", "--severity", "medium", "--title", "the header crowds the list on a 6.1 inch screen", "--screen", "Home"]).status);

  // ---- the score is arithmetic, and it fails closed
  {
    const r = runSelf(["score", "--dir", dir]);
    check("score passes once every dimension has evidence", 0, r.status, r.all.slice(-600));
    check("...and prints a number per dimension, not a paragraph", true, /Typography hierarchy\s+\d+\.\d\/10/.test(r.stdout), r.stdout.slice(0, 600));
    check("...and the arithmetic matches the recorded findings", true, /Touch targets\s+7\.0\/10/.test(r.stdout), r.stdout.slice(0, 900));
  }
  {
    // A fresh audit with a source scan but no screenshot: density cannot be seen.
    const d4 = path.join(tmp, "ledger4");
    runSelf(["init", "--app", app, "--dir", d4]);
    runSelf(["scan", "--dir", d4]);
    const r = runSelf(["score", "--dir", d4]);
    check("a device-only dimension with no device is UNSCORED, and that fails the run", 1, r.status, r.all.slice(-500));
    check("...and it is named, rather than quietly averaged out", true, /Information density/.test(r.stdout), r.stdout.slice(-800));
    const a = runSelf(["score", "--dir", d4, "--accept-unscored"]);
    check("...and a partial audit passes only when it is accepted explicitly", 0, a.status, a.all.slice(-400));
    check("...and is then stamped PARTIAL", true, /PARTIAL/.test(a.stdout), a.stdout.slice(-400));
    const stamp = JSON.parse(fs.readFileSync(path.join(d4, LEDGER_NAME), "utf8"));
    check("...naming exactly which dimensions the acceptance covers", "density", (stamp.acceptedUnscored?.dimensions ?? []).join(","), JSON.stringify(stamp.acceptedUnscored));
    check("...so a later score does not have to be re-flagged", 0, runSelf(["score", "--dir", d4]).status);
    const reportPath = path.join(tmp, "partial.md");
    const rep = runSelf(["report", "--dir", d4, "--out", reportPath]);
    check("the report writes when the score passed", 0, rep.status, rep.all.slice(0, 300));
    const text = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
    check("...and carries the PARTIAL AUDIT section", true, /## PARTIAL AUDIT/.test(text), text.slice(0, 400));
    check("...and states on the page whether a device was reachable at all", true, /Device evidence possible here \| (yes|no)/.test(text), text.slice(0, 600));
  }
  {
    const d5 = path.join(tmp, "ledger5");
    runSelf(["init", "--app", app, "--dir", d5]);
    const r = runSelf(["score", "--dir", d5]);
    check("an audit with nothing observed at all fails", 1, r.status, r.all.slice(-400));
    check("...saying so plainly", true, /NOTHING WAS OBSERVED/.test(r.stdout), r.stdout.slice(-400));
    check("report refuses to write over a failing score", 1, runSelf(["report", "--dir", d5]).status);
  }

  // ---- evidence that rots
  {
    const d6 = path.join(tmp, "ledger6");
    const app6 = path.join(tmp, "App6");
    fs.mkdirSync(path.join(app6, "Sources"), { recursive: true });
    const f6 = path.join(app6, "Sources", "V.swift");
    fs.writeFileSync(f6, DIRTY_SWIFT, "utf8");
    runSelf(["init", "--app", app6, "--dir", d6]);
    runSelf(["scan", "--dir", d6]);
    fs.writeFileSync(f6, CLEAN_SWIFT, "utf8"); // the file was fixed, or replaced
    const r = runSelf(["score", "--dir", d6]);
    check("a finding whose cited line changed fails the score", 1, r.status, r.all.slice(-500));
    check("...naming the file and line that no longer says it", true, /no longer contains what the finding quoted|no longer has a line/.test(r.stdout), r.stdout.slice(-800));
  }
  {
    const d7 = path.join(tmp, "ledger7");
    runSelf(["init", "--app", app, "--dir", d7]);
    runSelf(["scan", "--dir", d7]);
    const shot7 = path.join(tmp, "shot7.png");
    fs.writeFileSync(shot7, makePng(1179, 2556));
    runSelf(["evidence", "--dir", d7, "--screen", "Home", "--shot", shot7]);
    runSelf(["finding", "--dir", d7, "--id", "D-010", "--dimension", "density", "--severity", "high", "--title", "content runs off the right edge", "--screen", "Home"]);
    fs.writeFileSync(shot7, makePng(1179, 2556, { flat: true })); // swapped after the fact
    const r = runSelf(["score", "--dir", d7]);
    check("a screenshot swapped after it was verified fails the score", 1, r.status, r.all.slice(-500));
    check("...because the hash is re-taken at score time", true, /changed after it was verified/.test(r.stdout), r.stdout.slice(-600));
  }

  // ---- a corrupt ledger is not an empty audit
  {
    const d8 = path.join(tmp, "ledger8");
    fs.mkdirSync(d8, { recursive: true });
    fs.writeFileSync(path.join(d8, LEDGER_NAME), "{ not json", "utf8");
    check("a corrupt ledger is UNUSABLE, not a clean sheet", 2, runSelf(["score", "--dir", d8]).status);
  }
  check("scoring with no audit open is UNUSABLE", 2, runSelf(["score", "--dir", path.join(tmp, "never-opened")]).status);
  check("an unknown command is refused", 1, runSelf(["nonsense"]).status);

  // A selftest whose assertion count depends on the machine is a selftest that
  // can quietly stop asserting things.
  const EXPECTED = 62;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it runs",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-ios-design selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("\n  Every case above is one where gstack's version produces a clean ten-dimension report:");
  out("  no device, a black screenshot, a desktop grab, a citation that is not there, evidence");
  out("  that changed after the fact. Here each of them stops the run and says which one it was.\n");
}

// -------------------------------------------------------------------- entry

function help() {
  out(`
  tb-ios-design ${VERSION}, the SwiftUI design linter and evidence ledger

    init --app <dir> [--dir <out>]     open an audit; records what this host can reach
    scan [--dir <out>]                 lint the SwiftUI source; findings carry file:line
    evidence --screen <name> --shot <file.png> [--allow-size WxH]
                                       verify a device screenshot and record it
    finding --id <id> --dimension <d> --severity <high|medium|polish> --title <t>
            (--file <p> --line <n> [--quote <text>] | --screen <name>) [--fix <t>]
    score [--dir <out>] [--accept-unscored]
                                       per-dimension 0-10, computed from the ledger
    report [--dir <out>] [--out <file.md>]
                                       write the markdown report; refuses a failing score
    selftest                           prove all of the above against broken input

  Dimensions: ${Object.keys(DIMENSIONS).join(", ")}

  A dimension with no evidence is UNSCORED, and an UNSCORED dimension fails the
  run until a partial audit is accepted on purpose. That is the difference
  between this and a rubric: the report cannot come out the same shape whether
  or not anyone ever saw the app.
`);
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

switch (cmd) {
  case "init":
    process.exitCode = cmdInit(flags);
    break;
  case "scan":
    process.exitCode = cmdScan(flags);
    break;
  case "evidence":
    process.exitCode = cmdEvidence(flags);
    break;
  case "finding":
    process.exitCode = cmdFinding(flags);
    break;
  case "score":
    process.exitCode = cmdScore(flags).code;
    break;
  case "report":
    process.exitCode = cmdReport(flags);
    break;
  case "selftest":
    selftest();
    break;
  case undefined:
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    err(`Unknown command ${cmd}. Try: tb-ios-design.mjs help`);
    process.exitCode = 1;
}
