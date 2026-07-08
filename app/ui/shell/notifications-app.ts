import { NotificationsListLayer } from "../notifications";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";

export const NOTIFICATIONS_WINDOW_ID = "notifications";
export const NOTIFICATIONS_SURFACE_ID = "window:notifications";

/**
 * The Notifications app: the Android-notification list (previously a
 * dashboard page) in its own in-process window; selecting a notification
 * opens the detail view with its quick actions.
 */
export function createNotificationsAppWindow(options: InProcessAppOptions): InProcessWindow {
  return createInProcessWindow({
    appId: "notifications",
    windowId: NOTIFICATIONS_WINDOW_ID,
    title: "Notifications",
    iconLetter: "N",
    icon: "bell",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NotificationsListLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}
