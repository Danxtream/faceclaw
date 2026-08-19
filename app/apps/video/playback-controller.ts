import type { AppContext } from "../app-definition";
import { H264BufferedReader } from "../../native/h264-stream-reader";
import {
  h264BeginStream,
  h264Drain,
  h264EndStream,
  h264PresentedSequence,
  h264QueueNal,
  h264Reset,
  h264SetFrameInterval,
  h264SetScale2x,
  h264Start,
} from "../../native/h264";
import { pairedMp4Path, resumePositionFor, saveVideoResumeState } from "../../native/g2-video-library";
import { VideoAudioClock } from "../../native/video-audio";
import { configuredVideoFps, configuredVideoScale2x } from "./video-settings";
import { videoPlaybackState, type VideoPlaybackSnapshot } from "./video-playback-state";

const V24_DEGRADED_STARTUP_GRACE_MS = 15_000;
const V24_HARD_STARTUP_GRACE_MS = 2_500;
const V24_ZERO_PROGRESS_MS = 2_500;
const V24_ZERO_PROGRESS_POLL_MS = 500;
const V25_RESUME_SAVE_INTERVAL_MS = 1_500;
const V25_SESSION_SETTLE_MS = 2_500;
const V25_SESSION_SAMPLE_MS = 5_000;
const V25_MAX_AUTO_RETRIES = 2;
const V25_HEALTH_RATIO = 0.70;
const V25_AUDIO_RESUME_CUSHION_MS = 50;
const POLL_MS = 12;
const QUEUE_LEAD_FRAMES = 3;
const RESUME_SAVE_INTERVAL_MS = 4_000;
const MAX_SYNC_DRIFT_MIN_MS = 80;
const SEEK_FAST_PACE_MS = 16;
const PARAMETER_PROBE_NALS = 128;
const SEQUENCE_MAP_SOFT_LIMIT = 256;
const H264_START_ATTEMPTS = 4;
const H264_START_RETRY_MS = 300;
const G2_REPAIR_GOP_FRAMES = 128;
const CLEAN_RESTART_SETTLE_MS = 150;
const DEGRADED_WINDOW_MS = 5_000;
const DEGRADED_MIN_FPS_RATIO = 0.45;
const DEGRADED_RECOVERY_WINDOW_MS = 60_000;
const MAX_DEGRADED_RECOVERIES_PER_WINDOW = 3;
const AUDIO_SYNC_RELAPSE_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVclNal(type: number): boolean {
  return type === 1 || type === 5;
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function formatPlaybackTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

type StreamItem = {
  nal: Uint8Array;
  type: number;
  frameIndex: number | null;
};

type SequenceMeta = {
  sequence: number;
  frameIndex: number | null;
  type: number;
  bytes: number;
};

export type PauseOverlaySelection = 0 | 1 | 2 | 3 | 4;

export class VideoPlaybackController {

  // V25_CANONICAL_CONTROL
  private readonly v25BoundedRecoveryOnly = true;

  private v25CanonicalMs = 0;
  private v25NeedsFreshResume = false;
  private v25PauseSettling: Promise<void> | null = null;

  private v25LastResumeSaveMs = 0;

  private v25QualificationTimer: any = null;
  private v25QualificationToken = 0;
  private v25AutoRetryCount = 0;
  private v25SessionHealthy = false;
  private v25SessionRecoveryInFlight = false;

  private v25StopRequested = false;

  // V24_RUNTIME_STABILITY
  private v24PausedStreamClosed = false;
  private v24DegradedGraceUntilMs = 0;
  private v24HardGraceUntilMs = 0;

  private v24ProgressTimer: any = null;
  private v24LastPresentedSequence = 0;
  private v24LastProgressAtMs = 0;
  private v24HardRecoveryInFlight = false;

  private v24DurableResumeMs = 0;

  private v24TransitionTail: Promise<void> =
    Promise.resolve();

  private readonly reader: H264BufferedReader;
  private readonly audioPath: string | null;
  private readonly audio = new VideoAudioClock();
  private readonly configuredFps = configuredVideoFps();
  private readonly scale2x = configuredVideoScale2x();
  private readonly frameDurationMs = 1000 / this.configuredFps;
  private durationMs: number;
  private audioPrepared = false;

  private firstSps: Uint8Array | null = null;
  private firstPps: Uint8Array | null = null;
  private lastSps: Uint8Array | null = null;
  private lastPps: Uint8Array | null = null;
  private nextFrameIndex = 0;

  private generation = 0;
  private streamBegun = false;
  private streamId = 0;
  private nextSequence = 1;
  private readonly sequenceToMeta = new Map<number, SequenceMeta>();

  private playing = false;
  private stopping = false;
  private positionMs = 0;
  private wallClockAnchorMs = 0;
  private wallMediaAnchorMs = 0;
  private audioHeldForSync = false;
  private lastResumeSaveMs = 0;
  private pumpPromise: Promise<void> | null = null;
  private overlaySelection: PauseOverlaySelection = 0;
  private lastPublishedAtMs = 0;
  private releaseScreenAwake: (() => void) | null = null;
  private controlTail: Promise<void> = Promise.resolve();
  private lastRecoveryFrame: number | null = null;
  private healthWindowStartedAtMs = 0;
  private healthWindowStartFrame: number | null = null;
  private lastAudioSyncResumeAtMs = 0;
  private degradedRecoveryTimes: number[] = [];

  constructor(
    private readonly ctx: Pick<AppContext, "appendLog" | "acquireScreenAwakeLease">,
    readonly filePath: string,
    private readonly onEnded: () => void,
    private readonly onExitRequested: () => void,
  ) {
    this.reader = new H264BufferedReader(filePath);
    this.cacheInitialParameterSets();

    this.audioPath = pairedMp4Path(filePath);
    let audioDurationMs = 0;
    if (this.audioPath) {
      try {
        audioDurationMs = this.audio.prepare(this.audioPath);
        this.audioPrepared = audioDurationMs > 0;
      } catch (error) {
        this.ctx.appendLog(`paired MP4 audio unavailable: ${error}`);
        this.audio.release();
      }
    }

    // Paired MP4 remains the authoritative duration/audio clock. Unlike the
    // old implementation, paired playback does not count every H264 frame at
    // startup. The elementary stream is consumed incrementally at configured
    // FPS. Standalone H264 still gets a native buffered frame-count scan so it
    // retains a useful duration without loading the file into JS memory.
    if (this.audioPrepared && audioDurationMs > 0) {
      this.durationMs = audioDurationMs;
      this.ctx.appendLog(
        `video streaming: ${(this.reader.bufferSize / 1024).toFixed(0)} KiB buffer, ${this.configuredFps} fps, MP4 duration ${(audioDurationMs / 1000).toFixed(2)}s`,
      );
    } else {
      const scanStarted = Date.now();
      const frameCount = this.reader.countFrames();
      if (frameCount <= 0) throw new Error("H264 stream contains no VCL frames");
      this.durationMs = frameCount * this.frameDurationMs;
      this.ctx.appendLog(
        `standalone H264 scan: ${frameCount} frames in ${Date.now() - scanStarted}ms; ${(this.reader.bufferSize / 1024).toFixed(0)} KiB playback buffer`,
      );
    }

    this.positionMs = Math.min(this.durationMs, resumePositionFor(filePath));
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isActive(): boolean {
    return !this.stopping;
  }

  get pauseOverlaySelection(): PauseOverlaySelection {
    return this.overlaySelection;
  }

  get currentPositionMs(): number {
    if (this.audioPrepared && (this.playing || this.audioHeldForSync)) {
      return Math.min(this.durationMs, this.audio.currentPositionMs);
    }
    if (this.playing && !this.audioPrepared) {
      return Math.min(this.durationMs, this.wallMediaAnchorMs + (Date.now() - this.wallClockAnchorMs));
    }
    return Math.min(this.durationMs, this.positionMs);
  }

  async startV233(): Promise<void> {
    return this.runControl(() => this.startInternal());
  }

  async togglePause(): Promise<void> {
    return this.runControl(async () => {
      if (this.playing) await this.pauseInternal();
      else await this.resumeInternal();
    });
  }

  async pauseV233(): Promise<void> {
    return this.runControl(() => this.pauseInternal());
  }

  async resumeV233(): Promise<void> {
    return this.runControl(() => this.resumeInternal());
  }

  async seekBy(deltaMs: number): Promise<void> {
    return this.runControl(() => this.seekToInternal(this.currentPositionMs + deltaMs));
  }

  async seekToV233(targetMs: number): Promise<void> {
    return this.runControl(() => this.seekToInternal(targetMs));
  }

  async setPauseOverlaySelection(selection: PauseOverlaySelection): Promise<void> {
    return this.runControl(async () => {
      this.overlaySelection = selection;
      if (!this.playing) await this.refreshPauseOverlay();
    });
  }

  async stopV233(): Promise<void> {
    return this.runControl(() => this.stopInternal());
  }

  private runControl(operation: () => Promise<void>): Promise<void> {
    const run = this.controlTail.then(operation, operation);
    this.controlTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInternal(): Promise<void> {
    (globalThis as any).__faceclawVideoOwnsDisplay = true;
    this.publish("starting", true);
    this.releaseScreenAwake = this.ctx.acquireScreenAwakeLease();
    this.lastRecoveryFrame = null;
    try {
      await this.rebuildAt(this.positionMs, false);
      await this.resumeInternal();
    } catch (error) {
      await this.stopInternal().catch(() => undefined);
      throw error;
    }
  }

  private async pauseInternal(): Promise<void> {
    if (!this.playing || this.stopping) return;
    const fallbackPosition = this.currentPositionMs;
    this.playing = false;
    this.audioHeldForSync = false;
    if (this.audioPrepared) this.audio.pause();
    this.generation++;
    await this.waitForPumpStop();

    const pauseDrainOk = await h264Drain().catch(() => false);
    this.ctx.appendLog(`PHONE_PAUSE_DRAIN result=${pauseDrainOk}`);
    this.positionMs = this.presentedMediaMs() ?? fallbackPosition;
    if (this.audioPrepared) this.audio.seekTo(this.positionMs);
    saveVideoResumeState(this.filePath, this.positionMs);
    await this.refreshPauseOverlay();
    this.publish("paused", true);
  }

  private async resumeInternal(): Promise<void> {
    if (this.playing || this.stopping) return;
    this.playing = true;
    this.audioHeldForSync = false;
    this.lastAudioSyncResumeAtMs = 0;
    this.resetPlaybackHealth();
    this.ctx.appendLog("PHONE_RESUME_NO_FIRMWARE_OVERLAY");
    if (this.audioPrepared) {
      this.audio.seekTo(this.positionMs);
      this.audio.start();
    } else {
      this.wallMediaAnchorMs = this.positionMs;
      this.wallClockAnchorMs = Date.now();
    }
    this.publish("playing", true);
    const generation = this.generation;
    this.pumpPromise = this.pump(generation);
  }

  private async seekToInternal(targetMs: number): Promise<void> {
    if (this.stopping) return;
    const resumeAfterSeek = this.playing;
    const target = Math.max(0, Math.min(this.durationMs, Math.round(targetMs)));
    this.lastRecoveryFrame = null;
    this.degradedRecoveryTimes = [];
    this.lastAudioSyncResumeAtMs = 0;
    this.playing = false;
    this.audioHeldForSync = false;
    if (this.audioPrepared) this.audio.pause();
    this.generation++;

    // Publish the requested target immediately so the phone timer follows the
    // scrubber instead of showing the old playback position during the scan.
    this.positionMs = target;
    this.publish("seeking", true);

    await this.waitForPumpStop();
    this.resetPlaybackHealth();
    await this.rebuildAt(target, !resumeAfterSeek, true, "seek");

    this.overlaySelection = 0;
    if (this.audioPrepared) this.audio.seekTo(this.positionMs);
    saveVideoResumeState(this.filePath, this.positionMs);

    if (resumeAfterSeek) {
      await this.resumeInternal();
    } else {
      await this.refreshPauseOverlay();
      this.publish("paused", true);
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.stopping) return;
    const fallbackPosition = this.currentPositionMs;
    this.stopping = true;
    this.playing = false;
    this.generation++;
    if (this.audioPrepared) this.audio.pause();

    try {
      await this.waitForPumpStop();
      if (this.streamBegun) await h264Drain().catch(() => false);
      const finalPosition = this.presentedMediaMs() ?? fallbackPosition;
      saveVideoResumeState(this.filePath, finalPosition);
      this.ctx.appendLog("PHONE_STOP_NO_FIRMWARE_OVERLAY");
      await this.endCurrentStream();
    } finally {
      this.audio.release();
      this.reader.close();
      const releaseScreenAwake = this.releaseScreenAwake;
      this.releaseScreenAwake = null;
      releaseScreenAwake?.();
      (globalThis as any).__faceclawVideoOwnsDisplay = false;
      videoPlaybackState.clear();
    }
  }

  private cacheInitialParameterSets(): void {
    this.reader.seekToOffset(0);
    let sawFrame = false;

    for (let i = 0; i < PARAMETER_PROBE_NALS; i++) {
      const item = this.reader.nextNal();
      if (!item) break;
      if (item.type === 7 && !this.firstSps) this.firstSps = new Uint8Array(item.nal);
      if (item.type === 8 && !this.firstPps) this.firstPps = new Uint8Array(item.nal);
      if (isVclNal(item.type)) {
        sawFrame = true;
        break;
      }
    }

    this.reader.seekToOffset(0);
    if (!sawFrame) throw new Error("H264 stream contains no VCL frame near the beginning");
  }

  private async rebuildAt(
    targetMs: number,
    remainPaused: boolean,
    cleanRestart = false,
    reason = "rebuild",
  ): Promise<void> {
    this.v24DegradedGraceUntilMs =
      Date.now() + V24_DEGRADED_STARTUP_GRACE_MS;
    this.v24HardGraceUntilMs =
      Date.now() + V24_HARD_STARTUP_GRACE_MS;
    this.v24ResetProgressBaseline();
    if (cleanRestart && this.streamBegun) {
      const drained = await h264Drain().catch(() => false);
      this.ctx.appendLog(`H264 clean restart pre-drain reason=${reason} result=${drained}`);
    }
    await this.endCurrentStream();
    if (this.stopping) return;

    if (cleanRestart) {
      this.sequenceToMeta.clear();
      this.nextSequence = 1;
      await sleep(CLEAN_RESTART_SETTLE_MS);
      if (!(await h264Reset())) {
        throw new Error(`H264 RESET failed during clean restart: ${reason}`);
      }
      await sleep(CLEAN_RESTART_SETTLE_MS);
      this.ctx.appendLog(`H264 CLEAN RESTART reason=${reason} target=${formatPlaybackTime(targetMs)}`);
    }

    const maxFrameEstimate = Math.max(0, Math.ceil(this.durationMs / this.frameDurationMs) - 1);
    const targetFrame = Math.max(
      0,
      Math.min(maxFrameEstimate, Math.floor(targetMs / this.frameDurationMs)),
    );

    let startByteOffset = 0;
    let startFrameIndex = 0;
    if (targetFrame > 0) {
      const scanStarted = Date.now();
      const point = this.reader.findSeekPoint(targetFrame);
      if (!point.reachedTarget) {
        throw new Error(`Unable to locate H264 seek target frame ${targetFrame}`);
      }
      startByteOffset = point.byteOffset;
      startFrameIndex = point.frameIndex;
      this.ctx.appendLog(
        `H264 seek scan: frame ${targetFrame}, IDR ${startFrameIndex}, byte ${startByteOffset}, ${Date.now() - scanStarted}ms`,
      );
    }

    this.reader.seekToOffset(startByteOffset);
    this.nextFrameIndex = startFrameIndex;
    this.lastSps = null;
    this.lastPps = null;

    this.streamId = ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
    if (!h264BeginStream(this.streamId)) throw new Error("H264 transport stream could not begin");
    this.streamBegun = true;
    await this.beginH264StreamWithRetry();
    if (!(await h264SetScale2x(this.scale2x))) throw new Error("H264 display-size selection failed");

    const seeking = targetFrame > startFrameIndex;
    const normalPace = Math.max(16, Math.min(1000, Math.round(this.frameDurationMs)));
    if (!(await h264SetFrameInterval(seeking ? SEEK_FAST_PACE_MS : normalPace))) {
      throw new Error("H264 firmware pacing selection failed");
    }

    this.nextSequence = 1;
    this.sequenceToMeta.clear();

    // Starting at an IDR in the middle of the file requires the initial codec
    // parameter sets because the raw H264 stream may not repeat them there.
    if (startByteOffset > 0) {
      if (this.firstSps) {
        this.lastSps = new Uint8Array(this.firstSps);
        await this.queueOne(this.firstSps, 7, null);
      }
      if (this.firstPps) {
        this.lastPps = new Uint8Array(this.firstPps);
        await this.queueOne(this.firstPps, 8, null);
      }
    }

    let displayedTargetFrame: number | null = null;
    while (true) {
      const item = this.nextPlayableNal();
      if (!item) break;
      await this.queueOne(item.nal, item.type, item.frameIndex);
      if (item.frameIndex !== null && item.frameIndex >= targetFrame) {
        displayedTargetFrame = item.frameIndex;
        break;
      }
    }

    if (displayedTargetFrame === null) {
      throw new Error("Unable to locate seek target frame in H264 stream");
    }
    await this.waitForPresentedFrame(displayedTargetFrame);

    if (seeking && !(await h264SetFrameInterval(normalPace))) {
      throw new Error("H264 normal pacing restore failed after seek");
    }

    this.positionMs = Math.min(this.durationMs, displayedTargetFrame * this.frameDurationMs);
    if (this.audioPrepared) this.audio.seekTo(this.positionMs);
    if (remainPaused) await this.refreshPauseOverlay();
  }

  private nextPlayableNal(): StreamItem | null {
    while (true) {
      const source = this.reader.nextNal();
      if (!source) return null;
      const type = source.type;

      // AUD/SEI are not needed by the G2 decoder path.
      if (type === 9 || type === 6) continue;

      if (type === 7) {
        if (bytesEqual(this.lastSps, source.nal)) continue;
        this.lastSps = new Uint8Array(source.nal);
      } else if (type === 8) {
        if (bytesEqual(this.lastPps, source.nal)) continue;
        this.lastPps = new Uint8Array(source.nal);
      }

      const frameIndex = isVclNal(type) ? this.nextFrameIndex++ : null;
      return { nal: source.nal, type, frameIndex };
    }
  }

  private async queueOne(nal: Uint8Array, type: number, frameIndex: number | null): Promise<void> {
    const sequence = this.nextSequence++;
    const meta: SequenceMeta = { sequence, frameIndex, type, bytes: nal.length };
    this.sequenceToMeta.set(sequence, meta);
    this.pruneSequenceMap();
    if (!(await h264QueueNal(nal, this.streamId, sequence))) {
      throw new Error(
        `H264 queue failed: sequence=${sequence} frame=${frameIndex ?? -1} type=${type} bytes=${nal.length}`,
      );
    }
  }

  private pruneSequenceMap(): void {
    if (this.sequenceToMeta.size <= SEQUENCE_MAP_SOFT_LIMIT) return;
    const presented = h264PresentedSequence();
    const keepFrom = presented > 0 ? Math.max(1, presented - 32) : Math.max(1, this.nextSequence - 192);
    for (const sequence of this.sequenceToMeta.keys()) {
      if (sequence < keepFrom) this.sequenceToMeta.delete(sequence);
    }
  }

  private firstUnpresentedMeta(): SequenceMeta | null {
    const presented = h264PresentedSequence();
    let best: SequenceMeta | null = null;
    for (const meta of this.sequenceToMeta.values()) {
      if (meta.sequence <= presented || meta.frameIndex === null) continue;
      if (!best || meta.sequence < best.sequence) best = meta;
    }
    return best;
  }

  private async waitForPresentedFrame(targetFrame: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const frame = this.presentedFrameIndex();
      if (frame !== null && frame >= targetFrame) return;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for H264 frame ${targetFrame}`);
  }

  private presentedFrameIndex(): number | null {
    const sequence = h264PresentedSequence();
    if (sequence <= 0) return null;
    let bestSequence = -1;
    let bestFrame: number | null = null;
    for (const meta of this.sequenceToMeta.values()) {
      if (meta.frameIndex !== null && meta.sequence <= sequence && meta.sequence > bestSequence) {
        bestSequence = meta.sequence;
        bestFrame = meta.frameIndex;
      }
    }
    return bestFrame;
  }

  private presentedMediaMs(): number | null {
    const frame = this.presentedFrameIndex();
    return frame === null ? null : Math.min(this.durationMs, frame * this.frameDurationMs);
  }

  private async pump(generation: number): Promise<void> {
    try {
      while (!this.stopping && this.playing && generation === this.generation) {
        const item = this.nextPlayableNal();
        if (!item) {
          if (!(await h264Drain())) {
            throw new Error("H264 final drain failed");
          }
          if (!this.stopping && generation === this.generation) {
            this.positionMs = this.durationMs;
            saveVideoResumeState(this.filePath, 0);
            if (this.audioPrepared) this.audio.pause();
            this.playing = false;
            this.publish("complete", true);
            this.positionMs = 0;
            setTimeout(() => this.onEnded(), 0);
          }
          return;
        }

        if (item.frameIndex !== null) {
          const targetMs = item.frameIndex * this.frameDurationMs;
          const leadMs = QUEUE_LEAD_FRAMES * this.frameDurationMs;
          while (!this.stopping && this.playing && generation === this.generation) {
            const clockMs = this.currentPositionMs;
            if (targetMs <= clockMs + leadMs) break;
            await this.updateAudioSyncHold();
            await sleep(Math.min(25, Math.max(4, targetMs - (clockMs + leadMs))));
          }
        }

        if (this.stopping || !this.playing || generation !== this.generation) return;
        await this.queueOne(item.nal, item.type, item.frameIndex);
        await this.updateAudioSyncHold();
        const degraded = this.checkPlaybackHealth();
        if (degraded) throw new Error(degraded);
        const presentedAfterQueue = this.presentedFrameIndex();
        if (
          this.lastRecoveryFrame !== null &&
          presentedAfterQueue !== null &&
          presentedAfterQueue > this.lastRecoveryFrame + 8
        ) {
          this.ctx.appendLog(
            `video playback recovery confirmed past frame ${this.lastRecoveryFrame} at ${presentedAfterQueue}`,
          );
          this.lastRecoveryFrame = null;
        }
        this.publish("playing");
        this.persistResumeOccasionally();
      }
    } catch (error) {
      if (!this.stopping && generation === this.generation) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (errorText.startsWith("VIDEO_DEGRADED")) {
          const recoveryMs = this.presentedMediaMs() ?? this.currentPositionMs;
          this.ctx.appendLog(errorText);
          this.playing = false;
          this.audioHeldForSync = false;
          this.lastAudioSyncResumeAtMs = 0;
          if (this.audioPrepared) this.audio.pause();
          this.publish("recovering", true);

          const failureGeneration = generation;
          setTimeout(() => {
            void this.runControl(async () => {
              if (this.stopping || this.generation !== failureGeneration) return;
              await this.recoverDegradedPlayback(recoveryMs, errorText);
            }).catch((recoveryError) => {
              if (this.stopping) return;
              this.ctx.appendLog(`VIDEO_DEGRADED recovery failed: ${recoveryError}`);
              this.publish(`failed: ${recoveryError}`, true);
            });
          }, 0);
          return;
        }

        const presentedSequence = h264PresentedSequence();
        const stall = this.firstUnpresentedMeta();
        const stallFrame = stall?.frameIndex ?? null;
        const stallMs = stallFrame === null ? this.currentPositionMs : stallFrame * this.frameDurationMs;
        const typeLabel = stall ? `${stall.type}${stall.type === 5 ? "/IDR" : ""}` : "unknown";
        this.ctx.appendLog(
          `VIDEO STALL presentedSeq=${presentedSequence} seq=${stall?.sequence ?? -1} frame=${stallFrame ?? -1} time=${formatPlaybackTime(stallMs)} type=${typeLabel} nal=${stall?.bytes ?? -1}B error=${error}`,
        );
        this.playing = false;
        this.audioHeldForSync = false;
        this.lastAudioSyncResumeAtMs = 0;
        if (this.audioPrepared) this.audio.pause();
        this.publish("recovering", true);

        const failureGeneration = generation;
        setTimeout(() => {
          void this.runControl(async () => {
            if (this.stopping || this.generation !== failureGeneration) return;
            await this.recoverPlaybackStall(stall, stallMs);
          }).catch((recoveryError) => {
            if (this.stopping) return;
            this.ctx.appendLog(`video playback recovery failed: ${recoveryError}`);
            this.publish(`failed: ${recoveryError}`, true);
          });
        }, 0);
      }
    }
  }

  private async beginH264StreamWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= H264_START_ATTEMPTS; attempt++) {
      if (await h264Start(this.streamId)) {
        if (attempt > 1) {
          this.ctx.appendLog(`H264 START recovered on attempt ${attempt}/${H264_START_ATTEMPTS}`);
        }
        return;
      }
      this.ctx.appendLog(`H264 START attempt ${attempt}/${H264_START_ATTEMPTS} failed`);
      if (attempt < H264_START_ATTEMPTS) await sleep(H264_START_RETRY_MS);
    }
    throw new Error(`H264 START failed after ${H264_START_ATTEMPTS} attempts`);
  }

  private async recoverPlaybackStall(stall: SequenceMeta | null, fallbackMs: number): Promise<void> {
    const stallFrame = stall?.frameIndex ?? null;
    const repeatedExactFrame = stallFrame !== null && this.lastRecoveryFrame === stallFrame;

    let targetMs = Math.max(0, Math.min(this.durationMs, fallbackMs));
    if (repeatedExactFrame && stallFrame !== null) {
      const maxFrameEstimate = Math.max(0, Math.ceil(this.durationMs / this.frameDurationMs) - 1);
      const skipToFrame = Math.min(
        maxFrameEstimate,
        (Math.floor(stallFrame / G2_REPAIR_GOP_FRAMES) + 1) * G2_REPAIR_GOP_FRAMES,
      );
      targetMs = Math.min(this.durationMs, skipToFrame * this.frameDurationMs);
      this.ctx.appendLog(
        `DETERMINISTIC_MEDIA_STALL frame=${stallFrame} time=${formatPlaybackTime(
          stallFrame * this.frameDurationMs,
        )} type=${stall?.type ?? -1}${stall?.type === 5 ? "/IDR" : ""} nal=${
          stall?.bytes ?? -1
        }B skipToFrame=${skipToFrame} skipToTime=${formatPlaybackTime(targetMs)}`,
      );
      this.lastRecoveryFrame = null;
    } else {
      this.lastRecoveryFrame = stallFrame;
      const presentedMs = this.presentedMediaMs();
      if (presentedMs !== null) targetMs = presentedMs;
      this.ctx.appendLog(
        `video playback recovery: restart=${formatPlaybackTime(targetMs)} suspectFrame=${stallFrame ?? -1}`,
      );
    }

    this.generation++;
    await this.rebuildAt(targetMs, false, true, repeatedExactFrame ? "deterministic-skip" : "stall-recovery");
    await this.resumeInternal();
  }

  private resetPlaybackHealth(): void {
    this.healthWindowStartedAtMs = Date.now();
    this.healthWindowStartFrame = this.presentedFrameIndex();
  }

  private checkPlaybackHealth(): string | null {
    // V25_CANONICAL_CONTROL:
    // legacy auto recovery is intentionally disabled.
    // V2.5 performs bounded startup qualification instead.
    if (this.v25BoundedRecoveryOnly) return;
    // V2.4: do not let the 5-second degraded window turn startup
    // into a repeated reset loop. Once startup grace expires,
    // the existing V2.3 degraded watchdog works normally.
    if (Date.now() < this.v24DegradedGraceUntilMs) return;
    if (!this.playing) return null;
    const now = Date.now();
    const frame = this.presentedFrameIndex();
    if (frame === null) return null;

    if (this.healthWindowStartedAtMs <= 0 || this.healthWindowStartFrame === null) {
      this.healthWindowStartedAtMs = now;
      this.healthWindowStartFrame = frame;
      return null;
    }

    const elapsedMs = now - this.healthWindowStartedAtMs;
    if (elapsedMs < DEGRADED_WINDOW_MS) return null;

    const frameDelta = Math.max(0, frame - this.healthWindowStartFrame);
    const presentedFps = frameDelta * 1000 / Math.max(1, elapsedMs);
    this.healthWindowStartedAtMs = now;
    this.healthWindowStartFrame = frame;

    const minimumFps = Math.max(1.5, this.configuredFps * DEGRADED_MIN_FPS_RATIO);
    if (presentedFps >= minimumFps) return null;

    return `VIDEO_DEGRADED presentedFps=${presentedFps.toFixed(2)} targetFps=${this.configuredFps.toFixed(
      2,
    )} frame=${frame} time=${formatPlaybackTime(frame * this.frameDurationMs)} audioHeld=${this.audioHeldForSync}`;
  }

  private async recoverDegradedPlayback(recoveryMs: number, reason: string): Promise<void> {
    const now = Date.now();
    this.degradedRecoveryTimes = this.degradedRecoveryTimes.filter(
      (timeMs) => now - timeMs <= DEGRADED_RECOVERY_WINDOW_MS,
    );
    if (this.degradedRecoveryTimes.length >= MAX_DEGRADED_RECOVERIES_PER_WINDOW) {
      this.ctx.appendLog(
        `VIDEO_DEGRADED_GIVEUP recoveries=${this.degradedRecoveryTimes.length} windowMs=${DEGRADED_RECOVERY_WINDOW_MS} reason=${reason}`,
      );
      this.publish("failed: repeated degraded transport", true);
      return;
    }

    this.degradedRecoveryTimes.push(now);
    const targetMs = Math.max(0, Math.min(this.durationMs, recoveryMs));
    this.ctx.appendLog(
      `VIDEO_DEGRADED_RECOVERY attempt=${this.degradedRecoveryTimes.length}/${MAX_DEGRADED_RECOVERIES_PER_WINDOW} restart=${formatPlaybackTime(
        targetMs,
      )}`,
    );
    this.lastRecoveryFrame = null;
    this.lastAudioSyncResumeAtMs = 0;
    this.generation++;
    await this.rebuildAt(targetMs, false, true, "degraded-throughput");
    await this.resumeInternal();
  }

  private async updateAudioSyncHoldV24Rejected(): Promise<void> {
    // V2.4 startup stabilization:
    // Keep the existing V2.3 audio-sync system, but during the
    // startup grace window audio is allowed to HOLD only.
    // It cannot resume/thrash/restart H264 until the new session
    // has had time to establish stable BLE throughput.
    if (Date.now() < this.v24DegradedGraceUntilMs) {
      if (!this.audioPrepared || !this.playing) return;

      const videoMs = this.presentedMediaMs();
      if (videoMs === null) return;

      const audioMs = this.audio.currentPositionMs;
      const maxDrift = Math.max(
        MAX_SYNC_DRIFT_MIN_MS,
        this.frameDurationMs * 1.5,
      );

      const lag = audioMs - videoMs;

      if (
        !this.audioHeldForSync &&
        lag > maxDrift
      ) {
        this.audio.pause();
        this.audioHeldForSync = true;

        this.ctx.appendLog(
          `VIDEO_STARTUP_RELAPSE_SUPPRESSED action=hold lagMs=${Math.round(
            lag,
          )} remainingMs=${Math.max(
            0,
            this.v24DegradedGraceUntilMs - Date.now(),
          )}`,
        );
      }

      return;
    }

    if (!this.audioPrepared || !this.playing) return;
    const videoMs = this.presentedMediaMs();
    if (videoMs === null) return;
    const audioMs = this.audio.currentPositionMs;
    const maxDrift = Math.max(MAX_SYNC_DRIFT_MIN_MS, this.frameDurationMs * 1.5);
    const lag = audioMs - videoMs;
    const now = Date.now();

    if (!this.audioHeldForSync && lag > maxDrift) {
      if (
        this.lastAudioSyncResumeAtMs > 0 &&
        now - this.lastAudioSyncResumeAtMs < AUDIO_SYNC_RELAPSE_MS
      ) {
        throw new Error(
          `VIDEO_DEGRADED audioSyncRelapseMs=${now - this.lastAudioSyncResumeAtMs} lagMs=${lag.toFixed(
            0,
          )} video=${formatPlaybackTime(videoMs)}`,
        );
      }
      this.audio.pause();
      this.audioHeldForSync = true;
      this.ctx.appendLog(`audio sync hold: video lag ${lag.toFixed(0)}ms`);
      return;
    }
    if (this.audioHeldForSync && lag <= this.frameDurationMs * 0.5) {
      this.audio.start();
      this.audioHeldForSync = false;
      this.lastAudioSyncResumeAtMs = now;
      this.ctx.appendLog(`audio sync resume: lag ${lag.toFixed(0)}ms`);
    }
  }

  private async refreshPauseOverlay(): Promise<void> {
    // Phone controls are authoritative for now.
    // Leave the last decoded H264 frame on the glasses.
    this.ctx.appendLog("PHONE_PAUSE_NO_FIRMWARE_OVERLAY");
  }

  private persistResumeOccasionallyV233(): void {
    const now = Date.now();
    if (now - this.lastResumeSaveMs < RESUME_SAVE_INTERVAL_MS) return;
    this.lastResumeSaveMs = now;
    saveVideoResumeState(this.filePath, this.presentedMediaMs() ?? this.currentPositionMs);
  }

  private async waitForPumpStop(): Promise<void> {
    const pump = this.pumpPromise;
    this.pumpPromise = null;
    if (!pump) return;
    try {
      await pump;
    } catch {
      // The pump reports playback failures through publish/logging.
    }
  }

  private async endCurrentStream(): Promise<void> {
    if (!this.streamBegun) return;
    try {
      await h264EndStream();
    } finally {
      this.streamBegun = false;
      this.sequenceToMeta.clear();
    }
  }

  private publish(status: string, force = false): void {
    const now = Date.now();
    if (!force && status === "playing" && now - this.lastPublishedAtMs < 250) return;
    this.lastPublishedAtMs = now;
    const positionMs = this.currentPositionMs;
    const snapshot: VideoPlaybackSnapshot = {
      active: !this.stopping,
      filePath: this.filePath,
      audioPath: this.audioPath,
      playing: this.playing,
      positionMs,
      durationMs: this.durationMs,
      fps: this.configuredFps,
      status: `${status} | ${formatPlaybackTime(positionMs)} / ${formatPlaybackTime(this.durationMs)}`,
    };
    videoPlaybackState.publish(snapshot, {
      togglePause: () => this.togglePause(),
      seekBy: (deltaMs) => this.seekBy(deltaMs),
      seekTo: (positionMs) => this.seekTo(positionMs),
      stop: () => this.onExitRequested(),
    });
  }


  async startV24Rejected(): Promise<void> {
    const priorResume = Math.max(
      0,
      Math.min(
        this.durationMs,
        resumePositionFor(this.filePath),
      ),
    );

    this.v24DurableResumeMs = priorResume;

    try {
      await this.startV233();
      this.v24ArmProgressWatch();
    } catch (error) {
      // V2.3 recovery/start failure must never erase a valid
      // persisted resume location with a startup 0.
      if (priorResume > 0) {
        saveVideoResumeState(
          this.filePath,
          priorResume,
        );

        this.ctx.appendLog(
          `VIDEO_RESUME_RESTORE_AFTER_START_FAILURE positionMs=${priorResume}`,
        );
      }

      throw error;
    }
  }

  async pauseV24Rejected(): Promise<void> {
    return this.v24RunTransition(
      () => this.v24PauseInternal(),
    );
  }

  private async v24PauseInternal(): Promise<void> {
    if (!this.playing || this.stopping) return;

    await this.pauseV233();

    const pausedAt =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    this.positionMs = Math.max(
      0,
      Math.min(this.durationMs, pausedAt),
    );

    this.v24PersistResume(
      this.positionMs,
      "pause",
      false,
    );

    // Do not leave an H264 decoder/transport session sitting
    // idle for an arbitrary pause duration. The framebuffer
    // stays on the last decoded image; Play will build a fresh
    // H264 stream at this exact saved location.
    if (this.streamBegun) {
      await this.endCurrentStream().catch(
        (error) => {
          this.ctx.appendLog(
            `VIDEO_PAUSE_END_STREAM_FAILED error=${error}`,
          );
        },
      );
    }

    this.v24PausedStreamClosed = true;
    this.v24ResetProgressBaseline();

    this.ctx.appendLog(
      `VIDEO_PAUSE_STREAM_CLOSED positionMs=${Math.round(
        this.positionMs,
      )}`,
    );

    this.publish("paused", true);
  }

  async resumeV24Rejected(): Promise<void> {
    return this.v24RunTransition(
      () => this.v24ResumeInternal(),
    );
  }

  private async v24ResumeInternal(): Promise<void> {
    if (this.playing || this.stopping) return;

    if (this.v24PausedStreamClosed) {
      await this.rebuildAt(
        this.positionMs,
        true,
        true,
        "pause-resume",
      );

      this.v24PausedStreamClosed = false;

      this.ctx.appendLog(
        `VIDEO_PAUSE_FRESH_RESUME positionMs=${Math.round(
          this.positionMs,
        )}`,
      );
    }

    await this.resumeV233();

    this.v24ResetProgressBaseline();
    this.v24ArmProgressWatch();
  }

  async seekToV24Rejected(targetMs: number): Promise<void> {
    return this.v24RunTransition(
      () => this.v24SeekToInternal(targetMs),
    );
  }

  private async v24SeekToInternal(
    targetMs: number,
  ): Promise<void> {
    const requested = Math.max(
      0,
      Math.min(
        this.durationMs,
        Math.round(targetMs),
      ),
    );

    await this.seekToV233(requested);

    this.v24DegradedGraceUntilMs =
      Date.now() + V24_DEGRADED_STARTUP_GRACE_MS;

    this.v24HardGraceUntilMs =
      Date.now() + V24_HARD_STARTUP_GRACE_MS;

    const committed = Math.max(
      0,
      Math.min(
        this.durationMs,
        this.positionMs,
      ),
    );

    // A user seek is authoritative and may legitimately move
    // backward, so it is allowed to replace the durable resume
    // location.
    this.v24PersistResume(
      committed,
      "seek",
      true,
    );

    // If seek landed paused, use the same long-pause-safe model:
    // keep the displayed frame but close the H264 stream.
    if (!this.playing && this.streamBegun) {
      await this.endCurrentStream().catch(
        (error) => {
          this.ctx.appendLog(
            `VIDEO_PAUSED_SEEK_END_STREAM_FAILED error=${error}`,
          );
        },
      );

      this.v24PausedStreamClosed = true;
    } else {
      this.v24PausedStreamClosed = false;
    }

    this.v24ResetProgressBaseline();
  }

  async stopV24Rejected(): Promise<void> {
    return this.v24RunTransition(
      () => this.v24StopInternal(),
    );
  }

  private async v24StopInternal(): Promise<void> {
    const candidate =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    if (candidate > 1000) {
      this.v24PersistResume(
        candidate,
        "pre-stop",
        false,
      );
    }

    this.v24DisarmProgressWatch();

    try {
      await this.stopV233();
    } finally {
      // stopV233/recovery may have temporarily published or
      // saved position 0. Restore the last trustworthy position.
      if (this.v24DurableResumeMs > 1000) {
        saveVideoResumeState(
          this.filePath,
          this.v24DurableResumeMs,
        );

        this.ctx.appendLog(
          `VIDEO_RESUME_FINAL positionMs=${Math.round(
            this.v24DurableResumeMs,
          )}`,
        );
      }
    }
  }

  private persistResumeOccasionallyV24Rejected(): void {
    const now = Date.now();

    if (
      now - this.lastResumeSaveMs <
      RESUME_SAVE_INTERVAL_MS
    ) {
      return;
    }

    this.lastResumeSaveMs = now;

    const position =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    this.v24PersistResume(
      position,
      "periodic",
      false,
    );
  }

  private v24PersistResume(
    positionMs: number,
    reason: string,
    allowBackward: boolean,
  ): void {
    const position = Math.max(
      0,
      Math.min(
        this.durationMs,
        Math.round(positionMs),
      ),
    );

    // Recovery can jump to a preceding IDR or momentarily lose
    // presented-sequence mapping. Do not let such an internal
    // transition erase a later known-good resume point.
    //
    // Explicit user seek is the exception and is allowed to move
    // backward.
    if (
      !allowBackward &&
      this.v24DurableResumeMs > 2000 &&
      position + 2000 <
        this.v24DurableResumeMs
    ) {
      this.ctx.appendLog(
        `VIDEO_RESUME_REGRESSION_SUPPRESSED reason=${reason} candidate=${position} durable=${Math.round(
          this.v24DurableResumeMs,
        )}`,
      );

      return;
    }

    this.v24DurableResumeMs = position;

    saveVideoResumeState(
      this.filePath,
      position,
    );
  }

  private v24RunTransition(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.v24TransitionTail.then(
      operation,
      operation,
    );

    this.v24TransitionTail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private v24ResetProgressBaseline(): void {
    try {
      this.v24LastPresentedSequence =
        h264PresentedSequence();
    } catch {
      this.v24LastPresentedSequence = 0;
    }

    this.v24LastProgressAtMs = Date.now();
  }

  private v24ArmProgressWatch(): void {
    if (this.v24ProgressTimer !== null) return;

    this.v24ResetProgressBaseline();

    this.v24ProgressTimer = setInterval(
      () => {
        void this.v24PollProgressWatch();
      },
      V24_ZERO_PROGRESS_POLL_MS,
    );
  }

  private v24DisarmProgressWatch(): void {
    if (this.v24ProgressTimer === null) {
      return;
    }

    clearInterval(this.v24ProgressTimer);
    this.v24ProgressTimer = null;
  }

  private async v24PollProgressWatch(): Promise<void> {
    if (
      this.stopping ||
      !this.playing ||
      !this.streamBegun ||
      this.v24HardRecoveryInFlight ||
      Date.now() < this.v24HardGraceUntilMs
    ) {
      this.v24ResetProgressBaseline();
      return;
    }

    let sequence = 0;

    try {
      sequence = h264PresentedSequence();
    } catch {
      return;
    }

    if (
      sequence > 0 &&
      sequence !== this.v24LastPresentedSequence
    ) {
      this.v24LastPresentedSequence =
        sequence;

      this.v24LastProgressAtMs =
        Date.now();

      return;
    }

    const stalledMs =
      Date.now() -
      this.v24LastProgressAtMs;

    if (
      stalledMs <
      V24_ZERO_PROGRESS_MS
    ) {
      return;
    }

    const targetMs =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    this.v24HardRecoveryInFlight = true;

    this.v24LastProgressAtMs =
      Date.now();

    this.v24PersistResume(
      targetMs,
      "zero-progress",
      false,
    );

    this.ctx.appendLog(
      `VIDEO_ZERO_PROGRESS sequence=${sequence} stalledMs=${stalledMs} positionMs=${Math.round(
        targetMs,
      )}`,
    );

    try {
      // Reuse the already-proven V2.3 seek/clean-reset path.
      // This stays serialized with phone/glasses controls.
      await this.seekTo(targetMs);

      this.ctx.appendLog(
        `VIDEO_ZERO_PROGRESS_RECOVERY positionMs=${Math.round(
          this.positionMs,
        )}`,
      );
    } catch (error) {
      this.ctx.appendLog(
        `VIDEO_ZERO_PROGRESS_RECOVERY_FAILED error=${error}`,
      );
    } finally {
      this.v24HardRecoveryInFlight = false;

      this.v24DegradedGraceUntilMs =
        Date.now() +
        V24_DEGRADED_STARTUP_GRACE_MS;

      this.v24HardGraceUntilMs =
        Date.now() +
        V24_HARD_STARTUP_GRACE_MS;

      this.v24ResetProgressBaseline();
    }
  }


  async start(): Promise<void> {
    const saved = Math.max(
      0,
      Math.min(
        this.durationMs,
        resumePositionFor(this.filePath),
      ),
    );

    this.v25CanonicalMs = saved;
    this.positionMs = saved;

    this.v25AutoRetryCount = 0;
    this.v25SessionHealthy = false;
    this.v25StopRequested = false;

    this.ctx.appendLog(
      `VIDEO_V25_START savedMs=${Math.round(saved)}`,
    );

    try {
      // startV233 performs the proven clean initial rebuild.
      //
      // Its call to this.resume() resolves to the V2.5 resume
      // method below.
      await this.startV233();
    } catch (error) {
      if (this.v25CanonicalMs > 0) {
        saveVideoResumeState(
          this.filePath,
          this.v25CanonicalMs,
        );
      }

      throw error;
    }
  }

  async pause(): Promise<void> {
    if (
      !this.playing ||
      this.stopping
    ) {
      return;
    }

    this.v25CancelQualification();

    const anchor =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    //
    // Capture the position BEFORE changing clocks/state.
    //
    this.v25CommitPosition(
      anchor,
      "pause",
      false,
    );

    //
    // Pause is LOCAL ONLY.
    //
    // No h264Drain()
    // No h264EndStream()
    // No RESET
    // No rebuild
    // No pause-overlay command
    //
    this.playing = false;
    this.audioHeldForSync = false;

    if (this.audioPrepared) {
      this.audio.pause();
      this.audio.seekTo(
        this.v25CanonicalMs,
      );
    }

    this.positionMs =
      this.v25CanonicalMs;

    this.generation++;

    //
    // Do not make Pause wait on an in-flight BLE transfer.
    // This is intentionally asynchronous.
    //
    const settling =
      this.waitForPumpStop();

    this.v25PauseSettling =
      settling;

    void settling.finally(() => {
      if (
        this.v25PauseSettling ===
        settling
      ) {
        this.v25PauseSettling =
          null;
      }
    });

    this.v25NeedsFreshResume = true;

    saveVideoResumeState(
      this.filePath,
      this.v25CanonicalMs,
    );

    this.ctx.appendLog(
      `VIDEO_V25_PAUSE positionMs=${Math.round(
        this.v25CanonicalMs,
      )} h264Action=NONE`,
    );

    this.publish(
      "paused",
      true,
    );
  }

  async resume(): Promise<void> {
    if (
      this.playing ||
      this.stopping
    ) {
      return;
    }

    await this.v25AwaitPauseSettled();

    if (this.v25StopRequested) {
      return;
    }

    //
    // Manual Pause -> Play is a deliberate new-session attempt.
    //
    // This implements what was empirically helping when the
    // user tried Play/Pause several times.
    //
    if (this.v25NeedsFreshResume) {
      const anchor =
        this.v25CanonicalMs;

      this.ctx.appendLog(
        `VIDEO_V25_RESUME_FRESH requestedMs=${Math.round(
          anchor,
        )}`,
      );

      await this.rebuildAt(
        anchor,
        true,
        true,
        "v25-manual-resume",
      );

      this.positionMs =
        this.presentedMediaMs() ??
        this.positionMs;

      this.v25CommitPosition(
        this.positionMs,
        "manual-resume",
        false,
      );

      this.v25NeedsFreshResume =
        false;
    }

    this.v25AutoRetryCount = 0;
    this.v25SessionHealthy = false;

    await this.resumeV233();

    this.ctx.appendLog(
      `VIDEO_V25_PLAY positionMs=${Math.round(
        this.v25CanonicalMs,
      )}`,
    );

    this.v25ScheduleQualification(
      "play",
    );
  }

  async seekTo(
    targetMs: number,
  ): Promise<void> {
    if (this.stopping) return;

    await this.v25AwaitPauseSettled();

    const target = Math.max(
      0,
      Math.min(
        this.durationMs,
        Math.round(targetMs),
      ),
    );

    const wasPlaying =
      this.playing;

    this.v25CancelQualification();

    //
    // A user seek is authoritative.
    //
    // It is allowed to move backward.
    //
    this.v25CommitPosition(
      target,
      "user-seek-request",
      true,
    );

    //
    // The proven V2.3 seek implementation may start internally
    // from a preceding IDR, but it decodes forward to the target.
    //
    // That internal IDR NEVER replaces v25CanonicalMs.
    //
    this.v25NeedsFreshResume =
      false;

    await this.seekToV233(
      target,
    );

    const displayed =
      this.presentedMediaMs() ??
      this.positionMs ??
      target;

    this.positionMs =
      displayed;

    this.v25CommitPosition(
      displayed,
      "user-seek-displayed",
      true,
    );

    saveVideoResumeState(
      this.filePath,
      this.v25CanonicalMs,
    );

    this.ctx.appendLog(
      `VIDEO_V25_SEEK requestedMs=${target} displayedMs=${Math.round(
        displayed,
      )} playing=${this.playing}`,
    );

    //
    // If V2.3 preserved playing state, qualify this new H264
    // session. If the user remains paused, do not start any
    // automatic recovery work.
    //
    if (
      wasPlaying &&
      this.playing
    ) {
      this.v25AutoRetryCount = 0;
      this.v25SessionHealthy = false;

      this.v25ScheduleQualification(
        "seek",
      );
    } else {
      this.v25NeedsFreshResume =
        false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;

    //
    // Stop wins over every automatic session operation.
    //
    this.v25StopRequested = true;
    this.v25CancelQualification();

    const anchor =
      this.presentedMediaMs() ??
      this.currentPositionMs ??
      this.v25CanonicalMs;

    this.v25CommitPosition(
      anchor,
      "stop",
      false,
    );

    saveVideoResumeState(
      this.filePath,
      this.v25CanonicalMs,
    );

    this.ctx.appendLog(
      `VIDEO_V25_STOP positionMs=${Math.round(
        this.v25CanonicalMs,
      )}`,
    );

    await this.v25AwaitPauseSettled();

    try {
      await this.stopV233();
    } finally {
      //
      // stopV233 may observe a temporary internal/rebuild
      // position. Restore the user's canonical location.
      //
      if (
        this.v25CanonicalMs > 0
      ) {
        saveVideoResumeState(
          this.filePath,
          this.v25CanonicalMs,
        );
      }
    }
  }

  private persistResumeOccasionally(): void {
    const now = Date.now();

    if (
      now -
        this.v25LastResumeSaveMs <
      V25_RESUME_SAVE_INTERVAL_MS
    ) {
      return;
    }

    this.v25LastResumeSaveMs =
      now;

    const candidate =
      this.presentedMediaMs() ??
      this.currentPositionMs;

    this.v25CommitPosition(
      candidate,
      "periodic",
      false,
    );
  }

  private v25CommitPosition(
    positionMs: number,
    reason: string,
    allowBackward: boolean,
  ): void {
    if (
      !Number.isFinite(positionMs)
    ) {
      return;
    }

    const candidate = Math.max(
      0,
      Math.min(
        this.durationMs,
        Math.round(positionMs),
      ),
    );

    //
    // Internal recovery can briefly expose:
    //   - 0
    //   - preceding-IDR time
    //   - stale sequence-map time
    //
    // None of those may destroy a later known user position.
    //
    if (
      !allowBackward &&
      this.v25CanonicalMs > 3_000 &&
      candidate + 2_000 <
        this.v25CanonicalMs
    ) {
      this.ctx.appendLog(
        `VIDEO_V25_RESUME_REGRESSION_BLOCKED reason=${reason} candidateMs=${candidate} canonicalMs=${Math.round(
          this.v25CanonicalMs,
        )}`,
      );

      return;
    }

    this.v25CanonicalMs =
      candidate;

    saveVideoResumeState(
      this.filePath,
      candidate,
    );
  }

  private async v25AwaitPauseSettled(): Promise<void> {
    const settling =
      this.v25PauseSettling;

    if (!settling) return;

    try {
      await settling;
    } catch {
      // pump already logs its own failures
    }
  }

  private v25CancelQualification(): void {
    this.v25QualificationToken++;

    if (
      this.v25QualificationTimer !== null
    ) {
      clearTimeout(
        this.v25QualificationTimer,
      );

      this.v25QualificationTimer =
        null;
    }
  }

  private v25ScheduleQualification(
    reason: string,
  ): void {
    this.v25CancelQualification();

    if (
      this.stopping ||
      this.v25StopRequested ||
      !this.playing
    ) {
      return;
    }

    const token =
      this.v25QualificationToken;

    this.ctx.appendLog(
      `VIDEO_V25_SESSION_QUALIFY reason=${reason} attempt=${this.v25AutoRetryCount}/${V25_MAX_AUTO_RETRIES}`,
    );

    this.v25QualificationTimer =
      setTimeout(() => {
        if (
          token !==
            this.v25QualificationToken ||
          this.stopping ||
          this.v25StopRequested ||
          !this.playing
        ) {
          return;
        }

        let seq0 = 0;

        try {
          seq0 =
            h264PresentedSequence();
        } catch {
          seq0 = 0;
        }

        const startedAt =
          Date.now();

        this.v25QualificationTimer =
          setTimeout(() => {
            void this.v25FinishQualification(
              token,
              seq0,
              startedAt,
            );
          }, V25_SESSION_SAMPLE_MS);
      }, V25_SESSION_SETTLE_MS);
  }

  private async v25FinishQualification(
    token: number,
    seq0: number,
    startedAt: number,
  ): Promise<void> {
    if (
      token !==
        this.v25QualificationToken ||
      this.stopping ||
      this.v25StopRequested ||
      !this.playing ||
      this.v25SessionRecoveryInFlight
    ) {
      return;
    }

    let seq1 = 0;

    try {
      seq1 =
        h264PresentedSequence();
    } catch {
      seq1 = 0;
    }

    const elapsedMs = Math.max(
      1,
      Date.now() - startedAt,
    );

    const frames = Math.max(
      0,
      seq1 - seq0,
    );

    const fps =
      frames *
      1000 /
      elapsedMs;

    const healthyFloor =
      Math.max(
        4,
        this.configuredFps *
          V25_HEALTH_RATIO,
      );

    this.ctx.appendLog(
      `VIDEO_V25_SESSION_RESULT seq0=${seq0} seq1=${seq1} frames=${frames} elapsedMs=${elapsedMs} fps=${fps.toFixed(
        2,
      )} floor=${healthyFloor.toFixed(
        2,
      )} attempt=${this.v25AutoRetryCount}/${V25_MAX_AUTO_RETRIES}`,
    );

    if (fps >= healthyFloor) {
      this.v25SessionHealthy =
        true;

      this.ctx.appendLog(
        `VIDEO_V25_SESSION_HEALTHY fps=${fps.toFixed(
          2,
        )}`,
      );

      //
      // Critical:
      // once a session qualifies, no slow-throughput watchdog
      // is allowed to repeatedly destroy it later.
      //
      return;
    }

    if (
      this.v25AutoRetryCount >=
      V25_MAX_AUTO_RETRIES
    ) {
      this.ctx.appendLog(
        `VIDEO_V25_SESSION_GIVEUP fps=${fps.toFixed(
          2,
        )} retries=${this.v25AutoRetryCount}`,
      );

      //
      // Leave the session controllable.
      // No more automatic restarts.
      //
      return;
    }

    this.v25AutoRetryCount++;

    this.ctx.appendLog(
      `VIDEO_V25_SESSION_RETRY attempt=${this.v25AutoRetryCount}/${V25_MAX_AUTO_RETRIES} fps=${fps.toFixed(
        2,
      )}`,
    );

    await this.v25RetrySession();
  }

  private async v25RetrySession(): Promise<void> {
    if (
      this.stopping ||
      this.v25StopRequested ||
      !this.playing ||
      this.v25SessionRecoveryInFlight
    ) {
      return;
    }

    this.v25SessionRecoveryInFlight =
      true;

    this.v25CancelQualification();

    const anchor =
      this.presentedMediaMs() ??
      this.currentPositionMs ??
      this.v25CanonicalMs;

    this.v25CommitPosition(
      anchor,
      "bounded-session-retry",
      false,
    );

    this.playing = false;
    this.audioHeldForSync = false;

    if (this.audioPrepared) {
      this.audio.pause();
      this.audio.seekTo(
        this.v25CanonicalMs,
      );
    }

    this.generation++;

    try {
      await this.waitForPumpStop();

      if (
        this.stopping ||
        this.v25StopRequested
      ) {
        return;
      }

      await this.rebuildAt(
        this.v25CanonicalMs,
        true,
        true,
        `v25-auto-retry-${this.v25AutoRetryCount}`,
      );

      if (
        this.stopping ||
        this.v25StopRequested
      ) {
        return;
      }

      await this.resumeV233();

      this.ctx.appendLog(
        `VIDEO_V25_SESSION_RETRY_STARTED attempt=${this.v25AutoRetryCount}/${V25_MAX_AUTO_RETRIES} positionMs=${Math.round(
          this.v25CanonicalMs,
        )}`,
      );
    } catch (error) {
      this.ctx.appendLog(
        `VIDEO_V25_SESSION_RETRY_FAILED attempt=${this.v25AutoRetryCount} error=${error}`,
      );
    } finally {
      this.v25SessionRecoveryInFlight =
        false;
    }

    if (
      !this.stopping &&
      !this.v25StopRequested &&
      this.playing
    ) {
      this.v25ScheduleQualification(
        "auto-retry",
      );
    }
  }

  private async updateAudioSyncHold(): Promise<void> {
    if (
      !this.audioPrepared ||
      !this.playing
    ) {
      return;
    }

    const videoMs =
      this.presentedMediaMs();

    if (videoMs === null) {
      return;
    }

    const audioMs =
      this.audio.currentPositionMs;

    const maxDrift =
      Math.max(
        MAX_SYNC_DRIFT_MIN_MS,
        this.frameDurationMs * 1.5,
      );

    const lag =
      audioMs - videoMs;

    //
    // Audio synchronization NEVER causes H264 restart in V2.5.
    //
    if (
      !this.audioHeldForSync &&
      lag > maxDrift
    ) {
      this.audio.pause();
      this.audioHeldForSync = true;

      this.ctx.appendLog(
        `VIDEO_V25_AUDIO_HOLD lagMs=${Math.round(
          lag,
        )}`,
      );

      return;
    }

    if (this.audioHeldForSync) {
      const resumeAt =
        -Math.max(
          V25_AUDIO_RESUME_CUSHION_MS,
          this.frameDurationMs * 0.5,
        );

      if (lag <= resumeAt) {
        this.audio.start();
        this.audioHeldForSync = false;

        this.ctx.appendLog(
          `VIDEO_V25_AUDIO_RESUME lagMs=${Math.round(
            lag,
          )}`,
        );
      }
    }
  }
}
