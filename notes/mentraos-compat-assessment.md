# MentraOS app compatibility for Faceclaw — feasibility assessment (2026-07-23)

MentraOS: https://github.com/Mentra-Community/MentraOS (MIT), docs at https://docs.mentraglass.com.

## TL;DR

Technically feasible with moderate effort, but the timing is awkward: MentraOS is
**deprecating its entire current app API**. MentraOS 3.0 ships **Aug 3, 2026** and
cloud-SDK apps stop working on it (a "MentraOS Legacy" mode preserves them through
**October 2026**). The replacement — a **Miniapp SDK** where apps are phone-local JS
bundles running in a WebView — gets a public spec in **September 2026**, and that model
is a *much* better fit for Faceclaw than the cloud model. Recommendation: wait for the
miniapp spec and target that; only build a minimal cloud-protocol emulator if access to
the existing app corpus is wanted in the interim.

## MentraOS app model (current, "Cloud SDK" / TPA era)

- Apps are developer-hosted server processes (Node/Bun, `@mentra/sdk`). Chain:
  glasses → phone (BLE) → MentraOS Cloud (WS) → app server (WS).
- Start flow: cloud POSTs a `session_request` webhook `{sessionId, userId, websocketUrl}`
  to the app's registered URL; the app dials back to `websocketUrl` and sends
  `tpa_connection_init {packageName, sessionId, apiKey}`; cloud acks with settings +
  device capabilities. **The webhook carries the WS URL, so an unmodified `@mentra/sdk`
  app can be pointed at any server** — that is the compat hook.
- Protocol: JSON over WebSocket (binary frames for audio). 28 app→cloud + 28 cloud→app
  message types, defined in `cloud/packages/sdk/src/types/` (`message-types.ts`,
  `streams.ts`, `layouts.ts`, `webhooks.ts`, `capabilities.ts`). The TS types are the spec.
- Subscriptions: `subscription_update` with a full list of stream types, some
  parameterized (`transcription:en-US`, `touch_event:forward_swipe`). Events arrive in a
  `data_stream` envelope.
- Display: 7 layout types — `text_wall`, `double_text_wall`, `dashboard_card`,
  `reference_card`, `bitmap_view` (base64), `bitmap_animation`, `clear_view` — sent as
  `display_event {view: 'main'|'dashboard', layout, durationMs?, forceDisplay?}`.
  Cloud throttles displays to 1 per 300 ms. Dashboard = shared look-up surface.
- Streams: `transcription` (`{text, isFinal, ...}`), `translation`, `VAD`, `audio_chunk`
  (PCM), `button_press`, `touch_event`, `head_position` (up/down), `glasses_battery_update`,
  `phone_battery_update`, `location_update`, `phone_notification`(+dismissed),
  `calendar_event`, plus camera/RTMP/LED families irrelevant to G2.
- Other: ElevenLabs TTS (`audio.speak`), per-app settings (schema in dev console, 9
  setting types, live `settings_update`), webview UI with signed-token auth, cloud KV
  storage, app-to-app messaging.
- Hardware abstraction: `Capabilities` flags per device. **Even Realities G2 is a
  first-class device** (`capabilities/even-realities-g2.ts`): display 640×200 (their
  rendering canvas, not the 576×288 EvenHub raster), maxTextLines 5, bitmap-capable,
  capacitive swipe bar with TAP/DOUBLE_TAP/TRIPLE_TAP/PRESS_HOLD/SWIPE_UP/SWIPE_DOWN,
  IMU, mic, no camera/speaker/LED.
- Licensing: MIT throughout; cloud is self-hostable in principle (Bun + MongoDB + S3 +
  third-party STT/TTS keys) but heavy.

## Coming model (Miniapp SDK, MentraOS 3.0)

Miniapps are JS bundles (`index.html` + `miniapp.json`) running **on the phone** inside
the MentraOS host app's WebView ("Mentra Runtime"), packages `@mentra/miniapp` +
`@mentra/miniapp-cli`, sideloaded via QR. API is analogous but smaller:
`session.transcription`, `session.display.showTextWall`, `session.storage`. Example:
https://github.com/Mentra-Community/LiveCaptionsLocalSdkMiniapp. Public spec Sept 2026.

## Fit with Faceclaw

Faceclaw's worker-per-app architecture is unusually favorable: apps are already isolated
contexts speaking a small typed JSON vocabulary (`WorkerAppMessage`/`WorkerAppReply` in
`app/ui/shell/worker-window.ts`), with pixels out-of-band. The compat layer would be one
compiled-in "MentraOS host" app (a peer of `WorkerAppHost`) that presents each external
app as a `ShellWindow` and:

- **Rasterizes layouts** → trivial. All 7 layout types map onto `GrayImage` +
  `drawTextWrapped`/`bitBlt` into the 540×260 `APP_VIEWPORT`. Bitmaps need scaling from
  their 640×200/576×136 assumptions; monochrome already matches.
- **Maps input** → good. `DashboardInputEvent` (`click`/`double-click`/`long-press`/
  `scroll-up`/`scroll-down`) covers their G2 button-event list almost 1:1 (TRIPLE_TAP
  missing). Work item: input is currently routed only to the focused window; MentraOS
  wants multi-subscriber fan-out (background apps), so a broadcast layer is needed.
- **Transcription** → the load-bearing stream, and Faceclaw already has it:
  `voiceControlBridge.onTranscript` (`{text, isFinal}`, replace semantics — matches
  MentraOS's `TranscriptionData` model well). Onboard Moonshine is English-only;
  parameterized languages would fall back to ElevenLabs/Whisper cloud providers.
  Needs multi-consumer fan-out and a policy for when the mic is open (MentraOS keeps it
  effectively continuous; Faceclaw is PTT/wakeword-oriented — battery implications).
- **VAD** → sherpa endpointing exists. **audio_chunk** → PCM already surfaced on the
  ElevenLabs path (`onPcm`).
- **Battery / phone notifications / calendar** → data already flows in Faceclaw
  (top-bar battery, notification listener, calendar app); just needs re-emission as
  streams.
- **head_position** → gap. Faceclaw exposes raw IMU only (no gesture classification);
  the look-up dashboard gesture would need a small accelerometer classifier (cmd 19
  stream exists, see imu-accelerometer memory).
- **TTS / audio out** → G2 has no speaker; MentraOS plays through the phone. Faceclaw
  would need phone-side audio playback (new but simple Android work).
- **Settings** → MentraOS per-app settings map onto the shared `FaceclawSettings` store
  with a `mentra.<packageName>.*` prefix; the 9 setting types map onto
  `ConfigSetting` subclasses, mostly.
- **Not applicable on G2**: camera/photo/RTMP/LiveKit, LED, WiFi setup — can be
  rejected via capabilities, which the protocol explicitly supports.

## The hard parts

1. **Who plays "cloud"?** Cloud-SDK apps dial out to a WS URL given in a webhook, so
   Faceclaw must (a) run a WS **server** — none exists anywhere in the codebase today,
   all networking is outbound okhttp client (`FaceclawWebSocket`, g2mirror pattern) —
   reachable from wherever the app server runs (fine on LAN; NAT pain otherwise), and
   (b) send the session webhook itself (simple outbound HTTP POST). A phone-hosted
   mini-cloud with Java-WebSocket/NanoWSD listening on LAN is the sane MVP; self-hosting
   their actual cloud (Bun+Mongo+Docker) is overkill.
2. **Session lifecycle**: connection init/ack, `subscription_update` bookkeeping,
   `reconnect`/`reconnect_ack/rejected/deferred`, `app_stopped`, per-app permission
   gating. This is bookkeeping-heavy but not deep.
3. **Display arbitration**: foreground vs `background`+`forceDisplay` apps, `durationMs`
   auto-revert, the shared dashboard view. Faceclaw's shell has focus/foreground but no
   equivalent of background-app display preemption or a look-up dashboard.
4. **App discovery/registration UX**: no dev console; needs a simple "add app by URL +
   API key" settings flow (API key check can be a no-op or shared secret).

## Effort estimate

MVP covering the bulk of display-glasses apps (live captions, teleprompters, dashboards,
notification relays): ~10–15 message types + ~8 stream types + webhook sender + LAN WS
server + layout rasterizer + settings mapping. Roughly a few weeks of focused work, with
transcription-stream policy and the WS server being the riskiest pieces. Full-surface
emulation (webview auth, app messaging rooms, TTS, location tiers) is substantially more
and mostly not worth it.

## Recommendation

- **Don't invest in the cloud-TPA protocol as the long-term target** — the vendor is
  killing it within ~3 months of now, and the ecosystem's apps will migrate to miniapps.
- **Target the Miniapp SDK when its spec lands (Sept 2026).** It's strictly easier for
  Faceclaw: JS bundle in an Android WebView with an injected `session` bridge — no
  server, no webhooks, no reconnect protocol — and Faceclaw already has every underlying
  facility the bridge needs. The rasterizer/input/transcription plumbing built for it
  would be shared with any interim TPA emulator anyway.
- If interim access to existing cloud-SDK apps matters, build the minimal LAN emulator
  described above, scoped to text layouts + transcription + button streams, and treat it
  as disposable.
