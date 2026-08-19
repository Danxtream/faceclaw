import { GrayImage } from "../../graphics/image";
import { LayerActions } from "../../ui/layers";
import { EditTextSettingLayer } from "../../ui/dashboard-settings";
import { createSettingsPanelLayer } from "../../ui/dashboard/settings-menus";
import { createInProcessWindow, type InProcessWindow } from "../../ui/shell/in-process-window";
import { type ShellWindow } from "../../ui/shell/shell";
import type { AppDefinition } from "../app-definition";

export const SETTINGS_WINDOW_ID = "settings";
export const SETTINGS_SURFACE_ID = "window:settings";

export type SettingsAppOptions = {
  actions: LayerActions;
  apps: readonly AppDefinition[];
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  onClosed: () => void;
};

export type SettingsAppWindow = {
  window: ShellWindow;
  inProcess: InProcessWindow;
  requestRender: () => void;
  focusSection: (label: string) => void;
  isTextEditorOnTop: () => boolean;
  closeTextEditor: () => boolean;
};

export function createSettingsAppWindow(options: SettingsAppOptions): SettingsAppWindow {
  const panel = createSettingsPanelLayer(options.apps);
  const inProcess = createInProcessWindow({
    appId: "settings",
    windowId: SETTINGS_WINDOW_ID,
    title: "Settings",
    iconLetter: "Se",
    icon: "settings",
    closeable: true,
    actions: options.actions,
    baseLayer: panel,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  const { window, stack, requestRender } = inProcess;
  return {
    window,
    inProcess,
    requestRender,
    focusSection: (label) => {
      panel.focusSection(label);
      requestRender();
    },
    isTextEditorOnTop: () => stack.topMatches((layer) => layer instanceof EditTextSettingLayer),
    closeTextEditor: () => stack.popIfTop((layer) => layer instanceof EditTextSettingLayer),
  };
}
