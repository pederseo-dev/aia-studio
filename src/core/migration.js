// Migration to the bone layer model (Moho): older documents had the bones at the root, in the document frame, and
// the drawing bound from anywhere. Now the bones live inside a `skeleton`, which also contains the drawing they
// move. The conversion is deterministic and moves nothing on screen or in the poses.
//
// - If all the bound drawing is inside the same root group (for example `cat`), that group becomes the skeleton
//   and the bones move inside, with their values brought to the group's frame (also those of the poses).
//   If the group was bound to one of the bones, that binding passes to its direct children (a skeleton cannot
//   follow its own bones), which is the same thing they inherited.
// - If not (bound drawing loose at the root, in several groups, or a group that a pose moves or that is mirrored),
//   a new skeleton is created at the root, with no transform, with the bones and the span of the root that goes from
//   the first to the last bound drawing (so the drawing order does not change).

import { findObject, skeletonOf, children, subtree, validate } from './document.js';
import { read } from './schema.js';
import { POSE_FIELDS } from './skeleton.js';
import { apply, invert, worldMatrix } from './geometry.js';

const FRAME_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

/** Root bones that are not in a skeleton yet (those of a document older than the bone layer model). */
export function looseBones(doc) {
  return doc.objects.filter((o) => o.type === 'bone' && findObject(doc, o.parent)?.type !== 'bone' && !skeletonOf(doc, o.id));
}

/**
 * Converts the document. Returns { doc, changes } (changes: sentences for the history, in English because the user
 * sees them) or, if there is nothing to migrate, the same document and empty changes.
 */
export function migrateToSkeletons(original, schema) {
  if (!looseBones(original).length) return { doc: original, changes: [] };
  const doc = structuredClone(original);
  const roots = looseBones(doc);
  const bones = new Set(roots.flatMap((h) => subtree(doc, h.id)));
  const rootOf = (id) => {
    let o = findObject(doc, id);
    while (o.parent != null) o = findObject(doc, o.parent);
    return o.id;
  };
  const bound = doc.objects.filter((o) => bones.has(o.bone) || o.vertices?.some((v) => bones.has(v.bone)));
  const fromAbove = [...new Set(bound.map((o) => rootOf(o.id)))];

  const group = fromAbove.length === 1 && findObject(doc, fromAbove[0]);
  const frame = group && group.type === 'group' && similarity(worldMatrix(doc, schema, group.id));
  const posed = (id) => doc.objects.some((p) => p.type === 'pose' && FRAME_FIELDS.some((k) => p.values?.[id]?.[k] !== undefined));
  const changes = [];
  let skeleton;

  if (frame && !posed(group.id) && (!group.bone || bones.has(group.bone))) {
    // The group becomes the bone layer.
    skeleton = group.id;
    group.type = 'skeleton';
    if (group.bone) {
      const inherited = group.bone;
      delete group.bone;
      for (const h of children(doc, group.id)) if ('bone' in (schema.types.get(h.type)?.properties ?? {}) && !h.bone) h.bone = inherited;
      changes.push(`${group.id}'s children that followed ${inherited} through it are now bound to it directly`);
    }
    for (const h of roots) toFrame(doc, schema, h, frame);
    changes.unshift(`Group ${group.id} is now a Skeleton and contains the bones`);
  } else {
    // New skeleton at the root, with no transform: the bones keep the same values.
    skeleton = 'skeleton';
    for (let n = 2; findObject(doc, skeleton); n++) skeleton = `skeleton_${n}`;
    const rootDrawing = children(doc, null).filter((o) => o.type !== 'bone' && !schema.types.get(o.type)?.resource);
    const positions = fromAbove.map((id) => rootDrawing.findIndex((o) => o.id === id)).filter((i) => i >= 0);
    const span = positions.length ? rootDrawing.slice(Math.min(...positions), Math.max(...positions) + 1) : [];
    const place = span.length ? doc.objects.indexOf(span[0]) : doc.objects.length;
    doc.objects.splice(place, 0, { id: skeleton, type: 'skeleton', parent: null });
    for (const o of span) o.parent = skeleton;
    changes.push(`New Skeleton ${skeleton} with the bones${span.length ? ` and ${span.map((o) => o.id).join(', ')}` : ''}`);
  }

  // The bones go inside, at the front of the skeleton (they are not drawn, so it does not matter for drawing order),
  // in the same order they had.
  const sorted = doc.objects.filter((o) => bones.has(o.id));
  doc.objects = doc.objects.filter((o) => !bones.has(o.id));
  for (const h of roots) sorted.find((o) => o.id === h.id).parent = skeleton;
  const last = Math.max(...subtree(doc, skeleton).map((id) => doc.objects.findIndex((o) => o.id === id)));
  doc.objects.splice(last + 1, 0, ...sorted);

  const { errors } = validate(doc, schema);
  if (errors.length) throw new Error(`the migration left the document invalid:\n${errors.join('\n')}`);
  return { doc, changes };
}

/**
 * If the matrix is a similarity (translation, rotation and positive uniform scale), its rotation and scale; if not
 * (mirror or unequal scale with rotation), null: the bone cannot be expressed in that frame without deforming it.
 */
function similarity(m) {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (a * d - b * c <= 0 || Math.abs(sx - sy) > 1e-9 || Math.abs(a * c + b * d) > 1e-9) return null;
  return { m, rotation: (Math.atan2(b, a) * 180) / Math.PI, scale: sx };
}

/** Moves the values of a root bone (setup and poses) from the document frame to the group's. */
function toFrame(doc, schema, bone, { m, rotation, scale }) {
  const inverse = invert(m);
  const convert = (values, complete) => {
    const output = {};
    if (values.x !== undefined || values.y !== undefined) {
      const [x, y] = apply(inverse, complete.x, complete.y);
      [output.x, output.y] = [r6(x), r6(y)];
    }
    if (values.rotation !== undefined && rotation) output.rotation = r6(complete.rotation - rotation);
    for (const k of ['scaleX', 'scaleY']) if (values[k] !== undefined && scale !== 1) output[k] = r6(complete[k] / scale);
    return output;
  };
  const setup = Object.fromEntries(POSE_FIELDS.map((k) => [k, read(schema, bone, k)]));
  // In the setup everything the frame changes is written (even if it was at its default value).
  const fixed = { x: 1, y: 1, ...(rotation ? { rotation: 1 } : {}), ...(scale !== 1 ? { scaleX: 1, scaleY: 1 } : {}) };
  Object.assign(bone, convert(fixed, setup));
  // The limits use the same reference as rotation.
  for (const k of ['minAngle', 'maxAngle']) if (rotation && bone[k] != null) bone[k] = r6(bone[k] - rotation);
  for (const pose of doc.objects.filter((p) => p.type === 'pose' && p.values?.[bone.id])) {
    const values = pose.values[bone.id];
    Object.assign(values, convert(values, { ...setup, ...values }));
  }
}

/**
 * Animate scenes with param tracks (from before params were Puppet-only, or a clip changed from Puppet to Animate by
 * hand): they no longer validate and the document would not accept any operation. They are turned into Puppet, which
 * does animate params; so no keyframe is lost and the user decides (back to Animate removing those tracks, or leave
 * it as a clip). Returns { doc, changes } like migrateToSkeletons.
 */
export function migrateScenesWithParams(original, schema) {
  const withParams = (clip) => Object.keys(clip.tracks ?? {}).some((id) => findObject(original, id)?.type === 'param');
  const scenes = original.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') !== 'puppet' && withParams(o));
  if (!scenes.length) return { doc: original, changes: [] };
  const doc = structuredClone(original);
  const changes = [];
  for (const { id } of scenes) {
    findObject(doc, id).usage = 'puppet';
    changes.push(`Scene "${id}" animated parameters, which only Puppet clips can do: it is now a Puppet clip (nothing was lost). To use it as a scene again, delete its parameter tracks and set Usage to animate.`);
  }
  return { doc, changes };
}
