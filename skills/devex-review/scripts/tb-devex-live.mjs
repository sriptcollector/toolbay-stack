#!/usr/bin/env node
/**
 * tb-devex-live.mjs: the measured half of /devex-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The audit this supports (the `/devex-review` command; dogfooding
 * a live developer product rather than reviewing a plan; the DX First Principles;
 * the Seven DX Characteristics; the 0-10 scoring rubric and the gap method; the
 * eight audit dimensions Getting Started / API-CLI-SDK / Error Messages /
 * Documentation / Upgrade Path / Dev Environment / Community / DX Measurement;
 * the TESTED / PARTIAL / INFERRED evidence method; the TTHW benchmark tiers
 * Champion / Competitive / Needs Work / Red Flag; and the boomerang comparison
 * against a prior plan review) comes from `devex-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or endorsed
 * by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's /devex-review is prose. Measured on Windows 11, gstack 1.60.1.0,
 * 2026-08-14:
 *
 *     $ ls ~/.claude/skills/gstack/devex-review/
 *     SKILL.md  SKILL.md.tmpl
 *
 *     $ grep -cE '^\s*(node|bun|python|\./)' devex-review/SKILL.md.tmpl
 *     0
 *
 * Nothing in it executes, and the four consequences below all fail in the
 * direction that reads as a completed audit.
 *
 * 1. THE BROWSER COMMANDS SILENTLY BROWSE NOTHING. The skill's SETUP block
 *    (SKILL.md:846-856) assigns the browse binary to the shell variable `$B`,
 *    and every later instruction spends it: "Navigate to the docs/landing page
 *    via browse. Screenshot it." (:991), "Screenshot each error." (:1019). In
 *    Claude Code every Bash call is a fresh shell, so `$B` is empty by the next
 *    tool call and `$B goto <url>` is not an error the flow can see. Reproduced
 *    here, in a fresh shell, 2026-08-14:
 *
 *      $ $B goto https://example.com
 *      /usr/bin/bash: line 8: goto: command not found
 *      exit=127                                     <- and stdout is EMPTY
 *
 *    There is no state anywhere in that skill for "the screenshot did not
 *    happen". The scorecard's Evidence column is the literal token
 *    `[screenshots]` (:1078-1085), so a run in which zero screenshots were taken
 *    produces the same artifact as a run in which all of them were. Here every
 *    page step is delegated to the forked browse engine, its exit code is the
 *    step's verdict, and a step whose PNG is absent, zero bytes, not a PNG, or
 *    below a blank-canvas floor is `unverified` — a state that is neither a pass
 *    nor a score, and that propagates to the run verdict.
 *
 * 2. THE HEADLINE NUMBER IS LABELLED MEASURED AND IS SUMMED FROM ESTIMATES. The
 *    scorecard row is `| TTHW (measured) | __ min | [step count] | TESTED |`
 *    (:1087). The per-step cells it is summed from are
 *    `Step 1: [what dev does]  Time: [est]` (:996). The skill says estimate on
 *    line 996 and measured on line 1087, about the same number. Here TTHW is the
 *    sum of per-step durations taken from `process.hrtime.bigint()`, `verify`
 *    recomputes it from run.json, and a report whose stated TTHW does not match
 *    the recomputed one is refused.
 *
 * 3. THE SCORECARD IS A TEMPLATE OF BLANKS AND NOTHING CHECKS IT. Eight rows of
 *    `__/10` with `[screenshots]` or `[file refs]` for evidence. Pasted unfilled
 *    it is a finished-looking audit, and the model that pasted it is the only
 *    thing gstack asks whether the audit happened. Here the tool never emits a
 *    blank: a dimension with no evidence renders as UNMEASURED, `score` REFUSES a
 *    dimension that has no measured step and no evidence file that exists, and
 *    `verify` fails a report still carrying a placeholder.
 *
 * 4. THE AUDIT LEAVES NOTHING ON DISK. The deliverable is a scorecard in the
 *    conversation. A week later there is no run to re-open, no screenshot to
 *    compare against, and the "re-run /devex-review after fixes to verify
 *    improvement" step (:1298) has nothing to diff. Here a run is a directory:
 *    run.json, report.md, shots/, logs/ — timestamped, named with a Windows-legal
 *    id (an ISO string contains colons, which cannot be in a Windows filename),
 *    and independently checkable by `verify` long after the session is gone.
 *
 * Design rules, the same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. Nothing returns "fine" because a check could not run. If the
 *     browse daemon is down, a run containing page steps is REFUSED before a
 *     single artifact is written, rather than scored from whatever came back.
 *   - NO INTERPRETER BUT NODE. No `$B`, no `source <(...)`, no `find -mmin`, no
 *     `$PPID`, no `date +%s`, no `open`, no `/tmp`, no jq, no bun. Every one of
 *     those is in the gstack version of this skill's preamble.
 *   - PROVE IT. `selftest` runs this executable as a child process against a
 *     browser that lies in each documented way, and against reports that have
 *     been tampered with, and fails loudly if any lie is believed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { checkArtifact, makePngOfSize } from "./tb-artifact.mjs";
import { AMBIGUOUS_ON_WINDOWS, resolveOutDir as resolveOutDirShared } from "./tb-outdir.mjs";

/**
 * This skill's output directory. The refusal and the resolution are shared
 * (src/outdir/tb-outdir.mjs); only the default and the consequence sentence
 * are this skill's.
 */
function resolveOutDir(raw) {
  return resolveOutDirShared(raw, {
    defaultDir: process.env.TOOLBAY_DEVEX_DIR || path.join(process.cwd(), ".toolbay", "devex"),
    consequence: "The audit would be written to one and read back from the other, which reads as 'the run is gone'.",
  });
}


const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // ran, and everything it claims is backed
const EXIT_FINDINGS = 1; // ran, and found real DX defects
const EXIT_UNUSABLE = 2; // the input could not be read or is not a usable plan
const EXIT_UNVERIFIED = 3; // the audit itself could not be trusted to have happened

/**
 * gstack's eight dimensions, kept verbatim so a scorecard from either tool reads
 * the same. What is new is that a score here has to be backed.
 */
const DIMENSIONS = {
  "getting-started": "Getting Started",
  "api-cli-sdk": "API / CLI / SDK",
  "error-messages": "Error Messages",
  documentation: "Documentation",
  "upgrade-path": "Upgrade Path",
  "dev-environment": "Dev Environment",
  community: "Community",
  "dx-measurement": "DX Measurement",
};

/** gstack's TTHW table (SKILL.md:941-949), applied to a number that came from a clock. */
const TTHW_TIERS = [
  { max: 2 * 60 * 1000, tier: "Champion", note: "under 2 min" },
  { max: 5 * 60 * 1000, tier: "Competitive", note: "2-5 min" },
  { max: 10 * 60 * 1000, tier: "Needs Work", note: "5-10 min" },
  { max: Infinity, tier: "Red Flag", note: "over 10 min" },
];

/**
 * A screenshot smaller than this is treated as no evidence.
 *
 * A PNG signature is 8 bytes, so "is it a PNG" is satisfied by 8 bytes plus
 * anything. The failure this floor exists for is a capture of a page that never
 * painted: structurally perfect, a few hundred bytes, and indistinguishable from
 * a real screenshot in every check that only asks about the magic number.
 * Override with --min-shot-bytes when auditing something genuinely tiny.
 */
const DEFAULT_MIN_SHOT_BYTES = 1024;

// --------------------------------------------------------------------- paths

/** POSIX system directories that name two different places on Windows. */

function expand(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(looksAbsolute(s) ? s : path.join(process.cwd(), s));
}

/**
 * A run id that is a legal filename on Windows.
 *
 * `new Date().toISOString()` is 2026-08-14T07:42:11.030Z. The colons make it an
 * invalid Windows path component, so a directory named from it either throws
 * ENOENT or, through a shim, lands somewhere other than where it is read back
 * from. Both look like a missing run.
 */
function runIdFrom(date = new Date()) {
  return `devex-${date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}`;
}

function slug(s) {
  return (
    String(s)
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .toLowerCase() || "step"
  );
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

// ------------------------------------------------------------------ evidence

/**
 * A screenshot has to be a real PNG AND weigh enough to have painted.
 * src/artifact/tb-artifact.mjs is the one standard; the floor stays local
 * because what a painted page weighs is this skill's judgement.
 */
const checkPng = (file, floor) => checkArtifact(file, { requirePng: true, minBytes: floor });

function checkLog(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, why: `${file} is not a file` };
    return { ok: true, why: `${st.size} bytes`, bytes: st.size };
  } catch {
    return { ok: false, why: `no file at ${file}, though the run claims a command log` };
  }
}

// -------------------------------------------------------------- browse engine

function resolveBrowseScript(explicit) {
  const named = explicit ?? process.env.TOOLBAY_DEVEX_BROWSE_SCRIPT;
  if (named) {
    const abs = expand(named);
    if (!abs || !fs.existsSync(abs)) {
      return {
        error:
          `the browse engine you named does not exist: ${abs ?? named}. Refusing to fall back to a different one, ` +
          `because evidence collected through an engine you did not ask for is not the evidence you asked for.`,
      };
    }
    return { script: abs };
  }
  const candidates = [
    path.resolve(path.dirname(SELF), "..", "..", "browse", "scripts", "tb-browse.mjs"),
    path.join(os.homedir(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
    path.join(process.cwd(), ".claude", "skills", "browse", "scripts", "tb-browse.mjs"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return { script: path.resolve(c) };
  return {
    error:
      `the Toolbay Stack browse engine was not found (looked in ${candidates.join(", ")}). Page steps cannot be ` +
      `run without it, and a DX audit that skipped its page steps is not a DX audit with fewer steps, it is an ` +
      `audit of nothing. Install the browse skill, or run a plan with only cmd steps.`,
  };
}

function spawnNode(script, args, { timeoutMs = 180000, cwd = process.cwd(), env = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    status: r.status,
    stdout: (r.stdout || "").replace(/\r\n/g, "\n"),
    stderr: (r.stderr || "").replace(/\r\n/g, "\n"),
    timedOut: r.status === null,
    spawnError: r.error ? String(r.error.message || r.error) : null,
  };
}

/**
 * The gate that gstack does not have.
 *
 * `browse doctor` exits non-zero when the binary is missing OR when the daemon
 * does not answer. Running page steps past that point produces empty output that
 * is indistinguishable from a fast, clean page, so the run is refused here
 * instead — before a run directory exists, so there is no half-written artifact
 * to mistake for a result.
 */
function browseDoctor(script, timeoutMs) {
  const r = spawnNode(script, ["doctor"], { timeoutMs });
  const text = `${r.stdout}${r.stderr}`.trim();
  if (r.spawnError) return { ok: false, why: `could not run the browse engine: ${r.spawnError}`, text };
  if (r.timedOut) return { ok: false, why: `the browse engine did not answer within ${Math.round(timeoutMs / 1000)}s`, text };
  if (r.status !== 0) return { ok: false, why: `browse doctor exited ${r.status}`, text };
  const bin = /^\s*binary\s+(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? null;
  return { ok: true, binary: bin, text };
}

// ------------------------------------------------------------------ the plan

const PLAN_KEYS = new Set(["product", "baseUrl", "steps", "_comment", "notes"]);
const STEP_KEYS = new Set([
  "id",
  "kind",
  "label",
  "url",
  "selector",
  "allowConsoleErrors",
  "allowEmptyText",
  "argv",
  "cwd",
  "expectExit",
  "timeout",
  "dimension",
  "countsTowardTthw",
  "_why",
]);

/** "90s", "10m", "2h", "45" (seconds). Returns ms, or null. */
function parseDuration(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(raw).trim());
  if (!m) return null;
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[(m[2] || "s").toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

function validatePlan(plan, source) {
  const problems = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return [`${source} is not a JSON object`];
  for (const k of Object.keys(plan)) {
    if (!PLAN_KEYS.has(k)) {
      problems.push(`unknown top-level key "${k}". A key you think you set and did not is worse than not setting it, so this is refused rather than ignored. Accepted: ${[...PLAN_KEYS].join(", ")}`);
    }
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    problems.push(`"steps" must be a non-empty array. A run with no steps would produce a report backed by nothing`);
    return problems;
  }
  const ids = new Set();
  plan.steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push(`${at} is not an object`);
      return;
    }
    for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) problems.push(`${at}: unknown key "${k}". Accepted: ${[...STEP_KEYS].join(", ")}`);
    if (s.id !== undefined && typeof s.id !== "string") problems.push(`${at}: "id" must be a string`);
    const id = s.id || `step-${i + 1}`;
    if (ids.has(id)) problems.push(`${at}: duplicate id "${id}" — two steps would write to the same evidence file`);
    ids.add(id);
    if (s.kind !== "page" && s.kind !== "cmd") problems.push(`${at}: "kind" must be "page" or "cmd", got ${JSON.stringify(s.kind)}`);
    if (s.kind === "page") {
      if (typeof s.url !== "string" || !s.url.trim()) problems.push(`${at}: a page step needs a "url"`);
      else {
        try {
          const u = new URL(s.url);
          if (u.protocol !== "http:" && u.protocol !== "https:") problems.push(`${at}: "${s.url}" is not an http(s) URL`);
        } catch {
          problems.push(`${at}: "${s.url}" is not a URL. Include the scheme, for example https://example.com`);
        }
      }
    }
    if (s.kind === "cmd") {
      if (!Array.isArray(s.argv) || !s.argv.length || !s.argv.every((a) => typeof a === "string" && a.length)) {
        problems.push(`${at}: a cmd step needs "argv" as a non-empty array of strings. It is an array and not a string on purpose: splitting a command line on spaces produces a different command on Windows than it does in bash.`);
      }
      if (s.expectExit !== undefined && !Number.isInteger(s.expectExit)) problems.push(`${at}: "expectExit" must be a whole number`);
    }
    if (s.timeout !== undefined && parseDuration(s.timeout) === null) problems.push(`${at}: "timeout" takes a value like 60s or 2m`);
    if (s.dimension !== undefined && !DIMENSIONS[s.dimension]) {
      problems.push(`${at}: "${s.dimension}" is not a dimension. One of: ${Object.keys(DIMENSIONS).join(", ")}`);
    }
    if (s.countsTowardTthw !== undefined && typeof s.countsTowardTthw !== "boolean") problems.push(`${at}: "countsTowardTthw" must be true or false`);
  });
  return problems;
}

function readPlan(file) {
  const abs = expand(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { error: `${abs} could not be read (${e.code || e.message})` };
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    return { error: `${abs} is not valid JSON (${e.message}), so there is no plan to run` };
  }
  const problems = validatePlan(plan, abs);
  if (problems.length) return { error: `${abs} is not a usable plan:\n      - ${problems.join("\n      - ")}` };
  return { plan, file: abs };
}

// ------------------------------------------------------------------- running

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const round1 = (n) => Math.round(n * 10) / 10;

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${round1(ms / 1000)}s`;
  return `${round1(ms / 60000)} min`;
}

function tierFor(ms) {
  return TTHW_TIERS.find((t) => ms < t.max) ?? TTHW_TIERS[TTHW_TIERS.length - 1];
}

function runPageStep(step, ctx) {
  const shot = path.join(ctx.runDir, "shots", `${ctx.n}-${slug(step.id)}.png`);
  const args = ["verify", "--url", step.url, "--shot", shot, "--dir", path.join(ctx.runDir, "shots")];
  if (step.selector) args.push("--selector", step.selector);
  if (step.allowConsoleErrors) args.push("--allow-console-errors");
  if (step.allowEmptyText) args.push("--allow-empty-text");
  const timeoutMs = parseDuration(step.timeout) ?? ctx.timeoutMs;
  args.push("--timeout", String(Math.max(1, Math.round(timeoutMs / 1000))));

  const t0 = nowMs();
  const r = spawnNode(ctx.browseScript, args, { timeoutMs: timeoutMs + 15000 });
  const ms = round1(nowMs() - t0);

  const log = path.join(ctx.runDir, "logs", `${ctx.n}-${slug(step.id)}.txt`);
  writeTextAtomic(log, `$ node tb-browse.mjs ${args.join(" ")}\n\n${r.stdout}\n${r.stderr}\n`);

  const png = checkPng(shot, ctx.minShotBytes);
  const evidence = {
    shot: png.ok ? path.relative(ctx.runDir, shot).replace(/\\/g, "/") : null,
    log: path.relative(ctx.runDir, log).replace(/\\/g, "/"),
    shotBytes: png.bytes ?? null,
  };

  // No usable PNG means no evidence, whatever the exit code said. This is the
  // branch gstack has no state for at all.
  if (!png.ok) {
    return {
      status: "unverified",
      ms,
      evidence,
      detail: `no usable screenshot: ${png.why}${r.spawnError ? ` (browse could not start: ${r.spawnError})` : ""}`,
    };
  }
  if (r.spawnError || r.timedOut) {
    return { status: "unverified", ms, evidence, detail: r.spawnError ? `browse could not start: ${r.spawnError}` : `browse did not answer within ${fmtMs(timeoutMs)}` };
  }
  if (r.status === 3) {
    return { status: "unverified", ms, evidence, detail: `browse could not run the check (exit 3): ${firstFail(r.stdout) ?? "no reason printed"}` };
  }
  // Navigation failing and the page failing its checks are different answers.
  // If the browser never reached the site, the PNG on disk is a picture of
  // Chromium's own error page, so there is nothing here to have an opinion
  // about: that is unverified, not a finding about the product. gstack reads the
  // same state (empty text under a chrome-error source) as a page with nothing
  // to report.
  const nav = navigationFailure(r.stdout);
  if (nav) return { status: "unverified", ms, evidence, detail: nav };
  if (r.status !== 0) {
    return { status: "finding", ms, evidence, detail: firstFail(r.stdout) ?? `browse verify exited ${r.status}` };
  }
  return { status: "ok", ms, evidence, detail: `page verified, ${png.why}` };
}

/** The reason the browser never got to the page, or null if it did. */
function navigationFailure(stdout) {
  for (const line of stdout.split("\n")) {
    if (!/^\s*FAIL\s/.test(line)) continue;
    const l = line.trim().replace(/\s{2,}/g, "  ");
    if (/goto exits 0/.test(l)) return `the browser never navigated: ${l}`;
    if (/current url is the requested page/.test(l)) return `the browser ended up somewhere else, so nothing here is about the requested page: ${l}`;
    if (/page text is/.test(l) && /source=(chrome-error|about:blank)/i.test(l)) {
      return `the browser answered from its own error page, not the site: ${l}`;
    }
  }
  return null;
}

function firstFail(stdout) {
  const line = stdout.split("\n").find((l) => /^\s*FAIL\s/.test(l));
  return line ? line.trim().replace(/\s{2,}/g, "  ") : null;
}

function runCmdStep(step, ctx) {
  const timeoutMs = parseDuration(step.timeout) ?? ctx.timeoutMs;
  const expect = step.expectExit ?? 0;
  const cwd = step.cwd ? expand(step.cwd) : process.cwd();
  const log = path.join(ctx.runDir, "logs", `${ctx.n}-${slug(step.id)}.txt`);

  const t0 = nowMs();
  const r = spawnSync(step.argv[0], step.argv.slice(1), {
    encoding: "utf8",
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    // No shell. A command run through a shell is a different command on Windows
    // than in bash, and a DX audit that measures the shell's interpretation of
    // the install line has not measured the install line.
    shell: false,
  });
  const ms = round1(nowMs() - t0);
  const stdout = (r.stdout || "").replace(/\r\n/g, "\n");
  const stderrText = (r.stderr || "").replace(/\r\n/g, "\n");
  writeTextAtomic(
    log,
    `$ ${step.argv.join(" ")}\n  cwd: ${cwd}\n  exit: ${r.status === null ? "(no exit: killed)" : r.status}\n  ms: ${ms}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderrText}\n`,
  );
  const evidence = { log: path.relative(ctx.runDir, log).replace(/\\/g, "/"), exit: r.status, shot: null };

  if (r.error && /ENOENT/i.test(String(r.error.code || r.error.message))) {
    return {
      status: "unverified",
      ms,
      evidence,
      detail:
        `"${step.argv[0]}" could not be started (${r.error.code || r.error.message}). A command that never ran is ` +
        `not a command that ran quickly, so this step is not timed and not scored.`,
    };
  }
  if (r.error && r.status === null && !r.signal) {
    return { status: "unverified", ms, evidence, detail: `could not run "${step.argv[0]}": ${r.error.message}` };
  }
  if (r.status === null) {
    return {
      status: "finding",
      ms,
      evidence,
      truncated: true,
      detail: `the command did not finish within ${fmtMs(timeoutMs)} and was killed. A developer waiting on this sees no end to it.`,
    };
  }
  if (r.status !== expect) {
    const tail = (stderrText.trim() || stdout.trim()).split("\n").slice(-1)[0] ?? "";
    return { status: "finding", ms, evidence, detail: `exit ${r.status}, expected ${expect}${tail ? `. last line: ${tail.slice(0, 160)}` : ""}` };
  }
  return { status: "ok", ms, evidence, detail: `exit ${r.status} in ${fmtMs(ms)}` };
}

function computeTthw(steps) {
  const counted = steps.filter((s) => s.countsTowardTthw !== false && s.status !== "unverified");
  const ms = round1(counted.reduce((a, s) => a + (s.ms || 0), 0));
  return {
    ms,
    steps: counted.length,
    excludedUnverified: steps.filter((s) => s.status === "unverified").length,
    truncated: counted.some((s) => s.truncated === true),
    tier: tierFor(ms).tier,
    tierNote: tierFor(ms).note,
    source: "sum of per-step durations from process.hrtime.bigint()",
  };
}

function computeVerdict(steps) {
  if (steps.some((s) => s.status === "unverified")) return "UNVERIFIED";
  if (steps.some((s) => s.status === "finding")) return "FINDINGS";
  return "PASS";
}

const VERDICT_EXIT = { PASS: EXIT_OK, FINDINGS: EXIT_FINDINGS, UNVERIFIED: EXIT_UNVERIFIED };

// -------------------------------------------------------------- the report

/**
 * Placeholders that must never survive into a report.
 *
 * Every one of these is a literal cell from gstack's required output. They are
 * matched here so that a report which was hand-edited back into the template
 * shape is refused rather than filed.
 */
const PLACEHOLDERS = [
  { re: /_{2,}\s*\/\s*10/, why: "a blank score cell" },
  { re: /_{2,}\s*min\b/, why: "a blank TTHW cell" },
  { re: /\[est\]/i, why: "an estimated time where a measured one is required" },
  { re: /\[screenshots?\]/i, why: "the literal token [screenshot] instead of a path to one" },
  { re: /\[file refs?\]/i, why: "the literal token [file refs] instead of a path" },
  { re: /\[step count\]/i, why: "the literal token [step count]" },
  { re: /\[what dev does\]/i, why: "an unfilled step description" },
  { re: /\[Champion\/Competitive/i, why: "an unchosen TTHW tier" },
];

function scanPlaceholders(text) {
  return PLACEHOLDERS.filter((p) => p.re.test(text)).map((p) => p.why);
}

function statusMark(s) {
  return { ok: "ok", finding: "FINDING", unverified: "UNVERIFIED" }[s] ?? s;
}

function renderReport(run) {
  const L = [];
  const t = run.tthw;
  L.push(`# DX live audit: ${run.product}`);
  L.push("");
  L.push(`Run id: \`${run.runId}\``);
  L.push(`Started: ${run.startedAt}`);
  L.push(`Machine: ${run.env.host} / ${run.env.platform} / ${run.env.arch} / node ${run.env.node}`);
  L.push(`Browse engine: ${run.browse.script ?? "not needed (no page steps)"}${run.browse.binary ? ` -> ${run.browse.binary}` : ""}`);
  L.push("");
  L.push(`## Verdict: ${run.verdict}`);
  L.push("");
  L.push(verdictSentence(run));
  L.push("");
  L.push("## Time to hello world");
  L.push("");
  L.push(`Measured: ${fmtMs(t.ms)} (${Math.round(t.ms)} ms across ${t.steps} measured step(s), ${t.source})`);
  L.push(`Tier: ${t.tier} (${t.tierNote}; tiers from gstack's TTHW table)`);
  if (t.excludedUnverified) L.push(`Excluded: ${t.excludedUnverified} unverified step(s). An unverified step is not a fast step, so its duration is not summed.`);
  if (t.truncated) L.push(`Lower bound only: a step was killed at its timeout, so the real number is larger than this.`);
  L.push("");
  L.push("## Steps");
  L.push("");
  L.push("| # | Step | Kind | Status | Time | Evidence |");
  L.push("|---|------|------|--------|------|----------|");
  for (const s of run.steps) {
    const ev = [s.evidence?.shot, s.evidence?.log].filter(Boolean).map((p) => `\`${p}\``).join(" ");
    L.push(`| ${s.n} | ${s.label} | ${s.kind} | ${statusMark(s.status)} | ${fmtMs(s.ms)} | ${ev || "none"} |`);
  }
  L.push("");
  const unver = run.steps.filter((s) => s.status === "unverified");
  const finds = run.steps.filter((s) => s.status === "finding");
  if (unver.length) {
    L.push("## Unverified");
    L.push("");
    L.push("These steps did not produce evidence, so nothing about them is reported as passing or failing.");
    L.push("");
    for (const s of unver) L.push(`${s.n}. **${s.label}** — ${s.detail}`);
    L.push("");
  }
  if (finds.length) {
    L.push("## Findings");
    L.push("");
    for (const s of finds) L.push(`${s.n}. **${s.label}** — ${s.detail}`);
    L.push("");
  }
  L.push("## Scorecard");
  L.push("");
  L.push("| Dimension | Score | Method | Evidence |");
  L.push("|-----------|-------|--------|----------|");
  for (const [key, label] of Object.entries(DIMENSIONS)) {
    const sc = run.scores?.[key];
    const backing = run.steps.filter((s) => s.dimension === key);
    const measured = backing.filter((s) => s.status !== "unverified");
    if (!sc) {
      const note = measured.length
        ? `${measured.length} measured step(s), not yet scored`
        : backing.length
          ? `${backing.length} step(s), all unverified`
          : "no step in this run exercised it";
      L.push(`| ${label} | UNMEASURED | - | ${note} |`);
      continue;
    }
    const ev = sc.evidence
      ? `\`${sc.evidence}\``
      : measured.map((s) => `\`${s.evidence?.shot ?? s.evidence?.log}\``).join(" ") || "-";
    L.push(`| ${label} | ${sc.score}/10 | ${sc.method} | ${ev} |`);
  }
  L.push("");
  if (run.scores && Object.keys(run.scores).length) {
    L.push("### Why those scores");
    L.push("");
    for (const [key, sc] of Object.entries(run.scores)) L.push(`- **${DIMENSIONS[key]} ${sc.score}/10** — ${sc.why}`);
    L.push("");
  }
  L.push("---");
  L.push("");
  L.push(`Every number above was computed by \`tb-devex-live.mjs ${VERSION}\` from the files in this directory.`);
  L.push(`Re-check it at any time, on any machine, with:`);
  L.push("");
  L.push("```");
  L.push(`node tb-devex-live.mjs verify --run ${run.runId}`);
  L.push("```");
  L.push("");
  return `${L.join("\n")}\n`;
}

function verdictSentence(run) {
  if (run.verdict === "UNVERIFIED") {
    const n = run.steps.filter((s) => s.status === "unverified").length;
    return `${n} step(s) produced no usable evidence, so this audit does not support a score. Fix the listed causes and re-run; do not report the product as working or broken on the strength of this run.`;
  }
  if (run.verdict === "FINDINGS") {
    const n = run.steps.filter((s) => s.status === "finding").length;
    return `Every step produced evidence. ${n} of them found a real defect in the developer experience, listed below.`;
  }
  return `Every step ran and produced evidence, and none of them found a defect.`;
}

// ------------------------------------------------------------------ commands

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function flagAll(args, name) {
  const vals = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1] !== undefined) vals.push(args[i + 1]);
  return vals;
}

function refuse(message, code = EXIT_UNUSABLE) {
  err(`\n  ${code === EXIT_UNVERIFIED ? "REFUSED " : "UNUSABLE"}  ${message}\n`);
  process.exitCode = code;
}

function cmdRun(args) {
  const dirRes = resolveOutDir(flag(args, "--dir"));
  if (!dirRes.ok) return refuse(dirRes.error, EXIT_UNUSABLE);
  const root = dirRes.dir;

  let plan;
  let planSource;
  const planFlag = flag(args, "--plan");
  if (planFlag) {
    const r = readPlan(planFlag);
    if (r.error) return refuse(r.error, EXIT_UNUSABLE);
    plan = r.plan;
    planSource = r.file;
  } else {
    const pages = [...(flag(args, "--url") ? [flag(args, "--url")] : []), ...flagAll(args, "--page")];
    if (!pages.length) {
      return refuse(
        `nothing to run. Pass --plan <file.json>, or --url/--page for page steps. Command steps come from a plan ` +
          `file only, because a command assembled by splitting a flag on spaces is a different command on Windows ` +
          `than it is in bash.`,
        EXIT_UNUSABLE,
      );
    }
    plan = {
      product: flag(args, "--product") ?? pages[0],
      steps: pages.map((u, i) => ({ id: `page-${i + 1}`, kind: "page", url: u, dimension: i === 0 ? "getting-started" : undefined })),
    };
    planSource = "the command line";
    const problems = validatePlan(plan, planSource);
    if (problems.length) return refuse(`${planSource} did not produce a usable plan:\n      - ${problems.join("\n      - ")}`, EXIT_UNUSABLE);
  }

  const minShotBytes = Number(flag(args, "--min-shot-bytes") ?? DEFAULT_MIN_SHOT_BYTES);
  if (!Number.isFinite(minShotBytes) || minShotBytes < 0) return refuse(`--min-shot-bytes must be a number`, EXIT_UNUSABLE);
  const timeoutMs = parseDuration(flag(args, "--timeout") ?? "120s");
  if (timeoutMs === null) return refuse("--timeout takes a value like 120s or 3m", EXIT_UNUSABLE);

  const needsBrowse = plan.steps.some((s) => s.kind === "page");
  let browseScript = null;
  let browseBinary = null;
  if (needsBrowse) {
    const res = resolveBrowseScript(flag(args, "--browse"));
    if (res.error) return refuse(res.error, EXIT_UNVERIFIED);
    browseScript = res.script;
    const doc = browseDoctor(browseScript, Math.min(timeoutMs, 120000));
    if (!doc.ok) {
      return refuse(
        `the browser is not usable, so ${plan.steps.filter((s) => s.kind === "page").length} page step(s) cannot be ` +
          `run: ${doc.why}. Refusing to start. A page step run past this point comes back empty, and empty is what a ` +
          `fast clean page looks like to anything that does not check.\n\n${indent(doc.text)}`,
        EXIT_UNVERIFIED,
      );
    }
    browseBinary = doc.binary;
  }

  const startedAt = new Date();
  const runId = flag(args, "--run-id") ?? runIdFrom(startedAt);
  const runDir = path.join(root, runId);
  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });

  out(`\n  tb-devex-live run  ${plan.product ?? "(unnamed product)"}`);
  out(`  plan: ${planSource}`);
  out(`  run:  ${runDir}\n`);

  const steps = [];
  plan.steps.forEach((step, i) => {
    const n = String(i + 1).padStart(2, "0");
    const id = step.id || `step-${i + 1}`;
    const label = step.label || (step.kind === "page" ? step.url : step.argv.join(" "));
    const ctx = { runDir, n, browseScript, minShotBytes, timeoutMs };
    const res = step.kind === "page" ? runPageStep({ ...step, id }, ctx) : runCmdStep({ ...step, id }, ctx);
    const row = {
      n: i + 1,
      id,
      kind: step.kind,
      label,
      dimension: step.dimension ?? null,
      countsTowardTthw: step.countsTowardTthw,
      ...res,
    };
    steps.push(row);
    out(`  ${statusMark(row.status).padEnd(10)} ${String(i + 1).padStart(2)} ${label.slice(0, 58).padEnd(58)} ${fmtMs(row.ms).padStart(8)}  ${row.detail}`);
  });

  const run = {
    tool: "tb-devex-live",
    version: VERSION,
    runId,
    product: plan.product ?? "(unnamed product)",
    planSource,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    env: { host: os.hostname(), platform: process.platform, arch: process.arch, node: process.version },
    browse: { script: browseScript, binary: browseBinary },
    minShotBytes,
    steps,
    scores: {},
    tthw: computeTthw(steps),
    verdict: computeVerdict(steps),
  };

  writeJsonAtomic(path.join(runDir, "run.json"), run);
  writeTextAtomic(path.join(runDir, "report.md"), renderReport(run));

  out("");
  out(`  TTHW: ${fmtMs(run.tthw.ms)} (${run.tthw.tier})`);
  out(`  VERDICT: ${run.verdict}`);
  out(`  report: ${path.join(runDir, "report.md")}`);
  out(`  data:   ${path.join(runDir, "run.json")}`);
  out("");
  process.exitCode = VERDICT_EXIT[run.verdict];
}

function indent(text, pad = "    ") {
  return String(text)
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Find a run directory from --run: an absolute path, or an id under --dir. */
function locateRun(args) {
  const raw = flag(args, "--run");
  if (!raw) return { error: `--run <dir|run-id> is required` };
  const direct = expand(raw);
  if (direct && fs.existsSync(path.join(direct, "run.json"))) return { dir: direct };
  const dirRes = resolveOutDir(flag(args, "--dir"));
  if (!dirRes.ok) return { error: dirRes.error };
  const under = path.join(dirRes.dir, String(raw).trim());
  if (fs.existsSync(path.join(under, "run.json"))) return { dir: under };
  return {
    error:
      `no run at ${direct} and none at ${under}. A run that cannot be found is not a run that passed. ` +
      `List what is there with: node tb-devex-live.mjs runs --dir ${dirRes.dir}`,
  };
}

function readRun(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "run.json"), "utf8");
  } catch (e) {
    return { error: `${path.join(dir, "run.json")} could not be read (${e.code || e.message})` };
  }
  let run;
  try {
    run = JSON.parse(raw);
  } catch (e) {
    return { error: `${path.join(dir, "run.json")} is not valid JSON (${e.message}), so nothing in this run can be checked` };
  }
  if (!run || typeof run !== "object" || !Array.isArray(run.steps)) {
    return { error: `${path.join(dir, "run.json")} has no "steps" array, so it is not a run record` };
  }
  return { run };
}

/**
 * `score` is the gate on the scorecard.
 *
 * gstack's scorecard is eight rows of `__/10` and the model fills them in from
 * whatever it remembers. Here a score is refused unless this run holds something
 * to score it from: a step for that dimension that was not unverified, or an
 * evidence file that exists on disk. INFERRED is still allowed, as in gstack, but
 * it has to name the file it was inferred from and that file has to be there.
 */
function cmdScore(args) {
  const loc = locateRun(args);
  if (loc.error) return refuse(loc.error, EXIT_UNUSABLE);
  const r = readRun(loc.dir);
  if (r.error) return refuse(r.error, EXIT_UNUSABLE);
  const run = r.run;

  const dim = flag(args, "--dimension");
  if (!dim || !DIMENSIONS[dim]) {
    return refuse(`--dimension must be one of: ${Object.keys(DIMENSIONS).join(", ")}`, EXIT_UNUSABLE);
  }
  const scoreRaw = flag(args, "--score");
  if (!/^\d+$/.test(String(scoreRaw ?? ""))) return refuse(`--score must be a whole number 0-10`, EXIT_UNUSABLE);
  const score = Number(scoreRaw);
  if (score < 0 || score > 10) return refuse(`--score must be between 0 and 10`, EXIT_UNUSABLE);
  const why = flag(args, "--why");
  if (!why || why.trim().length < 20) {
    return refuse(`--why is required and must say something (at least 20 characters). A score with no reason is a number nobody can act on.`, EXIT_UNUSABLE);
  }

  const backing = run.steps.filter((s) => s.dimension === dim && s.status !== "unverified");
  const evidenceFlag = flag(args, "--evidence");
  let evidenceRel = null;
  if (evidenceFlag) {
    const abs = expand(evidenceFlag);
    if (!abs || !fs.existsSync(abs)) {
      return refuse(`--evidence ${evidenceFlag} does not exist. An evidence path that does not open is not evidence.`, EXIT_FINDINGS);
    }
    evidenceRel = path.relative(loc.dir, abs).replace(/\\/g, "/");
    if (evidenceRel.startsWith("..")) evidenceRel = abs.replace(/\\/g, "/");
  }
  if (!backing.length && !evidenceRel) {
    const all = run.steps.filter((s) => s.dimension === dim);
    return refuse(
      `${DIMENSIONS[dim]} cannot be scored from this run: ${
        all.length ? `all ${all.length} step(s) for it are unverified` : "no step in this run exercised it"
      }, and no --evidence file was given. Run a step that exercises it, or pass --evidence <file> to score it as INFERRED. ` +
        `A score with nothing behind it is the one output of a DX audit that cannot be checked by anyone later.`,
      EXIT_FINDINGS,
    );
  }

  run.scores = run.scores || {};
  run.scores[dim] = {
    score,
    why: why.trim(),
    method: evidenceRel && !backing.length ? "INFERRED" : backing.length && backing.every((s) => s.kind === "page") ? "TESTED" : "PARTIAL",
    evidence: evidenceRel,
    backedBySteps: backing.map((s) => s.n),
    scoredAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(loc.dir, "run.json"), run);
  writeTextAtomic(path.join(loc.dir, "report.md"), renderReport(run));
  out(`\n  ${DIMENSIONS[dim]}: ${score}/10 (${run.scores[dim].method}), backed by ${backing.length ? `step(s) ${backing.map((s) => s.n).join(", ")}` : evidenceRel}`);
  out(`  report rewritten: ${path.join(loc.dir, "report.md")}\n`);
}

function cmdVerify(args) {
  const loc = locateRun(args);
  if (loc.error) return refuse(loc.error, EXIT_UNUSABLE);
  const dir = loc.dir;
  const r = readRun(dir);
  if (r.error) return refuse(r.error, EXIT_UNUSABLE);
  const run = r.run;
  const floor = Number.isFinite(run.minShotBytes) ? run.minShotBytes : DEFAULT_MIN_SHOT_BYTES;

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. every artifact the run claims is on disk and is what it says it is.
  for (const s of run.steps) {
    if (s.evidence?.shot) {
      const png = checkPng(path.join(dir, s.evidence.shot), floor);
      add(`step ${s.n} screenshot is a real PNG`, png.ok, png.why);
    }
    if (s.evidence?.log) {
      const lg = checkLog(path.join(dir, s.evidence.log));
      add(`step ${s.n} command log is on disk`, lg.ok, lg.why);
    }
    if (s.status === "ok" && s.kind === "page" && !s.evidence?.shot) {
      add(`step ${s.n} passed with a screenshot`, false, `step ${s.n} is recorded as ok but names no screenshot`);
    }
  }

  // 2. the numbers in the record are the numbers the record's own data produces.
  const tthw = computeTthw(run.steps);
  add(
    "TTHW in run.json is the sum of its measured steps",
    Math.abs((run.tthw?.ms ?? -1) - tthw.ms) < 1,
    `recorded ${run.tthw?.ms}ms, recomputed ${tthw.ms}ms from ${tthw.steps} step(s)`,
  );
  const verdict = computeVerdict(run.steps);
  add("verdict in run.json follows from its step statuses", run.verdict === verdict, `recorded ${run.verdict}, recomputed ${verdict}`);

  // 3. every score is still backed.
  for (const [dim, sc] of Object.entries(run.scores ?? {})) {
    const backing = run.steps.filter((s) => s.dimension === dim && s.status !== "unverified");
    const evOk = sc.evidence ? fs.existsSync(path.resolve(dir, sc.evidence)) : false;
    add(
      `score for ${DIMENSIONS[dim] ?? dim} is backed`,
      backing.length > 0 || evOk,
      backing.length ? `${backing.length} measured step(s)` : evOk ? `evidence file ${sc.evidence}` : `nothing in this run backs it`,
    );
  }

  // 4. the report is a report, not the template.
  const reportPath = path.join(dir, "report.md");
  let report = null;
  try {
    report = fs.readFileSync(reportPath, "utf8");
  } catch (e) {
    add("report.md is on disk", false, `${reportPath} could not be read (${e.code || e.message})`);
  }
  if (report !== null) {
    add("report.md is on disk", true, `${report.length} chars`);
    const holes = scanPlaceholders(report);
    add("report.md carries no unfilled placeholder", holes.length === 0, holes.length ? holes.join("; ") : "none of the template cells survived");

    const stated = /Measured:.*?\((\d+)\s*ms/.exec(report);
    add(
      "TTHW stated in report.md matches the recomputed one",
      Boolean(stated) && Math.abs(Number(stated[1]) - Math.round(tthw.ms)) <= 1,
      stated ? `report says ${stated[1]}ms, recomputed ${Math.round(tthw.ms)}ms` : "report states no machine-readable TTHW",
    );

    const statedVerdict = /^##\s*Verdict:\s*(\w+)/m.exec(report);
    add(
      "verdict stated in report.md matches the recomputed one",
      Boolean(statedVerdict) && statedVerdict[1] === verdict,
      statedVerdict ? `report says ${statedVerdict[1]}, recomputed ${verdict}` : "report states no verdict",
    );

    const refs = [...report.matchAll(/`((?:shots|logs)\/[^`]+)`/g)].map((m) => m[1]);
    const missing = refs.filter((p) => !fs.existsSync(path.join(dir, p)));
    add(
      "every file report.md cites exists in the run",
      missing.length === 0,
      missing.length ? `missing: ${missing.slice(0, 4).join(", ")}` : `${refs.length} cited file(s) all present`,
    );
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  out(`\n  tb-devex-live verify  ${dir}\n`);
  for (const c of checks) out(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  out(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    out(`\n  VERDICT: NOT BACKED. This report claims things this directory does not show.\n`);
    process.exitCode = EXIT_FINDINGS;
    return;
  }
  out(`\n  VERDICT: BACKED. Every number and every screenshot in report.md was recomputed from this directory.`);
  out(`  Run verdict was ${run.verdict}.\n`);
  if (run.verdict !== "PASS") process.exitCode = VERDICT_EXIT[run.verdict];
}

function cmdRuns(args) {
  const dirRes = resolveOutDir(flag(args, "--dir"));
  if (!dirRes.ok) return refuse(dirRes.error, EXIT_UNUSABLE);
  let names;
  try {
    names = fs.readdirSync(dirRes.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if (e.code === "ENOENT") {
      out(`\n  no runs yet: ${dirRes.dir} does not exist\n`);
      return;
    }
    return refuse(`${dirRes.dir} exists but could not be listed (${e.code || e.message}). That is not "no runs".`, EXIT_UNUSABLE);
  }
  out(`\n  runs in ${dirRes.dir}\n`);
  if (!names.length) out("  (none)");
  for (const n of names.sort().reverse()) {
    const rr = readRun(path.join(dirRes.dir, n));
    out(`  ${n.padEnd(34)} ${rr.error ? "UNREADABLE" : `${rr.run.verdict.padEnd(10)} TTHW ${fmtMs(rr.run.tthw?.ms ?? 0)}`}`);
  }
  out("");
}

function cmdDoctor(args) {
  out(`\n  tb-devex-live doctor  (node ${process.version}, ${process.platform})\n`);
  const dirRes = resolveOutDir(flag(args, "--dir"));
  out(`  output dir        ${dirRes.ok ? dirRes.dir : `REFUSED: ${dirRes.error}`}`);
  out(`  run id shape      ${runIdFrom()}   (no ":" — a Windows path component cannot contain one)`);
  const res = resolveBrowseScript(flag(args, "--browse"));
  if (res.error) {
    out(`  browse engine     NOT FOUND`);
    out(indent(res.error));
    out("");
    process.exitCode = EXIT_UNVERIFIED;
    return;
  }
  out(`  browse engine     ${res.script}`);
  const doc = browseDoctor(res.script, 120000);
  out(`  browser           ${doc.ok ? `usable -> ${doc.binary ?? "(binary not printed)"}` : `NOT USABLE: ${doc.why}`}`);
  if (!doc.ok) {
    out(indent(doc.text));
    out(`\n  Page steps would be refused, which is correct. Nothing here would be scored.\n`);
    process.exitCode = EXIT_UNVERIFIED;
    return;
  }
  out(`\n  Ready. Page steps will run and produce screenshots.\n`);
}

// ------------------------------------------------------------------ selftest
//
// The engine is run as a real child process against a browser that lies, and
// against reports that have been edited after the fact. A stub browser is used
// rather than a real one because there is no way to ask Chromium to claim it
// saved a screenshot it did not save, and that claim is the exact failure this
// tool exists to catch.

const STUB_BROWSE = `
import fs from "node:fs";
const mode = process.env.TB_STUB || "ok";
const [cmd, ...rest] = process.argv.slice(2);
const URL_OK = process.env.TB_STUB_URL || "https://app.example.com/start";
const wrap = (src, body) =>
  "--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: " + src + ") ---\\n" + body + "\\n--- END UNTRUSTED EXTERNAL CONTENT ---";
const { makePngOfSize } = await import("${new URL("tb-artifact.mjs", import.meta.url).href}");
const bigPng = makePngOfSize(8200);
const tinyPng = makePngOfSize(68);
let src = URL_OK, url = URL_OK;
if (mode === "chromeerror") { src = "chrome-error://chromewebdata/"; url = "chrome-error://chromewebdata/"; }
switch (cmd) {
  case "status":
    if (mode === "daemondown") { process.stderr.write("connect ECONNREFUSED 127.0.0.1:9333\\n"); process.exit(1); }
    process.stdout.write("Status: healthy\\n"); break;
  case "goto":
    if (mode === "chromeerror") { process.stderr.write("page.goto: net::ERR_NAME_NOT_RESOLVED\\n"); process.exit(1); }
    process.stdout.write("Navigated to " + url + " (200)\\n"); break;
  case "url": process.stdout.write(url + "\\n"); break;
  case "text": process.stdout.write(wrap(src, mode === "chromeerror" ? "" : "Get started") + "\\n"); break;
  case "console":
    process.stdout.write(wrap(src, mode === "consoleerr" ? "[2026-01-01T00:00:00Z] [error] Uncaught TypeError" : "(no console errors)") + "\\n"); break;
  case "is": process.stdout.write((mode === "chromeerror" ? "false" : "true") + "\\n"); break;
  case "screenshot": {
    const p = rest[rest.length - 1];
    if (mode === "noshot") { /* claim it, write nothing */ }
    else if (mode === "zeroshot") fs.writeFileSync(p, "");
    else if (mode === "notpng") fs.writeFileSync(p, "<html>error 500</html>");
    else if (mode === "tinyshot") fs.writeFileSync(p, tinyPng);
    else fs.writeFileSync(p, bigPng);
    process.stdout.write("Screenshot saved: " + p + "\\n"); break;
  }
  default: process.exit(1);
}
process.exit(0);
`;

function runSelf(args, env = {}) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: r.status, stdout: `${r.stdout || ""}${r.stderr || ""}` };
}

function writePlan(file, steps, product = "Stub Product") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ product, steps }, null, 2), "utf8");
  return file;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-devex-selftest-"));
  const stub = path.join(tmp, "stub-browse.mjs");
  fs.writeFileSync(stub, STUB_BROWSE, "utf8");
  const browseScript = resolveBrowseScript().script;
  const URL_OK = "https://app.example.com/start";
  const results = [];
  const check = (name, expected, got, detail = "") => results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  if (!browseScript) {
    out("\n  tb-devex-live selftest CANNOT RUN: the sibling browse engine was not found.\n");
    process.exitCode = EXIT_UNVERIFIED;
    return;
  }

  const baseEnv = (mode) => ({
    TOOLBAY_BROWSE_BIN: stub,
    TB_STUB: mode,
    TB_STUB_URL: URL_OK,
    TOOLBAY_DEVEX_BROWSE_SCRIPT: browseScript,
  });

  const pagePlan = (dir) =>
    writePlan(path.join(dir, "plan.json"), [
      { id: "landing", kind: "page", url: URL_OK, label: "open the getting-started page", dimension: "getting-started" },
    ]);

  // --- the browser is down: refuse before writing anything ------------------
  {
    const d = path.join(tmp, "daemondown");
    const r = runSelf(["run", "--plan", pagePlan(d), "--dir", path.join(d, "out")], baseEnv("daemondown"));
    check("a run with page steps is REFUSED when the daemon is down", EXIT_UNVERIFIED, r.status, r.stdout.slice(0, 200));
    check(
      "the refused run left no run directory behind",
      "no directory",
      fs.existsSync(path.join(d, "out")) ? "directory written" : "no directory",
      "a half-written run reads as a result",
    );
  }

  // --- a browse engine that was named and is not there ----------------------
  {
    const d = path.join(tmp, "nobrowse");
    const r = runSelf(["run", "--plan", pagePlan(d), "--dir", path.join(d, "out"), "--browse", path.join(tmp, "does-not-exist.mjs")], baseEnv("ok"));
    check("a named browse engine that does not exist is REFUSED", EXIT_UNVERIFIED, r.status, r.stdout.slice(0, 160));
  }

  // --- the browser lies about the screenshot -------------------------------
  for (const [mode, label] of [
    ["noshot", "claims a screenshot and writes none"],
    ["zeroshot", "writes a zero-byte screenshot"],
    ["notpng", "writes HTML with a .png name"],
    ["tinyshot", "writes a valid PNG too small to be a painted page"],
  ]) {
    const d = path.join(tmp, `shot-${mode}`);
    const r = runSelf(["run", "--plan", pagePlan(d), "--dir", path.join(d, "out")], baseEnv(mode));
    check(`a browser that ${label} yields UNVERIFIED`, EXIT_UNVERIFIED, r.status, r.stdout.slice(-300));
    const runDir = path.join(d, "out", fs.readdirSync(path.join(d, "out"))[0] ?? "");
    const rep = fs.existsSync(path.join(runDir, "report.md")) ? fs.readFileSync(path.join(runDir, "report.md"), "utf8") : "";
    check(`  ...and its report says UNVERIFIED rather than a score`, true, /^##\s*Verdict:\s*UNVERIFIED/m.test(rep), runDir);
  }

  // --- the page did not load at all ----------------------------------------
  {
    const d = path.join(tmp, "chromeerror");
    const r = runSelf(["run", "--plan", pagePlan(d), "--dir", path.join(d, "out")], baseEnv("chromeerror"));
    check("a page that resolved to chrome-error is never ok", EXIT_UNVERIFIED, r.status, r.stdout.slice(-260));
  }

  // --- console errors are a finding, not an unverified ----------------------
  {
    const d = path.join(tmp, "consoleerr");
    const r = runSelf(["run", "--plan", pagePlan(d), "--dir", path.join(d, "out")], baseEnv("consoleerr"));
    check("a page that loads but throws in the console is a FINDING", EXIT_FINDINGS, r.status, r.stdout.slice(-260));
  }

  // --- the happy path -------------------------------------------------------
  const good = path.join(tmp, "good");
  let goodRunDir = null;
  {
    const r = runSelf(["run", "--plan", pagePlan(good), "--dir", path.join(good, "out")], baseEnv("ok"));
    check("a browser that tells the truth passes", EXIT_OK, r.status, r.stdout.slice(-300));
    const dirs = fs.existsSync(path.join(good, "out")) ? fs.readdirSync(path.join(good, "out")) : [];
    goodRunDir = dirs.length ? path.join(good, "out", dirs[0]) : null;
    check("the run wrote a report.md", true, Boolean(goodRunDir) && fs.existsSync(path.join(goodRunDir, "report.md")), String(goodRunDir));
    check("the run wrote a run.json", true, Boolean(goodRunDir) && fs.existsSync(path.join(goodRunDir, "run.json")), String(goodRunDir));
    check("the run wrote a screenshot", true, Boolean(goodRunDir) && fs.readdirSync(path.join(goodRunDir, "shots")).some((f) => f.endsWith(".png")), String(goodRunDir));
    check(
      "the run directory name is a legal Windows filename",
      true,
      Boolean(goodRunDir) && !path.basename(goodRunDir).includes(":"),
      "an ISO timestamp contains colons, which Windows refuses",
    );
    const rep = goodRunDir ? fs.readFileSync(path.join(goodRunDir, "report.md"), "utf8") : "";
    check("the report contains no unfilled template cell", 0, scanPlaceholders(rep).length, scanPlaceholders(rep).join("; "));
    check("verify accepts the untouched run", EXIT_OK, runSelf(["verify", "--run", goodRunDir]).status, "");
  }

  // --- cmd steps ------------------------------------------------------------
  {
    const d = path.join(tmp, "cmd-missing");
    const plan = writePlan(path.join(d, "plan.json"), [
      { id: "install", kind: "cmd", argv: ["definitely-not-a-real-binary-xyz", "--help"], label: "run the documented install command" },
    ]);
    const r = runSelf(["run", "--plan", plan, "--dir", path.join(d, "out")], {});
    check("a command that cannot start is UNVERIFIED, not a fast pass", EXIT_UNVERIFIED, r.status, r.stdout.slice(-260));
  }
  {
    const d = path.join(tmp, "cmd-fail");
    const plan = writePlan(path.join(d, "plan.json"), [
      { id: "help", kind: "cmd", argv: [process.execPath, "-e", "process.exit(3)"], label: "the CLI's own --help" },
    ]);
    const r = runSelf(["run", "--plan", plan, "--dir", path.join(d, "out")], {});
    check("a command that exits non-zero is a FINDING", EXIT_FINDINGS, r.status, r.stdout.slice(-200));
  }
  {
    const d = path.join(tmp, "cmd-timeout");
    const plan = writePlan(path.join(d, "plan.json"), [
      { id: "hang", kind: "cmd", argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"], timeout: "2s", label: "a command that never returns" },
    ]);
    const r = runSelf(["run", "--plan", plan, "--dir", path.join(d, "out")], {});
    check("a command that hangs is a FINDING, not a 0ms success", EXIT_FINDINGS, r.status, r.stdout.slice(-200));
  }
  {
    const d = path.join(tmp, "cmd-ok");
    const plan = writePlan(path.join(d, "plan.json"), [
      { id: "version", kind: "cmd", argv: [process.execPath, "-v"], label: "node -v", dimension: "dev-environment" },
    ]);
    const r = runSelf(["run", "--plan", plan, "--dir", path.join(d, "out")], {});
    check("a cmd-only plan runs with no browser at all", EXIT_OK, r.status, r.stdout.slice(-200));
  }

  // --- unusable plans -------------------------------------------------------
  {
    const d = path.join(tmp, "badplan");
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, "broken.json");
    fs.writeFileSync(f, "{ this is not json", "utf8");
    check("an unparseable plan is UNUSABLE", EXIT_UNUSABLE, runSelf(["run", "--plan", f, "--dir", path.join(d, "out")]).status);
    const empty = path.join(d, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ steps: [] }), "utf8");
    check("a plan with no steps is UNUSABLE", EXIT_UNUSABLE, runSelf(["run", "--plan", empty, "--dir", path.join(d, "out")]).status);
    const typo = path.join(d, "typo.json");
    fs.writeFileSync(typo, JSON.stringify({ steps: [{ id: "a", kind: "page", url: URL_OK, dimenson: "getting-started" }] }), "utf8");
    check("a misspelled step key is refused, not ignored", EXIT_UNUSABLE, runSelf(["run", "--plan", typo, "--dir", path.join(d, "out")]).status);
    const missing = path.join(d, "nofile.json");
    check("a plan file that does not exist is UNUSABLE", EXIT_UNUSABLE, runSelf(["run", "--plan", missing, "--dir", path.join(d, "out")]).status);
  }

  // --- scoring is gated on evidence ----------------------------------------
  if (goodRunDir) {
    const ok = runSelf(["score", "--run", goodRunDir, "--dimension", "getting-started", "--score", "7", "--why", "one page, one command, no account required"]);
    check("a dimension with a measured step can be scored", EXIT_OK, ok.status, ok.stdout.slice(-160));
    const bad = runSelf(["score", "--run", goodRunDir, "--dimension", "upgrade-path", "--score", "9", "--why", "the changelog looked fine to me honestly"]);
    check("a dimension with no evidence CANNOT be scored", EXIT_FINDINGS, bad.status, bad.stdout.slice(-200));
    const badEv = runSelf(["score", "--run", goodRunDir, "--dimension", "upgrade-path", "--score", "9", "--why", "inferred from a changelog that is not there", "--evidence", path.join(tmp, "no-such-changelog.md")]);
    check("an --evidence path that does not exist is refused", EXIT_FINDINGS, badEv.status, badEv.stdout.slice(-160));
    const noWhy = runSelf(["score", "--run", goodRunDir, "--dimension", "getting-started", "--score", "7", "--why", "good"]);
    check("a score with no real reason is refused", EXIT_UNUSABLE, noWhy.status, noWhy.stdout.slice(-160));
    check("verify still accepts the run after a backed score", EXIT_OK, runSelf(["verify", "--run", goodRunDir]).status, "");
  }

  // --- verify catches a report that was edited after the fact ---------------
  if (goodRunDir) {
    const tamperTthw = path.join(tmp, "tamper-tthw");
    copyDir(goodRunDir, tamperTthw);
    const p = path.join(tamperTthw, "report.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/Measured:.*$/m, "Measured: 1.1 min (66000 ms across 1 measured step(s), sum)"), "utf8");
    check("verify refuses a report whose TTHW was rewritten", EXIT_FINDINGS, runSelf(["verify", "--run", tamperTthw]).status);

    const tamperVerdict = path.join(tmp, "tamper-verdict");
    copyDir(goodRunDir, tamperVerdict);
    const q = path.join(tamperVerdict, "report.md");
    fs.writeFileSync(q, fs.readFileSync(q, "utf8").replace(/^##\s*Verdict:.*$/m, "## Verdict: PASS"), "utf8");
    const runJson = JSON.parse(fs.readFileSync(path.join(tamperVerdict, "run.json"), "utf8"));
    runJson.steps[0].status = "unverified";
    fs.writeFileSync(path.join(tamperVerdict, "run.json"), JSON.stringify(runJson, null, 2), "utf8");
    check("verify refuses a PASS the step statuses do not support", EXIT_FINDINGS, runSelf(["verify", "--run", tamperVerdict]).status);

    const tamperShot = path.join(tmp, "tamper-shot");
    copyDir(goodRunDir, tamperShot);
    for (const f of fs.readdirSync(path.join(tamperShot, "shots"))) fs.rmSync(path.join(tamperShot, "shots", f), { force: true });
    check("verify refuses a report whose screenshots are gone", EXIT_FINDINGS, runSelf(["verify", "--run", tamperShot]).status);

    const tamperBlank = path.join(tmp, "tamper-blank");
    copyDir(goodRunDir, tamperBlank);
    const b = path.join(tamperBlank, "report.md");
    fs.writeFileSync(b, `${fs.readFileSync(b, "utf8")}\n| Getting Started | __/10 | [screenshots] | TESTED |\n`, "utf8");
    check("verify refuses a report pasted back into the blank template", EXIT_FINDINGS, runSelf(["verify", "--run", tamperBlank]).status);

    const tamperJson = path.join(tmp, "tamper-json");
    copyDir(goodRunDir, tamperJson);
    fs.writeFileSync(path.join(tamperJson, "run.json"), "{ not json", "utf8");
    check("verify refuses a run whose record cannot be parsed", EXIT_UNUSABLE, runSelf(["verify", "--run", tamperJson]).status);
  }
  check("verify refuses a run directory that does not exist", EXIT_UNUSABLE, runSelf(["verify", "--run", path.join(tmp, "no-such-run")]).status);

  // --- Windows path ambiguity ----------------------------------------------
  if (isWindows) {
    check(
      "a --dir under /tmp is refused on Windows",
      EXIT_UNUSABLE,
      runSelf(["run", "--url", URL_OK, "--dir", "/tmp/devex"], baseEnv("ok")).status,
      "Git Bash and Node resolve it to two different directories",
    );
  } else {
    check("a --dir under /tmp is accepted off Windows", true, resolveOutDir("/tmp/devex").ok, "only Windows has the ambiguity");
  }

  // --- the count itself -----------------------------------------------------
  // Both branches of the Windows check below add exactly one assertion, so this
  // total is the same on every platform. A run that does not reach it has
  // skipped a case, which is itself a failure rather than a shorter test.
  const EXPECTED = 41;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "a selftest whose total depends on where it ran can quietly stop asserting things",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-devex-live selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out(`\n  This audit engine is NOT trustworthy in this state. Failures:`);
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = EXIT_FINDINGS;
    return;
  }
  out("\n  Every lie above was caught: a browser that claims a screenshot it did not save, a daemon that is");
  out("  down, a command that cannot start, a score with nothing behind it, and a report edited after the");
  out("  fact. None of them produced a number. That is the whole difference from a prose scorecard.\n");
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// --------------------------------------------------------------------- entry

function help() {
  out(`
  tb-devex-live ${VERSION}  Toolbay Stack live developer-experience audit
  (fork of gstack /devex-review by Garry Tan, MIT)

  node tb-devex-live.mjs doctor [--dir <d>] [--browse <script>]
      Whether a run could happen at all: output dir, run-id shape, browse
      engine, and whether the browser answers. Non-zero means page steps
      would be refused.

  node tb-devex-live.mjs run --plan <plan.json> [--dir <d>] [--timeout 120s]
                             [--min-shot-bytes ${DEFAULT_MIN_SHOT_BYTES}] [--browse <script>]
  node tb-devex-live.mjs run --url <url> [--page <url>]... [--dir <d>]
      Walk the flow for real. Every page step is delegated to the browse
      engine and its screenshot is checked on disk; every cmd step is spawned
      without a shell and its log is written. Writes <dir>/<run-id>/ with
      run.json, report.md, shots/ and logs/.
      Exit 0 backed and clean, 1 real findings, 2 unusable plan,
      3 the audit could not be trusted to have happened.

  node tb-devex-live.mjs score --run <dir|id> --dimension <d> --score 0-10
                               --why "<reason>" [--evidence <file>]
      Put a number on a dimension. REFUSED unless this run holds a measured
      step for it, or an --evidence file that exists.
      Dimensions: ${Object.keys(DIMENSIONS).join(", ")}

  node tb-devex-live.mjs verify --run <dir|id> [--dir <d>]
      Recompute every claim in report.md from the files next to it: the
      screenshots, the TTHW, the verdict, the backing for each score, and
      every path the report cites. Exit non-zero if the report claims
      something this directory does not show.

  node tb-devex-live.mjs runs [--dir <d>]
      Every run in the directory, newest first.

  node tb-devex-live.mjs selftest
      Run this engine against a browser that lies and reports edited after
      the fact. Non-zero if any of it is believed.

  Nothing here scores what it did not see. A step with no evidence is
  UNVERIFIED, which is neither a pass nor a number.
`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "verify":
      return cmdVerify(rest);
    case "score":
      return cmdScore(rest);
    case "runs":
      return cmdRuns(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "selftest":
      return selftest();
    case "version":
    case "--version":
      return out(VERSION);
    default:
      return help();
  }
}

try {
  main();
} catch (e) {
  err(`\n  tb-devex-live crashed: ${e?.stack ?? e}\n`);
  err(`  A crash is not a passing audit. Nothing above should be reported as a result.\n`);
  process.exit(EXIT_UNVERIFIED);
}
