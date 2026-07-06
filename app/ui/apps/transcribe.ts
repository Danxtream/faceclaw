import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { Layer, type DashboardInputEvent, type LayerActions, type LayerContext } from "../layers";

export class TranscribeLayer implements Layer {
  private status = "Starting transcription...";
  // Finalized utterances, plus the live (replace-semantics) partial appended
  // when painting.
  private finalizedText = "";
  private liveText = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private actions: LayerActions | null = null;

  start(ctx: LayerContext): void {
    this.actions = ctx.actions;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      ctx.actions.requestRender();
    });
    void ctx.actions.setTranscribeRenderActive(true);
    void Promise.resolve(ctx.actions.startVoiceCapture());
  }

  paint(): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const text = this.displayText() || "Listening...";
    const wrapped = wrapTranscribeText(font, text, G2_LENS_WIDTH - 64);

    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(font, 24, 24, "Transcribe", 200);
    image.drawText(font, 24, 46, this.status, 110);

    const firstLine = Math.max(0, wrapped.length - 10);
    for (let index = firstLine; index < wrapped.length; index++) {
      const y = 72 + (index - firstLine) * 16;
      image.drawText(font, 32, y, wrapped[index]!, 230);
    }

    image.drawText(font, 24, 252, "Double-click: back", 110);
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
    void this.actions?.setTranscribeRenderActive(false);
    void this.actions?.stopVoiceCapture();
    this.actions = null;
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
      // Replace semantics: the live partial is the whole current best transcript.
      this.liveText = event.text.trim();
    }
  }
}

function wrapTranscribeText(font: BdfFont, text: string, maxWidth: number): string[] {
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
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

