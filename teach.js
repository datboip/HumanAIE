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
    replay_of: session.replay_of ?? null,
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

function captureStep({ action, args, screenshotBuffer = null, metaArgs = null, replay_of = null }) {
  if (!activeSession || activeSession.ended_at !== null) startSession(metaArgs || {});
  // Tag the active session with replay_of on the FIRST call that supplies it.
  // Subsequent calls in the same session don't re-tag (a session represents
  // one replay attempt; replay_of is set-once).
  if (replay_of && !activeSession.replay_of) {
    activeSession.replay_of = String(replay_of);
  }
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
  // If this session was a replay, increment the source workflow's success
  // counter on a 'done' finish (any other end_reason = the replay didn't
  // complete cleanly, don't credit it).
  if (reason === 'done' && activeSession.replay_of && workflowsRoot) {
    try {
      const wf = readWorkflow(activeSession.replay_of);
      if (wf) {
        wf.success_count = (wf.success_count || 0) + 1;
        wf.updated_at = Date.now();
        const wfPath = workflowPathById(wf.id);
        if (wfPath) writeWorkflowJson(wfPath, wf);
      }
    } catch {}
  }
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

function listWorkflows({ package: pkgFilter, activity: actFilter, status: statusFilter } = {}) {
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
          if (statusFilter && wf.status !== statusFilter) continue;
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
    status:          wf.status          ?? 'approved',
    intent:          wf.intent          ?? wf.name ?? '',
    source_kind:     wf.source_kind     ?? 'human-promoted',
    success_count:   wf.success_count   ?? 0,
    rejected_reason: wf.rejected_reason ?? null,
    flagged:         wf.flagged         ?? false,
    flag_reason:     wf.flag_reason     ?? null,
    flagged_at:      wf.flagged_at      ?? null,
    parent:          wf.parent          ?? null,
    edit_reason:     wf.edit_reason     ?? null,
  });
}

function readWorkflow(id) {
  for (const wf of listWorkflows()) if (wf.id === id) return wf;
  return null;
}

function workflowPathById(id) {
  // Scan the actual directory tree rather than recomputing from slugify(name),
  // because edit workflows are stored under slugs that include a timestamp
  // suffix (e.g. "orig-edit-<ts>") which does not match slugify(name).
  if (!workflowsRoot || !fs.existsSync(workflowsRoot)) return null;
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
          const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
          if (wf.id === id) return wfPath;
        } catch {}
      }
    }
  }
  return null;
}

function writeWorkflowJson(wfPath, wf) {
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));
}

function deleteWorkflow(id) {
  // Use workflowPathById so proposed-edit dirs (named <parent-slug>-edit-<ts>)
  // resolve correctly — slugify(wf.name) was reconstructing 'q-edit' instead
  // of the real timestamped slug and silently no-op'ing the delete.
  const wfPath = workflowPathById(id);
  if (!wfPath) return false;
  try { fs.rmSync(path.dirname(wfPath), { recursive: true, force: true }); return true; } catch { return false; }
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
    flagged: false,
    flag_reason: null,
    flagged_at: null,
    parent: null,
    edit_reason: null,
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}

function proposeSessionAsWorkflow(sessionId, { name, intent }) {
  // Same on-disk shape as promote but with proposed status — used by AI
  // agents auto-saving successful sessions for human review.
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
    intent: String(intent || name || ''),
    status: 'proposed',
    source_kind: 'agent-proposed',
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
    flagged: false,
    flag_reason: null,
    flagged_at: null,
    parent: null,
    edit_reason: null,
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}

function flagWorkflow(id, reason) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const wf = readWorkflow(id);
  if (!wf) throw new Error('workflow not found');
  wf.flagged = true;
  wf.flag_reason = String(reason || '').slice(0, 500);
  wf.flagged_at = Date.now();
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(id);
  if (!wfPath) throw new Error('cannot resolve workflow path');
  writeWorkflowJson(wfPath, wf);
  return wf;
}

function unflagWorkflow(id) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const wf = readWorkflow(id);
  if (!wf) throw new Error('workflow not found');
  wf.flagged = false;
  wf.flag_reason = null;
  wf.flagged_at = null;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(id);
  if (!wfPath) throw new Error('cannot resolve workflow path');
  writeWorkflowJson(wfPath, wf);
  return wf;
}

function findPendingEditFor(parentId) {
  for (const wf of listWorkflows({ status: 'proposed-edit' })) {
    if (wf.parent === parentId) return wf;
  }
  return null;
}

function proposeWorkflowEdit(parentId, steps, editReason) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps array required');
  const parent = readWorkflow(parentId);
  if (!parent) throw new Error('parent not found');
  const existing = findPendingEditFor(parentId);
  if (existing) {
    const err = new Error('pending edit exists');
    err.pending_edit_id = existing.id;
    throw err;
  }
  // Slug: <parent-slug>-edit-<ts> for uniqueness even if multiple edits land
  // over time (rejected ones get deleted; this just keeps disk paths distinct).
  const parentSlug = slugify(parent.name);
  const editSlug = parentSlug + '-edit-' + Date.now();
  const dir = workflowDir(parent.package, parent.activity, editSlug);
  fs.mkdirSync(dir, { recursive: true });
  const wf = {
    id: 'wf-' + Date.now(),
    name: parent.name + ' (edit)',
    intent: parent.intent,
    status: 'proposed-edit',
    source_kind: 'agent-edit',
    package: parent.package,
    activity: parent.activity,
    screen_w: parent.screen_w,
    screen_h: parent.screen_h,
    steps: steps,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: parent.source,
    use_count: 0,
    success_count: 0,
    rejected_reason: null,
    flagged: false,
    flag_reason: null,
    flagged_at: null,
    parent: parentId,
    edit_reason: String(editReason || '').slice(0, 500),
  };
  writeWorkflowJson(path.join(dir, 'workflow.json'), wf);
  return wf;
}

function applyEditToParent(editId) {
  if (!workflowsRoot) throw new Error('workflows not configured');
  const edit = readWorkflow(editId);
  if (!edit) throw new Error('edit not found');
  if (edit.status !== 'proposed-edit') throw new Error('not a proposed-edit workflow');
  if (!edit.parent) throw new Error('edit has no parent reference');
  const parent = readWorkflow(edit.parent);
  if (!parent) throw new Error('parent no longer exists');
  // Merge: parent keeps id/name/intent/counts/history; gains edit's steps + screen dims.
  parent.steps = edit.steps;
  parent.screen_w = edit.screen_w;
  parent.screen_h = edit.screen_h;
  parent.updated_at = Date.now();
  // Approving an edit implicitly clears any flag on the parent (the AI's
  // edit IS the fix; the human's approval IS the verification).
  parent.flagged = false;
  parent.flag_reason = null;
  parent.flagged_at = null;
  const parentPath = workflowPathById(parent.id);
  if (parentPath) writeWorkflowJson(parentPath, parent);
  // Delete sibling on disk
  const editPath = workflowPathById(edit.id);
  if (editPath) {
    try { fs.rmSync(require('path').dirname(editPath), { recursive: true, force: true }); } catch {}
  }
  return parent;
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

router.post('/teach/sessions/:id/propose', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const name = req.body && req.body.name;
  const intent = req.body && req.body.intent;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const wf = proposeSessionAsWorkflow(req.params.id, { name, intent });
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/flows', (req, res) => {
  const minStatus = req.query.min_status || 'approved';
  const candidates = listWorkflows({
    package: req.query.package,
    activity: req.query.activity,
    status: minStatus,
  });
  if (candidates.length === 0) {
    return res.json({ workflow: null, reason: 'no candidates' });
  }
  // If no intent is supplied, matchIntent returns 0.5 for every candidate,
  // so all scores tie and the tiebreaker chain picks the highest-success_count
  // approved flow for this (package, activity). That's the intentional
  // degraded-mode behavior: "give me the most battle-tested flow you've got."
  const ranked = candidates.map(w => ({ w, score: matchIntent(w, req.query.intent) }))
                            .sort((a, b) => {
                              if (b.score !== a.score) return b.score - a.score;
                              // Tiebreaker: higher success_count wins, then most recent
                              if ((b.w.success_count || 0) !== (a.w.success_count || 0)) {
                                return (b.w.success_count || 0) - (a.w.success_count || 0);
                              }
                              return (b.w.updated_at || 0) - (a.w.updated_at || 0);
                            });
  const best = ranked[0];
  if (best.score < 0.4) {
    return res.json({ workflow: null, reason: 'low confidence', confidence: best.score });
  }
  // Bump use_count: this is the "attempt" signal — AI fetched the flow
  // intending to replay it. success_count is bumped separately by
  // endActive() on /teach/done if the replay actually completes.
  // We intentionally do NOT touch updated_at here — that field feeds the
  // recency tiebreaker above, and self-stamping on every fetch would lock
  // whichever flow was queried first into a permanent winner.
  try {
    best.w.use_count = (best.w.use_count || 0) + 1;
    const wfPath = workflowPathById(best.w.id);
    if (wfPath) writeWorkflowJson(wfPath, best.w);
  } catch {}
  res.json({ workflow: best.w, confidence: best.score });
});

router.get('/flows/catalog', (req, res) => {
  const pkg = req.query.package;
  const act = req.query.activity;
  // Approved + flagged-approved live in the same set; flagged is just a hint.
  const approved = listWorkflows({ package: pkg, activity: act, status: 'approved' });
  const proposed = listWorkflows({ package: pkg, activity: act, status: 'proposed' });
  const proposedEdits = listWorkflows({ package: pkg, activity: act, status: 'proposed-edit' });
  const pendingByParent = {};
  for (const e of proposedEdits) {
    if (e.parent) pendingByParent[e.parent] = e.id;
  }
  const skills = approved.map(w => ({
    id: w.id,
    name: w.name,
    intent: w.intent,
    activity: w.activity,
    step_count: (w.steps && w.steps.length) || 0,
    use_count: w.use_count || 0,
    success_count: w.success_count || 0,
    success_rate: (w.use_count > 0) ? (w.success_count / w.use_count) : null,
    flagged: !!w.flagged,
    flag_reason: w.flag_reason || null,
    has_pending_edit: !!pendingByParent[w.id],
    pending_edit_id: pendingByParent[w.id] || null,
    updated_at: w.updated_at,
  }));
  // Sort: flagged first (true > false), then highest success_rate, then most recent.
  skills.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    const ar = a.success_rate ?? -1, br = b.success_rate ?? -1;
    if (br !== ar) return br - ar;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
  res.json({
    package: pkg || null,
    activity: act || null,
    approved_count: approved.length,
    proposed_count: proposed.length,
    proposed_edit_count: proposedEdits.length,
    flagged_count: approved.filter(w => w.flagged).length,
    skills: skills,
  });
});

router.get('/workflows', (req, res) => {
  res.json(listWorkflows({
    package: req.query.package,
    activity: req.query.activity,
    status: req.query.status,
  }));
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

router.patch('/workflows/:id/status', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const status = req.body && req.body.status;
  if (status !== 'proposed' && status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: 'status must be proposed/approved/rejected' });
  }
  const wf = readWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  // proposed-edit branch: approve merges into parent + deletes sibling;
  // reject deletes sibling only; any other target status is invalid here.
  if (wf.status === 'proposed-edit') {
    if (status === 'approved') {
      try {
        const merged = applyEditToParent(req.params.id);
        return res.json({ ok: true, workflow: merged });
      } catch (e) {
        if (e.message === 'parent no longer exists') return res.status(410).json({ error: e.message });
        return res.status(500).json({ error: e.message });
      }
    }
    if (status === 'rejected') {
      const wfPath = workflowPathById(req.params.id);
      if (wfPath) {
        try { fs.rmSync(require('path').dirname(wfPath), { recursive: true, force: true }); } catch {}
      }
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'proposed-edit can only be approved or rejected' });
  }
  // Regular workflow branch (P3 behavior preserved).
  // 'proposed' is a valid target — the un-reject UI flow moves rejected workflows
  // back to proposed for human re-review.
  wf.status = status;
  // Reason clears whenever we move OFF rejected, so subsequent reads see a clean slate.
  wf.rejected_reason = (status === 'rejected') ? (req.body.rejected_reason || null) : null;
  wf.updated_at = Date.now();
  const wfPath = workflowPathById(req.params.id);
  // Guard against race with concurrent DELETE — readWorkflow succeeded but the dir was removed before we could resolve the path.
  if (!wfPath) return res.status(500).json({ error: 'cannot resolve workflow path' });
  writeWorkflowJson(wfPath, wf);
  res.json({ ok: true, workflow: wf });
});

router.post('/workflows/:id/flag', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const reason = req.body && req.body.reason;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  try {
    const wf = flagWorkflow(req.params.id, reason);
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

router.post('/workflows/:id/unflag', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  try {
    const wf = unflagWorkflow(req.params.id);
    res.json({ ok: true, workflow: wf });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

router.post('/workflows/:id/propose-edit', (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).end();
  const steps = req.body && req.body.steps;
  const editReason = req.body && req.body.edit_reason;
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'steps array required' });
  }
  try {
    const edit = proposeWorkflowEdit(req.params.id, steps, editReason);
    res.json({ ok: true, edit_workflow: edit });
  } catch (e) {
    if (e.message === 'pending edit exists') {
      return res.status(409).json({ error: e.message, pending_edit_id: e.pending_edit_id });
    }
    if (e.message === 'parent not found') return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
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
  promoteSessionToWorkflow, proposeSessionAsWorkflow, listWorkflows, readWorkflow, deleteWorkflow,
  flagWorkflow, unflagWorkflow,
  proposeWorkflowEdit, findPendingEditFor, applyEditToParent,
  matchIntent,
  withDefaults,
};
