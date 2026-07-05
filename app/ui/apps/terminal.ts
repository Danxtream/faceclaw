import { getFont } from "~/graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "~/graphics/image";
import {
  G2MirrorClient,
  type G2MirrorSession,
  type G2MirrorState,
} from "~/native/g2mirror-client";
import {
  terminalAuthTokenSetting,
  terminalHostSetting,
  terminalPortSetting,
  textSettingMenuItem,
} from "../dashboard-settings";
import { TOP_LEFT_MENU_LAYOUT } from "../dashboard";
import { MenuLayer } from "../menu";
import { type DashboardInputEvent, type Layer, type LayerActions, type LayerContext } from "../layers";

// Terminus-12 has a 6x12 cell, so the full 576x288 lens is a 96x24 grid —
// this is the size we declare in the g2mirror init handshake, fixed per
// websocket connection.
const terminalFont = getFont("terminus12");
const CELL_WIDTH = 6;
const CELL_HEIGHT = 12;
const TERMINAL_COLS = G2_LENS_WIDTH / CELL_WIDTH;
const TERMINAL_ROWS = G2_LENS_HEIGHT / CELL_HEIGHT;
const DEVICE_NAME = "Faceclaw G2";

const HUB_ROW_HEIGHT = 20;
const HUB_LIST_TOP = 64;

type HubItem = {
  label: string;
  onSelect: (ctx: LayerContext) => void;
};

/**
 * The Terminal app hub: connection status, list of live g2mirror sessions,
 * and the app-local settings menu. Selecting a session attaches and opens
 * the full-screen readonly terminal view.
 */
export class TerminalAppLayer implements Layer {
  private client: G2MirrorClient | null = null;
  private clientState: G2MirrorState | null = null;
  private selectedIndex = 0;
  private lastCtx: LayerContext | null = null;
  private activeViewLayer: TerminalViewLayer | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly actions: LayerActions) {
    selfTestEmulator();
    this.startClient();
  }

  private startClient(): void {
    this.stopClient();
    const host = terminalHostSetting.get().trim();
    if (!host) return;
    const port = parseInt(terminalPortSetting.get(), 10) || 8737;
    const client = new G2MirrorClient({
      host,
      port,
      authToken: terminalAuthTokenSetting.get(),
      deviceName: DEVICE_NAME,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    });
    this.client = client;
    this.clientState = client.state();
    this.unsubscribers.push(
      client.onStateChange((state) => {
        this.clientState = state;
        this.actions.requestRender();
      }),
      client.onSessionAttached(() => {
        this.openViewLayer();
      }),
      client.onSessionDetached(() => {
        this.closeViewLayer();
      }),
    );
    client.start();
  }

  private stopClient(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.client?.stop();
    this.client = null;
    this.clientState = null;
  }

  private openViewLayer(): void {
    const ctx = this.lastCtx;
    if (!ctx || !this.client || this.activeViewLayer) return;
    const viewLayer = new TerminalViewLayer(this.client, this.actions, () => {
      if (this.activeViewLayer === viewLayer) {
        this.activeViewLayer = null;
      }
    });
    this.activeViewLayer = viewLayer;
    ctx.stack.push(viewLayer);
    this.actions.requestRender();
  }

  private closeViewLayer(): void {
    const ctx = this.lastCtx;
    const viewLayer = this.activeViewLayer;
    if (!ctx || !viewLayer) return;
    ctx.stack.popIfTop((layer) => layer === viewLayer);
    this.actions.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    this.lastCtx = ctx;
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawText(terminalFont, 18, 14, "Terminal", 220);
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(terminalFont, 24, 38, this.statusLine(), 170);

    let listTop = HUB_LIST_TOP;
    if (!terminalHostSetting.get().trim()) {
      image.drawText(terminalFont, 24, 56, "To set up a server, see:", 150);
      image.drawText(terminalFont, 24, 70, "https://github.com/jimrandomh/g2mirror", 190);
      listTop += 32;
    }

    const items = this.hubItems();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
    for (let index = 0; index < items.length; index++) {
      const y = listTop + index * HUB_ROW_HEIGHT;
      if (y + HUB_ROW_HEIGHT > G2_LENS_HEIGHT - 40) break;
      const selected = index === this.selectedIndex;
      if (selected) {
        image.fillRoundedRect(20, y - 2, G2_LENS_WIDTH - 40, HUB_ROW_HEIGHT - 1, 15);
        image.drawRoundedRect(20, y - 2, G2_LENS_WIDTH - 40, HUB_ROW_HEIGHT - 1, 45);
      }
      image.drawText(terminalFont, 32, y + 2, items[index]!.label, selected ? 255 : 200);
    }

    image.drawText(terminalFont, 24, G2_LENS_HEIGHT - 36, "Double-click to go back", 110);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    this.lastCtx = ctx;
    const items = this.hubItems();
    switch (event.type) {
      case "double-click":
        ctx.stack.pop();
        return;
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
        return;
      case "click": {
        const item = items[Math.max(0, Math.min(this.selectedIndex, items.length - 1))];
        item?.onSelect(ctx);
        return;
      }
      default:
        return;
    }
  }

  onRemoved(): void {
    this.stopClient();
  }

  private statusLine(): string {
    const host = terminalHostSetting.get().trim();
    if (!host) {
      return "No host configured. Open Settings below.";
    }
    return this.clientState?.status ?? "Not connected.";
  }

  private hubItems(): HubItem[] {
    const items: HubItem[] = [];
    const state = this.clientState;
    const phase = state?.phase ?? "idle";

    if (phase === "connected" || phase === "attached") {
      for (const session of state?.sessions ?? []) {
        items.push({
          label: sessionLabel(session),
          onSelect: () => {
            this.client?.connectSession(session.socket);
          },
        });
      }
      if (!state?.sessions.length) {
        items.push({
          label: "(no live sessions; run g2mirror <command>)",
          onSelect: () => {
            this.client?.listSessions();
          },
        });
      }
    }
    if (phase === "idle" || phase === "failed") {
      items.push({
        label: terminalHostSetting.get().trim() ? "Connect" : "Connect (host not set)",
        onSelect: () => {
          this.startClient();
        },
      });
    }
    items.push({
      label: "Settings",
      onSelect: (ctx) => {
        ctx.stack.push(createTerminalSettingsMenuLayer());
      },
    });
    return items;
  }
}

/** Full-screen readonly mirror of the attached session. */
class TerminalViewLayer implements Layer {
  private readonly emulator: import("./terminal-emulator").TerminalEmulator;
  private receivedData = false;
  private unsubscribeData: (() => void) | null = null;

  constructor(
    private readonly client: G2MirrorClient,
    private readonly actions: LayerActions,
    private readonly onClosed: () => void,
  ) {
    // Lazy import keeps xterm out of the startup path; it is only needed
    // once a terminal is actually viewed.
    const { TerminalEmulator } = require("./terminal-emulator") as typeof import("./terminal-emulator");
    this.emulator = new TerminalEmulator(TERMINAL_COLS, TERMINAL_ROWS);
    this.unsubscribeData = client.onTerminalData((data, kind) => {
      if (kind === "snapshot") {
        this.emulator.reset();
      }
      this.receivedData = true;
      this.emulator.write(data, () => this.actions.requestRender());
    });
    client.view();
  }

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    if (!this.receivedData) {
      image.drawText(terminalFont, 24, 130, "Waiting for terminal output...", 170);
      image.drawText(terminalFont, 24, 150, "Double-click to go back", 110);
      return image;
    }
    const cursor = this.emulator.cursor();
    image.fillRect(cursor.x * CELL_WIDTH, cursor.y * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT, 70);
    const lines = this.emulator.visibleLines();
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row]!;
      if (line.length === 0) continue;
      image.drawText(terminalFont, 0, row * CELL_HEIGHT, line, 200);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    // Readonly for now: protocol v1 has no keyboard input, so scrolls and
    // clicks are ignored rather than forwarded.
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.unsubscribeData?.();
    this.unsubscribeData = null;
    // Let the wrapped app resize back for the person at the real keyboard,
    // and free the session for other clients.
    this.client.unview();
    this.client.disconnectSession();
    this.onClosed();
  }
}

// One-time check that the xterm-headless emulator evaluates and parses in
// this JS runtime, run at app open so a broken dependency surfaces in the log
// immediately instead of mid-session-attach.
let emulatorSelfTested = false;
function selfTestEmulator(): void {
  if (emulatorSelfTested) return;
  emulatorSelfTested = true;
  try {
    const { TerminalEmulator } = require("./terminal-emulator") as typeof import("./terminal-emulator");
    const emulator = new TerminalEmulator(8, 2);
    emulator.write(Uint8Array.from([0x68, 0x69, 0x1b, 0x5b, 0x31, 0x6d, 0x21]), () => {
      console.log(`terminal emulator self-test: ${JSON.stringify(emulator.visibleLines())}`);
    });
  } catch (error) {
    console.error("terminal emulator failed to load:", error);
  }
}

function createTerminalSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Terminal > Settings",
    [
      textSettingMenuItem(terminalHostSetting),
      textSettingMenuItem(terminalPortSetting),
      textSettingMenuItem(terminalAuthTokenSetting),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function sessionLabel(session: G2MirrorSession): string {
  const hint = session.cwdHint.replace(/^_+/, "").replace(/_+/g, "/");
  return `${hint || "session"}  (pid ${session.pid})`;
}
