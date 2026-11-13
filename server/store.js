// Documentos en disco: documents/<id>/document.json y su historial (history.jsonl).
// Lo usan el servidor del editor (origen "user") y el MCP (origen "ai"), así que los dos trabajan sobre los mismos
// archivos. Cada lote queda en el historial con su origen y sus inversas; deshacer y rehacer se calculan desde ahí,
// por origen: la IA deshace solo lo suyo y el usuario solo lo suyo.

import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError, createDocument, validate } from '../src/core/document.js';
import { migrateScenesWithParams } from '../src/core/migration.js';
import { applyOperations } from '../src/core/operations.js';
import { ASSET_FILE } from '../src/core/schema.js';
import { IMAGE_FORMATS, usedAssets, readImage, assetMime, assetName, freeName } from '../src/core/images.js';

export const DOCUMENTS_FOLDER = fileURLToPath(new URL('../documents/', import.meta.url));
const DOCUMENT_ID = /^[a-z][a-z0-9_-]*$/;

// Operaciones que cambian la estructura de un objeto (no una propiedad suelta): tocan "todo" el objeto.
const STRUCTURAL = new Set(['create', 'delete', 'move', 'rename', 'duplicate', '_restore', '_place']);

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// Propiedades que se deshacen por (objeto, propiedad) y no enteras: los `values` de una pose y las `tracks` de un
// clip. Así una pose o un clip que editaron los dos orígenes en objetos o pistas distintas no bloquea el deshacer.
const BY_KEY = { values: 'pose', tracks: 'animation' };
// En una pose o una pista, "d" es azúcar para los vértices: tocar uno es tocar los otros.
const keyOf = (field, object, prop) => `${field}.${object}.${prop === 'd' ? 'vertices' : prop}`;

/**
 * Cambios de un lote en los `values` de las poses y las `tracks` de los clips, por (objeto, propiedad). Devuelve
 * Map destino → { campo, antes, despues, claves } (antes = lo que restauran sus inversas; despues = lo que fijaron
 * sus operaciones).
 */
function changesByKey(entry) {
  const last = (ops) => {
    const m = new Map();
    for (const op of ops ?? []) {
      for (const field of Object.keys(BY_KEY)) {
        if (op.op === 'set' && isObject(op.props?.[field])) m.set(op.target, { field, value: op.props[field] });
        // Una pose o un clip que no tenía el campo: su inversa es un unset, que equivale a vacío.
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
        // Sin las dos versiones (por ejemplo, una pose que no tenía values) cuenta todo lo que se ve.
        if (!a || !d || JSON.stringify(ca[prop]) !== JSON.stringify(cd[prop])) keys.add(keyOf(field, object, prop));
      }
    }
    changes.set(target, { field, before: a, after: d, keys });
  }
  return changes;
}

/**
 * Las inversas de un lote, con los `values` de pose y las `tracks` de clip aplicados por clave sobre cómo están
 * ahora: deshacer un cambio en un objeto de la pose (o en una pista del clip) no se lleva lo que el otro origen
 * cambió después en otro objeto o pista.
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

/** (id, propiedad) que toca un lote, con sus inversas: Map id → Set de propiedades ("*" = el objeto entero). */
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
      // Meter algo en un contenedor también lo toca: deshacer la creación del contenedor se llevaría ese hijo.
      if (op.parent != null) add(op.parent, 'children');
      for (const { obj } of op.entries ?? []) add(obj?.id, '*');
    }
  }
  return map;
}

/** ¿Dos propiedades se pisan? Iguales, o una contiene a la otra ("values" contiene a "values.mouth.x"). */
const overlap = (p, q) => p === q || p.startsWith(`${q}.`) || q.startsWith(`${p}.`);

/** Nombres "id.prop" (o "id", si alguno cambió el objeto entero) que dos lotes tocan en común. */
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

// ---------- Formato viejo en disco ----------
// Hasta la etapa de traducción (2026-11) los documentos vivían en personajes/<id>/documento.json, con el historial en
// historial.jsonl y sus campos en español. Se pasa al formato nuevo una sola vez, al crear el almacén; es repetible y
// no toca lo que ya está migrado.

const KIND_FROM_LEGACY = { crear: 'create', cambio: 'change', migracion: 'migration', deshacer: 'undo', rehacer: 'redo' };

/** Una entrada del historial viejo con sus campos en inglés (las nuevas quedan igual). */
export function entryFromLegacy(e) {
  if (!('fecha' in e) && !('origen' in e) && !('tipo' in e)) return e;
  const { fecha, origen, tipo, nota, inversas, ...rest } = e;
  const entry = { ...rest, date: fecha, origin: origen, kind: KIND_FROM_LEGACY[tipo] ?? tipo };
  if (nota !== undefined) entry.note = nota;
  if (inversas !== undefined) entry.inverses = inversas;
  // El orden de los campos de antes: n, date, origin, kind, [ref], note, ops, inverses.
  const { n, date, origin, kind, ref, note, ops, inverses, ...extra } = entry;
  return Object.fromEntries(Object.entries({ n, date, origin, kind, ref, note, ops, inverses, ...extra }).filter(([, v]) => v !== undefined));
}

/** Pasa `folder` (y la carpeta vieja personajes/ al lado, si `folder` todavía no existe) al formato nuevo. */
export function migrateLegacyFolder(folder) {
  const legacy = path.join(path.dirname(path.resolve(folder)), 'personajes');
  if (!existsSync(folder) && existsSync(legacy)) {
    try {
      renameSync(legacy, folder);
    } catch (e) {
      // Otro proceso (el editor o el MCP) pudo moverla primero.
      if (!existsSync(folder)) throw e;
    }
  }
  if (!existsSync(folder)) return;
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
}

export function createStore({ schema, folder = DOCUMENTS_FOLDER }) {
  migrateLegacyFolder(folder);
  // Las escrituras de este proceso van en fila para no pisarse entre sí.
  /** @type {Promise<any>} */
  let row = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const enqueue = (fn) => (row = row.then(fn, fn));

  const filePath = (id, file) => {
    if (!DOCUMENT_ID.test(id ?? '')) throw new Error(`id de documento inválido "${id}": minúsculas, números, _ y -`);
    return path.join(folder, id, file);
  };

  // Archivos de las capas image: personajes/<id>/assets/<src>. No entran en el historial (deshacer quita la capa, no
  // el archivo).
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

  /** Avisos de capas image del lote cuyo archivo no está en assets/. */
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
      if (e.code === 'ENOENT') throw new Error(`No existe el documento "${id}"`);
      throw e;
    }
    return migrateOnRead(id, doc);
  }

  // Migraciones del formato que se hacen solas al leer (ver src/core/migracion.js): se guardan una vez, con una
  // entrada «migracion» en el historial. Una promesa por documento, para que dos lecturas a la vez no migren dos veces.
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
    // Temporal + rename: nadie lee nunca un archivo a medio escribir.
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

  // Pilas de deshacer/rehacer de un origen, reconstruidas desde el historial.
  function stacks(entries, origin) {
    const undo = [];
    const redo = [];
    for (const e of entries) {
      // Una migración del formato (de cualquier origen) corta las pilas: las inversas de antes ya no encajan.
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
   * Lotes de otro origen posteriores a `entrada` que siguen en pie y tocan alguna de sus mismas (id, propiedad):
   * deshacerla o rehacerla los pisaría. Un cambio que su origen ya deshizo (o un deshacer que ya rehizo) se cancela y
   * no cuenta. Devuelve [{ quien, n, nota, props: ["r.x", ...] }].
   */
  function conflictsWithOthers(entries, entry) {
    const own = touched(entry);
    const standing = new Map(); // origen → Map(n → entrada)
    for (const e of entries.slice(entry.n)) {
      if (e.kind === 'migration') return []; // la migración ya cortó las pilas
      if (e.origin === entry.origin || !['change', 'undo', 'redo'].includes(e.kind)) continue;
      const fromOrigin = standing.get(e.origin) ?? standing.set(e.origin, new Map()).get(e.origin);
      // Deshacer un lote (o rehacer un deshacer) que también es posterior: se anulan entre sí.
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
    // La nota la ve el usuario en el historial: en inglés (los prefijos viejos en español también se limpian).
    const note = entry.note?.replace(/^(deshacer|rehacer|undo|redo): /, '') ?? '';
    await record(id, { origin, kind, ref: entry.n, note: `${kind === 'undo' ? 'undo' : 'redo'}: ${note}`, ops: inverses, inverses: result.inverses });
    return { doc: result.doc, in: { n: entry.n, note, ops: entry.ops.length, lote: entry.ops } };
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
          // carpeta sin documento: se ignora
        }
      }
      return list;
    },

    /** Crea un documento vacío o, con `copiarDe`, una copia de otro (sin su historial). */
    /** @param {string} id @param {Record<string, any>} meta @param {{ origin: string, note?: string, copyFrom?: string }} options */
    create: (id, meta, { origin, note, copyFrom }) =>
      enqueue(async () => {
        try {
          await fs.access(filePath(id, 'document.json'));
          throw new Error(`Ya existe el documento "${id}"`);
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
        // La copia lleva también los archivos de sus imágenes.
        if (copyFrom && (await listAssets(copyFrom)).length) await fs.cp(path.dirname(assetPath(copyFrom, 'x.png')), path.dirname(assetPath(id, 'x.png')), { recursive: true });
        await write(id, doc);
        await record(id, { origin, kind: 'create', note: note ?? 'document created', ops: [], inverses: [] });
        return doc;
      }),

    /** Aplica un lote sobre la versión en disco. Devuelve el documento y los avisos. */
    applyOps: (id, ops, { origin, note }) =>
      enqueue(async () => {
        const { doc, inverses, warnings } = applyOperations(await read(id), ops, schema);
        await write(id, doc);
        await record(id, { origin, kind: 'change', note: note || `${ops.length} ${ops.length === 1 ? 'change' : 'changes'}`, ops, inverses });
        return { doc, warnings: [...warnings, ...(await assetWarnings(id, doc, ops))] };
      }),

    /** Borra el documento y su historial. No se puede deshacer. */
    delete: (id) =>
      enqueue(async () => {
        await read(id);
        await fs.rm(path.dirname(filePath(id, 'document.json')), { recursive: true });
      }),

    /**
     * Guarda un archivo de imagen en assets/ y devuelve { src, ancho, alto, formato, reusado }. El nombre sale del
     * original; si ya hay un archivo con los mismos bytes, se reusa ese, y si el nombre está ocupado por otro, se le
     * agrega _2, _3...
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

    /** Bytes y tipo MIME de un asset. */
    async readAsset(id, src) {
      try {
        return { bytes: await fs.readFile(assetPath(id, src)), mime: assetMime(src) };
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`The document "${id}" has no asset "${src}"`);
        throw e;
      }
    },

    listAssets,

    /** Los archivos de las imágenes que usa el documento (src → bytes), para dibujarlo fuera del navegador. */
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

    /** Últimas entradas, de la más vieja a la más nueva, más qué puede deshacer/rehacer cada origen. */
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
