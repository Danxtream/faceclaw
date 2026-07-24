import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../gestures";
import {
  MenuLayer,
  drawListScrollbar,
  drawSelectionHighlight,
  drawSubmenuIndicator,
  scrollToKeepSelectionVisible,
} from "../menu";
import {
  mediaBrowserBridge,
  type MediaBrowseItem,
  type MediaBrowserApp,
} from "../../native/media-browser";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 16;
const LIST_X = 20;
const FOOTER_HEIGHT = 22;

export type MediaBrowseOptions = {
  app: MediaBrowserApp;
  /** Called after playback of a picked item has been requested. */
  onPlayed: (ctx: LayerContext) => void;
  /** Double-click at the library root (leave the browser). */
  onLeave: (ctx: LayerContext) => void;
};

type BrowseLevel = {
  parentId: string;
  title: string;
  /** null while the listing is loading. */
  items: MediaBrowseItem[] | null;
  error: string;
  selectedIndex: number;
  scrollRow: number;
};

type BrowsePhase = "idle" | "connecting" | "ready" | "failed";

/**
 * Library browser over another app's MediaBrowserService (the Android Auto
 * mechanism): connecting starts the player's process if needed, so this works
 * with no media session active and the phone locked. Scroll to select, click
 * to open a folder or play an item, double-click to go up (leaving the browser
 * when already at the root).
 */
export class MediaBrowseLayer implements Layer {
  private phase: BrowsePhase = "idle";
  private connectError = "";
  private levels: BrowseLevel[] = [];
  private removed = false;

  constructor(private readonly options: MediaBrowseOptions) {}

  paint(ctx: LayerContext): GrayImage {
    if (this.phase === "idle") {
      this.startConnect(ctx);
    }
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);

    image.drawText(font, 20, 8, `Library: ${this.options.app.appName}`, 220);

    if (this.phase === "connecting" || this.phase === "idle") {
      image.drawText(font, 24, HEADER_HEIGHT + 8, `Starting ${this.options.app.appName}...`, 150);
      image.drawText(font, 20, height - 16, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }
    if (this.phase === "failed") {
      image.drawText(font, 24, HEADER_HEIGHT + 8, "Could not connect:", 180);
      image.drawText(font, 24, HEADER_HEIGHT + 24, truncateRight(font, this.connectError, width - 48), 140);
      image.drawText(font, 20, height - 16, `${GESTURE_CLICK} retry   ${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const level = this.currentLevel();
    const path = this.levels.map((entry) => entry.title).join(" / ");
    image.drawText(font, 20, 22, truncateLeft(font, path, width - 40), 130);

    if (!level || level.items === null) {
      image.drawText(font, 24, HEADER_HEIGHT + 8, level?.error ? level.error : "Loading...", level?.error ? 140 : 150);
      image.drawText(font, 20, height - 16, `${GESTURE_DOUBLE_CLICK} up / back`, 110);
      return image;
    }

    const items = level.items;
    if (!items.length) {
      image.drawText(font, 24, HEADER_HEIGHT + 8, "(empty)", 120);
      image.drawText(font, 20, height - 16, `${GESTURE_DOUBLE_CLICK} up / back`, 110);
      return image;
    }

    level.selectedIndex = clamp(level.selectedIndex, 0, items.length - 1);
    const listHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT;
    const visibleRows = Math.max(1, (listHeight / ROW_HEIGHT) | 0);
    level.scrollRow = scrollToKeepSelectionVisible(level.scrollRow, level.selectedIndex, visibleRows, items.length);

    const rowWidth = width - 2 * LIST_X;
    const lastVisible = Math.min(items.length, level.scrollRow + visibleRows);
    for (let index = level.scrollRow; index < lastVisible; index++) {
      const item = items[index]!;
      const y = HEADER_HEIGHT + (index - level.scrollRow) * ROW_HEIGHT;
      const selected = index === level.selectedIndex;
      const highlightX = LIST_X - 6;
      const highlightY = y - 1;
      const highlightWidth = rowWidth + 12;
      const highlightHeight = ROW_HEIGHT - 1;
      if (selected) {
        drawSelectionHighlight(image, highlightX, highlightY, highlightWidth, highlightHeight, ctx.stack.isFocused(), 4);
      }
      const value = selected ? 255 : 200;
      const title = truncateRight(font, item.title || "(untitled)", rowWidth - 16);
      image.drawText(font, LIST_X, y + 1, title, value);
      if (item.subtitle) {
        const titleWidth = font.measureText(title);
        const subtitleWidth = font.measureText(item.subtitle);
        if (titleWidth + subtitleWidth + 24 <= rowWidth - 16) {
          image.drawText(font, LIST_X + rowWidth - 16 - subtitleWidth, y + 1, item.subtitle, 110);
        }
      }
      if (item.browsable) {
        drawSubmenuIndicator(image, font, highlightX, highlightY, highlightWidth, highlightHeight, selected ? value : 110);
      }
    }
    if (items.length > visibleRows) {
      drawListScrollbar(
        image,
        width - 12,
        HEADER_HEIGHT,
        visibleRows * ROW_HEIGHT - 4,
        level.scrollRow,
        visibleRows,
        items.length,
      );
    }

    image.drawText(
      font,
      20,
      height - 16,
      `${GESTURE_SCROLL} select   ${GESTURE_CLICK} open/play   ${GESTURE_DOUBLE_CLICK} up / back`,
      110,
    );
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (this.phase === "failed") {
      if (event.type === "click") {
        this.phase = "idle";
        this.connectError = "";
      } else if (event.type === "double-click") {
        this.leave(ctx);
      }
      return;
    }
    if (event.type === "double-click") {
      if (this.levels.length > 1) {
        this.levels.pop();
      } else {
        this.leave(ctx);
      }
      return;
    }
    const level = this.currentLevel();
    const items = level?.items;
    if (!level || !items || !items.length) return;
    switch (event.type) {
      case "scroll-up":
        level.selectedIndex = Math.max(0, level.selectedIndex - 1);
        return;
      case "scroll-down":
        level.selectedIndex = Math.min(items.length - 1, level.selectedIndex + 1);
        return;
      case "click": {
        const item = items[clamp(level.selectedIndex, 0, items.length - 1)];
        if (!item) return;
        if (item.browsable && item.playable) {
          ctx.stack.push(
            new MenuLayer(truncateRight(getDefaultSmallFont(), item.title || "(untitled)", 230), [
              {
                label: "Play",
                onSelect: (menuCtx) => {
                  menuCtx.stack.pop();
                  this.play(menuCtx, item);
                },
              },
              {
                label: "Open",
                onSelect: (menuCtx) => {
                  menuCtx.stack.pop();
                  this.descendInto(menuCtx, item);
                },
              },
            ]),
          );
        } else if (item.browsable) {
          this.descendInto(ctx, item);
        } else if (item.playable) {
          this.play(ctx, item);
        }
        return;
      }
      default:
        return;
    }
  }

  onRemoved(): void {
    this.removed = true;
    mediaBrowserBridge.disconnect();
  }

  private currentLevel(): BrowseLevel | undefined {
    return this.levels[this.levels.length - 1];
  }

  private leave(ctx: LayerContext): void {
    this.options.onLeave(ctx);
  }

  private play(ctx: LayerContext, item: MediaBrowseItem): void {
    mediaBrowserBridge.playFromMediaId(item.mediaId);
    this.options.onPlayed(ctx);
  }

  private descendInto(ctx: LayerContext, item: MediaBrowseItem): void {
    const level: BrowseLevel = {
      parentId: item.mediaId,
      title: item.title || "(untitled)",
      items: null,
      error: "",
      selectedIndex: 0,
      scrollRow: 0,
    };
    this.levels.push(level);
    this.loadLevel(ctx, level);
  }

  private startConnect(ctx: LayerContext): void {
    this.phase = "connecting";
    mediaBrowserBridge
      .connect(this.options.app)
      .then((rootId) => {
        if (this.removed) return;
        this.phase = "ready";
        const root: BrowseLevel = {
          parentId: rootId,
          title: "Library",
          items: null,
          error: "",
          selectedIndex: 0,
          scrollRow: 0,
        };
        this.levels = [root];
        this.loadLevel(ctx, root);
        ctx.actions.requestRender();
      })
      .catch((error) => {
        if (this.removed) return;
        this.phase = "failed";
        this.connectError = error instanceof Error ? error.message : String(error);
        ctx.actions.requestRender();
      });
  }

  private loadLevel(ctx: LayerContext, level: BrowseLevel): void {
    mediaBrowserBridge
      .browse(level.parentId)
      .then((items) => {
        if (this.removed) return;
        level.items = items;
        ctx.actions.requestRender();
      })
      .catch((error) => {
        if (this.removed) return;
        level.error = error instanceof Error ? error.message : String(error);
        ctx.actions.requestRender();
      });
  }
}

function truncateRight(font: BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function truncateLeft(font: BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`...${out}`) > maxWidth) {
    out = out.slice(1);
  }
  return `...${out}`;
}
