import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCrossSite, isLocalHost } from '../server/guard.js';
import { startServer } from '../server/app.js';

test('isLocalHost accepts only names of this machine', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:47613', 'localhost', 'LOCALHOST:5173', '[::1]', '[::1]:80']) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of [undefined, '', 'evil.example', 'evil.example:47613', '127.0.0.1.evil.example', '0.0.0.0', '192.168.1.5']) {
    assert.equal(isLocalHost(host), false, String(host));
  }
});

test('isCrossSite lets through the same origin and tools without a browser', () => {
  const host = '127.0.0.1:47613';
  assert.equal(isCrossSite({ headers: { host } }), false);
  assert.equal(isCrossSite({ headers: { host, origin: 'http://127.0.0.1:47613' } }), false);
  assert.equal(isCrossSite({ headers: { host, 'sec-fetch-site': 'same-origin' } }), false);
  assert.equal(isCrossSite({ headers: { host, origin: 'https://evil.example' } }), true);
  assert.equal(isCrossSite({ headers: { host, origin: 'http://127.0.0.1:5173' } }), true);
  assert.equal(isCrossSite({ headers: { host, origin: 'null' } }), true);
  assert.equal(isCrossSite({ headers: { host, 'sec-fetch-site': 'cross-site' } }), true);
});

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aia-server-'));
  const dist = path.join(root, 'dist');
  await fs.mkdir(dist);
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>aia-studio</title>');
  server = await startServer({ documents: path.join(root, 'documents'), dist, port: 0 });
});

after(async () => {
  await server?.close();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * A raw request, so the test controls the Host and Origin headers (fetch does not let it set Host).
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, body: string }>}
 */
function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (piece) => (body += piece));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server listens on 127.0.0.1 and creates the documents folder', async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok((await fs.stat(server.documents)).isDirectory());
});

test('the server serves the editor and the status to local requests', async () => {
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /aia-studio/);
  const status = await request('/api/status', { origin: `http://127.0.0.1:${server.port}` });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).documents, server.documents);
});

test('the server refuses a foreign Host (DNS rebinding)', async () => {
  const { status } = await request('/api/status', { host: `evil.example:${server.port}` });
  assert.equal(status, 403);
});

test('the server refuses requests from pages of other sites', async () => {
  assert.equal((await request('/api/status', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/', { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('the server does not serve files outside dist/', async () => {
  const { status } = await request('/..%2f..%2fpackage.json');
  assert.equal(status, 404);
});
