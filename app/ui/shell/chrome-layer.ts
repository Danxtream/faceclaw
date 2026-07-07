import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont } from "../../graphics/bdffont";
import { drawBattery } from "../../graphics/battery";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
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
};

/** Reusable placeholder window icon: rounded outline with a single letter. */
export function makeLetterWindowIcon(letter: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size) => {
    const font = getDefaultMediumFont();
    image.drawRoundedRect(x, y, size, size, 120, 6);
    const textX = x + Math.max(0, ((size - font.measureText(letter)) / 2) | 0);
    const textY = y + Math.max(0, ((size - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, textY, letter, 210);
  };
}

/**
 * Base layer of the shell surface: the window sidebar on the left and the
 * status top bar. Everything not explicitly painted stays 0 (transparent on
 * the color-key shell surface), so the app viewport shows through.
 */
export class ShellChromeLayer implements Layer {
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
    for (let index = 0; index < state.windows.length; index++) {
      const window = state.windows[index]!;
      const y = TOP_BAR_HEIGHT + 6 + index * (ICON_SIZE + ICON_SPACING);
      if (y + ICON_SIZE > G2_LENS_HEIGHT) break;
      if (index === state.selectedIndex) {
        const highlight = state.focus === "sidebar" ? 200 : 70;
        image.drawRoundedRect(0, y - 2, SIDEBAR_WIDTH - 3, ICON_SIZE + 4, highlight, 6);
      }
      window.drawIcon(image, ICON_MARGIN_X, y, ICON_SIZE);
      if (window.attention) {
        image.fillRoundedRect(ICON_MARGIN_X + ICON_SIZE - 7, y - 1, 8, 8, 255, 4);
      }
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

    let batteryLeft = G2_LENS_WIDTH;
    if (state.battery.headset !== null) {
      const battery = drawBattery(state.battery.headset, Boolean(state.battery.headsetCharging));
      batteryLeft = G2_LENS_WIDTH - battery.width - 8;
      image.bitBlt(battery, batteryLeft, Math.max(0, ((TOP_BAR_HEIGHT - battery.height) / 2) | 0), {
        transparentZero: true,
      });
    }

    const iconsX = clockX + font.measureText(clock) + 16;
    const maxIcons = Math.max(0, ((batteryLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
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
}
