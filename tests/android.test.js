const test = require('node:test');
const assert = require('node:assert');

test('android module exports ADB_AVAILABLE boolean and adbPath', () => {
  const android = require('../android');
  assert.strictEqual(typeof android.ADB_AVAILABLE, 'boolean');
  if (android.ADB_AVAILABLE) {
    assert.strictEqual(typeof android.adbPath, 'string');
    assert.ok(android.adbPath.length > 0);
  } else {
    assert.strictEqual(android.adbPath, null);
  }
});

test('android module exports an Express router', () => {
  const android = require('../android');
  assert.strictEqual(typeof android.router, 'function');
  assert.ok(Array.isArray(android.router.stack));
});
