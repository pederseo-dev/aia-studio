// Live notices: when a document changes on disk (for example because the AI ran `aia ops` from the CLI or the MCP,
// in another process), the open editors hear it over Server-Sent Events (GET /api/events) and load it again.
//   document {id}   the document was written (created, changed, undone…)
//   deleted  {id}   its folder or its document.json is gone

import { existsSync, mkdirSync, watch } from 'node:fs';
import path from 'node:path';

/**
 * What a change at `relative` (a path inside the documents folder, as fs.watch reports it) means. Pure, so it is
 * tested without the disk; `exists` tells whether a path is still there.
 * @param {string} relative @param {(relative: string) => boolean} exists
 * @returns {{ event: 'document' | 'deleted', id: string } | null}
 */
export function classifyChange(relative, exists) {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  const [id, file] = parts;
  if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) return null;
  if (parts.length === 1) return exists(id) ? null : { event: 'deleted', id };
  // history.jsonl is written right after document.json: its change is the step being complete.
  if (parts.length !== 2 || (file !== 'document.json' && file !== 'history.jsonl')) return null;
  return exists(path.join(id, 'document.json')) ? { event: 'document', id } : { event: 'deleted', id };
}

/**
 * Watches the documents folder and keeps the editors that listen up to date.
 * @param {string} folder
 * @param {{ delay?: number }} [options] how long the notices of one save wait to be sent as one (ms)
 */
export function createEvents(folder, { delay = 60 } = {}) {
  mkdirSync(folder, { recursive: true });
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** @type {Map<string, NodeJS.Timeout>} */
  const pending = new Map();
  /** @param {string} event @param {string} id */
  const send = (event, id) => {
    const key = `${event}:${id}`;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify({ id })}\n\n`);
      }, delay),
    );
  };
  const watcher = watch(folder, { recursive: true }, (_type, filename) => {
    if (!filename) return;
    const change = classifyChange(filename.toString(), (relative) => existsSync(path.join(folder, relative)));
    if (change) send(change.event, change.id);
  });
  // A heartbeat keeps proxies and the browser from dropping a quiet stream.
  const beat = setInterval(() => {
    for (const res of clients) res.write(': beat\n\n');
  }, 25000);
  beat.unref();

  return {
    /** Answers GET /api/events: the stream stays open until the editor goes. @param {import('node:http').ServerResponse} res */
    listen(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': aia-studio events\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    close() {
      watcher.close();
      clearInterval(beat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
