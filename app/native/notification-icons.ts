import { GrayImage } from "../graphics/image";
import { logCurrent, spanCurrent } from "./frame-timings";
import { toUint8Array } from "../util/array-util";

declare const com: any;

const ICON_SIZE = 24;
const ICON_CACHE_MS = 5_000;

let cachedIcons: GrayImage[] = [];
let cachedAtMs = 0;
let notificationListenerProxy: any | null = null;
const notificationPostedListeners = new Set<(notificationKey: string) => void>();

export type AndroidNotificationAction = {
  index: number;
  title: string;
  enabled: boolean;
};

export type AndroidNotification = {
  key: string;
  packageName: string;
  appName: string;
  title: string;
  text: string;
  bigText: string;
  subText: string;
  infoText: string;
  summaryText: string;
  category: string;
  lines: string[];
  postTime: number;
  when: number;
  actions: AndroidNotificationAction[];
};

export function readActiveNotificationIcons(maxIcons: number): GrayImage[] {
  if (!global.isAndroid || maxIcons <= 0) return [];

  const now = Date.now();
  if (now - cachedAtMs < ICON_CACHE_MS) {
    logCurrent("notification icons served from cache");
    return cachedIcons.map(icon => icon.clone());
  }

  const bytes = spanCurrent("fetch-notification-icons", () =>
    toUint8Array(
      com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationIconGrays(
        ICON_SIZE,
        maxIcons,
      ),
    ),
  );
  const iconByteLength = ICON_SIZE * ICON_SIZE;
  const iconCount = Math.floor(bytes.length / iconByteLength);
  const icons: GrayImage[] = [];
  for (let index = 0; index < iconCount; index++) {
    const icon = new GrayImage(ICON_SIZE, ICON_SIZE, 0);
    icon.pixels.set(bytes.subarray(index * iconByteLength, (index + 1) * iconByteLength));
    icons.push(icon);
  }

  cachedIcons = icons;
  cachedAtMs = now;
  return icons.map(icon => icon.clone());
}

export function readActiveNotifications(maxNotifications = 50): AndroidNotification[] {
  if (!global.isAndroid || maxNotifications <= 0) return [];
  try {
    const json = spanCurrent("fetch-notifications-json", () =>
      String(
        com.faceclaw.app.FaceclawMediaNotificationListenerService.getActiveNotificationsJson(
          Math.max(0, Math.round(maxNotifications)),
        ),
      ),
    );
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeNotification).filter((item): item is AndroidNotification => Boolean(item));
  } catch {
    return [];
  }
}

export function invokeNotificationAction(notificationKey: string, actionIndex: number): boolean {
  if (!global.isAndroid || !notificationKey) return false;
  cachedAtMs = 0;
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.invokeNotificationAction(
      notificationKey,
      Math.round(actionIndex),
    ),
  );
}

export function dismissNotification(notificationKey: string): boolean {
  if (!global.isAndroid || !notificationKey) return false;
  cachedAtMs = 0;
  return Boolean(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.dismissNotification(notificationKey),
  );
}

export function onAndroidNotificationPosted(listener: (notificationKey: string) => void): () => void {
  notificationPostedListeners.add(listener);
  ensureNotificationPostedListener();
  return () => {
    notificationPostedListeners.delete(listener);
    if (notificationPostedListeners.size === 0) {
      removeNotificationPostedListener();
    }
  };
}

function normalizeNotification(value: any): AndroidNotification | null {
  if (!value || typeof value !== "object") return null;
  const key = String(value.key ?? "");
  if (!key) return null;
  const actions = Array.isArray(value.actions)
    ? value.actions.map(normalizeAction).filter((item): item is AndroidNotificationAction => Boolean(item))
    : [];
  return {
    key,
    packageName: String(value.packageName ?? ""),
    appName: String(value.appName ?? value.packageName ?? ""),
    title: String(value.title ?? ""),
    text: String(value.text ?? ""),
    bigText: String(value.bigText ?? ""),
    subText: String(value.subText ?? ""),
    infoText: String(value.infoText ?? ""),
    summaryText: String(value.summaryText ?? ""),
    category: String(value.category ?? ""),
    lines: Array.isArray(value.lines) ? value.lines.map((line: unknown) => String(line)).filter(Boolean) : [],
    postTime: Number(value.postTime) || 0,
    when: Number(value.when) || 0,
    actions,
  };
}

function ensureNotificationPostedListener(): void {
  if (!global.isAndroid || notificationListenerProxy) return;
  notificationListenerProxy = new com.faceclaw.app.FaceclawNotificationListener({
    onNotificationPosted: (notificationKey: string) => {
      cachedAtMs = 0;
      const key = String(notificationKey);
      const listeners = Array.from(notificationPostedListeners);
      setTimeout(() => {
        for (const listener of listeners) {
          listener(key);
        }
      }, 0);
    },
  });
  com.faceclaw.app.FaceclawMediaNotificationListenerService.addNotificationListener(
    notificationListenerProxy,
  );
}

function removeNotificationPostedListener(): void {
  if (!global.isAndroid || !notificationListenerProxy) return;
  com.faceclaw.app.FaceclawMediaNotificationListenerService.removeNotificationListener(
    notificationListenerProxy,
  );
  notificationListenerProxy = null;
}

function normalizeAction(value: any): AndroidNotificationAction | null {
  if (!value || typeof value !== "object") return null;
  const title = String(value.title ?? "");
  if (!title) return null;
  const index = Number(value.index);
  if (!Number.isFinite(index)) return null;
  return {
    index,
    title,
    enabled: Boolean(value.enabled),
  };
}
