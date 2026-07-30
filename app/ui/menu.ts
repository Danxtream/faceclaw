import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { getDefaultSmallFont, type BdfFont } from "../graphics/bdffont";
import { clamp } from "../util/numeric-util";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "./layers";

import { GESTURE_DOUBLE_CLICK } from "./gestures";
const DEFAULT_MENU_X = 8;
const DEFAULT_MENU_Y = 8;
const DEFAULT_MENU_WIDTH = 272;
// Menus grow with their item count, from half the screen (matching the old
// fixed quarter-screen-era look) up to the full screen, then scroll.
const DEFAULT_MENU_MIN_HEIGHT = G2_LENS_HEIGHT / 2 - 2 * DEFAULT_MENU_Y;
const MENU_TITLE_HEIGHT = 16;
const MENU_ROW_HEIGHT = 20;
const MENU_BODY_PADDING = 8;
const MENU_HIGHLIGHT_Y_OFFSET = 0;
const MENU_TOGGLE_SWITCH_Y_OFFSET = 1;
const MENU_HIGHLIGHT_HEIGHT = MENU_ROW_HEIGHT - 1;
const MENU_HIGHLIGHT_SELECTED_BACKGROUND_FILL = 15;
const MENU_HIGHLIGHT_SELECTED_BORDER_STROKE = 45;

export type MenuLayout = {
  x: number;
  y: number;
  width: number;
  /** Smallest box to draw even when items don't fill it. Default: top half of the screen. */
  minHeight?: number;
  /** Height cap before the menu starts scrolling. Default: the full screen. */
  maxHeight?: number;
};

export type MenuItemRenderArgs = {
  image: GrayImage;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  disabled: boolean;
  text: string;
  ctx: LayerContext;
};

export type MenuItem = {
  label: string;
  /** Extended description; the Settings panel shows it below the list while the item is selected. */
  description?: string;
  /** Disabled rows stay visible but render dimly and ignore clicks. */
  disabled?: boolean | (() => boolean);
  onSelect: (ctx: LayerContext, menu: MenuLayer) => Promise<void> | void;
  render?: (args: MenuItemRenderArgs) => void;
};

/**
 * Draw a selection highlight for a list row. A focused list fills the row and
 * outlines it; a visible-but-unfocused list draws only the outline, so the
 * selection stays legible without implying it will receive input.
 */
export function drawSelectionHighlight(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  focused: boolean,
  radius = 6,
): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, MENU_HIGHLIGHT_SELECTED_BACKGROUND_FILL, radius);
  }
  image.drawRoundedRect(x, y, width, height, MENU_HIGHLIGHT_SELECTED_BORDER_STROKE, radius);
}

/**
 * Move a list's scroll position the minimum distance needed to keep the
 * selected row inside the visible window, clamped to the list bounds.
 * Returns the new scroll row (the index of the first visible item).
 */
export function scrollToKeepSelectionVisible(
  scrollRow: number,
  selectedIndex: number,
  visibleRowCount: number,
  itemCount: number,
): number {
  if (selectedIndex < scrollRow) {
    scrollRow = selectedIndex;
  } else if (selectedIndex >= scrollRow + visibleRowCount) {
    scrollRow = selectedIndex - visibleRowCount + 1;
  }
  return clamp(scrollRow, 0, Math.max(0, itemCount - visibleRowCount));
}

/**
 * Draw a vertical scrollbar beside a row-scrolled list: a dim track with a
 * proportional thumb positioned by scroll fraction. Only call when the list
 * actually overflows (itemCount > visibleRowCount).
 */
export function drawListScrollbar(
  image: GrayImage,
  trackX: number,
  trackY: number,
  trackHeight: number,
  scrollRow: number,
  visibleRowCount: number,
  itemCount: number,
): void {
  image.fillRect(trackX, trackY, 3, trackHeight, 30);
  const thumbHeight = Math.max(8, (trackHeight * visibleRowCount / itemCount) | 0);
  const maxScrollRow = Math.max(1, itemCount - visibleRowCount);
  const thumbY = trackY + (((trackHeight - thumbHeight) * clamp(scrollRow, 0, maxScrollRow) / maxScrollRow) | 0);
  image.fillRect(trackX, thumbY, 3, thumbHeight, 120);
}

/**
 * Draw a ">" submenu indicator inset at the right edge of a row's selection
 * highlight box, vertically centered within it. Pass the same rect as the
 * row's drawSelectionHighlight call (the row need not actually be selected).
 */
export function drawSubmenuIndicator(
  image: GrayImage,
  font: BdfFont,
  highlightX: number,
  highlightY: number,
  highlightWidth: number,
  highlightHeight: number,
  value: number,
): void {
  const arrow = ">";
  const x = highlightX + highlightWidth - font.measureText(arrow) - 4;
  const y = highlightY + (((highlightHeight - font.lineHeight) / 2) | 0);
  image.drawText(font, x, y, arrow, value);
}

export function drawToggleMenuItem(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  width: number,
  label: string,
  enabled: boolean,
  selected: boolean,
): void {
  const switchWidth = 34;
  const switchHeight = 16;
  const switchX = x + width - switchWidth - 2;
  const switchY = y + MENU_TOGGLE_SWITCH_Y_OFFSET;
  image.drawText(font, x, y + 3, label, 200);
  const offFill = selected ? 1 : 18;
  image.fillRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 70 : offFill, 8);
  image.drawRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 130 : 55, 8);
  const knobSize = 12;
  const knobX = enabled ? switchX + switchWidth - knobSize - 2 : switchX + 2;
  image.fillRoundedRect(knobX, switchY + 2, knobSize, knobSize, enabled ? 230 : selected ? 170 : 90, 6);
}

export function drawRightValueMenuItem(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
): void {
  image.drawText(font, x, y + 3, label, 200);
  const valueX = x + width - font.measureText(value) - 2;
  image.drawText(font, valueX, y + 3, value, 220);
}

export class MenuLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;

  constructor(
    private readonly title: string | null,
    private readonly items: MenuItem[],
    private readonly layout: MenuLayout = {
      x: DEFAULT_MENU_X,
      y: DEFAULT_MENU_Y,
      width: DEFAULT_MENU_WIDTH,
    },
    public readonly paintOverBase = false,
  ) {}

  /** Start a newly opened picker on its current value. */
  selectItem(index: number): this {
    this.selectedIndex = clamp(index, 0, Math.max(0, this.items.length - 1));
    return this;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { x, y, width } = this.layout;
    const chromeTop = (this.title ? MENU_TITLE_HEIGHT : 0) + MENU_BODY_PADDING;
    const minHeight = this.layout.minHeight ?? DEFAULT_MENU_MIN_HEIGHT;
    const maxHeight = Math.min(
      this.layout.maxHeight ?? G2_LENS_HEIGHT - y - DEFAULT_MENU_Y,
      G2_LENS_HEIGHT - y,
    );
    const contentHeight = chromeTop + this.items.length * MENU_ROW_HEIGHT + MENU_BODY_PADDING;
    const height = clamp(contentHeight, Math.min(minHeight, maxHeight), maxHeight);
    const visibleRowCount = Math.max(1, ((height - chromeTop - MENU_BODY_PADDING) / MENU_ROW_HEIGHT) | 0);
    this.scrollRow = scrollToKeepSelectionVisible(
      this.scrollRow,
      this.selectedIndex,
      visibleRowCount,
      this.items.length,
    );

    const image = paintBelow();
    // Fill 1, not 0: identical after 4bpp quantization, but 0 is the
    // transparent color key when a menu paints on the shell surface.
    image.fillRoundedRect(x, y, width, height, 1);
    image.drawRoundedRect(x, y, width, height, 72);
    if (this.title) {
      image.drawText(font, x + 12, y + 8, this.title, 220);
    }

    const bodyY = y + chromeTop;
    const focused = ctx.stack.isFocused();
    const lastVisibleRow = Math.min(this.items.length, this.scrollRow + visibleRowCount);
    for (let index = this.scrollRow; index < lastVisibleRow; index++) {
      const item = this.items[index]!;
      const rowY = bodyY + (index - this.scrollRow) * MENU_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      const disabled = isMenuItemDisabled(item);
      if (selected) {
        drawSelectionHighlight(
          image,
          x + 12,
          rowY + MENU_HIGHLIGHT_Y_OFFSET,
          width - 24,
          MENU_HIGHLIGHT_HEIGHT,
          focused,
          8,
        );
      }
      if (item.render) {
        item.render({
          image,
          x: x + 22,
          y: rowY,
          width: width - 44,
          height: MENU_ROW_HEIGHT - 3,
          selected,
          disabled,
          text: item.label,
          ctx,
        });
      } else {
        image.drawText(font, x + 22, rowY + 3, item.label, disabled ? 70 : selected ? 255 : 200);
      }
    }

    if (this.items.length > visibleRowCount) {
      drawListScrollbar(
        image,
        x + width - 7,
        bodyY,
        visibleRowCount * MENU_ROW_HEIGHT - 4,
        this.scrollRow,
        visibleRowCount,
        this.items.length,
      );
    }

    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (!this.items.length) {
      if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = (this.selectedIndex + this.items.length - 1) % this.items.length;
        return;
      case "scroll-down":
        this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      case "click":
        if (!isMenuItemDisabled(this.items[this.selectedIndex]!)) {
          await this.items[this.selectedIndex]!.onSelect(ctx, this);
        }
        return;
      default:
        return;
    }
  }
}

/** Open a centered, bordered menu over the current layer. */
export function openModalMenu(
  ctx: LayerContext,
  title: string,
  items: MenuItem[],
  initialSelectedIndex = 0,
): void {
  const { width, height } = ctx.stack.getBaseSize();
  const menuWidth = Math.min(320, width - 40);
  const naturalHeight = MENU_TITLE_HEIGHT + 2 * MENU_BODY_PADDING + items.length * MENU_ROW_HEIGHT;
  const menuHeight = Math.min(naturalHeight, height - 40);
  const layout: MenuLayout = {
    x: ((width - menuWidth) / 2) | 0,
    y: ((height - menuHeight) / 2) | 0,
    width: menuWidth,
    minHeight: menuHeight,
    maxHeight: menuHeight,
  };
  ctx.stack.push(new MenuLayer(title, items, layout).selectItem(initialSelectedIndex));
}

export function isMenuItemDisabled(item: MenuItem): boolean {
  return typeof item.disabled === "function" ? item.disabled() : item.disabled === true;
}

export class TextPageLayer implements Layer {
  constructor(
    private readonly title: string,
    private readonly body: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawText(font, 18, 14, this.title, 220);
    image.drawRect(12, 12, 552, 264, 52);

    const wrapped = wrapText(font, this.body, 520);
    for (let index = 0; index < wrapped.length; index++) {
      image.drawText(font, 24, 42 + index * 14, wrapped[index]!, 190);
    }
    image.drawText(font, 24, 252, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
