import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const COLOR_VALUE_COUNT = 256;
const COLOR_VALUE_STEP = 1;
const GRID_COLUMNS = 16;
const CELL_HEIGHT = 30;
const LABEL_Y_OFFSET = 0;
const SWATCH_Y_OFFSET = 12;
const SWATCH_WIDTH = 24;
const SWATCH_HEIGHT = 16;

export class ScreenTestLayer implements Layer {
  paint(ctx: LayerContext): GrayImage {
    // Sized to the hosting stack (the Debug tests app viewport).
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const font = getDefaultSmallFont();
    const cellWidth = Math.floor(width / GRID_COLUMNS);
    const gridX = Math.floor((width - cellWidth * GRID_COLUMNS) / 2);

    for (let value = 0; value < COLOR_VALUE_COUNT; value += COLOR_VALUE_STEP) {
      const slot = value / COLOR_VALUE_STEP;
      const col = slot % GRID_COLUMNS;
      const row = Math.floor(slot / GRID_COLUMNS);
      const cellX = gridX + col * cellWidth;
      const cellY = row * CELL_HEIGHT;
      const label = String(value);
      const labelX = cellX + Math.max(0, Math.floor((cellWidth - font.measureText(label)) / 2));
      const swatchX = cellX + Math.floor((cellWidth - SWATCH_WIDTH) / 2);

      image.drawText(font, labelX, cellY + LABEL_Y_OFFSET, label, 185);
      fillSwatch(image, swatchX, cellY + SWATCH_Y_OFFSET, SWATCH_WIDTH, SWATCH_HEIGHT, value);
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

function fillSwatch(image: GrayImage, x: number, y: number, width: number, height: number, value: number): void {
  // Values will ultimately be rounded up to the nearest multiple of 16 (since they're transmitted as 4-bit)
  // grayscale). So, for intermediate values, dither.
  if (value % 16 !== 0) {
    const baseValue = value & 0xf0;
    const fillFraction = value & 0x0f;
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) {
        const ditheredValue = ditherPattern(j, i, fillFraction)
        image.setPixel(x + j, y + i, ditheredValue ? baseValue + 16 : baseValue);
      }
    }
  } else {
    image.fillRect(x, y, width, height, value);
  }
}

function ditherPattern(x: number, y: number, fillFraction: number): number {
  const pattern = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const patternValue = pattern[y % 4][x % 4];
  return (fillFraction > patternValue) ? 1 : 0;
}