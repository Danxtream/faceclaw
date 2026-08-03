import { shell } from "../../ui/shell/shell";
import { type AppDefinition } from "../app-definition";
import {
  createSettingsAppWindow,
  SETTINGS_SURFACE_ID,
  SETTINGS_WINDOW_ID,
  type SettingsAppWindow,
} from "./settings-app";

// The Settings app is a singleton; tracked so a relaunch with a section
// deep-link can focus that section in the open window.
let activeSettingsApp: SettingsAppWindow | null = null;

const settingsApp: AppDefinition = {
  appId: "settings",
  title: "Settings",
  icon: "settings",
  launch: async (ctx, params) => {
    if (activeSettingsApp) {
      if (params?.section) activeSettingsApp.focusSection(params.section);
      shell.focusWindow(SETTINGS_WINDOW_ID);
      ctx.requestShellRender();
      return;
    }
    await ctx.launchInProcessApp(SETTINGS_WINDOW_ID, SETTINGS_SURFACE_ID, (options) => {
      const app = createSettingsAppWindow({
        ...options,
        onClosed: () => {
          // Closing mid-edit must not leave the phone-side editor dangling.
          void options.actions.endTextSettingEdit();
          ctx.setTextEditorHost(null);
          activeSettingsApp = null;
          options.onClosed();
        },
      });
      activeSettingsApp = app;
      // The controller echoes phone-side edits into the glasses editor.
      ctx.setTextEditorHost(app);
      return app.inProcess;
    });
    if (params?.section) activeSettingsApp?.focusSection(params.section);
  },
};

export default settingsApp;
