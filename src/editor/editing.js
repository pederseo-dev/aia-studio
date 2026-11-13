// Qué se edita y qué se ve en el editor, derivado del estado: la pose o el clip abiertos (en el tiempo del playhead),
// la mezcla de los params, la variante de cada switch, y el lote que escribe en la pose o el clip abiertos. Lo usan
// el lienzo, el inspector, la timeline y las herramientas; no dibuja nada.

import { findObject } from '../core/document.js';
import { opsForKeysInClip, clipPose } from '../core/animation.js';
import { blendPoses, opsToSetPose } from '../core/blend.js';
import { execute, schema, state } from './state.js';

/**
 * La pose que se está editando en el documento indicado, o null. Con un clip abierto, es lo que se ve en el tiempo
 * del playhead (con el id del clip, para que los cambios vayan a sus keyframes).
 */
export function activePose(doc = state.doc) {
  // Con Live encendido no se edita nada: no hay pose ni clip que reciba cambios.
  if (state.live) return null;
  const p = state.pose && findObject(doc, state.pose);
  if (p?.type === 'animation') return { ...clipPose(doc, schema, p, state.time, state.params ?? {}), id: p.id };
  return p?.type === 'pose' ? p : null;
}

/** Cómo se nombra en el historial lo que se edita: «pose happy» o «clip wave @ 0.5s». */
export function editingName(id = state.pose) {
  return findObject(state.doc, id)?.type === 'animation' ? `clip ${id} @ ${+state.time.toFixed(3)}s` : `pose ${id}`;
}

/** El clip abierto (animation), o null. */
export function openedClip(doc = state.doc) {
  const p = state.pose && doc && findObject(doc, state.pose);
  return p?.type === 'animation' ? p : null;
}

/** Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o null (el montaje). */
export function viewedPose(doc = state.doc) {
  if (state.live) return state.livePose;
  return activePose(doc) ?? (state.params ? blendPoses(doc, schema, state.params) : null);
}

/**
 * Lote que fija propiedades de un objeto dentro de una pose (conserva lo demás; undefined quita la propiedad). En un
 * clip, cada propiedad queda como keyframe en el tiempo del playhead (autokey); undefined quita ese keyframe. La
 * lógica está en el núcleo, la misma que usa el MCP.
 */
export function poseOps(doc, poseId, id, fields) {
  if (findObject(doc, poseId)?.type === 'animation') return opsForKeysInClip(doc, schema, poseId, id, fields, state.time, state.params ?? {});
  return opsToSetPose(doc, poseId, { [id]: fields });
}

/** Variante que muestra un switch: la de la pose que se edita, si la fija; si no, la del montaje (o la primera). */
export function variantOf(doc, sw) {
  const children = doc.objects.filter((o) => o.parent === sw.id);
  const chosen = activePose(doc)?.values?.[sw.id]?.active ?? sw.active;
  return children.find((o) => o.id === chosen)?.id ?? children[0]?.id ?? null;
}

/** Elegir qué muestra un switch: en la pose que se edita, si hay una; si no, en el montaje. */
export function chooseVariant(swId, child) {
  const pose = activePose();
  if (pose) return execute(poseOps(state.doc, pose.id, swId, { active: child }), `${editingName(pose.id)}: ${swId} shows ${child}`);
  execute([{ op: 'set', target: swId, props: { active: child } }], `${swId} shows ${child}`);
}

/**
 * Variantes que hay que mostrar aunque su switch muestre otra: la seleccionada (y sus ancestros dentro de switches),
 * para poder verla y editarla. Es solo de la vista: no cambia el documento.
 */
export function variantsToShow(doc = state.doc) {
  const show = {};
  for (let o = state.selection && findObject(doc, state.selection); o?.parent; o = findObject(doc, o.parent)) {
    const parent = findObject(doc, o.parent);
    if (parent?.type === 'switch' && variantOf(doc, parent) !== o.id) show[parent.id] = o.id;
  }
  return show;
}
