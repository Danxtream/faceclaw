package com.faceclaw.app;

public interface FaceclawMediaControllerListener {
    void onStateChange(
            String playbackState,
            String packageName,
            String appName,
            String title,
            String artist,
            String album,
            long positionMs,
            long durationMs,
            float playbackSpeed,
            boolean canPlayPause,
            boolean canSkipNext,
            boolean canSkipPrevious,
            boolean accessEnabled,
            String status
    );
}
