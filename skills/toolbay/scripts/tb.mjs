#!/usr/bin/env node
/**
 * tb.mjs — a minimal, dependency-free client for the Toolbay MCP connector.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * Part of Toolbay Stack, which is built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This file is original Toolbay work and is not derived from gstack.
 *
 * WHY THIS EXISTS AT ALL, given the connector can be installed as a real MCP
 * server in Claude Code: the connector is the happy path and this script is the
 * fallback. A skill cannot assume the user ran `claude mcp add`, and the single
 * worst onboarding moment is a skill that says "use the toolbay MCP tool" to an
 * agent that has no such tool. With this script the skill degrades to a Bash
 * call that works immediately, and the connector upgrade becomes an optional
 * improvement rather than a prerequisite.
 *
 * WHY IT DISCOVERS SCHEMAS RATHER THAN HARDCODING THEM: the marketplace ships
 * new tools independently of this package. `tools/list` is one round trip and it
 * is always right; a hardcoded copy of the schemas is wrong the first time the
 * server adds a parameter. `tb tools` prints the live schema, so an agent can
 * read the real contract at call time instead of trusting this file.
 *
 * NO TELEMETRY. This script talks to exactly one host: the Toolbay API. It does
 * not phone anywhere else, and it never logs a token.
 */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The one credential stripper in this package, authored at
// src/secrets/tb-secrets.mjs and copied in beside this file by
// `tools/sync-guard.mjs`. It is shared with the memory layer on purpose: two
// redaction implementations means one of them gets a new pattern and the other
// quietly does not.
import { scrub } from "./tb-secrets.mjs";

const BASE = process.env.TOOLBAY_BASE_URL ?? "https://toolbay.ai";
const MCP_URL = `${BASE}/api/mcp`;
// The override exists so the selftest can exercise the credential paths without
// touching the real one. Same shape as TOOLBAY_STACK_STATE_DIR in the guard.
const CONFIG_DIR = process.env.TOOLBAY_STACK_CONFIG_DIR || path.join(os.homedir(), ".toolbay-stack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * How this script was invoked, so printed hints are copy-pasteable.
 * Hardcoding "node tb.mjs" prints a command that only works if the user happens
 * to be cd'd into the scripts directory, which they almost never are — the
 * skill resolves an absolute or project-relative path.
 */
const SELF = (() => {
  const rel = path.relative(process.cwd(), process.argv[1] ?? "tb.mjs");
  const p = !rel || rel.startsWith("..") ? (process.argv[1] ?? "tb.mjs") : rel;
  return `node ${p.includes(" ") ? `"${p}"` : p}`;
})();

// -------------------------------------------------------------------- output

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

function die(msg, hint) {
  out();
  out(`  ${red("x")} ${scrub(msg)}`);
  if (hint) out(dim(`    ${hint}`));
  out();
  process.exit(1);
}

// -------------------------------------------------------------------- config

/**
 * A config file that will not parse is not the same as no config file.
 *
 * This used to return `{}` for both, which had two consequences: a corrupt
 * config read as "not logged in", so every command told the user to run
 * `login` when the real problem was a damaged file; and `login` itself wrote
 * `{ ...readConfig(), token }`, silently discarding whatever else was in it.
 * Both are reported now, and nothing is written over a file this cannot read.
 */
function readConfig() {
  if (!existsSync(CONFIG_FILE)) return { config: {}, existed: false };
  let text;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch (e) {
    return { error: `${CONFIG_FILE} could not be read (${e.code || e.message})` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${CONFIG_FILE} does not contain a JSON object` };
    }
    return { config: parsed, existed: true };
  } catch (e) {
    return { error: `${CONFIG_FILE} is not valid JSON (${e.message})` };
  }
}

const CONFIG_HINT = "Fix the file, or delete it and run login again. It is not being overwritten.";

function writeConfig(next) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 0600: this file holds a live credential. On Windows the mode is advisory,
  // which is why the token is ALSO accepted from the environment — a user on a
  // shared machine can skip the file entirely.
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Env wins over the config file so CI can inject a token without writing one.
 * With no env token and an unreadable config, this stops: "no token" would be a
 * guess about a file it could not read.
 */
function getToken() {
  if (process.env.TOOLBAY_TOKEN) return process.env.TOOLBAY_TOKEN;
  const c = readConfig();
  if (c.error) die(c.error, CONFIG_HINT);
  return c.config.token || null;
}

// ------------------------------------------------------------------ the stance
//
// The modes layer decides whether reaching a marketplace is appropriate at all
// right now, and this client has to ask. The router already gates the
// marketplace TIER, but the router is only one way in: `tb find` typed by hand,
// or run by an agent that never consulted the router, would otherwise walk
// straight past a stance that exists to stop exactly that. A control enforced at
// one entrance is not a control.
//
// LOCK sets `routing.marketplace: "off"` because pulling an unreviewed
// third-party artifact into near-real-money or client work, or pushing that
// client's work out to a public listing, is the specific damage that mode
// exists to prevent.
//
// FAIL-CLOSED DIRECTION, which is the part worth being careful about:
//
//   - modes layer NOT INSTALLED  -> "on". An install without the layer behaves
//     exactly as it did before it existed. Absent is not the same as forbidding.
//   - modes layer INSTALLED BUT BROKEN -> "quiet", not "on". tb-mode resolves a
//     corrupt or empty config to its own restrained built-in stance, and if the
//     import itself throws, this falls back the same direction by hand.
//
// There is deliberately no --force flag. The only way past a mode that says off
// is for the human to change the stance, which is a visible, deliberate act.
// A bypass flag would be reached for by the agent within one turn of being told
// no, and the whole value of the stance is that it cannot be argued with.

const MODE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "modes", "scripts", "tb-mode.mjs");

/** Marketplace policy for right now. Never throws. */
async function stance() {
  if (!existsSync(MODE_SCRIPT)) {
    return { policy: "on", label: null, installed: false, why: "the modes layer is not installed" };
  }
  try {
    const mod = await import(pathToFileURL(MODE_SCRIPT).href);
    const r = mod.resolveMode({ cwd: process.cwd() });
    const policy = r.mode?.routing?.marketplace;
    return {
      policy: policy === "on" || policy === "quiet" || policy === "off" ? policy : "quiet",
      label: r.mode?.label ?? null,
      installed: true,
      degraded: Boolean(r.degraded),
      source: r.source,
      configPath: r.configPath,
      why: r.mode?.routing?.note || "",
    };
  } catch (err) {
    // Installed but unusable. Resolve DOWN to the built-in stance's policy, not up.
    return { policy: "quiet", label: null, installed: true, degraded: true, why: `the modes layer threw (${err.message})` };
  }
}

/**
 * Called by every command that reaches the marketplace, before the token is read
 * and before any request is built.
 *
 * @param op  human phrasing of what was about to happen, printed in the refusal
 */
async function gate(op) {
  const s = await stance();
  if (s.policy === "off") {
    out();
    out(`  ${red("x")} The active mode does not allow this.`);
    out();
    out(`    mode      ${bold(s.label ?? "unknown")}`);
    out(`    blocked   ${op}`);
    if (s.why) out(dim(`    why       ${s.why}`));
    out();
    out(dim("    Nothing was sent. No token was read."));
    out();
    out(dim("    This is a stance, not a lock, and it is the human's to change:"));
    out(dim("      node <skills>/modes/scripts/tb-mode.mjs show      what is in force and why"));
    out(dim("      node <skills>/modes/scripts/tb-mode.mjs set <name>  choose a different stance"));
    if (s.configPath) out(dim(`      ${s.configPath}  the file that defines them`));
    out();
    out(dim("    Ask them. Do not change the mode yourself to get past this."));
    out();
    process.exit(7);
  }
  if (s.policy === "quiet") {
    out();
    out(dim(`  mode ${s.label ?? "built-in fallback"}: allowed, but in this stance the default answer to a`));
    out(dim("  gap is to build it properly rather than to buy it. Do not pad a thin result."));
    if (s.degraded) out(dim(`  (the modes config could not be read: ${s.why || "falling back to the restrained stance"})`));
  }
  return s;
}

// ----------------------------------------------------------------- MCP client
//
// Streamable HTTP transport: a JSON-RPC POST whose response is EITHER a JSON
// body or an SSE stream, chosen by the server. Both are accepted here because
// which one you get is a server-side detail that has changed before, and a
// client that only handles `application/json` breaks silently the day the
// server decides to stream.

let requestId = 0;
let sessionId = null;

/**
 * @param soft when true, return `{ error }` instead of exiting. Needed for the
 *   auth probe, which must distinguish "bad token" from "valid token, not a
 *   seller yet" rather than dying on the first non-200.
 */
async function rpc(method, params, { token, notify = false, soft = false } = {}) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) body.id = ++requestId;

  const headers = {
    "Content-Type": "application/json",
    // Advertising both is required by the streamable-HTTP spec; servers reject
    // a request that does not accept the stream form.
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let res;
  try {
    res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    die(`Could not reach ${MCP_URL} (${err.message}).`, "Check your connection, or set TOOLBAY_BASE_URL if you are pointing at a local server.");
  }

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (notify) return null;

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    const err = { code: res.status, message: `Toolbay rejected the credential (HTTP ${res.status}).`, http: res.status };
    if (soft) return { error: err };
    die(err.message, `Create a fresh one at https://toolbay.ai/sell/api, then run: ${SELF} login <token>`);
  }

  if (!res.ok) {
    const err = { code: res.status, message: `Toolbay returned HTTP ${res.status}. ${text.slice(0, 400)}`, http: res.status };
    if (soft) return { error: err };
    die(err.message);
  }

  const payload = parseBody(res.headers.get("content-type") ?? "", text);
  if (!payload) {
    const err = { message: "Toolbay returned an empty response." };
    if (soft) return { error: err };
    die(err.message, `Raw body: ${text.slice(0, 200)}`);
  }
  if (payload.error && soft) return { error: payload.error };
  if (payload.error) {
    // Toolbay signals auth failure as a JSON-RPC error (-32001) on a 200, not
    // as an HTTP 401, so the HTTP branch above never catches it. Without this
    // the most common first-run failure prints with no way forward.
    const msg = payload.error.message ?? "MCP error";
    const isAuth = payload.error.code === -32001 || /unauthor|token|credential|forbidden/i.test(msg);
    die(
      `${msg}${payload.error.code ? ` (code ${payload.error.code})` : ""}`,
      isAuth
        ? `Create a token at https://toolbay.ai/sell/api, then run:  ${SELF} login <token>`
        : undefined,
    );
  }
  return payload.result;
}

/** Pull the JSON-RPC envelope out of either a plain body or an SSE stream. */
function parseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    // Take the LAST `data:` frame that parses as a JSON-RPC response. Servers
    // legitimately emit progress notifications first, and taking the first
    // frame would return a notification instead of the result.
    let found = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const obj = JSON.parse(raw);
        if (obj.result !== undefined || obj.error !== undefined) found = obj;
      } catch {
        /* a partial frame is not fatal; keep scanning */
      }
    }
    return found;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Handshake. The server may require it before it will answer tools/*. */
async function connect(token) {
  await rpc(
    "initialize",
    {
      // Matches the version the Toolbay server advertises (route.ts serverInfo).
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "toolbay-stack", version: "0.1.0" },
    },
    { token },
  );
  // Best-effort: some servers do not care, and a failure here must not block
  // the actual call the user asked for.
  try {
    await rpc("notifications/initialized", undefined, { token, notify: true });
  } catch {
    /* non-fatal */
  }
}

async function listTools(token) {
  await connect(token);
  const result = await rpc("tools/list", {}, { token });
  return result?.tools ?? [];
}

async function callTool(token, name, args) {
  await connect(token);
  return rpc("tools/call", { name, arguments: args ?? {} }, { token });
}

/**
 * Prove a token actually works.
 *
 * WHY NOT `tools/list`: it is ANONYMOUS on this server — it answers happily
 * with no credential at all, so using it to "verify" a token reports success
 * for a token that is pure garbage. That bug shipped in the first draft of this
 * file and was caught only by feeding it a fake token. `tools/call` is the
 * cheapest thing that actually exercises the credential.
 *
 * `list_my_products` is the probe because it tests BOTH things that matter for
 * selling: that the credential is valid, and that the account has the seller
 * role. It is read-only and has no side effects (unlike `become_affiliate`,
 * which would silently enrol someone just for checking their token).
 *
 * @returns {{ ok: boolean, seller: boolean, reason?: string }}
 */
async function verifyToken(token) {
  await connect(token);
  const res = await rpc("tools/call", { name: "list_my_products", arguments: {} }, { token, soft: true });

  if (!res?.error) return { ok: true, seller: true };

  const msg = String(res.error.message ?? "");

  // ORDER MATTERS, and getting it wrong is not theoretical: the server's
  // rejection message is "Unauthorized. … Create one in your Toolbay seller
  // settings." A role-check regex containing `seller` matches that string, so
  // testing for the role gate first classifies a totally invalid token as
  // "valid, just not a seller" and saves the garbage. Auth is checked first,
  // and on the error CODE rather than on prose wherever possible.
  //
  // Note this deployment reports auth failure as JSON-RPC -32001 on an HTTP
  // 200, not as an HTTP 401, so both forms have to be handled.
  const authFailed =
    res.error.http === 401 ||
    res.error.code === -32001 ||
    /^unauthorized\b|invalid token|rejected the credential|expired|revoked/i.test(msg);
  if (authFailed) return { ok: false, seller: false, reason: msg };

  // A valid non-seller token fails the ROLE gate, not the auth gate. That is a
  // working token, so saving it is correct — it can search and evaluate, and
  // only publishing needs the upgrade.
  const roleFailed = res.error.http === 403 || /seller access|not a seller|requires seller|insufficient scope/i.test(msg);
  if (roleFailed) return { ok: true, seller: false, reason: msg };

  return { ok: false, seller: false, reason: msg };
}

/** MCP returns content blocks; give the agent the text, parsed if it is JSON. */
function flatten(result) {
  if (!result) return "";
  if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!text) return JSON.stringify(result, null, 2);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ------------------------------------------------------------------ commands

async function cmdStatus() {
  const token = getToken();
  const source = process.env.TOOLBAY_TOKEN ? "TOOLBAY_TOKEN env var" : existsSync(CONFIG_FILE) ? CONFIG_FILE : null;

  out();
  out(bold("  Toolbay connection"));
  out();
  out(`  endpoint   ${dim(MCP_URL)}`);
  if (!token) {
    out(`  token      ${yellow("not set")}`);
    out();
    out(dim("  You can still browse the marketplace; selling needs a token."));
    out(dim("  Get one at https://toolbay.ai/sell/api then run:"));
    out(cyan(`      ${SELF} login <token>`));
    out();
    return;
  }
  out(`  token      ${green("set")} ${dim(`(${token.slice(0, 11)}…, from ${source})`)}`);

  const tools = await listTools(token);
  out(`  endpoint   ${green("reachable")} ${dim(`(${tools.length} tools)`)}`);

  // A token that exists is not a token that works, and `tools/list` answers
  // without any credential — so status must make a real authenticated call or
  // it is reporting on the existence of a file, not on the connection.
  const check = await verifyToken(token);
  out(
    `  auth       ${check.ok ? green("valid") : red("rejected")}${
      check.ok ? "" : dim(` — ${scrub(check.reason ?? "")}`)
    }`,
  );
  out(`  selling    ${check.seller ? green("enabled") : yellow("not a seller account yet")}`);
  out();
  if (!check.ok) out(dim(`  Fix: create a new token at https://toolbay.ai/sell/api then: ${SELF} login <token>`));
  else if (!check.seller) out(dim("  Search and evaluate work. To publish, enable selling at https://toolbay.ai/sell"));
  out();
}

async function cmdLogin(token) {
  if (!token) die(`Usage: ${SELF} login <token>`, "Create a token at https://toolbay.ai/sell/api");
  if (!/^tb_/.test(token)) {
    out(dim("  Note: Toolbay tokens normally start with tb_. Trying it anyway."));
  }
  // Verify BEFORE saving. Writing an unverified credential to disk means the
  // failure surfaces later, in the middle of a publish, instead of right now.
  const check = await verifyToken(token);
  if (!check.ok) {
    die(
      `That token did not work. ${check.reason ?? ""}`.trim(),
      "Create a fresh one at https://toolbay.ai/sell/api and try again. Nothing was saved.",
    );
  }

  const existing = readConfig();
  if (existing.error) die(existing.error, `The token verified, but it cannot be saved without destroying what is already in that file. ${CONFIG_HINT}`);
  writeConfig({ ...existing.config, token });
  out();
  out(`  ${green("+")} Token verified and saved to ${dim(CONFIG_FILE)}`);
  if (!check.seller) {
    out();
    out(`  ${yellow("!")} This account is not a seller yet.`);
    out(dim("    Searching and evaluating work now. Publishing needs seller access:"));
    out(dim("    https://toolbay.ai/sell"));
  }
  out();
  out(dim("  For the full connector inside Claude Code (recommended), also run:"));
  out(cyan(`      claude mcp add --transport http --scope user toolbay ${MCP_URL} --header "Authorization: Bearer <token>"`));
  out();
}

/**
 * Print the real one-time connector install, ready to paste.
 *
 * WHY THIS IS A COMMAND AND NOT A PARAGRAPH IN A SKILL FILE: the command needs
 * the user's token in it, and the single worst thing this stack could do is ask
 * someone to paste a live credential into the chat. Claude has no idea Toolbay
 * exists until the connector is installed, so a token in a message accomplishes
 * nothing except leaving a working credential in their history forever. Here
 * the token never leaves the machine: it is read from the config file that
 * `login` already verified, and printed straight into the command line the user
 * runs in their own terminal.
 */
function cmdConnect({ reveal }) {
  const token = getToken();
  out();
  out(bold("  Connect Toolbay to Claude Code"));
  out();
  if (!token) {
    out(`  ${yellow("!")} No token yet. Two steps, both optional. Everything in this stack`);
    out(`    works without connecting.`);
    out();
    out(`  1. Create a token   ${dim("https://toolbay.ai/sell/api")}`);
    out(`  2. Verify and save  ${cyan(`${SELF} login <token>`)}`);
    out();
    out(dim("  Then run this command again and it will print the connector install"));
    out(dim("  with your token already in it."));
    out();
    out(dim("  Do NOT paste the token into the chat. It does nothing there except"));
    out(dim("  leave a live credential in your history."));
    out();
    return;
  }

  const shown = reveal ? token : `${token.slice(0, 11)}...`;
  out(`  Run this in your terminal, once:`);
  out();
  out(cyan(`      claude mcp add --transport http --scope user toolbay ${MCP_URL} \\`));
  out(cyan(`        --header "Authorization: Bearer ${shown}"`));
  out();
  if (!reveal) {
    out(dim(`  The token is masked above. Print the real command with:  ${SELF} connect --reveal`));
    out(dim("  It is only ever printed to your terminal, never sent anywhere."));
    out();
  }
  out(dim("  After that, mcp__toolbay__* tools are native in every session and this"));
  out(dim("  script is only a fallback. Remove it again with: claude mcp remove toolbay"));
  out();
}

async function cmdTools(filter) {
  const tools = await listTools(getToken());
  const rows = filter ? tools.filter((t) => t.name.includes(filter)) : tools;
  if (rows.length === 0) {
    out();
    out(`  No tools${filter ? ` matching ${bold(filter)}` : ""}.`);
    out();
    return;
  }
  out();
  out(bold(`  ${rows.length} Toolbay tool${rows.length === 1 ? "" : "s"}`));
  out();
  for (const t of rows) {
    out(`  ${cyan(t.name)}`);
    if (t.description) out(`    ${dim(t.description.split("\n")[0])}`);
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    for (const [k, v] of Object.entries(props)) {
      const req = required.has(k) ? red("*") : " ";
      out(dim(`      ${req} ${k} (${v.type ?? "any"})${v.description ? ` — ${v.description.split("\n")[0]}` : ""}`));
    }
  }
  out();
  out(dim(`  * = required.  Call one:  ${SELF} call <tool> '<json>'`));
  out();
}

/**
 * The load-bearing command. This is what a skill runs the moment the agent
 * needs a capability it does not have.
 *
 * HONESTY RAIL: an empty result prints as empty. It does not fall back to
 * "here are some popular tools" and it does not pad the list with near-misses.
 * A stack that answers "nothing on the marketplace does this" is trustworthy;
 * one that always finds something is an ad.
 */
async function cmdFind(problem, limit) {
  if (!problem) die(`Usage: ${SELF} find "<what you are stuck on>" [limit]`);

  // Before the token, before the request. A stance that says no has to say it
  // without a credential being read or a packet leaving the machine.
  await gate(`searching the marketplace for "${String(problem).slice(0, 60)}"`);

  // The server's parameter is `problem`, not `query`, and it means it: the
  // matcher strips stopwords and needs >=2 distinct specific terms, so "a
  // testing tool" returns nothing while "walk-forward backtest harness for
  // ccxt OHLCV data" can match. Pass the user's real words plus the concrete
  // technical detail.
  const args = { problem };
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) args.limit = Math.min(10, Math.round(n));

  const result = await callTool(getToken(), "find_tools", args);
  const body = flatten(result);

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* server returned prose; print it as-is below */
  }

  const items = parsed?.results ?? (Array.isArray(parsed) ? parsed : null);

  if (Array.isArray(items)) {
    out();
    if (items.length === 0) {
      out(`  ${yellow("Nothing on Toolbay fits")} ${bold(problem)}.`);
      // `basis` is written server-side to be relayed verbatim. Paraphrasing it
      // is how an honest empty result turns into a vague one.
      if (parsed?.basis) out(dim(`    ${parsed.basis}`));
      out();
      out(dim("  That is the correct answer, not a failure. Do NOT soften it with"));
      out(dim("  a loosely related listing. The honest next moves:"));
      out(dim(`    - just build it here, then list it:   ${SELF} call evaluate_products ...`));
      out(dim(`    - ask a builder for it (needs consent): ${SELF} call post_request '{"title":"…","brief":"…"}'`));
      out();
      return;
    }
    out(bold(`  ${items.length} listing${items.length === 1 ? "" : "s"} on Toolbay for "${problem}"`));
    out(dim("  These are paid marketplace listings the user would be BUYING. Show the price."));
    out();
    for (const it of items) {
      // `price` is already a display label from the server ("Free", "$19"),
      // so it must not be re-formatted with another dollar sign.
      const price = it.price === "Free" ? green("Free") : bold(it.price ?? "price n/a");
      out(`  ${cyan(it.title ?? it.slug ?? "(untitled)")}  ${price}`);
      if (it.tagline) out(dim(`    ${String(it.tagline).split("\n")[0].slice(0, 120)}`));
      const meta = [it.category, it.type].filter(Boolean).join(" · ");
      if (meta) out(dim(`    ${meta}`));
      out(dim(`    ${it.url ?? `${BASE}/product/${it.slug}`}`));
    }
    if (parsed?.basis) {
      out();
      out(dim(`  ${parsed.basis}`));
    }
    out();
    return;
  }

  out();
  out(body);
  out();
}

async function cmdCall(name, jsonArgs) {
  if (!name) die(`Usage: ${SELF} call <tool> '<json args>'`, `See available tools: ${SELF} tools`);
  // `call` is the general escape hatch, so it is gated too. Gating only `find`
  // would leave `call find_tools` as a one-word way around the stance, and
  // publishing (which sends the user's work OUT) matters at least as much as
  // searching.
  await gate(`calling the marketplace tool "${String(name).slice(0, 40)}"`);
  let args = {};
  if (jsonArgs) {
    try {
      args = JSON.parse(jsonArgs);
    } catch (err) {
      die(`Arguments are not valid JSON: ${err.message}`, `Got: ${jsonArgs.slice(0, 120)}`);
    }
  }
  const result = await callTool(getToken(), name, args);
  out(flatten(result));
}

// ------------------------------------------------------------------ selftest
//
// This client had no selftest. Every case below is a way it could have answered
// a question it had no business answering: a config file it could not read
// reported as "no token set", that same file overwritten by the next login, an
// endpoint that never answered treated as an empty marketplace.

// The stance every subprocess below starts from. Set by selftest() before the
// first case runs.
//
// WHY. This client asks the modes layer for permission before it reaches a
// marketplace, and the modes layer answers from the state of the project the
// process is running in. Without this, every case in this suite inherited
// whatever stance the developer happened to be in: run `npm test` from a
// repository set to LOCK and four unrelated cases (a bad JSON argument, an
// unreachable endpoint) got exit 7 from the mode veto instead of the exit they
// assert, and the suite went red for a reason that had nothing to do with the
// code. A test whose answer depends on the machine it runs on is not a test.
// Cases that are specifically ABOUT modes override these two keys with their own
// fixtures, because `...env` is spread last.
let SELFTEST_STANCE = {};

function runSelf(args, env = {}, cwd = undefined) {
  const res = spawnSync(process.execPath, [process.argv[1], ...args], {
    encoding: "utf8",
    cwd,
    // Nothing here is allowed to reach the real API, the real config, or the
    // real stance.
    env: {
      ...process.env,
      NO_COLOR: "1",
      TOOLBAY_TOKEN: "",
      TOOLBAY_BASE_URL: "http://127.0.0.1:1",
      ...SELFTEST_STANCE,
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tb-client-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const cfgDir = (name, body) => {
    const d = path.join(tmp, name);
    mkdirSync(d, { recursive: true });
    if (body !== undefined) writeFileSync(path.join(d, "config.json"), body, "utf8");
    return d;
  };

  // ---- pin the stance for the whole suite before any case runs
  // A one-mode config with the marketplace tier on, and an empty state
  // directory so no project's saved mode is found. Restraint 2 keeps it a legal
  // safeDefault, so nothing here is testing against a stance the layer would
  // refuse to adopt on its own.
  const neutralModes = path.join(tmp, "modes-selftest.json");
  writeFileSync(
    neutralModes,
    `${JSON.stringify(
      {
        version: 1,
        safeDefault: "selftest",
        modes: {
          selftest: {
            label: "SELFTEST",
            restraint: 2,
            summary: "fixture stance for this suite",
            routing: { marketplace: "on", note: "fixture" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const neutralState = path.join(tmp, "state-selftest");
  mkdirSync(neutralState, { recursive: true });
  SELFTEST_STANCE = { TOOLBAY_STACK_MODES_FILE: neutralModes, TOOLBAY_STACK_STATE_DIR: neutralState };

  {
    // The regression itself: a case that says nothing about modes must not be
    // answered by the developer's stance. Exit 7 here means the veto fired, and
    // the veto has no business firing in a case about a bad JSON argument.
    const d = cfgDir("stance-isolation");
    const r = runSelf(["call", "find_tools", "{not json}"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("the developer's own stance does not leak into unrelated cases", false, r.status === 7, r.stdout.slice(0, 200));
  }

  // ---- a corrupt config is not "logged out"
  {
    const body = '{ "token": "tb_live_truncated';
    const d = cfgDir("corrupt", body);
    const r = runSelf(["status"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("a corrupt config.json fails, rather than reporting no token", 1, r.status, r.stdout.slice(0, 200));
    check("...and names the file", true, /config\.json/.test(r.stdout), r.stdout.slice(0, 200));
    check("...and does not rewrite it", body, readFileSync(path.join(d, "config.json"), "utf8"));
  }
  {
    const d = cfgDir("array", "[1,2,3]");
    const r = runSelf(["find", "a thing"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("a config.json that is not an object fails too", 1, r.status, r.stdout.slice(0, 200));
  }
  {
    // The ordinary case still has to work: no config at all is legitimately
    // "no token", and status says so without failing.
    const d = cfgDir("absent");
    const r = runSelf(["status"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("no config file at all is a normal, non-fatal 'not set'", 0, r.status, r.stdout.slice(0, 200));
    check("...and says the token is not set", true, /not set/.test(r.stdout), r.stdout.slice(0, 200));
  }
  {
    const d = cfgDir("valid", JSON.stringify({ token: "tb_live_abc123", other: "keep me" }));
    const r = runSelf(["status"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("a valid config with an unreachable endpoint fails loudly", 1, r.status, r.stdout.slice(0, 200));
    check("...and never prints the token", false, /tb_live_abc123/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`.slice(0, 200));
  }

  // ---- unknown input
  {
    const d = cfgDir("args");
    check("an unknown command is refused", 1, runSelf(["not-a-command"], { TOOLBAY_STACK_CONFIG_DIR: d }).status);
    check("call with no tool name is refused", 1, runSelf(["call"], { TOOLBAY_STACK_CONFIG_DIR: d }).status);
    const bad = runSelf(["call", "find_tools", "{not json}"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("call with arguments that are not JSON is refused", 1, bad.status);
    check("...and says so before any request is made", true, /not valid JSON/.test(bad.stdout), bad.stdout.slice(0, 200));
    check("login with no token is refused", 1, runSelf(["login"], { TOOLBAY_STACK_CONFIG_DIR: d }).status);
    check("help exits 0", 0, runSelf(["--help"], { TOOLBAY_STACK_CONFIG_DIR: d }).status);
  }

  // ---- an endpoint that does not answer is not an empty marketplace
  {
    const d = cfgDir("offline");
    const r = runSelf(["find", "a pdf parser", "3"], { TOOLBAY_STACK_CONFIG_DIR: d });
    check("an unreachable endpoint fails instead of printing 'nothing fits'", 1, r.status, r.stdout.slice(0, 200));
    check("...and does not claim the marketplace is empty", false, /Nothing on Toolbay fits/.test(r.stdout), r.stdout.slice(0, 200));
  }

  // ---- the stance gate
  //
  // The router already refuses to ROUTE to the marketplace tier under a mode
  // that forbids it. These cases are about the other entrance: the command run
  // by hand, or by an agent that skipped the router entirely. Every refusal has
  // to happen before the token is read and before a packet is built, which is
  // why a dead endpoint is useful here: "allowed" fails with 1 at the network,
  // "refused" exits 7 without ever getting there.
  {
    const proj = path.join(tmp, "stance-project");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, "package.json"), "{}\n", "utf8");
    const stateDir = path.join(tmp, "stance-state");
    mkdirSync(stateDir, { recursive: true });
    const cfg = cfgDir("stance", JSON.stringify({ token: "tb_live_secret999" }));

    const modesFile = (name, body) => {
      const f = path.join(tmp, name);
      writeFileSync(f, body, "utf8");
      return f;
    };
    // safeDefault points at a restraint-2 mode, so an unset project resolves to
    // it. That keeps this test about the POLICY, not about state plumbing.
    const OFF = modesFile(
      "modes-off.json",
      JSON.stringify({
        safeDefault: "sealed",
        modes: { sealed: { label: "SEALED", restraint: 3, summary: "no outside artifacts", routing: { marketplace: "off", note: "client work" } } },
      }),
    );
    const ON = modesFile(
      "modes-on.json",
      JSON.stringify({
        safeDefault: "open",
        modes: { open: { label: "OPEN", restraint: 2, summary: "anything goes", routing: { marketplace: "on" } } },
      }),
    );
    const CORRUPT = modesFile("modes-corrupt.json", '{ "modes": { "sealed":');

    const env = (modes) => ({ TOOLBAY_STACK_CONFIG_DIR: cfg, TOOLBAY_STACK_MODES_FILE: modes, TOOLBAY_STACK_STATE_DIR: stateDir });

    const off = runSelf(["find", "a walk-forward backtest harness for ccxt data"], env(OFF), proj);
    check("a mode that forbids the marketplace refuses find", 7, off.status, off.stdout.slice(0, 240));
    check("...and names the mode that refused", true, /SEALED/.test(off.stdout), off.stdout.slice(0, 240));
    check("...and says nothing was sent", true, /Nothing was sent/.test(off.stdout), off.stdout.slice(0, 240));
    check("...and never read the token", false, /tb_live_secret999/.test(`${off.stdout}${off.stderr}`));
    check("...and did not claim the marketplace was empty", false, /Nothing on Toolbay fits/.test(off.stdout));
    check("...and points at the human, not a bypass flag", true, /Ask them/.test(off.stdout), off.stdout.slice(-240));

    // `call` is the escape hatch, so it has to be gated by the same rule.
    const offCall = runSelf(["call", "find_tools", '{"problem":"x"}'], env(OFF), proj);
    check("the same mode refuses `call find_tools`", 7, offCall.status, offCall.stdout.slice(0, 200));
    const offPublish = runSelf(["call", "publish_evaluated", '{"products":[]}'], env(OFF), proj);
    check("...and refuses publishing out just as hard as pulling in", 7, offPublish.status, offPublish.stdout.slice(0, 200));

    // Not a blanket kill switch: diagnostics still work, so a blocked user can
    // still see why.
    check("a forbidding mode does not break `--help`", 0, runSelf(["--help"], env(OFF), proj).status);

    // Allowed: reaches the network and fails there, which is exit 1, not 7.
    const on = runSelf(["find", "a walk-forward backtest harness for ccxt data"], env(ON), proj);
    check("a mode that allows the marketplace does not block", 1, on.status, on.stdout.slice(0, 200));
    check("...and it got as far as the network", false, /does not allow this/.test(on.stdout), on.stdout.slice(0, 200));

    // A stance flag on an unquoted query used to be swallowed into the search
    // text: it looked obeyed, changed nothing, and sent the flag to Toolbay as
    // part of the problem statement. Refused now, before the token is read.
    const flagged = runSelf(["find", "a backtest harness", "--mode", "lock"], env(ON), proj);
    check("a --mode flag on find is refused, not searched for", 2, flagged.status, flagged.stdout.slice(0, 200));
    check("...and says there is no per-invocation override", true, /no per-invocation mode override/.test(flagged.stdout), flagged.stdout.slice(0, 300));
    check("...and never reached the network with the flag as query text", false, /Nothing on Toolbay fits/.test(flagged.stdout));

    // The direction that matters: a broken modes config must not read as "on".
    const broken = runSelf(["find", "a walk-forward backtest harness for ccxt data"], env(CORRUPT), proj);
    check("a corrupt modes config does not silently become the permissive policy", true, /default answer to a/.test(broken.stdout), broken.stdout.slice(0, 300));
    check("...and still lets the work continue rather than crashing", 1, broken.status, broken.stdout.slice(0, 200));
  }

  rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb selftest  (node ${process.version}, ${process.platform})\n`);
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
  out("\n  No network was touched: every case above points at a dead port on purpose,");
  out("  and a dead port has to read as a failure, never as an empty result.\n");
}

function help() {
  out(`
${bold("tb")} ${dim("— Toolbay marketplace client for Toolbay Stack")}

${bold("Usage")}
  ${cyan(`${SELF} status`)}                    is the connector reachable, is a token set
  ${cyan(`${SELF} login <token>`)}             verify + save a seller token
  ${cyan(`${SELF} connect`)}                   print the one-time MCP connector install
  ${cyan(`${SELF} tools [filter]`)}            list live tools with their real schemas
  ${cyan(`${SELF} find "<need>" [limit]`)}     search the marketplace for a capability
  ${cyan(`${SELF} call <tool> '<json>'`)}      call any tool directly
  ${cyan(`${SELF} selftest`)}                  prove it against deliberately broken input

${bold("Auth")}
  Token comes from ${cyan("TOOLBAY_TOKEN")} or ${dim("~/.toolbay-stack/config.json")}.
  Create one at ${dim("https://toolbay.ai/sell/api")}. Searching may work without one;
  publishing never does.

${bold("The active mode can refuse")}
  ${cyan("find")} and ${cyan("call")} ask the modes layer first. A mode whose
  ${dim("routing.marketplace")} is ${bold("off")} (LOCK ships that way) refuses both before the
  token is read and before anything is sent, and exits ${bold("7")}. That is the human's
  to change with ${dim("tb-mode set <name>")} — there is no bypass flag here on purpose.
  No modes layer installed means no gate, exactly as before it existed.

${bold("Exit codes")}
  0 ok    1 failed    7 the active mode forbids reaching the marketplace

${bold("Notes")}
  Talks only to ${dim(BASE)}. No telemetry. Tokens are never printed.
`);
}

// --------------------------------------------------------------------- entry

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

try {
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") help();
  else if (cmd === "status") await cmdStatus();
  else if (cmd === "login") await cmdLogin(rest[0]);
  else if (cmd === "connect") cmdConnect({ reveal: rest.includes("--reveal") });
  else if (cmd === "tools") await cmdTools(rest[0]);
  else if (cmd === "find") {
    // Accept both `find "the problem" 3` and an unquoted problem, by peeling a
    // trailing bare integer off as the limit. Unquoted input is what people
    // actually type, and a shell that ate the quotes should still work.
    //
    // But an unquoted query means every argument is query text, so a flag typed
    // here is SEARCHED FOR rather than obeyed: `find "x" --mode lock` used to
    // query the marketplace for the literal words "--mode lock" and quietly run
    // under whatever stance was already active. Silently accepting a stance flag
    // that does nothing is the worst of both worlds, because it reads as
    // respected. So flags are refused here, loudly, and `--mode` says why: there
    // is no per-invocation stance override, by design, because a stance you can
    // pass a flag past is not a stance.
    const parts = [...rest];
    const flag = parts.find((p) => p.startsWith("--"));
    if (flag) {
      const isMode = /^--mode\b/.test(flag);
      out();
      out(`  ${red("x")} ${bold(flag)} is not a flag ${bold("find")} takes, and its query is unquoted,`);
      out(`    so this would have searched for the literal text ${bold(flag)}. Nothing was sent.`);
      out();
      if (isMode) {
        out(dim("    There is deliberately no per-invocation mode override on this command."));
        out(dim("    The stance is set on the project and the marketplace client reads it:"));
        out(dim("      node <skills>/modes/scripts/tb-mode.mjs show"));
        out(dim("      node <skills>/modes/scripts/tb-mode.mjs set <name>"));
      } else {
        out(dim(`    Try ${SELF} --help.`));
      }
      out();
      process.exit(2);
    }
    const tail = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? parts.pop() : undefined;
    await cmdFind(parts.join(" "), tail);
  }
  else if (cmd === "call") await cmdCall(rest[0], rest[1]);
  else if (cmd === "selftest") selftest();
  else {
    out();
    out(`  Unknown command ${bold(cmd)}. Try ${cyan(`${SELF} --help`)}.`);
    out();
    process.exit(1);
  }
} catch (err) {
  die(err?.message ?? String(err));
}
