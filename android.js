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
    if (fs.existsSync(p)) return p;
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
    if (!/^[A-Z0-9_]+$/.test(String(keycode))) {
      return res.status(400).json({ error: 'keycode must be alphanumeric uppercase + underscores (e.g., KEYCODE_HOME)' });
    }
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
