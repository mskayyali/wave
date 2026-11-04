// A gapless player for the *edited* timeline: plays the original audio while
// skipping cut ranges sample-accurately, joining the kept pieces with the same
// resolved joins sent to the exporter — so editing and export share timing.
//
// It mimics the slice of HTMLMediaElement that wavesurfer.js drives through its
// `media` option, so the waveform cursor and events work unchanged.
// `currentTime` is in ORIGINAL-timeline seconds and jumps over cuts.
//
// Added pauses are room tone: a quiet stretch of the same
// recording, looped for as long as the pause, crossfaded in and out like any
// join. While one plays, `currentTime` holds at the point it was added.
//
// At 1× rendered chunks are scheduled ahead on the audio clock. Each join
// is rendered before it plays, independent of UI animation timing. At other
// speeds playback goes through Signalsmith Stretch, which
// preserves pitch. It is fed the already-edited signal (kept pieces joined
// with the same crossfades), streamed in chunks, so it never has to jump.

import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

import { buildEditPlan, editedTime, renderPlan, type CutRange, type EditPlan } from './editPlan';
export type { CutRange, InsertedPause } from './editPlan';

/** Softens starting or stopping playback in the middle of a waveform. */
const EDGE_FADE_S  = 0.005;
/** Scheduling headroom so the first segment starts cleanly. */
const LOOKAHEAD_S  = 0.03;
/** Extra headroom for the stretcher to compensate for its own latency. */
const STRETCH_LOOKAHEAD_S = 0.12;
/** Edited audio is handed to the stretcher this many seconds at a time… */
const STRETCH_CHUNK_S     = 15;
/** …topping up once less than this much is queued past the read position. */
const STRETCH_LOW_WATER_S = 8;
/** How often the stretcher reports its read position. */
const STRETCH_POLL_S      = 0.25;
type Listener = (...args: unknown[]) => void;

export interface PlayRangeOptions {
  ignoreCuts?: boolean;
  extraCuts?: CutRange[];
}

interface Segment {
  srcStart: number;
  srcEnd: number;
  outStart: number;
}

interface Session {
  gain:     GainNode;
  sources:  AudioScheduledSourceNode[];
  segments: Segment[];
  rate:     number;
  outputFromMs: number;
  outputToMs: number;
  startTime: number;
  loop: { fromMs: number; toMs: number } | null;
  plan: EditPlan;
  /** Set for sessions played through the stretcher. */
  stretch:  StretchNode | null;
  endTimer: ReturnType<typeof setTimeout> | null;
}

export class EditPlayer {
  // ── HTMLMediaElement surface used by wavesurfer.js ───────────────────────
  paused         = true;
  seeking        = false;
  currentSrc     = '';
  crossOrigin: string | null = null;
  autoplay       = false;
  preservesPitch = true;
  error: Error | null = null;
  /** HAVE_ENOUGH_DATA, as far as wavesurfer is concerned: it only needs the duration. */
  readonly readyState = 4;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly master: GainNode;
  private plan: EditPlan = buildEditPlan(0, []);
  private position    = 0;
  private outputPosition: number | null = 0;
  private rate        = 1;
  private volumeValue = 1;
  private mutedValue  = false;
  private session: Session | null = null;
  /** Bumped whenever a session starts or stops, to drop stale async starts. */
  private generation  = 0;
  private stretch: Promise<StretchNode> | null = null;
  /** Channels the stretcher was made for (fixed when it's made). */
  private stretchChannels = 0;
  private destroyed   = false;
  /** Set while playing a one-off range (playRange): where to stop, and the cuts it honours. */
  private loop: { startMs: number; endMs: number } | null = null;
  private range: { end: number; plan: EditPlan } | null = null;

  /**
   * `buffer` may come later (`setBuffer`): the waveform is drawn from
   * precomputed data while the audio is still decoding, so the player starts
   * with just the duration. Playing before then starts as soon as it arrives.
   */
  constructor(private readonly ctx: AudioContext, private buffer: AudioBuffer | null, private readonly knownDuration = buffer?.duration ?? 0) {
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  /** The audio is decoded and can play. */
  get hasAudio(): boolean { return this.buffer !== null; }

  /**
   * Give the player its audio, or swap in another version of the same audio
   * (the enhanced one). The timeline is the same, so cuts and position carry
   * over, and playback (a playRange included, or a play pressed while the
   * audio was still decoding) continues from where it is.
   */
  setBuffer(buffer: AudioBuffer | null): void {
    if (buffer === this.buffer || this.destroyed) return;
    const playing = !this.paused;
    if (playing && this.session) { this.position = this.currentTime; this.outputPosition = this.outputTime(); }
    this.stopSession();
    if (this.stretch && buffer && buffer.numberOfChannels !== this.stretchChannels) {
      // The stretcher's channel count is fixed when it's made.
      const old = this.stretch;
      this.stretch = null;
      old.then((node) => node.disconnect()).catch(() => undefined);
    }
    this.buffer = buffer;
    if (playing && buffer) void this.startSession();
  }

  // ── Events ───────────────────────────────────────────────────────────────
  addEventListener(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  removeEventListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  // ── Media-element no-ops (the buffer is supplied up front) ───────────────
  get src(): string { return this.currentSrc; }
  set src(value: string) { this.currentSrc = value; }
  load(): void {}
  removeAttribute(_name: string): void {}
  canPlayType(): CanPlayTypeResult { return 'probably'; }
  remove(): void { this.destroy(); }

  get duration(): number { return this.buffer?.duration ?? this.knownDuration; }

  // ── Cuts ─────────────────────────────────────────────────────────────────
  /** The exact plan also sent to export and used to time subtitles. */
  setPlan(plan: EditPlan): void {
    if (plan === this.plan) return;
    this.position = this.currentTime;
    this.stopSession();
    this.plan = plan;
    this.outputPosition = this.position === 0 ? 0 : null;
    if (this.range) this.range.plan = plan;
    if (!this.paused) void this.startSession();
  }

  /** Selection loops are scheduled by the audio engine, independent of UI frames. */
  setLoop(range: { startMs: number; endMs: number } | null): void {
    const next = range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs)
      ? { startMs: Math.max(0, range.startMs), endMs: Math.min(this.duration * 1000, range.endMs) } : null;
    const valid = next && next.endMs - next.startMs >= 1 ? next : null;
    if (valid?.startMs === this.loop?.startMs && valid?.endMs === this.loop?.endMs) return;
    this.loop = valid;
    if (!this.paused && !this.range) this.restart();
  }

  // ── Transport ────────────────────────────────────────────────────────────
  get currentTime(): number {
    const s = this.session;
    if (!s || s.segments.length === 0) return this.position;
    if (s.loop) {
      const output = this.outputTime();
      // A pause holds at its insertion point. Binary search the resolved plan.
      let lo = 0, hi = s.plan.pieces.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.plan.pieces[mid].outputStartMs <= output) lo = mid + 1; else hi = mid;
      }
      const piece = s.plan.pieces[Math.max(0, lo - 1)];
      return piece ? (piece.sourceStartMs + (piece.pause ? 0 : Math.min(piece.durationMs, Math.max(0, output - piece.outputStartMs)))) / 1000 : this.position;
    }
    const now = this.ctx.currentTime;
    let seg = s.segments[0];
    for (const candidate of s.segments) {
      if (candidate.outStart <= now) seg = candidate;
      else break;
    }
    if (now < seg.outStart) return seg.srcStart;
    return Math.min(seg.srcEnd, seg.srcStart + (now - seg.outStart) * s.rate);
  }

  set currentTime(value: number) {
    // Stop first: restart() would resume from the old session's position.
    this.stopSession();
    this.range = null;
    this.outputPosition = value <= 0 ? 0 : null;
    this.position = this.skipCut(Math.max(0, Math.min(value, this.duration)));
    if (!this.paused) void this.startSession();
    this.emit('seeking');
    this.emit('seeked');
    this.emit('timeupdate');
  }

  get playbackRate(): number { return this.rate; }
  set playbackRate(value: number) {
    if (value === this.rate) return;
    this.rate = value;
    if (!this.paused) this.restart();
    this.emit('ratechange');
  }

  get volume(): number { return this.volumeValue; }
  set volume(value: number) {
    this.volumeValue = value;
    this.applyGain();
    this.emit('volumechange');
  }

  get muted(): boolean { return this.mutedValue; }
  set muted(value: boolean) {
    this.mutedValue = value;
    this.applyGain();
    this.emit('volumechange');
  }

  async play(): Promise<void> {
    if (!this.paused || this.destroyed) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
    if (this.outputPosition === null && this.position >= this.duration - 0.001) { this.position = 0; this.outputPosition = 0; }
    this.range = null;
    this.paused = false;
    this.emit('play');
    await this.startSession();
  }

  /** Play [start, end] once, then pause at `end` (see PlayRangeOptions). */
  async playRange(start: number, end: number, options: PlayRangeOptions = {}): Promise<void> {
    if (this.destroyed || end <= start) return;
    this.stopSession();
    const plan = options.ignoreCuts
      ? buildEditPlan(this.plan.sourceDurationMs, [])
      : options.extraCuts?.length
        ? buildEditPlan(this.plan.sourceDurationMs, [...this.plan.cuts, ...options.extraCuts], this.plan.inserts)
        : this.plan;
    this.range = { end: Math.min(end, this.duration), plan };
    this.outputPosition = start <= 0 ? 0 : null;
    this.position = this.skipCut(Math.max(0, start), plan);
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
    if (this.paused) {
      this.paused = false;
      this.emit('play');
    }
    this.emit('timeupdate');
    await this.startSession();
  }

  pause(): void {
    if (this.paused) return;
    this.position = this.currentTime;
    this.outputPosition = this.range ? null : this.outputTime();
    this.stopSession();
    this.range = null;
    this.paused = true;
    this.emit('pause');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSession();
    this.master.disconnect();
    this.stretch?.then((node) => node.disconnect()).catch(() => undefined);
    this.listeners.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private applyGain(): void {
    this.master.gain.value = this.mutedValue ? 0 : this.volumeValue;
  }

  private outputTime(): number {
    const s = this.session;
    if (s?.loop) {
      const elapsed = Math.max(0, this.ctx.currentTime - s.startTime) * s.rate * 1000;
      return s.loop.fromMs + ((s.outputFromMs - s.loop.fromMs + elapsed) % (s.loop.toMs - s.loop.fromMs));
    }
    return s ? Math.min(s.outputToMs, s.outputFromMs + Math.max(0, this.ctx.currentTime - s.startTime) * s.rate * 1000)
      : this.outputPosition ?? editedTime(this.range?.plan ?? this.plan, this.position * 1000, 'start');
  }

  private restart(): void {
    this.outputPosition = this.outputTime();
    this.position = this.currentTime;
    this.stopSession();
    void this.startSession();
  }

  private skipCut(t: number, plan = this.range?.plan ?? this.plan): number {
    for (const c of plan.cuts) if (t * 1000 >= c.startMs && t * 1000 < c.endMs) return c.endMs / 1000;
    return t;
  }

  private async startSession(): Promise<void> {
    if (!this.buffer) return;
    const generation = ++this.generation;
    const plan = this.range?.plan ?? this.plan;
    const sr = this.buffer.sampleRate;
    const loopRange = this.range ? null : this.loop;
    if (loopRange && !plan.pieces.some(p => p.pause
      ? p.sourceStartMs >= loopRange.startMs && p.sourceStartMs <= loopRange.endMs
      : p.sourceEndMs > loopRange.startMs && p.sourceStartMs < loopRange.endMs)) { this.finish(); return; }
    const loopFrom = loopRange ? Math.round(editedTime(plan, loopRange.startMs, 'start') * sr / 1000) : 0;
    const loopTo = loopRange ? Math.round(editedTime(plan, loopRange.endMs, 'end') * sr / 1000) : 0;
    const requested = Math.round((this.outputPosition ?? editedTime(plan, this.position * 1000, 'start')) * sr / 1000);
    const from = loopRange && (requested < loopFrom || requested >= loopTo) ? loopFrom : requested;
    const to = loopRange ? loopTo : Math.round((this.range ? editedTime(plan, this.range.end * 1000, 'end') : plan.durationMs) * sr / 1000);
    if (to <= from) { this.finish(); return; }
    const rate = this.rate;
    const stretch = rate === 1 ? null : await this.loadStretch().catch(() => null);
    if (generation !== this.generation || this.paused) return;

    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, c) => this.buffer!.getChannelData(c));
    const chunk = Math.round(STRETCH_CHUNK_S * sr);
    const firstEnd = Math.min(to, from + chunk);
    const firstChunk = renderPlan(plan, channels, sr, loopRange ? loopFrom : from, loopRange ? loopTo : firstEnd);
    let loopBuffer: AudioBuffer | null = null;
    if (loopRange) {
      const fade = Math.min(Math.round(EDGE_FADE_S * sr), Math.floor((loopTo - loopFrom) / 2));
      for (const data of firstChunk) for (let i = 0; i < fade; i++) {
        const g = (i + 0.5) / fade;
        data[i] *= g; data[data.length - 1 - i] *= g;
      }
      if (stretch) {
        await stretch.dropBuffers();
        if (generation !== this.generation || this.paused) return;
        await stretch.addBuffers(firstChunk, firstChunk.map(c => c.buffer));
        if (generation !== this.generation || this.paused) return;
      } else {
        loopBuffer = this.ctx.createBuffer(channels.length, loopTo - loopFrom, sr);
        firstChunk.forEach((data, c) => loopBuffer!.copyToChannel(data, c));
      }
    }
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const t0 = this.ctx.currentTime + (stretch ? STRETCH_LOOKAHEAD_S : LOOKAHEAD_S);
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + EDGE_FADE_S);
    const session: Session = { gain, sources: [], segments: [], rate: stretch ? rate : 1, stretch, endTimer: null, outputFromMs: from * 1000 / sr, outputToMs: to * 1000 / sr, startTime: t0, plan, loop: loopRange ? { fromMs: loopFrom * 1000 / sr, toMs: loopTo * 1000 / sr } : null };
    this.session = session;
    session.segments = plan.pieces.filter((p) => (p.outputStartMs + p.durationMs) * sr / 1000 > from && p.outputStartMs * sr / 1000 < to)
      .map((p) => {
        const offset = Math.max(0, from / sr - p.outputStartMs / 1000);
        return { srcStart: (p.sourceStartMs / 1000) + (p.pause ? 0 : offset), srcEnd: p.sourceEndMs / 1000,
          outStart: t0 + Math.max(0, p.outputStartMs / 1000 - from / sr) / session.rate };
      });
    if (loopRange) {
      const length = (loopTo - loopFrom) / sr;
      const offset = (from - loopFrom) / sr;
      if (stretch) {
        stretch.schedule({ output: t0, active: true, input: offset, rate, loopStart: 0, loopEnd: length });
        stretch.connect(gain);
      } else {
        const source = this.ctx.createBufferSource();
        source.buffer = loopBuffer; source.loop = true; source.loopStart = 0; source.loopEnd = length;
        source.connect(gain); session.sources.push(source); source.start(t0, offset);
      }
      return;
    }
    let queued = from;
    if (stretch) {
      const feed = (end: number) => {
        const out = queued === from ? firstChunk : renderPlan(plan, channels, sr, queued, end);
        void stretch.addBuffers(out, out.map((c) => c.buffer));
        queued = end;
      };
      void stretch.dropBuffers();
      feed(Math.min(to, from + chunk));
      stretch.schedule({ output: t0, active: true, input: 0, rate, loopStart: 0, loopEnd: 0 });
      void stretch.setUpdateInterval(STRETCH_POLL_S, (inputTime) => {
        if (this.session !== session || queued >= to || inputTime < (queued - from) / sr - STRETCH_LOW_WATER_S) return;
        feed(Math.min(to, queued + chunk));
        void stretch.dropBuffers(Math.max(0, inputTime - 1));
      });
      stretch.connect(gain);
      session.endTimer = setTimeout(() => { if (this.session === session) this.finish(); },
        Math.max(0, (t0 + (to - from) / sr / rate - this.ctx.currentTime) * 1000) + 20);
    } else {
      // Keep two chunks scheduled on the audio clock. The native `ended`
      // event replenishes them even when animation/background timers throttle.
      // Both 1× and stretched playback use the same PCM renderer as export.
      const enqueue = () => {
        if (this.session !== session || queued >= to) return;
        const start = queued, end = Math.min(to, start + chunk);
        const out = start === from ? firstChunk : renderPlan(plan, channels, sr, start, end);
        const buffer = this.ctx.createBuffer(channels.length, end - start, sr);
        out.forEach((data, c) => buffer.copyToChannel(data, c));
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        session.sources.push(source);
        source.onended = () => {
          session.sources = session.sources.filter((s) => s !== source);
          source.disconnect();
          if (this.session !== session) return;
          if (end === to) this.finish(); else enqueue();
        };
        source.start(t0 + (start - from) / sr);
        queued = end;
      };
      enqueue();
      enqueue();
    }
  }

  private stopSession(): void {
    this.generation++;
    const s = this.session;
    if (!s) return;
    this.session = null;
    const now = this.ctx.currentTime;
    s.gain.gain.cancelScheduledValues(now);
    s.gain.gain.setValueAtTime(s.gain.gain.value, now);
    s.gain.gain.linearRampToValueAtTime(0, now + EDGE_FADE_S);
    for (const source of s.sources) {
      source.onended = null;
      try { source.stop(now + EDGE_FADE_S + 0.002); } catch { /* not started yet */ }
    }
    if (s.stretch) {
      const node = s.stretch;
      node.schedule({ output: now + EDGE_FADE_S, active: false });
      setTimeout(() => { try { node.disconnect(s.gain); } catch { /* already gone */ } }, 60);
    }
    if (s.endTimer) clearTimeout(s.endTimer);
    setTimeout(() => s.gain.disconnect(), 60);
  }

  private finish(): void {
    this.stopSession();
    const range = this.range;
    this.range = null;
    this.position = range ? range.end : this.duration;
    this.outputPosition = null;
    if (!this.paused) {
      this.paused = true;
      this.emit('pause');
    }
    this.emit('timeupdate');
    if (!range) this.emit('ended');
  }

  /** Lazily create the stretcher (only needed when speed ≠ 1×). */
  private loadStretch(): Promise<StretchNode> {
    if (!this.stretch) {
      this.stretchChannels = this.buffer?.numberOfChannels ?? 2;
      this.stretch = SignalsmithStretch(this.ctx, {
        // Left unconnected, but required: the processor reads its input list
        // whenever it's idle and throws (killing the node) if there is none.
        numberOfInputs:     1,
        numberOfOutputs:    1,
        outputChannelCount: [this.stretchChannels],
      });
      this.stretch.catch(() => { this.stretch = null; });
    }
    return this.stretch;
  }
}
