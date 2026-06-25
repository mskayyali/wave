import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

// ─── Types mirroring Rust structs ─────────────────────────────────────────────

export type ProjectStatus =
  | { type: 'empty' }
  | { type: 'importing' }
  | { type: 'readyToTranscribe' }
  | { type: 'transcribing' }
  | { type: 'ready' }
  | { type: 'error'; message: string };

export interface Project {
  id: string;
  name: string;
  createdAt: number;            // Unix ms
  originalFilename?: string;
  durationSecs?: number;
  status: ProjectStatus;
}

export interface ImportProgress {
  projectId:  string;
  percentage: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useProjects() {
  const [projects,               setProjects]               = useState<Project[]>([]);
  const [importProgress,         setImportProgress]         = useState<Record<string, number>>({});
  const [transcriptionProgress,  setTranscriptionProgress]  = useState<Record<string, number>>({});
  const [loading,                setLoading]                = useState(true);

  // ── List ───────────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const list = await invoke<Project[]>('list_projects');
      setProjects(list);
    } catch (e) {
      console.error('list_projects failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Create ─────────────────────────────────────────────────────────────────
  const createProject = useCallback(async (name: string): Promise<Project> => {
    const project = await invoke<Project>('create_project', { name });
    setProjects((prev) => [project, ...prev]);
    return project;
  }, []);

  // ── Pick audio file via native dialog ──────────────────────────────────────
  const pickAudioFile = useCallback(async (): Promise<string | null> => {
    const result = await open({
      multiple: false,
      directory: false,
      filters: [{
        name: 'Audio Files',
        extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'mp4', 'aiff'],
      }],
    });
    if (!result) return null;
    return typeof result === 'string' ? result : (result as { path: string }).path;
  }, []);

  // ── Import audio ───────────────────────────────────────────────────────────
  const importAudio = useCallback(async (projectId: string, sourcePath: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, status: { type: 'importing' } } : p
      )
    );
    setImportProgress((prev) => ({ ...prev, [projectId]: 0 }));
    try {
      await invoke('import_audio', { projectId, sourcePath });
    } catch (e) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? { ...p, status: { type: 'error', message: String(e) } }
            : p
        )
      );
    }
  }, []);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deleteProject = useCallback(async (projectId: string) => {
    try {
      await invoke('delete_project', { projectId });
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch (e) {
      console.error('delete_project failed:', e);
      throw e;
    }
  }, []);

  // ── Transcribe (local Whisper) ──────────────────────────────────────────────
  const transcribeProject = useCallback(async (projectId: string, modelId: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, status: { type: 'transcribing' } } : p
      )
    );
    setTranscriptionProgress((prev) => ({ ...prev, [projectId]: 0 }));
    try {
      await invoke('transcribe', { projectId, modelId });
    } catch (e) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? { ...p, status: { type: 'error', message: String(e) } }
            : p
        )
      );
    }
  }, []);


  // ── Event listeners ────────────────────────────────────────────────────────
  useEffect(() => {
    refresh();
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      // ── Import events ──────────────────────────────────────────────────────
      unlisteners.push(
        await listen<ImportProgress>('project:import_progress', ({ payload }) => {
          setImportProgress((prev) => ({
            ...prev,
            [payload.projectId]: payload.percentage,
          }));
        })
      );

      unlisteners.push(
        await listen<{ project: Project }>('project:import_complete', ({ payload }) => {
          setImportProgress((prev) => {
            const next = { ...prev };
            delete next[payload.project.id];
            return next;
          });
          setProjects((prev) =>
            prev.map((p) => (p.id === payload.project.id ? payload.project : p))
          );
        })
      );

      unlisteners.push(
        await listen<{ projectId: string; message: string }>(
          'project:import_error',
          ({ payload }) => {
            setImportProgress((prev) => {
              const next = { ...prev };
              delete next[payload.projectId];
              return next;
            });
            setProjects((prev) =>
              prev.map((p) =>
                p.id === payload.projectId
                  ? { ...p, status: { type: 'error', message: payload.message } }
                  : p
              )
            );
          }
        )
      );

      // ── Transcription events ───────────────────────────────────────────────
      unlisteners.push(
        await listen<{ projectId: string; percentage: number }>(
          'transcription:progress',
          ({ payload }) => {
            setTranscriptionProgress((prev) => ({
              ...prev,
              [payload.projectId]: payload.percentage,
            }));
          }
        )
      );

      unlisteners.push(
        await listen<{ projectId: string }>(
          'transcription:complete',
          ({ payload }) => {
            setTranscriptionProgress((prev) => {
              const next = { ...prev };
              delete next[payload.projectId];
              return next;
            });
            // Re-fetch to get the updated Ready status
            refresh();
          }
        )
      );

      unlisteners.push(
        await listen<{ projectId: string; message: string }>(
          'transcription:error',
          ({ payload }) => {
            setTranscriptionProgress((prev) => {
              const next = { ...prev };
              delete next[payload.projectId];
              return next;
            });
            setProjects((prev) =>
              prev.map((p) =>
                p.id === payload.projectId
                  ? { ...p, status: { type: 'error', message: payload.message } }
                  : p
              )
            );
          }
        )
      );
    };

    setup();
    return () => unlisteners.forEach((fn) => fn());
  }, [refresh]);

  return {
    projects,
    importProgress,
    transcriptionProgress,
    loading,
    refresh,
    createProject,
    deleteProject,
    pickAudioFile,
    importAudio,
    transcribeProject,
  };
}
