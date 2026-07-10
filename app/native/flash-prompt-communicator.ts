import { Utils } from "@nativescript/core";

declare const com: any;

export type FlashPromptState =
  | "connecting"
  | "connected"
  | "prompting"
  | "result"
  | "cancelled"
  | "timeout"
  | "disconnected"
  | "error";

/**
 * TS wrapper around the native FaceclawFlashPromptCommunicator — the
 * stock-firmware-compatible BLE path that shows the pre-flash confirmation on
 * the glasses and reports the user's Yes/No choice. Separate from
 * FaceclawCommunicatorBridge on purpose (different, minimal protocol subset).
 */
export class FlashPromptCommunicator {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: FlashPromptState, detail: string) => void>();
  private readonly resultListeners = new Set<(approved: boolean) => void>();

  constructor(addresses: { right: string; left: string }, warningText: string) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.communicator = new com.faceclaw.app.FaceclawFlashPromptCommunicator(
      context,
      addresses.right,
      addresses.left,
      warningText,
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawFlashPromptListener({
      onLog: (line: string) => this.emit(this.logListeners, String(line)),
      onState: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as FlashPromptState, String(detail ?? "")),
      onResult: (approved: boolean) => this.emit(this.resultListeners, Boolean(approved)),
    });
    this.communicator.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: FlashPromptState, detail: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onResult(listener: (approved: boolean) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  start(): void {
    this.communicator.start();
  }

  cancel(): void {
    this.communicator.cancel();
  }

  close(): void {
    this.communicator.close();
  }

  private emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) {
        listener(...args);
      }
    }, 0);
  }
}
