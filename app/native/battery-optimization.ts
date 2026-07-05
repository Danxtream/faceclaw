import { Utils } from "@nativescript/core";

declare const android: any;

/**
 * Battery-optimization ("Doze") exemption checks. Faceclaw holds a partial
 * wakelock while the G2 screen is on, but Android ignores wakelocks of
 * non-exempt apps in deep Doze (phone unplugged + still + screen off), which
 * suspends the CPU between BLE packets and stalls the render timers to a few
 * frames per second. The exemption ("Allow background usage: Unrestricted")
 * makes the system honor the wakelock.
 */

export function isIgnoringBatteryOptimizations(): boolean {
  if (!global.isAndroid) return true;
  const context = Utils.android.getApplicationContext();
  if (!context) return true;
  const powerManager = context.getSystemService(android.content.Context.POWER_SERVICE);
  return Boolean(powerManager?.isIgnoringBatteryOptimizations(context.getPackageName()));
}

/** Open the system dialog asking to exempt Faceclaw from battery optimization. */
export function requestIgnoreBatteryOptimizations(): void {
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (!context) return;
  const intent = new android.content.Intent(
    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
    android.net.Uri.parse(`package:${context.getPackageName()}`),
  );
  intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
  context.startActivity(intent);
}
