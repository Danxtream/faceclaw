import { MenuLayer } from "../menu";
import { ScreenTestLayer } from "../apps/screen-test";
import { BuzzerDemoLayer } from "../apps/buzzer-demo";
import { APP_VIEWPORT } from "./geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";

export const DEBUG_TESTS_WINDOW_ID = "debug-tests";
export const DEBUG_TESTS_SURFACE_ID = "window:debug-tests";

/** Debug/diagnostic pages (screen test, buzzer demo) as an in-process app. */
export function createDebugTestsAppWindow(options: InProcessAppOptions): InProcessWindow {
  const menu = new MenuLayer(
    "Debug tests",
    [
      {
        label: "Screen test",
        onSelect: (ctx) => {
          ctx.stack.push(new ScreenTestLayer());
        },
      },
      {
        label: "Buzzer demo",
        onSelect: (ctx) => {
          ctx.stack.push(new BuzzerDemoLayer());
        },
      },
    ],
    {
      x: 8,
      y: 8,
      width: 272,
      minHeight: 0,
      maxHeight: APP_VIEWPORT.height - 16,
    },
  );
  return createInProcessWindow({
    appId: "debug-tests",
    windowId: DEBUG_TESTS_WINDOW_ID,
    title: "Debug tests",
    iconLetter: "Db",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(menu),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}
