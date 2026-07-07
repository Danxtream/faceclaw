import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";

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

/** Screen region belonging to the foreground app window (compile-time fixed). */
export const APP_VIEWPORT = {
  x: SIDEBAR_WIDTH,
  y: TOP_BAR_HEIGHT,
  width: G2_LENS_WIDTH - SIDEBAR_WIDTH,
  height: G2_LENS_HEIGHT - TOP_BAR_HEIGHT,
} as const;
