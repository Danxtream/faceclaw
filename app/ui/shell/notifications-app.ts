import { GrayImage } from "../../graphics/image";
import { LayerActions } from "../layers";
import { NotificationsListLayer } from "../notifications";
import { createInProcessWindow, YieldAtRootLayer, type InProcessWindow } from "./in-process-window";

export const NOTIFICATIONS_WINDOW_ID = "notifications";
export const NOTIFICATIONS_SURFACE_ID = "window:notifications";

export type NotificationsAppOptions = {
  actions: LayerActions;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  onClosed: () => void;
};

/**
 * The Notifications app: the Android-notification list (previously a
 * dashboard page) in its own in-process window; selecting a notification
 * opens the detail view with its quick actions.
 */
export function createNotificationsAppWindow(options: NotificationsAppOptions): InProcessWindow {
  return createInProcessWindow({
    appId: "notifications",
    windowId: NOTIFICATIONS_WINDOW_ID,
    title: "Notifications",
    iconLetter: "N",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NotificationsListLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}
