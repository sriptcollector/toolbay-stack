#!/usr/bin/env node
/**
 * tb-designsys.mjs: the Toolbay Stack design-system engine. It takes the design
 * system a consultation proposed, refuses it if it cannot actually be rendered,
 * and then renders it into a preview page that cannot lie about what it showed.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /design-consultation
 * command, the consultant posture, the phase order, the aesthetic-direction and
 * decoration/layout/colour/motion vocabularies, the font recommendation lists,
 * the font blacklist and the overused-font list, the AI-slop anti-pattern list,
 * the anti-convergence directive, the coherence-validation nudges, the preview
 * page requirements, and the DESIGN.md section layout) comes from
 * `design-consultation` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS EXISTS AS CODE RATHER THAN AS MORE PROSE
 *
 * gstack's Phase 5 Path B tells the agent to write a preview page that "loads
 * proposed fonts from Google Fonts (or Bunny Fonts) via <link> tags". Its own
 * recommendation list, in the same skill, is:
 *
 *   Display/Hero: Satoshi, General Sans, Instrument Serif, Fraunces,
 *                 Clash Grotesk, Cabinet Grotesk
 *   Code:         JetBrains Mono, Fira Code, Berkeley Mono, Geist Mono
 *
 * Measured against the real Google Fonts CSS2 API on 2026-08-13:
 *
 *   400  Satoshi            400  General Sans      400  Clash Grotesk
 *   400  Cabinet Grotesk    400  Berkeley Mono
 *   200  Instrument Serif   200  Fraunces          200  JetBrains Mono
 *   200  Geist Mono         200  Instrument Sans   200  Geist
 *
 * Four of the six recommended display faces and one of the four code faces
 * return HTTP 400 from the loader the skill tells you to use. A <link> to a 400
 * is not an error the browser shows anyone: the stylesheet is simply absent, the
 * CSS falls through to the next family in the stack, and the page renders in
 * Times New Roman or whatever the system default is. The user then looks at a
 * page that says "Display: Satoshi" in a face that is not Satoshi, says yes, and
 * the approved typography of the product is a font nobody in the room ever saw.
 *
 * Silent fallback is the single most expensive failure available to a skill
 * whose entire job is "show them what it will look like", and gstack has no
 * check for it anywhere. So:
 *
 *   1. FAIL CLOSED ON THE FONT. Every declared family is resolved to a provider
 *      that can actually serve it before anything is generated. A family that
 *      resolves to nothing, or that is only sold commercially, is refused, not
 *      quietly linked. An unrecognised family is UNVERIFIED and refused too:
 *      "I have never heard of this font" must not render as a preview.
 *   2. THE ARTIFACT ACCUSES ITSELF. The generated page asserts, in the browser
 *      at runtime via document.fonts.check(), that every declared family really
 *      loaded, and paints a loud banner naming the ones that did not. A preview
 *      that fell back is a preview that says so on its own face.
 *   3. THE NUMBERS ARE COMPUTED, NOT VIBED. Every colour pair is measured with
 *      WCAG 2.1 relative luminance at generate time, in light AND dark mode, and
 *      the ratios are printed on the page next to the swatches. gstack proposes
 *      a palette and a dark-mode strategy and checks neither.
 *   4. NO /tmp. gstack writes the preview to /tmp/design-consultation-preview-*.html
 *      and opens it with `open`. On Windows /tmp is C:\tmp to Node and
 *      %LOCALAPPDATA%\Temp to Git Bash, and `open` is not a command at all, so
 *      the file lands somewhere the next line cannot find and the browser never
 *      opens. Both are refused here, with the real path named.
 *
 * Exit codes: 0 pass, 1 checks failed, 2 arguments or spec unusable, 3 refused.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseColor, contrastRatio, meetsRatio, relativeLuminance, round2, toHex } from "./tb-color.mjs";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS } from "./tb-outdir.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;

// ------------------------------------------------------------------ registry
//
// Provider truth for every family this engine will emit a <link> for. The
// classification is not a guess: `fonts --live` re-derives it from the real
// provider APIs and the selftest asserts the two agree whenever the network is
// reachable, so a family that migrates between providers shows up as a failing
// assertion rather than as a preview page that renders in Times New Roman.
//
//   google      served by fonts.googleapis.com/css2
//   fontshare   served by api.fontshare.com/v2/css (free, Indian Type Foundry)
//   commercial  a real typeface that no free webfont host serves. Refused for a
//               preview unless the spec says where the licensed files live.
//   system      not a webfont at all.

const FONT_REGISTRY = {
  // --- Google Fonts: display / text
  "Instrument Serif": { provider: "google" },
  "Instrument Sans": { provider: "google" },
  Fraunces: { provider: "google" },
  "DM Sans": { provider: "google" },
  "DM Serif Display": { provider: "google" },
  "Source Sans 3": { provider: "google" },
  "Source Serif 4": { provider: "google" },
  "Plus Jakarta Sans": { provider: "google" },
  Outfit: { provider: "google" },
  Geist: { provider: "google" },
  "Geist Mono": { provider: "google" },
  Sora: { provider: "google" },
  Manrope: { provider: "google" },
  Figtree: { provider: "google" },
  Archivo: { provider: "google" },
  "Archivo Expanded": { provider: "google" },
  "Bricolage Grotesque": { provider: "google" },
  Syne: { provider: "google" },
  Unbounded: { provider: "google" },
  "Work Sans": { provider: "google" },
  Rubik: { provider: "google" },
  Karla: { provider: "google" },
  "Public Sans": { provider: "google" },
  Epilogue: { provider: "google" },
  Chivo: { provider: "google" },
  Lexend: { provider: "google" },
  Urbanist: { provider: "google" },
  Onest: { provider: "google" },
  Mulish: { provider: "google" },
  Asap: { provider: "google" },
  Overpass: { provider: "google" },
  Cabin: { provider: "google" },
  "Josefin Sans": { provider: "google" },
  Quicksand: { provider: "google" },
  "Playfair Display": { provider: "google" },
  "Libre Baskerville": { provider: "google" },
  "Libre Franklin": { provider: "google" },
  Lora: { provider: "google" },
  Merriweather: { provider: "google" },
  Newsreader: { provider: "google" },
  Spectral: { provider: "google" },
  "Crimson Pro": { provider: "google" },
  "EB Garamond": { provider: "google" },
  "Cormorant Garamond": { provider: "google" },
  Literata: { provider: "google" },
  Vollkorn: { provider: "google" },
  Bitter: { provider: "google" },
  "Bodoni Moda": { provider: "google" },
  "Big Shoulders Display": { provider: "google" },
  "Bebas Neue": { provider: "google" },
  Anton: { provider: "google" },
  Oswald: { provider: "google" },
  Barlow: { provider: "google" },
  "Barlow Condensed": { provider: "google" },
  "IBM Plex Sans": { provider: "google" },
  "IBM Plex Serif": { provider: "google" },
  "IBM Plex Mono": { provider: "google" },
  "Red Hat Display": { provider: "google" },
  "Red Hat Text": { provider: "google" },
  "Red Hat Mono": { provider: "google" },
  "Noto Sans": { provider: "google" },
  "Noto Serif": { provider: "google" },
  Nunito: { provider: "google" },
  "Nunito Sans": { provider: "google" },
  // --- Google Fonts: mono / code
  "JetBrains Mono": { provider: "google" },
  "Fira Code": { provider: "google" },
  "Fira Sans": { provider: "google" },
  "Roboto Mono": { provider: "google" },
  "Source Code Pro": { provider: "google" },
  "Space Mono": { provider: "google" },
  Inconsolata: { provider: "google" },
  "Ubuntu Mono": { provider: "google" },
  "Martian Mono": { provider: "google" },
  "Azeret Mono": { provider: "google" },
  // --- Google Fonts: on the overused list, but real
  Inter: { provider: "google" },
  Roboto: { provider: "google" },
  "Open Sans": { provider: "google" },
  Lato: { provider: "google" },
  Montserrat: { provider: "google" },
  Poppins: { provider: "google" },
  "Space Grotesk": { provider: "google" },
  Raleway: { provider: "google" },
  Ubuntu: { provider: "google" },

  // --- Fontshare. gstack recommends these as headline faces and tells the agent
  // to load them from Google Fonts, where they return HTTP 400.
  Satoshi: { provider: "fontshare", slug: "satoshi" },
  "General Sans": { provider: "fontshare", slug: "general-sans" },
  "Clash Grotesk": { provider: "fontshare", slug: "clash-grotesk" },
  "Clash Display": { provider: "fontshare", slug: "clash-display" },
  "Cabinet Grotesk": { provider: "fontshare", slug: "cabinet-grotesk" },
  Switzer: { provider: "fontshare", slug: "switzer" },
  Chillax: { provider: "fontshare", slug: "chillax" },
  Ranade: { provider: "fontshare", slug: "ranade" },
  Sentient: { provider: "fontshare", slug: "sentient" },
  Erode: { provider: "fontshare", slug: "erode" },
  Zodiak: { provider: "fontshare", slug: "zodiak" },
  Supreme: { provider: "fontshare", slug: "supreme" },
  Melodrama: { provider: "fontshare", slug: "melodrama" },
  Gambetta: { provider: "fontshare", slug: "gambetta" },
  Boska: { provider: "fontshare", slug: "boska" },
  Author: { provider: "fontshare", slug: "author" },
  Synonym: { provider: "fontshare", slug: "synonym" },
  Panchang: { provider: "fontshare", slug: "panchang" },
  "Bespoke Serif": { provider: "fontshare", slug: "bespoke-serif" },
  Excon: { provider: "fontshare", slug: "excon" },

  // --- Commercial. Real, excellent, and not servable from any free CDN.
  "Berkeley Mono": { provider: "commercial", vendor: "Berkeley Graphics" },
  "Söhne": { provider: "commercial", vendor: "Klim" },
  Sohne: { provider: "commercial", vendor: "Klim" },
  "Untitled Sans": { provider: "commercial", vendor: "Klim" },
  "Founders Grotesk": { provider: "commercial", vendor: "Klim" },
  "GT America": { provider: "commercial", vendor: "Grilli Type" },
  "Neue Haas Grotesk": { provider: "commercial", vendor: "Monotype" },
  "Helvetica Neue": { provider: "commercial", vendor: "Monotype" },
  Circular: { provider: "commercial", vendor: "Lineto" },
  Graphik: { provider: "commercial", vendor: "Commercial Type" },
  "PP Neue Montreal": { provider: "commercial", vendor: "Pangram Pangram" },
  "Monument Extended": { provider: "commercial", vendor: "Pangram Pangram" },
  "ABC Diatype": { provider: "commercial", vendor: "Dinamo" },
  Aeonik: { provider: "commercial", vendor: "CoType" },
  "Suisse Int'l": { provider: "commercial", vendor: "Swiss Typefaces" },
  "SF Pro": { provider: "commercial", vendor: "Apple" },
  "SF Mono": { provider: "commercial", vendor: "Apple" },

  // --- Not webfonts at all.
  "system-ui": { provider: "system" },
  "-apple-system": { provider: "system" },
  "BlinkMacSystemFont": { provider: "system" },
  "sans-serif": { provider: "system" },
  "serif": { provider: "system" },
  "monospace": { provider: "system" },
  Arial: { provider: "system" },
  Helvetica: { provider: "system" },
  "Times New Roman": { provider: "system" },
  Georgia: { provider: "system" },
  "Courier New": { provider: "system" },
  Verdana: { provider: "system" },
  Tahoma: { provider: "system" },
  "Segoe UI": { provider: "system" },
};

// gstack's lists, carried over verbatim. They are good lists; the change here is
// that they are enforced by the engine instead of being a paragraph the model is
// asked to remember four phases later.
const BLACKLIST = [
  "Papyrus", "Comic Sans", "Comic Sans MS", "Lobster", "Impact", "Jokerman",
  "Bleeding Cowboys", "Permanent Marker", "Bradley Hand", "Brush Script",
  "Brush Script MT", "Hobo", "Trajan", "Trajan Pro", "Raleway", "Clash Display",
];
const BLACKLIST_BODY_ONLY = ["Courier New"];
const OVERUSED = [
  "Inter", "Roboto", "Arial", "Helvetica", "Open Sans", "Lato", "Montserrat",
  "Poppins", "Space Grotesk",
];

const TEXT_ROLES = ["display", "body", "ui", "data", "code"];
const DEFAULT_WEIGHTS = {
  display: [400, 700],
  body: [400, 500, 700],
  ui: [400, 500, 600],
  data: [400, 500],
  code: [400, 500],
};

// -------------------------------------------------------------------- colour

function toHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s, l };
}

// --------------------------------------------------------------------- paths
//
// Same rule the rest of Toolbay Stack uses: a path that means two different
// directories depending on which shell expands it is not a path, it is a
// coin flip, and the coin is flipped between the line that writes the preview
// and the line that opens it.


function defaultDesignDir() {
  return process.env.TOOLBAY_DESIGNSYS_DIR || path.join(os.homedir(), ".toolbay-stack", "design");
}

function resolvePathArg(raw, { fallback } = {}) {
  if (!raw) return { ok: true, p: path.resolve(fallback) };
  const s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (isWindows && AMBIGUOUS_ON_WINDOWS.test(s)) {
    const viaShell = path.join(os.tmpdir(), s.replace(/^\/(tmp|var|usr|home|opt|etc|mnt|dev|proc)\/?/, ""));
    return {
      ok: false,
      error:
        `"${s}" is two different locations on this machine. Node resolves it to ${path.resolve(s)}; ` +
        `Git Bash resolves it under ${viaShell}. The preview would be written to one and opened from the ` +
        `other, which is exactly how a preview gets approved that nobody ever saw. ` +
        `Pass a real path, or omit the flag to use ${defaultDesignDir()}.`,
    };
  }
  const msys = fromMsysPath(s);
  return { ok: true, p: path.resolve(looksAbsolute(msys) ? msys : path.join(process.cwd(), msys)) };
}

// ---------------------------------------------------------------------- spec

function readSpec(file) {
  if (!file) return { error: `no --spec given. The engine grades a design system it can read, not one it is told about.` };
  const r = resolvePathArg(file, { fallback: file });
  if (!r.ok) return { error: r.error };
  if (!fs.existsSync(r.p)) return { error: `no spec at ${r.p}. Run "tb-designsys.mjs init" to scaffold one.` };
  let raw;
  try {
    raw = fs.readFileSync(r.p, "utf8");
  } catch (e) {
    return { error: `${r.p} could not be read (${e.code || e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { error: `${r.p} is not valid JSON (${e.message}). Nothing can be verified about a spec that will not parse.` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { error: `${r.p} does not contain a JSON object` };
  }
  return { spec: obj, file: r.p };
}

function specFingerprint(spec) {
  const t = spec.typography || {};
  const a = spec.aesthetic || {};
  const bg = parseColor(spec.color?.background);
  const dark = bg ? relativeLuminance(bg) < 0.2 : null;
  const parts = [
    String(t.display || "").toLowerCase(),
    String(t.body || "").toLowerCase(),
    String(a.direction || "").toLowerCase(),
    String(a.decoration || "").toLowerCase(),
    dark === null ? "?" : dark ? "dark" : "light",
  ];
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// --------------------------------------------------------------------- fonts

function normaliseFamily(name) {
  return String(name || "").trim().replace(/^["']|["']$/g, "");
}

function registryLookup(family) {
  const f = normaliseFamily(family);
  if (!f) return null;
  if (FONT_REGISTRY[f]) return { family: f, ...FONT_REGISTRY[f] };
  const lower = f.toLowerCase();
  for (const [k, v] of Object.entries(FONT_REGISTRY)) {
    if (k.toLowerCase() === lower) return { family: k, ...v };
  }
  return null;
}

function googleUrl(family, weights) {
  const w = [...new Set(weights)].sort((a, b) => a - b).join(";");
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${w}&display=swap`;
}

function fontshareUrl(slug, weights) {
  const w = [...new Set(weights)].sort((a, b) => a - b).join(",");
  return `https://api.fontshare.com/v2/css?f%5B%5D=${slug}@${w}&display=swap`;
}

/**
 * Resolve every declared family to something that can actually serve it.
 * Anything short of that is an error, never a warning: a warning here renders as
 * a beautiful page in the wrong typeface, which is indistinguishable from success.
 */
function resolveFonts(spec) {
  const typo = spec.typography || {};
  const selfHost = spec.typography?.selfHosted || {};
  const out = [];
  const seen = new Map();
  for (const role of TEXT_ROLES) {
    const raw = typo[role];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const v = String(raw).trim();
    if (/^same as (body|display|ui)$/i.test(v)) {
      out.push({ role, family: null, inherits: v.replace(/^same as /i, "").toLowerCase(), status: "inherit" });
      continue;
    }
    const family = normaliseFamily(v);
    const hit = registryLookup(family);
    const weights = Array.isArray(typo.weights?.[role]) ? typo.weights[role].map(Number) : DEFAULT_WEIGHTS[role];
    const entry = { role, family, weights, status: "?", provider: null, url: null, note: "" };
    if (!hit) {
      entry.status = "UNVERIFIED";
      entry.note =
        `"${family}" is not in the provider registry, so the engine cannot say who serves it. ` +
        `An unrecognised family linked from a guessed CDN is the exact failure this engine exists to stop: ` +
        `the stylesheet 404s, the page silently falls back, and the preview shows a font nobody chose. ` +
        `Use a registered family, or declare typography.selfHosted["${family}"] with a stylesheet URL you have verified.`;
    } else if (selfHost[hit.family]) {
      entry.status = "OK";
      entry.provider = "self-hosted";
      entry.url = String(selfHost[hit.family]);
      entry.note = `self-hosted stylesheet declared in the spec`;
    } else if (hit.provider === "google") {
      entry.status = "OK";
      entry.provider = "google";
      entry.url = googleUrl(hit.family, weights);
    } else if (hit.provider === "fontshare") {
      entry.status = "OK";
      entry.provider = "fontshare";
      entry.url = fontshareUrl(hit.slug, weights);
      entry.note = `Fontshare, not Google Fonts. fonts.googleapis.com returns HTTP 400 for "${hit.family}".`;
    } else if (hit.provider === "commercial") {
      entry.status = "COMMERCIAL";
      entry.provider = "commercial";
      entry.note =
        `"${hit.family}" is a licensed typeface from ${hit.vendor || "its foundry"} and no free webfont host serves it. ` +
        `A <link> to Google Fonts for it returns HTTP 400 and the page renders in the fallback. ` +
        `Either license and self-host it (declare typography.selfHosted["${hit.family}"]) or choose another face.`;
    } else if (hit.provider === "system") {
      entry.status = "SYSTEM";
      entry.provider = "system";
      entry.note = `"${hit.family}" is a system stack, not a typeface choice.`;
    }
    if (selfHost[family] && entry.status === "UNVERIFIED") {
      entry.status = "OK";
      entry.provider = "self-hosted";
      entry.url = String(selfHost[family]);
      entry.note = `self-hosted stylesheet declared in the spec`;
    }
    if (entry.url) {
      if (seen.has(entry.url)) entry.duplicateOf = seen.get(entry.url);
      else seen.set(entry.url, role);
    }
    out.push(entry);
  }
  return out;
}

async function liveProbe(url) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36";
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    const body = res.ok ? await res.text() : "";
    return { ok: true, status: res.status, hasFontFace: /@font-face/.test(body), bytes: body.length };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// --------------------------------------------------------------------- lint

const CONTRAST_PAIRS = [
  { fg: "text", bg: "background", min: 4.5, why: "body text on the page background (WCAG AA, normal text)" },
  { fg: "muted", bg: "background", min: 4.5, why: "muted/secondary text is still text, and AA does not have a 'less important' tier" },
  { fg: "text", bg: "surface", min: 4.5, why: "text on cards and panels" },
  { fg: "onPrimary", bg: "primary", min: 4.5, why: "the label inside the primary button" },
  // WCAG 1.4.11 wants 3.0 for a boundary that is the ONLY thing identifying a
  // control, which a hairline separator usually is not. So this pair is graded
  // in two bands: below 1.15 the border is invisible and that is a real defect;
  // between 1.15 and 3.0 it is a decorative hairline and gets a note, not a
  // block. Grading it as one hard floor would either wave through invisible
  // borders or refuse every well-made subtle design system, and both of those
  // are worse than saying which band you are in.
  { fg: "border", bg: "background", min: 1.15, soft: 3.0, why: "a border you cannot see at all is not a border; WCAG 1.4.11 wants 3.0 when the border is the only thing identifying a control" },
  { fg: "primary", bg: "background", min: 3.0, why: "the accent has to be distinguishable from the page (WCAG 1.4.11 non-text)" },
  { fg: "success", bg: "background", min: 3.0, why: "semantic colour used as a non-text indicator" },
  { fg: "warning", bg: "background", min: 3.0, why: "semantic colour used as a non-text indicator" },
  { fg: "error", bg: "background", min: 3.0, why: "semantic colour used as a non-text indicator" },
  { fg: "info", bg: "background", min: 3.0, why: "semantic colour used as a non-text indicator" },
];

const REQUIRED_COLORS = ["background", "surface", "text", "muted", "primary", "onPrimary", "border"];

function lintSpec(spec, opts = {}) {
  const checks = [];
  const add = (id, ok, detail, { fatal = true, overridden = false } = {}) =>
    checks.push({ id, ok, detail, fatal: ok ? false : fatal, overridden });

  // --- product
  const name = String(spec.product?.name || "").trim();
  add(
    "product.name",
    name.length > 0 && !/^lorem/i.test(name),
    name ? `product name "${name}"` : `spec.product.name is empty. The preview would say "Lorem Ipsum", which is the thing the preview exists to avoid.`,
  );
  const type = String(spec.product?.type || "").trim().toLowerCase();
  const KNOWN_TYPES = ["dashboard", "web app", "webapp", "marketing", "marketing site", "editorial", "internal tool", "settings", "auth", "onboarding"];
  add(
    "product.type",
    KNOWN_TYPES.includes(type),
    KNOWN_TYPES.includes(type) ? `product type "${type}"` : `spec.product.type "${type || "(empty)"}" is not one of: ${KNOWN_TYPES.join(", ")}. The mockup section is chosen from it.`,
  );

  // --- fonts
  const fonts = resolveFonts(spec);
  const roleOf = Object.fromEntries(fonts.map((f) => [f.role, f]));
  add(
    "typography.roles",
    Boolean(roleOf.display && roleOf.body),
    roleOf.display && roleOf.body
      ? `display + body declared`
      : `typography needs at least "display" and "body". Got: ${fonts.map((f) => f.role).join(", ") || "nothing"}.`,
  );

  for (const f of fonts) {
    if (f.status === "inherit") continue;
    add(
      `font.${f.role}.loadable`,
      f.status === "OK",
      f.status === "OK"
        ? `${f.role}: ${f.family} via ${f.provider}${f.note ? ` (${f.note})` : ""}`
        : `${f.role}: ${f.note}`,
    );
    if (f.status === "OK" && f.family) {
      const bl = BLACKLIST.some((b) => b.toLowerCase() === f.family.toLowerCase());
      add(`font.${f.role}.blacklist`, !bl, bl ? `${f.family} is on the never-recommend list.` : `${f.family} is not blacklisted`);
      if (f.role === "body") {
        const blb = BLACKLIST_BODY_ONLY.some((b) => b.toLowerCase() === f.family.toLowerCase());
        add(`font.body.blacklist-body`, !blb, blb ? `${f.family} is blacklisted for body text specifically.` : `${f.family} is allowed for body`);
      }
      if (f.role === "display" || f.role === "body") {
        const over = OVERUSED.some((b) => b.toLowerCase() === f.family.toLowerCase());
        const acked = (spec.typography?.acknowledgeOverused || []).some((a) => String(a).toLowerCase() === f.family.toLowerCase());
        add(
          `font.${f.role}.overused`,
          !over || acked,
          !over
            ? `${f.family} is not on the overused list`
            : acked
              ? `${f.family} is overused but the spec records that it was asked for by name`
              : `${f.family} is on the overused list, so it is only allowed when the user asks for it by name. ` +
                `Record that in typography.acknowledgeOverused, or pick something else. ` +
                `(Space Grotesk counts: every AI design tool converges on it as "the safe alternative to Inter", which is the same trap.)`,
        );
      }
    }
  }

  // --- slop: a system stack in a display or body role
  for (const role of ["display", "body"]) {
    const f = roleOf[role];
    if (f && f.status === "SYSTEM") {
      add(`slop.${role}.system-stack`, false, `${f.family} in the ${role} role is the "I gave up on typography" signal.`);
    }
  }

  // --- colour
  const modes = [{ key: "light", colors: spec.color || {} }];
  if (spec.color?.darkMode && typeof spec.color.darkMode === "object") {
    modes.push({ key: "dark", colors: { ...spec.color, ...spec.color.darkMode } });
  }

  for (const missing of REQUIRED_COLORS) {
    const present = spec.color && spec.color[missing] !== undefined && String(spec.color[missing]).trim() !== "";
    add(`color.${missing}.present`, Boolean(present), present ? `color.${missing} = ${spec.color[missing]}` : `color.${missing} is missing`);
  }

  for (const mode of modes) {
    for (const [k, v] of Object.entries(mode.colors)) {
      if (k === "darkMode" || k === "approach") continue;
      if (v === undefined || v === null || String(v).trim() === "") continue;
      const c = parseColor(v);
      add(`color.${mode.key}.${k}.parses`, Boolean(c), c ? `${k} = ${toHex(c)}` : `${mode.key} colour "${k}" = ${JSON.stringify(v)} is not a colour this engine can measure`);
    }
    for (const pair of CONTRAST_PAIRS) {
      const fg = parseColor(mode.colors[pair.fg]);
      const bg = parseColor(mode.colors[pair.bg]);
      if (!fg || !bg) continue;
      const exact = contrastRatio(fg, bg);
      const ratio = round2(exact);
      const soft = pair.soft && meetsRatio(exact, pair.min) && !meetsRatio(exact, pair.soft);
      add(
        `contrast.${mode.key}.${pair.fg}-on-${pair.bg}`,
        meetsRatio(exact, pair.min) && !soft,
        soft
          ? `${mode.key}: ${pair.fg} ${toHex(fg)} on ${pair.bg} ${toHex(bg)} = ${ratio}:1 — a decorative hairline. Fine for a separator, not enough if this border is the only thing marking a control (WCAG 1.4.11 wants ${pair.soft}:1 there).`
          : `${mode.key}: ${pair.fg} ${toHex(fg)} on ${pair.bg} ${toHex(bg)} = ${ratio}:1 (needs ${pair.min}:1 — ${pair.why})`,
        { fatal: !soft },
      );
    }
  }

  // --- slop: purple/violet accent
  const primary = parseColor(spec.color?.primary);
  if (primary) {
    const { h, s, l } = toHsl(primary);
    const purple = h >= 252 && h <= 300 && s > 0.35 && l > 0.3 && l < 0.8;
    const allowed = opts.allowSlop === true;
    add(
      "slop.purple-accent",
      !purple || allowed,
      !purple
        ? `primary ${toHex(primary)} (hue ${h}) is not the default AI purple`
        : allowed
          ? `primary ${toHex(primary)} (hue ${h}) is in the AI-default violet band — allowed by --allow-slop, and that override is recorded`
          : `primary ${toHex(primary)} is hue ${h}, saturation ${round2(s)}: the violet every AI design tool reaches for first. ` +
            `Pick an accent that is a decision rather than a default, or pass --allow-slop if it genuinely is the right colour.`,
      { overridden: purple && allowed },
    );
  }

  // --- radius scale
  const radius = spec.radius || {};
  const scale = ["sm", "md", "lg"].map((k) => Number(radius[k])).filter((n) => Number.isFinite(n));
  add("radius.scale.present", scale.length === 3, scale.length === 3 ? `radius sm/md/lg = ${scale.join("/")}` : `radius needs sm, md and lg (numbers, px). Got ${JSON.stringify(radius)}.`);
  if (scale.length === 3) {
    const hierarchical = scale[0] < scale[1] && scale[1] < scale[2];
    const uniformBubble = scale[0] === scale[1] && scale[1] === scale[2] && scale[0] >= 12;
    add("radius.hierarchical", hierarchical, hierarchical ? `radius scale is hierarchical` : `radius sm/md/lg = ${scale.join("/")} is not a scale, it is one number three times. Uniform bubbly radius on everything is on the slop list.`);
    if (!hierarchical && uniformBubble) add("radius.bubble", false, `every element at ${scale[0]}px radius is the bubble-everything look.`);
  }

  // --- spacing
  const base = Number(spec.spacing?.base);
  add("spacing.base", base === 4 || base === 8, base === 4 || base === 8 ? `spacing base ${base}px` : `spacing.base must be 4 or 8, got ${JSON.stringify(spec.spacing?.base)}`);
  const sscale = Array.isArray(spec.spacing?.scale) ? spec.spacing.scale.map(Number) : null;
  add("spacing.scale.present", Boolean(sscale && sscale.length >= 5), sscale && sscale.length >= 5 ? `spacing scale has ${sscale.length} steps` : `spacing.scale must be an array of at least 5 numbers`);
  if (sscale && sscale.length >= 5 && (base === 4 || base === 8)) {
    // A half-step (4 on an 8px base) is normal and useful; a 13 is a typo that
    // will be copied into six components before anyone notices.
    const half = base / 2;
    const offGrid = sscale.filter((n) => !Number.isFinite(n) || n % half !== 0);
    add(
      "spacing.scale.on-grid",
      offGrid.length === 0,
      offGrid.length === 0 ? `every step is a multiple of ${half} (base ${base}, half-steps allowed)` : `steps off the ${base}px grid, and not half-steps either: ${offGrid.join(", ")}`,
    );
    const halfSteps = sscale.filter((n) => n % base !== 0);
    if (halfSteps.length > 2) {
      add("spacing.scale.half-steps", false, `${halfSteps.length} of ${sscale.length} steps are half-steps (${halfSteps.join(", ")}). That is a ${half}px grid wearing a ${base}px label.`, { fatal: false });
    }
    const rising = sscale.every((n, i) => i === 0 || n > sscale[i - 1]);
    add("spacing.scale.rising", rising, rising ? `scale is strictly increasing` : `spacing scale must strictly increase: ${sscale.join(", ")}`);
  }

  // --- motion
  const dur = spec.motion?.durations || {};
  const order = ["micro", "short", "medium", "long"];
  const vals = order.map((k) => Number(dur[k]));
  if (vals.every((v) => Number.isFinite(v))) {
    const rising = vals.every((n, i) => i === 0 || n > vals[i - 1]);
    add("motion.durations.rising", rising, rising ? `durations ${vals.join(" < ")}ms` : `motion durations must increase micro < short < medium < long, got ${vals.join(", ")}`);
    add("motion.durations.sane", vals[3] <= 900, vals[3] <= 900 ? `longest transition ${vals[3]}ms` : `a ${vals[3]}ms transition is not motion, it is waiting`);
  } else {
    add("motion.durations.present", false, `motion.durations needs micro, short, medium and long in ms`);
  }

  // --- coherence nudges. gstack's rule is "flag, never block", and that is right,
  // so these are recorded as non-fatal.
  const direction = String(spec.aesthetic?.direction || "").toLowerCase();
  const motionApproach = String(spec.motion?.approach || "").toLowerCase();
  if (/brutal|minimal/.test(direction) && /expressive/.test(motionApproach)) {
    add("coherence.motion", false, `a ${direction} aesthetic with ${motionApproach} motion is an unusual pairing. Fine if deliberate; worth a sentence in DESIGN.md either way.`, { fatal: false });
  }
  if (/expressive/.test(String(spec.color?.approach || "").toLowerCase()) && /minimal/.test(String(spec.aesthetic?.decoration || "").toLowerCase())) {
    add("coherence.color", false, `an expressive palette with minimal decoration makes the colour carry all the weight. Fine if deliberate.`, { fatal: false });
  }

  // --- anti-convergence
  if (opts.history) {
    const fp = specFingerprint(spec);
    const prior = readHistory(opts.history).filter((h) => h.fingerprint === fp);
    const allowed = opts.allowRepeat === true;
    add(
      "anti-convergence",
      prior.length === 0 || allowed,
      prior.length === 0
        ? `no prior approved system in ${opts.history} shares this display/body/direction/mode fingerprint`
        : allowed
          ? `repeats ${prior[prior.length - 1].at} — allowed by --allow-repeat, and that override is recorded`
          : `this is the same display font, body font, aesthetic direction and light/dark posture as the system approved at ${prior[prior.length - 1].at}. ` +
            `Proposing it again without saying why is convergence. Say why and pass --allow-repeat, or vary something.`,
      { overridden: prior.length > 0 && allowed },
    );
  }

  const failed = checks.filter((c) => !c.ok && c.fatal);
  return { checks, fonts, failed, ok: failed.length === 0 };
}

function readHistory(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- preview

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function stackFor(role, family) {
  const generic = role === "code" || role === "data" ? "ui-monospace, SFMono-Regular, monospace" : role === "display" ? "Georgia, serif" : "system-ui, sans-serif";
  return family ? `"${family}", ${generic}` : generic;
}

function mockupFor(type, ctx) {
  const t = String(type || "").toLowerCase();
  const { name } = ctx;
  if (/dashboard|web app|webapp|internal tool/.test(t)) {
    return `
    <div class="mock mock-app">
      <aside class="mock-nav">
        <div class="mock-brand">${esc(name)}</div>
        <a class="mock-navitem is-active">Overview</a>
        <a class="mock-navitem">Activity</a>
        <a class="mock-navitem">Reports</a>
        <a class="mock-navitem">Settings</a>
      </aside>
      <div class="mock-main">
        <header class="mock-head"><h3>Overview</h3><button class="btn btn-primary">New report</button></header>
        <div class="stats">
          <div class="stat"><span class="stat-k">Active</span><span class="stat-v">1,284</span><span class="stat-d up">+4.2%</span></div>
          <div class="stat"><span class="stat-k">Queued</span><span class="stat-v">37</span><span class="stat-d">&mdash;</span></div>
          <div class="stat"><span class="stat-k">Failed</span><span class="stat-v">2</span><span class="stat-d down">-1</span></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Run</th><th>Owner</th><th class="num">Duration</th><th class="num">Rows</th><th>State</th></tr></thead>
          <tbody>
            <tr><td>nightly-ingest</td><td>platform</td><td class="num">04:12</td><td class="num">128,400</td><td><span class="pill ok">done</span></td></tr>
            <tr><td>reconcile-ledger</td><td>finance</td><td class="num">00:48</td><td class="num">9,310</td><td><span class="pill warn">retry</span></td></tr>
            <tr><td>export-partners</td><td>ops</td><td class="num">12:05</td><td class="num">1,002,884</td><td><span class="pill err">failed</span></td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
  }
  if (/marketing|editorial/.test(t)) {
    return `
    <div class="mock mock-marketing">
      <nav class="mock-topnav"><span class="mock-brand">${esc(name)}</span><span class="mock-links">Product &nbsp; Pricing &nbsp; Docs</span><button class="btn btn-primary sm">Start</button></nav>
      <div class="hero">
        <h2 class="hero-h">${esc(ctx.headline)}</h2>
        <p class="hero-p">${esc(ctx.subhead)}</p>
        <div class="hero-cta"><button class="btn btn-primary">${esc(ctx.cta)}</button><button class="btn btn-ghost">Read the docs</button></div>
      </div>
      <div class="cols">
        <div class="col"><h4>Measured, not asserted</h4><p>Every number on this page was computed from the palette, not estimated from a screenshot.</p></div>
        <div class="col"><h4>Fails closed</h4><p>A font that cannot load stops the preview instead of silently falling back.</p></div>
      </div>
    </div>`;
  }
  if (/auth|onboarding/.test(t)) {
    return `
    <div class="mock mock-auth">
      <div class="auth-card">
        <div class="mock-brand">${esc(name)}</div>
        <h4>Sign in</h4>
        <label class="fld"><span>Email</span><input value="you@example.com" readonly></label>
        <label class="fld"><span>Password</span><input value="••••••••••" readonly></label>
        <label class="fld err-fld"><span>Workspace</span><input value="acme-" readonly><em class="err-msg">Workspace not found</em></label>
        <button class="btn btn-primary wide">Continue</button>
        <button class="btn btn-ghost wide">Use a single sign-on link</button>
      </div>
    </div>`;
  }
  return `
    <div class="mock mock-settings">
      <h4>Settings &mdash; ${esc(name)}</h4>
      <label class="fld"><span>Display name</span><input value="${esc(name)}" readonly></label>
      <label class="fld"><span>Contact</span><input value="team@example.com" readonly></label>
      <div class="row"><span>Weekly digest</span><span class="toggle on"></span></div>
      <div class="row"><span>Failure alerts</span><span class="toggle"></span></div>
      <div class="mock-actions"><button class="btn btn-primary">Save changes</button><button class="btn btn-ghost">Cancel</button></div>
    </div>`;
}

function buildPreviewHtml(spec, lint) {
  const name = String(spec.product?.name || "").trim();
  const c = spec.color || {};
  const dark = { ...c, ...(c.darkMode || {}) };
  const fonts = lint.fonts.filter((f) => f.status === "OK" && f.family);
  const links = [];
  const seenUrl = new Set();
  for (const f of fonts) {
    if (f.url && !seenUrl.has(f.url)) {
      seenUrl.add(f.url);
      links.push(`  <link rel="stylesheet" href="${esc(f.url)}">`);
    }
  }
  const byRole = Object.fromEntries(lint.fonts.map((f) => [f.role, f]));
  const famOf = (role) => {
    let f = byRole[role];
    let guard = 0;
    while (f && f.status === "inherit" && guard++ < 4) f = byRole[f.inherits];
    return f && f.family ? f.family : null;
  };
  const declaredFamilies = [...new Set(fonts.map((f) => f.family))];

  const tokens = (obj) =>
    Object.entries(obj)
      .filter(([k, v]) => k !== "darkMode" && k !== "approach" && parseColor(v))
      .map(([k, v]) => `      --c-${k}: ${toHex(parseColor(v))};`)
      .join("\n");

  // Ratios are computed here, at generate time, and printed onto the page. The
  // page therefore carries its own evidence: you cannot look at this preview and
  // not know whether the muted text passes AA.
  const ratioRows = [];
  for (const [modeKey, colors] of [["light", c], ["dark", dark]]) {
    if (modeKey === "dark" && !c.darkMode) continue;
    for (const pair of CONTRAST_PAIRS) {
      const fg = parseColor(colors[pair.fg]);
      const bg = parseColor(colors[pair.bg]);
      if (!fg || !bg) continue;
      const r = round2(contrastRatio(fg, bg));
      ratioRows.push(
        `<tr><td>${modeKey}</td><td>${esc(pair.fg)} on ${esc(pair.bg)}</td><td class="num">${r}:1</td><td class="num">${pair.min}:1</td><td><span class="pill ${r >= pair.min ? "ok" : "err"}">${r >= pair.min ? "pass" : "fail"}</span></td></tr>`,
      );
    }
  }

  const swatches = REQUIRED_COLORS.concat(["success", "warning", "error", "info"])
    .filter((k) => parseColor(c[k]))
    .map((k) => {
      const col = parseColor(c[k]);
      return `<figure class="sw"><span class="sw-chip" style="background:${toHex(col)}"></span><figcaption><b>${esc(k)}</b><code>${toHex(col)}</code></figcaption></figure>`;
    })
    .join("\n        ");

  const ctx = {
    name,
    headline: spec.product?.headline || `${name}`,
    subhead: spec.product?.subhead || String(spec.product?.audience || "").trim() || "The system, rendered in the fonts and colours actually proposed.",
    cta: spec.product?.cta || "Get started",
  };

  const specimen = TEXT_ROLES.map((role) => {
    const fam = famOf(role);
    if (!fam) return "";
    const sample =
      role === "display"
        ? `<p class="spec-sample" style="font-family:${stackFor("display", fam)};font-size:clamp(2rem,5vw,3.5rem);line-height:1.05;font-weight:700">${esc(name)}</p>`
        : role === "body"
          ? `<p class="spec-sample" style="font-family:${stackFor("body", fam)};font-size:1.0625rem;line-height:1.6;max-width:60ch">${esc(ctx.subhead)} Every measurement on this page was computed from the palette in the spec, in both light and dark mode, before the file was written.</p>`
          : role === "data"
            ? `<p class="spec-sample" style="font-family:${stackFor("data", fam)};font-variant-numeric:tabular-nums;font-size:1.125rem">1,284,009 &nbsp; 04:12 &nbsp; 99.982% &nbsp; -1,004.55</p>`
            : role === "code"
              ? `<pre class="spec-sample" style="font-family:${stackFor("code", fam)};font-size:0.9375rem">node tb-designsys.mjs preview --spec design-system.json</pre>`
              : `<p class="spec-sample" style="font-family:${stackFor("ui", fam)};font-size:0.9375rem;letter-spacing:0.01em">Overview &nbsp;&middot;&nbsp; Activity &nbsp;&middot;&nbsp; Reports &nbsp;&middot;&nbsp; Save changes</p>`;
    const prov = byRole[role]?.provider || "";
    return `      <div class="spec-row" data-family="${esc(fam)}">
        <div class="spec-meta"><b>${esc(role)}</b><code>${esc(fam)}</code><small>${esc(prov)}</small></div>
        ${sample}
      </div>`;
  })
    .filter(Boolean)
    .join("\n");

  const generated = new Date().toISOString();

  return `<!doctype html>
<html lang="en" data-mode="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)} — proposed design system</title>
  <meta name="generator" content="toolbay-stack tb-designsys ${VERSION}">
  <meta name="tbs-declared-fonts" content="${esc(declaredFamilies.join("|"))}">
${links.join("\n")}
  <style>
    :root {
${tokens(c)}
      --r-sm: ${Number(spec.radius?.sm) || 4}px;
      --r-md: ${Number(spec.radius?.md) || 8}px;
      --r-lg: ${Number(spec.radius?.lg) || 12}px;
      --s: ${Number(spec.spacing?.base) || 8}px;
      --f-display: ${stackFor("display", famOf("display"))};
      --f-body: ${stackFor("body", famOf("body"))};
      --f-ui: ${stackFor("ui", famOf("ui") || famOf("body"))};
      --f-data: ${stackFor("data", famOf("data") || famOf("body"))};
      --f-code: ${stackFor("code", famOf("code") || famOf("data"))};
      --t-short: ${Number(spec.motion?.durations?.short) || 180}ms;
    }
    html[data-mode="dark"] {
${tokens(dark)}
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--c-background); color: var(--c-text); font-family: var(--f-body); -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    code, pre { font-family: var(--f-code); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: calc(var(--s) * 5) calc(var(--s) * 3) calc(var(--s) * 10); }
    h1, h2, h3 { font-family: var(--f-display); font-weight: 700; line-height: 1.08; margin: 0 0 calc(var(--s) * 2); }
    h1 { font-size: clamp(2.25rem, 6vw, 4rem); letter-spacing: -0.02em; }
    h2 { font-size: 1.5rem; margin-top: calc(var(--s) * 8); }
    h3, h4 { font-family: var(--f-ui); font-size: 1.0625rem; margin: 0 0 var(--s); }
    p { margin: 0 0 calc(var(--s) * 2); }
    small, .muted { color: var(--c-muted); }
    header.top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s); flex-wrap: wrap; }
    .btn { font-family: var(--f-ui); font-size: 0.9375rem; font-weight: 500; padding: calc(var(--s) * 1.25) calc(var(--s) * 2); border-radius: var(--r-md); border: 1px solid transparent; cursor: pointer; transition: opacity var(--t-short) ease-out; }
    .btn:hover { opacity: 0.86; }
    .btn-primary { background: var(--c-primary); color: var(--c-onPrimary); }
    .btn-ghost { background: transparent; color: var(--c-text); border-color: var(--c-border); }
    .btn.sm { padding: calc(var(--s)) calc(var(--s) * 1.5); font-size: 0.875rem; }
    .btn.wide { width: 100%; margin-top: var(--s); }
    .card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: calc(var(--s) * 3); }
    section { margin-top: calc(var(--s) * 6); }
    .spec-row { display: grid; grid-template-columns: 190px 1fr; gap: calc(var(--s) * 3); padding: calc(var(--s) * 3) 0; border-top: 1px solid var(--c-border); align-items: start; }
    .spec-meta { display: flex; flex-direction: column; gap: 4px; font-family: var(--f-ui); }
    .spec-meta code { color: var(--c-muted); font-size: 0.875rem; }
    .spec-sample { margin: 0; overflow-wrap: anywhere; }
    .sws { display: flex; flex-wrap: wrap; gap: calc(var(--s) * 2); }
    .sw { margin: 0; width: 150px; }
    .sw-chip { display: block; height: 64px; border-radius: var(--r-md); border: 1px solid var(--c-border); }
    .sw figcaption { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; font-family: var(--f-ui); font-size: 0.8125rem; }
    .sw code { color: var(--c-muted); }
    table { width: 100%; border-collapse: collapse; font-family: var(--f-data); font-size: 0.9375rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: calc(var(--s) * 1.25) var(--s); border-bottom: 1px solid var(--c-border); }
    th { font-family: var(--f-ui); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-muted); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .pill { font-family: var(--f-ui); font-size: 0.75rem; padding: 2px 8px; border-radius: var(--r-sm); border: 1px solid var(--c-border); }
    .pill.ok { color: var(--c-success, var(--c-text)); }
    .pill.warn { color: var(--c-warning, var(--c-text)); }
    .pill.err { color: var(--c-error, var(--c-text)); }
    .mock { border: 1px solid var(--c-border); border-radius: var(--r-lg); overflow: hidden; background: var(--c-surface); }
    .mock-app { display: grid; grid-template-columns: 200px 1fr; min-height: 340px; }
    .mock-nav { border-right: 1px solid var(--c-border); padding: calc(var(--s) * 2); display: flex; flex-direction: column; gap: 4px; font-family: var(--f-ui); font-size: 0.9375rem; }
    .mock-brand { font-family: var(--f-display); font-weight: 700; margin-bottom: var(--s); }
    .mock-navitem { padding: calc(var(--s)) calc(var(--s) * 1.5); border-radius: var(--r-sm); color: var(--c-muted); }
    .mock-navitem.is-active { background: var(--c-background); color: var(--c-text); }
    .mock-main { padding: calc(var(--s) * 3); }
    .mock-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: calc(var(--s) * 2); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--s) * 2); margin-bottom: calc(var(--s) * 3); }
    .stat { border: 1px solid var(--c-border); border-radius: var(--r-md); padding: calc(var(--s) * 2); display: flex; flex-direction: column; gap: 4px; }
    .stat-k { font-family: var(--f-ui); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-muted); }
    .stat-v { font-family: var(--f-data); font-size: 1.75rem; font-variant-numeric: tabular-nums; }
    .stat-d { font-family: var(--f-data); font-size: 0.8125rem; color: var(--c-muted); }
    .stat-d.up { color: var(--c-success, var(--c-text)); }
    .stat-d.down { color: var(--c-error, var(--c-text)); }
    .mock-marketing { padding: calc(var(--s) * 3); }
    .mock-topnav { display: flex; align-items: center; justify-content: space-between; gap: var(--s); font-family: var(--f-ui); font-size: 0.9375rem; }
    .hero { padding: calc(var(--s) * 6) 0 calc(var(--s) * 4); max-width: 40ch; }
    .hero-h { font-family: var(--f-display); font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.05; margin: 0 0 calc(var(--s) * 2); }
    .hero-cta { display: flex; gap: var(--s); flex-wrap: wrap; }
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: calc(var(--s) * 3); border-top: 1px solid var(--c-border); padding-top: calc(var(--s) * 3); }
    .mock-auth { padding: calc(var(--s) * 5); display: flex; justify-content: center; }
    .auth-card { width: min(380px, 100%); display: flex; flex-direction: column; gap: var(--s); }
    .mock-settings { padding: calc(var(--s) * 3); }
    .fld { display: flex; flex-direction: column; gap: 6px; font-family: var(--f-ui); font-size: 0.875rem; margin-bottom: var(--s); }
    .fld input { font: inherit; font-family: var(--f-body); padding: calc(var(--s) * 1.25); border-radius: var(--r-sm); border: 1px solid var(--c-border); background: var(--c-background); color: var(--c-text); }
    .err-fld input { border-color: var(--c-error, var(--c-border)); }
    .err-msg { color: var(--c-error, var(--c-muted)); font-style: normal; font-size: 0.8125rem; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: calc(var(--s) * 1.5) 0; border-bottom: 1px solid var(--c-border); font-family: var(--f-ui); font-size: 0.9375rem; }
    .toggle { width: 40px; height: 22px; border-radius: 999px; background: var(--c-border); position: relative; }
    .toggle.on { background: var(--c-primary); }
    .toggle::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: var(--c-surface); }
    .toggle.on::after { left: auto; right: 3px; }
    .mock-actions { display: flex; gap: var(--s); margin-top: calc(var(--s) * 2); }
    #fontalarm { display: none; background: #7f1d1d; color: #fff; padding: calc(var(--s) * 2) calc(var(--s) * 3); font-family: var(--f-ui); font-size: 0.9375rem; line-height: 1.5; }
    #fontalarm b { display: block; font-size: 1.0625rem; margin-bottom: 4px; }
    #fontok { display: none; }
    .modebtn { position: fixed; right: 16px; bottom: 16px; z-index: 5; }
    @media (max-width: 720px) { .mock-app { grid-template-columns: 1fr; } .mock-nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--c-border); } .spec-row { grid-template-columns: 1fr; } .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div id="fontalarm" role="alert"></div>
  <div class="wrap">
    <header class="top">
      <div>
        <h1>${esc(name)}</h1>
        <p class="muted">Proposed design system &mdash; ${esc(spec.aesthetic?.direction || "direction unset")}, ${esc(spec.aesthetic?.decoration || "decoration unset")} decoration, ${esc(spec.color?.approach || "colour approach unset")} colour.</p>
        ${spec.product?.memorable ? `<p class="muted">The one thing to remember: <b>${esc(spec.product.memorable)}</b></p>` : ""}
      </div>
      <button class="btn btn-ghost modebtn" id="modetoggle" type="button">Dark mode</button>
    </header>

    <section>
      <h2>Typography, as it actually loads</h2>
      <p class="muted" id="fontok">Every declared family below was measured in this browser and really is the face you are looking at. If one had silently fallen back, the red banner at the top of this page would name it.</p>
${specimen}
    </section>

    <section>
      <h2>Colour</h2>
      <div class="sws">
        ${swatches}
      </div>
    </section>

    <section>
      <h2>Contrast, measured</h2>
      <p class="muted">WCAG 2.1 relative luminance, computed when this file was written &mdash; not estimated from a screenshot.</p>
      <div class="card">
        <table>
          <thead><tr><th>Mode</th><th>Pair</th><th class="num">Ratio</th><th class="num">Floor</th><th>Verdict</th></tr></thead>
          <tbody>
            ${ratioRows.join("\n            ")}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>The system on a real screen</h2>
      ${mockupFor(spec.product?.type, ctx)}
    </section>

    <section>
      <h2>Components</h2>
      <div class="card">
        <p><button class="btn btn-primary">Primary action</button> <button class="btn btn-ghost">Secondary</button></p>
        <div class="row"><span>Success</span><span class="pill ok">operation complete</span></div>
        <div class="row"><span>Warning</span><span class="pill warn">retrying in 30s</span></div>
        <div class="row"><span>Error</span><span class="pill err">could not reach the host</span></div>
      </div>
    </section>

    <footer style="margin-top:calc(var(--s)*8);border-top:1px solid var(--c-border);padding-top:calc(var(--s)*3)">
      <p class="muted">Generated ${esc(generated)} by toolbay-stack tb-designsys ${VERSION}. Self-contained: no build step, no framework, no /tmp.</p>
    </footer>
  </div>

  <script>
    // TBS_FONT_PROOF — the whole point of this block. A webfont that fails to
    // load is invisible: the browser silently uses the next family in the stack
    // and the page looks finished. So the page proves its own typography and
    // accuses itself when the proof fails.
    //
    // It does NOT use the CSS Font Loading API's check() method. That was the
    // first implementation and it fails OPEN, which was caught by loading this
    // very page in headless Chrome with the Google Fonts link gstack's
    // instructions produce for Satoshi: the stylesheet 400s, the heading renders
    // in the fallback, and check() for 16px Satoshi still answers true — with no
    // @font-face for that family anywhere, nothing is pending, so the font set
    // reports itself complete. A checker that says yes when the font is absent
    // is the same bug as the one this engine exists to remove.
    //
    // The honest test is metric. Set the family against three different generic
    // fallbacks; if the measured width never moves for any of them, the family
    // contributed nothing and is not there.
    (function () {
      var declared = ${JSON.stringify(declaredFamilies)};
      var alarm = document.getElementById("fontalarm");
      var okline = document.getElementById("fontok");
      var PROBE = "mmmmmmmmmmlliWW@#0123";
      var BASES = ["monospace", "serif", "sans-serif"];

      function present(family) {
        var span = document.createElement("span");
        span.style.cssText = "position:absolute;left:-9999px;top:-9999px;font-size:96px;white-space:nowrap;line-height:1;";
        span.textContent = PROBE;
        document.body.appendChild(span);
        var moved = false;
        for (var i = 0; i < BASES.length; i++) {
          span.style.fontFamily = BASES[i];
          var base = span.offsetWidth;
          span.style.fontFamily = '"' + family + '",' + BASES[i];
          if (span.offsetWidth !== base) { moved = true; break; }
        }
        document.body.removeChild(span);
        return moved;
      }

      function verdict(isFinal) {
        var missing = [];
        for (var i = 0; i < declared.length; i++) {
          if (!present(declared[i])) missing.push(declared[i]);
        }
        if (!missing.length) {
          alarm.style.display = "none";
          document.documentElement.setAttribute("data-fonts", "ok");
          if (okline) okline.style.display = "block";
          return true;
        }
        if (!isFinal) return false;
        alarm.innerHTML = "<b>THIS PREVIEW IS NOT SHOWING THE FONTS IT CLAIMS.</b>" +
          "Did not load: " + missing.map(function (m) { return "<code>" + m + "</code>"; }).join(", ") +
          ". Everything below is rendering in a fallback face, so do not approve the typography from this page. " +
          "The usual cause is a stylesheet that returns HTTP 400 for a family its provider does not serve — " +
          "a failure the browser reports nowhere else on the page.";
        alarm.style.display = "block";
        document.documentElement.setAttribute("data-fonts", "missing");
        return false;
      }

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { verdict(false); }).catch(function () {});
      }
      // fonts.ready can resolve before a slow stylesheet has been applied, so
      // re-check and only commit to the accusation on the last pass.
      setTimeout(function () { verdict(false); }, 700);
      setTimeout(function () { verdict(false); }, 1600);
      setTimeout(function () { verdict(true); }, 3200);
    })();

    (function () {
      var btn = document.getElementById("modetoggle");
      var root = document.documentElement;
      btn.addEventListener("click", function () {
        var next = root.getAttribute("data-mode") === "dark" ? "light" : "dark";
        root.setAttribute("data-mode", next);
        btn.textContent = next === "dark" ? "Light mode" : "Dark mode";
      });
    })();
  </script>
</body>
</html>
`;
}

// -------------------------------------------------------------------- verify

function verifyPreview(html, spec, lint) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const fonts = lint.fonts.filter((f) => f.status === "OK" && f.family);

  add("file is non-trivial", html.length > 8000, `${html.length} bytes`);
  add("declares the generator", /toolbay-stack tb-designsys/.test(html), "generator meta present");

  for (const f of fonts) {
    if (f.provider === "google") {
      const want = `family=${encodeURIComponent(f.family).replace(/%20/g, "+")}`;
      add(`${f.role} (${f.family}) linked to Google Fonts`, html.includes("fonts.googleapis.com/css2") && html.includes(want), want);
    } else if (f.provider === "fontshare") {
      const slug = registryLookup(f.family)?.slug;
      add(`${f.role} (${f.family}) linked to Fontshare, not Google`, html.includes(`api.fontshare.com`) && html.includes(`${slug}@`), `slug ${slug}`);
      add(
        `${f.role} (${f.family}) is NOT linked to Google Fonts`,
        !new RegExp(`fonts\\.googleapis\\.com[^"']*family=${encodeURIComponent(f.family).replace(/%20/g, "\\+")}`).test(html),
        `gstack's instructions would emit exactly that link, and it returns HTTP 400`,
      );
    } else if (f.provider === "self-hosted") {
      add(`${f.role} (${f.family}) linked to its declared self-hosted stylesheet`, html.includes(f.url), f.url);
    }
    add(`${f.family} is named in the runtime font assertion`, html.includes(`"${f.family}"`) || html.includes(JSON.stringify(f.family).slice(1, -1)), "declared list");
  }

  add(
    "carries the runtime font-load proof",
    /TBS_FONT_PROOF/.test(html) && /offsetWidth/.test(html),
    "metric width comparison present",
  );
  add(
    "the proof is NOT document.fonts.check (which returns true for a font that does not exist)",
    !/document\.fonts\.check/.test(html),
    "no fail-open checker",
  );
  add("carries the fallback alarm banner", /THIS PREVIEW IS NOT SHOWING THE FONTS IT CLAIMS/.test(html), "alarm text present");

  const name = String(spec.product?.name || "").trim();
  add("shows the product name", name.length > 0 && html.includes(esc(name)), name);
  add("contains no lorem ipsum", !/lorem ipsum/i.test(html), "no placeholder copy");

  const colors = Object.entries(spec.color || {}).filter(([k, v]) => k !== "darkMode" && k !== "approach" && parseColor(v));
  const missingColors = colors.filter(([, v]) => !html.includes(toHex(parseColor(v))));
  add("every declared colour appears in the page", missingColors.length === 0, missingColors.length ? `missing ${missingColors.map(([k]) => k).join(", ")}` : `${colors.length} colours`);

  add("has a light and a dark token block", /:root\s*\{/.test(html) && /data-mode="dark"\]?\s*\{/.test(html.replace(/html\[/g, "[")), "both token blocks");
  add("has a working mode toggle", /getElementById\("modetoggle"\)/.test(html), "toggle wired");
  add("prints measured contrast ratios", /Contrast, measured/.test(html) && /:1<\/td>/.test(html), "ratio table present");
  add("no /tmp path anywhere in the artifact", !/["'(\s]\/tmp\//.test(html), "no /tmp");
  add("self-contained: no external script", !/<script[^>]+src=/.test(html), "no remote JS");

  return results;
}

// ---------------------------------------------------------------------- open

function openFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, how: "none", error: `no file at ${abs}` };
  let res;
  if (isWindows) {
    // `start` is a cmd builtin, so it needs cmd. The empty "" is the window
    // title argument; without it cmd eats a quoted path as the title and opens
    // nothing, which is a silent no-op with exit 0.
    res = spawnSync("cmd", ["/c", "start", "", abs], { stdio: "ignore", windowsHide: true });
  } else if (process.platform === "darwin") {
    res = spawnSync("open", [abs], { stdio: "ignore" });
  } else {
    res = spawnSync("xdg-open", [abs], { stdio: "ignore" });
  }
  if (res.error || res.status !== 0) {
    return { ok: false, how: isWindows ? "cmd /c start" : process.platform === "darwin" ? "open" : "xdg-open", error: res.error ? res.error.message : `exit ${res.status}` };
  }
  return { ok: true, how: isWindows ? "cmd /c start" : process.platform === "darwin" ? "open" : "xdg-open" };
}

// ------------------------------------------------------------------ scaffold

function scaffoldSpec(name) {
  return {
    product: {
      name: name || "Untitled",
      type: "dashboard",
      audience: "who this is for",
      memorable: "the one thing someone should remember after seeing this once",
      headline: "",
      subhead: "",
      cta: "Get started",
    },
    aesthetic: { direction: "Industrial/Utilitarian", decoration: "minimal", layout: "grid-disciplined" },
    typography: {
      display: "Instrument Serif",
      body: "Instrument Sans",
      ui: "same as body",
      data: "Geist Mono",
      code: "JetBrains Mono",
      acknowledgeOverused: [],
      selfHosted: {},
    },
    color: {
      approach: "restrained",
      background: "#fbfbf9",
      surface: "#ffffff",
      text: "#16161a",
      muted: "#5c5c66",
      primary: "#1b4d3e",
      onPrimary: "#ffffff",
      border: "#e2e2dc",
      success: "#1b6b3a",
      warning: "#8a5a00",
      error: "#a01b1b",
      info: "#1d4ed8",
      darkMode: {
        background: "#0e0f10",
        surface: "#17181a",
        text: "#ededed",
        muted: "#9a9aa2",
        primary: "#5fd0a4",
        onPrimary: "#08130f",
        border: "#2a2c2f",
        success: "#5fd0a4",
        warning: "#e0b050",
        error: "#f08a8a",
        info: "#8ab4ff",
      },
    },
    spacing: { base: 8, density: "comfortable", scale: [4, 8, 16, 24, 32, 48, 64] },
    radius: { sm: 4, md: 8, lg: 12, full: 9999 },
    motion: { approach: "minimal-functional", durations: { micro: 80, short: 180, medium: 320, long: 560 } },
  };
}

// ------------------------------------------------------------------ printing

function printChecks(lint, { json } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: lint.ok, checks: lint.checks, fonts: lint.fonts }, null, 2) + "\n");
    return;
  }
  const width = Math.min(48, Math.max(...lint.checks.map((c) => c.id.length)));
  for (const c of lint.checks) {
    const tag = c.ok ? "ok   " : c.fatal ? "FAIL " : "note ";
    process.stdout.write(`  ${tag} ${c.id.padEnd(width)}  ${c.detail}\n`);
  }
  const overrides = lint.checks.filter((c) => c.overridden);
  if (overrides.length) {
    process.stdout.write(`\n  OVERRIDDEN: ${overrides.map((c) => c.id).join(", ")}\n`);
    process.stdout.write(`  Say so out loud. A check that was waved through is not a check that passed.\n`);
  }
  process.stdout.write(
    lint.ok
      ? `\n  LINT: PASS  (${lint.checks.filter((c) => c.ok).length}/${lint.checks.length} checks)\n`
      : `\n  LINT: FAIL  ${lint.failed.length} blocking issue${lint.failed.length === 1 ? "" : "s"}\n`,
  );
}

// ------------------------------------------------------------------ commands

function cmdInit(args) {
  const dirArg = args["--dir"];
  const name = args["--name"] || path.basename(process.cwd());
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const base = resolvePathArg(dirArg, { fallback: path.join(defaultDesignDir(), `${slug}-${stamp}`) });
  if (!base.ok) {
    process.stderr.write(`REFUSED: ${base.error}\n`);
    return EXIT_REFUSED;
  }
  fs.mkdirSync(base.p, { recursive: true });
  const specFile = path.join(base.p, "design-system.json");
  if (fs.existsSync(specFile) && !args["--force"]) {
    process.stderr.write(`REFUSED: ${specFile} already exists. Pass --force to overwrite it, or edit it in place.\n`);
    return EXIT_REFUSED;
  }
  fs.writeFileSync(specFile, JSON.stringify(scaffoldSpec(name), null, 2) + "\n", "utf8");
  process.stdout.write(`DESIGN_DIR: ${base.p}\n`);
  process.stdout.write(`SPEC_FILE: ${specFile}\n`);
  process.stdout.write(`HISTORY_FILE: ${path.join(base.p, "history.jsonl")}\n`);
  process.stdout.write(`PREVIEW_FILE (after preview): ${path.join(base.p, "preview.html")}\n`);
  process.stdout.write(`\nEdit the spec to match the proposal, then run:\n  node ${path.basename(SELF)} lint --spec "${specFile}"\n`);
  return EXIT_OK;
}

function lintOptsFrom(args, specFile) {
  return {
    allowSlop: Boolean(args["--allow-slop"]),
    allowRepeat: Boolean(args["--allow-repeat"]),
    history: args["--no-history"] ? null : args["--history"] || path.join(path.dirname(specFile), "history.jsonl"),
  };
}

function cmdLint(args) {
  const r = readSpec(args["--spec"]);
  if (r.error) {
    process.stderr.write(`UNUSABLE: ${r.error}\n`);
    return EXIT_USAGE;
  }
  const lint = lintSpec(r.spec, lintOptsFrom(args, r.file));
  if (!args["--json"]) process.stdout.write(`\n  tb-designsys lint  ${r.file}\n\n`);
  printChecks(lint, { json: args["--json"] });
  return lint.ok ? EXIT_OK : EXIT_FAIL;
}

async function cmdFonts(args) {
  const r = readSpec(args["--spec"]);
  if (r.error) {
    process.stderr.write(`UNUSABLE: ${r.error}\n`);
    return EXIT_USAGE;
  }
  const fonts = resolveFonts(r.spec);
  const rows = [];
  for (const f of fonts) {
    const row = { ...f };
    if (args["--live"] && f.url) {
      const probe = await liveProbe(f.url);
      row.live = probe;
      if (!probe.ok) row.status = f.status === "OK" ? "UNREACHABLE" : f.status;
      else if (probe.status !== 200 || !probe.hasFontFace) row.status = "BROKEN_LINK";
    }
    rows.push(row);
  }
  if (args["--json"]) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  tb-designsys fonts  ${r.file}\n\n`);
    for (const f of rows) {
      if (f.status === "inherit") {
        process.stdout.write(`  ${f.role.padEnd(8)} inherits ${f.inherits}\n`);
        continue;
      }
      const live = f.live ? `  [live ${f.live.ok ? f.live.status : "unreachable"}${f.live.hasFontFace ? " @font-face" : ""}]` : "";
      process.stdout.write(`  ${f.role.padEnd(8)} ${String(f.family).padEnd(20)} ${String(f.status).padEnd(12)} ${f.provider || "-"}${live}\n`);
      if (f.note) process.stdout.write(`           ${f.note}\n`);
      if (f.url) process.stdout.write(`           ${f.url}\n`);
    }
  }
  const bad = rows.filter((f) => f.status !== "OK" && f.status !== "inherit");
  process.stdout.write(bad.length ? `\n  FONTS: ${bad.length} cannot be loaded as declared\n` : `\n  FONTS: every declared family resolves to a provider that serves it\n`);
  return bad.length ? EXIT_FAIL : EXIT_OK;
}

function cmdPreview(args) {
  const r = readSpec(args["--spec"]);
  if (r.error) {
    process.stderr.write(`UNUSABLE: ${r.error}\n`);
    return EXIT_USAGE;
  }
  const lint = lintSpec(r.spec, lintOptsFrom(args, r.file));
  if (!lint.ok) {
    process.stderr.write(`\nREFUSED: the spec does not pass lint, so no preview is written.\n\n`);
    for (const c of lint.failed) process.stderr.write(`  FAIL  ${c.id}: ${c.detail}\n`);
    process.stderr.write(
      `\nA preview generated from a failing spec is the failure mode this engine exists to remove:\n` +
        `it looks finished, it gets approved, and the thing that was approved is not the thing that was shown.\n`,
    );
    return EXIT_REFUSED;
  }
  const out = resolvePathArg(args["--out"], { fallback: path.join(path.dirname(r.file), "preview.html") });
  if (!out.ok) {
    process.stderr.write(`REFUSED: ${out.error}\n`);
    return EXIT_REFUSED;
  }
  const html = buildPreviewHtml(r.spec, lint);
  fs.mkdirSync(path.dirname(out.p), { recursive: true });
  fs.writeFileSync(out.p, html, "utf8");
  const sha = crypto.createHash("sha256").update(html).digest("hex");
  const checks = verifyPreview(html, r.spec, lint);
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\nPREVIEW_FILE: ${out.p}\n`);
  process.stdout.write(`PREVIEW_BYTES: ${Buffer.byteLength(html, "utf8")}\n`);
  process.stdout.write(`PREVIEW_SHA256: ${sha}\n`);
  process.stdout.write(`FONTS_LINKED: ${lint.fonts.filter((f) => f.status === "OK" && f.family).map((f) => `${f.family} (${f.provider})`).join(", ")}\n`);
  const overrides = lint.checks.filter((c) => c.overridden);
  if (overrides.length) process.stdout.write(`OVERRIDES_USED: ${overrides.map((c) => c.id).join(", ")}\n`);
  process.stdout.write(`SELF_VERIFY: ${checks.length - failed.length}/${checks.length} assertions on the written file\n`);
  for (const c of failed) process.stdout.write(`  FAIL  ${c.name}: ${c.detail}\n`);
  if (failed.length) {
    process.stderr.write(`\nThe file was written but does not contain what it claims. Do not show it.\n`);
    return EXIT_FAIL;
  }
  process.stdout.write(`\nOpen it with:\n  node ${path.basename(SELF)} show --file "${out.p}"\n`);
  return EXIT_OK;
}

function cmdVerify(args) {
  const r = readSpec(args["--spec"]);
  if (r.error) {
    process.stderr.write(`UNUSABLE: ${r.error}\n`);
    return EXIT_USAGE;
  }
  const fileArg = resolvePathArg(args["--file"], { fallback: path.join(path.dirname(r.file), "preview.html") });
  if (!fileArg.ok) {
    process.stderr.write(`REFUSED: ${fileArg.error}\n`);
    return EXIT_REFUSED;
  }
  if (!fs.existsSync(fileArg.p)) {
    process.stderr.write(`UNUSABLE: no preview at ${fileArg.p}\n`);
    return EXIT_USAGE;
  }
  const html = fs.readFileSync(fileArg.p, "utf8");
  const lint = lintSpec(r.spec, { ...lintOptsFrom(args, r.file), allowSlop: true, allowRepeat: true });
  const checks = verifyPreview(html, r.spec, lint);
  const failed = checks.filter((c) => !c.ok);
  if (args["--json"]) {
    process.stdout.write(JSON.stringify({ file: fileArg.p, ok: failed.length === 0, checks }, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  tb-designsys verify  ${fileArg.p}\n\n`);
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}\n`);
    process.stdout.write(`\n  ${checks.length - failed.length}/${checks.length} assertions hold against the file on disk\n`);
  }
  return failed.length ? EXIT_FAIL : EXIT_OK;
}

function cmdRecord(args) {
  const r = readSpec(args["--spec"]);
  if (r.error) {
    process.stderr.write(`UNUSABLE: ${r.error}\n`);
    return EXIT_USAGE;
  }
  const lint = lintSpec(r.spec, { ...lintOptsFrom(args, r.file), allowRepeat: true });
  if (!lint.ok && !args["--force"]) {
    process.stderr.write(`REFUSED: recording a system that does not pass lint would poison the anti-convergence history. Pass --force only if you know why.\n`);
    return EXIT_REFUSED;
  }
  const hist = args["--history"] || path.join(path.dirname(r.file), "history.jsonl");
  const entry = {
    at: new Date().toISOString(),
    spec: r.file,
    fingerprint: specFingerprint(r.spec),
    display: r.spec.typography?.display || null,
    body: r.spec.typography?.body || null,
    direction: r.spec.aesthetic?.direction || null,
    lint: lint.ok ? "pass" : "forced",
  };
  fs.mkdirSync(path.dirname(hist), { recursive: true });
  fs.appendFileSync(hist, JSON.stringify(entry) + "\n", "utf8");
  process.stdout.write(`RECORDED: ${entry.fingerprint} -> ${hist}\n`);
  return EXIT_OK;
}

function cmdContrast(args) {
  const fg = parseColor(args["--fg"]);
  const bg = parseColor(args["--bg"]);
  if (!fg || !bg) {
    process.stderr.write(`UNUSABLE: --fg and --bg must both be colours (#rgb, #rrggbb or rgb()). Got ${JSON.stringify(args["--fg"])} and ${JSON.stringify(args["--bg"])}.\n`);
    return EXIT_USAGE;
  }
  const size = Number(args["--size"]) || 16;
  const bold = Boolean(args["--bold"]);
  const large = size >= 24 || (bold && size >= 18.66);
  const need = large ? 3.0 : 4.5;
  const ratio = round2(contrastRatio(fg, bg));
  process.stdout.write(`${toHex(fg)} on ${toHex(bg)}: ${ratio}:1  (needs ${need}:1 at ${size}px${bold ? " bold" : ""})  ${ratio >= need ? "PASS" : "FAIL"}\n`);
  return ratio >= need ? EXIT_OK : EXIT_FAIL;
}

function cmdShow(args) {
  const f = args["--file"];
  if (!f) {
    process.stderr.write(`UNUSABLE: --file is required\n`);
    return EXIT_USAGE;
  }
  const r = resolvePathArg(f, { fallback: f });
  if (!r.ok) {
    process.stderr.write(`REFUSED: ${r.error}\n`);
    return EXIT_REFUSED;
  }
  if (args["--print-only"]) {
    process.stdout.write(`PREVIEW_PATH: ${r.p}\nNOT_OPENED: --print-only was passed, so nothing was launched.\n`);
    return EXIT_OK;
  }
  const res = openFile(r.p);
  if (!res.ok) {
    // gstack runs `open <file>` unconditionally. On Windows that is a
    // command-not-found, the `||` chain swallows it, and the skill goes on to
    // discuss a preview the user is not looking at.
    process.stdout.write(`OPEN_FAILED: ${res.error}\nPREVIEW_PATH: ${r.p}\nOpen that path in a browser manually. Do not discuss the preview until they say they can see it.\n`);
    return EXIT_FAIL;
  }
  process.stdout.write(`OPENED: ${r.p}\nVIA: ${res.how}\n`);
  return EXIT_OK;
}

// ------------------------------------------------------------------ selftest

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tb-designsys-selftest-"));
}

function runSelf(argv, { cwd } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...argv], { encoding: "utf8", cwd: cwd || process.cwd() });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

function writeSpec(dir, name, mutate) {
  const spec = scaffoldSpec("Ledgerline");
  spec.product.type = "dashboard";
  if (mutate) mutate(spec);
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(spec, null, 2), "utf8");
  return f;
}

async function selftest() {
  const tmp = tmpdir();
  const results = [];
  const add = (name, expected, got, detail = "") => results.push({ name, expected, got, pass: String(expected) === String(got), detail });

  // ---------- the baseline has to pass, or every refusal below proves nothing
  const good = writeSpec(tmp, "good.json");
  add("a coherent spec passes lint", EXIT_OK, runSelf(["lint", "--spec", good, "--no-history"]).status);

  // ---------- the gstack font bug, in both directions
  const satoshi = writeSpec(tmp, "satoshi.json", (s) => {
    s.typography.display = "Satoshi";
  });
  const satoshiPrev = runSelf(["preview", "--spec", satoshi, "--out", path.join(tmp, "satoshi.html"), "--no-history"]);
  add("a Fontshare face is accepted", EXIT_OK, satoshiPrev.status, satoshiPrev.out.slice(0, 200));
  const satoshiHtml = fs.existsSync(path.join(tmp, "satoshi.html")) ? fs.readFileSync(path.join(tmp, "satoshi.html"), "utf8") : "";
  add("Satoshi is linked to Fontshare", true, /api\.fontshare\.com[^"']*satoshi@/.test(satoshiHtml));
  add(
    "Satoshi is NOT linked to Google Fonts (gstack emits exactly that, and it 400s)",
    true,
    !/fonts\.googleapis\.com[^"']*family=Satoshi/.test(satoshiHtml),
  );

  const berkeley = writeSpec(tmp, "berkeley.json", (s) => {
    s.typography.code = "Berkeley Mono";
  });
  add("a commercial-only face is refused, not linked", EXIT_FAIL, runSelf(["lint", "--spec", berkeley, "--no-history"]).status);
  add("and no preview is written from it", EXIT_REFUSED, runSelf(["preview", "--spec", berkeley, "--out", path.join(tmp, "berkeley.html"), "--no-history"]).status);
  add("the refused preview really was not written", false, fs.existsSync(path.join(tmp, "berkeley.html")));

  const berkeleyHosted = writeSpec(tmp, "berkeley-hosted.json", (s) => {
    s.typography.code = "Berkeley Mono";
    s.typography.selfHosted = { "Berkeley Mono": "https://cdn.example.com/berkeley.css" };
  });
  add("...unless the spec says where the licensed files are", EXIT_OK, runSelf(["lint", "--spec", berkeleyHosted, "--no-history"]).status);

  const unknown = writeSpec(tmp, "unknown.json", (s) => {
    s.typography.display = "Frobnicate Grotesk";
  });
  add("an unrecognised family fails closed rather than being guessed at", EXIT_FAIL, runSelf(["lint", "--spec", unknown, "--no-history"]).status);

  // ---------- gstack's own lists, enforced instead of remembered
  const papyrus = writeSpec(tmp, "papyrus.json", (s) => {
    s.typography.display = "Papyrus";
  });
  add("a blacklisted face is refused", EXIT_FAIL, runSelf(["lint", "--spec", papyrus, "--no-history"]).status);

  const inter = writeSpec(tmp, "inter.json", (s) => {
    s.typography.body = "Inter";
  });
  add("an overused face is refused by default", EXIT_FAIL, runSelf(["lint", "--spec", inter, "--no-history"]).status);

  const interAck = writeSpec(tmp, "inter-ack.json", (s) => {
    s.typography.body = "Inter";
    s.typography.acknowledgeOverused = ["Inter"];
  });
  add("...and allowed when the spec records it was asked for by name", EXIT_OK, runSelf(["lint", "--spec", interAck, "--no-history"]).status);

  const spaceG = writeSpec(tmp, "spacegrotesk.json", (s) => {
    s.typography.display = "Space Grotesk";
  });
  add("Space Grotesk gets the same treatment as Inter (the convergence trap)", EXIT_FAIL, runSelf(["lint", "--spec", spaceG, "--no-history"]).status);

  const sysui = writeSpec(tmp, "sysui.json", (s) => {
    s.typography.body = "system-ui";
  });
  add("system-ui as body text is refused as slop", EXIT_FAIL, runSelf(["lint", "--spec", sysui, "--no-history"]).status);

  // ---------- contrast, in both modes
  const lowContrast = writeSpec(tmp, "low.json", (s) => {
    s.color.background = "#ffffff";
    s.color.text = "#777777"; // 4.48:1 — the classic near-miss
  });
  add("4.48:1 body text is refused (AA needs 4.5)", EXIT_FAIL, runSelf(["lint", "--spec", lowContrast, "--no-history"]).status);

  const badButton = writeSpec(tmp, "button.json", (s) => {
    s.color.primary = "#7dd3a0";
    s.color.onPrimary = "#ffffff";
  });
  add("white on a light primary button is refused", EXIT_FAIL, runSelf(["lint", "--spec", badButton, "--no-history"]).status);

  const badDark = writeSpec(tmp, "dark.json", (s) => {
    s.color.darkMode.muted = "#4a4a52"; // fine-looking, fails on the dark background
  });
  add("dark mode is measured too (gstack never checks it at all)", EXIT_FAIL, runSelf(["lint", "--spec", badDark, "--no-history"]).status);

  const badHex = writeSpec(tmp, "badhex.json", (s) => {
    s.color.primary = "#12345";
  });
  add("a colour that is not a colour is refused", EXIT_FAIL, runSelf(["lint", "--spec", badHex, "--no-history"]).status);

  // ---------- slop patterns
  const purple = writeSpec(tmp, "purple.json", (s) => {
    s.color.primary = "#7c3aed";
    s.color.onPrimary = "#ffffff";
  });
  add("the default AI violet is refused", EXIT_FAIL, runSelf(["lint", "--spec", purple, "--no-history"]).status);
  add("...and can be overridden deliberately", EXIT_OK, runSelf(["lint", "--spec", purple, "--allow-slop", "--no-history"]).status);
  add(
    "an override is printed, not swallowed",
    true,
    /OVERRIDDEN/.test(runSelf(["lint", "--spec", purple, "--allow-slop", "--no-history"]).out),
  );

  const bubble = writeSpec(tmp, "bubble.json", (s) => {
    s.radius = { sm: 16, md: 16, lg: 16, full: 9999 };
  });
  add("one radius three times is refused as bubble-everything", EXIT_FAIL, runSelf(["lint", "--spec", bubble, "--no-history"]).status);

  // ---------- structure
  const offGrid = writeSpec(tmp, "offgrid.json", (s) => {
    s.spacing = { base: 8, density: "comfortable", scale: [4, 8, 13, 24, 32, 48] };
  });
  add("a spacing step off the base grid is refused", EXIT_FAIL, runSelf(["lint", "--spec", offGrid, "--no-history"]).status);

  const base5 = writeSpec(tmp, "base5.json", (s) => {
    s.spacing.base = 5;
  });
  add("a 5px base unit is refused", EXIT_FAIL, runSelf(["lint", "--spec", base5, "--no-history"]).status);

  const noName = writeSpec(tmp, "noname.json", (s) => {
    s.product.name = "";
  });
  add("a nameless product is refused (the preview would say Lorem Ipsum)", EXIT_FAIL, runSelf(["lint", "--spec", noName, "--no-history"]).status);

  const slowMotion = writeSpec(tmp, "slow.json", (s) => {
    s.motion.durations = { micro: 80, short: 180, medium: 320, long: 1400 };
  });
  add("a 1400ms transition is refused", EXIT_FAIL, runSelf(["lint", "--spec", slowMotion, "--no-history"]).status);

  // ---------- unusable inputs
  const notJson = path.join(tmp, "broken.json");
  fs.writeFileSync(notJson, "{ this is not json", "utf8");
  add("a spec that will not parse is unusable, not empty-passing", EXIT_USAGE, runSelf(["lint", "--spec", notJson]).status);
  add("a missing spec is unusable", EXIT_USAGE, runSelf(["lint", "--spec", path.join(tmp, "nope.json")]).status);
  add("no --spec at all is unusable", EXIT_USAGE, runSelf(["lint"]).status);

  // ---------- windows path ambiguity
  if (isWindows) {
    const tmpOut = runSelf(["preview", "--spec", good, "--out", "/tmp/preview.html", "--no-history"]);
    add("writing the preview to /tmp is refused on Windows", EXIT_REFUSED, tmpOut.status);
    add("...and the refusal names both real locations", true, /Git Bash resolves it/.test(tmpOut.out));
  } else {
    add("writing the preview to /tmp is refused on Windows", "skipped-not-windows", "skipped-not-windows");
    add("...and the refusal names both real locations", "skipped-not-windows", "skipped-not-windows");
  }

  // ---------- the artifact, and tampering with it
  const prevFile = path.join(tmp, "good-preview.html");
  const prevRun = runSelf(["preview", "--spec", good, "--out", prevFile, "--no-history"]);
  add("a passing spec produces a preview", EXIT_OK, prevRun.status, prevRun.out.slice(0, 300));
  add("the preview file exists", true, fs.existsSync(prevFile));
  add("preview verifies against its spec", EXIT_OK, runSelf(["verify", "--spec", good, "--file", prevFile, "--no-history"]).status);

  const html = fs.readFileSync(prevFile, "utf8");
  add("the preview carries the runtime font-load proof", true, /TBS_FONT_PROOF/.test(html) && /offsetWidth/.test(html));
  add("the proof is metric, not document.fonts.check (which fails open)", true, !/document\.fonts\.check/.test(html));
  add("the preview prints its own measured contrast ratios", true, /Contrast, measured/.test(html));
  add("the preview has a dark-mode token block", true, /data-mode="dark"\]/.test(html.replace(/html\[/g, "[")));
  add("the preview contains no /tmp path", true, !/["'(\s]\/tmp\//.test(html));

  const tampered = path.join(tmp, "tampered.html");
  fs.writeFileSync(tampered, html.replace(/<link rel="stylesheet"[^>]*>/g, ""), "utf8");
  add("verify catches a preview whose font links were stripped", EXIT_FAIL, runSelf(["verify", "--spec", good, "--file", tampered, "--no-history"]).status);

  const gutted = path.join(tmp, "gutted.html");
  fs.writeFileSync(gutted, html.replace(/TBS_FONT_PROOF/g, "removed").replace(/offsetWidth/g, "x"), "utf8");
  add("verify catches a preview with the font proof removed", EXIT_FAIL, runSelf(["verify", "--spec", good, "--file", gutted, "--no-history"]).status);

  const failOpen = path.join(tmp, "failopen.html");
  fs.writeFileSync(failOpen, html.replace(/present\(declared\[i\]\)/g, "document.fonts.check('16px \"' + declared[i] + '\"')"), "utf8");
  add("verify catches a preview that went back to the fail-open checker", EXIT_FAIL, runSelf(["verify", "--spec", good, "--file", failOpen, "--no-history"]).status);

  const recolored = path.join(tmp, "recolored.html");
  fs.writeFileSync(recolored, html.replace(/#1b4d3e/g, "#333333"), "utf8");
  add("verify catches a preview whose palette drifted from the spec", EXIT_FAIL, runSelf(["verify", "--spec", good, "--file", recolored, "--no-history"]).status);

  // ---------- anti-convergence
  const histDir = path.join(tmp, "hist");
  fs.mkdirSync(histDir, { recursive: true });
  const h1 = writeSpec(histDir, "round1.json");
  add("recording an approved system succeeds", EXIT_OK, runSelf(["record", "--spec", h1]).status);
  const h2 = writeSpec(histDir, "round2.json"); // identical fingerprint
  add("proposing the same fonts + direction again is refused as convergence", EXIT_FAIL, runSelf(["lint", "--spec", h2]).status);
  add("...and can be overridden when it is deliberate", EXIT_OK, runSelf(["lint", "--spec", h2, "--allow-repeat"]).status);
  const h3 = writeSpec(histDir, "round3.json", (s) => {
    s.typography.display = "Fraunces";
    s.aesthetic.direction = "Editorial/Magazine";
  });
  add("a genuinely different system is not blocked", EXIT_OK, runSelf(["lint", "--spec", h3]).status);

  // ---------- open path
  const show = runSelf(["show", "--file", prevFile, "--print-only"]);
  add("show --print-only never claims it opened anything", true, /NOT_OPENED/.test(show.out) && !/^OPENED/m.test(show.out));

  // ---------- contrast primitive
  add("contrast exits 1 on a failing pair", EXIT_FAIL, runSelf(["contrast", "--fg", "#777777", "--bg", "#ffffff"]).status);
  add("contrast exits 0 on a passing pair", EXIT_OK, runSelf(["contrast", "--fg", "#16161a", "--bg", "#ffffff"]).status);
  add("contrast refuses a non-colour", EXIT_USAGE, runSelf(["contrast", "--fg", "burnt sienna", "--bg", "#fff"]).status);

  // ---------- the registry against the real world
  //
  // This is the assertion the whole fork rests on, so it is checked against the
  // live provider APIs rather than against itself. Offline it is reported
  // SKIPPED, never PASS: a claim that could not be tested has not been proven.
  const liveCases = [
    ["Satoshi", "fontshare"],
    ["General Sans", "fontshare"],
    ["Clash Grotesk", "fontshare"],
    ["Cabinet Grotesk", "fontshare"],
    ["Instrument Serif", "google"],
    ["JetBrains Mono", "google"],
    ["Geist Mono", "google"],
  ];
  let online = true;
  const probeOne = await liveProbe(googleUrl("Instrument Serif", [400]));
  if (!probeOne.ok) online = false;
  for (const [family, provider] of liveCases) {
    if (!online) {
      add(`live: ${family} is served by ${provider}, not by the other one`, "skipped-offline", "skipped-offline");
      continue;
    }
    const g = await liveProbe(googleUrl(family, [400]));
    const entry = registryLookup(family);
    const fs_ = entry.slug ? await liveProbe(fontshareUrl(entry.slug, [400])) : null;
    const googleServes = g.ok && g.status === 200 && g.hasFontFace;
    const fontshareServes = Boolean(fs_ && fs_.ok && fs_.status === 200 && fs_.hasFontFace);
    const actual = googleServes ? "google" : fontshareServes ? "fontshare" : "neither";
    add(`live: ${family} is served by ${provider}, not by the other one`, provider, actual, `google ${g.status}, fontshare ${fs_ ? fs_.status : "n/a"}`);
  }

  // ---------- the count
  const EXPECTED = 59;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "a selftest whose total can shrink is a selftest that can stop asserting things without anyone noticing",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-designsys selftest  (node ${process.version}, ${process.platform}, network ${online ? "up" : "down"})\n\n`);
  for (const r of results) {
    const skipped = String(r.expected).startsWith("skipped");
    const tag = skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
    process.stdout.write(`  ${tag}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass && !String(r.expected).startsWith("skipped"));
  const skipped = results.filter((r) => String(r.expected).startsWith("skipped"));
  process.stdout.write(`\n  ${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped` : ""}\n`);
  if (failed.length) {
    process.stdout.write(`\n  The engine is NOT trustworthy in this state. Failures:\n`);
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    return EXIT_FAIL;
  }
  process.stdout.write(
    "\n  Every deliberately broken system above was refused before a preview was written,\n" +
      "  and every preview written was checked against the file on disk rather than assumed.\n\n",
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------- main

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[a] = true;
    else {
      args[a] = next;
      i++;
    }
  }
  return args;
}

function usage() {
  process.stdout.write(`
  tb-designsys ${VERSION}  (Toolbay Stack)

  init [--name <product>] [--dir <d>] [--force]
                                   scaffold a design-system spec, print absolute paths
  lint --spec <f>                  grade the whole system: fonts, contrast (light AND
                                   dark), slop patterns, scales, convergence
  fonts --spec <f> [--live]        resolve every family to a provider that serves it;
                                   --live checks the real provider API
  preview --spec <f> [--out <f>]   write the self-contained preview page. Refuses if
                                   lint fails, then verifies the file it just wrote
  verify --spec <f> --file <html>  prove the page on disk still matches the spec
  record --spec <f>                record an approved system for anti-convergence
  contrast --fg <c> --bg <c> [--size <px>] [--bold]
                                   WCAG 2.1 ratio, exit 1 if it fails AA
  show --file <f> [--print-only]   open it with this platform's opener, loudly
  selftest                         prove it against systems that must be refused

  Options: --json  --allow-slop  --allow-repeat  --history <f>  --no-history

  Nothing here is written to /tmp: on Windows that is C:\\tmp to Node and
  %LOCALAPPDATA%\\Temp to Git Bash, so the file lands where the next line cannot
  find it. Default output is ${defaultDesignDir()}.

  Exit: 0 pass, 1 checks failed, 2 spec/arguments unusable, 3 refused.
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "lint":
      return cmdLint(args);
    case "fonts":
      return await cmdFonts(args);
    case "preview":
      return cmdPreview(args);
    case "verify":
      return cmdVerify(args);
    case "record":
      return cmdRecord(args);
    case "contrast":
      return cmdContrast(args);
    case "show":
      return cmdShow(args);
    case "selftest":
      return await selftest();
    case "--help":
    case "-h":
    case "help":
    case undefined:
      usage();
      return EXIT_OK;
    default:
      process.stderr.write(`unknown command "${cmd}"\n`);
      usage();
      return EXIT_USAGE;
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? EXIT_OK;
  },
  (e) => {
    process.stderr.write(`tb-designsys crashed: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = EXIT_USAGE;
  },
);
