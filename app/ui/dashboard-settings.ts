import { ApplicationSettings } from "@nativescript/core";
import { getDefaultSmallFont } from "~/graphics/bdffont";
import { wrapText } from "~/graphics/textwrap";
import { drawRightValueMenuItem, drawToggleMenuItem, MenuItem, MenuLayer } from "./menu";
import { DashboardInputEvent, Layer, type LayerContext } from "./layers";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "~/graphics/image";
import { GrayImage } from "~/graphics/image";

export type DashboardSlotId = "bottom-left" | "bottom-right";
export const dashboardSlotIds: DashboardSlotId[] = ["bottom-left", "bottom-right"];
export type DashboardPluginId = "blank" | "input-debug-log" | "music-controller" | "nightscout";

export type DashboardSlotConfig = Record<DashboardSlotId, DashboardPluginId>;
export type NightscoutSettings = {
  siteUrl: string;
  apiToken: string;
};
export type BatteryDisplayMode = "icon" | "percentage";
export type SystemCardSettings = {
  showFaceclawLogo: boolean;
  showBatteryIndicators: boolean;
  batteryDisplayMode: BatteryDisplayMode;
  showAndroidNotifications: boolean;
  showSignalStrength: boolean;
};
export type SystemCardSettingKey = keyof SystemCardSettings;
export type ScreenTimeoutSetting = "15s" | "30s" | "1m" | "never";

type ConfigSettingOptions<TValue, TId extends string> = {
  id: TId;
  label: string;
  storageKey: string;
  defaultValue: TValue;
  formatValue?: (value: TValue) => string;
};

// Fired after any setting's set(); lets phone-side UI that depends on
// settings toggled from the glasses (e.g. the raw-screenshot button) update
// without waiting for an unrelated snapshot emit.
const settingChangeListeners = new Set<() => void>();

export function onAnySettingChanged(listener: () => void): () => void {
  settingChangeListeners.add(listener);
  return () => {
    settingChangeListeners.delete(listener);
  };
}

function notifySettingChanged(): void {
  for (const listener of Array.from(settingChangeListeners)) {
    listener();
  }
}

export abstract class ConfigSetting<TValue, TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  protected readonly storageKey: string;
  protected readonly defaultValue: TValue;
  private readonly valueFormatter: (value: TValue) => string;

  protected constructor(options: ConfigSettingOptions<TValue, TId>) {
    this.id = options.id;
    this.label = options.label;
    this.storageKey = options.storageKey;
    this.defaultValue = options.defaultValue;
    this.valueFormatter = options.formatValue ?? ((value) => String(value));
  }

  abstract get(): TValue;
  abstract set(value: TValue): TValue;

  displayValue(value?: TValue): string {
    const displayValue = arguments.length > 0 ? value as TValue : this.get();
    return this.valueFormatter(displayValue);
  }
}

export class ConfigSettingBoolean<TId extends string = string> extends ConfigSetting<boolean, TId> {
  constructor(options: ConfigSettingOptions<boolean, TId>) {
    super(options);
  }

  get(): boolean {
    return ApplicationSettings.getBoolean(this.storageKey, this.defaultValue);
  }

  set(value: boolean): boolean {
    ApplicationSettings.setBoolean(this.storageKey, value);
    notifySettingChanged();
    return value;
  }

  toggle(value = this.get()): boolean {
    return this.set(!value);
  }
}

type ConfigSettingEnumOptions<TValue extends string, TId extends string> = ConfigSettingOptions<TValue, TId> & {
  values: readonly TValue[];
  normalize?: (value: string | null | undefined) => TValue;
};

export class ConfigSettingEnum<TValue extends string, TId extends string = string> extends ConfigSetting<TValue, TId> {
  readonly values: readonly TValue[];
  private readonly normalizer: (value: string | null | undefined) => TValue;

  constructor(options: ConfigSettingEnumOptions<TValue, TId>) {
    super(options);
    this.values = options.values;
    if (options.normalize) {
      this.normalizer = (value: string | null | undefined) => {
        const normalized = options.normalize(value) as TValue|undefined;
        if (normalized === undefined) return this.defaultValue;
        return normalized;
      }
    } else {
      this.normalizer = (value) => this.values.includes(value as TValue) ? value as TValue : this.defaultValue;
    }
  }

  get(): TValue {
    return this.normalizer(ApplicationSettings.getString(this.storageKey, this.defaultValue));
  }

  set(value: TValue): TValue {
    const normalized = this.normalizer(value);
    ApplicationSettings.setString(this.storageKey, normalized);
    notifySettingChanged();
    return normalized;
  }

  next(value = this.get()): TValue {
    const index = this.values.indexOf(value);
    return this.values[(index + 1) % this.values.length] ?? this.defaultValue;
  }
}

type ConfigSettingStringOptions<TId extends string> = ConfigSettingOptions<string, TId> & {
  editorTitle?: string;
  glassesEditTitle?: string;
  normalize?: (value: string | null | undefined) => string;
};

export class ConfigSettingString<TId extends string = string> extends ConfigSetting<string, TId> {
  readonly editorTitle: string;
  readonly glassesEditTitle: string;
  private readonly normalizer: (value: string | null | undefined) => string;

  constructor(options: ConfigSettingStringOptions<TId>) {
    super(options);
    this.editorTitle = options.editorTitle ?? options.label;
    this.glassesEditTitle = options.glassesEditTitle ?? `Edit ${options.label}`;
    this.normalizer = options.normalize ?? ((value) => value ?? "");
  }

  get(): string {
    return this.normalizer(ApplicationSettings.getString(this.storageKey, this.defaultValue));
  }

  set(value: string): string {
    const normalized = this.normalizer(value);
    ApplicationSettings.setString(this.storageKey, normalized);
    notifySettingChanged();
    return normalized;
  }
}


const KNOWN_PLUGIN_IDS = new Set<DashboardPluginId>([
  "blank",
  "input-debug-log",
  "music-controller",
  "nightscout",
]);


export const bottomLeftSlotSetting = new ConfigSettingEnum<DashboardPluginId>({
  id: "bottom-left-slot",
  label: "Bottom left slot",
  storageKey: "dashboard.slot.bottomLeft",
  defaultValue: "blank",
  values: Array.from(KNOWN_PLUGIN_IDS),
});

export const bottomRightSlotSetting = new ConfigSettingEnum<DashboardPluginId>({
  id: "bottom-right-slot",
  label: "Bottom right slot",
  storageKey: "dashboard.slot.bottomRight",
  defaultValue: "blank",
  values: Array.from(KNOWN_PLUGIN_IDS),
});

export const dashboardSlotSettings: Record<DashboardSlotId, ConfigSettingEnum<DashboardPluginId>> = {
  "bottom-left": bottomLeftSlotSetting,
  "bottom-right": bottomRightSlotSetting,
};

export const systemCardNameSetting = new ConfigSettingString({
  id: "dashboard-name",
  label: "Dashboard name",
  storageKey: "dashboard.systemCardName",
  defaultValue: "Faceclaw",
  editorTitle: "Dashboard name",
  glassesEditTitle: "Edit dashboard name",
  normalize: normalizeSystemCardName,
  formatValue: (value) => value || "Faceclaw",
});

export const showFaceclawLogoSetting = new ConfigSettingBoolean({
  id: "showFaceclawLogo",
  label: "Show Faceclaw Logo",
  storageKey: "dashboard.systemCard.showFaceclawLogo",
  defaultValue: true,
});

export const showBatteryIndicatorsSetting = new ConfigSettingBoolean({
  id: "showBatteryIndicators",
  label: "Show Battery Indicators",
  storageKey: "dashboard.systemCard.showBatteryIndicators",
  defaultValue: true,
});

export const batteryDisplayModeSetting = new ConfigSettingEnum<BatteryDisplayMode>({
  id: "batteryDisplayMode",
  label: "Battery display",
  storageKey: "dashboard.systemCard.batteryDisplayMode",
  defaultValue: "icon",
  values: ["icon", "percentage"],
  formatValue: batteryDisplayModeLabel,
});

export const showAndroidNotificationsSetting = new ConfigSettingBoolean({
  id: "showAndroidNotifications",
  label: "Show Android Notifications",
  storageKey: "dashboard.systemCard.showAndroidNotifications",
  defaultValue: true,
});

export const showSignalStrengthSetting = new ConfigSettingBoolean({
  id: "showSignalStrength",
  label: "Show Signal Strength",
  storageKey: "dashboard.systemCard.showSignalStrength",
  defaultValue: true,
});

export const screenTimeoutSetting = new ConfigSettingEnum<ScreenTimeoutSetting>({
  id: "screen-timeout",
  label: "Screen timeout",
  storageKey: "display.screenTimeout",
  defaultValue: "30s",
  values: ["15s", "30s", "1m", "never"],
  formatValue: screenTimeoutLabel,
});

export const voiceControlEnabledSetting = new ConfigSettingBoolean({
  id: "voice-control-enabled",
  label: "Enable",
  storageKey: "voice.enabled",
  defaultValue: false,
});

export const rawScreenshotsEnabledSetting = new ConfigSettingBoolean({
  id: "raw-screenshots-enabled",
  label: "Take raw screenshots",
  storageKey: "developer.rawScreenshots",
  defaultValue: false,
});

export type VoiceProvider = "onboard" | "elevenlabs";

export const voiceProviderSetting = new ConfigSettingEnum<VoiceProvider>({
  id: "voice-provider",
  label: "Provider",
  storageKey: "voice.provider",
  defaultValue: "onboard",
  values: ["onboard", "elevenlabs"],
  formatValue: (value) => (value === "elevenlabs" ? "ElevenLabs" : "On-device"),
});

export const elevenLabsApiKeySetting = new ConfigSettingString({
  id: "elevenlabs-api-key",
  label: "ElevenLabs key",
  storageKey: "voice.elevenLabsApiKey",
  defaultValue: "",
  editorTitle: "ElevenLabs API key",
  glassesEditTitle: "Edit ElevenLabs key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
});

export const terminalHostSetting = new ConfigSettingString({
  id: "terminal-host",
  label: "Host",
  storageKey: "terminal.host",
  defaultValue: "",
  editorTitle: "g2mirror host (tailscale IP)",
  glassesEditTitle: "Edit terminal host",
});

export const terminalPortSetting = new ConfigSettingString({
  id: "terminal-port",
  label: "Port",
  storageKey: "terminal.port",
  defaultValue: "8737",
  editorTitle: "g2mirror port",
  glassesEditTitle: "Edit terminal port",
});

export const terminalAuthTokenSetting = new ConfigSettingString({
  id: "terminal-auth-token",
  label: "Auth token",
  storageKey: "terminal.authToken",
  defaultValue: "",
  editorTitle: "g2mirror auth token",
  glassesEditTitle: "Edit terminal auth token",
});

export const nightscoutSiteUrlSetting = new ConfigSettingString({
  id: "nightscout-site-url",
  label: "Nightscout site URL",
  storageKey: "integrations.nightscout.siteUrl",
  defaultValue: "",
  editorTitle: "Nightscout site URL",
  glassesEditTitle: "Edit Nightscout URL",
  normalize: normalizeNightscoutSiteUrl,
  formatValue: emptySettingDisplay,
});

export const nightscoutApiTokenSetting = new ConfigSettingString({
  id: "nightscout-api-token",
  label: "Nightscout API token",
  storageKey: "integrations.nightscout.apiToken",
  defaultValue: "",
  editorTitle: "Nightscout API token",
  glassesEditTitle: "Edit API token",
  normalize: normalizeNightscoutApiToken,
  formatValue: maskToken,
});


export function screenTimeoutSettingToMs(value: ScreenTimeoutSetting): number | null {
  switch (value) {
    case "15s":
      return 15_000;
    case "30s":
      return 30_000;
    case "1m":
      return 60_000;
    case "never":
      return null;
  }
}

export function screenTimeoutLabel(value: ScreenTimeoutSetting): string {
  return value === "never" ? "Never" : value;
}

export function batteryDisplayModeLabel(value: BatteryDisplayMode): string {
  return value === "icon" ? "Icon" : "Percentage";
}

export function loadNightscoutSettings(): NightscoutSettings {
  return {
    siteUrl: nightscoutSiteUrlSetting.get(),
    apiToken: nightscoutApiTokenSetting.get(),
  };
}

export function isNightscoutSettingsConfigured(): boolean {
  return nightscoutSiteUrlSetting.get().length > 0 && nightscoutApiTokenSetting.get().length > 0;
}

export function normalizePluginId(
  value: string | null | undefined,
  fallback: DashboardPluginId = "blank",
): DashboardPluginId {
  if (value && KNOWN_PLUGIN_IDS.has(value as DashboardPluginId)) {
    return value as DashboardPluginId;
  }
  return fallback;
}

function normalizeSystemCardName(name: string | null | undefined): string {
  const normalized = (name ?? "").replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized;
}

function normalizeNightscoutSiteUrl(siteUrl: string | null | undefined): string {
  return (siteUrl ?? "").replace(/[\x00-\x1f]+/g, "").trim().replace(/\/+$/, "");
}

function normalizeNightscoutApiToken(apiToken: string | null | undefined): string {
  return (apiToken ?? "").replace(/[\x00-\x1f]+/g, "").trim();
}

function emptySettingDisplay(value: string): string {
  return value || "(empty)";
}

function maskToken(token: string): string {
  if (!token) return "(empty)";
  return token.length <= 6 ? "******" : `${token.slice(0, 2)}...${token.slice(-4)}`;
}


type SettingsMenuOptions<T> = {
  style?: "cycle"|"submenu"
  onChange?: (ctx: LayerContext, newValue: T, oldValue: T) => void
}

export function enumSettingMenuItem<TValue extends string, TId extends string = string>(
  setting: ConfigSettingEnum<TValue, TId>,
  opts?: SettingsMenuOptions<TValue>
): MenuItem {
  const style = opts?.style ?? "cycle";
  return {
    label: setting.label,
      onSelect: (ctx) => {
        if (style === "cycle") {
        const oldValue = setting.get();
          const newValue = setting.next(oldValue);
          setting.set(newValue);
          opts?.onChange?.(ctx, newValue, oldValue);
        } else {
          const submenu = new MenuLayer(setting.label, setting.values.map((value) => ({
            label: value,
            onSelect: () => {
              setting.set(value);
              opts?.onChange?.(ctx, value, setting.get());
              ctx.stack.pop();
            },
            render: ({ image, x, y }) => {
              const selected = setting.get() === value ? " *" : "";
              image.drawText(getDefaultSmallFont(), x, y + 3, `${value}${selected}`, 200);
            }
          })));
          ctx.stack.push(submenu);
        }
      },
      render: ({ image, x, y, width }) => {
        drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, setting.label, setting.displayValue(setting.get()));
      },
  };
}

export function toggleSettingMenuItem<TId extends string = string>(
  setting: ConfigSettingBoolean<TId>,
   opts?: SettingsMenuOptions<boolean>
): MenuItem {
  return {
    label: setting.label,
    onSelect: (ctx) => {
      setting.set(!setting.get());
      opts?.onChange?.(ctx, setting.get(), !setting.get());
    },
    render: ({ image, x, y, width, selected }) => {
      drawToggleMenuItem(image, getDefaultSmallFont(), x, y, width, setting.label, setting.get(), selected);
    },
  };
}

export function textSettingMenuItem<TId extends string = string>(
  setting: ConfigSettingString<TId>,
  opts?: SettingsMenuOptions<string>
): MenuItem {
  return {
    label: setting.label,
    onSelect: (ctx: LayerContext) => {
      void ctx.actions.startTextSettingEdit(setting);
      ctx.stack.push(new EditTextSettingLayer(setting));
    },
    render: ({ image, x, y }) => {
      // displayValue honors the setting's formatValue, so secrets (API keys,
      // tokens) can mask themselves instead of rendering in the clear.
      image.drawText(getDefaultSmallFont(), x, y + 3, `${setting.label}: ${truncateSetting(setting.displayValue())}`, 200);
    }
  };
}

function truncateSetting(value: string, maxLength = 22): string {
  const text = value || "(empty)";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export class EditTextSettingLayer implements Layer {
  constructor(private readonly setting: ConfigSettingString) {}

  paint(): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(font, 22, 16, this.setting.glassesEditTitle, 220);
    const message = wrapText(font, "Look at the phone app to type a value.", G2_LENS_WIDTH - 48);
    for (let index = 0; index < message.length; index++) {
      image.drawText(font, 22, 52 + index * 14, message[index]!, 200);
    }
    image.drawText(font, 22, 110, truncateSetting(this.setting.get(), 52), 220);
    image.drawText(font, 22, 252, "Double-click to go back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.endTextSettingEdit();
      ctx.stack.pop();
    }
  }
}
