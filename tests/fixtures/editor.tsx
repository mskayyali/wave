// Standalone editor fixture. All native calls and media are isolated from user projects.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@carbon/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { EditorPage } from '../../src/pages/EditorPage';
import { openEditor } from '../../src/lib/agent';
import '../../src/styles/global.scss';

const demo = new URLSearchParams(location.search).has('demo');
const demoText = `So, um, I think the best conversations happen when you give people a little room to think. You don't have to fill every silence. Sometimes the pause is where the interesting part begins. When we started recording this series, we tried to plan everything. Every question had a follow-up, every minute had a purpose. But the moments we kept coming back to were the ones we hadn't planned at all. A guest would remember something, or change their mind halfway through a sentence, and suddenly we were somewhere new. That's the part I want to keep in the edit. The feeling that two people are figuring something out together. We can take out the interruptions and the long search for a word. We can make the listening easier. But I still want it to sound like a conversation, with enough space to hear the person behind the story. I suppose that is what makes a recording worth returning to.`.split(/\s+/);
const project = { id: 'editor-regression', name: demo ? 'Room for a conversation' : 'Editor regression', createdAt: 0, durationSecs: 85, status: { type: 'ready' as const } };
const words = Array.from({ length: demo ? demoText.length : 160 }, (_, i) => ({ text: demo ? demoText[i] : `word${i}`, startMs: 1000 + i * 500, endMs: 1300 + i * 500, confidence: 1 }));
const samples = 85 * 16000;
const wav = new ArrayBuffer(44 + samples * 2), v = new DataView(wav);
const tag = (offset: number, text: string) => [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
tag(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples * 2, true);
for (let i = 0; i < samples; i++) v.setInt16(44 + 2 * i, Math.sin(i * 0.05) * (demo ? 5500 * Math.pow(Math.abs(Math.sin(i / 16000 * 8.7)), 2) * (0.3 + 0.7 * Math.abs(Math.sin(i / 16000 * 1.3))) : 2000), true);
const audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
mockWindows('main');
mockIPC((command, args) => {
  if (command === 'get_transcript') return { words, language: 'en', durationMs: 85000 };
  if (command === 'get_waveform') throw new Error('Fixture exercises decode fallback');
  if (command === 'get_playback_audio_path') return audioUrl;
  if (command === 'load_edits') return localStorage.getItem('fixture.edits');
  if (command === 'save_edits') { localStorage.setItem('fixture.edits', (args as {data: string}).data); return; }
  return null;
}, { shouldMockEvents: true });
(window as any).__TAURI_INTERNALS__.convertFileSrc = (path: string) => path;
(window as any).editorApi = () => openEditor(project.id);
function Fixture() {
  const [open, setOpen] = React.useState(true);
  return <Theme theme="g100" className="wave-theme-root">{open ? <EditorPage project={project} alignerReady={false}
    enhanceModels={{ dpdfnet: false }} speakerModelReady={false} onBack={() => setOpen(false)} onRetry={() => {}} />
    : <button onClick={() => setOpen(true)}>Reopen project</button>}</Theme>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
