import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { announceRendererReady, installHost } from './host/install';
import { connectSimulation } from './sim/client';
import { appStore } from './state/store';
import './styles.css';

// Inside the Mac app: native file dialogs, menu-bar commands, window chrome (no-op in the browser).
installHost();

// One simulation worker for the whole app, connected to the store before the first render.
connectSimulation();

// Development aid: the live store from the browser console (window.__picStudio.getState()).
if (import.meta.env.DEV) (window as unknown as { __picStudio: typeof appStore }).__picStudio = appStore;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
announceRendererReady();
