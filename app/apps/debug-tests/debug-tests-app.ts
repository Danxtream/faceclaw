import { MenuLayer } from "../../ui/menu";
import { ScreenTestLayer } from "./screen-test";
import { BuzzerDemoLayer } from "./buzzer-demo";
import { AccelerometerDemoLayer } from "./accelerometer-demo";
import { appViewportSize } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

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
      {
        label: "Accelerometer demo",
        onSelect: (ctx) => {
          ctx.stack.push(new AccelerometerDemoLayer(DEBUG_TESTS_WINDOW_ID, ctx.actions.requestRender));
        },
      },
    ],
    {
      x: 8,
      y: 8,
      width: 272,
      minHeight: 0,
      maxHeight: appViewportSize("min").height - 16,
    },
  );
  return createInProcessWindow({
    appId: "debug-tests",
    windowId: DEBUG_TESTS_WINDOW_ID,
    title: "Debug tests",
    iconLetter: "Db",
    icon: "flask-conical",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(menu),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}
