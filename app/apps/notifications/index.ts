import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../../native/notification-access";
import { type AppDefinition } from "../app-definition";
import { createNotificationsAppWindow, NOTIFICATIONS_SURFACE_ID, NOTIFICATIONS_WINDOW_ID } from "./notifications-app";

const notificationsApp: AppDefinition = {
  appId: "notifications",
  title: "Notifications",
  icon: "bell",
  launch: (ctx) => {
    // Without notification-listener access the tray reads as empty; prompt
    // the user on the phone so the on-glasses "grant permission" message is
    // actionable. The app still opens to show that message.
    if (!isNotificationListenerEnabled()) {
      requestNotificationListenerAccess();
    }
    return ctx.launchInProcessApp(NOTIFICATIONS_WINDOW_ID, NOTIFICATIONS_SURFACE_ID, createNotificationsAppWindow);
  },
};

export default notificationsApp;
