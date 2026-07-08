import { imageFromAsciiArt } from "../../graphics/image";
import { TranscribeLayer } from "../apps/transcribe";
import type { LayerActions } from "../layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";
import { shell } from "./shell";

export const TRANSCRIBE_WINDOW_ID = "transcribe";
export const TRANSCRIBE_SURFACE_ID = "window:transcribe";

const TRAY_ICON_ID = "transcribe";

// 16x18 microphone glyph for the top-bar tray.
const MIC_ICON = imageFromAsciiArt(
  [
    "     ####     ",
    "    ######    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "  # #    # #  ",
    "  # #    # #  ",
    "  #  ####  #  ",
    "   #      #   ",
    "    ######    ",
    "       #      ",
    "       #      ",
    "     ######   ",
  ],
  220,
);

export type TranscribeAppOptions = InProcessAppOptions & {
  /** Begin continuous mic capture (kept on while the window is open). */
  startContinuousVoiceCapture: () => void;
  stopContinuousVoiceCapture: () => void;
};

/**
 * The Transcribe app: live speech-to-text in its own window. While open it
 * holds continuous mic capture (so push-to-talk can share the stream) and
 * shows a microphone tray icon in the top bar.
 */
export function createTranscribeAppWindow(options: TranscribeAppOptions): InProcessWindow {
  const layer = new TranscribeLayer();
  const actions: LayerActions = { ...options.actions };
  const app = createInProcessWindow({
    appId: "transcribe",
    windowId: TRANSCRIBE_WINDOW_ID,
    title: "Transcribe",
    iconLetter: "Tr",
    icon: "mic",
    closeable: true,
    actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      options.stopContinuousVoiceCapture();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  // start() wires the layer's transcript/status subscriptions; the LayerStack
  // exposes its context through a paint, but the layer needs it up front, so
  // build a minimal context here.
  layer.start({ stack: app.stack, actions });
  options.startContinuousVoiceCapture();
  shell.setTrayIcon(TRAY_ICON_ID, MIC_ICON);
  return app;
}
