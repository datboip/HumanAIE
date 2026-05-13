# HiveDroid Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold HiveDroid (Android-over-ADB control server) into HumanAIE as a second target alongside the headless Chromium browser, with one unified Cam UI and shared spatial-memory (Highlight-to-Teach).

**Architecture:** Single Express process on port 3333. New `android.js` module exports a router that mounts under `/android/*` in `server.js` — conditionally, so the server boots fine without ADB. The existing `/cam/` UI gains a green PHONE tab pinned on the right; clicking it swaps the viewport stream and control bar. Highlights gain a `target` field; Android highlights are keyed by `(package, activity)` instead of `url`.

**Tech Stack:** Node 18+, Express 4, child_process (ADB invocation), Playwright (existing, untouched), vanilla JS/HTML/CSS for the Cam UI, Node's built-in `node:test` for tests (no new npm deps).

**Spec reference:** `docs/superpowers/specs/2026-05-13-hivedroid-integration-design.md`

**Source for ADB code being ported:** `/home/rickburp/Projects/.dormant/hiveclaw/nanoclaw/groups/telegram_main/android-ui/server.js`

---

## File Structure

**Created:**
- `android.js` — top-level ADB wrapper module, exports Express router
- `tests/version.test.js` — smoke test for harness
- `tests/android.test.js` — tests for android module (ADB detection, error fallbacks, input validation)
- `tests/highlights.test.js` — tests for extended highlight schema

**Modified:**
- `server.js` — conditionally require `./android` and mount router under `/android` (~15 line addition near existing route mounts)
- `public/cam/index.html` — green PHONE tab, mode-switch JS, Android control bar, splash state, status polling (additions to existing HTML/CSS/JS)
- `package.json` — add `"test"` script, bump version to `1.2.0`
- `.claude-plugin/plugin.json` — bump version to `1.2.0`
- `README.md` — `/android/*` endpoints documentation, env vars section update

**Untouched:** the entire Playwright browser code path. All existing browser endpoints. The `/cam/` styling and tab handlers for browser tabs.

**Security note:** All UI text is set via `textContent` only (never `innerHTML`). Treat any code that reaches the DOM the same way — even hardcoded strings, to prevent future drift into XSS-prone patterns.

---

## Task 1: Set up minimal test harness

**Files:**
- Modify: `package.json` (add test script)
- Create: `tests/version.test.js`
- Modify: `server.js` (add HUMANAIE_TEST_NO_BROWSER escape hatch + ensure "Listening" log)

- [ ] **Step 1: Read current package.json**

```bash
cat package.json
```

- [ ] **Step 2: Add test script to package.json**

Edit `package.json`, change the `scripts` block from:

```json
"scripts": {
  "start": "node server.js",
  "install-browsers": "npx playwright install chromium"
}
```

To:

```json
"scripts": {
  "start": "node server.js",
  "install-browsers": "npx playwright install chromium",
  "test": "node --test tests/"
}
```

- [ ] **Step 3: Create the tests directory and the smoke test**

Create `tests/version.test.js` with:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('GET /version returns name and version', async (t) => {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13333' },
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
  assert.ok(ready, 'server did not start within 5s');

  const res = await fetch('http://127.0.0.1:13333/version');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.version, 'response should have version field');
});
```

- [ ] **Step 4: Add the test-mode escape hatch to server.js**

Read `server.js`, find where `initBrowser()` is called (search for `initBrowser`). Wrap that call:

```javascript
if (process.env.HUMANAIE_TEST_NO_BROWSER !== '1') {
  initBrowser().catch(err => console.error('[FATAL] initBrowser failed:', err));
}
```

Also ensure `app.listen(...)` logs the word "listening" on stdout. Search for `app.listen`. If the log message doesn't contain "listening" (case-insensitive), edit it so it does, e.g. `console.log('Listening on port', PORT)`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test
```

Expected: `# tests 1 ... # pass 1 ... # fail 0`

- [ ] **Step 6: Commit**

```bash
git add package.json tests/version.test.js server.js
git commit -m "test: minimal node:test harness with /version smoke test"
```

---

## Task 2: ADB detection module

**Files:**
- Create: `android.js`
- Create: `tests/android.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/android.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

test('android module exports ADB_AVAILABLE boolean and adbPath', () => {
  const android = require('../android');
  assert.strictEqual(typeof android.ADB_AVAILABLE, 'boolean');
  if (android.ADB_AVAILABLE) {
    assert.strictEqual(typeof android.adbPath, 'string');
    assert.ok(android.adbPath.length > 0);
  } else {
    assert.strictEqual(android.adbPath, null);
  }
});

test('android module exports an Express router', () => {
  const android = require('../android');
  assert.strictEqual(typeof android.router, 'function');
  assert.ok(Array.isArray(android.router.stack));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="android module"
```

Expected: FAIL with `Cannot find module '../android'`.

- [ ] **Step 3: Implement the minimal android.js**

Create `android.js`:

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

const ADB_SEARCH_PATHS = [
  '/usr/lib/android-sdk/platform-tools/adb',
  '/usr/local/bin/adb',
  '/opt/android-sdk/platform-tools/adb',
  '/workspace/group/android-sdk/platform-tools/adb',
];

function findAdbInPath() {
  try {
    const out = execFileSync('which', ['adb'], { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    const p = out.toString().trim();
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

function findAdb() {
  const fromPath = findAdbInPath();
  if (fromPath) return fromPath;
  for (const p of ADB_SEARCH_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const adbPath = findAdb();
const ADB_AVAILABLE = adbPath !== null;

const PHONE_IP = process.env.HUMANAIE_PHONE_IP || '';
const PHONE_PORT = process.env.HUMANAIE_PHONE_PORT || '5555';
const PHONE_ADDR = PHONE_IP ? `${PHONE_IP}:${PHONE_PORT}` : '';

const router = express.Router();

if (!ADB_AVAILABLE) {
  router.use((req, res) => {
    res.status(503).json({
      error: 'ADB not configured',
      hint: 'Install Android platform-tools (apt install adb on Debian/Ubuntu) and set HUMANAIE_PHONE_IP.',
    });
  });
}

module.exports = { ADB_AVAILABLE, adbPath, router, PHONE_IP, PHONE_PORT, PHONE_ADDR };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- --test-name-pattern="android module"
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add android.js tests/android.test.js
git commit -m "feat: ADB detection module with 503 fallback router"
```

---

## Task 3: Mount android router in server.js

**Files:**
- Modify: `server.js` (add require + app.use after existing static-file mount)
- Modify: `tests/android.test.js` (add integration test)

- [ ] **Step 1: Write the failing test**

Append to `tests/android.test.js`:

```javascript
test('GET /android/screenshot returns 503 when ADB is unavailable', async (t) => {
  const { ADB_AVAILABLE } = require('../android');
  if (ADB_AVAILABLE) { t.skip('ADB present, covered by separate tests'); return; }

  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13334' },
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

  const res = await fetch('http://127.0.0.1:13334/android/screenshot');
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.match(body.error || '', /ADB not configured/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --test-name-pattern="503 when ADB"
```

Expected: FAIL (route not mounted yet).

- [ ] **Step 3: Mount the router in server.js**

Find the line `app.use(express.static(path.join(__dirname, 'public')));` (around line 56). After that line, add:

```javascript
const android = require('./android');
app.use('/android', android.router);
console.log(android.ADB_AVAILABLE
  ? `[android] ADB found at ${android.adbPath}, phone target: ${android.PHONE_ADDR || '(not configured — set HUMANAIE_PHONE_IP)'}`
  : `[android] ADB not found — /android/* will return 503`);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/android.test.js
git commit -m "feat: mount /android router in server.js with availability log"
```

---

## Task 4: Tap, swipe, type, key endpoints

**Files:**
- Modify: `android.js` (replace stub with branching ADB-available logic and four action routes)
- Modify: `tests/android.test.js` (validation test)

- [ ] **Step 1: Restructure android.js to branch on ADB_AVAILABLE**

Replace `android.js` entirely with the following structure. The key change is wrapping ADB-only code in `else { ... }` since CommonJS modules cannot use top-level `return`.

```javascript
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const express = require('express');

const ADB_SEARCH_PATHS = [
  '/usr/lib/android-sdk/platform-tools/adb',
  '/usr/local/bin/adb',
  '/opt/android-sdk/platform-tools/adb',
  '/workspace/group/android-sdk/platform-tools/adb',
];

function findAdbInPath() {
  try {
    const out = execFileSync('which', ['adb'], { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    const p = out.toString().trim();
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

function findAdb() {
  const fromPath = findAdbInPath();
  if (fromPath) return fromPath;
  for (const p of ADB_SEARCH_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const adbPath = findAdb();
const ADB_AVAILABLE = adbPath !== null;

const PHONE_IP = process.env.HUMANAIE_PHONE_IP || '';
const PHONE_PORT = process.env.HUMANAIE_PHONE_PORT || '5555';
const PHONE_ADDR = PHONE_IP ? `${PHONE_IP}:${PHONE_PORT}` : '';

const router = express.Router();
let getForeground = null;
const SERIAL_REF = { current: 'emulator-5554' };

if (!ADB_AVAILABLE) {
  // /android/status still returns a valid response when ADB is missing — the Cam UI relies on it.
  router.get('/status', (req, res) => {
    res.json({ adb_available: false, phone_connected: false, phone_addr: '', battery: null, package: '', activity: '' });
  });
  router.use((req, res) => {
    res.status(503).json({
      error: 'ADB not configured',
      hint: 'Install Android platform-tools (apt install adb on Debian/Ubuntu) and set HUMANAIE_PHONE_IP.',
    });
  });
} else {
  // ── ADB serial auto-detection ───────────────────────────────────────────────
  function detectSerial() {
    try {
      if (PHONE_ADDR) {
        try { execFileSync(adbPath, ['connect', PHONE_ADDR], { timeout: 3000 }); } catch {}
      }
      const out = execFileSync(adbPath, ['devices'], { timeout: 3000 }).toString();
      const lines = out.split('\n').slice(1).map(l => l.trim()).filter(l => l.endsWith('\tdevice'));
      if (!lines.length) return 'emulator-5554';
      const real = lines.find(l => !l.startsWith('emulator-'));
      return (real || lines[0]).split('\t')[0];
    } catch { return 'emulator-5554'; }
  }

  SERIAL_REF.current = detectSerial();
  console.log(`[android] serial: ${SERIAL_REF.current}`);
  setInterval(() => {
    const s = detectSerial();
    if (s !== SERIAL_REF.current) {
      console.log(`[android] device switched: ${SERIAL_REF.current} → ${s}`);
      SERIAL_REF.current = s;
    }
  }, 5000);

  function adbAsync(...args) {
    return new Promise((resolve, reject) => {
      execFile(adbPath, ['-s', SERIAL_REF.current, ...args],
        { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(stdout));
    });
  }

  // ── Routes: tap, swipe, type, key ──────────────────────────────────────────
  router.post('/tap', async (req, res) => {
    const { x, y } = req.body || {};
    if (x == null || y == null) return res.status(400).json({ error: 'x,y required' });
    try {
      await adbAsync('shell', `input tap ${Math.round(x)} ${Math.round(y)}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/swipe', async (req, res) => {
    const { x1, y1, x2, y2, dur = 300 } = req.body || {};
    if (x1 == null || y1 == null || x2 == null || y2 == null) {
      return res.status(400).json({ error: 'x1,y1,x2,y2 required' });
    }
    try {
      await adbAsync('shell',
        `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${dur}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/type', async (req, res) => {
    const { text } = req.body || {};
    if (text == null || text === '') return res.status(400).json({ error: 'text required' });
    const safe = String(text).replace(/(['"\\();<>&| ])/g, '\\$1');
    try {
      await adbAsync('shell', `input text ${safe}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/key', async (req, res) => {
    const { keycode } = req.body || {};
    if (!keycode) return res.status(400).json({ error: 'keycode required' });
    try {
      await adbAsync('shell', `input keyevent ${keycode}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // (Subsequent tasks add frame loop, /screenshot, /stream, /status, /info, /ui-dump, /shell, /launch, /install, /push, /pull, /record here.)

  // Export helpers used by later tasks
  module.exports.adbAsync = adbAsync;
}

module.exports.ADB_AVAILABLE = ADB_AVAILABLE;
module.exports.adbPath = adbPath;
module.exports.router = router;
module.exports.PHONE_IP = PHONE_IP;
module.exports.PHONE_PORT = PHONE_PORT;
module.exports.PHONE_ADDR = PHONE_ADDR;
module.exports.SERIAL = () => SERIAL_REF.current;
module.exports.getForeground = () => getForeground;
```

- [ ] **Step 2: Add a validation test for /android/tap**

Append to `tests/android.test.js`:

```javascript
test('POST /android/tap returns 400 on missing coords (when ADB available)', async (t) => {
  const { ADB_AVAILABLE } = require('../android');
  if (!ADB_AVAILABLE) { t.skip('Validation only runs with ADB available; 503 covered by separate test'); return; }

  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13335' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot timeout')), 5000);
    proc.stdout.on('data', (c) => {
      if (c.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(); }
    });
  });

  const res = await fetch('http://127.0.0.1:13335/android/tap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all pass (validation test skips on no-ADB machines, which is fine).

- [ ] **Step 4: Manual smoke test (only with ADB + phone paired)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s -X POST localhost:3333/android/tap -H 'content-type: application/json' -d '{"x":540,"y":1200}'
# Expected: {"ok":true}
kill $SERVER_PID
```

- [ ] **Step 5: Commit**

```bash
git add android.js tests/android.test.js
git commit -m "feat: /android/{tap,swipe,type,key} endpoints"
```

---

## Task 5: Frame capture loop + /android/screenshot

**Files:**
- Modify: `android.js` (add capture loop + screenshot route inside the ADB-available branch)

- [ ] **Step 1: Add frame cache, capture loop, and screenshot route**

Inside `android.js`, inside the `else { ... }` block (ADB-available branch), **before** the existing route handlers, add:

```javascript
// ── Frame cache — background screencap loop, shared by /screenshot and /stream ─
let frameCache = null;
const MJPEG_CLIENTS = new Set();
const BOUNDARY = 'frame';

function pushFrame(buf) {
  if (!buf || buf.length < 1000) return;
  frameCache = buf;
  const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
  for (const client of MJPEG_CLIENTS) {
    try { client.write(header); client.write(buf); client.write('\r\n'); }
    catch { MJPEG_CLIENTS.delete(client); }
  }
}

(async function captureLoop() {
  while (true) {
    try {
      const buf = execFileSync(adbPath, ['-s', SERIAL_REF.current, 'exec-out', 'screencap', '-p'],
        { timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
      if (buf && buf.length > 1000) pushFrame(buf);
    } catch { /* phone offline, emulator rebooting, etc. */ }
    await new Promise(r => setTimeout(r, 80)); // ~12fps
  }
})();
```

Then add the route, placed after the `/key` route:

```javascript
router.get('/screenshot', (req, res) => {
  if (!frameCache) return res.status(503).json({ error: 'No frame yet — phone may be offline' });
  const isJpeg = frameCache[0] === 0xFF && frameCache[1] === 0xD8;
  res.set('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
  res.set('Cache-Control', 'no-cache');
  res.send(frameCache);
});
```

- [ ] **Step 2: Manual smoke test (ADB + phone)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 3
curl -s -o /tmp/phone.png localhost:3333/android/screenshot
file /tmp/phone.png  # expect: PNG image data
kill $SERVER_PID
```

- [ ] **Step 3: No-ADB regression check**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s -w "%{http_code}\n" localhost:3333/android/screenshot
# Expected: 503
kill $SERVER_PID
```

- [ ] **Step 4: Commit**

```bash
git add android.js
git commit -m "feat: /android/screenshot with background screencap loop"
```

---

## Task 6: /android/stream MJPEG endpoint

**Files:**
- Modify: `android.js`
- Modify: `server.js` (auth bypass for /android/stream)

- [ ] **Step 1: Add stream route to android.js**

Inside the ADB-available branch, after the `/screenshot` route:

```javascript
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': `multipart/x-mixed-replace;boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  MJPEG_CLIENTS.add(res);
  if (frameCache) {
    const isJpeg = frameCache[0] === 0xFF && frameCache[1] === 0xD8;
    const ct = isJpeg ? 'image/jpeg' : 'image/png';
    const header = `--${BOUNDARY}\r\nContent-Type: ${ct}\r\nContent-Length: ${frameCache.length}\r\n\r\n`;
    res.write(header); res.write(frameCache); res.write('\r\n');
  }
  req.on('close', () => MJPEG_CLIENTS.delete(res));
});
```

- [ ] **Step 2: Add `/android/stream` to the auth-bypass list in server.js**

Find the auth middleware (around line 39–54). The current bypass logic includes `/events` and `/stream`. Add `/android/stream`:

```javascript
if (isLocal || req.path === '/events' || req.path === '/stream' || req.path === '/android/stream' || isMedia) return next();
```

- [ ] **Step 3: Manual smoke test (ADB + phone)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 3
timeout 3 curl -s -N localhost:3333/android/stream | head -c 200 | xxd | head -5
# Expected: --frame boundary visible plus FFD8 JPEG header bytes
kill $SERVER_PID
```

- [ ] **Step 4: Commit**

```bash
git add android.js server.js
git commit -m "feat: /android/stream MJPEG endpoint with auth bypass"
```

---

## Task 7: /android/info, /status, /ui-dump endpoints

**Files:**
- Modify: `android.js`

- [ ] **Step 1: Add the device-info endpoints**

Inside the ADB-available branch, after the `/stream` route. First, define the foreground helper:

```javascript
async function detectForeground() {
  try {
    const out = (await adbAsync('shell',
      "dumpsys activity activities | grep -E 'mResumedActivity|mCurrentFocus'")).toString();
    const m = out.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
    return m ? { package: m[1], activity: m[2] } : { package: '', activity: '' };
  } catch { return { package: '', activity: '' }; }
}
getForeground = detectForeground; // store on outer-scope variable so module.exports.getForeground works
```

Then add the routes:

```javascript
router.get('/info', async (req, res) => {
  try {
    const [model, release, serialOut] = await Promise.all([
      adbAsync('shell', 'getprop ro.product.model').then(b => b.toString().trim()),
      adbAsync('shell', 'getprop ro.build.version.release').then(b => b.toString().trim()),
      adbAsync('get-serialno').then(b => b.toString().trim()).catch(() => SERIAL_REF.current),
    ]);
    res.json({ model, android_version: release, serial: serialOut, phone_addr: PHONE_ADDR });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

router.get('/ui-dump', async (req, res) => {
  try {
    await adbAsync('shell', 'uiautomator dump /sdcard/window_dump.xml');
    const xml = await adbAsync('shell', 'cat /sdcard/window_dump.xml');
    res.set('Content-Type', 'application/xml');
    res.send(xml.toString());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Manual smoke test (ADB + phone)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 3
curl -s localhost:3333/android/status | python3 -m json.tool
# Expected: {"adb_available": true, "phone_connected": true, "package": "...", "activity": "...", ...}
curl -s localhost:3333/android/info | python3 -m json.tool
kill $SERVER_PID
```

- [ ] **Step 3: No-ADB regression check**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s localhost:3333/android/status | python3 -m json.tool
# Expected: {"adb_available": false, "phone_connected": false, ...}
curl -s -w "%{http_code}\n" localhost:3333/android/info
# Expected: 503
kill $SERVER_PID
```

- [ ] **Step 4: Commit**

```bash
git add android.js
git commit -m "feat: /android/{info,status,ui-dump} endpoints"
```

---

## Task 8: shell, launch, install, push, pull, record endpoints

**Files:**
- Modify: `android.js`

- [ ] **Step 1: Add the remaining endpoints**

Inside the ADB-available branch, after the `/ui-dump` route. First a helper for `execFile` (since `adbAsync` always prepends `-s SERIAL`, but `screenrecord` needs a different invocation):

```javascript
function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts || {}, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}
```

Then the routes:

```javascript
router.post('/shell', async (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  try {
    const out = await adbAsync('shell', cmd);
    res.json({ ok: true, output: out.toString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/launch', async (req, res) => {
  const { pkg } = req.body || {};
  if (!pkg) return res.status(400).json({ error: 'pkg required' });
  try {
    await adbAsync('shell', `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/install', async (req, res) => {
  const { apkPath } = req.body || {};
  if (!apkPath) return res.status(400).json({ error: 'apkPath required' });
  if (!fs.existsSync(apkPath)) return res.status(400).json({ error: 'APK file not found' });
  try {
    await adbAsync('install', '-r', apkPath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push', async (req, res) => {
  const { local, remote } = req.body || {};
  if (!local || !remote) return res.status(400).json({ error: 'local,remote required' });
  try {
    await adbAsync('push', local, remote);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pull', async (req, res) => {
  const { remote, local } = req.body || {};
  if (!remote || !local) return res.status(400).json({ error: 'remote,local required' });
  try {
    await adbAsync('pull', remote, local);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/record', async (req, res) => {
  const seconds = Math.max(1, Math.min(180, (req.body && req.body.seconds) || 30));
  const sessionsDir = path.join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'humanaie-sessions');
  try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch {}
  const id = `android-${Date.now()}`;
  const remotePath = `/sdcard/${id}.mp4`;
  const localPath = path.join(sessionsDir, `${id}.mp4`);
  try {
    await execFileAsync(adbPath,
      ['-s', SERIAL_REF.current, 'shell', `screenrecord --time-limit ${seconds} ${remotePath}`],
      { timeout: (seconds + 10) * 1000, maxBuffer: 1024 * 1024 });
    await adbAsync('pull', remotePath, localPath);
    await adbAsync('shell', `rm ${remotePath}`).catch(() => {});
    res.json({ ok: true, path: localPath, id, target: 'android' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Manual smoke test for `/launch` (ADB + phone)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s -X POST localhost:3333/android/launch \
  -H 'content-type: application/json' \
  -d '{"pkg":"com.android.settings"}'
# Expected: {"ok":true}, Settings app opens on phone
kill $SERVER_PID
```

- [ ] **Step 3: Validation test (no body)**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s -X POST localhost:3333/android/launch -H 'content-type: application/json' -d '{}'
# With ADB: {"error":"pkg required"} status 400
# Without ADB: {"error":"ADB not configured",...} status 503
kill $SERVER_PID
```

- [ ] **Step 4: Commit**

```bash
git add android.js
git commit -m "feat: /android/{shell,launch,install,push,pull,record} endpoints"
```

---

## Task 9: Highlight schema extension — add `target` field

**Files:**
- Modify: `server.js` (the `/highlight` POST handler around line 793)
- Create: `tests/highlights.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/highlights.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function bootServer(port, extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanaie-test-'));
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: String(port), HUMANAIE_DATA_DIR: tmpDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot timeout')), 5000);
    proc.stdout.on('data', (c) => {
      if (c.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', code => reject(new Error(`server exited ${code} before ready`)));
  });
  return { proc, tmpDir };
}

test('POST /highlight saves entry with target=browser by default', async (t) => {
  const { proc, tmpDir } = await bootServer(13340);
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  const res = await fetch('http://127.0.0.1:13340/highlight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 100, y: 200, label: 'Login' }),
  });
  assert.strictEqual(res.status, 200);

  const logPath = path.join(tmpDir, 'highlight-history.jsonl');
  const line = fs.readFileSync(logPath, 'utf-8').trim().split('\n').pop();
  const entry = JSON.parse(line);
  assert.strictEqual(entry.target, 'browser');
  assert.strictEqual(entry.x, 100);
  assert.strictEqual(entry.label, 'Login');
});

test('POST /highlight with target=android saves android entry', async (t) => {
  const { proc, tmpDir } = await bootServer(13341);
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  const res = await fetch('http://127.0.0.1:13341/highlight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 540, y: 1200, label: 'Send', target: 'android', package: 'com.whatsapp', activity: '.HomeActivity' }),
  });
  assert.strictEqual(res.status, 200);

  const logPath = path.join(tmpDir, 'highlight-history.jsonl');
  const line = fs.readFileSync(logPath, 'utf-8').trim().split('\n').pop();
  const entry = JSON.parse(line);
  assert.strictEqual(entry.target, 'android');
  assert.strictEqual(entry.package, 'com.whatsapp');
  assert.strictEqual(entry.activity, '.HomeActivity');
  assert.strictEqual(entry.url, undefined);
});

module.exports = { bootServer };
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="POST /highlight"
```

Expected: FAIL — `target` field is `undefined` on current entries.

- [ ] **Step 3: Modify the `/highlight` handler in server.js**

Find `app.post('/highlight', ...)` (around line 793). Replace the entire handler body with:

```javascript
app.post('/highlight', (req, res) => {
  const { x, y, label, target, package: pkg, activity } = req.body || {};
  const t = target === 'android' ? 'android' : 'browser';
  const entry = { x, y, label: label || '', time: new Date().toISOString(), target: t };
  highlights.push(entry);
  try {
    const logEntry = { ...entry, timestamp: new Date().toISOString() };
    if (t === 'android') {
      logEntry.package = pkg || '';
      logEntry.activity = activity || '';
    } else {
      logEntry.url = page ? page.url() : '';
    }
    const logPath = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'highlight-history.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch(e) {}
  if (highlights.length > 20) highlights.shift();
  res.json({ success: true, highlights });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- --test-name-pattern="POST /highlight"
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/highlights.test.js
git commit -m "feat: highlights gain target field (browser|android)"
```

---

## Task 10: /highlight-history target-aware query

**Files:**
- Modify: `server.js` (the `/highlight-history` GET handler around line 808)
- Modify: `tests/highlights.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/highlights.test.js`:

```javascript
test('GET /highlight-history?package= returns only android entries for that app', async (t) => {
  const { bootServer } = require('./highlights.test'); // self-reference for the helper
  const { proc, tmpDir } = await bootServer(13342);
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  await fetch('http://127.0.0.1:13342/highlight', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ x:1, y:1, label:'b', target:'browser' }) });
  await fetch('http://127.0.0.1:13342/highlight', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ x:2, y:2, label:'a1', target:'android', package:'com.whatsapp', activity:'.X' }) });
  await fetch('http://127.0.0.1:13342/highlight', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ x:3, y:3, label:'a2', target:'android', package:'com.telegram', activity:'.Y' }) });

  const res = await fetch('http://127.0.0.1:13342/highlight-history?package=com.whatsapp');
  const body = await res.json();
  assert.strictEqual(body.history.length, 1);
  assert.strictEqual(body.history[0].package, 'com.whatsapp');
});

test('GET /highlight-history?target=android returns only android entries', async (t) => {
  const { bootServer } = require('./highlights.test');
  const { proc, tmpDir } = await bootServer(13343);
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  await fetch('http://127.0.0.1:13343/highlight', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ x:1, y:1, label:'b', target:'browser' }) });
  await fetch('http://127.0.0.1:13343/highlight', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ x:2, y:2, label:'a', target:'android', package:'com.x' }) });

  const res = await fetch('http://127.0.0.1:13343/highlight-history?target=android');
  const body = await res.json();
  assert.strictEqual(body.history.length, 1);
  assert.strictEqual(body.history[0].target, 'android');
});

test('legacy entries without target field default to browser when filtering', async (t) => {
  const { bootServer } = require('./highlights.test');
  const { proc, tmpDir } = await bootServer(13344);
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });

  const logPath = path.join(tmpDir, 'highlight-history.jsonl');
  fs.writeFileSync(logPath,
    JSON.stringify({ x:1, y:1, label:'legacy', url:'https://example.com', timestamp:'2024-01-01T00:00:00Z' }) + '\n');

  const res = await fetch('http://127.0.0.1:13344/highlight-history?target=browser');
  const body = await res.json();
  assert.strictEqual(body.history.length, 1);
  assert.strictEqual(body.history[0].label, 'legacy');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="highlight-history"
```

Expected: FAIL — current handler doesn't filter by package/activity/target.

- [ ] **Step 3: Modify the `/highlight-history` handler in server.js**

Find `app.get('/highlight-history', ...)` (around line 808). Replace its body with:

```javascript
app.get('/highlight-history', (req, res) => {
  try {
    const logPath = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'highlight-history.jsonl');
    if (!fs.existsSync(logPath)) return res.json({ history: [] });
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Backwards-compat: entries without `target` are browser entries.
    entries = entries.map(e => ({ target: e.target || 'browser', ...e }));

    const url = req.query.url || null;
    const q = req.query.q || null;
    const pkg = req.query.package || null;
    const activity = req.query.activity || null;
    const target = req.query.target || null;

    if (target) entries = entries.filter(e => e.target === target);
    if (url) entries = entries.filter(e => e.url && e.url.includes(url));
    if (pkg) entries = entries.filter(e => e.package === pkg);
    if (activity) entries = entries.filter(e => e.activity === activity);
    if (q) entries = entries.filter(e =>
      (e.label || '').toLowerCase().includes(q.toLowerCase()) ||
      (e.url || '').toLowerCase().includes(q.toLowerCase()) ||
      (e.package || '').toLowerCase().includes(q.toLowerCase())
    );

    const byUrl = {};
    const byPackage = {};
    entries.forEach(e => {
      if (e.target === 'android' && e.package) {
        if (!byPackage[e.package]) byPackage[e.package] = [];
        byPackage[e.package].push({ x: e.x, y: e.y, label: e.label, activity: e.activity, time: e.timestamp || e.time });
      } else if (e.url) {
        const domain = (() => { try { return new URL(e.url).hostname; } catch { return 'unknown'; } })();
        if (!byUrl[domain]) byUrl[domain] = [];
        byUrl[domain].push({ x: e.x, y: e.y, label: e.label, url: e.url, time: e.timestamp || e.time });
      }
    });

    res.json({ history: entries.slice(-50), byUrl, byPackage, total: entries.length });
  } catch(e) { res.json({ history: [], error: e.message }); }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- --test-name-pattern="highlight-history"
```

Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/highlights.test.js
git commit -m "feat: /highlight-history supports target/package/activity filters"
```

---

## Task 11: Cam UI — green PHONE tab + mode switch

**Files:**
- Modify: `public/cam/index.html`

This task changes HTML/CSS/JS in the existing single-file Cam UI (~1956 lines). Changes are localized.

- [ ] **Step 1: Identify the tab strip container**

Open `public/cam/index.html`. Search for the JavaScript that renders tabs (around lines 987–1027). Note:
- The DOM element that contains the rendered tabs (likely `id="tabs-container"` or a class). Search for `getElementById('tabs` or `querySelector('.tabs`.
- The `<img>` element whose `src` is `/stream` (the viewport image). Note its ID/class.

Write down both for use in subsequent steps. (If you cannot identify them, search `/stream"` and the tab append loop respectively.)

- [ ] **Step 2: Add the PHONE tab markup**

Locate the HTML for the tab strip (the parent of the dynamically-added browser tabs). Add the PHONE tab inside that parent, **after** any existing static tab placeholders:

```html
<!-- Pinned green PHONE tab — always present, can't close. Switches Cam UI to Android mode. -->
<div id="phone-tab" class="tab phone-tab" title="Android phone view">
  <span class="tab-title">📱 PHONE</span>
  <span id="phone-tab-indicator" class="phone-tab-indicator" data-state="unknown"></span>
</div>
```

Then wire up the click handler in the script block (so the click is bound after DOM is ready):

```javascript
document.getElementById('phone-tab').addEventListener('click', switchToAndroidMode);
```

- [ ] **Step 3: Add the PHONE tab CSS**

In the `<style>` block (find the existing `.tab` rule around line 135), append:

```css
.tab.phone-tab {
  background: #00aa44;
  color: #fff;
  border-color: #006622;
  margin-left: auto;
  font-weight: bold;
  cursor: pointer;
}
.tab.phone-tab:hover { background: #00cc55; }
.tab.phone-tab.active { background: #00ff66; color: #000; }
.phone-tab-indicator {
  display: inline-block;
  width: 8px; height: 8px; border-radius: 50%;
  margin-left: 6px;
  background: #888;
}
.phone-tab-indicator[data-state="connected"] { background: #0f0; }
.phone-tab-indicator[data-state="disconnected"] { background: #f00; }
.phone-tab-indicator[data-state="no-adb"]      { background: #888; }
```

Find the tab-strip container's CSS (the parent of `.tab` elements) and ensure it has `display: flex;`. If not, change it (otherwise `margin-left: auto` won't push the tab right).

- [ ] **Step 4: Add the mode-switch JavaScript**

In the script block (place this after existing tab handlers — search for `switchTab` or similar to find a good location):

```javascript
let androidMode = false;
const VIEWPORT_SELECTOR = '#stream-img'; // replace with the actual ID/class from Step 1

function switchToAndroidMode() {
  androidMode = true;
  document.getElementById('phone-tab').classList.add('active');
  document.querySelectorAll('.tab:not(.phone-tab).active').forEach(el => el.classList.remove('active'));
  const viewport = document.querySelector(VIEWPORT_SELECTOR);
  if (viewport) viewport.src = '/android/stream?t=' + Date.now();
  const urlBar = document.getElementById('url-bar') || document.querySelector('.url-bar');
  if (urlBar) urlBar.style.display = 'none';
  const ac = document.getElementById('android-controls');
  if (ac) ac.style.display = '';
  if (typeof refreshAndroidStatus === 'function') refreshAndroidStatus();
}

function switchToBrowserMode() {
  androidMode = false;
  document.getElementById('phone-tab').classList.remove('active');
  const viewport = document.querySelector(VIEWPORT_SELECTOR);
  if (viewport) viewport.src = '/stream?t=' + Date.now();
  const urlBar = document.getElementById('url-bar') || document.querySelector('.url-bar');
  if (urlBar) urlBar.style.display = '';
  const ac = document.getElementById('android-controls');
  if (ac) ac.style.display = 'none';
}
```

Replace `#stream-img` with the actual selector you noted in Step 1.

- [ ] **Step 5: Hook browser-tab clicks to flip back to browser mode**

Find the existing function that handles a click on a browser tab (search for `switchTab`, `tabs/switch`, or look at the click handler attached in the tab-render loop around line 1027). At the top of that handler, add:

```javascript
if (androidMode) switchToBrowserMode();
```

- [ ] **Step 6: Manual smoke test**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
# Open http://localhost:3333/cam/ in a real browser.
# Verify: green 📱 PHONE tab visible on the far right of the tab strip.
# Click it: viewport <img> src changes to /android/stream?t=...
# Click any regular tab: viewport src changes back to /stream?t=...
kill $SERVER_PID
```

- [ ] **Step 7: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: green PHONE tab on Cam UI with mode-switch"
```

---

## Task 12: Cam UI — Android control bar + splash state + status polling

**Files:**
- Modify: `public/cam/index.html`

- [ ] **Step 1: Add the Android control bar HTML**

In the body, **after** the existing URL bar div (`id="url-bar"` or similar), add:

```html
<div id="android-controls" style="display:none; padding:4px 8px; background:#c0c0c0; border-bottom:1px solid #808080;">
  <button id="ac-back" title="Back">◀</button>
  <button id="ac-home" title="Home">●</button>
  <button id="ac-recent" title="Recent apps">▢</button>
  <span style="margin:0 12px;">|</span>
  <select id="android-app-launcher">
    <option value="">App ▾</option>
    <option value="com.android.settings">Settings</option>
    <option value="com.android.chrome">Chrome</option>
    <option value="com.whatsapp">WhatsApp</option>
  </select>
  <button id="ac-reconnect" title="Reconnect">⟳</button>
  <span id="android-status-text" style="margin-left:12px; font-size:11px; color:#444;">—</span>
</div>
```

- [ ] **Step 2: Add the splash overlay HTML**

After the viewport container (the wrapper around the streaming `<img>`), add:

```html
<div id="android-splash" style="display:none; position:absolute; inset:0; background:rgba(192,192,192,0.95);
     align-items:center; justify-content:center; flex-direction:column; text-align:center;
     font-family: 'Times New Roman', serif; z-index:10;">
  <div style="border:2px solid #808080; background:#fff; padding:24px 32px; max-width:360px;">
    <div style="font-size:48px;">📱</div>
    <h2 id="android-splash-title" style="margin:8px 0; color:#000080;">NO PHONE</h2>
    <p id="android-splash-body" style="font-size:13px; color:#333;">Phone not paired yet.</p>
    <button id="splash-reconnect" style="margin-top:12px; padding:4px 16px;">RECONNECT</button>
  </div>
</div>
```

Ensure the viewport's wrapper has `position: relative;` so the splash's absolute positioning covers it.

- [ ] **Step 3: Add the JS for controls, polling, and splash**

In the script block:

```javascript
let androidStatus = { adb_available: false, phone_connected: false };
let androidStatusTimer = null;

async function androidKey(keycode) {
  try {
    await fetch('/android/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keycode }),
    });
  } catch (e) { console.warn('android key failed', e); }
}

async function launchAndroidApp(pkg) {
  if (!pkg) return;
  try {
    await fetch('/android/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pkg }),
    });
  } catch (e) { console.warn('android launch failed', e); }
  const sel = document.getElementById('android-app-launcher');
  if (sel) sel.value = '';
}

async function refreshAndroidStatus() {
  try {
    const r = await fetch('/android/status');
    androidStatus = await r.json();
  } catch { androidStatus = { adb_available: false, phone_connected: false }; }

  const ind = document.getElementById('phone-tab-indicator');
  if (ind) {
    if (!androidStatus.adb_available) ind.dataset.state = 'no-adb';
    else if (androidStatus.phone_connected) ind.dataset.state = 'connected';
    else ind.dataset.state = 'disconnected';
  }

  const splash = document.getElementById('android-splash');
  if (splash) {
    if (androidMode && !androidStatus.phone_connected) {
      splash.style.display = 'flex';
      const title = document.getElementById('android-splash-title');
      const body = document.getElementById('android-splash-body');
      // Use textContent only — no innerHTML to avoid XSS surface.
      if (!androidStatus.adb_available) {
        if (title) title.textContent = 'NO ADB';
        if (body) body.textContent = 'ADB is not installed on the server. Install with: apt install adb';
      } else {
        if (title) title.textContent = 'NO PHONE';
        if (body) body.textContent = 'Phone not paired. Set HUMANAIE_PHONE_IP and restart, or check WiFi ADB.';
      }
    } else {
      splash.style.display = 'none';
    }
  }

  const txt = document.getElementById('android-status-text');
  if (txt) {
    if (!androidStatus.adb_available) txt.textContent = 'ADB not installed';
    else if (!androidStatus.phone_connected) txt.textContent = 'Phone offline';
    else {
      const batt = androidStatus.battery == null ? '?' : androidStatus.battery + '%';
      txt.textContent = (androidStatus.package || '?') + ' — battery ' + batt;
    }
  }
}

// Wire up event listeners (after DOM is ready — place near the end of the script block)
document.getElementById('ac-back').addEventListener('click', () => androidKey('KEYCODE_BACK'));
document.getElementById('ac-home').addEventListener('click', () => androidKey('KEYCODE_HOME'));
document.getElementById('ac-recent').addEventListener('click', () => androidKey('KEYCODE_APP_SWITCH'));
document.getElementById('ac-reconnect').addEventListener('click', refreshAndroidStatus);
document.getElementById('splash-reconnect').addEventListener('click', refreshAndroidStatus);
document.getElementById('android-app-launcher').addEventListener('change', (e) => launchAndroidApp(e.target.value));

androidStatusTimer = setInterval(refreshAndroidStatus, 5000);
refreshAndroidStatus();
```

- [ ] **Step 4: Wire highlight saves to include target+package+activity in Android mode**

Search the script block for the existing function that handles saving a highlight (look for `fetch('/highlight'` POST). Locate where the request body is built. Replace the body assembly with:

```javascript
const body = androidMode
  ? { x, y, label, target: 'android', package: androidStatus.package || '', activity: androidStatus.activity || '' }
  : { x, y, label };
fetch('/highlight', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
```

(Keep variable names — `x`, `y`, `label` — matching whatever the existing function uses.)

- [ ] **Step 5: Manual smoke test**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
# Open http://localhost:3333/cam/ in a real browser.
# - Indicator dot on PHONE tab: gray (no-adb) or red (disconnected), depending on machine.
# - Click PHONE tab → splash appears with appropriate message.
# - Click RECONNECT → status refreshes.
# - Click back to a browser tab → splash hides, URL bar reappears.
kill $SERVER_PID
```

- [ ] **Step 6: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: Android control bar, splash state, status polling"
```

---

## Task 13: README, version bumps, manual end-to-end pass

**Files:**
- Modify: `README.md`
- Modify: `package.json` (version bump)
- Modify: `.claude-plugin/plugin.json` (version bump)

- [ ] **Step 1: Add an Android section to README**

In `README.md`, after the existing `### Other` API table near the bottom, add:

```markdown
### Android (HiveDroid)

Android endpoints are mounted when ADB is available on the server. Set `HUMANAIE_PHONE_IP` to your phone's WiFi-ADB address.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/android/screenshot` | -- | Current phone screen as PNG/JPEG |
| GET | `/android/stream` | -- | MJPEG stream |
| GET | `/android/status` | -- | `{adb_available, phone_connected, package, activity, battery}` |
| GET | `/android/info` | -- | Device model, Android version, serial |
| GET | `/android/ui-dump` | -- | `uiautomator` XML dump |
| POST | `/android/tap` | `{x, y}` | Tap at coordinates |
| POST | `/android/swipe` | `{x1, y1, x2, y2, dur}` | Swipe gesture |
| POST | `/android/type` | `{text}` | Type text |
| POST | `/android/key` | `{keycode}` | Key event (KEYCODE_HOME, KEYCODE_BACK, etc.) |
| POST | `/android/shell` | `{cmd}` | Arbitrary `adb shell` command |
| POST | `/android/launch` | `{pkg}` | Launch app by package name |
| POST | `/android/install` | `{apkPath}` | Install APK from local path |
| POST | `/android/push` | `{local, remote}` | Push file to device |
| POST | `/android/pull` | `{remote, local}` | Pull file from device |
| POST | `/android/record` | `{seconds}` | Record screen, returns MP4 path |
```

In the "Environment Variables" section table, add two rows:

```markdown
| `HUMANAIE_PHONE_IP` | (empty) | Android phone IP for WiFi ADB (e.g., `192.168.1.42`) |
| `HUMANAIE_PHONE_PORT` | `5555` | Port for WiFi ADB |
```

In "Features" (or wherever the streaming list lives), add a one-liner: `- Android phone via the PHONE tab on the Cam UI (requires adb + WiFi pairing)`.

- [ ] **Step 2: Bump versions**

```bash
# In package.json
"version": "1.1.0"  →  "version": "1.2.0"
# In .claude-plugin/plugin.json
"version": "1.1.0"  →  "version": "1.2.0"
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: all tests PASS (some skip on no-ADB machines, that's fine).

- [ ] **Step 4: Manual end-to-end smoke test**

```bash
HUMANAIE_TEST_NO_BROWSER=1 node server.js &
SERVER_PID=$!
sleep 2
curl -s localhost:3333/version | python3 -m json.tool
# Expected: version 1.2.0
curl -s localhost:3333/android/status | python3 -m json.tool
# Expected: matches machine state (adb_available, phone_connected)
curl -s -w "\nstatus: %{http_code}\n" -X POST localhost:3333/android/tap \
  -H 'content-type: application/json' -d '{"x":1,"y":1}'
# Expected: 503 (no ADB) OR 500 (ADB but no phone) OR 200 (full)
kill $SERVER_PID
```

If ADB + phone are set up:

```bash
HUMANAIE_PHONE_IP=<your phone IP> node server.js
# Open localhost:3333/cam/, click PHONE tab, verify stream + tap + highlight save.
```

- [ ] **Step 5: Commit everything**

```bash
git add README.md package.json .claude-plugin/plugin.json
git commit -m "docs: README + version bump to 1.2.0 for HiveDroid integration"
```

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Self-review

After completing all tasks, verify:

1. **Spec coverage:** Every section of `docs/superpowers/specs/2026-05-13-hivedroid-integration-design.md` has at least one task covering it. The "Open questions" section is deferred to implementer judgment per the spec.
2. **No regressions:** Existing browser endpoints work unchanged (`/click`, `/navigate`, `/screenshot`, `/cam/`, etc.).
3. **No new npm dependencies:** `package.json` deps unchanged from `1.1.0`.
4. **Both manifests bumped to 1.2.0:** `package.json` AND `.claude-plugin/plugin.json`.
5. **Cam UI works without ADB:** PHONE tab shows splash; all browser-side functions normally.
6. **No `innerHTML` writes in UI code:** every text update uses `textContent`.
