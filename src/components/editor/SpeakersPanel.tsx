import { useEffect, useState } from 'react';
import { Button, InlineNotification, OverflowMenu, OverflowMenuItem, ProgressBar, Stack, TextInput, Toggle } from '@carbon/react';
import { Renew } from '@carbon/icons-react';
import type { Speaker, SpeakerAnalysis } from '../../hooks/useSpeakers';
import { formatTalkTime, rootSpeaker, speakerColor } from '../../lib/speakers';
import { OpenSettings } from './OpenSettings';
import { ToolCredit } from './ToolCredit';
import { ToolOptions } from './ToolOptions';

// The Speakers tool (inspector → Tools): detect who speaks when, name them,
// and show the turns in the transcript and exports.

export interface SpeakerToolProps {
  /** The speaker detection model is downloaded. */
  modelReady: boolean;
  analysis:   SpeakerAnalysis | null;
  running:    boolean;
  /** 0–1 while running. */
  progress:   number;
  error:      string | null;
  onDetect:   () => void;
  onRename:   (id: number, name: string) => void;
  onShow:     (show: boolean) => void;
  /** Count `from`'s words as `into`'s. */
  onMerge:    (from: number, into: number) => void;
  onUnmerge:  (id: number) => void;
  /** Select every word the speaker says (merges included). */
  onSelect:   (id: number) => void;
}

const CREDIT = (
  <ToolCredit
    model="Nemotron 3 Diarization"
    provider="NVIDIA"
    url="https://huggingface.co/nvidia/Nemotron-3-Diarization"
    license={{ name: 'OpenMDW 1.1', url: 'https://openmdw.ai/license/1-1/' }}
  />
);

/** A name field that saves on blur or Enter, not on every keystroke. */
function NameField({ id, name, onRename }: { id: number; name: string; onRename: (id: number, name: string) => void }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  return (
    <TextInput
      id={`wave-speaker-${id}`}
      size="sm"
      labelText={`Name of speaker ${id + 1}`}
      hideLabel
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onRename(id, value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function SpeakersPanel(p: SpeakerToolProps) {
  const { analysis } = p;
  const error = p.error && !p.running && (
    <InlineNotification kind="error" lowContrast hideCloseButton title="Speaker detection failed" subtitle={p.error} />
  );

  if (p.running) {
    return (
      <ProgressBar
        label="Listening for speakers…"
        helperText={`${Math.round(p.progress * 100)}%`}
        value={p.progress * 100}
        max={100}
        size="small"
      />
    );
  }

  if (!analysis) {
    return (
      <Stack gap={5}>
        <p className="wave-tool-note">
          Works out who is speaking when, for up to 8 people, so the transcript reads as a conversation
          and exports carry the names.
          {!p.modelReady && <> Download <strong>Speaker detection</strong> in Settings to use it.</>}
        </p>
        {p.modelReady ? (
          <div>
            <Button size="sm" kind="primary" className="wave-btn-accent" onClick={p.onDetect}>Detect speakers</Button>
          </div>
        ) : <OpenSettings />}
        {error}
        {CREDIT}
      </Stack>
    );
  }

  const total = analysis.speakers.reduce((sum, s) => sum + s.talkMs, 0) || 1;
  // Speakers as they now stand: each with the ones merged into it.
  const roots = analysis.speakers.filter((s) => rootSpeaker(s.id, analysis.speakers) === s.id);
  const mergedInto = (root: Speaker) =>
    analysis.speakers.filter((s) => s.id !== root.id && rootSpeaker(s.id, analysis.speakers) === root.id);

  return (
    <Stack gap={5}>
      <p className="wave-tool-summary">
        <strong>{roots.length}</strong> {roots.length === 1 ? 'speaker' : 'speakers'}
        <span className="wave-tool-summary__muted"> · name them to label the transcript</span>
      </p>

      <ul className="wave-speaker-list">
        {roots.map((s) => {
          const merged = mergedInto(s);
          const talkMs = s.talkMs + merged.reduce((sum, m) => sum + m.talkMs, 0);
          return (
            <li key={s.id} className="wave-speaker">
              <div className="wave-speaker__row">
                <span className="wave-speaker__swatch" style={{ background: speakerColor(s.id) }} aria-hidden />
                <NameField id={s.id} name={s.name} onRename={p.onRename} />
                <span className="wave-speaker__time" title={`${Math.round((100 * talkMs) / total)}% of the talking`}>
                  {formatTalkTime(talkMs)}
                </span>
                <OverflowMenu size="sm" flipped aria-label={`Actions for ${s.name}`} iconDescription={`Actions for ${s.name}`}>
                  <OverflowMenuItem itemText="Select everything they said" onClick={() => p.onSelect(s.id)} />
                  {roots.filter((o) => o.id !== s.id).map((o, i) => (
                    <OverflowMenuItem key={o.id} hasDivider={i === 0} itemText={`Merge into ${o.name}`} onClick={() => p.onMerge(s.id, o.id)} />
                  ))}
                </OverflowMenu>
              </div>
              {merged.map((m) => (
                <div key={m.id} className="wave-speaker__merged">
                  <span className="wave-speaker__swatch" style={{ background: speakerColor(m.id) }} aria-hidden />
                  <span className="wave-speaker__merged-name">Includes {m.name} · {formatTalkTime(m.talkMs)}</span>
                  <Button kind="ghost" size="sm" onClick={() => p.onUnmerge(m.id)}>Separate</Button>
                </div>
              ))}
            </li>
          );
        })}
      </ul>

      <ToolOptions>
        <Toggle
          id="wave-speakers-show"
          size="sm"
          labelText="Show in transcript and exports"
          labelA="Off"
          labelB="On"
          toggled={analysis.settings.show}
          onToggle={(show: boolean) => p.onShow(show)}
        />
        {p.modelReady && (
          <div>
            <Button size="sm" kind="ghost" renderIcon={Renew} onClick={p.onDetect}>Detect again</Button>
          </div>
        )}
      </ToolOptions>
      {error}
      {CREDIT}
    </Stack>
  );
}
