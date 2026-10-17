import type { EditAction } from '../pages/EditorPage';
import type { EnhanceModelsReady, EnhanceOptions } from '../hooks/useEnhancement';
import type { Rhythm } from './pauses';
import type { ExportSettings } from './audioFormats';

// AI agents: what the editor lets them see and do. A tool call reaches the
// frontend as an `agent:request` (hooks/useAgent.ts), runTool (agentTools.ts)
// carries it out through the EditorAgentApi of the project open in the
// editor, which registers here once its transcript and edits are loaded.
//
// Agents refer to words by their number: the position in transcript.json,
// which never changes as the project is edited (enrichedWords also holds
// pause markers, so its indices aren't shown to agents).

export interface AgentWord {
  /** Word number: its position in the transcript. */
  n:              number;
  text:           string;
  startMs:        number;
  endMs:          number;
  confidence:     number;
  speaker:        string | null;
  /** Cut: deleted, or all of its audio cut. */
  cut:            boolean;
  /** Part of its audio is cut. */
  partCut:        boolean;
  /** What transcription heard, when the word was corrected. */
  correctedFrom?: string;
}


/** A pause between kept words that no edit has touched (word numbers either side). */
export interface AgentPause {
  before:   number;
  after:    number;
  startMs:  number;
  endMs:    number;
  /** Between sentences (or speakers), so it may stay longer. */
  sentence: boolean;
}

/** Speech enhancement: what's applied and what can run. */
export interface AgentEnhancement {
  exists:   boolean;
  /** The enhanced audio plays and exports. */
  on:       boolean;
  running:  boolean;
  /** 0–1 while running. */
  progress: number | null;
  applied:  EnhanceOptions | null;
  ready:    EnhanceModelsReady;
}

/** Edits made inside `group`: they become one edit. */
export interface AgentEdits {
  cutWords(words: number[]): void;
  cutTime(startMs: number, endMs: number): void;
  correct(word: number, text: string): void;
  /** Shorten the long pauses to a rhythm (the Pauses tool); returns what it cut. */
  tightenPauses(rhythm: Rhythm['id']): { count: number; savedMs: number };
  /** Add `ms` of room tone after word `after` (in the gap to the next word). */
  addPause(after: number, ms: number): void;
}

export interface EditorAgentApi {
  projectId:  string;
  name:       string;
  language:   string;
  durationMs: number;
  /** Length after the edits. */
  editedMs:   number;
  words():    AgentWord[];
  /** Null until speaker detection has run. */
  speakers(): { id: number; name: string; talkMs: number }[] | null;
  /** The cut ranges, as playback skips them. */
  cuts():     { startMs: number; endMs: number }[];
  edits():    EditAction[];
  enhancement(): AgentEnhancement;
  /** Run speech enhancement (clean-up, EQ, loudness) with these options; starts and returns. */
  enhance(options: EnhanceOptions): void;
  /** Use the enhanced audio for playback and export (or the original). */
  setEnhanced(on: boolean): void;
  /** Pauses between kept words no edit has touched, in order. */
  pauses(): AgentPause[];
  /** Pauses added by hand or by an agent. */
  addedPauses(): { atMs: number; ms: number }[];
  /** Make edits as one: labelled, credited to `agent`, undone together. */
  group(label: string, agent: string, make: (edits: AgentEdits) => void): void;
  restore(words: number[]): void;
  /** Undo the edit with this id (with its group), or else the last agent edit. Returns its label. */
  undo(editId?: string): string | null;
  renameSpeaker(id: number, name: string): void;
  /** Start speaker detection; an error says why it can't. */
  analyze(): void;
  exportText(format: 'txt' | 'srt' | 'vtt' | 'json'): string;
  exportAudio(destPath: string, enhanced: boolean, format: ExportSettings): Promise<void>;
  /** Resolves once edits made so far show in the editor's state. */
  settled(): Promise<void>;
}

// ─── The open editor ──────────────────────────────────────────────────────────

let open: { projectId: string; api: () => EditorAgentApi } | null = null;
const watchers = new Set<() => void>();

/** Called by the editor once it's ready; returns the unregister function. */
export function registerEditor(projectId: string, api: () => EditorAgentApi): () => void {
  const entry = { projectId, api };
  open = entry;
  watchers.forEach((w) => w());
  return () => { if (open === entry) open = null; };
}

/** The editor's API if this project is open and ready. */
export function openEditor(projectId: string): EditorAgentApi | null {
  return open?.projectId === projectId ? open.api() : null;
}

/** Wait for this project's editor to be ready. */
export function waitForEditor(projectId: string, timeoutMs: number): Promise<EditorAgentApi> {
  return new Promise((resolve, reject) => {
    const ready = openEditor(projectId);
    if (ready) { resolve(ready); return; }
    const watch = () => {
      const api = openEditor(projectId);
      if (!api) return;
      done();
      resolve(api);
    };
    const timer = window.setTimeout(() => {
      done();
      reject(new Error('The project took too long to open in Wave.'));
    }, timeoutMs);
    const done = () => { window.clearTimeout(timer); watchers.delete(watch); };
    watchers.add(watch);
  });
}

/** What an agent app calls itself → how Wave credits its edits. */
export function agentName(client: string | null | undefined): string {
  const c = (client ?? '').toLowerCase();
  if (c.includes('claude'))  return 'Claude';
  if (c.includes('codex'))   return 'Codex';
  if (c.includes('chatgpt') || c.includes('openai')) return 'ChatGPT';
  if (c.includes('cursor'))  return 'Cursor';
  return client?.trim() || 'AI agent';
}
