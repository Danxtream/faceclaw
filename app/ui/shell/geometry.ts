import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import { verticalPositionSetting } from "../dashboard-settings";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;
/** Left sidebar: 32px window icons plus a little padding. */
export const SIDEBAR_WIDTH = 36;

/**
 * On the color-key shell surface, pixel value 0 is transparent; 1 is the
 * darkest opaque shade (identical to 0 after 4bpp quantization). Shell
 * painting must use this for intentional black.
 */
export const SHELL_OPAQUE_BLACK = 1;

/**
 * Windows come in two heights. "min" covers the same 288px band the stock
 * firmware uses, leaving most of the field of view clear; "max" uses the
 * whole 480px screen (terminal views). Both include a top bar drawn by the
 * shell at the window's top edge.
 */
export type WindowHeightMode = "min" | "max";

/** Total height (top bar + content) of a min-height window. */
export const MIN_WINDOW_HEIGHT = 288;
/** Farthest down a min-height window can start. */
export const MIN_WINDOW_MAX_TOP = G2_LENS_HEIGHT - MIN_WINDOW_HEIGHT;

/**
 * Top edge (y) of a min-height window, from the Display > Vertical position
 * setting. The sidebar and shell overlays always align to this band, even
 * while a max-height window is foreground.
 */
export function minWindowTop(): number {
  switch (verticalPositionSetting.get()) {
    case "top":
      return 0;
    case "upper":
      return Math.round(MIN_WINDOW_MAX_TOP * 0.25);
    case "lower":
      return Math.round(MIN_WINDOW_MAX_TOP * 0.75);
    case "bottom":
      return MIN_WINDOW_MAX_TOP;
    default:
      return Math.round(MIN_WINDOW_MAX_TOP * 0.5);
  }
}

/** Top edge (y) of a window's top bar; max-height windows pin to the screen top. */
export function windowTop(mode: WindowHeightMode): number {
  return mode === "max" ? 0 : minWindowTop();
}

/** App-content viewport size for a height mode (independent of vertical position). */
export function appViewportSize(mode: WindowHeightMode): { width: number; height: number } {
  return {
    width: G2_LENS_WIDTH - SIDEBAR_WIDTH,
    height: (mode === "max" ? G2_LENS_HEIGHT : MIN_WINDOW_HEIGHT) - TOP_BAR_HEIGHT,
  };
}

/** Screen rect of a window's app-content viewport (below its top bar). */
export function appViewportRect(mode: WindowHeightMode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: SIDEBAR_WIDTH,
    y: windowTop(mode) + TOP_BAR_HEIGHT,
    ...appViewportSize(mode),
  };
}
