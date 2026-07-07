import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const android: any;

/**
 * Client for the g2mirror terminal-mirroring protocol (see
 * ../experiments/g2mirror/PROTOCOL.md). One instance per Terminal app
 * session; talks JSON over a websocket to g2mirror-server, which relays to
 * one wrapped CLI app at a time.
 */

const PROTOCOL_VERSION = 1;
const SESSION_LIST_REFRESH_MS = 3_000;

export type G2MirrorSession = {
  socket: string;
  pid: number;
  cwdHint: string;
  /** Unix epoch ms of the terminal's last bell, or null if none observed. */
  lastBellAt: number | null;
  /** Window title the app last set (xterm OSC 0/2), or null if none observed. */
  title: string | null;
};

export type G2MirrorPhase =
  | "idle"
  | "connecting"
  | "connected" // handshake accepted; can list/attach
  | "attached" // relaying to one session
  | "failed";

export type G2MirrorState = {
  phase: G2MirrorPhase;
  status: string;
  sessions: G2MirrorSession[];
  attachedCommand: string;
};

export type G2MirrorClientOptions = {
  host: string;
  port: number;
  authToken: string;
  deviceName: string;
  cols: number;
  rows: number;
};

type TerminalDataKind = "snapshot" | "output";

export class G2MirrorClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private phase: G2MirrorPhase = "idle";
  private status = "Not connected.";
  private sessions: G2MirrorSession[] = [];
  private attachedCommand = "";
  private listRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();
  private readonly terminalDataListeners = new Set<(data: Uint8Array, kind: TerminalDataKind) => void>();
  private readonly sessionAttachedListeners = new Set<(command: string) => void>();
  private readonly sessionDetachedListeners = new Set<(reason: string) => void>();
  private readonly bellListeners = new Set<(socket: string, lastBellAtMs: number) => void>();
  private readonly titleListeners = new Set<(socket: string, title: string) => void>();

  constructor(private readonly options: G2MirrorClientOptions) {}

  state(): G2MirrorState {
    return {
      phase: this.phase,
      status: this.status,
      sessions: this.sessions.slice(),
      attachedCommand: this.attachedCommand,
    };
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Raw VT100/xterm bytes to feed the emulator. Snapshot implies reset-first. */
  onTerminalData(listener: (data: Uint8Array, kind: TerminalDataKind) => void): () => void {
    this.terminalDataListeners.add(listener);
    return () => this.terminalDataListeners.delete(listener);
  }

  onSessionAttached(listener: (command: string) => void): () => void {
    this.sessionAttachedListeners.add(listener);
    return () => this.sessionAttachedListeners.delete(listener);
  }

  onSessionDetached(listener: (reason: string) => void): () => void {
    this.sessionDetachedListeners.add(listener);
    return () => this.sessionDetachedListeners.delete(listener);
  }

  /** Unsolicited bell notification for any monitored terminal (rate-limited server-side). */
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void {
    this.bellListeners.add(listener);
    return () => this.bellListeners.delete(listener);
  }

  /** Unsolicited title change for any monitored terminal. */
  onTitle(listener: (socket: string, title: string) => void): () => void {
    this.titleListeners.add(listener);
    return () => this.titleListeners.delete(listener);
  }

  start(): void {
    if (this.ws) return;
    this.stopped = false;
    const url = `ws://${this.options.host}:${this.options.port}`;
    this.setState("connecting", `Connecting to ${this.options.host}:${this.options.port}...`);
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (this.stopped) return;
        this.setState("connecting", "Authenticating...");
        this.send({
          type: "init",
          version: PROTOCOL_VERSION,
          auth_token: this.options.authToken,
          device: this.options.deviceName,
          width: this.options.cols,
          height: this.options.rows,
        });
      },
      onTextMessage: (message: string) => {
        if (this.stopped) return;
        this.handleMessage(String(message));
      },
      onClosed: (code: number, reason: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(`Connection closed (${Number(code)}${reason ? `: ${String(reason)}` : ""}).`);
      },
      onFailure: (message: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(`Connection failed: ${shortenError(String(message))}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, null, null);
    } catch (error) {
      this.ws = null;
      this.handleConnectionLost(`Connection failed: ${shortenError(String((error as Error)?.message ?? error))}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearListRefreshTimer();
    if (this.ws) {
      // Best effort: let the wrapped app resize back before we go away.
      if (this.phase === "attached") {
        this.send({ type: "unview" });
        this.send({ type: "disconnect" });
      }
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
    this.setState("idle", "Not connected.");
  }

  listSessions(): void {
    if (this.phase === "connected" || this.phase === "attached") {
      this.send({ type: "list" });
    }
  }

  connectSession(socket: string): void {
    if (this.phase !== "connected") return;
    this.setState(this.phase, "Attaching to session...");
    this.send({ type: "connect", socket });
  }

  disconnectSession(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "unview" });
    this.send({ type: "disconnect" });
  }

  view(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "view" });
  }

  unview(): void {
    if (this.phase !== "attached") return;
    this.send({ type: "unview" });
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "init":
        this.setState("connected", "Connected.");
        this.listSessions();
        this.ensureListRefreshTimer();
        return;
      case "error": {
        const errorText = String(message.message ?? "unknown error");
        if (this.phase === "connecting") {
          // Handshake rejection; the server closes the socket after this.
          this.setState("failed", `Rejected: ${errorText}`);
        } else {
          this.setState(this.phase, `Server error: ${errorText}`);
        }
        return;
      }
      case "sessions": {
        const raw = Array.isArray(message.sessions) ? message.sessions : [];
        this.sessions = raw
          .map((item: any): G2MirrorSession => ({
            socket: String(item?.socket ?? ""),
            pid: Number(item?.pid) || 0,
            cwdHint: String(item?.cwd_hint ?? ""),
            lastBellAt: typeof item?.last_bell_at === "number" ? item.last_bell_at : null,
            title: typeof item?.title === "string" ? item.title : null,
          }))
          .filter((session: G2MirrorSession) => session.socket.length > 0);
        this.emitState();
        return;
      }
      case "bell": {
        const socket = String(message.socket ?? "");
        const lastBellAt = Number(message.last_bell_at) || Date.now();
        if (!socket) return;
        const session = this.sessions.find((s) => s.socket === socket);
        if (session) session.lastBellAt = lastBellAt;
        for (const listener of Array.from(this.bellListeners)) {
          listener(socket, lastBellAt);
        }
        return;
      }
      case "title": {
        const socket = String(message.socket ?? "");
        const title = String(message.title ?? "");
        if (!socket) return;
        const session = this.sessions.find((s) => s.socket === socket);
        if (session) session.title = title;
        for (const listener of Array.from(this.titleListeners)) {
          listener(socket, title);
        }
        this.emitState();
        return;
      }
      case "connect": {
        // Session accepted us (relayed from the wrapper).
        this.clearListRefreshTimer();
        this.attachedCommand = String(message.command ?? "");
        this.setState("attached", `Attached: ${this.attachedCommand || "session"}`);
        for (const listener of Array.from(this.sessionAttachedListeners)) {
          listener(this.attachedCommand);
        }
        return;
      }
      case "snapshot":
      case "output": {
        const data = decodeBase64(String(message.data ?? ""));
        for (const listener of Array.from(this.terminalDataListeners)) {
          listener(data, message.type as TerminalDataKind);
        }
        return;
      }
      case "exit": {
        const status = message.status === null || message.status === undefined ? "signal" : String(message.status);
        this.setState(this.phase, `Session exited (status ${status}).`);
        return;
      }
      case "disconnected": {
        const reason = String(message.reason ?? "unknown");
        this.attachedCommand = "";
        if (this.phase === "attached") {
          this.setState("connected", `Detached (${reason}).`);
          this.ensureListRefreshTimer();
          this.listSessions();
          for (const listener of Array.from(this.sessionDetachedListeners)) {
            listener(reason);
          }
        }
        return;
      }
      default:
        // Unknown message types are expected; ignore for forward compatibility.
        return;
    }
  }

  private handleConnectionLost(statusText: string): void {
    this.clearListRefreshTimer();
    this.ws = null;
    this.listenerProxy = null;
    const wasAttached = this.phase === "attached";
    this.attachedCommand = "";
    this.setState("failed", statusText);
    if (wasAttached) {
      for (const listener of Array.from(this.sessionDetachedListeners)) {
        listener("connection lost");
      }
    }
  }

  private ensureListRefreshTimer(): void {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = setInterval(() => {
      if (this.phase === "connected") {
        this.listSessions();
      }
    }, SESSION_LIST_REFRESH_MS);
  }

  private clearListRefreshTimer(): void {
    if (this.listRefreshTimer) {
      clearInterval(this.listRefreshTimer);
      this.listRefreshTimer = null;
    }
  }

  private send(message: object): void {
    if (!this.ws) return;
    try {
      this.ws.sendText(JSON.stringify(message));
    } catch (error) {
      console.warn("g2mirror send failed", error);
    }
  }

  private setState(phase: G2MirrorPhase, status: string): void {
    this.phase = phase;
    this.status = status;
    this.emitState();
  }

  private emitState(): void {
    const state = this.state();
    for (const listener of Array.from(this.stateListeners)) {
      listener(state);
    }
  }
}

function decodeBase64(data: string): Uint8Array {
  if (!data) return new Uint8Array(0);
  return toUint8Array(android.util.Base64.decode(data, android.util.Base64.DEFAULT));
}

function shortenError(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}
