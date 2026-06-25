import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from '@carbon/icons-react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../hooks/useProjects';
import type { ViewMode } from '../../pages/EditorPage';

interface EditorTopBarProps {
  project:          Project;
  viewMode:         ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onBack:           () => void;
  /** Called with the new name after a successful rename. */
  onRename?:        (name: string) => void;
}

export function EditorTopBar({ project, viewMode, onViewModeChange, onBack, onRename }: EditorTopBarProps) {
  const [editing,   setEditing]   = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select-all when entering edit mode
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startEdit() {
    setEditValue(project.name);
    setEditing(true);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === project.name) return;
    invoke('rename_project', { projectId: project.id, name: trimmed })
      .then(() => onRename?.(trimmed))
      .catch((e) => console.warn('Rename failed:', e));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { setEditing(false); }
  }

  return (
    <header className="wave-editor-topbar">
      {/* Left — back + project name */}
      <button className="wave-editor-topbar__back" onClick={onBack} aria-label="Back to projects">
        <ArrowLeft size={16} />
      </button>

      <div className="wave-editor-topbar__divider" />

      {editing ? (
        <input
          ref={inputRef}
          className="wave-editor-topbar__rename-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          maxLength={80}
        />
      ) : (
        <h1
          className="wave-editor-topbar__title"
          onDoubleClick={startEdit}
          title="Double-click to rename"
        >
          {project.name}
        </h1>
      )}

      {/* Center — view mode toggle (absolutely positioned) */}
      <div className="wave-view-toggle" role="group" aria-label="Display mode">
        <button
          className={`wave-view-btn${viewMode === 'flow' ? ' wave-view-btn--active' : ''}`}
          onClick={() => onViewModeChange('flow')}
          title="Flow view — continuous text"
        >
          Flow
        </button>
        <button
          className={`wave-view-btn${viewMode === 'segments' ? ' wave-view-btn--active' : ''}`}
          onClick={() => onViewModeChange('segments')}
          title="Segments view — timestamped chunks"
        >
          Segments
        </button>
      </div>

      {/* Right side spacer so the left content doesn't push into the toggle */}
      <div className="wave-editor-topbar__spacer" />
    </header>
  );
}
