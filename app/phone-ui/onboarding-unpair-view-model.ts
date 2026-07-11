import { Frame, Observable } from "@nativescript/core";

import { openEvenAppSettings } from "../native/even-app-conflict";

export class OnboardingUnpairViewModel extends Observable {
  onOpenEvenAppSettingsTap(): void {
    openEvenAppSettings();
  }

  onContinueTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/onboarding-firmware-check-page" });
  }

  onBackTap(): void {
    const frame = Frame.topmost();
    if (frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    frame?.navigate({
      moduleName: "phone-ui/config-page",
      context: { onboarding: true },
      clearHistory: true,
    });
  }
}
