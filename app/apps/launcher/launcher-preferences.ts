import { getStringSetting, setStringSetting } from "../../native/settings-store";

const HIDDEN_APPS_KEY = "launcher.hiddenApps.v1";
const APP_ORDER_KEY = "launcher.appOrder.v1";

function readStringArray(key: string): string[] {
  const raw = getStringSetting(key, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function writeStringArray(key: string, values: readonly string[]): void {
  setStringSetting(key, JSON.stringify(Array.from(new Set(values))));
}

export function getHiddenLauncherAppIds(): string[] {
  return readStringArray(HIDDEN_APPS_KEY).filter((id) => id !== "settings");
}

export function isLauncherAppVisible(appId: string): boolean {
  if (appId === "settings") return true;
  return !getHiddenLauncherAppIds().includes(appId);
}

export function setLauncherAppVisible(appId: string, visible: boolean): void {
  if (appId === "settings") return;
  const hidden = new Set(getHiddenLauncherAppIds());
  if (visible) hidden.delete(appId);
  else hidden.add(appId);
  writeStringArray(HIDDEN_APPS_KEY, Array.from(hidden));
}

export function getOrderedLauncherAppIds(availableIds: readonly string[]): string[] {
  const available = new Set(availableIds);
  const stored = readStringArray(APP_ORDER_KEY).filter((id) => available.has(id));
  for (const id of availableIds) {
    if (!stored.includes(id)) stored.push(id);
  }
  return stored;
}

export function moveLauncherApp(appId: string, delta: -1 | 1, availableIds: readonly string[]): void {
  const order = getOrderedLauncherAppIds(availableIds);
  const index = order.indexOf(appId);
  if (index < 0) return;
  const nextIndex = Math.max(0, Math.min(order.length - 1, index + delta));
  if (nextIndex === index) return;
  const [moved] = order.splice(index, 1);
  order.splice(nextIndex, 0, moved!);
  writeStringArray(APP_ORDER_KEY, order);
}

export function launcherPreferencesFingerprint(): string {
  return `${getStringSetting(HIDDEN_APPS_KEY, "")}|${getStringSetting(APP_ORDER_KEY, "")}`;
}
