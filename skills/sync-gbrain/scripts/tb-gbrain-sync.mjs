#!/usr/bin/env node
/**
 * tb-gbrain-sync.mjs — index this repo into gbrain, pin the worktree, and
 * prove the result is searchable before saying so.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * DERIVED WORK. The /sync-gbrain skill name, the `.gbrain-source` worktree pin
 * and the command surface are gstack's, by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gbrain itself is his. This code drives the real CLI. See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS.
 *
 * `gbrain sync` exiting 0 is not evidence that anything is searchable. It is
 * evidence that a sync process ran. The two come apart constantly — an empty
 * file list, a filter that matched nothing, an embedding step that was skipped,
 * a brain that timed out on open. In every one of those the exit code is 0 and
 * the log says "sync complete".
 *
 * The agent then stops using Grep, because it was told the repo is indexed, and
 * every subsequent answer is drawn from an index that does not contain the
 * code. That is worse than never syncing: it is a confident wrong answer where
 * there would have been a correct slow one.
 *
 * So `sync` here is a three-step contract and the third step is the point:
 *
 *   1. run the sync
 *   2. pin the worktree, so queries are scoped to this repo
 *   3. VERIFY, by asking gbrain for a symbol that this repo definitely
 *      contains and that a generic brain would not — and reporting NOT
 *      SEARCHABLE if it comes back empty, whatever step 1 exited with.
 *
 * The verification symbol is read from the repo's own files rather than
 * hardcoded, because a hardcoded symbol is a fixture, and a fixture proves the
 * fixture.
 *
 *   node tb-gbrain-sync.mjs sync [--repo <path>] [--full] [--strategy code]
 *   node tb-gbrain-sync.mjs verify [--repo <path>]
 *   node tb-gbrain-sync.mjs pin [--repo <path>]
 *   node tb-gbrain-sync.mjs status [--repo <path>]
 *   node tb-gbrain-sync.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectCli, readConfig, sh, countHits,
  bold, dim, red, yellow, green,
  coreSelftestCases,
} from "./tb-gbrain-core.mjs";

export const PIN_FILE = ".gbrain-source";

/* ------------------------------------------------------------------ *
 * Picking a symbol that proves THIS repo is indexed.
 * ------------------------------------------------------------------ */

/**
 * Pull candidate symbols out of source text.
 *
 * Deliberately biased toward long, distinctive, repo-specific names. A symbol
 * like `main`, `get` or `run` exists in every brain, so finding it proves
 * nothing about this repo — which is exactly how a verification step becomes
 * decoration.
 */
export function extractSymbols(source, { minLength = 12 } = {}) {
  const out = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) {
      const name = m[1];
      if (name.length >= minLength && !GENERIC_SYMBOLS.has(name.toLowerCase())) out.add(name);
    }
  }
  // Longest first: the longer the identifier, the less likely a generic brain
  // has it by coincidence.
  return [...out].sort((a, b) => b.length - a.length);
}

export const GENERIC_SYMBOLS = new Set([
  "main", "run", "get", "set", "init", "start", "stop", "index", "handler",
  "default", "test", "setup", "teardown", "constructor", "render", "update",
]);

/** Walk a repo for source files, skipping the directories that are never ours. */
export function findSourceFiles(root, { limit = 40 } = {}) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "vendor", "__pycache__", ".venv", "coverage"]);
  const EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".rb"]);
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, depth + 1); }
      else if (EXT.has(path.extname(e.name))) found.push(p);
    }
  };
  walk(root, 0);
  return found;
}

/** The symbol this run will verify with, and where it came from. */
export function chooseVerificationSymbol(root) {
  for (const f of findSourceFiles(root)) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const syms = extractSymbols(text);
    if (syms.length) return { symbol: syms[0], file: path.relative(root, f) };
  }
  return { symbol: null, file: null };
}

/* ------------------------------------------------------------------ *
 * The pin.
 * ------------------------------------------------------------------ */

export function gitTopLevel(dir) {
  const r = sh("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 20000 });
  return r.code === 0 && r.out ? r.out.trim() : null;
}

export function readPin(root) {
  try {
    return fs.readFileSync(path.join(root, PIN_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writePin(root, sourceId) {
  fs.writeFileSync(path.join(root, PIN_FILE), sourceId + "\n");
  return path.join(root, PIN_FILE);
}

/** A stable source id for a repo: its directory name, lowercased and slugged. */
export function sourceIdFor(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
}

/* ------------------------------------------------------------------ *
 * THE RULE. What a sync run is allowed to claim.
 * ------------------------------------------------------------------ */

export const SEARCHABLE = "SEARCHABLE";
export const NOT_SEARCHABLE = "NOT_SEARCHABLE";
export const UNVERIFIED = "UNVERIFIED";

/**
 * Pure. Given what the sync did and what verification found, decide what may
 * be said. `syncExitCode === 0` on its own never reaches SEARCHABLE.
 */
export function syncVerdict({ syncExitCode, symbol, hits, verifyRan }) {
  if (syncExitCode !== 0) {
    return { state: NOT_SEARCHABLE, headline: "SYNC FAILED", why: `\`gbrain sync\` exited ${syncExitCode}; nothing was indexed` };
  }
  if (!symbol) {
    return {
      state: UNVERIFIED,
      headline: "SYNC RAN, NOT VERIFIED",
      why: "no distinctive symbol could be found in this repo to verify with, so a successful sync cannot be distinguished from an empty one",
    };
  }
  if (!verifyRan) {
    return { state: UNVERIFIED, headline: "SYNC RAN, NOT VERIFIED", why: "verification was skipped, so the index was not shown to contain this repo" };
  }
  if (hits > 0) {
    return { state: SEARCHABLE, headline: "SEARCHABLE", why: `gbrain resolved \`${symbol}\`, which only exists in this repo` };
  }
  return {
    state: NOT_SEARCHABLE,
    headline: "SYNC EXITED 0 BUT THIS REPO IS NOT SEARCHABLE",
    why: `gbrain returned nothing for \`${symbol}\`, a symbol that is definitely in this repo. Do not rely on gbrain for code questions here — use Grep.`,
  };
}

/* ------------------------------------------------------------------ *
 * Commands.
 * ------------------------------------------------------------------ */

function doVerify(root, { symbolOverride } = {}) {
  const chosen = symbolOverride ? { symbol: symbolOverride, file: "(given on the command line)" } : chooseVerificationSymbol(root);
  if (!chosen.symbol) return { ...chosen, hits: 0, verifyRan: false, why: "no distinctive symbol found" };
  const r = sh("gbrain", ["code-def", chosen.symbol], { cwd: root, timeout: 60000 });
  if (r.failed) return { ...chosen, hits: 0, verifyRan: false, why: r.reason };
  return { ...chosen, hits: r.code === 0 ? countHits(r.out) : 0, verifyRan: true, why: r.code === 0 ? null : `exited ${r.code}: ${(r.err || "").slice(0, 160)}` };
}

function render({ root, cli, verdict, chosen, pin, syncOut }) {
  const L = [];
  L.push("");
  L.push(`  ${bold("gbrain sync")}  ${dim(root)}`);
  L.push("");
  if (syncOut) {
    L.push(`  ${bold("Sync output")}`);
    for (const line of syncOut.split("\n").slice(0, 12)) L.push(dim("    " + line.slice(0, 120)));
    L.push("");
  }
  L.push(`  ${bold("Worktree pin")}`);
  L.push(pin ? `    ${PIN_FILE} -> ${pin}` : `    ${yellow("not pinned")} — queries will not be scoped to this repo`);
  L.push("");
  L.push(`  ${bold("Verification")}`);
  if (chosen?.symbol) {
    L.push(`    symbol   ${chosen.symbol}   ${dim("from " + chosen.file)}`);
    L.push(`    hits     ${chosen.hits}`);
    if (chosen.why) L.push(dim(`    note     ${chosen.why}`));
  } else {
    L.push(`    ${yellow("no distinctive symbol found in this repo")}`);
  }
  L.push("");
  const paint = verdict.state === SEARCHABLE ? green : verdict.state === UNVERIFIED ? yellow : red;
  L.push(`  ${bold(paint(verdict.headline))}`);
  L.push(`  ${dim(verdict.why)}`);
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

  coreSelftestCases(check);

  // --- THE RULE
  check(
    "exit 0 with zero hits is NOT searchable",
    NOT_SEARCHABLE,
    syncVerdict({ syncExitCode: 0, symbol: "chooseVerificationSymbol", hits: 0, verifyRan: true }).state
  );
  check(
    "...and the headline says so in plain words",
    true,
    /NOT SEARCHABLE/.test(syncVerdict({ syncExitCode: 0, symbol: "x".repeat(14), hits: 0, verifyRan: true }).headline)
  );
  check(
    "...and it tells the agent to fall back to Grep",
    true,
    /use Grep/.test(syncVerdict({ syncExitCode: 0, symbol: "x".repeat(14), hits: 0, verifyRan: true }).why)
  );
  check(
    "exit 0 with hits IS searchable",
    SEARCHABLE,
    syncVerdict({ syncExitCode: 0, symbol: "chooseVerificationSymbol", hits: 2, verifyRan: true }).state
  );
  check(
    "a non-zero sync is never searchable, even with hits",
    NOT_SEARCHABLE,
    syncVerdict({ syncExitCode: 1, symbol: "x", hits: 5, verifyRan: true }).state
  );
  check(
    "skipping verification yields UNVERIFIED, not SEARCHABLE",
    UNVERIFIED,
    syncVerdict({ syncExitCode: 0, symbol: "x".repeat(14), hits: 0, verifyRan: false }).state
  );
  check(
    "no symbol to verify with yields UNVERIFIED, not SEARCHABLE",
    UNVERIFIED,
    syncVerdict({ syncExitCode: 0, symbol: null, hits: 0, verifyRan: true }).state
  );
  check(
    "UNVERIFIED and SEARCHABLE are different states",
    false,
    syncVerdict({ syncExitCode: 0, symbol: null, hits: 0, verifyRan: true }).state === SEARCHABLE
  );

  // --- symbol choice is distinctive, not generic
  const src = `
    export function chooseVerificationSymbol(root) {}
    export function main() {}
    function get() {}
    export const SHELL_METACHARACTERS = /x/;
    class ThisIsALongClassName {}
    def compute_something_distinctive(): pass
  `;
  const syms = extractSymbols(src);
  check("a long exported function is a candidate", true, syms.includes("chooseVerificationSymbol"));
  check("`main` is NEVER a candidate", false, syms.includes("main"));
  check("`get` is NEVER a candidate", false, syms.includes("get"));
  check("a long class name is a candidate", true, syms.includes("ThisIsALongClassName"));
  check("a python def is a candidate", true, syms.includes("compute_something_distinctive"));
  check("an exported const is a candidate", true, syms.includes("SHELL_METACHARACTERS"));
  check("candidates are sorted longest first", true, syms[0].length >= syms[syms.length - 1].length);
  check("short names are excluded by length", false, extractSymbols("export function ab() {}").includes("ab"));
  check("an empty file yields no candidates", 0, extractSymbols("").length);

  // --- it can find a symbol in THIS repo, which is the real path
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const real = chooseVerificationSymbol(here);
  check("a real symbol is found in the toolbay-stack repo itself", true, typeof real.symbol === "string" && real.symbol.length >= 12);
  check("...and it is attributed to a real file", true, typeof real.file === "string" && real.file.length > 0);

  // --- source ids
  check("a source id is slugged", "toolbay-stack", sourceIdFor("C:/x/toolbay-stack"));
  check("a source id lowercases", "myrepo", sourceIdFor("/x/MyRepo"));
  check("a source id never ends up empty", "repo", sourceIdFor("/x/---"));

  // --- file discovery skips what is never ours
  const files = findSourceFiles(here, { limit: 200 });
  check("source discovery finds files in this repo", true, files.length > 0);
  check("...and never descends into node_modules", false, files.some((f) => f.includes("node_modules")));
  check("...and never descends into .git", false, files.some((f) => f.includes(`${path.sep}.git${path.sep}`)));

  // --- rendering the dangerous case
  const text = render({
    root: "/x",
    cli: { installed: true, version: "1" },
    verdict: syncVerdict({ syncExitCode: 0, symbol: "chooseVerificationSymbol", hits: 0, verifyRan: true }),
    chosen: { symbol: "chooseVerificationSymbol", file: "a.mjs", hits: 0 },
    pin: "toolbay-stack",
    syncOut: "sync complete",
  });
  check("a zero-hit run never renders the bare word SEARCHABLE as a pass", true, /NOT SEARCHABLE/.test(text));
  check("...even though the sync output said 'sync complete'", true, /sync complete/.test(text));

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-gbrain-sync selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A sync that exits 0 over an empty index is reported as not searchable, because it is.\n\n");
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
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = path.resolve(typeof args.repo === "string" ? args.repo : process.cwd());
  const root = gitTopLevel(dir) || dir;

  if (cmd === "selftest") {
    selftest();
  } else if (cmd === "pin") {
    const id = sourceIdFor(root);
    const p = writePin(root, id);
    process.stdout.write(`\n  pinned ${p} -> ${id}\n\n`);
  } else if (cmd === "status") {
    const cli = detectCli();
    const cfg = readConfig();
    process.stdout.write(`\n  gbrain      ${cli.installed ? cli.version : red("not installed")}\n`);
    process.stdout.write(`  config      ${cfg.exists ? cfg.path : red("missing")}\n`);
    process.stdout.write(`  repo        ${root}\n`);
    process.stdout.write(`  pin         ${readPin(root) || yellow("none")}\n\n`);
  } else if (cmd === "verify") {
    const chosen = doVerify(root, { symbolOverride: typeof args.symbol === "string" ? args.symbol : undefined });
    const v = syncVerdict({ syncExitCode: 0, symbol: chosen.symbol, hits: chosen.hits, verifyRan: chosen.verifyRan });
    process.stdout.write(render({ root, cli: detectCli(), verdict: v, chosen, pin: readPin(root), syncOut: null }));
    if (v.state !== SEARCHABLE) process.exitCode = 1;
  } else if (cmd === "sync" || cmd === undefined) {
    const cli = detectCli();
    if (!cli.installed) {
      process.stdout.write(`\n  ${red("gbrain is not installed")} — ${cli.why}\n\n`);
      process.exitCode = 1;
    } else {
      const syncArgs = ["sync", "--repo", root];
      if (args.strategy === "code" || args.full) syncArgs.push("--strategy", "code");
      const r = sh("gbrain", syncArgs, { cwd: root, timeout: 900000 });
      const pin = readPin(root) || (() => { try { writePin(root, sourceIdFor(root)); return sourceIdFor(root); } catch { return null; } })();
      const chosen = doVerify(root);
      const v = syncVerdict({ syncExitCode: r.failed ? 1 : r.code, symbol: chosen.symbol, hits: chosen.hits, verifyRan: chosen.verifyRan });
      process.stdout.write(render({ root, cli, verdict: v, chosen, pin, syncOut: r.out || r.err || r.reason }));
      if (v.state !== SEARCHABLE) process.exitCode = 1;
    }
  } else {
    process.stdout.write("\n  usage: tb-gbrain-sync.mjs sync [--repo <p>] [--full] | verify | pin | status | selftest\n\n");
    process.exitCode = 1;
  }
}
