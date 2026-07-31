import { GrayImage } from "../../graphics/image";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { appViewportRect, appViewportSize, SHELL_OPAQUE_BLACK } from "./geometry";

// The modal covers most of the min-height app viewport, leaving a little of
// the foreground app visible around the edges. Its size is fixed (min-height
// windows have a fixed viewport size); its position follows the vertical
// position setting, so it is computed per paint.
const MODAL_MARGIN = 14;
const MODAL_PADDING = 4;

export const MODAL_INTERIOR = {
  width: appViewportSize("min").width - 2 * MODAL_MARGIN - 2 * MODAL_PADDING,
  height: appViewportSize("min").height - 2 * MODAL_MARGIN - 2 * MODAL_PADDING,
} as const;

/** Screen rect of the modal box, aligned to the min-height window band. */
export function modalRect(): { x: number; y: number; width: number; height: number } {
  const viewport = appViewportRect("min");
  return {
    x: viewport.x + MODAL_MARGIN,
    y: viewport.y + MODAL_MARGIN,
    width: viewport.width - 2 * MODAL_MARGIN,
    height: viewport.height - 2 * MODAL_MARGIN,
  };
}

/**
 * A shell overlay hosting an inner layer stack in a bordered box over the
 * app viewport (used for new-notification popups). The inner stack paints at
 * the modal's interior size; its pixels blit onto an opaque black backdrop,
 * so inner value-0 pixels read as black, not transparent.
 */
export class ShellModalLayer implements Layer {
  private readonly stack: LayerStack;

  constructor(baseLayer: Layer, actions: LayerActions) {
    this.stack = new LayerStack(baseLayer, actions, {
      width: MODAL_INTERIOR.width,
      height: MODAL_INTERIOR.height,
    });
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const inner = this.stack.paint();
    const rect = modalRect();
    image.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, SHELL_OPAQUE_BLACK, 8);
    image.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 110, 8);
    image.bitBlt(inner, rect.x + MODAL_PADDING, rect.y + MODAL_PADDING, { transparentZero: true });
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    await this.stack.handleInput(event);
  }
}
