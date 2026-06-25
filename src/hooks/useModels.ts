import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ─── Types mirroring the Rust structs ────────────────────────────────────────

export type ModelStatusType =
  | { type: 'notDownloaded' }
  | { type: 'partial'; downloadedBytes: number }
  | { type: 'downloading' }
  | { type: 'ready'; sizeBytes: number };

export interface ModelInfo {
  id: string;
  filename: string;
  status: ModelStatusType;
}

export interface DownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  etaSecs: number;
  resuming: boolean;
}

export interface ModelError {
  modelId: string;
  message: string;
}

// Live download progress keyed by model id
export type ProgressMap = Record<string, DownloadProgress>;
export type ErrorMap    = Record<string, string>;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useModels() {
  const [models,    setModels]    = useState<ModelInfo[]>([]);
  const [progress,  setProgress]  = useState<ProgressMap>({});
  const [errors,    setErrors]    = useState<ErrorMap>({});
  const [loading,   setLoading]   = useState(true);

  // ── Fetch model list ───────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const list = await invoke<ModelInfo[]>('list_models');
      setModels(list);
    } catch (e) {
      console.error('list_models failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Download ───────────────────────────────────────────────────────────────
  const downloadModel = useCallback(async (modelId: string) => {
    // Optimistically mark as downloading in local state
    setModels((prev) =>
      prev.map((m) =>
        m.id === modelId ? { ...m, status: { type: 'downloading' } } : m
      )
    );
    // Clear any previous error for this model
    setErrors((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });

    try {
      await invoke('start_model_download', { modelId });
    } catch (e: unknown) {
      const msg = String(e);
      if (msg === 'already_downloaded' || msg === 'already_downloading') return;
      // Revert and show error
      setErrors((prev) => ({ ...prev, [modelId]: msg }));
      await refresh();
    }
  }, [refresh]);

  // ── Cancel ─────────────────────────────────────────────────────────────────
  const cancelDownload = useCallback(async (modelId: string) => {
    try {
      await invoke('cancel_model_download', { modelId });
    } catch {
      // Already finished or not found — refresh to sync state
      await refresh();
    }
  }, [refresh]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deleteModel = useCallback(async (modelId: string) => {
    try {
      await invoke('delete_model', { modelId });
      await refresh();
    } catch (e) {
      console.error('delete_model failed:', e);
    }
  }, [refresh]);

  // ── Clear error for a model (allows retry) ─────────────────────────────────
  const clearError = useCallback((modelId: string) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    // Also revert the model's status to reflect filesystem reality
    refresh();
  }, [refresh]);

  // ── Event listeners ────────────────────────────────────────────────────────
  useEffect(() => {
    refresh();

    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      // Progress ticks
      unlisteners.push(
        await listen<DownloadProgress>('model:progress', ({ payload }) => {
          setProgress((prev) => ({ ...prev, [payload.modelId]: payload }));
        })
      );

      // Download complete
      unlisteners.push(
        await listen<string>('model:complete', ({ payload: modelId }) => {
          setProgress((prev) => {
            const next = { ...prev };
            delete next[modelId];
            return next;
          });
          // Re-fetch to get the Ready status with actual file size
          refresh();
        })
      );

      // Download cancelled — keep partial state in the list
      unlisteners.push(
        await listen<string>('model:cancelled', ({ payload: modelId }) => {
          setProgress((prev) => {
            const next = { ...prev };
            delete next[modelId];
            return next;
          });
          refresh();
        })
      );

      // Download error
      unlisteners.push(
        await listen<ModelError>('model:error', ({ payload }) => {
          setProgress((prev) => {
            const next = { ...prev };
            delete next[payload.modelId];
            return next;
          });
          setErrors((prev) => ({ ...prev, [payload.modelId]: payload.message }));
          refresh();
        })
      );
    };

    setup();
    return () => unlisteners.forEach((fn) => fn());
  }, [refresh]);

  const hasReadyModel = models.some((m) => m.status.type === 'ready');

  return {
    models,
    progress,
    errors,
    loading,
    hasReadyModel,
    downloadModel,
    cancelDownload,
    deleteModel,
    clearError,
    refresh,
  };
}
