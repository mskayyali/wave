import { expect, test } from 'bun:test';
import { EditHistory } from '../src/lib/editHistory';
import { wordAudioState } from '../src/lib/wordAudioState';
import { parseEditorSession } from '../src/lib/editorSession';
import { selectionWordIndices, wordCutIntent } from '../src/lib/selection';
import { subtractRanges } from '../src/lib/ranges';
import { visibleRulerTicks, wheelPixels, wheelZoom } from '../src/lib/waveformGeometry';
import { buildEditPlan, mapEditedWords } from '../src/lib/editPlan';

const word = { startMs: 150, endMs: 250 };
test('only explicit text selections request word deletion, even at identical boundaries', () => {
  expect(selectionWordIndices({ ...word, kind: 'audio' }, [word])).toBeNull();
  expect(selectionWordIndices({ startMs: 151, endMs: 250, kind: 'audio' }, [word])).toBeNull();
  expect(selectionWordIndices({ ...word, kind: 'words' }, [word])).toEqual([0]);
  expect(selectionWordIndices({ ...word, kind: 'words', wordIndices: [1] }, [word, { startMs: 200, endMs: 300 }])).toEqual([1]);
});
test('overlapping manual cuts count their union and retain small word fragments', () => {
  const state = wordAudioState([word], [{ startMs: 150, endMs: 220 }, { startMs: 180, endMs: 249 }], 300);
  expect(state.fullCutWords.size).toBe(0);
  expect(state.partCutWords.has(0)).toBe(true);
  expect(state.retainedMs.get(0)).toBe(1);
  expect(wordAudioState([word], [{ startMs: 150, endMs: 151 }], 300).partCutWords.has(0)).toBe(true);
});
test('manual boundary changes are reflected in text and subtitle survival', () => {
  const removed = wordAudioState([word], [{ startMs: 125, endMs: 275 }], 300);
  expect(removed.fullCutWords.has(0)).toBe(true);
  const cuts = [{ startMs: 175, endMs: 275 }];
  expect(wordAudioState([word], cuts, 300).partCutWords.has(0)).toBe(true);
  expect(mapEditedWords(buildEditPlan(300, cuts), [{ ...word, text: 'um' }])).toHaveLength(1);
});
test('restoration preserves unrelated exact boundaries and metadata', () => {
  const cuts = [{ startMs: 100.25, endMs: 600.75, fadeMs: 2, review: true }, { startMs: 800, endMs: 900, fadeMs: 12 }];
  const result = subtractRanges(cuts, [{ startMs: 150, endMs: 250 }, { startMs: 200, endMs: 300 }]);
  expect(result).toEqual([{ startMs: 100.25, endMs: 150, fadeMs: 2, review: true }, { startMs: 300, endMs: 600.75, fadeMs: 2, review: true }, cuts[1]]);
  expect(result[2]).toBe(cuts[1]);
});
test('restoration is undoable even when it leaves no cuts, and redo is exact', () => {
  const history = new EditHistory<{id: string}>();
  const original = [{ id: 'cut' }, { id: 'nudge' }];
  history.hydrate(original);
  history.set([]);
  history.undo(); expect(history.current).toEqual(original);
  history.redo(); expect(history.current).toEqual([]);
  history.undo(); history.set([{ id: 'new' }]); history.redo();
  expect(history.current).toEqual([{ id: 'new' }]);
});
test('multiple edge changes and rapid undo preserve single transaction boundaries', () => {
  const h = new EditHistory<{id: string; group?: {id: string}}>();
  h.set([{ id: 'cut' }]);
  h.set([...h.current, { id: 'left' }, { id: 'right' }]);
  h.undo(); expect(h.current.map(a => a.id)).toEqual(['cut']);
  h.undo(); expect(h.current).toEqual([]);
  h.redo(); h.redo(); expect(h.current.map(a => a.id)).toEqual(['cut', 'left', 'right']);
  h.set([...h.current, { id: 'agent1', group: { id: 'g' } }]);
  h.set([...h.current, { id: 'agent2', group: { id: 'g' } }]);
  h.undo(); expect(h.current.map(a => a.id)).toEqual(['cut', 'left', 'right']);
});
test('project positions validate stale transcripts, corrupt storage and source bounds', () => {
  const saved = { version: 1, fingerprint: 'a', playheadMs: 9000, centerMs: -5, spanMs: 2000, panelHeight: 900,
    selection: { startMs: 150, endMs: 250, kind: 'words' }, textAnchor: { word: 2, offset: -10 }, viewMode: 'segments', pane: 'audio' };
  const same = parseEditorSession(JSON.stringify(saved), 1000, 'a')!;
  expect(same.playheadMs).toBe(1000); expect(same.centerMs).toBe(0); expect(same.panelHeight).toBe(600);
  expect(same.selection?.kind).toBe('words'); expect(same.textAnchor?.offset).toBe(-10);
  const stale = parseEditorSession(JSON.stringify(saved), 1000, 'b')!;
  expect(stale.selection).toBeNull(); expect(stale.textAnchor).toBeNull(); expect(stale.playheadMs).toBe(1000);
  expect(parseEditorSession('broken', 1000, 'a')).toBeNull();
  expect(parseEditorSession(JSON.stringify(saved), 0, 'a')).toBeNull();
});
test('deep zoom only creates visible fine ruler ticks; wheel zoom remains positive', () => {
  const ticks = visibleRulerTicks(7_200_101, 7_200_121, 14_400_000);
  expect(ticks.length).toBeLessThan(12); expect(ticks[1] - ticks[0]).toBe(5);
  expect(wheelPixels(3, 1, 800)).toBe(48); expect(wheelPixels(2, 2, 800)).toBe(1600);
  expect(wheelZoom(100000)).toBeGreaterThan(0); expect(wheelZoom(-100000)).toBeLessThan(8);
});

test('project saves finish in order across reopening and recover after a failed write', async () => {
  const { ProjectSaveQueue } = await import('../src/lib/editPersistence');
  const queue = new ProjectSaveQueue();
  const calls: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const first = queue.write('a', async () => { calls.push('a1'); await gate; });
  const second = queue.write('a', async () => { calls.push('a2'); throw new Error('disk'); }).catch(() => calls.push('failed'));
  const third = queue.write('a', async () => { calls.push('a3'); });
  await queue.write('b', async () => { calls.push('b'); });
  expect(calls).toEqual(['a1', 'b']);
  let reopened = false;
  const reopen = queue.settled('a').then(() => { reopened = true; });
  expect(reopened).toBe(false); finish();
  await Promise.all([first, second, third, reopen]);
  expect(calls).toEqual(['a1', 'b', 'a2', 'failed', 'a3']);
  expect(reopened).toBe(true);
});

test('silence sentinels reflect their actual cut audio too', () => {
  const silence = { startMs: 100, endMs: 4000, isSilence: true };
  expect(wordAudioState([silence], [silence], 5000).fullCutWords.has(0)).toBe(true);
  expect(wordAudioState([silence], [{ startMs: 100, endMs: 200 }], 5000).partCutWords.has(0)).toBe(true);
});

test('re-cutting manually revealed word audio produces an exact fill, not a stale word nudge', () => {
  expect(wordCutIntent([0, 1, 2, 1], new Set([1, 2]), new Set([2]))).toEqual({ kept: [0, 1], fresh: [0], revealed: [1] });
});

test('added-pause markers use the playback insertion point, including cut and file-end pauses', async () => {
  const { resolvePauseMarkers, PAUSE_LENGTHS } = await import('../src/lib/pauseOptions');
  const pauses = [{ id: 'inside', atMs: 200, ms: 500 }, { id: 'end', atMs: 1000, ms: 250 }];
  expect(resolvePauseMarkers(pauses, [{ startMs: 100, endMs: 400 }], 1000)).toEqual([
    { id: 'inside', atMs: 400, ms: 500 }, { id: 'end', atMs: 1000, ms: 250 },
  ]);
  expect(PAUSE_LENGTHS).toEqual([250, 500, 1000, 2000]);
});
