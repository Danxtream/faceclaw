import { APP_VIEWPORT } from "../shell/geometry";
import { MenuLayer, type MenuLayout } from "../menu";
import { shell } from "../shell/shell";
import { batteryDisplayModeSetting, elevenLabsApiKeySetting, enumSettingMenuItem, firmwareDebugFlagsSetting, rawScreenshotsEnabledSetting, saveVoiceRecordingsSetting, terminalAuthTokenSetting, terminalHostSetting, terminalPortSetting, textSettingMenuItem, toggleSettingMenuItem, voiceProviderSetting, nightscoutSiteUrlSetting, nightscoutApiTokenSetting, screenTimeoutSetting } from "../dashboard-settings";
import { AboutPage } from "./about-page";

// Rendered in the Settings app window (viewport-sized); cap height to it.
const SETTINGS_MENU_LAYOUT: MenuLayout = { x: 8, y: 8, width: 272, maxHeight: APP_VIEWPORT.height - 16 };

export function createSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings",
    [
      {
        label: "Display",
        onSelect: (ctx) => {
          ctx.stack.push(createDisplaySettingsMenuLayer());
        },
      },
      {
        label: "Voice",
        onSelect: (ctx) => {
          ctx.stack.push(createVoiceSettingsMenuLayer());
        },
      },
      {
        label: "Integrations",
        onSelect: (ctx) => {
          ctx.stack.push(createIntegrationsMenuLayer());
        },
      },
      {
        label: "Terminal",
        onSelect: (ctx) => {
          ctx.stack.push(createTerminalSettingsMenuLayer());
        },
      },
      {
        label: "Developer",
        onSelect: (ctx) => {
          ctx.stack.push(createDeveloperSettingsMenuLayer());
        },
      },
      {
        label: "About",
        onSelect: (ctx) => {
          ctx.stack.push(new AboutPage());
        },
      },
      {
        label: "Quit / Disconnect",
        onSelect: async (ctx) => {
          ctx.stack.clearToBase();
          await ctx.actions.disconnect();
        },
      },
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createTerminalSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Terminal",
    [
      textSettingMenuItem(terminalHostSetting),
      textSettingMenuItem(terminalPortSetting),
      textSettingMenuItem(terminalAuthTokenSetting),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createDeveloperSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Developer",
    [
      toggleSettingMenuItem(rawScreenshotsEnabledSetting),
      toggleSettingMenuItem(saveVoiceRecordingsSetting),
      toggleSettingMenuItem(firmwareDebugFlagsSetting),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createDisplaySettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Display",
    [
      enumSettingMenuItem(screenTimeoutSetting, {
        onChange: () => {
          shell.noteUserActivity();
        },
      }),
      // Controls the top-bar battery indicators (icon vs percentage).
      enumSettingMenuItem(batteryDisplayModeSetting),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createVoiceSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Voice",
    [
      enumSettingMenuItem(voiceProviderSetting),
      textSettingMenuItem(elevenLabsApiKeySetting),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createIntegrationsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Integrations",
    [
      {
        label: "Nightscout",
        onSelect: (ctx) => {
          ctx.stack.push(createNightscoutSettingsMenuLayer());
        },
      },
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

export function createNightscoutSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Integrations > Nightscout",
    [
      textSettingMenuItem(nightscoutSiteUrlSetting),
      textSettingMenuItem(nightscoutApiTokenSetting),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}