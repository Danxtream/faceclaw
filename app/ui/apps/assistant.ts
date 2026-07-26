import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { drawSelectionHighlight } from "../menu";
import { Layer, type DashboardInputEvent, type LayerActions, type LayerContext } from "../layers";
import { wrapText, truncateText } from "../../graphics/textwrap";

const DIALOG_X = 40;
const DIALOG_Y = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
const DIALOG_H = G2_LENS_HEIGHT - 80;
const TEXT_MAX_WIDTH = DIALOG_W - 32;
const MENU_ROW_H = 20;
const MENU_ROWS = 2;

/** thinking: turn running; done/error: finished, showing the Follow-up/Done menu. */
type AssistantPhase = "thinking" | "done" | "error";

export type AssistantLayerCallbacks = {
  /** Record another utterance and continue this conversation. */
  onFollowUp: () => void;
  /** Abort the in-flight turn (double-click while thinking). */
  onCancel: () => void;
  /** The user closed the overlay (Done). */
  onClose: () => void;
  /** The layer left the stack by any path (Done, or the screen sleeping). */
  onRemoved?: () => void;
};

/**
 * The assistant overlay: streamed reply text with a status line for tool
 * activity, and a Follow-up / Done menu once the turn ends. Double-click
 * cancels an in-flight turn. The shell owns the AssistantSession and drives
 * this layer's state through the on* methods as the turn streams.
 */
export class AssistantLayer implements Layer {
  private phase: AssistantPhase = "thinking";
  private replyText = "";
  private status = "Thinking...";
  private menuIndex = 0;

  constructor(
    private readonly actions: LayerActions,
    private readonly callbacks: AssistantLayerCallbacks,
  ) {}

  /** Shell: a new turn (initial utterance or follow-up) is starting. */
  startTurn(): void {
    this.phase = "thinking";
    this.replyText = "";
    this.status = "Thinking...";
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  onTextDelta(_delta: string, textSoFar: string): void {
    this.replyText = textSoFar;
    if (this.phase === "thinking") this.status = "Thinking...";
    this.actions.requestRender();
  }

  onToolActivity(label: string): void {
    if (this.phase === "thinking") this.status = `→ ${label}`;
    this.actions.requestRender();
  }

  onTurnDone(): void {
    this.phase = "done";
    this.status = this.replyText.trim() ? "" : "(no reply)";
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  onError(message: string): void {
    this.phase = "error";
    this.status = message;
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const font = getDefaultSmallFont();
    const image = paintBelow();

    // Solid dialog box (fill 1, matching the voice dialog: opaque after 4bpp
    // quantization, but not the color-key transparent 0).
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 1, 10);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 90, 10);

    const left = DIALOG_X + 16;
    image.drawText(font, left, DIALOG_Y + 12, this.phase === "thinking" ? "Assistant ●" : "Assistant", 220);
    if (this.status) {
      const statusValue = this.phase === "error" ? 200 : 130;
      image.drawText(font, left, DIALOG_Y + 30, truncateText(font, this.status, TEXT_MAX_WIDTH), statusValue);
    }

    const inMenu = this.phase !== "thinking";
    const textBottom = inMenu ? DIALOG_Y + DIALOG_H - MENU_ROWS * MENU_ROW_H - 8 : DIALOG_Y + DIALOG_H - 8;
    const textTop = DIALOG_Y + 56;
    const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

    const wrapped = wrapText(font, this.replyText, TEXT_MAX_WIDTH);
    // Keep the tail visible as text streams past the bottom.
    const firstLine = Math.max(0, wrapped.length - maxLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
    }

    if (inMenu) {
      const rows = ["Follow-up", "Done"];
      const menuTop = DIALOG_Y + DIALOG_H - MENU_ROWS * MENU_ROW_H - 2;
      for (let i = 0; i < rows.length; i++) {
        const rowY = menuTop + i * MENU_ROW_H;
        const selected = i === this.menuIndex;
        if (selected) {
          drawSelectionHighlight(image, left - 4, rowY - 2, DIALOG_W - 24, MENU_ROW_H - 2, true, 6);
        }
        image.drawText(font, left + 4, rowY + 2, rows[i]!, selected ? 255 : 200);
      }
    } else {
      image.drawText(font, left, DIALOG_Y + DIALOG_H - 14, `${GESTURE_DOUBLE_CLICK} cancel`, 110);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (this.phase === "thinking") {
      if (event.type === "double-click") {
        this.callbacks.onCancel();
        this.phase = "done";
        this.status = "Cancelled";
        this.menuIndex = 0;
        this.actions.requestRender();
      }
      return;
    }
    // done / error: the Follow-up / Done menu.
    switch (event.type) {
      case "scroll-up":
        this.menuIndex = (this.menuIndex + MENU_ROWS - 1) % MENU_ROWS;
        this.actions.requestRender();
        return;
      case "scroll-down":
        this.menuIndex = (this.menuIndex + 1) % MENU_ROWS;
        this.actions.requestRender();
        return;
      case "click":
        if (this.menuIndex === 0) {
          this.callbacks.onFollowUp();
        } else {
          this.callbacks.onClose();
        }
        return;
      case "double-click":
        this.callbacks.onClose();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.callbacks.onRemoved?.();
  }
}
