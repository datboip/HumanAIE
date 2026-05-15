# Touch Gestures — Design

**Status:** Draft for review
**Date:** 2026-05-15
**Target version:** HumanAIE 1.2.0 (handroid branch)

## Summary

Wire up real phone interaction from the Cam UI's viewport. Today the HANDROID mode renders the phone stream but clicks and drags still POST to `/live/click` and `/live/scroll` (browser-mode endpoints), so the phone receives nothing. This spec routes viewport input to `/android/tap` and `/android/swipe` when in android mode, modernizes the viewport's input handlers from mouse events to pointer events (one set of handlers covering mouse / pen / touchscreen), adds phone-sleep awareness with a wake-banner, fixes a stale `v1.0.1`/`v1.0.0` flash in the version label, and validates the existing Touch-tab popup buttons against a real phone.

## Motivation

After the Handroid integration in `1dd5dbb...41afce1`, the phone stream renders correctly and the Touch-tab canned-action buttons fire the right endpoints, but the popup hint *"Click = Tap. Drag = Swipe."* is unfulfilled — clicking the viewport in HANDROID mode still drives the *browser*. The failure is silent (the request succeeds against a no-op endpoint), making the feature feel broken without a console error to follow. Users also see the phone go to sleep without any UI feedback (just a black viewport), which is indistinguishable from server failure (we hit this during the `2026-05-15` dev session — investigated as a server bug before realizing the phone was simply asleep).

While we're inside the viewport input handlers, switching from mouse events to pointer events removes a small amount of accumulated complexity (today's drag handler reaches for `document` to compensate for cursors leaving the viewport — `setPointerCapture` is the right primitive) and makes touch-driven HumanAIE possible without per-platform shims.

## Architecture

Three layers, one responsibility each.

```
┌─────────────────────────────────────────────────────────────┐
│ BROWSER  public/cam/index.html                  ← INPUT     │
│  ─ Pointer-event handlers on $viewport (one set)            │
│  ─ Mode routing: androidMode + interactionMode              │
│  ─ Coord mapping: CSS px → phone px via img.naturalWidth    │
│  ─ Sleep-banner overlay                                     │
│  ─ Static v1.0.x → v1.2.0 in markup                         │
└─────────────────────────────────────────────────────────────┘
                          │  HTTP POST
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ SERVER  android.js                              ← STATE     │
│  ─ /android/tap, /android/swipe, /android/key  (existing)   │
│  ─ /android/status  + screen_on field          (new)        │
│  ─ parseWakefulness()  (pure, unit-tested)     (new)        │
└─────────────────────────────────────────────────────────────┘
                          │  adb shell
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PHONE                                                       │
│  ─ Receives input via `adb shell input tap/swipe/keyevent`  │
│  ─ Wakefulness via `adb shell dumpsys power`                │
└─────────────────────────────────────────────────────────────┘
```

**Key decisions:**

1. **One viewport, two modes.** The `<img id="viewport">` element is shared between browser and android modes. Handlers branch internally on `androidMode`. Splitting into two viewports would duplicate the cursor overlay, click ripple, highlight-dot, and CSS mode machinery — too much for the gain.
2. **Pointer events replace mouse events.** Today's `click` + `mousedown` + document-level `mousemove`/`mouseup` become `pointerdown` + `pointermove` + `pointerup` + `pointercancel` with `setPointerCapture`. Net diff over a minimal A-grade fix is roughly +20 LOC; net diff vs the *existing* tangle is roughly neutral.
3. **No new endpoints.** `/android/tap`, `/android/swipe`, `/android/key` already exist and are correct. Only `/android/status` gains one field.
4. **Sleep detection is poll-derived UI state.** The UI already polls `/android/status` via `refreshAndroidStatus`. The sleep banner is a new consumer of that data — no new polling, no WebSocket.
5. **Coordinate space conversion derives from the rendered image.** The `<img>` element's `naturalWidth`/`naturalHeight` reflect the most recent MJPEG frame, which is the phone's *current* resolution and orientation. No `/android/info` extension needed, no cached state, rotation handled automatically.

### What this design explicitly does NOT touch

- Highlight mode behavior (clicking with highlight active still records a highlight; in android mode it's already tagged `target: 'android'`)
- The Keyboard tab popup
- Recording / video / takeover features
- Any browser-mode endpoint (`/live/click`, `/live/scroll`)

## Components

### Server side

**1. `android.js` — `parseWakefulness(dumpsysOutput)` pure helper** *(new)*

- **Signature:** `(string) → boolean`
- **Behavior:** match `/mWakefulness=(\w+)/`; return `true` for `Awake` or `Dreaming`, `false` for `Asleep`, `Dozing`, no match, or any unrecognized value
- **Why pure:** lets us unit-test all branches without an ADB dependency

**2. `android.js` — `/android/status` augmentation** *(modify existing handler at line 225)*

- **Add:** `screen_on: boolean` field to JSON response
- **How:** when `phone_connected === true`, run `adb shell dumpsys power | grep mWakefulness`, feed result to `parseWakefulness`. Default `false` if the call throws or the phone isn't connected.
- **Doesn't change:** any other field, any other endpoint, any error path

### Browser side, `public/cam/index.html`

**3. Pointer-event handler unit** *(replaces existing handlers at lines 1672, 2211–2252)*

- One unit listening on `$viewport` for `pointerdown` / `pointermove` / `pointerup` / `pointercancel`
- Internal state: `{ active: bool, dragged: bool, startX, startY, startTime, startNaturalW, startNaturalH }`
- **State machine:**
  - `pointerdown`: if `!e.isPrimary` ignore; else capture pointer, set `active=true`, stash start coords and `naturalWidth`/`naturalHeight`
  - `pointermove`: if `active && !dragged && distance > 5px` → set `dragged=true`, cursor → `grabbing`
  - `pointerup`: dispatch by mode (see Data flow); reset state
  - `pointercancel`: reset state silently — do **not** dispatch
- **Dispatch table on `pointerup`** (single rule: drag-actions require `interactionMode === 'drag'`; everything else is a tap. Matches today's browser-mode behavior — drag in click-mode is treated as a tap-at-release, not a scroll):

  | androidMode | interactionMode | dragged | Action |
  |---|---|---|---|
  | * | `highlight` | * | Record highlight (existing behavior) |
  | true | `click` | * | POST `/android/tap` (drag-in-click-mode ignored, taps at release coord) |
  | false | `click` | * | POST `/live/click` (existing — drag-in-click-mode ignored) |
  | true | `drag` | false | POST `/android/tap` (no movement = tap) |
  | true | `drag` | true | POST `/android/swipe` |
  | false | `drag` | false | POST `/live/click` (existing) |
  | false | `drag` | true | POST `/live/scroll` (existing) |

- **Rotation guard on `pointerup`:** if `$viewport.naturalWidth !== startNaturalW` or `naturalHeight !== startNaturalH`, abort the swipe (treat as cancel). Mid-drag rotation is rare; dropping the swipe is safer than sending bad coords.
- **Side effects preserved:** still calls `recordAction(...)` and `showClickEffect('human', ...)` so recording and ripples work in both modes

**4. `screenToPhone(e)` helper** *(new)*

- **Signature:** `(pointerEvent) → { x: int, y: int } | null`
- **Math:**
  ```
  const rect = $viewport.getBoundingClientRect();
  if (!$viewport.naturalWidth || !$viewport.naturalHeight) return null;
  return {
    x: clamp(round((e.clientX - rect.left) / rect.width  * $viewport.naturalWidth),  0, $viewport.naturalWidth  - 1),
    y: clamp(round((e.clientY - rect.top ) / rect.height * $viewport.naturalHeight), 0, $viewport.naturalHeight - 1),
  };
  ```
- **Returns `null`** if stream hasn't loaded (`naturalWidth === 0`) → caller no-ops

**5. Sleep banner overlay** *(new DOM + JS + CSS)*

- **DOM:** new `<div id="phone-sleep-banner">💤 Phone is asleep — tap to wake</div>` inside `#viewport-wrapper`, hidden by default
- **CSS:** absolutely positioned, centered, sits above the `<img>`. Semi-transparent dark backdrop, green accent text matching the Handroid palette. Hidden via missing `.shown` class.
- **JS:** inside `refreshAndroidStatus` callback, toggle `.shown` based on `androidStatus.screen_on === false && androidStatus.phone_connected === true`. (Don't show banner when phone is just disconnected — that's the existing NO-PHONE splash's job.)
- **Click handler:** POST `/android/key { keycode: 'KEYCODE_WAKEUP' }`, immediately call `refreshAndroidStatus()` to clear the banner on next poll

**6. Version-string cleanup** *(text replacements only)*

- `index.html:807`  `<div class="version ver-tag">v1.0.0</div>` → `v1.2.0`
- `index.html:1052` `<span class="ver-tag">v1.0.1</span>` → `v1.2.0`
- The existing JS at line 2530 still overwrites both from `/version`; this change makes the *static fallback* truthful so users see correct text even before the API call resolves

**7. Touch-popup button validation** *(verification, no code change)*

- Existing `phoneKey` / `phoneSwipe` / `phoneScreenshot` already POST to the correct endpoints
- End-to-end test each against the real phone on `.90`; document any not firing correctly so they can be fixed in-scope

### Unit boundaries

| Unit | Knows about | Doesn't know about |
|---|---|---|
| Pointer handler | mode flags, coord helper, endpoints | dumpsys, wakefulness parsing |
| `screenToPhone` | viewport rect & natural dims | event types, mode flags |
| Sleep banner | `/android/status` poll, KEYCODE_WAKEUP | viewport input, coord mapping |
| `parseWakefulness` | dumpsys output strings | UI, banner, anything front-end |

## Data flow

### A. Tap on the phone (NEW)

```
pointerdown (primary)
  → setPointerCapture; record start coords + startNaturalW/H
pointermove
  → distance < 5px → stay in 'tap' state
pointerup
  → androidMode + click-mode + !highlight
    coords = screenToPhone(event)
    POST /android/tap { x: coords.x, y: coords.y }
    showClickEffect('human', ...)
    recordAction('tap', { x, y })
    server: adb shell input tap X Y
```

### B. Drag on the phone = swipe (NEW)

```
pointerdown (primary)
  → capture, stash startX/Y, startTime, startNaturalW/H
pointermove
  → distance crosses 5px → dragged = true; cursor → 'grabbing'
pointerup
  → rotation guard: if naturalW/H changed → reset state, abort
  → androidMode + interactionMode === 'drag' + dragged
    start = screenToPhone(start)
    end   = screenToPhone(release)
    dur   = clamp(release.timeStamp - startTime, 100, 1000)   // ms; natural feel
    POST /android/swipe { x1, y1, x2, y2, dur }
    recordAction('swipe', { ... })
    server: adb shell input swipe X1 Y1 X2 Y2 DUR
```

### C. Tap / drag in browser mode (UNCHANGED externally)

```
same pointer flow, androidMode === false
  tap  → POST /live/click  { x, y }                  // existing endpoint
  drag → POST /live/scroll { direction, amount }     // existing endpoint
```

### D. Sleep / wake awareness (NEW)

```
poll loop (~every 2s, existing):
  GET /android/status
    server: adb shell dumpsys power | grep mWakefulness → parseWakefulness
    returns { ..., screen_on: bool }
  if (screen_on === false && phone_connected === true):
    #phone-sleep-banner.classList.add('shown')
  else:
    .remove('shown')

user clicks banner:
  POST /android/key { keycode: 'KEYCODE_WAKEUP' }
  refreshAndroidStatus()    // immediate re-poll clears banner
```

### E. Existing Touch popup buttons (UNCHANGED, verified)

```
phoneKey('KEYCODE_POWER')    → POST /android/key
phoneSwipe('up'|'down'|...)  → POST /android/swipe   (canned 1080×1920 coords)
phoneScreenshot()            → GET  /android/screenshot
```

## Error handling

Failure modes and chosen behavior, ordered by likelihood.

| # | Failure | Behavior | Surface to user |
|---|---|---|---|
| 1 | Stream not loaded yet (`naturalWidth === 0`) | `screenToPhone` returns null; handler no-ops | None (splash already covers viewport) |
| 2 | POST `/android/tap`/`swipe` fails (network, server) | `.catch(e => console.warn(...))` matching existing pattern at line 1510 | None in v1 |
| 3 | `/android/tap` returns 503 ADB-not-configured | Same as #2 | None (NO-ADB splash already shown) |
| 4 | `dumpsys` parse fails | Server returns `screen_on: false` (conservative) | False-positive banner; clicking it harmlessly fires WAKEUP. Acceptable. |
| 5 | `/android/status` poll fails | Existing poll already swallows failures and retries | Banner stays in last-known state |
| 6 | Phone disconnects mid-drag | `pointerup` fires normally; POST fails per #2 | Next status poll picks up `phone_connected: false`, existing NO-PHONE splash returns |
| 7 | Non-primary pointer (multi-touch) | `pointerdown` checks `e.isPrimary`; ignored otherwise | None (prevents second finger interfering) |
| 8 | `pointercancel` (OS steals pointer) | Reset state, do **not** dispatch | None (better to drop than send half-swipe) |
| 9 | Phone rotates mid-drag | Compare `naturalW/H` at `pointerup` vs `pointerdown`; if different, abort | None (mid-drag rotation is rare) |

### What we explicitly DON'T add

- Retry logic on tap/swipe failures (user will click again — premature)
- Toast / notification system (new dependency; v1 silent-with-console.warn matches existing style)
- Coord-bounds validation (server's `adb input` already clamps via Android semantics)

## Testing

### Layer 1 — Server unit tests *(automated, `tests/android.test.js`)*

Cover `parseWakefulness` across the dumpsys value space:

| Input fragment | Expected `screen_on` |
|---|---|
| `mWakefulness=Awake` | `true` |
| `mWakefulness=Dreaming` | `true` |
| `mWakefulness=Asleep` | `false` |
| `mWakefulness=Dozing` | `false` |
| `mWakefulness=Some_Vendor_State` | `false` |
| empty / no match | `false` |

Plus regression smoke: `/android/status` without ADB returns `{ adb_available: false, screen_on: false }` and HTTP 200.

### Layer 2 — Browser pure-function checks *(automated via `chrome-devtools-mcp evaluate_script`)*

`screenToPhone` is pure arithmetic — verifiable headless:

```
$viewport.naturalWidth=1080, naturalHeight=2400, rect 500×1000:
  offset (0, 0)        → (0, 0)
  offset (500, 1000)   → (1079, 2399)            // clamp at edge
  offset (250, 500)    → (540, 1200)             // center
  naturalWidth === 0   → null
```

### Layer 3 — End-to-end on .90 *(manual, requires real phone)*

**Tap & drag:**
- [ ] Click clear UI element on phone → that element activates
- [ ] Click in different screen regions → tap lands at correct spot (no offset)
- [ ] Drag slowly upward → phone scrolls slowly upward
- [ ] Flick quickly upward → phone scrolls quickly (natural duration delta visible)
- [ ] Drag pointer outside viewport and back → swipe completes (pointer-capture works)

**Sleep awareness:**
- [ ] Let phone sleep naturally → "💤 Phone asleep — tap to wake" banner appears within ~2s
- [ ] Click banner → phone wakes, banner clears within ~2s
- [ ] Press hardware power button → banner appears

**Touch popup buttons (Component 7 verification):**
- [ ] 🔒 Power → screen toggles
- [ ] 🔆 Wake → wakes if asleep
- [ ] Vol+ / Vol− → volume changes
- [ ] 📸 Screenshot → screenshot saved
- [ ] ▲ ◀ ▼ ▶ canned swipes → phone scrolls correct direction
- [ ] ⬆ Home → home screen
- [ ] ⬇ Notif → notification shade pulls down

**Regression — browser mode unchanged:**
- [ ] Exit HANDROID → viewport click drives browser (existing)
- [ ] Browser drag scrolls page (existing)
- [ ] Highlight mode still records (existing)

### Out of scope for testing

- Multi-touch (not supported)
- Mid-drag rotation (documented as silent drop, not asserted)
- Network failure paths (covered by code review, not tests)

## Acceptance criteria

Feature is done when:

1. All Layer 1 unit tests pass under `npm test`
2. All Layer 2 evaluate_script checks pass against a running local server
3. User runs the Layer 3 checklist on .90 and reports green

## Out of scope

- Multi-touch / pinch zoom (ADB `input` doesn't natively support it; would require `sendevent` plumbing — separate spec)
- Long-press as a distinct gesture (a slow press today fires as a swipe with tiny distance — acceptable for v1)
- Trackpad-style remote gestures (alternative to viewport-mounted input — not requested)
- `/android/info` returning resolution (no longer needed; `naturalWidth/Height` is used instead)
- Version-bump to `1.2.1` (we're still pre-release on `handroid-v1.2.0`; bump happens when v1.2.0 is tagged and we cut a patch branch)

## File touch list

| File | Change |
|---|---|
| `android.js` | Add `parseWakefulness`, extend `/android/status` |
| `public/cam/index.html` | Replace mouse handlers with pointer handlers; add `screenToPhone`; add sleep-banner DOM + JS + CSS; fix two hardcoded v1.0.x strings |
| `tests/android.test.js` | Add `parseWakefulness` unit tests + status regression smoke |

No new npm dependencies, no new endpoints, no schema changes.
