import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

// Wave's idea as one loop, for the empty Projects page. A spoken sentence in
// Fraunces over its waveform, edited the way Wave edits:
//   1. a long pause is shortened (1.8 s → 0.4 s);
//   2. the filler "um" is drag-selected, ⌫, struck through and cut;
//   3. a misheard word is corrected (↩): "tax." becomes "text.", underlined
//      green, while the audio under it stays as it is;
// then the playhead plays the clean sentence, each word lighting up as it's
// spoken, and three chips say where it runs and what it costs.
// SMIL on one clock (T holds the beats); the words close up from both sides
// so the sentence stays centred. Reduced motion shows the last frame.

const DUR = '12s';
const T = {
  shown:      0.03,
  pauseMark:  0.07,
  pause:      [0.10, 0.15],
  fillerDrag: [0.21, 0.24],
  fillerKey:  0.25,
  strike:     [0.26, 0.29],
  cut:        [0.30, 0.35],
  fixSelect:  0.38,
  fixKey:     0.41,
  fix:        [0.43, 0.47],
  underline:  [0.46, 0.50],
  play:       [0.53, 0.80],
  chips:      [0.81, 0.84, 0.87],
  hide:       0.95,
  hidden:     0.985,
};

const FONT_SIZE = 46;
const WORD_FONT = `500 ${FONT_SIZE}px 'Fraunces Variable'`;
const CHIP_FONT = `500 15px 'IBM Plex Sans'`;
const SPACE = 15;
const PAUSE_GAP = 104;   // the long pause, as space between "So," and "editing"…
const PAUSE_KEEP = 34;   // …and once shortened
const PAD = 40;
const BASELINE = 96;
const WAVE_Y = 196;
const AMPLITUDE = 40;
const PAUSE_Y = 134;     // the pause's length, between the words and the waveform
const CHIPS_Y = 292;
const HEIGHT = 318;
const BAR = 3.2;
const BAR_GAP = 2.6;

const GREY = '#8d8d8d';
const DIM = '#5f5f5f';
const BAR_GREY = '#353535';
const AMBER = '#e8a020';
const BLUE_FILL = 'rgba(100, 149, 237, 0.22)';
const BLUE_LINE = 'rgba(100, 149, 237, 0.6)';
const CORAL = '#ff8389';
const GREEN = '#42be65';

// The sentence: groups that move as one when a gap closes.
const A = ['So,'];
const B = ['editing', 'audio', 'is'];
const FILLER = 'um';
const C = ['just', 'editing'];
const MISHEARD = 'tax.';
const FIXED = 'text.';
const CHIPS = ['Runs on your Mac', 'Private', 'Free'];

/** Small deterministic random numbers, so the waveform is the same every time. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function useMeasure(): ((font: string, text: string) => number) | null {
  const [measure, setMeasure] = useState<((font: string, text: string) => number) | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ready = () => {
      if (cancelled) return;
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      setMeasure(() => (font: string, text: string) => { ctx.font = font; return ctx.measureText(text).width; });
    };
    Promise.all([document.fonts.load(WORD_FONT), document.fonts.load(CHIP_FONT)]).then(ready, ready);
    return () => { cancelled = true; };
  }, []);
  return measure;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** An animation on the shared clock (eased between keyframes). */
function Anim({ attr, values, times, linear }: { attr: string; values: (string | number)[]; times: number[]; linear?: boolean }) {
  return (
    <animate
      attributeName={attr} values={values.join(';')} keyTimes={times.join(';')}
      dur={DUR} repeatCount="indefinite"
      {...(linear ? {} : { calcMode: 'spline', keySplines: times.slice(1).map(() => '0.4 0 0.2 1').join(';') })}
    />
  );
}

/** A horizontal move on the shared clock. */
function Slide({ xs, times }: { xs: number[]; times: number[] }) {
  return (
    <animateTransform
      attributeName="transform" type="translate" values={xs.map((x) => `${x} 0`).join(';')} keyTimes={times.join(';')}
      calcMode="spline" keySplines={times.slice(1).map(() => '0.4 0 0.2 1').join(';')}
      dur={DUR} repeatCount="indefinite"
    />
  );
}

interface Word { text: string; x: number; w: number; bars: { x: number; h: number }[] }

/** A keyboard key popping up over a word: what was pressed. */
function Keycap({ x, glyph, at }: { x: number; glyph: string; at: number }) {
  const y = BASELINE - 72;
  return (
    <g transform={`translate(${x} ${y})`} opacity="0">
      <Anim attr="opacity" values={[0, 0, 1, 1, 0, 0]} times={[0, at, at + 0.015, at + 0.05, at + 0.07, 1]} />
      <g>
        {/* Up past its place and back (SMIL splines can't overshoot). */}
        <animateTransform attributeName="transform" type="translate" values="0 6;0 6;0 -2;0 0;0 0"
          keyTimes={`0;${at};${at + 0.012};${at + 0.022};1`} calcMode="spline"
          keySplines="0 0 1 1;0.2 0.8 0.3 1;0.4 0 0.6 1;0 0 1 1"
          dur={DUR} repeatCount="indefinite" />
        <rect x={-17} y={-15} width={34} height={32} rx={7} fill="#1c1c1c" />
        <rect x={-17} y={-17} width={34} height={30} rx={7} fill="#2a2a2a" stroke="#4a4a4a" />
        <text x={0} y={4} textAnchor="middle" className="wave-hero__key">{glyph}</text>
      </g>
    </g>
  );
}

/** The chips' little icons, 14 units square, drawn in `color`. */
const ICONS: Record<string, (color: string) => ReactNode> = {
  'Runs on your Mac': (c) => (
    <g fill="none" stroke={c} strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="2.5" width="10" height="7" rx="1.2" />
      <path d="M0.5 12h13" />
    </g>
  ),
  Private: (c) => (
    <g fill="none" stroke={c} strokeWidth="1.4" strokeLinecap="round">
      <rect x="2.5" y="6" width="9" height="7" rx="1.5" />
      <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" />
    </g>
  ),
  Free: (c) => <path d="M7 0.5l1.6 4.9 4.9 1.6-4.9 1.6L7 13.5 5.4 8.6 0.5 7l4.9-1.6z" fill={c} />,
};

export function BrandHero() {
  // Ids for the defs, unique per copy: the welcome and About can both be open,
  // and an animated clip found by a shared id would run on the other's clock.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ref = (name: string) => `wave-hero-${name}-${uid}`;
  const measure = useMeasure();
  const still = useReducedMotion();

  const layout = useMemo(() => {
    if (!measure) return null;
    const rand = random(11);
    const width = (t: string) => measure(WORD_FONT, t);
    const word = (text: string, x: number, loud = 0.7 + rand() * 0.3): Word => {
      const w = width(text);
      const n = Math.max(2, Math.floor((w + BAR_GAP) / (BAR + BAR_GAP)));
      const start = x + (w - (n * BAR + (n - 1) * BAR_GAP)) / 2;
      const bars = Array.from({ length: n }, (_, k) => {
        const shape = Math.pow(Math.sin((Math.PI * (k + 0.5)) / n), 0.6);
        return { x: start + k * (BAR + BAR_GAP), h: Math.max(3, loud * shape * (0.5 + rand() * 0.5) * AMPLITUDE * 2) };
      });
      return { text, x, w, bars };
    };
    // Laid out as spoken, before any edit.
    let x = PAD;
    const run = (texts: string[]) => texts.map((t) => { const wd = word(t, x); x += wd.w + SPACE; return wd; });
    const a = run(A);
    x += PAUSE_GAP - SPACE;
    const pauseCentre = x - PAUSE_GAP / 2;
    const b = run(B);
    const filler = word(FILLER, x, 0.32);
    x += filler.w + SPACE;
    const c = run(C);
    const misheard = word(MISHEARD, x);
    const total = x + misheard.w + PAD;

    // How much each edit closes (or, for the correction, opens) the sentence.
    const dP = PAUSE_GAP - PAUSE_KEEP;
    const dF = filler.w + SPACE;
    const dC = width(FIXED) - misheard.w;
    // Each group's offset after each beat: before, after the pause, after the
    // cut, after the correction. Halves either side keep it centred.
    const move = {
      a:     [0,  dP / 2,  dP / 2 + dF / 2,  dP / 2 + dF / 2 - dC / 2],
      b:     [0, -dP / 2, -dP / 2 + dF / 2, -dP / 2 + dF / 2 - dC / 2],
      c:     [0, -dP / 2, -dP / 2 - dF / 2, -dP / 2 - dF / 2 - dC / 2],
      pause: [0, 0,        dF / 2,           dF / 2 - dC / 2],
    };
    const start = PAD + move.a[3];
    const end = misheard.x + move.c[3] + width(FIXED);

    // The chips, centred under the sentence.
    const chips = CHIPS.map((t) => ({ text: t, w: 14 + 14 + 8 + measure(CHIP_FONT, t) + 16 }));
    const chipsWidth = chips.reduce((s, ch) => s + ch.w, 0) + 12 * (chips.length - 1);
    let cx = total / 2 - chipsWidth / 2;
    const placedChips = chips.map((ch) => { const p = { ...ch, x: cx }; cx += ch.w + 12; return p; });

    return { a, b, c, filler, misheard, fixedWidth: width(FIXED), pauseCentre, total, move, start, end, chips: placedChips };
  }, [measure]);

  if (!layout) return <div className="wave-hero" style={{ aspectRatio: `900 / ${HEIGHT}` }} aria-hidden />;
  const { a, b, c, filler, misheard, fixedWidth, pauseCentre, total, move, start, end, chips } = layout;

  // Beat times for the group moves: before, pause, cut, correction.
  const moveTimes = [0, T.pause[0], T.pause[1], T.cut[0], T.cut[1], T.fix[0], T.fix[1], 1];
  const moveXs = (m: number[]) => [m[0], m[0], m[1], m[1], m[2], m[2], m[3], m[3]];
  const group = (m: number[], children: ReactNode) => (still
    ? <g transform={`translate(${m[3]} 0)`}>{children}</g>
    : <g><Slide xs={moveXs(m)} times={moveTimes} />{children}</g>);

  const text = (w: Word, fill: string, extra?: ReactNode) => (
    <text key={`t${w.x}`} x={w.x} y={BASELINE} fill={fill} className="wave-hero__word">{w.text}{extra}</text>
  );
  const bars = (w: Word, fill: string) => w.bars.map((bar, k) => (
    <rect key={`b${w.x}-${k}`} x={bar.x} y={WAVE_Y - bar.h / 2} width={BAR} height={bar.h} rx={BAR / 2} fill={fill} />
  ));
  // Where each word ends up, for the played copy (it's only seen after the edits).
  const final = (w: Word, m: number[]): Word => ({ ...w, x: w.x + m[3], bars: w.bars.map((bar) => ({ ...bar, x: bar.x + m[3] })) });
  const fixed: Word = { ...misheard, text: FIXED, w: fixedWidth };

  const strikeLength = filler.w + 10;
  const underlineLength = fixedWidth;
  const pauseLine = [PAUSE_GAP - 18, PAUSE_KEEP - 10];

  return (
    <svg className="wave-hero" viewBox={`0 0 ${total} ${HEIGHT}`} role="img"
      aria-label="So, editing audio is just editing text. Runs on your Mac. Private. Free.">
      <defs>
        <linearGradient id={ref('bars')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f5c04a" />
          <stop offset="0.55" stopColor={AMBER} />
          <stop offset="1" stopColor={AMBER} stopOpacity="0.4" />
        </linearGradient>
        <radialGradient id={ref('glow')}>
          <stop offset="0" stopColor={AMBER} stopOpacity="0.15" />
          <stop offset="1" stopColor={AMBER} stopOpacity="0" />
        </radialGradient>
        {/* A soft halo on what's been played. */}
        <filter id={ref('halo')} x="-10%" y="-40%" width="120%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feComponentTransfer in="blur" result="soft"><feFuncA type="linear" slope="0.45" /></feComponentTransfer>
          <feMerge><feMergeNode in="soft" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath id={ref('played')}>
          <rect x="0" y="0" height={CHIPS_Y - 30} width={still ? total : 0}>
            {!still && <Anim attr="width" values={[0, start, end, end, 0]} times={[0, T.play[0], T.play[1], 0.99, 1]} linear />}
          </rect>
        </clipPath>
      </defs>

      <ellipse cx={total / 2} cy={WAVE_Y} rx={total * 0.46} ry={80} fill={`url(#${ref('glow')})`}>
        {!still && <animate attributeName="opacity" values="0.5;1;0.5" dur="5s" repeatCount="indefinite" />}
      </ellipse>

      <g>
        {!still && <Anim attr="opacity" values={[0, 1, 1, 0, 0]} times={[0, T.shown, T.hide, T.hidden, 1]} linear />}

        {/* ── As spoken: grey words over grey audio ── */}
        {group(move.a, <>{a.map((w) => text(w, GREY))}{a.map((w) => bars(w, BAR_GREY))}</>)}

        {/* 1 · the long pause: a silence with its length over it, shortened */}
        {!still && group(move.pause, (
          <g transform={`translate(${pauseCentre} 0)`}>
            <rect y={WAVE_Y - 1} height={2} rx={1} fill="#4a4a4a" x={-pauseLine[0] / 2} width={pauseLine[0]}>
              <Anim attr="width" values={[pauseLine[0], pauseLine[0], pauseLine[1], pauseLine[1]]} times={[0, T.pause[0], T.pause[1], 1]} />
              <Anim attr="x" values={[-pauseLine[0] / 2, -pauseLine[0] / 2, -pauseLine[1] / 2, -pauseLine[1] / 2]} times={[0, T.pause[0], T.pause[1], 1]} />
            </rect>
            <g>
              <Anim attr="opacity" values={[1, 1, 0, 0]} times={[0, T.pause[1] + 0.02, T.pause[1] + 0.05, 1]} />
              <rect x={-27} y={PAUSE_Y - 12} width={54} height={24} rx={12} fill="#1c1c1c" stroke="#4a4a4a">
                <Anim attr="stroke" values={['#4a4a4a', '#4a4a4a', AMBER, AMBER]} times={[0, T.pauseMark, T.pauseMark + 0.01, 1]} linear />
              </rect>
              <text x={0} y={PAUSE_Y + 4} textAnchor="middle" className="wave-hero__pause" fill="#c6c6c6">
                1.8 s
                <Anim attr="opacity" values={[1, 1, 0, 0]} times={[0, T.pause[0], T.pause[0] + 0.01, 1]} linear />
              </text>
              <text x={0} y={PAUSE_Y + 4} textAnchor="middle" className="wave-hero__pause" fill={AMBER} opacity="0">
                0.4 s
                <Anim attr="opacity" values={[0, 0, 1, 1]} times={[0, T.pause[0], T.pause[0] + 0.01, 1]} linear />
              </text>
            </g>
          </g>
        ))}

        {group(move.b, <>{b.map((w) => text(w, GREY))}{b.map((w) => bars(w, BAR_GREY))}</>)}

        {/* 2 · the filler: drag-selected, ⌫, struck, cut */}
        {!still && group(move.c.slice(0, 2).concat([move.c[1], move.c[1]]), (
          <g>
            <Anim attr="opacity" values={[1, 1, 0, 0]} times={[0, T.cut[0], T.cut[0] + 0.03, 1]} />
            <rect x={filler.x - 7} y={BASELINE - 40} height={54} rx={5} fill={BLUE_FILL} stroke={BLUE_LINE} width={0}>
              <Anim attr="width" values={[0, 0, filler.w + 14, filler.w + 14]} times={[0, T.fillerDrag[0], T.fillerDrag[1], 1]} />
            </rect>
            {text(filler, GREY)}
            <line x1={filler.x} x2={filler.x + filler.w} y1={BASELINE + 10} y2={BASELINE + 10}
              stroke="#f1c21b" strokeOpacity="0.75" strokeWidth="2" strokeDasharray="2 4.5" strokeLinecap="round" />
            {bars(filler, BAR_GREY)}
            <line x1={filler.x - 5} x2={filler.x + filler.w + 5} y1={BASELINE - 15} y2={BASELINE - 15}
              stroke={CORAL} strokeWidth="3" strokeLinecap="round" strokeDasharray={strikeLength} strokeDashoffset={strikeLength}>
              <Anim attr="stroke-dashoffset" values={[strikeLength, strikeLength, 0, 0]} times={[0, T.strike[0], T.strike[1], 1]} />
              {/* Hidden until it draws: an empty dash still shows its round cap. */}
              <Anim attr="opacity" values={[0, 0, 1, 1]} times={[0, T.strike[0], T.strike[0] + 0.002, 1]} linear />
            </line>
            <Keycap x={filler.x + filler.w / 2} glyph="⌫" at={T.fillerKey} />
          </g>
        ))}

        {group(move.c, (
          <>
            {c.map((w) => text(w, GREY))}
            {c.map((w) => bars(w, BAR_GREY))}
            {/* 3 · the misheard word: unsure (dim), selected, ↩, corrected */}
            {bars(misheard, BAR_GREY)}
            {!still && (
              <>
                <rect x={misheard.x - 7} y={BASELINE - 40} width={Math.max(misheard.w, fixedWidth) + 14} height={54} rx={5}
                  fill={BLUE_FILL} stroke={BLUE_LINE} opacity="0">
                  <Anim attr="opacity" values={[0, 0, 1, 1, 0, 0]} times={[0, T.fixSelect, T.fixSelect + 0.015, T.fix[1], T.fix[1] + 0.03, 1]} />
                </rect>
                <text x={misheard.x} y={BASELINE} fill={DIM} className="wave-hero__word">
                  {MISHEARD}
                  <Anim attr="opacity" values={[1, 1, 0, 0]} times={[0, T.fix[0], T.fix[0] + 0.02, 1]} />
                </text>
              </>
            )}
            <text x={misheard.x} y={BASELINE} fill={GREY} className="wave-hero__word" opacity={still ? 1 : 0}>
              {FIXED}
              {!still && <Anim attr="opacity" values={[0, 0, 1, 1]} times={[0, T.fix[0], T.fix[0] + 0.03, 1]} />}
            </text>
            <line x1={misheard.x} x2={misheard.x + fixedWidth} y1={BASELINE + 10} y2={BASELINE + 10}
              stroke={GREEN} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={underlineLength} strokeDashoffset={still ? 0 : underlineLength}>
              {!still && <Anim attr="stroke-dashoffset" values={[underlineLength, underlineLength, 0, 0]} times={[0, T.underline[0], T.underline[1], 1]} />}
              {!still && <Anim attr="opacity" values={[0, 0, 1, 1]} times={[0, T.underline[0], T.underline[0] + 0.002, 1]} linear />}
            </line>
            {!still && <Keycap x={misheard.x + fixedWidth / 2} glyph="↩" at={T.fixKey} />}
          </>
        ))}

        {/* ── As played: the edited sentence in amber, revealed behind the playhead ── */}
        <g clipPath={`url(#${ref('played')})`}>
          <g filter={`url(#${ref('halo')})`}>
            {[...a.map((w) => final(w, move.a)), ...b.map((w) => final(w, move.b)), ...c.map((w) => final(w, move.c)), final(fixed, move.c)]
              .map((w) => text(w, AMBER))}
          </g>
          {[...a.map((w) => final(w, move.a)), ...b.map((w) => final(w, move.b)), ...c.map((w) => final(w, move.c)), final(misheard, move.c)]
            .map((w) => bars(w, `url(#${ref('bars')})`))}
        </g>

        {!still && (
          <g>
            <animateTransform attributeName="transform" type="translate"
              values={`${start} 0;${start} 0;${end} 0;${end} 0`} keyTimes={`0;${T.play[0]};${T.play[1]};1`}
              dur={DUR} repeatCount="indefinite" />
            <Anim attr="opacity" values={[0, 0, 1, 1, 0, 0]} times={[0, T.play[0] - 0.02, T.play[0], T.play[1], T.play[1] + 0.03, 1]} linear />
            <line x1="0" x2="0" y1={BASELINE - 52} y2={WAVE_Y + AMPLITUDE + 12} stroke={AMBER} strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="0" cy={BASELINE - 52} r="5" fill={AMBER} filter={`url(#${ref('halo')})`} />
          </g>
        )}

        {/* ── Where it runs, what it costs ── */}
        {chips.map((chip, i) => {
          const free = chip.text === 'Free';
          const color = free ? AMBER : '#c6c6c6';
          const at = T.chips[i];
          return (
            <g key={chip.text} transform={`translate(${chip.x} ${CHIPS_Y - 17})`} opacity={still ? 1 : 0}>
              {!still && <Anim attr="opacity" values={[0, 0, 1, 1]} times={[0, at, at + 0.02, 1]} />}
              <g>
                {!still && (
                  <animateTransform attributeName="transform" type="translate" values="0 8;0 8;0 0;0 0"
                    keyTimes={`0;${at};${at + 0.025};1`} calcMode="spline" keySplines="0 0 1 1;0.2 0.8 0.2 1;0 0 1 1"
                    dur={DUR} repeatCount="indefinite" />
                )}
                <rect width={chip.w} height={34} rx={17}
                  fill={free ? 'rgba(232, 160, 32, 0.12)' : 'rgba(255, 255, 255, 0.04)'}
                  stroke={free ? 'rgba(232, 160, 32, 0.6)' : '#3d3d3d'} />
                <g transform="translate(14 10)">{ICONS[chip.text](color)}</g>
                <text x={14 + 14 + 8} y={22} fill={color} className="wave-hero__chip">{chip.text}</text>
              </g>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
