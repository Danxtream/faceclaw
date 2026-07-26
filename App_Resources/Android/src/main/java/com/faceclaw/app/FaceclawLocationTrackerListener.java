package com.faceclaw.app;

/** Continuous location callbacks for the TypeScript navigation bridge. */
public interface FaceclawLocationTrackerListener {
    /**
     * A new fix. bearingDeg/speedMps are -1 when the fix doesn't carry them
     * (common when stationary); accuracyMeters is -1 when unknown.
     */
    void onLocation(double latitude, double longitude, float accuracyMeters,
                    float bearingDeg, float speedMps, long timestampMs);

    void onError(String message);
}
