'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile, spawn } = require('node:child_process');
const express = require('express');
const teach = require('./teach');

// Optional broadcaster — server.js wires this up at startup so dispatch
// handlers can push SSE events for AI-driven phone actions. Until set,
// the broadcaster is a no-op so android.js stays standalone-loadable.
let broadcaster = function() {};
function setBroadcaster(fn) { if (typeof fn === 'function') broadcaster = fn; }

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

  // Keep the display on while USB is connected. This is the root-cause
  // mitigation for the Samsung MediaCodec/screenrecord wedge: the encoder's
  // virtual display goes silent when the keyguard engages on Android 14+,
  // and the encoder never recovers without a process-level reset. Forcing
  // stay-on prevents the trigger entirely. Safe to run on every connect;
  // setting persists until USB unplug or another `svc power stayon` call.
  function ensureStayOn() {
    if (!SERIAL_REF.current) return;
    try {
      execFileSync(adbPath, ['-s', SERIAL_REF.current, 'shell', 'svc', 'power', 'stayon', 'usb'],
                   { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {}
  }
  ensureStayOn();

  setInterval(() => {
    const s = detectSerial();
    if (s !== SERIAL_REF.current) {
      console.log(`[android] device switched: ${SERIAL_REF.current} → ${s}`);
      SERIAL_REF.current = s;
      ensureStayOn();
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
  function captureSessionFrame() {
    // Reuse the most-recent broadcast frame (JPEG when h264 alive, PNG when
    // on screencap fallback). Avoids a separate ADB call per dispatch —
    // tap latency unchanged.
    return frameCache;
  }
  const MJPEG_CLIENTS = new Set();
  const BOUNDARY = 'frame';

  let lastFrameTime = 0;
  // Sliding-window FPS counter. Keeps timestamps from the last 2 seconds
  // and reports count/elapsed so the cam UI side panel can render a live
  // number — drops to 5-ish during screencap fallback, 20+ on healthy h264.
  let frameTimestamps = [];
  function recordFrameForFps(t) {
    frameTimestamps.push(t);
    const cutoff = t - 2000;
    while (frameTimestamps.length && frameTimestamps[0] < cutoff) frameTimestamps.shift();
  }
  function currentFps() {
    if (frameTimestamps.length < 2) return 0;
    const span = (frameTimestamps[frameTimestamps.length - 1] - frameTimestamps[0]) / 1000;
    if (span <= 0) return 0;
    return Math.round((frameTimestamps.length - 1) / span);
  }
  function pushFrame(buf) {
    if (!buf || buf.length < 1000) return;
    lastFrameTime = Date.now();
    recordFrameForFps(lastFrameTime);
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
  let h264ShellProc = null;
  let h264RestartTimer = null;
  let h264WatchdogTimer = null;
  let h264LastFrameAt = 0;
  let h264FailedStarts = 0;
  let h264DisabledUntil = 0;
  let h264BackoffCount = 0;   // resets when h264 produces a frame
  let h264Wedged = false;     // true after 3 consecutive backoff cycles

  // WebCodecs delivery: /stream-h264 broadcasts raw Annex-B NAL units to
  // clients. We split screenrecord and ffmpeg into separate child processes
  // and fan out screenrecord's h264 output to both: ffmpeg (which produces
  // MJPEG for the legacy <img src=/stream> path) and the H264_CLIENTS set
  // (HTTP response objects for /stream-h264).
  let screenrecordProc = null;
  let ffmpegProc = null;
  const H264_CLIENTS = new Set();
  // Cache the most recent SPS (NAL type 7) + PPS (NAL type 8) so new
  // clients can initialise their decoder without waiting for the next IDR.
  let h264ParameterSets = null;

  function findNaluTypes(chunk) {
    // Scan Annex-B start codes (0x00 0x00 0x00 0x01 or 0x00 0x00 0x01) and
    // collect SPS/PPS NAL units (the first ones in the stream — they're
    // tiny, contain encoder config, and don't change unless resolution does).
    const out = [];
    let i = 0;
    while (i < chunk.length - 4) {
      let scLen = 0;
      if (chunk[i] === 0 && chunk[i+1] === 0 && chunk[i+2] === 0 && chunk[i+3] === 1) scLen = 4;
      else if (chunk[i] === 0 && chunk[i+1] === 0 && chunk[i+2] === 1) scLen = 3;
      if (scLen) {
        const nalType = chunk[i + scLen] & 0x1F;
        if (nalType === 7 || nalType === 8) out.push({ start: i, type: nalType });
        i += scLen;
      } else {
        i++;
      }
    }
    return out;
  }

  function broadcastH264(chunk) {
    // Cache SPS + PPS for new client init. We capture once at startup and
    // refresh whenever new SPS/PPS arrive (encoder change). Sufficient for
    // screenrecord which emits them in front of each IDR.
    const nalus = findNaluTypes(chunk);
    if (nalus.length >= 2) {
      // Take from the first SPS start to the byte before whatever follows
      // the last PPS (next start code, if any). Simple approach: just save
      // the head of this chunk if it starts with SPS.
      if (nalus[0].start === 0 && nalus[0].type === 7) {
        // Find end of PPS — first start code after the last sps/pps in nalus.
        const last = nalus[nalus.length - 1];
        // Scan from end-of-last-NAL for the NEXT start code; if none, save through end.
        let end = chunk.length;
        for (let j = last.start + 4; j < chunk.length - 3; j++) {
          if (chunk[j] === 0 && chunk[j+1] === 0 && (chunk[j+2] === 1 || (chunk[j+2] === 0 && chunk[j+3] === 1))) {
            end = j;
            break;
          }
        }
        h264ParameterSets = chunk.slice(0, end);
      }
    }
    for (const client of H264_CLIENTS) {
      try { client.write(chunk); }
      catch { H264_CLIENTS.delete(client); }
    }
  }

  function killH264ProcessGroup() {
    if (screenrecordProc) {
      try { screenrecordProc.kill('SIGKILL'); } catch {}
      screenrecordProc = null;
    }
    if (ffmpegProc) {
      try { ffmpegProc.kill('SIGKILL'); } catch {}
      ffmpegProc = null;
    }
    if (h264ShellProc) {
      const pid = h264ShellProc.pid;
      h264ShellProc = null;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  function startH264Stream() {
    h264RestartTimer = null;
    if (Date.now() < h264DisabledUntil) {
      // Backed off — try again later (handled by the disable timer below).
      return;
    }
    try {
      // Two processes connected by node so we can tap the raw h264 NAL stream
      // between them. screenrecord emits Annex-B h264 → ffmpeg downscales +
      // re-encodes as MJPEG for the legacy <img src=/stream> path. Node fans
      // the screenrecord output to BOTH ffmpeg.stdin AND broadcastH264()
      // (for the WebCodecs /stream-h264 path).
      screenrecordProc = spawn(adbPath, ['-s', SERIAL_REF.current, 'exec-out',
        'screenrecord', '--output-format=h264', '--bit-rate', '2000000', '/dev/stdout'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpegProc = spawn('ffmpeg', ['-loglevel', 'error', '-fflags', '+genpts',
        '-probesize', '100000', '-analyzeduration', '0',
        '-f', 'h264', '-i', 'pipe:0', '-vf', 'scale=540:-2',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.log('[android] h264 stream unavailable (' + e.message + '), screencap fallback only');
      try { if (screenrecordProc) screenrecordProc.kill('SIGKILL'); } catch {}
      try { if (ffmpegProc) ffmpegProc.kill('SIGKILL'); } catch {}
      screenrecordProc = null; ffmpegProc = null;
      return;
    }
    h264LastFrameAt = Date.now();
    screenrecordProc.stderr.on('data', () => {});
    ffmpegProc.stderr.on('data', () => {});

    // Fan-out: every h264 chunk from screenrecord goes to ffmpeg (for MJPEG)
    // AND to WebCodecs clients (raw passthrough). NOTE: h264LastFrameAt is
    // updated ONLY inside ffmpegProc.stdout (where a real JPEG frame is
    // detected) — NOT here. A wedged screenrecord still emits ~44-byte
    // config-only chunks periodically; if we reset the watchdog on those,
    // the stall detector never trips.
    screenrecordProc.stdout.on('data', chunk => {
      if (ffmpegProc && ffmpegProc.stdin.writable) {
        try { ffmpegProc.stdin.write(chunk); } catch {}
      }
      broadcastH264(chunk);
    });
    screenrecordProc.stdout.on('error', () => {});

    // ffmpeg.stdout → MJPEG frames → existing pushFrame path
    let gotFrames = false;
    let frameBuf = Buffer.alloc(0);
    ffmpegProc.stdout.on('data', chunk => {
      frameBuf = Buffer.concat([frameBuf, chunk]);
      let start = -1;
      for (let i = 0; i < frameBuf.length - 1; i++) {
        if (frameBuf[i] === 0xFF && frameBuf[i + 1] === 0xD8) start = i;
        if (start !== -1 && frameBuf[i] === 0xFF && frameBuf[i + 1] === 0xD9) {
          h264LastFrameAt = Date.now();
          gotFrames = true;
          h264FailedStarts = 0; // reset on healthy frame
          if (h264BackoffCount > 0 || h264Wedged) {
            h264BackoffCount = 0;
            h264Wedged = false;
            try { broadcaster('ScreenrecordRecovered', 'h264 stream healthy again', 'ok', { wedged: false }); } catch {}
          }
          pushFrame(frameBuf.slice(start, i + 2));
          frameBuf = frameBuf.slice(i + 2);
          start = -1;
          i = -1;
        }
      }
      if (frameBuf.length > 2 * 1024 * 1024) frameBuf = Buffer.alloc(0);
    });
    let restartHandled = false;
    const restart = () => {
      // Dedupe: two child procs each emit 'close' on the same crash; only
      // run the recovery once per cycle.
      if (restartHandled) return;
      restartHandled = true;
      if (h264WatchdogTimer) { clearInterval(h264WatchdogTimer); h264WatchdogTimer = null; }
      killH264ProcessGroup();
      if (!gotFrames) {
        h264FailedStarts++;
        if (h264FailedStarts >= 3) {
          // After 3 starts producing only SPS/PPS config bytes (no real frames),
          // the phone's MediaCodec encoder is wedged — common on Samsung after
          // a display-off/on cycle. The encoder lives in `mediaserver`, but
          // killing the screenrecord shell process forces MediaCodec to
          // destroy its instance and re-allocate fresh on the next start.
          // This recovers without a phone reboot, typically in <2s.
          h264BackoffCount++;
          // Exponential-ish backoff: 1.5s for the first few cycles (handles
          // the common case — process-level wedge that pkill recovers from
          // fast), then back off aggressively for the rare case where the
          // phone's mediaserver is truly dead and our retries are just
          // burning phone CPU. Without this, a stuck mediaserver pushes the
          // phone's load average to 15+ and makes the whole device unusable.
          let delay;
          if (h264BackoffCount <= 3) delay = 1500;        // first ~5s: fast retry
          else if (h264BackoffCount <= 6) delay = 15000;  // ~45s elapsed: slow down
          else delay = 5 * 60 * 1000;                     // give up retrying for 5 min
          console.log(`[android] h264 wedged (3 starts produced only config bytes); pkill + retry in ${delay}ms (cycle ${h264BackoffCount})`);
          try {
            execFileSync(adbPath, ['-s', SERIAL_REF.current, 'shell', 'pkill', '-f', 'screenrecord'],
                         { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
          } catch {}
          // Also re-assert stay-on-usb in case keyguard re-engagement triggered this.
          if (typeof ensureStayOn === 'function') ensureStayOn();
          h264FailedStarts = 0;
          if (h264RestartTimer) return;
          h264RestartTimer = setTimeout(startH264Stream, delay);
          // Flag wedged state for the cam UI banner after several consecutive
          // recovery attempts (~30s) — gives the human visibility while the
          // server keeps trying. Clears automatically when frames flow again.
          if (h264BackoffCount >= 5 && !h264Wedged) {
            h264Wedged = true;
            try { broadcaster('ScreenrecordWedged',
              `${h264BackoffCount} pkill-respawn cycles — phone MediaCodec stuck despite resets`,
              'warn', { wedged: true, cycles: h264BackoffCount }); } catch {}
          }
          return;
        }
      }
      if (h264RestartTimer) return;
      h264RestartTimer = setTimeout(startH264Stream, 2000);
    };
    screenrecordProc.on('close', restart);
    screenrecordProc.on('error', restart);
    ffmpegProc.on('close', restart);
    ffmpegProc.on('error', restart);
    // ffmpeg's stdin pipe needs an error handler too — when screenrecord
    // dies suddenly, our write() can throw EPIPE; just absorb it.
    ffmpegProc.stdin.on('error', () => {});
    h264WatchdogTimer = setInterval(() => {
      if (Date.now() - h264LastFrameAt > 20000) {
        console.log('[android] h264 stalled (no frame in 20s); restarting');
        restart();
      }
    }, 5000);
  }
  startH264Stream();
  // Safety net — every minute, re-arm if the process died without scheduling
  // its own restart (shouldn't happen with the pkill-respawn watchdog above
  // but cheap to keep as belt-and-suspenders).
  setInterval(() => {
    if (!screenrecordProc && !ffmpegProc && !h264RestartTimer) {
      startH264Stream();
    }
  }, 60 * 1000);

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
      ensureStayOn();
      res.json({ ok: true, serial: SERIAL_REF.current });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Launch a URL on the phone, explicitly targeting Chrome (-p
  // com.android.chrome). Without -p, ACTION_VIEW for http URLs on many
  // Samsung phones routes to Google Lens or shows an intent-picker. Chrome
  // is required anyway because the calibration target uses the Fullscreen
  // API. URL is regex-whitelisted to plain http(s) so no scheme smuggling.
  router.post('/open-url', async (req, res) => {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    if (!/^https?:\/\/[A-Za-z0-9._:\-]+(\/[^\s'"<>`]*)?$/.test(url)) {
      return res.status(400).json({ error: 'invalid url (http/https only, no shell metachars)' });
    }
    try {
      const out = await adbAsync('shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
                                 '-d', url, '-p', 'com.android.chrome');
      res.json({ ok: true, stdout: String(out || '').trim() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Routes: tap, swipe, type, key ──────────────────────────────────────────
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
        replay_of: req.body && req.body.replay_of,
      });
      // Broadcast with whatever source the caller indicated (defaults to
      // 'agent-phone' for external AI agents). Frontend SSE handler
      // differentiates human vs AI to avoid double-painting cursors.
      var tapSource = (req.body && req.body.source === 'human') ? 'human' : 'agent-phone';
      broadcaster('AndroidTap', `(${xi}, ${yi})`, 'ok', { phoneX: xi, phoneY: yi, source: tapSource });
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
      teach.captureStep({
        action: 'swipe',
        args: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), dur: safeDur },
        screenshotBuffer: captureSessionFrame(),
        metaArgs: { device: SERIAL_REF.current, screen_w: cachedScreenW, screen_h: cachedScreenH },
        replay_of: req.body && req.body.replay_of,
      });
      // Broadcast with the caller's source so the frontend can differentiate
      // (humans need the trail without the cursor flicker; AI gets both).
      var swSource = (req.body && req.body.source === 'human') ? 'human' : 'agent-phone';
      broadcaster('AndroidSwipe',
        `(${Math.round(x1)},${Math.round(y1)})→(${Math.round(x2)},${Math.round(y2)})`,
        'ok',
        {
          phoneX1: Math.round(x1), phoneY1: Math.round(y1),
          phoneX2: Math.round(x2), phoneY2: Math.round(y2),
          phoneX:  Math.round(x2), phoneY:  Math.round(y2),
          dur: safeDur,
          source: swSource,
        });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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

  // Raw Annex-B h264 NAL stream for WebCodecs clients. ~5x lower latency
  // than the MJPEG path (no ffmpeg re-encode, no multipart parsing) and
  // ~2-3x lower bandwidth at the same visual quality. Falls back to /stream
  // automatically on the client side when WebCodecs isn't supported or this
  // endpoint isn't producing frames.
  router.get('/stream-h264', (req, res) => {
    res.set({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    H264_CLIENTS.add(res);
    // Prime the new client with cached SPS+PPS so its decoder can configure
    // itself without waiting for the next IDR frame from screenrecord.
    if (h264ParameterSets) {
      try { res.write(h264ParameterSets); } catch {}
    }
    req.on('close', () => H264_CLIENTS.delete(res));
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
      screenrecord_wedged: h264Wedged,
      screenrecord_backoff_cycles: h264BackoffCount,
      fps: currentFps(),
    });
  });

  // Reboot the phone. Used by the cam UI's reboot button and (auto-suggested)
  // when /status shows screenrecord_wedged after the watchdog escalation.
  // Phone is offline for ~30-45 seconds during boot; the existing reconnect
  // loop picks it back up.
  router.post('/reboot', async (req, res) => {
    try {
      await adbAsync('reboot');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

  // ── App favorites (apps.json) — read/add/remove for the launcher popup. ─
  // Stored alongside the server module so it persists across restarts; not
  // git-tracked (added to .gitignore) since it's per-deployment user data.
  const APPS_JSON_PATH = path.join(__dirname, 'apps.json');
  const DEFAULT_APPS = [
    { pkg: 'com.android.settings', name: 'Settings' },
    { pkg: 'com.android.chrome',   name: 'Chrome' },
    { pkg: 'com.whatsapp',         name: 'WhatsApp' },
  ];
  function loadApps() {
    try {
      const raw = fs.readFileSync(APPS_JSON_PATH, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch {}
    return DEFAULT_APPS.slice();
  }
  function saveApps(apps) {
    try { fs.writeFileSync(APPS_JSON_PATH, JSON.stringify(apps, null, 2)); } catch {}
  }
  router.get('/apps', (req, res) => {
    res.json(loadApps());
  });
  router.post('/apps', (req, res) => {
    const { pkg, name } = req.body || {};
    if (!pkg || !name) return res.status(400).json({ error: 'pkg and name required' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(String(pkg))) {
      return res.status(400).json({ error: 'invalid package name' });
    }
    const apps = loadApps();
    if (apps.find(a => a.pkg === pkg)) {
      return res.json({ ok: true, deduped: true });
    }
    apps.push({ pkg: String(pkg), name: String(name).slice(0, 40) });
    saveApps(apps);
    res.json({ ok: true });
  });
  router.delete('/apps/:pkg', (req, res) => {
    const pkg = req.params.pkg;
    const apps = loadApps().filter(a => a.pkg !== pkg);
    saveApps(apps);
    res.json({ ok: true });
  });

  // Pull all user-installed (non-system) packages from the phone so the
  // Add-app UI can offer a pick list instead of a free-text prompt. Output
  // of `pm list packages -3` is one line per package, prefixed `package:`.
  router.get('/apps/installed', async (req, res) => {
    try {
      const out = (await adbAsync('shell', 'pm list packages -3')).toString();
      const pkgs = out.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('package:'))
        .map(l => l.slice('package:'.length))
        .filter(Boolean)
        .sort();
      res.json(pkgs);
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
module.exports.setBroadcaster = setBroadcaster;
module.exports.getForeground = () => getForeground;
module.exports.parseWakefulness = parseWakefulness;
