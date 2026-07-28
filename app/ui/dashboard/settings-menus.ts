import { getDefaultSmallFont } from "../../graphics/bdffont";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { shell } from "../shell/shell";
import {
  anthropicApiKeySetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  openAiApiKeySetting,
  enumSettingMenuItem,
  firmwareDebugFlagsSetting,
  saveVoiceRecordingsSetting,
  suspendEvenHubWhenScreenOffSetting,
  terminalAuthTokenSetting,
  terminalHostSetting,
  terminalLaunchPresetsSetting,
  terminalPortSetting,
  terminalWakeOnBellSetting,
  textSettingMenuItem,
  timeFormatSetting,
  toggleSettingMenuItem,
  uiFontSetting,
  voiceProviderSetting,
  screenTimeoutSetting,
  wakeWordActionSetting,
} from "../dashboard-settings";
import { SettingsPanelLayer, type SettingsSection } from "./settings-panel";

/** The Settings app's master-detail panel (sections on the left, contents on the right). */
export function createSettingsPanelLayer(): SettingsPanelLayer {
  return new SettingsPanelLayer(settingsSections());
}

function settingsSections(): SettingsSection[] {
  return [
    {
      label: "Display",
      items: [
        // Auto (ambient sensor) or an exact level; pushed to the glasses by
        // the dashboard controller when changed and on each connect.
        enumSettingMenuItem(brightnessSetting),
        enumSettingMenuItem(screenTimeoutSetting, {
          onChange: () => {
            shell.noteUserActivity();
          },
        }),
        // Controls the top-bar battery indicators (icon vs percentage).
        enumSettingMenuItem(batteryDisplayModeSetting),
        // Controls the top-bar clock (24-hour vs 12-hour).
        enumSettingMenuItem(timeFormatSetting),
        // Selects the UI body typeface (Terminus vs proportional TerminusV).
        enumSettingMenuItem(uiFontSetting),
      ],
    },
    {
      label: "Voice",
      items: [
        enumSettingMenuItem(wakeWordActionSetting),
        enumSettingMenuItem(voiceProviderSetting),
        enumSettingMenuItem(assistantModelSetting),
        // When on, a wakeword utterance goes straight to the assistant with no
        // Send/Type menu step.
        toggleSettingMenuItem(assistantSkipConfirmationSetting),
      ],
    },
    {
      label: "API Keys",
      items: [
        textSettingMenuItem(elevenLabsApiKeySetting),
        textSettingMenuItem(openAiApiKeySetting),
        textSettingMenuItem(anthropicApiKeySetting),
        textSettingMenuItem(mapboxApiKeySetting),
      ],
    },
    {
      label: "Terminal",
      items: [
        textSettingMenuItem(terminalHostSetting),
        textSettingMenuItem(terminalPortSetting),
        textSettingMenuItem(terminalAuthTokenSetting),
        textSettingMenuItem(terminalLaunchPresetsSetting),
        toggleSettingMenuItem(terminalWakeOnBellSetting),
      ],
    },
    {
      label: "Developer",
      items: [
        toggleSettingMenuItem(saveVoiceRecordingsSetting),
        toggleSettingMenuItem(firmwareDebugFlagsSetting),
        toggleSettingMenuItem(suspendEvenHubWhenScreenOffSetting),
      ],
    },
    {
      label: "About",
      items: [],
      renderDetail: renderAbout,
    },
    {
      label: "Quit",
      items: [
        {
          label: "Disconnect from glasses",
          description: "Close the Bluetooth connection to the glasses and return them to standby.",
          onSelect: async (ctx) => {
            ctx.stack.clearToBase();
            await ctx.actions.disconnect();
          },
        },
      ],
    },
  ];
}

function renderAbout(args: { image: GrayImage; x: number; y: number; width: number }): void {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  const logo = getDashboardLogo();
  if (logo) {
    image.bitBlt(logo, x, y + 4, { transparentZero: true });
  }
  const textX = logo ? x + logo.width + 12 : x;
  image.drawText(font, textX, y + 8, "Faceclaw", 220);
  image.drawText(font, textX, y + 24, "v0.2.0", 170);
  image.drawTextWrapped({
    font,
    x,
    y: y + 64,
    width,
    text: "By James Babcock. Distributed under the GNU General Public License, version 3.",
    value: 170,
  });
}
