import { useState } from 'react';
import { Button, IconButton, Popover, PopoverContent, ProgressBar, Tag } from '@carbon/react';
import { CheckmarkFilled, Close, WarningFilled } from '@carbon/icons-react';
import { useActivities } from '../../hooks/useActivity';
import { activity, type Activity } from '../../lib/activity';
import { JobIcon, jobKind } from './JobIcon';

// What Wave is doing in the background (lib/activity.ts): the latest job, what
// kind of work it is (an animated JobIcon) and how far along (a ring around
// it), opening a list of every job. In the sidebar on the
// Projects and Settings pages, and in the editor's top bar. Nothing shows
// while nothing runs.

function title(a: Activity): string {
  if (a.state === 'done')  return a.doneLabel ?? a.label;
  if (a.state === 'error') return `${a.label} failed`;
  return a.label;
}

function percent(a: Activity): string | null {
  return a.state === 'running' && a.progress !== null ? `${Math.round(a.progress * 100)}%` : null;
}

/**
 * The job's icon inside a ring of its progress (a turning arc when there's no
 * telling); a check or a warning once it's over.
 */
function Badge({ a }: { a: Activity }) {
  if (a.state === 'done')  return <CheckmarkFilled size={20} className="wave-activity__icon wave-activity__icon--done" />;
  if (a.state === 'error') return <WarningFilled size={20} className="wave-activity__icon wave-activity__icon--error" />;
  const r = 10.75;
  const c = 2 * Math.PI * r;
  const known = a.progress !== null;
  return (
    <span className="wave-activity__badge">
      <svg className={`wave-activity__ring${known ? '' : ' wave-activity__ring--busy'}`} width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r={r} className="wave-activity__ring-track" />
        <circle cx="12" cy="12" r={r} className="wave-activity__ring-value"
          strokeDasharray={known ? `${c * a.progress!} ${c}` : `${c * 0.25} ${c}`} />
      </svg>
      <JobIcon kind={jobKind(a.id)} size={14} />
    </span>
  );
}

function ActivityItem({ a }: { a: Activity }) {
  const pct    = percent(a);
  const helper = a.state === 'error'
    ? a.error
    : [a.subject, a.state === 'running' ? a.detail : undefined, pct].filter(Boolean).join(' · ');
  return (
    <li className="wave-activity__item">
      <JobIcon kind={jobKind(a.id)} still={a.state !== 'running'} className="wave-activity__item-icon" />
      <ProgressBar
        label={title(a)}
        helperText={helper || undefined}
        value={a.state === 'running' && a.progress === null ? undefined : (a.progress ?? 0) * 100}
        max={100}
        size="small"
        status={a.state === 'done' ? 'finished' : a.state === 'error' ? 'error' : 'active'}
      />
      {a.state === 'running' && a.cancel && (
        <Button size="sm" kind="ghost" className="wave-activity__action" onClick={a.cancel}>Cancel</Button>
      )}
      {a.state !== 'running' && (
        <IconButton size="sm" kind="ghost" label="Dismiss" align="left" className="wave-activity__action" onClick={() => activity.dismiss(a.id)}>
          <Close />
        </IconButton>
      )}
    </li>
  );
}

export function ActivityStatus({ placement }: {
  /** `toolbar`: one line, the list below it. `sidebar`: two lines, the list beside it. */
  placement: 'toolbar' | 'sidebar';
}) {
  const [open, setOpen] = useState(false);
  const shown = useActivities().filter((a) => a.shown);
  if (shown.length === 0) return null;

  // The newest running job leads; else the newest failure; else what just finished.
  const newest = (state: Activity['state']) => shown.filter((a) => a.state === state).pop();
  const lead   = newest('running') ?? newest('error') ?? newest('done')!;
  const pct    = percent(lead);
  const others = shown.length - 1;
  const summary = [title(lead), pct, lead.subject].filter(Boolean).join(', ');

  return (
    <Popover
      open={open}
      onRequestClose={() => setOpen(false)}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
      align={placement === 'toolbar' ? 'bottom-end' : 'right-end'}
      caret={false}
      dropShadow
      className={`wave-activity wave-activity--${placement}`}
    >
      <button
        type="button"
        className="wave-activity__trigger"
        aria-expanded={open}
        aria-label={`Activity: ${summary}${others > 0 ? `, and ${others} more` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Badge a={lead} />
        <span className="wave-activity__text">
          <span className="wave-activity__label">{title(lead)}</span>
          {placement === 'sidebar' && lead.subject && <span className="wave-activity__subject">{lead.subject}</span>}
        </span>
        {pct && <span className="wave-activity__pct">{pct}</span>}
        {others > 0 && <Tag size="sm" type="gray" className="wave-activity__more">+{others}</Tag>}
      </button>
      {/* Announced as it changes, for screen readers. */}
      <span className="cds--visually-hidden" role="status" aria-live="polite">{lead.state === 'running' ? title(lead) : summary}</span>
      <PopoverContent className="wave-activity__panel">
        <p className="wave-activity__heading">Activity</p>
        <ul className="wave-activity__list">
          {[...shown].reverse().map((a) => <ActivityItem key={a.id} a={a} />)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
