declare const com: any;

/**
 * Minimal streaming client for the Anthropic Messages API. There is no
 * official SDK for the NativeScript runtime, so this speaks raw HTTP/SSE via
 * FaceclawSseRequest (okhttp on the Java side), which delivers the response
 * body line by line on this isolate's thread.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Default model for voice continuations (and a sensible general default). */
export const DEFAULT_LLM_MODEL = "claude-sonnet-5";

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AnthropicStreamResult = {
  text: string;
  /** e.g. "end_turn", "max_tokens", "refusal"; null if the stream never said. */
  stopReason: string | null;
};

export type AnthropicStreamOptions = {
  apiKey: string;
  model?: string;
  system?: string;
  messages: AnthropicMessage[];
  maxTokens?: number;
  /** Thinking/latency tradeoff; voice flows want "low". Default: model default. */
  effort?: "low" | "medium" | "high";
  /** Called with each incremental text delta as it streams in. */
  onTextDelta?: (delta: string, textSoFar: string) => void;
  onDone: (result: AnthropicStreamResult) => void;
  /** Called at most once, instead of onDone, with a user-displayable message. */
  onError: (message: string) => void;
};

export type AnthropicStreamHandle = {
  cancel(): void;
};

export function streamAnthropicMessage(options: AnthropicStreamOptions): AnthropicStreamHandle {
  const apiKey = options.apiKey.trim();
  let request: any = null;
  let settled = false;
  let text = "";
  let stopReason: string | null = null;

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    options.onError(message);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    options.onDone({ text, stopReason });
  };

  if (!global.isAndroid) {
    // Deferred so the caller gets its handle back before the callback runs.
    setTimeout(() => fail("Anthropic API is only wired up on Android"), 0);
    return { cancel: () => {} };
  }
  if (!apiKey) {
    setTimeout(() => fail("No Anthropic API key set"), 0);
    return { cancel: () => {} };
  }

  const body: any = {
    model: options.model ?? DEFAULT_LLM_MODEL,
    max_tokens: options.maxTokens ?? 8192,
    stream: true,
    messages: options.messages,
  };
  if (options.system) body.system = options.system;
  if (options.effort) body.output_config = { effort: options.effort };

  const listener = new com.faceclaw.app.FaceclawSseListener({
    onLine: (line: string) => {
      if (settled) return;
      const event = parseSseDataLine(String(line));
      if (!event) return;
      switch (event.type) {
        case "content_block_delta":
          if (event.delta?.type === "text_delta") {
            const delta = String(event.delta.text ?? "");
            text += delta;
            options.onTextDelta?.(delta, text);
          }
          return;
        case "message_delta":
          if (event.delta?.stop_reason) {
            stopReason = String(event.delta.stop_reason);
          }
          return;
        case "message_stop":
          done();
          return;
        case "error":
          fail(`Anthropic: ${String(event.error?.message ?? event.error?.type ?? "stream error")}`);
          return;
        default:
          // message_start, content_block_start/stop, ping — nothing to do.
          return;
      }
    },
    onHttpError: (code: number, errorBody: string) => {
      fail(describeHttpError(Number(code), String(errorBody)));
    },
    onComplete: () => {
      // Normally message_stop settles first; a clean EOF without it still
      // resolves with whatever streamed.
      done();
    },
    onFailure: (message: string) => {
      fail(`Anthropic connection failed: ${String(message)}`);
    },
  });

  const headers = Array.create("java.lang.String", 4) as string[];
  headers[0] = "x-api-key";
  headers[1] = apiKey;
  headers[2] = "anthropic-version";
  headers[3] = ANTHROPIC_VERSION;
  try {
    request = new com.faceclaw.app.FaceclawSseRequest(ANTHROPIC_URL, JSON.stringify(body), headers, listener);
  } catch (error) {
    setTimeout(() => fail(`Anthropic request failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => {} };
  }

  return {
    cancel: () => {
      settled = true;
      try {
        request?.cancel();
      } catch {
        // ignore
      }
    },
  };
}

/** Parse one SSE line; returns the JSON payload of a data: line, else null. */
function parseSseDataLine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function describeHttpError(code: number, body: string): string {
  let detail = "";
  try {
    detail = String(JSON.parse(body)?.error?.message ?? "");
  } catch {
    // non-JSON error body; fall through to the generic text
  }
  switch (code) {
    case 401:
      return "Anthropic: invalid API key";
    case 403:
      return "Anthropic: API key lacks permission";
    case 429:
      return "Anthropic: rate limited, try again shortly";
    case 500:
    case 529:
      return "Anthropic: service overloaded, try again shortly";
    default:
      return `Anthropic: HTTP ${code}${detail ? ` (${detail})` : ""}`;
  }
}

const REFINE_SYSTEM_PROMPT =
  "You edit dictated text. The user dictated a message, then dictated a follow-up. " +
  "If the follow-up is additional content, append it to the message where it naturally fits. " +
  "If it describes an edit (a correction, a deletion, or content to insert somewhere specific), apply that edit instead of appending the instruction itself. " +
  "Fix only what the follow-up asks; keep the rest of the original wording. " +
  "Output only the final text of the message, with no preamble, quotes, or commentary.";

export type RefineDictationOptions = {
  apiKey: string;
  original: string;
  followup: string;
  onTextDelta?: (delta: string, textSoFar: string) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
};

/**
 * Voice continuation: combine an original dictation with a follow-up
 * (appended content or a spoken edit instruction) into one edited text.
 */
export function refineDictation(options: RefineDictationOptions): AnthropicStreamHandle {
  return streamAnthropicMessage({
    apiKey: options.apiKey,
    model: DEFAULT_LLM_MODEL,
    system: REFINE_SYSTEM_PROMPT,
    effort: "low",
    messages: [
      {
        role: "user",
        content: `Original dictation:\n${options.original}\n\nFollow-up dictation:\n${options.followup}`,
      },
    ],
    onTextDelta: options.onTextDelta,
    onDone: (result) => {
      if (result.stopReason === "refusal") {
        options.onError("Anthropic: the model declined this request");
        return;
      }
      const text = result.text.trim();
      if (!text) {
        options.onError("Anthropic: empty response");
        return;
      }
      options.onDone(text);
    },
    onError: options.onError,
  });
}
