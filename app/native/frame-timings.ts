/**
 * TS-side wrapper for the Java FrameTimings singleton (per-frame latency
 * instrumentation; see FrameTimings.java). Frame ID 0 means "no frame" and is
 * ignored by every method, so callers never need to null-check.
 *
 * Because the JS side is single-threaded, this module also tracks a "current
 * frame" so that leaf drawing/IO code can record spans without threading a
 * frame ID through every call signature.
 */

declare const com: any;
declare const global: any;

let javaInstance: any = null;
let javaUnavailable = false;
// Fallback IDs when the Java class is unavailable (e.g. unit tests): negative
// so they can never collide with real Java-issued frame IDs.
let fallbackNextFrameId = -1;
let currentFrameId = 0;

function getJava(): any {
  if (javaInstance === null && !javaUnavailable) {
    try {
      if (typeof com !== "undefined" && global.isAndroid) {
        javaInstance = com.faceclaw.app.FrameTimings.getInstance();
      } else {
        javaUnavailable = true;
      }
    } catch {
      javaUnavailable = true;
    }
  }
  return javaInstance;
}

export function startFrame(reason: string): number {
  const java = getJava();
  if (!java) return fallbackNextFrameId--;
  return Number(java.startFrame(reason));
}

export function logFrame(frameId: number, message: string): void {
  if (frameId <= 0) return;
  getJava()?.log(frameId, message);
}

export function spanStart(frameId: number, name: string): void {
  if (frameId <= 0) return;
  getJava()?.spanStart(frameId, name);
}

export function spanEnd(frameId: number, name: string): void {
  if (frameId <= 0) return;
  getJava()?.spanEnd(frameId, name);
}

export function finishFrame(frameId: number, outcome: string): void {
  if (frameId <= 0) return;
  getJava()?.finishFrame(frameId, outcome);
}

export function span<T>(frameId: number, name: string, fn: () => T): T {
  spanStart(frameId, name);
  try {
    return fn();
  } finally {
    spanEnd(frameId, name);
  }
}

/** Set the current frame while running fn, for leaf code using the *Current helpers. */
export function runWithFrame<T>(frameId: number, fn: () => T): T {
  const previous = currentFrameId;
  currentFrameId = frameId;
  try {
    return fn();
  } finally {
    currentFrameId = previous;
  }
}

export function currentFrame(): number {
  return currentFrameId;
}

export function logCurrent(message: string): void {
  logFrame(currentFrameId, message);
}

export function spanCurrent<T>(name: string, fn: () => T): T {
  return span(currentFrameId, name, fn);
}
