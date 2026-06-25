import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ─── Types mirroring Rust structs ─────────────────────────────────────────────

export interface AppSettings {
  selectedModelId: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>({ selectedModelId: null });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<AppSettings>('get_settings');
      setSettingsState(s);
    } catch (e) {
      console.error('get_settings failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const setSelectedModel = useCallback(async (modelId: string | null) => {
    const next: AppSettings = { selectedModelId: modelId };
    try {
      await invoke('set_settings', { settings: next });
      setSettingsState(next);
    } catch (e) {
      console.error('set_settings failed:', e);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { settings, loading, setSelectedModel, refresh };
}
