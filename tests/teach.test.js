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

test('promoteSessionToWorkflow copies steps and writes workflow.json', () => {
  const teachDir = tmpDir();
  const wfDir = tmpDir();
  teach.configure({ rootDir: teachDir });
  teach.configureWorkflows({ rootDir: wfDir });
  if (teach.getActive()) teach.endActive('test-cleanup');

  teach.captureStep({ action: 'tap', args: { x: 100, y: 200 },
    screenshotBuffer: Buffer.alloc(200, 0xff),
    metaArgs: { package: 'com.test', activity: '.A' } });
  teach.captureStep({ action: 'tap', args: { x: 300, y: 400 },
    screenshotBuffer: Buffer.alloc(200, 0xff) });
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

test('teach routes reject malformed session IDs (path traversal)', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13340', HUMANAIE_DATA_DIR: dataDir },
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

  // URL-encoded slash in id should be rejected with 400
  for (const evil of ['..%2Fetc', 'foo%2Fbar', 'has%20spaces']) {
    const res = await fetch('http://127.0.0.1:13340/teach/sessions/' + evil);
    assert.strictEqual(res.status, 400, 'evil id "' + evil + '" should 400');
  }
  // Plain '..' is normalised away by Express before routing (becomes /teach/)
  // so the response is 404 — but it never reaches path.join, which is fine.
  const dotdot = await fetch('http://127.0.0.1:13340/teach/sessions/..');
  assert.ok(dotdot.status === 404, 'plain .. should not reach handler');
});

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

test('matchIntent 0.4 floor does not outscore a single-token partial match', () => {
  // "send" is a substring of "send a dm" → hits the 0.9 full-match path, NOT the 0.4 floor
  const wf = { name: 'Send a DM', intent: '' };
  assert.strictEqual(teach.matchIntent(wf, 'send'), 0.9);
});

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

test('PATCH /teach/sessions/:id/steps round-trip', async (t) => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const dataDir = tmpDir();
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HUMANAIE_TEST_NO_BROWSER: '1', HUMANAIE_PORT: '13339', HUMANAIE_DATA_DIR: dataDir },
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

  // Bad body → 400
  const bad = await fetch('http://127.0.0.1:13339/teach/sessions/teach-x/steps', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(bad.status, 400);

  // Missing session → 404
  const missing = await fetch('http://127.0.0.1:13339/teach/sessions/teach-does-not-exist/steps', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [] }),
  });
  assert.strictEqual(missing.status, 404);
});

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

  // Re-approve clears the previously stored rejected_reason
  const reapproved = await fetch('http://127.0.0.1:13342/workflows/' + wfId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.strictEqual(reapproved.status, 200);
  const reapprovedBody = await reapproved.json();
  assert.strictEqual(reapprovedBody.workflow.status, 'approved');
  assert.strictEqual(reapprovedBody.workflow.rejected_reason, null);

  // Invalid status
  const bad = await fetch('http://127.0.0.1:13342/workflows/' + wfId + '/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'maybe' }),
  });
  assert.strictEqual(bad.status, 400);
});

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
