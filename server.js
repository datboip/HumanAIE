const AUTH_USER = process.env.HUMANAIE_USER || "";
const AUTH_PASS = process.env.HUMANAIE_PASS || "";
// DATA_DIR — base directory for sessions, history, and data files
const DATA_DIR = process.env.HUMANAIE_DATA_DIR || process.cwd();
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || `${DATA_DIR}/browsers`;
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ── Human takeover flag ──────────────────────────────────────────────────────
let humanControl = false;

// ── Global crash guards — keep the process alive no matter what ───────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Don't exit — log and continue
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  // Don't exit — log and continue
});

const _pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'package.json'), 'utf-8'));
const APP_VERSION = _pkg.version || '0.0.0';
const APP_NAME = _pkg.name || 'humanaie';

const app = express();
app.use(express.json());

// HTTP Basic Auth (skip for localhost and SSE endpoint)
const AUTH_ENABLED = AUTH_USER && AUTH_PASS;
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('::ffff:127.0.0.1');
  const isMedia = req.path.match(/^\/sessions\/.+\/(mp4|edited\/.+|thumbnail)$/);
  if (isLocal || req.path === '/events' || req.path === '/stream' || isMedia) return next();
  if (!AUTH_ENABLED) return next();
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="HumanAIE"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="HumanAIE"');
  return res.status(401).send('Invalid credentials');
});

app.use(express.static(path.join(__dirname, 'public')));

let browser, context;
let tabs = [];        // [{ id, page }]
let activeTabId = null;
let tabCounter = 0;
let page = null;      // always mirrors the active tab's page

function getTabList() {
  return tabs.map(t => ({
    id: t.id,
    url: (() => { try { return t.page.url(); } catch(e) { return 'about:blank'; } })(),
    active: t.id === activeTabId,
  }));
}

function switchActiveTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return false;
  activeTabId = id;
  page = tab.page;
  pushAction('Tab', `Switched to tab ${id}`, 'ok', { tabs: getTabList() });
  return true;
}

async function createTab(url = 'about:blank') {
  const id = ++tabCounter;
  const p = await context.newPage();
  if (url !== 'about:blank') {
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch(e) {}
  }
  tabs.push({ id, page: p });
  switchActiveTab(id);
  pushAction('New Tab', `Tab ${id}: ${url}`, 'ok', { tabs: getTabList() });
  return id;
}

async function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1 || tabs.length <= 1) return false;
  const tab = tabs[idx];
  try { await tab.page.close(); } catch(e) {}
  tabs.splice(idx, 1);
  if (activeTabId === id) switchActiveTab(tabs[Math.max(0, idx - 1)].id);
  pushAction('Close Tab', `Tab ${id} closed`, 'ok', { tabs: getTabList() });
  return true;
}

// ── Frame cache + MJPEG stream ────────────────────────────────────────────────
let latestFrame = null;          // latest captured JPEG buffer — always in memory
const streamClients = [];        // active MJPEG stream response objects

function pushStreamFrame(buf) {
  latestFrame = buf;
  if (!streamClients.length) return;
  const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
  for (let i = streamClients.length - 1; i >= 0; i--) {
    try {
      streamClients[i].write(header);
      streamClients[i].write(buf);
      streamClients[i].write('\r\n');
    } catch(e) {
      streamClients.splice(i, 1);
    }
  }
}

// ── Action log + SSE ─────────────────────────────────────────────────────────
const actionLog = [];
const sseClients = [];

function pushAction(type, detail, status = 'ok', extra = {}) {
  const entry = { time: new Date().toISOString(), type, detail, status, ...extra };
  actionLog.push(entry);
  if (actionLog.length > 200) actionLog.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach(r => r.write(data));
  console.log(`[${status.toUpperCase()}] ${type}: ${detail}`);
}

// MJPEG stream — push-based live view, no polling needed
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  streamClients.push(res);
  // Send latest cached frame immediately so viewer isn't blank
  if (latestFrame) {
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`;
    try { res.write(header); res.write(latestFrame); res.write('\r\n'); } catch(e) {}
  }
  req.on('close', () => {
    const idx = streamClients.indexOf(res);
    if (idx !== -1) streamClients.splice(idx, 1);
  });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  actionLog.slice(-50).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ── Recording ────────────────────────────────────────────────────────────────
const SESSIONS_DIR = `${DATA_DIR}/humanaie-sessions`;
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let recording = false;
let currentSession = null;

function startSession() {
  const id = `session-${Date.now()}`;
  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const vp = page ? page.viewportSize() : { width: 1280, height: 800 };
  currentSession = { id, dir, frameIndex: 0, startTime: new Date().toISOString(), actions: [], hasActivity: false, width: vp ? vp.width : 1280, height: vp ? vp.height : 800 };
  recording = true;
  pushAction('Recording', 'Started', 'ok', { recording: true });
  return id;
}

// isManual=true means user explicitly stopped — always keep.
// isManual=false means auto-rotate — purge if nothing happened.
function stopSession(isManual = false) {
  if (!currentSession) return null;
  recording = false;
  const sess = currentSession;
  currentSession = null;

  // Auto-purge blank sessions (idle auto-rotations with no user actions)
  if (!isManual && !sess.hasActivity) {
    try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch(e) {}
    pushAction('Purged', 'Blank session (no activity)', 'info', { recording: false });
    return sess.id;
  }

  fs.writeFileSync(path.join(sess.dir, 'meta.json'), JSON.stringify({
    id: sess.id, startTime: sess.startTime,
    endTime: new Date().toISOString(),
    frameCount: sess.frameIndex, actions: sess.actions,
    width: sess.width || 1280, height: sess.height || 800,
  }, null, 2));
  pushAction('Recording', `Stopped — ${sess.frameIndex} frames`, 'ok', { recording: false });
  generateOutputs(sess);
  return sess.id;
}

// Prune oldest sessions when total size exceeds 10GB
const MAX_BYTES = 10 * 1024 * 1024 * 1024;

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
  } catch (e) {}
  return total;
}

function pruneOldSessions() {
  try {
    const all = fs.readdirSync(SESSIONS_DIR)
      .filter(d => fs.existsSync(path.join(SESSIONS_DIR, d, 'meta.json')))
      .map(d => {
        const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, d, 'meta.json'), 'utf8'));
        return { id: d, startTime: meta.startTime };
      })
      .sort((a, b) => a.startTime.localeCompare(b.startTime)); // oldest first

    let total = dirSize(SESSIONS_DIR);
    for (const s of all) {
      if (total <= MAX_BYTES) break;
      const sDir = path.join(SESSIONS_DIR, s.id);
      const sSize = dirSize(sDir);
      fs.rmSync(sDir, { recursive: true, force: true });
      total -= sSize;
      console.log(`[CLEANUP] Deleted old session ${s.id} (freed ${(sSize/1024/1024).toFixed(1)}MB)`);
    }
  } catch (e) { /* ignore */ }
}

// Dead-time trimming: build ranges of frames worth keeping around real activity.
// Params tuned for 500ms-per-frame capture rate (2fps).
function getActivityRanges(actions, totalFrames) {
  const BEFORE = 2;     // frames to include before each action (~1s)
  const AFTER  = 4;     // frames to include after each action (~2s)
  const MERGE  = 4;     // merge ranges within this many frames (~2s)

  const activityFrames = (actions || [])
    .filter(a => a.label !== 'auto')
    .map(a => a.frame)
    .filter(f => f >= 0 && f < totalFrames);

  if (!activityFrames.length) return null; // no activity — use all frames

  // Build [start, end] ranges (inclusive)
  let ranges = activityFrames.map(f => [
    Math.max(0, f - BEFORE),
    Math.min(totalFrames - 1, f + AFTER),
  ]);

  // Sort by start frame
  ranges.sort((a, b) => a[0] - b[0]);

  // Merge overlapping / nearby ranges
  const merged = [[...ranges[0]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1] + MERGE + 1) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push([...ranges[i]]);
    }
  }
  return merged;
}

function generateOutputs(sess) {
  const dir = sess.dir;

  // Read frames from disk
  const frames = fs.readdirSync(dir)
    .filter(f => f.startsWith('frame-') && f.endsWith('.jpg'))
    .sort();
  if (!frames.length) return;

  // Thumbnail: use first activity frame (or frame 0 as fallback)
  try {
    const firstActivity = (sess.actions || []).find(a => a.label !== 'auto');
    const thumbIdx = firstActivity ? Math.max(0, firstActivity.frame - 1) : 0;
    const thumbSrc = path.join(dir, frames[Math.min(thumbIdx, frames.length - 1)]);
    fs.copyFileSync(thumbSrc, path.join(dir, 'thumbnail.jpg'));
  } catch(e) {}

  // Compute which frames to keep
  const ranges = getActivityRanges(sess.actions, frames.length);

  let ffmpegArgs, selectedCount;
  const outputMp4 = path.join(dir, 'replay.mp4');

  if (!ranges) {
    // No activity recorded — keep everything (shouldn't happen due to purge, but safe)
    selectedCount = frames.length;
    // Build concat list even for all-frames case to avoid glob shell expansion
    const concatAllPath = path.join(dir, 'concat.txt');
    fs.writeFileSync(concatAllPath,
      frames.map(f => `file '${path.join(dir, f)}'\nduration 0.25`).join('\n') + '\n'
    );
    ffmpegArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', concatAllPath,
      '-vf', 'scale=640:-2', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', outputMp4];
  } else {
    // Build list of selected frames from ranges
    const selected = [];
    for (const [start, end] of ranges) {
      for (let i = start; i <= end && i < frames.length; i++) selected.push(frames[i]);
    }
    selectedCount = selected.length;

    // Write ffmpeg concat list (each frame shown for 0.5s = 2fps, matches capture rate)
    const concatPath = path.join(dir, 'concat.txt');
    fs.writeFileSync(concatPath,
      selected.map(f => `file '${path.join(dir, f)}'\nduration 0.5`).join('\n') + '\n'
    );

    ffmpegArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-vf', 'scale=640:-2', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', outputMp4];
  }

  execFile('ffmpeg', ffmpegArgs, (err) => {
    // Clean up concat list
    try { fs.unlinkSync(path.join(dir, 'concat.txt')); } catch(e) {}

    if (err) {
      pushAction('MP4 failed', err.message.substring(0, 80), 'err');
    } else {
      // Delete raw frames — MP4 is the source of truth now
      try {
        frames.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch(e) {} });
      } catch(e) {}

      const mp4Size = (() => { try { return (fs.statSync(`${dir}/replay.mp4`).size / 1024 / 1024).toFixed(1) + 'MB'; } catch(e) { return '?'; } })();
      const keptPct = Math.round((selectedCount / frames.length) * 100);
      const trimMsg = ranges ? `${keptPct}% kept (dead time trimmed)` : 'all frames';
      pushAction('MP4 ready', `${mp4Size} · ${trimMsg}`, 'ok', { sessionId: sess.id });
      pruneOldSessions();
    }
  });
}

app.get('/version', (req, res) => {
  res.json({ name: APP_NAME, version: APP_VERSION });
});

// ── Live status — public "browser is live" indicator ────────────────────────────
app.get('/live/status', (req, res) => {
  var currentUrl = page ? page.url() : '';
  res.json({
    live: !!page && currentUrl !== 'about:blank',
    url: currentUrl,
    humanControl: humanControl || false
  });
});

// ── Human takeover endpoints ─────────────────────────────────────────────────
app.post('/takeover', (req, res) => {
  humanControl = true;
  res.json({ success: true, humanControl: true });
});

app.post('/release', (req, res) => {
  humanControl = false;
  res.json({ success: true, humanControl: false });
});

// ── HumanAIE interaction endpoints (used by MCP tools in worker containers) ────
app.post('/live/click', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    const { x, y } = req.body;
    await page.mouse.click(x, y);
    pushAction("Click", `(${x}, ${y})`, "ok", { clickX: x, clickY: y, source: "agent" });
    const buf = await captureBuf();
    const screenshot = buf ? buf.toString('base64') : null;
    res.json({ success: true, screenshot, url: page.url() });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/live/type', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    await page.keyboard.type(req.body.text || '');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/live/scroll', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    const { direction = 'down', amount = 300 } = req.body;
    const delta = direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, delta);
    await new Promise(r => setTimeout(r, 300));
    const buf = await captureBuf();
    const screenshot = buf ? buf.toString('base64') : null;
    res.json({ success: true, screenshot });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/live/key', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    await page.keyboard.press(req.body.key || 'Enter');
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ── Fast raw JPEG frame — serves latestFrame directly, no base64/JSON overhead
app.get('/frame.jpg', (req, res) => {
  if (!latestFrame) {
    res.status(204).end();
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.end(latestFrame);
});

app.post('/record/start', (req, res) => {
  if (recording) return res.json({ success: false, error: 'Already recording' });
  res.json({ success: true, id: startSession() });
});

app.post('/record/stop', (req, res) => {
  if (!recording) return res.json({ success: false, error: 'Not recording' });
  res.json({ success: true, id: stopSession(true) }); // manual stop — always keep
});

app.get('/record/status', (req, res) => {
  res.json({ recording, sessionId: currentSession ? currentSession.id : null, frameCount: currentSession ? currentSession.frameIndex : 0 });
});

app.get('/sessions', (req, res) => {
  try {
    const sessions = fs.readdirSync(SESSIONS_DIR)
      .filter(d => fs.existsSync(path.join(SESSIONS_DIR, d, 'meta.json')))
      .map(d => {
        const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, d, 'meta.json'), 'utf8'));
        const namePath = path.join(SESSIONS_DIR, d, 'name.txt');
        const name = fs.existsSync(namePath) ? fs.readFileSync(namePath, 'utf8').trim() : null;
        const w = meta.width || 1280, h = meta.height || 800;
        const ratio = w / h;
        const format = ratio < 0.75 ? 'vertical' : ratio > 1.4 ? 'wide' : 'square';
        return {
          ...meta,
          name,
          width: w, height: h, format,
          mp4Ready: fs.existsSync(path.join(SESSIONS_DIR, d, 'replay.mp4')),
        };
      })
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
    res.json({ sessions });
  } catch (e) {
    res.json({ sessions: [] });
  }
});

app.patch('/sessions/:id/rename', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  const sessionDir = path.join(SESSIONS_DIR, id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });
  const name = (req.body.name || '').trim().substring(0, 60);
  const namePath = path.join(sessionDir, 'name.txt');
  if (name) {
    fs.writeFileSync(namePath, name);
  } else {
    try { fs.unlinkSync(namePath); } catch(e) {}
  }
  res.json({ ok: true, name: name || null });
});

app.get('/sessions/:id/mp4', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  const f = path.join(SESSIONS_DIR, id, 'replay.mp4');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'MP4 not ready yet' });
  res.sendFile(f);
});

app.get('/sessions/:id/thumbnail', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  const f = path.join(SESSIONS_DIR, id, 'thumbnail.jpg');
  if (!fs.existsSync(f)) return res.status(404).send('');
  res.sendFile(f);
});

app.delete('/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  const sessionDir = path.join(SESSIONS_DIR, id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sessions/:id/edited/:filename', (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  if (filename.includes('..') || filename.includes('/')) return res.status(400).json({ error: 'invalid' });
  const f = path.join(SESSIONS_DIR, id, filename);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(f);
});

function buildEditArgs(inputFile, outputFile, opts) {
  const { trimStart = 0, trimEnd = null, speed = 1, cropVertical = false, text = '', textPos = 'top' } = opts;

  // Reject shell metacharacters in text overlay to prevent injection via ffmpeg filter strings
  if (text && /[`$;|&<>(){}[\]!#]/.test(text)) {
    throw new Error('Text contains disallowed characters');
  }

  let filters = [];

  if (speed !== 1 && speed > 0) filters.push(`setpts=${(1/speed).toFixed(4)}*PTS`);

  if (cropVertical) {
    filters.push(`crop=ih*9/16:ih:(iw-ih*9/16)/2:0`);
    filters.push(`scale=1080:1920`);
  }

  if (text) {
    const yMap = { top: 'h*0.08', middle: '(h-text_h)/2', bottom: 'h*0.85' };
    const y = yMap[textPos] || 'h*0.08';
    const escaped = text.replace(/\\/g,'\\\\').replace(/'/g,"\u2019").replace(/:/g,'\\:');
    filters.push(`drawtext=text='${escaped}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.55:boxborderw=12`);
  }

  const args = ['-y'];
  if (trimStart > 0) args.push('-ss', String(trimStart));
  args.push('-i', inputFile);
  if (trimEnd && trimEnd > trimStart) args.push('-t', String(trimEnd - trimStart));
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', outputFile);
  return args;
}

app.post('/sessions/:id/edit', (req, res) => {
  const id = req.params.id;
  if (id.includes('..') || id.includes('/')) return res.status(400).json({ error: 'invalid' });
  const inputFile = path.join(SESSIONS_DIR, id, 'replay.mp4');
  if (!fs.existsSync(inputFile)) return res.status(404).json({ error: 'Source MP4 not found' });
  const outName = `edited-${Date.now()}.mp4`;
  const outputFile = path.join(SESSIONS_DIR, id, outName);
  let editArgs;
  try { editArgs = buildEditArgs(inputFile, outputFile, req.body); }
  catch(e) { return res.status(400).json({ error: e.message }); }
  pushAction('Editing', `${id} — ffmpeg ${editArgs.slice(0, 4).join(' ')}...`, 'info');
  execFile('ffmpeg', editArgs, { timeout: 300000 }, (err) => {
    if (err) {
      pushAction('Edit failed', err.message.substring(0, 80), 'err');
      return res.status(500).json({ error: err.message });
    }
    const size = (() => { try { return (fs.statSync(outputFile).size/1024/1024).toFixed(1)+'MB'; } catch(e) { return '?'; } })();
    pushAction('Edit ready', `${size} — /sessions/${req.params.id}/edited/${outName}`, 'ok');
    res.json({ success: true, file: outName, url: `/sessions/${req.params.id}/edited/${outName}`, size });
  });
});

// Auto-rotate session every 600 frames (~5min at 2fps) so replays appear reasonably
const AUTO_ROTATE_FRAMES = 600;

function saveFrame(buf, label) {
  if (!recording || !currentSession) return;
  const n = String(currentSession.frameIndex).padStart(4, '0');
  fs.writeFileSync(path.join(currentSession.dir, `frame-${n}.jpg`), buf);
  currentSession.actions.push({ frame: currentSession.frameIndex, label, time: new Date().toISOString() });
  // Mark session as having real activity (not just idle auto-frames)
  if (label !== 'auto') currentSession.hasActivity = true;
  currentSession.frameIndex++;
  // Auto-rotate if too many frames — auto-rotate purges blank sessions
  if (currentSession.frameIndex >= AUTO_ROTATE_FRAMES) {
    stopSession(false); // auto, not manual
    startSession();
  }
}

// ── Screenshot stream — Playwright screenshot polling ─────────────────────────
let ffmpegProc = null;

function startScreenshotStream() {
  if (ffmpegProc) return; // reuse var as interval handle
  console.log('[stream] Starting Playwright screenshot stream at ~2fps');
  ffmpegProc = setInterval(async () => {
    try {
      const buf = await captureStreamBuf();
      if (buf) {
        latestFrame = buf;
        if (streamClients.length > 0) pushStreamFrame(buf);
      }
    } catch(e) {}
  }, 80);
}

// ── Auto-frame timer — saves a frame every 500ms while recording ──────────────
let autoFrameTimer = null;

function startAutoFrameTimer() {
  if (autoFrameTimer) return;
  autoFrameTimer = setInterval(() => {
    if (!recording || !page) return;
    // Use cached frame — instant, no extra Playwright call
    if (latestFrame) saveFrame(latestFrame, 'auto');
  }, 500);
}

// ── Browser ───────────────────────────────────────────────────────────────────
let browserRestarting = false;

async function initBrowser() {
  // Use Playwright bundled Chromium in headless mode
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-position=0,0',
      '--window-size=1280,720',
      '--app=about:blank',
    ]
  });
  const contextOptions = { viewport: { width: 1280, height: 720 } };
  context = await browser.newContext(contextOptions);

  // Auto-restart browser if Chromium crashes
  browser.on('disconnected', () => {
    if (browserRestarting) return;
    browserRestarting = true;
    console.error('[browser] Chromium disconnected — restarting in 3s...');
    // Clear state immediately and notify clients so UI doesn't show stale tabs
    tabs = []; page = null; activeTabId = null; tabCounter = 0;
    pushAction('Browser', 'Crashed — restarting...', 'err', { tabs: [] });
    setTimeout(async () => {
      try {
        await initBrowser();
        browserRestarting = false;
        pushAction('Browser', 'Restarted after crash', 'ok');
      } catch(e) {
        browserRestarting = false;
        console.error('[browser] Restart failed:', e.message);
        // Try again in 10s
        setTimeout(() => { browserRestarting = false; initBrowser().catch(console.error); }, 10000);
      }
    }, 3000);
  });

  await createTab('about:blank');
  pushAction('Browser', 'Ready', 'ok');
  // Auto-start recording immediately
  startSession();
  startScreenshotStream();
  startAutoFrameTimer(); // saves cached latestFrame to disk for recording
}

// ── Tab endpoints ──────────────────────────────────────────────────────────────
app.get('/tabs', (req, res) => {
  res.json({ tabs: getTabList(), activeTabId });
});

app.post('/tabs/new', async (req, res) => {
  const { url = 'about:blank' } = req.body;
  try {
    const id = await createTab(url);
    const img = await shot(`New Tab: ${url}`);
    res.json({ success: true, id, tabs: getTabList(), screenshot: img, url: page.url() });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/tabs/switch', async (req, res) => {
  const { id } = req.body;
  if (!switchActiveTab(id)) return res.json({ success: false, error: 'Tab not found' });
  const img = await shot(`Switch to Tab ${id}`);
  res.json({ success: true, id, tabs: getTabList(), screenshot: img, url: page.url() });
});

app.delete('/tabs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const ok = await closeTab(id);
  if (!ok) return res.json({ success: false, error: 'Tab not found or last tab' });
  const img = await shot('Close Tab');
  res.json({ success: true, tabs: getTabList(), screenshot: img, url: page ? page.url() : '' });
});

// Returns raw Buffer (not base64)
async function captureBuf() {
  if (!page) return null;
  try { return await page.screenshot({ type: 'jpeg', quality: 80 }); }
  catch (e) { return null; }
}

// Low-quality capture for the MJPEG stream — saves bandwidth
async function captureStreamBuf() {
  if (!page) return null;
  try { return await page.screenshot({ type: 'jpeg', quality: 75 }); }
  catch (e) { return null; }
}

// Take screenshot, save frame if recording, return base64
async function shot(label) {
  const buf = await captureBuf();
  if (!buf) return null;
  if (recording) saveFrame(buf, label);
  return buf.toString('base64');
}

app.get('/screenshot', async (req, res) => {
  // Return cached frame instantly if available — no new Playwright capture needed
  const buf = latestFrame || await captureBuf();
  if (!buf) return res.status(500).json({ error: 'No browser' });
  res.json({ screenshot: buf.toString('base64'), url: page ? page.url() : '' });
});

// Store highlights for AI to read
let highlights = [];

// Bot asks user to highlight something
let waitforHighlight = null; // { message, since }

app.post('/waitfor-highlight', (req, res) => {
  const { message } = req.body;
  waitforHighlight = { message: message || 'Please highlight what I should click', since: new Date().toISOString() };
  highlights = []; // clear old highlights
  res.json({ success: true, waiting: true, message: waitforHighlight.message });
});

app.get('/waitfor-highlight/status', (req, res) => {
  if (!waitforHighlight) return res.json({ waiting: false });
  res.json({
    waiting: true,
    message: waitforHighlight.message,
    since: waitforHighlight.since,
    highlights: highlights,
    answered: highlights.length > 0,
    corrections: highlights.filter(h => h.label && h.label.startsWith('CORRECTION:')).map(h => h.label.replace('CORRECTION: ', '')),
    points: highlights.filter(h => h.label && !h.label.startsWith('CORRECTION:'))
  });
});

app.post('/waitfor-highlight/done', (req, res) => {
  const result = { highlights: [...highlights], message: waitforHighlight ? waitforHighlight.message : '' };
  // Log the full interaction
  try {
    const logPath = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'highlight-history.jsonl');
    const logEntry = {
      type: 'waitfor-complete',
      question: waitforHighlight ? waitforHighlight.message : '',
      highlights: [...highlights],
      url: page ? page.url() : '',
      timestamp: new Date().toISOString()
    };
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch(e) {}
  waitforHighlight = null;
  highlights = [];
  res.json({ success: true, ...result });
});

app.post('/highlight', (req, res) => {
  const { x, y, label } = req.body;
  const entry = { x, y, label: label || '', time: new Date().toISOString() };
  highlights.push(entry);
  // Persist to log file so AI can recall past highlights
  try {
    const logEntry = { ...entry, url: page ? page.url() : '', timestamp: new Date().toISOString() };
    const logPath = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'highlight-history.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch(e) {}
  if (highlights.length > 20) highlights.shift();
  res.json({ success: true, highlights });
});

// Search highlight history by URL or label
app.get('/highlight-history', (req, res) => {
  try {
    const logPath = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'highlight-history.jsonl');
    if (!fs.existsSync(logPath)) return res.json({ history: [] });
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const url = req.query.url || null;
    const q = req.query.q || null;

    if (url) entries = entries.filter(e => e.url && e.url.includes(url));
    if (q) entries = entries.filter(e => (e.label || '').toLowerCase().includes(q.toLowerCase()) || (e.url || '').toLowerCase().includes(q.toLowerCase()));

    // Group by URL for easy lookup
    const byUrl = {};
    entries.forEach(e => {
      const domain = e.url ? new URL(e.url).hostname : 'unknown';
      if (!byUrl[domain]) byUrl[domain] = [];
      byUrl[domain].push({ x: e.x, y: e.y, label: e.label, url: e.url, time: e.timestamp || e.time });
    });

    res.json({ history: entries.slice(-50), byUrl, total: entries.length });
  } catch(e) { res.json({ history: [], error: e.message }); }
});

app.get('/highlights', (req, res) => {
  res.json({ highlights, url: page ? page.url() : '' });
});

app.delete('/highlights', (req, res) => {
  highlights = [];
  res.json({ success: true });
});

app.post('/resize', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    var w = parseInt(req.body.width) || 1280;
    var h = parseInt(req.body.height) || 720;
    w = Math.max(800, Math.min(1920, w));
    h = Math.max(600, Math.min(1200, h));
    await page.setViewportSize({ width: w, height: h });
    res.json({ success: true, width: w, height: h });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/viewport-size', (req, res) => {
  if (!page) return res.json({ width: 1280, height: 720 });
  var vp = page.viewportSize();
  res.json(vp || { width: 1280, height: 720 });
});

// Browsing history
let browsingHistory = [];
const HISTORY_FILE = require('path').join(process.env.HUMANAIE_DATA_DIR || process.cwd(), 'history.json');

// Load history from disk
try {
  if (fs.existsSync(HISTORY_FILE)) {
    browsingHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  }
} catch(e) {}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(browsingHistory)); } catch(e) {}
}

function addToHistory(url, title) {
  if (!url || url === 'about:blank') return;
  browsingHistory.unshift({ url: url, title: title || '', time: new Date().toISOString() });
  if (browsingHistory.length > 500) browsingHistory = browsingHistory.slice(0, 500);
  saveHistory();
}

app.get('/history', (req, res) => {
  var limit = parseInt(req.query.limit) || 50;
  var q = req.query.q || '';
  var results = browsingHistory;
  if (q) results = results.filter(h => (h.url + ' ' + h.title).toLowerCase().includes(q.toLowerCase()));
  res.json({ history: results.slice(0, limit), total: results.length });
});

app.get('/history/frequent', (req, res) => {
  // Count visits per domain
  var counts = {};
  browsingHistory.forEach(function(h) {
    try {
      var domain = new URL(h.url).hostname;
      counts[domain] = (counts[domain] || { domain: domain, url: h.url, count: 0 });
      counts[domain].count++;
    } catch(e) {}
  });
  var sorted = Object.values(counts).sort(function(a, b) { return b.count - a.count; });
  res.json({ frequent: sorted.slice(0, 10) });
});

app.delete('/history', (req, res) => {
  browsingHistory = [];
  saveHistory();
  res.json({ success: true });
});

app.post('/back', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    const img = buf ? buf.toString('base64') : null;
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/forward', async (req, res) => {
  if (!page) return res.json({ success: false, error: 'No active page' });
  try {
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    const img = buf ? buf.toString('base64') : null;
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/navigate', async (req, res) => {
  addToHistory(req.body.url, '');
  const { url } = req.body;
  pushAction('Navigate', url, 'info');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const img = await shot(`Navigate: ${url}`);
    pushAction('Loaded', page.url(), 'ok', { tabs: getTabList() });
    res.json({ success: true, screenshot: img, url: page.url(), tabs: getTabList() });
  } catch (e) {
    pushAction('Navigate failed', e.message, 'err');
    res.json({ success: false, error: e.message });
  }
});

app.post('/hover', async (req, res) => {
  const { x, y } = req.body;
  pushAction('Hover', `(${x}, ${y})`, 'info', { clickX: x, clickY: y, source: 'agent' });
  try {
    await page.mouse.move(x, y);
    await page.waitForTimeout(800);
    const img = await shot(`Hover (${x},${y})`);
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/type', async (req, res) => {
  const { text } = req.body;
  pushAction('Type', `"${text}"`, 'info');
  try {
    await page.keyboard.type(text);
    await page.waitForTimeout(400);
    const img = await shot(`Type: ${text}`);
    pushAction('Typed', `"${text}"`, 'ok');
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch (e) {
    pushAction('Type failed', e.message, 'err');
    res.json({ success: false, error: e.message });
  }
});

app.post('/key', async (req, res) => {
  const { key } = req.body;
  pushAction('Key', key, 'info');
  try {
    await page.keyboard.press(key);
    await page.waitForTimeout(600);
    const img = await shot(`Key: ${key}`);
    pushAction('Key pressed', key, 'ok');
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch (e) {
    pushAction('Key failed', e.message, 'err');
    res.json({ success: false, error: e.message });
  }
});

app.post('/scroll', async (req, res) => {
  const { deltaY } = req.body;
  pushAction('Scroll', `${deltaY > 0 ? 'down' : 'up'} ${Math.abs(deltaY)}px`, 'info');
  try {
    await page.mouse.wheel(0, deltaY || 300);
    await page.waitForTimeout(400);
    const img = await shot(`Scroll ${deltaY}`);
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/fill', async (req, res) => {
  const { selector, value } = req.body;
  pushAction('Fill', `${selector} = "${value}"`, 'info');
  try {
    await page.fill(selector, value, { timeout: 5000 });
    await page.waitForTimeout(400);
    const img = await shot(`Fill ${selector}`);
    pushAction('Filled', selector, 'ok');
    res.json({ success: true, screenshot: img, url: page.url() });
  } catch (e) {
    pushAction('Fill failed', e.message, 'err');
    res.json({ success: false, error: e.message });
  }
});

app.post('/wait', async (req, res) => {
  const { selector, timeout } = req.body;
  try {
    if (selector) await page.waitForSelector(selector, { timeout: timeout || 10000 });
    else await page.waitForTimeout(timeout || 1000);
    const buf = await captureBuf();
    res.json({ success: true, screenshot: buf ? buf.toString('base64') : null, url: page.url() });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/refresh', async (req, res) => {
  // Use cached frame for fast response
  const buf = latestFrame || await captureBuf();
  res.json({ screenshot: buf ? buf.toString('base64') : null, url: page ? page.url() : '' });
});

// ── Static files for /cam/ UI ────────────────────────────────────────────────
app.use('/cam', express.static(path.join(__dirname, 'public', 'cam')));

const PORT = process.env.HUMANAIE_PORT || process.env.PORT || '3333';
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`HumanAIE running at http://0.0.0.0:${PORT}`);
  // Retry browser init up to 5 times before giving up
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await initBrowser();
      break;
    } catch(e) {
      console.error(`[startup] Browser init attempt ${attempt}/5 failed:`, e.message);
      if (attempt === 5) {
        console.error('[startup] All browser init attempts failed — server running without browser');
      } else {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }
});
