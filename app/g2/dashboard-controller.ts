import { ImageSource } from "@nativescript/core";
import { EvenAIStatusName, EventSourceType, EventSourceTypeName, OsEventTypeList, OsEventTypeName } from "./events";
import { loadDeviceAddresses } from "./device-addresses";
import { ensureBlePermissions, ensureVoicePermissions } from "./android-permissions";
import { FaceclawCommunicatorBridge, type FrameMetrics, type RawInputEvent } from "../native/faceclaw-communicator";
import * as frameTimings from "../native/frame-timings";
import { startForegroundNotification, stopForegroundNotification, updateForegroundNotification } from "../native/foreground-service";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { onAndroidNotificationPosted } from "../native/notification-icons";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../native/notification-access";
import { openEvenAppSettings, readEvenAppNotificationState } from "../native/even-app-conflict";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import { firmwareIncompatibilityMessage } from "./firmware-compat";
import { findSoundEffect, playSoundEffect } from "../ui/apps/sound-effects";
import { isWelcomeSoundPending, setWelcomeSoundPending } from "../phone-ui/onboarding-state";
import { beginRenderPass, endRenderPass } from "../util/render-freshness";
import { voiceControlBridge } from "../native/voice-control";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { rawInputEventToInputEvent, shell, type ShellInputOutcome } from "../ui/shell/shell";
import { WorkerAppHost } from "../ui/shell/worker-window";
import { createLauncherWindow, LAUNCHER_SURFACE_ID } from "../ui/shell/launcher-app";
import {
  createSettingsAppWindow,
  SETTINGS_SURFACE_ID,
  SETTINGS_WINDOW_ID,
  type SettingsAppWindow,
} from "../ui/shell/settings-app";
import {
  createNotificationsAppWindow,
  NOTIFICATIONS_SURFACE_ID,
  NOTIFICATIONS_WINDOW_ID,
} from "../ui/shell/notifications-app";
import {
  createCalendarAppWindow,
  CALENDAR_SURFACE_ID,
  CALENDAR_WINDOW_ID,
} from "../ui/shell/calendar-app";
import {
  createWeatherAppWindow,
  WEATHER_SURFACE_ID,
  WEATHER_WINDOW_ID,
} from "../ui/shell/weather-app";
import {
  createDebugTestsAppWindow,
  DEBUG_TESTS_SURFACE_ID,
  DEBUG_TESTS_WINDOW_ID,
} from "../ui/shell/debug-tests-app";
import {
  createTelepromptBrowserWindow,
  createTelepromptDocumentWindow,
  TELEPROMPT_SURFACE_ID,
  TELEPROMPT_WINDOW_ID,
} from "../ui/shell/teleprompt-app";
import {
  createNightscoutAppWindow,
  NIGHTSCOUT_SURFACE_ID,
  NIGHTSCOUT_WINDOW_ID,
} from "../ui/shell/nightscout-app";
import { createMusicAppWindow, MUSIC_SURFACE_ID, MUSIC_WINDOW_ID } from "../ui/shell/music-app";
import {
  createTranscribeAppWindow,
  TRANSCRIBE_SURFACE_ID,
  TRANSCRIBE_WINDOW_ID,
} from "../ui/shell/transcribe-app";
import { type InProcessAppOptions, type InProcessWindow } from "../ui/shell/in-process-window";
import { APP_VIEWPORT } from "../ui/shell/geometry";
import { type LayerActions } from "../ui/layers";
import {
  elevenLabsApiKeySetting,
  openAiApiKeySetting,
  nightscoutApiTokenSetting,
  firmwareDebugFlagsSetting,
  nightscoutSiteUrlSetting,
  onAnySettingChanged,
  rawScreenshotsEnabledSetting,
  saveVoiceRecordingsSetting,
  screenTimeoutSetting,
  screenTimeoutSettingToMs,
  systemCardNameSetting,
  voiceProviderSetting,
  type ConfigSettingString,
} from "../ui/dashboard-settings";
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from "../native/battery-optimization";

type ConnectionPhase = "disconnected" | "connecting" | "connected" | "charging" | "disconnecting";

export type DashboardSnapshot = {
  phase: ConnectionPhase;
  status: string;
  log: string;
  displayPreview: ImageSource | null;
  /**
   * When non-empty, the phone UI shows this instead of the display preview:
   * the preview would be a black rectangle indistinguishable from dead
   * glasses, and this says which harmless thing is actually going on.
   */
  displayPreviewMessage: string;
  activeTextSettingId: string | null;
  activeTextSettingTitle: string;
  activeTextSettingValue: string;
  evenAppConflictMessage: string;
  evenAppConflictWarningVisible: boolean;
  firmwareWarningMessage: string;
  firmwareWarningVisible: boolean;
  rawScreenshotsEnabled: boolean;
  batteryOptimizationWarningVisible: boolean;
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;

// The shell chrome (sidebar + top bar + overlays) composites above all app
// window surfaces with color-key transparency.
const SHELL_SURFACE_ID = "shell";
// Top-bar clock refresh; the phone-side preview polls the Java composite so
// it reflects every app (including worker apps the TS side never renders).
const SHELL_REFRESH_INTERVAL_MS = 60_000;
const PREVIEW_INTERVAL_MS = 1_000;
const SCREEN_TIMEOUT_CHECK_MS = 1_000;
const FOREGROUND_NOTIFICATION_MIN_UPDATE_MS = 30_000;
const FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS = 6_000;
const CONNECTED_PREVIEW_MIN_UPDATE_MS = 1_000;
// Below this, a disconnect is more likely a flat battery than a BLE problem.
const LOW_BATTERY_PERCENT = 5;
const EVEN_APP_DETECTED_MESSAGE =
  "The Even Realities app appears to be running. If Faceclaw has trouble connecting, open its app settings and force stop it.";

function createInitialDisplayPreview(): ImageSource | null {
  return grayImageToPreviewSource(new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0));
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 23);
}

function eventName(eventType: number): string {
  return OsEventTypeName[eventType] ?? `UNKNOWN_${eventType}`;
}

/**
 * Event-type label for logs. "even-ai" frames carry eEvenAIStatus, not an
 * OsEventTypeList value, so naming them with the OS table would be wrong
 * (status 1 would read as "SCROLL_TOP_EVENT").
 */
function eventLabel(kind: string, eventType: number): string {
  if (kind === "even-ai") {
    return EvenAIStatusName[eventType] ?? `EVEN_AI_UNKNOWN_${eventType}`;
  }
  return eventName(eventType);
}

function sourceName(eventSource: number): string {
  return EventSourceTypeName[eventSource] ?? `SOURCE_${eventSource}`;
}

class DashboardController {
  private phase: ConnectionPhase = "disconnected";
  private status = "Disconnected.";
  private log = "";
  private activeTextSetting: ConfigSettingString | null = null;
  private evenNotificationActive = false;
  private evenAppConflictMessage = "";
  private firmwareWarningMessage = "";
  private batteryOptimizationWarningVisible = false;
  private displayPreview: ImageSource | null = createInitialDisplayPreview();
  private silentMode = false;
  // Last battery level the glasses reported, kept across disconnects so a
  // drop-off right after a low reading can be explained as a flat battery.
  private lastHeadsetBattery: number | null = null;
  private readonly listeners = new Set<DashboardListener>();
  // Set at connect time from the persisted flag; the one-time post-onboarding
  // welcome sound plays on the first rendered frame (proof the session is warm).
  private welcomeSoundArmed = false;

  private communicator: FaceclawCommunicatorBridge | null = null;
  private shellRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private screenTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private offState: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  private offRing: (() => void) | null = null;
  private offBattery: (() => void) | null = null;
  private offSilentMode: (() => void) | null = null;
  private offEvenAppConflict: (() => void) | null = null;
  private offFrameMetrics: (() => void) | null = null;
  private offFirmwareInfo: (() => void) | null = null;
  private offVoiceStatus: (() => void) | null = null;
  private offVoiceWakeWord: (() => void) | null = null;
  private offAndroidNotification: (() => void) | null = null;
  private lastInput = "waiting...";
  private lastSys = "none yet";
  private shellRenderInProgress = false;
  private shellRenderQueued = false;
  private nextShellRenderWantsFreshData = false;
  // One shared worker per app hosts all its windows; spawned on first launch.
  private readonly appHosts = new Map<string, WorkerAppHost>();
  private nextWindowSerial = 1;
  // The Settings app is in-process (its text editor syncs with the phone UI
  // through this controller); tracked so edit flows reach its window.
  private settingsApp: SettingsAppWindow | null = null;
  // Other in-process singleton apps, keyed by windowId.
  private readonly inProcessApps = new Map<string, InProcessWindow>();
  private sharedActions!: Omit<LayerActions, "requestRender">;
  private lastForegroundNotificationUpdateAtMs = 0;
  private lastConnectedPreviewUpdateAtMs = 0;

  constructor() {
    const sharedActions = {
      disconnect: () => this.disconnect(),
      startTextSettingEdit: (setting: ConfigSettingString) => this.startTextSettingEdit(setting),
      endTextSettingEdit: () => this.endTextSettingEdit(),
      startVoiceCapture: () => this.startVoiceCapture(),
      stopVoiceCapture: () => this.stopVoiceCapture(),
      startContinuousVoiceCapture: () => this.startContinuousVoiceCapture(),
      stopContinuousVoiceCapture: () => this.stopContinuousVoiceCapture(),
      playBuzzerSequence: (payload: Uint8Array) => this.playBuzzerSequence(payload),
    };
    this.sharedActions = sharedActions;
    shell.configure({
      actions: {
        ...sharedActions,
        // Shell overlays (voice dialog, long-press menu) live on the shell
        // surface, so their repaints go through the shell render path.
        requestRender: () => this.requestShellRender(),
      },
      getScreenTimeoutMs: () => screenTimeoutSettingToMs(screenTimeoutSetting.get()),
      requestShellRender: () => this.requestShellRender(),
      onScreenStateChanged: (on) => {
        const communicator = this.communicator;
        if (!communicator) return;
        void (async () => {
          // Blanking is a compositor-level flag so worker-window surfaces go
          // dark too; retained state survives for instant wake.
          await communicator.setScreenBlanked(!on);
          await communicator.setG2ScreenOn(on);
        })().catch((error) => {
          this.appendLog(`screen state change failed: ${this.formatError(error)}`);
        });
        if (on) this.requestShellRender();
      },
    });
    // The launcher is pinned first in the sidebar and is the boot foreground.
    shell.registerWindow(
      createLauncherWindow({
        actions: {
          ...sharedActions,
          requestRender: () => shell.foregroundWindow()?.requestRender(),
        },
        apps: [
          { appId: "timer", label: "Timer", icon: "timer" },
          { appId: "terminal", label: "Terminal", icon: "terminal" },
          { appId: "teleprompt", label: "Teleprompt", icon: "file-text" },
          { appId: "music", label: "Music", icon: "music" },
          { appId: "nightscout", label: "Nightscout", icon: "nightscout" },
          { appId: "transcribe", label: "Transcribe", icon: "mic" },
          { appId: "notifications", label: "Notifications", icon: "bell" },
          { appId: "calendar", label: "Calendar", icon: "calendar" },
          { appId: "weather", label: "Weather", icon: "cloud-sun" },
          { appId: "debug-tests", label: "Debug tests", icon: "flask-conical" },
          { appId: "settings", label: "Settings", icon: "settings" },
        ],
        launchApp: (appId) => this.launchApp(appId),
        submitFrame: (image, paintMs, frameId) =>
          this.submitWindowFrame(LAUNCHER_SURFACE_ID, image, paintMs, frameId),
        setSurfaceVisible: (visible) => {
          this.setWindowSurfaceVisible(LAUNCHER_SURFACE_ID, visible);
        },
      }),
    );
    this.offAndroidNotification = onAndroidNotificationPosted((notificationKey) => {
      void this.handleAndroidNotificationPosted(notificationKey).catch((error) => {
        this.appendLog(`notification wake failed: ${this.formatError(error)}`);
      });
    });
    // Settings toggled from the glasses can change what the phone UI shows
    // (e.g. the raw-screenshot button), so re-emit the snapshot on any change.
    onAnySettingChanged(() => {
      this.emit();
      // Apply a firmware-debug-flags toggle live while connected (Java dedups).
      this.pushFirmwareDebugFlags();
    });
  }

  private pushFirmwareDebugFlags(): void {
    if (!this.communicator) return;
    void this.communicator
      .setFirmwareDebugFlags(firmwareDebugFlagsSetting.get())
      .catch(() => {});
  }

  /**
   * Save the current composited screen as the raw headerless 4bpp frame
   * buffer the wire compressor sees; test data for compression experiments.
   */
  saveRawDashboardScreenshot(): string {
    const path = this.communicator?.saveRawCompositeScreenshot() ?? "";
    this.appendLog(path ? `raw screenshot saved: ${path}` : "raw screenshot skipped: not connected");
    return path;
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
      displayPreviewMessage: this.displayPreviewMessage(),
      activeTextSettingId: this.activeTextSetting?.id ?? null,
      activeTextSettingTitle: this.activeTextSetting?.editorTitle ?? "",
      activeTextSettingValue: this.activeTextSetting?.get() ?? "",
      evenAppConflictMessage: this.evenAppConflictMessage,
      evenAppConflictWarningVisible: this.evenAppConflictMessage.length > 0,
      firmwareWarningMessage: this.firmwareWarningMessage,
      firmwareWarningVisible: this.firmwareWarningMessage.length > 0,
      rawScreenshotsEnabled: rawScreenshotsEnabledSetting.get(),
      batteryOptimizationWarningVisible: this.batteryOptimizationWarningVisible,
    };
  }

  /**
   * Message to show in place of the display preview, or "" to show the preview.
   *
   * Both cases look identical to a dead pair of glasses from the phone side:
   * silent mode blanks the display and swallows input while the BLE session
   * stays up, and a battery that just ran out simply stops answering.
   */
  private displayPreviewMessage(): string {
    if (this.silentMode && (this.phase === "connected" || this.phase === "charging")) {
      return "Connected (Silent mode enabled)";
    }
    const connectionFailing = this.phase === "disconnected" || this.phase === "connecting";
    if (
      connectionFailing &&
      this.lastHeadsetBattery !== null &&
      this.lastHeadsetBattery < LOW_BATTERY_PERCENT
    ) {
      return "Disconnected (low battery)";
    }
    return "";
  }

  /**
   * Re-check the Doze exemption (cheap system call, but cached so snapshot()
   * stays trivial). Called on connect, page load, and after the user answers
   * the system exemption dialog.
   */
  refreshBatteryOptimizationStatus(): void {
    const warningVisible = !isIgnoringBatteryOptimizations();
    if (warningVisible !== this.batteryOptimizationWarningVisible) {
      this.batteryOptimizationWarningVisible = warningVisible;
      this.emit();
    }
  }

  requestBatteryOptimizationExemption(): void {
    requestIgnoreBatteryOptimizations();
    // The system dialog is asynchronous and there is no result callback from
    // this context; poll briefly so the banner clears once granted.
    let checksLeft = 12;
    const poll = setInterval(() => {
      this.refreshBatteryOptimizationStatus();
      if (!this.batteryOptimizationWarningVisible || --checksLeft <= 0) {
        clearInterval(poll);
      }
    }, 5_000);
  }

  refreshEvenAppStatus(): void {
    this.refreshBatteryOptimizationStatus();
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
    shell.noteUserActivity();
    const setting = this.activeTextSetting;
    if (!setting) return;
    if (setting.get() === value) return;
    setting.set(value);
    // Deliberately do NOT emit() here. The phone TextField is the source of
    // truth while typing; echoing activeTextSettingValue back into its two-way
    // binding on every keystroke drops fast/pasted characters (observed: a
    // 51-char API key stored as its first 46 chars). Just refresh the preview.
    this.previewOrRenderAfterTextSettingChange();
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
    this.welcomeSoundArmed = isWelcomeSoundPending();
    this.firmwareWarningMessage = "";
    this.refreshBatteryOptimizationStatus();
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
            : state.phase === "charging"
              ? "charging"
              : state.phase === "disconnecting"
                ? "disconnecting"
                : state.phase === "disconnected"
                  ? "disconnected"
                  : "connecting";
        if (mappedPhase === "charging" && this.phase !== "charging") {
          // Nobody is wearing the glasses; drop the G2-screen wakelock so the
          // phone can sleep normally while they charge.
          void this.communicator?.setG2ScreenOn(false).catch(() => {});
        }
        if (mappedPhase === "connected" && this.phase !== "connected") {
          // Push the CFW firmware-debug-flags overlay preference; Java emits the
          // mode-7 control message once the dashboard container is warmed up.
          this.pushFirmwareDebugFlags();
        }
        this.setPhase(mappedPhase);
        this.setStatus(state.status);
      });
      this.offRing = communicator.onRingEvent((event) => {
        void this.handleInputEvent(event).catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`input handler failed: ${message}`);
        });
      });
      this.offSilentMode = communicator.onSilentMode((silent) => {
        if (this.silentMode === silent) return;
        this.silentMode = silent;
        this.emit();
      });
      this.offBattery = communicator.onBatteryState((state) => {
        this.lastHeadsetBattery = state.battery >= 0 ? state.battery : null;
        shell.setBatteryLevels({
          headset: state.battery,
          headsetCharging: state.chargingStatus > 0,
        });
        if ((this.phase === "connected" || this.phase === "charging") && this.communicator) {
          // Repaint the top bar (battery indicators live in the shell chrome).
          this.requestShellRender();
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
          // A rendered frame means the session is warmed up (fixedLayoutCreated),
          // so the buzzer won't be dropped. Play the one-time welcome sound now.
          if (this.welcomeSoundArmed) {
            this.welcomeSoundArmed = false;
            setWelcomeSoundPending(false);
            void this.playWelcomeSound();
          }
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
      // The Music and Nightscout apps subscribe to their bridges directly and
      // repaint their own windows, so bridge updates need no controller action.
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
      // Register the compositor surfaces: the shell chrome above all windows,
      // and a surface per live window (only the foreground one is composited).
      await communicator.configureCompositorScreen(G2_LENS_WIDTH, G2_LENS_HEIGHT);
      await communicator.configureSurface(SHELL_SURFACE_ID, {
        x: 0,
        y: 0,
        width: G2_LENS_WIDTH,
        height: G2_LENS_HEIGHT,
        zOrder: 1,
        transparency: "color-key",
      });
      const foregroundWindowId = shell.foregroundWindow()?.windowId;
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(window.surfaceId, window.windowId === foregroundWindowId);
      }
      await communicator.start();
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
      // Refresh the top-bar clock and the phone-side preview once a minute,
      // and keep the Android persistent notification current.
      this.shellRefreshTimer = setInterval(() => {
        this.requestShellRender();
        this.updateCompositePreview();
        this.updateConnectedForegroundNotification();
      }, SHELL_REFRESH_INTERVAL_MS);
      this.previewTimer = setInterval(() => this.updateCompositePreview(), PREVIEW_INTERVAL_MS);
      this.screenTimeoutTimer = setInterval(() => {
        if (this.phase !== "connected" || !this.communicator) return;
        if (!shell.applyScreenTimeout()) return;
        this.endTextSettingEdit();
        this.requestShellRender();
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
      this.offSilentMode?.();
      this.offSilentMode = null;
      this.offEvenAppConflict?.();
      this.offEvenAppConflict = null;
      this.offFrameMetrics?.();
      this.offFrameMetrics = null;
      this.offFirmwareInfo?.();
      this.offFirmwareInfo = null;
      this.offVoiceStatus?.();
      this.offVoiceStatus = null;
      this.offVoiceWakeWord?.();
      this.offVoiceWakeWord = null;
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
    this.offSilentMode?.();
    this.offSilentMode = null;
    this.offEvenAppConflict?.();
    this.offEvenAppConflict = null;
    this.offFrameMetrics?.();
    this.offFrameMetrics = null;
    this.offFirmwareInfo?.();
    this.offFirmwareInfo = null;
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

  /** A document arrived via Android's Share intent: open it as a new window. */
  async openTelepromptDocument(text: string): Promise<void> {
    this.appendLog(`teleprompt document received (${text.length} chars)`);
    if (!shell.isScreenOn()) {
      shell.wake("sidebar");
    }
    this.openTelepromptDocumentWindow("Shared text", text);
  }

  /** Open a teleprompt document as its own (closeable, non-singleton) window. */
  private openTelepromptDocumentWindow(title: string, text: string): void {
    const windowId = `teleprompt:doc:${this.nextWindowSerial++}`;
    void this.launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createTelepromptDocumentWindow(windowId, title, text, options),
    ).catch((error) => {
      this.appendLog(`teleprompt window failed: ${this.formatError(error)}`);
    });
  }

  private startTextSettingEdit(setting: ConfigSettingString): void {
    this.activeTextSetting = setting;
    this.emit();
  }

  /**
   * Begin voice capture with the provider chosen in settings. Used by both
   * push-to-talk and the Transcribe app. Android mic permission is the consent
   * gate even though the audio source is the G2 mic over BLE.
   */
  private startVoiceCapture(endpointing = false): void {
    this.beginVoiceCapture("ptt", endpointing);
  }

  private stopVoiceCapture(): void {
    voiceControlBridge.stopPushToTalk();
  }

  private startContinuousVoiceCapture(): void {
    this.beginVoiceCapture("continuous");
  }

  private stopContinuousVoiceCapture(): void {
    voiceControlBridge.stopContinuousCapture();
  }

  private beginVoiceCapture(kind: "ptt" | "continuous", endpointing = false): void {
    if (this.phase !== "connected" || !this.communicator) {
      return;
    }
    const communicator = this.communicator;
    void ensureVoicePermissions()
      .then(() => {
        if (this.phase !== "connected" || this.communicator !== communicator) return;
        const options = {
          communicator: communicator.getNativeCommunicator(),
          provider: voiceProviderSetting.get(),
          elevenLabsApiKey: elevenLabsApiKeySetting.get(),
          openAiApiKey: openAiApiKeySetting.get(),
          saveRecording: saveVoiceRecordingsSetting.get(),
          endpointing,
        };
        if (kind === "ptt") {
          voiceControlBridge.startPushToTalk(options);
        } else {
          voiceControlBridge.startContinuousCapture(options);
        }
      })
      .catch((error) => {
        this.appendLog(`voice permission failed: ${this.formatError(error)}`);
      });
  }

  private endTextSettingEdit(): void {
    const finishedSetting = this.activeTextSetting;
    this.activeTextSetting = null;
    this.emit();
    if (finishedSetting === nightscoutSiteUrlSetting || finishedSetting === nightscoutApiTokenSetting) {
      void this.refreshNightscoutAfterSettingsChange();
    }
  }

  /**
   * Finish the active edit from the phone side (e.g. the IME's done key):
   * ends the edit session and navigates the Settings app's glasses editor
   * out of the edit page.
   */
  finishActiveTextSettingEdit(): void {
    if (!this.activeTextSetting) return;
    this.endTextSettingEdit();
    if (this.settingsApp?.closeTextEditor()) {
      this.settingsApp.requestRender();
    }
  }

  private updateTextSetting(setting: ConfigSettingString, value: string): void {
    if (setting.get() !== value) {
      setting.set(value);
      this.emit();
      this.previewOrRenderAfterTextSettingChange();
    }
  }

  private async refreshNightscoutAfterSettingsChange(): Promise<void> {
    await nightscoutBridge.refreshNow().catch((error) => {
      this.appendLog(`nightscout settings refresh failed: ${this.formatError(error)}`);
    });
  }

  private previewOrRenderAfterTextSettingChange(): void {
    // Echo phone-side keystrokes into the Settings app's glasses editor.
    if (this.settingsApp?.isTextEditorOnTop()) {
      this.settingsApp.requestRender();
    }
  }

  private async handleInputEvent(event: RawInputEvent): Promise<void> {
    const frameId =
      event.frameId > 0 ? event.frameId : frameTimings.startFrame(`input:${event.kind} (untracked source)`);
    frameTimings.logFrame(frameId, `TS input handler start: ${event.kind} ${eventLabel(event.kind, event.eventType)}`);
    let frameOwned = false;
    try {
      const inputEvent = rawInputEventToInputEvent(event);
      frameTimings.spanStart(frameId, "handle-input");
      let outcome: ShellInputOutcome;
      try {
        // The shell consumes its reserved gestures and forwards the rest to
        // the focused window; the outcome says which surfaces changed.
        outcome = await shell.receiveInput(inputEvent, frameId);
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
      }

      if (outcome.shell) {
        this.requestShellRender();
      }
      if (outcome.window) {
        // The window adapter owned frameId (render or explicit finish).
        frameOwned = true;
      } else if (outcome.shell) {
        frameOwned = true;
        frameTimings.finishFrame(frameId, "input consumed by shell; chrome render scheduled");
      }
    } finally {
      if (!frameOwned) {
        frameTimings.finishFrame(frameId, "discarded: input did not trigger a render");
      }
    }
  }

  /** Launch or focus the (in-process, singleton) Settings app. */
  private async launchSettingsApp(): Promise<void> {
    if (this.settingsApp) {
      shell.focusWindow(SETTINGS_WINDOW_ID);
      this.requestShellRender();
      return;
    }
    const settingsApp = createSettingsAppWindow({
      actions: {
        ...this.sharedActions,
        requestRender: () => {}, // rebound by createInProcessWindow
      },
      submitFrame: (image, paintMs, frameId) =>
        this.submitWindowFrame(SETTINGS_SURFACE_ID, image, paintMs, frameId),
      setSurfaceVisible: (visible) => this.setWindowSurfaceVisible(SETTINGS_SURFACE_ID, visible),
      removeSurface: () => this.removeWindowSurface(SETTINGS_SURFACE_ID),
      onClosed: () => {
        // Closing mid-edit must not leave the phone-side editor dangling.
        this.endTextSettingEdit();
        this.settingsApp = null;
      },
    });
    this.settingsApp = settingsApp;
    shell.registerWindow(settingsApp.window);
    // Configure the surface before foregrounding so the first frame has
    // somewhere to land.
    await this.configureWindowSurface(SETTINGS_SURFACE_ID, false);
    shell.focusWindow(SETTINGS_WINDOW_ID);
    this.requestShellRender();
    this.appendLog("launched settings");
  }

  /** Launch or focus an in-process singleton app (notifications, debug tests). */
  private async launchInProcessApp(
    windowId: string,
    surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow,
  ): Promise<void> {
    const existing = this.inProcessApps.get(windowId);
    if (existing) {
      shell.focusWindow(windowId);
      this.requestShellRender();
      return;
    }
    const app = create({
      actions: {
        ...this.sharedActions,
        requestRender: () => {}, // rebound by createInProcessWindow
      },
      submitFrame: (image, paintMs, frameId) => this.submitWindowFrame(surfaceId, image, paintMs, frameId),
      setSurfaceVisible: (visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: () => this.removeWindowSurface(surfaceId),
      onClosed: () => {
        this.inProcessApps.delete(windowId);
      },
    });
    this.inProcessApps.set(windowId, app);
    shell.registerWindow(app.window);
    await this.configureWindowSurface(surfaceId, false);
    shell.focusWindow(windowId);
    this.requestShellRender();
    this.appendLog(`launched ${windowId}`);
  }

  /** Get or spawn the worker host for an app. */
  private ensureAppHost(appId: string): WorkerAppHost | null {
    const existing = this.appHosts.get(appId);
    if (existing) return existing;
    // Worker paths must be string literals for the webpack worker loader.
    let worker: Worker;
    if (appId === "timer") {
      worker = new Worker("../workers/timer-app.worker");
    } else if (appId === "terminal") {
      worker = new Worker("../workers/terminal-app.worker");
    } else {
      return null;
    }
    const host = new WorkerAppHost({
      appId,
      worker,
      viewport: { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height },
      configureSurface: (surfaceId, visible) => this.configureWindowSurface(surfaceId, visible),
      setSurfaceVisible: (surfaceId, visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: (surfaceId) => this.removeWindowSurface(surfaceId),
      requestShellRender: () => this.requestShellRender(),
    });
    this.appHosts.set(appId, host);
    return host;
  }

  /**
   * Launch an app from the launcher: open a window in the app's shared
   * worker (spawned on first launch) and foreground it. Launching an app
   * with an open singleton window (the terminal hub, settings) focuses it.
   */
  private async launchApp(appId: string): Promise<void> {
    if (appId === "settings") {
      await this.launchSettingsApp();
      return;
    }
    if (appId === "notifications") {
      // Without notification-listener access the tray reads as empty; prompt
      // the user on the phone so the on-glasses "grant permission" message is
      // actionable. The app still opens to show that message.
      if (!isNotificationListenerEnabled()) {
        requestNotificationListenerAccess();
      }
      await this.launchInProcessApp(NOTIFICATIONS_WINDOW_ID, NOTIFICATIONS_SURFACE_ID, createNotificationsAppWindow);
      return;
    }
    if (appId === "calendar") {
      await this.launchInProcessApp(CALENDAR_WINDOW_ID, CALENDAR_SURFACE_ID, createCalendarAppWindow);
      return;
    }
    if (appId === "weather") {
      await this.launchInProcessApp(WEATHER_WINDOW_ID, WEATHER_SURFACE_ID, createWeatherAppWindow);
      return;
    }
    if (appId === "debug-tests") {
      await this.launchInProcessApp(DEBUG_TESTS_WINDOW_ID, DEBUG_TESTS_SURFACE_ID, createDebugTestsAppWindow);
      return;
    }
    if (appId === "nightscout") {
      await this.launchInProcessApp(NIGHTSCOUT_WINDOW_ID, NIGHTSCOUT_SURFACE_ID, createNightscoutAppWindow);
      return;
    }
    if (appId === "music") {
      await this.launchInProcessApp(MUSIC_WINDOW_ID, MUSIC_SURFACE_ID, createMusicAppWindow);
      return;
    }
    if (appId === "transcribe") {
      await this.launchInProcessApp(TRANSCRIBE_WINDOW_ID, TRANSCRIBE_SURFACE_ID, (options) =>
        createTranscribeAppWindow({
          ...options,
          startContinuousVoiceCapture: () => this.startContinuousVoiceCapture(),
          stopContinuousVoiceCapture: () => this.stopContinuousVoiceCapture(),
        }),
      );
      return;
    }
    if (appId === "teleprompt") {
      await this.launchInProcessApp(TELEPROMPT_WINDOW_ID, TELEPROMPT_SURFACE_ID, (options) =>
        createTelepromptBrowserWindow({
          ...options,
          openDocumentWindow: (title, text) => this.openTelepromptDocumentWindow(title, text),
        }),
      );
      return;
    }
    const host = this.ensureAppHost(appId);
    if (!host) {
      this.appendLog(`unknown app: ${appId}`);
      return;
    }
    if (appId === "terminal") {
      const existingHub = shell.getWindows().find((w) => w.windowId === "terminal:hub");
      if (existingHub) {
        shell.focusWindow(existingHub.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({ windowId: "terminal:hub", title: "Terminal", iconLetter: "T", icon: "terminal", focus: true });
      this.appendLog("launched terminal:hub");
      return;
    }
    if (appId === "timer") {
      const existing = shell.getWindows().find((window) => window.appId === "timer");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({ windowId: "timer:main", title: "Timer", iconLetter: "T", icon: "timer", focus: true });
      this.appendLog("launched timer:main");
      return;
    }
  }

  /** Create/refresh a window surface on the compositor, if connected. */
  private async configureWindowSurface(surfaceId: string, visible: boolean): Promise<void> {
    const communicator = this.communicator;
    if (!communicator) return;
    await communicator.configureSurface(surfaceId, {
      x: APP_VIEWPORT.x,
      y: APP_VIEWPORT.y,
      width: APP_VIEWPORT.width,
      height: APP_VIEWPORT.height,
      zOrder: 0,
      transparency: "opaque",
    });
    await communicator.setSurfaceVisible(surfaceId, visible);
  }

  private removeWindowSurface(surfaceId: string): void {
    const communicator = this.communicator;
    if (!communicator) return;
    void communicator.removeSurface(surfaceId).catch((error) => {
      this.appendLog(`surface removal failed: ${this.formatError(error)}`);
    });
  }

  /** Submit a painted frame for an in-process window (e.g. the launcher). */
  private async submitWindowFrame(surfaceId: string, image: GrayImage, paintMs: number, frameId: number): Promise<void> {
    const communicator = this.communicator;
    if (!communicator || this.phase === "charging") {
      frameTimings.finishFrame(frameId, "discarded: window frame with no active connection");
      return;
    }
    const fingerprint = image.fingerprint();
    const buffer = image.to8bppBuffer();
    await communicator.submitSurfaceFrame(
      surfaceId,
      buffer,
      { x: 0, y: 0, width: image.width, height: image.height },
      fingerprint,
      paintMs,
      frameId,
    );
  }

  /** Flip a window surface's compositor visibility; fire-and-forget. */
  private setWindowSurfaceVisible(surfaceId: string, visible: boolean): void {
    const communicator = this.communicator;
    if (!communicator) return;
    void communicator.setSurfaceVisible(surfaceId, visible).catch((error) => {
      this.appendLog(`surface visibility change failed: ${this.formatError(error)}`);
    });
  }

  /**
   * Re-render and resubmit the shell surface (sidebar, top bar, shell
   * overlays). Coalesces like requestRender: one render in flight, at most
   * one queued.
   */
  requestShellRender(): void {
    if (this.shellRenderInProgress) {
      this.shellRenderQueued = true;
      return;
    }
    this.shellRenderInProgress = true;
    void (async () => {
      try {
        do {
          this.shellRenderQueued = false;
          await this.renderShell();
        } while (this.shellRenderQueued);
      } catch (error) {
        this.appendLog(`shell render failed: ${this.formatError(error)}`);
      } finally {
        this.shellRenderInProgress = false;
      }
    })();
  }

  private async renderShell(): Promise<void> {
    const frameId = frameTimings.startFrame("render:shell");
    const wantFreshData = this.nextShellRenderWantsFreshData;
    this.nextShellRenderWantsFreshData = false;
    beginRenderPass(!wantFreshData);
    const paintStartedAtMs = Date.now();
    const image = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => shell.paintSurface()),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const paintUsedStaleData = endRenderPass();
    if (paintUsedStaleData) {
      // Repaint with fresh data (e.g. notification icons) once this frame is
      // out; mirrors renderDashboard's stale-data contract.
      this.nextShellRenderWantsFreshData = true;
      this.requestShellRender();
    }
    if (!this.communicator || this.phase === "charging") {
      frameTimings.finishFrame(frameId, "discarded: shell render with no active connection");
      return;
    }
    const fingerprint = frameTimings.span(frameId, "fingerprint", () => image.fingerprint());
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    await this.communicator.submitSurfaceFrame(
      SHELL_SURFACE_ID,
      buffer,
      { x: 0, y: 0, width: image.width, height: image.height },
      fingerprint,
      paintMs,
      frameId,
    );
    await this.communicator.waitForFrameFinished(frameId, FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS);
    this.updateCompositePreview();
  }

  private async handleWakeWord(keyword: string): Promise<void> {
    const normalized = keyword.trim();
    if (normalized.length === 0) return;
    this.appendLog(`wake-word detected: ${normalized}`);
    if (shell.wake("sidebar")) {
      this.requestShellRender();
    }
  }

  private async handleAndroidNotificationPosted(notificationKey: string): Promise<void> {
    // Keep the Notifications app's list fresh if it is open.
    this.inProcessApps.get(NOTIFICATIONS_WINDOW_ID)?.requestRender();
    if (!notificationKey) {
      this.requestShellRender();
      return;
    }
    // New notifications open a shell modal over the app viewport; if the
    // screen was off, wake for it and go back to sleep when it is closed.
    // Waking while already on would steal focus, so only wake from sleep.
    const wokeScreen = shell.isScreenOn() ? false : shell.wake("sidebar");
    if (wokeScreen) {
      this.appendLog("android notification woke the screen");
    }
    shell.openNotificationModal(notificationKey, wokeScreen);
    this.requestShellRender();
  }

  private async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    if (this.phase !== "connected" || !this.communicator) {
      return;
    }
    await this.communicator.playBuzzerSequence(payload);
  }

  /** One-time celebratory jingle on the first connection after onboarding. */
  private async playWelcomeSound(): Promise<void> {
    const effect = findSoundEffect("questcomplete");
    if (!effect) return;
    try {
      await playSoundEffect(
        effect,
        (payload) => this.playBuzzerSequence(payload),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
    } catch (error) {
      this.appendLog(`welcome sound failed: ${this.formatError(error)}`);
    }
  }

  private clearDashboardTimer(): void {
    if (this.shellRefreshTimer) {
      clearInterval(this.shellRefreshTimer);
      this.shellRefreshTimer = null;
    }
    if (this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.screenTimeoutTimer) {
      clearInterval(this.screenTimeoutTimer);
      this.screenTimeoutTimer = null;
    }
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === "disconnected") {
      // Kept across "connecting": silent mode blocks app launches, so it can
      // itself cause the reconnect churn, and Java re-reports it either way.
      this.silentMode = false;
    }
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

  /**
   * Phone-side preview of what is on the glasses, fetched from the Java
   * compositor so it reflects every surface (chrome + whichever app is
   * foreground, including worker apps the TS side never renders). Throttled
   * to avoid rebuilding the bitmap faster than the phone UI needs it.
   */
  private updateCompositePreview(): void {
    if (!this.communicator) return;
    const now = Date.now();
    if (
      this.lastConnectedPreviewUpdateAtMs > 0 &&
      now - this.lastConnectedPreviewUpdateAtMs < CONNECTED_PREVIEW_MIN_UPDATE_MS
    ) {
      return;
    }
    this.lastConnectedPreviewUpdateAtMs = now;
    const preview = this.communicator.getCompositePreview();
    if (preview) {
      this.setDisplayPreview(preview);
    }
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
          containerName: "",
          eventType: OsEventTypeList.CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "double-click":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-up":
        return {
          kind: "text-click",
          containerName: "",
          eventType: OsEventTypeList.SCROLL_TOP_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-down":
      default:
        return {
          kind: "text-click",
          containerName: "",
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
