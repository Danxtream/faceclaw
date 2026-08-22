import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import {
  ensureG2VideoDirectory,
  g2VideoDirectoryPath,
  isG2VideoPickerFile,
  resolveG2H264Path,
  shouldShowG2VideoEntry,
} from "../../native/g2-video-library";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";
import { FileBrowserLayer } from "../files/file-browser";
import type { AppContext } from "../app-definition";
import { VideoPlaybackController, type PauseOverlaySelection } from "./playback-controller";

const PAUSE_ACTIONS: readonly { label: string; deltaMs?: number }[] = [
  { label: "PLAY" },
  { label: "-10", deltaMs: -10_000 },
  { label: "+10", deltaMs: 10_000 },
  { label: "-30", deltaMs: -30_000 },
  { label: "+30", deltaMs: 30_000 },
];

type VideoMode = "browser" | "loading" | "playing";

export class VideoAppLayer implements Layer {
  private mode: VideoMode = "browser";
  private readonly browser: FileBrowserLayer;
  private controller: VideoPlaybackController | null = null;
  private pauseSelection: PauseOverlaySelection = 0;
  private loadingLabel = "Opening video...";

  constructor(private readonly appCtx: AppContext) {
    const root = ensureG2VideoDirectory() ?? g2VideoDirectoryPath();
    this.browser = new FileBrowserLayer({
      title: "G2 Videos",
      rootPath: root,
      includeEntry: shouldShowG2VideoEntry,
      isSupportedFile: isG2VideoPickerFile,
      onFilePicked: (entry, ctx) => {
        if (entry.isDirectory) return;
        const h264Path = resolveG2H264Path(entry.path);
        if (h264Path) void this.openVideo(h264Path, ctx);
      },
      onLeave: () => shell.yieldFocusToSidebar(),
    });
  }

  /** While firmware owns the direct framebuffer, do not submit ordinary app frames. */
  suppressesShellRender(): boolean {
    return this.controller !== null;
  }

  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    if (this.mode === "browser") {
      // Retrying creation here handles returning from Android's all-files permission screen.
      ensureG2VideoDirectory();
      this.browser.refreshEntries();
      return this.browser.paint(ctx);
    }

    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const font = getDefaultSmallFont();
    image.drawText(font, 20, 20, this.loadingLabel, 220);
    image.drawText(font, 20, 42, "Double-click to cancel / return", 120);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (this.mode === "browser") {
      if (
        event.type === "scroll-up" ||
        event.type === "scroll-down"
      ) {
        this.browser.refreshEntries();
      }
      await this.browser.handleInput(event, ctx);
      return;
    }

    if (this.mode === "loading") {
      if (event.type === "double-click") {
        await this.stopPlayback();
        this.mode = "browser";
        ctx.actions.requestRender();
      }
      return;
    }

    const controller = this.controller;
    if (!controller) return;

    if (event.type === "double-click") {
      await this.stopPlayback();
      this.mode = "browser";
      ctx.actions.requestRender();
      return;
    }

    if (event.type === "click") {
      if (controller.isPlaying) {
        this.pauseSelection = 0;
        await controller.pause();
        await controller.setPauseOverlaySelection(this.pauseSelection);
        return;
      }

      // Synchronize the app-layer cursor with the controller. Phone seeks also
      // reset the controller to PLAY, so a later glasses tap cannot accidentally
      // repeat an old skip selection.
      this.pauseSelection = controller.pauseOverlaySelection;

      const action = PAUSE_ACTIONS[this.pauseSelection]!;
      if (this.pauseSelection === 0) {
        await controller.resume();
      } else if (action.deltaMs !== undefined) {
        await controller.seekBy(action.deltaMs);

        // The target frame remains on screen, paused. Return the cursor to PLAY
        // so one deliberate later tap resumes playback.
        this.pauseSelection = 0;
      }
      return;
    }

    if (!controller.isPlaying && (event.type === "scroll-up" || event.type === "scroll-down")) {
      const delta = event.type === "scroll-up" ? -1 : 1;
      const current = controller.pauseOverlaySelection;
      const next = (current + delta + PAUSE_ACTIONS.length) % PAUSE_ACTIONS.length;
      this.pauseSelection = next as PauseOverlaySelection;
      await controller.setPauseOverlaySelection(this.pauseSelection);
    }
  }

  async dispose(): Promise<void> {
    await this.stopPlayback();
  }

  private async openVideo(path: string, ctx: LayerContext): Promise<void> {
    await this.stopPlayback();
    this.mode = "loading";
    this.loadingLabel = `Opening ${path.slice(path.lastIndexOf("/") + 1)}...`;
    ctx.actions.requestRender();

    const controller = new VideoPlaybackController(
      this.appCtx,
      path,
      () => { void this.finishNaturalPlayback(ctx); },
      () => { void this.exitPlayback(ctx); },
    );
    this.controller = controller;
    this.pauseSelection = 0;

    try {
      await controller.start();
      if (this.controller === controller) this.mode = "playing";
    } catch (error) {
      this.appCtx.appendLog(`video open failed: ${error}`);
      if (this.controller === controller) this.controller = null;
      try {
        await controller.stop();
      } catch (cleanupError) {
        this.appCtx.appendLog(`video cleanup after open failure failed: ${cleanupError}`);
      }
      this.mode = "browser";
      ctx.actions.requestRender();
    }
  }

  private async finishNaturalPlayback(ctx: LayerContext): Promise<void> {
    await this.stopPlayback();
    this.mode = "browser";
    ctx.actions.requestRender();
  }

  private async exitPlayback(ctx: LayerContext): Promise<void> {
    await this.stopPlayback();
    this.mode = "browser";
    ctx.actions.requestRender();
  }

  private async stopPlayback(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    if (!controller) return;
    try {
      await controller.stop();
    } catch (error) {
      this.appCtx.appendLog(`video stop failed: ${error}`);
    }
  }
}
