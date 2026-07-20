import { Utils } from "@nativescript/core";

declare const com: any;

function getContext(): android.content.Context | null {
  if (!global.isAndroid) return null;
  return Utils.android.getApplicationContext() ?? null;
}

/** Schedule the durable Android alarm backing one on-glasses timer. */
export function scheduleTimerNotification(timerId: number, triggerAtMs: number, durationLabel: string): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.schedule(context, timerId, triggerAtMs, durationLabel);
}

/** Cancel both a pending alarm and any already-posted notification. */
export function cancelTimerNotification(timerId: number): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.cancel(context, timerId);
}

/** Prompt worker-side expiry path; Java deduplicates it against the alarm. */
export function fireTimerNotification(timerId: number, durationLabel: string): void {
  const context = getContext();
  if (!context) return;
  com.faceclaw.app.FaceclawTimerNotifications.fireNow(context, timerId, durationLabel);
}
