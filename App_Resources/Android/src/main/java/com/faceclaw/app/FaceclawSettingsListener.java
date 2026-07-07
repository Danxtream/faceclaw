package com.faceclaw.app;

/** Change-notification callback for FaceclawSettings; implemented in JS. */
public interface FaceclawSettingsListener {
    void onSettingChanged(String key);
}
