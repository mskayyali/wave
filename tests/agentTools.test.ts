import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runTool, type AgentContext } from '../src/lib/agentTools';
import { registerEditor, serializeAgentCalls, type AgentWord, type EditorAgentApi } from '../src/lib/agent';
import { inspectTransitions } from '../src/lib/agentTransitions';
import { computeCutOps, type TimeOp } from '../src/lib/cutBoundaries';
import { buildEditPlan } from '../src/lib/editPlan';
import { activity } from '../src/lib/activity';

const words: AgentWord[] = [
  { n: 0, text: 'one', startMs: 0, endMs: 100, confidence: 0.9, speaker: null, cut: false, partCut: false },
  { n: 1, text: 'um', startMs: 100, endMs: 200, confidence: 0.9, speaker: null, cut: false, partCut: false },
  { n: 2, text: 'two', startMs: 200, endMs: 400, confidence: 0.9, speaker: null, cut: false, partCut: false },
];
const enriched = words.map((w) => ({ ...w, isSilence: false }));
const context: AgentContext = {
  agent: 'test', projects: () => [{ id: 'test', name: 'test', status: { type: 'ready' }, createdAt: 0 }],
  open() { throw new Error('Unexpected project switch'); },
  async importAudio() { throw new Error('Unexpected import'); }, hasTranscriber: true,
};
let unregister: () => void;
let revision: number, ready: boolean, history: number, deleted: Set<number>, ranges: { startMs: number; endMs: number; id: string }[];
let announce: ReturnType<typeof spyOn>;
let api: EditorAgentApi;
function resolve(extraWords: number[] = [], extraRanges: { startMs: number; endMs: number }[] = []) {
  const proposed = new Set([...deleted, ...extraWords]);
  const ops = computeCutOps(enriched, proposed, [...ranges, ...extraRanges.map((r, i) => ({ ...r, id: `p${i}` }))], new Map(), new Float32Array(100).fill(0.2));
  return inspectTransitions(buildEditPlan(1000, ops), ops, words, new Map(), `r${revision}`, ready);
}
beforeEach(() => {
  revision = 1; ready = true; history = 0; deleted = new Set(); ranges = [];
  announce = spyOn(activity, 'announce').mockImplementation(() => {});
  api = {
    projectId: 'test', name: 'test', language: 'en', durationMs: 1000,
    get editedMs() { return resolve().durationMs; },
    words: () => words.map((w) => ({ ...w, cut: deleted.has(w.n) })),
    editingState: () => resolve(), planEdit: resolve, settled: async () => {},
    group(_label, _agent, run) {
      run({ cutWords: (ns: number[]) => ns.forEach((n) => deleted.add(n)),
        cutTime: (startMs: number, endMs: number) => ranges.push({ startMs, endMs, id: `r${ranges.length}` }) } as never);
      history++; revision++;
    },
  } as EditorAgentApi;
  unregister = registerEditor('test', () => api);
});
afterEach(() => { unregister(); announce.mockRestore(); });

describe('MCP editing contract', () => {
  test('dry run exposes actual joins without mutating anything, and applying matches it', async () => {
    const report = await runTool('plan_edit', { project: 'test', word_ranges: [{ from: 1, to: 1 }] }, context);
    expect(report).toContain('DRY RUN');
    expect(report).toContain('Revision: r1');
    expect(report).toContain('edited duration 0.898000 s');
    expect(report).toContain('fade 2.000 ms');
    expect(report).toContain('REVIEW:');
    expect(history).toBe(0);
    expect(deleted.size).toBe(0);
    const result = await runTool('cut_words', { project: 'test', ranges: [{ from: 1, to: 1 }], expected_revision: 'r1' }, context);
    expect(result).toContain('flagged for listening review');
    expect(api.editedMs).toBe(898);
    expect(history).toBe(1);
    expect(await runTool('get_transitions', { project: 'test' }, context)).toContain('fade 2.000 ms');
  });

  test('stale, malformed and fractional word requests make no edit', async () => {
    for (const args of [
      { expected_revision: 'old', ranges: [{ from: 1, to: 1 }] },
      { expected_revision: 123, ranges: [{ from: 1, to: 1 }] },
      { ranges: [{ from: 0.6, to: 1 }] },
    ]) await expect(runTool('cut_words', { project: 'test', ...args }, context)).rejects.toThrow();
    expect(history).toBe(0);
  });

  test('time cuts guard speech; explicit exact trims remain available', async () => {
    await expect(runTool('cut_time', { project: 'test', ranges: [{ start: 0.21, end: 0.23 }] }, context)).rejects.toThrow('allow_word_trim');
    expect(history).toBe(0);
    const report = await runTool('plan_edit', { project: 'test', time_ranges: [{ start: 0.21, end: 0.23 }], allow_word_trim: true }, context);
    expect(report).toContain('partly trims words 2');
    const result = await runTool('cut_time', { project: 'test', ranges: [{ start: 0.21, end: 0.23 }], allow_word_trim: true, expected_revision: 'r1' }, context);
    expect(result).toContain('partly trims speech');
    expect(ranges[0].startMs).toBe(210);
    expect(ranges[0].endMs).toBe(230);
  });

  test('pause cuts work without overriding word protection, and bounds are enforced', async () => {
    await runTool('cut_time', { project: 'test', ranges: [{ start: 0.5, end: 0.6 }] }, context);
    expect(history).toBe(1);
    for (const r of [{ start: -0.1, end: 0.1 }, { start: 0.5, end: 1.01 }, { start: 0.5, end: 0.501 }, { start: 0.7, end: 0.5 }]) {
      await expect(runTool('cut_time', { project: 'test', ranges: [r] }, context)).rejects.toThrow();
    }
    expect(history).toBe(1);
  });

  test('restoring cannot falsely claim success for audio still removed by a time cut', async () => {
    api.words = () => words.map((w) => ({ ...w, cut: w.n === 1 }));
    api.restore = () => {};
    await expect(runTool('restore_words', { project: 'test', ranges: [{ from: 1, to: 1 }] }, context)).rejects.toThrow('No words were restored');
  });

  test('restoring partial manual trims verifies the retained audio too', async () => {
    let partial = true;
    api.words = () => words.map(w => ({ ...w, partCut: w.n === 1 && partial }));
    api.restore = () => {};
    await expect(runTool('restore_words', { project: 'test', ranges: [{ from: 1, to: 1 }] }, context)).rejects.toThrow('No words were restored');
    api.restore = () => { partial = false; };
    expect(await runTool('restore_words', { project: 'test', ranges: [{ from: 1, to: 1 }] }, context)).toContain('one undoable step');
  });

  test('analysis must be ready before audio editing, but inspection can show preparation', async () => {
    ready = false;
    await expect(runTool('plan_edit', { project: 'test', word_ranges: [{ from: 1, to: 1 }] }, context)).rejects.toThrow('preparing');
    await expect(runTool('cut_words', { project: 'test', ranges: [{ from: 1, to: 1 }] }, context)).rejects.toThrow('preparing');
    expect(await runTool('get_transitions', { project: 'test' }, context)).toContain('Analysis ready: false');
    expect(history).toBe(0);
  });

  test('dry-run mode, booleans and paging are checked at runtime', async () => {
    for (const extra of [
      {}, { word_ranges: [{ from: 1, to: 1 }], time_ranges: [{ start: 0.5, end: 0.6 }] },
      { word_ranges: [{ from: 1, to: 1 }], limit: 101 },
      { word_ranges: [{ from: 1, to: 1 }], review_only: 'false' },
    ]) await expect(runTool('plan_edit', { project: 'test', ...extra }, context)).rejects.toThrow();
    expect(history).toBe(0);
  });
});

test('inspection reports manual boundaries and partial trims at the start of a file', () => {
  const ops: TimeOp[] = [{ startMs: 0, endMs: 250, startKey: 'a', endKey: 'b' }];
  const state = inspectTransitions(buildEditPlan(1000, ops), ops, words, new Map([['b', 250]]), 'r', true);
  expect(state.cuts[0].manualBoundary).toBe(true);
  expect(state.cuts[0].partialWords).toEqual([2]);
  expect(state.transitions).toHaveLength(0);
});

test('missing room tone is reported on both joins of the inserted silence', () => {
  const state = inspectTransitions(buildEditPlan(1000, [], [{ atMs: 500, ms: 100 }]), [], words, new Map(), 'r', true);
  expect(state.transitions).toHaveLength(2);
  expect(state.transitions.every((t) => t.reviewReasons.some((r) => r.includes('digital silence')))).toBe(true);
});

test('concurrent agent requests settle in order, and failure does not poison later calls', async () => {
  const enqueue = serializeAgentCalls();
  const events: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = enqueue(async () => { events.push(1); await gate; events.push(2); });
  const failed = enqueue(async () => { events.push(3); throw new Error('expected failure'); });
  const rejected = failed.catch((e: Error) => e.message);
  const last = enqueue(async () => { events.push(4); });
  await Promise.resolve();
  expect(events).toEqual([1]);
  release();
  await first; expect(await rejected).toBe('expected failure'); await last;
  expect(events).toEqual([1, 2, 3, 4]);
});
