import { GrayImage } from "../graphics/image";
import { type MediaControllerState } from "../native/media-controller";
import { type DashboardPluginId } from "./dashboard-settings";
import { Layer } from "./layers";
import { NightscoutDashboardPlugin } from "./apps/nightscout";
import { NightscoutState } from "~/native/nightscout-bridge";
import { MusicControllerDashboardPlugin } from "./apps/music-controller";
import { DebugLogDashboardPlugin } from "./apps/debug-log";

export type DashboardPluginState = {
  logLines: string[];
  media: MediaControllerState;
  nightscout: NightscoutState;
  nightscoutConfigured: boolean;
};

export type DashboardPluginCardBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DashboardPluginCardRenderArgs = {
  image: GrayImage;
  bounds: DashboardPluginCardBounds;
  selected: boolean;
  state: DashboardPluginState;
};

export abstract class DashboardPlugin {
  readonly id: DashboardPluginId;
  readonly label: string;

  constructor(config: {
    id: DashboardPluginId;
    label: string;
  }) {
    this.id = config.id;
    this.label = config.label;
  }

  abstract renderCard(args: DashboardPluginCardRenderArgs): void;

  createFullscreenLayer(getState: () => DashboardPluginState): Layer | null {
    return null;
  }
}

const DASHBOARD_PLUGINS: DashboardPlugin[] = [
  {
    id: "blank",
    label: "Blank",
    renderCard: () => {},
    createFullscreenLayer: () => null,
  },
  new DebugLogDashboardPlugin(),
  new MusicControllerDashboardPlugin(),
  new NightscoutDashboardPlugin(),
];

const PLUGIN_MAP = new Map<DashboardPluginId, DashboardPlugin>(
  DASHBOARD_PLUGINS.map((plugin) => [plugin.id, plugin]),
);
export function listDashboardPlugins(): DashboardPlugin[] {
  return [...DASHBOARD_PLUGINS];
}

export function getDashboardPlugin(pluginId: DashboardPluginId): DashboardPlugin {
  return PLUGIN_MAP.get(pluginId) ?? PLUGIN_MAP.get("blank")!;
}

export function isBlankDashboardPlugin(pluginId: DashboardPluginId): boolean {
  return pluginId === "blank";
}
