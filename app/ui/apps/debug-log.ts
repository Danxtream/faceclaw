import takeRight from "lodash/takeRight";
import { getDefaultSmallFont } from "~/graphics/bdffont";
import { DashboardPlugin, DashboardPluginCardRenderArgs, DashboardPluginState } from "../dashboard-plugins";
import { Layer, LayerContext, type DashboardInputEvent } from "../layers";
import { GrayImage } from "~/graphics/image";

export class DebugLogDashboardPlugin extends DashboardPlugin {
  constructor() {
    super({
      id: "input-debug-log",
      label: "Input debug log",
    });
  }

  override renderCard({ image, bounds, state }: DashboardPluginCardRenderArgs): void {
    const font = getDefaultSmallFont();
    image.drawText(font, bounds.x + 10, bounds.y + 14, "Input log", 180);
    const lineHeight = 14;
    const visibleLineCount = Math.max(1, Math.floor((bounds.height - 28) / lineHeight));
    const visibleLines = takeRight(state.logLines, visibleLineCount);
    for (let i = 0; i < visibleLines.length; i++) {
      image.drawText(font, bounds.x + 8, bounds.y + 26 + i * lineHeight, visibleLines[i]!, 190);
    }
  }

  override createFullscreenLayer(getState: () => DashboardPluginState): Layer {
    return new DebugLogLayer(getState);
  }
}

class DebugLogLayer implements Layer {
  private scrollOffset = 0;

  constructor(private readonly getState: () => DashboardPluginState) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const image = new GrayImage(576, 288, 0);
    image.drawRect(12, 12, 552, 264, 52);
    image.drawText(font, 22, 16, "Input debug log", 220);

    const logs = this.getState().logLines;
    const lineHeight = 14;
    const visibleCount = Math.max(1, Math.floor((288 - 64) / lineHeight));
    const maxOffset = Math.max(0, logs.length - visibleCount);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const start = Math.max(0, maxOffset - this.scrollOffset);
    const visible = logs.slice(start, start + visibleCount);
    for (let index = 0; index < visible.length; index++) {
      image.drawText(font, 22, 42 + index * lineHeight, visible[index]!, 180);
    }
    image.drawText(font, 22, 252, "Scroll: browse  Double-click: back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.scrollOffset += 1;
        return;
      case "scroll-down":
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }
}