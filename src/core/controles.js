// Controles de un switch (como el «Create control» del editor): un param enum con una opción por variante, una pose
// por opción que pone esa variante en active y un driver con equals para cada una. Lo usan el editor y el MCP.

import { buscar } from './documento.js';

/** Nombre de param válido a partir de lo que escribió alguien ("Mouth shape" → "mouth_shape"). */
export function nombreDeControl(texto) {
  const base = String(texto ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return null;
  return /^[a-z]/.test(base) ? base : `param_${base}`;
}

/**
 * Lote para controlar un switch desde un param. `nombre`: id del param (por defecto <switch>_choice). Las opciones son
 * los ids de las variantes, sin el prefijo del switch si todas lo tienen (mouth_a → a). La opción inicial es la
 * variante que muestra el switch en el montaje. Devuelve { ops, param, opciones } o lanza si algo ya existe.
 */
export function opsDeControl(doc, switchId, nombre = null) {
  const sw = buscar(doc, switchId);
  if (sw?.type !== 'switch') throw new Error(`"${switchId}" is not a switch`);
  const variantes = doc.objects.filter((o) => o.parent === sw.id);
  if (!variantes.length) throw new Error(`switch ${sw.id} has no variants yet: put a drawing inside it for each one`);
  const param = nombreDeControl(nombre ?? `${sw.id}_choice`);
  if (!param) throw new Error(`"${nombre}" is not a valid control name: use lowercase letters, numbers and _`);
  const prefijo = `${sw.id}_`;
  const corto = variantes.every((v) => v.id.startsWith(prefijo) && v.id.length > prefijo.length);
  const opciones = variantes.map((v) => (corto ? v.id.slice(prefijo.length) : v.id));
  const visible = variantes.find((v) => v.id === sw.active) ?? variantes[0];
  const ops = [{ op: 'create', type: 'param', id: param, props: { kind: 'enum', options: opciones, initial: opciones[variantes.indexOf(visible)] } }];
  variantes.forEach((v, i) => {
    const pose = `${param}_${opciones[i]}`;
    ops.push({ op: 'create', type: 'pose', id: pose, props: { values: { [sw.id]: { active: v.id } } } });
    ops.push({ op: 'create', type: 'driver', id: `${pose}_driver`, props: { param, pose, equals: opciones[i] } });
  });
  const repetido = ops.find((o) => buscar(doc, o.id));
  if (repetido) throw new Error(`"${repetido.id}" already exists; choose another name for the control`);
  return { ops, param, opciones };
}
