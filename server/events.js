// Live notices: when a document changes on disk (for example because the AI edited it over MCP), the editor hears it.
// Our own watcher on the documents folder (no Vite needed) feeds a hub that streams the notices to every open
// editor over Server-Sent Events (GET /api/events). Events:
//   document {id}   document.json written (created or changed)
//   history  {id}   history.jsonl written (it is written after the document, so it is notified separately)
//   deleted  {id}   the document's folder or its document.json is gone
//   ai       {}     an MCP server started or stopped (its status marker in .aia/mcp/ changed)

import { existsSync, mkdirSync, watch } from 'node:fs';
import path from 'node:path';

const FILES = { 'document.json': 'document', 'history.jsonl': 'history' };

/**
 * What a change at `relative` (a path inside the documents folder, as fs.watch reports it) means for the editor.
 * Pure, so it is tested without touching the disk. `exists` tells whether the path is still there.
 * @param {string} relative @param {(relative: string) => boolean} exists
 * @returns {{ event: string, data: object } | null}
 */
export function classifyChange(relative, exists) {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (parts[0] === '.aia') return parts[1] === 'mcp' ? { event: 'ai', data: {} } : null;
  const [id, file] = parts;
  if (!id || id.startsWith('.')) return null;
  // The document's folder itself: only its disappearance matters.
  if (parts.length === 1) return exists(id) ? null : { event: 'deleted', data: { id } };
  if (parts.length !== 2 || !(file in FILES)) return null;
  if (exists(relative)) return { event: FILES[file], data: { id } };
  // Writing goes through a temp file and a rename, so a missing document.json is checked again later (see watcher).
  return file === 'document.json' ? { event: 'deleted', data: { id } } : null;
}

/**
 * Watches `folder` (recursively) and calls `emit(event, data)` for each notice, grouping the bursts a single save
 * produces (temp file, rename) into one notice per event and document.
 * @param {string} folder @param {(event: string, data: object) => void} emit
 * @param {{ delay?: number }} [options] how long a notice waits for its burst to settle (ms)
 * @returns {{ close(): void }}
 */
export function watchDocuments(folder, emit, { delay = 80 } = {}) {
  mkdirSync(folder, { recursive: true });
  const pending = new Map();
  // Second stage: one save (or deleting a folder) touches several paths that mean the same notice.
  const outgoing = new Map();
  const send = ({ event, data }) => {
    const key = `${event}:${data.id ?? ''}`;
    clearTimeout(outgoing.get(key));
    outgoing.set(key, setTimeout(() => (outgoing.delete(key), emit(event, data)), 30));
  };
  const exists = (relative) => existsSync(path.join(folder, relative));
  const watcher = watch(folder, { recursive: true }, (_type, filename) => {
    if (!filename) return;
    const relative = filename.toString();
    const key = relative.replace(/\\/g, '/');
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        const notice = classifyChange(relative, exists);
        if (notice) send(notice);
      }, delay),
    );
  });
  watcher.on('error', (e) => console.error(`aia-studio: the documents watcher stopped (${e.message})`));
  return {
    close() {
      for (const t of [...pending.values(), ...outgoing.values()]) clearTimeout(t);
      watcher.close();
    },
  };
}

/** The open editors listening on /api/events. */
export function createHub() {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  // A comment every so often keeps proxies and sleeping connections from dropping the stream.
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  ping.unref?.();
  return {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    connect(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    send(event, data) {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(message);
    },
    get size() {
      return clients.size;
    },
    close() {
      clearInterval(ping);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

/** The hub fed by a watcher on `folder`: what both the Vite plugin and the desktop server use. */
export function liveNotices(folder) {
  const hub = createHub();
  const watcher = watchDocuments(folder, hub.send);
  return {
    connect: hub.connect,
    hub,
    close() {
      watcher.close();
      hub.close();
    },
  };
}
