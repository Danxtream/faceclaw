import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { truncateText } from "../../graphics/textwrap";
import { GrayImage } from "../../graphics/image";
import { renderIcon, type IconName } from "../../graphics/icons";
import { clamp } from "../../util/numeric-util";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
} from "../gestures";
import { DashboardInputEvent, Layer, LayerActions, LayerContext } from "../layers";
import { drawSelectionHighlight, scrollToKeepSelectionVisible } from "../menu";
import { createInProcessWindow } from "./in-process-window";
import { shell, type ShellWindow } from "./shell";

export type LauncherAppEntry = {
  appId: string;
  label: string;
  icon: IconName;
};

export type LauncherOptions = {
  actions: LayerActions;
  apps: LauncherAppEntry[];
  launchApp: (appId: string) => Promise<void> | void;
  /** Submit a painted viewport-sized frame to this window's surface. */
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  /** Flip the launcher's compositor surface visibility on foreground changes. */
  setSurfaceVisible: (visible: boolean) => void;
};

export const LAUNCHER_WINDOW_ID = "launcher";
export const LAUNCHER_SURFACE_ID = "window:launcher";

const COLS = 5;
// Row height is sized so 3.5 rows fit the viewport: three full rows are
// always visible, and a fourth (half-clipped) row peeks in to signal that
// there are more apps to scroll to.
const VISIBLE_ROWS = 3.5;
const FULL_ROWS = Math.floor(VISIBLE_ROWS);
const GRID_TOP = 6;
const FOOTER_HEIGHT = 16;
const ICON_SIZE = 44;
const LABEL_GAP = 2;

type LauncherMode = "row" | "item";

/**
 * The launcher grid: app icons with labels, arranged in a 3-column grid.
 * Navigation has two levels so the max number of swipes to any app is halved:
 * entering from the sidebar starts in "row" mode (scroll picks a row); a tap
 * drops into "item" mode on that row, defaulting to the middle column (scroll
 * picks the app); a tap launches it. Double-click backs out one level (item →
 * row), and from the top level yields to the sidebar.
 */
class LauncherGridLayer implements Layer {
  private mode: LauncherMode = "row";
  private selectedRow = 0;
  private selectedCol = 1;
  private scrollRow = 0;
  private wasFocused = false;

  constructor(private readonly options: LauncherOptions) {}

  private rowCount(): number {
    return Math.max(1, Math.ceil(this.options.apps.length / COLS));
  }

  private itemsInRow(row: number): number {
    return Math.max(0, Math.min(COLS, this.options.apps.length - row * COLS));
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const focused = ctx.stack.isFocused();
    // Re-entering the launcher (focus gained) resets to row selection.
    if (focused && !this.wasFocused) {
      this.mode = "row";
    }
    this.wasFocused = focused;

    const rows = this.rowCount();
    this.selectedRow = clamp(this.selectedRow, 0, rows - 1);
    this.selectedCol = clamp(this.selectedCol, 0, Math.max(0, this.itemsInRow(this.selectedRow) - 1));

    const gridBottom = height - FOOTER_HEIGHT;
    const rowH = (gridBottom - GRID_TOP) / VISIBLE_ROWS;
    const colW = width / COLS;

    // Scroll to keep the selected row among the fully-visible rows.
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedRow, FULL_ROWS, rows);

    const rowY = (row: number) => GRID_TOP + (row - this.scrollRow) * rowH;

    // Selection highlight (row band, or a single cell in item mode).
    const selY = rowY(this.selectedRow);
    if (this.mode === "row") {
      drawSelectionHighlight(image, 4, selY + 2, width - 8, rowH - 4, focused, 6);
    } else {
      drawSelectionHighlight(image, this.selectedCol * colW + 6, selY + 2, colW - 12, rowH - 4, focused, 6);
    }

    for (let index = 0; index < this.options.apps.length; index++) {
      const app = this.options.apps[index]!;
      const row = Math.floor(index / COLS);
      if (row < this.scrollRow) continue;
      const blockTop = rowY(row) + Math.max(2, (rowH - ICON_SIZE - font.lineHeight - LABEL_GAP) / 2);
      if (blockTop >= gridBottom) break; // fully below the grid
      const centerX = (index % COLS) * colW + colW / 2;
      const icon = renderIcon(app.icon, ICON_SIZE);
      if (icon) {
        // Clip the icon at the grid bottom so a peeking row shows only its top.
        const clipHeight = Math.min(icon.height, Math.floor(gridBottom - blockTop));
        image.bitBlt(icon, Math.round(centerX - icon.width / 2), Math.round(blockTop), {
          height: clipHeight,
          transparentZero: true,
        });
      }
      const labelY = Math.round(blockTop + ICON_SIZE + LABEL_GAP);
      if (labelY + font.lineHeight <= gridBottom) {
        const label = truncateText(font, app.label, colW - 8);
        image.drawText(font, Math.round(centerX - font.measureText(label) / 2), labelY, label, 210);
      }
    }

    const hint =
      this.mode === "row"
        ? `${GESTURE_SCROLL} row   ${GESTURE_CLICK} pick   ${GESTURE_DOUBLE_CLICK} back`
        : `${GESTURE_SCROLL} app   ${GESTURE_CLICK} launch   ${GESTURE_DOUBLE_CLICK} row`;
    image.drawText(font, 8, height - 14, hint, 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.rowCount();
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "scroll-down" ? 1 : -1;
        if (this.mode === "row") {
          this.selectedRow = clamp(this.selectedRow + delta, 0, rows - 1);
        } else {
          this.selectedCol = clamp(this.selectedCol + delta, 0, Math.max(0, this.itemsInRow(this.selectedRow) - 1));
        }
        return;
      }
      case "click": {
        if (this.mode === "row") {
          this.mode = "item";
          // Default to the middle column (clamped to the row's app count).
          this.selectedCol = Math.min(Math.floor(COLS / 2), this.itemsInRow(this.selectedRow) - 1);
        } else {
          const index = this.selectedRow * COLS + this.selectedCol;
          const app = this.options.apps[index];
          if (app) await this.options.launchApp(app.appId);
        }
        return;
      }
      case "double-click":
        if (this.mode === "item") {
          this.mode = "row";
        } else {
          shell.yieldFocusToSidebar();
        }
        return;
      default:
        return;
    }
  }
}

/**
 * The launcher: a pinned, uncloseable in-process window presenting the app
 * grid. Selecting an app asks the controller to launch it and foregrounds the
 * new window.
 */
export function createLauncherWindow(options: LauncherOptions): ShellWindow {
  const sortedOptions: LauncherOptions = {
    ...options,
    apps: [...options.apps].sort((a, b) => a.label.localeCompare(b.label)),
  };

  return createInProcessWindow({
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    iconLetter: "A",
    icon: "layout-grid",
    closeable: false,
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the grid handles double-click itself to
    // back out of item selection before yielding to the sidebar.
    baseLayer: new LauncherGridLayer(sortedOptions),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  }).window;
}
