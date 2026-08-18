#!/usr/bin/env node
/**
 * tb-upgrade.mjs — the Toolbay Stack self-upgrade engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the /gstack-upgrade
 * command name, the update-check output vocabulary UP_TO_DATE /
 * UPGRADE_AVAILABLE / JUST_UPGRADED, the snooze ladder with escalating backoff,
 * the auto-upgrade setting, the just-upgraded marker, the cache TTLs of 60 and
 * 720 minutes, and the "show what's new after upgrading" step) comes from
 * `gstack-upgrade` and `bin/gstack-update-check` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ENGINE AND NOT A PAGE OF BASH THE MODEL PASTES
 * ---------------------------------------------------------------------------
 *
 * gstack's upgrade is a markdown document containing shell blocks that an agent
 * copies into a terminal, plus one bash script that decides whether to nag.
 * Three failure modes fall out of that, all reproduced on this machine against
 * the installed gstack on 2026-08-14. Each one is now a selftest case here.
 *
 * 1. A FAILED UPDATE CHECK IS RECORDED AS "UP TO DATE".
 *
 *      $ GSTACK_DIR=<fake with VERSION 1.0.0.0> GSTACK_STATE_DIR=<tmp> \
 *        GSTACK_REMOTE_URL=http://127.0.0.1:9/VERSION \
 *        bash ~/.claude/skills/gstack/bin/gstack-update-check ; echo "exit=$?"
 *      exit=0
 *      $ cat <tmp>/last-update-check
 *      UP_TO_DATE 1.0.0.0
 *
 *    The fetch never succeeded. Nothing was learned. gstack still writes the
 *    positive verdict and caches it for 60 minutes, so a version 60 releases
 *    behind reports itself current, silently, because the probe broke. That is
 *    a check that fails OPEN: the absence of an answer is stored as a good
 *    answer. Here, a probe that cannot complete prints CHECK_FAILED, exits
 *    non-zero, and writes NOTHING to the cache. Only a probe that actually
 *    resolved a version is allowed to leave a verdict behind.
 *
 * 2. CACHE STALENESS IS COMPUTED WITH `find -mmin`, WHICH IS NOT PORTABLE.
 *
 *      $ which -a find
 *      /usr/bin/find
 *      /c/WINDOWS/system32/find          <- also on PATH
 *      $ OUT=$(/c/WINDOWS/system32/find <cache> -mmin +60 2>/dev/null || true)
 *      $ echo "[$OUT]"
 *      []
 *
 *    Windows' find.exe has no -mmin. It prints "FIND: Parameter format not
 *    correct" and gstack's `2>/dev/null || true` discards it, leaving STALE
 *    empty — which gstack reads as "the cache is fresh". Whenever System32
 *    precedes /usr/bin on PATH (bash spawned from PowerShell, from a Windows
 *    service, from a task scheduler entry) the cache never expires and the
 *    stack never notices another release again. Staleness here is
 *    `Date.now() - at`, in Node, with no external binary to be the wrong one.
 *
 * 3. THE ROLLBACK THE DOCS PROMISE HAS ALREADY BEEN DELETED.
 *
 *    gstack's vendored-upgrade block, run verbatim with a setup that fails:
 *
 *      mv "$INSTALL_DIR" "$INSTALL_DIR.bak"
 *      mv "$TMP_DIR/gstack" "$INSTALL_DIR"
 *      cd "$INSTALL_DIR" && ./setup
 *      rm -rf "$INSTALL_DIR.bak" "$TMP_DIR"
 *
 *      setup: FAILED
 *      ls: cannot access '<...>/install.bak': No such file or directory
 *
 *    The `rm -rf` is its own statement, so it runs whether or not setup
 *    succeeded. SKILL.md tells the user to "restore from backup (.bak
 *    directory)" after exactly this failure. The backup is gone by then. Here
 *    the backup is deleted only after a verify pass, and a failed verify
 *    restores it and then re-checks the restore byte for byte.
 *
 * ---------------------------------------------------------------------------
 * AND THE THING GSTACK NEVER DOES AT ALL: VERIFY
 * ---------------------------------------------------------------------------
 *
 * gstack's Step 6 prints "gstack v{new} — upgraded from v{old}!" with {new}
 * substituted from the update-check line the agent read BEFORE the upgrade ran.
 * Nothing re-reads the disk afterwards. If `./setup` half-finished — and
 * gstack's own Windows guidance is that skills are file-copied rather than
 * symlinked, so a single locked file leaves a mixed tree — the user is told the
 * upgrade succeeded by a message assembled from the intent, not the result.
 *
 * `verify` here holds the release package on disk and compares every installed
 * file against it by SHA-256. An upgrade is not reported as successful until
 * that comparison passes, and if the release cannot be located the answer is
 * UNVERIFIED and a non-zero exit, never a cheerful summary.
 *
 * DESIGN RULES, same three as tb-guard.mjs:
 *   1. FAIL CLOSED. Any path that cannot reach a confident answer exits
 *      non-zero and names the check that could not complete.
 *   2. NO INTERPRETER BUT NODE. Node is already required by Claude Code. No
 *      bash, no curl, no find, no date, no sort -V, no mktemp, no symlinks.
 *   3. PROVE IT. `selftest` runs the real upgrade pipeline against a
 *      deliberately partial release and asserts the rollback happened.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const PKG_NAME = "toolbay-stack";

/**
 * The stack version this copy of the skill shipped with.
 *
 * It is a constant because an installed skill directory sits at
 * ~/.claude/skills/gstack-upgrade/ with no package.json above it, so there is
 * nothing on disk to read it from. A constant that has to be hand-bumped is
 * exactly the kind of thing that silently drifts, so selftest asserts it equals
 * the repository's package.json whenever it is run from a checkout. It cannot
 * drift for more than one commit without a red test.
 */
const STACK_VERSION = "0.2.0";

const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const PROBE_TIMEOUT_MS = 5000;

// gstack's TTLs, kept deliberately: check often while current, nag less often
// once an upgrade is already known to be waiting.
const TTL_UP_TO_DATE_MIN = 60;
const TTL_UPGRADE_AVAILABLE_MIN = 720;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

// --------------------------------------------------------------------- state

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}
const cacheFile = () => path.join(stateDir(), "last-update-check.json");
const snoozeFile = () => path.join(stateDir(), "update-snoozed.json");
const markerFile = () => path.join(stateDir(), "just-upgraded-from.json");
const installedFile = () => path.join(stateDir(), "installed.json");
const configFile = () => path.join(stateDir(), "upgrade-config.json");

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    // A corrupt or absent state file means "no state", never "state that says
    // yes". Every caller treats null as the conservative branch.
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// -------------------------------------------------------------------- semver

/**
 * Compare dotted numeric versions of any length. gstack shells out to `sort -V`
 * for this, which is GNU coreutils and not present on a bare Windows PATH, and
 * its migration selector additionally falls back to a plain string compare with
 * the comment that it "works for dotted versions with same segment count" —
 * which makes 1.9.0 sort above 1.10.0. Numeric, segment by segment, here.
 */
function cmpVersion(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = Number.parseInt(pa[i] ?? "0", 10);
    const y = Number.parseInt(pb[i] ?? "0", 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return String(a).localeCompare(String(b));
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const isVersion = (s) => typeof s === "string" && /^\d+(\.\d+)*$/.test(s.trim());

// ------------------------------------------------------------------- sleeping

/** Synchronous sleep with no busy loop and no `sleep` binary. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --------------------------------------------------------- filesystem, safely

/**
 * Windows loses to file locks in ways POSIX does not: OneDrive, an indexer, an
 * antivirus scanner, or Claude Code itself holding a script open makes rename
 * and unlink throw EBUSY/EPERM/ENOTEMPTY for a few hundred milliseconds. gstack
 * runs bare `mv` and `rm -rf` and treats a failure as fatal-and-silent. Retry,
 * then report honestly — never pretend the operation happened.
 */
function withRetry(label, fn, attempts = 5) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      lastErr = err;
      const retryable = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES", "EMFILE"].includes(err?.code);
      if (!retryable) break;
      sleepSync(50 * (i + 1));
    }
  }
  return { ok: false, error: `${label} failed: ${lastErr?.code ?? ""} ${lastErr?.message ?? lastErr}`.trim() };
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    // No symlink handling on purpose: this stack never installs symlinks,
    // because a symlink is what degrades to a stale copy on Windows.
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
}

/** Relative paths of every file under dir, POSIX-separated and sorted. */
function walk(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return acc.sort();
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Files that are ALLOWED to differ between the release and the installed copy,
 * because the installer deliberately rewrites or preserves them.
 *
 * Getting this list wrong in either direction is a real bug: too broad and
 * verify stops catching a truncated file, too narrow and it cries drift on
 * every healthy install. Each entry names why it is here.
 */
const EXEMPT_EXACT = new Set([
  "modes/modes.json", // user's stances; installer carries the edited copy across
  "memory/memory.json", // user's captured corrections, same reason
]);
const isExempt = (rel) => EXEMPT_EXACT.has(rel) || rel.endsWith(".shipped");

/**
 * SKILL.md is rewritten at install time: pinHookPaths() replaces
 *   command: "node $HOME/.claude/skills/guard/scripts/tb-guard.mjs freeze"
 * with an absolute pinned path, so a raw byte compare would report drift on
 * every correctly installed safety skill. Canonicalise just that line and
 * compare everything else exactly — a truncated or half-copied SKILL.md still
 * fails, which is the case that matters.
 */
function canonicalise(rel, buf) {
  if (path.posix.basename(rel) !== "SKILL.md") return buf;
  const text = buf.toString("utf8").replace(/\r\n/g, "\n");
  return Buffer.from(text.replace(/^(\s*command:\s*).*$/gm, "$1<pinned-at-install>"), "utf8");
}

// -------------------------------------------------------------- install sites

/** A directory is one of ours if its SKILL.md carries the Toolbay Stack header. */
function isToolbaySkill(dir) {
  const md = path.join(dir, "SKILL.md");
  if (!fs.existsSync(md)) return false;
  try {
    return /Toolbay Stack/.test(fs.readFileSync(md, "utf8"));
  } catch {
    return false;
  }
}

function listSkills(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => {
      const d = path.join(root, n);
      try {
        return fs.statSync(d).isDirectory() && isToolbaySkill(d);
      } catch {
        return false;
      }
    })
    .sort();
}

function installSites(explicitRoot) {
  if (explicitRoot) {
    const root = path.resolve(explicitRoot);
    return [{ scope: "explicit", root, skills: listSkills(root) }];
  }
  return [
    { scope: "project", root: path.join(process.cwd(), ".claude", "skills") },
    { scope: "global", root: path.join(os.homedir(), ".claude", "skills") },
  ]
    .map((s) => ({ ...s, skills: listSkills(s.root) }))
    .filter((s) => s.skills.length);
}

/** The stack version believed to be on disk. Marker first, constant as fallback. */
function localVersion() {
  const rec = readJson(installedFile());
  if (rec && isVersion(rec.version)) return rec.version;
  return STACK_VERSION;
}

// -------------------------------------------------------------- update check

/**
 * Ask the registry what the latest published version is.
 *
 * Returns {ok:true, version} or {ok:false, reason}. There is no third answer
 * and no default. Every failure mode below produced "UP_TO_DATE" in gstack.
 */
async function probeRemote() {
  const override = process.env.TOOLBAY_UPGRADE_REGISTRY_URL;
  const target = override || REGISTRY_URL;

  let body = null;
  if (override && !/^https?:/i.test(override)) {
    // A filesystem path, so selftest (and an air-gapped mirror) can feed this
    // real bytes without a network. Same parsing and same strictness after.
    try {
      body = fs.readFileSync(override, "utf8");
    } catch (err) {
      return { ok: false, reason: `could not read the registry override at ${override} (${err.code ?? err.message})` };
    }
  } else {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(target, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!res.ok) return { ok: false, reason: `the registry answered HTTP ${res.status} for ${target}` };
      body = await res.text();
    } catch (err) {
      // Offline, DNS failure, captive portal, refused connection, timeout.
      return { ok: false, reason: `the registry could not be reached (${err?.name === "AbortError" ? `no answer in ${PROBE_TIMEOUT_MS}ms` : err?.message ?? err})` };
    } finally {
      clearTimeout(timer);
    }
  }

  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // A captive portal's login page is valid HTTP and complete nonsense here.
    return { ok: false, reason: `the registry returned ${body.length} bytes that are not JSON (starts: ${JSON.stringify(body.slice(0, 40))})` };
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "the registry returned JSON that is not an object" };
  if (!isVersion(json.version)) {
    return { ok: false, reason: `the registry returned no usable version field (got ${JSON.stringify(json.version)})` };
  }
  return { ok: true, version: json.version.trim() };
}

function snoozeActive(remote) {
  const s = readJson(snoozeFile());
  if (!s) return false;
  if (s.version !== remote) return false; // a new release always breaks a snooze
  const level = Number.isInteger(s.level) ? s.level : 0;
  const at = Number.isFinite(s.at) ? s.at : 0;
  if (!level || !at) return false;
  const durations = { 1: 24 * 3600e3, 2: 48 * 3600e3 };
  const dur = durations[level] ?? 7 * 24 * 3600e3;
  return Date.now() - at < dur;
}

function cacheVerdict() {
  const cached = readJson(cacheFile());
  // probe:"ok" is written ONLY after a probe that actually resolved a version.
  // Anything else on disk — corrupt, hand-edited, from an older format, or from
  // a failed probe — is not a verdict and is re-probed.
  if (!cached || cached.probe !== "ok" || !Number.isFinite(cached.at)) return null;
  if (!isVersion(cached.local) || !isVersion(cached.remote)) return null;
  if (cached.local !== localVersion()) return null; // we moved; the verdict is void
  const ttlMin = cached.verdict === "UPGRADE_AVAILABLE" ? TTL_UPGRADE_AVAILABLE_MIN : TTL_UP_TO_DATE_MIN;
  const ageMin = (Date.now() - cached.at) / 60000;
  if (ageMin < 0) return null; // clock moved backwards; do not trust it
  if (ageMin >= ttlMin) return null;
  return cached;
}

async function cmdCheck({ force, quiet }) {
  const local = localVersion();

  if (force) {
    for (const f of [cacheFile(), snoozeFile()]) fs.rmSync(f, { force: true });
  }

  // The just-upgraded marker, same idea as gstack's, but it is only written by
  // an upgrade that verified, so seeing it means the new bytes are really down.
  const marker = readJson(markerFile());
  if (marker && isVersion(marker.from)) {
    fs.rmSync(markerFile(), { force: true });
    fs.rmSync(snoozeFile(), { force: true });
    out(`JUST_UPGRADED ${marker.from} ${local}`);
  }

  const cached = force ? null : cacheVerdict();
  if (cached) {
    if (cached.verdict === "UP_TO_DATE") return 0;
    if (snoozeActive(cached.remote)) return 0;
    out(`UPGRADE_AVAILABLE ${cached.local} ${cached.remote}`);
    return 0;
  }

  const probe = await probeRemote();
  if (!probe.ok) {
    // THE WHOLE POINT. gstack writes UP_TO_DATE here and exits 0. A check that
    // did not happen is not a clean bill of health, so: say so, exit non-zero,
    // and leave the cache untouched so the next run tries again immediately
    // rather than replaying a verdict nobody ever established.
    if (!quiet) out(`CHECK_FAILED ${probe.reason}`);
    return 2;
  }

  const remote = probe.version;
  const verdict = cmpVersion(remote, local) > 0 ? "UPGRADE_AVAILABLE" : "UP_TO_DATE";
  writeJson(cacheFile(), { probe: "ok", verdict, local, remote, at: Date.now() });

  if (verdict === "UP_TO_DATE") return 0;
  if (snoozeActive(remote)) return 0;
  out(`UPGRADE_AVAILABLE ${local} ${remote}`);
  return 0;
}

function cmdSnooze() {
  const cached = readJson(cacheFile());
  const remote = cached && isVersion(cached.remote) ? cached.remote : null;
  if (!remote) {
    process.stderr.write("tb-upgrade: nothing to snooze — run `check` first.\n");
    return 1;
  }
  const prev = readJson(snoozeFile());
  const level = prev && prev.version === remote && Number.isInteger(prev.level) ? Math.min(prev.level + 1, 3) : 1;
  writeJson(snoozeFile(), { version: remote, level, at: Date.now() });
  out(`Snoozed v${remote}. Next reminder in ${{ 1: "24h", 2: "48h" }[level] ?? "1 week"}.`);
  return 0;
}

// -------------------------------------------------------------------- verify

/**
 * Compare an installed skills root against a release package, file by file.
 *
 * `releaseDir` is a directory containing skills/ — either an extracted npm
 * package or a repository checkout. If it cannot be located, this returns
 * unverified:true and the caller MUST NOT report success. That is the
 * distinction gstack does not draw at all: it has no verify step, so "the
 * upgrade worked" and "the upgrade was never checked" print the same sentence.
 */
function verifyAgainst(releaseDir, sites) {
  const srcSkills = path.join(releaseDir, "skills");
  if (!fs.existsSync(srcSkills)) {
    return { unverified: true, reason: `no skills/ directory inside ${releaseDir}`, sites: [] };
  }
  const results = [];
  for (const site of sites) {
    for (const name of site.skills) {
      const installed = path.join(site.root, name);
      const source = path.join(srcSkills, name);
      if (!fs.existsSync(source)) {
        // Installed but not in the release: a skill the release dropped, or a
        // directory from a different product. Reported, not silently ignored.
        results.push({ scope: site.scope, skill: name, status: "EXTRA", detail: "installed but not present in this release" });
        continue;
      }
      const want = walk(source).filter((r) => !isExempt(r));
      const have = new Set(walk(installed));
      const missing = want.filter((r) => !have.has(r));
      const differing = [];
      for (const rel of want) {
        if (!have.has(rel)) continue;
        const a = canonicalise(rel, fs.readFileSync(path.join(source, rel)));
        const b = canonicalise(rel, fs.readFileSync(path.join(installed, rel)));
        if (sha256(a) !== sha256(b)) differing.push(rel);
      }
      if (missing.length || differing.length) {
        const parts = [];
        if (missing.length) parts.push(`${missing.length} missing (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""})`);
        if (differing.length) parts.push(`${differing.length} differ (${differing.slice(0, 3).join(", ")}${differing.length > 3 ? ", ..." : ""})`);
        results.push({ scope: site.scope, skill: name, status: "DRIFT", detail: parts.join("; "), missing, differing });
      } else {
        results.push({ scope: site.scope, skill: name, status: "OK", detail: `${want.length} file${want.length === 1 ? "" : "s"} match` });
      }
    }
  }
  return { unverified: false, results };
}

/**
 * Find a release to verify against when the caller did not name one.
 * Order: explicit env, then a repository checkout above this script.
 * Returns null rather than guessing, because guessing wrong here produces a
 * confident wrong answer, which is the failure this file exists to remove.
 */
function findRelease() {
  if (process.env.TOOLBAY_UPGRADE_PACKAGE_DIR) return path.resolve(process.env.TOOLBAY_UPGRADE_PACKAGE_DIR);
  let dir = path.dirname(SELF);
  for (let i = 0; i < 6; i += 1) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      const j = readJson(pkg);
      if (j && j.name === PKG_NAME && fs.existsSync(path.join(dir, "skills"))) return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function printVerify(v) {
  if (v.unverified) {
    out(`\n  ${bold("UNVERIFIED")} — ${v.reason}`);
    out(dim("  No release package to compare against, so nothing was checked. This is"));
    out(dim("  reported as a failure on purpose: an unchecked install must never read"));
    out(dim("  as a clean one.\n"));
    return 1;
  }
  if (!v.results.length) {
    out(`\n  ${bold("UNVERIFIED")} — no installed Toolbay Stack skills were found to check\n`);
    return 1;
  }
  const w = Math.max(...v.results.map((r) => r.skill.length));
  out();
  for (const r of v.results) {
    out(`  ${r.status === "OK" ? "OK   " : bold(r.status.padEnd(5))} ${r.skill.padEnd(w)}  ${dim(`${r.scope}: ${r.detail}`)}`);
  }
  const bad = v.results.filter((r) => r.status !== "OK");
  out(`\n  ${v.results.length - bad.length}/${v.results.length} skills match the release byte for byte\n`);
  return bad.length ? 1 : 0;
}

function cmdVerify({ root, release }) {
  const rel = release ? path.resolve(release) : findRelease();
  if (!rel) {
    return printVerify({ unverified: true, reason: `could not locate a ${PKG_NAME} release to compare against (pass --release <dir>)` });
  }
  return printVerify(verifyAgainst(rel, installSites(root)));
}

// ------------------------------------------------------------------- upgrade

/** Fetch a published release into workDir/node_modules/<pkg> without a tarball tool. */
function acquireRelease(version, workDir) {
  const injected = process.env.TOOLBAY_UPGRADE_PACKAGE_DIR;
  if (injected) {
    // Used by selftest and by air-gapped installs: a directory already holding
    // the release. It goes through the identical verify afterwards.
    const dir = path.resolve(injected);
    if (!fs.existsSync(path.join(dir, "skills"))) return { ok: false, reason: `TOOLBAY_UPGRADE_PACKAGE_DIR=${dir} has no skills/ directory` };
    return { ok: true, dir };
  }
  fs.mkdirSync(workDir, { recursive: true });
  // Node refuses to spawn a .cmd shim without a shell on Windows, and a shell
  // re-parses the argument vector — so workDir, which lives under a path that
  // on this platform routinely contains spaces ("C:\Users\First Last\..."),
  // has to be quoted by hand. version is already validated by isVersion(), so
  // nothing user-controlled reaches the command line unquoted.
  const win = process.platform === "win32";
  const q = (a) => (win && /[\s&|<>^]/.test(a) ? `"${a}"` : a);
  const npm = win ? "npm.cmd" : "npm";
  const args = ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", workDir, `${PKG_NAME}@${version}`];
  const r = spawnSync(npm, win ? args.map(q) : args, { encoding: "utf8", shell: win });
  if (r.error) return { ok: false, reason: `npm could not be run (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) return { ok: false, reason: `npm install ${PKG_NAME}@${version} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}` };
  const dir = path.join(workDir, "node_modules", PKG_NAME);
  if (!fs.existsSync(path.join(dir, "skills"))) return { ok: false, reason: `npm reported success but ${dir}/skills is not there` };
  return { ok: true, dir };
}

async function cmdUpgrade({ root, to, yes }) {
  const local = localVersion();

  let target = to;
  if (!target) {
    const probe = await probeRemote();
    if (!probe.ok) {
      // Refuse rather than guess. An upgrade whose target version came from a
      // broken probe is how you install nothing and celebrate.
      out(`\n  CHECK_FAILED ${probe.reason}`);
      out(dim("  Refusing to upgrade to an unknown version. Nothing was changed.\n"));
      return 2;
    }
    target = probe.version;
  }
  if (!isVersion(target)) {
    process.stderr.write(`tb-upgrade: ${JSON.stringify(target)} is not a version.\n`);
    return 1;
  }
  if (cmpVersion(target, local) <= 0 && !yes) {
    out(`\n  Already on v${local}${cmpVersion(target, local) === 0 ? "" : ` (the registry has v${target}, which is older)`}. Nothing to do.`);
    out(dim("  Pass --yes to reinstall this version anyway.\n"));
    return 0;
  }

  const sites = installSites(root);
  if (!sites.length) {
    process.stderr.write("tb-upgrade: no installed Toolbay Stack skills found. Run `npx toolbay-stack install --global` first.\n");
    return 1;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-upgrade-"));
  const backupRoot = path.join(work, "backup");
  // Tri-state, not a boolean: "we finished cleanly", "we rolled back cleanly",
  // and "the rollback itself did not complete" need different endings, and only
  // the third one is allowed to leave the backup on disk. A two-state flag here
  // leaked a full copy of every installed skill into TEMP on every successful
  // upgrade, which is the sort of thing that is invisible until a disk fills.
  let keepWork = false;

  try {
    out(`\n  ${bold(`Upgrading Toolbay Stack v${local} -> v${target}`)}\n`);

    const rel = acquireRelease(target, path.join(work, "release"));
    if (!rel.ok) {
      out(`  FAILED to fetch the release: ${rel.reason}`);
      out(dim("  Nothing on disk was touched.\n"));
      return 1;
    }

    // ---- back up everything we are about to overwrite, and hash it, so the
    // ---- restore can be checked rather than assumed.
    const backupHashes = new Map();
    for (const site of sites) {
      for (const name of site.skills) {
        const from = path.join(site.root, name);
        const to2 = path.join(backupRoot, site.scope, name);
        const cp = withRetry(`backing up ${name}`, () => copyTree(from, to2));
        if (!cp.ok) {
          out(`  FAILED: ${cp.error}`);
          out(dim("  Refusing to upgrade something that could not be backed up first.\n"));
          return 1;
        }
        for (const rel2 of walk(to2)) backupHashes.set(`${site.scope}/${name}/${rel2}`, sha256(fs.readFileSync(path.join(to2, rel2))));
      }
    }
    out(`  backed up ${backupHashes.size} files from ${sites.length} install site${sites.length === 1 ? "" : "s"}`);

    // ---- run the release's own installer
    const bin = path.join(rel.dir, "bin", "toolbay-stack.mjs");
    if (!fs.existsSync(bin)) {
      out(`  FAILED: the release has no bin/toolbay-stack.mjs`);
      return 1;
    }
    for (const site of sites) {
      const isGlobal = site.scope === "global";
      const args = ["install", "--force", ...(isGlobal ? ["--global"] : [])];
      // For a project or explicit root, the installer derives the destination
      // from cwd, so put cwd two levels above <root>/.claude/skills.
      let cwd = process.cwd();
      if (!isGlobal) {
        const parts = site.root.split(path.sep);
        if (parts.slice(-2).join("/") === ".claude/skills") cwd = parts.slice(0, -2).join(path.sep) || path.sep;
      }
      const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      out(`  installer (${site.scope}) exited ${r.status}`);
      if (r.status !== 0) {
        out(dim(`    ${(r.stdout || r.stderr || "").trim().split("\n").slice(-4).join("\n    ")}`));
      }
      // A non-zero installer is not fatal on its own — verify below is the
      // authority, and it is stricter than an exit code. But it IS reported,
      // unlike gstack, where `./setup`'s status is discarded by the next line.
    }

    // ---- the step gstack does not have
    const v = verifyAgainst(rel.dir, installSites(root));
    const code = printVerify(v);
    if (code !== 0) {
      out(`  ${bold("Verify failed. Rolling back.")}`);
      for (const site of sites) {
        for (const name of site.skills) {
          const from = path.join(backupRoot, site.scope, name);
          const to2 = path.join(site.root, name);
          const rm = withRetry(`removing ${to2}`, () => fs.rmSync(to2, { recursive: true, force: true }));
          if (!rm.ok) out(`    ${rm.error}`);
          const cp = withRetry(`restoring ${name}`, () => copyTree(from, to2));
          if (!cp.ok) out(`    ${cp.error}`);
        }
      }
      // Check the restore instead of announcing it.
      let bad = 0;
      for (const [key, want] of backupHashes) {
        const [scope, name, ...rest] = key.split("/");
        const site = sites.find((s) => s.scope === scope);
        const f = path.join(site.root, name, ...rest);
        if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== want) bad += 1;
      }
      out(bad === 0
        ? `  Rolled back. All ${backupHashes.size} files restored and re-hashed; the previous version is intact.\n`
        : `  ${bold("ROLLBACK INCOMPLETE")} — ${bad}/${backupHashes.size} files did not come back. A copy is at ${backupRoot}\n`);
      if (bad !== 0) {
        // The one case where the working directory is deliberately kept: the
        // backup is now the only surviving copy of the user's install.
        keepWork = true;
        process.stdout.write(dim(`  Not deleting ${work} so the backup survives.\n\n`));
      }
      return 1;
    }

    writeJson(installedFile(), { version: target, at: Date.now(), sites: sites.map((s) => ({ scope: s.scope, root: s.root, skills: s.skills })) });
    writeJson(markerFile(), { from: local, to: target, at: Date.now() });
    for (const f of [cacheFile(), snoozeFile()]) fs.rmSync(f, { force: true });

    out(`  ${bold(`Toolbay Stack v${target}`)} — upgraded from v${local}, and verified against the release on disk.\n`);
    return 0;
  } finally {
    // The backup is destroyed only on a clean run or a clean rollback. gstack
    // deletes it unconditionally on the line after the ./setup that may have
    // failed, which is why the recovery its own docs prescribe cannot be done.
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- status

function cmdStatus({ root }) {
  const sites = installSites(root);
  out();
  out(`  ${bold(`Toolbay Stack v${localVersion()}`)}  ${dim(`(tb-upgrade ${VERSION}, node ${process.version}, ${process.platform})`)}`);
  out();
  if (!sites.length) out(`  ${dim("no installed Toolbay Stack skills found")}`);
  for (const s of sites) out(`  ${s.scope.padEnd(9)} ${s.skills.length} skills  ${dim(s.root)}`);
  const cached = readJson(cacheFile());
  out();
  if (!cached) out(`  update check   ${dim("never completed, or the cache was cleared")}`);
  else if (cached.probe !== "ok") out(`  update check   ${bold("INVALID CACHE")} ${dim("(no successful probe recorded)")}`);
  else out(`  update check   ${cached.verdict} ${dim(`local ${cached.local}, remote ${cached.remote}, ${Math.round((Date.now() - cached.at) / 60000)} min ago`)}`);
  const rel = findRelease();
  out(`  release found  ${rel ? dim(rel) : bold("none — `verify` will report UNVERIFIED")}`);
  out();
  return 0;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-upgrade-selftest-"));
  // The backup lives in a mkdtemp under the system temp dir, so "did the
  // working directory get cleaned up" is answerable by counting siblings.
  const workDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("tb-upgrade-") && !n.includes("selftest"));
  const run = (args, env = {}, cwd = tmp) => {
    const r = spawnSync(process.execPath, [SELF, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  // ---------------------------------------------------------------- semver
  check("1.10.0 sorts above 1.9.0 (sort -V's string fallback gets this wrong)", 1, cmpVersion("1.10.0", "1.9.0"));
  check("0.2.0.1 sorts above 0.2.0", 1, cmpVersion("0.2.0.1", "0.2.0"));
  check("equal versions compare equal", 0, cmpVersion("1.2.3", "1.2.3"));

  // ------------------------------------------ the constant cannot drift silently
  {
    const repo = findRelease();
    if (repo && fs.existsSync(path.join(repo, "package.json"))) {
      const pkg = readJson(path.join(repo, "package.json"));
      check("STACK_VERSION matches the repo's package.json", pkg.version, STACK_VERSION, repo);
    } else {
      check("STACK_VERSION check skipped outside a checkout", true, true);
    }
  }

  // ----------------------------------------------- update check, failing probes
  // Each of these produced `UP_TO_DATE` in gstack. Every one must now refuse.
  const badProbes = [
    ["an unreachable registry", "http://127.0.0.1:9/nope"],
    ["a captive-portal HTML page", "html"],
    ["a JSON object with no version", "noversion"],
    ["a JSON version that is not a version", "badversion"],
    ["an empty body", "empty"],
    ["a registry path that does not exist", path.join(tmp, "definitely-absent.json")],
  ];
  fs.writeFileSync(path.join(tmp, "html"), "<!doctype html><title>Sign in to the WiFi</title>", "utf8");
  fs.writeFileSync(path.join(tmp, "noversion"), JSON.stringify({ name: PKG_NAME }), "utf8");
  fs.writeFileSync(path.join(tmp, "badversion"), JSON.stringify({ version: "latest" }), "utf8");
  fs.writeFileSync(path.join(tmp, "empty"), "", "utf8");
  fs.writeFileSync(path.join(tmp, "good-newer"), JSON.stringify({ version: "99.0.0" }), "utf8");
  fs.writeFileSync(path.join(tmp, "good-same"), JSON.stringify({ version: STACK_VERSION }), "utf8");
  fs.writeFileSync(path.join(tmp, "good-older"), JSON.stringify({ version: "0.0.1" }), "utf8");

  for (const [label, url] of badProbes) {
    const st = path.join(tmp, `state-${label.replace(/\W+/g, "-")}`);
    const target = /^https?:/.test(url) ? url : path.isAbsolute(url) ? url : path.join(tmp, url);
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: target });
    check(`check refuses ${label}`, 2, r.status, r.stdout.trim());
    check(`...and says CHECK_FAILED for ${label}`, true, /^CHECK_FAILED /m.test(r.stdout), r.stdout.trim());
    check(`...and writes NO cache for ${label}`, false, fs.existsSync(path.join(st, "last-update-check.json")), st);
  }

  // ------------------------------------------------ update check, good probes
  {
    const st = path.join(tmp, "state-newer");
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    check("a real newer version reports UPGRADE_AVAILABLE", true, /^UPGRADE_AVAILABLE \S+ 99\.0\.0$/m.test(r.stdout), r.stdout.trim());
    check("...exit 0", 0, r.status);
    const cached = readJson(path.join(st, "last-update-check.json"));
    check("...and the cache records a successful probe", "ok", cached?.probe, JSON.stringify(cached));
  }
  {
    const st = path.join(tmp, "state-same");
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-same") });
    check("the same version prints nothing", "", r.stdout.trim());
    check("...exit 0", 0, r.status);
  }
  {
    const st = path.join(tmp, "state-older");
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-older") });
    check("a registry serving an OLDER version never offers a downgrade", "", r.stdout.trim());
  }

  // ---------------------------------------------- cache expiry, computed in node
  {
    const st = path.join(tmp, "state-stale");
    fs.mkdirSync(st, { recursive: true });
    // A verdict from ten years ago, with a real mtime of right now — which is
    // what gstack's `find -mmin` looks at, and what Windows find.exe cannot
    // look at at all.
    writeJson(path.join(st, "last-update-check.json"), {
      probe: "ok", verdict: "UP_TO_DATE", local: STACK_VERSION, remote: STACK_VERSION, at: Date.now() - 10 * 365 * 24 * 3600e3,
    });
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    check("a ten-year-old cache entry is stale and gets re-probed", true, /UPGRADE_AVAILABLE/.test(r.stdout), r.stdout.trim());
  }
  {
    const st = path.join(tmp, "state-corrupt");
    fs.mkdirSync(st, { recursive: true });
    fs.writeFileSync(path.join(st, "last-update-check.json"), "{ not json at all", "utf8");
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    check("a corrupt cache is re-probed rather than trusted", true, /UPGRADE_AVAILABLE/.test(r.stdout), r.stdout.trim());
  }
  {
    const st = path.join(tmp, "state-forged");
    fs.mkdirSync(st, { recursive: true });
    // A cache entry that looks right but was never backed by a probe. gstack
    // has no such distinction: its cache file is one line of text.
    writeJson(path.join(st, "last-update-check.json"), { verdict: "UP_TO_DATE", local: STACK_VERSION, remote: STACK_VERSION, at: Date.now() });
    const r = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    check("a cache entry with no recorded probe is not a verdict", true, /UPGRADE_AVAILABLE/.test(r.stdout), r.stdout.trim());
  }

  // ------------------------------------------------------------------- verify
  // Build a tiny but real release: two skills, one of them hook-registering.
  const release = path.join(tmp, "release");
  const mkSkill = (root, name, body, files = {}) => {
    const d = path.join(root, "skills", name);
    fs.mkdirSync(path.join(d, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), body, "utf8");
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), content, "utf8");
    return d;
  };
  fs.mkdirSync(path.join(release, "bin"), { recursive: true });
  writeJson(path.join(release, "package.json"), { name: PKG_NAME, version: "99.0.0" });
  const hookMd =
    "---\nname: alpha\nversion: 9.9.9\n---\n\n# alpha\n\nToolbay Stack, Copyright (c) 2026 Toolbay. MIT.\n" +
    "hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n" +
    '          command: "node $HOME/.claude/skills/alpha/scripts/tb-guard.mjs careful"\n';
  mkSkill(release, "alpha", hookMd, { "scripts/engine.mjs": "// alpha engine\n" });
  mkSkill(release, "beta", "---\nname: beta\n---\n\n# beta\n\nToolbay Stack, Copyright (c) 2026 Toolbay. MIT.\n", { "scripts/b.mjs": "// beta\n" });

  // A healthy install: exactly the release, with the hook line pinned the way
  // the real installer pins it.
  const goodRoot = path.join(tmp, "good", ".claude", "skills");
  fs.mkdirSync(goodRoot, { recursive: true });
  copyTree(path.join(release, "skills"), goodRoot);
  {
    const md = path.join(goodRoot, "alpha", "SKILL.md");
    fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace(/command:.*/, `command: 'node "${goodRoot.replace(/\\/g, "/")}/alpha/scripts/tb-guard.mjs" careful'`), "utf8");
  }
  {
    const r = run(["verify", "--root", goodRoot, "--release", release]);
    check("verify passes on a healthy install", 0, r.status, r.stdout.trim());
    check("...even though the hook path was rewritten at install time", true, /2\/2 skills match/.test(r.stdout), r.stdout.trim());
  }

  // The Windows failure: one file was locked during the copy, so it never landed.
  const partialRoot = path.join(tmp, "partial", ".claude", "skills");
  fs.mkdirSync(partialRoot, { recursive: true });
  copyTree(path.join(release, "skills"), partialRoot);
  fs.rmSync(path.join(partialRoot, "alpha", "scripts", "engine.mjs"), { force: true });
  {
    const r = run(["verify", "--root", partialRoot, "--release", release]);
    check("verify FAILS when one file never landed", 1, r.status, r.stdout.trim());
    check("...and names the missing file", true, /scripts\/engine\.mjs/.test(r.stdout), r.stdout.trim());
  }

  // A truncated file: present, right name, wrong bytes.
  const truncRoot = path.join(tmp, "trunc", ".claude", "skills");
  fs.mkdirSync(truncRoot, { recursive: true });
  copyTree(path.join(release, "skills"), truncRoot);
  fs.writeFileSync(path.join(truncRoot, "beta", "scripts", "b.mjs"), "// bet", "utf8");
  {
    const r = run(["verify", "--root", truncRoot, "--release", release]);
    check("verify FAILS on a truncated file that is the right size on a bad day", 1, r.status, r.stdout.trim());
    check("...and says it differs", true, /DRIFT/.test(r.stdout) && /b\.mjs/.test(r.stdout), r.stdout.trim());
  }

  // No release to compare against: must be UNVERIFIED, never a pass.
  {
    const r = run(["verify", "--root", goodRoot, "--release", path.join(tmp, "no-such-release")], { TOOLBAY_UPGRADE_PACKAGE_DIR: "" });
    check("verify with no release is UNVERIFIED, not OK", 1, r.status, r.stdout.trim());
    check("...and says UNVERIFIED out loud", true, /UNVERIFIED/.test(r.stdout), r.stdout.trim());
  }

  // ------------------------------------------------------- upgrade + rollback
  // A release whose installer deliberately skips one file — precisely the
  // locked-file case gstack's own Windows note warns about, and precisely the
  // case where gstack prints "upgraded!" anyway.
  const badRelease = path.join(tmp, "bad-release");
  fs.mkdirSync(path.join(badRelease, "bin"), { recursive: true });
  writeJson(path.join(badRelease, "package.json"), { name: PKG_NAME, version: "99.0.0" });
  copyTree(path.join(release, "skills"), path.join(badRelease, "skills"));
  fs.writeFileSync(path.join(badRelease, "skills", "alpha", "scripts", "engine.mjs"), "// alpha engine v99\n", "utf8");
  fs.writeFileSync(
    path.join(badRelease, "bin", "toolbay-stack.mjs"),
    [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const root = path.join(process.cwd(), '.claude', 'skills');",
      "const src = path.join(new URL('..', import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'), 'skills');",
      "function cp(a,b){ fs.mkdirSync(b,{recursive:true}); for (const e of fs.readdirSync(a)) {",
      "  const s=path.join(a,e), d=path.join(b,e);",
      "  if (fs.statSync(s).isDirectory()) cp(s,d);",
      "  else if (e === 'engine.mjs') { /* locked by another process, skipped */ }",
      "  else fs.writeFileSync(d, fs.readFileSync(s)); } }",
      "fs.rmSync(root,{recursive:true,force:true}); cp(src, root);",
      "console.log('installed'); process.exit(0);",
    ].join("\n"),
    "utf8",
  );

  {
    const proj = path.join(tmp, "rollback");
    const projRoot = path.join(proj, ".claude", "skills");
    fs.mkdirSync(projRoot, { recursive: true });
    copyTree(path.join(release, "skills"), projRoot);
    const engine = path.join(projRoot, "alpha", "scripts", "engine.mjs");
    const before = fs.readFileSync(engine, "utf8");
    const workBefore = workDirs().length;

    const st = path.join(tmp, "state-rollback");
    const r = run(["upgrade", "--root", projRoot, "--to", "99.0.0"], {
      TOOLBAY_STACK_STATE_DIR: st,
      TOOLBAY_UPGRADE_PACKAGE_DIR: badRelease,
    }, proj);

    check("an upgrade whose install lost a file exits non-zero", 1, r.status, r.stdout.trim().slice(-400));
    check("...says it is rolling back", true, /Rolling back/.test(r.stdout), r.stdout.trim().slice(-400));
    check("...restores the file the installer dropped", true, fs.existsSync(engine), engine);
    check("...byte for byte", before, fs.existsSync(engine) ? fs.readFileSync(engine, "utf8") : "<gone>");
    check("...re-hashes the restore instead of announcing it", true, /restored and re-hashed/.test(r.stdout), r.stdout.trim().slice(-400));
    check("...and does NOT record the new version as installed", false, readJson(path.join(st, "installed.json"))?.version === "99.0.0");
    check("...and does NOT write a just-upgraded marker", false, fs.existsSync(path.join(st, "just-upgraded-from.json")));
    check("...and leaves no backup behind once the rollback verified", workBefore, workDirs().length, workDirs().join(", "));
  }

  // The same pipeline with an installer that copies everything: must succeed,
  // and must record it.
  {
    const goodRelease = path.join(tmp, "good-release");
    fs.mkdirSync(path.join(goodRelease, "bin"), { recursive: true });
    writeJson(path.join(goodRelease, "package.json"), { name: PKG_NAME, version: "99.0.0" });
    copyTree(path.join(badRelease, "skills"), path.join(goodRelease, "skills"));
    fs.writeFileSync(
      path.join(goodRelease, "bin", "toolbay-stack.mjs"),
      fs.readFileSync(path.join(badRelease, "bin", "toolbay-stack.mjs"), "utf8").replace(
        "else if (e === 'engine.mjs') { /* locked by another process, skipped */ }",
        "",
      ),
      "utf8",
    );

    const proj = path.join(tmp, "clean");
    const projRoot = path.join(proj, ".claude", "skills");
    fs.mkdirSync(projRoot, { recursive: true });
    copyTree(path.join(release, "skills"), projRoot);
    const st = path.join(tmp, "state-clean");
    const workBefore = workDirs().length;
    const r = run(["upgrade", "--root", projRoot, "--to", "99.0.0"], {
      TOOLBAY_STACK_STATE_DIR: st,
      TOOLBAY_UPGRADE_PACKAGE_DIR: goodRelease,
    }, proj);

    check("a complete install verifies and exits 0", 0, r.status, r.stdout.trim().slice(-400));
    check("...and says it verified against the release on disk", true, /verified against the release on disk/.test(r.stdout), r.stdout.trim().slice(-300));
    check("...records the installed version", "99.0.0", readJson(path.join(st, "installed.json"))?.version);
    check("...and the new bytes are really there", "// alpha engine v99\n", fs.readFileSync(path.join(projRoot, "alpha", "scripts", "engine.mjs"), "utf8"));
    check("...and the temp backup is cleaned up, not leaked into TEMP", workBefore, workDirs().length, workDirs().join(", "));

    // JUST_UPGRADED is emitted once and then the marker is consumed.
    const c1 = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-same") });
    check("the next check reports JUST_UPGRADED once", true, /^JUST_UPGRADED \S+ 99\.0\.0$/m.test(c1.stdout), c1.stdout.trim());
    const c2 = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-same") });
    check("...and not twice", false, /JUST_UPGRADED/.test(c2.stdout), c2.stdout.trim());
  }

  // An upgrade with a broken update check must not proceed on a guessed target.
  {
    const proj = path.join(tmp, "noprobe");
    const projRoot = path.join(proj, ".claude", "skills");
    fs.mkdirSync(projRoot, { recursive: true });
    copyTree(path.join(release, "skills"), projRoot);
    const before = fs.readFileSync(path.join(projRoot, "alpha", "scripts", "engine.mjs"), "utf8");
    const r = run(["upgrade", "--root", projRoot], {
      TOOLBAY_STACK_STATE_DIR: path.join(tmp, "state-noprobe"),
      TOOLBAY_UPGRADE_REGISTRY_URL: "http://127.0.0.1:9/nope",
      TOOLBAY_UPGRADE_PACKAGE_DIR: badRelease,
    }, proj);
    check("upgrade refuses when the update check itself failed", 2, r.status, r.stdout.trim());
    check("...and changes nothing on disk", before, fs.readFileSync(path.join(projRoot, "alpha", "scripts", "engine.mjs"), "utf8"));
  }

  // ------------------------------------------------------------------ snooze
  {
    const st = path.join(tmp, "state-snooze");
    run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    const s1 = run(["snooze"], { TOOLBAY_STACK_STATE_DIR: st });
    check("first snooze is 24h", true, /24h/.test(s1.stdout), s1.stdout.trim());
    const after = run(["check"], { TOOLBAY_STACK_STATE_DIR: st, TOOLBAY_UPGRADE_REGISTRY_URL: path.join(tmp, "good-newer") });
    check("...and the upgrade stops being announced", "", after.stdout.trim());
    run(["snooze"], { TOOLBAY_STACK_STATE_DIR: st });
    const s3 = run(["snooze"], { TOOLBAY_STACK_STATE_DIR: st });
    check("the third snooze escalates to a week", true, /1 week/.test(s3.stdout), s3.stdout.trim());
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-upgrade selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    return 1;
  }
  out("\n  Every refusal above is a case where gstack's upgrade path returns a");
  out("  cheerful answer instead: a failed probe cached as UP_TO_DATE, a cache that");
  out("  never expires because Windows find.exe has no -mmin, and a backup deleted");
  out("  on the line after the setup that failed.\n");
  return 0;
}

// ---------------------------------------------------------------------- main

function help() {
  out(`
  tb-upgrade ${VERSION} — upgrade Toolbay Stack, and prove it landed.

    check [--force]      is a newer release published? Prints one of
                         UPGRADE_AVAILABLE <old> <new>, JUST_UPGRADED <old> <new>,
                         CHECK_FAILED <reason>, or nothing when current.
                         Exits 2 when the check itself could not complete —
                         a broken check is never reported as "up to date".
    upgrade [--to V]     back up, install, verify against the release on disk,
                         and roll back if the verify fails. The backup is
                         deleted only after the verify passes.
    verify               compare every installed file against the release by
                         SHA-256. Reports UNVERIFIED and exits non-zero when
                         there is no release to compare against.
    status               versions, install sites, and the state of the cache.
    snooze               quiet the reminder, escalating 24h / 48h / 1 week.
    selftest             run the whole pipeline against a deliberately partial
                         release and assert the rollback happened.

  Options
    --root <dir>         treat <dir> as the skills root (tests, odd layouts)
    --release <dir>      compare against this release instead of auto-detecting
    --to <version>       upgrade to a specific version
    --yes                reinstall even when already current
    --force              ignore the cache and re-probe

  Environment
    TOOLBAY_STACK_STATE_DIR       where cache/marker/snooze live
    TOOLBAY_UPGRADE_REGISTRY_URL  registry URL, or a path to a JSON file
    TOOLBAY_UPGRADE_PACKAGE_DIR   use a release already on disk

  Every path that cannot reach a confident answer exits non-zero and names the
  check that could not complete.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--root" && argv[argv.indexOf(a) - 1] !== "--release" && argv[argv.indexOf(a) - 1] !== "--to");

  const opts = { root: val("--root"), release: val("--release"), to: val("--to"), force: flag("--force"), yes: flag("--yes"), quiet: flag("--quiet") };

  if (cmd === "check") return cmdCheck(opts);
  if (cmd === "upgrade") return cmdUpgrade(opts);
  if (cmd === "verify") return cmdVerify(opts);
  if (cmd === "status") return cmdStatus(opts);
  if (cmd === "snooze") return cmdSnooze();
  if (cmd === "selftest") return selftest();
  help();
  return cmd ? 1 : 0;
}

// Nothing below turns a crash into a success. A self-upgrade tool that dies
// mid-flight and exits 0 is the same class of bug as a cached UP_TO_DATE.
main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write(`tb-upgrade: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
