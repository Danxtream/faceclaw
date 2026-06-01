import { type DashboardPluginId } from "./dashboard-settings";
import { DashboardPlugin } from "./dashboard-plugin";
import { NightscoutDashboardPlugin } from "./apps/nightscout";
import { MusicControllerDashboardPlugin } from "./apps/music-controller";
import { DebugLogDashboardPlugin } from "./apps/debug-log";

export { DashboardPlugin } from "./dashboard-plugin";
export type { DashboardPluginCardBounds, DashboardPluginCardRenderArgs, DashboardPluginState } from "./dashboard-plugin";

let dashboardPlugins: DashboardPlugin[] | null = null;
function getDashboardPlugins(): DashboardPlugin[] {
  if (!dashboardPlugins) {
    dashboardPlugins = [
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
  }
  return dashboardPlugins;
};

export function listDashboardPlugins(): DashboardPlugin[] {
  return [...getDashboardPlugins()];
}

export function getDashboardPlugin(pluginId: DashboardPluginId): DashboardPlugin {
  const PLUGIN_MAP = new Map<DashboardPluginId, DashboardPlugin>(
    getDashboardPlugins().map((plugin) => [plugin.id, plugin]),
  );
  return PLUGIN_MAP.get(pluginId) ?? PLUGIN_MAP.get("blank")!;
}

export function isBlankDashboardPlugin(pluginId: DashboardPluginId): boolean {
  return pluginId === "blank";
}
