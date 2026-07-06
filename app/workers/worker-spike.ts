/**
 * Worker spike: spawn the echo worker, do one round trip, log the results.
 * Temporary scaffolding for the app-shell architecture work; exercises the
 * webpack worker chunk, bidirectional postMessage, and worker Java access.
 * Results appear in logcat prefixed with "worker-spike:".
 */
declare const java: any;

export function runWorkerSpike(): void {
  const mainJavaThreadName = String(java.lang.Thread.currentThread().getName());
  console.log(`worker-spike: spawning echo worker (main thread=${mainJavaThreadName})`);

  let worker: Worker;
  try {
    worker = new Worker("./echo.worker");
  } catch (error) {
    console.error(`worker-spike: failed to spawn worker: ${error}`);
    return;
  }

  const sentAtMs = Date.now();
  worker.onmessage = (event: MessageEvent) => {
    const roundTripMs = Date.now() - sentAtMs;
    console.log(
      `worker-spike: reply received in ${roundTripMs}ms: ${JSON.stringify(event.data)}`,
    );
    worker.terminate();
    console.log("worker-spike: worker terminated, spike complete");
  };
  worker.onerror = (error) => {
    console.error(`worker-spike: worker error: ${JSON.stringify(error)}`);
    worker.terminate();
  };

  worker.postMessage({ type: "ping", sentAtMs, payload: "hello from main" });
}
