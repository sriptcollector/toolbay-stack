#!/usr/bin/env node
/**
 * tb-color.mjs — colour parsing and the WCAG 2.1 contrast arithmetic, once.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. The contrast ratio is the one number in this package
 * that is arithmetic rather than opinion, and it was written twice by hand:
 * once in design-consultation (which proposes the palette) and once in
 * design-review (which audits the page built from it). The two copies had
 * drifted in two places, and one of them decided pass/fail:
 *
 *   1. design-review's contrastRatio ROUNDED to two decimals before returning,
 *      and both engines then compared that rounded number to the threshold. So
 *      a real ratio of 4.4951 was rounded up to 4.50 and reported as passing
 *      WCAG AA. A gate that rounds INTO a pass is a fail-open, in the exact
 *      measurement this stack points at when it says it computes instead of
 *      guessing. Fixed here: the ratio is returned exact, the comparison uses
 *      the exact value, and rounding happens only where a human reads it.
 *
 *   2. the sRGB linearisation cut-off was 0.03928 in one copy and 0.04045 in
 *      the other. 0.03928 is the number written in the WCAG 2.1 definition of
 *      relative luminance, and both engines cite WCAG 2.1, so that is the one
 *      kept. (For 8-bit channels the two are equivalent — 0.03928*255 = 10.02
 *      and 0.04045*255 = 10.31, so every integer 0-255 lands on the same side
 *      of both — which is why this one had gone unnoticed.)
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory, so a skill importing across skill
 * boundaries breaks when only one of them is installed. Each skill carries the
 * file; tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-color.mjs contrast <fg> <bg> [px] [--bold]
 *   node tb-color.mjs selftest
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Two-decimal rounding, for display only. Never for a comparison. */
export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * `#abc`, `#aabbcc`, `aabbcc`, `rgb(1,2,3)`, `rgba(1,2,3,.5)` -> {r,g,b,src}.
 * Anything else is null, which callers must treat as "not measurable" rather
 * than as a colour, because a palette entry nobody can measure is exactly the
 * entry a report would otherwise silently score as fine.
 */
export function parseColor(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, "");
  let m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return { r, g, b, src: s };
  }
  m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, src: s };
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].every((v) => v >= 0 && v <= 255)) return { r, g, b, src: s };
  }
  return null;
}

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2.1 relative luminance. The 0.03928 cut-off is the one in the spec. */
export function relativeLuminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.1 contrast ratio, EXACT. Round it for display with round2; never
 * round it before comparing it to a threshold.
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG "large text": >= 24px, or >= 18.66px when bold. */
export function isLargeText(sizePx, bold) {
  const px = Number(sizePx);
  if (!Number.isFinite(px)) return false;
  return bold ? px >= 18.66 : px >= 24;
}

/**
 * Grade an exact ratio against the AA/AAA thresholds for this text size.
 *
 * `ratio` is the rounded value, because it is the one that gets printed.
 * `exact` is what the pass/fail booleans were computed from, so a report can
 * always show its own working.
 */
export function contrastVerdict(exact, sizePx, bold) {
  const large = isLargeText(sizePx, bold);
  const aa = large ? 3.0 : 4.5;
  const aaa = large ? 4.5 : 7.0;
  return {
    ratio: round2(exact),
    exact,
    large,
    thresholdAA: aa,
    thresholdAAA: aaa,
    passesAA: exact >= aa,
    passesAAA: exact >= aaa,
  };
}

/** Does an exact ratio meet a threshold. Exists so no caller rounds first. */
export function meetsRatio(exact, min) {
  return exact >= min;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const black = parseColor("#000000");
  const white = parseColor("#ffffff");

  check("black on white is 21:1", 21, round2(contrastRatio(black, white)));
  check("white on white is 1:1", 1, round2(contrastRatio(white, white)));
  check("the ratio is symmetric", true, contrastRatio(black, white) === contrastRatio(white, black));

  check("#abc expands to #aabbcc", "#aabbcc", toHex(parseColor("#abc")));
  check("a bare hex with no # parses", "#aabbcc", toHex(parseColor("aabbcc")));
  check("rgb() parses", "#010203", toHex(parseColor("rgb(1, 2, 3)")));
  check("rgba() parses and the alpha is ignored", "#010203", toHex(parseColor("rgba(1,2,3,0.5)")));
  check("a channel over 255 is not a colour", "null", String(parseColor("rgb(256,0,0)")));
  check("a name this engine cannot measure is null", "null", String(parseColor("rebeccapurple")));
  check("undefined is null, not a crash", "null", String(parseColor(undefined)));

  // The regression this module exists for. #767676 on white measures
  // 4.5382..., #777777 on white measures 4.4781... Neither is the trap; the
  // trap is any pair whose exact ratio is under 4.5 and whose ROUNDED ratio is
  // 4.5, which the old code passed. Assert on the arithmetic directly.
  const justUnder = 4.4951;
  check("a ratio that only reaches AA after rounding does NOT pass", false, contrastVerdict(justUnder, 16, false).passesAA);
  check("...and its printed ratio is still the rounded 4.5", 4.5, contrastVerdict(justUnder, 16, false).ratio);
  check("...and the exact value it was judged on is kept", justUnder, contrastVerdict(justUnder, 16, false).exact);
  check("a ratio exactly on the threshold passes", true, contrastVerdict(4.5, 16, false).passesAA);
  check("meetsRatio does not round either", false, meetsRatio(justUnder, 4.5));

  check("18px normal text is not large", false, isLargeText(18, false));
  check("24px normal text is large", true, isLargeText(24, false));
  check("19px bold text is large", true, isLargeText(19, true));
  check("a size that is not a number is not large", false, isLargeText("big", false));
  check("large text only needs 3:1 for AA", true, contrastVerdict(3.2, 24, false).passesAA);
  check("...and the same ratio fails AA at body size", false, contrastVerdict(3.2, 16, false).passesAA);
  check("AAA is stricter than AA", false, contrastVerdict(5, 16, false).passesAAA);

  // WCAG 2.1 worked examples, to catch a luminance formula that drifts.
  check("#767676 on white measures 4.54", 4.54, round2(contrastRatio(parseColor("#767676"), white)));
  check("#777777 on white measures 4.48", 4.48, round2(contrastRatio(parseColor("#777777"), white)));

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-color selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  One contrast formula, so the palette that was approved and the page that\n  was audited are graded by the same arithmetic.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, fgRaw, bgRaw, pxRaw] = process.argv.slice(2);
  if (cmd === "selftest") selftest();
  else if (cmd === "contrast") {
    const fg = parseColor(fgRaw);
    const bg = parseColor(bgRaw);
    if (!fg || !bg) {
      process.stdout.write(`\n  not a measurable colour: ${!fg ? fgRaw : bgRaw}\n\n`);
      process.exitCode = 1;
    } else {
      const v = contrastVerdict(contrastRatio(fg, bg), pxRaw ?? 16, process.argv.includes("--bold"));
      process.stdout.write(`\n  ${toHex(fg)} on ${toHex(bg)}  ${v.ratio}:1  AA ${v.passesAA ? "pass" : "FAIL"} (needs ${v.thresholdAA}:1)\n\n`);
      if (!v.passesAA) process.exitCode = 1;
    }
  } else {
    process.stdout.write("\n  usage: tb-color.mjs contrast <fg> <bg> [px] [--bold] | selftest\n\n");
    process.exitCode = 1;
  }
}
