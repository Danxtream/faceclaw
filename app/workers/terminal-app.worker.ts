/**
 * Terminal app, hosted in its own worker thread. Window model:
 * - "terminal:hub": the window opened from the launcher; shows connection
 *   status and the list of live g2mirror sessions. One control websocket
 *   backs it and also carries unsolicited bell/title notifications.
 * - "terminal:view:N": opened by selecting a session in the hub; each has
 *   its own websocket connection (the protocol allows one attached session
 *   per connection) and its own xterm emulator.
 *
 * Bells for a session with an open, non-foregrounded view window set that
 * window's sidebar attention flag (cleared by the host on foregrounding).
 * Frames are painted here and submitted directly to the Java compositor from
 * this worker's thread.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../graphics/image";
import { getFont } from "../graphics/bdffont";
import * as frameTimings from "../native/frame-timings";
import {
  G2MirrorClient,
  type G2MirrorSession,
  type G2MirrorState,
} from "../native/g2mirror-client";
import { onSettingsStoreChanged } from "../native/settings-store";
import {
  terminalAuthTokenSetting,
  terminalHostSetting,
  terminalPortSetting,
} from "../ui/dashboard-settings";
import { TerminalEmulator } from "../ui/apps/terminal-emulator";
import type { DashboardInputEvent } from "../ui/layers";
import type { WorkerAppMessage, WorkerAppReply } from "../ui/shell/worker-window";

declare const global: any;
declare const com: any;

// Terminus-12 has a 6x12 cell; the grid size is derived from the viewport at
// the first open-window and declared in each websocket init handshake.
const terminalFont = getFont("terminus12");
const CELL_WIDTH = 6;
const CELL_HEIGHT = 12;
const DEVICE_NAME = "Faceclaw G2";
const HUB_ROW_HEIGHT = 20;
const RENDER_COALESCE_MS = 33;

type BaseWindow = {
  windowId: string;
  surfaceId: string;
  foreground: boolean;
  renderScheduled: boolean;
  lastSubmittedFingerprint: string;
};

type HubWindow = BaseWindow & {
  kind: "hub";
  selectedIndex: number;
};

type ViewWindow = BaseWindow & {
  kind: "view";
  socket: string;
  label: string;
  client: G2MirrorClient;
  emulator: TerminalEmulator;
  receivedData: boolean;
  attachRequested: boolean;
  status: string;
  unsubscribers: Array<() => void>;
};

type TerminalWindow = HubWindow | ViewWindow;

const windows = new Map<string, TerminalWindow>();
const pendingViews = new Map<string, { socket: string; label: string }>();
let nextViewSerial = 1;
let viewportWidth = 0;
let viewportHeight = 0;
let gridCols = 0;
let gridRows = 0;
let screenOn = true;

// Control connection: session listing for the hub, plus unsolicited
// bell/title notifications for every monitored terminal. Lives as long as
// the worker so bells keep flowing even if the hub window is closed.
let controlClient: G2MirrorClient | null = null;
let controlState: G2MirrorState | null = null;
let controlUnsubscribers: Array<() => void> = [];

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window":
      openWindow(message.windowId, message.surfaceId, message.viewport);
      break;
    case "close-window":
      closeWindow(message.windowId);
      break;
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown terminal window");
        break;
      }
      handleInput(window, message.event as DashboardInputEvent, message.frameId);
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (window) renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      if (screenOn) {
        for (const window of windows.values()) {
          if (window.foreground) renderAndSubmit(window, 0);
        }
      }
      break;
  }
};

// Restart the control connection when the g2mirror settings change (edited
// in the dashboard's Settings menu, which lives in the main isolate).
onSettingsStoreChanged((key) => {
  if (!key.startsWith("terminal.")) return;
  if (gridCols > 0) {
    startControlClient();
  }
});

function openWindow(windowId: string, surfaceId: string, viewport: { width: number; height: number }): void {
  viewportWidth = viewport.width;
  viewportHeight = viewport.height;
  gridCols = Math.floor(viewportWidth / CELL_WIDTH);
  gridRows = Math.floor(viewportHeight / CELL_HEIGHT);

  const pendingView = pendingViews.get(windowId);
  if (pendingView) {
    pendingViews.delete(windowId);
    windows.set(windowId, createViewWindow(windowId, surfaceId, pendingView.socket, pendingView.label));
    return;
  }
  windows.set(windowId, {
    kind: "hub",
    windowId,
    surfaceId,
    foreground: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    selectedIndex: 0,
  });
  if (!controlClient) {
    startControlClient();
  }
}

function closeWindow(windowId: string): void {
  const window = windows.get(windowId);
  if (!window) return;
  if (window.kind === "view") {
    for (const unsubscribe of window.unsubscribers.splice(0)) {
      unsubscribe();
    }
    window.client.stop();
  }
  windows.delete(windowId);
}

function clientOptions() {
  return {
    host: terminalHostSetting.get().trim(),
    port: parseInt(terminalPortSetting.get(), 10) || 8737,
    authToken: terminalAuthTokenSetting.get(),
    deviceName: DEVICE_NAME,
    cols: gridCols,
    rows: gridRows,
  };
}

function startControlClient(): void {
  stopControlClient();
  const options = clientOptions();
  if (!options.host) {
    controlState = null;
    renderHubWindows();
    return;
  }
  const client = new G2MirrorClient(options);
  controlClient = client;
  controlState = client.state();
  controlUnsubscribers.push(
    client.onStateChange((state) => {
      controlState = state;
      renderHubWindows();
    }),
    client.onBell((socket) => {
      routeBell(socket);
    }),
  );
  client.start();
}

function stopControlClient(): void {
  for (const unsubscribe of controlUnsubscribers.splice(0)) {
    unsubscribe();
  }
  controlClient?.stop();
  controlClient = null;
  controlState = null;
}

function routeBell(socket: string): void {
  for (const window of windows.values()) {
    if (window.kind === "view" && window.socket === socket && !window.foreground) {
      post({ type: "set-attention", windowId: window.windowId, attention: true });
    }
  }
}

function renderHubWindows(): void {
  for (const window of windows.values()) {
    if (window.kind === "hub") scheduleRender(window);
  }
}

function createViewWindow(windowId: string, surfaceId: string, socket: string, label: string): ViewWindow {
  const client = new G2MirrorClient(clientOptions());
  const window: ViewWindow = {
    kind: "view",
    windowId,
    surfaceId,
    foreground: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    socket,
    label,
    client,
    emulator: new TerminalEmulator(gridCols, gridRows),
    receivedData: false,
    attachRequested: false,
    status: "Connecting...",
    unsubscribers: [],
  };
  window.unsubscribers.push(
    client.onStateChange((state) => {
      if (state.phase === "connected" && !window.attachRequested) {
        window.attachRequested = true;
        client.connectSession(socket);
      }
      window.status = state.status;
      scheduleRender(window);
    }),
    client.onSessionAttached(() => {
      client.view();
      scheduleRender(window);
    }),
    client.onTerminalData((data, kind) => {
      if (kind === "snapshot") {
        window.emulator.reset();
      }
      window.receivedData = true;
      window.emulator.write(data, () => scheduleRender(window));
    }),
    client.onSessionDetached((reason) => {
      window.status = `Detached (${reason}).`;
      scheduleRender(window);
    }),
  );
  client.start();
  return window;
}

function handleInput(window: TerminalWindow, event: DashboardInputEvent, frameId: number): void {
  if (event.type === "double-click") {
    frameTimings.finishFrame(frameId, "discarded: terminal yielded focus");
    post({ type: "yield-focus", windowId: window.windowId });
    return;
  }
  if (window.kind === "hub") {
    handleHubInput(window, event, frameId);
    return;
  }
  // View windows are readonly (protocol v1 has no keyboard input).
  frameTimings.finishFrame(frameId, "discarded: terminal view ignored input");
}

type HubItem = {
  label: string;
  onSelect?: () => void;
};

function hubItems(): HubItem[] {
  const items: HubItem[] = [];
  const state = controlState;
  const phase = state?.phase ?? "idle";

  if (phase === "connected" || phase === "attached") {
    for (const session of state?.sessions ?? []) {
      items.push({
        label: sessionLabel(session),
        onSelect: () => openViewWindowFor(session),
      });
    }
    if (!state?.sessions.length) {
      items.push({
        label: "(no live sessions; run g2mirror <command>)",
        onSelect: () => controlClient?.listSessions(),
      });
    }
  }
  if (phase === "idle" || phase === "failed") {
    items.push({
      label: terminalHostSetting.get().trim() ? "Connect" : "Connect (host not set)",
      onSelect: () => startControlClient(),
    });
  }
  return items;
}

function handleHubInput(window: HubWindow, event: DashboardInputEvent, frameId: number): void {
  const items = hubItems();
  switch (event.type) {
    case "scroll-up":
      window.selectedIndex = Math.max(0, window.selectedIndex - 1);
      renderAndSubmit(window, frameId);
      return;
    case "scroll-down":
      window.selectedIndex = Math.min(items.length - 1, window.selectedIndex + 1);
      renderAndSubmit(window, frameId);
      return;
    case "click": {
      const item = items[Math.max(0, Math.min(window.selectedIndex, items.length - 1))];
      item?.onSelect?.();
      renderAndSubmit(window, frameId);
      return;
    }
    default:
      frameTimings.finishFrame(frameId, "discarded: terminal hub ignored input");
      return;
  }
}

function openViewWindowFor(session: G2MirrorSession): void {
  const windowId = `terminal:view:${nextViewSerial++}`;
  const label = sessionLabel(session);
  pendingViews.set(windowId, { socket: session.socket, label });
  post({ type: "open-window-request", windowId, title: label, iconLetter: "T", focus: true });
}

function paint(window: TerminalWindow): GrayImage {
  return window.kind === "hub" ? paintHub(window) : paintView(window);
}

function paintHub(window: HubWindow): GrayImage {
  const image = new GrayImage(viewportWidth, viewportHeight, 0);
  image.drawText(terminalFont, 18, 10, "Terminal", 220);
  image.drawRect(12, 8, viewportWidth - 24, viewportHeight - 16, 52);
  image.drawText(terminalFont, 24, 30, hubStatusLine(), 170);

  let listTop = 52;
  if (!terminalHostSetting.get().trim()) {
    image.drawText(terminalFont, 24, 46, "Set host in Settings > Terminal, see:", 150);
    image.drawText(terminalFont, 24, 60, "https://github.com/jimrandomh/g2mirror", 190);
    listTop += 28;
  }

  const items = hubItems();
  window.selectedIndex = Math.max(0, Math.min(window.selectedIndex, items.length - 1));
  for (let index = 0; index < items.length; index++) {
    const y = listTop + index * HUB_ROW_HEIGHT;
    if (y + HUB_ROW_HEIGHT > viewportHeight - 30) break;
    const selected = index === window.selectedIndex;
    if (selected) {
      image.fillRoundedRect(20, y - 2, viewportWidth - 40, HUB_ROW_HEIGHT - 1, 15);
      image.drawRoundedRect(20, y - 2, viewportWidth - 40, HUB_ROW_HEIGHT - 1, 45);
    }
    image.drawText(terminalFont, 32, y + 2, items[index]!.label, selected ? 255 : 200);
  }

  image.drawText(terminalFont, 24, viewportHeight - 24, "Double-click: back to sidebar", 110);
  return image;
}

function hubStatusLine(): string {
  if (!terminalHostSetting.get().trim()) {
    return "No host configured.";
  }
  return controlState?.status ?? "Not connected.";
}

function paintView(window: ViewWindow): GrayImage {
  const image = new GrayImage(viewportWidth, viewportHeight, 0);
  if (!window.receivedData) {
    image.drawText(terminalFont, 24, 110, window.status, 170);
    image.drawText(terminalFont, 24, 130, "Double-click: back to sidebar", 110);
    return image;
  }
  const cursor = window.emulator.cursor();
  image.fillRect(cursor.x * CELL_WIDTH, cursor.y * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT, 70);
  const lines = window.emulator.visibleLines();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    if (line.length === 0) continue;
    image.drawText(terminalFont, 0, row * CELL_HEIGHT, line, 200);
  }
  return image;
}

/** Coalesce bursty repaint triggers (terminal output) into ~30fps renders. */
function scheduleRender(window: TerminalWindow): void {
  if (window.renderScheduled) return;
  window.renderScheduled = true;
  setTimeout(() => {
    window.renderScheduled = false;
    renderAndSubmit(window, 0);
  }, RENDER_COALESCE_MS);
}

function renderAndSubmit(window: TerminalWindow, inputFrameId: number): void {
  if (!window.foreground || !screenOn) {
    frameTimings.finishFrame(inputFrameId, "discarded: terminal window not visible");
    return;
  }
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const image = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = image.fingerprint();
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: terminal content unchanged");
      return;
    }
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active communicator");
      return;
    }
    const buffer = image.to8bppBuffer();
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: terminal render failed");
    console.error(`terminal worker render failed: ${error}`);
  }
}

function sessionLabel(session: G2MirrorSession): string {
  if (session.title) {
    return `${session.title}  (pid ${session.pid})`;
  }
  const hint = session.cwdHint.replace(/^_+/, "").replace(/_+/g, "/");
  return `${hint || "session"}  (pid ${session.pid})`;
}
