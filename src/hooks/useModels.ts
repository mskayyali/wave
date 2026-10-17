import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ALIGNER_MODEL_ID, DPDFNET_MODEL_ID, SPEAKER_MODEL_ID, TRANSCRIPTION_BUNDLE,
  type ModelBundle,
} from '../lib/modelCatalog';

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

  // ── Bundles: download the parts one after another ───────────────────────────
  // Per bundle id (two can download at once): `active` is the part downloading
  // now and `rest` the parts after it. The 'model:complete' listener starts the
  // next part; an error or cancel of the active part ends the sequence. Refs,
  // so the listeners always see the latest.
  const bundleRunsRef    = useRef(new Map<string, { active: string; rest: string[] }>());
  const modelsRef        = useRef(models);
  modelsRef.current      = models;
  const downloadModelRef = useRef(downloadModel);
  downloadModelRef.current = downloadModel;

  const startNextBundlePart = useCallback((bundleId: string, parts: string[]) => {
    const [next, ...rest] = parts;
    if (next) bundleRunsRef.current.set(bundleId, { active: next, rest });
    else bundleRunsRef.current.delete(bundleId);
    if (next) void downloadModelRef.current(next);
  }, []);

  /** End whichever bundle sequence is waiting on `modelId`. */
  const endBundleRunOf = useCallback((modelId: string) => {
    for (const [id, run] of bundleRunsRef.current) {
      if (run.active === modelId) bundleRunsRef.current.delete(id);
    }
  }, []);

  /** Download every part of a bundle that isn't ready yet, in order. */
  const downloadBundle = useCallback((bundle: ModelBundle) => {
    const missing = bundle.parts
      .map((p) => p.modelId)
      .filter((id) => modelsRef.current.find((m) => m.id === id)?.status.type !== 'ready');
    startNextBundlePart(bundle.id, missing);
  }, [startNextBundlePart]);

  /** Stop the bundle's download (parts already finished stay). */
  const cancelBundle = useCallback(async (bundle: ModelBundle) => {
    bundleRunsRef.current.delete(bundle.id);
    for (const p of bundle.parts) {
      if (modelsRef.current.find((m) => m.id === p.modelId)?.status.type === 'downloading') {
        await cancelDownload(p.modelId);
      }
    }
  }, [cancelDownload]);

  /** Delete every downloaded (or partly downloaded) part of a bundle. */
  const deleteBundle = useCallback(async (bundle: ModelBundle) => {
    bundleRunsRef.current.delete(bundle.id);
    for (const p of bundle.parts) {
      const status = modelsRef.current.find((m) => m.id === p.modelId)?.status.type;
      if (status === 'ready' || status === 'partial') await deleteModel(p.modelId);
    }
  }, [deleteModel]);

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
          // Part of a bundle: start the next part.
          for (const [id, run] of bundleRunsRef.current) {
            if (run.active === modelId) { startNextBundlePart(id, run.rest); break; }
          }
        })
      );

      // Download cancelled — keep partial state in the list
      unlisteners.push(
        await listen<string>('model:cancelled', ({ payload: modelId }) => {
          endBundleRunOf(modelId);
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
          endBundleRunOf(payload.modelId);
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
  }, [refresh, startNextBundlePart, endBundleRunOf]);

  // Projects need the whole Transcription bundle: Whisper *and* the aligner.
  const isReady = (id: string) => models.some((m) => m.id === id && m.status.type === 'ready');
  const hasReadyModel = TRANSCRIPTION_BUNDLE.parts.every((p) => isReady(p.modelId));
  const alignerReady     = isReady(ALIGNER_MODEL_ID);
  const speakerModelReady = isReady(SPEAKER_MODEL_ID);
  /** Which speech-enhancement models are downloaded: the clean-up, DPDFNet. */
  const enhanceModels    = { dpdfnet: isReady(DPDFNET_MODEL_ID) };

  return {
    models,
    progress,
    errors,
    loading,
    hasReadyModel,
    alignerReady,
    speakerModelReady,
    enhanceModels,
    downloadModel,
    cancelDownload,
    deleteModel,
    downloadBundle,
    cancelBundle,
    deleteBundle,
    clearError,
    refresh,
  };
}
