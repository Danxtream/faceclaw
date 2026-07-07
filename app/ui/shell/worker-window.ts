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

export type WorkerAppReply =
  | { type: "yield-focus"; windowId: string }
  | {
      /** App-initiated window (e.g. a terminal view opened from the hub list). */
      type: "open-window-request";
      windowId: string;
      title: string;
      iconLetter: string;
      focus?: boolean;
    }
  | { type: "set-title"; windowId: string; title: string }
  | { type: "set-attention"; windowId: string; attention: boolean };

export type WorkerWindowSpec = {
  /** Unique across the shell; namespace with the appId (e.g. "terminal:view:3"). */
  windowId: string;
  title: string;
  iconLetter: string;
  /** Foreground and focus the window once its surface exists. */
  focus?: boolean;
};

export type WorkerAppHostOptions = {
  appId: string;
  worker: Worker;
  viewport: { width: number; height: number };
  /** Create/refresh a window surface on the compositor (no-op when disconnected). */
  configureSurface: (surfaceId: string, visible: boolean) => Promise<void>;
  setSurfaceVisible: (surfaceId: string, visible: boolean) => void;
  removeSurface: (surfaceId: string) => void;
  requestShellRender: () => void;
};

/**
 * Owns the Worker for one app and adapts its windows to the shell's window
 * interface: forwards input and lifecycle over postMessage, relays worker
 * requests (yield-focus, new windows, attention flags) back to the shell,
 * and manages compositor surfaces for the app's windows. The worker submits
 * frames straight to the Java compositor, so no pixels cross this boundary.
 */
export class WorkerAppHost {
  private readonly openWindows = new Set<string>();

  constructor(private readonly options: WorkerAppHostOptions) {
    options.worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerAppReply | undefined;
      if (!message) return;
      switch (message.type) {
        case "yield-focus":
          // Only the focused window's yield is meaningful.
          if (shell.foregroundWindow()?.windowId === message.windowId) {
            shell.yieldFocusToSidebar();
          }
          break;
        case "open-window-request":
          this.openWindow({
            windowId: message.windowId,
            title: message.title,
            iconLetter: message.iconLetter,
            focus: message.focus,
          });
          break;
        case "set-attention":
          shell.setWindowAttention(message.windowId, message.attention);
          break;
        case "set-title":
          // Titles are informational for now (sidebar shows icons only).
          break;
      }
    };
    options.worker.onerror = (error) => {
      console.error(`worker app ${options.appId} error: ${JSON.stringify(error)}`);
    };
  }

  windowCount(): number {
    return this.openWindows.size;
  }

  /** Open a window of this app and register it with the shell. */
  openWindow(spec: WorkerWindowSpec): ShellWindow {
    const surfaceId = `window:${spec.windowId}`;
    this.openWindows.add(spec.windowId);
    this.post({
      type: "open-window",
      windowId: spec.windowId,
      surfaceId,
      viewport: this.options.viewport,
    });
    const window: ShellWindow = {
      appId: this.options.appId,
      windowId: spec.windowId,
      title: spec.title,
      surfaceId,
      closeable: true,
      close: () => {
        this.openWindows.delete(spec.windowId);
        this.post({ type: "close-window", windowId: spec.windowId });
        this.options.removeSurface(surfaceId);
      },
      drawIcon: makeLetterWindowIcon(spec.iconLetter),
      handleInput: (event, frameId) => {
        this.post({ type: "input", windowId: spec.windowId, event, frameId });
      },
      requestRender: () => {
        this.post({ type: "render", windowId: spec.windowId });
      },
      setForeground: (foreground) => {
        this.options.setSurfaceVisible(surfaceId, foreground);
        if (foreground) {
          shell.setWindowAttention(spec.windowId, false);
        }
        this.post({ type: "foreground", windowId: spec.windowId, foreground });
      },
      setScreenOn: (on) => {
        // Screen state is per-app, but sending per-window keeps the protocol
        // uniform; the worker treats it globally.
        this.post({ type: "screen", on });
      },
    };
    shell.registerWindow(window);
    // Configure the surface before any foregrounding so the worker's first
    // frame has somewhere to land.
    void this.options
      .configureSurface(surfaceId, false)
      .then(() => {
        if (spec.focus) {
          shell.focusWindow(spec.windowId);
        }
        this.options.requestShellRender();
      })
      .catch((error) => {
        console.error(`surface setup for ${spec.windowId} failed: ${error}`);
      });
    return window;
  }

  private post(message: WorkerAppMessage): void {
    this.options.worker.postMessage(message);
  }
}
