import { downloadDir, join } from '@tauri-apps/api/path';
import type { Project } from '../hooks/useProjects';
import { activity } from './activity';
import { openEditor, waitForEditor, type AgentWord, type EditorAgentApi } from './agent';
import { findPhrase } from './textSearch';
import { RHYTHMS, shortenPauses, type Rhythm } from './pauses';
import { EQ_PRESETS, type EqAmount } from './eq';
import { findPreset, PRESET_IDS } from './audioFormats';
import { describeEnhancement } from '../components/editor/EnhancePanel';
import type { EnhanceOptions } from '../hooks/useEnhancement';

// The tools AI agents call (listed for them in src-tauri/src/mcp.rs; keep the
// names and arguments in step). Each takes the agent's arguments and returns
// the text the agent reads; throwing an Error returns its message as a failed
// call. Editing tools work through the editor (agent.ts), so every change
// shows live and can be undone like any edit.

/** What the app gives the tools. */
export interface AgentContext {
  /** Who's calling, as Wave credits it ("Claude", "Codex"…). */
  agent:          string;
  projects:       () => Project[];
  /** Open a project in the editor. */
  open:           (project: Project) => void;
  importAudio:    (path: string, name: string) => Promise<Project>;
  hasTranscriber: boolean;
}

type Args = Record<string, unknown>;

/** Longest wait for a project to open in the editor. */
const OPEN_TIMEOUT_MS = 30_000;
/** Paragraph breaks in get_transcript: a pause this long, a new speaker, or this many words. */
const PARAGRAPH_GAP_MS = 1500;
const LINE_WORDS = 50;
const LOW_CONFIDENCE = 0.6;

export async function runTool(tool: string, args: Args, ctx: AgentContext): Promise<string> {
  const run = TOOLS[tool];
  if (!run) throw new Error(`Wave has no tool called "${tool}".`);
  return run(args ?? {}, ctx);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** 2:31.4, or 1:02:31.4 past an hour. */
function clock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const seconds = (ms: number) => (ms / 1000).toFixed(2);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─── Arguments ────────────────────────────────────────────────────────────────

function str(args: Args, key: string, required = true): string | undefined {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (required) throw new Error(`"${key}" is required.`);
  return undefined;
}

function num(args: Args, key: string, fallback?: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (fallback !== undefined && (v === undefined || v === null)) return fallback;
  throw new Error(`"${key}" must be a number.`);
}

function list(args: Args, key: string): Args[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new Error(`"${key}" must be a non-empty list.`);
  return v.map((item) => (item && typeof item === 'object' ? item as Args : {}));
}

/** Word numbers from {from, to} ranges, checked against the transcript. */
function wordsIn(ranges: Args[], count: number): number[] {
  const out = new Set<number>();
  for (const r of ranges) {
    const from = Math.round(num(r, 'from'));
    const to   = Math.round(num(r, 'to', from));
    if (from < 0 || to >= count || to < from) {
      throw new Error(`Word range ${from}–${to} is outside the transcript (words 0–${count - 1}).`);
    }
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// ─── Projects ─────────────────────────────────────────────────────────────────

function findProject(ctx: AgentContext, ref: string): Project {
  const projects = ctx.projects();
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Several projects are called "${ref}"; use the id (see list_projects).`);
  const names = projects.map((p) => `"${p.name}"`).join(', ') || 'none yet';
  throw new Error(`No project "${ref}". Projects: ${names}.`);
}

function statusText(p: Project): string {
  switch (p.status.type) {
    case 'ready':             return 'ready';
    case 'transcribing':      return 'transcribing';
    case 'importing':         return 'importing';
    case 'readyToTranscribe': return 'imported, waiting to be transcribed';
    case 'empty':             return 'no audio yet';
    case 'error':             return `failed: ${p.status.message}`;
  }
}

/** The project's editor, opening the project in Wave if it isn't open yet. */
async function editorFor(args: Args, ctx: AgentContext): Promise<EditorAgentApi> {
  const project = findProject(ctx, str(args, 'project')!);
  if (project.status.type !== 'ready') {
    throw new Error(`"${project.name}" isn't ready to edit (${statusText(project)}).`);
  }
  const open = openEditor(project.id);
  if (open) return open;
  ctx.open(project);
  return waitForEditor(project.id, OPEN_TIMEOUT_MS);
}

/** After edits: wait for the editor to take them in, and say so in Wave. */
async function done(api: EditorAgentApi, ctx: AgentContext, summary: string): Promise<EditorAgentApi> {
  await api.settled();
  activity.announce(`${ctx.agent}: ${summary}`, api.projectId);
  return openEditor(api.projectId) ?? api;
}

function lengthNow(api: EditorAgentApi): string {
  return `Edited length now ${clock(api.editedMs)} (was ${clock(api.durationMs)}).`;
}

function jobsOf(projectId: string): string[] {
  return activity.getSnapshot()
    .filter((a) => a.projectId === projectId && a.state === 'running')
    .map((a) => `${a.label}${a.progress !== null ? ` (${Math.round(a.progress * 100)}%)` : ''}`);
}

// ─── Reading ──────────────────────────────────────────────────────────────────

function wordText(w: AgentWord): string {
  if (w.cut) return `~~${w.text}~~`;
  const unsure = !w.correctedFrom && w.confidence < LOW_CONFIDENCE ? '(?)' : '';
  return `${w.text}${unsure}${w.partCut ? '[~]' : ''}`;
}

/** Pauses between kept words, minus whatever of them is already cut. */
function pauses(api: EditorAgentApi, minMs: number) {
  const kept = api.words().filter((w) => !w.cut);
  const cuts = api.cuts();
  const out: { before: AgentWord; after: AgentWord; startMs: number; endMs: number; ms: number; untouched: boolean }[] = [];
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1], b = kept[i];
    const gap = b.startMs - a.endMs;
    if (gap < minMs) continue;
    const cutMs = cuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.endMs, b.startMs) - Math.max(c.startMs, a.endMs)), 0);
    const ms = gap - cutMs;
    if (ms >= minMs) out.push({ before: a, after: b, startMs: a.endMs, endMs: b.startMs, ms, untouched: cutMs === 0 });
  }
  return out;
}

// ─── The tools ────────────────────────────────────────────────────────────────

const TOOLS: Record<string, (args: Args, ctx: AgentContext) => Promise<string>> = {
  async list_projects(_args, ctx) {
    const projects = ctx.projects();
    if (projects.length === 0) return 'No projects yet. import_audio creates one from an audio file.';
    return [`${plural(projects.length, 'project')}:`, ...projects.map((p) => {
      const length = p.durationSecs ? `, ${clock(p.durationSecs * 1000)}` : '';
      const open = openEditor(p.id) ? ' (open in the editor)' : '';
      return `- "${p.name}" (id ${p.id}): ${statusText(p)}${length}${open}`;
    })].join('\n');
  },

  async get_project(args, ctx) {
    const project = findProject(ctx, str(args, 'project')!);
    const lines = [`"${project.name}" (id ${project.id})`, `Status: ${statusText(project)}`];
    if (project.originalFilename) lines.push(`File: ${project.originalFilename}`);
    const jobs = jobsOf(project.id);
    if (jobs.length > 0) lines.push(`Running: ${jobs.join('; ')}`);
    if (project.status.type !== 'ready') {
      if (project.durationSecs) lines.push(`Length: ${clock(project.durationSecs * 1000)}`);
      return lines.join('\n');
    }
    const api = await editorFor(args, ctx);
    const words = api.words();
    const cutWords = words.filter((w) => w.cut).length;
    const edits = new Set(api.edits().map((e) => e.group?.id ?? e.id)).size;
    const speakers = api.speakers();
    const enh = api.enhancement();
    const longPauses = shortenPauses(api.pauses(), RHYTHMS.find((r) => r.id === 'natural')!).length;
    const added = api.addedPauses();
    lines.push(
      `Language: ${api.language}`,
      `Length: ${clock(api.durationMs)}, ${clock(api.editedMs)} after edits`,
      `Words: ${words.length} (${cutWords} cut)`,
      `Edits: ${edits}`,
      `Speakers: ${speakers === null ? 'not detected (analyze)'
        : speakers.map((s) => `${s.name} (${clock(s.talkMs)})`).join(', ')}`,
      `Pauses: ${longPauses > 0 ? `${longPauses} run long at the Natural rhythm (tighten_pauses)` : 'none run long at the Natural rhythm'}`
        + (added.length > 0 ? `; ${plural(added.length, 'pause')} added` : ''),
      `Speech enhancement: ${enh.running ? `running (${Math.round((enh.progress ?? 0) * 100)}%)`
        : !enh.exists ? 'none'
        : `${enh.on ? 'on' : 'made, switched off'}: ${describeEnhancement(enh.applied!)}`}`,
      `Clean-up model (DPDFNet): ${enh.ready.dpdfnet ? 'downloaded' : 'not downloaded (an EQ and loudness still work)'}`,
    );
    return lines.join('\n');
  },

  async get_transcript(args, ctx) {
    const api = await editorFor(args, ctx);
    const all = api.words();
    if (all.length === 0) return 'The transcript is empty.';
    const from = Math.max(0, Math.round(num(args, 'from', 0)));
    const to = Math.min(all.length - 1, Math.round(num(args, 'to', all.length - 1)));
    if (from > to) throw new Error(`Nothing between words ${from} and ${to} (words 0–${all.length - 1}).`);
    const words = all.slice(from, to + 1);

    const lines: string[] = [];
    let line: string[] = [];
    let lineStart: AgentWord | null = null;
    let lastSpeaker: string | null = null;
    const flush = () => {
      if (!lineStart || line.length === 0) return;
      const speaker = lineStart.speaker && lineStart.speaker !== lastSpeaker ? `${lineStart.speaker}: ` : '';
      if (lineStart.speaker) lastSpeaker = lineStart.speaker;
      lines.push(`[${lineStart.n}] ${clock(lineStart.startMs)} ${speaker}${line.join(' ')}`);
      line = [];
      lineStart = null;
    };
    words.forEach((w, i) => {
      const prev = words[i - 1];
      const count = line.length;
      if (prev && (w.startMs - prev.endMs >= PARAGRAPH_GAP_MS || w.speaker !== prev.speaker || count >= LINE_WORDS)) flush();
      if (!lineStart) lineStart = w;
      line.push(wordText(w));
    });
    flush();

    const kept = all.filter((w) => !w.cut).length;
    return [
      `"${api.name}": words ${from}–${to} of ${all.length} (${kept} kept). ${clock(api.durationMs)} long, ${clock(api.editedMs)} after edits.`,
      'Each line starts with [number of its first word] and its time. ~~word~~ is cut, word(?) may be misheard, word[~] is partly cut.',
      '',
      ...lines,
    ].join('\n');
  },

  async get_words(args, ctx) {
    const api = await editorFor(args, ctx);
    const all = api.words();
    const from = Math.max(0, Math.round(num(args, 'from')));
    const to = Math.min(all.length - 1, Math.round(num(args, 'to')));
    if (from > to) throw new Error(`Nothing between words ${from} and ${to} (words 0–${all.length - 1}).`);
    if (to - from >= 400) throw new Error('At most 400 words per call.');
    const rows = all.slice(from, to + 1).map((w) => {
      const state = w.cut ? 'cut' : w.partCut ? 'partly cut' : 'kept';
      const fixed = w.correctedFrom ? ` (corrected from "${w.correctedFrom}")` : '';
      return `${w.n}\t${seconds(w.startMs)}\t${seconds(w.endMs)}\t${w.confidence.toFixed(2)}\t${state}\t${w.text}${fixed}`;
    });
    return ['number\tstart\tend\tconfidence\tstate\ttext', ...rows].join('\n');
  },

  async find_text(args, ctx) {
    const api = await editorFor(args, ctx);
    const words = api.words();
    const found = findPhrase(words.map((w) => w.text), str(args, 'text')!);
    const total = found.length;
    const matches: string[] = [];
    for (const { from: a, to: b } of found.slice(0, 25)) {
      const before = words.slice(Math.max(0, a - 6), a).map(wordText).join(' ');
      const after = words.slice(b + 1, b + 7).map(wordText).join(' ');
      const hit = words.slice(a, b + 1).map(wordText).join(' ');
      matches.push(`- words ${a}–${b}, ${clock(words[a].startMs)}–${clock(words[b].endMs)}: …${before} **${hit}** ${after}…`);
    }
    if (total === 0) return `"${args.text}" isn't in the transcript.`;
    return [`${plural(total, 'match', 'matches')}${total > matches.length ? ` (first ${matches.length})` : ''}:`, ...matches].join('\n');
  },

  async list_pauses(args, ctx) {
    const api = await editorFor(args, ctx);
    const minMs = num(args, 'min_seconds', 1) * 1000;
    const found = pauses(api, minMs);
    if (found.length === 0) return `No pauses of ${seconds(minMs)} s or more between kept words.`;
    const totalMs = found.reduce((s, p) => s + p.ms, 0);
    const between = new Set(api.pauses().filter((p) => p.sentence).map((p) => p.before));
    const rows = found.slice(0, 200).map((p) =>
      `- ${seconds(p.ms)} s after word ${p.before.n} "${p.before.text}" at ${clock(p.startMs)}, ${between.has(p.before.n) ? 'between sentences' : 'within a sentence'}${p.untouched ? '' : ' (partly cut already)'}`);
    const added = api.addedPauses();
    return [
      `${plural(found.length, 'pause')} of ${seconds(minMs)} s or more, ${seconds(totalMs)} s in all${found.length > 200 ? ' (first 200)' : ''}:`,
      ...rows,
      ...(added.length > 0 ? [`Added pauses: ${added.map((p) => `${seconds(p.ms)} s at ${clock(p.atMs)}`).join(', ')}`] : []),
    ].join('\n');
  },

  async cut_words(args, ctx) {
    const api = await editorFor(args, ctx);
    const words = api.words();
    const chosen = wordsIn(list(args, 'ranges'), words.length).filter((n) => !words[n].cut);
    if (chosen.length === 0) return 'Those words are already cut.';
    const summary = str(args, 'label', false) ?? `Cut ${plural(chosen.length, 'word')}`;
    api.group(summary, ctx.agent, (e) => e.cutWords(chosen));
    const after = await done(api, ctx, summary);
    return `Cut ${plural(chosen.length, 'word')}. ${lengthNow(after)}`;
  },

  async restore_words(args, ctx) {
    const api = await editorFor(args, ctx);
    const words = api.words();
    const chosen = wordsIn(list(args, 'ranges'), words.length).filter((n) => words[n].cut);
    if (chosen.length === 0) return 'None of those words are cut.';
    api.restore(chosen);
    const after = await done(api, ctx, `Restored ${plural(chosen.length, 'word')}`);
    return `Restored ${plural(chosen.length, 'word')}. ${lengthNow(after)}`;
  },

  async cut_time(args, ctx) {
    const api = await editorFor(args, ctx);
    const ranges = list(args, 'ranges').map((r) => {
      const startMs = num(r, 'start') * 1000, endMs = num(r, 'end') * 1000;
      if (startMs < 0 || endMs > api.durationMs + 1 || endMs - startMs < 5) {
        throw new Error(`${seconds(startMs)}–${seconds(endMs)} s isn't a stretch of the audio (0–${seconds(api.durationMs)} s).`);
      }
      return { startMs, endMs };
    });
    const summary = str(args, 'label', false) ?? `Cut ${plural(ranges.length, 'stretch', 'stretches')} of audio`;
    api.group(summary, ctx.agent, (e) => ranges.forEach((r) => e.cutTime(r.startMs, r.endMs)));
    const after = await done(api, ctx, summary);
    const totalMs = ranges.reduce((s, r) => s + r.endMs - r.startMs, 0);
    return `Cut ${plural(ranges.length, 'stretch', 'stretches')}, ${seconds(totalMs)} s. ${lengthNow(after)}`;
  },

  async correct_words(args, ctx) {
    const api = await editorFor(args, ctx);
    const words = api.words();
    const fixes = list(args, 'corrections').map((c) => {
      const n = Math.round(num(c, 'word'));
      if (n < 0 || n >= words.length) throw new Error(`There's no word ${n} (words 0–${words.length - 1}).`);
      return { n, text: str(c, 'text')! };
    }).filter((c) => c.text !== words[c.n].text);
    if (fixes.length === 0) return 'Those words already say that.';
    const summary = str(args, 'label', false) ?? `Corrected ${plural(fixes.length, 'word')}`;
    api.group(summary, ctx.agent, (e) => fixes.forEach((c) => e.correct(c.n, c.text)));
    await done(api, ctx, summary);
    return `Corrected ${fixes.map((c) => `word ${c.n} "${words[c.n].correctedFrom ?? words[c.n].text}" → "${c.text}"`).join(', ')}.`;
  },

  async shorten_pauses(args, ctx) {
    const api = await editorFor(args, ctx);
    const longerMs = num(args, 'longer_than', 1) * 1000;
    const keepMs = num(args, 'keep', 0.5) * 1000;
    if (keepMs >= longerMs) throw new Error('"keep" must be shorter than "longer_than".');
    const todo = pauses(api, longerMs).filter((p) => p.untouched)
      .map((p) => ({ startMs: p.startMs + keepMs / 2, endMs: p.endMs - keepMs / 2 }));
    if (todo.length === 0) return `No pauses longer than ${seconds(longerMs)} s to shorten.`;
    const summary = `Shortened ${plural(todo.length, 'pause')} to ${seconds(keepMs)} s`;
    api.group(summary, ctx.agent, (e) => todo.forEach((r) => e.cutTime(r.startMs, r.endMs)));
    const after = await done(api, ctx, summary);
    const savedMs = todo.reduce((s, r) => s + r.endMs - r.startMs, 0);
    return `${summary}, saving ${seconds(savedMs)} s. ${lengthNow(after)}`;
  },

  async tighten_pauses(args, ctx) {
    const api = await editorFor(args, ctx);
    const rhythm = (str(args, 'rhythm', false) ?? 'natural') as Rhythm['id'];
    const r = RHYTHMS.find((x) => x.id === rhythm);
    if (!r) throw new Error('"rhythm" must be tight, natural or relaxed.');
    let result = { count: 0, savedMs: 0 };
    const label = `Tightened pauses (${r.label.toLowerCase()})`;
    api.group(label, ctx.agent, (e) => { result = e.tightenPauses(r.id); });
    if (result.count === 0) return `No pauses run longer than the ${r.label.toLowerCase()} rhythm allows (${seconds(r.sentence)} s between sentences, ${seconds(r.within)} s within one).`;
    const after = await done(api, ctx, `${label}: ${plural(result.count, 'pause')}`);
    return `Shortened ${plural(result.count, 'pause')} to the ${r.label.toLowerCase()} rhythm, saving ${seconds(result.savedMs)} s. ${lengthNow(after)}`;
  },

  async add_pauses(args, ctx) {
    const api = await editorFor(args, ctx);
    const words = api.words();
    const pauses = list(args, 'pauses').map((p) => {
      const after = num(p, 'after_word');
      const secs = num(p, 'seconds', 0.5);
      if (!Number.isInteger(after) || after < 0 || after >= words.length) throw new Error(`No word ${after}: words go from 0 to ${words.length - 1}.`);
      if (secs < 0.1 || secs > 5) throw new Error('"seconds" must be between 0.1 and 5.');
      return { after, ms: Math.round(secs * 1000) };
    });
    if (pauses.length === 0) throw new Error('"pauses" is empty.');
    const label = str(args, 'label', false) ?? `Added ${plural(pauses.length, 'pause')}`;
    api.group(label, ctx.agent, (e) => pauses.forEach((p) => e.addPause(p.after, p.ms)));
    const after = await done(api, ctx, label);
    return `${label}: ${pauses.map((p) => `${seconds(p.ms)} s after word ${p.after} "${words[p.after].text}"`).join(', ')}. ${lengthNow(after)}`;
  },

  async enhance_audio(args, ctx) {
    const api = await editorFor(args, ctx);
    const enh = api.enhancement();
    // Start from what's applied (or Wave's defaults) and change what's asked.
    // An earlier version's Clear run starts from DPDFNet instead.
    const defaults: EnhanceOptions = { models: 'dpdfnet', loudness: 'podcast', strength: 1, eq: 'off', eqAmount: 'medium' };
    const applied = enh.applied;
    const base: EnhanceOptions = applied
      ? { ...applied, models: applied.models === 'none' ? 'none' : 'dpdfnet' }
      : defaults;
    const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
      const v = str(args, key, false);
      if (v === undefined) return undefined;
      if (!allowed.includes(v as T)) throw new Error(`"${key}" must be one of ${allowed.join(', ')}.`);
      return v as T;
    };
    if (['clear', 'both'].includes(str(args, 'noise_removal', false) ?? '')) {
      throw new Error('Clear is no longer part of Wave: use "dpdfnet" (or "none").');
    }
    const strength = pick('strength', ['subtle', 'medium', 'full'] as const);
    const options: EnhanceOptions = {
      models:   pick('noise_removal', ['none', 'dpdfnet'] as const) ?? base.models,
      strength: strength ? { subtle: 0.4, medium: 0.7, full: 1 }[strength] : base.strength,
      eq:       pick('eq', ['off', ...EQ_PRESETS.map((p) => p.id)]) ?? base.eq,
      eqAmount: (pick('eq_amount', ['subtle', 'medium', 'strong'] as const) as EqAmount | undefined) ?? base.eqAmount,
      loudness: pick('loudness', ['podcast', 'streaming', 'broadcast', 'off'] as const) ?? base.loudness,
    };
    api.enhance(options);
    activity.announce(`${ctx.agent}: enhancing speech`, api.projectId);
    return `Started speech enhancement on "${api.name}": ${describeEnhancement(options)}. `
      + (options.models === 'dpdfnet' ? 'The clean-up takes about 6–10 minutes per hour of audio; ' : '')
      + 'get_project shows when it\'s done. The enhanced audio is then used for playback and export (use_enhanced_audio switches it).';
  },

  async use_enhanced_audio(args, ctx) {
    const api = await editorFor(args, ctx);
    const on = args.on;
    if (typeof on !== 'boolean') throw new Error('"on" must be true or false.');
    api.setEnhanced(on);
    await done(api, ctx, on ? 'enhanced audio on' : 'enhanced audio off');
    return on ? 'Playback and export now use the enhanced audio.' : 'Playback and export now use the original audio.';
  },

  async rename_speaker(args, ctx) {
    const api = await editorFor(args, ctx);
    const speakers = api.speakers();
    if (speakers === null) throw new Error('Speakers haven\'t been detected yet: run analyze with kind "speakers" first.');
    const ref = str(args, 'speaker')!.toLowerCase();
    const name = str(args, 'name')!;
    const speaker = speakers.find((s) => s.name.toLowerCase() === ref)
      ?? speakers.find((s) => `speaker ${s.id + 1}` === ref || String(s.id + 1) === ref);
    if (!speaker) throw new Error(`No speaker "${args.speaker}". Speakers: ${speakers.map((s) => s.name).join(', ')}.`);
    api.renameSpeaker(speaker.id, name);
    await done(api, ctx, `Renamed ${speaker.name} to ${name}`);
    return `${speaker.name} is now "${name}".`;
  },

  async list_edits(args, ctx) {
    const api = await editorFor(args, ctx);
    const edits = api.edits();
    if (edits.length === 0) return 'No edits yet.';
    const rows: string[] = [];
    const seen = new Set<string>();
    for (const e of [...edits].reverse()) {
      if (e.group) {
        if (seen.has(e.group.id)) continue;
        seen.add(e.group.id);
        rows.push(`- ${e.id}: ${e.group.label} (by ${e.group.agent})`);
      } else {
        rows.push(`- ${e.id}: ${e.label}`);
      }
    }
    return [`${plural(rows.length, 'edit')}, newest first:`, ...rows.slice(0, 100)].join('\n');
  },

  async undo(args, ctx) {
    const api = await editorFor(args, ctx);
    const label = api.undo(str(args, 'edit_id', false));
    if (label === null) throw new Error(args.edit_id ? `No edit "${args.edit_id}" (see list_edits).` : 'There\'s no agent edit to undo.');
    const after = await done(api, ctx, `Undid "${label}"`);
    return `Undid "${label}". ${lengthNow(after)}`;
  },

  async analyze(args, ctx) {
    const api = await editorFor(args, ctx);
    const kind = str(args, 'kind', false) ?? 'speakers';
    if (kind !== 'speakers') throw new Error('"kind" must be "speakers". Fillers are words in the transcript: find them with find_text and cut them with cut_words.');
    api.analyze();
    return `Started speaker detection on "${api.name}". It takes about a minute per hour of audio; get_project shows when it's done.`;
  },

  async export_text(args, ctx) {
    const api = await editorFor(args, ctx);
    const format = str(args, 'format');
    if (format !== 'txt' && format !== 'srt' && format !== 'vtt' && format !== 'json') {
      throw new Error('"format" must be txt, srt, vtt or json.');
    }
    return api.exportText(format);
  },

  async export_audio(args, ctx) {
    const api = await editorFor(args, ctx);
    // A preset ("mp3-192") or a format at its standard preset ("flac").
    const chosen = findPreset(str(args, 'format', false) ?? 'mp3');
    if (!chosen) throw new Error(`"format" must be one of ${PRESET_IDS.join(', ')}.`);
    const { format, preset } = chosen;
    const enh = api.enhancement();
    const enhanced = typeof args.enhanced === 'boolean' ? args.enhanced : enh.on;
    if (enhanced && !enh.exists) throw new Error('This project has no enhanced audio yet: export without it, or run enhance_audio first.');
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
    const file = `${api.name.replace(/[/\\:*?"<>|]+/g, '-')} (edited ${stamp}).${format.ext}`;
    const dest = await join(await downloadDir(), file);
    await activity.track(
      { id: `export:${api.projectId}`, label: 'Exporting audio', doneLabel: `Exported for ${ctx.agent}`, projectId: api.projectId, quietMs: 500 },
      () => api.exportAudio(dest, enhanced, preset.settings),
    );
    return `Exported ${clock(api.editedMs)} of ${enhanced ? 'enhanced' : 'original'} audio as ${format.name} (${preset.name}: ${preset.note}) to ${dest}`;
  },

  async import_audio(args, ctx) {
    const path = str(args, 'path')!;
    const fileName = path.split('/').pop() ?? path;
    const name = str(args, 'name', false) ?? fileName.replace(/\.[^.]+$/, '');
    const project = await ctx.importAudio(path, name);
    activity.announce(`${ctx.agent}: imported "${name}"`, project.id);
    return ctx.hasTranscriber
      ? `Importing "${name}" (id ${project.id}); transcription starts when the import is done. Check get_project until it's ready.`
      : `Importing "${name}" (id ${project.id}), but transcription isn't set up: download it in Wave → Settings, then it can be transcribed.`;
  },
};
