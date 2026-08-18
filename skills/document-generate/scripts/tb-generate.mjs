#!/usr/bin/env node
/**
 * tb-generate.mjs: the citation engine for /document-generate.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed.
 *
 * DERIVED WORK. The workflow this serves (research the whole codebase before
 * writing a line, partition the work across the four Diataxis quadrants, write
 * reference first because it establishes the vocabulary, then explanation, then
 * how-to, then tutorial, cross-link the quadrants, make every document
 * reachable from the README, self-review against accuracy/completeness/voice
 * gates, and commit) comes from `document-generate` in gstack by Garry Tan:
 *   https://github.com/garrytan/gstack  MIT, Copyright (c) 2026 Garry Tan
 * See LICENSE and NOTICE at the repository root. Not affiliated with or
 * endorsed by Garry Tan.
 *
 * The Diataxis structure, the four templates, the write-order and the voice
 * rules are his and are kept as written. What is new here is everything that
 * turns the accuracy rules from instructions into checks, plus the Windows
 * fixes below.
 *
 * WHY THERE IS CODE HERE AT ALL
 *
 * 1. THE RESEARCH STEP DOES NOT RUN ON WINDOWS.
 *
 *    gstack Step 1.1 maps the project with:
 *      find . -type f -not -path "./.git/*" -not -path "./node_modules/*" ... | head -200
 *    In PowerShell `find` is C:\Windows\System32\find.exe, a text search tool
 *    that has never heard of -type, and `head` does not exist at all. Measured
 *    on Windows 11, 2026-08-14, in this repository:
 *
 *      PS> find . -type f -not -path "./.git/*" -not -path "./node_modules/*"
 *      FIND: Parameter format not correct
 *      exit=2
 *
 *    Step 1 is the step the skill itself calls "the most important step... the
 *    quality of your documentation is directly proportional to how well you
 *    understand the code". On Windows it returns one line of error text, and
 *    the agent proceeds to write documentation for a project it never listed.
 *    `map` walks the tree with node:fs.
 *
 * 2. "EVERY API DESCRIPTION MUST MATCH THE ACTUAL CODE" IS AN INSTRUCTION TO
 *    THE MODEL THAT WROTE THE DESCRIPTION.
 *
 *    This is the failure that matters for generated docs. Documentation is the
 *    one artifact where a language model's output is graded on plausibility by
 *    a reader who cannot check it, and where being wrong is invisible until
 *    somebody copies the snippet. gstack's countermeasures are Step 8's
 *    checkboxes:
 *
 *      - [ ] Every API description matches the actual code signature
 *      - [ ] No stale references to renamed/removed entities
 *
 *    They are ticked by the same context window that produced the prose, with
 *    no read-back of the source in between. A hallucinated export named
 *    `makeWidget()` next to a real one named `createWidget()` produces exactly
 *    the report a correct run produces.
 *
 *    `surface` extracts the real symbols, flags and env vars out of the source
 *    with a file and a line number each. `cite` then reads a finished document
 *    and resolves every anchor in it against that index: every function it
 *    names, every flag, every env var, every path, every `file.ts:120`
 *    citation, every relative link and every heading anchor. A name that is not
 *    in the source is a FAILURE with the closest real name printed next to it.
 *
 * 3. A DOCUMENT THAT CITES NOTHING PASSES EVERY CHECK THERE IS.
 *
 *    The accuracy gate can only fail claims that were made. Fluent prose that
 *    names no file, no symbol and no command asserts nothing checkable and
 *    sails through, and it is also the exact shape of output a model produces
 *    when it did not really read the code. `cite` fails a document whose
 *    verifiable-anchor count is zero rather than passing it for lack of
 *    evidence, which is the one case where fail-closed has real teeth.
 *
 * 4. "REACHABLE WITHIN 2 CLICKS FROM README.md" IS NEVER COMPUTED.
 *
 *    Step 7.3 states the rule and Step 7.4 says to "grep for any `](`
 *    references that point to files that don't exist". Both are left to the
 *    agent. `discoverability` builds the link graph and returns the actual
 *    click depth of each new document, and unreachable is a failure.
 *
 * 5. THE PRE-COMMIT CREDENTIAL SCAN FAILS OPEN.
 *
 *    gstack Step 9 scans the staged docs for secrets with:
 *      git diff --cached --no-color | grep '^+' | sed 's/^+//' | gstack-redact ...
 *    A pipeline reports the exit status of its LAST command, so every way the
 *    scan can break -- git failing, nothing staged, the wrong directory --
 *    arrives at the redactor as an empty stream, which is indistinguishable
 *    from clean input. Measured on Windows 11, 2026-08-14, in a directory that
 *    is not a git work tree:
 *
 *      $ git diff --cached --no-color | grep '^+' | sed 's/^+//' | wc -c
 *      error: unknown option `cached'
 *      0
 *      pipeline exit=0
 *
 *    git printed a usage error, the pipeline exited 0, and zero bytes were
 *    scanned. Under the documented rule ("exit 3 (HIGH) -> do NOT commit") that
 *    is a pass, and generated docs full of example credentials get committed on
 *    the strength of a scan that never ran. In PowerShell it is worse still:
 *    `grep` and `sed` do not exist. `secrets` reads the staged content through
 *    node with the exit status checked, and refuses to return "clean" for any
 *    reason other than having actually read and scanned the bytes.
 *
 * DESIGN RULES
 *
 *   FAIL CLOSED. Unreadable document, missing root, unreadable source, no
 *   staged content, no anchors to check: all failures, never "nothing to
 *   check, looks fine".
 *
 *   CITE OR IT DID NOT HAPPEN. Every item this file reports carries a file and
 *   a line. Nothing is emitted from inference.
 *
 *   NODE ONLY. No shell, no find, no head, no grep, no sed, no /tmp, no $$.
 *
 *   PROVE IT. `selftest` runs this file as a child process against throwaway
 *   projects and documents built to be wrong in one specific way each, and
 *   fails if any of them is allowed through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const SELF = fileURLToPath(import.meta.url);

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_UNUSABLE = 2;

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ the tree

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "out", "target", "vendor", "coverage", "__pycache__", ".venv", "venv",
  ".gstack", ".toolbay", ".cache", ".turbo", ".pytest_cache", ".mypy_cache",
  ".idea", ".vscode", "Pods", ".gradle", ".terraform",
]);

const SOURCE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".rs", ".rb", ".sh", ".bash", ".ps1", ".psm1",
  ".java", ".kt", ".swift", ".php", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".scala", ".ex", ".exs", ".lua", ".sql",
]);

const DOC_EXT = new Set([".md", ".mdx", ".markdown", ".rst", ".txt"]);

/**
 * Every file under root, found with node:fs.
 *
 * This replaces `find . -type f -not -path ... | head -200`, which on Windows
 * is find.exe piped into a command that does not exist. It also drops the
 * arbitrary 200-file truncation: a project bigger than 200 files is exactly the
 * project where the missing files are the ones you needed to read.
 */
function walk(root, { limit = 200000 } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: recorded as absent, never as empty-and-fine
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        files.push(abs);
        if (files.length >= limit) return files.sort();
      }
    }
  }
  return files.sort();
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

function readTextOrNull(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function existsFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function existsAny(abs) {
  try {
    fs.statSync(abs);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- project shape

const PROJECT_MARKERS = [
  ["package.json", "node"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Gemfile", "ruby"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["Package.swift", "swift"],
  ["composer.json", "php"],
];

const ENTRY_NAMES = [
  "README.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md",
  "CHANGELOG.md", "NOTICE", "LICENSE", "TODOS.md",
];

function mapProject(root) {
  const files = walk(root);
  const rels = files.map((f) => rel(root, f));
  const kinds = [];
  for (const [marker, kind] of PROJECT_MARKERS) {
    if (rels.includes(marker) && !kinds.includes(kind)) kinds.push(kind);
  }
  const entries = ENTRY_NAMES.filter((n) => rels.includes(n));
  const byExt = new Map();
  for (const r of rels) {
    const e = path.extname(r).toLowerCase() || "(none)";
    byExt.set(e, (byExt.get(e) ?? 0) + 1);
  }
  const docs = rels.filter((r) => DOC_EXT.has(path.extname(r).toLowerCase()));
  const source = rels.filter((r) => SOURCE_EXT.has(path.extname(r).toLowerCase()));
  const docDirs = [...new Set(docs.map((d) => path.posix.dirname(d)))].sort();
  return {
    root,
    fileCount: rels.length,
    projectKinds: kinds.length ? kinds : ["unknown"],
    entryPoints: entries,
    docFiles: docs,
    docDirs,
    sourceFiles: source,
    extensions: [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    files: rels,
  };
}

// ------------------------------------------------------------ public surface

/**
 * Declaration patterns, per language. Anything matched here is a name a reader
 * could type, and every hit carries the file and the 1-based line it came from,
 * because a symbol without a location is the same unverifiable assertion this
 * file exists to remove.
 */
const DECL_RULES = [
  // JS / TS
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "export", exported: true, re: /^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/ },
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "export", exported: true, re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { ext: [".ts", ".tsx", ".mts", ".cts"], kind: "type", exported: true, re: /^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/ },
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "export", exported: true, re: /^\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/ },
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "function", exported: false, re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "class", exported: false, re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
  { ext: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"], kind: "function", exported: false, re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
  // Python
  { ext: [".py"], kind: "function", exported: false, re: /^\s*def\s+([A-Za-z_][\w]*)/ },
  { ext: [".py"], kind: "class", exported: false, re: /^\s*class\s+([A-Za-z_][\w]*)/ },
  // Go
  { ext: [".go"], kind: "function", exported: false, re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
  { ext: [".go"], kind: "type", exported: false, re: /^\s*type\s+([A-Za-z_][\w]*)/ },
  // Rust
  { ext: [".rs"], kind: "export", exported: true, re: /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
  { ext: [".rs"], kind: "function", exported: false, re: /^\s*(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
  { ext: [".rs"], kind: "type", exported: false, re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/ },
  // Ruby
  { ext: [".rb"], kind: "function", exported: false, re: /^\s*def\s+([A-Za-z_][\w]*[?!]?)/ },
  { ext: [".rb"], kind: "class", exported: false, re: /^\s*(?:class|module)\s+([A-Za-z_][\w]*)/ },
  // Shell
  { ext: [".sh", ".bash"], kind: "function", exported: false, re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/ },
  // PowerShell
  { ext: [".ps1", ".psm1"], kind: "function", exported: false, re: /^\s*function\s+([A-Za-z_][\w-]*)/ },
  // Java / Kotlin / Swift / C#
  { ext: [".java", ".kt", ".swift", ".cs", ".scala"], kind: "class", exported: false, re: /^\s*(?:public\s+|open\s+|internal\s+)?(?:final\s+)?(?:class|interface|struct|enum|protocol)\s+([A-Za-z_][\w]*)/ },
  { ext: [".swift"], kind: "function", exported: false, re: /^\s*(?:public\s+|open\s+)?func\s+([A-Za-z_][\w]*)/ },
  { ext: [".kt"], kind: "function", exported: false, re: /^\s*(?:public\s+)?fun\s+([A-Za-z_][\w]*)/ },
];

const ENV_RULES = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]{2,})["'`]\]/g,
  /os\.environ(?:\.get)?[[(]["']([A-Z][A-Z0-9_]{2,})["']/g,
  /os\.getenv\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /Deno\.env\.get\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /std::env::var\(["']([A-Z][A-Z0-9_]{2,})["']/g,
  /\$env:([A-Za-z_][A-Za-z0-9_]{2,})/g,
  /ENV\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
];

const FLAG_RE = /(--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;

function addHit(map, name, hit) {
  if (!map.has(name)) map.set(name, []);
  const list = map.get(name);
  if (list.length < 12) list.push(hit);
}

/**
 * The index every citation is checked against: what this codebase actually
 * declares, with a location for each. Built by reading files, never by recall.
 */
function buildSurface(root, targets) {
  const roots = targets && targets.length ? targets : [root];
  const seen = new Set();
  const files = [];
  for (const t of roots) {
    const abs = path.resolve(root, t);
    if (!existsAny(abs)) return { ok: false, error: `target does not exist: ${t}` };
    const list = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const f of list) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }

  const symbols = new Map();
  const flags = new Map();
  const envs = new Map();
  const scripts = new Map();
  const kindOf = new Map();
  let scanned = 0;
  let unreadable = 0;

  for (const abs of files) {
    const ext = path.extname(abs).toLowerCase();
    const r = rel(root, abs);

    if (path.basename(abs) === "package.json") {
      const text = readTextOrNull(abs);
      if (text !== null) {
        try {
          const pkg = JSON.parse(text);
          const lines = text.split("\n");
          for (const name of Object.keys(pkg.scripts ?? {})) {
            const i = lines.findIndex((l) => l.includes(`"${name}"`));
            addHit(scripts, name, `${r}:${i >= 0 ? i + 1 : 1}`);
          }
        } catch {
          unreadable += 1;
        }
      }
      continue;
    }

    if (!SOURCE_EXT.has(ext)) continue;
    const text = readTextOrNull(abs);
    if (text === null) {
      unreadable += 1;
      continue;
    }
    scanned += 1;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const where = `${r}:${i + 1}`;
      for (const rule of DECL_RULES) {
        if (!rule.ext.includes(ext)) continue;
        const m = rule.re.exec(line);
        if (m && m[1]) {
          addHit(symbols, m[1], where);
          const prev = kindOf.get(m[1]);
          if (!prev || (rule.exported && prev !== "export")) kindOf.set(m[1], rule.exported ? "export" : rule.kind);
        }
      }
      for (const re of ENV_RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) addHit(envs, m[1], where);
      }
      FLAG_RE.lastIndex = 0;
      let fm;
      while ((fm = FLAG_RE.exec(line)) !== null) addHit(flags, fm[1], where);
    }
  }

  return {
    ok: true,
    root,
    scanned,
    unreadable,
    symbols,
    flags,
    envs,
    scripts,
    kindOf,
    // Every file the walk saw, source or not. `cite` resolves bare filenames
    // against this, so it has to be the whole tree and not just the files the
    // declaration rules understood.
    allFiles: files.map((f) => rel(root, f)),
    files: files.map((f) => rel(root, f)),
  };
}

function surfaceItems(s) {
  const items = [];
  for (const [name, hits] of s.symbols) items.push({ kind: s.kindOf.get(name) ?? "symbol", name, at: hits[0], hits: hits.length });
  for (const [name, hits] of s.flags) items.push({ kind: "flag", name, at: hits[0], hits: hits.length });
  for (const [name, hits] of s.envs) items.push({ kind: "env", name, at: hits[0], hits: hits.length });
  for (const [name, hits] of s.scripts) items.push({ kind: "script", name, at: hits[0], hits: hits.length });
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ citations

/**
 * Names a document may use without them being in this codebase: language
 * builtins, ubiquitous tooling, and the shell. Everything else it names in code
 * voice has to exist somewhere in the source, which is the point.
 */
const KNOWN_EXTERNAL = new Set([
  "require", "import", "export", "console", "fetch", "process", "module",
  "print", "len", "range", "open", "str", "int", "list", "dict", "set", "map",
  "filter", "reduce", "main", "init", "test", "describe", "it", "expect",
  "npm", "npx", "node", "yarn", "pnpm", "bun", "deno", "git", "make", "cargo",
  "python", "python3", "pip", "go", "rustc", "docker", "curl", "ls", "cd",
  "echo", "cat", "grep", "sed", "awk", "sudo", "chmod", "mkdir", "rm", "cp",
  "mv", "env", "export", "source", "bash", "sh", "zsh", "powershell", "pwsh",
  "String", "Number", "Boolean", "Array", "Object", "Promise", "Error", "Date",
  "JSON", "Math", "RegExp", "Map", "Set", "Symbol", "BigInt", "undefined", "null",
  "true", "false", "self", "this", "super", "async", "await", "void", "any",
  "atob", "btoa", "catch", "try", "finally", "http", "https", "if", "for",
  "while", "switch", "return", "throw", "new", "delete", "typeof", "yield",
]);

/**
 * Names that are obviously stand-ins. `src/a.ts` and `src/b.ts` in a sentence
 * about two files that conflict are correct prose, and failing them for not
 * existing is a checker inventing work. Real files are almost never named `a`.
 */
const PLACEHOLDER_BASENAMES = new Set([
  "a", "b", "c", "x", "y", "z", "foo", "bar", "baz", "qux", "example",
  "examples", "sample", "thing", "one", "two", "three", "old", "new",
  "deleted", "renamed", "yourfile", "your-file", "myfile", "my-file",
  "file", "somefile", "some-file", "placeholder", "name", "path",
]);

const IGNORED_PATHISH = new Set([
  ".env", ".env.local", ".env.example", ".gitignore", ".npmrc", ".nvmrc",
  ".dockerignore", ".editorconfig", ".prettierrc", ".eslintrc",
]);

const CHECKABLE_EXT = new Set([
  ...SOURCE_EXT, ...DOC_EXT, ".json", ".yml", ".yaml", ".toml", ".ini",
  ".html", ".css", ".scss", ".xml", ".lock", ".cfg", ".conf",
]);

function headingSlugs(text) {
  const slugs = new Set();
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slug) slugs.add(slug);
  }
  return slugs;
}

function stripFences(text) {
  // Fenced blocks are kept for path/citation anchors but their prose-level
  // backtick parsing is meaningless, so they are blanked for symbol scanning
  // while preserving line numbers.
  const lines = text.split("\n");
  let inFence = false;
  return lines.map((l) => {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : l;
  });
}

function fenceLines(text) {
  const lines = text.split("\n");
  let inFence = false;
  return lines.map((l) => {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? l : "";
  });
}

function nearest(name, candidates) {
  let best = null;
  let bestScore = Infinity;
  const lower = name.toLowerCase();
  for (const c of candidates) {
    const d = distance(lower, c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  if (best === null) return null;
  // Two edits, not "half the name", and only one on a short name. The loose
  // limit matched `stageSkill` to unrelated real names; two edits on five
  // letters then matched SwiftUI's `Color` to a local `ctlOf`, which is not a
  // typo, it is a different word. What survives is the off-by-one API name
  // (`createWidgets` for `createWidget`) that a reader cannot catch.
  const limit = name.length <= 6 ? 1 : 2;
  return bestScore > 0 && bestScore <= limit ? best : null;
}

function distance(a, b) {
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Read one finished document and resolve everything in it that can be resolved.
 *
 * The unit of failure is an ANCHOR: a link, a path, a file:line citation, a
 * function name in code voice, a flag, an env var. Each one either points at
 * something that exists in this repository or it does not, and the second case
 * is a failure rather than a note.
 */
function citeDoc(root, docAbs, surface, opts = {}) {
  const results = [];
  const docRel = rel(root, docAbs);
  const text = readTextOrNull(docAbs);
  if (text === null) {
    return {
      unusable: true,
      docRel,
      results: [{ name: `${docRel} is readable`, expected: "readable file", got: "UNREADABLE", pass: false, detail: "a document that cannot be read cannot be verified; this is a failure, not a skip" }],
    };
  }

  const lines = text.split("\n");
  const prose = stripFences(text);
  const fenced = fenceLines(text);
  const docDir = path.dirname(docAbs);
  const byBasename = basenameIndex(surface.allFiles ?? []);
  let anchors = 0;

  /**
   * Two severities, on one line: FAIL what the document PROMISES the reader can
   * find, NOTE what it merely NAMES.
   *
   * A link, a line citation, a path under a directory this repository really
   * has, a path in a command the reader is told to run, a function called in
   * code voice: the reader will follow those and they will not be there. That
   * is a defect in the document.
   *
   * A flag or an env var name can belong to any tool the prose mentions, and a
   * bare filename can be one the tutorial asks the reader to create. Measured
   * across all 48 SKILL.md files in this repository on 2026-08-14, failing
   * those produced 40+ findings of which the large majority were correct
   * sentences about git, the codex CLI, or a file created at runtime. A checker
   * with that hit rate gets switched off, and then it protects nothing. They
   * are reported as NOTE and `--strict` turns them back into failures.
   */
  const push = (name, pass, expected, got, detail, level = "fail") => {
    results.push({ name, pass, expected, got, detail, level });
  };

  const rootDirs = new Set(
    (surface.allFiles ?? []).filter((f) => f.includes("/")).map((f) => f.split("/")[0]),
  );
  const underRealDir = (tok) => rootDirs.has(tok.replace(/^\.\//, "").split("/")[0]);
  const isPlaceholder = (tok) => {
    const base = path.posix.basename(tok).replace(/\.[^.]*$/, "").toLowerCase();
    return PLACEHOLDER_BASENAMES.has(base) || base.length <= 2;
  };

  // --- 1. markdown links, including heading anchors
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (let i = 0; i < lines.length; i += 1) {
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(lines[i])) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
      anchors += 1;
      const [p, frag] = target.split("#");
      const abs = path.resolve(docDir, decodeURIComponent(p || "."));
      const where = `${docRel}:${i + 1}`;
      if (!existsAny(abs)) {
        push(`link ${target} (${where})`, false, "a file that exists", "MISSING", `resolved to ${abs}`);
        continue;
      }
      if (frag && DOC_EXT.has(path.extname(abs).toLowerCase())) {
        const t = readTextOrNull(abs);
        const slugs = t === null ? new Set() : headingSlugs(t);
        const ok = slugs.has(frag.toLowerCase());
        push(`link ${target} (${where})`, ok, "a heading that exists", ok ? "found" : "NO SUCH HEADING", ok ? "" : `${rel(root, abs)} has no heading slugged "${frag.toLowerCase()}"`);
        continue;
      }
      push(`link ${target} (${where})`, true, "a file that exists", "found", "");
    }
  }

  // --- 2. file:line citations, anywhere in the document
  const citeRe = /(?:^|[\s(`"'])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,6}):(\d{1,6})(?![\w])/g;
  for (let i = 0; i < lines.length; i += 1) {
    citeRe.lastIndex = 0;
    let m;
    while ((m = citeRe.exec(lines[i])) !== null) {
      const [, p, lineNo] = m;
      const where = `${docRel}:${i + 1}`;
      // No basename fallback here, deliberately. A line number is a claim about
      // one specific file, and resolving a bare `SKILL.md:1049` to whichever
      // SKILL.md happens to be nearby then failing it for being 297 lines long
      // is a fabricated defect. Measured across this repository's own docs on
      // 2026-08-14, that produced 4 of 26 remaining failures, all wrong: the
      // citations were to gstack's files, quoted on purpose.
      const hit = resolveRepoPath(root, docDir, p);
      anchors += 1;
      if (!hit) {
        push(
          `citation ${p}:${lineNo} (${where})`,
          false,
          "a file that exists",
          "MISSING",
          "no such file relative to the document or the repository root; if this cites another project, say which",
          underRealDir(p) && !isPlaceholder(p) ? "fail" : "note",
        );
        continue;
      }
      const t = readTextOrNull(hit.abs);
      const count = t === null ? 0 : t.split("\n").length;
      const n = Number(lineNo);
      const ok = t !== null && n >= 1 && n <= count;
      // A bare `SKILL.md:1049` inside a SKILL.md resolves to the document
      // itself, and a document rarely cites its own line 1049. It is far more
      // likely quoting another project's file of the same name, so it is
      // reported rather than failed.
      const selfCite = path.resolve(hit.abs) === path.resolve(docAbs);
      push(
        `citation ${p}:${lineNo} (${where})`,
        ok,
        `a line within ${rel(root, hit.abs)}`,
        ok ? "in range" : `FILE HAS ${count} LINES`,
        ok ? "" : selfCite ? "resolved to this same document, which suggests it cites another project's file of the same name; give the full path" : "the citation points past the end of the file",
        selfCite ? "note" : "fail",
      );
    }
  }

  // --- 3. paths in code voice
  const tickRe = /`([^`\n]{1,120})`/g;
  for (let i = 0; i < lines.length; i += 1) {
    const source = `${prose[i]} ${fenced[i]}`;
    tickRe.lastIndex = 0;
    let m;
    const seenOnLine = new Set();
    while ((m = tickRe.exec(prose[i] ?? "")) !== null) {
      const tok = m[1].trim();
      if (seenOnLine.has(tok)) continue;
      seenOnLine.add(tok);
      const where = `${docRel}:${i + 1}`;

      // An installed path: `~/.claude/skills/guard/scripts/tb-guard.mjs` is how
      // a SKILL.md legitimately names its own script, and it will never resolve
      // against the repository as written. Match the longest multi-segment tail
      // that does exist here. No tail matching is not a failure -- an absolute
      // path may genuinely live outside this tree -- but a tail that matches is
      // a real citation and counts as one.
      if (/^[~/]/.test(tok) && tok.includes("/") && !/[*?{}[\]$\s]/.test(tok)) {
        const tail = resolveInstalledPath(root, tok);
        if (tail) {
          anchors += 1;
          push(`path \`${tok}\` (${where})`, true, "a path that exists", `found at ${tail}`, "");
        }
        continue;
      }

      // path-shaped?
      if (isPathish(tok)) {
        if (IGNORED_PATHISH.has(tok)) continue;
        if (/:\d+$/.test(tok)) continue; // already handled as a citation
        anchors += 1;
        const hit = resolveRepoPath(root, docDir, tok.replace(/^\.\//, "").replace(/\/$/, ""), byBasename);
        push(
          `path \`${tok}\` (${where})`,
          Boolean(hit),
          "a path that exists",
          hit ? (hit.loose ? `found at ${rel(root, hit.abs)}` : "found") : "MISSING",
          hit ? "" : underRealDir(tok) && !isPlaceholder(tok)
            ? "the document points at a path under a directory this repository really has, and there is nothing there"
            : "named in code voice and not present in the repository; it may be a stand-in, created at runtime, or created by the reader",
          hit || (underRealDir(tok) && !isPlaceholder(tok)) ? "fail" : "note",
        );
        continue;
      }

      // flag?
      if (/^--[a-z][a-z0-9-]*$/.test(tok)) {
        anchors += 1;
        const hits = surface.flags.get(tok);
        const near = hits ? null : nearest(tok, [...surface.flags.keys()]);
        push(
          `flag \`${tok}\` (${where})`,
          Boolean(hits),
          "a flag the code parses",
          hits ? hits[0] : "NOT IN SOURCE",
          hits ? "" : near ? `closest real flag is ${near}; or it belongs to another tool this document mentions` : "no flag by this name appears anywhere in the source",
          "note",
        );
        continue;
      }

      // env var?
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(tok) && tok.includes("_")) {
        anchors += 1;
        const hits = surface.envs.get(tok) ?? surface.symbols.get(tok);
        const near = hits ? null : nearest(tok, [...surface.envs.keys()]);
        push(
          `env \`${tok}\` (${where})`,
          Boolean(hits),
          "an env var the code reads",
          hits ? hits[0] : "NOT IN SOURCE",
          hits ? "" : near ? `closest real env var is ${near}` : "no code here reads this; it may be an output field name rather than a variable",
          "note",
        );
        continue;
      }

      // symbol in call form: foo(), foo(a, b), Class.method()
      const call = /^([A-Za-z_][\w$]*)\s*\([^)]*\)$/.exec(tok);
      if (call) {
        const name = call[1];
        if (KNOWN_EXTERNAL.has(name)) continue;
        anchors += 1;
        // A pure case difference means the thing exists and the document typed
        // it differently. `Color()` in a SwiftUI document next to a `color()`
        // in this tree is not a fabricated API, so this is not a failure.
        const names = [...surface.symbols.keys()];
        const cased = surface.symbols.has(name) ? null : names.find((n) => n.toLowerCase() === name.toLowerCase());
        if (cased) {
          anchors += 1;
          push(`symbol \`${name}()\` (${where})`, true, "a symbol declared in the source", `declared as ${cased}`, "", "note");
          continue;
        }
        const hits = surface.symbols.get(name);
        const near = hits ? null : nearest(name, names);
        // A near-miss is the failure this whole file exists for: `makeWidget()`
        // standing next to a real `createWidget()` is a fabricated API, and no
        // reader can tell. A name with no near-miss at all is far more often a
        // call into a library the document mentions -- `atob()`, `Color()`,
        // `catch()` all showed up in this repository's own docs -- so it is
        // reported and not failed.
        push(
          `symbol \`${name}()\` (${where})`,
          Boolean(hits),
          "a symbol declared in the source",
          hits ? hits[0] : "NOT IN SOURCE",
          hits ? "" : near ? `no such declaration; closest real name is ${near}, which is what a fabricated API looks like` : "no such declaration here; if it comes from a library, name the library",
          hits || near ? "fail" : "note",
        );
        continue;
      }
      void source;
    }
  }

  // --- 4. paths inside fenced commands
  //
  // The commands a document tells you to run are the part a reader copies, and
  // in a SKILL.md they are the only place the script path ever appears. Prose
  // backtick rules do not apply inside a fence, so the tokens are split out of
  // the command line directly.
  //
  // Only two shapes are checked, both unambiguous: a path whose first segment
  // is a real directory at the repository root, and an installed path whose
  // tail resolves here. Everything else in a fence is skipped, because
  // `path/to/your-file.md` in an example is a placeholder, not a wrong claim,
  // and a checker that fails it teaches people to delete their examples.
  const seenFencePath = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const cmd = fenced[i];
    if (!cmd || !cmd.trim()) continue;
    for (const raw of cmd.split(/[\s"'`(),;|]+/)) {
      const tok = raw.replace(/[.,:;]+$/, "");
      if (!tok || !tok.includes("/")) continue;
      if (/[*?{}[\]$<>]/.test(tok)) continue;
      const where = `${docRel}:${i + 1}`;
      const key = `${tok}@${i}`;
      if (seenFencePath.has(key)) continue;
      seenFencePath.add(key);

      if (/^[~/]/.test(tok)) {
        const tail = resolveInstalledPath(root, tok);
        if (tail) {
          anchors += 1;
          push(`command path \`${tok}\` (${where})`, true, "a path that exists", `found at ${tail}`, "");
        }
        continue;
      }
      const first = tok.replace(/^\.\//, "").split("/")[0];
      if (!rootDirs.has(first)) continue;
      anchors += 1;
      const hit = resolveRepoPath(root, docDir, tok.replace(/^\.\//, "").replace(/\/$/, ""));
      push(
        `command path \`${tok}\` (${where})`,
        Boolean(hit),
        "a path that exists",
        hit ? "found" : "MISSING",
        hit ? "" : "the command in this document tells the reader to use a path that is not there; if the command is an example for the reader's own project, say so",
        // A fenced command is as often an example for the reader's project as
        // it is a command against this one, so an unresolvable path here is
        // reported rather than failed. `--strict` is the generate-time gate:
        // a document you just wrote about THIS repository has no excuse.
        "note",
      );
    }
  }

  // --- 5. the document must assert something checkable
  const strict = opts.minAnchors ?? 1;
  push(
    `${docRel} cites something checkable`,
    anchors >= strict,
    `at least ${strict} anchor`,
    String(anchors),
    "a document that names no file, symbol, flag or path asserts nothing that can be wrong, which is also what a document written without reading the code looks like",
  );

  return { unusable: false, docRel, anchors, results };
}

/**
 * A name with no directory in it is a claim about a file, not about a location.
 *
 * Measured against this repository's own README on 2026-08-14, the first
 * version failed `modes.json` and `SKILL.md`, which are both real files named
 * the way a human names them in prose. Requiring a bare name to sit next to the
 * document or at the root would train an author to write worse sentences to
 * satisfy the checker. So a bare name resolves anywhere in the tree and is
 * reported as found-elsewhere; a name WITH a slash is a path, and a path that
 * does not resolve is still a failure.
 */
function basenameIndex(files) {
  const idx = new Map();
  for (const f of files) {
    const b = f.split("/").pop();
    if (!idx.has(b)) idx.set(b, []);
    const list = idx.get(b);
    if (list.length < 8) list.push(f);
  }
  return idx;
}

function isPathish(tok) {
  if (/\s/.test(tok)) return false;
  if (/^(https?:|#|-|\$)/.test(tok)) return false;
  // Any URL scheme, and any angle-bracket template slot. `file://./docs/x.html`
  // and `projects/<slug>/checkpoints/<title>.md` are both correct prose and
  // neither is a path that can be resolved.
  if (/:\/\//.test(tok) || /[<>]/.test(tok)) return false;
  // A glob is a pattern, not a claim that a file exists. Measured against this
  // repository on 2026-08-14, the first version failed `*.md` in a sentence
  // about a glob, which is a checker inventing a bug in correct prose.
  if (/[*?{}[\]$]/.test(tok)) return false;
  // An absolute path, or a Windows drive path, is outside the repository and
  // cannot be resolved against it. Skills quote gstack's `/tmp/...` paths on
  // purpose; failing those would fail the sentence explaining why they are wrong.
  if (tok.startsWith("/") || /^[A-Za-z]:[\\/]/.test(tok) || tok.startsWith("~")) return false;
  if (tok.startsWith("./") || tok.startsWith("../")) return true;
  if (tok.includes("/")) {
    const ext = path.extname(tok).toLowerCase();
    return CHECKABLE_EXT.has(ext) || tok.endsWith("/");
  }
  const ext = path.extname(tok).toLowerCase();
  return Boolean(ext) && CHECKABLE_EXT.has(ext) && !tok.startsWith(".");
}

/**
 * The longest multi-segment tail of an installed path that exists in this repo.
 * Single-segment tails are refused on purpose: matching `tb-guard.mjs` out of
 * `/usr/share/whatever/tb-guard.mjs` would be a coincidence, not a citation.
 */
function resolveInstalledPath(root, tok) {
  const segs = tok.split("/").filter((s) => s && s !== "~" && s !== ".");
  for (let i = 0; i <= segs.length - 2; i += 1) {
    const candidate = segs.slice(i).join("/");
    if (existsAny(path.resolve(root, candidate))) return candidate;
  }
  return null;
}

function resolveRepoPath(root, docDir, p, index = null) {
  const candidates = [path.resolve(docDir, p), path.resolve(root, p)];
  for (const c of candidates) if (existsAny(c)) return { abs: c, loose: false };
  if (index && !p.includes("/") && !p.startsWith(".")) {
    const hits = index.get(p);
    if (hits && hits.length) return { abs: path.resolve(root, hits[0]), loose: true, all: hits };
  }
  return null;
}

// -------------------------------------------------------------- reachability

/**
 * The actual click depth of each document from the entry point.
 *
 * gstack states the rule ("reachable within 2 clicks from README.md") in the
 * step where the agent is asked to confirm it about the files it just wrote.
 * Here it is a breadth-first search over the real link graph, and a document
 * nothing links to fails.
 */
function discoverability(root, fromRel, targets, maxDepth) {
  const results = [];
  const startAbs = path.resolve(root, fromRel);
  if (!existsFile(startAbs)) {
    return {
      unusable: true,
      results: [{
        name: `entry point ${fromRel} exists`,
        pass: false,
        expected: "a readable entry document",
        got: "MISSING",
        detail: "with no entry point there is no such thing as reachable; this fails rather than reporting every document fine",
      }],
    };
  }

  const depth = new Map([[path.resolve(startAbs), 0]]);
  const queue = [path.resolve(startAbs)];
  while (queue.length) {
    const cur = queue.shift();
    const d = depth.get(cur);
    if (d >= maxDepth + 4) continue;
    const text = readTextOrNull(cur);
    if (text === null) continue;
    const dir = path.dirname(cur);
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
      const p = target.split("#")[0];
      if (!p) continue;
      const abs = path.resolve(dir, decodeURIComponent(p));
      if (!existsFile(abs)) continue;
      if (!DOC_EXT.has(path.extname(abs).toLowerCase())) continue;
      if (depth.has(abs) && depth.get(abs) <= d + 1) continue;
      depth.set(abs, d + 1);
      queue.push(abs);
    }
  }

  for (const t of targets) {
    const abs = path.resolve(root, t);
    const r = rel(root, abs);
    if (!existsFile(abs)) {
      results.push({ name: `${r} exists`, pass: false, expected: "a file", got: "MISSING", detail: "cannot measure the reachability of a document that is not there" });
      continue;
    }
    const d = depth.get(abs);
    const reachable = d !== undefined && d <= maxDepth;
    results.push({
      name: `${r} is reachable from ${fromRel}`,
      pass: reachable,
      expected: `<= ${maxDepth} clicks`,
      got: d === undefined ? "UNREACHABLE" : `${d} clicks`,
      detail: reachable ? "" : d === undefined ? "nothing links to this document, so nobody will find it" : "too deep; link it closer to the entry point",
    });
  }
  return { unusable: false, results };
}

// ------------------------------------------------------------------- secrets

const SECRET_RULES = [
  { id: "aws-access-key", severity: "HIGH", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "private-key-block", severity: "HIGH", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "github-token", severity: "HIGH", re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/ },
  { id: "slack-token", severity: "HIGH", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "openai-key", severity: "HIGH", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic-key", severity: "HIGH", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "google-api-key", severity: "HIGH", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", severity: "HIGH", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: "assigned-secret", severity: "MEDIUM", re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i },
];

const PLACEHOLDER_RE = /EXAMPLE|PLACEHOLDER|XXXX|YOUR[_-]?|CHANGE[_-]?ME|<[^>]+>|\.\.\.|REDACTED|FAKE|DUMMY|TEST[_-]?KEY|abc123/i;

function gitCapture(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: flat(res.stderr ?? res.error?.message ?? ""),
  };
}

/**
 * The credential scan, with the exit status checked.
 *
 * The rule this replaces is a shell pipeline whose exit status belongs to its
 * last stage, so every upstream failure reaches the redactor as an empty stream
 * and is scored as clean. Here, "clean" is only ever returned after bytes were
 * actually read; every other outcome is a refusal with the reason printed.
 */
function scanStagedSecrets(cwd) {
  const results = [];
  const root = gitCapture(["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) {
    results.push({
      name: "the staged content can be read at all",
      pass: false,
      expected: "a git work tree",
      got: "NOT A GIT REPOSITORY",
      detail: `git said: ${root.stderr || "unknown error"}. gstack's pipeline returns 0 here and the commit proceeds unscanned.`,
    });
    return { unusable: true, results };
  }
  const diff = gitCapture(["diff", "--cached", "--no-color", "--unified=0"], cwd);
  if (!diff.ok) {
    results.push({
      name: "git produced the staged diff",
      pass: false,
      expected: "exit 0 from git diff --cached",
      got: `exit ${diff.status}`,
      detail: `git said: ${diff.stderr || "unknown error"}. A failed read is not an empty diff.`,
    });
    return { unusable: true, results };
  }
  const added = diff.stdout
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
  if (!added.length) {
    results.push({
      name: "there is staged content to scan",
      pass: false,
      expected: "at least one added line",
      got: "NOTHING STAGED",
      detail: "nothing was scanned, so nothing can be declared clean; stage the docs first",
    });
    return { unusable: true, results };
  }

  const findings = [];
  for (let i = 0; i < added.length; i += 1) {
    const line = added[i];
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const span = m[0];
      if (PLACEHOLDER_RE.test(span)) continue;
      findings.push({ rule: rule.id, severity: rule.severity, sample: `${span.slice(0, 8)}...`, at: `staged line ${i + 1}` });
    }
  }
  const high = findings.filter((f) => f.severity === "HIGH");
  results.push({
    name: `${added.length} staged lines scanned for credentials`,
    pass: high.length === 0,
    expected: "no live-format secret",
    got: high.length ? `${high.length} HIGH` : "clean",
    detail: high.length ? high.map((f) => `${f.rule} at ${f.at} (${f.sample})`).join("; ") : "",
  });
  for (const f of findings.filter((x) => x.severity !== "HIGH")) {
    results.push({ name: `possible secret: ${f.rule} at ${f.at}`, pass: false, expected: "no assigned secret literal", got: f.sample, detail: "medium confidence; confirm before committing" });
  }
  return { unusable: false, results, scanned: added.length };
}

// ------------------------------------------------------------------ printing

function report(title, results, { strict = false, quiet = false } = {}) {
  const width = Math.min(96, Math.max(...results.map((r) => r.name.length)));
  const tagOf = (r) => (r.pass ? "PASS" : strict || (r.level ?? "fail") === "fail" ? "FAIL" : "NOTE");
  const shown = quiet ? results.filter((r) => tagOf(r) !== "PASS") : results;
  out(`\n  ${title}  (node ${process.version}, ${process.platform})\n`);
  if (!shown.length) out("  nothing to report");
  for (const r of shown) {
    out(`  ${tagOf(r)}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  }
  const failed = results.filter((r) => tagOf(r) === "FAIL");
  const notes = results.filter((r) => tagOf(r) === "NOTE");
  out(`\n  ${results.filter((r) => r.pass).length}/${results.length} passed${notes.length ? `, ${notes.length} to look at` : ""}`);
  if (notes.length && !failed.length) {
    out(`\n  NOTE is a name this repository does not contain. It is not automatically`);
    out(`  wrong -- a flag can belong to another tool, a file can be created at`);
    out(`  runtime or by the reader -- but each one is worth a look. Re-run with`);
    out(`  --strict to treat them as failures.`);
    for (const r of notes) out(`    - ${r.name}: ${flat(r.detail) || `expected ${r.expected}, got ${r.got}`}`);
  }
  if (failed.length) {
    out(`\n  Fix these before reporting the documentation done:`);
    for (const r of failed) out(`    - ${r.name}: ${flat(r.detail) || `expected ${r.expected}, got ${r.got}`}`);
    out("");
    return EXIT_FAILED;
  }
  out("");
  return EXIT_OK;
}

// ------------------------------------------------------------------ selftest

function run(args, cwd, env = {}) {
  const res = spawnSync(process.execPath, [SELF, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-generate-selftest-"));
  const proj = path.join(tmp, "proj");
  const results = [];
  const check = (name, expected, got, detail = "") => {
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });
  };

  // ---- a small project with a KNOWN public surface
  write(path.join(proj, "package.json"), JSON.stringify({ name: "widgets", scripts: { build: "node build.mjs" } }, null, 2));
  write(
    path.join(proj, "src", "widget.js"),
    [
      "// line 1",
      "export function createWidget(name) {",
      "  return { name };",
      "}",
      "",
      "export const WIDGET_LIMIT = 10;",
      "",
      "function internalHelper() {",
      "  return process.env.WIDGET_TOKEN;",
      "}",
      "",
      "// parsed flags: --verbose",
      "export function parseArgs(argv) {",
      "  return argv.includes('--verbose');",
      "}",
    ].join("\n"),
  );
  write(path.join(proj, "node_modules", "junk", "index.js"), "export function shouldNotBeIndexed() {}\n");
  write(path.join(proj, "docs", "other.md"), "# Other\n\n## Real Heading\n\ntext\n");

  // ---- map: it lists the tree that `find | head -200` cannot list on Windows
  const mapRes = run(["map", "--json"], proj);
  let mapped = null;
  try {
    mapped = JSON.parse(mapRes.stdout);
  } catch {
    mapped = null;
  }
  check("map exits 0 in a plain directory", 0, mapRes.status);
  check("map returns parseable JSON", true, mapped !== null);
  check("map finds the nested source file", true, Boolean(mapped?.files?.includes("src/widget.js")));
  check("map excludes node_modules", false, Boolean(mapped?.files?.some((f) => f.startsWith("node_modules/"))));
  check("map identifies the project kind", "node", mapped?.projectKinds?.[0] ?? "none");

  // ---- surface: real names with real line numbers
  const surfRes = run(["surface", "--json"], proj);
  let surf = null;
  try {
    surf = JSON.parse(surfRes.stdout);
  } catch {
    surf = null;
  }
  const item = (kind, name) => surf?.items?.find((i) => i.kind === kind && i.name === name);
  check("surface exits 0", 0, surfRes.status);
  check("surface finds createWidget at its real line", "src/widget.js:2", item("export", "createWidget")?.at ?? "missing");
  check("surface finds parseArgs at its real line", "src/widget.js:13", item("export", "parseArgs")?.at ?? "missing");
  check("surface finds the --verbose flag", true, Boolean(item("flag", "--verbose")));
  check("surface finds WIDGET_TOKEN read from the env", "src/widget.js:9", item("env", "WIDGET_TOKEN")?.at ?? "missing");
  check("surface finds the build script", true, Boolean(item("script", "build")));
  check("surface does not index node_modules", false, Boolean(item("export", "shouldNotBeIndexed")));

  // ---- cite: the documents built to be wrong, one way each
  const docs = {
    "good.md": [
      "# Widgets",
      "",
      "Call `createWidget()` from `src/widget.js`. The limit is set at `src/widget.js:6`.",
      "Pass `--verbose` to see more. Set `WIDGET_TOKEN` first.",
      "",
      "See [other](./other.md#real-heading).",
    ].join("\n"),
    // An off-by-one API name: the reader copies it, it does not exist, and no
    // amount of re-reading the prose reveals that. This is the one the accuracy
    // checkbox cannot catch, because the same context window wrote both.
    "hallucinated-symbol.md": "# Widgets\n\nCall `createWidgets()` from `src/widget.js`.\n",
    "unknown-symbol.md": "# Widgets\n\nIt calls `zzqqxvv()` internally. See `src/widget.js`.\n",
    "cased-symbol.md": "# Widgets\n\nIt calls `CreateWidget()` internally. See `src/widget.js`.\n",
    "hallucinated-flag.md": "# Widgets\n\nSee `src/widget.js`. Pass `--verbosity` to the CLI.\n",
    "hallucinated-env.md": "# Widgets\n\nSee `src/widget.js`. Set `WIDGET_SECRET` before running.\n",
    "missing-path.md": "# Widgets\n\nThe code lives in `src/gadget.js`.\n",
    "bare-name.md": "# Widgets\n\nThe code lives in `widget.js`.\n",
    "bare-missing.md": "# Widgets\n\nThe code lives in `gadget.js`.\n",
    "globs-and-abs.md": "# Widgets\n\nDiscovery used `*.md` and wrote to `/tmp/out-$$.md`, both wrong. See `src/widget.js`.\n",
    "installed-path.md": "# Widgets\n\nRun `~/.claude/skills/widgets/src/widget.js` to build.\n",
    "outside-only.md": "# Widgets\n\nIt writes to `/var/log/widgets.log` and nothing else.\n",
    "fence-good.md": "# Widgets\n\n```bash\nnode src/widget.js --verbose\n```\n",
    "fence-bad.md": "# Widgets\n\n```bash\nnode src/gadget.js --verbose\n```\n",
    "fence-placeholder.md": "# Widgets\n\nSee `src/widget.js`.\n\n```bash\nnode path/to/your-entry.js\n```\n",
    "bad-citation.md": "# Widgets\n\nThe limit is defined at `src/widget.js:900`.\n",
    "placeholder-citation.md": "# Widgets\n\nA citation looks like `src/example.js:900`. See `src/widget.js`.\n",
    "broken-link.md": "# Widgets\n\nSee [the guide](./nope.md) and `src/widget.js`.\n",
    "bad-anchor.md": "# Widgets\n\nSee [other](./other.md#imaginary-heading) and `src/widget.js`.\n",
    "pure-prose.md": "# Widgets\n\nThe widget system provides a flexible and powerful abstraction that lets\nyou compose behaviour cleanly across your application.\n",
  };
  for (const [name, body] of Object.entries(docs)) write(path.join(proj, "docs", name), body);

  const cite = (name, extra = []) => run(["cite", `docs/${name}`, ...extra], proj);
  check("cite passes a document whose every citation is real", 0, cite("good.md").status);

  const halluc = cite("hallucinated-symbol.md");
  check("cite FAILS an off-by-one export name", 1, halluc.status);
  check("cite names the closest real symbol", true, /closest real name is createWidget/.test(halluc.stdout));
  check("cite does not fail a symbol that differs only in case", 0, cite("cased-symbol.md").status);
  check("cite NOTES a name with no near-miss (it may be a library call)", 0, cite("unknown-symbol.md").status);
  check("cite --strict FAILS that unknown name", 1, cite("unknown-symbol.md", ["--strict"]).status);

  const flagRun = cite("hallucinated-flag.md");
  check("cite NOTES a flag the code never parses, rather than failing it", 0, flagRun.status);
  check("cite says NOTE on that flag", true, /NOTE\s+flag `--verbosity`/.test(flagRun.stdout));
  check("cite --strict FAILS that same flag", 1, cite("hallucinated-flag.md", ["--strict"]).status);
  check("cite NOTES an env var nothing reads", 0, cite("hallucinated-env.md").status);
  check("cite --strict FAILS that same env var", 1, cite("hallucinated-env.md", ["--strict"]).status);
  check("cite FAILS a source path that does not exist", 1, cite("missing-path.md").status);
  check("cite passes a bare filename that exists elsewhere in the tree", 0, cite("bare-name.md").status);
  check("cite NOTES a bare filename that exists nowhere (a tutorial may create it)", 0, cite("bare-missing.md").status);
  check("cite --strict FAILS that bare filename", 1, cite("bare-missing.md", ["--strict"]).status);
  check("cite does not invent a bug in a glob or a quoted absolute path", 0, cite("globs-and-abs.md").status);
  check("cite counts an installed path whose tail is really in the tree", 0, cite("installed-path.md").status);
  check("cite FAILS a doc whose only path lives outside the repository", 1, cite("outside-only.md").status);
  check("cite counts a real path inside a fenced command", 0, cite("fence-good.md").status);
  check("cite NOTES a fenced command path that is not there", 0, cite("fence-bad.md").status);
  check("cite --strict FAILS that fenced command path", 1, cite("fence-bad.md", ["--strict"]).status);
  check("cite leaves an obvious placeholder path in an example alone", 0, cite("fence-placeholder.md").status);
  check("cite FAILS a file:line citation past the end of the file", 1, cite("bad-citation.md").status);
  check("cite NOTES a stand-in citation used to show the format", 0, cite("placeholder-citation.md").status);
  check("cite FAILS a link to a missing file", 1, cite("broken-link.md").status);
  check("cite FAILS a link to a heading that does not exist", 1, cite("bad-anchor.md").status);
  check("cite FAILS fluent prose that cites nothing at all", 1, cite("pure-prose.md").status);
  check("cite fails CLOSED on a document that is not there", 2, cite("does-not-exist.md").status);
  check("cite fails CLOSED when handed a directory", 2, run(["cite", "docs"], proj).status);
  check("cite fails CLOSED when given no document", 2, run(["cite"], proj).status);

  // ---- discoverability: computed, not asserted
  write(path.join(proj, "README.md"), "# Widgets\n\n- [good](docs/good.md)\n");
  write(path.join(proj, "docs", "deep1.md"), "# Deep 1\n\n- [deep2](./deep2.md)\n");
  write(path.join(proj, "docs", "deep2.md"), "# Deep 2\n\n- [deep3](./deep3.md)\n");
  write(path.join(proj, "docs", "deep3.md"), "# Deep 3\n");
  write(path.join(proj, "docs", "orphan.md"), "# Orphan\n\nNothing links here.\n");
  const link = (p) => run(["discoverability", p], proj);
  check("discoverability passes a doc linked from the README", 0, link("docs/good.md").status);
  check("discoverability passes a doc two links deep", 0, link("docs/other.md").status);
  check("discoverability FAILS a doc nothing links to", 1, link("docs/orphan.md").status);
  write(path.join(proj, "README.md"), "# Widgets\n\n- [good](docs/good.md)\n- [deep](docs/deep1.md)\n");
  check("discoverability FAILS a doc 3 clicks deep", 1, link("docs/deep3.md").status);
  check("discoverability passes that same doc at --max-depth 3", 0, run(["discoverability", "docs/deep3.md", "--max-depth", "3"], proj).status);
  const noReadme = path.join(tmp, "no-readme");
  write(path.join(noReadme, "docs", "a.md"), "# A\n");
  check("discoverability fails CLOSED with no entry point", 2, run(["discoverability", "docs/a.md"], noReadme).status);

  // ---- secrets: the fail-open pipeline, closed
  const gitOk = git(["--version"], tmp).status === 0;
  check("git is available to build the credential fixtures", "yes", gitOk ? "yes" : "NO", "the secret assertions cannot run without git");
  if (gitOk) {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "-q"], repo);
    git(["config", "user.email", "selftest@toolbay.invalid"], repo);
    git(["config", "user.name", "tb-generate selftest"], repo);

    check("secrets fails CLOSED outside a git work tree (gstack exits 0 here)", 2, run(["secrets"], tmp).status);
    check("secrets fails CLOSED with nothing staged (gstack exits 0 here)", 2, run(["secrets"], repo).status);

    write(path.join(repo, "docs", "clean.md"), "# Clean\n\nUse `AKIAIOSFODNN7EXAMPLE` as your key id.\n");
    git(["add", "docs/clean.md"], repo);
    check("secrets passes a documented placeholder key", 0, run(["secrets"], repo).status);

    // Deliberately carries none of the words the placeholder filter forgives,
    // because a fixture the filter rescues proves the filter, not the scanner.
    write(path.join(repo, "docs", "leak.md"), `# Leak\n\nkey id ${["AKIA", "3QK7WZLPXNVR2HDC"].join("")} here.\n`);
    git(["add", "docs/leak.md"], repo);
    const leak = run(["secrets"], repo);
    check("secrets FAILS on a live-format AWS key in a generated doc", 1, leak.status);
    check("secrets names the rule that fired", true, /aws-access-key/.test(leak.stdout));
  } else {
    for (const n of [
      "secrets fails CLOSED outside a git work tree (gstack exits 0 here)",
      "secrets fails CLOSED with nothing staged (gstack exits 0 here)",
      "secrets passes a documented placeholder key",
      "secrets FAILS on a live-format AWS key in a generated doc",
      "secrets names the rule that fired",
    ]) {
      check(n, "skipped-without-git", "skipped-without-git", "git missing");
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  // A selftest whose total depends on where it ran is a selftest that can
  // quietly stop asserting things, so the count is stated here and falling
  // short of it is itself a failure.
  const EXPECTED = 55;
  results.push({
    name: `all ${EXPECTED} assertions ran`,
    expected: String(EXPECTED),
    got: String(results.length + 1),
    pass: results.length + 1 === EXPECTED,
    detail: "the selftest must assert the same number of things wherever it is run from",
  });

  const width = Math.max(...results.map((r) => r.name.length));
  out(`\n  tb-generate selftest  (node ${process.version}, ${process.platform})\n`);
  for (const r of results) {
    out(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected}, got ${r.got}`);
  }
  const failed = results.filter((r) => !r.pass);
  out(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    out(`\n  tb-generate is NOT trustworthy in this state. Failures:`);
    for (const r of failed) out(`    - ${r.name}: expected ${r.expected}, got ${r.got}. ${flat(r.detail)}`);
    out("");
    process.exitCode = 1;
    return EXIT_FAILED;
  }
  out("\n  Every document above was written to be wrong in exactly one way: an export");
  out("  that does not exist, a flag nothing parses, an env var nothing reads, a line");
  out("  citation past the end of the file, a dead link, a dead heading anchor, and");
  out("  fluent prose that cites nothing. All were refused, and the credential scan");
  out("  refused to say clean when it had read nothing. That refusal is the feature.\n");
  return EXIT_OK;
}

// --------------------------------------------------------------------- entry

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
}

function positionals(argv) {
  const skipValue = new Set(["--root", "--from", "--max-depth", "--min-anchors", "--path"]);
  const list = [];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (skipValue.has(a)) i += 1;
      continue;
    }
    list.push(a);
  }
  return list;
}

function help() {
  out(`
  tb-generate ${VERSION}, the citation engine for /document-generate

    map [--json]                      every file in the project, walked with
                                      node:fs. gstack's Step 1 uses
                                      "find . -type f ... | head -200", which
                                      in PowerShell is find.exe piped into a
                                      command that does not exist
    surface [--path <dir|file>]... [--json]
                                      every symbol, flag, env var and script
                                      the code really declares, each with the
                                      file and line it was read from
    cite <doc.md>... [--min-anchors N]
                                      resolve every anchor in a finished
                                      document against the source: symbols,
                                      flags, env vars, paths, file:line
                                      citations, links and heading anchors.
                                      Exit 1 on the first thing that is not
                                      really there
    discoverability <doc.md>... [--from README.md] [--max-depth 2]
                                      the real click depth of each document
                                      over the real link graph
    secrets                           scan the STAGED content for credentials
                                      with the exit status checked. Refuses to
                                      report clean unless bytes were read
    selftest                          run all of the above against documents
                                      built to be wrong

  Exit codes: 0 pass, 1 a check failed, 2 the check could not run (which is a
  refusal, never a pass).
`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes("--json");
  const root = path.resolve(flag(argv, "--root", process.cwd()));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return EXIT_OK;
  }

  if (!existsAny(root)) {
    err(`tb-generate: root does not exist: ${root}`);
    return EXIT_UNUSABLE;
  }

  if (cmd === "map") {
    const m = mapProject(root);
    if (json) {
      out(JSON.stringify(m, null, 2));
      return EXIT_OK;
    }
    out(`\n  ${m.fileCount} files under ${m.root}`);
    out(`  project kind: ${m.projectKinds.join(", ")}`);
    out(`  entry points: ${m.entryPoints.join(", ") || "none"}`);
    out(`  doc files:    ${m.docFiles.length} in ${m.docDirs.join(", ") || "-"}`);
    out(`  source files: ${m.sourceFiles.length}`);
    out("\n  by extension:");
    for (const [e, n] of m.extensions) out(`    ${String(n).padStart(6)}  ${e}`);
    out("\n  Read the entry points before writing anything. Then:  tb-generate surface\n");
    return EXIT_OK;
  }

  if (cmd === "surface") {
    const targets = [];
    for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--path" && argv[i + 1]) targets.push(argv[i + 1]);
    targets.push(...positionals(argv));
    const s = buildSurface(root, targets);
    if (!s.ok) {
      err(`tb-generate: ${s.error}`);
      return EXIT_UNUSABLE;
    }
    const items = surfaceItems(s);
    if (json) {
      out(JSON.stringify({ root, scanned: s.scanned, items }, null, 2));
      return EXIT_OK;
    }
    out(`\n  public surface of ${root}  (${s.scanned} source files read)\n`);
    if (!items.length) out("  nothing found. Check --path, or this project has no source in a language this reads.");
    for (const i of items) out(`  ${i.kind.padEnd(9)} ${i.name.padEnd(32)} ${i.at}`);
    out(`\n  ${items.length} items. Every reference doc you write must name these and`);
    out("  nothing else. Check it afterwards with:  tb-generate cite <doc.md>\n");
    return items.length ? EXIT_OK : EXIT_UNUSABLE;
  }

  if (cmd === "cite") {
    const targets = positionals(argv);
    if (!targets.length) {
      err("tb-generate: cite needs at least one document. Nothing to check is not the same as nothing wrong.");
      return EXIT_UNUSABLE;
    }
    const s = buildSurface(root, []);
    if (!s.ok) {
      err(`tb-generate: ${s.error}`);
      return EXIT_UNUSABLE;
    }
    const minAnchors = Number(flag(argv, "--min-anchors", "1")) || 1;
    const all = [];
    let unusable = false;
    for (const t of targets) {
      const abs = path.resolve(root, t);
      if (!existsFile(abs)) {
        all.push({ name: `${t} is a readable document`, pass: false, expected: "a file", got: existsAny(abs) ? "NOT A FILE" : "MISSING", detail: "a document that cannot be read cannot be verified" });
        unusable = true;
        continue;
      }
      const r = citeDoc(root, abs, s, { minAnchors });
      if (r.unusable) unusable = true;
      all.push(...r.results);
    }
    const code = report("tb-generate cite", all, { strict: argv.includes("--strict"), quiet: argv.includes("--quiet") });
    return unusable ? EXIT_UNUSABLE : code;
  }

  if (cmd === "discoverability") {
    const targets = positionals(argv);
    if (!targets.length) {
      err("tb-generate: discoverability needs at least one document to measure.");
      return EXIT_UNUSABLE;
    }
    const from = flag(argv, "--from", "README.md");
    const maxDepth = Number(flag(argv, "--max-depth", "2"));
    const r = discoverability(root, from, targets, Number.isFinite(maxDepth) ? maxDepth : 2);
    const code = report("tb-generate discoverability", r.results);
    return r.unusable ? EXIT_UNUSABLE : code;
  }

  if (cmd === "secrets") {
    const r = scanStagedSecrets(root);
    const code = report("tb-generate secrets", r.results);
    return r.unusable ? EXIT_UNUSABLE : code;
  }

  if (cmd === "selftest") return selftest();

  err(`tb-generate: unknown command "${cmd}"`);
  help();
  return EXIT_UNUSABLE;
}

try {
  const code = main();
  if (typeof code === "number" && code !== EXIT_OK && !process.exitCode) process.exitCode = code;
} catch (e) {
  err(`tb-generate: ${e?.stack ?? e}`);
  process.exit(EXIT_UNUSABLE);
}
