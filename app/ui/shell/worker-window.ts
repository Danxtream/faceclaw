import { GrayImage } from "../../graphics/image";
import { windowIcon } from "./chrome-layer";
import { type IconName } from "../../graphics/icons";
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
  | { type: "input"; windowId: string; event: unknown; frameId: number; focused: boolean }
  | { type: "text-input"; windowId: string; text: string }
  | { type: "render"; windowId: string; focused: boolean }
  | { type: "foreground"; windowId: string; foreground: boolean; focused: boolean }
  | { type: "screen"; on: boolean };

export type WorkerAppReply =
  | { type: "yield-focus"; windowId: string }
  | {
      /** Foreground and focus one of the app's existing windows. */
      type: "focus-window";
      windowId: string;
    }
  | {
      /** App-initiated window (e.g. a terminal view opened from the hub list). */
      type: "open-window-request";
      windowId: string;
      title: string;
      iconLetter: string;
      icon?: IconName;
      focus?: boolean;
    }
  | { type: "set-title"; windowId: string; title: string }
  | { type: "set-attention"; windowId: string; attention: boolean }
  | {
      /**
       * Set or clear the app's top-bar tray icon. Pixels ride the JSON
       * postMessage roundtrip — acceptable because tray icons are small and
       * infrequently updated.
       */
      type: "set-tray-icon";
      icon: { width: number; height: number; pixels: number[] } | null;
    };

export type WorkerWindowSpec = {
  /** Unique across the shell; namespace with the appId (e.g. "terminal:view:3"). */
  windowId: string;
  title: string;
  iconLetter: string;
  /** Lucide icon name for the sidebar indicator; falls back to iconLetter. */
  icon?: IconName;
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
        case "focus-window":
          if (this.openWindows.has(message.windowId)) {
            shell.focusWindow(message.windowId);
            this.options.requestShellRender();
          }
          break;
        case "open-window-request":
          this.openWindow({
            windowId: message.windowId,
            title: message.title,
            iconLetter: message.iconLetter,
            icon: message.icon,
            focus: message.focus,
          });
          break;
        case "set-attention":
          shell.setWindowAttention(message.windowId, message.attention);
          break;
        case "set-tray-icon": {
          let icon: GrayImage | null = null;
          if (message.icon) {
            icon = new GrayImage(message.icon.width, message.icon.height, 0);
            icon.pixels.set(message.icon.pixels.slice(0, icon.pixels.length));
          }
          shell.setTrayIcon(this.options.appId, icon);
          break;
        }
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
      drawIcon: windowIcon(spec.icon, spec.iconLetter),
      handleInput: (event, frameId) => {
        this.post({
          type: "input",
          windowId: spec.windowId,
          event,
          frameId,
          focused: shell.isWindowFocused(spec.windowId),
        });
      },
      requestRender: () => {
        this.post({ type: "render", windowId: spec.windowId, focused: shell.isWindowFocused(spec.windowId) });
      },
      receiveTextInput: (text) => {
        this.post({ type: "text-input", windowId: spec.windowId, text });
      },
      setForeground: (foreground) => {
        this.options.setSurfaceVisible(surfaceId, foreground);
        if (foreground) {
          shell.setWindowAttention(spec.windowId, false);
        }
        this.post({
          type: "foreground",
          windowId: spec.windowId,
          foreground,
          focused: shell.isWindowFocused(spec.windowId),
        });
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
