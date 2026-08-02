import { ImageSource } from "@nativescript/core";
import {
  EvenAIStatus,
  EvenAIStatusName,
  EventSourceType,
  EventSourceTypeName,
  OsEventTypeList,
  OsEventTypeName,
} from "./events";
import { loadDeviceAddresses } from "./device-addresses";
import { ensureBlePermissions, ensureFineLocationPermission, ensureVoicePermissions } from "./android-permissions";
import { FaceclawCommunicatorBridge, type RawInputEvent } from "../native/faceclaw-communicator";
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
import { getDefaultMediumFont } from "../graphics/bdffont";
import { wrapText } from "../graphics/textwrap";
import { rawInputEventToInputEvent, shell, type ShellInputOutcome } from "../ui/shell/shell";
import { registerSystemTools } from "../assistant/system-tools";
import { registerNavigateTools } from "../assistant/navigate-tools";
import { assistantBridge } from "../assistant/bridge-client";
import { registerWindowTools } from "../assistant/window-tools";
import { WorkerAppHost } from "../ui/shell/worker-window";
import {
  createLauncherWindow,
  LAUNCHER_SURFACE_ID,
  type LauncherAppEntry,
} from "../ui/shell/launcher-app";
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
  createFilesAppWindow,
  createImageDocumentWindow,
  createTextDocumentWindow,
  FILES_SURFACE_ID,
  FILES_WINDOW_ID,
} from "../ui/shell/files-app";
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
import { loadPersistedOpenApps, savePersistedOpenApps } from "../ui/shell/open-apps-persistence";
import { appViewportRect, type WindowHeightMode } from "../ui/shell/geometry";
import { type LayerActions } from "../ui/layers";
import {
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  brightnessSetting,
  brightnessSettingToLevel,
  elevenLabsApiKeySetting,
  openAiApiKeySetting,
  nightscoutApiTokenSetting,
  firmwareDebugFlagsSetting,
  lockScreenEnabledSetting,
  nightscoutSiteUrlSetting,
  onAnySettingChanged,
  saveVoiceRecordingsSetting,
  screenTimeoutSetting,
  screenTimeoutSettingToMs,
  suspendEvenHubWhenScreenOffSetting,
  systemCardNameSetting,
  verticalPositionSetting,
  voiceProviderSetting,
  wakeWordActionSetting,
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
  screenRecordingActive: boolean;
  batteryOptimizationWarningVisible: boolean;
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;

// The shell chrome (sidebar + top bar + overlays) composites above all app
// window surfaces with color-key transparency.
const SHELL_SURFACE_ID = "shell";
const LOCK_SCREEN_SURFACE_ID = "lock-screen";
const LOCK_SCREEN_MESSAGE = "Glasses locked; unlock the phone to unlock the glasses.";
// Top-bar clock refresh; the phone-side preview polls the Java composite so
// it reflects every app (including worker apps the TS side never renders).
const SHELL_REFRESH_INTERVAL_MS = 60_000;
const PREVIEW_INTERVAL_MS = 1_000;
const SCREEN_TIMEOUT_CHECK_MS = 1_000;
const EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS = 5_000;
const EVENHUB_WAKE_READY_TIMEOUT_MS = 4_500;
const FOREGROUND_NOTIFICATION_MIN_UPDATE_MS = 30_000;
const FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS = 6_000;
const CONNECTED_PREVIEW_MIN_UPDATE_MS = 1_000;
// Below this, a disconnect is more likely a flat battery than a BLE problem.
const LOW_BATTERY_PERCENT = 5;
const EVEN_APP_DETECTED_MESSAGE =
  "The Even Realities app appears to be running. If Faceclaw has trouble connecting, open its app settings and force stop it.";

// The launcher grid's app list; also fixes the app ids apps.launch accepts.
const LAUNCHER_APPS: LauncherAppEntry[] = [
  { appId: "timer", label: "Timer", icon: "timer" },
  { appId: "terminal", label: "Terminal", icon: "terminal" },
  { appId: "files", label: "Files", icon: "folder" },
  { appId: "music", label: "Music", icon: "music" },
  { appId: "nightscout", label: "Nightscout", icon: "nightscout" },
  { appId: "transcribe", label: "Transcribe", icon: "mic" },
  { appId: "notifications", label: "Notifications", icon: "bell" },
  { appId: "calendar", label: "Calendar", icon: "calendar" },
  { appId: "weather", label: "Weather", icon: "cloud-sun" },
  { appId: "navigate", label: "Navigate", icon: "map" },
  { appId: "blocks", label: "Blocks", icon: "l-piece" },
  { appId: "minesweeper", label: "Minesweeper", icon: "bomb" },
  { appId: "freecell", label: "Freecell", icon: "spade" },
  { appId: "pinball", label: "Pinball", icon: "pinball" },
  { appId: "debug-tests", label: "Debug tests", icon: "flask-conical" },
  { appId: "settings", label: "Settings", icon: "settings" },
];

function createInitialDisplayPreview(): ImageSource | null {
  return grayImageToPreviewSource(new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0));
}

function createLockScreenImage(): GrayImage {
  const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  const font = getDefaultMediumFont();
  const boxWidth = 480;
  const boxHeight = 150;
  const boxX = Math.round((G2_LENS_WIDTH - boxWidth) / 2);
  const boxY = Math.round((G2_LENS_HEIGHT - boxHeight) / 2);
  image.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, 150, 12);
  const lines = wrapText(font, LOCK_SCREEN_MESSAGE, boxWidth - 64);
  const textHeight = lines.length * font.lineHeight;
  const firstY = boxY + Math.round((boxHeight - textHeight) / 2);
  lines.forEach((line, index) => {
    const x = Math.round((G2_LENS_WIDTH - font.measureText(line)) / 2);
    image.drawText(font, x, firstY + index * font.lineHeight, line, 230);
  });
  return image;
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
  private screenRecordingActive = false;
  private displayPreview: ImageSource | null = createInitialDisplayPreview();
  private silentMode = false;
  // Brightness value last pushed to the glasses; see pushBrightness.
  private lastPushedBrightness: string | null = null;
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
  private evenHubSuspendTimer: ReturnType<typeof setTimeout> | null = null;
  private evenHubSessionSuspended = false;
  private evenHubResumePromise: Promise<boolean> | null = null;
  private faceclawWakeLeaseSupported = false;
  private faceclawWakeLeaseState: boolean | null = null;
  private wearNotifySupported = false;
  private glassesWorn: boolean | null = null;
  private phoneLocked = false;
  private glassesLocked = false;
  private lockSurfaceConfigured = false;
  private lastLockScreenEnabled = lockScreenEnabledSetting.get();
  private offState: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  private offRing: (() => void) | null = null;
  private offBattery: (() => void) | null = null;
  private offSilentMode: (() => void) | null = null;
  private offWearState: (() => void) | null = null;
  private offPhoneLockState: (() => void) | null = null;
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
  // Saving the open-app list is gated until the one-time restore has run, so
  // the boot-time registry (just the launcher) never clobbers the saved list.
  private openAppsRestored = false;
  private suppressOpenAppsPersist = false;

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
    // The always-available assistant tools (calendar, media, notifications,
    // glasses state) register once at startup, independent of any connection.
    registerSystemTools();
    // nav.* tools launch the Navigate app on demand, so they need launchApp.
    registerNavigateTools((appId) => this.launchApp(appId));
    // apps.* tools mirror the launcher grid and sidebar (launch, focus, close).
    registerWindowTools({
      apps: LAUNCHER_APPS,
      launchApp: (appId) => this.launchApp(appId),
      requestShellRender: () => this.requestShellRender(),
    });
    shell.configure({
      actions: {
        ...sharedActions,
        // Shell overlays (voice dialog, long-press menu) live on the shell
        // surface, so their repaints go through the shell render path.
        requestRender: () => this.requestShellRender(),
      },
      getScreenTimeoutMs: () => screenTimeoutSettingToMs(screenTimeoutSetting.get()),
      requestShellRender: () => this.requestShellRender(),
      onWindowsChanged: () => this.persistOpenApps(),
      onScreenStateChanged: (on) => {
        this.handleScreenStateChanged(on);
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
        apps: LAUNCHER_APPS,
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
    // (e.g. the text-setting editor), so re-emit the snapshot on any change.
    onAnySettingChanged(() => {
      this.emit();
      // Apply a firmware-debug-flags toggle live while connected (Java dedups).
      this.pushFirmwareDebugFlags();
      this.pushBrightness();
      this.syncEvenHubScreenOffSetting();
      this.applyVerticalPositionIfChanged();
      this.syncAssistantBridgeIfChanged();
      this.syncLockScreenSettingIfChanged();
    });
    // Connect to the external agent bridge at boot if configured; the
    // connection stays up (with re-dial) so proactive tool calls work
    // outside voice turns.
    this.syncAssistantBridge();
  }

  // Bridge settings changes re-dial the connection; unrelated setting changes
  // must not, so the config it was last started with is tracked.
  private lastBridgeConfigKey = "";

  private bridgeConfigKey(): string {
    return JSON.stringify([
      assistantBackendSetting.get(),
      assistantBridgeHostSetting.get().trim(),
      assistantBridgePortSetting.get().trim(),
      assistantBridgeTokenSetting.get(),
    ]);
  }

  private syncAssistantBridgeIfChanged(): void {
    if (this.bridgeConfigKey() === this.lastBridgeConfigKey) return;
    this.syncAssistantBridge();
  }

  private syncAssistantBridge(): void {
    this.lastBridgeConfigKey = this.bridgeConfigKey();
    const host = assistantBridgeHostSetting.get().trim();
    const token = assistantBridgeTokenSetting.get();
    if (assistantBackendSetting.get() !== "external" || !host || !token) {
      assistantBridge.stop();
      return;
    }
    assistantBridge.configure({
      host,
      port: parseInt(assistantBridgePortSetting.get(), 10) || 8790,
      token,
      deviceName: "faceclaw",
      allowProactive: () => assistantAllowProactiveSetting.get(),
    });
  }

  // Vertical-position changes move every window surface (and the chrome that
  // aligns with them); the value is tracked so unrelated setting changes
  // don't trigger a full reposition.
  private lastVerticalPosition = verticalPositionSetting.get();

  private applyVerticalPositionIfChanged(): void {
    const position = verticalPositionSetting.get();
    if (position === this.lastVerticalPosition) return;
    this.lastVerticalPosition = position;
    const foregroundWindowId = shell.foregroundWindow()?.windowId;
    void (async () => {
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(
          window.surfaceId,
          window.windowId === foregroundWindowId,
          window.heightMode,
        );
      }
      // Repaint after the surfaces have moved: window content is unchanged
      // but the moved surfaces need a recomposite, and the chrome band moved.
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
    })().catch((error) => {
      this.appendLog(`vertical reposition failed: ${this.formatError(error)}`);
    });
  }

  private handleScreenStateChanged(on: boolean): void {
    if (on) {
      this.cancelEvenHubSuspendTimer();
      void this.ensureEvenHubSessionActive().catch((error) => {
        this.appendLog(`screen wake failed: ${this.formatError(error)}`);
      });
      return;
    }

    const communicator = this.communicator;
    if (!communicator) return;
    // Blanking is a compositor-level flag so worker-window surfaces go dark
    // too; retained state survives while the EvenHub page is absent.
    void (async () => {
      await communicator.setScreenBlanked(true);
      await communicator.setG2ScreenOn(false);
    })().catch((error) => {
      this.appendLog(`screen sleep failed: ${this.formatError(error)}`);
    });
    this.scheduleEvenHubSuspend();
  }

  private syncLockScreenSettingIfChanged(): void {
    const enabled = lockScreenEnabledSetting.get();
    if (enabled === this.lastLockScreenEnabled) return;
    this.lastLockScreenEnabled = enabled;
    if (!enabled) {
      this.setGlassesLocked(false, "lock screen disabled");
      return;
    }
    if (this.phoneLocked && this.glassesWorn === false) {
      this.setGlassesLocked(true, "lock screen enabled while glasses are off-head");
    }
    this.ensureWearStateTracking();
  }

  private handleWearState(wearing: boolean): void {
    this.glassesWorn = wearing;
    this.appendLog(wearing ? "glasses wear state: ON_HEAD" : "glasses wear state: OFF_HEAD");
    if (!wearing && this.phoneLocked && lockScreenEnabledSetting.get()) {
      this.setGlassesLocked(true, "glasses removed while phone locked");
    }
  }

  private handlePhoneLockState(locked: boolean): void {
    if (locked === this.phoneLocked) return;
    this.phoneLocked = locked;
    this.appendLog(`phone lock state: ${locked ? "locked" : "unlocked"}`);
    if (!locked) {
      this.setGlassesLocked(false, "phone unlocked");
    } else if (this.glassesWorn === false && lockScreenEnabledSetting.get()) {
      this.setGlassesLocked(true, "phone locked while glasses are off-head");
    }
  }

  private setGlassesLocked(locked: boolean, reason: string): void {
    if (locked === this.glassesLocked) return;
    this.glassesLocked = locked;
    this.appendLog(`glasses ${locked ? "locked" : "unlocked"}: ${reason}`);
    void this.syncLockSurface().catch((error) => {
      this.appendLog(`lock screen update failed: ${this.formatError(error)}`);
    });
  }

  private ensureWearStateTracking(): void {
    const communicator = this.communicator;
    if (
      !lockScreenEnabledSetting.get() ||
      !this.wearNotifySupported ||
      this.phase !== "connected" ||
      !communicator
    ) {
      return;
    }
    void communicator.enableWearDetectionAndRequestState().catch((error) => {
      this.appendLog(`wear detector setup failed: ${this.formatError(error)}`);
    });
  }

  private async configureLockSurface(communicator: FaceclawCommunicatorBridge): Promise<void> {
    await communicator.configureSurface(LOCK_SCREEN_SURFACE_ID, {
      x: 0,
      y: 0,
      width: G2_LENS_WIDTH,
      height: G2_LENS_HEIGHT,
      zOrder: 1000,
      transparency: "opaque",
    });
    await communicator.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, false);
    const image = createLockScreenImage();
    await communicator.submitSurfaceFrame(
      LOCK_SCREEN_SURFACE_ID,
      image.to8bppBuffer(),
      { x: 0, y: 0, width: image.width, height: image.height },
      image.fingerprint(),
    );
    if (this.communicator === communicator) {
      this.lockSurfaceConfigured = true;
    }
  }

  private async syncLockSurface(): Promise<void> {
    const communicator = this.communicator;
    if (!communicator || !this.lockSurfaceConfigured) return;
    await communicator.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, this.glassesLocked);
    this.updateCompositePreview();
  }

  /**
   * The single wake barrier for every source: restore the EvenHub lifecycle,
   * unblank the retained compositor, and resolve only after that frame is
   * visible. Concurrent display-wake, shell, and wakeword callbacks share the
   * same operation.
   */
  private ensureEvenHubSessionActive(): Promise<boolean> {
    if (this.evenHubResumePromise) return this.evenHubResumePromise;
    const communicator = this.communicator;
    if (!communicator || this.phase === "charging" || this.phase === "disconnected") {
      return Promise.resolve(false);
    }

    const operation = (async () => {
      await communicator.setG2ScreenOn(true);
      if (!(await communicator.resumeEvenHubSession())) {
        return false;
      }
      // Resume first: setScreenBlanked(false) then recomposites retained state
      // as the desired first frame for the fresh layout.
      await communicator.setScreenBlanked(false);
      const ready = await communicator.awaitEvenHubSessionReady(EVENHUB_WAKE_READY_TIMEOUT_MS);
      if (ready && this.communicator === communicator) {
        this.evenHubSessionSuspended = false;
      }
      return ready;
    })();
    this.evenHubResumePromise = operation;
    const clearOperation = () => {
      if (this.evenHubResumePromise === operation) {
        this.evenHubResumePromise = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private desiredFaceclawWakeLeaseState(): boolean {
    // The same firmware lease owns two stock wake paths: deferred dashboard
    // launch while EvenHub is suspended, and suppression of the stock Even AI
    // foreground app when Faceclaw handles the glasses wakeword. Without the
    // latter, Even AI displaces EvenHub before our first wake frame can ACK.
    return (
      this.faceclawWakeLeaseSupported &&
      (suspendEvenHubWhenScreenOffSetting.get() || wakeWordActionSetting.get() !== "off")
    );
  }

  private async syncFaceclawWakeLease(
    communicator = this.communicator,
    force = false,
  ): Promise<boolean> {
    if (!communicator || communicator !== this.communicator) return false;
    const enabled = this.desiredFaceclawWakeLeaseState();
    if (!force && this.faceclawWakeLeaseState === enabled) return true;
    const applied = await communicator.setFaceclawWakeLeaseEnabled(enabled);
    if (this.communicator === communicator) {
      this.faceclawWakeLeaseState = applied || !enabled ? enabled : null;
    }
    return applied;
  }

  private syncEvenHubScreenOffSetting(): void {
    void this.syncFaceclawWakeLease().catch((error) => {
      this.appendLog(`wake takeover lease sync failed: ${this.formatError(error)}`);
    });
    if (suspendEvenHubWhenScreenOffSetting.get() && !shell.isScreenOn()) {
      this.scheduleEvenHubSuspend();
      return;
    }

    this.cancelEvenHubSuspendTimer();
    if (!this.evenHubSessionSuspended) return;

    // Turning the experiment off restores the legacy all-black page even if
    // the screen remains asleep.
    const communicator = this.communicator;
    if (!communicator) return;
    void communicator
      .resumeEvenHubSession()
      .then((resumed) => {
        if (resumed && this.communicator === communicator) {
          this.evenHubSessionSuspended = false;
        }
      })
      .catch((error) => {
        this.appendLog(`EvenHub resume failed: ${this.formatError(error)}`);
      });
  }

  private scheduleEvenHubSuspend(): void {
    this.cancelEvenHubSuspendTimer();
    if (
      !suspendEvenHubWhenScreenOffSetting.get() ||
      shell.isScreenOn() ||
      this.phase !== "connected" ||
      !this.communicator ||
      this.evenHubSessionSuspended
    ) {
      return;
    }

    const communicator = this.communicator;
    this.evenHubSuspendTimer = setTimeout(() => {
      this.evenHubSuspendTimer = null;
      if (
        !suspendEvenHubWhenScreenOffSetting.get() ||
        shell.isScreenOn() ||
        this.phase !== "connected" ||
        this.communicator !== communicator
      ) {
        return;
      }

      void (async () => {
        if (this.faceclawWakeLeaseSupported) {
          // Refresh immediately before teardown so the first suspended wake
          // cannot race an old lease's expiry.
          const leaseReady = await this.syncFaceclawWakeLease(communicator, true);
          if (!leaseReady) {
            this.appendLog("EvenHub suspend deferred; wake takeover lease was not delivered");
            this.scheduleEvenHubSuspend();
            return;
          }
        }
        if (
          !suspendEvenHubWhenScreenOffSetting.get() ||
          shell.isScreenOn() ||
          this.phase !== "connected" ||
          this.communicator !== communicator
        ) {
          return;
        }
        this.evenHubSessionSuspended = true;
        return communicator.suspendEvenHubSession();
      })()
        .then((suspended) => {
          if (suspended === undefined) return;
          if (suspended) {
            this.appendLog("EvenHub session suspended while screen is off");
            return;
          }
          if (this.communicator !== communicator || shell.isScreenOn()) return;
          this.evenHubSessionSuspended = false;
          this.scheduleEvenHubSuspend();
        })
        .catch((error) => {
          if (this.communicator === communicator) {
            this.evenHubSessionSuspended = false;
            this.appendLog(`EvenHub suspend failed: ${this.formatError(error)}`);
            this.scheduleEvenHubSuspend();
          }
        });
    }, EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS);
  }

  private cancelEvenHubSuspendTimer(): void {
    if (this.evenHubSuspendTimer === null) return;
    clearTimeout(this.evenHubSuspendTimer);
    this.evenHubSuspendTimer = null;
  }

  private pushFirmwareDebugFlags(): void {
    if (!this.communicator) return;
    void this.communicator
      .setFirmwareDebugFlags(firmwareDebugFlagsSetting.get())
      .catch(() => {});
  }

  /**
   * Push the brightness setting to the glasses. Deduped TS-side (the change
   * listener fires for every setting, and each push queues a real BLE
   * message); `force` skips the dedup so a fresh connection always gets the
   * configured value regardless of what the firmware restored.
   */
  private pushBrightness(force = false): void {
    if (!this.communicator) return;
    const value = brightnessSetting.get();
    if (!force && value === this.lastPushedBrightness) return;
    this.lastPushedBrightness = value;
    const level = brightnessSettingToLevel(value);
    void this.communicator.setBrightness(level === null, level ?? 0).catch(() => {});
  }

  /** Save the current composited screen as a 4-bit grayscale PNG. */
  saveScreenshot(): string {
    const path = this.communicator?.saveScreenshot() ?? "";
    this.appendLog(path ? `screenshot saved: ${path}` : "screenshot skipped: not connected");
    return path;
  }

  /**
   * Begin collecting composited frames for an animated-GIF screen recording.
   * Frames are captured at the same points the phone-side preview is
   * refreshed, so the recording matches what the phone display showed.
   */
  startScreenRecording(): void {
    if (this.screenRecordingActive) return;
    const communicator = this.communicator;
    if (!communicator) {
      this.appendLog("screen recording skipped: not connected");
      return;
    }
    communicator.startScreenRecording();
    // Capture the starting frame immediately rather than waiting for the
    // next preview flush.
    communicator.recordScreenFrame();
    this.screenRecordingActive = true;
    this.appendLog("screen recording started");
    this.emit();
  }

  /** Finish the recording and save it as an animated GIF; returns the path or "". */
  stopScreenRecording(): string {
    if (!this.screenRecordingActive) return "";
    this.screenRecordingActive = false;
    let path = "";
    try {
      path = this.communicator?.stopScreenRecording() ?? "";
    } finally {
      this.emit();
    }
    this.appendLog(path ? `screen recording saved: ${path}` : "screen recording discarded: no frames");
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
      screenRecordingActive: this.screenRecordingActive,
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
    this.glassesWorn = null;
    this.glassesLocked = false;
    this.refreshBatteryOptimizationStatus();
    this.refreshEvenAppStatus();
    this.setPhase("connecting");
    this.setStatus("Connecting to the glasses...");
    this.appendLog(
      `Using configured arms: R=${addresses.right} L=${addresses.left}${addresses.ring ? ` ring=${addresses.ring}` : ""}`,
    );

    let communicator: FaceclawCommunicatorBridge | null = null;
    this.faceclawWakeLeaseSupported = false;
    this.faceclawWakeLeaseState = null;
    this.wearNotifySupported = false;
    this.lockSurfaceConfigured = false;
    this.evenHubResumePromise = null;

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
          // A transport reconnect starts with a live EvenHub lifecycle again;
          // if the shell is asleep, begin a fresh five-second grace period.
          this.evenHubSessionSuspended = false;
          // Firmware leases are volatile, and the Java transport may have been
          // rebuilt underneath this long-lived controller. Do not let a cached
          // TypeScript value suppress re-acquisition on the new session.
          this.faceclawWakeLeaseState = null;
          // Push the CFW firmware-debug-flags overlay preference; Java emits the
          // mode-7 control message once the dashboard container is warmed up.
          this.pushFirmwareDebugFlags();
          this.pushBrightness(true);
        }
        if (mappedPhase !== "connected") {
          // A wear snapshot is session-scoped. CFW reports a fresh value when
          // the transport comes back, so do not make lock decisions from a
          // stale pre-disconnect value in the meantime.
          this.glassesWorn = null;
        }
        this.setPhase(mappedPhase);
        this.setStatus(state.status);
        if (mappedPhase === "connected") {
          this.syncEvenHubScreenOffSetting();
          this.ensureWearStateTracking();
        } else if (mappedPhase !== "charging") {
          this.cancelEvenHubSuspendTimer();
          this.evenHubSessionSuspended = false;
        }
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
      this.offWearState = communicator.onWearState((wearing) => {
        this.handleWearState(wearing);
      });
      this.offPhoneLockState = communicator.onPhoneLockState((locked) => {
        this.handlePhoneLockState(locked);
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
      this.offFrameMetrics = communicator.onFrameMetrics(() => {
        if (this.phase === "connected") {
          this.setStatus("Connected.");
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
        const wakeLeaseSupported = info.capabilities
          .trim()
          .split(/\s+/)
          .includes("wakelease");
        const wearNotifySupported = info.capabilities
          .trim()
          .split(/\s+/)
          .includes("wearnotify");
        if (wakeLeaseSupported !== this.faceclawWakeLeaseSupported) {
          this.faceclawWakeLeaseSupported = wakeLeaseSupported;
          this.faceclawWakeLeaseState = null;
          void this.syncFaceclawWakeLease().catch((error) => {
            this.appendLog(`wake takeover lease sync failed: ${this.formatError(error)}`);
          });
        }
        if (wearNotifySupported !== this.wearNotifySupported) {
          this.wearNotifySupported = wearNotifySupported;
          this.ensureWearStateTracking();
        }
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
      await this.configureLockSurface(communicator);
      const foregroundWindowId = shell.foregroundWindow()?.windowId;
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(
          window.surfaceId,
          window.windowId === foregroundWindowId,
          window.heightMode,
        );
      }
      await communicator.start();
      await this.syncLockSurface();
      this.syncEvenHubScreenOffSetting();
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
      this.offWearState?.();
      this.offWearState = null;
      this.offPhoneLockState?.();
      this.offPhoneLockState = null;
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
        await communicator.setFaceclawWakeLeaseEnabled(false).catch(() => false);
        await communicator.close().catch(() => {});
      }
      this.communicator = null;
      this.lockSurfaceConfigured = false;
      this.wearNotifySupported = false;
      this.faceclawWakeLeaseSupported = false;
      this.faceclawWakeLeaseState = null;
      this.evenHubResumePromise = null;
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
    this.offWearState?.();
    this.offWearState = null;
    this.offPhoneLockState?.();
    this.offPhoneLockState = null;
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
    this.lockSurfaceConfigured = false;
    this.evenHubSessionSuspended = false;
    this.evenHubResumePromise = null;

    // The recording's frame store lives in the communicator, so save what has
    // accumulated rather than silently losing it with the connection.
    if (this.screenRecordingActive) {
      this.screenRecordingActive = false;
      try {
        const path = communicator?.stopScreenRecording() ?? "";
        this.appendLog(path ? `screen recording saved: ${path}` : "screen recording discarded: no frames");
      } catch (error) {
        this.appendLog(`screen recording save failed: ${this.formatError(error)}`);
      }
    }

    try {
      const leaseReleased = await communicator?.setFaceclawWakeLeaseEnabled(false).catch((error) => {
        this.appendLog(`wake takeover lease release failed: ${this.formatError(error)}`);
        return false;
      });
      if (leaseReleased === true) {
        this.faceclawWakeLeaseState = false;
      }
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
      this.faceclawWakeLeaseSupported = false;
      this.faceclawWakeLeaseState = null;
      this.wearNotifySupported = false;
      this.setPhase("disconnected");
      this.setStatus("Disconnected.");
      this.appendLog("Disconnected from the glasses.");
    }
  }

  async injectSyntheticRingInput(
    kind: "click" | "double-click" | "scroll-up" | "scroll-down" | "long-press" | "wakeword",
  ): Promise<void> {
    if (kind === "long-press") {
      // Hardware delivers a press event and then a release when the finger
      // lifts; emulate a short hold so the escape-menu countdown never fires.
      await this.handleInputEvent(this.buildSyntheticRingInput("long-press"));
      await this.handleInputEvent(this.buildSyntheticRingInput("long-press-release"));
      return;
    }
    const event = this.buildSyntheticRingInput(kind);
    await this.handleInputEvent(event);
  }

  /** A document arrived via Android's Share intent: open it as a new window. */
  async openSharedTextDocument(text: string): Promise<void> {
    this.appendLog(`shared text document received (${text.length} chars)`);
    if (!shell.isScreenOn()) {
      shell.wake("sidebar");
    }
    this.openTextDocumentWindow("Shared text", text);
  }

  /** Open a text document as its own (closeable, non-singleton) window. */
  private openTextDocumentWindow(title: string, text: string): void {
    const windowId = `files:doc:${this.nextWindowSerial++}`;
    void this.launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createTextDocumentWindow(windowId, title, text, options),
    ).catch((error) => {
      this.appendLog(`text document window failed: ${this.formatError(error)}`);
    });
  }

  /** Open an image file as its own (closeable, non-singleton) window. */
  private openImageDocumentWindow(title: string, path: string): void {
    const windowId = `files:doc:${this.nextWindowSerial++}`;
    void this.launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createImageDocumentWindow(windowId, title, path, options),
    ).catch((error) => {
      this.appendLog(`image window failed: ${this.formatError(error)}`);
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
      if (this.glassesLocked) {
        const ringDoubleTap =
          inputEvent.type === "double-click" &&
          event.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING;
        const suspendedDisplayWake = inputEvent.type === "display-wake";
        if (ringDoubleTap || suspendedDisplayWake) {
          if (shell.isScreenOn()) {
            // A normal ring double-tap still turns the locked display off.
            // display-wake is directional and can only turn an off display on.
            if (ringDoubleTap) shell.sleep();
          } else {
            shell.wake("sidebar");
            const ready = await this.ensureEvenHubSessionActive();
            if (!ready) {
              this.appendLog("EvenHub wake barrier timed out for locked display");
            }
          }
          frameTimings.finishFrame(frameId, "locked display toggled");
          frameOwned = true;
        }
        return;
      }
      const wakewordShouldWake =
        event.kind === "even-ai" &&
        event.eventType === EvenAIStatus.EVEN_AI_WAKE_UP &&
        wakeWordActionSetting.get() !== "off";
      const displayShouldWake = event.kind === "display-wake";
      let shellPreWoke = false;
      if (wakewordShouldWake || displayShouldWake) {
        if (!shell.isScreenOn()) {
          shellPreWoke = shell.wake("sidebar");
        }
        if (shellPreWoke || this.evenHubSessionSuspended || this.evenHubResumePromise) {
          const ready = await this.ensureEvenHubSessionActive();
          if (!ready) {
            this.appendLog(`EvenHub wake barrier timed out for ${event.kind}`);
          }
        }
      }
      frameTimings.spanStart(frameId, "handle-input");
      let outcome: ShellInputOutcome;
      try {
        // The shell consumes its reserved gestures and forwards the rest to
        // the focused window; the outcome says which surfaces changed.
        outcome = await shell.receiveInput(inputEvent, frameId);
      } finally {
        frameTimings.spanEnd(frameId, "handle-input");
      }
      if (shellPreWoke && !outcome.shell) {
        outcome = { ...outcome, shell: true };
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

  /** Launch or focus the (in-process, singleton) Settings app, optionally on a section. */
  private async launchSettingsApp(section?: string): Promise<void> {
    if (this.settingsApp) {
      if (section) this.settingsApp.focusSection(section);
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
    if (section) settingsApp.focusSection(section);
    shell.registerWindow(settingsApp.window);
    // Configure the surface before foregrounding so the first frame has
    // somewhere to land.
    await this.configureWindowSurface(SETTINGS_SURFACE_ID, false, settingsApp.window.heightMode);
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
    await this.configureWindowSurface(surfaceId, false, app.window.heightMode);
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
    } else if (appId === "navigate") {
      worker = new Worker("../workers/navigate-app.worker");
    } else if (appId === "blocks") {
      worker = new Worker("../workers/blocks-app.worker");
    } else if (appId === "minesweeper") {
      worker = new Worker("../workers/minesweeper-app.worker");
    } else if (appId === "freecell") {
      worker = new Worker("../workers/freecell-app.worker");
    } else if (appId === "pinball") {
      worker = new Worker("../workers/pinball-app.worker");
    } else {
      return null;
    }
    const host = new WorkerAppHost({
      appId,
      worker,
      configureSurface: (surfaceId, visible, heightMode) =>
        this.configureWindowSurface(surfaceId, visible, heightMode),
      setSurfaceVisible: (surfaceId, visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: (surfaceId) => this.removeWindowSurface(surfaceId),
      requestShellRender: () => this.requestShellRender(),
      openSettings: (section) => {
        void this.launchSettingsApp(section).catch((error) => {
          this.appendLog(`settings launch failed: ${this.formatError(error)}`);
        });
      },
    });
    this.appHosts.set(appId, host);
    return host;
  }

  /** Save which apps are open (and which is foreground) for restoreOpenApps. */
  private persistOpenApps(): void {
    if (!this.openAppsRestored || this.suppressOpenAppsPersist) return;
    const open: string[] = [];
    for (const window of shell.getWindows()) {
      if (window.appId === "launcher") continue;
      if (!open.includes(window.appId)) open.push(window.appId);
    }
    savePersistedOpenApps({ open, foreground: shell.foregroundWindow()?.appId ?? null });
  }

  /**
   * Reopen the apps that were open when the app last ran — a development
   * convenience so installing a new build restores the working set. Shallow by
   * design: apps relaunch fresh (no within-app state), and multi-window apps
   * reopen only their primary window. Runs once, on reaching the main page;
   * windows opened here get compositor surfaces at connect like any launch.
   */
  async restoreOpenApps(): Promise<void> {
    if (this.openAppsRestored) return;
    this.openAppsRestored = true;
    const saved = loadPersistedOpenApps();
    if (!saved.open.length) return;
    const known = new Set(LAUNCHER_APPS.map((app) => app.appId));
    this.suppressOpenAppsPersist = true;
    try {
      for (const appId of saved.open) {
        if (!known.has(appId)) continue;
        try {
          await this.launchApp(appId);
        } catch (error) {
          this.appendLog(`restore of ${appId} failed: ${this.formatError(error)}`);
        }
      }
      const foreground = saved.foreground
        ? shell.getWindows().find((window) => window.appId === saved.foreground)
        : undefined;
      if (foreground) shell.focusWindow(foreground.windowId);
    } finally {
      this.suppressOpenAppsPersist = false;
    }
    // Re-save the canonical post-restore state (drops apps that failed to open).
    this.persistOpenApps();
    this.requestShellRender();
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
    if (appId === "files") {
      await this.launchInProcessApp(FILES_WINDOW_ID, FILES_SURFACE_ID, (options) =>
        createFilesAppWindow({
          ...options,
          openDocumentWindow: (title, text) => this.openTextDocumentWindow(title, text),
          openImageWindow: (title, path) => this.openImageDocumentWindow(title, path),
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
    if (appId === "blocks") {
      const existing = shell.getWindows().find((window) => window.appId === "blocks");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({ windowId: "blocks:main", title: "Blocks", iconLetter: "B", icon: "l-piece", focus: true });
      this.appendLog("launched blocks:main");
      return;
    }
    if (appId === "minesweeper") {
      const existing = shell.getWindows().find((window) => window.appId === "minesweeper");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({
        windowId: "minesweeper:main",
        title: "Minesweeper",
        iconLetter: "M",
        icon: "bomb",
        focus: true,
      });
      this.appendLog("launched minesweeper:main");
      return;
    }
    if (appId === "freecell") {
      const existing = shell.getWindows().find((window) => window.appId === "freecell");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({
        windowId: "freecell:main",
        title: "Freecell",
        iconLetter: "F",
        icon: "spade",
        focus: true,
      });
      this.appendLog("launched freecell:main");
      return;
    }
    if (appId === "pinball") {
      const existing = shell.getWindows().find((window) => window.appId === "pinball");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({
        windowId: "pinball:main",
        title: "Pinball",
        iconLetter: "P",
        icon: "pinball",
        focus: true,
      });
      this.appendLog("launched pinball:main");
      return;
    }
    if (appId === "navigate") {
      // Navigation needs precise location; prompt on the phone while the
      // window opens (the worker can't show permission dialogs).
      void ensureFineLocationPermission().catch(() => {});
      const existing = shell.getWindows().find((window) => window.appId === "navigate");
      if (existing) {
        shell.focusWindow(existing.windowId);
        this.requestShellRender();
        return;
      }
      host.openWindow({ windowId: "navigate:main", title: "Navigate", iconLetter: "N", icon: "map", focus: true });
      this.appendLog("launched navigate:main");
      return;
    }
  }

  /** Create/refresh a window surface on the compositor, if connected. */
  private async configureWindowSurface(
    surfaceId: string,
    visible: boolean,
    heightMode: WindowHeightMode = "min",
  ): Promise<void> {
    const communicator = this.communicator;
    if (!communicator) return;
    await communicator.configureSurface(surfaceId, {
      ...appViewportRect(heightMode),
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
    const woke = shell.wake("sidebar");
    if (woke) {
      const ready = await this.ensureEvenHubSessionActive();
      if (!ready) {
        this.appendLog("EvenHub wake barrier timed out for phone wakeword");
      }
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
    this.cancelEvenHubSuspendTimer();
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
    // The recorder captures at the same cadence the phone-side preview is
    // refreshed, so the GIF matches what the phone display showed.
    if (this.screenRecordingActive) {
      this.communicator.recordScreenFrame();
    }
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

  private buildSyntheticRingInput(
    kind:
      | "click"
      | "double-click"
      | "scroll-up"
      | "scroll-down"
      | "long-press"
      | "long-press-release"
      | "wakeword",
  ): RawInputEvent {
    const frameId = frameTimings.startFrame(`input:synthetic:${kind}`);
    switch (kind) {
      case "wakeword":
        // Same event the glasses report for the spoken wakeword (sid 0x07).
        return {
          kind: "even-ai",
          containerName: "",
          eventType: EvenAIStatus.EVEN_AI_WAKE_UP,
          eventSource: 0,
          systemExitReasonCode: 0,
          frameId,
        };
      case "long-press":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.RING_LONG_PRESS_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
      case "long-press-release":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.RING_LONG_PRESS_RELEASE_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
          frameId,
        };
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
