declare const com: any;
declare const android: any;

/**
 * ElevenLabs realtime speech-to-text over WebSocket.
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *
 * We push 16 kHz signed-16-bit-LE PCM (base64) as it arrives from the G2 mic
 * and, because push-to-talk gives us the utterance boundary, use manual commit:
 * commit=true is sent when the button is released, which finalizes the
 * transcript. Partial transcripts stream in the meantime.
 */

const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
// The only model the realtime endpoint accepts (verified against the live API;
// it rejects "scribe_v1" with an explicit message naming this one).
const MODEL_ID = "scribe_v2_realtime";
const SAMPLE_RATE = 16000;

export type ElevenLabsTranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export type ElevenLabsSttOptions = {
  apiKey: string;
  onTranscript: (event: ElevenLabsTranscriptEvent) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
};

export class ElevenLabsSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  // PCM that arrived before the socket finished opening; flushed on open.
  private readonly pendingChunks: string[] = [];
  private latestText = "";

  constructor(private readonly options: ElevenLabsSttOptions) {}

  start(): void {
    if (this.ws) return;
    const url = `${WS_URL}?model_id=${MODEL_ID}&audio_format=pcm_${SAMPLE_RATE}&commit_strategy=manual`;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        this.open = true;
        for (const chunk of this.pendingChunks.splice(0)) {
          this.sendChunk(chunk);
        }
      },
      onTextMessage: (message: string) => this.handleMessage(String(message)),
      onClosed: () => {
        this.open = false;
      },
      onFailure: (message: string) => {
        if (this.closed) return;
        this.options.onError(`ElevenLabs connection failed: ${String(message)}`);
      },
    });
    try {
      // The API key rides an xi-api-key header, added by FaceclawWebSocket.
      this.ws = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, "xi-api-key", this.options.apiKey);
      this.options.onStatus("Connecting to ElevenLabs...");
    } catch (error) {
      this.options.onError(`ElevenLabs connection failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  /** Feed PCM (16 kHz signed-16-bit LE). */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    const base64 = encodeBase64(pcm);
    if (this.open) {
      this.sendChunk(base64);
    } else {
      this.pendingChunks.push(base64);
    }
  }

  /** End of utterance: flush and commit for a final transcript. */
  finish(): void {
    if (this.closed) return;
    const commitMessage = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: SAMPLE_RATE,
    });
    if (this.open) {
      this.trySend(commitMessage);
    } else {
      this.pendingChunks.push("__commit__");
    }
  }

  stop(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
  }

  private sendChunk(base64OrCommit: string): void {
    if (base64OrCommit === "__commit__") {
      this.finish();
      return;
    }
    this.trySend(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64OrCommit,
        commit: false,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  private trySend(message: string): void {
    try {
      this.ws?.sendText(message);
    } catch (error) {
      console.warn("elevenlabs send failed", error);
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message?.message_type) {
      case "session_started":
        this.options.onStatus("Listening (ElevenLabs)...");
        return;
      case "partial_transcript":
        this.latestText = String(message.text ?? "");
        this.options.onTranscript({ text: this.latestText, isFinal: false });
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        this.latestText = String(message.text ?? this.latestText);
        this.options.onTranscript({ text: this.latestText, isFinal: true });
        return;
      case "error":
      case "auth_error":
      case "quota_exceeded":
      case "rate_limited":
      case "input_error":
        this.options.onError(`ElevenLabs: ${String(message.error ?? message.message_type)}`);
        return;
      default:
        return;
    }
  }
}

function encodeBase64(bytes: Uint8Array): string {
  if (!global.isAndroid) return "";
  const javaBytes = Array.create("byte", bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    javaBytes[i] = value > 127 ? value - 256 : value;
  }
  return String(android.util.Base64.encodeToString(javaBytes, android.util.Base64.NO_WRAP));
}
