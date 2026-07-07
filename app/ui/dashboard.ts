import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { getDashboardPlugin, type DashboardPluginCardBounds, type DashboardPluginState } from "./dashboard-plugins";
import { EditTextSettingLayer, isNightscoutSettingsConfigured, type DashboardSlotId, DashboardPluginId, bottomRightSlotSetting, bottomLeftSlotSetting, dashboardSlotIds } from "./dashboard-settings";
import { Layer, LayerActions, LayerStack, type DashboardInputEvent, type LayerContext } from "./layers";
import { SingleNotificationLayer } from "./notifications";
import { TelepromptLayer } from "./apps/teleprompt";
import { drawSystemCard } from "./dashboard/system-card";
import { createRootMenuLayer } from "./dashboard/root-menu";
import { inputEventToString, shell } from "./shell/shell";

type DashboardCardId = "system" | DashboardSlotId;
export type DashboardBatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  ring: number | null;
};

type DashboardState = {
  logLines: string[];
  telepromptDocumentText: string | null;
  battery: DashboardBatteryLevels;
};

export let dashboardState: DashboardState = {
  logLines: [] as string[],
  telepromptDocumentText: null as string | null,
  battery: {
    headset: null,
    headsetCharging: null,
    ring: null,
  } as DashboardBatteryLevels,
};

const dashboardActions: LayerActions = {
  requestRender: () => {},
  disconnect: () => {},
  startTextSettingEdit: () => {},
  endTextSettingEdit: () => {},
  setTranscribeRenderActive: () => {},
  startVoiceCapture: () => {},
  stopVoiceCapture: () => {},
  playBuzzerNote: () => {},
};
export const TOP_LEFT_MENU_LAYOUT = { x: 8, y: 8, width: 272 };

/**
 * Input handler for the dashboard window. Global gestures (wake, sleep,
 * long-press/push-to-talk) are consumed by the shell before this is called.
 */
export async function receiveDashboardWindowInput(inputEvent: DashboardInputEvent): Promise<void> {
  dashboardState.logLines.push(inputEventToString(inputEvent));
  await dashboardLayers.handleInput(inputEvent);
}

export function logToDashboard(message: string): void {
  dashboardState.logLines.push(message);
}

export function setDashboardActions(actions: Partial<LayerActions>): void {
  dashboardLayers.setActions(actions);
}

/**
 * Close the glasses-side text-setting edit page, e.g. when the user finishes
 * typing on the phone. Returns whether the display changed.
 */
export function closeDashboardTextSettingEditor(): boolean {
  return dashboardLayers.popIfTop((layer) => layer instanceof EditTextSettingLayer);
}

export function drawDashboard(): GrayImage {
  if (!shell.isScreenOn()) {
    return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  }
  return dashboardLayers.paint();
}

export function openTelepromptDocument(text?: string): void {
  if (text !== undefined) {
    dashboardState.telepromptDocumentText = text;
  }
  shell.wake("window");
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  dashboardLayers.push(new TelepromptLayer(dashboardState.telepromptDocumentText));
}

export function openAndroidNotificationFromSleep(notificationKey: string, nowMs = Date.now()): boolean {
  if (!notificationKey || shell.isScreenOn()) return false;

  shell.wake("window", nowMs);
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  dashboardLayers.push(new SingleNotificationLayer(notificationKey, {
    origin: "new-notification-trigger",
    closeNewNotificationTrigger: closeNewNotificationTrigger,
  }));
  return true;
}

function closeNewNotificationTrigger(ctx: LayerContext): void {
  shell.sleep();
  ctx.stack.clearToBase();
}

export function resetDashboardSleepTimerAndWake(nowMs = Date.now()): boolean {
  if (!shell.wake("sidebar", nowMs)) return false;
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  return true;
}

export function setDashboardBatteryLevels(levels: Partial<DashboardBatteryLevels>): void {
  dashboardState.battery = {
    ...dashboardState.battery,
    ...levels,
  };
}

export function getPluginIdForSlot(slot: DashboardSlotId): DashboardPluginId {
  switch (slot) {
    case "bottom-left":
      return bottomLeftSlotSetting.get();
    case "bottom-right":
      return bottomRightSlotSetting.get();
  }
}


class DashboardLayer implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const pluginState = getPluginState();
    drawSystemCard(image, getCardBounds("system"));

    for (const slot of dashboardSlotIds) {
      const bounds = getCardBounds(slot);
      const pluginId = getPluginIdForSlot(slot);
      getDashboardPlugin(pluginId).renderCard({
        image,
        bounds,
        selected: false,
        state: pluginState,
      });
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (event.type === "click") {
      ctx.stack.push(createRootMenuLayer());
      return;
    }

    if (event.type === "double-click") {
      // Backing out of the window's root returns focus to the shell sidebar.
      shell.yieldFocusToSidebar();
    }
  }
}

export function getPluginState(): DashboardPluginState {
  return {
    logLines: dashboardState.logLines,
    media: mediaControllerBridge.snapshot(),
    nightscout: nightscoutBridge.snapshot(),
    nightscoutConfigured: isNightscoutSettingsConfigured(),
  };
}

function getCardBounds(card: DashboardCardId): DashboardPluginCardBounds {
  switch (card) {
    case "system":
      return {
        x: G2_LENS_WIDTH / 2 + 2,
        y: 0,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
    case "bottom-left":
      return {
        x: 0,
        y: G2_LENS_HEIGHT / 2 + 2,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
    case "bottom-right":
      return {
        x: G2_LENS_WIDTH / 2 + 2,
        y: G2_LENS_HEIGHT / 2 + 2,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
  }
}

const dashboardLayers = new LayerStack(new DashboardLayer(), dashboardActions);
dashboardLayers.push(createRootMenuLayer());

