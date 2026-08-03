/**
 * Maneuver arrow glyphs for turn-by-turn guidance, drawn with GrayImage
 * primitives from the Directions maneuver type + modifier (no image assets).
 */
import { GrayImage } from "../../graphics/image";

/**
 * Draw the glyph for a maneuver into a size x size box at (x, y).
 * Roundabout exit numbers are the caller's job (drawn as text next to it).
 */
export function drawManeuverGlyph(
  image: GrayImage,
  x: number,
  y: number,
  size: number,
  maneuverType: string,
  modifier: string,
  value = 245,
): void {
  const type = maneuverType.toLowerCase();
  if (type === "arrive") {
    drawArriveFlag(image, x, y, size, value);
    return;
  }
  if (type === "roundabout" || type === "rotary" || type === "roundabout turn" || type === "exit roundabout" || type === "exit rotary") {
    drawRoundabout(image, x, y, size, value);
    return;
  }
  drawArrow(image, x, y, size, modifier.toLowerCase(), value);
}

/** Normalized path points (0..1 box coords, y down) for each arrow shape. */
function arrowPath(modifier: string): Array<[number, number]> {
  switch (modifier) {
    case "uturn":
      return [
        [0.68, 0.92],
        [0.68, 0.42],
        [0.62, 0.28],
        [0.5, 0.22],
        [0.38, 0.28],
        [0.32, 0.42],
        [0.32, 0.88],
      ];
    case "sharp left":
      return [
        [0.6, 0.92],
        [0.6, 0.42],
        [0.2, 0.72],
      ];
    case "left":
      return [
        [0.62, 0.92],
        [0.62, 0.42],
        [0.14, 0.42],
      ];
    case "slight left":
      return [
        [0.56, 0.92],
        [0.56, 0.5],
        [0.32, 0.16],
      ];
    case "sharp right":
      return [
        [0.4, 0.92],
        [0.4, 0.42],
        [0.8, 0.72],
      ];
    case "right":
      return [
        [0.38, 0.92],
        [0.38, 0.42],
        [0.86, 0.42],
      ];
    case "slight right":
      return [
        [0.44, 0.92],
        [0.44, 0.5],
        [0.68, 0.16],
      ];
    case "straight":
    default:
      return [
        [0.5, 0.92],
        [0.5, 0.12],
      ];
  }
}

function drawArrow(image: GrayImage, x: number, y: number, size: number, modifier: string, value: number): void {
  const path = arrowPath(modifier).map(([px, py]): [number, number] => [x + px * size, y + py * size]);
  const thickness = Math.max(2, Math.round(size / 14));
  for (let i = 1; i < path.length; i++) {
    drawThickLine(image, path[i - 1]!, path[i]!, thickness, value);
  }
  const tip = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  drawArrowHead(image, prev, tip, Math.max(5, size * 0.22), thickness, value);
}

function drawRoundabout(image: GrayImage, x: number, y: number, size: number, value: number): void {
  const cx = x + size * 0.5;
  const cy = y + size * 0.58;
  const radius = size * 0.24;
  const thickness = Math.max(2, Math.round(size / 14));
  // Circle from line segments.
  const segments = 20;
  let last: [number, number] | null = null;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const point: [number, number] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
    if (last) drawThickLine(image, last, point, thickness, value);
    last = point;
  }
  // Exit arrow upward out of the circle.
  const from: [number, number] = [cx, cy - radius];
  const to: [number, number] = [cx, y + size * 0.08];
  drawThickLine(image, from, to, thickness, value);
  drawArrowHead(image, from, to, Math.max(5, size * 0.2), thickness, value);
}

function drawArriveFlag(image: GrayImage, x: number, y: number, size: number, value: number): void {
  const poleX = Math.round(x + size * 0.36);
  const top = Math.round(y + size * 0.12);
  const bottom = Math.round(y + size * 0.92);
  const thickness = Math.max(2, Math.round(size / 16));
  drawThickLine(image, [poleX, top], [poleX, bottom], thickness, value);
  // Flag: two stacked rows of alternating blocks reads as checkered at 4bpp.
  const flagWidth = Math.round(size * 0.42);
  const rowHeight = Math.max(3, Math.round(size * 0.11));
  const blocks = 3;
  const blockWidth = Math.max(3, Math.round(flagWidth / blocks));
  for (let row = 0; row < 2; row++) {
    for (let block = 0; block < blocks; block++) {
      const bright = (row + block) % 2 === 0;
      image.fillRect(
        poleX + thickness + block * blockWidth,
        top + row * rowHeight,
        blockWidth,
        rowHeight,
        bright ? value : Math.round(value * 0.35),
      );
    }
  }
}

function drawArrowHead(
  image: GrayImage,
  from: [number, number],
  tip: [number, number],
  headLength: number,
  thickness: number,
  value: number,
): void {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = Math.PI / 5.5;
  for (const side of [-1, 1]) {
    const barbAngle = angle + Math.PI + side * spread;
    const barb: [number, number] = [
      tip[0] + headLength * Math.cos(barbAngle),
      tip[1] + headLength * Math.sin(barbAngle),
    ];
    drawThickLine(image, tip, barb, thickness, value);
  }
}

function drawThickLine(
  image: GrayImage,
  from: [number, number],
  to: [number, number],
  thickness: number,
  value: number,
): void {
  // Stamp a small square along the line; plenty at glyph scale.
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const half = Math.floor(thickness / 2);
  for (let i = 0; i <= steps; i++) {
    const px = Math.round(from[0] + (dx * i) / steps);
    const py = Math.round(from[1] + (dy * i) / steps);
    image.fillRect(px - half, py - half, thickness, thickness, value);
  }
}
