import { GESTURE_DOUBLE_CLICK } from "./gestures";
import {
  getBooleanSetting,
  getStringSetting,
  onSettingsStoreChanged,
  setBooleanSetting,
  setStringSetting,
} from "~/native/settings-store";
import {
  getDefaultSmallFont,
  UI_FONT_SETTING_KEY,
  UI_FONT_VALUES,
  type UiFontChoice,
} from "~/graphics/bdffont";
import { wrapText } from "~/graphics/textwrap";
import {
  ASSISTANT_MODEL_VALUES,
  assistantModelLabel,
  assistantModelProvider,
  type AssistantModel,
} from "~/assistant/models";
import { drawRightValueMenuItem, drawToggleMenuItem, MenuItem, openModalMenu } from "./menu";
import { DashboardInputEvent, Layer, type LayerContext } from "./layers";
import { GrayImage } from "~/graphics/image";

export type NightscoutSettings = {
  siteUrl: string;
  apiToken: string;
};
export type BatteryDisplayMode = "icon" | "percentage";
export type TimeFormat = "24h" | "12h";
export type ScreenTimeoutSetting = "15s" | "30s" | "1m" | "3m" | "never";
// "auto" lets the glasses' ambient-light sensor drive brightness; the numeric
// values are exact levels on the firmware's 0-100 scale (nonlinear: ~30 is
// dim-but-readable indoors, ~60 is bright outdoors).
export const BRIGHTNESS_VALUES = ["auto", "0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"] as const;
export type BrightnessSetting = (typeof BRIGHTNESS_VALUES)[number];
export type WakeWordAction = "voice-input" | "off" | "turn-screen-on";

type ConfigSettingOptions<TValue, TId extends string> = {
  id: TId;
  label: string;
  storageKey: string;
  defaultValue: TValue;
  formatValue?: (value: TValue) => string;
  /** Extended description shown in the Settings panel when the row is selected. */
  description?: string;
};

// Fired after any setting changes, in any isolate (storage lives in the Java
// FaceclawSettings store and broadcasts to every isolate). Lets phone-side UI
// that depends on settings toggled from the glasses (e.g. the text-setting
// editor) update without waiting for an unrelated snapshot emit. Delivery is
// asynchronous: one message-loop tick after the set().
const settingChangeListeners = new Set<() => void>();

export function onAnySettingChanged(listener: () => void): () => void {
  settingChangeListeners.add(listener);
  return () => {
    settingChangeListeners.delete(listener);
  };
}

onSettingsStoreChanged(() => {
  for (const listener of Array.from(settingChangeListeners)) {
    listener();
  }
});

export abstract class ConfigSetting<TValue, TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly description?: string;
  protected readonly storageKey: string;
  protected readonly defaultValue: TValue;
  private readonly valueFormatter: (value: TValue) => string;

  protected constructor(options: ConfigSettingOptions<TValue, TId>) {
    this.id = options.id;
    this.label = options.label;
    this.description = options.description;
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
    return getBooleanSetting(this.storageKey, this.defaultValue);
  }

  set(value: boolean): boolean {
    setBooleanSetting(this.storageKey, value);
    return value;
  }

  toggle(value = this.get()): boolean {
    return this.set(!value);
  }
}

type ConfigSettingEnumOptions<TValue extends string, TId extends string> = ConfigSettingOptions<TValue, TId> & {
  values: readonly TValue[];
  normalize?: (value: string | null | undefined) => TValue;
  /** Dynamic availability check used by enum picker rows. */
  isDisabled?: (value: TValue) => boolean;
};

export class ConfigSettingEnum<TValue extends string, TId extends string = string> extends ConfigSetting<TValue, TId> {
  readonly values: readonly TValue[];
  private readonly normalizer: (value: string | null | undefined) => TValue;
  private readonly disabledPredicate: (value: TValue) => boolean;

  constructor(options: ConfigSettingEnumOptions<TValue, TId>) {
    super(options);
    this.values = options.values;
    this.disabledPredicate = options.isDisabled ?? (() => false);
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
    return this.normalizer(getStringSetting(this.storageKey, this.defaultValue));
  }

  set(value: TValue): TValue {
    const normalized = this.normalizer(value);
    setStringSetting(this.storageKey, normalized);
    return normalized;
  }

  isDisabled(value: TValue): boolean {
    return this.disabledPredicate(value);
  }

  next(value = this.get()): TValue {
    const index = this.values.indexOf(value);
    for (let offset = 1; offset <= this.values.length; offset++) {
      const candidate = this.values[(index + offset) % this.values.length];
      if (candidate !== undefined && !this.isDisabled(candidate)) return candidate;
    }
    return value;
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
    return this.normalizer(getStringSetting(this.storageKey, this.defaultValue));
  }

  set(value: string): string {
    const normalized = this.normalizer(value);
    setStringSetting(this.storageKey, normalized);
    return normalized;
  }
}


export const batteryDisplayModeSetting = new ConfigSettingEnum<BatteryDisplayMode>({
  id: "batteryDisplayMode",
  label: "Battery display",
  storageKey: "dashboard.systemCard.batteryDisplayMode",
  defaultValue: "icon",
  values: ["icon", "percentage"],
  formatValue: batteryDisplayModeLabel,
  description: "How the top bar shows the phone and glasses battery levels: a small gauge icon or an exact percentage.",
});

export const uiFontSetting = new ConfigSettingEnum<UiFontChoice>({
  id: "uiFont",
  label: "Font",
  storageKey: UI_FONT_SETTING_KEY,
  defaultValue: "terminus",
  values: UI_FONT_VALUES,
  formatValue: uiFontLabel,
  description: "Typeface for UI text on the glasses. Terminus is fixed-width; TerminusV is a proportional variant that fits more text per line.",
});

export const timeFormatSetting = new ConfigSettingEnum<TimeFormat>({
  id: "timeFormat",
  label: "Time format",
  storageKey: "display.timeFormat",
  defaultValue: "24h",
  values: ["24h", "12h"],
  formatValue: timeFormatLabel,
  description: "Whether the top-bar clock shows 24-hour or 12-hour time.",
});

export const brightnessSetting = new ConfigSettingEnum<BrightnessSetting>({
  id: "brightness",
  label: "Brightness",
  storageKey: "display.brightness",
  defaultValue: "auto",
  values: BRIGHTNESS_VALUES,
  formatValue: brightnessLabel,
  description: "Display brightness. Auto lets the ambient-light sensor pick the level; numbers set an exact level. After picking Auto, it may take some time to first adjust.",
});

export const screenTimeoutSetting = new ConfigSettingEnum<ScreenTimeoutSetting>({
  id: "screen-timeout",
  label: "Screen timeout",
  storageKey: "display.screenTimeout",
  defaultValue: "30s",
  values: ["15s", "30s", "1m", "3m", "never"],
  formatValue: screenTimeoutLabel,
  description: "How long the display stays on after the last input before turning itself off. \"Never\" keeps it on until turned off manually.",
});

export const lockScreenEnabledSetting = new ConfigSettingBoolean({
  id: "lock-screen-enabled",
  label: "Enable lock screen",
  storageKey: "display.lockScreenEnabled",
  defaultValue: true,
  description:
    "Lock the glasses after they are taken off while the phone is locked. Unlocking the phone unlocks the glasses.",
});

export type VerticalPosition = "top" | "upper" | "middle" | "lower" | "bottom";

const VERTICAL_POSITION_LABELS: Record<VerticalPosition, string> = {
  top: "Top",
  upper: "Upper",
  middle: "Middle",
  lower: "Lower",
  bottom: "Bottom",
};

export const verticalPositionSetting = new ConfigSettingEnum<VerticalPosition>({
  id: "vertical-position",
  label: "Vertical position",
  storageKey: "display.verticalPosition",
  defaultValue: "middle",
  values: ["top", "upper", "middle", "lower", "bottom"],
  formatValue: (value) => VERTICAL_POSITION_LABELS[value] ?? value,
  description:
    "Where standard (reduced-height) windows sit vertically within the display area, to position them within your field of view. Full-height windows such as terminal views always use the whole screen.",
});

export const voiceControlEnabledSetting = new ConfigSettingBoolean({
  id: "voice-control-enabled",
  label: "Enable",
  storageKey: "voice.enabled",
  defaultValue: true,
  description: "Master switch for voice features, including wakeword detection and voice input.",
});

export const firmwareDebugFlagsSetting = new ConfigSettingBoolean({
  id: "firmware-debug-flags",
  label: "Firmware debug flags",
  storageKey: "developer.firmwareDebugFlags",
  defaultValue: false,
  description: "Overlay debug information provided by custom firmware that shows draw timings and dirty rects. Only useful for firmware development.",
});

export const suspendEvenHubWhenScreenOffSetting = new ConfigSettingBoolean({
  id: "suspend-evenhub-screen-off",
  label: "Suspend EvenHub when screen off",
  storageKey: "developer.suspendEvenHubWhenScreenOff",
  defaultValue: true,
  description: "Suspend the EvenHub session while the display is off. This significantly improves battery life, but increases the latency of waking the screen.",
});

export type VoiceProvider = "onboard" | "elevenlabs" | "whisper" | "soniox";

const voiceProviderLabels: Record<VoiceProvider, string> = {
  onboard: "On-device",
  elevenlabs: "ElevenLabs",
  whisper: "Whisper",
  soniox: "Soniox",
};

export const voiceProviderSetting = new ConfigSettingEnum<VoiceProvider>({
  id: "voice-provider",
  label: "Transcription Provider",
  storageKey: "voice.provider",
  defaultValue: "onboard",
  values: ["onboard", "elevenlabs", "whisper", "soniox"],
  formatValue: (value) => voiceProviderLabels[value] ?? value,
  isDisabled: (value) => {
    if (value === "elevenlabs") return elevenLabsApiKeySetting.get().trim().length === 0;
    if (value === "whisper") return openAiApiKeySetting.get().trim().length === 0;
    if (value === "soniox") return sonioxApiKeySetting.get().trim().length === 0;
    return false;
  },
  description: "Speech-to-text engine for voice input. ElevenLabs, Whisper, and Soniox are cloud services that need an API key, with significantly better accuracy than on-device transcription.",
});

const wakeWordActionLabels: Record<WakeWordAction, string> = {
  "voice-input": "Voice Input",
  off: "Off",
  "turn-screen-on": "Turn Screen On",
};

export const wakeWordActionSetting = new ConfigSettingEnum<WakeWordAction>({
  id: "wake-word-action",
  label: "Wakeword Action (\"Hey Even\")",
  storageKey: "voice.wakeWordAction",
  defaultValue: "voice-input",
  values: ["voice-input", "off", "turn-screen-on"],
  formatValue: (value) => wakeWordActionLabels[value] ?? value,
  description: "What saying \"Hey Even\" does: start voice input, just turn the screen on, or nothing.",
});

export const saveVoiceRecordingsSetting = new ConfigSettingBoolean({
  id: "save-voice-recordings",
  label: "Save voice recordings",
  storageKey: "developer.saveVoiceRecordings",
  defaultValue: false,
  description: "Keep a copy of captured voice audio on the phone, for debugging transcription problems.",
});

export const assistantSkipConfirmationSetting = new ConfigSettingBoolean({
  id: "assistant-skip-confirmation",
  label: "Send to assistant without confirming",
  storageKey: "assistant.skipConfirmationAfterWakeword",
  defaultValue: false,
  description: "After a wakeword utterance, send the transcript straight to the assistant instead of stopping at the Send/Type confirmation menu.",
});

export type AssistantBackendKind = "direct" | "external";

const assistantBackendLabels: Record<AssistantBackendKind, string> = {
  direct: "On-phone (API key)",
  external: "My own agent (bridge)",
};

export const assistantBackendSetting = new ConfigSettingEnum<AssistantBackendKind>({
  id: "assistant-backend",
  label: "Assistant backend",
  storageKey: "assistant.backend",
  defaultValue: "direct",
  values: ["direct", "external"],
  formatValue: (value) => assistantBackendLabels[value] ?? value,
  description:
    "Who answers assistant queries: an LLM called directly from the phone (needs an API key), or your own long-running agent (e.g. OpenClaw) reached through the faceclaw-agent-bridge plugin.",
});

export const assistantBridgeHostSetting = new ConfigSettingString({
  id: "assistant-bridge-host",
  label: "Bridge host",
  storageKey: "assistant.bridgeHost",
  defaultValue: "",
  editorTitle: "Agent bridge host (tailscale IP)",
  glassesEditTitle: "Edit bridge host",
  description:
    "Hostname or IP address (e.g. a Tailscale address) of the machine running the agent bridge.",
});

export const assistantBridgePortSetting = new ConfigSettingString({
  id: "assistant-bridge-port",
  label: "Bridge port",
  storageKey: "assistant.bridgePort",
  defaultValue: "8790",
  editorTitle: "Agent bridge port",
  glassesEditTitle: "Edit bridge port",
  description: "TCP port the agent bridge listens on. The default is 8790.",
});

export const assistantBridgeTokenSetting = new ConfigSettingString({
  id: "assistant-bridge-token",
  label: "Bridge token",
  storageKey: "assistant.bridgeToken",
  defaultValue: "",
  editorTitle: "Agent bridge auth token",
  glassesEditTitle: "Edit bridge token",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Shared secret that must match the bridge's configured token.",
});

export const assistantAllowProactiveSetting = new ConfigSettingBoolean({
  id: "assistant-allow-proactive",
  label: "Allow proactive agent actions",
  storageKey: "assistant.allowProactive",
  defaultValue: true,
  description:
    "Let the external agent use glasses tools outside of a conversation, e.g. showing an alert when a long-running job finishes. Rate-limited; only tools marked proactive-safe are allowed.",
});

export const elevenLabsApiKeySetting = new ConfigSettingString({
  id: "elevenlabs-api-key",
  label: "ElevenLabs key",
  storageKey: "voice.elevenLabsApiKey",
  defaultValue: "",
  editorTitle: "ElevenLabs API key",
  glassesEditTitle: "Edit ElevenLabs key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "ElevenLabs API key, used when ElevenLabs is the transcription provider. The key needs the speech-to-text permission.",
});

export const openAiApiKeySetting = new ConfigSettingString({
  id: "openai-api-key",
  label: "OpenAI key",
  storageKey: "voice.openAiApiKey",
  defaultValue: "",
  editorTitle: "OpenAI API key",
  glassesEditTitle: "Edit OpenAI key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "OpenAI API key, used when Whisper is the transcription provider or an OpenAI model is selected for the voice assistant.",
});

export const sonioxApiKeySetting = new ConfigSettingString({
  id: "soniox-api-key",
  label: "Soniox key",
  storageKey: "voice.sonioxApiKey",
  defaultValue: "",
  editorTitle: "Soniox API key",
  glassesEditTitle: "Edit Soniox key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Soniox API key, used when Soniox is the transcription provider.",
});

export const anthropicApiKeySetting = new ConfigSettingString({
  id: "anthropic-api-key",
  label: "Anthropic key",
  storageKey: "llm.anthropicApiKey",
  defaultValue: "",
  editorTitle: "Anthropic API key",
  glassesEditTitle: "Edit Anthropic key",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Anthropic API key, used when an Anthropic model is selected for the voice assistant.",
});

export const assistantModelSetting = new ConfigSettingEnum<AssistantModel>({
  id: "assistant-model",
  label: "Assistant model",
  storageKey: "assistant.model",
  defaultValue: "auto",
  values: ASSISTANT_MODEL_VALUES,
  formatValue: assistantModelLabel,
  isDisabled: (value) => {
    const provider = assistantModelProvider(value);
    if (provider === "anthropic") return anthropicApiKeySetting.get().trim().length === 0;
    if (provider === "openai") return openAiApiKeySetting.get().trim().length === 0;
    return false;
  },
  description: "Model used by the voice assistant. Auto prefers Terra when an OpenAI key is set, then Sonnet when an Anthropic key is set.",
});

export const mapboxApiKeySetting = new ConfigSettingString({
  id: "mapbox-api-key",
  label: "Mapbox token",
  storageKey: "maps.mapboxApiKey",
  defaultValue: "",
  editorTitle: "Mapbox public token (pk.…)",
  glassesEditTitle: "Edit Mapbox token",
  formatValue: (value) => (value ? `${value.slice(0, 6)}...` : "(not set)"),
  description: "Mapbox public token (pk. prefix), used by the Navigate app for maps, geocoding, and directions.",
});

export const terminalHostSetting = new ConfigSettingString({
  id: "terminal-host",
  label: "Host",
  storageKey: "terminal.host",
  defaultValue: "",
  editorTitle: "g2mirror host (tailscale IP)",
  glassesEditTitle: "Edit terminal host",
  description: "Hostname or IP address (e.g. a Tailscale address) of the machine running g2mirror, for the Terminal app.",
});

export const terminalPortSetting = new ConfigSettingString({
  id: "terminal-port",
  label: "Port",
  storageKey: "terminal.port",
  defaultValue: "8737",
  editorTitle: "g2mirror port",
  glassesEditTitle: "Edit terminal port",
  description: "TCP port the g2mirror server listens on. The default is 8737.",
});

export const terminalAuthTokenSetting = new ConfigSettingString({
  id: "terminal-auth-token",
  label: "Auth token",
  storageKey: "terminal.authToken",
  defaultValue: "",
  editorTitle: "g2mirror auth token",
  glassesEditTitle: "Edit terminal auth token",
  description: "Shared secret that must match the g2mirror server's configured auth token.",
});

export const terminalLaunchPresetsSetting = new ConfigSettingString({
  id: "terminal-launch-presets",
  label: "Launch presets",
  storageKey: "terminal.launchPresets",
  defaultValue: "shell",
  editorTitle: "g2mirror launch presets (comma-separated)",
  glassesEditTitle: "Edit launch presets",
  description:
    "Comma-separated names of g2mirror launch presets that can be started from the glasses. Presets are defined in the server's config; the wire protocol has no way to list them, so name them here. The default server config defines \"shell\".",
});

export const terminalWakeOnBellSetting = new ConfigSettingBoolean({
  id: "terminal-wake-on-bell",
  label: "Wake glasses on terminal bell",
  storageKey: "terminal.wakeOnBell",
  defaultValue: false,
  description:
    "When a terminal rings its bell while the glasses are asleep, wake them and focus that terminal's window (or the terminals list if it has no window open).",
});

export const roamGraphNameSetting = new ConfigSettingString({
  id: "roam-graph-name",
  label: "Roam graph name",
  storageKey: "integrations.roam.graphName",
  defaultValue: "",
  editorTitle: "Roam graph name",
  glassesEditTitle: "Edit Roam graph",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
  formatValue: emptySettingDisplay,
  description: "Name of the Roam Research graph the Roam app reads and writes (as shown in Roam's graph switcher).",
});

export const roamApiTokenSetting = new ConfigSettingString({
  id: "roam-api-token",
  label: "Roam API token",
  storageKey: "integrations.roam.apiToken",
  defaultValue: "",
  editorTitle: "Roam API token (roam-graph-token-...)",
  glassesEditTitle: "Edit Roam token",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
  formatValue: maskToken,
  description: "API token for the graph, created in Roam under Settings > Graph > API tokens. Needs edit access for checking off todos.",
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
  description: "Base URL of a Nightscout site to fetch glucose readings from, for the dashboard's glucose card.",
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
  description: "Access token for the Nightscout site's API.",
});


export function screenTimeoutSettingToMs(value: ScreenTimeoutSetting): number | null {
  switch (value) {
    case "15s":
      return 15_000;
    case "30s":
      return 30_000;
    case "1m":
      return 60_000;
    case "3m":
      return 180_000;
    case "never":
      return null;
  }
}

export function brightnessLabel(value: BrightnessSetting): string {
  return value === "auto" ? "Auto" : value;
}

/** The exact level for the wire, or null when the ambient sensor drives it. */
export function brightnessSettingToLevel(value: BrightnessSetting): number | null {
  return value === "auto" ? null : Number(value);
}

export function screenTimeoutLabel(value: ScreenTimeoutSetting): string {
  return value === "never" ? "Never" : value;
}

export function batteryDisplayModeLabel(value: BatteryDisplayMode): string {
  return value === "icon" ? "Icon" : "Percentage";
}

export function timeFormatLabel(value: TimeFormat): string {
  return value === "12h" ? "12-hour" : "24-hour";
}

export function uiFontLabel(value: UiFontChoice): string {
  return value === "terminusv" ? "TerminusV" : "Terminus";
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
  onChange?: (ctx: LayerContext, newValue: T, oldValue: T) => void
}

export function enumSettingMenuItem<TValue extends string, TId extends string = string>(
  setting: ConfigSettingEnum<TValue, TId>,
  opts?: SettingsMenuOptions<TValue>
): MenuItem {
  return {
    label: setting.label,
    description: setting.description,
    onSelect: (ctx) => {
      const current = setting.get();
      const items = setting.values.map((value): MenuItem => ({
        label: setting.displayValue(value),
        disabled: () => setting.isDisabled(value),
        onSelect: () => {
          const oldValue = setting.get();
          setting.set(value);
          opts?.onChange?.(ctx, value, oldValue);
          ctx.stack.pop();
        },
        render: ({ image, x, y, disabled }) => {
          const selected = setting.get() === value ? " *" : "";
          image.drawText(
            getDefaultSmallFont(),
            x,
            y + 3,
            `${setting.displayValue(value)}${selected}`,
            disabled ? 70 : 200,
          );
        },
      }));
      openModalMenu(ctx, setting.label, items, Math.max(0, setting.values.indexOf(current)));
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
    description: setting.description,
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
    description: setting.description,
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

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    // Sized to the hosting stack (full lens in the dashboard window, app
    // viewport in the settings app).
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, 22, 16, this.setting.glassesEditTitle, 220);
    const message = wrapText(font, "Look at the phone app to type a value.", width - 48);
    for (let index = 0; index < message.length; index++) {
      image.drawText(font, 22, 52 + index * 14, message[index]!, 200);
    }
    image.drawText(font, 22, 110, truncateSetting(this.setting.get(), 52), 220);
    image.drawText(font, 22, height - 36, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.endTextSettingEdit();
      ctx.stack.pop();
    }
  }
}
