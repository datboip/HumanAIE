# Teaching Mode P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-capture every `/android/*` dispatch into a teaching-session with screenshots, surface those sessions in a new "🎓 Teach" tab where the human reviews stuck points and annotates steps, then promote good sessions to durable workflows saved to disk.

**Architecture:** Three layers wired through a new `teach.js` module. Capture layer hooks `/android/{tap,swipe,key,type}` to append steps with screenshots to a single in-flight session. Workflow layer promotes finalized sessions to per-app JSON files. UI layer adds a `🎓 Teach` tab with a two-column landing (sessions ↔ saved workflows) and a horizontal step-card editor for annotation. `/waitfor-highlight` integration converts the AI's "ask for help" calls into stuck-point markers in the session.

**Tech Stack:** Node.js + Express (existing `server.js`, `android.js`), new `teach.js` module, `node:test` framework, `fs.promises` for disk I/O, vanilla JS in `public/cam/index.html`. No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-05-19-teaching-mode-p1-design.md`](../specs/2026-05-19-teaching-mode-p1-design.md)

---

## File Structure

| File | Role | Disposition |
|---|---|---|
| `teach.js` | New module: TeachingSession primitives, in-flight session state, disk I/O, promote-to-workflow, Express router for `/teach/*` and `/workflows/*` | **Create** |
| `tests/teach.test.js` | Unit tests for session primitives + smoke tests for endpoints | **Create** |
| `android.js` | Hook `captureStep` calls into existing `/tap`, `/swipe`, `/key`, `/type` handlers | **Modify** |
| `server.js` | Mount `teach.js` router; extend `pruneOldSessions` to prune `teach-*` drafts older than 7 days; integrate `/waitfor-highlight` with teach session | **Modify** |
| `public/cam/index.html` | Add `🎓 Teach` tab, mode-switch logic, landing view, step-card editor, annotation overlay, save-as-workflow flow | **Modify** |
| `.gitignore` | Add `workflows/` | **Modify** |

No new external dependencies. New on-disk artifacts:

- `humanaie-sessions/teach-<unix-ms>/{meta.json, steps.jsonl, step-NNNN.jpg}`
- `workflows/<pkg-slug>/<activity-slug>/<name-slug>/{workflow.json, step-NNNN.jpg}`

---

## Task Order Rationale

1. **Pure primitives first** (Task 1) — `TeachingSession` object with no I/O. Easiest to unit-test, no integration cost. Locks the data shape.
2. **Disk persistence** (Task 2) — once the primitives are stable, give them somewhere to live.
3. **In-flight session manager** (Task 3) — module-level singleton with idle timer.
4. **/teach router** (Task 4) — read-only and lifecycle endpoints, verifiable via curl.
5. **Dispatch hook** (Task 5) — modify the 4 existing `/android/*` handlers to call `captureStep`. After this, real sessions are being recorded.
6. **/waitfor-highlight stuck-point** (Task 6) — server.js's waitfor wiring notifies teach.
7. **Workflow promote** (Task 7) — copy a session to a durable workflow file.
8. **Workflow endpoints** (Task 8) — list / detail / patch / delete.
9. **🎓 Teach tab + switching** (Task 9) — UI scaffolding.
10. **Landing view** (Task 10) — read-only listing of sessions + workflows.
11. **Step-card editor** (Task 11) — render session steps; read-only.
12. **Annotation + delete + session-steps PATCH** (Task 12) — first write-side of editor.
13. **Save-as-workflow flow** (Task 13) — completes the loop.
14. **7-day cleanup** (Task 14) — janitor.
15. **End-to-end verification** (Task 15) — manual checklist on `.90`.

Each task ends in a commit.

---

## Task 1: TeachingSession primitives (pure, no I/O)

**Files:**
- Create: `teach.js` — initial scaffolding + pure functions
- Create: `tests/teach.test.js` — unit tests

- [ ] **Step 1: Create the skeleton of `teach.js`**

Create `teach.js` at the repo root:

```javascript
'use strict';

/**
 * Teaching Mode P1 — capture, storage, and workflow promotion.
 *
 * Pure primitives in this section have no I/O — they only manipulate the
 * in-memory shape of a TeachingSession. Disk I/O is added in Task 2, and
 * HTTP routing in Task 4.
 */

function makeSession({ package: pkg, activity, device, screen_w, screen_h, now = Date.now() } = {}) {
  return {
    id: 'teach-' + now,
    package: pkg || '',
    activity: activity || '',
    device: device || '',
    screen_w: screen_w || 0,
    screen_h: screen_h || 0,
    started_at: now,
    ended_at: null,
    end_reason: null,
    steps: [],
    stuck_at: null,
    help_question: null,
    help_resolved: null,
  };
}

function appendStep(session, { action, args, screenshot = null, now = Date.now() }) {
  if (!session || session.ended_at !== null) return null;
  const step = {
    index: session.steps.length,
    action,
    args: args || {},
    screenshot,
    timestamp: now,
    label: null,
    anchor: null,
  };
  session.steps.push(step);
  return step;
}

function markStuck(session, { help_question, step_index = null }) {
  if (!session || session.ended_at !== null) return;
  session.stuck_at = step_index !== null ? step_index : session.steps.length - 1;
  session.help_question = help_question || '';
}

function resolveStuck(session, { x, y, label }) {
  if (!session) return;
  session.help_resolved = { x: x | 0, y: y | 0, label: label || '' };
}

function finalizeSession(session, { end_reason, now = Date.now() }) {
  if (!session || session.ended_at !== null) return;
  session.ended_at = now;
  session.end_reason = end_reason || 'unknown';
}

module.exports = { makeSession, appendStep, markStuck, resolveStuck, finalizeSession };
```

- [ ] **Step 2: Write tests**

Create `tests/teach.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSession, appendStep, markStuck, resolveStuck, finalizeSession } = require('../teach');

test('makeSession captures device + screen meta', () => {
  const s = makeSession({ package: 'com.foo', activity: '.Main', device: 'serial', screen_w: 1080, screen_h: 2340, now: 1000 });
  assert.strictEqual(s.id, 'teach-1000');
  assert.strictEqual(s.package, 'com.foo');
  assert.strictEqual(s.screen_w, 1080);
  assert.strictEqual(s.started_at, 1000);
  assert.strictEqual(s.ended_at, null);
  assert.deepStrictEqual(s.steps, []);
});

test('appendStep adds a step and assigns sequential index', () => {
  const s = makeSession({});
  appendStep(s, { action: 'tap', args: { x: 100, y: 200 }, now: 1500 });
  appendStep(s, { action: 'swipe', args: { x1: 100, y1: 200, x2: 100, y2: 100 }, now: 1600 });
  assert.strictEqual(s.steps.length, 2);
  assert.strictEqual(s.steps[0].action, 'tap');
  assert.strictEqual(s.steps[0].index, 0);
  assert.strictEqual(s.steps[1].index, 1);
});

test('appendStep returns null on a finalized session', () => {
  const s = makeSession({});
  finalizeSession(s, { end_reason: 'done' });
  const step = appendStep(s, { action: 'tap', args: { x: 1, y: 2 } });
  assert.strictEqual(step, null);
  assert.strictEqual(s.steps.length, 0);
});

test('markStuck records the help question at the latest step', () => {
  const s = makeSession({});
  appendStep(s, { action: 'tap', args: { x: 1, y: 2 } });
  appendStep(s, { action: 'tap', args: { x: 3, y: 4 } });
  markStuck(s, { help_question: 'where is the post button?' });
  assert.strictEqual(s.stuck_at, 1);
  assert.strictEqual(s.help_question, 'where is the post button?');
});

test('resolveStuck records the human resolution coords', () => {
  const s = makeSession({});
  markStuck(s, { help_question: 'where?', step_index: 0 });
  resolveStuck(s, { x: 540, y: 1500, label: 'post button' });
  assert.deepStrictEqual(s.help_resolved, { x: 540, y: 1500, label: 'post button' });
});

test('finalizeSession is idempotent', () => {
  const s = makeSession({ now: 100 });
  finalizeSession(s, { end_reason: 'done', now: 200 });
  finalizeSession(s, { end_reason: 'idle', now: 300 });
  assert.strictEqual(s.ended_at, 200);
  assert.strictEqual(s.end_reason, 'done');
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: TeachingSession pure primitives (makeSession/appendStep/markStuck/resolveStuck/finalizeSession)"
```

---

## Task 2: Disk persistence for sessions

**Files:**
- Modify: `teach.js` — add `writeSessionMeta`, `appendStepJsonl`, `saveStepScreenshot`, `readSession`, `listSessions`
- Modify: `tests/teach.test.js` — add tests using a temp directory

- [ ] **Step 1: Add disk helpers to `teach.js`**

Append to `teach.js` (after the pure helpers, before `module.exports`):

```javascript
const fs = require('node:fs');
const path = require('node:path');

function sessionDir(rootDir, sessionId) {
  return path.join(rootDir, sessionId);
}

function writeSessionMeta(rootDir, session) {
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id: session.id,
    package: session.package,
    activity: session.activity,
    device: session.device,
    screen_w: session.screen_w,
    screen_h: session.screen_h,
    started_at: session.started_at,
    ended_at: session.ended_at,
    end_reason: session.end_reason,
    stuck_at: session.stuck_at,
    help_question: session.help_question,
    help_resolved: session.help_resolved,
    step_count: session.steps.length,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function appendStepJsonl(rootDir, session, step) {
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify(step) + '\n');
}

function saveStepScreenshot(rootDir, session, step, buffer) {
  if (!buffer || buffer.length < 100) return null;
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = 'step-' + String(step.index + 1).padStart(4, '0') + '.jpg';
  fs.writeFileSync(path.join(dir, name), buffer);
  step.screenshot = name;
  return name;
}

function readSession(rootDir, sessionId) {
  const dir = sessionDir(rootDir, sessionId);
  if (!fs.existsSync(dir)) return null;
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const steps = [];
  const stepsPath = path.join(dir, 'steps.jsonl');
  if (fs.existsSync(stepsPath)) {
    const lines = fs.readFileSync(stepsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { steps.push(JSON.parse(line)); } catch {}
    }
  }
  return { ...meta, steps };
}

function listSessions(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(rootDir)) {
    if (!name.startsWith('teach-')) continue;
    const metaPath = path.join(rootDir, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
    } catch {}
  }
  out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return out;
}
```

Update the `module.exports` block:

```javascript
module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
};
```

- [ ] **Step 2: Add tests**

Append to `tests/teach.test.js`:

```javascript
const fs = require('node:fs');
const path = require('node:path');
const os  = require('node:os');
const {
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
} = require('../teach');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teach-test-'));
}

test('writeSessionMeta + appendStepJsonl + readSession round-trip', () => {
  const root = tmpDir();
  const s = makeSession({ package: 'com.foo', activity: '.A', now: 5000 });
  appendStep(s, { action: 'tap', args: { x: 1, y: 2 }, now: 5001 });
  appendStep(s, { action: 'tap', args: { x: 3, y: 4 }, now: 5002 });
  writeSessionMeta(root, s);
  appendStepJsonl(root, s, s.steps[0]);
  appendStepJsonl(root, s, s.steps[1]);
  const round = readSession(root, s.id);
  assert.strictEqual(round.id, s.id);
  assert.strictEqual(round.steps.length, 2);
  assert.deepStrictEqual(round.steps[1].args, { x: 3, y: 4 });
});

test('saveStepScreenshot writes a step-NNNN.jpg and updates step.screenshot', () => {
  const root = tmpDir();
  const s = makeSession({ now: 6000 });
  const step = appendStep(s, { action: 'tap', args: { x: 1, y: 2 } });
  const buf = Buffer.from(new Array(500).fill(0xFF));
  saveStepScreenshot(root, s, step, buf);
  assert.strictEqual(step.screenshot, 'step-0001.jpg');
  const onDisk = fs.readFileSync(path.join(root, s.id, 'step-0001.jpg'));
  assert.strictEqual(onDisk.length, buf.length);
});

test('listSessions returns most-recent-first', () => {
  const root = tmpDir();
  const a = makeSession({ now: 1000 });
  const b = makeSession({ now: 2000 });
  writeSessionMeta(root, a);
  writeSessionMeta(root, b);
  const list = listSessions(root);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, b.id);
});

test('readSession returns null for non-existent id', () => {
  const root = tmpDir();
  assert.strictEqual(readSession(root, 'teach-does-not-exist'), null);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: disk persistence helpers for TeachingSession (meta.json, steps.jsonl, step-NNNN.jpg)"
```

---

## Task 3: In-flight session manager (singleton)

**Files:**
- Modify: `teach.js` — add `configure`, `getActive`, `startSession`, `captureStep`, `endActive`, `cancelActive`, idle timer
- Modify: `tests/teach.test.js`

- [ ] **Step 1: Append session manager to `teach.js`**

Before the `module.exports`:

```javascript
// ── Active session manager (singleton) ─────────────────────────────────────
const IDLE_MS = 30 * 1000;
let activeSession = null;
let idleTimer = null;
let teachRoot = null;          // set by configure() before any capture happens

function configure({ rootDir }) { teachRoot = rootDir; }
function getActive() { return activeSession; }
function clearIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (activeSession && activeSession.ended_at === null) endActive('idle');
  }, IDLE_MS);
}

function startSession(metaArgs) {
  if (activeSession && activeSession.ended_at === null) return activeSession;
  activeSession = makeSession(metaArgs || {});
  if (teachRoot) writeSessionMeta(teachRoot, activeSession);
  armIdleTimer();
  return activeSession;
}

function captureStep({ action, args, screenshotBuffer = null, metaArgs = null }) {
  if (!activeSession || activeSession.ended_at !== null) startSession(metaArgs || {});
  const step = appendStep(activeSession, { action, args });
  if (!step) return null;
  if (screenshotBuffer && teachRoot) saveStepScreenshot(teachRoot, activeSession, step, screenshotBuffer);
  if (teachRoot) {
    appendStepJsonl(teachRoot, activeSession, step);
    writeSessionMeta(teachRoot, activeSession);
  }
  armIdleTimer();
  return step;
}

function endActive(reason) {
  if (!activeSession || activeSession.ended_at !== null) return null;
  finalizeSession(activeSession, { end_reason: reason });
  if (teachRoot) writeSessionMeta(teachRoot, activeSession);
  clearIdleTimer();
  const finished = activeSession;
  activeSession = null;
  return finished;
}

function cancelActive() {
  if (!activeSession) return null;
  if (teachRoot) {
    const dir = sessionDir(teachRoot, activeSession.id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  clearIdleTimer();
  const cancelled = activeSession;
  activeSession = null;
  return cancelled;
}
```

Update `module.exports`:

```javascript
module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
  configure, getActive, startSession, captureStep, endActive, cancelActive,
  IDLE_MS,
};
```

- [ ] **Step 2: Add tests**

Append to `tests/teach.test.js`:

```javascript
const teach = require('../teach');

test('captureStep starts a session lazily on first call', () => {
  const root = tmpDir();
  teach.configure({ rootDir: root });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 }, metaArgs: { package: 'com.foo' } });
  const active = teach.getActive();
  assert.ok(active);
  assert.strictEqual(active.package, 'com.foo');
  assert.strictEqual(active.steps.length, 1);
  teach.endActive('test-cleanup');
});

test('endActive finalizes and clears activeSession', () => {
  const root = tmpDir();
  teach.configure({ rootDir: root });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 } });
  const finished = teach.endActive('done');
  assert.strictEqual(finished.end_reason, 'done');
  assert.ok(finished.ended_at);
  assert.strictEqual(teach.getActive(), null);
});

test('cancelActive removes the session directory', () => {
  const root = tmpDir();
  teach.configure({ rootDir: root });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 } });
  const id = teach.getActive().id;
  assert.ok(fs.existsSync(path.join(root, id)));
  teach.cancelActive();
  assert.strictEqual(fs.existsSync(path.join(root, id)), false);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 13 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: in-flight session manager with idle auto-close + cancel"
```

---

## Task 4: `/teach/*` router endpoints

**Files:**
- Modify: `teach.js` — add `express.Router()` with session endpoints
- Modify: `server.js` — require + mount, configure root
- Modify: `.gitignore` — add `workflows/`

- [ ] **Step 1: Add router to `teach.js`**

Append before `module.exports`:

```javascript
// ── HTTP router ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();

router.get('/teach/sessions', (req, res) => {
  if (!teachRoot) return res.json([]);
  res.json(listSessions(teachRoot));
});

router.get('/teach/sessions/:id', (req, res) => {
  if (!teachRoot) return res.status(404).json({ error: 'teach not configured' });
  const s = readSession(teachRoot, req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

router.get('/teach/sessions/:id/:file', (req, res) => {
  if (!teachRoot) return res.status(404).end();
  if (!/^step-\d{4}\.jpg$/.test(req.params.file)) return res.status(400).end();
  const p = path.join(teachRoot, req.params.id, req.params.file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.sendFile(p);
});

router.post('/teach/done', (req, res) => {
  const f = endActive('done');
  if (!f) return res.status(400).json({ error: 'no active session' });
  res.json({ ok: true, id: f.id });
});

router.post('/teach/cancel', (req, res) => {
  const c = cancelActive();
  if (!c) return res.status(400).json({ error: 'no active session' });
  res.json({ ok: true, id: c.id });
});

router.delete('/teach/sessions/:id', (req, res) => {
  if (!teachRoot) return res.status(404).end();
  const dir = sessionDir(teachRoot, req.params.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

Add `router` to the `module.exports`:

```javascript
module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
  configure, getActive, startSession, captureStep, endActive, cancelActive,
  IDLE_MS,
  router,
};
```

- [ ] **Step 2: Mount in `server.js`**

Run: `grep -n "app.use('/android'" server.js` to find where the android router is mounted. Just below that line, add:

```javascript
const teach = require('./teach');
teach.configure({ rootDir: SESSIONS_DIR });
app.use('/', teach.router);
```

- [ ] **Step 3: Add `workflows/` to `.gitignore`**

Find the `apps.json` line in `.gitignore` and add `workflows/` directly under it:

```
apps.json
workflows/
```

- [ ] **Step 4: Smoke-test the empty endpoint**

Append to `tests/teach.test.js`:

```javascript
test('GET /teach/sessions returns empty list when no sessions exist', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13337', HUMANAIE_DATA_DIR: dataDir },
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
  const res = await fetch('http://127.0.0.1:13337/teach/sessions');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.strictEqual(body.length, 0);
});
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/teach.test.js`
Expected: 14 tests pass.

- [ ] **Step 6: Commit**

```bash
git add teach.js server.js .gitignore tests/teach.test.js
git commit -m "feat: /teach/sessions router + mount in server.js"
```

---

## Task 5: Dispatch hook — wire `captureStep` into `/android/*`

**Files:**
- Modify: `android.js` — call `teach.captureStep` after every successful tap/swipe/key/type

- [ ] **Step 1: Import `teach` + add frame getter**

At the top of `android.js`, alongside other `require`s, add:

```javascript
const teach = require('./teach');
```

Inside the `if (ADB_AVAILABLE) { ... }` block, find `let frameCache = null;` and add immediately below it:

```javascript
function captureSessionFrame() {
  // Reuse the most-recent broadcast frame (JPEG when h264 alive, PNG when
  // on screencap fallback). Avoids a separate ADB call per dispatch —
  // tap latency unchanged.
  return frameCache;
}
```

- [ ] **Step 2: Hook `/tap`**

Find `router.post('/tap', ...)` and replace with:

```javascript
router.post('/tap', async (req, res) => {
  const { x, y } = req.body || {};
  if (x == null || y == null) return res.status(400).json({ error: 'x,y required' });
  const xi = Math.round(x), yi = Math.round(y);
  try {
    await adbAsync('shell', `input tap ${xi} ${yi}`);
    teach.captureStep({
      action: 'tap', args: { x: xi, y: yi },
      screenshotBuffer: captureSessionFrame(),
      metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Hook `/swipe`**

Find `router.post('/swipe', ...)` and replace with:

```javascript
router.post('/swipe', async (req, res) => {
  const { x1, y1, x2, y2, dur = 300 } = req.body || {};
  if (x1 == null || y1 == null || x2 == null || y2 == null) {
    return res.status(400).json({ error: 'x1,y1,x2,y2 required' });
  }
  const safeDur = Math.max(1, Math.min(10000, parseInt(dur, 10) || 300));
  try {
    await adbAsync('shell',
      `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${safeDur}`);
    teach.captureStep({
      action: 'swipe',
      args: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), dur: safeDur },
      screenshotBuffer: captureSessionFrame(),
      metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: Hook `/type`**

Find `router.post('/type', ...)` and replace with:

```javascript
router.post('/type', async (req, res) => {
  const { text } = req.body || {};
  if (text == null || text === '') return res.status(400).json({ error: 'text required' });
  const safe = String(text).replace(/([^a-zA-Z0-9@.,!?\-])/g, '\\$1');
  try {
    await adbAsync('shell', `input text ${safe}`);
    teach.captureStep({
      action: 'type', args: { text: String(text) },
      screenshotBuffer: captureSessionFrame(),
      metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 5: Hook `/key`**

Find `router.post('/key', ...)` and replace with:

```javascript
router.post('/key', async (req, res) => {
  const { keycode } = req.body || {};
  if (!keycode) return res.status(400).json({ error: 'keycode required' });
  if (!/^[A-Z0-9_]+$/.test(String(keycode))) {
    return res.status(400).json({ error: 'keycode must be alphanumeric uppercase + underscores' });
  }
  try {
    await adbAsync('shell', `input keyevent ${keycode}`);
    teach.captureStep({
      action: 'key', args: { keycode: String(keycode) },
      screenshotBuffer: captureSessionFrame(),
      metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 6: Verify module loads and existing tests pass**

Run: `node -e "require('./android.js'); console.log('ok')"`
Expected: `ok`

Run: `node --test tests/android.test.js tests/teach.test.js`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add android.js
git commit -m "feat: /android/{tap,swipe,key,type} append to active TeachingSession on success"
```

---

## Task 6: `/waitfor-highlight` stuck-point integration

**Files:**
- Modify: `server.js` — when waitfor opens, call `teach.markStuck` + append a `waitfor-asked` step; when resolved, call `teach.resolveStuck` + `teach.endActive('stuck')`

- [ ] **Step 1: Locate the waitfor handlers**

Run: `grep -n "waitfor-highlight\|waitforState" server.js | head -10`
Read 25 lines of context around the endpoint that sets `waitforState.active = true` (the "AI asks for help" endpoint) and around the one that handles resolution (the "human clicks" endpoint or wherever waitfor is cleared).

- [ ] **Step 2: Mark stuck on waitfor-start**

In the handler that begins a waitfor (where `waitforState.active = true` is set), immediately after that line add:

```javascript
const active = teach.getActive();
if (active) {
  teach.markStuck(active, { help_question: req.body && req.body.message || '' });
  teach.captureStep({
    action: 'waitfor-asked',
    args: { question: req.body && req.body.message || '' },
    screenshotBuffer: null,
  });
}
```

(If `const teach = require('./teach');` isn't already at the top of `server.js` from Task 4, add it.)

- [ ] **Step 3: Resolve stuck on waitfor-resolve**

In the handler where the human's coordinates come in to resolve the waitfor (where `waitforState.active = false` is set after a click):

```javascript
const active = teach.getActive();
if (active) {
  teach.resolveStuck(active, { x: req.body.x, y: req.body.y, label: req.body.label || '' });
  teach.endActive('stuck');
}
```

- [ ] **Step 4: Verify**

Run: `node --test tests/teach.test.js tests/android.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: /waitfor-highlight marks stuck point + records human resolution in TeachingSession"
```

---

## Task 7: Workflow promote

**Files:**
- Modify: `teach.js` — add `configureWorkflows`, `slugify`, `workflowDir`, `listWorkflows`, `readWorkflow`, `workflowPathById`, `writeWorkflowJson`, `deleteWorkflow`, `promoteSessionToWorkflow`, `POST /teach/sessions/:id/promote`
- Modify: `server.js` — call `teach.configureWorkflows`
- Modify: `tests/teach.test.js` — promote tests

- [ ] **Step 1: Add workflow helpers to `teach.js`**

Append before the `router` definition:

```javascript
// ── Workflow promotion ──────────────────────────────────────────────────────
let workflowsRoot = null;
function configureWorkflows({ rootDir }) { workflowsRoot = rootDir; }

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workflow';
}

function workflowDir(pkg, activity, slug) {
  return path.join(workflowsRoot, slugify(pkg || 'unknown'), slugify(activity || 'unknown'), slug);
}

function listWorkflows({ package: pkgFilter, activity: actFilter } = {}) {
  if (!workflowsRoot || !fs.existsSync(workflowsRoot)) return [];
  const out = [];
  for (const pkgDir of fs.readdirSync(workflowsRoot)) {
    const pkgPath = path.join(workflowsRoot, pkgDir);
    if (!fs.statSync(pkgPath).isDirectory()) continue;
    for (const actDir of fs.readdirSync(pkgPath)) {
      const actPath = path.join(pkgPath, actDir);
      if (!fs.statSync(actPath).isDirectory()) continue;
      for (const slug of fs.readdirSync(actPath)) {
        const wfPath = path.join(actPath, slug, 'workflow.json');
        if (!fs.existsSync(wfPath)) continue;
        try {
          const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
          if (pkgFilter && wf.package !== pkgFilter) continue;
          if (actFilter && wf.activity !== actFilter) continue;
          out.push(wf);
        } catch {}
      }
    }
  }
  out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return out;
}

function readWorkflow(id) {
  for (const wf of listWorkflows()) if (wf.id === id) return wf;
  return null;
}

function workflowPathById(id) {
  for (const wf of listWorkflows()) {
    if (wf.id === id) return path.join(workflowDir(wf.package, wf.activity, slugify(wf.name)), 'workflow.json');
  }
  return null;
}

function writeWorkflowJson(wfPath, wf) {
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));
}

function deleteWorkflow(id) {
  const wf = readWorkflow(id);
  if (!wf) return false;
  const dir = workflowDir(wf.package, wf.activity, slugify(wf.name));
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

function promoteSessionToWorkflow(sessionId, { name }) {
  if (!teachRoot || !workflowsRoot) throw new Error('teach/workflows not configured');
  const session = readSession(teachRoot, sessionId);
  if (!session) throw new Error('session not found');
  const slug = slugify(name);
  let finalSlug = slug, n = 2;
  while (fs.existsSync(workflowDir(session.package, session.activity, finalSlug))) {
    finalSlug = slug + '-' + n++;
  }
  const dir = workflowDir(session.package, session.activity, finalSlug);
  fs.mkdirSync(dir, { recursive: true });
  for (const step of session.steps) {
    if (!step.screenshot) continue;
    const src = path.join(teachRoot, sessionId, step.screenshot);
    const dst = path.join(dir, step.screenshot);
    try { fs.copyFileSync(src, dst); } catch {}
  }
  const wf = {
    id: 'wf-' + Date.now(),
    name: String(name || 'Untitled'),
    package: session.package,
    activity: session.activity,
    screen_w: session.screen_w,
    screen_h: session.screen_h,
    steps: session.steps,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: sessionId,
    use_count: 0,
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}
```

- [ ] **Step 2: Add promote endpoint**

Inside the router section in `teach.js`, append:

```javascript
router.post('/teach/sessions/:id/promote', (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const wf = promoteSessionToWorkflow(req.params.id, { name });
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
```

- [ ] **Step 3: Update `module.exports`**

```javascript
module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
  configure, configureWorkflows, getActive, startSession, captureStep, endActive, cancelActive,
  IDLE_MS,
  router,
  slugify, workflowDir, workflowPathById, writeWorkflowJson,
  promoteSessionToWorkflow, listWorkflows, readWorkflow, deleteWorkflow,
};
```

- [ ] **Step 4: Configure workflows root in `server.js`**

Find the line `teach.configure({ rootDir: SESSIONS_DIR });` added in Task 4. Immediately below, add:

```javascript
const WORKFLOWS_DIR = `${DATA_DIR}/workflows`;
teach.configureWorkflows({ rootDir: WORKFLOWS_DIR });
```

- [ ] **Step 5: Add tests**

Append to `tests/teach.test.js`:

```javascript
test('promoteSessionToWorkflow copies steps and writes workflow.json', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 100, y: 200 },
    screenshotBuffer: Buffer.from('fakejpg'),
    metaArgs: { package: 'com.test', activity: '.A' } });
  teach.captureStep({ action: 'tap', args: { x: 300, y: 400 },
    screenshotBuffer: Buffer.from('fakejpg2') });
  const id = teach.getActive().id;
  teach.endActive('done');

  const wf = teach.promoteSessionToWorkflow(id, { name: 'Test flow' });
  assert.strictEqual(wf.name, 'Test flow');
  assert.strictEqual(wf.steps.length, 2);
  const wfPath = path.join(wfDir, 'com-test', 'a', 'test-flow', 'step-0001.jpg');
  assert.ok(fs.existsSync(wfPath));
});

test('listWorkflows returns the promoted workflow', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 }, metaArgs: { package: 'com.foo', activity: '.X' } });
  const id = teach.getActive().id;
  teach.endActive('done');
  teach.promoteSessionToWorkflow(id, { name: 'Foo' });

  const list = teach.listWorkflows();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Foo');
});
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add teach.js server.js tests/teach.test.js
git commit -m "feat: promote TeachingSession to durable Workflow (workflows/<pkg>/<activity>/<slug>/)"
```

---

## Task 8: Workflow CRUD endpoints

**Files:**
- Modify: `teach.js` — add `GET /workflows`, `GET /workflows/:id`, `GET /workflows/:id/:file`, `PATCH /workflows/:id`, `DELETE /workflows/:id`

- [ ] **Step 1: Append the workflow endpoints to the router**

Append to the router section in `teach.js`:

```javascript
router.get('/workflows', (req, res) => {
  res.json(listWorkflows({ package: req.query.package, activity: req.query.activity }));
});

router.get('/workflows/:id', (req, res) => {
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});

router.get('/workflows/:id/:file', (req, res) => {
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).end();
  if (!/^step-\d{4}\.jpg$/.test(req.params.file)) return res.status(400).end();
  const p = path.join(workflowDir(wf.package, wf.activity, slugify(wf.name)), req.params.file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.sendFile(p);
});

router.patch('/workflows/:id', (req, res) => {
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  if (req.body.name) wf.name = String(req.body.name).slice(0, 80);
  if (Array.isArray(req.body.steps)) wf.steps = req.body.steps;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(req.params.id);
  if (!wfPath) return res.status(500).json({ error: 'cannot resolve workflow path' });
  writeWorkflowJson(wfPath, wf);
  res.json({ ok: true, workflow: wf });
});

router.delete('/workflows/:id', (req, res) => {
  if (deleteWorkflow(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'not found' });
});
```

- [ ] **Step 2: Add smoke test**

Append to `tests/teach.test.js`:

```javascript
test('GET /workflows returns an array', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13338', HUMANAIE_DATA_DIR: dataDir },
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

  const res = await fetch('http://127.0.0.1:13338/workflows');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: workflow CRUD endpoints (GET list/detail/step.jpg, PATCH, DELETE)"
```

---

## Task 9: `🎓 Teach` tab + mode-switching

**Files:**
- Modify: `public/cam/index.html` — tab markup, CSS, mode-switch functions

- [ ] **Step 1: Add the tab markup**

Run: `grep -n 'id="phone-tab"' public/cam/index.html`. Find the closing `</div>` of `#phone-tab` and insert immediately after:

```html
    <div id="teach-tab" class="tab teach-tab" title="Workflow capture + replay (P1)">
      <span class="tab-title">🎓 Teach</span>
      <span id="teach-tab-indicator" class="teach-tab-indicator" title="active session"></span>
    </div>
```

- [ ] **Step 2: Add CSS**

Find `.phone-tab-indicator[data-state="no-adb"]` in the CSS section. Append immediately below:

```css
  .tab.teach-tab {
    background: #6633cc;
    color: #fff;
  }
  .tab.teach-tab:hover { background: #7744dd; }
  .tab.teach-tab.active { background: #8855ee; color: #fff; }
  .teach-tab-indicator {
    display: inline-block;
    width: 8px; height: 8px; border-radius: 50%;
    margin-left: 6px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.4);
  }
  .teach-tab-indicator.active { background: #d80000; border-color: rgba(0,0,0,0.5); }
```

- [ ] **Step 3: Add mode-switch functions**

Find `function switchToBrowserMode()`. Immediately after its closing `}`, add:

```javascript
  var teachMode = false;
  function switchToTeachMode() {
    teachMode = true;
    androidMode = false;
    document.body.classList.add('teach-mode');
    document.body.classList.remove('android-mode');
    document.getElementById('teach-tab').classList.add('active');
    document.getElementById('phone-tab').classList.remove('active');
    document.querySelectorAll('.tab:not(.teach-tab):not(.phone-tab).active').forEach(function(el) { el.classList.remove('active'); });
    var browserSplash = document.getElementById('splash');
    if (browserSplash) browserSplash.style.display = 'none';
    state.splashVisible = false;
    if ($viewport) $viewport.classList.remove('visible');
    showTeachLanding();
  }
  function switchFromTeachMode() {
    teachMode = false;
    document.body.classList.remove('teach-mode');
    document.getElementById('teach-tab').classList.remove('active');
    var root = document.getElementById('teach-root');
    if (root) root.style.display = 'none';
  }
  document.getElementById('teach-tab').addEventListener('click', switchToTeachMode);

  function showTeachLanding() {
    // Wired in Task 10.
    var wrap = document.getElementById('viewport-wrapper');
    if (!wrap) return;
    var existing = document.getElementById('teach-root');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'teach-root';
      existing.style.cssText = 'position:absolute;inset:0;background:#0a0a0a;color:#bbb;padding:24px;overflow:auto;z-index:6';
      wrap.appendChild(existing);
    }
    existing.style.display = 'block';
    existing.textContent = 'Teach landing — wired in Task 10';
  }
```

- [ ] **Step 4: Update `switchToAndroidMode` + `switchToBrowserMode` to exit teach**

Find `function switchToAndroidMode()`. Immediately after the opening `{`, add:

```javascript
    if (typeof teachMode !== 'undefined' && teachMode) switchFromTeachMode();
```

Same edit at the top of `switchToBrowserMode`:

```javascript
    if (typeof teachMode !== 'undefined' && teachMode) switchFromTeachMode();
```

- [ ] **Step 5: Verify static HTML**

Run: `grep -c 'id="teach-tab"\|switchToTeachMode\|teachMode' public/cam/index.html`
Expected: ≥ 6 matches.

- [ ] **Step 6: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: 🎓 Teach tab with mode-switching scaffolding"
```

---

## Task 10: Teach landing view

**Files:**
- Modify: `public/cam/index.html` — replace the stub `showTeachLanding` with the full DOM-construction renderer (no innerHTML for user-controlled strings — XSS-safe via createElement + textContent)

- [ ] **Step 1: Replace `showTeachLanding` and add `renderTeachLanding`**

Find `function showTeachLanding()` (the stub added in Task 9). Replace it and add `renderTeachLanding` plus an empty `openTeachEditor` stub:

```javascript
  var teachRefreshTimer = null;
  function showTeachLanding() {
    var wrap = document.getElementById('viewport-wrapper');
    if (!wrap) return;
    var root = document.getElementById('teach-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'teach-root';
      root.style.cssText = 'position:absolute;inset:0;background:#0a0a0a;color:#bbb;padding:16px;overflow:auto;z-index:6';
      wrap.appendChild(root);
    }
    root.style.display = 'block';
    // Reset DOM
    while (root.firstChild) root.removeChild(root.firstChild);
    var landing = document.createElement('div');
    landing.id = 'teach-landing';
    root.appendChild(landing);
    renderTeachLanding();
    if (teachRefreshTimer) clearInterval(teachRefreshTimer);
    teachRefreshTimer = setInterval(function() {
      if (teachMode) renderTeachLanding();
      else { clearInterval(teachRefreshTimer); teachRefreshTimer = null; }
    }, 5000);
  }

  function renderTeachLanding() {
    var landing = document.getElementById('teach-landing');
    if (!landing) return;
    Promise.all([
      fetch('/teach/sessions').then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch('/workflows').then(function(r) { return r.json(); }).catch(function() { return []; }),
    ]).then(function(results) {
      var sessions = results[0] || [];
      var workflows = results[1] || [];
      // Clear and rebuild via DOM API (no innerHTML — keeps user-controlled
      // strings safely text-only).
      while (landing.firstChild) landing.removeChild(landing.firstChild);
      var grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:16px';
      grid.appendChild(buildLandingColumn('Recent sessions', sessions, renderSessionRow));
      grid.appendChild(buildLandingColumn('Saved workflows (consulted by AI in P3)', workflows, renderWorkflowRow));
      landing.appendChild(grid);
    });
  }

  function buildLandingColumn(title, items, rowBuilder) {
    var col = document.createElement('div');
    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:13px;font-weight:bold;margin-bottom:8px;border-bottom:1px solid #2a2a2a;padding-bottom:4px';
    hdr.textContent = title;
    col.appendChild(hdr);
    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:12px;font-style:italic';
      empty.textContent = 'nothing here yet';
      col.appendChild(empty);
      return col;
    }
    items.forEach(function(item) {
      col.appendChild(rowBuilder(item));
    });
    return col;
  }

  function renderSessionRow(s) {
    var statusColor = '#cccc55', statusText = '⏱ idle timeout';
    if (s.end_reason === 'done')  { statusColor = '#3ddc84'; statusText = '✓ succeeded'; }
    if (s.end_reason === 'stuck') { statusColor = '#d80000'; statusText = '✕ stuck — needs help'; }
    if (s.ended_at === null)      { statusColor = '#ff66cc'; statusText = '🔴 active'; }
    var ago = (Date.now() - (s.ended_at || s.started_at)) / 1000;
    var agoText = ago < 60 ? Math.round(ago) + 's ago' : Math.round(ago/60) + 'm ago';
    var row = document.createElement('div');
    row.className = 'teach-session-row';
    row.style.cssText = 'background:#0a0a0a;border:1px solid #2a2a2a;border-left:3px solid ' + statusColor + ';border-radius:4px;padding:8px;margin-bottom:6px;cursor:pointer';
    row.addEventListener('click', function() { openTeachEditor(s.id, 'session'); });
    var top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;font-size:11px';
    var lt = document.createElement('span'); lt.style.color = statusColor; lt.textContent = statusText;
    var rt = document.createElement('span'); rt.style.color = '#666'; rt.textContent = agoText;
    top.appendChild(lt); top.appendChild(rt); row.appendChild(top);
    var mid = document.createElement('div');
    mid.style.cssText = 'font-size:12px;color:#ccc;margin-top:2px';
    mid.textContent = (s.package || '—') + ' · ' + (s.step_count || 0) + ' actions';
    row.appendChild(mid);
    if (s.help_question) {
      var bot = document.createElement('div');
      bot.style.cssText = 'font-size:10px;color:#cccc55;margin-top:2px;font-style:italic';
      bot.textContent = '"' + s.help_question + '"';
      row.appendChild(bot);
    }
    return row;
  }

  function renderWorkflowRow(w) {
    var row = document.createElement('div');
    row.className = 'teach-workflow-row';
    row.style.cssText = 'background:#0a0a0a;border:1px solid #2a2a2a;border-radius:4px;padding:8px;margin-bottom:6px;cursor:pointer';
    row.addEventListener('click', function() { openTeachEditor(w.id, 'workflow'); });
    var name = document.createElement('div');
    name.style.cssText = 'font-size:12px;color:#3ddc84;font-weight:bold';
    name.textContent = w.name;
    row.appendChild(name);
    var meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#666;margin-top:2px';
    var stepCount = (w.steps && w.steps.length) || 0;
    meta.textContent = (w.package || '—') + ' · ' + stepCount + ' steps · used ' + (w.use_count || 0) + '×';
    row.appendChild(meta);
    return row;
  }

  // Stubbed for Task 11.
  function openTeachEditor(id, type) {
    console.log('openTeachEditor', id, type);
  }
```

- [ ] **Step 2: Wire the active-session indicator**

Find `refreshAndroidStatus` function. Inside it (anywhere — bottom is fine), add:

```javascript
    fetch('/teach/sessions').then(function(r) { return r.json(); }).then(function(list) {
      var active = Array.isArray(list) && list.find && list.find(function(s) { return s.ended_at === null; });
      var dot = document.getElementById('teach-tab-indicator');
      if (dot) dot.classList.toggle('active', !!active);
    }).catch(function() {});
```

- [ ] **Step 3: Verify**

Run: `grep -c 'renderTeachLanding\|renderSessionRow\|renderWorkflowRow' public/cam/index.html`
Expected: ≥ 4 matches.

- [ ] **Step 4: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: Teach landing view — sessions + workflows columns, DOM-constructed (XSS-safe), 5s refresh"
```

---

## Task 11: Step-card editor (read-only render)

**Files:**
- Modify: `public/cam/index.html` — implement `openTeachEditor` using DOM construction

- [ ] **Step 1: Replace the `openTeachEditor` stub**

Find `function openTeachEditor` (added at end of Task 10). Replace its body with:

```javascript
  function openTeachEditor(id, type) {
    var root = document.getElementById('teach-root');
    if (!root) return;
    var endpoint = type === 'workflow' ? '/workflows/' + encodeURIComponent(id) : '/teach/sessions/' + encodeURIComponent(id);
    var imgPrefix = type === 'workflow' ? '/workflows/' + encodeURIComponent(id) + '/' : '/teach/sessions/' + encodeURIComponent(id) + '/';
    fetch(endpoint).then(function(r) { return r.json(); }).then(function(data) {
      if (!data || data.error) {
        while (root.firstChild) root.removeChild(root.firstChild);
        var err = document.createElement('div');
        err.style.color = '#d80000';
        err.textContent = 'Could not load: ' + (data && data.error || 'unknown');
        root.appendChild(err);
        return;
      }
      window.__teachEditorData = data;
      renderTeachEditor(id, type, data, imgPrefix);
    });
  }

  function renderTeachEditor(id, type, data, imgPrefix) {
    var root = document.getElementById('teach-root');
    while (root.firstChild) root.removeChild(root.firstChild);

    // Header row: back button + title + meta + save button (sessions only)
    var hdr = document.createElement('div');
    hdr.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;gap:8px';
    var back = document.createElement('button');
    back.textContent = '← back';
    back.style.cssText = 'background:transparent;color:#888;border:none;cursor:pointer;font-size:12px';
    back.addEventListener('click', function() { showTeachLanding(); });
    hdr.appendChild(back);
    var name = document.createElement('span');
    name.style.cssText = 'font-size:14px;color:#ccc;font-weight:bold';
    name.textContent = data.name || data.id;
    hdr.appendChild(name);
    var meta = document.createElement('span');
    meta.style.cssText = 'font-size:11px;color:#888';
    meta.textContent = '· ' + (data.package || '(unknown)') + ' · ' + ((data.steps && data.steps.length) || 0) + ' steps';
    hdr.appendChild(meta);
    if (type === 'session') {
      var save = document.createElement('button');
      save.id = 'teach-save-btn';
      save.className = 'nav-btn';
      save.textContent = '💾 Save as workflow';
      save.style.marginLeft = 'auto';
      save.addEventListener('click', function() { window.saveWorkflowFromSession(id); });
      hdr.appendChild(save);
    }
    root.appendChild(hdr);

    // Stuck-point banner (if applicable)
    if (data.help_question) {
      var banner = document.createElement('div');
      banner.style.cssText = 'background:#3a1818;border:1px solid #d80000;border-radius:4px;padding:8px;margin-bottom:12px;color:#ffaaaa;font-size:12px';
      banner.textContent = '⚠ AI asked here: "' + data.help_question + '"';
      root.appendChild(banner);
    }

    // Step timeline
    var timeline = document.createElement('div');
    timeline.style.cssText = 'display:flex;gap:12px;overflow-x:auto;padding-bottom:12px';
    var stuck = (type === 'session' && data.end_reason === 'stuck') ? data.stuck_at : null;
    (data.steps || []).forEach(function(step, idx) {
      timeline.appendChild(buildStepCard(step, idx, stuck === idx, type, imgPrefix));
    });
    root.appendChild(timeline);
  }

  function buildStepCard(step, idx, isStuck, type, imgPrefix) {
    var card = document.createElement('div');
    card.className = 'teach-step-card';
    card.style.cssText = 'min-width:200px;background:#0a0a0a;border:1px solid ' + (isStuck ? '#d80000' : '#2a2a2a') + ';border-radius:6px;padding:8px';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:10px;color:#888;margin-bottom:4px';
    hdr.textContent = 'STEP ' + (idx + 1) + ' · ' + step.action;
    card.appendChild(hdr);

    var shotWrap = document.createElement('div');
    shotWrap.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:4px;width:100%;aspect-ratio:9/19;display:flex;align-items:center;justify-content:center;color:#444;position:relative;overflow:hidden';
    if (step.screenshot) {
      var img = document.createElement('img');
      img.src = imgPrefix + step.screenshot;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain';
      shotWrap.appendChild(img);
    } else {
      var ph = document.createElement('span');
      ph.style.fontSize = '10px';
      ph.textContent = '(no screenshot)';
      shotWrap.appendChild(ph);
    }
    card.appendChild(shotWrap);

    // Editable label
    var labelWrap = document.createElement('div');
    labelWrap.style.marginTop = '6px';
    var labelInput = document.createElement('input');
    labelInput.className = 'mock-input teach-step-label';
    labelInput.value = step.label || stepDefaultLabel(step);
    labelInput.setAttribute('data-step-idx', String(idx));
    labelInput.style.cssText = 'width:100%;height:20px;font-size:10px;padding:2px 4px';
    labelWrap.appendChild(labelInput);
    card.appendChild(labelWrap);

    // Coord readout
    var coord = document.createElement('div');
    coord.style.cssText = 'margin-top:4px;font-size:9px;color:#666;font-family:monospace';
    coord.textContent = stepCoordText(step);
    card.appendChild(coord);

    // Delete button (sessions only)
    if (type === 'session') {
      var del = document.createElement('button');
      del.className = 'teach-step-delete nav-btn';
      del.setAttribute('data-step-idx', String(idx));
      del.textContent = '✕ delete';
      del.style.cssText = 'margin-top:4px;width:100%;font-size:9px;padding:2px 4px;color:#888';
      card.appendChild(del);
    }
    return card;
  }

  function stepDefaultLabel(step) {
    if (step.action === 'tap')   return 'tap (' + step.args.x + ',' + step.args.y + ')';
    if (step.action === 'swipe') return 'swipe (' + step.args.x1 + ',' + step.args.y1 + ')→(' + step.args.x2 + ',' + step.args.y2 + ')';
    if (step.action === 'key')   return 'key ' + step.args.keycode;
    if (step.action === 'type')  return 'type "' + (step.args.text || '').substring(0, 30) + '"';
    if (step.action === 'waitfor-asked') return 'asked: ' + (step.args.question || '');
    return step.action;
  }

  function stepCoordText(step) {
    return stepDefaultLabel(step);
  }
```

- [ ] **Step 2: Verify**

Run: `grep -c 'renderTeachEditor\|buildStepCard\|stepDefaultLabel' public/cam/index.html`
Expected: ≥ 4 matches.

- [ ] **Step 3: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: step-card editor renders session/workflow with screenshots + stuck marker (DOM-constructed)"
```

---

## Task 12: Step delete + label edit wiring (annotation v1)

**Files:**
- Modify: `public/cam/index.html` — wire delete buttons + label edits inside `renderTeachEditor`
- Modify: `teach.js` — add `PATCH /teach/sessions/:id/steps` so label edits persist to disk before promote

- [ ] **Step 1: Add `PATCH /teach/sessions/:id/steps` to `teach.js`**

Append to the router section:

```javascript
router.patch('/teach/sessions/:id/steps', (req, res) => {
  if (!teachRoot) return res.status(404).json({ error: 'teach not configured' });
  if (!Array.isArray(req.body && req.body.steps)) return res.status(400).json({ error: 'steps[] required' });
  const dir = sessionDir(teachRoot, req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  const tmp = path.join(dir, 'steps.jsonl.tmp');
  fs.writeFileSync(tmp, req.body.steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  fs.renameSync(tmp, path.join(dir, 'steps.jsonl'));
  res.json({ ok: true });
});
```

- [ ] **Step 2: Wire delete + label edit in `renderTeachEditor`**

At the END of `renderTeachEditor` (after appending `timeline` to `root`), append:

```javascript
    // Wire delete + label-edit handlers
    var deleteBtns = root.querySelectorAll('.teach-step-delete');
    for (var di = 0; di < deleteBtns.length; di++) {
      deleteBtns[di].addEventListener('click', function(e) {
        var idx = parseInt(e.target.getAttribute('data-step-idx'), 10);
        data.steps.splice(idx, 1);
        // Re-index remaining steps so their index field matches array position
        for (var i = 0; i < data.steps.length; i++) data.steps[i].index = i;
        window.__teachEditorData = data;
        renderTeachEditor(id, type, data, imgPrefix);
      });
    }
    var labelInputs = root.querySelectorAll('.teach-step-label');
    for (var li = 0; li < labelInputs.length; li++) {
      labelInputs[li].addEventListener('blur', function(e) {
        var idx = parseInt(e.target.getAttribute('data-step-idx'), 10);
        data.steps[idx].label = e.target.value;
        window.__teachEditorData = data;
        if (type === 'workflow') {
          fetch('/workflows/' + encodeURIComponent(id), {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ steps: data.steps }),
          }).catch(function(err) { console.warn('patch failed', err); });
        }
      });
    }
```

- [ ] **Step 3: Verify**

Run: `node --test tests/teach.test.js`
Expected: all pass.

Run: `grep -c 'teach-step-delete\|teach-step-label' public/cam/index.html`
Expected: ≥ 4 matches.

- [ ] **Step 4: Commit**

```bash
git add teach.js public/cam/index.html
git commit -m "feat: step delete + label edit in Teach editor + PATCH /teach/sessions/:id/steps"
```

---

## Task 13: Save-as-workflow flow

**Files:**
- Modify: `public/cam/index.html` — implement `window.saveWorkflowFromSession`

- [ ] **Step 1: Implement the save handler**

Below `renderTeachEditor`, add:

```javascript
  window.saveWorkflowFromSession = function(sessionId) {
    var data = window.__teachEditorData;
    if (!data) { alert('No session data loaded — try opening the session again.'); return; }
    var defaultName = (function() {
      var labels = data.steps.filter(function(s) { return s.label; }).map(function(s) { return s.label; });
      return labels[0] ? labels.slice(0, 2).join(' → ') : 'untitled-' + sessionId.slice(-6);
    })();
    var name = prompt('Name this workflow:', defaultName);
    if (!name) return;
    // Persist in-memory edits to disk first, then promote.
    fetch('/teach/sessions/' + encodeURIComponent(sessionId) + '/steps', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: data.steps }),
    }).then(function() {
      return fetch('/teach/sessions/' + encodeURIComponent(sessionId) + '/promote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name }),
      });
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Save failed: ' + d.error); return; }
      openTeachEditor(d.workflow.id, 'workflow');
    }).catch(function(err) { alert('Save failed: ' + err.message); });
  };
```

- [ ] **Step 2: Verify**

Run: `node -e "require('./teach.js'); console.log('ok')"` → expect `ok`
Run: `node --test tests/teach.test.js` → all pass.
Run: `grep -c 'saveWorkflowFromSession' public/cam/index.html` → ≥ 2 matches.

- [ ] **Step 3: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: save-as-workflow flow (PATCH session steps → POST promote → switch to workflow view)"
```

---

## Task 14: 7-day cleanup of unpromoted teach drafts

**Files:**
- Modify: `server.js` — extend `pruneOldSessions` to also delete `teach-*` directories older than 7 days unless referenced by a workflow

- [ ] **Step 1: Locate `pruneOldSessions`**

Run: `grep -n "function pruneOldSessions" server.js`
Read 30 lines of context.

- [ ] **Step 2: Verify `path` is imported at top of `server.js`**

Run: `grep -n "^const path" server.js`. If no result, add `const path = require('path');` near the other `require`s at the top.

- [ ] **Step 3: Append teach cleanup logic to `pruneOldSessions`**

Inside `pruneOldSessions`, just before its closing `}`:

```javascript
  // Teach-session cleanup: drafts unpromoted after 7 days are deleted.
  try {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    const wfList = teach.listWorkflows();
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith('teach-')) continue;
      const dir = path.join(SESSIONS_DIR, ent.name);
      const metaPath = path.join(dir, 'meta.json');
      let m = null;
      try { m = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
      const startedAt = (m && m.started_at) || 0;
      const age = now - startedAt;
      if (age > SEVEN_DAYS_MS) {
        const referenced = wfList.some(w => w.source === ent.name);
        if (!referenced) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      }
    }
  } catch (e) { /* sessions dir may not exist yet */ }
```

- [ ] **Step 4: Verify**

Run: `node -e "require('./server.js')"` (Ctrl+C after "Listening").
Run: `node --test tests/teach.test.js tests/android.test.js` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: pruneOldSessions deletes unpromoted teach-* drafts after 7 days"
```

---

## Task 15: Manual end-to-end verification on `.90`

**Files:** None. User-driven checklist.

- [ ] **Step 1: Push + pull**

On `.82`:
```bash
git push origin main
```

On `.90`:
```bash
cd ~/projects/HumanAIE
git pull
pkill -9 -f "node.*HumanAIE/server.js"
sleep 2
systemd-run --user --scope --no-block /home/garage/.nvm/versions/node/v22.22.1/bin/node /home/garage/projects/HumanAIE/server.js
```

Close + reopen the browser tab on `http://192.168.2.90:3333/cam/`.

- [ ] **Step 2: Verify 🎓 Teach tab exists**

Tab bar shows: `+`, `📱 HANDROID`, `🎓 Teach`. Click 🎓 — landing appears (empty).

- [ ] **Step 3: Create a session by tapping in HANDROID**

Click 📱 HANDROID. Tap on the phone viewport twice. Wait 35s. Click 🎓 Teach.
Expected: a row with `⏱ idle timeout` and 2 actions.

- [ ] **Step 4: Open the session in the editor**

Click the row. Step cards appear with screenshots. Edit one step's label. Click the screenshot card off the input — the blur should fire (no PATCH yet for sessions; persisted via the Save button).

- [ ] **Step 5: Save as workflow**

Click "💾 Save as workflow". Name it `test-flow`. Expected: editor switches to viewing the new workflow. Verify the workflow appears in the right column when you click back.

- [ ] **Step 6: Verify on disk**

```bash
ls ~/projects/HumanAIE/workflows/
ls ~/projects/HumanAIE/humanaie-sessions/ | grep teach-
```

You should see at least one workflow dir + a teach-session dir.

- [ ] **Step 7: Trigger stuck-point scenario**

Use whatever the current waitfor start endpoint is (search by `grep -n "waitfor-highlight" server.js`):
```bash
curl -X POST -H 'content-type: application/json' -d '{"message":"where is the post button?"}' http://192.168.2.90:3333/waitfor-highlight
```
Then click on the phone viewport in the cam UI to resolve. Switch to 🎓 Teach.
Expected: a row with `✕ stuck — needs help` and the question text. Click → editor shows the red-bordered stuck step.

- [ ] **Step 8: Workflow PATCH**

Open the saved workflow. Change a label, click out. Reload the page → label persists.

- [ ] **Step 9: Bump to v1.4.0 if all green**

```bash
sed -i 's/"version": "1.3.0"/"version": "1.4.0"/' package.json
sed -i 's/v1\.3\.0/v1.4.0/g' public/cam/index.html
git add package.json public/cam/index.html
git commit -m "chore: bump to v1.4.0 — Teaching Mode P1 shipped"
git push origin main
```

- [ ] **Step 10: If anything broke, file targeted fix commits on `main`**

Same convention as before — small focused commits, one issue per commit.

---

## Done criteria

- [ ] `node --test tests/teach.test.js` and `node --test tests/android.test.js` both pass
- [ ] All HANDROID taps/swipes/keys produce step entries in the active session
- [ ] `/waitfor-highlight` flips the active session to `stuck` with the question + resolution
- [ ] 🎓 Teach tab shows sessions + workflows, auto-refreshing every 5s
- [ ] Editor renders screenshots, allows label edits + step deletion
- [ ] Save-as-workflow round-trip works: session → workflow file → visible in right column → label edits PATCH back
- [ ] No regressions in HANDROID gesture behavior
- [ ] `package.json` bumped to 1.4.0 after green E2E
