import { FolderOpen, Settings } from '@carbon/icons-react';

type Page = 'projects' | 'settings';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
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

function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="wave-sidebar">
      <div className="wave-sidebar__logo">
        <WaveformMark />
        <span className="wave-sidebar__wordmark">wave</span>
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

      <div className="wave-sidebar__footer">v0.1.0</div>
    </aside>
  );
}

interface AppShellProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  children: React.ReactNode;
}

export function AppShell({ activePage, onNavigate, children }: AppShellProps) {
  return (
    <div className="wave-shell">
      <Sidebar activePage={activePage} onNavigate={onNavigate} />
      <main className="wave-main">{children}</main>
    </div>
  );
}
