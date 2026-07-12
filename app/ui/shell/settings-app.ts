import { GrayImage } from "../../graphics/image";
import { LayerActions } from "../layers";
import { EditTextSettingLayer } from "../dashboard-settings";
import { createSettingsPanelLayer } from "../dashboard/settings-menus";
import { createInProcessWindow } from "./in-process-window";
import { type ShellWindow } from "./shell";

export const SETTINGS_WINDOW_ID = "settings";
export const SETTINGS_SURFACE_ID = "window:settings";

export type SettingsAppOptions = {
  actions: LayerActions;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  onClosed: () => void;
};

export type SettingsAppWindow = {
  window: ShellWindow;
  requestRender: () => void;
  /** Whether the glasses-side text-setting editor is the top layer. */
  isTextEditorOnTop: () => boolean;
  /** Pop the text-setting editor if it is on top; returns whether it was. */
  closeTextEditor: () => boolean;
};

/**
 * The Settings app: the settings menu tree (previously a dashboard submenu)
 * hosted in its own in-process window. In-process because the text-setting
 * editor is synchronized with the phone-side TextField through the
 * controller, which lives on the main thread.
 */
export function createSettingsAppWindow(options: SettingsAppOptions): SettingsAppWindow {
  const { window, stack, requestRender } = createInProcessWindow({
    appId: "settings",
    windowId: SETTINGS_WINDOW_ID,
    title: "Settings",
    iconLetter: "Se",
    icon: "settings",
    closeable: true,
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the panel routes double-click itself
    // (right column -> left column, then left column -> sidebar).
    baseLayer: createSettingsPanelLayer(),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  return {
    window,
    requestRender,
    isTextEditorOnTop: () => stack.topMatches((layer) => layer instanceof EditTextSettingLayer),
    closeTextEditor: () => stack.popIfTop((layer) => layer instanceof EditTextSettingLayer),
  };
}
