import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { readUpcomingEvents, type CalendarEvent } from "../../native/calendar";
import { timeFormatSetting } from "../../ui/dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../../ui/gestures";
import { hasCalendarPermission } from "../../g2/android-permissions";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";

const PAGE_X = 12;
const PAGE_Y = 12;
const LIST_TOP = 38;
const ROW_X = 16;
const LINE_HEIGHT = 14;
const DAY_HEADER_HEIGHT = 16;
const ROW_GAP = 4;
const MAX_EVENTS = 50;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type EventRow = {
  event: CalendarEvent;
  /** Day header text drawn above this row, or null when it shares the prior day. */
  dayHeader: string | null;
  lines: string[];
  height: number;
};

/**
 * The Calendar app's single screen. Without calendar permission it shows a
 * prompt telling the user to grant access on the phone (the launch path also
 * fires the system permission dialog); with permission it lists upcoming
 * events grouped by day, scrollable when they overflow the viewport.
 */
export class CalendarLayer implements Layer {
  private selectedIndex = 0;

  constructor(private readonly requestPermission: () => void) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, PAGE_X + 12, PAGE_Y + 9, "Calendar", 220);

    if (!hasCalendarPermission()) {
      this.paintPermissionPrompt(image, font, width, height);
      return image;
    }

    const events = readUpcomingEvents(MAX_EVENTS);
    if (!events.length) {
      image.drawText(font, 24, 72, "No upcoming events.", 190);
      image.drawText(font, 24, height - 36, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const rows = buildEventRows(events);
    this.selectedIndex = clamp(this.selectedIndex, 0, rows.length - 1);
    image.drawText(font, width - 96, PAGE_Y + 9, `${this.selectedIndex + 1}/${rows.length}`, 150);

    const listBottom = height;
    const scrollY = scrollForSelected(rows, this.selectedIndex, listBottom - LIST_TOP);
    let cursorY = LIST_TOP - scrollY;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (cursorY + row.height >= LIST_TOP && cursorY <= listBottom) {
        drawEventRow(image, font, row, ROW_X, cursorY, width, index === this.selectedIndex);
      }
      cursorY += row.height + ROW_GAP;
      if (cursorY > listBottom + 80) break;
    }
    return image;
  }

  handleInput(event: DashboardInputEvent): void {
    if (!hasCalendarPermission()) {
      // Any tap on the prompt re-triggers the phone-side permission request.
      if (event.type === "click") this.requestPermission();
      return;
    }
    const rows = buildEventRows(readUpcomingEvents(MAX_EVENTS));
    if (!rows.length) return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
    }
  }

  private paintPermissionPrompt(image: GrayImage, font: BdfFont, width: number, height: number): void {
    const message = "Grant calendar permission on your phone to see your events on the glasses.";
    const lines = wrapText(font, message, width - 48);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, 24, 72 + index * LINE_HEIGHT, lines[index]!, 190);
    }
    image.drawText(font, 24, height - 36, `${GESTURE_CLICK} request   ${GESTURE_DOUBLE_CLICK} back`, 110);
  }
}

function buildEventRows(events: CalendarEvent[]): EventRow[] {
  const rows: EventRow[] = [];
  let previousDayKey = "";
  for (const event of events) {
    const dayKey = dayKeyOf(event.startMs);
    const dayHeader = dayKey === previousDayKey ? null : dayHeaderLabel(event.startMs);
    previousDayKey = dayKey;

    const lines: string[] = [];
    const timeLabel = event.allDay ? "All day" : formatEventTime(event.startMs);
    lines.push(`${timeLabel}  ${event.title || "(untitled)"}`);
    if (event.location) {
      lines.push(event.location);
    }

    rows.push({
      event,
      dayHeader,
      lines,
      height: (dayHeader ? DAY_HEADER_HEIGHT : 0) + 6 + lines.length * LINE_HEIGHT,
    });
  }
  return rows;
}

function drawEventRow(
  image: GrayImage,
  font: BdfFont,
  row: EventRow,
  x: number,
  y: number,
  width: number,
  selected: boolean,
): void {
  let cursorY = y;
  if (row.dayHeader) {
    image.drawText(font, x, cursorY + 2, row.dayHeader, 150);
    cursorY += DAY_HEADER_HEIGHT;
  }
  const bodyHeight = row.lines.length * LINE_HEIGHT + 4;
  if (selected) {
    image.fillRoundedRect(x - 6, cursorY, width - 2 * (x - 6), bodyHeight, 15, 6);
    image.drawRoundedRect(x - 6, cursorY, width - 2 * (x - 6), bodyHeight, 90, 6);
  }
  const maxTextWidth = width - 2 * x;
  for (let index = 0; index < row.lines.length; index++) {
    const value = index === 0 ? (selected ? 235 : 205) : 160;
    image.drawText(font, x, cursorY + 3 + index * LINE_HEIGHT, truncateText(font, row.lines[index]!, maxTextWidth), value);
  }
}

function scrollForSelected(rows: EventRow[], selectedIndex: number, viewportHeight: number): number {
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += rows[index]!.height + ROW_GAP;
  }
  const selectedBottom = selectedTop + rows[selectedIndex]!.height;
  const contentHeight = rows.reduce((sum, row) => sum + row.height + ROW_GAP, 0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered = selectedTop - Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function dayKeyOf(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayHeaderLabel(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round((midnight(date) - midnight(now)) / (24 * 60 * 60 * 1000));
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (dayDelta === 0) return `Today  ${base}`;
  if (dayDelta === 1) return `Tomorrow  ${base}`;
  return base;
}

function formatEventTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour24 = date.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${String(hour24).padStart(2, "0")}:${minutes}`;
}
