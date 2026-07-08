import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { clamp } from "../../util/numeric-util";
import { renderIcon, type IconName } from "../../graphics/icons";
import { batteryDisplayModeSetting } from "../dashboard-settings";
import { Layer } from "../layers";
import { SHELL_OPAQUE_BLACK, SIDEBAR_WIDTH, TOP_BAR_HEIGHT } from "./geometry";

const ICON_SIZE = 32;
const ICON_MARGIN_X = ((SIDEBAR_WIDTH - ICON_SIZE) / 2) | 0;
const ICON_SPACING = 8;
const NOTIFICATION_ICON_SIZE = 24;
const BORDER_VALUE = 40;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ShellChromeWindow = {
  windowId: string;
  title: string;
  attention: boolean;
  drawIcon: (image: GrayImage, x: number, y: number, size: number) => void;
};

export type ShellChromeState = {
  windows: ShellChromeWindow[];
  selectedIndex: number;
  focus: "sidebar" | "window";
  battery: { headset: number | null; headsetCharging: boolean | null };
  /** App-provided tray images, drawn between notification icons and batteries. */
  trayIcons: GrayImage[];
};

/** Placeholder window icon: rounded outline with a single letter. */
export function makeLetterWindowIcon(letter: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size) => {
    const font = getDefaultMediumFont();
    image.drawRoundedRect(x, y, size, size, 120, 6);
    const textX = x + Math.max(0, ((size - font.measureText(letter)) / 2) | 0);
    const textY = y + Math.max(0, ((size - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, textY, letter, 210);
  };
}

/** Window icon rendered from an SVG (Lucide), rendered once per size and cached. */
export function makeSvgWindowIcon(name: IconName): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size) => {
    const icon = renderIcon(name, size);
    if (!icon) return;
    const dx = x + Math.max(0, ((size - icon.width) / 2) | 0);
    const dy = y + Math.max(0, ((size - icon.height) / 2) | 0);
    image.bitBlt(icon, dx, dy, { transparentZero: true });
  };
}

/** SVG icon when a name is given, else the letter placeholder. */
export function windowIcon(icon: IconName | undefined, letter: string): ShellChromeWindow["drawIcon"] {
  return icon ? makeSvgWindowIcon(icon) : makeLetterWindowIcon(letter);
}

/**
 * Base layer of the shell surface: the window sidebar on the left and the
 * status top bar. Everything not explicitly painted stays 0 (transparent on
 * the color-key shell surface), so the app viewport shows through.
 */
export class ShellChromeLayer implements Layer {
  // First sidebar row shown; adjusted each paint to keep the selection visible.
  private scrollRow = 0;

  constructor(private readonly getState: () => ShellChromeState) {}

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const state = this.getState();
    this.drawSidebar(image, state);
    this.drawTopBar(image, state);
    return image;
  }

  handleInput(): void {
    // Shell input is handled by the shell state machine before it reaches the
    // layer stack; the chrome itself never consumes events.
  }

  private drawSidebar(image: GrayImage, state: ShellChromeState): void {
    image.fillRect(0, 0, SIDEBAR_WIDTH, G2_LENS_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(SIDEBAR_WIDTH - 1, 0, SIDEBAR_WIDTH - 1, G2_LENS_HEIGHT - 1, BORDER_VALUE);

    // Scroll the icon list to keep the selection visible; chevrons mark
    // windows off-screen above/below.
    const listTop = TOP_BAR_HEIGHT + 10;
    const itemStride = ICON_SIZE + ICON_SPACING;
    const listHeight = G2_LENS_HEIGHT - listTop - 10;
    const visibleCount = Math.max(1, ((listHeight + ICON_SPACING) / itemStride) | 0);
    const count = state.windows.length;
    if (state.selectedIndex < this.scrollRow) {
      this.scrollRow = state.selectedIndex;
    } else if (state.selectedIndex >= this.scrollRow + visibleCount) {
      this.scrollRow = state.selectedIndex - visibleCount + 1;
    }
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, count - visibleCount));
    const lastVisible = Math.min(count, this.scrollRow + visibleCount);

    for (let index = this.scrollRow; index < lastVisible; index++) {
      const window = state.windows[index]!;
      const y = listTop + (index - this.scrollRow) * itemStride;
      if (index === state.selectedIndex) {
        const highlight = state.focus === "sidebar" ? 200 : 70;
        image.drawRoundedRect(0, y - 2, SIDEBAR_WIDTH - 3, ICON_SIZE + 4, highlight, 6);
      }
      window.drawIcon(image, ICON_MARGIN_X, y, ICON_SIZE);
      if (window.attention) {
        image.fillRoundedRect(ICON_MARGIN_X + ICON_SIZE - 7, y - 1, 8, 8, 255, 4);
      }
    }

    if (this.scrollRow > 0) {
      drawChevron(image, SIDEBAR_WIDTH / 2, TOP_BAR_HEIGHT + 6, -1);
    }
    if (lastVisible < count) {
      drawChevron(image, SIDEBAR_WIDTH / 2, G2_LENS_HEIGHT - 6, 1);
    }
  }

  private drawTopBar(image: GrayImage, state: ShellChromeState): void {
    const font = getDefaultMediumFont();
    image.fillRect(SIDEBAR_WIDTH, 0, G2_LENS_WIDTH - SIDEBAR_WIDTH, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(SIDEBAR_WIDTH, TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, TOP_BAR_HEIGHT - 1, BORDER_VALUE);

    const now = new Date();
    const clock = `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ` +
      `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
    const clockX = SIDEBAR_WIDTH + 10;
    const textY = Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    image.drawText(font, clockX, textY, clock, 210);

    const batteryLeft = this.drawTopBarBatteries(image, state);
    const trayLeft = drawTrayIcons(image, state.trayIcons, batteryLeft);

    const iconsX = clockX + font.measureText(clock) + 16;
    const maxIcons = Math.max(0, ((trayLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) {
        noteStaleDataUsed();
      }
      const iconY = ((TOP_BAR_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0;
      for (let index = 0; index < icons.length; index++) {
        image.bitBlt(icons[index]!, iconsX + index * (NOTIFICATION_ICON_SIZE + 4), iconY, {
          transparentZero: true,
        });
      }
    }
  }

  /**
   * Labelled battery indicators for the phone and the G2, right-aligned in
   * the top bar, following the dashboard card's icon/percentage setting.
   * Returns the left edge of the battery block.
   */
  private drawTopBarBatteries(image: GrayImage, state: ShellChromeState): number {
    const font = getDefaultSmallFont();
    const percentageMode = batteryDisplayModeSetting.get() === "percentage";
    type BatteryItem = { label: string; percent: number; charging: boolean };
    const items: BatteryItem[] = [];
    const phone = readPhoneBatteryState();
    if (phone.battery !== null && Number.isFinite(phone.battery)) {
      items.push({ label: "Phone", percent: phone.battery, charging: Boolean(phone.charging) });
    }
    if (state.battery.headset !== null && Number.isFinite(state.battery.headset)) {
      items.push({ label: "G2", percent: state.battery.headset, charging: Boolean(state.battery.headsetCharging) });
    }
    if (!items.length) return G2_LENS_WIDTH;

    const labelGap = 5;
    const itemGap = 12;
    const textY = Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    let x = G2_LENS_WIDTH - 8;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      const percentText = `${Math.max(0, Math.min(100, Math.round(item.percent)))}%`;
      const valueWidth = percentageMode ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
      const labelWidth = font.measureText(item.label);
      x -= labelWidth + labelGap + valueWidth;
      image.drawText(font, x, textY, item.label, 150);
      const valueX = x + labelWidth + labelGap;
      if (percentageMode) {
        if (item.charging) {
          // Inverted text marks charging, matching the dashboard card.
          image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
          image.drawText(font, valueX, textY, percentText, 1);
        } else {
          image.drawText(font, valueX, textY, percentText, 200);
        }
      } else {
        const icon = drawBattery(item.percent, item.charging);
        image.bitBlt(icon, valueX, Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
          transparentZero: true,
        });
      }
      x -= itemGap;
    }
    return x + itemGap;
  }
}

/**
 * Draw app tray icons right-to-left, ending just left of the battery block;
 * returns the left edge of the tray region.
 */
function drawTrayIcons(image: GrayImage, trayIcons: GrayImage[], rightEdge: number): number {
  let x = rightEdge;
  for (let index = trayIcons.length - 1; index >= 0; index--) {
    const icon = trayIcons[index]!;
    x -= icon.width + 10;
    image.bitBlt(icon, x, Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
      transparentZero: true,
    });
  }
  return x;
}

/** Small triangle marker for sidebar overflow; direction -1 = up, 1 = down. */
function drawChevron(image: GrayImage, centerX: number, y: number, direction: -1 | 1): void {
  const half = 5;
  const tipY = direction < 0 ? y - 3 : y + 3;
  image.drawLine(centerX - half, y, centerX, tipY, 140);
  image.drawLine(centerX, tipY, centerX + half, y, 140);
}
