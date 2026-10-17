import { useEffect, useRef, useState } from 'react';
import { Button, ContentSwitcher, InlineLoading, Switch } from '@carbon/react';
import { PlayFilledAlt, StopFilledAlt } from '@carbon/icons-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { EnhancePreview as Preview } from '../../hooks/useEnhancement';

// Hear the enhancement before running it on everything: 15 s from the
// selection or the playhead, original and enhanced playing together (one
// muted), so the switch flips between them in place. The original comes at
// the enhanced version's loudness, so the difference heard is the cleaning.

type Version = 'original' | 'enhanced';

export function EnhancePreview({ from, render, onStart, disabled }: {
  /** Where to start (ms). */
  from:     () => number;
  render:   (startMs: number) => Promise<Preview>;
  /** Pause the editor's playback. */
  onStart:  () => void;
  disabled: boolean;
}) {
  const [state,   setState]   = useState<'idle' | 'rendering' | 'playing'>('idle');
  const [version, setVersion] = useState<Version>('enhanced');
  const [error,   setError]   = useState<string | null>(null);
  const ctxRef   = useRef<AudioContext | null>(null);
  const playing  = useRef<{ sources: AudioBufferSourceNode[]; gains: Record<Version, GainNode> } | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  /** Bumped by each start and stop, so a slow render can't start late. */
  const run = useRef(0);

  function stop() {
    run.current++;
    playing.current?.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch { /* not started */ } });
    playing.current = null;
    setState('idle');
  }

  useEffect(() => () => { stop(); void ctxRef.current?.close(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    stop();
    onStart();
    setError(null);
    setState('rendering');
    const mine = ++run.current;
    try {
      const preview = await render(from());
      const ctx = ctxRef.current ?? (ctxRef.current = new AudioContext());
      const decode = async (path: string) => ctx.decodeAudioData(await (await fetch(convertFileSrc(path))).arrayBuffer());
      const [original, enhanced] = await Promise.all([decode(preview.original), decode(preview.enhanced)]);
      if (mine !== run.current) return;
      await ctx.resume();
      const at = ctx.currentTime + 0.05;
      const make = (buffer: AudioBuffer, v: Version) => {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        gain.gain.value = versionRef.current === v ? 1 : 0;
        source.connect(gain).connect(ctx.destination);
        source.start(at);
        return { source, gain };
      };
      const o = make(original, 'original');
      const e = make(enhanced, 'enhanced');
      e.source.onended = () => { if (playing.current?.sources.includes(e.source)) stop(); };
      playing.current = { sources: [o.source, e.source], gains: { original: o.gain, enhanced: e.gain } };
      setState('playing');
    } catch (err) {
      if (mine !== run.current) return;
      setError(String(err));
      setState('idle');
    }
  }

  function choose(v: Version) {
    setVersion(v);
    const p = playing.current;
    const ctx = ctxRef.current;
    if (!p || !ctx) return;
    for (const key of ['original', 'enhanced'] as const) {
      const g = p.gains[key].gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(key === v ? 1 : 0, ctx.currentTime + 0.03);
    }
  }

  return (
    <div className="wave-enhance-preview">
      {state === 'playing' ? (
        <>
          <ContentSwitcher size="sm" selectedIndex={version === 'original' ? 0 : 1} onChange={({ index }) => choose(index === 0 ? 'original' : 'enhanced')}>
            <Switch name="original" text="Original" />
            <Switch name="enhanced" text="Enhanced" />
          </ContentSwitcher>
          <Button size="sm" kind="ghost" renderIcon={StopFilledAlt} onClick={stop}>Stop preview</Button>
        </>
      ) : state === 'rendering' ? (
        <InlineLoading description="Preparing 15 s…" />
      ) : (
        <Button size="sm" kind="tertiary" renderIcon={PlayFilledAlt} disabled={disabled} onClick={() => void start()}>Preview 15 s</Button>
      )}
      {error && <p className="cds--form__helper-text wave-enhance-preview__error">{error}</p>}
    </div>
  );
}
