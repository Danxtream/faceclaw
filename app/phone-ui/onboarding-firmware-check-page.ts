import { EventData, Page } from "@nativescript/core";

import { OnboardingFirmwareCheckViewModel } from "./onboarding-firmware-check-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new OnboardingFirmwareCheckViewModel();
  }
}
