/**
 * Shell-side roam.* assistant tools. The Roam app's own tools are
 * window-scoped ("open" tier), but "add milk to my todo list" should work
 * with the app closed — so these always-available wrappers launch the app,
 * wait for its tools to register, and forward the call.
 */
import { roamApiTokenSetting, roamGraphNameSetting } from "../ui/dashboard-settings";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

const APP_TOOL_PREFIX = "app.roam.";
const TOOL_APPEAR_TIMEOUT_MS = 5_000;
const TOOL_APPEAR_POLL_MS = 150;

let registered = false;

export function registerRoamTools(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry = toolRegistry,
): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "roam.add_todo",
      description:
        "Add a TODO item to the user's Roam Research daily notes page (their main todo list). Opens the Roam app on the glasses.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The todo item's text." } },
        required: ["text"],
        additionalProperties: false,
      },
      timeoutMs: 25_000,
    },
    async (args) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return err("roam.add_todo requires text");
      return callAppTool(launchApp, registry, "add_todo", { text });
    },
  );

  registry.registerSystemTool(
    {
      name: "roam.read_todos",
      description:
        "Read the user's Roam Research daily notes page, including their todo list with each item's done/open state. Opens the Roam app on the glasses.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 25_000,
    },
    async () => callAppTool(launchApp, registry, "read_page", {}),
  );
}

/** Launch the Roam app if needed, wait for its tool, and forward the call. */
async function callAppTool(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry,
  unprefixedName: string,
  args: unknown,
): Promise<ToolResult> {
  if (roamGraphNameSetting.get().length === 0 || roamApiTokenSetting.get().length === 0) {
    return err("Roam is not configured; the user must set the graph name and API token in Settings > Roam.");
  }
  const fullName = `${APP_TOOL_PREFIX}${unprefixedName}`;
  if (!registry.listTools().some((tool) => tool.name === fullName)) {
    await launchApp("roam");
    const deadline = Date.now() + TOOL_APPEAR_TIMEOUT_MS;
    while (!registry.listTools().some((tool) => tool.name === fullName)) {
      if (Date.now() > deadline) {
        return err("The Roam app did not start in time.");
      }
      await sleep(TOOL_APPEAR_POLL_MS);
    }
  }
  return registry.callTool(fullName, args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
