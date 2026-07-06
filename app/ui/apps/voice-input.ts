import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { Layer, type DashboardInputEvent, type LayerActions, type LayerContext } from "../layers";

const DIALOG_X = 40;
const DIALOG_Y = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
const DIALOG_H = G2_LENS_HEIGHT - 80;
const TEXT_MAX_WIDTH = DIALOG_W - 32;

/**
 * Push-to-talk voice dialog, drawn on top of whatever is already on screen.
 * The mic runs while the button is held (long-press); releasing it stops the
 * mic and finalizes. The dialog stays up until dismissed with a double-click.
 */
export class VoiceInputLayer implements Layer {
  private status = "Listening...";
  private finalizedText = "";
  private liveText = "";
  private capturing = false;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(
    private readonly actions: LayerActions,
    private readonly onClosed: () => void,
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

  /** Button released: stop the mic and finalize, but keep the dialog open. */
  endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    void this.actions.stopVoiceCapture();
    if (this.status.startsWith("Listening")) {
      this.status = "Double-click to close.";
    }
    this.actions.requestRender();
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const font = getDefaultSmallFont();
    const image = paintBelow();

    // Solid dialog box over the underlying UI.
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 0, 10);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_W, DIALOG_H, 90, 10);

    const left = DIALOG_X + 16;
    image.drawText(font, left, DIALOG_Y + 12, this.capturing ? "Voice ●" : "Voice", 220);
    image.drawText(font, left, DIALOG_Y + 30, truncate(font, this.status, TEXT_MAX_WIDTH), 130);

    const text = this.displayText() || (this.capturing ? "Listening..." : "(no speech detected)");
    const wrapped = wrapText(font, text, TEXT_MAX_WIDTH);
    const maxLines = 8;
    const firstLine = Math.max(0, wrapped.length - maxLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      image.drawText(font, left, DIALOG_Y + 56 + (index - firstLine) * 16, wrapped[index]!, 235);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
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
