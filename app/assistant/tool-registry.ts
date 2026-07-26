/**
 * The assistant's tool registry: the single place that knows which tools exist,
 * whether each is currently callable, and how to invoke it. Both assistant
 * backends (direct provider loop, external agent bridge) list and call tools
 * through here, so gating and timeouts are enforced in one spot rather than
 * trusted to a model or a remote agent.
 *
 * Availability tiers (see notes/voice-assistant-design.md):
 *   - "always"     system/shell tools; no app involved.
 *   - "installed"  app tool live whenever the app is installed (no window
 *                  needed) -- e.g. "start a 5 minute timer".
 *   - "open"       app tool live while the app has a window open, foreground
 *                  or backgrounded -- e.g. "next track".
 *   - "foreground" app tool live only while the app owns the foreground window
 *                  -- e.g. "scroll down".
 *
 * Phase 1 only registers "always" tools; the tier machinery is here so the
 * app-tool phases slot in without reshaping the registry.
 */

export type ToolAvailability = "always" | "installed" | "open" | "foreground";

export type ToolSpec = {
  /** Namespaced, e.g. "glasses.get_state" or "app.terminal.send_input". */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: object;
  availability: ToolAvailability;
  /** May be invoked outside an active voice turn (external mode proactive calls). */
  proactive?: boolean;
  /** Round-trip cap; the registry rejects with a tool error past it. Default 10s. */
  timeoutMs?: number;
};

/**
 * A tool's outcome. Flat (not a discriminated union) on purpose: this project
 * builds with strictNullChecks off, so `ok: true|false` would widen to boolean
 * and defeat union narrowing. Read `content` when ok, `error` when not.
 */
export type ToolResult = {
  ok: boolean;
  /** Text payload back to the model (when ok). */
  content?: string;
  /** Error message back to the model (when not ok). */
  error?: string;
};

export type ToolHandler = (args: any) => Promise<ToolResult> | ToolResult;

export type ToolRegistration = {
  spec: ToolSpec;
  handler: ToolHandler;
  /**
   * Whether the tool is currently live. Absent means always live (the "always"
   * tier). App-tool phases supply a predicate keyed on window/foreground state.
   */
  isAvailable?: () => boolean;
};

export type ListToolsOptions = {
  /** Only tools flagged proactive (for calls outside an active turn). */
  proactiveOnly?: boolean;
};

export type CallToolOptions = {
  /** The call is happening outside an active voice turn; enforce proactive gating. */
  proactive?: boolean;
};

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** One registration as seen by the shell's tool-debug dialog. */
export type ToolDebugEntry = {
  spec: ToolSpec;
  /** The window that contributed the tool, or null for system-registered tools. */
  windowId: string | null;
  /** Whether the tool is callable right now (availability gate at snapshot time). */
  live: boolean;
};

/** How the shell reaches a window's tool handler and gates its foreground tools. */
export type AppToolProvider = {
  windowId: string;
  appId: string;
  /** The window's declared specs, with UNPREFIXED names (registry adds the prefix). */
  specs: ToolSpec[];
  /** Invoke a tool on the window by its unprefixed name. */
  invoke: (toolName: string, args: unknown) => Promise<ToolResult> | ToolResult;
  /** Whether the window currently owns the foreground (gates `foreground` tools). */
  isForeground: () => boolean;
};

export class ToolRegistry {
  private readonly registrations = new Map<string, ToolRegistration>();
  private readonly changeListeners = new Set<() => void>();
  // windowId -> the canonical (prefixed) tool names it contributed, for bulk
  // removal when the window closes or re-declares.
  private readonly windowToolNames = new Map<string, string[]>();

  /** Register (or replace) a tool. Names are unique across all tiers. */
  register(registration: ToolRegistration): void {
    this.addRegistration(registration);
    this.fireToolsChanged();
  }

  /** Convenience for the always-live system tools. */
  registerSystemTool(
    spec: Omit<ToolSpec, "availability">,
    handler: ToolHandler,
  ): void {
    this.register({ spec: { ...spec, availability: "always" }, handler });
  }

  unregister(name: string): void {
    if (this.registrations.delete(name)) {
      this.fireToolsChanged();
    }
  }

  /**
   * Declare (replacing any prior set) the tools contributed by one app window.
   * Names are prefixed `app.<appId>.` so windows can't shadow system tools or
   * each other. `open` tools stay live while the window exists; `foreground`
   * tools are gated on `isForeground()` at both list and call time.
   */
  setAppTools(provider: AppToolProvider): void {
    this.clearWindowTools(provider.windowId, false);
    const names: string[] = [];
    for (const spec of provider.specs) {
      if (spec.availability !== "open" && spec.availability !== "foreground") {
        console.warn(`app tool ${spec.name} has non-app availability ${spec.availability}; skipping`);
        continue;
      }
      const canonical = `app.${provider.appId}.${spec.name}`;
      const toolName = spec.name;
      this.addRegistration({
        spec: { ...spec, name: canonical },
        handler: (args) => provider.invoke(toolName, args),
        isAvailable: spec.availability === "foreground" ? () => provider.isForeground() : undefined,
      });
      names.push(canonical);
    }
    this.windowToolNames.set(provider.windowId, names);
    this.fireToolsChanged();
  }

  /** Remove all tools contributed by a window (its worker closed or the window did). */
  removeAppTools(windowId: string): void {
    this.clearWindowTools(windowId, true);
  }

  private clearWindowTools(windowId: string, fire: boolean): void {
    const names = this.windowToolNames.get(windowId);
    if (!names) return;
    for (const name of names) {
      this.registrations.delete(name);
    }
    this.windowToolNames.delete(windowId);
    if (fire) this.fireToolsChanged();
  }

  private addRegistration(registration: ToolRegistration): void {
    this.registrations.set(registration.spec.name, registration);
  }

  /** Specs for the tools callable right now, given the availability tiers. */
  listTools(options: ListToolsOptions = {}): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const registration of this.registrations.values()) {
      if (!this.isLive(registration)) continue;
      if (options.proactiveOnly && !registration.spec.proactive) continue;
      specs.push(registration.spec);
    }
    return specs;
  }

  /**
   * Snapshot of every registration, including ones not currently live — for
   * the shell's debug dialog only; backends must use listTools.
   */
  listToolsForDebug(): ToolDebugEntry[] {
    const ownerByName = new Map<string, string>();
    for (const [windowId, names] of this.windowToolNames) {
      for (const name of names) ownerByName.set(name, windowId);
    }
    const entries: ToolDebugEntry[] = [];
    for (const registration of this.registrations.values()) {
      entries.push({
        spec: registration.spec,
        windowId: ownerByName.get(registration.spec.name) ?? null,
        live: this.isLive(registration),
      });
    }
    return entries;
  }

  /**
   * Invoke a tool by name. Never throws: a missing/unavailable tool, a
   * proactive-gating rejection, a handler exception, or a timeout all come back
   * as `{ ok: false }` so the agent loop can surface them as tool errors.
   */
  async callTool(name: string, args: unknown, options: CallToolOptions = {}): Promise<ToolResult> {
    const registration = this.registrations.get(name);
    if (!registration) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    if (!this.isLive(registration)) {
      return { ok: false, error: `Tool ${name} is not currently available` };
    }
    if (options.proactive && !registration.spec.proactive) {
      return { ok: false, error: `Tool ${name} cannot be called outside a conversation` };
    }
    const timeoutMs = registration.spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    try {
      return await this.withTimeout(registration.handler(args), timeoutMs, name);
    } catch (error) {
      return { ok: false, error: `Tool ${name} failed: ${describeError(error)}` };
    }
  }

  /** Subscribe to add/remove/availability changes (drives MCP list_changed). */
  onToolsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** App-tool phases call this after a foreground/window change re-gates tools. */
  fireToolsChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("onToolsChanged listener failed", error);
      }
    }
  }

  private isLive(registration: ToolRegistration): boolean {
    return registration.isAvailable ? registration.isAvailable() : true;
  }

  private withTimeout(
    result: Promise<ToolResult> | ToolResult,
    timeoutMs: number,
    name: string,
  ): Promise<ToolResult> {
    if (!(result instanceof Promise)) return Promise.resolve(result);
    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: `Tool ${name} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      result.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: `Tool ${name} failed: ${describeError(error)}` });
        },
      );
    });
  }
}

function describeError(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/** The process-wide registry; system tools register into it at startup. */
export const toolRegistry = new ToolRegistry();
