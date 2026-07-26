import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import type { DirectoryEntry } from "../../native/file-access";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { Layer, type DashboardInputEvent, type LayerContext, type PaintBelow } from "../layers";
import { drawSelectionHighlight } from "../menu";

const DIALOG_X = 8;
const DIALOG_Y = 8;
const DIALOG_WIDTH = 272;
const PADDING = 10;
const INFO_LINE_STEP = 14;
const ACTION_ROW_HEIGHT = 20;
const MAX_NAME_LINES = 3;

export type FileInfoAction = {
  label: string;
  onSelect: (ctx: LayerContext) => Promise<void> | void;
};

/**
 * The picked-file dialog: metadata (full untruncated name, size, modified
 * date) followed by the open actions for viewable file types — possibly none
 * for files nothing can open. Opened by the browser for every file;
 * double-click closes it.
 */
export class FileInfoDialogLayer implements Layer {
  private selectedIndex = 0;

  constructor(
    private readonly entry: DirectoryEntry,
    private readonly actions: FileInfoAction[],
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { height: viewportHeight } = ctx.stack.getBaseSize();
    const image = paintBelow();

    const textWidth = DIALOG_WIDTH - 2 * PADDING - 4;
    const nameLines = wrapText(font, this.entry.name, textWidth, { breakLongWords: true }).slice(0, MAX_NAME_LINES);
    const infoLines = [
      `Size: ${formatSize(this.entry.sizeBytes)}`,
      `Modified: ${formatDate(this.entry.modifiedMs)}`,
    ];
    const bodyTop = PADDING + (nameLines.length + infoLines.length) * INFO_LINE_STEP + 6;
    const bodyHeight = this.actions.length ? this.actions.length * ACTION_ROW_HEIGHT : INFO_LINE_STEP;
    const height = Math.min(bodyTop + bodyHeight + PADDING, viewportHeight - 2 * DIALOG_Y);

    // Fill 1, not 0: identical after 4bpp quantization, but 0 is the
    // transparent color key when painting on the shell surface.
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 1);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 72);

    let y = DIALOG_Y + PADDING;
    for (const line of nameLines) {
      image.drawText(font, DIALOG_X + PADDING + 2, y, line, 230);
      y += INFO_LINE_STEP;
    }
    for (const line of infoLines) {
      image.drawText(font, DIALOG_X + PADDING + 2, y, line, 150);
      y += INFO_LINE_STEP;
    }
    y += 6;

    if (!this.actions.length) {
      image.drawText(font, DIALOG_X + PADDING + 2, y + 3, `${GESTURE_DOUBLE_CLICK} close`, 110);
      return image;
    }
    const focused = ctx.stack.isFocused();
    for (let index = 0; index < this.actions.length; index++) {
      const rowY = y + index * ACTION_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, DIALOG_X + 12, rowY, DIALOG_WIDTH - 24, ACTION_ROW_HEIGHT - 1, focused, 8);
      }
      image.drawText(font, DIALOG_X + 22, rowY + 3, this.actions[index]!.label, selected ? 255 : 200);
    }
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
        if (this.actions.length) {
          this.selectedIndex = (this.selectedIndex + this.actions.length - 1) % this.actions.length;
        }
        return;
      case "scroll-down":
        if (this.actions.length) {
          this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
        }
        return;
      case "click":
        await this.actions[this.selectedIndex]?.onSelect(ctx);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ms: number): string {
  if (!ms) return "unknown";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
