/**
 * Stopwatch app, hosted in its own worker thread. One worker serves every
 * stopwatch window; per-window state is keyed by windowId. The shell (main
 * thread) sends open/close/input/lifecycle messages over postMessage; frames
 * are painted here and submitted directly to the Java compositor from this
 * worker's own thread — no pixels cross the isolate boundary.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../graphics/image";
import { getDefaultSmallFont, getFont } from "../graphics/bdffont";
import * as frameTimings from "../native/frame-timings";
import type { DashboardInputEvent } from "../ui/layers";
import type { WorkerAppMessage } from "../ui/shell/worker-window";

declare const global: any;
declare const com: any;

const RENDER_INTERVAL_MS = 100;

const stopwatchFont = getFont("terminus32");
const smallFont = getDefaultSmallFont();

type StopwatchWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  // Accumulated time survives pausing, backgrounding, and screen-off; only
  // rendering pauses.
  accumulatedMs: number;
  runningSinceMs: number | null;
  renderTimer: ReturnType<typeof setInterval> | null;
  lastSubmittedFingerprint: string;
};

const windows = new Map<string, StopwatchWindow>();
let screenOn = true;

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window":
      windows.set(message.windowId, {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        accumulatedMs: 0,
        runningSinceMs: null,
        renderTimer: null,
        lastSubmittedFingerprint: "",
      });
      break;
    case "close-window": {
      const window = windows.get(message.windowId);
      if (window?.renderTimer) clearInterval(window.renderTimer);
      windows.delete(message.windowId);
      break;
    }
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown stopwatch window");
        break;
      }
      handleInput(window, message.event as DashboardInputEvent, message.frameId);
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (window) renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      updateRenderTimer(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        updateRenderTimer(window);
      }
      break;
  }
};

function handleInput(window: StopwatchWindow, event: DashboardInputEvent, frameId: number): void {
  if (event.type === "double-click") {
    // Back out of the app root: return focus to the shell sidebar. State keeps
    // running; the frame is finished here since no repaint happens.
    frameTimings.finishFrame(frameId, "discarded: stopwatch yielded focus");
    global.postMessage({ type: "yield-focus", windowId: window.windowId });
    return;
  }
  if (event.type === "click") {
    if (window.runningSinceMs === null) {
      window.runningSinceMs = Date.now();
    } else {
      window.accumulatedMs += Date.now() - window.runningSinceMs;
      window.runningSinceMs = null;
    }
    updateRenderTimer(window);
    renderAndSubmit(window, frameId);
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: stopwatch ignored input");
}

function updateRenderTimer(window: StopwatchWindow): void {
  const shouldRun = window.runningSinceMs !== null && window.foreground && screenOn;
  if (shouldRun && window.renderTimer === null) {
    window.renderTimer = setInterval(() => renderAndSubmit(window, 0), RENDER_INTERVAL_MS);
  } else if (!shouldRun && window.renderTimer !== null) {
    clearInterval(window.renderTimer);
    window.renderTimer = null;
  }
}

function elapsedMs(window: StopwatchWindow): number {
  const runningMs = window.runningSinceMs === null ? 0 : Date.now() - window.runningSinceMs;
  return window.accumulatedMs + runningMs;
}

function paint(window: StopwatchWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  const elapsed = elapsedMs(window);
  const timeLabel = formatStopwatchElapsed(elapsed);
  const stateLabel = window.runningSinceMs === null ? (elapsed > 0 ? "Paused" : "Ready") : "Running";

  image.drawText(smallFont, 24, 16, "Stopwatch", 180);
  const timeX = Math.max(0, Math.round((window.viewportWidth - stopwatchFont.measureText(timeLabel)) / 2));
  const timeY = Math.max(0, Math.round((window.viewportHeight / 2 - stopwatchFont.lineHeight) / 2) + 20);
  image.drawText(stopwatchFont, timeX, timeY, timeLabel, 245);

  const hintsY = window.viewportHeight - 66;
  image.drawText(smallFont, 90, hintsY, stateLabel, 150);
  image.drawText(smallFont, 90, hintsY + 18, "Click: start / pause", 150);
  image.drawText(smallFont, 90, hintsY + 36, "Double-click: back to sidebar", 150);
  return image;
}

function renderAndSubmit(window: StopwatchWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const image = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = image.fingerprint();
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: stopwatch content unchanged");
      return;
    }
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active communicator");
      return;
    }
    const buffer = image.to8bppBuffer();
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, `discarded: stopwatch render failed`);
    console.error(`stopwatch worker render failed: ${error}`);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatStopwatchElapsed(totalMs: number): string {
  const totalTenths = Math.floor(totalMs / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}
