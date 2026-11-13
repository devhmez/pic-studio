// UI side of the simulation worker: starts ./worker.ts and connects it to the app store.
import { appStore, type AppStoreApi, type SimDriver } from '../state/store';
import type { FromWorker, ToWorker } from './protocol';

export interface SimClient extends SimDriver {
  post(message: ToWorker): void;
  /** Terminate the worker. */
  dispose(): void;
}

/** Start the simulation worker; `onMessage` receives everything it posts. */
export function createSimClient(onMessage: (message: FromWorker) => void): SimClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'pic-studio-sim' });
  worker.onmessage = (event: MessageEvent<FromWorker>) => onMessage(event.data);
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    onMessage({ type: 'error', message: `Le simulateur s’est arrêté : ${event.message || 'erreur inconnue'}` });
  };
  worker.onmessageerror = () => onMessage({ type: 'error', message: 'Message illisible reçu du simulateur.' });
  return {
    post: (message) => worker.postMessage(message),
    dispose: () => worker.terminate(),
  };
}

/**
 * Start the worker and wire it to the store (snapshots, breakpoints and errors flow into `sim`).
 * Returns a function that disconnects and terminates it. Without Web Worker support the store reports the
 * simulator as unavailable when the student presses ▶.
 */
export function connectSimulation(store: AppStoreApi = appStore): () => void {
  if (typeof Worker === 'undefined') return () => {};
  const client = createSimClient((message) => store.receive(message));
  store.attachSim(client);
  return () => {
    store.attachSim(null);
    client.dispose();
  };
}
