import { GrayImage } from "../../graphics/image";
import { beginRenderPass, endRenderPass } from "../../util/render-freshness";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { windowIcon } from "./chrome-layer";
import { type IconName } from "../../graphics/icons";
import { APP_VIEWPORT } from "./geometry";
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
  /** Shared actions; requestRender is rebound to this window's render. */
  actions: LayerActions;
  baseLayer: Layer;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
  removeSurface?: () => void;
  onClosed?: () => void;
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
  const stack = new LayerStack(
    options.baseLayer,
    { ...options.actions, requestRender },
    { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height },
    () => shell.isWindowFocused(options.windowId),
  );

  // Data sources with caches (e.g. notification icons) may serve stale data
  // to keep the paint fast; when they do, schedule one follow-up render that
  // requires fresh data (same contract as the dashboard render loop).
  let nextRenderWantsFreshData = false;

  async function render(frameId: number): Promise<void> {
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

  const window: ShellWindow = {
    appId: options.appId,
    windowId: options.windowId,
    title: options.title,
    surfaceId: `window:${options.windowId}`,
    closeable: options.closeable,
    close: () => {
      options.onClosed?.();
      options.removeSurface?.();
    },
    drawIcon: windowIcon(options.icon, options.iconLetter),
    handleInput: async (event, frameId) => {
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
