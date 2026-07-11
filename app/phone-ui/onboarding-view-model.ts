import { Frame, Observable } from "@nativescript/core";

import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";

type OnboardingStep = 1 | 2 | 3;

type StepContent = {
  headline: string;
  tagline: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  showLogo: boolean;
  showTagline: boolean;
  showSecondary: boolean;
};

const STEP_CONTENT: Record<OnboardingStep, StepContent> = {
  1: {
    headline: "Faceclaw",
    tagline: "Perching on the faces of giants",
    body: "",
    primaryLabel: "Next",
    secondaryLabel: "",
    showLogo: true,
    showTagline: true,
    showSecondary: false,
  },
  2: {
    headline: "Before You Continue",
    tagline: "",
    body:
      "This unofficial software provides a custom user interface and functionality for the Even Realities G2 smart glasses. It is not created or supported by Even Realities. If this software somehow breaks my headset, this is not Even's fault and is not covered by the hardware's warranty. If this software doesn't break my headset, using this software may void the hardware's warranty anyways, at the sole discretion of Even Realities. This software is a development prototype and may not be relied on for anything important. This software may be broken at any time by software or firmware updates created by Even, and this will not be Even's fault.",
    primaryLabel: "Agree",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
  },
  3: {
    headline: "Custom Firmware Required",
    tagline: "",
    body:
      "Faceclaw only runs on Even Realities G2 glasses that have Faceclaw's custom firmware installed. You have two choices:\n\n• Preview Only — explore Faceclaw's interface on your phone's screen without pairing any glasses. Nothing is written to a headset.\n\n• Flash Firmware — install the custom firmware on your glasses now, then use Faceclaw for real. This connects to your glasses, asks for confirmation on the lens, then downloads and prepares the firmware.\n\nFlashing replaces the official firmware. It may void your warranty and, like any firmware update, carries a risk of bricking the device. You can only be connected to one app at a time, so disconnect the official Even app before flashing (open it, go to Home, select your glasses, open Connection, and press Disconnect).",
    primaryLabel: "Flash Firmware",
    secondaryLabel: "Preview Only",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
  },
};

export class OnboardingViewModel extends Observable {
  private _step: OnboardingStep = 1;

  constructor() {
    super();
    this.publish();
  }

  onPrimaryTap(): void {
    if (this._step === 1) {
      this.setStep(2);
      return;
    }
    if (this._step === 2) {
      this.setStep(3);
      return;
    }
    // Step 3 primary: begin the flashing setup — configure device addresses,
    // then unpair the official app, then check firmware and flash.
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/config-page",
      context: { onboarding: true },
    });
  }

  onSecondaryTap(): void {
    if (this._step === 2) {
      this.setStep(1);
      return;
    }
    if (this._step === 3) {
      // Step 3 secondary: skip flashing, use the on-phone preview only.
      setPreviewOnlyMode(true);
      setOnboardingCompleted(true);
      Frame.topmost()?.navigate({
        moduleName: "phone-ui/main-page",
        clearHistory: true,
      });
    }
  }

  get headline(): string {
    return STEP_CONTENT[this._step].headline;
  }

  get tagline(): string {
    return STEP_CONTENT[this._step].tagline;
  }

  get body(): string {
    return STEP_CONTENT[this._step].body;
  }

  get primaryLabel(): string {
    return STEP_CONTENT[this._step].primaryLabel;
  }

  get secondaryLabel(): string {
    return STEP_CONTENT[this._step].secondaryLabel;
  }

  get showLogo(): boolean {
    return STEP_CONTENT[this._step].showLogo;
  }

  get showTagline(): boolean {
    return STEP_CONTENT[this._step].showTagline;
  }

  get showSecondary(): boolean {
    return STEP_CONTENT[this._step].showSecondary;
  }

  get logoVisibility(): "visible" | "collapse" {
    return this.showLogo ? "visible" : "collapse";
  }

  get taglineVisibility(): "visible" | "collapse" {
    return this.showTagline ? "visible" : "collapse";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    return this.showSecondary ? "visible" : "collapse";
  }

  private setStep(step: OnboardingStep): void {
    if (this._step === step) return;
    this._step = step;
    this.publish();
  }

  private publish(): void {
    this.notifyPropertyChange("headline", this.headline);
    this.notifyPropertyChange("tagline", this.tagline);
    this.notifyPropertyChange("body", this.body);
    this.notifyPropertyChange("primaryLabel", this.primaryLabel);
    this.notifyPropertyChange("secondaryLabel", this.secondaryLabel);
    this.notifyPropertyChange("showLogo", this.showLogo);
    this.notifyPropertyChange("showTagline", this.showTagline);
    this.notifyPropertyChange("showSecondary", this.showSecondary);
    this.notifyPropertyChange("logoVisibility", this.logoVisibility);
    this.notifyPropertyChange("taglineVisibility", this.taglineVisibility);
    this.notifyPropertyChange("secondaryVisibility", this.secondaryVisibility);
  }
}
