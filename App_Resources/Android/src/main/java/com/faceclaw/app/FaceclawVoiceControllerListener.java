package com.faceclaw.app;

public interface FaceclawVoiceControllerListener {
    void onStatus(String status);

    void onWakeWord(String keyword);

    /**
     * Best transcript of the current utterance so far. REPLACE semantics: text
     * is the complete transcript, not a delta — display it verbatim, replacing
     * any previous partial. isFinal marks the end of the utterance.
     */
    void onTranscript(String text, boolean isFinal);

    /**
     * Decoded microphone audio for CLOUD mode: 16 kHz mono signed 16-bit
     * little-endian PCM. Empty/absent in onboard mode.
     */
    void onPcm(byte[] pcm16le);
}
