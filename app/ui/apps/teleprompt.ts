import { wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const MARGIN_X = 18;
const TITLE_Y = 16;
const BODY_X = 18;
const BODY_Y = 44;
const LINE_STEP = 14;
const FOOTER_MARGIN = 36;

/**
 * Paged text viewer for a document. Sized to its hosting stack (a teleprompt
 * document window, or pushed over the file browser for view-in-place).
 */
export class TelepromptLayer implements Layer {
  private lines: string[] | null = null;
  private wrappedForWidth = 0;
  private firstLine = 0;
  private bodyLineCount = 14;

  constructor(
    private readonly documentText: string,
    private readonly title = "Teleprompt",
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const footerY = height - FOOTER_MARGIN;
    this.bodyLineCount = Math.max(1, Math.floor((footerY - BODY_Y) / LINE_STEP));
    image.drawRect(12, 12, width - 24, height - 24, 52);
    image.drawText(font, MARGIN_X + 4, TITLE_Y, truncateToWidth(font, this.title, width - 2 * MARGIN_X - 8), 220);

    const lines = this.getLines(font, width);
    const visibleLines = lines.slice(this.firstLine, this.firstLine + this.bodyLineCount);
    for (let index = 0; index < visibleLines.length; index++) {
      image.drawText(font, BODY_X, BODY_Y + index * LINE_STEP, visibleLines[index]!, 230);
    }

    const currentPage = Math.floor(this.firstLine / this.pageStep()) + 1;
    image.drawText(font, BODY_X, footerY, `Page ${currentPage}/${this.totalPageCount(lines.length)}`, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.scrollBy(this.pageStep());
        return;
      case "scroll-up":
        this.scrollBy(-this.pageStep());
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private pageStep(): number {
    return Math.max(1, this.bodyLineCount - 1);
  }

  private scrollBy(delta: number): void {
    const lines = this.lines ?? [];
    if (lines.length <= this.bodyLineCount) {
      this.firstLine = 0;
      return;
    }
    const maxFirstLine = Math.max(0, lines.length - 1);
    this.firstLine = Math.max(0, Math.min(maxFirstLine, this.firstLine + delta));
  }

  private getLines(font: BdfFont, width: number): string[] {
    if (this.lines === null || this.wrappedForWidth !== width) {
      const normalized = this.documentText.replace(/\t/g, "    ").replace(/\r/g, "");
      this.lines = wrapText(font, normalized, width - BODY_X - 12, {
        preserveLeadingWhitespace: true,
        breakLongWords: true,
      });
      this.wrappedForWidth = width;
    }
    return this.lines;
  }

  private totalPageCount(lineCount: number): number {
    if (lineCount <= this.bodyLineCount) {
      return 1;
    }
    return Math.ceil((lineCount - this.bodyLineCount) / this.pageStep()) + 1;
  }
}

function truncateToWidth(font: BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}
