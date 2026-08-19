import { GrayImage } from "../../graphics/image";
import * as frameTimings from "../../native/frame-timings";
import { beginRenderPass, endRenderPass } from "../../util/render-freshness";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { type MenuItem } from "../menu";
import { WindowMenuLayer } from "../window-menu";
import { windowIcon } from "./chrome-layer";
import { type IconName } from "../../graphics/icons";
import { appViewportSize, type WindowHeightMode } from "./geometry";
import { shell, type ShellWindow } from "./shell";

/**
 * A window whose app logic runs on the main thread (launcher, settings):
 * hosts a viewport-sized LayerStack, renders it on input or request, and
 * submits frames through a controller-provided submitter. Java-side dedup
 * finishes no-change frames, so unconditional resubmits keep frame ownership
 * simple.
 */
export type InProcessWindowOptions = {
  appId: string;
  windowId: string;
  title: string;
  iconLetter: string;
  /** Lucide icon name for the sidebar indicator; falls back to iconLetter. */
  icon?: IconName;
  closeable: boolean;
  /** Window height: the standard 288px band ("min", default) or full screen ("max"). */
  heightMode?: WindowHeightMode;
  /**
   * App-specific entries for the window's long-press menu, listed ahead of
   * the default Voice input / Close window entries. Called at open time, so
   * the items can reflect current app state.
   */
  menuItems?: () => MenuItem[];
  /** Shared actions; requestRender is rebound to this window's render. */
  actions: LayerActions;
  baseLayer: Layer;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface?: () => void;
  onClosed?: () => void;
  /** When true, the app/firmware owns the framebuffer and normal compositor frames must be dropped. */
  shouldSuppressRender?: () => boolean;
};

export type InProcessWindow = {
  window: ShellWindow;
  stack: LayerStack;
  requestRender: () => void;
};

/** The controller-provided plumbing common to every in-process app window. */
export type InProcessAppOptions = {
  actions: LayerActions;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface: () => void;
  onClosed: () => void;
};

export function createInProcessWindow(options: InProcessWindowOptions): InProcessWindow {
  const requestRender = () => {
    void render(0).catch((error) => {
      console.error(`${options.windowId} render failed: ${error}`);
    });
  };
  const heightMode = options.heightMode ?? "min";
  const stack = new LayerStack(
    options.baseLayer,
    { ...options.actions, requestRender },
    appViewportSize(heightMode),
    () => shell.isWindowFocused(options.windowId),
  );

  // Data sources with caches (e.g. notification icons) may serve stale data
  // to keep the paint fast; when they do, schedule one follow-up render that
  // requires fresh data (same contract as the dashboard render loop).
  let nextRenderWantsFreshData = false;
  let closed = false;

  async function render(frameId: number): Promise<void> {
    if (closed) {
      // The surface is gone (e.g. Close window picked from this window's own
      // menu); dropping the frame beats submitting to a removed surface.
      frameTimings.finishFrame(frameId, "discarded: window closed");
      return;
    }
    if (options.shouldSuppressRender?.()) {
      frameTimings.finishFrame(frameId, "discarded: direct framebuffer owner");
      return;
    }
    const wantFreshData = nextRenderWantsFreshData;
    nextRenderWantsFreshData = false;
    beginRenderPass(!wantFreshData);
    const paintStartedAtMs = Date.now();
    const image = stack.paint();
    const paintUsedStaleData = endRenderPass();
    await options.submitFrame(image, Date.now() - paintStartedAtMs, frameId);
    if (paintUsedStaleData) {
      nextRenderWantsFreshData = true;
      requestRender();
    }
  }

  // The window's long-press menu: app-specific items, then the defaults every
  // window shares. In-process apps run on the main thread, so the default
  // items act on the shell directly (workers post messages instead).
  const openWindowMenu = () => {
    if (stack.topMatches((layer) => layer instanceof WindowMenuLayer)) return;
    const items: MenuItem[] = [...(options.menuItems?.() ?? [])];
    items.push({
      label: "Voice input",
      onSelect: (ctx) => {
        ctx.stack.pop();
        shell.startVoiceInput();
      },
    });
    if (options.closeable) {
      items.push({
        label: "Close window",
        onSelect: (ctx) => {
          ctx.stack.pop();
          shell.closeWindow(options.windowId);
        },
      });
    }
    stack.push(new WindowMenuLayer(items));
  };

  const window: ShellWindow = {
    appId: options.appId,
    windowId: options.windowId,
    title: options.title,
    surfaceId: `window:${options.windowId}`,
    closeable: options.closeable,
    heightMode,
    close: () => {
      closed = true;
      // Fire onRemoved for any pushed layers so they release resources (e.g. a
      // demo that enabled a hardware stream) even when closed from within.
      stack.clearToBase();
      options.onClosed?.();
      options.removeSurface?.();
    },
    drawIcon: windowIcon(options.icon, options.iconLetter),
    handleInput: async (event, frameId) => {
      // The default long-press response: the window menu. Handled here (not
      // per-layer) so it works over submenus and app content alike.
      if (event.type === "long-press") {
        openWindowMenu();
        await render(frameId);
        return;
      }
      await stack.handleInput(event);
      await render(frameId);
    },
    requestRender,
    setForeground: (foreground) => {
      options.setSurfaceVisible(foreground);
    },
  };
  return { window, stack, requestRender };
}

/**
 * Wrap an app's root layer so double-click at the root yields focus to the
 * shell sidebar (the standard leave-the-app gesture) instead of being
 * swallowed by the layer's own back handling.
 */
export class YieldAtRootLayer implements Layer {
  constructor(private readonly inner: Layer) {}

  get paintOverBase(): boolean | undefined {
    return this.inner.paintOverBase;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.inner.paint(ctx, paintBelow);
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      shell.yieldFocusToSidebar();
      return;
    }
    await this.inner.handleInput(event, ctx);
  }

  onRemoved(): void {
    this.inner.onRemoved?.();
  }
}
