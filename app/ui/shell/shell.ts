import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { EvenAIStatus, EventSourceType, OsEventTypeList } from "../../g2/events";
import type { RawInputEvent } from "../../native/faceclaw-communicator";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, noopLayerActions } from "../layers";
import { MenuLayer, type MenuItem } from "../menu";
import { VoiceInputLayer, type VoiceSendTarget } from "../apps/voice-input";
import { AssistantLayer } from "../apps/assistant";
import { AssistantSession, type AssistantBackendConfig } from "../../assistant/session";
import { resolveAssistantModel } from "../../assistant/models";
import type { AssistantContext } from "../../assistant/types";
import { SingleNotificationLayer } from "../notifications";
import {
  anthropicApiKeySetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  onAnySettingChanged,
  openAiApiKeySetting,
  timeFormatSetting,
  wakeWordActionSetting,
} from "../dashboard-settings";
import { ShellChromeLayer, sidebarLeftColumnUsed, type ShellChromeState, type ShellChromeWindow } from "./chrome-layer";
import { ShellModalLayer } from "./modal-layer";
import { ToolDebugMenuLayer } from "./tool-debug-layer";
import { toolRegistry } from "../../assistant/tool-registry";
import {
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SIDEBAR_COLUMN_WIDTH,
  SIDEBAR_WIDTH,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

/**
 * The shell: owns the window registry, focus, screen on/off, and the shell
 * surface (sidebar + top bar + shell overlays such as the escape menu and
 * the voice dialog). Runs on the main thread; windows are hosted in-process
 * or in per-app worker threads.
 *
 * Input flow: every event enters via receiveInput. The shell consumes
 * everything while the sidebar or a shell overlay has focus and forwards the
 * rest to the focused window. Long-press goes to the foreground window (from
 * the sidebar it focuses the window first); by convention apps answer it with
 * a window menu that ends in Voice input / Close window. Holding the press
 * past the escape threshold opens the shell's own escape menu, so the shell
 * keeps working when a window's handler hangs.
 */

export type ShellWindow = {
  appId: string;
  windowId: string;
  title: string;
  /** Compositor surface this window renders to; configured at connect / launch. */
  surfaceId: string;
  /** Whether close menu entries (app menu default, shell escape menu) apply (the launcher is pinned). */
  closeable: boolean;
  /**
   * Window height: the standard 288px band ("min") or the full screen
   * ("max", terminal views). Decides the surface rect and where the shell
   * draws this window's top bar.
   */
  heightMode: WindowHeightMode;
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
  /** Window registered/removed or foreground changed (persists the open-app list). */
  onWindowsChanged?: () => void;
};

/** Which surfaces need re-rendering after an input event. */
export type ShellInputOutcome = { shell: boolean; window: boolean };

type FocusKind = "sidebar" | "window";

const noopActions: LayerActions = noopLayerActions;

/**
 * Hold a long-press this much past the long-press event (which the firmware
 * itself only fires after a shorter hold) and the shell opens its own escape
 * menu — the recovery path when an app ignores or mishandles the gesture.
 */
const LONG_PRESS_ESCAPE_MENU_MS = 4000;

/** Shell-surface overlay menu (the escape menu); closing it returns focus to the sidebar. */
class ShellOverlayMenuLayer extends MenuLayer {
  constructor(items: MenuItem[], private readonly onClosed: () => void) {
    // Aligned to the min-height window band (like the sidebar), wherever the
    // vertical position setting currently puts it.
    super(null, items, {
      x: SIDEBAR_WIDTH + 8,
      y: minWindowTop() + TOP_BAR_HEIGHT + 8,
      width: 272,
      minHeight: 0,
    });
  }

  onRemoved(): void {
    this.onClosed();
  }
}

/** How long a show_alert popup stays before auto-dismissing. */
const ALERT_DISMISS_MS = 6000;
const ALERT_X = 40;
const ALERT_W = G2_LENS_WIDTH - 80;
const ALERT_Y = 96;
const ALERT_H = 96;

/**
 * A brief text popup on the shell surface (the assistant's show_alert tool and
 * other short notices). Auto-dismisses after a few seconds; a click or
 * double-click dismisses it early.
 */
class ShellAlertLayer implements Layer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly text: string, private readonly onDismiss: () => void) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDismiss();
    }, ALERT_DISMISS_MS);
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    // Positioned within the min-height window band, like the other shell overlays.
    const alertY = minWindowTop() + ALERT_Y;
    image.fillRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 1, 10);
    image.drawRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 90, 10);
    image.drawText(font, ALERT_X + 16, alertY + 12, "Assistant", 200);
    image.drawTextWrapped({
      font,
      x: ALERT_X + 16,
      y: alertY + 34,
      width: ALERT_W - 32,
      text: this.text,
      value: 235,
    });
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") {
      this.clearTimer();
      this.onDismiss();
    }
  }

  onRemoved(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

class Shell {
  private windows: ShellWindow[] = [];
  private selectedIndex = 0;
  /** Window ids in most-recently-visible-first order; closing the visible window returns to the next entry. */
  private mruWindowIds: string[] = [];
  private focus: FocusKind = "sidebar";
  private screenOn = true;
  private lastInputAtMs = Date.now();
  private battery: ShellChromeState["battery"] = { headset: null, headsetCharging: null };
  private attention = new Map<string, boolean>();
  // App-provided top-bar tray icons, keyed by owner id; drawn between the
  // notification icons and the battery indicators.
  private readonly trayIcons = new Map<string, GrayImage>();
  private activeVoiceLayer: VoiceInputLayer | null = null;
  private assistantSession: AssistantSession | null = null;
  private assistantLayer: AssistantLayer | null = null;
  private escapeMenuTimer: ReturnType<typeof setTimeout> | null = null;
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
      if (existing === this.selectedIndex) this.noteWindowVisible(window.windowId);
    } else {
      this.windows.push(window);
      if (this.windows.length - 1 === this.selectedIndex) this.noteWindowVisible(window.windowId);
    }
    this.config.onWindowsChanged?.();
  }

  /** Move a window to the front of the most-recently-visible order. */
  private noteWindowVisible(windowId: string): void {
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    this.mruWindowIds.unshift(windowId);
  }

  /** Index of the most recently visible window still in the registry, or -1. */
  private mostRecentWindowIndex(): number {
    for (const id of this.mruWindowIds) {
      const index = this.windows.findIndex((w) => w.windowId === id);
      if (index >= 0) return index;
    }
    return -1;
  }

  removeWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    const wasSelected = index === this.selectedIndex;
    this.windows.splice(index, 1);
    this.attention.delete(windowId);
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    if (wasSelected) {
      // Return to the most recently visible remaining window.
      const mruIndex = this.mostRecentWindowIndex();
      this.selectedIndex =
        mruIndex >= 0 ? mruIndex : Math.min(index, Math.max(0, this.windows.length - 1));
    } else if (this.selectedIndex > index) {
      this.selectedIndex--;
    }
    if (this.focus === "window" && (wasSelected || !this.windows.length)) {
      this.focus = "sidebar";
    }
    if (wasSelected) {
      // Hand the foreground to whatever is now selected.
      const next = this.windows[this.selectedIndex];
      if (next) {
        this.noteWindowVisible(next.windowId);
        next.setForeground?.(true);
        next.requestRender();
      }
    }
    this.config.onWindowsChanged?.();
    this.config.requestShellRender();
  }

  /** Close a window by id, if it is closeable (menu actions route here). */
  closeWindow(windowId: string): void {
    const window = this.windows.find((w) => w.windowId === windowId);
    if (!window || !window.closeable) return;
    try {
      window.close?.();
    } catch (error) {
      console.warn(`window ${window.windowId} close failed`, error);
    }
    this.removeWindow(window.windowId);
  }

  /** Close the foreground window via the shell (escape menu action). */
  closeForegroundWindow(): void {
    const window = this.foregroundWindow();
    if (window) this.closeWindow(window.windowId);
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

  /** Current headset battery levels (for the assistant's get_state tool). */
  getBatteryLevels(): ShellChromeState["battery"] {
    return this.battery;
  }

  /**
   * The foreground app, or null when only the launcher is showing. The launcher
   * is a pinned window but counts as "no app" for the assistant's context.
   */
  getForegroundApp(): { appId: string; title: string } | null {
    const window = this.foregroundWindow();
    if (!window || window.appId === "launcher") return null;
    return { appId: window.appId, title: window.title };
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
    this.cancelEscapeMenuTimer();
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
    // An open voice dialog suspends the timeout: a long dictation or refine
    // has no button presses, but the screen must stay on for it. Sliding
    // lastInputAtMs forward also restarts the full timeout when it closes.
    // An in-flight assistant turn suspends it for the same reason (a tool loop
    // can run for a while with no input); once the turn ends and the
    // Follow-up/Done menu is showing, the normal idle timeout resumes.
    if (this.activeVoiceLayer || this.assistantSession?.isTurnActive()) {
      this.lastInputAtMs = nowMs;
      return false;
    }
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
    // The stock lifecycle has already interpreted the physical double tap as
    // "wake". Keep that directionality if delivery is delayed or duplicated.
    if (event.type === "display-wake") {
      this.lastInputAtMs = Date.now();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      return { shell: wokeScreen, window: false };
    }

    // The wakeword is handled before the screen-off short-circuit so its
    // configured action can work from a dark screen. With the CFW the stock
    // Even AI app never launches, so the firmware does not power the display
    // for us either -- actions that need it wake the screen themselves.
    if (event.type === "wakeword") {
      const action = wakeWordActionSetting.get();
      if (action === "off") {
        return { shell: false, window: false };
      }

      this.lastInputAtMs = Date.now();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      if (action === "voice-input" && !this.activeVoiceLayer) {
        if (this.assistantLayer) {
          // The assistant overlay is up; a wakeword continues that conversation.
          this.startAssistantFollowUp(true);
        } else {
          // Wakeword defaults the highlight to Send to Assistant.
          this.openVoiceDialog({ handsFree: true, defaultTarget: "assistant" });
        }
      }
      return { shell: wokeScreen || action === "voice-input", window: false };
    }

    this.lastInputAtMs = Date.now();

    // Anything but the long-press itself means the press ended (or the event
    // stream moved on), so the escape countdown stops.
    if (event.type !== "long-press") {
      this.cancelEscapeMenuTimer();
    }

    if (!this.screenOn) {
      if (event.type === "double-click") {
        this.wake("sidebar");
        return { shell: true, window: false };
      }
      return { shell: false, window: false };
    }

    // Long-press goes to the foreground window (from the sidebar it focuses
    // the window first); apps conventionally answer it with their window
    // menu. The escape timer runs regardless of what the app does with it:
    // holding the press long enough opens the shell's own menu.
    if (event.type === "long-press") {
      this.startEscapeMenuTimer();
      if (this.activeVoiceLayer || !this.stack.isAtBase()) {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      if (this.focus === "sidebar") {
        this.focus = "window";
      }
      // The window owns frameId from here (render or explicit finish).
      await window.handleInput(event, frameId);
      return { shell: true, window: true };
    }
    if (event.type === "long-press-release") {
      this.activeVoiceLayer?.endCapture();
      if (this.activeVoiceLayer || !this.stack.isAtBase() || this.focus !== "window") {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      await window.handleInput(event, frameId);
      return { shell: false, window: true };
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

  /**
   * Screen rect actually occupied by content, for cropping screenshots: the
   * foreground window's band (full screen for a max-height window, the
   * vertical-position-dependent 288px band otherwise), minus the sidebar's
   * left column when no icons have overflowed into it.
   */
  screenshotCropRect(): { x: number; y: number; width: number; height: number } {
    const heightMode = this.foregroundWindow()?.heightMode ?? "min";
    const x = sidebarLeftColumnUsed(this.windows.length) ? 0 : SIDEBAR_COLUMN_WIDTH;
    return {
      x,
      y: windowTop(heightMode),
      width: G2_LENS_WIDTH - x,
      height: heightMode === "max" ? G2_LENS_HEIGHT : MIN_WINDOW_HEIGHT,
    };
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
    if (next) this.noteWindowVisible(next.windowId);
    previous?.setForeground?.(false);
    next?.setForeground?.(true);
    next?.requestRender();
    this.config.onWindowsChanged?.();
  }

  private openVoiceDialog(options: {
    finishOnClick?: boolean;
    handsFree?: boolean;
    defaultTarget: "assistant" | "app";
  }): void {
    const targets = this.buildVoiceSendTargets();
    let defaultIndex = targets.findIndex((target) => target.id === options.defaultTarget);
    if (defaultIndex < 0) defaultIndex = 0;
    // Skip the menu only for a hands-free (wakeword) capture aimed at the
    // assistant, when the user has opted into it.
    const autoSend =
      Boolean(options.handsFree) &&
      options.defaultTarget === "assistant" &&
      targets[defaultIndex]?.id === "assistant" &&
      assistantSkipConfirmationSetting.get();

    const layer = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === layer) {
          this.activeVoiceLayer = null;
          // The idle countdown restarts in full once voice input ends.
          this.noteUserActivity();
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === layer);
      },
      sendTargets: targets,
      defaultTargetIndex: defaultIndex,
      finishOnClick: options.finishOnClick ?? false,
      handsFree: options.handsFree ?? false,
      autoSend,
    });
    this.activeVoiceLayer = layer;
    this.stack.push(layer);
    layer.startCapture();
  }

  /**
   * The send destinations offered by the voice dialog: the assistant (when an
   * API key is configured) and/or typing into the foreground window (when it
   * accepts text). Order fixes the menu row order.
   */
  private buildVoiceSendTargets(): VoiceSendTarget[] {
    const targets: VoiceSendTarget[] = [];
    if (this.isAssistantAvailable()) {
      targets.push({
        id: "assistant",
        label: "Send to Assistant",
        onSend: (text) => this.sendToAssistant(text),
      });
    }
    if (this.foregroundWindow()?.receiveTextInput) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    // Guarantee at least one destination so the dialog is never a dead end.
    if (targets.length === 0) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    return targets;
  }

  /** Deliver a text string to the foreground window (e.g. finalized voice input). */
  sendTextToForegroundWindow(text: string): void {
    this.foregroundWindow()?.receiveTextInput?.(text);
  }

  /**
   * Open the voice dialog aimed at the foreground window. Called when the
   * user picks Voice input from a window's menu (in-process directly, worker
   * apps via a start-voice-input message). The menu click already ended the
   * press, so the dialog finishes on click instead of long-press-release.
   */
  startVoiceInput(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    // The transcript is aimed at the window whose menu requested it; the menu
    // entry point defaults the highlight to Type Into App.
    this.focus = "window";
    this.openVoiceDialog({ finishOnClick: true, defaultTarget: "app" });
    this.config.requestShellRender();
  }

  private isAssistantAvailable(): boolean {
    return this.resolveAssistantConfiguration() !== null;
  }

  private ensureAssistantSession(): AssistantSession | null {
    const config = this.resolveAssistantConfiguration();
    if (!config) return null;
    if (
      !this.assistantSession ||
      this.assistantSession.isExpired() ||
      !this.assistantSession.matchesConfiguration(config)
    ) {
      this.assistantSession?.cancel();
      this.assistantSession = new AssistantSession(config);
    }
    return this.assistantSession;
  }

  private resolveAssistantConfiguration(): AssistantBackendConfig | null {
    if (assistantBackendSetting.get() === "external") {
      const host = assistantBridgeHostSetting.get().trim();
      const token = assistantBridgeTokenSetting.get();
      if (!host || !token) return null;
      const port = parseInt(assistantBridgePortSetting.get(), 10) || 8790;
      return { kind: "external", bridge: { host, port, token } };
    }
    const llm = resolveAssistantModel(assistantModelSetting.get(), {
      anthropic: anthropicApiKeySetting.get(),
      openai: openAiApiKeySetting.get(),
    });
    return llm ? { kind: "direct", llm } : null;
  }

  private buildAssistantContext(): AssistantContext {
    const foreground = this.getForegroundApp();
    return {
      foregroundApp: foreground?.appId ?? null,
      foregroundTitle: foreground?.title ?? null,
      screenOn: this.screenOn,
      localTime: formatAssistantTime(new Date()),
      headsetBattery: this.battery.headset,
    };
  }

  /**
   * Start (or continue) an assistant conversation from a finalized utterance.
   * Opens the assistant overlay if it isn't already up; a follow-up reuses the
   * existing session and overlay.
   */
  sendToAssistant(text: string): void {
    const session = this.ensureAssistantSession();
    if (!session) {
      this.showAlert(
        assistantBackendSetting.get() === "external"
          ? "Configure the agent bridge host and token in Settings."
          : "Set an API key for the selected assistant model in Settings.",
      );
      return;
    }
    if (!this.screenOn) this.wake("sidebar");
    let layer = this.assistantLayer;
    if (!layer) {
      const created = new AssistantLayer(this.config.actions, {
        onFollowUp: () => this.startAssistantFollowUp(),
        onCancel: () => this.assistantSession?.cancel(),
        onClose: () => this.closeAssistantLayer(),
        onRemoved: () => {
          // Removed by any path (Done, or the screen sleeping mid-conversation):
          // stop the turn and drop the reference so a later query starts clean.
          this.assistantSession?.cancel();
          if (this.assistantLayer === created) this.assistantLayer = null;
        },
      });
      layer = created;
      this.assistantLayer = created;
      this.stack.push(created);
    }
    this.runAssistantTurn(session, layer, text);
    this.config.requestShellRender();
  }

  private runAssistantTurn(session: AssistantSession, layer: AssistantLayer, text: string): void {
    layer.startTurn();
    session.sendUtterance(text, this.buildAssistantContext(), {
      onTextDelta: (delta, textSoFar) => layer.onTextDelta(delta, textSoFar),
      onToolActivity: (label) => layer.onToolActivity(label),
      onTurnDone: () => layer.onTurnDone(),
      onError: (message) => layer.onError(message),
    });
  }

  /**
   * Record another utterance in the current assistant conversation. handsFree
   * (from a wakeword over the overlay) starts the mic immediately; otherwise
   * (the Follow-up menu button) a click ends the utterance.
   */
  private startAssistantFollowUp(handsFree = false): void {
    const layer = this.assistantLayer;
    const session = this.assistantSession;
    if (!layer || !session || this.activeVoiceLayer) return;
    const voice = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === voice) {
          this.activeVoiceLayer = null;
          this.noteUserActivity();
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === voice);
      },
      sendTargets: [
        { id: "assistant", label: "Send", onSend: (text) => this.runAssistantTurn(session, layer, text) },
      ],
      finishOnClick: !handsFree,
      handsFree,
      autoSend: handsFree && assistantSkipConfirmationSetting.get(),
    });
    this.activeVoiceLayer = voice;
    this.stack.push(voice);
    voice.startCapture();
    this.config.requestShellRender();
  }

  private closeAssistantLayer(): void {
    // Popping fires the layer's onRemoved, which cancels the turn and clears
    // this.assistantLayer.
    const layer = this.assistantLayer;
    if (layer) this.stack.popIfTop((top) => top === layer);
    this.noteUserActivity();
    this.config.requestShellRender();
  }

  /** Show a brief text popup on the lenses (assistant show_alert / notices). */
  showAlert(text: string): void {
    if (!this.screenOn) this.wake("sidebar");
    const layer = new ShellAlertLayer(text, () => {
      this.stack.popIfTop((top) => top === layer);
      this.config.requestShellRender();
    });
    this.stack.push(layer);
    this.config.requestShellRender();
  }

  private startEscapeMenuTimer(): void {
    this.cancelEscapeMenuTimer();
    this.escapeMenuTimer = setTimeout(() => {
      this.escapeMenuTimer = null;
      this.openEscapeMenu();
    }, LONG_PRESS_ESCAPE_MENU_MS);
  }

  private cancelEscapeMenuTimer(): void {
    if (this.escapeMenuTimer !== null) {
      clearTimeout(this.escapeMenuTimer);
      this.escapeMenuTimer = null;
    }
  }

  /**
   * The held-long-press safeguard menu. Shell-owned and shell-drawn (never
   * the app's), so an unresponsive app can always be closed. It opens over
   * whatever the app did with the long-press, including its own menu.
   */
  private openEscapeMenu(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    const foreground = this.foregroundWindow();
    if (!foreground) return;
    const items: MenuItem[] = [];
    if (foreground.closeable) {
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
    items.push({
      label: "Debug",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.openToolDebugDialog();
      },
    });
    this.stack.push(new ShellOverlayMenuLayer(items, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
  }

  /**
   * Escape menu > Debug: list the assistant tools registered for the
   * foreground window's app (live or gated). System-wide "always" tools are
   * constant and omitted.
   */
  private openToolDebugDialog(): void {
    const foreground = this.foregroundWindow();
    const appId = foreground?.appId ?? null;
    const entries = appId
      ? toolRegistry
          .listToolsForDebug()
          .filter(
            (entry) =>
              entry.spec.name.startsWith(`app.${appId}.`) || entry.windowId === foreground!.windowId,
          )
      : [];
    this.stack.push(new ToolDebugMenuLayer(appId, entries, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
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
      foregroundHeightMode: this.foregroundWindow()?.heightMode ?? "min",
      battery: this.battery,
      trayIcons: Array.from(this.trayIcons.keys())
        .sort()
        .map((key) => this.trayIcons.get(key)!),
    };
  }
}

export const shell = new Shell();

const ASSISTANT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ASSISTANT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable local time for the assistant's per-turn context. */
function formatAssistantTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const day = `${ASSISTANT_WEEKDAYS[date.getDay()]} ${ASSISTANT_MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${day}, ${hours}:${minutes} ${meridiem}`;
}

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
  } else if (event.kind === "even-ai") {
    // sid 0x07 EvenAIDataPackage; eventType carries eEvenAIStatus. Only the
    // wakeword interests us -- ENTER means the user manually opened the stock
    // assistant, and EXIT is it tearing down.
    if (event.eventType === EvenAIStatus.EVEN_AI_WAKE_UP) {
      return { type: "wakeword" };
    }
  } else if (event.kind === "display-wake") {
    // Outside an EvenHub page the firmware consumes the physical double tap
    // itself and reports only that the stock display lifecycle woke.
    return { type: "display-wake" };
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
    case "display-wake":
      return `Display wake`;
    case "wakeword":
      return `Wakeword`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}
