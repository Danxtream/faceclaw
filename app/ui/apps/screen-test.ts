import { getDefaultSmallFont } from "../../graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const COLOR_VALUE_COUNT = 256;
const COLOR_VALUE_STEP = 1;
const SWATCH_COUNT = COLOR_VALUE_COUNT / COLOR_VALUE_STEP;
const GRID_COLUMNS = 16;
const GRID_ROWS = Math.ceil(SWATCH_COUNT / GRID_COLUMNS);
const CELL_WIDTH = Math.floor(G2_LENS_WIDTH / GRID_COLUMNS);
//const CELL_HEIGHT = Math.floor(G2_LENS_HEIGHT / GRID_ROWS);
const CELL_HEIGHT = 30;
const GRID_X = Math.floor((G2_LENS_WIDTH - CELL_WIDTH * GRID_COLUMNS) / 2);
const LABEL_Y_OFFSET = 0;
const SWATCH_Y_OFFSET = 12;
const SWATCH_WIDTH = 24;
const SWATCH_HEIGHT = 16;

export class ScreenTestLayer implements Layer {
  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const font = getDefaultSmallFont();

    for (let value = 0; value < COLOR_VALUE_COUNT; value += COLOR_VALUE_STEP) {
      const slot = value / COLOR_VALUE_STEP;
      const col = slot % GRID_COLUMNS;
      const row = Math.floor(slot / GRID_COLUMNS);
      const cellX = GRID_X + col * CELL_WIDTH;
      const cellY = row * CELL_HEIGHT;
      const label = String(value);
      const labelX = cellX + Math.max(0, Math.floor((CELL_WIDTH - font.measureText(label)) / 2));
      const swatchX = cellX + Math.floor((CELL_WIDTH - SWATCH_WIDTH) / 2);

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