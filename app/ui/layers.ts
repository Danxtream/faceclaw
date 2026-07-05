import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { BdfFont } from "../graphics/bdffont";
import { spanCurrent } from "../native/frame-timings";
import { type ConfigSettingString } from "./dashboard-settings";

export type DashboardInputEvent =
  | { type: "click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "double-click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "scroll-up" }
  | { type: "scroll-down" }
  | { type: "long-press"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "long-press-release"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "unknown"; kind: string; eventSource: number; eventType: number };

export type LayerActions = {
  /** Ask for a dashboard repaint+transmit, e.g. when async data arrives. */
  requestRender: () => void;
  disconnect: () => Promise<void> | void;
  startTextSettingEdit: (setting: ConfigSettingString) => Promise<void> | void;
  endTextSettingEdit: () => Promise<void> | void;
  setVoiceControlEnabled: (enabled: boolean) => Promise<void> | void;
  setStopwatchRenderActive: (active: boolean) => Promise<void> | void;
  setTranscribeRenderActive: (active: boolean) => Promise<void> | void;
  startDedicatedVoiceInput: (mode: "wakeword" | "full") => Promise<void> | void;
  stopDedicatedVoiceInput: () => Promise<void> | void;
  playBuzzerNote: (note: number, oct: number, beat: number) => Promise<void> | void;
};

export type PaintBelow = () => GrayImage;

function notifyRemoved(layer: Layer | undefined): void {
  try {
    layer?.onRemoved?.();
  } catch (error) {
    console.warn("layer onRemoved failed", error);
  }
}

export interface LayerContext {
  readonly stack: LayerStack;
  readonly actions: LayerActions;
}

export interface Layer {
  readonly paintOverBase?: boolean;
  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage;
  handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> | void;
  /** Called when the layer leaves the stack by any path (pop or clearToBase). */
  onRemoved?(): void;
}

export class LayerStack {
  private readonly layers: Layer[];
  private readonly ctx: LayerContext;

  constructor(baseLayer: Layer, actions: LayerActions) {
    this.layers = [baseLayer];
    this.ctx = {
      stack: this,
      actions,
    };
  }

  push(layer: Layer): void {
    this.layers.push(layer);
  }

  pop(): void {
    if (this.layers.length > 1) {
      notifyRemoved(this.layers.pop());
    }
  }

  /** Pop the top layer only if it matches; returns whether a layer was popped. */
  popIfTop(predicate: (layer: Layer) => boolean): boolean {
    if (this.layers.length > 1 && predicate(this.layers[this.layers.length - 1]!)) {
      notifyRemoved(this.layers.pop());
      return true;
    }
    return false;
  }

  clearToBase(): void {
    for (const layer of this.layers.splice(1)) {
      notifyRemoved(layer);
    }
  }

  isAtBase(): boolean {
    return this.layers.length === 1;
  }

  setActions(actions: Partial<LayerActions>): void {
    Object.assign(this.ctx.actions, actions);
  }

  paint(): GrayImage {
    return this.paintLayer(this.layers.length - 1);
  }

  async handleInput(event: DashboardInputEvent): Promise<void> {
    await this.layers[this.layers.length - 1]!.handleInput(event, this.ctx);
  }

  private paintLayer(index: number): GrayImage {
    const layer = this.layers[index]!;
    let cachedBelow: GrayImage | null = null;
    return spanCurrent(`paint[${index}]:${layer.constructor.name}`, () =>
      layer.paint(this.ctx, () => {
        if (cachedBelow) {
          return cachedBelow;
        }
        if (index <= 0) {
          cachedBelow = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
        } else if (layer.paintOverBase) {
          cachedBelow = this.paintLayer(0);
        } else {
          cachedBelow = this.paintLayer(index - 1);
        }
        return cachedBelow;
      }),
    );
  }
}
