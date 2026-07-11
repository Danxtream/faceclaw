package com.faceclaw.app;

/**
 * Receives IMU (accelerometer) readings decoded from the glasses' sys-event
 * stream. Registered on FaceclawBleCommunicator via addImuListener; callbacks
 * are delivered on the Android main thread.
 */
public interface FaceclawImuListener {
    void onImuData(double x, double y, double z, int eventSource);
}
