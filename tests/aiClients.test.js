import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addEntry, removeEntry, entryStatus, connectClaudeDesktop, disconnectClaudeDesktop, repairClaudeDesktop,
  claudeDesktopCandidates, findClaudeDesktopConfig, claudeCodeCommand, cursorLink, vscodeLink,
} from '../server/aiClients.js';
import { markRunning, runningServers, clientLabel } from '../server/mcpStatus.js';
import { createAiRoutes } from '../server/aiRoutes.js';
import { startServer } from '../server/app.js';

const entry = { command: 'C:\\Program Files\\aia-studio\\aia-studio.exe', args: ['C:\\Program Files\\aia-studio\\resources\\app.asar\\mcp\\server.js'], env: { ELECTRON_RUN_AS_NODE: '1', AIA_DOCUMENTS: 'C:\\Users\\me\\AppData\\Roaming\\aia-studio\\documents' } };
// A config as people have it: other servers, preferences and keys we know nothing about.
const existing = JSON.stringify({
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Desktop'] },
    github: { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: 'secret' } },
  },
  preferences: { sidebarMode: 'chat', quickEntryShortcut: 'off' },
  globalShortcut: 'Ctrl+Space',
});

async function withFolder(fn) {
  const folder = await mkdtemp(path.join(tmpdir(), 'aia-ai-'));
  try {
    await fn(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('adding our entry keeps every other server and setting', () => {
  const { text, changed } = addEntry(existing, entry);
  assert.ok(changed);
  const before = JSON.parse(existing);
  const after = JSON.parse(text);
  assert.deepEqual(after.mcpServers['aia-studio'], entry);
  assert.deepEqual(after.mcpServers.filesystem, before.mcpServers.filesystem);
  assert.deepEqual(after.mcpServers.github, before.mcpServers.github);
  assert.deepEqual(after.preferences, before.preferences);
  assert.equal(after.globalShortcut, 'Ctrl+Space');
  // Again: nothing to do.
  assert.equal(addEntry(text, entry).changed, false);
  assert.equal(entryStatus(text, entry), 'current');
});

test('a config without mcpServers, empty or missing gets just our entry', () => {
  for (const text of [null, '', '  \n', '{}', JSON.stringify({ preferences: { a: 1 } })]) {
    const after = JSON.parse(addEntry(text, entry).text);
    assert.deepEqual(after.mcpServers, { 'aia-studio': entry });
  }
  assert.deepEqual(JSON.parse(addEntry(JSON.stringify({ preferences: { a: 1 } }), entry).text).preferences, { a: 1 });
});

test('an old entry (the app moved) is replaced; key order does not matter', () => {
  const old = addEntry(existing, { ...entry, command: 'D:\\old\\aia-studio.exe' }).text;
  assert.equal(entryStatus(old, entry), 'outdated');
  const replaced = JSON.parse(addEntry(old, entry).text);
  assert.deepEqual(replaced.mcpServers['aia-studio'], entry);
  assert.equal(Object.keys(replaced.mcpServers).length, 3);
  const reordered = JSON.stringify({ mcpServers: { 'aia-studio': { env: entry.env, args: entry.args, command: entry.command } } });
  assert.equal(entryStatus(reordered, entry), 'current');
});

test('removing our entry leaves the others', () => {
  const connected = addEntry(existing, entry).text;
  const { text, changed } = removeEntry(connected);
  assert.ok(changed);
  assert.deepEqual(JSON.parse(text), JSON.parse(existing));
  assert.equal(removeEntry(existing).changed, false);
  assert.equal(entryStatus(existing, entry), 'missing');
});

test('a broken config is never overwritten', () => {
  for (const text of ['{ "mcpServers": { ', '[]', '"text"', JSON.stringify({ mcpServers: [] })]) {
    assert.throws(() => addEntry(text, entry), /not changed/);
    assert.throws(() => removeEntry(text), /not changed/);
  }
});

test('connect, repair and disconnect on disk keep a backup of what was there', () =>
  withFolder(async (folder) => {
    const file = path.join(folder, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(file));
    await writeFile(file, existing);

    let r = await connectClaudeDesktop(file, entry);
    assert.ok(r.changed);
    assert.equal(await readFile(`${file}.aia-backup`, 'utf8'), existing);
    assert.equal(entryStatus(await readFile(file, 'utf8'), entry), 'current');
    assert.equal((await connectClaudeDesktop(file, entry)).changed, false);

    // The app moved: repaired at launch.
    const moved = { ...entry, command: 'E:\\Apps\\aia-studio.exe' };
    assert.ok(await repairClaudeDesktop(file, moved));
    assert.equal(entryStatus(await readFile(file, 'utf8'), moved), 'current');
    assert.equal(await repairClaudeDesktop(file, moved), false);

    r = await disconnectClaudeDesktop(file);
    assert.ok(r.changed);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), JSON.parse(existing));
    // Disconnected: launching again does not bring it back.
    assert.equal(await repairClaudeDesktop(file, entry), false);
    assert.equal(entryStatus(await readFile(file, 'utf8'), entry), 'missing');
    assert.ok(!existsSync(`${file}.tmp`));
  }));

test('connecting creates the config when Claude Desktop has none yet', () =>
  withFolder(async (folder) => {
    const file = path.join(folder, 'Claude', 'claude_desktop_config.json');
    const r = await connectClaudeDesktop(file, entry);
    assert.deepEqual(r, { changed: true, backup: null });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { 'aia-studio': entry } });
  }));

test('where Claude Desktop keeps its config on each system', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const list = (dir) => (dir.endsWith('Packages') ? ['Microsoft.Foo_1', 'Claude_pzs8sxrjxfjjc'] : dir.endsWith('Claude-Data') ? ['claude_pzs8sxrjxfjjc'] : []);
  const win = claudeDesktopCandidates({ platform: 'win32', env, home: 'C:\\Users\\me', list });
  assert.deepEqual(win, [
    'C:\\Users\\me\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json',
    'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
  ]);
  assert.deepEqual(claudeDesktopCandidates({ platform: 'darwin', home: '/Users/me' }), [path.join('/Users/me', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]);

  const system = { platform: 'win32', env, home: 'C:\\Users\\me', list };
  // An existing file wins, the newest one if there are several.
  const files = { [win[1]]: 10, [win[2]]: 20 };
  assert.equal(findClaudeDesktopConfig({ ...system, exists: (p) => p in files, modified: (p) => files[p] }), win[2]);
  // No file yet: the first folder that exists.
  assert.equal(findClaudeDesktopConfig({ ...system, exists: (p) => p === path.dirname(win[1]) }), win[1]);
  assert.equal(findClaudeDesktopConfig({ ...system, list: () => [], exists: () => false }), null);
});

test('Claude Code command and Cursor / VS Code links carry the same entry', () => {
  assert.equal(
    claudeCodeCommand(entry),
    'claude mcp add --scope user aia-studio -e ELECTRON_RUN_AS_NODE=1 -e "AIA_DOCUMENTS=C:\\Users\\me\\AppData\\Roaming\\aia-studio\\documents" -- "C:\\Program Files\\aia-studio\\aia-studio.exe" "C:\\Program Files\\aia-studio\\resources\\app.asar\\mcp\\server.js"',
  );
  const cursor = new URL(cursorLink(entry));
  assert.equal(cursor.searchParams.get('name'), 'aia-studio');
  assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get('config'), 'base64').toString()), entry);
  const vscode = vscodeLink(entry);
  assert.ok(vscode.startsWith('vscode:mcp/install?'));
  assert.deepEqual(JSON.parse(decodeURIComponent(vscode.split('?')[1])), { name: 'aia-studio', ...entry });
});

test('running MCP servers come from their markers; dead ones are cleaned up', () =>
  withFolder(async (documents) => {
    const running = markRunning(documents, { version: '0.1.0' });
    running.setClient({ name: 'claude-ai', version: '1.0' });
    const dead = path.join(documents, '.aia', 'mcp', '999999.json');
    await writeFile(dead, JSON.stringify({ pid: 999999, version: '0.1.0', started: '2026-01-01', client: null }));
    const list = await runningServers(documents, { isAlive: (pid) => pid === process.pid });
    assert.deepEqual(list.map((s) => [s.pid, s.label]), [[process.pid, 'Claude Desktop']]);
    assert.ok(!existsSync(dead));
    running.remove();
    assert.deepEqual(await runningServers(documents), []);
    assert.equal(clientLabel('claude-code'), 'Claude Code');
    assert.equal(clientLabel(undefined), 'an AI client');
  }));

test('the editor connects and disconnects Claude Desktop through /api/ai', () =>
  withFolder(async (base) => {
    const file = path.join(base, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(file));
    await writeFile(file, existing);
    const documents = path.join(base, 'documents');
    const dist = path.join(base, 'dist');
    await mkdir(dist);
    await writeFile(path.join(dist, 'index.html'), '<!doctype html>');
    const ai = createAiRoutes({ documents, entry, app: true, findConfig: () => file });
    const server = await startServer({ folder: documents, dist, ai });
    try {
      const call = (method) => fetch(`${server.url}api/ai${method === 'GET' ? '' : '/claude-desktop'}`, { method }).then((r) => r.json());
      let status = await call('GET');
      assert.equal(status.claudeDesktop.status, 'missing');
      assert.equal(status.app, true);
      status = await call('POST');
      assert.equal(status.claudeDesktop.status, 'current');
      assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).mcpServers).length, 3);
      status = await call('DELETE');
      assert.equal(status.claudeDesktop.status, 'missing');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), JSON.parse(existing));
      // Another site cannot do it through the user's browser.
      const r = await fetch(`${server.url}api/ai/claude-desktop`, { method: 'POST', headers: { origin: 'https://evil.example' } });
      assert.equal(r.status, 403);
    } finally {
      await server.close();
    }
  }));
