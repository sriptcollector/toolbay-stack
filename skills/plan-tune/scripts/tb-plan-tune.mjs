#!/usr/bin/env node
/**
 * tb-plan-tune.mjs: the Toolbay Stack question-suppression engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /plan-tune, the three preference values never-ask / always-ask /
 * ask-only-for-one-way, the one-way-door safety override, the
 * <qid:...> question marker, the "(recommended)" option convention, the
 * refuse-on-ambiguous rule, the split-chain carve-out, the all-or-nothing
 * semantics for a multi-question AskUserQuestion, and the door-type
 * classification of all 53 registered questions) comes from `plan-tune`,
 * `scripts/question-registry.ts` and
 * `hosts/claude/hooks/question-preference-hook.ts` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 *
 * WHICH DIRECTION IS "CLOSED" HERE
 *
 * This hook is the mirror image of tb-guard. tb-guard's dangerous output is
 * "allow"; this one's dangerous output is "suppress". So closed means THE
 * HUMAN STILL GETS ASKED. Every uncertain path in this file ends in
 * `passThrough()`, and the only path that suppresses a question is one where
 * every single check returned a confident yes.
 *
 * That distinction is not academic. The three failures below were reproduced
 * against gstack 1.60.1.0 on Windows 11 on 2026-08-14, and all three are
 * suppression happening (or not happening) for the wrong reason.
 *
 *
 * FAILURE 1 — the registry never loads on Windows, so one-way doors are
 * silently downgraded to two-way and a never-ask preference auto-approves an
 * irreversible action.
 *
 * question-preference-hook.ts resolves its own registry like this:
 *
 *     const here = path.dirname(new URL(import.meta.url).pathname);
 *     const repoRoot = path.resolve(here, '..', '..', '..');
 *
 * On Windows `.pathname` is `/C:/Users/...`, so repoRoot becomes
 * `C:\C:\Users\...`, existsSync is false, and loadRegistry returns `{}`.
 * Downstream, `const doorType = entry?.door_type || 'two-way'` turns all 12
 * one-way doors into two-way ones. Reproduced:
 *
 *   $ echo '{"tool_name":"AskUserQuestion", ... "question":"Roll back the
 *       production deploy? This is irreversible.
 *       <gstack-qid:land-and-deploy-rollback>", "options":[
 *       {"label":"Roll back now (recommended)"},{"label":"Leave it"}]}'
 *     | bun hosts/claude/hooks/question-preference-hook.ts
 *   {"hookSpecificOutput":{"permissionDecision":"deny",
 *    "permissionDecisionReason":"[plan-tune auto-decide]
 *     land-and-deploy-rollback -> Roll back now (your never-ask preference)..."}}
 *
 * `land-and-deploy-rollback` is declared one-way in gstack's own registry, and
 * gstack's own documentation says one-way doors override never-ask. On Windows
 * it rolled back production without asking.
 *
 * Fixed here three ways: paths come from fileURLToPath, the registry is JSON
 * rather than a regex-scraped .ts module, and a registry that fails to load
 * suppresses NOTHING instead of suppressing everything.
 *
 *
 * FAILURE 2 — preferences are written to one directory and read from another,
 * so on a normal repo /plan-tune suppresses nothing at all.
 *
 * `bin/gstack-question-preference` writes to
 * `projects/<gstack-slug>/question-preferences.json`, where gstack-slug is
 * derived from the git remote (`acme/backend` -> `acme-backend`). The hook
 * reads from `projects/<basename(cwd)>/...` via its own `slugFromCwd`. Those
 * agree only when the checkout directory happens to be named `owner-repo`.
 * Reproduced in a repo at `myproj` with remote `git@github.com:acme/backend`:
 *
 *   writer slug: acme-backend      (bin/gstack-question-preference)
 *   reader slug: myproj            (hook slugFromCwd)
 *   preference landed in:  <state>/projects/acme-backend/question-preferences.json
 *   hook decision:         {"permissionDecision":"defer"}   <- still asks
 *
 * Fixed here by having exactly one policy file, one slug resolver used by both
 * the writer and the reader, and a documented alias chain on read so a policy
 * written under any plausible name for this project is still honoured.
 *
 *
 * FAILURE 3 — an unrecognised preference value is treated as consent.
 *
 *     if (!pref.preference || pref.preference === 'always-ask') { ... break; }
 *
 * Any other non-empty string falls through into the auto-decide branch. A
 * typo suppresses the question. Reproduced with `"alwys-ask"`:
 *
 *   preference on disk: { "ship-commit-message-style": "alwys-ask" }
 *   hook decision:      "deny ... [plan-tune auto-decide] ... (your never-ask
 *                        preference)"
 *
 * Fixed here with an allowlist: a value that is not exactly one of the three
 * known preferences suppresses nothing and is reported by `state` and `doctor`.
 *
 *
 * AND THE THING THE ORIGINAL DOES NOT CLAIM TO DO
 *
 * gstack's plan-tune describes itself as "v1: observational" and its skill body
 * is prose: it logs questions, shows a psychographic profile, and never writes
 * an enforceable policy of its own. `measure` here exists so the claim this
 * skill makes is falsifiable: it runs a fixed corpus of AskUserQuestion
 * payloads through this exact executable with the policy off and then on, and
 * prints how many prompts reached the human each time. If the number does not
 * drop, the skill is not working, and it says so.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

// --------------------------------------------------------------- hook output
//
// `passThrough` says nothing at all. Saying nothing lets the AskUserQuestion
// call proceed and lets the user's own permission rules decide, which is what
// must happen whenever this engine is not certain. An explicit "allow" would
// override those rules, so it is never emitted.
//
// `suppress` is a PreToolUse deny carrying the auto-decided option in its
// reason. gstack chose deny-with-reason over allow-with-updatedInput because
// the mutation shape is not pinned in the Claude Code docs; that reasoning
// still holds, so the shape is kept. The union of decision envelopes is
// emitted so a Claude Code upgrade cannot quietly make this inert.

function emitPassThrough() {
  process.stdout.write("{}\n");
}

function emitSuppress(reason) {
  process.stdout.write(
    `${JSON.stringify({
      permissionDecision: "deny",
      message: reason,
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

// ----------------------------------------------------------------- constants

const MARKER_RE = /<(?:tbs|gstack)-qid:([a-z0-9-]{1,64})>/i;
const RECOMMENDED_LABEL_RE = /\(recommended\)\s*$/i;
const PREFERENCES = new Set(["never-ask", "always-ask", "ask-only-for-one-way"]);
const DOORS = new Set(["one-way", "two-way"]);
const AUQ_RE = /^(?:AskUserQuestion|mcp__.+__AskUserQuestion)$/;

// ------------------------------------------------------------------- stdin

function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "no input on stdin within 5s" }), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) finish({ ok: false, error: "input larger than 8MB" });
    });
    process.stdin.on("end", () => finish({ ok: true, data }));
    process.stdin.on("error", (err) => finish({ ok: false, error: `stdin error: ${err.message}` }));
  });
}

function parseHookInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "empty payload" };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `payload is not valid JSON (${err.message})` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "payload is not a JSON object" };
  return { ok: true, value: obj };
}

// ------------------------------------------------------------------- paths

const isWindows = process.platform === "win32";

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}

function policyFile() {
  return path.join(stateDir(), "plan-tune", "policy.json");
}

function registryPath() {
  if (process.env.TB_PLAN_TUNE_REGISTRY) return path.resolve(fromMsysPath(process.env.TB_PLAN_TUNE_REGISTRY));
  // The registry sits beside the skill, one level up from scripts/. Resolved
  // with fileURLToPath, which is the entire content of Failure 1 above.
  return path.resolve(path.dirname(SELF), "..", "registry.json");
}

// ------------------------------------------------------------------ registry
//
// A registry that cannot be loaded, or that contains an entry with no valid
// door type, disables suppression completely. The door type is the only thing
// standing between a never-ask preference and an irreversible action, so a
// registry this engine cannot vouch for is not a registry it will act on.

function loadRegistry() {
  const p = registryPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    return { ok: false, path: p, error: `registry at ${p} could not be read (${err.code || err.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path: p, error: `registry at ${p} is not valid JSON (${err.message})` };
  }
  const questions = obj?.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return { ok: false, path: p, error: `registry at ${p} has no "questions" object` };
  }
  for (const [id, entry] of Object.entries(questions)) {
    if (!entry || typeof entry !== "object" || !DOORS.has(entry.door)) {
      return { ok: false, path: p, error: `registry entry "${id}" has no valid door type, so the whole registry is untrusted` };
    }
  }
  return { ok: true, path: p, questions };
}

// --------------------------------------------------------------------- slug
//
// ONE resolver, used by the writer and the reader. gstack has two that
// disagree (Failure 2). The alias chain exists so that a policy written before
// a remote was added, or under a differently named checkout, is still found:
// missing a policy the user set is a silent no-op, which is the failure this
// skill exists to remove.

function sanitizeSlug(s) {
  return String(s ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
}

function gitOutput(args, cwd) {
  try {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000, windowsHide: true });
    if (res.status !== 0) return null;
    const out = (res.stdout || "").trim();
    return out || null;
  } catch {
    return null;
  }
}

function slugFromRemote(cwd) {
  const url = gitOutput(["remote", "get-url", "origin"], cwd);
  if (!url) return null;
  // git@host:owner/repo.git | https://host/owner/repo(.git) | ssh://host/owner/repo
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  const slug = sanitizeSlug(`${m[1]}-${m[2]}`);
  return slug || null;
}

function slugChain(cwd) {
  const forced = process.env.TB_PLAN_TUNE_SLUG ? sanitizeSlug(process.env.TB_PLAN_TUNE_SLUG) : null;
  const dir = path.resolve(fromMsysPath(cwd || process.cwd()));
  const chain = [];
  const push = (s) => {
    const v = sanitizeSlug(s);
    if (v && !chain.includes(v)) chain.push(v);
  };
  if (forced) push(forced);
  else push(slugFromRemote(dir));
  const top = gitOutput(["rev-parse", "--show-toplevel"], dir);
  if (top) push(path.basename(path.resolve(fromMsysPath(top))));
  push(path.basename(dir));
  if (!chain.length) chain.push("unknown");
  return chain;
}

// ------------------------------------------------------------------- policy
//
// One file, one shape:
//   { version: 1, scopes: { "<slug>": { "<qid>": <entry> } }, global: { ... } }
//   entry = { preference, door?, setAt, source, note? }
//
// The optional `door` is how a question that is not in the registry can ever
// become suppressible: the person setting the preference has to state, in
// writing, that it is reversible. Without it the id resolves to an unknown
// door, and an unknown door is treated as one-way.

function emptyPolicy() {
  return { version: 1, scopes: {}, global: {} };
}

function readPolicy() {
  const file = policyFile();
  let raw;
  try {
    if (!fs.existsSync(file)) return { ok: true, data: emptyPolicy(), missing: true, file };
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, file, error: `policy at ${file} exists but could not be read (${err.code || err.message})` };
  }
  const text = raw.trim();
  if (!text) return { ok: false, file, error: `policy at ${file} is empty` };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { ok: false, file, error: `policy at ${file} is not valid JSON (${err.message})` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, file, error: `policy at ${file} is not an object` };
  if (!obj.scopes || typeof obj.scopes !== "object") obj.scopes = {};
  if (!obj.global || typeof obj.global !== "object") obj.global = {};
  return { ok: true, data: obj, file };
}

function writePolicy(data) {
  const file = policyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/**
 * @returns {{found:boolean, entry?:object, scope?:string, invalid?:string}}
 * `invalid` is set when a stored value is not one this engine recognises. It is
 * reported rather than guessed at, and it never suppresses (Failure 3).
 */
function lookupPolicy(policy, chain, id) {
  const buckets = [];
  for (const slug of chain) buckets.push([`project:${slug}`, policy.scopes?.[slug]]);
  buckets.push(["global", policy.global]);
  for (const [scope, bucket] of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const raw = bucket[id];
    if (raw === undefined) continue;
    // Accept gstack's bare-string shape on read so a migrated file still works.
    const entry = typeof raw === "string" ? { preference: raw } : raw;
    if (!entry || typeof entry !== "object" || typeof entry.preference !== "string") {
      return { found: true, scope, invalid: `entry for "${id}" in ${scope} is not a preference object` };
    }
    if (!PREFERENCES.has(entry.preference)) {
      return {
        found: true,
        scope,
        invalid: `entry for "${id}" in ${scope} has preference "${entry.preference}", which is not one of ${[...PREFERENCES].join(", ")}`,
      };
    }
    return { found: true, entry, scope };
  }
  return { found: false };
}

// ------------------------------------------------------------------- doors

function doorFor(id, registry, entry) {
  const r = registry.questions[id];
  if (r) return { door: r.door, from: "registry" };
  if (entry && DOORS.has(entry.door)) return { door: entry.door, from: "policy" };
  return { door: "unknown", from: "none" };
}

// --------------------------------------------------------- recommended option

function optionLabels(opts) {
  if (!Array.isArray(opts)) return [];
  return opts.map((o) => (typeof o === "string" ? o : String(o?.label ?? o?.description ?? "")));
}

function extractRecommended(questionText, opts) {
  const labelled = opts.filter((o) => RECOMMENDED_LABEL_RE.test(o));
  if (labelled.length === 1) return { recommended: labelled[0].replace(RECOMMENDED_LABEL_RE, "").trim() };
  if (labelled.length > 1) return { reason: `${labelled.length} options are marked (recommended)` };

  const m = /Recommendation:\s*([^\n]+)/i.exec(questionText);
  if (!m) return { reason: "no option is marked (recommended) and there is no Recommendation: line" };
  const phrase = m[1].trim();
  if (phrase.length < 3) return { reason: "the Recommendation: line is too short to match an option" };
  const needle = phrase.toLowerCase().slice(0, 12);
  const hits = opts.filter((o) => o.toLowerCase().startsWith(needle));
  if (hits.length === 1) return { recommended: hits[0] };
  if (hits.length > 1) return { reason: `the Recommendation: line matches ${hits.length} options` };
  return { reason: "the Recommendation: line does not match any option" };
}

// ---------------------------------------------------------------- the decision
//
// One question in, one verdict out. `suppress` is true only when every check
// below returned a confident yes; `why` always says which check decided, so
// `measure` and `doctor` can print a reason rather than a shrug.

function decideQuestion(q, ctx) {
  const text = String(q?.question ?? "");
  const marker = MARKER_RE.exec(text);
  if (!marker) return { suppress: false, why: "no <tbs-qid:...> marker, so the question cannot be identified" };
  const id = marker[1].toLowerCase();

  if (q?.multiSelect === true) {
    // A multi-select answer is a set. Collapsing it to the single recommended
    // option silently discards the rest, which is a wrong answer rather than a
    // skipped question. gstack does not check this.
    return { id, suppress: false, why: "multiSelect questions are never auto-decided: one recommended option cannot stand in for a set" };
  }

  // gstack's split-chain carve-out, kept: splitting a 5+ option question into
  // per-option calls exists to give the option set back to the user, so the
  // per-option calls are never suppressible.
  if (id.includes("-split-")) return { id, suppress: false, why: "split-chain per-option calls always ask" };

  const found = lookupPolicy(ctx.policy, ctx.chain, id);
  if (!found.found) return { id, suppress: false, why: "no policy set for this question" };
  if (found.invalid) return { id, suppress: false, why: `policy not applied: ${found.invalid}` };
  const { entry, scope } = found;
  if (entry.preference === "always-ask") return { id, suppress: false, why: `always-ask (${scope})` };

  const { door, from } = doorFor(id, ctx.registry, entry);
  if (door === "unknown") {
    return {
      id,
      suppress: false,
      why: "door type unknown: the question is not in the registry and the policy entry does not declare one, so it is treated as one-way",
    };
  }
  if (door === "one-way") {
    return { id, suppress: false, why: `one-way door (from ${from}) overrides ${entry.preference}` };
  }

  const opts = optionLabels(q?.options);
  if (opts.length < 2) return { id, suppress: false, why: "fewer than two options, so there is nothing to decide between" };
  const rec = extractRecommended(text, opts);
  if (!rec.recommended) return { id, suppress: false, why: `cannot tell which option is recommended: ${rec.reason}` };

  return { id, suppress: true, recommended: rec.recommended, scope, why: `${entry.preference} (${scope}), two-way door from ${from}` };
}

function decide(input, cwd) {
  if (!AUQ_RE.test(String(input?.tool_name ?? input?.toolName ?? ""))) {
    return { suppress: false, why: "not an AskUserQuestion call" };
  }
  const questions = input?.tool_input?.questions ?? input?.toolInput?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { suppress: false, why: "payload carried no questions" };
  }

  const registry = loadRegistry();
  if (!registry.ok) {
    // The single most important line in this file. gstack reaches this state on
    // every Windows machine and carries on suppressing anyway.
    return { suppress: false, why: `registry unusable, so nothing is suppressed: ${registry.error}` };
  }
  const policy = readPolicy();
  if (!policy.ok) return { suppress: false, why: `policy unusable, so nothing is suppressed: ${policy.error}` };

  const ctx = { registry, policy: policy.data, chain: slugChain(cwd) };
  const verdicts = questions.map((q) => decideQuestion(q, ctx));
  // All-or-nothing per call, as in gstack: one question the user still has to
  // answer means the whole call has to reach them.
  const blocked = verdicts.find((v) => !v.suppress);
  if (blocked) return { suppress: false, why: blocked.why, verdicts, chain: ctx.chain };
  return { suppress: true, verdicts, chain: ctx.chain };
}

function suppressionReason(verdicts) {
  return verdicts
    .map(
      (v) =>
        `[plan-tune auto-decide] ${v.id} -> ${v.recommended} (your ${v.scope} policy). ` +
        `Proceed with that option and do NOT re-ask. Change it with /plan-tune.`,
    )
    .join("\n");
}

// ------------------------------------------------------------------ commands

function cmdPolicy(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    flags.set(key, next && !next.startsWith("--") ? next : true);
  }

  const policyRead = readPolicy();
  if (!policyRead.ok && !flags.has("list")) {
    process.stderr.write(`${policyRead.error}\nRefusing to edit a policy file this engine cannot parse. Move it aside or run --clear-all after fixing it.\n`);
    process.exitCode = 1;
    return;
  }
  const data = policyRead.ok ? policyRead.data : emptyPolicy();
  const chain = slugChain(process.cwd());
  const slug = chain[0];

  if (flags.has("list") || flags.size === 0) {
    const registry = loadRegistry();
    process.stdout.write(`\n  policy file : ${policyFile()}${policyRead.missing ? "  (not created yet)" : ""}\n`);
    if (!policyRead.ok) process.stdout.write(`  PROBLEM     : ${policyRead.error}\n`);
    process.stdout.write(`  this project: ${slug}${chain.length > 1 ? `   (also matched as: ${chain.slice(1).join(", ")})` : ""}\n\n`);
    let rows = 0;
    for (const [scopeName, bucket] of [[`project:${slug}`, data.scopes?.[slug]], ["global", data.global]]) {
      for (const [id, raw] of Object.entries(bucket || {})) {
        const entry = typeof raw === "string" ? { preference: raw } : raw || {};
        const door = registry.ok ? doorFor(id, registry, entry) : { door: "?", from: "registry unreadable" };
        const bad = !PREFERENCES.has(entry.preference) ? "  <- NOT A VALID PREFERENCE, ignored" : "";
        const oneWay = door.door === "one-way" ? "  <- one-way door, always asked anyway" : "";
        process.stdout.write(`  ${scopeName.padEnd(24)} ${id.padEnd(38)} ${String(entry.preference).padEnd(20)} door=${door.door}${bad}${oneWay}\n`);
        rows += 1;
      }
    }
    if (!rows) process.stdout.write("  (no preferences set: every question is asked)\n");
    process.stdout.write("\n");
    return;
  }

  const target = flags.has("global") ? "global" : "project";
  const bucketFor = () => {
    if (target === "global") return data.global;
    data.scopes[slug] = data.scopes[slug] || {};
    return data.scopes[slug];
  };

  if (flags.has("clear-all")) {
    if (target === "global") data.global = {};
    else delete data.scopes[slug];
    writePolicy(data);
    process.stdout.write(`Cleared every ${target} preference${target === "project" ? ` for ${slug}` : ""}. All questions are asked again.\n`);
    return;
  }

  if (flags.has("clear")) {
    const id = String(flags.get("clear"));
    const bucket = bucketFor();
    if (bucket[id] === undefined) {
      process.stdout.write(`No ${target} preference was set for ${id}.\n`);
      return;
    }
    delete bucket[id];
    writePolicy(data);
    process.stdout.write(`Cleared ${target} preference for ${id}. It will be asked again.\n`);
    return;
  }

  const prefFlag = ["never-ask", "always-ask", "one-way-only"].find((f) => flags.has(f));
  if (!prefFlag) {
    process.stderr.write("Usage: tb-plan-tune policy --never-ask <id> [--door two-way] [--global] [--note \"...\"]\n");
    process.exitCode = 1;
    return;
  }
  const preference = prefFlag === "one-way-only" ? "ask-only-for-one-way" : prefFlag;
  const id = String(flags.get(prefFlag) === true ? "" : flags.get(prefFlag)).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(id)) {
    process.stderr.write(`"${id}" is not a valid question id (lower-case letters, digits and hyphens, up to 64 characters).\n`);
    process.exitCode = 1;
    return;
  }

  const registry = loadRegistry();
  if (!registry.ok) {
    process.stderr.write(`${registry.error}\nRefusing to write a preference while the door-type registry is unreadable.\n`);
    process.exitCode = 1;
    return;
  }

  const entry = { preference, setAt: new Date().toISOString(), source: "plan-tune", version: VERSION };
  const declaredDoor = flags.get("door");
  if (typeof declaredDoor === "string") {
    if (!DOORS.has(declaredDoor)) {
      process.stderr.write(`--door must be one-way or two-way, got "${declaredDoor}".\n`);
      process.exitCode = 1;
      return;
    }
    entry.door = declaredDoor;
  }
  if (typeof flags.get("note") === "string") entry.note = String(flags.get("note")).slice(0, 300).replace(/\s+/g, " ");

  const known = registry.questions[id];
  if (!known && !entry.door && preference !== "always-ask") {
    process.stderr.write(
      `"${id}" is not in the door-type registry, so this engine does not know whether it is reversible.\n` +
        `Nothing was written. If you are certain it is reversible, say so explicitly:\n` +
        `  tb-plan-tune policy --${prefFlag} ${id} --door two-way\n` +
        `An unclassified question is treated as one-way and is always asked.\n`,
    );
    process.exitCode = 1;
    return;
  }

  bucketFor()[id] = entry;
  const file = writePolicy(data);
  const door = doorFor(id, registry, entry);
  process.stdout.write(`Set ${target === "global" ? "global" : `${slug}`} policy: ${id} -> ${preference}  (door=${door.door} from ${door.from})\n`);
  process.stdout.write(`Written to ${file}\n`);
  if (door.door === "one-way") {
    process.stdout.write("NOTE: this is a one-way door. It will still be asked every time. That override is deliberate and cannot be turned off.\n");
  } else if (preference !== "always-ask") {
    process.stdout.write("Active immediately for questions carrying the matching <tbs-qid:...> marker.\n");
  }
}

function cmdState() {
  const registry = loadRegistry();
  const policy = readPolicy();
  const chain = slugChain(process.cwd());
  process.stdout.write(`\n  tb-plan-tune ${VERSION}  (node ${process.version}, ${process.platform})\n\n`);
  process.stdout.write(`  registry   : ${registryPath()}\n`);
  if (registry.ok) {
    const ids = Object.keys(registry.questions);
    const oneWay = ids.filter((i) => registry.questions[i].door === "one-way").length;
    process.stdout.write(`               OK, ${ids.length} questions (${oneWay} one-way, ${ids.length - oneWay} two-way)\n`);
  } else {
    process.stdout.write(`               UNUSABLE: ${registry.error}\n`);
    process.stdout.write("               While this is true, NO question is suppressed. That is deliberate.\n");
    process.exitCode = 1;
  }
  process.stdout.write(`  policy     : ${policy.file}\n`);
  if (!policy.ok) {
    process.stdout.write(`               UNUSABLE: ${policy.error}\n`);
    process.exitCode = 1;
  } else if (policy.missing) {
    process.stdout.write("               not created yet, so every question is asked\n");
  } else {
    const proj = Object.keys(policy.data.scopes?.[chain[0]] || {}).length;
    const glob = Object.keys(policy.data.global || {}).length;
    process.stdout.write(`               OK, ${proj} preference(s) for this project, ${glob} global\n`);
  }
  process.stdout.write(`  project    : ${chain[0]}\n`);
  if (chain.length > 1) process.stdout.write(`  also read as: ${chain.slice(1).join(", ")}\n`);
  process.stdout.write("\n  Run \"selftest\" to prove the engine, \"doctor\" to prove it is wired in,\n  and \"measure\" to see how many prompts the current policy actually removes.\n\n");
}

// ----------------------------------------------------------------- corpus
//
// The corpus is deliberately mixed: things that SHOULD be suppressible and
// things that must never be, so a before/after number that moved for the wrong
// reason is visible rather than flattering.

function corpus() {
  const q = (id, question, options, extra = {}) => ({
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: `${question} <tbs-qid:${id}>`, options, ...extra }] },
  });
  const rec = (a, b) => [{ label: `${a} (recommended)` }, { label: b }];
  return [
    { name: "ship: version bump tier", id: "ship-version-bump-tier", payload: q("ship-version-bump-tier", "Which version bump?", rec("Patch", "Minor")) },
    { name: "ship: create todos", id: "ship-todos-create", payload: q("ship-todos-create", "Create TODOs for the deferred items?", rec("Yes, create them", "Skip")) },
    { name: "ship: changelog voice", id: "ship-changelog-voice-polish", payload: q("ship-changelog-voice-polish", "Polish the changelog voice?", rec("Polish it", "Leave it")) },
    { name: "review: apply finding", id: "review-finding-fix", payload: q("review-finding-fix", "Apply this review finding?", rec("Apply", "Skip")) },
    { name: "qa: bug fix scope", id: "qa-bug-fix-scope", payload: q("qa-bug-fix-scope", "Fix all bugs found, or only blockers?", rec("All of them", "Blockers only")) },
    { name: "plan-eng: reduce scope", id: "plan-eng-review-scope-reduce", payload: q("plan-eng-review-scope-reduce", "Reduce scope to the core path?", rec("Reduce it", "Keep the full scope")) },
    { name: "preamble: telemetry consent", id: "preamble-telemetry-consent", payload: q("preamble-telemetry-consent", "Share anonymous usage data?", rec("Share it", "No thanks")) },
    { name: "preamble: proactive suggestions", id: "preamble-proactive-behavior", payload: q("preamble-proactive-behavior", "Let skills suggest themselves?", rec("Keep it on", "Turn it off")) },
    { name: "ONE-WAY land-and-deploy rollback", id: "land-and-deploy-rollback", payload: q("land-and-deploy-rollback", "Roll back the production deploy? This is irreversible.", rec("Roll back now", "Leave it")), mustAsk: true },
    { name: "ONE-WAY cso finding fix", id: "cso-finding-fix", payload: q("cso-finding-fix", "Apply this security fix to production config?", rec("Apply", "Report only")), mustAsk: true },
    { name: "unregistered ad-hoc question", id: "some-adhoc-question", payload: q("some-adhoc-question", "Rename the helper?", rec("Rename it", "Leave it")), mustAsk: true },
    { name: "multiSelect: which suites to run", id: "qa-tier", payload: q("qa-tier", "Which test tiers should run?", rec("Smoke", "Full"), { multiSelect: true }), mustAsk: true },
  ];
}

function runHook(payload, env = {}, cwd = process.cwd()) {
  const res = spawnSync(process.execPath, [SELF, "hook"], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  let parsed = null;
  try {
    parsed = JSON.parse((res.stdout || "").trim() || "{}");
  } catch {
    parsed = null;
  }
  const action = parsed === null ? "unparseable" : parsed.permissionDecision === "deny" ? "suppress" : "ask";
  return { action, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim(), status: res.status, reason: parsed?.message ?? "" };
}

function explain(payload, env, cwd) {
  // Same decision path as the hook, in-process, purely to print WHY a question
  // still reached the user. The verdict that counts is always the child
  // process above; this only annotates it.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const d = decide(parsed, cwd);
    return d.suppress ? "suppressed" : d.why;
  } catch (err) {
    return `could not explain (${err.message})`;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function cmdMeasure() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-plan-tune-measure-"));
  const state = path.join(tmp, "state");
  fs.mkdirSync(path.join(state, "plan-tune"), { recursive: true });
  const env = { TOOLBAY_STACK_STATE_DIR: state, TB_PLAN_TUNE_SLUG: "measure-corpus" };
  const items = corpus();

  const before = items.map((it) => ({ it, res: runHook(it.payload, env), why: explain(it.payload, env, tmp) }));

  // Turn on never-ask for EVERY id in the corpus, including the ones that must
  // never be suppressed. Asking for too much is the only honest way to show
  // that the refusals are the engine's and not the policy's.
  const policy = { version: 1, scopes: { "measure-corpus": {} }, global: {} };
  for (const it of items) policy.scopes["measure-corpus"][it.id] = { preference: "never-ask", setAt: new Date().toISOString(), source: "measure" };
  fs.writeFileSync(path.join(state, "plan-tune", "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const after = items.map((it) => ({ it, res: runHook(it.payload, env), why: explain(it.payload, env, tmp) }));

  const askedBefore = before.filter((r) => r.res.action !== "suppress").length;
  const askedAfter = after.filter((r) => r.res.action !== "suppress").length;

  const width = Math.max(...items.map((i) => i.name.length));
  process.stdout.write(`\n  tb-plan-tune measure  (node ${process.version}, ${process.platform})\n`);
  process.stdout.write(`  ${items.length} AskUserQuestion payloads, run through this executable twice.\n\n`);
  process.stdout.write(`  ${"question".padEnd(width)}  before   after    why it still asks\n`);
  process.stdout.write(`  ${"-".repeat(width)}  -------  -------  ------------------\n`);
  for (let i = 0; i < items.length; i += 1) {
    const b = before[i].res.action === "suppress" ? "silent" : "ASKED";
    const a = after[i].res.action === "suppress" ? "silent" : "ASKED";
    const why = after[i].res.action === "suppress" ? "" : after[i].why;
    process.stdout.write(`  ${items[i].name.padEnd(width)}  ${b.padEnd(7)}  ${a.padEnd(7)}  ${why}\n`);
  }
  process.stdout.write(`\n  prompts reaching the user, policy off : ${askedBefore}/${items.length}\n`);
  process.stdout.write(`  prompts reaching the user, policy on  : ${askedAfter}/${items.length}\n`);
  process.stdout.write(`  suppressed                            : ${askedBefore - askedAfter}\n\n`);

  // The three refusals are the point. If never-ask ever silences one of them,
  // this command has to fail rather than celebrate a smaller number.
  const mustAsk = items.map((it, i) => ({ it, res: after[i].res })).filter(({ it }) => it.mustAsk);
  const leaked = mustAsk.filter(({ res }) => res.action === "suppress");
  for (const { it } of mustAsk) {
    const ok = !leaked.find((l) => l.it === it);
    process.stdout.write(
      ok
        ? `  HELD    ${it.name} was still asked despite never-ask\n`
        : `  LEAKED  ${it.name} was SILENCED by never-ask, which must never happen\n`,
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (leaked.length || askedAfter >= askedBefore) {
    process.stdout.write("\n  MEASURE FAILED: either nothing was suppressed, or something that must always ask was silenced.\n\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n  ${askedBefore - askedAfter} prompts removed; the ${mustAsk.length} that must always ask still do.\n\n`);
}

// ----------------------------------------------------------------- selftest

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-plan-tune-selftest-"));
  const mk = (name) => {
    const d = path.join(tmp, name, "plan-tune");
    fs.mkdirSync(d, { recursive: true });
    return path.join(tmp, name);
  };
  const put = (stateRoot, obj) =>
    fs.writeFileSync(path.join(stateRoot, "plan-tune", "policy.json"), typeof obj === "string" ? obj : `${JSON.stringify(obj, null, 2)}\n`, "utf8");

  const entry = (preference, extra = {}) => ({ preference, setAt: "2026-08-14T00:00:00Z", source: "selftest", ...extra });

  const S = {
    empty: mk("empty"),
    neverTwoWay: mk("never-two-way"),
    neverOneWay: mk("never-one-way"),
    neverUnregistered: mk("never-unregistered"),
    neverUnregisteredDeclared: mk("never-unregistered-declared"),
    typo: mk("typo"),
    always: mk("always"),
    oneWayOnly: mk("one-way-only"),
    corrupt: mk("corrupt"),
    globalOnly: mk("global-only"),
    globalVsProject: mk("global-vs-project"),
    aliasOnly: mk("alias-only"),
    legacyString: mk("legacy-string"),
    multi: mk("multi"),
  };

  put(S.empty, { version: 1, scopes: {}, global: {} });
  put(S.neverTwoWay, { version: 1, scopes: { proj: { "ship-version-bump-tier": entry("never-ask") } }, global: {} });
  put(S.neverOneWay, { version: 1, scopes: { proj: { "land-and-deploy-rollback": entry("never-ask") } }, global: {} });
  put(S.neverUnregistered, { version: 1, scopes: { proj: { "totally-made-up-question": entry("never-ask") } }, global: {} });
  put(S.neverUnregisteredDeclared, { version: 1, scopes: { proj: { "totally-made-up-question": entry("never-ask", { door: "two-way" }) } }, global: {} });
  put(S.typo, { version: 1, scopes: { proj: { "ship-version-bump-tier": entry("alwys-ask") } }, global: {} });
  put(S.always, { version: 1, scopes: { proj: { "ship-version-bump-tier": entry("always-ask") } }, global: {} });
  put(S.oneWayOnly, { version: 1, scopes: { proj: { "ship-version-bump-tier": entry("ask-only-for-one-way"), "land-and-deploy-rollback": entry("ask-only-for-one-way") } }, global: {} });
  put(S.corrupt, "{ this is not json");
  put(S.globalOnly, { version: 1, scopes: {}, global: { "ship-version-bump-tier": entry("never-ask") } });
  put(S.globalVsProject, { version: 1, scopes: { proj: { "ship-version-bump-tier": entry("always-ask") } }, global: { "ship-version-bump-tier": entry("never-ask") } });
  put(S.aliasOnly, { version: 1, scopes: { "checkout-dir-name": { "ship-version-bump-tier": entry("never-ask") } }, global: {} });
  put(S.legacyString, { version: 1, scopes: { proj: { "ship-version-bump-tier": "never-ask" } }, global: {} });
  put(S.multi, { version: 1, scopes: { proj: { "ship-todos-create": entry("never-ask"), "ship-version-bump-tier": entry("never-ask"), "land-and-deploy-rollback": entry("never-ask") } }, global: {} });

  const ask = (id, question, options, extra = {}) => ({
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: `${question} <tbs-qid:${id}>`, options, ...extra }] },
  });
  const rec = (a, b) => [{ label: `${a} (recommended)` }, { label: b }];

  const bump = ask("ship-version-bump-tier", "Which version bump?", rec("Patch", "Minor"));
  const rollback = ask("land-and-deploy-rollback", "Roll back production? Irreversible.", rec("Roll back", "Leave it"));
  const adhoc = ask("totally-made-up-question", "Rename the helper?", rec("Rename", "Leave"));

  const base = { TB_PLAN_TUNE_SLUG: "proj" };
  const cases = [
    // ---- it actually suppresses, which is the whole point
    ["never-ask on a two-way door suppresses the prompt", bump, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "suppress"],
    ["ask-only-for-one-way suppresses a two-way prompt", bump, { TOOLBAY_STACK_STATE_DIR: S.oneWayOnly, ...base }, "suppress"],
    ["a global policy applies when the project has none", bump, { TOOLBAY_STACK_STATE_DIR: S.globalOnly, ...base }, "suppress"],
    ["gstack's bare-string preference shape is still honoured", bump, { TOOLBAY_STACK_STATE_DIR: S.legacyString, ...base }, "suppress"],
    [
      "a policy written under the checkout directory name is still found (gstack loses this one)",
      bump,
      { TOOLBAY_STACK_STATE_DIR: S.aliasOnly, TB_PLAN_TUNE_SLUG: "acme-backend", TB_PLAN_TUNE_ALIAS_TEST: "1" },
      "suppress",
    ],
    [
      "an unregistered question suppresses only when the door is declared",
      adhoc,
      { TOOLBAY_STACK_STATE_DIR: S.neverUnregisteredDeclared, ...base },
      "suppress",
    ],
    [
      "a multi-question call is suppressed only when every question is eligible",
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            { question: "Create TODOs? <tbs-qid:ship-todos-create>", options: rec("Yes", "No") },
            { question: "Which bump? <tbs-qid:ship-version-bump-tier>", options: rec("Patch", "Minor") },
          ],
        },
      },
      { TOOLBAY_STACK_STATE_DIR: S.multi, ...base },
      "suppress",
    ],

    // ---- safety: never-ask must never silence an irreversible action
    ["never-ask does NOT suppress a one-way door", rollback, { TOOLBAY_STACK_STATE_DIR: S.neverOneWay, ...base }, "ask"],
    ["ask-only-for-one-way does NOT suppress a one-way door", rollback, { TOOLBAY_STACK_STATE_DIR: S.oneWayOnly, ...base }, "ask"],
    [
      "one ineligible question makes the whole multi-question call ask",
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            { question: "Which bump? <tbs-qid:ship-version-bump-tier>", options: rec("Patch", "Minor") },
            { question: "Roll back production? <tbs-qid:land-and-deploy-rollback>", options: rec("Roll back", "Leave it") },
          ],
        },
      },
      { TOOLBAY_STACK_STATE_DIR: S.multi, ...base },
      "ask",
    ],

    // ---- fail closed: the engine is broken or unsure, so the human is asked
    [
      "an unreadable registry suppresses NOTHING (gstack suppresses anyway)",
      bump,
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, TB_PLAN_TUNE_REGISTRY: path.join(tmp, "no-such-registry.json"), ...base },
      "ask",
    ],
    [
      "a registry with an invalid door type suppresses NOTHING",
      bump,
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, TB_PLAN_TUNE_REGISTRY: path.join(tmp, "bad-registry.json"), ...base },
      "ask",
    ],
    ["a corrupt policy file suppresses NOTHING", bump, { TOOLBAY_STACK_STATE_DIR: S.corrupt, ...base }, "ask"],
    [
      "a typo'd preference value suppresses NOTHING (gstack treats it as never-ask)",
      bump,
      { TOOLBAY_STACK_STATE_DIR: S.typo, ...base },
      "ask",
    ],
    [
      "an unregistered question with no declared door suppresses NOTHING",
      adhoc,
      { TOOLBAY_STACK_STATE_DIR: S.neverUnregistered, ...base },
      "ask",
    ],
    ["always-ask beats a global never-ask", bump, { TOOLBAY_STACK_STATE_DIR: S.globalVsProject, ...base }, "ask"],
    ["no policy at all asks", bump, { TOOLBAY_STACK_STATE_DIR: S.empty, ...base }, "ask"],
    ["a question with no marker asks", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which bump?", options: rec("Patch", "Minor") }] } }, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    [
      "a multiSelect question asks even under never-ask",
      ask("ship-version-bump-tier", "Which bumps?", rec("Patch", "Minor"), { multiSelect: true }),
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base },
      "ask",
    ],
    [
      "two (recommended) options are ambiguous, so it asks",
      ask("ship-version-bump-tier", "Which bump?", [{ label: "Patch (recommended)" }, { label: "Minor (recommended)" }]),
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base },
      "ask",
    ],
    [
      "no (recommended) option at all, so it asks",
      ask("ship-version-bump-tier", "Which bump?", [{ label: "Patch" }, { label: "Minor" }]),
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base },
      "ask",
    ],
    [
      "a split-chain per-option call asks",
      ask("ship-split-patch", "Include the patch option?", rec("Include", "Drop")),
      { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base },
      "ask",
    ],
    ["non-JSON stdin asks", "not json at all", { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    ["an empty payload asks", "", { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    ["a payload with no questions asks", { tool_name: "AskUserQuestion", tool_input: {} }, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    ["a payload whose questions is not an array asks", { tool_name: "AskUserQuestion", tool_input: { questions: "nope" } }, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    ["some other tool is left alone", { tool_name: "Bash", tool_input: { command: "ls" } }, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, ...base }, "ask"],
    ["a crash inside the hook asks", bump, { TOOLBAY_STACK_STATE_DIR: S.neverTwoWay, TB_PLAN_TUNE_FORCE_CRASH: "1", ...base }, "ask"],
  ];

  fs.writeFileSync(path.join(tmp, "bad-registry.json"), JSON.stringify({ version: 1, questions: { "ship-version-bump-tier": { door: "sideways" } } }), "utf8");

  // The alias case has to run from a directory actually named checkout-dir-name,
  // because that name is the last link in the alias chain.
  const aliasDir = path.join(tmp, "checkout-dir-name");
  fs.mkdirSync(aliasDir, { recursive: true });

  const results = [];
  for (const [name, payload, env, expected] of cases) {
    const cwd = env.TB_PLAN_TUNE_ALIAS_TEST ? aliasDir : tmp;
    const got = runHook(payload, env, cwd);
    results.push({ name, expected, got: got.action, pass: got.action === expected, detail: got.reason || got.stderr || got.stdout });
  }

  // The registry is data this engine acts on, so its shape is asserted here
  // rather than assumed. A registry that quietly lost its one-way entries
  // would turn every safety refusal above into a pass for the wrong reason.
  const reg = loadRegistry();
  const ids = reg.ok ? Object.keys(reg.questions) : [];
  const oneWay = ids.filter((i) => reg.questions[i].door === "one-way");
  results.push({
    name: "the shipped registry loads from this file's own directory",
    expected: "loads",
    got: reg.ok ? `loads (${ids.length} questions)` : `UNUSABLE: ${reg.error}`,
    pass: reg.ok,
    detail: registryPath(),
  });
  results.push({
    name: "the registry still carries every one-way door",
    expected: ">= 12 one-way",
    got: `${oneWay.length} one-way`,
    pass: oneWay.length >= 12,
    detail: "these are the questions no preference may ever silence",
  });
  const criticalOneWay = ["land-and-deploy-rollback", "land-and-deploy-merge-confirm", "cso-finding-fix", "investigate-fix-apply"];
  const missing = criticalOneWay.filter((i) => reg.questions?.[i]?.door !== "one-way");
  results.push({
    name: "the irreversible four are classified one-way",
    expected: "all four",
    got: missing.length ? `MISSING: ${missing.join(", ")}` : "all four",
    pass: missing.length === 0,
    detail: criticalOneWay.join(", "),
  });

  // A selftest whose total depends on where it ran is a selftest that can
  // quietly stop asserting things. Borrowed from tb-guard, for the same reason.
  const EXPECTED = cases.length + 4;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-plan-tune selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  This engine is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n  Every deliberately broken input above still reached the human, and every\n");
  process.stdout.write("  one-way door was asked despite a never-ask preference. Suppression only\n");
  process.stdout.write("  happens when every check is confident.\n\n");
}

// ------------------------------------------------------------------- doctor

function doctor() {
  const roots = [path.join(os.homedir(), ".claude", "skills"), path.join(process.cwd(), ".claude", "skills")];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-plan-tune-doctor-"));
  fs.mkdirSync(path.join(tmp, "plan-tune"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "plan-tune", "policy.json"),
    JSON.stringify({ version: 1, scopes: {}, global: { "ship-version-bump-tier": { preference: "never-ask", source: "doctor" } } }, null, 2),
    "utf8",
  );
  const probe = JSON.stringify({
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which version bump? <tbs-qid:ship-version-bump-tier>", options: [{ label: "Patch (recommended)" }, { label: "Minor" }] }] },
  });
  const probeOneWay = JSON.stringify({
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Roll back production? <tbs-qid:land-and-deploy-rollback>", options: [{ label: "Roll back (recommended)" }, { label: "Leave it" }] }] },
  });

  process.stdout.write("\n  tb-plan-tune doctor\n\n");
  let ourInstalls = 0;
  for (const root of roots) {
    const md = path.join(root, "plan-tune", "SKILL.md");
    if (!fs.existsSync(md)) continue;
    const text = fs.readFileSync(md, "utf8");
    const ours = /tb-plan-tune\.mjs/.test(text);
    const cmds = [...new Set([...text.matchAll(/^\s*command:\s*(["'])(.+)\1\s*$/gm)].map((m) => m[2]))];
    process.stdout.write(`  plan-tune  ${path.dirname(md)}${ours ? "" : "   (not a Toolbay Stack skill)"}\n`);
    // A foreign plan-tune is reported and left alone. Its state lives somewhere
    // this tool cannot set, so probing it would produce a verdict about nothing,
    // and failing on it would be an accusation this tool cannot support.
    if (!ours) {
      process.stdout.write(
        cmds.length
          ? "        SKIP    registers its own hook and keeps its preferences elsewhere, so it is not probed here\n"
          : "        SKIP    no PreToolUse hook in its frontmatter; whatever enforces it is registered somewhere else\n",
      );
      continue;
    }
    ourInstalls += 1;
    if (!cmds.length) {
      process.stdout.write("        INERT   no PreToolUse hook command in the frontmatter, so no question is ever suppressed\n");
      process.exitCode = 1;
      continue;
    }
    for (const raw of cmds) {
      const expanded = raw
        .replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/g, os.homedir())
        .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, process.cwd());
      const argv = (expanded.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ""));
      if (!argv.length) continue;
      const env = { ...process.env, TOOLBAY_STACK_STATE_DIR: tmp };
      const run = (input) => {
        const res = spawnSync(argv[0], argv.slice(1), { input, encoding: "utf8", env, windowsHide: true });
        try {
          const p = JSON.parse((res.stdout || "").trim() || "{}");
          return { action: (p.permissionDecision ?? p.hookSpecificOutput?.permissionDecision) === "deny" ? "suppress" : "ask", stderr: (res.stderr || "").trim() };
        } catch {
          return { action: "unparseable output", stderr: (res.stderr || "").trim() };
        }
      };
      const two = run(probe);
      const one = run(probeOneWay);
      const active = two.action === "suppress";
      const safe = one.action === "ask";
      process.stdout.write(`        ${active ? "ACTIVE " : "INERT  "} ${raw}\n`);
      process.stdout.write(`                 two-way question with never-ask -> ${two.action}${active ? "" : "   (this hook removes no prompts)"}\n`);
      process.stdout.write(`                 one-way question with never-ask -> ${one.action}${safe ? "" : "   *** UNSAFE: an irreversible action was auto-approved ***"}\n`);
      if (!active || !safe) {
        const err = two.stderr || one.stderr;
        if (err) process.stdout.write(`                 stderr: ${err.slice(0, 200)}\n`);
        process.exitCode = 1;
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!ourInstalls) {
    process.stdout.write("\n  The Toolbay Stack plan-tune is not installed in ~/.claude/skills or ./.claude/skills,\n");
    process.stdout.write("  so nothing here is suppressing anything on this machine.\n");
    process.stdout.write("  Install with: npx toolbay-stack install --global\n");
    process.exitCode = 1;
  }
  process.stdout.write("\n");
}

// -------------------------------------------------------------------- entry

function help() {
  process.stdout.write(`
  tb-plan-tune ${VERSION}, the Toolbay Stack question-suppression engine

  Hook mode (reads a PreToolUse payload on stdin, prints a decision):
    hook

  Policy:
    policy --list                          show what is set and what it does
    policy --never-ask <id> [--door two-way] [--global] [--note "..."]
    policy --always-ask <id>               ask this one every time
    policy --one-way-only <id>             ask only when it is irreversible
    policy --clear <id> | --clear-all      undo

  Proof:
    state       registry, policy file, and how this project is named
    measure     run a fixed corpus twice, policy off then on, and print how
                many prompts actually stopped reaching you
    selftest    run this executable against real and deliberately broken
                payloads, including ones it must refuse to suppress
    doctor      run the hook command written in the installed SKILL.md and
                report ACTIVE or INERT, and whether one-way doors still ask

  This engine fails closed toward ASKING. A registry it cannot read, a policy
  it cannot parse, a preference value it does not recognise, a question it
  cannot identify, or a door type it does not know all mean the question
  reaches you. One-way doors are asked whatever the policy says.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "hook") {
    if (process.env.TB_PLAN_TUNE_FORCE_CRASH === "1") throw new Error("forced crash for the selftest");
    const stdin = await readStdin();
    if (!stdin.ok) return emitPassThrough();
    const parsed = parseHookInput(stdin.data);
    if (!parsed.ok) return emitPassThrough();
    const d = decide(parsed.value, process.cwd());
    if (!d.suppress) return emitPassThrough();
    return emitSuppress(suppressionReason(d.verdicts));
  }

  if (cmd === "policy") return cmdPolicy(argv.slice(1));
  if (cmd === "state") return cmdState();
  if (cmd === "measure") return cmdMeasure();
  if (cmd === "selftest") return selftest();
  if (cmd === "doctor") return doctor();
  return help();
}

// Nothing below this line may turn a crash into a suppressed question. If the
// process dies while acting as a hook, say nothing, which means the user is
// asked exactly as they would have been without this skill installed.
const actingAsHook = process.argv[2] === "hook";

function crashGuard(err) {
  if (actingAsHook) {
    emitPassThrough();
    process.exit(0);
  }
  process.stderr.write(`tb-plan-tune: ${err?.stack ?? err}\n`);
  process.exit(1);
}

process.on("uncaughtException", crashGuard);
process.on("unhandledRejection", crashGuard);

main().catch(crashGuard);
