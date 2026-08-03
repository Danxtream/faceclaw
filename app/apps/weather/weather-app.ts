import { ensureLocationPermission, hasLocationPermission } from "../../g2/android-permissions";
import { weatherBridge } from "../../native/weather";
import { WeatherLayer } from "./weather";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const WEATHER_WINDOW_ID = "weather";
export const WEATHER_SURFACE_ID = "window:weather";

/** Local current conditions and forecast from the National Weather Service. */
export function createWeatherAppWindow(options: InProcessAppOptions): InProcessWindow {
  let requestingPermission = false;
  let unsubscribe: (() => void) | null = null;
  let app: InProcessWindow;

  const requestUpdate = () => {
    if (requestingPermission) return;
    if (hasLocationPermission()) {
      weatherBridge.start();
      return;
    }
    requestingPermission = true;
    void ensureLocationPermission().then((granted) => {
      requestingPermission = false;
      if (granted) weatherBridge.start();
      app.requestRender();
    });
  };

  app = createInProcessWindow({
    appId: "weather",
    windowId: WEATHER_WINDOW_ID,
    title: "Weather",
    iconLetter: "W",
    icon: "cloud-sun",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new WeatherLayer(() => weatherBridge.snapshot(), requestUpdate)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      unsubscribe?.();
      unsubscribe = null;
      weatherBridge.stop();
      options.onClosed();
    },
  });
  unsubscribe = weatherBridge.onStateChange(() => app.requestRender());
  requestUpdate();
  return app;
}
