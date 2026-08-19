import { getStringSetting, setStringSetting } from "./settings-store";
import type { DirectoryEntry } from "./file-access";

declare const android: any;
declare const java: any;

const VIDEO_RESUME_KEY = "video.resumeState.v1";

export type VideoResumeState = {
  path: string;
  positionMs: number;
};

export function g2VideoDirectoryPath(): string {
  const downloads = android.os.Environment.getExternalStoragePublicDirectory(
    android.os.Environment.DIRECTORY_DOWNLOADS,
  );
  return String(new java.io.File(downloads, "G2").getAbsolutePath());
}

/** Best-effort creation. It is retried whenever Video opens, after file access may have been granted. */
export function ensureG2VideoDirectory(): string | null {
  try {
    const path = g2VideoDirectoryPath();
    const dir = new java.io.File(path);
    if (dir.isDirectory()) return path;
    if (dir.exists() && !dir.isDirectory()) return null;
    return dir.mkdirs() || dir.isDirectory() ? path : null;
  } catch (error) {
    console.warn(`ensureG2VideoDirectory failed: ${error}`);
    return null;
  }
}

export function isG2H264File(name: string): boolean {
  return /\.(h264|264)$/i.test(name);
}

export function isG2VideoPickerFile(name: string): boolean {
  return /\.(h264|264|mp4)$/i.test(name);
}

/** Resolve the user-facing MP4/H264 selection to the elementary stream sent to the glasses. */
export function resolveG2H264Path(selectedPath: string): string | null {
  try {
    if (/\.(h264|264)$/i.test(selectedPath)) {
      const file = new java.io.File(selectedPath);
      return file.isFile() ? String(file.getAbsolutePath()) : null;
    }
    if (/\.mp4$/i.test(selectedPath)) {
      const base = selectedPath.replace(/\.mp4$/i, "");
      for (const extension of [".h264", ".264"]) {
        const file = new java.io.File(base + extension);
        if (file.isFile()) return String(file.getAbsolutePath());
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * User-facing browser de-duplicates a paired movie: show movie.mp4 and hide
 * movie.h264. A standalone H264 remains visible so silent playback still works.
 */
export function shouldShowG2VideoEntry(entry: DirectoryEntry): boolean {
  if (entry.isDirectory) return true;
  if (/\.mp4$/i.test(entry.name)) return resolveG2H264Path(entry.path) !== null;
  if (/\.(h264|264)$/i.test(entry.name)) return pairedMp4Path(entry.path) === null;
  return false;
}

export function pairedMp4Path(h264Path: string): string | null {
  try {
    const mp4Path = h264Path.replace(/\.(h264|264)$/i, ".mp4");
    if (mp4Path === h264Path) return null;
    const file = new java.io.File(mp4Path);
    return file.isFile() ? String(file.getAbsolutePath()) : null;
  } catch {
    return null;
  }
}

export function loadVideoResumeState(): VideoResumeState | null {
  const raw = getStringSetting(VIDEO_RESUME_KEY, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    const positionMs = Number(parsed.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) return null;
    return { path: parsed.path, positionMs: Math.round(positionMs) };
  } catch {
    return null;
  }
}

export function saveVideoResumeState(path: string, positionMs: number): void {
  const state: VideoResumeState = {
    path,
    positionMs: Math.max(0, Math.round(positionMs)),
  };
  setStringSetting(VIDEO_RESUME_KEY, JSON.stringify(state));
}

export function resumePositionFor(path: string): number {
  const state = loadVideoResumeState();
  return state?.path === path ? state.positionMs : 0;
}
