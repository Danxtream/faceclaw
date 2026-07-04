import { ImageSource } from "@nativescript/core";
import { EventSourceType, EventSourceTypeName, OsEventTypeList, OsEventTypeName } from "./events";
import { loadDeviceAddresses } from "./device-addresses";
import { ensureBlePermissions, ensureVoicePermissions } from "./android-permissions";
import { FaceclawCommunicatorBridge, type FrameMetrics, type RawInputEvent } from "../native/faceclaw-communicator";
import * as frameTimings from "../native/frame-timings";
import { startForegroundNotification, stopForegroundNotification, updateForegroundNotification } from "../native/foreground-service";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { onAndroidNotificationPosted } from "../native/notification-icons";
import { openEvenAppSettings, readEvenAppNotificationState } from "../native/even-app-conflict";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import { firmwareIncompatibilityMessage } from "./firmware-compat";
import { beginRenderPass, endRenderPass } from "../util/render-freshness";
import { voiceControlBridge } from "../native/voice-control";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import {
  applyDashboardScreenTimeout,
  dashboardState,
  drawDashboard,
  noteDashboardPhoneTextInput,
  openAndroidNotificationFromSleep,
  openTelepromptDocument,
  receiveInput,
  resetDashboardSleepTimerAndWake,
  setDashboardBatteryLevels,
  setDashboardActions,
} from "../ui/dashboard";
import {
  nightscoutApiTokenSetting,
  nightscoutSiteUrlSetting,
  systemCardNameSetting,
  voiceControlEnabledSetting,
  type ConfigSettingString,
} from "../ui/dashboard-settings";

type ConnectionPhase = "disconnected" | "connecting" | "connected" | "disconnecting";

export type DashboardSnapshot = {
  phase: ConnectionPhase;
  status: string;
  log: string;
  displayPreview: ImageSource | null;
  activeTextSettingId: string | null;
  activeTextSettingTitle: string;
  activeTextSettingValue: string;
  evenAppConflictMessage: string;
  evenAppConflictWarningVisible: boolean;
  firmwareWarningMessage: string;
  firmwareWarningVisible: boolean;
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;
type LogLevel = "debug"|"info"|"warn"|"error";

const CONTAINER_NAME = "dashboard";
const DASHBOARD_INTERVAL_MS = 60_000;
const SCREEN_TIMEOUT_CHECK_MS = 1_000;
const STOPWATCH_RENDER_INTERVAL_MS = 100;
const TRANSCRIBE_RENDER_INTERVAL_MS = 250;
const FOREGROUND_NOTIFICATION_MIN_UPDATE_MS = 30_000;
const FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS = 6_000;
const CONNECTED_PREVIEW_MIN_UPDATE_MS = 1_000;
const EVEN_APP_DETECTED_MESSAGE =
  "The Even Realities app appears to be running. If Faceclaw has trouble connecting, open its app settings and force stop it.";

function createInitialDisplayPreview(): ImageSource | null {
  return grayImageToPreviewSource(new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0));
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 23);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime24h(date: Date, includeSeconds: boolean): string {
  const hours = date.getHours();
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return includeSeconds
    ? `${hours}:${minutes}:${seconds}`
    : `${hours}:${minutes}`;
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function formatForStatus(date: Date): string {
  return formatTime24h(date, true);
}

function eventName(eventType: number): string {
  return OsEventTypeName[eventType] ?? `UNKNOWN_${eventType}`;
}

function sourceName(eventSource: number): string {
  return EventSourceTypeName[eventSource] ?? `SOURCE_${eventSource}`;
}

function normalizeContainerName(name: string): string {
  return name.replace(/[^\x20-\x7e]+/g, "");
}

function isDashboardContainerName(name: string): boolean {
  const normalized = normalizeContainerName(name);
  return normalized === CONTAINER_NAME || normalized.includes(CONTAINER_NAME);
}

class DashboardController {
  private phase: ConnectionPhase = "disconnected";
  private status = "Disconnected.";
  private log = "";
  private activeTextSetting: ConfigSettingString | null = null;
  private evenNotificationActive = false;
  private evenAppConflictMessage = "";
  private firmwareWarningMessage = "";
  private displayPreview: ImageSource | null = createInitialDisplayPreview();
  private readonly listeners = new Set<DashboardListener>();

  private communicator: FaceclawCommunicatorBridge | null = null;
  private dashboardTimer: ReturnType<typeof setInterval> | null = null;
  private screenTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private stopwatchRenderTimer: ReturnType<typeof setInterval> | null = null;
  private transcribeRenderTimer: ReturnType<typeof setInterval> | null = null;
  private offState: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  private offRing: (() => void) | null = null;
  private offBattery: (() => void) | null = null;
  private offEvenAppConflict: (() => void) | null = null;
  private offFrameMetrics: (() => void) | null = null;
  private offFirmwareInfo: (() => void) | null = null;
  private offMedia: (() => void) | null = null;
  private offNightscout: (() => void) | null = null;
  private offVoiceStatus: (() => void) | null = null;
  private offVoiceWakeWord: (() => void) | null = null;
  private offAndroidNotification: (() => void) | null = null;
  private lastInput = "waiting...";
  private lastSys = "none yet";
  private renderInProgress = false;
  private renderQueued = false;
  private queuedRenderReason: "initial" | "interval" = "interval";
  private queuedFrameId = 0;
  private lastForegroundNotificationUpdateAtMs = 0;
  private lastConnectedPreviewUpdateAtMs = 0;
  // Consumed by the next renderDashboard: repaint with data sources not
  // allowed to serve stale caches (set after a frame painted with stale data).
  private nextRenderWantsFreshData = false;

  constructor() {
    setDashboardActions({
      disconnect: () => this.disconnect(),
      startTextSettingEdit: (setting) => this.startTextSettingEdit(setting),
      endTextSettingEdit: () => this.endTextSettingEdit(),
      setVoiceControlEnabled: (enabled) => this.setVoiceControlEnabled(enabled),
      setStopwatchRenderActive: (active) => this.setStopwatchRenderActive(active),
      setTranscribeRenderActive: (active) => this.setTranscribeRenderActive(active),
      startDedicatedVoiceInput: (mode) => this.startDedicatedVoiceInput(mode),
      stopDedicatedVoiceInput: () => this.stopDedicatedVoiceInput(),
      playBuzzerNote: (note, oct, beat) => this.playBuzzerNote(note, oct, beat),
    });
    this.offAndroidNotification = onAndroidNotificationPosted((notificationKey) => {
      void this.handleAndroidNotificationPosted(notificationKey).catch((error) => {
        this.appendLog(`notification wake failed: ${this.formatError(error)}`);
      });
    });
  }

  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DashboardSnapshot {
    return {
      phase: this.phase,
      status: this.status,
      log: this.log,
      displayPreview: this.displayPreview,
      activeTextSettingId: this.activeTextSetting?.id ?? null,
      activeTextSettingTitle: this.activeTextSetting?.editorTitle ?? "",
      activeTextSettingValue: this.activeTextSetting?.get() ?? "",
      evenAppConflictMessage: this.evenAppConflictMessage,
      evenAppConflictWarningVisible: this.evenAppConflictMessage.length > 0,
      firmwareWarningMessage: this.firmwareWarningMessage,
      firmwareWarningVisible: this.firmwareWarningMessage.length > 0,
    };
  }

  refreshEvenAppStatus(): void {
    const state = readEvenAppNotificationState();
    const wasActive = this.evenNotificationActive;
    this.evenNotificationActive = state.evenNotificationActive;
    if (state.evenNotificationActive && !wasActive) {
      this.appendLog("Even app notification is active.");
    }
    if (state.evenNotificationActive && !this.evenAppConflictMessage) {
      this.evenAppConflictMessage = EVEN_APP_DETECTED_MESSAGE;
      this.emit();
    }
    if (!state.evenNotificationActive && this.evenAppConflictMessage) {
      this.evenAppConflictMessage = "";
      this.emit();
    }
  }

  openEvenAppSettings(): void {
    openEvenAppSettings();
  }

  setSystemCardName(name: string): void {
    this.updateTextSetting(systemCardNameSetting, name);
  }

  setActiveTextSettingValue(value: string): void {
    noteDashboardPhoneTextInput();
    if (!this.activeTextSetting) return;
    this.updateTextSetting(this.activeTextSetting, value);
  }

  async connect(): Promise<void> {
    if (this.phase !== "disconnected") return;

    const addresses = loadDeviceAddresses();
    if (!addresses.right || !addresses.left) {
      const message = "Configure both left and right arm MAC addresses before connecting.";
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw new Error(message);
    }
    this.log = "";
    this.lastInput = "waiting...";
    this.lastSys = "none yet";
    this.firmwareWarningMessage = "";
    resetDashboardSleepTimerAndWake();
    this.refreshEvenAppStatus();
    this.setPhase("connecting");
    this.setStatus("Connecting to the glasses...");
    this.appendLog(
      `Using configured arms: R=${addresses.right} L=${addresses.left}${addresses.ring ? ` ring=${addresses.ring}` : ""}`,
    );

    let communicator: FaceclawCommunicatorBridge | null = null;

    try {
      await ensureBlePermissions();
      startForegroundNotification("Connecting to the glasses");
      communicator = new FaceclawCommunicatorBridge({
        right: addresses.right,
        left: addresses.left,
        ring: addresses.ring,
      });
      this.communicator = communicator;
      this.offLog = communicator.onLog((line) => {
        this.appendLog(line);
      });
      this.offState = communicator.onStateChange((state) => {
        const mappedPhase =
          state.phase === "connected"
            ? "connected"
            : state.phase === "disconnecting"
              ? "disconnecting"
              : state.phase === "disconnected"
                ? "disconnected"
                : "connecting";
        this.setPhase(mappedPhase);
        this.setStatus(state.status);
      });
      this.offRing = communicator.onRingEvent((event) => {
        void this.handleInputEvent(event).catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`input handler failed: ${message}`);
        });
      });
      this.offBattery = communicator.onBatteryState((state) => {
        setDashboardBatteryLevels({
          headset: state.battery,
          headsetCharging: state.chargingStatus > 0,
        });
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`battery update failed: ${message}`);
          });
        }
      });
      this.offEvenAppConflict = communicator.onEvenAppConflict((message) => {
        this.refreshEvenAppStatus();
        if (!this.evenNotificationActive) {
          this.appendLog(`Even app conflict suspected, but notification was not active: ${message}`);
          return;
        }
        this.evenAppConflictMessage = message;
        this.appendLog(message);
        this.emit();
      });
      this.offFrameMetrics = communicator.onFrameMetrics((metrics) => {
        if (this.phase === "connected") {
          this.setStatus(`Connected. Last frame: ${this.formatFrameMetrics(metrics)}.`);
        }
      });
      this.offFirmwareInfo = communicator.onFirmwareInfo((info) => {
        this.appendLog(
          `firmware: L=${info.leftVersion || "?"} R=${info.rightVersion || "?"}` +
            (info.capabilities ? ` caps="${info.capabilities}"` : " (no CFW capability string)"),
        );
        const warning = firmwareIncompatibilityMessage(info) ?? "";
        if (warning !== this.firmwareWarningMessage) {
          this.firmwareWarningMessage = warning;
          if (warning) {
            this.appendLog(`firmware compatibility warning: ${warning}`);
          }
          this.emit();
        }
      });
      this.offMedia = mediaControllerBridge.onStateChange(() => {
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`media update failed: ${message}`);
          });
        }
      });
      this.offNightscout = nightscoutBridge.onStateChange(() => {
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`nightscout update failed: ${message}`);
          });
        }
      });
      this.offVoiceStatus = voiceControlBridge.onStatus((state) => {
        this.appendLog(state.status);
      });
      this.offVoiceWakeWord = voiceControlBridge.onWakeWord((keyword) => {
        void this.handleWakeWord(keyword).catch((error) => {
          this.appendLog(`wake-word handler failed: ${this.formatError(error)}`);
        });
      });

      await mediaControllerBridge.start();
      await nightscoutBridge.start();
      await communicator.start();
      await this.requestRender("initial");
      this.startVoiceControlIfEnabled();
      this.dashboardTimer = setInterval(() => {
        void this.requestRender("interval").catch((error) => {
          const message = this.formatError(error);
          this.setStatus(`Dashboard update failed: ${message}`);
          this.appendLog(`dashboard update failed: ${message}`);
        });
      }, DASHBOARD_INTERVAL_MS);
      this.screenTimeoutTimer = setInterval(() => {
        if (this.phase !== "connected" || !this.communicator) return;
        if (!applyDashboardScreenTimeout()) return;
        this.setStopwatchRenderActive(false);
        this.endTextSettingEdit();
        void this.requestRender("interval").catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`screen timeout render failed: ${message}`);
        });
      }, SCREEN_TIMEOUT_CHECK_MS);
    } catch (error) {
      const message = this.formatError(error);
      this.offState?.();
      this.offState = null;
      this.offLog?.();
      this.offLog = null;
      this.offRing?.();
      this.offRing = null;
      this.offBattery?.();
      this.offBattery = null;
      this.offEvenAppConflict?.();
      this.offEvenAppConflict = null;
      this.offFrameMetrics?.();
      this.offFrameMetrics = null;
      this.offFirmwareInfo?.();
      this.offFirmwareInfo = null;
      this.offMedia?.();
      this.offMedia = null;
      this.offNightscout?.();
      this.offNightscout = null;
      this.offVoiceStatus?.();
      this.offVoiceStatus = null;
      this.offVoiceWakeWord?.();
      this.offVoiceWakeWord = null;
      if (this.transcribeRenderTimer) {
        clearInterval(this.transcribeRenderTimer);
        this.transcribeRenderTimer = null;
      }
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.stop();
      if (communicator) {
        await communicator.close().catch(() => {});
      }
      this.communicator = null;
      this.clearDashboardTimer();
      stopForegroundNotification();
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.phase === "disconnected" || this.phase === "disconnecting") return;

    this.setPhase("disconnecting");
    this.setStatus("Disconnecting...");
    this.clearDashboardTimer();
    this.offState?.();
    this.offState = null;
    this.offLog?.();
    this.offLog = null;
    this.offRing?.();
    this.offRing = null;
    this.offBattery?.();
    this.offBattery = null;
    this.offEvenAppConflict?.();
    this.offEvenAppConflict = null;
    this.offFrameMetrics?.();
    this.offFrameMetrics = null;
    this.offFirmwareInfo?.();
    this.offFirmwareInfo = null;
    this.offMedia?.();
    this.offMedia = null;
    this.offNightscout?.();
    this.offNightscout = null;
    this.offVoiceStatus?.();
    this.offVoiceStatus = null;
    this.offVoiceWakeWord?.();
    this.offVoiceWakeWord = null;

    const communicator = this.communicator;
    this.communicator = null;

    try {
      const shutdownAcked = await communicator?.sendShutdown(0).catch((error) => {
        this.appendLog(`shutdown command failed: ${this.formatError(error)}`);
        return false;
      });
      if (shutdownAcked === true) {
        this.appendLog("Shutdown command completed.");
      } else if (communicator) {
        this.appendLog("Shutdown command did not complete before disconnect.");
      }
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.stop();
      if (this.transcribeRenderTimer) {
        clearInterval(this.transcribeRenderTimer);
        this.transcribeRenderTimer = null;
      }
      await communicator?.close().catch(() => {});
    } finally {
      stopForegroundNotification();
      this.setPhase("disconnected");
      this.setStatus("Disconnected.");
      this.appendLog("Disconnected from the glasses.");
    }
  }

  async injectSyntheticRingInput(kind: "click" | "double-click" | "scroll-up" | "scroll-down"): Promise<void> {
    const event = this.buildSyntheticRingInput(kind);
    await this.handleInputEvent(event);
  }

  async openTelepromptDocument(text: string): Promise<void> {
    openTelepromptDocument(text);
    this.appendLog(`teleprompt document received (${text.length} chars)`);
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("interval");
      return;
    }
    const image = drawDashboard();
    this.updateDisplayPreviewFromImage(image);
  }

  private startTextSettingEdit(setting: ConfigSettingString): void {
    this.activeTextSetting = setting;
    this.emit();
  }

  private async setVoiceControlEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      try {
        // Treat Android mic permission as the consent gate for voice control,
        // even when the current source is the G2 mic over BLE.
        await ensureVoicePermissions();
      } catch (error) {
        this.appendLog(`voice control permission failed: ${this.formatError(error)}`);
        return;
      }
    }

    voiceControlEnabledSetting.set(enabled);
    this.appendLog(`Voice control ${enabled ? "enabled" : "disabled"}.`);
    if (enabled) {
      this.startVoiceControlIfEnabled();
    } else {
      voiceControlBridge.stop();
    }
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("interval").catch((error) => {
        this.appendLog(`voice setting render failed: ${this.formatError(error)}`);
      });
    }
  }

  private endTextSettingEdit(): void {
    const finishedSetting = this.activeTextSetting;
    this.activeTextSetting = null;
    this.emit();
    if (finishedSetting === nightscoutSiteUrlSetting || finishedSetting === nightscoutApiTokenSetting) {
      void this.refreshNightscoutAfterSettingsChange();
    }
  }

  private updateTextSetting(setting: ConfigSettingString, value: string): void {
    if (setting.get() !== value) {
      setting.set(value);
      this.emit();
      this.previewOrRenderAfterTextSettingChange(setting.label);
    }
  }

  private async refreshNightscoutAfterSettingsChange(): Promise<void> {
    await nightscoutBridge.refreshNow().catch((error) => {
      this.appendLog(`nightscout settings refresh failed: ${this.formatError(error)}`);
    });
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("interval").catch((error) => {
        this.appendLog(`nightscout settings render failed: ${this.formatError(error)}`);
      });
    } else {
      const image = drawDashboard();
      this.updateDisplayPreviewFromImage(image);
    }
  }

  private previewOrRenderAfterTextSettingChange(label: string): void {
    if (this.phase === "connected" && this.communicator) {
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`${label} update failed: ${this.formatError(error)}`);
      });
      return;
    }
    const image = drawDashboard();
    this.updateDisplayPreviewFromImage(image);
  }

  /**
   * Serialize renders; frameId identifies the input event or timer tick that
   * asked for this render (one is started here for callers that don't have
   * one). Ownership of the frame passes to renderDashboard and then to the
   * Java side; requests that coalesce into an already-queued render finish
   * immediately as discarded. When coalescing we keep the oldest waiting frame
   * so measured latency reflects the worst-served request.
   */
  private async requestRender(reason: "initial" | "interval", frameId?: number): Promise<void> {
    const newFrameId = frameId ?? frameTimings.startFrame(`render:${reason}`);
    this.queuedRenderReason = this.queuedRenderReason === "initial" ? "initial" : reason;
    if (this.renderInProgress) {
      if (this.renderQueued && this.queuedFrameId > 0) {
        frameTimings.finishFrame(newFrameId, `discarded: coalesced into frame#${this.queuedFrameId}`);
      } else {
        this.renderQueued = true;
        this.queuedFrameId = newFrameId;
        frameTimings.logFrame(newFrameId, "render queued behind in-progress render");
      }
      return;
    }

    this.renderInProgress = true;
    let frameToRender = newFrameId;
    try {
      while (true) {
        const nextReason = this.queuedRenderReason;
        this.renderQueued = false;
        this.queuedRenderReason = "interval";
        try {
          await this.renderDashboard(nextReason, frameToRender);
        } catch (error) {
          frameTimings.finishFrame(frameToRender, `discarded: render failed: ${this.formatError(error)}`);
          throw error;
        }
        if (!this.renderQueued || this.queuedFrameId <= 0) break;
        frameToRender = this.queuedFrameId;
        this.queuedFrameId = 0;
      }
    } finally {
      this.renderInProgress = false;
    }
  }

  private async renderDashboard(reason: "initial" | "interval", frameId: number): Promise<void> {
    console.log("renderDashboard", reason);
    frameTimings.logFrame(frameId, `renderDashboard start (${reason})`);
    const wantFreshData = this.nextRenderWantsFreshData;
    this.nextRenderWantsFreshData = false;
    beginRenderPass(!wantFreshData);
    const paintStartedAtMs = Date.now();
    const image = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => drawDashboard()),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const paintUsedStaleData = endRenderPass();
    if (paintUsedStaleData) {
      frameTimings.logFrame(frameId, "painted with stale data; will schedule a fresh-data repaint");
    }
    const fingerprint = frameTimings.span(frameId, "fingerprint", () => image.fingerprint());
    const updatePreviewAfterTransmit = this.phase === "connected";
    if (!updatePreviewAfterTransmit) {
      this.updateDisplayPreviewFromImage(image);
    }
    if (this.communicator) {
      if (dashboardState.screenOn) {
        await this.communicator.setG2ScreenOn(true);
      }
      console.log("submitDashboardImage");
      const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
      // The Java side owns the frame from here: it finishes it on last-packet
      // ack, dedup, supersede, or timeout.
      await this.communicator.submitDashboardImage(buffer, image.width, image.height, fingerprint, paintMs, frameId);
      const outcome = await this.communicator.waitForFrameFinished(frameId, FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS);
      if (outcome === null) {
        frameTimings.logFrame(frameId, "transmit backpressure wait timed out; render loop continuing");
      }
      if (!dashboardState.screenOn) {
        await this.communicator.setG2ScreenOn(false);
      }
      if (updatePreviewAfterTransmit) {
        this.updateConnectedDisplayPreviewFromImage(image);
      }
    } else {
      frameTimings.finishFrame(frameId, "discarded: no communicator, preview only");
    }

    if (paintUsedStaleData) {
      this.nextRenderWantsFreshData = true;
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`fresh-data repaint failed: ${this.formatError(error)}`);
      });
    }

    this.updateConnectedForegroundNotification();
    if (reason === "initial") {
      this.appendLog("initial dashboard image queued");
    }
    console.log("renderDashbaord finished");
  }

  private async handleInputEvent(event: RawInputEvent): Promise<void> {
    const frameId =
      event.frameId > 0 ? event.frameId : frameTimings.startFrame(`input:${event.kind} (untracked source)`);
    frameTimings.logFrame(frameId, `TS input handler start: ${event.kind} ${eventName(event.eventType)}`);
    let renderRequested = false;
    try {
      frameTimings.spanStart(frameId, "handle-input");
      try {
        await receiveInput(event);
      } finally {
        frameTimings.spanEnd(frameId, "handle-input");
      }

      if (event.kind === "sys-event") {
        this.lastSys = `${sourceName(event.eventSource)}/${eventName(event.eventType)}`;
        this.appendLog(`sys-event ${this.lastSys}`);

        if (
          event.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
          event.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
          event.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT
        ) {
          this.appendLog("display state invalidated by firmware exit event");
        }

        if (event.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
          this.lastInput = eventName(event.eventType);
        }
        renderRequested = true;
        await this.requestRender("interval", frameId);
        return;
      }

      if (event.kind === "text-click" && isDashboardContainerName(event.containerName)) {
        if (
          event.eventType === OsEventTypeList.SCROLL_TOP_EVENT ||
          event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT
        ) {
          this.lastSys = `TEXT/${eventName(event.eventType)}`;
          this.lastInput = `TEXT_${eventName(event.eventType)}`;
          this.appendLog(`text-event ${this.lastSys}`);
          renderRequested = true;
          await this.requestRender("interval", frameId);
        }
      }
    } finally {
      if (!renderRequested) {
        frameTimings.finishFrame(frameId, "discarded: input did not trigger a render");
      }
    }
  }

  private async handleWakeWord(keyword: string): Promise<void> {
    const normalized = keyword.trim();
    if (normalized.length === 0) return;
    this.appendLog(`wake-word detected: ${normalized}`);
    const changed = resetDashboardSleepTimerAndWake();
    if (this.phase === "connected" && this.communicator) {
      if (changed) {
        await this.requestRender("initial");
      }
      return;
    }
    if (changed) {
      const image = drawDashboard();
      this.updateDisplayPreviewFromImage(image);
    }
  }

  private async handleAndroidNotificationPosted(notificationKey: string): Promise<void> {
    const changed = openAndroidNotificationFromSleep(notificationKey);
    if (!changed) {
      if (this.phase === "connected" && this.communicator) {
        await this.requestRender("interval");
      }
      return;
    }

    this.appendLog("android notification woke dashboard");
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("initial");
      return;
    }
    const image = drawDashboard();
    this.updateDisplayPreviewFromImage(image);
  }

  private startVoiceControlIfEnabled(): void {
    if (!this.communicator) return;
    if (!voiceControlEnabledSetting.get()) return;
    this.updateConnectedForegroundNotification();
    voiceControlBridge.start(this.communicator.getNativeCommunicator(), "wakeword");
  }

  private async startDedicatedVoiceInput(mode: "wakeword" | "full"): Promise<void> {
    if (!this.communicator) {
      throw new Error("Voice input needs an active G2 connection.");
    }
    await ensureVoicePermissions();
    this.updateConnectedForegroundNotification();
    voiceControlBridge.start(this.communicator.getNativeCommunicator(), mode);
  }

  private stopDedicatedVoiceInput(): void {
    voiceControlBridge.stop();
    this.startVoiceControlIfEnabled();
  }

  private async playBuzzerNote(note: number, oct: number, beat: number): Promise<void> {
    if (this.phase !== "connected" || !this.communicator) {
      return;
    }
    await this.communicator.playBuzzerNote(note, oct, beat);
  }

  private setStopwatchRenderActive(active: boolean): void {
    if (!active || this.phase !== "connected" || !this.communicator) {
      if (this.stopwatchRenderTimer) {
        clearInterval(this.stopwatchRenderTimer);
        this.stopwatchRenderTimer = null;
      }
      return;
    }
    if (this.stopwatchRenderTimer) return;
    this.stopwatchRenderTimer = setInterval(() => {
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`stopwatch render failed: ${this.formatError(error)}`);
      });
    }, STOPWATCH_RENDER_INTERVAL_MS);
  }

  private setTranscribeRenderActive(active: boolean): void {
    if (!active || this.phase !== "connected" || !this.communicator) {
      if (this.transcribeRenderTimer) {
        clearInterval(this.transcribeRenderTimer);
        this.transcribeRenderTimer = null;
      }
      return;
    }
    if (this.transcribeRenderTimer) return;
    this.transcribeRenderTimer = setInterval(() => {
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`transcribe render failed: ${this.formatError(error)}`);
      });
    }, TRANSCRIBE_RENDER_INTERVAL_MS);
  }

  private clearDashboardTimer(): void {
    if (this.dashboardTimer) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = null;
    }
    if (this.screenTimeoutTimer) {
      clearInterval(this.screenTimeoutTimer);
      this.screenTimeoutTimer = null;
    }
    if (this.stopwatchRenderTimer) {
      clearInterval(this.stopwatchRenderTimer);
      this.stopwatchRenderTimer = null;
    }
    if (this.transcribeRenderTimer) {
      clearInterval(this.transcribeRenderTimer);
      this.transcribeRenderTimer = null;
    }
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private updateConnectedForegroundNotification(): void {
    if (this.phase !== "connected") return;
    const now = Date.now();
    if (now - this.lastForegroundNotificationUpdateAtMs < FOREGROUND_NOTIFICATION_MIN_UPDATE_MS) return;
    this.lastForegroundNotificationUpdateAtMs = now;
    updateForegroundNotification("Connected");
  }

  private formatFrameMetrics(metrics: FrameMetrics): string {
    return `paint=${Math.round(metrics.paintMs)}ms, transmit=${Math.round(metrics.transmitMs)}ms, tiles=${Math.round(metrics.tileCount)}`;
  }


  private appendLog(line: string): void {
    const stamped = `[${formatTimestamp(new Date())}] ${line}`;
    //this.log = this.log ? `${this.log}\n${stamped}` : stamped;
    console.log(stamped);
    //this.emit();
  }

  private setDisplayPreview(preview: ImageSource | null): void {
    if (this.displayPreview === preview) return;
    this.displayPreview = preview;
    this.emit();
  }

  private updateDisplayPreviewFromImage(image: GrayImage): void {
    this.setDisplayPreview(grayImageToPreviewSource(image));
  }

  private updateConnectedDisplayPreviewFromImage(image: GrayImage): void {
    if (!this.communicator) return;
    const now = Date.now();
    if (
      this.lastConnectedPreviewUpdateAtMs > 0 &&
      now - this.lastConnectedPreviewUpdateAtMs < CONNECTED_PREVIEW_MIN_UPDATE_MS
    ) {
      return;
    }
    this.lastConnectedPreviewUpdateAtMs = now;
    this.updateDisplayPreviewFromImage(image);
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
    if (sanitized.length <= 240) return sanitized;
    return `${sanitized.slice(0, 237)}...`;
  }

  private buildSyntheticRingInput(kind: "click" | "double-click" | "scroll-up" | "scroll-down"): RawInputEvent {
    const frameId = frameTimings.startFrame(`input:synthetic:${kind}`);
    switch (kind) {
      case "click":
        return {
          kind: "sys-event",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "double-click":
        return {
          kind: "sys-event",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-up":
        return {
          kind: "text-click",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.SCROLL_TOP_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-down":
      default:
        return {
          kind: "text-click",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export const dashboardController = new DashboardController();
