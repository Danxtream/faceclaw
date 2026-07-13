import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { EventSourceType, OsEventTypeList } from "../../g2/events";
import type { RawInputEvent } from "../../native/faceclaw-communicator";
import { DashboardInputEvent, LayerActions, LayerStack } from "../layers";
import { MenuLayer, type MenuItem } from "../menu";
import { VoiceInputLayer } from "../apps/voice-input";
import { SingleNotificationLayer } from "../notifications";
import { batteryDisplayModeSetting, onAnySettingChanged, timeFormatSetting } from "../dashboard-settings";
import { ShellChromeLayer, type ShellChromeState, type ShellChromeWindow } from "./chrome-layer";
import { ShellModalLayer } from "./modal-layer";
import { SIDEBAR_WIDTH, TOP_BAR_HEIGHT } from "./geometry";

/**
 * The shell: owns the window registry, focus, screen on/off, and the shell
 * surface (sidebar + top bar + shell overlays such as the long-press menu and
 * the push-to-talk dialog). Runs on the main thread; windows will later live
 * in worker threads, today the only window is the in-process dashboard.
 *
 * Input flow: every event enters via receiveInput. The shell consumes its
 * reserved gestures (long-press, and everything while the sidebar or a shell
 * overlay has focus) and forwards the rest to the focused window. Windows
 * never see events the shell consumed, and the shell keeps working when a
 * window's handler hangs (the long-press menu is the escape hatch).
 */

export type ShellWindow = {
  appId: string;
  windowId: string;
  title: string;
  /** Compositor surface this window renders to; configured at connect / launch. */
  surfaceId: string;
  /** Whether the shell's long-press menu offers Close Window (launcher and dashboard are pinned). */
  closeable: boolean;
  /** App-side cleanup when the shell closes the window (worker notification, surface removal). */
  close?: () => void;
  drawIcon: ShellChromeWindow["drawIcon"];
  /**
   * Handle an input event the shell forwarded. Ownership of frameId (latency
   * tracking) passes to the window: it must eventually reach a frame submit
   * or a finishFrame call.
   */
  handleInput: (event: DashboardInputEvent, frameId: number) => Promise<void> | void;
  /** Repaint and resubmit this window's surface. */
  requestRender: () => void;
  /**
   * Deliver a text string to the window (e.g. finalized voice input). Optional:
   * only windows that consume typed text (the terminal) implement it.
   */
  receiveTextInput?: (text: string) => void;
  /** Foreground state changed: this window's surface is (not) the visible one. */
  setForeground?: (foreground: boolean) => void;
  /** Screen turned on/off; hidden or screen-off windows should stop painting. */
  setScreenOn?: (on: boolean) => void;
};

export type ShellConfig = {
  /** Actions handed to shell overlay layers; requestRender must re-render the shell surface. */
  actions: LayerActions;
  getScreenTimeoutMs: () => number | null;
  requestShellRender: () => void;
  /** Screen on/off changed: the controller blanks/unblanks the compositor. */
  onScreenStateChanged: (on: boolean) => void;
};

/** Which surfaces need re-rendering after an input event. */
export type ShellInputOutcome = { shell: boolean; window: boolean };

type FocusKind = "sidebar" | "window";

const noopActions: LayerActions = {
  requestRender: () => {},
  disconnect: () => {},
  startTextSettingEdit: () => {},
  endTextSettingEdit: () => {},
  startVoiceCapture: () => {},
  stopVoiceCapture: () => {},
  startContinuousVoiceCapture: () => {},
  stopContinuousVoiceCapture: () => {},
  playBuzzerSequence: () => {},
};

/** Long-press overlay menu; closing it returns focus to the sidebar. */
class ShellOverlayMenuLayer extends MenuLayer {
  constructor(items: MenuItem[], private readonly onClosed: () => void) {
    super(null, items, {
      x: SIDEBAR_WIDTH + 8,
      y: TOP_BAR_HEIGHT + 8,
      width: 272,
      minHeight: 0,
    });
  }

  onRemoved(): void {
    this.onClosed();
  }
}

class Shell {
  private windows: ShellWindow[] = [];
  private selectedIndex = 0;
  private focus: FocusKind = "sidebar";
  private screenOn = true;
  private lastInputAtMs = Date.now();
  private battery: ShellChromeState["battery"] = { headset: null, headsetCharging: null };
  private attention = new Map<string, boolean>();
  // App-provided top-bar tray icons, keyed by owner id; drawn between the
  // notification icons and the battery indicators.
  private readonly trayIcons = new Map<string, GrayImage>();
  private activeVoiceLayer: VoiceInputLayer | null = null;
  private readonly actions: LayerActions = { ...noopActions };
  private config: ShellConfig = {
    actions: noopActions,
    getScreenTimeoutMs: () => null,
    requestShellRender: () => {},
    onScreenStateChanged: () => {},
  };
  private readonly stack = new LayerStack(
    new ShellChromeLayer(() => this.chromeState()),
    this.actions,
  );

  // Top-bar settings we mirror into the chrome; a change to either repaints
  // the shell surface so the top bar reflects it immediately.
  private topBarSettingsSubscribed = false;
  private lastBatteryDisplayMode: string | null = null;
  private lastTimeFormat: string | null = null;

  configure(config: ShellConfig): void {
    this.config = config;
    this.stack.setActions(config.actions);
    this.subscribeToTopBarSettings();
  }

  private subscribeToTopBarSettings(): void {
    if (this.topBarSettingsSubscribed) return;
    this.topBarSettingsSubscribed = true;
    this.lastBatteryDisplayMode = batteryDisplayModeSetting.get();
    this.lastTimeFormat = timeFormatSetting.get();
    onAnySettingChanged(() => {
      const batteryMode = batteryDisplayModeSetting.get();
      const timeFormat = timeFormatSetting.get();
      if (batteryMode === this.lastBatteryDisplayMode && timeFormat === this.lastTimeFormat) {
        return;
      }
      this.lastBatteryDisplayMode = batteryMode;
      this.lastTimeFormat = timeFormat;
      this.config.requestShellRender();
    });
  }

  /** Add a window (or replace one with the same windowId, keeping its slot). */
  registerWindow(window: ShellWindow): void {
    const existing = this.windows.findIndex((w) => w.windowId === window.windowId);
    if (existing >= 0) {
      this.windows[existing] = window;
    } else {
      this.windows.push(window);
    }
  }

  removeWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    const wasSelected = index === this.selectedIndex;
    this.windows.splice(index, 1);
    this.attention.delete(windowId);
    if (this.selectedIndex > index) {
      this.selectedIndex--;
    } else if (this.selectedIndex >= this.windows.length) {
      this.selectedIndex = Math.max(0, this.windows.length - 1);
    }
    if (this.focus === "window" && (wasSelected || !this.windows.length)) {
      this.focus = "sidebar";
    }
    if (wasSelected) {
      // Hand the foreground to whatever is now selected.
      const next = this.windows[this.selectedIndex];
      next?.setForeground?.(true);
      next?.requestRender();
    }
    this.config.requestShellRender();
  }

  /** Close the foreground window via the shell (long-press menu action). */
  closeForegroundWindow(): void {
    const window = this.foregroundWindow();
    if (!window || !window.closeable) return;
    try {
      window.close?.();
    } catch (error) {
      console.warn(`window ${window.windowId} close failed`, error);
    }
    this.removeWindow(window.windowId);
  }

  getWindows(): readonly ShellWindow[] {
    return this.windows;
  }

  setWindowAttention(windowId: string, attention: boolean): void {
    if (Boolean(this.attention.get(windowId)) === attention) return;
    this.attention.set(windowId, attention);
    this.config.requestShellRender();
  }

  setBatteryLevels(levels: Partial<ShellChromeState["battery"]>): void {
    this.battery = { ...this.battery, ...levels };
  }

  /**
   * Set or clear an app's top-bar tray icon (a small grayscale image, drawn
   * between the notification icons and the battery indicators). Small and
   * infrequently updated by design; not a framebuffer.
   */
  setTrayIcon(ownerId: string, icon: GrayImage | null): void {
    if (icon) {
      this.trayIcons.set(ownerId, icon);
    } else if (!this.trayIcons.delete(ownerId)) {
      return;
    }
    this.config.requestShellRender();
  }

  isScreenOn(): boolean {
    return this.screenOn;
  }

  noteUserActivity(nowMs = Date.now()): void {
    this.lastInputAtMs = nowMs;
  }

  /** Turn the screen on (if off) and set focus. Returns whether it was off. */
  wake(focus: FocusKind, nowMs = Date.now()): boolean {
    this.lastInputAtMs = nowMs;
    this.focus = focus;
    if (this.screenOn) return false;
    this.screenOn = true;
    this.config.onScreenStateChanged(true);
    for (const window of this.windows) {
      window.setScreenOn?.(true);
    }
    // Refresh the foreground window; the compositor restored its retained
    // frame, but its content may be stale (e.g. a running stopwatch).
    this.foregroundWindow()?.requestRender();
    return true;
  }

  /** Turn the screen off, closing any shell overlays. Sidebar selection is kept. */
  sleep(): void {
    if (!this.screenOn) return;
    this.screenOn = false;
    this.stack.clearToBase();
    for (const window of this.windows) {
      window.setScreenOn?.(false);
    }
    this.config.onScreenStateChanged(false);
  }

  /** Foreground and focus a window by id (e.g. a wake path opening content in it). */
  focusWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    this.setSelectedIndex(index);
    this.focus = "window";
  }

  /** Idle timeout: sleep if the configured timeout elapsed. Returns whether it slept. */
  applyScreenTimeout(nowMs = Date.now()): boolean {
    const timeoutMs = this.config.getScreenTimeoutMs();
    if (timeoutMs === null || !this.screenOn) return false;
    if (nowMs - this.lastInputAtMs < timeoutMs) return false;
    this.sleep();
    return true;
  }

  /**
   * Show a new notification in a shell modal over the app viewport. If the
   * notification woke the screen, closing the modal goes back to sleep
   * (matching the old sleep-popup behavior).
   */
  openNotificationModal(notificationKey: string, wokeScreen: boolean): void {
    if (!this.screenOn) return;
    const modal: ShellModalLayer = new ShellModalLayer(
      new SingleNotificationLayer(notificationKey, {
        origin: "new-notification-modal",
        closeModal: () => this.closeNotificationModal(modal, wokeScreen),
      }),
      this.config.actions,
    );
    this.stack.push(modal);
    this.config.requestShellRender();
  }

  private closeNotificationModal(modal: ShellModalLayer, wokeScreen: boolean): void {
    this.stack.popIfTop((layer) => layer === modal);
    if (wokeScreen) {
      this.sleep();
    }
    this.config.requestShellRender();
  }

  /** Called by a window when the user backs out of its root (double-tap). */
  yieldFocusToSidebar(): void {
    if (this.focus === "sidebar") return;
    this.focus = "sidebar";
    // Repaint the window so its selection highlight dims to the unfocused
    // style this frame.
    this.foregroundWindow()?.requestRender();
    this.config.requestShellRender();
  }

  /** Paint the shell surface: transparent chrome, or all-transparent when asleep. */
  paintSurface(): GrayImage {
    if (!this.screenOn) {
      return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    }
    return this.stack.paint();
  }

  async receiveInput(event: DashboardInputEvent, frameId = 0): Promise<ShellInputOutcome> {
    this.lastInputAtMs = Date.now();

    if (!this.screenOn) {
      if (event.type === "double-click") {
        this.wake("sidebar");
        return { shell: true, window: false };
      }
      return { shell: false, window: false };
    }

    // Long-press is reserved by the shell: PTT from the sidebar, the overlay
    // menu from inside a window. Windows never see it.
    if (event.type === "long-press") {
      if (!this.activeVoiceLayer && this.stack.isAtBase()) {
        if (this.focus === "sidebar") {
          this.openVoiceDialog();
        } else {
          this.openOverlayMenu();
        }
      }
      return { shell: true, window: false };
    }
    if (event.type === "long-press-release") {
      this.activeVoiceLayer?.endCapture();
      return { shell: true, window: false };
    }

    if (!this.stack.isAtBase()) {
      await this.stack.handleInput(event);
      return { shell: true, window: false };
    }

    if (this.focus === "sidebar") {
      return this.handleSidebarInput(event);
    }

    const window = this.foregroundWindow();
    if (window) {
      // The window owns frameId from here (render or explicit finish).
      await window.handleInput(event, frameId);
      return { shell: false, window: true };
    }
    return { shell: false, window: false };
  }

  foregroundWindow(): ShellWindow | undefined {
    return this.windows[this.selectedIndex] ?? this.windows[0];
  }

  /** Whether a window is the current input target (foreground + focus in-window). */
  isWindowFocused(windowId: string): boolean {
    return this.screenOn && this.focus === "window" && this.foregroundWindow()?.windowId === windowId;
  }

  /**
   * Whether a window's content is on screen: it's the foreground window and the
   * screen is on. Focus-independent — the app viewport stays visible while the
   * sidebar is focused (the sidebar is just the left strip).
   */
  isWindowVisible(windowId: string): boolean {
    return this.screenOn && this.foregroundWindow()?.windowId === windowId;
  }

  private handleSidebarInput(event: DashboardInputEvent): ShellInputOutcome {
    switch (event.type) {
      case "double-click":
        this.sleep();
        return { shell: true, window: false };
      case "scroll-up":
        this.moveSelection(-1);
        return { shell: true, window: false };
      case "scroll-down":
        this.moveSelection(1);
        return { shell: true, window: false };
      case "click":
        if (this.windows.length) {
          this.focus = "window";
          // Repaint the window now so its selection highlight reflects focus
          // this frame, not one frame late.
          this.foregroundWindow()?.requestRender();
        }
        return { shell: true, window: false };
      default:
        return { shell: false, window: false };
    }
  }

  private moveSelection(delta: number): void {
    if (!this.windows.length) return;
    const count = this.windows.length;
    this.setSelectedIndex((this.selectedIndex + delta + count) % count);
  }

  /** Change selection; the selected window is the foreground window. */
  private setSelectedIndex(index: number): void {
    if (index === this.selectedIndex) return;
    const previous = this.windows[this.selectedIndex];
    this.selectedIndex = index;
    const next = this.windows[index];
    previous?.setForeground?.(false);
    next?.setForeground?.(true);
    next?.requestRender();
  }

  private openVoiceDialog(): void {
    const layer = new VoiceInputLayer(
      this.config.actions,
      () => {
        if (this.activeVoiceLayer === layer) {
          this.activeVoiceLayer = null;
        }
      },
      (text) => this.sendTextToForegroundWindow(text),
    );
    this.activeVoiceLayer = layer;
    this.stack.push(layer);
    layer.startCapture();
  }

  /** Deliver a text string to the foreground window (e.g. finalized voice input). */
  sendTextToForegroundWindow(text: string): void {
    this.foregroundWindow()?.receiveTextInput?.(text);
  }

  private openOverlayMenu(): void {
    const foreground = this.foregroundWindow();
    const items: MenuItem[] = [
      {
        label: "Voice input",
        onSelect: () => {
          this.openVoiceDialog();
        },
      },
    ];
    if (foreground?.closeable) {
      items.push({
        label: "Close window",
        onSelect: (ctx) => {
          // Pop the menu first (its onRemoved returns focus to the sidebar),
          // then close the window the menu was opened over.
          ctx.stack.pop();
          this.closeForegroundWindow();
        },
      });
    }
    this.stack.push(new ShellOverlayMenuLayer(items, () => this.yieldFocusToSidebar()));
  }

  private chromeState(): ShellChromeState {
    return {
      windows: this.windows.map((window) => ({
        windowId: window.windowId,
        title: window.title,
        attention: Boolean(this.attention.get(window.windowId)),
        drawIcon: window.drawIcon,
      })),
      selectedIndex: this.selectedIndex,
      focus: this.focus,
      battery: this.battery,
      trayIcons: Array.from(this.trayIcons.keys())
        .sort()
        .map((key) => this.trayIcons.get(key)!),
    };
  }
}

export const shell = new Shell();

export function rawInputEventToInputEvent(event: RawInputEvent): DashboardInputEvent {
  if (event.kind === "sys-event") {
    if (event.eventType === OsEventTypeList.CLICK_EVENT) {
      return {
        type: "click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return {
        type: "double-click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_EVENT) {
      // CFW-forwarded long-press (replaces the firmware's force-quit dialog).
      // The CFW gates this to the ring, so eventSource may be 0 (unknown);
      // eventSourceToString falls back to "ring".
      return { type: "long-press", source: eventSourceToString(event.eventSource) };
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_RELEASE_EVENT) {
      return { type: "long-press-release", source: eventSourceToString(event.eventSource) };
    }
  } else if (event.kind === "text-click") {
    if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    }
  }
  return {
    type: "unknown",
    kind: event.kind,
    eventSource: event.eventSource,
    eventType: event.eventType,
  };
}

function eventSourceToString(eventSource: number): "ring" | "left-arm" | "right-arm" {
  if (eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
    return "ring";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) {
    return "left-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    return "right-arm";
  }
  return "ring";
}

export function inputEventToString(event: DashboardInputEvent): string {
  switch (event.type) {
    case "click":
      return `Click from ${event.source}`;
    case "double-click":
      return `Double click from ${event.source}`;
    case "scroll-up":
      return `Scroll up`;
    case "scroll-down":
      return `Scroll down`;
    case "long-press":
      return `Long press from ${event.source}`;
    case "long-press-release":
      return `Long press release from ${event.source}`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}
