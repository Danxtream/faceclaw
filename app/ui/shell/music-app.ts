import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import {
  mediaControllerBridge,
  type MediaControllerState,
  type MediaQueueItem,
} from "../../native/media-controller";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";

export const MUSIC_WINDOW_ID = "music";
export const MUSIC_SURFACE_ID = "window:music";

const ART_SIZE = 96;
const ART_X = 22;
const ART_Y = 40;
const META_X = ART_X + ART_SIZE + 14;
const LIST_TOP = 150;
const ROW_HEIGHT = 16;
const LIST_X = 22;
const FOOTER_HEIGHT = 20;

type MusicRow =
  | { kind: "play-pause"; label: string; enabled: boolean }
  | { kind: "previous"; label: string; enabled: boolean }
  | { kind: "next"; label: string; enabled: boolean }
  | { kind: "queue-item"; label: string; enabled: true; item: MediaQueueItem };

/**
 * Music controller app: metadata + album art + transport controls for the
 * active Android media session (any player that publishes one), plus the
 * player's queue when it exposes one (scroll to a track, click to jump).
 */
class MusicAppLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;
  private art: GrayImage | null = null;
  private artKey = "";

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const media = mediaControllerBridge.snapshot();

    image.drawText(font, 20, 8, "Music", 220);
    const status = playbackLabel(media);
    image.drawText(font, width - 24 - font.measureText(status), 8, status, 140);

    if (!media.accessEnabled) {
      const lines = wrapText(
        font,
        "Notification access is required before Android exposes media sessions. Click to open settings.",
        width - 48,
      );
      for (let index = 0; index < lines.length; index++) {
        image.drawText(font, 24, 44 + index * 14, lines[index]!, 180);
      }
      image.drawText(font, 20, height - 16, "Click: open settings   Double-click: back", 110);
      return image;
    }

    if (!media.available) {
      image.drawText(font, 24, 44, "No active media session.", 180);
      image.drawText(font, 24, 62, "Start playback in another app on the phone.", 150);
      image.drawText(font, 20, height - 16, "Double-click: back to sidebar", 110);
      return image;
    }

    this.drawArt(image, media);

    const metaWidth = width - META_X - 24;
    const titleLines = wrapText(font, media.title || "Unknown title", metaWidth).slice(0, 2);
    for (let index = 0; index < titleLines.length; index++) {
      image.drawText(font, META_X, ART_Y + 2 + index * 15, titleLines[index]!, 230);
    }
    image.drawText(font, META_X, ART_Y + 36, media.artist || "Unknown artist", 180);
    if (media.album) {
      image.drawText(font, META_X, ART_Y + 52, truncate(font, media.album, metaWidth), 150);
    }
    image.drawText(font, META_X, ART_Y + 70, media.packageName, 110);

    const rows = this.buildRows(media);
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, rows.length - 1));
    const listHeight = height - LIST_TOP - FOOTER_HEIGHT;
    const visibleRows = Math.max(1, (listHeight / ROW_HEIGHT) | 0);
    if (this.selectedIndex < this.scrollRow) {
      this.scrollRow = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollRow + visibleRows) {
      this.scrollRow = this.selectedIndex - visibleRows + 1;
    }
    this.scrollRow = clamp(this.scrollRow, 0, Math.max(0, rows.length - visibleRows));

    const lastVisible = Math.min(rows.length, this.scrollRow + visibleRows);
    for (let index = this.scrollRow; index < lastVisible; index++) {
      const row = rows[index]!;
      const y = LIST_TOP + (index - this.scrollRow) * ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        image.fillRoundedRect(LIST_X - 6, y - 1, width - 2 * LIST_X + 12, ROW_HEIGHT - 1, 15, 4);
        image.drawRoundedRect(LIST_X - 6, y - 1, width - 2 * LIST_X + 12, ROW_HEIGHT - 1, 45, 4);
      }
      const value = !row.enabled ? (selected ? 130 : 90) : selected ? 255 : 200;
      image.drawText(font, LIST_X, y + 1, truncate(font, row.label, width - 2 * LIST_X), value);
    }

    image.drawText(font, 20, height - 16, "Scroll: select   Click: activate   Double-click: back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const media = mediaControllerBridge.snapshot();
    if (!media.accessEnabled) {
      if (event.type === "click") {
        mediaControllerBridge.openNotificationAccessSettings();
      } else if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    const rows = this.buildRows(media);
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
        return;
      case "click": {
        const row = rows[clamp(this.selectedIndex, 0, Math.max(0, rows.length - 1))];
        if (!row || !row.enabled) return;
        if (row.kind === "play-pause") await mediaControllerBridge.playPause();
        else if (row.kind === "previous") await mediaControllerBridge.skipPrevious();
        else if (row.kind === "next") await mediaControllerBridge.skipNext();
        else if (row.kind === "queue-item") await mediaControllerBridge.skipToQueueItem(row.item.id);
        return;
      }
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private buildRows(media: MediaControllerState): MusicRow[] {
    const rows: MusicRow[] = [
      {
        kind: "play-pause",
        label: media.playbackState === "playing" ? "Pause" : "Play",
        enabled: media.canPlayPause,
      },
      { kind: "previous", label: "Previous track", enabled: media.canSkipPrevious },
      { kind: "next", label: "Next track", enabled: media.canSkipNext },
    ];
    for (const item of mediaControllerBridge.getQueue()) {
      rows.push({
        kind: "queue-item",
        label: `${item.active ? "> " : "   "}${item.title || "(untitled)"}`,
        enabled: true,
        item,
      });
    }
    return rows;
  }

  private drawArt(image: GrayImage, media: MediaControllerState): void {
    const key = `${media.packageName}|${media.title}|${media.album}`;
    if (key !== this.artKey) {
      this.artKey = key;
      this.art = mediaControllerBridge.getAlbumArt(ART_SIZE);
    }
    if (this.art) {
      // Center within the art box.
      const dx = ART_X + Math.max(0, ((ART_SIZE - this.art.width) / 2) | 0);
      const dy = ART_Y + Math.max(0, ((ART_SIZE - this.art.height) / 2) | 0);
      image.bitBlt(this.art, dx, dy);
      image.drawRect(dx - 1, dy - 1, this.art.width + 2, this.art.height + 2, 60);
    } else {
      image.drawRect(ART_X, ART_Y, ART_SIZE, ART_SIZE, 60);
      const font = getDefaultSmallFont();
      image.drawText(font, ART_X + 22, ART_Y + ART_SIZE / 2 - 7, "no art", 90);
    }
  }
}

export function createMusicAppWindow(options: InProcessAppOptions): InProcessWindow {
  let unsubscribe: (() => void) | null = null;
  const app = createInProcessWindow({
    appId: "music",
    windowId: MUSIC_WINDOW_ID,
    title: "Music",
    iconLetter: "M",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new MusicAppLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      unsubscribe?.();
      unsubscribe = null;
      options.onClosed();
    },
  });
  unsubscribe = mediaControllerBridge.onStateChange(() => {
    app.requestRender();
  });
  return app;
}

function playbackLabel(media: MediaControllerState): string {
  switch (media.playbackState) {
    case "playing":
      return "Playing";
    case "paused":
      return "Paused";
    case "buffering":
      return "Buffering";
    case "stopped":
      return "Stopped";
    case "notification-access-required":
      return "Access required";
    default:
      return media.status || "Idle";
  }
}

function truncate(font: import("../../graphics/bdffont").BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}
