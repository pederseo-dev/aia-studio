// Documents on disk: documents/<id>/document.json and its history (history.jsonl).
// Used by the editor server (origin "user") and the MCP (origin "ai"), so both work on the same
// files. Each batch stays in the history with its origin and its inverses; undo and redo are computed from there,
// per origin: the AI undoes only its own and the user only theirs.

import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ValidationError, createDocument, validate } from '../src/core/document.js';
import { migrateScenesWithParams } from '../src/core/migration.js';
import { applyOperations } from '../src/core/operations.js';
import { ASSET_FILE } from '../src/core/schema.js';
import { IMAGE_FORMATS, usedAssets, readImage, assetMime, assetName, freeName } from '../src/core/images.js';

import { resolveDocumentsFolder } from './folder.js';

/** The documents folder of this process: see server/folder.js. */
export const DOCUMENTS_FOLDER = resolveDocumentsFolder();
const DOCUMENT_ID = /^[a-z][a-z0-9_-]*$/;

// Operations that change the structure of an object (not a single property): they touch the "whole" object.
const STRUCTURAL = new Set(['create', 'delete', 'move', 'rename', 'duplicate', '_restore', '_place']);

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// Properties undone per (object, property) and not whole: a pose's `values` and a clip's `tracks`.
// That way a pose or clip both origins edited on different objects or tracks does not block undo.
const BY_KEY = { values: 'pose', tracks: 'animation' };
// In a pose or a track, "d" is sugar for the vertices: touching one is touching the other.
const keyOf = (field, object, prop) => `${field}.${object}.${prop === 'd' ? 'vertices' : prop}`;

/**
 * Changes of a batch to the poses' `values` and the clips' `tracks`, per (object, property). Returns
 * Map target → { field, before, after, keys } (before = what its inverses restore; after = what its
 * operations set).
 */
function changesByKey(entry) {
  const last = (ops) => {
    const m = new Map();
    for (const op of ops ?? []) {
      for (const field of Object.keys(BY_KEY)) {
        if (op.op === 'set' && isObject(op.props?.[field])) m.set(op.target, { field, value: op.props[field] });
        // A pose or clip that did not have the field: its inverse is an unset, which amounts to empty.
        else if (op.op === 'unset' && op.props?.includes(field)) m.set(op.target, { field, value: {} });
      }
    }
    return m;
  };
  const after = last(entry.ops);
  const before = last(entry.inverses);
  const changes = new Map();
  for (const target of new Set([...after.keys(), ...before.keys()])) {
    const field = (after.get(target) ?? before.get(target)).field;
    const [a, d] = [before.get(target)?.value, after.get(target)?.value];
    const keys = new Set();
    for (const object of new Set([...Object.keys(a ?? {}), ...Object.keys(d ?? {})])) {
      const [ca, cd] = [a?.[object] ?? {}, d?.[object] ?? {}];
      for (const prop of new Set([...Object.keys(ca), ...Object.keys(cd)])) {
        // Without both versions (for example, a pose that had no values) everything visible counts.
        if (!a || !d || JSON.stringify(ca[prop]) !== JSON.stringify(cd[prop])) keys.add(keyOf(field, object, prop));
      }
    }
    changes.set(target, { field, before: a, after: d, keys });
  }
  return changes;
}

/**
 * The inverses of a batch, with the pose `values` and clip `tracks` applied per key over how they are
 * now: undoing a change to one object of the pose (or one track of the clip) does not take away what the other
 * origin changed later on another object or track.
 */
function inversesByKey(doc, entry) {
  const changes = changesByKey(entry);
  if (!changes.size) return entry.inverses;
  return entry.inverses.flatMap((op) => {
    const change = changes.get(op.target);
    if (!change) return op;
    const { field } = change;
    const fromField = (op.op === 'set' && isObject(op.props?.[field])) || (op.op === 'unset' && op.props?.includes(field));
    const current = fromField && doc.objects.find((o) => o.id === op.target);
    if (!change.before || !change.after || current?.type !== BY_KEY[field]) return op;
    const value = structuredClone(current[field] ?? {});
    for (const key of change.keys) {
      const [, object, prop] = key.split('.');
      const old = change.before[object]?.[prop];
      if (old === undefined) {
        if (value[object]) delete value[object][prop];
        if (value[object] && !Object.keys(value[object]).length) delete value[object];
      } else (value[object] ??= {})[prop] = structuredClone(old);
    }
    if (op.op === 'set') return [{ ...op, props: { ...op.props, [field]: value } }];
    const rest = op.props.filter((k) => k !== field);
    return [{ op: 'set', target: op.target, props: { [field]: value } }, ...(rest.length ? [{ ...op, props: rest }] : [])];
  });
}

/** (id, property) touched by a batch, with its inverses: Map id → Set of properties ("*" = the whole object). */
function touched(entry) {
  const map = new Map();
  const add = (id, prop) => id != null && (map.get(id) ?? map.set(id, new Set()).get(id)).add(prop);
  const byKey = changesByKey(entry);
  for (const [target, { keys }] of byKey) keys.forEach((k) => add(target, k));
  const alreadyCounted = (id, k) => byKey.get(id)?.field === k;
  for (const op of [...(entry.ops ?? []), ...(entry.inverses ?? [])]) {
    if (op.op === 'set') Object.keys(op.props ?? {}).forEach((k) => !alreadyCounted(op.target, k) && add(op.target, k));
    else if (op.op === 'unset') (op.props ?? []).forEach((k) => !alreadyCounted(op.target, k) && add(op.target, k));
    else if (STRUCTURAL.has(op.op)) {
      add(op.target ?? op.id, '*');
      if (op.op === 'rename' || op.op === 'create') add(op.id, '*');
      // Putting something into a container also touches it: undoing the container's creation would take that
      // child away.
      if (op.parent != null) add(op.parent, 'children');
      for (const { obj } of op.entries ?? []) add(obj?.id, '*');
    }
  }
  return map;
}

/** Do two properties overlap? Equal, or one contains the other ("values" contains "values.mouth.x"). */
const overlap = (p, q) => p === q || p.startsWith(`${q}.`) || q.startsWith(`${p}.`);

/** "id.prop" names (or "id", if either changed the whole object) that two batches touch in common. */
function common(a, b) {
  const output = new Set();
  for (const [id, propsA] of a) {
    const propsB = b.get(id);
    if (!propsB) continue;
    if (propsB.has('*')) output.add(id);
    else for (const p of propsB) if (propsA.has('*') || [...propsA].some((q) => overlap(p, q))) output.add(`${id}.${p}`);
  }
  return output;
}

// ---------- Old on-disk format ----------
// Until the translation stage (2026-11) documents lived in personajes/<id>/documento.json, with the history in
// historial.jsonl and its fields in Spanish. They are moved to the new format once, when the store is created; it is
// repeatable and does not touch what is already migrated.

const KIND_FROM_LEGACY = { crear: 'create', cambio: 'change', migracion: 'migration', deshacer: 'undo', rehacer: 'redo' };

/** An old history entry with its fields in English (new ones stay the same). */
export function entryFromLegacy(e) {
  if (!('fecha' in e) && !('origen' in e) && !('tipo' in e)) return e;
  const { fecha, origen, tipo, nota, inversas, ...rest } = e;
  const entry = { ...rest, date: fecha, origin: origen, kind: KIND_FROM_LEGACY[tipo] ?? tipo };
  if (nota !== undefined) entry.note = nota;
  if (inversas !== undefined) entry.inverses = inversas;
  // The previous field order: n, date, origin, kind, [ref], note, ops, inverses.
  const { n, date, origin, kind, ref, note, ops, inverses, ...extra } = entry;
  return Object.fromEntries(Object.entries({ n, date, origin, kind, ref, note, ops, inverses, ...extra }).filter(([, v]) => v !== undefined));
}

/**
 * Moves `folder` (and the old personajes/ folder next to it, if `folder` does not exist yet) to the new format.
 * Returns a warning when both folders exist: personajes/ is then left as it is, and someone has to merge it by hand.
 * @returns {string | null}
 */
export function migrateLegacyFolder(folder) {
  const legacy = path.join(path.dirname(path.resolve(folder)), 'personajes');
  let warning = null;
  if (existsSync(folder) && existsSync(legacy) && readdirSync(legacy).length) {
    warning = `Both ${legacy} (old format) and ${path.resolve(folder)} exist: the old folder is not migrated. Move its documents into the new one by hand (they are migrated on the next start).`;
  }
  if (!existsSync(folder) && existsSync(legacy)) {
    try {
      renameSync(legacy, folder);
    } catch (e) {
      // Another process (the editor or the MCP) may have moved it first.
      if (!existsSync(folder)) throw e;
    }
  }
  if (!existsSync(folder)) return warning;
  for (const d of readdirSync(folder, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(folder, d.name);
    const pair = (old, current) => [path.join(dir, old), path.join(dir, current)];
    const [oldDoc, newDoc] = pair('documento.json', 'document.json');
    if (existsSync(oldDoc) && !existsSync(newDoc)) renameSync(oldDoc, newDoc);
    const [oldHistory, newHistory] = pair('historial.jsonl', 'history.jsonl');
    if (existsSync(oldHistory) && !existsSync(newHistory)) {
      const lines = readFileSync(oldHistory, 'utf8').split('\n').filter((l) => l.trim());
      writeFileSync(`${newHistory}.tmp`, lines.map((l) => JSON.stringify(entryFromLegacy(JSON.parse(l))) + '\n').join(''));
      renameSync(`${newHistory}.tmp`, newHistory);
      unlinkSync(oldHistory);
    }
  }
  return warning;
}

export function createStore({ schema, folder = DOCUMENTS_FOLDER }) {
  const warning = migrateLegacyFolder(folder);
  // On stderr: the MCP uses stdout for the protocol.
  if (warning) console.error(warning);
  // This process's writes are queued so they do not overwrite each other.
  /** @type {Promise<any>} */
  let row = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const enqueue = (fn) => (row = row.then(fn, fn));

  const filePath = (id, file) => {
    if (!DOCUMENT_ID.test(id ?? '')) throw new Error(`Invalid document id "${id}": lowercase, digits, _ and -`);
    return path.join(folder, id, file);
  };

  // Image layer files: documents/<id>/assets/<src>. They are not part of the history (undo removes the layer, not
  // the file).
  const assetPath = (id, src) => {
    if (!ASSET_FILE.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
    return filePath(id, path.join('assets', src));
  };
  const exists = (file) => fs.access(file).then(() => true, () => false);

  async function listAssets(id) {
    try {
      return (await fs.readdir(path.dirname(assetPath(id, 'x.png')))).filter((a) => ASSET_FILE.test(a)).sort();
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Warnings for image layers of the batch whose file is not in assets/. */
  async function assetWarnings(id, doc, ops) {
    const touched = new Set(ops.filter((o) => o.op === 'create' || o.op === 'set').map((o) => o.op === 'create' ? o.id : o.target));
    const missing = [];
    for (const o of doc.objects) if (o.type === 'image' && touched.has(o.id) && !(await exists(assetPath(id, o.src ?? 'missing.png')))) missing.push(`${o.id} (${o.src ?? 'missing.png'})`);
    return missing.length ? [`Image file not found in the document's assets: ${missing.join(', ')}. Add the file with add_image (or the editor's Image option); until then the layer draws nothing.`] : [];
  }

  async function read(id) {
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(filePath(id, 'document.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`There is no document "${id}"`);
      throw e;
    }
    return migrateOnRead(id, doc);
  }

  // Format migrations done automatically on read (see src/core/migration.js): saved once, with a
  // "migration" entry in the history. One promise per document, so two reads at once do not migrate twice.
  const migrating = new Map();
  async function migrateOnRead(id, doc) {
    const { doc: migrated, changes } = migrateScenesWithParams(doc, schema);
    if (!changes.length) return doc;
    if (!migrating.has(id)) {
      migrating.set(id, (async () => {
        await write(id, migrated);
        await record(id, { origin: 'system', kind: 'migration', note: changes.join(' '), ops: [], inverses: [] });
      })().finally(() => migrating.delete(id)));
    }
    await migrating.get(id);
    return migrated;
  }

  async function write(id, doc) {
    // Temp file + rename: nobody ever reads a half-written file.
    const target = filePath(id, 'document.json');
    await fs.writeFile(target + '.tmp', JSON.stringify(doc, null, 2) + '\n');
    await fs.rename(target + '.tmp', target);
  }

  async function history(id) {
    try {
      const text = await fs.readFile(filePath(id, 'history.jsonl'), 'utf8');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async function record(id, entry) {
    const n = (await history(id)).length + 1;
    const complete = { n, date: new Date().toISOString(), ...entry };
    await fs.appendFile(filePath(id, 'history.jsonl'), JSON.stringify(complete) + '\n');
    return complete;
  }

  // Undo/redo stacks of an origin, rebuilt from the history.
  function stacks(entries, origin) {
    const undo = [];
    const redo = [];
    for (const e of entries) {
      // A format migration (from any origin) cuts the stacks: the inverses from before no longer fit.
      if (e.kind === 'migration') {
        undo.length = 0;
        redo.length = 0;
        continue;
      }
      if (e.origin !== origin) continue;
      if (e.kind === 'change') {
        undo.push(e.n);
        redo.length = 0;
      } else if (e.kind === 'undo') {
        undo.pop();
        redo.push(e.n);
      } else if (e.kind === 'redo') {
        redo.pop();
        undo.push(e.n);
      }
    }
    return { undo, redo };
  }

  /**
   * Batches from another origin after `entry` that are still standing and touch any of its same (id, property):
   * undoing or redoing it would overwrite them. A change its origin already undid (or an undo it already redid)
   * cancels out and does not count. Returns [{ who, n, note, props: ["r.x", ...] }].
   */
  function conflictsWithOthers(entries, entry) {
    const own = touched(entry);
    const standing = new Map(); // origin → Map(n → entry)
    for (const e of entries.slice(entry.n)) {
      if (e.kind === 'migration') return []; // the migration already cut the stacks
      if (e.origin === entry.origin || !['change', 'undo', 'redo'].includes(e.kind)) continue;
      const fromOrigin = standing.get(e.origin) ?? standing.set(e.origin, new Map()).get(e.origin);
      // Undoing a batch (or redoing an undo) that is also later: they cancel each other out.
      if (e.kind !== 'change' && fromOrigin.has(e.ref)) fromOrigin.delete(e.ref);
      else fromOrigin.set(e.n, e);
    }
    const conflicts = [];
    for (const fromOrigin of standing.values()) {
      for (const e of fromOrigin.values()) {
        const props = [...common(own, touched(e))];
        if (props.length) conflicts.push({ who: e.origin, n: e.n, note: e.note ?? '', props });
      }
    }
    return conflicts;
  }

  async function revert(id, origin, kind) {
    const entries = await history(id);
    const stack = stacks(entries, origin)[kind === 'undo' ? 'undo' : 'redo'];
    if (!stack.length) throw new Error(kind === 'undo' ? 'Nothing of yours to undo' : 'Nothing to redo');
    const entry = entries[stack.at(-1) - 1];
    const conflicts = conflictsWithOthers(entries, entry);
    if (conflicts.length) {
      const verb = kind === 'undo' ? 'undo' : 'redo';
      const detail = conflicts.map(({ who, n, note, props }) => `${props.join(', ')} (changed by ${who === 'user' ? 'the user' : who === 'ai' ? 'the AI' : who} in #${n} "${note}")`).join('; ');
      throw new Error(`Can't ${verb} #${entry.n} "${entry.note ?? ''}": it would overwrite later changes from another origin: ${detail}. Change those properties by hand instead, or ask whoever made them.`);
    }
    let result;
    const current = await read(id);
    const inverses = inversesByKey(current, entry);
    try {
      result = applyOperations(current, inverses, schema);
    } catch (e) {
      throw new Error(`Can't ${kind === 'undo' ? 'undo' : 'redo'}: the document changed afterwards and it no longer fits.\n${e.message}`);
    }
    await write(id, result.doc);
    // The user sees the note in the history: in English (old Spanish prefixes are cleaned up too).
    const note = entry.note?.replace(/^(deshacer|rehacer|undo|redo): /, '') ?? '';
    await record(id, { origin, kind, ref: entry.n, note: `${kind === 'undo' ? 'undo' : 'redo'}: ${note}`, ops: inverses, inverses: result.inverses });
    return { doc: result.doc, in: { n: entry.n, note, ops: entry.ops.length, batch: entry.ops } };
  }

  return {
    read,

    async list() {
      await fs.mkdir(folder, { recursive: true });
      const folders = await fs.readdir(folder, { withFileTypes: true });
      const ids = folders.filter((c) => c.isDirectory() && DOCUMENT_ID.test(c.name)).map((c) => c.name).sort();
      const list = [];
      for (const id of ids) {
        try {
          list.push({ id, name: (await read(id)).meta.name ?? id });
        } catch {
          // folder without a document: ignored
        }
      }
      return list;
    },

    /** Creates an empty document or, with `copyFrom`, a copy of another one (without its history). */
    /** @param {string} id @param {Record<string, any>} meta @param {{ origin: string, note?: string, copyFrom?: string }} options */
    create: (id, meta, { origin, note, copyFrom }) =>
      enqueue(async () => {
        try {
          await fs.access(filePath(id, 'document.json'));
          throw new Error(`The document "${id}" already exists`);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        let doc = createDocument(meta);
        if (copyFrom) {
          const base = await read(copyFrom);
          doc = { ...base, meta: { ...base.meta, ...meta } };
          note ??= `copy of ${copyFrom}`;
        }
        const { errors } = validate(doc, schema);
        if (errors.length) throw new ValidationError(errors);
        await fs.mkdir(path.dirname(filePath(id, 'document.json')), { recursive: true });
        // The copy also carries its images' files.
        if (copyFrom && (await listAssets(copyFrom)).length) await fs.cp(path.dirname(assetPath(copyFrom, 'x.png')), path.dirname(assetPath(id, 'x.png')), { recursive: true });
        await write(id, doc);
        await record(id, { origin, kind: 'create', note: note ?? 'document created', ops: [], inverses: [] });
        return doc;
      }),

    /** Applies a batch on the version on disk. Returns the document and the warnings. */
    applyOps: (id, ops, { origin, note }) =>
      enqueue(async () => {
        const { doc, inverses, warnings } = applyOperations(await read(id), ops, schema);
        await write(id, doc);
        await record(id, { origin, kind: 'change', note: note || `${ops.length} ${ops.length === 1 ? 'change' : 'changes'}`, ops, inverses });
        return { doc, warnings: [...warnings, ...(await assetWarnings(id, doc, ops))] };
      }),

    /** Deletes the document and its history. Cannot be undone. */
    delete: (id) =>
      enqueue(async () => {
        await read(id);
        await fs.rm(path.dirname(filePath(id, 'document.json')), { recursive: true });
      }),

    /**
     * Saves an image file in assets/ and returns { src, naturalWidth, naturalHeight, format, reused }. The name
     * comes from the original; if there is already a file with the same bytes, that one is reused, and if the name
     * is taken by another, _2, _3... is appended.
     * @param {string} id @param {string} original @param {Uint8Array} bytes
     */
    saveAsset: (id, original, bytes) =>
      enqueue(async () => {
        await read(id);
        const { format, naturalWidth, naturalHeight } = readImage(bytes);
        const equal = async (src) => Buffer.from(bytes).equals(await fs.readFile(assetPath(id, src)));
        for (const src of await listAssets(id)) if (assetMime(src) === IMAGE_FORMATS[format].mime && (await equal(src))) return { src, naturalWidth, naturalHeight, format, reused: true };
        const taken = new Set(await listAssets(id));
        const src = freeName(assetName(original, format), (n) => taken.has(n));
        await fs.mkdir(path.dirname(assetPath(id, src)), { recursive: true });
        await fs.writeFile(assetPath(id, src), bytes);
        return { src, naturalWidth, naturalHeight, format, reused: false };
      }),

    /**
     * Deletes an asset that no image layer uses (for example, the file of an add_image whose layer could not be
     * created). Returns whether it deleted it.
     * @param {string} id @param {string} src
     */
    discardAsset: (id, src) =>
      enqueue(async () => {
        if (usedAssets(await read(id)).includes(src)) return false;
        await fs.rm(assetPath(id, src), { force: true });
        return true;
      }),

    /**
     * The files in assets/ with their natural size and the layers that use them (for get_document: the AI can reuse
     * them, go back to the original size or see what is left unused).
     * @param {string} id @param {any} doc
     */
    async assetsInfo(id, doc) {
      const info = [];
      for (const src of await listAssets(id)) {
        const layers = doc.objects.filter((o) => o.type === 'image' && o.src === src).map((o) => o.id);
        let size = '';
        try {
          const { naturalWidth, naturalHeight } = readImage(new Uint8Array(await fs.readFile(assetPath(id, src))));
          size = `${naturalWidth}×${naturalHeight} px`;
        } catch {
          size = 'size unknown';
        }
        info.push({ src, size, layers });
      }
      return info;
    },

    /** Bytes and MIME type of an asset. */
    async readAsset(id, src) {
      try {
        return { bytes: await fs.readFile(assetPath(id, src)), mime: assetMime(src) };
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`The document "${id}" has no asset "${src}"`);
        throw e;
      }
    },

    listAssets,

    /** The image files the document uses (src → bytes), to draw it outside the browser. */
    async imagesOf(id, doc) {
      const map = new Map();
      for (const src of usedAssets(doc)) {
        if (!ASSET_FILE.test(src)) continue;
        try {
          map.set(src, await fs.readFile(assetPath(id, src)));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
      return map;
    },

    undo: (id, origin) => enqueue(() => revert(id, origin, 'undo')),
    redo: (id, origin) => enqueue(() => revert(id, origin, 'redo')),

    /** Latest entries, from oldest to newest, plus what each origin can undo/redo. */
    async history(id, limit = 50) {
      const entries = await history(id);
      const available = (origin) => {
        const p = stacks(entries, origin);
        return { undo: p.undo.length > 0, redo: p.redo.length > 0 };
      };
      return { entries: entries.slice(-limit), ai: available('ai'), user: available('user') };
    },
  };
}
