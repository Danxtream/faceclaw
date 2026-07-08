import { DashboardPlugin, type DashboardPluginCardRenderArgs, type DashboardPluginState } from "../dashboard-plugin";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { mediaControllerBridge, type MediaControllerState } from "../../native/media-controller";


export class MusicControllerDashboardPlugin extends DashboardPlugin {
  constructor() {
    super({
      id: "music-controller",
      label: "Music controller",
    });
  }

  override renderCard({ image, bounds, state }: DashboardPluginCardRenderArgs): void {
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
  }

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

