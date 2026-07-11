package com.faceclaw.app;

/** Callbacks from FaceclawDeviceInfoProbe to the TypeScript layer. */
public interface FaceclawDeviceInfoProbeListener {
    void onLog(String line);

    /** Lifecycle: connecting, querying. */
    void onState(String state, String detail);

    /** Terminal success: firmware versions and the CFW capability string (may be empty). */
    void onResult(String leftVersion, String rightVersion, String capabilities);

    /** Terminal failure (couldn't connect or read the version). */
    void onError(String message);
}
