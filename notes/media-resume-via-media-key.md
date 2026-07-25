# Music: "Resume" action via media-key dispatch

Follow-up to the MediaBrowserService browsing support. When no media session
is active, `AudioManager.dispatchMediaKeyEvent(KEYCODE_MEDIA_PLAY)` (down+up
pair) is routed by the system to the *last* media app's manifest-declared
`MEDIA_BUTTON` receiver, even if that app's process is dead — the same
mechanism a Bluetooth headset play button uses. Most players respond by
resuming the last queue.

Idea: add a "Resume last" row to the Music app's no-active-session screen
(next to the browse entry). ~5 lines in `FaceclawMediaController` plus one UI
row; no per-app negotiation needed. Caveat: it's fire-and-forget — no feedback
if nothing handles it, so the UI should just wait for a session to appear.
