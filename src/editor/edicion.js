// Qué se edita y qué se ve en el editor, derivado del estado: la pose o el clip abiertos (en el tiempo del playhead),
// la mezcla de los params, la variante de cada switch, y el lote que escribe en la pose o el clip abiertos. Lo usan
// el lienzo, el inspector, la timeline y las herramientas; no dibuja nada.

import { buscar } from '../core/documento.js';
import { opsParaClavesEnClip, poseDeClip } from '../core/animacion.js';
import { mezclarPoses, opsParaFijarPose } from '../core/mezcla.js';
import { ejecutar, esquema, estado } from './estado.js';

/**
 * La pose que se está editando en el documento indicado, o null. Con un clip abierto, es lo que se ve en el tiempo
 * del playhead (con el id del clip, para que los cambios vayan a sus keyframes).
 */
export function poseActiva(doc = estado.doc) {
  // Con Live encendido no se edita nada: no hay pose ni clip que reciba cambios.
  if (estado.vivo) return null;
  const p = estado.pose && buscar(doc, estado.pose);
  if (p?.type === 'animation') return { ...poseDeClip(doc, esquema, p, estado.tiempo, estado.params ?? {}), id: p.id };
  return p?.type === 'pose' ? p : null;
}

/** Cómo se nombra en el historial lo que se edita: «pose happy» o «clip wave @ 0.5s». */
export function nombreDeEdicion(id = estado.pose) {
  return buscar(estado.doc, id)?.type === 'animation' ? `clip ${id} @ ${+estado.tiempo.toFixed(3)}s` : `pose ${id}`;
}

/** El clip abierto (animation), o null. */
export function clipAbierto(doc = estado.doc) {
  const p = estado.pose && doc && buscar(doc, estado.pose);
  return p?.type === 'animation' ? p : null;
}

/** Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o null (el montaje). */
export function poseVista(doc = estado.doc) {
  if (estado.vivo) return estado.poseViva;
  return poseActiva(doc) ?? (estado.params ? mezclarPoses(doc, esquema, estado.params) : null);
}

/**
 * Lote que fija propiedades de un objeto dentro de una pose (conserva lo demás; undefined quita la propiedad). En un
 * clip, cada propiedad queda como keyframe en el tiempo del playhead (autokey); undefined quita ese keyframe. La
 * lógica está en el núcleo, la misma que usa el MCP.
 */
export function opsDePose(doc, poseId, id, campos) {
  if (buscar(doc, poseId)?.type === 'animation') return opsParaClavesEnClip(doc, esquema, poseId, id, campos, estado.tiempo, estado.params ?? {});
  return opsParaFijarPose(doc, poseId, { [id]: campos });
}

/** Variante que muestra un switch: la de la pose que se edita, si la fija; si no, la del montaje (o la primera). */
export function varianteDe(doc, sw) {
  const hijos = doc.objects.filter((o) => o.parent === sw.id);
  const elegida = poseActiva(doc)?.values?.[sw.id]?.active ?? sw.active;
  return hijos.find((o) => o.id === elegida)?.id ?? hijos[0]?.id ?? null;
}

/** Elegir qué muestra un switch: en la pose que se edita, si hay una; si no, en el montaje. */
export function elegirVariante(swId, hijo) {
  const pose = poseActiva();
  if (pose) return ejecutar(opsDePose(estado.doc, pose.id, swId, { active: hijo }), `${nombreDeEdicion(pose.id)}: ${swId} shows ${hijo}`);
  ejecutar([{ op: 'set', target: swId, props: { active: hijo } }], `${swId} shows ${hijo}`);
}

/**
 * Variantes que hay que mostrar aunque su switch muestre otra: la seleccionada (y sus ancestros dentro de switches),
 * para poder verla y editarla. Es solo de la vista: no cambia el documento.
 */
export function variantesAMostrar(doc = estado.doc) {
  const mostrar = {};
  for (let o = estado.seleccion && buscar(doc, estado.seleccion); o?.parent; o = buscar(doc, o.parent)) {
    const padre = buscar(doc, o.parent);
    if (padre?.type === 'switch' && varianteDe(doc, padre) !== o.id) mostrar[padre.id] = o.id;
  }
  return mostrar;
}
