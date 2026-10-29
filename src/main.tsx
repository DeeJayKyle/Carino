import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { startSync } from './lib/sync';

const render = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The phone app runs Carino's server inside itself; start it before the first API call.
if (import.meta.env.VITE_MOBILE) {
  import('../mobile/engine').then((m) => m.engineReady).then(render, (err) => {
    document.getElementById('root')!.textContent = `Carino could not start: ${err?.message ?? err}`;
  });
} else render();

// Register the service worker in production builds (offline shell + push notifications).
if ('serviceWorker' in navigator && import.meta.env.PROD && !import.meta.env.VITE_MOBILE) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('Service worker registration failed', err));
  });
}

// Replay task/note changes made offline once the connection returns.
startSync();
