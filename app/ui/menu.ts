import { G2_LENS_HEIGHT, GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { getDefaultSmallFont, type BdfFont } from "../graphics/bdffont";
import { clamp } from "../util/numeric-util";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "./layers";

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
  text: string;
  ctx: LayerContext;
};

export type MenuItem = {
  label: string;
  onSelect: (ctx: LayerContext, menu: MenuLayer) => Promise<void> | void;
  render?: (args: MenuItemRenderArgs) => void;
};

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
  const offFill = selected ? 0 : 18;
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
    this.clampScrollToSelection(visibleRowCount);

    const image = paintBelow();
    image.fillRoundedRect(x, y, width, height, 0);
    image.drawRoundedRect(x, y, width, height, 72);
    if (this.title) {
      image.drawText(font, x + 12, y + 8, this.title, 220);
    }

    const bodyY = y + chromeTop;
    const lastVisibleRow = Math.min(this.items.length, this.scrollRow + visibleRowCount);
    for (let index = this.scrollRow; index < lastVisibleRow; index++) {
      const item = this.items[index]!;
      const rowY = bodyY + (index - this.scrollRow) * MENU_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        image.fillRoundedRect(x + 12, rowY + MENU_HIGHLIGHT_Y_OFFSET, width - 24, MENU_HIGHLIGHT_HEIGHT, MENU_HIGHLIGHT_SELECTED_BACKGROUND_FILL);
        image.drawRoundedRect(x + 12, rowY + MENU_HIGHLIGHT_Y_OFFSET, width - 24, MENU_HIGHLIGHT_HEIGHT, MENU_HIGHLIGHT_SELECTED_BORDER_STROKE);
      }
      if (item.render) {
        item.render({
          image,
          x: x + 22,
          y: rowY,
          width: width - 44,
          height: MENU_ROW_HEIGHT - 3,
          selected,
          text: item.label,
          ctx,
        });
      } else {
        image.drawText(font, x + 22, rowY + 3, item.label, selected ? 255 : 200);
      }
    }

    if (this.items.length > visibleRowCount) {
      this.drawScrollbar(image, x + width - 7, bodyY, visibleRowCount);
    }

    return image;
  }

  private clampScrollToSelection(visibleRowCount: number): void {
    if (this.selectedIndex < this.scrollRow) {
      this.scrollRow = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollRow + visibleRowCount) {
      this.scrollRow = this.selectedIndex - visibleRowCount + 1;
    }
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, this.items.length - visibleRowCount));
  }

  private drawScrollbar(image: GrayImage, trackX: number, trackY: number, visibleRowCount: number): void {
    const trackHeight = visibleRowCount * MENU_ROW_HEIGHT - 4;
    image.fillRect(trackX, trackY, 3, trackHeight, 30);
    const thumbHeight = Math.max(8, (trackHeight * visibleRowCount / this.items.length) | 0);
    const maxScrollRow = this.items.length - visibleRowCount;
    const thumbY = trackY + (((trackHeight - thumbHeight) * this.scrollRow / maxScrollRow) | 0);
    image.fillRect(trackX, thumbY, 3, thumbHeight, 120);
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
        await this.items[this.selectedIndex]!.onSelect(ctx, this);
        return;
      default:
        return;
    }
  }
}

export class TextPageLayer implements Layer {
  constructor(
    private readonly title: string,
    private readonly body: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(576, 288, 0);
    image.drawText(font, 18, 14, this.title, 220);
    image.drawRect(12, 12, 552, 264, 52);

    const wrapped = wrapText(font, this.body, 520);
    for (let index = 0; index < wrapped.length; index++) {
      image.drawText(font, 24, 42 + index * 14, wrapped[index]!, 190);
    }
    image.drawText(font, 24, 252, "Double-click to go back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
