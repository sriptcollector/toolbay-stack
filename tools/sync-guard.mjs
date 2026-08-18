#!/usr/bin/env node
/**
 * sync-guard.mjs: copy every canonical shared engine into the skills that carry
 * it, and fail if any copy has drifted.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * This build tool is not derived from gstack's code, but the skills it keeps in
 * sync include files that are. See LICENSE and NOTICE.
 *
 * WHY A COPY AND NOT A SHARED MODULE: Claude Code installs a skill as a self
 * contained directory. A skill that imports across skill boundaries breaks the
 * moment someone installs only one of them, and the failure mode for a safety
 * skill whose engine is missing is the exact failure this project exists to
 * remove. So each skill carries the whole engine, and this check asserts the
 * copies are byte-identical, so "I fixed careful" cannot silently leave freeze
 * on old code.
 *
 * WHAT IS SHARED THIS WAY:
 *
 *   src/guard/tb-guard.mjs      the safety engine, in every skill that
 *                               registers a PreToolUse hook.
 *   src/secrets/tb-secrets.mjs  the credential stripper, in every skill that
 *                               handles text that could contain one. There is
 *                               exactly one pattern list in this package: the
 *                               Toolbay client redacts its own output with it
 *                               and the memory layer redacts with it before
 *                               anything is stored or synced. Two redactors
 *                               would mean one of them quietly gets a new
 *                               pattern and the other does not.
 *   src/paths/tb-paths.mjs      MSYS path conversion and the absolute-path
 *                               test, previously copied into 26 and 22 engines.
 *   src/outdir/tb-outdir.mjs    the /tmp refusal and the output-directory
 *                               resolver, previously 16 copies of the refusal.
 *   src/ledger/tb-ledger.mjs    the evidence ledger, previously written by hand
 *                               eight times. This is the file the whole package
 *                               is about, and it was its most duplicated code.
 *   src/artifact/tb-artifact.mjs  the evidence gate. Before this, how strict a
 *                               "verified pass" was depended on which skill ran.
 *   src/color/tb-color.mjs      the WCAG contrast arithmetic, written twice,
 *                               with a rounding difference that decided
 *                               pass/fail.
 *   src/browse-bin/tb-browse-bin.mjs  the browse-daemon lookup, written twice,
 *                               with a search-order difference that was a live
 *                               bug.
 *   src/context-format/tb-context-format.mjs  the saved-context file format.
 *                               Two private copies of "which field holds the
 *                               save time", and they disagreed, so the save/
 *                               restore pair had never round-tripped once.
 *   src/citations/tb-citations.mjs  "does this file:line exist". /spec checked
 *                               it, /investigate's DONE gate did not.
 *
 * A spec may also name `alsoInto` directories outside skills/, for the case
 * where a canonical engine in src/ imports another shared module and therefore
 * needs a copy of it beside itself to run standalone.
 *
 *   node tools/sync-guard.mjs          write the copies
 *   node tools/sync-guard.mjs --check  fail if any copy is stale (CI)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPECS = [
  {
    // The two path helpers that decide where every artifact this package
    // promises as evidence is written and read back. Copied by hand into 26
    // and 22 engines respectively, with five variants of the first and three
    // of the second on disk before this row existed.
    src: path.join(ROOT, "src", "paths", "tb-paths.mjs"),
    file: "tb-paths.mjs",
    targets: [
      "autoplan", "benchmark", "canary", "careful", "context-restore", "context-save",
      "design-consultation", "design-review", "design-shotgun", "devex-review", "freeze",
      "guard", "health", "investigate", "ios-design-review", "ios-fix", "ios-sync",
      "land-and-deploy", "learn", "plan-ceo-review", "plan-design-review",
      "plan-devex-review", "plan-eng-review", "plan-tune", "qa", "qa-only",
      "setup-deploy", "skillify", "video",
    ],
    // The canonical guard engine imports this too, and it is run from src/ by
    // tools/run-tests.mjs, so it needs the module beside it there as well.
    alsoInto: [path.join(ROOT, "src", "guard"), path.join(ROOT, "src", "outdir")],
  },
  {
    src: path.join(ROOT, "src", "guard", "tb-guard.mjs"),
    file: "tb-guard.mjs",
    // `investigate` is here because its scope lock registers the same PreToolUse
    // hook, and a hook that reaches across into another skill's directory is
    // exactly the "the script was not there, so allow the edit" failure this
    // project exists to remove.
    targets: ["careful", "freeze", "guard", "investigate"],
  },
  {
    src: path.join(ROOT, "src", "secrets", "tb-secrets.mjs"),
    file: "tb-secrets.mjs",
    targets: ["toolbay", "memory"],
  },
  {
    // The gstack browse-daemon lookup. It was written twice by hand and the two
    // copies disagreed about whether to search the git root, so /scrape run
    // from a subdirectory reported "browse binary not found" while /browse,
    // from the same cwd, found it. One resolver now, asserted identical.
    src: path.join(ROOT, "src", "browse-bin", "tb-browse-bin.mjs"),
    file: "tb-browse-bin.mjs",
    targets: ["browse", "scrape"],
  },
  {
    // The WCAG contrast arithmetic. design-consultation proposes the palette
    // and design-review audits the page built from it, so two formulas here
    // means a pair can be approved by one and failed by the other.
    src: path.join(ROOT, "src", "color", "tb-color.mjs"),
    file: "tb-color.mjs",
    targets: ["design-consultation", "design-review"],
  },
  {
    // The evidence gate. Before this row, how strict a "verified pass" was
    // depended on which skill ran: qa accepted any non-zero file, browse
    // checked eight signature bytes, devex-review added a size floor.
    src: path.join(ROOT, "src", "artifact", "tb-artifact.mjs"),
    file: "tb-artifact.mjs",
    targets: ["browse", "devex-review", "qa", "qa-only", "video"],
    // src/video/tb-video-evidence.mjs imports it and is run standalone by
    // tools/run-tests.mjs, so it needs the module beside it in src/ too.
    alsoInto: [path.join(ROOT, "src", "video")],
  },
  {
    // The video evidence gate: duration and aspect read out of the container.
    // It is a separate file from tb-artifact rather than an extension of it
    // because tb-artifact answers "is this file real" and ships inside four
    // skills that will never open a video, while this answers "is this the
    // video that was specified" and needs the spec as an argument.
    src: path.join(ROOT, "src", "video", "tb-video-evidence.mjs"),
    file: "tb-video-evidence.mjs",
    targets: ["video"],
  },
  {
    // The /tmp refusal and the output-directory resolver, previously 16 copies
    // of the refusal list and six of the resolver, each with its own wording.
    src: path.join(ROOT, "src", "outdir", "tb-outdir.mjs"),
    file: "tb-outdir.mjs",
    targets: [
      "benchmark", "canary", "design-consultation", "design-review", "devex-review",
      "ios-fix", "land-and-deploy", "qa", "qa-only", "setup-deploy", "video",
    ],
  },
  {
    // The saved-context FORMAT: which frontmatter field holds the save time,
    // which clock it is on, and which directory the drawer is in. Those three
    // answers were written twice, privately, and all three disagreed, so
    // /context-save and /context-restore shipped as a paired feature that had
    // never once round-tripped. Both engines now read the format from one file.
    src: path.join(ROOT, "src", "context-format", "tb-context-format.mjs"),
    file: "tb-context-format.mjs",
    targets: ["context-save", "context-restore"],
  },
  {
    // "Does the file:line this claim cites actually exist." /spec's linter had
    // it and /investigate's report gate did not, so the gate whose whole job is
    // refusing unevidenced claims accepted a citation to a file that has never
    // existed. Sharing it here rather than copying those thirty lines is the
    // difference between fixing this once and fixing it again in six weeks.
    src: path.join(ROOT, "src", "citations", "tb-citations.mjs"),
    file: "tb-citations.mjs",
    targets: ["investigate", "spec"],
  },
  {
    // The evidence ledger. This is what the package is for, and it had been
    // written by hand eight times, with eight versions of what a ledger that
    // cannot be read means. It means an error, everywhere, now.
    src: path.join(ROOT, "src", "ledger", "tb-ledger.mjs"),
    file: "tb-ledger.mjs",
    targets: [
      "canary", "design-review", "ios-clean", "ios-design-review", "ios-fix",
      "land-and-deploy", "qa", "qa-only",
    ],
  },
];

const check = process.argv.includes("--check");
let stale = 0;

for (const spec of SPECS) {
  let source;
  try {
    source = fs.readFileSync(spec.src);
  } catch (err) {
    // A missing canonical source is not "nothing to sync". It means every copy
    // on disk is unverifiable, which must never read as a pass.
    process.stdout.write(`  MISSING ${path.relative(ROOT, spec.src).split(path.sep).join("/")} (${err.code || err.message})\n`);
    stale += 1;
    continue;
  }
  const dests = [
    ...spec.targets.map((skill) => path.join(ROOT, "skills", skill, "scripts", spec.file)),
    ...(spec.alsoInto || []).map((dir) => path.join(dir, spec.file)),
  ];
  for (const dest of dests) {
    const rel = path.relative(ROOT, dest).split(path.sep).join("/");
    const same = fs.existsSync(dest) && fs.readFileSync(dest).equals(source);
    if (same) {
      process.stdout.write(`  ok      ${rel}\n`);
      continue;
    }
    if (check) {
      process.stdout.write(`  STALE   ${rel}\n`);
      stale += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source);
    process.stdout.write(`  wrote   ${rel}\n`);
  }
}

if (stale) {
  process.stdout.write(`\n  ${stale} copy/copies are out of date. Run: node tools/sync-guard.mjs\n`);
  process.exitCode = 1;
}
