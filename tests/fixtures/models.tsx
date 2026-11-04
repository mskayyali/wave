import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@carbon/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { useSettings } from '../../src/hooks/useSettings';
import type { ModelInfo } from '../../src/hooks/useModels';
import { MODEL_CATALOG, PARAKEET_MODEL_ID, readyTranscriptionModels, type ModelBundle } from '../../src/lib/modelCatalog';
import '../../src/styles/global.scss';

mockWindows('main');
mockIPC((command, args) => {
  if (command === 'get_settings') return JSON.parse(localStorage.getItem('fixture.settings') ?? '{"selectedModelId":"large-v3-turbo"}');
  if (command === 'set_settings') localStorage.setItem('fixture.settings', JSON.stringify(args.settings));
  if (command === 'agent_status') return { enabled: false, command: 'wave' };
  return null;
});
function Fixture() {
  const { settings, setSelectedModel, loading } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>(() => MODEL_CATALOG.map(meta => ({ id: meta.id, filename: '',
    status: meta.id === PARAKEET_MODEL_ID && !localStorage.getItem('fixture.parakeet') ? { type: 'notDownloaded' } : { type: 'ready', sizeBytes: meta.sizeMb * 1024 * 1024 } })));
  const update = (id: string, ready: boolean) => {
    if (id === PARAKEET_MODEL_ID) { if (ready) localStorage.setItem('fixture.parakeet', 'ready'); else localStorage.removeItem('fixture.parakeet'); }
    setModels(all => all.map(m => m.id === id ? { ...m, status: ready ? { type: 'ready', sizeBytes: 713975456 } : { type: 'notDownloaded' } } : m));
  };
  useEffect(() => {
    if (loading) return;
    const ready = readyTranscriptionModels(models);
    if (!ready.some(m => m.id === settings.selectedModelId)) void setSelectedModel(ready[0]?.id ?? null);
  }, [models, loading, settings.selectedModelId, setSelectedModel]);
  const bundle = (b: ModelBundle, ready: boolean) => b.parts.forEach(p => update(p.modelId, ready));
  return <Theme theme="g100" className="wave-theme-root"><SettingsPage models={models} loading={loading}
    selectedModelId={settings.selectedModelId} onSelectModel={setSelectedModel} progress={{}} errors={{}}
    onDownload={id => update(id, true)} onDelete={id => update(id, false)} onCancel={() => {}} onRetry={() => {}}
    onDownloadBundle={b => bundle(b, true)} onDeleteBundle={b => bundle(b, false)} onCancelBundle={() => {}} onRetryBundle={() => {}} /></Theme>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
