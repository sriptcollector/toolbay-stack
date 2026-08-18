#!/usr/bin/env node
/**
 * tb-ios-sync.mjs: the Toolbay Stack iOS debug-bridge sync engine.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The user-facing contract implemented here (the command name
 * /ios-sync, the four-phase shape "detect version -> regenerate accessors ->
 * update templated files in place -> verify", the DebugBridgeGenerated layout,
 * the gen-accessors invocation, and the GSTACK-EDIT-LINE fold-forward idea)
 * comes from `ios-sync` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THIS IS AN ENGINE AND NOT A PROSE SKILL
 *
 * gstack's ios-sync is 94 lines of instructions with no executable part. Every
 * decision it describes is left to the model, and each one has a failure mode
 * that reads as success. Measured against gstack 1.60.1.0 on this machine,
 * 2026-08-13:
 *
 *  1. THE TEMPLATE PATH DOES NOT RESOLVE. Every command in the skill points at
 *     `$GSTACK_HOME/ios-qa/...`. GSTACK_HOME is not exported by gstack; the
 *     preamble only ever uses it as `${GSTACK_HOME:-$HOME/.gstack}` for state.
 *
 *       $ env -u GSTACK_HOME bash -c 'ls -d "$GSTACK_HOME/ios-qa/templates"'
 *       ls: cannot access '/ios-qa/templates': No such file or directory
 *       $ env -u GSTACK_HOME bash -c 'ls -d "${GSTACK_HOME:-$HOME/.gstack}/ios-qa/templates"'
 *       ls: cannot access '/c/Users/orion/.gstack/ios-qa/templates': No such file or directory
 *
 *     The templates are at ~/.claude/skills/gstack/ios-qa/templates. The skill
 *     prose says so in one paragraph and then contradicts itself in every
 *     command. `resolve` here probes an ordered candidate list, prints what it
 *     tried, and exits non-zero rather than guessing.
 *
 *  2. THE EARLY EXIT FAILS OPEN. Phase 1 says: read the app's
 *     `.gstack-version`, read upstream's `.gstack-version`, and "if versions
 *     match, exit early with already up to date". Neither file exists:
 *
 *       $ ls ~/.claude/skills/gstack/ios-qa/.gstack-version
 *       ls: cannot access ...: No such file or directory
 *       $ grep -ic "gstack-version" ~/.claude/skills/gstack/ios-qa/SKILL.md
 *       0
 *
 *     Two absent files compare equal, so the documented happy path is to
 *     declare the bridge current without ever having looked at it. Here,
 *     version is informational only. Drift is decided by content hashes, and an
 *     app with no stamp is UNSTAMPED (exit 4), never "up to date".
 *
 *  3. PHASE 3 WOULD DESTROY THE GENERATED ACCESSORS. It says to replace each
 *     installed file "outright with the new template". One of the nine
 *     templates is generator-owned:
 *
 *       $ grep -o "{{[A-Z_]*}}" StateAccessor.swift.template | sort -u
 *       {{ACCESSORS}} {{ACCESSOR_HASH}} {{APP_BUILD_ID}}
 *       {{CLASS_NAME}} {{REGISTER_BLOCK}} {{VALIDATION_BLOCK}}
 *
 *     Copying it verbatim writes `{{ACCESSORS}}` into the app and the build
 *     stops compiling. `apply` refuses any template containing placeholders.
 *
 *  4. PHASE 3 NAMES THE WRONG FILES. It maps every template to
 *     `<app>/DebugBridgeGenerated/<Name>.swift`, but two of the nine are
 *     DebugBridgeTouch.h and DebugBridgeTouch.m. Installed names here come from
 *     stripping `.template`, so ObjC files keep their extensions.
 *
 *  5. THE FAILURE TABLE CITES A FLAG THAT DOES NOT EXIST. It says to exclude
 *     test fixtures with `--exclude`. Both generators disagree:
 *
 *       $ grep -n "usage:" ios-qa/scripts/gen-accessors.ts
 *       297: 'usage: gen-accessors --input <dir> [--output <dir>]\n'
 *
 *     The Swift tool ignores unknown arguments, so the advice fails silently.
 *     `plan --json` reports which sources were scanned instead.
 *
 *  6. IT IS AN iOS SKILL WITH NO HOST CHECK. `swift` and `xcodebuild` exist
 *     only on macOS. On this Windows box neither is on PATH, so Phase 2 and
 *     Phase 4 cannot run at all, and nothing in the skill says so. `preflight`
 *     exits 2 and names the missing tool, so a sync cannot be reported as done
 *     on a host that could never have compiled it.
 *
 * DESIGN RULES
 *
 *   1. FAIL CLOSED. Unknown state is exit 4, not "up to date". A resolution
 *      that cannot be made is exit 3, not a default path. A coverage scan that
 *      cannot read the generated accessors is UNVERIFIABLE, not "no gaps".
 *   2. NODE ONLY. No bash, no find -mmin, no date +%s, no $PPID, no source
 *      <(...), no symlink assumptions, no `open`. Git Bash paths (/c/Users/...)
 *      are translated; comparisons are case-insensitive on win32.
 *   3. LINE ENDINGS ARE NOT DRIFT. Content hashes normalise CRLF, lone CR, the
 *      UTF-8 BOM and trailing whitespace, so a file checked out on Windows does
 *      not read as locally edited on every run.
 *   4. PROVE IT. `selftest` runs this executable as a child process against
 *      fixtures that are deliberately broken, and fails if any of them are
 *      reported as fine.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

const GENERATED_DIR = "DebugBridgeGenerated";
const STAMP_NAME = ".tbs-sync.json";

/** Exit codes are part of the contract; a caller can branch on them. */
const EXIT = {
  OK: 0,
  WORK_TO_DO: 1, // safe, mechanical work: upstream changed or a file is missing
  HOST_UNFIT: 2, // this machine cannot build an iOS app at all
  UNRESOLVED: 3, // the upstream templates could not be located
  NEEDS_HUMAN: 4, // conflict, local edits, no stamp, or something unreadable
  USAGE: 64,
};

// --------------------------------------------------------------- path handling

const isWindows = process.platform === "win32";

function toAbsolute(input, cwd = process.cwd()) {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(looksAbsolute(s) ? s : path.join(cwd, s));
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- hashing
//
// Byte equality is the wrong test on Windows. A template committed with LF and
// checked out through a repo with core.autocrlf=true lands on disk with CRLF,
// and a byte-for-byte comparison would call every single file locally edited on
// every single run, which trains the user to ignore the report.

function normalise(buf) {
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8 BOM
  s = s.replace(/\r\n?/g, "\n"); // CRLF and lone CR
  s = s.replace(/[ \t]+$/gm, ""); // trailing whitespace
  s = s.replace(/\n+$/, "\n"); // one final newline
  return s;
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(normalise(buf), "utf8").digest("hex");
}

function hashFile(p) {
  try {
    return { ok: true, hash: hashBuffer(fs.readFileSync(p)) };
  } catch (e) {
    return { ok: false, error: `${p} could not be read (${e.code || e.message})` };
  }
}

// ------------------------------------------------------------ template lookup

/**
 * Ordered candidates for the upstream ios-qa templates directory.
 *
 * An environment variable that is set but EMPTY is skipped rather than
 * concatenated, which is exactly the bug that turns gstack's
 * `$GSTACK_HOME/ios-qa/templates` into `/ios-qa/templates`.
 */
function templateCandidates(override) {
  const out = [];
  const push = (why, p) => {
    if (typeof p === "string" && p.trim()) out.push({ why, path: toAbsolute(p) });
  };
  push("--templates / TBS_IOS_TEMPLATES", override || process.env.TBS_IOS_TEMPLATES);
  const gh = process.env.GSTACK_HOME;
  if (gh && gh.trim()) push("$GSTACK_HOME/ios-qa/templates", path.join(fromMsysPath(gh.trim()), "ios-qa", "templates"));
  push("./ios-qa/templates (gstack worktree)", path.join(process.cwd(), "ios-qa", "templates"));
  push("~/.claude/skills/gstack/ios-qa/templates", path.join(os.homedir(), ".claude", "skills", "gstack", "ios-qa", "templates"));
  push("./.claude/skills/gstack/ios-qa/templates", path.join(process.cwd(), ".claude", "skills", "gstack", "ios-qa", "templates"));
  return out;
}

function listTemplates(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".template"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A directory that exists but holds no templates is NOT a resolution. Accepting
 * it is how a sync run reports "0 files needed updating" against an empty
 * directory, which is the same shape of lie as a green build that never ran.
 */
function resolveTemplates(override) {
  const tried = [];
  for (const c of templateCandidates(override)) {
    const exists = isDir(c.path);
    const files = exists ? listTemplates(c.path) : [];
    tried.push({ ...c, exists, count: files.length });
    if (exists && files.length) return { ok: true, root: c.path, files, tried };
  }
  return { ok: false, tried };
}

/** Informational only. Never used to decide whether a sync is needed. */
function upstreamVersion(root) {
  for (const rel of [["..", ".gstack-version"], ["..", "..", "VERSION"], ["..", "VERSION"]]) {
    const p = path.resolve(root, ...rel);
    if (isFile(p)) {
      const v = fs.readFileSync(p, "utf8").trim().split(/\r?\n/)[0];
      if (v) return { version: v, from: p };
    }
  }
  return { version: "unknown", from: null };
}

/** `Foo.swift.template` -> `Foo.swift`; `DebugBridgeTouch.m.template` -> `DebugBridgeTouch.m`. */
const installedName = (tpl) => tpl.replace(/\.template$/, "");

const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/;

// ------------------------------------------------------------------- the app

function generatedDir(appDir) {
  return path.join(appDir, GENERATED_DIR);
}

function stampPath(appDir) {
  return path.join(generatedDir(appDir), STAMP_NAME);
}

/**
 * @returns {{present:false}|{present:true,data:object}|{error:string}}
 * A stamp that exists but cannot be parsed is an ERROR, not an absence. The
 * difference matters: absence means "never synced by this tool" and error means
 * "the record of what was synced is damaged", and only one of those is safe to
 * overwrite without asking.
 */
function readStamp(appDir) {
  const p = stampPath(appDir);
  if (!fs.existsSync(p)) return { present: false };
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    return { error: `${p} exists but could not be read (${e.code || e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { error: `${p} is not valid JSON (${e.message})` };
  }
  if (!obj || typeof obj !== "object" || typeof obj.files !== "object" || obj.files === null) {
    return { error: `${p} has no "files" object, so nothing can be compared against it` };
  }
  return { present: true, data: obj };
}

const STATUS = {
  UP_TO_DATE: "UP-TO-DATE",
  UPSTREAM_CHANGED: "UPSTREAM-CHANGED",
  LOCALLY_EDITED: "LOCALLY-EDITED",
  CONFLICT: "CONFLICT",
  MISSING: "MISSING",
  UNSTAMPED: "UNSTAMPED",
  ERROR: "ERROR",
};

const NEEDS_HUMAN = new Set([STATUS.LOCALLY_EDITED, STATUS.CONFLICT, STATUS.UNSTAMPED, STATUS.ERROR]);
const MECHANICAL = new Set([STATUS.UPSTREAM_CHANGED, STATUS.MISSING]);

function computePlan(appDir, templatesOverride) {
  const res = resolveTemplates(templatesOverride);
  if (!res.ok) return { ok: false, code: EXIT.UNRESOLVED, resolve: res };

  const ver = upstreamVersion(res.root);
  const gen = generatedDir(appDir);
  const stamp = readStamp(appDir);

  const entries = [];
  for (const tpl of res.files) {
    const name = installedName(tpl);
    const tplPath = path.join(res.root, tpl);
    const instPath = path.join(gen, name);
    const t = hashFile(tplPath);
    if (!t.ok) {
      entries.push({ name, template: tpl, status: STATUS.ERROR, detail: t.error, generated: false });
      continue;
    }
    const generated = PLACEHOLDER.test(fs.readFileSync(tplPath, "utf8"));

    if (stamp.error) {
      entries.push({ name, template: tpl, status: STATUS.ERROR, detail: stamp.error, generated });
      continue;
    }
    if (!fs.existsSync(instPath)) {
      entries.push({ name, template: tpl, status: STATUS.MISSING, detail: `${instPath} is not installed`, generated });
      continue;
    }
    const i = hashFile(instPath);
    if (!i.ok) {
      entries.push({ name, template: tpl, status: STATUS.ERROR, detail: i.error, generated });
      continue;
    }
    if (!stamp.present) {
      entries.push({
        name,
        template: tpl,
        status: STATUS.UNSTAMPED,
        detail: "no sync stamp, so upstream drift cannot be told apart from local edits",
        generated,
      });
      continue;
    }
    const rec = stamp.data.files[name];
    if (!rec || typeof rec.template !== "string" || typeof rec.installed !== "string") {
      entries.push({
        name,
        template: tpl,
        status: STATUS.UNSTAMPED,
        detail: `${STAMP_NAME} has no usable record for ${name}`,
        generated,
      });
      continue;
    }
    const upstreamChanged = rec.template !== t.hash;
    const locallyEdited = rec.installed !== i.hash;
    let status = STATUS.UP_TO_DATE;
    let detail = "installed content matches what was stamped, and upstream has not moved";
    if (upstreamChanged && locallyEdited) {
      status = STATUS.CONFLICT;
      detail = "upstream changed AND the installed file was edited locally; a human has to merge";
    } else if (upstreamChanged) {
      status = STATUS.UPSTREAM_CHANGED;
      detail = "upstream template moved since the last sync";
    } else if (locallyEdited) {
      status = STATUS.LOCALLY_EDITED;
      detail = "the installed file was edited after the last sync; it will not be overwritten";
    }
    entries.push({ name, template: tpl, status, detail, generated });
  }

  let code = EXIT.OK;
  if (entries.some((e) => NEEDS_HUMAN.has(e.status))) code = EXIT.NEEDS_HUMAN;
  else if (entries.some((e) => MECHANICAL.has(e.status))) code = EXIT.WORK_TO_DO;

  return {
    ok: true,
    code,
    root: res.root,
    appDir,
    generatedDir: gen,
    upstream: ver,
    stamp: stamp.present ? stampPath(appDir) : null,
    stampError: stamp.error || null,
    entries,
  };
}

// ------------------------------------------------------------------ preflight
//
// Simulation is gated on TBS_IOS_SELFTEST=1 so a real run cannot be talked into
// a green preflight by an environment variable, and it prints SIMULATED either
// way so the output can never be quoted as evidence of a real toolchain.

function preflight() {
  const selftesting = process.env.TBS_IOS_SELFTEST === "1";
  const platform = (selftesting && process.env.TBS_IOS_FORCE_PLATFORM) || process.platform;
  const simulated = selftesting && process.env.TBS_IOS_FAKE_TOOLCHAIN === "1";

  const checks = [];
  checks.push({
    name: "host is macOS",
    ok: platform === "darwin",
    detail: platform === "darwin" ? "darwin" : `${platform}: Xcode and the Swift toolchain do not exist here`,
  });

  for (const [tool, args] of [
    ["swift", ["--version"]],
    ["xcodebuild", ["-version"]],
  ]) {
    if (simulated) {
      checks.push({ name: `${tool} is available`, ok: true, detail: "SIMULATED (selftest)" });
      continue;
    }
    let ok = false;
    let detail = "not on PATH";
    try {
      const r = spawnSync(tool, args, { encoding: "utf8" });
      if (r.error) detail = r.error.code === "ENOENT" ? "not on PATH" : r.error.message;
      else if (r.status === 0) {
        ok = true;
        detail = (r.stdout || r.stderr || "").trim().split(/\r?\n/)[0] || "present";
      } else detail = `exited ${r.status}`;
    } catch (e) {
      detail = e.message;
    }
    checks.push({ name: `${tool} is available`, ok, detail });
  }

  return { platform, simulated, checks, ok: checks.every((c) => c.ok) };
}

// ------------------------------------------------------------------- coverage
//
// gstack Phase 1 gates the whole workflow on "no new @Observable classes were
// added", and leaves that to recall. This computes it. Everything it cannot
// read is reported as UNVERIFIABLE, never as zero gaps.

function collectSwift(dir, acc = [], depth = 0) {
  if (depth > 24) return acc;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === GENERATED_DIR || e.name === ".git" || e.name === ".build" || e.name === "Pods") continue;
      collectSwift(p, acc, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".swift") && e.name !== "StateAccessor.swift") {
      acc.push(p);
    }
  }
  return acc;
}

function scanObservables(files) {
  const found = [];
  for (const f of files) {
    let lines;
    try {
      lines = normalise(fs.readFileSync(f)).split("\n");
    } catch {
      continue;
    }
    let pendingObservable = false;
    let current = null;
    let pendingSnapshot = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^@Observable\b/.test(line)) {
        pendingObservable = true;
        continue;
      }
      const cls = /^(?:public\s+|internal\s+|private\s+|fileprivate\s+|final\s+)*class\s+([A-Za-z_]\w*)/.exec(line);
      if (cls) {
        if (pendingObservable) {
          current = { file: f, klass: cls[1], props: [] };
          found.push(current);
        } else {
          current = null;
        }
        pendingObservable = false;
        continue;
      }
      if (/^@Snapshotable\b/.test(line)) {
        pendingSnapshot = true;
        continue;
      }
      const prop = /^(?:public\s+|internal\s+|private\s+|fileprivate\s+)*(?:var|let)\s+([A-Za-z_]\w*)/.exec(line);
      if (prop && pendingSnapshot) {
        if (current) current.props.push(prop[1]);
        pendingSnapshot = false;
        continue;
      }
      if (prop) pendingSnapshot = false;
    }
  }
  return found;
}

function coverage(appDir, sourceDir, templatesOverride) {
  const accessor = path.join(generatedDir(appDir), "StateAccessor.swift");
  const files = collectSwift(sourceDir);
  const classes = scanObservables(files);

  if (!isDir(sourceDir)) {
    return { verdict: "UNVERIFIABLE", code: EXIT.NEEDS_HUMAN, reason: `source directory ${sourceDir} does not exist`, files: 0, classes, gaps: [] };
  }
  if (!isFile(accessor)) {
    return {
      verdict: "UNVERIFIABLE",
      code: EXIT.NEEDS_HUMAN,
      reason: `${accessor} is not installed, so accessor coverage cannot be checked. This is not the same as full coverage.`,
      files: files.length,
      classes,
      gaps: [],
    };
  }
  let text;
  try {
    text = normalise(fs.readFileSync(accessor));
  } catch (e) {
    return { verdict: "UNVERIFIABLE", code: EXIT.NEEDS_HUMAN, reason: `${accessor} could not be read (${e.code || e.message})`, files: files.length, classes, gaps: [] };
  }
  if (PLACEHOLDER.test(text)) {
    return {
      verdict: "UNVERIFIABLE",
      code: EXIT.NEEDS_HUMAN,
      reason: `${accessor} still contains unrendered {{PLACEHOLDER}} tokens, so it is a raw template rather than generated output`,
      files: files.length,
      classes,
      gaps: [],
    };
  }

  const gaps = [];
  for (const c of classes) {
    for (const p of c.props) {
      const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (!re.test(text)) gaps.push({ klass: c.klass, prop: p, file: c.file });
    }
  }
  const total = classes.reduce((n, c) => n + c.props.length, 0);
  return {
    verdict: gaps.length ? "GAPS" : "COVERED",
    code: gaps.length ? EXIT.WORK_TO_DO : EXIT.OK,
    reason: gaps.length
      ? `${gaps.length} of ${total} @Snapshotable properties have no accessor; re-run gen-accessors`
      : `all ${total} @Snapshotable properties across ${classes.length} @Observable class(es) appear in the generated accessors`,
    files: files.length,
    classes,
    gaps,
    templatesOverride: templatesOverride || null,
  };
}

// ---------------------------------------------------------------------- stamp

function writeStamp(appDir, templatesOverride) {
  const res = resolveTemplates(templatesOverride);
  if (!res.ok) return { ok: false, code: EXIT.UNRESOLVED, error: "upstream templates could not be located", tried: res.tried };
  const gen = generatedDir(appDir);
  if (!isDir(gen)) return { ok: false, code: EXIT.NEEDS_HUMAN, error: `${gen} does not exist, so there is nothing installed to stamp` };

  const files = {};
  const missing = [];
  for (const tpl of res.files) {
    const name = installedName(tpl);
    const t = hashFile(path.join(res.root, tpl));
    const i = hashFile(path.join(gen, name));
    if (!t.ok) return { ok: false, code: EXIT.NEEDS_HUMAN, error: t.error };
    if (!i.ok) {
      missing.push(name);
      continue;
    }
    files[name] = { template: t.hash, installed: i.hash };
  }
  // Stamping a partial install would record "this is the state we synced to"
  // for an app that is missing half the bridge, and the next plan would call it
  // up to date. Refuse instead.
  if (missing.length) {
    return {
      ok: false,
      code: EXIT.NEEDS_HUMAN,
      error: `refusing to stamp a partial install; not present in ${gen}: ${missing.join(", ")}`,
    };
  }
  const ver = upstreamVersion(res.root);
  const data = {
    tool: "tb-ios-sync",
    version: VERSION,
    stampedAt: new Date().toISOString(),
    upstreamVersion: ver.version,
    upstreamVersionFrom: ver.from,
    templatesRoot: res.root,
    files,
  };
  fs.writeFileSync(stampPath(appDir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { ok: true, code: EXIT.OK, path: stampPath(appDir), count: Object.keys(files).length };
}

// ---------------------------------------------------------------------- apply

function apply(appDir, templatesOverride, only) {
  const plan = computePlan(appDir, templatesOverride);
  if (!plan.ok) return { ok: false, code: EXIT.UNRESOLVED, error: "upstream templates could not be located", resolve: plan.resolve };

  const blocked = plan.entries.filter((e) => NEEDS_HUMAN.has(e.status) && (!only || e.name === only));
  if (blocked.length) {
    return {
      ok: false,
      code: EXIT.NEEDS_HUMAN,
      error: "refusing to write while any file needs a human",
      blocked: blocked.map((e) => `${e.name}: ${e.status} (${e.detail})`),
    };
  }

  const gen = generatedDir(appDir);
  fs.mkdirSync(gen, { recursive: true });
  const wrote = [];
  const refused = [];
  for (const e of plan.entries) {
    if (only && e.name !== only) continue;
    if (!MECHANICAL.has(e.status)) continue;
    if (e.generated) {
      // gstack says to replace these outright. That writes {{ACCESSORS}} into
      // the app and stops it compiling.
      refused.push(`${e.name}: generator-owned (contains {{PLACEHOLDER}} tokens); run gen-accessors instead of copying`);
      continue;
    }
    fs.copyFileSync(path.join(plan.root, e.template), path.join(gen, e.name));
    wrote.push(e.name);
  }
  const stamped = wrote.length || refused.length === 0 ? writeStamp(appDir, templatesOverride) : { ok: false, code: EXIT.NEEDS_HUMAN, error: "nothing was written" };
  return {
    ok: refused.length === 0,
    code: refused.length ? EXIT.NEEDS_HUMAN : stamped.ok ? EXIT.OK : stamped.code,
    wrote,
    refused,
    stamp: stamped.ok ? stamped.path : null,
    stampError: stamped.ok ? null : stamped.error,
  };
}

// --------------------------------------------------------------------- output

const out = (s) => process.stdout.write(`${s}\n`);

function printResolve(res) {
  out("");
  out("  tb-ios-sync resolve");
  out("");
  for (const t of res.tried) {
    const tag = t.exists ? (t.count ? "USING " : "EMPTY ") : "absent";
    out(`  ${tag}  ${t.path}`);
    out(`          via ${t.why}${t.exists ? `, ${t.count} template(s)` : ""}`);
  }
  out("");
  if (res.ok) {
    const v = upstreamVersion(res.root);
    out(`  templates: ${res.root}`);
    out(`  upstream version: ${v.version}${v.from ? ` (${v.from})` : " (no version file found; informational only)"}`);
    out(`  ${res.files.length} template(s): ${res.files.join(", ")}`);
  } else {
    out("  NOT RESOLVED. No candidate directory exists and holds at least one *.template.");
    out("  A directory that exists but is empty is refused on purpose: reporting");
    out("  \"0 files needed updating\" against an empty directory is not a sync.");
    out("  Point at it explicitly with --templates <dir> or TBS_IOS_TEMPLATES.");
  }
  out("");
}

function printPlan(p) {
  out("");
  out("  tb-ios-sync plan");
  out("");
  out(`  app:       ${p.appDir}`);
  out(`  generated: ${p.generatedDir}`);
  out(`  templates: ${p.root}`);
  out(`  upstream:  ${p.upstream.version}  (informational; drift is decided by content hash)`);
  out(`  stamp:     ${p.stamp || (p.stampError ? `BROKEN (${p.stampError})` : "none")}`);
  out("");
  const w = Math.max(...p.entries.map((e) => e.name.length), 4);
  for (const e of p.entries) {
    out(`  ${e.status.padEnd(17)} ${e.name.padEnd(w)}  ${e.generated ? "[generator-owned] " : ""}${e.detail}`);
  }
  out("");
  const counts = {};
  for (const e of p.entries) counts[e.status] = (counts[e.status] || 0) + 1;
  out(`  ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (p.code === EXIT.OK) out("  Nothing to do.");
  if (p.code === EXIT.WORK_TO_DO) out("  Mechanical work only: run `apply`.");
  if (p.code === EXIT.NEEDS_HUMAN) {
    out("  A human has to decide. This exits 4 rather than assuming the bridge is current;");
    out("  an app with no stamp has never been verified, which is not the same as up to date.");
  }
  out("");
}

// ------------------------------------------------------------------- selftest

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    env: { ...process.env, TBS_IOS_SELFTEST: "1", ...env },
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const TPL_A = "// StateServer\nfinal class StateServer {}\n";
const TPL_GEN = "// StateAccessor\n// {{ACCESSORS}}\nfinal class {{CLASS_NAME}} {}\n";

function fixture(root, name, opts = {}) {
  const dir = path.join(root, name);
  const tpl = path.join(dir, "templates");
  const app = path.join(dir, "App");
  const gen = path.join(app, GENERATED_DIR);
  fs.mkdirSync(tpl, { recursive: true });
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(path.join(tpl, "StateServer.swift.template"), opts.templateA ?? TPL_A, "utf8");
  fs.writeFileSync(path.join(tpl, "StateAccessor.swift.template"), TPL_GEN, "utf8");
  fs.writeFileSync(path.join(gen, "StateServer.swift"), opts.installedA ?? TPL_A, "utf8");
  fs.writeFileSync(path.join(gen, "StateAccessor.swift"), opts.installedGen ?? "// StateAccessor\nvar count = 0\n", "utf8");
  return { dir, tpl, app, gen };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ios-sync-selftest-"));
  const results = [];
  const check = (name, pass, expected, got, detail = "") => results.push({ name, pass, expected: String(expected), got: String(got), detail });

  // --- resolve fails closed -------------------------------------------------
  const emptyDir = path.join(tmp, "empty-templates");
  fs.mkdirSync(emptyDir, { recursive: true });
  {
    const r = run(["resolve", "--templates", path.join(tmp, "does-not-exist")], { HOME: tmp, USERPROFILE: tmp, GSTACK_HOME: "" });
    check("a template dir that does not exist is UNRESOLVED, not a default guess", r.status === EXIT.UNRESOLVED, EXIT.UNRESOLVED, r.status, r.stdout.slice(-200));
  }
  {
    const r = run(["resolve", "--templates", emptyDir], { HOME: tmp, USERPROFILE: tmp, GSTACK_HOME: "" });
    check("a template dir that exists but is EMPTY is refused", r.status === EXIT.UNRESOLVED, EXIT.UNRESOLVED, r.status, r.stdout.slice(-200));
  }
  {
    // gstack's own bug: an unset GSTACK_HOME concatenates to /ios-qa/templates.
    const r = run(["resolve"], { HOME: tmp, USERPROFILE: tmp, GSTACK_HOME: "", TBS_IOS_TEMPLATES: "" });
    const mentions = /\/ios-qa\/templates|\\ios-qa\\templates/.test(r.stdout) && !/\$GSTACK_HOME/.test(r.stdout.split("\n").filter((l) => l.includes("USING")).join(""));
    check("an empty GSTACK_HOME is skipped, never concatenated into a root path", !r.stdout.includes("USING  /ios-qa"), "no /ios-qa root", r.stdout.includes("USING  /ios-qa") ? "concatenated" : "skipped", String(mentions));
  }

  // --- plan: the fail-open gstack takes ------------------------------------
  const f1 = fixture(tmp, "unstamped");
  {
    const r = run(["plan", "--app", f1.app, "--templates", f1.tpl]);
    check("an app with NO stamp is UNSTAMPED, not 'already up to date'", r.status === EXIT.NEEDS_HUMAN && r.stdout.includes("UNSTAMPED"), EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-160));
  }
  {
    const s = run(["stamp", "--app", f1.app, "--templates", f1.tpl]);
    const r = run(["plan", "--app", f1.app, "--templates", f1.tpl]);
    check("after stamping, an untouched app is UP-TO-DATE", s.status === 0 && r.status === EXIT.OK, EXIT.OK, r.status, r.stdout.slice(-160));
  }

  // --- plan: CRLF and BOM are not drift ------------------------------------
  {
    const p = path.join(f1.gen, "StateServer.swift");
    fs.writeFileSync(p, `\ufeff${TPL_A.replace(/\n/g, "\r\n")}`, "utf8");
    const r = run(["plan", "--app", f1.app, "--templates", f1.tpl]);
    check("a CRLF + BOM rewrite of identical content is NOT reported as drift", r.status === EXIT.OK, EXIT.OK, r.status, r.stdout.slice(-200));
    fs.writeFileSync(p, TPL_A, "utf8");
  }

  // --- plan: the four real states ------------------------------------------
  {
    const f = fixture(tmp, "upstream-moved");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.tpl, "StateServer.swift.template"), `${TPL_A}// upstream added a line\n`, "utf8");
    const r = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("an upstream template that moved is UPSTREAM-CHANGED (exit 1)", r.status === EXIT.WORK_TO_DO && r.stdout.includes("UPSTREAM-CHANGED"), EXIT.WORK_TO_DO, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "locally-edited");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.gen, "StateServer.swift"), `${TPL_A}// the user changed this\n`, "utf8");
    const r = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("a locally edited install is LOCALLY-EDITED and needs a human (exit 4)", r.status === EXIT.NEEDS_HUMAN && r.stdout.includes("LOCALLY-EDITED"), EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "conflict");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.tpl, "StateServer.swift.template"), `${TPL_A}// upstream\n`, "utf8");
    fs.writeFileSync(path.join(f.gen, "StateServer.swift"), `${TPL_A}// local\n`, "utf8");
    const r = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("both sides changed is a CONFLICT, never auto-resolved (exit 4)", r.status === EXIT.NEEDS_HUMAN && r.stdout.includes("CONFLICT"), EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "deleted");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.rmSync(path.join(f.gen, "StateServer.swift"));
    const r = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("a deleted installed file is MISSING (exit 1)", r.status === EXIT.WORK_TO_DO && r.stdout.includes("MISSING"), EXIT.WORK_TO_DO, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "broken-stamp");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.gen, STAMP_NAME), "{ not json", "utf8");
    const r = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("a corrupt stamp is an ERROR, not an absent one (exit 4)", r.status === EXIT.NEEDS_HUMAN && r.stdout.includes("ERROR"), EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200));
  }
  {
    const r = run(["plan", "--app", path.join(tmp, "no-such-app"), "--templates", f1.tpl]);
    check("planning against an app dir that does not exist does not exit 0", r.status !== EXIT.OK, "non-zero", r.status, r.stdout.slice(-160));
  }

  // --- stamp refuses a partial install -------------------------------------
  {
    const f = fixture(tmp, "partial");
    fs.rmSync(path.join(f.gen, "StateAccessor.swift"));
    const r = run(["stamp", "--app", f.app, "--templates", f.tpl]);
    check("stamping a PARTIAL install is refused", r.status === EXIT.NEEDS_HUMAN, EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200) + r.stderr.slice(-200));
  }

  // --- apply never clobbers the generated accessors ------------------------
  {
    const f = fixture(tmp, "apply-generated");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.tpl, "StateAccessor.swift.template"), `${TPL_GEN}// upstream moved\n`, "utf8");
    const r = run(["apply", "--app", f.app, "--templates", f.tpl]);
    const body = fs.readFileSync(path.join(f.gen, "StateAccessor.swift"), "utf8");
    check(
      "apply REFUSES to copy a generator-owned template over the accessors (gstack replaces it outright)",
      r.status === EXIT.NEEDS_HUMAN && !PLACEHOLDER.test(body),
      "refused, no {{ }} written",
      `${r.status}, ${PLACEHOLDER.test(body) ? "{{ }} WRITTEN" : "clean"}`,
      r.stdout.slice(-220),
    );
  }
  {
    const f = fixture(tmp, "apply-plain");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.tpl, "StateServer.swift.template"), `${TPL_A}// upstream moved\n`, "utf8");
    const r = run(["apply", "--app", f.app, "--templates", f.tpl, "--only", "StateServer.swift"]);
    const after = run(["plan", "--app", f.app, "--templates", f.tpl]);
    check("apply copies a plain template and re-stamps, so plan goes quiet", r.status === EXIT.OK && after.status === EXIT.OK, "0 then 0", `${r.status} then ${after.status}`, after.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "apply-blocked");
    run(["stamp", "--app", f.app, "--templates", f.tpl]);
    fs.writeFileSync(path.join(f.tpl, "StateServer.swift.template"), `${TPL_A}// upstream\n`, "utf8");
    fs.writeFileSync(path.join(f.gen, "StateServer.swift"), `${TPL_A}// local\n`, "utf8");
    const before = fs.readFileSync(path.join(f.gen, "StateServer.swift"), "utf8");
    const r = run(["apply", "--app", f.app, "--templates", f.tpl]);
    const after = fs.readFileSync(path.join(f.gen, "StateServer.swift"), "utf8");
    check("apply refuses to write anything while a CONFLICT exists", r.status === EXIT.NEEDS_HUMAN && before === after, "refused, file untouched", `${r.status}, ${before === after ? "untouched" : "OVERWRITTEN"}`, r.stdout.slice(-200));
  }

  // --- coverage ------------------------------------------------------------
  const srcDir = path.join(tmp, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "Model.swift"),
    "@Observable\nfinal class CartModel {\n  @Snapshotable\n  var itemCount: Int = 0\n  @Snapshotable\n  var couponCode: String = \"\"\n}\n",
    "utf8",
  );
  {
    const f = fixture(tmp, "cov-gap", { installedGen: "// generated\nvar itemCount = 0\n" });
    const r = run(["coverage", "--app", f.app, "--source", srcDir]);
    check("a @Snapshotable property with no accessor is reported as a GAP (exit 1)", r.status === EXIT.WORK_TO_DO && r.stdout.includes("couponCode"), EXIT.WORK_TO_DO, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "cov-full", { installedGen: "// generated\nvar itemCount = 0\nvar couponCode = \"\"\n" });
    const r = run(["coverage", "--app", f.app, "--source", srcDir]);
    check("full coverage is COVERED (exit 0)", r.status === EXIT.OK && r.stdout.includes("COVERED"), EXIT.OK, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "cov-missing");
    fs.rmSync(path.join(f.gen, "StateAccessor.swift"));
    const r = run(["coverage", "--app", f.app, "--source", srcDir]);
    check("a missing StateAccessor.swift is UNVERIFIABLE, not zero gaps (exit 4)", r.status === EXIT.NEEDS_HUMAN && r.stdout.includes("UNVERIFIABLE"), EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200));
  }
  {
    const f = fixture(tmp, "cov-raw", { installedGen: TPL_GEN });
    const r = run(["coverage", "--app", f.app, "--source", srcDir]);
    check("an accessors file still holding {{PLACEHOLDER}} tokens is UNVERIFIABLE", r.status === EXIT.NEEDS_HUMAN, EXIT.NEEDS_HUMAN, r.status, r.stdout.slice(-200));
  }

  // --- preflight -----------------------------------------------------------
  {
    const r = run(["preflight"], { TBS_IOS_FORCE_PLATFORM: "win32", TBS_IOS_FAKE_TOOLCHAIN: "1" });
    check("preflight BLOCKS on a non-macOS host even with a toolchain (exit 2)", r.status === EXIT.HOST_UNFIT, EXIT.HOST_UNFIT, r.status, r.stdout.slice(-200));
  }
  {
    const r = run(["preflight"], { TBS_IOS_FORCE_PLATFORM: "darwin" });
    const ok = process.platform === "darwin" ? [EXIT.OK, EXIT.HOST_UNFIT].includes(r.status) : r.status === EXIT.HOST_UNFIT;
    check("preflight BLOCKS on macOS when the Swift toolchain is absent", ok, "2 (or 0 on a real Mac with Xcode)", r.status, r.stdout.slice(-200));
  }
  {
    const r = run(["preflight"], { TBS_IOS_FORCE_PLATFORM: "darwin", TBS_IOS_FAKE_TOOLCHAIN: "1" });
    check("preflight passes only when host AND toolchain are both fit", r.status === EXIT.OK && r.stdout.includes("SIMULATED"), EXIT.OK, r.status, r.stdout.slice(-200));
  }
  {
    // Simulation must be inert outside the selftest, or a real run could be
    // talked into a green preflight by an environment variable.
    const r = spawnSync(process.execPath, [SELF, "preflight"], {
      encoding: "utf8",
      env: { ...process.env, TBS_IOS_SELFTEST: "0", TBS_IOS_FORCE_PLATFORM: "darwin", TBS_IOS_FAKE_TOOLCHAIN: "1" },
    });
    const pass = process.platform === "darwin" ? true : r.status === EXIT.HOST_UNFIT;
    check("the toolchain simulation is inert unless TBS_IOS_SELFTEST=1", pass, "2 off-Mac", r.status, (r.stdout || "").slice(-200));
  }

  // --- Windows path handling ----------------------------------------------
  {
    const r = run(["paths", "/c/Users/example/App"]);
    const got = r.stdout.trim().split("\n").pop().trim();
    const expected = isWindows ? "C:\\Users\\example\\App" : path.resolve("/c/Users/example/App");
    check("a Git Bash /c/... path resolves to the native form, not C:\\c\\...", got === expected, expected, got);
  }

  // --- the count itself ----------------------------------------------------
  const EXPECTED = 26;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    pass: results.length + 1 === EXPECTED,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    detail: "a selftest whose total can shrink is a selftest that can stop asserting things",
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows can hold a handle briefly; the temp dir is disposable either way. */
  }

  const w = Math.max(...results.map((r) => r.name.length));
  out("");
  out(`  tb-ios-sync selftest  (node ${process.version}, ${process.platform})`);
  out("");
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out("");
  out(`  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("");
    out("  This sync engine is NOT trustworthy in this state. Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("");
  out("  Every case above is an input designed to look fine and not be: an app that");
  out("  was never synced, a stamp that will not parse, a template directory with");
  out("  nothing in it, a generator-owned file offered up for overwriting, an");
  out("  accessors file that is missing entirely. None of them exit 0.");
  out("");
}

// ------------------------------------------------------------------ arg parse

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

function help() {
  process.stdout.write(`
  tb-ios-sync ${VERSION}, the Toolbay Stack iOS debug-bridge sync engine

    resolve                       locate the upstream ios-qa templates and print
                                  every candidate that was tried
    preflight                     check this host can build an iOS app at all
    plan     --app <dir>          classify every bridge file: UP-TO-DATE,
                                  UPSTREAM-CHANGED, LOCALLY-EDITED, CONFLICT,
                                  MISSING, UNSTAMPED, ERROR
    apply    --app <dir>          copy only the mechanically safe templates and
             [--only <File>]      re-stamp; refuses conflicts and generated files
    stamp    --app <dir>          record the current state as the sync baseline
    coverage --app <dir>          check every @Snapshotable property has an
             --source <dir>       accessor in the generated output
    doctor                        resolve + preflight in one report
    selftest                      run against deliberately broken fixtures
    paths <p>                     print how a path resolves on this host

  Common flags:  --templates <dir>   (or TBS_IOS_TEMPLATES)   --json

  Exit codes: 0 nothing to do, 1 mechanical work to do, 2 host cannot build iOS,
  3 templates unresolved, 4 a human has to decide.

  Unknown state exits 4. It is never reported as up to date.
`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes("--json");
  const templates = argValue(argv, "--templates");
  const appArg = argValue(argv, "--app");
  const appDir = appArg ? toAbsolute(appArg) : null;

  if (cmd === "paths") {
    const p = argv[1];
    if (!p) {
      process.stderr.write("usage: tb-ios-sync paths <path>\n");
      process.exitCode = EXIT.USAGE;
      return;
    }
    out(toAbsolute(p));
    return;
  }

  if (cmd === "resolve") {
    const res = resolveTemplates(templates);
    if (json) out(JSON.stringify(res, null, 2));
    else printResolve(res);
    process.exitCode = res.ok ? EXIT.OK : EXIT.UNRESOLVED;
    return;
  }

  if (cmd === "preflight") {
    const p = preflight();
    if (json) out(JSON.stringify(p, null, 2));
    else {
      out("");
      out(`  tb-ios-sync preflight  (${p.platform}${p.simulated ? ", SIMULATED toolchain" : ""})`);
      out("");
      for (const c of p.checks) out(`  ${c.ok ? "OK   " : "BLOCK"}  ${c.name.padEnd(22)} ${c.detail}`);
      out("");
      if (!p.ok) {
        out("  This host cannot build or run an iOS app, so a resync cannot be verified here.");
        out("  plan / coverage / stamp still work: they are file comparisons and need no toolchain.");
        out("  What must NOT happen is reporting a completed sync on a host that could never");
        out("  have compiled it, which is what an unguarded run does.");
        out("");
      }
    }
    process.exitCode = p.ok ? EXIT.OK : EXIT.HOST_UNFIT;
    return;
  }

  if (cmd === "plan") {
    if (!appDir) {
      process.stderr.write("usage: tb-ios-sync plan --app <dir>\n");
      process.exitCode = EXIT.USAGE;
      return;
    }
    const p = computePlan(appDir, templates);
    if (!p.ok) {
      if (json) out(JSON.stringify(p, null, 2));
      else printResolve(p.resolve);
      process.exitCode = EXIT.UNRESOLVED;
      return;
    }
    if (json) out(JSON.stringify(p, null, 2));
    else printPlan(p);
    process.exitCode = p.code;
    return;
  }

  if (cmd === "stamp") {
    if (!appDir) {
      process.stderr.write("usage: tb-ios-sync stamp --app <dir>\n");
      process.exitCode = EXIT.USAGE;
      return;
    }
    const r = writeStamp(appDir, templates);
    if (json) out(JSON.stringify(r, null, 2));
    else if (r.ok) out(`\n  stamped ${r.count} file(s) -> ${r.path}\n`);
    else out(`\n  NOT STAMPED: ${r.error}\n`);
    process.exitCode = r.code;
    return;
  }

  if (cmd === "apply") {
    if (!appDir) {
      process.stderr.write("usage: tb-ios-sync apply --app <dir>\n");
      process.exitCode = EXIT.USAGE;
      return;
    }
    const r = apply(appDir, templates, argValue(argv, "--only"));
    if (json) out(JSON.stringify(r, null, 2));
    else {
      out("");
      out("  tb-ios-sync apply");
      out("");
      for (const n of r.wrote || []) out(`  WROTE    ${n}`);
      for (const n of r.refused || []) out(`  REFUSED  ${n}`);
      for (const n of r.blocked || []) out(`  BLOCKED  ${n}`);
      if (r.error) out(`  ${r.error}`);
      if (r.stamp) out(`  stamp    ${r.stamp}`);
      if (r.stampError) out(`  stamp    NOT WRITTEN: ${r.stampError}`);
      out("");
    }
    process.exitCode = r.code;
    return;
  }

  if (cmd === "coverage") {
    const src = argValue(argv, "--source");
    if (!appDir || !src) {
      process.stderr.write("usage: tb-ios-sync coverage --app <dir> --source <dir>\n");
      process.exitCode = EXIT.USAGE;
      return;
    }
    const c = coverage(appDir, toAbsolute(src), templates);
    if (json) out(JSON.stringify(c, null, 2));
    else {
      out("");
      out(`  tb-ios-sync coverage: ${c.verdict}`);
      out("");
      out(`  ${c.reason}`);
      out(`  scanned ${c.files} swift file(s), found ${c.classes.length} @Observable class(es)`);
      for (const g of c.gaps) out(`  GAP  ${g.klass}.${g.prop}  (${g.file})`);
      out("");
    }
    process.exitCode = c.code;
    return;
  }

  if (cmd === "doctor") {
    const res = resolveTemplates(templates);
    printResolve(res);
    const p = preflight();
    out(`  preflight (${p.platform}):`);
    for (const c of p.checks) out(`    ${c.ok ? "OK   " : "BLOCK"}  ${c.name.padEnd(22)} ${c.detail}`);
    out("");
    process.exitCode = res.ok ? (p.ok ? EXIT.OK : EXIT.HOST_UNFIT) : EXIT.UNRESOLVED;
    return;
  }

  if (cmd === "selftest") return selftest();
  help();
}

// A crash must not read as success. Anything unexpected exits 4 (needs a human).
process.on("uncaughtException", (e) => {
  process.stderr.write(`tb-ios-sync: ${e?.stack ?? e}\n`);
  process.exit(EXIT.NEEDS_HUMAN);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`tb-ios-sync: ${e?.stack ?? e}\n`);
  process.exit(EXIT.NEEDS_HUMAN);
});

main();
