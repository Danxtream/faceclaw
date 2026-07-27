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
import { onAnySettingChanged } from "../dashboard-settings";
import { createInProcessWindow } from "./in-process-window";
import { getFolderAssignments, getFolders, getFolderStateFingerprint } from "./launcher-folders";
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
/** Extra top inset for the folder-name header while inside a folder. */
const FOLDER_HEADER_HEIGHT = 16;

type LauncherMode = "row" | "item";

/** One cell of the grid: an app, or a folder holding some of the apps. */
type LauncherGridEntry =
  | { kind: "app"; label: string; icon: IconName; appId: string }
  | { kind: "folder"; label: string; name: string };

/**
 * The launcher grid: app and folder icons with labels, arranged in a grid.
 * Navigation has two levels so the max number of swipes to any app is halved:
 * entering from the sidebar starts in "row" mode (scroll picks a row); a tap
 * drops into "item" mode on that row, defaulting to the middle column (scroll
 * picks the item); a tap launches an app or opens a folder (the same grid,
 * restricted to that folder's apps). Double-click backs out one level (item →
 * row, folder → top grid), and from the top level yields to the sidebar.
 *
 * The folder grouping lives in the settings store (see launcher-folders.ts)
 * and is re-read every paint, so assistant folder tools take effect without
 * the layer holding any copy of the state.
 */
class LauncherGridLayer implements Layer {
  private mode: LauncherMode = "row";
  private selectedRow = 0;
  private selectedCol = 1;
  private scrollRow = 0;
  private wasFocused = false;
  /** Folder whose contents the grid is showing, or null for the top grid. */
  private currentFolder: string | null = null;

  constructor(private readonly options: LauncherOptions) {}

  /**
   * The cells to show, computed fresh from the folder state. Self-heals
   * currentFolder: if the open folder no longer exists (the assistant
   * disbanded it), the view falls back to the top grid.
   */
  private entries(): LauncherGridEntry[] {
    const byAppId = new Map(this.options.apps.map((app) => [app.appId, app]));
    if (this.currentFolder !== null) {
      const members = (getFolders().get(this.currentFolder) ?? [])
        .map((appId) => byAppId.get(appId))
        .filter(Boolean) as LauncherAppEntry[];
      if (members.length > 0) {
        return members
          .map((app): LauncherGridEntry => ({ kind: "app", label: app.label, icon: app.icon, appId: app.appId }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      this.currentFolder = null;
    }
    const assignments = getFolderAssignments();
    const entries: LauncherGridEntry[] = [];
    // A folder cell appears only when it holds at least one known app; stale
    // assignments to removed apps are ignored.
    for (const [name, members] of getFolders()) {
      if (members.some((appId) => byAppId.has(appId))) {
        entries.push({ kind: "folder", label: name, name });
      }
    }
    for (const app of this.options.apps) {
      if (!assignments[app.appId]) {
        entries.push({ kind: "app", label: app.label, icon: app.icon, appId: app.appId });
      }
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }

  private rowCount(entryCount: number): number {
    return Math.max(1, Math.ceil(entryCount / COLS));
  }

  private itemsInRow(entryCount: number, row: number): number {
    return Math.max(0, Math.min(COLS, entryCount - row * COLS));
  }

  /** Leave the current folder, putting the selection back on its cell. */
  private exitFolder(): void {
    const folder = this.currentFolder;
    this.currentFolder = null;
    this.mode = "row";
    const index = this.entries().findIndex((entry) => entry.kind === "folder" && entry.name === folder);
    this.selectedRow = index >= 0 ? Math.floor(index / COLS) : 0;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const focused = ctx.stack.isFocused();
    // Re-entering the launcher (focus gained) resets to the top grid's row
    // selection, so the view never resumes inside a stale folder.
    if (focused && !this.wasFocused) {
      this.mode = "row";
      this.currentFolder = null;
    }
    this.wasFocused = focused;

    const entries = this.entries();
    const rows = this.rowCount(entries.length);
    this.selectedRow = clamp(this.selectedRow, 0, rows - 1);
    this.selectedCol = clamp(
      this.selectedCol,
      0,
      Math.max(0, this.itemsInRow(entries.length, this.selectedRow) - 1),
    );

    const gridTop = this.currentFolder !== null ? GRID_TOP + FOLDER_HEADER_HEIGHT : GRID_TOP;
    if (this.currentFolder !== null) {
      image.drawText(font, 8, GRID_TOP - 2, truncateText(font, this.currentFolder, width - 16), 160);
    }
    const gridBottom = height - FOOTER_HEIGHT;
    const rowH = (gridBottom - gridTop) / VISIBLE_ROWS;
    const colW = width / COLS;

    // Scroll to keep the selected row among the fully-visible rows.
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedRow, FULL_ROWS, rows);

    const rowY = (row: number) => gridTop + (row - this.scrollRow) * rowH;

    // Selection highlight (row band, or a single cell in item mode).
    const selY = rowY(this.selectedRow);
    if (this.mode === "row") {
      drawSelectionHighlight(image, 4, selY + 2, width - 8, rowH - 4, focused, 6);
    } else {
      drawSelectionHighlight(image, this.selectedCol * colW + 6, selY + 2, colW - 12, rowH - 4, focused, 6);
    }

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const row = Math.floor(index / COLS);
      if (row < this.scrollRow) continue;
      const blockTop = rowY(row) + Math.max(2, (rowH - ICON_SIZE - font.lineHeight - LABEL_GAP) / 2);
      if (blockTop >= gridBottom) break; // fully below the grid
      const centerX = (index % COLS) * colW + colW / 2;
      const icon = renderIcon(entry.kind === "app" ? entry.icon : "folder", ICON_SIZE);
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
        const label = truncateText(font, entry.label, colW - 8);
        image.drawText(font, Math.round(centerX - font.measureText(label) / 2), labelY, label, 210);
      }
    }

    const selectedEntry = entries[this.selectedRow * COLS + this.selectedCol];
    const pickVerb = selectedEntry?.kind === "folder" ? "open" : "launch";
    const hint =
      this.mode === "row"
        ? `${GESTURE_SCROLL} row   ${GESTURE_CLICK} pick   ${GESTURE_DOUBLE_CLICK} back`
        : `${GESTURE_SCROLL} item   ${GESTURE_CLICK} ${pickVerb}   ${GESTURE_DOUBLE_CLICK} row`;
    image.drawText(font, 8, height - 14, hint, 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const entries = this.entries();
    const rows = this.rowCount(entries.length);
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "scroll-down" ? 1 : -1;
        if (this.mode === "row") {
          this.selectedRow = clamp(this.selectedRow + delta, 0, rows - 1);
        } else {
          this.selectedCol = clamp(
            this.selectedCol + delta,
            0,
            Math.max(0, this.itemsInRow(entries.length, this.selectedRow) - 1),
          );
        }
        return;
      }
      case "click": {
        if (this.mode === "row") {
          this.mode = "item";
          // Default to the middle column (clamped to the row's item count).
          this.selectedCol = Math.min(
            Math.floor(COLS / 2),
            this.itemsInRow(entries.length, this.selectedRow) - 1,
          );
        } else {
          const entry = entries[this.selectedRow * COLS + this.selectedCol];
          if (!entry) return;
          if (entry.kind === "folder") {
            this.currentFolder = entry.name;
            this.mode = "row";
            this.selectedRow = 0;
            this.scrollRow = 0;
          } else {
            await this.options.launchApp(entry.appId);
          }
        }
        return;
      }
      case "double-click":
        if (this.mode === "item") {
          this.mode = "row";
        } else if (this.currentFolder !== null) {
          this.exitFolder();
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
  const created = createInProcessWindow({
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    iconLetter: "A",
    icon: "layout-grid",
    closeable: false,
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the grid handles double-click itself to
    // back out of item selection before yielding to the sidebar.
    baseLayer: new LauncherGridLayer(options),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  });
  // The assistant's folder tools change the grouping from outside the window;
  // the settings broadcast is the change signal, and the fingerprint check
  // keeps every unrelated setting change from repainting the launcher. The
  // launcher is pinned for the app's lifetime, so the subscription never needs
  // tearing down.
  let lastFolderState = getFolderStateFingerprint();
  onAnySettingChanged(() => {
    const state = getFolderStateFingerprint();
    if (state === lastFolderState) return;
    lastFolderState = state;
    created.requestRender();
  });
  return created.window;
}
