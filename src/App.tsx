import { useEffect, useRef, useState } from 'react';
import { Theme } from '@carbon/react';
import { AppShell } from './components/layout/AppShell';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { EditorPage } from './pages/EditorPage';
import { useModels } from './hooks/useModels';
import { useProjects } from './hooks/useProjects';
import { useSettings } from './hooks/useSettings';
import type { Project } from './hooks/useProjects';

type Page = 'projects' | 'settings';

function App() {
  const [activePage,   setActivePage]   = useState<Page>('projects');
  const [openProject,  setOpenProject]  = useState<Project | null>(null);

  const {
    models, progress: modelProgress, errors: modelErrors,
    loading: modelsLoading, hasReadyModel,
    downloadModel, cancelDownload, deleteModel, clearError,
  } = useModels();

  const {
    projects, importProgress, transcriptionProgress,
    loading: projectsLoading,
    createProject, deleteProject, pickAudioFile, importAudio,
    transcribeProject,
  } = useProjects();

  const {
    settings, loading: settingsLoading,
    setSelectedModel,
  } = useSettings();

  // ── Auto-select first ready model when none is selected ───────────────────
  useEffect(() => {
    if (settingsLoading) return;
    if (settings.selectedModelId) return;
    const firstReady = models.find((m) => m.status.type === 'ready');
    if (firstReady) {
      setSelectedModel(firstReady.id);
    }
  }, [models, settings.selectedModelId, settingsLoading, setSelectedModel]);

  // ── Auto-transcribe after import ──────────────────────────────────────────
  // Track which projects were just imported in this session so we don't
  // re-trigger transcription on projects that were already readyToTranscribe
  // before the app launched.
  const justImportedRef = useRef<Set<string>>(new Set());

  async function handleNewProject(name: string, filePath: string) {
    const project = await createProject(name);
    justImportedRef.current.add(project.id);
    await importAudio(project.id, filePath);
  }

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

  function handleOpenProject(project: Project) {
    setOpenProject(project);
  }

  // ── Editor view bypasses the AppShell sidebar ──────────────────────────────
  if (openProject) {
    return (
      <Theme theme="g100" className="wave-theme-root">
        <EditorPage
          project={openProject}
          onBack={() => setOpenProject(null)}
        />
      </Theme>
    );
  }

  return (
    <Theme theme="g100" className="wave-theme-root">
      <AppShell activePage={activePage} onNavigate={setActivePage}>
        {activePage === 'projects' && (
          <ProjectsPage
            projects={projects}
            importProgress={importProgress}
            transcriptionProgress={transcriptionProgress}
            loading={projectsLoading}
            hasReadyModel={hasReadyModel}
            onNewProject={handleNewProject}
            onPickFile={pickAudioFile}
            onOpenProject={handleOpenProject}
            onDeleteProject={deleteProject}
            onGoToSettings={() => setActivePage('settings')}
          />
        )}
        {activePage === 'settings' && (
          <SettingsPage
            models={models}
            progress={modelProgress}
            errors={modelErrors}
            loading={modelsLoading}
            selectedModelId={settings.selectedModelId}
            onDownload={downloadModel}
            onCancel={cancelDownload}
            onDelete={deleteModel}
            onRetry={(id) => { clearError(id); downloadModel(id); }}
            onSelectModel={setSelectedModel}
          />
        )}
      </AppShell>
    </Theme>
  );
}

export default App;
