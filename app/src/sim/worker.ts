/// <reference lib="webworker" />
// Simulation Web Worker: a thin wrapper that hands protocol messages to SimEngine (./engine.ts).
import { SimEngine, type EngineHost } from './engine';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

// A MessageChannel yields to pending messages without the ~4 ms clamping of nested setTimeout(0).
const channel = new MessageChannel();
const immediate: (() => void)[] = [];
channel.port1.onmessage = () => {
  const fn = immediate.shift();
  fn?.();
};

const host: EngineHost = {
  post(message: FromWorker) {
    self.postMessage(message);
  },
  now: () => performance.now(),
  schedule(fn, delayMs) {
    if (delayMs <= 0) {
      immediate.push(fn);
      channel.port2.postMessage(0);
    } else {
      setTimeout(fn, delayMs);
    }
  },
};

const engine = new SimEngine(host);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  engine.handle(event.data);
};
