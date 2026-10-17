import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
// Fraunces (SIL OFL), all axes: the wordmark and display headings (brand only;
// the UI stays IBM Plex).
import '@fontsource-variable/fraunces/full.css';
import './styles/global.scss';

// The WebView's own context menu (Reload, Inspect Element…) isn't the app's.
// Keep it only where it does something: in text fields and over selected
// text (Copy). Wave's menus call preventDefault themselves.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.closest('input, textarea, [contenteditable="true"]')) return;
  if (!(window.getSelection()?.isCollapsed ?? true)) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
