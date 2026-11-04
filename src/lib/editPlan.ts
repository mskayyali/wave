// The sole timeline planner. Playback, native export, subtitle timestamps and
// duration displays consume this resolved plan; renderers never move an edge.
export interface CutRange {
  startMs: number;
  endMs: number;
  /** Maximum overlap at this join. Manual/free cuts use the short default. */
  fadeMs?: number;
  /** No clear gap between kept speech: offer contextual review. */
  review?: boolean;
}

export interface InsertedPause {
  atMs: number;
  ms: number;
  tone?: { startMs: number; endMs: number };
}

export interface EditPiece {
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
  durationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** A pause holds source time at sourceStartMs. No tone means digital silence. */
  pause: boolean;
  tone: { startMs: number; endMs: number } | null;
}

export interface EditPlan {
  version: 1;
  sourceDurationMs: number;
  durationMs: number;
  cuts: CutRange[];
  inserts: InsertedPause[];
  pieces: EditPiece[];
}

export const DEFAULT_FADE_MS = 5;
export const MAX_FADE_MS = 12;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const finite = (n: number) => Number.isFinite(n);

export function normalizeCuts(cuts: CutRange[], durationMs: number): CutRange[] {
  const sorted = cuts.filter((c) => finite(c.startMs) && finite(c.endMs))
    .map((c) => ({ startMs: clamp(c.startMs, 0, durationMs), endMs: clamp(c.endMs, 0, durationMs),
      fadeMs: clamp(finite(c.fadeMs ?? NaN) ? c.fadeMs! : DEFAULT_FADE_MS, 0, MAX_FADE_MS) }))
    .filter((c) => c.endMs > c.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: CutRange[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, c.endMs);
      prev.fadeMs = Math.min(prev.fadeMs!, c.fadeMs!);
    } else out.push({ ...c });
  }
  return out;
}

export function buildEditPlan(sourceDurationMs: number, inputCuts: CutRange[], inputInserts: InsertedPause[] = []): EditPlan {
  const duration = finite(sourceDurationMs) ? Math.max(0, sourceDurationMs) : 0;
  const cuts = normalizeCuts(inputCuts, duration);
  const skip = (ms: number) => {
    let lo = 0, hi = cuts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cuts[mid].endMs <= ms) lo = mid + 1; else hi = mid; }
    return cuts[lo] && cuts[lo].startMs <= ms ? cuts[lo].endMs : ms;
  };
  const joins = new Map(cuts.map((c) => [`${c.startMs}:${c.endMs}`, c.fadeMs]));
  const inserts = inputInserts.filter((p) => finite(p.atMs) && finite(p.ms) && p.ms > 0).map((p) => {
    const a = clamp(p.tone?.startMs ?? 0, 0, duration);
    const b = clamp(p.tone?.endMs ?? 0, 0, duration);
    return { atMs: skip(clamp(p.atMs, 0, duration)), ms: p.ms,
      ...(finite(a) && finite(b) && b - a > 20 ? { tone: { startMs: a, endMs: b } } : {}) };
  }).sort((a, b) => a.atMs - b.atMs);

  const pieces: EditPiece[] = [];
  const add = (a: number, b: number, pause?: InsertedPause) => {
    const ms = pause?.ms ?? b - a;
    if (ms <= 0) return;
    pieces.push({ sourceStartMs: a, sourceEndMs: pause ? a : b, durationMs: ms,
      outputStartMs: 0, fadeInMs: 0, fadeOutMs: 0, pause: !!pause, tone: pause?.tone ?? null });
  };
  let p = 0;
  const stretch = (a: number, b: number) => {
    let cursor = a;
    while (p < inserts.length && inserts[p].atMs < b) {
      const insert = inserts[p++];
      add(cursor, insert.atMs);
      add(insert.atMs, insert.atMs, insert);
      cursor = insert.atMs;
    }
    add(cursor, b);
  };
  let cursor = 0;
  for (const c of cuts) { stretch(cursor, c.startMs); cursor = c.endMs; }
  stretch(cursor, duration);
  while (p < inserts.length) { const insert = inserts[p++]; add(insert.atMs, insert.atMs, insert); }

  // Symmetric limits ensure that the two fades of a short piece cannot overlap.
  // Constant-gain blends cannot create a peak larger than either input sample.
  let output = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i], prev = pieces[i - 1];
    if (prev) {
      const join = !piece.pause && !prev.pause ? joins.get(`${prev.sourceEndMs}:${piece.sourceStartMs}`) : undefined;
      const fade = Math.min(join ?? DEFAULT_FADE_MS, prev.durationMs / 2, piece.durationMs / 2);
      prev.fadeOutMs = piece.fadeInMs = fade;
      output -= fade;
    }
    piece.outputStartMs = output;
    output += piece.durationMs;
  }
  return { version: 1, sourceDurationMs: duration, durationMs: output, cuts, inserts, pieces };
}

// Plans are immutable after construction. Index audio pieces once so mapping
// a long transcript with thousands of cuts costs O(words × log(pieces)).
const audioIndex = new WeakMap<EditPlan, EditPiece[]>();
function audioPieces(plan: EditPlan): EditPiece[] {
  let audio = audioIndex.get(plan);
  if (!audio) { audio = plan.pieces.filter((p) => !p.pause); audioIndex.set(plan, audio); }
  return audio;
}
function pieceAt(audio: EditPiece[], ms: number, edge: 'start' | 'end'): number {
  let lo = 0, hi = audio.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (edge === 'start' ? audio[mid].sourceEndMs <= ms : audio[mid].sourceEndMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Source time at an insertion is before it for an end, after it for a start. */
export function editedTime(plan: EditPlan, ms: number, edge: 'start' | 'end'): number {
  const audio = audioPieces(plan);
  const i = pieceAt(audio, ms, edge), p = audio[i];
  if (p && ms >= p.sourceStartMs) return clamp(p.outputStartMs + ms - p.sourceStartMs, 0, plan.durationMs);
  if (edge === 'start') return p?.outputStartMs ?? plan.durationMs;
  const prev = audio[i - 1];
  return prev ? prev.outputStartMs + prev.durationMs : 0;
}

/** Omit words fully removed by waveform cuts, and trim partially removed words. */
export function mapEditedWords<T extends { startMs: number; endMs: number }>(plan: EditPlan, words: T[]): T[] {
  const audio = audioPieces(plan);
  return words.flatMap((w) => {
    const first = audio[pieceAt(audio, w.startMs, 'start')];
    if (!first || first.sourceStartMs >= w.endMs) return [];
    const startMs = editedTime(plan, w.startMs, 'start');
    const endMs = editedTime(plan, w.endMs, 'end');
    return endMs > startMs ? [{ ...w, startMs, endMs }] : [];
  });
}

/** Sample a room-tone loop with a short linear blend at *every* wrap. The
 * shortened period and midpoint gains match native export (edit_plan.rs). */
export function toneSample(data: Float32Array, start: number, end: number, i: number, sr: number): number {
  const length = end - start;
  if (length <= 0) return 0;
  const fade = Math.min(Math.round(DEFAULT_FADE_MS * sr / 1000), Math.floor(length / 4));
  const period = length - fade;
  const at = i % period;
  if (fade > 0 && at < fade) {
    const t = (at + 0.5) / fade;
    return (data[end - fade + at] ?? 0) * (1 - t) + (data[start + at] ?? 0) * t;
  }
  return data[start + at] ?? 0;
}

/** Render an absolute output-frame window. Absolute positions avoid cumulative
 * rounding drift, and seeking/chunking never recomputes a join or its fades. */
export function renderPlan(plan: EditPlan, channels: Float32Array[], sr: number, from = 0, to = Math.round(plan.durationMs * sr / 1000)): Float32Array[] {
  const out = channels.map(() => new Float32Array(Math.max(0, to - from)));
  const frame = (ms: number) => Math.round(ms * sr / 1000);
  for (const p of plan.pieces) {
    const start = frame(p.outputStartMs), end = frame(p.outputStartMs + p.durationMs);
    const lo = Math.max(from, start), hi = Math.min(to, end);
    if (lo >= hi || (p.pause && !p.tone)) continue;
    const source = frame(p.sourceStartMs);
    const sourceEnd = frame(p.sourceEndMs);
    const toneStart = frame(p.tone?.startMs ?? 0), toneEnd = frame(p.tone?.endMs ?? 0);
    channels.forEach((data, c) => {
      for (let f = lo; f < hi; f++) {
        const i = f - start;
        const t = (f + 0.5) * 1000 / sr;
        let gain = 1;
        if (p.fadeInMs > 0) gain = Math.min(gain, clamp((t - p.outputStartMs) / p.fadeInMs, 0, 1));
        if (p.fadeOutMs > 0) gain = Math.min(gain, clamp((p.outputStartMs + p.durationMs - t) / p.fadeOutMs, 0, 1));
        const sample = p.pause ? toneSample(data, toneStart, toneEnd, i, sr) : (data[Math.min(source + i, sourceEnd - 1)] ?? 0);
        out[c][f - from] += sample * gain;
      }
    });
  }
  return out;
}
