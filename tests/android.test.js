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
