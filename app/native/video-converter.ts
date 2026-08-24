import { Utils } from "@nativescript/core";

declare const com: any;

export type VideoConversionStage =
  | "idle"
  | "encoding"
  | "auditing"
  | "finalizing"
  | "complete"
  | "failed"
  | "cancelled";

export type VideoConversionSnapshot = {
  running: boolean;
  stage: VideoConversionStage;
  progress: number;
  fps?: number;
  inputPath?: string | null;
  outputPath?: string | null;
  message?: string;
  error?: string;
};

const IDLE: VideoConversionSnapshot = {
  running: false,
  stage: "idle",
  progress: 0,
};

export function startG2VideoConversion(inputPath: string, fps: number): void {
  const context = Utils.android.getApplicationContext();
  com.faceclaw.app.FaceclawVideoConversionService.start(context, inputPath, fps);
}

export function cancelG2VideoConversion(): void {
  const context = Utils.android.getApplicationContext();
  com.faceclaw.app.FaceclawVideoConversionService.cancel(context);
}

export function getG2VideoConversionSnapshot(): VideoConversionSnapshot {
  try {
    const raw = String(com.faceclaw.app.FaceclawVideoConversionService.snapshotJson());
    const parsed = JSON.parse(raw) as Partial<VideoConversionSnapshot>;
    return {
      running: Boolean(parsed.running),
      stage: (parsed.stage ?? "idle") as VideoConversionStage,
      progress: Math.max(0, Math.min(100, Number(parsed.progress) || 0)),
      fps: parsed.fps === undefined ? undefined : Number(parsed.fps),
      inputPath: parsed.inputPath ?? null,
      outputPath: parsed.outputPath ?? null,
      message: parsed.message ?? "",
      error: parsed.error ?? "",
    };
  } catch (error) {
    console.warn(`video conversion snapshot failed: ${error}`);
    return IDLE;
  }
}
