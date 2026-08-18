#!/usr/bin/env node
/**
 * tb-secrets.mjs — the ONE credential stripper in Toolbay Stack.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no equivalent and this file is not derived from its code.
 *
 * WHY THIS FILE EXISTS. Two things in this package have to redact credentials
 * before text leaves the machine: the Toolbay Connect client (`tb.mjs`, which
 * must never print or upload a token) and the memory engine (`tb-memory.mjs`,
 * which must never store or sync one). Those were about to become two different
 * stripping implementations with two different pattern lists, which is the
 * classic way a redactor rots: one of them gets a new pattern and the other does
 * not, and the gap is invisible until something leaks through the older one.
 *
 * So there is one list, authored here, and `npm test` fails if the copies drift.
 *
 * WHY A COPY AND NOT A SHARED IMPORT: same reason as the guard engine. Claude
 * Code installs a skill as a self-contained directory, so a skill that imports
 * across a skill boundary breaks the moment someone installs only one of them.
 * The canonical file lives in src/, `tools/sync-guard.mjs` copies it into every
 * skill that needs it, and the copies are asserted byte-identical.
 *
 * DESIGN RULE: OVER-REDACT. A memory that loses a word is a bad memory. A
 * memory that keeps a live API key is an incident. Every ambiguous case here
 * resolves toward redacting, and the caller is told what was removed and why.
 *
 *   node tb-secrets.mjs check "<text>"   show what would be stripped
 *   node tb-secrets.mjs selftest         prove it against real credential shapes
 */

import { pathToFileURL } from "node:url";

/** What a redaction leaves behind. Deliberately unmistakable in a diff or a log. */
export const PLACEHOLDER_PREFIX = "[secret stripped:";
const ph = (label) => `${PLACEHOLDER_PREFIX} ${label}]`;

/**
 * ORDER IS LOAD-BEARING. `assigned credential` runs FIRST so that
 * `ANTHROPIC_API_KEY=sk-ant-...` is redacted as a whole assignment rather than
 * leaving `ANTHROPIC_API_KEY=` glued to a placeholder; every later pattern then
 * catches the bare forms that appear in prose. Each value pattern refuses to
 * match a placeholder this file already wrote, so nothing is ever redacted twice
 * into a nested `[secret stripped: [secret stripped: ...]]`.
 *
 * The specific-vendor rows are the same list the `cso` skill scans git history
 * with, kept in step deliberately: the shapes a scanner looks for and the shapes
 * a redactor removes should never be two different sets.
 */
const NOT_A_PLACEHOLDER = `(?!\\[secret stripped)`;
const VALUE = `["'\`]?${NOT_A_PLACEHOLDER}[^\\s"'\`,;)\\]}]{6,}`;

export const SECRET_PATTERNS = [
  [
    "assigned credential",
    new RegExp(
      `\\b[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*\\s*[:=]\\s*${VALUE}`,
      "gi",
    ),
  ],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["Toolbay token", /\btb_[a-z]+_[A-Za-z0-9_-]{4,}/g],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{10,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g],
  ["bearer token", new RegExp(`\\bBearer\\s+${NOT_A_PLACEHOLDER}[A-Za-z0-9._~+/-]{12,}=*`, "gi")],
  [
    "connection URL with password",
    /\b(?:postgres|postgresql|mongodb\+srv|mongodb|mysql|redis|amqp|ftp|https?):\/\/[^\s:/@"']+:[^\s:/@"']+@[^\s"'<>]*/gi,
  ],
  ["PEM-ish base64 blob", /\b[A-Za-z0-9+/]{60,}={0,2}\b/g],
];

/**
 * Strip every credential shape from a string.
 *
 * Never throws, never returns undefined, and always reports what it removed:
 * a redactor that silently changes text is one nobody can audit.
 *
 * @param {string} input
 * @returns {{ text: string, labels: string[], count: number, clean: boolean }}
 */
export function stripSecrets(input) {
  if (input === null || input === undefined) return { text: "", labels: [], count: 0, clean: true };
  let text = String(input);
  const labels = [];
  let count = 0;
  for (const [label, pattern] of SECRET_PATTERNS) {
    // A fresh regex per call: a shared /g regex carries lastIndex between calls
    // and starts skipping matches, which for a redactor means leaking one.
    const re = new RegExp(pattern.source, pattern.flags);
    text = text.replace(re, () => {
      count += 1;
      if (!labels.includes(label)) labels.push(label);
      return ph(label);
    });
  }
  return { text, labels, count, clean: count === 0 };
}

/** Does this string contain anything that looks like a credential. */
export function containsSecret(input) {
  return stripSecrets(input).count > 0;
}

/**
 * The one-liner form the Toolbay client uses on its own output. Kept as a
 * separate export so `tb.mjs` reads as it did before, while the pattern list
 * behind it is now the shared one.
 */
export function scrub(s) {
  return stripSecrets(s).text;
}

// ------------------------------------------------------------------- selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // Every one of these is a real credential SHAPE (the values are invented).
  const cases = [
    ["Anthropic key", "use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG as the key"],
    ["OpenAI key", "OPENAI: sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"],
    ["AWS access key id", "id is AKIAIOSFODNN7EXAMPLE ok"],
    ["GitHub token", "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234"],
    ["Stripe live key", "sk_live_AAAABBBBCCCCDDDDEEEE"],
    ["Slack token", "xoxb-1234567890-AAAABBBBCCCC"],
    ["Google API key", `AIza${"Sy0123456789".repeat(3)}`.slice(0, 39)],
    ["Toolbay token", "tb_live_AAAABBBBCCCC"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["bearer token", "send Bearer AAAABBBBCCCCDDDDEEEE upstream"],
    ["connection URL with password", "postgres://admin:hunter2hunter2@db.example.com:5432/app"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
    ["assigned credential", 'ANTHROPIC_API_KEY="sk-ant-api03-ZZZZYYYYXXXXWWWWVVVV"'],
    ["assigned credential", "password: correcthorsebattery"],
  ];

  for (const [label, text] of cases) {
    const r = stripSecrets(text);
    check(`${label}: is detected`, true, r.count > 0, JSON.stringify(r.text).slice(0, 90));
    check(`${label}: the literal value is gone`, true, !overlaps(text, r.text), JSON.stringify(r.text).slice(0, 90));
    check(`${label}: says what it removed`, true, r.labels.length > 0, r.labels.join(","));
  }

  // Ordinary preference text must survive intact. A redactor that eats the
  // sentence is a redactor people turn off.
  const innocent = [
    "no, do not use tailwind here, this project uses plain css",
    "I already told you: run the tests with npm test, not yarn",
    "keep tables terse, 3 columns max",
    "token: 3",
    "always ask before touching the database",
  ];
  for (const t of innocent) {
    const r = stripSecrets(t);
    check(`innocent text is untouched: ${t.slice(0, 34)}`, t, r.text);
  }

  // The properties that make it safe to call twice, on anything.
  {
    const once = stripSecrets("key=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF").text;
    const twice = stripSecrets(once).text;
    check("stripping is idempotent (no nested placeholders)", once, twice);
    check("...and leaves no doubled marker", false, /\[secret stripped:[^\]]*\[secret stripped/.test(twice), twice);
  }
  {
    const long = `prefix ${"sk-ant-api03-" + "A".repeat(40)} suffix`;
    const a = stripSecrets(long);
    const b = stripSecrets(long);
    check("a /g pattern does not carry lastIndex between calls", a.count, b.count);
  }
  check("null is handled", "", stripSecrets(null).text);
  check("undefined is handled", "", stripSecrets(undefined).text);
  check("a number is handled", "42", stripSecrets(42).text);
  check("empty string is clean", true, stripSecrets("").clean);
  check("containsSecret agrees with stripSecrets", true, containsSecret("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"));
  check("containsSecret is false on plain text", false, containsSecret("no, use the env var instead"));

  // Two secrets, one string: both go, and both are named.
  {
    const r = stripSecrets("first sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF then ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234");
    check("multiple secrets in one string are all removed", 0, countRemaining(r.text), r.text);
    check("...and each one is reported", 2, r.labels.length, r.labels.join(","));
  }

  return report("tb-secrets", results);
}

/** Does any suspicious run of the original survive into the output. */
function overlaps(original, redacted) {
  const runs = String(original).match(/[A-Za-z0-9_+/=-]{12,}/g) || [];
  return runs.some((run) => redacted.includes(run));
}

function countRemaining(text) {
  return stripSecrets(text).count;
}

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
  process.stdout.write("\n  Every credential shape above is removed before the text is returned, the\n");
  process.stdout.write("  ordinary sentences a person actually types come back byte-identical, and\n");
  process.stdout.write("  stripping the same string twice changes nothing the second time.\n\n");
  return true;
}

// ---------------------------------------------------------------------- entry

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "selftest") {
    selftest();
    return;
  }
  if (cmd === "check") {
    const r = stripSecrets(rest.join(" "));
    process.stdout.write(`\n  ${r.count} removed${r.labels.length ? ` (${r.labels.join(", ")})` : ""}\n  ${r.text}\n\n`);
    return;
  }
  process.stdout.write(`
  tb-secrets — the shared credential stripper for Toolbay Stack

    node tb-secrets.mjs check "<text>"   show what would be stripped
    node tb-secrets.mjs selftest         prove it against real credential shapes

  Authored once at src/secrets/tb-secrets.mjs and copied into each skill that
  needs it. \`npm test\` fails if the copies drift.
`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
