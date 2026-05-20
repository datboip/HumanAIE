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
    package: pkg || '',
    activity: activity || '',
    device: device || '',
    screen_w: screen_w || 0,
    screen_h: screen_h || 0,
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
  if (!session) return;
  session.help_resolved = { x: x | 0, y: y | 0, label: label || '' };
}

function finalizeSession(session, { end_reason, now = Date.now() }) {
  if (!session || session.ended_at !== null) return;
  session.ended_at = now;
  session.end_reason = end_reason || 'unknown';
}

module.exports = { makeSession, appendStep, markStuck, resolveStuck, finalizeSession };
