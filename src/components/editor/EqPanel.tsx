import { Button, ContentSwitcher, FormGroup, InlineNotification, Link, ProgressBar, RadioButton, RadioButtonGroup, Stack, Switch, Toggle } from '@carbon/react';
import { StopFilled } from '@carbon/icons-react';
import { EQ_AMOUNTS, EQ_PRESETS, eqName, type EqAmount } from '../../lib/eq';
import { canRun, sameOptions } from '../../hooks/useEnhancement';
import { describeEnhancement, missing, type EnhanceToolProps } from './EnhancePanel';
import { EnhancePreview } from './EnhancePreview';
import { OpenSettings } from './OpenSettings';

// The EQ tool (inspector → Tools → Sound): a preset for the voice's tone and how
// much of it. It runs in the same chain as Speech enhancement (clean-up,
// then the EQ, then the loudness target) and makes the same enhanced audio, so
// the line above Apply says exactly what will run, with a way to change the rest.

export interface EqToolProps extends EnhanceToolProps {
  /** Open Speech enhancement (clean-up and loudness live there). */
  onOpenEnhance: () => void;
}

const LOUDNESS_SHORT: Record<string, string> = { podcast: '−19 LUFS', streaming: '−14 LUFS', broadcast: '−23 LUFS' };

/** "clean-up with DPDFNet → EQ Warmer (medium) → loudness to −19 LUFS". */
function chain(p: EqToolProps): string {
  const d = p.draft;
  const noise = d.models === 'dpdfnet' ? 'clean-up with DPDFNet' : null;
  const eq = d.eq === 'off' ? 'no EQ' : `EQ ${eqName(d.eq)} (${d.eqAmount})`;
  const loud = LOUDNESS_SHORT[d.loudness] ? `loudness to ${LOUDNESS_SHORT[d.loudness]}` : null;
  return [noise, eq, loud].filter(Boolean).join(' → ');
}

export function EqPanel(p: EqToolProps) {
  const { enhancement, draft } = p;
  const changed  = enhancement === null || !sameOptions(draft, enhancement.options);
  const runnable = canRun(draft, p.modelsReady);
  const needs    = missing(draft, p.modelsReady);

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
      <p className="wave-tool-note">
        Shapes the tone of the voice. It runs after the clean-up and before the loudness target, into the same enhanced audio.
      </p>

      {enhancement && (
        <div>
          <Toggle
            id="wave-eq-on"
            size="sm"
            labelText="Use for playback and export"
            labelA="Original audio"
            labelB="Enhanced audio"
            toggled={enhancement.enabled}
            onToggle={(on: boolean) => p.onEnabled(on)}
          />
          <p className="cds--form__helper-text">Applied: {describeEnhancement(enhancement.options)}.</p>
        </div>
      )}

      <RadioButtonGroup
        name="wave-eq-preset"
        legendText="Preset"
        orientation="vertical"
        valueSelected={draft.eq}
        onChange={(value) => p.onDraft({ eq: String(value) })}
        className="wave-choice-list"
      >
        {[{ id: 'off', name: 'Off', note: 'The voice as it is.' }, ...EQ_PRESETS].map((preset) => (
          <RadioButton
            key={preset.id}
            id={`wave-eq-${preset.id}`}
            value={preset.id}
            labelText={<span className="wave-choice"><span className="wave-choice__name">{preset.name}</span><span className="wave-choice__note">{preset.note}</span></span>}
          />
        ))}
      </RadioButtonGroup>

      {draft.eq !== 'off' && (
        <FormGroup legendText="Amount">
          <ContentSwitcher
            size="sm"
            selectedIndex={Math.max(0, EQ_AMOUNTS.findIndex((a) => a.id === draft.eqAmount))}
            onChange={({ index }) => { if (index !== undefined) p.onDraft({ eqAmount: EQ_AMOUNTS[index].id as EqAmount }); }}
          >
            {EQ_AMOUNTS.map((a) => <Switch key={a.id} name={a.id} text={a.label} />)}
          </ContentSwitcher>
        </FormGroup>
      )}

      <div className="wave-eq-chain">
        <p className="cds--form__helper-text">Runs: {chain(p).replace(/^./, (c) => c.toUpperCase())}.</p>
        <Link href="#" size="sm" onClick={(e) => { e.preventDefault(); p.onOpenEnhance(); }}>Change clean-up or loudness</Link>
      </div>

      <div className="wave-tool-actions">
        {changed && (
          <Button size="sm" kind="primary" className="wave-btn-accent" disabled={!runnable} onClick={p.onRun}>
            {enhancement ? 'Apply changes' : 'Apply EQ'}
          </Button>
        )}
        <EnhancePreview from={p.previewFrom} render={p.onPreview} onStart={p.pausePlayback} disabled={!runnable} />
      </div>
      {needs && <><p className="cds--form__helper-text"><strong>{needs}</strong></p><OpenSettings /></>}

      {p.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Couldn't apply the EQ" subtitle={p.error} />}
    </Stack>
  );
}
