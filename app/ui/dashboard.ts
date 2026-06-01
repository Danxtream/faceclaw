import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { getDefaultSmallFont } from "../graphics/bdffont";
import { type RawInputEvent } from "../native/faceclaw-communicator";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { EventSourceType, OsEventTypeList } from "../g2/events";
import { getDashboardPlugin, isBlankDashboardPlugin, type DashboardPluginCardBounds, type DashboardPluginState } from "./dashboard-plugins";
import {
  estimateCompressionRatiosSetting,
  isNightscoutSettingsConfigured,
  nightscoutApiTokenSetting,
  nightscoutSiteUrlSetting,
  screenTimeoutSettingToMs,
  screenTimeoutSetting,
  systemCardNameSetting,
  voiceControlEnabledSetting,
  wakeModeSetting,
  type DashboardSlotId,
  DashboardPluginId,
  bottomRightSlotSetting,
  bottomLeftSlotSetting,
  dashboardSlotSettings,
  dashboardSlotIds,
  enumSettingMenuItem,
  toggleSettingMenuItem,
  showFaceclawLogoSetting,
  showBatteryIndicatorsSetting,
  showAndroidNotificationsSetting,
  showSignalStrengthSetting,
  textSettingMenuItem,
} from "./dashboard-settings";
import { Layer, LayerActions, LayerStack, type DashboardInputEvent, type LayerContext } from "./layers";
import { MenuLayer } from "./menu";
import { StopwatchLayer } from "./apps/stopwatch";
import { NotificationsListLayer, SingleNotificationLayer } from "./notifications";
import { TranscribeLayer } from "./apps/transcribe";
import { TelepromptLayer } from "./apps/teleprompt";
import { ScreenTestLayer } from "./apps/screen-test";
import { getDashboardLogo } from "~/graphics/logo";
import { drawSystemCard } from "./dashboard/system-card";

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
  tiledWakePaintPending: boolean;
  telepromptDocumentText: string | null;
  battery: DashboardBatteryLevels;
};

export let dashboardState: DashboardState = {
  logLines: [] as string[],
  screenOn: true,
  lastInputAtMs: Date.now(),
  tiledWakePaintPending: false,
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
};
const dashboardFont = getDefaultSmallFont();
const TOP_LEFT_MENU_LAYOUT = { x: 8, y: 8, width: 272, height: 128 };

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
      dashboardState.tiledWakePaintPending = wakeModeSetting.get() === "tiled";
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

export function consumeDashboardTiledWakePaint(): boolean {
  const value = dashboardState.tiledWakePaintPending;
  dashboardState.tiledWakePaintPending = false;
  return value;
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
  dashboardState.tiledWakePaintPending = wakeModeSetting.get() === "tiled";
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  dashboardLayers.push(new SingleNotificationLayer(notificationKey));
  return true;
}

export function resetDashboardSleepTimerAndWake(nowMs = Date.now()): boolean {
  dashboardState.lastInputAtMs = nowMs;
  if (dashboardState.screenOn) return false;

  dashboardState.screenOn = true;
  dashboardState.tiledWakePaintPending = wakeModeSetting.get() === "tiled";
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

function getPluginIdForSlot(slot: DashboardSlotId): DashboardPluginId {
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

function createRootMenuLayer(): MenuLayer {
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
            image.drawText(dashboardFont, x, y + 3, pluginLabelForSlot(slot), 200);
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
          ctx.stack.push(new AboutLayer());
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

function createSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings",
    [
      {
        label: "Display",
        onSelect: (ctx) => {
          ctx.stack.push(createDisplaySettingsMenuLayer());
        },
      },
      {
        label: "Dashboard",
        onSelect: (ctx) => {
          ctx.stack.push(createDashboardSettingsMenuLayer());
        },
      },
      {
        label: "Voice",
        onSelect: (ctx) => {
          ctx.stack.push(createVoiceSettingsMenuLayer());
        },
      },
      {
        label: "Integrations",
        onSelect: (ctx) => {
          ctx.stack.push(createIntegrationsMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createDisplaySettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Display",
    [
      enumSettingMenuItem(screenTimeoutSetting, {
        onChange: (newValue, oldValue) => {
          dashboardState.lastInputAtMs = Date.now();
        },
      }),
      enumSettingMenuItem(wakeModeSetting),
      toggleSettingMenuItem(estimateCompressionRatiosSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createVoiceSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Voice",
    [
      toggleSettingMenuItem(voiceControlEnabledSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createDashboardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Dashboard",
    [
      {
        label: "System Card",
        onSelect: (ctx) => {
          ctx.stack.push(createSystemCardSettingsMenuLayer());
        },
      },
      ...dashboardSlotIds.map((slot) => enumSettingMenuItem(dashboardSlotSettings[slot], {
        style: "submenu",
      })),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createSystemCardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Dashboard > System Card",
    [
      textSettingMenuItem(systemCardNameSetting),
      toggleSettingMenuItem(showFaceclawLogoSetting),
      toggleSettingMenuItem(showBatteryIndicatorsSetting),
      toggleSettingMenuItem(showAndroidNotificationsSetting),
      toggleSettingMenuItem(showSignalStrengthSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createIntegrationsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Integrations",
    [
      {
        label: "Nightscout",
        onSelect: (ctx) => {
          ctx.stack.push(createNightscoutSettingsMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createNightscoutSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings > Integrations > Nightscout",
    [
      textSettingMenuItem(nightscoutSiteUrlSetting),
      textSettingMenuItem(nightscoutApiTokenSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}


class AboutLayer implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const logo = getDashboardLogo();
    image.drawText(dashboardFont, 22, 16, "About Faceclaw", 220);
    if (logo) {
      image.bitBlt(logo, 22, 42);
    }
    image.drawText(dashboardFont, 108, 48, "Faceclaw", 220);
    image.drawText(dashboardFont, 108, 64, "Dashboard prototype", 180);

    image.drawTextWrapped({
      font: dashboardFont,
      x: 22, y: 128,
      width: G2_LENS_WIDTH - 44,
      text: "By James Babcock. Distributed under the GNU General Public License, version 3. Version 0.1.0. Too much of an early janky development prototype to have proper numbered releases.",
      value: 180
    });
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

function getPluginState(): DashboardPluginState {
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

function pluginLabelForSlot(slot: DashboardSlotId): string {
  return getDashboardPlugin(getPluginIdForSlot(slot)).label;
}

const dashboardLayers = new LayerStack(new DashboardLayer(), dashboardActions);
dashboardLayers.push(createRootMenuLayer());

