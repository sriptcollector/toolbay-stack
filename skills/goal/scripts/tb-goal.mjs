#!/usr/bin/env node
/**
 * tb-goal.mjs — say what you are trying to achieve; get back an ordered plan of
 * skills to run, each one offered rather than performed.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no equivalent of this skill. See LICENSE and NOTICE.
 *
 * WHY THIS EXISTS
 *
 * /router answers "which ONE skill handles this request". /suggest answers
 * "given the repo as it is, what is worth doing next". Neither answers the
 * question people actually arrive with, which is "here is what I want, what
 * should I run and in what order".
 *
 * THE FOUR WAYS A SKILL LIKE THIS LIES, AND WHAT IS DONE ABOUT EACH
 *
 * 1. IT INVENTS STEPS. A plan is a persuasive shape, and the temptation is to
 *    fill it out. Every step here comes from `route.mjs explain --json`, which
 *    only names a skill that exists on disk and only when the router actually
 *    chose one. This file never names a skill the router did not return, and
 *    the selftest asserts that against a catalog it controls.
 *
 * 2. IT DROPS WHAT IT COULD NOT PLAN. Silently omitting the part of a goal
 *    nothing covers turns "I can do 2 of your 3 things" into what reads as a
 *    complete plan. Unmatched pieces are reported as GAPS, in the output, at
 *    the same size as the steps.
 *
 * 3. IT PRESENTS A GUESS AS A DECISION. The router distinguishes a strong match
 *    from a weak one. That distinction survives into the plan: a weak step is
 *    labelled a guess and is never auto-ordered ahead of a strong one.
 *
 * 4. IT RUNS THINGS. This command plans. `plan` executes nothing at all — no
 *    skill, no shell, no write outside its own record. Running a step is a
 *    separate verb with an explicit index, because "and then it did it" is how
 *    an agent deletes a branch you wanted.
 *
 * A goal too vague to decompose is REFUSED with what is missing, rather than
 * answered with a generic four-step plan that would fit any project.
 *
 *   node tb-goal.mjs plan --goal "..." [--json] [--mode <name>]
 *   node tb-goal.mjs show                 the last plan
 *   node tb-goal.mjs selftest
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, "..", "..", "router", "scripts", "route.mjs");
const IS_WINDOWS = process.platform === "win32";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

/* ------------------------------------------------------------------ *
 * Splitting a goal into intents.
 * ------------------------------------------------------------------ */

/** Connectives that genuinely separate two pieces of work. */
const SPLIT_RE = /\s*(?:\band then\b|\bthen\b|\bafter that\b|\bfollowed by\b|\band also\b|[;\n]|(?<=[a-z0-9)])\.(?=\s+[A-Z]))\s*/gi;

/**
 * Split a goal into intents.
 *
 * Deliberately conservative. "test and deploy" splits on `and` in the naive
 * version, but so does "fix the login and signup flow", which is one job about
 * two pages, and splitting it invents a second step out of a noun phrase. So a
 * bare `and` is NOT a separator — only "and then" and "and also" are, where the
 * speaker has marked sequence explicitly.
 */
export function splitIntents(goal) {
  return String(goal || "")
    .split(SPLIT_RE)
    .map((s) => s.trim().replace(/^[,\-–—\s]+|[,\s]+$/g, ""))
    .filter((s) => s.length > 0);
}

/** Words that carry no routable intent on their own. */
const FILLER = new Set([
  "help", "me", "please", "can", "you", "i", "want", "need", "to", "the", "a",
  "an", "my", "it", "this", "that", "with", "for", "on", "do", "make", "just",
  "stuff", "things", "some", "something", "anything", "work", "fix",
  // Bare comparatives. "better", "faster" and friends name a DIRECTION, never a
  // subject, so "make it better" and "make it faster" are the same sentence
  // about nothing. They route — every scorer returns a top row — and the plan
  // that comes back would fit any repository on earth, which is exactly the
  // output this skill refuses to produce.
  "better", "faster", "improve", "improved", "cleaner", "nicer", "good",
  "great", "best", "more", "less", "up", "out",
]);

/**
 * Is this goal specific enough to plan against?
 *
 * "make it better" routes to something — every scorer returns a top row — and
 * the resulting plan would be indistinguishable from a plan for any other
 * project. Refusing is the honest answer, and the refusal names what is missing.
 */
export function isPlannable(goal) {
  const text = String(goal || "").trim();
  if (!text) return { ok: false, why: "no goal was given" };
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || [];
  if (words.length < 3) {
    return { ok: false, why: `"${text}" is ${words.length} word(s); name what you want to end up with, not just the verb` };
  }
  const substantive = words.filter((w) => !FILLER.has(w));
  if (substantive.length === 0) {
    return {
      ok: false,
      why: `"${text}" is all filler words, so any plan built from it would fit any project equally well`,
    };
  }
  return { ok: true, why: null };
}

/* ------------------------------------------------------------------ *
 * Routing one intent through the real router.
 * ------------------------------------------------------------------ */

export function routeIntent(intent, { mode, routerPath = ROUTER } = {}) {
  const args = [routerPath, "explain", intent, "--json"];
  if (mode) args.push("--mode", mode);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30000,
  });
  if (r.error || r.status !== 0) {
    return { intent, error: `router failed (${r.error?.code || "exit " + r.status})`, pick: null, tier: null };
  }
  let j;
  try {
    j = JSON.parse(r.stdout || "{}");
  } catch {
    return { intent, error: "router did not return JSON", pick: null, tier: null };
  }
  return {
    intent,
    tier: j.tier ?? null,
    action: j.action ?? null,
    pick: j.pick ?? null,
    topCandidate: j.topCandidate ?? null,
    marketplace: j.marketplace ?? null,
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * THE PLAN. Pure given routed intents, so it is tested directly.
 * ------------------------------------------------------------------ */

export function buildPlan(routed) {
  const steps = [];
  const gaps = [];
  const seen = new Set();

  for (const r of routed) {
    if (r.error) {
      gaps.push({ intent: r.intent, why: r.error, kind: "router-error" });
      continue;
    }
    if (!r.pick) {
      gaps.push({
        intent: r.intent,
        // The near-miss is named because it is useful, and immediately
        // disqualified because it was not chosen. Reporting it without the
        // second half would be handing over a suggestion wearing a plan's hat.
        why: r.topCandidate?.skill
          ? `no skill covers this. Closest was ${r.topCandidate.skill} at ${r.topCandidate.score}, which the router did not consider a match`
          : "no skill covers this",
        kind: "no-skill",
        marketplace: !!r.marketplace?.offered,
      });
      continue;
    }
    // The same skill twice in a row is one step, not two. Different intents
    // landing on the same skill is normal and is not evidence of a good plan.
    const key = r.pick.skill;
    if (seen.has(key)) {
      steps.find((s) => s.skill === key)?.covers.push(r.intent);
      continue;
    }
    seen.add(key);
    steps.push({
      skill: r.pick.skill,
      strength: r.pick.strength,
      guess: r.pick.strength !== "strong",
      score: r.pick.score,
      covers: [r.intent],
      why: (r.pick.why || []).slice(0, 3),
      command: `/${r.pick.skill}`,
    });
  }

  // Strong steps first. A guess never leads a plan, because the first step is
  // the one most likely to be run without being read.
  steps.sort((a, b) => Number(a.guess) - Number(b.guess));
  steps.forEach((s, i) => { s.n = i + 1; });

  return {
    steps,
    gaps,
    complete: gaps.length === 0 && steps.length > 0,
    empty: steps.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * Record, so /memory can learn which offers get taken.
 * ------------------------------------------------------------------ */

export function planRecordPath(cwd = process.cwd()) {
  return path.join(cwd, ".toolbay", "goal", "last-plan.json");
}

export function writePlan(plan, goal, cwd = process.cwd()) {
  const p = planRecordPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ goal, at: new Date().toISOString(), ...plan }, null, 2));
  return p;
}

/* ------------------------------------------------------------------ *
 * Learning which offers get taken.
 *
 * A planner that never finds out whether its plan was any good keeps making
 * the same bad step forever. The signal is `accept` / `skip`, and the more
 * valuable half is SKIP: a step you took might have been right or might have
 * been the only option; a step you refused is unambiguous.
 *
 * Two rules, because this is the part that quietly becomes surveillance:
 *
 *   1. NOTHING IS RECORDED UNLESS /memory IS ENABLED. Memory is opt-in and off
 *      by default. When it is off, this says so out loud rather than writing
 *      anywhere, and rather than silently discarding — "not recorded" is a
 *      fact the user should get to hear.
 *   2. IT RECORDS THE DECISION, NOT THE PERSON. "skipped /document-generate for
 *      a translation request" is a fact about a routing mistake. "Orion avoids
 *      documentation work" is an inference, and an inference stored as a fact
 *      is how a memory layer starts being wrong confidently.
 * ------------------------------------------------------------------ */

const MEMORY = path.resolve(HERE, "..", "..", "memory", "scripts", "tb-memory.mjs");

export function memoryEnabled() {
  if (!fs.existsSync(MEMORY)) return { on: false, why: "the memory skill is not installed" };
  const r = spawnSync(process.execPath, [MEMORY, "status"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 20000,
  });
  if (r.status !== 0 && !r.stdout) return { on: false, why: "memory status could not be read" };
  const on = /MEMORY\s+ON\b/.test(r.stdout || "");
  return { on, why: on ? null : "memory is off (opt-in). Turn it on with: tb-memory enable --yes" };
}

export function recordChoice({ verb, step, goal, why }) {
  const mem = memoryEnabled();
  if (!mem.on) return { recorded: false, why: mem.why };
  const note =
    verb === "skip"
      ? `Skipped /${step.skill} when planning "${goal}"${why ? ` — ${why}` : ""}. The planner offered it${step.guess ? " as a guess" : ""}.`
      : `Ran /${step.skill} when planning "${goal}". The planner offered it${step.guess ? " as a guess" : ""}.`;
  const r = spawnSync(process.execPath, [MEMORY, "record", note], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 25000,
  });
  if (r.status !== 0) return { recorded: false, why: `tb-memory record exited ${r.status}` };
  return { recorded: true, why: null, note };
}

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

export function render(plan, goal, { mode } = {}) {
  const L = [];
  L.push("");
  L.push(`  ${bold("Goal")}`);
  L.push(`    ${goal}`);
  if (mode) L.push(dim(`    stance: ${mode}`));
  L.push("");

  if (plan.empty) {
    L.push(`  ${bold(red("NO PLAN"))} — nothing on disk covers any part of this.`);
  } else {
    L.push(`  ${bold("Plan")}  ${dim("nothing below has been run")}`);
    for (const s of plan.steps) {
      const tag = s.guess ? yellow("  (a guess)") : "";
      L.push(`    ${bold(String(s.n) + ".")} ${cyan(s.command)}${tag}`);
      L.push(dim(`        for: ${s.covers.join(" / ")}`));
      if (s.why.length) L.push(dim(`        why: ${s.why[0]}`));
    }
  }
  L.push("");

  if (plan.gaps.length) {
    L.push(`  ${bold(yellow("Not covered"))}  ${dim("(" + plan.gaps.length + ")")}`);
    for (const g of plan.gaps) {
      L.push(`    ${g.intent}`);
      L.push(dim(`        ${g.why}`));
    }
    L.push("");
  }

  if (plan.steps.length) {
    L.push(dim("  Run one at a time. This command does not run anything."));
    L.push("");
  }
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

  // ---- splitting
  check("a sequence splits on 'then'", 2, splitIntents("run the tests then ship it").length);
  check("'and then' splits", 2, splitIntents("review the diff and then deploy").length);
  check("a bare 'and' does NOT split a noun phrase", 1, splitIntents("fix the login and signup flow").length);
  check("...which is the whole reason 'and' is not a separator", true, splitIntents("fix the login and signup flow")[0].includes("signup"));
  check("a semicolon splits", 2, splitIntents("write the spec; review it").length);
  check("a newline splits", 2, splitIntents("do this\ndo that").length);
  check("an empty goal yields nothing", 0, splitIntents("").length);
  check("a decimal does not split a sentence", 1, splitIntents("cut latency to 1.5 seconds").length);

  // ---- vagueness refusal
  check("a two-word goal is refused", false, isPlannable("go faster").ok);
  check("an all-filler goal is refused", false, isPlannable("just make it better please").ok);
  check("...and the refusal explains itself", true, /fit any project/.test(isPlannable("just make it better please").why || ""));
  check("an empty goal is refused", false, isPlannable("").ok);
  check("a specific goal is accepted", true, isPlannable("the checkout page throws a 500 on submit").ok);

  // ---- THE PLAN RULES
  const strong = (skill, intent) => ({ intent, tier: "1. local skill", pick: { skill, strength: "strong", score: 15, why: ["because"] }, error: null });
  const weak = (skill, intent) => ({ intent, tier: "2. weak match", pick: { skill, strength: "weak", score: 6, why: ["maybe"] }, error: null });
  const none = (intent, near) => ({ intent, tier: "3. answer directly", pick: null, topCandidate: near ? { skill: near, score: 0.5 } : null, error: null, marketplace: { offered: false } });

  const p1 = buildPlan([strong("investigate", "the tests fail"), strong("ship", "then ship it")]);
  check("two routed intents become two steps", 2, p1.steps.length);
  check("...numbered from 1", [1, 2], p1.steps.map((s) => s.n));
  check("...and the plan is complete", true, p1.complete);

  const p2 = buildPlan([strong("investigate", "a"), none("translate it into Farsi", "document-generate")]);
  check("an unroutable intent does NOT become a step", 1, p2.steps.length);
  check("...it becomes a reported gap", 1, p2.gaps.length);
  check("...the gap keeps the original words", "translate it into Farsi", p2.gaps[0].intent);
  check("...and the plan is NOT complete", false, p2.complete);
  check("...the near-miss is named but disqualified in the same sentence", true, /did not consider a match/.test(p2.gaps[0].why));

  const p3 = buildPlan([weak("qa", "a"), strong("investigate", "b")]);
  check("a guess never leads the plan", "investigate", p3.steps[0].skill);
  check("...and is still present, labelled", true, p3.steps[1].guess);
  check("a strong step is not labelled a guess", false, p3.steps[0].guess);

  const p4 = buildPlan([strong("review", "a"), strong("review", "b")]);
  check("the same skill twice is ONE step", 1, p4.steps.length);
  check("...covering both intents", 2, p4.steps[0].covers.length);

  const p5 = buildPlan([none("x"), none("y")]);
  check("nothing routable yields an empty plan", true, p5.empty);
  check("...which is not the same as a complete one", false, p5.complete);
  check("...and both gaps survive", 2, p5.gaps.length);

  const p6 = buildPlan([{ intent: "a", error: "router failed (ENOENT)", pick: null }]);
  check("a router failure is a gap, not a silently dropped intent", 1, p6.gaps.length);
  check("...tagged as a router error, not as 'no skill'", "router-error", p6.gaps[0].kind);

  // ---- it never invents a skill
  check(
    "every step's skill came from a router pick",
    true,
    buildPlan([strong("investigate", "a"), none("b"), weak("qa", "c")]).steps.every((s) => ["investigate", "qa"].includes(s.skill))
  );

  // ---- rendering tells the truth
  const text = render(p2, "fix the tests and translate it into Farsi");
  check("the rendered plan shows the gap", true, /Not covered/.test(text));
  check("...and says nothing was run", true, /does not run anything/.test(text));
  check("an empty plan renders NO PLAN", true, /NO PLAN/.test(render(p5, "x")));
  check("a guess is visibly marked in the output", true, /a guess/.test(render(p3, "x")));

  // ---- learning must never happen silently, or claim to have happened
  {
    const mem = memoryEnabled();
    check("memory state is a real reading, not an assumption", true, typeof mem.on === "boolean");
    check("...and when it is off, a reason is given", true, mem.on || typeof mem.why === "string");

    const step = { n: 1, skill: "investigate", guess: false };
    const r = recordChoice({ verb: "skip", step, goal: "x", why: "wrong tool" });
    if (mem.on) {
      check("with memory ON, a choice is recorded", true, r.recorded);
    } else {
      check("with memory OFF, NOTHING is recorded", false, r.recorded);
      check("...and the refusal names why, rather than failing silently", true, /opt-in|not installed|could not be read/.test(r.why || ""));
    }
    check("recordChoice never throws, whatever the memory state", true, typeof r.recorded === "boolean");
  }

  // ---- the real router, end to end
  {
    const r = routeIntent("the tests are failing and I dont know why");
    check("routing a real intent through the real router picks a skill", "investigate", r.pick?.skill ?? null);
    const r2 = routeIntent("translate this document into Farsi");
    check("...and an uncovered intent yields no pick", null, r2.pick);
    const real = buildPlan([r, r2]);
    check("a real end-to-end plan has one step and one gap", [1, 1], [real.steps.length, real.gaps.length]);
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-goal selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  Every step came from the router; nothing it could not plan was quietly dropped.\n\n");
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else o._.push(a);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "selftest") {
    selftest();
  } else if (cmd === "show") {
    const p = planRecordPath();
    try {
      const rec = JSON.parse(fs.readFileSync(p, "utf8"));
      out(render(rec, rec.goal));
    } catch {
      out(`\n  no plan recorded yet (${p})\n`);
      process.exitCode = 1;
    }
  } else if (cmd === "plan" || cmd === undefined) {
    const goal = typeof args.goal === "string" ? args.goal : args._.slice(1).join(" ");
    const v = isPlannable(goal);
    if (!v.ok) {
      out(`\n  ${bold(red("NOT PLANNABLE"))} — ${v.why}\n`);
      out(dim("  A plan built from this would fit any project, which makes it worth nothing.\n"));
      process.exitCode = 1;
    } else {
      const intents = splitIntents(goal);
      const mode = typeof args.mode === "string" ? args.mode : null;
      const routed = intents.map((i) => routeIntent(i, { mode }));
      const plan = buildPlan(routed);
      if (args.json) out(JSON.stringify({ goal, ...plan }, null, 2));
      else out(render(plan, goal, { mode }));
      try { writePlan(plan, goal); } catch { /* recording is a convenience, not a result */ }
      if (plan.empty) process.exitCode = 1;
    }
  } else if (cmd === "accept" || cmd === "skip") {
    const n = Number(args._[1]);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(planRecordPath(), "utf8"));
    } catch {
      out("\n  no plan recorded yet — run `plan` first\n");
      process.exitCode = 1;
      rec = null;
    }
    if (rec) {
      const step = (rec.steps || []).find((s) => s.n === n);
      if (!step) {
        out(`\n  no step ${args._[1] ?? "(none given)"} in the last plan (it has ${(rec.steps || []).length})\n`);
        process.exitCode = 1;
      } else {
        const r = recordChoice({ verb: cmd, step, goal: rec.goal, why: typeof args.why === "string" ? args.why : null });
        out("");
        out(`  ${cmd === "skip" ? yellow("skipped") : green("accepted")}  step ${n}: /${step.skill}`);
        // Say which of the two happened. "Noted" when nothing was written is
        // the small lie that makes a memory layer untrustworthy.
        out(r.recorded ? dim("  recorded to memory") : dim(`  NOT recorded — ${r.why}`));
        out("");
      }
    }
  } else {
    out('\n  usage: tb-goal.mjs plan --goal "..." [--json] [--mode <name>] | accept <n> | skip <n> [--why "..."] | show | selftest\n');
    process.exitCode = 1;
  }
}
