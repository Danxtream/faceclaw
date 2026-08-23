import { Dialogs, Observable, ObservableArray } from "@nativescript/core";
import { hasAllFilesAccess, listDirectory, requestAllFilesAccess, type DirectoryEntry } from "../native/file-access";
import { ensureG2VideoDirectory, g2VideoDirectoryPath, isUnconvertedG2Mp4 } from "../native/g2-video-library";
import {
  cancelG2VideoConversion,
  getG2VideoConversionSnapshot,
  startG2VideoConversion,
  type VideoConversionSnapshot,
} from "../native/video-converter";

const FPS_CHOICES = [5, 10, 15, 20, 25, 30] as const;

export class VideoConvertViewModel extends Observable {
  readonly files = new ObservableArray<DirectoryEntry>();
  private _status = "Select an MP4 to convert.";
  private _progress = 0;
  private _running = false;
  private _accessGranted = hasAllFilesAccess();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStage = "";

  constructor() {
    super();
    this.refreshFiles();
    this.applySnapshot(getG2VideoConversionSnapshot());
  }

  get status(): string { return this._status; }
  set status(value: string) {
    if (value === this._status) return;
    this._status = value;
    this.notifyPropertyChange("status", value);
  }

  get progress(): number { return this._progress; }
  set progress(value: number) {
    const next = Math.max(0, Math.min(100, Number(value) || 0));
    if (next === this._progress) return;
    this._progress = next;
    this.notifyPropertyChange("progress", next);
  }

  get running(): boolean { return this._running; }
  set running(value: boolean) {
    if (value === this._running) return;
    this._running = value;
    this.notifyPropertyChange("running", value);
    this.notifyPropertyChange("cancelVisibility", this.cancelVisibility);
    this.notifyPropertyChange("listEnabled", this.listEnabled);
  }

  get cancelVisibility(): "visible" | "collapse" {
    return this._running ? "visible" : "collapse";
  }

  get listEnabled(): boolean { return !this._running; }

  get accessGranted(): boolean { return this._accessGranted; }
  set accessGranted(value: boolean) {
    if (value === this._accessGranted) return;
    this._accessGranted = value;
    this.notifyPropertyChange("accessGranted", value);
    this.notifyPropertyChange("accessWarningVisibility", this.accessWarningVisibility);
  }

  get accessWarningVisibility(): "visible" | "collapse" {
    return this._accessGranted ? "collapse" : "visible";
  }

  get emptyVisibility(): "visible" | "collapse" {
    return this.files.length === 0 && this._accessGranted ? "visible" : "collapse";
  }

  onGrantAccessTap(): void {
    requestAllFilesAccess();
  }

  onResume(): void {
    this.accessGranted = hasAllFilesAccess();
    this.refreshFiles();
    this.startPolling();
  }

  onPause(): void {
    this.stopPolling();
  }

  refreshFiles(): void {
    this.accessGranted = hasAllFilesAccess();
    this.files.splice(0);
    if (!this._accessGranted) {
      this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
      return;
    }
    const root = ensureG2VideoDirectory() ?? g2VideoDirectoryPath();
    const entries = listDirectory(root) ?? [];
    for (const entry of entries.filter(isUnconvertedG2Mp4)) this.files.push(entry);
    this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
  }

  async onFileTap(index: number): Promise<void> {
    if (this._running) return;
    const entry = this.files.getItem(index);
    if (!entry) return;

    const choices = FPS_CHOICES.map((fps) => `${fps} FPS`);
    const selected = await Dialogs.action({
      title: `Convert ${entry.name}`,
      message: "Choose the frame rate for this G2 video.",
      cancelButtonText: "Cancel",
      actions: choices,
    });
    const indexOfChoice = choices.indexOf(selected);
    if (indexOfChoice < 0) return;
    const fps = FPS_CHOICES[indexOfChoice]!;

    try {
      startG2VideoConversion(entry.path, fps);
      this.status = `Starting ${entry.name} at ${fps} FPS...`;
      this.running = true;
      this.progress = 0;
      this.startPolling();
    } catch (error) {
      await Dialogs.alert({ title: "Conversion could not start", message: String(error), okButtonText: "OK" });
    }
  }

  onCancelTap(): void {
    if (!this._running) return;
    cancelG2VideoConversion();
    this.status = "Cancelling conversion...";
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.applySnapshot(getG2VideoConversionSnapshot()), 500);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private applySnapshot(snapshot: VideoConversionSnapshot): void {
    const wasRunning = this._running;
    this.running = snapshot.running;
    this.progress = snapshot.progress;
    if (snapshot.message) this.status = snapshot.message;
    else if (snapshot.stage === "idle") this.status = "Select an MP4 to convert.";

    if (snapshot.stage !== this.lastStage) {
      this.lastStage = snapshot.stage;
      if (!snapshot.running && wasRunning) this.refreshFiles();
    }
  }
}
