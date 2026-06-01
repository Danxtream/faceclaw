import { clamp } from "~/util/numeric-util";
import { formatRelativeTime } from "~/util/date-util";
import { BdfFont, getDefaultSmallFont } from "../graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import {
  dismissNotification,
  invokeNotificationAction,
  readActiveNotifications,
  type AndroidNotification,
  type AndroidNotificationAction,
} from "../native/notification-icons";
import { type DashboardInputEvent, type Layer, type LayerContext, type PaintBelow } from "./layers";

const PAGE_X = 12;
const PAGE_Y = 12;
const LIST_TOP = 38;
const LIST_BOTTOM = G2_LENS_HEIGHT;
const CARD_X = 20;
const CARD_WIDTH = G2_LENS_WIDTH - 40;
const CARD_TEXT_WIDTH = CARD_WIDTH - 24;
const LINE_HEIGHT = 14;
const CARD_GAP = 6;
const MAX_NOTIFICATIONS = 50;

type CardLayout = {
  notification: AndroidNotification;
  height: number;
  lines: string[];
};

type DetailMenuItem =
  | { kind: "back"; label: string }
  | { kind: "action"; label: string; action: AndroidNotificationAction }
  | { kind: "dismiss"; label: string };

export class NotificationsListLayer implements Layer {
  private selectedKey = "";

  constructor(private readonly exitToRootMenu?: (ctx: LayerContext) => void) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    const layouts = notifications.map((notification, index) =>
      buildNotificationCardLayout(font, notification, index === selectedIndex),
    );

    image.drawText(font, PAGE_X + 12, PAGE_Y + 9, "Notifications", 220);
    image.drawText(font, G2_LENS_WIDTH - 96, PAGE_Y + 9, `${selectedIndex+1}/${notifications.length}`, 150);

    if (!notifications.length) {
      image.drawText(font, 24, 72, "No current Android notifications.", 190);
      image.drawText(font, 24, 252, "Double-click to return to dashboard", 110);
      return image;
    }

    const scrollY = scrollForSelected(layouts, selectedIndex, LIST_BOTTOM - LIST_TOP);
    let cursorY = LIST_TOP - scrollY;
    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      if (cursorY + layout.height >= LIST_TOP && cursorY <= LIST_BOTTOM) {
        drawNotificationCard(image, font, layout, CARD_X, cursorY, CARD_WIDTH, index === selectedIndex);
      }
      cursorY += layout.height + CARD_GAP;
      if (cursorY > LIST_BOTTOM + 80) break;
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    if (event.type === "double-click") {
      if (this.exitToRootMenu) {
        this.exitToRootMenu(ctx);
      } else {
        ctx.stack.clearToBase();
      }
      return;
    }
    if (!notifications.length) return;

    if (event.type === "scroll-up") {
      this.selectedKey = notifications[Math.max(0, selectedIndex - 1)]!.key;
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedKey = notifications[Math.min(notifications.length - 1, selectedIndex + 1)]!.key;
      return;
    }
    if (event.type === "click") {
      ctx.stack.push(new SingleNotificationLayer(notifications[selectedIndex]!.key));
    }
  }

  private resolveSelectedIndex(notifications: AndroidNotification[]): number {
    if (!notifications.length) {
      this.selectedKey = "";
      return -1;
    }
    let index = notifications.findIndex((notification) => notification.key === this.selectedKey);
    if (index < 0) {
      index = 0;
      this.selectedKey = notifications[0]!.key;
    }
    return index;
  }
}

export class SingleNotificationLayer implements Layer {
  private selectedMenuIndex = 0;

  constructor(private readonly notificationKey: string) {}

  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const notification = readActiveNotifications(MAX_NOTIFICATIONS).find((item) => item.key === this.notificationKey);

    if (!notification) {
      image.drawText(font, PAGE_X + 12, PAGE_Y + 9, "Notification", 220);
      image.drawText(font, 24, 72, "This notification is no longer active.", 190);
      image.drawText(font, 24, 252, "Double-click to go back", 110);
      return image;
    }

    const menu = buildDetailMenu(notification);
    this.selectedMenuIndex = clamp(this.selectedMenuIndex, 0, Math.max(0, menu.length - 1));
    drawDetailContent(image, font, notification);
    drawDetailMenu(image, font, menu, this.selectedMenuIndex);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const notification = readActiveNotifications(MAX_NOTIFICATIONS).find((item) => item.key === this.notificationKey);
    const menu = notification ? buildDetailMenu(notification) : [{ kind: "back", label: "Back" } as DetailMenuItem];

    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "scroll-up") {
      this.selectedMenuIndex = Math.max(0, this.selectedMenuIndex - 1);
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedMenuIndex = Math.min(menu.length - 1, this.selectedMenuIndex + 1);
      return;
    }
    if (event.type !== "click") return;

    const item = menu[this.selectedMenuIndex]!;
    if (item.kind === "back") {
      ctx.stack.pop();
    } else if (item.kind === "action") {
      invokeNotificationAction(this.notificationKey, item.action.index);
    } else if (item.kind === "dismiss") {
      dismissNotification(this.notificationKey);
      ctx.stack.pop();
    }
  }
}


function buildNotificationCardLayout(font: BdfFont, notification: AndroidNotification, selected: boolean): CardLayout {
  const lines: string[] = [];
  const time = formatRelativeTime(notification.postTime);
  const title = notificationTitle(notification);
  const timeSuffix = time ? `  ${time}` : "";
  lines.push(truncateToWidth(font, `${title}${timeSuffix}`, CARD_TEXT_WIDTH));

  const appName = notification.appName || notification.packageName;
  const body = primaryNotificationBody(notification);

  if (selected) {
    if (appName && appName !== title) {
      lines.push(truncateToWidth(font, appName, CARD_TEXT_WIDTH));
    }
    if (body) {
      lines.push(...wrapText(font, body, CARD_TEXT_WIDTH).slice(0, 4));
    }
  } else if (body) {
    lines.push(truncateToWidth(font, wrapText(font, body, CARD_TEXT_WIDTH)[0]!, CARD_TEXT_WIDTH));
  }
  if (notification.actions.length) {
    lines.push(`${notification.actions.length} quick action${notification.actions.length === 1 ? "" : "s"}`);
  }
  return {
    notification,
    lines,
    height: Math.max(42, 12 + lines.length * LINE_HEIGHT),
  };
}

function drawNotificationCard(
  image: GrayImage,
  font: BdfFont,
  layout: CardLayout,
  x: number,
  y: number,
  width: number,
  selected: boolean,
): void {
  const fill = selected ? 15 : 0;
  const stroke = selected ? 110 : 38;
  image.fillRoundedRect(x, y, width, layout.height, fill, 8);
  image.drawRoundedRect(x, y, width, layout.height, stroke, 8);
  for (let index = 0; index < layout.lines.length; index++) {
    const value = index === 0 ? 140 : selected ? 235 : 185;
    image.drawText(font, x + 10, y + 7 + index * LINE_HEIGHT, layout.lines[index]!, value);
  }
}

function scrollForSelected(layouts: CardLayout[], selectedIndex: number, viewportHeight: number): number {
  if (selectedIndex < 0) return 0;
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += layouts[index]!.height + CARD_GAP;
  }
  const selectedBottom = selectedTop + layouts[selectedIndex]!.height;
  const contentHeight = layouts.reduce((sum, layout) => sum + layout.height + CARD_GAP, 0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered = selectedTop - Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function drawDetailContent(image: GrayImage, font: BdfFont, notification: AndroidNotification): void {
  const contentX = 24;
  const contentWidth = 360;
  image.drawText(font, PAGE_X + 12, PAGE_Y + 9, "Notification", 220);
  image.drawText(font, contentX, 42, `${notification.appName || notification.packageName}  ${formatRelativeTime(notification.postTime)}`, 150);

  const lines: string[] = [];
  lines.push(...wrapText(font, notification.title || "(untitled)", contentWidth));
  const body = detailNotificationBody(notification);
  if (body) {
    lines.push("");
    lines.push(...wrapText(font, body, contentWidth));
  }
  const meta = [notification.subText, notification.infoText, notification.summaryText].filter(Boolean).join("  ");
  if (meta) {
    lines.push("");
    lines.push(...wrapText(font, meta, contentWidth));
  }

  for (let index = 0; index < Math.min(lines.length, 14); index++) {
    const line = lines[index]!;
    image.drawText(font, contentX, 64 + index * LINE_HEIGHT, line, index === 0 ? 230 : 190);
  }
  if (lines.length > 14) {
    image.drawText(font, contentX, 260, "...", 140);
  }
}

function drawDetailMenu(image: GrayImage, font: BdfFont, menu: DetailMenuItem[], selectedIndex: number): void {
  const menuX = 404;
  const menuY = 24;
  const menuWidth = 148;
  for (let index = 0; index < menu.length; index++) {
    const y = menuY + index * 22;
    const selected = index === selectedIndex;
    if (selected) {
      image.fillRoundedRect(menuX - 8, y - 2, menuWidth, 19, 18, 6);
      image.drawRoundedRect(menuX - 8, y - 2, menuWidth, 19, 60, 6);
    }
    const label = truncateToWidth(font, menu[index]!.label, menuWidth - 12);
    image.drawText(font, menuX, y + 2, label, selected ? 255 : 185);
  }
}

function buildDetailMenu(notification: AndroidNotification): DetailMenuItem[] {
  return [
    { kind: "back", label: "Back" },
    ...notification.actions.map((action): DetailMenuItem => ({
      kind: "action",
      label: action.enabled ? action.title : `${action.title} (unavailable)`,
      action,
    })),
    { kind: "dismiss", label: "Dismiss" },
  ];
}

function primaryNotificationBody(notification: AndroidNotification): string {
  const title = notificationTitle(notification);
  const body = notification.bigText || notification.text || notification.lines.join(" / ") || notification.summaryText || "";
  return body === title ? "" : body;
}

function detailNotificationBody(notification: AndroidNotification): string {
  const lines = notification.lines.length ? notification.lines.join("\n") : "";
  return [notification.bigText || notification.text, lines].filter(Boolean).join("\n");
}

function truncateToWidth(font: BdfFont, text: string, width: number): string {
  if (font.measureText(text) <= width) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > width) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function notificationTitle(notification: AndroidNotification): string {
  return notification.title || notification.text || notification.summaryText || notification.appName || notification.packageName || "(untitled)";
}
