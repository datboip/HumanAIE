# Full Calibration Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** End-to-end click-accuracy verification: HumanAIE fires `/android/tap` at known phone coords, a mobile web page opened in the phone's Chrome captures the actual touch coords, posts them back, and the cam UI shows real drift per tap in real time. AI agents can call a single `POST /calibrate/start` to run the suite autonomously.

**Architecture:** Calibration page (`/calibrate-target`) is a static HTML served by HumanAIE that registers touch events and POSTs each one to `/calibrate-target/report`. Reports broadcast over the existing SSE `/events` stream so the cam UI sees them live. An orchestrator endpoint coordinates server-fired taps + report collection + drift computation in one call.

**Tech Stack:** Node.js + Express (existing `server.js`, `android.js`), vanilla JS in the calibration page, ADB for launching the page on the phone via `am start -a android.intent.action.VIEW -d <url>`.

**Spec discussion:** captured in conversation 2026-05-20 — user wants a "full suite" calibration where the phone shows where taps actually land, not just a sanity check of client-side math.

---

## File Structure

| File | Role | Disposition |
|---|---|---|
| `public/calibrate-target.html` | Mobile-optimized full-screen page. Touch events render dots + POST to `/calibrate-target/report`. Fullscreen API used to remove address bar (avoid offset complications). | **Create** |
| `server.js` | Routes: `GET /calibrate-target` (serves the HTML), `POST /calibrate-target/report` (accepts reports, broadcasts via SSE), `POST /android/open-url` (ADB intent launcher), `POST /calibrate/start` (orchestrator). | **Modify** |
| `public/cam/index.html` | Replace existing `calibrateClicks` UI with new "Start full calibration" flow: opens page on phone (via /android/open-url), fires server taps, listens to SSE reports, shows live results. Keeps the click-the-dot mode reachable as a separate "client-math only" test. | **Modify** |
| `README.md` | Add agent guidance: when to call /calibrate/start, what the result means, when to abort vs proceed. | **Modify** |

---

## Task Order

1. **Calibration target page + report endpoint + in-memory store** — the surface AI/UI interact with.
2. **SSE broadcast of reports** — so the cam UI sees live updates without polling.
3. **ADB open-url helper** — so the user (and AI) doesn't have to type the URL on the phone manually.
4. **Cam UI Full Calibration mode** — orchestrate server taps + SSE listening + live results panel.
5. **`POST /calibrate/start` orchestrator** — AI-callable, returns drift summary in one round trip.
6. **README + version bump v1.5.0** — ship with P3 since both are mobile-side improvements.

Each task ends in a commit.

---

## Task 1: `/calibrate-target` page + report endpoint

**Files:**
- Create: `public/calibrate-target.html`
- Modify: `server.js` — add route, in-memory store

- [ ] **Step 1: Create `public/calibrate-target.html`**

Mobile-optimized full-screen page. Black background, large "Tap anywhere" instruction. Each touch:
- Renders a dot at the touch location with `(x, y) phone-coord-equivalent` label
- POSTs `{ clientX, clientY, innerW, innerH, screenW, screenH, dpr, t }` to `/calibrate-target/report`
- A Fullscreen button at top requests document.documentElement.requestFullscreen() to remove the address bar

The page uses `<meta viewport content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">` and CSS `touch-action: none` on the canvas so the browser doesn't intercept gestures.

```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>HumanAIE Calibration Target</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff; font-family: monospace; overscroll-behavior: none; }
  #canvas { position: fixed; inset: 0; touch-action: none; }
  .dot { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #3ddc84; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.7); }
  .label { position: absolute; font-size: 12px; color: #3ddc84; text-shadow: 0 0 2px #000; pointer-events: none; padding: 2px 4px; background: rgba(0,0,0,0.6); border-radius: 3px; }
  #hud { position: fixed; left: 8px; top: 8px; right: 8px; display: flex; justify-content: space-between; align-items: center; pointer-events: none; }
  #hud .left, #hud .right { background: rgba(0,0,0,0.7); padding: 6px 10px; border-radius: 4px; font-size: 12px; pointer-events: auto; }
  #fs-btn { background: #6633cc; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; font-family: inherit; font-size: 12px; cursor: pointer; }
  #clear-btn { background: transparent; color: #888; border: 1px solid #444; padding: 4px 10px; border-radius: 3px; font-family: inherit; font-size: 11px; cursor: pointer; margin-left: 6px; }
</style>
</head><body>
  <div id="canvas"></div>
  <div id="hud">
    <div class="left"><span id="status">Tap anywhere — dots will appear</span></div>
    <div class="right"><button id="fs-btn">⛶ Fullscreen</button><button id="clear-btn">Clear</button></div>
  </div>
<script>
(function() {
  var $canvas = document.getElementById('canvas');
  var $status = document.getElementById('status');
  var n = 0;
  function dotAt(clientX, clientY, phoneX, phoneY) {
    var dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.left = clientX + 'px';
    dot.style.top  = clientY + 'px';
    $canvas.appendChild(dot);
    var label = document.createElement('div');
    label.className = 'label';
    label.style.left = (clientX + 10) + 'px';
    label.style.top  = (clientY + 10) + 'px';
    label.textContent = '#' + (++n) + ' (' + Math.round(phoneX) + ',' + Math.round(phoneY) + ')';
    $canvas.appendChild(label);
  }
  function report(e) {
    e.preventDefault();
    // Use touches for touch events, else clientX/Y for pointer events.
    var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
    var cx = t.clientX, cy = t.clientY;
    // Map CSS coords → phone pixel coords assuming the page fills the viewport
    // at 1:1 device pixel ratio. devicePixelRatio handles HiDPI screens.
    var dpr = window.devicePixelRatio || 1;
    var phoneX = cx * dpr;
    var phoneY = cy * dpr;
    dotAt(cx, cy, phoneX, phoneY);
    $status.textContent = 'Last: (' + Math.round(phoneX) + ', ' + Math.round(phoneY) + ')  · ' + n + ' total';
    fetch('/calibrate-target/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientX: cx, clientY: cy,
        phoneX: phoneX, phoneY: phoneY,
        innerW: window.innerWidth, innerH: window.innerHeight,
        screenW: window.screen.width, screenH: window.screen.height,
        dpr: dpr, t: Date.now(),
      }),
    }).catch(function() {});
  }
  // Use both touchstart and pointerdown; pointerdown fires on desktop Chrome
  // (lets you test from a desktop browser too).
  $canvas.addEventListener('touchstart', report, { passive: false });
  $canvas.addEventListener('pointerdown', function(e) {
    if (e.pointerType === 'touch') return;  // already handled by touchstart
    report(e);
  });
  document.getElementById('fs-btn').addEventListener('click', function() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) fn.call(el);
  });
  document.getElementById('clear-btn').addEventListener('click', function() {
    while ($canvas.firstChild) $canvas.removeChild($canvas.firstChild);
    n = 0;
    $status.textContent = 'Cleared — tap anywhere';
  });
})();
</script>
</body></html>
```

- [ ] **Step 2: Add server route + store**

In `server.js`, find an appropriate spot for new routes. Add:

```javascript
// ── Calibration target (mobile web page that captures touch coords) ───────
const CALIB_REPORTS = [];          // ring buffer of recent reports
const CALIB_MAX = 200;

app.get('/calibrate-target', function(req, res) {
  res.sendFile(require('path').join(__dirname, 'public', 'calibrate-target.html'));
});

app.post('/calibrate-target/report', function(req, res) {
  const body = req.body || {};
  if (typeof body.phoneX !== 'number' || typeof body.phoneY !== 'number') {
    return res.status(400).json({ error: 'phoneX/phoneY required' });
  }
  const report = {
    phoneX: body.phoneX, phoneY: body.phoneY,
    clientX: body.clientX, clientY: body.clientY,
    innerW: body.innerW, innerH: body.innerH,
    screenW: body.screenW, screenH: body.screenH,
    dpr: body.dpr, t: body.t || Date.now(),
  };
  CALIB_REPORTS.push(report);
  if (CALIB_REPORTS.length > CALIB_MAX) CALIB_REPORTS.shift();
  // SSE broadcast added in Task 2.
  res.json({ ok: true });
});

app.get('/calibrate-target/reports', function(req, res) {
  res.json({ reports: CALIB_REPORTS.slice(-50) });
});
```

- [ ] **Step 3: Smoke test the page loads + report stores**

```bash
ssh garage@192.168.2.90 "git pull && fuser -k 3333/tcp; sleep 2; systemd-run --user --scope --no-block bash -lc 'cd /home/garage/projects/HumanAIE && /home/garage/.nvm/versions/node/v22.22.1/bin/node server.js >> /tmp/humanaie.log 2>&1'"
sleep 4
ssh garage@192.168.2.90 "curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3333/calibrate-target"
# expected: 200
ssh garage@192.168.2.90 "curl -sS -X POST -H 'content-type: application/json' -d '{\"phoneX\":540,\"phoneY\":1200}' http://127.0.0.1:3333/calibrate-target/report"
# expected: {\"ok\":true}
ssh garage@192.168.2.90 "curl -sS http://127.0.0.1:3333/calibrate-target/reports"
# expected: {\"reports\":[{\"phoneX\":540,\"phoneY\":1200,...}]}
```

- [ ] **Step 4: Commit**

```bash
git add public/calibrate-target.html server.js
git commit -m "feat(calibration): mobile target page + report capture endpoint"
```

---

## Task 2: SSE broadcast of calibration reports

**Files:**
- Modify: `server.js` — broadcast each report via the existing `pushAction` SSE stream

- [ ] **Step 1: Broadcast on every report**

Find the existing `pushAction(label, value, status, meta)` function in `server.js` (it's the broadcaster used for tap/swipe events). The cam UI already listens for `AndroidTap`, `AndroidSwipe`, etc. We add a new event type `CalibrationReport`.

In the `/calibrate-target/report` handler, after pushing to `CALIB_REPORTS`, add:

```javascript
try {
  pushAction('CalibrationReport', '(' + Math.round(report.phoneX) + ', ' + Math.round(report.phoneY) + ')', 'ok', {
    phoneX: report.phoneX, phoneY: report.phoneY, t: report.t,
  });
} catch {}
```

- [ ] **Step 2: Verify the broadcaster exists and signature matches**

```bash
grep -n "function pushAction\|pushAction(" server.js | head -5
```

Confirm the signature is `(label, value, status, meta)`. If it's different, adapt the call.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(calibration): broadcast each touch report over SSE as CalibrationReport event"
```

---

## Task 3: `POST /android/open-url` helper

**Files:**
- Modify: `android.js` — add an endpoint that runs `adb shell am start -a android.intent.action.VIEW -d <url>`

- [ ] **Step 1: Add the handler**

In `android.js`, find an existing router endpoint that runs adb shell commands (e.g., the /key handler, or the launcher endpoint). Add below it:

```javascript
router.post('/open-url', function(req, res) {
  var url = req.body && req.body.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
  // Reject anything that isn't a plain http(s) URL — prevents shell-injection
  // via crafted "intent://" or arbitrary scheme strings.
  if (!/^https?:\/\/[A-Za-z0-9._:\-]+(\/[^\s'\"<>`]*)?$/.test(url)) {
    return res.status(400).json({ error: 'invalid url' });
  }
  var cp = require('child_process');
  cp.execFile('adb', ['-s', SERIAL_REF.current || '', 'shell', 'am', 'start',
                       '-a', 'android.intent.action.VIEW', '-d', url], { timeout: 5000 },
    function(err, stdout, stderr) {
      if (err) return res.status(500).json({ error: err.message, stderr: stderr });
      res.json({ ok: true, stdout: String(stdout || '').trim() });
    });
});
```

Note: the URL whitelist regex blocks shell metachars and protocol smuggling. Only plain http/https URLs allowed.

- [ ] **Step 2: Smoke test**

```bash
ssh garage@192.168.2.90 "curl -sS -X POST -H 'content-type: application/json' -d '{\"url\":\"http://192.168.2.90:3333/calibrate-target\"}' http://127.0.0.1:3333/android/open-url"
# expected: {\"ok\":true,...}
# Phone's Chrome should open the calibration page.
```

- [ ] **Step 3: Commit**

```bash
git add android.js
git commit -m "feat(android): POST /android/open-url launches Chrome on phone via ADB intent"
```

---

## Task 4: Cam UI Full Calibration mode

**Files:**
- Modify: `public/cam/index.html` — add a "Full calibration" button + flow

- [ ] **Step 1: Add a new button next to the existing 📐 Calibrate**

In the phone settings popup, add a row below the existing Calibrate button:

```html
<div class="popup-row">
  <button class="nav-btn" style="height:28px;font-size:11px;padding:0 8px;width:100%" onclick="calibrateFullSuite()" title="End-to-end click test: opens the calibration target page on the phone, fires 9 server taps, compares fired vs observed coords">📐 Full calibration (E2E)</button>
</div>
```

- [ ] **Step 2: Add `calibrateFullSuite()` function**

Append in the same script block as `calibrateClicks`:

```javascript
window.calibrateFullSuite = function() {
  if (!androidMode) { alert('Calibration only works in HANDROID mode.'); return; }
  if (state.calibratingFull) return;
  state.calibratingFull = true;

  var positions = buildCalibrationGrid();
  var phoneHost = location.host; // e.g. 192.168.2.90:3333
  var targetUrl = location.protocol + '//' + phoneHost + '/calibrate-target';

  if (!confirm('This will:\\n  1. Open ' + targetUrl + ' in Chrome on the phone\\n  2. Fire 9 taps at known coords\\n  3. Show drift between fired vs observed\\n\\nMake sure the phone is unlocked. Continue?')) {
    state.calibratingFull = false;
    return;
  }

  fetch('/android/open-url', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: targetUrl }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { alert('Failed to open page: ' + d.error); state.calibratingFull = false; return; }
    runFullCalibration(positions);
  }).catch(function(err) {
    alert('Failed to open page: ' + err);
    state.calibratingFull = false;
  });
};

function runFullCalibration(positions) {
  var pending = positions.map(function(p) { return { target: p, observed: null }; });
  var idx = 0;

  // Build overlay panel for live status.
  var overlay = document.createElement('div');
  overlay.id = 'calib-full-overlay';
  overlay.style.cssText = 'position:fixed;right:16px;top:64px;width:320px;background:#0a0a0a;border:2px solid #6633cc;border-radius:6px;padding:12px;color:#fff;font-family:monospace;font-size:11px;z-index:120;box-shadow:0 4px 20px rgba(0,0,0,0.8)';
  var hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;color:#cccc55;margin-bottom:8px;font-size:12px';
  hdr.textContent = '📐 Full calibration in progress';
  overlay.appendChild(hdr);
  var status = document.createElement('div');
  status.style.cssText = 'margin-bottom:8px;color:#888';
  status.textContent = 'Wait 2s for phone to load page...';
  overlay.appendChild(status);
  var resultsList = document.createElement('div');
  resultsList.id = 'calib-full-results';
  overlay.appendChild(resultsList);
  var closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'margin-top:12px;width:100%;padding:6px;background:transparent;color:#888;border:1px solid #444;border-radius:3px;cursor:pointer;font-family:inherit';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', function() {
    overlay.remove();
    cleanupSse();
    state.calibratingFull = false;
  });
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  // Listen for CalibrationReport SSE events.
  var sseHandler = function(evt) {
    try {
      var data = JSON.parse(evt.data);
      if (data.label !== 'CalibrationReport' || !data.meta) return;
      if (idx === 0) return;  // ignore reports before we started firing
      var pos = pending[idx - 1];
      if (pos.observed) return;  // already recorded
      pos.observed = { x: data.meta.phoneX, y: data.meta.phoneY };
      renderRow(pos);
    } catch {}
  };
  // The cam UI's SSE plumbing might already parse events into a custom event;
  // try both:
  if (window.eventSource && typeof window.eventSource.addEventListener === 'function') {
    window.eventSource.addEventListener('message', sseHandler);
  } else {
    document.addEventListener('humanaie:sse', sseHandler);  // fallback (cam UI dispatches these from /events)
  }
  function cleanupSse() {
    if (window.eventSource) window.eventSource.removeEventListener('message', sseHandler);
    document.removeEventListener('humanaie:sse', sseHandler);
  }

  function renderRow(pos) {
    var row = document.createElement('div');
    var color = '#888';
    var detail = '— waiting';
    if (pos.observed) {
      var dx = pos.observed.x - pos.target.px;
      var dy = pos.observed.y - pos.target.py;
      var err = Math.hypot(dx, dy);
      color = err < 5 ? '#3ddc84' : err < 30 ? '#cccc55' : '#d80000';
      detail = '(' + Math.round(pos.observed.x) + ',' + Math.round(pos.observed.y) + ')  Δ' + Math.round(dx) + ',' + Math.round(dy) + '  err ' + err.toFixed(1) + 'px';
    }
    row.style.cssText = 'color:' + color + ';padding:2px 0';
    row.textContent = pos.target.label + ' → (' + pos.target.px + ',' + pos.target.py + ')  ' + detail;
    // Find or append row in list.
    var existing = resultsList.querySelector('[data-label=\"' + pos.target.label + '\"]');
    if (existing) existing.replaceWith(row);
    else resultsList.appendChild(row);
    row.dataset.label = pos.target.label;
  }

  // Render all targets as placeholders.
  pending.forEach(renderRow);

  // Wait 2s for Chrome to load the page on the phone, then start firing taps.
  setTimeout(function() {
    fireNext();
  }, 2000);

  function fireNext() {
    if (idx >= positions.length) {
      status.textContent = 'Done — see results';
      closeBtn.textContent = 'Close';
      // Compute summary.
      var done = pending.filter(function(p) { return p.observed; });
      if (done.length > 0) {
        var avgErr = done.reduce(function(s, p) {
          return s + Math.hypot(p.observed.x - p.target.px, p.observed.y - p.target.py);
        }, 0) / done.length;
        var summary = document.createElement('div');
        summary.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #333;font-weight:bold';
        summary.textContent = done.length + '/' + positions.length + ' captured · avg err ' + avgErr.toFixed(1) + 'px';
        overlay.insertBefore(summary, closeBtn);
      }
      cleanupSse();
      state.calibratingFull = false;
      return;
    }
    var p = positions[idx];
    status.textContent = 'Firing tap ' + (idx + 1) + '/' + positions.length + ': (' + p.px + ',' + p.py + ')';
    idx++;
    fetch('/android/tap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: p.px, y: p.py, source: 'human' }),
    }).catch(function() {});
    setTimeout(fireNext, 800);
  }
}
```

Also add to state init: `calibratingFull: false,`.

- [ ] **Step 3: Verify the SSE listener wiring**

Run: `grep -n "EventSource\|new EventSource\|/events\|window.eventSource" public/cam/index.html | head -10`

If `window.eventSource` isn't already exposed, find the EventSource setup and expose it: change `var eventSource = new EventSource('/events');` to `window.eventSource = new EventSource('/events');` (or use the existing pattern in the codebase).

- [ ] **Step 4: Commit**

```bash
git add public/cam/index.html
git commit -m "feat(calibration): Full calibration (E2E) mode — opens target on phone, fires server taps, shows live drift via SSE"
```

---

## Task 5: `POST /calibrate/start` orchestrator + AI guidance

**Files:**
- Modify: `server.js` — add the orchestrator endpoint

- [ ] **Step 1: Add the endpoint**

In `server.js`, add:

```javascript
// One-shot calibration orchestrator. AI agents call this to verify click
// accuracy before driving the phone. Opens the target page on phone,
// fires 9 taps at known coords, waits for reports, returns drift summary.
app.post('/calibrate/start', async function(req, res) {
  try {
    var dims = await fetch('http://127.0.0.1:' + PORT + '/android/status').then(r => r.json()).catch(() => null);
    if (!dims || !dims.screen_w || !dims.screen_h) {
      return res.status(503).json({ error: 'phone not connected' });
    }
    var W = dims.screen_w, H = dims.screen_h;
    var positions = [];
    [0.1, 0.5, 0.9].forEach(function(yf) {
      [0.1, 0.5, 0.9].forEach(function(xf) {
        positions.push({ px: Math.round(W * xf), py: Math.round(H * yf) });
      });
    });

    // Reset the report buffer.
    CALIB_REPORTS.length = 0;

    // Open the page on the phone (best-effort; AI may have opened it already).
    var targetUrl = 'http://127.0.0.1:' + PORT + '/calibrate-target';
    try {
      await fetch('http://127.0.0.1:' + PORT + '/android/open-url', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      await new Promise(function(r) { setTimeout(r, 2500); });  // page load
    } catch {}

    // Fire taps in sequence.
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      try {
        await fetch('http://127.0.0.1:' + PORT + '/android/tap', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x: p.px, y: p.py, source: 'agent-phone' }),
        });
      } catch {}
      await new Promise(function(r) { setTimeout(r, 800); });
    }

    // Wait 1.5s for trailing reports.
    await new Promise(function(r) { setTimeout(r, 1500); });

    // Match each fired tap to the nearest report (in time order, but use
    // chronological order since taps were sequential).
    var pairs = [];
    var reports = CALIB_REPORTS.slice();
    for (var j = 0; j < positions.length; j++) {
      var fired = positions[j];
      var obs = reports[j] || null;
      if (obs) {
        var dx = obs.phoneX - fired.px;
        var dy = obs.phoneY - fired.py;
        pairs.push({ target: fired, observed: { x: obs.phoneX, y: obs.phoneY }, dx: dx, dy: dy, err: Math.hypot(dx, dy) });
      } else {
        pairs.push({ target: fired, observed: null, dx: null, dy: null, err: null });
      }
    }
    var captured = pairs.filter(function(p) { return p.observed; });
    var avgErr = captured.length ? captured.reduce(function(s, p) { return s + p.err; }, 0) / captured.length : null;
    var maxErr = captured.length ? Math.max.apply(null, captured.map(function(p) { return p.err; })) : null;
    var verdict;
    if (captured.length < positions.length / 2) verdict = 'incomplete';
    else if (avgErr < 5) verdict = 'accurate';
    else if (avgErr < 30) verdict = 'minor-offset';
    else verdict = 'misaligned';

    res.json({
      ok: true,
      captured: captured.length,
      total: positions.length,
      avg_err_px: avgErr,
      max_err_px: maxErr,
      verdict: verdict,
      pairs: pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat(calibration): POST /calibrate/start orchestrator — AI-callable, returns drift summary"
```

---

## Task 6: README + v1.5.0 bump

**Files:**
- Modify: `README.md` — add calibration section under AI Integration
- Modify: `package.json` — bump to v1.5.0
- Modify: `public/cam/index.html` — update version tag

- [ ] **Step 1: README section**

Below the "Phone agent workflow (P3)" section in `README.md`, add:

```markdown
### Click calibration (P3.1)

Before driving the phone, AI agents can verify click accuracy with a single call:

```
POST /calibrate/start
```

Returns:
```
{
  ok: true,
  captured: 9, total: 9,
  avg_err_px: 2.3, max_err_px: 4.1,
  verdict: "accurate",
  pairs: [{target:{px,py}, observed:{x,y}, dx, dy, err}, ...]
}
```

Verdict values:
- `accurate` (avg err < 5px): proceed with replay or exploration normally.
- `minor-offset` (avg err < 30px): proceed but expect occasional tap-target misses on small UI elements; consider re-running calibration if a /waitfor-highlight surfaces.
- `misaligned` (avg err ≥ 30px): stop and call /waitfor-highlight asking the human to check the phone (rotation, screen-mirror lag, ADB density mismatch).
- `incomplete` (< half the reports came back): the calibration page didn't load or the phone is locked; ask human for help.

Call /calibrate/start on first connect, after a screen rotation, or any time `/waitfor-highlight` fires for a click-missed-target reason.
```

- [ ] **Step 2: Version bump**

```bash
sed -i 's/"version": "1.4.0"/"version": "1.5.0"/' package.json
sed -i 's/v1\.4\.0/v1.5.0/g' public/cam/index.html
```

- [ ] **Step 3: Commit**

```bash
git add README.md package.json public/cam/index.html
git commit -m "chore: bump to v1.5.0 — Teaching Mode P3 + calibration suite"
git push origin main
```

---

## Done criteria

- [ ] `GET /calibrate-target` returns 200 with the HTML page
- [ ] `POST /calibrate-target/report` stores reports + broadcasts via SSE
- [ ] `POST /android/open-url` launches Chrome on the phone with the given URL
- [ ] Cam UI "📐 Full calibration (E2E)" button opens page on phone, fires 9 taps, shows live drift
- [ ] `POST /calibrate/start` returns drift summary
- [ ] README has calibration section
- [ ] package.json bumped to 1.5.0
- [ ] Pushed to origin
