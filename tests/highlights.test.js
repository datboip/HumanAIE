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

test('GET /highlight-history?package= returns only android entries for that app', async (t) => {
  const { bootServer } = require('./highlights.test');
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

module.exports = { bootServer };
