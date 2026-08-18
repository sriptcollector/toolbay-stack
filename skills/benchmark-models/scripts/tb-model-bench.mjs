#!/usr/bin/env node
/**
 * tb-model-bench.mjs — run one prompt through several model CLIs and report
 * latency, tokens and cost side by side.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * DERIVED WORK. The skill name, the command surface and the idea of a
 * cross-model shootout inside the skill suite are gstack's, by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * The code here is a rewrite. See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS, AND THE ONE THING IT REFUSES TO DO.
 *
 * A model benchmark is a scoreboard, and a scoreboard is worth exactly as much
 * as its refusal to score what it could not measure. The failure mode is not
 * subtle and it is not hypothetical — on this machine right now:
 *
 *   $ command -v codex     -> not found
 *   $ command -v gemini    -> not found
 *   $ command -v claude    -> found
 *
 * A benchmark that shells out to three CLIs, gets ENOENT from two of them, and
 * prints "Claude wins" has told you nothing except that Claude is installed.
 * That is the same defect this repository keeps finding everywhere else: a
 * check that reports success while doing nothing.
 *
 * So the rules, enforced by `decideOutcome` and its selftest:
 *
 *   1. A contender that did not run is UNAVAILABLE. It is never 0ms, never
 *      $0.00, never "slowest", and it is never quietly dropped from the table.
 *   2. Fewer than two contenders actually RAN  =>  NO COMPARISON. Not a
 *      winner with an asterisk. The single result is still printed, labelled
 *      as a measurement rather than a comparison.
 *   3. A contender that ran and failed (non-zero exit, timeout, empty output)
 *      is ERROR, which is distinct from UNAVAILABLE, because "we asked it and
 *      it broke" and "we never asked it" are different facts about a model.
 *   4. Latency is only comparable when every compared run saw the same prompt.
 *      The prompt is hashed, and a mismatch voids the comparison.
 *
 * Cost is computed from a table that is a snapshot and says so. A price that
 * silently goes stale is a wrong number with a confident format, so every cost
 * cell carries the table's date and `--no-cost` turns the column off entirely.
 *
 *   node tb-model-bench.mjs run --prompt "..." [--models a,b] [--timeout 120]
 *   node tb-model-bench.mjs detect
 *   node tb-model-bench.mjs selftest
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";

/* ------------------------------------------------------------------ *
 * The contenders.
 *
 * `probe` is the argv that proves the CLI is really there and runnable —
 * `command -v` only proves a file exists with the right name. `invoke` builds
 * the argv for a real prompt. `parse` pulls a token count out of the CLI's own
 * output when it offers one; when it does not, tokens stay null and the table
 * prints "not reported" rather than an estimate dressed as a measurement.
 * ------------------------------------------------------------------ */
export const CONTENDERS = [
  {
    id: "claude",
    label: "Claude (claude CLI)",
    bin: "claude",
    probe: ["--version"],
    // The prompt goes on STDIN, never in argv. See the note on runProcess.
    invoke: () => ["-p"],
  },
  {
    id: "gpt",
    label: "GPT (codex CLI)",
    bin: "codex",
    probe: ["--version"],
    invoke: () => ["exec", "-"],
  },
  {
    id: "gemini",
    label: "Gemini (gemini CLI)",
    bin: "gemini",
    probe: ["--version"],
    invoke: () => [],
  },
];

/* ------------------------------------------------------------------ *
 * Pricing. A snapshot, dated, and treated as one.
 * USD per 1M tokens. Nulls mean "we do not have a price", which prints as
 * "no price" — deliberately not 0, which would read as free.
 * ------------------------------------------------------------------ */
export const PRICE_TABLE_DATE = "2026-08-17";
export const PRICES = {
  claude: { input: 5.0, output: 25.0, note: "Opus-class list price" },
  gpt: { input: null, output: null, note: "codex CLI does not report the model it billed" },
  gemini: { input: null, output: null, note: "gemini CLI does not report the model it billed" },
};

/** Cost in USD, or null when we cannot honestly compute one. */
export function costOf(id, tokensIn, tokensOut) {
  const p = PRICES[id];
  if (!p || p.input == null || p.output == null) return null;
  if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) return null;
  return (tokensIn / 1e6) * p.input + (tokensOut / 1e6) * p.output;
}

/* ------------------------------------------------------------------ *
 * Outcome status vocabulary. Four words, each meaning one thing.
 * ------------------------------------------------------------------ */
export const RAN = "RAN";
export const ERROR = "ERROR";
export const UNAVAILABLE = "UNAVAILABLE";
export const TIMEOUT = "TIMEOUT";

/**
 * Turn a set of per-contender results into a verdict.
 *
 * THIS is the function that keeps the skill honest, so it is small, pure and
 * tested directly. It never looks at the filesystem or the clock.
 */
export function decideOutcome(results) {
  const ran = results.filter((r) => r.status === RAN);
  const unavailable = results.filter((r) => r.status === UNAVAILABLE);
  const errored = results.filter((r) => r.status === ERROR || r.status === TIMEOUT);

  // Rule 4 before rule 2: comparing runs that saw different prompts is worse
  // than not comparing at all, and it is invisible in the output if we let it
  // through, because every row still has a number in it.
  const hashes = new Set(ran.map((r) => r.promptHash));
  if (ran.length >= 2 && hashes.size > 1) {
    return {
      comparable: false,
      reason: "the compared runs did not all see the same prompt",
      detail: `${hashes.size} distinct prompt hashes across ${ran.length} runs`,
      ran,
      unavailable,
      errored,
      winner: null,
    };
  }

  if (ran.length < 2) {
    return {
      comparable: false,
      reason:
        ran.length === 0
          ? "no model ran"
          : "only one model ran, so there is nothing to compare it against",
      detail: [
        unavailable.length ? `${unavailable.length} not installed (${unavailable.map((r) => r.id).join(", ")})` : "",
        errored.length ? `${errored.length} failed (${errored.map((r) => r.id).join(", ")})` : "",
      ]
        .filter(Boolean)
        .join("; "),
      ran,
      unavailable,
      errored,
      winner: null,
    };
  }

  const fastest = ran.reduce((a, b) => (a.ms <= b.ms ? a : b));
  return {
    comparable: true,
    reason: null,
    detail: null,
    ran,
    unavailable,
    errored,
    winner: { id: fastest.id, ms: fastest.ms, basis: "latency" },
  };
}

/** Stable hash of the exact prompt bytes each contender was handed. */
export function hashPrompt(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * Process plumbing.
 * ------------------------------------------------------------------ */

/**
 * WHY THE PROMPT IS NEVER AN ARGUMENT.
 *
 * The first version of this file spawned with `shell: true` on Windows, because
 * npm installs these CLIs as `.cmd` shims that cannot be executed directly.
 * With `shell: true` Node does not escape argv, it concatenates it — so a
 * prompt of
 *
 *     Explain a race condition" && del /q important.txt && echo "
 *
 * is not a prompt, it is three commands. Node warns about exactly this
 * (DEP0190) and the warning was right.
 *
 * Passing the prompt on stdin removes the vector rather than trying to quote
 * around it: stdin is a pipe, not a string the shell ever parses. Everything
 * still in argv here is a fixed literal from CONTENDERS, never user input.
 */
async function runProcess(bin, args, opts) {
  // shell:false first, because the shell is what makes argv concatenation
  // possible. It is only needed for npm's .cmd shims on Windows, and spawn
  // reports a missing executable ASYNCHRONOUSLY (an 'error' event, not a
  // throw) — so the retry has to happen after the first attempt resolves, not
  // in a try/catch around it. Getting that wrong would report every .cmd-shim
  // CLI as "not installed", which is the same lie in the other direction.
  const first = await runProcessOnce(bin, args, opts, false);
  if (first.spawnFailed && IS_WINDOWS) {
    return runProcessOnce(bin, args, opts, true);
  }
  return first;
}

function runProcessOnce(bin, args, { timeoutMs, input }, useShell) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let child;
    try {
      child = spawn(bin, args, { shell: useShell, windowsHide: true });
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: String(e.message), ms: 0, spawnFailed: true });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (e) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code: null, stdout, stderr: stderr || String(e.message), ms, spawnFailed: true });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, stdout, stderr, ms, timedOut, spawnFailed: false });
    });

    if (input != null && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/**
 * Is the binary anywhere on PATH?
 *
 * Needed because `spawn(..., {shell: true})` on Windows routes through cmd.exe,
 * which reports a missing command as a plain exit 1 — indistinguishable from a
 * command that exists and failed. Without this the report said
 * "`codex --version` exited 1", which reads as "codex is installed and broken"
 * when the truth is "codex is not installed". Same verdict, wrong reason, and
 * the wrong reason is the one that sends you debugging a program you do not have.
 */
export function onPath(bin) {
  const exts = IS_WINDOWS ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, bin + ext))) return true;
      } catch {}
    }
  }
  return false;
}

/** Is this CLI actually runnable? Runs its own --version rather than trusting PATH. */
export async function detect(contender, { timeoutMs = 15000 } = {}) {
  const present = onPath(contender.bin);
  if (!present) {
    return {
      id: contender.id, label: contender.label, bin: contender.bin,
      available: false, version: null,
      why: `not installed (\`${contender.bin}\` is not on PATH)`,
    };
  }
  const r = await runProcess(contender.bin, contender.probe, { timeoutMs });
  const ok = !r.spawnFailed && r.code === 0;
  return {
    id: contender.id,
    label: contender.label,
    bin: contender.bin,
    available: ok,
    version: ok ? (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 60) : null,
    why: ok ? null : `installed, but \`${contender.bin} ${contender.probe.join(" ")}\` exited ${r.code}`,
  };
}

/** Run one contender against one prompt. Never throws. */
export async function runOne(contender, prompt, { timeoutMs = 120000 } = {}) {
  const promptHash = hashPrompt(prompt);
  const probe = await detect(contender);
  if (!probe.available) {
    return {
      id: contender.id,
      label: contender.label,
      status: UNAVAILABLE,
      ms: null,
      tokensIn: null,
      tokensOut: null,
      output: null,
      promptHash,
      note: probe.why,
    };
  }

  const r = await runProcess(contender.bin, contender.invoke(), { timeoutMs, input: prompt });

  if (r.timedOut) {
    return {
      id: contender.id, label: contender.label, status: TIMEOUT, ms: r.ms,
      tokensIn: null, tokensOut: null, output: null, promptHash,
      note: `killed after ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  if (r.code !== 0 || !r.stdout.trim()) {
    return {
      id: contender.id, label: contender.label, status: ERROR, ms: r.ms,
      tokensIn: null, tokensOut: null, output: null, promptHash,
      note: r.code !== 0 ? `exited ${r.code}: ${r.stderr.trim().slice(0, 160)}` : "exited 0 but produced no output",
    };
  }

  return {
    id: contender.id, label: contender.label, status: RAN, ms: r.ms,
    // No CLI in this set reports its token accounting on stdout in a stable,
    // documented shape. Rather than regex something fragile and print it as a
    // measurement, these stay null and the table says "not reported".
    tokensIn: null, tokensOut: null,
    output: r.stdout.trim(), promptHash, note: null,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

const bold = (s) => `[1m${s}[22m`;
const dim = (s) => `[2m${s}[22m`;
const red = (s) => `[31m${s}[39m`;

export function renderReport(outcome, { prompt, showCost = true }) {
  const L = [];
  L.push("");
  L.push(`  ${bold("Model comparison")}`);
  L.push(dim(`  prompt sha256:${hashPrompt(prompt)}  ·  ${prompt.length} chars  ·  node ${process.version}, ${process.platform}`));
  L.push("");

  const all = [...outcome.ran, ...outcome.errored, ...outcome.unavailable];
  const w = Math.max(...all.map((r) => r.label.length), 8);

  L.push(`  ${"MODEL".padEnd(w)}  ${"STATUS".padEnd(11)}  ${"LATENCY".padStart(9)}  ${"TOKENS".padStart(10)}${showCost ? "  " + "COST".padStart(9) : ""}`);
  L.push(`  ${"-".repeat(w)}  ${"-".repeat(11)}  ${"-".repeat(9)}  ${"-".repeat(10)}${showCost ? "  " + "-".repeat(9) : ""}`);

  for (const r of all) {
    const lat = r.status === RAN ? `${Math.round(r.ms)}ms` : r.status === TIMEOUT ? "timeout" : "—";
    const tok = r.tokensIn == null ? "not reported" : `${r.tokensIn}/${r.tokensOut}`;
    const c = costOf(r.id, r.tokensIn, r.tokensOut);
    const cost = c == null ? "no price" : `$${c.toFixed(4)}`;
    const status = r.status === RAN ? r.status : red(r.status);
    // padEnd on the colourised string would count escape bytes, so pad first.
    const statusCell = r.status === RAN ? r.status.padEnd(11) : red(r.status.padEnd(11));
    L.push(`  ${r.label.padEnd(w)}  ${statusCell}  ${lat.padStart(9)}  ${tok.padStart(10)}${showCost ? "  " + cost.padStart(9) : ""}`);
    if (r.note) L.push(dim(`  ${" ".repeat(w)}  ${r.note}`));
  }

  L.push("");
  if (outcome.comparable) {
    L.push(`  ${bold("Fastest:")} ${outcome.winner.id} at ${Math.round(outcome.winner.ms)}ms`);
    L.push(dim("  Latency only. This says nothing about which answer was better."));
  } else {
    L.push(`  ${bold(red("NO COMPARISON"))} — ${outcome.reason}.`);
    if (outcome.detail) L.push(dim(`  ${outcome.detail}`));
    L.push(dim("  A winner is not reported when there was nothing to win against."));
  }
  if (showCost) {
    L.push("");
    L.push(dim(`  Prices are a snapshot taken ${PRICE_TABLE_DATE} and are not refreshed automatically.`));
    L.push(dim("  Cells reading \"no price\" are models whose CLI does not report which model it billed."));
  }
  L.push("");
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Selftest.
 * ------------------------------------------------------------------ */

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") => {
    const pass = JSON.stringify(expected) === JSON.stringify(got);
    results.push({ name, pass, expected: JSON.stringify(expected), got: JSON.stringify(got), detail });
  };

  const mk = (id, status, ms, promptHash = "aaaa") => ({ id, label: id, status, ms, tokensIn: null, tokensOut: null, promptHash, note: null });

  // --- the rule the whole skill exists to enforce
  check(
    "two unavailable + one ran => NOT comparable",
    false,
    decideOutcome([mk("claude", RAN, 100), mk("gpt", UNAVAILABLE, null), mk("gemini", UNAVAILABLE, null)]).comparable
  );
  check(
    "...and it names no winner",
    null,
    decideOutcome([mk("claude", RAN, 100), mk("gpt", UNAVAILABLE, null), mk("gemini", UNAVAILABLE, null)]).winner
  );
  check(
    "...and the one that DID run is still reported, not dropped",
    1,
    decideOutcome([mk("claude", RAN, 100), mk("gpt", UNAVAILABLE, null)]).ran.length
  );
  check(
    "zero ran => not comparable, and the reason says so",
    "no model ran",
    decideOutcome([mk("gpt", UNAVAILABLE, null), mk("gemini", UNAVAILABLE, null)]).reason
  );
  check(
    "two ran => comparable",
    true,
    decideOutcome([mk("claude", RAN, 100), mk("gpt", RAN, 250)]).comparable
  );
  check(
    "...and the faster one wins",
    "claude",
    decideOutcome([mk("claude", RAN, 100), mk("gpt", RAN, 250)]).winner.id
  );
  check(
    "...regardless of argument order",
    "claude",
    decideOutcome([mk("gpt", RAN, 250), mk("claude", RAN, 100)]).winner.id
  );

  // --- ERROR is not UNAVAILABLE
  const errOutcome = decideOutcome([mk("claude", RAN, 100), mk("gpt", ERROR, 40)]);
  check("a model that ran and broke is not comparable against", false, errOutcome.comparable);
  check("...and it is counted as errored, not unavailable", 1, errOutcome.errored.length);
  check("...and NOT as unavailable", 0, errOutcome.unavailable.length);
  check("a timeout counts as errored too", 1, decideOutcome([mk("a", RAN, 1), mk("b", TIMEOUT, 999)]).errored.length);

  // --- prompt-identity guard
  const mixed = decideOutcome([mk("claude", RAN, 100, "aaaa"), mk("gpt", RAN, 250, "bbbb")]);
  check("two runs on DIFFERENT prompts are not comparable", false, mixed.comparable);
  check("...and the reason names the prompt, not the models", true, /same prompt/.test(mixed.reason));
  check(
    "same prompt hash across three runs is comparable",
    true,
    decideOutcome([mk("a", RAN, 1, "x"), mk("b", RAN, 2, "x"), mk("c", RAN, 3, "x")]).comparable
  );

  // --- hashing
  check("the same prompt hashes the same", hashPrompt("write a haiku"), hashPrompt("write a haiku"));
  check("a one-character change changes the hash", false, hashPrompt("write a haiku") === hashPrompt("write a haiky"));
  check("whitespace is significant (it reaches the model)", false, hashPrompt("a b") === hashPrompt("a  b"));

  // --- cost
  check("a model with no published price costs null, not zero", null, costOf("gpt", 1000, 1000));
  check("null tokens cost null even when the model has a price", null, costOf("claude", null, null));
  check("a real price computes", 0.03, Number(costOf("claude", 1e6 * 0.001, 1e6 * 0.001).toFixed(4)));

  // --- rendering does not crash on the ugly cases, and tells the truth in them
  const rep = renderReport(decideOutcome([mk("claude", RAN, 100), mk("gpt", UNAVAILABLE, null)]), { prompt: "hi" });
  check("the report prints NO COMPARISON when it cannot compare", true, /NO COMPARISON/.test(rep));
  check("the report never prints 0ms for a model that did not run", false, /UNAVAILABLE.*0ms/.test(rep));
  check("the unavailable model still appears in the table", true, /gpt/.test(rep));
  const rep2 = renderReport(decideOutcome([mk("claude", RAN, 100, "x"), mk("gpt", RAN, 250, "x")]), { prompt: "hi" });
  check("a real comparison prints a fastest line", true, /Fastest:/.test(rep2));
  check("...and disclaims that latency is not quality", true, /nothing about which answer was better/.test(rep2));
  check("cost can be turned off entirely", false, /COST/.test(renderReport(decideOutcome([mk("a", RAN, 1, "x"), mk("b", RAN, 2, "x")]), { prompt: "hi", showCost: false })));

  // --- "not installed" must not be reported as "installed and broken"
  check("node itself is found on PATH", true, onPath("node"));
  check("a binary nobody has is not found", false, onPath("tb-definitely-not-a-real-binary-xyz"));
  check("the empty string is not a binary", false, onPath(""));

  // --- the contender table itself
  check("three contenders are configured", 3, CONTENDERS.length);
  check("every contender has a probe that proves runnability", true, CONTENDERS.every((c) => Array.isArray(c.probe) && c.probe.length > 0));
  check("every contender has a price-table entry (even if null)", true, CONTENDERS.every((c) => c.id in PRICES));

  // --- COMMAND INJECTION. The prompt must never reach argv, because argv is
  //     concatenated unescaped under `shell: true` on Windows.
  const evil = 'ok" && echo PWNED && echo "';
  check(
    "no contender puts the prompt in argv",
    true,
    CONTENDERS.every((c) => c.invoke(evil).every((a) => !a.includes("PWNED") && !a.includes(evil)))
  );
  check(
    "invoke() takes no argument at all, so a prompt cannot be threaded into it by mistake",
    true,
    CONTENDERS.every((c) => c.invoke.length === 0)
  );
  check(
    "every argv element is a fixed literal with no shell metacharacters",
    true,
    CONTENDERS.every((c) => c.invoke().every((a) => !/[&|;<>$`"'\n]/.test(a)))
  );

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-model-bench selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A model that was never asked is never scored, and one result is never a comparison.\n\n");
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "no-cost") { out.noCost = true; continue; }
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "selftest") return selftest();

  if (cmd === "detect") {
    const rows = await Promise.all(CONTENDERS.map((c) => detect(c)));
    process.stdout.write(`\n  ${bold("Model CLIs on this machine")}\n\n`);
    const w = Math.max(...rows.map((r) => r.label.length));
    for (const r of rows) {
      process.stdout.write(`  ${r.label.padEnd(w)}  ${r.available ? "available" : red("not available")}  ${dim(r.available ? r.version : r.why)}\n`);
    }
    const n = rows.filter((r) => r.available).length;
    process.stdout.write(`\n  ${n} of ${rows.length} available. ${n < 2 ? red("A comparison needs at least two.") : "A comparison is possible."}\n\n`);
    if (n < 2) process.exitCode = 1;
    return;
  }

  if (cmd === "run") {
    const prompt = typeof args.prompt === "string" ? args.prompt : null;
    if (!prompt) {
      process.stdout.write("\n  usage: tb-model-bench.mjs run --prompt \"...\" [--models claude,gpt] [--timeout 120] [--no-cost]\n\n");
      process.exitCode = 1;
      return;
    }
    const only = typeof args.models === "string" ? args.models.split(",").map((s) => s.trim()) : null;
    const chosen = only ? CONTENDERS.filter((c) => only.includes(c.id)) : CONTENDERS;
    if (!chosen.length) {
      process.stdout.write(`\n  no contender matches --models ${args.models}. known: ${CONTENDERS.map((c) => c.id).join(", ")}\n\n`);
      process.exitCode = 1;
      return;
    }
    const timeoutMs = (Number(args.timeout) || 120) * 1000;

    // Sequential, not parallel: three CLIs racing for the same CPU makes the
    // latency column measure contention rather than the models.
    const results = [];
    for (const c of chosen) {
      process.stderr.write(dim(`  running ${c.id}...\n`));
      results.push(await runOne(c, prompt, { timeoutMs }));
    }

    const outcome = decideOutcome(results);
    process.stdout.write(renderReport(outcome, { prompt, showCost: !args.noCost }));

    if (args.out) {
      const dir = path.dirname(path.resolve(String(args.out)));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(String(args.out), JSON.stringify({ prompt, promptHash: hashPrompt(prompt), at: new Date().toISOString(), outcome }, null, 2));
      process.stdout.write(dim(`  wrote ${path.resolve(String(args.out))}\n\n`));
    }
    // A run that could not compare is not a failed run — it is an honest one.
    // Exit 0 so a caller can distinguish "the tool broke" from "there was
    // nothing to compare", which the report already says in words.
    return;
  }

  process.stdout.write("\n  usage: tb-model-bench.mjs run --prompt \"...\" | detect | selftest\n\n");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
