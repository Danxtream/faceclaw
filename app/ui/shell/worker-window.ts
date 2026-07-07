import { makeLetterWindowIcon } from "./chrome-layer";
import { shell, type ShellWindow } from "./shell";

/**
 * Messages between the shell (main thread) and an app worker. One worker
 * hosts one app, which may have several windows; messages are routed by
 * windowId. Everything crossing this boundary is small JSON; pixels go
 * worker→Java directly.
 */
export type WorkerAppMessage =
  | { type: "open-window"; windowId: string; surfaceId: string; viewport: { width: number; height: number } }
  | { type: "close-window"; windowId: string }
  | { type: "input"; windowId: string; event: unknown; frameId: number }
  | { type: "render"; windowId: string }
  | { type: "foreground"; windowId: string; foreground: boolean }
  | { type: "screen"; on: boolean };

export type WorkerAppReply = { type: "yield-focus"; windowId: string };

export type WorkerWindowOptions = {
  windowId: string;
  title: string;
  iconLetter: string;
  surfaceId: string;
  viewport: { width: number; height: number };
  /** Flip the window's compositor surface visibility. */
  setSurfaceVisible: (visible: boolean) => void;
  /** Remove the window's compositor surface (on close). */
  removeSurface: () => void;
};

/**
 * Owns the Worker for one app and adapts its windows to the shell's window
 * interface: forwards input and lifecycle over postMessage, relays
 * yield-focus back to the shell, and tells the worker when windows open and
 * close. The worker submits frames straight to the Java compositor, so no
 * pixels cross this boundary.
 */
export class WorkerAppHost {
  private readonly openWindows = new Set<string>();

  constructor(
    private readonly appId: string,
    private readonly worker: Worker,
  ) {
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerAppReply | undefined;
      if (message?.type === "yield-focus") {
        // Only the focused window's yield is meaningful.
        if (shell.foregroundWindow()?.windowId === message.windowId) {
          shell.yieldFocusToSidebar();
        }
      }
    };
    worker.onerror = (error) => {
      console.error(`worker app ${appId} error: ${JSON.stringify(error)}`);
    };
  }

  windowCount(): number {
    return this.openWindows.size;
  }

  openWindow(options: WorkerWindowOptions): ShellWindow {
    this.openWindows.add(options.windowId);
    this.post({
      type: "open-window",
      windowId: options.windowId,
      surfaceId: options.surfaceId,
      viewport: options.viewport,
    });
    return {
      appId: this.appId,
      windowId: options.windowId,
      title: options.title,
      surfaceId: options.surfaceId,
      closeable: true,
      close: () => {
        this.openWindows.delete(options.windowId);
        this.post({ type: "close-window", windowId: options.windowId });
        options.removeSurface();
      },
      drawIcon: makeLetterWindowIcon(options.iconLetter),
      handleInput: (event, frameId) => {
        this.post({ type: "input", windowId: options.windowId, event, frameId });
      },
      requestRender: () => {
        this.post({ type: "render", windowId: options.windowId });
      },
      setForeground: (foreground) => {
        options.setSurfaceVisible(foreground);
        this.post({ type: "foreground", windowId: options.windowId, foreground });
      },
      setScreenOn: (on) => {
        // Screen state is per-app, but sending per-window keeps the protocol
        // uniform; the worker treats it globally.
        this.post({ type: "screen", on });
      },
    };
  }

  private post(message: WorkerAppMessage): void {
    this.worker.postMessage(message);
  }
}
