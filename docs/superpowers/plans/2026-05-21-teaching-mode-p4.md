# Teaching Mode P4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn workflows into a per-app, AI-co-maintained skill library. AI can browse the catalog, flag degraded flows, propose step edits; human stays in the approval seat for every change.

**Architecture:** All work lands in `teach.js` (new endpoints + sibling-edit lifecycle), `public/cam/index.html` (per-app grouping + diff view + flag badge), and `README.md` (AI contract additions). Workflow.json schema gains five new fields with backward-compat defaults applied at read-time via the existing `withDefaults` helper. Proposed-edit workflows are siblings of their parent on disk; approving the edit merges its `steps` into the parent and deletes the sibling.

**Tech Stack:** Node.js + Express (existing `teach.js`), `node:test` framework, vanilla JS in `public/cam/index.html`. No new dependencies.

**Spec reference:** [`docs/superpowers/specs/2026-05-21-teaching-mode-p4-design.md`](../specs/2026-05-21-teaching-mode-p4-design.md)

---

## File Structure

| File | Role | Disposition |
|---|---|---|
| `teach.js` | New: `flagWorkflow`, `unflagWorkflow`, `proposeWorkflowEdit`, `applyEditToParent`. Modified: `withDefaults` (5 new defaults), `PATCH /workflows/:id/status` (sibling-edit handling), `promoteSessionToWorkflow` + `proposeSessionAsWorkflow` (5 new fields on write). New endpoints: `GET /flows/catalog`, `POST /workflows/:id/flag`, `POST /workflows/:id/unflag`, `POST /workflows/:id/propose-edit`. | **Modify** |
| `tests/teach.test.js` | Unit tests for the 4 new helpers + backward-compat for new fields. Endpoint smoke tests for catalog / flag / unflag / propose-edit / approve-edit / reject-edit. | **Modify** |
| `public/cam/index.html` | Flows tab right column: per-app grouping with collapsible headers + 🟠 Proposed edits sub-section. Flag ⚠ badge on approved rows with hover tooltip. Proposed-edit diff view (modal extension). Right-click "Unflag" menu. | **Modify** |
| `README.md` | "Skill discovery", "Flagging a degraded flow", "Proposing an edit", "Cultural rule (P4 amendment)" sub-sections under the existing AI Agents section. | **Modify** |

No new files. No new dependencies.

---

## Task Order Rationale

1. **Backward-compat read defaults first** — extending `withDefaults` is the foundation. Every subsequent task reads workflows that might lack the new fields.
2. **Status fields on write paths** — `promoteSessionToWorkflow` and `proposeSessionAsWorkflow` both gain the 5 new fields (defaulted explicitly on disk) so freshly-created workflows have full schema.
3. **`flagWorkflow` + `unflagWorkflow` primitives + endpoints** — smallest behavior change. Sets flagged + reason; clear is the inverse.
4. **`proposeWorkflowEdit` primitive + endpoint** — creates a sibling workflow with `status:"proposed-edit"`. One-pending-edit-per-parent invariant via 409.
5. **`applyEditToParent` + PATCH status branching** — the merge-on-approve behavior. Distinct from existing status PATCH because it touches two workflows (parent + sibling).
6. **`GET /flows/catalog` endpoint** — the AI-side digest. Uses everything above.
7. **Flows tab per-app grouping UI** — outer collapsible section per package wrapping the existing 3-section sub-layout.
8. **🟠 Proposed edits sub-section + flag badge** — the visual surface for the new statuses.
9. **Proposed-edit diff view** — clicking an edit row opens a step-by-step diff with approve/reject buttons.
10. **README AI agent contract additions** — the human-readable contract for the new endpoints.
11. **Manual E2E on the phone host** — full walkthrough + v1.6.0 version bump.

Each task ends in a commit.

**Note on parse-checks:** existing convention in this codebase extracts the inline `<script>` blocks from `public/cam/index.html` and runs `node --check` on the extracted file. Each UI task ends with that check before commit. The exact shell command is shown in the relevant steps.

---

## Task 1: Backward-compat read defaults for P4 fields

**Files:**
- Modify: `teach.js` — extend `withDefaults` helper
- Modify: `tests/teach.test.js` — backward-compat test

- [ ] **Step 1: Add a backward-compat test**

Append to `tests/teach.test.js`:

```javascript
test('readWorkflow defaults P3-era missing fields (flagged, parent, edit_reason, flag_reason, flagged_at)', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const pkgDir = path.join(wfDir, 'com-foo', 'a', 'p3era');
  fs.mkdirSync(pkgDir, { recursive: true });
  // P3-era workflow.json — has status/intent/source_kind but no P4 fields
  fs.writeFileSync(path.join(pkgDir, 'workflow.json'), JSON.stringify({
    id: 'wf-p3', name: 'P3 flow', intent: 'p3 flow', status: 'approved',
    source_kind: 'human-promoted', package: 'com.foo', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 'session-x', use_count: 3, success_count: 2, rejected_reason: null,
  }));
  const wf = teach.readWorkflow('wf-p3');
  assert.ok(wf);
  // P3 fields preserved
  assert.strictEqual(wf.status, 'approved');
  assert.strictEqual(wf.success_count, 2);
  // New P4 fields defaulted
  assert.strictEqual(wf.flagged, false);
  assert.strictEqual(wf.flag_reason, null);
  assert.strictEqual(wf.flagged_at, null);
  assert.strictEqual(wf.parent, null);
  assert.strictEqual(wf.edit_reason, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/teach.test.js`
Expected: this one test fails because `wf.flagged` is `undefined`.

- [ ] **Step 3: Extend `withDefaults` in `teach.js`**

Find the existing `function withDefaults(wf) { ... }` in `teach.js`. Update the `Object.assign` block to include the five new fields:

```javascript
function withDefaults(wf) {
  if (!wf) return wf;
  return Object.assign({}, wf, {
    status:          wf.status          ?? 'approved',
    intent:          wf.intent          ?? wf.name ?? '',
    source_kind:     wf.source_kind     ?? 'human-promoted',
    success_count:   wf.success_count   ?? 0,
    rejected_reason: wf.rejected_reason ?? null,
    flagged:         wf.flagged         ?? false,
    flag_reason:     wf.flag_reason     ?? null,
    flagged_at:      wf.flagged_at      ?? null,
    parent:          wf.parent          ?? null,
    edit_reason:     wf.edit_reason     ?? null,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/teach.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: workflow read defaults for P4 — flagged/parent/edit_reason/flag_reason/flagged_at"
```

---

## Task 2: P4 fields written explicitly by promote + propose

**Files:**
- Modify: `teach.js` — `promoteSessionToWorkflow` and `proposeSessionAsWorkflow` wf object literals
- Modify: `tests/teach.test.js` — assert new fields land on disk

- [ ] **Step 1: Add tests**

Append to `tests/teach.test.js`:

```javascript
test('promoteSessionToWorkflow writes P4 fields with default values', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');
  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 },
    screenshotBuffer: Buffer.alloc(200, 0xff),
    metaArgs: { package: 'com.p4', activity: 'a' } });
  const id = teach.getActive().id;
  teach.endActive('done');
  const wf = teach.promoteSessionToWorkflow(id, { name: 'P4 promote' });
  assert.strictEqual(wf.flagged, false);
  assert.strictEqual(wf.flag_reason, null);
  assert.strictEqual(wf.flagged_at, null);
  assert.strictEqual(wf.parent, null);
  assert.strictEqual(wf.edit_reason, null);
  // Round-trip from disk
  const loaded = teach.readWorkflow(wf.id);
  assert.strictEqual(loaded.flagged, false);
  assert.strictEqual(loaded.parent, null);
});

test('proposeSessionAsWorkflow writes P4 fields with default values', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');
  teach.captureStep({ action: 'tap', args: { x: 1, y: 2 },
    screenshotBuffer: Buffer.alloc(200, 0xff),
    metaArgs: { package: 'com.p4', activity: 'a' } });
  const id = teach.getActive().id;
  teach.endActive('done');
  const wf = teach.proposeSessionAsWorkflow(id, { name: 'P4 propose', intent: 'p4' });
  assert.strictEqual(wf.flagged, false);
  assert.strictEqual(wf.parent, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/teach.test.js`
Expected: tests fail because returned wf objects lack the P4 fields.

- [ ] **Step 3: Update both write paths in `teach.js`**

Find the `wf = { ... }` object literal in `promoteSessionToWorkflow`. After the `rejected_reason: null,` line and before the closing `};`, add:

```javascript
    flagged: false,
    flag_reason: null,
    flagged_at: null,
    parent: null,
    edit_reason: null,
```

Find the matching `wf = { ... }` in `proposeSessionAsWorkflow`. Add the same five lines in the same position.

- [ ] **Step 4: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: promote + propose explicitly persist P4 fields (flagged/flag_reason/flagged_at/parent/edit_reason)"
```

---

## Task 3: `flagWorkflow` + `unflagWorkflow` primitives + endpoints

**Files:**
- Modify: `teach.js` — add helpers + router handlers
- Modify: `tests/teach.test.js` — unit + endpoint tests

- [ ] **Step 1: Add unit tests**

Append to `tests/teach.test.js`:

```javascript
test('flagWorkflow sets flagged + reason + timestamp', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const dir = path.join(wfDir, 'com-test', 'a', 'tgt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-tgt', name: 'tgt', intent: 'tgt', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
  }));
  const before = Date.now();
  const wf = teach.flagWorkflow('wf-tgt', 'step 3 missed target');
  assert.strictEqual(wf.flagged, true);
  assert.strictEqual(wf.flag_reason, 'step 3 missed target');
  assert.ok(wf.flagged_at >= before);
  // Round-trip
  const loaded = teach.readWorkflow('wf-tgt');
  assert.strictEqual(loaded.flagged, true);
});

test('unflagWorkflow clears all three flag fields', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const dir = path.join(wfDir, 'com-test', 'a', 'tgt2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-tgt2', name: 'tgt2', intent: 'tgt2', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
    flagged: true, flag_reason: 'something wrong', flagged_at: 5000,
  }));
  const wf = teach.unflagWorkflow('wf-tgt2');
  assert.strictEqual(wf.flagged, false);
  assert.strictEqual(wf.flag_reason, null);
  assert.strictEqual(wf.flagged_at, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/teach.test.js`
Expected: fail because `teach.flagWorkflow` is undefined.

- [ ] **Step 3: Add the helpers + exports + router handlers**

Find the existing `proposeSessionAsWorkflow` function in `teach.js`. Below it (still before the router section), add:

```javascript
function flagWorkflow(id, reason) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const wf = readWorkflow(id);
  if (!wf) throw new Error('workflow not found');
  wf.flagged = true;
  wf.flag_reason = String(reason || '').slice(0, 500);
  wf.flagged_at = Date.now();
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(id);
  if (!wfPath) throw new Error('cannot resolve workflow path');
  writeWorkflowJson(wfPath, wf);
  return wf;
}

function unflagWorkflow(id) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const wf = readWorkflow(id);
  if (!wf) throw new Error('workflow not found');
  wf.flagged = false;
  wf.flag_reason = null;
  wf.flagged_at = null;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(id);
  if (!wfPath) throw new Error('cannot resolve workflow path');
  writeWorkflowJson(wfPath, wf);
  return wf;
}
```

Add to `module.exports`:

```javascript
module.exports = {
  // ... existing exports ...
  flagWorkflow,
  unflagWorkflow,
};
```

Find the existing `router.patch('/workflows/:id/status', ...)` handler. Below it, add:

```javascript
router.post('/workflows/:id/flag', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const reason = req.body && req.body.reason;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  try {
    const wf = flagWorkflow(req.params.id, reason);
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

router.post('/workflows/:id/unflag', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  try {
    const wf = unflagWorkflow(req.params.id);
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(404).json({ error: e.message }); }
});
```

- [ ] **Step 4: Add endpoint smoke test**

Append to `tests/teach.test.js`:

```javascript
test('POST /workflows/:id/flag sets the flag; /unflag clears it', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13350', HUMANAIE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(true); }
    });
  });
  assert.ok(ready);

  const dir = path.join(dataDir, 'workflows', 'com-test', 'a', 'flagtgt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-flag', name: 'flagtgt', intent: 'flag', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
  }));

  const flagRes = await fetch('http://127.0.0.1:13350/workflows/wf-flag/flag', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'drifted' }),
  });
  assert.strictEqual(flagRes.status, 200);
  const flagBody = await flagRes.json();
  assert.strictEqual(flagBody.workflow.flagged, true);
  assert.strictEqual(flagBody.workflow.flag_reason, 'drifted');

  const noReason = await fetch('http://127.0.0.1:13350/workflows/wf-flag/flag', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(noReason.status, 400);

  const unflagRes = await fetch('http://127.0.0.1:13350/workflows/wf-flag/unflag', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  });
  assert.strictEqual(unflagRes.status, 200);
  const unflagBody = await unflagRes.json();
  assert.strictEqual(unflagBody.workflow.flagged, false);
  assert.strictEqual(unflagBody.workflow.flag_reason, null);
});
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: POST /workflows/:id/flag + /unflag — AI marks degraded flows for human review"
```

---

## Task 4: `proposeWorkflowEdit` primitive + endpoint

**Files:**
- Modify: `teach.js` — `proposeWorkflowEdit` + router handler
- Modify: `tests/teach.test.js` — unit + endpoint tests

- [ ] **Step 1: Add unit test**

Append to `tests/teach.test.js`:

```javascript
test('proposeWorkflowEdit creates sibling with proposed-edit status + parent ref', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const dir = path.join(wfDir, 'com-test', 'a', 'orig');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-orig', name: 'orig', intent: 'orig', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [{ index: 0, action: 'tap', args: { x: 1, y: 2 } }],
    created_at: 1000, updated_at: 1000, source: 's', use_count: 0, success_count: 0,
    rejected_reason: null,
  }));
  const editedSteps = [{ index: 0, action: 'tap', args: { x: 99, y: 88 } }];
  const edit = teach.proposeWorkflowEdit('wf-orig', editedSteps, 'tap moved');
  assert.strictEqual(edit.status, 'proposed-edit');
  assert.strictEqual(edit.source_kind, 'agent-edit');
  assert.strictEqual(edit.parent, 'wf-orig');
  assert.strictEqual(edit.edit_reason, 'tap moved');
  assert.deepStrictEqual(edit.steps, editedSteps);
  // Parent untouched
  const parent = teach.readWorkflow('wf-orig');
  assert.deepStrictEqual(parent.steps[0].args, { x: 1, y: 2 });
});

test('proposeWorkflowEdit throws 409-style error when pending edit exists', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const dir = path.join(wfDir, 'com-test', 'a', 'orig2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-orig2', name: 'orig2', intent: 'orig2', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
  }));
  teach.proposeWorkflowEdit('wf-orig2', [{ index: 0, action: 'tap', args: { x: 1, y: 1 } }], 'first');
  assert.throws(
    () => teach.proposeWorkflowEdit('wf-orig2', [{ index: 0, action: 'tap', args: { x: 2, y: 2 } }], 'second'),
    /pending edit exists/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/teach.test.js`
Expected: fail because `teach.proposeWorkflowEdit` is undefined.

- [ ] **Step 3: Add the helper**

Below `unflagWorkflow` in `teach.js`, add:

```javascript
function findPendingEditFor(parentId) {
  for (const wf of listWorkflows({ status: 'proposed-edit' })) {
    if (wf.parent === parentId) return wf;
  }
  return null;
}

function proposeWorkflowEdit(parentId, steps, editReason) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps array required');
  const parent = readWorkflow(parentId);
  if (!parent) throw new Error('parent not found');
  const existing = findPendingEditFor(parentId);
  if (existing) {
    const err = new Error('pending edit exists');
    err.pending_edit_id = existing.id;
    throw err;
  }
  // Slug: <parent-slug>-edit-<ts> for uniqueness even if multiple edits land
  // over time (rejected ones get deleted; this just keeps disk paths distinct).
  const parentSlug = slugify(parent.name);
  const editSlug = parentSlug + '-edit-' + Date.now();
  const dir = workflowDir(parent.package, parent.activity, editSlug);
  fs.mkdirSync(dir, { recursive: true });
  const wf = {
    id: 'wf-' + Date.now(),
    name: parent.name + ' (edit)',
    intent: parent.intent,
    status: 'proposed-edit',
    source_kind: 'agent-edit',
    package: parent.package,
    activity: parent.activity,
    screen_w: parent.screen_w,
    screen_h: parent.screen_h,
    steps: steps,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: parent.source,
    use_count: 0,
    success_count: 0,
    rejected_reason: null,
    flagged: false,
    flag_reason: null,
    flagged_at: null,
    parent: parentId,
    edit_reason: String(editReason || '').slice(0, 500),
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}
```

Add to `module.exports`:

```javascript
proposeWorkflowEdit,
findPendingEditFor,
```

Below the `/unflag` handler, add:

```javascript
router.post('/workflows/:id/propose-edit', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const steps = req.body && req.body.steps;
  const editReason = req.body && req.body.edit_reason;
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'steps array required' });
  }
  try {
    const edit = proposeWorkflowEdit(req.params.id, steps, editReason);
    res.json({ ok: true, edit_workflow: edit });
  } catch (e) {
    if (e.message === 'pending edit exists') {
      return res.status(409).json({ error: e.message, pending_edit_id: e.pending_edit_id });
    }
    if (e.message === 'parent not found') return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Add endpoint smoke test**

Append to `tests/teach.test.js`:

```javascript
test('POST /workflows/:id/propose-edit creates a proposed-edit sibling; 409 on second attempt', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13351', HUMANAIE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(true); }
    });
  });
  assert.ok(ready);

  const dir = path.join(dataDir, 'workflows', 'com-test', 'a', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-p', name: 'p', intent: 'p', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [{ index: 0, action: 'tap', args: { x: 1, y: 2 } }],
    created_at: 1000, updated_at: 1000, source: 's', use_count: 0, success_count: 0,
    rejected_reason: null,
  }));

  const first = await fetch('http://127.0.0.1:13351/workflows/wf-p/propose-edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ index: 0, action: 'tap', args: { x: 5, y: 5 } }], edit_reason: 'fix tap' }),
  });
  assert.strictEqual(first.status, 200);
  const firstBody = await first.json();
  assert.strictEqual(firstBody.edit_workflow.status, 'proposed-edit');
  assert.strictEqual(firstBody.edit_workflow.parent, 'wf-p');

  const second = await fetch('http://127.0.0.1:13351/workflows/wf-p/propose-edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ index: 0, action: 'tap', args: { x: 6, y: 6 } }], edit_reason: 'second' }),
  });
  assert.strictEqual(second.status, 409);
  const secondBody = await second.json();
  assert.strictEqual(secondBody.error, 'pending edit exists');
  assert.strictEqual(secondBody.pending_edit_id, firstBody.edit_workflow.id);

  const empty = await fetch('http://127.0.0.1:13351/workflows/wf-p/propose-edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [], edit_reason: 'empty' }),
  });
  assert.strictEqual(empty.status, 400);
});
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: POST /workflows/:id/propose-edit — AI suggests step amendments as proposed-edit siblings"
```

---

## Task 5: `applyEditToParent` + PATCH-status branching

**Files:**
- Modify: `teach.js` — `applyEditToParent` + branch in PATCH-status handler
- Modify: `tests/teach.test.js` — approve-edit + reject-edit tests

- [ ] **Step 1: Add unit test**

Append to `tests/teach.test.js`:

```javascript
test('applyEditToParent replaces parent steps + deletes sibling + preserves parent metadata', () => {
  const wfDir = tmpDir();
  teach.configureWorkflows({ rootDir: wfDir });
  const parentDir = path.join(wfDir, 'com-test', 'a', 'q');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(path.join(parentDir, 'workflow.json'), JSON.stringify({
    id: 'wf-q', name: 'q', intent: 'q intent', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [{ index: 0, action: 'tap', args: { x: 1, y: 1 } }],
    created_at: 1000, updated_at: 1000, source: 's', use_count: 5, success_count: 3,
    rejected_reason: null,
  }));
  const edit = teach.proposeWorkflowEdit('wf-q', [
    { index: 0, action: 'tap', args: { x: 100, y: 200 } },
    { index: 1, action: 'tap', args: { x: 300, y: 400 } },
  ], 'new app version');

  const merged = teach.applyEditToParent(edit.id);
  // Parent now has the edit's steps but original id/name/counts
  assert.strictEqual(merged.id, 'wf-q');
  assert.strictEqual(merged.name, 'q');
  assert.strictEqual(merged.intent, 'q intent');
  assert.strictEqual(merged.use_count, 5);
  assert.strictEqual(merged.success_count, 3);
  assert.strictEqual(merged.steps.length, 2);
  assert.deepStrictEqual(merged.steps[0].args, { x: 100, y: 200 });
  // Sibling deleted
  assert.strictEqual(teach.readWorkflow(edit.id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/teach.test.js`
Expected: fail because `teach.applyEditToParent` is undefined.

- [ ] **Step 3: Add `applyEditToParent`**

Below `proposeWorkflowEdit` in `teach.js`, add:

```javascript
function applyEditToParent(editId) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const edit = readWorkflow(editId);
  if (!edit) throw new Error('edit not found');
  if (edit.status !== 'proposed-edit') throw new Error('not a proposed-edit workflow');
  if (!edit.parent) throw new Error('edit has no parent reference');
  const parent = readWorkflow(edit.parent);
  if (!parent) throw new Error('parent no longer exists');
  // Merge: parent keeps id/name/intent/counts/history; gains edit's steps + screen dims.
  parent.steps = edit.steps;
  parent.screen_w = edit.screen_w;
  parent.screen_h = edit.screen_h;
  parent.updated_at = Date.now();
  // Approving an edit implicitly clears any flag on the parent (the AI's
  // edit IS the fix; the human's approval IS the verification).
  parent.flagged = false;
  parent.flag_reason = null;
  parent.flagged_at = null;
  const parentPath = workflowPathById(parent.id);
  if (parentPath) writeWorkflowJson(parentPath, parent);
  // Delete sibling on disk
  const editPath = workflowPathById(edit.id);
  if (editPath) {
    try { fs.rmSync(require('path').dirname(editPath), { recursive: true, force: true }); } catch {}
  }
  return parent;
}
```

Add to `module.exports`:

```javascript
applyEditToParent,
```

- [ ] **Step 4: Branch the PATCH-status handler**

Find the existing `router.patch('/workflows/:id/status', ...)` handler in `teach.js`. Replace the body with:

```javascript
router.patch('/workflows/:id/status', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const status = req.body && req.body.status;
  if (status !== 'proposed' && status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: 'status must be proposed/approved/rejected' });
  }
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  // proposed-edit branch: approve merges into parent + deletes sibling;
  // reject deletes sibling only; any other target status is invalid here.
  if (wf.status === 'proposed-edit') {
    if (status === 'approved') {
      try {
        const merged = applyEditToParent(req.params.id);
        return res.json({ ok: true, workflow: merged });
      } catch (e) {
        if (e.message === 'parent no longer exists') return res.status(410).json({ error: e.message });
        return res.status(500).json({ error: e.message });
      }
    }
    if (status === 'rejected') {
      const wfPath = workflowPathById(req.params.id);
      if (wfPath) {
        try { fs.rmSync(require('path').dirname(wfPath), { recursive: true, force: true }); } catch {}
      }
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'proposed-edit can only be approved or rejected' });
  }
  // Regular workflow branch (P3 behavior preserved).
  wf.status = status;
  wf.rejected_reason = (status === 'rejected') ? (req.body.rejected_reason || null) : null;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(req.params.id);
  if (!wfPath) return res.status(500).json({ error: 'cannot resolve workflow path' });
  writeWorkflowJson(wfPath, wf);
  res.json({ ok: true, workflow: wf });
});
```

- [ ] **Step 5: Add endpoint test for the full approve-edit flow**

Append to `tests/teach.test.js`:

```javascript
test('PATCH /workflows/:edit-id/status approved merges into parent; rejected just deletes sibling', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13352', HUMANAIE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(true); }
    });
  });
  assert.ok(ready);

  const dir = path.join(dataDir, 'workflows', 'com-test', 'a', 'r');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    id: 'wf-r', name: 'r', intent: 'r', status: 'approved',
    source_kind: 'human-promoted', package: 'com.test', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [{ index: 0, action: 'tap', args: { x: 1, y: 1 } }],
    created_at: 1000, updated_at: 1000, source: 's', use_count: 7, success_count: 4,
    rejected_reason: null,
  }));

  // Propose an edit
  const propose = await fetch('http://127.0.0.1:13352/workflows/wf-r/propose-edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ index: 0, action: 'tap', args: { x: 9, y: 9 } }], edit_reason: 'fix' }),
  }).then(r => r.json());
  const editId = propose.edit_workflow.id;

  // Approve the edit → merge into parent
  const approve = await fetch('http://127.0.0.1:13352/workflows/' + editId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.strictEqual(approve.status, 200);
  const merged = (await approve.json()).workflow;
  assert.strictEqual(merged.id, 'wf-r');
  assert.strictEqual(merged.use_count, 7);
  assert.deepStrictEqual(merged.steps[0].args, { x: 9, y: 9 });

  // Edit sibling is gone
  const list = await fetch('http://127.0.0.1:13352/workflows').then(r => r.json());
  assert.strictEqual(list.find(w => w.id === editId), undefined);

  // Propose + reject a second edit
  const propose2 = await fetch('http://127.0.0.1:13352/workflows/wf-r/propose-edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ index: 0, action: 'tap', args: { x: 0, y: 0 } }], edit_reason: 'bad' }),
  }).then(r => r.json());
  const reject = await fetch('http://127.0.0.1:13352/workflows/' + propose2.edit_workflow.id + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'rejected' }),
  });
  assert.strictEqual(reject.status, 200);
  // Parent still has the previously-approved (9, 9) steps
  const parentAfter = await fetch('http://127.0.0.1:13352/workflows').then(r => r.json());
  const parentRow = parentAfter.find(w => w.id === 'wf-r');
  assert.deepStrictEqual(parentRow.steps[0].args, { x: 9, y: 9 });
});
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: PATCH status approves proposed-edit → merge into parent (id/name/counts preserved, sibling deleted); reject just deletes sibling"
```

---

## Task 6: `GET /flows/catalog` endpoint

**Files:**
- Modify: `teach.js` — router handler
- Modify: `tests/teach.test.js` — smoke test

- [ ] **Step 1: Add the handler**

Find the existing `router.get('/flows', ...)` handler in `teach.js`. Below it, add:

```javascript
router.get('/flows/catalog', (req, res) => {
  const pkg = req.query.package;
  const act = req.query.activity;
  // Approved + flagged-approved live in the same set; flagged is just a hint.
  const approved = listWorkflows({ package: pkg, activity: act, status: 'approved' });
  const proposed = listWorkflows({ package: pkg, activity: act, status: 'proposed' });
  const proposedEdits = listWorkflows({ package: pkg, activity: act, status: 'proposed-edit' });
  const pendingByParent = {};
  for (const e of proposedEdits) {
    if (e.parent) pendingByParent[e.parent] = e.id;
  }
  const skills = approved.map(w => ({
    id: w.id,
    name: w.name,
    intent: w.intent,
    activity: w.activity,
    step_count: (w.steps && w.steps.length) || 0,
    use_count: w.use_count || 0,
    success_count: w.success_count || 0,
    success_rate: (w.use_count > 0) ? (w.success_count / w.use_count) : null,
    flagged: !!w.flagged,
    flag_reason: w.flag_reason || null,
    has_pending_edit: !!pendingByParent[w.id],
    pending_edit_id: pendingByParent[w.id] || null,
    updated_at: w.updated_at,
  }));
  // Sort: flagged first (true > false), then highest success_rate, then most recent.
  skills.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    const ar = a.success_rate ?? -1, br = b.success_rate ?? -1;
    if (br !== ar) return br - ar;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
  res.json({
    package: pkg || null,
    activity: act || null,
    approved_count: approved.length,
    proposed_count: proposed.length,
    proposed_edit_count: proposedEdits.length,
    flagged_count: approved.filter(w => w.flagged).length,
    skills: skills,
  });
});
```

- [ ] **Step 2: Add a smoke test**

Append to `tests/teach.test.js`:

```javascript
test('GET /flows/catalog returns per-app digest with flagged + pending-edit metadata', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13353', HUMANAIE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { proc.kill('SIGTERM'); } catch {} });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().toLowerCase().includes('listening')) { clearTimeout(timer); resolve(true); }
    });
  });
  assert.ok(ready);

  // Seed: one approved (flagged), one approved (with pending edit), one approved (clean).
  const base = path.join(dataDir, 'workflows', 'com-cat', 'a');
  fs.mkdirSync(path.join(base, 'flagged'), { recursive: true });
  fs.writeFileSync(path.join(base, 'flagged', 'workflow.json'), JSON.stringify({
    id: 'wf-fl', name: 'flagged-flow', intent: 'fl', status: 'approved',
    source_kind: 'human-promoted', package: 'com.cat', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1000,
    source: 's', use_count: 4, success_count: 1, rejected_reason: null,
    flagged: true, flag_reason: 'drifted', flagged_at: 5000,
  }));
  fs.mkdirSync(path.join(base, 'withedit'), { recursive: true });
  fs.writeFileSync(path.join(base, 'withedit', 'workflow.json'), JSON.stringify({
    id: 'wf-we', name: 'withedit-flow', intent: 'we', status: 'approved',
    source_kind: 'human-promoted', package: 'com.cat', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 2000,
    source: 's', use_count: 10, success_count: 9, rejected_reason: null,
  }));
  fs.mkdirSync(path.join(base, 'withedit-edit-9999'), { recursive: true });
  fs.writeFileSync(path.join(base, 'withedit-edit-9999', 'workflow.json'), JSON.stringify({
    id: 'wf-we-edit', name: 'withedit-flow (edit)', intent: 'we', status: 'proposed-edit',
    source_kind: 'agent-edit', package: 'com.cat', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 9999, updated_at: 9999,
    source: 's', use_count: 0, success_count: 0, rejected_reason: null,
    parent: 'wf-we', edit_reason: 'fix',
  }));
  fs.mkdirSync(path.join(base, 'clean'), { recursive: true });
  fs.writeFileSync(path.join(base, 'clean', 'workflow.json'), JSON.stringify({
    id: 'wf-cl', name: 'clean-flow', intent: 'cl', status: 'approved',
    source_kind: 'human-promoted', package: 'com.cat', activity: 'a',
    screen_w: 1080, screen_h: 2340, steps: [], created_at: 1000, updated_at: 1500,
    source: 's', use_count: 2, success_count: 2, rejected_reason: null,
  }));

  const res = await fetch('http://127.0.0.1:13353/flows/catalog?package=com.cat').then(r => r.json());
  assert.strictEqual(res.approved_count, 3);
  assert.strictEqual(res.flagged_count, 1);
  assert.strictEqual(res.proposed_edit_count, 1);
  assert.strictEqual(res.skills.length, 3);
  // Flagged sorts first
  assert.strictEqual(res.skills[0].id, 'wf-fl');
  assert.strictEqual(res.skills[0].flagged, true);
  assert.strictEqual(res.skills[0].flag_reason, 'drifted');
  // wf-we has a pending edit
  const we = res.skills.find(s => s.id === 'wf-we');
  assert.strictEqual(we.has_pending_edit, true);
  assert.strictEqual(we.pending_edit_id, 'wf-we-edit');
  assert.strictEqual(we.success_rate, 0.9);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/teach.test.js`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add teach.js tests/teach.test.js
git commit -m "feat: GET /flows/catalog — per-app skill digest for AI agents (sorted flagged → success_rate → updated_at)"
```

---

## Task 7: Flows tab per-app grouping (UI scaffold)

**Files:**
- Modify: `public/cam/index.html` — rebuild `buildWorkflowsColumn` to group by package first

- [ ] **Step 1: Locate `buildWorkflowsColumn`**

Run: `grep -n "function buildWorkflowsColumn\|function buildSubSection" public/cam/index.html`
Expected: matches `buildWorkflowsColumn` (one definition).

- [ ] **Step 2: Replace `buildWorkflowsColumn` with per-app version**

Find `function buildWorkflowsColumn(workflows) { ... }` in `public/cam/index.html`. Replace its body so the outer structure groups by package:

```javascript
  // Persistent collapse state (per package, per session).
  if (!state.flowsGroupOpen) state.flowsGroupOpen = {};

  function buildWorkflowsColumn(workflows) {
    var col = document.createElement('div');
    // Bucket workflows by package; 'Unknown' for empty package.
    var byPkg = {};
    workflows.forEach(function(w) {
      var pkg = w.package || 'Unknown';
      if (!byPkg[pkg]) byPkg[pkg] = [];
      byPkg[pkg].push(w);
    });
    var pkgs = Object.keys(byPkg).sort();
    if (pkgs.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:12px;font-style:italic;padding:8px 0';
      empty.textContent = 'No flows yet — promote a session below.';
      col.appendChild(empty);
      return col;
    }
    pkgs.forEach(function(pkg) {
      col.appendChild(buildAppGroup(pkg, byPkg[pkg]));
    });
    return col;
  }

  function buildAppGroup(pkg, workflows) {
    var approved = workflows.filter(function(w) { return w.status === 'approved'; });
    var proposed = workflows.filter(function(w) { return w.status === 'proposed'; });
    var edits    = workflows.filter(function(w) { return w.status === 'proposed-edit'; });
    var rejected = workflows.filter(function(w) { return w.status === 'rejected'; });
    var flagged  = approved.filter(function(w) { return w.flagged; });

    var grp = document.createElement('div');
    grp.style.cssText = 'margin-bottom:14px;border:1px solid #2a2a2a;border-radius:4px;overflow:hidden';

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'background:#1a1a1a;padding:8px 12px;cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center;font-size:13px';
    var open = state.flowsGroupOpen[pkg] !== false;  // default open
    var titleLeft = document.createElement('div');
    titleLeft.style.cssText = 'font-weight:bold;color:#fff;overflow:hidden;text-overflow:ellipsis';
    titleLeft.textContent = (open ? '▼ ' : '▶ ') + pkg + '  (' + approved.length + ')';
    hdr.appendChild(titleLeft);
    var titleRight = document.createElement('div');
    titleRight.style.cssText = 'font-size:11px;color:#888;flex-shrink:0;margin-left:8px';
    var parts = [];
    if (flagged.length) parts.push('⚠ ' + flagged.length);
    if (edits.length)   parts.push('🟠 ' + edits.length);
    if (proposed.length) parts.push('🟡 ' + proposed.length);
    titleRight.textContent = parts.join(' · ');
    hdr.appendChild(titleRight);
    grp.appendChild(hdr);

    var body = document.createElement('div');
    body.style.cssText = 'padding:8px 10px;background:#0a0a0a;display:' + (open ? 'block' : 'none');
    if (approved.length)  body.appendChild(buildSubSection('✅ Approved', approved, renderWorkflowRow, false));
    if (edits.length)     body.appendChild(buildSubSection('🟠 Proposed edits (review)', edits, renderProposedEditRow, false));
    if (proposed.length)  body.appendChild(buildSubSection('🟡 Proposed (review)', proposed, renderProposedRow, false));
    if (rejected.length)  body.appendChild(buildSubSection('🗑 Rejected', rejected, renderRejectedRow, true));
    grp.appendChild(body);

    hdr.addEventListener('click', function() {
      var nowOpen = body.style.display === 'none';
      body.style.display = nowOpen ? 'block' : 'none';
      state.flowsGroupOpen[pkg] = nowOpen;
      titleLeft.textContent = (nowOpen ? '▼ ' : '▶ ') + pkg + '  (' + approved.length + ')';
    });
    return grp;
  }
```

- [ ] **Step 3: Stub `renderProposedEditRow` (filled in Task 8)**

Below the existing `renderProposedRow` function in `public/cam/index.html`, add the stub:

```javascript
  function renderProposedEditRow(w) {
    // Filled out in Task 8.
    var row = document.createElement('div');
    row.style.cssText = 'background:#0a0a0a;border-left:3px solid #ff9933;padding:8px;margin-bottom:6px;font-size:12px;color:#ff9933';
    row.textContent = '(edit pending) ' + w.name;
    return row;
  }
```

- [ ] **Step 4: Parse check**

Extract the inline scripts to a temp file and ask Node to syntax-check it:

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('public/cam/index.html','utf-8');const m=[...h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/g)].filter(x=>!x[0].match(/<script[^>]*src=/));fs.writeFileSync('/tmp/_cam_check.js', m.map(x=>x[1]).join(';\\n'));" && node --check /tmp/_cam_check.js && echo parses
```
Expected output ends with `parses`.

Also confirm the new names are present:
```bash
grep -c "buildAppGroup\|renderProposedEditRow" public/cam/index.html
```
Expected: ≥ 3.

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: Flows tab right column groups by package — collapsible app sections with counts (approved / ⚠ flagged / 🟠 edits / 🟡 proposed)"
```

---

## Task 8: Flag badge + proposed-edit row + diff view + handlers

**Files:**
- Modify: `public/cam/index.html` — flesh out `renderProposedEditRow`, add flag badge to `renderWorkflowRow`, add diff modal + approve/reject handlers

- [ ] **Step 1: Add flag badge to the existing `renderWorkflowRow`**

Find `function renderWorkflowRow(w) { ... }` in `public/cam/index.html`. Locate the line that builds the meta (or counter) text — usually a `meta.textContent = ...` line near the row construction. After whatever element shows the (N×) count, append a flagged indicator:

```javascript
    if (w.flagged) {
      var badge = document.createElement('span');
      badge.textContent = ' ⚠';
      badge.title = w.flag_reason || 'Flagged for review';
      badge.style.cssText = 'color:#cccc55;font-weight:bold;margin-left:4px;cursor:help';
      // Right-click to unflag.
      badge.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (confirm('Unflag "' + w.name + '"? (Use after verifying the flow works correctly again.)')) {
          fetch('/workflows/' + encodeURIComponent(w.id) + '/unflag', { method: 'POST' })
            .then(function() { renderTeachLanding(); });
        }
      });
      // Attach to the row's meta div (the one already showing package + step count).
      // If your renderWorkflowRow already builds a 'meta' variable, do: meta.appendChild(badge);
    }
```

Where exactly the badge attaches depends on the current `renderWorkflowRow` shape. Locate the row's "info" or "meta" div (the part that already shows package + step count + use_count) and `appendChild(badge)` to it. The badge must live inside something with `pointer-events:auto` (the row, not a label).

- [ ] **Step 2: Fill out `renderProposedEditRow`**

Replace the stub from Task 7 with:

```javascript
  function renderProposedEditRow(w) {
    var row = document.createElement('div');
    row.className = 'teach-workflow-row';
    row.style.cssText = 'background:#0a0a0a;border:1px solid #2a2a2a;border-left:3px solid #ff9933;border-radius:4px;padding:8px;margin-bottom:6px;display:flex;align-items:center;gap:6px';
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;cursor:pointer';
    info.addEventListener('click', function() { openProposedEditDiff(w); });
    var name = document.createElement('div');
    name.style.cssText = 'font-size:12px;color:#ff9933;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = '🟠 ' + w.name;
    info.appendChild(name);
    var meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#888;margin-top:2px';
    var stepCount = (w.steps && w.steps.length) || 0;
    meta.textContent = stepCount + ' steps · ' + (w.edit_reason || 'no reason given');
    info.appendChild(meta);
    row.appendChild(info);

    var approveBtn = document.createElement('button');
    approveBtn.className = 'nav-btn';
    approveBtn.style.cssText = 'background:#0a3a18;color:#3ddc84;border:1px solid #3ddc84;padding:2px 6px;font-size:10px;cursor:pointer';
    approveBtn.textContent = '✓';
    approveBtn.title = 'Approve edit — merges into parent';
    approveBtn.addEventListener('click', function(e) { e.stopPropagation(); approveEdit(w); });
    row.appendChild(approveBtn);

    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'nav-btn';
    rejectBtn.style.cssText = 'background:#3a1818;color:#ff6666;border:1px solid #d80000;padding:2px 6px;font-size:10px;cursor:pointer';
    rejectBtn.textContent = '✕';
    rejectBtn.title = 'Reject edit — discards the proposal, parent untouched';
    rejectBtn.addEventListener('click', function(e) { e.stopPropagation(); rejectEdit(w); });
    row.appendChild(rejectBtn);
    return row;
  }

  function approveEdit(w) {
    fetch('/workflows/' + encodeURIComponent(w.id) + '/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Approve edit failed: ' + d.error); return; }
      renderTeachLanding();
    }).catch(function(err) { console.warn('approve edit failed', err); });
  }

  function rejectEdit(w) {
    if (!confirm('Reject this edit? The original flow stays untouched.')) return;
    fetch('/workflows/' + encodeURIComponent(w.id) + '/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { alert('Reject edit failed: ' + d.error); return; }
      renderTeachLanding();
    }).catch(function(err) { console.warn('reject edit failed', err); });
  }
```

- [ ] **Step 3: Add the diff modal**

Below `rejectEdit`, add:

```javascript
  function openProposedEditDiff(editWf) {
    // Fetch parent for side-by-side step comparison. Parent id is editWf.parent.
    fetch('/workflows').then(function(r) { return r.json(); }).then(function(all) {
      var parent = all.find(function(w) { return w.id === editWf.parent; });
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:130;display:flex;align-items:center;justify-content:center;padding:20px';
      var panel = document.createElement('div');
      panel.style.cssText = 'background:#0a0a0a;border:2px solid #ff9933;border-radius:6px;padding:18px;max-width:560px;width:100%;max-height:80vh;overflow:auto;color:#fff;font-family:monospace;font-size:12px';
      var hdr = document.createElement('div');
      hdr.style.cssText = 'color:#ff9933;font-weight:bold;font-size:14px;margin-bottom:6px';
      hdr.textContent = '🟠 Proposed edit: ' + editWf.name;
      panel.appendChild(hdr);
      if (parent) {
        var sub = document.createElement('div');
        sub.style.cssText = 'color:#888;font-size:11px;margin-bottom:8px';
        sub.textContent = 'Parent: ' + parent.name + ' (' + parent.id + ')';
        panel.appendChild(sub);
      }
      if (editWf.edit_reason) {
        var reason = document.createElement('div');
        reason.style.cssText = 'background:#1a1a1a;border-left:3px solid #ff9933;padding:6px 10px;margin-bottom:10px;font-size:11px';
        reason.textContent = 'Reason: ' + editWf.edit_reason;
        panel.appendChild(reason);
      }
      var diff = document.createElement('div');
      diff.style.cssText = 'margin:10px 0';
      var pSteps = (parent && parent.steps) || [];
      var eSteps = editWf.steps || [];
      var maxLen = Math.max(pSteps.length, eSteps.length);
      for (var i = 0; i < maxLen; i++) {
        var ps = pSteps[i], es = eSteps[i];
        var line = document.createElement('div');
        line.style.cssText = 'padding:2px 0;font-size:11px';
        var label = 'Step ' + (i + 1) + '  ';
        if (!ps && es) { line.style.color = '#3ddc84'; line.textContent = label + '+ ' + describeStep(es) + '  (NEW)'; }
        else if (ps && !es) { line.style.color = '#d80000'; line.textContent = label + '- ' + describeStep(ps) + '  (REMOVED)'; }
        else if (JSON.stringify(ps.args) !== JSON.stringify(es.args) || ps.action !== es.action) {
          line.style.color = '#cccc55';
          line.textContent = label + '~ ' + describeStep(ps) + '  →  ' + describeStep(es) + '  (CHANGED)';
        } else {
          line.style.color = '#666';
          line.textContent = label + '  ' + describeStep(ps);
        }
        diff.appendChild(line);
      }
      panel.appendChild(diff);
      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px';
      var ok = document.createElement('button');
      ok.style.cssText = 'flex:1;padding:8px;background:#0a3a18;color:#3ddc84;border:1px solid #3ddc84;border-radius:3px;cursor:pointer;font-family:inherit;font-weight:bold';
      ok.textContent = '✓ Approve edit';
      ok.addEventListener('click', function() { overlay.remove(); approveEdit(editWf); });
      btnRow.appendChild(ok);
      var no = document.createElement('button');
      no.style.cssText = 'flex:1;padding:8px;background:#3a1818;color:#ff6666;border:1px solid #d80000;border-radius:3px;cursor:pointer;font-family:inherit;font-weight:bold';
      no.textContent = '✕ Reject';
      no.addEventListener('click', function() { overlay.remove(); rejectEdit(editWf); });
      btnRow.appendChild(no);
      var cancel = document.createElement('button');
      cancel.style.cssText = 'flex:1;padding:8px;background:transparent;color:#888;border:1px solid #444;border-radius:3px;cursor:pointer;font-family:inherit';
      cancel.textContent = 'Close';
      cancel.addEventListener('click', function() { overlay.remove(); });
      btnRow.appendChild(cancel);
      panel.appendChild(btnRow);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    });
  }

  function describeStep(s) {
    if (!s) return '(none)';
    if (s.action === 'tap' && s.args) return 'tap (' + s.args.x + ', ' + s.args.y + ')';
    if (s.action === 'swipe' && s.args) return 'swipe (' + s.args.x1 + ',' + s.args.y1 + ') → (' + s.args.x2 + ',' + s.args.y2 + ')';
    if (s.action === 'key' && s.args) return 'key ' + s.args.keycode;
    if (s.action === 'type' && s.args) return 'type "' + (s.args.text || '').slice(0, 20) + '"';
    return s.action;
  }
```

- [ ] **Step 4: Parse check**

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('public/cam/index.html','utf-8');const m=[...h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/g)].filter(x=>!x[0].match(/<script[^>]*src=/));fs.writeFileSync('/tmp/_cam_check.js', m.map(x=>x[1]).join(';\\n'));" && node --check /tmp/_cam_check.js && echo parses
```
Expected: ends with `parses`.

- [ ] **Step 5: Commit**

```bash
git add public/cam/index.html
git commit -m "feat: Flows tab — flag ⚠ badge with right-click unflag + proposed-edit row with diff modal (approve/reject)"
```

---

## Task 9: README AI agent contract additions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the P4 subsections under existing AI Integration section**

Find the existing `### Phone agent workflow (P3 — Teaching Mode replay)` section in `README.md`. Below the `### Click calibration (P3.1)` section that ends with the verdict descriptions, add:

```markdown
### Skill discovery (P4)

Before exploring a new app, query the catalog:

```
GET /flows/catalog?package=com.instagram.android
```

Returns the full list of skills for that app (approved + flagged counts plus
per-skill metadata: intent, success_rate, use_count, has_pending_edit, flagged
status with reason). Scan this once at session start to know what skills are
available. Use `/flows` when you need to match a specific intent to a workflow.

Skills are sorted with flagged flows first (your attention items), then by
success_rate, then by recency.

### Flagging a degraded flow

If you replay a flow and it fails (a tap missed its target, a step landed on
unexpected content, you needed to call `/waitfor-highlight` mid-replay), flag
the flow so the human knows it drifted:

```
POST /workflows/wf-.../flag
{ "reason": "step 3 tap at (520, 1180) missed the post button — got 'home' instead" }
```

The flow keeps serving but gets a ⚠ badge in the UI. Do this BEFORE trying to
explore your way around the failure — the human seeing the flag is the trigger
for them to either fix the flow themselves or wait for you to propose an edit.

To clear a flag (after verifying the flow is healthy again):

```
POST /workflows/wf-.../unflag
```

### Proposing an edit

If you've identified what's wrong and have a fix, propose an edit instead of
asking the human to make it:

```
POST /workflows/wf-.../propose-edit
{
  "steps": [...amended step array...],
  "edit_reason": "step 3 coord moved from (520, 1180) to (540, 1200) after IG v210 UI change"
}
```

The edit lives as a sibling workflow with `status: "proposed-edit"`. The
original keeps serving until the human approves. After approval, the original's
steps are replaced in place (id, name, intent, use_count, success_count are all
preserved). Approval also auto-clears any flag on the parent.

Only one pending edit per parent — a second `/propose-edit` while one is
pending returns 409 with `pending_edit_id` pointing to the existing one. If
you need to revise your edit before the human reviews it, `DELETE /workflows/<pending_edit_id>`
first, then re-propose.

### Cultural rule (P4 amendment)

If you flag a flow more than 3 times for the same reason without proposing an
edit, you're failing the contract. Either propose an edit or call
`/waitfor-highlight` asking the human for the new coord. The point of
proposing edits is to keep the human's review queue short — flag-and-wait is
worse than propose-and-wait because the human has nothing concrete to act on.
```

- [ ] **Step 2: Verify the section landed**

Run:
```bash
grep -nE "### Skill discovery|### Flagging a degraded flow|### Proposing an edit|### Cultural rule \(P4" README.md
```
Expected: 4 matches.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README — P4 AI contract (skill discovery, flag, propose-edit, cultural rules)"
```

---

## Task 10: Manual E2E + v1.6.0 bump

**Files:** None until the bump step.

- [ ] **Step 1: Push + pull**

On the dev box:
```bash
git push origin main
```

On the phone host (substitute your environment-specific paths):
```bash
cd <repo-root> && git pull
fuser -k 3333/tcp 2>/dev/null
sleep 2
systemd-run --user --scope --no-block bash -lc 'cd <repo-root> && node server.js >> /tmp/humanaie.log 2>&1'
```

Hard-refresh the browser tab on `http://<phone-host>:3333/cam/`.

- [ ] **Step 2: Verify per-app grouping**

Open 📂 Flows → 📱 Phone. The workflows column should now show your existing flows grouped by `package`. Each app section header shows the count and is collapsible.

- [ ] **Step 3: Test the catalog endpoint**

```bash
curl -sS "http://<phone-host>:3333/flows/catalog?package=<package-of-an-existing-flow>" | jq
```

Expected response shape:
```
{ "package": "...", "approved_count": N, "proposed_edit_count": 0, "flagged_count": 0,
  "skills": [{ "id": "wf-...", "name": "...", "intent": "...", "step_count": int, ... }] }
```

- [ ] **Step 4: Test the flag flow**

```bash
WFID="<your-workflow-id>"
curl -X POST -H 'content-type: application/json' \
  -d '{"reason":"E2E test flag"}' \
  http://<phone-host>:3333/workflows/$WFID/flag
```

Reload Flows tab. The workflow row should show a ⚠ badge. Hover (or long-press) the badge — tooltip shows "E2E test flag". Right-click the badge → confirm → flag clears.

- [ ] **Step 5: Test propose-edit + diff view**

Get the workflow's step array and tweak one:
```bash
curl -sS http://<phone-host>:3333/workflows | jq '.[] | select(.id=="'$WFID'") | .steps'
# Take that array, change one tap's x or y, post back:
curl -X POST -H 'content-type: application/json' \
  -d '{"steps":[<modified steps array>], "edit_reason":"E2E test edit"}' \
  http://<phone-host>:3333/workflows/$WFID/propose-edit
```

Reload Flows tab → the app section now shows 🟠 1 in the header and a "🟠 Proposed edits" sub-section with the edit row. Click the row → diff modal opens showing the original vs amended steps with the changed step highlighted yellow.

- [ ] **Step 6: Test approve + reject paths**

Click ✓ Approve edit → modal closes, parent row updates to show new step coords, edit row vanishes, app section's 🟠 count drops to 0.

Re-create the edit (same curl), then click ✕ Reject → modal closes (after confirm), edit row vanishes, parent untouched.

- [ ] **Step 7: Test the 409 (pending-edit conflict)**

Create an edit, then attempt to propose a second edit on the same parent without approving the first:
```bash
curl -i -X POST -H 'content-type: application/json' \
  -d '{"steps":[...], "edit_reason":"second"}' \
  http://<phone-host>:3333/workflows/$WFID/propose-edit
```
Expected: HTTP 409 with body `{"error": "pending edit exists", "pending_edit_id": "wf-..."}`.

- [ ] **Step 8: Bump to v1.6.0 if all green**

```bash
sed -i 's/"version": "1.5.0"/"version": "1.6.0"/' package.json
sed -i 's/v1\.5\.0/v1.6.0/g' public/cam/index.html
git add package.json public/cam/index.html
git commit -m "chore: bump to v1.6.0 — Teaching Mode P4 (AI co-maintains the skill library) shipped"
git push origin main
```

- [ ] **Step 9: Document any failures as fix commits on `main`**

Same pattern as P3/calibration E2E — small focused commits, one issue per commit.

---

## Done criteria

- [ ] `node --test tests/teach.test.js` passes all existing + new P4 tests
- [ ] P3 workflows still load with `flagged: false, parent: null` (backward compat)
- [ ] AI can flag/unflag/propose-edit/catalog via documented endpoints
- [ ] Human can approve/reject proposed edits via the Flows tab diff view
- [ ] Approving an edit merges steps into parent; rejecting just deletes sibling
- [ ] One-pending-edit-per-parent invariant enforced (409 on conflict)
- [ ] Flows tab groups by app; flagged rows show ⚠ badge with reason
- [ ] README has the 4 new P4 subsections
- [ ] Phone-host E2E checklist green
- [ ] package.json bumped to 1.6.0
