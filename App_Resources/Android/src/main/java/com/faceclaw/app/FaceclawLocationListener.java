package com.faceclaw.app;

/** One-shot Android location callbacks for the TypeScript Weather bridge. */
public interface FaceclawLocationListener {
    void onLocation(double latitude, double longitude, float accuracyMeters, long timestampMs);

    void onError(String message);
}
