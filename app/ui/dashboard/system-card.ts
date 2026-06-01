import { GrayImage } from "../../graphics/image";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { readSystemStatusIcons } from "../../native/system-status-icons";
import { type DashboardPluginCardBounds } from "../dashboard-plugins";
import { dashboardState } from "../dashboard";
import { getDefaultMediumFont, getDefaultSmallFont } from "~/graphics/bdffont";
import { getDashboardLogo } from "~/graphics/logo";
import { DEFAULT_SYSTEM_CARD_NAME } from "../dashboard-settings";

const NOTIFICATION_ICON_SIZE = 24;
const SYSTEM_CARD_ITEM_HEIGHT = 38;
const SYSTEM_CARD_ITEM_GAP = 2;
const BATTERY_ITEM_Y_OFFSET = 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type SystemCardFlowItem =
  | { type: "battery"; label: string; percentCharge: number; isCharging: boolean }
  | { type: "notification"; icon: GrayImage };

const smallFont = getDefaultSmallFont();
const mediumFont = getDefaultMediumFont();

function drawSystemCardFlowItems(image: GrayImage, bounds: DashboardPluginCardBounds): void {
  const left = bounds.x + 10;
  const top = bounds.y + 84;
  const right = bounds.x + bounds.width - 10;
  const bottom = bounds.y + bounds.height - 6;
  const items: SystemCardFlowItem[] = [];
  if (dashboardState.systemCardSettings.showAndroidNotifications) {
    const maxNotificationIcons = Math.max(0, ((right - left) / Math.max(1, NOTIFICATION_ICON_SIZE + SYSTEM_CARD_ITEM_GAP)) | 0) * 2;
    for (const icon of readActiveNotificationIcons(maxNotificationIcons)) {
      items.push({ type: "notification", icon });
    }
  }
  items.push(...collectBatteryItems());
  if (dashboardState.systemCardSettings.showSignalStrength) {
    for (const icon of readSystemStatusIcons()) {
      items.push({ type: "notification", icon });
    }
  }

  let itemX = left;
  let itemY = top;
  for (const item of items) {
    const itemWidth = systemCardFlowItemWidth(item);
    if (itemX > left && itemX + itemWidth > right) {
      itemX = left;
      itemY += SYSTEM_CARD_ITEM_HEIGHT + SYSTEM_CARD_ITEM_GAP;
    }
    if (itemY + SYSTEM_CARD_ITEM_HEIGHT > bottom) {
      break;
    }
    if (item.type === "battery") {
      drawBatteryFlowItem(image, itemX, itemY, item);
    } else {
      image.bitBlt(
        item.icon,
        itemX,
        itemY + ((SYSTEM_CARD_ITEM_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0,
      );
    }
    itemX += itemWidth + SYSTEM_CARD_ITEM_GAP;
  }
}

function systemCardFlowItemWidth(item: SystemCardFlowItem): number {
  if (item.type === "notification") {
    return NOTIFICATION_ICON_SIZE;
  }
  return Math.max(BATTERY_ICON_WIDTH, smallFont.measureText(item.label));
}

function collectBatteryItems(): SystemCardFlowItem[] {
  if (!dashboardState.systemCardSettings.showBatteryIndicators) return [];
  const phone = readPhoneBatteryState();
  const items: SystemCardFlowItem[] = [];
  addBatteryItem(items, "Phone", phone.battery, phone.charging);
  addBatteryItem(items, "G2", dashboardState.battery.headset, dashboardState.battery.headsetCharging);
  addBatteryItem(items, "R1", dashboardState.battery.ring, null);
  return items;
}

function addBatteryItem(
  items: SystemCardFlowItem[],
  label: string,
  percentCharge: number | null,
  isCharging: boolean | null,
): void {
  if (percentCharge === null || !Number.isFinite(percentCharge)) return;
  items.push({
    type: "battery",
    label,
    percentCharge,
    isCharging: Boolean(isCharging),
  });
}

function drawBatteryFlowItem(image: GrayImage, x: number, y: number, item: Extract<SystemCardFlowItem, { type: "battery" }>): void {
  const itemWidth = systemCardFlowItemWidth(item);
  const labelX = x + Math.max(0, ((itemWidth - smallFont.measureText(item.label)) / 2) | 0);
  image.drawText(smallFont, labelX, y + BATTERY_ITEM_Y_OFFSET, item.label, 150);
  const battery = drawBattery(item.percentCharge, item.isCharging);
  image.bitBlt(battery, x + ((itemWidth - battery.width) / 2) | 0, y + 16 + BATTERY_ITEM_Y_OFFSET);
}

function formatDashboardDate(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${MONTHS[now.getMonth()]} ${now.getDate()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function getDisplayedSystemCardName(): string {
  return dashboardState.systemCardName || DEFAULT_SYSTEM_CARD_NAME;
}


export function drawSystemCard(image: GrayImage, bounds: DashboardPluginCardBounds): void {
    const now = new Date();
    const logo = getDashboardLogo();

    if (logo && dashboardState.systemCardSettings.showFaceclawLogo) {
      image.bitBlt(logo, bounds.x + 10, bounds.y + 10);
    }
    const infoX = logo && dashboardState.systemCardSettings.showFaceclawLogo ? bounds.x + 92 : bounds.x + 10;
    image.drawText(mediumFont, infoX, bounds.y + 10, getDisplayedSystemCardName(), 200);
    image.drawText(mediumFont, infoX, bounds.y + 32, formatDashboardDate(now), 200);
    drawSystemCardFlowItems(image, bounds);
}

