import { useEffect, useRef, useState } from 'react';
import { Theme } from '@carbon/react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { DropOverlay } from './components/layout/DropOverlay';
import { listenForMenu, onCommand, typing } from './lib/commands';
import { NavigationContext, type Navigation } from './lib/navigation';
import { AppShell } from './components/layout/AppShell';
import { AboutWave } from './components/layout/AboutWave';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { EditorPage } from './pages/EditorPage';
import { useModels } from './hooks/useModels';
import { isAudioFile, useProjects } from './hooks/useProjects';
import { useSettings } from './hooks/useSettings';
import { useActivityEvents } from './hooks/useActivity';
import { useAgentBridge } from './hooks/useAgent';
import type { Project } from './hooks/useProjects';
import { isTranscriptionModel, type ModelBundle } from './lib/modelCatalog';

type Page = 'projects' | 'settings';

function App() {
  const [activePage,   setActivePage]   = useState<Page>('projects');
  const [openProject,  setOpenProject]  = useState<Project | null>(null);
  /** ⌘N: the Projects page opens its New Project dialog (it may mount first). */
  const [newProjectPending, setNewProjectPending] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Files being dragged over the window: how many are audio. */
  const [dragging, setDragging] = useState<{ audio: number; other: number } | null>(null);

  const {
    models, progress: modelProgress, errors: modelErrors,
    loading: modelsLoading, hasReadyModel, alignerReady, speakerModelReady, enhanceModels,
    downloadModel, cancelDownload, deleteModel, clearError,
    downloadBundle, cancelBundle, deleteBundle,
  } = useModels();

  const {
    projects, importProgress, transcriptionProgress,
    loading: projectsLoading, refresh: refreshProjects,
    createProject, deleteProject, pickAudioFile, importAudio,
    transcribeProject,
  } = useProjects();

  const {
    settings, loading: settingsLoading,
    setSelectedModel,
  } = useSettings();

  // Background jobs (imports, transcription, downloads, the AI tools) for the
  // activity status in the sidebar and the editor, and the Dock icon.
  useActivityEvents(projects);

  // The window starts hidden (tauri.conf.json) and appears once the app is on
  // the page, so it never opens empty. Not on a frame: a hidden window gets
  // none. lib.rs shows it anyway if this never runs.
  useEffect(() => {
    try {
      getCurrentWindow().show().catch(() => undefined);
    } catch { /* not running in Tauri (a browser preview) */ }
  }, []);

  // Full screen hides the window buttons, so the space kept for them goes too.
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try { win = getCurrentWindow(); } catch { return; }
    const update = () => win.isFullscreen()
      .then((full) => document.body.classList.toggle('wave-fullscreen', full))
      .catch(() => undefined);
    update();
    const unlisten = win.onResized(update);
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  // ── Menu bar commands ──────────────────────────────────────────────────────
  // The shell's share; the editor registers its own while it's open.
  useEffect(() => {
    const off = [
      listenForMenu(),
      onCommand('about', () => setAboutOpen(true)),
      onCommand('settings', () => { setOpenProject(null); setActivePage('settings'); }),
      onCommand('new-project', () => {
        setOpenProject(null);
        setActivePage('projects');
        setNewProjectPending(true);
      }),
      onCommand('back', () => { setOpenProject(null); }),
      // Outside the editor, Undo and Redo only mean something in a text field.
      onCommand('undo', () => { if (typing()) document.execCommand('undo'); }),
      onCommand('redo', () => { if (typing()) document.execCommand('redo'); }),
    ];
    return () => off.forEach((fn) => fn());
  }, []);

  // ── Auto-select a ready model ──────────────────────────────────────────────
  // Selects the first ready model when none is selected, and re-points a saved
  // selection that names a model Wave no longer ships (it would otherwise fail
  // transcription with "model file not found").
  useEffect(() => {
    if (settingsLoading || modelsLoading) return;
    const transcribers = models.filter((m) => isTranscriptionModel(m.id));
    const current = settings.selectedModelId;
    const known   = transcribers.some((m) => m.id === current);
    if (current && known) return;
    const firstReady = transcribers.find((m) => m.status.type === 'ready');
    const next = firstReady?.id ?? null;
    if (next !== current) {
      setSelectedModel(next);
    }
  }, [models, modelsLoading, settings.selectedModelId, settingsLoading, setSelectedModel]);

  // ── Auto-transcribe after import ──────────────────────────────────────────
  // Track which projects were just imported in this session so we don't
  // re-trigger transcription on projects that were already readyToTranscribe
  // before the app launched.
  const justImportedRef = useRef<Set<string>>(new Set());

  async function handleNewProject(name: string, filePath: string): Promise<Project> {
    const project = await createProject(name);
    justImportedRef.current.add(project.id);
    await importAudio(project.id, filePath);
    return project;
  }

  // ── Drag and drop: every audio file dropped on the window becomes a project
  const dropRef = useRef<(paths: string[]) => void>(() => undefined);
  dropRef.current = (paths) => {
    for (const path of paths.filter(isAudioFile)) {
      const name = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
      handleNewProject(name, path).catch((e) => console.warn('Import failed:', e));
    }
  };
  useEffect(() => {
    let unlisten: Promise<() => void>;
    try {
      unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter') {
          const audio = payload.paths.filter(isAudioFile).length;
          setDragging({ audio, other: payload.paths.length - audio });
        } else if (payload.type === 'drop') {
          setDragging(null);
          dropRef.current(payload.paths);
        } else if (payload.type === 'leave') {
          setDragging(null);
        }
      });
    } catch { return; }
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  /** A project that failed or never got transcribed: try again. */
  async function retryProject(project: Project) {
    if (project.durationSecs) {
      // The audio was imported; it's the transcription that's missing.
      if (settings.selectedModelId) transcribeProject(project.id, settings.selectedModelId);
      else { setOpenProject(null); setActivePage('settings'); }
      return;
    }
    const path = await pickAudioFile();
    if (!path) return;
    justImportedRef.current.add(project.id);
    await importAudio(project.id, path);
  }

  const navigation: Navigation = {
    openSettings: () => { setOpenProject(null); setActivePage('settings'); },
  };

  // AI agents (Settings → AI agents): their tool calls run here and in the
  // open editor. Working on a project opens it, so its edits show as they land.
  useAgentBridge({
    projects:       () => projects,
    open:           (project) => setOpenProject(project),
    importAudio:    (path, name) => handleNewProject(name, path),
    hasTranscriber: hasReadyModel,
  });

  useEffect(() => {
    const { selectedModelId } = settings;
    if (!selectedModelId) return;

    for (const project of projects) {
      if (
        project.status.type === 'readyToTranscribe' &&
        justImportedRef.current.has(project.id)
      ) {
        justImportedRef.current.delete(project.id);
        transcribeProject(project.id, selectedModelId);
      }
    }
  }, [projects, settings, transcribeProject]);

  // Deleting the Transcription bundle removes the selected transcriber too.
  async function handleDeleteBundle(bundle: ModelBundle) {
    await deleteBundle(bundle);
    if (bundle.parts.some((p) => p.modelId === settings.selectedModelId)) {
      await setSelectedModel(null);
    }
  }

  function handleRetryBundle(bundle: ModelBundle) {
    bundle.parts.forEach((p) => clearError(p.modelId));
    downloadBundle(bundle);
  }

  function handleOpenProject(project: Project) {
    setOpenProject(project);
  }

  // Deleting the active model must not leave a dangling selection that later
  // fails transcription with "model not found". Clearing it lets the
  // auto-select effect re-point to another ready model (or leave it unset).
  async function handleDeleteModel(id: string) {
    await deleteModel(id);
    if (settings.selectedModelId === id) {
      await setSelectedModel(null);
    }
  }

  // ── Editor view bypasses the AppShell sidebar ──────────────────────────────
  // The open project as the list has it now, so its status stays current
  // (a project opened while transcribing fills in when it's done).
  const current = openProject ? projects.find((p) => p.id === openProject.id) ?? openProject : null;

  return (
    <NavigationContext.Provider value={navigation}>
      <Theme theme="g100" className="wave-theme-root">
        {current ? (
          <EditorPage
            key={current.id}
            project={current}
            alignerReady={alignerReady}
            enhanceModels={enhanceModels}
            speakerModelReady={speakerModelReady}
            onBack={() => setOpenProject(null)}
            onRename={() => void refreshProjects()}
            onRetry={() => void retryProject(current)}
          />
        ) : (
          <AppShell activePage={activePage} onNavigate={setActivePage} onAbout={() => setAboutOpen(true)}>
            {activePage === 'projects' && (
              <ProjectsPage
                projects={projects}
                importProgress={importProgress}
                transcriptionProgress={transcriptionProgress}
                loading={projectsLoading}
                hasReadyModel={hasReadyModel}
                newProjectPending={newProjectPending}
                onNewProjectShown={() => setNewProjectPending(false)}
                onNewProject={async (name, path) => { await handleNewProject(name, path); }}
                onPickFile={pickAudioFile}
                onOpenProject={handleOpenProject}
                onDeleteProject={deleteProject}
                onRetryProject={(p) => void retryProject(p)}
                onGoToSettings={() => setActivePage('settings')}
              />
            )}
            {activePage === 'settings' && (
              <SettingsPage
                models={models}
                progress={modelProgress}
                errors={modelErrors}
                loading={modelsLoading}
                onDownload={downloadModel}
                onCancel={cancelDownload}
                onDelete={handleDeleteModel}
                onRetry={(id) => { clearError(id); downloadModel(id); }}
                onDownloadBundle={downloadBundle}
                onCancelBundle={(b) => void cancelBundle(b)}
                onDeleteBundle={(b) => void handleDeleteBundle(b)}
                onRetryBundle={handleRetryBundle}
              />
            )}
          </AppShell>
        )}
        <AboutWave open={aboutOpen} onClose={() => setAboutOpen(false)} />
        {dragging && <DropOverlay audio={dragging.audio} other={dragging.other} />}
      </Theme>
    </NavigationContext.Provider>
  );
}

export default App;
