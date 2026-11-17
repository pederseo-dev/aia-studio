// Documents on disk: <documents>/<id>/document.json and its history, <documents>/<id>/history.jsonl. The pictures
// of its image layers live in <documents>/<id>/assets/. An asset is never deleted while the document lives (an undo
// may bring back the layer that showed it), and the same bytes saved twice are one file.
//
// Every change is a batch of operations with its origin ("user" for the editor, "ai" for the AI) and its inverse.
// Undo and redo are per origin: each side undoes only its own batches, newest first, and a new batch of a side clears
// that side's redo. The history is append-only (one JSON line per batch, undo or redo), so it is also the record of
// who did what.

import fs from 'node:fs/promises';
import path from 'node:path';
import { idFromName, newDocument } from '../src/core/document.js';
import { assetMime, assetName, freeAssetName, readImage, usedAssets } from '../src/core/images.js';
import { ASSET_FILE } from '../src/core/schema.js';
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
  /** @param {string} id */
  const assetsDir = (id) => path.join(dir(id), 'assets');
  /** @param {string} id @param {string} name */
  const assetFile = (id, name) => {
    if (!ASSET_FILE.test(name)) throw new StoreError(`"${name}" is not an asset name`, 400);
    return path.join(assetsDir(id), name);
  };

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

  /** The bytes and MIME type of an asset. @param {string} id @param {string} name */
  async function readAsset(id, name) {
    const file = assetFile(id, name);
    try {
      return { bytes: new Uint8Array(await fs.readFile(file)), mime: /** @type {string} */ (assetMime(name)) };
    } catch (e) {
      if (e.code === 'ENOENT') throw new StoreError(`${id} has no asset "${name}"`, 404);
      throw e;
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

    /**
     * Saves a picture in the document's assets folder, named after its file, and gives its name and size. The same
     * bytes already there are not copied again (reused: true).
     * @param {string} id @param {string} original the file's own name @param {Uint8Array} bytes
     * @returns {Promise<{ src: string, format: string, naturalWidth: number, naturalHeight: number, reused: boolean }>}
     */
    async saveAsset(id, original, bytes) {
      await read(id);
      /** @type {import('../src/core/images.js').ImageInfo} */
      let info;
      try {
        info = readImage(bytes);
      } catch (e) {
        throw new StoreError(e.message, 400);
      }
      const name = assetName(original, info.format);
      await fs.mkdir(assetsDir(id), { recursive: true });
      const there = new Set(await fs.readdir(assetsDir(id)));
      const same = /** @param {string} candidate */ async (candidate) =>
        there.has(candidate) && Buffer.from(bytes).equals(await fs.readFile(assetFile(id, candidate)));
      // The same picture saved before, under its name or a numbered one, is reused.
      const stem = name.replace(/\.[a-z]+$/, '');
      const extension = name.slice(stem.length);
      for (const candidate of [name, ...[...there].filter((f) => f.startsWith(`${stem}_`) && f.endsWith(extension))]) {
        if (await same(candidate)) return { src: candidate, ...info, reused: true };
      }
      const src = freeAssetName(name, (candidate) => there.has(candidate));
      await fs.writeFile(assetFile(id, src), bytes);
      return { src, ...info, reused: false };
    },

    readAsset,

    /** The names of the document's asset files. @param {string} id @returns {Promise<string[]>} */
    async assets(id) {
      await read(id);
      return (await fs.readdir(assetsDir(id)).catch(() => [])).filter((name) => ASSET_FILE.test(name)).sort();
    },

    /**
     * The pictures a document shows, as data URLs by name (for drawings that carry them inside: PNG, export).
     * Missing files are left out, so their layers draw nothing.
     * @param {string} id @param {Doc} document
     * @returns {Promise<Record<string, string>>}
     */
    async assetUrls(id, document) {
      /** @type {Record<string, string>} */
      const urls = {};
      for (const name of usedAssets(document)) {
        const asset = await readAsset(id, name).catch(() => null);
        if (asset) urls[name] = `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString('base64')}`;
      }
      return urls;
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
