package com.faceclaw.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.browse.MediaBrowser;
import android.media.session.MediaController;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Client for other apps' MediaBrowserService implementations (the mechanism
 * Android Auto uses). Binding starts the target player's process even when it
 * is not running, so this can list a player's library (playlists, albums, ...)
 * and start playback without the phone being unlocked.
 *
 * Holds at most one connection at a time. All MediaBrowser interaction happens
 * on the main thread; results are reported through
 * FaceclawMediaBrowserListener, also on the main thread.
 */
public class FaceclawMediaBrowser {
    private static final String TAG = "FaceclawMediaBrowser";
    private static final String BROWSER_SERVICE_ACTION = "android.media.browse.MediaBrowserService";
    // Generous: connecting may cold-start the player's process.
    private static final long CONNECT_TIMEOUT_MS = 15_000;
    private static final long BROWSE_TIMEOUT_MS = 15_000;
    // Unbinding immediately after a play command can race the player promoting
    // itself to a foreground service, letting the system kill its process
    // before playback starts; keep the binding alive briefly instead.
    private static final long PLAY_DISCONNECT_GRACE_MS = 5_000;

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile FaceclawMediaBrowserListener listener;

    // Main-thread only.
    private MediaBrowser browser;
    private int generation;
    private long lastPlayCommandAtMs;

    public FaceclawMediaBrowser(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setListener(FaceclawMediaBrowserListener listener) {
        this.listener = listener;
    }

    /**
     * Installed apps exposing a media browser service, as JSON sorted by app
     * name: [{"packageName": ..., "serviceClass": ..., "appName": ...}, ...].
     * Synchronous (PackageManager lookup only).
     */
    public String listBrowsableAppsJson() {
        PackageManager packageManager = appContext.getPackageManager();
        List<ResolveInfo> services;
        try {
            services = packageManager.queryIntentServices(new Intent(BROWSER_SERVICE_ACTION), 0);
        } catch (Exception e) {
            Log.w(TAG, "media browser service query failed", e);
            return "[]";
        }
        List<JSONObject> apps = new ArrayList<>();
        for (ResolveInfo service : services) {
            if (service.serviceInfo == null) {
                continue;
            }
            try {
                CharSequence label = service.serviceInfo.applicationInfo.loadLabel(packageManager);
                JSONObject app = new JSONObject();
                app.put("packageName", service.serviceInfo.packageName);
                app.put("serviceClass", service.serviceInfo.name);
                app.put("appName", label == null ? service.serviceInfo.packageName : label.toString());
                apps.add(app);
            } catch (Exception e) {
                Log.w(TAG, "media browser service entry failed", e);
            }
        }
        Collections.sort(apps, (a, b) -> a.optString("appName").compareToIgnoreCase(b.optString("appName")));
        return new JSONArray(apps).toString();
    }

    /**
     * Connect to an app's media browser service, starting its process if
     * needed; replaces any existing connection. Async; reports through
     * onConnectResult with the browse-tree root id on success.
     */
    public void connect(int requestId, String packageName, String serviceClass) {
        mainHandler.post(() -> {
            closeBrowser();
            final int myGeneration = generation;
            final boolean[] settled = {false};
            final MediaBrowser[] browserRef = new MediaBrowser[1];
            MediaBrowser newBrowser = new MediaBrowser(
                    appContext,
                    new ComponentName(packageName, serviceClass),
                    new MediaBrowser.ConnectionCallback() {
                        @Override
                        public void onConnected() {
                            if (generation != myGeneration || settled[0]) {
                                return;
                            }
                            settled[0] = true;
                            String rootId = "";
                            try {
                                rootId = browserRef[0].getRoot();
                            } catch (Exception e) {
                                Log.w(TAG, "getRoot failed", e);
                            }
                            emitConnectResult(requestId, true, rootId, "");
                        }

                        @Override
                        public void onConnectionFailed() {
                            if (generation != myGeneration || settled[0]) {
                                return;
                            }
                            settled[0] = true;
                            closeBrowser();
                            emitConnectResult(requestId, false, "", "Connection refused by " + packageName);
                        }

                        @Override
                        public void onConnectionSuspended() {
                            if (generation != myGeneration) {
                                return;
                            }
                            FaceclawMediaBrowserListener currentListener = listener;
                            if (currentListener != null) {
                                currentListener.onDisconnected();
                            }
                        }
                    },
                    null
            );
            browserRef[0] = newBrowser;
            browser = newBrowser;
            mainHandler.postDelayed(() -> {
                if (generation != myGeneration || settled[0]) {
                    return;
                }
                settled[0] = true;
                closeBrowser();
                emitConnectResult(requestId, false, "", "Connection to " + packageName + " timed out");
            }, CONNECT_TIMEOUT_MS);
            try {
                newBrowser.connect();
            } catch (Exception e) {
                if (!settled[0]) {
                    settled[0] = true;
                    closeBrowser();
                    emitConnectResult(requestId, false, "", "Connection failed: " + e.getMessage());
                }
            }
        });
    }

    /**
     * Fetch one level of the connected service's content tree. Async; reports
     * through onBrowseResult with children as JSON:
     * [{"mediaId": ..., "title": ..., "subtitle": ..., "browsable": bool, "playable": bool}, ...].
     */
    public void browse(int requestId, String parentId) {
        mainHandler.post(() -> {
            final MediaBrowser currentBrowser = browser;
            if (currentBrowser == null || !currentBrowser.isConnected()) {
                emitBrowseResult(requestId, "", "Not connected");
                return;
            }
            final int myGeneration = generation;
            final boolean[] settled = {false};
            mainHandler.postDelayed(() -> {
                if (generation != myGeneration || settled[0]) {
                    return;
                }
                settled[0] = true;
                try {
                    currentBrowser.unsubscribe(parentId);
                } catch (Exception ignored) {
                }
                emitBrowseResult(requestId, "", "Browse timed out");
            }, BROWSE_TIMEOUT_MS);
            try {
                currentBrowser.subscribe(parentId, new MediaBrowser.SubscriptionCallback() {
                    @Override
                    public void onChildrenLoaded(String loadedParentId, List<MediaBrowser.MediaItem> children) {
                        if (generation != myGeneration || settled[0]) {
                            return;
                        }
                        settled[0] = true;
                        // One snapshot is all we want; unsubscribe outside the callback.
                        mainHandler.post(() -> {
                            try {
                                currentBrowser.unsubscribe(loadedParentId);
                            } catch (Exception ignored) {
                            }
                        });
                        emitBrowseResult(requestId, serializeChildren(children), "");
                    }

                    @Override
                    public void onError(String erroredParentId) {
                        if (generation != myGeneration || settled[0]) {
                            return;
                        }
                        settled[0] = true;
                        mainHandler.post(() -> {
                            try {
                                currentBrowser.unsubscribe(erroredParentId);
                            } catch (Exception ignored) {
                            }
                        });
                        emitBrowseResult(requestId, "", "Browse failed");
                    }
                });
            } catch (Exception e) {
                if (!settled[0]) {
                    settled[0] = true;
                    emitBrowseResult(requestId, "", "Browse failed: " + e.getMessage());
                }
            }
        });
    }

    /** Start playback of a browsed item through the connected service's session. */
    public void playFromMediaId(String mediaId) {
        mainHandler.post(() -> {
            if (browser == null || !browser.isConnected()) {
                return;
            }
            try {
                MediaController controller = new MediaController(appContext, browser.getSessionToken());
                controller.getTransportControls().playFromMediaId(mediaId, null);
                lastPlayCommandAtMs = SystemClock.elapsedRealtime();
            } catch (Exception e) {
                Log.w(TAG, "playFromMediaId failed", e);
            }
        });
    }

    public void disconnect() {
        mainHandler.post(() -> {
            long sincePlayMs = SystemClock.elapsedRealtime() - lastPlayCommandAtMs;
            long graceMs = lastPlayCommandAtMs == 0 ? 0 : PLAY_DISCONNECT_GRACE_MS - sincePlayMs;
            if (graceMs <= 0) {
                closeBrowser();
                return;
            }
            final MediaBrowser lingering = browser;
            browser = null;
            generation++;
            if (lingering != null) {
                mainHandler.postDelayed(() -> {
                    try {
                        lingering.disconnect();
                    } catch (Exception ignored) {
                    }
                }, graceMs);
            }
        });
    }

    private void closeBrowser() {
        generation++;
        if (browser != null) {
            try {
                browser.disconnect();
            } catch (Exception ignored) {
            }
            browser = null;
        }
    }

    private String serializeChildren(List<MediaBrowser.MediaItem> children) {
        JSONArray out = new JSONArray();
        if (children == null) {
            return out.toString();
        }
        for (MediaBrowser.MediaItem item : children) {
            try {
                CharSequence title = item.getDescription() == null ? null : item.getDescription().getTitle();
                CharSequence subtitle = item.getDescription() == null ? null : item.getDescription().getSubtitle();
                JSONObject entry = new JSONObject();
                entry.put("mediaId", item.getMediaId() == null ? "" : item.getMediaId());
                entry.put("title", title == null ? "" : title.toString());
                entry.put("subtitle", subtitle == null ? "" : subtitle.toString());
                entry.put("browsable", item.isBrowsable());
                entry.put("playable", item.isPlayable());
                out.put(entry);
            } catch (Exception e) {
                Log.w(TAG, "media item serialization failed", e);
            }
        }
        return out.toString();
    }

    private void emitConnectResult(int requestId, boolean connected, String rootId, String error) {
        FaceclawMediaBrowserListener currentListener = listener;
        if (currentListener != null) {
            currentListener.onConnectResult(requestId, connected, rootId, error);
        }
    }

    private void emitBrowseResult(int requestId, String childrenJson, String error) {
        FaceclawMediaBrowserListener currentListener = listener;
        if (currentListener != null) {
            currentListener.onBrowseResult(requestId, childrenJson, error);
        }
    }
}
