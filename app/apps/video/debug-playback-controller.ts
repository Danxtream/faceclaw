import type { AppContext } from "../app-definition";
import { H264BufferedReader } from "../../native/h264-stream-reader";
import {
  h264BeginStream,
  h264EndStream,
  h264PresentedSequence,
  h264QueueNal,
  h264SetFrameInterval,
  h264SetScale2x,
  h264Start,
  h264StreamSummary,
} from "../../native/h264";
import { pairedMp4Path } from "../../native/g2-video-library";
import { VideoAudioClock } from "../../native/video-audio";
import { configuredVideoScale2x } from "./video-settings";

const DEBUG_TARGET_FPS = 30;
const DEBUG_TARGET_INTERVAL_MS = 1000 / DEBUG_TARGET_FPS;

const DEBUG_START_ATTEMPTS = 4;
const DEBUG_START_RETRY_MS = 300;

const DEBUG_SAMPLE_MS = 5_000;
const DEBUG_FINAL_WAIT_MS = 30_000;
const DEBUG_FINAL_POLL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function isVcl(type: number): boolean {
  return type === 1 || type === 5;
}

function bytesEqual(
  a: Uint8Array | null,
  b: Uint8Array,
): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

type DebugStreamItem = {
  nal: Uint8Array;
  type: number;
  frameIndex: number | null;
};

/**
 * Deliberately simple H264 throughput harness.
 *
 * There is no host-side frame clock. The firmware is asked to
 * present at a 30 FPS ceiling, while the phone feeds NALs as
 * quickly as the real H264 queue accepts them.
 *
 * Slow presentation is a measurement, not an error.
 */
export class DebugVideoPlaybackController {
  private readonly reader: H264BufferedReader;

  private readonly audioPath:
    string | null;

  private readonly audio =
    new VideoAudioClock();

  private readonly scale2x =
    configuredVideoScale2x();

  private audioPrepared =
    false;

  private playing =
    false;

  private stopping =
    false;

  private stopped =
    false;

  private streamBegun =
    false;

  private streamId =
    0;

  private nextSequence =
    1;

  private nextFrameIndex =
    0;

  private lastVclSequence =
    0;

  private lastSps:
    Uint8Array | null =
    null;

  private lastPps:
    Uint8Array | null =
    null;

  private readonly sequenceToFrame =
    new Map<number, number>();

  private pumpPromise:
    Promise<void> | null =
    null;

  private releaseScreenAwake:
    (() => void) | null =
    null;

  private startedAtMs =
    0;

  private lastSampleAtMs =
    0;

  constructor(
    private readonly ctx: Pick<
      AppContext,
      "appendLog" | "acquireScreenAwakeLease"
    >,
    readonly filePath: string,
    private readonly onEnded: () => void,
  ) {
    this.reader =
      new H264BufferedReader(
        filePath,
      );

    this.audioPath =
      pairedMp4Path(
        filePath,
      );

    if (this.audioPath) {
      try {
        const durationMs =
          this.audio.prepare(
            this.audioPath,
          );

        this.audioPrepared =
          durationMs > 0;
      } catch (error) {
        this.ctx.appendLog(
          `VIDEO_DEBUG_AUDIO_UNAVAILABLE error=${error}`,
        );

        this.audio.release();
      }
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isActive(): boolean {
    return (
      !this.stopping &&
      !this.stopped
    );
  }

  get pauseOverlaySelection(): 0 {
    return 0;
  }

  async start(): Promise<void> {
    if (
      this.playing ||
      this.stopping ||
      this.stopped
    ) {
      return;
    }

    (
      globalThis as any
    ).__faceclawVideoOwnsDisplay =
      true;

    this.releaseScreenAwake =
      this.ctx.acquireScreenAwakeLease();

    this.reader.seekToOffset(0);

    this.streamId =
      (
        (
          Date.now() ^
          Math.floor(
            Math.random() *
            0xffffffff
          )
        ) >>> 0
      ) || 1;

    try {
      if (
        !h264BeginStream(
          this.streamId,
        )
      ) {
        throw new Error(
          "H264 transport stream could not begin",
        );
      }

      this.streamBegun =
        true;

      await this.startStreamWithRetry();

      if (
        !(
          await h264SetScale2x(
            this.scale2x,
          )
        )
      ) {
        throw new Error(
          "H264 display-size selection failed",
        );
      }

      if (
        !(
          await h264SetFrameInterval(
            DEBUG_TARGET_INTERVAL_MS,
          )
        )
      ) {
        throw new Error(
          "H264 30 FPS debug presentation interval failed",
        );
      }

      if (this.audioPrepared) {
        this.audio.seekTo(0);
        this.audio.start();
      }

      this.startedAtMs =
        Date.now();

      this.lastSampleAtMs =
        this.startedAtMs;

      this.playing =
        true;

      this.ctx.appendLog(
        `VIDEO_DEBUG_START ` +
          `targetFps=${DEBUG_TARGET_FPS} ` +
          `intervalMs=${Math.round(DEBUG_TARGET_INTERVAL_MS)} ` +
          `audioLoad=${this.audioPrepared} ` +
          `mode=MAX_THROUGHPUT`,
      );

      this.pumpPromise =
        this.pump();
    } catch (error) {
      this.ctx.appendLog(
        `VIDEO_DEBUG_START_FAILED error=${error}`,
      );

      await this.cleanupStartFailure();

      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopping =
      true;

    this.playing =
      false;

    if (this.audioPrepared) {
      this.audio.pause();
    }

    const pump =
      this.pumpPromise;

    this.pumpPromise =
      null;

    if (pump) {
      await pump.catch(
        () => undefined,
      );
    }

    await this.endStreamWithoutWaiting();

    this.audio.release();
    this.reader.close();

    const release =
      this.releaseScreenAwake;

    this.releaseScreenAwake =
      null;

    release?.();

    (
      globalThis as any
    ).__faceclawVideoOwnsDisplay =
      false;

    this.stopped =
      true;

    this.ctx.appendLog(
      "VIDEO_DEBUG_STOP restart=false",
    );
  }

  async pause(): Promise<void> {
    this.ctx.appendLog(
      "VIDEO_DEBUG_CONTROL_IGNORED action=pause",
    );
  }

  async resume(): Promise<void> {
    this.ctx.appendLog(
      "VIDEO_DEBUG_CONTROL_IGNORED action=resume",
    );
  }

  async seekBy(
    _deltaMs: number,
  ): Promise<void> {
    this.ctx.appendLog(
      "VIDEO_DEBUG_CONTROL_IGNORED action=seek",
    );
  }

  async setPauseOverlaySelection(
    _selection: number,
  ): Promise<void> {
    // Intentionally empty.
  }

  private async startStreamWithRetry():
    Promise<void> {

    for (
      let attempt = 1;
      attempt <=
        DEBUG_START_ATTEMPTS;
      attempt++
    ) {
      if (
        await h264Start(
          this.streamId,
        )
      ) {
        if (attempt > 1) {
          this.ctx.appendLog(
            `VIDEO_DEBUG_START_RECOVERED attempt=${attempt}`,
          );
        }

        return;
      }

      this.ctx.appendLog(
        `VIDEO_DEBUG_START_RETRY ` +
          `attempt=${attempt}/${DEBUG_START_ATTEMPTS}`,
      );

      if (
        attempt <
        DEBUG_START_ATTEMPTS
      ) {
        await sleep(
          DEBUG_START_RETRY_MS,
        );
      }
    }

    throw new Error(
      `H264 START failed after ${DEBUG_START_ATTEMPTS} attempts`,
    );
  }

  private nextItem():
    DebugStreamItem | null {

    while (true) {
      const source =
        this.reader.nextNal();

      if (!source) {
        return null;
      }

      const type =
        source.type;

      // Match the production transport cleanup.
      if (
        type === 6 ||
        type === 9
      ) {
        continue;
      }

      if (type === 7) {
        if (
          bytesEqual(
            this.lastSps,
            source.nal,
          )
        ) {
          continue;
        }

        this.lastSps =
          new Uint8Array(
            source.nal,
          );
      } else if (type === 8) {
        if (
          bytesEqual(
            this.lastPps,
            source.nal,
          )
        ) {
          continue;
        }

        this.lastPps =
          new Uint8Array(
            source.nal,
          );
      }

      const frameIndex =
        isVcl(type)
          ? this.nextFrameIndex++
          : null;

      return {
        nal: source.nal,
        type,
        frameIndex,
      };
    }
  }

  private async queueItem(
    item: DebugStreamItem,
  ): Promise<void> {

    const sequence =
      this.nextSequence++;

    if (
      item.frameIndex !==
      null
    ) {
      this.sequenceToFrame.set(
        sequence,
        item.frameIndex,
      );

      this.lastVclSequence =
        sequence;
    }

    const accepted =
      await h264QueueNal(
        item.nal,
        this.streamId,
        sequence,
      );

    if (!accepted) {
      throw new Error(
        `H264 queue stopped accepting data ` +
          `sequence=${sequence} ` +
          `frame=${item.frameIndex ?? -1} ` +
          `type=${item.type} ` +
          `bytes=${item.nal.length}`,
      );
    }
  }

  private async pump():
    Promise<void> {

    try {
      while (!this.stopping) {
        const item =
          this.nextItem();

        if (!item) {
          break;
        }

        /*
         * Deliberately no sleep and no source-FPS clock here.
         *
         * h264QueueNal's real queue/backpressure is the throttle.
         */
        await this.queueItem(
          item,
        );

        this.sampleIfDue();
      }

      if (this.stopping) {
        return;
      }

      /*
       * Input has been completely queued. Do not restart or
       * reinterpret slow presentation as failure. Allow the real
       * queue to finish naturally.
       */
      const deadline =
        Date.now() +
        DEBUG_FINAL_WAIT_MS;

      while (
        !this.stopping &&
        this.lastVclSequence > 0 &&
        this.safePresentedSequence() <
          this.lastVclSequence &&
        Date.now() <
          deadline
      ) {
        this.sampleIfDue();

        await sleep(
          DEBUG_FINAL_POLL_MS,
        );
      }

      if (this.stopping) {
        return;
      }

      this.logResult(
        "complete",
      );

      this.playing =
        false;

      if (this.audioPrepared) {
        this.audio.pause();
      }
    } catch (error) {
      if (!this.stopping) {
        this.ctx.appendLog(
          `VIDEO_DEBUG_TRANSPORT_STOP error=${error}`,
        );

        this.logResult(
          "transport-stop",
        );

        this.playing =
          false;

        if (
          this.audioPrepared
        ) {
          this.audio.pause();
        }
      }
    } finally {
      if (!this.stopping) {
        await this.endStreamWithoutWaiting();

        setTimeout(
          () => this.onEnded(),
          0,
        );
      }
    }
  }

  private safePresentedSequence():
    number {

    try {
      return (
        h264PresentedSequence() >>>
        0
      );
    } catch {
      return 0;
    }
  }

  private presentedFrame():
    number | null {

    const presentedSequence =
      this.safePresentedSequence();

    let bestSequence =
      -1;

    let bestFrame:
      number | null =
      null;

    for (
      const [
        sequence,
        frame,
      ] of this.sequenceToFrame
    ) {
      if (
        sequence <=
          presentedSequence &&
        sequence >
          bestSequence
      ) {
        bestSequence =
          sequence;

        bestFrame =
          frame;
      }
    }

    return bestFrame;
  }

  private sampleIfDue():
    void {

    const now =
      Date.now();

    if (
      now -
        this.lastSampleAtMs <
      DEBUG_SAMPLE_MS
    ) {
      return;
    }

    this.lastSampleAtMs =
      now;

    /*
     * The paired MP4 is NOT a clock here.
     * Its only purpose is maintaining the same Android media /
     * Bluetooth-headphone workload during an audio benchmark.
     */
    if (
      this.audioPrepared &&
      !this.audio.isPlaying
    ) {
      this.audio.seekTo(0);
      this.audio.start();

      this.ctx.appendLog(
        "VIDEO_DEBUG_AUDIO_RESTART loadOnly=true",
      );
    }

    const frame =
      this.presentedFrame();

    const presentedFrames =
      frame === null
        ? 0
        : frame + 1;

    const elapsedMs =
      Math.max(
        1,
        now -
          this.startedAtMs,
      );

    const fps =
      presentedFrames *
      1000 /
      elapsedMs;

    this.ctx.appendLog(
      `VIDEO_DEBUG_SAMPLE ` +
        `elapsedMs=${elapsedMs} ` +
        `presentedFrames=${presentedFrames} ` +
        `queuedFrames=${this.nextFrameIndex} ` +
        `avgFps=${fps.toFixed(2)} ` +
        `audioLoad=${this.audioPrepared}`,
    );
  }

  private logResult(
    reason: string,
  ): void {

    const frame =
      this.presentedFrame();

    const frames =
      frame === null
        ? 0
        : frame + 1;

    const elapsedMs =
      Math.max(
        1,
        Date.now() -
          this.startedAtMs,
      );

    const fps =
      frames *
      1000 /
      elapsedMs;

    const presentedSequence =
      this.safePresentedSequence();

    const allPresented =
      this.lastVclSequence > 0 &&
      presentedSequence >=
        this.lastVclSequence;

    let summary =
      "unavailable";

    try {
      summary =
        h264StreamSummary();
    } catch {
      // Telemetry is optional in benchmark mode.
    }

    this.ctx.appendLog(
      `VIDEO_DEBUG_RESULT ` +
        `reason=${reason} ` +
        `allPresented=${allPresented} ` +
        `frames=${frames} ` +
        `queuedFrames=${this.nextFrameIndex} ` +
        `elapsedMs=${elapsedMs} ` +
        `fps=${fps.toFixed(2)} ` +
        `targetFps=${DEBUG_TARGET_FPS} ` +
        `audioLoad=${this.audioPrepared} ` +
        `presentedSeq=${presentedSequence} ` +
        `lastVclSeq=${this.lastVclSequence}`,
    );

    this.ctx.appendLog(
      `VIDEO_DEBUG_TRANSPORT_SUMMARY ${summary}`,
    );
  }

  private async endStreamWithoutWaiting():
    Promise<void> {

    if (!this.streamBegun) {
      return;
    }

    try {
      const ended =
        await h264EndStream()
          .catch(
            () => false,
          );

      this.ctx.appendLog(
        `VIDEO_DEBUG_END result=${ended}`,
      );
    } finally {
      this.streamBegun =
        false;
    }
  }

  private async cleanupStartFailure():
    Promise<void> {

    this.playing =
      false;

    this.stopping =
      true;

    if (this.audioPrepared) {
      this.audio.pause();
    }

    await this.endStreamWithoutWaiting();

    this.audio.release();
    this.reader.close();

    const release =
      this.releaseScreenAwake;

    this.releaseScreenAwake =
      null;

    release?.();

    (
      globalThis as any
    ).__faceclawVideoOwnsDisplay =
      false;

    this.stopped =
      true;
  }
}