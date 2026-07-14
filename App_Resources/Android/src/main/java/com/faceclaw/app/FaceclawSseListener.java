package com.faceclaw.app;

/** Callbacks for FaceclawSseRequest, delivered on the constructing thread's Looper. */
public interface FaceclawSseListener {
    /** One line of a successful (2xx) streaming response body, without the newline. */
    void onLine(String line);
    /** The server answered with a non-2xx status; body is the full error body. */
    void onHttpError(int code, String body);
    /** The 2xx response body ended normally. */
    void onComplete();
    /** Network-level failure (connect, TLS, mid-stream drop). Not called after cancel(). */
    void onFailure(String message);
}
