// What is edited and what is seen in the editor, derived from the state: the open pose or clip (at the playhead time),
// the blend of the params, the variant of each switch, and the batch that writes to the open pose or clip. Used by
// the canvas, the inspector, the timeline and the tools; it draws nothing.

import { findObject } from '../core/document.js';
import { opsForKeysInClip, clipPose } from '../core/animation.js';
import { blendPoses, opsToSetPose } from '../core/blend.js';
import { execute, schema, state } from './state.js';

/**
 * The pose being edited in the given document, or null. With a clip open, it is what is seen at the playhead
 * time (with the clip id, so changes go to its keyframes).
 */
export function activePose(doc = state.doc) {
  // With Live on nothing is edited: there is no pose or clip to receive changes.
  if (state.live) return null;
  const p = state.pose && findObject(doc, state.pose);
  if (p?.type === 'animation') return { ...clipPose(doc, schema, p, state.time, state.params ?? {}), id: p.id };
  return p?.type === 'pose' ? p : null;
}

/** How what is edited is named in the history: «pose happy» or «clip wave @ 0.5s». */
export function editingName(id = state.pose) {
  return findObject(state.doc, id)?.type === 'animation' ? `clip ${id} @ ${+state.time.toFixed(3)}s` : `pose ${id}`;
}

/** The open clip (animation), or null. */
export function openedClip(doc = state.doc) {
  const p = state.pose && doc && findObject(doc, state.pose);
  return p?.type === 'animation' ? p : null;
}

/** What is seen: the pose being edited, the blend of the params (Parameters view) or null (the setup). */
export function viewedPose(doc = state.doc) {
  if (state.live) return state.livePose;
  return activePose(doc) ?? (state.params ? blendPoses(doc, schema, state.params) : null);
}

/**
 * Batch that sets properties of an object inside a pose (keeps the rest; undefined removes the property). In a
 * clip, each property becomes a keyframe at the playhead time (autokey); undefined removes that keyframe. The
 * logic is in the core, the same one the MCP uses.
 */
export function poseOps(doc, poseId, id, fields) {
  if (findObject(doc, poseId)?.type === 'animation') return opsForKeysInClip(doc, schema, poseId, id, fields, state.time, state.params ?? {});
  return opsToSetPose(doc, poseId, { [id]: fields });
}

/** Variant a switch shows: the one of the pose being edited, if it sets it; otherwise the setup's (or the first). */
export function variantOf(doc, sw) {
  const children = doc.objects.filter((o) => o.parent === sw.id);
  const chosen = activePose(doc)?.values?.[sw.id]?.active ?? sw.active;
  return children.find((o) => o.id === chosen)?.id ?? children[0]?.id ?? null;
}

/** Choose what a switch shows: in the pose being edited, if there is one; otherwise, in the setup. */
export function chooseVariant(swId, child) {
  const pose = activePose();
  if (pose) return execute(poseOps(state.doc, pose.id, swId, { active: child }), `${editingName(pose.id)}: ${swId} shows ${child}`);
  execute([{ op: 'set', target: swId, props: { active: child } }], `${swId} shows ${child}`);
}

/**
 * Variants that must be shown even if their switch shows another: the selected one (and its ancestors inside
 * switches), so it can be seen and edited. It is view only: it does not change the document.
 */
export function variantsToShow(doc = state.doc) {
  const show = {};
  for (let o = state.selection && findObject(doc, state.selection); o?.parent; o = findObject(doc, o.parent)) {
    const parent = findObject(doc, o.parent);
    if (parent?.type === 'switch' && variantOf(doc, parent) !== o.id) show[parent.id] = o.id;
  }
  return show;
}
