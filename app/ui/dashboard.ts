import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { getDefaultSmallFont } from "../graphics/bdffont";
import { type RawInputEvent } from "../native/faceclaw-communicator";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { EventSourceType, OsEventTypeList } from "../g2/events";
import { getDashboardPlugin, type DashboardPluginCardBounds, type DashboardPluginState } from "./dashboard-plugins";
import { isNightscoutSettingsConfigured, screenTimeoutSettingToMs, screenTimeoutSetting, type DashboardSlotId, DashboardPluginId, bottomRightSlotSetting, bottomLeftSlotSetting, dashboardSlotIds } from "./dashboard-settings";
import { Layer, LayerActions, LayerStack, type DashboardInputEvent, type LayerContext } from "./layers";
import { SingleNotificationLayer } from "./notifications";
import { TelepromptLayer } from "./apps/teleprompt";
import { drawSystemCard } from "./dashboard/system-card";
import { createRootMenuLayer } from "./dashboard/root-menu";

type DashboardCardId = "system" | DashboardSlotId;
export type DashboardBatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  ring: number | null;
};

type DashboardState = {
  logLines: string[];
  screenOn: boolean;
  lastInputAtMs: number;
  telepromptDocumentText: string | null;
  battery: DashboardBatteryLevels;
};

export let dashboardState: DashboardState = {
  logLines: [] as string[],
  screenOn: true,
  lastInputAtMs: Date.now(),
  telepromptDocumentText: null as string | null,
  battery: {
    headset: null,
    headsetCharging: null,
    ring: null,
  } as DashboardBatteryLevels,
};

const dashboardActions: LayerActions = {
  disconnect: () => {},
  startTextSettingEdit: () => {},
  endTextSettingEdit: () => {},
  setVoiceControlEnabled: () => {},
  setStopwatchRenderActive: () => {},
  setTranscribeRenderActive: () => {},
  startDedicatedVoiceInput: () => {},
  stopDedicatedVoiceInput: () => {},
  playBuzzerNote: () => {},
};
const dashboardFont = getDefaultSmallFont();
export const TOP_LEFT_MENU_LAYOUT = { x: 8, y: 8, width: 272, height: 128 };

function rawInputEventToInputEvent(event: RawInputEvent): DashboardInputEvent {
  if (event.kind === "sys-event") {
    if (event.eventType === OsEventTypeList.CLICK_EVENT) {
      return {
        type: "click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return {
        type: "double-click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    }
  } else if (event.kind === "text-click") {
    if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    }
  }
  return {
    type: "unknown",
    kind: event.kind,
    eventSource: event.eventSource,
    eventType: event.eventType,
  };
}

function eventSourceToString(eventSource: number): "ring" | "left-arm" | "right-arm" {
  if (eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
    return "ring";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) {
    return "left-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    return "right-arm";
  }
  return "ring";
}

export async function receiveInput(event: RawInputEvent): Promise<void> {
  const inputEvent = rawInputEventToInputEvent(event);
  dashboardState.lastInputAtMs = Date.now();
  dashboardState.logLines.push(eventToString(inputEvent));
  if (!dashboardState.screenOn) {
    if (inputEvent.type === "double-click") {
      dashboardState.screenOn = true;
      if (dashboardLayers.isAtBase()) {
        dashboardLayers.push(createRootMenuLayer());
      }
    }
    return;
  }
  await dashboardLayers.handleInput(inputEvent);
}

function eventToString(event: DashboardInputEvent): string {
  switch (event.type) {
    case "click":
      return `Click from ${event.source}`;
    case "double-click":
      return `Double click from ${event.source}`;
    case "scroll-up":
      return `Scroll up`;
    case "scroll-down":
      return `Scroll down`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}

export function logToDashboard(message: string): void {
  dashboardState.logLines.push(message);
}

export function setDashboardActions(actions: Partial<LayerActions>): void {
  dashboardLayers.setActions(actions);
}

export function drawDashboard(): GrayImage {
  if (!dashboardState.screenOn) {
    return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  }
  return dashboardLayers.paint();
}

export function applyDashboardScreenTimeout(nowMs = Date.now()): boolean {
  const timeoutMs = screenTimeoutSettingToMs(screenTimeoutSetting.get());
  if (timeoutMs === null || !dashboardState.screenOn) return false;
  if (nowMs - dashboardState.lastInputAtMs < timeoutMs) return false;
  dashboardState.screenOn = false;
  return true;
}

export function noteDashboardPhoneTextInput(nowMs = Date.now()): void {
  dashboardState.lastInputAtMs = nowMs;
}

export function openTelepromptDocument(text?: string): void {
  if (text !== undefined) {
    dashboardState.telepromptDocumentText = text;
  }
  dashboardState.lastInputAtMs = Date.now();
  dashboardState.screenOn = true;
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  dashboardLayers.push(new TelepromptLayer(dashboardState.telepromptDocumentText));
}

export function openAndroidNotificationFromSleep(notificationKey: string, nowMs = Date.now()): boolean {
  if (!notificationKey || dashboardState.screenOn) return false;

  dashboardState.lastInputAtMs = nowMs;
  dashboardState.screenOn = true;
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  dashboardLayers.push(new SingleNotificationLayer(notificationKey, {
    origin: "new-notification-trigger",
    closeNewNotificationTrigger: closeNewNotificationTrigger,
  }));
  return true;
}

function closeNewNotificationTrigger(ctx: LayerContext): void {
  dashboardState.screenOn = false;
  ctx.stack.clearToBase();
}

export function resetDashboardSleepTimerAndWake(nowMs = Date.now()): boolean {
  dashboardState.lastInputAtMs = nowMs;
  if (dashboardState.screenOn) return false;

  dashboardState.screenOn = true;
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
    if (!dashboardState.screenOn) {
      return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    }

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
      dashboardState.screenOn = false;
      ctx.stack.clearToBase();
      void dashboardActions.endTextSettingEdit();
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

