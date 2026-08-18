#!/usr/bin/env node
/**
 * tb-benchmark.mjs: the performance regression gate behind /benchmark.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (the `/benchmark` command and its arguments,
 * baseline capture before a change, before/after comparison per page, the metric
 * set (TTFB, paint, DOM timings, request count, transfer size, JS and CSS bundle
 * size), the REGRESSION/WARNING ladder and the numeric thresholds it uses, the
 * budget check, the slowest-resource list and the report layout) comes from
 * `benchmark` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's /benchmark is prose. Measured on Windows 11, gstack 1.60.1.0:
 *
 *     $ ls ~/.claude/skills/gstack/benchmark/
 *     SKILL.md  SKILL.md.tmpl
 *
 *     $ grep -cE '^\s*(node|bun|python|\./)' benchmark/SKILL.md.tmpl
 *     0
 *
 * Nothing in it executes. Five specific consequences, each of which this file
 * closes, and every one of them fails in the direction that reads as success.
 *
 * 1. THE MEASUREMENT COMMANDS SILENTLY MEASURE NOTHING. Five of the seven data
 *    collection commands are `$B eval "<javascript>"` (SKILL.md.tmpl:78, 91, 96,
 *    97, 102), where `$B` is a shell variable assigned in a SETUP block. In
 *    Claude Code every Bash call is a fresh shell, so `$B` is empty by the next
 *    call, and `$B eval "..."` does not fail loudly, it becomes bash's OWN
 *    builtin `eval` and tries to run the JavaScript as a shell command.
 *    Measured, in a fresh shell, verbatim from line 78:
 *
 *      $ $B eval "JSON.stringify(performance.getEntriesByType('navigation')[0])"
 *      bash: eval: line 1: syntax error near unexpected token `performance...'
 *      exit=2                                        <- and stdout is EMPTY
 *
 *      $ $B perf
 *      bash: line 1: perf: command not found
 *      exit=127                                      <- stdout EMPTY again
 *
 *    Empty stdout is not distinguishable, anywhere in that skill, from a page
 *    with nothing to report. There is no state in the whole workflow for "the
 *    measurement did not happen", so the agent writes the report from whatever
 *    it does have, and a benchmark that measured nothing looks like a benchmark
 *    that found nothing wrong.
 *
 * 2. THE THRESHOLDS ARE SENTENCES IN A MARKDOWN FILE (:168-172). ">50% increase
 *    OR >500ms absolute increase = REGRESSION" is applied by a language model
 *    eyeballing two numbers. There is no exit code anywhere in the skill, so
 *    nothing downstream can gate on it: /benchmark cannot fail a build, block a
 *    ship, or be put in front of a deploy. Here the thresholds are DATA, in a
 *    file you can diff, validated before use, and `compare` exits non-zero on a
 *    regression.
 *
 * 3. THE THRESHOLDS ARE ONE-SIDED, SO A BROKEN BUILD SCORES AS AN IMPROVEMENT.
 *    Every rule in that list fires on an INCREASE. A deploy that breaks the
 *    bundler and starts serving a 4KB error page in place of a 700KB app is, by
 *    those rules, six improvements in a row. Here a large DROP in a deterministic
 *    metric is `suspect` and fails the run, because bundles do not lose 60% of
 *    their weight by accident.
 *
 * 4. RE-BASELINING BURIES THE REGRESSION YOU ARE LOOKING FOR. `--baseline`
 *    writes `.gstack/benchmark-reports/baselines/baseline.json` (:154) with no
 *    guard. Run it once out of habit after the slow change landed and the slow
 *    numbers ARE the baseline; every later run is clean and the regression is
 *    now permanently invisible. Here an overwrite is refused unless you pass
 *    --force, and the refusal prints the delta it would have buried.
 *
 * 5. NOTHING RECORDS WHERE THE NUMBERS CAME FROM. A baseline captured on one
 *    machine and compared on another produces confident nonsense: different CPU,
 *    different network, different Node. The file has a `branch` field (:157) and
 *    nothing ever reads it. Here the host, platform, arch, Node version, commit
 *    and URL are recorded and CHECKED, and a cross-environment comparison is
 *    refused rather than reported.
 *
 * THE CONTRACT THIS FILE ADDS
 *
 * Every metric in the baseline must be covered by a validated rule, or the run
 * stops. Not "no rule means no opinion" — no rule means UNUSABLE, because an
 * unthresholded metric is not a passing metric. Opting out is allowed and has to
 * be written down: `thresholds --disable <metric>` sets `enabled: false` in a
 * file that shows up in a diff and is printed in every report. A typo in that
 * file (`fail_percent` for `fail_pct`) is refused rather than ignored, because a
 * threshold you think you set and did not is worse than no threshold at all.
 *
 * WINDOWS
 *
 * No shell, no `$B`, no coreutils, no `date +%s`. Node makes the requests and
 * measures them itself, so the same command produces the same numbers from Git
 * Bash, PowerShell and cmd, and there is no variable that has to survive a tool
 * call. `--dir /tmp/bench` is refused on win32 for the measured reason that it
 * names two different directories there. Browser-only metrics are collected
 * through the forked browse engine, and every way that engine can come back
 * empty is a failure here, never an omission.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS, resolveOutDir as resolveOutDirShared } from "./tb-outdir.mjs";

/**
 * This skill's output directory. The refusal and the resolution are shared
 * (src/outdir/tb-outdir.mjs); only the default and the consequence sentence
 * are this skill's.
 */
function resolveOutDir(raw) {
  return resolveOutDirShared(raw, {
    defaultDir: process.env.TOOLBAY_BENCHMARK_DIR || path.join(process.cwd(), ".toolbay", "benchmark"),
    consequence: "The baseline would be written to one and read from the other, which reads as 'no baseline yet' forever.",
  });
}


const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

/** 0 = no regression. 1 = a regression, or a metric nobody measured. */
const EXIT_PASS = 0;
const EXIT_FAILED = 1;
const EXIT_UNUSABLE = 2; // baseline, contract or arguments unusable
const EXIT_REFUSED = 3; // a request that must not be honoured

// ------------------------------------------------------------------- metrics
//
// `kind` decides how a delta is judged, and it is the distinction gstack states
// in its own rules ("Bundle size is the leading indicator... Load time varies
// with network. Bundle size is deterministic") and then does not act on: it
// applies the same eyeball to both. A deterministic metric moves only when the
// build changes, so a small percentage is real. A timing metric moves on its
// own, so a percentage means nothing until the absolute delta clears the noise
// the baseline itself measured.

const METRICS = {
  ttfb_ms: { unit: "ms", kind: "timing", source: "http", label: "time to response headers" },
  assets_ms: { unit: "ms", kind: "timing", source: "http", label: "html plus every subresource" },
  html_bytes: { unit: "bytes", kind: "deterministic", source: "http", label: "html document" },
  total_bytes: { unit: "bytes", kind: "deterministic", source: "http", label: "html plus subresources" },
  js_bytes: { unit: "bytes", kind: "deterministic", source: "http", label: "script bytes" },
  css_bytes: { unit: "bytes", kind: "deterministic", source: "http", label: "stylesheet bytes" },
  img_bytes: { unit: "bytes", kind: "deterministic", source: "http", label: "image bytes" },
  requests: { unit: "count", kind: "deterministic", source: "http", label: "requests that answered" },
  failed_requests: { unit: "count", kind: "deterministic", source: "http", label: "subresources that did not" },
  // Browser-only. Nothing outside a rendering engine can produce these, so they
  // arrive through `collect --browser` or `record`, and if the baseline has one
  // and this run does not, the run fails as unmeasured rather than skipping it.
  fcp_ms: { unit: "ms", kind: "timing", source: "browser", label: "first contentful paint" },
  lcp_ms: { unit: "ms", kind: "timing", source: "browser", label: "largest contentful paint" },
  dom_interactive_ms: { unit: "ms", kind: "timing", source: "browser", label: "dom interactive" },
  dom_complete_ms: { unit: "ms", kind: "timing", source: "browser", label: "dom complete" },
  full_load_ms: { unit: "ms", kind: "timing", source: "browser", label: "load event end" },
};

/**
 * The default contract. The percentages are gstack's, deliberately, so the
 * ladder behaves the same for anyone moving over. What is new is that they are
 * data rather than prose, that they are validated, that they have a noise floor
 * so a 3ms metric cannot post a 200% regression, and that a large DROP in a
 * deterministic metric is a finding rather than a celebration.
 */
const RULE_KEYS = new Set([
  "enabled",
  "kind",
  "warn_pct",
  "fail_pct",
  "fail_abs",
  "floor",
  "suspect_drop_pct",
  "max_baseline_noise_pct",
  "_why",
]);

function defaultRules() {
  const timing = (floor) => ({
    enabled: true,
    kind: "timing",
    warn_pct: 20,
    fail_pct: 50,
    fail_abs: 500,
    floor,
    suspect_drop_pct: null,
    max_baseline_noise_pct: 30,
  });
  const bytes = (floor) => ({
    enabled: true,
    kind: "deterministic",
    warn_pct: 10,
    fail_pct: 25,
    fail_abs: null,
    floor,
    suspect_drop_pct: 50,
    max_baseline_noise_pct: null,
  });
  return {
    ttfb_ms: timing(25),
    assets_ms: timing(50),
    html_bytes: bytes(1024),
    total_bytes: bytes(4096),
    js_bytes: bytes(2048),
    css_bytes: bytes(1024),
    img_bytes: bytes(4096),
    requests: {
      enabled: true,
      kind: "deterministic",
      warn_pct: 30,
      fail_pct: 60,
      fail_abs: null,
      floor: 2,
      suspect_drop_pct: 50,
      max_baseline_noise_pct: null,
    },
    failed_requests: {
      enabled: true,
      kind: "deterministic",
      warn_pct: 1,
      fail_pct: 1,
      fail_abs: null,
      floor: 0,
      suspect_drop_pct: null,
      max_baseline_noise_pct: null,
      _why: "any subresource that stopped answering is a regression, whatever the percentage says",
    },
    fcp_ms: timing(100),
    lcp_ms: timing(150),
    dom_interactive_ms: timing(100),
    dom_complete_ms: timing(150),
    full_load_ms: timing(200),
  };
}

// --------------------------------------------------------------------- paths

/** POSIX system directories that mean two different things on Windows. */

const baselinePath = (dir) => path.join(dir, "baseline.json");
const contractPath = (dir) => path.join(dir, "thresholds.json");
const pendingPath = (dir) => path.join(dir, "pending.json");
const reportsDir = (dir) => path.join(dir, "reports");

function readJsonFile(file, what) {
  if (!fs.existsSync(file)) return { missing: true };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: `${file} could not be read (${e.code || e.message})` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `${what} at ${file} is not valid JSON (${e.message}), so nothing can be computed from it` };
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

// ----------------------------------------------------------------- arguments

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** "90s", "10m", "2h", "14d", "45" (seconds). Returns ms, or null. */
function parseDuration(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Math.round(n * mult);
}

function parseUrl(raw) {
  if (!raw) return { error: "a URL is required" };
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: `"${raw}" is not a URL. Include the scheme, for example https://example.com` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: `"${raw}" is not an http(s) URL (${u.protocol}), so it cannot be measured` };
  }
  return { url: u };
}

function positiveInt(raw, fallback) {
  if (raw === undefined) return { value: fallback };
  if (!/^\d+$/.test(String(raw))) return { error: `"${raw}" is not a whole number` };
  const n = Number(raw);
  if (n < 1) return { error: `"${raw}" must be at least 1` };
  return { value: n };
}

// -------------------------------------------------------------- measurement
//
// The process that reports the number is the process that measured it. There is
// no daemon in between that can be down while the report still reads clean, and
// no shell variable that can be empty while the command still exits 0.

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * One request, with exactly one retry for a socket that died before any byte of
 * the response arrived.
 *
 * Not a fudge factor: Node's fetch keeps connections pooled, and a server that
 * closes an idle keep-alive socket at the same moment the pool reuses it
 * produces ECONNRESET for a server that is perfectly healthy. Measured while
 * building the selftest for this file. Retrying that once, and ONLY when the
 * socket died with nothing received, keeps a benchmark from reporting a
 * regression that is really a pooling race. A refused connection, a DNS failure
 * and a timeout are NOT retried, because those are the answers.
 */
const RETRYABLE = /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed/i;

async function fetchOnce(url, timeoutMs) {
  const first = await fetchAttempt(url, timeoutMs);
  if (first.ok || !RETRYABLE.test(first.error ?? "")) return first;
  const second = await fetchAttempt(url, timeoutMs);
  if (second.ok) return { ...second, retried: true };
  return { ...second, error: `${second.error} (retried once after: ${first.error})` };
}

async function fetchAttempt(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = nowMs();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": `toolbay-stack-benchmark/${VERSION}`,
        // Benchmarking the CDN's copy of yesterday measures yesterday.
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    const headersMs = nowMs() - t0;
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      headersMs,
      doneMs: nowMs() - t0,
      bytes: buf.length,
      buf,
      contentType: res.headers.get("content-type") || "",
      finalUrl: res.url || url,
    };
  } catch (e) {
    const aborted = e?.name === "AbortError" || controller.signal.aborted;
    const cause = e?.cause?.code || e?.code || null;
    return {
      ok: false,
      error: aborted
        ? `no response within ${timeoutMs}ms`
        : `request failed${cause ? ` (${cause})` : ""}: ${e?.message ?? String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const SRC_RE = /<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Every subresource the document asks for, as absolute URLs.
 *
 * Deliberately server-side. gstack reads `resource.transferSize` out of the
 * browser, which is a number the browser is allowed to report as 0 (a cached
 * resource, or a cross-origin one without Timing-Allow-Origin), so a bundle
 * budget built on it can be quietly wrong in the direction of "nothing grew".
 * Fetching the URLs and counting the bytes that arrive cannot be zero unless the
 * bytes really are, and a resource that does not answer is counted as a failure
 * rather than as 0 bytes.
 */
/**
 * Attribute values are HTML, so the entities have to come out before the string
 * is a URL. Found by pointing the first working build at a real Next.js site:
 * `/_next/image?url=%2Flogo.png&amp;w=64` fetched literally returns HTTP 400,
 * and the tool reported two failed subresources on a page where nothing was
 * wrong. A fail-closed gate that cries wolf gets switched off, which is the same
 * outcome as one that fails open.
 */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function discoverResources(html, baseUrl) {
  const refs = [];
  const push = (r) => {
    if (r) refs.push(r);
  };
  for (const m of html.matchAll(SRC_RE)) push(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(IMG_RE)) push(m[1] ?? m[2] ?? m[3]);
  for (const tag of html.matchAll(LINK_RE)) {
    const t = tag[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\b(stylesheet|preload)\b/i.test(t)) continue;
    const h = HREF_RE.exec(t);
    if (h) push(h[1] ?? h[2] ?? h[3]);
  }
  const seen = new Set();
  const urls = [];
  for (const raw of refs) {
    const ref = decodeEntities(String(raw).trim());
    if (!ref || ref.startsWith("#")) continue;
    if (/^(data|javascript|mailto|blob|about):/i.test(ref)) continue;
    let abs;
    try {
      abs = new URL(ref, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    urls.push(abs);
  }
  return urls;
}

function classify(url, contentType) {
  const ct = contentType.toLowerCase();
  const ext = (() => {
    try {
      return path.extname(new URL(url).pathname).toLowerCase();
    } catch {
      return "";
    }
  })();
  if (ct.includes("javascript") || ct.includes("ecmascript") || [".js", ".mjs", ".cjs"].includes(ext)) return "js";
  if (ct.includes("text/css") || ext === ".css") return "css";
  if (ct.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico"].includes(ext)) {
    return "img";
  }
  return "other";
}

async function measureOnce(url, { timeoutMs, maxResources, subresources }) {
  const t0 = nowMs();
  const main = await fetchOnce(url, timeoutMs);
  if (!main.ok) return { ok: false, error: main.error };
  if (main.status >= 400) {
    // Benchmarking an error page produces real numbers about the wrong page,
    // which is worse than no numbers.
    return { ok: false, error: `HTTP ${main.status} from ${url}, so there is no page here to benchmark` };
  }
  const html = main.buf.toString("utf8");
  const found = subresources ? discoverResources(html, main.finalUrl) : [];
  const resources = found.slice(0, maxResources);
  const truncated = found.length - resources.length;

  const byKind = { js: 0, css: 0, img: 0, other: 0 };
  let total = main.bytes;
  let okCount = 0;
  let failed = 0;
  const failures = [];
  const detail = [];
  for (const r of resources) {
    const got = await fetchOnce(r, timeoutMs);
    if (!got.ok || got.status >= 400) {
      failed += 1;
      failures.push(`${r}: ${got.ok ? `HTTP ${got.status}` : got.error}`);
      continue;
    }
    okCount += 1;
    total += got.bytes;
    byKind[classify(r, got.contentType)] += got.bytes;
    detail.push({ url: r, bytes: got.bytes, ms: round1(got.doneMs), kind: classify(r, got.contentType) });
  }

  return {
    ok: true,
    truncated,
    failures,
    resources: detail.sort((a, b) => b.bytes - a.bytes),
    metrics: {
      ttfb_ms: round1(main.headersMs),
      assets_ms: round1(nowMs() - t0),
      html_bytes: main.bytes,
      total_bytes: total,
      js_bytes: byKind.js,
      css_bytes: byKind.css,
      img_bytes: byKind.img,
      requests: 1 + okCount,
      failed_requests: failed,
    },
  };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : round1((v[mid - 1] + v[mid]) / 2);
}

/**
 * N samples, reported as median with the spread kept.
 *
 * The spread is the point. A single sample cannot tell a 20% regression from a
 * 20% noisy machine, and gstack compares single samples against a 20% warning
 * threshold. Keeping min and max means the comparison can refuse to call a
 * timing delta that is smaller than the baseline's own jitter, and can refuse to
 * pass a metric whose baseline is too noisy to gate on at all.
 */
async function measure(url, opts) {
  const samples = [];
  const errors = [];
  let last = null;
  for (let i = 0; i < opts.samples; i += 1) {
    const one = await measureOnce(url, opts);
    if (!one.ok) {
      errors.push(one.error);
      continue;
    }
    samples.push(one.metrics);
    last = one;
  }
  if (!samples.length) {
    return { error: `every one of ${opts.samples} sample(s) failed. ${errors[0] ?? "no reason recorded"}` };
  }
  const metrics = {};
  for (const key of Object.keys(samples[0])) {
    const vals = samples.map((s) => s[key]);
    metrics[key] = {
      median: median(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
      n: vals.length,
      unit: METRICS[key]?.unit ?? "unknown",
      source: "http",
    };
  }
  return { metrics, sampleErrors: errors, detail: last };
}

// -------------------------------------------------------- browser collection
//
// The one part of the measurement that genuinely needs a rendering engine, and
// therefore the one part that can come back empty for reasons the caller cannot
// see. gstack's version of this is `$B eval "<js>"` with no check on the output
// at all. Every shape of empty below is a failure here.

function resolveBrowseScript(explicit) {
  // An engine you NAMED and that is not there must not silently become a
  // different engine. Falling back would mean --browse ./my-instrumented-browse
  // quietly measuring through something else, and the numbers would look fine.
  const named = explicit ?? process.env.TOOLBAY_BROWSE_SCRIPT;
  if (named && !fs.existsSync(named)) {
    return {
      error:
        `the browse engine you named does not exist: ${path.resolve(named)}. ` +
        `Refusing to fall back to a different one, because metrics collected through an engine you did not ask ` +
        `for are not the metrics you asked for.`,
    };
  }
  const candidates = [
    named,
    path.resolve(path.dirname(SELF), "..", "..", "browse", "scripts", "tb-browse.mjs"),
    path.join(os.homedir(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
    path.join(process.cwd(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return { script: path.resolve(c) };
  }
  return {
    error:
      `the browse engine was not found (looked in ${candidates.slice(1).join(", ")}). ` +
      `Browser metrics cannot be collected without it, and a baseline that contains them will report them ` +
      `unmeasured, which fails the run. Install the browse skill, or drop those metrics from the contract ` +
      `with "thresholds --disable <metric>", which records the decision instead of hiding it.`,
  };
}

const PAINT_JS =
  "(() => { const n = performance.getEntriesByType('navigation')[0] || {};" +
  " const p = performance.getEntriesByType('paint');" +
  " const l = performance.getEntriesByType('largest-contentful-paint');" +
  " const at = (e) => (e && e.startTime > 0 ? Math.round(e.startTime) : null);" +
  " const num = (v) => (typeof v === 'number' && v > 0 ? Math.round(v) : null);" +
  " return JSON.stringify({ fcp_ms: at(p.find((x) => x.name === 'first-contentful-paint'))," +
  " lcp_ms: at(l[l.length - 1]), dom_interactive_ms: num(n.domInteractive)," +
  " dom_complete_ms: num(n.domComplete), full_load_ms: num(n.loadEventEnd) }); })()";

/**
 * Strip the browse untrusted-content wrapper and return the payload.
 *
 * The wrapper's source line is load-bearing: after a failed navigation browse
 * keeps answering, with `chrome-error://chromewebdata/` as the source and an
 * empty payload, and exit 0. That is the reading gstack's flow treats as "the
 * page had nothing to report".
 */
function unwrapBrowseOutput(stdout) {
  const text = String(stdout ?? "");
  const begin = /---\s*BEGIN UNTRUSTED EXTERNAL CONTENT(?:\s*\(source:\s*([^)]*)\))?\s*---/i.exec(text);
  let source = begin?.[1]?.trim() ?? null;
  let payload = text;
  if (begin) {
    const after = text.slice(begin.index + begin[0].length);
    const end = /---\s*END UNTRUSTED EXTERNAL CONTENT\s*---/i.exec(after);
    payload = end ? after.slice(0, end.index) : after;
  }
  return { source, payload: payload.trim() };
}

function runBrowse(script, args, timeoutMs) {
  const res = spawnSync(process.execPath, [script, "run", "--", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", signal: res.signal };
}

function collectBrowserMetrics(url, { script, timeoutMs }) {
  const nav = runBrowse(script, ["goto", url], timeoutMs);
  if (nav.status !== 0) {
    return {
      error:
        `the browser could not load ${url} (browse exited ${nav.status ?? `on signal ${nav.signal}`}). ` +
        `${(nav.stderr || nav.stdout || "").trim().slice(0, 200) || "no output"}`,
    };
  }
  const ev = runBrowse(script, ["eval", PAINT_JS], timeoutMs);
  if (ev.status !== 0) {
    return { error: `the browser refused the measurement script (exit ${ev.status}). ${(ev.stderr || "").trim().slice(0, 200)}` };
  }
  const { source, payload } = unwrapBrowseOutput(ev.stdout);
  if (source && /^chrome-error:/i.test(source)) {
    return {
      error:
        `the browser answered from ${source}, which is the error page, not the site. ` +
        `Timing entries there are empty, and an empty timing list is exactly what a fast page looks like to a check that does not look.`,
    };
  }
  if (!payload) {
    return { error: "the browser returned no output at all. Empty output is not a fast page, it is a measurement that did not happen." };
  }
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (e) {
    return { error: `the browser returned something that is not JSON (${e.message}): ${payload.slice(0, 120)}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { error: `the browser returned ${Array.isArray(obj) ? "an array" : typeof obj}, not an object of metrics` };
  }
  const metrics = {};
  const missing = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!METRICS[k]) continue;
    if (v === null || v === undefined) {
      missing.push(k);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { error: `the browser reported ${k} as ${JSON.stringify(v)}, which is not a measurement` };
    }
    metrics[k] = v;
  }
  if (!Object.keys(metrics).length) {
    return {
      error:
        `the browser answered but every metric was null (${missing.join(", ") || "no keys at all"}). ` +
        `That is what a page that never painted looks like, and it must not be recorded as a measurement.`,
    };
  }
  return { metrics, missing, source };
}

// --------------------------------------------------------- pending metrics
//
// Browser metrics arrive out of band, so they carry a timestamp and are only
// used if they are fresher than --pending-max-age. A paint number from last
// week passing today's gate would be the same class of bug as everything else
// in this file: a check that reads as passing because nothing checked.

function readPending(dir, maxAgeMs) {
  const r = readJsonFile(pendingPath(dir), "pending metrics");
  if (r.missing) return { fresh: {}, stale: [] };
  if (r.error) return { error: r.error };
  const v = r.value;
  if (!v || typeof v !== "object" || typeof v.metrics !== "object" || v.metrics === null) {
    return { error: `${pendingPath(dir)} has no "metrics" object` };
  }
  const fresh = {};
  const stale = [];
  const now = Date.now();
  for (const [k, rec] of Object.entries(v.metrics)) {
    const at = Date.parse(rec?.at ?? "");
    if (!Number.isFinite(at)) {
      stale.push(`${k} (no usable timestamp)`);
      continue;
    }
    const age = now - at;
    if (age > maxAgeMs) {
      stale.push(`${k} (${Math.round(age / 1000)}s old, limit ${Math.round(maxAgeMs / 1000)}s)`);
      continue;
    }
    fresh[k] = {
      median: rec.value,
      min: rec.value,
      max: rec.value,
      n: 1,
      unit: METRICS[k]?.unit ?? "unknown",
      source: rec.source || "browser",
      at: rec.at,
      evidence: rec.evidence ?? null,
    };
  }
  return { fresh, stale };
}

function writePending(dir, entries) {
  const existing = readJsonFile(pendingPath(dir), "pending metrics");
  const base = existing.value && typeof existing.value === "object" && existing.value.metrics ? existing.value : { metrics: {} };
  base._comment =
    "Out-of-band metrics waiting to be folded into the next baseline or compare. Written by collect/record. " +
    "Entries older than --pending-max-age are ignored, so a stale browser number cannot pass a fresh gate.";
  for (const [k, rec] of Object.entries(entries)) base.metrics[k] = rec;
  return writeJsonAtomic(pendingPath(dir), base);
}

// ------------------------------------------------------------- the contract

function validateRule(key, rule) {
  const problems = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return [`${key}: the rule is not an object`];
  }
  for (const k of Object.keys(rule)) {
    if (!RULE_KEYS.has(k)) {
      problems.push(
        `${key}: unknown key "${k}". A threshold you think you set and did not is worse than no threshold, so this is refused rather than ignored. Accepted keys: ${[...RULE_KEYS].join(", ")}`,
      );
    }
  }
  if (typeof rule.enabled !== "boolean") problems.push(`${key}: "enabled" must be true or false`);
  if (rule.kind !== "timing" && rule.kind !== "deterministic") {
    problems.push(`${key}: "kind" must be "timing" or "deterministic", got ${JSON.stringify(rule.kind)}`);
  }
  const num = (name, { min = 0, allowNull = false, exclusive = true }) => {
    const v = rule[name];
    if (v === null || v === undefined) {
      if (!allowNull) problems.push(`${key}: "${name}" is required`);
      return;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${key}: "${name}" must be a number, got ${JSON.stringify(v)}`);
      return;
    }
    if (exclusive ? v <= min : v < min) problems.push(`${key}: "${name}" must be greater than ${min}`);
  };
  num("warn_pct", { min: 0 });
  num("fail_pct", { min: 0 });
  num("floor", { min: 0, exclusive: false });
  num("fail_abs", { min: 0, allowNull: true });
  num("suspect_drop_pct", { min: 0, allowNull: true });
  if (typeof rule.warn_pct === "number" && typeof rule.fail_pct === "number" && rule.fail_pct < rule.warn_pct) {
    problems.push(`${key}: fail_pct (${rule.fail_pct}) is below warn_pct (${rule.warn_pct}), so nothing could ever fail without first not warning`);
  }
  if (rule.kind === "timing") num("max_baseline_noise_pct", { min: 0, allowNull: true });
  if (typeof rule.suspect_drop_pct === "number" && rule.suspect_drop_pct > 100) {
    problems.push(`${key}: suspect_drop_pct cannot exceed 100`);
  }
  return problems;
}

function readContract(dir) {
  const file = contractPath(dir);
  const r = readJsonFile(file, "threshold contract");
  if (r.missing) {
    return {
      error:
        `no threshold contract at ${file}. Without one there is nothing to fail on, and "no thresholds" must not ` +
        `quietly mean "everything passes". Run "tb-benchmark.mjs thresholds --init" or capture a baseline, which writes one.`,
    };
  }
  if (r.error) return { error: r.error };
  const v = r.value;
  if (!v || typeof v !== "object" || typeof v.rules !== "object" || v.rules === null) {
    return { error: `${file} has no "rules" object, so no metric has a threshold` };
  }
  const problems = [];
  for (const [key, rule] of Object.entries(v.rules)) {
    if (!METRICS[key]) {
      problems.push(`${key}: not a metric this tool measures. Known metrics: ${Object.keys(METRICS).join(", ")}`);
      continue;
    }
    problems.push(...validateRule(key, rule));
  }
  if (problems.length) {
    return { error: `${file} is not a usable contract:\n      - ${problems.join("\n      - ")}` };
  }
  return { contract: v, file };
}

function writeContract(dir, rules) {
  return writeJsonAtomic(contractPath(dir), {
    _comment: [
      "Toolbay Stack benchmark threshold contract. This file is the gate: compare reads it,",
      "validates it, and refuses to run if a metric in the baseline has no rule here.",
      "warn_pct only prints. fail_pct, fail_abs and suspect_drop_pct fail the run (exit 1).",
      "floor is the absolute delta below which a percentage is ignored, so a 3ms metric cannot",
      "post a 200% regression. suspect_drop_pct fails on a large DROP, because a deterministic",
      "metric that collapses usually means the build broke, not that it got better.",
      "enabled:false is a recorded opt-out; it is printed in every report rather than skipped.",
    ],
    version: 1,
    rules,
  });
}

// ------------------------------------------------------------------ baseline

function envIdentity() {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function gitIdentity() {
  const run = (args) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  };
  const commit = run(["rev-parse", "--short", "HEAD"]);
  if (commit === null) return { available: false };
  const status = run(["status", "--porcelain"]);
  return {
    available: true,
    commit,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
  };
}

function readBaseline(dir) {
  const file = baselinePath(dir);
  const r = readJsonFile(file, "baseline");
  if (r.missing) {
    return {
      error:
        `no baseline at ${file}. A comparison with nothing to compare against is not "no regression detected", ` +
        `it is a run that never happened. Capture one first: tb-benchmark.mjs baseline --url <url>`,
    };
  }
  if (r.error) return { error: r.error };
  const v = r.value;
  if (!v || typeof v !== "object" || typeof v.metrics !== "object" || v.metrics === null) {
    return { error: `${file} has no "metrics" object` };
  }
  if (!Object.keys(v.metrics).length) return { error: `${file} contains no metrics at all` };
  if (typeof v.url !== "string" || !v.url) return { error: `${file} does not record which URL it measured` };
  return { baseline: v, file };
}

// ------------------------------------------------------------- the judgement

function fmt(value, unit) {
  if (value === null || value === undefined) return "-";
  if (unit === "bytes") {
    if (value >= 1024 * 1024) return `${round1(value / 1024 / 1024)}MB`;
    if (value >= 1024) return `${round1(value / 1024)}KB`;
    return `${value}B`;
  }
  if (unit === "ms") return `${round1(value)}ms`;
  return String(value);
}

function fmtDelta(delta, unit) {
  if (delta === null) return "-";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${fmt(Math.abs(delta), unit)}`;
}

/**
 * One metric, judged. Every branch that cannot reach a confident "this did not
 * get worse" produces a status that is not `ok`.
 */
function judgeMetric(key, base, cur, rule) {
  const unit = METRICS[key]?.unit ?? "unknown";
  const row = { key, unit, kind: rule.kind, enabled: rule.enabled, base: base?.median ?? null, cur: cur?.median ?? null };

  if (cur === undefined || cur === null || cur.median === null || cur.median === undefined) {
    row.status = "unmeasured";
    row.detail =
      `the baseline has ${key} and this run does not. A metric that was not measured is not a metric that held steady` +
      (METRICS[key]?.source === "browser"
        ? `. Collect it with "collect --browser" before comparing, or record it with "record --metric ${key} --value <n>"`
        : "");
    return row;
  }

  const b = base.median;
  const c = cur.median;
  const delta = round1(c - b);
  row.delta = delta;
  row.pct = b > 0 ? round1((delta / b) * 100) : delta === 0 ? 0 : null;

  if (!rule.enabled) {
    row.status = "disabled";
    row.detail = `moved ${fmtDelta(delta, unit)}, not gated: this metric is disabled in the contract`;
    return row;
  }

  // A baseline that cannot tell a regression from its own jitter cannot be used
  // to say there was no regression. Percentage alone would fire constantly on a
  // 2ms localhost metric, so the spread has to clear the floor in absolute terms
  // before it counts as noisy.
  const spread = base.n >= 2 ? base.max - base.min : 0;
  if (rule.kind === "timing" && rule.max_baseline_noise_pct !== null && rule.max_baseline_noise_pct !== undefined) {
    const spreadPct = b > 0 ? (spread / b) * 100 : 0;
    if (spread > rule.floor && spreadPct > rule.max_baseline_noise_pct) {
      row.status = "inconclusive";
      row.detail =
        `the baseline for ${key} varied by ${fmt(round1(spread), unit)} across ${base.n} samples ` +
        `(${Math.round(spreadPct)}% of its median, limit ${rule.max_baseline_noise_pct}%), so it cannot distinguish a ` +
        `regression from the machine. Re-baseline with more --samples on a quieter machine, or disable this metric in ` +
        `the contract. It will not be reported as passing.`;
      return row;
    }
  }

  if (delta < 0) {
    const dropPct = b > 0 ? (-delta / b) * 100 : 0;
    if (rule.suspect_drop_pct !== null && rule.suspect_drop_pct !== undefined && dropPct >= rule.suspect_drop_pct) {
      row.status = "suspect";
      row.detail =
        `${fmt(b, unit)} -> ${fmt(c, unit)} (${Math.round(dropPct)}% smaller). A deterministic metric does not lose ` +
        `that much by accident; this is what a broken build, an error page served with HTTP 200, or a stripped asset ` +
        `looks like. Every threshold in gstack's list fires only on an increase, so it would score this as an improvement.`;
      return row;
    }
    row.status = "improved";
    row.detail = `${fmt(b, unit)} -> ${fmt(c, unit)}`;
    return row;
  }

  const noise = Math.max(rule.floor, rule.kind === "timing" ? spread : 0);
  if (delta <= noise) {
    row.status = "ok";
    row.detail = `${fmtDelta(delta, unit)}, inside the noise band (${fmt(noise, unit)})`;
    return row;
  }
  const pctHit = row.pct === null ? true : row.pct >= rule.fail_pct;
  const absHit = rule.fail_abs !== null && rule.fail_abs !== undefined && delta >= rule.fail_abs;
  if (pctHit || absHit) {
    row.status = "regression";
    row.detail =
      `${fmt(b, unit)} -> ${fmt(c, unit)} (${row.pct === null ? "from zero" : `+${row.pct}%`}, ${fmtDelta(delta, unit)}), ` +
      `over the ${pctHit ? `${rule.fail_pct}% fail threshold` : `${fmt(rule.fail_abs, unit)} absolute fail threshold`}`;
    return row;
  }
  if (row.pct !== null && row.pct >= rule.warn_pct) {
    row.status = "warning";
    row.detail = `${fmt(b, unit)} -> ${fmt(c, unit)} (+${row.pct}%), over the ${rule.warn_pct}% warning threshold but under ${rule.fail_pct}%`;
    return row;
  }
  row.status = "ok";
  row.detail = `${fmtDelta(delta, unit)}${row.pct === null ? "" : ` (+${row.pct}%)`}`;
  return row;
}

const VERDICT_ORDER = { REGRESSION: 4, UNMEASURED: 3, INCONCLUSIVE: 2, PASS: 1 };

function computeVerdict(rows) {
  let verdict = "PASS";
  const bump = (v) => {
    if (VERDICT_ORDER[v] > VERDICT_ORDER[verdict]) verdict = v;
  };
  for (const r of rows) {
    if (r.status === "regression" || r.status === "suspect") bump("REGRESSION");
    else if (r.status === "unmeasured") bump("UNMEASURED");
    else if (r.status === "inconclusive") bump("INCONCLUSIVE");
  }
  return verdict;
}

// ------------------------------------------------------------------ commands

function fail(json, message, code) {
  if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
  else err(`  ${code === EXIT_REFUSED ? "REFUSED " : "UNUSABLE"}  ${message}`);
  process.exitCode = code;
}

function openDir(args, json) {
  const res = resolveOutDir(flag(args, "--dir"));
  if (!res.ok) {
    fail(json, res.error, EXIT_REFUSED);
    return null;
  }
  return res.dir;
}

function measureOptions(args) {
  const samples = positiveInt(flag(args, "--samples"), 3);
  if (samples.error) return { error: `--samples ${samples.error}` };
  const timeoutMs = parseDuration(flag(args, "--timeout") ?? "20s");
  if (timeoutMs === null) return { error: "--timeout takes a value like 20s or 2m" };
  const maxResources = positiveInt(flag(args, "--max-resources"), 60);
  if (maxResources.error) return { error: `--max-resources ${maxResources.error}` };
  return {
    samples: samples.value,
    timeoutMs,
    maxResources: maxResources.value,
    subresources: !args.includes("--no-subresources"),
  };
}

async function cmdMeasure(args) {
  const json = args.includes("--json");
  const parsed = parseUrl(flag(args, "--url"));
  if (parsed.error) return fail(json, `--url is required: ${parsed.error}`, EXIT_UNUSABLE);
  const opts = measureOptions(args);
  if (opts.error) return fail(json, opts.error, EXIT_UNUSABLE);

  const m = await measure(parsed.url.href, opts);
  if (m.error) return fail(json, m.error, EXIT_FAILED);

  if (json) return out(JSON.stringify({ ok: true, url: parsed.url.href, samples: opts.samples, metrics: m.metrics }, null, 2));
  out(`\n  ${parsed.url.href}   ${opts.samples} sample(s)\n`);
  for (const [k, v] of Object.entries(m.metrics)) {
    out(`  ${k.padEnd(16)} ${fmt(v.median, v.unit).padStart(10)}   ${v.n > 1 ? `spread ${fmt(round1(v.max - v.min), v.unit)}` : ""}`);
  }
  if (m.detail?.failures?.length) {
    out(`\n  ${m.detail.failures.length} subresource(s) did not answer:`);
    for (const f of m.detail.failures.slice(0, 5)) out(`    - ${f}`);
  }
  if (m.detail?.truncated > 0) out(`\n  ${m.detail.truncated} more subresource(s) not fetched (--max-resources)`);
  if (m.detail?.resources?.length) {
    out(`\n  heaviest resources`);
    for (const r of m.detail.resources.slice(0, 5)) out(`    ${fmt(r.bytes, "bytes").padStart(8)}  ${r.kind.padEnd(5)} ${r.url}`);
  }
  out();
}

async function cmdBaseline(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const parsed = parseUrl(flag(args, "--url"));
  if (parsed.error) return fail(json, `--url is required: ${parsed.error}`, EXIT_UNUSABLE);
  const opts = measureOptions(args);
  if (opts.error) return fail(json, opts.error, EXIT_UNUSABLE);
  const pendingMaxAge = parseDuration(flag(args, "--pending-max-age") ?? "15m");
  if (pendingMaxAge === null) return fail(json, "--pending-max-age takes a value like 15m", EXIT_UNUSABLE);

  const existing = readJsonFile(baselinePath(dir), "baseline");
  const force = args.includes("--force");
  if (!existing.missing && !force) {
    // The refusal that matters most. Re-running --baseline out of habit after a
    // slow change has landed makes the slow numbers the reference point, and the
    // regression becomes permanently invisible. So say what would be buried.
    let preview = "";
    if (!existing.error && existing.value?.metrics) {
      const m = await measure(parsed.url.href, opts);
      if (!m.error) {
        const moved = [];
        for (const [k, b] of Object.entries(existing.value.metrics)) {
          const c = m.metrics[k];
          if (!c || typeof b.median !== "number") continue;
          const d = round1(c.median - b.median);
          if (b.median > 0 && Math.abs(d / b.median) >= 0.05) {
            moved.push(`${k} ${fmt(b.median, b.unit)} -> ${fmt(c.median, c.unit)} (${fmtDelta(d, b.unit)})`);
          }
        }
        preview = moved.length
          ? `\n            Overwriting would bury: ${moved.join("; ")}`
          : "\n            (nothing has moved more than 5% since it was captured)";
      }
    }
    return fail(
      json,
      `a baseline already exists at ${baselinePath(dir)}, captured ${existing.value?.capturedAt ?? "at an unknown time"}. ` +
        `Overwriting it makes today's numbers the reference point, which is how a regression stops being one.${preview}\n` +
        `            Pass --force if that is what you want.`,
      EXIT_REFUSED,
    );
  }

  const m = await measure(parsed.url.href, opts);
  if (m.error) return fail(json, m.error, EXIT_FAILED);

  const pending = readPending(dir, pendingMaxAge);
  if (pending.error) return fail(json, pending.error, EXIT_UNUSABLE);
  const metrics = { ...m.metrics, ...pending.fresh };

  const git = gitIdentity();
  const doc = {
    _comment:
      "Toolbay Stack performance baseline. Written by tb-benchmark.mjs baseline. compare measures again and judges " +
      "the deltas against thresholds.json. Every field here is checked before a comparison is allowed.",
    version: 1,
    url: parsed.url.href,
    capturedAt: new Date().toISOString(),
    samples: opts.samples,
    env: envIdentity(),
    git,
    metrics,
  };
  writeJsonAtomic(baselinePath(dir), doc);

  // The contract is written alongside so that "no thresholds" is never a state
  // a comparison can find itself in.
  let contractNote = "already present";
  if (!fs.existsSync(contractPath(dir))) {
    writeContract(dir, defaultRules());
    contractNote = "written with the defaults";
  }

  if (json) {
    return out(JSON.stringify({ ok: true, dir, baseline: baselinePath(dir), contract: contractPath(dir), metrics }, null, 2));
  }
  out(`\n  baseline   ${parsed.url.href}`);
  out(`  samples    ${opts.samples}`);
  out(`  env        ${doc.env.host} ${doc.env.platform}/${doc.env.arch} node ${doc.env.node}`);
  out(`  git        ${git.available ? `${git.commit}${git.dirty ? " (DIRTY TREE)" : ""} on ${git.branch}` : "not a git checkout"}`);
  out(`  contract   ${contractPath(dir)} (${contractNote})`);
  out(`  file       ${baselinePath(dir)}\n`);
  for (const [k, v] of Object.entries(metrics)) {
    out(`  ${k.padEnd(20)} ${fmt(v.median, v.unit).padStart(10)}   ${v.n > 1 ? `spread ${fmt(round1(v.max - v.min), v.unit)}` : `1 sample, source ${v.source}`}`);
  }
  if (pending.stale.length) out(`\n  ignored as stale: ${pending.stale.join(", ")}`);
  if (git.available && git.dirty) {
    out(`\n  This baseline came from a tree with uncommitted changes, so nobody can`);
    out(`  reproduce it, including you. Commit first if it is going to be a gate.`);
  }
  const browserMetrics = Object.keys(metrics).filter((k) => METRICS[k]?.source === "browser");
  if (!browserMetrics.length) {
    out(`\n  No browser metrics in this baseline (paint, LCP, DOM timings). Nothing`);
    out(`  outside a rendering engine can produce them: run "collect --browser" first`);
    out(`  if you want them gated.`);
  }
  out();
}

function cmdRecord(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const key = flag(args, "--metric");
  const raw = flag(args, "--value");
  if (!key) return fail(json, "--metric is required", EXIT_UNUSABLE);
  if (!METRICS[key]) {
    return fail(
      json,
      `"${key}" is not a metric this tool knows, so nothing would ever compare it. Known: ${Object.keys(METRICS).join(", ")}`,
      EXIT_UNUSABLE,
    );
  }
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < 0) {
    return fail(json, `--value must be a non-negative number, got ${JSON.stringify(raw)}`, EXIT_UNUSABLE);
  }
  const evidence = flag(args, "--evidence");
  if (evidence) {
    let st = null;
    try {
      st = fs.statSync(evidence);
    } catch {
      st = null;
    }
    if (!st || !st.isFile() || st.size === 0) {
      return fail(
        json,
        `--evidence ${evidence} ${!st ? "does not exist" : st.isFile() ? "is 0 bytes" : "is not a file"}. ` +
          `An artifact nobody can open is not evidence.`,
        EXIT_REFUSED,
      );
    }
  }
  const rec = {
    value,
    source: flag(args, "--source") ?? "manual",
    at: new Date().toISOString(),
    evidence: evidence ? path.resolve(evidence) : null,
    note: flag(args, "--note") ?? null,
  };
  writePending(dir, { [key]: rec });
  if (json) return out(JSON.stringify({ ok: true, metric: key, record: rec }, null, 2));
  out(`  recorded  ${key} = ${fmt(value, METRICS[key].unit)}  (source ${rec.source})`);
}

function cmdCollect(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;
  const parsed = parseUrl(flag(args, "--url") ?? readJsonFile(baselinePath(dir), "baseline").value?.url);
  if (parsed.error) return fail(json, `--url is required (or capture a baseline first): ${parsed.error}`, EXIT_UNUSABLE);
  const timeoutMs = parseDuration(flag(args, "--timeout") ?? "60s");
  if (timeoutMs === null) return fail(json, "--timeout takes a value like 60s", EXIT_UNUSABLE);

  const resolved = resolveBrowseScript(flag(args, "--browse"));
  if (resolved.error) return fail(json, resolved.error, EXIT_UNUSABLE);

  const res = collectBrowserMetrics(parsed.url.href, { script: resolved.script, timeoutMs });
  if (res.error) {
    // Nothing is written. A partial write here would be the exact bug: a metric
    // recorded from a browser that never rendered the page.
    return fail(json, res.error, EXIT_FAILED);
  }
  const at = new Date().toISOString();
  const entries = {};
  for (const [k, v] of Object.entries(res.metrics)) entries[k] = { value: v, source: "browse", at, evidence: null, note: null };
  writePending(dir, entries);
  if (json) return out(JSON.stringify({ ok: true, url: parsed.url.href, metrics: res.metrics, missing: res.missing }, null, 2));
  out(`\n  collected from the browser  ${parsed.url.href}`);
  for (const [k, v] of Object.entries(res.metrics)) out(`  ${k.padEnd(20)} ${fmt(v, METRICS[k].unit).padStart(10)}`);
  if (res.missing?.length) {
    out(`\n  not reported by the page: ${res.missing.join(", ")}`);
    out(`  If your baseline has any of those, the next compare will call them unmeasured`);
    out(`  and fail, which is correct: they were not measured.`);
  }
  out();
}

function cmdThresholds(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;

  if (args.includes("--init")) {
    if (fs.existsSync(contractPath(dir)) && !args.includes("--force")) {
      return fail(json, `${contractPath(dir)} already exists. Pass --force to replace it with the defaults.`, EXIT_REFUSED);
    }
    writeContract(dir, defaultRules());
    return out(`  wrote ${contractPath(dir)} with the default rules`);
  }

  const toggle = (on) => {
    const key = flag(args, on ? "--enable" : "--disable");
    const c = readContract(dir);
    if (c.error) return fail(json, c.error, EXIT_UNUSABLE);
    if (!c.contract.rules[key]) {
      return fail(json, `there is no rule for "${key}" in ${c.file}`, EXIT_UNUSABLE);
    }
    c.contract.rules[key].enabled = on;
    writeJsonAtomic(c.file, c.contract);
    out(`  ${key} is now ${on ? "enabled" : "disabled"} in ${c.file}`);
    if (!on) out(`  This is a recorded opt-out. It shows up in the diff and in every report.`);
    return undefined;
  };
  if (flag(args, "--disable") !== undefined) return toggle(false);
  if (flag(args, "--enable") !== undefined) return toggle(true);

  const c = readContract(dir);
  if (c.error) return fail(json, c.error, EXIT_UNUSABLE);
  if (json) return out(JSON.stringify({ ok: true, file: c.file, rules: c.contract.rules }, null, 2));
  out(`\n  ${c.file}\n`);
  out(`  metric                kind           warn    fail    abs      floor   drop`);
  for (const [k, r] of Object.entries(c.contract.rules)) {
    out(
      `  ${(r.enabled ? k : `${k} (off)`).padEnd(21)} ${r.kind.padEnd(14)} ${`${r.warn_pct}%`.padStart(5)}  ` +
        `${`${r.fail_pct}%`.padStart(6)}  ${(r.fail_abs === null || r.fail_abs === undefined ? "-" : fmt(r.fail_abs, METRICS[k].unit)).padStart(7)}  ` +
        `${fmt(r.floor, METRICS[k].unit).padStart(6)}  ${(r.suspect_drop_pct === null || r.suspect_drop_pct === undefined ? "-" : `${r.suspect_drop_pct}%`).padStart(5)}`,
    );
  }
  out();
}

async function cmdCompare(args) {
  const json = args.includes("--json");
  const dir = openDir(args, json);
  if (!dir) return;

  const base = readBaseline(dir);
  if (base.error) return fail(json, base.error, EXIT_UNUSABLE);
  const contract = readContract(dir);
  if (contract.error) return fail(json, contract.error, EXIT_UNUSABLE);

  // Every metric in the baseline must have a rule. "No rule" is not "no
  // opinion", it is an unthresholded metric being counted as a pass.
  const unruled = Object.keys(base.baseline.metrics).filter((k) => !contract.contract.rules[k]);
  if (unruled.length) {
    return fail(
      json,
      `the baseline contains ${unruled.length} metric(s) with no rule in ${contract.file}: ${unruled.join(", ")}. ` +
        `An unthresholded metric is not a passing metric. Add a rule, or drop the metric by re-capturing the baseline.`,
      EXIT_UNUSABLE,
    );
  }
  const gating = Object.keys(base.baseline.metrics).filter((k) => contract.contract.rules[k].enabled);
  if (!gating.length) {
    return fail(
      json,
      `every rule covering this baseline is disabled in ${contract.file}, so a comparison would check nothing. ` +
        `A run in which nothing was compared is not a pass.`,
      EXIT_UNUSABLE,
    );
  }

  const url = flag(args, "--url") ?? base.baseline.url;
  const parsed = parseUrl(url);
  if (parsed.error) return fail(json, parsed.error, EXIT_UNUSABLE);
  if (parsed.url.href !== base.baseline.url && !args.includes("--allow-different-url")) {
    return fail(
      json,
      `the baseline measured ${base.baseline.url} and this run was asked to measure ${parsed.url.href}. ` +
        `Comparing two different pages produces a number that means nothing. Pass --allow-different-url if you meant it.`,
      EXIT_REFUSED,
    );
  }

  // Environment identity. A baseline captured on another machine compared here
  // is confident nonsense; gstack records a branch field and never reads it.
  if (!args.includes("--allow-cross-env")) {
    const now = envIdentity();
    const was = base.baseline.env ?? {};
    const diffs = ["host", "platform", "arch", "node"].filter((k) => was[k] && was[k] !== now[k]);
    if (diffs.length) {
      return fail(
        json,
        `the baseline was captured on a different environment (${diffs.map((k) => `${k}: ${was[k]} -> ${now[k]}`).join(", ")}). ` +
          `Timing numbers do not transfer across machines and byte numbers can differ across builds. ` +
          `Pass --allow-cross-env if you have a reason.`,
        EXIT_REFUSED,
      );
    }
  }

  const maxAge = parseDuration(flag(args, "--max-age") ?? "14d");
  if (maxAge === null) return fail(json, "--max-age takes a value like 14d", EXIT_UNUSABLE);
  const capturedAt = Date.parse(base.baseline.capturedAt ?? "");
  if (!Number.isFinite(capturedAt)) {
    return fail(json, `${base.file} has no usable capturedAt, so its age cannot be checked`, EXIT_UNUSABLE);
  }
  const age = Date.now() - capturedAt;
  if (age > maxAge) {
    return fail(
      json,
      `the baseline is ${Math.round(age / 86400000)} day(s) old (limit ${Math.round(maxAge / 86400000)} days). ` +
        `An old baseline turns a slow accumulation into a permanent pass. Re-capture it, or raise --max-age deliberately.`,
      EXIT_REFUSED,
    );
  }

  const opts = measureOptions(args);
  if (opts.error) return fail(json, opts.error, EXIT_UNUSABLE);
  const pendingMaxAge = parseDuration(flag(args, "--pending-max-age") ?? "15m");
  if (pendingMaxAge === null) return fail(json, "--pending-max-age takes a value like 15m", EXIT_UNUSABLE);

  const m = await measure(parsed.url.href, opts);
  const pending = readPending(dir, pendingMaxAge);
  if (pending.error) return fail(json, pending.error, EXIT_UNUSABLE);

  // A failed measurement is a failure, never an absence. This is the branch
  // gstack has no state for: with `$B` empty the metrics simply never arrive.
  if (m.error) {
    const rows = Object.keys(base.baseline.metrics).map((k) =>
      judgeMetric(k, base.baseline.metrics[k], pending.fresh[k] ?? null, contract.contract.rules[k]),
    );
    const verdict = computeVerdict(rows);
    return finishCompare({ json, dir, base, contract, rows, verdict, url: parsed.url.href, opts, measureError: m.error, pending });
  }

  const current = { ...m.metrics, ...pending.fresh };
  const rows = Object.keys(base.baseline.metrics).map((k) =>
    judgeMetric(k, base.baseline.metrics[k], current[k] ?? null, contract.contract.rules[k]),
  );
  const newMetrics = Object.keys(current).filter((k) => !base.baseline.metrics[k]);
  return finishCompare({
    json,
    dir,
    base,
    contract,
    rows,
    verdict: computeVerdict(rows),
    url: parsed.url.href,
    opts,
    detail: m.detail,
    newMetrics,
    pending,
  });
}

function finishCompare(ctx) {
  const { json, dir, base, rows, verdict, url, opts, measureError, detail, newMetrics = [], pending } = ctx;
  const report = {
    _comment: "Toolbay Stack benchmark comparison. Computed from baseline.json and thresholds.json, not asserted.",
    url,
    verdict,
    at: new Date().toISOString(),
    baselineCapturedAt: base.baseline.capturedAt,
    baselineEnv: base.baseline.env,
    baselineGit: base.baseline.git,
    samples: opts.samples,
    measureError: measureError ?? null,
    stalePending: pending?.stale ?? [],
    rows,
    newMetrics,
    heaviest: detail?.resources?.slice(0, 10) ?? [],
    resourceFailures: detail?.failures ?? [],
  };
  fs.mkdirSync(reportsDir(dir), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonFile = path.join(reportsDir(dir), `${stamp}-benchmark.json`);
  writeJsonAtomic(jsonFile, report);

  const lines = [];
  const w = (s = "") => lines.push(s);
  w();
  w(`  ${url}`);
  w(`  baseline ${base.baseline.capturedAt}  ${base.baseline.git?.commit ? `at ${base.baseline.git.commit}` : ""}`);
  w(`  ${opts.samples} sample(s) now, ${base.baseline.samples ?? "?"} then`);
  w();
  if (measureError) {
    w(`  MEASUREMENT FAILED: ${measureError}`);
    w(`  Nothing below was measured this run. That is a failure, not a clean result.`);
    w();
  }
  const namew = Math.max(...rows.map((r) => r.key.length), 10);
  w(`  ${"metric".padEnd(namew)}  ${"baseline".padStart(10)}  ${"current".padStart(10)}  ${"delta".padStart(10)}   status`);
  for (const r of rows) {
    w(
      `  ${r.key.padEnd(namew)}  ${fmt(r.base, r.unit).padStart(10)}  ${fmt(r.cur, r.unit).padStart(10)}  ` +
        `${fmtDelta(r.delta ?? null, r.unit).padStart(10)}   ${r.status.toUpperCase()}`,
    );
  }
  const notable = rows.filter((r) => !["ok", "improved"].includes(r.status));
  if (notable.length) {
    w();
    for (const r of notable) w(`  ${r.status.toUpperCase()}  ${r.key}: ${r.detail}`);
  }
  if (pending?.stale?.length) {
    w();
    w(`  ignored as stale: ${pending.stale.join(", ")}`);
  }
  if (newMetrics.length) {
    w();
    w(`  measured now but not in the baseline (not gated): ${newMetrics.join(", ")}`);
  }
  if (detail?.failures?.length) {
    w();
    w(`  ${detail.failures.length} subresource(s) did not answer:`);
    for (const f of detail.failures.slice(0, 5)) w(`    - ${f}`);
  }
  if (detail?.resources?.length) {
    w();
    w(`  heaviest resources`);
    for (const r of detail.resources.slice(0, 5)) w(`    ${fmt(r.bytes, "bytes").padStart(8)}  ${r.kind.padEnd(5)} ${r.url}`);
  }
  w();
  w(`  ${verdict}`);
  w();

  const mdFile = path.join(reportsDir(dir), `${stamp}-benchmark.md`);
  fs.writeFileSync(mdFile, `# benchmark ${verdict}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`, "utf8");

  if (json) out(JSON.stringify({ ok: verdict === "PASS", ...report, reportJson: jsonFile, reportMd: mdFile }, null, 2));
  else {
    for (const l of lines) out(l);
    out(`  report ${jsonFile}`);
    out();
  }
  if (verdict !== "PASS") process.exitCode = EXIT_FAILED;
}

// ------------------------------------------------------------------ selftest
//
// Every case below is a way a performance check reports "no regression" without
// having established one. The fixture is a real HTTP server in its own process
// (spawnSync blocks this one), and the CLI is driven as a child process, because
// that is how it is used.

function runFixture() {
  const state = { jsBytes: 1000, jitter: 0 };
  const body = (n, ch = "x") => Buffer.alloc(n, ch);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, buf, type = "text/html; charset=utf-8", delay = 0) => {
      const finish = () => {
        res.writeHead(code, { "content-type": type, "content-length": Buffer.byteLength(buf) });
        res.end(buf);
      };
      if (delay > 0) setTimeout(finish, delay);
      else finish();
    };
    switch (url.pathname) {
      case "/":
        return send(
          200,
          '<html><head><link rel="stylesheet" href="/styles.css">' +
            '<script src="/app.js"></script><script src="/vendor.js"></script></head>' +
            '<body><img src="/hero.png"></body></html>',
        );
      case "/entities":
        // How every framework writes a query string into HTML. Fetch it without
        // decoding the entity and the second parameter is called "amp;q".
        return send(200, '<html><body><img src="/img?w=64&amp;q=75"></body></html>');
      case "/img":
        if (url.searchParams.get("q") !== "75") return send(400, "bad request", "text/plain");
        return send(200, body(700), "image/png");
      case "/missing-asset":
        return send(200, '<html><head><script src="/nope.js"></script></head><body>hi</body></html>');
      case "/app.js":
        return send(200, body(state.jsBytes), "application/javascript");
      case "/vendor.js":
        return send(200, body(2000), "application/javascript");
      case "/styles.css":
        return send(200, body(500), "text/css");
      case "/hero.png":
        return send(200, body(1500), "image/png");
      case "/jitter": {
        // Alternating fast and slow, so a noisy baseline can be produced on
        // purpose rather than hoped for.
        state.jitter += 1;
        return send(200, "<html><body>jitter</body></html>", "text/html; charset=utf-8", state.jitter % 2 === 0 ? 400 : 0);
      }
      case "/set":
        state.jsBytes = Number(url.searchParams.get("js") || 1000);
        return send(200, `js=${state.jsBytes}`, "text/plain");
      case "/boom":
        return send(500, "internal error");
      case "/hang":
        return; // never answers, on purpose
      default:
        return send(404, "not found");
    }
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`PORT ${server.address().port}\n`));
}

function startFixtureServer() {
  const child = spawn(process.execPath, [SELF, "__fixture"], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the selftest fixture server did not report a port within 10s"));
    }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /^PORT (\d+)/m.exec(buf);
      if (!m) return;
      clearTimeout(timer);
      const port = Number(m[1]);
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        // node:http with agent:false, not fetch. fetch pools its sockets, and a
        // pooled socket that the fixture closed while the selftest was busy
        // spawning child processes comes back as ECONNRESET on the next control
        // message. That crashed the suite before this was written down.
        setJs: (n) =>
          new Promise((res, rej) => {
            const req = http.get(
              { host: "127.0.0.1", port, path: `/set?js=${n}`, agent: false, timeout: 5000 },
              (r) => {
                r.resume();
                r.on("end", () => (r.statusCode === 200 ? res() : rej(new Error(`fixture said ${r.statusCode}`))));
              },
            );
            req.on("error", rej);
            req.on("timeout", () => {
              req.destroy();
              rej(new Error("fixture control request timed out"));
            });
          }),
        close: () => child.kill(),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (!/^PORT /m.test(buf)) {
        clearTimeout(timer);
        reject(new Error(`the selftest fixture server exited with code ${code} before serving`));
      }
    });
  });
}

/** A stand-in for the browse engine that lies in one specific way. */
const BROWSE_STUBS = {
  ok: `process.stdout.write("--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: http://x/) ---\\n{\\"fcp_ms\\":420,\\"lcp_ms\\":800,\\"dom_interactive_ms\\":600,\\"dom_complete_ms\\":1200,\\"full_load_ms\\":1400}\\n--- END UNTRUSTED EXTERNAL CONTENT ---\\n");`,
  crash: `process.exit(1);`,
  // Exit 0, no output at all: what an unset $B or a dead daemon produces.
  empty: `process.exit(0);`,
  // Exit 0, wrapper present, payload empty: what browse does after a failed goto.
  chromeerror: `process.stdout.write("--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: chrome-error://chromewebdata/) ---\\n\\n--- END UNTRUSTED EXTERNAL CONTENT ---\\n");`,
  garbage: `process.stdout.write("--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: http://x/) ---\\n(no console messages)\\n--- END UNTRUSTED EXTERNAL CONTENT ---\\n");`,
  nulls: `process.stdout.write("--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: http://x/) ---\\n{\\"fcp_ms\\":null,\\"lcp_ms\\":null,\\"dom_interactive_ms\\":null,\\"dom_complete_ms\\":null,\\"full_load_ms\\":null}\\n--- END UNTRUSTED EXTERNAL CONTENT ---\\n");`,
  negative: `process.stdout.write("--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: http://x/) ---\\n{\\"fcp_ms\\":-1}\\n--- END UNTRUSTED EXTERNAL CONTENT ---\\n");`,
};

function plantBrowseStub(dir, kind) {
  const file = path.join(dir, `stub-${kind}.mjs`);
  const src =
    `const args = process.argv.slice(2);\n` +
    `const isEval = args.includes("eval");\n` +
    `if (!isEval) { process.exit(${kind === "crash" ? 1 : 0}); }\n` +
    `${BROWSE_STUBS[kind]}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, src, "utf8");
  return file;
}

function runSelf(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function selftest() {
  const fixture = await startFixtureServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-benchmark-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const D = (n) => ["--dir", path.join(tmp, n)];
  const S = ["--samples", "2"];
  const baselineOf = (n) => parseJson(fs.readFileSync(baselinePath(path.join(tmp, n)), "utf8"));
  const compareOf = (n, extra = []) => {
    const r = runSelf(["compare", "--json", ...D(n), ...S, ...extra]);
    return { status: r.status, json: parseJson(r.stdout), raw: `${r.stdout}${r.stderr}` };
  };
  const statusOf = (res, key) => res.json.rows?.find((x) => x.key === key)?.status ?? "(none)";

  try {
    await fixture.setJs(1000);

    // ---- the happy path really passes, or nothing below means anything
    {
      const b = runSelf(["baseline", "--json", "--url", `${fixture.base}/`, ...D("good"), ...S]);
      check("baseline captures a page", 0, b.status, b.stderr.slice(0, 300));
      const j = parseJson(b.stdout);
      check("...and counts the subresources it fetched", 5, j.metrics?.requests?.median ?? 0, JSON.stringify(j.metrics?.requests));
      check("...and separates js bytes from the rest", 3000, j.metrics?.js_bytes?.median ?? 0, JSON.stringify(j.metrics?.js_bytes));
      check("...and records the machine it ran on", true, Boolean(j.metrics) && Boolean(baselineOf("good").env?.host));
      check("...and writes a threshold contract next to it", true, fs.existsSync(contractPath(path.join(tmp, "good"))));
      const c = compareOf("good");
      check("compare against an unchanged page passes", 0, c.status, c.raw.slice(-400));
      check("...with verdict PASS", "PASS", c.json.verdict ?? "(none)");
    }

    // ---- a real regression, computed rather than eyeballed
    {
      runSelf(["baseline", "--url", `${fixture.base}/`, ...D("regress"), ...S]);
      await fixture.setJs(200000);
      const c = compareOf("regress");
      check("a bundle that grew 200x is a REGRESSION", "REGRESSION", c.json.verdict ?? "(none)");
      check("...exit 1, so it can gate a ship", 1, c.status);
      check("...naming js_bytes", "regression", statusOf(c, "js_bytes"));
      check("...and total_bytes with it", "regression", statusOf(c, "total_bytes"));
      check("...and a report lands on disk", true, fs.existsSync(c.json.reportJson ?? ""), c.json.reportJson ?? "");
      await fixture.setJs(1000);
    }

    // ---- the one-sided-threshold hole: a broken build scores as an improvement
    {
      await fixture.setJs(200000);
      runSelf(["baseline", "--url", `${fixture.base}/`, ...D("collapse"), ...S]);
      await fixture.setJs(500);
      const c = compareOf("collapse");
      check("a bundle that COLLAPSED is suspect, not a win (gstack scores it as an improvement)", "suspect", statusOf(c, "js_bytes"));
      check("...and the run fails", 1, c.status);
      await fixture.setJs(1000);
    }

    // ---- a subresource that stopped answering
    {
      runSelf(["baseline", "--url", `${fixture.base}/missing-asset`, ...D("brokenasset"), ...S]);
      const b = baselineOf("brokenasset");
      check("a page whose script 404s records the failure as a metric", 1, b.metrics?.failed_requests?.median ?? -1);
    }

    // ---- crying wolf is the other way to be useless
    {
      const r = runSelf(["measure", "--json", "--url", `${fixture.base}/entities`, "--samples", "1"]);
      const m = parseJson(r.stdout).metrics ?? {};
      check("an &amp; in a resource url is decoded, not fetched literally", 0, m.failed_requests?.median ?? -1, r.stdout.slice(0, 300));
      check("...and the resource behind it is counted", 700, m.img_bytes?.median ?? -1);
    }

    // ---- no baseline, bad baseline, bad contract: none of them are a pass
    check(
      "compare with no baseline at all is UNUSABLE, not 'no regression'",
      2,
      runSelf(["compare", "--json", ...D("never-baselined")]).status,
    );
    {
      const dir = path.join(tmp, "corrupt");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(baselinePath(dir), "{ not json", "utf8");
      check("a corrupt baseline is UNUSABLE, not a pass", 2, runSelf(["compare", "--json", "--dir", dir]).status);
    }
    {
      const dir = path.join(tmp, "nocontract");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      fs.rmSync(contractPath(dir), { force: true });
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      check("a missing threshold contract stops the run", 2, r.status);
      check("...rather than defaulting to 'nothing to fail on'", true, /no threshold contract/.test(r.stdout), r.stdout.slice(0, 200));
    }
    {
      const dir = path.join(tmp, "badcontract");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      fs.writeFileSync(contractPath(dir), "{ nope", "utf8");
      check("a corrupt threshold contract stops the run", 2, runSelf(["compare", "--json", "--dir", dir, ...S]).status);
    }
    {
      const dir = path.join(tmp, "typo-contract");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const c = parseJson(fs.readFileSync(contractPath(dir), "utf8"));
      c.rules.js_bytes.fail_percent = 25; // the typo that silently does nothing
      fs.writeFileSync(contractPath(dir), JSON.stringify(c), "utf8");
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      check("a misspelled threshold key is refused, not ignored", 2, r.status);
      check("...and the key is named", true, /fail_percent/.test(r.stdout), r.stdout.slice(0, 300));
    }
    {
      const dir = path.join(tmp, "inverted");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const c = parseJson(fs.readFileSync(contractPath(dir), "utf8"));
      c.rules.js_bytes.fail_pct = 1;
      c.rules.js_bytes.warn_pct = 90;
      fs.writeFileSync(contractPath(dir), JSON.stringify(c), "utf8");
      check("a contract where fail is below warn is refused", 2, runSelf(["compare", "--json", "--dir", dir, ...S]).status);
    }
    {
      const dir = path.join(tmp, "unruled");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const c = parseJson(fs.readFileSync(contractPath(dir), "utf8"));
      delete c.rules.js_bytes;
      fs.writeFileSync(contractPath(dir), JSON.stringify(c), "utf8");
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      check("a baseline metric with NO rule stops the run", 2, r.status);
      check("...and says which metric is unthresholded", true, /js_bytes/.test(r.stdout), r.stdout.slice(0, 300));
    }
    {
      const dir = path.join(tmp, "alloff");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const c = parseJson(fs.readFileSync(contractPath(dir), "utf8"));
      for (const k of Object.keys(c.rules)) c.rules[k].enabled = false;
      fs.writeFileSync(contractPath(dir), JSON.stringify(c), "utf8");
      check("a comparison where every rule is disabled is UNUSABLE, not a pass", 2, runSelf(["compare", "--json", "--dir", dir, ...S]).status);
    }
    {
      const dir = path.join(tmp, "oneoff");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      runSelf(["thresholds", "--dir", dir, "--disable", "ttfb_ms"]);
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      const j = parseJson(r.stdout);
      check("a deliberately disabled metric is reported as disabled, not skipped", "disabled", j.rows?.find((x) => x.key === "ttfb_ms")?.status ?? "(none)");
      check("...and the rest of the run still passes", 0, r.status, r.stderr.slice(0, 200));
    }

    // ---- the measurement itself failing
    {
      const dir = path.join(tmp, "dead");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const deadServer = http.createServer();
      await new Promise((r) => deadServer.listen(0, "127.0.0.1", r));
      const deadPort = deadServer.address().port;
      await new Promise((r) => deadServer.close(r));
      const r = runSelf(["compare", "--json", "--dir", dir, ...S, "--url", `http://127.0.0.1:${deadPort}/`, "--allow-different-url"]);
      const j = parseJson(r.stdout);
      check("an origin that does not answer FAILS the comparison", 1, r.status);
      check("...as UNMEASURED, never as 'nothing got worse'", "UNMEASURED", j.verdict ?? "(none)");
      check("...with every metric marked unmeasured", "unmeasured", j.rows?.find((x) => x.key === "total_bytes")?.status ?? "(none)");
    }
    check("measuring a 500 is refused rather than benchmarked", 1, runSelf(["measure", "--json", "--url", `${fixture.base}/boom`, "--samples", "1"]).status);
    check(
      "a request that never answers is a failure, not a fast page",
      1,
      runSelf(["measure", "--json", "--url", `${fixture.base}/hang`, "--samples", "1", "--timeout", "400ms"]).status,
    );

    // ---- browser metrics: the part that needs the browse daemon
    {
      const dir = path.join(tmp, "browser");
      const stub = plantBrowseStub(path.join(tmp, "stubs"), "ok");
      const c1 = runSelf(["collect", "--json", "--dir", dir, "--url", `${fixture.base}/`, "--browse", stub]);
      check("collect records browser metrics through the browse engine", 0, c1.status, c1.stderr.slice(0, 200));
      check("...including fcp", 420, parseJson(c1.stdout).metrics?.fcp_ms ?? 0);
      runSelf(["baseline", "--dir", dir, "--url", `${fixture.base}/`, ...S]);
      const b = parseJson(fs.readFileSync(baselinePath(dir), "utf8"));
      check("...and they land in the baseline", 800, b.metrics?.lcp_ms?.median ?? 0);

      // Now compare WITHOUT collecting: the browser metric is simply absent.
      const noCollect = runSelf(["compare", "--json", "--dir", dir, ...S, "--pending-max-age", "0s"]);
      const j = parseJson(noCollect.stdout);
      check("a baseline browser metric that nobody measured this run FAILS", 1, noCollect.status);
      check("...as unmeasured", "unmeasured", j.rows?.find((x) => x.key === "lcp_ms")?.status ?? "(none)");
      check("...and the verdict is UNMEASURED", "UNMEASURED", j.verdict ?? "(none)");

      // Collect again, fresh: now it compares.
      runSelf(["collect", "--dir", dir, "--url", `${fixture.base}/`, "--browse", stub]);
      const withCollect = runSelf(["compare", "--json", "--dir", dir, ...S]);
      check("...and passes once it is measured again", 0, withCollect.status, withCollect.stderr.slice(0, 200));
    }
    {
      const stubs = path.join(tmp, "stubs");
      const dir = (n) => path.join(tmp, `stub-${n}`);
      const collect = (kind) =>
        runSelf(["collect", "--json", "--dir", dir(kind), "--url", `${fixture.base}/`, "--browse", plantBrowseStub(stubs, kind)]);
      const wrote = (kind) => fs.existsSync(pendingPath(dir(kind)));
      for (const [kind, why] of [
        ["crash", "the browser could not load the page"],
        ["empty", "the browser returned nothing at all (an unset $B produces exactly this)"],
        ["chromeerror", "the browser answered from the chrome error page"],
        ["garbage", "the browser returned prose instead of JSON"],
        ["nulls", "the browser answered with every metric null (a page that never painted)"],
        ["negative", "the browser reported a negative time"],
      ]) {
        const r = collect(kind);
        check(`collect fails when ${why}`, 1, r.status, r.stdout.slice(0, 160));
        check(`...and records nothing (${kind})`, false, wrote(kind));
      }
      const missing = runSelf([
        "collect",
        "--json",
        "--dir",
        path.join(tmp, "nobrowse"),
        "--url",
        `${fixture.base}/`,
        "--browse",
        path.join(tmp, "does-not-exist.mjs"),
      ]);
      check(
        "collect with a browse engine that is not there is UNUSABLE, and does not quietly use a different one",
        2,
        missing.status,
        missing.stdout.slice(0, 200),
      );
    }

    // ---- re-baselining is how a regression stops being one
    {
      const dir = path.join(tmp, "rebase");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      await fixture.setJs(300000);
      const again = runSelf(["baseline", "--json", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      check("re-baselining over an existing baseline is REFUSED", 3, again.status);
      check("...and prints the regression it would have buried", true, /js_bytes/.test(again.stdout), again.stdout.slice(0, 400));
      check("...unless --force", 0, runSelf(["baseline", "--json", "--url", `${fixture.base}/`, "--dir", dir, ...S, "--force"]).status);
      await fixture.setJs(1000);
    }

    // ---- provenance: whose numbers are these
    {
      const dir = path.join(tmp, "crossenv");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const b = parseJson(fs.readFileSync(baselinePath(dir), "utf8"));
      b.env.host = "somebody-elses-laptop";
      fs.writeFileSync(baselinePath(dir), JSON.stringify(b), "utf8");
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      check("a baseline from another machine is REFUSED", 3, r.status);
      check("...and names what differs", true, /somebody-elses-laptop/.test(r.stdout), r.stdout.slice(0, 300));
      check("...unless --allow-cross-env", 0, runSelf(["compare", "--json", "--dir", dir, ...S, "--allow-cross-env"]).status);
    }
    {
      const dir = path.join(tmp, "stale");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      const b = parseJson(fs.readFileSync(baselinePath(dir), "utf8"));
      b.capturedAt = new Date(Date.now() - 60 * 86400000).toISOString();
      fs.writeFileSync(baselinePath(dir), JSON.stringify(b), "utf8");
      check("a 60 day old baseline is REFUSED", 3, runSelf(["compare", "--json", "--dir", dir, ...S]).status);
      check("...unless --max-age says otherwise", 0, runSelf(["compare", "--json", "--dir", dir, ...S, "--max-age", "365d"]).status);
    }
    {
      const dir = path.join(tmp, "otherurl");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, ...S]);
      check(
        "comparing a different page against this baseline is REFUSED",
        3,
        runSelf(["compare", "--json", "--dir", dir, ...S, "--url", `${fixture.base}/missing-asset`]).status,
      );
    }

    // ---- noise, in both directions
    {
      const dir = path.join(tmp, "noisy");
      runSelf(["baseline", "--url", `${fixture.base}/jitter`, "--dir", dir, ...S]);
      const r = runSelf(["compare", "--json", "--dir", dir, ...S]);
      const j = parseJson(r.stdout);
      check("a baseline too noisy to gate on is INCONCLUSIVE, not PASS", "INCONCLUSIVE", j.verdict ?? "(none)");
      check("...exit 1", 1, r.status);
      check("...on the timing metric that jittered", "inconclusive", j.rows?.find((x) => x.key === "ttfb_ms")?.status ?? "(none)");
    }
    {
      // The other direction: a tiny absolute move on a fast metric must not be
      // called a regression just because the percentage is large.
      const dir = path.join(tmp, "quiet");
      runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", dir, "--samples", "3"]);
      const j = parseJson(runSelf(["compare", "--json", "--dir", dir, "--samples", "3"]).stdout);
      const ttfb = j.rows?.find((x) => x.key === "ttfb_ms");
      check("a millisecond wobble on a localhost metric is not a regression", true, ["ok", "improved"].includes(ttfb?.status), JSON.stringify(ttfb));
    }

    // ---- record
    {
      const dir = path.join(tmp, "record");
      check("record refuses a metric it would never compare", 2, runSelf(["record", "--json", "--dir", dir, "--metric", "lcp", "--value", "5"]).status);
      check("record refuses a value that is not a number", 2, runSelf(["record", "--json", "--dir", dir, "--metric", "lcp_ms", "--value", "fast"]).status);
      const shot = path.join(dir, "empty.png");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(shot, "");
      check(
        "record refuses a 0-byte artifact as evidence",
        3,
        runSelf(["record", "--json", "--dir", dir, "--metric", "lcp_ms", "--value", "900", "--evidence", shot]).status,
      );
      check("record accepts a real measurement", 0, runSelf(["record", "--json", "--dir", dir, "--metric", "lcp_ms", "--value", "900"]).status);
    }

    // ---- arguments
    check("measure requires a url", 2, runSelf(["measure", "--json"]).status);
    check("a non-http url is refused", 2, runSelf(["measure", "--json", "--url", "ftp://x/y"]).status);
    check("--samples 0 is refused", 2, runSelf(["measure", "--json", "--url", `${fixture.base}/`, "--samples", "0"]).status);
    if (isWindows) {
      const r = runSelf(["baseline", "--url", `${fixture.base}/`, "--dir", "/tmp/bench"]);
      check("/tmp is refused on Windows, where it names two directories", 3, r.status);
      check(
        "...and both of them are printed",
        true,
        /AppData[\\/]Local[\\/]Temp/.test(`${r.stdout}${r.stderr}`) && /C:[\\/]tmp[\\/]bench/.test(`${r.stdout}${r.stderr}`),
        `${r.stdout}${r.stderr}`.slice(0, 200),
      );
    }
  } finally {
    fixture.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-benchmark selftest  (node ${process.version}, ${process.platform})\n`);
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
  out("\n  Every case above is a way a performance check reports no regression without");
  out("  having established one: no baseline, a corrupt one, one from another machine,");
  out("  one too old or too noisy to mean anything, a threshold file with a typo in it,");
  out("  a metric with no threshold at all, a browser that answered with nothing, and");
  out("  the big one, a bundle that COLLAPSED because the build broke, which every");
  out("  threshold in gstack's list scores as an improvement. None of them reach PASS.\n");
}

// --------------------------------------------------------------------- help

function help() {
  out(`
  tb-benchmark ${VERSION}  (Toolbay Stack)

  Before the change:
    baseline --url <u> [--samples 3]      measure and store the reference point
                                          (also writes thresholds.json if absent)
  After it:
    compare  [--url <u>] [--samples 3]    measure again, judge, exit non-zero on
                                          a regression
  Anytime:
    measure  --url <u> [--samples 3]      numbers only, no judgement
    collect  --browser --url <u>          paint/LCP/DOM timings via the browse
                                          engine, into the next baseline/compare
    record   --metric <k> --value <n>     a metric measured some other way
                                          [--evidence <file>] [--source <s>]
    thresholds [--init] [--disable <k>] [--enable <k>]
                                          show or edit the gate

  Options: --json, --dir <d>, --timeout 20s, --max-resources 60,
           --no-subresources, --max-age 14d, --pending-max-age 15m,
           --allow-cross-env, --allow-different-url, --force

  Verdicts: PASS (0), REGRESSION (1), UNMEASURED (1), INCONCLUSIVE (1).
  Exit 2 = the baseline or the contract is unusable. Exit 3 = refused.

  Every metric in the baseline must have a rule in thresholds.json or the run
  stops: an unthresholded metric is not a passing metric. Opting out is allowed
  and is written down (--disable), so it shows up in a diff and in every report.

  A metric the baseline has and this run does not is UNMEASURED, which fails.
  A deterministic metric that COLLAPSED is suspect, which fails, because a
  bundle does not lose half its weight by accident.
`);
}

// -------------------------------------------------------------------- entry

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

if (cmd === "measure") await cmdMeasure(rest);
else if (cmd === "baseline") await cmdBaseline(rest);
else if (cmd === "compare") await cmdCompare(rest);
else if (cmd === "collect") cmdCollect(rest);
else if (cmd === "record") cmdRecord(rest);
else if (cmd === "thresholds") cmdThresholds(rest);
else if (cmd === "selftest") await selftest();
else if (cmd === "__fixture") runFixture(); // selftest support, not a user command
else help();
