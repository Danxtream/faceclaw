/**
 * Shell-side nav.* assistant tools. The Navigate app's own tools are
 * window-scoped ("open" tier), but the core use case is "navigate to X" with
 * the app closed — so these always-available wrappers launch the app first,
 * wait for its tools to register, and forward the call.
 */
import { ensureFineLocationPermission } from "../g2/android-permissions";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

const APP_TOOL_PREFIX = "app.navigate.";
const TOOL_APPEAR_TIMEOUT_MS = 5_000;
const TOOL_APPEAR_POLL_MS = 150;

let registered = false;

export function registerNavigateTools(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry = toolRegistry,
): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "nav.start_navigation",
      description:
        "Start turn-by-turn navigation on the glasses to a destination given as free text (place name, business, or address near the user). Opens the Navigate app. Returns the resolved destination, distance, and ETA; if the wrong place was resolved, call again with a more specific query.",
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Where to navigate to." },
          profile: {
            type: "string",
            enum: ["driving", "walking", "cycling"],
            description: "Travel mode (default driving).",
          },
        },
        required: ["destination"],
        additionalProperties: false,
      },
      // Launch + GPS fix + geocode + route can add up; stay above the app
      // tool's own 14 s budget.
      timeoutMs: 25_000,
    },
    async (args) => {
      const destination = String(args?.destination ?? "").trim();
      if (!destination) return err("nav.start_navigation requires a destination");
      // Fire the permission prompt early; the phone shows it while we work.
      void ensureFineLocationPermission().catch(() => {});
      const forwarded = await callAppTool(launchApp, registry, "start_route", {
        query: destination,
        profile: args?.profile,
      });
      return forwarded;
    },
  );

  registry.registerSystemTool(
    {
      name: "nav.stop_navigation",
      description: "Stop the current glasses navigation session, if one is active.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      if (!registry.listTools().some((tool) => tool.name === `${APP_TOOL_PREFIX}stop_route`)) {
        return ok("Navigation is not active.");
      }
      return registry.callTool(`${APP_TOOL_PREFIX}stop_route`, {});
    },
  );

  registry.registerSystemTool(
    {
      name: "nav.route_status",
      description:
        "Get the current navigation status: next maneuver, distance remaining, and ETA. Reports inactive when nothing is being navigated.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    async () => {
      if (!registry.listTools().some((tool) => tool.name === `${APP_TOOL_PREFIX}route_status`)) {
        return ok("Navigation is not active.");
      }
      return registry.callTool(`${APP_TOOL_PREFIX}route_status`, {});
    },
  );
}

/** Launch the Navigate app if needed, wait for its tool, and forward the call. */
async function callAppTool(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry,
  unprefixedName: string,
  args: unknown,
): Promise<ToolResult> {
  const fullName = `${APP_TOOL_PREFIX}${unprefixedName}`;
  if (!registry.listTools().some((tool) => tool.name === fullName)) {
    await launchApp("navigate");
    const deadline = Date.now() + TOOL_APPEAR_TIMEOUT_MS;
    while (!registry.listTools().some((tool) => tool.name === fullName)) {
      if (Date.now() > deadline) {
        return err("The Navigate app did not start in time.");
      }
      await sleep(TOOL_APPEAR_POLL_MS);
    }
  }
  return registry.callTool(fullName, args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
