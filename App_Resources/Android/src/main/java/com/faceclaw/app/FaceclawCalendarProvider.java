package com.faceclaw.app;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reads upcoming events from the Android Calendar provider for the Calendar
 * app. Queries the Instances table (rather than Events) so that recurring
 * events are expanded into concrete occurrences within the requested window.
 * Requires the READ_CALENDAR runtime permission; without it the content
 * resolver throws SecurityException and this returns an empty array.
 */
public final class FaceclawCalendarProvider {
    private static final String TAG = "FaceclawCalendar";

    private static final String[] PROJECTION = {
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
    };

    private FaceclawCalendarProvider() {
    }

    /**
     * JSON array of upcoming events starting from now through now+windowMs,
     * ordered by start time, capped at maxEvents. Each element carries id,
     * title, startMs, endMs, allDay, location, and calendarName.
     */
    public static String getUpcomingEventsJson(Context context, int maxEvents, long windowMs) {
        if (context == null || maxEvents <= 0) {
            return "[]";
        }
        long now = System.currentTimeMillis();
        long end = now + Math.max(0L, windowMs);
        int limit = Math.min(200, maxEvents);

        Uri.Builder builder = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(builder, now);
        ContentUris.appendId(builder, end);
        Uri uri = builder.build();

        JSONArray out = new JSONArray();
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    uri,
                    PROJECTION,
                    null,
                    null,
                    CalendarContract.Instances.BEGIN + " ASC");
            if (cursor != null) {
                while (cursor.moveToNext() && out.length() < limit) {
                    try {
                        out.put(buildEventJson(cursor));
                    } catch (JSONException e) {
                        Log.w(TAG, "failed to serialize calendar event", e);
                    }
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "calendar access denied while reading events", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read calendar events", t);
            return "[]";
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return out.toString();
    }

    private static JSONObject buildEventJson(Cursor cursor) throws JSONException {
        JSONObject event = new JSONObject();
        event.put("id", cursor.getLong(0));
        event.put("title", cursor.isNull(1) ? "" : cursor.getString(1));
        event.put("startMs", cursor.getLong(2));
        event.put("endMs", cursor.getLong(3));
        event.put("allDay", cursor.getInt(4) != 0);
        event.put("location", cursor.isNull(5) ? "" : cursor.getString(5));
        event.put("calendarName", cursor.isNull(6) ? "" : cursor.getString(6));
        return event;
    }
}
