import { BdfFont, getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage, imageFromAsciiArt } from "../../graphics/image";
import { DashboardPlugin, type DashboardPluginCardRenderArgs, type DashboardPluginState } from "../dashboard-plugin";
import { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { nightscoutBridge, type NightscoutState } from "../../native/nightscout-bridge";
import { formatAgeShortFromTimestamp, formatTimestamp } from "~/util/date-util";

const nightscoutLargeFont = getDefaultLargeFont();
const NIGHTSCOUT_STALE_MS = 15 * 60 * 1000;
const NIGHTSCOUT_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;
const NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS = 60 * 1000;


export class NightscoutDashboardPlugin extends DashboardPlugin {
  constructor() {
    super({
      id: "nightscout",
      label: "Nightscout",
    });
  }

  override renderCard({ image, bounds, state }: DashboardPluginCardRenderArgs): void {
    const font = getDefaultSmallFont();
    const nightscout = state.nightscout;
    const nowMs = Date.now();
    image.drawText(font, bounds.x + 10, bounds.y + 10, "Nightscout", 180);
    if (!state.nightscoutConfigured || nightscout.configurationMissing) {
      image.drawText(font, bounds.x + 10, bounds.y + 30, "Needs setup", 170);
      image.drawText(font, bounds.x + 10, bounds.y + 44, "Click to configure", 140);
      return;
    }
    if (!nightscout.available || !nightscout.latest) {
      image.drawText(font, bounds.x + 10, bounds.y + 30, "No glucose data", 150);
      image.drawText(font, bounds.x + 10, bounds.y + 44, truncateLine(nightscout.status, 26), 120);
      return;
    }

    const latest = nightscout.latest;
    const deltaLabel = formatDelta(nightscout.delta);
    const glucoseText = `${latest.sgv}`;
    const glucoseX = bounds.x + bounds.width - 92;
    image.drawText(nightscoutLargeFont, glucoseX, bounds.y + 10, glucoseText, 230);
    if (isNightscoutPointStale(latest, nowMs)) {
      drawNightscoutValueStrikeThrough(image, glucoseX, bounds.y + 22, nightscoutLargeFont.measureText(glucoseText));
    }
    drawNightscoutDelta(image, font, bounds.x + bounds.width - 92, bounds.y + 30, deltaLabel, nightscout.direction, 160);
    image.drawText(
      font,
      bounds.x + 10,
      bounds.y + 30,
      `IOB ${nightscout.iob === null ? "--" : nightscout.iob.toFixed(1)} COB ${nightscout.cob === null ? "--" : formatWholeNumber(nightscout.cob)}`,
      160,
    );
    image.drawText(
      font,
      bounds.x + 10,
      bounds.y + 44,
      `Loop ${nightscout.openapsStatusShort} CAGE ${formatAgeShortFromTimestamp(nightscout.cageTimestampMs, nowMs)}`,
      138,
    );
    drawNightscoutGraph(
      image,
      {
        x: bounds.x + 10,
        y: bounds.y + 60,
        width: bounds.width - 20,
        height: Math.max(16, bounds.height - 82),
      },
      nightscout,
      nowMs,
      font,
    );
  }

  override createFullscreenLayer(getState: () => DashboardPluginState): Layer {
    return new NightscoutLayer(getState);
  }
}

function drawNightscoutDelta(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  deltaLabel: string,
  direction: string,
  shade: number,
): void {
  const text = direction ? `${deltaLabel} ` : deltaLabel;
  image.drawText(font, x, y, text, shade);
  drawDirectionIndicator(image, font, x + font.measureText(text), y, direction, shade);
}

function drawDirectionIndicator(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  direction: string,
  shade: number,
): void {
  const label = directionGlyphLabel(font, direction);
  if (label) {
    image.drawText(font, x, y, label, shade);
    return;
  }

  const art = directionAsciiArt(direction);
  if (art) {
    image.bitBlt(imageFromAsciiArt(art, shade), x, y + 1);
    return;
  }

  if (direction) {
    image.drawText(font, x, y, truncateLine(direction, 10), shade);
  }
}

function directionGlyphLabel(font: BdfFont, direction: string): string {
  switch (direction) {
    case "DoubleUp":
      return font.hasGlyph("↑".codePointAt(0)!) ? "↑↑" : "";
    case "SingleUp":
      return font.hasGlyph("↑".codePointAt(0)!) ? "↑" : "";
    case "FortyFiveUp":
      return font.hasGlyph("↗".codePointAt(0)!) ? "↗" : "";
    case "Flat":
      return font.hasGlyph("→".codePointAt(0)!) ? "→" : "";
    case "FortyFiveDown":
      return font.hasGlyph("↘".codePointAt(0)!) ? "↘" : "";
    case "SingleDown":
      return font.hasGlyph("↓".codePointAt(0)!) ? "↓" : "";
    case "DoubleDown":
      return font.hasGlyph("↓".codePointAt(0)!) ? "↓↓" : "";
    default:
      return "";
  }
}

function directionAsciiArt(direction: string): readonly string[] | undefined {
  switch (direction) {
    case "FortyFiveUp":
      return ["   ##", "  ###", " # ##", "#  ##", "   ##"];
    case "FortyFiveDown":
      return ["   ##", "#  ##", " # ##", "  ###", "   ##"];
    default:
      return undefined;
  }
}

function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "--";
  return `${delta >= 0 ? "+" : ""}${Math.round(delta)}`;
}

function formatWholeNumber(value: number): string {
  return `${Math.round(value)}`;
}

function formatBolusLabel(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function drawNightscoutGraph(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  nightscout: NightscoutState,
  nowMs: number,
  font: BdfFont,
): void {
  if (bounds.width <= 2 || bounds.height <= 2) {
    return;
  }

  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleHistory = nightscout.history.filter((point) => {
    const pointTimestampMs = minuteBucketTimestampMs(point.timestampMs);
    return pointTimestampMs >= windowStartMs && pointTimestampMs <= graphNowMs;
  });
  if (visibleHistory.length === 0) {
    return;
  }

  const values = visibleHistory.map((point) => point.sgv);
  const min = Math.min(...values, 60);
  const max = Math.max(...values, 200);
  const range = Math.max(20, max - min);
  const paddedMin = min - range * 0.1;
  const paddedMax = max + range * 0.1;

  image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 56);
  drawNightscoutBasalOverlay(image, bounds, nightscout.basal, graphNowMs);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 60, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 100, 40);
  drawNightscoutReferenceLine(image, bounds, paddedMin, paddedMax, 180, 40);

  const plotted = visibleHistory.map((point) => ({
    point,
    x: timeToGraphX(bounds, windowStartMs, point.timestampMs),
    y:
      bounds.y +
      bounds.height -
      1 -
      Math.round(((point.sgv - paddedMin) / Math.max(1, paddedMax - paddedMin)) * Math.max(1, bounds.height - 1)),
  }));

  for (let i = 0; i < plotted.length; i++) {
    const current = plotted[i]!;
    const previous = i > 0 ? plotted[i - 1]! : null;
    const next = i + 1 < plotted.length ? plotted[i + 1]! : null;
    const connectedToPrevious =
      previous !== null && current.point.timestampMs - previous.point.timestampMs <= NIGHTSCOUT_STALE_MS;
    const connectedToNext =
      next !== null && next.point.timestampMs - current.point.timestampMs <= NIGHTSCOUT_STALE_MS;

    if (connectedToPrevious && previous) {
      image.drawLine(previous.x, previous.y, current.x, current.y, 220);
    }
    if (!connectedToPrevious && !connectedToNext) {
      image.fillRect(current.x - 1, current.y - 1, 2, 2, 220);
    }
  }
  drawNightscoutCarbMarkers(image, bounds, font, nightscout.carbs, graphNowMs);
  drawNightscoutBolusMarkers(image, bounds, font, nightscout.boluses, graphNowMs);
}

function drawNightscoutBasalOverlay(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  basalEvents: NightscoutState["basal"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const visibleEvents = basalEvents.filter(
    (event) =>
      minuteBucketTimestampMs(event.timestampMs + event.durationMinutes * 60_000) >= windowStartMs &&
      minuteBucketTimestampMs(event.timestampMs) <= graphNowMs,
  );
  if (visibleEvents.length === 0) {
    return;
  }
  const maxRate = Math.max(...visibleEvents.map((event) => event.rate), 0);
  if (maxRate <= 0) {
    return;
  }
  const overlayHeight = Math.max(8, Math.min(18, Math.floor(bounds.height * 0.22)));
  const bottomY = bounds.y + bounds.height - 2;
  for (const event of visibleEvents) {
    const startMs = Math.max(windowStartMs, minuteBucketTimestampMs(event.timestampMs));
    const endMs = Math.min(graphNowMs, minuteBucketTimestampMs(event.timestampMs + event.durationMinutes * 60_000));
    if (endMs <= startMs) {
      continue;
    }
    const leftX = timeToGraphX(bounds, windowStartMs, startMs);
    const rightX = timeToGraphX(bounds, windowStartMs, endMs);
    const height = Math.max(1, Math.round((event.rate / maxRate) * overlayHeight));
    image.fillRect(leftX, bottomY - height + 1, Math.max(1, rightX - leftX + 1), height, 15);
  }
}

function drawNightscoutCarbMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: BdfFont,
  carbEvents: NightscoutState["carbs"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const baselineY = bounds.y + bounds.height - 2;
  for (const event of carbEvents) {
    const eventTimestampMs = minuteBucketTimestampMs(event.timestampMs);
    if (eventTimestampMs < windowStartMs || eventTimestampMs > graphNowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, eventTimestampMs);
    image.drawLine(x, baselineY, x, baselineY - 6, 150);
    drawTextCentered(image, font, x, Math.max(bounds.y + 2, baselineY - 18), `${Math.round(event.carbs)}`, 150, bounds);
  }
}

function drawNightscoutBolusMarkers(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  font: BdfFont,
  bolusEvents: NightscoutState["boluses"],
  nowMs: number,
): void {
  const graphNowMs = minuteBucketTimestampMs(nowMs);
  const windowStartMs = graphNowMs - NIGHTSCOUT_GRAPH_WINDOW_MS;
  const topY = bounds.y + 1;
  for (const event of bolusEvents) {
    const eventTimestampMs = minuteBucketTimestampMs(event.timestampMs);
    if (eventTimestampMs < windowStartMs || eventTimestampMs > graphNowMs) {
      continue;
    }
    const x = timeToGraphX(bounds, windowStartMs, eventTimestampMs);
    image.drawLine(x, topY, x, topY + 6, 144);
    if (event.insulin >= 1) {
      drawTextCentered(
        image,
        font,
        x,
        Math.min(bounds.y + bounds.height - font.lineHeight - 1, topY + 8),
        formatBolusLabel(event.insulin),
        144,
        bounds,
      );
    }
  }
}

function drawTextCentered(
  image: GrayImage,
  font: BdfFont,
  centerX: number,
  y: number,
  text: string,
  shade: number,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  const textWidth = font.measureText(text);
  const x = Math.max(bounds.x + 1, Math.min(bounds.x + bounds.width - textWidth - 1, centerX - Math.round(textWidth / 2)));
  image.drawText(font, x, y, text, shade);
}

function timeToGraphX(
  bounds: { x: number; y: number; width: number; height: number },
  windowStartMs: number,
  timestampMs: number,
): number {
  const graphTimestampMs = minuteBucketTimestampMs(timestampMs);
  return (
    bounds.x +
    Math.round(
      ((graphTimestampMs - windowStartMs) / Math.max(1, NIGHTSCOUT_GRAPH_WINDOW_MS)) * Math.max(1, bounds.width - 1),
    )
  );
}

function minuteBucketTimestampMs(timestampMs: number): number {
  return Math.floor(timestampMs / NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS) * NIGHTSCOUT_GRAPH_TIME_QUANTUM_MS;
}

function drawNightscoutReferenceLine(
  image: GrayImage,
  bounds: { x: number; y: number; width: number; height: number },
  minValue: number,
  maxValue: number,
  value: number,
  shade: number,
): void {
  const y =
    bounds.y +
    bounds.height -
    1 -
    Math.round(((value - minValue) / Math.max(1, maxValue - minValue)) * Math.max(1, bounds.height - 1));
  image.drawLine(bounds.x + 1, y, bounds.x + bounds.width - 2, y, shade);
}


class NightscoutLayer implements Layer {
  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(576, 288, 0);
    const nightscout = this.getState().nightscout;
    const nowMs = Date.now();
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(font, 22, 16, "Nightscout", 220);

    if (!this.getState().nightscoutConfigured || nightscout.configurationMissing) {
      image.drawText(font, 22, 44, "Nightscout needs configuration.", 180);
      image.drawText(font, 22, 62, "Double-click and use Settings", 140);
      image.drawText(font, 22, 78, "Integrations > Nightscout.", 140);
      return image;
    }

    if (!nightscout.available || !nightscout.latest) {
      image.drawText(font, 22, 44, "No Nightscout data available.", 180);
      image.drawText(font, 22, 58, truncateLine(nightscout.status, 60), 140);
      image.drawText(font, 22, 252, "Click: refresh  Double-click: back", 110);
      return image;
    }

    const latest = nightscout.latest;
    const glucoseText = `${latest.sgv}`;
    const glucoseX = 22;
    const glucoseWidth = nightscoutLargeFont.measureText(glucoseText);
    image.drawText(nightscoutLargeFont, glucoseX, 28, glucoseText, 230);
    if (isNightscoutPointStale(latest, nowMs)) {
      drawNightscoutValueStrikeThrough(image, glucoseX, 40, glucoseWidth);
    }
    image.drawText(font, glucoseX + glucoseWidth + 8, 36, nightscout.units, 140);
    const trendText = `Delta ${formatDelta(nightscout.delta)}  Trend `;
    image.drawText(font, 22, 62, trendText, 180);
    drawDirectionIndicator(image, font, 22 + font.measureText(trendText), 62, nightscout.direction, 180);
    image.drawText(
      font,
      22,
      78,
      `IOB ${nightscout.iob === null ? "--" : nightscout.iob.toFixed(2)}  COB ${nightscout.cob === null ? "--" : formatWholeNumber(nightscout.cob)}  Updated ${formatTimestamp(latest.timestampMs)}`,
      160,
    );
    image.drawText(
      font,
      22,
      94,
      `CAGE ${formatAgeShortFromTimestamp(nightscout.cageTimestampMs, nowMs)}  Loop ${nightscout.openapsStatusShort}`,
      160,
    );
    image.drawText(font, 22, 110, `Pump ${truncateLine(nightscout.pumpStatus || "--", 56)}`, 150);
    drawNightscoutGraph(image, { x: 22, y: 128, width: 532, height: 96 }, nightscout, nowMs, font);
    image.drawText(font, 22, 234, "2-hour glucose history with basal / carbs / boluses", 130);
    image.drawText(font, 22, 252, "Click: refresh  Double-click: back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "click":
        await nightscoutBridge.refreshNow();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}

function isNightscoutPointStale(point: NightscoutState["latest"], nowMs: number): boolean {
  return point !== null && nowMs - point.timestampMs > NIGHTSCOUT_STALE_MS;
}

function drawNightscoutValueStrikeThrough(image: GrayImage, x: number, y: number, width: number): void {
  image.drawLine(x, y, x + width, y, 180);
}
