# Teaching Mode P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Teaching Mode learning loop. AI agents can fetch an approved workflow for an intent, replay its steps, and auto-propose newly-successful sessions; humans approve or reject in the Flows tab.

**Architecture:** Three layers added to existing P1 plumbing. `teach.js` grows a fuzzy intent matcher, three new endpoints (`GET /flows`, `POST /teach/sessions/:id/propose`, `PATCH /workflows/:id/status`), and per-field defaults on workflow read for backward compat. `android.js` forwards a new `replay_of` body field through to the capture pipeline. The Flows tab in `public/cam/index.html` splits its workflows column into Approved / Proposed / Rejected sub-sections with inline approve/reject controls. AI agents are guided via a new README section.

**Tech Stack:** Node.js + Express (existing `teach.js`, `android.js`), `node:test` framework, vanilla JS in `public/cam/index.html`. No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-05-20-teaching-mode-p3-design.md`](../specs/2026-05-20-teaching-mode-p3-design.md)

---

## File Structure

| File | Role | Disposition |
|---|---|---|
| `teach.js` | Pure `matchIntent` helper. Status/intent/source_kind defaults in `readWorkflow`. New endpoints: `GET /flows`, `POST /teach/sessions/:id/propose`, `PATCH /workflows/:id/status`. Extended `GET /workflows?status=` filter. `success_count` tracking in `endActive('done')` for replays. | **Modify** |
| `tests/teach.test.js` | Unit tests for `matchIntent`, backward-compat read, propose+approve flow, /flows match, success_count tracking. | **Modify** |
| `android.js` | `/android/tap` and `/android/swipe` handlers accept optional `replay_of` in body and forward to `teach.captureStep`. | **Modify** |
| `public/cam/index.html` | Workflows column in Flows tab splits into three sections. Proposed rows get inline approve/reject buttons. Active-session tracking learns `replay_of` for use_count increment. | **Modify** |
| `README.md` | New "AI agents using HumanAIE for phone control" section documenting the /flows → replay → propose contract. | **Modify** |

No new files. No new dependencies.

---

## Task Order Rationale

1. **Pure primitive first** — `matchIntent` standalone, TDD. Locks the scoring shape.
2. **Backward-compat field defaults** — Lets us add new fields without breaking P1 workflow.json reads. Required by every endpoint below.
3. **Write-side: status fields** — `promoteSessionToWorkflow` writes the new fields. After this, freshly-promoted workflows have full schema.
4. **POST /propose endpoint** — AI-side write path mirroring promote but for proposed status.
5. **PATCH /status endpoint** — Human-side approve/reject. Returns the updated workflow.
6. **GET /workflows status filter** — UI needs this to populate the Proposed/Rejected columns.
7. **GET /flows endpoint** — The big payoff. Uses everything above.
8. **`replay_of` forwarding in /android/{tap,swipe}** — Lets sessions know they came from a replay.
9. **success_count + use_count tracking** — Bumps the counters on the right lifecycle hooks.
10. **Flows tab UI: three-section workflows column** — Render Approved/Proposed/Rejected with status badges.
11. **Approve/reject handlers** — Wire the inline buttons in the Proposed/Rejected sections.
12. **README agent integration section** — The contract.
13. **End-to-end verification on `.90`** — Manual checklist + version bump.

Each task ends in a commit.

---

## Task 1: `matchIntent` pure helper

**Files:**
- Modify: `teach.js` — add `matchIntent` function + export
- Modify: `tests/teach.test.js` — add unit tests

- [ ] **Step 1: Write the failing tests**

Append to `tests/teach.test.js`:

```javascript
test('matchIntent returns 0.5 when no intent provided (package-only)', () => {
  const wf = { name: 'Post a photo', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, ''), 0.5);
  assert.strictEqual(teach.matchIntent(wf, null), 0.5);
});

test('matchIntent returns 0.9 on substring match against name', () => {
  const wf = { name: 'Post a photo', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, 'post a photo'), 0.9);
});

test('matchIntent returns 0.9 on substring match against intent field', () => {
  const wf = { name: 'Misc', intent: 'open the camera and snap' };
  assert.strictEqual(teach.matchIntent(wf, 'open the camera'), 0.9);
});

test('matchIntent is case-insensitive', () => {
  const wf = { name: 'Post a Photo', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, 'POST A PHOTO'), 0.9);
});

test('matchIntent returns hits/totalTokens on partial token overlap', () => {
  const wf = { name: 'Send a DM', intent: '' };
  // "send instagram" → tokens ≥3 chars: ["send","instagram"]; "send" hits, "instagram" misses → 1/2 = 0.5
  assert.strictEqual(teach.matchIntent(wf, 'send instagram'), 0.5);
});

test('matchIntent returns 0 when no tokens overlap', () => {
  const wf = { name: 'Send a DM', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, 'open settings'), 0);
});

test('matchIntent returns 0.4 floor when intent has no tokens >=3 chars', () => {
  const wf = { name: 'Send a DM', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, 'a b c'), 0.4);
});

test('matchIntent handles missing workflow fields gracefully', () => {
  const wf = {};
  assert.strictEqual(teach.matchIntent(wf, 'anything'), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/teach.test.js`
Expected: 8 new tests fail with `TypeError: teach.matchIntent is not a function`.

- [ ] **Step 3: Add `matchIntent` to `teach.js`**

In `teach.js`, append before the `module.exports` block:

```javascript
// ── Intent matching (P3 /flows) ─────────────────────────────────────────────
// Scores how well a workflow matches a free-text intent query. Pure function;
// no I/O. See spec 2026-05-20 § matchIntent for threshold rationale.
function matchIntent(workflow, queryIntent) {
  if (!queryIntent) return 0.5;
  const text = ((workflow && workflow.name || '') + ' ' + (workflow && workflow.intent || '')).toLowerCase();
  const q = String(queryIntent).toLowerCase();
  if (text && text.includes(q)) return 0.9;
  const tokens = q.split(/\W+/).filter(t => t.length >= 3);
  if (tokens.length === 0) return 0.4;
  const hits = tokens.filter(t => text.includes(t)).length;
  return hits / tokens.length;
}
```

Then update `module.exports` to include the new symbol — find the existing module.exports block at the end of `teach.js` and add `matchIntent` to it:

```javascript
module.exports = {
  // ... existing exports unchanged ...
  matchIntent,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/teach.test.js`
Expected: all tests pass (was 19 → now 27).

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: matchIntent pure helper for P3 /flows fuzzy matching"
```

---

## Task 2: Backward-compat field defaults in `readWorkflow` and `listWorkflows`

**Files:**
- Modify: `teach.js` — `readWorkflow` and `listWorkflows` apply field defaults on load
- Modify: `tests/teach.test.js` — add backward-compat test

- [ ] **Step 1: Add a backward-compat test**

Append to `tests/teach.test.js`:

```javascript
test('readWorkflow defaults P1-era missing fields (status, intent, source_kind, success_count)', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  // Write a P1-era workflow.json with only the original fields
  const pkgDir  = path.join(wfDir, 'com-foo', 'a', 'oldflow');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'workflow.json'), JSON.stringify({
    id: 'wf-old', name: 'Old flow', package: 'com.foo', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 'session-x', use_count: 0,
  }));
  const wf = teach.readWorkflow('wf-old');
  assert.ok(wf);
  assert.strictEqual(wf.status, 'approved');         // human-promoted in P1 → implicit approval
  assert.strictEqual(wf.intent, 'Old flow');         // defaults to name
  assert.strictEqual(wf.source_kind, 'human-promoted');
  assert.strictEqual(wf.success_count, 0);
  assert.strictEqual(wf.rejected_reason, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/teach.test.js`
Expected: fails because `wf.status` is `undefined`.

- [ ] **Step 3: Add a `withDefaults` helper and apply it in `readWorkflow`/`listWorkflows`**

In `teach.js`, find the `function readWorkflow(id) { ... }` definition. Above it, add:

```javascript
function withDefaults(wf) {
  if (!wf) return wf;
  return Object.assign({}, wf, {
    status:        wf.status        ?? 'approved',
    intent:        wf.intent        ?? wf.name ?? '',
    source_kind:   wf.source_kind   ?? 'human-promoted',
    success_count: wf.success_count ?? 0,
    rejected_reason: wf.rejected_reason ?? null,
  });
}
```

Then update `readWorkflow` to wrap its return:

```javascript
function readWorkflow(id) {
  for (const wf of listWorkflows()) if (wf.id === id) return wf;
  return null;
}
```

Becomes:

```javascript
function readWorkflow(id) {
  for (const wf of listWorkflows()) if (wf.id === id) return wf;  // already defaulted by listWorkflows
  return null;
}
```

And inside `listWorkflows`, the existing line that pushes to the `out` array:

```javascript
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
if (pkgFilter && wf.package !== pkgFilter) continue;
if (actFilter && wf.activity !== actFilter) continue;
out.push(wf);
```

Becomes:

```javascript
const wf = withDefaults(JSON.parse(fs.readFileSync(wfPath, 'utf-8')));
if (pkgFilter && wf.package !== pkgFilter) continue;
if (actFilter && wf.activity !== actFilter) continue;
out.push(wf);
```

Add `withDefaults` to `module.exports` for testability:

```javascript
module.exports = {
  // ... existing ...
  withDefaults,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/teach.test.js`
Expected: 28 tests pass.

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: workflow read defaults — P1 workflow.json gains status/intent/source_kind/success_count on load"
```

---

## Task 3: Status fields on write in `promoteSessionToWorkflow`

**Files:**
- Modify: `teach.js` — `promoteSessionToWorkflow` writes the new fields explicitly
- Modify: `tests/teach.test.js` — assert new fields land on disk

- [ ] **Step 1: Add a write-side test**

Append to `tests/teach.test.js`:

```javascript
test('promoteSessionToWorkflow writes status:approved and source_kind:human-promoted', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 },
    screenshotBuffer: Buffer.alloc(200, 0xff),
    metaArgs: { package: 'com.test', activity: '.A' } });
  const id = teach.getActive().id;
  teach.endActive('done');
  const wf = teach.promoteSessionToWorkflow(id, { name: 'Test flow' });
  assert.strictEqual(wf.status, 'approved');
  assert.strictEqual(wf.source_kind, 'human-promoted');
  assert.strictEqual(wf.intent, 'Test flow');         // defaults to name when not passed
  assert.strictEqual(wf.success_count, 0);
  assert.strictEqual(wf.rejected_reason, null);
  // Round-trip from disk
  const loaded = teach.readWorkflow(wf.id);
  assert.strictEqual(loaded.status, 'approved');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/teach.test.js`
Expected: fails because `promoteSessionToWorkflow` doesn't write `status` yet (the on-disk file lacks it, and even though `readWorkflow` defaults it, the in-memory `wf` returned by promote doesn't have it set).

- [ ] **Step 3: Update `promoteSessionToWorkflow` to write the new fields**

Find `promoteSessionToWorkflow` in `teach.js`. The `wf` object literal it constructs currently ends with `use_count: 0,`. Replace that object literal with the version below (add four new fields, keep all existing):

```javascript
const wf = {
  id: 'wf-' + Date.now(),
  name: String(name || 'Untitled'),
  intent: String(name || ''),                  // NEW — defaults to name; AI may override via /propose
  status: 'approved',                          // NEW — explicit Save = approved
  source_kind: 'human-promoted',               // NEW
  package: session.package,
  activity: session.activity,
  screen_w: session.screen_w,
  screen_h: session.screen_h,
  steps: session.steps,
  created_at: Date.now(),
  updated_at: Date.now(),
  source: sessionId,
  use_count: 0,
  success_count: 0,                            // NEW
  rejected_reason: null,                       // NEW
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 29 tests pass.

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: promoteSessionToWorkflow writes status/intent/source_kind/success_count fields"
```

---

## Task 4: `POST /teach/sessions/:id/propose` endpoint

**Files:**
- Modify: `teach.js` — add `proposeSessionAsWorkflow` helper + router handler
- Modify: `tests/teach.test.js` — smoke test on a fresh server

- [ ] **Step 1: Add `proposeSessionAsWorkflow` to `teach.js`**

Find `promoteSessionToWorkflow` in `teach.js`. Below it (still before the router section), add:

```javascript
function proposeSessionAsWorkflow(sessionId, { name, intent }) {
  // Same on-disk shape as promote but with proposed status — used by AI
  // agents auto-saving successful sessions for human review.
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
    intent: String(intent || name || ''),
    status: 'proposed',
    source_kind: 'agent-proposed',
    package: session.package,
    activity: session.activity,
    screen_w: session.screen_w,
    screen_h: session.screen_h,
    steps: session.steps,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: sessionId,
    use_count: 0,
    success_count: 0,
    rejected_reason: null,
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}
```

Add to `module.exports`:

```javascript
module.exports = {
  // ... existing ...
  proposeSessionAsWorkflow,
};
```

- [ ] **Step 2: Add the router handler**

Find the existing `router.post('/teach/sessions/:id/promote', ...)` handler in `teach.js`. Below it, add:

```javascript
router.post('/teach/sessions/:id/propose', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const name = req.body && req.body.name;
  const intent = req.body && req.body.intent;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const wf = proposeSessionAsWorkflow(req.params.id, { name, intent });
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
```

- [ ] **Step 3: Add a smoke test**

Append to `tests/teach.test.js`:

```javascript
test('POST /teach/sessions/:id/propose creates a proposed workflow', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13341', HUMANAIE_DATA_DIR: dataDir },
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

  // Manually create a session on disk (avoids needing /android/* in tests)
  const teachDir = path.join(dataDir, 'humanaie-sessions');
  const sid = 'teach-9999';
  fs.mkdirSync(path.join(teachDir, sid), { recursive: true });
  fs.writeFileSync(path.join(teachDir, sid, 'meta.json'), JSON.stringify({
    id: sid, package: 'com.test', activity: '.A', screen_w: 1080, screen_h: 2340,
    started_at: 1000, ended_at: 2000, end_reason: 'done', steps_count: 0,
  }));
  fs.writeFileSync(path.join(teachDir, sid, 'steps.jsonl'), '');

  const res = await fetch('http://127.0.0.1:13341/teach/sessions/' + sid + '/propose', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test proposal', intent: 'test the propose endpoint' }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.workflow);
  assert.strictEqual(body.workflow.status, 'proposed');
  assert.strictEqual(body.workflow.source_kind, 'agent-proposed');
  assert.strictEqual(body.workflow.intent, 'test the propose endpoint');
});
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 30 tests pass.

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: POST /teach/sessions/:id/propose — AI auto-promotes successful session as proposed workflow"
```

---

## Task 5: `PATCH /workflows/:id/status` endpoint

**Files:**
- Modify: `teach.js` — add the router handler
- Modify: `tests/teach.test.js` — smoke test happy path + invalid status

- [ ] **Step 1: Add the router handler**

Find the existing `router.patch('/workflows/:id', ...)` handler in `teach.js`. Below it, add:

```javascript
router.patch('/workflows/:id/status', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const status = req.body && req.body.status;
  if (status !== 'proposed' && status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: 'status must be proposed/approved/rejected' });
  }
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  wf.status = status;
  wf.rejected_reason = (status === 'rejected') ? (req.body.rejected_reason || null) : null;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(req.params.id);
  if (!wfPath) return res.status(500).json({ error: 'cannot resolve workflow path' });
  writeWorkflowJson(wfPath, wf);
  res.json({ ok: true, workflow: wf });
});
```

- [ ] **Step 2: Add tests**

Append to `tests/teach.test.js`:

```javascript
test('PATCH /workflows/:id/status accepts approved/proposed/rejected', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13342', HUMANAIE_DATA_DIR: dataDir },
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

  // Seed a workflow on disk
  const wfDir = path.join(dataDir, 'workflows', 'com-test', 'a', 'seed');
  fs.mkdirSync(wfDir, { recursive: true });
  const wfId = 'wf-seed-1';
  fs.writeFileSync(path.join(wfDir, 'workflow.json'), JSON.stringify({
    id: wfId, name: 'Seed', intent: 'seed', status: 'proposed',
    source_kind: 'agent-proposed', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 'seed', use_count: 0, success_count: 0, rejected_reason: null,
  }));

  // Approve
  const approved = await fetch('http://127.0.0.1:13342/workflows/' + wfId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.strictEqual(approved.status, 200);
  const approvedBody = await approved.json();
  assert.strictEqual(approvedBody.workflow.status, 'approved');
  assert.strictEqual(approvedBody.workflow.rejected_reason, null);

  // Reject with reason
  const rejected = await fetch('http://127.0.0.1:13342/workflows/' + wfId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', rejected_reason: 'flow is wrong' }),
  });
  assert.strictEqual(rejected.status, 200);
  const rejectedBody = await rejected.json();
  assert.strictEqual(rejectedBody.workflow.status, 'rejected');
  assert.strictEqual(rejectedBody.workflow.rejected_reason, 'flow is wrong');

  // Invalid status
  const bad = await fetch('http://127.0.0.1:13342/workflows/' + wfId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'maybe' }),
  });
  assert.strictEqual(bad.status, 400);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 31 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: PATCH /workflows/:id/status — human approves/rejects, clears rejected_reason on non-rejected status"
```

---

## Task 6: `?status=` filter on `GET /workflows`

**Files:**
- Modify: `teach.js` — extend the `/workflows` handler's `listWorkflows` filter
- Modify: `tests/teach.test.js` — smoke test the filter

- [ ] **Step 1: Extend `listWorkflows` to accept a status filter**

Find `function listWorkflows({ package: pkgFilter, activity: actFilter } = {}) { ... }` in `teach.js`. Change the signature and add a status filter:

```javascript
function listWorkflows({ package: pkgFilter, activity: actFilter, status: statusFilter } = {}) {
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
          const wf = withDefaults(JSON.parse(fs.readFileSync(wfPath, 'utf-8')));
          if (pkgFilter && wf.package !== pkgFilter) continue;
          if (actFilter && wf.activity !== actFilter) continue;
          if (statusFilter && wf.status !== statusFilter) continue;
          out.push(wf);
        } catch {}
      }
    }
  }
  out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return out;
}
```

Find the existing `router.get('/workflows', ...)` handler. Update it to forward the `status` query param:

```javascript
router.get('/workflows', (req, res) => {
  res.json(listWorkflows({
    package: req.query.package,
    activity: req.query.activity,
    status: req.query.status,
  }));
});
```

- [ ] **Step 2: Add a filter test**

Append to `tests/teach.test.js`:

```javascript
test('GET /workflows?status=proposed returns only proposed workflows', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13343', HUMANAIE_DATA_DIR: dataDir },
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

  // Seed three workflows: one approved, one proposed, one rejected
  const baseDir = path.join(dataDir, 'workflows', 'com-test', 'a');
  for (const [slug, status, id] of [['ap', 'approved', 'wf-ap'], ['pr', 'proposed', 'wf-pr'], ['rj', 'rejected', 'wf-rj']]) {
    const dir = path.join(baseDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
      id, name: slug, intent: slug, status, source_kind: 'human-promoted',
      package: 'com.test', activity: 'a', screen_w: 1080, screen_h: 2340,
      steps: [], created_at: 1000, updated_at: 1000, source: 's', use_count: 0,
      success_count: 0, rejected_reason: null,
    }));
  }

  const all = await fetch('http://127.0.0.1:13343/workflows').then(r => r.json());
  assert.strictEqual(all.length, 3);

  const proposed = await fetch('http://127.0.0.1:13343/workflows?status=proposed').then(r => r.json());
  assert.strictEqual(proposed.length, 1);
  assert.strictEqual(proposed[0].id, 'wf-pr');
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 32 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: GET /workflows?status= filter for Flows tab Proposed/Rejected columns"
```

---

## Task 7: `GET /flows` endpoint

**Files:**
- Modify: `teach.js` — add the `/flows` handler
- Modify: `tests/teach.test.js` — multiple match scenarios

- [ ] **Step 1: Add the `/flows` router handler**

Find the existing router handlers in `teach.js`. After the `GET /workflows` handler, add:

```javascript
router.get('/flows', (req, res) => {
  const minStatus = req.query.min_status || 'approved';
  const candidates = listWorkflows({
    package: req.query.package,
    activity: req.query.activity,
    status: minStatus,
  });
  if (candidates.length === 0) {
    return res.json({ workflow: null, reason: 'no candidates' });
  }
  const ranked = candidates.map(w => ({ w, score: matchIntent(w, req.query.intent) }))
                            .sort((a, b) => {
                              if (b.score !== a.score) return b.score - a.score;
                              // Tiebreaker: higher success_count wins, then most recent
                              if ((b.w.success_count || 0) !== (a.w.success_count || 0)) {
                                return (b.w.success_count || 0) - (a.w.success_count || 0);
                              }
                              return (b.w.updated_at || 0) - (a.w.updated_at || 0);
                            });
  const best = ranked[0];
  if (best.score < 0.4) {
    return res.json({ workflow: null, reason: 'low confidence', confidence: best.score });
  }
  // Bump use_count: this is the "attempt" signal — AI fetched the flow
  // intending to replay it. success_count is bumped separately by
  // endActive() on /teach/done if the replay actually completes.
  try {
    best.w.use_count = (best.w.use_count || 0) + 1;
    best.w.updated_at = Date.now();
    const wfPath = workflowPathById(best.w.id);
    if (wfPath) writeWorkflowJson(wfPath, best.w);
  } catch {}
  res.json({ workflow: best.w, confidence: best.score });
});
```

- [ ] **Step 2: Add /flows tests**

Append to `tests/teach.test.js`:

```javascript
test('GET /flows returns workflow:null when no candidates', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13344', HUMANAIE_DATA_DIR: dataDir },
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

  const res = await fetch('http://127.0.0.1:13344/flows?package=com.nothing&intent=anything').then(r => r.json());
  assert.strictEqual(res.workflow, null);
  assert.strictEqual(res.reason, 'no candidates');
});

test('GET /flows returns top match above threshold', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13345', HUMANAIE_DATA_DIR: dataDir },
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

  // Seed two approved workflows
  const baseDir = path.join(dataDir, 'workflows', 'com-test', 'a');
  fs.mkdirSync(path.join(baseDir, 'post'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'post', 'workflow.json'), JSON.stringify({
    id: 'wf-post', name: 'Post a photo', intent: 'post a photo to feed',
    status: 'approved', source_kind: 'human-promoted',
    package: 'com.test', activity: 'a', screen_w: 1080, screen_h: 2340,
    steps: [], created_at: 1000, updated_at: 1000, source: 's', use_count: 0,
    success_count: 5, rejected_reason: null,
  }));
  fs.mkdirSync(path.join(baseDir, 'dm'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'dm', 'workflow.json'), JSON.stringify({
    id: 'wf-dm', name: 'Send DM', intent: 'send a direct message',
    status: 'approved', source_kind: 'human-promoted',
    package: 'com.test', activity: 'a', screen_w: 1080, screen_h: 2340,
    steps: [], created_at: 1000, updated_at: 1000, source: 's', use_count: 0,
    success_count: 0, rejected_reason: null,
  }));

  const res = await fetch('http://127.0.0.1:13345/flows?package=com.test&intent=post%20a%20photo').then(r => r.json());
  assert.ok(res.workflow);
  assert.strictEqual(res.workflow.id, 'wf-post');
  assert.ok(res.confidence >= 0.9);
  // use_count was 0 in the seed; /flows return should have bumped it to 1
  assert.strictEqual(res.workflow.use_count, 1);

  // Calling /flows again should bump use_count to 2
  const res2 = await fetch('http://127.0.0.1:13345/flows?package=com.test&intent=post%20a%20photo').then(r => r.json());
  assert.strictEqual(res2.workflow.use_count, 2);
});

test('GET /flows returns workflow:null when only proposed workflows exist (default min_status=approved)', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13346', HUMANAIE_DATA_DIR: dataDir },
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

  const dir = path.join(dataDir, 'workflows', 'com-test', 'a', 'proposed-only');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-prop', name: 'Send DM', intent: 'send dm',
    status: 'proposed', source_kind: 'agent-proposed',
    package: 'com.test', activity: 'a', screen_w: 1080, screen_h: 2340,
    steps: [], created_at: 1000, updated_at: 1000, source: 's', use_count: 0,
    success_count: 0, rejected_reason: null,
  }));

  // Default min_status=approved should filter it out
  const def = await fetch('http://127.0.0.1:13346/flows?package=com.test&intent=send%20dm').then(r => r.json());
  assert.strictEqual(def.workflow, null);

  // min_status=proposed should return it
  const prop = await fetch('http://127.0.0.1:13346/flows?package=com.test&intent=send%20dm&min_status=proposed').then(r => r.json());
  assert.ok(prop.workflow);
  assert.strictEqual(prop.workflow.id, 'wf-prop');
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 35 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: GET /flows — fuzzy intent matcher returns top approved workflow + confidence"
```

---

## Task 8: `replay_of` forwarding in `/android/{tap,swipe}`

**Files:**
- Modify: `android.js` — read `replay_of` from request body, pass through to `teach.captureStep`
- Modify: `teach.js` — `captureStep` accepts and persists `replay_of` field

- [ ] **Step 1: Extend `captureStep` to record `replay_of` on the session**

In `teach.js`, find the `captureStep` function:

```javascript
function captureStep({ action, args, screenshotBuffer = null, metaArgs = null }) {
  if (!activeSession || activeSession.ended_at !== null) startSession(metaArgs || {});
  // ...
}
```

Change the signature and add the field-write block at the top of the body, AFTER startSession:

```javascript
function captureStep({ action, args, screenshotBuffer = null, metaArgs = null, replay_of = null }) {
  if (!activeSession || activeSession.ended_at !== null) startSession(metaArgs || {});
  // Tag the active session with replay_of on the FIRST call that supplies it.
  // Subsequent calls in the same session don't re-tag (a session represents
  // one replay attempt; replay_of is set-once).
  if (replay_of && !activeSession.replay_of) {
    activeSession.replay_of = String(replay_of);
  }
  const step = appendStep(activeSession, { action, args });
  // ... rest unchanged
}
```

Also update `writeSessionMeta` to persist the `replay_of` field. Find the existing `writeSessionMeta` function and update the `meta` object literal:

```javascript
const meta = {
  // ... existing fields ...
  replay_of: session.replay_of ?? null,
};
```

- [ ] **Step 2: Forward `replay_of` from /tap handler**

In `android.js`, find `router.post('/tap', ...)`. Locate the `teach.captureStep({ ... })` call inside it. Add `replay_of` to the captureStep args:

```javascript
teach.captureStep({
  action: 'tap', args: { x: xi, y: yi },
  screenshotBuffer: captureSessionFrame(),
  metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
  replay_of: req.body && req.body.replay_of,
});
```

- [ ] **Step 3: Forward `replay_of` from /swipe handler**

In `android.js`, find `router.post('/swipe', ...)`. Add `replay_of` the same way:

```javascript
teach.captureStep({
  action: 'swipe',
  args: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), dur: safeDur },
  screenshotBuffer: captureSessionFrame(),
  metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
  replay_of: req.body && req.body.replay_of,
});
```

- [ ] **Step 4: Add a test for the replay_of forwarding**

Append to `tests/teach.test.js`:

```javascript
test('captureStep records replay_of on the session', () => {
  const root = tmpDir();
  teach.configure({ rootDir: root });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({
    action: 'tap', args: { x: 1, y: 2 },
    metaArgs: { package: 'com.foo', activity: '.a' },
    replay_of: 'wf-abc',
  });
  const active = teach.getActive();
  assert.strictEqual(active.replay_of, 'wf-abc');

  // Subsequent capture without replay_of doesn't clear it
  teach.captureStep({ action: 'tap', args: { x: 3, y: 4 } });
  assert.strictEqual(teach.getActive().replay_of, 'wf-abc');

  teach.endActive('test-cleanup');
});
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 36 tests pass. Plus `node -e "require('./android.js'); console.log('ok')"` returns `ok`.

- [ ] **Step 6: Commit**

```bash
git add android.js teach.js tests/teach.test.js
git commit -m "feat: /android/{tap,swipe} forwards replay_of to captureStep; session meta.json records the source workflow"
```

---

## Task 9: `success_count` increment on `/teach/done` after replay

**Files:**
- Modify: `teach.js` — `endActive` bumps source workflow's `success_count` when the session has `replay_of` and `end_reason === 'done'`
- Modify: `tests/teach.test.js` — verify the counter increments

- [ ] **Step 1: Extend `endActive` to update workflow counters**

In `teach.js`, find `function endActive(reason) { ... }`. Update it to inspect `replay_of` after finalizing:

```javascript
function endActive(reason) {
  if (!activeSession || activeSession.ended_at !== null) return null;
  finalizeSession(activeSession, { end_reason: reason });
  // If this session was a replay, increment the source workflow's success
  // counter on a 'done' finish (any other end_reason = the replay didn't
  // complete cleanly, don't credit it).
  if (reason === 'done' && activeSession.replay_of && workflowsRoot) {
    try {
      const wf = readWorkflow(activeSession.replay_of);
      if (wf) {
        wf.success_count = (wf.success_count || 0) + 1;
        wf.updated_at = Date.now();
        const wfPath = workflowPathById(wf.id);
        if (wfPath) writeWorkflowJson(wfPath, wf);
      }
    } catch {}
  }
  if (teachRoot) writeSessionMeta(teachRoot, activeSession);
  clearIdleTimer();
  const finished = activeSession;
  activeSession = null;
  return finished;
}
```

- [ ] **Step 2: Add a test**

Append to `tests/teach.test.js`:

```javascript
test('endActive(done) bumps source workflow success_count when replay_of is set', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');

  // Seed a workflow on disk
  const dir = path.join(wfDir, 'com-foo', 'a', 'src');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-src', name: 'Source', intent: 'source', status: 'approved',
    source_kind: 'human-promoted', package: 'com.foo', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
  }));

  // Start a replay session and end it with 'done'
  teach.captureStep({
    action: 'tap', args: { x: 1, y: 2 },
    metaArgs: { package: 'com.foo', activity: 'a' },
    replay_of: 'wf-src',
  });
  teach.endActive('done');

  const wf = teach.readWorkflow('wf-src');
  assert.strictEqual(wf.success_count, 1);

  // Stuck end should NOT increment
  teach.captureStep({
    action: 'tap', args: { x: 1, y: 2 },
    metaArgs: { package: 'com.foo', activity: 'a' },
    replay_of: 'wf-src',
  });
  teach.endActive('stuck');
  const wf2 = teach.readWorkflow('wf-src');
  assert.strictEqual(wf2.success_count, 1);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: 37 tests pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: success_count increments on /teach/done for replay sessions (non-'done' end reasons skipped)"
```

---

## Task 10: Flows tab — three-section workflows column

**Files:**
- Modify: `public/cam/index.html` — `renderTeachLanding` replaces the single workflows column with three sub-sections (Approved / Proposed / Rejected). Each row gets a status badge.

- [ ] **Step 1: Locate `renderTeachLanding`**

Run: `grep -n "function renderTeachLanding" public/cam/index.html` — should match one line.

- [ ] **Step 2: Replace the single workflows-column build with three sub-sections**

Find this block inside `renderTeachLanding`:

```javascript
      grid.appendChild(buildLandingColumn('Recent attempts (click any → review + save as flow)', sessions, renderSessionRow));
      grid.appendChild(buildLandingColumn('Approved flows (AI references these on repeat tasks)', workflows, renderWorkflowRow));
```

Replace with:

```javascript
      grid.appendChild(buildLandingColumn('Recent attempts (click any → review + save as flow)', sessions, renderSessionRow));
      grid.appendChild(buildWorkflowsColumn(workflows));
```

Then below `renderTeachLanding` (or anywhere within the same script block), add the new `buildWorkflowsColumn` function:

```javascript
  function buildWorkflowsColumn(workflows) {
    var col = document.createElement('div');
    var approved = workflows.filter(function(w) { return w.status === 'approved'; });
    var proposed = workflows.filter(function(w) { return w.status === 'proposed'; });
    var rejected = workflows.filter(function(w) { return w.status === 'rejected'; });

    col.appendChild(buildSubSection('✅ Approved flows (AI references these on repeat tasks)', approved, renderWorkflowRow, false));
    col.appendChild(buildSubSection('🟡 Proposed (review)', proposed, renderProposedRow, false));
    col.appendChild(buildSubSection('🗑 Rejected', rejected, renderRejectedRow, true));  // collapsed by default

    return col;
  }

  function buildSubSection(title, items, rowBuilder, collapsedByDefault) {
    var sec = document.createElement('div');
    sec.style.cssText = 'margin-bottom:12px';
    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:13px;font-weight:bold;margin-bottom:6px;border-bottom:1px solid #2a2a2a;padding-bottom:3px;cursor:pointer;user-select:none';
    var body = document.createElement('div');
    body.style.display = collapsedByDefault ? 'none' : 'block';
    var caret = collapsedByDefault ? '▶' : '▼';
    hdr.textContent = caret + ' ' + title + ' (' + items.length + ')';
    hdr.addEventListener('click', function() {
      var shown = body.style.display !== 'none';
      body.style.display = shown ? 'none' : 'block';
      hdr.textContent = (shown ? '▶' : '▼') + ' ' + title + ' (' + items.length + ')';
    });
    sec.appendChild(hdr);
    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:11px;font-style:italic;padding:4px 0';
      empty.textContent = '(none)';
      body.appendChild(empty);
    } else {
      items.forEach(function(item) { body.appendChild(rowBuilder(item)); });
    }
    sec.appendChild(body);
    return sec;
  }

  function renderProposedRow(w) {
    var row = document.createElement('div');
    row.className = 'teach-workflow-row';
    row.style.cssText = 'background:#0a0a0a;border:1px solid #2a2a2a;border-left:3px solid #cccc55;border-radius:4px;padding:8px;margin-bottom:6px;display:flex;align-items:center;gap:6px';
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;cursor:pointer';
    info.addEventListener('click', function() { openTeachEditor(w.id, 'workflow'); });
    var name = document.createElement('div');
    name.style.cssText = 'font-size:12px;color:#cccc55;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = w.name;
    info.appendChild(name);
    var meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#666;margin-top:2px';
    var stepCount = (w.steps && w.steps.length) || 0;
    meta.textContent = (w.package || '—') + ' · ' + stepCount + ' steps · ' + (w.source_kind || '');
    info.appendChild(meta);
    row.appendChild(info);
    var approveBtn = document.createElement('button');
    approveBtn.className = 'nav-btn';
    approveBtn.style.cssText = 'background:#0a3a18;color:#3ddc84;border:1px solid #3ddc84;padding:2px 6px;font-size:10px;cursor:pointer';
    approveBtn.textContent = '✓';
    approveBtn.title = 'Approve';
    approveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      approveWorkflow(w.id);
    });
    row.appendChild(approveBtn);
    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'nav-btn';
    rejectBtn.style.cssText = 'background:#3a1818;color:#ff6666;border:1px solid #d80000;padding:2px 6px;font-size:10px;cursor:pointer';
    rejectBtn.textContent = '✕';
    rejectBtn.title = 'Reject';
    rejectBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      rejectWorkflow(w.id);
    });
    row.appendChild(rejectBtn);
    return row;
  }

  function renderRejectedRow(w) {
    var row = document.createElement('div');
    row.className = 'teach-workflow-row';
    row.style.cssText = 'background:#0a0a0a;border:1px solid #2a2a2a;border-left:3px solid #666;border-radius:4px;padding:8px;margin-bottom:6px;display:flex;align-items:center;gap:6px;opacity:0.6';
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    var name = document.createElement('div');
    name.style.cssText = 'font-size:12px;color:#888;text-decoration:line-through;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = w.name;
    info.appendChild(name);
    if (w.rejected_reason) {
      var reason = document.createElement('div');
      reason.style.cssText = 'font-size:10px;color:#888;margin-top:2px;font-style:italic';
      reason.textContent = '"' + w.rejected_reason + '"';
      info.appendChild(reason);
    }
    row.appendChild(info);
    var unBtn = document.createElement('button');
    unBtn.className = 'nav-btn';
    unBtn.style.cssText = 'background:transparent;color:#888;border:1px solid #444;padding:2px 6px;font-size:10px;cursor:pointer';
    unBtn.textContent = '↻ Un-reject';
    unBtn.title = 'Re-propose for review';
    unBtn.addEventListener('click', function() { unrejectWorkflow(w.id); });
    row.appendChild(unBtn);
    return row;
  }
```

Note: this assumes `renderWorkflowRow` (from P1) still exists and renders the approved row. It does — leave it untouched. It will be called for the Approved sub-section via `buildSubSection`. P1's `renderWorkflowRow` shows the name + (N×) counter; that's exactly what we want for Approved.

- [ ] **Step 3: Stub the approve/reject/unreject handlers (Task 11 wires them)**

Add these stubs anywhere in the same script block (Task 11 fills in the implementation):

```javascript
  function approveWorkflow(id) {
    console.log('approveWorkflow stub', id);
  }
  function rejectWorkflow(id) {
    console.log('rejectWorkflow stub', id);
  }
  function unrejectWorkflow(id) {
    console.log('unrejectWorkflow stub', id);
  }
```

- [ ] **Step 4: Verify static HTML serves**

Run: `grep -c "buildWorkflowsColumn\|renderProposedRow\|renderRejectedRow" public/cam/index.html` — should be ≥ 4 matches.

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: Flows tab workflows column splits into ✅ Approved / 🟡 Proposed / 🗑 Rejected"
```

---

## Task 11: Wire approve/reject/unreject handlers

**Files:**
- Modify: `public/cam/index.html` — replace the stubs from Task 10 with real PATCH calls + re-render

- [ ] **Step 1: Replace the stubs**

Find the three stub functions added in Task 10. Replace them with:

```javascript
  function approveWorkflow(id) {
    fetch('/workflows/' + encodeURIComponent(id) + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Approve failed: ' + d.error); return; }
      renderTeachLanding();
    }).catch(function(err) { console.warn('approve failed', err); });
  }

  function rejectWorkflow(id) {
    var reason = prompt('Why are you rejecting this flow? (optional)', '');
    if (reason === null) return;  // user cancelled
    fetch('/workflows/' + encodeURIComponent(id) + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', rejected_reason: reason || null }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Reject failed: ' + d.error); return; }
      renderTeachLanding();
    }).catch(function(err) { console.warn('reject failed', err); });
  }

  function unrejectWorkflow(id) {
    fetch('/workflows/' + encodeURIComponent(id) + '/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'proposed' }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Un-reject failed: ' + d.error); return; }
      renderTeachLanding();
    }).catch(function(err) { console.warn('unreject failed', err); });
  }
```

- [ ] **Step 2: Verify**

Run: `grep -c "approveWorkflow\|rejectWorkflow\|unrejectWorkflow" public/cam/index.html` — should be ≥ 6 (3 definitions + 3 button bindings from Task 10).

- [ ] **Step 3: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: approve/reject/unreject buttons PATCH /workflows/:id/status + reload landing"
```

---

## Task 12: README — AI agents integration section

**Files:**
- Modify: `README.md` — add a new section explaining the /flows → replay → /propose contract for AI agents

- [ ] **Step 1: Add the section**

Find the existing `## AI Integration` section in `README.md` (around line 244). Below it, add a new sub-section:

```markdown
### Phone agent workflow (P3 — Teaching Mode replay)

AI agents driving the connected phone should consult approved flows before
exploring. The contract:

1. **Before starting a multi-step task, query for an approved flow:**

   ```
   GET /flows?package=com.instagram.android&intent=post%20a%20photo
   ```

   Returns `{ workflow, confidence }` if a match is found above the 0.4
   confidence threshold, or `{ workflow: null, reason }` otherwise.

2. **If a flow comes back, execute its steps in order:**

   ```
   POST /android/tap   { "x": 540, "y": 1200, "replay_of": "wf-..." }
   POST /android/swipe { "x1": 540, "y1": 1800, "x2": 540, "y2": 600, "dur": 250, "replay_of": "wf-..." }
   ```

   Pass `replay_of` in each request so the captured session links back to the
   source workflow. The server tracks `use_count` (attempts) and `success_count`
   (completed via `/teach/done`).

3. **On success, call `POST /teach/done`.** If you get stuck mid-replay, call
   `POST /waitfor-highlight` with a clear question; the human's resolution is
   captured as part of the session and you can resume.

4. **If no flow matched and you succeeded by exploring, propose your session
   as a new workflow:**

   ```
   POST /teach/sessions/:id/propose
   { "name": "Post a photo", "intent": "post a photo to instagram feed" }
   ```

   The proposed flow appears in the 🟡 Proposed column of the Flows tab. After
   the human clicks ✓ Approve, subsequent runs will pick it up via `/flows`.

5. **Cultural rule (not server-enforced):** if you've tried more than ~3 times
   to find an unknown UI element, stop spamming and call `/waitfor-highlight`
   instead. Burning tokens on retries when the human is one click away is the
   anti-pattern Teaching Mode is designed to eliminate.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README — AI agent integration for /flows + replay + propose contract"
```

---

## Task 13: Manual end-to-end verification on `.90`

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
systemd-run --user --scope --no-block <phone-home>/.nvm/versions/node/v22.22.1/bin/node <phone-home>/projects/HumanAIE/server.js
```

Close + reopen the browser tab on `http://<phone-host>:3333/cam/`.

- [ ] **Step 2: Verify the three-section workflows column**

Click 📂 Flows. The right column should show three sub-sections:
- ✅ Approved flows (N)
- 🟡 Proposed (review) (0)
- 🗑 Rejected — collapsed, expand to confirm (0)

Existing P1 workflows should all show up under ✅ Approved.

- [ ] **Step 3: Test AI auto-propose**

From a terminal:
```bash
# Simulate AI: capture a session by tapping in HANDROID
curl -X POST -H 'content-type: application/json' -d '{"x":540,"y":1500}' \
  http://<phone-host>:3333/android/tap

# Auto-propose the active session (need its ID first)
SESS=$(curl -sS http://<phone-host>:3333/teach/sessions | jq -r '.[0].id')
curl -X POST -H 'content-type: application/json' -d '{"name":"Test propose","intent":"test the propose flow"}' \
  http://<phone-host>:3333/teach/sessions/$SESS/propose
```

Reload 📂 Flows. "Test propose" should appear in the 🟡 Proposed (1) section with ✓ and ✕ buttons.

- [ ] **Step 4: Approve via UI**

Click ✓ on the proposed row. The row should disappear from Proposed and reappear in ✅ Approved.

- [ ] **Step 5: Test GET /flows**

```bash
curl -sS "http://<phone-host>:3333/flows?package=com.test&intent=test%20the%20propose%20flow" | jq
```

Expected JSON: `{ workflow: { id: "...", name: "Test propose", status: "approved", ... }, confidence: 0.9 }`.

- [ ] **Step 6: Test reject**

In the Flows tab, click + Add to create another proposed workflow (or use curl again with a different name). On the new proposed row, click ✕. When prompted, type "wrong layout" and confirm. The row should move to 🗑 Rejected.

Expand the 🗑 Rejected section. The row should show the line-through name + the italic reason "wrong layout" + an `↻ Un-reject` button.

- [ ] **Step 7: Test un-reject**

Click `↻ Un-reject` on the rejected row. It should move back to 🟡 Proposed.

- [ ] **Step 8: Test success_count increment**

Find a workflow's ID in the Approved column (or via `curl /workflows`). Simulate an AI replay:

```bash
WFID="wf-..."  # paste an approved workflow ID
curl -X POST -H 'content-type: application/json' \
  -d '{"x":540,"y":1200,"replay_of":"'$WFID'"}' \
  http://<phone-host>:3333/android/tap
curl -X POST -H 'content-type: application/json' -d '{}' \
  http://<phone-host>:3333/teach/done
```

Reload Flows. The workflow's `(N×)` counter should have incremented.

- [ ] **Step 9: Bump to v1.5.0 if all green**

```bash
sed -i 's/"version": "1.4.0"/"version": "1.5.0"/' package.json
sed -i 's/v1\.4\.0/v1.5.0/g' public/cam/index.html
git add package.json public/cam/index.html
git commit -m "chore: bump to v1.5.0 — Teaching Mode P3 (replay + approval) shipped"
git push origin main
```

- [ ] **Step 10: Document any failures as fix commits on `main`**

Same pattern as P1's E2E — small focused commits, one issue per commit, bisect-friendly.

---

## Done criteria

- [ ] `node --test tests/teach.test.js` passes 37 tests
- [ ] P1 workflows still load with `status: "approved"` (backward compat)
- [ ] AI can POST /teach/sessions/:id/propose and get a workflow in `status: "proposed"`
- [ ] Human can PATCH /workflows/:id/status to approve/reject
- [ ] GET /flows returns the top approved match by intent text, confidence ≥ 0.4
- [ ] GET /flows respects min_status=approved by default
- [ ] /android/{tap,swipe} forwards replay_of into session metadata
- [ ] /teach/done increments source workflow's success_count when session was a replay
- [ ] Flows tab UI shows three sections with approve/reject buttons on Proposed
- [ ] README has the AI agent integration section
- [ ] `.90` E2E checklist green
- [ ] package.json bumped to 1.5.0
