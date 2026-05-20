'use strict';

/**
 * Teaching Mode P1 — capture, storage, and workflow promotion.
 *
 * Pure primitives in this section have no I/O — they only manipulate the
 * in-memory shape of a TeachingSession. Disk I/O is added in Task 2, and
 * HTTP routing in Task 4.
 */

function makeSession({ package: pkg, activity, device, screen_w, screen_h, now = Date.now() } = {}) {
  return {
    id: 'teach-' + now,
    package: pkg ?? '',
    activity: activity ?? '',
    device: device ?? '',
    screen_w: screen_w ?? 0,
    screen_h: screen_h ?? 0,
    started_at: now,
    ended_at: null,
    end_reason: null,
    steps: [],
    stuck_at: null,
    help_question: null,
    help_resolved: null,
  };
}

function appendStep(session, { action, args, screenshot = null, now = Date.now() }) {
  if (!session || session.ended_at !== null) return null;
  const step = {
    index: session.steps.length,
    action,
    args: args || {},
    screenshot,
    timestamp: now,
    label: null,
    anchor: null,
  };
  session.steps.push(step);
  return step;
}

function markStuck(session, { help_question, step_index = null }) {
  if (!session || session.ended_at !== null) return;
  session.stuck_at = step_index !== null ? step_index : session.steps.length - 1;
  session.help_question = help_question || '';
}

function resolveStuck(session, { x, y, label }) {
  if (!session || session.ended_at !== null) return;
  session.help_resolved = { x: x | 0, y: y | 0, label: label ?? '' };
}

function finalizeSession(session, { end_reason, now = Date.now() }) {
  if (!session || session.ended_at !== null) return;
  session.ended_at = now;
  session.end_reason = end_reason || 'unknown';
}

const fs = require('node:fs');
const path = require('node:path');

function sessionDir(rootDir, sessionId) {
  return path.join(rootDir, sessionId);
}

function writeSessionMeta(rootDir, session) {
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id: session.id,
    package: session.package,
    activity: session.activity,
    device: session.device,
    screen_w: session.screen_w,
    screen_h: session.screen_h,
    started_at: session.started_at,
    ended_at: session.ended_at,
    end_reason: session.end_reason,
    stuck_at: session.stuck_at,
    help_question: session.help_question,
    help_resolved: session.help_resolved,
    step_count: session.steps.length,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function appendStepJsonl(rootDir, session, step) {
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify(step) + '\n');
}

function saveStepScreenshot(rootDir, session, step, buffer) {
  if (!buffer || buffer.length < 100) return null;
  const dir = sessionDir(rootDir, session.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = 'step-' + String(step.index + 1).padStart(4, '0') + '.jpg';
  fs.writeFileSync(path.join(dir, name), buffer);
  step.screenshot = name;
  return name;
}

function readSession(rootDir, sessionId) {
  const dir = sessionDir(rootDir, sessionId);
  if (!fs.existsSync(dir)) return null;
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const steps = [];
  const stepsPath = path.join(dir, 'steps.jsonl');
  if (fs.existsSync(stepsPath)) {
    const lines = fs.readFileSync(stepsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { steps.push(JSON.parse(line)); } catch {}
    }
  }
  return { ...meta, steps };
}

function listSessions(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(rootDir)) {
    if (!name.startsWith('teach-')) continue;
    const metaPath = path.join(rootDir, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
    } catch {}
  }
  out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return out;
}

// ── Active session manager (singleton) ─────────────────────────────────────
const IDLE_MS = 30 * 1000;
let activeSession = null;
let idleTimer = null;
let teachRoot = null;          // set by configure() before any capture happens

function configure({ rootDir }) { teachRoot = rootDir; }
function getActive() { return activeSession; }
function clearIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (activeSession && activeSession.ended_at === null) endActive('idle');
  }, IDLE_MS);
}

function startSession(metaArgs) {
  if (activeSession && activeSession.ended_at === null) return activeSession;
  activeSession = makeSession(metaArgs || {});
  if (teachRoot) writeSessionMeta(teachRoot, activeSession);
  armIdleTimer();
  return activeSession;
}

function captureStep({ action, args, screenshotBuffer = null, metaArgs = null }) {
  if (!activeSession || activeSession.ended_at !== null) startSession(metaArgs || {});
  const step = appendStep(activeSession, { action, args });
  if (!step) return null;
  if (screenshotBuffer && teachRoot) saveStepScreenshot(teachRoot, activeSession, step, screenshotBuffer);
  if (teachRoot) {
    appendStepJsonl(teachRoot, activeSession, step);
    writeSessionMeta(teachRoot, activeSession);
  }
  armIdleTimer();
  return step;
}

function endActive(reason) {
  if (!activeSession || activeSession.ended_at !== null) return null;
  finalizeSession(activeSession, { end_reason: reason });
  if (teachRoot) writeSessionMeta(teachRoot, activeSession);
  clearIdleTimer();
  const finished = activeSession;
  activeSession = null;
  return finished;
}

function cancelActive() {
  if (!activeSession) return null;
  if (teachRoot) {
    const dir = sessionDir(teachRoot, activeSession.id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  clearIdleTimer();
  const cancelled = activeSession;
  activeSession = null;
  return cancelled;
}

module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
  configure, getActive, startSession, captureStep, endActive, cancelActive,
  IDLE_MS,
};
