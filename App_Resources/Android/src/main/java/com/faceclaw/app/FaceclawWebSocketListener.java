package com.faceclaw.app;

/** Callbacks for FaceclawWebSocket, delivered on the Android main thread. */
public interface FaceclawWebSocketListener {
    void onOpen();
    void onTextMessage(String message);
    void onClosed(int code, String reason);
    void onFailure(String message);
}
