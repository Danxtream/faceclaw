import { Utils } from "@nativescript/core";

import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

export type VoiceControlState = {
  status: string;
};

export type VoiceProviderKind = "onboard" | "elevenlabs";

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
  saveRecording: boolean;
};

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly wakeWordListeners = new Set<(keyword: string) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private started = false;
  // Non-null while a cloud provider owns the transcript; Java only decodes PCM.
  private cloudClient: ElevenLabsSttClient | null = null;

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

  /** Begin push-to-talk capture with the selected provider. */
  startPushToTalk(options: PushToTalkOptions): void {
    if (!global.isAndroid) return;
    if (this.started) this.stop();
    this.ensureController();
    this.controller?.setCommunicator(options.communicator);
    this.controller?.setSaveRecordings(options.saveRecording);

    if (options.provider === "elevenlabs" && options.elevenLabsApiKey.trim()) {
      this.cloudClient = new ElevenLabsSttClient({
        apiKey: options.elevenLabsApiKey.trim(),
        onTranscript: (event) => this.emitTranscript(event.text, event.isFinal),
        onStatus: (status) => this.setStatus(status),
        onError: (message) => this.setStatus(message),
      });
      this.cloudClient.start();
      this.started = true;
      this.controller?.start("cloud");
      return;
    }

    if (options.provider === "elevenlabs") {
      this.setStatus("No ElevenLabs key set; using on-device voice.");
    }
    this.cloudClient = null;
    this.started = true;
    this.controller?.start("onboard");
  }

  /** End push-to-talk: stop the mic and, for cloud, commit for a final result. */
  stopPushToTalk(): void {
    if (!this.started) {
      this.cloudClient?.finish();
      return;
    }
    // Order matters for cloud: stopping the Java controller flushes any final
    // decode/PCM; then commit so ElevenLabs finalizes the transcript. The
    // socket is closed once the committed transcript arrives, or on stop().
    this.controller?.stop();
    this.started = false;
    this.cloudClient?.finish();
  }

  stop(): void {
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
