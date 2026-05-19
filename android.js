'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile, spawn } = require('node:child_process');
const express = require('express');

function parseWakefulness(dumpsysOutput) {
  if (typeof dumpsysOutput !== 'string' || dumpsysOutput.length === 0) return false;
  const match = dumpsysOutput.match(/mWakefulness=(\w+)/);
  if (!match) return false;
  const value = match[1];
  return value === 'Awake' || value === 'Dreaming';
}

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
    res.json({ adb_available: false, phone_connected: false, phone_addr: '', battery: null, screen_on: false, package: '', activity: '' });
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

  // ── Frame cache — background screencap loop, shared by /screenshot and /stream ─
  let frameCache = null;
  const MJPEG_CLIENTS = new Set();
  const BOUNDARY = 'frame';

  let lastFrameTime = 0;
  function pushFrame(buf) {
    if (!buf || buf.length < 1000) return;
    lastFrameTime = Date.now();
    frameCache = buf;
    const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
    for (const client of MJPEG_CLIENTS) {
      try { client.write(header); client.write(buf); client.write('\r\n'); }
      catch { MJPEG_CLIENTS.delete(client); }
    }
  }

  // Capture cadence is configurable via POST /android/config. Lower ms = higher FPS.
  // (only affects the screencap fallback — the h264 stream below runs at the
  // phone's native frame rate independent of this.)
  let captureIntervalMs = 80; // default ~12fps

  // ── PRIMARY: H264 stream via screenrecord + ffmpeg ───────────────────────────
  // Port of nanodroidcam/hivedroid's high-fps pipeline:
  //   `adb exec-out screenrecord --output-format=h264 ...` produces a live h264
  //   bitstream from the phone's hardware encoder. We pipe that into ffmpeg
  //   which decodes h264 and re-encodes as MJPEG frames piped to stdout. Each
  //   JPEG frame (FFD8...FFD9) is broadcast via pushFrame(). This sustains
  //   ~25-30 FPS where the screencap-per-frame loop manages ~3-12.
  let h264AdbProc = null;
  let h264FfmpegProc = null;
  let h264RestartTimer = null;
  function startH264Stream() {
    h264RestartTimer = null;
    try {
      h264AdbProc = spawn(adbPath, ['-s', SERIAL_REF.current, 'exec-out',
        'screenrecord --output-format=h264 --bit-rate 2000000 /dev/stdout']);
      h264FfmpegProc = spawn('ffmpeg', [
        '-loglevel', 'error',
        // +genpts generates PTS for the live stream (screenrecord doesn't
        // emit container-level PTS, only NAL units). probesize must be big
        // enough for ffmpeg to find SPS/PPS — 32 bytes is way too small and
        // the decoder silently produces 0 frames. analyzeduration:0 skips
        // the time-based probe so we don't sit idle for ~5s at start.
        '-fflags', '+genpts',
        '-probesize', '100000',
        '-analyzeduration', '0',
        '-f', 'h264', '-i', 'pipe:0',
        // Downscale to 540px wide — full 1080×2340 MJPEG encoding maxed out
        // at 1.4 fps real-time on the host CPU; 540 wide gets us back to
        // ~25 fps. Matches hivedroid. Coord mapping uses phone's real screen
        // dims (queried separately via `wm size`), not these stream dims.
        '-vf', 'scale=540:-2',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1',
      ]);
    } catch (e) {
      // ffmpeg likely missing — fall back permanently to the screencap loop.
      console.log('[android] h264 stream unavailable (' + e.message + '), screencap fallback only');
      return;
    }
    h264AdbProc.stdout.pipe(h264FfmpegProc.stdin);
    h264AdbProc.stderr.on('data', () => {});
    h264FfmpegProc.stderr.on('data', () => {});
    let frameBuf = Buffer.alloc(0);
    h264FfmpegProc.stdout.on('data', chunk => {
      frameBuf = Buffer.concat([frameBuf, chunk]);
      // Find JPEG SOI/EOI boundaries (FFD8...FFD9) and emit each frame.
      let start = -1;
      for (let i = 0; i < frameBuf.length - 1; i++) {
        if (frameBuf[i] === 0xFF && frameBuf[i + 1] === 0xD8) start = i;
        if (start !== -1 && frameBuf[i] === 0xFF && frameBuf[i + 1] === 0xD9) {
          pushFrame(frameBuf.slice(start, i + 2));
          frameBuf = frameBuf.slice(i + 2);
          start = -1;
          i = -1;
        }
      }
      if (frameBuf.length > 2 * 1024 * 1024) frameBuf = Buffer.alloc(0); // safety drain
    });
    const restart = () => {
      try { if (h264AdbProc)    h264AdbProc.kill(); } catch {}
      try { if (h264FfmpegProc) h264FfmpegProc.stdin.end(); } catch {}
      h264AdbProc = null; h264FfmpegProc = null;
      if (h264RestartTimer) return;
      h264RestartTimer = setTimeout(startH264Stream, 2000);
    };
    h264FfmpegProc.on('close', restart);
    h264FfmpegProc.on('error', restart);
    h264AdbProc.on('close', () => { try { h264FfmpegProc && h264FfmpegProc.stdin.end(); } catch {} });
    h264AdbProc.on('error', restart);
  }
  startH264Stream();

  // ── FALLBACK: per-frame screencap loop ───────────────────────────────────────
  // Still runs alongside the h264 stream. If h264 is healthy it produces
  // frames faster and dominates the broadcast; if h264 dies between restarts,
  // screencap keeps frames flowing so the viewport never goes fully stale.

  // Async screencap — execFile (not execFileSync) so the event loop stays free
  // while ADB is in flight. encoding:'buffer' gives us raw PNG bytes back.
  function screencapAsync() {
    return new Promise((resolve, reject) => {
      execFile(adbPath, ['-s', SERIAL_REF.current, 'exec-out', 'screencap', '-p'],
        { timeout: 10000, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => err ? reject(err) : resolve(stdout));
    });
  }

  (async function captureLoop() {
    while (true) {
      // Only fire screencap if h264 hasn't delivered a frame recently —
      // otherwise both paths compete for the same ADB serial connection and
      // taps/swipes get queued behind the screencap PNG transfer.
      const h264Stale = (Date.now() - lastFrameTime) > 2000;
      if (h264Stale) {
        try {
          const buf = await screencapAsync();
          if (buf && buf.length > 1000) pushFrame(buf);
        } catch { /* phone offline, emulator rebooting, etc. */ }
      }
      await new Promise(r => setTimeout(r, captureIntervalMs));
    }
  })();

  router.post('/config', (req, res) => {
    const ms = parseInt(req.body && req.body.captureIntervalMs, 10);
    if (Number.isNaN(ms) || ms < 16 || ms > 2000) {
      return res.status(400).json({ error: 'captureIntervalMs must be 16-2000' });
    }
    captureIntervalMs = ms;
    res.json({ ok: true, captureIntervalMs });
  });

  // Cached phone screen dims — queried lazily from `wm size` (see getScreenDims
  // below). Cleared on /reconnect since a new device may be a different size.
  // Used by /android/status so the cam UI can map clicks to real phone pixel
  // coords even when the streamed image is downscaled.
  let cachedScreenW = 0, cachedScreenH = 0;

  router.post('/reconnect', async (req, res) => {
    if (!PHONE_ADDR) return res.status(400).json({ error: 'HUMANAIE_PHONE_IP not set' });
    try {
      execFileSync(adbPath, ['connect', PHONE_ADDR], { timeout: 5000 });
      SERIAL_REF.current = detectSerial();
      cachedScreenW = 0; cachedScreenH = 0;
      res.json({ ok: true, serial: SERIAL_REF.current });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
    const safeDur = Math.max(1, Math.min(10000, parseInt(dur, 10) || 300));
    try {
      await adbAsync('shell',
        `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${safeDur}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/type', async (req, res) => {
    const { text } = req.body || {};
    if (text == null || text === '') return res.status(400).json({ error: 'text required' });
    const safe = String(text).replace(/([^a-zA-Z0-9@.,!?\-])/g, '\\$1');
    try {
      await adbAsync('shell', `input text ${safe}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Wake + dismiss keyguard in one call. KEYCODE_WAKEUP only turns the screen
  // on — modern Android still shows the lockscreen, and the sleep banner on
  // the cam UI blocks the user's swipe-up gesture that would dismiss it. So
  // we wake, give the screen 250ms to render, then try `wm dismiss-keyguard`
  // (works on no-security phones; brings up PIN entry on secured ones — both
  // are correct outcomes for "user wants to use the phone").
  router.post('/wake', async (req, res) => {
    try {
      await adbAsync('shell', 'input keyevent KEYCODE_WAKEUP');
      await new Promise(r => setTimeout(r, 250));
      try { await adbAsync('shell', 'wm dismiss-keyguard'); } catch {}
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

  router.get('/screenshot', (req, res) => {
    if (!frameCache) return res.status(503).json({ error: 'No frame yet — phone may be offline' });
    const isJpeg = frameCache[0] === 0xFF && frameCache[1] === 0xD8;
    res.set('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(frameCache);
  });

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

  async function detectForeground() {
    try {
      const out = (await adbAsync('shell',
        "dumpsys activity activities | grep -E 'mResumedActivity|mCurrentFocus'")).toString();
      const m = out.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
      return m ? { package: m[1], activity: m[2] } : { package: '', activity: '' };
    } catch { return { package: '', activity: '' }; }
  }
  getForeground = detectForeground; // store on outer-scope variable so module.exports.getForeground works

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

  async function getScreenDims() {
    if (cachedScreenW && cachedScreenH) return { w: cachedScreenW, h: cachedScreenH };
    try {
      const out = (await adbAsync('shell', 'wm size')).toString();
      // Output looks like "Physical size: 1080x2340" or with an "Override size" line.
      const m = out.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/);
      if (m) {
        cachedScreenW = parseInt(m[1], 10);
        cachedScreenH = parseInt(m[2], 10);
      }
    } catch {}
    return { w: cachedScreenW, h: cachedScreenH };
  }

  router.get('/status', async (req, res) => {
    let phone_connected = false;
    let batteryLevel = null;
    let screen_on = false;
    let screen_w = 0, screen_h = 0;
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
      try {
        const p = (await adbAsync('shell', 'dumpsys power | grep mWakefulness')).toString();
        screen_on = parseWakefulness(p);
      } catch {}
      const dims = await getScreenDims();
      screen_w = dims.w; screen_h = dims.h;
      foreground = await detectForeground();
    }
    res.json({
      adb_available: true,
      phone_connected,
      phone_addr: PHONE_ADDR,
      battery: batteryLevel,
      screen_on,
      screen_w,
      screen_h,
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

  function execFileAsync(file, args, opts) {
    return new Promise((resolve, reject) => {
      execFile(file, args, opts || {}, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
  }

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
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(String(pkg))) {
      return res.status(400).json({ error: 'invalid package name (e.g., com.example.app)' });
    }
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
module.exports.parseWakefulness = parseWakefulness;
