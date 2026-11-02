// Esquema: las definiciones de schema/*.json resueltas (herencia incluida). Es la fuente única de verdad de qué tipos
// existen y qué propiedades tienen; de aquí salen la validación, el inspector del editor y la guía para la IA.

import { erroresDeVertice } from './trazado.js';

const TIPOS_DE_PROPIEDAD = new Set(['number', 'string', 'boolean', 'color', 'enum', 'ref', 'vertices', 'stops']);
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** @param {object[]} defs contenido de schema/*.json */
export function crearEsquema(defs) {
  const porNombre = new Map(defs.map((d) => [d.name, d]));
  const resueltos = new Map();

  const resolver = (nombre, cadena = []) => {
    if (resueltos.has(nombre)) return resueltos.get(nombre);
    const def = porNombre.get(nombre);
    if (!def) throw new Error(`Esquema: el tipo "${cadena.at(-1)}" extiende un tipo inexistente "${nombre}"`);
    if (cadena.includes(nombre)) throw new Error(`Esquema: herencia circular en ${[...cadena, nombre].join(' → ')}`);
    const base = def.extends ? resolver(def.extends, [...cadena, nombre]) : null;
    for (const [prop, p] of Object.entries(def.properties ?? {})) {
      if (!TIPOS_DE_PROPIEDAD.has(p.type)) throw new Error(`Esquema: ${nombre}.${prop} tiene un tipo desconocido "${p.type}"`);
      if (p.type === 'enum' && !Array.isArray(p.values)) throw new Error(`Esquema: ${nombre}.${prop} es enum y necesita values`);
    }
    const tipo = {
      name: nombre,
      description: def.description ?? '',
      abstract: !!def.abstract,
      container: def.container ?? base?.container ?? false,
      // Recurso: vive en la raíz, no se dibuja y otros objetos lo usan por referencia (estilos, degradados).
      resource: def.resource ?? base?.resource ?? false,
      ancestros: base ? [base.name, ...base.ancestros] : [],
      properties: { ...base?.properties, ...def.properties },
    };
    resueltos.set(nombre, tipo);
    return tipo;
  };

  for (const d of defs) resolver(d.name);
  const meta = resueltos.get('meta');
  if (!meta) throw new Error('Esquema: falta schema/meta.json');
  const tipos = new Map([...resueltos].filter(([n, t]) => n !== 'meta' && !t.abstract));
  return { meta, tipos };
}

/** Devuelve un mensaje de error si el valor no sirve para la propiedad, o null si está bien. */
export function validarValor(p, valor) {
  if (valor === null) return p.nullable ? null : 'no puede ser null';
  switch (p.type) {
    case 'number':
      if (typeof valor !== 'number' || !Number.isFinite(valor)) return `debe ser un número (recibido ${JSON.stringify(valor)})`;
      if (p.integer && !Number.isInteger(valor)) return 'debe ser un entero';
      if (p.min != null && valor < p.min) return `debe ser ≥ ${p.min}`;
      if (p.max != null && valor > p.max) return `debe ser ≤ ${p.max}`;
      return null;
    case 'string':
      return typeof valor === 'string' ? null : 'debe ser texto';
    case 'boolean':
      return typeof valor === 'boolean' ? null : 'debe ser true o false';
    case 'color':
      return typeof valor === 'string' && COLOR.test(valor) ? null : `debe ser un color "#rrggbb" (recibido ${JSON.stringify(valor)})`;
    case 'enum':
      return p.values.includes(valor) ? null : `debe ser uno de: ${p.values.join(', ')}`;
    case 'ref':
      return typeof valor === 'string' ? null : 'debe ser el id de un objeto';
    case 'vertices': {
      if (!Array.isArray(valor)) return 'debe ser una lista de vértices';
      const errores = valor.flatMap((v, i) => erroresDeVertice(v).map((e) => `[${i}] ${e}`));
      return errores.length ? errores.slice(0, 5).join('; ') + (errores.length > 5 ? ` (y ${errores.length - 5} más)` : '') : null;
    }
    case 'stops': {
      if (!Array.isArray(valor) || !valor.length) return 'debe ser una lista de paradas [{ offset, color }]';
      for (const [i, s] of valor.entries()) {
        if (typeof s?.offset !== 'number' || s.offset < 0 || s.offset > 1) return `[${i}].offset debe ser un número de 0 a 1`;
        if (typeof s.color !== 'string' || !COLOR.test(s.color)) return `[${i}].color debe ser "#rrggbb"`;
        if (s.opacity !== undefined && (typeof s.opacity !== 'number' || s.opacity < 0 || s.opacity > 1)) return `[${i}].opacity debe ser de 0 a 1`;
        if (i && s.offset < valor[i - 1].offset) return 'las paradas deben ir en orden de offset';
      }
      return null;
    }
  }
  return 'tipo de propiedad desconocido';
}

/** Valor efectivo de una propiedad: el guardado o, si no está, el valor por defecto del esquema. */
export function leer(esquema, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  return (esquema.tipos.get(obj.type) ?? esquema.meta).properties[prop]?.default;
}

export function leerMeta(esquema, doc, prop) {
  return doc.meta[prop] !== undefined ? doc.meta[prop] : esquema.meta.properties[prop]?.default;
}

/** Sugerencia para nombres mal escritos: el más parecido a distancia ≤ 2, o uno que sea prefijo del otro. */
export function sugerir(valor, opciones) {
  let mejor = null;
  let distanciaMejor = 3;
  const a = String(valor).toLowerCase();
  for (const opcion of opciones) {
    const b = String(opcion).toLowerCase();
    const prefijo = Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
    const d = prefijo ? 1 : distancia(a, b);
    if (d < distanciaMejor) [mejor, distanciaMejor] = [opcion, d];
  }
  return mejor ? ` ¿Quisiste decir "${mejor}"?` : '';
}

function distancia(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = arriba;
    }
  }
  return fila[b.length];
}
