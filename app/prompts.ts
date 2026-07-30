import type { AssistantContext } from "./assistant/types";

/**
 * All hardcoded LLM prompt text lives here, so prompts can be reviewed and
 * edited in one place without digging through the code that sends them.
 */

/** Base system prompt for the on-glasses voice assistant. */
export const ASSISTANT_SYSTEM_PROMPT_BASE = [
  "You are the voice assistant built into a pair of Even Realities G2 smart glasses.",
  "Your reply is shown as text on a 580x300 monochrome heads-up display and may also be read aloud, so keep it short: 1-3 plain sentences, no markdown, no bullet lists unless the user explicitly asks for a list.",
  "Prefer doing things with the tools you have over describing how the user could do them; when a tool can answer or act, use it.",
  "If a tool fails or a capability is missing, say so briefly rather than inventing a result.",
].join(" ");

/** Full assistant system prompt: the base plus the current device context. */
export function buildAssistantSystemPrompt(ctx: AssistantContext): string {
  return `${ASSISTANT_SYSTEM_PROMPT_BASE}\n\n${describeContext(ctx)}`;
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

/** System prompt for the dictation-refinement (voice continuation) flow. */
export const REFINE_SYSTEM_PROMPT =
  "You edit dictated text. The user dictated a message, then dictated a follow-up. " +
  "If the follow-up is additional content, append it to the message where it naturally fits. " +
  "If it describes an edit (a correction, a deletion, or content to insert somewhere specific), apply that edit instead of appending the instruction itself. " +
  "Fix only what the follow-up asks; keep the rest of the original wording. " +
  "Output only the final text of the message, with no preamble, quotes, or commentary.";

/** User message for the dictation-refinement flow. */
export function buildRefineUserMessage(original: string, followup: string): string {
  return `Original dictation:\n${original}\n\nFollow-up dictation:\n${followup}`;
}
