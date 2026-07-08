import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../gestures";
import { drawSelectionHighlight } from "../menu";
import {
  hasAllFilesAccess,
  listDirectory,
  requestAllFilesAccess,
  type DirectoryEntry,
} from "../../native/file-access";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 16;
const LIST_X = 20;
const FOOTER_HEIGHT = 22;

export type FileBrowserOptions = {
  startPath: string;
  /** Files failing this are listed dimmed and cannot be picked. */
  isSupportedFile: (name: string) => boolean;
  onFilePicked: (entry: DirectoryEntry, ctx: LayerContext) => void;
  /** Double-click while already at startPath (leave the browser). */
  onLeave: () => void;
};

type BrowserRow =
  | { kind: "grant"; label: string }
  | { kind: "info"; label: string }
  | { kind: "entry"; label: string; entry: DirectoryEntry; supported: boolean };

/**
 * Minimal filesystem browser: scroll to select, click to descend into a
 * directory or pick a supported file, double-click to go up (leaving the
 * browser when already at the top). Sized to its hosting stack.
 */
export class FileBrowserLayer implements Layer {
  private currentPath: string;
  private entries: DirectoryEntry[] | null = null;
  private listingFailed = false;
  private selectedIndex = 0;
  private scrollRow = 0;

  constructor(private readonly options: FileBrowserOptions) {
    this.currentPath = options.startPath;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    this.loadEntries();
    const rows = this.buildRows();
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, rows.length - 1));

    image.drawText(font, 20, 8, "Teleprompt files", 220);
    image.drawText(font, 20, 22, truncateLeft(font, this.currentPath, width - 40), 130);

    const listHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT;
    const visibleRows = Math.max(1, (listHeight / ROW_HEIGHT) | 0);
    if (this.selectedIndex < this.scrollRow) {
      this.scrollRow = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollRow + visibleRows) {
      this.scrollRow = this.selectedIndex - visibleRows + 1;
    }
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, rows.length - visibleRows));

    const lastVisible = Math.min(rows.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < lastVisible; index++) {
      const row = rows[index]!;
      const y = HEADER_HEIGHT + (index - this.scrollRow) * ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, LIST_X - 6, y - 1, width - 2 * LIST_X + 12, ROW_HEIGHT - 1, ctx.stack.isFocused(), 4);
      }
      const value = rowValue(row, selected);
      image.drawText(font, LIST_X, y + 1, truncateRight(font, row.label, width - 2 * LIST_X), value);
    }

    image.drawText(font, 20, height - 16, `${GESTURE_CLICK} open   ${GESTURE_DOUBLE_CLICK} up / back`, 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const rows = this.buildRows();
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
        return;
      case "click": {
        const row = rows[clamp(this.selectedIndex, 0, Math.max(0, rows.length - 1))];
        if (!row) return;
        if (row.kind === "grant") {
          requestAllFilesAccess();
          this.entries = null; // re-list after the user returns from Settings
          return;
        }
        if (row.kind !== "entry") return;
        if (row.entry.isDirectory) {
          this.navigateTo(row.entry.path);
        } else if (row.supported) {
          this.options.onFilePicked(row.entry, ctx);
        }
        return;
      }
      case "double-click": {
        if (this.currentPath === this.options.startPath) {
          this.options.onLeave();
          return;
        }
        const parent = this.currentPath.slice(0, this.currentPath.lastIndexOf("/"));
        this.navigateTo(parent.length >= this.options.startPath.length ? parent : this.options.startPath);
        return;
      }
      default:
        return;
    }
  }

  private navigateTo(path: string): void {
    this.currentPath = path;
    this.entries = null;
    this.selectedIndex = 0;
    this.scrollRow = 0;
  }

  private loadEntries(): void {
    if (this.entries !== null) return;
    const listing = listDirectory(this.currentPath);
    this.listingFailed = listing === null;
    this.entries = listing ?? [];
  }

  private buildRows(): BrowserRow[] {
    this.loadEntries();
    const rows: BrowserRow[] = [];
    if (!hasAllFilesAccess()) {
      rows.push({ kind: "grant", label: "Grant file access (opens phone Settings)" });
    }
    for (const entry of this.entries ?? []) {
      rows.push({
        kind: "entry",
        entry,
        supported: entry.isDirectory || this.options.isSupportedFile(entry.name),
        label: entry.isDirectory ? `${entry.name}/` : entry.name,
      });
    }
    if (!rows.length || (this.listingFailed && rows.every((row) => row.kind !== "entry"))) {
      rows.push({ kind: "info", label: this.listingFailed ? "(unreadable directory)" : "(empty directory)" });
    }
    return rows;
  }
}

function rowValue(row: BrowserRow, selected: boolean): number {
  if (row.kind === "info") return 120;
  if (row.kind === "grant") return selected ? 255 : 210;
  if (!row.supported) return selected ? 140 : 100;
  return selected ? 255 : 200;
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
