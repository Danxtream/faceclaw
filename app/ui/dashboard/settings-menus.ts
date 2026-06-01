import { dashboardState, TOP_LEFT_MENU_LAYOUT } from "../dashboard";
import { dashboardSlotIds, enumSettingMenuItem, estimateCompressionRatiosSetting, showSignalStrengthSetting, showAndroidNotificationsSetting, showBatteryIndicatorsSetting, showFaceclawLogoSetting, systemCardNameSetting, textSettingMenuItem, toggleSettingMenuItem, voiceControlEnabledSetting, wakeModeSetting, dashboardSlotSettings, nightscoutSiteUrlSetting, nightscoutApiTokenSetting, screenTimeoutSetting } from "../dashboard-settings";
import { MenuLayer } from "../menu";

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
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createDisplaySettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Display",
    [
      enumSettingMenuItem(screenTimeoutSetting, {
        onChange: (ctx, newValue, oldValue) => {
          dashboardState.lastInputAtMs = Date.now();
        },
      }),
      enumSettingMenuItem(wakeModeSetting),
      toggleSettingMenuItem(estimateCompressionRatiosSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createVoiceSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Voice",
    [
      toggleSettingMenuItem(voiceControlEnabledSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
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
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createSystemCardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Dashboard > System Card",
    [
      textSettingMenuItem(systemCardNameSetting),
      toggleSettingMenuItem(showFaceclawLogoSetting),
      toggleSettingMenuItem(showBatteryIndicatorsSetting),
      toggleSettingMenuItem(showAndroidNotificationsSetting),
      toggleSettingMenuItem(showSignalStrengthSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
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
    TOP_LEFT_MENU_LAYOUT,
  );
}

export function createNightscoutSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Integrations > Nightscout",
    [
      textSettingMenuItem(nightscoutSiteUrlSetting),
      textSettingMenuItem(nightscoutApiTokenSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}