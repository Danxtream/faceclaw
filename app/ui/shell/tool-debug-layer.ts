import { G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import type { ToolDebugEntry } from "../../assistant/tool-registry";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "../layers";
import { MenuLayer, drawListScrollbar, type MenuItem } from "../menu";
import { MIN_WINDOW_HEIGHT, minWindowTop, SIDEBAR_WIDTH, TOP_BAR_HEIGHT } from "./geometry";

/**
 * Shell-overlay debug dialog (escape menu > Debug): lists the voice assistant
 * tools registered for the foreground window's app, including ones whose
 * availability gate currently blocks them. Selecting a tool opens a detail
 * page with its full name, gating state, and description.
 */

const DIALOG_X = SIDEBAR_WIDTH + 8;
const DIALOG_WIDTH = 420;
const DETAIL_WIDTH = G2_LENS_WIDTH - DIALOG_X - 8;
// Shell overlays align to the min-height window band; the detail box fills
// the band below the top bar with an 8px margin on each side.
const DETAIL_HEIGHT = MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT - 16;

/** Dialog top edge, aligned to the min-height band's content area. */
function dialogY(): number {
  return minWindowTop() + TOP_BAR_HEIGHT + 8;
}
const DETAIL_PADDING = 14;
const DETAIL_LINE_HEIGHT = 14;

export class ToolDebugMenuLayer extends MenuLayer {
  constructor(appId: string | null, entries: ToolDebugEntry[], private readonly onClosed: () => void) {
    super(appId ? `Assistant tools: ${appId}` : "Assistant tools", buildItems(appId, entries), {
      x: DIALOG_X,
      y: dialogY(),
      width: DIALOG_WIDTH,
      minHeight: 0,
    });
  }

  onRemoved(): void {
    this.onClosed();
  }
}

function buildItems(appId: string | null, entries: ToolDebugEntry[]): MenuItem[] {
  if (!entries.length) {
    return [{ label: "(no tools registered)", onSelect: (ctx) => ctx.stack.pop() }];
  }
  const prefix = appId ? `app.${appId}.` : "";
  return entries.map((entry) => {
    const name = prefix && entry.spec.name.startsWith(prefix)
      ? entry.spec.name.slice(prefix.length)
      : entry.spec.name;
    return {
      label: name,
      onSelect: (ctx) => {
        ctx.stack.push(new ToolDetailLayer(entry));
      },
      render: ({ image, x, y, width, selected }) => {
        const font = getDefaultSmallFont();
        const nameValue = selected ? 255 : entry.live ? 200 : 110;
        const status = entry.live ? entry.spec.availability : `${entry.spec.availability} (off)`;
        const statusValue = entry.live ? (selected ? 200 : 150) : 100;
        image.drawText(font, x, y + 3, name, nameValue);
        image.drawText(font, x + width - font.measureText(status) - 2, y + 3, status, statusValue);
      },
    };
  });
}

/** Full-detail page for one tool: canonical name, gating, and description. */
class ToolDetailLayer implements Layer {
  private scrollRow = 0;

  constructor(private readonly entry: ToolDebugEntry) {}

  paint(_ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    const top = dialogY();
    image.fillRoundedRect(DIALOG_X, top, DETAIL_WIDTH, DETAIL_HEIGHT, 1, 10);
    image.drawRoundedRect(DIALOG_X, top, DETAIL_WIDTH, DETAIL_HEIGHT, 72, 10);

    const textX = DIALOG_X + DETAIL_PADDING;
    const textWidth = DETAIL_WIDTH - 2 * DETAIL_PADDING - 8;
    const lines = this.buildLines(textWidth);
    const visibleRowCount = Math.max(1, ((DETAIL_HEIGHT - 2 * DETAIL_PADDING) / DETAIL_LINE_HEIGHT) | 0);
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, lines.length - visibleRowCount));

    const lastVisibleRow = Math.min(lines.length, this.scrollRow + visibleRowCount);
    for (let index = this.scrollRow; index < lastVisibleRow; index++) {
      const line = lines[index]!;
      const y = top + DETAIL_PADDING + (index - this.scrollRow) * DETAIL_LINE_HEIGHT;
      image.drawText(font, textX, y, line.text, line.value);
    }
    if (lines.length > visibleRowCount) {
      drawListScrollbar(
        image,
        DIALOG_X + DETAIL_WIDTH - 7,
        top + DETAIL_PADDING,
        DETAIL_HEIGHT - 2 * DETAIL_PADDING,
        this.scrollRow,
        visibleRowCount,
        lines.length,
      );
    }
    return image;
  }

  private buildLines(width: number): { text: string; value: number }[] {
    const font = getDefaultSmallFont();
    const spec = this.entry.spec;
    const lines: { text: string; value: number }[] = [];
    for (const text of wrapText(font, spec.name, width)) {
      lines.push({ text, value: 235 });
    }
    lines.push({
      text: `${spec.availability}${this.entry.live ? ", live" : ", not live"}${spec.proactive ? ", proactive" : ""}`,
      value: 160,
    });
    if (this.entry.windowId) {
      lines.push({ text: `window: ${this.entry.windowId}`, value: 160 });
    }
    lines.push({ text: "", value: 0 });
    for (const text of wrapText(font, spec.description, width)) {
      lines.push({ text, value: 190 });
    }
    return lines;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.scrollRow = Math.max(0, this.scrollRow - 1);
        return;
      case "scroll-down":
        this.scrollRow++;
        return;
      case "click":
      case "double-click":
        ctx.stack.pop();
        return;
    }
  }
}
