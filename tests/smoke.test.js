import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT, CONVENTIONS } from '../src/core/format.js';

test('the core loads and declares its format', () => {
  assert.match(FORMAT, /^aia\/\d+\.\d+$/);
  assert.equal(CONVENTIONS.time, 'seconds');
});
