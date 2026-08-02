import { AssistantMcpServer } from "./mcp-server";
import { toolRegistry } from "./tool-registry";
import type { AssistantContext, AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

declare const com: any;

/**
 * Dial-out websocket client for the external assistant bridge (an OpenClaw
 * plugin or compatible server on the user's machine; see
 * notes/voice-assistant-design.md "External mode"). One JSON object per text
 * frame, three multiplexed channels:
 *
 *   ctl:  hello/hello-ack auth handshake, ping/pong, error
 *   chat: utterance in, streamed reply out (per-turn)
 *   mcp:  raw MCP JSON-RPC; the phone is the MCP *server* (ToolRegistry)
 *
 * Unlike G2MirrorClient (per-terminal-window, no reconnect), this connection
 * is a long-lived shell service: it stays up while configured so the remote
 * agent can make proactive tool calls, and it re-dials with backoff.
 */

const PROTOCOL_VERSION = 1;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** Backstop on a turn the bridge never finishes (server-side cap is 2 min). */
const TURN_TIMEOUT_MS = 3 * 60 * 1000;

export type AssistantBridgePhase = "idle" | "connecting" | "connected" | "failed";

export type AssistantBridgeState = {
  phase: AssistantBridgePhase;
  status: string;
};

export type AssistantBridgeOptions = {
  host: string;
  port: number;
  token: string;
  deviceName: string;
  /** Reads assistant.allowProactive; consulted per proactive tool call. */
  allowProactive: () => boolean;
};

type ActiveTurn = {
  turnId: string;
  callbacks: AssistantTurnCallbacks;
  textSoFar: string;
  timer: ReturnType<typeof setTimeout>;
};

export class AssistantBridgeClient {
  private options: AssistantBridgeOptions | null = null;
  private ws: any = null;
  private listenerProxy: any = null;
  private phase: AssistantBridgePhase = "idle";
  private status = "Not configured.";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private activeTurn: ActiveTurn | null = null;
  private turnSeq = 0;
  private mcpServer: AssistantMcpServer | null = null;
  private unsubscribeToolsChanged: (() => void) | null = null;
  private readonly stateListeners = new Set<(state: AssistantBridgeState) => void>();

  state(): AssistantBridgeState {
    return { phase: this.phase, status: this.status };
  }

  onStateChange(listener: (state: AssistantBridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.phase === "connected";
  }

  /**
   * Set (or replace) the bridge configuration and connect. Safe to call again
   * with new settings; the old connection is torn down first.
   */
  configure(options: AssistantBridgeOptions): void {
    this.stop();
    this.options = options;
    this.stopped = false;
    this.mcpServer = new AssistantMcpServer({
      send: (msg) => this.send({ chan: "mcp", msg }),
      isTurnActive: () => this.activeTurn !== null,
      allowProactive: options.allowProactive,
    });
    this.unsubscribeToolsChanged = toolRegistry.onToolsChanged(() => {
      if (this.phase === "connected") this.mcpServer?.sendToolsChanged();
    });
    this.connect();
  }

  /** Disconnect and stay down until the next configure(). */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.failActiveTurn("Bridge connection closed");
    if (this.unsubscribeToolsChanged) {
      this.unsubscribeToolsChanged();
      this.unsubscribeToolsChanged = null;
    }
    this.mcpServer = null;
    if (this.ws) {
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

  /**
   * Send an utterance as a new turn. Streaming replies arrive via callbacks.
   * A turn already in flight is superseded (the session serializes turns, so
   * this is just a safety net).
   */
  sendUtterance(
    text: string,
    ctx: AssistantContext,
    callbacks: AssistantTurnCallbacks,
  ): AssistantTurnHandle {
    if (this.phase !== "connected") {
      callbacks.onError(`Agent bridge is not connected (${this.status})`);
      return { cancel: () => {} };
    }
    this.failActiveTurn("Superseded by a new request");
    const turnId = `t${++this.turnSeq}`;
    this.activeTurn = {
      turnId,
      callbacks,
      textSoFar: "",
      timer: setTimeout(() => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.failActiveTurn("The agent took too long to reply");
      }, TURN_TIMEOUT_MS),
    };
    this.send({ chan: "chat", type: "utterance", turnId, text, ctx });
    return {
      cancel: () => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.send({ chan: "chat", type: "cancel", turnId });
        this.clearActiveTurn();
      },
    };
  }

  private connect(): void {
    if (this.stopped || this.ws || !this.options) return;
    const { host, port } = this.options;
    const url = `ws://${host}:${port}`;
    this.setState("connecting", `Connecting to ${host}:${port}...`);
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (this.stopped) return;
        this.setState("connecting", "Authenticating...");
        this.send({
          chan: "ctl",
          type: "hello",
          version: PROTOCOL_VERSION,
          token: this.options!.token,
          deviceName: this.options!.deviceName,
          capabilities: ["chat", "mcp"],
        });
      },
      onTextMessage: (message: string) => {
        if (this.stopped) return;
        this.handleMessage(String(message));
      },
      onClosed: (code: number, reason: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(
          `Connection closed (${Number(code)}${reason ? `: ${String(reason)}` : ""})`,
        );
      },
      onFailure: (message: string) => {
        if (this.stopped) return;
        this.handleConnectionLost(`Connection failed: ${String(message)}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, null, null);
    } catch (error) {
      this.ws = null;
      this.handleConnectionLost(
        `Connection failed: ${String((error as Error)?.message ?? error)}`,
      );
    }
  }

  private handleMessage(raw: string): void {
    let frame: any = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    switch (frame.chan) {
      case "ctl":
        this.handleCtl(frame);
        return;
      case "chat":
        this.handleChat(frame);
        return;
      case "mcp":
        this.mcpServer?.handleMessage(frame.msg);
        return;
      default:
        return;
    }
  }

  private handleCtl(frame: any): void {
    if (frame.type === "hello-ack") {
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.setState("connected", `Connected to ${String(frame.serverName ?? "bridge")}`);
      return;
    }
    if (frame.type === "ping") {
      this.send({ chan: "ctl", type: "pong", ts: frame.ts });
      return;
    }
    if (frame.type === "error") {
      // The server closes after a ctl error; the close handler schedules the
      // re-dial. Record the reason so the status is more useful than a bare
      // close code (especially for a bad token).
      this.status = `Bridge error: ${String(frame.message ?? "unknown")}`;
      return;
    }
  }

  private handleChat(frame: any): void {
    const turn = this.activeTurn;
    if (!turn || frame.turnId !== turn.turnId) return;
    switch (frame.type) {
      case "text-delta": {
        const text = typeof frame.text === "string" ? frame.text : "";
        turn.textSoFar = frame.replace === true ? text : turn.textSoFar + text;
        turn.callbacks.onTextDelta(text, turn.textSoFar);
        return;
      }
      case "tool-activity":
        turn.callbacks.onToolActivity(String(frame.label ?? "tool"));
        return;
      case "turn-done": {
        this.clearActiveTurn();
        turn.callbacks.onTurnDone({
          stopReason: typeof frame.stopReason === "string" ? frame.stopReason : null,
        });
        return;
      }
      case "turn-error":
        this.clearActiveTurn();
        turn.callbacks.onError(String(frame.message ?? "Agent error"));
        return;
      default:
        return;
    }
  }

  private handleConnectionLost(status: string): void {
    this.ws = null;
    this.listenerProxy = null;
    // Keep a ctl-error status (e.g. "invalid token") in preference to the
    // generic close message that follows it.
    const detail = this.status.startsWith("Bridge error:") ? this.status : status;
    this.failActiveTurn("Bridge connection lost");
    this.setState("failed", detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearActiveTurn(): void {
    if (!this.activeTurn) return;
    clearTimeout(this.activeTurn.timer);
    this.activeTurn = null;
  }

  private failActiveTurn(message: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.clearActiveTurn();
    turn.callbacks.onError(message);
  }

  private send(frame: object): void {
    if (!this.ws) return;
    try {
      this.ws.sendText(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    } catch {
      // A send on a dying socket; the close/failure callback handles recovery.
    }
  }

  private setState(phase: AssistantBridgePhase, status: string): void {
    this.phase = phase;
    this.status = status;
    const state = this.state();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // listeners must not break the client
      }
    }
  }
}

/** Process-wide bridge client (main isolate), configured by the dashboard controller. */
export const assistantBridge = new AssistantBridgeClient();
