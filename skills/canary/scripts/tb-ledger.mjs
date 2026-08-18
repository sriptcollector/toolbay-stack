#!/usr/bin/env node
/**
 * tb-ledger.mjs — the evidence ledger: read it, write it, refuse it.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * See LICENSE and NOTICE.
 *
 * WHY THIS FILE EXISTS. The ledger is what this package is for. "It never
 * tells you it worked without showing you the receipt" means a JSON file on
 * disk that records every check, its verdict and the artifact behind it, and
 * every verdict command in this package computes its answer from one. It had
 * been written by hand EIGHT times — canary, design-review, ios-clean,
 * ios-design-review, ios-fix, land-and-deploy, qa, qa-only — with eight
 * versions of the same three functions and eight versions of what a broken
 * ledger means. The project's differentiator was its most copy-pasted code.
 *
 * The failures this reader exists to refuse all look like an empty run:
 *   - the file is not there at all            -> "no checks yet", not "no run"
 *   - the file is not valid JSON              -> a parse throw, or worse, a
 *                                                catch that returns {} and
 *                                                scores a clean sheet
 *   - the file is JSON but not a ledger       -> every array is missing, so
 *                                                every count is 0, so 0 of 0
 *                                                checks failed
 * All three have to be an ERROR, never an empty result, because an empty
 * result is indistinguishable from a passing run in every report downstream.
 *
 * WHAT IS PARAMETERISED AND WHAT IS NOT. The filename, the noun used in
 * messages, the "run this first" hint and the fields that must be arrays are
 * per-skill and are passed in. The refusals themselves are not: whether an
 * unreadable ledger is an error is not a per-skill decision.
 *
 * WHY A COPY AND NOT A SHARED IMPORT ACROSS SKILLS. Claude Code installs a
 * skill as a self-contained directory. Each skill carries the file;
 * tools/sync-guard.mjs asserts the copies are byte-identical.
 *
 *   node tb-ledger.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where a ledger lives. `file` is per-skill (canary.json, <bug>.json, ...). */
export function ledgerPath(dir, file = "ledger.json") {
  return path.join(dir, file);
}

/**
 * Read a ledger, or say why it cannot be trusted.
 *
 *   file            filename inside `dir`                (default ledger.json)
 *   what            noun for messages                    (default "ledger")
 *   hint            sentence appended when it is missing (default none)
 *   missingIsError  false to return {ledger: null, missing: true} instead of
 *                   an error, for skills where "no baseline yet" is a real
 *                   and expected state rather than a failure
 *   require         field names that must be present AND be arrays
 *   validate        (obj, file) => string | null, for a skill-specific check
 *
 * Returns {ledger, file} on success, {error} on refusal, or
 * {ledger: null, missing: true, file} when missingIsError is false.
 */
export function readLedger(dir, {
  file = "ledger.json",
  what = "ledger",
  hint = "",
  missingIsError = true,
  require = [],
  validate = null,
} = {}) {
  const p = ledgerPath(dir, file);

  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      if (!missingIsError) return { ledger: null, missing: true, file: p };
      return { error: `no ${what} at ${p}.${hint ? ` ${hint}` : ""}` };
    }
    return { error: `${p} exists but could not be read (${e.code || e.message}), so nothing about this run can be established` };
  }

  if (!raw.trim()) return { error: `${p} is empty, so this run has no recorded evidence` };

  let obj;
  try {
    // A BOM is what a PowerShell redirect leaves on the front of a JSON file,
    // and JSON.parse refuses it. Stripping it here is the difference between
    // "your ledger is corrupt" and a ledger that reads fine.
    obj = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    return { error: `${p} is not valid JSON (${e.message}), so no verdict can be computed from it` };
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { error: `${p} does not contain a ${what} object` };
  }

  for (const field of require) {
    if (!Array.isArray(obj[field])) return { error: `${p} has no "${field}" array, so it is not a ${what}` };
  }

  if (validate) {
    const problem = validate(obj, p);
    if (problem) return { error: problem };
  }

  return { ledger: obj, file: p };
}

/**
 * Write a ledger. Atomic by default: a half-written ledger is a ledger that
 * reads as a shorter run, which is the one corruption nobody would notice.
 */
export function writeLedger(dir, ledger, { file = "ledger.json", atomic = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = ledgerPath(dir, file);
  const body = `${JSON.stringify(ledger, null, 2)}\n`;
  if (!atomic) {
    fs.writeFileSync(p, body, "utf8");
    return p;
  }
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, p);
  return p;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const os = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || ".", "tb-ledger-"));
  try {
    const opts = { what: "QA ledger", hint: 'Run "init" first.', require: ["checks"] };

    // Missing.
    const missing = readLedger(path.join(os, "nope"), opts);
    check("a ledger that is not there is an error, not an empty run", true, Boolean(missing.error), JSON.stringify(missing));
    check("...and the refusal carries the hint", true, /Run "init" first/.test(missing.error));
    check("...and undefined checks are never returned", "undefined", String(missing.ledger));

    const soft = readLedger(path.join(os, "nope"), { ...opts, missingIsError: false });
    check("a skill that allows no-baseline-yet gets missing:true", true, soft.missing === true && soft.ledger === null);

    // Written and read back.
    const d = path.join(os, "run");
    const p = writeLedger(d, { checks: [{ id: "A" }] }, {});
    check("writeLedger returns the path it wrote", true, fs.existsSync(p), p);
    check("a written ledger reads back", 1, readLedger(d, opts).ledger.checks.length);
    check("no .tmp file is left behind", 0, fs.readdirSync(d).filter((f) => f.endsWith(".tmp")).length, JSON.stringify(fs.readdirSync(d)));

    // Empty file.
    fs.writeFileSync(ledgerPath(d), "");
    check("an empty ledger file is an error", true, Boolean(readLedger(d, opts).error));

    // Corrupt.
    fs.writeFileSync(ledgerPath(d), "{ not json");
    const bad = readLedger(d, opts);
    check("a corrupt ledger is an error, not an empty run", true, Boolean(bad.error), JSON.stringify(bad));
    check("...and the reason says no verdict can be computed", true, /no verdict can be computed/.test(bad.error));

    // JSON, but not a ledger. This is the one that scores a clean sheet.
    fs.writeFileSync(ledgerPath(d), JSON.stringify({ target: "http://x" }));
    const notLedger = readLedger(d, opts);
    check("valid JSON with no checks array is an error", true, Boolean(notLedger.error), JSON.stringify(notLedger));
    check("...and names the field that is missing", true, /"checks"/.test(notLedger.error));

    fs.writeFileSync(ledgerPath(d), JSON.stringify([1, 2, 3]));
    check("a JSON array is not a ledger", true, Boolean(readLedger(d, opts).error));

    // A BOM must not read as corruption.
    fs.writeFileSync(ledgerPath(d), `﻿${JSON.stringify({ checks: [] })}`, "utf8");
    check("a UTF-8 BOM does not make a ledger corrupt", true, Array.isArray(readLedger(d, opts).ledger?.checks));

    // A skill-specific validator.
    fs.writeFileSync(ledgerPath(d), JSON.stringify({ checks: [], sha: "zzz" }));
    const v = readLedger(d, {
      ...opts,
      validate: (o, f) => (/^[0-9a-f]{7,40}$/i.test(o.sha || "") ? null : `${f} has no usable merge SHA`),
    });
    check("a skill's own validator can refuse a ledger", true, /no usable merge SHA/.test(v.error || ""), JSON.stringify(v));

    // A per-skill filename.
    writeLedger(d, { verifications: [] }, { file: "BUG-1.json" });
    check("a per-skill filename round-trips", true, Array.isArray(readLedger(d, { file: "BUG-1.json", require: ["verifications"] }).ledger?.verifications));
    check("...and does not collide with the default one", true, fs.existsSync(path.join(d, "BUG-1.json")) && fs.existsSync(path.join(d, "ledger.json")));

    // Non-atomic writes are still writes.
    writeLedger(d, { checks: [] }, { file: "plain.json", atomic: false });
    check("a non-atomic write lands too", true, fs.existsSync(path.join(d, "plain.json")));

    check("ledgerPath joins dir and file", path.join(d, "canary.json"), ledgerPath(d, "canary.json"));
  } finally {
    fs.rmSync(os, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-ledger selftest  (node ${process.version}, ${process.platform})\n\n`);
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
  process.stdout.write("\n  A ledger that cannot be read is an error in every skill now, rather than\n  an empty run in whichever one happened to be written last.\n\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "selftest") selftest();
  else {
    process.stdout.write("\n  usage: tb-ledger.mjs selftest\n\n");
    process.exitCode = 1;
  }
}
