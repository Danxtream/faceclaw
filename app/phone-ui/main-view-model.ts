import { Application, Frame, ImageSource, Observable, Screen } from "@nativescript/core";
import { dashboardController } from "../g2/dashboard-controller";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";
import {
  formatVideoTime,
  parseVideoTime,
  videoPlaybackState,
  type VideoPlaybackSnapshot,
} from "../apps/video/video-playback-state";

const LENS_ASPECT_RATIO = G2_LENS_WIDTH / G2_LENS_HEIGHT;

type LayoutOrientation = "portrait" | "landscape";

export class MainViewModel extends Observable {
  private _status = "Disconnected.";
  private _log = "";
  private _displayPreview: ImageSource | null = null;
  private _displayPreviewMessage = "";
  private _layoutOrientation: LayoutOrientation = this.readLayoutOrientation();
  private _activeTextSettingId: string | null = null;
  private _activeTextSettingTitle = "";
  private _activeTextSettingValue = "";
  private _evenAppConflictMessage = "";
  private _evenAppConflictWarningVisible = false;
  private _firmwareWarningMessage = "";
  private _firmwareWarningVisible = false;
  private _screenRecordingActive = false;
  private _batteryOptimizationWarningVisible = false;
  private _showLog = false;
  private _phase: "disconnected" | "connecting" | "connected" | "charging" | "disconnecting" = "disconnected";
  private _videoActive = false;
  private _videoPlaying = false;
  private _videoPositionText = "0:00:00";
  private _videoDurationText = "0:00:00";
  private _videoSeekSeconds = 0;
  private _videoDurationSeconds = 0;
  private _videoStatus = "";
  private _videoTimeEntry = "";
  private videoTimeEditing = false;
  private videoSeekPreviewMs: number | null = null;
  private videoScrubTimer: ReturnType<typeof setTimeout> | null = null;
  private videoPlaybackUnsubscribe: (() => void) | null = null;

  constructor() {
    super();
    dashboardController.subscribe((snapshot) => {
      this.status = snapshot.status;
      this.log = snapshot.log;
      this.displayPreview = snapshot.displayPreview;
      this.displayPreviewMessage = snapshot.displayPreviewMessage;
      this.phase = snapshot.phase;
      this.activeTextSettingId = snapshot.activeTextSettingId;
      this.activeTextSettingTitle = snapshot.activeTextSettingTitle;
      this.activeTextSettingValue = snapshot.activeTextSettingValue;
      this.evenAppConflictMessage = snapshot.evenAppConflictMessage;
      this.evenAppConflictWarningVisible = snapshot.evenAppConflictWarningVisible;
      this.firmwareWarningMessage = snapshot.firmwareWarningMessage;
      this.firmwareWarningVisible = snapshot.firmwareWarningVisible;
      this.screenRecordingActive = snapshot.screenRecordingActive;
      this.batteryOptimizationWarningVisible = snapshot.batteryOptimizationWarningVisible;
    });
    this.videoPlaybackUnsubscribe = videoPlaybackState.subscribe((snapshot) => {
      this.applyVideoSnapshot(snapshot);
    });
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status !== value) {
      this._status = value;
      this.notifyPropertyChange("status", value);
    }
  }

  get log(): string {
    return this._log;
  }

  set log(value: string) {
    if (this._log !== value) {
      this._log = value;
      this.notifyPropertyChange("log", value);
    }
  }

  get displayPreview(): ImageSource | null {
    return this._displayPreview;
  }

  set displayPreview(value: ImageSource | null) {
    if (this._displayPreview !== value) {
      this._displayPreview = value;
      this.notifyPropertyChange("displayPreview", value);
      this.notifyPropertyChange("hasDisplayPreview", this.hasDisplayPreview);
      this.notifyPropertyChange("displayPreviewVisibility", this.displayPreviewVisibility);
    }
  }

  get displayPreviewMessage(): string {
    return this._displayPreviewMessage;
  }

  set displayPreviewMessage(value: string) {
    if (this._displayPreviewMessage !== value) {
      this._displayPreviewMessage = value;
      this.notifyPropertyChange("displayPreviewMessage", value);
      this.notifyPropertyChange("displayPreviewMessageVisibility", this.displayPreviewMessageVisibility);
      this.notifyPropertyChange("displayPreviewVisibility", this.displayPreviewVisibility);
    }
  }

  get hasDisplayPreview(): boolean {
    return this._displayPreview !== null;
  }

  /**
   * The preview and its stand-in message are mutually exclusive and occupy the
   * same box, so the form doesn't reflow when one replaces the other.
   */
  get displayPreviewVisibility(): "visible" | "collapse" {
    return this.hasDisplayPreview && !this._displayPreviewMessage ? "visible" : "collapse";
  }

  get displayPreviewMessageVisibility(): "visible" | "collapse" {
    return this._displayPreviewMessage ? "visible" : "collapse";
  }

  get displayPreviewHeight(): number {
    return Screen.mainScreen.widthDIPs / LENS_ASPECT_RATIO;
  }

  get landscapeDisplayPreviewWidth(): number {
    return Math.floor(this.landscapeDisplayPreviewHeight * LENS_ASPECT_RATIO);
  }

  get landscapeDisplayPreviewHeight(): number {
    // Height keeps the vertical footprint the preview had at the old 2:1
    // aspect; the width is derived from it, so a wider lens aspect can't
    // grow the preview past the side panel.
    const screenWidth = Screen.mainScreen.widthDIPs;
    const sidePanelWidth = 260;
    const availableWidth = Math.max(240, Math.floor(screenWidth - sidePanelWidth - 56));
    return Math.floor(availableWidth / 2);
  }

  get portraitLayoutVisibility(): "visible" | "collapse" {
    return this._layoutOrientation === "portrait" ? "visible" : "collapse";
  }

  get landscapeLayoutVisibility(): "visible" | "collapse" {
    return this._layoutOrientation === "landscape" ? "visible" : "collapse";
  }

  refreshLayoutMetrics(): void {
    const nextOrientation = this.readLayoutOrientation();
    if (this._layoutOrientation !== nextOrientation) {
      this._layoutOrientation = nextOrientation;
      this.notifyPropertyChange("portraitLayoutVisibility", this.portraitLayoutVisibility);
      this.notifyPropertyChange("landscapeLayoutVisibility", this.landscapeLayoutVisibility);
    }
    this.notifyPropertyChange("displayPreviewHeight", this.displayPreviewHeight);
    this.notifyPropertyChange("landscapeDisplayPreviewWidth", this.landscapeDisplayPreviewWidth);
    this.notifyPropertyChange("landscapeDisplayPreviewHeight", this.landscapeDisplayPreviewHeight);
  }

  get showLog(): boolean {
    return this._showLog;
  }

  set showLog(value: boolean) {
    if (this._showLog !== value) {
      this._showLog = value;
      this.notifyPropertyChange("showLog", value);
      this.notifyPropertyChange("showLogVisibility", this.showLogVisibility);
      this.notifyPropertyChange("showLogMenuLabel", this.showLogMenuLabel);
    }
  }

  get showLogVisibility(): "visible" | "collapse" {
    return this._showLog ? "visible" : "collapse";
  }

  get showLogMenuLabel(): string {
    return this._showLog ? "Hide Log" : "Show Log";
  }

  get activeTextSettingId(): string | null {
    return this._activeTextSettingId;
  }

  set activeTextSettingId(value: string | null) {
    if (this._activeTextSettingId !== value) {
      this._activeTextSettingId = value;
      this.notifyPropertyChange("activeTextSettingId", value);
      this.notifyPropertyChange("textSettingEditorVisibility", this.textSettingEditorVisibility);
      this.notifyPropertyChange("isTextSettingEditorActive", this.isTextSettingEditorActive);
    }
  }

  get activeTextSettingTitle(): string {
    return this._activeTextSettingTitle;
  }

  set activeTextSettingTitle(value: string) {
    if (this._activeTextSettingTitle !== value) {
      this._activeTextSettingTitle = value;
      this.notifyPropertyChange("activeTextSettingTitle", value);
    }
  }

  get activeTextSettingValue(): string {
    return this._activeTextSettingValue;
  }

  set activeTextSettingValue(value: string) {
    if (this._activeTextSettingValue !== value) {
      this._activeTextSettingValue = value;
      this.notifyPropertyChange("activeTextSettingValue", value);
    }
  }

  get isTextSettingEditorActive(): boolean {
    return this._activeTextSettingId !== null;
  }

  get textSettingEditorVisibility(): "visible" | "collapse" {
    return this.isTextSettingEditorActive ? "visible" : "collapse";
  }

  get evenAppConflictMessage(): string {
    return this._evenAppConflictMessage;
  }

  set evenAppConflictMessage(value: string) {
    if (this._evenAppConflictMessage !== value) {
      this._evenAppConflictMessage = value;
      this.notifyPropertyChange("evenAppConflictMessage", value);
    }
  }

  get evenAppConflictWarningVisible(): boolean {
    return this._evenAppConflictWarningVisible;
  }

  set evenAppConflictWarningVisible(value: boolean) {
    if (this._evenAppConflictWarningVisible !== value) {
      this._evenAppConflictWarningVisible = value;
      this.notifyPropertyChange("evenAppConflictWarningVisible", value);
      this.notifyPropertyChange("evenAppConflictWarningVisibility", this.evenAppConflictWarningVisibility);
    }
  }

  get evenAppConflictWarningVisibility(): "visible" | "collapse" {
    return this._evenAppConflictWarningVisible ? "visible" : "collapse";
  }

  get firmwareWarningMessage(): string {
    return this._firmwareWarningMessage;
  }

  set firmwareWarningMessage(value: string) {
    if (this._firmwareWarningMessage !== value) {
      this._firmwareWarningMessage = value;
      this.notifyPropertyChange("firmwareWarningMessage", value);
    }
  }

  get firmwareWarningVisible(): boolean {
    return this._firmwareWarningVisible;
  }

  set firmwareWarningVisible(value: boolean) {
    if (this._firmwareWarningVisible !== value) {
      this._firmwareWarningVisible = value;
      this.notifyPropertyChange("firmwareWarningVisible", value);
      this.notifyPropertyChange("firmwareWarningVisibility", this.firmwareWarningVisibility);
    }
  }

  get firmwareWarningVisibility(): "visible" | "collapse" {
    return this._firmwareWarningVisible ? "visible" : "collapse";
  }

  get screenRecordingActive(): boolean {
    return this._screenRecordingActive;
  }

  set screenRecordingActive(value: boolean) {
    if (this._screenRecordingActive !== value) {
      this._screenRecordingActive = value;
      this.notifyPropertyChange("screenRecordingActive", value);
      this.notifyPropertyChange("stopRecordingButtonVisibility", this.stopRecordingButtonVisibility);
    }
  }

  get stopRecordingButtonVisibility(): "visible" | "collapse" {
    return this._screenRecordingActive ? "visible" : "collapse";
  }

  onTakeScreenshotTap(): void {
    try {
      dashboardController.saveScreenshot();
    } catch (error) {
      console.error("screenshot failed", error);
    }
  }

  onRecordScreenTap(): void {
    try {
      dashboardController.startScreenRecording();
    } catch (error) {
      console.error("screen recording start failed", error);
    }
  }

  onStopRecordingTap(): void {
    try {
      dashboardController.stopScreenRecording();
    } catch (error) {
      console.error("screen recording stop failed", error);
    }
  }

  get batteryOptimizationWarningVisible(): boolean {
    return this._batteryOptimizationWarningVisible;
  }

  set batteryOptimizationWarningVisible(value: boolean) {
    if (this._batteryOptimizationWarningVisible !== value) {
      this._batteryOptimizationWarningVisible = value;
      this.notifyPropertyChange("batteryOptimizationWarningVisible", value);
      this.notifyPropertyChange("batteryOptimizationWarningVisibility", this.batteryOptimizationWarningVisibility);
    }
  }

  get batteryOptimizationWarningVisibility(): "visible" | "collapse" {
    return this._batteryOptimizationWarningVisible ? "visible" : "collapse";
  }

  onAllowBackgroundUsageTap(): void {
    dashboardController.requestBatteryOptimizationExemption();
  }

  get phase(): "disconnected" | "connecting" | "connected" | "charging" | "disconnecting" {
    return this._phase;
  }

  set phase(value: "disconnected" | "connecting" | "connected" | "charging" | "disconnecting") {
    if (this._phase !== value) {
      this._phase = value;
      this.notifyPropertyChange("phase", value);
      this.notifyPropertyChange("buttonLabel", this.buttonLabel);
      this.notifyPropertyChange("canRun", this.canRun);
    }
  }

  get buttonLabel(): string {
    switch (this.phase) {
      case "connecting":
        return "Connecting...";
      case "connected":
      case "charging":
        return "Disconnect";
      case "disconnecting":
        return "Disconnecting...";
      default:
        return "Connect";
    }
  }

  get canRun(): boolean {
    return this.phase !== "connecting" && this.phase !== "disconnecting";
  }

  async onTap(): Promise<void> {
    if (!this.canRun) return;

    try {
      if (this.phase === "connected" || this.phase === "charging") {
        await dashboardController.disconnect();
      } else {
        await dashboardController.connect();
      }
    } catch (error) {
      const message = this.formatError(error);
      if (!this.status.startsWith("Failed:")) {
        this.status = `Failed: ${message}`;
        this.appendLog(`error: ${message}`);
      }
    }
  }

  /**
   * Try to connect automatically on reaching the main page. No-op if already
   * connecting/connected, or if no glasses are configured (e.g. preview-only
   * users, who have nothing to connect to).
   */
  async autoConnect(): Promise<void> {
    if (this.phase !== "disconnected") return;
    const addresses = loadDeviceAddresses();
    if (!isValidMacAddress(addresses.right) || !isValidMacAddress(addresses.left)) return;
    try {
      await dashboardController.connect();
    } catch {
      // The controller surfaces failures via status/log; nothing to add here.
    }
  }

  onConfigureTap(): void {
    if (!this.canRun) return;
    Frame.topmost()?.navigate("phone-ui/config-page");
  }

  async onInstallFirmwareTap(): Promise<void> {
    await this.openFlashPage("install");
  }

  async onUninstallFirmwareTap(): Promise<void> {
    await this.openFlashPage("uninstall");
  }

  private async openFlashPage(mode: "install" | "uninstall"): Promise<void> {
    // The flasher needs the glasses to itself, so drop the main connection first.
    if (this.phase === "connected" || this.phase === "charging") {
      try {
        await dashboardController.disconnect();
      } catch {
        // proceed anyway; the flash page surfaces any connection trouble
      }
    }
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-flash-page",
      context: { mode, fromOnboarding: false },
    });
  }

  onToggleLogTap(): void {
    this.showLog = !this.showLog;
  }

  onTextSettingTextChange(args: { value?: string; object?: { text?: string } }): void {
    dashboardController.setActiveTextSettingValue(args.object?.text ?? args.value ?? "");
  }

  onTextSettingReturnPress(args: { object?: { text?: string } }): void {
    // Commit the field's actual text at done-time, in case the final
    // keystroke's textChange hadn't landed yet.
    const text = args?.object?.text;
    if (typeof text === "string") {
      dashboardController.setActiveTextSettingValue(text);
    }
    dashboardController.finishActiveTextSettingEdit();
  }

  onOpenEvenAppSettingsTap(): void {
    dashboardController.openEvenAppSettings();
  }

  async onSyntheticUpTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("scroll-up");
  }

  async onSyntheticDownTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("scroll-down");
  }

  async onSyntheticLeftTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("double-click");
  }

  async onSyntheticRightTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("click");
  }

  async onSyntheticLongPressTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("long-press");
  }

  async onSyntheticMicTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("wakeword");
  }

  get videoControlsVisibility(): "visible" | "collapse" {
    return this._videoActive ? "visible" : "collapse";
  }

  get videoPlayPauseLabel(): string {
    return this._videoPlaying ? "Pause" : "Play";
  }

  get videoPositionText(): string {
    return this._videoPositionText;
  }

  set videoPositionText(value: string) {
    this._videoPositionText = String(value ?? "");
  }

  get videoDurationText(): string {
    return this._videoDurationText;
  }

  get videoSeekSeconds(): number {
    return this._videoSeekSeconds;
  }

  set videoSeekSeconds(value: number) {
    this._videoSeekSeconds = Number(value) || 0;
  }

  get videoDurationSeconds(): number {
    return Math.max(1, this._videoDurationSeconds);
  }

  get videoStatus(): string {
    return this._videoStatus;
  }

  get videoTimeEntry(): string {
    return this._videoTimeEntry;
  }

  set videoTimeEntry(value: string) {
    this._videoTimeEntry = String(value ?? "");
  }

  async onVideoPlayPauseTap(): Promise<void> {
    await videoPlaybackState.togglePause();
  }

  async onVideoBack10Tap(): Promise<void> {
    await videoPlaybackState.seekBy(-10_000);
  }

  async onVideoForward10Tap(): Promise<void> {
    await videoPlaybackState.seekBy(10_000);
  }

  async onVideoBack30Tap(): Promise<void> {
    await videoPlaybackState.seekBy(-30_000);
  }

  async onVideoForward30Tap(): Promise<void> {
    await videoPlaybackState.seekBy(30_000);
  }

  async onVideoStopTap(): Promise<void> {
    await videoPlaybackState.stop();
  }

  onVideoTimeFocus(): void {
    this.videoTimeEditing = true;
    this._videoTimeEntry = "";
    this.notifyPropertyChange("videoTimeEntry", this._videoTimeEntry);
  }

  onVideoTimeBlur(): void {
    this.videoTimeEditing = false;
    this._videoTimeEntry = "";
    this.notifyPropertyChange("videoTimeEntry", this._videoTimeEntry);
    this.applyVideoSnapshot(videoPlaybackState.current());
  }

  async onVideoTimeReturnPress(args: { object?: { text?: string; dismissSoftInput?: () => void } }): Promise<void> {
    const text = String(args.object?.text ?? this._videoTimeEntry);
    const parsedPositionMs = parseVideoTime(text);
    this.videoTimeEditing = false;
    this._videoTimeEntry = "";
    this.notifyPropertyChange("videoTimeEntry", this._videoTimeEntry);
    args.object?.dismissSoftInput?.();

    if (parsedPositionMs === null) {
      this.applyVideoSnapshot(videoPlaybackState.current());
      return;
    }

    const snapshot = videoPlaybackState.current();
    const targetMs = Math.max(0, Math.min(snapshot.durationMs, parsedPositionMs));
    this.videoSeekPreviewMs = targetMs;
    this._videoPositionText = formatVideoTime(targetMs);
    this._videoSeekSeconds = targetMs / 1000;
    this._videoStatus = `seeking | ${formatVideoTime(targetMs)} / ${this._videoDurationText}`;
    this.notifyPropertyChange("videoPositionText", this._videoPositionText);
    this.notifyPropertyChange("videoSeekSeconds", this._videoSeekSeconds);
    this.notifyPropertyChange("videoStatus", this._videoStatus);

    try {
      await videoPlaybackState.seekTo(targetMs);
    } finally {
      if (this.videoSeekPreviewMs === targetMs) {
        this.videoSeekPreviewMs = null;
        this.applyVideoSnapshot(videoPlaybackState.current());
      }
    }
  }

  onVideoSeekValueChange(args: { value?: number; object?: { value?: number } }): void {
    if (!this._videoActive) return;
    const seconds = Number(args.value ?? args.object?.value ?? this._videoSeekSeconds);
    if (!Number.isFinite(seconds)) return;

    const targetSeconds = Math.max(0, Math.min(this.videoDurationSeconds, seconds));
    const targetMs = targetSeconds * 1000;
    const currentMs = videoPlaybackState.current().positionMs;
    if (Math.abs(targetMs - currentMs) < 750) return;

    this.videoSeekPreviewMs = targetMs;
    this._videoPositionText = formatVideoTime(targetMs);
    this._videoStatus = `seeking | ${formatVideoTime(targetMs)} / ${this._videoDurationText}`;
    this.notifyPropertyChange("videoPositionText", this._videoPositionText);
    this.notifyPropertyChange("videoStatus", this._videoStatus);

    if (this.videoScrubTimer !== null) clearTimeout(this.videoScrubTimer);
    this.videoScrubTimer = setTimeout(() => {
      this.videoScrubTimer = null;
      void (async () => {
        try {
          await videoPlaybackState.seekTo(targetMs);
        } finally {
          if (this.videoSeekPreviewMs === targetMs) {
            this.videoSeekPreviewMs = null;
            this.applyVideoSnapshot(videoPlaybackState.current());
          }
        }
      })();
    }, 250);
  }

  dispose(): void {
    if (this.videoScrubTimer !== null) {
      clearTimeout(this.videoScrubTimer);
      this.videoScrubTimer = null;
    }
    this.videoPlaybackUnsubscribe?.();
    this.videoPlaybackUnsubscribe = null;
  }

  private applyVideoSnapshot(snapshot: VideoPlaybackSnapshot): void {
    const activeChanged = this._videoActive !== snapshot.active;
    const playingChanged = this._videoPlaying !== snapshot.playing;
    this._videoActive = snapshot.active;
    this._videoPlaying = snapshot.playing;
    this._videoDurationText = formatVideoTime(snapshot.durationMs);
    this._videoDurationSeconds = Math.max(0, snapshot.durationMs / 1000);
    const displayPositionMs = this.videoSeekPreviewMs ?? snapshot.positionMs;
    this._videoSeekSeconds = Math.max(0, displayPositionMs / 1000);
    this._videoStatus =
      this.videoSeekPreviewMs === null
        ? snapshot.status
        : `seeking | ${formatVideoTime(displayPositionMs)} / ${this._videoDurationText}`;
    this._videoPositionText = formatVideoTime(displayPositionMs);
    if (activeChanged) this.notifyPropertyChange("videoControlsVisibility", this.videoControlsVisibility);
    if (playingChanged) this.notifyPropertyChange("videoPlayPauseLabel", this.videoPlayPauseLabel);
    this.notifyPropertyChange("videoPositionText", this._videoPositionText);
    this.notifyPropertyChange("videoDurationText", this._videoDurationText);
    this.notifyPropertyChange("videoSeekSeconds", this._videoSeekSeconds);
    this.notifyPropertyChange("videoDurationSeconds", this.videoDurationSeconds);
    this.notifyPropertyChange("videoStatus", this._videoStatus);
  }

  private appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.log = this.log ? `${this.log}\n[${stamp}] ${line}` : `[${stamp}] ${line}`;
  }

  private readLayoutOrientation(): LayoutOrientation {
    const applicationOrientation = Application.orientation();
    if (applicationOrientation === "landscape" || applicationOrientation === "portrait") {
      return applicationOrientation;
    }
    return Screen.mainScreen.widthDIPs > Screen.mainScreen.heightDIPs ? "landscape" : "portrait";
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
    if (sanitized.length <= 240) return sanitized;
    return `${sanitized.slice(0, 237)}...`;
  }
}
