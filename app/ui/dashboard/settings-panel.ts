import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../gestures";
import { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { drawSelectionHighlight, MenuItem, MenuLayer, type MenuLayout } from "../menu";
import { shell } from "../shell/shell";

/**
 * One left-column entry. `items` are the right-column rows (reusing the shared
 * MenuItem builders). `renderDetail`, when set, replaces the row list with
 * custom informational content (e.g. About) and makes the pane non-interactive.
 */
export type SettingsSection = {
  label: string;
  items: MenuItem[];
  renderDetail?: (args: {
    image: GrayImage;
    x: number;
    y: number;
    width: number;
    height: number;
    ctx: LayerContext;
  }) => void;
};

const PAD = 8;
const ROW_H = 20;
const LEFT_W = 150;
// A throwaway menu to satisfy MenuItem.onSelect's second parameter; the
// settings items never use it (they act via ctx only).
const NO_MENU = new MenuLayer(null, []);

/**
 * Two-column (master-detail) settings UI. The left column lists sections; the
 * right column previews the highlighted section's contents. A tap moves focus
 * into the right column, a double-tap moves it back out (and from the left
 * column, out to the sidebar). Third-level menus open as centered modals.
 */
export class SettingsPanelLayer implements Layer {
  private leftIndex = 0;
  private rightIndex = 0;
  private focus: "left" | "right" = "left";
  private leftScroll = 0;
  private rightScroll = 0;

  constructor(private readonly sections: SettingsSection[]) {}

  private section(): SettingsSection {
    return this.sections[clamp(this.leftIndex, 0, this.sections.length - 1)]!;
  }

  /** Select a left-column section by label (deep link, e.g. from an app's menu). */
  focusSection(label: string): void {
    const index = this.sections.findIndex((section) => section.label === label);
    if (index < 0) return;
    this.leftIndex = index;
    this.focus = "left";
    this.resetRight();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const appFocused = ctx.stack.isFocused();

    this.leftIndex = clamp(this.leftIndex, 0, this.sections.length - 1);
    const section = this.section();
    const rightItems = section.items;
    this.rightIndex = clamp(this.rightIndex, 0, Math.max(0, rightItems.length - 1));

    const top = PAD;
    const listBottom = height - PAD - 12; // leave a row for the gesture hint

    // Left column: section labels.
    const leftRows = Math.max(1, ((listBottom - top) / ROW_H) | 0);
    this.leftScroll = clampScroll(this.leftIndex, this.leftScroll, leftRows, this.sections.length);
    for (let i = this.leftScroll; i < Math.min(this.sections.length, this.leftScroll + leftRows); i++) {
      const rowY = top + (i - this.leftScroll) * ROW_H;
      const selected = i === this.leftIndex;
      if (selected) {
        drawSelectionHighlight(image, PAD - 2, rowY, LEFT_W, ROW_H - 2, appFocused && this.focus === "left", 6);
      }
      image.drawText(font, PAD + 8, rowY + 4, this.sections[i]!.label, selected ? 255 : 200);
    }

    // Column divider (a light rule, not a full border).
    const divX = PAD + LEFT_W + 6;
    image.drawLine(divX, top, divX, listBottom, 40);

    // Right column: the highlighted section's contents.
    const rightX = divX + 14;
    const rightW = width - rightX - PAD;
    if (section.renderDetail) {
      section.renderDetail({ image, x: rightX, y: top, width: rightW, height: listBottom - top, ctx });
    } else if (rightItems.length) {
      const rightRows = Math.max(1, ((listBottom - top) / ROW_H) | 0);
      this.rightScroll = clampScroll(this.rightIndex, this.rightScroll, rightRows, rightItems.length);
      for (let i = this.rightScroll; i < Math.min(rightItems.length, this.rightScroll + rightRows); i++) {
        const item = rightItems[i]!;
        const rowY = top + (i - this.rightScroll) * ROW_H;
        // A selection only appears once focus is in the right column; before
        // that the pane is a preview of what tapping would open.
        const selected = this.focus === "right" && i === this.rightIndex;
        if (selected) {
          drawSelectionHighlight(image, rightX - 2, rowY, rightW + 2, ROW_H - 2, appFocused, 6);
        }
        if (item.render) {
          item.render({ image, x: rightX + 8, y: rowY, width: rightW - 16, height: ROW_H - 3, selected, text: item.label, ctx });
        } else {
          image.drawText(font, rightX + 8, rowY + 4, item.label, selected ? 255 : 200);
        }
      }
    }

    const hint =
      this.focus === "left"
        ? `${GESTURE_SCROLL} section   ${GESTURE_CLICK} open   ${GESTURE_DOUBLE_CLICK} exit`
        : `${GESTURE_SCROLL} item   ${GESTURE_CLICK} select   ${GESTURE_DOUBLE_CLICK} back`;
    image.drawText(font, PAD, height - 10, hint, 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (this.focus === "left") {
      switch (event.type) {
        case "scroll-up":
          this.leftIndex = (this.leftIndex + this.sections.length - 1) % this.sections.length;
          this.resetRight();
          return;
        case "scroll-down":
          this.leftIndex = (this.leftIndex + 1) % this.sections.length;
          this.resetRight();
          return;
        case "click":
          // Only enter sections that have something interactive on the right.
          if (this.section().items.length) {
            this.focus = "right";
            this.resetRight();
          }
          return;
        case "double-click":
          shell.yieldFocusToSidebar();
          return;
        default:
          return;
      }
    }

    const items = this.section().items;
    switch (event.type) {
      case "scroll-up":
        if (items.length) this.rightIndex = (this.rightIndex + items.length - 1) % items.length;
        return;
      case "scroll-down":
        if (items.length) this.rightIndex = (this.rightIndex + 1) % items.length;
        return;
      case "click":
        if (items.length) await items[clamp(this.rightIndex, 0, items.length - 1)]!.onSelect(ctx, NO_MENU);
        return;
      case "double-click":
        this.focus = "left";
        return;
      default:
        return;
    }
  }

  private resetRight(): void {
    this.rightIndex = 0;
    this.rightScroll = 0;
  }
}

/**
 * Open a third-level menu as a centered, bordered modal over the panel. Reuses
 * MenuLayer (which draws the border and self-closes on double-click).
 */
export function openSettingsSubMenu(ctx: LayerContext, title: string, items: MenuItem[]): void {
  const { width, height } = ctx.stack.getBaseSize();
  const menuW = Math.min(320, width - 40);
  const menuH = 16 + PAD + items.length * ROW_H + PAD;
  const layout: MenuLayout = {
    x: ((width - menuW) / 2) | 0,
    y: ((height - menuH) / 2) | 0,
    width: menuW,
    minHeight: menuH,
    maxHeight: menuH,
  };
  ctx.stack.push(new MenuLayer(title, items, layout));
}

function clampScroll(selected: number, scroll: number, visible: number, count: number): number {
  if (selected < scroll) {
    scroll = selected;
  } else if (selected >= scroll + visible) {
    scroll = selected - visible + 1;
  }
  return clamp(scroll, 0, Math.max(0, count - visible));
}
