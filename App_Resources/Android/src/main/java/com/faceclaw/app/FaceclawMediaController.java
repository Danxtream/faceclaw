package com.faceclaw.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.media.MediaDescription;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

public class FaceclawMediaController {
    private final Context appContext;
    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ComponentName listenerComponent;
    private final MediaSessionManager sessionManager;

    private final MediaController.Callback controllerCallback = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onQueueChanged(List<MediaSession.QueueItem> queue) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onSessionDestroyed() {
            synchronized (lock) {
                refreshActiveControllerLocked(null);
            }
        }
    };

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChangedListener = controllers -> {
        synchronized (lock) {
            refreshActiveControllerLocked(controllers);
        }
    };

    private volatile FaceclawMediaControllerListener listener;
    private MediaController activeController;
    private boolean started;

    public FaceclawMediaController(Context context) {
        this.appContext = context.getApplicationContext();
        this.listenerComponent = new ComponentName(appContext, FaceclawMediaNotificationListenerService.class);
        this.sessionManager = (MediaSessionManager) appContext.getSystemService(Context.MEDIA_SESSION_SERVICE);
    }

    public void setListener(FaceclawMediaControllerListener listener) {
        synchronized (lock) {
            this.listener = listener;
            emitStateLocked();
        }
    }

    public void start() {
        synchronized (lock) {
            if (started) {
                emitStateLocked();
                return;
            }
            started = true;
            if (!isNotificationAccessEnabled()) {
                emitStateLocked();
                return;
            }
            if (sessionManager != null) {
                try {
                    sessionManager.addOnActiveSessionsChangedListener(
                            sessionsChangedListener,
                            listenerComponent,
                            mainHandler
                    );
                } catch (SecurityException ignored) {
                    emitStateLocked();
                    return;
                }
            }
            refreshActiveControllerLocked(null);
        }
    }

    public void stop() {
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            if (sessionManager != null) {
                try {
                    sessionManager.removeOnActiveSessionsChangedListener(sessionsChangedListener);
                } catch (SecurityException ignored) {
                }
            }
            setActiveControllerLocked(null);
            emitStateLocked();
        }
    }

    public void playPause() {
        synchronized (lock) {
            if (activeController == null) {
                return;
            }
            PlaybackState playbackState = activeController.getPlaybackState();
            MediaController.TransportControls controls = activeController.getTransportControls();
            if (playbackState == null) {
                controls.play();
                return;
            }
            switch (playbackState.getState()) {
                case PlaybackState.STATE_PLAYING:
                case PlaybackState.STATE_BUFFERING:
                case PlaybackState.STATE_CONNECTING:
                    controls.pause();
                    return;
                default:
                    controls.play();
            }
        }
    }

    public void skipNext() {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToNext();
            }
        }
    }

    public void skipPrevious() {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToPrevious();
            }
        }
    }

    public void skipToQueueItem(long queueId) {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToQueueItem(queueId);
            }
        }
    }

    /**
     * Album art for the active session's current item, grayscale, scaled to
     * fit within maxSize x maxSize preserving aspect. Returns
     * [widthLo, widthHi, heightLo, heightHi, pixels...] or an empty array
     * when no art is available.
     */
    public byte[] getAlbumArtGray(int maxSize) {
        Bitmap art;
        synchronized (lock) {
            if (activeController == null) {
                return new byte[0];
            }
            MediaMetadata metadata = activeController.getMetadata();
            if (metadata == null) {
                return new byte[0];
            }
            art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ART);
            }
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
            }
        }
        if (art == null || art.getWidth() <= 0 || art.getHeight() <= 0 || maxSize <= 0) {
            return new byte[0];
        }
        try {
            float scale = Math.min(1f, Math.min(
                    (float) maxSize / art.getWidth(),
                    (float) maxSize / art.getHeight()));
            int width = Math.max(1, Math.round(art.getWidth() * scale));
            int height = Math.max(1, Math.round(art.getHeight() * scale));
            Bitmap scaled = Bitmap.createScaledBitmap(art, width, height, true);
            if (scaled.getConfig() == Bitmap.Config.HARDWARE) {
                scaled = scaled.copy(Bitmap.Config.ARGB_8888, false);
            }
            int[] pixels = new int[width * height];
            scaled.getPixels(pixels, 0, width, 0, 0, width, height);
            byte[] out = new byte[4 + width * height];
            out[0] = (byte) (width & 0xff);
            out[1] = (byte) ((width >> 8) & 0xff);
            out[2] = (byte) (height & 0xff);
            out[3] = (byte) ((height >> 8) & 0xff);
            for (int i = 0; i < pixels.length; i++) {
                int p = pixels[i];
                int r = (p >> 16) & 0xff;
                int g = (p >> 8) & 0xff;
                int b = p & 0xff;
                out[4 + i] = (byte) ((r * 299 + g * 587 + b * 114) / 1000);
            }
            return out;
        } catch (Exception e) {
            Log.w("FaceclawMedia", "album art conversion failed", e);
            return new byte[0];
        }
    }

    /**
     * The active session's queue (playlist) as JSON:
     * [{"id": long, "title": string, "active": bool}, ...]. Empty string when
     * the player exposes no queue.
     */
    public String getQueueJson() {
        synchronized (lock) {
            if (activeController == null) {
                return "";
            }
            List<MediaSession.QueueItem> queue = activeController.getQueue();
            if (queue == null || queue.isEmpty()) {
                return "";
            }
            PlaybackState state = activeController.getPlaybackState();
            long activeId = state == null ? -1 : state.getActiveQueueItemId();
            try {
                JSONArray out = new JSONArray();
                for (MediaSession.QueueItem item : queue) {
                    MediaDescription description = item.getDescription();
                    CharSequence title = description == null ? null : description.getTitle();
                    JSONObject entry = new JSONObject();
                    entry.put("id", item.getQueueId());
                    entry.put("title", title == null ? "" : title.toString());
                    entry.put("active", item.getQueueId() == activeId);
                    out.put(entry);
                }
                return out.toString();
            } catch (Exception e) {
                Log.w("FaceclawMedia", "queue serialization failed", e);
                return "";
            }
        }
    }

    public void openNotificationAccessSettings() {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        appContext.startActivity(intent);
    }

    private void refreshActiveControllerLocked(List<MediaController> controllers) {
        if (!started) {
            setActiveControllerLocked(null);
            emitStateLocked();
            return;
        }
        if (!isNotificationAccessEnabled()) {
            setActiveControllerLocked(null);
            emitStateLocked();
            return;
        }
        if (controllers == null && sessionManager != null) {
            try {
                controllers = sessionManager.getActiveSessions(listenerComponent);
            } catch (SecurityException ignored) {
                controllers = null;
            }
        }
        setActiveControllerLocked(chooseController(controllers));
        emitStateLocked();
    }

    private MediaController chooseController(List<MediaController> controllers) {
        if (controllers == null || controllers.isEmpty()) {
            return null;
        }
        MediaController first = controllers.get(0);
        for (MediaController controller : controllers) {
            PlaybackState playbackState = controller.getPlaybackState();
            if (playbackState != null && playbackState.getState() == PlaybackState.STATE_PLAYING) {
                return controller;
            }
        }
        return first;
    }

    private void setActiveControllerLocked(MediaController controller) {
        if (sameController(activeController, controller)) {
            return;
        }
        if (activeController != null) {
            activeController.unregisterCallback(controllerCallback);
        }
        activeController = controller;
        if (activeController != null) {
            activeController.registerCallback(controllerCallback, mainHandler);
        }
    }

    private boolean sameController(MediaController a, MediaController b) {
        if (a == b) {
            return true;
        }
        if (a == null || b == null) {
            return false;
        }
        return a.getSessionToken().equals(b.getSessionToken());
    }

    private boolean isNotificationAccessEnabled() {
        String enabledListeners = Settings.Secure.getString(
                appContext.getContentResolver(),
                "enabled_notification_listeners"
        );
        if (enabledListeners == null || enabledListeners.isEmpty()) {
            return false;
        }
        String fullName = listenerComponent.flattenToString();
        String shortName = listenerComponent.flattenToShortString();
        return enabledListeners.contains(fullName)
                || enabledListeners.contains(shortName)
                || enabledListeners.contains(appContext.getPackageName());
    }

    private void emitStateLocked() {
        FaceclawMediaControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        String playbackState = started ? "idle" : "stopped";
        String packageName = "";
        String title = "";
        String artist = "";
        String album = "";
        boolean canPlayPause = false;
        boolean canSkipNext = false;
        boolean canSkipPrevious = false;
        boolean accessEnabled = isNotificationAccessEnabled();
        String status;

        if (!accessEnabled) {
            playbackState = "notification-access-required";
            status = "Notification access required.";
        } else if (activeController == null) {
            status = "No active media session.";
        } else {
            packageName = safe(activeController.getPackageName());
            PlaybackState state = activeController.getPlaybackState();
            MediaMetadata metadata = activeController.getMetadata();
            playbackState = playbackStateName(state);
            if (metadata != null) {
                title = safe(metadata.getString(MediaMetadata.METADATA_KEY_TITLE));
                artist = safe(metadata.getString(MediaMetadata.METADATA_KEY_ARTIST));
                album = safe(metadata.getString(MediaMetadata.METADATA_KEY_ALBUM));
            }
            long actions = state == null ? 0L : state.getActions();
            canPlayPause = (actions & PlaybackState.ACTION_PLAY_PAUSE) != 0
                    || (actions & PlaybackState.ACTION_PLAY) != 0
                    || (actions & PlaybackState.ACTION_PAUSE) != 0;
            canSkipNext = (actions & PlaybackState.ACTION_SKIP_TO_NEXT) != 0;
            canSkipPrevious = (actions & PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0;
            status = packageName.isEmpty() ? "Active media session." : "Active session: " + packageName;
        }

        final String finalPlaybackState = playbackState;
        final String finalPackageName = packageName;
        final String finalTitle = title;
        final String finalArtist = artist;
        final String finalAlbum = album;
        final boolean finalCanPlayPause = canPlayPause;
        final boolean finalCanSkipNext = canSkipNext;
        final boolean finalCanSkipPrevious = canSkipPrevious;
        final boolean finalAccessEnabled = accessEnabled;
        final String finalStatus = status;

        mainHandler.post(() -> currentListener.onStateChange(
                finalPlaybackState,
                finalPackageName,
                finalTitle,
                finalArtist,
                finalAlbum,
                finalCanPlayPause,
                finalCanSkipNext,
                finalCanSkipPrevious,
                finalAccessEnabled,
                finalStatus
        ));
    }

    private String playbackStateName(PlaybackState state) {
        if (state == null) {
            return "idle";
        }
        switch (state.getState()) {
            case PlaybackState.STATE_PLAYING:
                return "playing";
            case PlaybackState.STATE_PAUSED:
                return "paused";
            case PlaybackState.STATE_BUFFERING:
            case PlaybackState.STATE_CONNECTING:
                return "buffering";
            case PlaybackState.STATE_STOPPED:
                return "stopped";
            default:
                return "idle";
        }
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }
}
