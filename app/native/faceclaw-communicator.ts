import { ImageSource, Utils } from "@nativescript/core";
import * as frameTimings from "./frame-timings";

declare const com: any;

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

export type CommunicatorPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "charging"
  | "retrying"
  | "disconnecting";

export type CommunicatorState = {
  phase: CommunicatorPhase;
  status: string;
};

export type HeadsetBatteryState = {
  battery: number;
  chargingStatus: number;
};

export type FrameMetrics = {
  paintMs: number;
  transmitMs: number;
  tileCount: number;
};

export type FirmwareInfo = {
  leftVersion: string;
  rightVersion: string;
  capabilities: string;
};

/**
 * Compositor surface configuration. Position/size are in screen pixels;
 * surfaces composite in ascending zOrder onto a black background. A
 * "color-key" surface treats pixel value 0 as transparent and 1 as black
 * (painters must clamp intentional black to 1); "opaque" surfaces cover
 * their whole rect.
 */
export type SurfaceOptions = {
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  transparency: "opaque" | "color-key";
};

export type RawInputEvent =
  | {
      kind: "list-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      kind: "text-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      kind: "sys-event";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    };

function nonNegativeNumber(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export class FaceclawCommunicatorBridge {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private javaCallQueue: Promise<void> = Promise.resolve();
  private readonly frameMetricWaiters = new Set<(metrics: FrameMetrics) => void>();
  // Recent frame-finished outcomes from the Java side, so waitForFrameFinished
  // does not race against finishes that land before the wait starts.
  private readonly finishedFrameOutcomes = new Map<number, string>();
  private readonly frameFinishedWaiters = new Map<number, Set<(outcome: string) => void>>();
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: CommunicatorState) => void>();
  private readonly ringListeners = new Set<(event: RawInputEvent) => void>();
  private readonly batteryListeners = new Set<(state: HeadsetBatteryState) => void>();
  private readonly evenAppConflictListeners = new Set<(message: string) => void>();
  private readonly frameMetricsListeners = new Set<(metrics: FrameMetrics) => void>();
  private readonly firmwareInfoListeners = new Set<(info: FirmwareInfo) => void>();

  constructor(addresses: { right: string; left: string; ring?: string }) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.communicator = new com.faceclaw.app.FaceclawBleCommunicator(
      context,
      addresses.right,
      addresses.left,
      addresses.ring ?? "",
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawBleCommunicatorListener({
      onLog: (line: string) => {
        this.emitAsync(this.logListeners, String(line));
      },
      onStateChange: (phase: string, status: string) => {
        const state = {
          phase: String(phase) as CommunicatorPhase,
          status: String(status),
        };
        this.emitAsync(this.stateListeners, state);
      },
      onRingEvent: (
        kind: string,
        containerName: string,
        eventType: number,
        eventSource: number,
        systemExitReasonCode: number,
        frameId: number,
      ) => {
        const event = {
          kind: String(kind) as RawInputEvent["kind"],
          containerName: String(containerName),
          eventType: Number(eventType),
          eventSource: Number(eventSource),
          systemExitReasonCode: Number(systemExitReasonCode),
          frameId: Number(frameId),
        };
        frameTimings.logFrame(event.frameId, "input event received on JS side");
        this.emitAsync(this.ringListeners, event);
      },
      onBatteryState: (headsetBattery: number, headsetCharging: number) => {
        const state = {
          battery: Number(headsetBattery),
          chargingStatus: Number(headsetCharging),
        };
        this.emitAsync(this.batteryListeners, state);
      },
      onEvenAppConflict: (message: string) => {
        this.emitAsync(this.evenAppConflictListeners, String(message));
      },
      onFrameMetrics: (paintMs: number, transmitMs: number, tileCount: number) => {
        const metrics = {
          paintMs: nonNegativeNumber(paintMs),
          transmitMs: nonNegativeNumber(transmitMs),
          tileCount: nonNegativeNumber(tileCount),
        };
        const waiters = Array.from(this.frameMetricWaiters);
        this.frameMetricWaiters.clear();
        for (const waiter of waiters) {
          setTimeout(() => waiter(metrics), 0);
        }
        this.emitAsync(this.frameMetricsListeners, metrics);
      },
      onFrameFinished: (frameId: number, outcome: string) => {
        this.recordFrameFinished(Number(frameId), String(outcome));
      },
      onFirmwareInfo: (leftVersion: string, rightVersion: string, capabilities: string) => {
        const info = {
          leftVersion: String(leftVersion),
          rightVersion: String(rightVersion),
          capabilities: String(capabilities),
        };
        this.emitAsync(this.firmwareInfoListeners, info);
      },
    });
    this.communicator.setListener(this.listenerProxy);
  }

  private emitAsync<T>(listeners: Set<(value: T) => void>, value: T): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) {
        listener(value);
      }
    }, 0);
  }

  private enqueueJavaCall<T>(operation: () => T): Promise<T> {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(operation());
          } catch (error) {
            reject(error);
          }
        }, 0);
      });

    const result = this.javaCallQueue.then(run, run);
    this.javaCallQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: CommunicatorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onRingEvent(listener: (event: RawInputEvent) => void): () => void {
    this.ringListeners.add(listener);
    return () => this.ringListeners.delete(listener);
  }

  onBatteryState(listener: (state: HeadsetBatteryState) => void): () => void {
    this.batteryListeners.add(listener);
    return () => this.batteryListeners.delete(listener);
  }

  onEvenAppConflict(listener: (message: string) => void): () => void {
    this.evenAppConflictListeners.add(listener);
    return () => this.evenAppConflictListeners.delete(listener);
  }

  onFrameMetrics(listener: (metrics: FrameMetrics) => void): () => void {
    this.frameMetricsListeners.add(listener);
    return () => this.frameMetricsListeners.delete(listener);
  }

  onFirmwareInfo(listener: (info: FirmwareInfo) => void): () => void {
    this.firmwareInfoListeners.add(listener);
    return () => this.firmwareInfoListeners.delete(listener);
  }

  getNativeCommunicator(): any {
    return this.communicator;
  }

  private recordFrameFinished(frameId: number, outcome: string): void {
    if (!Number.isFinite(frameId) || frameId <= 0) return;
    this.finishedFrameOutcomes.set(frameId, outcome);
    while (this.finishedFrameOutcomes.size > 128) {
      const oldest = this.finishedFrameOutcomes.keys().next().value;
      if (oldest === undefined) break;
      this.finishedFrameOutcomes.delete(oldest);
    }
    const waiters = this.frameFinishedWaiters.get(frameId);
    if (waiters) {
      this.frameFinishedWaiters.delete(frameId);
      for (const waiter of waiters) {
        setTimeout(() => waiter(outcome), 0);
      }
    }
  }

  /**
   * Resolve with the frame's outcome once the Java side finishes it (sent,
   * discarded, or timed out), or with null after timeoutMs. Used as transmit
   * backpressure: unlike waiting for frame metrics, this also resolves when a
   * frame is discarded (e.g. deduped as unchanged), so no-op renders do not
   * stall the render loop.
   */
  waitForFrameFinished(frameId: number, timeoutMs: number): Promise<string | null> {
    const known = this.finishedFrameOutcomes.get(frameId);
    if (known !== undefined) return Promise.resolve(known);
    if (frameId <= 0) return Promise.resolve(null);
    const delayMs = Math.max(1, Math.round(nonNegativeNumber(timeoutMs)));
    return new Promise((resolve) => {
      let settled = false;
      const onFinished = (outcome: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(outcome);
      };
      let waiters = this.frameFinishedWaiters.get(frameId);
      if (!waiters) {
        waiters = new Set();
        this.frameFinishedWaiters.set(frameId, waiters);
      }
      waiters.add(onFinished);
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        const pending = this.frameFinishedWaiters.get(frameId);
        if (pending) {
          pending.delete(onFinished);
          if (pending.size === 0) this.frameFinishedWaiters.delete(frameId);
        }
        resolve(null);
      }, delayMs);
    });
  }

  waitForNextFrameMetrics(timeoutMs: number): Promise<FrameMetrics | null> {
    const delayMs = Math.max(1, Math.round(nonNegativeNumber(timeoutMs)));
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const complete = (metrics: FrameMetrics | null) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        this.frameMetricWaiters.delete(onMetrics);
        resolve(metrics);
      };
      const onMetrics = (metrics: FrameMetrics) => complete(metrics);
      this.frameMetricWaiters.add(onMetrics);
      timeoutHandle = setTimeout(() => complete(null), delayMs);
    });
  }

  async start(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.start());
  }

  async setG2ScreenOn(screenOn: boolean): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.setG2ScreenOn(Boolean(screenOn)));
  }

  async setFirmwareDebugFlags(enabled: boolean): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.setFirmwareDebugFlags(Boolean(enabled)));
  }

  /** Set the compositor's output frame size. Call before configuring surfaces. */
  async configureCompositorScreen(width: number, height: number): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.configureCompositorScreen(Math.round(width), Math.round(height));
    });
  }

  /** Phone-UI preview of the current composited screen, or null if none yet. */
  getCompositePreview(): ImageSource | null {
    if (!global.isAndroid) return null;
    const bitmap = this.communicator.getCompositePreviewBitmap(PREVIEW_BRIGHTEN_GAMMA);
    return bitmap ? new ImageSource(bitmap) : null;
  }

  /** Save the current composite as a raw 4bpp screenshot; returns the path (empty if none). */
  saveRawCompositeScreenshot(): string {
    if (!global.isAndroid) return "";
    return String(this.communicator.saveRawCompositeScreenshot());
  }

  /**
   * Create or reconfigure a compositor surface. Geometry changes take effect
   * when the next frame is submitted.
   */
  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    const transparency = options.transparency === "color-key" ? 1 : 0;
    await this.enqueueJavaCall(() => {
      this.communicator.configureSurface(
        id,
        Math.round(options.x),
        Math.round(options.y),
        Math.round(options.width),
        Math.round(options.height),
        Math.round(options.zOrder),
        transparency,
      );
    });
  }

  async removeSurface(id: string): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.removeSurface(id);
    });
  }

  /** Show or hide a compositor surface; takes effect at the next composite. */
  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.setSurfaceVisible(id, Boolean(visible));
    });
  }

  /**
   * Blank (screen off) or unblank the composited output; retained surface
   * state survives, so unblanking restores the screen without repaints.
   */
  async setScreenBlanked(blanked: boolean): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.setScreenBlanked(Boolean(blanked));
    });
  }

  /**
   * Apply an update covering rect (in surface-local coordinates) to a surface
   * and submit the recomposited screen to the glasses. pixels8bpp holds
   * rect.width*rect.height bytes, row-major; fingerprint identifies the
   * surface's full content after the update.
   */
  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    fingerprint: string,
    paintMs = -1,
    frameId = 0,
  ): Promise<void> {
    // Snapshot because the Java call is deferred; the buffer is passed as an
    // ArrayBuffer, which NativeScript marshals to a ByteBuffer without the
    // ~150ms per-element copy a byte[] parameter would need.
    const snapshot = new Uint8Array(pixels8bpp);
    await this.enqueueJavaCall(() => {
      this.communicator.submitSurfaceFrame(
        snapshot.buffer,
        surfaceId,
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
        fingerprint,
        Math.round(nonNegativeNumber(paintMs)),
        Math.round(nonNegativeNumber(frameId)),
      );
    });
  }

  async disconnect(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.disconnect());
  }

  async sendShutdown(exitMode = 0): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.sendShutdown(exitMode)));
  }

  /** Play a CFW mode-5 kind-4 tone sequence (complete wire payload). */
  async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    const snapshot = new Uint8Array(payload);
    await this.enqueueJavaCall(() => {
      this.communicator.playBuzzerSequence(snapshot.buffer);
    });
  }

  async close(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.close());
  }
}
