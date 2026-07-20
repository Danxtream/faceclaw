import { Utils } from "@nativescript/core";

import { CloudSttClient } from "./cloud-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

export type VoiceControlState = {
  status: string;
};

export type VoiceProviderKind = "onboard" | "elevenlabs" | "whisper";

export type VoiceTranscriptEvent = {
  /**
   * Complete best transcript of the current utterance. REPLACE semantics —
   * render as-is, replacing any previous partial. Not a delta.
   */
  text: string;
  isFinal: boolean;
};

export type PushToTalkOptions = {
  communicator: any;
  provider: VoiceProviderKind;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  saveRecording: boolean;
  /**
   * Watch the mic and fire onSpeechEnd when the speaker stops. For hands-free
   * ("Hey Even") capture, which has no button release to end the utterance.
   * Ignored when the mic is already running for another holder.
   */
  endpointing?: boolean;
};

/** Who currently wants the mic running. */
type CaptureHolder = "ptt" | "continuous";

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly wakeWordListeners = new Set<(keyword: string) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private readonly speechEndListeners = new Set<() => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private started = false;
  // The mic is a single shared stream; these are the reasons it is running.
  // The first holder starts capture (choosing the provider); the mic stops
  // when the last one releases. Transcript events broadcast to every
  // listener, so push-to-talk and the Transcribe window both receive text.
  private readonly captureHolders = new Set<CaptureHolder>();
  // Non-null while a cloud provider owns the transcript; Java only decodes PCM.
  private cloudClient: CloudSttClient | null = null;

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener({ status: this.status });
    return () => this.statusListeners.delete(listener);
  }

  onWakeWord(listener: (keyword: string) => void): () => void {
    this.wakeWordListeners.add(listener);
    return () => this.wakeWordListeners.delete(listener);
  }

  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  /**
   * The speaker stopped, in a hands-free session. Only fires when the capture
   * was started with `endpointing: true`.
   */
  onSpeechEnd(listener: () => void): () => void {
    this.speechEndListeners.add(listener);
    return () => this.speechEndListeners.delete(listener);
  }

  /** Begin push-to-talk capture (momentary; released with stopPushToTalk). */
  startPushToTalk(options: PushToTalkOptions): void {
    this.acquireCapture("ptt", options);
  }

  /** End push-to-talk: for cloud, commit for a final result if it was the last holder. */
  stopPushToTalk(): void {
    this.releaseCapture("ptt", true);
  }

  /** Begin continuous capture (Transcribe): the mic stays on until released. */
  startContinuousCapture(options: PushToTalkOptions): void {
    this.acquireCapture("continuous", options);
  }

  stopContinuousCapture(): void {
    this.releaseCapture("continuous", false);
  }

  private acquireCapture(holder: CaptureHolder, options: PushToTalkOptions): void {
    if (!global.isAndroid) return;
    const wasIdle = this.captureHolders.size === 0;
    this.captureHolders.add(holder);
    if (!wasIdle) {
      // Mic already running; the new holder just shares the existing stream
      // (transcripts are already broadcast to its listeners).
      return;
    }
    this.ensureController();
    this.controller?.setCommunicator(options.communicator);
    this.controller?.setSaveRecordings(options.saveRecording);
    this.controller?.setEndpointing(Boolean(options.endpointing));

    const cloudClient = this.createCloudClient(options);
    if (cloudClient) {
      this.cloudClient = cloudClient;
      cloudClient.start();
      this.started = true;
      this.controller?.start("cloud");
      return;
    }

    this.cloudClient = null;
    this.started = true;
    this.controller?.start("onboard");
  }

  /**
   * The cloud provider for this session, or null to transcribe on-device.
   * A cloud provider whose API key is missing falls back to on-device rather
   * than failing the capture outright.
   */
  private createCloudClient(options: PushToTalkOptions): CloudSttClient | null {
    if (options.provider === "onboard") return null;
    const sttOptions = {
      apiKey: "",
      onTranscript: (event: { text: string; isFinal: boolean }) =>
        this.emitTranscript(event.text, event.isFinal),
      onStatus: (status: string) => this.setStatus(status),
      onError: (message: string) => this.setStatus(message),
    };
    if (options.provider === "elevenlabs") {
      const apiKey = options.elevenLabsApiKey.trim();
      if (!apiKey) {
        this.setStatus("No ElevenLabs key set; using on-device voice.");
        return null;
      }
      return new ElevenLabsSttClient({ ...sttOptions, apiKey });
    }
    const apiKey = options.openAiApiKey.trim();
    if (!apiKey) {
      this.setStatus("No OpenAI key set; using on-device voice.");
      return null;
    }
    return new OpenAiRealtimeSttClient({ ...sttOptions, apiKey });
  }

  private releaseCapture(holder: CaptureHolder, commit: boolean): void {
    if (!this.captureHolders.delete(holder)) {
      // Never held; still finish a dangling cloud commit if one is pending.
      if (commit) this.cloudClient?.finish();
      return;
    }
    if (this.captureHolders.size > 0) {
      // Another holder still wants the mic; keep it running.
      return;
    }
    if (!this.started) {
      this.cloudClient?.finish();
      return;
    }
    // Order matters for cloud: stopping the Java controller flushes any final
    // decode/PCM; then commit so the provider finalizes the transcript.
    this.controller?.stop();
    this.started = false;
    if (commit) {
      this.cloudClient?.finish();
    } else {
      this.cloudClient?.stop();
      this.cloudClient = null;
    }
  }

  stop(): void {
    this.captureHolders.clear();
    if (global.isAndroid) {
      this.controller?.stop();
    }
    this.started = false;
    this.cloudClient?.stop();
    this.cloudClient = null;
    this.setStatus("Voice control stopped.");
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawVoiceController(context);
    this.listenerProxy = new com.faceclaw.app.FaceclawVoiceControllerListener({
      onStatus: (status: string) => {
        this.setStatus(String(status));
      },
      onWakeWord: (keyword: string) => {
        for (const listener of this.wakeWordListeners) {
          listener(String(keyword));
        }
      },
      onTranscript: (text: string, isFinal: boolean) => {
        this.emitTranscript(String(text), Boolean(isFinal));
      },
      onPcm: (pcm: any) => {
        this.cloudClient?.acceptPcm(toUint8Array(pcm));
      },
      onSpeechEnd: () => {
        for (const listener of this.speechEndListeners) {
          listener();
        }
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private emitTranscript(text: string, isFinal: boolean): void {
    const event = { text, isFinal };
    for (const listener of this.transcriptListeners) {
      listener(event);
    }
  }

  private setStatus(status: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener({ status });
    }
  }
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();
