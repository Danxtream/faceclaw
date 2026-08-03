import { knownFolders } from "@nativescript/core";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import { TextViewerLayer } from "../../apps/files/text-viewer";
import type { MenuItem } from "../menu";
import { shell } from "../shell/shell";
import {
  anthropicApiKeySetting,
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  openAiApiKeySetting,
  roamApiTokenSetting,
  roamGraphNameSetting,
  enumSettingMenuItem,
  firmwareDebugFlagsSetting,
  lockScreenEnabledSetting,
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
  verticalPositionSetting,
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
        toggleSettingMenuItem(lockScreenEnabledSetting),
        // Where min-height windows (and the sidebar) sit vertically on the
        // screen; the dashboard controller repositions surfaces on change.
        enumSettingMenuItem(verticalPositionSetting),
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
      ],
    },
    {
      label: "Assistant",
      items: [
        // On-phone LLM loop vs the user's own agent via the bridge plugin.
        enumSettingMenuItem(assistantBackendSetting),
        enumSettingMenuItem(assistantModelSetting),
        // When on, a wakeword utterance goes straight to the assistant with no
        // Send/Type menu step.
        toggleSettingMenuItem(assistantSkipConfirmationSetting),
        textSettingMenuItem(assistantBridgeHostSetting),
        textSettingMenuItem(assistantBridgePortSetting),
        textSettingMenuItem(assistantBridgeTokenSetting),
        toggleSettingMenuItem(assistantAllowProactiveSetting),
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
      label: "Roam",
      items: [
        textSettingMenuItem(roamGraphNameSetting),
        textSettingMenuItem(roamApiTokenSetting),
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
      // The version/license blurb (renderDetail) draws above the bundled
      // project docs, in both the preview and the focused states.
      items: [
        bundledDocMenuItem("README.md", "README"),
        bundledDocMenuItem("LICENSE", "License"),
        bundledDocMenuItem("PRIVACY", "Privacy policy"),
      ],
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

/** A row that opens one of the project docs (copied into the bundle under
 * about/ by webpack.config.js) in the paged text viewer. */
function bundledDocMenuItem(fileName: string, label: string): MenuItem {
  return {
    label,
    onSelect: (ctx) => {
      ctx.stack.push(new TextViewerLayer(readBundledDoc(fileName), label));
    },
  };
}

function readBundledDoc(fileName: string): string {
  try {
    const text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync();
    return text || `(${fileName} is missing from this build)`;
  } catch {
    return `(${fileName} is missing from this build)`;
  }
}

function renderAbout(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  const logo = getDashboardLogo();
  if (logo) {
    image.bitBlt(logo, x, y + 4, { transparentZero: true });
  }
  const textX = logo ? x + logo.width + 12 : x;
  image.drawText(font, textX, y + 8, "Faceclaw", 220);
  image.drawText(font, textX, y + 24, "v0.3.0", 170);
  const blurb = "By James Babcock. Distributed under the GNU General Public License, version 3.";
  const blurbY = y + Math.max(64, logo ? logo.height + 12 : 0);
  const blurbLines = wrapText(font, blurb, width);
  for (let i = 0; i < blurbLines.length; i++) {
    image.drawText(font, x, blurbY + i * font.lineHeight, blurbLines[i]!, 170);
  }
  return blurbY - y + blurbLines.length * font.lineHeight + 10;
}
