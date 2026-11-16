import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO_DOCUMENTS, resolveDocumentsFolder } from '../server/folder.js';

test('the --documents argument wins over AIA_DOCUMENTS', () => {
  const folder = resolveDocumentsFolder({ argv: ['node', 'x', '--documents', 'from-arg'], env: { AIA_DOCUMENTS: 'from-env' } });
  assert.equal(folder, path.resolve('from-arg'));
});

test('AIA_DOCUMENTS is used when there is no argument', () => {
  assert.equal(resolveDocumentsFolder({ argv: [], env: { AIA_DOCUMENTS: 'from-env' } }), path.resolve('from-env'));
});

test("without either, the repo's documents/ folder", () => {
  assert.equal(resolveDocumentsFolder({ argv: [], env: {} }), path.resolve(REPO_DOCUMENTS));
  assert.equal(path.basename(REPO_DOCUMENTS), 'documents');
});

test('--documents without a folder after it is ignored', () => {
  assert.equal(resolveDocumentsFolder({ argv: ['--documents'], env: { AIA_DOCUMENTS: 'from-env' } }), path.resolve('from-env'));
});

test('the result is always absolute', () => {
  assert.ok(path.isAbsolute(resolveDocumentsFolder({ argv: ['--documents', 'relative/folder'], env: {} })));
});
