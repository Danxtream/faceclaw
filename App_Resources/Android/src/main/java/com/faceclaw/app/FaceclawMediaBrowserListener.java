package com.faceclaw.app;

public interface FaceclawMediaBrowserListener {
    void onConnectResult(int requestId, boolean connected, String rootId, String error);

    void onBrowseResult(int requestId, String childrenJson, String error);

    /** The service connection dropped after connecting (player crashed or was killed). */
    void onDisconnected();
}
