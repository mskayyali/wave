import type { AgentWord } from './agent';
import type { TimeOp } from './cutBoundaries';
import type { EditPlan } from './editPlan';

export interface AgentTransition {
  number: number;
  kind: 'cut' | 'added-pause';
  sourceLeftMs: number;
  sourceRightMs: number;
  outputStartMs: number;
  outputEndMs: number;
  fadeMs: number;
  beforeWord: number | null;
  afterWord: number | null;
  manualBoundary: boolean;
  reviewReasons: string[];
}

export interface AgentEditSnapshot {
  /** Revision of the actual editor state this snapshot was planned against. */
  revision: string;
  ready: boolean;
  sourceDurationMs: number;
  durationMs: number;
  cuts: { startMs: number; endMs: number; manualBoundary: boolean; partialWords: number[] }[];
  transitions: AgentTransition[];
}

/** Expose the actual resolved joins, not guesses from word timestamps. */
export function inspectTransitions(plan: EditPlan, ops: TimeOp[], words: AgentWord[], adjustments: ReadonlyMap<string, number>, revision: string, ready: boolean): AgentEditSnapshot {
  const cuts = ops.map((op) => ({
    startMs: Math.max(0, op.startMs), endMs: Math.min(plan.sourceDurationMs, op.endMs),
    manualBoundary: !!op.manualBoundary || !!((op.startKey && adjustments.has(op.startKey)) || (op.endKey && adjustments.has(op.endKey))),
    partialWords: words.filter((w) => ((op.startMs > w.startMs && op.startMs < w.endMs)
      || (op.endMs > w.startMs && op.endMs < w.endMs))).map((w) => w.n),
  })).filter((c) => c.endMs > c.startMs);
  const transitions: AgentTransition[] = [];
  // Binary search the closest transcript word on each retained side. A pause
  // holds source time, so only the adjacent audio piece can supply its word.
  const firstStartingAt = (ms: number) => {
    let lo = 0, hi = words.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (words[mid].startMs < ms) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const firstEndingAfter = (ms: number) => {
    let lo = 0, hi = words.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (words[mid].endMs <= ms) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const cutAt = new Map(cuts.map((c) => [`${c.startMs}:${c.endMs}`, c]));
  const tight = new Set(ops.filter((op) => op.review).map((op) => `${Math.max(0, op.startMs)}:${Math.min(plan.sourceDurationMs, op.endMs)}`));
  for (let i = 1; i < plan.pieces.length; i++) {
    const prev = plan.pieces[i - 1], next = plan.pieces[i];
    const key = `${prev.sourceEndMs}:${next.sourceStartMs}`;
    const cut = !prev.pause && !next.pause ? cutAt.get(key) : undefined;
    const before = !prev.pause ? words[firstStartingAt(prev.sourceEndMs) - 1] : undefined;
    const after = !next.pause ? words[firstEndingAfter(next.sourceStartMs)] : undefined;
    const pause = prev.pause ? prev : next.pause ? next : null;
    const reviewReasons: string[] = [];
    if (cut && tight.has(key)) reviewReasons.push('Very little space between kept speech; listen to the join.');
    if (cut?.partialWords.length) reviewReasons.push(`Word spans partly trimmed: ${cut.partialWords.join(', ')}.`);
    if (pause && !pause.tone) reviewReasons.push('Added pause uses digital silence; no suitable room tone was available.');
    transitions.push({
      number: transitions.length, kind: pause ? 'added-pause' : 'cut',
      sourceLeftMs: prev.sourceEndMs, sourceRightMs: next.sourceStartMs,
      outputStartMs: next.outputStartMs, outputEndMs: prev.outputStartMs + prev.durationMs,
      fadeMs: next.fadeInMs,
      beforeWord: before && before.endMs > prev.sourceStartMs ? before.n : null,
      afterWord: after && after.startMs < next.sourceEndMs ? after.n : null,
      manualBoundary: cut?.manualBoundary ?? false, reviewReasons,
    });
  }
  return { revision, ready, sourceDurationMs: plan.sourceDurationMs, durationMs: plan.durationMs, cuts, transitions };
}
