# Touch Gestures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clicks and drags on the HumanAIE viewport actually drive the connected phone when in HANDROID mode, while modernizing the input layer to pointer events, adding phone-sleep awareness, and fixing two stale version labels.

**Architecture:** Three layers as in the spec — server gains a `screen_on` field on `/android/status` derived from `dumpsys power`; browser replaces mouse handlers with one set of pointer-event handlers that branch on `androidMode` + `interactionMode`; a new sleep banner DOM toggles from the existing status-poll callback. No new endpoints, no new dependencies.

**Tech Stack:** Node.js + Express (`android.js`, `server.js`), vanilla JS in `public/cam/index.html`, `node:test` for server unit tests, `chrome-devtools-mcp` evaluate_script for browser pure-function checks.

**Spec reference:** `docs/superpowers/specs/2026-05-15-touch-gestures-design.md`

---

## File Structure

| File | Role | Disposition |
|---|---|---|
| `android.js` | Server ADB wrapper. Owns `parseWakefulness` + `/android/status` `screen_on` field. | Modify |
| `tests/android.test.js` | Server tests, `node:test` style. Gains unit tests for `parseWakefulness` + a smoke test for `screen_on` on the no-ADB path. | Modify |
| `public/cam/index.html` | Cam UI. All input handlers + sleep banner + version strings live here. | Modify |

No new files. The spec deliberately avoids growing the file count — `index.html` is already where every cam-UI concern lives, and splitting it for this feature would set a precedent we don't want without a broader UI restructure.

---

## Task Order Rationale

1. Server first (pure function + endpoint extension) — small, testable, no UI dependency
2. Browser pure helper (`screenToPhone`) — also testable in isolation, used by later tasks
3. Pointer-event refactor (regression-only — no new behavior) — risky change isolated to one commit
4. Android-mode dispatch (additive on top of refactor) — new behavior layered on verified-clean refactor
5. Sleep banner DOM + CSS — purely cosmetic, can land independently
6. Sleep banner wiring (consumes Task 1's `screen_on` + Task 5's DOM)
7. Hardcoded version-string cleanup — trivial, separate commit
8. End-to-end manual verification on the user's real phone at `.90`

---

## Task 1: `parseWakefulness` pure helper (TDD)

**Files:**
- Modify: `android.js` (add export)
- Modify: `tests/android.test.js` (add tests at end of file)

- [ ] **Step 1: Write the failing test**

Append to `tests/android.test.js`:

```javascript
test('parseWakefulness returns true for Awake', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('  mWakefulness=Awake\n'), true);
});

test('parseWakefulness returns true for Dreaming', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('mWakefulness=Dreaming'), true);
});

test('parseWakefulness returns false for Asleep', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('mWakefulness=Asleep'), false);
});

test('parseWakefulness returns false for Dozing', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('mWakefulness=Dozing'), false);
});

test('parseWakefulness returns false for unknown vendor state', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('mWakefulness=Some_New_State'), false);
});

test('parseWakefulness returns false when no mWakefulness in output', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness('some unrelated dumpsys text'), false);
});

test('parseWakefulness returns false for empty string', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness(''), false);
});

test('parseWakefulness returns false for null/undefined', () => {
  const { parseWakefulness } = require('../android');
  assert.strictEqual(parseWakefulness(null), false);
  assert.strictEqual(parseWakefulness(undefined), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/android.test.js`
Expected: 8 new tests fail with `TypeError: parseWakefulness is not a function` (or similar — the export doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `android.js`, find the `module.exports` block at the bottom of the file. If there isn't one yet (current file exports via assignments — verify by reading the last 20 lines first), add this function near the top of the file (anywhere after the `'use strict';` line at line 1, before the `router` declaration is fine), and add `parseWakefulness` to the exports:

```javascript
function parseWakefulness(dumpsysOutput) {
  if (typeof dumpsysOutput !== 'string' || dumpsysOutput.length === 0) return false;
  const match = dumpsysOutput.match(/mWakefulness=(\w+)/);
  if (!match) return false;
  const value = match[1];
  return value === 'Awake' || value === 'Dreaming';
}
```

Then at wherever `module.exports` is set (check the file's bottom), add `parseWakefulness` to it. If exports use individual assignments like `module.exports.foo = foo`, add:

```javascript
module.exports.parseWakefulness = parseWakefulness;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/android.test.js`
Expected: all `parseWakefulness` tests pass. Existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add android.js tests/android.test.js
git commit -m "feat: parseWakefulness helper — pure dumpsys mWakefulness parser"
```

---

## Task 2: Extend `/android/status` with `screen_on`

**Files:**
- Modify: `android.js` — both the `if (!ADB_AVAILABLE)` branch (around line 43–47) and the `router.get('/status', ...)` handler at line 225
- Modify: `tests/android.test.js` — add a `screen_on` smoke test on the no-ADB path

- [ ] **Step 1: Write the failing smoke test**

Append to `tests/android.test.js`:

```javascript
test('GET /android/status returns screen_on:false when ADB is unavailable', async (t) => {
  const { ADB_AVAILABLE } = require('../android');
  if (ADB_AVAILABLE) { t.skip('ADB present, covered by manual testing on real phone'); return; }

  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13336' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().toLowerCase().includes('listening')) {
        clearTimeout(timer); resolve(true);
      }
    });
  });
  assert.ok(ready);

  const res = await fetch('http://127.0.0.1:13336/android/status');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.adb_available, false);
  assert.strictEqual(body.screen_on, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/android.test.js`
Expected: the new test fails because `body.screen_on` is `undefined`, not `false`.

- [ ] **Step 3: Modify the no-ADB branch in `android.js`**

Find the line in the `if (!ADB_AVAILABLE)` block (around line 45–47):

```javascript
router.get('/status', (req, res) => {
  res.json({ adb_available: false, phone_connected: false, phone_addr: '', battery: null, package: '', activity: '' });
});
```

Replace with:

```javascript
router.get('/status', (req, res) => {
  res.json({ adb_available: false, phone_connected: false, phone_addr: '', battery: null, package: '', activity: '', screen_on: false });
});
```

- [ ] **Step 4: Modify the ADB-available `/status` handler**

Find the handler at line 225:

```javascript
router.get('/status', async (req, res) => {
  let phone_connected = false;
  let batteryLevel = null;
  let foreground = { package: '', activity: '' };
  try {
    const devOut = (await adbAsync('devices')).toString();
    phone_connected = devOut.split('\n').slice(1).some(l => l.trim().endsWith('\tdevice'));
  } catch {}
  if (phone_connected) {
    try {
      const b = (await adbAsync('shell', 'dumpsys battery | grep level')).toString();
      const m = b.match(/level:\s*(\d+)/); if (m) batteryLevel = parseInt(m[1], 10);
    } catch {}
    foreground = await detectForeground();
  }
  res.json({
    adb_available: true,
    phone_connected,
    phone_addr: PHONE_ADDR,
    battery: batteryLevel,
    package: foreground.package,
    activity: foreground.activity,
  });
});
```

Replace with (only the `if (phone_connected)` body and the `res.json` are changed — the rest stays):

```javascript
router.get('/status', async (req, res) => {
  let phone_connected = false;
  let batteryLevel = null;
  let screen_on = false;
  let foreground = { package: '', activity: '' };
  try {
    const devOut = (await adbAsync('devices')).toString();
    phone_connected = devOut.split('\n').slice(1).some(l => l.trim().endsWith('\tdevice'));
  } catch {}
  if (phone_connected) {
    try {
      const b = (await adbAsync('shell', 'dumpsys battery | grep level')).toString();
      const m = b.match(/level:\s*(\d+)/); if (m) batteryLevel = parseInt(m[1], 10);
    } catch {}
    try {
      const p = (await adbAsync('shell', 'dumpsys power | grep mWakefulness')).toString();
      screen_on = parseWakefulness(p);
    } catch {}
    foreground = await detectForeground();
  }
  res.json({
    adb_available: true,
    phone_connected,
    phone_addr: PHONE_ADDR,
    battery: batteryLevel,
    screen_on,
    package: foreground.package,
    activity: foreground.activity,
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/android.test.js`
Expected: all tests pass, including the new `screen_on:false when ADB is unavailable` smoke.

- [ ] **Step 6: Commit**

```bash
git add android.js tests/android.test.js
git commit -m "feat: /android/status reports screen_on derived from dumpsys mWakefulness"
```

---

## Task 3: `screenToPhone` browser helper (pure function)

**Files:**
- Modify: `public/cam/index.html` — add helper near existing `screenToVirtual` around line 1645

- [ ] **Step 1: Locate the existing `screenToVirtual` function**

In `public/cam/index.html`, find `function screenToVirtual(e) {` at line 1645. Read the surrounding 30 lines to understand its style; the new function will sit immediately after it.

- [ ] **Step 2: Add `screenToPhone` directly below `screenToVirtual`**

After the closing `}` of `screenToVirtual` (and after the closing `}` of `virtualToScreen` if those are adjacent — confirm by reading), insert:

```javascript
  // Map a browser pointer event's CSS coords to phone-screen pixel coords.
  // Uses the viewport <img>'s naturalWidth/Height — that's whatever the most recent
  // MJPEG frame actually was, so rotation is handled automatically (the new frame
  // brings new natural dimensions).
  function screenToPhone(e) {
    if (!$viewport) return null;
    var nw = $viewport.naturalWidth;
    var nh = $viewport.naturalHeight;
    if (!nw || !nh) return null;
    var rect = $viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var x = Math.round((e.clientX - rect.left) / rect.width  * nw);
    var y = Math.round((e.clientY - rect.top ) / rect.height * nh);
    if (x < 0) x = 0; else if (x > nw - 1) x = nw - 1;
    if (y < 0) y = 0; else if (y > nh - 1) y = nh - 1;
    return { x: x, y: y };
  }
```

- [ ] **Step 3: Start the dev server (if not running)**

Run: `npm start &` then wait a moment.
Verify: `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3333/cam/` returns `200`.

- [ ] **Step 4: Test the helper headless via chrome-devtools-mcp**

Open `http://localhost:3333/cam/` in the chrome-devtools-mcp browser, then evaluate this script:

```javascript
() => {
  // Find the cam IIFE's screenToPhone via the viewport's bound listener — but it's
  // closure-scoped. Instead, replicate the logic with the same source-of-truth
  // ($viewport.naturalWidth/Height) to verify the math.
  const viewport = document.getElementById('viewport');
  // Force-set naturalWidth/Height by injecting a known image:
  // (in practice, just test math against a stub.)
  function screenToPhoneTest(clientX, clientY, naturalW, naturalH, rect) {
    if (!naturalW || !naturalH || !rect.width || !rect.height) return null;
    let x = Math.round((clientX - rect.left) / rect.width * naturalW);
    let y = Math.round((clientY - rect.top) / rect.height * naturalH);
    if (x < 0) x = 0; else if (x > naturalW - 1) x = naturalW - 1;
    if (y < 0) y = 0; else if (y > naturalH - 1) y = naturalH - 1;
    return { x, y };
  }
  const rect = { left: 0, top: 0, width: 500, height: 1000 };
  return {
    origin:       screenToPhoneTest(0, 0, 1080, 2400, rect),         // expect (0,0)
    bottomRight:  screenToPhoneTest(500, 1000, 1080, 2400, rect),    // expect (1079,2399)
    center:       screenToPhoneTest(250, 500, 1080, 2400, rect),     // expect (540,1200)
    notLoaded:    screenToPhoneTest(100, 100, 0, 0, rect),           // expect null
    offscreenNeg: screenToPhoneTest(-50, -50, 1080, 2400, rect),     // expect (0,0)  clamp
    offscreenPos: screenToPhoneTest(9999, 9999, 1080, 2400, rect),   // expect (1079,2399) clamp
  };
}
```

Expected output:
```json
{
  "origin": {"x":0,"y":0},
  "bottomRight": {"x":1079,"y":2399},
  "center": {"x":540,"y":1200},
  "notLoaded": null,
  "offscreenNeg": {"x":0,"y":0},
  "offscreenPos": {"x":1079,"y":2399}
}
```

If math is correct, the implementation is correct (the test replicates the implementation rather than calling it directly because `screenToPhone` is closure-scoped inside the cam IIFE).

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: screenToPhone helper maps viewport CSS coords to phone pixel coords"
```

---

## Task 4: Pointer-event refactor (regression-only — preserve existing behavior)

**Files:**
- Modify: `public/cam/index.html` — replace mouse-event listeners at lines 1672–1707 and 2211–2252

**Critical rule:** This task changes NO observable behavior. Browser-mode click + drag must work identically after this task. The android-mode routing is added in Task 5. If any browser-mode interaction starts failing, revert immediately and re-investigate before proceeding.

- [ ] **Step 1: Locate and read the existing handlers**

Open `public/cam/index.html`. Confirm the following ranges (line numbers may shift slightly after Task 3):
- `$viewport.addEventListener('click', ...)` block — currently lines 1672–1707
- `$viewport.addEventListener('mousedown', ...)` and the two `document.addEventListener('mouse...')` blocks — currently lines 2211–2252

Read both ranges fully so the new implementation can preserve every branch (highlight mode, waitfor handoff, click ripple, recordAction, scroll-on-drag with direction logic).

- [ ] **Step 2: Replace the click handler block (~1672–1707)**

Replace the entire `$viewport.addEventListener('click', function(e) { ... });` block with this comment + a placeholder, since the new unified pointer handler will absorb its responsibilities:

```javascript
  // (Click handler removed — its responsibilities are now in the unified pointer
  // handler below, which dispatches tap/scroll/highlight based on mode + drag distance.)
```

- [ ] **Step 3: Replace the mousedown/mousemove/mouseup block (~2211–2252)**

Replace the entire three-listener block (`$viewport.addEventListener('mousedown', ...)`, `document.addEventListener('mousemove', ...)`, `document.addEventListener('mouseup', ...)`) with this unified pointer handler:

```javascript
  // ---- Unified pointer handler for the viewport ----
  // One state machine handles tap-vs-drag and dispatches to the right endpoint
  // based on interactionMode (and androidMode — added in a later commit).
  var pointerState = null;  // { id, startX, startY, startNaturalW, startNaturalH, startTime, dragged }
  var DRAG_THRESHOLD_PX = 5;

  $viewport.addEventListener('pointerdown', function(e) {
    if (!e.isPrimary) return;
    if (state.splashVisible) return;
    if (state.interactionMode === 'highlight') return; // highlights handled via the simple-click branch below
    $viewport.setPointerCapture(e.pointerId);
    pointerState = {
      id: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startVirtual: screenToVirtual(e),
      startNaturalW: $viewport.naturalWidth,
      startNaturalH: $viewport.naturalHeight,
      startTime: e.timeStamp,
      dragged: false,
    };
    if (state.interactionMode === 'drag') {
      $viewport.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  $viewport.addEventListener('pointermove', function(e) {
    if (!pointerState || e.pointerId !== pointerState.id) return;
    if (!pointerState.dragged) {
      var dx = Math.abs(e.clientX - pointerState.startClientX);
      var dy = Math.abs(e.clientY - pointerState.startClientY);
      if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
        pointerState.dragged = true;
      }
    }
    if (state.interactionMode === 'drag') e.preventDefault();
  });

  $viewport.addEventListener('pointerup', function(e) {
    if (!pointerState || e.pointerId !== pointerState.id) return;
    var ps = pointerState;
    pointerState = null;
    if (state.interactionMode === 'drag') $viewport.style.cursor = 'grab';

    var endVirtual = screenToVirtual(e);
    var startV = ps.startVirtual;
    if (!startV) return;
    var endV = endVirtual || startV;

    // Highlight mode handled in the simple-click branch below — the early-return in
    // pointerdown means highlight mode falls through to the legacy click flow.

    if (state.interactionMode === 'drag') {
      if (ps.dragged) {
        // Drag in drag-mode → scroll
        apiPost('/live/scroll', {
          direction: (endV.y < startV.y) ? 'down' : 'up',
          amount: Math.abs(endV.y - startV.y),
        });
      } else {
        // No movement in drag-mode → treat as click (existing behavior)
        var rect = $viewport.getBoundingClientRect();
        showClickEffect(e.clientX - rect.left, e.clientY - rect.top, 'human');
        recordAction('click', { x: startV.x, y: startV.y });
        apiPost('/live/click', { x: startV.x, y: startV.y });
      }
    } else if (state.interactionMode === 'click') {
      // Click-mode → always tap at release coord, ignore drag movement
      var rect2 = $viewport.getBoundingClientRect();
      showClickEffect(e.clientX - rect2.left, e.clientY - rect2.top, 'human');
      recordAction('click', { x: endV.x, y: endV.y });
      apiPost('/live/click', { x: endV.x, y: endV.y });
    }
  });

  $viewport.addEventListener('pointercancel', function(e) {
    if (pointerState && e.pointerId === pointerState.id) {
      pointerState = null;
      if (state.interactionMode === 'drag') $viewport.style.cursor = 'grab';
    }
  });

  // Highlight mode still uses a plain click — the pointer handler above bails
  // early when interactionMode is 'highlight'. Same logic as the old click handler.
  $viewport.addEventListener('click', function(e) {
    if (state.interactionMode !== 'highlight') return;
    if (state.splashVisible) return;
    var coords = screenToVirtual(e);
    if (!coords) return;
    var x = coords.x, y = coords.y;
    var label = state.waitforActive ? state.waitforMessage : 'Point ' + (state.highlights.length + 1);
    addHighlightDot(coords.screenX, coords.screenY, x, y, label);
    apiPost('/highlight', androidMode
      ? { x: x, y: y, label: label, target: 'android', package: (androidStatus.package || ''), activity: (androidStatus.activity || '') }
      : { x: x, y: y, label: label });
    if (state.waitforActive) {
      state.highlightMode = false;
      var allModes = document.querySelectorAll('.cb-mode');
      for (var m = 0; m < allModes.length; m++) allModes[m].classList.remove('active-mode');
      document.getElementById('mode-click').classList.add('active-mode');
      $viewport.style.cursor = 'crosshair';
      $waitforBanner.classList.remove('visible');
    }
  });
```

- [ ] **Step 4: Manual regression check — browser-mode click**

In the chrome-devtools-mcp browser, open `http://localhost:3333/cam/`. Make sure HANDROID is OFF (body should not have `.android-mode` class). Then:
1. Navigate to any URL via the URL bar (e.g., `https://example.com`).
2. Wait for viewport to show the rendered browser page.
3. Click somewhere in the viewport.
4. Use `evaluate_script` to verify the click was registered:
   ```javascript
   () => fetch('/sessions/current').then(r => r.json()).then(d => d.actions ? d.actions.slice(-3) : 'no-actions-key')
   ```
   Or just verify a red click ripple animated where you clicked. The ripple is sufficient evidence the handler fired.

- [ ] **Step 5: Manual regression check — browser-mode drag scroll**

Same browser tab. Switch interaction mode to `✋ Drag` (the button at the top). Then perform a drag (mousedown, move > 5px, mouseup) on the viewport. The remote browser page should scroll. If `/live/scroll` doesn't fire, debug the handler. Tail the server log to confirm:

```bash
tail -f /tmp/claude-1000/-home-rickburp-Projects-HumanAIE/*/tasks/*.output 2>/dev/null | grep -E "scroll|click"
```

Or check the dev server's stdout for `/live/scroll` or any error.

- [ ] **Step 6: Manual regression check — highlight mode**

Click the `👆 Point` button to enter highlight mode. Click in the viewport. Verify a yellow highlight dot appears and `/highlight` was POSTed. (Server log line or check `history.json`.)

- [ ] **Step 7: Commit**

```bash
git add public/cam/index.html
git commit -m "refactor: replace mouse handlers on viewport with unified pointer-event state machine"
```

---

## Task 5: Add android-mode dispatch (tap-through + drag-swipe)

**Files:**
- Modify: `public/cam/index.html` — extend the `pointerup` handler from Task 4 with android-mode branches

- [ ] **Step 1: Read the pointer-handler code from Task 4**

Locate the `pointerup` listener installed in Task 4. Its current dispatch handles two cases: `interactionMode === 'drag'` (scroll-or-click) and `interactionMode === 'click'` (always click). This task wraps each call to `/live/click` and `/live/scroll` with a mode-aware branch.

- [ ] **Step 2: Modify the `pointerup` listener**

Replace the entire `$viewport.addEventListener('pointerup', function(e) { ... });` block from Task 4 with this extended version:

```javascript
  $viewport.addEventListener('pointerup', function(e) {
    if (!pointerState || e.pointerId !== pointerState.id) return;
    var ps = pointerState;
    pointerState = null;
    if (state.interactionMode === 'drag') $viewport.style.cursor = 'grab';

    var startV = ps.startVirtual;
    var endV = screenToVirtual(e) || startV;
    if (!startV) return;

    // Rotation guard: if the phone's natural dimensions changed mid-drag,
    // abort the gesture. Better to drop one swipe than send bad coords.
    var rotated = (
      $viewport.naturalWidth  !== ps.startNaturalW ||
      $viewport.naturalHeight !== ps.startNaturalH
    );

    if (state.interactionMode === 'drag') {
      if (ps.dragged) {
        if (androidMode) {
          if (rotated) return;
          var startP = screenToPhone({ clientX: ps.startClientX, clientY: ps.startClientY });
          var endP   = screenToPhone(e);
          if (!startP || !endP) return;
          var dur = e.timeStamp - ps.startTime;
          if (dur < 100) dur = 100; else if (dur > 1000) dur = 1000;
          recordAction('swipe', { x1: startP.x, y1: startP.y, x2: endP.x, y2: endP.y, dur: dur });
          fetch('/android/swipe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ x1: startP.x, y1: startP.y, x2: endP.x, y2: endP.y, dur: dur }),
          }).catch(function(err) { console.warn('android swipe failed', err); });
        } else {
          apiPost('/live/scroll', {
            direction: (endV.y < startV.y) ? 'down' : 'up',
            amount: Math.abs(endV.y - startV.y),
          });
        }
      } else {
        // No movement in drag-mode → treat as tap/click
        var rect = $viewport.getBoundingClientRect();
        showClickEffect(e.clientX - rect.left, e.clientY - rect.top, 'human');
        if (androidMode) {
          var tapP = screenToPhone({ clientX: ps.startClientX, clientY: ps.startClientY });
          if (!tapP) return;
          recordAction('tap', { x: tapP.x, y: tapP.y });
          fetch('/android/tap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ x: tapP.x, y: tapP.y }),
          }).catch(function(err) { console.warn('android tap failed', err); });
        } else {
          recordAction('click', { x: startV.x, y: startV.y });
          apiPost('/live/click', { x: startV.x, y: startV.y });
        }
      }
    } else if (state.interactionMode === 'click') {
      // Click-mode → always tap at release coord, ignore drag movement
      var rect2 = $viewport.getBoundingClientRect();
      showClickEffect(e.clientX - rect2.left, e.clientY - rect2.top, 'human');
      if (androidMode) {
        var clickP = screenToPhone(e);
        if (!clickP) return;
        recordAction('tap', { x: clickP.x, y: clickP.y });
        fetch('/android/tap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x: clickP.x, y: clickP.y }),
        }).catch(function(err) { console.warn('android tap failed', err); });
      } else {
        recordAction('click', { x: endV.x, y: endV.y });
        apiPost('/live/click', { x: endV.x, y: endV.y });
      }
    }
  });
```

- [ ] **Step 3: Verify browser-mode still works (regression check)**

Re-run the manual regression checks from Task 4, Steps 4–6. **No browser-mode behavior should have changed.** If anything broke, revert and re-inspect the diff.

- [ ] **Step 4: Verify android-mode wiring against `/android/*` 503 responses on this machine**

This machine has no ADB (`.82`), so `/android/tap` returns 503. That's still useful — it proves the request is *firing*. Open `http://localhost:3333/cam/`, enable HANDROID mode, ensure Click interaction mode is selected, click the viewport. Use chrome-devtools-mcp's `list_network_requests` and look for a POST to `/android/tap` with status 503. If you see it, the wiring is correct. The actual phone-side verification happens on `.90` in Task 8.

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: viewport tap/drag drives /android/tap and /android/swipe in HANDROID mode"
```

---

## Task 6: Sleep banner DOM and CSS

**Files:**
- Modify: `public/cam/index.html` — add a `<div>` inside `#viewport-wrapper` (around line 803), add corresponding CSS

- [ ] **Step 1: Add the CSS rule**

Find the `<style>` section. Locate the existing `#android-splash` rule (around line 684). Add this block immediately after the existing splash-related rules (search for the comment `Handroid splash` to find the right neighborhood):

```css
  /* Phone-asleep banner — sits above the viewport in HANDROID mode when
     /android/status reports screen_on:false. Click to wake. */
  #phone-sleep-banner {
    display: none;
    position: absolute;
    inset: 0;
    z-index: 9;
    background: rgba(0, 0, 0, 0.55);
    color: #c8f0c8;
    font-family: inherit;
    font-size: 14px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  #phone-sleep-banner.shown { display: flex; }
  #phone-sleep-banner .ps-title { font-weight: bold; font-size: 16px; color: #d0f0d0; }
  #phone-sleep-banner .ps-hint  { opacity: 0.7; font-size: 11px; }
```

- [ ] **Step 2: Add the DOM element**

Find `<div id="viewport-wrapper">` at line 803. Locate the existing splash element inside it (search for `id="android-splash"`). Add the new banner element immediately after the android-splash closing tag (still inside `#viewport-wrapper`):

```html
        <div id="phone-sleep-banner">
          <div>💤</div>
          <div class="ps-title">Phone is asleep</div>
          <div class="ps-hint">tap to wake</div>
        </div>
```

- [ ] **Step 3: Verify markup renders correctly**

Reload `http://localhost:3333/cam/`. Use chrome-devtools-mcp evaluate_script:

```javascript
() => {
  const el = document.getElementById('phone-sleep-banner');
  if (!el) return 'MISSING';
  const cs = getComputedStyle(el);
  return { display: cs.display, zIndex: cs.zIndex, position: cs.position };
}
```

Expected: `{ display: 'none', zIndex: '9', position: 'absolute' }`. The banner is in the DOM but hidden because no `.shown` class is applied yet (Task 7 wires that).

- [ ] **Step 4: Manually force-show the banner and screenshot for visual check**

Evaluate:
```javascript
() => document.getElementById('phone-sleep-banner').classList.add('shown')
```

Take a screenshot. Verify it shows a centered "💤 Phone is asleep — tap to wake" message overlay. Then evaluate:
```javascript
() => document.getElementById('phone-sleep-banner').classList.remove('shown')
```

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: phone-asleep banner DOM and CSS (hidden by default)"
```

---

## Task 7: Wire sleep banner to status poll + KEYCODE_WAKEUP

**Files:**
- Modify: `public/cam/index.html` — extend the existing `refreshAndroidStatus` callback (around lines 1559–1605) and bind a click handler on the banner

- [ ] **Step 1: Find the status-poll callback**

In `public/cam/index.html`, find `function refreshAndroidStatus` or — if it's structured differently — the area starting at line 1559 where `var splash = document.getElementById('android-splash');` appears. Read the surrounding 40 lines so you understand the existing `androidStatus.*` consumption pattern.

- [ ] **Step 2: Add banner-toggle logic to the status callback**

Inside the same function/block that handles the splash visibility (after the `if (splash) { ... }` block, still inside the `androidMode` branch), insert:

```javascript
    // Phone-asleep banner toggle. Show only when phone is connected AND screen is off
    // (when phone disconnected, the existing NO-PHONE splash takes over).
    var sleepBanner = document.getElementById('phone-sleep-banner');
    if (sleepBanner) {
      var shouldShowSleep = androidMode && androidStatus.phone_connected && androidStatus.screen_on === false;
      sleepBanner.classList.toggle('shown', shouldShowSleep);
    }
```

- [ ] **Step 3: Bind the click → wake handler**

Find a section near other `bindIf(...)` or DOMContentLoaded-style bindings — there's a block around line 1624 with `bindIf('ac-back', ...)` etc. Add a new binding for the banner. If `bindIf` is the helper used elsewhere, prefer it; otherwise use a plain `addEventListener`. Add:

```javascript
  (function bindSleepBanner() {
    var el = document.getElementById('phone-sleep-banner');
    if (!el) return;
    el.addEventListener('click', function() {
      fetch('/android/key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keycode: 'KEYCODE_WAKEUP' }),
      }).catch(function(err) { console.warn('wake key failed', err); });
      // Immediately re-poll status so the banner clears as soon as the phone wakes.
      if (typeof refreshAndroidStatus === 'function') refreshAndroidStatus();
    });
  })();
```

- [ ] **Step 4: Test banner toggle by stubbing the status poll response**

Open `http://localhost:3333/cam/` in chrome-devtools-mcp. Enable HANDROID. Then evaluate this script to simulate the poll callback running with a sleep-state response:

```javascript
() => {
  // Force-set androidStatus and re-run refreshAndroidStatus to test the toggle.
  if (typeof androidStatus === 'undefined') return 'androidStatus not in scope';
  androidStatus.phone_connected = true;
  androidStatus.screen_on = false;
  androidStatus.adb_available = true;
  // The refreshAndroidStatus function reads from a global androidStatus — call it.
  // If it does its own fetch, we override fetch briefly first:
  const origFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.includes('/android/status')) {
      return Promise.resolve(new Response(JSON.stringify({
        adb_available: true, phone_connected: true, screen_on: false,
        battery: 80, package: 'com.test', activity: '.Main', phone_addr: 'stub',
      }), { headers: { 'content-type': 'application/json' } }));
    }
    return origFetch(url, opts);
  };
  return new Promise((resolve) => {
    setTimeout(() => {
      const banner = document.getElementById('phone-sleep-banner');
      window.fetch = origFetch;
      resolve({ shown: banner.classList.contains('shown') });
    }, 2500);  // wait one poll cycle
  });
}
```

Expected: `{ shown: true }` — banner became visible because the poll saw `screen_on: false`.

- [ ] **Step 5: Verify clicking the banner POSTs the wake key**

Add a small in-browser fetch monitor first, then click the banner:

```javascript
() => {
  window.__lastWake = null;
  const origFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url === '/android/key') window.__lastWake = JSON.parse(opts.body);
    return origFetch(url, opts);
  };
  document.getElementById('phone-sleep-banner').click();
  return new Promise(r => setTimeout(() => { window.fetch = origFetch; r(window.__lastWake); }, 200));
}
```

Expected: `{ keycode: 'KEYCODE_WAKEUP' }`

- [ ] **Step 6: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: sleep banner toggles from /android/status poll and wakes phone on click"
```

---

## Task 8: Fix two hardcoded version strings

**Files:**
- Modify: `public/cam/index.html` — line 807 (`v1.0.0`) and line 1052 (`v1.0.1`)

- [ ] **Step 1: Verify current state**

Run:
```bash
grep -n 'v1\.0\.' public/cam/index.html
```

Expected output (line numbers may have shifted from earlier tasks):
```
807:      <div class="version ver-tag">v1.0.0</div>
1052:      <span style="font-weight:bold;font-size:11px">HumanAIE <span class="ver-tag" style="font-weight:normal;opacity:0.7">v1.0.1</span></span>
```

If line numbers differ, locate the strings by `grep`.

- [ ] **Step 2: Replace both strings**

Edit `public/cam/index.html`:
- Change `v1.0.0` (around line 807) to `v1.2.0`
- Change `v1.0.1` (around line 1052) to `v1.2.0`

- [ ] **Step 3: Verify**

Run:
```bash
grep -n 'v1\.0\.' public/cam/index.html
```

Expected: no matches.

Run:
```bash
grep -n 'v1\.2\.0' public/cam/index.html | head
```

Expected: at least two matches in the markup regions (~807 and ~1052).

- [ ] **Step 4: Reload the page and confirm the corner badge shows v1.2.0 before any /version fetch**

In chrome-devtools-mcp, navigate to `http://localhost:3333/cam/` and immediately (before the page settles) evaluate:

```javascript
() => {
  const tags = [...document.querySelectorAll('.ver-tag')].map(t => t.textContent);
  return tags;
}
```

Expected: every entry is `v1.2.0` (either the static fallback or after the `/version` API resolved — both routes now agree).

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "fix: stale hardcoded v1.0.x version labels in markup now match package.json"
```

---

## Task 9: End-to-end manual verification on the real phone (`.90`)

**Files:** None. This task is a user-driven checklist. The implementation is done at the end of Task 8; this task confirms it works against actual hardware.

- [ ] **Step 1: Push the branch and pull on `.90`**

On the dev machine:
```bash
git push origin handroid-v1.2.0
```

On `.90`:
```bash
git pull && npm install   # in case anything changed; otherwise plain pull
npm start
```

- [ ] **Step 2: Tap and drag end-to-end**

Open `http://localhost:3333/cam/` on `.90`. Enable HANDROID mode. With the phone connected and screen on:

- [ ] Click a clear element (e.g., an app icon) → that element activates on the phone
- [ ] Click in different screen regions → tap lands at correct spot (no offset)
- [ ] In Drag mode, drag slowly upward → phone scrolls slowly upward
- [ ] In Drag mode, flick quickly upward → phone scrolls quickly (duration noticeably different)
- [ ] Drag past the viewport edge and back → swipe still completes (pointer-capture working)

- [ ] **Step 3: Sleep awareness**

- [ ] Let the phone sleep naturally → "💤 Phone is asleep — tap to wake" banner appears within ~2s
- [ ] Click the banner → phone wakes, banner clears within ~2s
- [ ] Press the hardware power button on the phone → banner appears

- [ ] **Step 4: Touch popup buttons**

Open the `⌨ Controls` popup, switch to the Touch tab.

- [ ] 🔒 Power → phone screen toggles off/on
- [ ] 🔆 Wake → phone wakes if asleep
- [ ] Vol+ / Vol− → volume changes on phone
- [ ] 📸 Screenshot → screenshot saved (existing path)
- [ ] ▲ ◀ ▼ ▶ canned swipes → phone scrolls correct direction
- [ ] ⬆ Home → navigates to home screen
- [ ] ⬇ Notif → notification shade pulls down
- [ ] ⬅ Back / ➡ Fwd → swipe-back / swipe-forward gestures fire

- [ ] **Step 5: Regression — browser mode unchanged**

Exit HANDROID mode (click the Cam UI tab).
- [ ] Click viewport in browser mode → browser receives click (existing behavior)
- [ ] Drag in browser mode → page scrolls (existing behavior)
- [ ] `👆 Point` → highlight dot drops, `/highlight` POST recorded

- [ ] **Step 6: Document any failures and commit follow-ups inline**

If anything fails, file a focused fix as its own commit on the same branch with message format `fix: <thing> — <one-line cause>`. Don't bundle multiple fixes into one commit.

- [ ] **Step 7: When checklist is fully green, merge branch to main**

On the dev machine:
```bash
git checkout main
git merge --ff-only handroid-v1.2.0
git push origin main
git checkout handroid-v1.2.0
```

---

## Done criteria

- [ ] `node --test tests/android.test.js` passes 100%
- [ ] Browser-mode click/drag/highlight work identically to pre-change behavior
- [ ] On the `.90` phone, all checklist items in Task 9 are green
- [ ] No new console warnings or errors in the browser
- [ ] `git log --oneline main..handroid-v1.2.0` shows ~8 focused commits, each scoped to one task
