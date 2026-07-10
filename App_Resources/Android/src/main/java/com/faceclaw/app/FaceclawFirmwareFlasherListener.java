package com.faceclaw.app;

/** Callbacks from FaceclawFirmwareFlasher to the TypeScript layer. */
public interface FaceclawFirmwareFlasherListener {
    void onLog(String line);

    /**
     * Fine-grained progress for the UI bar. `lens` is "left"/"right";
     * component/block indices are 1-based against their counts.
     */
    void onProgress(String lens, int componentIndex, int componentCount, int blockIndex, int blockCount);

    /**
     * Coarse lifecycle. `state` is one of: validating, connecting, flashing,
     * rebooting, done, error. `detail` carries the lens name or a message.
     */
    void onState(String state, String detail);

    /** Terminal callback: success or failure, with an explanatory message. */
    void onComplete(boolean success, String detail);
}
