#!/usr/bin/env node
/**
 * toolbay-stack — installer for the Toolbay Stack skills.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 * Built on gstack by Garry Tan (https://github.com/garrytan/gstack), MIT,
 * Copyright (c) 2026 Garry Tan. See LICENSE and NOTICE.
 *
 * Derived in shape from the `toolbay` npm CLI (also Toolbay, MIT).
 *
 * WHY NODE AND NOT BASH: gstack's installer is 1,531 lines of POSIX shell and
 * it is the single biggest reason gstack is second-class on Windows — the whole
 * control plane needs Git Bash, symlinks degrade to stale copies, and
 * `.exe`-suffixed build artifacts are missed by unsuffixed path tests. Node
 * runs identically on all three platforms and is already required by Claude
 * Code, so there is no new dependency and no shell to be wrong about.
 *
 * NO NETWORK, NO TELEMETRY. Skills are bundled in the package. This binary
 * opens zero sockets. (The `toolbay` skill talks to the marketplace at runtime,
 * but only when a user actually invokes it.)
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_SRC = path.join(ROOT, "skills");
const HOME = "https://toolbay.ai";

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * How to invoke this CLI again, in a way that actually works from where it is.
 *
 * Every one of these strings used to be hard-coded `npx toolbay-stack`, and this
 * package is not published: `npx toolbay-stack install --global` is an npm 404.
 * The README said it, the installer's own output said it, and the first person
 * to try the documented install could not get past line one. So the invocation
 * is derived from where this file is actually running: from a clone, it is the
 * path to this script; from an npm install, npx is right again with no change
 * here. A command printed by a tool should be a command you can paste.
 */
const SELF_PATH = path.join(ROOT, "bin", "toolbay-stack.mjs");
const FROM_NPM = ROOT.split(path.sep).includes("node_modules");
const CLI = (() => {
  if (FROM_NPM) return "npx toolbay-stack";
  const rel = path.relative(process.cwd(), SELF_PATH).split(path.sep).join("/");
  // A relative path is friendlier, but only while it stays inside the clone.
  return rel && !rel.startsWith("..") ? `node ${rel}` : `node "${SELF_PATH.split(path.sep).join("/")}"`;
})();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

/** Read the skills actually present on disk rather than a hand-kept manifest. */
function discover() {
  if (!existsSync(SKILLS_SRC)) return [];
  return readdirSync(SKILLS_SRC)
    .filter((n) => existsSync(path.join(SKILLS_SRC, n, "SKILL.md")))
    .map((name) => {
      const md = readFileSync(path.join(SKILLS_SRC, name, "SKILL.md"), "utf8");
      // Frontmatter is small and well-formed here; a YAML dep would be the only
      // dependency in the package and would buy nothing.
      const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let description = "";
      if (m) {
        const d = m[1].match(/^description:\s*(.+)$/m);
        if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
      }
      return { name, description, dir: path.join(SKILLS_SRC, name) };
    });
}

/** Copy a tree. Recursive, no symlinks — a symlink is what breaks on Windows. */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/**
 * Rewrite hook commands in an installed SKILL.md to the real absolute path.
 *
 * The bundled file says `node $HOME/.claude/skills/<name>/scripts/tb-guard.mjs
 * <mode>`, which is readable and which is what someone reviewing the package
 * should see. But it only works if the hook runner expands $HOME, and it is
 * simply wrong for a project-scoped install, where the skill lives under the
 * project rather than the home directory.
 *
 * A safety hook whose path does not resolve does not warn anybody. It just
 * never fires, exactly like the upstream hooks this fork exists to fix, so
 * this is not a tidiness change. Pinning the absolute path at install time
 * removes the environment variable from the equation entirely. Forward slashes
 * work on all three platforms and avoid a backslash meeting a YAML parser; the
 * path is double-quoted inside a single-quoted YAML scalar so a directory with
 * a space in it still works.
 *
 * The pattern it matches on is below, and generalising it was the fix for a
 * skill this installer shipped knowingly broken.
 */

/**
 * Any `node <something>.mjs <mode>` hook command, whatever the engine is called.
 *
 * This pattern used to be spelled `tb-guard\.mjs`. Every skill it did not match
 * installed INERT: `plan-tune` registers its hook on tb-plan-tune.mjs, so its
 * `$HOME` was never expanded, the hook runner could not resolve the command, and
 * the skill silently did nothing — while the installer printed "+ plan-tune" and
 * the selftest printed "22/22 passed" under a banner about inert skills. The
 * engine name is not the thing worth matching on; being a hook is.
 */
const HOOK_COMMAND = /^(\s*command:\s*)(["'])(.*?([A-Za-z0-9_.-]+\.mjs)"?\s+(\w+))\2\s*$/gm;

function pinHookPaths(installedDir) {
  const md = path.join(installedDir, "SKILL.md");
  if (!existsSync(md)) return { ok: false, hooks: 0, problems: [`${md} is missing, so this is not an installed skill`] };

  const src = readFileSync(md, "utf8");
  const hooks = [...src.matchAll(new RegExp(HOOK_COMMAND.source, "gm"))];
  // No hook in this skill's frontmatter is the ordinary case for most of them.
  if (!hooks.length) return { ok: true, hooks: 0, problems: [] };

  // A skill that registers a PreToolUse hook and has no engine to run is the
  // exact failure this fork exists to remove: the install prints "+ careful",
  // the hook command points at a file that is not there, and the hook just
  // never fires. Returning quietly here made this installer produce it.
  const problems = [];
  const engines = new Map();
  for (const h of hooks) {
    const base = h[4];
    const engine = path.join(installedDir, "scripts", base);
    if (!existsSync(engine)) {
      problems.push(`SKILL.md registers a PreToolUse hook on ${base} but ${engine} does not exist, so the hook would never fire`);
      continue;
    }
    engines.set(base, path.resolve(engine).replace(/\\/g, "/"));
  }
  if (problems.length) return { ok: false, hooks: hooks.length, problems };

  const next = src.replace(new RegExp(HOOK_COMMAND.source, "gm"), (m, lead, _q, _whole, base, mode) => {
    const abs = engines.get(base);
    return abs ? `${lead}'node "${abs}" ${mode}'` : m;
  });
  if (next !== src) writeFileSync(md, next, "utf8");

  // Verify the rewrite instead of assuming it: any hook command still carrying
  // an unexpanded variable is one the hook runner may not resolve.
  const after = readFileSync(md, "utf8");
  const stillUnpinned = [...after.matchAll(new RegExp(HOOK_COMMAND.source, "gm"))]
    .map((m) => m[3])
    .filter((cmd) => /\$HOME|\$\{HOME\}|%USERPROFILE%|\$CLAUDE_PROJECT_DIR/.test(cmd));
  if (stillUnpinned.length) {
    return { ok: false, hooks: hooks.length, problems: [`hook command was not pinned to an absolute path: ${stillUnpinned[0]}`] };
  }
  return { ok: true, hooks: hooks.length, problems: [] };
}

/**
 * Is an installed skill directory actually usable, or just present.
 *
 * `status` used to answer from the directory name alone, which reports a skill
 * as installed when its SKILL.md is gone or its hook points at a missing
 * engine. Same question the installer asks, asked again after the fact.
 */
function inspectInstalled(dir) {
  const md = path.join(dir, "SKILL.md");
  if (!existsSync(md)) return { ok: false, problem: "no SKILL.md" };
  const src = readFileSync(md, "utf8");
  const hooks = [...src.matchAll(/^\s*command:\s*(["'])(.*?)\1\s*$/gm)].map((m) => m[2]);
  for (const cmd of hooks) {
    // The path inside the hook command, as the hook runner would see it.
    const quoted = cmd.match(/"([^"]+\.mjs)"/) || cmd.match(/(\S+\.mjs)/);
    if (!quoted) continue;
    const target = quoted[1]
      .replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/g, os.homedir())
      .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, process.cwd());
    if (!existsSync(target)) return { ok: false, problem: `hook points at ${target}, which does not exist` };
  }
  return { ok: true, problem: null, hooks: hooks.length };
}

/**
 * Every (tool matcher, guard mode) pair a skill registers a PreToolUse hook for.
 *
 * Read out of the frontmatter rather than hard-coded, so this keeps telling the
 * truth when a skill gains or loses a hook. Both hook command shapes are
 * recognised: the shipped `"node $HOME/.../tb-guard.mjs careful"` and the
 * absolute form `'node "C:/.../tb-guard.mjs" careful'` that pinHookPaths writes.
 */
function hookRegistrations(dir) {
  const md = path.join(dir, "SKILL.md");
  if (!existsSync(md)) return [];
  const fm = readFileSync(md, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const block = fm[1].match(/^hooks:[ \t]*\r?\n([\s\S]*)$/m);
  if (!block) return [];
  const regs = [];
  let matcher = null;
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^\s*-\s*matcher:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m) {
      matcher = m[1];
      continue;
    }
    // Any engine, not just tb-guard.mjs: a duplicated hook is a duplicated
    // prompt whichever script is behind it. The engine's basename is part of the
    // key, so two skills hooking the same tool with DIFFERENT engines are not
    // reported as a collision.
    const c = /command:\s*.*?([A-Za-z0-9_.-]+\.mjs)["']?\s+(\w+)/.exec(line);
    if (c && matcher) regs.push({ matcher, engine: c[1], mode: c[2] });
  }
  return regs;
}

/**
 * Guard hooks that two installed skills both registered.
 *
 * WHY THIS IS A REAL FAILURE AND NOT TIDINESS. `/guard` is `/careful` plus
 * `/freeze` in one skill, running a byte-identical engine (tools/sync-guard.mjs
 * asserts the copies match). Install `guard` next to `careful` and Claude Code
 * runs BOTH Bash hooks on every command, so a `rm -rf` prompts twice with the
 * same warning. A safety prompt that appears twice for one command is a prompt
 * people learn to dismiss, which is the exact behaviour `/careful` exists to
 * prevent — so the redundancy does not merely waste a keystroke, it converts the
 * feature into its own failure mode. `/investigate` carries the freeze engine
 * too, so it collides with `/freeze` and `/guard` on Edit and Write the same way.
 *
 * Computed from what is on disk in `dest`, not from what this run installed, so
 * adding `guard` to a machine that already had `careful` is caught.
 */
function conflictingHooks(dest) {
  if (!existsSync(dest)) return [];
  const byPair = new Map();
  for (const name of readdirSync(dest).sort()) {
    let regs;
    try {
      regs = hookRegistrations(path.join(dest, name));
    } catch {
      continue;
    }
    for (const r of regs) {
      const key = `${r.matcher} -> ${r.engine} ${r.mode}`;
      if (!byPair.has(key)) byPair.set(key, []);
      if (!byPair.get(key).includes(name)) byPair.get(key).push(name);
    }
  }
  return [...byPair.entries()]
    .filter(([, skills]) => skills.length > 1)
    .map(([pair, skills]) => ({ pair, skills }));
}

/**
 * Files inside a skill that belong to the user, not to the release.
 * Keyed by skill name, paths relative to the installed skill directory.
 */
const USER_EDITED = {
  modes: ["modes.json"],
  memory: ["memory.json"],
};

function skillsRoot(isGlobal) {
  return isGlobal
    ? path.join(os.homedir(), ".claude", "skills")
    : path.join(process.cwd(), ".claude", "skills");
}

function cmdList() {
  const skills = discover();
  out();
  out(bold(`  Toolbay Stack v${pkg.version} — ${skills.length} skill${skills.length === 1 ? "" : "s"}`));
  out();
  const width = Math.max(...skills.map((s) => s.name.length), 8);
  for (const s of skills) {
    out(`  ${cyan(s.name.padEnd(width))}  ${dim(s.description.split(".")[0].slice(0, 90))}`);
  }
  out();
  out(dim(`  Install:  ${CLI} install --global`));
  out();
}

/**
 * `install --cursor` — hand the whole job to the Cursor engine.
 *
 * It is a separate engine rather than a branch in cmdInstall because installing
 * into Cursor is not the same operation with a different destination. Cursor
 * reads a different skill layout, wires guards through .cursor/hooks.json
 * instead of SKILL.md frontmatter, and — the part that matters — cannot enforce
 * everything Claude Code can. That engine owns the capability table and the
 * refusals that come out of it. Delegating keeps the two installers from
 * quietly growing each other's assumptions.
 */
function cmdInstallCursor(names, flags) {
  const engine = path.join(ROOT, "src", "cursor", "tb-cursor.mjs");
  if (!existsSync(engine)) {
    out(`\n  ${yellow("x")} The Cursor engine is missing at ${engine}\n`);
    process.exitCode = 1;
    return;
  }
  const args = [engine, "install", ...names];
  if (flags.global) args.push("--global");
  if (flags.force) args.push("--force");
  if (flags.allowMissingCursor) args.push("--allow-missing-cursor");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  process.exitCode = r.status ?? 1;
}

/**
 * `uninstall --cursor` — and the reason this function exists as its own entry.
 *
 * `--cursor` was routed for `install` and NOT for `uninstall`, so
 * `toolbay-stack uninstall --cursor` fell through to the Claude Code
 * uninstaller. It then reported, cheerfully, "Nothing to remove in
 * <project>/.claude/skills" — a true sentence about a directory the user had
 * never installed into — and left every .cursor skill, the adapter and both
 * hooks.json entries exactly where they were. The Cursor installer's own output
 * recommends this command by name when it folds a duplicate guard, so the
 * documented way out of a Cursor install did nothing and said it was fine.
 *
 * Silent no-ops are worse here than anywhere else: somebody uninstalling a
 * guard is usually trying to stop it blocking them, and a guard that survives
 * its own uninstall is the same class of surprise as one that never ran.
 */
function cmdUninstallCursor(flags) {
  const engine = path.join(ROOT, "src", "cursor", "tb-cursor.mjs");
  if (!existsSync(engine)) {
    out(`\n  ${yellow("x")} The Cursor engine is missing at ${engine}\n`);
    process.exitCode = 1;
    return;
  }
  const args = [engine, "uninstall"];
  if (flags.global) args.push("--global");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  process.exitCode = r.status ?? 1;
}

function cmdInstall(names, { global: isGlobal, force }) {
  const all = discover();
  const chosen = names.length ? all.filter((s) => names.includes(s.name)) : all;

  if (names.length && chosen.length !== names.length) {
    const missing = names.filter((n) => !all.some((s) => s.name === n));
    out();
    out(`  ${yellow("?")} No skill named ${bold(missing.join(", "))}.`);
    out(dim(`    Available: ${all.map((s) => s.name).join(", ")}`));
    out();
    process.exitCode = 1;
    return;
  }

  const dest = skillsRoot(isGlobal);
  const installed = [];
  const skipped = [];
  const preserved = [];
  const broken = [];

  for (const s of chosen) {
    const target = path.join(dest, s.name);
    if (existsSync(path.join(target, "SKILL.md")) && !force) {
      skipped.push(s);
      continue;
    }

    // Carry across the files a user is told to edit, BEFORE the directory is
    // removed. modes.json is the whole point of the modes skill: the README
    // says to edit it, so `install --force` deleting it on an upgrade would
    // silently throw away the user's stances. Anything they changed comes back,
    // and the incoming version lands beside it as `.shipped` to diff against.
    const carry = new Map();
    for (const rel of USER_EDITED[s.name] || []) {
      const f = path.join(target, rel);
      if (existsSync(f)) carry.set(rel, readFileSync(f));
    }

    // Remove first so a shrinking skill does not leave orphaned files behind.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    copyTree(s.dir, target);

    for (const [rel, mine] of carry) {
      const f = path.join(target, rel);
      const shipped = existsSync(f) ? readFileSync(f) : null;
      if (shipped && shipped.equals(mine)) continue; // never edited, nothing to keep
      if (shipped) writeFileSync(`${f}.shipped`, shipped);
      writeFileSync(f, mine);
      preserved.push({ skill: s.name, rel, hasShipped: Boolean(shipped) });
    }

    const pin = pinHookPaths(target);
    if (!pin.ok) {
      // Leaving a half-installed safety skill on disk is worse than not
      // installing it: `status` would list it, the user would believe it, and
      // it would check nothing. Remove it and say why.
      rmSync(target, { recursive: true, force: true });
      broken.push({ name: s.name, problems: pin.problems });
      continue;
    }

    // POST-INSTALL INSPECTION, run by the installer, before it prints "+".
    //
    // This is the same inspectInstalled() that `status` uses. It sat forty lines
    // below cmdInstall in this file and cmdInstall never called it, so the two
    // commands could and did disagree about the same directory one second apart:
    // `install plan-tune` printed "+ plan-tune", and `status` in that very
    // directory printed "plan-tune BROKEN" and exited 1. An installer that will
    // not ask the question its own status command asks is an installer that
    // ships skills it already knows are inert.
    const inspected = inspectInstalled(target);
    if (!inspected.ok) {
      rmSync(target, { recursive: true, force: true });
      broken.push({
        name: s.name,
        problems: [`${inspected.problem}, so this skill would have installed inert (found by the same check \`status\` runs)`],
      });
      continue;
    }
    installed.push(s);
  }

  out();
  for (const b of broken) {
    out(`  ${yellow("x")} ${bold(b.name)} ${yellow("NOT installed")}`);
    for (const p of b.problems) out(dim(`      ${p}`));
  }
  for (const s of installed) out(`  ${green("+")} ${bold(s.name)}`);
  for (const s of skipped) out(`  ${dim("=")} ${s.name} ${dim("already installed (--force to overwrite)")}`);

  if (installed.length) {
    out();
    out(`  Installed to ${dim(isGlobal ? "~/.claude/skills" : ".claude/skills")}`);
    out(`  Use ${cyan(`/${installed[0].name}`)} in Claude Code.`);
  }
  out();

  for (const p of preserved) {
    out(`  ${green("kept")} your ${bold(`${p.skill}/${p.rel}`)} ${dim("(it was edited, so the upgrade did not overwrite it)")}`);
    if (p.hasShipped) out(dim(`       this release's version is beside it as ${p.rel}.shipped`));
  }
  if (preserved.length) out();

  // Safety skills are only real if they are wired in, and the whole reason this
  // fork exists is that the upstream ones looked wired in and were not. So the
  // installer says how to check, right where someone will see it.
  if (installed.some((s) => ["careful", "freeze", "guard"].includes(s.name))) {
    const dir = isGlobal ? "~/.claude/skills" : ".claude/skills";
    const first = installed.find((s) => ["careful", "freeze", "guard"].includes(s.name)).name;
    out(dim("  Prove the safety hooks are actually active:"));
    out(`    ${cyan(`node ${dir}/${first}/scripts/tb-guard.mjs selftest`)}`);
    out(`    ${cyan(`node ${dir}/${first}/scripts/tb-guard.mjs doctor`)}`);
    out();
  }

  // A duplicated safety hook is worse than a missing one, because it trains the
  // user to click through the warning. Say so, name the pairs, and give the one
  // command that fixes it. This warns rather than refusing: `install --all` is
  // the documented path and it is the path that produces the collision, so
  // failing it would make the ordinary install exit non-zero.
  const clashes = conflictingHooks(dest);
  if (clashes.length) {
    const scope = isGlobal ? "--global" : "";
    out(`  ${yellow("!")} ${bold("Two skills are hooked to the same tool, so it will prompt twice:")}`);
    for (const cl of clashes) out(`      ${cl.pair.padEnd(34)} ${yellow(cl.skills.join(", "))}`);
    out();
    out(dim("    /guard is /careful + /freeze in one skill, running the same engine, and"));
    out(dim("    /investigate carries the freeze half too. Two hooks on one tool means one"));
    out(dim("    destructive command asks twice, which is how people learn to click through"));
    out(dim("    the warning — the exact failure /careful exists to prevent. Keep one:"));
    const namesIn = (...n) => n.filter((x) => clashes.some((cl) => cl.skills.includes(x)));
    const dropForGuard = namesIn("careful", "freeze");
    if (dropForGuard.length) {
      out(`      ${cyan(`${CLI} uninstall ${dropForGuard.join(" ")} ${scope}`.trim())}   ${dim("keep /guard")}`);
      out(`      ${cyan(`${CLI} uninstall guard ${scope}`.trim())}   ${dim(`keep /${dropForGuard.join(" + /")}`)}`);
    }
    out();
  }

  if (installed.some((s) => s.name === "memory")) memoryPrompt(isGlobal);
  if (installed.some((s) => s.name === "toolbay")) connectPrompt(isGlobal);

  // A skill that could not be installed correctly is a failed install, and the
  // exit code has to say so or a CI step would go green over it.
  if (broken.length) process.exitCode = 1;
}

/**
 * First run of the memory layer: the offer, and the part that is worth more
 * than the offer.
 *
 * This does NOT turn memory on. It cannot: consent is a separate, explicit
 * command, and an installer that opted someone into capture would be the exact
 * thing that makes people distrust a tool like this. What it does instead is
 * spend six lines teaching the user how to prompt, because the highest-value
 * thing this stack can do at install time is get them saying the thing worth
 * remembering. The full guide is one command away and lives in memory.json,
 * where they can rewrite it.
 */
function memoryPrompt(isGlobal) {
  const mem = isGlobal
    ? "~/.claude/skills/memory/scripts/tb-memory.mjs"
    : ".claude/skills/memory/scripts/tb-memory.mjs";
  out(bold("  Get better work out of the agent (this is the part people skip)"));
  out();
  out(`    ${dim("1.")} Say what "done" means before it starts, not after.`);
  out(`    ${dim("2.")} Say what you do NOT want. "no new dependencies, don't refactor on the way past."`);
  out(`    ${dim("3.")} When it gets it wrong, correct it out loud AND say why. The why is the`);
  out(`       part that carries to the next task.`);
  out(`    ${dim("4.")} Put your constraints up front. One line beats three wrong turns.`);
  out(`    ${dim("5.")} Say what you LIKE too, not only what is wrong.`);
  out();
  out("  Telling the agent what you like and what you don't is what makes this stack");
  out("  better for you. Corrections are the fuel, not friction.");
  out();
  out(`  The memory skill keeps those corrections, ${bold("if you turn it on")}:`);
  out(`    ${cyan(`node ${mem} enable`)}   ${dim("prints exactly what it would capture, and stops")}`);
  out(`    ${cyan(`node ${mem} onboard`)}  ${dim("the full 60-second guide")}`);
  out();
  out(dim("  It is OFF right now and records nothing until you opt in. Credentials are"));
  out(dim("  stripped before anything is written, code is never stored, and everything"));
  out(dim("  it holds is printable with `status` and deletable with `forget <id>`."));
  out();
}

/**
 * The connect-and-sell offer, shown once at install.
 *
 * It is an OFFER, printed, not a blocking prompt and not a hard gate: the stack
 * has to be fully usable by someone who never connects an account. Gating a
 * developer tool behind a signup is how it gets uninstalled before it is
 * evaluated.
 */
function connectPrompt(isGlobal) {
  const tb = isGlobal
    ? "~/.claude/skills/toolbay/scripts/tb.mjs"
    : ".claude/skills/toolbay/scripts/tb.mjs";
  out(bold("  Connect Toolbay, so you can sell what you build"));
  out();
  out("  Optional, and skippable. With an account connected, this stack can:");
  out(`    ${dim("-")} find a tool on the marketplace when you hit a real gap mid-task`);
  out(`    ${dim("-")} tell you honestly what something you built could list for`);
  out(`    ${dim("-")} publish it for you, without opening a single form`);
  out();
  out(`  1. Get a token   ${dim(`${HOME}/sell/api`)}`);
  out(`  2. Verify it     ${cyan(`node ${tb} login <token>`)}`);
  out(`  3. Connect it    ${cyan(`node ${tb} connect`)}`);
  out();
  out(dim("  Step 3 prints the one-time install for the real connector:"));
  out(dim(`    claude mcp add --transport http --scope user toolbay ${HOME}/api/mcp \\`));
  out(dim('      --header "Authorization: Bearer <token>"'));
  out(dim("  It fills your token in for you, so the token never has to be typed into"));
  out(dim("  a chat message. Never paste a token into the chat: Claude cannot use it"));
  out(dim("  there, and it stays in your history."));
  out();
  out(dim("  Skip all of it and everything else still works. Nothing here is gated on"));
  out(dim("  an account. Connect later by asking Claude to \"connect Toolbay\"."));
  out();
}

function cmdUninstall(names, { global: isGlobal }) {
  const dest = skillsRoot(isGlobal);
  const all = discover();
  const chosen = names.length ? names : all.map((s) => s.name);
  const removed = [];
  for (const name of chosen) {
    const target = path.join(dest, name);
    // Only remove a directory this package actually ships, so a stray argument
    // cannot delete an unrelated skill.
    if (all.some((s) => s.name === name) && existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    }
  }
  out();
  if (removed.length) out(`  ${green("-")} Removed ${removed.join(", ")} from ${dim(dest)}`);
  else out(`  ${dim("Nothing to remove in")} ${dim(dest)}`);
  out();
}

function cmdStatus() {
  const all = discover();
  let anyBroken = false;
  out();
  for (const scope of [
    { label: "this project", root: skillsRoot(false) },
    { label: "global", root: skillsRoot(true) },
  ]) {
    const present = existsSync(scope.root)
      ? readdirSync(scope.root).filter((n) => all.some((s) => s.name === n))
      : [];
    // "installed" used to mean "a directory with this name exists". It now
    // means the SKILL.md is there and every hook command in it points at a file
    // that exists, because a skill that is present and inert is the failure
    // this project is about.
    const checked = present.map((n) => ({ name: n, ...inspectInstalled(path.join(scope.root, n)) }));
    const ok = checked.filter((s) => s.ok).map((s) => s.name);
    const bad = checked.filter((s) => !s.ok);
    out(`  ${bold(scope.label.padEnd(13))} ${ok.length ? ok.join(", ") : dim("none")}`);
    for (const b of bad) {
      anyBroken = true;
      out(`  ${" ".repeat(13)} ${yellow(`${b.name}  BROKEN`)} ${dim(b.problem)}`);
    }
  }
  out();
  out(dim(`  Marketplace connection:  node ~/.claude/skills/toolbay/scripts/tb.mjs status`));
  out();
  if (anyBroken) process.exitCode = 1;
}

// ------------------------------------------------------------------ selftest

/**
 * Installs into throwaway directories and asserts the failures that matter:
 * a hook-registering skill whose engine is missing must not be reported as
 * installed, and `status` must not call a broken directory installed either.
 */
function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbay-stack-install-"));
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  const run = (args, cwd) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  // A THROW IS A NAMED FAILURE, NOT A STACK TRACE. A selftest that dies mid-run
  // prints no "N/M passed" line, and the suite runner then says it "cannot be
  // shown to have asserted anything" — which buries the one assertion that
  // really failed under a stack trace from a line merely downstream of it. A
  // test that crashes is indistinguishable from a test that never ran.
  try {

  // ---- pinHookPaths, the function the audit found returning quietly
  {
    const dir = path.join(tmp, "fake-careful");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const md =
      "---\nname: careful\nhooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n      hooks:\n        - type: command\n" +
      "          command: \"node $HOME/.claude/skills/careful/scripts/tb-guard.mjs careful\"\n---\nbody\n";
    writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");
    const missing = pinHookPaths(dir);
    check("a hook whose engine is missing is NOT a successful install", false, missing.ok, JSON.stringify(missing.problems));
    check("...and says the guard would never fire", true, /never fire/.test(missing.problems.join(" ")), missing.problems.join(" "));

    writeFileSync(path.join(dir, "scripts", "tb-guard.mjs"), "// engine\n", "utf8");
    const okPin = pinHookPaths(dir);
    check("with the engine present the hook pins", true, okPin.ok, JSON.stringify(okPin.problems));
    const after = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    check("...and no $HOME survives in the hook command", false, /\$HOME/.test(after), after.split("\n").find((l) => l.includes("command:")) ?? "");
  }
  // ---- the pin must not care what the engine is CALLED. It used to match only
  // tb-guard.mjs, so plan-tune's tb-plan-tune.mjs hook installed unpinned and
  // therefore inert, and the installer reported it as installed anyway.
  {
    const dir = path.join(tmp, "fake-plan-tune");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const md =
      "---\nname: plan-tune\nhooks:\n  PreToolUse:\n    - matcher: \"(AskUserQuestion|mcp__.*__AskUserQuestion)\"\n      hooks:\n        - type: command\n" +
      "          command: \"node $HOME/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs hook\"\n---\nbody\n";
    writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");

    const missing = pinHookPaths(dir);
    check("a non-guard hook with no engine is NOT a successful install either", false, missing.ok, JSON.stringify(missing.problems));
    check("...and the problem names that engine, not tb-guard", true, /tb-plan-tune\.mjs/.test(missing.problems.join(" ")), missing.problems.join(" "));

    writeFileSync(path.join(dir, "scripts", "tb-plan-tune.mjs"), "// engine\n", "utf8");
    const pinned = pinHookPaths(dir);
    check("a hook on any .mjs engine pins", true, pinned.ok, JSON.stringify(pinned.problems));
    const after = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    check("...with no $HOME left in the command", false, /\$HOME/.test(after), after.split("\n").find((l) => l.includes("command:")) ?? "");
    check("...pointing at the engine that is really there", true, after.includes(path.resolve(dir, "scripts", "tb-plan-tune.mjs").replace(/\\/g, "/")), after.split("\n").find((l) => l.includes("command:")) ?? "");
    check("...and the mode argument survives the rewrite", true, /tb-plan-tune\.mjs" hook'/.test(after), after.split("\n").find((l) => l.includes("command:")) ?? "");
    // Pinning twice must be a no-op, because `install --force` is an upgrade path.
    const again = pinHookPaths(dir);
    check("pinning an already-pinned hook is idempotent", true, again.ok, JSON.stringify(again.problems));
    check("...and does not double-wrap the command", after, readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  }
  {
    const dir = path.join(tmp, "no-hook-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: docs-only\n---\nbody\n", "utf8");
    check("a skill with no hook at all installs cleanly", true, pinHookPaths(dir).ok);
  }
  {
    check("a directory with no SKILL.md is not an installed skill", false, pinHookPaths(path.join(tmp, "nothing-here")).ok);
  }

  // ---- the post-install inspection is not redundant with the pin.
  //
  // cmdInstall runs BOTH, and this is the case that shows why. A hook command
  // with no mode argument is not a shape pinHookPaths can rewrite — it matches
  // nothing, so the pin honestly reports "no hooks to pin, nothing wrong". The
  // command is still there, still carrying an unexpanded $HOME, and still
  // pointing at a file that does not exist in a project-scoped install. Only
  // inspectInstalled catches that, and until this fix cmdInstall never called
  // it: install printed "+", `status` printed BROKEN, one second apart.
  {
    const dir = path.join(tmp, "modeless-hook");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: modeless\nhooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n      hooks:\n        - type: command\n" +
        "          command: \"node $HOME/.claude/skills/definitely-not-installed/scripts/tb-nowhere.mjs\"\n---\nbody\n",
      "utf8",
    );
    check("a hook with no mode argument is not something the pin can fix", true, pinHookPaths(dir).ok, JSON.stringify(pinHookPaths(dir).problems));
    check("...and the post-install inspection catches it anyway", false, inspectInstalled(dir).ok, inspectInstalled(dir).problem ?? "");
    check("...naming the path that is not there", true, /tb-nowhere\.mjs/.test(inspectInstalled(dir).problem ?? ""), inspectInstalled(dir).problem ?? "");
  }

  // ---- status must not call a present-but-inert directory installed
  {
    const proj = path.join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    const r = run(["install", "careful"], proj);
    check("installing careful into a project succeeds", 0, r.status, r.stdout.slice(0, 300));
    const engine = path.join(proj, ".claude", "skills", "careful", "scripts", "tb-guard.mjs");
    check("...and the engine is really there", true, existsSync(engine));
    check("status reports it installed", 0, run(["status"], proj).status);
    rmSync(engine, { force: true });
    const s = run(["status"], proj);
    check("status refuses to call a skill with no engine installed", 1, s.status, s.stdout.slice(0, 300));
    check("...and names it BROKEN", true, /careful\s+BROKEN/.test(s.stdout), s.stdout.slice(0, 300));
  }

  // ---- the duplicate-hook check. The failure it catches reads as a clean
  // install: both skills print "+", both hooks fire, and the second prompt is
  // indistinguishable from the first.
  {
    const proj = path.join(tmp, "proj-clash");
    mkdirSync(proj, { recursive: true });
    const dest = path.join(proj, ".claude", "skills");

    const one = run(["install", "careful"], proj);
    check("installing careful alone warns about no conflict", false, /prompt twice/.test(one.stdout), one.stdout.slice(-300));
    check("...and conflictingHooks finds nothing", 0, conflictingHooks(dest).length, JSON.stringify(conflictingHooks(dest)));

    const two = run(["install", "guard"], proj);
    const found = conflictingHooks(dest);
    check("careful + guard is detected as a duplicate hook", true, found.length > 0, JSON.stringify(found));
    check(
      "...and it is the Bash/careful pair that is named",
      true,
      found.some((c) => /^Bash /.test(c.pair) && c.skills.includes("careful") && c.skills.includes("guard")),
      JSON.stringify(found),
    );
    check("...and the install says it will prompt twice", true, /prompt twice/.test(two.stdout), two.stdout.slice(-500));
    check("...and offers the uninstall that resolves it", true, /uninstall careful/.test(two.stdout), two.stdout.slice(-500));
    check("...but does not fail the install over it", 0, two.status, two.stdout.slice(-300));

    // Hooks on DIFFERENT tools are not a conflict: freeze never touches Bash.
    const regs = hookRegistrations(path.join(dest, "careful"));
    check("hookRegistrations reads careful's one Bash/careful hook", "Bash/careful", regs.map((r) => `${r.matcher}/${r.mode}`).join(","), JSON.stringify(regs));
    check("a directory with no SKILL.md registers no hooks", 0, hookRegistrations(path.join(tmp, "nowhere")).length);
  }

  // ---- ordinary argument handling
  {
    const proj = path.join(tmp, "proj2");
    mkdirSync(proj, { recursive: true });
    check("an unknown command exits non-zero", 1, run(["definitely-not-a-command"], proj).status);
    check("installing a skill that does not exist exits non-zero", 1, run(["install", "not-a-skill"], proj).status);
  }

  // ---- `install --cursor` routes to the Cursor engine, and that engine's
  // refusals survive the trip. The risk being tested is that --cursor silently
  // falls through to the Claude Code installer, which would write
  // .claude/skills and report success while the user believes they installed
  // into Cursor — and would install the guards Cursor cannot enforce.
  {
    const proj = path.join(tmp, "proj-cursor");
    mkdirSync(proj, { recursive: true });
    const fakeCursor = path.join(tmp, "cursor-home");
    mkdirSync(fakeCursor, { recursive: true });
    const runEnv = (args, cwd, env) => {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", ...env },
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    const noCursor = runEnv(["install", "careful", "--cursor"], proj, { TOOLBAY_CURSOR_HOME: path.join(tmp, "nope") });
    check("install --cursor refuses when Cursor is absent", 1, noCursor.status, noCursor.stdout.slice(0, 300));
    check("...and writes no .claude directory either", false, existsSync(path.join(proj, ".claude")));

    const ok = runEnv(["install", "careful", "plan-tune", "--cursor"], proj, { TOOLBAY_CURSOR_HOME: fakeCursor });
    check("install --cursor installs into .cursor, not .claude", true, existsSync(path.join(proj, ".cursor", "skills", "careful", "SKILL.md")), ok.stdout.slice(-400));
    check("...and does NOT write .claude/skills", false, existsSync(path.join(proj, ".claude", "skills")));
    check("...and the Cursor engine's refusal of plan-tune survives the delegation", true, /REFUSED/.test(ok.stdout) && /plan-tune/.test(ok.stdout), ok.stdout.slice(-500));
    check("...and hooks.json was written", true, existsSync(path.join(proj, ".cursor", "hooks.json")));
    check("...with failClosed on every entry", true, Object.values(JSON.parse(readFileSync(path.join(proj, ".cursor", "hooks.json"), "utf8")).hooks).flat().every((h) => h.failClosed === true));
    check("--help mentions the cursor install", true, /--cursor/.test(runEnv(["--help"], proj, {}).stdout));

    // uninstall --cursor has to reach the Cursor engine too. It did not: it
    // fell through to the Claude Code uninstaller, said "Nothing to remove in
    // <project>/.claude/skills", exited 0, and left the whole .cursor install
    // in place — including the guards. The install output recommends this exact
    // command, so the documented way out was a no-op that reported success.
    {
      const theirs = path.join(proj, ".cursor", "hooks.json");
      const cfg = JSON.parse(readFileSync(theirs, "utf8"));
      cfg.hooks.afterFileEdit = [{ command: "./their-formatter.sh" }];
      writeFileSync(theirs, JSON.stringify(cfg, null, 2));

      const un = runEnv(["uninstall", "--cursor"], proj, { TOOLBAY_CURSOR_HOME: fakeCursor });
      check("uninstall --cursor does not report on .claude instead", false, /\.claude/.test(un.stdout), un.stdout.slice(0, 300));
      check("...and really removes the Cursor skills", false, existsSync(path.join(proj, ".cursor", "skills", "careful", "SKILL.md")), un.stdout.slice(0, 300));
      check("...and the adapter", false, existsSync(path.join(proj, ".cursor", "hooks", "tb-cursor.mjs")));
      const after = JSON.parse(readFileSync(theirs, "utf8"));
      check("...and every Toolbay hook entry", 0, Object.values(after.hooks || {}).flat().filter((h) => h && h.toolbayStack).length, JSON.stringify(after.hooks));
      check("...while leaving the user's own hook alone", true, (after.hooks.afterFileEdit || []).some((h) => h.command === "./their-formatter.sh"), JSON.stringify(after.hooks));
    }

    // THE ONE THAT ONLY FAILS FOR SOMEBODY ELSE.
    //
    // Everything above passes from a git checkout, because src/ is sitting
    // right there. package.json's `files` allowlist decides what a published
    // tarball actually contains, and it listed bin, skills, LICENSE, NOTICE and
    // README — not src. So `npx toolbay-stack install --cursor` reached
    // cmdInstallCursor, failed existsSync on the engine, printed "The Cursor
    // engine is missing" and exited 1, for every user who was not us. The
    // Cursor support was untestable from the outside because it was not in the
    // package.
    //
    // Asserting on package.json rather than on the filesystem is the point: the
    // filesystem is the thing that is always fine here.
    {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
      const engineRel = "src/cursor/tb-cursor.mjs";
      const shipped = (pkg.files || []).some((f) => {
        const norm = String(f).replace(/^\.\//, "").replace(/\/$/, "");
        return norm === engineRel || engineRel.startsWith(`${norm}/`);
      });
      check(
        "the Cursor engine is inside package.json files, so a published install can find it",
        true,
        shipped,
        `package.json files = ${JSON.stringify(pkg.files)}; without src, install --cursor exits 1 for every npm user`,
      );
    }
  }

  } catch (e) {
    check("the installer selftest ran to completion without throwing", true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
  }

  rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  toolbay-stack installer selftest  (node ${process.version}, ${process.platform})\n`);
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
  out("\n  An install that leaves a safety skill present and inert is the failure this");
  out("  package exists to remove, so it is a failed install here, not a warning.\n");
}

function help() {
  out(`
${bold("toolbay-stack")} ${dim(`v${pkg.version}`)}

An agent stack that can buy the skill it is missing and sell the one it
just built. Built on gstack by Garry Tan (MIT) — ${dim("github.com/garrytan/gstack")}

${bold("Usage")}
  ${cyan(CLI)}   list the skills
  ${cyan(`${CLI} install --global`)}   install all, for every project
  ${cyan(`${CLI} install toolbay`)}   install one, into ./.claude/skills
  ${cyan(`${CLI} install --cursor`)}   install into ./.cursor for Cursor
  ${cyan(`${CLI} status`)}   what is installed where
  ${cyan(`${CLI} uninstall --global`)}   remove them again

${bold("Options")}
  -g, --global    install for every project on this machine
  -f, --force     overwrite an already-installed skill
      --cursor    target Cursor instead of Claude Code
  -h, --help      show this
  -v, --version   show the version

${bold("Cursor")}
  Cursor can genuinely deny an edit or a shell command before it happens, so
  the guards port. What it cannot enforce is REFUSED at install time and named,
  rather than installed as documentation for protection that never fires:

    ${cyan("node src/cursor/tb-cursor.mjs capabilities")}   what it can and cannot do
    ${cyan("node src/cursor/tb-cursor.mjs doctor")}         and whether it is proven yet

${bold("Notes")}
  Skills are bundled. This command makes no network requests and collects
  nothing. ${dim(HOME)}
`);
}

const argv = process.argv.slice(2);
const flags = {
  global: argv.includes("-g") || argv.includes("--global"),
  force: argv.includes("-f") || argv.includes("--force"),
  cursor: argv.includes("--cursor"),
  allowMissingCursor: argv.includes("--allow-missing-cursor"),
};
const positional = argv.filter((a) => !a.startsWith("-"));
const [cmd, ...rest] = positional;

if (argv.includes("-h") || argv.includes("--help")) help();
else if (argv.includes("-v") || argv.includes("--version")) out(pkg.version);
else if (!cmd || cmd === "list" || cmd === "ls") cmdList();
else if ((cmd === "install" || cmd === "add" || cmd === "i") && flags.cursor) cmdInstallCursor(rest, flags);
else if (cmd === "install" || cmd === "add" || cmd === "i") cmdInstall(rest, flags);
else if ((cmd === "uninstall" || cmd === "remove" || cmd === "rm") && flags.cursor) cmdUninstallCursor(flags);
else if (cmd === "uninstall" || cmd === "remove" || cmd === "rm") cmdUninstall(rest, flags);
else if (cmd === "status") cmdStatus();
else if (cmd === "selftest") selftest();
else {
  out();
  out(`  Unknown command ${bold(cmd)}. Try ${cyan(`${CLI} --help`)}.`);
  out();
  process.exitCode = 1;
}
