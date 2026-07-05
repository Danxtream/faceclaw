import { Application, Frame, ImageSource, Observable, Screen } from "@nativescript/core";
import { dashboardController } from "../g2/dashboard-controller";

type LayoutOrientation = "portrait" | "landscape";

export class MainViewModel extends Observable {
  private _status = "Disconnected.";
  private _log = "";
  private _displayPreview: ImageSource | null = null;
  private _layoutOrientation: LayoutOrientation = this.readLayoutOrientation();
  private _activeTextSettingId: string | null = null;
  private _activeTextSettingTitle = "";
  private _activeTextSettingValue = "";
  private _evenAppConflictMessage = "";
  private _evenAppConflictWarningVisible = false;
  private _firmwareWarningMessage = "";
  private _firmwareWarningVisible = false;
  private _rawScreenshotsEnabled = false;
  private _showLog = false;
  private _phase: "disconnected" | "connecting" | "connected" | "disconnecting" = "disconnected";

  constructor() {
    super();
    dashboardController.subscribe((snapshot) => {
      this.status = snapshot.status;
      this.log = snapshot.log;
      this.displayPreview = snapshot.displayPreview;
      this.phase = snapshot.phase;
      this.activeTextSettingId = snapshot.activeTextSettingId;
      this.activeTextSettingTitle = snapshot.activeTextSettingTitle;
      this.activeTextSettingValue = snapshot.activeTextSettingValue;
      this.evenAppConflictMessage = snapshot.evenAppConflictMessage;
      this.evenAppConflictWarningVisible = snapshot.evenAppConflictWarningVisible;
      this.firmwareWarningMessage = snapshot.firmwareWarningMessage;
      this.firmwareWarningVisible = snapshot.firmwareWarningVisible;
      this.rawScreenshotsEnabled = snapshot.rawScreenshotsEnabled;
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

  get hasDisplayPreview(): boolean {
    return this._displayPreview !== null;
  }

  get displayPreviewVisibility(): "visible" | "collapse" {
    return this.hasDisplayPreview ? "visible" : "collapse";
  }

  get displayPreviewHeight(): number {
    return Screen.mainScreen.widthDIPs / 2;
  }

  get landscapeDisplayPreviewWidth(): number {
    const screenWidth = Screen.mainScreen.widthDIPs;
    const sidePanelWidth = 260;
    return Math.max(240, Math.floor(screenWidth - sidePanelWidth - 56));
  }

  get landscapeDisplayPreviewHeight(): number {
    return Math.floor(this.landscapeDisplayPreviewWidth / 2);
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

  get rawScreenshotsEnabled(): boolean {
    return this._rawScreenshotsEnabled;
  }

  set rawScreenshotsEnabled(value: boolean) {
    if (this._rawScreenshotsEnabled !== value) {
      this._rawScreenshotsEnabled = value;
      this.notifyPropertyChange("rawScreenshotsEnabled", value);
      this.notifyPropertyChange("screenshotButtonVisibility", this.screenshotButtonVisibility);
    }
  }

  get screenshotButtonVisibility(): "visible" | "collapse" {
    return this._rawScreenshotsEnabled ? "visible" : "collapse";
  }

  onScreenshotTap(): void {
    try {
      dashboardController.saveRawDashboardScreenshot();
    } catch (error) {
      console.error("raw screenshot failed", error);
    }
  }

  get phase(): "disconnected" | "connecting" | "connected" | "disconnecting" {
    return this._phase;
  }

  set phase(value: "disconnected" | "connecting" | "connected" | "disconnecting") {
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
      if (this.phase === "connected") {
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

  onConfigureTap(): void {
    if (!this.canRun) return;
    Frame.topmost()?.navigate("phone-ui/config-page");
  }

  onToggleLogTap(): void {
    this.showLog = !this.showLog;
  }

  onSystemCardNameTextChange(args: { value?: string; object?: { text?: string } }): void {
    dashboardController.setSystemCardName(args.object?.text ?? args.value ?? "");
  }

  onTextSettingTextChange(args: { value?: string; object?: { text?: string } }): void {
    dashboardController.setActiveTextSettingValue(args.object?.text ?? args.value ?? "");
  }

  onTextSettingReturnPress(): void {
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
