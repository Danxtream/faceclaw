import { GrayImage } from "../graphics/image";
import {
  noopLayerActions,
  LayerStack,
  type DashboardInputEvent,
  type Layer,
} from "./layers";
import { MenuLayer, type MenuItem, type MenuLayout } from "./menu";
import type { WorkerAppReply } from "./shell/worker-window";

/**
 * The window long-press menu. By convention every app answers a long-press by
 * opening one of these: its app-specific actions followed by the default
 * entries (Voice input, Close window). This is a convenience path, not the
 * safety net — the shell separately opens its own escape menu when the press
 * is held long enough, so an unresponsive app can always be closed.
 */

/** Viewport-relative layout; visually matches the shell's escape menu position. */
export const WINDOW_MENU_LAYOUT: MenuLayout = { x: 8, y: 8, width: 272, minHeight: 0 };

export class WindowMenuLayer extends MenuLayer {
  constructor(items: MenuItem[]) {
    super(null, items, WINDOW_MENU_LAYOUT);
  }
}

export type WindowMenuOptions = {
  /** Paint the window content the menu draws over (a fresh, mutable image). */
  paintBase: () => GrayImage;
  size: { width: number; height: number };
  isFocused: () => boolean;
};

/**
 * Menu host for worker apps, which paint pixels directly rather than through
 * a persistent LayerStack. Wraps a short-lived stack so MenuLayer (and the
 * ctx.stack.pop() convention in item callbacks) works unchanged.
 *
 * Usage: route input to handleInput while isOpen(); paint() returns the
 * window content with the menu drawn over it.
 */
export class WindowMenu {
  private stack: LayerStack | null = null;

  constructor(private readonly options: WindowMenuOptions) {}

  isOpen(): boolean {
    return this.stack !== null;
  }

  open(items: MenuItem[]): void {
    if (this.stack) return;
    const base: Layer = {
      paint: () => this.options.paintBase(),
      handleInput: () => {},
    };
    const stack = new LayerStack(base, { ...noopLayerActions }, this.options.size, this.options.isFocused);
    stack.push(new WindowMenuLayer(items));
    this.stack = stack;
  }

  /** Paint the window content with the menu over it (content alone if closed). */
  paint(): GrayImage {
    return this.stack ? this.stack.paint() : this.options.paintBase();
  }

  /** Route an input event to the menu; the menu closes by popping itself. */
  async handleInput(event: DashboardInputEvent): Promise<void> {
    const stack = this.stack;
    if (!stack) return;
    await stack.handleInput(event);
    if (stack.isAtBase()) {
      this.stack = null;
    }
  }
}

/**
 * The default entries every window menu ends with, in worker form: the
 * actions cross to the shell as WorkerAppReply messages. In-process windows
 * build the equivalent items against the shell directly (in-process-window.ts).
 */
export function defaultWindowMenuItems(
  windowId: string,
  post: (reply: WorkerAppReply) => void,
): MenuItem[] {
  return [
    {
      label: "Voice input",
      onSelect: (ctx) => {
        ctx.stack.pop();
        post({ type: "start-voice-input", windowId });
      },
    },
    {
      label: "Close window",
      onSelect: (ctx) => {
        ctx.stack.pop();
        post({ type: "close-window-request", windowId });
      },
    },
  ];
}
