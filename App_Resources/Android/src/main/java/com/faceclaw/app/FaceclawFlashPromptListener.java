package com.faceclaw.app;

/** Callbacks from FaceclawFlashPromptCommunicator to the TypeScript layer. */
public interface FaceclawFlashPromptListener {
    void onLog(String line);

    /**
     * Lifecycle updates. `state` is one of: connecting, connected, prompting,
     * result, cancelled, timeout, disconnected, error. `detail` carries the
     * "approved"/"declined" text for result, or an error/explanation message.
     */
    void onState(String state, String detail);

    /** Fires once the user picks a menu row: true = flash, false = cancel. */
    void onResult(boolean approved);
}
