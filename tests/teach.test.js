'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSession, appendStep, markStuck, resolveStuck, finalizeSession } = require('../teach');

test('makeSession captures device + screen meta', () => {
  const s = makeSession({ package: 'com.foo', activity: '.Main', device: 'serial', screen_w: 1080, screen_h: 2340, now: 1000 });
  assert.strictEqual(s.id, 'teach-1000');
  assert.strictEqual(s.package, 'com.foo');
  assert.strictEqual(s.screen_w, 1080);
  assert.strictEqual(s.started_at, 1000);
  assert.strictEqual(s.ended_at, null);
  assert.deepStrictEqual(s.steps, []);
});

test('appendStep adds a step and assigns sequential index', () => {
  const s = makeSession({});
  appendStep(s, { action: 'tap', args: { x: 100, y: 200 }, now: 1500 });
  appendStep(s, { action: 'swipe', args: { x1: 100, y1: 200, x2: 100, y2: 100 }, now: 1600 });
  assert.strictEqual(s.steps.length, 2);
  assert.strictEqual(s.steps[0].action, 'tap');
  assert.strictEqual(s.steps[0].index, 0);
  assert.strictEqual(s.steps[1].index, 1);
});

test('appendStep returns null on a finalized session', () => {
  const s = makeSession({});
  finalizeSession(s, { end_reason: 'done' });
  const step = appendStep(s, { action: 'tap', args: { x: 1, y: 2 } });
  assert.strictEqual(step, null);
  assert.strictEqual(s.steps.length, 0);
});

test('markStuck records the help question at the latest step', () => {
  const s = makeSession({});
  appendStep(s, { action: 'tap', args: { x: 1, y: 2 } });
  appendStep(s, { action: 'tap', args: { x: 3, y: 4 } });
  markStuck(s, { help_question: 'where is the post button?' });
  assert.strictEqual(s.stuck_at, 1);
  assert.strictEqual(s.help_question, 'where is the post button?');
});

test('resolveStuck records the human resolution coords', () => {
  const s = makeSession({});
  markStuck(s, { help_question: 'where?', step_index: 0 });
  resolveStuck(s, { x: 540, y: 1500, label: 'post button' });
  assert.deepStrictEqual(s.help_resolved, { x: 540, y: 1500, label: 'post button' });
});

test('finalizeSession is idempotent', () => {
  const s = makeSession({ now: 100 });
  finalizeSession(s, { end_reason: 'done', now: 200 });
  finalizeSession(s, { end_reason: 'idle', now: 300 });
  assert.strictEqual(s.ended_at, 200);
  assert.strictEqual(s.end_reason, 'done');
});
