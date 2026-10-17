import { useLayoutEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { Button, ContainedList, ContainedListItem, IconButton, Toggle } from '@carbon/react';
import { ArrowLeft, ArrowRight, ChevronRight, Equalizer, PauseOutline, UserMultiple, Waveform } from '@carbon/icons-react';
import { useNavigation } from '../../lib/navigation';
import { RHYTHMS, shortenPauses } from '../../lib/pauses';
import { rootSpeaker } from '../../lib/speakers';
import { JobIcon, type JobKind } from '../layout/JobIcon';
import { EnhancePanel, describeEnhancement, type EnhanceToolProps } from './EnhancePanel';
import { SpeakersPanel, type SpeakerToolProps } from './SpeakersPanel';
import { PausesPanel, type PauseToolProps } from './PausesPanel';
import { EqPanel } from './EqPanel';
import { eqName } from '../../lib/eq';

// The inspector's Tools tab: a short list of the tools, grouped by what they're
// for, each row with its live status and the one thing to do next (find,
// remove, shorten, switch on…). A row opens that tool on its own, with its
// results first and its settings folded under Options; its chevron says so.
// Every label says what happens: a button that leads to Settings says
// Settings, and the enhancement switch is named for what it switches.

export type ToolId = 'pauses' | 'enhance' | 'eq' | 'speakers';

export interface ToolsTabProps {
  enhanceTool: EnhanceToolProps;
  speakerTool: SpeakerToolProps;
  pauseTool:   PauseToolProps;
  /** The tool shown on its own, or null for the list. */
  open:        ToolId | null;
  onOpen:      (id: ToolId | null) => void;
}

interface Row {
  status: string;
  /** The next step, beside the row. */
  action?: ReactNode;
  /** Working: its animated icon instead of the tool's own. */
  busy?:   JobKind;
}

const TOOLS: { id: ToolId; group: string; title: string; icon: ComponentType }[] = [
  { id: 'pauses',   group: 'Tighten',  title: 'Pauses',             icon: PauseOutline },
  { id: 'enhance',  group: 'Sound',    title: 'Speech enhancement', icon: Waveform },
  { id: 'eq',       group: 'Sound',    title: 'EQ',                 icon: Equalizer },
  { id: 'speakers', group: 'People',   title: 'Speakers',           icon: UserMultiple },
];

const pct = (progress: number) => `${Math.round(progress * 100)}%`;

function seconds(ms: number): string {
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : Number(s.toFixed(1))} s`;
}

export function ToolsTab(p: ToolsTabProps) {
  const { openSettings } = useNavigation();
  const get = <Button size="sm" kind="ghost" renderIcon={ArrowRight} onClick={openSettings}>Settings</Button>;
  const act = (label: string, onClick: () => void) => <Button size="sm" kind="ghost" onClick={onClick}>{label}</Button>;

  function row(id: ToolId): Row {
    switch (id) {
      case 'pauses': {
        const t = p.pauseTool;
        const plan = shortenPauses(t.pauses, RHYTHMS.find((r) => r.id === t.rhythm) ?? RHYTHMS[1]);
        const added = t.added.count > 0 ? ` · ${t.added.count} added` : '';
        if (plan.length === 0) return { status: `None run long${added}` };
        const saved = plan.reduce((sum, c) => sum + c.endMs - c.startMs, 0);
        return { status: `${plan.length} run long · ${seconds(saved)} to save${added}`, action: act('Shorten', t.onShorten) };
      }
      case 'enhance': {
        const t = p.enhanceTool;
        if (t.running) return { status: `${t.step ?? 'Starting'}… ${pct(t.progress)}`, busy: 'enhance' };
        if (!t.enhancement) {
          if (t.error) return { status: 'Enhancement failed', action: act('Retry', t.onRun) };
          return { status: t.modelsReady.dpdfnet ? 'Removes noise and room echo' : 'Loudness only: the clean-up needs a download', action: act('Enhance', t.onRun) };
        }
        // A bare switch: the status says what's on, its (hidden) name what it does.
        return {
          status: t.enhancement.enabled ? describeEnhancement(t.enhancement.options) : 'Off: the original plays and exports',
          action: (
            <>
              <span id="wave-enhance-row-label" className="cds--visually-hidden">Use the enhanced audio for playback and export</span>
              <Toggle
                id="wave-enhance-row"
                size="sm"
                labelText=""
                hideLabel
                aria-labelledby="wave-enhance-row-label"
                toggled={t.enhancement.enabled}
                onToggle={(on: boolean) => t.onEnabled(on)}
              />
            </>
          ),
        };
      }
      case 'eq': {
        const t = p.enhanceTool;
        if (t.running) return { status: `${t.step ?? 'Starting'}… ${pct(t.progress)}`, busy: 'enhance' };
        const applied = t.enhancement?.options;
        if (applied && applied.eq !== 'off') {
          return { status: `${eqName(applied.eq) ?? applied.eq} · ${applied.eqAmount}${t.enhancement!.enabled ? '' : ' · enhanced audio off'}` };
        }
        if (t.draft.eq !== 'off') return { status: `${eqName(t.draft.eq)} chosen, not applied yet` };
        return { status: 'Off' };
      }
      case 'speakers': {
        const t = p.speakerTool;
        if (t.running) return { status: `Listening for speakers… ${pct(t.progress)}`, busy: 'speakers' };
        if (!t.analysis) {
          if (!t.modelReady) return { status: 'Needs a download', action: get };
          if (t.error) return { status: 'Detection failed', action: act('Retry', t.onDetect) };
          return { status: 'Finds who speaks when', action: act('Detect', t.onDetect) };
        }
        const roots = t.analysis.speakers.filter((s) => rootSpeaker(s.id, t.analysis!.speakers) === s.id);
        return { status: roots.length === 0 ? 'Nobody found' : roots.map((s) => s.name).join(', ') };
      }
    }
  }

  // ── One tool ──────────────────────────────────────────────────────────────
  if (p.open) {
    const tool = TOOLS.find((t) => t.id === p.open)!;
    return (
      <div className="wave-tool-detail">
        <div className="wave-tool-detail__header">
          <IconButton kind="ghost" size="sm" label="All tools" align="right" onClick={() => p.onOpen(null)}>
            <ArrowLeft />
          </IconButton>
          <h3 className="wave-tool-detail__title">{tool.title}</h3>
        </div>
        <div className="wave-tool-detail__body">
          {tool.id === 'pauses'   && <PausesPanel {...p.pauseTool} />}
          {tool.id === 'enhance'  && <EnhancePanel {...p.enhanceTool} />}
          {tool.id === 'eq'       && <EqPanel {...p.enhanceTool} onOpenEnhance={() => p.onOpen('enhance')} />}
          {tool.id === 'speakers' && <SpeakersPanel {...p.speakerTool} />}
        </div>
      </div>
    );
  }

  // ── The list ──────────────────────────────────────────────────────────────
  const groups = [...new Set(TOOLS.map((t) => t.group))];
  return (
    <div className="wave-tools">
      {groups.map((group) => (
        <ContainedList key={group} label={group} kind="on-page" size="lg" className="wave-tools__group">
          {TOOLS.filter((t) => t.group === group).map((tool) => {
            const r = row(tool.id);
            const Busy = r.busy ? () => <JobIcon kind={r.busy!} size={16} /> : null;
            return (
              <ContainedListItem
                key={tool.id}
                renderIcon={Busy ?? tool.icon}
                onClick={() => p.onOpen(tool.id)}
                action={
                  <RowActions>
                    {r.action}
                    <IconButton kind="ghost" size="sm" label={`Open ${tool.title}`} align="left" onClick={() => p.onOpen(tool.id)}>
                      <ChevronRight />
                    </IconButton>
                  </RowActions>
                }
                className="wave-tools__row"
              >
                <span className="wave-tools__text">
                  <span className="wave-tools__name">{tool.title}</span>
                  <span className="wave-tools__status">{r.status}</span>
                </span>
              </ContainedListItem>
            );
          })}
        </ContainedList>
      ))}
    </div>
  );
}

/** A row's next step and chevron. Carbon floats a list item's action over the
 *  row, so this tells the row how wide they are and its text stops short. */
function RowActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.closest<HTMLElement>('.wave-tools__row');
    if (!el || !row) return;
    const fit = () => row.style.setProperty('--wave-tools-actions', `${el.offsetWidth}px`);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="wave-tools__actions">{children}</div>;
}
