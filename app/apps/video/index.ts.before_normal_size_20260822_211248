import { type AppDefinition } from "../app-definition";
import { createInProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { VideoAppLayer } from "./video-app-layer";

export const VIDEO_WINDOW_ID = "video";
export const VIDEO_SURFACE_ID = "window:video";

let activeLayer: VideoAppLayer | null = null;

const videoApp: AppDefinition = {
  appId: "video",
  title: "Video",
  icon: "film",

  launch: async (ctx) => {
    if (activeLayer) {
      shell.focusWindow(VIDEO_WINDOW_ID);
      ctx.requestShellRender();
      return;
    }

    await ctx.launchInProcessApp(VIDEO_WINDOW_ID, VIDEO_SURFACE_ID, (options) => {
      const layer = new VideoAppLayer(ctx);
      activeLayer = layer;
      return createInProcessWindow({
        appId: "video",
        windowId: VIDEO_WINDOW_ID,
        title: "Video",
        iconLetter: "V",
        icon: "film",
        closeable: true,
        heightMode: "max",
        actions: options.actions,
        baseLayer: layer,
        shouldSuppressRender: () => layer.suppressesShellRender(),
        submitFrame: options.submitFrame,
        setSurfaceVisible: options.setSurfaceVisible,
        removeSurface: options.removeSurface,
        onClosed: () => {
          if (activeLayer === layer) activeLayer = null;
          void layer.dispose();
          options.onClosed();
        },
      });
    });
  },
};

export default videoApp;
