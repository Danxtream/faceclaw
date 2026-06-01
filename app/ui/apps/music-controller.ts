import { DashboardPlugin, DashboardPluginState } from "../dashboard-plugins";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { mediaControllerBridge, type MediaControllerState } from "../../native/media-controller";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

export const musicControllerDashboardPlugin: DashboardPlugin = {
  id: "music-controller",
  label: "Music controller",
  renderCard: ({ image, bounds, state }) => {
    const font = getDefaultSmallFont();
    const media = state.media;
    image.drawText(font, bounds.x + 10, bounds.y + 14, "Now playing", 180);
    if (!media.accessEnabled) {
      image.drawText(font, bounds.x + 10, bounds.y + 30, "Enable notification", 150);
      image.drawText(font, bounds.x + 10, bounds.y + 44, "access for media", 150);
      return;
    }
    if (!media.available) {
      image.drawText(font, bounds.x + 10, bounds.y + 30, "No active session", 150);
      return;
    }

    const titleLines = wrapText(font, media.title || "Unknown title", bounds.width - 20).slice(0, 2);
    const artistLine = media.artist || media.album || media.packageName || "Unknown source";
    image.drawText(font, bounds.x + 10, bounds.y + 30, titleLines[0] ?? "", 210);
    if (titleLines[1]) {
      image.drawText(font, bounds.x + 10, bounds.y + 44, titleLines[1], 210);
    }
    image.drawText(font, bounds.x + 10, bounds.y + 62, artistLine, 160);
    image.drawText(font, bounds.x + 10, bounds.y + bounds.height - 18, playbackLabel(media), 130);
  },
  createFullscreenLayer: (getState) => new MusicControllerLayer(getState),
};

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

class MusicControllerLayer implements Layer {
  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(576, 288, 0);
    const media = this.getState().media;
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(font, 22, 16, "Music controller", 220);

    if (!media.accessEnabled) {
      const lines = wrapText(
        font,
        "Notification access is required before Android will expose active media sessions to Faceclaw. Click to open settings.",
        520,
      );
      for (let i = 0; i < lines.length; i++) {
        image.drawText(font, 22, 44 + i * 14, lines[i]!, 180);
      }
      image.drawText(font, 22, 252, "Click: open settings  Double-click: back", 110);
      return image;
    }

    if (!media.available) {
      image.drawText(font, 22, 44, "No active media session.", 180);
      image.drawText(font, 22, 58, "Start playback in another app,", 180);
      image.drawText(font, 22, 72, "then reopen this card.", 180);
      image.drawText(font, 22, 252, "Double-click: back", 110);
      return image;
    }

    image.drawText(font, 22, 44, media.title || "Unknown title", 220);
    image.drawText(font, 22, 60, media.artist || media.album || "Unknown artist", 180);
    image.drawText(font, 22, 76, media.packageName, 130);
    image.drawText(font, 22, 104, `State: ${playbackLabel(media)}`, 180);
    image.drawText(font, 22, 132, "Click: play/pause", 180);
    image.drawText(font, 22, 146, "Scroll up: previous", 180);
    image.drawText(font, 22, 160, "Scroll down: next", 180);
    image.drawText(font, 22, 252, "Double-click: back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const media = this.getState().media;
    switch (event.type) {
      case "click":
        if (!media.accessEnabled) {
          mediaControllerBridge.openNotificationAccessSettings();
        } else if (media.canPlayPause) {
          await mediaControllerBridge.playPause();
        }
        return;
      case "scroll-up":
        if (media.canSkipPrevious) {
          await mediaControllerBridge.skipPrevious();
        }
        return;
      case "scroll-down":
        if (media.canSkipNext) {
          await mediaControllerBridge.skipNext();
        }
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}