import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { loadImageFileAsGray } from "../../native/image-files";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const MARGIN_X = 18;
const TITLE_Y = 8;
const BODY_TOP = 24;
const BODY_MARGIN = 2;

/**
 * Image viewer for a file on disk: title line, then the image decoded to
 * grayscale and downscaled to fit the remaining area (never upscaled).
 * Double-click closes it. Sized to its hosting stack (a Files document
 * window, or pushed over the file browser for view-in-place).
 */
export class ImageViewerLayer implements Layer {
  private image: GrayImage | null = null;
  private loadAttempted = false;

  constructor(
    private readonly path: string,
    private readonly title: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const out = new GrayImage(width, height, 0);
    out.drawText(font, MARGIN_X, TITLE_Y, truncateToWidth(font, this.title, width - 2 * MARGIN_X), 220);

    const bodyHeight = height - BODY_TOP - BODY_MARGIN;
    if (!this.loadAttempted) {
      this.loadAttempted = true;
      this.image = loadImageFileAsGray(this.path, width - 2 * BODY_MARGIN, bodyHeight);
    }
    if (!this.image) {
      out.drawText(font, MARGIN_X, BODY_TOP + 16, "(could not load image)", 160);
      out.drawText(font, MARGIN_X, height - 16, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return out;
    }
    out.bitBlt(
      this.image,
      Math.round((width - this.image.width) / 2),
      BODY_TOP + Math.round((bodyHeight - this.image.height) / 2),
    );
    return out;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
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
