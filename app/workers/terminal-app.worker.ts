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
import { TERMINAL_ICON_GLYPHS } from "../graphics/icons";
import * as frameTimings from "../native/frame-timings";
import { GESTURE_DOUBLE_CLICK } from "../ui/gestures";
import {
  G2MirrorClient,
  type G2MirrorSession,
  type G2MirrorState,
} from "../native/g2mirror-client";
import { onSettingsStoreChanged } from "../native/settings-store";
import { clamp } from "../util/numeric-util";
import {
  terminalAuthTokenSetting,
  terminalHostSetting,
  terminalLaunchPresetsSetting,
  terminalPortSetting,
  terminalWakeOnBellSetting,
} from "../ui/dashboard-settings";
import { TerminalEmulator } from "../ui/apps/terminal-emulator";
import type { DashboardInputEvent } from "../ui/layers";
import {
  drawListScrollbar,
  drawSelectionHighlight,
  scrollToKeepSelectionVisible,
  type MenuItem,
} from "../ui/menu";
import { defaultWindowMenuItems, WindowMenu } from "../ui/window-menu";
import { appViewportSize } from "../ui/shell/geometry";
import type { WorkerAppMessage, WorkerAppReply } from "../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../assistant/tool-registry";

declare const global: any;
declare const com: any;

// Terminus-12 has a 6x12 cell; each window derives its grid from the
// viewport in its open-window message (the hub is min-height, session views
// full-height). The websocket init handshake declares the view grid.
const terminalFont = getFont("terminus12");
const CELL_WIDTH = 6;
const CELL_HEIGHT = 12;
// Grid of a session view window (full-height); also declared on the control
// connection so sessions launched from presets come up at view size.
const VIEW_VIEWPORT = appViewportSize("max");
const VIEW_GRID = {
  cols: Math.floor(VIEW_VIEWPORT.width / CELL_WIDTH),
  rows: Math.floor(VIEW_VIEWPORT.height / CELL_HEIGHT),
};
const DEVICE_NAME = "Faceclaw G2";
const HUB_ROW_HEIGHT = 20;
const RENDER_COALESCE_MS = 33;
const HISTORY_PAGE = 200;

type BaseWindow = {
  windowId: string;
  surfaceId: string;
  /** Content viewport from the shell's open-window message; grid = viewport / cell. */
  viewportWidth: number;
  viewportHeight: number;
  gridCols: number;
  gridRows: number;
  foreground: boolean;
  /**
   * Whether this window is the shell's input target (vs. the sidebar having
   * focus). Pushed by the shell on every input/render/foreground message;
   * every focus transition triggers one of those, so it never goes stale.
   */
  focused: boolean;
  renderScheduled: boolean;
  lastSubmittedFingerprint: string;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
};

type HubWindow = BaseWindow & {
  kind: "hub";
  selectedIndex: number;
  scrollRow: number;
  /**
   * Session sockets in display order, captured when the window last became
   * visible so the list doesn't reshuffle under the user while it's open.
   * Cleared on foreground/screen-on; orderedSessions() rebuilds it lazily,
   * sorting by recency and appending sessions that appear while visible.
   */
  sessionOrder: string[];
};

type ViewWindow = BaseWindow & {
  kind: "view";
  socket: string;
  label: string;
  /** Sidebar-icon character (">3"); "" if every glyph was taken at open time. */
  glyph: string;
  client: G2MirrorClient;
  emulator: TerminalEmulator;
  receivedData: boolean;
  attachRequested: boolean;
  status: string;
  unsubscribers: Array<() => void>;
  // Scrollback model. Absolute line indices span the archive and the emulator:
  // indices < historyNext are archived lines; >= historyNext are emulator buffer
  // line (index - historyNext). `archive` holds fetched lines [archiveStart,
  // historyNext). `scrollTop` is the absolute index of the top visible line, or
  // null to follow the live bottom.
  historyNext: number;
  historyOldest: number;
  archive: string[];
  archiveStart: number;
  scrollTop: number | null;
  historyFetchInFlight: boolean;
};

type TerminalWindow = HubWindow | ViewWindow;

const windows = new Map<string, TerminalWindow>();
const pendingViews = new Map<string, { socket: string; label: string; glyph: string }>();
// The view an assistant tool acts on when the terminal isn't foregrounded:
// the last view to be foregrounded or receive input.
let activeViewId: string | null = null;
let nextViewSerial = 1;

/**
 * Assistant tools this app contributes, declared on the hub window (which the
 * launcher opens and which persists for the app's life). All `open`-tier so
 * "rerun the build" works while the terminal is backgrounded. send_input and
 * read_screen act on the active view session (see resolveActiveView).
 */
const TERMINAL_TOOLS: ToolSpec[] = [
  {
    name: "list_sessions",
    description: "List the live g2mirror terminal sessions the glasses can see.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "send_input",
    description:
      "Type a line into the active terminal session and submit it (as if typed and Enter pressed). Use to run a command in the terminal.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The line to type and run." } },
      required: ["text"],
      additionalProperties: false,
    },
    availability: "open",
  },
  {
    name: "read_screen",
    description: "Return the current visible contents of the active terminal session's screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "list_launch_presets",
    description:
      "List the named launch presets that can start a new terminal session on the host machine (for launch_session).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "launch_session",
    description:
      "Start a new terminal session on the host machine from a named launch preset (see list_launch_presets) and open a window viewing it.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", description: "Name of the launch preset to start." },
      },
      required: ["preset"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 15_000,
  },
];
let screenOn = true;

// Control connection: session listing for the hub, plus unsolicited
// bell/title notifications for every monitored terminal. Lives as long as
// the worker so bells keep flowing even if the hub window is closed.
let controlClient: G2MirrorClient | null = null;
let controlState: G2MirrorState | null = null;
let controlUnsubscribers: Array<() => void> = [];

// When each session (by socket) last "updated", unix epoch ms: bells, title
// changes, and terminal output from open views. Sessions first seen in the
// initial list after (re)connect are seeded from their last bell, since we
// weren't watching; ones appearing later were just created, so they get "now".
const sessionRecency = new Map<string, number>();
let controlSessionsSeeded = false;

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
      window.focused = message.focused;
      handleInput(window, message.event as DashboardInputEvent, message.frameId);
      break;
    }
    case "text-input": {
      const window = windows.get(message.windowId);
      // Only attached view windows have a terminal to type into. submitInput
      // appends Enter ("\r") after a wrapper-side pause so paste-detecting
      // apps (e.g. Claude Code) submit instead of inserting a newline.
      if (window && window.kind === "view") {
        window.client.submitInput(message.text);
      }
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.focused = message.focused;
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (window.foreground && window.kind === "view") activeViewId = window.windowId;
      if (window.foreground && window.kind === "hub") window.sessionOrder = [];
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      if (screenOn) {
        for (const window of windows.values()) {
          if (!window.foreground) continue;
          // Waking counts as becoming visible: let the session list re-sort.
          if (window.kind === "hub") window.sessionOrder = [];
          renderAndSubmit(window, 0);
        }
      }
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleTerminalTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) =>
          post({
            type: "tool-result",
            callId,
            result: { ok: false, error: String((error as Error)?.message ?? error) },
          }),
        );
      break;
    }
  }
};

// Restart the control connection when the g2mirror settings change (edited
// in the dashboard's Settings menu, which lives in the main isolate).
onSettingsStoreChanged((key) => {
  if (!key.startsWith("terminal.")) return;
  // Settings that don't affect the connection; no reconnect needed.
  if (key === "terminal.launchPresets" || key === "terminal.wakeOnBell") return;
  // (Re)start only once the app has actually been opened.
  if (controlClient || windows.size > 0) {
    startControlClient();
  }
});

function openWindow(windowId: string, surfaceId: string, viewport: { width: number; height: number }): void {
  const pendingView = pendingViews.get(windowId);
  if (pendingView) {
    pendingViews.delete(windowId);
    windows.set(windowId, createViewWindow(windowId, surfaceId, viewport, pendingView));
    renderHubWindows();
    return;
  }
  windows.set(windowId, {
    kind: "hub",
    windowId,
    surfaceId,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    gridCols: Math.floor(viewport.width / CELL_WIDTH),
    gridRows: Math.floor(viewport.height / CELL_HEIGHT),
    foreground: false,
    focused: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    menu: null,
    selectedIndex: 0,
    scrollRow: 0,
    sessionOrder: [],
  });
  // The hub carries the app's assistant tools; declare them once it exists.
  post({ type: "set-tools", windowId, tools: TERMINAL_TOOLS });
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
  if (activeViewId === windowId) activeViewId = null;
  if (window.kind === "view") {
    renderHubWindows();
  }
}

function clientOptions() {
  return {
    host: terminalHostSetting.get().trim(),
    port: parseInt(terminalPortSetting.get(), 10) || 8737,
    authToken: terminalAuthTokenSetting.get(),
    deviceName: DEVICE_NAME,
    cols: VIEW_GRID.cols,
    rows: VIEW_GRID.rows,
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
  controlSessionsSeeded = false;
  controlUnsubscribers.push(
    client.onStateChange((state) => {
      noteSessionListRecency(state);
      controlState = state;
      renderHubWindows();
    }),
    client.onBell((socket, lastBellAtMs) => {
      routeBell(socket, lastBellAtMs);
    }),
    client.onTitle((socket) => {
      noteSessionUpdated(socket);
    }),
  );
  client.start();
}

function noteSessionUpdated(socket: string): void {
  sessionRecency.set(socket, Date.now());
}

function noteSessionListRecency(state: G2MirrorState): void {
  for (const session of state.sessions) {
    const known = sessionRecency.get(session.socket);
    if (known === undefined) {
      sessionRecency.set(
        session.socket,
        Math.max(session.lastBellAt ?? 0, controlSessionsSeeded ? Date.now() : 0),
      );
    } else if ((session.lastBellAt ?? 0) > known) {
      sessionRecency.set(session.socket, session.lastBellAt!);
    }
  }
  if (state.sessions.length) controlSessionsSeeded = true;
}

function stopControlClient(): void {
  for (const unsubscribe of controlUnsubscribers.splice(0)) {
    unsubscribe();
  }
  controlClient?.stop();
  controlClient = null;
  controlState = null;
}

function routeBell(socket: string, lastBellAtMs: number): void {
  const known = sessionRecency.get(socket) ?? 0;
  if (lastBellAtMs > known) sessionRecency.set(socket, lastBellAtMs);
  for (const window of windows.values()) {
    if (window.kind === "view" && window.socket === socket && !window.foreground) {
      post({ type: "set-attention", windowId: window.windowId, attention: true });
    }
  }
  if (terminalWakeOnBellSetting.get()) {
    // Wake to the belling session's view window, or the hub if it has none.
    // The shell drops the message unless the glasses are actually asleep.
    const viewId = viewWindowIdForSocket(socket);
    const hubId = [...windows.values()].find((window) => window.kind === "hub")?.windowId ?? null;
    const target = viewId ?? hubId;
    if (target) post({ type: "wake-window", windowId: target });
  }
}

function renderHubWindows(): void {
  for (const window of windows.values()) {
    if (window.kind === "hub") scheduleRender(window);
  }
}

function createViewWindow(
  windowId: string,
  surfaceId: string,
  viewport: { width: number; height: number },
  view: { socket: string; label: string; glyph: string },
): ViewWindow {
  const { socket, label, glyph } = view;
  const gridCols = Math.floor(viewport.width / CELL_WIDTH);
  const gridRows = Math.floor(viewport.height / CELL_HEIGHT);
  const client = new G2MirrorClient({ ...clientOptions(), cols: gridCols, rows: gridRows });
  const window: ViewWindow = {
    kind: "view",
    windowId,
    surfaceId,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    gridCols,
    gridRows,
    foreground: false,
    focused: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    menu: null,
    socket,
    label,
    glyph,
    client,
    emulator: new TerminalEmulator(gridCols, gridRows),
    receivedData: false,
    attachRequested: false,
    status: "Connecting...",
    unsubscribers: [],
    historyNext: 0,
    historyOldest: 0,
    archive: [],
    archiveStart: 0,
    scrollTop: null,
    historyFetchInFlight: false,
  };
  window.unsubscribers.push(
    client.onSnapshot((historyNext, historyOldest) => {
      // A (re)snapshot resets the emulator, so reset the scroll model too:
      // follow the bottom and drop any fetched archive (its splice may move).
      window.historyNext = historyNext;
      window.historyOldest = historyOldest;
      window.archive = [];
      window.archiveStart = historyNext;
      window.scrollTop = null;
      window.historyFetchInFlight = false;
      maybePrefetchHistory(window);
      scheduleRender(window);
    }),
    client.onHistoryLines((reply) => {
      applyHistoryReply(window, reply);
      scheduleRender(window);
    }),
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
      noteSessionUpdated(window.socket);
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

/** The window's long-press menu, created lazily so window literals stay simple. */
function windowMenu(window: TerminalWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function windowMenuItems(window: TerminalWindow): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        post({ type: "open-settings", section: "Terminal" });
      },
    },
  ];
  if (window.kind === "hub") {
    const phase = controlState?.phase;
    if (phase === "connected" || phase === "attached") {
      for (const preset of launchPresetNames()) {
        items.push({
          label: `Launch ${preset}`,
          onSelect: (ctx) => {
            ctx.stack.pop();
            launchAndOpenView(preset).catch((error) => {
              // The hub status line also shows the server's error message.
              console.warn(`terminal launch ${preset} failed: ${error}`);
            });
          },
        });
      }
      items.push({
        label: "Disconnect",
        onSelect: (ctx) => {
          ctx.stack.pop();
          stopControlClient();
          renderHubWindows();
        },
      });
    }
  } else {
    items.push(
      {
        label: "Send <Enter>",
        onSelect: (ctx) => {
          ctx.stack.pop();
          window.client.sendInput("\r");
        },
      },
      {
        label: "Send <Esc>",
        onSelect: (ctx) => {
          ctx.stack.pop();
          window.client.sendInput("\u001b");
        },
      },
    );
  }
  items.push(...defaultWindowMenuItems(window.windowId, post));
  return items;
}

function handleInput(window: TerminalWindow, event: DashboardInputEvent, frameId: number): void {
  if (window.kind === "view") activeViewId = window.windowId;
  // An open window menu owns all input (it closes itself via pop).
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(event)
      .catch((error) => console.error(`terminal menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }
  if (event.type === "long-press") {
    windowMenu(window).open(windowMenuItems(window));
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type === "double-click") {
    frameTimings.finishFrame(frameId, "discarded: terminal yielded focus");
    post({ type: "yield-focus", windowId: window.windowId });
    return;
  }
  if (window.kind === "hub") {
    handleHubInput(window, event, frameId);
    return;
  }
  // View windows: scroll gestures page through scrollback; text input arrives
  // via the separate "text-input" message.
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    handleViewScroll(window, event.type === "scroll-up" ? -1 : 1, frameId);
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: terminal view ignored input");
}

/** Top visible absolute line index when following the live bottom. */
function followTop(window: ViewWindow): number {
  return window.historyNext + window.emulator.bufferLength() - window.gridRows;
}

function handleViewScroll(window: ViewWindow, direction: -1 | 1, frameId: number): void {
  const page = Math.max(1, window.gridRows - 1);
  const bottomTop = followTop(window);
  const minTop = window.archiveStart;
  const currentTop = window.scrollTop ?? bottomTop;
  const newTop = clamp(currentTop + direction * page, Math.min(minTop, bottomTop), bottomTop);
  // Snapping to (or below) the live bottom re-locks to follow mode.
  window.scrollTop = newTop >= bottomTop ? null : newTop;
  maybePrefetchHistory(window);
  renderAndSubmit(window, frameId);
}

/** Fetch an older page of archive when the view nears the top of what's loaded. */
function maybePrefetchHistory(window: ViewWindow): void {
  if (window.historyFetchInFlight) return;
  if (window.archiveStart <= window.historyOldest) return; // nothing older retained
  const top = window.scrollTop ?? followTop(window);
  if (window.archive.length === 0 || top - window.archiveStart <= window.gridRows) {
    window.historyFetchInFlight = true;
    window.client.requestHistory(window.archiveStart, HISTORY_PAGE);
  }
}

function applyHistoryReply(window: ViewWindow, reply: { start: number; oldest: number; lines: string[] }): void {
  window.historyFetchInFlight = false;
  window.historyOldest = reply.oldest;
  if (!reply.lines.length) {
    // Nothing older was returned; stop asking below what we already have.
    window.historyOldest = window.archiveStart;
    return;
  }
  // The page ends just before our request (archiveStart); prepend it.
  if (reply.start < window.archiveStart) {
    window.archive = reply.lines.concat(window.archive);
    window.archiveStart = reply.start;
  }
}

type HubItem = {
  label: string;
  onSelect?: () => void;
};

/**
 * The control connection's sessions in this hub window's display order:
 * most-recently-updated first as of when the window became visible, with
 * sessions that appeared since then at the end. The captured order lives in
 * window.sessionOrder (cleared when the window becomes visible) so the list
 * doesn't reshuffle while the user is looking at it.
 */
function orderedSessions(window: HubWindow): G2MirrorSession[] {
  const sessions = controlState?.sessions ?? [];
  const position = new Map<string, number>();
  for (const socket of window.sessionOrder) {
    if (!position.has(socket)) position.set(socket, position.size);
  }
  const fresh = sessions
    .filter((session) => !position.has(session.socket))
    .sort((a, b) => (sessionRecency.get(b.socket) ?? 0) - (sessionRecency.get(a.socket) ?? 0));
  for (const session of fresh) {
    position.set(session.socket, position.size);
    window.sessionOrder.push(session.socket);
  }
  return sessions.slice().sort((a, b) => position.get(a.socket)! - position.get(b.socket)!);
}

function hubItems(window: HubWindow): HubItem[] {
  const items: HubItem[] = [];
  const state = controlState;
  const phase = state?.phase ?? "idle";

  if (phase === "connected" || phase === "attached") {
    for (const session of orderedSessions(window)) {
      const openWindowId = viewWindowIdForSocket(session.socket);
      items.push({
        label: openWindowId ? `${sessionLabel(session)}  [open]` : sessionLabel(session),
        onSelect: () => {
          const windowId = viewWindowIdForSocket(session.socket);
          if (windowId) {
            post({ type: "focus-window", windowId });
          } else {
            openViewWindowFor(session);
          }
        },
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
  const items = hubItems(window);
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

/**
 * Window id of the view already showing this session's terminal, if any.
 * Includes views that were requested but whose surface hasn't opened yet, so
 * a quick double-select can't spawn two windows for one session.
 */
function viewWindowIdForSocket(socket: string): string | null {
  for (const window of windows.values()) {
    if (window.kind === "view" && window.socket === socket) return window.windowId;
  }
  for (const [windowId, pending] of pendingViews) {
    if (pending.socket === socket) return windowId;
  }
  return null;
}

function openViewWindowFor(session: G2MirrorSession): void {
  openViewWindow(session.socket, sessionLabel(session));
}

/**
 * Lowest unused sidebar-icon character for a new view window (its terminal
 * icon shows ">N"). Glyphs free up when their window closes, since usage is
 * recomputed from the live windows; "" (plain ">_" icon) if all are taken.
 */
function allocateViewGlyph(): string {
  const used = new Set<string>();
  for (const window of windows.values()) {
    if (window.kind === "view") used.add(window.glyph);
  }
  for (const pending of pendingViews.values()) used.add(pending.glyph);
  for (const glyph of TERMINAL_ICON_GLYPHS) {
    if (!used.has(glyph)) return glyph;
  }
  return "";
}

function openViewWindow(socket: string, label: string): void {
  const windowId = `terminal:view:${nextViewSerial++}`;
  const glyph = allocateViewGlyph();
  pendingViews.set(windowId, { socket, label, glyph });
  post({
    type: "open-window-request",
    windowId,
    title: label,
    iconLetter: "T",
    icon: "terminal",
    iconGlyph: glyph || undefined,
    focus: true,
    // Terminal views are the one full-height window kind: more rows matter
    // more than a small on-screen footprint.
    heightMode: "max",
  });
}

/** Preset names the user listed in Settings > Terminal (the wire protocol has no way to enumerate the server's). */
function launchPresetNames(): string[] {
  const names: string[] = [];
  for (const piece of terminalLaunchPresetsSetting.get().split(",")) {
    const name = piece.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Launch a preset on the server and open a view window on the new session. */
async function launchAndOpenView(preset: string): Promise<string> {
  if (!controlClient) throw new Error("Not connected to the g2mirror server.");
  const socket = await controlClient.launchSession(preset);
  openViewWindow(socket, preset);
  return socket;
}

function paint(window: TerminalWindow): GrayImage {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return paintContent(window);
}

function paintContent(window: TerminalWindow): GrayImage {
  return window.kind === "hub" ? paintHub(window) : paintView(window);
}

function paintHub(window: HubWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  // No border box: the shell chrome (top bar + sidebar) already frames the app.
  image.drawText(terminalFont, 18, 10, "Terminal", 220);
  image.drawText(terminalFont, 24, 30, hubStatusLine(), 170);

  let listTop = 52;
  if (!terminalHostSetting.get().trim()) {
    image.drawText(terminalFont, 24, 46, "Set host in Settings > Terminal, see:", 150);
    image.drawText(terminalFont, 24, 60, "https://github.com/jimrandomh/g2mirror", 190);
    listTop += 28;
  }

  const items = hubItems(window);
  window.selectedIndex = Math.max(0, Math.min(window.selectedIndex, items.length - 1));
  const visibleRowCount = Math.max(1, ((window.viewportHeight - 30 - listTop) / HUB_ROW_HEIGHT) | 0);
  window.scrollRow = scrollToKeepSelectionVisible(window.scrollRow, window.selectedIndex, visibleRowCount, items.length);
  const lastVisibleRow = Math.min(items.length, window.scrollRow + visibleRowCount);
  for (let index = window.scrollRow; index < lastVisibleRow; index++) {
    const y = listTop + (index - window.scrollRow) * HUB_ROW_HEIGHT;
    const selected = index === window.selectedIndex;
    if (selected) {
      // Match the shell convention: fill only when this window has focus, so
      // an outline-only selection signals the sidebar owns input.
      drawSelectionHighlight(image, 20, y - 2, window.viewportWidth - 40, HUB_ROW_HEIGHT - 1, window.focused, 8);
    }
    image.drawText(terminalFont, 32, y + 2, items[index]!.label, selected ? 255 : 200);
  }
  if (items.length > visibleRowCount) {
    drawListScrollbar(
      image,
      window.viewportWidth - 10,
      listTop,
      visibleRowCount * HUB_ROW_HEIGHT - 4,
      window.scrollRow,
      visibleRowCount,
      items.length,
    );
  }

  image.drawText(terminalFont, 24, window.viewportHeight - 24, `${GESTURE_DOUBLE_CLICK} back`, 110);
  return image;
}

function hubStatusLine(): string {
  if (!terminalHostSetting.get().trim()) {
    return "No host configured.";
  }
  return controlState?.status ?? "Not connected.";
}

function paintView(window: ViewWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  if (!window.receivedData) {
    image.drawText(terminalFont, 24, 110, window.status, 170);
    image.drawText(terminalFont, 24, 130, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  const rows = window.gridRows;
  const historyNext = window.historyNext;
  const bufferLength = window.emulator.bufferLength();
  const bottomTop = historyNext + bufferLength - rows;
  const following = window.scrollTop === null;
  const top = following ? bottomTop : clamp(window.scrollTop!, window.archiveStart, bottomTop);

  // Draw the cursor only if its line is within the visible window.
  const cursorScreenRow = historyNext + window.emulator.cursorRow() - top;
  if (cursorScreenRow >= 0 && cursorScreenRow < rows) {
    image.fillRect(window.emulator.cursorCol() * CELL_WIDTH, cursorScreenRow * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT, 70);
  }

  for (let row = 0; row < rows; row++) {
    const absolute = top + row;
    let text = "";
    if (absolute >= historyNext) {
      const bufferIndex = absolute - historyNext;
      if (bufferIndex >= 0 && bufferIndex < bufferLength) text = window.emulator.lineAt(bufferIndex);
    } else if (absolute >= window.archiveStart) {
      text = window.archive[absolute - window.archiveStart] ?? "";
    }
    if (text.length) image.drawText(terminalFont, 0, row * CELL_HEIGHT, text, 200);
  }

  if (!following) {
    drawScrollIndicator(image, top, window.archiveStart, bottomTop);
  }
  return image;
}

/** Right-edge scrollbar showing the view position within the scrollback. */
function drawScrollIndicator(image: GrayImage, top: number, minTop: number, maxTop: number): void {
  const trackX = image.width - 3;
  image.fillRect(trackX, 0, 3, image.height, 30);
  const fraction = clamp((top - minTop) / Math.max(1, maxTop - minTop), 0, 1);
  const thumbHeight = 24;
  const thumbY = Math.round((image.height - thumbHeight) * fraction);
  image.fillRect(trackX, thumbY, 3, thumbHeight, 150);
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
    return session.title;
  }
  const hint = session.cwdHint.replace(/^_+/, "").replace(/_+/g, "/");
  return hint || "session";
}

/** Dispatch an assistant tool-call (unprefixed name) to its handler. */
function handleTerminalTool(name: string, args: any): ToolResult | Promise<ToolResult> {
  switch (name) {
    case "list_sessions":
      return toolListSessions();
    case "send_input":
      return toolSendInput(args);
    case "read_screen":
      return toolReadScreen();
    case "list_launch_presets":
      return toolListLaunchPresets();
    case "launch_session":
      return toolLaunchSession(args);
    default:
      return { ok: false, error: `Unknown terminal tool: ${name}` };
  }
}

function toolListLaunchPresets(): ToolResult {
  const presets = launchPresetNames();
  if (!presets.length) {
    return { ok: true, content: "No launch presets configured (Settings > Terminal > Launch presets)." };
  }
  return { ok: true, content: presets.map((preset) => `- ${preset}`).join("\n") };
}

async function toolLaunchSession(args: any): Promise<ToolResult> {
  const preset = String(args?.preset ?? "").trim();
  if (!preset) return { ok: false, error: "launch_session requires a preset name." };
  const phase = controlState?.phase;
  if (phase !== "connected" && phase !== "attached") {
    return { ok: false, error: "Not connected to the g2mirror server." };
  }
  const socket = await launchAndOpenView(preset);
  return { ok: true, content: `Launched "${preset}" (session ${socket}) and opened a window viewing it.` };
}

function toolListSessions(): ToolResult {
  const sessions = controlState?.sessions ?? [];
  if (!sessions.length) {
    return { ok: true, content: "No live terminal sessions (run g2mirror <command> on the host)." };
  }
  const lines = sessions.map(
    (session) => `- ${sessionLabel(session)}${viewWindowIdForSocket(session.socket) ? " [open]" : ""}`,
  );
  return { ok: true, content: lines.join("\n") };
}

function toolSendInput(args: any): ToolResult {
  const text = String(args?.text ?? "");
  if (!text) return { ok: false, error: "send_input requires non-empty text." };
  const view = resolveActiveView();
  if (!view) return { ok: false, error: "No terminal session is open to send input to." };
  view.client.submitInput(text);
  return { ok: true, content: `Sent to ${view.label}.` };
}

function toolReadScreen(): ToolResult {
  const view = resolveActiveView();
  if (!view) return { ok: false, error: "No terminal session is open." };
  const length = view.emulator.bufferLength();
  const start = Math.max(0, length - view.gridRows);
  const lines: string[] = [];
  for (let index = start; index < length; index++) {
    lines.push(view.emulator.lineAt(index));
  }
  const text = lines.join("\n").replace(/\s+$/, "");
  return { ok: true, content: text || "(screen is empty)" };
}

/**
 * The terminal view an `open`-tier tool acts on: a foregrounded view if any,
 * else the last view to be active, else the sole open view. Null when no view
 * is open (the model gets a tool error it can relay).
 */
function resolveActiveView(): ViewWindow | null {
  const views: ViewWindow[] = [];
  let foreground: ViewWindow | null = null;
  for (const window of windows.values()) {
    if (window.kind !== "view") continue;
    views.push(window);
    if (window.foreground) foreground = window;
  }
  if (foreground) return foreground;
  if (activeViewId) {
    const window = windows.get(activeViewId);
    if (window && window.kind === "view") return window;
  }
  return views.length === 1 ? views[0]! : null;
}
