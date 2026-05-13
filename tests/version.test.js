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
  const expectedVersion = require('../package.json').version;
  assert.strictEqual(body.version, expectedVersion, 'version should match package.json');
});
