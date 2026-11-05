// Documentos en disco: personajes/<id>/documento.json y su historial (historial.jsonl).
// Lo usan el servidor del editor (origen "user") y el MCP (origen "ai"), así que los dos trabajan sobre los mismos
// archivos. Cada lote queda en el historial con su origen y sus inversas; deshacer y rehacer se calculan desde ahí,
// por origen: la IA deshace solo lo suyo y el usuario solo lo suyo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorDeValidacion, crearDocumento, validar } from '../src/core/documento.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';

export const CARPETA_PERSONAJES = fileURLToPath(new URL('../personajes/', import.meta.url));
const ID_DOCUMENTO = /^[a-z][a-z0-9_-]*$/;

// Operaciones que cambian la estructura de un objeto (no una propiedad suelta): tocan "todo" el objeto.
const ESTRUCTURALES = new Set(['create', 'delete', 'move', 'rename', 'duplicate', '_restore', '_place']);

const esObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// En una pose, "d" es azúcar para los vértices: tocar uno es tocar los otros.
const claveDePose = (objeto, prop) => `values.${objeto}.${prop === 'd' ? 'vertices' : prop}`;

/**
 * Cambios de un lote en los `values` de las poses, por (objeto, propiedad) y no la pose entera: así una pose que
 * editaron los dos orígenes en objetos distintos no bloquea el deshacer. Devuelve Map pose → { antes, despues,
 * claves } (antes = lo que restauran sus inversas; despues = lo que fijaron sus operaciones).
 */
function cambiosDePose(entrada) {
  const ultimo = (ops) => {
    const m = new Map();
    for (const op of ops ?? []) {
      if (op.op === 'set' && esObjeto(op.props?.values)) m.set(op.target, op.props.values);
      // Una pose que no tenía values: su inversa es un unset, que equivale a values vacío.
      else if (op.op === 'unset' && op.props?.includes('values')) m.set(op.target, {});
    }
    return m;
  };
  const despues = ultimo(entrada.ops);
  const antes = ultimo(entrada.inversas);
  const cambios = new Map();
  for (const pose of new Set([...despues.keys(), ...antes.keys()])) {
    const [a, d] = [antes.get(pose), despues.get(pose)];
    const claves = new Set();
    for (const objeto of new Set([...Object.keys(a ?? {}), ...Object.keys(d ?? {})])) {
      const [ca, cd] = [a?.[objeto] ?? {}, d?.[objeto] ?? {}];
      for (const prop of new Set([...Object.keys(ca), ...Object.keys(cd)])) {
        // Sin las dos versiones (por ejemplo, una pose que no tenía values) cuenta todo lo que se ve.
        if (!a || !d || JSON.stringify(ca[prop]) !== JSON.stringify(cd[prop])) claves.add(claveDePose(objeto, prop));
      }
    }
    cambios.set(pose, { antes: a, despues: d, claves });
  }
  return cambios;
}

/**
 * Las inversas de un lote, con los `values` de pose aplicados por clave sobre la pose como está ahora: deshacer un
 * cambio en un objeto de la pose no se lleva lo que el otro origen cambió después en otro objeto de la misma pose.
 */
function inversasPorClave(doc, entrada) {
  const cambios = cambiosDePose(entrada);
  if (!cambios.size) return entrada.inversas;
  return entrada.inversas.flatMap((op) => {
    const deValues = (op.op === 'set' && esObjeto(op.props?.values)) || (op.op === 'unset' && op.props?.includes('values'));
    const cambio = deValues && cambios.get(op.target);
    const actual = cambio && doc.objects.find((o) => o.id === op.target);
    if (!cambio?.antes || !cambio.despues || actual?.type !== 'pose') return op;
    const values = structuredClone(actual.values ?? {});
    for (const clave of cambio.claves) {
      const [, objeto, prop] = clave.split('.');
      const viejo = cambio.antes[objeto]?.[prop];
      if (viejo === undefined) {
        if (values[objeto]) delete values[objeto][prop];
        if (values[objeto] && !Object.keys(values[objeto]).length) delete values[objeto];
      } else (values[objeto] ??= {})[prop] = structuredClone(viejo);
    }
    if (op.op === 'set') return [{ ...op, props: { ...op.props, values } }];
    const resto = op.props.filter((k) => k !== 'values');
    return [{ op: 'set', target: op.target, props: { values } }, ...(resto.length ? [{ ...op, props: resto }] : [])];
  });
}

/** (id, propiedad) que toca un lote, con sus inversas: Map id → Set de propiedades ("*" = el objeto entero). */
function tocados(entrada) {
  const mapa = new Map();
  const sumar = (id, prop) => id != null && (mapa.get(id) ?? mapa.set(id, new Set()).get(id)).add(prop);
  const poses = cambiosDePose(entrada);
  for (const [pose, { claves }] of poses) claves.forEach((k) => sumar(pose, k));
  for (const op of [...(entrada.ops ?? []), ...(entrada.inversas ?? [])]) {
    if (op.op === 'set') Object.keys(op.props ?? {}).forEach((k) => !(k === 'values' && poses.has(op.target)) && sumar(op.target, k));
    else if (op.op === 'unset') (op.props ?? []).forEach((k) => !(k === 'values' && poses.has(op.target)) && sumar(op.target, k));
    else if (ESTRUCTURALES.has(op.op)) {
      sumar(op.target ?? op.id, '*');
      if (op.op === 'rename' || op.op === 'create') sumar(op.id, '*');
      // Meter algo en un contenedor también lo toca: deshacer la creación del contenedor se llevaría ese hijo.
      if (op.parent != null) sumar(op.parent, 'children');
      for (const { obj } of op.entries ?? []) sumar(obj?.id, '*');
    }
  }
  return mapa;
}

/** ¿Dos propiedades se pisan? Iguales, o una contiene a la otra ("values" contiene a "values.mouth.x"). */
const sePisan = (p, q) => p === q || p.startsWith(`${q}.`) || q.startsWith(`${p}.`);

/** Nombres "id.prop" (o "id", si alguno cambió el objeto entero) que dos lotes tocan en común. */
function comunes(a, b) {
  const salida = new Set();
  for (const [id, propsA] of a) {
    const propsB = b.get(id);
    if (!propsB) continue;
    if (propsB.has('*')) salida.add(id);
    else for (const p of propsB) if (propsA.has('*') || [...propsA].some((q) => sePisan(p, q))) salida.add(`${id}.${p}`);
  }
  return salida;
}

export function crearAlmacen({ esquema, carpeta = CARPETA_PERSONAJES }) {
  // Las escrituras de este proceso van en fila para no pisarse entre sí.
  let fila = Promise.resolve();
  const enFila = (fn) => (fila = fila.then(fn, fn));

  const ruta = (id, archivo) => {
    if (!ID_DOCUMENTO.test(id ?? '')) throw new Error(`id de documento inválido "${id}": minúsculas, números, _ y -`);
    return path.join(carpeta, id, archivo);
  };

  async function leer(id) {
    try {
      return JSON.parse(await fs.readFile(ruta(id, 'documento.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`No existe el documento "${id}"`);
      throw e;
    }
  }

  async function escribir(id, doc) {
    // Temporal + rename: nadie lee nunca un archivo a medio escribir.
    const destino = ruta(id, 'documento.json');
    await fs.writeFile(destino + '.tmp', JSON.stringify(doc, null, 2) + '\n');
    await fs.rename(destino + '.tmp', destino);
  }

  async function historial(id) {
    try {
      const texto = await fs.readFile(ruta(id, 'historial.jsonl'), 'utf8');
      return texto.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async function registrar(id, entrada) {
    const n = (await historial(id)).length + 1;
    const completa = { n, fecha: new Date().toISOString(), ...entrada };
    await fs.appendFile(ruta(id, 'historial.jsonl'), JSON.stringify(completa) + '\n');
    return completa;
  }

  // Pilas de deshacer/rehacer de un origen, reconstruidas desde el historial.
  function pilas(entradas, origen) {
    const deshacer = [];
    const rehacer = [];
    for (const e of entradas) {
      // Una migración del formato (de cualquier origen) corta las pilas: las inversas de antes ya no encajan.
      if (e.tipo === 'migracion') {
        deshacer.length = 0;
        rehacer.length = 0;
        continue;
      }
      if (e.origen !== origen) continue;
      if (e.tipo === 'cambio') {
        deshacer.push(e.n);
        rehacer.length = 0;
      } else if (e.tipo === 'deshacer') {
        deshacer.pop();
        rehacer.push(e.n);
      } else if (e.tipo === 'rehacer') {
        rehacer.pop();
        deshacer.push(e.n);
      }
    }
    return { deshacer, rehacer };
  }

  /**
   * Lotes de otro origen posteriores a `entrada` que siguen en pie y tocan alguna de sus mismas (id, propiedad):
   * deshacerla o rehacerla los pisaría. Un cambio que su origen ya deshizo (o un deshacer que ya rehizo) se cancela y
   * no cuenta. Devuelve [{ quien, n, nota, props: ["r.x", ...] }].
   */
  function choquesConOtros(entradas, entrada) {
    const propias = tocados(entrada);
    const enPie = new Map(); // origen → Map(n → entrada)
    for (const e of entradas.slice(entrada.n)) {
      if (e.tipo === 'migracion') return []; // la migración ya cortó las pilas
      if (e.origen === entrada.origen || !['cambio', 'deshacer', 'rehacer'].includes(e.tipo)) continue;
      const delOrigen = enPie.get(e.origen) ?? enPie.set(e.origen, new Map()).get(e.origen);
      // Deshacer un lote (o rehacer un deshacer) que también es posterior: se anulan entre sí.
      if (e.tipo !== 'cambio' && delOrigen.has(e.ref)) delOrigen.delete(e.ref);
      else delOrigen.set(e.n, e);
    }
    const choques = [];
    for (const delOrigen of enPie.values()) {
      for (const e of delOrigen.values()) {
        const props = [...comunes(propias, tocados(e))];
        if (props.length) choques.push({ quien: e.origen, n: e.n, nota: e.nota ?? '', props });
      }
    }
    return choques;
  }

  async function revertir(id, origen, tipo) {
    const entradas = await historial(id);
    const pila = pilas(entradas, origen)[tipo === 'deshacer' ? 'deshacer' : 'rehacer'];
    if (!pila.length) throw new Error(tipo === 'deshacer' ? 'Nothing of yours to undo' : 'Nothing to redo');
    const entrada = entradas[pila.at(-1) - 1];
    const choques = choquesConOtros(entradas, entrada);
    if (choques.length) {
      const verbo = tipo === 'deshacer' ? 'undo' : 'redo';
      const detalle = choques.map(({ quien, n, nota, props }) => `${props.join(', ')} (changed by ${quien === 'user' ? 'the user' : quien === 'ai' ? 'the AI' : quien} in #${n} "${nota}")`).join('; ');
      throw new Error(`Can't ${verbo} #${entrada.n} "${entrada.nota ?? ''}": it would overwrite later changes from another origin: ${detalle}. Change those properties by hand instead, or ask whoever made them.`);
    }
    let resultado;
    const actual = await leer(id);
    const inversas = inversasPorClave(actual, entrada);
    try {
      resultado = aplicarOperaciones(actual, inversas, esquema);
    } catch (e) {
      throw new Error(`Can't ${tipo === 'deshacer' ? 'undo' : 'redo'}: the document changed afterwards and it no longer fits.\n${e.message}`);
    }
    await escribir(id, resultado.doc);
    // La nota la ve el usuario en el historial: en inglés (los prefijos viejos en español también se limpian).
    const nota = entrada.nota?.replace(/^(deshacer|rehacer|undo|redo): /, '') ?? '';
    await registrar(id, { origen, tipo, ref: entrada.n, nota: `${tipo === 'deshacer' ? 'undo' : 'redo'}: ${nota}`, ops: inversas, inversas: resultado.inversas });
    return { doc: resultado.doc, entrada: { n: entrada.n, nota, ops: entrada.ops.length, lote: entrada.ops } };
  }

  return {
    leer,

    async listar() {
      await fs.mkdir(carpeta, { recursive: true });
      const carpetas = await fs.readdir(carpeta, { withFileTypes: true });
      const ids = carpetas.filter((c) => c.isDirectory() && ID_DOCUMENTO.test(c.name)).map((c) => c.name).sort();
      const lista = [];
      for (const id of ids) {
        try {
          lista.push({ id, name: (await leer(id)).meta.name ?? id });
        } catch {
          // carpeta sin documento: se ignora
        }
      }
      return lista;
    },

    /** Crea un documento vacío o, con `copiarDe`, una copia de otro (sin su historial). */
    crear: (id, meta, { origen, nota, copiarDe }) =>
      enFila(async () => {
        try {
          await fs.access(ruta(id, 'documento.json'));
          throw new Error(`Ya existe el documento "${id}"`);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        let doc = crearDocumento(meta);
        if (copiarDe) {
          const base = await leer(copiarDe);
          doc = { ...base, meta: { ...base.meta, ...meta } };
          nota ??= `copy of ${copiarDe}`;
        }
        const { errores } = validar(doc, esquema);
        if (errores.length) throw new ErrorDeValidacion(errores);
        await fs.mkdir(path.dirname(ruta(id, 'documento.json')), { recursive: true });
        await escribir(id, doc);
        await registrar(id, { origen, tipo: 'crear', nota: nota ?? 'document created', ops: [], inversas: [] });
        return doc;
      }),

    /** Aplica un lote sobre la versión en disco. Devuelve el documento y los avisos. */
    operar: (id, ops, { origen, nota }) =>
      enFila(async () => {
        const { doc, inversas, avisos } = aplicarOperaciones(await leer(id), ops, esquema);
        await escribir(id, doc);
        await registrar(id, { origen, tipo: 'cambio', nota: nota || `${ops.length} ${ops.length === 1 ? 'change' : 'changes'}`, ops, inversas });
        return { doc, avisos };
      }),

    /** Borra el documento y su historial. No se puede deshacer. */
    eliminar: (id) =>
      enFila(async () => {
        await leer(id);
        await fs.rm(path.dirname(ruta(id, 'documento.json')), { recursive: true });
      }),

    deshacer: (id, origen) => enFila(() => revertir(id, origen, 'deshacer')),
    rehacer: (id, origen) => enFila(() => revertir(id, origen, 'rehacer')),

    /** Últimas entradas, de la más vieja a la más nueva, más qué puede deshacer/rehacer cada origen. */
    async historial(id, limite = 50) {
      const entradas = await historial(id);
      const disponible = (origen) => {
        const p = pilas(entradas, origen);
        return { deshacer: p.deshacer.length > 0, rehacer: p.rehacer.length > 0 };
      };
      return { entradas: entradas.slice(-limite), ai: disponible('ai'), user: disponible('user') };
    },
  };
}
