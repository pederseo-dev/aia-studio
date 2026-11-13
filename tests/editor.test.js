import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('the editor never calls window.prompt (the desktop app, Electron, does not implement it)', () => {
  const folder = new URL('../src/editor/', import.meta.url);
  const offenders = readdirSync(folder)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /(^|[^\w.])prompt\(/.test(readFileSync(new URL(f, folder), 'utf8')));
  assert.deepEqual(offenders, [], 'use askText() from src/editor/ask.js');
});
