// Documents on disk: <documents>/<id>/document.json and its history, <documents>/<id>/history.jsonl.
//
// Every change is a batch of operations with its origin ("user" for the editor, "ai" for the AI) and its inverse.
// Undo and redo are per origin: each side undoes only its own batches, newest first, and a new batch of a side clears
// that side's redo. The history is append-only (one JSON line per batch, undo or redo), so it is also the record of
// who did what.

import fs from 'node:fs/promises';
import path from 'node:path';
import { idFromName, newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { settleOps } from '../src/core/points.js';

/**
 * @typedef {import('../src/core/document.js').Doc} Doc
 * @typedef {import('../src/core/operations.js').Operation} Operation
 * @typedef {{ n: number, time: string, origin: string, kind: 'batch' | 'undo' | 'redo', of?: number,
 *   note?: string, ops: Operation[], inverse: Operation[] }} HistoryEntry
 * @typedef {{ document: Doc, canUndo: boolean, canRedo: boolean }} DocumentState
 */

export class StoreError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ folder: string, schema: import('../src/core/schema.js').Schema }} options
 */
export function createStore({ folder, schema }) {
  /** @param {string} id */
  const dir = (id) => {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new StoreError(`"${id}" is not a document id`, 400);
    return path.join(folder, id);
  };
  const documentFile = (id) => path.join(dir(id), 'document.json');
  const historyFile = (id) => path.join(dir(id), 'history.jsonl');

  /** @param {string} id @returns {Promise<Doc>} */
  async function read(id) {
    try {
      return JSON.parse(await fs.readFile(documentFile(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new StoreError(`There is no document "${id}"`, 404);
      throw e;
    }
  }

  /** @param {string} id @returns {Promise<HistoryEntry[]>} */
  async function history(id) {
    const text = await fs.readFile(historyFile(id), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /**
   * What an origin can undo and redo right now, newest last. Both are entries whose `inverse` does the job: the
   * inverse of a batch (or a redo) undoes it, and the inverse of an undo redoes it exactly as it was (the same places
   * in the layer order, not only the same ops).
   * @param {HistoryEntry[]} entries @param {string} origin
   */
  function stacks(entries, origin) {
    /** @type {HistoryEntry[]} */ const done = [];
    /** @type {HistoryEntry[]} */ let undone = [];
    for (const entry of entries) {
      if (entry.origin !== origin) continue;
      if (entry.kind === 'batch') {
        done.push(entry);
        undone = [];
      } else if (entry.kind === 'undo') {
        done.pop();
        undone.push(entry);
      } else if (entry.kind === 'redo') {
        undone.pop();
        done.push(entry);
      }
    }
    return { done, undone };
  }

  /** @param {string} id @param {Doc} document @param {string} origin @returns {Promise<DocumentState>} */
  async function state(id, document, origin) {
    const { done, undone } = stacks(await history(id), origin);
    return { document, canUndo: done.length > 0, canRedo: undone.length > 0 };
  }

  /** @param {string} id @param {Doc} document @param {Omit<HistoryEntry, 'n' | 'time'>} entry */
  async function save(id, document, entry) {
    const n = (await history(id)).length + 1;
    await fs.writeFile(documentFile(id), `${JSON.stringify(document, null, 2)}\n`);
    await fs.appendFile(historyFile(id), `${JSON.stringify({ n, time: new Date().toISOString(), ...entry })}\n`);
  }

  // One change at a time per document, so two batches never read the same version.
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();
  /** @template T @param {string} id @param {() => Promise<T>} task @returns {Promise<T>} */
  function queued(id, task) {
    const run = (queues.get(id) ?? Promise.resolve()).then(task, task);
    queues.set(id, run.catch(() => {}));
    return run;
  }

  /** @param {Doc} document @param {Operation[]} ops */
  function settled(document, ops) {
    if (!Array.isArray(ops) || !ops.length) return ops;
    try {
      return settleOps(document, ops, (d, o) => applyOps(schema, d, o, { checkPoints: false }).document);
    } catch (e) {
      throw new StoreError(e.message, 400);
    }
  }

  /** @param {Doc} document @param {Operation[]} ops */
  function apply(document, ops) {
    try {
      return applyOps(schema, document, ops);
    } catch (e) {
      throw new StoreError(e.message, 400);
    }
  }

  return {
    folder,

    /** @returns {Promise<{ id: string, name: string }[]>} */
    async list() {
      const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
      const documents = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-z][a-z0-9_]*$/.test(entry.name)) continue;
        const document = await read(entry.name).catch(() => null);
        if (document) documents.push({ id: entry.name, name: String(document.meta?.name ?? entry.name) });
      }
      return documents.sort((a, b) => a.name.localeCompare(b.name));
    },

    /**
     * @param {Record<string, unknown>} meta at least a name
     * @returns {Promise<{ id: string } & DocumentState>}
     */
    async create(meta) {
      const name = String(meta.name ?? '').trim() || 'Untitled';
      const taken = new Set((await fs.readdir(folder).catch(() => [])).map(String));
      const id = idFromName(name, (candidate) => taken.has(candidate));
      // Built through `set` so the meta is validated and keeps only what differs from the defaults.
      const { document } = apply(newDocument(), [{ op: 'set', target: 'meta', props: { ...meta, name } }]);
      document.meta = { name, ...document.meta };
      await fs.mkdir(dir(id), { recursive: true });
      await fs.writeFile(documentFile(id), `${JSON.stringify(document, null, 2)}\n`);
      return { id, document, canUndo: false, canRedo: false };
    },

    /** The history of a document, oldest first. @param {string} id */
    history,

    /** @param {string} id @param {string} origin */
    async get(id, origin) {
      return state(id, await read(id), origin);
    },

    /** @param {string} id */
    async remove(id) {
      await read(id);
      await fs.rm(dir(id), { recursive: true, force: true });
    },

    /**
     * Applies a batch, settled first as for everyone (settleOps in core/points.js): a shared vertex given a place
     * moves the point it shares, and deleting a shared point leaves the vertices that shared it where they were.
     * @param {string} id @param {Operation[]} ops @param {{ origin: string, note?: string }} by
     */
    apply(id, ops, { origin, note }) {
      return queued(id, async () => {
        const current = await read(id);
        ops = settled(current, ops);
        const { document, inverse } = apply(current, ops);
        await save(id, document, { origin, kind: 'batch', ...(note ? { note } : {}), ops, inverse });
        return state(id, document, origin);
      });
    },

    /** @param {string} id @param {string} origin */
    undo(id, origin) {
      return queued(id, async () => {
        const target = stacks(await history(id), origin).done.at(-1);
        if (!target) throw new StoreError('Nothing to undo', 409);
        const { document, inverse } = apply(await read(id), target.inverse);
        await save(id, document, { origin, kind: 'undo', of: target.n, ops: target.inverse, inverse });
        return state(id, document, origin);
      });
    },

    /** @param {string} id @param {string} origin */
    redo(id, origin) {
      return queued(id, async () => {
        const target = stacks(await history(id), origin).undone.at(-1);
        if (!target) throw new StoreError('Nothing to redo', 409);
        const { document, inverse } = apply(await read(id), target.inverse);
        await save(id, document, { origin, kind: 'redo', of: target.of, ops: target.inverse, inverse });
        return state(id, document, origin);
      });
    },
  };
}
