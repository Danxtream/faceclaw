import { buildAssistantSystemPrompt } from "../prompts";
import { DirectAssistantBackend } from "./direct-backend";
import type { LlmMessage, LlmToolDefinition } from "./llm-protocol";
import type { ResolvedAssistantModel } from "./models";
import { toolRegistry, type ToolRegistry } from "./tool-registry";
import type { AssistantContext, AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

/**
 * One assistant conversation. Owns the message history and turn state and
 * drives a direct provider backend. The UI talks only to
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

export class AssistantSession {
  private readonly backend = new DirectAssistantBackend();
  private readonly messages: LlmMessage[] = [];
  private turnHandle: AssistantTurnHandle | null = null;
  private lastActivityMs = Date.now();
  // API-safe tool name -> canonical registry name. Provider APIs restrict tool
  // names, so dotted registry names are sanitized and mapped back on calls.
  private readonly toolNameMap = new Map<string, string>();

  constructor(
    private readonly llm: ResolvedAssistantModel,
    private readonly registry: ToolRegistry = toolRegistry,
  ) {}

  matchesConfiguration(llm: ResolvedAssistantModel): boolean {
    return (
      this.llm.provider === llm.provider &&
      this.llm.model === llm.model &&
      this.llm.apiKey === llm.apiKey
    );
  }

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

    const system = buildAssistantSystemPrompt(ctx);

    const finish = () => {
      this.turnHandle = null;
      this.lastActivityMs = Date.now();
    };

    this.turnHandle = this.backend.runTurn({
      provider: this.llm.provider,
      apiKey: this.llm.apiKey,
      model: this.llm.model,
      effort: this.llm.effort,
      system,
      messages: this.messages,
      buildTools: () => this.buildToolDefinitions(),
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

  private buildToolDefinitions(): LlmToolDefinition[] {
    this.toolNameMap.clear();
    return this.registry.listTools().map((spec) => {
      const apiName = this.toApiToolName(spec.name);
      this.toolNameMap.set(apiName, spec.name);
      return { name: apiName, description: spec.description, input_schema: spec.inputSchema };
    });
  }

  /** Convert a canonical registry name to a provider-legal tool name. */
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

function startsWithToolResult(message: LlmMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content[0]!.type === "tool_result"
  );
}
