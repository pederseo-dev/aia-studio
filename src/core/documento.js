// Formato del personaje: validación y utilidades compartidas por navegador y Node.

export const FORMATO = 'aia/0.1';

const ID = /^[a-z][a-z0-9_]*$/;
// Un personaje es texto que escriben la IA y el usuario: no se permite nada ejecutable.
const SVG_PROHIBIDO = /<script|<foreignObject|\son\w+\s*=|javascript:/i;

// Propiedades que un driver puede mover, por colección.
export const DESTINOS = {
  bones: ['x', 'y', 'rotation', 'scaleX', 'scaleY'],
  parts: ['opacity'],
  slots: ['active'],
};

export class ErrorDeValidacion extends Error {
  constructor(errores) {
    super(errores.join('\n'));
    this.errores = errores;
  }
}

/** "bones.head.rotation" → { coleccion: 'bones', id: 'head', prop: 'rotation' } */
export function leerDestino(target) {
  const [coleccion, id, prop, ...resto] = String(target).split('.');
  if (resto.length || !DESTINOS[coleccion]?.includes(prop)) return null;
  return { coleccion, id, prop };
}

/** Devuelve los huesos ordenados de padre a hijo. Lanza si hay ciclos o padres inexistentes. */
export function ordenarHuesos(bones) {
  const porId = new Map(bones.map((b) => [b.id, b]));
  const estado = new Map();
  const orden = [];
  const visitar = (b) => {
    if (estado.get(b.id) === 'listo') return;
    if (estado.get(b.id) === 'visitando') throw new Error(`Ciclo de huesos en "${b.id}"`);
    estado.set(b.id, 'visitando');
    if (b.parent != null) {
      const padre = porId.get(b.parent);
      if (!padre) throw new Error(`El hueso "${b.id}" tiene un padre inexistente: "${b.parent}"`);
      visitar(padre);
    }
    estado.set(b.id, 'listo');
    orden.push(b);
  };
  bones.forEach(visitar);
  return orden;
}

/** Devuelve una lista de errores legibles; vacía si el documento es válido. */
export function validar(doc) {
  const errores = [];
  if (doc?.format !== FORMATO) errores.push(`format debe ser "${FORMATO}"`);
  if (!(doc?.canvas?.width > 0 && doc?.canvas?.height > 0)) errores.push('canvas necesita width y height positivos');

  const rig = doc?.rig ?? {};
  const listas = { bones: rig.bones, parts: rig.parts, slots: rig.slots, params: rig.params, drivers: doc?.drivers };
  for (const [nombre, lista] of Object.entries(listas)) {
    if (!Array.isArray(lista)) {
      errores.push(`falta la lista ${nombre}`);
      continue;
    }
    const vistos = new Set();
    for (const item of lista) {
      if (!ID.test(item?.id ?? '')) errores.push(`${nombre}: id inválido "${item?.id}" (minúsculas, números y _; empieza con letra)`);
      else if (vistos.has(item.id)) errores.push(`${nombre}: id repetido "${item.id}"`);
      vistos.add(item?.id);
    }
  }
  if (errores.length) return errores;

  try {
    ordenarHuesos(rig.bones);
  } catch (e) {
    errores.push(e.message);
  }

  const huesos = new Set(rig.bones.map((b) => b.id));
  for (const d of [...rig.parts, ...rig.slots]) {
    if (!huesos.has(d.bone)) errores.push(`"${d.id}" está pegado a un hueso inexistente: "${d.bone}"`);
  }
  for (const p of rig.parts) {
    if (typeof p.svg !== 'string') errores.push(`parts.${p.id}: falta svg`);
    else if (SVG_PROHIBIDO.test(p.svg)) errores.push(`parts.${p.id}: el svg no puede tener scripts ni eventos`);
  }
  for (const s of rig.slots) {
    const opciones = s.options && typeof s.options === 'object' ? Object.entries(s.options) : [];
    if (!opciones.length) errores.push(`slots.${s.id}: necesita al menos una opción en options`);
    for (const [nombre, svg] of opciones) {
      if (typeof svg !== 'string') errores.push(`slots.${s.id}.options.${nombre}: debe ser texto svg`);
      else if (SVG_PROHIBIDO.test(svg)) errores.push(`slots.${s.id}.options.${nombre}: el svg no puede tener scripts ni eventos`);
    }
    if (opciones.length && !(s.active in s.options)) errores.push(`slots.${s.id}: active "${s.active}" no está en options`);
  }

  const params = new Set();
  for (const p of rig.params) {
    params.add(p.id);
    const [min, max] = p.range ?? [];
    if (!(typeof min === 'number' && typeof max === 'number' && min < max)) errores.push(`params.${p.id}: range debe ser [min, max] con min < max`);
  }

  for (const d of doc.drivers) {
    if (!params.has(d.param)) errores.push(`drivers.${d.id}: param inexistente "${d.param}"`);
    const destino = leerDestino(d.target);
    const coleccion = destino && (destino.coleccion === 'bones' ? rig.bones : destino.coleccion === 'parts' ? rig.parts : rig.slots);
    const objetivo = coleccion?.find((x) => x.id === destino.id);
    if (!objetivo) {
      errores.push(`drivers.${d.id}: target inválido "${d.target}"`);
      continue;
    }
    if (destino.prop === 'active') {
      if (!Array.isArray(d.steps) || !d.steps.every((s) => typeof s[0] === 'number' && s[1] in objetivo.options)) {
        errores.push(`drivers.${d.id}: un slot se mueve con steps: [[umbral, opción], ...] y opciones existentes`);
      }
    } else {
      const ok = Array.isArray(d.in) && Array.isArray(d.out) && d.in.length >= 2 && d.in.length === d.out.length
        && d.in.every((v, i) => typeof v === 'number' && typeof d.out[i] === 'number' && (i === 0 || v > d.in[i - 1]));
      if (!ok) errores.push(`drivers.${d.id}: in y out deben ser listas de números del mismo largo (≥2) con in creciente`);
    }
  }
  return errores;
}
