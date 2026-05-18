package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class FaceclawMediaNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "FaceclawNotify";
    private static final double NOTIFICATION_ICON_GAMMA = 1.6;
    private static final String EXTRA_SUBSTITUTE_APP_NAME = "android.substName";

    private static volatile FaceclawMediaNotificationListenerService activeService;

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
        }
        super.onDestroy();
    }

    @Override
    public void onListenerConnected() {
        activeService = this;
        super.onListenerConnected();
    }

    @Override
    public void onListenerDisconnected() {
        if (activeService == this) {
            activeService = null;
        }
        super.onListenerDisconnected();
    }

    public static boolean hasActiveNotificationTitle(String expectedTitle) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || expectedTitle == null || expectedTitle.isEmpty()) {
            return false;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while checking active notifications", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to check active notifications", t);
            return false;
        }
        if (notifications == null || notifications.length == 0) {
            return false;
        }
        for (StatusBarNotification notification : notifications) {
            if (notification == null || notification.getNotification() == null) {
                continue;
            }
            Bundle extras = notification.getNotification().extras;
            if (extras == null) {
                continue;
            }
            CharSequence title = extras.getCharSequence(Notification.EXTRA_TITLE);
            if (title != null && expectedTitle.contentEquals(title)) {
                return true;
            }
        }
        return false;
    }

    public static byte[] getActiveNotificationIconGrays(int iconSize, int maxIcons) {
        FaceclawMediaNotificationListenerService service = activeService;
        int size = Math.max(1, Math.min(96, iconSize));
        int limit = Math.max(0, maxIcons);
        if (service == null || limit == 0) {
            return new byte[0];
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading icons", e);
            return new byte[0];
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notification icons", t);
            return new byte[0];
        }
        if (notifications == null || notifications.length == 0) {
            return new byte[0];
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size * Math.min(limit, notifications.length));
        Set<String> emittedGroupKeys = new HashSet<>();
        int emitted = 0;
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!shouldShowNotificationIcon(service, statusBarNotification)) {
                continue;
            }
            String dedupeGroupKey = getNotificationDedupeGroupKey(statusBarNotification);
            if (dedupeGroupKey != null && emittedGroupKeys.contains(dedupeGroupKey)) {
                continue;
            }
            Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
            if (drawable == null) {
                continue;
            }
            appendIconGrayBytes(drawable, size, out);
            if (dedupeGroupKey != null) {
                emittedGroupKeys.add(dedupeGroupKey);
            }
            emitted += 1;
            if (emitted >= limit) {
                break;
            }
        }
        return out.toByteArray();
    }

    public static String getActiveNotificationsJson(int maxNotifications) {
        FaceclawMediaNotificationListenerService service = activeService;
        int limit = Math.max(0, Math.min(100, maxNotifications));
        if (service == null || limit == 0) {
            return "[]";
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading notifications", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notifications", t);
            return "[]";
        }
        if (notifications == null || notifications.length == 0) {
            return "[]";
        }

        Arrays.sort(notifications, new Comparator<StatusBarNotification>() {
            @Override
            public int compare(StatusBarNotification a, StatusBarNotification b) {
                long left = a == null ? 0 : a.getPostTime();
                long right = b == null ? 0 : b.getPostTime();
                return Long.compare(right, left);
            }
        });

        JSONArray out = new JSONArray();
        for (StatusBarNotification statusBarNotification : notifications) {
            if (out.length() >= limit) {
                break;
            }
            if (!shouldShowNotificationInList(service, statusBarNotification)) {
                continue;
            }
            try {
                out.put(buildNotificationJson(service, statusBarNotification));
            } catch (Throwable t) {
                Log.w(TAG, "failed to serialize notification", t);
            }
        }
        return out.toString();
    }

    public static boolean invokeNotificationAction(String key, int actionIndex) {
        FaceclawMediaNotificationListenerService service = activeService;
        StatusBarNotification statusBarNotification = findActiveNotificationByKey(service, key);
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        Notification.Action[] actions = statusBarNotification.getNotification().actions;
        if (actions == null || actionIndex < 0 || actionIndex >= actions.length) {
            return false;
        }
        PendingIntent intent = actions[actionIndex].actionIntent;
        if (intent == null) {
            return false;
        }
        try {
            intent.send();
            return true;
        } catch (PendingIntent.CanceledException e) {
            Log.w(TAG, "notification action pending intent was canceled", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to invoke notification action", t);
            return false;
        }
    }

    public static boolean dismissNotification(String key) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || key == null || key.isEmpty()) {
            return false;
        }
        try {
            service.cancelNotification(key);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while dismissing notification", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to dismiss notification", t);
            return false;
        }
    }

    private static boolean shouldShowNotificationIcon(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (!shouldShowNotificationInList(service, statusBarNotification)) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }
        return true;
    }

    private static boolean shouldShowNotificationInList(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        if (service.getPackageName().equals(statusBarNotification.getPackageName())) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if (Notification.CATEGORY_TRANSPORT.equals(notification.category)) {
            return false;
        }
        Bundle extras = notification.extras;
        if (extras != null && extras.containsKey("android.mediaSession")) {
            return false;
        }

        NotificationListenerService.RankingMap rankingMap = service.getCurrentRanking();
        if (rankingMap == null) {
            return true;
        }
        NotificationListenerService.Ranking ranking = new NotificationListenerService.Ranking();
        if (!rankingMap.getRanking(statusBarNotification.getKey(), ranking)) {
            return true;
        }
        int importance = ranking.getImportance();
        return importance > NotificationManager.IMPORTANCE_MIN;
    }

    private static String getNotificationDedupeGroupKey(StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification.getGroup() == null && statusBarNotification.getOverrideGroupKey() == null) {
            return null;
        }
        String groupKey = statusBarNotification.getGroupKey();
        if (groupKey == null || groupKey.isEmpty()) {
            return null;
        }
        // Group children often share the same small icon. Emit only one icon for the group.
        return groupKey;
    }

    private static Drawable loadNotificationIcon(FaceclawMediaNotificationListenerService service, Notification notification) {
        try {
            Icon smallIcon = notification.getSmallIcon();
            if (smallIcon != null) {
                Drawable drawable = smallIcon.loadDrawable(service);
                if (drawable != null) {
                    return drawable;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load small notification icon", t);
        }
        try {
            Icon largeIcon = notification.getLargeIcon();
            if (largeIcon != null) {
                return largeIcon.loadDrawable(service);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load large notification icon", t);
        }
        return null;
    }

    private static void appendIconGrayBytes(Drawable drawable, int size, ByteArrayOutputStream out) {
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, size, size);
        drawable.draw(canvas);
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int color = bitmap.getPixel(x, y);
                int alpha = Color.alpha(color);
                double grayLinear = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) * alpha / (255.0 * 255.0);
                int gray = (int) Math.round(255.0 * Math.pow(Math.max(0.0, Math.min(1.0, grayLinear)), NOTIFICATION_ICON_GAMMA));
                out.write(gray & 0xff);
            }
        }
        bitmap.recycle();
    }

    private static StatusBarNotification findActiveNotificationByKey(FaceclawMediaNotificationListenerService service, String key) {
        if (service == null || key == null || key.isEmpty()) {
            return null;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to find active notification", t);
            return null;
        }
        if (notifications == null) {
            return null;
        }
        for (StatusBarNotification statusBarNotification : notifications) {
            if (statusBarNotification != null && key.equals(statusBarNotification.getKey())) {
                return statusBarNotification;
            }
        }
        return null;
    }

    private static JSONObject buildNotificationJson(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification)
            throws JSONException {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        JSONObject out = new JSONObject();
        out.put("key", statusBarNotification.getKey());
        out.put("packageName", statusBarNotification.getPackageName());
        out.put("appName", getNotificationAppName(service, statusBarNotification));
        out.put("postTime", statusBarNotification.getPostTime());
        out.put("when", notification.when);
        putString(out, "category", notification.category);
        if (extras != null) {
            putCharSequence(out, "title", firstNonEmpty(
                    extras.getCharSequence(Notification.EXTRA_TITLE_BIG),
                    extras.getCharSequence(Notification.EXTRA_TITLE)
            ));
            putCharSequence(out, "text", extras.getCharSequence(Notification.EXTRA_TEXT));
            putCharSequence(out, "bigText", extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            putCharSequence(out, "subText", extras.getCharSequence(Notification.EXTRA_SUB_TEXT));
            putCharSequence(out, "infoText", extras.getCharSequence(Notification.EXTRA_INFO_TEXT));
            putCharSequence(out, "summaryText", extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT));
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            JSONArray lines = new JSONArray();
            if (textLines != null) {
                for (CharSequence line : textLines) {
                    String text = charSequenceToString(line);
                    if (!text.isEmpty()) {
                        lines.put(text);
                    }
                }
            }
            out.put("lines", lines);
        } else {
            out.put("lines", new JSONArray());
        }

        JSONArray actionsJson = new JSONArray();
        Notification.Action[] actions = notification.actions;
        if (actions != null) {
            for (int index = 0; index < actions.length; index++) {
                Notification.Action action = actions[index];
                if (action == null) {
                    continue;
                }
                String title = charSequenceToString(action.title);
                if (title.isEmpty()) {
                    continue;
                }
                JSONObject actionJson = new JSONObject();
                actionJson.put("index", index);
                actionJson.put("title", title);
                actionJson.put("enabled", action.actionIntent != null);
                actionsJson.put(actionJson);
            }
        }
        out.put("actions", actionsJson);
        return out;
    }

    private static String getNotificationAppName(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        if (extras != null) {
            String substituteName = charSequenceToString(extras.getCharSequence(EXTRA_SUBSTITUTE_APP_NAME));
            if (!substituteName.isEmpty()) {
                return substituteName;
            }
        }
        return getAppLabel(service, statusBarNotification.getPackageName());
    }

    private static String getAppLabel(FaceclawMediaNotificationListenerService service, String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return "";
        }
        try {
            CharSequence label = service
                    .getPackageManager()
                    .getApplicationLabel(service.getPackageManager().getApplicationInfo(packageName, 0));
            String text = charSequenceToString(label);
            return text.isEmpty() ? packageName : text;
        } catch (Throwable t) {
            return packageName;
        }
    }

    private static void putString(JSONObject out, String key, String value) throws JSONException {
        out.put(key, value == null ? "" : value);
    }

    private static void putCharSequence(JSONObject out, String key, CharSequence value) throws JSONException {
        out.put(key, charSequenceToString(value));
    }

    private static CharSequence firstNonEmpty(CharSequence first, CharSequence second) {
        return charSequenceToString(first).isEmpty() ? second : first;
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString();
    }
}
