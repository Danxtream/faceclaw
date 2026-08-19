export type VideoPlaybackSnapshot = {
  active: boolean;
  filePath: string;
  audioPath: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  fps: number;
  status: string;
};

type VideoPlaybackControls = {
  togglePause: () => Promise<void> | void;
  seekBy: (deltaMs: number) => Promise<void> | void;
  seekTo: (positionMs: number) => Promise<void> | void;
  stop: () => Promise<void> | void;
};

const EMPTY_SNAPSHOT: VideoPlaybackSnapshot = {
  active: false,
  filePath: "",
  audioPath: null,
  playing: false,
  positionMs: 0,
  durationMs: 0,
  fps: 0,
  status: "",
};

class VideoPlaybackState {
  private snapshot: VideoPlaybackSnapshot = EMPTY_SNAPSHOT;
  private controls: VideoPlaybackControls | null = null;
  private readonly listeners = new Set<(snapshot: VideoPlaybackSnapshot) => void>();

  subscribe(listener: (snapshot: VideoPlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  publish(snapshot: VideoPlaybackSnapshot, controls?: VideoPlaybackControls | null): void {
    this.snapshot = { ...snapshot };
    if (controls !== undefined) this.controls = controls;
    for (const listener of Array.from(this.listeners)) listener(this.snapshot);
  }

  clear(): void {
    this.controls = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  current(): VideoPlaybackSnapshot {
    return this.snapshot;
  }

  async togglePause(): Promise<void> {
    await this.controls?.togglePause();
  }

  async seekBy(deltaMs: number): Promise<void> {
    await this.controls?.seekBy(deltaMs);
  }

  async seekTo(positionMs: number): Promise<void> {
    await this.controls?.seekTo(positionMs);
  }

  async stop(): Promise<void> {
    await this.controls?.stop();
  }
}

export const videoPlaybackState = new VideoPlaybackState();

export function formatVideoTime(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function parseVideoTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.length >= 2 && values[values.length - 1]! >= 60) return null;
  if (values.length === 3 && values[1]! >= 60) return null;
  let seconds = 0;
  if (values.length === 3) seconds = values[0]! * 3600 + values[1]! * 60 + values[2]!;
  else if (values.length === 2) seconds = values[0]! * 60 + values[1]!;
  else seconds = values[0]!;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}
