import { describe, expect, test } from 'bun:test';
import { buildEditPlan, editedTime, mapEditedWords, renderPlan, toneSample } from '../src/lib/editPlan';
import { computeCutOps } from '../src/lib/cutBoundaries';
import { toSRT, toVTT } from '../src/utils/exportFormats';
import fixtures from './fixtures/edit-plans.json';

describe('one resolved timeline', () => {
  test('no edits preserve every sample; full deletion is empty', () => {
    const source = Float32Array.from([0.2, -0.1, 0.5, 0.7]);
    expect(renderPlan(buildEditPlan(4, []), [source], 1000)[0]).toEqual(source);
    const plan = buildEditPlan(4, [{ startMs: -10, endMs: 10 }]);
    expect(plan.durationMs).toBe(0);
    expect(renderPlan(plan, [source], 1000)[0].length).toBe(0);
  });

  test('short retained pieces survive; the two fades cannot overlap', () => {
    const plan = buildEditPlan(100, [{ startMs: 20, endMs: 40 }, { startMs: 44, endMs: 60 }]);
    expect(plan.pieces.map((p) => p.durationMs)).toEqual([20, 4, 40]);
    expect(plan.pieces[1].fadeInMs).toBe(2);
    expect(plan.pieces[1].fadeOutMs).toBe(2);
    expect(plan.durationMs).toBe(60);
  });

  test('subtitle times account for every overlap, including many cuts', () => {
    const cuts = Array.from({ length: 100 }, (_, i) => ({ startMs: i * 100 + 40, endMs: i * 100 + 60 }));
    const plan = buildEditPlan(10001, cuts);
    expect(plan.durationMs).toBe(7501);
    expect(editedTime(plan, 10000, 'start')).toBe(7500);
  });

  test('insertions on a boundary and inside a cut map to the audio that plays', () => {
    const plan = buildEditPlan(1000, [{ startMs: 400, endMs: 600 }], [{ atMs: 500, ms: 100 }]);
    expect(plan.durationMs).toBe(890);
    expect(plan.inserts[0].atMs).toBe(600);
    expect(editedTime(plan, 400, 'end')).toBe(400);
    expect(editedTime(plan, 600, 'start')).toBe(490);
    const split = buildEditPlan(1000, [], [{ atMs: 500, ms: 100 }]);
    expect(editedTime(split, 500, 'end')).toBe(500);
    expect(editedTime(split, 500, 'start')).toBe(590);
  });

  test('fully cut words disappear, partially cut words are clipped, captions stay valid', () => {
    const plan = buildEditPlan(1000, [{ startMs: 200, endMs: 600 }], [{ atMs: 300, ms: 100 }]);
    const words = [
      { text: 'kept', startMs: 0, endMs: 100, confidence: 1 },
      { text: 'gone', startMs: 300, endMs: 400, confidence: 1 },
      { text: 'also gone', startMs: 400, endMs: 600, confidence: 1 },
      { text: 'part', startMs: 550, endMs: 700, confidence: 1 },
    ];
    const mapped = mapEditedWords(plan, words);
    expect(mapped.map((w) => w.text)).toEqual(['kept', 'part']);
    expect(mapped[1].startMs).toBe(290);
    expect(mapped[1].endMs).toBe(390);
    const fractional = [{ text: 'word', startMs: 0.25, endMs: 2.75, confidence: 1 }];
    expect(toSRT(fractional)).toContain('00:00:00,000 --> 00:00:00,003');
    expect(toVTT(fractional)).toContain('00:00:00.000 --> 00:00:00.003');
  });

  test('chunked rendering and seeking preserve exactly the same join samples', () => {
    const plan = buildEditPlan(100, [{ startMs: 20.3, endMs: 39.7 }], [{ atMs: 60, ms: 33, tone: { startMs: 0, endMs: 30 } }]);
    const source = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i * 0.13));
    const full = renderPlan(plan, [source], 44100)[0];
    const chunks = [renderPlan(plan, [source], 44100, 0, 777)[0], renderPlan(plan, [source], 44100, 777, full.length)[0]];
    expect(Float32Array.from([...chunks[0], ...chunks[1]])).toEqual(full);
    expect(renderPlan(plan, [source], 44100, 333, 999)[0]).toEqual(full.slice(333, 999));
  });

  test('correlated full-scale audio cannot gain a crossfade peak', () => {
    for (const sr of [1000, 44100, 48000]) {
      const plan = buildEditPlan(30.7, [{ startMs: 10.3, endMs: 20.2, fadeMs: 5.3 }]);
      const out = renderPlan(plan, [new Float32Array(Math.ceil(30.7 * sr / 1000)).fill(1)], sr)[0];
      expect(Math.max(...out)).toBeLessThanOrEqual(1.000001);
      expect(Math.min(...out)).toBeGreaterThanOrEqual(0.999999);
    }
  });

  test('room-tone wraps blend instead of jumping between endpoints', () => {
    const data = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    const loop = Float32Array.from({ length: 400 }, (_, i) => toneSample(data, 0, 100, i, 1000));
    let biggest = 0;
    for (let i = 1; i < loop.length; i++) biggest = Math.max(biggest, Math.abs(loop[i] - loop[i - 1]));
    expect(biggest).toBeLessThan(0.25); // raw loop jumps by .99
  });

  test('multiple pauses at the same point and zero-length source remain ordered', () => {
    const plan = buildEditPlan(1000, [], [{ atMs: 500, ms: 100 }, { atMs: 500, ms: 50 }]);
    expect(plan.durationMs).toBe(1135);
    expect(editedTime(plan, 500, 'end')).toBe(500);
    expect(editedTime(plan, 500, 'start')).toBe(635);
    const empty = buildEditPlan(0, [], [{ atMs: 0, ms: 100 }]);
    expect(empty.durationMs).toBe(100);
    expect(renderPlan(empty, [new Float32Array(0)], 1000)[0].length).toBe(100);
  });

  test('invalid input cannot introduce NaNs or inverted cuts', () => {
    const plan = buildEditPlan(100, [{ startMs: NaN, endMs: 50 }, { startMs: 80, endMs: 20 }], [{ atMs: Infinity, ms: 5 }]);
    expect(plan.durationMs).toBe(100);
    expect(plan.cuts).toEqual([]);
  });

  test('playback matches the fixtures also consumed by native export', () => {
    for (const f of fixtures) {
      const plan = buildEditPlan(f.plan.sourceDurationMs, f.plan.cuts, f.plan.inserts);
      expect(plan).toEqual(f.plan);
      const source = Array.from({ length: f.channels }, (_, c) => Float32Array.from({ length: f.sourceFrames }, (_, i) => ((i * 17 + c * 7) % 97 - 48) / 64));
      expect(renderPlan(plan, source, f.sr).map((c) => Array.from(c))).toEqual(f.expected);
    }
  });
});

const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs, confidence: 1, isSilence: false });
describe('protected cut boundaries', () => {
  test('quiet consonants inside kept words are never cut', () => {
    const energy = new Float32Array(100).fill(0.5);
    energy[26] = 0; energy[53] = 0;
    const words = [word('keep', 100, 300), word('delete', 300, 500), word('keep', 500, 700)];
    const [cut] = computeCutOps(words, new Set([1]), [], new Map(), energy);
    expect(cut.startMs).toBe(300);
    expect(cut.endMs).toBe(500);
    expect(cut.fadeMs).toBe(2);
    expect(cut.review).toBe(true);
  });

  test('boundary pairs favour quiet points within the permitted gaps', () => {
    const energy = new Float32Array(100).fill(1);
    energy[14] = 0.01; energy[35] = 0.01;
    const words = [word('keep', 0, 100), word('delete', 200, 300), word('keep', 400, 500)];
    const [cut] = computeCutOps(words, new Set([1]), [], new Map(), energy);
    expect(cut.startMs).toBe(145);
    expect(cut.endMs).toBe(350);
    expect(cut.fadeMs).toBe(12);
    expect(cut.review).toBe(false);
  });

  test('manual boundaries remain exact even inside a word', () => {
    const words = [word('keep', 100, 300), word('delete', 350, 500), word('keep', 550, 700)];
    const [cut] = computeCutOps(words, new Set([1]), [], new Map([['ws:1', 290], ['we:1', 560]]), new Float32Array(100));
    expect(cut.startMs).toBe(290);
    expect(cut.endMs).toBe(560);
    expect(cut.review).toBe(false);
  });

  test('small kept islands and free-range boundaries survive unchanged', () => {
    const cuts = computeCutOps([], new Set(), [{ id: 'a', startMs: 10, endMs: 20 }, { id: 'b', startMs: 24, endMs: 30 }], new Map(), null);
    expect(cuts).toHaveLength(2);
    expect(cuts[0].endMs).toBe(20);
    expect(cuts[1].startMs).toBe(24);
  });
});
