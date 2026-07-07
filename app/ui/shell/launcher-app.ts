import { GrayImage } from "../../graphics/image";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack } from "../layers";
import { MenuLayer } from "../menu";
import { makeLetterWindowIcon } from "./chrome-layer";
import { APP_VIEWPORT } from "./geometry";
import { shell, type ShellWindow } from "./shell";

export type LauncherAppEntry = {
  appId: string;
  label: string;
};

export type LauncherOptions = {
  actions: LayerActions;
  apps: LauncherAppEntry[];
  launchApp: (appId: string) => Promise<void> | void;
  /** Submit a painted viewport-sized frame to this window's surface. */
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  /** Flip the launcher's compositor surface visibility on foreground changes. */
  setSurfaceVisible: (visible: boolean) => void;
};

export const LAUNCHER_WINDOW_ID = "launcher";
export const LAUNCHER_SURFACE_ID = "window:launcher";

/** The launcher's root menu; backing out of it yields to the sidebar. */
class LauncherMenuLayer extends MenuLayer {
  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      shell.yieldFocusToSidebar();
      return;
    }
    await super.handleInput(event, ctx);
  }
}

/**
 * The launcher: a pinned, uncloseable in-process window listing launchable
 * apps. Selecting an app asks the controller to launch it (new window,
 * possibly in an existing app worker) and foregrounds the new window.
 */
export function createLauncherWindow(options: LauncherOptions): ShellWindow {
  const baseLayer: Layer = new LauncherMenuLayer(
    "Apps",
    options.apps.map((app) => ({
      label: app.label,
      onSelect: async () => {
        await options.launchApp(app.appId);
      },
    })),
    {
      x: 8,
      y: 8,
      width: 272,
      minHeight: 0,
      maxHeight: APP_VIEWPORT.height - 16,
    },
  );
  const stack = new LayerStack(baseLayer, options.actions, {
    width: APP_VIEWPORT.width,
    height: APP_VIEWPORT.height,
  });

  async function render(frameId: number): Promise<void> {
    const paintStartedAtMs = Date.now();
    const image = stack.paint();
    await options.submitFrame(image, Date.now() - paintStartedAtMs, frameId);
  }

  return {
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    surfaceId: LAUNCHER_SURFACE_ID,
    closeable: false,
    drawIcon: makeLetterWindowIcon("A"),
    handleInput: async (event, frameId) => {
      await stack.handleInput(event);
      // Java-side dedup finishes no-change frames, so an unconditional
      // resubmit keeps frame ownership simple.
      await render(frameId);
    },
    requestRender: () => {
      void render(0).catch((error) => {
        console.error(`launcher render failed: ${error}`);
      });
    },
    setForeground: (foreground) => {
      options.setSurfaceVisible(foreground);
    },
  };
}
