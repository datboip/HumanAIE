# HiveDroid Integration — Design

**Status:** Draft for review
**Date:** 2026-05-13
**Target version:** HumanAIE 1.2.0

## Summary

Fold HiveDroid (Android-over-ADB control server, currently living at `~/Projects/.dormant/hiveclaw/nanoclaw/groups/telegram_main/android-ui/`) into HumanAIE as a second target alongside the headless Chromium browser. One process, two targets, one Cam UI. The phone gets the same Highlight-to-Teach spatial memory, the same `/waitfor-highlight` human handoff, and the same session recording — keyed by `(package, activity)` instead of `url`.

## Motivation

HumanAIE's differentiator is spatial memory for AI agents: tap a thing on screen, the AI learns where it is. Today this only works for browsers. Extending it to Android phones is a natural fit because:

- The control API surface is nearly identical (tap/type/screenshot/stream/waitfor)
- Phones are where most real human workflows live (banking, messaging, 2FA, food delivery)
- An AI that can drive *both* surfaces gets dramatically more capable
- Running two separate servers (ports 3333 and 3335) is awkward; unifying them is cleaner

The user's intended workflow is "one server for both, used independently" — typically you're driving browser OR phone in a given task, not both simultaneously.

## Architecture

Single Express process. Browser endpoints unchanged. Android endpoints added under `/android/*`. A new ADB module (`android.js`) is loaded conditionally:

```
HumanAIE server.js (port 3333)
├── existing browser routes (/click, /navigate, /cam, ...)     ← untouched
├── /android/* routes                                          ← new, conditional
│     └── android.js (ADB wrapper)                             ← loads only if ADB found
└── shared: /waitfor-highlight, /highlights, /sessions         ← extended for both targets
```

If ADB isn't installed, the server still boots and serves the browser side normally; `/android/*` routes respond `503 ADB not configured` with install instructions. This keeps the project's "one `npm start` and you're live" ethos.

### File layout

```
android.js                       ← new — ADB wrapper module
public/cam/                      ← modified — same page, target-aware
  index.html                     ← +green PHONE tab, +phone control bar, +splash
  cam.js                         ← +target-switch logic, +android splash state
server.js                        ← +~15 lines: conditional require + route mounting
README.md                        ← +/android/* docs, +env vars section
Dockerfile                       ← +ADB install (optional, behind a build arg)
package.json                     ← version bump only, no new deps
.claude-plugin/plugin.json       ← version bump
```

No new npm dependencies. ADB is a system binary.

## Backend changes

### `android.js`

A new module that exports an Express router. Ported from `~/Projects/.dormant/hiveclaw/nanoclaw/groups/telegram_main/android-ui/server.js` with the following adaptations:

1. **Export router, not server** — `module.exports = router` instead of `app.listen()`.
2. **Configurable phone connection** — `HUMANAIE_PHONE_IP` and `HUMANAIE_PHONE_PORT` env vars replace the hardcoded `100.73.182.67:5555`.
3. **ADB binary detection** — at module load, search in order: `PATH`, `/usr/lib/android-sdk/platform-tools/adb`, `/workspace/group/android-sdk/platform-tools/adb`. Export `ADB_AVAILABLE` constant.
4. **Reuse HumanAIE's `/waitfor-highlight`** — don't duplicate the `/waitfor` endpoint from HiveDroid. The Cam UI already has a notification chime + banner; the same one fires for either target.
5. **Lazy `execFile`** — every endpoint already shells out per-request, so there's no persistent ADB state to manage.

### Endpoints under `/android/*`

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/android/screenshot` | — | Current screen as PNG |
| GET | `/android/stream` | — | MJPEG multipart stream |
| GET | `/android/status` | — | `{ adb_available, phone_connected, package, activity, battery }` |
| GET | `/android/info` | — | Device model, OS version, IP, serial |
| GET | `/android/ui-dump` | — | `uiautomator` XML hierarchy |
| POST | `/android/tap` | `{x, y}` | Tap at coordinates |
| POST | `/android/swipe` | `{x1, y1, x2, y2, dur}` | Swipe gesture |
| POST | `/android/type` | `{text}` | Type text |
| POST | `/android/key` | `{keycode}` | `adb input keyevent` (HOME, BACK, ENTER, etc.) |
| POST | `/android/shell` | `{cmd}` | Arbitrary `adb shell` command |
| POST | `/android/launch` | `{pkg}` | Launch app by package name |
| POST | `/android/install` | `{apkPath}` | Install APK |
| POST | `/android/record` | `{seconds}` | `screenrecord`, returns MP4 path |
| POST | `/android/push` | `{local, remote}` | Push file to device |
| POST | `/android/pull` | `{remote, local}` | Pull file from device |

`/android/status` is the key new endpoint — the Cam UI polls it to decide whether to show the stream or the splash, and the AI calls it to know which app/screen it's on (needed for spatial memory queries).

### Highlight schema extension

Existing highlight record (unchanged shape, one new field):

```json
{
  "x": 250, "y": 480,
  "label": "Login button",
  "target": "browser",
  "url": "https://example.com/login",
  "timestamp": 1731512000
}
```

New Android highlight record:

```json
{
  "x": 540, "y": 1320,
  "label": "Send message",
  "target": "android",
  "package": "com.whatsapp",
  "activity": ".HomeActivity",
  "timestamp": 1731512000
}
```

**Backwards compatibility:** highlights without a `target` field are treated as `target: "browser"`. No migration script needed.

### `/highlight-history` extension

Query parameters extended to support either target:

- `GET /highlight-history?url=https://...` — browser highlights (existing)
- `GET /highlight-history?package=com.whatsapp` — all highlights for that app
- `GET /highlight-history?package=com.whatsapp&activity=.HomeActivity` — narrowed to a screen
- `GET /highlight-history?target=android` — all Android highlights
- `GET /highlight-history?target=browser` — all browser highlights (equivalent to existing behavior)
- `GET /highlight-history?label=foo` — works across both targets (existing)

The query handler infers target from which key fields are present.

### `/waitfor-highlight` (no changes)

The existing human-handoff machinery is target-agnostic — the AI posts a message, the human clicks somewhere on the active Cam UI, the coordinates come back. Works as-is once the UI is target-aware.

### Session recording

HiveDroid uses Android's built-in `screenrecord` (produces MP4 natively). HumanAIE uses frame-grab → ffmpeg. Both write MP4 into the existing `humanaie-sessions/` directory. The session manifest gains a `target: "browser" | "android"` field so the existing `/sessions` listing endpoint and Cam UI session manager can label/filter by target. No new directory structure.

## Frontend changes (Cam UI)

The existing `/cam/` page becomes target-aware. No second page, no separate Cam UI.

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ File  Edit  View  Go  Bookmarks  Options                │ ← menubar (unchanged)
├─────────────────────────────────────────────────────────┤
│ ⬅ ➡  🏠  ↻  📑   [https://example.com         ] [Go]    │ ← URL bar (browser mode only)
├──────────────┬──────────────┬───────────────┬───────────┤
│ 📄 Tab 1     │ 📄 Tab 2  X  │ 📄 Tab 3  X   │  📱 PHONE │ ← tab strip + pinned right tab
├──────────────┴──────────────┴───────────────┴───────────┤
│                                                         │
│                    [stream viewport]                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Green PHONE tab

- Pinned to the far right of the tab strip. Always present. Cannot be closed (no `×` button).
- Distinct green (`#00ff66` or close — matches the v1.1.0 AI cursor color) so it reads as "the AI-controlled device tab."
- Click → switches mode to Android. Click any browser tab → switches back to browser.
- In Android mode, browser tabs render at reduced opacity / disabled state.

### Mode switch (client-side)

When the user clicks the PHONE tab:

1. Cam UI swaps `<img src="/stream">` → `<img src="/android/stream">`
2. URL bar hides; Android control bar appears in its place:
   - `[◀ Back]` `[● Home]` `[▢ Recent]` Android nav buttons (→ `POST /android/key`)
   - `[App ▾]` dropdown with frequently-used apps (populated from highlight history — apps with the most highlights bubble up)
   - `[⟳ Reconnect]` if status flips to offline mid-session
3. Status poll: `GET /android/status` every 5s. If `phone_connected: false`, switch to splash state.
4. Highlight overlay, waitfor banner, notification chime — all continue working unchanged; they're target-agnostic.

When the user clicks a browser tab, the reverse: stream src restored to `/stream`, URL bar shown, Android control bar hidden.

### Splash state

Shown inside the viewport area when the PHONE tab is active **and** any of:
- ADB not installed
- `HUMANAIE_PHONE_IP` not set
- Phone unreachable at configured IP

Splash content (Netscape-themed):

```
                    ┌──────────────────┐
                    │   📱  NO PHONE   │
                    │                  │
                    │  Phone not       │
                    │  paired yet.     │
                    │                  │
                    │  Set:            │
                    │   HUMANAIE_      │
                    │   PHONE_IP       │
                    │                  │
                    │  [ RECONNECT ]   │
                    └──────────────────┘
```

The `RECONNECT` button re-runs `/android/status` and re-renders accordingly. If ADB is missing entirely, the splash shows install instructions instead of the IP hint.

## Error handling & graceful degradation

| Situation | Behavior |
|-----------|----------|
| ADB binary not found at startup | Server boots normally. `/android/*` routes return `503 { error: "ADB not configured", hint: "Install adb..." }`. PHONE tab in UI shows install-instructions splash. |
| ADB present, phone unreachable | `/android/*` returns `502 { error: "phone offline at <ip:port>" }`. UI shows reconnect splash. |
| ADB command timeout (e.g., phone froze) | Per-endpoint timeout (5s for short ops, 30s for `install`/`record`). Returns `504 { error: "adb timeout" }`. |
| Invalid coordinates / bad input | `400` with specific reason. |
| `screenrecord` interrupted | Best-effort: partial MP4 saved, return path with `{ truncated: true }`. |

The principle: **the browser side should never break because of an Android problem.** If anything Android-related fails, it fails in isolation.

## Testing plan

Manual (consistent with the project's existing approach — no test suite, README says "test locally"):

**With ADB + phone connected:**
1. `npm start` — server boots, console shows `Android: ADB found at <path>, phone at <ip>`
2. Visit `/cam/`, click PHONE tab → MJPEG stream loads
3. Click somewhere on the phone view → tap registers on the device
4. Type a label, drag a highlight → entry appears in `highlights.json` with `target: "android"` + current `package` + `activity`
5. `GET /highlight-history?package=com.whatsapp` → returns matching entries
6. `POST /waitfor-highlight` from a script → notification fires, click resolves
7. Click a browser tab → flips back to browser stream cleanly

**Without ADB:**
1. `npm start` — server boots, console shows `Android: ADB not found — /android/* will return 503`
2. Browser side fully functional (`/cam/`, `/click`, `/navigate`, etc.)
3. Click PHONE tab → splash with install instructions
4. `curl localhost:3333/android/screenshot` → `503`

**Cross-target isolation:**
1. Save a browser highlight at `(100, 200)` for `https://github.com`
2. Save an Android highlight at `(100, 200)` for `com.github.android / .MainActivity`
3. `GET /highlights` → returns both, correctly tagged
4. `GET /highlight-history?url=https://github.com` → returns only the browser one
5. `GET /highlight-history?package=com.github.android` → returns only the Android one

## Migration & backwards compatibility

- Existing `highlights.json` entries without `target` field → treated as `target: "browser"`. Read-time inference, no rewrite.
- All existing browser endpoints unchanged. Existing skills, commands, AI integrations continue working with zero modifications.
- `plugin.json` and `package.json` bump to `1.2.0`. Both manifests must stay in sync (per the lesson learned from `1.0.0`/`1.1.0` drift).

## Out of scope (future work)

- **ADB auto-install / phone pairing wizard** — for v1.2 we document env-var setup; first-run UX comes later.
- **iOS support** — entirely different control mechanism (WebDriverAgent). Separate spec.
- **Cross-target task orchestration** — "click this on the phone after this loads in the browser" — would require shared state machine; deferred until we see real demand.
- **App launcher grid UI** — beyond the dropdown, a Netscape-styled grid of installed apps with icons. Nice-to-have.
- **Per-app highlight scope rules** — e.g., always treat any highlight inside `com.whatsapp` as relative to "currently open chat" rather than activity. Complex inference; deferred.

## Open questions

1. Should the Android `record` endpoint write into the same `humanaie-sessions/` directory as browser recordings? Probably yes (single sessions list), but Cam UI's session manager needs minor changes to label them by target.
2. Should the PHONE tab show a connection indicator (green dot when connected, red when not) so users don't have to click it to discover the state? Probably yes, low-effort, defer to implementation.
3. ADB on Docker — the `Dockerfile` would need `apt-get install -y adb` and host networking for WiFi ADB to reach the phone. Worth adding now or later? Suggest **later** — most users will run `npm start` directly during development; Docker is for deployments where the phone setup is more involved anyway.
