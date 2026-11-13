import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT, CONVENTIONS } from '../src/core/format.js';

test('el núcleo carga y declara su formato', () => {
  assert.match(FORMAT, /^aia\/\d+\.\d+$/);
  assert.equal(CONVENTIONS.time, 'segundos');
});
