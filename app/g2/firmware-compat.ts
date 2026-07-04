/**
 * Compatibility check for the glasses firmware. Faceclaw requires the custom
 * firmware: version >= 2.2.4.34 with the "imgz" extension token in the CFW
 * capability string ("EVENCFW/1 img576 imgz ..."). Stock firmware sends no
 * capability string at all.
 */

import { type FirmwareInfo } from "../native/faceclaw-communicator";

const MIN_FIRMWARE_VERSION = [2, 2, 4, 34];
const REQUIRED_FIRMWARE_EXTENSION = "imgz";

function parseDottedVersion(version: string): number[] {
  return version
    .trim()
    .split(".")
    .map((part) => {
      const value = parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

/** Standard component-wise compare; missing components count as 0. */
function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Human-readable explanation of why this firmware cannot run Faceclaw, or
 * null if it is compatible. Returns null when no version was reported at all
 * (no data is not evidence of incompatibility).
 */
export function firmwareIncompatibilityMessage(info: FirmwareInfo): string | null {
  const reportedVersions = [info.leftVersion, info.rightVersion].filter((v) => v.trim().length > 0);
  if (reportedVersions.length === 0) return null;

  const minVersionText = MIN_FIRMWARE_VERSION.join(".");
  const versionsText = `L=${info.leftVersion || "unknown"} R=${info.rightVersion || "unknown"}`;

  if (reportedVersions.some((v) => compareVersions(parseDottedVersion(v), MIN_FIRMWARE_VERSION) < 0)) {
    return (
      `The glasses report firmware ${versionsText}, but Faceclaw requires the modified firmware, ` +
      `version ${minVersionText} or newer. Displaying images will not work until the glasses firmware is updated.`
    );
  }

  const tokens = info.capabilities.trim().split(/\s+/);
  if (!tokens.includes(REQUIRED_FIRMWARE_EXTENSION)) {
    return (
      `The glasses firmware (${versionsText}) does not advertise the "${REQUIRED_FIRMWARE_EXTENSION}" extension` +
      `${info.capabilities.trim() ? ` (reported: ${info.capabilities.trim()})` : ", which suggests stock firmware"}. ` +
      `Faceclaw requires the modified firmware with compressed-image support.`
    );
  }

  return null;
}
