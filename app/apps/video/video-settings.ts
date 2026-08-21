import { ConfigSettingBoolean, ConfigSettingEnum, onAnySettingChanged } from "../../ui/dashboard-settings";

export const VIDEO_FPS_VALUES = ["5", "10", "15", "20", "25", "30"] as const;
export type VideoFpsSetting = (typeof VIDEO_FPS_VALUES)[number];

export type VideoScaleSetting = "native" | "2x";
export type VideoBlePhySetting = "1m" | "2m";

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

export const videoDebuggingSetting = new ConfigSettingBoolean({
  id: "video-debugging",
  label: "Video debugging",
  storageKey: "video.debugging",
  defaultValue: false,
  description:
    "Maximum-throughput H264 benchmark mode. Firmware target is 30 fps; pause, seek, audio synchronization, restart, recovery, and host frame pacing are bypassed.",
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

export function configuredVideoDebugging(): boolean {
  return videoDebuggingSetting.get();
}

export const videoBlePhySetting =
  new ConfigSettingEnum<VideoBlePhySetting>({
    id: "video-ble-phy",
    label: "BLE PHY",
    storageKey: "video.blePhy",
    defaultValue: "1m",
    values: ["1m", "2m"],
    formatValue: (value) =>
      value === "2m" ? "2M" : "1M",
    description:
      "BLE radio PHY used only while Video is active. 1M is the safe default. 2M temporarily enables the G2 controller's LE 2M feature for video playback; closing Video always restores 1M.",
  });

export function configuredVideoBlePhy2m():
  boolean {
  return videoBlePhySetting.get() === "2m";
}

/**
 * Receive BLE-PHY setting changes from either the glasses UI
 * or phone-side settings store.
 */
export function onVideoBlePhySettingChanged(
  listener: (
    value: VideoBlePhySetting,
    oldValue: VideoBlePhySetting,
  ) => void,
): () => void {
  let previous =
    videoBlePhySetting.get();

  return onAnySettingChanged(() => {
    const current =
      videoBlePhySetting.get();

    if (current === previous) {
      return;
    }

    const oldValue =
      previous;

    previous =
      current;

    listener(
      current,
      oldValue,
    );
  });
}

export function configuredVideoFps(): number {
  return Number(videoPlaybackFpsSetting.get());
}

export function configuredVideoScale2x(): boolean {
  return videoScaleSetting.get() === "2x";
}
