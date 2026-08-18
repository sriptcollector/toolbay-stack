#!/usr/bin/env node
/**
 * tb-spec.mjs: the gates behind the /spec workflow.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow (five phases, the hard gate against producing an
 * issue on the first message, the interrogation style, the quality standards,
 * the Standard / Epic / Audit templates, the anti-pattern list, the fail-closed
 * redaction that precedes any dispatch, and the local spec archive that /ship
 * later reads) comes from `spec` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * 1. THE ARCHIVE PATH IS BUILT FROM SHELL IDIOMS THAT DO NOT EXIST OFF POSIX.
 *    gstack (spec/SKILL.md.tmpl:200-204, :226, :351, :430):
 *
 *      printf '%s' "<body>" > /tmp/spec-semantic-$$.txt
 *      TMPERR_GATE=$(mktemp /tmp/spec-gate-XXXXXXXX)
 *      ARCHIVE_NAME="$(date +%Y%m%d-%H%M%S)-$$-${SLUG_TITLE}.md"
 *      SPAWN_BRANCH="spec/${SLUG_TITLE}-$$"
 *
 *    Measured on Windows 11, 2026-08-13:
 *
 *      PS> date +%Y%m%d-%H%M%S
 *      Get-Date : Cannot bind parameter 'Date'. Cannot convert value
 *      "+%Y%m%d-%H%M%S" to type "System.DateTime".
 *      PS> "value: [$$]"
 *      value: []
 *
 *    So the archive name becomes `--<slug>.md` at best, and the collision
 *    protection gstack explicitly documents ("The PID suffix and atomic rename
 *    prevent collisions when two /spec invocations run in the same second") is
 *    not there. `/tmp` is worse than absent: Git Bash resolves it to
 *    C:\Users\<u>\AppData\Local\Temp and Node resolves the same string to
 *    C:\tmp, so a file written by one is invisible to the other.
 *
 * 2. "TESTABLE ACCEPTANCE CRITERIA" IS THE POINT OF THE SKILL AND IS NOT
 *    CHECKED. gstack lists the rule and the counterexamples ("The feature works
 *    correctly", "Edge cases are handled") and then asks a second model to score
 *    the spec 0-10, skipping the gate entirely if codex is missing, not logged
 *    in, or slow. `lint` is deterministic, runs everywhere, and exits non-zero.
 *
 * 3. A CITED LINE NUMBER IS A CLAIM ABOUT CODE THAT EXISTS. `src/auth.ts:42` in
 *    a Files Reference table says "go and read this". `lint --check-paths`
 *    verifies exactly those and fails on the stale ones.
 *
 * `scan` is the redaction backstop, kept fail-closed as gstack has it, but with
 * no interpreter dependency and no network.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findCitations, checkCitations } from "./tb-citations.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.3.0";
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0;
const EXIT_REJECTED = 1; // the spec is not ready
const EXIT_UNUSABLE = 2; // could not read what it was asked to check
const EXIT_BLOCKED = 3; // a credential was found; nothing may be persisted

// ---------------------------------------------------------------------- io

function readInput(args) {
  const fi = args.findIndex((a) => !a.startsWith("--"));
  const file = fi === -1 ? null : args[fi];
  if (!file) {
    try {
      return { ok: true, text: fs.readFileSync(0, "utf8"), file: "(stdin)" };
    } catch {
      return { ok: false, error: "no spec file given and nothing on stdin" };
    }
  }
  try {
    return { ok: true, text: fs.readFileSync(file, "utf8"), file };
  } catch (e) {
    return { ok: false, error: `${file} could not be read (${e.code || e.message})` };
  }
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

// -------------------------------------------------------------------- lint

const REQUIRED_SECTIONS = ["Context", "Acceptance Criteria", "Out of Scope"];
const RECOMMENDED_SECTIONS = ["Current State", "Proposed Change", "Testing Plan", "Rollback Plan", "Files Reference"];

/**
 * Words that make a criterion unfalsifiable. Every one of these is either in
 * gstack's own anti-pattern list or is the same shape as one.
 */
const SUBJECTIVE = [
  "works correctly",
  "works properly",
  "works as expected",
  "as expected",
  "handles edge cases",
  "edge cases are handled",
  "properly handled",
  "gracefully",
  "appropriate",
  "appropriately",
  "reasonable",
  "reasonably",
  "user-friendly",
  "user friendly",
  "intuitive",
  "clean",
  "nice",
  "good",
  "better",
  "improved",
  "improves",
  "fast",
  "faster",
  "performant",
  "snappy",
  "robust",
  "solid",
  "seamless",
  "etc.",
  "and so on",
  "make sure it works",
  "no issues",
  "no bugs",
];

function sections(text) {
  const found = new Map();
  const lines = String(text).split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].replace(/[*_`]/g, "").trim();
      if (!found.has(current)) found.set(current, []);
      continue;
    }
    if (current) found.get(current).push(line);
  }
  return found;
}

const sectionKey = (name) => name.toLowerCase().replace(/[^a-z]/g, "");

function findSection(map, name) {
  const want = sectionKey(name);
  for (const [k, v] of map) if (sectionKey(k) === want) return v;
  return null;
}

/** Numbered or bulleted list items in a block of lines. */
function listItems(lines) {
  const items = [];
  let cur = null;
  for (const line of lines ?? []) {
    const m = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (m) {
      if (cur) items.push(cur.trim());
      cur = m[1];
    } else if (cur && line.trim() && !/^#{1,4}\s/.test(line)) {
      cur += ` ${line.trim()}`;
    } else if (cur && !line.trim()) {
      items.push(cur.trim());
      cur = null;
    }
  }
  if (cur) items.push(cur.trim());
  return items.filter(Boolean);
}

/**
 * `path/to/file.ext:42` — a citation that asserts the line exists today.
 *
 * Both the pattern and the does-it-exist check now live in tb-citations.mjs,
 * because /investigate's DONE gate needed exactly this and had nothing: it
 * accepted a report citing a file that has never existed. Two copies of this
 * would have meant the spec linter and the report gate disagreeing about what
 * counts as evidence the first time either was touched.
 */

function lintSpec(text, { root = process.cwd(), checkPaths = false } = {}) {
  const problems = [];
  const notes = [];
  const map = sections(text);

  for (const name of REQUIRED_SECTIONS) {
    if (!findSection(map, name)) problems.push(`missing required section "## ${name}"`);
  }
  for (const name of RECOMMENDED_SECTIONS) {
    if (!findSection(map, name)) notes.push(`no "## ${name}" section`);
  }

  const acLines = findSection(map, "Acceptance Criteria");
  if (acLines) {
    const items = listItems(acLines);
    if (items.length < 2) {
      problems.push(`Acceptance Criteria has ${items.length} item(s); a spec worth filing has at least 2, numbered`);
    }
    items.forEach((item, i) => {
      const low = item.toLowerCase();
      const hit = SUBJECTIVE.find((s) => new RegExp(`(^|[^a-z])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(low));
      if (hit) problems.push(`acceptance criterion ${i + 1} is not falsifiable ("${hit}"): ${item.slice(0, 80)}`);
      else if (item.replace(/[^a-z0-9]/gi, "").length < 12) {
        problems.push(`acceptance criterion ${i + 1} is too short to test: "${item}"`);
      }
    });
  }

  const scope = findSection(map, "Out of Scope");
  if (scope && !listItems(scope).length) {
    problems.push('"Out of Scope" is present but empty; name at least one thing this issue is NOT');
  }

  // Cited line numbers.
  const cites = findCitations(text);
  if (checkPaths) {
    for (const p of checkCitations(text, root).problems) problems.push(p);
    if (cites.length) notes.push(`${cites.length} file:line citation(s) checked against ${root}`);
  } else if (cites.length) {
    notes.push(`${cites.length} file:line citation(s) present; re-run with --check-paths to verify them`);
  }

  return { ok: problems.length === 0, problems, notes };
}

function cmdLint(args) {
  const json = args.includes("--json");
  const input = readInput(args.filter((a, i) => !(args[i - 1] === "--root")));
  if (!input.ok) {
    if (json) out(JSON.stringify({ ok: false, problems: [input.error] }, null, 2));
    else err(`  UNUSABLE  ${input.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const r = lintSpec(input.text, { root: flag(args, "--root") || process.cwd(), checkPaths: args.includes("--check-paths") });
  if (json) {
    out(JSON.stringify(r, null, 2));
  } else {
    out();
    if (r.ok) out("  ok  the spec is executable: every required section is present and every criterion is falsifiable");
    else {
      out(`  ${r.problems.length} problem(s):`);
      for (const p of r.problems) out(`    - ${p}`);
    }
    for (const n of r.notes) out(`  note  ${n}`);
    out();
  }
  if (!r.ok) process.exitCode = EXIT_REJECTED;
}

// -------------------------------------------------------------------- scan
//
// The deterministic backstop. It runs before anything is written to disk or
// sent anywhere, and finding a credential blocks; it does not warn.

const HIGH = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: "stripe-secret", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  // Passphrases contain spaces, so the value is anything but a quote. The
  // placeholder filter is applied to this one rule so `password = "<your-password>"`
  // in an example block does not block a spec.
  { id: "assigned-secret", re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\n]{12,}["']/i, allowPlaceholder: true },
];

const MEDIUM = [
  { id: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: "bearer-header", re: /\bAuthorization\s*:\s*Bearer\s+\S{8,}/i },
  { id: "phone", re: /\b\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
];

/** Placeholders that exist to be examples. Flagging them trains people to click through. */
const PLACEHOLDER = /(example\.(com|org|net)|\.invalid\b|<[a-z-]+>|\byour[_-]?(key|token|secret)\b|xxx+|\.{3})/i;

function scanText(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of HIGH) {
      if (!p.re.test(line)) continue;
      if (p.allowPlaceholder && PLACEHOLDER.test(line)) continue;
      findings.push({ tier: "HIGH", id: p.id, line: i + 1 });
    }
    for (const p of MEDIUM) {
      if (p.re.test(line) && !PLACEHOLDER.test(line)) findings.push({ tier: "MEDIUM", id: p.id, line: i + 1 });
    }
  });
  return findings;
}

function cmdScan(args) {
  const json = args.includes("--json");
  const input = readInput(args);
  if (!input.ok) {
    if (json) out(JSON.stringify({ ok: false, error: input.error }, null, 2));
    else err(`  UNUSABLE  ${input.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  const findings = scanText(input.text);
  const high = findings.filter((f) => f.tier === "HIGH");
  const medium = findings.filter((f) => f.tier === "MEDIUM");
  if (json) {
    out(JSON.stringify({ ok: findings.length === 0, high, medium }, null, 2));
  } else if (!findings.length) {
    out("  ok  no credentials or personal data found");
  } else {
    out();
    for (const f of findings) out(`  ${f.tier}  line ${f.line}: ${f.id}`);
    out();
    if (high.length) out("  BLOCKED. Nothing may be filed, archived, or sent while a credential is in the body.");
    else out("  Confirm with the user before this leaves the machine.");
    out();
  }
  if (high.length) process.exitCode = EXIT_BLOCKED;
  else if (medium.length) process.exitCode = EXIT_REJECTED;
}

// ----------------------------------------------------------------- archive

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "spec";

function cmdArchive(args) {
  const json = args.includes("--json");
  const title = flag(args, "--title");
  const issue = flag(args, "--issue");
  const input = readInput(args.filter((a, i) => !["--title", "--issue", "--root"].includes(args[i - 1])));
  if (!input.ok) {
    if (json) out(JSON.stringify({ ok: false, error: input.error }, null, 2));
    else err(`  UNUSABLE  ${input.error}`);
    process.exitCode = EXIT_UNUSABLE;
    return;
  }
  if (!title) {
    err("  UNUSABLE  --title is required");
    process.exitCode = EXIT_UNUSABLE;
    return;
  }

  // The audit-sink invariant, kept from gstack: if the scan blocks, the raw spec
  // is not persisted anywhere. Enforced here rather than asked for in prose.
  const findings = scanText(input.text).filter((f) => f.tier === "HIGH");
  if (findings.length) {
    const message = `refusing to archive: ${findings[0].id} on line ${findings[0].line}. Remove the credential first.`;
    if (json) out(JSON.stringify({ ok: false, error: message, high: findings }, null, 2));
    else err(`  BLOCKED  ${message}`);
    process.exitCode = EXIT_BLOCKED;
    return;
  }

  const dir = path.join(stateDir(), "specs");
  fs.mkdirSync(dir, { recursive: true });
  // Timestamp and PID come from Node, so this works identically in Git Bash,
  // PowerShell and cmd. gstack builds the same name from `date +%Y%m%d-%H%M%S`
  // and `$$`, and both are empty or an error in PowerShell.
  const name = `${stamp()}-${process.pid}-${slugify(title)}.md`;
  const dest = path.join(dir, name);
  const body =
    `---\n` +
    `spec_title: ${JSON.stringify(title)}\n` +
    `spec_issue_number: ${issue ?? ""}\n` +
    `spec_filed_at: ${new Date().toISOString()}\n` +
    `spec_tool: toolbay-stack tb-spec ${VERSION}\n` +
    `---\n\n# ${title}\n\n${input.text.replace(/\s*$/, "")}\n`;
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, dest); // atomic on the same volume, on every platform

  if (json) out(JSON.stringify({ ok: true, path: dest }, null, 2));
  else out(`  archived  ${dest}`);
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { stdin = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GOOD_SPEC = `## Context

Orders older than 30 days are still returned by the public API, which leaks
fulfilled customer addresses to anyone holding a stale order id.

## Current State

\`src/api/orders.ts\` returns every order regardless of age. Verified 2026-08-13.

## Proposed Change

Return HTTP 410 for orders whose \`created_at\` is more than 30 days old.

## Acceptance Criteria

1. Orders older than 30 days return HTTP 410 for all 4 user roles
2. Orders 30 days old or newer return HTTP 200 with the existing body
3. The 410 response body contains no address fields
4. Query time for a 10K-row table stays under 100ms measured by EXPLAIN ANALYZE

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | \`isExpired()\` boundary at exactly 30 days | +3 |
| Integration | create -> age -> expect 410 | +2 |

## Rollback Plan

Revert the PR. No migration, no data change.

## Files Reference

| File | Change |
|---|---|
| \`src/api/orders.ts\` | add the expiry check |

## Out of Scope

- Archiving expired orders to cold storage
`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-spec-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // ---- lint accepts a real spec
  check("lint accepts a complete spec", 0, runSelf(["lint", "--json"], { stdin: GOOD_SPEC }).status);

  // ---- lint rejects the ways a spec is vague
  const bad = [
    ["lint rejects 'works correctly'", GOOD_SPEC.replace("1. Orders older than 30 days return HTTP 410 for all 4 user roles", "1. The feature works correctly")],
    ["lint rejects 'edge cases are handled'", GOOD_SPEC.replace("2. Orders 30 days old or newer return HTTP 200 with the existing body", "2. Edge cases are handled")],
    ["lint rejects 'improves performance'", GOOD_SPEC.replace("3. The 410 response body contains no address fields", "3. Improves performance of the endpoint")],
    ["lint rejects 'as expected'", GOOD_SPEC.replace("4. Query time for a 10K-row table stays under 100ms measured by EXPLAIN ANALYZE", "4. Behaves as expected under load")],
    ["lint rejects a one-item criteria list", GOOD_SPEC.replace(/## Acceptance Criteria\n\n[\s\S]*?\n\n## Testing/, "## Acceptance Criteria\n\n1. Orders older than 30 days return HTTP 410 for all 4 roles\n\n## Testing")],
    ["lint rejects a missing Acceptance Criteria section", GOOD_SPEC.replace(/## Acceptance Criteria\n\n[\s\S]*?\n\n## Testing/, "## Testing")],
    ["lint rejects a missing Out of Scope section", GOOD_SPEC.replace(/## Out of Scope\n\n[\s\S]*$/, "")],
    ["lint rejects an empty Out of Scope section", GOOD_SPEC.replace("- Archiving expired orders to cold storage", "")],
    ["lint rejects a missing Context section", GOOD_SPEC.replace(/^## Context\n\n[\s\S]*?\n\n## Current State/, "## Current State")],
  ];
  for (const [name, payload] of bad) check(name, 1, runSelf(["lint", "--json"], { stdin: payload }).status);

  check("lint treats an unreadable spec file as a failure", 2, runSelf(["lint", "--json", path.join(tmp, "nope.md")]).status);

  // ---- lint --check-paths: a cited line number is a claim about real code
  {
    const root = path.join(tmp, "proj", "src", "api");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "orders.ts"), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join("\n"), "utf8");
    const projRoot = path.join(tmp, "proj");
    const cited = GOOD_SPEC.replace("`src/api/orders.ts` returns", "`src/api/orders.ts:42` returns");
    check("lint --check-paths accepts a citation that resolves", 0, runSelf(["lint", "--json", "--check-paths", "--root", projRoot], { stdin: cited }).status);
    const past = GOOD_SPEC.replace("`src/api/orders.ts` returns", "`src/api/orders.ts:9000` returns");
    check("lint --check-paths rejects a line past the end of the file", 1, runSelf(["lint", "--json", "--check-paths", "--root", projRoot], { stdin: past }).status);
    const gone = GOOD_SPEC.replace("`src/api/orders.ts` returns", "`src/api/deleted.ts:12` returns");
    check("lint --check-paths rejects a citation to a file that is gone", 1, runSelf(["lint", "--json", "--check-paths", "--root", projRoot], { stdin: gone }).status);
  }

  // ---- scan
  check("scan passes a clean spec", 0, runSelf(["scan", "--json"], { stdin: GOOD_SPEC }).status);
  const secrets = [
    ["scan blocks an AWS access key", "key: AKIAIOSFODNN7EXAMPLE"],
    ["scan blocks a private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["scan blocks a GitHub token", `token ghp_${"a".repeat(36)}`],
    ["scan blocks an Anthropic key", `sk-ant-api03-${"b".repeat(40)}`],
    ["scan blocks a database URL with a password", "postgres://admin:hunter2@db.internal:5432/prod"],
    ["scan blocks an assigned secret", 'password = "correct horse battery"'],
    ["scan blocks a JWT", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"c".repeat(20)}`],
  ];
  for (const [name, payload] of secrets) check(name, 3, runSelf(["scan", "--json"], { stdin: payload }).status);
  check(
    "scan does not block a placeholder secret assignment",
    0,
    runSelf(["scan", "--json"], { stdin: 'password = "<your-password-here>"' }).status,
  );
  check("scan flags a real email address", 1, runSelf(["scan", "--json"], { stdin: "contact sarah.chen@acmecorp.io about this" }).status);
  check("scan does not cry wolf on example.com", 0, runSelf(["scan", "--json"], { stdin: "contact user@example.com about this" }).status);
  check("scan treats an unreadable file as unusable, not clean", 2, runSelf(["scan", "--json", path.join(tmp, "nope.md")]).status);

  // ---- archive
  const stateA = path.join(tmp, "state");
  {
    const r = runSelf(["archive", "--json", "--title", "Expire orders after 30 days"], {
      stdin: GOOD_SPEC,
      env: { TOOLBAY_STACK_STATE_DIR: stateA },
    });
    check("archive writes the spec", 0, r.status, r.stderr.trim());
    const p = JSON.parse(r.stdout || "{}").path ?? "";
    check("archive path exists", true, Boolean(p) && fs.existsSync(p), p);
    // gstack's name is "$(date +%Y%m%d-%H%M%S)-$$-<slug>.md"; in PowerShell both
    // halves are empty, giving "--<slug>.md" with no collision protection.
    check("archive name carries a real timestamp and a real pid", true, /^\d{8}-\d{6}-\d+-expire-orders-after-30-days\.md$/.test(path.basename(p)), path.basename(p));
  }
  {
    // Two runs in the same second must not collide.
    const a = JSON.parse(runSelf(["archive", "--json", "--title", "Same title"], { stdin: GOOD_SPEC, env: { TOOLBAY_STACK_STATE_DIR: stateA } }).stdout || "{}");
    const b = JSON.parse(runSelf(["archive", "--json", "--title", "Same title"], { stdin: GOOD_SPEC, env: { TOOLBAY_STACK_STATE_DIR: stateA } }).stdout || "{}");
    check("two archives of the same title do not collide", true, Boolean(a.path) && Boolean(b.path) && a.path !== b.path, `${a.path} vs ${b.path}`);
  }
  {
    const r = runSelf(["archive", "--json", "--title", "Leaky spec"], {
      stdin: `${GOOD_SPEC}\n\nUse AKIAIOSFODNN7EXAMPLE to test.\n`,
      env: { TOOLBAY_STACK_STATE_DIR: stateA },
    });
    check("archive refuses to persist a spec containing a credential", 3, r.status);
    const files = fs.readdirSync(path.join(stateA, "specs"));
    check("...and nothing named after it was written", false, files.some((f) => f.includes("leaky-spec")), files.join(","));
  }
  check("archive without a title is refused", 2, runSelf(["archive", "--json"], { stdin: GOOD_SPEC, env: { TOOLBAY_STACK_STATE_DIR: stateA } }).status);

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-spec", results);
}

// -------------------------------------------------------------------- output

function report(label, results) {
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  ${label} selftest  (node ${process.version}, ${process.platform})\n\n`);
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
    return false;
  }
  process.stdout.write("\n  Every vague acceptance criterion above is one gstack lists as an anti-pattern\n");
  process.stdout.write("  and then checks only by asking a second model, which it skips when that model\n");
  process.stdout.write("  is missing, unauthenticated or slow. These checks are deterministic and offline.\n\n");
  return true;
}

function help() {
  out(`
  tb-spec ${VERSION}  (Toolbay Stack)

  lint [file] [--check-paths] [--root <dir>]
        required sections present, acceptance criteria falsifiable,
        cited file:line references real code. Exit 1 if not.
  scan [file]
        credential and PII backstop. Exit 3 on a credential (nothing may be
        filed or archived), 1 on personal data.
  archive [file] --title "<t>" [--issue <n>]
        write the spec to the local archive with a timestamp and pid that
        exist on every platform. Refuses if scan blocks.
  selftest

  Options: --json.  Reads stdin when no file is given.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "lint") cmdLint(argv.slice(1));
else if (cmd === "scan") cmdScan(argv.slice(1));
else if (cmd === "archive") cmdArchive(argv.slice(1));
else if (cmd === "selftest") selftest();
else help();
