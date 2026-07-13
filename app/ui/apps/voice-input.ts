import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { drawSelectionHighlight } from "../menu";
import { Layer, type DashboardInputEvent, type LayerActions, type LayerContext } from "../layers";

const DIALOG_X = 40;
const DIALOG_Y = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
const DIALOG_H = G2_LENS_HEIGHT - 80;
const TEXT_MAX_WIDTH = DIALOG_W - 32;
const MENU_ROW_H = 20;

/**
 * Push-to-talk voice dialog, drawn on top of whatever is already on screen.
 * The mic runs while the button is held (long-press); releasing it stops the
 * mic and shows a Send / Discard menu. Send delivers the transcript to the
 * foreground window (e.g. the terminal); Discard (or double-click) closes.
 */
export class VoiceInputLayer implements Layer {
  private status = "Listening...";
  private finalizedText = "";
  private liveText = "";
  private capturing = false;
  // Set once the button is released: the mic has stopped and the Send/Discard
  // menu is active.
  private finished = false;
  private menuIndex = 0;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(
    private readonly actions: LayerActions,
    private readonly onClosed: () => void,
    private readonly onSend: (text: string) => void,
  ) {}

  startCapture(): void {
    if (this.capturing) return;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.actions.requestRender();
    });
    this.capturing = true;
    void this.actions.startVoiceCapture();
    this.actions.requestRender();
  }

  /** Button released: stop the mic, finalize, and show the Send/Discard menu. */
  endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.finished = true;
    void this.actions.stopVoiceCapture();
    if (this.status.startsWith("Listening")) {
      this.status = "Send or discard?";
    }
    this.actions.requestRender();
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const font = getDefaultSmallFont();
    const image = paintBelow();

    // Solid dialog box over the underlying UI. Fill 1, not 0: identical after
    // 4bpp quantization, but 0 is transparent on the color-key shell surface.
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 1, 10);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 90, 10);

    const left = DIALOG_X + 16;
    image.drawText(font, left, DIALOG_Y + 12, this.capturing ? "Voice ●" : "Voice", 220);
    image.drawText(font, left, DIALOG_Y + 30, truncate(font, this.status, TEXT_MAX_WIDTH), 130);

    const hasText = this.displayText().trim().length > 0;
    // Leave room for the two-row menu when finished.
    const textBottom = this.finished ? DIALOG_Y + DIALOG_H - 2 * MENU_ROW_H - 8 : DIALOG_Y + DIALOG_H - 8;
    const textTop = DIALOG_Y + 56;
    const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

    const text = this.displayText() || (this.capturing ? "Listening..." : "(no speech detected)");
    const wrapped = wrapText(font, text, TEXT_MAX_WIDTH);
    const firstLine = Math.max(0, wrapped.length - maxLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
    }

    if (this.finished) {
      const labels = ["Send", "Discard"];
      const menuTop = DIALOG_Y + DIALOG_H - 2 * MENU_ROW_H - 2;
      for (let i = 0; i < labels.length; i++) {
        const rowY = menuTop + i * MENU_ROW_H;
        const selected = i === this.menuIndex;
        if (selected) {
          drawSelectionHighlight(image, left - 4, rowY - 2, DIALOG_W - 24, MENU_ROW_H - 2, true, 6);
        }
        // Dim "Send" when there is nothing to send.
        const dim = i === 0 && !hasText;
        image.drawText(font, left + 4, rowY + 2, labels[i]!, dim ? 90 : selected ? 255 : 200);
      }
    } else {
      image.drawText(font, left, DIALOG_Y + DIALOG_H - 14, `${GESTURE_DOUBLE_CLICK} close`, 110);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (!this.finished) {
      if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        // Two options; either scroll direction toggles the selection.
        this.menuIndex = (this.menuIndex + 1) % 2;
        this.actions.requestRender();
        return;
      case "click":
        if (this.menuIndex === 0) {
          const text = this.displayText().trim();
          if (text) this.onSend(text);
        }
        ctx.stack.pop();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture();
    }
    this.onClosed();
  }

  private displayText(): string {
    if (!this.finalizedText) return this.liveText;
    if (!this.liveText) return this.finalizedText;
    return `${this.finalizedText} ${this.liveText}`;
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.isFinal) {
      const finalText = event.text.trim() || this.liveText.trim();
      if (finalText) {
        this.finalizedText = this.finalizedText ? `${this.finalizedText} ${finalText}` : finalText;
      }
      this.liveText = "";
    } else {
      this.liveText = event.text.trim();
    }
    this.actions.requestRender();
  }
}

function wrapText(font: BdfFont, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.measureText(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function truncate(font: BdfFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}
