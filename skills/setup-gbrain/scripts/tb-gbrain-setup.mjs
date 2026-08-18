#!/usr/bin/env node
/**
 * tb-gbrain-setup.mjs — get from zero to "gbrain is running and this agent can
 * actually call it", and prove each half of that sentence separately.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * DERIVED WORK. The /setup-gbrain skill name and command surface are gstack's,
 * by Garry Tan (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026
 * Garry Tan). gbrain itself is his. This code drives the real CLI rather than
 * reimplementing it. See LICENSE and NOTICE.
 *
 * This command NEVER writes to the brain and never runs `gbrain init` without
 * being asked: `check` and `doctor` are read-only, and `init` is a separate
 * verb you have to type.
 *
 *   node tb-gbrain-setup.mjs check     probe every capability, print a verdict
 *   node tb-gbrain-setup.mjs doctor    hand off to gbrain's own health check
 *   node tb-gbrain-setup.mjs init      create a brain (asks gbrain to do it)
 *   node tb-gbrain-setup.mjs selftest
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKS, DEGRADED, ABSENT,
  detectCli, readConfig, capabilities, verdict,
  probeKeyword, probeCode, renderCapabilities, sh, daemonHolding,
  bold, dim, red, yellow, green,
  coreSelftestCases,
} from "./tb-gbrain-core.mjs";

function runCheck({ probe = true } = {}) {
  const cli = detectCli();
  const cfg = readConfig();

  const probes = {};
  // Diagnose contention FIRST: if a daemon holds the DB, every probe below
  // would time out and report the wrong cause.
  if (cli.installed && cfg.config) probes.daemon = daemonHolding(cfg.config);
  if (probe && cli.installed && cfg.config && !probes.daemon?.held) {
    const k = probeKeyword("the");
    probes.keyword = k.ok;
    probes.keywordWhy = k.why;

    // Only probe semantic search when embeddings are actually on. Probing it
    // with embeddings off would "pass" on keyword fallback and manufacture the
    // exact false green this skill exists to prevent.
    if (cfg.config.embedding_disabled !== true) {
      const q = sh("gbrain", ["query", "what is this brain about"], { timeout: 60000 });
      probes.semantic = q.code === 0 && !q.failed;
      probes.semanticWhy = probes.semantic ? null : `\`gbrain query\` exited ${q.code}`;
    }

    const c = probeCode("main");
    probes.code = c.ok;
    probes.codeWhy = c.why;
  }

  const caps = capabilities({ cli, config: cfg.config, probes });
  return { cli, cfg, caps, verdict: verdict(caps) };
}

function render(r) {
  const L = [];
  L.push("");
  L.push(`  ${bold("gbrain setup check")}`);
  L.push(dim("  read only — this command does not write to your brain"));
  L.push("");

  L.push(`  ${bold("Config")}  ${dim(r.cfg.path)}`);
  if (!r.cfg.exists) L.push(`    ${red("missing")} — ${r.cfg.error}`);
  else if (r.cfg.error) L.push(`    ${red(r.cfg.error)}`);
  else {
    for (const [k, v] of Object.entries(r.cfg.safe)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      L.push(`    ${k.padEnd(20)} ${String(s).slice(0, 70)}`);
    }
  }
  L.push("");

  L.push(`  ${bold("Capabilities")}  ${dim("(probed, not inferred)")}`);
  L.push(renderCapabilities(r.caps));
  L.push("");

  const paint = r.verdict.ready ? green : r.verdict.headline === "PARTIALLY READY" ? yellow : red;
  L.push(`  ${bold(paint(r.verdict.headline))} — ${r.verdict.why}`);
  L.push("");

  const degraded = r.caps.filter((c) => c.state === DEGRADED || c.state === ABSENT);
  if (degraded.length) {
    L.push(`  ${bold("What to do")}`);
    for (const c of degraded) L.push(`    ${c.name}: ${c.detail}`);
    L.push("");
  }
  return L.join("\n");
}

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") => {
    const pass = JSON.stringify(expected) === JSON.stringify(got);
    results.push({ name, pass, expected: JSON.stringify(expected), got: JSON.stringify(got), detail });
  };

  coreSelftestCases(check);

  // --- rendering the trap case must not read as success anywhere in the text
  const trap = {
    cli: { installed: true, version: "0.42.53.0" },
    cfg: { path: "/x/config.json", exists: true, error: null, safe: { engine: "pglite", embedding_disabled: true } },
    caps: capabilities({
      cli: { installed: true, version: "0.42.53.0" },
      config: { engine: "pglite", database_path: process.cwd(), embedding_disabled: true },
      probes: { keyword: true, code: true },
    }),
  };
  trap.verdict = verdict(trap.caps);
  const text = render(trap);
  check("the trap case never renders the word READY on its own", false, /\bREADY\b/.test(text.replace(/PARTIALLY READY|NOT READY/g, "")));
  check("...it renders PARTIALLY READY", true, /PARTIALLY READY/.test(text));
  check("...and prints a What to do section", true, /What to do/.test(text));
  check("...naming the embedding config key", true, /embedding_disabled/.test(text));
  check("the header states it is read only", true, /does not write to your brain/.test(text));

  // --- a secret in config must never appear in rendered output
  const secretCfg = {
    cli: { installed: true, version: "1" },
    cfg: { path: "/x", exists: true, error: null, safe: readConfigSafeFixture() },
    caps: capabilities({ cli: { installed: true, version: "1" }, config: { engine: "pglite", database_path: process.cwd() }, probes: { keyword: true, semantic: true, code: true } }),
  };
  secretCfg.verdict = verdict(secretCfg.caps);
  check("a secret value never reaches the rendered output", false, /sk-ant-SUPERSECRET/.test(render(secretCfg)));

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-gbrain-setup selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A configured capability is not a working one, and only the second is reported as ready.\n\n");
}

/** Mimics readConfig()'s redaction without touching the real config file. */
function readConfigSafeFixture() {
  return { engine: "pglite", anthropic_api_key: "<set, 40 chars, not shown>" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  if (cmd === "selftest") {
    selftest();
  } else if (cmd === "check" || cmd === undefined) {
    const r = runCheck({ probe: !process.argv.includes("--no-probe") });
    process.stdout.write(render(r));
    if (!r.verdict.ready) process.exitCode = 1;
  } else if (cmd === "doctor") {
    const r = sh("gbrain", ["doctor", "--fast"], { timeout: 180000 });
    process.stdout.write((r.out || r.err || "gbrain doctor produced no output") + "\n");
    process.exitCode = r.code === 0 ? 0 : 1;
  } else if (cmd === "init") {
    // Deliberately a separate verb. `check` never creates anything.
    const r = sh("gbrain", ["init"], { timeout: 300000 });
    process.stdout.write((r.out || r.err) + "\n");
    process.exitCode = r.code === 0 ? 0 : 1;
  } else {
    process.stdout.write("\n  usage: tb-gbrain-setup.mjs check [--no-probe] | doctor | init | selftest\n\n");
    process.exitCode = 1;
  }
}
