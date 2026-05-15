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
