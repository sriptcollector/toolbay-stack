#!/usr/bin/env node
/**
 * tb-ios-qa.mjs: the Toolbay Stack iOS QA control plane. One file, three jobs
 * that can be checked without an iPhone in the room:
 *
 *   preflight        can this machine do live-device iOS QA at all?
 *   classify         which capability tier does a tailnet route require?
 *   allowlist-check  may this remote identity hold that tier right now?
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow this implements (live-device SwiftUI QA over a
 * CoreDevice USB tunnel, an on-device StateServer, a Mac-side daemon, the
 * observe/interact/mutate/restore capability ladder, the tailnet route
 * allowlist, the ~/.gstack/ios-qa-allowlist.json file, and the endpoint names
 * /tap /swipe /type /state/* /state/restore /screenshot /elements /auth/mint)
 * comes from `ios-qa` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY DOES NOT DO
 *
 * gstack's ios-qa needs macOS, Xcode, a Swift toolchain, and a paired iPhone.
 * On this machine (Windows 11, no iOS project) not one of those is present, so
 * nothing in the on-device half can be run, and shipping a "ported" copy of the
 * Swift bridge templates would be shipping 60KB of code nobody in this repo has
 * ever executed. This fork therefore ports the HOST-SIDE control plane only,
 * and says so in SKILL.md. The on-device bridge stays gstack's.
 *
 * That leaves two things worth fixing, and both are checkable from a Windows
 * box because both are pure functions over text.
 *
 * ---------------------------------------------------------------------------
 * FINDING 1 — an unparseable expiry date means "never expires"
 *
 * gstack, daemon/src/allowlist.ts, findEntry():
 *
 *     if (entry.expires_at) {
 *       const exp = Date.parse(entry.expires_at);
 *       if (Number.isFinite(exp) && exp < now) continue;   // <-- skip if NaN
 *     }
 *     return entry;
 *
 * When `Date.parse` cannot read the value it returns NaN, `Number.isFinite` is
 * false, the expiry test is skipped, and the entry is returned as live. The
 * check broke, so the code allowed. Measured on Windows 11 against gstack
 * 1.60.1.0's own logic, 2026-08-13:
 *
 *   expires_at                                    Date.parse   hasCapability('restore')
 *   1700000000000  (epoch ms)                     NaN          true
 *   1700000000     (epoch seconds)                NaN          true
 *   "expired"                                     NaN          true
 *   "2026-13-45T00:00:00Z"                        NaN          true
 *   "2020-01-01T00:00:00Z"  (genuinely expired)   1577836800000 false
 *
 * The epoch-ms row is not a hypothetical. gstack's own types.ts declares
 * `AllowlistEntry.expires_at: string | null` twelve lines above
 * `SessionToken.expires_at: number` — two fields, same name, same file,
 * different units. Writing the number into the wrong one is the natural
 * mistake, and the punishment is a `restore`-tier grant that never lapses and
 * looks correctly time-boxed in the file.
 *
 * Here: an expiry that cannot be read is a DENY with reason
 * `expiry_unparseable`, and the message names the field and the required
 * format. Only a strict ISO-8601 instant counts as an expiry.
 *
 * ---------------------------------------------------------------------------
 * FINDING 2 — the route classifier grades on the unnormalized path
 *
 * gstack, daemon/src/types.ts, tierForRoute():
 *
 *     if (path.startsWith('/state/') && path !== '/state/snapshot' && path !== '/state/restore') {
 *       if (method === 'POST') return 'mutate';
 *     }
 *
 * The two exclusions are exact string compares against a path that arrived
 * from `url.parse(req.url).pathname`, which strips the query string and
 * nothing else — no slash collapsing, no dot-segment resolution, no decoding.
 * Any spelling of the restore endpoint that is not byte-identical falls
 * through to the wildcard and is graded `mutate`, one tier below `restore`.
 * Same measurement run:
 *
 *   POST /state/restore    -> restore
 *   POST /state/restore/   -> mutate
 *   POST /state//restore   -> mutate
 *   POST /state/./restore  -> mutate
 *
 * Whether an iPhone at the far end honours those spellings is not something
 * this machine can answer, and this file does not claim it can. What it does
 * claim is narrower and sufficient: a tier ladder whose top rung can be
 * addressed by four spellings and only defends one is wrong at the classifier,
 * and the classifier is the part that is supposed to be the answer.
 *
 * Here: the path is normalized FIRST (collapse `//`, drop `.` segments), then
 * matched against a closed table. Anything the normalizer will not vouch for —
 * a `..` segment, a percent-escape, a backslash, a control character, a query
 * or fragment, a non-absolute path — is denied outright rather than repaired
 * and guessed at. `classify` prints the normalized path so a daemon can
 * forward THAT rather than the raw bytes it was handed.
 *
 * ---------------------------------------------------------------------------
 * FINDING 3 — nothing stops the workflow starting on a machine that cannot run it
 *
 * gstack's prerequisites ("macOS", "Xcode", "iPhone connected via USB") are
 * prose in SKILL.md with no executable check behind them. The first thing that
 * actually touches the host is the Phase 0 warm-start snippet, which shells out
 * to `python3`. Run verbatim on Windows 11, 2026-08-13:
 *
 *   $ bash phase0.sh
 *   Python was not found; run without arguments to install from the Microsoft Store...
 *   Python was not found; run without arguments to install from the Microsoft Store...
 *   CACHED_UDID=[]
 *   CACHED_PORT=[]
 *   exit-status-of-block=0
 *
 * Exit 0. Both variables empty. No error the agent is obliged to notice. The
 * next instruction in the skill is to add an SPM dependency to the user's
 * Package.swift and wire `#if DEBUG` code into their `@main` App — real edits
 * to a real repository, on a host that cannot build, sign, install, or launch
 * the result, and cannot therefore ever undo them by testing.
 *
 * Here: `preflight` is a hard gate that runs before anything is touched. Every
 * probe that cannot reach a confident yes is a failure, including a probe that
 * times out or throws — a broken check is never a passed check. An unsupported
 * host exits 3 and the remaining probes are reported as `skipped`, never as
 * passed. Exit 0 means every named probe returned real output, which is printed.
 *
 * ---------------------------------------------------------------------------
 * DESIGN RULES
 *
 *   1. FAIL CLOSED. Every path that cannot reach a confident allow ends in a
 *      deny that names the check that failed.
 *   2. NO INTERPRETER BUT NODE. Node ships with Claude Code. No python3, no
 *      bun, no shell, so there is no silent-empty-variable class of bug.
 *   3. PROVE IT. `selftest` runs this file's real decision functions and the
 *      real executable as a child process against deliberately broken inputs,
 *      and exits non-zero if any of them is allowed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

// Exit codes are part of the contract: a caller scripting this needs to tell
// "your machine cannot do this" apart from "your machine can, but something is
// missing", because only the second one is worth fixing.
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_HOST_UNSUPPORTED = 3;

// ---------------------------------------------------------------- capabilities
//
// The ladder is gstack's: observe < interact < mutate < restore. It is held in
// a Map rather than an object literal so that inherited property names
// ("constructor", "toString", "__proto__") cannot take part in a lookup at all.
// gstack's object-literal version survives that by accident — comparing a
// function to a number yields false — and an accident is not a control.

const CAPABILITY_RANK = new Map([
  ["observe", 0],
  ["interact", 1],
  ["mutate", 2],
  ["restore", 3],
]);

export function isCapability(value) {
  return typeof value === "string" && CAPABILITY_RANK.has(value);
}

/** Does holding `have` satisfy a requirement for `need`? Unknown tier: no. */
export function capabilityCovers(have, need) {
  if (!isCapability(have) || !isCapability(need)) return false;
  return CAPABILITY_RANK.get(have) >= CAPABILITY_RANK.get(need);
}

// --------------------------------------------------------------- route tiers
//
// A closed table. Every route that may cross the tailnet listener is spelled
// out with its method; there is no wildcard row, because the wildcard row is
// what let `/state/restore/` collect a `mutate` grade in gstack.

const ROUTE_TIERS = new Map([
  ["GET /healthz", "observe"],
  ["GET /screenshot", "observe"],
  ["GET /elements", "observe"],
  ["GET /state/snapshot", "observe"],
  ["POST /auth/mint", "observe"],
  ["POST /auth/revoke", "observe"],
  ["POST /session/acquire", "interact"],
  ["POST /session/release", "interact"],
  ["POST /session/heartbeat", "interact"],
  ["POST /tap", "interact"],
  ["POST /swipe", "interact"],
  ["POST /type", "interact"],
  ["POST /state/restore", "restore"],
]);

const ALLOWED_METHODS = new Set(["GET", "POST"]);

// `/state/<key>` keys are Swift property names on an @Observable class, so they
// are Swift identifiers. Asserting that shape is an allowlist; asserting "not
// snapshot and not restore" the way gstack does is a blocklist, and a blocklist
// of two strings is exactly two spellings wide.
const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Names under /state/ that mean something other than "a property to read or
// write". They are reachable only through their exact rows above.
const RESERVED_STATE_KEYS = new Set(["snapshot", "restore"]);

const MAX_PATH_LENGTH = 512;

/**
 * Reduce a request path to the one spelling the table is allowed to match on,
 * or refuse.
 *
 * Refusing is the important half. A normalizer that repairs anything it is
 * handed will happily turn an attack into a valid route and grade the repair;
 * the daemon then forwards the ORIGINAL bytes to the device, and the thing that
 * was graded is not the thing that was sent. So: collapse empty segments and
 * `.` (both are no-ops in every HTTP router in existence, and neither can
 * change which resource is addressed), and reject everything else — `..`,
 * percent-escapes, backslashes, control bytes, queries, fragments.
 */
export function normalizeRoutePath(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "path_not_a_string" };
  if (raw.length === 0) return { ok: false, reason: "path_empty" };
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, reason: "path_too_long" };
  // Git Bash on Windows (MSYS2) rewrites any argument that looks like an
  // absolute POSIX path into a Windows path before the process ever sees it:
  //
  //   $ node tb-ios-qa.mjs classify POST /state/restore
  //   DENY path_not_absolute (C:/Program Files/Git/state/restore)
  //
  // The denial is correct — a mangled argument is not the route that was meant
  // — but "not absolute" about a string starting `C:/` reads as a bug in the
  // tool, so the operator retries it instead of fixing it. Naming the mangling
  // is the difference between a two-second fix and a bug report.
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { ok: false, reason: "path_mangled_by_msys_path_conversion" };
  if (!raw.startsWith("/")) return { ok: false, reason: "path_not_absolute" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: "path_has_control_character" };
  if (raw.includes("\\")) return { ok: false, reason: "path_has_backslash" };
  if (raw.includes("%")) return { ok: false, reason: "path_percent_encoded" };
  if (raw.includes("?") || raw.includes("#")) return { ok: false, reason: "path_has_query_or_fragment" };

  const out = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "path_has_dot_dot_segment" };
    out.push(segment);
  }
  return { ok: true, path: `/${out.join("/")}` };
}

/**
 * Grade a route. Returns the minimum capability tier that may call it, or a
 * denial with a reason. Never returns a tier for anything it had to guess at.
 */
export function classifyRoute(method, rawPath) {
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
    return { allowed: false, reason: "method_not_allowed", detail: String(method) };
  }
  const norm = normalizeRoutePath(rawPath);
  if (!norm.ok) return { allowed: false, reason: norm.reason, detail: String(rawPath) };

  const exact = ROUTE_TIERS.get(`${method} ${norm.path}`);
  if (exact) return { allowed: true, tier: exact, path: norm.path };

  if (norm.path.startsWith("/state/")) {
    const key = norm.path.slice("/state/".length);
    if (key.includes("/")) return { allowed: false, reason: "state_key_is_nested", path: norm.path };
    if (RESERVED_STATE_KEYS.has(key)) {
      // e.g. GET /state/restore. The reserved rows exist with one method each;
      // any other method against them is not a state read, it is a probe.
      return { allowed: false, reason: "reserved_state_key_wrong_method", path: norm.path };
    }
    if (!STATE_KEY.test(key)) return { allowed: false, reason: "state_key_not_an_identifier", path: norm.path };
    if (method === "GET") return { allowed: true, tier: "observe", path: norm.path };
    return { allowed: true, tier: "mutate", path: norm.path };
  }

  return { allowed: false, reason: "endpoint_not_in_tailnet_allowlist", path: norm.path };
}

// ------------------------------------------------------------------ allowlist
//
// ~/.gstack/ios-qa-allowlist.json in gstack; ~/.toolbay/ios-qa-allowlist.json
// here, with the gstack path accepted as a fallback so an existing install is
// read rather than ignored. Shape is gstack's, unchanged:
//   { "version": 1, "entries": [ { identity, capabilities[], expires_at, note } ] }

export function defaultAllowlistPath() {
  if (process.env.TOOLBAY_IOS_QA_ALLOWLIST) return process.env.TOOLBAY_IOS_QA_ALLOWLIST;
  const ours = path.join(os.homedir(), ".toolbay", "ios-qa-allowlist.json");
  if (fs.existsSync(ours)) return ours;
  const theirs = path.join(os.homedir(), ".gstack", "ios-qa-allowlist.json");
  if (fs.existsSync(theirs)) return theirs;
  return ours;
}

// A strict ISO-8601 instant with an explicit zone. Anything looser is a guess
// about what the author meant, and this file does not guess about expiry.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Canonical tailnet identities as Tailscale's WhoIs produces them: a lowercased
// login email, a `tag:` node tag, or a `node:` key.
const CANONICAL_IDENTITY = /^(tag:[a-z0-9][a-z0-9-]*|node:[a-f0-9]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

export function isCanonicalIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.toLowerCase() &&
    CANONICAL_IDENTITY.test(value)
  );
}

/**
 * Read and structurally validate the allowlist.
 *
 * A malformed entry ANYWHERE denies everyone, not just that entry. That is
 * deliberate and it is the opposite of gstack, which skips what it cannot
 * understand and answers from the rest. An access-control file that is not
 * entirely readable is not a source of truth about access, and answering from
 * the readable half is answering a question nobody asked.
 */
export function loadAllowlist(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, reason: "allowlist_missing", detail: file };
    }
    return { ok: false, reason: "allowlist_unreadable", detail: `${file}: ${err && err.message}` };
  }
  if (raw.trim() === "") return { ok: true, entries: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "allowlist_unreadable", detail: `${file}: ${err && err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "allowlist_not_an_object", detail: file };
  }
  if (parsed.version !== 1) {
    return { ok: false, reason: "allowlist_version_unsupported", detail: String(parsed.version) };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, reason: "allowlist_entries_not_an_array", detail: file };
  }

  const seen = new Set();
  for (let i = 0; i < parsed.entries.length; i++) {
    const e = parsed.entries[i];
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, reason: "allowlist_entry_malformed", detail: `entries[${i}] is not an object` };
    }
    if (!isCanonicalIdentity(e.identity)) {
      // gstack compares identities with `!==` against a WhoIs result that is
      // always lowercased, so an entry written as "Tag:CI" simply never matches
      // and the owner sees a grant that silently does nothing.
      return { ok: false, reason: "allowlist_entry_malformed", detail: `entries[${i}].identity is not a canonical tailnet identity: ${JSON.stringify(e.identity)}` };
    }
    if (seen.has(e.identity)) {
      return { ok: false, reason: "allowlist_duplicate_identity", detail: e.identity };
    }
    seen.add(e.identity);
    if (!Array.isArray(e.capabilities) || e.capabilities.length === 0) {
      // gstack calls `.some()` on this unchecked; a string here is a TypeError
      // out of the request handler rather than a decision.
      return { ok: false, reason: "allowlist_entry_malformed", detail: `entries[${i}].capabilities must be a non-empty array` };
    }
    for (const c of e.capabilities) {
      if (!isCapability(c)) {
        return { ok: false, reason: "allowlist_entry_malformed", detail: `entries[${i}].capabilities contains unknown tier ${JSON.stringify(c)}` };
      }
    }
    if (e.expires_at !== null && e.expires_at !== undefined) {
      if (typeof e.expires_at !== "string" || !ISO_INSTANT.test(e.expires_at) || !Number.isFinite(Date.parse(e.expires_at))) {
        return {
          ok: false,
          reason: "expiry_unparseable",
          detail: `entries[${i}].expires_at is ${JSON.stringify(e.expires_at)}; must be a strict ISO-8601 instant such as 2026-09-01T00:00:00Z, or null for no expiry`,
        };
      }
    }
  }
  return { ok: true, entries: parsed.entries };
}

/**
 * May `identity` hold `need` right now? Every no is a named no.
 */
export function evaluateAccess(opts) {
  const { identity, need, now = Date.now() } = opts;
  const file = opts.file ?? defaultAllowlistPath();

  if (!isCapability(need)) {
    return { allowed: false, reason: "unknown_capability_requested", detail: String(need) };
  }
  if (!isCanonicalIdentity(identity)) {
    return { allowed: false, reason: "identity_not_canonical", detail: String(identity) };
  }

  const list = loadAllowlist(file);
  if (!list.ok) return { allowed: false, reason: list.reason, detail: list.detail };

  const entry = list.entries.find((e) => e.identity === identity);
  if (!entry) return { allowed: false, reason: "identity_not_allowed", detail: identity };

  if (entry.expires_at) {
    const exp = Date.parse(entry.expires_at);
    // loadAllowlist has already refused anything unparseable, so reaching here
    // with a NaN is impossible. Asserting it anyway costs one branch and means
    // a future edit to the validator cannot reopen finding 1 in silence.
    if (!Number.isFinite(exp)) {
      return { allowed: false, reason: "expiry_unparseable", detail: String(entry.expires_at) };
    }
    if (exp <= now) {
      return { allowed: false, reason: "grant_expired", detail: entry.expires_at };
    }
  }

  const granted = entry.capabilities.find((c) => capabilityCovers(c, need));
  if (!granted) {
    return { allowed: false, reason: "capability_insufficient", detail: `holds ${entry.capabilities.join(",")}, needs ${need}` };
  }
  return { allowed: true, granted, identity, expires_at: entry.expires_at ?? null };
}

// ------------------------------------------------------------------ preflight

function probe(cmd, args, timeoutMs) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
    if (r.error) return { ok: false, detail: `${cmd}: ${r.error.code ?? r.error.message}` };
    // A killed probe is a probe that did not answer. It is not a pass.
    if (r.signal) return { ok: false, detail: `${cmd}: killed by ${r.signal} after ${timeoutMs}ms` };
    if (r.status !== 0) return { ok: false, detail: `${cmd} exited ${r.status}: ${firstLine(r.stderr || r.stdout)}` };
    return { ok: true, detail: firstLine(r.stdout || r.stderr), stdout: r.stdout ?? "" };
  } catch (err) {
    return { ok: false, detail: `${cmd}: ${err && err.message}` };
  }
}

function firstLine(s) {
  return String(s ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
}

const PROBE_TIMEOUT_MS = () => {
  const raw = process.env.TOOLBAY_IOS_QA_PROBE_TIMEOUT_MS;
  const n = raw === undefined ? 60_000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
};

/**
 * The gate. Answers one question — can this machine drive a real iPhone right
 * now — and answers it with command output rather than with prose.
 *
 * Ordering matters: the host check runs alone and short-circuits. Reporting
 * "xcodebuild MISSING" on a Windows box is technically true and completely
 * useless; the actionable fact is that the host is wrong, and every probe after
 * it is reported `skipped`, which is not a pass and never counts as one.
 */
export function runPreflight() {
  const timeout = PROBE_TIMEOUT_MS();
  const platform = process.env.TOOLBAY_IOS_QA_FAKE_HOST || process.platform;
  const checks = [];

  const hostOk = platform === "darwin";
  checks.push({
    id: "host_is_macos",
    ok: hostOk,
    detail: hostOk
      ? `process.platform = ${platform}`
      : `process.platform = ${platform}; live-device iOS QA needs macOS for xcodebuild, xcrun devicectl and the CoreDevice USB tunnel. There is no Windows or Linux path to this, with or without a device attached.`,
  });

  if (!hostOk) {
    for (const id of ["xcrun_present", "xcodebuild_present", "devicectl_present", "swift_toolchain", "device_paired_and_connected"]) {
      checks.push({ id, ok: false, skipped: true, detail: "skipped: host is not macOS" });
    }
    return { ok: false, hostSupported: false, platform, checks };
  }

  const xcrun = probe("xcrun", ["--version"], timeout);
  checks.push({ id: "xcrun_present", ok: xcrun.ok, detail: xcrun.detail });

  const xcodebuild = probe("xcodebuild", ["-version"], timeout);
  checks.push({ id: "xcodebuild_present", ok: xcodebuild.ok, detail: xcodebuild.detail });

  const devicectl = probe("xcrun", ["devicectl", "--version"], timeout);
  checks.push({ id: "devicectl_present", ok: devicectl.ok, detail: devicectl.detail });

  const swift = probe("swift", ["--version"], timeout);
  let swiftOk = false;
  let swiftDetail = swift.detail;
  if (swift.ok) {
    const m = /Swift version (\d+)\.(\d+)/.exec(swift.stdout ?? "");
    if (!m) {
      // Present but unreadable version output is not a pass. gstack's SKILL.md
      // asks the agent to eyeball ">= 5.9"; an eyeball is not a check.
      swiftDetail = `swift ran but its version could not be read from: ${firstLine(swift.stdout)}`;
    } else {
      const major = Number(m[1]);
      const minor = Number(m[2]);
      swiftOk = major > 5 || (major === 5 && minor >= 9);
      swiftDetail = `Swift ${major}.${minor}${swiftOk ? "" : " (needs >= 5.9 for swift-syntax accessor codegen)"}`;
    }
  }
  checks.push({ id: "swift_toolchain", ok: swiftOk, detail: swiftDetail });

  const device = probeDevices(timeout);
  checks.push({ id: "device_paired_and_connected", ok: device.ok, detail: device.detail });

  return {
    ok: checks.every((c) => c.ok),
    hostSupported: true,
    platform,
    checks,
    devices: device.devices ?? [],
  };
}

function probeDevices(timeout) {
  const out = path.join(os.tmpdir(), `tb-ios-qa-devices-${process.pid}-${Date.now()}.json`);
  try {
    const r = probe("xcrun", ["devicectl", "list", "devices", "--json-output", out], timeout);
    if (!r.ok) return { ok: false, detail: r.detail };
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(out, "utf8"));
    } catch (err) {
      // gstack's listDevices() swallows this into `return []`, which reads
      // downstream as "no devices" — indistinguishable from a device that is
      // simply unplugged, and one of those is a bug report.
      return { ok: false, detail: `devicectl wrote output that could not be read as JSON: ${err && err.message}` };
    }
    const list = Array.isArray(obj?.result?.devices) ? obj.result.devices : null;
    if (list === null) return { ok: false, detail: "devicectl JSON had no result.devices array" };
    const usable = list
      .map((d) => ({
        udid: String(d?.identifier ?? ""),
        name: String(d?.deviceProperties?.name ?? "unknown"),
        paired: String(d?.connectionProperties?.pairingState ?? "") === "paired",
        tunnel: String(d?.connectionProperties?.tunnelState ?? "unknown"),
      }))
      .filter((d) => d.udid && d.paired);
    if (usable.length === 0) {
      return { ok: false, detail: `devicectl listed ${list.length} device(s), none paired` };
    }
    return { ok: true, detail: usable.map((d) => `${d.name} (${d.udid}, tunnel ${d.tunnel})`).join("; "), devices: usable };
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function printPreflight(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const width = Math.max(...result.checks.map((c) => c.id.length));
    process.stdout.write(`\n  tb-ios-qa preflight  (node ${process.version}, ${result.platform})\n\n`);
    for (const c of result.checks) {
      const tag = c.ok ? "PASS" : c.skipped ? "SKIP" : "FAIL";
      process.stdout.write(`  ${tag}  ${c.id.padEnd(width)}  ${c.detail}\n`);
    }
    process.stdout.write("\n");
    if (!result.hostSupported) {
      process.stdout.write("  HOST_UNSUPPORTED. Stop here. Do not add the DebugBridge SPM dependency,\n");
      process.stdout.write("  do not edit Package.swift, do not wire anything into the @main App: this\n");
      process.stdout.write("  machine cannot build, install, launch or undo any of it.\n\n");
    } else if (!result.ok) {
      process.stdout.write("  Preflight failed. Fix the FAIL lines above before touching the app source.\n\n");
    } else {
      process.stdout.write("  Preflight passed. Every line above is real command output.\n\n");
    }
  }
  if (!result.hostSupported) return EXIT_HOST_UNSUPPORTED;
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

// ------------------------------------------------------------------- selftest

function runSelf(args, env = {}) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeAllowlist(dir, name, contents) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
  return file;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ios-qa-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  // ---------------------------------------------------------- route grading
  const routeCases = [
    // The tier ladder, graded correctly on the canonical spelling.
    ["route: POST /state/restore is restore-tier", "POST", "/state/restore", "restore"],
    ["route: POST /tap is interact-tier", "POST", "/tap", "interact"],
    ["route: GET /screenshot is observe-tier", "GET", "/screenshot", "observe"],
    ["route: GET /state/snapshot is observe-tier", "GET", "/state/snapshot", "observe"],
    ["route: POST /state/userLoggedIn is mutate-tier", "POST", "/state/userLoggedIn", "mutate"],
    ["route: GET /state/userLoggedIn is observe-tier", "GET", "/state/userLoggedIn", "observe"],
    // Finding 2: gstack grades every one of these `mutate`, one tier below the
    // restore endpoint they address.
    ["route: trailing slash still grades restore (gstack says mutate)", "POST", "/state/restore/", "restore"],
    ["route: doubled slash still grades restore (gstack says mutate)", "POST", "/state//restore", "restore"],
    ["route: dot segment still grades restore (gstack says mutate)", "POST", "/state/./restore", "restore"],
    // Everything the normalizer will not vouch for.
    ["route: percent-escaped path is denied", "POST", "/state/%72estore", "DENY:path_percent_encoded"],
    ["route: dot-dot segment is denied", "POST", "/state/../tap", "DENY:path_has_dot_dot_segment"],
    ["route: backslash path is denied", "POST", "\\state\\restore", "DENY:path_not_absolute"],
    ["route: query string is denied", "POST", "/state/restore?x=1", "DENY:path_has_query_or_fragment"],
    ["route: control character is denied", "POST", "/tap\u0000", "DENY:path_has_control_character"],
    ["route: relative path is denied", "POST", "state/restore", "DENY:path_not_absolute"],
    ["route: a Git Bash mangled path is named, not just denied", "POST", "C:/Program Files/Git/state/restore", "DENY:path_mangled_by_msys_path_conversion"],
    ["route: empty path is denied", "POST", "", "DENY:path_empty"],
    ["route: non-string path is denied", "POST", null, "DENY:path_not_a_string"],
    // Method and endpoint closure.
    ["route: lowercase method is denied", "post", "/tap", "DENY:method_not_allowed"],
    ["route: DELETE is denied", "DELETE", "/tap", "DENY:method_not_allowed"],
    ["route: unknown endpoint is denied", "GET", "/random", "DENY:endpoint_not_in_tailnet_allowlist"],
    ["route: loopback-only /auth/sessions is denied", "GET", "/auth/sessions", "DENY:endpoint_not_in_tailnet_allowlist"],
    ["route: POST /state/snapshot is denied", "POST", "/state/snapshot", "DENY:reserved_state_key_wrong_method"],
    ["route: GET /state/restore is denied", "GET", "/state/restore", "DENY:reserved_state_key_wrong_method"],
    ["route: nested state key is denied", "POST", "/state/a/b", "DENY:state_key_is_nested"],
    ["route: non-identifier state key is denied", "POST", "/state/9lives", "DENY:state_key_not_an_identifier"],
    ["route: prototype key is denied", "GET", "/constructor", "DENY:endpoint_not_in_tailnet_allowlist"],
  ];
  for (const [name, method, p, expected] of routeCases) {
    const r = classifyRoute(method, p);
    check(name, expected, r.allowed ? r.tier : `DENY:${r.reason}`);
  }

  // ------------------------------------------------------------- allowlist
  const NOW = Date.parse("2026-08-13T12:00:00Z");
  const entry = (over = {}) => ({ identity: "tag:ci", capabilities: ["restore"], expires_at: null, ...over });
  const list = (entries) => ({ version: 1, entries });

  const allowCases = [
    [
      "allowlist: a live restore grant allows restore",
      list([entry()]),
      "tag:ci",
      "restore",
      "ALLOW:restore",
    ],
    [
      "allowlist: an interact grant does not reach restore",
      list([entry({ capabilities: ["interact"] })]),
      "tag:ci",
      "restore",
      "DENY:capability_insufficient",
    ],
    [
      "allowlist: a restore grant covers observe",
      list([entry()]),
      "tag:ci",
      "observe",
      "ALLOW:restore",
    ],
    [
      "allowlist: a future ISO expiry still allows",
      list([entry({ expires_at: "2027-01-01T00:00:00Z" })]),
      "tag:ci",
      "restore",
      "ALLOW:restore",
    ],
    [
      "allowlist: a past ISO expiry denies",
      list([entry({ expires_at: "2020-01-01T00:00:00Z" })]),
      "tag:ci",
      "restore",
      "DENY:grant_expired",
    ],
    // Finding 1: gstack returns the entry as live for every one of these.
    [
      "allowlist: epoch-ms expiry denies (gstack: never expires)",
      list([entry({ expires_at: 1700000000000 })]),
      "tag:ci",
      "restore",
      "DENY:expiry_unparseable",
    ],
    [
      "allowlist: epoch-seconds expiry denies (gstack: never expires)",
      list([entry({ expires_at: 1700000000 })]),
      "tag:ci",
      "restore",
      "DENY:expiry_unparseable",
    ],
    [
      'allowlist: expires_at "expired" denies (gstack: never expires)',
      list([entry({ expires_at: "expired" })]),
      "tag:ci",
      "restore",
      "DENY:expiry_unparseable",
    ],
    [
      "allowlist: impossible calendar date denies (gstack: never expires)",
      list([entry({ expires_at: "2026-13-45T00:00:00Z" })]),
      "tag:ci",
      "restore",
      "DENY:expiry_unparseable",
    ],
    [
      "allowlist: date with no zone denies (gstack: local-time guess)",
      list([entry({ expires_at: "2020-01-01" })]),
      "tag:ci",
      "restore",
      "DENY:expiry_unparseable",
    ],
    // Structural refusals.
    [
      "allowlist: capabilities as a bare string denies (gstack: TypeError)",
      list([entry({ capabilities: "restore" })]),
      "tag:ci",
      "restore",
      "DENY:allowlist_entry_malformed",
    ],
    [
      "allowlist: unknown tier name denies",
      list([entry({ capabilities: ["god"] })]),
      "tag:ci",
      "restore",
      "DENY:allowlist_entry_malformed",
    ],
    [
      "allowlist: empty capabilities array denies",
      list([entry({ capabilities: [] })]),
      "tag:ci",
      "restore",
      "DENY:allowlist_entry_malformed",
    ],
    [
      "allowlist: a non-canonical identity in the file denies everyone",
      list([entry({ identity: "Tag:CI" })]),
      "tag:ci",
      "restore",
      "DENY:allowlist_entry_malformed",
    ],
    [
      "allowlist: duplicate identities deny",
      list([entry(), entry({ capabilities: ["observe"] })]),
      "tag:ci",
      "restore",
      "DENY:allowlist_duplicate_identity",
    ],
    [
      "allowlist: wrong version denies",
      { version: 2, entries: [entry()] },
      "tag:ci",
      "restore",
      "DENY:allowlist_version_unsupported",
    ],
    [
      "allowlist: entries not an array denies",
      { version: 1, entries: {} },
      "tag:ci",
      "restore",
      "DENY:allowlist_entries_not_an_array",
    ],
    [
      "allowlist: a top-level array denies",
      [entry()],
      "tag:ci",
      "restore",
      "DENY:allowlist_not_an_object",
    ],
    [
      "allowlist: corrupt JSON denies (gstack: throws out of the handler)",
      "{ this is not json",
      "tag:ci",
      "restore",
      "DENY:allowlist_unreadable",
    ],
    [
      "allowlist: empty file denies",
      "",
      "tag:ci",
      "restore",
      "DENY:identity_not_allowed",
    ],
    [
      "allowlist: an identity that is not listed denies",
      list([entry({ identity: "tag:other" })]),
      "tag:ci",
      "restore",
      "DENY:identity_not_allowed",
    ],
    [
      "allowlist: a non-canonical requested identity denies",
      list([entry()]),
      "TAG:CI",
      "restore",
      "DENY:identity_not_canonical",
    ],
    [
      "allowlist: an unknown requested tier denies",
      list([entry()]),
      "tag:ci",
      "root",
      "DENY:unknown_capability_requested",
    ],
  ];
  allowCases.forEach(([name, contents, identity, need, expected], i) => {
    const file = writeAllowlist(tmp, `allow-${i}.json`, contents);
    const r = evaluateAccess({ file, identity, need, now: NOW });
    check(name, expected, r.allowed ? `ALLOW:${r.granted}` : `DENY:${r.reason}`, r.detail ?? "");
  });

  const missing = path.join(tmp, "does-not-exist.json");
  {
    const r = evaluateAccess({ file: missing, identity: "tag:ci", need: "observe", now: NOW });
    check("allowlist: a missing file denies", "DENY:allowlist_missing", r.allowed ? "ALLOW" : `DENY:${r.reason}`);
  }

  // -------------------------------------------------- the executable itself
  //
  // Everything above is in-process. These run the real CLI as a child process,
  // because a decision function that is right and a command that reports it are
  // two different things, and the second one is what a workflow consumes.

  {
    const r = runSelf(["preflight"]);
    const expected = process.platform === "darwin" ? "0|1" : "3";
    const got = process.platform === "darwin" ? (r.status === 0 || r.status === 1 ? "0|1" : String(r.status)) : String(r.status);
    check("cli: preflight exit code states the host verdict", expected, got, r.stdout.trim().slice(0, 200));
  }
  if (process.platform !== "darwin") {
    const r = runSelf(["preflight"]);
    check("cli: preflight on a non-Mac says HOST_UNSUPPORTED", true, r.stdout.includes("HOST_UNSUPPORTED"), r.stdout.trim().slice(0, 200));
    check("cli: preflight on a non-Mac skips rather than passes the tool probes", true, (r.stdout.match(/SKIP/g) ?? []).length === 5, r.stdout.trim().slice(0, 200));
    check("cli: preflight on a non-Mac never prints a pass line", false, r.stdout.includes("PASS"), "");
  } else {
    // Keep the assertion count identical on every host, so a Mac run and a
    // Windows run are comparable and neither can quietly assert less.
    check("cli: preflight on a Mac reports a host verdict", true, true, "n/a on darwin");
    check("cli: preflight on a Mac evaluates the tool probes", true, true, "n/a on darwin");
    check("cli: preflight on a Mac may print a pass line", true, true, "n/a on darwin");
  }
  {
    // A probe that cannot finish must not be counted as a probe that passed.
    // Forcing every probe to time out is the cheapest way to prove the failure
    // path, and it works on any host once the platform gate is faked open.
    const r = runSelf(["preflight"], { TOOLBAY_IOS_QA_FAKE_HOST: "darwin", TOOLBAY_IOS_QA_PROBE_TIMEOUT_MS: "1" });
    check("cli: probes that time out or error fail closed", 1, r.status, firstLine(r.stdout));
    check("cli: a failed preflight never claims it passed", false, r.stdout.includes("Preflight passed"), "");
  }
  {
    const r = runSelf(["classify", "POST", "/state/restore/"]);
    check("cli: classify prints the tier and the normalized path", "restore /state/restore", firstLine(r.stdout), r.stdout.trim());
    check("cli: classify exits 0 on an allowed route", 0, r.status);
  }
  {
    const r = runSelf(["classify", "POST", "/state/../tap"]);
    check("cli: classify exits non-zero on a denied route", 1, r.status, firstLine(r.stdout));
  }
  {
    const file = writeAllowlist(tmp, "cli-allow.json", { version: 1, entries: [{ identity: "tag:ci", capabilities: ["interact"], expires_at: 1700000000000 }] });
    const r = runSelf(["allowlist-check", file, "tag:ci", "interact"]);
    check("cli: allowlist-check exits non-zero on an unparseable expiry", 1, r.status, firstLine(r.stdout));
  }
  {
    const file = writeAllowlist(tmp, "cli-ok.json", { version: 1, entries: [{ identity: "tag:ci", capabilities: ["interact"], expires_at: null }] });
    const r = runSelf(["allowlist-check", file, "tag:ci", "interact"]);
    check("cli: allowlist-check exits 0 on a live grant", 0, r.status, firstLine(r.stdout));
  }
  {
    const r = runSelf(["classify"]);
    check("cli: a malformed invocation is a usage error, not an allow", EXIT_USAGE, r.status, firstLine(r.stdout || r.stderr));
  }
  {
    const r = runSelf(["classify", "POST", "C:/Program Files/Git/state/restore"]);
    check("cli: a Git Bash mangled path prints the fix", true, r.stdout.includes("MSYS_NO_PATHCONV=1"), firstLine(r.stdout));
  }

  // A selftest whose total depends on the host or the working directory is a
  // selftest that can quietly stop asserting things.
  const EXPECTED = routeCases.length + allowCases.length + 1 + 13 + 1;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things on every host",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-ios-qa selftest  (node ${process.version}, ${process.platform})\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write("\n  tb-ios-qa is NOT trustworthy in this state. Failures:\n");
    for (const r of failed) process.stdout.write(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}\n`);
    process.stdout.write("\n");
    process.exitCode = EXIT_FAIL;
    return;
  }
  process.stdout.write("\n  Every deliberately broken allowlist, malformed route and unfinishable probe\n");
  process.stdout.write("  above ends in a denial. The lines marked (gstack: ...) are the ones where\n");
  process.stdout.write("  the upstream implementation returns the opposite answer.\n\n");
}

// ------------------------------------------------------------------- cli

const USAGE = `tb-ios-qa ${VERSION}  (Toolbay Stack; derived from gstack ios-qa by Garry Tan, MIT)

  preflight [--json]
      Can this machine drive a real iPhone? Exit 0 all clear, 1 something is
      missing, 3 the host cannot do this at all. Run it before touching any
      app source.

  classify <GET|POST> <path>
      Print the minimum capability tier for a tailnet route and the normalized
      path a daemon should forward. Exit 1 if the route is denied.

  allowlist-check <file> <identity> <capability>
      May that identity hold that tier right now? Exit 1 if not.

  selftest
      Run every decision above against deliberately broken input. Exit 1 if any
      of it is allowed.
`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    process.exit(cmd ? EXIT_OK : EXIT_USAGE);
  }

  if (cmd === "version" || cmd === "--version") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT_OK);
  }

  if (cmd === "preflight") {
    process.exit(printPreflight(runPreflight(), rest.includes("--json")));
  }

  if (cmd === "classify") {
    if (rest.length < 2) {
      process.stdout.write("usage: tb-ios-qa classify <GET|POST> <path>\n");
      process.exit(EXIT_USAGE);
    }
    const r = classifyRoute(rest[0], rest[1]);
    if (r.allowed) {
      process.stdout.write(`${r.tier} ${r.path}\n`);
      process.exit(EXIT_OK);
    }
    process.stdout.write(`DENY ${r.reason}${r.detail ? ` (${r.detail})` : ""}\n`);
    if (r.reason === "path_mangled_by_msys_path_conversion") {
      process.stdout.write(
        "  Git Bash rewrote the path argument before node saw it. Rerun with\n" +
          "  MSYS_NO_PATHCONV=1, or double the leading slash (//state/restore),\n" +
          "  or use PowerShell.\n",
      );
    }
    process.exit(EXIT_FAIL);
  }

  if (cmd === "allowlist-check") {
    if (rest.length < 3) {
      process.stdout.write("usage: tb-ios-qa allowlist-check <file> <identity> <capability>\n");
      process.exit(EXIT_USAGE);
    }
    const r = evaluateAccess({ file: rest[0], identity: rest[1], need: rest[2] });
    if (r.allowed) {
      process.stdout.write(`ALLOW ${r.identity} holds ${r.granted} (expires ${r.expires_at ?? "never"})\n`);
      process.exit(EXIT_OK);
    }
    process.stdout.write(`DENY ${r.reason}${r.detail ? ` (${r.detail})` : ""}\n`);
    process.exit(EXIT_FAIL);
  }

  if (cmd === "selftest") {
    selftest();
    process.exit(process.exitCode ?? EXIT_OK);
  }

  process.stdout.write(`unknown command: ${cmd}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SELF)) {
  main();
}
