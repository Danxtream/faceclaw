import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { nightscoutBridge, type NightscoutState } from "../../native/nightscout-bridge";
import { NightscoutLayer } from "../apps/nightscout";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";
import { shell } from "./shell";

export const NIGHTSCOUT_WINDOW_ID = "nightscout";
export const NIGHTSCOUT_SURFACE_ID = "window:nightscout";

const TRAY_ICON_ID = "nightscout";
const TRAY_HEIGHT = 24;
const TRAY_GRAPH_WIDTH = 48;
const TRAY_STALE_MS = 15 * 60 * 1000;
const TRAY_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The Nightscout app: the full-screen glucose view (previously reached via
 * the dashboard card) in its own in-process window. While the app is running
 * it also publishes a top-bar tray icon: the latest blood-glucose value
 * (struck through when stale) plus a minimal 48px history graph.
 */
export function createNightscoutAppWindow(options: InProcessAppOptions): InProcessWindow {
  let unsubscribe: (() => void) | null = null;
  const app = createInProcessWindow({
    appId: "nightscout",
    windowId: NIGHTSCOUT_WINDOW_ID,
    title: "Nightscout",
    iconLetter: "Ns",
    icon: "activity",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NightscoutLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      unsubscribe?.();
      unsubscribe = null;
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  // onStateChange fires immediately with the current snapshot, so this also
  // publishes the initial tray icon.
  unsubscribe = nightscoutBridge.onStateChange((state) => {
    shell.setTrayIcon(TRAY_ICON_ID, buildNightscoutTrayIcon(state));
    app.requestRender();
  });
  return app;
}

/** BG value (struck through when stale) + minimal 2-hour line graph. */
function buildNightscoutTrayIcon(state: NightscoutState): GrayImage {
  const font = getDefaultSmallFont();
  const nowMs = Date.now();
  const label = state.latest ? `${state.latest.sgv}` : "--";
  const labelWidth = font.measureText(label);
  const image = new GrayImage(labelWidth + 4 + TRAY_GRAPH_WIDTH, TRAY_HEIGHT, 0);

  const textY = Math.max(0, ((TRAY_HEIGHT - font.lineHeight) / 2) | 0);
  image.drawText(font, 0, textY, label, 220);
  const stale = state.latest !== null && nowMs - state.latest.timestampMs > TRAY_STALE_MS;
  if (stale) {
    image.drawLine(0, TRAY_HEIGHT / 2, labelWidth, TRAY_HEIGHT / 2, 180);
  }

  drawTrayGraph(image, labelWidth + 4, state, nowMs);
  return image;
}

function drawTrayGraph(image: GrayImage, x: number, state: NightscoutState, nowMs: number): void {
  const windowStartMs = nowMs - TRAY_GRAPH_WINDOW_MS;
  const points = state.history.filter(
    (point) => point.timestampMs >= windowStartMs && point.timestampMs <= nowMs,
  );
  if (points.length === 0) return;

  const values = points.map((point) => point.sgv);
  const min = Math.min(...values, 60);
  const max = Math.max(...values, 200);
  const span = Math.max(20, max - min);

  const plotted = points.map((point) => ({
    timestampMs: point.timestampMs,
    x: x + Math.round(((point.timestampMs - windowStartMs) / TRAY_GRAPH_WINDOW_MS) * (TRAY_GRAPH_WIDTH - 1)),
    y: TRAY_HEIGHT - 1 - Math.round(((point.sgv - min) / span) * (TRAY_HEIGHT - 1)),
  }));
  for (let index = 1; index < plotted.length; index++) {
    const previous = plotted[index - 1]!;
    const current = plotted[index]!;
    if (current.timestampMs - previous.timestampMs <= TRAY_STALE_MS) {
      image.drawLine(previous.x, previous.y, current.x, current.y, 190);
    } else {
      image.fillRect(current.x, current.y, 1, 1, 190);
    }
  }
}
