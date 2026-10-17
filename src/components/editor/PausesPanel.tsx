import { useState } from 'react';
import { Button, ContentSwitcher, FormGroup, Select, SelectItem, Stack, Switch } from '@carbon/react';
import { Add, PlayFilledAlt } from '@carbon/icons-react';
import { RHYTHMS, shortenPauses, type Pause, type Rhythm } from '../../lib/pauses';

// The Pauses tool (inspector → Tools). Long pauses are read from the
// transcript and shortened to a rhythm: pauses between sentences (a word that
// ends one, or a change of speaker) stay longer than pauses within one. A
// preview plays the result before anything is cut, and the cuts are one edit.
// Pauses can also be added: room tone from nearby, so it sounds like the room.

export interface PauseToolProps {
  /** Pauses between kept words that no edit has touched, from the transcript. */
  pauses:        Pause[];
  rhythm:        Rhythm['id'];
  onRhythm:      (id: Rhythm['id']) => void;
  /** Shorten every pause longer than the rhythm allows, as one edit. */
  onShorten:     () => void;
  /** Hear the result from the next long pause after the playhead. */
  onPreview:     () => void;
  /** Pauses added by hand so far. */
  added:         { count: number; ms: number };
  onAddAtPlayhead: (ms: number) => void;
}

const ADD_LENGTHS = [250, 500, 1000, 2000];

function seconds(ms: number): string {
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : Number(s.toFixed(s < 1 ? 2 : 1))} s`;
}

export function PausesPanel(p: PauseToolProps) {
  const [addMs, setAddMs] = useState(500);
  const rhythm = RHYTHMS.find((r) => r.id === p.rhythm) ?? RHYTHMS[1];
  const plan = shortenPauses(p.pauses, rhythm);
  const savedMs = plan.reduce((sum, c) => sum + c.endMs - c.startMs, 0);

  return (
    <Stack gap={6}>
      <Stack gap={5}>
        <p className="wave-tool-note">
          Shortens long pauses, read from the transcript. Pauses between sentences stay a little longer than
          pauses within one, so it still breathes.
        </p>
        <FormGroup legendText="Rhythm">
          <ContentSwitcher
            size="sm"
            selectedIndex={Math.max(0, RHYTHMS.findIndex((r) => r.id === p.rhythm))}
            onChange={({ index }) => { if (index !== undefined) p.onRhythm(RHYTHMS[index].id); }}
          >
            {RHYTHMS.map((r) => <Switch key={r.id} name={r.id} text={r.label} />)}
          </ContentSwitcher>
          <p className="cds--form__helper-text">
            Up to {seconds(rhythm.sentence)} between sentences and {seconds(rhythm.within)} within one.
          </p>
        </FormGroup>
        <p className="wave-tool-summary">
          {plan.length === 0
            ? 'No pauses run longer than that.'
            : <>{plan.length} {plan.length === 1 ? 'pause runs' : 'pauses run'} longer <span className="wave-tool-summary__muted">· shortening saves {seconds(savedMs)}</span></>}
        </p>
        <div className="wave-tool-actions">
          <Button size="sm" kind="tertiary" renderIcon={PlayFilledAlt} disabled={plan.length === 0} onClick={p.onPreview}>Preview</Button>
          <Button size="sm" kind="primary" className="wave-btn-accent" disabled={plan.length === 0} onClick={p.onShorten}>
            {plan.length === 0 ? 'Shorten pauses' : `Shorten ${plan.length} ${plan.length === 1 ? 'pause' : 'pauses'}`}
          </Button>
        </div>
      </Stack>

      <FormGroup legendText="Add a pause">
        <Stack gap={4}>
          <p className="cds--form__helper-text wave-pauses__hint">
            Right-click a word for <strong>Add pause after</strong>, or add one at the playhead. It's filled with the
            room&apos;s own quiet from nearby, so it doesn&apos;t sound like a drop-out.
          </p>
          <div className="wave-tool-actions">
            <Select id="wave-pause-length" size="sm" labelText="Length" hideLabel value={String(addMs)} onChange={(e) => setAddMs(Number(e.target.value))}>
              {ADD_LENGTHS.map((ms) => <SelectItem key={ms} value={String(ms)} text={seconds(ms)} />)}
            </Select>
            <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => p.onAddAtPlayhead(addMs)}>Add at playhead</Button>
          </div>
          {p.added.count > 0 && (
            <p className="cds--form__helper-text wave-pauses__hint">
              {p.added.count} added, {seconds(p.added.ms)} in all. Right-click one in the text to take it out, or undo it under Edits.
            </p>
          )}
        </Stack>
      </FormGroup>
    </Stack>
  );
}
