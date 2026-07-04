import { getDefaultSmallFont } from "../../graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

const NOTE_NAMES = ["C", "D", "E", "F", "G", "A", "B"] as const;
const DEFAULT_BEAT = 4; // ~250ms at 62ms units

export class BuzzerDemoLayer implements Layer {
  private note = 1;
  private oct = 2;

  paint(_ctx: LayerContext, _paintBelow: () => GrayImage): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const font = getDefaultSmallFont();

    image.drawText(font, 24, 20, "Buzzer demo", 200);
    image.drawText(font, 24, 44, `Note: ${NOTE_NAMES[this.note - 1]}   Octave: ${this.oct}`, 180);
    image.drawText(font, 24, 68, "Scroll: change note", 150);
    image.drawText(font, 24, 84, "Click: play note", 150);
    image.drawText(font, 24, 252, "Double-click: back", 130);

    const keyWidth = 64;
    const keyY = 130;
    const keyX = Math.floor((G2_LENS_WIDTH - keyWidth * NOTE_NAMES.length) / 2);
    for (let i = 0; i < NOTE_NAMES.length; i++) {
      const selected = i + 1 === this.note;
      const x = keyX + i * keyWidth;
      image.drawRect(x + 2, keyY, keyWidth - 4, 48, selected ? 220 : 80);
      const label = NOTE_NAMES[i]!;
      image.drawText(
        font,
        x + Math.max(4, Math.floor((keyWidth - font.measureText(label)) / 2)),
        keyY + 18,
        label,
        selected ? 0 : 200,
      );
    }

    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
        this.advanceNote(1);
        return;
      case "scroll-down":
        this.advanceNote(-1);
        return;
      case "click":
        await ctx.actions.playBuzzerNote(this.note, this.oct, DEFAULT_BEAT);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private advanceNote(delta: number): void {
    let next = this.note + delta;
    if (next > 7) {
      this.note = 1;
      this.oct = Math.min(3, this.oct + 1);
      return;
    }
    if (next < 1) {
      this.note = 7;
      this.oct = Math.max(0, this.oct - 1);
      return;
    }
    this.note = next;
  }
}
