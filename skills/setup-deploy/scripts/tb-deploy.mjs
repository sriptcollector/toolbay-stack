#!/usr/bin/env node
/**
 * tb-deploy.mjs: the deploy-configuration engine behind /setup-deploy.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The command name and the contract this implements (detect the
 * deploy platform, the production URL, the health check and the deploy status
 * command, then persist them to CLAUDE.md so /land-and-deploy does not have to
 * detect anything again) come from `setup-deploy` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * gstack's setup-deploy is six steps of shell embedded in a prompt. Four
 * measured failures, all on Windows 11, all on 2026-08-13:
 *
 * 1. THE DETECTOR NAMES TWO PLATFORMS AND NEVER PICKS ONE. Step 2 is a list of
 *    independent `[ -f x ] && echo PLATFORM:y` lines with no precedence and no
 *    tie-break anywhere in Step 3. Run verbatim in a repo that deploys with
 *    `railway up`:
 *
 *      $ [ -f vercel.json ] || [ -d .vercel ] && echo "PLATFORM:vercel"
 *        [ -f railway.json ] || [ -f railway.toml ] && echo "PLATFORM:railway"
 *      PLATFORM:vercel
 *      PLATFORM:railway
 *
 *    A stale `.vercel/` link directory and the file that actually describes the
 *    deploy are given equal standing. `detect` here ranks candidates by the
 *    strength of the evidence, prints the evidence, and REFUSES to return a
 *    single answer while more than one platform has any (exit 1), because the
 *    honest output of an ambiguous repo is a question, not a guess.
 *
 * 2. "DEPLOYS AUTOMATICALLY ON PUSH" IS WRITTEN WITHOUT CHECKING FOR A REMOTE.
 *    Step 3's Vercel, Netlify and Render sections all assert auto-deploy on
 *    push, and Step 4 writes `Deploy trigger: automatic on push to main` into
 *    CLAUDE.md. In that same repo:
 *
 *      $ git rev-parse --is-inside-work-tree ; git remote
 *      true
 *      (no output: zero remotes)
 *
 *    There is nothing to push to. The config gstack writes is not merely
 *    imprecise, it is false, and /land-and-deploy then merges and waits for a
 *    deploy that can never start. `write` refuses `--trigger git-push` when the
 *    repository has no remote, and says so.
 *
 * 3. THE VERIFY STEP CANNOT FAIL. Step 5 checks the deploy status command with
 *      {deploy-status-command} 2>/dev/null | head -5 || echo "COMMAND_FAILED"
 *    In a pipeline the exit status is the LAST command's, and `head` succeeds
 *    whenever it can write. Measured:
 *
 *      $ vercel-that-does-not-exist ls --prod 2>/dev/null | head -5 || echo "COMMAND_FAILED"
 *      [exit=0]
 *
 *    No output, no COMMAND_FAILED, exit 0. A deploy status command that is not
 *    installed verifies clean. `verify` resolves the executable itself, against
 *    PATH and PATHEXT, and a command that is not there is MISSING and exits 1.
 *
 * 4. NONE OF IT RUNS IN POWERSHELL. Step 2 is POSIX test syntax and `find`.
 *    In PowerShell the block does not even parse, and the workflow scan hits
 *    Windows FIND.EXE, which is a text search tool:
 *
 *      PS> [ -f fly.toml ]
 *      Missing type name after '['.
 *      PS> find .github/workflows -maxdepth 1 -name '*.yml'
 *      File not found - '*.yml'
 *
 *    Both failures are silent to the skill: it sees no PLATFORM line and no
 *    DEPLOY_WORKFLOW line, concludes nothing was detected, and asks the user to
 *    describe their deploy by hand. Everything here is Node, so both shells get
 *    the same answer, and there is no `find`, `which`, `curl`, `sed` or `grep`.
 *
 * The through-line: a deploy configuration is a claim about the future, and the
 * only way to keep it honest is to derive every field from a file that exists
 * and to refuse to record a field that contradicts one.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fromMsysPath, looksAbsolute } from "./tb-paths.mjs";
import { AMBIGUOUS_ON_WINDOWS } from "./tb-outdir.mjs";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";
const isWindows = process.platform === "win32";
const out = (s = "") => process.stdout.write(`${s}\n`);
const errOut = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // the question was answered and the answer is usable
const EXIT_NOT_USABLE = 1; // answered, and the answer is that this is not ready
const EXIT_UNUSABLE = 2; // the inputs or the stored config cannot be used at all
const EXIT_REFUSED = 3; // a request that must not be honoured

// ---------------------------------------------------------------------- paths
//
// Same Windows path handling as the rest of Toolbay Stack. `/tmp` resolves to
// two different directories on this machine depending on which shell asks, so a
// config written by one and read by the other configures nothing.


function resolveRepo(raw) {
  const s = String(raw ?? ".").trim().replace(/^["']|["']$/g, "") || ".";
  if (isWindows && AMBIGUOUS_ON_WINDOWS.test(s)) {
    return {
      ok: false,
      error:
        `"${s}" means two different directories on this machine. Git Bash resolves it under ${os.tmpdir()}, ` +
        `and Node, Python and PowerShell resolve it to ${path.resolve(s)}. Pass a real path.`,
    };
  }
  const msys = fromMsysPath(s);
  const dir = path.resolve(looksAbsolute(msys) ? msys : path.join(process.cwd(), msys));
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    return { ok: false, error: `${dir} does not exist (${e.code || e.message})` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `${dir} is not a directory` };
  return { ok: true, dir };
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
}

/**
 * Flags given more than once.
 *
 * `indexOf` takes the first, so `--url a --url b` would silently record `a`
 * while the caller believes it recorded `b`. Every value in this file ends up
 * written to CLAUDE.md and trusted by a later deploy, so a silently discarded
 * argument is the same class of bug as everything else here: a wrong fact that
 * reads clean. Repeats are refused rather than resolved.
 */
function duplicateFlags(args) {
  const seen = new Map();
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    seen.set(a, (seen.get(a) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([a]) => a);
}

/**
 * Read a file, distinguishing "not there" from "there and unreadable".
 * The second is never allowed to look like the first: a deploy config file
 * that cannot be opened is the exact case where a detector must stop rather
 * than rank the platforms it could read.
 */
function readIfPresent(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { present: false };
    return { present: true, error: `${e.code || e.message}` };
  }
  if (stat.isDirectory()) return { present: true, error: "EISDIR (it is a directory, not a file)" };
  try {
    return { present: true, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    return { present: true, error: `${e.code || e.message}` };
  }
}

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// -------------------------------------------------------------- PATH lookup
//
// `which` does not exist in PowerShell and `command -v` does not exist outside
// a POSIX shell, so both of gstack's probes are shell-specific. This resolves a
// command the way the OS would, in Node, on either shell. PATHEXT matters: npm
// installs `vercel.cmd`, and a bare `vercel` on the filesystem is a Git Bash
// shim that cmd cannot run.

function pathExtensions() {
  if (!isWindows) return [""];
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
  const exts = raw.split(";").map((e) => e.trim()).filter(Boolean);
  if (!exts.some((e) => e.toLowerCase() === ".ps1")) exts.push(".PS1");
  // The extension-less shim is real on this platform and Git Bash will run it.
  return [...exts, ""];
}

/** The first token of a command line, with one level of quoting removed. */
function firstToken(cmdline) {
  const m = /^\s*("[^"]*"|'[^']*'|\S+)/.exec(String(cmdline ?? ""));
  if (!m) return "";
  return m[1].replace(/^["']|["']$/g, "");
}

function whichExe(cmdline) {
  const token = firstToken(cmdline);
  if (!token) return { found: false, why: "the command line is empty" };
  const exts = pathExtensions();

  const tryPath = (base) => {
    for (const ext of exts) {
      const p = base + ext;
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
    return null;
  };

  if (token.includes("/") || token.includes("\\")) {
    const abs = path.resolve(fromMsysPath(token));
    const hit = tryPath(abs);
    return hit ? { found: true, at: hit } : { found: false, why: `${abs} is not an executable file` };
  }

  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const hit = tryPath(path.join(d, token));
    if (hit) return { found: true, at: hit };
  }
  return { found: false, why: `"${token}" is not on PATH (${dirs.length} entries searched)` };
}

// ------------------------------------------------------------------ git facts
//
// Read from .git/config directly rather than spawning git. Same answer in both
// shells, no dependency on git being installed, and it works in a worktree
// where .git is a file. The one thing this is asked for is load-bearing: with
// zero remotes, "deploys automatically on push" cannot be true.

function gitFacts(repo) {
  const dotgit = path.join(repo, ".git");
  let configFile = path.join(dotgit, "config");
  let st;
  try {
    st = fs.statSync(dotgit);
  } catch {
    return { isRepo: false, remotes: [] };
  }
  if (st.isFile()) {
    const f = readIfPresent(dotgit);
    if (f.error) return { isRepo: true, remotes: [], error: `.git could not be read (${f.error})` };
    const m = /^gitdir:\s*(.+)$/m.exec(f.text || "");
    if (!m) return { isRepo: true, remotes: [], error: ".git is a file with no gitdir: line" };
    const gitdir = path.resolve(repo, m[1].trim());
    configFile = path.join(gitdir, "config");
    // A linked worktree keeps remotes in the main repo's config.
    if (!exists(configFile)) {
      const commondir = readIfPresent(path.join(gitdir, "commondir"));
      if (commondir.text) configFile = path.join(path.resolve(gitdir, commondir.text.trim()), "config");
    }
  }
  const cfg = readIfPresent(configFile);
  if (!cfg.present) return { isRepo: true, remotes: [] };
  if (cfg.error) return { isRepo: true, remotes: [], error: `${configFile} could not be read (${cfg.error})` };

  const remotes = [];
  let current = null;
  for (const line of cfg.text.split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (section) {
      current = { name: section[1], url: null };
      remotes.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (kv && current) current.url = kv[1];
  }
  return { isRepo: true, remotes: remotes.filter((r) => r.url) };
}

// ------------------------------------------------------- platform evidence
//
// Every entry is a real file. `weight` is how much that file proves. A config
// a human committed outranks a link directory a CLI dropped, because the link
// directory survives switching platforms and the committed config does not.

const TOML_STR = (text, key) => {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(text);
  return m ? m[1] : null;
};

function parseJsonEvidence(text, file) {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: `${file} is not valid JSON (${e.message})` };
  }
}

const PLATFORMS = {
  railway: { deploy: "railway up", status: "railway status", label: "Railway" },
  vercel: { deploy: "vercel --prod", status: "vercel ls --prod", label: "Vercel" },
  netlify: { deploy: "netlify deploy --prod", status: "netlify status", label: "Netlify" },
  fly: { deploy: "fly deploy", status: "fly status", label: "Fly.io" },
  render: { deploy: null, status: null, label: "Render" },
  heroku: { deploy: "git push heroku main", status: "heroku ps", label: "Heroku" },
  cloudflare: { deploy: "wrangler deploy", status: "wrangler deployments list", label: "Cloudflare" },
};

/**
 * @returns {{evidence: Array, problems: string[], facts: object}}
 */
function collectEvidence(repo) {
  const evidence = [];
  const problems = [];
  const facts = { urls: {}, healthPaths: {}, apps: {} };

  const add = (platform, file, weight, note) => evidence.push({ platform, file, weight, note });

  const readFile = (rel) => {
    const r = readIfPresent(path.join(repo, rel));
    if (r.error) {
      problems.push(
        `${rel} exists but could not be read (${r.error}), so whether this project deploys to that platform is unknown. ` +
          `Fix or remove the file: a detector that skipped it would rank the platforms it happened to be able to open.`,
      );
      return null;
    }
    return r.present ? r.text : null;
  };

  // ---- Railway
  {
    const text = readFile("railway.json");
    if (text !== null) {
      const p = parseJsonEvidence(text, "railway.json");
      if (p.error) problems.push(p.error);
      else {
        const hasDeploy = p.value && typeof p.value.deploy === "object" && p.value.deploy;
        add("railway", "railway.json", hasDeploy ? 7 : 5, hasDeploy ? "declares a deploy block" : "present");
        const hc = hasDeploy ? p.value.deploy.healthcheckPath : null;
        if (typeof hc === "string" && hc.startsWith("/")) facts.healthPaths.railway = hc;
      }
    }
  }
  {
    const text = readFile("railway.toml");
    if (text !== null) {
      add("railway", "railway.toml", 5, "present");
      const hc = TOML_STR(text, "healthcheckPath");
      if (hc && hc.startsWith("/")) facts.healthPaths.railway = hc;
    }
  }

  // ---- Vercel. The link directory is deliberately weak evidence: `vercel link`
  // writes it once and nothing ever removes it, so it long outlives the choice.
  {
    const text = readFile("vercel.json");
    if (text !== null) {
      const p = parseJsonEvidence(text, "vercel.json");
      if (p.error) problems.push(p.error);
      else add("vercel", "vercel.json", 5, "committed platform config");
    }
  }
  {
    const text = readFile(path.join(".vercel", "project.json"));
    if (text !== null) {
      const p = parseJsonEvidence(text, ".vercel/project.json");
      if (p.error) problems.push(p.error);
      else {
        const name = p.value?.name || p.value?.projectId || null;
        add("vercel", ".vercel/project.json", 2, `local link${name ? ` to ${name}` : ""}, which survives switching platforms`);
      }
    }
  }

  // ---- Netlify
  {
    const text = readFile("netlify.toml");
    if (text !== null) {
      add("netlify", "netlify.toml", 5, "committed platform config");
      const pub = TOML_STR(text, "publish");
      if (pub) facts.apps.netlify = `publish ${pub}`;
    }
  }
  {
    const text = readFile(path.join(".netlify", "state.json"));
    if (text !== null) {
      const p = parseJsonEvidence(text, ".netlify/state.json");
      if (p.error) problems.push(p.error);
      else add("netlify", ".netlify/state.json", 2, "local link, which survives switching platforms");
    }
  }

  // ---- Fly
  {
    const text = readFile("fly.toml");
    if (text !== null) {
      add("fly", "fly.toml", 6, "committed platform config");
      const app = TOML_STR(text, "app");
      if (app) {
        facts.apps.fly = app;
        facts.urls.fly = `https://${app}.fly.dev`;
      }
      const checkPath = TOML_STR(text, "path");
      if (checkPath && checkPath.startsWith("/")) facts.healthPaths.fly = checkPath;
    }
  }

  // ---- Render
  {
    const text = readFile("render.yaml");
    if (text !== null) {
      add("render", "render.yaml", 5, "committed platform config");
      const name = /^\s*-?\s*name:\s*(\S+)/m.exec(text);
      if (name) {
        facts.apps.render = name[1];
        facts.urls.render = `https://${name[1]}.onrender.com`;
      }
      const hc = /^\s*healthCheckPath:\s*(\S+)/m.exec(text);
      if (hc && hc[1].startsWith("/")) facts.healthPaths.render = hc[1];
    }
  }

  // ---- Heroku
  if (readFile("Procfile") !== null) add("heroku", "Procfile", 4, "present");

  // ---- Cloudflare. gstack does not detect this platform at all.
  {
    const text = readFile("wrangler.toml");
    if (text !== null) {
      add("cloudflare", "wrangler.toml", 6, "committed platform config");
      const name = TOML_STR(text, "name");
      if (name) facts.apps.cloudflare = name;
    }
  }
  {
    const text = readFile("wrangler.jsonc") ?? readFile("wrangler.json");
    if (text !== null) add("cloudflare", "wrangler.json(c)", 6, "committed platform config");
  }

  // ---- package.json scripts. A `deploy` script is the strongest signal that
  // the deploy is a command somebody runs, not something a push triggers.
  {
    const text = readFile("package.json");
    if (text !== null) {
      const p = parseJsonEvidence(text, "package.json");
      if (p.error) problems.push(p.error);
      else {
        const scripts = p.value?.scripts && typeof p.value.scripts === "object" ? p.value.scripts : {};
        for (const [name, body] of Object.entries(scripts)) {
          if (!/deploy|release|publish/i.test(name) || typeof body !== "string") continue;
          facts.scripts = facts.scripts || {};
          facts.scripts[name] = body;
          for (const [plat, re] of [
            ["vercel", /\bvercel\b/],
            ["netlify", /\bnetlify\b/],
            ["railway", /\brailway\b/],
            ["fly", /\bfly(ctl)?\b/],
            ["cloudflare", /\bwrangler\b/],
          ]) {
            if (re.test(body)) add(plat, `package.json scripts.${name}`, 3, `runs \`${body.trim().slice(0, 60)}\``);
          }
        }
      }
    }
  }

  return { evidence, problems, facts };
}

/** Every workflow file, read without `find`, classified by what it deploys. */
function collectWorkflows(repo) {
  const dir = path.join(repo, ".github", "workflows");
  const problems = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { workflows: [], problems };
    problems.push(`${path.join(".github", "workflows")} could not be listed (${e.code || e.message}), so CI deploys are unknown`);
    return { workflows: [], problems };
  }
  const workflows = [];
  for (const name of names.sort()) {
    if (!/\.(ya?ml)$/i.test(name)) continue;
    const r = readIfPresent(path.join(dir, name));
    if (r.error) {
      problems.push(`.github/workflows/${name} could not be read (${r.error}), so whether CI deploys this project is unknown`);
      continue;
    }
    const text = r.text || "";
    // Content, not filename. gstack's land-and-deploy fingerprint only looks at
    // workflows whose NAME contains deploy or cd, which misses release.yml.
    const deploys = /\b(deploy|release|production|staging)\b/i.test(text);
    const platforms = [];
    for (const [plat, re] of [
      ["vercel", /vercel/i],
      ["netlify", /netlify/i],
      ["railway", /railway/i],
      ["fly", /flyctl|superfly|fly deploy/i],
      ["cloudflare", /wrangler|cloudflare/i],
      ["heroku", /heroku/i],
    ]) {
      if (re.test(text)) platforms.push(plat);
    }
    workflows.push({ file: `.github/workflows/${name}`, deploys, platforms });
  }
  return { workflows, problems };
}

/**
 * A route that could answer "which commit are you serving".
 *
 * This is the field gstack never asks about and the one /land-and-deploy's
 * verdict depends on: without it the best any future deploy check can report is
 * UNPROVEN. Finding it at setup time is the whole point of a setup skill.
 */
const BUILD_ID_ROUTES = [
  ["/api/version", ["app/api/version/route.ts", "app/api/version/route.js", "src/app/api/version/route.ts", "pages/api/version.ts", "pages/api/version.js", "api/version.ts", "api/version.js", "api/version.py"]],
  ["/api/health", ["app/api/health/route.ts", "app/api/health/route.js", "src/app/api/health/route.ts", "pages/api/health.ts", "pages/api/health.js", "api/health.ts", "api/health.js", "api/health.py"]],
  ["/healthz", ["app/healthz/route.ts", "api/healthz.ts"]],
];

function findRoutes(repo) {
  const found = [];
  for (const [route, candidates] of BUILD_ID_ROUTES) {
    for (const rel of candidates) {
      if (exists(path.join(repo, ...rel.split("/")))) {
        found.push({ route, file: rel });
        break;
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------- detect

function detect(repo) {
  const { evidence, problems: evProblems, facts } = collectEvidence(repo);
  const { workflows, problems: wfProblems } = collectWorkflows(repo);
  const git = gitFacts(repo);
  const problems = [...evProblems, ...wfProblems];
  if (git.error) problems.push(git.error);

  const byPlatform = new Map();
  for (const e of evidence) {
    if (!byPlatform.has(e.platform)) byPlatform.set(e.platform, { platform: e.platform, score: 0, evidence: [] });
    const c = byPlatform.get(e.platform);
    c.score += e.weight;
    c.evidence.push(`${e.file} (${e.note})`);
  }

  // A workflow that names a platform is corroboration, not a platform config.
  for (const wf of workflows) {
    if (!wf.deploys) continue;
    for (const plat of wf.platforms) {
      if (!byPlatform.has(plat)) byPlatform.set(plat, { platform: plat, score: 0, evidence: [] });
      const c = byPlatform.get(plat);
      c.score += 3;
      c.evidence.push(`${wf.file} (a deploy workflow that names ${plat})`);
    }
  }

  const candidates = [...byPlatform.values()]
    .sort((a, b) => b.score - a.score || a.platform.localeCompare(b.platform))
    .map((c) => ({
      ...c,
      label: PLATFORMS[c.platform]?.label ?? c.platform,
      url: facts.urls[c.platform] ?? null,
      healthPath: facts.healthPaths[c.platform] ?? null,
      deployCommand: PLATFORMS[c.platform]?.deploy ?? null,
      statusCommand: PLATFORMS[c.platform]?.status ?? null,
    }));

  const deployWorkflows = workflows.filter((w) => w.deploys);
  const remotes = git.remotes ?? [];

  // The trigger, which is the field gstack asserts and never checks.
  let trigger;
  if (git.isRepo && remotes.length === 0) {
    trigger = {
      class: candidates.length ? "cli" : "unknown",
      proved: true,
      why:
        `this is a git repository with zero remotes, so "deploys automatically on push" cannot be true here. ` +
        `Whatever deploys it is a command someone runs.`,
    };
  } else if (!git.isRepo) {
    trigger = { class: "unknown", proved: true, why: "not a git repository, so there is no push to deploy from" };
  } else if (deployWorkflows.length) {
    trigger = {
      class: "ci-workflow",
      proved: true,
      why: `${deployWorkflows.map((w) => w.file).join(", ")} runs on this repository and deploys`,
    };
  } else if (candidates.length) {
    trigger = {
      class: "git-push",
      proved: false,
      why:
        `${candidates[0].label} deploys from a connected git branch and this repository has ${remotes.length} remote(s), ` +
        `but the connection itself lives in the platform dashboard and cannot be read from disk. Confirm it before relying on it.`,
    };
  } else {
    trigger = { class: "unknown", proved: true, why: "no platform configuration was found on disk" };
  }

  const ambiguous = candidates.length > 1;
  const routes = findRoutes(repo);
  const buildIdPath = routes.find((r) => r.route === "/api/version")?.route ?? null;
  const healthPath = candidates[0]?.healthPath ?? routes.find((r) => r.route.includes("health"))?.route ?? null;

  return {
    root: repo,
    candidates,
    recommended: candidates.length === 1 ? candidates[0].platform : null,
    ranked: candidates[0]?.platform ?? null,
    ambiguous,
    trigger,
    git: { isRepo: git.isRepo, remotes },
    workflows,
    routes,
    buildIdPath,
    healthPath,
    scripts: facts.scripts ?? null,
    problems,
  };
}

function cmdDetect(args) {
  const json = args.includes("--json");
  const dupes = duplicateFlags(args);
  if (dupes.length) return fail(json, EXIT_REFUSED, `${dupes.join(", ")} given more than once; only the first would have been used`);
  const r = resolveRepo(flag(args, "--repo") || ".");
  if (!r.ok) return fail(json, EXIT_REFUSED, r.error);
  const d = detect(r.dir);

  const exit = d.problems.length
    ? EXIT_UNUSABLE
    : d.candidates.length === 1
      ? EXIT_OK
      : EXIT_NOT_USABLE;

  if (json) {
    out(JSON.stringify({ ok: exit === EXIT_OK, ...d }, null, 2));
  } else {
    out();
    out(`  root       ${d.root}`);
    out(`  git        ${d.git.isRepo ? `${d.git.remotes.length} remote(s)${d.git.remotes.length ? `: ${d.git.remotes.map((x) => `${x.name} ${x.url}`).join(", ")}` : ""}` : "not a git repository"}`);
    out();
    if (!d.candidates.length) {
      out("  PLATFORM   none found on disk");
      out("             No railway/vercel/netlify/fly/render/heroku/cloudflare config, and no");
      out("             deploy workflow. Ask the user; do not guess a platform.");
    } else {
      for (const [i, c] of d.candidates.entries()) {
        out(`  ${i === 0 ? "PLATFORM " : "also     "}  ${c.label.padEnd(11)} score ${String(c.score).padEnd(3)} ${i === 0 && d.ambiguous ? "(best guess, NOT decided)" : ""}`);
        for (const e of c.evidence) out(`             - ${e}`);
        if (c.url) out(`             url from config: ${c.url}`);
        if (c.healthPath) out(`             health path from config: ${c.healthPath}`);
      }
    }
    out();
    out(`  TRIGGER    ${d.trigger.class}${d.trigger.proved ? "" : " (probable, not proved)"}`);
    out(`             ${d.trigger.why}`);
    if (d.workflows.length) {
      out();
      for (const w of d.workflows) out(`  workflow   ${w.file}${w.deploys ? " (deploys)" : ""}${w.platforms.length ? ` -> ${w.platforms.join(", ")}` : ""}`);
    }
    out();
    out(`  BUILD ID   ${d.buildIdPath ? `${d.buildIdPath} (a route that can name the running commit)` : "none found"}`);
    if (!d.buildIdPath) {
      out("             Without one, every future deploy check can only ever report UNPROVEN.");
      out('             One route returning {"commit": <sha>} fixes that permanently.');
    }
    if (d.healthPath) out(`  HEALTH     ${d.healthPath}`);
    if (d.problems.length) {
      out();
      for (const p of d.problems) out(`  UNUSABLE   ${p}`);
    }
    out();
    if (exit === EXIT_NOT_USABLE && d.ambiguous) {
      out(`  ${d.candidates.length} platforms have evidence here. Ranked, not decided: ask which one actually`);
      out("  deploys production before writing anything.");
      out();
    }
  }
  process.exitCode = exit;
}

// ----------------------------------------------------------- the config block
//
// gstack writes markdown bullets containing `{placeholder}` braces and tells
// the model to "find and replace the section if it exists, or append it". That
// is not a format, it is a suggestion: nothing can parse it back, nothing
// notices when a placeholder is left in verbatim, and two runs append two
// sections. This block has explicit delimiters and a JSON payload, so `read`
// gets back exactly what `write` put in, and a second `write` replaces it.

const BEGIN = "<!-- toolbay-stack:deploy:begin v1 -->";
const END = "<!-- toolbay-stack:deploy:end -->";
const HEADING = "## Deploy Configuration (toolbay-stack /setup-deploy)";
const TRIGGERS = new Set(["git-push", "cli", "ci-workflow", "manual", "none"]);

const PLACEHOLDER = /^\s*[{<].*[}>]\s*$|\{(url|platform|command|health|workflow|app|service)[^}]*\}/i;

/**
 * A URL path, and nothing that has stopped being one.
 *
 * MSYS PATH CONVERSION. In Git Bash a bare `/api/health` argument is rewritten
 * to a Windows path by the shell BEFORE the program is started, so this arrives
 * as `C:/Program Files/Git/api/health`. Caught by running the tool's own demo
 * on this machine:
 *
 *     $ tb-deploy write ... --health-path /api/health
 *       health     C:/Program Files/Git/api/health
 *
 * Nothing in the process can tell that apart from a user who typed it, so the
 * only safe answer is to refuse the shape. Silently stripping a prefix would be
 * a guess, and this file exists to stop guesses reaching CLAUDE.md.
 */
function routePathProblem(name, value) {
  if (!value) return null;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\")) {
    return (
      `${name} "${value}" is a filesystem path, not a URL path. In Git Bash a leading "/" argument is rewritten to a ` +
      `Windows path by the shell before this program starts. Pass it as "//api/health", or set MSYS_NO_PATHCONV=1, ` +
      `or run the command from PowerShell.`
    );
  }
  if (!value.startsWith("/")) return `${name} "${value}" must start with "/"`;
  if (/\s/.test(value)) return `${name} "${value}" contains whitespace, so it is not a URL path`;
  return null;
}

/**
 * `//api/health` is the documented Git Bash escape, so collapsing the leading
 * slashes is undoing a shell quirk, not guessing at intent. Left alone it would
 * be stored as a protocol-relative URL and the live check would fetch the
 * wrong host.
 */
const normalizeRoutePath = (v) => (v ? v.replace(/^\/{2,}/, "/") : v);

function configFile(repo, args) {
  const f = flag(args, "--file");
  return f ? path.resolve(repo, fromMsysPath(f)) : path.join(repo, "CLAUDE.md");
}

function readBlock(file) {
  const r = readIfPresent(file);
  if (!r.present) return { error: `${file} does not exist, so no deploy configuration has ever been written` };
  if (r.error) return { error: `${file} could not be read (${r.error})` };
  const text = r.text;
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i === -1 || j === -1 || j < i) {
    return {
      error:
        `${file} has no toolbay-stack deploy block. ` +
        (/##\s*Deploy Configuration/i.test(text)
          ? `It does have a "## Deploy Configuration" heading, which is gstack's prose format: nothing can parse it back, so it cannot be trusted as configuration. Re-run /setup-deploy.`
          : `Run /setup-deploy first.`),
    };
  }
  const inner = text.slice(i + BEGIN.length, j);
  const fence = /```json\s*\r?\n([\s\S]*?)\r?\n```/.exec(inner);
  if (!fence) return { error: `${file} has a deploy block with no json payload in it` };
  let value;
  try {
    value = JSON.parse(fence[1]);
  } catch (e) {
    return { error: `the deploy block in ${file} is not valid JSON (${e.message}), so the configuration is unusable` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `the deploy block in ${file} is not a JSON object` };
  }
  return { value, text, start: i, end: j + END.length };
}

function renderBlock(cfg) {
  const lines = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push(`**${cfg.platform}**, and pushing to git ${cfg.trigger === "git-push" ? "DOES" : "does NOT"} deploy it.`);
  if (cfg.trigger !== "git-push") {
    lines.push(`The deploy is \`${cfg.deployCommand || "(none recorded)"}\`, run by a person or a job. A merge alone changes nothing in production.`);
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(cfg, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(END);
  return lines.join("\n");
}

function cmdWrite(args) {
  const json = args.includes("--json");
  const dupes = duplicateFlags(args);
  if (dupes.length) {
    return fail(
      json,
      EXIT_REFUSED,
      `${dupes.join(", ")} given more than once. Only the first would have been recorded, and the value you meant would have been silently dropped into CLAUDE.md as the other one.`,
    );
  }
  const r = resolveRepo(flag(args, "--repo") || ".");
  if (!r.ok) return fail(json, EXIT_REFUSED, r.error);
  const repo = r.dir;
  const file = configFile(repo, args);

  const platform = (flag(args, "--platform") || "").trim();
  const url = (flag(args, "--url") || "").trim();
  const trigger = (flag(args, "--trigger") || "").trim();
  const deployCommand = (flag(args, "--deploy-cmd") || "").trim();
  const statusCommand = (flag(args, "--status-cmd") || "").trim();
  const healthPath = normalizeRoutePath((flag(args, "--health-path") || "").trim());
  const buildIdPath = normalizeRoutePath((flag(args, "--build-id-path") || "").trim());
  const why = (flag(args, "--why") || "").trim();
  const force = args.includes("--force");

  const refusals = [];
  if (!platform) refusals.push("--platform is required: a config with no platform configures nothing");
  if (!trigger) refusals.push(`--trigger is required, one of ${[...TRIGGERS].join(", ")}`);
  else if (!TRIGGERS.has(trigger)) refusals.push(`--trigger "${trigger}" is not one of ${[...TRIGGERS].join(", ")}`);

  // Placeholders. gstack's template is literally `- Production URL: {url}` and a
  // model that copies the template faithfully writes the braces to disk.
  for (const [name, value] of [
    ["--platform", platform],
    ["--url", url],
    ["--deploy-cmd", deployCommand],
    ["--status-cmd", statusCommand],
    ["--health-path", healthPath],
  ]) {
    if (value && PLACEHOLDER.test(value)) {
      refusals.push(`${name} is still the template placeholder ${value}. A placeholder written to disk reads as configuration forever.`);
    }
  }

  for (const [name, value] of [
    ["--health-path", healthPath],
    ["--build-id-path", buildIdPath],
  ]) {
    const p = routePathProblem(name, value);
    if (p) refusals.push(p);
  }

  if (trigger === "none") {
    if (!why) refusals.push('--trigger none records that this project does not deploy, which needs --why "<reason>"');
  } else if (!url) {
    refusals.push("--url is required unless --trigger is none");
  } else if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    refusals.push(`--url "${url}" is not an absolute http(s) URL`);
  }

  const d = detect(repo);
  if (d.problems.length && !force) {
    refusals.push(...d.problems.map((p) => `${p} (--force --why "<reason>" to record a config anyway)`));
  }

  // THE FALSE CLAIM gstack WRITES. Nothing here can override it, because the
  // repository state that contradicts it is not a matter of opinion.
  if (trigger === "git-push" && d.git.isRepo && d.git.remotes.length === 0) {
    refusals.push(
      `--trigger git-push, but ${repo} is a git repository with zero remotes. There is nothing to push to, so no push can ` +
        `deploy this. Record the real trigger (\`cli\` with --deploy-cmd) instead. --force does not apply: this is not a judgement call.`,
    );
  }

  const known = new Set(d.candidates.map((c) => c.platform));
  if (platform && !known.has(platform) && !force) {
    refusals.push(
      `no evidence on disk for platform "${platform}" (found: ${known.size ? [...known].join(", ") : "nothing"}). ` +
        `Pass --force --why "<reason>" if the deploy really is configured somewhere this cannot see.`,
    );
  }
  if (force && !why) refusals.push('--force requires --why "<reason>", recorded in the config');

  if (refusals.length) return fail(json, EXIT_REFUSED, refusals);

  const cfg = {
    version: 1,
    platform,
    url: url || null,
    trigger,
    deployCommand: deployCommand || null,
    statusCommand: statusCommand || null,
    healthPath: healthPath || null,
    buildIdPath: buildIdPath || null,
    gitRemotes: d.git.remotes.map((x) => x.url),
    evidence: (d.candidates.find((c) => c.platform === platform)?.evidence ?? []).slice(0, 6),
    forced: force ? why : null,
    note: trigger === "none" ? why : null,
    writtenBy: `toolbay-stack tb-deploy ${VERSION}`,
    writtenAt: new Date().toISOString(),
  };

  const block = renderBlock(cfg);
  const existing = readIfPresent(file);
  if (existing.error) return fail(json, EXIT_UNUSABLE, `${file} exists but could not be read (${existing.error})`);

  let next;
  if (!existing.present) {
    next = `${HEADING}\n\n${block}\n`;
  } else {
    const text = existing.text;
    const i = text.indexOf(BEGIN);
    const j = text.indexOf(END);
    if (i !== -1 && j !== -1 && j > i) {
      // Replace in place. Two runs must not leave two blocks.
      next = text.slice(0, i) + block + text.slice(j + END.length);
    } else {
      const sep = text.endsWith("\n") ? "\n" : "\n\n";
      next = `${text}${sep}${HEADING}\n\n${block}\n`;
    }
  }

  try {
    fs.writeFileSync(file, next, "utf8");
  } catch (e) {
    return fail(json, EXIT_UNUSABLE, `${file} could not be written (${e.code || e.message})`);
  }

  // Read it straight back. A write nobody re-read is a claim, not a fact.
  const back = readBlock(file);
  if (back.error) return fail(json, EXIT_UNUSABLE, `written, but it did not read back: ${back.error}`);

  if (json) out(JSON.stringify({ ok: true, file, config: back.value }, null, 2));
  else {
    out();
    out(`  wrote      ${file}`);
    out(`  platform   ${cfg.platform}`);
    out(`  url        ${cfg.url ?? "(none: this project does not deploy)"}`);
    out(`  trigger    ${cfg.trigger}`);
    out(`  deploy     ${cfg.deployCommand ?? "(none)"}`);
    out(`  health     ${cfg.healthPath ?? "(none)"}`);
    out(`  build id   ${cfg.buildIdPath ?? "(none)"}`);
    out(`  read back  yes, and it parsed`);
    out();
  }
  process.exitCode = EXIT_OK;
}

function cmdRead(args) {
  const json = args.includes("--json");
  const dupes = duplicateFlags(args);
  if (dupes.length) return fail(json, EXIT_REFUSED, `${dupes.join(", ")} given more than once; only the first would have been used`);
  const r = resolveRepo(flag(args, "--repo") || ".");
  if (!r.ok) return fail(json, EXIT_REFUSED, r.error);
  const block = readBlock(configFile(r.dir, args));
  if (block.error) return fail(json, EXIT_UNUSABLE, block.error);
  if (json) out(JSON.stringify({ ok: true, config: block.value }, null, 2));
  else {
    out();
    for (const [k, v] of Object.entries(block.value)) out(`  ${k.padEnd(14)} ${Array.isArray(v) ? v.join(", ") || "(none)" : (v ?? "(none)")}`);
    out();
  }
}

// -------------------------------------------------------------------- verify

/** 7+ hex characters that look like a commit, anywhere in the text. */
const BUILD_ID = /\b[0-9a-f]{7,40}\b/i;

function looksLikeBuildId(text) {
  if (!text) return null;
  // Keyed forms first: they are unambiguous where a bare hex run is not.
  const keyed = /(commit|sha|revision|build[_-]?id|version)["'\s:=]+([0-9a-zA-Z._-]{7,64})/i.exec(text);
  if (keyed && BUILD_ID.test(keyed[2])) return keyed[2];
  return null;
}

async function fetchStatus(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "toolbay-stack/tb-deploy" } });
    const body = await res.text().catch(() => "");
    const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    return { ok: true, status: res.status, body, headers };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? `no answer within ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function cmdVerify(args) {
  const json = args.includes("--json");
  const dupes = duplicateFlags(args);
  if (dupes.length) return fail(json, EXIT_REFUSED, `${dupes.join(", ")} given more than once; only the first would have been used`);
  const r = resolveRepo(flag(args, "--repo") || ".");
  if (!r.ok) return fail(json, EXIT_REFUSED, r.error);
  const repo = r.dir;
  const file = configFile(repo, args);
  const block = readBlock(file);
  if (block.error) return fail(json, EXIT_UNUSABLE, block.error);
  const cfg = block.value;

  const checks = [];
  const record = (name, verdict, pass, detail) => checks.push({ name, verdict, pass, detail });

  // 1. Commands, resolved against PATH and PATHEXT rather than piped to head.
  for (const [label, cmdline] of [
    ["deploy command", cfg.deployCommand],
    ["status command", cfg.statusCommand],
  ]) {
    if (!cmdline) {
      const required = label === "deploy command" && cfg.trigger === "cli";
      record(label, required ? "MISSING" : "not configured", !required, required ? "trigger is cli, so a deploy command is the whole configuration" : "nothing to check");
      continue;
    }
    const w = whichExe(cmdline);
    record(label, w.found ? "installed" : "MISSING", w.found, w.found ? w.at : w.why);
  }

  // 2. The trigger, re-checked against the repository as it is NOW. A config
  //    written when a remote existed is not evidence that one still does.
  const git = gitFacts(repo);
  if (cfg.trigger === "git-push") {
    const ok = git.isRepo && git.remotes.length > 0;
    record("git-push trigger", ok ? "possible" : "IMPOSSIBLE", ok, ok ? `${git.remotes.length} remote(s)` : "the repository has no remote, so a push cannot deploy anything");
  } else {
    record("git-push trigger", `not claimed (${cfg.trigger})`, true, "nothing to contradict");
  }

  // 3. The URL.
  if (cfg.trigger === "none") {
    record("production url", "not applicable", true, cfg.note || "recorded as a project that does not deploy");
  } else {
    const ok = typeof cfg.url === "string" && /^https?:\/\/[^\s/]+/i.test(cfg.url);
    record("production url", ok ? "well formed" : "UNUSABLE", ok, ok ? cfg.url : `"${cfg.url}" is not an absolute http(s) URL`);
  }

  // 4. The live check. Offline inputs exist so this is testable; the default is
  //    a real request. `--config-only` is the ONLY way to skip it, and it is
  //    reported in the output so nobody reads a config-only pass as a live one.
  const configOnly = args.includes("--config-only");
  const statusArg = flag(args, "--status");
  const bodyFile = flag(args, "--body-file");
  let probe = null;

  if (configOnly) {
    record("live url", "NOT CHECKED", true, "--config-only was passed, so nothing about production was verified here");
  } else if (cfg.trigger === "none") {
    record("live url", "not applicable", true, "this project does not deploy");
  } else if (statusArg !== undefined && statusArg !== "") {
    const status = Number(statusArg);
    if (!Number.isFinite(status)) return fail(json, EXIT_UNUSABLE, `--status "${statusArg}" is not a number`);
    let body = "";
    if (bodyFile) {
      const b = readIfPresent(path.resolve(bodyFile));
      if (!b.present || b.error) return fail(json, EXIT_UNUSABLE, `--body-file ${bodyFile} could not be read (${b.error || "not found"})`);
      body = b.text;
    }
    probe = { status, body, headers: "" };
  } else {
    const target = (cfg.url || "").replace(/\/+$/, "") + (cfg.buildIdPath || cfg.healthPath || "");
    if (!/^https?:/i.test(target)) {
      record("live url", "UNUSABLE", false, `nothing fetchable was configured (url=${cfg.url ?? "none"})`);
    } else {
      const res = await fetchStatus(target, Number(flag(args, "--timeout") || 15000));
      if (!res.ok) record("live url", "UNREACHABLE", false, `${target}: ${res.error}`);
      else probe = { status: res.status, body: res.body, headers: res.headers, target };
    }
  }

  if (probe) {
    const ok2xx = probe.status >= 200 && probe.status < 300;
    if (probe.status === 402 || /DEPLOYMENT_DISABLED/i.test(probe.body)) {
      record("live url", "BILLING BLOCKED", false, `HTTP ${probe.status}. The platform is refusing on billing; deploys will fail identically until it is cleared.`);
    } else if (!ok2xx) {
      // gstack's `curl -sf ... -w %{http_code} || echo UNREACHABLE` prints the
      // status and the word UNREACHABLE glued together. One verdict here.
      record("live url", "NOT OK", false, `HTTP ${probe.status} from ${probe.target ?? "the supplied response"}`);
    } else {
      const id = looksLikeBuildId(`${probe.headers}\n${probe.body}`);
      if (id) record("live url", "serving a named build", true, `HTTP ${probe.status}, build id ${id}`);
      else {
        record(
          "live url",
          "NO BUILD ID",
          false,
          `HTTP ${probe.status}, but nothing in the response names a commit. A 200 proves the URL is up, not which build is behind it, ` +
            `so /land-and-deploy can only ever report UNPROVEN for this project. One route returning {"commit": <sha>} fixes it permanently.`,
        );
      }
    }
  }

  const failed = checks.filter((c) => !c.pass);
  if (json) {
    out(JSON.stringify({ ok: failed.length === 0, file, config: cfg, checks, configOnly }, null, 2));
  } else {
    out();
    out(`  config     ${file}`);
    const w = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) out(`  ${c.pass ? "ok  " : "FAIL"}  ${c.name.padEnd(w)}  ${c.verdict}`);
    out();
    for (const c of checks) if (!c.pass) out(`  ${c.name}: ${c.detail}`);
    if (!failed.length) {
      out(`  Usable. ${configOnly ? "The live URL was NOT checked (--config-only)." : "Checked against the live URL."}`);
    }
    out();
  }
  process.exitCode = failed.length ? EXIT_NOT_USABLE : EXIT_OK;
}

// -------------------------------------------------------------------- output

function fail(json, code, problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  if (json) out(JSON.stringify({ ok: false, exit: code, problems: list }, null, 2));
  else {
    out();
    for (const p of list) out(`  REFUSED   ${p}`);
    out();
  }
  process.exitCode = code;
}

// ------------------------------------------------------------------ selftest

function runSelf(args, { env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", input, env: { ...process.env, ...env } });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-deploy-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  /** Build a fixture repo. `files` maps relative path -> contents. */
  const repo = (name, files, { git = true, remote = "https://github.com/o/x.git" } = {}) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, "utf8");
    }
    if (git) {
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".git", "config"),
        `[core]\n\trepositoryformatversion = 0\n` + (remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""),
        "utf8",
      );
    }
    return dir;
  };
  const detectJson = (dir, extra = []) => {
    const r = runSelf(["detect", "--json", "--repo", dir, ...extra]);
    let v = {};
    try {
      v = JSON.parse(r.stdout || "{}");
    } catch {
      /* leave */
    }
    return { ...r, v };
  };

  const RAILWAY = JSON.stringify({ build: { builder: "DOCKERFILE" }, deploy: { startCommand: "./run.sh", healthcheckPath: "/api/health" } }, null, 2);

  // ------------------------------------------------------------- detection
  {
    // THE MEASURED CASE. A repo with a stale .vercel link, a real railway.json,
    // and zero git remotes. gstack prints PLATFORM:vercel and PLATFORM:railway
    // with no tie-break, then Step 3's Vercel section says it deploys on push.
    const dir = repo(
      "toolbay-shape",
      { "railway.json": RAILWAY, ".vercel/project.json": JSON.stringify({ projectId: "prj_1", orgId: "team_1", name: "toolbay" }) },
      { remote: null },
    );
    const { v, status } = detectJson(dir);
    check("two platforms with evidence is ambiguous, not a decision", true, v.ambiguous === true, JSON.stringify(v.candidates?.map((c) => c.platform)));
    check("...and exits non-zero so the skill has to ask", 1, status);
    check("...and ranks the committed config above the stale link dir", "railway", v.ranked);
    check("...and reads the health path out of railway.json", "/api/health", v.healthPath);
    check("...and says push cannot deploy a repo with no remote", "cli", v.trigger?.class);
    check("...and marks that conclusion as proved, not guessed", true, v.trigger?.proved === true, JSON.stringify(v.trigger));
  }
  {
    const dir = repo("netlify-only", { "netlify.toml": '[build]\n  publish = "dist"\n  command = "npm run build"\n' });
    const { v, status } = detectJson(dir);
    check("a single platform is decided, not left ambiguous", false, v.ambiguous);
    check("...and exits 0", 0, status);
    check("...and a repo WITH a remote is probable-git-push", "git-push", v.trigger?.class);
    check("...and that probability is NOT reported as proved", false, v.trigger?.proved);
  }
  {
    const dir = repo("nothing", { "README.md": "hi\n" });
    const { v, status } = detectJson(dir);
    check("a repo with no deploy config finds no platform", 0, v.candidates?.length);
    check("...and exits non-zero rather than passing with nothing", 1, status);
  }
  {
    const dir = repo("corrupt", { "railway.json": "{ this is not json", "netlify.toml": "[build]\n" });
    const { v, status } = detectJson(dir);
    check("a deploy config that will not parse is UNUSABLE, not skipped", 2, status);
    check("...and names the file", true, /railway\.json/.test(JSON.stringify(v.problems)), JSON.stringify(v.problems));
  }
  {
    // A config file replaced by a directory of the same name: listed, and
    // unreadable, on every platform.
    const dir = repo("unreadable", { "netlify.toml": "[build]\n" });
    fs.mkdirSync(path.join(dir, "vercel.json"));
    const { v, status } = detectJson(dir);
    check("a deploy config that cannot be opened is UNUSABLE, not absent", 2, status);
    check("...and names it", true, /vercel\.json/.test(JSON.stringify(v.problems)), JSON.stringify(v.problems));
  }
  {
    // gstack's land-and-deploy fingerprint only looks at workflows NAMED
    // *deploy*/*cd*. This one is release.yml and it deploys.
    const dir = repo("wf-release", {
      ".github/workflows/release.yml": "name: release\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    steps:\n      - run: npx vercel --prod\n",
    });
    const { v, status } = detectJson(dir);
    check("a deploy workflow not named *deploy* is still found", "ci-workflow", v.trigger?.class);
    check("...and it names the platform it deploys to", "vercel", v.ranked);
    check("...single platform via workflow alone exits 0", 0, status);
  }
  {
    const dir = repo("fly", { "fly.toml": 'app = "orion-api"\n\n[http_service]\n  [http_service.checks]\n    path = "/healthz"\n' });
    const { v } = detectJson(dir);
    check("fly.toml yields the app url without asking", "https://orion-api.fly.dev", v.candidates?.[0]?.url);
    check("...and its check path", "/healthz", v.healthPath);
  }
  {
    const dir = repo("cf", { "wrangler.toml": 'name = "edge-api"\nmain = "src/index.ts"\n' });
    const { v } = detectJson(dir);
    check("cloudflare is detected (gstack does not know this platform)", "cloudflare", v.ranked);
  }
  {
    const dir = repo("buildid", {
      "netlify.toml": "[build]\n",
      "app/api/version/route.ts": "export const GET = () => Response.json({ commit: process.env.COMMIT_SHA });\n",
    });
    const { v } = detectJson(dir);
    check("a route that can name the running commit is found", "/api/version", v.buildIdPath);
  }
  {
    const dir = repo("nobuildid", { "netlify.toml": "[build]\n" });
    const { v } = detectJson(dir);
    check("...and its absence is reported as absent, not assumed", null, v.buildIdPath);
  }
  if (isWindows) {
    check("detect refuses /tmp on Windows, where it means two directories", 3, runSelf(["detect", "--json", "--repo", "/tmp/x"]).status);
  } else {
    check("detect refuses a repo path that does not exist", 3, runSelf(["detect", "--json", "--repo", path.join(tmp, "nope")]).status);
  }

  // ----------------------------------------------------------------- write
  const W = (dir, extra) => runSelf(["write", "--json", "--repo", dir, ...extra]);
  {
    const dir = repo("w-noremote", { "railway.json": RAILWAY }, { remote: null });
    const r = W(dir, ["--platform", "railway", "--url", "https://toolbay.ai", "--trigger", "git-push"]);
    check("write REFUSES git-push in a repo with no remote (gstack writes it)", 3, r.status, r.stdout.slice(0, 200));
    check("...and says why", true, /zero remotes/.test(r.stdout), r.stdout.slice(0, 300));
    const ok = W(dir, ["--platform", "railway", "--url", "https://toolbay.ai", "--trigger", "cli", "--deploy-cmd", "railway up", "--health-path", "/api/health"]);
    check("...and accepts the trigger that is actually true", 0, ok.status, ok.stdout.slice(0, 300));
    check("...and --force cannot override it", 3, W(dir, ["--platform", "railway", "--url", "https://toolbay.ai", "--trigger", "git-push", "--force", "--why", "I said so"]).status);
  }
  {
    const dir = repo("w-placeholder", { "netlify.toml": "[build]\n" });
    const r = W(dir, ["--platform", "netlify", "--url", "{url}", "--trigger", "git-push"]);
    check("write refuses gstack's literal {url} placeholder", 3, r.status, r.stdout.slice(0, 200));
    check("write refuses a url that is not http(s)", 3, W(dir, ["--platform", "netlify", "--url", "toolbay.ai", "--trigger", "git-push"]).status);
    check("write refuses an unknown trigger word", 3, W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "magic"]).status);
    // Git Bash rewrites a leading "/" argument to a Windows path before the
    // program starts, so this is what `--health-path /api/health` can arrive as.
    const mangled = W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push", "--health-path", "C:/Program Files/Git/api/health"]);
    check("write refuses an MSYS-mangled health path instead of storing it", 3, mangled.status, mangled.stdout.slice(0, 200));
    check("...and names the shell that did it", true, /Git Bash|MSYS_NO_PATHCONV/.test(mangled.stdout), mangled.stdout.slice(0, 300));
    check("write refuses a health path that is not a path at all", 3, W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push", "--build-id-path", "api/version"]).status);
    const esc = W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push", "--health-path", "//api/health"]);
    let escCfg = {};
    try {
      escCfg = JSON.parse(esc.stdout || "{}").config ?? {};
    } catch {
      /* leave */
    }
    check("the //path escape is normalised, not stored protocol-relative", "/api/health", escCfg.healthPath, esc.stdout.slice(0, 200));
  }
  {
    const dir = repo("w-noevidence", { "README.md": "x\n" });
    check("write refuses a platform nothing on disk supports", 3, W(dir, ["--platform", "vercel", "--url", "https://a.test", "--trigger", "git-push"]).status);
    check("...and --force alone is not enough", 3, W(dir, ["--platform", "vercel", "--url", "https://a.test", "--trigger", "git-push", "--force"]).status);
    check("...but --force --why is", 0, W(dir, ["--platform", "vercel", "--url", "https://a.test", "--trigger", "git-push", "--force", "--why", "linked in the dashboard only"]).status);
  }
  {
    const dir = repo("w-idempotent", { "netlify.toml": "[build]\n", "CLAUDE.md": "# Project\n\nSome existing notes.\n\n## Testing\n\nnpm test\n" });
    const args = ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push"];
    check("first write succeeds", 0, W(dir, args).status);
    check("a flag given twice is REFUSED, not silently first-wins", 3, W(dir, [...args, "--url", "https://b.test"]).status);
    check("second write succeeds", 0, W(dir, ["--platform", "netlify", "--url", "https://b.test", "--trigger", "git-push"]).status);
    const text = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    const blocks = text.split(BEGIN).length - 1;
    check("writing twice leaves ONE config block, not two", 1, blocks);
    check("...and the rest of CLAUDE.md is untouched", true, text.includes("## Testing") && text.includes("Some existing notes."), text.slice(0, 120));
    const rd = runSelf(["read", "--json", "--repo", dir]);
    let cfg = {};
    try {
      cfg = JSON.parse(rd.stdout || "{}").config ?? {};
    } catch {
      /* leave */
    }
    check("...and the second write is what reads back", "https://b.test", cfg.url);
  }
  {
    const dir = repo("w-nodeploy", { "README.md": "x\n" });
    check("write refuses --trigger none with no stated reason", 3, W(dir, ["--platform", "none", "--trigger", "none"]).status);
    check("...and accepts it with one", 0, W(dir, ["--platform", "none", "--trigger", "none", "--why", "npm package, nothing deploys", "--force"]).status);
  }
  {
    const dir = repo("w-corrupt-cfg", { "netlify.toml": "[build]\n", "CLAUDE.md": `# x\n\n${BEGIN}\n\n\`\`\`json\n{ not json\n\`\`\`\n\n${END}\n` });
    check("read of a corrupt config block is UNUSABLE, not empty", 2, runSelf(["read", "--json", "--repo", dir]).status);
    check("verify of a corrupt config block is UNUSABLE, not a pass", 2, runSelf(["verify", "--json", "--repo", dir, "--config-only"]).status);
  }
  {
    const dir = repo("w-gstack-prose", {
      "netlify.toml": "[build]\n",
      "CLAUDE.md": "# x\n\n## Deploy Configuration (configured by /setup-deploy)\n- Platform: netlify\n- Production URL: {url}\n",
    });
    const r = runSelf(["read", "--json", "--repo", dir]);
    check("gstack's prose config is not mistaken for configuration", 2, r.status, r.stdout.slice(0, 200));
    check("...and the reason names the format", true, /cannot be parsed|nothing can parse it back/i.test(r.stdout), r.stdout.slice(0, 300));
  }
  check("verify with no config at all is UNUSABLE, not a pass", 2, runSelf(["verify", "--json", "--repo", repo("v-none", { "netlify.toml": "[build]\n" }), "--config-only"]).status);

  // ---------------------------------------------------------------- verify
  //
  // The gstack shape being replaced:
  //   {deploy-status-command} 2>/dev/null | head -5 || echo "COMMAND_FAILED"
  // measured to exit 0, print nothing, and print no COMMAND_FAILED when the
  // command does not exist.
  {
    const dir = repo("v-missing-cmd", { "railway.json": RAILWAY }, { remote: null });
    W(dir, ["--platform", "railway", "--url", "https://a.test", "--trigger", "cli", "--deploy-cmd", "railway-cli-that-is-not-installed up"]);
    const r = runSelf(["verify", "--json", "--repo", dir, "--config-only"]);
    check("verify FAILS on a deploy command that is not installed", 1, r.status, r.stdout.slice(0, 300));
    check("...and calls it MISSING", true, /MISSING/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    // Prove the PATH+PATHEXT resolution really resolves, using a file this test
    // creates, so the assertion does not depend on what is installed here.
    const bin = path.join(tmp, "fakebin");
    fs.mkdirSync(bin, { recursive: true });
    const name = isWindows ? "tbfake.cmd" : "tbfake";
    fs.writeFileSync(path.join(bin, name), isWindows ? "@echo off\r\necho ok\r\n" : "#!/bin/sh\necho ok\n", "utf8");
    if (!isWindows) fs.chmodSync(path.join(bin, name), 0o755);
    const dir = repo("v-found-cmd", { "railway.json": RAILWAY }, { remote: null });
    W(dir, ["--platform", "railway", "--url", "https://a.test", "--trigger", "cli", "--deploy-cmd", "tbfake up"]);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, Path: `${bin}${path.delimiter}${process.env.PATH}` };
    const r = runSelf(["verify", "--json", "--repo", dir, "--config-only"], { env });
    check(`verify resolves a command on PATH without \`which\` (${name})`, 0, r.status, r.stdout.slice(0, 400));
    const r2 = runSelf(["verify", "--json", "--repo", dir, "--config-only"], { env: { PATH: bin, Path: bin } });
    check("...and finds it with PATH cut down to just that directory", 0, r2.status, r2.stdout.slice(0, 300));
  }
  {
    const dir = repo("v-live", { "netlify.toml": "[build]\n" });
    W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push", "--build-id-path", "/api/version"]);
    const bodyOk = path.join(tmp, "body-ok.json");
    fs.writeFileSync(bodyOk, JSON.stringify({ commit: "9f2c1ab", builtAt: "now" }), "utf8");
    const bodyPlain = path.join(tmp, "body-plain.html");
    fs.writeFileSync(bodyPlain, "<html><body><h1>Everything is fine</h1></body></html>", "utf8");
    const body402 = path.join(tmp, "body-402.txt");
    fs.writeFileSync(body402, "DEPLOYMENT_DISABLED", "utf8");

    check("verify passes when the live response names a build", 0, runSelf(["verify", "--json", "--repo", dir, "--status", "200", "--body-file", bodyOk]).status);
    const noid = runSelf(["verify", "--json", "--repo", dir, "--status", "200", "--body-file", bodyPlain]);
    check("a healthy 200 with no build identifier does NOT pass", 1, noid.status, noid.stdout.slice(0, 300));
    check("...and is named NO BUILD ID rather than a vague failure", true, /NO BUILD ID/.test(noid.stdout), noid.stdout.slice(0, 400));
    const four04 = runSelf(["verify", "--json", "--repo", dir, "--status", "404"]);
    check("a 404 health check fails", 1, four04.status);
    check('...and does not print "404UNREACHABLE" as one token', false, /404UNREACHABLE/.test(four04.stdout), four04.stdout.slice(0, 200));
    check("a 402 is called out as a billing block", true, /BILLING BLOCKED/.test(runSelf(["verify", "--json", "--repo", dir, "--status", "402", "--body-file", body402]).stdout));
  }
  {
    // A config written while a remote existed, verified after it went away.
    const dir = repo("v-stale-trigger", { "netlify.toml": "[build]\n" });
    check("a git-push config writes while the remote exists", 0, W(dir, ["--platform", "netlify", "--url", "https://a.test", "--trigger", "git-push"]).status);
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
    const r = runSelf(["verify", "--json", "--repo", dir, "--config-only"]);
    check("verify re-checks the trigger and fails once the remote is gone", 1, r.status, r.stdout.slice(0, 300));
    check("...and calls it IMPOSSIBLE", true, /IMPOSSIBLE/.test(r.stdout), r.stdout.slice(0, 300));
  }
  {
    // A worktree: .git is a file. gstack's Step 3 never looks at git at all, so
    // this is only a regression guard on the remote reader.
    const main = repo("wt-main", { "netlify.toml": "[build]\n" });
    const wt = path.join(tmp, "wt-linked");
    fs.mkdirSync(path.join(wt), { recursive: true });
    fs.writeFileSync(path.join(wt, "netlify.toml"), "[build]\n", "utf8");
    const gitdir = path.join(main, ".git", "worktrees", "linked");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    const { v } = detectJson(wt);
    check("a linked worktree still finds the repository's remotes", 1, v.git?.remotes?.length, JSON.stringify(v.git));
  }

  const EXPECTED = 67;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  return report("tb-deploy", results);
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
  process.stdout.write("\n  Every case above is a way a deploy configuration can be written down wrong and\n");
  process.stdout.write("  read clean: two platforms and no decision, a push trigger in a repo with no\n");
  process.stdout.write("  remote, a {url} placeholder, a second config block appended beside the first,\n");
  process.stdout.write("  a deploy command that is not installed, and a 200 that names no build.\n");
  process.stdout.write("  None of them exits 0 here.\n\n");
  return true;
}

// --------------------------------------------------------------------- entry

function help() {
  out(`
  tb-deploy ${VERSION}  (Toolbay Stack)

  detect [--repo R] [--json]
      rank the deploy platforms that have evidence on disk, read the health
      path and app name out of their configs, find a route that can name the
      running commit, and decide whether a git push can deploy this at all.
      Exit 0 only when exactly one platform has evidence.

  write --platform P --trigger T [--url U] [--deploy-cmd C] [--status-cmd C]
        [--health-path P] [--build-id-path P] [--repo R] [--file F]
        [--force --why "<reason>"]
      write the configuration into CLAUDE.md as a parseable block, replacing
      any earlier one in place, and read it straight back.

  read   [--repo R] [--json]        print the stored configuration
  verify [--repo R] [--config-only | --status N --body-file F] [--timeout ms]
      prove the stored configuration is usable: the deploy command resolves on
      PATH, the trigger is still possible, and the live URL names a build.

  selftest

  Exit: 0 usable, 1 not usable, 2 unusable input or stored config, 3 refused.
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

async function main() {
  if (cmd === "detect") return cmdDetect(rest);
  if (cmd === "write") return cmdWrite(rest);
  if (cmd === "read") return cmdRead(rest);
  if (cmd === "verify") return cmdVerify(rest);
  if (cmd === "selftest") return selftest();
  return help();
}

main().catch((e) => {
  errOut(`tb-deploy: ${e?.stack ?? e}`);
  process.exit(EXIT_UNUSABLE);
});
