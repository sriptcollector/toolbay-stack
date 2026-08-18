#!/usr/bin/env node
/**
 * tb-cursor.mjs — install the Toolbay Stack into Cursor, and refuse to install
 * any protection Cursor cannot actually enforce.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This adapter is not derived from gstack's code — gstack has no Cursor
 * integration — but the skills it installs include files that are. See LICENSE
 * and NOTICE.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS CHECKED, AND WHAT IS STILL ASSUMED
 * ---------------------------------------------------------------------------
 *
 * This file is the reason the whole package exists, pointed at ourselves. The
 * one thing we must not do is ship a guard into a second editor that looks
 * installed and enforces nothing. So the capability table below is built from
 * evidence, each row is labelled with how strong that evidence is, and the
 * installer refuses any skill whose guard maps to a row it cannot enforce.
 *
 * VERIFIED ON DISK (first-party Anysphere documentation, read directly):
 *
 *   ~/.cursor/skills-cursor/create-hook/SKILL.md
 *   ~/.cursor/skills-cursor/create-skill/SKILL.md
 *
 *   Those are Cursor's own built-in authoring skills, shipped inside the app
 *   install, not a blog post and not a memory. They state:
 *
 *     - hooks live in `.cursor/hooks.json` (project) or `~/.cursor/hooks.json`
 *       (user), schema `{ "version": 1, "hooks": { "<event>": [ ... ] } }`
 *     - a hook entry takes `command`, `type`, `timeout`, `matcher`,
 *       `failClosed`, `loop_limit`
 *     - "Block or approve shell commands -> beforeShellExecution"
 *     - "Block or rewrite a specific tool call -> preToolUse"
 *     - beforeShellExecution / beforeMCPExecution / preToolUse "can return
 *       `permission`, `user_message`, and `agent_message`"
 *     - "Exit code 2: block the action, same as returning deny"
 *     - "Other non-zero exit codes: fail open by default unless
 *       `failClosed: true`"
 *     - project hooks run from the project root; user hooks run from ~/.cursor
 *     - "Matchers use JavaScript-style regular expressions, not POSIX/grep"
 *     - skills live in `.cursor/skills/<name>/SKILL.md`, frontmatter `name`
 *       (max 64 chars, lowercase/numbers/hyphens) and `description`
 *
 *   Cursor 3.16.17 is installed on the machine this was written on
 *   (AppData/Local/Programs/cursor/resources/app/package.json).
 *
 * SO THE HEADLINE ANSWER IS YES: Cursor can deny an edit or a shell command
 * before it happens, from an external script, on an exit code. That is a real
 * PreToolUse equivalent, and the guards port.
 *
 * WHAT IS NOT VERIFIED, AND IS THEREFORE TREATED AS UNPROVEN:
 *
 *   1. NOTHING HERE HAS BEEN OBSERVED FIRING INSIDE A LIVE CURSOR AGENT LOOP.
 *      The format is documented by Cursor; that the hook actually runs on this
 *      user's machine, with this user's Cursor build, is a separate claim and
 *      this file does not make it. It MEASURES it instead: every invocation of
 *      the adapter records what fired into an observation ledger, and `doctor`
 *      reports UNPROVEN until Cursor has really called it. See observations().
 *
 *   2. THE TOOL NAMES CURSOR USES ARE NOT KNOWN FROM DOCUMENTATION. The
 *      create-hook skill names `Shell`, `Read`, `Write`, `Task` as examples of
 *      preToolUse matchers. Whether Cursor's edit tool is called `Write` in
 *      every build, and what its argument key for the target path is, is not
 *      stated anywhere we could check. A matcher that matches nothing is a
 *      guard that never fires, silently — the exact defect this package was
 *      forked to remove. Two things follow, and both are implemented:
 *        - the write matcher is deliberately broad, and
 *        - the observation ledger records the real tool names Cursor sends, so
 *          `doctor` can say "your Cursor calls it X, and the matcher covers it"
 *          instead of anybody assuming.
 *
 *   3. HOOKS ARE BETA. They landed in Cursor 1.7 and Cursor's own changelog
 *      calls them beta. There are open reports of a malformed JSON response
 *      failing OPEN rather than blocking, which is why this adapter never
 *      relies on `failClosed` alone and always emits an explicit decision.
 *
 *   4. THE CURSOR CLI (`cursor-agent`) IS NOT COVERED. Its docs describe rules,
 *      AGENTS.md and mcp.json as shared with the editor and say nothing about
 *      hooks. It is not installed on this machine and we could not test it.
 *      `install` says so rather than implying terminal sessions are guarded.
 *
 * ---------------------------------------------------------------------------
 * ONE DELIBERATE DIFFERENCE FROM THE CLAUDE CODE GUARD
 * ---------------------------------------------------------------------------
 *
 * In Claude Code the guard expresses "allow" as `{}` — silence — because an
 * explicit allow OVERRIDES the user's own permission rules, and a safety hook
 * that widens permissions is a contradiction. In Cursor we emit an explicit
 * `{"permission":"allow"}` instead, because Cursor's own documented example
 * does, and because we set `failClosed: true` on every entry: with failClosed
 * on, a response Cursor considers invalid BLOCKS the action. Staying silent
 * would risk blocking every shell command in the editor, which is not a safe
 * failure, it is an unusable one that gets the guard uninstalled. So we follow
 * the platform here and say so out loud rather than porting a decision whose
 * reasoning does not carry across.
 *
 *   node tb-cursor.mjs capabilities        what Cursor can and cannot enforce
 *   node tb-cursor.mjs install [names...]  install into .cursor/
 *   node tb-cursor.mjs uninstall           take it back out
 *   node tb-cursor.mjs status              what is installed, and is it proven
 *   node tb-cursor.mjs doctor              simulate real payloads, report truth
 *   node tb-cursor.mjs hook <mode>         the runtime adapter Cursor calls
 *   node tb-cursor.mjs selftest            prove all of the above fails closed
 *
 * Flags: --project <dir>  --global  --force  --allow-missing-cursor  --json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.2.0";
const CLI_HINT = "npx toolbay-stack";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

// ===========================================================================
// THE CAPABILITY TABLE
// ===========================================================================
//
// Every row is a thing a Toolbay Stack guard needs an editor to be able to do.
// `supported` is the only field the installer reads; everything else is there
// so a human can check our homework. `evidence` cites the file or page the
// claim came from, and `confidence` is deliberately blunt:
//
//   "documented"  Cursor's own docs or its bundled first-party skills say so.
//                 Not observed running.
//   "implemented" we read the code that does it, inside the Cursor build on this
//                 machine. Stronger than "documented" — a doc can be stale, the
//                 shipped bundle is what actually runs — and still weaker than
//                 "observed", because reading a branch is not watching it taken.
//   "observed"    we have seen it happen on this machine. Nothing earns this
//                 at install time; only the observation ledger can grant it.
//   "absent"      we looked and there is no such surface.
//   "unproven"    the surface exists but we could not establish that it carries
//                 what a guard needs. NOT the same as absent, and it is still a
//                 refusal: an unknown is not an install.

// The Cursor build's own hook implementation, read off this machine. Paths are
// relative to the Cursor install root
// (%LOCALAPPDATA%/Programs/cursor/resources/app on Windows). Quoted symbols are
// minified identifiers, so they will change name between builds — the string
// literals beside them will not, and those are what to grep for.
export const BUNDLE = {
  matcher:
    'out/vs/workbench/workbench.desktop.main.js, module "../packages/hooks/src/matcher.ts": ' +
    'function(e,t){if(!e.matcher||e.matcher===""||e.matcher==="*"||t===void 0)return!0;try{return new RegExp(e.matcher).test(t)}catch{return!0}} ' +
    "— an UNANCHORED RegExp.test against the match value, and for preToolUse that value is `t.tool_name`.",
  exitTwo:
    'out/vs/workbench/workbench.desktop.main.js: the hook runner compares the child\'s exit code to the constant 2 and logs "Hook ... blocked action (exit code 2)" before turning it into a block response.',
  permissionEnum:
    'out/vs/workbench/workbench.desktop.main.js, modules "../packages/hooks/src/validators/preToolUseResponse.ts" and ' +
    '"../packages/hooks/src/validators/beforeCommandExecutionHookResponse.ts": both validate `permission` against ["allow","deny","ask"].',
  blockingSteps:
    "out/vs/workbench/workbench.desktop.main.js: the list of hook steps that may block is exactly " +
    "[beforeShellExecution, beforeMCPExecution, beforeReadFile, beforeTabFileRead, subagentStart, preToolUse].",
  toolNames:
    'out/vs/workbench/workbench.glass.main.js: Cursor\'s own tool vocabulary, as a switch over its internal tool enum — ' +
    'Read, Grep, Glob, Shell, Edit, LS, SemanticSearch, Delete, WebSearch, MCP, Task, CreatePlan, ReadLints, ListMCPResources, TodoWrite, AskQuestion. ' +
    'Separately, module "../packages/hooks/src/claude-code-types.ts" carries Cursor\'s Claude Code importer map: ' +
    '{Bash:"Shell",Read:"Read",Write:"Write",Edit:"Write",Glob:null,Grep:"Grep",WebFetch:"WebFetch",WebSearch:"WebSearch",Task:"Task"}.',
};

export const CAPABILITIES = {
  "deny-shell-command": {
    supported: true,
    event: "beforeShellExecution",
    confidence: "implemented",
    summary: "block or ask before a terminal command runs",
    evidence:
      "~/.cursor/skills-cursor/create-hook/SKILL.md: \"Block or approve shell commands -> beforeShellExecution\"; " +
      "that event \"can return permission, user_message, and agent_message\"; \"Exit code 2: block the action, same as returning deny\". " +
      `Confirmed in the shipped build, not just the doc — ${BUNDLE.permissionEnum} ${BUNDLE.exitTwo} ${BUNDLE.blockingSteps}`,
    // beforeShellExecution's payload is {command, cwd, sandbox} — no tool_input
    // wrapper, so the adapter has to reshape it. See normalizeCursorPayload.
    payloadShape: "{ command, cwd, sandbox }",
  },
  "deny-file-write": {
    supported: true,
    event: "preToolUse",
    confidence: "implemented",
    summary: "block an edit or file write before it is applied",
    evidence:
      "~/.cursor/skills-cursor/create-hook/SKILL.md: \"Block or rewrite a specific tool call -> preToolUse\"; " +
      "preToolUse \"can return permission, user_message, agent_message, and updated_input\"; matchers filter on tool type such as Write. " +
      `Confirmed in the shipped build — ${BUNDLE.permissionEnum} ${BUNDLE.blockingSteps} ` +
      "The payload shape below is Cursor's own protobuf `agent.v1.PreToolUseRequestQuery` in workbench.glass.main.js.",
    caveat:
      "The key Cursor puts the target path under is still not stated anywhere, so the adapter normalises a list of aliases and the guard fails closed when none of them is present. " +
      "The tool NAMES are no longer a guess: they are read out of the build (see BUNDLE.toolNames). That is what turned this row's broad matcher from a safe over-match into a bug — see WRITE_MATCHER.",
    payloadShape: "{ tool_name, tool_input, tool_use_id, cwd, conversation_id, generation_id, model }",
  },
  "gate-mcp-call": {
    supported: true,
    event: "beforeMCPExecution",
    confidence: "documented",
    summary: "block or ask before an MCP tool call runs",
    evidence: "~/.cursor/skills-cursor/create-hook/SKILL.md: \"Protect MCP calls -> beforeMCPExecution\"; returns permission.",
    payloadShape: "{ tool_name, tool_input, url }",
  },

  // ---- the rows that make this table worth having ----

  "deny-question-tool": {
    supported: false,
    confidence: "unproven",
    summary: "intercept the agent's structured-question tool before it asks",
    why:
      "Cursor HAS a question tool — its tool enum names it \"AskQuestion\" — but two things are unestablished and either one is fatal. " +
      "Nothing shows that preToolUse fires for it rather than Cursor treating the question as UI; and /plan-tune matches Claude's spelling, AskUserQuestion, " +
      "which Cursor's Claude Code importer map does not translate, so it would never test true against \"AskQuestion\" anyway. " +
      "An unproven guard is refused on the same rule as an absent one: it would install cleanly, read as protection, and never fire.",
    correction:
      "AN EARLIER VERSION OF THIS ROW SAID \"Cursor has no AskUserQuestion tool and no hook event over one\". That was false, and it is corrected in place " +
      "rather than quietly deleted, because a table whose whole job is honesty has to be honest about itself. Cursor's internal tool enum maps ASK_QUESTION to " +
      "\"AskQuestion\" (workbench.glass.main.js), and Cursor's own bundled create-skill skill tells the agent to \"use the AskQuestion tool when available\". " +
      "The verdict did not change; the reason did, from a claim about the editor to a claim about what we could establish. If you want this capability, prove " +
      "the event fires first, then widen the matcher.",
  },
  "deny-after-file-edit": {
    supported: false,
    confidence: "absent",
    summary: "block an edit from Cursor's afterFileEdit event",
    why:
      "afterFileEdit fires AFTER the edit has been written, and it is absent from the list of events that may return a permission " +
      "(create-hook's Event Output Cheat Sheet grants permission to preToolUse, subagentStart, beforeShellExecution and beforeMCPExecution only). " +
      `The shipped build agrees: ${BUNDLE.blockingSteps} and its afterFileEdit response validator ` +
      '("../packages/hooks/src/validators/afterEditFileResponse.ts") checks only that the response is an object — it reads no permission field at all. ' +
      "It can report a violation. It cannot prevent one, so nothing may be installed against it and called a guard.",
  },
  "deny-tab-edit": {
    supported: false,
    confidence: "absent",
    summary: "stop Cursor's Tab autocomplete from writing outside a freeze boundary",
    why:
      "Tab (inline completion) writes files on its own path, and the only Tab EDIT event is afterTabFileEdit, which fires after the write and whose response " +
      'validator ("../packages/hooks/src/validators/afterTabFileEditResponse.ts") reads no permission field. Cursor does expose a blocking beforeTabFileRead, ' +
      "so Tab READS can be gated and Tab WRITES cannot. " +
      "THIS IS A REAL HOLE IN /freeze UNDER CURSOR AND IT IS NOT PATCHABLE FROM HERE, so it is not silently absent from the table: it is named, and " +
      "enforcementBanner() prints it into every installed SKILL.md so nobody reads 'blocks any edit outside the boundary' and believes it covers Tab.",
  },
  "gate-via-mcp-server": {
    supported: false,
    confidence: "absent",
    summary: "use an MCP server to deny another tool's call",
    why:
      "An MCP server exposes tools; it does not sit in front of anybody else's. Gating MCP is done with beforeMCPExecution, which is a hook, not a server. " +
      "Listing this row because 'add an MCP server' is the usual wrong answer to 'how do I add a guard to Cursor'.",
  },
};

/**
 * Which capability a Claude Code PreToolUse matcher needs from the host editor.
 *
 * Read from the skill's own frontmatter rather than a hard-coded list of skill
 * names, so a skill that gains or loses a hook is classified correctly without
 * anybody remembering to edit this file. That is the same rule the rest of this
 * package follows: ask the disk.
 */
export function capabilityForMatcher(matcher) {
  const m = String(matcher || "");
  if (/AskUserQuestion/i.test(m)) return "deny-question-tool";
  if (/\b(Bash|Shell|Terminal)\b/i.test(m)) return "deny-shell-command";
  if (/\b(Edit|Write|MultiEdit|NotebookEdit|Update|Create)\b/i.test(m)) return "deny-file-write";
  if (/^mcp__/i.test(m)) return "gate-mcp-call";
  return null; // unrecognised, which is NOT the same as unsupported
}

/** The Cursor hook event that serves a capability, or null if none can. */
export function eventForCapability(cap) {
  const row = CAPABILITIES[cap];
  return row && row.supported ? row.event : null;
}

// ===========================================================================
// READING A SKILL
// ===========================================================================

/** Split a SKILL.md into frontmatter text and body. */
export function splitFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/.exec(md);
  if (!m) return { fm: null, body: md, raw: null };
  return { fm: m[1], body: md.slice(m[0].length), raw: m[0] };
}

/**
 * Every (matcher, engine, mode) a skill's frontmatter registers a hook for.
 * Same shape the Claude Code installer reads, kept separate on purpose: this
 * one has to survive being handed a skill it has never seen.
 */
export function hookRegistrations(md) {
  const { fm } = splitFrontmatter(md);
  if (!fm) return [];
  const block = /^hooks:[ \t]*\r?\n([\s\S]*)$/m.exec(fm);
  if (!block) return [];
  const regs = [];
  let matcher = null;
  for (const line of block[1].split(/\r?\n/)) {
    const mm = /^\s*-\s*matcher:\s*["']?([^"']+?)["']?\s*$/.exec(line);
    if (mm) {
      matcher = mm[1];
      continue;
    }
    const cm = /command:\s*.*?([A-Za-z0-9_.-]+\.mjs)["']?\s+([\w-]+)/.exec(line);
    if (cm && matcher) regs.push({ matcher, engine: cm[1], mode: cm[2] });
  }
  return regs;
}

/**
 * Remove the `hooks:` block from frontmatter.
 *
 * Cursor does not read a Claude Code hooks block, so leaving it in the
 * installed copy would be a lie told to the next reader — including the agent,
 * which reads SKILL.md and would report the user as protected by a PreToolUse
 * hook that this editor has never heard of. The real wiring goes in
 * .cursor/hooks.json and the banner below says so.
 */
export function stripHooksFrontmatter(md) {
  const { fm, body, raw } = splitFrontmatter(md);
  if (!fm) return md;
  const lines = fm.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^hooks:[ \t]*$/.test(l));
  if (startIdx === -1) return md;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    // A new top-level key ends the block. Blank lines and indented lines do not.
    if (/^[^\s#][^:]*:/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const kept = [...lines.slice(0, startIdx), ...lines.slice(endIdx)];
  return `---\n${kept.join("\n").replace(/\n+$/, "")}\n---\n${raw ? "" : ""}${body}`;
}

/**
 * Point the script paths in an installed copy at where the scripts actually are.
 *
 * Every SKILL.md tells the agent to run its engine by path, and every one of
 * those paths is Claude Code's: `~/.claude/skills/<name>/scripts/<engine>.mjs`,
 * 37 of them for tb-mode.mjs alone. Installed into Cursor unchanged, that is an
 * instruction to execute a file that is not there. The skill does not fail
 * loudly either — the agent runs the command, gets ENOENT, and improvises.
 *
 * The rewrite is deliberately narrow: only `.claude/skills/`, only to the
 * matching `.cursor/skills/`, matching `~/`, `$HOME/` and bare forms. Prose
 * about Claude Code is left alone, because rewriting "in Claude Code this lives
 * in .claude/" into a sentence about Cursor would make the document lie about a
 * different editor to avoid lying about this one. The banner says so instead.
 *
 * @param {string} md
 * @param {{global?: boolean}} [opts]  global installs land in ~/.cursor
 */
export function retargetClaudePaths(md, opts = {}) {
  const root = opts.global ? "~/.cursor/skills/" : ".cursor/skills/";
  return String(md)
    .replace(/(?:~\/|\$HOME\/|\$\{HOME\}\/|%USERPROFILE%[\\/])?\.claude\/skills\//g, root)
    .replace(/(?:~\/|\$HOME\/)?\.claude\\skills\\/g, root.replace(/\//g, "\\"));
}

/**
 * The banner stamped into every SKILL.md this installs.
 *
 * It exists because the agent reads this file and answers questions about it.
 * A /freeze SKILL.md that says "blocks any Edit outside the boundary, fails
 * closed" is a true sentence about Claude Code and an unproven one about
 * Cursor, and if the hook is not firing it is a false one. So the installed
 * copy carries what is actually enforcing it, in this editor, right at the top.
 */
export function enforcementBanner(plan) {
  const lines = [];
  lines.push("");
  lines.push("> **Running in Cursor.** This copy was installed by `toolbay-stack install --cursor`.");
  lines.push(">");
  lines.push("> This skill was written for Claude Code, so read two things below as Claude Code's");
  lines.push("> and not as instructions for this editor:");
  lines.push(">");
  lines.push("> - `/name` is Claude Code's slash-command syntax. Cursor has no slash commands for");
  lines.push(">   skills — invoke this one by naming it (\"use the freeze skill\"), and read any");
  lines.push(">   `/other-skill` below as \"the other-skill skill\".");
  lines.push("> - Any `.claude/` path is Claude Code's install location. Script paths in this copy");
  lines.push(">   have been retargeted to `.cursor/`; a `.claude/settings.json` mentioned in prose");
  lines.push(">   has no Cursor equivalent and does not apply here.");
  if (!plan.hooks.length) {
    lines.push(">");
    lines.push("> This skill registers no guard. Nothing about it is enforced by a hook in any editor;");
    lines.push("> it is instructions and engines, and it behaves here exactly as it does in Claude Code.");
  } else {
    lines.push(">");
    lines.push("> Its guard is enforced by Cursor hooks in `.cursor/hooks.json`, NOT by the");
    lines.push("> `hooks:` frontmatter this file carries in Claude Code (that block has been removed");
    lines.push("> from this copy, because Cursor does not read it). Enforcement here:");
    lines.push(">");
    for (const h of plan.hooks) {
      lines.push(`> - \`${h.event}\` -> ${CAPABILITIES[h.capability].summary} (\`failClosed: true\`)`);
    }
    if (plan.hooks.some((h) => h.capability === "deny-file-write")) {
      lines.push(">");
      lines.push("> **WHAT THIS GUARD DOES NOT COVER IN CURSOR.** Read this before you trust it,");
      lines.push("> because the text below was written about an editor where these gaps do not exist:");
      lines.push(">");
      lines.push("> - **Tab does not go through it.** Cursor's inline autocomplete writes files on its");
      lines.push(">   own path, and the only Tab edit event (`afterTabFileEdit`) fires after the write");
      lines.push(">   and cannot refuse it. A Tab completion can edit a file outside the boundary and");
      lines.push(">   this guard will not see it. Turn Tab off if the boundary has to hold.");
      lines.push("> - **A file written by a shell command is a shell decision, not an edit.** `echo >`");
      lines.push(">   or `git checkout` reaches `beforeShellExecution` and is judged as a command, so");
      lines.push(">   it is checked by /careful's destructive-pattern list, not by the boundary.");
      lines.push("> - **Your own typing is never guarded.** Hooks gate the agent, not the editor.");
    }
    lines.push(">");
    lines.push("> **Not yet proven on this machine.** Cursor's hook format is documented by Cursor,");
    lines.push("> but that these hooks actually fire in your Cursor build has not been observed.");
    lines.push("> Run `node .cursor/hooks/tb-cursor.mjs doctor` — it reports UNPROVEN until Cursor");
    lines.push("> has really called them, and never claims otherwise. Do not tell the user they are");
    lines.push("> protected until doctor says OBSERVED.");
  }
  lines.push("");
  return lines.join("\n");
}

// ===========================================================================
// PLANNING AN INSTALL
// ===========================================================================

/**
 * Decide what installing one skill into Cursor would mean, without doing it.
 *
 * Returns { name, ok, hooks[], refusals[] }. `ok: false` means the skill must
 * not be installed at all: it registers a guard that Cursor cannot enforce, and
 * installing the documentation for a guard that does not run is precisely how a
 * user ends up believing in protection they do not have.
 */
export function planSkill(name, md) {
  const regs = hookRegistrations(md);
  const hooks = [];
  const refusals = [];
  const seen = new Set();

  for (const reg of regs) {
    const cap = capabilityForMatcher(reg.matcher);
    if (!cap) {
      refusals.push({
        matcher: reg.matcher,
        capability: null,
        why:
          `the matcher "${reg.matcher}" does not map to any capability this installer understands, ` +
          `so whether Cursor could enforce it is unknown — and an unknown is not an install`,
      });
      continue;
    }
    const row = CAPABILITIES[cap];
    if (!row.supported) {
      refusals.push({ matcher: reg.matcher, capability: cap, why: row.why });
      continue;
    }
    const key = `${row.event}:${reg.mode}`;
    if (seen.has(key)) continue; // four Claude matchers collapse to one Cursor entry
    seen.add(key);
    hooks.push({
      event: row.event,
      capability: cap,
      mode: reg.mode,
      engine: reg.engine,
      matcher: matcherFor(cap),
    });
  }

  return { name, ok: refusals.length === 0, hooks, refusals };
}

/**
 * The matcher written into hooks.json, as a JavaScript regular expression.
 *
 * Cursor's create-hook skill is explicit that these are JS regexes and not
 * POSIX, and equally explicit that a matcher is the first thing to suspect when
 * a hook does not fire. So:
 *
 *   - the shell hook takes NO matcher. Every terminal command should reach
 *     /careful; filtering which commands are dangerous is the guard's whole
 *     job and it is already good at it. A matcher here could only subtract.
 *   - the write hook takes a deliberately broad alternation, because the cost
 *     of matching a tool that turns out not to write anything is one guard run
 *     that answers allow, and the cost of missing the tool that does write is
 *     an unguarded edit and a user who thinks otherwise.
 *
 * JS has no inline `(?i)` flag, so the case-insensitivity is spelled out in the
 * alternation instead, and verifyHooksFile compiles every matcher it wrote.
 *
 * An earlier version of this comment said an uncompilable matcher is an entry
 * Cursor never loads, so the guard silently never fires. THE SHIPPED BUILD DOES
 * THE OPPOSITE and it is worth knowing which way it fails: matcher.ts ends
 * `catch { return !0 }`, so a matcher Cursor cannot compile matches EVERY tool
 * call. The failure is a guard that fires on everything, not one that fires on
 * nothing — noisy rather than silent, which is the better of the two, and either
 * way verifyHooksFile refuses to write one.
 *
 * IT IS ALSO UNANCHORED, WHICH IS A DELIBERATE CHOICE AND NOT AN OVERSIGHT.
 * An earlier version anchored on `^`, and the selftest caught that it would
 * therefore miss `search_replace` and `str_replace_editor` — snake_case names
 * are entirely plausible and Cursor documents none of them. Matching the verb
 * anywhere in the name covers Write, MultiEdit, ApplyDiff, notebook_edit and
 * str_replace_editor alike.
 *
 * The cost of matching too much is one extra guard run. The cost of matching
 * too little is an unguarded edit and a user who believes otherwise, which is
 * the failure this package exists to remove, so the trade is not close. And the
 * blast radius of over-matching is small and bounded: /freeze answers allow for
 * everything until a boundary has actually been set, so a broad matcher costs
 * nothing at all except during the deliberate, attentive session in which
 * somebody has frozen a directory on purpose.
 */
const WRITE_VERBS = ["write", "edit", "create", "update", "apply", "patch", "replace", "insert", "append", "delete", "remove", "rename", "move", "mkdir", "save"];
const WRITE_ALTERNATION = `(?:${WRITE_VERBS.map((v) => [...v].map((ch) => `[${ch.toUpperCase()}${ch}]`).join("")).join("|")})`;

/**
 * The tools that carry a write verb in their name and write NO FILE.
 *
 * This list is not a guess and it is not a convenience. It is the fix for a bug
 * that made /freeze unusable in Cursor, caught by running the installed hook
 * command against Cursor's real tool vocabulary:
 *
 *   Cursor's tool enum (BUNDLE.toolNames) contains TodoWrite and CreatePlan.
 *   Both match the write-verb alternation. Neither touches a file. Both
 *   therefore reached tb-guard, which does not recognise the name, which is a
 *   guard failure, which in freeze mode is a DENY. Measured, before the fix:
 *
 *     tool_name TodoWrite   -> exit 2, {"permission":"deny", ... "the freeze
 *                              hook was invoked for tool "TodoWrite", which it
 *                              does not know how to check"}
 *     tool_name CreatePlan  -> exit 2, same
 *
 *   So the moment anybody set a freeze boundary, Cursor's agent could no longer
 *   keep a todo list or write a plan, and the message it got told it the guard
 *   was broken. The comment above used to justify the broad matcher by saying
 *   the cost of over-matching is "one guard run that answers allow". That was
 *   the false premise: this guard does not answer allow to a name it does not
 *   know, it fails closed, by design and correctly. Broad matcher plus
 *   fail-closed guard multiplies into a blocked editor.
 *
 * The matcher therefore excludes exactly these two, by exact name, on evidence
 * from Cursor's own build — not by loosening the guard, which stays exactly as
 * strict as it was.
 */
const NON_FILE_WRITERS = ["TodoWrite", "CreatePlan"];

const WRITE_MATCHER = `^(?!(?:${NON_FILE_WRITERS.join("|")})$).*${WRITE_ALTERNATION}`;

/**
 * Cursor's file-touching tool names, translated into the vocabulary tb-guard
 * speaks (Edit / Write / MultiEdit / NotebookEdit / Update).
 *
 * `Delete` is why this exists. Cursor's DELETE_FILE tool is named "Delete", it
 * carries a path, and deleting a file outside a freeze boundary is precisely
 * what the boundary is for. Before this, it produced:
 *
 *   Delete inside the boundary  -> deny, "the freeze hook was invoked for tool
 *                                  "Delete", which it does not know how to
 *                                  check"   (a wrong block)
 *   Delete outside it           -> deny, the same guard-is-broken text instead
 *                                  of the boundary message  (right answer,
 *                                  wrong and misleading reason)
 *
 * Translating it means the boundary is actually consulted, so a delete inside
 * the boundary proceeds and a delete outside it is refused with the message
 * that names the boundary. This does not widen what is allowed: an unknown name
 * still has to match the write alternation to be translated at all, and a
 * translated call with no resolvable path still fails closed in tb-guard.
 */
const GUARD_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);
const CURSOR_TOOL_ALIASES = { Delete: "Write" };

/**
 * What a preToolUse tool name is, as far as a file-boundary guard is concerned.
 *
 *   "not-a-file-write"  Cursor's own enum says it writes no file. Allow, and
 *                       say which tool and why. Only NON_FILE_WRITERS qualify.
 *   "file-write"        tb-guard already knows this name; pass it through.
 *   "write-like"        we do not know the name, but it carries a write verb,
 *                       so it reached us through the write matcher. Translate
 *                       it so the boundary is checked instead of the guard
 *                       reporting itself broken.
 *   "unrelated"         no write verb at all. Do NOT translate: the hook should
 *                       not have fired, and tb-guard failing closed on it is
 *                       the correct, loud outcome.
 */
export function classifyCursorTool(toolName) {
  const n = String(toolName || "");
  if (!n) return "unrelated";
  if (NON_FILE_WRITERS.includes(n)) return "not-a-file-write";
  if (GUARD_EDIT_TOOLS.has(n)) return "file-write";
  return new RegExp(WRITE_ALTERNATION).test(n) ? "write-like" : "unrelated";
}

/** The name to hand tb-guard for a Cursor tool, or null to pass it through. */
export function guardToolNameFor(toolName) {
  if (classifyCursorTool(toolName) !== "write-like") return null;
  return CURSOR_TOOL_ALIASES[toolName] || "Write";
}

export function matcherFor(cap) {
  return cap === "deny-file-write" ? WRITE_MATCHER : null;
}

// ===========================================================================
// THE RUNTIME ADAPTER — what Cursor actually calls
// ===========================================================================

/**
 * Reshape a Cursor hook payload into the {tool_name, tool_input} shape the
 * guard engine speaks.
 *
 * The three events differ enough that guessing would be a bug:
 *
 *   beforeShellExecution  { command, cwd, sandbox }        — no wrapper at all
 *   preToolUse            { tool_name, tool_input, cwd }   — nearly ours already
 *   beforeMCPExecution    { tool_name, tool_input, url }   — tool_input is a
 *                                                            JSON *string*
 *
 * Returns { ok, value } or { ok:false, error }. An error here is never an
 * allow; the caller fails closed on it.
 */
export function normalizeCursorPayload(payload, modeHint) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "the hook payload was not a JSON object" };
  }
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;

  // beforeShellExecution is recognised by its shape as well as its name,
  // because hook_event_name is documented as present on every event and we
  // still refuse to depend on a single field for a safety decision.
  if (event === "beforeShellExecution" || event === "afterShellExecution" || (!event && typeof payload.command === "string" && payload.tool_input === undefined)) {
    if (typeof payload.command !== "string") {
      return { ok: false, error: `${event || "a shell event"} carried no command string, so there is nothing to check` };
    }
    return { ok: true, value: { tool_name: "Bash", tool_input: { command: payload.command } }, cwd: typeof payload.cwd === "string" ? payload.cwd : null, event: event || "beforeShellExecution" };
  }

  if (event === "beforeMCPExecution") {
    let ti = payload.tool_input;
    if (typeof ti === "string") {
      try {
        ti = JSON.parse(ti);
      } catch (e) {
        return { ok: false, error: `beforeMCPExecution tool_input was a string that is not JSON (${e.message})` };
      }
    }
    if (!ti || typeof ti !== "object") return { ok: false, error: "beforeMCPExecution carried no usable tool_input" };
    return { ok: true, value: { tool_name: payload.tool_name || "mcp", tool_input: ti }, cwd: typeof payload.cwd === "string" ? payload.cwd : null, event };
  }

  // preToolUse, and anything else that already looks like a tool call.
  const ti = payload.tool_input;
  if (ti === undefined) {
    return { ok: false, error: `${event || "this event"} carried no tool_input, so there is nothing for the guard to inspect` };
  }
  if (!ti || typeof ti !== "object" || Array.isArray(ti)) {
    return { ok: false, error: "tool_input is present but is not an object" };
  }

  // Normalise the path key. The guard looks for file_path / filePath / path /
  // notebook_path / notebookPath. Cursor's own docs never name the key its edit
  // tool uses, so the aliases below are a best effort, and — this is the point —
  // when NONE of them is present the guard fails closed and says which keys it
  // looked for. It does not shrug and allow.
  const ALIASES = ["target_file", "targetFile", "file", "filepath", "absolute_path", "absolutePath", "uri", "relative_workspace_path"];
  const normalized = { ...ti };
  if (!["file_path", "filePath", "path", "notebook_path", "notebookPath"].some((k) => typeof normalized[k] === "string" && normalized[k].trim())) {
    const alias = ALIASES.find((k) => typeof ti[k] === "string" && ti[k].trim());
    if (alias) normalized.file_path = ti[alias];
  }
  // Normalise the TOOL NAME, for freeze only.
  //
  // tb-guard speaks Claude Code's vocabulary and must keep speaking it — it is
  // the same engine Claude Code runs and it is not being loosened to suit a
  // second editor. So the translation happens here, in the adapter, where the
  // Cursor-specific knowledge belongs. See classifyCursorTool for why each
  // branch is what it is; the short version is that Cursor's real tool names
  // (Delete, TodoWrite, CreatePlan) turned a broad matcher plus a fail-closed
  // guard into a blocked editor.
  const cursorToolName = payload.tool_name || "unknown";
  let guardName = cursorToolName;
  let notAFileWrite = false;
  if (modeHint === "freeze") {
    const kind = classifyCursorTool(cursorToolName);
    if (kind === "not-a-file-write") notAFileWrite = true;
    else if (kind === "write-like") guardName = guardToolNameFor(cursorToolName);
  }

  // Cursor's Shell tool_input is {command, working_directory}; the guard reads
  // .command, which already matches.
  return {
    ok: true,
    value: { tool_name: guardName, tool_input: normalized },
    cwd: typeof payload.cwd === "string" ? payload.cwd : (typeof ti.working_directory === "string" ? ti.working_directory : null),
    event: event || "preToolUse",
    cursorToolName,
    notAFileWrite,
  };
}

/**
 * Turn the guard engine's answer into Cursor's answer.
 *
 * THIS FUNCTION IS WHERE A FAIL-OPEN WOULD LIVE, so it is written to have no
 * path to "allow" that is not an explicit, parsed, recognised allow from a
 * guard that exited 0. Anything else — a crash, an empty stdout, unparseable
 * JSON, a decision word nobody recognises — is a block.
 *
 * `mode` decides what a block means, matching the guard's own contract:
 * /careful asks (a human overrides), /freeze denies.
 */
export function toCursorDecision({ status, stdout }, mode) {
  const failClosed = (detail) => {
    const strict = process.env.TOOLBAY_GUARD_STRICT === "1";
    const permission = mode === "careful" && !strict ? "ask" : "deny";
    return {
      permission,
      user_message: `[${mode}] The Toolbay Stack guard could not verify this operation, so it is blocked: ${detail}. This guard fails closed on purpose.`,
      agent_message: `The ${mode} guard could not run (${detail}). Do not treat this as approval. Tell the user the guard is broken and run: node .cursor/hooks/tb-cursor.mjs doctor`,
      _reason: "guard-failure",
    };
  };

  if (status !== 0) return failClosed(`the guard engine exited ${status}`);
  const text = String(stdout ?? "").trim();
  if (!text) return failClosed("the guard engine printed nothing");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return failClosed(`the guard engine printed output that is not JSON (${e.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failClosed("the guard engine printed JSON that is not an object");
  }

  // The guard says allow by saying nothing: `{}`.
  const action = parsed.permissionDecision ?? parsed.hookSpecificOutput?.permissionDecision ?? (Object.keys(parsed).length === 0 ? "allow" : null);
  if (action === null) return failClosed("the guard engine's output carried no decision");

  const reason = parsed.message ?? parsed.hookSpecificOutput?.permissionDecisionReason ?? parsed.reason ?? "";

  if (action === "allow") return { permission: "allow", _reason: "guard-allow" };
  if (action === "ask") return { permission: "ask", user_message: reason, agent_message: reason, _reason: "guard-ask" };
  if (action === "deny") return { permission: "deny", user_message: reason, agent_message: reason, _reason: "guard-deny" };
  return failClosed(`the guard engine returned an unrecognised decision "${String(action).slice(0, 40)}"`);
}

// ---------------------------------------------------------------- state files

function stateDir() {
  return process.env.TOOLBAY_STACK_STATE_DIR || path.join(os.homedir(), ".toolbay-stack");
}
function observedFile() {
  return path.join(stateDir(), "cursor-observed.json");
}

/**
 * The observation ledger: the only thing in this file that can move a claim
 * from "documented" to "observed".
 *
 * Every time Cursor really calls the adapter, this records the event name, the
 * tool name Cursor used, and Cursor's version. `doctor` reads it and reports
 * UNPROVEN when it is empty. Bookkeeping must never change a safety decision,
 * so the whole thing is wrapped and a failure is swallowed on purpose.
 */
export function recordObservation(payload, event, decision) {
  // A HARNESS MUST NOT MANUFACTURE ITS OWN EVIDENCE.
  //
  // This line is here because the selftest caught the absence of it. `doctor`
  // proves the adapter works by feeding it real Cursor payload shapes — and
  // those runs went straight into the ledger, so doctor then read the ledger
  // back and cheerfully reported "YES — OBSERVED. Cursor has fired these
  // hooks", on a machine where Cursor had never once called anything. It was
  // quoting itself and calling it proof.
  //
  // That is exactly the failure this whole package exists to remove, committed
  // by the tool whose job is to detect it. The ledger's single purpose is to
  // answer "has the real editor ever called us", so only the real editor may
  // write to it. doctor sets this variable on every probe it spawns.
  if (process.env.TOOLBAY_CURSOR_SIMULATED === "1") return;
  try {
    const f = observedFile();
    let db = {};
    try {
      db = JSON.parse(fs.readFileSync(f, "utf8")) || {};
    } catch {
      db = {};
    }
    if (typeof db !== "object" || Array.isArray(db)) db = {};
    const now = new Date().toISOString();
    db.firstSeen = db.firstSeen || now;
    db.lastSeen = now;
    if (typeof payload?.cursor_version === "string") db.cursorVersion = payload.cursor_version;
    db.events = db.events && typeof db.events === "object" ? db.events : {};
    const e = (db.events[event] = db.events[event] && typeof db.events[event] === "object" ? db.events[event] : { count: 0 });
    e.count = (Number(e.count) || 0) + 1;
    e.lastSeen = now;
    db.toolNames = db.toolNames && typeof db.toolNames === "object" ? db.toolNames : {};
    const tn = payload?.tool_name;
    // Bounded: a ledger that grows without limit is a bug waiting on a long
    // session, and 64 distinct tool names is already far more than any editor has.
    if (typeof tn === "string" && tn && (db.toolNames[tn] !== undefined || Object.keys(db.toolNames).length < 64)) {
      db.toolNames[tn] = (Number(db.toolNames[tn]) || 0) + 1;
    }
    db.decisions = db.decisions && typeof db.decisions === "object" ? db.decisions : {};
    const d = decision?.permission || "unknown";
    db.decisions[d] = (Number(db.decisions[d]) || 0) + 1;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  } catch {
    /* never let bookkeeping change a safety decision */
  }
}

export function observations() {
  try {
    const db = JSON.parse(fs.readFileSync(observedFile(), "utf8"));
    if (!db || typeof db !== "object" || Array.isArray(db)) return null;
    return db;
  } catch {
    return null;
  }
}

/**
 * Does the write matcher we installed actually cover the tool names Cursor has
 * been seen using. This is the question nobody can answer from documentation,
 * and the ledger can.
 */
export function matcherCoverage(db, matcher = WRITE_MATCHER) {
  if (!db || !db.toolNames) return { known: false };
  let re;
  try {
    re = new RegExp(matcher);
  } catch {
    return { known: true, broken: true, matched: [], unmatched: Object.keys(db.toolNames) };
  }
  const names = Object.keys(db.toolNames);
  return {
    known: names.length > 0,
    broken: false,
    matched: names.filter((n) => re.test(n)),
    unmatched: names.filter((n) => !re.test(n)),
  };
}

// ------------------------------------------------------------- stdin plumbing

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

/**
 * Write the decision and exit.
 *
 * A deny is signalled BOTH ways: the JSON says deny and the exit code is 2,
 * which Cursor documents as "block the action, same as returning deny". Saying
 * it twice costs nothing and there is a live report of a malformed response
 * failing open, so a second, cruder channel that Cursor reads earlier is worth
 * having. `ask` and `allow` have no exit-code equivalent and exit 0.
 */
function emitAndExit(decision) {
  const { _reason, ...wire } = decision;
  process.stdout.write(`${JSON.stringify(wire)}\n`);
  process.exit(decision.permission === "deny" ? 2 : 0);
}

/** The runtime hook. Cursor pipes JSON in; this pipes a decision back. */
async function cmdHook(mode, guardPath) {
  // One way to fail, and it is the same one toCursorDecision uses: an adapter
  // that invented its own softer failure path would be the hole this file is
  // about. `stdout: ""` is the canonical "the guard said nothing" input, and
  // the detail is swapped in so the user hears the real reason.
  const failClosed = (detail) => {
    const d = toCursorDecision({ status: 0, stdout: "" }, mode);
    return {
      ...d,
      user_message: `[${mode}] The Toolbay Stack guard could not verify this operation, so it is blocked: ${detail}. This guard fails closed on purpose.`,
      agent_message: `The ${mode} guard could not run (${detail}). Do not treat this as approval. Tell the user the guard is broken and run: node .cursor/hooks/tb-cursor.mjs doctor`,
    };
  };

  if (mode !== "careful" && mode !== "freeze") {
    // An unknown mode is not something to guess at. Deny outright: a hook wired
    // to a mode this adapter does not implement is a misconfiguration, and the
    // safe reading of a misconfigured guard is "stop".
    emitAndExit({
      permission: "deny",
      user_message: `[toolbay] The Cursor hook adapter was invoked with an unknown guard mode "${mode}", so it is blocking rather than guessing.`,
      agent_message: `tb-cursor.mjs hook was given mode "${mode}"; only careful and freeze exist. Fix .cursor/hooks.json.`,
    });
  }

  const raw = await readStdin();
  if (!raw.ok) emitAndExit(failClosed(raw.error));

  let payload;
  try {
    payload = JSON.parse(String(raw.data).trim() || "null");
  } catch (e) {
    emitAndExit(failClosed(`the hook payload is not valid JSON (${e.message})`));
  }

  const norm = normalizeCursorPayload(payload, mode);
  if (!norm.ok) {
    const d = failClosed(norm.error);
    recordObservation(payload, payload?.hook_event_name || "unknown", d);
    emitAndExit(d);
  }

  // The ONE allow this adapter issues without asking the guard, and the reason
  // it is not a fail-open.
  //
  // A fail-open is answering "allow" when we could not establish an answer.
  // This is the opposite: Cursor's own tool enum establishes that TodoWrite and
  // CreatePlan write no file, so a file-boundary guard has nothing to say about
  // them and the honest answer is that they are out of its scope. The
  // alternative was measured and it is not neutral — tb-guard denies a name it
  // does not know, so leaving this out blocked the agent's todo list and plan
  // tool and told the user the guard was broken.
  //
  // It is deliberately narrow: exact names, freeze only, and the matcher should
  // already have kept them away (Cursor's matcher fails OPEN into match-all, so
  // "should" is not "will", which is why the check is here too).
  if (norm.notAFileWrite) {
    const d = {
      permission: "allow",
      _reason: "not-a-file-write",
    };
    recordObservation(payload, norm.event, d);
    emitAndExit(d);
  }

  const engine = guardPath || defaultGuardPath();
  if (!engine || !fs.existsSync(engine)) {
    const d = failClosed(`the guard engine is not at ${engine || "(no path given)"}`);
    recordObservation(payload, norm.event, d);
    emitAndExit(d);
  }

  const res = spawnSync(process.execPath, [engine, mode], {
    input: JSON.stringify(norm.value),
    encoding: "utf8",
    // The guard's own stdin wait is 5s; give it room and still bound it, because
    // a hook that hangs is a frozen editor and users kill frozen editors.
    timeout: 20000,
    killSignal: "SIGKILL",
    windowsHide: true,
    cwd: norm.cwd && fs.existsSync(norm.cwd) ? norm.cwd : process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
  });

  let decision;
  if (res.error || res.status === null) {
    decision = failClosed(`the guard engine could not be run (${res.error?.code || "killed or timed out"})`);
  } else {
    decision = toCursorDecision({ status: res.status, stdout: res.stdout }, mode);
  }
  recordObservation(payload, norm.event, decision);
  emitAndExit(decision);
}

function defaultGuardPath() {
  // Installed layout: .cursor/hooks/tb-cursor.mjs beside .cursor/skills/<x>/scripts/tb-guard.mjs
  const hooksDir = path.dirname(SELF);
  const cursorDir = path.dirname(hooksDir);
  for (const skill of ["guard", "careful", "freeze", "investigate"]) {
    const p = path.join(cursorDir, "skills", skill, "scripts", "tb-guard.mjs");
    if (fs.existsSync(p)) return p;
  }
  // Running from the repo.
  const repo = path.resolve(path.dirname(SELF), "..", "guard", "tb-guard.mjs");
  return fs.existsSync(repo) ? repo : null;
}

// ===========================================================================
// INSTALL
// ===========================================================================

/** Is Cursor actually on this machine, and how do we know. */
export function findCursor() {
  const override = process.env.TOOLBAY_CURSOR_HOME;
  if (override) {
    return fs.existsSync(override)
      ? { found: true, home: override, how: "TOOLBAY_CURSOR_HOME" }
      : { found: false, why: `TOOLBAY_CURSOR_HOME points at ${override}, which does not exist` };
  }
  const home = path.join(os.homedir(), ".cursor");
  if (fs.existsSync(home)) {
    let version = null;
    for (const p of [
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "cursor", "resources", "app", "package.json"),
      "/Applications/Cursor.app/Contents/Resources/app/package.json",
      path.join(os.homedir(), ".local", "share", "cursor", "resources", "app", "package.json"),
    ]) {
      try {
        version = JSON.parse(fs.readFileSync(p, "utf8")).version;
        break;
      } catch {
        /* keep looking */
      }
    }
    return { found: true, home, how: "~/.cursor exists", version };
  }
  return { found: false, why: `no ~/.cursor directory at ${home}, so Cursor has never run on this machine` };
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
}

/**
 * Merge our entries into an existing hooks.json without destroying anybody
 * else's. Ours are tagged, so an upgrade replaces exactly our rows and leaves
 * the user's own hooks alone.
 */
export function mergeHooks(existing, ours) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const version = base.version === 1 ? 1 : 1;
  const hooks = base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks) ? { ...base.hooks } : {};
  // Drop every previous entry of ours, wherever it lives.
  for (const ev of Object.keys(hooks)) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev].filter((h) => !(h && h.toolbayStack)) : [];
    if (list.length) hooks[ev] = list;
    else delete hooks[ev];
  }
  for (const [ev, entries] of Object.entries(ours)) {
    hooks[ev] = [...(Array.isArray(hooks[ev]) ? hooks[ev] : []), ...entries];
  }
  return { ...base, version, hooks };
}

/**
 * Read a written hooks.json back and prove it says what we meant.
 *
 * Every one of these is a way a guard can be present and inert, which is the
 * failure this package exists to remove:
 *   - failClosed missing  -> a crashed hook fails OPEN, per Cursor's own docs
 *   - command script gone -> the hook never runs
 *   - matcher won't compile -> Cursor cannot load the entry
 */
/**
 * Two of our entries on the same event running the same guard mode.
 *
 * The Claude Code installer already warns about this and the Cursor one did not
 * until a real install of `freeze` + `investigate` produced two identical
 * preToolUse entries. Both fire on the same edit, so one edit outside the
 * boundary asks twice — and a safety prompt that appears twice for one action is
 * a prompt people learn to dismiss, which is the exact behaviour the guard
 * exists to prevent. The redundancy does not waste a keystroke, it converts the
 * feature into its own failure mode.
 *
 * This warns rather than refusing, because `install` with no names is the
 * documented path and it is the path that produces the collision.
 */
/**
 * Fold duplicate (event, mode) entries down to one, and report what was folded.
 *
 * The old behaviour was to warn and install all of them. That warning was
 * correct about the consequence and too weak about it, because the consequence
 * is the default: `install --cursor` with no skill names installs careful,
 * freeze, guard and investigate, and guard carries both halves while
 * investigate carries the freeze half. Driving the installed hooks.json with a
 * real Cursor preToolUse payload for an edit outside the boundary produced,
 * before this fix, THREE identical deny responses for one edit — freeze, guard
 * and investigate, all running byte-identical copies of the same engine against
 * the same boundary file, all answering the same thing.
 *
 * A safety prompt that appears three times for one action is a prompt people
 * learn to dismiss, so the redundancy does not cost a keystroke, it converts
 * the feature into its own failure mode. Nothing is lost by folding: the
 * entries differ only in which skill's copy of tb-guard.mjs they invoke, the
 * copies are identical, and the freeze boundary they read is one shared file.
 */
export function dedupeCursorHooks(hookEntries) {
  const kept = {};
  const folded = [];
  for (const [event, entries] of Object.entries(hookEntries)) {
    const seen = new Map();
    for (const h of entries) {
      const mode = h.toolbayStack?.mode;
      const key = `${event} -> ${mode}`;
      if (seen.has(key)) {
        folded.push({ event, mode, dropped: h.toolbayStack?.skill, keptFor: seen.get(key) });
        continue;
      }
      seen.set(key, h.toolbayStack?.skill);
      (kept[event] = kept[event] || []).push(h);
    }
  }
  return { entries: kept, folded };
}

export function conflictingCursorHooks(hookEntries) {
  const byPair = new Map();
  for (const [event, entries] of Object.entries(hookEntries)) {
    for (const h of entries) {
      const key = `${event} -> ${h.toolbayStack.mode}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(h.toolbayStack.skill);
    }
  }
  return [...byPair.entries()].filter(([, skills]) => skills.length > 1).map(([pair, skills]) => ({ pair, skills }));
}

export function verifyHooksFile(cfg, root) {
  const problems = [];
  if (!cfg || typeof cfg !== "object") return ["hooks.json is not a JSON object"];
  if (cfg.version !== 1) problems.push(`hooks.json version is ${JSON.stringify(cfg.version)}, not 1`);
  const hooks = cfg.hooks || {};
  let ours = 0;
  for (const [ev, entries] of Object.entries(hooks)) {
    for (const h of Array.isArray(entries) ? entries : []) {
      if (!h || !h.toolbayStack) continue;
      ours += 1;
      if (h.failClosed !== true) {
        problems.push(`${ev}: our entry does not set failClosed:true, so a crashed guard would fail OPEN in Cursor`);
      }
      const scriptMatch = /"([^"]+\.mjs)"/.exec(h.command || "");
      if (!scriptMatch) problems.push(`${ev}: our entry's command does not name a script`);
      else if (!fs.existsSync(scriptMatch[1])) problems.push(`${ev}: the hook command points at ${scriptMatch[1]}, which does not exist, so the hook would never fire`);
      const guardMatch = /--guard\s+"([^"]+)"/.exec(h.command || "");
      if (guardMatch && !fs.existsSync(guardMatch[1])) problems.push(`${ev}: the guard engine ${guardMatch[1]} does not exist, so the hook would run and check nothing`);
      if (h.matcher !== undefined && h.matcher !== null) {
        try {
          new RegExp(h.matcher);
        } catch (e) {
          problems.push(`${ev}: the matcher is not a valid regular expression (${e.message}), so Cursor cannot load this entry`);
        }
      }
    }
  }
  if (ours === 0) problems.push("hooks.json contains no Toolbay Stack entries at all");
  return problems;
}

function cmdInstall(names, flags) {
  const cursor = findCursor();
  if (!cursor.found && !flags.allowMissingCursor) {
    out();
    out(`  ${red("x")} ${bold("Cursor is not installed on this machine.")}`);
    out(dim(`      ${cursor.why}`));
    out();
    out("  Refusing rather than writing .cursor/ into your project, because an install");
    out("  that cannot be checked against the editor it targets is a claim, not an install.");
    out(`  If you are setting this up for teammates who do have Cursor, pass ${cyan("--allow-missing-cursor")}`);
    out("  and the install will say UNVERIFIED everywhere instead of implying it works.");
    out();
    return 1;
  }

  const skillsSrc = flags.skillsSrc || path.resolve(path.dirname(SELF), "..", "..", "skills");
  if (!fs.existsSync(skillsSrc)) {
    out(red(`\n  No skills directory at ${skillsSrc}\n`));
    return 1;
  }

  const root = flags.global ? path.join(os.homedir(), ".cursor") : path.join(path.resolve(flags.project || process.cwd()), ".cursor");
  const all = fs
    .readdirSync(skillsSrc)
    .filter((n) => fs.existsSync(path.join(skillsSrc, n, "SKILL.md")))
    .sort();
  const chosen = names.length ? all.filter((n) => names.includes(n)) : all;

  if (names.length && chosen.length !== names.length) {
    const missing = names.filter((n) => !all.includes(n));
    out(`\n  ${yellow("?")} No skill named ${bold(missing.join(", "))}.\n`);
    return 1;
  }

  const installed = [];
  const refused = [];
  const hookEntries = {};

  const hooksDir = path.join(root, "hooks");
  const adapterPath = path.join(hooksDir, "tb-cursor.mjs");

  for (const name of chosen) {
    const md = fs.readFileSync(path.join(skillsSrc, name, "SKILL.md"), "utf8");
    const plan = planSkill(name, md);

    if (!plan.ok) {
      // THE REFUSAL THAT MATTERS. Not a warning, not a partial install: the
      // skill does not go in. Installing the documentation for a guard Cursor
      // cannot run would leave a user reading "fails closed, blocks the edit"
      // in an editor where nothing blocks anything.
      refused.push({ name, refusals: plan.refusals });
      continue;
    }

    const target = path.join(root, "skills", name);
    if (fs.existsSync(path.join(target, "SKILL.md")) && !flags.force) {
      installed.push({ name, skipped: true, plan });
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    copyTree(path.join(skillsSrc, name), target);

    // The installed SKILL.md tells the truth about this editor.
    const cursorMd = retargetClaudePaths(stripHooksFrontmatter(md), { global: flags.global });
    const { fm, body } = splitFrontmatter(cursorMd);
    const withBanner = fm !== null ? `---\n${fm}\n---\n${enforcementBanner(plan)}${body}` : `${enforcementBanner(plan)}${cursorMd}`;
    fs.writeFileSync(path.join(target, "SKILL.md"), withBanner, "utf8");

    for (const h of plan.hooks) {
      const guard = path.join(target, "scripts", h.engine).split(path.sep).join("/");
      if (!fs.existsSync(guard)) {
        refused.push({ name, refusals: [{ matcher: h.matcher, capability: h.capability, why: `the skill registers a guard on ${h.engine} but that engine is not in the package, so the hook would never fire` }] });
        fs.rmSync(target, { recursive: true, force: true });
        installed.pop();
        break;
      }
      const entry = {
        command: `node "${adapterPath.split(path.sep).join("/")}" hook ${h.mode} --guard "${guard}"`,
        // Cursor's default is failClosed:false, which means a guard that
        // crashes ALLOWS the action. That default is the exact bug this package
        // was forked over, so it is set on every entry and verified after.
        failClosed: true,
        timeout: 30,
        toolbayStack: { skill: name, mode: h.mode, capability: h.capability, version: VERSION },
      };
      const m = matcherFor(h.capability);
      if (m) entry.matcher = m;
      (hookEntries[h.event] = hookEntries[h.event] || []).push(entry);
    }
    if (!installed.some((i) => i.name === name)) installed.push({ name, skipped: false, plan });
  }

  // The adapter itself, copied in so the install is self-contained.
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(adapterPath, fs.readFileSync(SELF));

  const hooksFile = path.join(root, "hooks.json");
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {
    existing = null;
  }
  const { entries: dedupedEntries, folded } = dedupeCursorHooks(hookEntries);
  const merged = mergeHooks(existing, dedupedEntries);
  const hasHooks = Object.keys(dedupedEntries).length > 0;
  if (hasHooks) fs.writeFileSync(hooksFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  // ---- verify what we just wrote, rather than trusting that we wrote it
  let hookProblems = [];
  if (hasHooks) {
    let readBack = null;
    try {
      readBack = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    } catch (e) {
      hookProblems = [`hooks.json could not be read back after writing it (${e.message})`];
    }
    if (readBack) hookProblems = verifyHooksFile(readBack, root);
  }

  // ---- report
  out();
  out(bold(`  Toolbay Stack -> Cursor  ${dim(`v${VERSION}`)}`));
  out(dim(`  ${root}`));
  if (cursor.found) out(dim(`  Cursor detected: ${cursor.how}${cursor.version ? ` (v${cursor.version})` : ""}`));
  else out(yellow(`  Cursor NOT detected — installed anyway because --allow-missing-cursor was passed. Nothing below is verified.`));
  out();

  const fresh = installed.filter((i) => !i.skipped);
  const skipped = installed.filter((i) => i.skipped);
  out(`  ${green(String(fresh.length))} skills installed into ${dim(".cursor/skills/")}${skipped.length ? dim(`, ${skipped.length} already there (--force to overwrite)`) : ""}`);
  const guarded = fresh.filter((i) => i.plan.hooks.length);
  const foldedKeys = new Set(folded.map((f) => `${f.dropped}:${f.event}:${f.mode}`));
  for (const g of guarded) {
    for (const h of g.plan.hooks) {
      if (foldedKeys.has(`${g.name}:${h.event}:${h.mode}`)) {
        out(`    ${dim("·")} ${dim(`${g.name}  ->  ${h.event}  folded into an identical guard already registered (see below)`)}`);
        continue;
      }
      out(`    ${green("+")} ${bold(g.name)}  ${dim("->")} ${cyan(h.event)}  ${dim(`failClosed:true${h.matcher ? "" : "  (no matcher: every call reaches the guard)"}`)}`);
    }
  }
  out();

  if (refused.length) {
    out(`  ${red(bold("REFUSED — Cursor cannot enforce these, so they were not installed:"))}`);
    for (const r of refused) {
      out(`    ${red("x")} ${bold(r.name)}`);
      for (const x of r.refusals) out(dim(`        ${x.matcher ? `matcher ${x.matcher}: ` : ""}${x.why}`));
    }
    out();
    out(dim("    This is on purpose. A skill whose guard cannot fire in this editor would"));
    out(dim("    install cleanly, read as protection, and check nothing. Not installing it"));
    out(dim("    is the honest outcome, and it is the failure this whole package is about."));
    out();
  }

  if (hookProblems.length) {
    out(`  ${red(bold("The hooks file did not verify:"))}`);
    for (const p of hookProblems) out(red(`    - ${p}`));
    out();
    out(dim("    The guards are NOT active. Fix the above or uninstall; do not rely on them."));
    out();
    return 1;
  }

  if (hasHooks) {
    out(`  ${green("ok")}  hooks.json verified: every entry sets failClosed:true, names a script that exists,`);
    out(`      and carries a matcher that compiles.`);
    out();
  }

  if (folded.length) {
    out(`  ${green("ok")}  ${bold("Folded duplicate guards so one action prompts once.")}`);
    for (const f of folded) out(dim(`      ${`${f.event} -> ${f.mode}`.padEnd(30)} kept ${f.keptFor}, dropped the identical copy from ${f.dropped}`));
    out();
    out(dim("    /guard is /careful + /freeze in one skill and /investigate carries the freeze"));
    out(dim("    half too, all running byte-identical copies of the same engine against the same"));
    out(dim("    boundary. Left alone that is three deny prompts for one edit, which is how"));
    out(dim("    people learn to click through a safety warning — the exact failure the guard"));
    out(dim("    exists to prevent. All the skills are still installed; only the redundant hook"));
    out(dim("    registrations were dropped, so nothing is unguarded."));
    out();
  }

  // ---- the part that refuses to overclaim
  out(bold("  What is proven, and what is not"));
  out();
  out(`  ${green("Proven here")}   the hook contract is read out of the Cursor build on this machine,`);
  out(`                 not just its docs: exit code 2 blocks, permission is validated`);
  out(`                 against allow/deny/ask, and matchers are an unanchored regex test`);
  out(`                 against the tool name. The files exist, the matcher compiles, and`);
  out(`                 the guard answers correctly when fed real Cursor payloads using`);
  out(`                 Cursor's own tool names. Check that yourself:`);
  out(`                   ${cyan(`node "${adapterPath.split(path.sep).join("/")}" doctor`)}`);
  out();
  out(`  ${yellow("NOT proven")}    that Cursor actually calls these hooks in your build. Nothing on`);
  out(`                 this machine can prove that without Cursor running an agent turn.`);
  out(`                 So it is MEASURED instead: use Cursor normally for a minute, then`);
  out(`                 run doctor again. It reports OBSERVED once the hooks have really`);
  out(`                 fired, and names the tool names Cursor sent.`);
  out();
  if (guarded.some((g) => g.plan.hooks.some((h) => h.capability === "deny-file-write"))) {
    out(`  ${red("NOT COVERED")}   Cursor's Tab autocomplete writes files on a path no hook can`);
    out(`                 refuse (its only edit event fires after the write), so a freeze`);
    out(`                 boundary does NOT hold against Tab. Nor against files written by`);
    out(`                 a shell command, which are judged as commands, nor against your`);
    out(`                 own typing. Every installed SKILL.md says so at the top.`);
    out();
  }
  out(`  ${yellow("Out of scope")}  the Cursor CLI (\`cursor-agent\`). Its docs describe rules,`);
  out(`                 AGENTS.md and mcp.json as shared with the editor and say nothing`);
  out(`                 about hooks; there is an open feature request asking for them.`);
  out(`                 Assume terminal sessions are UNGUARDED until you prove otherwise.`);
  out();
  out(dim("  Hooks are beta in Cursor. Restart Cursor if they do not load; it watches"));
  out(dim("  hooks.json and reloads on save, but a fresh install is worth a restart."));
  out();
  return 0;
}

function cmdUninstall(flags) {
  const root = flags.global ? path.join(os.homedir(), ".cursor") : path.join(path.resolve(flags.project || process.cwd()), ".cursor");
  const hooksFile = path.join(root, "hooks.json");
  let removed = 0;
  try {
    const cfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    const merged = mergeHooks(cfg, {});
    for (const entries of Object.values(cfg.hooks || {})) for (const h of entries || []) if (h && h.toolbayStack) removed += 1;
    if (Object.keys(merged.hooks || {}).length) fs.writeFileSync(hooksFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    else fs.rmSync(hooksFile, { force: true });
  } catch {
    /* nothing to clean */
  }
  const skillsRoot = path.join(root, "skills");
  let skills = 0;
  const srcSkills = path.resolve(path.dirname(SELF), "..", "..", "skills");
  const ours = fs.existsSync(srcSkills) ? new Set(fs.readdirSync(srcSkills)) : new Set();
  if (fs.existsSync(skillsRoot)) {
    for (const n of fs.readdirSync(skillsRoot)) {
      if (!ours.has(n)) continue;
      fs.rmSync(path.join(skillsRoot, n), { recursive: true, force: true });
      skills += 1;
    }
  }
  fs.rmSync(path.join(root, "hooks", "tb-cursor.mjs"), { force: true });
  out(`\n  ${green("-")} Removed ${skills} skills and ${removed} hook entries from ${dim(root)}\n`);
  return 0;
}

// ===========================================================================
// STATUS AND DOCTOR
// ===========================================================================

function cmdStatus(flags) {
  const root = flags.global ? path.join(os.homedir(), ".cursor") : path.join(path.resolve(flags.project || process.cwd()), ".cursor");
  const cursor = findCursor();
  out();
  out(bold("  Toolbay Stack in Cursor"));
  out(dim(`  ${root}`));
  out();
  out(`  Cursor          ${cursor.found ? green(`present${cursor.version ? ` v${cursor.version}` : ""}`) : red("not found")}`);
  const skillsRoot = path.join(root, "skills");
  const n = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot).filter((d) => fs.existsSync(path.join(skillsRoot, d, "SKILL.md"))).length : 0;
  out(`  Skills          ${n ? green(String(n)) : dim("none")}`);
  let problems = ["hooks.json is not there"];
  try {
    problems = verifyHooksFile(JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8")), root);
  } catch {
    /* keep the default */
  }
  out(`  Guards wired    ${problems.length ? red(problems[0]) : green("yes, failClosed:true, verified")}`);
  const db = observations();
  out(`  Guards observed ${db ? green(`yes, last ${db.lastSeen}`) : yellow("NEVER — configured but unproven")}`);
  out();
  if (problems.length || !db) out(dim(`  Run  node "${path.join(root, "hooks", "tb-cursor.mjs").split(path.sep).join("/")}" doctor\n`));
  return problems.length ? 1 : 0;
}

/**
 * Doctor: feed the installed adapter real Cursor payloads and print what it
 * really answered, then say plainly what remains unproven.
 *
 * This is the difference between "we wrote a config file" and "we know what
 * happens when Cursor calls it". Everything here is executed, not asserted.
 */
function cmdDoctor(flags) {
  const root = flags.global ? path.join(os.homedir(), ".cursor") : path.join(path.resolve(flags.project || process.cwd()), ".cursor");
  const adapter = fs.existsSync(path.join(root, "hooks", "tb-cursor.mjs")) ? path.join(root, "hooks", "tb-cursor.mjs") : SELF;
  const guard = defaultGuardPathFrom(root);

  out();
  out(bold("  Toolbay Stack Cursor doctor"));
  out(dim(`  adapter ${adapter}`));
  out(dim(`  guard   ${guard || "(not found)"}`));
  out();

  const rows = [];
  const probe = (label, mode, payload) => {
    if (!guard) {
      rows.push({ label, got: "n/a", ok: false, note: "no guard engine found" });
      return;
    }
    const r = spawnSync(process.execPath, [adapter, "hook", mode, "--guard", guard], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      // TOOLBAY_CURSOR_SIMULATED keeps these probes OUT of the observation
      // ledger. Without it doctor writes the evidence it then reads back and
      // reports as proof that Cursor called us. See recordObservation.
      env: { ...process.env, NO_COLOR: "1", TOOLBAY_CURSOR_SIMULATED: "1" },
    });
    let permission = "(unparseable)";
    try {
      permission = JSON.parse((r.stdout || "").trim()).permission;
    } catch {
      /* leave it */
    }
    rows.push({ label, got: permission, exit: r.status, ok: true });
  };

  probe("beforeShellExecution  rm -rf /var/data", "careful", {
    hook_event_name: "beforeShellExecution",
    command: "rm -rf /var/data",
    cwd: process.cwd(),
  });
  probe("beforeShellExecution  ls -la", "careful", {
    hook_event_name: "beforeShellExecution",
    command: "ls -la",
    cwd: process.cwd(),
  });
  probe("preToolUse  Write outside the boundary", "freeze", {
    hook_event_name: "preToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(os.tmpdir(), "definitely-outside-any-boundary.txt") },
    cwd: process.cwd(),
  });
  // Cursor's OWN tool names, from its tool enum, rather than Claude Code's.
  // These are the ones that turned a broad matcher into a blocked editor, so
  // they are probed by name and their answers are worth reading.
  probe("preToolUse  Edit (Cursor's edit tool name)", "freeze", {
    hook_event_name: "preToolUse",
    tool_name: "Edit",
    tool_input: { path: path.join(os.tmpdir(), "definitely-outside-any-boundary.txt") },
    cwd: process.cwd(),
  });
  probe("preToolUse  TodoWrite (writes no file)", "freeze", {
    hook_event_name: "preToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos: [] },
    cwd: process.cwd(),
  });
  probe("preToolUse  CreatePlan (writes no file)", "freeze", {
    hook_event_name: "preToolUse",
    tool_name: "CreatePlan",
    tool_input: { plan: "x" },
    cwd: process.cwd(),
  });

  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    out(`  ${r.got === "deny" || r.got === "ask" ? yellow(String(r.got).padEnd(6)) : r.got === "allow" ? green("allow ") : red(String(r.got).padEnd(6))}  ${r.label.padEnd(w)}  ${dim(`exit ${r.exit}`)}`);
  }
  out();
  out(dim("  Those are real runs of the installed adapter against real Cursor payload"));
  out(dim("  shapes, using Cursor's own tool names. They prove the adapter and the guard"));
  out(dim("  work. They do NOT prove Cursor calls them."));
  out();
  // Without this line the freeze rows read as a broken guard. /freeze allows
  // everything until a boundary is deliberately set — that is the contract, not
  // a failure — and a doctor that prints "allow" beside "outside the boundary"
  // with no explanation teaches the user to distrust a correct answer.
  let boundary = null;
  try {
    boundary = JSON.parse(fs.readFileSync(path.join(stateDir(), "freeze.json"), "utf8")).dir;
  } catch {
    boundary = null;
  }
  if (boundary) {
    out(dim(`  The freeze rows were judged against the boundary now set: ${boundary}`));
  } else {
    out(`  ${yellow("!")} ${bold("No freeze boundary is set")}, so every freeze row above is expected to say`);
    out(`      allow — /freeze permits everything until you deliberately scope it. To see it`);
    out(`      actually deny, set a boundary and run doctor again:`);
    out(`        ${cyan(`node "${(guard || "").split(path.sep).join("/")}" freeze --set <dir>`)}`);
  }
  out();
  out(bold("  What these guards do NOT cover in Cursor"));
  out();
  for (const [name, row] of Object.entries(CAPABILITIES)) {
    if (row.supported) continue;
    out(`  ${red("NO")}  ${row.summary}`);
    out(dim(`      ${name}`));
  }
  out();
  out(dim("  Tab autocomplete in particular writes files on a path no hook can refuse, so"));
  out(dim("  a freeze boundary does not hold against it. Turn Tab off if it has to."));
  out();

  const db = observations();
  out(bold("  Has Cursor actually fired these hooks?"));
  out();
  if (!db) {
    out(`  ${yellow(bold("NO — UNPROVEN."))} The observation ledger at`);
    out(dim(`  ${observedFile()}`));
    out(`  is empty, which means nothing has ever invoked this adapter from Cursor.`);
    out();
    out("  To find out, in 30 seconds:");
    out(`    1. open this project in Cursor`);
    out(`    2. ask the agent to run a shell command, and to edit a file`);
    out(`    3. run this doctor again`);
    out();
    out(dim("  Until then, treat these guards as configured and unproven. Do not tell"));
    out(dim("  anyone they are protected."));
  } else {
    out(`  ${green(bold("YES — OBSERVED."))}  first ${db.firstSeen}, last ${db.lastSeen}${db.cursorVersion ? `, Cursor ${db.cursorVersion}` : ""}`);
    for (const [ev, e] of Object.entries(db.events || {})) out(`    ${cyan(ev.padEnd(24))} ${e.count} call${e.count === 1 ? "" : "s"}  ${dim(e.lastSeen)}`);
    out();
    const cov = matcherCoverage(db);
    if (cov.known) {
      out(`  Tool names Cursor really sent: ${Object.keys(db.toolNames).join(", ")}`);
      if (cov.unmatched.length) {
        out(`  ${yellow("!")} The write matcher does NOT cover: ${bold(cov.unmatched.join(", "))}`);
        out(dim("    Any of those that write files are UNGUARDED. This is the failure mode"));
        out(dim("    documentation cannot rule out, which is why it is measured here."));
      } else {
        out(`  ${green("ok")} the write matcher covers every tool name observed.`);
      }
    }
  }
  out();
  return 0;
}

function defaultGuardPathFrom(root) {
  for (const skill of ["guard", "careful", "freeze", "investigate"]) {
    const p = path.join(root, "skills", skill, "scripts", "tb-guard.mjs");
    if (fs.existsSync(p)) return p;
  }
  const repo = path.resolve(path.dirname(SELF), "..", "guard", "tb-guard.mjs");
  return fs.existsSync(repo) ? repo : null;
}

function cmdCapabilities(json) {
  if (json) {
    out(JSON.stringify(CAPABILITIES, null, 2));
    return 0;
  }
  out();
  out(bold("  What Cursor can and cannot enforce"));
  out(dim("  Every row cites where the claim came from, and how strong that source is:"));
  out(dim("    documented   Cursor's docs or bundled skills say so; not watched happening"));
  out(dim("    implemented  we read the code that does it, inside the Cursor build here"));
  out(dim("    observed     we have seen it happen — only the ledger can grant this"));
  out(dim("    absent       we looked and there is no such surface"));
  out(dim("    unproven     the surface exists; that it carries a guard does not follow"));
  out();
  for (const [name, row] of Object.entries(CAPABILITIES)) {
    out(`  ${row.supported ? green("YES") : red("NO ")}  ${bold(name.padEnd(22))} ${dim(row.confidence)}`);
    out(`       ${row.summary}`);
    if (row.event) out(`       ${cyan(`event: ${row.event}`)}  ${dim(row.payloadShape || "")}`);
    for (const line of wrap(row.evidence || row.why, 84)) out(dim(`       ${line}`));
    if (row.caveat) for (const line of wrap(`CAVEAT: ${row.caveat}`, 84)) out(yellow(`       ${line}`));
    if (row.correction) for (const line of wrap(`CORRECTION: ${row.correction}`, 84)) out(yellow(`       ${line}`));
    out();
  }
  return 0;
}

function wrap(s, n) {
  const words = String(s || "").split(/\s+/);
  const lines = [];
  let cur = "";
  for (const word of words) {
    if ((cur + " " + word).trim().length > n) {
      lines.push(cur.trim());
      cur = word;
    } else cur = `${cur} ${word}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// ===========================================================================
// SELFTEST
// ===========================================================================

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cursor-selftest-"));

  try {
    // -------------------------------------------------------------------
    // 1. The capability table refuses what it cannot do
    // -------------------------------------------------------------------
    check("a shell-command deny is a capability Cursor has", true, CAPABILITIES["deny-shell-command"].supported);
    check("a file-write deny is a capability Cursor has", true, CAPABILITIES["deny-file-write"].supported);
    check("intercepting a question tool is NOT", false, CAPABILITIES["deny-question-tool"].supported);
    check("blocking from afterFileEdit is NOT", false, CAPABILITIES["deny-after-file-edit"].supported);
    check("...and afterFileEdit says why: it fires after the edit", true, /AFTER the edit/.test(CAPABILITIES["deny-after-file-edit"].why));
    check("blocking a Tab autocomplete edit is NOT possible either", false, CAPABILITIES["deny-tab-edit"].supported);
    check("...and that hole in /freeze is named rather than left out of the table", true, /REAL HOLE IN \/freeze/.test(CAPABILITIES["deny-tab-edit"].why), CAPABILITIES["deny-tab-edit"].why);
    // This row used to assert, falsely, that Cursor has no question tool. It
    // does. The correction is asserted so it cannot quietly regress into the
    // comfortable version again.
    check("the question-tool row does NOT claim Cursor lacks a question tool", false, /Cursor has no AskUserQuestion tool and no hook event/.test(CAPABILITIES["deny-question-tool"].why));
    check("...it says Cursor HAS one, named AskQuestion", true, /AskQuestion/.test(CAPABILITIES["deny-question-tool"].why), CAPABILITIES["deny-question-tool"].why);
    check("...and refuses on the honest ground that coverage is unproven", "unproven", CAPABILITIES["deny-question-tool"].confidence);
    check("...which is still a refusal", false, CAPABILITIES["deny-question-tool"].supported);
    check("every supported capability names the Cursor event that serves it", true, Object.values(CAPABILITIES).filter((r) => r.supported).every((r) => typeof r.event === "string" && r.event.length > 0));
    check("every unsupported capability says why, rather than just NO", true, Object.values(CAPABILITIES).filter((r) => !r.supported).every((r) => typeof r.why === "string" && r.why.length > 40));
    check("every supported capability cites its evidence", true, Object.values(CAPABILITIES).filter((r) => r.supported).every((r) => /create-hook|cursor\.com/.test(r.evidence || "")));
    // MUTATION: if a capability row lost its `supported:false`, planSkill would
    // start installing plan-tune. Prove the refusal is driven by that field.
    {
      const saved = CAPABILITIES["deny-question-tool"].supported;
      CAPABILITIES["deny-question-tool"].supported = true;
      CAPABILITIES["deny-question-tool"].event = "preToolUse";
      const mutated = planSkill("plan-tune", PLAN_TUNE_MD);
      CAPABILITIES["deny-question-tool"].supported = saved;
      delete CAPABILITIES["deny-question-tool"].event;
      check("MUTATION: flipping deny-question-tool to supported would install plan-tune", true, mutated.ok, "so the refusal really is driven by the capability table, not a hard-coded skill name");
    }

    // -------------------------------------------------------------------
    // 2. planSkill: the install-time refusal
    // -------------------------------------------------------------------
    {
      const p = planSkill("plan-tune", PLAN_TUNE_MD);
      check("plan-tune is REFUSED for Cursor", false, p.ok, JSON.stringify(p.refusals));
      check("...naming the capability Cursor lacks", "deny-question-tool", p.refusals[0]?.capability);
      check("...and it plans no hooks at all", 0, p.hooks.length);
    }
    {
      const p = planSkill("careful", CAREFUL_MD);
      check("careful is accepted", true, p.ok, JSON.stringify(p.refusals));
      check("...onto beforeShellExecution", "beforeShellExecution", p.hooks[0]?.event);
      check("...in careful mode", "careful", p.hooks[0]?.mode);
      check("...with no matcher, so every command reaches the guard", null, matcherFor(p.hooks[0]?.capability));
    }
    {
      const p = planSkill("freeze", FREEZE_MD);
      check("freeze is accepted", true, p.ok, JSON.stringify(p.refusals));
      check("...and its four Claude matchers collapse to ONE Cursor entry", 1, p.hooks.length, JSON.stringify(p.hooks));
      check("...on preToolUse", "preToolUse", p.hooks[0]?.event);
      check("...with a matcher that compiles as a JS regex", true, (() => { try { new RegExp(matcherFor("deny-file-write")); return true; } catch { return false; } })());
      const re = new RegExp(matcherFor("deny-file-write"));
      // The names Cursor documents.
      check("...matching Write", true, re.test("Write"));
      check("...matching Edit", true, re.test("Edit"));
      check("...matching MultiEdit", true, re.test("MultiEdit"));
      // The names Cursor does NOT document, which is the whole risk: a matcher
      // that only covers the spellings we happened to think of is a guard that
      // silently does not fire on the one the editor actually uses.
      for (const name of ["ApplyDiff", "search_replace", "str_replace_editor", "notebook_edit", "create_file", "fileWrite", "SaveFile", "TabWrite", "DeleteFile", "rename_file"]) {
        check(`...matching the undocumented spelling ${name}`, true, re.test(name), matcherFor("deny-file-write"));
      }
      // And it must still not drag in the read-only tools, or /freeze would
      // block reads it never promised to block.
      for (const name of ["Read", "Grep", "Glob", "Shell", "Task", "LS", "Bash", "codebase_search"]) {
        check(`...and NOT matching the read-only tool ${name}`, false, re.test(name));
      }
      // THE BUG THIS SECTION EXISTS FOR. Cursor's own tool enum contains
      // TodoWrite and CreatePlan. Both carry a write verb and neither writes a
      // file, so under the old matcher both reached tb-guard, which does not
      // know the names, which in freeze mode is a deny. Setting a boundary
      // stopped the agent keeping a todo list, and told it the guard was broken.
      for (const name of ["TodoWrite", "CreatePlan"]) {
        check(`...and NOT matching Cursor's non-file-writing ${name}`, false, re.test(name), "it carries a write verb but writes no file; matching it denies it");
      }
      // ...while anything that merely CONTAINS one of those names still matches,
      // because an editor calling its writer TodoWriteFile is not this exception.
      check("...but a longer name containing TodoWrite still matches", true, re.test("TodoWriteFile"));
    }

    // -------------------------------------------------------------------
    // 2b. Cursor's tool vocabulary, translated into the guard's
    // -------------------------------------------------------------------
    {
      check("Cursor's Delete tool is classified as a write-like tool", "write-like", classifyCursorTool("Delete"));
      check("...and is translated to a name tb-guard knows", "Write", guardToolNameFor("Delete"), "otherwise the boundary is never consulted and the guard reports itself broken");
      check("Cursor's TodoWrite is classified as not a file write", "not-a-file-write", classifyCursorTool("TodoWrite"));
      check("Cursor's CreatePlan is too", "not-a-file-write", classifyCursorTool("CreatePlan"));
      check("...and neither is translated", null, guardToolNameFor("TodoWrite"));
      check("a name tb-guard already knows is passed through untranslated", "file-write", classifyCursorTool("Write"));
      check("...so it is not rewritten", null, guardToolNameFor("Write"));
      check("an undocumented write spelling is translated rather than failing closed", "Write", guardToolNameFor("str_replace_editor"));
      // The limit of the translation: a name with NO write verb is NOT made
      // into a write. If such a call arrives the hook registration is wrong,
      // and tb-guard failing closed on it is the correct, loud outcome.
      check("a read-only tool is NOT classified as write-like", "unrelated", classifyCursorTool("Read"));
      check("...and is never translated into a write", null, guardToolNameFor("Read"), "translating it would make /freeze deny READS outside the boundary, which it never promised");
      check("an empty tool name is not translated", null, guardToolNameFor(""));

      // The translation only happens in freeze mode, and only on the way to the
      // guard — the payload Cursor sent is not rewritten under it.
      const n = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: "/a/b.txt" } }, "freeze");
      check("normalising a Delete for freeze hands the guard a name it knows", "Write", n.value?.tool_name);
      check("...while remembering what Cursor actually called it", "Delete", n.cursorToolName);
      check("...and it is not flagged as a non-file-write", false, n.notAFileWrite);
      const nt = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "TodoWrite", tool_input: { todos: [] } }, "freeze");
      check("normalising a TodoWrite flags it as out of the boundary guard's scope", true, nt.notAFileWrite);
      const nc = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: "/a/b.txt" } }, "careful");
      check("MUTATION: outside freeze mode nothing is translated at all", "Delete", nc.value?.tool_name, "careful judges commands, not tool names; translating there would be scope creep");
    }

    // -------------------------------------------------------------------
    // 2c. Claude Code paths are retargeted, prose is not
    // -------------------------------------------------------------------
    {
      const md = "Run `node ~/.claude/skills/modes/scripts/tb-mode.mjs read`\nand `node .claude/skills/freeze/scripts/tb-guard.mjs`\nand $HOME/.claude/skills/ship/scripts/tb-ship.mjs\n";
      const r = retargetClaudePaths(md);
      check("a ~/.claude script path is retargeted", true, /`node \.cursor\/skills\/modes\/scripts\/tb-mode\.mjs read`/.test(r), r);
      check("...a bare .claude one too", true, r.includes(".cursor/skills/freeze/scripts/tb-guard.mjs"), r);
      check("...and a $HOME one", true, r.includes(".cursor/skills/ship/scripts/tb-ship.mjs"), r);
      check("...leaving no .claude script path behind", false, /\.claude\/skills/.test(r), r);
      check("a global install retargets to ~/.cursor instead", true, retargetClaudePaths(md, { global: true }).includes("~/.cursor/skills/modes/"), retargetClaudePaths(md, { global: true }));
      // Prose about the other editor is NOT rewritten, because a document that
      // lies about Claude Code to avoid lying about Cursor is no better.
      const prose = "In Claude Code the settings live in .claude/settings.json.";
      check("prose about .claude/settings.json is left alone", prose, retargetClaudePaths(prose), "rewriting it would make the sentence false about the editor it is describing");
    }

    // -------------------------------------------------------------------
    // 2d. Duplicate guards are folded, not merely warned about
    // -------------------------------------------------------------------
    {
      const e = (skill, mode) => ({ toolbayStack: { skill, mode } });
      const { entries, folded } = dedupeCursorHooks({
        preToolUse: [e("freeze", "freeze"), e("guard", "freeze"), e("investigate", "freeze")],
        beforeShellExecution: [e("careful", "careful"), e("guard", "careful")],
      });
      check("three identical preToolUse guards fold to one", 1, entries.preToolUse.length, JSON.stringify(entries.preToolUse));
      check("...two identical shell guards fold to one", 1, entries.beforeShellExecution.length);
      check("...and the first one registered is the one kept", "freeze", entries.preToolUse[0].toolbayStack.skill);
      check("...with every fold reported rather than done quietly", 3, folded.length, JSON.stringify(folded));
      check("...naming what was dropped", true, folded.some((f) => f.dropped === "investigate"), JSON.stringify(folded));
      // Different modes on one event are NOT duplicates: /guard registers both
      // halves and both have to run.
      const two = dedupeCursorHooks({ preToolUse: [e("guard", "freeze"), e("guard", "careful")] });
      check("MUTATION: two DIFFERENT modes on one event are both kept", 2, two.entries.preToolUse.length, JSON.stringify(two.entries));
      check("...and nothing is reported as folded", 0, two.folded.length);
    }
    {
      const p = planSkill("mystery", MYSTERY_MD);
      check("a skill with an unrecognised matcher is REFUSED, not guessed at", false, p.ok, JSON.stringify(p.refusals));
      check("...saying the capability is unknown rather than unsupported", null, p.refusals[0]?.capability);
    }
    {
      const p = planSkill("docs-only", "---\nname: docs-only\ndescription: nothing\n---\nbody\n");
      check("a skill with no hooks installs cleanly", true, p.ok);
      check("...and plans no hooks", 0, p.hooks.length);
    }

    // -------------------------------------------------------------------
    // 3. Payload normalisation
    // -------------------------------------------------------------------
    {
      const n = normalizeCursorPayload({ hook_event_name: "beforeShellExecution", command: "rm -rf /", cwd: "/tmp" });
      check("beforeShellExecution reshapes into a Bash tool call", "Bash", n.value?.tool_name);
      check("...carrying the command", "rm -rf /", n.value?.tool_input?.command);
    }
    {
      const n = normalizeCursorPayload({ hook_event_name: "beforeShellExecution", cwd: "/tmp" });
      check("a shell event with NO command is an error, not an allow", false, n.ok, n.error);
    }
    {
      const n = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: "/a/b.txt" } });
      check("preToolUse passes through", "Write", n.value?.tool_name);
      check("...with the path intact", "/a/b.txt", n.value?.tool_input?.file_path);
    }
    {
      // The key nobody could document: Cursor might call it target_file.
      const n = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "Edit", tool_input: { target_file: "/a/b.txt" } });
      check("an aliased path key is normalised to file_path", "/a/b.txt", n.value?.tool_input?.file_path);
    }
    {
      const n = normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { mystery_key: "/a/b.txt" } });
      check("an UNKNOWN path key is left alone rather than invented", undefined, n.value?.tool_input?.file_path);
      check("...so the guard is the one that fails closed on it", true, n.ok, "normalisation succeeds; containment cannot be checked, and tb-guard denies");
    }
    {
      const n = normalizeCursorPayload({ hook_event_name: "beforeMCPExecution", tool_name: "mcp__x__y", tool_input: '{"a":1}' });
      check("beforeMCPExecution's stringified tool_input is parsed", 1, n.value?.tool_input?.a);
    }
    {
      const n = normalizeCursorPayload({ hook_event_name: "beforeMCPExecution", tool_name: "x", tool_input: "{not json" });
      check("...and unparseable tool_input is an error, not an allow", false, n.ok, n.error);
    }
    check("a null payload is an error", false, normalizeCursorPayload(null).ok);
    check("an array payload is an error", false, normalizeCursorPayload([]).ok);
    check("a payload with no tool_input at all is an error", false, normalizeCursorPayload({ hook_event_name: "preToolUse", tool_name: "X" }).ok);
    check("a non-object tool_input is an error", false, normalizeCursorPayload({ hook_event_name: "preToolUse", tool_input: "nope" }).ok);

    // -------------------------------------------------------------------
    // 4. toCursorDecision — EVERY path to allow
    // -------------------------------------------------------------------
    check("an explicit guard allow becomes allow", "allow", toCursorDecision({ status: 0, stdout: "{}" }, "freeze").permission);
    check("a guard deny becomes deny", "deny", toCursorDecision({ status: 0, stdout: JSON.stringify({ permissionDecision: "deny", message: "no" }) }, "freeze").permission);
    check("a guard ask becomes ask", "ask", toCursorDecision({ status: 0, stdout: JSON.stringify({ permissionDecision: "ask", message: "hm" }) }, "careful").permission);
    check("...and the reason survives to the user", "no", toCursorDecision({ status: 0, stdout: JSON.stringify({ permissionDecision: "deny", message: "no" }) }, "freeze").user_message);
    check("the hookSpecificOutput envelope is understood too", "deny", toCursorDecision({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "r" } }) }, "freeze").permission);

    // ---- the fail-closed matrix. None of these may be `allow`.
    const mustBlock = [
      ["the guard crashed (non-zero exit)", { status: 1, stdout: "{}" }],
      ["the guard was killed (null status is not zero)", { status: null, stdout: "" }],
      ["the guard printed nothing", { status: 0, stdout: "" }],
      ["the guard printed whitespace", { status: 0, stdout: "   \n " }],
      ["the guard printed non-JSON", { status: 0, stdout: "boom" }],
      ["the guard printed a JSON array", { status: 0, stdout: "[]" }],
      ["the guard printed a JSON string", { status: 0, stdout: '"allow"' }],
      ["the guard printed null", { status: 0, stdout: "null" }],
      ["the guard printed an unrecognised decision", { status: 0, stdout: JSON.stringify({ permissionDecision: "probably-fine" }) }],
      ["the guard printed a decision-less object", { status: 0, stdout: JSON.stringify({ note: "hi" }) }],
    ];
    for (const [label, res] of mustBlock) {
      check(`freeze BLOCKS when ${label}`, "deny", toCursorDecision(res, "freeze").permission, JSON.stringify(res));
      const careful = toCursorDecision(res, "careful").permission;
      check(`careful does not ALLOW when ${label}`, true, careful === "ask" || careful === "deny", careful);
    }
    // MUTATION: an object with keys but no decision must NOT be read as allow.
    // The `Object.keys(parsed).length === 0` clause is the only thing standing
    // between "the guard said something we did not understand" and a fail-open.
    check(
      "MUTATION: only a LITERALLY empty object counts as the guard's silent allow",
      "deny",
      toCursorDecision({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: {} }) }, "freeze").permission,
      "an envelope with an empty inner object has no decision and must block",
    );
    check("careful's fail-closed is ask (a human can override)", "ask", toCursorDecision({ status: 0, stdout: "" }, "careful").permission);
    {
      process.env.TOOLBAY_GUARD_STRICT = "1";
      check("...and TOOLBAY_GUARD_STRICT=1 upgrades it to deny for unattended runs", "deny", toCursorDecision({ status: 0, stdout: "" }, "careful").permission);
      delete process.env.TOOLBAY_GUARD_STRICT;
    }
    check("a fail-closed message tells the agent not to treat it as approval", true, /not.*approval/i.test(toCursorDecision({ status: 0, stdout: "" }, "freeze").agent_message));

    // -------------------------------------------------------------------
    // 5. hooks.json construction and verification
    // -------------------------------------------------------------------
    {
      const script = path.join(tmp, "adapter.mjs");
      fs.writeFileSync(script, "// x\n");
      const guard = path.join(tmp, "tb-guard.mjs");
      fs.writeFileSync(guard, "// g\n");
      const good = {
        version: 1,
        hooks: { beforeShellExecution: [{ command: `node "${script}" hook careful --guard "${guard}"`, failClosed: true, toolbayStack: { skill: "careful" } }] },
      };
      check("a well-formed hooks.json verifies", 0, verifyHooksFile(good, tmp).length, JSON.stringify(verifyHooksFile(good, tmp)));

      // MUTATION 1: drop failClosed. Cursor's default is false, which fails OPEN.
      const noFailClosed = JSON.parse(JSON.stringify(good));
      delete noFailClosed.hooks.beforeShellExecution[0].failClosed;
      const p1 = verifyHooksFile(noFailClosed, tmp);
      check("MUTATION: a missing failClosed is caught", true, p1.length > 0, JSON.stringify(p1));
      check("...and named as failing OPEN", true, /fail OPEN/.test(p1.join(" ")), p1.join(" "));

      // MUTATION 2: failClosed present but false.
      const falseFailClosed = JSON.parse(JSON.stringify(good));
      falseFailClosed.hooks.beforeShellExecution[0].failClosed = false;
      check("MUTATION: failClosed:false is caught", true, verifyHooksFile(falseFailClosed, tmp).length > 0);

      // MUTATION 3: the adapter script is gone. The hook would never fire.
      const missingScript = JSON.parse(JSON.stringify(good));
      missingScript.hooks.beforeShellExecution[0].command = `node "${path.join(tmp, "gone.mjs")}" hook careful --guard "${guard}"`;
      const p3 = verifyHooksFile(missingScript, tmp);
      check("MUTATION: a hook command pointing at a missing script is caught", true, /never fire/.test(p3.join(" ")), p3.join(" "));

      // MUTATION 4: the adapter exists but the guard engine does not. This is
      // the nastiest one: the hook fires, runs, and checks nothing.
      const missingGuard = JSON.parse(JSON.stringify(good));
      missingGuard.hooks.beforeShellExecution[0].command = `node "${script}" hook careful --guard "${path.join(tmp, "no-guard.mjs")}"`;
      const p4 = verifyHooksFile(missingGuard, tmp);
      check("MUTATION: a missing guard engine is caught", true, /check nothing/.test(p4.join(" ")), p4.join(" "));

      // MUTATION 5: a matcher that will not compile means Cursor drops the entry.
      const badMatcher = JSON.parse(JSON.stringify(good));
      badMatcher.hooks.beforeShellExecution[0].matcher = "[[:space:]](";
      const p5 = verifyHooksFile(badMatcher, tmp);
      check("MUTATION: a POSIX-style matcher that JS cannot compile is caught", true, /valid regular expression/.test(p5.join(" ")), p5.join(" "));

      // MUTATION 6: wrong schema version.
      const badVersion = { ...JSON.parse(JSON.stringify(good)), version: 2 };
      check("MUTATION: a wrong schema version is caught", true, verifyHooksFile(badVersion, tmp).some((p) => /version/.test(p)));

      // A hooks.json with none of our entries is not a pass.
      check("a hooks.json with no Toolbay entries does not verify", true, verifyHooksFile({ version: 1, hooks: { stop: [{ command: "x" }] } }, tmp).length > 0);
      check("a non-object hooks.json does not verify", true, verifyHooksFile("nope", tmp).length > 0);
    }

    // ---- the double-prompt collision, found by a real install of
    // freeze + investigate, which both carry the freeze engine.
    {
      const entry = (skill, mode) => ({ toolbayStack: { skill, mode } });
      const clash = conflictingCursorHooks({ preToolUse: [entry("freeze", "freeze"), entry("investigate", "freeze")] });
      check("two skills on one event in the same mode is a collision", 1, clash.length, JSON.stringify(clash));
      check("...naming both skills", true, clash[0].skills.includes("freeze") && clash[0].skills.includes("investigate"), JSON.stringify(clash));
      const noClash = conflictingCursorHooks({ preToolUse: [entry("freeze", "freeze")], beforeShellExecution: [entry("careful", "careful")] });
      check("hooks on DIFFERENT events are not a collision", 0, noClash.length, JSON.stringify(noClash));
      const diffMode = conflictingCursorHooks({ preToolUse: [entry("guard", "freeze"), entry("guard", "careful")] });
      check("...and neither are two modes of one skill on one event", 0, diffMode.length, JSON.stringify(diffMode));
    }

    // ---- mergeHooks must not eat the user's own hooks
    {
      const theirs = { version: 1, hooks: { afterFileEdit: [{ command: "./fmt.sh" }], beforeShellExecution: [{ command: "./mine.sh" }] } };
      const merged = mergeHooks(theirs, { beforeShellExecution: [{ command: "ours", toolbayStack: { skill: "careful" } }] });
      check("merging keeps the user's unrelated hook", 1, merged.hooks.afterFileEdit.length);
      check("...and their hook on the same event", true, merged.hooks.beforeShellExecution.some((h) => h.command === "./mine.sh"), JSON.stringify(merged.hooks.beforeShellExecution));
      check("...and adds ours beside it", true, merged.hooks.beforeShellExecution.some((h) => h.toolbayStack));
      // Reinstalling must replace ours exactly once, not accumulate.
      const twice = mergeHooks(merged, { beforeShellExecution: [{ command: "ours2", toolbayStack: { skill: "careful" } }] });
      check("reinstalling replaces our entry rather than duplicating it", 1, twice.hooks.beforeShellExecution.filter((h) => h.toolbayStack).length, JSON.stringify(twice.hooks.beforeShellExecution));
      check("...and still keeps theirs", true, twice.hooks.beforeShellExecution.some((h) => h.command === "./mine.sh"));
      // Uninstall removes ours and leaves theirs.
      const cleaned = mergeHooks(twice, {});
      check("uninstall removes every entry of ours", 0, (cleaned.hooks.beforeShellExecution || []).filter((h) => h.toolbayStack).length);
      check("...and leaves theirs untouched", true, cleaned.hooks.beforeShellExecution.some((h) => h.command === "./mine.sh"));
    }

    // -------------------------------------------------------------------
    // 6. The SKILL.md rewrite tells the truth in the new editor
    // -------------------------------------------------------------------
    {
      const stripped = stripHooksFrontmatter(FREEZE_MD);
      check("the Claude hooks block is removed from the Cursor copy", false, /PreToolUse/.test(stripped), stripped.slice(0, 300));
      check("...and the name survives", true, /^name: freeze$/m.test(stripped));
      check("...and the description survives", true, /^description: /m.test(stripped));
      check("...and the body survives", true, /body text/.test(stripped), stripped.slice(-200));
      check("...and it is still valid frontmatter", true, splitFrontmatter(stripped).fm !== null);
      const banner = enforcementBanner(planSkill("freeze", FREEZE_MD));
      check("the banner names the Cursor event that enforces it", true, /preToolUse/.test(banner), banner);
      check("...says failClosed is on", true, /failClosed: true/.test(banner));
      check("...and says it is NOT YET PROVEN", true, /[Nn]ot yet proven/.test(banner), banner);
      check("...and tells the agent not to claim protection", true, /Do not tell the user they are/.test(banner));
      // A skill that is degraded in this editor has to say so in its own text,
      // or the user reads "blocks any edit outside the boundary" and believes it.
      check("...names Tab as a gap the boundary does not cover", true, /Tab does not go through it/.test(banner), banner);
      check("...names shell-written files as a gap", true, /shell command is a shell decision/.test(banner), banner);
      check("...and says the user's own typing is never guarded", true, /own typing is never guarded/.test(banner), banner);
      check("...and translates Claude Code's slash-command syntax", true, /Cursor has no slash commands for/.test(banner), banner);
      const plainBanner = enforcementBanner(planSkill("docs", "---\nname: d\n---\nx\n"));
      check("a hookless skill's banner does not imply a guard", false, /failClosed/.test(plainBanner), plainBanner);
      check("...but still explains the syntax difference", true, /slash-command syntax/.test(plainBanner), plainBanner);
      // A shell-only guard must NOT claim the edit-boundary gaps, which are not
      // its gaps to have.
      const shellBanner = enforcementBanner(planSkill("careful", CAREFUL_MD));
      check("a shell-only guard's banner does not list the edit-boundary gaps", false, /Tab does not go through it/.test(shellBanner), shellBanner);
    }

    // -------------------------------------------------------------------
    // 7. END TO END: install into a throwaway project, then run the hook
    // -------------------------------------------------------------------
    {
      const proj = path.join(tmp, "proj");
      fs.mkdirSync(proj, { recursive: true });

      // 7a. Cursor absent -> refuse.
      const noCursor = spawnSync(process.execPath, [SELF, "install", "careful", "--project", proj], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TOOLBAY_CURSOR_HOME: path.join(tmp, "definitely-not-here") },
        timeout: 60000,
        windowsHide: true,
      });
      check("install REFUSES when Cursor is not installed", 1, noCursor.status, (noCursor.stdout || "").slice(0, 300));
      check("...saying so plainly", true, /Cursor is not installed/.test(noCursor.stdout || ""), (noCursor.stdout || "").slice(0, 300));
      check("...and writes no .cursor directory", false, fs.existsSync(path.join(proj, ".cursor")));

      // 7b. Cursor present -> install.
      const fakeCursor = path.join(tmp, "fake-cursor-home");
      fs.mkdirSync(fakeCursor, { recursive: true });
      const env = { ...process.env, NO_COLOR: "1", TOOLBAY_CURSOR_HOME: fakeCursor };
      const inst = spawnSync(process.execPath, [SELF, "install", "careful", "freeze", "plan-tune", "--project", proj], {
        encoding: "utf8",
        env,
        timeout: 120000,
        windowsHide: true,
      });
      check("install succeeds when Cursor is present", 0, inst.status, (inst.stdout || "").slice(-600));
      check("...and REFUSES plan-tune out loud", true, /REFUSED/.test(inst.stdout || "") && /plan-tune/.test(inst.stdout || ""), (inst.stdout || "").slice(-800));
      check("...leaving plan-tune off the disk entirely", false, fs.existsSync(path.join(proj, ".cursor", "skills", "plan-tune")));
      check("...while careful is installed", true, fs.existsSync(path.join(proj, ".cursor", "skills", "careful", "SKILL.md")));
      check("...with its guard engine beside it", true, fs.existsSync(path.join(proj, ".cursor", "skills", "careful", "scripts", "tb-guard.mjs")));
      check("...and the adapter copied in", true, fs.existsSync(path.join(proj, ".cursor", "hooks", "tb-cursor.mjs")));
      check("...and it says what is NOT proven", true, /NOT proven/.test(inst.stdout || ""), (inst.stdout || "").slice(-900));
      check("...and warns the Cursor CLI is out of scope", true, /cursor-agent/.test(inst.stdout || ""));

      // Installing freeze + investigate really does collide, and the install
      // has to say so rather than leaving one edit prompting twice.
      const proj2 = path.join(tmp, "proj-clash");
      fs.mkdirSync(proj2, { recursive: true });
      const clashInst = spawnSync(process.execPath, [SELF, "install", "freeze", "investigate", "--project", proj2], {
        encoding: "utf8",
        env,
        timeout: 120000,
        windowsHide: true,
      });
      check("installing freeze + investigate folds the duplicate guard", true, /Folded duplicate guards/.test(clashInst.stdout || ""), (clashInst.stdout || "").slice(-900));
      check("...but does not fail the install over it", 0, clashInst.status);
      {
        const clashCfg = JSON.parse(fs.readFileSync(path.join(proj2, ".cursor", "hooks.json"), "utf8"));
        check("...so ONE edit gets ONE deny prompt, not two", 1, clashCfg.hooks.preToolUse.filter((h) => h.toolbayStack).length, JSON.stringify(clashCfg.hooks.preToolUse.map((h) => h.toolbayStack)));
        check("...and both skills are still installed", true, fs.existsSync(path.join(proj2, ".cursor", "skills", "investigate", "SKILL.md")));
      }

      const cfg = JSON.parse(fs.readFileSync(path.join(proj, ".cursor", "hooks.json"), "utf8"));
      check("hooks.json is schema version 1", 1, cfg.version);
      check("...with a beforeShellExecution entry", true, Array.isArray(cfg.hooks.beforeShellExecution) && cfg.hooks.beforeShellExecution.length > 0);
      check("...and a preToolUse entry for freeze", true, Array.isArray(cfg.hooks.preToolUse) && cfg.hooks.preToolUse.length > 0);
      check("...every entry failClosed:true", true, Object.values(cfg.hooks).flat().every((h) => h.failClosed === true), JSON.stringify(cfg.hooks));
      check("...and it verifies", 0, verifyHooksFile(cfg, path.join(proj, ".cursor")).length, JSON.stringify(verifyHooksFile(cfg, path.join(proj, ".cursor"))));

      const installedMd = fs.readFileSync(path.join(proj, ".cursor", "skills", "freeze", "SKILL.md"), "utf8");
      check("the installed SKILL.md carries no Claude hooks block", false, /PreToolUse/.test(installedMd));
      check("...and does carry the enforcement banner", true, /Running in Cursor/.test(installedMd));
      check("...which says it is unproven", true, /[Nn]ot yet proven/.test(installedMd));

      // 7c. RUN THE REAL HOOK, end to end, through the installed adapter.
      const adapter = path.join(proj, ".cursor", "hooks", "tb-cursor.mjs");
      const guardEngine = path.join(proj, ".cursor", "skills", "careful", "scripts", "tb-guard.mjs");
      const stateHome = path.join(tmp, "state");
      const hookEnv = { ...process.env, NO_COLOR: "1", TOOLBAY_STACK_STATE_DIR: stateHome };
      const fire = (mode, payload, guard = guardEngine) =>
        spawnSync(process.execPath, [adapter, "hook", mode, "--guard", guard], {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 60000,
          windowsHide: true,
          env: hookEnv,
        });

      const danger = fire("careful", { hook_event_name: "beforeShellExecution", command: "rm -rf /var/data", cwd: proj });
      const dangerJson = JSON.parse((danger.stdout || "{}").trim());
      check("END TO END: rm -rf through a real Cursor payload is not allowed", true, dangerJson.permission === "ask" || dangerJson.permission === "deny", danger.stdout);
      check("...and the user is told why", true, typeof dangerJson.user_message === "string" && dangerJson.user_message.length > 10, danger.stdout);

      const safe = fire("careful", { hook_event_name: "beforeShellExecution", command: "ls -la", cwd: proj });
      check("END TO END: a harmless command is allowed", "allow", JSON.parse((safe.stdout || "{}").trim()).permission, safe.stdout);
      check("...with exit 0", 0, safe.status);

      // END TO END, THE REGRESSION. These three ran as real hook invocations
      // against the installed adapter and, before the fix, all three answered
      // deny with "the freeze hook was invoked for tool X, which it does not
      // know how to check". A boundary that blocks the todo list is a boundary
      // that gets uninstalled.
      {
        const freezeGuard = path.join(proj, ".cursor", "skills", "freeze", "scripts", "tb-guard.mjs");
        const inside = path.join(proj, "inside");
        fs.mkdirSync(inside, { recursive: true });
        spawnSync(process.execPath, [freezeGuard, "freeze", "--set", inside], { encoding: "utf8", timeout: 60000, windowsHide: true, env: hookEnv });

        const todo = fire("freeze", { hook_event_name: "preToolUse", tool_name: "TodoWrite", tool_input: { todos: [] }, cwd: proj }, freezeGuard);
        check("END TO END: a frozen boundary does NOT block Cursor's TodoWrite", "allow", JSON.parse((todo.stdout || "{}").trim()).permission, todo.stdout);
        check("...and exits 0", 0, todo.status);
        const plan = fire("freeze", { hook_event_name: "preToolUse", tool_name: "CreatePlan", tool_input: { plan: "x" }, cwd: proj }, freezeGuard);
        check("END TO END: nor Cursor's CreatePlan", "allow", JSON.parse((plan.stdout || "{}").trim()).permission, plan.stdout);

        const delIn = fire("freeze", { hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: path.join(inside, "a.txt") }, cwd: proj }, freezeGuard);
        check("END TO END: a Delete INSIDE the boundary is allowed", "allow", JSON.parse((delIn.stdout || "{}").trim()).permission, delIn.stdout);
        const delOut = fire("freeze", { hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: path.join(proj, "outside.txt") }, cwd: proj }, freezeGuard);
        const delOutJson = JSON.parse((delOut.stdout || "{}").trim());
        check("END TO END: a Delete OUTSIDE the boundary is denied", "deny", delOutJson.permission, delOut.stdout);
        check("...and exits 2, which Cursor reads as block", 2, delOut.status);
        check("...for the BOUNDARY reason, not 'the guard is broken'", true, /outside the freeze boundary/.test(delOutJson.user_message || ""), delOutJson.user_message);

        // Cursor's own edit tool name, with Cursor's own path key.
        const edOut = fire("freeze", { hook_event_name: "preToolUse", tool_name: "Edit", tool_input: { path: path.join(proj, "outside.txt") }, cwd: proj }, freezeGuard);
        check("END TO END: an Edit outside the boundary is denied", "deny", JSON.parse((edOut.stdout || "{}").trim()).permission, edOut.stdout);
        check("...and exits 2", 2, edOut.status);
        const edIn = fire("freeze", { hook_event_name: "preToolUse", tool_name: "Edit", tool_input: { path: path.join(inside, "a.txt") }, cwd: proj }, freezeGuard);
        check("END TO END: an Edit inside the boundary is allowed", "allow", JSON.parse((edIn.stdout || "{}").trim()).permission, edIn.stdout);

        // A tool with a write verb that the guard cannot check still fails
        // closed. The exception is exactly two names, not a category.
        const noPath = fire("freeze", { hook_event_name: "preToolUse", tool_name: "ApplyDiff", tool_input: { mystery: 1 }, cwd: proj }, freezeGuard);
        check("END TO END: a write-like tool with no readable path still DENIES", "deny", JSON.parse((noPath.stdout || "{}").trim()).permission, noPath.stdout);

        spawnSync(process.execPath, [freezeGuard, "unfreeze"], { encoding: "utf8", timeout: 60000, windowsHide: true, env: hookEnv });
      }

      // The installed copy points at scripts that are actually there.
      {
        const anyMd = fs.readFileSync(path.join(proj, ".cursor", "skills", "careful", "SKILL.md"), "utf8");
        check("the installed SKILL.md has no Claude Code script paths left", false, /\.claude\/skills/.test(anyMd), (anyMd.match(/[^\s]*\.claude\/skills[^\s]*/) || [""])[0]);
      }

      // A guard that is not there must never produce an allow.
      const noGuard = fire("freeze", { hook_event_name: "preToolUse", tool_name: "Write", tool_input: { file_path: path.join(proj, "x.txt") } }, path.join(tmp, "no-such-guard.mjs"));
      check("END TO END: a MISSING guard engine denies", "deny", JSON.parse((noGuard.stdout || "{}").trim()).permission, noGuard.stdout);
      check("...and exits 2, which Cursor reads as block", 2, noGuard.status);

      const badStdin = spawnSync(process.execPath, [adapter, "hook", "freeze", "--guard", guardEngine], {
        input: "this is not json",
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
        env: hookEnv,
      });
      check("END TO END: an unparseable payload denies", "deny", JSON.parse((badStdin.stdout || "{}").trim()).permission, badStdin.stdout);
      check("...and exits 2", 2, badStdin.status);

      const badMode = spawnSync(process.execPath, [adapter, "hook", "wobble", "--guard", guardEngine], {
        input: "{}",
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
        env: hookEnv,
      });
      check("END TO END: an unknown guard mode denies rather than guessing", "deny", JSON.parse((badMode.stdout || "{}").trim()).permission, badMode.stdout);

      // 7d. The observation ledger recorded the real calls.
      const db = JSON.parse(fs.readFileSync(path.join(stateHome, "cursor-observed.json"), "utf8"));
      check("the observation ledger recorded beforeShellExecution", true, (db.events?.beforeShellExecution?.count || 0) >= 2, JSON.stringify(db.events));
      check("...and the tool names that were sent", true, Object.keys(db.toolNames || {}).includes("Write"), JSON.stringify(db.toolNames));
      const cov = matcherCoverage(db);
      check("...and matcher coverage can be computed from it", true, cov.known);
      check("...showing Write is covered by the write matcher", true, cov.matched.includes("Write"), JSON.stringify(cov));
      // The whole point: an editor whose write tool has another name shows up.
      const pretend = { toolNames: { fs_put: 3, Read: 9 } };
      const cov2 = matcherCoverage(pretend);
      check("an UNCOVERED write tool name is reported as unmatched", true, cov2.unmatched.includes("fs_put"), JSON.stringify(cov2));

      // 7e. doctor runs and reports UNPROVEN against an empty ledger.
      //
      // THIS IS THE ONE THAT CAUGHT A REAL BUG. doctor proves the adapter works
      // by firing real payload shapes at it — and those runs were landing in the
      // observation ledger, so doctor read back its own probes and reported
      // "YES — OBSERVED, Cursor has fired these hooks" on a machine where Cursor
      // had never called anything. A harness quoting itself as evidence is the
      // precise failure this package exists to remove.
      const emptyState = path.join(tmp, "empty-state");
      const doc = spawnSync(process.execPath, [SELF, "doctor", "--project", proj], {
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TOOLBAY_STACK_STATE_DIR: emptyState },
      });
      check("doctor runs", 0, doc.status, (doc.stdout || "").slice(-400));
      check("...and says UNPROVEN when Cursor has never fired the hooks", true, /UNPROVEN/.test(doc.stdout || ""), (doc.stdout || "").slice(-600));
      check("...and does NOT claim the hooks are observed", false, /OBSERVED\./.test(doc.stdout || ""));
      check(
        "...because doctor's own probes are NOT written to the observation ledger",
        false,
        fs.existsSync(path.join(emptyState, "cursor-observed.json")),
        "a doctor that records its own simulated runs would report them back as proof Cursor called us",
      );
      // MUTATION: without the simulated flag, the very same probe DOES write —
      // proving the guard above is what is keeping the evidence honest, rather
      // than the ledger happening to be somewhere else.
      {
        const mutState = path.join(tmp, "mutation-state");
        spawnSync(process.execPath, [adapter, "hook", "careful", "--guard", guardEngine], {
          input: JSON.stringify({ hook_event_name: "beforeShellExecution", command: "ls", cwd: proj }),
          encoding: "utf8",
          timeout: 60000,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: "1", TOOLBAY_STACK_STATE_DIR: mutState },
        });
        check("MUTATION: the same call WITHOUT the simulated flag does record", true, fs.existsSync(path.join(mutState, "cursor-observed.json")));
      }
      const doc2 = spawnSync(process.execPath, [SELF, "doctor", "--project", proj], {
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        env: hookEnv,
      });
      check("...and says OBSERVED once the ledger has real calls", true, /OBSERVED/.test(doc2.stdout || ""), (doc2.stdout || "").slice(-600));

      // 7f. status
      const st = spawnSync(process.execPath, [SELF, "status", "--project", proj], { encoding: "utf8", timeout: 60000, windowsHide: true, env: hookEnv });
      check("status exits 0 on a good install", 0, st.status, (st.stdout || "").slice(-400));
      // Break the install and status must notice.
      fs.rmSync(guardEngine, { force: true });
      const st2 = spawnSync(process.execPath, [SELF, "status", "--project", proj], { encoding: "utf8", timeout: 60000, windowsHide: true, env: hookEnv });
      check("MUTATION: deleting the guard engine makes status fail", 1, st2.status, (st2.stdout || "").slice(-400));
    }
  } catch (e) {
    check("the cursor selftest ran to completion without throwing", true, false, `it threw instead of reporting: ${e?.stack ?? e}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-cursor selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out("\n  Failures:");
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${r.detail}`);
    out("");
    return 1;
  }
  out("\n  A guard installed into an editor that cannot run it is worse than no guard,");
  out("  so the refusal above is a feature and it has more tests than the install.\n");
  return 0;
}

// Fixtures for the selftest, kept beside it rather than read off disk, so the
// selftest still asserts the refusal after somebody edits a real SKILL.md.
const CAREFUL_MD = `---
name: careful
description: Safety guardrails.
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/careful/scripts/tb-guard.mjs careful"
---
body text
`;

const FREEZE_MD = `---
name: freeze
description: Restrict file edits to one directory.
platforms:
  - win32
hooks:
  PreToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
    - matcher: "Write"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
    - matcher: "MultiEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
    - matcher: "NotebookEdit"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/freeze/scripts/tb-guard.mjs freeze"
---
body text
`;

const PLAN_TUNE_MD = `---
name: plan-tune
description: Question sensitivity.
hooks:
  PreToolUse:
    - matcher: "(AskUserQuestion|mcp__.*__AskUserQuestion)"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/plan-tune/scripts/tb-plan-tune.mjs hook"
---
body text
`;

const MYSTERY_MD = `---
name: mystery
description: Hooks something nobody has heard of.
hooks:
  PreToolUse:
    - matcher: "Telepathy"
      hooks:
        - type: command
          command: "node $HOME/.claude/skills/mystery/scripts/tb-mystery.mjs hook"
---
body text
`;

// ===========================================================================
// MAIN
// ===========================================================================

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const argv = process.argv.slice(2);
const flags = {
  global: argv.includes("--global") || argv.includes("-g"),
  force: argv.includes("--force") || argv.includes("-f"),
  allowMissingCursor: argv.includes("--allow-missing-cursor"),
  json: argv.includes("--json"),
  project: argValue("--project"),
  skillsSrc: argValue("--skills"),
};
const VALUE_FLAGS = new Set(["--project", "--skills", "--guard"]);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith("-")) {
    if (VALUE_FLAGS.has(argv[i])) i += 1;
    continue;
  }
  positional.push(argv[i]);
}
const [cmd, ...rest] = positional;

if (cmd === "selftest") process.exit(selftest());
else if (cmd === "hook") await cmdHook(rest[0], argValue("--guard"));
else if (cmd === "install") process.exit(cmdInstall(rest, flags));
else if (cmd === "uninstall") process.exit(cmdUninstall(flags));
else if (cmd === "status") process.exit(cmdStatus(flags));
else if (cmd === "doctor") process.exit(cmdDoctor(flags));
else if (cmd === "capabilities" || cmd === "caps") process.exit(cmdCapabilities(flags.json));
else {
  out(`
${bold("tb-cursor")} ${dim(`v${VERSION}`)}  install the Toolbay Stack into Cursor

  ${cyan("capabilities")}   what Cursor can and cannot enforce, with evidence
  ${cyan("install")}        install skills + guards into .cursor/
  ${cyan("uninstall")}      remove them, leaving your own hooks alone
  ${cyan("status")}         what is installed, and whether it is proven
  ${cyan("doctor")}         run real payloads through it and report the truth
  ${cyan("hook <mode>")}    the runtime adapter Cursor calls (not for humans)
  ${cyan("selftest")}       prove all of the above fails closed

  ${dim("--project <dir>  --global  --force  --allow-missing-cursor  --json")}
`);
  process.exit(cmd ? 1 : 0);
}
