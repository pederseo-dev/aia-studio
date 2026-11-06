// Migración al modelo de capa de huesos (Moho): los documentos de antes tenían los huesos en la raíz, en el marco del
// documento, y el dibujo enlazado desde cualquier lugar. Ahora los huesos viven dentro de un `skeleton`, que también
// contiene el dibujo que mueven. La conversión es determinista y no mueve nada en pantalla ni en las poses.
//
// - Si todo el dibujo enlazado está dentro de un mismo grupo de la raíz (por ejemplo `cat`), ese grupo se convierte
//   en el skeleton y los huesos pasan adentro, con sus valores llevados al marco del grupo (también los de las poses).
//   Si el grupo estaba enlazado a uno de los huesos, ese enlace pasa a sus hijos directos (un skeleton no puede
//   seguir a sus propios huesos), que es lo mismo que heredaban.
// - Si no (dibujo enlazado suelto en la raíz, en varios grupos, o un grupo que una pose mueve o que está espejado),
//   se crea un skeleton nuevo en la raíz, sin transformación, con los huesos y el tramo de la raíz que va del primer
//   al último dibujo enlazado (así el orden de dibujo no cambia).

import { buscar, esqueletoDe, hijos, subarbol, validar } from './documento.js';
import { leer } from './esquema.js';
import { CAMPOS_DE_POSE } from './esqueleto.js';
import { aplicar, invertir, matrizMundo } from './geometria.js';

const CAMPOS_DE_MARCO = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

/** Huesos raíz que todavía no están en un skeleton (los de un documento anterior al modelo de capa de huesos). */
export function huesosSueltos(doc) {
  return doc.objects.filter((o) => o.type === 'bone' && buscar(doc, o.parent)?.type !== 'bone' && !esqueletoDe(doc, o.id));
}

/**
 * Convierte el documento. Devuelve { doc, cambios } (cambios: frases para el historial, en inglés porque las ve el
 * usuario) o, si no hay nada que migrar, el mismo documento y cambios vacío.
 */
export function migrarAEsqueletos(original, esquema) {
  if (!huesosSueltos(original).length) return { doc: original, cambios: [] };
  const doc = structuredClone(original);
  const raices = huesosSueltos(doc);
  const huesos = new Set(raices.flatMap((h) => subarbol(doc, h.id)));
  const raizDe = (id) => {
    let o = buscar(doc, id);
    while (o.parent != null) o = buscar(doc, o.parent);
    return o.id;
  };
  const enlazados = doc.objects.filter((o) => huesos.has(o.bone) || o.vertices?.some((v) => huesos.has(v.bone)));
  const deArriba = [...new Set(enlazados.map((o) => raizDe(o.id)))];

  const grupo = deArriba.length === 1 && buscar(doc, deArriba[0]);
  const marco = grupo && grupo.type === 'group' && similitud(matrizMundo(doc, esquema, grupo.id));
  const posado = (id) => doc.objects.some((p) => p.type === 'pose' && CAMPOS_DE_MARCO.some((k) => p.values?.[id]?.[k] !== undefined));
  const cambios = [];
  let esqueleto;

  if (marco && !posado(grupo.id) && (!grupo.bone || huesos.has(grupo.bone))) {
    // El grupo pasa a ser la capa de huesos.
    esqueleto = grupo.id;
    grupo.type = 'skeleton';
    if (grupo.bone) {
      const heredado = grupo.bone;
      delete grupo.bone;
      for (const h of hijos(doc, grupo.id)) if ('bone' in (esquema.tipos.get(h.type)?.properties ?? {}) && !h.bone) h.bone = heredado;
      cambios.push(`${grupo.id}'s children that followed ${heredado} through it are now bound to it directly`);
    }
    for (const h of raices) llevarAlMarco(doc, esquema, h, marco);
    cambios.unshift(`Group ${grupo.id} is now a Skeleton and contains the bones`);
  } else {
    // Skeleton nuevo en la raíz, sin transformación: los huesos quedan con los mismos valores.
    esqueleto = 'skeleton';
    for (let n = 2; buscar(doc, esqueleto); n++) esqueleto = `skeleton_${n}`;
    const dibujoDeRaiz = hijos(doc, null).filter((o) => o.type !== 'bone' && !esquema.tipos.get(o.type)?.resource);
    const posiciones = deArriba.map((id) => dibujoDeRaiz.findIndex((o) => o.id === id)).filter((i) => i >= 0);
    const tramo = posiciones.length ? dibujoDeRaiz.slice(Math.min(...posiciones), Math.max(...posiciones) + 1) : [];
    const lugar = tramo.length ? doc.objects.indexOf(tramo[0]) : doc.objects.length;
    doc.objects.splice(lugar, 0, { id: esqueleto, type: 'skeleton', parent: null });
    for (const o of tramo) o.parent = esqueleto;
    cambios.push(`New Skeleton ${esqueleto} with the bones${tramo.length ? ` and ${tramo.map((o) => o.id).join(', ')}` : ''}`);
  }

  // Los huesos van adentro, al frente del skeleton (no se dibujan, así que no importa para el orden de dibujo), en el
  // mismo orden que tenían.
  const ordenados = doc.objects.filter((o) => huesos.has(o.id));
  doc.objects = doc.objects.filter((o) => !huesos.has(o.id));
  for (const h of raices) ordenados.find((o) => o.id === h.id).parent = esqueleto;
  const ultimo = Math.max(...subarbol(doc, esqueleto).map((id) => doc.objects.findIndex((o) => o.id === id)));
  doc.objects.splice(ultimo + 1, 0, ...ordenados);

  const { errores } = validar(doc, esquema);
  if (errores.length) throw new Error(`la migración dejó el documento inválido:\n${errores.join('\n')}`);
  return { doc, cambios };
}

/**
 * Si la matriz es una similitud (traslación, rotación y escala uniforme positiva), su rotación y escala; si no
 * (espejo o escala desigual con giro), null: no se puede expresar el hueso en ese marco sin deformarlo.
 */
function similitud(m) {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (a * d - b * c <= 0 || Math.abs(sx - sy) > 1e-9 || Math.abs(a * c + b * d) > 1e-9) return null;
  return { m, rotacion: (Math.atan2(b, a) * 180) / Math.PI, escala: sx };
}

/** Pasa los valores de un hueso raíz (montaje y poses) del marco del documento al del grupo. */
function llevarAlMarco(doc, esquema, hueso, { m, rotacion, escala }) {
  const inversa = invertir(m);
  const convertir = (valores, completos) => {
    const salida = {};
    if (valores.x !== undefined || valores.y !== undefined) {
      const [x, y] = aplicar(inversa, completos.x, completos.y);
      [salida.x, salida.y] = [r6(x), r6(y)];
    }
    if (valores.rotation !== undefined && rotacion) salida.rotation = r6(completos.rotation - rotacion);
    for (const k of ['scaleX', 'scaleY']) if (valores[k] !== undefined && escala !== 1) salida[k] = r6(completos[k] / escala);
    return salida;
  };
  const montaje = Object.fromEntries(CAMPOS_DE_POSE.map((k) => [k, leer(esquema, hueso, k)]));
  // En el montaje se escribe todo lo que el marco cambia (aunque estuviera en su valor por defecto).
  const fijos = { x: 1, y: 1, ...(rotacion ? { rotation: 1 } : {}), ...(escala !== 1 ? { scaleX: 1, scaleY: 1 } : {}) };
  Object.assign(hueso, convertir(fijos, montaje));
  // Los límites usan la misma referencia que rotation.
  for (const k of ['minAngle', 'maxAngle']) if (rotacion && hueso[k] != null) hueso[k] = r6(hueso[k] - rotacion);
  for (const pose of doc.objects.filter((p) => p.type === 'pose' && p.values?.[hueso.id])) {
    const valores = pose.values[hueso.id];
    Object.assign(valores, convertir(valores, { ...montaje, ...valores }));
  }
}

/**
 * Escenas de Animate con pistas de params (de antes de que los params fueran solo de Puppet, o un clip que pasó de
 * Puppet a Animate a mano): ya no validan y el documento no aceptaría ninguna operación. Se pasan a Puppet, que sí
 * anima params; así no se pierde ningún keyframe y el usuario decide (volver a Animate quitando esas pistas, o
 * dejarlo como clip). Devuelve { doc, cambios } como migrarAEsqueletos.
 */
export function migrarEscenasConParams(original, esquema) {
  const conParams = (clip) => Object.keys(clip.tracks ?? {}).some((id) => buscar(original, id)?.type === 'param');
  const escenas = original.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') !== 'puppet' && conParams(o));
  if (!escenas.length) return { doc: original, cambios: [] };
  const doc = structuredClone(original);
  const cambios = [];
  for (const { id } of escenas) {
    buscar(doc, id).usage = 'puppet';
    cambios.push(`Scene "${id}" animated parameters, which only Puppet clips can do: it is now a Puppet clip (nothing was lost). To use it as a scene again, delete its parameter tracks and set Usage to animate.`);
  }
  return { doc, cambios };
}
