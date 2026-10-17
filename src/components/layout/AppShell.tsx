import { FolderOpen, Settings } from '@carbon/icons-react';
import { UpdateCue } from '../update/UpdateCue';
import { ActivityStatus } from './ActivityStatus';

type Page = 'projects' | 'settings';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  /** Open About Wave. */
  onAbout:    () => void;
}

const WaveformMark = () => (
  <svg width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden="true">
    <rect x="0"  y="7"  width="2.5" height="4"  rx="1.25" fill="var(--wave-accent)" />
    <rect x="4"  y="3"  width="2.5" height="12" rx="1.25" fill="var(--wave-accent)" />
    <rect x="8"  y="0"  width="2.5" height="18" rx="1.25" fill="var(--wave-accent)" />
    <rect x="12" y="4"  width="2.5" height="10" rx="1.25" fill="var(--wave-accent)" />
    <rect x="16" y="1"  width="2.5" height="16" rx="1.25" fill="var(--wave-accent)" />
    <rect x="20" y="6"  width="2.5" height="6"  rx="1.25" fill="var(--wave-accent)" opacity="0.6" />
  </svg>
);

const NAV_ITEMS: { id: Page; label: string; Icon: React.ComponentType<{ size: number }> }[] = [
  { id: 'projects', label: 'Projects',  Icon: FolderOpen },
  { id: 'settings', label: 'Settings',  Icon: Settings   },
];

function Sidebar({ activePage, onNavigate, onAbout }: SidebarProps) {
  return (
    <aside className="wave-sidebar">
      {/* The window buttons sit at the left of this row; it moves the window. */}
      <div className="wave-sidebar__logo" data-tauri-drag-region>
        <WaveformMark />
        <span className="wave-sidebar__wordmark">Wave</span>
      </div>

      <nav className="wave-sidebar__nav" aria-label="Main navigation">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`wave-sidebar__nav-item${activePage === id ? ' wave-sidebar__nav-item--active' : ''}`}
            onClick={() => onNavigate(id)}
            aria-current={activePage === id ? 'page' : undefined}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>

      <ActivityStatus placement="sidebar" />
      <div className="wave-sidebar__footer">
        <button type="button" className="wave-sidebar__about" onClick={onAbout}>About</button>
        <UpdateCue placement="sidebar" />
      </div>
    </aside>
  );
}

interface AppShellProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  onAbout:    () => void;
  children: React.ReactNode;
}

export function AppShell({ activePage, onNavigate, onAbout, children }: AppShellProps) {
  return (
    <div className="wave-shell">
      <Sidebar activePage={activePage} onNavigate={onNavigate} onAbout={onAbout} />
      <main className="wave-main">
        {/* Under the hidden title bar: where the window is dragged from. */}
        <div className="wave-titlebar" data-tauri-drag-region />
        {children}
      </main>
    </div>
  );
}
