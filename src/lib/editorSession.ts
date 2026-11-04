export interface EditorSelection { startMs: number; endMs: number; kind?: 'words' | 'audio'; wordIndices?: number[] }
export interface EditorSession {
  version: 1;
  fingerprint: string | null;
  playheadMs: number;
  selection: EditorSelection | null;
  wordSelection?: { indices: number[]; speaker: number; label: string } | null;
  viewMode: 'flow' | 'segments';
  pane: 'text' | 'audio';
  following: boolean;
  centerMs: number;
  spanMs: number;
  panelHeight: number;
  textAnchor: { word: number; offset: number } | null;
}
const finite = (x: unknown, fallback: number) => typeof x === 'number' && Number.isFinite(x) ? x : fallback;
export function parseEditorSession(json: string | null, duration: number, fingerprint: string | null): EditorSession | null {
  try {
    const s = JSON.parse(json ?? 'null');
    if (!s || s.version !== 1 || !(duration > 0)) return null;
    const clamp = (x: unknown) => Math.max(0, Math.min(duration, finite(x, 0)));
    const matches = s.fingerprint === fingerprint;
    const start = clamp(s.selection?.startMs), end = clamp(s.selection?.endMs);
    return {
      version: 1, fingerprint, playheadMs: clamp(s.playheadMs),
      selection: matches && end - start >= 1 ? { startMs: start, endMs: end, kind: s.selection?.kind === 'words' ? 'words' : 'audio',
        ...(Array.isArray(s.selection?.wordIndices) ? { wordIndices: s.selection.wordIndices.filter((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0) } : {}) } : null,
      wordSelection: matches && Array.isArray(s.wordSelection?.indices) && Number.isInteger(s.wordSelection.speaker) && typeof s.wordSelection.label === 'string'
        ? { indices: s.wordSelection.indices.filter((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0), speaker: s.wordSelection.speaker, label: s.wordSelection.label } : null,
      viewMode: s.viewMode === 'segments' ? 'segments' : 'flow', pane: s.pane === 'audio' ? 'audio' : 'text', following: s.following === true,
      centerMs: clamp(s.centerMs), spanMs: Math.max(1, Math.min(duration, finite(s.spanMs, duration))),
      panelHeight: Math.max(140, Math.min(600, finite(s.panelHeight, 240))),
      textAnchor: matches && Number.isInteger(s.textAnchor?.word) && s.textAnchor.word >= 0
        ? { word: s.textAnchor.word, offset: finite(s.textAnchor.offset, 0) } : null,
    };
  } catch { return null; }
}
