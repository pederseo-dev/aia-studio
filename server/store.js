// Documents on disk: <documents>/<id>/document.json and its history, <documents>/<id>/history.jsonl. The pictures
// of its image layers live in <documents>/<id>/assets/. An asset is never deleted while the document lives (an undo
// may bring back the layer that showed it), and the same bytes saved twice are one file.
//
// Every change is a batch of operations with its origin ("user" for the editor, "ai" for the AI) and its inverse.
// Undo and redo are per origin: each side undoes only its own batches, newest first, and a new batch of a side clears
// that side's redo. An undo that would take away or overwrite what the other side did after that step is refused,
// with the reason; `skip` then drops that step from the side's undo, so it can go on undoing older ones. The history is append-only (one JSON line per batch, undo or redo), so it is also the record of
// who did what.

import fs from 'node:fs/promises';
import path from 'node:path';
import { idFromName, newDocument, subtree } from '../src/core/document.js';
import { assetMime, assetName, freeAssetName, readImage, usedAssets } from '../src/core/images.js';
import { ASSET_FILE } from '../src/core/schema.js';
import { applyOps } from '../src/core/operations.js';
import { settleBatch } from '../src/core/settle.js';

/**
 * @typedef {import('../src/core/document.js').Doc} Doc
 * @typedef {import('../src/core/operations.js').Operation} Operation
 * @typedef {{ n: number, time: string, origin: string, kind: 'batch' | 'undo' | 'redo' | 'skip', of?: number,
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
      } else if (entry.kind === 'skip') {
        done.pop();
      }
    }
    return { done, undone };
  }

  /** Who an origin is, in a message. @param {string} origin */
  const who = (origin) => (origin === 'user' ? 'the person' : origin === 'ai' ? 'the AI' : origin);

  /**
   * What the other sides did after step `n`: for each object, the properties they set, or '*' when they made,
   * deleted, moved or renamed it.
   * @param {HistoryEntry[]} entries @param {string} origin @param {number} n
   * @returns {Map<string, { keys: Set<string>, by: string }>}
   */
  function touchedSince(entries, origin, n) {
    /** @type {Map<string, { keys: Set<string>, by: string }>} */
    const touched = new Map();
    /** @param {unknown} id @param {string} key @param {string} by */
    const mark = (id, key, by) => {
      if (typeof id !== 'string') return;
      const entry = touched.get(id) ?? { keys: new Set(), by };
      entry.keys.add(key);
      touched.set(id, entry);
    };
    for (const entry of entries) {
      if (entry.n <= n || entry.origin === origin || entry.kind === 'skip') continue;
      for (const op of entry.ops) {
        if (op.op === 'set') for (const key of Object.keys(op.props ?? {})) mark(op.target, key, entry.origin);
        else if (op.op === 'create') mark(op.id, '*', entry.origin);
        else if (op.op === 'rename') {
          mark(op.target, '*', entry.origin);
          mark(op.id, '*', entry.origin);
        } else mark(op.target, '*', entry.origin);
      }
    }
    return touched;
  }

  /**
   * Why undoing a step would take away or overwrite what another side did after it, or null.
   * @param {Doc} document @param {HistoryEntry[]} entries @param {HistoryEntry} target @param {string} origin
   */
  function conflict(document, entries, target, origin) {
    const touched = touchedSince(entries, origin, target.n);
    if (!touched.size) return null;
    for (const op of target.inverse) {
      if (op.op === 'delete') {
        for (const o of subtree(document, op.target)) {
          const t = touched.get(o.id);
          if (t) return `it would delete ${o.id}, which ${who(t.by)} ${o.id === op.target ? 'changed' : 'made or changed inside it'} after that step`;
        }
      } else if (op.op === 'set') {
        const t = touched.get(op.target);
        const key = t && Object.keys(op.props ?? {}).find((k) => t.keys.has(k) || t.keys.has('*'));
        if (t && key) return `it would overwrite ${op.target}.${key}, which ${who(t.by)} changed after that step`;
      } else if (op.op === 'move' || op.op === 'rename') {
        const t = touched.get(op.target);
        if (t) return `it would ${op.op} ${op.target}, which ${who(t.by)} changed after that step`;
      }
    }
    return null;
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
      return settleBatch(document, ops, (d, o) => applyOps(schema, d, o, { checkPoints: false }).document);
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
     * Applies a batch, settled first as for everyone (settleBatch in core/settle.js): a shared vertex given a place
     * moves the point it shares, deleting a shared point leaves the vertices that shared it where they were, and
     * a transformed layer keeps its origin.
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

    /**
     * Undoes the origin's last step, unless that would take away or overwrite what another side did after it.
     * With skip, that step is dropped from the origin's undo instead (nothing changes in the document).
     * @param {string} id @param {string} origin @param {{ skip?: boolean }} [options]
     */
    undo(id, origin, { skip = false } = {}) {
      return queued(id, async () => {
        const entries = await history(id);
        const target = stacks(entries, origin).done.at(-1);
        if (!target) throw new StoreError('Nothing to undo', 409);
        const current = await read(id);
        if (skip) {
          await save(id, current, { origin, kind: 'skip', of: target.n, ops: [], inverse: [] });
          return state(id, current, origin);
        }
        const step = `step #${target.n}${target.note ? ` (${target.note})` : ''}`;
        const refusal = (/** @type {string} */ why) =>
          new StoreError(`Cannot undo ${step}: ${why}. Skip it to undo older steps (aia undo --skip; in the editor, undo again).`, 409);
        const why = conflict(current, entries, target, origin);
        if (why) throw refusal(why);
        let result;
        try {
          const ops = settled(current, target.inverse);
          result = { ops, ...apply(current, ops) };
        } catch (e) {
          throw refusal(e.message);
        }
        await save(id, result.document, { origin, kind: 'undo', of: target.n, ops: result.ops, inverse: result.inverse });
        return state(id, result.document, origin);
      });
    },

    /** @param {string} id @param {string} origin */
    redo(id, origin) {
      return queued(id, async () => {
        const target = stacks(await history(id), origin).undone.at(-1);
        if (!target) throw new StoreError('Nothing to redo', 409);
        const current = await read(id);
        let result;
        try {
          const ops = settled(current, target.inverse);
          result = { ops, ...apply(current, ops) };
        } catch (e) {
          throw new StoreError(`Cannot redo: ${e.message}`, 409);
        }
        await save(id, result.document, { origin, kind: 'redo', of: target.of, ops: result.ops, inverse: result.inverse });
        return state(id, result.document, origin);
      });
    },
  };
}
