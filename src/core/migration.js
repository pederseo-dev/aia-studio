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

import { findObject, skeletonOf, children, subtree, validate } from './document.js';
import { read } from './schema.js';
import { POSE_FIELDS } from './skeleton.js';
import { apply, invert, worldMatrix } from './geometry.js';

const FRAME_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

/** Huesos raíz que todavía no están en un skeleton (los de un documento anterior al modelo de capa de huesos). */
export function looseBones(doc) {
  return doc.objects.filter((o) => o.type === 'bone' && findObject(doc, o.parent)?.type !== 'bone' && !skeletonOf(doc, o.id));
}

/**
 * Convierte el documento. Devuelve { doc, cambios } (cambios: frases para el historial, en inglés porque las ve el
 * usuario) o, si no hay nada que migrar, el mismo documento y cambios vacío.
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
    // El grupo pasa a ser la capa de huesos.
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
    // Skeleton nuevo en la raíz, sin transformación: los huesos quedan con los mismos valores.
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

  // Los huesos van adentro, al frente del skeleton (no se dibujan, así que no importa para el orden de dibujo), en el
  // mismo orden que tenían.
  const sorted = doc.objects.filter((o) => bones.has(o.id));
  doc.objects = doc.objects.filter((o) => !bones.has(o.id));
  for (const h of roots) sorted.find((o) => o.id === h.id).parent = skeleton;
  const last = Math.max(...subtree(doc, skeleton).map((id) => doc.objects.findIndex((o) => o.id === id)));
  doc.objects.splice(last + 1, 0, ...sorted);

  const { errors } = validate(doc, schema);
  if (errors.length) throw new Error(`la migración dejó el documento inválido:\n${errors.join('\n')}`);
  return { doc, changes };
}

/**
 * Si la matriz es una similitud (traslación, rotación y escala uniforme positiva), su rotación y escala; si no
 * (espejo o escala desigual con giro), null: no se puede expresar el hueso en ese marco sin deformarlo.
 */
function similarity(m) {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (a * d - b * c <= 0 || Math.abs(sx - sy) > 1e-9 || Math.abs(a * c + b * d) > 1e-9) return null;
  return { m, rotation: (Math.atan2(b, a) * 180) / Math.PI, scale: sx };
}

/** Pasa los valores de un hueso raíz (montaje y poses) del marco del documento al del grupo. */
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
  // En el montaje se escribe todo lo que el marco cambia (aunque estuviera en su valor por defecto).
  const fixed = { x: 1, y: 1, ...(rotation ? { rotation: 1 } : {}), ...(scale !== 1 ? { scaleX: 1, scaleY: 1 } : {}) };
  Object.assign(bone, convert(fixed, setup));
  // Los límites usan la misma referencia que rotation.
  for (const k of ['minAngle', 'maxAngle']) if (rotation && bone[k] != null) bone[k] = r6(bone[k] - rotation);
  for (const pose of doc.objects.filter((p) => p.type === 'pose' && p.values?.[bone.id])) {
    const values = pose.values[bone.id];
    Object.assign(values, convert(values, { ...setup, ...values }));
  }
}

/**
 * Escenas de Animate con pistas de params (de antes de que los params fueran solo de Puppet, o un clip que pasó de
 * Puppet a Animate a mano): ya no validan y el documento no aceptaría ninguna operación. Se pasan a Puppet, que sí
 * anima params; así no se pierde ningún keyframe y el usuario decide (volver a Animate quitando esas pistas, o
 * dejarlo como clip). Devuelve { doc, cambios } como migrarAEsqueletos.
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
