// A gapless player for the *edited* timeline: plays the original audio while
// skipping cut ranges sample-accurately, joining the kept pieces with the same
// 8 ms equal-power crossfade the exporter uses (write_spliced in
// src-tauri/src/projects.rs) — so what you hear while editing is what exports.
//
// It mimics the slice of HTMLMediaElement that wavesurfer.js drives through its
// `media` option, so the waveform cursor and events work unchanged.
// `currentTime` is in ORIGINAL-timeline seconds and jumps over cuts.
//
// Added pauses (setInserts) are room tone: a quiet stretch of the same
// recording, looped for as long as the pause, crossfaded in and out like any
// join. While one plays, `currentTime` holds at the point it was added.
//
// At 1× every kept segment is an AudioBufferSourceNode scheduled on the audio
// clock up front: no main-thread timing is involved, so cuts stay exact even
// when the window is in the background (requestAnimationFrame is throttled
// there). At other speeds playback goes through Signalsmith Stretch, which
// preserves pitch. It is fed the already-edited signal (kept pieces joined
// with the same crossfades), streamed in chunks, so it never has to jump.

import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';

export interface CutRange {
  startMs: number;
  endMs:   number;
}

/** A pause added at `atMs` (original time), filled with room tone. */
export interface InsertedPause {
  atMs: number;
  ms:   number;
  /** The room tone to loop (original time); silence without one. */
  tone?: { startMs: number; endMs: number };
}

/** Matches the export crossfade (write_spliced in projects.rs). */
const CROSSFADE_S  = 0.008;
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
const CURVE_POINTS = 64;
const FADE_IN  = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.sin((i / (CURVE_POINTS - 1)) * (Math.PI / 2)));
const FADE_OUT = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.cos((i / (CURVE_POINTS - 1)) * (Math.PI / 2)));

type Listener = (...args: unknown[]) => void;

/** A cut, in seconds. */
interface Span {
  start: number;
  end:   number;
}

/** Options for a one-off playRange. */
export interface PlayRangeOptions {
  /** Play the original audio, cuts and all — to hear what an edit removed. */
  ignoreCuts?: boolean;
  /** Extra cuts for this playback only — to preview an edit before making it. */
  extraCuts?:  CutRange[];
}

/**
 * An uncut stretch of original audio, in seconds; or, with `fill`, an added
 * pause at `srcStart` (= `srcEnd`) lasting `fill.dur`, looping `tone`.
 */
interface Kept {
  srcStart: number;
  srcEnd:   number;
  fill?:    { dur: number; tone: Span | null };
}

/** A pause in seconds. */
interface Insert {
  at:   number;
  dur:  number;
  tone: Span | null;
}

const lengthOf = (k: Kept) => (k.fill ? k.fill.dur : k.srcEnd - k.srcStart);

/** A kept stretch placed on the edited timeline (seconds from its start). */
interface Placed extends Kept {
  at:   number;
  xIn:  number;
  xOut: number;
}

/** A kept stretch of original audio, placed on the AudioContext clock. */
interface Segment {
  srcStart: number;
  srcEnd:   number;
  outStart: number;
}

/**
 * Lay kept stretches end to end, each join overlapped by a crossfade bounded
 * by both neighbours' lengths (as exported). Returns the edited length too.
 */
function layOut(kept: Kept[]): { placed: Placed[]; length: number } {
  const placed: Placed[] = [];
  let at = 0;
  for (let k = 0; k < kept.length; k++) {
    const dur  = lengthOf(kept[k]);
    const prev = kept[k - 1];
    const next = kept[k + 1];
    const xIn  = prev ? Math.min(CROSSFADE_S, dur / 2, lengthOf(prev) / 2) : 0;
    const xOut = next ? Math.min(CROSSFADE_S, dur / 2, lengthOf(next) / 2) : 0;
    at -= xIn;
    placed.push({ ...kept[k], at, xIn, xOut });
    at += dur;
  }
  return { placed, length: at };
}

interface Session {
  gain:     GainNode;
  sources:  AudioScheduledSourceNode[];
  segments: Segment[];
  rate:     number;
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
  private cuts: Span[] = [];
  private inserts: Insert[] = [];
  private position    = 0;
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
  private range: { end: number; cuts: Span[] } | null = null;

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
    if (playing && this.session) this.position = this.currentTime;
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
  /** Replace the cut list. A playing session is rescheduled from where it is. */
  setCuts(cuts: CutRange[]): void {
    this.cuts = this.normalizeCuts(cuts);
    if (!this.paused) this.restart();
  }

  /** Replace the added pauses. A playing session is rescheduled from where it is. */
  setInserts(inserts: InsertedPause[]): void {
    this.inserts = inserts
      .filter((i) => i.ms > 0)
      .map((i) => ({
        at:   Math.max(0, Math.min(this.duration, i.atMs / 1000)),
        dur:  i.ms / 1000,
        tone: i.tone && i.tone.endMs - i.tone.startMs > 20 ? { start: i.tone.startMs / 1000, end: i.tone.endMs / 1000 } : null,
      }))
      .sort((a, b) => a.at - b.at);
    if (!this.paused) this.restart();
  }

  /** Cut ranges in seconds, clamped to the audio, sorted, overlaps merged. */
  private normalizeCuts(cuts: CutRange[]): Span[] {
    const sorted = cuts
      .map((c) => ({ start: Math.max(0, c.startMs / 1000), end: Math.min(this.duration, c.endMs / 1000) }))
      .filter((c) => c.end > c.start)
      .sort((a, b) => a.start - b.start);
    const merged: Span[] = [];
    for (const c of sorted) {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
      else merged.push({ ...c });
    }
    return merged;
  }

  // ── Transport ────────────────────────────────────────────────────────────
  get currentTime(): number {
    const s = this.session;
    if (!s || s.segments.length === 0) return this.position;
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
    if (this.position >= this.duration - 0.01) this.position = 0;
    this.range = null;
    this.paused = false;
    this.emit('play');
    await this.startSession();
  }

  /** Play [start, end] once, then pause at `end` (see PlayRangeOptions). */
  async playRange(start: number, end: number, options: PlayRangeOptions = {}): Promise<void> {
    if (this.destroyed || end <= start) return;
    this.stopSession();
    const cuts = options.ignoreCuts
      ? []
      : options.extraCuts?.length
        ? this.normalizeCuts([...this.cuts.map((c) => ({ startMs: c.start * 1000, endMs: c.end * 1000 })), ...options.extraCuts])
        : this.cuts;
    this.range    = { end: Math.min(end, this.duration), cuts };
    this.position = this.skipCut(Math.max(0, start), cuts);
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

  private restart(): void {
    this.position = this.currentTime;
    this.stopSession();
    void this.startSession();
  }

  private skipCut(t: number, cuts: Span[] = this.cuts): number {
    for (const c of cuts) if (t >= c.start && t < c.end) return c.end;
    return t;
  }

  /**
   * The kept (uncut) stretches of original audio from `from` to the end, with
   * the added pauses between them. A pause added inside a cut sits at the cut's
   * join; one at `from` plays first.
   */
  private keptFrom(from: number, cuts: Span[] = this.cuts): Kept[] {
    const stretches: Kept[] = [];
    let cursor = this.skipCut(from, cuts);
    for (const c of cuts) {
      if (c.end <= cursor) continue;
      if (c.start > cursor) stretches.push({ srcStart: cursor, srcEnd: c.start });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < this.duration) stretches.push({ srcStart: cursor, srcEnd: this.duration });
    const kept = stretches.filter((k) => k.srcEnd - k.srcStart > 0.0005);

    const start = this.skipCut(from, cuts);
    const pauses = this.inserts
      .map((i) => ({ ...i, at: this.skipCut(i.at, cuts) }))
      .filter((i) => i.at >= start - 1e-6);
    if (pauses.length === 0) return kept;
    const out: Kept[] = [];
    let p = 0;
    const fill = (i: Insert): Kept => ({ srcStart: i.at, srcEnd: i.at, fill: { dur: i.dur, tone: i.tone } });
    for (const k of kept) {
      let piece = { ...k };
      while (p < pauses.length && pauses[p].at < piece.srcEnd - 1e-6) {
        const i = pauses[p++];
        if (i.at > piece.srcStart + 1e-6) {
          out.push({ srcStart: piece.srcStart, srcEnd: i.at });
          piece = { srcStart: i.at, srcEnd: piece.srcEnd };
        }
        out.push(fill(i));
      }
      out.push(piece);
    }
    while (p < pauses.length) out.push(fill(pauses[p++]));
    return out.filter((k) => k.fill || k.srcEnd - k.srcStart > 0.0005);
  }

  /** What to play from `from`: everything kept, or just the current playRange. */
  private toPlay(from: number): Kept[] {
    const range = this.range;
    if (!range) return this.keptFrom(from);
    return this.keptFrom(from, range.cuts)
      .filter((k) => k.srcStart < range.end || (k.fill && k.srcStart <= range.end))
      .map((k) => (k.fill ? k : { srcStart: k.srcStart, srcEnd: Math.min(k.srcEnd, range.end) }))
      .filter((k) => k.fill || k.srcEnd - k.srcStart > 0.0005);
  }

  private async startSession(): Promise<void> {
    // No audio yet: setBuffer starts the session when it arrives.
    if (!this.buffer) return;
    const generation = ++this.generation;
    const kept = this.toPlay(this.position);
    if (kept.length === 0) {
      this.finish();
      return;
    }
    const rate = this.rate;
    const stretch = rate === 1 ? null : await this.loadStretch().catch(() => null);
    if (generation !== this.generation || this.paused) return;

    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const t0 = this.ctx.currentTime + (stretch ? STRETCH_LOOKAHEAD_S : LOOKAHEAD_S);
    // Silent until t0: a shared stretcher may still be winding down the last session.
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + EDGE_FADE_S);

    const session: Session = { gain, sources: [], segments: [], rate: stretch ? rate : 1, stretch, endTimer: null };
    this.session = session;
    const endAt = stretch
      ? this.playStretched(session, stretch, kept, t0)
      : this.playExact(session, kept, t0);

    // The last source's `ended` fires from the audio thread's timeline, so it
    // isn't delayed by background timer throttling the way setTimeout is.
    const last = session.sources[session.sources.length - 1];
    if (last) {
      last.onended = () => { if (this.session === session) this.finish(); };
    } else {
      session.endTimer = setTimeout(() => { if (this.session === session) this.finish(); },
        Math.max(0, (endAt - this.ctx.currentTime) * 1000) + 20);
    }
  }

  /** 1×: one source per kept segment, crossfaded exactly like the exporter. */
  private playExact(session: Session, kept: Kept[], t0: number): number {
    const { placed, length } = layOut(kept);
    for (const piece of placed) {
      const { srcStart, srcEnd, at, xIn, xOut } = piece;
      const dur   = lengthOf(piece);
      const start = t0 + at;
      const source = this.ctx.createBufferSource();
      source.buffer = this.buffer;
      const fade = this.ctx.createGain();
      source.connect(fade);
      fade.connect(session.gain);
      if (xIn > 0)  fade.gain.setValueCurveAtTime(FADE_IN, start, xIn);
      if (xOut > 0) fade.gain.setValueCurveAtTime(FADE_OUT, start + dur - xOut, xOut);
      if (piece.fill) {
        // Room tone, looped for the pause; silence when there's none.
        const tone = piece.fill.tone;
        if (tone) {
          source.loop = true;
          source.loopStart = tone.start;
          source.loopEnd = tone.end;
          source.start(start, tone.start);
          source.stop(start + dur);
        } else {
          fade.gain.value = 0;
          source.start(start, 0, dur);
        }
      } else {
        source.start(start, srcStart, dur);
      }

      session.segments.push({ srcStart, srcEnd, outStart: start });
      session.sources.push(source);
    }
    return t0 + length;
  }

  /**
   * Other speeds: the stretcher plays the edited signal straight through.
   *
   * Its schedule() keeps only one pending change — each call drops every change
   * still in the future — so it can't be told up front to jump over each cut.
   * Instead the kept pieces are rendered joined (same crossfades as above) and
   * streamed to it in chunks just ahead of its read position, which also keeps
   * a long recording from being copied into the audio thread all at once.
   */
  private playStretched(session: Session, node: StretchNode, kept: Kept[], t0: number): number {
    const { placed, length } = layOut(kept);
    const rate = session.rate;
    session.segments = placed.map((p) => ({ srcStart: p.srcStart, srcEnd: p.srcEnd, outStart: t0 + p.at / rate }));

    let queued = Math.min(length, STRETCH_CHUNK_S);
    void node.dropBuffers();
    this.feed(node, placed, 0, queued);
    node.schedule({ output: t0, active: true, input: 0, rate });
    void node.setUpdateInterval(STRETCH_POLL_S, (inputTime) => {
      if (this.session !== session || queued >= length || inputTime < queued - STRETCH_LOW_WATER_S) return;
      const next = Math.min(length, queued + STRETCH_CHUNK_S);
      this.feed(node, placed, queued, next);
      queued = next;
      void node.dropBuffers(Math.max(0, inputTime - 1));
    });
    node.connect(session.gain);
    return t0 + length / rate;
  }

  /** Render seconds [from, to) of the edited signal and append it to the stretcher's input. */
  private feed(node: StretchNode, placed: Placed[], from: number, to: number): void {
    const buffer = this.buffer;
    if (!buffer) return;
    const sr = buffer.sampleRate;
    const a  = Math.round(from * sr);
    const b  = Math.round(to * sr);
    const out = Array.from({ length: buffer.numberOfChannels }, () => new Float32Array(Math.max(0, b - a)));
    for (const p of placed) {
      const start = Math.round(p.at * sr);
      const len   = Math.round(lengthOf(p) * sr);
      const lo = Math.max(a, start);
      const hi = Math.min(b, start + len);
      if (lo >= hi) continue;
      const tone = p.fill?.tone;
      if (p.fill && !tone) continue; // silence
      const src  = Math.round(p.srcStart * sr) - start;
      // Room tone: frame i of the pause reads tone frame (i mod its length).
      const toneStart = tone ? Math.round(tone.start * sr) : 0;
      const toneLen   = tone ? Math.max(1, Math.round((tone.end - tone.start) * sr)) : 1;
      const fIn  = Math.round(p.xIn * sr);
      const fOut = Math.round(p.xOut * sr);
      out.forEach((channel, c) => {
        const data = buffer.getChannelData(c);
        for (let f = lo; f < hi; f++) {
          const i = f - start;
          let g = 1;
          if (i < fIn) g = Math.sin(((i + 0.5) / fIn) * (Math.PI / 2));
          else if (i >= len - fOut) g = Math.cos(((i - (len - fOut) + 0.5) / fOut) * (Math.PI / 2));
          channel[f - a] += (tone ? data[toneStart + (i % toneLen)] : data[src + f]) * g;
        }
      });
    }
    // Transfer, don't copy: the chunk is ours alone.
    void node.addBuffers(out, out.map((channel) => channel.buffer));
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
