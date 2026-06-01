import { getDefaultSmallFont } from "~/graphics/bdffont";
import { dashboardState, getPluginIdForSlot, getPluginState, TOP_LEFT_MENU_LAYOUT } from "../dashboard";
import { getDashboardPlugin, isBlankDashboardPlugin } from "../dashboard-plugins";
import { DashboardSlotId, dashboardSlotIds, isNightscoutSettingsConfigured } from "../dashboard-settings";
import { DashboardInputEvent, LayerContext } from "../layers";
import { MenuLayer } from "../menu";
import { NotificationsListLayer } from "../notifications";
import { createNightscoutSettingsMenuLayer, createSettingsMenuLayer } from "./settings-menus";
import { TelepromptLayer } from "../apps/teleprompt";
import { StopwatchLayer } from "../apps/stopwatch";
import { TranscribeLayer } from "../apps/transcribe";
import { ScreenTestLayer } from "../apps/screen-test";
import { AboutPage } from "./about-page";
import { GrayImage } from "~/graphics/image";

const rootMenuFont = getDefaultSmallFont();

class RootMenuLayer extends MenuLayer {
  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      dashboardState.screenOn = false;
      ctx.stack.clearToBase();
      void ctx.actions.endTextSettingEdit();
      return;
    }
    await super.handleInput(event, ctx);
  }
}

export function createRootMenuLayer(): MenuLayer {
  return new RootMenuLayer(
    null,
    [
      {
        label: "Apps",
        onSelect: (ctx) => {
          ctx.stack.push(createAppsMenuLayer());
        },
      },
      {
        label: "Notifications",
        onSelect: (ctx) => {
          ctx.stack.push(new NotificationsListLayer((ctx) => {
            ctx.stack.clearToBase();
            ctx.stack.push(createRootMenuLayer());
          }));
        },
      },
      {
        label: "Settings",
        onSelect: (ctx) => {
          ctx.stack.push(createSettingsMenuLayer());
        },
      },
      ...dashboardSlotIds
        .filter((slot) => !isBlankDashboardPlugin(getPluginIdForSlot(slot)))
        .map((slot) => ({
          label: pluginLabelForSlot(slot),
          onSelect: (ctx: LayerContext) => {
            openDashboardSlot(slot, ctx);
          },
          render: ({ image, x, y }: { image: GrayImage; x: number; y: number }) => {
            image.drawText(rootMenuFont, x, y + 3, pluginLabelForSlot(slot), 200);
          },
        })),
      {
        label: "System",
        onSelect: (ctx) => {
          ctx.stack.push(createSystemMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createAppsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Apps",
    [
      {
        label: "Teleprompt",
        onSelect: (ctx) => {
          ctx.stack.push(new TelepromptLayer(dashboardState.telepromptDocumentText));
        },
      },
      {
        label: "Stopwatch",
        onSelect: (ctx) => {
          ctx.stack.push(new StopwatchLayer());
          void ctx.actions.setStopwatchRenderActive(true);
        },
      },
      {
        label: "Transcribe",
        onSelect: (ctx) => {
          const layer = new TranscribeLayer();
          ctx.stack.push(layer);
          layer.start(ctx);
        },
      },
      {
        label: "Screen test",
        onSelect: (ctx) => {
          ctx.stack.push(new ScreenTestLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createSystemMenuLayer(): MenuLayer {
  return new MenuLayer(
    "System",
    [
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
    TOP_LEFT_MENU_LAYOUT,
  );
}

function openDashboardSlot(slot: DashboardSlotId, ctx: LayerContext): void {
  const pluginId = getPluginIdForSlot(slot);
  if (isBlankDashboardPlugin(pluginId)) {
    return;
  }
  if (pluginId === "nightscout" && !isNightscoutSettingsConfigured()) {
    ctx.stack.push(createNightscoutSettingsMenuLayer());
    return;
  }
  const layer = getDashboardPlugin(pluginId).createFullscreenLayer?.(getPluginState);
  if (layer) {
    ctx.stack.push(layer);
  }
}


function pluginLabelForSlot(slot: DashboardSlotId): string {
  return getDashboardPlugin(getPluginIdForSlot(slot)).label;
}
