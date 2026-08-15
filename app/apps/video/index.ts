import { action } from "@nativescript/core";

import { type AppDefinition } from "../app-definition";
import { openVideoPicker } from "../../native/video-picker";
import { readH264File } from "../../native/h264-file";
import { splitAnnexBNals } from "../../native/annex-b";
import {
  h264BeginStream,
  h264Drain,
  h264EndStream,
  h264OrientationProbe,
  h264Probe,
  h264QueueNal,
  h264SetFrameInterval,
  h264SetScale2x,
  h264Start,
  h264StreamSummary,
  h264Telemetry,
} from "../../native/h264";

const PLAYBACK_RATE_LABELS = [
  "1 fps (diagnostic)",
  "5 fps",
  "7.5 fps",
  "8.5 fps",
  "9.5 fps",
  "10 fps",
  "15 fps",
  "20 fps",
  "30 fps",
] as const;

const CANCEL_PLAYBACK = "Cancel";
const LATE_FRAME_TOLERANCE_MS = 5;
const NATIVE_DISPLAY_SIZE = "320×192 (native)";
const SCALED_DISPLAY_SIZE = "640×384 (2×)";

function nalType(nal: Uint8Array): number {
  return nal.length > 0 ? nal[0]! & 0x1f : -1;
}

function isVclNal(type: number): boolean {
  return type === 1 || type === 5;
}

interface PlaybackNal {
  nal: Uint8Array;
  sourceIndex: number;
  type: number;
}

interface PlaybackNalPlan {
  nals: PlaybackNal[];
  skippedAud: number;
  skippedSei: number;
  skippedParameterSets: number;
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function planPlaybackNals(sourceNals: Uint8Array[]): PlaybackNalPlan {
  const nals: PlaybackNal[] = [];
  let lastSps: Uint8Array | null = null;
  let lastPps: Uint8Array | null = null;
  let skippedAud = 0;
  let skippedSei = 0;
  let skippedParameterSets = 0;

  for (let i = 0; i < sourceNals.length; i++) {
    const nal = sourceNals[i]!;
    const type = nalType(nal);

    if (type === 9) {
      skippedAud++;
      continue;
    }

    if (type === 6) {
      skippedSei++;
      continue;
    }

    if (type === 7) {
      if (bytesEqual(lastSps, nal)) {
        skippedParameterSets++;
        continue;
      }
      lastSps = new Uint8Array(nal);
    } else if (type === 8) {
      if (bytesEqual(lastPps, nal)) {
        skippedParameterSets++;
        continue;
      }
      lastPps = new Uint8Array(nal);
    }

    nals.push({ nal, sourceIndex: i, type });
  }

  return {
    nals,
    skippedAud,
    skippedSei,
    skippedParameterSets,
  };
}

function pauseForObservation(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pauseUntil(deadlineMs: number): Promise<void> {
  const remainingMs = deadlineMs - Date.now();

  if (remainingMs > 0) {
    await pauseForObservation(remainingMs);
  }
}

async function choosePlaybackRate(): Promise<number | null> {
  const selected = await action({
    title: "H.264 playback rate",
    message: "Start slowly, then increase toward the 30 fps target.",
    cancelButtonText: CANCEL_PLAYBACK,
    actions: [...PLAYBACK_RATE_LABELS],
  });

  if (selected === CANCEL_PLAYBACK) {
    return null;
  }

  const framesPerSecond = Number.parseFloat(selected);

  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    throw new Error(`Invalid H264 playback rate: ${selected}`);
  }

  return framesPerSecond;
}

async function chooseDisplayScale(): Promise<boolean | null> {
  const selected = await action({
    title: "Video display size",
    message: "2× enlarges a 320×192 stream without changing its BLE data rate.",
    cancelButtonText: CANCEL_PLAYBACK,
    actions: [NATIVE_DISPLAY_SIZE, SCALED_DISPLAY_SIZE],
  });

  if (selected === CANCEL_PLAYBACK) {
    return null;
  }

  if (selected === NATIVE_DISPLAY_SIZE) return false;
  if (selected === SCALED_DISPLAY_SIZE) return true;

  throw new Error(`Invalid H264 display size: ${selected}`);
}

const videoApp: AppDefinition = {
  appId: "video",
  title: "Video",
  icon: "film",

  launch: async (ctx) => {
    let releaseScreenAwake: (() => void) | null = null;

    try {
      const picked = await openVideoPicker();

      if (!picked) {
        ctx.appendLog("video picker cancelled");
        return;
      }

      ctx.appendLog(`video selected: ${picked.name}`);

      const bytes = readH264File(picked.uri);
      ctx.appendLog(`video file loaded: ${bytes.length} bytes`);

      const sourceNals = splitAnnexBNals(bytes);
      const playbackPlan = planPlaybackNals(sourceNals);
      const vclCount = playbackPlan.nals.reduce(
        (count, item) => count + (isVclNal(item.type) ? 1 : 0),
        0,
      );

      ctx.appendLog(
        `video NALs: source=${sourceNals.length} ` +
          `transport=${playbackPlan.nals.length} frames=${vclCount}`,
      );
      ctx.appendLog(
        `video NALs skipped: AUD=${playbackPlan.skippedAud} ` +
          `SEI=${playbackPlan.skippedSei} ` +
          `duplicate SPS/PPS=${playbackPlan.skippedParameterSets}`,
      );

      if (vclCount === 0) {
        throw new Error("H264 stream contains no VCL frame NALs");
      }

      const framesPerSecond = await choosePlaybackRate();

      if (framesPerSecond === null) {
        ctx.appendLog("video playback cancelled");
        return;
      }

      const scale2x = await chooseDisplayScale();

      if (scale2x === null) {
        ctx.appendLog("video playback cancelled");
        return;
      }

      releaseScreenAwake = ctx.acquireScreenAwakeLease();

      const frameDurationMs = 1000 / framesPerSecond;
      const transportPayloadBytes = playbackPlan.nals.reduce(
        (total, item) => total + 10 + item.nal.length,
        0,
      );
      const requiredPayloadKbps =
        vclCount > 0
          ? (transportPayloadBytes * 8 * framesPerSecond) / vclCount / 1000
          : 0;
      ctx.appendLog(`H264 target rate: ${framesPerSecond} fps`);
      ctx.appendLog(
        `H264 required payload rate: ${requiredPayloadKbps.toFixed(0)} kbps ` +
          `(before BLE framing)`,
      );

      if (!(await h264Probe())) {
        throw new Error("H264 display PROBE failed");
      }
      ctx.appendLog("H264 PROBE: expect four intensity bands");
      await pauseForObservation(1500);

      if (!(await h264OrientationProbe())) {
        throw new Error("H264 orientation PROBE failed");
      }
      ctx.appendLog("H264 ORIENTATION: LEFT/RIGHT labels and unequal corner blocks");
      await pauseForObservation(1500);

      let streamBegun = false;
      const streamId =
        ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;

      try {
        if (!h264BeginStream(streamId)) {
          throw new Error("H264 transport stream could not begin");
        }
        streamBegun = true;
        ctx.appendLog(`H264 session: ${streamId}`);

        if (!(await h264Start(streamId))) {
          throw new Error("H264 START failed");
        }
        ctx.appendLog("H264 START: expect diagnostic status");
        await pauseForObservation(1500);

        if (!(await h264SetFrameInterval(frameDurationMs))) {
          throw new Error("H264 firmware pacing selection failed");
        }
        ctx.appendLog(
          `H264 firmware pace: ${Math.round(frameDurationMs)}ms per NAL`,
        );

        if (!(await h264SetScale2x(scale2x))) {
          throw new Error("H264 display-size selection failed");
        }
        ctx.appendLog(
          `H264 display: ${scale2x ? SCALED_DISPLAY_SIZE : NATIVE_DISPLAY_SIZE}`,
        );

        let sentNals = 0;
        let sentFrames = 0;
        let lateFrames = 0;
        let maxLatenessMs = 0;
        let firstFrameQueuedMs = 0;
        let lastFrameQueuedMs = 0;
        let totalTransportMs = 0;

        for (let i = 0; i < playbackPlan.nals.length; i++) {
          const item = playbackPlan.nals[i]!;
          const nal = item.nal;
          const type = item.type;
          const isFrame = isVclNal(type);
          let targetStartMs = 0;

          if (isFrame) {
            if (sentFrames === 0) {
              targetStartMs = Date.now();
            } else {
              // Pace from the previous actual enqueue completion. If transport
              // stalls, playback slows instead of bursting reference frames to
              // catch up and overflowing the firmware snapshot queue.
              targetStartMs = lastFrameQueuedMs + frameDurationMs;
              await pauseUntil(targetStartMs);
            }
          }

          const transportStartedMs = Date.now();
          const latenessMs = isFrame
            ? Math.max(0, transportStartedMs - targetStartMs)
            : 0;

          if (isFrame && latenessMs > LATE_FRAME_TOLERANCE_MS) {
            lateFrames++;
            maxLatenessMs = Math.max(maxLatenessMs, latenessMs);
          }

          if (!(await h264QueueNal(nal, streamId, sentNals + 1))) {
            throw new Error(
              `transport NAL ${i + 1}/${playbackPlan.nals.length} ` +
                `source=${item.sourceIndex + 1}/${sourceNals.length} ` +
                `type=${type} failed`,
            );
          }

          const transportMs = Date.now() - transportStartedMs;
          totalTransportMs += transportMs;
          sentNals++;

          if (isFrame) {
            const queuedAtMs = Date.now();
            sentFrames++;
            if (firstFrameQueuedMs === 0) firstFrameQueuedMs = queuedAtMs;
            lastFrameQueuedMs = queuedAtMs;

            if (
              vclCount <= 10 ||
              sentFrames === 1 ||
              sentFrames === vclCount ||
              sentFrames % 30 === 0 ||
              latenessMs >= frameDurationMs
            ) {
              ctx.appendLog(
                `H264 frame ${sentFrames}/${vclCount} type=${type} ` +
                  `size=${nal.length} transport=${transportMs}ms ` +
                  `late=${latenessMs.toFixed(1)}ms`,
              );
            }
          } else if (
            type === 7 ||
            type === 8 ||
            (i < 10 && type !== 9)
          ) {
              ctx.appendLog(
                `H264 NAL ${i + 1}/${playbackPlan.nals.length} ` +
                  `source=${item.sourceIndex + 1} type=${type} ` +
                  `size=${nal.length} transport=${transportMs}ms`,
              );
          }
        }

        if (!(await h264Drain())) {
          throw new Error("H264 transport drain failed");
        }
        const drainCompletedMs = Date.now();
        if (!(await h264Telemetry())) {
          throw new Error("H264 final telemetry failed");
        }
        ctx.appendLog(`H264 firmware: ${h264StreamSummary()}`);

        const playbackSpanMs = drainCompletedMs - firstFrameQueuedMs;
        const achievedFps =
          sentFrames > 0 && playbackSpanMs > 0
            ? (sentFrames * 1000) / playbackSpanMs
            : 0;
        const averageTransportMs =
          sentNals > 0 ? totalTransportMs / sentNals : 0;

        ctx.appendLog(
          `H264 complete: transport=${sentNals}/${playbackPlan.nals.length} ` +
            `source=${sourceNals.length} ` +
            `frames=${sentFrames}/${vclCount}`,
        );
        ctx.appendLog(
          `H264 timing: achieved=${achievedFps.toFixed(1)}fps ` +
            `late=${lateFrames} maxLate=${maxLatenessMs.toFixed(1)}ms ` +
            `avgTransport=${averageTransportMs.toFixed(1)}ms`,
        );
        ctx.appendLog("holding final H264 frame for 8 seconds");
        await pauseForObservation(8000);

      } finally {
        if (streamBegun) {
          try {
            const stopped = await h264EndStream();
            ctx.appendLog(stopped ? "H264 STOP" : "H264 STOP was not acknowledged");
          } catch (stopError) {
            ctx.appendLog(`H264 STOP failed: ${stopError}`);
          } finally {
            streamBegun = false;
            ctx.requestShellRender();
          }
        }
      }
    } catch (error) {
      console.log(`[H264] playback failed: ${error}`);
      ctx.appendLog(`video playback failed: ${error}`);
    } finally {
      if (releaseScreenAwake) ctx.requestShellRender();
      releaseScreenAwake?.();
    }
  },
};

export default videoApp;
