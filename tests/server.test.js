import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, isLocalHost } from '../server/app.js';
import { isCrossSite } from '../server/api.js';
import { classifyChange } from '../server/events.js';
import { resolveDocumentsFolder, REPO_DOCUMENTS } from '../server/folder.js';
import { createStore } from '../server/store.js';
import { loadSchema } from '../server/schema.js';

const schema = loadSchema();

async function withServer(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'aia-server-'));
  const folder = path.join(base, 'documents');
  const dist = path.join(base, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>aia</title>');
  await writeFile(path.join(dist, 'assets', 'main-abc.js'), 'export {}');
  const server = await startServer({ folder, dist });
  try {
    await fn({ server, folder, base });
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
}

/** A raw request, so the Host and Origin headers can be anything. */
function request(port, { method = 'GET', path: url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Opens /api/events and collects the notices until `until` returns true. */
function listen(port, until, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const notices = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) notices.push({ event, data: JSON.parse(data) });
        }
        if (until(notices)) {
          clearTimeout(timer);
          req.destroy();
          resolve(notices);
        }
      });
    });
    const timer = setTimeout(() => (req.destroy(), reject(new Error(`no notice in time: ${JSON.stringify(notices)}`))), timeout);
    req.on('error', () => {});
    listen.ready = new Promise((r) => req.on('response', r));
  });
}

test('the documents folder: --documents, then AIA_DOCUMENTS, then the repo', () => {
  assert.equal(resolveDocumentsFolder({ argv: [], env: {} }), REPO_DOCUMENTS);
  assert.equal(resolveDocumentsFolder({ argv: [], env: { AIA_DOCUMENTS: 'x/docs' } }), path.resolve('x/docs'));
  assert.equal(resolveDocumentsFolder({ argv: ['node', 'mcp/server.js', '--documents', 'y'], env: { AIA_DOCUMENTS: 'x' } }), path.resolve('y'));
});

test('changes on disk become notices for the editor', () => {
  const there = new Set(['robot', 'robot/document.json', 'robot/history.jsonl']);
  const exists = (r) => there.has(r.replace(/\\/g, '/'));
  assert.deepEqual(classifyChange('robot\\document.json', exists), { event: 'document', data: { id: 'robot' } });
  assert.deepEqual(classifyChange('robot/history.jsonl', exists), { event: 'history', data: { id: 'robot' } });
  assert.equal(classifyChange('robot/document.json.tmp', exists), null);
  assert.equal(classifyChange('robot/assets/a.png', exists), null);
  assert.equal(classifyChange('robot', exists), null);
  assert.deepEqual(classifyChange('ghost', exists), { event: 'deleted', data: { id: 'ghost' } });
  assert.deepEqual(classifyChange('ghost/document.json', exists), { event: 'deleted', data: { id: 'ghost' } });
  assert.deepEqual(classifyChange('.aia/mcp/123.json', exists), { event: 'ai', data: {} });
  assert.equal(classifyChange('.aia/other', exists), null);
});

test('only local hosts and same-site requests get through', () => {
  assert.ok(isLocalHost('127.0.0.1:4000') && isLocalHost('localhost:5173') && isLocalHost('[::1]:80'));
  assert.ok(!isLocalHost('evil.example:4000') && !isLocalHost(undefined));
  const req = (headers) => /** @type {any} */ ({ headers: { host: '127.0.0.1:4000', ...headers } });
  assert.ok(!isCrossSite(req({})));
  assert.ok(!isCrossSite(req({ origin: 'http://127.0.0.1:4000' })));
  assert.ok(isCrossSite(req({ origin: 'https://evil.example' })));
  assert.ok(isCrossSite(req({ origin: 'http://127.0.0.1:5000' })));
  assert.ok(isCrossSite(req({ 'sec-fetch-site': 'cross-site' })));
});

test('the production server serves the build and the API, and refuses foreign pages', () =>
  withServer(async ({ server }) => {
    const { port } = server;
    let r = await request(port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    r = await request(port, { path: '/?doc=robot' });
    assert.match(r.text, /<title>aia/);
    r = await request(port, { path: '/assets/main-abc.js' });
    assert.match(r.type, /javascript/);
    assert.equal((await request(port, { path: '/assets/missing.js' })).status, 404);
    // Never a file outside dist.
    for (const url of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/%2e%2e/package.json']) assert.equal((await request(port, { path: url })).status, 404, url);

    r = await request(port, { method: 'POST', path: '/api/documents', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'robot', meta: { name: 'Robot' } }) });
    assert.equal(r.status, 200, r.text);
    r = await request(port, { path: '/api/documents' });
    assert.deepEqual(JSON.parse(r.text), [{ id: 'robot', name: 'Robot' }]);

    // Another site's page (cross-site Origin) and DNS rebinding (foreign Host) are refused.
    r = await request(port, { method: 'DELETE', path: '/api/documents/robot', headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await request(port, { path: '/api/documents', headers: { host: `evil.example:${port}` } });
    assert.equal(r.status, 403);
    assert.equal(JSON.parse((await request(port, { path: '/api/documents' })).text).length, 1);
  }));

test('what another process (the MCP) writes reaches the editor as live notices', () =>
  withServer(async ({ server, folder }) => {
    const mcp = createStore({ schema, folder });
    const created = listen(server.port, (n) => n.some((x) => x.event === 'document') && n.some((x) => x.event === 'history'));
    await listen.ready;
    await mcp.create('robot', { name: 'Robot' }, { origin: 'ai' });
    await mcp.applyOps('robot', [{ op: 'create', type: 'rect', id: 'torso' }], { origin: 'ai' });
    const notices = await created;
    assert.ok(notices.every((n) => n.data.id === 'robot'));

    const deleted = listen(server.port, (n) => n.some((x) => x.event === 'deleted'));
    await listen.ready;
    await mcp.delete('robot');
    const after = await deleted;
    assert.equal(after.filter((n) => n.event === 'deleted').length, 1, 'one notice per deleted document');
  }));
