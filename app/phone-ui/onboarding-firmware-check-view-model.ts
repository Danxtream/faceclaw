import { Frame, Observable } from "@nativescript/core";

import { ensureBlePermissions } from "../g2/android-permissions";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import { classifyOnboardingFirmware, FLASHABLE_STOCK_VERSION_TEXT } from "../g2/firmware-compat";
import { DeviceInfoProbe, DeviceInfoState } from "../native/device-info-probe";
import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";

type CheckPhase = "checking" | "custom" | "flashable" | "newer" | "error";

export class OnboardingFirmwareCheckViewModel extends Observable {
  private _phase: CheckPhase = "checking";
  private _headline = "Checking Firmware";
  private _status = "";
  private _busy = true;

  private probeInstance: DeviceInfoProbe | null = null;

  constructor() {
    super();
    void this.check();
  }

  // --- observable properties -------------------------------------------------

  get headline(): string {
    return this._headline;
  }

  set headline(value: string) {
    if (this._headline !== value) {
      this._headline = value;
      this.notifyPropertyChange("headline", value);
    }
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

  get busy(): boolean {
    return this._busy;
  }

  set busy(value: boolean) {
    if (this._busy !== value) {
      this._busy = value;
      this.notifyPropertyChange("busy", value);
      this.notifyPropertyChange("busyVisibility", this.busyVisibility);
    }
  }

  get busyVisibility(): "visible" | "collapse" {
    return this._busy ? "visible" : "collapse";
  }

  get primaryLabel(): string {
    switch (this._phase) {
      case "custom":
        return "Finish";
      case "flashable":
        return "Install Firmware";
      case "newer":
        return "Proceed Anyway";
      case "error":
        return "Retry";
      default:
        return "";
    }
  }

  get secondaryLabel(): string {
    return "Back";
  }

  get primaryVisibility(): "visible" | "collapse" {
    return this.primaryLabel ? "visible" : "collapse";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    // Once the custom firmware is confirmed present, Finish is the only action.
    return this._phase === "custom" ? "collapse" : "visible";
  }

  // --- button handlers -------------------------------------------------------

  onPrimaryTap(): void {
    switch (this._phase) {
      case "custom":
        this.finish();
        return;
      case "flashable":
      case "newer":
        this.goToFlashing();
        return;
      case "error":
        void this.check();
        return;
      default:
        return;
    }
  }

  onSecondaryTap(): void {
    this.disposeProbe();
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({ moduleName: "phone-ui/onboarding-unpair-page", clearHistory: true });
  }

  // --- probe flow ------------------------------------------------------------

  private async check(): Promise<void> {
    if (!global.isAndroid) {
      this.toError("Firmware checking is only available on Android.");
      return;
    }
    this.setPhase("checking");
    this.headline = "Checking Firmware";
    this.busy = true;
    this.status = "Connecting to your glasses to read their firmware version...";

    try {
      await ensureBlePermissions();
      const stored = loadDeviceAddresses();
      if (!isValidMacAddress(stored.right)) {
        this.toError("No glasses address is configured. Go back and set the device addresses.");
        return;
      }

      this.disposeProbe();
      const probe = new DeviceInfoProbe(stored.right);
      this.probeInstance = probe;
      probe.onStateChange((state) => this.reportProbeState(state));

      const info = await probe.run();
      this.probeInstance = null;

      const { kind, version } = classifyOnboardingFirmware(info);
      this.applyClassification(kind, version, info.capabilities.trim());
    } catch (error) {
      this.probeInstance = null;
      this.toError(this.formatError(error));
    }
  }

  private reportProbeState(state: DeviceInfoState): void {
    if (state === "connecting") {
      this.status = "Connecting to your glasses...";
    } else if (state === "querying") {
      this.status = "Reading the firmware version...";
    }
  }

  private applyClassification(kind: string, version: string, capabilities: string): void {
    this.busy = false;
    switch (kind) {
      case "custom":
        this.setPhase("custom");
        this.headline = "Custom Firmware Detected";
        this.status =
          `Your glasses already run Faceclaw's custom firmware${version ? ` (version ${version})` : ""}` +
          `${capabilities ? `, extensions: ${capabilities}` : ""}. No flashing needed — you're all set.`;
        break;
      case "flashable":
        this.setPhase("flashable");
        this.headline = "Ready to Install";
        this.status =
          `Your glasses run stock firmware ${version}. This is compatible — tap Install Firmware to flash ` +
          "Faceclaw's custom firmware.";
        break;
      case "newer":
        this.setPhase("newer");
        this.headline = "Unrecognized Firmware";
        this.status =
          `Your glasses run stock firmware ${version}, which is newer than the ${FLASHABLE_STOCK_VERSION_TEXT} ` +
          "release Faceclaw's custom image is built from. Flashing may not work correctly and carries extra risk. " +
          "You can proceed anyway, or go back.";
        break;
      default:
        // "unknown" — connected but no version. Treat as a probe failure (hard block).
        this.toError(
          "Connected, but couldn't read a firmware version. Make sure the glasses are on and the Even app is " +
            "disconnected, then retry.",
        );
        break;
    }
  }

  // --- terminal actions ------------------------------------------------------

  private goToFlashing(): void {
    this.disposeProbe();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-flash-page",
      context: { mode: "install", fromOnboarding: true },
    });
  }

  private finish(): void {
    setPreviewOnlyMode(false);
    setOnboardingCompleted(true);
    this.disposeProbe();
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/main-page",
      clearHistory: true,
    });
  }

  private toError(message: string): void {
    this.disposeProbe();
    this.busy = false;
    this.status = message;
    this.setPhase("error");
    this.headline = "Couldn't Check Firmware";
  }

  private setPhase(phase: CheckPhase): void {
    if (this._phase !== phase) {
      this._phase = phase;
      this.notifyPropertyChange("phase", phase);
    }
    this.notifyPropertyChange("primaryLabel", this.primaryLabel);
    this.notifyPropertyChange("secondaryLabel", this.secondaryLabel);
    this.notifyPropertyChange("primaryVisibility", this.primaryVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
  }

  private disposeProbe(): void {
    if (this.probeInstance) {
      try {
        this.probeInstance.close();
      } catch {
        // ignore
      }
      this.probeInstance = null;
    }
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    return raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  }
}
