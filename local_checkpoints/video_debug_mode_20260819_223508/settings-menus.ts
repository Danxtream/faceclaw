import { knownFolders } from "@nativescript/core";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import { TextViewerLayer } from "../../apps/files/text-viewer";
import type { AppDefinition } from "../../apps/app-definition";
import { LauncherOrderLayer } from "../../apps/launcher/launcher-order-layer";
import {
  isLauncherAppVisible,
  setLauncherAppVisible,
} from "../../apps/launcher/launcher-preferences";
import {
  videoPlaybackFpsSetting,
  videoScaleSetting,
} from "../../apps/video/video-settings";
import { drawToggleMenuItem, type MenuItem } from "../menu";
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
  sonioxApiKeySetting,
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
export function createSettingsPanelLayer(apps: readonly AppDefinition[] = []): SettingsPanelLayer {
  return new SettingsPanelLayer(settingsSections(apps));
}

function launcherVisibilityItem(app: AppDefinition): MenuItem {
  return {
    label: app.title,
    description: `Show or hide ${app.title} on the main Apps screen. Closing or hiding an app does not erase that app's saved state.`,
    onSelect: (ctx) => {
      setLauncherAppVisible(app.appId, !isLauncherAppVisible(app.appId));
      ctx.actions.requestRender();
    },
    render: ({ image, x, y, width, selected }) => {
      drawToggleMenuItem(
        image,
        getDefaultSmallFont(),
        x,
        y,
        width,
        app.title,
        isLauncherAppVisible(app.appId),
        selected,
      );
    },
  };
}

function settingsSections(apps: readonly AppDefinition[]): SettingsSection[] {
  const launcherApps = apps.filter(
    (app) => app.showInLauncher !== false && app.appId !== "settings",
  );

  return [
    {
      label: "Display",
      items: [
        enumSettingMenuItem(brightnessSetting),
        enumSettingMenuItem(screenTimeoutSetting, {
          onChange: () => {
            shell.noteUserActivity();
          },
        }),
        toggleSettingMenuItem(lockScreenEnabledSetting),
        enumSettingMenuItem(verticalPositionSetting),
        enumSettingMenuItem(batteryDisplayModeSetting),
        enumSettingMenuItem(timeFormatSetting),
        enumSettingMenuItem(uiFontSetting),
      ],
    },
    {
      label: "Video",
      items: [
        enumSettingMenuItem(videoPlaybackFpsSetting),
        enumSettingMenuItem(videoScaleSetting),
      ],
    },
    {
      label: "Apps",
      items: [
        {
          label: "Reorder apps",
          description:
            "Choose the order of visible apps on the main Apps screen. Tap an app to enter move mode, scroll it up or down, then tap again to finish.",
          onSelect: (ctx) => {
            ctx.stack.push(new LauncherOrderLayer(apps));
          },
        },
        ...launcherApps.map(launcherVisibilityItem),
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
        enumSettingMenuItem(assistantBackendSetting),
        enumSettingMenuItem(assistantModelSetting),
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
        textSettingMenuItem(sonioxApiKeySetting),
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
          label: "Close all apps",
          description:
            "Close every closeable app window except Settings. Saved app state, including the last video and playback position, is kept.",
          onSelect: (ctx) => {
            shell.closeAllCloseableWindows(["settings"]);
            ctx.actions.requestRender();
          },
        },
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
  if (logo) image.bitBlt(logo, x, y + 4, { transparentZero: true });
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
