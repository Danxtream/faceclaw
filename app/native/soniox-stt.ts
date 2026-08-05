import { CLOUD_STT_SAMPLE_RATE, CloudSttClient, CloudSttOptions, toJavaBytes } from "./cloud-stt";

declare const com: any;

/**
 * Soniox realtime speech-to-text over WebSocket.
 * https://soniox.com/docs/stt/rt/real-time-transcription
 *
 * Unlike the other cloud providers, Soniox authenticates with an api_key field
 * in the first (JSON) message rather than an HTTP header, and audio is sent as
 * raw binary frames rather than base64-in-JSON. Push-to-talk defines the
 * utterance boundary: an empty text frame is the end-of-audio signal, after
 * which the server finalizes all tokens and replies with finished=true.
 *
 * Transcripts arrive as TOKENS: final tokens are delivered exactly once and
 * are accumulated here; non-final tokens repeat (revised) in every message and
 * are appended for display only. Listeners get full replace-semantics text.
 */

const WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const MODEL_ID = "stt-rt-v5";

export type SonioxSttOptions = CloudSttOptions;

export class SonioxSttClient implements CloudSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  // PCM queued until the socket opens and the config message is sent.
  private readonly pendingPcm: Uint8Array[] = [];
  private pendingFinish = false;
  // Concatenation of all final tokens so far.
  private finalText = "";

  constructor(private readonly options: SonioxSttOptions) {}

  start(): void {
    if (this.ws) return;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        // The API key rides in the config message; there is no auth header.
        this.trySendText(
          JSON.stringify({
            api_key: this.options.apiKey,
            model: MODEL_ID,
            audio_format: "pcm_s16le",
            sample_rate: CLOUD_STT_SAMPLE_RATE,
            num_channels: 1,
          }),
        );
        this.open = true;
        for (const chunk of this.pendingPcm.splice(0)) {
          this.sendPcm(chunk);
        }
        if (this.pendingFinish) {
          this.pendingFinish = false;
          this.finish();
        }
        this.options.onStatus("Listening (Soniox)...");
      },
      onTextMessage: (message: string) => this.handleMessage(String(message)),
      onClosed: () => {
        this.open = false;
      },
      onFailure: (message: string) => {
        if (this.closed) return;
        this.options.onError(`Soniox connection failed: ${String(message)}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(WS_URL, this.listenerProxy, null, null);
      this.options.onStatus("Connecting to Soniox...");
    } catch (error) {
      this.options.onError(`Soniox connection failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  /** Feed PCM (16 kHz signed-16-bit LE), as raw binary frames. */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    if (this.open) {
      this.sendPcm(pcm);
    } else {
      this.pendingPcm.push(pcm);
    }
  }

  /** End of utterance: an empty text frame tells Soniox the audio is done. */
  finish(): void {
    if (this.closed) return;
    if (this.open) {
      this.trySendText("");
    } else {
      this.pendingFinish = true;
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

  private sendPcm(pcm: Uint8Array): void {
    try {
      this.ws?.sendBinary(toJavaBytes(pcm));
    } catch (error) {
      console.warn("soniox send failed", error);
    }
  }

  private trySendText(message: string): void {
    try {
      this.ws?.sendText(message);
    } catch (error) {
      console.warn("soniox send failed", error);
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.error_code != null) {
      this.options.onError(`Soniox: ${String(message.error_message ?? message.error_code)}`);
      return;
    }
    const tokens = Array.isArray(message?.tokens) ? message.tokens : [];
    let nonFinal = "";
    for (const token of tokens) {
      const tokenText = String(token?.text ?? "");
      // Markers emitted by endpoint detection / manual finalize; not speech.
      if (tokenText === "<end>" || tokenText === "<fin>") continue;
      if (token?.is_final) {
        this.finalText += tokenText;
      } else {
        nonFinal += tokenText;
      }
    }
    if (message?.finished) {
      this.options.onTranscript({ text: this.finalText, isFinal: true });
      this.stop();
      return;
    }
    if (tokens.length > 0) {
      this.options.onTranscript({ text: this.finalText + nonFinal, isFinal: false });
    }
  }
}
