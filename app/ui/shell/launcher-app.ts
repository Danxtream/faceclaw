import { GrayImage } from "../../graphics/image";
import { LayerActions } from "../layers";
import { MenuLayer } from "../menu";
import { APP_VIEWPORT } from "./geometry";
import { createInProcessWindow, YieldAtRootLayer } from "./in-process-window";
import { type ShellWindow } from "./shell";

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

/**
 * The launcher: a pinned, uncloseable in-process window listing launchable
 * apps. Selecting an app asks the controller to launch it (new window,
 * possibly in an existing app worker) and foregrounds the new window.
 */
export function createLauncherWindow(options: LauncherOptions): ShellWindow {
  const menu = new MenuLayer(
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
  return createInProcessWindow({
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    iconLetter: "A",
    icon: "layout-grid",
    closeable: false,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(menu),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  }).window;
}
