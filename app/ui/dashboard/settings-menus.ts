import { APP_VIEWPORT } from "../shell/geometry";
import { type MenuLayout } from "../menu";

// Settings menus render in both the dashboard window (full lens) and the
// Settings app window (viewport-sized); cap heights to the smaller of the two.
const SETTINGS_MENU_LAYOUT: MenuLayout = { x: 8, y: 8, width: 272, maxHeight: APP_VIEWPORT.height - 16 };
import { shell } from "../shell/shell";
import { batteryDisplayModeSetting, dashboardSlotIds, elevenLabsApiKeySetting, enumSettingMenuItem, firmwareDebugFlagsSetting, rawScreenshotsEnabledSetting, saveVoiceRecordingsSetting, showSignalStrengthSetting, showAndroidNotificationsSetting, showBatteryIndicatorsSetting, showFaceclawLogoSetting, systemCardNameSetting, terminalAuthTokenSetting, terminalHostSetting, terminalPortSetting, textSettingMenuItem, toggleSettingMenuItem, voiceProviderSetting, dashboardSlotSettings, nightscoutSiteUrlSetting, nightscoutApiTokenSetting, screenTimeoutSetting } from "../dashboard-settings";
import { MenuLayer } from "../menu";
import { AboutPage } from "./about-page";

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
        label: "Dashboard",
        onSelect: (ctx) => {
          ctx.stack.push(createDashboardSettingsMenuLayer());
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
        onChange: (ctx, newValue, oldValue) => {
          shell.noteUserActivity();
        },
      }),
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

function createDashboardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Dashboard",
    [
      {
        label: "System Card",
        onSelect: (ctx) => {
          ctx.stack.push(createSystemCardSettingsMenuLayer());
        },
      },
      ...dashboardSlotIds.map((slot) => enumSettingMenuItem(dashboardSlotSettings[slot], {
        style: "submenu",
      })),
    ],
    SETTINGS_MENU_LAYOUT,
  );
}

function createSystemCardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Dashboard > System Card",
    [
      textSettingMenuItem(systemCardNameSetting),
      toggleSettingMenuItem(showFaceclawLogoSetting),
      toggleSettingMenuItem(showBatteryIndicatorsSetting),
      enumSettingMenuItem(batteryDisplayModeSetting),
      toggleSettingMenuItem(showAndroidNotificationsSetting),
      toggleSettingMenuItem(showSignalStrengthSetting),
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