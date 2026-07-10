import { EventData, Page } from "@nativescript/core";

import { OnboardingViewModel } from "./onboarding-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  // Preserve the step when returning from the flashing page (back navigation
  // re-fires navigatingTo); only build a fresh model on first entry.
  if (!page.bindingContext) {
    page.bindingContext = new OnboardingViewModel();
  }
}
