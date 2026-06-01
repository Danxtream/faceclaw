
export function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatAgeShortFromTimestamp(timestampMs: number | null, nowMs: number): string {
  if (!timestampMs) {
    return "--";
  }
  const elapsedMinutes = Math.max(0, Math.round((nowMs - timestampMs) / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }
  return `${Math.round(elapsedHours / 24)}d`;
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const ageMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
