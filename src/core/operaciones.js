// Motor de operaciones: la única forma de modificar un documento, igual para la IA y para el editor.
//
//   { op: 'create', type: 'rect', id: 'eye_l', parent: 'head', index?: 0, props?: { width: 20 } }
//   { op: 'set',    target: 'eye_l' | 'meta', props: { x: 10, fill: '#ffffff' } }
//   { op: 'unset',  target: 'eye_l' | 'meta', props: ['x'] }            ← vuelve al valor por defecto
//   { op: 'delete', target: 'head' }                                     ← borra también los hijos y suelta
//                                                                          las referencias a lo borrado
//   { op: 'move',   target: 'eye_l', parent?: 'face' | null, index?: 0 } ← reparentar y/o reordenar
//   { op: 'rename', target: 'eye_l', id: 'left_eye' }                    ← actualiza las referencias (y las poses)
//   { op: 'duplicate', target: 'arm_l', id?: 'arm_r', suffix?: 'copy', parent?, index?, props? }
//                                                     ← copia con sus hijos; los hijos reciben el sufijo
//
// `index` es la posición entre los hermanos en orden de dibujo: 0 = al fondo; sin index = al frente.

import { expandirDesdeHasta } from './esqueleto.js';
import { sugerir } from './esquema.js';
import { parsearD } from './trazado.js';
import { ErrorDeValidacion, ID, buscar, hijos, subarbol, validar } from './documento.js';

const ESTRUCTURA = new Set(['id', 'type', 'parent']);

/**
 * Aplica un lote de forma atómica: si una operación falla o el resultado no es válido, no cambia nada y lanza.
 * Devuelve el documento nuevo, las operaciones inversas (para deshacer) y los avisos nuevos.
 */
export function aplicarOperaciones(doc, ops, esquema) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('Se necesita una lista de operaciones no vacía');
  const siguiente = structuredClone(doc);
  const inversas = [];
  ops.forEach((op, i) => {
    try {
      inversas.unshift(...aplicarUna(siguiente, op, esquema));
    } catch (e) {
      throw new Error(`Operación ${i + 1} (${op?.op}): ${e.message}`);
    }
  });
  const { errores, avisos } = validar(siguiente, esquema);
  if (errores.length) throw new ErrorDeValidacion(errores);
  const previos = new Set(validar(doc, esquema).avisos);
  return { doc: siguiente, inversas, avisos: avisos.filter((a) => !previos.has(a)) };
}

/** Junta los `set` seguidos sobre el mismo objetivo en uno solo (el último valor gana). */
export function compactar(ops) {
  const resultado = [];
  for (const op of ops) {
    const anterior = resultado.at(-1);
    if (op.op === 'set' && anterior?.op === 'set' && anterior.target === op.target) {
      resultado[resultado.length - 1] = { ...anterior, props: { ...anterior.props, ...op.props } };
    } else {
      resultado.push(op);
    }
  }
  return resultado;
}

/** Resumen corto de un lote para mostrar: "head.x, head.rotation, crear eye_l". */
export function resumirOperaciones(ops) {
  const partes = [];
  for (const op of ops) {
    if (op.op === 'set') partes.push(...Object.keys(op.props).map((p) => `${op.target}.${p}`));
    else if (op.op === 'unset') partes.push(...op.props.map((p) => `${op.target}.${p} (por defecto)`));
    else if (op.op === 'create') partes.push(`crear ${op.id}`);
    else if (op.op === 'rename') partes.push(`renombrar ${op.target} → ${op.id}`);
    else if (op.op === 'duplicate') partes.push(`duplicar ${op.target}`);
    else if (op.op === 'delete') partes.push(`borrar ${op.target}`);
    else if (op.op === 'move') partes.push(`mover ${op.target}`);
    else partes.push(op.op);
  }
  return [...new Set(partes)];
}

function objetivo(doc, id) {
  const obj = buscar(doc, id);
  if (!obj) throw new Error(`no existe el objeto "${id}".${sugerir(id, doc.objects.map((o) => o.id))}`);
  return obj;
}

function contenedor(doc, id, esquema) {
  if (id == null) return null;
  const padre = objetivo(doc, id);
  if (!esquema.tipos.get(padre.type)?.container) throw new Error(`"${id}" es un ${padre.type} y no puede tener hijos (usa un group)`);
  return id;
}

/** Inserta obj en la lista plana para que quede en la posición `index` entre los hijos de `padre`. */
function insertar(doc, obj, padre, index) {
  const hermanos = hijos(doc, padre);
  const i = Math.max(0, Math.min(index ?? hermanos.length, hermanos.length));
  let pos;
  if (i < hermanos.length) pos = doc.objects.indexOf(hermanos[i]);
  // Al frente: después de todo el subárbol del último hermano, para que la lista plana siga ordenada por ramas.
  else if (hermanos.length) pos = Math.max(...subarbol(doc, hermanos.at(-1).id).map((id) => doc.objects.findIndex((o) => o.id === id))) + 1;
  else pos = padre == null ? doc.objects.length : doc.objects.indexOf(buscar(doc, padre)) + 1;
  doc.objects.splice(pos, 0, obj);
}

/** Azúcar para la IA: un path acepta `d` (trazado SVG de un solo subtrazado) y se guarda como vértices. */
function expandirD(tipo, props) {
  if (props?.d === undefined) return props;
  if (!tipo?.properties.vertices) throw new Error(`"d" solo sirve en tipos con vértices (path), no en ${tipo?.name ?? 'meta'}`);
  const subtrazados = parsearD(props.d);
  if (subtrazados.length !== 1) throw new Error(`d tiene ${subtrazados.length} subtrazados; crea un path por cada uno`);
  const { d, ...resto } = props;
  return { closed: subtrazados[0].closed, ...resto, vertices: subtrazados[0].vertices };
}

/**
 * Rehace los valores de una pose cambiando ids: los de los objetos (claves) y los que son referencias (el hijo
 * activo de un switch). `cambiar(id)` devuelve el id nuevo, o null para quitarlo.
 */
function mapearPose(doc, esquema, valores, cambiar) {
  const resultado = {};
  for (const [id, campos] of Object.entries(valores)) {
    const nuevo = cambiar(id);
    if (nuevo == null) continue;
    const tipo = esquema.tipos.get(buscar(doc, nuevo)?.type ?? buscar(doc, id)?.type);
    const limpios = {};
    for (const [k, v] of Object.entries(campos)) {
      if (tipo?.properties[k]?.type !== 'ref' || v == null) limpios[k] = v;
      else if (cambiar(v) != null) limpios[k] = cambiar(v);
    }
    if (Object.keys(limpios).length) resultado[nuevo] = limpios;
  }
  return resultado;
}

/** Azúcar para la IA: dentro de una pose, un path también acepta `d` (se guarda como vértices, para el morph). */
function expandirPose(doc, esquema, tipo, props) {
  if (tipo !== 'pose' || !props?.values || typeof props.values !== 'object') return props;
  const values = {};
  for (const [id, campos] of Object.entries(props.values)) {
    const destino = buscar(doc, id);
    if (campos?.d === undefined || !destino) {
      values[id] = campos;
      continue;
    }
    const { d, ...resto } = expandirD(esquema.tipos.get(destino.type), campos);
    delete resto.closed; // si es cerrado o abierto lo decide el montaje
    values[id] = resto;
  }
  return { ...props, values };
}

/** Azúcar para la IA: un bone acepta `from` y `to` ([x, y] en el documento) en vez de x, y, rotation y length. */
function expandirHueso(doc, esquema, tipo, padre, props, actual) {
  if (props?.from === undefined && props?.to === undefined) return props;
  if (tipo !== 'bone') throw new Error(`"from"/"to" solo sirven en huesos (bone), no en ${tipo}`);
  return expandirDesdeHasta(doc, esquema, padre, props, actual);
}

function comprobarProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('props debe ser un objeto { propiedad: valor }');
  for (const [k, v] of Object.entries(props)) {
    if (ESTRUCTURA.has(k)) throw new Error(`"${k}" no se cambia con props (usa ${k === 'parent' ? 'move' : k === 'id' ? 'rename' : 'delete y create'})`);
    if (v === undefined) throw new Error(`falta el valor de "${k}"`);
  }
}

function aplicarUna(doc, op, esquema) {
  switch (op?.op) {
    case 'create': {
      const tipo = esquema.tipos.get(op.type);
      if (!tipo) throw new Error(`tipo desconocido "${op.type}".${sugerir(op.type, esquema.tipos.keys())} Tipos: ${[...esquema.tipos.keys()].join(', ')}`);
      if (!ID.test(op.id ?? '')) throw new Error(`id inválido "${op.id}": usa minúsculas, números y _, empezando con letra`);
      const repetido = buscar(doc, op.id);
      if (repetido) {
        // Los ids son únicos en todo el documento: dibujo, huesos y recursos comparten el espacio de nombres.
        const pista = op.type === 'bone' && repetido.type !== 'bone' ? ` Para huesos conviene el sufijo _bone: "${op.id}_bone".` : '';
        throw new Error(`ya existe un objeto "${op.id}" (${repetido.type}).${pista}`);
      }
      const padre = contenedor(doc, op.parent, esquema);
      if (op.props !== undefined) comprobarProps(op.props);
      const props = expandirPose(doc, esquema, op.type, expandirHueso(doc, esquema, op.type, padre, expandirD(tipo, op.props))) ?? {};
      insertar(doc, { id: op.id, type: op.type, parent: padre, ...structuredClone(props) }, padre, op.index);
      return [{ op: 'delete', target: op.id }];
    }

    case 'set': {
      comprobarProps(op.props);
      const obj = op.target === 'meta' ? doc.meta : objetivo(doc, op.target);
      const props = op.target === 'meta' ? op.props : expandirPose(doc, esquema, obj.type, expandirHueso(doc, esquema, obj.type, obj.parent ?? null, expandirD(esquema.tipos.get(obj.type), op.props), obj));
      const anteriores = {};
      const nuevas = [];
      for (const [k, v] of Object.entries(props)) {
        if (k in obj) anteriores[k] = obj[k];
        else nuevas.push(k);
        obj[k] = structuredClone(v);
      }
      const inversas = [];
      if (Object.keys(anteriores).length) inversas.push({ op: 'set', target: op.target, props: anteriores });
      if (nuevas.length) inversas.push({ op: 'unset', target: op.target, props: nuevas });
      return inversas;
    }

    case 'unset': {
      if (!Array.isArray(op.props)) throw new Error('props debe ser una lista de nombres de propiedad');
      const obj = op.target === 'meta' ? doc.meta : objetivo(doc, op.target);
      const anteriores = {};
      for (const k of op.props) {
        if (ESTRUCTURA.has(k)) throw new Error(`"${k}" no se puede quitar`);
        if (k in obj) {
          anteriores[k] = obj[k];
          delete obj[k];
        }
      }
      return Object.keys(anteriores).length ? [{ op: 'set', target: op.target, props: anteriores }] : [];
    }

    case 'delete': {
      objetivo(doc, op.target);
      const ids = new Set(subarbol(doc, op.target));
      const quitados = [];
      doc.objects.forEach((o, pos) => ids.has(o.id) && quitados.push({ pos, obj: o }));
      doc.objects = doc.objects.filter((o) => !ids.has(o.id));
      // Lo que apuntaba a algo borrado (un estilo, un hueso) se suelta; deshacer lo vuelve a enlazar.
      const reenlazar = [];
      for (const o of doc.objects) {
        const anteriores = {};
        for (const [prop, p] of Object.entries(esquema.tipos.get(o.type)?.properties ?? {})) {
          if (p.type === 'ref' && ids.has(o[prop])) {
            anteriores[prop] = o[prop];
            delete o[prop];
          } else if (p.type === 'vertices' && o[prop]?.some((v) => ids.has(v.bone))) {
            anteriores[prop] = structuredClone(o[prop]);
            o[prop] = o[prop].map(({ bone, ...v }) => (bone === undefined || ids.has(bone) ? v : { ...v, bone }));
          } else if (p.type === 'pose' && o[prop]) {
            const limpia = mapearPose(doc, esquema, o[prop], (id) => (ids.has(id) ? null : id));
            if (JSON.stringify(limpia) !== JSON.stringify(o[prop])) {
              anteriores[prop] = structuredClone(o[prop]);
              o[prop] = limpia;
            }
          }
        }
        if (Object.keys(anteriores).length) reenlazar.push({ op: 'set', target: o.id, props: anteriores });
      }
      return [{ op: '_restore', root: op.target, entries: quitados }, ...reenlazar];
    }

    case '_restore': {
      // Interna: inversa de delete. Devuelve los objetos a su posición exacta en la lista plana.
      for (const { pos, obj } of op.entries) doc.objects.splice(pos, 0, structuredClone(obj));
      return [{ op: 'delete', target: op.root }];
    }

    case 'move': {
      const obj = objetivo(doc, op.target);
      const padreAnterior = obj.parent ?? null;
      const indexAnterior = hijos(doc, padreAnterior).indexOf(obj);
      const padre = 'parent' in op ? contenedor(doc, op.parent, esquema) : padreAnterior;
      if (padre != null && subarbol(doc, obj.id).includes(padre)) throw new Error(`"${obj.id}" no puede quedar dentro de sí mismo o de un descendiente`);
      const posAnterior = doc.objects.indexOf(obj);
      doc.objects.splice(posAnterior, 1);
      obj.parent = padre;
      insertar(doc, obj, padre, op.index);
      return [{ op: '_place', target: obj.id, parent: padreAnterior, pos: posAnterior }];
    }

    case '_place': {
      // Interna: inversa de move. Devuelve el objeto a su posición exacta en la lista plana.
      const obj = objetivo(doc, op.target);
      const inversa = { op: '_place', target: obj.id, parent: obj.parent ?? null, pos: doc.objects.indexOf(obj) };
      doc.objects.splice(inversa.pos, 1);
      obj.parent = op.parent;
      doc.objects.splice(op.pos, 0, obj);
      return [inversa];
    }

    case 'rename': {
      const obj = objetivo(doc, op.target);
      if (!ID.test(op.id ?? '')) throw new Error(`id inválido "${op.id}": usa minúsculas, números y _, empezando con letra`);
      if (buscar(doc, op.id)) throw new Error(`ya existe un objeto "${op.id}"`);
      const anterior = obj.id;
      obj.id = op.id;
      for (const o of doc.objects) {
        if (o.parent === anterior) o.parent = op.id;
        const tipo = esquema.tipos.get(o.type);
        for (const [prop, p] of Object.entries(tipo?.properties ?? {})) {
          if (p.type === 'ref' && o[prop] === anterior) o[prop] = op.id;
          if (p.type === 'pose' && o[prop]) o[prop] = mapearPose(doc, esquema, o[prop], (id) => (id === anterior ? op.id : id));
          if (p.type === 'vertices' && o[prop]?.some((v) => v.bone === anterior)) o[prop] = o[prop].map((v) => (v.bone === anterior ? { ...v, bone: op.id } : v));
        }
      }
      return [{ op: 'rename', target: op.id, id: anterior }];
    }

    case 'duplicate': {
      const original = objetivo(doc, op.target);
      const sufijo = op.suffix ?? 'copy';
      if (!/^[a-z0-9_]+$/.test(sufijo)) throw new Error(`suffix inválido "${sufijo}": minúsculas, números y _`);
      const ids = subarbol(doc, original.id);
      const mapa = new Map(ids.map((id) => [id, id === original.id && op.id ? op.id : `${id}_${sufijo}`]));
      for (const nuevo of mapa.values()) {
        if (!ID.test(nuevo)) throw new Error(`id inválido "${nuevo}": usa minúsculas, números y _, empezando con letra`);
        if (buscar(doc, nuevo)) throw new Error(`ya existe un objeto "${nuevo}"; elige otro id o suffix`);
      }
      const padreOriginal = original.parent ?? null;
      const padre = 'parent' in op ? contenedor(doc, op.parent, esquema) : padreOriginal;
      if (op.props !== undefined) comprobarProps(op.props);

      // Copias en el orden de la lista plana, con padres y referencias apuntando a las copias.
      const copias = doc.objects
        .filter((o) => mapa.has(o.id))
        .map((o) => {
          const c = structuredClone(o);
          c.id = mapa.get(o.id);
          c.parent = o.id === original.id ? padre : mapa.get(o.parent);
          for (const [prop, p] of Object.entries(esquema.tipos.get(c.type)?.properties ?? {})) {
            if (p.type === 'ref' && mapa.has(c[prop])) c[prop] = mapa.get(c[prop]);
            // Al copiar un skeleton entero, los vértices enlazados por punto siguen a los huesos copiados.
            if (p.type === 'vertices' && c[prop]?.some((v) => mapa.has(v.bone))) c[prop] = c[prop].map((v) => (mapa.has(v.bone) ? { ...v, bone: mapa.get(v.bone) } : v));
          }
          return c;
        });
      const raiz = copias.find((c) => c.id === mapa.get(original.id));
      Object.assign(raiz, structuredClone(op.props ?? {}));
      // Por defecto queda justo delante del original.
      const index = op.index ?? (padre === padreOriginal ? hijos(doc, padre).indexOf(original) + 1 : undefined);
      insertar(doc, raiz, padre, index);
      let pos = doc.objects.indexOf(raiz) + 1;
      for (const c of copias) if (c !== raiz) doc.objects.splice(pos++, 0, c);
      return [{ op: 'delete', target: raiz.id }];
    }

    default:
      throw new Error(`operación desconocida "${op?.op}". Usa create, set, unset, delete, move, rename o duplicate`);
  }
}
