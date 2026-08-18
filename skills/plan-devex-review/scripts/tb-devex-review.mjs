#!/usr/bin/env node
/**
 * tb-devex-review.mjs: the measurable parts of /plan-devex-review.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The review methodology this supports (developer-experience plan
 * review; the three modes DX EXPANSION / DX POLISH / DX TRIAGE; Step 0's persona
 * interrogation, empathy narrative, competitive benchmark, magical-moment design,
 * journey trace and first-time-developer roleplay; the eight review passes; the
 * DX First Principles; the DX Scorecard, the DX Implementation Checklist and the
 * DX Hall of Fame) comes from `plan-devex-review` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or endorsed
 * by Garry Tan.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * The review is a prompt and stays a prompt. What is code here is only the
 * places where gstack's version asks a model to certify its own work, or asks a
 * POSIX shell for something Windows does not have. Four of them, all failing in
 * the same direction: the review reads as complete and measured, having measured
 * nothing.
 *
 * 1. THE DX TREND IS STRUCTURALLY DEAD, AND ITS DEATH LOOKS LIKE A FIRST REVIEW.
 *    gstack's DX Trend Check is:
 *
 *      eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
 *      ~/.claude/skills/gstack/bin/gstack-review-read 2>/dev/null \
 *        | grep plan-devex-review || echo "NO_PRIOR_DX_REVIEWS"
 *
 *    gstack-review-read cats `$GSTACK_HOME/projects/$SLUG/$BRANCH-reviews.jsonl`.
 *    The log is keyed by BRANCH. Plan reviews happen on feature branches, and the
 *    next plan is a different feature on a different branch, so the lookup that
 *    is supposed to produce the Scorecard's `Prior` and `Trend` columns almost
 *    never finds the prior review. Reproduced on Windows 11, 2026-08-14:
 *
 *      $ echo '{"skill":"plan-devex-review","overall_score":4}' \
 *          > ~/.gstack/projects/demo-slug/feat-dx-reviews.jsonl
 *      $ SLUG=demo-slug BRANCH=feat-next bash -c \
 *          'cat "$HOME/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl" 2>/dev/null \
 *           || echo NO_REVIEWS' | grep plan-devex-review || echo "NO_PRIOR_DX_REVIEWS"
 *      NO_PRIOR_DX_REVIEWS
 *
 *    Every other way that lookup can break lands on the same string: a missing
 *    or non-executable gstack-review-read (`2>/dev/null` eats it), an unreadable
 *    projects directory, a slug that resolved differently this time. `grep ... ||
 *    echo` cannot tell "there is no history" from "I could not read the history",
 *    and the review then reports a first-ever DX review to a project on its
 *    fourth. `context` reads every branch's log for the slug, prints the prior
 *    scores it found, and exits 2 — not "no prior reviews" — when the directory
 *    exists and cannot be listed.
 *
 * 2. TTHW IS THE HEADLINE METRIC AND IT IS AN ESTIMATE. The whole review scores
 *    against "time to hello world", which gstack obtains by asking the model to
 *    "trace the actual path" through the README. A model tracing a README finds
 *    what a README says. It cannot find the defect that actually ends the
 *    getting-started path — the command in the quickstart that cannot run at all:
 *    an `npm run dev` with no `dev` script in package.json, a `cp .env.example
 *    .env` with no `.env.example` in the repo, a copy-paste block still holding
 *    `YOUR_API_KEY`. All three read perfectly. `tthw` runs the README's commands
 *    against the repository they claim to work in and exits non-zero when the
 *    documented path is broken.
 *
 * 3. THE PRODUCT TYPE IS INFERRED FROM THE PLAN'S PROSE. gstack's Auto-Detect
 *    gate maps "mentions CLI commands, flags, arguments, terminal -> CLI Tool"
 *    off the plan text, and a plan that mentions a terminal is not a CLI. The
 *    type selects the persona menu, the passes and the whole rubric. `surface`
 *    reads the repository instead (a `bin` map, an `exports` map, route files, a
 *    Dockerfile, a SKILL.md), prints the evidence file for each verdict, and when
 *    there is no evidence returns UNDETERMINED rather than a confident guess.
 *
 * 4. THE SCORECARD IS A TEMPLATE OF BLANKS AND NOTHING CHECKS IT. gstack's
 *    required output is a table of `__/10` cells, `__ min`, `[Champion/
 *    Competitive/Needs Work/Red Flag]` and `[covered/gap]`. Pasted unfilled it is
 *    a completed-looking review, and the model that pasted it is the one gstack
 *    asks whether the review is done. `gate` reads the plan off disk and refuses
 *    a scorecard still carrying its blanks, a checklist still saying "[target
 *    from 0C]", a persona card with no persona, an empathy narrative that is not
 *    a narrative, and a journey map of `[action]` rows.
 *
 * Design rules, same as the rest of Toolbay Stack:
 *   - FAIL CLOSED. No path returns "fine" because a check could not run.
 *     Unreadable input has its own exit code and is never reported as "nothing
 *     found".
 *   - NO INTERPRETER BUT NODE. No `eval "$(...)"`, no `grep ... || echo`, no
 *     `ls -t <glob> | head -1`, no zsh `setopt +o nomatch`, no `find -mmin`, no
 *     `source <(...)`, no `open`, no `$PPID`, no `/tmp`, no jq, no bun. Every one
 *     of those is in the gstack version of this skill.
 *   - PROVE IT. `selftest` runs this executable as a child process against
 *     deliberately broken repositories and plans, and asserts each one is caught.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromMsysPath } from "./tb-paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(SELF, "..", "..");
const VERSION = "0.1.0";

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);

const EXIT_OK = 0; // the check ran and passed
const EXIT_REJECTED = 1; // the check ran and FAILED
const EXIT_UNUSABLE = 2; // the input could not be read
const EXIT_UNDETERMINED = 3; // a precondition could not be established: refuse

// --------------------------------------------------------------------- paths

const isWindows = process.platform === "win32";

function expand(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  s = fromMsysPath(s);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function readFileOr(p) {
  try {
    return { ok: true, text: fs.readFileSync(p, "utf8") };
  } catch (e) {
    return { ok: false, code: e.code || "EUNKNOWN", error: e.message };
  }
}

// ------------------------------------------------------------------ git facts

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) {
    return { ok: false, error: (res.stderr || res.error?.message || `git ${args[0]} exited ${res.status}`).split("\n")[0].trim() };
  }
  return { ok: true, text: res.stdout.trim() };
}

function sanitizeSlug(s) {
  const cleaned = String(s).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function repoSlug(repo) {
  const remote = git(repo, ["remote", "get-url", "origin"]);
  if (remote.ok && remote.text) {
    const base = remote.text.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
    if (base) return { slug: sanitizeSlug(base), source: "origin remote" };
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (top.ok && top.text) return { slug: sanitizeSlug(path.basename(top.text)), source: "repository directory name" };
  return { slug: sanitizeSlug(path.basename(repo)), source: "working directory name (not a git repository)" };
}

function currentBranch(repo) {
  const b = git(repo, ["branch", "--show-current"]);
  if (b.ok && b.text) return { ok: true, branch: b.text, safe: b.text.replace(/\//g, "-") };
  const d = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (d.ok && d.text) return { ok: true, branch: d.text, safe: d.text.replace(/\//g, "-") };
  return { ok: false, branch: null, safe: null, error: b.error ?? "no branch" };
}

// ---------------------------------------------------------------- artifacts
//
// ~/.gstack/projects/<slug> on purpose: it is where gstack already writes and
// where /autoplan's aggregator already looks, so a mixed install stays whole.

function artifactsDirFor(slug) {
  const override = process.env.TOOLBAY_DEVEX_ARTIFACTS_DIR;
  if (override) return expand(override);
  return path.join(os.homedir(), ".gstack", "projects", slug);
}

function listDir(dir) {
  try {
    return { state: "read", names: fs.readdirSync(dir) };
  } catch (e) {
    if (e.code === "ENOENT") return { state: "absent", names: [], note: `${dir} does not exist yet` };
    return { state: "unreadable", names: [], error: `${dir} exists but could not be listed (${e.code || e.message})` };
  }
}

/**
 * Every DX review record for this project, from every branch.
 *
 * gstack reads exactly one file, `$BRANCH-reviews.jsonl`, so the trend it prints
 * is the trend of the branch you happen to be on — which for a plan review is a
 * branch that has never been reviewed before. The prior scores are on disk one
 * filename over. This reads them all and sorts by timestamp, and reports an
 * unreadable directory as unreadable rather than as an empty history.
 */
function priorDxReviews(slug) {
  const dir = artifactsDirFor(slug);
  const listing = listDir(dir);
  if (listing.state !== "read") return { dir, state: listing.state, note: listing.note, error: listing.error, records: [] };
  const records = [];
  const unreadable = [];
  for (const name of listing.names) {
    if (!/reviews\.jsonl$/i.test(name) && !/^dx-reviews\.jsonl$/i.test(name)) continue;
    const file = path.join(dir, name);
    const r = readFileOr(file);
    if (!r.ok) {
      unreadable.push(`${name} (${r.code})`);
      continue;
    }
    for (const line of r.text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let rec = null;
      try {
        rec = JSON.parse(s);
      } catch {
        continue; // a corrupt line is not a review; it is also not an absence
      }
      if (rec && typeof rec.skill === "string" && /devex/i.test(rec.skill)) records.push({ ...rec, _file: name });
    }
  }
  records.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return { dir, state: "read", records, unreadable };
}

// ------------------------------------------------------------ repository walk

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage", "vendor",
  ".venv", "venv", "__pycache__", "target", ".turbo", "tmp", ".cache", ".svelte-kit",
]);

function walk(root, { maxDepth = 4, maxFiles = 4000 } = {}) {
  const files = [];
  let truncated = false;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && e.name !== ".github") continue;
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return { files, truncated };
}

function readJsonFile(p) {
  const r = readFileOr(p);
  if (!r.ok) return { ok: false, code: r.code };
  try {
    return { ok: true, json: JSON.parse(r.text) };
  } catch (e) {
    return { ok: false, code: "EPARSE", error: e.message };
  }
}

// --------------------------------------------------------- product surface
//
// gstack infers the product type from the PLAN's prose. This reads the repo.

function detectSurface(root) {
  const { files, truncated } = walk(root);
  const has = (rel) => files.includes(rel);
  const any = (re) => files.filter((f) => re.test(f));
  const types = [];
  const add = (type, evidence) => {
    const found = types.find((t) => t.type === type);
    if (found) found.evidence.push(evidence);
    else types.push({ type, evidence: [evidence] });
  };

  const pkgPath = path.join(root, "package.json");
  let pkg = null;
  if (has("package.json")) {
    const r = readJsonFile(pkgPath);
    if (r.ok) pkg = r.json;
    else if (r.code === "EPARSE") add("UNPARSEABLE", "package.json is present and is not valid JSON");
  }

  if (pkg) {
    if (pkg.bin && (typeof pkg.bin === "string" || Object.keys(pkg.bin).length)) {
      const names = typeof pkg.bin === "string" ? [pkg.name] : Object.keys(pkg.bin);
      add("CLI Tool", `package.json bin: ${names.join(", ")}`);
    }
    if (pkg.exports || pkg.main || pkg.module || pkg.types) {
      add("Library/SDK", `package.json ${["exports", "main", "module", "types"].filter((k) => pkg[k]).join(" + ")}`);
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const serverDeps = ["express", "fastify", "koa", "hono", "@nestjs/core", "apollo-server", "graphql-yoga", "next"].filter((d) => deps[d]);
    if (serverDeps.length) add("API/Service", `package.json dependency: ${serverDeps.join(", ")}`);
  }

  const openapi = any(/(^|\/)(openapi|swagger)\.(ya?ml|json)$/i);
  if (openapi.length) add("API/Service", `spec file: ${openapi[0]}`);
  const routes = any(/(^|\/)(routes?|api)\/.+\.(ts|js|mjs|py|go|rb)$/i);
  if (routes.length >= 2) add("API/Service", `${routes.length} route files, e.g. ${routes[0]}`);

  const skills = any(/(^|\/)SKILL\.md$/);
  if (skills.length) add("Claude Code Skill", `${skills.length} SKILL.md file(s), e.g. ${skills[0]}`);
  if (has(".mcp.json") || any(/(^|\/)mcp[-.]server\./i).length) add("Claude Code Skill", "MCP server manifest");

  const platform = ["Dockerfile", "docker-compose.yml", "vercel.json", "netlify.toml", "railway.json", "fly.toml"].filter(has);
  if (platform.length) add("Platform", `deploy manifest: ${platform.join(", ")}`);

  const docs = any(/^docs\//).length;
  if (docs >= 3) add("Documentation", `docs/ has ${docs} files`);
  if (has("mkdocs.yml") || has("docusaurus.config.js") || has("docusaurus.config.ts")) add("Documentation", "docs site config");

  const pyPkg = ["pyproject.toml", "setup.py"].filter(has);
  if (pyPkg.length && !types.some((t) => t.type === "Library/SDK")) add("Library/SDK", `python package manifest: ${pyPkg.join(", ")}`);

  return { types: types.filter((t) => t.type !== "UNPARSEABLE"), notes: types.filter((t) => t.type === "UNPARSEABLE"), fileCount: files.length, truncated };
}

// ------------------------------------------------------ getting-started path
//
// The point of this is not to be clever about English. It is to take the
// commands a README tells a developer to run and check them against the repo
// they are supposed to run in.

const GS_HEADING = /^#{1,4}\s*.*\b(getting[ -]started|quick[ -]?start|installation|install|setup|set up|usage|try it|run it|first steps)\b/im;

function fencedBlocks(md) {
  const blocks = [];
  const re = /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)^\1\2[ \t]*$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push({ lang: (m[3] || "").toLowerCase(), body: m[4], index: m.index });
  }
  return blocks;
}

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console", "terminal", "text", "shell-session", "powershell", "ps1", "cmd"]);

function commandLines(block) {
  const lines = [];
  for (const raw of block.body.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("//")) continue;
    if (/^(PS\s+)?[A-Za-z]:\\.*>/.test(line)) line = line.replace(/^.*?>\s*/, "");
    if (line.startsWith("$ ")) line = line.slice(2);
    else if (line === "$") continue;
    else if (/^[>❯➜]\s/.test(line)) line = line.replace(/^[>❯➜]\s+/, "");
    // Output lines: a shell-session block interleaves them. Anything that does
    // not begin with something command-shaped is treated as output, not a step.
    if (!/^[A-Za-z_./\\~][\w./\\@:-]*(\s|$)/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

const PLACEHOLDERS = [
  /\bYOUR[_-][A-Z0-9_]+\b/,
  /<your[ _-][^>]{1,40}>/i,
  /<[A-Z][A-Z0-9_]{2,}>/,
  /\bREPLACE[_-]?ME\b/i,
  /\bCHANGE[_-]?ME\b/i,
  /\bxxxxx+\b/i,
  /\b(sk|pk)_(test|live)_(123|xxx|your)/i,
  /\byour-(api-key|token|project|domain|username)\b/i,
];

const ACCESS_GATES = [
  [/credit card/i, "a credit card is required before the developer sees anything work"],
  [/contact (us|sales)/i, "a sales conversation stands between the developer and a first run"],
  [/request access|join the waitlist|apply for access/i, "access is gated on a human approving it"],
  [/verify your e-?mail|confirm your e-?mail/i, "email verification interrupts the flow before first value"],
  [/sign ?up|create an account|register (an|for an) account/i, "an account is required before the first command can run"],
];

/** npm/pnpm/yarn/bun invocations that are the tool's own, not a package script. */
const PM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "init", "create", "exec",
  "link", "publish", "update", "up", "audit", "outdated", "login", "config", "run", "x", "dlx",
]);

function scriptTargets(cmdLine) {
  // Returns [{pm, script}] for invocations that require a package.json script.
  const targets = [];
  const re = /\b(npm|pnpm|yarn|bun)\b((?:\s+(?:--?[\w-]+(?:=\S+)?))*)\s+([\w:.-]+)/g;
  let m;
  while ((m = re.exec(cmdLine)) !== null) {
    const pm = m[1];
    let word = m[3];
    if (word === "run" || word === "run-script") {
      const after = cmdLine.slice(m.index + m[0].length).trim().split(/\s+/)[0];
      if (after && !after.startsWith("-")) targets.push({ pm, script: after, raw: `${pm} run ${after}` });
      continue;
    }
    if (PM_BUILTINS.has(word)) continue;
    if (pm === "npm" || pm === "pnpm") {
      // `npm start` / `npm test` resolve to scripts; anything else is a typo or a script.
      targets.push({ pm, script: word, raw: `${pm} ${word}` });
    } else if (pm === "yarn" || pm === "bun") {
      targets.push({ pm, script: word, raw: `${pm} ${word}` });
    }
  }
  return targets;
}

const FILE_ARG_RE = [
  /^cp\s+(?:-\w+\s+)*([^\s'"]+)/,
  /^(?:node|python3?|ruby|bash|sh|deno)\s+([^\s'"-][^\s'"]*)/,
  /^\.\/([^\s'"]+)/,
  /^source\s+([^\s'"]+)/,
  /^cat\s+([^\s'"]+)/,
];

function looksLikeRepoPath(p) {
  if (!p) return false;
  if (/[*?${}|<>]/.test(p)) return false; // globs and variables: not checkable
  if (/^[/~]/.test(p)) return false; // absolute: not this repo's business
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (!/[./]/.test(p)) return false; // bare word: probably a subcommand
  return true;
}

function measureGettingStarted(root) {
  const readmeName = ["README.md", "readme.md", "README.MD", "Readme.md", "README.markdown", "README.rst", "README.txt"]
    .find((n) => fs.existsSync(path.join(root, n)));
  if (!readmeName) {
    return { ok: false, reason: "no README at the repository root, so there is no documented getting-started path to measure" };
  }
  const r = readFileOr(path.join(root, readmeName));
  if (!r.ok) return { ok: false, reason: `${readmeName} could not be read (${r.code})` };
  const md = r.text;

  const gsMatch = GS_HEADING.exec(md);
  const region = gsMatch ? md.slice(gsMatch.index) : md;
  const blocks = fencedBlocks(region).filter((b) => SHELL_LANGS.has(b.lang));
  const commands = [];
  for (const b of blocks) commands.push(...commandLines(b));

  const findings = [];
  const finding = (id, blocking, detail) => findings.push({ id, blocking, detail });

  if (!gsMatch) {
    finding("gs.no-heading", false, "no Getting Started / Install / Quick Start heading; a developer has to read the whole README to find the entry point");
  }
  if (!commands.length) {
    finding("gs.no-commands", true, `${readmeName} has no runnable command in any shell code block${gsMatch ? " under its getting-started heading" : ""}, so there is no copy-paste path at all`);
  }

  // 1. Package scripts the README tells you to run that do not exist.
  const pkgRead = readJsonFile(path.join(root, "package.json"));
  const scripts = pkgRead.ok && pkgRead.json && typeof pkgRead.json.scripts === "object" ? pkgRead.json.scripts : null;
  const scriptChecks = [];
  for (const line of commands) {
    for (const t of scriptTargets(line)) {
      if (scripts === null) {
        scriptChecks.push({ ...t, verdict: pkgRead.ok ? "no scripts block" : `package.json ${pkgRead.ok ? "" : pkgRead.code}` });
        finding(
          "gs.script-unresolvable",
          true,
          `README runs \`${t.raw}\` but package.json ${pkgRead.ok ? "has no scripts block" : `could not be read (${pkgRead.code})`}, so the documented path cannot resolve`
        );
      } else if (!Object.prototype.hasOwnProperty.call(scripts, t.script)) {
        scriptChecks.push({ ...t, verdict: "MISSING" });
        finding(
          "gs.broken-script",
          true,
          `README runs \`${t.raw}\` but package.json defines no "${t.script}" script (it defines: ${Object.keys(scripts).join(", ") || "nothing"})`
        );
      } else {
        scriptChecks.push({ ...t, verdict: "ok" });
      }
    }
  }

  // 2. Files the README tells you to copy, source or run that are not there.
  const fileChecks = [];
  for (const line of commands) {
    for (const re of FILE_ARG_RE) {
      const m = re.exec(line);
      if (!m) continue;
      const arg = m[1];
      if (!looksLikeRepoPath(arg)) continue;
      const exists = fs.existsSync(path.join(root, arg));
      fileChecks.push({ command: line, file: arg, exists });
      if (!exists) finding("gs.missing-file", true, `README runs \`${line}\` but ${arg} does not exist in the repository`);
      break;
    }
  }

  // 3. Copy-paste blocks that cannot be pasted.
  for (const line of commands) {
    for (const re of PLACEHOLDERS) {
      if (re.test(line)) {
        finding("gs.placeholder", true, `the copy-paste line \`${line}\` still holds a placeholder, so pasting it fails and the developer must go and find a value first`);
        break;
      }
    }
  }

  // 4. Gates between "I want to try" and "it works".
  const gsProse = region.replace(/```[\s\S]*?```/g, " ").slice(0, 6000);
  for (const [re, why] of ACCESS_GATES) {
    if (re.test(gsProse)) finding("gs.access-gate", false, why);
  }

  // 5. Prerequisites that nothing checks for.
  const prereqs = [];
  for (const [re, name] of [[/\bdocker\b/i, "Docker"], [/\bpostgres|psql\b/i, "PostgreSQL"], [/\bredis\b/i, "Redis"], [/\bnode(js)?\s*(>=?|v)?\s*\d/i, "a specific Node version"], [/\bpython\s*3?\.\d/i, "a specific Python version"], [/\brust|cargo\b/i, "the Rust toolchain"]]) {
    if (re.test(gsProse)) prereqs.push(name);
  }

  const blocking = findings.filter((f) => f.blocking);
  return {
    ok: true,
    readme: readmeName,
    hasGettingStartedHeading: Boolean(gsMatch),
    steps: commands.length,
    commands,
    scriptChecks,
    fileChecks,
    prereqs,
    findings,
    blocking: blocking.length,
    oneCommandInstall: commands.length > 0 && commands.length <= 1,
  };
}

// ------------------------------------------------------- error message census

const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rb", ".rs", ".java", ".cs", ".php"]);

const ERROR_PATTERNS = [
  /throw new [A-Za-z_$][\w$]*Error\s*\(\s*(['"`])([\s\S]*?)\1/g,
  /console\.error\s*\(\s*(['"`])([\s\S]*?)\1/g,
  /raise\s+[A-Za-z_][\w.]*\s*\(\s*(f?['"])([\s\S]*?)\1/g,
  /fmt\.Errorf\s*\(\s*(")([\s\S]*?)\1/g,
  /panic\s*\(\s*(['"`])([\s\S]*?)\1/g,
];

function scoreMessage(msg) {
  const namesValue = /\$\{|%[sdv]|\{\}|\{[a-z_]+\}|"\s*\+\s*|'\s*\+\s*/i.test(msg);
  const namesAction = /\b(try|run|use|set|add|remove|install|check|pass|see|expected|instead|did you mean|must be|should be|make sure|provide)\b/i.test(msg);
  const linksDocs = /https?:\/\//.test(msg);
  return { namesValue, namesAction, linksDocs, score: Number(namesValue) + Number(namesAction) + Number(linksDocs) };
}

function errorCensus(root) {
  const { files, truncated } = walk(root);
  const sources = files.filter((f) => SOURCE_EXT.has(path.extname(f)));
  if (!sources.length) return { ok: true, scanned: 0, messages: [], truncated };
  const messages = [];
  for (const rel of sources.slice(0, 800)) {
    const r = readFileOr(path.join(root, rel));
    if (!r.ok) continue;
    for (const re of ERROR_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(r.text)) !== null) {
        const msg = m[2];
        if (!msg || msg.length < 4) continue;
        const line = r.text.slice(0, m.index).split(/\r?\n/).length;
        messages.push({ file: rel, line, message: msg.slice(0, 160), ...scoreMessage(msg) });
      }
    }
  }
  return { ok: true, scanned: sources.length, messages, truncated };
}

// ----------------------------------------------------------------- plan gate

function readPlan(file) {
  const abs = expand(file);
  if (!abs) return { ok: false, error: "no plan file given (--plan <file>)" };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    return { ok: false, error: `plan file ${abs} could not be opened (${e.code || e.message})` };
  }
  if (!stat.isFile()) return { ok: false, error: `${abs} is not a file` };
  const r = readFileOr(abs);
  if (!r.ok) return { ok: false, error: `plan file ${abs} could not be read (${r.code})` };
  if (!r.text.trim()) return { ok: false, error: `plan file ${abs} is empty, so there is nothing to gate` };
  return { ok: true, path: abs, text: r.text };
}

function sectionBody(text, headingRe) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i]) && headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/** A block of text starting at a marker line, running to the next blank-blank or heading. */
function blockAt(text, markerRe, maxLines = 40) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => markerRe.test(l));
  if (i === -1) return null;
  return lines.slice(i, i + maxLines).join("\n");
}

const SCORECARD_BLANKS = [
  { re: /_{2,}\s*\/\s*10/, why: "a `__/10` cell was never filled in" },
  { re: /_{2,}\s*min/i, why: "the TTHW cell is still `__ min`" },
  { re: /\[\s*Champion\s*\/\s*Competitive/i, why: "the competitive rank is still the template's list of options" },
  { re: /\[\s*designed\s*\/\s*missing\s*\]/i, why: "the magical-moment cell is still `[designed/missing]`" },
  { re: /\[\s*covered\s*\/\s*gap\s*\]/i, why: "a DX principle row is still `[covered/gap]`" },
  { re: /\[\s*EXPANSION\s*\/\s*POLISH/i, why: "the mode cell is still the template's list of options" },
  { re: /\|\s*\[type\]\s*\|/i, why: "the product type cell is still `[type]`" },
];

function gatePlan(text) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });
  const lines = text.split(/\r?\n/);

  // 1. The report exists, and it is the LAST ## section.
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) if (/^##\s/.test(lines[i])) headingIdx.push(i);
  const reportRe = /^##\s+(TOOLBAY\s+)?DX\s+REVIEW\s+REPORT\s*$/i;
  const reportLine = headingIdx.find((i) => reportRe.test(lines[i]));
  add("report.present", reportLine !== undefined, "the review report section is missing; review prose in the plan body is not the report");
  add(
    "report.is-last-section",
    reportLine !== undefined && reportLine === headingIdx[headingIdx.length - 1],
    "the report is present but another `## ` section follows it, so the plan does not end on the review"
  );

  // 2. The persona card, with a persona in it.
  const persona = blockAt(text, /TARGET DEVELOPER PERSONA/i, 12);
  const filledField = (label) => new RegExp(`${label}:[ \\t]*\\S.{4,}`, "i").test(persona ?? "");
  const personaFilled =
    persona !== null &&
    filledField("Who") &&
    filledField("Context") &&
    filledField("Tolerance") &&
    filledField("Expects") &&
    !/\[(description|when\/why|how many|what they)/i.test(persona);
  add("output.persona-card", personaFilled, "the TARGET DEVELOPER PERSONA card is missing or still holds its template placeholders");

  // 3. The empathy narrative has to actually be a narrative.
  const narrative = sectionBody(text, /developer (perspective|empathy)|empathy narrative/i);
  const words = narrative ? narrative.trim().split(/\s+/).filter(Boolean).length : 0;
  const firstPerson = narrative ? /(^|\s)I['’\s]/.test(narrative) : false;
  add(
    "output.empathy-narrative",
    narrative !== null && words >= 100 && firstPerson,
    narrative === null
      ? "no Developer Perspective / Empathy Narrative section"
      : `the narrative is ${words} words and ${firstPerson ? "first person" : "not written in first person"}; gstack asks for 150-250 first-person words and the implementer is meant to feel it`
  );

  // 4. The competitive benchmark, with competitors in it.
  const bench = sectionBody(text, /competitive (dx )?benchmark/i) ?? blockAt(text, /COMPETITIVE DX BENCHMARK/i, 20);
  const benchRows = bench
    ? bench.split(/\r?\n/).filter((l) => /\S/.test(l) && /\|/.test(l) && !/^\s*\|?\s*-{2,}/.test(l) && !/Tool\s*\|/i.test(l))
    : [];
  const competitorRows = benchRows.filter((l) => !/your product/i.test(l) && !/\[(competitor|time|what they|url|est|from README)/i.test(l));
  add(
    "output.benchmark",
    bench !== null && competitorRows.length >= 2 && /your product/i.test(bench),
    `the competitive benchmark needs at least two real competitor rows and a YOUR PRODUCT row; found ${competitorRows.length} competitor row(s). A benchmark of one is a comparison you cannot land a tier against.`
  );

  // 5. The magical moment, with a vehicle named.
  const magic = sectionBody(text, /magical moment/i);
  add(
    "output.magical-moment",
    magic !== null && magic.trim().length > 60 && !/\[(specific moment|vehicle|A\/B\/C\/D)/i.test(magic),
    "no Magical Moment specification naming the chosen delivery vehicle"
  );

  // 6. The journey map, with real rows.
  const journey = sectionBody(text, /developer journey|journey map/i);
  const journeyRows = journey ? journey.split(/\r?\n/).filter((l) => /^\s*\d\.\s|^\|\s*\d\./.test(l)) : [];
  add(
    "output.journey-map",
    journey !== null && journeyRows.length >= 3 && !journeyRows.some((l) => /\[action\]|\[resolved\/deferred\]|\[fixed\/ok\/deferred\]/i.test(l)),
    "the journey map is missing or still carries `[action]` / `[fixed/ok/deferred]` template cells"
  );

  // 7. The confusion report, with a clock in it.
  const confusion = sectionBody(text, /confusion report|first-?time developer/i);
  const stamps = confusion ? (confusion.match(/T\+\d+:\d\d/g) ?? []) : [];
  add(
    "output.confusion-report",
    confusion !== null && stamps.length >= 3 && !/\[What they do first\]/i.test(confusion),
    "the first-time developer report needs at least three T+ observations and must not be the empty template"
  );

  // 8+9. gstack's two never-skippable prose outputs.
  add("output.not-in-scope", sectionBody(text, /not in scope/i) !== null, 'no "NOT in scope" section: DX work considered and deferred has to be written down');
  add("output.already-exists", sectionBody(text, /what already exists/i) !== null, 'no "What already exists" section: existing docs, examples and error handling the plan should reuse');

  // 10. The scorecard, filled.
  const card = blockAt(text, /DX PLAN REVIEW\s*[—-]?\s*SCORECARD|DX SCORECARD/i, 45);
  add("scorecard.present", card !== null, "no DX Scorecard");
  const blanks = card ? SCORECARD_BLANKS.filter((b) => b.re.test(card)) : [];
  add("scorecard.filled", card !== null && blanks.length === 0, card === null ? "no scorecard to check" : blanks.map((b) => b.why).join("; "));

  // 11. The implementation checklist must not still point at Step 0.
  const checklist = blockAt(text, /DX IMPLEMENTATION CHECKLIST/i, 40);
  add(
    "checklist.filled",
    checklist !== null && !/\[(target|vehicle|persona)[^\]]*from 0[A-G]\]/i.test(checklist),
    checklist === null ? "no DX Implementation Checklist" : "the checklist still says `[target from 0C]` / `[vehicle from 0D]` instead of the values that were chosen"
  );

  // 12. The final line is the unresolved-decisions status, unbolded.
  const trimmed = text.replace(/\s+$/, "");
  const finalLine = trimmed.split(/\r?\n/).pop().trim();
  let statusOk = finalLine === "NO UNRESOLVED DECISIONS";
  if (!statusOk && /^[-*]\s+\S/.test(finalLine)) {
    // A trailing bullet only counts if it belongs to an UNRESOLVED DECISIONS block.
    const tail = trimmed.split(/\r?\n/).slice(-25).join("\n");
    statusOk = /UNRESOLVED DECISIONS/i.test(tail);
  }
  add(
    "report.unresolved-status",
    statusOk,
    `the plan's final non-whitespace line is "${finalLine.slice(0, 60)}"; it must be the exact unbolded NO UNRESOLVED DECISIONS, or the last bullet of an UNRESOLVED DECISIONS block`
  );

  return checks;
}

// -------------------------------------------------------------------- output

function printChecks(checks, json) {
  const failed = checks.filter((c) => !c.pass);
  if (json) {
    out(JSON.stringify({ ok: failed.length === 0, passed: checks.filter((c) => c.pass).map((c) => c.id), failed: failed.map((c) => c.id), detail: failed.map((c) => ({ id: c.id, detail: c.detail })) }));
  } else {
    for (const c of checks) out(`  ${c.pass ? "PASS" : "FAIL"}  ${c.id}${c.pass ? "" : `\n        ${c.detail}`}`);
    out("");
    out(failed.length === 0 ? `  ${checks.length}/${checks.length} checks passed. The review report is really there.` : `  ${checks.length - failed.length}/${checks.length} passed. Produce what is named above and run this again. Do NOT call ExitPlanMode.`);
  }
  return failed.length === 0 ? EXIT_OK : EXIT_REJECTED;
}

// ------------------------------------------------------------------ commands

function cmdContext(args) {
  const repo = expand(args.dir ?? process.cwd());
  const json = args.json;
  const { slug, source } = repoSlug(repo);
  const branch = currentBranch(repo);
  const prior = priorDxReviews(slug);
  const surface = detectSurface(repo);

  const payload = {
    slug,
    slugSource: source,
    branch: branch.branch,
    branchState: branch.ok ? "read" : "unresolved",
    artifactsDir: prior.dir,
    artifactsState: prior.state,
    priorReviews: prior.records.map((r) => ({
      timestamp: r.timestamp ?? null,
      branch: r.branch ?? r._file.replace(/-reviews\.jsonl$/, ""),
      overall: r.overall_score ?? null,
      tthw: r.tthw_current ?? null,
      mode: r.mode ?? null,
      persona: r.persona ?? null,
    })),
    unreadableLogs: prior.unreadable ?? [],
    productTypes: surface.types,
  };

  if (json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    out("");
    out(`  slug            ${slug}  (${source})`);
    out(`  branch          ${branch.ok ? branch.branch : `UNRESOLVED (${branch.error})`}`);
    out(`  artifacts dir   ${prior.dir}  [${prior.state}]`);
    if (prior.state === "unreadable") out(`                  ${prior.error}`);
    out("");
    if (prior.state === "absent") {
      out("  prior DX reviews: none. The directory does not exist, which is a verified nothing-there,");
      out("  not a lookup that failed. This is a first DX review; leave the Prior column empty.");
    } else if (prior.state === "read") {
      if (payload.priorReviews.length === 0) {
        out("  prior DX reviews: none, and the directory was genuinely read. This is a first DX review.");
      } else {
        out(`  prior DX reviews: ${payload.priorReviews.length}, across every branch (gstack reads only this branch's file)`);
        for (const p of payload.priorReviews) {
          out(`    ${p.timestamp ?? "(no timestamp)"}  branch=${p.branch}  overall=${p.overall ?? "?"}/10  tthw=${p.tthw ?? "?"}  mode=${p.mode ?? "?"}`);
        }
        out("");
        out("  Use these for the Scorecard's Prior and Trend columns. Do not write a trend you did not read.");
      }
      if (payload.unreadableLogs.length) out(`  NOTE: ${payload.unreadableLogs.length} review log(s) could not be read: ${payload.unreadableLogs.join(", ")}`);
    } else {
      out(`  prior DX reviews: NOT ESTABLISHED (${prior.state}). This is not the same as "none".`);
    }
    out("");
    if (surface.types.length) {
      out("  developer-facing surface, from the repository:");
      for (const t of surface.types) out(`    ${t.type.padEnd(20)} ${t.evidence.join("; ")}`);
    } else {
      out("  developer-facing surface: UNDETERMINED. No bin map, no exports, no routes, no SKILL.md, no deploy manifest, no docs tree.");
    }
    out("");
  }

  if (prior.state === "unreadable") return EXIT_UNUSABLE;
  return EXIT_OK;
}

function cmdSurface(args) {
  const repo = expand(args.dir ?? process.cwd());
  const s = detectSurface(repo);
  if (args.json) out(JSON.stringify(s, null, 2));
  else {
    out("");
    if (!s.types.length) {
      out("  PRODUCT TYPE: UNDETERMINED");
      out("");
      out(`  ${s.fileCount} files scanned under ${repo}. None of them is a bin map, an exports map,`);
      out("  a route tree, an OpenAPI spec, a SKILL.md, a deploy manifest or a docs tree.");
      out("");
      out("  Ask the user what the developer-facing surface is. Do NOT infer it from the plan's");
      out("  prose: a plan that mentions a terminal is not thereby a CLI.");
    } else {
      out("  PRODUCT TYPE, from the repository:");
      out("");
      for (const t of s.types) {
        out(`    ${t.type}`);
        for (const e of t.evidence) out(`      evidence: ${e}`);
      }
      out("");
      out(`  Primary: ${s.types[0].type}. State this classification and ask the user to confirm it.`);
    }
    for (const n of s.notes) out(`  NOTE: ${n.evidence.join("; ")}`);
    if (s.truncated) out("  NOTE: the walk hit its file cap, so this is a floor, not a census.");
    out("");
  }
  return s.types.length ? EXIT_OK : EXIT_UNDETERMINED;
}

function cmdTthw(args) {
  const repo = expand(args.dir ?? process.cwd());
  const m = measureGettingStarted(repo);
  if (!m.ok) {
    if (args.json) out(JSON.stringify({ ok: false, reason: m.reason }));
    else {
      out("");
      out(`  GETTING STARTED: UNMEASURABLE — ${m.reason}`);
      out("");
      out("  That is a finding in itself, and it is Pass 1's finding. Do not estimate a TTHW");
      out("  from a path that does not exist.");
      out("");
    }
    return EXIT_UNUSABLE;
  }
  if (args.json) {
    out(JSON.stringify(m, null, 2));
    return m.blocking ? EXIT_REJECTED : EXIT_OK;
  }
  out("");
  out(`  README            ${m.readme}`);
  out(`  entry point       ${m.hasGettingStartedHeading ? "a getting-started heading exists" : "NONE — no Install / Quick Start / Getting Started heading"}`);
  out(`  documented steps  ${m.steps} command${m.steps === 1 ? "" : "s"} before the developer is on their own`);
  if (m.prereqs.length) out(`  prerequisites     ${m.prereqs.join(", ")}`);
  out("");
  if (m.scriptChecks.length) {
    out("  package scripts the README tells a developer to run:");
    for (const c of m.scriptChecks) out(`    ${c.verdict === "ok" ? "ok     " : "MISSING"}  ${c.raw}`);
    out("");
  }
  if (m.fileChecks.length) {
    out("  files the README tells a developer to use:");
    for (const c of m.fileChecks) out(`    ${c.exists ? "ok     " : "MISSING"}  ${c.file}   (${c.command})`);
    out("");
  }
  if (!m.findings.length) {
    out("  No broken step found. Every documented command resolves against this repository.");
    out("  That is a floor, not a pass: it does not mean the path is FAST, only that it RUNS.");
    out("");
    return EXIT_OK;
  }
  out("  FINDINGS:");
  for (const f of m.findings) out(`    ${f.blocking ? "BLOCKING" : "note    "}  [${f.id}] ${f.detail}`);
  out("");
  if (m.blocking) {
    out(`  ${m.blocking} blocking finding${m.blocking === 1 ? "" : "s"}: the documented getting-started path cannot be completed by`);
    out("  copy-paste. Pass 1 cannot score above 3 until these are fixed, and no TTHW estimate");
    out("  is meaningful while a step does not run.");
    out("");
    return EXIT_REJECTED;
  }
  return EXIT_OK;
}

function cmdErrors(args) {
  const repo = expand(args.dir ?? process.cwd());
  const c = errorCensus(repo);
  if (args.json) {
    out(JSON.stringify(c, null, 2));
    return EXIT_OK;
  }
  out("");
  if (!c.messages.length) {
    out(`  ${c.scanned} source file(s) scanned, no error messages matched. Pass 3 has nothing to`);
    out("  trace from the code, so trace it from the plan and say that is what you did.");
    out("");
    return EXIT_OK;
  }
  const tally = [0, 0, 0, 0];
  for (const m of c.messages) tally[m.score]++;
  out(`  ${c.messages.length} error messages in ${c.scanned} source files.`);
  out("");
  out("  Scored on gstack's own formula (names the value that caused it / says what to do / links docs):");
  out(`    3 of 3   ${tally[3]}`);
  out(`    2 of 3   ${tally[2]}`);
  out(`    1 of 3   ${tally[1]}`);
  out(`    0 of 3   ${tally[0]}   <- a developer reading this learns nothing`);
  out("");
  const worst = c.messages.filter((m) => m.score === 0).slice(0, 5);
  if (worst.length) {
    out("  Trace these in Pass 3. They were chosen by the census, not by which ones read worst:");
    for (const m of worst) out(`    ${m.file}:${m.line}  "${m.message}"`);
    out("");
  }
  if (c.truncated) out("  NOTE: the walk hit its file cap, so these counts are a floor.\n");
  return EXIT_OK;
}

function cmdRef(args) {
  const n = String(args.pass ?? "").trim();
  const file = path.join(SKILL_DIR, "dx-hall-of-fame.md");
  const r = readFileOr(file);
  if (!r.ok) {
    err(`dx-hall-of-fame.md could not be read at ${file} (${r.code}).`);
    err("REFUSING to continue this pass from memory: the gold standards in that file are the");
    err("rubric, and a pass scored against remembered examples is scored against nothing.");
    return EXIT_UNUSABLE;
  }
  const want = /^\d+$/.test(n) ? new RegExp(`^##\\s+Pass ${n}\\b`, "m") : new RegExp(`^##\\s+.*${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im");
  const lines = r.text.split(/\r?\n/);
  const start = lines.findIndex((l) => want.test(l));
  if (start === -1) {
    err(`dx-hall-of-fame.md has no section matching "${n}".`);
    return EXIT_UNUSABLE;
  }
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  out(body.join("\n").trimEnd());
  return EXIT_OK;
}

function cmdGate(args) {
  const plan = readPlan(args.plan);
  if (!plan.ok) {
    if (args.json) out(JSON.stringify({ ok: false, unusable: true, error: plan.error }));
    else err(`GATE UNUSABLE: ${plan.error}\nA gate that cannot read the thing it checks does not pass it.`);
    return EXIT_UNUSABLE;
  }
  if (!args.json) {
    out("");
    out(`  DX plan gate: ${plan.path}`);
    out("");
  }
  return printChecks(gatePlan(plan.text), args.json);
}

function cmdRecord(args) {
  const plan = readPlan(args.plan);
  if (!plan.ok) {
    err(`RECORD REFUSED: ${plan.error}`);
    return EXIT_UNUSABLE;
  }
  const checks = gatePlan(plan.text);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    err(`RECORD REFUSED: the gate fails ${failed.length} check(s): ${failed.map((c) => c.id).join(", ")}.`);
    err("gstack writes its review-log line BEFORE the exit gate and unconditionally, so a DX");
    err("review that produced no report still leaves a record that /ship's readiness dashboard");
    err("reads as a completed DX review. Nothing is written here.");
    return EXIT_REJECTED;
  }
  const repo = expand(args.dir ?? process.cwd());
  const { slug } = repoSlug(repo);
  const branch = currentBranch(repo);
  const dir = artifactsDirFor(slug);
  const file = expand(args.out) ?? path.join(dir, "dx-reviews.jsonl");
  const record = {
    skill: "plan-devex-review",
    stack: "toolbay-stack",
    version: VERSION,
    timestamp: new Date().toISOString(),
    branch: branch.branch ?? "unresolved",
    status: args.status ?? "clean",
    overall_score: args.overall ? Number(args.overall) : null,
    tthw_current: args.tthw ?? null,
    tthw_target: args["tthw-target"] ?? null,
    mode: args.mode ?? null,
    persona: args.persona ?? null,
    product_type: args["product-type"] ?? null,
    unresolved: args.unresolved ? Number(args.unresolved) : 0,
    verified: true,
    checks_passed: checks.map((c) => c.id),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (e) {
    err(`RECORD FAILED: ${file} could not be written (${e.code || e.message})`);
    return EXIT_UNUSABLE;
  }
  if (args.json) out(JSON.stringify({ ok: true, file, record }));
  else {
    out("");
    out(`  Review recorded: ${file}`);
    out("  Written branch-independently, so the next DX review on the next branch can read it.");
    out("");
  }
  return EXIT_OK;
}

// ----------------------------------------------------------------- selftest

function runSelf(argv, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...argv], { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const GOOD_PLAN = `# Plan: publish the retry SDK

## What already exists
docs/quickstart.md and the existing \`tbx init\` command already cover install.

## NOT in scope
Python SDK. Deferred to TODOS.md with a one-line rationale.

## Developer Perspective

I am a YC founder with an afternoon to wire up webhooks before a demo. I open the
README and the first heading I see is Quick Start, which is what I wanted. I copy
the install line and it works on the first try, which is rare enough that I notice.
Then the second line tells me to run a command that needs an API key I do not have
yet, and nothing on the page says where to get one, so I go hunting through the
dashboard for four minutes and come back annoyed. When I finally paste the key the
first call returns a 401 with the body "invalid request", which tells me nothing
about whether my key is wrong, my account is not provisioned, or I am hitting the
wrong base URL. I try the key in curl to isolate it and that works, so the problem
is in the SDK, and now I am reading source code fifteen minutes into a thirty
minute budget. I want to like this thing but I am starting to look at alternatives.

TARGET DEVELOPER PERSONA
========================
Who:       YC founder wiring webhooks before a demo
Context:   afternoon before a customer call, one integration to finish
Tolerance: 30 minutes, then they look at the alternative
Expects:   an npm install, a key that is easy to find, and a working first call

## Competitive DX Benchmark

| Tool | TTHW | Notable DX Choice | Source |
|---|---|---|---|
| Stripe | 30s | keys pre-filled into docs examples | stripe.com/docs |
| Vercel | 2min | git push is the whole onboarding | vercel.com/docs |
| YOUR PRODUCT | 6min | key must be hunted for | current plan |

## Magical Moment

The moment is the first webhook arriving in their terminal. Delivery vehicle: a
copy-paste demo command, \`npx tbx listen\`, which prints live deliveries without
requiring an account first. Chosen over a hosted playground because the persona is
already in a terminal and a playground is a week of work.

## Developer Journey Map

1. Discover  | reads the README            | none                | ok
2. Install   | npm i tbx                   | resolved             | fixed
3. Hello World | npx tbx listen            | key was unfindable   | fixed
4. Real Usage | wires the handler          | none                 | ok
5. Debug     | reads the 401               | message was useless  | fixed
6. Upgrade   | follows the migration guide | none                 | ok

## First-Time Developer Confusion Report

T+0:00  Opens the README, finds Quick Start, copies the install line.
T+0:30  Install succeeds. Runs the demo command.
T+1:00  Demo command asks for an API key. Goes hunting in the dashboard.
T+4:00  Finds the key under Settings > Developers > API keys.
T+6:00  First call returns 401 "invalid request". Tries curl to isolate it.

## DX Scorecard

\`\`\`
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                            |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
| Getting Started      | 8/10   | 4/10   | +4     |
| API/CLI/SDK          | 9/10   | 7/10   | +2     |
| Error Messages       | 7/10   | 3/10   | +4     |
| Documentation        | 8/10   | 6/10   | +2     |
| Upgrade Path         | 9/10   | 9/10   | =      |
| Dev Environment      | 8/10   | 8/10   | =      |
| Community            | 6/10   | 6/10   | =      |
| DX Measurement       | 7/10   | 2/10   | +5     |
+--------------------------------------------------------------------+
| TTHW                 | 2 min  | 6 min  | -4     |
| Competitive Rank     | Competitive                                 |
| Magical Moment       | designed via copy-paste demo command        |
| Product Type         | Library/SDK                                 |
| Mode                 | DX POLISH                                   |
| Overall DX           | 8/10   | 6/10   | +2     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                              |
| Zero Friction      | covered                                       |
| Learn by Doing     | covered                                       |
| Fight Uncertainty  | covered                                       |
| Opinionated + Escape Hatches | covered                             |
| Code in Context    | covered                                       |
| Magical Moments    | covered                                       |
+====================================================================+
\`\`\`

## DX Implementation Checklist

\`\`\`
DX IMPLEMENTATION CHECKLIST
[x] Time to hello world < 2 min
[x] Installation is one command
[x] Magical moment delivered via npx tbx listen
[ ] Every error message has: problem + cause + fix + docs link
\`\`\`

## TOOLBAY DX REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| DX Review | /plan-devex-review | Developer-facing surface | 1 | CLEAR | 6 findings, 6 resolved |

**VERDICT:** DX CLEARED — TTHW 6min to 2min, error messages specified.

NO UNRESOLVED DECISIONS`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-devex-selftest-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  const write = (rel, body) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    return p;
  };
  const gate = (p) => runSelf(["gate", "--plan", p, "--json"]);
  const failedIds = (r) => {
    try {
      return JSON.parse(r.stdout || "{}").failed ?? [];
    } catch {
      return [];
    }
  };

  // =========================================================== the plan gate
  const goodPlan = write("plans/good.md", GOOD_PLAN);
  {
    const r = gate(goodPlan);
    check("gate passes a DX review that actually produced its outputs", 0, r.status, failedIds(r).join(","));
  }

  // The pasted template. This is the failure that matters: it is what a review
  // that did no work looks like, and gstack's own gate is the model's opinion.
  {
    const p = write("plans/blank-scorecard.md", GOOD_PLAN.replace(/\| Getting Started      \| 8\/10   \| 4\/10   \| \+4     \|/, "| Getting Started      | __/10  | __/10  | __ ↑↓  |"));
    const r = gate(p);
    check("gate REJECTS a scorecard still holding its __/10 blanks", 1, r.status);
    check("...naming scorecard.filled", true, failedIds(r).includes("scorecard.filled"));
  }
  {
    const p = write("plans/blank-tthw.md", GOOD_PLAN.replace("| TTHW                 | 2 min  | 6 min  | -4     |", "| TTHW                 | __ min | __ min | __ ↑↓  |"));
    const r = gate(p);
    check("gate REJECTS a TTHW row that was never measured", 1, r.status);
    check("...naming scorecard.filled", true, failedIds(r).includes("scorecard.filled"));
  }
  {
    const p = write("plans/template-rank.md", GOOD_PLAN.replace("| Competitive Rank     | Competitive                                 |", "| Competitive Rank     | [Champion/Competitive/Needs Work/Red Flag]   |"));
    const r = gate(p);
    check("gate REJECTS a competitive rank left as the template's option list", 1, r.status);
  }
  {
    const p = write("plans/checklist-refs.md", GOOD_PLAN.replace("[x] Time to hello world < 2 min", "[x] Time to hello world < [target from 0C]"));
    const r = gate(p);
    check("gate REJECTS a checklist still pointing at [target from 0C]", 1, r.status);
    check("...naming checklist.filled", true, failedIds(r).includes("checklist.filled"));
  }
  {
    const p = write("plans/persona-template.md", GOOD_PLAN.replace("Who:       YC founder wiring webhooks before a demo", "Who:       [description]"));
    const r = gate(p);
    check("gate REJECTS a persona card that is still [description]", 1, r.status);
    check("...naming output.persona-card", true, failedIds(r).includes("output.persona-card"));
  }
  {
    const short = "\n## Developer Perspective\n\nThe developer opens the README and it is fine.\n";
    const p = write("plans/thin-narrative.md", GOOD_PLAN.replace(/## Developer Perspective[\s\S]*?(?=TARGET DEVELOPER PERSONA)/, `${short}\n`));
    const r = gate(p);
    check("gate REJECTS a 9-word third-person 'empathy narrative'", 1, r.status);
    check("...naming output.empathy-narrative", true, failedIds(r).includes("output.empathy-narrative"));
  }
  {
    const p = write("plans/template-journey.md", GOOD_PLAN.replace("2. Install   | npm i tbx                   | resolved             | fixed", "2. Install   | [action]                    | [resolved/deferred]  | [fixed/ok/deferred]"));
    const r = gate(p);
    check("gate REJECTS a journey map of [action] rows", 1, r.status);
    check("...naming output.journey-map", true, failedIds(r).includes("output.journey-map"));
  }
  {
    const p = write("plans/no-confusion.md", GOOD_PLAN.replace(/## First-Time Developer Confusion Report[\s\S]*?(?=\n## DX Scorecard)/, ""));
    const r = gate(p);
    check("gate REJECTS a review with no first-time developer report", 1, r.status);
    check("...naming output.confusion-report", true, failedIds(r).includes("output.confusion-report"));
  }
  {
    const p = write("plans/one-competitor.md", GOOD_PLAN.replace("| Vercel | 2min | git push is the whole onboarding | vercel.com/docs |\n", ""));
    const r = gate(p);
    check("gate REJECTS a competitive benchmark with fewer than two competitors", 1, r.status);
    check("...naming output.benchmark", true, failedIds(r).includes("output.benchmark"));
  }
  {
    const p = write("plans/prose-only.md", GOOD_PLAN.replace(/## TOOLBAY DX REVIEW REPORT[\s\S]*$/, "The DX review went well and I fixed six things.\n"));
    const r = gate(p);
    check("gate REJECTS review prose in the body with no report section", 1, r.status);
    check("...naming report.present", true, failedIds(r).includes("report.present"));
  }
  {
    const p = write("plans/report-midfile.md", `${GOOD_PLAN}\n\n## Appendix\n\nnotes\n`);
    const r = gate(p);
    check("gate REJECTS a report that is present but not the last section", 1, r.status);
    check("...naming report.is-last-section", true, failedIds(r).includes("report.is-last-section"));
  }
  {
    const p = write("plans/bold-sentinel.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**NO UNRESOLVED DECISIONS**"));
    const r = gate(p);
    check("gate REJECTS a BOLDED unresolved-decisions sentinel", 1, r.status);
    check("...naming report.unresolved-status", true, failedIds(r).includes("report.unresolved-status"));
  }
  {
    const p = write("plans/unresolved-block.md", GOOD_PLAN.replace("NO UNRESOLVED DECISIONS", "**UNRESOLVED DECISIONS:**\n\n- whether the playground is worth a week"));
    check("gate ACCEPTS a proper UNRESOLVED DECISIONS block", 0, gate(p).status);
  }
  for (const [name, cut, id] of [
    ['gate REJECTS a review with no "NOT in scope" section', /## NOT in scope[\s\S]*?(?=\n## )/, "output.not-in-scope"],
    ['gate REJECTS a review with no "What already exists" section', /## What already exists[\s\S]*?(?=\n## )/, "output.already-exists"],
    ["gate REJECTS a review with no magical moment", /## Magical Moment[\s\S]*?(?=\n## )/, "output.magical-moment"],
  ]) {
    const p = write(`plans/${id}.md`, GOOD_PLAN.replace(cut, ""));
    const r = gate(p);
    check(name, 1, r.status);
    check(`...naming ${id}`, true, failedIds(r).includes(id));
  }
  // Fail closed: the gate cannot read the plan.
  check("gate REFUSES a plan file that does not exist (never passes)", 2, gate(path.join(tmp, "nope.md")).status);
  check("gate REFUSES an empty plan file", 2, gate(write("plans/empty.md", "   \n")).status);
  check("gate REFUSES a directory handed to it as a plan", 2, gate(tmp).status);

  // ============================================ the documented path that lies
  //
  // This is the class of defect a model tracing a README cannot find, because
  // the README reads perfectly. It is only visible by running the commands
  // against the repository they claim to work in.
  const brokenRepo = path.join(tmp, "repo-broken");
  write("repo-broken/package.json", JSON.stringify({ name: "tbx", version: "1.0.0", bin: { tbx: "./cli.js" }, scripts: { build: "tsc", test: "vitest" } }, null, 2));
  write("repo-broken/cli.js", "#!/usr/bin/env node\n");
  write(
    "repo-broken/README.md",
    [
      "# tbx",
      "",
      "## Quick Start",
      "",
      "```bash",
      "npm install tbx",
      "cp .env.example .env",
      "npm run dev",
      "tbx send --key YOUR_API_KEY",
      "```",
      "",
      "You will need to sign up for an account and add a credit card first.",
      "",
    ].join("\n")
  );
  {
    const r = runSelf(["tthw", "--dir", brokenRepo, "--json"]);
    let m = {};
    try {
      m = JSON.parse(r.stdout);
    } catch { /* stays {} */ }
    const ids = (m.findings ?? []).map((f) => f.id);
    check("tthw exits non-zero on a getting-started path that cannot run", 1, r.status, r.stdout.slice(0, 120));
    check("tthw catches `npm run dev` with no dev script in package.json", true, ids.includes("gs.broken-script"));
    check("tthw catches `cp .env.example .env` with no .env.example in the repo", true, ids.includes("gs.missing-file"));
    check("tthw catches a copy-paste line still holding YOUR_API_KEY", true, ids.includes("gs.placeholder"));
    check("tthw notes the credit card gate before first value", true, ids.includes("gs.access-gate"));
    check("...and the scripts that DO exist are not flagged", false, (m.scriptChecks ?? []).some((c) => c.script === "build" && c.verdict === "MISSING"));
  }
  {
    // The same README, now honest. The measurement must come back clean, or it
    // is just a machine that always says no.
    const okRepo = path.join(tmp, "repo-ok");
    write("repo-ok/package.json", JSON.stringify({ name: "tbx", scripts: { dev: "node cli.js" } }, null, 2));
    write("repo-ok/.env.example", "TBX_KEY=\n");
    write("repo-ok/cli.js", "#!/usr/bin/env node\n");
    write("repo-ok/README.md", "# tbx\n\n## Quick Start\n\n```bash\nnpm install tbx\ncp .env.example .env\nnpm run dev\n```\n");
    const r = runSelf(["tthw", "--dir", okRepo, "--json"]);
    check("tthw PASSES the same README once every step resolves", 0, r.status, r.stdout.slice(0, 200));
  }
  {
    const noReadme = path.join(tmp, "repo-no-readme");
    fs.mkdirSync(noReadme, { recursive: true });
    check("tthw REFUSES to estimate a TTHW with no README at all", 2, runSelf(["tthw", "--dir", noReadme, "--json"]).status);
  }

  // ====================================================== the product surface
  {
    const r = runSelf(["surface", "--dir", brokenRepo, "--json"]);
    let s = {};
    try {
      s = JSON.parse(r.stdout);
    } catch { /* stays {} */ }
    check("surface reads the product type off the repository", 0, r.status);
    check("...calling a package.json bin map a CLI Tool", true, (s.types ?? []).some((t) => t.type === "CLI Tool"));
  }
  {
    const empty = path.join(tmp, "repo-empty");
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, "notes.txt"), "just some notes\n", "utf8");
    const r = runSelf(["surface", "--dir", empty, "--json"]);
    check("surface returns UNDETERMINED rather than guessing a type", 3, r.status);
  }

  // ============================================= the trend that gstack cannot see
  //
  // The whole point: a prior review logged on ANOTHER branch. gstack cats
  // `$BRANCH-reviews.jsonl` and reports NO_PRIOR_DX_REVIEWS.
  const artifacts = path.join(tmp, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(
    path.join(artifacts, "feat-old-branch-reviews.jsonl"),
    `${JSON.stringify({ skill: "plan-devex-review", timestamp: "2026-03-15T10:00:00Z", overall_score: 4, tthw_current: "11 min", branch: "feat/old-branch" })}\n`,
    "utf8"
  );
  {
    const r = runSelf(["context", "--json"], { TOOLBAY_DEVEX_ARTIFACTS_DIR: artifacts });
    let c = {};
    try {
      c = JSON.parse(r.stdout);
    } catch { /* stays {} */ }
    check("context finds a prior DX review logged on a DIFFERENT branch", 1, (c.priorReviews ?? []).length, JSON.stringify(c.priorReviews ?? []));
    check("...and carries its score forward for the Prior column", 4, c.priorReviews?.[0]?.overall ?? "none");
  }
  {
    // gstack's own lookup, on the same directory, from a different branch.
    const gstackAnswer = (() => {
      const f = path.join(artifacts, "feat-new-branch-reviews.jsonl");
      let text = "";
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        text = ""; // `cat ... 2>/dev/null || echo NO_REVIEWS`
      }
      const matched = text.split("\n").filter((l) => l.includes("plan-devex-review"));
      return matched.length ? "found" : "NO_PRIOR_DX_REVIEWS"; // `grep ... || echo`
    })();
    check("gstack's branch-keyed lookup reports NO_PRIOR_DX_REVIEWS for the same history", "NO_PRIOR_DX_REVIEWS", gstackAnswer);
  }
  {
    const missing = path.join(tmp, "artifacts-missing");
    const r = runSelf(["context", "--json"], { TOOLBAY_DEVEX_ARTIFACTS_DIR: missing });
    let c = {};
    try {
      c = JSON.parse(r.stdout);
    } catch { /* stays {} */ }
    check("context reports a genuinely absent history as absent, not unreadable", "absent", c.artifactsState ?? "none");
    check("...and exits 0, because absence is a real answer", 0, r.status);
  }
  {
    // A directory that exists and cannot be listed is NOT an empty history.
    const blocked = path.join(tmp, "artifacts-blocked");
    fs.writeFileSync(blocked, "this is a file where a directory should be\n", "utf8");
    const r = runSelf(["context", "--json"], { TOOLBAY_DEVEX_ARTIFACTS_DIR: blocked });
    check("context exits 2 when the history could not be READ (gstack prints 'none')", 2, r.status);
  }

  // ================================================ the reference must be real
  {
    check("ref prints the Hall of Fame section for a pass", 0, runSelf(["ref", "--pass", "3"]).status);
    check("ref REFUSES a pass number the reference does not have", 2, runSelf(["ref", "--pass", "99"]).status);
  }

  // ====================================================== the record is gated
  {
    const recFile = path.join(tmp, "refused.jsonl");
    const bad = write("plans/bad-for-record.md", GOOD_PLAN.replace("| TTHW                 | 2 min  | 6 min  | -4     |", "| TTHW                 | __ min | __ min | __ ↑↓  |"));
    const r = runSelf(["record", "--plan", bad, "--out", recFile, "--json"]);
    check("record REFUSES to log a DX review whose gate fails", 1, r.status);
    check("...and writes no file at all", false, fs.existsSync(recFile));
  }
  {
    const recFile = path.join(tmp, "ok.jsonl");
    const r = runSelf(["record", "--plan", goodPlan, "--out", recFile, "--overall", "8", "--tthw", "2 min", "--json"]);
    check("record logs a DX review whose gate passes", 0, r.status, r.stderr.trim());
    let first = {};
    try {
      first = JSON.parse(fs.readFileSync(recFile, "utf8").trim().split("\n")[0]);
    } catch { /* stays {} */ }
    check("...carrying verified:true", true, first.verified === true);
    check("...and the ids of the checks that ran", true, Array.isArray(first.checks_passed) && first.checks_passed.length >= 12);
  }

  // A selftest whose total depends on where it was run from is a selftest that
  // can quietly stop asserting things.
  const EXPECTED = 59;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out("");
  out(`  tb-devex-review selftest  (node ${process.version}, ${process.platform})`);
  out("");
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out("");
  out(`  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("");
    out("  This skill is NOT trustworthy in this state. Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    process.exitCode = 1;
    return;
  }
  out("");
  out("  Every deliberately broken input above was caught: a scorecard of blanks, a narrative");
  out("  that is not a narrative, a journey map of template rows, a README whose commands cannot");
  out("  run, a product type with no evidence, and a review history that exists on another");
  out("  branch. None of them was reported as fine.");
  out("");
}

// --------------------------------------------------------------------- entry

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function usage() {
  out(`tb-devex-review ${VERSION} — the measurable parts of /plan-devex-review

  context   [--dir .] [--json]   slug, branch, EVERY branch's prior DX reviews, product surface
  surface   [--dir .] [--json]   what developer-facing product this repo actually is, with evidence
  tthw      [--dir .] [--json]   run the README's getting-started commands against this repo
  errors    [--dir .] [--json]   census every error message and score it on the 3-tier formula
  ref       --pass N             print one DX Hall of Fame section; refuse if it cannot be read
  gate      --plan f [--json]    refuse a DX review that did not produce its outputs
  record    --plan f [...]       log the review, but only if the gate passes
  selftest                       run this executable against deliberately broken inputs

Exit codes: 0 passed, 1 ran and failed, 2 input unreadable, 3 undetermined (refuse).`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

switch (cmd) {
  case "context":
    process.exit(cmdContext(args));
    break;
  case "surface":
    process.exit(cmdSurface(args));
    break;
  case "tthw":
    process.exit(cmdTthw(args));
    break;
  case "errors":
    process.exit(cmdErrors(args));
    break;
  case "ref":
    process.exit(cmdRef(args));
    break;
  case "gate":
    process.exit(cmdGate(args));
    break;
  case "record":
    process.exit(cmdRecord(args));
    break;
  case "selftest":
    selftest();
    break;
  case "--version":
  case "version":
    out(VERSION);
    break;
  default:
    usage();
    process.exit(cmd ? EXIT_UNUSABLE : EXIT_OK);
}
