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

  async function revertir(id, origen, tipo) {
    const entradas = await historial(id);
    const pila = pilas(entradas, origen)[tipo === 'deshacer' ? 'deshacer' : 'rehacer'];
    if (!pila.length) throw new Error(tipo === 'deshacer' ? 'No hay nada tuyo para deshacer' : 'No hay nada para rehacer');
    const entrada = entradas[pila.at(-1) - 1];
    let resultado;
    try {
      resultado = aplicarOperaciones(await leer(id), entrada.inversas, esquema);
    } catch (e) {
      throw new Error(`No se puede ${tipo}: el documento cambió después y ya no encaja.\n${e.message}`);
    }
    await escribir(id, resultado.doc);
    const nota = entrada.nota?.replace(/^(deshacer|rehacer): /, '') ?? '';
    await registrar(id, { origen, tipo, ref: entrada.n, nota: `${tipo}: ${nota}`, ops: entrada.inversas, inversas: resultado.inversas });
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
          nota ??= `copia de ${copiarDe}`;
        }
        const { errores } = validar(doc, esquema);
        if (errores.length) throw new ErrorDeValidacion(errores);
        await fs.mkdir(path.dirname(ruta(id, 'documento.json')), { recursive: true });
        await escribir(id, doc);
        await registrar(id, { origen, tipo: 'crear', nota: nota ?? 'documento creado', ops: [], inversas: [] });
        return doc;
      }),

    /** Aplica un lote sobre la versión en disco. Devuelve el documento y los avisos. */
    operar: (id, ops, { origen, nota }) =>
      enFila(async () => {
        const { doc, inversas, avisos } = aplicarOperaciones(await leer(id), ops, esquema);
        await escribir(id, doc);
        await registrar(id, { origen, tipo: 'cambio', nota: nota || `${ops.length} cambios`, ops, inversas });
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
