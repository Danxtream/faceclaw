import { type GrayImage } from "../graphics/image";
import { type MediaControllerState } from "../native/media-controller";
import { type NightscoutState } from "../native/nightscout-bridge";
import { type DashboardPluginId } from "./dashboard-settings";
import { type Layer } from "./layers";

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
