import { useCallback, useEffect, useRef, useState } from 'react';

export interface PlaybackState {
  isPlaying: boolean;
  currentMs: number;
  durationMs: number;
  rate: number;
}

const INITIAL: PlaybackState = { isPlaying: false, currentMs: 0, durationMs: 0, rate: 1 };

export function usePlayback(audioSrc: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef   = useRef<number>(0);
  const [state,  setState] = useState<PlaybackState>(INITIAL);

  // ── Create / destroy audio element when src changes ───────────────────────
  useEffect(() => {
    if (!audioSrc) {
      setState(INITIAL);
      return;
    }

    const audio   = new Audio(audioSrc);
    audioRef.current = audio;

    const onMeta  = () => setState((s) => ({ ...s, durationMs: audio.duration * 1000 }));
    const onPlay  = () => setState((s) => ({ ...s, isPlaying: true }));
    const onPause = () => setState((s) => ({ ...s, isPlaying: false }));
    const onEnded = () => setState((s) => ({ ...s, isPlaying: false }));

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('play',           onPlay);
    audio.addEventListener('pause',          onPause);
    audio.addEventListener('ended',          onEnded);

    return () => {
      audio.pause();
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('play',           onPlay);
      audio.removeEventListener('pause',          onPause);
      audio.removeEventListener('ended',          onEnded);
      audioRef.current = null;
    };
  }, [audioSrc]);

  // ── RAF loop — track currentMs smoothly without event polling lag ─────────
  useEffect(() => {
    function tick() {
      const audio = audioRef.current;
      if (audio) {
        const ms = audio.currentTime * 1000;
        setState((s) => (ms !== s.currentMs ? { ...s, currentMs: ms } : s));
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Controls ──────────────────────────────────────────────────────────────
  const play   = useCallback(() => { audioRef.current?.play(); }, []);
  const pause  = useCallback(() => { audioRef.current?.pause(); }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.paused ? a.play() : a.pause();
  }, []);

  const seek = useCallback((ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    const clamped = Math.max(0, Math.min(ms, a.duration * 1000));
    a.currentTime = clamped / 1000;
    setState((s) => ({ ...s, currentMs: clamped }));
  }, []);

  const setRate = useCallback((r: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = r;
    setState((s) => ({ ...s, rate: r }));
  }, []);

  return { ...state, play, pause, toggle, seek, setRate };
}
