import { DEFAULT_LLM_MODEL, type AnthropicMessage, type AnthropicToolDefinition } from "../native/anthropic";
import { DirectAnthropicBackend } from "./direct-backend";
import { toolRegistry, type ToolRegistry } from "./tool-registry";
import type { AssistantContext, AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

/**
 * One assistant conversation. Owns the message history and turn state and
 * drives a backend (direct Anthropic loop for phase 1). The UI talks only to
 * this surface, so swapping in the external-agent backend later doesn't touch
 * AssistantLayer.
 *
 * Sessions are cheap and idle-expire (see isExpired): the shell starts a fresh
 * one for a new wakeword and reuses the current one for a follow-up.
 */

/** A new PTT after this much idle starts a fresh conversation. */
const SESSION_IDLE_MS = 10 * 60 * 1000;

/** Trim history from the head once it grows past this many messages. */
const MAX_HISTORY_MESSAGES = 40;

const SYSTEM_PROMPT_BASE = [
  "You are the voice assistant built into a pair of Even Realities G2 smart glasses.",
  "Your reply is shown as text on a 576x288 monochrome heads-up display and may also be read aloud, so keep it short: 1-3 plain sentences, no markdown, no bullet lists unless the user explicitly asks for a list.",
  "Prefer doing things with the tools you have over describing how the user could do them; when a tool can answer or act, use it.",
  "If a tool fails or a capability is missing, say so briefly rather than inventing a result.",
].join(" ");

export class AssistantSession {
  private readonly backend = new DirectAnthropicBackend();
  private readonly messages: AnthropicMessage[] = [];
  private turnHandle: AssistantTurnHandle | null = null;
  private lastActivityMs = Date.now();
  // API-safe tool name -> canonical registry name. The Anthropic API only
  // allows [a-zA-Z0-9_-] in tool names, so dotted registry names ("glasses.
  // get_state") are sanitized for the request and mapped back on tool calls.
  private readonly toolNameMap = new Map<string, string>();

  constructor(
    private readonly apiKey: string,
    private readonly registry: ToolRegistry = toolRegistry,
  ) {}

  /** Whether this session has been idle long enough to retire. */
  isExpired(nowMs = Date.now()): boolean {
    return nowMs - this.lastActivityMs > SESSION_IDLE_MS;
  }

  isTurnActive(): boolean {
    return this.turnHandle !== null;
  }

  /** Begin a turn from a spoken utterance. Only one turn runs at a time. */
  sendUtterance(text: string, ctx: AssistantContext, callbacks: AssistantTurnCallbacks): void {
    if (this.turnHandle) {
      callbacks.onError("The assistant is still working on the previous request");
      return;
    }
    this.lastActivityMs = Date.now();
    this.messages.push({ role: "user", content: text });
    this.trimHistory();

    const tools = this.buildToolDefinitions();
    const system = `${SYSTEM_PROMPT_BASE}\n\n${describeContext(ctx)}`;

    const finish = () => {
      this.turnHandle = null;
      this.lastActivityMs = Date.now();
    };

    this.turnHandle = this.backend.runTurn({
      apiKey: this.apiKey,
      model: DEFAULT_LLM_MODEL,
      effort: "low",
      system,
      messages: this.messages,
      tools,
      registry: this.registry,
      resolveToolName: (apiName) => this.toolNameMap.get(apiName) ?? apiName,
      callbacks: {
        onTextDelta: callbacks.onTextDelta,
        onToolActivity: callbacks.onToolActivity,
        onTurnDone: (result) => {
          finish();
          callbacks.onTurnDone(result);
        },
        onError: (message) => {
          finish();
          callbacks.onError(message);
        },
      },
    });
  }

  cancel(): void {
    this.turnHandle?.cancel();
    this.turnHandle = null;
    this.lastActivityMs = Date.now();
  }

  private buildToolDefinitions(): AnthropicToolDefinition[] {
    this.toolNameMap.clear();
    return this.registry.listTools().map((spec) => {
      const apiName = this.toApiToolName(spec.name);
      this.toolNameMap.set(apiName, spec.name);
      return { name: apiName, description: spec.description, input_schema: spec.inputSchema };
    });
  }

  /** Convert a canonical registry name to an Anthropic-legal tool name. */
  private toApiToolName(name: string): string {
    let base = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Disambiguate the rare case where two canonical names sanitize alike.
    if (this.toolNameMap.has(base)) {
      let i = 2;
      while (this.toolNameMap.has(`${base}_${i}`)) i++;
      base = `${base}_${i}`;
    }
    return base;
  }

  private trimHistory(): void {
    if (this.messages.length <= MAX_HISTORY_MESSAGES) return;
    // Drop whole messages from the head. A leading orphan tool_result (whose
    // tool_use we trimmed) would be rejected by the API, so skip past any
    // tool_result-only user message left at the front.
    const overflow = this.messages.length - MAX_HISTORY_MESSAGES;
    this.messages.splice(0, overflow);
    while (this.messages.length && startsWithToolResult(this.messages[0]!)) {
      this.messages.shift();
    }
  }
}

function startsWithToolResult(message: AnthropicMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content[0]!.type === "tool_result"
  );
}

function describeContext(ctx: AssistantContext): string {
  const parts = [`Current time: ${ctx.localTime}.`];
  parts.push(`The glasses display is currently ${ctx.screenOn ? "on" : "off"}.`);
  if (ctx.foregroundApp) {
    const title = ctx.foregroundTitle ? ` ("${ctx.foregroundTitle}")` : "";
    parts.push(`The foreground app is ${ctx.foregroundApp}${title}.`);
  } else {
    parts.push("No app is in the foreground (the launcher is showing).");
  }
  if (ctx.headsetBattery !== null) {
    parts.push(`Glasses battery: ${ctx.headsetBattery}%.`);
  }
  return `Context: ${parts.join(" ")}`;
}
