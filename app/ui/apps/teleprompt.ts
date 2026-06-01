import { wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const MARGIN_X = 18;
const TITLE_Y = 16;
const BODY_X = 18;
const BODY_Y = 44;
const BODY_WIDTH = G2_LENS_WIDTH - BODY_X - 12;
const LINE_STEP = 14;
const FOOTER_Y = 252;
const BODY_LINE_COUNT = Math.floor((FOOTER_Y - BODY_Y) / LINE_STEP);
const PAGE_STEP = Math.max(1, BODY_LINE_COUNT - 1);

export class TelepromptLayer implements Layer {
  private lines: string[] | null = null;
  private firstLine = 0;

  constructor(private readonly documentText: string | null) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(font, MARGIN_X + 4, TITLE_Y, "Teleprompt", 220);

    if (this.documentText === null) {
      const message = [
        "Open a plain text document on your phone and Share it to Faceclaw.",
      ];
      for (let index = 0; index < message.length; index++) {
        image.drawText(font, BODY_X, BODY_Y + index * LINE_STEP, message[index]!, 200);
      }
      return image;
    }

    const lines = this.getLines(font);
    const visibleLines = lines.slice(this.firstLine, this.firstLine + BODY_LINE_COUNT);
    for (let index = 0; index < visibleLines.length; index++) {
      image.drawText(font, BODY_X, BODY_Y + index * LINE_STEP, visibleLines[index]!, 230);
    }

    const currentPage = Math.floor(this.firstLine / PAGE_STEP) + 1;
    const totalPages = totalPageCount(lines.length);
    image.drawText(font, BODY_X, FOOTER_Y, `Page ${currentPage}/${totalPages}`, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.scrollBy(PAGE_STEP);
        return;
      case "scroll-up":
        this.scrollBy(-PAGE_STEP);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private scrollBy(delta: number): void {
    const lines = this.lines ?? [];
    if (lines.length <= BODY_LINE_COUNT) {
      this.firstLine = 0;
      return;
    }
    const maxFirstLine = Math.max(0, lines.length - 1);
    this.firstLine = Math.max(0, Math.min(maxFirstLine, this.firstLine + delta));
  }

  private getLines(font: BdfFont): string[] {
    if (this.lines === null) {
      this.lines = wrapTextForTeleprompt(font, this.documentText ?? "");
    }
    return this.lines;
  }
}

function wrapTextForTeleprompt(font: BdfFont, text: string): string[] {
  const normalized = text.replace(/\t/g, "    ").replace(/\r/g, "");
  return wrapText(font, normalized, BODY_WIDTH, {
    preserveLeadingWhitespace: true,
    breakLongWords: true,
  });
}

function totalPageCount(lineCount: number): number {
  if (lineCount <= BODY_LINE_COUNT) {
    return 1;
  }
  return Math.ceil((lineCount - BODY_LINE_COUNT) / PAGE_STEP) + 1;
}
