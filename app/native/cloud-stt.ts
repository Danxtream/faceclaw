/**
 * Shared shape for the cloud speech-to-text providers (ElevenLabs, Whisper).
 * The voice bridge holds one of these while a cloud provider owns the
 * transcript; the Java controller then only decodes LC3 to PCM and hands it
 * over via acceptPcm.
 */

export type CloudSttTranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export type CloudSttOptions = {
  apiKey: string;
  onTranscript: (event: CloudSttTranscriptEvent) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
};

export interface CloudSttClient {
  /** Open whatever the provider needs before audio arrives. */
  start(): void;
  /** Feed PCM (16 kHz signed-16-bit LE). */
  acceptPcm(pcm: Uint8Array): void;
  /** End of utterance: produce a final transcript. */
  finish(): void;
  /** Abandon the session without finalizing. */
  stop(): void;
}

/** Sample rate of the PCM the G2 mic path produces, shared by all providers. */
export const CLOUD_STT_SAMPLE_RATE = 16000;

declare const android: any;

/** Base64 for audio payloads, via the Android SDK (no JS base64 in NS core). */
export function encodeBase64(bytes: Uint8Array): string {
  if (!global.isAndroid) return "";
  const javaBytes = Array.create("byte", bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    javaBytes[i] = value > 127 ? value - 256 : value;
  }
  return String(android.util.Base64.encodeToString(javaBytes, android.util.Base64.NO_WRAP));
}
