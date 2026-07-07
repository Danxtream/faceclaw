import { GrayImage } from "../../graphics/image";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { APP_VIEWPORT, SHELL_OPAQUE_BLACK } from "./geometry";

// The modal covers most of the app viewport, leaving a little of the
// foreground app visible around the edges.
const MODAL_MARGIN = 14;
const MODAL_PADDING = 4;
export const MODAL_RECT = {
  x: APP_VIEWPORT.x + MODAL_MARGIN,
  y: APP_VIEWPORT.y + MODAL_MARGIN,
  width: APP_VIEWPORT.width - 2 * MODAL_MARGIN,
  height: APP_VIEWPORT.height - 2 * MODAL_MARGIN,
} as const;

export const MODAL_INTERIOR = {
  width: MODAL_RECT.width - 2 * MODAL_PADDING,
  height: MODAL_RECT.height - 2 * MODAL_PADDING,
} as const;

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
    image.fillRoundedRect(MODAL_RECT.x, MODAL_RECT.y, MODAL_RECT.width, MODAL_RECT.height, SHELL_OPAQUE_BLACK, 8);
    image.drawRoundedRect(MODAL_RECT.x, MODAL_RECT.y, MODAL_RECT.width, MODAL_RECT.height, 110, 8);
    image.bitBlt(inner, MODAL_RECT.x + MODAL_PADDING, MODAL_RECT.y + MODAL_PADDING, { transparentZero: true });
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    await this.stack.handleInput(event);
  }
}
