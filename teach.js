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
    if (!activeSession || activeSession.ended_at !== null) return;
    // If the AI explicitly paused to wait for human help (markStuck fired
    // but resolveStuck hasn't yet), the session is intentionally idle —
    // don't auto-close. The waitfor-resolve handler will close it as
    // 'stuck' once the human responds, or POST /teach/cancel can discard.
    if (activeSession.stuck_at !== null && activeSession.help_resolved === null) return;
    endActive('idle');
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

// ── Workflow promotion ──────────────────────────────────────────────────────
let workflowsRoot = null;
function configureWorkflows({ rootDir }) { workflowsRoot = rootDir; }

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workflow';
}

function workflowDir(pkg, activity, slug) {
  return path.join(workflowsRoot, slugify(pkg || 'unknown'), slugify(activity || 'unknown'), slug);
}

function listWorkflows({ package: pkgFilter, activity: actFilter } = {}) {
  if (!workflowsRoot || !fs.existsSync(workflowsRoot)) return [];
  const out = [];
  for (const pkgDir of fs.readdirSync(workflowsRoot)) {
    const pkgPath = path.join(workflowsRoot, pkgDir);
    if (!fs.statSync(pkgPath).isDirectory()) continue;
    for (const actDir of fs.readdirSync(pkgPath)) {
      const actPath = path.join(pkgPath, actDir);
      if (!fs.statSync(actPath).isDirectory()) continue;
      for (const slug of fs.readdirSync(actPath)) {
        const wfPath = path.join(actPath, slug, 'workflow.json');
        if (!fs.existsSync(wfPath)) continue;
        try {
          const wf = withDefaults(JSON.parse(fs.readFileSync(wfPath, 'utf-8')));
          if (pkgFilter && wf.package !== pkgFilter) continue;
          if (actFilter && wf.activity !== actFilter) continue;
          out.push(wf);
        } catch {}
      }
    }
  }
  out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return out;
}

function withDefaults(wf) {
  if (!wf) return wf;
  return Object.assign({}, wf, {
    status:        wf.status        ?? 'approved',
    intent:        wf.intent        ?? wf.name ?? '',
    source_kind:   wf.source_kind   ?? 'human-promoted',
    success_count: wf.success_count ?? 0,
    rejected_reason: wf.rejected_reason ?? null,
  });
}

function readWorkflow(id) {
  for (const wf of listWorkflows()) if (wf.id === id) return wf;
  return null;
}

function workflowPathById(id) {
  for (const wf of listWorkflows()) {
    if (wf.id === id) return path.join(workflowDir(wf.package, wf.activity, slugify(wf.name)), 'workflow.json');
  }
  return null;
}

function writeWorkflowJson(wfPath, wf) {
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));
}

function deleteWorkflow(id) {
  const wf = readWorkflow(id);
  if (!wf) return false;
  const dir = workflowDir(wf.package, wf.activity, slugify(wf.name));
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

function promoteSessionToWorkflow(sessionId, { name }) {
  if (!teachRoot || !workflowsRoot) throw new Error('teach/workflows not configured');
  const session = readSession(teachRoot, sessionId);
  if (!session) throw new Error('session not found');
  const slug = slugify(name);
  let finalSlug = slug, n = 2;
  while (fs.existsSync(workflowDir(session.package, session.activity, finalSlug))) {
    finalSlug = slug + '-' + n++;
  }
  const dir = workflowDir(session.package, session.activity, finalSlug);
  fs.mkdirSync(dir, { recursive: true });
  for (const step of session.steps) {
    if (!step.screenshot) continue;
    const src = path.join(teachRoot, sessionId, step.screenshot);
    const dst = path.join(dir, step.screenshot);
    try { fs.copyFileSync(src, dst); } catch {}
  }
  const wf = {
    id: 'wf-' + Date.now(),
    name: String(name || 'Untitled'),
    intent: String(name || ''),
    status: 'approved',
    source_kind: 'human-promoted',
    package: session.package,
    activity: session.activity,
    screen_w: session.screen_w,
    screen_h: session.screen_h,
    steps: session.steps,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: sessionId,
    use_count: 0,
    success_count: 0,
    rejected_reason: null,
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}

// ── Intent matching (P3 /flows) ─────────────────────────────────────────────
// Scores how well a workflow matches a free-text intent query. Pure function;
// no I/O. See spec 2026-05-20 § matchIntent for threshold rationale.
function matchIntent(workflow, queryIntent) {
  if (queryIntent == null || queryIntent === '') return 0.5;
  const name = (workflow && workflow.name) || '';
  const intent = (workflow && workflow.intent) || '';
  const text = (name + ' ' + intent).toLowerCase();
  const q = String(queryIntent).toLowerCase();
  if (text.includes(q)) return 0.9;
  // Token-fallback: split on non-word chars, keep tokens long enough to be
  // discriminating (≥3 chars filters out "a", "to", "is", etc.).
  const tokens = q.split(/\W+/).filter(t => t.length >= 3);
  if (tokens.length === 0) return 0.4;
  const hits = tokens.filter(t => text.includes(t)).length;
  return hits / tokens.length;
}

// ── HTTP router ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();

function isSafeId(id) {
  // Reject anything that could escape the session/workflow root via path
  // traversal — slashes, backslashes, '..', leading dots. Real IDs are
  // 'teach-<digits>' or 'wf-<digits>' (set server-side); this regex covers
  // both plus tolerates future ID shapes that stay alphanumeric+dash+underscore.
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

router.get('/teach/sessions', (req, res) => {
  if (!teachRoot) return res.json([]);
  res.json(listSessions(teachRoot));
});

router.get('/teach/sessions/:id', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  if (!teachRoot) return res.status(404).json({ error: 'teach not configured' });
  const s = readSession(teachRoot, req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

router.get('/teach/sessions/:id/:file', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  if (!teachRoot) return res.status(404).end();
  if (!/^step-\d{4}\.jpg$/.test(req.params.file)) return res.status(400).end();
  const p = path.join(teachRoot, req.params.id, req.params.file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.sendFile(p);
});

router.post('/teach/done', (req, res) => {
  const f = endActive('done');
  if (!f) return res.status(400).json({ error: 'no active session' });
  res.json({ ok: true, id: f.id });
});

router.post('/teach/cancel', (req, res) => {
  const c = cancelActive();
  if (!c) return res.status(400).json({ error: 'no active session' });
  res.json({ ok: true, id: c.id });
});

router.delete('/teach/sessions/:id', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  if (!teachRoot) return res.status(404).end();
  const dir = sessionDir(teachRoot, req.params.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/teach/sessions/:id/promote', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const wf = promoteSessionToWorkflow(req.params.id, { name });
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/workflows', (req, res) => {
  res.json(listWorkflows({ package: req.query.package, activity: req.query.activity }));
});

router.get('/workflows/:id', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});

router.get('/workflows/:id/:file', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).end();
  if (!/^step-\d{4}\.jpg$/.test(req.params.file)) return res.status(400).end();
  const p = path.join(workflowDir(wf.package, wf.activity, slugify(wf.name)), req.params.file);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.sendFile(p);
});

router.patch('/workflows/:id', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  if (req.body.name) wf.name = String(req.body.name).slice(0, 80);
  if (Array.isArray(req.body.steps)) wf.steps = req.body.steps;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(req.params.id);
  if (!wfPath) return res.status(500).json({ error: 'cannot resolve workflow path' });
  writeWorkflowJson(wfPath, wf);
  res.json({ ok: true, workflow: wf });
});

router.delete('/workflows/:id', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  if (deleteWorkflow(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'not found' });
});

router.patch('/teach/sessions/:id/steps', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  if (!teachRoot) return res.status(404).json({ error: 'teach not configured' });
  if (!Array.isArray(req.body && req.body.steps)) return res.status(400).json({ error: 'steps[] required' });
  const dir = sessionDir(teachRoot, req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  const tmp = path.join(dir, 'steps.jsonl.tmp');
  fs.writeFileSync(tmp, req.body.steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  fs.renameSync(tmp, path.join(dir, 'steps.jsonl'));
  res.json({ ok: true });
});

module.exports = {
  makeSession, appendStep, markStuck, resolveStuck, finalizeSession,
  writeSessionMeta, appendStepJsonl, saveStepScreenshot, readSession, listSessions,
  sessionDir,
  configure, configureWorkflows, getActive, startSession, captureStep, endActive, cancelActive,
  IDLE_MS,
  router,
  slugify, workflowDir, workflowPathById, writeWorkflowJson,
  promoteSessionToWorkflow, listWorkflows, readWorkflow, deleteWorkflow,
  matchIntent,
  withDefaults,
};
