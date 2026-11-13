import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMATO, CONVENCIONES } from '../src/core/format.js';

test('el núcleo carga y declara su formato', () => {
  assert.match(FORMATO, /^aia\/\d+\.\d+$/);
  assert.equal(CONVENCIONES.tiempo, 'segundos');
});
