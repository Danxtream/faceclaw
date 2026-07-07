import { getDefaultSmallFont } from "~/graphics/bdffont";
import { dashboardState, getPluginIdForSlot, getPluginState, TOP_LEFT_MENU_LAYOUT } from "../dashboard";
import { getDashboardPlugin, isBlankDashboardPlugin } from "../dashboard-plugins";
import { DashboardSlotId, dashboardSlotIds, isNightscoutSettingsConfigured } from "../dashboard-settings";
import { DashboardInputEvent, LayerContext } from "../layers";
import { MenuLayer } from "../menu";
import { createNightscoutSettingsMenuLayer } from "./settings-menus";
import { TelepromptLayer } from "../apps/teleprompt";
import { TranscribeLayer } from "../apps/transcribe";
import { ScreenTestLayer } from "../apps/screen-test";
import { BuzzerDemoLayer } from "../apps/buzzer-demo";
import { GrayImage } from "~/graphics/image";
import { shell } from "../shell/shell";

const rootMenuFont = getDefaultSmallFont();

class RootMenuLayer extends MenuLayer {
  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      // Backing out of the window's root returns focus to the shell sidebar.
      shell.yieldFocusToSidebar();
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
      {
        label: "Buzzer demo",
        onSelect: (ctx) => {
          ctx.stack.push(new BuzzerDemoLayer());
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
