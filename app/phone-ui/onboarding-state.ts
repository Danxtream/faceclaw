import { ApplicationSettings } from "@nativescript/core";

const ONBOARDING_COMPLETE_KEY = "onboarding.complete";
const PREVIEW_ONLY_KEY = "onboarding.previewOnly";
const WELCOME_SOUND_PENDING_KEY = "onboarding.welcomeSoundPending";

export function hasCompletedOnboarding(): boolean {
  return ApplicationSettings.getBoolean(ONBOARDING_COMPLETE_KEY, false);
}

export function setOnboardingCompleted(completed: boolean): void {
  const wasCompleted = hasCompletedOnboarding();
  ApplicationSettings.setBoolean(ONBOARDING_COMPLETE_KEY, completed);
  // Arm the one-time welcome sound on the first-ever completion (not on the
  // idempotent re-completions that happen when installing from the main menu).
  if (completed && !wasCompleted) {
    setWelcomeSoundPending(true);
  }
}

/**
 * True when onboarding just completed and the celebratory sound hasn't played
 * yet. Consumed (and cleared) on the first successful glasses connection.
 */
export function isWelcomeSoundPending(): boolean {
  return ApplicationSettings.getBoolean(WELCOME_SOUND_PENDING_KEY, false);
}

export function setWelcomeSoundPending(pending: boolean): void {
  ApplicationSettings.setBoolean(WELCOME_SOUND_PENDING_KEY, pending);
}

/**
 * True when the user chose to skip flashing during onboarding and use only the
 * on-phone display preview instead of pairing with glasses. Persisted so the
 * app can adapt later; the flashing path clears it.
 */
export function isPreviewOnlyMode(): boolean {
  return ApplicationSettings.getBoolean(PREVIEW_ONLY_KEY, false);
}

export function setPreviewOnlyMode(previewOnly: boolean): void {
  ApplicationSettings.setBoolean(PREVIEW_ONLY_KEY, previewOnly);
}
