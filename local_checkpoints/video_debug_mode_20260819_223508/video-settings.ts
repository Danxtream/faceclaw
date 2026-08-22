import { ConfigSettingEnum } from "../../ui/dashboard-settings";

export const VIDEO_FPS_VALUES = ["5", "10", "15", "20", "25", "30"] as const;
export type VideoFpsSetting = (typeof VIDEO_FPS_VALUES)[number];
export type VideoScaleSetting = "native" | "2x";

export const videoPlaybackFpsSetting = new ConfigSettingEnum<VideoFpsSetting>({
  id: "video-fps",
  label: "Video FPS",
  storageKey: "video.playbackFps",
  defaultValue: "15",
  values: VIDEO_FPS_VALUES,
  formatValue: (value) => `${value} fps`,
  description:
    "Target frame rate for paired G2 H.264 video. Use the same rate when creating the .h264 file from its same-name MP4 so video duration matches the phone audio timeline.",
});

export const videoScaleSetting = new ConfigSettingEnum<VideoScaleSetting>({
  id: "video-scale",
  label: "Video size",
  storageKey: "video.scale",
  defaultValue: "native",
  values: ["native", "2x"],
  formatValue: (value) => (value === "2x" ? "2x" : "Native"),
  description:
    "Native displays the coded frame at its original size. 2x uses nearest-neighbor scaling in firmware without increasing BLE video payload size.",
});

export function configuredVideoFps(): number {
  return Number(videoPlaybackFpsSetting.get());
}

export function configuredVideoScale2x(): boolean {
  return videoScaleSetting.get() === "2x";
}
