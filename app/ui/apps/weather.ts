import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { type ForecastPeriod, type WeatherState } from "../../native/weather";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../gestures";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../layers";
import { drawSelectionHighlight } from "../menu";

const PAGE_X = 18;
const HEADER_Y = 8;
const CURRENT_TOP = 34;
const CURRENT_TEXT_X = 112;
const FORECAST_HEADER_Y = 105;
const FORECAST_TOP = 124;
const FORECAST_ROW_HEIGHT = 23;
const FOOTER_HEIGHT = 18;
const FORECAST_NAME_WIDTH = 92;
const FORECAST_TEMP_X = 126;
const FORECAST_PRECIP_X = 184;
const FORECAST_SUMMARY_X = 244;

/** Weather's current-conditions summary and scrollable 12-hour forecast. */
export class WeatherLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;

  constructor(
    private readonly state: () => WeatherState,
    private readonly requestUpdate: () => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const weather = this.state();
    image.drawText(font, PAGE_X, HEADER_Y, "Weather", 225);
    if (weather.locationName) {
      image.drawText(
        font,
        width - PAGE_X - font.measureText(truncate(font, weather.locationName, 220)),
        HEADER_Y,
        truncate(font, weather.locationName, 220),
        150,
      );
    }

    if (weather.phase === "permission-required") {
      this.drawMessage(
        image,
        font,
        width,
        height,
        "Allow approximate location on your phone to get local weather.",
        `${GESTURE_CLICK} request   ${GESTURE_DOUBLE_CLICK} back`,
      );
      return image;
    }
    if (weather.phase === "locating" || weather.phase === "loading") {
      this.drawMessage(image, font, width, height, weather.status, `${GESTURE_DOUBLE_CLICK} back`);
      return image;
    }
    if (weather.phase === "error") {
      this.drawMessage(
        image,
        font,
        width,
        height,
        weather.status,
        `${GESTURE_CLICK} retry   ${GESTURE_DOUBLE_CLICK} back`,
      );
      return image;
    }

    this.drawCurrent(image, weather, width);
    this.drawForecast(image, weather.forecast, ctx, width, height);
    return image;
  }

  handleInput(event: DashboardInputEvent): void {
    const weather = this.state();
    if (event.type === "click") {
      this.requestUpdate();
      return;
    }
    if (!weather.forecast.length || weather.phase !== "ready") return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(weather.forecast.length - 1, this.selectedIndex + 1);
    }
  }

  private drawCurrent(image: GrayImage, weather: WeatherState, width: number): void {
    const current = weather.current;
    if (!current) return;
    const large = getDefaultLargeFont();
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const temperature = current.temperatureF === null ? "--°" : `${Math.round(current.temperatureF)}°F`;
    image.drawText(large, PAGE_X, CURRENT_TOP + 8, temperature, 245);
    image.drawText(
      medium,
      CURRENT_TEXT_X,
      CURRENT_TOP + 5,
      truncate(medium, current.description || "Current conditions", width - CURRENT_TEXT_X - PAGE_X),
      220,
    );

    const details: string[] = [];
    if (current.humidityPercent !== null) details.push(`Humidity ${Math.round(current.humidityPercent)}%`);
    if (current.windSpeedMph !== null) {
      details.push(`Wind ${current.windDirection ? `${current.windDirection} ` : ""}${Math.round(current.windSpeedMph)} mph`);
    }
    image.drawText(small, CURRENT_TEXT_X, CURRENT_TOP + 35, details.join("   ") || "Current forecast", 170);
    const source = current.observed ? "Observed" : "Forecast";
    const age = current.timestampMs ? formatAge(Date.now() - current.timestampMs) : "";
    image.drawText(small, CURRENT_TEXT_X, CURRENT_TOP + 54, `${source}${age ? ` ${age}` : ""}`, 105);
    image.drawLine(PAGE_X, FORECAST_HEADER_Y - 7, width - PAGE_X, FORECAST_HEADER_Y - 7, 40);
  }

  private drawForecast(
    image: GrayImage,
    forecast: ForecastPeriod[],
    ctx: LayerContext,
    width: number,
    height: number,
  ): void {
    const font = getDefaultSmallFont();
    if (!forecast.length) {
      image.drawText(font, PAGE_X, FORECAST_TOP, "No upcoming forecast periods.", 160);
      return;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, forecast.length - 1);
    const visibleRows = Math.max(1, Math.floor((height - FOOTER_HEIGHT - FORECAST_TOP) / FORECAST_ROW_HEIGHT));
    if (this.selectedIndex < this.scrollRow) {
      this.scrollRow = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollRow + visibleRows) {
      this.scrollRow = this.selectedIndex - visibleRows + 1;
    }
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, forecast.length - visibleRows));

    image.drawText(font, PAGE_X, FORECAST_HEADER_Y, "Upcoming", 150);
    image.drawText(font, FORECAST_TEMP_X, FORECAST_HEADER_Y, "Temp", 105);
    image.drawText(font, FORECAST_PRECIP_X, FORECAST_HEADER_Y, "Rain", 105);
    image.drawText(font, width - PAGE_X - font.measureText(`${this.selectedIndex + 1}/${forecast.length}`), FORECAST_HEADER_Y, `${this.selectedIndex + 1}/${forecast.length}`, 105);

    const last = Math.min(forecast.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < last; index++) {
      const period = forecast[index]!;
      const y = FORECAST_TOP + (index - this.scrollRow) * FORECAST_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, PAGE_X - 7, y - 2, width - 2 * (PAGE_X - 7), FORECAST_ROW_HEIGHT - 2, ctx.stack.isFocused(), 5);
      }
      const shade = selected ? 245 : 190;
      image.drawText(font, PAGE_X, y + 2, truncate(font, period.name, FORECAST_NAME_WIDTH), shade);
      image.drawText(font, FORECAST_TEMP_X, y + 2, period.temperatureF === null ? "--" : `${Math.round(period.temperatureF)}°F`, shade);
      image.drawText(font, FORECAST_PRECIP_X, y + 2, period.precipitationPercent === null ? "--" : `${Math.round(period.precipitationPercent)}%`, selected ? 220 : 155);
      image.drawText(font, FORECAST_SUMMARY_X, y + 2, truncate(font, period.shortForecast, width - FORECAST_SUMMARY_X - PAGE_X), selected ? 220 : 165);
    }

    image.drawText(
      font,
      PAGE_X,
      height - 15,
      `${GESTURE_SCROLL} forecast   ${GESTURE_CLICK} refresh   ${GESTURE_DOUBLE_CLICK} back`,
      105,
    );
  }

  private drawMessage(
    image: GrayImage,
    font: BdfFont,
    width: number,
    height: number,
    message: string,
    footer: string,
  ): void {
    const lines = wrapText(font, message, width - 2 * (PAGE_X + 6));
    const top = Math.max(52, Math.round((height - lines.length * 15) / 2) - 8);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, PAGE_X + 6, top + index * 15, lines[index]!, 185);
    }
    image.drawText(font, PAGE_X, height - 20, footer, 110);
  }
}

function formatAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function truncate(font: BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}
