import {
  Button, ContentSwitcher, FormGroup, InlineNotification, ProgressBar, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, Switch, Toggle,
} from '@carbon/react';
import { StopFilled, TrashCan } from '@carbon/icons-react';
import { EQ_AMOUNTS, eqName } from '../../lib/eq';
import {
  canRun, sameOptions,
  type EnhanceLoudness, type EnhanceModels, type EnhanceModelsReady, type EnhanceOptions, type EnhancePreview as Preview,
  type Enhancement,
} from '../../hooks/useEnhancement';
import { EnhancePreview } from './EnhancePreview';
import { OpenSettings } from './OpenSettings';
import { ToolCredit } from './ToolCredit';
import { ToolOptions } from './ToolOptions';

// Speech enhancement (inspector → Tools). One choice up front, the clean-up:
// DPDFNet, or off (for the EQ and loudness alone, which need no download).
// Hear it on 15 s, then run it. A run writes an enhanced copy of the audio
// (with the EQ tool's preset, if one is chosen); the switch picks which one
// plays and exports. The clean-up's strength and the loudness target sit
// under Options.

export interface EnhanceToolProps {
  modelsReady: EnhanceModelsReady;
  enhancement: Enhancement | null;
  /** Options for the next run. */
  draft:       EnhanceOptions;
  running:     boolean;
  /** The step it's on ("Cleaning up speech"), while running. */
  step:        string | undefined;
  /** 0–1 while running. */
  progress:    number;
  error:       string | null;
  /** The enhanced audio is decoded, so switching to it is instant. */
  audioReady:  boolean;
  onDraft:     (patch: Partial<EnhanceOptions>) => void;
  onRun:       () => void;
  onCancel:    () => void;
  onEnabled:   (enabled: boolean) => void;
  onRemove:    () => void;
  /** Where a preview starts (ms): the selection, else the playhead. */
  previewFrom: () => number;
  onPreview:   (startMs: number) => Promise<Preview>;
  pausePlayback: () => void;
}

// DPDFNet takes 44–56 dB of noise out of the pauses on speech with noise mixed
// in (enhance.rs, tests::clean_up_yardstick).
const MODELS: { id: EnhanceModels; label: string; note: string }[] = [
  { id: 'none',    label: 'Off',     note: 'No clean-up: only the EQ and the loudness.' },
  { id: 'dpdfnet', label: 'DPDFNet', note: 'Removes background noise and room echo, keeping the voice as recorded.' },
];

/** How much of the clean-up to keep. */
const STRENGTHS: { value: number; label: string; hint: string }[] = [
  { value: 0.4, label: 'Subtle', hint: '40% cleaned, 60% original' },
  { value: 0.7, label: 'Medium', hint: '70% cleaned, 30% original' },
  { value: 1,   label: 'Full',   hint: 'Fully cleaned' },
];

const LOUDNESS: { id: EnhanceLoudness; label: string; short: string }[] = [
  { id: 'podcast',   label: 'Podcast (−19 LUFS)',     short: '−19 LUFS' },
  { id: 'streaming', label: 'Spotify, YouTube (−14)', short: '−14 LUFS' },
  { id: 'broadcast', label: 'Broadcast (−23)',        short: '−23 LUFS' },
  { id: 'off',       label: 'Off: keep the level',    short: 'level as is' },
];

function nearestStrength(strength: number): number {
  return STRENGTHS.reduce((best, s, i) => (Math.abs(s.value - strength) < Math.abs(STRENGTHS[best].value - strength) ? i : best), 0);
}

/** The clean-up's name; earlier versions' runs may name Clear. */
const CLEAN_UP_NAMES: Record<string, string> = { dpdfnet: 'DPDFNet', clear: 'Clear', both: 'DPDFNet + Clear' };

/** "DPDFNet · −19 LUFS", "DPDFNet · Medium · EQ Warmer · −14 LUFS". */
export function describeEnhancement(o: EnhanceOptions): string {
  const models = CLEAN_UP_NAMES[o.models] ?? null;
  const strength = STRENGTHS[nearestStrength(o.strength)];
  const eq = o.eq !== 'off' ? `EQ ${eqName(o.eq) ?? o.eq}${o.eqAmount !== 'medium' ? ` (${o.eqAmount})` : ''}` : null;
  return [models, models && strength.value < 1 ? strength.label : null, eq, o.loudness !== 'off' ? LOUDNESS.find((l) => l.id === o.loudness)?.short : null]
    .filter(Boolean).join(' · ') || 'Nothing applied';
}

/** The amount's label, for the EQ tool's summary. */
export const eqAmountLabel = (id: string) => EQ_AMOUNTS.find((a) => a.id === id)?.label ?? id;

/** What the chosen clean-up needs that isn't downloaded, for the note under the choice. */
export function missing(o: EnhanceOptions, ready: EnhanceModelsReady): string | null {
  return o.models === 'dpdfnet' && !ready.dpdfnet ? 'Download DPDFNet in Settings to clean up.' : null;
}

export function EnhancePanel(p: EnhanceToolProps) {
  const { enhancement, draft } = p;
  const changed  = enhancement !== null && !sameOptions(draft, enhancement.options);
  const runnable = canRun(draft, p.modelsReady);
  const needs    = missing(draft, p.modelsReady);

  const credits = (
    <ToolCredit model="DPDFNet" provider="Ceva" url="https://github.com/ceva-ip/DPDFNet"
      license={{ name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }} />
  );

  if (p.running) {
    return (
      <Stack gap={4}>
        <ProgressBar label={`${p.step ?? 'Starting'}…`} helperText={`${Math.round(p.progress * 100)}%`} value={p.progress * 100} max={100} size="small" />
        <div><Button size="sm" kind="ghost" renderIcon={StopFilled} onClick={p.onCancel}>Cancel</Button></div>
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      {enhancement && (
        <div>
          <Toggle
            id="wave-enhance-on"
            size="sm"
            labelText="Use for playback and export"
            labelA="Original audio"
            labelB="Enhanced audio"
            toggled={enhancement.enabled}
            onToggle={(on: boolean) => p.onEnabled(on)}
          />
          <p className="cds--form__helper-text">
            {enhancement.enabled && !p.audioReady ? 'Loading the enhanced audio…' : 'Switch while playing to compare. Edits apply to both.'}
          </p>
        </div>
      )}

      <RadioButtonGroup
        name="wave-noise-removal"
        legendText="Clean up"
        orientation="vertical"
        valueSelected={draft.models}
        onChange={(value) => p.onDraft({ models: value as EnhanceModels })}
        className="wave-choice-list"
      >
        {MODELS.map((m) => (
          <RadioButton
            key={m.id}
            id={`wave-noise-${m.id}`}
            value={m.id}
            labelText={<span className="wave-choice"><span className="wave-choice__name">{m.label}</span><span className="wave-choice__note">{m.note}</span></span>}
          />
        ))}
      </RadioButtonGroup>
      {needs && <p className="cds--form__helper-text"><strong>{needs}</strong></p>}

      <div className="wave-tool-actions">
        {(!enhancement || changed) && (
          <Button size="sm" kind="primary" className="wave-btn-accent" disabled={!runnable} onClick={p.onRun}>
            {enhancement ? 'Apply changes' : 'Enhance audio'}
          </Button>
        )}
        <EnhancePreview from={p.previewFrom} render={p.onPreview} onStart={p.pausePlayback} disabled={!runnable} />
      </div>
      {needs && <OpenSettings />}

      <ToolOptions>
        {draft.models !== 'none' && <FormGroup legendText="Clean-up strength">
          <ContentSwitcher
            size="sm"
            selectedIndex={nearestStrength(draft.strength)}
            onChange={({ index }) => { if (index !== undefined) p.onDraft({ strength: STRENGTHS[index].value }); }}
          >
            {STRENGTHS.map((s) => <Switch key={s.label} name={s.label} text={s.label} title={s.hint} />)}
          </ContentSwitcher>
        </FormGroup>}
        <Select
          id="wave-enhance-loudness"
          size="sm"
          labelText="Loudness"
          value={draft.loudness}
          onChange={(e) => p.onDraft({ loudness: e.target.value as EnhanceLoudness })}
        >
          {LOUDNESS.map((l) => <SelectItem key={l.id} value={l.id} text={l.label} />)}
        </Select>
      </ToolOptions>

      {enhancement && (
        <Stack gap={3}>
          <p className="cds--form__helper-text">
            Applied: {describeEnhancement(enhancement.options)}, in {(enhancement.elapsedMs / 1000).toFixed(0)} s.
            {enhancement.enabled && ' Plays and exports as 48 kHz mono; transcription uses the original.'}
          </p>
          <div>
            <Button size="sm" kind="danger--ghost" renderIcon={TrashCan} onClick={p.onRemove}>Discard enhanced audio</Button>
          </div>
        </Stack>
      )}

      {p.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Enhancement failed" subtitle={p.error} />}

      {credits}
    </Stack>
  );
}
