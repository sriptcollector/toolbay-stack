#!/usr/bin/env node
/**
 * tb-video.mjs — plain prompt in, finished video out.
 *
 * Toolbay Stack, Copyright (c) 2026 Toolbay. MIT licensed. Original work.
 * Part of Toolbay Stack, built on gstack by Garry Tan
 * (https://github.com/garrytan/gstack, MIT, Copyright (c) 2026 Garry Tan).
 * gstack has no video layer and no code or contract here is derived from it.
 * See LICENSE and NOTICE.
 *
 * WHAT THIS IS. Diffusion Studio's `dapi` is a real video editor with a real
 * timeline, and the price of that is that driving it means knowing what a
 * composition, a scene root, a sequence and a keyframe are. This file is the
 * layer that means you do not. You type the sentence you would have said to a
 * person — "make me a video showing off Toolbay" — and this decides the format,
 * the length, the shots and the pacing, writes the composition, drives dapi,
 * and refuses to tell you it worked unless a file came out the other end that
 * is genuinely video of genuinely the right length and shape.
 *
 * THE PART THAT MAKES IT FEEL LIKE A PERSON, and the reason this is not a form:
 * every decision is printed with the reason it was made. "9:16 because you said
 * Reels." "22 seconds because that is the drop-off cliff." A decision you can
 * see is a decision you can overrule in one sentence, and a wrong guess costs a
 * sentence instead of a render. A form would have asked six questions up front
 * and got the same answers wrong more slowly.
 *
 * WHAT IT REFUSES TO DO. It never says a video was made. It says a FILE exists,
 * is MP4 or WebM by its own container bytes, runs for the number of seconds the
 * plan asked for, and is the aspect the plan asked for — or it exits non-zero
 * and says which of those is false. The most valuable output of a render
 * pipeline is the word "no", because the alternative is a green log over a
 * 1.4-second landscape file that nobody opened until it was posted.
 *
 * WHERE THE TASTE LIVES. Not here. Every platform, duration, aspect, shot,
 * colour, phrase-to-meaning mapping and explanation sentence is in video.json,
 * the same way modes.json holds the stances and memory.json holds the kinds.
 * This file knows that a platform has a duration and a reason. It does not know
 * that Reels is 9:16 or that 22 seconds is the cliff. Argue with the JSON.
 *
 *   node tb-video.mjs make "<prompt>"      plan, compose, render, verify
 *   node tb-video.mjs plan "<prompt>"      decide and explain, render nothing
 *   node tb-video.mjs compose "<prompt>"   plan and write the .jsx, render nothing
 *   node tb-video.mjs verify <file> [--spec <spec.json>]
 *   node tb-video.mjs remember "<what>" --because "<why>"
 *   node tb-video.mjs doctor
 *   node tb-video.mjs selftest
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkVideoArtifact, makeTinyMp4 } from "./tb-video-evidence.mjs";
import { resolveOutDir } from "./tb-outdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const CONFIG_FILE = process.env.TB_VIDEO_CONFIG || path.join(SKILL_DIR, "video.json");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const cyan = (s) => c("36", s);
const out = (s = "") => process.stdout.write(`${s}\n`);

/** Exit codes are part of the contract: 0 done, 1 refused, 2 one answer needed. */
export const EXIT = { ok: 0, refused: 1, question: 2 };

// ------------------------------------------------------------------- config

/**
 * Load video.json, and refuse rather than fall back to a built-in default.
 *
 * There is no built-in default on purpose. A skill that silently substitutes
 * hard-coded values when its config is unreadable is a skill whose config is a
 * suggestion, and then nobody can tell whether the 22 seconds on screen came
 * from the file they edited.
 */
export function loadConfig(file = CONFIG_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`video.json could not be read at ${file} (${e.code || e.message}). Every value this skill uses lives in that file, so there is nothing to fall back to.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`video.json is not valid JSON (${e.message}). Refusing to plan a video from a config that cannot be read.`);
  }
  for (const key of ["platforms", "purposes", "tones", "beats", "defaults", "verify", "engine", "subject", "output"]) {
    if (!cfg[key] || typeof cfg[key] !== "object") {
      throw new Error(`video.json has no "${key}" section, so this skill has no ${key} to work from.`);
    }
  }
  if (!cfg.platforms[cfg.defaults.platform]) {
    throw new Error(`video.json's default platform "${cfg.defaults.platform}" is not one of its platforms.`);
  }
  return cfg;
}

// ----------------------------------------------------------------- matching

const normalize = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9:. /-]+/g, " ").replace(/\s+/g, " ").trim()} `;

/**
 * Does `text` contain `phrase`, and how strong is that.
 *
 * Whole-word for single tokens (so "ig" does not fire inside "big"), substring
 * for phrases that already contain a space. Score is the phrase length, so a
 * longer phrase always beats a shorter one that it contains: "youtube shorts"
 * outranks "youtube".
 */
export function phraseScore(text, phrase) {
  const hay = normalize(text);
  const needle = String(phrase).toLowerCase().trim();
  if (!needle) return 0;
  const hit = needle.includes(" ") ? hay.includes(needle) : hay.includes(` ${needle} `);
  return hit ? needle.length : 0;
}

/** The best-scoring key of a {key: {match: [...]}} table, or null. */
export function bestMatch(text, table) {
  let best = null;
  let bestScore = 0;
  for (const [key, def] of Object.entries(table)) {
    if (key.startsWith("_") || !def || !Array.isArray(def.match)) continue;
    for (const phrase of def.match) {
      const s = phraseScore(text, phrase);
      if (s > bestScore) {
        bestScore = s;
        best = key;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ subject

/** Pull the thing the video is ABOUT out of a sentence, per video.json. */
export function extractSubject(prompt, cfg) {
  const sub = cfg.subject;
  let text = String(prompt || "").trim();
  // Longest strip phrase first, so "make me a video showing off X" loses the
  // whole lead-in rather than leaving "showing off" behind.
  const strips = [...(sub.strip || [])].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of strips) {
      const re = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (re.test(text)) {
        text = text.replace(re, "$1 $2");
        changed = true;
      }
    }
  }
  // Anything that was a decision (a platform name, a duration, a tone) is not
  // the subject. Those are stripped by their own match tables, so the subject
  // never comes out as "Toolbay for instagram 20 seconds".
  const decisionPhrases = [
    ...Object.values(cfg.platforms).flatMap((p) => p.match || []),
    ...Object.values(cfg.purposes).flatMap((p) => p.match || []),
    ...Object.values(cfg.tones).flatMap((t) => t.match || []),
    ...(cfg.durationHints || []).flatMap((h) => h.match || []),
    ...(cfg.aspectOverride?.options || []).flatMap((o) => o.match || []),
    ...Object.values(cfg.beats).flatMap((b) => (b.match ? b.match : [])),
  ].sort((a, b) => b.length - a.length);
  for (const phrase of decisionPhrases) {
    const re = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "ig");
    text = text.replace(re, "$1 $2");
  }
  text = text.replace(/\b\d+(\.\d+)?\s*(s|secs?|seconds?|mins?|minutes?)\b/gi, " ");
  text = text.replace(/[^A-Za-z0-9 .&'+/-]+/g, " ").replace(/\s+/g, " ").trim();

  const fillers = new Set((sub.leadingFillers || []).map((w) => w.toLowerCase()));
  let words = text.split(" ").filter(Boolean);
  while (words.length && fillers.has(words[0].toLowerCase())) words.shift();
  while (words.length && fillers.has(words[words.length - 1].toLowerCase())) words.pop();
  words = words.slice(0, sub.maxWords || 8);
  const subject = words.join(" ").trim();
  if (subject.replace(/[^A-Za-z0-9]/g, "").length < (sub.minChars || 2)) return null;
  return subject;
}

// ----------------------------------------------------------------- duration

const numberWord = (text, cfg) => {
  for (const [phrase, seconds] of Object.entries(cfg.explicitDuration?.words || {})) {
    if (phraseScore(text, phrase)) return seconds;
  }
  return null;
};

/** A duration the user typed, in seconds, or null. */
export function extractDuration(prompt, cfg) {
  const spec = cfg.explicitDuration;
  if (!spec) return null;
  const hay = normalize(prompt);
  for (const unit of Object.values(spec.units || {})) {
    for (const token of unit.match || []) {
      const re = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const m = re.exec(hay);
      if (m) return Number(m[1]) * (unit.multiplier || 1);
    }
  }
  return numberWord(prompt, cfg);
};

// ------------------------------------------------------------------- memory

/**
 * Ask skills/memory/ what this person has already corrected.
 *
 * This skill stores nothing of its own. The memory layer already keeps a
 * correction WITH the reason it was given, strips credentials before the write,
 * and can be listed and deleted, and a second private store would be a second
 * thing to audit and a second thing to forget to delete.
 *
 * Returns {on, reason, entries, reachable}. Unreachable is never fatal: a
 * missing memory layer degrades to "planned from video.json alone", said out
 * loud, rather than to a crash.
 */
export function recallMemory(cfg, { cwd = process.cwd(), scriptOverride = null } = {}) {
  const script = scriptOverride ?? path.resolve(SKILL_DIR, cfg.memory?.script || "");
  if (!script || !fs.existsSync(script)) {
    return { on: false, reachable: false, reason: "the memory skill is not installed beside this one", entries: [] };
  }
  // No query by default, and that is load-bearing. `recall <query>` SCORES
  // entries against the query, so asking for "video" returns nothing: the
  // sentence people actually record is "always end on the logo", which shares
  // not one word with it. Relevance is decided here instead, by running each
  // entry through the very same match tables in video.json that the prompt goes
  // through — which is the only reason a correction phrased in any of a dozen
  // ways still lands on the right beat.
  const query = cfg.memory?.recallQuery ? [cfg.memory.recallQuery] : [];
  const r = spawnSync(process.execPath, [script, "recall", ...query, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { on: false, reachable: false, reason: r.error.message, entries: [] };
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { on: false, reachable: false, reason: "the memory layer answered with something that is not JSON", entries: [] };
  }
  const entries = Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.text === "string") : [];
  return { on: doc.on === true, reachable: true, reason: doc.reason || null, entries };
}

// -------------------------------------------------------------------- plan

const round2 = (n) => Math.round(n * 100) / 100;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "video";

/**
 * Turn a sentence into a spec, and a reason for every line of it.
 *
 * `remembered` entries only apply where the PROMPT WAS SILENT. What someone
 * just typed always beats what they said last month, otherwise a preference
 * recorded once becomes impossible to override without deleting it, which is
 * the failure that makes people turn memory off.
 */
export function plan(prompt, cfg, { memory = null, assume = false, footage = [], logo = null, lines = [] } = {}) {
  const decisions = [];
  const notes = [];
  const say = (what, value, why, source = "read from what you said") =>
    decisions.push({ what, value: String(value), why, source });

  const text = String(prompt || "");
  const subject = extractSubject(text, cfg);
  if (!subject) {
    return { ok: false, why: cfg.subject.refuseWhy, decisions, notes };
  }

  const remembered = (memory?.entries || []).map((e) => e.text);
  const rememberedNote = (entryText) => (cfg.memory?.appliedNote || "{text}").replace("{text}", entryText);
  const findRemembered = (table) => {
    for (const t of remembered) {
      const key = bestMatch(t, table);
      if (key) return { key, entry: t };
    }
    return null;
  };

  // ---- platform, and the aspect that comes with it
  let platformKey = bestMatch(text, cfg.platforms);
  let platformSource = "read from what you said";
  const platformSignal = Boolean(platformKey);
  if (!platformKey) {
    const r = findRemembered(cfg.platforms);
    if (r) {
      platformKey = r.key;
      platformSource = rememberedNote(r.entry);
    }
  }
  const platformRemembered = !platformSignal && Boolean(platformKey);
  if (!platformKey) platformKey = cfg.defaults.platform;
  const platform = cfg.platforms[platformKey];

  // ---- an aspect said out loud beats the platform's
  let aspect = platform.aspect;
  let width = platform.width;
  let height = platform.height;
  let aspectWhy = platform.why?.aspect || `${aspect}, the default for ${platform.label}.`;
  let aspectSignal = false;
  for (const opt of cfg.aspectOverride?.options || []) {
    if ((opt.match || []).some((m) => phraseScore(text, m))) {
      aspect = opt.aspect;
      width = opt.width;
      height = opt.height;
      aspectWhy = opt.why;
      aspectSignal = true;
      break;
    }
  }

  // ---- purpose: the shot grammar
  let purposeKey = bestMatch(text, cfg.purposes);
  const purposeSignal = Boolean(purposeKey);
  let purposeSource = "read from what you said";
  if (!purposeKey) {
    const r = findRemembered(cfg.purposes);
    if (r) {
      purposeKey = r.key;
      purposeSource = rememberedNote(r.entry);
    }
  }
  if (!purposeKey) {
    purposeKey = cfg.defaults.purpose;
    if (purposeSource === "read from what you said") purposeSource = "the default in video.json, because nothing said otherwise";
  }
  const purpose = cfg.purposes[purposeKey];

  // ---- tone: motion and typography
  let toneKey = bestMatch(text, cfg.tones);
  let toneSource = "read from what you said";
  if (!toneKey) {
    const r = findRemembered(cfg.tones);
    if (r) {
      toneKey = r.key;
      toneSource = rememberedNote(r.entry);
    }
  }
  if (!toneKey) {
    toneKey = cfg.defaults.tone;
    if (toneSource === "read from what you said") toneSource = "the default in video.json, because nothing said otherwise";
  }
  const tone = cfg.tones[toneKey];

  // ---- duration
  const ed = cfg.explicitDuration || {};
  let seconds = platform.seconds;
  let secondsWhy = platform.why?.seconds || `${seconds} seconds, the default for ${platform.label}.`;
  let secondsSource = "the default for this surface";
  const explicit = extractDuration(text, cfg);
  if (explicit !== null) {
    if (explicit > (ed.maxSeconds ?? Infinity)) {
      return {
        ok: false,
        why: (ed.tooLong || "").replace("{seconds}", String(explicit)).replace("{max}", String(ed.maxSeconds)),
        decisions,
        notes,
      };
    }
    if (explicit < (ed.minSeconds ?? 0)) {
      return {
        ok: false,
        why: (ed.tooShort || "").replace("{seconds}", String(explicit)).replace("{min}", String(ed.minSeconds)),
        decisions,
        notes,
      };
    }
    seconds = explicit;
    secondsWhy = (ed.why || "{seconds} seconds.").replace("{seconds}", String(explicit));
    secondsSource = "read from what you said";
  } else {
    for (const hint of cfg.durationHints || []) {
      if ((hint.match || []).some((m) => phraseScore(text, m))) {
        seconds = round2(seconds * hint.scale);
        secondsWhy = `${seconds} seconds. ${hint.why}`;
        secondsSource = "read from what you said";
        break;
      }
    }
  }

  // ---- beats: the shot list
  const beatKeys = [...(purpose.beats || [])];
  // A remembered beat ("always end on the logo") is appended if it is not
  // already in the grammar. This is the whole point of the memory loop: the
  // sentence is never matched by this file, it is matched by the same beat
  // match table the prompt is matched against.
  const beatNotes = [];
  for (const entryText of remembered) {
    const key = bestMatch(entryText, cfg.beats);
    if (key && !beatKeys.includes(key)) {
      beatKeys.push(key);
      beatNotes.push({ key, entry: entryText });
    }
  }
  // A beat named in the prompt itself is appended the same way.
  for (const [key, def] of Object.entries(cfg.beats)) {
    if (key.startsWith("_") || !Array.isArray(def.match)) continue;
    if (def.match.some((m) => phraseScore(text, m)) && !beatKeys.includes(key)) beatKeys.push(key);
  }

  const totalWeight = beatKeys.reduce((sum, k) => sum + (cfg.beats[k]?.weight || 1), 0);
  let cursor = 0;
  const shots = beatKeys.map((key, i) => {
    const beat = cfg.beats[key];
    const span = round2((seconds * (beat.weight || 1)) / totalWeight);
    const start = round2(cursor);
    // The last shot absorbs the rounding, so the composition's own end is
    // exactly the duration the plan promised and the verifier is checking.
    const end = i === beatKeys.length - 1 ? seconds : round2(cursor + span);
    cursor = end;
    // The words on screen are resolved HERE rather than at compose time, so
    // they land in the spec where they can be read and argued with. A line
    // supplied by the caller wins; otherwise the beat's own template does, and
    // that template only ever says the subject back. Nothing here invents a
    // claim about the product, because a plausible sentence nobody wrote is
    // worse than an obvious placeholder.
    const template = (beat.text || "{subject}").replace(/\{(\w+)\}/g, "<<$1>>");
    const copy = lines[i] || fill(template, { subject, index: i + 1 });
    return { beat: key, label: beat.label, start, end, why: beat.why, index: i + 1, copy, copyFrom: lines[i] ? "you" : "default" };
  });

  const fontBase = (width + height) / 2;
  const spec = {
    prompt: text,
    subject,
    slug: slugify(subject),
    platform: platformKey,
    platformLabel: platform.label,
    aspect,
    width,
    height,
    fps: platform.fps,
    seconds,
    purpose: purposeKey,
    tone: toneKey,
    container: cfg.defaults.container,
    palette: { background: tone.background, ink: tone.ink, accent: tone.accent },
    motion: { animIn: tone.animIn, animOut: tone.animOut, animDuration: tone.animDuration, fontWeight: tone.fontWeight },
    fontBase,
    footage,
    logo,
    shots,
  };

  say("what it is about", subject, cfg.subject.why.replace("{subject}", subject));
  const surfaceWhy = platform.why?.surface || `The ${platform.label} surface, as configured in video.json.`;
  say(
    "where it goes",
    platform.label,
    platformRemembered ? `${surfaceWhy} ${platformSource}` : surfaceWhy,
    platformRemembered ? platformSource : platformSignal ? "read from what you said" : "the default in video.json, because nothing said otherwise",
  );
  say("aspect ratio", aspect, aspectWhy, aspectSignal ? "read from what you said" : "comes with the surface");
  say("how long", `${seconds}s`, secondsWhy, secondsSource);
  say("what shape of video", purpose.label, purpose.why, purposeSource);
  say("how it moves", tone.label, tone.why, toneSource);
  // The shot list is the one decision with internal structure, so it carries
  // its parts rather than being flattened into a paragraph nobody reads.
  decisions.push({
    what: "the shot list",
    value: shots.map((s) => s.label).join(" → "),
    why: `${shots.length} shots filling the ${seconds}s exactly, each sized by the weight in video.json.`,
    source: "built from the shape above",
    shots: shots.map((s) => ({ label: s.label, span: `${s.start}-${s.end}s`, why: s.why, copy: s.copy })),
  });

  // Said plainly rather than hidden, because it is the honest weakness of a
  // one-sentence brief: nobody told this what the video should SAY, and a
  // sentence invented here would be a claim about a product nobody made.
  const defaultCopy = shots.filter((s) => s.copyFrom === "default").map((s) => s.copy);
  if (defaultCopy.length && new Set(defaultCopy).size < defaultCopy.length) {
    notes.push(
      `Every shot currently says "${subject}", because nothing said what it should say. ` +
        `Give it real lines with --line "..." once per shot, or just tell me what each shot should say. ` +
        `Nothing was invented for you: a plausible sentence nobody wrote is worse than an obvious placeholder.`,
    );
  }

  for (const n of beatNotes) {
    notes.push(`Added a ${cfg.beats[n.key].label} shot. ${rememberedNote(n.entry)}`);
  }

  // ---- the one question, asked only when guessing wrong wastes the render
  let question = null;
  const conditions = { noPlatformSignal: !platformSignal && !platformRemembered, noAspectSignal: !aspectSignal, noPurposeSignal: !purposeSignal };
  const askWhen = cfg.question?.askWhen || [];
  const shouldAsk = askWhen.length > 0 && askWhen.every((cond) => conditions[cond] === true);
  if (shouldAsk && !assume) {
    question = {
      text: cfg.question.text,
      hint: cfg.question.hint,
      options: Object.entries(cfg.platforms).map(([k, p]) => ({ key: k, label: p.label, aspect: p.aspect, seconds: p.seconds })),
      defaultNote: (cfg.question.defaultNote || "").replace("{label}", platform.label).replace("{aspect}", aspect),
    };
  } else if (shouldAsk && assume) {
    notes.push((cfg.question.defaultNote || "").replace("{label}", platform.label).replace("{aspect}", aspect));
  }

  if (memory && !memory.on) {
    notes.push(memory.reachable ? cfg.memory.offNote : (cfg.memory.unavailableNote || "").replace("{reason}", memory.reason || "unknown"));
  }

  return { ok: true, spec, decisions, notes, question };
}

// ---------------------------------------------------------------- composing

/**
 * Substitute <<token>> in a template.
 *
 * The delimiter is angle brackets and NOT the usual {{token}} for one reason:
 * the templates being filled are JSX, where braces are syntax. `start={{start}}`
 * substituted with a brace-delimited token yields `start=0`, which is not valid
 * JSX and which every check short of compiling it will wave through. Written as
 * `start={<<start>>}` the braces belong to the JSX and the delimiter cannot
 * collide with them. This cost one real bug to learn.
 */
const fill = (template, tokens) =>
  String(template).replace(/<<(\w+)>>/g, (_, key) => (key in tokens ? String(tokens[key]) : `<<${key}>>`));

/**
 * Write the composition as JSX, against Diffusion Studio's real contract.
 *
 * The shape is not negotiable and comes from the editor's own reference: a
 * project module default-exports a Solid component; only a `<rect>` promoted
 * with `scene` is mountable as a root; every position is explicit in pixels;
 * clips get `start`/`end` on the parent timeline. The beat bodies themselves
 * come out of video.json, so what a "hook" looks like is an edit to a JSON
 * file and not to this function.
 */
export function composeJsx(spec, cfg) {
  const lines = [];
  const shotSource = [];
  for (const shot of spec.shots) {
    const beat = cfg.beats[shot.beat];
    const footage = spec.footage?.[shotSource.length] || spec.footage?.[0] || null;
    const wantsFootage = beat.requiresFootage === true;
    const haveAsset = shot.beat === "logo" ? Boolean(spec.logo) : Boolean(footage);
    const body = haveAsset || !beat.placeholderJsx ? beat.jsx : beat.placeholderJsx;
    const tokens = {
      width: spec.width,
      height: spec.height,
      start: shot.start,
      end: shot.end,
      sourceIn: 0,
      index: shot.index,
      subject: spec.subject,
      ink: spec.palette.ink,
      accent: spec.palette.accent,
      background: spec.palette.background,
      fontWeight: spec.motion.fontWeight,
      fontSize: Math.round((beat.fontScale || 0.05) * spec.fontBase),
      animIn: spec.motion.animIn,
      animOut: spec.motion.animOut,
      animDuration: spec.motion.animDuration,
      footage: footage || "",
      logo: spec.logo || "",
    };
    // The copy was resolved at plan time and lives in the spec, so what the
    // composition says is whatever the spec says it says — editing spec.json
    // and re-composing is a supported way to change the words.
    tokens.text = shot.copy ?? fill((beat.text || "{subject}").replace(/\{(\w+)\}/g, "<<$1>>"), tokens);
    if (wantsFootage && footage) shotSource.push(footage);
    const rendered = (Array.isArray(body) ? body : [String(body)]).map((l) => fill(l, tokens));
    lines.push(`        {/* ${shot.label}: ${shot.start}s to ${shot.end}s */}`);
    for (const l of rendered) lines.push(`        ${l}`);
  }

  return `/**
 * ${spec.subject} — ${spec.platformLabel}, ${spec.aspect}, ${spec.seconds}s.
 *
 * Generated by Toolbay Stack's video skill from the prompt:
 *   "${spec.prompt.replace(/\*\//g, "*\\/")}"
 *
 * Every element here is a real entity in the editor after \`dapi mount\`, so
 * anything below can be dragged, retimed or restyled by hand afterwards; the
 * mount is a starting point, not a black box. Re-running the mount rebuilds
 * this scene in place rather than adding a second copy of it.
 */

export default function Project() {
  return (
    <rect
      scene="${spec.slug}"
      name="${spec.subject}"
      width={${spec.width}}
      height={${spec.height}}
      fill="${spec.palette.background}"
    >
      <sequence name="${spec.purpose}">
${lines.join("\n")}
      </sequence>
    </rect>
  );
}
`;
}

// ------------------------------------------------------------------- engine

/** Every name a binary can have on this platform. */
function candidateNames(bin) {
  if (process.platform !== "win32") return [bin];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [bin, ...exts.map((e) => bin + e.toLowerCase()), ...exts.map((e) => bin + e)];
}

/**
 * Find dapi, or say precisely that it is not here.
 *
 * TB_VIDEO_ENGINE_BIN overrides the name, which is how the selftest proves the
 * absent-CLI path without uninstalling anything.
 */
export function findEngine(cfg) {
  const bin = process.env.TB_VIDEO_ENGINE_BIN || cfg.engine.bin;
  if (path.isAbsolute(bin)) {
    return fs.existsSync(bin) ? { ok: true, bin, path: bin } : { ok: false, bin, why: `${bin} does not exist` };
  }
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidateNames(bin)) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return { ok: true, bin, path: full };
      } catch { /* not here; keep looking */ }
    }
  }
  return { ok: false, bin, why: `\`${bin}\` is not on PATH` };
}

/**
 * Run the engine, including when Windows has installed it as a shim.
 *
 * A CLI on Windows is very often a `.cmd` or `.bat` next to the real binary,
 * and since Node 18.20 spawning one of those WITHOUT `shell: true` fails with
 * EINVAL rather than running it. Without this branch the skill would report
 * "dapi is not on PATH" on a machine where dapi is on PATH, which is the worst
 * kind of wrong: a fail-closed message that is closed for the wrong reason.
 * Under a shell the arguments are re-parsed, so anything containing a space is
 * quoted here — and a rendered path with a space in it is the normal case on
 * Windows, not the exotic one.
 */
function runEngine(enginePath, args, { cwd, timeout }) {
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(enginePath);
  const quote = (s) => (/[\s&|<>^]/.test(s) ? `"${s}"` : s);
  // Under a shell the whole invocation goes as ONE string. Passing an args
  // array alongside shell:true is deprecated in Node (DEP0190) precisely
  // because the two get concatenated without escaping, which is the bug this
  // quoting is here to avoid.
  const command = viaShell ? [enginePath, ...args].map(quote).join(" ") : enginePath;
  const r = spawnSync(command, viaShell ? [] : args, {
    cwd,
    encoding: "utf8",
    timeout,
    shell: viaShell,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error ? r.error.message : null,
  };
}

const expandArgs = (args, tokens) => args.map((a) => fill(a.replace(/\{(\w+)\}/g, "<<$1>>"), tokens));

/**
 * Drive dapi and then refuse to believe it.
 *
 * The two commands are the ones the editor documents (`dapi mount <file>`, then
 * `dapi node render -o <file>`); their exact spelling lives in video.json's
 * engine block so a CLI change is a config edit. A zero exit status from either
 * proves nothing on its own — an encoder that dies after writing its header
 * exits 0 on some platforms and leaves a file that opens in nothing — so the
 * verdict comes from the bytes and never from the status.
 */
export function render(spec, cfg, { dir, engine, dryRun = false }) {
  const outFile = path.join(dir, (cfg.output.renderFile || "{slug}.{container}").replace("{slug}", spec.slug).replace("{container}", spec.container));
  const composition = path.join(dir, cfg.output.compositionFile);
  const steps = [];

  if (!engine.ok) {
    return { ok: false, why: `Refused: ${engine.why}, so no render was attempted and no file was produced.`, steps, outFile, engineMissing: true };
  }
  if (dryRun) return { ok: false, why: "dry run: dapi was found but not invoked", steps, outFile, dryRun: true };

  const timeout = cfg.engine.timeoutMs || 900000;
  const mount = runEngine(engine.path, expandArgs(cfg.engine.mountArgs, { composition }), { cwd: dir, timeout });
  steps.push({ step: "mount", ok: mount.ok, detail: mount.error || `exit ${mount.status}` });
  if (!mount.ok) {
    return {
      ok: false,
      why: `Refused: \`${cfg.engine.bin} mount\` failed (${mount.error || `exit ${mount.status}`}). The composition was written to ${composition} and nothing was rendered.`,
      steps,
      outFile,
      log: `${mount.stdout}${mount.stderr}`.trim(),
    };
  }

  const enc = runEngine(engine.path, expandArgs(cfg.engine.renderArgs, { output: outFile }), { cwd: dir, timeout });
  steps.push({ step: "render", ok: enc.ok, detail: enc.error || `exit ${enc.status}` });
  if (!enc.ok) {
    return {
      ok: false,
      why: `Refused: \`${cfg.engine.bin} node render\` failed (${enc.error || `exit ${enc.status}`}).`,
      steps,
      outFile,
      log: `${enc.stdout}${enc.stderr}`.trim(),
    };
  }

  const verdict = verify(outFile, spec, cfg);
  // The step line is a one-word status; the full reason is printed once, below,
  // rather than twice in two widths.
  steps.push({ step: "verify", ok: verdict.ok, detail: verdict.ok ? "the file matches the plan" : "the file does not match the plan" });
  return { ...verdict, steps, outFile, log: `${enc.stdout}${enc.stderr}`.trim() };
}

/** The evidence gate, with the spec's own numbers as the expectation. */
export function verify(file, spec, cfg) {
  const v = cfg.verify;
  const minBytes = Math.max(v.minBytesFloor || 0, Math.round((v.minBytesPerSecond || 0) * (spec?.seconds || 0)));
  return checkVideoArtifact(file, {
    expectSeconds: spec?.seconds ?? null,
    toleranceSeconds: v.toleranceSeconds,
    expectAspect: spec?.aspect ?? null,
    aspectTolerance: v.aspectTolerance,
    minBytes,
  });
}

// ---------------------------------------------------------------- reporting

function printPlan(result, cfg) {
  const { spec, decisions, notes, question } = result;
  out();
  out(bold(`  ${spec.subject} — ${spec.platformLabel}, ${spec.aspect}, ${spec.seconds}s`));
  out();
  out(bold("  What I decided, and why"));
  out();
  const w = Math.max(...decisions.map((d) => d.what.length));
  for (const d of decisions) {
    out(`  ${cyan(d.what.padEnd(w))}  ${bold(d.value)}`);
    for (const line of wrap(d.why, 92)) out(`  ${" ".repeat(w)}  ${dim(line)}`);
    for (const s of d.shots || []) {
      const head = `${s.span.padEnd(12)} ${s.label.padEnd(7)}`;
      out(`  ${" ".repeat(w)}    ${dim(head)}  ${s.copy ? `"${s.copy}"` : dim("(no copy)")}`);
      for (const line of wrap(s.why, 72)) out(`  ${" ".repeat(w)}    ${" ".repeat(head.length)}  ${dim(line)}`);
    }
    out();
  }
  if (notes.length) {
    out(bold("  Worth knowing"));
    for (const n of notes) for (const line of wrap(n, 96)) out(`    ${dim(line)}`);
    out();
  }
  out(dim("  Any of that wrong? Say the one thing that is wrong and it re-plans; nothing else moves."));
  if (question) {
    out();
    out(bold(red("  One question before spending a render")));
    out();
    for (const line of wrap(question.text, 92)) out(`    ${line}`);
    out();
    for (const o of question.options) out(`    ${cyan(o.key.padEnd(14))} ${dim(`${o.label}, ${o.aspect}, ${o.seconds}s`)}`);
    out();
    out(`    ${dim(question.hint)}`);
    out();
  }
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else line = `${line} ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function writeArtifacts(result, cfg, baseDir) {
  const dir = path.join(baseDir, result.spec.slug);
  fs.mkdirSync(dir, { recursive: true });
  const jsx = composeJsx(result.spec, cfg);
  const compositionPath = path.join(dir, cfg.output.compositionFile);
  fs.writeFileSync(compositionPath, jsx, "utf8");
  fs.writeFileSync(
    path.join(dir, cfg.output.specFile),
    JSON.stringify({ spec: result.spec, decisions: result.decisions, notes: result.notes }, null, 2),
    "utf8",
  );
  return { dir, compositionPath };
}

/**
 * Where the composition, the spec and the render land.
 *
 * Delegated to the shared resolver rather than joined by hand, because that is
 * the module that knows "/tmp" means two different directories on Windows and
 * refuses it. Returns the directory, or throws with the resolver's own sentence.
 */
export function resolveBase(cfg, flags = {}) {
  const r = resolveOutDir(flags.out || null, {
    defaultDir: path.resolve(process.cwd(), cfg.output.dir),
    consequence: "The composition would be written where the render does not look for it.",
  });
  if (!r.ok) throw new Error(r.error);
  return r.dir;
}

// ------------------------------------------------------------------ selftest

function selftest() {
  const results = [];
  const check = (name, expected, got, detail = "") =>
    results.push({ name, expected: String(expected), got: String(got), pass: String(expected) === String(got), detail });

  const cfg = loadConfig();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || ".", "tb-video-skill-"));
  try {
    const p = (n) => path.join(dir, n);

    // ---- an unparseable prompt is refused, not guessed at
    for (const bad of ["", "   ", "make me a video", "please make a video for me thanks"]) {
      const r = plan(bad, cfg);
      check(`"${bad.trim() || "(empty)"}" is refused as having no subject`, false, r.ok);
    }
    check("...and the refusal explains what is missing", true,
      /what the video is ABOUT/.test(plan("make me a video", cfg).why));

    // ---- the headline case
    const toolbay = plan("make me a video showing off Toolbay", cfg, { assume: true });
    check("a plain prompt plans successfully", true, toolbay.ok, toolbay.why || "");
    check("...and pulls the subject out", "Toolbay", toolbay.spec.subject);
    check("...and every decision carries a reason", true, toolbay.decisions.every((d) => d.why && d.why.length > 20));
    check("...and it lands on the configured default surface", cfg.defaults.platform, toolbay.spec.platform);

    // ---- inference from the words themselves
    const reel = plan("quick reel showing off Toolbay", cfg);
    check("\"reel\" picks the Reels surface", "reels", reel.spec.platform);
    check("...which is vertical", "9:16", reel.spec.aspect);
    check("...and \"quick\" shortens it below the platform default", true,
      reel.spec.seconds < cfg.platforms.reels.seconds, `${reel.spec.seconds}`);
    check("...and the explanation names the surface", true, /Reels/.test(reel.decisions.find((d) => d.what === "aspect ratio").why));

    const yt = plan("youtube demo of the ALEX leasing app", cfg);
    check("\"youtube\" picks landscape", "16:9", yt.spec.aspect);
    check("\"demo\" picks the demo shot grammar", "demo", yt.spec.purpose);
    check("...and the subject survives both", true, /ALEX/i.test(yt.spec.subject), yt.spec.subject);

    const explicit = plan("30 second launch video for Toolbay on tiktok", cfg);
    check("a duration said out loud wins over the platform default", 30, explicit.spec.seconds);
    check("...and the platform is still read", "tiktok", explicit.spec.platform);
    check("...and the purpose too", "launch", explicit.spec.purpose);

    const override = plan("make a landscape reel about Toolbay", cfg);
    check("an aspect said out loud beats the platform's", "16:9", override.spec.aspect);
    check("...and the dimensions follow it", "1920x1080", `${override.spec.width}x${override.spec.height}`);

    // ---- the ceiling and floor on duration are refusals, not clamps
    check("an absurd duration is refused", false, plan("make a 3 hour video about Toolbay", cfg).ok);
    check("a 1 second video is refused", false, plan("make a 1 second video about Toolbay", cfg).ok);

    // ---- shots fill exactly the duration that was promised
    const shots = toolbay.spec.shots;
    check("the shot list is not empty", true, shots.length > 0);
    check("the shots start at zero", 0, shots[0].start);
    check("...and end exactly on the planned duration", toolbay.spec.seconds, shots[shots.length - 1].end);
    check("...with no gaps between them", true,
      shots.every((s, i) => i === 0 || s.start === shots[i - 1].end));

    // ---- the one question
    const vague = plan("make me a video about Toolbay", cfg);
    check("a prompt with no surface asks the one question", true, Boolean(vague.question));
    check("...and it is about the thing a re-render cannot fix", true, /aspect ratio/i.test(vague.question.text));
    check("...and naming a surface stops it being asked", null, plan("a reel about Toolbay", cfg).question);
    check("...and --assume answers it with the default", null, plan("make me a video about Toolbay", cfg, { assume: true }).question);
    check("...and says so in the notes rather than silently", true,
      plan("make me a video about Toolbay", cfg, { assume: true }).notes.some((n) => /Nothing said where this was going/.test(n)));

    // ---- memory: a correction, applied through the same match tables
    const withMemory = plan("make a reel showing off Toolbay", cfg, {
      memory: { on: true, reachable: true, entries: [{ text: "always end on the logo" }] },
    });
    check("a remembered correction adds the shot it names", true,
      withMemory.spec.shots.some((s) => s.beat === "logo"), withMemory.spec.shots.map((s) => s.beat).join(","));
    check("...at the end, where it was asked for", "logo", withMemory.spec.shots[withMemory.spec.shots.length - 1].beat);
    check("...and it says WHY it did that", true,
      withMemory.notes.some((n) => /always end on the logo/.test(n)));
    check("...and without memory that shot is not there", false,
      plan("make a reel showing off Toolbay", cfg).spec.shots.some((s) => s.beat === "logo"));

    const memoryOff = plan("a reel about Toolbay", cfg, { memory: { on: false, reachable: true, reason: "never enabled" } });
    check("memory being off is said out loud, not hidden", true,
      memoryOff.notes.some((n) => /Memory is off/.test(n)));
    const memoryGone = plan("a reel about Toolbay", cfg, { memory: { on: false, reachable: false, reason: "not installed" } });
    check("memory being unreachable degrades cleanly and says why", true,
      memoryGone.notes.some((n) => /could not be reached/.test(n)));
    check("...and the plan still succeeds without it", true, memoryGone.ok);

    // The prompt always wins over a remembered preference, or a preference
    // recorded once could never be overruled.
    const fight = plan("a youtube video about Toolbay", cfg, {
      memory: { on: true, reachable: true, entries: [{ text: "always use tiktok" }] },
    });
    check("what you just said beats what you said last month", "youtube", fight.spec.platform);

    // ---- the composition is real JSX against the real contract
    const jsx = composeJsx(toolbay.spec, cfg);
    fs.writeFileSync(p("composition.jsx"), jsx);
    check("the composition default-exports a project component", true, /export default function Project\(\)/.test(jsx));
    check("...whose root is a scene-promoted rect", true, /<rect\s+scene="/.test(jsx));
    check("...at the planned dimensions", true,
      jsx.includes(`width={${toolbay.spec.width}}`) && jsx.includes(`height={${toolbay.spec.height}}`));
    check("...with one element per shot", true,
      toolbay.spec.shots.every((s) => jsx.includes(`${s.label}: ${s.start}s to ${s.end}s`)));
    check("...and no unsubstituted tokens left in it", false, /<<\w+>>/.test(jsx));

    // The check that would have caught the delimiter bug. Every JSX attribute
    // has to be a quoted string or a braced expression; `start=0` is neither,
    // and it is what a brace-delimited token produces once substituted. It reads
    // fine, it renders in no editor, and nothing else here would have noticed.
    const unbraced = (src) => (src.match(/\s[a-zA-Z][\w-]*=(?!["{])/g) || []).map((s) => s.trim());
    check("every attribute in the composition is quoted or braced", "",
      unbraced(jsx).join(","), "an attribute like start=0 is not valid JSX");
    for (const [purposeKey] of Object.entries(cfg.purposes)) {
      const built = plan(`a ${purposeKey} video about Toolbay on youtube`, cfg);
      const src = composeJsx(built.spec, cfg);
      check(`the ${purposeKey} grammar produces valid attributes`, "", unbraced(src).join(","));
      check(`...and leaves no tokens behind`, false, /<<\w+>>/.test(src));
      for (const tag of ["text", "rect", "sequence"]) {
        const opens = (src.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
        const closes = (src.match(new RegExp(`</${tag}>`, "g")) || []).length;
        check(`...and every <${tag}> in it is closed`, opens, closes);
      }
    }
    // Footage and logo beats are self-closing, so they are counted the other way.
    const withAssets = plan("a demo of Toolbay on youtube, end on the logo", cfg, {
      footage: ["C:/clips/a.mp4", "C:/clips/b.mp4"],
      logo: "C:/brand/logo.png",
    });
    const assetJsx = composeJsx(withAssets.spec, cfg);
    check("a supplied logo becomes an image element", true, /<image[\s\S]*logo\.png/.test(assetJsx));
    check("...and supplied footage a video element", true, /<video[\s\S]*a\.mp4/.test(assetJsx));
    check("...with valid attributes throughout", "", unbraced(assetJsx).join(","));
    check("...and the subject on screen", true, jsx.includes(toolbay.spec.subject));
    check("footage supplied is used as a video source", true,
      composeJsx(plan("demo of Toolbay on youtube", cfg, { footage: ["C:/clips/take.mp4"] }).spec, cfg).includes("<video"));
    check("...and with none supplied it says so rather than inventing a path", true,
      /No footage was supplied/.test(composeJsx(plan("demo of Toolbay on youtube", cfg).spec, cfg)));

    // ---- the CLI being absent is a refusal, and no file is claimed
    const noEngine = { ok: false, bin: "dapi", why: "`dapi` is not on PATH" };
    const refused = render(toolbay.spec, cfg, { dir, engine: noEngine });
    check("a missing dapi refuses the render", false, refused.ok);
    check("...and says no file was produced", true, /no file was produced/.test(refused.why), refused.why);
    check("...and never writes one", false, fs.existsSync(refused.outFile));
    const lookup = findEngine({ engine: { bin: "definitely-not-a-real-binary-xyz" } });
    check("a binary that is not on PATH is not found", false, lookup.ok);
    check("...and the reason names it", true, /is not on PATH/.test(lookup.why));

    // ---- the six ways a render can lie, each refused
    const spec = toolbay.spec;
    check("a render that produced no file is refused", false, verify(p("missing.mp4"), spec, cfg).ok);
    fs.writeFileSync(p("zero.mp4"), "");
    check("a 0-byte render is refused", false, verify(p("zero.mp4"), spec, cfg).ok);
    fs.writeFileSync(p("notvideo.mp4"), "dapi: render failed\n".repeat(4000));
    const nv = verify(p("notvideo.mp4"), spec, cfg);
    check("a log file named .mp4 is refused", false, nv.ok);
    check("...even though it clears the byte floor", true, fs.statSync(p("notvideo.mp4")).size > cfg.verify.minBytesFloor);

    // Fixtures are padded past the byte floor on purpose: a real 22-second
    // render is megabytes, and a 2KB fixture would fail the floor for the one
    // reason that has nothing to do with what is being tested here.
    const weighty = { mdatBytes: 400000 };
    fs.writeFileSync(p("right.mp4"), makeTinyMp4({ width: spec.width, height: spec.height, seconds: spec.seconds, ...weighty }));
    const okRender = verify(p("right.mp4"), spec, cfg);
    check("a video of the right length and shape passes", true, okRender.ok, okRender.why);
    fs.writeFileSync(p("undersized.mp4"), makeTinyMp4({ width: spec.width, height: spec.height, seconds: spec.seconds }));
    check("...and a video far too small to hold that many seconds is refused", false,
      verify(p("undersized.mp4"), spec, cfg).ok);

    fs.writeFileSync(p("shortcut.mp4"), makeTinyMp4({ width: spec.width, height: spec.height, seconds: 2, ...weighty }));
    const wrongLen = verify(p("shortcut.mp4"), spec, cfg);
    check("a video of the WRONG DURATION is refused", false, wrongLen.ok);
    check("...and the refusal names both lengths", true,
      wrongLen.why.includes(String(spec.seconds)) && /2.00s/.test(wrongLen.why), wrongLen.why);

    fs.writeFileSync(p("wideshot.mp4"), makeTinyMp4({ width: 1920, height: 1080, seconds: spec.seconds, ...weighty }));
    const wrongShape = verify(p("wideshot.mp4"), spec, cfg);
    check("a video of the WRONG ASPECT is refused", false, wrongShape.ok);
    check("...and the refusal names the aspect that was asked for", true,
      wrongShape.why.includes(spec.aspect), wrongShape.why);

    fs.writeFileSync(p("thin.mp4"), makeTinyMp4({ width: spec.width, height: spec.height, seconds: spec.seconds, withMdat: false }));
    check("an encode that wrote no frames is refused", false, verify(p("thin.mp4"), spec, cfg).ok);

    // ---- config integrity: the code holds no values, so the file must hold them all
    check("every platform declares an aspect, size and duration", true,
      Object.values(cfg.platforms).every((pl) => pl.aspect && pl.width > 0 && pl.height > 0 && pl.seconds > 0));
    check("every platform explains its own aspect and length", true,
      Object.values(cfg.platforms).every((pl) => pl.why?.aspect && pl.why?.seconds));
    check("every purpose names only beats that exist", true,
      Object.values(cfg.purposes).every((pu) => pu.beats.every((b) => Boolean(cfg.beats[b]))));
    check("every beat has a body to render", true,
      Object.entries(cfg.beats).filter(([k]) => !k.startsWith("_")).every(([, b]) => Array.isArray(b.jsx) && b.jsx.length));
    check("every tone declares a full palette", true,
      Object.values(cfg.tones).every((t) => t.background && t.ink && t.accent));
    check("a config that cannot be read is refused, not defaulted", true,
      (() => {
        try {
          loadConfig(p("nope.json"));
          return false;
        } catch (e) {
          return /nothing to fall back to/.test(e.message);
        }
      })());
    fs.writeFileSync(p("broken.json"), "{ not json");
    check("...and neither is one that is not JSON", true,
      (() => {
        try {
          loadConfig(p("broken.json"));
          return false;
        } catch (e) {
          return /not valid JSON/.test(e.message);
        }
      })());

    // ---- the words on screen: supplied, defaulted, and never invented
    check("every shot carries the copy it will show", true, toolbay.spec.shots.every((s) => Boolean(s.copy)));
    check("...which defaults to the subject and nothing more", "Toolbay", toolbay.spec.shots[0].copy);
    check("...and is flagged as a default rather than passed off as yours", "default", toolbay.spec.shots[0].copyFrom);
    check("...and the repetition is pointed out instead of hidden", true,
      toolbay.notes.some((n) => /Every shot currently says/.test(n)));
    const scripted = plan("a reel showing off Toolbay", cfg, { lines: ["Ship faster", "Watch it build", "One command", "Toolbay"] });
    check("supplied lines are used in order", "Ship faster", scripted.spec.shots[0].copy);
    check("...and marked as yours", "you", scripted.spec.shots[0].copyFrom);
    check("...and reach the composition", true, composeJsx(scripted.spec, cfg).includes("Watch it build"));
    check("...and no placeholder warning is raised when they are all distinct", false,
      scripted.notes.some((n) => /Every shot currently says/.test(n)));

    // ---- the wiring between plan and disk, which is where a shape mismatch
    // hides: this suite passed once while `make` crashed on the very first
    // write, because nothing ran the path from a plan to a file.
    const base = resolveBase(cfg, {});
    check("the output directory resolves to a real path string", "string", typeof base);
    check("...under the directory named in video.json", true, base.includes(path.normalize(cfg.output.dir)), base);
    check("an explicit --out is honoured", path.resolve(p("elsewhere")), resolveBase(cfg, { out: p("elsewhere") }));
    if (process.platform === "win32") {
      check("...and /tmp is refused, because it means two directories here", true,
        (() => {
          try {
            resolveBase(cfg, { out: "/tmp/video" });
            return false;
          } catch (e) {
            return /two different directories/.test(e.message);
          }
        })());
    }
    const written = writeArtifacts(toolbay, cfg, p("artifacts"));
    check("writeArtifacts writes the composition", true, fs.existsSync(written.compositionPath));
    check("...and the spec beside it", true, fs.existsSync(path.join(written.dir, cfg.output.specFile)));
    check("...and the spec round-trips as JSON", toolbay.spec.seconds,
      JSON.parse(fs.readFileSync(path.join(written.dir, cfg.output.specFile), "utf8")).spec.seconds);
    check("...and the composition on disk is what compose produced", true,
      fs.readFileSync(written.compositionPath, "utf8") === composeJsx(toolbay.spec, cfg));

    // ---- planning is deterministic: same sentence, same video
    check("the same prompt plans the same video twice", true,
      JSON.stringify(plan("a reel showing off Toolbay", cfg).spec) === JSON.stringify(plan("a reel showing off Toolbay", cfg).spec));

    // ---- the real memory layer, called for real
    const mem = recallMemory(cfg);
    check("the memory layer is reachable from here", true, mem.reachable, mem.reason || "");
    check("...and returns a usable shape whether it is on or off", true, Array.isArray(mem.entries));

    // The recall call is made with NO query, and that has to stay true. With a
    // query of "video" the layer scored "always end on the logo" at zero and
    // returned nothing, so memory was on, the correction was stored, and not a
    // single one was ever applied. Nothing else here would have noticed: every
    // other memory test passes a hand-built entries array straight in.
    const spy = p("memory-spy.mjs");
    fs.writeFileSync(spy, [
      "const argv = process.argv.slice(2);",
      'process.stdout.write(JSON.stringify({ on: true, entries: [{ text: argv.join(" ") }] }));',
    ].join("\n"), "utf8");
    const spied = recallMemory(cfg, { scriptOverride: spy });
    check("recall is called with no query, so nothing is scored away", "recall --json", spied.entries[0].text);
    check("...and a configured query would be passed through if one were set", "recall shots --json",
      recallMemory({ ...cfg, memory: { ...cfg.memory, recallQuery: "shots" } }, { scriptOverride: spy }).entries[0].text);
    check("...and a memory layer answering nonsense degrades rather than throws", false,
      (() => {
        fs.writeFileSync(p("junk.mjs"), 'process.stdout.write("not json at all");', "utf8");
        return recallMemory(cfg, { scriptOverride: p("junk.mjs") }).reachable;
      })());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\n  tb-video selftest  (node ${process.version}, ${process.platform})\n\n`);
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
    return;
  }
  process.stdout.write("\n  A prompt becomes a spec, a spec becomes a composition, and a render is only\n  a render once the file proves it.\n\n");
}

// ----------------------------------------------------------------------- CLI

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--assume" || a === "--yes") flags.assume = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--spec") flags.spec = argv[++i];
    else if (a === "--footage") flags.footage = (flags.footage || []).concat(argv[++i]);
    else if (a === "--line") flags.lines = (flags.lines || []).concat(argv[++i]);
    else if (a === "--logo") flags.logo = argv[++i];
    else if (a === "--because") flags.because = argv[++i];
    else if (a === "--platform") flags.platform = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function usage() {
  out(`
  ${bold("tb-video")} — plain prompt in, finished video out. Wraps Diffusion Studio's ${cyan("dapi")}.

  ${cyan('tb-video.mjs make "make me a video showing off Toolbay"')}
      Decide everything, write the composition, render it, and verify the file.

  ${cyan('tb-video.mjs plan "..."')}       decide and explain; render nothing
  ${cyan('tb-video.mjs compose "..."')}    also write the .jsx; render nothing
  ${cyan("tb-video.mjs verify <file> --spec <spec.json>")}
  ${cyan('tb-video.mjs remember "always end on the logo" --because "brand recall"')}
  ${cyan("tb-video.mjs doctor")}           is the engine here, and can it render
  ${cyan("tb-video.mjs selftest")}

  Flags: --assume (take the default instead of asking)  --line "..." (once per shot)
         --footage <file>  --logo <file>  --out <dir>  --json  --dry-run
`);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (!cmd || cmd === "help" || cmd === "--help") {
    usage();
    return;
  }
  if (cmd === "selftest") {
    selftest();
    return;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    out(red(`\n  REFUSED  ${e.message}\n`));
    process.exitCode = EXIT.refused;
    return;
  }

  if (cmd === "doctor") {
    const engine = findEngine(cfg);
    out();
    out(bold("  Can this machine render?"));
    out();
    out(`  ${engine.ok ? green("ok  ") : red("NO  ")}  ${cfg.engine.bin}${engine.ok ? ` at ${engine.path}` : `: ${engine.why}`}`);
    if (engine.ok) {
      const v = runEngine(engine.path, cfg.engine.probeArgs, { cwd: process.cwd(), timeout: 30000 });
      out(`  ${v.ok ? green("ok  ") : red("NO  ")}  ${cfg.engine.bin} ${cfg.engine.probeArgs.join(" ")} ${v.ok ? "answers" : `failed: ${v.error || `exit ${v.status}`}`}`);
      const who = runEngine(engine.path, cfg.engine.whoamiArgs, { cwd: process.cwd(), timeout: 30000 });
      out(`  ${who.ok ? green("ok  ") : dim("--  ")}  account: ${who.ok ? who.stdout.trim().split("\n")[0] : "not signed in, or this build has no account. AI generation, transcription and `media listen` are cloud features and need one; a composition of your own footage and type does not."}`);
    } else {
      out();
      for (const line of cfg.engine.install) out(`  ${dim(line)}`);
    }
    out();
    out(`  ${dim("Verification does not need dapi:")} node scripts/tb-video-evidence.mjs check <file> --seconds N --aspect 9:16`);
    out();
    process.exitCode = engine.ok ? EXIT.ok : EXIT.refused;
    return;
  }

  if (cmd === "remember") {
    const what = rest.join(" ").trim();
    if (!what) {
      out(red("\n  REFUSED  nothing to remember. Say the correction, e.g. \"always end on the logo\".\n"));
      process.exitCode = EXIT.refused;
      return;
    }
    const script = path.resolve(SKILL_DIR, cfg.memory.script);
    if (!fs.existsSync(script)) {
      out(red(`\n  REFUSED  the memory skill is not installed beside this one, so a correction has nowhere to live.\n           ${dim("This skill deliberately keeps no store of its own.")}\n`));
      process.exitCode = EXIT.refused;
      return;
    }
    // Asked BEFORE recording, because the memory layer prints its own guidance
    // and exits 0 when it is switched off. Passing that through would report a
    // correction as kept when nothing was written, which is the one thing a
    // memory feature must never do.
    const state = recallMemory(cfg);
    if (!state.on) {
      out(red(`\n  NOT REMEMBERED  memory is off (${state.reason || "unknown"}), so "${what}" was not stored.`));
      out(dim(`                  Nothing was written and nothing will be applied to the next video.`));
      const shown = path.relative(process.cwd(), script);
      out(`\n      node ${shown.length < script.length ? shown : script} enable\n`);
      process.exitCode = EXIT.refused;
      return;
    }
    const args = [script, "record", what];
    if (flags.because) args.push("--why", flags.because);
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env } });
    process.exitCode = r.status === 0 ? EXIT.ok : EXIT.refused;
    return;
  }

  if (cmd === "verify") {
    const file = rest[0];
    if (!file) {
      out(red("\n  REFUSED  verify needs a file.\n"));
      process.exitCode = EXIT.refused;
      return;
    }
    let spec = null;
    if (flags.spec) {
      try {
        spec = JSON.parse(fs.readFileSync(flags.spec, "utf8")).spec;
      } catch (e) {
        out(red(`\n  REFUSED  the spec at ${flags.spec} could not be read (${e.message}).\n`));
        process.exitCode = EXIT.refused;
        return;
      }
    }
    const v = verify(file, spec, cfg);
    out();
    for (const ch of v.checks) out(`  ${ch.ok ? green("ok ") : red("NO ")}  ${ch.label}`);
    out();
    out(`  ${v.ok ? green("VERIFIED") : red("REFUSED")}  ${v.why}`);
    out();
    process.exitCode = v.ok ? EXIT.ok : EXIT.refused;
    return;
  }

  const prompt = rest.join(" ").trim();
  if (!["make", "plan", "compose"].includes(cmd)) {
    usage();
    process.exitCode = EXIT.refused;
    return;
  }

  const memory = recallMemory(cfg);
  const result = plan(prompt, cfg, {
    memory,
    assume: flags.assume === true,
    footage: flags.footage || [],
    logo: flags.logo || null,
    lines: flags.lines || [],
  });

  if (!result.ok) {
    out(red(`\n  REFUSED  ${result.why}\n`));
    process.exitCode = EXIT.refused;
    return;
  }

  if (flags.json) {
    out(JSON.stringify({ spec: result.spec, decisions: result.decisions, notes: result.notes, question: result.question }, null, 2));
    process.exitCode = result.question ? EXIT.question : EXIT.ok;
    return;
  }

  printPlan(result, cfg);

  if (result.question) {
    out(dim(`  Nothing was rendered. Answer in one word, or re-run with --assume.`));
    out();
    process.exitCode = EXIT.question;
    return;
  }

  if (cmd === "plan") {
    out(dim(`  Nothing written. \`compose\` writes the composition, \`make\` renders it.`));
    out();
    return;
  }

  let base;
  try {
    base = resolveBase(cfg, flags);
  } catch (e) {
    out(red(`\n  REFUSED  ${e.message}\n`));
    process.exitCode = EXIT.refused;
    return;
  }

  const { dir, compositionPath } = writeArtifacts(result, cfg, base);
  out(`  ${green("wrote")}  ${compositionPath}`);
  out(`  ${green("wrote")}  ${path.join(dir, cfg.output.specFile)}`);
  out();

  if (cmd === "compose") {
    out(dim(`  Mount it yourself with:  ${cfg.engine.bin} mount "${compositionPath}"`));
    out();
    return;
  }

  const engine = findEngine(cfg);
  const r = render(result.spec, cfg, { dir, engine, dryRun: flags.dryRun === true });
  if (r.ok) {
    out(bold(green("  RENDERED")));
    out();
    for (const ch of r.checks) out(`  ${green("ok ")}  ${ch.label}`);
    out();
    out(`  ${bold(r.outFile)}`);
    out();
    return;
  }

  out(bold(red("  NOT RENDERED")));
  out();
  for (const step of r.steps) out(`  ${step.ok ? green("ok ") : red("NO ")}  ${step.step}: ${step.detail}`);
  out();
  for (const line of wrap(r.why, 96)) out(`  ${red(line)}`);
  if (r.engineMissing) {
    out();
    for (const line of cfg.engine.install) out(`  ${dim(line)}`);
    out();
    out(dim(`  The composition is written and valid at ${compositionPath}. It needs dapi to become a file.`));
  }
  if (r.log) {
    out();
    out(dim("  engine output:"));
    for (const line of r.log.split("\n").slice(-12)) out(dim(`    ${line}`));
  }
  out();
  process.exitCode = EXIT.refused;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
