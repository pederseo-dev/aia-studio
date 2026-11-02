// Motor de operaciones: la única forma de modificar un personaje, tanto para la IA como para el editor.
//
// Rutas legibles: "rig.bones.head.rotation". Dentro de una lista, el segmento es el id del elemento.
//   { op: 'set',    path: 'rig.bones.head.rotation', value: 10 }
//   { op: 'add',    path: 'rig.bones', value: { id: 'arm_l', parent: 'torso', x: 0, y: 0 } }
//   { op: 'remove', path: 'rig.bones.arm_l' }

import { validar, ErrorDeValidacion } from './documento.js';

function buscar(nodo, segmento) {
  return Array.isArray(nodo) ? nodo.find((x) => x?.id === segmento) : nodo?.[segmento];
}

function ubicar(doc, path) {
  const segmentos = String(path).split('.');
  if (segmentos.some((s) => !s)) throw new Error(`Ruta inválida: "${path}"`);
  let padre = doc;
  for (const s of segmentos.slice(0, -1)) {
    padre = buscar(padre, s);
    if (padre == null || typeof padre !== 'object') throw new Error(`Ruta inexistente: "${path}"`);
  }
  return { padre, clave: segmentos.at(-1) };
}

function aplicarUna(doc, op) {
  const { padre, clave } = ubicar(doc, op.path);
  switch (op.op) {
    case 'set': {
      if (Array.isArray(padre)) throw new Error(`set no reemplaza elementos de una lista, usa remove y add: "${op.path}"`);
      if (op.value === undefined) throw new Error(`set necesita value: "${op.path}"`);
      const anterior = padre[clave];
      padre[clave] = structuredClone(op.value);
      return anterior === undefined ? { op: 'remove', path: op.path } : { op: 'set', path: op.path, value: anterior };
    }
    case 'add': {
      const lista = buscar(padre, clave);
      if (!Array.isArray(lista)) throw new Error(`add necesita la ruta de una lista: "${op.path}"`);
      if (lista.some((x) => x?.id === op.value?.id)) throw new Error(`Ya existe "${op.value?.id}" en ${op.path}`);
      lista.splice(op.index ?? lista.length, 0, structuredClone(op.value));
      return { op: 'remove', path: `${op.path}.${op.value?.id}` };
    }
    case 'remove': {
      if (!Array.isArray(padre)) {
        if (!(clave in padre)) throw new Error(`No existe: "${op.path}"`);
        const anterior = padre[clave];
        delete padre[clave];
        return { op: 'set', path: op.path, value: anterior };
      }
      const i = padre.findIndex((x) => x?.id === clave);
      if (i < 0) throw new Error(`No existe: "${op.path}"`);
      const [item] = padre.splice(i, 1);
      return { op: 'add', path: op.path.split('.').slice(0, -1).join('.'), value: item, index: i };
    }
    default:
      throw new Error(`Operación desconocida: "${op.op}" (usa set, add o remove)`);
  }
}

/**
 * Aplica un lote de operaciones de forma atómica: o se aplican todas y el resultado es válido, o lanza.
 * Devuelve el documento nuevo y las operaciones inversas, que sirven para deshacer.
 */
export function aplicarOperaciones(doc, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('Se necesita una lista de operaciones no vacía');
  const siguiente = structuredClone(doc);
  const inversas = [];
  for (const op of ops) inversas.unshift(aplicarUna(siguiente, op));
  const errores = validar(siguiente);
  if (errores.length) throw new ErrorDeValidacion(errores);
  return { doc: siguiente, inversas };
}
