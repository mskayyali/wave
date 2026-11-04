import { expect, mock, test } from 'bun:test';
import { buildEditPlan, editedTime, renderPlan } from '../src/lib/editPlan';

const stretchNodes: FakeStretch[] = [];
class FakeStretch {
  buffers: Float32Array[][] = [];
  schedules: Record<string, unknown>[] = [];
  schedule(change: Record<string, unknown>) { this.schedules.push(change); }
  async dropBuffers() {}
  async addBuffers(out: Float32Array[]) { this.buffers.push(out); }
  async setUpdateInterval(_seconds: number, _callback: (time: number) => void) {}
  connect() {}
  disconnect() {}
}
mock.module('signalsmith-stretch', () => ({ default: async () => { const s = new FakeStretch(); stretchNodes.push(s); return s; } }));
const { EditPlayer } = await import('../src/lib/editPlayer');

class FakeBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  data: Float32Array[];
  constructor(channels: number, length: number, rate: number) {
    this.sampleRate = rate; this.numberOfChannels = channels; this.length = length; this.duration = length / rate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(c: number) { return this.data[c]; }
  copyToChannel(data: Float32Array, c: number) { this.data[c].set(data); }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  at = 0;
  connect() {}
  disconnect() {}
  start(at: number) { this.at = at; }
  stop() {}
}
class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} }; }
  createBuffer(ch: number, length: number, sr: number) { return new FakeBuffer(ch, length, sr); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  async resume() {}
}
function playerFor(durationMs: number) {
  const ctx = new FakeContext();
  const buffer = new FakeBuffer(2, durationMs, 1000);
  buffer.data.forEach((data, c) => { for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.1 + c); });
  const player = new EditPlayer(ctx as unknown as AudioContext, buffer as unknown as AudioBuffer);
  return { ctx, buffer, player };
}

test('normal playback and cut preview use the resolved renderer', async () => {
  const { ctx, buffer, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [{ startMs: 200, endMs: 400 }]);
  player.setPlan(plan);
  await player.play();
  expect(ctx.sources[0].buffer!.data).toEqual(renderPlan(plan, buffer.data, 1000));
  player.pause();
  const extraCuts = [{ startMs: 600, endMs: 700, fadeMs: 2 }];
  const preview = buildEditPlan(1000, [...plan.cuts, ...extraCuts]);
  await player.playRange(0.1, 0.9, { extraCuts });
  const from = Math.round(editedTime(preview, 100, 'start'));
  const to = Math.round(editedTime(preview, 900, 'end'));
  expect(ctx.sources.at(-1)!.buffer!.data).toEqual(renderPlan(preview, buffer.data, 1000, from, to));
  player.destroy();
});

test('an inserted leading pause plays and resumes at its actual output position', async () => {
  const { ctx, buffer, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [], [{ atMs: 0, ms: 300 }]);
  player.setPlan(plan);
  await player.play();
  expect(ctx.sources[0].buffer!.data[0].slice(0, 290).every((v) => v === 0)).toBe(true);
  ctx.currentTime = ctx.sources[0].at + 0.15;
  expect(player.currentTime).toBe(0);
  player.pause();
  await player.play();
  expect(ctx.sources.at(-1)!.buffer!.data).toEqual(renderPlan(plan, buffer.data, 1000, 150));
  player.destroy();
});

test('seeking into an overlap uses existing fade samples', async () => {
  const { ctx, buffer, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [{ startMs: 200, endMs: 400 }]);
  player.setPlan(plan);
  player.currentTime = 0.401;
  await player.play();
  expect(ctx.sources[0].buffer!.data).toEqual(renderPlan(plan, buffer.data, 1000, 196));
  player.destroy();
});

test('long playback schedules contiguous chunks with bounded retained buffers', async () => {
  const { ctx, player } = playerFor(45000);
  player.setPlan(buildEditPlan(45000, []));
  await player.play();
  expect(ctx.sources.length).toBe(2);
  expect(ctx.sources[1].at - ctx.sources[0].at).toBe(15);
  const stale = ctx.sources[0].onended!;
  ctx.sources[0].onended!();
  expect(ctx.sources.length).toBe(3);
  expect(ctx.sources[2].at - ctx.sources[1].at).toBeCloseTo(15, 12);
  ctx.sources[1].onended!();
  expect(ctx.sources.length).toBe(3);
  ctx.sources[2].onended!();
  expect(player.paused).toBe(true);
  const count = ctx.sources.length;
  stale();
  expect(ctx.sources.length).toBe(count);
  player.destroy();
});

test('stretched playback receives identical join samples before time stretching', async () => {
  const { buffer, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [{ startMs: 200, endMs: 400 }]);
  player.setPlan(plan);
  player.playbackRate = 1.5;
  await player.play();
  expect(stretchNodes.at(-1)!.buffers[0]).toEqual(renderPlan(plan, buffer.data, 1000));
  player.destroy();
});


test('a trailing pause resumes without restarting the recording', async () => {
  const { ctx, buffer, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [], [{ atMs: 1000, ms: 300 }]);
  player.setPlan(plan);
  await player.play();
  ctx.currentTime = ctx.sources[0].at + 1.1;
  expect(player.currentTime).toBe(1);
  player.pause();
  await player.play();
  expect(ctx.sources.at(-1)!.buffer!.data).toEqual(renderPlan(plan, buffer.data, 1000, 1100));
  player.destroy();
});

test('selection loops use the native audio clock and retain inserted pauses', async () => {
  const { ctx, player } = playerFor(1000);
  const plan = buildEditPlan(1000, [{ startMs: 400, endMs: 500 }], [{ atMs: 600, ms: 100 }]);
  player.setPlan(plan); player.setLoop({ startMs: 200, endMs: 800 });
  await player.play();
  const source = ctx.sources[0] as FakeSource & {loop: boolean; loopEnd: number};
  expect(source.loop).toBe(true);
  const cycle = (editedTime(plan, 800, 'end') - editedTime(plan, 200, 'start')) / 1000;
  expect(source.loopEnd).toBeCloseTo(cycle);
  ctx.currentTime = source.at + cycle * 1000 + 0.01;
  expect(player.currentTime).toBeCloseTo(0.21, 6);
  expect(player.paused).toBe(false);
  player.pause(); await player.play();
  expect(ctx.sources.at(-1)!.buffer!.length).toBe(source.buffer!.length);
  player.destroy();
});
test('range previews bypass selection looping and all-cut loops stop cleanly', async () => {
  const { ctx, player } = playerFor(1000);
  player.setPlan(buildEditPlan(1000, [{ startMs: 200, endMs: 500 }]));
  player.setLoop({ startMs: 100, endMs: 800 });
  await player.playRange(0, 0.1);
  expect((ctx.sources[0] as FakeSource & {loop?:boolean}).loop).not.toBe(true);
  player.pause(); player.setLoop({ startMs: 250, endMs: 450 });
  await player.play(); expect(player.paused).toBe(true);
  player.destroy();
});
test('pitch-preserving selection loops stay inside the audio worklet', async () => {
  const { ctx, player } = playerFor(1000);
  player.setPlan(buildEditPlan(1000, [])); player.setLoop({ startMs: 200, endMs: 400 });
  player.playbackRate = 1.5;
  await player.play();
  const stretch = stretchNodes.at(-1)!;
  expect(stretch.buffers[0][0].length).toBe(200);
  expect(stretch.schedules.at(-1)).toMatchObject({ rate: 1.5, loopStart: 0, loopEnd: 0.2 });
  ctx.currentTime = 0.12 + 0.2 / 1.5 * 100 + 0.01;
  expect(player.currentTime).toBeCloseTo(0.215, 5);
  expect(player.paused).toBe(false); player.destroy();
});
