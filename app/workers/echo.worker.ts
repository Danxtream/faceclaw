/**
 * Trivial echo worker: spike scaffolding for the app-shell architecture.
 * Validates that worker chunks build under @nativescript/webpack, that
 * message passing works in both directions, and that a worker isolate can
 * call Java APIs directly.
 */
import "@nativescript/core/globals";

declare const global: any;
declare const java: any;

global.onmessage = (event: { data: any }) => {
  // Direct Java call from the worker isolate: this runs on the worker's own
  // JVM-attached thread, not the main thread.
  const javaThreadName = String(java.lang.Thread.currentThread().getName());
  global.postMessage({
    type: "pong",
    echoed: event.data,
    workerJavaThreadName: javaThreadName,
    workerReceivedAtMs: Date.now(),
  });
};
