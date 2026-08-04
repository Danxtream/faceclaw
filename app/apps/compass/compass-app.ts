import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import {
  COMPASS_CALIBRATION_COMPLETE,
  COMPASS_CALIBRATION_STARTED,
  COMPASS_CHANGED,
  addCompassListener,
  setCompassEnabled,
  type CompassEvent,
} from "../../native/compass";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const COMPASS_WINDOW_ID = "compass";
export const COMPASS_SURFACE_ID = "window:compass";
const RECONCILE_INTERVAL_MS = 400;

class CompassLayer implements Layer {
  private heading: number | null = null;
  private status = "Waiting for compass data…";
  private enabled = false;
  private removed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    this.unsubscribe = addCompassListener((event) => this.onCompassEvent(event));
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.enabled) setCompassEnabled(false);
    this.enabled = false;
  }

  onRemoved(): void {
    this.stop();
  }

  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(COMPASS_WINDOW_ID);
    if (visible === this.enabled) return;
    this.enabled = visible;
    setCompassEnabled(visible);
    this.status = visible ? "Waiting for compass data…" : "Compass paused";
    this.requestRender();
  }

  private onCompassEvent(event: CompassEvent): void {
    if (this.removed) return;
    if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
      this.heading = normalizeHeading(event.headingDegrees);
      this.status = "Magnetic heading";
    } else if (event.command === COMPASS_CALIBRATION_STARTED) {
      this.status = "Calibrating — move the glasses";
    } else if (event.command === COMPASS_CALIBRATION_COMPLETE) {
      this.status = "Calibration complete";
    }
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const large = getDefaultLargeFont();
    const cx = Math.round(width * 0.28);
    const cy = Math.round(height * 0.51);
    const radius = Math.min(94, Math.round(height * 0.34));

    drawCompassRose(image, cx, cy, radius, this.heading);

    if (this.heading !== null) {
      const headingText = `${Math.round(this.heading)}°`;
      const direction = cardinalDirection(this.heading);
      const textX = Math.round(width * 0.57);
      image.drawText(large, textX, 72, headingText, 255);
      image.drawText(large, textX, 108, direction, 210);
    } else {
      image.drawText(medium, Math.round(width * 0.56), 84, "--°", 150);
      image.drawText(small, Math.round(width * 0.56), 116, "No heading yet", 130);
    }
    image.drawText(small, Math.round(width * 0.56), 158, this.status, 125);
    return image;
  }

  handleInput(_event: DashboardInputEvent, _ctx: LayerContext): void {}
}

export function createCompassAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow;
  let requestRender = () => {};
  const layer = new CompassLayer(() => requestRender());
  app = createInProcessWindow({
    appId: "compass",
    windowId: COMPASS_WINDOW_ID,
    title: "Compass",
    iconLetter: "C",
    icon: "compass",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function cardinalDirection(heading: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(normalizeHeading(heading) / 45) % names.length]!;
}

/** Draw a compass rose whose bright needle points toward magnetic north. */
function drawCompassRose(image: GrayImage, cx: number, cy: number, radius: number, heading: number | null): void {
  drawCircle(image, cx, cy, radius, 105);
  const small = getDefaultSmallFont();
  const medium = getDefaultMediumFont();
  const cardinals: Array<[string, number]> = [["N", -90], ["E", 0], ["S", 90], ["W", 180]];
  for (const [label, degrees] of cardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - 14) - medium.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - 14) - medium.lineHeight / 2;
    image.drawText(medium, Math.round(x), Math.round(y), label, label === "N" ? 230 : 105);
  }
  const intercardinals: Array<[string, number]> = [["NE", -45], ["SE", 45], ["SW", 135], ["NW", -135]];
  for (const [label, degrees] of intercardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - 14) - small.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - 14) - small.lineHeight / 2;
    image.drawText(small, Math.round(x), Math.round(y), label, 85);
  }
  image.fillRect(cx - 2, cy - 2, 5, 5, 180);
  if (heading === null) return;
  const northAngle = (-90 - heading) * Math.PI / 180;
  const nx = cx + Math.cos(northAngle) * (radius - 30);
  const ny = cy + Math.sin(northAngle) * (radius - 30);
  const sx = cx - Math.cos(northAngle) * (radius - 38);
  const sy = cy - Math.sin(northAngle) * (radius - 38);
  drawThickLine(image, cx, cy, nx, ny, 255);
  image.drawLine(cx, cy, sx, sy, 75);
}

function drawCircle(image: GrayImage, cx: number, cy: number, radius: number, value: number): void {
  let x = radius;
  let y = 0;
  let error = 1 - x;
  while (x >= y) {
    const points = [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]];
    for (const [dx, dy] of points) image.setPixel(cx + dx!, cy + dy!, value);
    y++;
    if (error < 0) error += 2 * y + 1;
    else { x--; error += 2 * (y - x) + 1; }
  }
}

function drawThickLine(image: GrayImage, x0: number, y0: number, x1: number, y1: number, value: number): void {
  image.drawLine(x0, y0, x1, y1, value);
  image.drawLine(x0 - 1, y0, x1 - 1, y1, value);
  image.drawLine(x0 + 1, y0, x1 + 1, y1, value);
}
