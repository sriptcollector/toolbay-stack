#!/usr/bin/env node
/**
 * tb-cookies.mjs: the Toolbay Stack browser-cookie import engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /setup-browser-cookies, importing a logged-in Chromium session into a
 * headless browse session, the browser registry and its aliases, the
 * `--domain` / `--profile` option semantics, the Chromium decryption pipeline
 * shape, and the Windows v20 -> CDP fallback idea) comes from
 * `setup-browser-cookies` and `browse/src/cookie-import-browser.ts` in gstack
 * by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Authenticated QA is the only kind that tests the product. Everything else
 * tests the marketing site. So the one job of this skill is to be able to say
 * "N cookies for domain X are in the session" and be RIGHT.
 *
 * gstack's version cannot say that on Windows, and worse, it says it anyway.
 * Measured against gstack 1.60.1.0 on Windows 11, Chrome 2026-08-13, the real
 * profile at %LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies
 * (1293 cookies, 397 hosts):
 *
 * 1. EXACT host_key MATCH, so the documented CLI path silently returns nothing.
 *
 *    gstack's SKILL.md tells you to run:
 *        $B cookie-import-browser chrome --domain github.com
 *    and cookie-import-browser.ts:267 builds
 *        WHERE host_key IN (?)   -- one exact string
 *
 *    Chromium stores domain-scoped cookies with a LEADING DOT. On this machine
 *    211 of 397 host_keys start with ".". `.netlify.com` holds 8 cookies and
 *    `netlify.com` holds 0, so `--domain netlify.com` matches zero rows.
 *    gstack's own CDP path DOES normalise the dot (cookie-import-browser.ts:963)
 *    which is how you can tell the SQL path forgot to.
 *
 * 2. ZERO ROWS DISABLES THE v20 FALLBACK, so the failure is silent.
 *
 *    write-commands.ts:709 gates the App-Bound-Encryption fallback on
 *        result.cookies.length === 0 && result.failed > 0
 *    `failed` only counts rows that were FETCHED and then failed to decrypt.
 *    Zero fetched rows means failed === 0, so the fallback never fires. The
 *    command then returns, verbatim:
 *        "Imported 0 cookies for netlify.com from chrome"
 *    exit code 0, no error, no warning. The skill's verification step is
 *    "run `$B cookies`, show the user a summary", which asserts nothing. An
 *    agent reading that transcript concludes the session is authenticated.
 *
 * 3. THE v20 DETECTOR SAMPLES 10 ROWS IN INSERTION ORDER.
 *
 *    cookie-import-browser.ts:1034:
 *        SELECT encrypted_value FROM cookies LIMIT 10
 *    No ORDER BY means rowid order, which is oldest first. A profile that
 *    predates Chrome 127 has v10 rows at the front, so hasV20Cookies() returns
 *    false on a database full of v20, and the fallback is disabled a second
 *    time. Reproduced as a fixture in `selftest`.
 *
 * 4. NOTHING IS PROVED. `importCookies` returns a count of objects held in
 *    memory. Nothing re-reads what was written, so a truncated or unwritable
 *    artifact still reports a healthy number.
 *
 * DESIGN RULES HERE
 *
 *   1. FAIL CLOSED. A count of zero for the domain you asked for is an ERROR
 *      with a named cause and a non-zero exit, never a clean line of output.
 *      Every route that cannot reach a confident count ends in a non-zero exit.
 *   2. THE NUMBER COMES OFF DISK. `import` writes the artifact, re-reads it,
 *      re-parses it, re-counts it and re-checks every cookie's domain against
 *      the request before printing "N cookies for domain X imported". The
 *      number printed is a property of a file that exists.
 *   3. NODE ONLY. No bash preamble, no bun, no `open`, no `/tmp`, no
 *      `date +%s`, no `find -mmin`, no `source <(...)`. Runs identically from
 *      PowerShell and Git Bash. node:sqlite ships with Node 22.5+.
 *   4. SAY WHAT CANNOT BE DONE. v20 App-Bound Encryption wraps the key in a
 *      SYSTEM-level DPAPI layer that an unelevated same-user process cannot
 *      peel. This tool does not pretend otherwise: it names v20, prints how
 *      many of your rows are v20, and routes to CDP, which decrypts inside the
 *      browser. If CDP is unavailable too, it exits non-zero and says why.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

let DatabaseSync = null;
let SQLITE_LOAD_ERROR = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (err) {
  SQLITE_LOAD_ERROR = err;
}

// ------------------------------------------------------------------ failure
//
// One exit path for everything that went wrong, so no caller has to guess
// whether a zero was a real zero. `code` is a stable machine-readable token;
// the message is for the human.

class CookieError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const fail = (code, message, hint) => {
  throw new CookieError(code, message, hint);
};

// ------------------------------------------------------------------ registry
//
// gstack's registry, kept so aliases behave the same for anyone moving over.
// Windows paths are first-class here rather than an afterthought, and every
// browser that exists on Windows carries its Windows exe locations so the CDP
// route is available to all of them, not only Chrome and Edge.

const BROWSERS = [
  {
    name: "Chrome",
    aliases: ["chrome", "google-chrome", "google-chrome-stable"],
    darwinDir: "Google/Chrome/",
    linuxDir: "google-chrome/",
    win32Dir: "Google/Chrome/User Data/",
    keychainService: "Chrome Safe Storage",
    linuxApplication: "chrome",
    win32Exe: ["Google/Chrome/Application/chrome.exe"],
  },
  {
    name: "Edge",
    aliases: ["edge", "msedge", "microsoft-edge"],
    darwinDir: "Microsoft Edge/",
    linuxDir: "microsoft-edge/",
    win32Dir: "Microsoft/Edge/User Data/",
    keychainService: "Microsoft Edge Safe Storage",
    linuxApplication: "microsoft-edge",
    win32Exe: ["Microsoft/Edge/Application/msedge.exe"],
  },
  {
    name: "Brave",
    aliases: ["brave"],
    darwinDir: "BraveSoftware/Brave-Browser/",
    linuxDir: "BraveSoftware/Brave-Browser/",
    win32Dir: "BraveSoftware/Brave-Browser/User Data/",
    keychainService: "Brave Safe Storage",
    linuxApplication: "brave",
    win32Exe: ["BraveSoftware/Brave-Browser/Application/brave.exe"],
  },
  {
    name: "Chromium",
    aliases: ["chromium"],
    darwinDir: "chromium/",
    linuxDir: "chromium/",
    win32Dir: "Chromium/User Data/",
    keychainService: "Chromium Safe Storage",
    linuxApplication: "chromium",
    win32Exe: ["Chromium/Application/chrome.exe"],
  },
  {
    name: "Comet",
    aliases: ["comet", "perplexity"],
    darwinDir: "Comet/",
    win32Dir: "Perplexity/Comet/User Data/",
    keychainService: "Comet Safe Storage",
    win32Exe: ["Perplexity/Comet/Application/comet.exe"],
  },
  {
    name: "Arc",
    aliases: ["arc"],
    darwinDir: "Arc/User Data/",
    win32Dir: "Packages/TheBrowserCompany.Arc/LocalCache/Local/Arc/User Data/",
    keychainService: "Arc Safe Storage",
    win32Exe: [],
  },
  {
    name: "Opera",
    aliases: ["opera"],
    darwinDir: "com.operasoftware.Opera/",
    linuxDir: "opera/",
    win32Dir: "Programs/Opera/User Data/",
    win32RoamingDir: "Opera Software/Opera Stable/",
    keychainService: "Opera Safe Storage",
    linuxApplication: "opera",
    win32Exe: ["Programs/Opera/opera.exe"],
  },
  {
    name: "Vivaldi",
    aliases: ["vivaldi"],
    darwinDir: "Vivaldi/",
    linuxDir: "vivaldi/",
    win32Dir: "Vivaldi/User Data/",
    keychainService: "Vivaldi Safe Storage",
    linuxApplication: "vivaldi",
    win32Exe: ["Vivaldi/Application/vivaldi.exe"],
  },
];

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === "win32";

function baseDir(platform) {
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (platform === "win32") return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(os.homedir(), ".config");
}

function roamingDir() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

/** Every root directory this browser might keep profiles under, on this host. */
function userDataDirs(browser) {
  const out = [];
  if (IS_WIN) {
    if (browser.win32Dir) out.push(path.join(baseDir("win32"), ...browser.win32Dir.split("/").filter(Boolean)));
    if (browser.win32RoamingDir) out.push(path.join(roamingDir(), ...browser.win32RoamingDir.split("/").filter(Boolean)));
  } else if (PLATFORM === "darwin") {
    if (browser.darwinDir) out.push(path.join(baseDir("darwin"), ...browser.darwinDir.split("/").filter(Boolean)));
  } else {
    if (browser.linuxDir) out.push(path.join(baseDir("linux"), ...browser.linuxDir.split("/").filter(Boolean)));
  }
  return out;
}

function resolveBrowser(nameOrAlias) {
  const needle = String(nameOrAlias || "").toLowerCase().trim();
  if (!needle) fail("bad_request", "no browser given");
  const found = BROWSERS.find((b) => b.aliases.includes(needle) || b.name.toLowerCase() === needle);
  if (!found) {
    fail(
      "unknown_browser",
      `unknown browser "${nameOrAlias}"`,
      `supported: ${BROWSERS.flatMap((b) => b.aliases).join(", ")}`,
    );
  }
  return found;
}

/**
 * A profile directory name is pasted into a filesystem path, so it is checked
 * rather than trusted. gstack checks this too; it is kept because it is right.
 */
function validateProfile(profile) {
  if (typeof profile !== "string" || !profile.trim()) fail("bad_request", "profile name is empty");
  if (/[/\\]|\.\./.test(profile) || /[\u0000-\u001f]/.test(profile)) {
    fail("bad_request", `invalid profile name "${profile}"`, "profile names cannot contain separators, .., or control characters");
  }
}

/**
 * Chrome 80+ moved the cookie DB to <profile>/Network/Cookies. Both locations
 * are checked, newest first, on every platform rather than only on Windows:
 * the move was not Windows-specific and a mac profile created after the move
 * has the same layout.
 */
function cookieDbCandidates(profileDir) {
  return [path.join(profileDir, "Network", "Cookies"), path.join(profileDir, "Cookies")];
}

function findProfiles(browser) {
  const found = [];
  for (const root of userDataDirs(browser)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name !== "Default" && !/^Profile \d+$/.test(e.name) && e.name !== "Guest Profile") continue;
      const profileDir = path.join(root, e.name);
      const db = cookieDbCandidates(profileDir).find((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (!db) continue;
      let label = e.name;
      try {
        const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, "Preferences"), "utf8"));
        const email = prefs?.account_info?.[0]?.email;
        label = (typeof email === "string" && email) || (typeof prefs?.profile?.name === "string" && prefs.profile.name) || e.name;
      } catch {
        /* the directory name is a fine label */
      }
      found.push({ profile: e.name, label, dir: profileDir, db, root, size: safeSize(db) });
    }
  }
  return found;
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function findProfile(browser, profile) {
  validateProfile(profile);
  const all = findProfiles(browser);
  const hit = all.find((p) => p.profile === profile);
  if (hit) return hit;
  const roots = userDataDirs(browser);
  if (!roots.length) {
    fail("not_installed", `${browser.name} has no known profile location on ${PLATFORM}`);
  }
  fail(
    "not_installed",
    `no cookie database for ${browser.name} profile "${profile}"`,
    all.length
      ? `profiles that DO have one: ${all.map((p) => p.profile).join(", ")}`
      : `looked under ${roots.join(" and ")}`,
  );
}

// -------------------------------------------------------------- sqlite access
//
// Chrome holds the cookie DB open, so it is always copied first. The copy also
// takes -wal, -shm and -journal, and is then opened READ-WRITE, which is the
// part gstack's comment promises ("so we can open read-write and process the
// WAL") and its code does not do (it passes readonly: true, and a readonly
// connection cannot replay a WAL, so cookies that live only in the WAL are
// invisible). Writing to a throwaway copy costs nothing and is what makes the
// WAL replay legal.

function tempPath(prefix, ext = ".db") {
  const dir = process.env.TOOLBAY_COOKIES_TMP || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${crypto.randomUUID()}${ext}`);
}

function openCookieDb(dbPath) {
  if (!DatabaseSync) {
    fail(
      "no_sqlite",
      `node:sqlite is unavailable on this Node (${process.version}): ${SQLITE_LOAD_ERROR?.message ?? "unknown"}`,
      "node:sqlite ships with Node 22.5 and later. Upgrade Node, or use the cdp route which needs no SQLite at all.",
    );
  }
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (err) {
    fail("db_missing", `cookie database not found at ${dbPath} (${err.code || err.message})`);
  }
  if (!stat.isFile() || stat.size === 0) {
    fail("db_missing", `cookie database at ${dbPath} is ${stat.size === 0 ? "empty" : "not a file"}`);
  }

  const copy = tempPath("tb-cookies");
  const sidecars = [];
  try {
    fs.copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(dbPath + suffix)) {
        fs.copyFileSync(dbPath + suffix, copy + suffix);
        sidecars.push(copy + suffix);
      }
    }
  } catch (err) {
    cleanup([copy, ...sidecars]);
    fail(
      "db_locked",
      `could not copy the cookie database (${err.code || err.message})`,
      "close the browser and try again, or check that the profile path is readable",
    );
  }

  let db;
  try {
    db = new DatabaseSync(copy); // read-write on the COPY, so a WAL can be replayed
  } catch (err) {
    cleanup([copy, ...sidecars]);
    const msg = String(err?.message || err);
    if (/corrupt|malformed|not a database/i.test(msg)) {
      fail("db_corrupt", `the cookie database copy is unreadable: ${msg}`);
    }
    fail("db_open_failed", `could not open the cookie database copy: ${msg}`);
  }

  // A file that opens but has no cookies table is not an empty cookie jar, it
  // is the wrong file. Say so instead of returning zero rows.
  try {
    db.prepare("SELECT 1 FROM cookies LIMIT 1").get();
  } catch (err) {
    db.close();
    cleanup([copy, ...sidecars]);
    fail("db_not_cookies", `${dbPath} has no readable "cookies" table (${err.message})`);
  }

  const close = () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    cleanup([copy, ...sidecars]);
  };
  return { db, close, copy };
}

function cleanup(paths) {
  for (const p of paths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// ------------------------------------------------------------ domain matching
//
// THE FIX FOR gstack ISSUE 1. A request for "netlify.com" has to reach the rows
// Chromium actually stored, which are "netlify.com", ".netlify.com" and, unless
// you say otherwise, "app.netlify.com".

function normaliseDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  if (!d) fail("bad_request", "no domain given");
  if (d.includes("://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      fail("bad_request", `"${input}" is not a domain or a URL`);
    }
  }
  d = d.replace(/^\.+/, "").replace(/\.+$/, "").replace(/:\d+$/, "").replace(/\/.*$/, "");
  if (!d || !/^[a-z0-9._-]+$/.test(d)) {
    fail("bad_request", `"${input}" does not look like a hostname`);
  }
  return d;
}

/** The host_key forms a request should match, and the SQL that matches them. */
function domainMatcher(domain, { exact = false } = {}) {
  const bare = normaliseDomain(domain);
  const dotted = `.${bare}`;
  if (exact) {
    return {
      bare,
      forms: [bare, dotted],
      where: "(host_key = ? OR host_key = ?)",
      params: [bare, dotted],
      test: (host) => host === bare || host === dotted,
      describe: `host_key = "${bare}" or "${dotted}"`,
    };
  }
  // ESCAPE so a domain containing % or _ cannot widen the match. Real hostnames
  // cannot contain them, but the check costs one character and a hand-typed
  // "--domain %" should match nothing rather than everything.
  const suffix = `%.${bare.replace(/([%_\\])/g, "\\$1")}`;
  return {
    bare,
    forms: [bare, dotted, `*.${bare}`],
    where: "(host_key = ? OR host_key = ? OR host_key LIKE ? ESCAPE '\\')",
    params: [bare, dotted, suffix],
    test: (host) => {
      const h = String(host || "").toLowerCase();
      return h === bare || h === dotted || h.endsWith(`.${bare}`);
    },
    describe: `host_key = "${bare}", "${dotted}", or any subdomain of "${bare}"`,
  };
}

// ---------------------------------------------------------- chromium epoch

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;
const chromiumNow = () => BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;

function chromiumEpochToUnix(epoch, hasExpires) {
  if (!hasExpires || epoch === 0 || epoch === 0n) return -1;
  const micro = BigInt(epoch) - CHROMIUM_EPOCH_OFFSET;
  if (micro <= 0n) return -1;
  return Number(micro / 1000000n);
}

const SAME_SITE = { 0: "None", 1: "Lax", 2: "Strict" };
const mapSameSite = (v) => SAME_SITE[v] ?? "Lax";

// ------------------------------------------------------------------- census
//
// THE FIX FOR gstack ISSUE 3. Every row, not the first ten in insertion order.
// The census is the thing that decides the route, so sampling it is how you get
// the route wrong on a profile older than Chrome 127.

function censusOf(db, matcher = null) {
  const sql = matcher
    ? `SELECT host_key, value, encrypted_value FROM cookies WHERE ${matcher.where}`
    : "SELECT host_key, value, encrypted_value FROM cookies";
  const rows = matcher ? db.prepare(sql).all(...matcher.params) : db.prepare(sql).all();
  const counts = { v10: 0, v11: 0, v20: 0, plaintext: 0, empty: 0, other: 0 };
  const hosts = new Map();
  for (const r of rows) {
    const ev = toBuffer(r.encrypted_value);
    const prefix = ev.length >= 3 ? ev.subarray(0, 3).toString("latin1") : null;
    if (prefix === "v10") counts.v10 += 1;
    else if (prefix === "v11") counts.v11 += 1;
    else if (prefix === "v20") counts.v20 += 1;
    else if (typeof r.value === "string" && r.value.length > 0) counts.plaintext += 1;
    else if (ev.length === 0) counts.empty += 1;
    else counts.other += 1;
    hosts.set(r.host_key, (hosts.get(r.host_key) || 0) + 1);
  }
  return { total: rows.length, counts, hosts };
}

function toBuffer(v) {
  if (v === null || v === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, "binary");
  return Buffer.alloc(0);
}

// ------------------------------------------------------------ key derivation

const keyCache = new Map();

function localStatePath(browser) {
  for (const root of userDataDirs(browser)) {
    const p = path.join(root, "Local State");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readLocalState(browser) {
  const p = localStatePath(browser);
  if (!p) return { error: `no "Local State" file for ${browser.name}` };
  try {
    return { path: p, json: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { path: p, error: `"Local State" at ${p} could not be parsed (${err.message})` };
  }
}

/**
 * DPAPI unprotect, without building a multi-statement PowerShell -Command
 * string. The script goes to a file and runs under -File, which is the shape
 * that survives every quoting layer on Windows. If -File is refused by
 * execution policy the -Command form is tried as a fallback, and if BOTH fail
 * the caller gets both stderr streams rather than an empty string that would
 * read as "no key".
 */
function dpapiUnprotect(encrypted) {
  if (!IS_WIN) fail("not_supported", "DPAPI only exists on Windows");
  const b64 = encrypted.toString("base64");
  const body = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$stdin = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [System.Convert]::FromBase64String($stdin)",
    "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([System.Convert]::ToBase64String($dec))",
  ];
  const scriptFile = tempPath("tb-dpapi", ".ps1");
  fs.writeFileSync(scriptFile, `${body.join("\r\n")}\r\n`, "utf8");
  const attempts = [
    ["powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile]],
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command", body.join("; ")]],
  ];
  const errors = [];
  try {
    for (const [exe, args] of attempts) {
      const res = spawnSync(exe, args, { input: b64, encoding: "utf8", timeout: 20000, windowsHide: true });
      if (res.error) {
        errors.push(`${exe}: ${res.error.message}`);
        continue;
      }
      const out = (res.stdout || "").trim();
      if (res.status !== 0 || !out) {
        errors.push(`${exe} exit ${res.status}: ${(res.stderr || "").trim().slice(0, 300) || "no output"}`);
        continue;
      }
      let decoded;
      try {
        decoded = Buffer.from(out, "base64");
      } catch (err) {
        errors.push(`${exe}: output was not base64 (${err.message})`);
        continue;
      }
      // Base64.decode never throws on junk, it returns a short buffer. An AES
      // key is 32 bytes; anything shorter is a decode of an error message.
      if (decoded.length < 16) {
        errors.push(`${exe}: decoded ${decoded.length} bytes, too short to be an AES key`);
        continue;
      }
      return decoded;
    }
  } finally {
    cleanup([scriptFile]);
  }
  fail("dpapi_failed", `DPAPI could not unprotect the browser key. ${errors.join(" | ")}`);
}

function runCapture(cmd, args, { input, timeout = 10000 } = {}) {
  const res = spawnSync(cmd, args, { input, encoding: "utf8", timeout, windowsHide: true });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
    error: res.error ? res.error.message : null,
  };
}

/**
 * @returns {{keys: Map<string,Buffer>, notes: string[]}}
 * Throws rather than returning an empty map, because "I have no keys" and
 * "there was nothing to decrypt" must not look the same to the caller.
 */
function deriveKeys(browser, override) {
  if (override) return { keys: new Map([["v10", override], ["v11", override]]), notes: ["key supplied on the command line"] };

  const cached = keyCache.get(browser.name);
  if (cached) return cached;

  const notes = [];
  const keys = new Map();

  if (IS_WIN) {
    const ls = readLocalState(browser);
    if (ls.error) fail("key_unavailable", ls.error, "the browser has never been run, or the profile lives somewhere else");
    const b64 = ls.json?.os_crypt?.encrypted_key;
    if (typeof b64 !== "string" || !b64) {
      fail("key_unavailable", `no os_crypt.encrypted_key in ${ls.path}`);
    }
    const raw = Buffer.from(b64, "base64");
    if (raw.subarray(0, 5).toString("latin1") !== "DPAPI") {
      fail("key_unavailable", `os_crypt.encrypted_key in ${ls.path} does not start with the DPAPI marker`);
    }
    keys.set("v10", dpapiUnprotect(raw.subarray(5)));
    notes.push("v10 key: DPAPI(CurrentUser) over os_crypt.encrypted_key");
  } else if (PLATFORM === "darwin") {
    const res = runCapture("security", ["find-generic-password", "-s", browser.keychainService, "-w"]);
    if (!res.ok || !res.stdout) {
      const low = res.stderr.toLowerCase();
      if (low.includes("denied") || low.includes("user canceled") || low.includes("interaction not allowed")) {
        fail("keychain_denied", `Keychain access denied for "${browser.keychainService}"`, 'click Allow in the macOS dialog, then run this again');
      }
      fail("key_unavailable", `no Keychain entry for "${browser.keychainService}" (${res.stderr || res.error || `exit ${res.status}`})`);
    }
    keys.set("v10", crypto.pbkdf2Sync(res.stdout, "saltysalt", 1003, 16, "sha1"));
    notes.push("v10 key: PBKDF2(Keychain password, saltysalt, 1003)");
  } else {
    keys.set("v10", crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"));
    notes.push('v10 key: PBKDF2("peanuts", saltysalt, 1)');
    const attempts = [["secret-tool", "lookup", "Title", browser.keychainService]];
    if (browser.linuxApplication) {
      attempts.push(["secret-tool", "lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", browser.linuxApplication]);
      attempts.push(["secret-tool", "lookup", "xdg:schema", "chrome_libsecret_os_crypt_password", "application", browser.linuxApplication]);
    }
    for (const cmd of attempts) {
      const res = runCapture(cmd[0], cmd.slice(1), { timeout: 5000 });
      if (res.ok && res.stdout) {
        keys.set("v11", crypto.pbkdf2Sync(res.stdout, "saltysalt", 1, 16, "sha1"));
        notes.push("v11 key: PBKDF2(libsecret password, saltysalt, 1)");
        break;
      }
    }
    if (!keys.has("v11")) notes.push("v11 key: UNAVAILABLE (secret-tool returned nothing); v11 rows will be reported as failures, not skipped");
  }

  const result = { keys, notes };
  keyCache.set(browser.name, result);
  return result;
}

// ------------------------------------------------------------------- decrypt

function decryptRow(row, keys) {
  const ev = toBuffer(row.encrypted_value);
  if (ev.length === 0) {
    if (typeof row.value === "string" && row.value.length > 0) return { ok: true, value: row.value, scheme: "plaintext" };
    return { ok: false, reason: "empty", detail: "no encrypted_value and no plaintext value" };
  }
  const prefix = ev.subarray(0, 3).toString("latin1");

  if (prefix === "v20") {
    return {
      ok: false,
      reason: "v20",
      detail: "App-Bound Encryption: the key is wrapped in a SYSTEM-level DPAPI layer this process cannot peel",
    };
  }

  const key = keys.get(prefix);
  if (!key) {
    // Not a "skip". A row we cannot read is a row we must not silently drop.
    return { ok: false, reason: "no_key", detail: `no ${prefix} key was derived on this host` };
  }

  try {
    if (IS_WIN && (prefix === "v10" || prefix === "v11")) {
      // Windows: v10(3) + nonce(12) + ciphertext + tag(16), AES-256-GCM
      if (ev.length < 3 + 12 + 16) return { ok: false, reason: "truncated", detail: `${ev.length} bytes is too short for a GCM record` };
      const nonce = ev.subarray(3, 15);
      const tag = ev.subarray(ev.length - 16);
      const body = ev.subarray(15, ev.length - 16);
      const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
      d.setAuthTag(tag);
      const out = Buffer.concat([d.update(body), d.final()]);
      return { ok: true, value: out.toString("utf8"), scheme: `${prefix}-gcm` };
    }
    // macOS / Linux: v10|v11(3) + ciphertext, AES-128-CBC, IV = 16 spaces,
    // then 32 bytes of Chromium metadata in front of the value.
    const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([d.update(ev.subarray(3)), d.final()]);
    const body = plain.length > 32 ? plain.subarray(32) : plain;
    return { ok: true, value: body.toString("utf8"), scheme: `${prefix}-cbc` };
  } catch (err) {
    return { ok: false, reason: "decrypt_failed", detail: err.message };
  }
}

function toPlaywrightCookie(row, value) {
  return {
    name: String(row.name),
    value,
    domain: String(row.host_key),
    path: String(row.path || "/"),
    expires: chromiumEpochToUnix(row.expires_utc, Number(row.has_expires)),
    httpOnly: Number(row.is_httponly) === 1,
    secure: Number(row.is_secure) === 1,
    sameSite: mapSameSite(Number(row.samesite)),
  };
}

// ---------------------------------------------------------------- db route

function importViaDb({ dbPath, browser, matcher, keyOverride, includeExpired }) {
  const { db, close } = openCookieDb(dbPath);
  try {
    const now = chromiumNow();
    const expiryClause = includeExpired ? "" : " AND (has_expires = 0 OR expires_utc > ?)";
    const params = includeExpired ? [...matcher.params] : [...matcher.params, now];
    const stmt = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
         FROM cookies
        WHERE ${matcher.where}${expiryClause}
        ORDER BY host_key, name`,
    );
    // Chromium's expires_utc is microseconds since 1601, which is past
    // Number.MAX_SAFE_INTEGER. Reading it as a JS number throws RangeError, so
    // every integer column comes back as a BigInt and is narrowed on use.
    stmt.setReadBigInts(true);
    const rows = stmt.all(...params);

    const census = censusOf(db, matcher);
    const cookies = [];
    const failures = {};
    for (const row of rows) {
      const keys = browser ? deriveKeysLazily(browser, keyOverride, rows) : new Map();
      const res = decryptRow(row, keys);
      if (res.ok && res.value.length > 0) {
        cookies.push(toPlaywrightCookie(row, res.value));
      } else if (res.ok) {
        // A cookie whose value decrypts to the empty string is not a working
        // session cookie. It is counted as a failure, not as a success, so the
        // headline number cannot be padded with blanks.
        failures.empty_value = (failures.empty_value || 0) + 1;
      } else {
        failures[res.reason] = (failures[res.reason] || 0) + 1;
      }
    }
    return { cookies, failures, rowsMatched: rows.length, census };
  } finally {
    close();
  }
}

/**
 * Keys are derived only once a row that needs them exists. On an all-v20
 * profile that means no PowerShell process is spawned at all, and on a profile
 * with nothing matching the domain the user is never prompted for a Keychain
 * password for a query that was going to return nothing.
 */
let lazyKeys = null;
function deriveKeysLazily(browser, override, rows) {
  if (lazyKeys) return lazyKeys.keys;
  const needsKey = rows.some((r) => {
    const ev = toBuffer(r.encrypted_value);
    if (ev.length < 3) return false;
    const p = ev.subarray(0, 3).toString("latin1");
    return p === "v10" || p === "v11";
  });
  if (!needsKey) {
    lazyKeys = { keys: new Map(), notes: ["no v10/v11 rows matched, so no key was derived"] };
    return lazyKeys.keys;
  }
  lazyKeys = deriveKeys(browser, override);
  return lazyKeys.keys;
}

// --------------------------------------------------------------- cdp route
//
// The only route that can read v20. The browser decrypts its own cookies, so
// Network.getAllCookies returns plaintext. It needs the REAL user-data-dir,
// because the App-Bound key is bound to it, and it needs the browser closed,
// because of the profile lock.
//
// MEASURED 2026-08-13, Chrome 151.0.7922.138 on Windows 11: this route is now
// blocked by Chrome itself, and both of the obvious ways around it are dead
// ends. Chrome refuses --remote-debugging-port when --user-data-dir points at
// the default profile:
//
//   "DevTools remote debugging requires a non-default data directory.
//    Specify this using --user-data-dir."
//
// and it never opens the port, so gstack's fallback here fails with its own
// generic "did not start within 15s" and no cause. Mirroring the profile to a
// scratch directory (Local State + Default/Network/Cookies) DOES get the port
// open, and Network.getAllCookies then returns 0 cookies out of 1293, because
// the App-Bound key does not validate outside its original path. Both were
// tried; neither is offered here as a working route, because a route that
// returns an empty list would be indistinguishable from a profile with no
// cookies, which is the exact failure this skill exists to remove.
//
// So on current Chrome the honest answer is: attach to a browser you launched
// with the debug flag yourself, or use a browser whose profile is still v10.
// The code below stays, because it still works on Edge/Comet/older Chrome, and
// because it surfaces the browser's OWN stderr line when it does not.

function findBrowserExe(browser) {
  if (!IS_WIN) return null;
  const roots = [
    process.env.PROGRAMFILES || "C:\\Program Files",
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
    baseDir("win32"),
  ];
  for (const rel of browser.win32Exe || []) {
    for (const root of roots) {
      const p = path.join(root, ...rel.split("/"));
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function browserIsRunning(exePath) {
  if (!IS_WIN) return false;
  const image = path.basename(exePath);
  const res = runCapture("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], { timeout: 15000 });
  // tasklist prints "INFO: No tasks are running..." on no match, and never
  // fails. If the probe itself broke we return TRUE, because launching a second
  // instance against a live profile is the outcome to avoid.
  if (!res.ok) return true;
  return res.stdout.toLowerCase().includes(image.toLowerCase());
}

async function importViaCdp({ browser, profile, matcher, timeoutMs = 30000 }) {
  const exe = findBrowserExe(browser);
  if (!exe) {
    fail(
      "no_browser_exe",
      `cannot find the ${browser.name} executable, so the CDP route is unavailable`,
      "install it, or connect an already-running browser over CDP instead",
    );
  }
  if (browserIsRunning(exe)) {
    fail(
      "browser_running",
      `${browser.name} is running, so its profile is locked`,
      `close every ${path.basename(exe)} window and run this again. The App-Bound key is bound to the real profile path, so a copy cannot be used.`,
    );
  }
  const prof = findProfile(browser, profile);
  const userDataDir = prof.root;

  const port = 9500 + Math.floor(Math.random() * 400);
  const { spawn } = await import("node:child_process");
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--window-size=800,600",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let childExit = null;
  child.on("exit", (code) => {
    childExit = code;
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c).slice(0, 4000);
  });

  const kill = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    if (IS_WIN) {
      // --headless=new leaves helper processes behind if only the parent is
      // signalled. A stray headless browser holding the profile lock is
      // exactly the state that makes the NEXT run fail, so it is cleaned up.
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let wsUrl = null;
    let versionLine = null;
    while (Date.now() < deadline) {
      if (childExit !== null) {
        fail("cdp_exited", `${browser.name} exited with code ${childExit} before the debug port came up`, salientStderr(stderr) || undefined);
      }
      try {
        if (!versionLine) {
          const v = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
          if (v?.Browser) versionLine = v.Browser;
        }
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500);
        const page = Array.isArray(list) ? list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    if (!wsUrl) {
      fail(
        "cdp_timeout",
        `${browser.name} did not expose a CDP page target within ${Math.round(timeoutMs / 1000)}s`,
        salientStderr(stderr) || undefined,
      );
    }

    const all = await cdpGetAllCookies(wsUrl, 20000);
    const cookies = [];
    for (const c of all) {
      if (!matcher.test(c.domain)) continue;
      if (typeof c.value !== "string" || c.value.length === 0) continue;
      cookies.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: typeof c.expires === "number" && c.expires > 0 ? Math.floor(c.expires) : -1,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax",
      });
    }
    return { cookies, failures: {}, rowsMatched: cookies.length, browserVersion: versionLine, totalSeen: all.length };
  } finally {
    kill();
  }
}

/**
 * A headless Chromium writes GPU, USB and TensorFlow noise to stderr on every
 * launch. The one line that explains a failed launch is buried in it, and a
 * blind slice(0, 300) shows the noise instead, which is how a precise refusal
 * ("requires a non-default data directory") turns back into a shrug.
 */
function salientStderr(text) {
  const noise = /device_event_log|XNNPACK|TensorFlow|GPU |gpu_|Registration response error|voice_transcription|dxdiag/i;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !noise.test(l));
  const preferred = lines.find((l) => /data directory|user-data-dir|profile|lock|denied|not allowed|cannot|failed/i.test(l));
  return (preferred || lines[0] || "").slice(0, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function cdpGetAllCookies(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new CookieError("cdp_timeout", `CDP did not answer Network.getAllCookies within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
    ws.onerror = (e) => finish(reject, new CookieError("cdp_error", `CDP socket error: ${e?.message || "unknown"}`));
    ws.onclose = () => finish(reject, new CookieError("cdp_closed", "CDP socket closed before returning cookies"));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error) return finish(reject, new CookieError("cdp_error", `Network.enable failed: ${msg.error.message}`));
        return ws.send(JSON.stringify({ id: 2, method: "Network.getAllCookies" }));
      }
      if (msg.id === 2) {
        if (msg.error) return finish(reject, new CookieError("cdp_error", `Network.getAllCookies failed: ${msg.error.message}`));
        const list = msg.result?.cookies;
        if (!Array.isArray(list)) return finish(reject, new CookieError("cdp_error", "Network.getAllCookies returned no cookie array"));
        return finish(resolve, list);
      }
    };
  });
}

// ----------------------------------------------------------------- artifact
//
// RULE 2. The number in the success line is counted off the file, after the
// file has been written, re-read and re-parsed. If the write silently produced
// nothing, or produced something that does not parse, that is a failure and not
// a smaller number.

function writeAndVerify(outPath, cookies, matcher, meta) {
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(cookies, null, 2)}\n`, "utf8");
  const metaPath = `${abs}.meta.json`;
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const check = verifyArtifact(abs, matcher);
  if (!check.ok) fail("artifact_unverified", `wrote ${abs} but could not verify it: ${check.error}`);
  return { path: abs, metaPath, count: check.count, domains: check.domains };
}

function verifyArtifact(file, matcher) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read ${file} (${err.code || err.message})` };
  }
  if (!raw.trim()) return { ok: false, error: `${file} is empty` };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${file} is not valid JSON (${err.message})` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `${file} is not a JSON array of cookies` };

  const domains = new Set();
  for (const [i, c] of parsed.entries()) {
    if (!c || typeof c !== "object") return { ok: false, error: `entry ${i} is not an object` };
    if (typeof c.name !== "string" || !c.name) return { ok: false, error: `entry ${i} has no name` };
    if (typeof c.value !== "string" || !c.value) return { ok: false, error: `entry ${i} ("${c.name}") has an empty value` };
    if (typeof c.domain !== "string" || !c.domain) return { ok: false, error: `entry ${i} ("${c.name}") has no domain` };
    if (matcher && !matcher.test(c.domain)) {
      return { ok: false, error: `entry ${i} ("${c.name}") is for ${c.domain}, which is not ${matcher.describe}` };
    }
    domains.add(c.domain);
  }
  return { ok: true, count: parsed.length, domains: [...domains].sort() };
}

// ------------------------------------------------------------------ commands

function cmdBrowsers() {
  const rows = [];
  for (const b of BROWSERS) {
    const profiles = findProfiles(b);
    if (!profiles.length) continue;
    rows.push({ browser: b.name, alias: b.aliases[0], profiles });
  }
  if (!rows.length) {
    out(`No Chromium browser profile with a cookie database was found on this ${PLATFORM} host.`);
    out(`Looked under: ${BROWSERS.flatMap(userDataDirs).join(", ") || "(no known locations)"}`);
    return 1;
  }
  for (const r of rows) {
    out(`${r.browser}  (--browser ${r.alias})`);
    for (const p of r.profiles) {
      out(`   ${p.profile.padEnd(12)} ${p.label.padEnd(34)} ${fmtBytes(p.size).padStart(9)}  ${p.db}`);
    }
  }
  return 0;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cmdScan(opts) {
  const browser = resolveBrowser(opts.browser);
  // Validated even on the --db path. findProfile() does this for the normal
  // path, so routing around it must not also route around the check: the
  // profile string is recorded in the artifact and passed to the browser as
  // --profile-directory on the cdp route.
  validateProfile(opts.profile);
  const prof = opts.db ? { db: path.resolve(opts.db), profile: opts.profile, label: "(--db)" } : findProfile(browser, opts.profile);
  const { db, close } = openCookieDb(prof.db);
  let all;
  let scoped = null;
  let matcher = null;
  try {
    all = censusOf(db);
    if (opts.domain) {
      matcher = domainMatcher(opts.domain, { exact: opts.exact });
      scoped = censusOf(db, matcher);
    }
  } finally {
    close();
  }

  out(`${browser.name} / ${prof.profile}   ${prof.db}`);
  out(`  ${all.total} cookies across ${all.hosts.size} hosts`);
  out(`  encryption (every row, not a sample): ${fmtCensus(all.counts)}`);

  if (matcher) {
    out("");
    out(`  ${matcher.describe}`);
    out(`    matched ${scoped.total} rows across ${scoped.hosts.size} hosts: ${fmtCensus(scoped.counts)}`);
    const exactOnly = [...all.hosts.entries()].filter(([h]) => h === matcher.bare);
    const dotted = [...all.hosts.entries()].filter(([h]) => h === `.${matcher.bare}`);
    out(`    host_key "${matcher.bare}": ${exactOnly[0]?.[1] ?? 0} rows`);
    out(`    host_key ".${matcher.bare}": ${dotted[0]?.[1] ?? 0} rows`);
    if ((exactOnly[0]?.[1] ?? 0) === 0 && scoped.total > 0) {
      out(`    NOTE: an exact host_key match on "${matcher.bare}" would return 0 rows here.`);
    }
  }

  const route = decideRoute(scoped ?? all);
  out("");
  out(`  route: ${route.route}`);
  out(`  ${route.why}`);
  if (route.route === "cdp" && IS_WIN) {
    const exe = findBrowserExe(browser);
    out(`  ${browser.name} executable: ${exe || "NOT FOUND"}`);
    if (exe) out(`  ${browser.name} currently running: ${browserIsRunning(exe) ? "yes (close it before importing)" : "no"}`);
  }
  return scoped && scoped.total === 0 ? 1 : 0;
}

function fmtCensus(c) {
  const parts = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  return parts.length ? parts.join(" ") : "none";
}

function decideRoute(census) {
  const { counts, total } = census;
  if (total === 0) {
    return { route: "none", why: "no rows matched, so there is nothing to decrypt by any route" };
  }
  const decryptable = counts.v10 + counts.v11 + counts.plaintext;
  if (counts.v20 > 0 && decryptable === 0) {
    return { route: "cdp", why: `all ${counts.v20} matching rows use v20 App-Bound Encryption, which only the browser process can decrypt` };
  }
  if (counts.v20 > 0) {
    return { route: "db+cdp", why: `${decryptable} rows are readable from disk and ${counts.v20} are v20; the db route will return the readable ones and report the rest` };
  }
  return { route: "db", why: `${decryptable} matching rows use a scheme this process can decrypt directly` };
}

async function cmdImport(opts) {
  if (!opts.domain) fail("bad_request", "--domain is required", "run `scan` first if you do not know which domains are in the profile");
  const browser = resolveBrowser(opts.browser);
  validateProfile(opts.profile); // also on the --db path; see cmdScan
  const matcher = domainMatcher(opts.domain, { exact: opts.exact });
  const min = Number.isFinite(opts.min) ? opts.min : 1;
  const wantRoute = opts.route || "auto";
  if (!["auto", "db", "cdp"].includes(wantRoute)) fail("bad_request", `--route must be auto, db, or cdp (got "${wantRoute}")`);

  const prof = opts.db ? { db: path.resolve(opts.db), profile: opts.profile, root: null } : findProfile(browser, opts.profile);
  const keyOverride = opts.keyHex ? Buffer.from(opts.keyHex, "hex") : null;
  if (opts.keyHex && keyOverride.length !== 32 && keyOverride.length !== 16) {
    fail("bad_request", `--key-hex decoded to ${keyOverride.length} bytes; expected 16 or 32`);
  }

  const attempts = [];
  let result = null;
  let usedRoute = null;

  if (wantRoute === "auto" || wantRoute === "db") {
    try {
      const r = importViaDb({ dbPath: prof.db, browser, matcher, keyOverride, includeExpired: opts.includeExpired });
      attempts.push({ route: "db", cookies: r.cookies.length, rows: r.rowsMatched, failures: r.failures, census: r.census });
      if (r.cookies.length > 0) {
        result = r;
        usedRoute = "db";
      } else if (wantRoute === "db") {
        failZero("db", r, matcher, browser, prof);
      }
    } catch (err) {
      if (wantRoute === "db" || !(err instanceof CookieError)) throw err;
      attempts.push({ route: "db", error: `${err.code}: ${err.message}` });
    }
  }

  if (!result && (wantRoute === "auto" || wantRoute === "cdp")) {
    if (!IS_WIN && wantRoute === "cdp") fail("not_supported", "the cdp route is implemented for Windows only");
    if (IS_WIN) {
      try {
        const r = await importViaCdp({ browser, profile: opts.profile, matcher });
        attempts.push({ route: "cdp", cookies: r.cookies.length, seen: r.totalSeen, version: r.browserVersion });
        if (r.cookies.length > 0) {
          result = r;
          usedRoute = "cdp";
        }
      } catch (err) {
        if (!(err instanceof CookieError)) throw err;
        attempts.push({ route: "cdp", error: `${err.code}: ${err.message}`, hint: err.hint });
      }
    }
  }

  if (!result) {
    const last = attempts[attempts.length - 1];
    const dbAttempt = attempts.find((a) => a.route === "db");
    err(`FAILED: 0 cookies for ${matcher.describe} from ${browser.name}/${opts.profile}.`);
    for (const a of attempts) {
      if (a.error) err(`  route ${a.route}: ${a.error}${a.hint ? ` -- ${a.hint}` : ""}`);
      else err(`  route ${a.route}: matched ${a.rows ?? a.seen ?? 0} rows, recovered 0${a.failures ? ` (${fmtCensus(a.failures)})` : ""}`);
    }
    if (dbAttempt?.census) {
      err(`  matching rows by scheme: ${fmtCensus(dbAttempt.census.counts) || "none"}`);
      if (dbAttempt.census.total === 0) {
        err(`  nothing in this profile matches ${matcher.describe}. Run: node ${path.basename(SELF)} scan --browser ${opts.browser} --domain ${matcher.bare}`);
      }
    }
    err(`  nothing was written. Exit code 1.`);
    void last;
    return 1;
  }

  const meta = {
    tool: `tb-cookies ${VERSION}`,
    importedAt: new Date().toISOString(),
    browser: browser.name,
    profile: opts.profile,
    database: prof.db,
    domain: matcher.bare,
    match: matcher.describe,
    route: usedRoute,
    attempts,
    platform: PLATFORM,
    node: process.version,
  };

  const outPath = opts.out || path.join(process.cwd(), ".toolbay", "cookies", `${matcher.bare}.json`);
  const written = writeAndVerify(outPath, result.cookies, matcher, meta);

  if (written.count < min) {
    err(`FAILED: ${written.count} cookies for ${matcher.bare} is below --min ${min}.`);
    err(`  the artifact at ${written.path} is real, it is just not enough to call this session authenticated.`);
    return 1;
  }

  out(`${written.count} cookies for domain ${matcher.bare} imported`);
  out(`  route:    ${usedRoute}${usedRoute === "cdp" ? ` (${result.browserVersion || "browser-decrypted"})` : ""}`);
  out(`  hosts:    ${written.domains.join(", ")}`);
  out(`  names:    ${summariseNames(result.cookies)}`);
  out(`  file:     ${written.path}`);
  out(`  verified: re-read from disk, ${written.count} entries, every one non-empty and matching ${matcher.describe}`);
  if (result.failures && Object.keys(result.failures).length) {
    out(`  not recovered: ${fmtCensus(result.failures)}`);
  }
  out("");
  out(`Load it into a headless session with:  browse cookie-import "${written.path}"`);
  return 0;
}

function failZero(route, r, matcher, browser, prof) {
  const reasons = Object.entries(r.failures || {});
  const detail = reasons.length ? reasons.map(([k, n]) => `${n} ${k}`).join(", ") : "no rows matched at all";
  fail(
    "no_cookies",
    `the ${route} route recovered 0 cookies for ${matcher.describe} from ${browser.name}/${prof.profile}: ${detail}`,
    r.failures?.v20
      ? "these rows use App-Bound Encryption. Close the browser and re-run with --route cdp, or connect to the running browser over CDP."
      : "run `scan --domain <d>` to see what is actually in the profile",
  );
}

function summariseNames(cookies) {
  const names = cookies.map((c) => c.name);
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? `${shown}, +${names.length - 6} more` : shown || "(none)";
}

function cmdVerify(opts) {
  if (!opts.file) fail("bad_request", "--file is required");
  const matcher = opts.domain ? domainMatcher(opts.domain, { exact: opts.exact }) : null;
  const res = verifyArtifact(path.resolve(opts.file), matcher);
  const min = Number.isFinite(opts.min) ? opts.min : 1;
  if (!res.ok) {
    err(`FAILED: ${res.error}`);
    return 1;
  }
  if (res.count < min) {
    err(`FAILED: ${path.resolve(opts.file)} holds ${res.count} cookies, below --min ${min}`);
    return 1;
  }
  out(`${res.count} cookies${matcher ? ` for domain ${matcher.bare}` : ""} verified in ${path.resolve(opts.file)}`);
  out(`  hosts: ${res.domains.join(", ")}`);
  return 0;
}

// ------------------------------------------------------------------ selftest
//
// Fixtures are built from scratch, including deliberately broken ones, and the
// gstack behaviour is reimplemented alongside so the comparison is an
// assertion rather than a claim in a comment.

function gstackHostKeyQuery(db, domain) {
  // cookie-import-browser.ts:262-270, reduced to the part under test.
  const rows = db.prepare(`SELECT host_key, name FROM cookies WHERE host_key IN (?)`).all(domain);
  return rows.length;
}

function gstackHasV20(db) {
  // cookie-import-browser.ts:1034, verbatim query.
  const rows = db.prepare("SELECT encrypted_value FROM cookies LIMIT 10").all();
  return rows.some((r) => {
    const ev = toBuffer(r.encrypted_value);
    return ev.length >= 3 && ev.subarray(0, 3).toString("latin1") === "v20";
  });
}

function makeFixture(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE cookies (
    creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT,
    path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
    last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER,
    priority INTEGER, encrypted_value BLOB, samesite INTEGER, source_scheme INTEGER
  )`);
  const ins = db.prepare(
    `INSERT INTO cookies (creation_utc, host_key, name, value, path, expires_utc,
      is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority,
      encrypted_value, samesite, source_scheme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const future = chromiumNow() + 86400000000n;
  rows.forEach((r, i) => {
    ins.run(
      i + 1,
      r.host,
      r.name,
      r.plain ?? "",
      r.path ?? "/",
      r.expires ?? future,
      r.secure ? 1 : 0,
      r.httpOnly ? 1 : 0,
      i + 1,
      r.hasExpires === 0 ? 0 : 1,
      1,
      1,
      r.enc ?? new Uint8Array(0),
      r.sameSite ?? 1,
      2,
    );
  });
  db.close();
}

/** A real Windows-format v10 record: "v10" + nonce(12) + ct + tag(16). */
function encV10Win(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from("v10", "latin1"), nonce, ct, c.getAuthTag()]));
}

/**
 * A missing or unparseable artifact inside the selftest must become a FAILING
 * assertion, never a crashed process: a selftest that dies half way through has
 * printed neither a pass nor a fail for everything after it.
 */
function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  const raw = readTextSafe(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runSelf(args, env = {}) {
  const res = spawnSync(process.execPath, ["--no-warnings", SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120000,
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", combined: `${res.stdout || ""}${res.stderr || ""}` };
}

function selftest() {
  if (!DatabaseSync) {
    err(`selftest cannot run: node:sqlite is unavailable on ${process.version} (${SQLITE_LOAD_ERROR?.message})`);
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cookies-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const KEY = Buffer.alloc(32, 0x11);
  const KEY_HEX = KEY.toString("hex");

  // ---- fixture A: only dotted host_keys, the shape that breaks gstack's CLI
  const fxDotted = path.join(tmp, "dotted.db");
  makeFixture(fxDotted, [
    { host: ".example.com", name: "session", enc: encV10Win(KEY, "abc123") },
    { host: ".example.com", name: "csrf", enc: encV10Win(KEY, "tok") },
    { host: "app.example.com", name: "sub", enc: encV10Win(KEY, "deep") },
  ]);

  // ---- fixture B: 10 old v10 rows then v20, the shape that breaks LIMIT 10
  const fxMixed = path.join(tmp, "mixed.db");
  makeFixture(fxMixed, [
    ...Array.from({ length: 10 }, (_, i) => ({ host: ".old.com", name: `old${i}`, enc: encV10Win(KEY, `v${i}`) })),
    ...Array.from({ length: 5 }, (_, i) => ({ host: ".new.com", name: `new${i}`, enc: new Uint8Array(Buffer.concat([Buffer.from("v20", "latin1"), crypto.randomBytes(40)])) })),
  ]);

  // ---- fixture C: nothing but v20, this machine's real shape
  const fxV20 = path.join(tmp, "v20.db");
  makeFixture(fxV20, Array.from({ length: 7 }, (_, i) => ({
    host: ".toolbay.ai",
    name: `abe${i}`,
    enc: new Uint8Array(Buffer.concat([Buffer.from("v20", "latin1"), crypto.randomBytes(40)])),
  })));

  // ---- fixture D: expired + empty-valued rows, the padding traps
  const fxJunk = path.join(tmp, "junk.db");
  makeFixture(fxJunk, [
    { host: ".junk.io", name: "expired", enc: encV10Win(KEY, "stale"), expires: CHROMIUM_EPOCH_OFFSET + 1000000n, hasExpires: 1 },
    { host: ".junk.io", name: "blank", enc: encV10Win(KEY, "") },
    { host: ".junk.io", name: "good", enc: encV10Win(KEY, "real-value") },
  ]);

  // ---- fixture E: a real file that is not a cookie database
  const fxWrong = path.join(tmp, "wrong.db");
  {
    const d = new DatabaseSync(fxWrong);
    d.exec("CREATE TABLE notcookies (a TEXT)");
    d.close();
  }
  const fxGarbage = path.join(tmp, "garbage.db");
  fs.writeFileSync(fxGarbage, "this is not a sqlite file at all", "utf8");
  const fxEmpty = path.join(tmp, "empty.db");
  fs.writeFileSync(fxEmpty, "", "utf8");

  // ================= the gstack comparison, asserted both ways ==============
  {
    const d = new DatabaseSync(fxDotted);
    check(
      "gstack's exact host_key IN (?) finds 0 rows for example.com",
      0,
      gstackHostKeyQuery(d, "example.com"),
      "cookie-import-browser.ts:267 -- this is the zero that disables its own v20 fallback",
    );
    check("gstack's query does find the dotted form, so the rows exist", 2, gstackHostKeyQuery(d, ".example.com"), "proves the rows are there and only the match is wrong");
    d.close();
  }
  {
    const d = new DatabaseSync(fxMixed);
    check(
      "gstack's LIMIT 10 v20 detector says no-v20 on a db with 5 v20 rows",
      false,
      gstackHasV20(d),
      "cookie-import-browser.ts:1034 -- no ORDER BY, so it samples the oldest 10",
    );
    d.close();
  }

  // ================= ours: the same inputs, correct answers =================
  {
    const { db, close } = openCookieDb(fxDotted);
    const m = domainMatcher("example.com");
    check("ours matches all 3 rows for example.com (dotted + subdomain)", 3, censusOf(db, m).total);
    const mx = domainMatcher("example.com", { exact: true });
    check("ours with --exact matches the 2 non-subdomain rows", 2, censusOf(db, mx).total);
    close();
  }
  {
    const { db, close } = openCookieDb(fxMixed);
    check("ours censuses every row and sees all 5 v20", 5, censusOf(db).counts.v20);
    check("ours sees the 10 v10 too", 10, censusOf(db).counts.v10);
    check("ours routes an all-v20 domain to cdp", "cdp", decideRoute(censusOf(db, domainMatcher("new.com"))).route);
    check("ours routes a v10 domain to db", "db", decideRoute(censusOf(db, domainMatcher("old.com"))).route);
    close();
  }

  // ================= end to end: the real executable ========================
  const outA = path.join(tmp, "out-a.json");
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "example.com", "--key-hex", KEY_HEX, "--route", "db", "--out", outA]);
    check("import exits 0 on a dotted-only db", 0, r.status, r.combined.trim().slice(0, 200));
    check("import prints the exact provable line", true, /^3 cookies for domain example\.com imported$/m.test(r.stdout), r.stdout.trim().slice(0, 200));
    const written = readJsonSafe(outA) ?? [];
    check("the artifact holds 3 cookies", 3, Array.isArray(written) ? written.length : "unreadable");
    check("the values really decrypted", "abc123", (Array.isArray(written) && written.find((c) => c.name === "session")?.value) || "unreadable");
    check("a sidecar records the route and the database", "db", readJsonSafe(`${outA}.meta.json`)?.route ?? "unreadable");
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "example.com", "--key-hex", KEY_HEX, "--exact", "--route", "db", "--out", path.join(tmp, "out-exact.json")]);
    check("--exact narrows to 2 and still exits 0", true, r.status === 0 && /^2 cookies for domain example\.com imported$/m.test(r.stdout), r.stdout.trim().slice(0, 160));
  }

  // ---- FAIL CLOSED: every one of these must be non-zero
  const outV20 = path.join(tmp, "out-v20.json");
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxV20, "--domain", "toolbay.ai", "--key-hex", KEY_HEX, "--route", "db", "--out", outV20]);
    check("an all-v20 db FAILS instead of reporting 0 imported", true, r.status !== 0, `exit ${r.status}`);
    check("...and names v20 as the reason", true, /v20/i.test(r.combined), r.combined.trim().slice(0, 200));
    check("...and writes no artifact at all", false, fs.existsSync(outV20), "gstack would have said 'Imported 0 cookies' and exited 0");
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "nosuchdomain.test", "--key-hex", KEY_HEX, "--route", "db", "--out", path.join(tmp, "out-none.json")]);
    check("a domain with no rows FAILS", true, r.status !== 0, `exit ${r.status}`);
    check("...and says nothing matched", true, /nothing in this profile matches|no rows matched/i.test(r.combined), r.combined.trim().slice(0, 200));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "example.com", "--route", "db", "--out", path.join(tmp, "out-nokey.json")], {
      LOCALAPPDATA: path.join(tmp, "no-such-localappdata"),
      APPDATA: path.join(tmp, "no-such-appdata"),
      HOME: path.join(tmp, "no-such-home"),
      USERPROFILE: path.join(tmp, "no-such-home"),
    });
    check("a db whose key cannot be derived FAILS rather than returning 0", true, r.status !== 0, `exit ${r.status}: ${r.combined.trim().slice(0, 160)}`);
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxJunk, "--domain", "junk.io", "--key-hex", KEY_HEX, "--route", "db", "--out", path.join(tmp, "out-junk.json")]);
    check("expired and empty-valued rows are excluded, leaving 1", true, /^1 cookies for domain junk\.io imported$/m.test(r.stdout), r.stdout.trim().slice(0, 200));
    check("...and the blank one is reported as not recovered, not as a success", true, /empty_value/.test(r.stdout), r.stdout.trim().slice(0, 200));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxJunk, "--domain", "junk.io", "--key-hex", KEY_HEX, "--route", "db", "--min", "5", "--out", path.join(tmp, "out-min.json")]);
    check("--min 5 with 1 real cookie FAILS", true, r.status !== 0, `exit ${r.status}`);
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxWrong, "--domain", "example.com", "--route", "db", "--out", path.join(tmp, "out-wrong.json")]);
    check("a sqlite file with no cookies table FAILS", true, r.status !== 0 && /cookies" table/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxGarbage, "--domain", "example.com", "--route", "db", "--out", path.join(tmp, "out-garbage.json")]);
    check("a non-sqlite file FAILS", true, r.status !== 0, `exit ${r.status}: ${r.combined.trim().slice(0, 120)}`);
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxEmpty, "--domain", "example.com", "--route", "db", "--out", path.join(tmp, "out-empty.json")]);
    check("a zero-byte database FAILS", true, r.status !== 0 && /empty/i.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", path.join(tmp, "does-not-exist.db"), "--domain", "example.com", "--route", "db", "--out", path.join(tmp, "out-missing.json")]);
    check("a missing database FAILS", true, r.status !== 0 && /not found/i.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--key-hex", KEY_HEX, "--route", "db", "--out", path.join(tmp, "out-nodomain.json")]);
    check("import without --domain FAILS", true, r.status !== 0 && /--domain is required/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "notabrowser", "--db", fxDotted, "--domain", "example.com", "--route", "db"]);
    check("an unknown browser FAILS with the supported list", true, r.status !== 0 && /unknown browser/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "example.com", "--profile", "../../etc", "--key-hex", KEY_HEX, "--route", "db"]);
    check("a traversal in --profile FAILS", true, r.status !== 0 && /invalid profile/i.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["import", "--browser", "chrome", "--db", fxDotted, "--domain", "%", "--key-hex", KEY_HEX, "--route", "db"]);
    check('--domain "%" FAILS instead of matching every host', true, r.status !== 0 && /hostname/i.test(r.combined), r.combined.trim().slice(0, 160));
  }

  // ---- verify: the artifact contract
  {
    const r = runSelf(["verify", "--file", outA, "--domain", "example.com"]);
    check("verify passes on a good artifact", 0, r.status, r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["verify", "--file", outA, "--domain", "other.com"]);
    check("verify FAILS when the cookies are for another domain", true, r.status !== 0, "an artifact full of the wrong site's cookies is not an import");
  }
  {
    const truncated = path.join(tmp, "truncated.json");
    fs.writeFileSync(truncated, (readTextSafe(outA) || '[{"name":"a","value":"b"').slice(0, 40), "utf8");
    const r = runSelf(["verify", "--file", truncated, "--domain", "example.com"]);
    check("verify FAILS on a truncated artifact", true, r.status !== 0 && /not valid JSON/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const blanked = path.join(tmp, "blanked.json");
    const arr = readJsonSafe(outA) ?? [{ name: "a", value: "x", domain: ".example.com", path: "/" }];
    arr[0].value = "";
    fs.writeFileSync(blanked, JSON.stringify(arr), "utf8");
    const r = runSelf(["verify", "--file", blanked, "--domain", "example.com"]);
    check("verify FAILS on a cookie with an empty value", true, r.status !== 0 && /empty value/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const notarray = path.join(tmp, "notarray.json");
    fs.writeFileSync(notarray, JSON.stringify({ cookies: [] }), "utf8");
    const r = runSelf(["verify", "--file", notarray]);
    check("verify FAILS on JSON that is not a cookie array", true, r.status !== 0 && /JSON array/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const r = runSelf(["verify", "--file", path.join(tmp, "nope.json")]);
    check("verify FAILS on a missing file", true, r.status !== 0 && /cannot read/.test(r.combined), r.combined.trim().slice(0, 160));
  }
  {
    const empties = path.join(tmp, "emptyarray.json");
    fs.writeFileSync(empties, "[]", "utf8");
    const r = runSelf(["verify", "--file", empties, "--domain", "example.com"]);
    check("verify FAILS on an empty cookie array", true, r.status !== 0, "zero cookies is never a passing verification");
  }

  // ---- unit checks that back the claims in the header
  check("session cookies map to expires -1", -1, chromiumEpochToUnix(0, 0));
  check("a chromium epoch converts to unix seconds", 1700000000, chromiumEpochToUnix(1700000000n * 1000000n + CHROMIUM_EPOCH_OFFSET, 1));
  check("a URL is accepted where a domain is expected", "toolbay.ai", domainMatcher("https://toolbay.ai/pricing").bare);
  check("a leading dot is normalised away", "toolbay.ai", domainMatcher(".toolbay.ai").bare);
  check("subdomain matching is suffix-anchored, so notexample.com does not match", false, domainMatcher("example.com").test("notexample.com"));
  check("subdomain matching does match a real subdomain", true, domainMatcher("example.com").test("app.example.com"));
  check("sameSite 0 is None, not Lax", "None", mapSameSite(0));

  // ---- the count guard, same idea as tb-guard's
  const EXPECTED = 47;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "a selftest whose total drifts is a selftest that can quietly stop asserting things",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.min(78, Math.max(...results.map((r) => r.name.length)));
  out(`\n  tb-cookies selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  NOT trustworthy in this state. Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${String(r.detail).replace(/\s+/g, " ").slice(0, 220)}`);
    out("");
    return 1;
  }
  out("");
  out("  Every deliberately broken input above exits non-zero and writes nothing.");
  out("  The two gstack assertions are the point: on the same fixture, its exact");
  out("  host_key match finds 0 of 3 rows and its LIMIT 10 detector misses 5 v20");
  out("  rows, which is the pair of bugs that turns a failed import into the");
  out("  sentence \"Imported 0 cookies\" with exit code 0.");
  out("");
  return 0;
}

// -------------------------------------------------------------------- doctor

function cmdDoctor() {
  out(`\n  tb-cookies doctor  (node ${process.version}, ${PLATFORM})\n`);
  let bad = 0;
  out(`  node:sqlite            ${DatabaseSync ? "available" : `MISSING (${SQLITE_LOAD_ERROR?.message})`}`);
  if (!DatabaseSync) bad += 1;
  out(`  WebSocket (for CDP)    ${typeof WebSocket === "function" ? "available" : "MISSING"}`);
  if (typeof WebSocket !== "function") bad += 1;
  if (IS_WIN) {
    const ps = runCapture("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"], { timeout: 20000 });
    out(`  powershell (for DPAPI) ${ps.ok && ps.stdout === "ok" ? "available" : `NOT USABLE (${ps.stderr || ps.error || `exit ${ps.status}`})`}`);
    if (!(ps.ok && ps.stdout === "ok")) bad += 1;
  }
  out("");
  const installed = BROWSERS.map((b) => ({ b, p: findProfiles(b) })).filter((x) => x.p.length);
  if (!installed.length) {
    out("  No Chromium profile with a cookie database found.");
    bad += 1;
  }
  for (const { b, p } of installed) {
    const exe = findBrowserExe(b);
    out(`  ${b.name.padEnd(9)} ${p.length} profile(s)   exe: ${exe || "not found (cdp route unavailable)"}`);
    for (const prof of p) {
      let line = `      ${prof.profile.padEnd(11)}`;
      try {
        const { db, close } = openCookieDb(prof.db);
        try {
          const c = censusOf(db);
          line += ` ${String(c.total).padStart(5)} cookies  ${fmtCensus(c.counts)}`;
          const route = decideRoute(c);
          line += `  -> route ${route.route}`;
        } finally {
          close();
        }
      } catch (e) {
        line += ` UNREADABLE (${e.code || "error"}: ${e.message})`;
        bad += 1;
      }
      out(line);
    }
  }
  out("");
  if (bad) out(`  ${bad} problem(s). Cookie import will not be reliable until they are fixed.\n`);
  return bad ? 1 : 0;
}

// --------------------------------------------------------------------- entry

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

function parseArgs(argv) {
  const o = { browser: "chrome", profile: "Default", exact: false, includeExpired: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail("bad_request", `${a} needs a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--browser": o.browser = next(); break;
      case "--profile": o.profile = next(); break;
      case "--domain": o.domain = next(); break;
      case "--out": o.out = next(); break;
      case "--file": o.file = next(); break;
      case "--db": o.db = next(); break;
      case "--route": o.route = next(); break;
      case "--key-hex": o.keyHex = next(); break;
      case "--min": o.min = Number(next()); break;
      case "--exact": o.exact = true; break;
      case "--include-expired": o.includeExpired = true; break;
      default:
        if (a.startsWith("--")) fail("bad_request", `unknown option ${a}`);
        positional.push(a);
    }
  }
  return { opts: o, positional };
}

function help() {
  out(`
  tb-cookies ${VERSION}, the Toolbay Stack browser-cookie import engine

    browsers                     list Chromium profiles with a cookie database
    doctor                       can this machine import cookies at all
    scan    --browser <b> [--domain <d>]
                                 census EVERY row by encryption scheme and say
                                 which route can actually read them
    import  --browser <b> --domain <d> [--profile P] [--out FILE]
            [--route auto|db|cdp] [--exact] [--min N] [--include-expired]
                                 decrypt, write, re-read, then print
                                 "N cookies for domain <d> imported"
    verify  --file FILE [--domain <d>] [--min N]
                                 re-check an artifact on disk
    selftest                     run against real and deliberately broken input

  Exit code 0 means cookies are on disk and were re-read after writing. Zero
  cookies is always exit 1 with a named cause; it is never a success line.

  Windows note: Chrome 127+ encrypts cookies with App-Bound Encryption (v20).
  No unelevated same-user process can decrypt those from the database. Close
  the browser and use --route cdp, which reads them through the browser itself.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return 0;
  }
  if (cmd === "selftest") return selftest();
  const { opts, positional } = parseArgs(argv.slice(1));
  // `import chrome --domain x` works as well as `--browser chrome`.
  if (positional.length && !argv.includes("--browser")) opts.browser = positional[0];

  switch (cmd) {
    case "browsers": return cmdBrowsers();
    case "doctor": return cmdDoctor();
    case "scan": return cmdScan(opts);
    case "import": return await cmdImport(opts);
    case "verify": return cmdVerify(opts);
    default:
      err(`unknown command "${cmd}"`);
      help();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    if (e instanceof CookieError) {
      err(`FAILED [${e.code}]: ${e.message}`);
      if (e.hint) err(`  ${e.hint}`);
    } else {
      err(`FAILED [crash]: ${e?.stack || e}`);
    }
    err("  nothing was written. Exit code 1.");
    process.exitCode = 1;
  });
