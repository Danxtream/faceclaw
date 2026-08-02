# Voice Assistant Architecture

Status: design draft, 2026-07-19; revised 2026-07-24 (tool availability
ontology, misc fixes); revised 2026-08-01 (external bridge landed).
**Phases 1 and 2 are implemented**, and **phase 3 + the OpenClaw part of
phase 4 landed 2026-08-01** with one architecture change: the bridge server
is not a standalone package — it *is* the OpenClaw plugin
(`~/repositories/faceclaw-agent-bridge`, installed on the OpenClaw host).
The plugin hosts the websocket endpoint the phone dials into, runs
utterances as embedded OpenClaw agent turns (`runEmbeddedAgent` with a
dedicated session, default key `faceclaw:glasses`), and exposes the
glasses' MCP-served tools to the agent via two fixed meta-tools
(`glasses_list_tools` / `glasses_call` — fixed names because OpenClaw's
manifest `contracts.tools` wants static declarations, while the glasses
toolset is dynamic). The generic "MCP face for any agent" from the original
design is unbuilt; the wire protocol is unchanged, so a standalone bridge
for other agents can be added later without phone changes.

## Goal

A default voice assistant reachable from anywhere in the shell: hold the
button, speak, and the utterance goes to an agent that can answer in text on
the lenses and act on the glasses through tools. The agent is pluggable:

- **Direct mode**: the phone runs the agent loop itself against the Anthropic
  Messages API (tool-use loop, conversation state on-phone).
- **External mode**: the utterance is routed to the user's own long-running
  agent (OpenClaw, Hermes, or anything similar running on their machine), and
  that agent gets access to the glasses' tools while it works.

Tools come from two sources, with four availability tiers (see "Tool
availability ontology" below):

- **Glasses/system tools**: provided by the shell, always available (show
  text, notifications, screen state, open app, ...).
- **App tools**: contributed by apps. Each app tool declares how much of the
  app needs to exist for the tool to be live: merely **installed** ("start a
  5 minute timer" must not require the Timer app to be open), **open**
  ("next track" needs a running Music window, foreground or not), or
  **foreground** ("scroll down" only makes sense aimed at the foreground app).

## What we already have

- **PTT capture UI**: `VoiceInputLayer` (app/ui/apps/voice-input.ts) handles
  push-to-talk, live transcripts, and a Send/Continue/Discard menu; `Shell`
  opens it on long-press and delivers Send to the foreground window's
  `receiveTextInput` (app/ui/shell/shell.ts).
- **Wakeword**: On-device classifier listens for the wakeword "Hey Even",
  which sends a message to the phone which wakes the screen and starts voice
  input.
- **STT**: `voiceControlBridge` with onboard Moonshine, Whisper, or ElevenLabs
  cloud.
- **LLM client**: `streamAnthropicMessage` (app/native/anthropic.ts) — raw
  SSE streaming over `FaceclawSseRequest`. Text-only today; no tool use.
- **Worker app protocol**: `WorkerAppMessage`/`WorkerAppReply`
  (app/ui/shell/worker-window.ts) — small-JSON postMessage protocol between
  shell and app workers; the natural place to add tool declarations.
- **Dial-out websocket precedent**: `G2MirrorClient` — JSON over a websocket
  to a server on the user's machine (tailscale host/port/token settings).
  The external-agent bridge should copy this shape.

## Architecture overview

```
                        main isolate (shell)
  ┌───────────────────────────────────────────────────────────┐
  │  Shell ──(PTT)──> VoiceInputLayer ──> AssistantSession    │
  │                                            │              │
  │  AssistantLayer (overlay UI) <──streaming──┤              │
  │                                            │              │
  │                                   AssistantBackend        │
  │                                   ┌────────┴─────────┐    │
  │                                   │ Direct  │ External│    │
  │                                   └────┬────┴────┬────┘    │
  │                                        │         │         │
  │  ToolRegistry <────────────────────────┴─────────┘         │
  │   ├─ system tools (in-process handlers)                    │
  │   ├─ app "installed" tools (shell-side or launch-on-call)  │
  │   └─ app "open"/"foreground" tools (proxied to app worker) │
  └──────────┬──────────────────────────────────────┬─────────┘
             │ postMessage                          │
       app worker (e.g. terminal)          Anthropic API (SSE)
       set-tools / tool-call /             or agent bridge (WS)
       tool-result                         on the user's machine
```

Everything assistant-side lives on the main isolate. Rationale: tool handlers
need shell state (window list, focus, notifications, settings), the agent
loop is I/O-bound not CPU-bound, and the overlay UI is a shell layer anyway.
If conversation rendering ever gets expensive it can move to a worker later
without changing the tool protocol, which is already async message passing.

### Core pieces

1. **`ToolRegistry`** (new, `app/assistant/tool-registry.ts`)
   - Holds `ToolSpec`s and handlers; answers `listTools(scopeFilter)` and
     `callTool(name, args) -> Promise<ToolResult>`.
   - Emits `onToolsChanged` (needed for MCP `tools/list_changed` in external
     mode, and consulted at each turn boundary in direct mode).

2. **`AssistantBackend`** (interface) with two implementations:
   - `DirectAnthropicBackend`: tool-use loop over the Messages API.
   - `ExternalAgentBackend`: websocket bridge to the user's agent.

3. **`AssistantSession`**: one conversation. Owns history/turn state,
   exposes `sendUtterance(text, ctx)`, `cancel()`, and streaming callbacks
   (`onTextDelta`, `onToolActivity`, `onTurnDone`, `onError`). Both backends
   implement the same session surface so the UI is backend-agnostic.

4. **`AssistantLayer`**: shell overlay showing streamed reply text, a status
   line for tool activity ("→ calendar.list_events"), and a small menu
   (Follow-up / Done). Double-click cancels the in-flight turn.

## Entry points and routing

- **Wakeword** Saying "Hey Even" wakes the screen if necessary and opens the
  dictation dialog. For one-off voice commands, this will be the main entry
  point.
- **Context menu** The sidebar context menu and app context menu already have
  a "Voice input" option, which opens the dictation dialog whose Send goes to
  the foreground window. We'll split the Send option in this dialog into two
  options, "Send to Assistant" and "Type Into App". If the entry point was via
  context menu, "Type Into App" is highlighted by default; if the entry point
  was the wakeword, "Send to Assistant" is highlighted by default instead.
  (The capture UI is the existing `VoiceInputLayer` flow, with Send handing off
  to `AssistantSession` and morphing into `AssistantLayer`).

## Tool model

```ts
type ToolAvailability =
  | "always"      // system tools; no app involved
  | "installed"   // app tool, live whenever the app is installed —
                  //   the app need not have any window open
  | "open"        // app tool, live while the app has a window open,
                  //   foreground or backgrounded
  | "foreground"; // app tool, live only while the app owns the
                  //   foreground window

type ToolSpec = {
  name: string;              // namespaced: "glasses.show_notification",
                             // "app.terminal.send_input"
  description: string;
  inputSchema: object;       // JSON Schema
  availability: ToolAvailability;
  /** May be invoked by the external agent outside an active voice turn. */
  proactive?: boolean;
  timeoutMs?: number;        // default 10s; registry enforces
};

type ToolResult =
  | { ok: true; content: string }           // text payload back to the model
  | { ok: false; error: string };
```

### Tool availability ontology

Every tool sits in exactly one tier, and the tier answers two questions: *when
does the tool appear in `listTools()`*, and *who handles the call*.

| Tier | Live when | Handler | Examples |
|---|---|---|---|
| `always` | always | shell, in-process | `glasses.get_state`, `notifications.list` |
| `installed` | app installed (launcher entry exists) | shell-side handler registered with the app entry, or launch-the-app-then-proxy | `timer.set` ("start a 5 minute timer" must work with no Timer window), `music.play` (cold-start playback) |
| `open` | app has ≥1 open window, foreground or not | app worker (or in-process window) via tool-call proxy | `music.next_track`, `terminal.send_input` |
| `foreground` | app owns the foreground window | app worker via tool-call proxy | `teleprompt.scroll_down`, anything meaning "act on what I'm looking at" |

Mechanics per tier:

- **`installed`** tools cannot be declared by the worker (it may not be
  running), so they are declared statically alongside the app's launcher
  registration. Two handler flavors: (a) a shell-side handler function
  registered with the entry — right for tools that don't actually need the
  app UI (timers, starting playback); (b) *launch-on-call*: the shell opens
  the app (as if launched from the launcher), waits for its `set-tools`
  declaration, then proxies the call. Start with (a) only; (b) adds a
  launch-latency/timeout dance that no phase-1/2 tool needs.
- **`open`** and **`foreground`** tools are declared by the running app via
  `set-tools` (worker apps) or direct registration (in-process windows).
  The registry filters `foreground` tools by whether the declaring app owns
  the current foreground window at list time and again at call time —
  a `foreground` tool called after a foreground swap fails with a normal tool
  error rather than acting on a window the user is no longer looking at.
- A tier is a *floor*, not a routing rule: an `installed` tool stays listed
  while the app is open or foreground. If an app wants different behavior when
  its window exists (e.g. `timer.set` also shows a countdown in the open
  Timer window), the shell-side handler checks for the window itself.

> **Flag:** with multiple windows per app (the worker protocol is
> per-window), tool names are namespaced per *app*, so two windows of one
> app declaring the same tool name would collide. Rule: `set-tools`
> replaces the app's toolset per window, and a call routes to the declaring
> window; if two windows declare the same name, last declaration wins and
> earlier ones are dropped with a logged warning. Revisit only if a real
> app needs per-window tools with the same name (none of the planned ones
> do).

### System tools (initial set)

| Tool | Notes |
|---|---|
| `glasses.show_alert` | short text popup on the lenses; proactive-capable |
| `glasses.list_windows` / `glasses.focus_window` / `glasses.open_app` | shell control |
| `glasses.get_state` | screen on/off, foreground app, battery levels, time |
| `glasses.read_screen` | text/description of the current foreground surface (start with window title + app-reported summary; pixel OCR is out of scope) |
| `calendar.list_events` | wraps FaceclawCalendarProvider |
| `media.play_pause` / `media.next` / `media.now_playing` | wraps FaceclawMediaController |
| `notifications.list` / `notifications.dismiss` | wraps notification listener |
| `timer.set` / `timer.cancel` | new, but trivial and high-value for an assistant |

Keep the first release to ~8–12 tools; every tool costs prompt tokens and
model attention in direct mode.

Note that `calendar.*`, `media.*`, and `timer.*` are conceptually
`installed`-tier app tools that happen to be implemented by in-process shell
code; listing them here just means the shell registers their handlers
directly. If any of them later becomes a real app, its tools move to the
app's launcher registration without the model-visible surface changing.

### App tools

Running apps declare `open`/`foreground` tools per window over the existing
worker protocol (`installed` tools are declared statically with the launcher
entry, per the ontology above):

```ts
// WorkerAppReply additions (worker -> shell)
| { type: "set-tools"; windowId: string; tools: ToolSpec[] }   // replaces the set
| { type: "tool-result"; callId: string; result: ToolResult }

// WorkerAppMessage additions (shell -> worker)
| { type: "tool-call"; callId: string; windowId: string; name: string; args: unknown }
```

Registry rules:

- Liveness follows the availability tier: `open` tools are removed when the
  app's last window closes, `foreground` tools additionally drop out of
  `listTools()` when the app loses the foreground. Either transition fires
  `onToolsChanged`; in-flight calls to a closed window resolve as errors,
  and calls to a `foreground` tool are re-checked at dispatch time.
- Names are auto-prefixed `app.<appId>.` by the registry so apps can't
  shadow system tools or each other.
- The shell enforces `timeoutMs` on the postMessage round-trip; a hung
  worker yields a tool error, not a hung turn (same philosophy as input
  handling — the shell must survive a stuck app).
- In-process shell apps (calendar, music, ...) register handlers directly
  with the registry; the worker protocol is just the remote flavor of the
  same registration.
- **Mid-turn availability changes** (foreground swap, window close): direct
  mode re-lists tools at each loop iteration (tool set is per-API-call
  anyway); external mode sends MCP `notifications/tools/list_changed`. A
  call to a tool that just vanished returns a normal tool error the model
  can react to.

First app to wire up: the terminal —
`app.terminal.send_input` (type into the attached session; `open`,
proactive: false — "rerun the build" should work while the terminal is
backgrounded), `app.terminal.read_screen` (current grid contents; `open`),
`app.terminal.list_sessions` (`open`). This immediately enables "tell the
terminal to rerun the build" style commands and doubles as the reference
implementation — deliberately all `open`-tier; the first `foreground` tool
should come from an app where focus genuinely matters (teleprompt scrolling).

## Direct mode: agent loop on the phone

Extend `app/native/anthropic.ts`:

1. **Streaming tool-use support**: handle `content_block_start` with
   `tool_use`, accumulate `input_json_delta`, surface complete tool_use
   blocks alongside text deltas. (Today the client only reads `text_delta`.)
2. **`runAgentTurn` loop** (new, `app/assistant/direct-backend.ts`):
   messages + `tools` from the registry → stream → if `stop_reason ==
   "tool_use"`, execute each call via the registry, append `tool_result`
   blocks, continue; until `end_turn`/`refusal` or a safety cap
   (max 8 loop iterations, max ~2 min per turn).
3. **Session state**: history kept in memory per `AssistantSession`,
   trimmed from the head past a token budget. Sessions idle-expire
   (~10 min) so a new PTT starts fresh; "Follow-up" continues the session.
4. **System prompt**: glasses context — output renders on a 576×288
   monochrome HUD, so answer in 1–3 short sentences, no markdown, no lists
   unless asked; prefer acting via tools over describing; current time,
   foreground app, and screen state are injected per turn.
5. Model `claude-sonnet-5`, `effort: "low"` (same latency posture as the
   dictation refiner). Model/effort become settings later if needed.

## External mode: bridge to the user's agent

### Topology

The phone **dials out** (g2mirror pattern — phones don't accept inbound
connections reliably; tailscale host + port + token settings) to a small
**bridge server** co-located with the user's agent. One websocket, JSON
frames, three multiplexed channels:

```
{ v: 1, chan: "ctl" | "chat" | "mcp", ... }

ctl:  hello {deviceName, token, capabilities}, hello-ack, ping/pong, error
chat: utterance {turnId, text, ctx}        (phone -> agent)
      text-delta {turnId, text}            (agent -> phone)
      tool-activity {turnId, label}        (agent -> phone, optional status)
      turn-done {turnId, stopReason} / turn-error {turnId, message}
      cancel {turnId}                      (phone -> agent)
mcp:  { msg: <raw MCP JSON-RPC frame> }    (bidirectional)
```

On the `mcp` channel the **phone is an MCP server** (MCP roles come from the
initialize handshake, not from who dialed). It serves `tools/list` from the
ToolRegistry, `tools/call` into it, and emits `tools/list_changed` on
foreground changes. This means the agent-side integration needs zero
Faceclaw-specific tool code — the glasses appear as a normal MCP server.

### Agent-side adapters

The bridge server is a small standalone package (`faceclaw-agent-bridge`,
sibling of g2mirror) with two faces:

1. **MCP face**: re-exposes the phone's MCP channel as a localhost
   streamable-HTTP MCP endpoint. The user registers
   `http://localhost:<port>/mcp` with their agent (OpenClaw, Hermes, Claude
   Code, anything MCP-capable) exactly like any other MCP server. When the
   phone is disconnected, `tools/list` returns empty rather than erroring.
2. **Chat face**: pluggable per-agent adapter that forwards `utterance`
   frames into the agent and streams replies back:
   - **OpenClaw**: a plugin that injects the utterance as an inbound message
     on a dedicated "glasses" channel/session and relays the streamed reply.
   - **Hermes**: equivalent module against its session API.
   - **Fallback adapter**: spawn a configured CLI (e.g. `claude -p --resume`)
     per turn — lowest-fidelity but makes the bridge useful with no plugin.

Utterance `ctx` carries `{foregroundApp, screenOn, localTime}` so the remote
agent has the same situational grounding the direct loop gets in its system
prompt.

### Proactive agent actions

Because the MCP channel is live whenever the bridge is connected, the
external agent can call glasses tools **outside a voice turn** — e.g. push a
notification to the lenses when a long job finishes. Gating:

- Only tools marked `proactive: true` are callable outside an active turn
  (registry-enforced; enforced on the phone, never trusted to the bridge).
  Availability tiers apply to proactive calls unchanged: a proactive
  `installed` tool (e.g. `timer.set`) works anytime, while a proactive call
  to an `open`/`foreground` tool whose app isn't in the right state gets the
  same tool error a mid-turn call would.
- Master setting `assistant.allowProactive` (default on — it's a marquee
  feature — but visible and easy to turn off).
- Proactive display actions are rate-limited (e.g. 6/min) and never turn
  the screen on unless the user enabled that specifically.

## Settings

New "Assistant" section in dashboard settings:

- `assistant.backend`: `anthropic` | `external` (default `anthropic` if an
  API key is set, else `external` if a bridge host is set).
- `assistant.bridgeHost` / `assistant.bridgePort` / `assistant.bridgeToken`
  (mirrors the terminal.* trio).
- `assistant.allowProactive`: boolean.
- `voice.skipConfirmationAfterWakeword`: Wakeword-triggered input sends to the
  assistant immediately at the end of an utterance, rather than waiting for a
  menu selection.
- Reuses existing `llm.anthropicApiKey` for direct mode.

## Security notes

- Bridge auth: bearer token in the `hello` frame, TLS optional because the
  expected transport is tailscale (same stance as g2mirror); document that
  plainly.
- The phone enforces all tool gating (proactive flags, rate limits,
  timeouts). The bridge and agent are treated as honest-but-fallible.
- Tool results may contain private data (calendar, notifications); external
  mode ships them to the user's own machine only — no third-party hop. In
  direct mode they go to the Anthropic API like any other request content.
- App tools execute inside the app's worker with the app's existing
  privileges; the registry adds no new capability beyond what the app could
  already do.

## Implementation plan

**Phase 1 — direct assistant, system tools only.** ✅ Landed 2026-07-24
(builds + typechecks; not yet hardware-tested).
ToolRegistry (`app/assistant/tool-registry.ts`) with the full availability-tier
model but only `always` tools wired; 8 system tools (`glasses.get_state`,
`glasses.show_alert`, `calendar.list_events`, `media.now_playing`/`play_pause`/
`next`, `notifications.list`/`dismiss`) in `app/assistant/system-tools.ts`;
tool-use streaming in `anthropic.ts` (content-block assembly, `tools` param);
`DirectAnthropicBackend` + `AssistantSession`; `AssistantLayer` overlay
(`app/ui/apps/assistant.ts`); `VoiceInputLayer` reworked to route via a
`sendTargets` list ("Send to Assistant" / "Type Into App") with entry-point
default highlight and wakeword skip-confirmation auto-send;
`shell.showAlert` popup; `assistant.skipConfirmationAfterWakeword` setting.
*Deliverable: speak wakeword, ask "what's on my calendar", get an answer
on-lens.*

**Phase 2 — app tools.** ✅ Landed 2026-07-25 (builds + typechecks; not yet
hardware-tested).
Worker protocol extended with `set-tools` / `tool-result` (WorkerAppReply) and
`tool-call` (WorkerAppMessage). `ToolRegistry.setAppTools`/`removeAppTools`
key tools by windowId, prefix names `app.<appId>.`, and gate `foreground`
tools on an `isForeground()` predicate (checked at list and dispatch time).
`WorkerAppHost` proxies calls to its worker (callId round-trip, 15s host
timeout backstop on top of the registry's per-tool timeout), registers a
window's tools on `set-tools`, and withdraws them + fails in-flight calls on
window close. Direct mode now re-lists tools each loop iteration.
Terminal is the reference: the hub window declares `send_input` /
`read_screen` / `list_sessions` (all `open`-tier); send_input/read_screen act
on the active view (foregrounded → last-active → sole view). *Deliverable:
"run the build again" typed into the terminal even while it's backgrounded.*

*Not yet done from the Phase 2 design:* `installed`-tier registration on
launcher entries (no `installed` app tool exists yet — timer stays deferred);
in-process-window tool registration (only worker apps wired); the per-window
same-name collision handling (the terminal sidesteps it by declaring all tools
on the single hub window).

**Phase 3 — external bridge.** ✅ Landed 2026-08-01 (see the status note at
the top for the architecture change: bridge server == OpenClaw plugin).
Phone side: `app/assistant/bridge-client.ts` (`assistantBridge` singleton —
dial-out FaceclawWebSocket, hello/token auth, auto-reconnect with 1s→60s
backoff, started at boot by the dashboard controller when configured),
`app/assistant/mcp-server.ts` (MCP over the `mcp` channel: initialize /
tools/list / tools/call from the ToolRegistry, list_changed on
onToolsChanged, proactive gating + 6/min rate limit enforced on-phone),
external mode in `AssistantSession` (`AssistantBackendConfig` union selects
direct vs external; external history lives on the agent's machine), settings
(`assistant.backend`, `assistant.bridgeHost/Port/Token`,
`assistant.allowProactive`) in a new Assistant settings section.
Server side: `~/repositories/faceclaw-agent-bridge` (own repo/package).
*Verified against the live OpenClaw on serac with a simulated phone
(`test/fake-phone.js`): auth, streamed turns, and both tool directions
work; a real model turn needs the OpenClaw instance to have provider auth.*

**Phase 4 — OpenClaw/Hermes adapters + proactive polish.** Partially landed
2026-08-01: the OpenClaw adapter is the plugin itself (no separate chat
adapter needed); proactive gating + rate limits and `tools/list_changed`
are done. Remaining: Hermes (or generic-agent) support — likely a
standalone bridge speaking the same wire protocol with an MCP face +
CLI chat adapter; session persistence questions across reconnects
(currently: OpenClaw session is persistent, phone session is UI-only).

**Hardware-test TODO (external mode):** end-to-end on the real phone +
glasses against serac — connect status, a streamed turn, cancel, follow-up,
proactive `glasses.show_alert` from another OpenClaw channel, and behavior
across phone network transitions (the reconnect backoff is untested on
device).

## Open questions (deferred, not blockers):

- Continuous conversation: after a turn ends, listen for a follow-up
  utterance without requiring the wakeword/PTT again? There are some UI
  design questions here; maybe multi-turn conversations take the form of an
  Assistant app.
- Launch-on-call for `installed`-tier tools that genuinely need the app UI
  (open the app, await `set-tools`, proxy the call) — deferred until a tool
  needs it.
- `glasses.read_screen` fidelity beyond app-reported summaries? We probably
  don't want to do OCR, but we might do something like extending the draw-text
  draw call with an on-by-default option that also appends the drawn text to
  a string that gets submitted along with the frame.
- Whether assistant conversations should be reviewable in the phone UI
  (transcript log) — probably yes, cheap once sessions are objects. The
  natural UI home for this would be inside an Assistant app window.

