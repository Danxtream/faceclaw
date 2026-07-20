import { CLOUD_STT_SAMPLE_RATE, CloudSttClient, CloudSttOptions, encodeBase64 } from "./cloud-stt";

declare const com: any;

/**
 * OpenAI realtime speech-to-text over WebSocket (a transcription-only session
 * on the Realtime API, with the streaming gpt-realtime-whisper model).
 * https://developers.openai.com/api/docs/guides/realtime-transcription
 *
 * Like the ElevenLabs client, push-to-talk defines the utterance boundary:
 * turn detection is disabled and input_audio_buffer.commit is sent on button
 * release. Two impedance mismatches with our pipeline, both handled here:
 * the endpoint only accepts 24 kHz PCM (the G2 mic path is 16 kHz, so chunks
 * pass through a 2:3 linear-interpolation upsampler), and transcripts arrive
 * as DELTAS, which are accumulated into the full text our replace-semantics
 * listeners expect.
 */

const WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const MODEL_ID = "gpt-realtime-whisper";
const TARGET_SAMPLE_RATE = 24000;

export type OpenAiSttOptions = CloudSttOptions;

export class OpenAiRealtimeSttClient implements CloudSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  // Base64 audio (or the commit sentinel) queued until the socket opens.
  private readonly pendingChunks: string[] = [];
  private readonly upsampler = new PcmUpsampler();
  private latestText = "";
  private committed = false;

  constructor(private readonly options: OpenAiSttOptions) {}

  start(): void {
    if (this.ws) return;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        this.open = true;
        this.trySend(JSON.stringify(sessionConfig()));
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
        this.options.onError(`OpenAI connection failed: ${String(message)}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(
        WS_URL,
        this.listenerProxy,
        "Authorization",
        `Bearer ${this.options.apiKey}`,
      );
      this.options.onStatus("Connecting to OpenAI...");
    } catch (error) {
      this.options.onError(`OpenAI connection failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  /** Feed PCM (16 kHz signed-16-bit LE); upsampled to 24 kHz for the API. */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    const resampled = this.upsampler.process(pcm);
    if (resampled.length === 0) return;
    const base64 = encodeBase64(resampled);
    if (this.open) {
      this.sendChunk(base64);
    } else {
      this.pendingChunks.push(base64);
    }
  }

  /** End of utterance: commit the buffer for a final transcript. */
  finish(): void {
    if (this.closed) return;
    if (this.open) {
      this.sendChunk("__commit__");
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
      this.committed = true;
      this.trySend(JSON.stringify({ type: "input_audio_buffer.commit" }));
      return;
    }
    this.trySend(JSON.stringify({ type: "input_audio_buffer.append", audio: base64OrCommit }));
  }

  private trySend(message: string): void {
    try {
      this.ws?.sendText(message);
    } catch (error) {
      console.warn("openai send failed", error);
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message?.type) {
      case "session.created":
      case "session.updated":
        this.options.onStatus("Listening (OpenAI)...");
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.latestText += String(message.delta ?? "");
        this.options.onTranscript({ text: this.latestText, isFinal: false });
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.latestText = String(message.transcript ?? this.latestText);
        this.options.onTranscript({ text: this.latestText, isFinal: true });
        // The utterance is done; nothing further is coming after the commit.
        if (this.committed) this.stop();
        return;
      case "error":
        this.options.onError(`OpenAI: ${String(message.error?.message ?? "unknown error")}`);
        return;
      default:
        return;
    }
  }
}

function sessionConfig(): object {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: TARGET_SAMPLE_RATE },
          transcription: { model: MODEL_ID },
          // Push-to-talk owns the utterance boundary; no server VAD.
          turn_detection: null,
        },
      },
    },
  };
}

/**
 * Streaming 16 kHz -> 24 kHz PCM16LE upsampler (linear interpolation, exact
 * 2:3 ratio). Keeps the last sample and fractional phase across chunks so
 * chunk boundaries don't glitch. Linear interpolation adds a little imaging
 * noise above 8 kHz, which is irrelevant to speech recognition.
 */
class PcmUpsampler {
  private prev = 0;
  private havePrev = false;
  // Output position between prev and the next input sample, in input-sample
  // units; advances by inputRate/outputRate per emitted sample.
  private phase = 0;

  process(bytes: Uint8Array): Uint8Array {
    const sampleCount = bytes.length >> 1;
    const step = CLOUD_STT_SAMPLE_RATE / TARGET_SAMPLE_RATE;
    // Phase starts each input interval at < 1 and advances by 2/3, so the
    // inner loop emits at most 2 outputs per input sample.
    const out = new Uint8Array(sampleCount * 2 * 2);
    let outBytes = 0;
    for (let i = 0; i < sampleCount; i++) {
      let sample = bytes[2 * i]! | (bytes[2 * i + 1]! << 8);
      if (sample >= 0x8000) sample -= 0x10000;
      if (!this.havePrev) {
        this.havePrev = true;
        this.prev = sample;
        continue;
      }
      while (this.phase < 1) {
        const value = Math.round(this.prev + this.phase * (sample - this.prev));
        out[outBytes++] = value & 0xff;
        out[outBytes++] = (value >> 8) & 0xff;
        this.phase += step;
      }
      this.phase -= 1;
      this.prev = sample;
    }
    return out.subarray(0, outBytes);
  }
}
