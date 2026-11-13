import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { findObject, createDocument, skeletonOf, validate } from '../src/core/document.js';
import { deltaOf, bindingsByProximity, evaluateInPose, evaluateSkeleton, opsToReparent, reparentSeveral, tipOf, distributeBetweenBones, releaseForeignBindings } from '../src/core/skeleton.js';
import { apply, multiply } from '../src/core/geometry.js';
import { migrateToSkeletons } from '../src/core/migration.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;
const near = (p, q, eps = 0.01) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;
const matrixOf = (svg, id) => svg.match(new RegExp(`data-id="${id}" transform="matrix\\(([^)]+)\\)"`))[1].split(' ').map(Number);

// An arm: a skeleton without transform with the shoulder at (100, 100) pointing right, the forearm
// chained at the tip and the hand bound to the forearm.
function arm() {
  return op(
    createDocument({ name: 'Brazo' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'upper', parent: 'rig', props: { x: 100, y: 100, length: 50 } },
    { op: 'create', type: 'bone', id: 'lower', parent: 'upper', props: { x: 50, length: 40 } },
    { op: 'create', type: 'rect', id: 'hand', parent: 'rig', props: { x: 190, y: 100, width: 10, height: 10, bone: 'lower' } },
    { op: 'create', type: 'pose', id: 'up', props: { values: { upper: { rotation: -90 } } } },
  );
}

test('los huesos encadenan sus matrices y la pose no toca el montaje', () => {
  const doc = arm();
  const setup = evaluateSkeleton(doc, schema);
  assert.ok(near(tipOf(schema, findObject(doc, 'lower'), setup.rest.get('lower')), [190, 100]));
  const pose = evaluateSkeleton(doc, schema, findObject(doc, 'up'));
  // Turning the shoulder -90° (upward) takes the forearm's tip to (100, 10).
  assert.ok(near(tipOf(schema, findObject(doc, 'lower'), pose.posed.get('lower')), [100, 10]));
  assert.ok(near(tipOf(schema, findObject(doc, 'lower'), pose.rest.get('lower')), [190, 100]));
  assert.equal(findObject(doc, 'upper').rotation, undefined);
});

test('lo enlazado sigue al hueso solo en la pose, y en el SVG queda donde corresponde', () => {
  const doc = arm();
  const pose = evaluateSkeleton(doc, schema, findObject(doc, 'up'));
  assert.ok(near(apply(deltaOf(doc, pose, 'hand'), 190, 100), [100, 10]));
  assert.ok(near(apply(deltaOf(doc, evaluateSkeleton(doc, schema), 'hand'), 190, 100), [190, 100]));
  assert.match(svgDocument(doc, schema), /data-id="hand" transform="translate\(190 100\)"/);
  const [, , , , e, f] = matrixOf(svgDocument(doc, schema, { pose: 'up' }), 'hand');
  assert.ok(near([e, f], [100, 10]));
  // Bones are children of the skeleton but are not drawn.
  assert.doesNotMatch(svgDocument(doc, schema), /data-id="upper"/);
});

test('ángulo independiente y límites', () => {
  let doc = op(arm(), { op: 'set', target: 'lower', props: { independentAngle: true } });
  const pose = evaluateSkeleton(doc, schema, findObject(doc, 'up'));
  // The forearm moves with the shoulder but keeps pointing right.
  assert.ok(near(tipOf(schema, findObject(doc, 'lower'), pose.posed.get('lower')), [140, 50]));
  doc = op(doc, { op: 'set', target: 'upper', props: { minAngle: -45 } });
  const limited = evaluateSkeleton(doc, schema, findObject(doc, 'up'));
  const [a, b] = limited.posed.get('upper');
  assert.ok(Math.abs((Math.atan2(b, a) * 180) / Math.PI + 45) < 0.01);
});

test('pertenencia: los huesos van dentro de un skeleton, y solo tienen huesos como hijos', () => {
  assert.throws(() => op(createDocument(), { op: 'create', type: 'bone', id: 'b' }), /no puede estar en la raíz: va dentro de skeleton o bone\. Crea primero un skeleton/);
  assert.throws(() => op(arm(), { op: 'create', type: 'bone', id: 'b' }), /Esqueletos del documento: rig/);
  assert.throws(() => op(arm(), { op: 'create', type: 'group', id: 'g' }, { op: 'create', type: 'bone', id: 'b', parent: 'g' }), /solo puede estar dentro de skeleton o bone \(su padre "g" es un group\)/);
  assert.throws(() => op(arm(), { op: 'create', type: 'rect', id: 'x', parent: 'upper' }), /el dibujo va dentro del skeleton \(rig\)/);
  assert.throws(() => op(arm(), { op: 'move', target: 'upper', parent: null }), /no puede estar en la raíz/);
  assert.equal(skeletonOf(arm(), 'lower'), 'rig');
  assert.equal(skeletonOf(arm(), 'rig'), null);
  assert.throws(() => op(arm(), { op: 'set', target: 'up', props: { values: { uper: { rotation: 1 } } } }), /¿Quisiste decir "upper"\?/);
  assert.throws(() => op(arm(), { op: 'set', target: 'up', props: { values: { upper: { angle: 1 } } } }), /no tiene "angle" animable/);
});

test('enlace limitado a su skeleton, por capa y por punto, con mensajes que orientan', () => {
  const doc = op(arm(), { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'tail_bone', parent: 'otro' }, { op: 'create', type: 'ellipse', id: 'suelta' });
  // Outside any skeleton.
  assert.throws(() => op(doc, { op: 'set', target: 'suelta', props: { bone: 'upper' } }), /suelta\.bone: "upper" es un hueso del skeleton "rig" y suelta no está dentro de ningún skeleton.*mételo dentro de "rig"/);
  // In another skeleton: lists the bones that do work, with a suggestion.
  assert.throws(() => op(doc, { op: 'set', target: 'hand', props: { bone: 'tail_bone' } }), /hand está en el skeleton "rig" y solo puede enlazarse a sus huesos: upper, lower/);
  assert.throws(() => op(doc, { op: 'set', target: 'hand', props: { bone: 'lowr' } }), /no existe el hueso "lowr"\. ¿Quisiste decir "lower"\?/);
  // A skeleton is not bound to its own bones.
  assert.throws(() => op(doc, { op: 'set', target: 'rig', props: { bone: 'upper' } }), /rig no está dentro de ningún skeleton/);
  // Per point, the same.
  assert.throws(() => op(doc, { op: 'create', type: 'path', id: 'p', parent: 'otro', props: { vertices: [{ x: 0, y: 0, bone: 'upper' }, { x: 1, y: 1 }] } }), /p\.vertices\[0\]\.bone: "upper" es un hueso del skeleton "rig", pero p está en el skeleton "otro"/);
  // Taking a drawing out of the skeleton leaves a foreign binding: the editor releases it with releaseForeignBindings.
  const outside = structuredClone(doc);
  findObject(outside, 'hand').parent = null;
  assert.ok(validate(outside, schema).errors.some((e) => /hand\.bone/.test(e)));
  assert.deepEqual(releaseForeignBindings(outside, schema), [{ op: 'unset', target: 'hand', props: ['bone'] }]);
});

test('un skeleton transformado lleva sus huesos: from/to en el documento y poses en su marco', () => {
  // The skeleton is at (300, 200) and turned 90°: its x axis points down on screen.
  let doc = op(
    createDocument(),
    { op: 'create', type: 'skeleton', id: 'rig', props: { x: 300, y: 200, rotation: 90 } },
    { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { from: [300, 200], to: [300, 260] } },
    { op: 'create', type: 'bone', id: 'c', parent: 'b', props: { from: [300, 260], to: [340, 260] } },
    { op: 'create', type: 'rect', id: 'r', parent: 'rig', props: { x: 60, y: -40, width: 4, height: 4, bone: 'c' } },
    { op: 'create', type: 'pose', id: 'p', props: { values: { b: { rotation: 90 } } } },
  );
  // Relative to the skeleton: b starts at its origin and points along its x axis (0°); c turns -90° relative to b.
  assert.deepEqual([findObject(doc, 'b').x, findObject(doc, 'b').y, findObject(doc, 'b').rotation, findObject(doc, 'b').length], [0, 0, 0, 60]);
  assert.deepEqual([findObject(doc, 'c').x, findObject(doc, 'c').rotation, findObject(doc, 'c').length], [60, -90, 40]);
  const ev = evaluateSkeleton(doc, schema, findObject(doc, 'p'));
  assert.ok(near(tipOf(schema, findObject(doc, 'c'), ev.rest.get('c')), [340, 260]));
  // The pose turns b 90° more (on screen it points left) and c, at -90° from b, hangs: its tip ends at (240, 240).
  assert.ok(near(tipOf(schema, findObject(doc, 'c'), ev.posed.get('c')), [240, 240]));
  // r is at c's tip in the setup: (x 60, y -40) of the skeleton = (340, 260) on screen, and follows it.
  const [, , , , e, f] = matrixOf(svgDocument(doc, schema, { pose: 'p' }), 'r');
  assert.ok(near(apply([0, 1, -1, 0, 300, 200], e, f), [240, 240]));
  // Moving the skeleton moves the rig and the drawing together, without touching the bones.
  doc = op(doc, { op: 'set', target: 'rig', props: { x: 400 } });
  assert.ok(near(tipOf(schema, findObject(doc, 'c'), evaluateSkeleton(doc, schema).rest.get('c')), [440, 260]));
  assert.deepEqual([findObject(doc, 'b').x, findObject(doc, 'b').rotation], [0, 0]);
});

test('un skeleton anidado sigue al hueso del de afuera', () => {
  const doc = op(
    arm(),
    { op: 'create', type: 'skeleton', id: 'mano', parent: 'rig', props: { bone: 'lower' } },
    { op: 'create', type: 'bone', id: 'finger', parent: 'mano', props: { from: [190, 100], to: [200, 100] } },
    { op: 'create', type: 'rect', id: 'nail', parent: 'mano', props: { x: 200, y: 100, bone: 'finger' } },
  );
  const ev = evaluateSkeleton(doc, schema, findObject(doc, 'up'));
  // The shoulder turns -90°: the finger, at the forearm's tip, rises with it to (100, 10) → (100, 0).
  assert.ok(near(tipOf(schema, findObject(doc, 'finger'), ev.posed.get('finger')), [100, 0]));
  // In the SVG, the nail (inside hand) ends at the finger's tip.
  const svg = svgDocument(doc, schema, { pose: 'up' });
  assert.ok(near(apply(multiply(matrixOf(svg, 'mano'), matrixOf(svg, 'nail')), 0, 0), [100, 0]));
  assert.throws(() => op(doc, { op: 'set', target: 'nail', props: { bone: 'lower' } }), /nail está en el skeleton "mano"/);
});

test('renombrar y borrar un hueso actualiza enlaces y poses, y deshacer los recupera', () => {
  let doc = op(arm(), { op: 'rename', target: 'upper', id: 'arm' });
  assert.deepEqual(findObject(doc, 'up').values, { arm: { rotation: -90 } });
  const { doc: sin, inverses } = applyOperations(doc, [{ op: 'delete', target: 'arm' }], schema);
  assert.equal(findObject(sin, 'hand').bone, undefined);
  assert.deepEqual(findObject(sin, 'up').values, {});
  doc = applyOperations(sin, inverses, schema).doc;
  assert.equal(findObject(doc, 'hand').bone, 'lower');
  assert.deepEqual(findObject(doc, 'up').values, { arm: { rotation: -90 } });
});

test('duplicar un skeleton copia sus huesos y los enlaces apuntan a las copias', () => {
  let doc = op(arm(), { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 190, y: 100, bone: 'lower' }] } });
  doc = op(doc, { op: 'duplicate', target: 'rig', suffix: 'b' });
  assert.equal(findObject(doc, 'hand_b').bone, 'lower_b');
  assert.deepEqual(findObject(doc, 'tira_b').vertices.map((v) => v.bone), ['upper_b', 'lower_b']);
  assert.equal(skeletonOf(doc, 'lower_b'), 'rig_b');
});

test('la vista previa puede dibujar el esqueleto encima, posado', () => {
  const doc = arm();
  assert.doesNotMatch(svgDocument(doc, schema), /data-huesos/);
  const svg = svgDocument(doc, schema, { bones: true, pose: 'up' });
  assert.match(svg, /<g data-bones="">/);
  assert.match(svg, />lower<\/text>/);
});

test('enlace por punto: un path se dobla con varios huesos y sigue siendo uno solo', () => {
  let doc = arm();
  // A strip from (100,100) to (190,100): the first two points follow the shoulder, the tip the forearm.
  doc = op(doc, {
    op: 'create',
    type: 'path',
    id: 'tira',
    parent: 'rig',
    props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 150, y: 100, bone: 'upper' }, { x: 190, y: 100, bone: 'lower' }] },
  });
  doc = op(doc, { op: 'set', target: 'up', props: { values: { upper: { rotation: -90 }, lower: { rotation: 90 } } } });
  const d = svgDocument(doc, schema, { pose: 'up' }).match(/data-id="tira"><path d="([^"]+)"/)[1];
  // The shoulder points up and the forearm turns back right: the elbow ends at (100, 50), the tip at (140, 50).
  assert.equal(d, 'M100 100L100 50L140 50');
  // Renaming and deleting the bone update the vertices.
  doc = op(doc, { op: 'rename', target: 'lower', id: 'fore' });
  assert.equal(findObject(doc, 'tira').vertices[2].bone, 'fore');
  doc = op(doc, { op: 'delete', target: 'fore' });
  assert.deepEqual(findObject(doc, 'tira').vertices[2], { x: 190, y: 100 });
  assert.throws(() => op(doc, { op: 'set', target: 'tira', props: { vertices: [{ x: 0, y: 0, bone: 'nada' }, { x: 1, y: 1 }] } }), /no existe el hueso "nada"/);
});

test('from/to crean huesos con coordenadas del documento, también encadenados', () => {
  let doc = op(
    createDocument({ name: 'Desde hasta' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'spine_bone', parent: 'rig', props: { from: [300, 400], to: [300, 300] } },
    { op: 'create', type: 'bone', id: 'arm_bone', parent: 'spine_bone', props: { from: [320, 320], to: [380, 320] } },
  );
  assert.deepEqual(findObject(doc, 'spine_bone'), { id: 'spine_bone', type: 'bone', parent: 'rig', x: 300, y: 400, rotation: -90, length: 100 });
  const arm = findObject(doc, 'arm_bone');
  assert.deepEqual([arm.x, arm.y, arm.rotation, arm.length], [80, 20, 90, 60]);
  // With only `to` the origin is kept.
  doc = op(doc, { op: 'set', target: 'arm_bone', props: { to: [320, 260] } });
  assert.deepEqual([findObject(doc, 'arm_bone').x, findObject(doc, 'arm_bone').rotation, findObject(doc, 'arm_bone').length], [80, 0, 60]);
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'r', props: { from: [0, 0] } }), /solo sirven en huesos/);
});

test('repartir los puntos de un path entre los huesos más cercanos de su skeleton', () => {
  const doc = op(arm(), { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 180, y: 100 }] } });
  assert.deepEqual(distributeBetweenBones(doc, schema, 'tira').map((v) => v.bone), ['upper', 'upper', 'lower']);
  const withOther = op(doc, { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'x_bone', parent: 'otro' });
  assert.throws(() => distributeBetweenBones(withOther, schema, 'tira', ['upper', 'x_bone']), /x_bone no es un hueso del skeleton "rig"/);
  const loose = op(doc, { op: 'move', target: 'tira', parent: null });
  assert.throws(() => distributeBetweenBones(loose, schema, 'tira'), /no está dentro de un skeleton/);
});

test('bind all by proximity: cada pieza sin enlace va al hueso más cercano, sin tocar lo ya enlazado', () => {
  const doc = op(
    arm(),
    // A group with nothing bound goes whole; its center (180, 110) falls on the forearm.
    { op: 'create', type: 'group', id: 'glove', parent: 'rig', props: { x: 180, y: 110 } },
    { op: 'create', type: 'rect', id: 'palm', parent: 'glove', props: { width: 20, height: 20 } },
    // A group with something bound inside is traversed: only what is missing gets bound.
    { op: 'create', type: 'group', id: 'sleeve', parent: 'rig' },
    { op: 'create', type: 'ellipse', id: 'cuff', parent: 'sleeve', props: { x: 120, y: 100, width: 10, height: 10 } },
    { op: 'create', type: 'ellipse', id: 'patch', parent: 'sleeve', props: { x: 180, y: 100, width: 10, height: 10, bone: 'upper' } },
    // A path bound per point is already decided.
    { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 190, y: 100 }] } },
    // What is outside the skeleton does not count.
    { op: 'create', type: 'rect', id: 'fondo', props: { x: 100, y: 100 } },
  );
  assert.deepEqual(bindingsByProximity(doc, schema, 'rig'), [
    { id: 'glove', bone: 'lower' },
    { id: 'cuff', bone: 'upper' },
  ]);
  assert.throws(() => bindingsByProximity(op(createDocument(), { op: 'create', type: 'skeleton', id: 's' }), schema, 's'), /no tiene huesos/);
  assert.throws(() => bindingsByProximity(doc, schema, 'hand'), /no es un skeleton/);
});

// A document from before the bone layer model: bones at the root and the group `cat` bound to one of them.
function oldDocument({ withRotation = false } = {}) {
  return {
    format: createDocument().format,
    meta: { name: 'Viejo' },
    objects: [
      { id: 'cat', type: 'group', parent: null, x: 300, y: 400, ...(withRotation ? { rotation: 30, scaleX: 2, scaleY: 2 } : {}), bone: 'body_bone' },
      { id: 'torso', type: 'rect', parent: 'cat', width: 80, height: 120 },
      { id: 'head', type: 'group', parent: 'cat', y: -100, bone: 'head_bone' },
      { id: 'face', type: 'ellipse', parent: 'head' },
      { id: 'tail', type: 'path', parent: 'cat', closed: false, vertices: [{ x: 40, y: 40, bone: 'tail_bone' }, { x: 80, y: 40, bone: 'tail_bone' }] },
      { id: 'body_bone', type: 'bone', parent: null, x: 300, y: 460, rotation: -90, length: 120, minAngle: -100 },
      { id: 'head_bone', type: 'bone', parent: 'body_bone', x: 120, length: 60 },
      { id: 'tail_bone', type: 'bone', parent: 'body_bone', x: 20, y: 40, rotation: 90, length: 40 },
      { id: 'nod', type: 'pose', parent: null, values: { body_bone: { rotation: -80, x: 310 }, head_bone: { rotation: 20 } } },
    ],
  };
}

test('migración: el grupo raíz pasa a ser el skeleton y nada se mueve, ni en el montaje ni en las poses', () => {
  for (const withRotation of [false, true]) {
    const old = oldDocument({ withRotation });
    assert.ok(validate(old, schema).errors.some((e) => /body_bone: un bone no puede estar en la raíz/.test(e)));
    const { doc, changes } = migrateToSkeletons(old, schema);
    assert.deepEqual(validate(doc, schema).errors, []);
    assert.match(changes[0], /Group cat is now a Skeleton/);
    assert.equal(findObject(doc, 'cat').type, 'skeleton');
    assert.equal(findObject(doc, 'cat').bone, undefined);
    assert.equal(findObject(doc, 'body_bone').parent, 'cat');
    // What body_bone inherited through cat it now has on its own; what had its own keeps it.
    assert.deepEqual(['torso', 'head', 'tail'].map((id) => findObject(doc, id).bone), ['body_bone', 'head_bone', 'body_bone']);
    // The bones stay where they were on screen, in the setup and in the pose.
    for (const pose of [null, 'nod']) {
      const before = evaluateSkeleton(old, schema, pose && findObject(old, pose));
      const after = evaluateSkeleton(doc, schema, pose && findObject(doc, pose));
      for (const id of ['body_bone', 'head_bone', 'tail_bone']) assert.ok(before.posed.get(id).every((v, i) => Math.abs(v - after.posed.get(id)[i]) < 1e-4), `${id} en ${pose}`);
    }
    assert.equal(svgDocument(doc, schema).length > 0, true);
    // Migrating again changes nothing.
    assert.deepEqual(migrateToSkeletons(doc, schema).changes, []);
  }
  // Without rotation, the root bone only shifts into cat's frame.
  const { doc } = migrateToSkeletons(oldDocument(), schema);
  assert.deepEqual([findObject(doc, 'body_bone').x, findObject(doc, 'body_bone').y, findObject(doc, 'body_bone').rotation], [0, 60, -90]);
  assert.deepEqual(findObject(doc, 'nod').values.body_bone, { rotation: -80, x: 10, y: 60 });
});

test('migración: dibujo enlazado suelto en la raíz va a un skeleton nuevo sin cambiar el orden de dibujo', () => {
  const old = {
    format: createDocument().format,
    meta: {},
    objects: [
      { id: 'fondo', type: 'rect', parent: null },
      { id: 'a', type: 'ellipse', parent: null, bone: 'b1' },
      { id: 'medio', type: 'rect', parent: null },
      { id: 'c', type: 'ellipse', parent: null, bone: 'b2' },
      { id: 'frente', type: 'rect', parent: null },
      { id: 'b1', type: 'bone', parent: null, x: 10 },
      { id: 'b2', type: 'bone', parent: 'b1' },
      { id: 'b3', type: 'bone', parent: null },
    ],
  };
  const { doc, changes } = migrateToSkeletons(old, schema);
  assert.deepEqual(validate(doc, schema).errors, []);
  assert.match(changes[0], /New Skeleton skeleton with the bones and a, medio, c/);
  assert.deepEqual(doc.objects.filter((o) => o.parent == null).map((o) => o.id), ['fondo', 'skeleton', 'frente']);
  assert.deepEqual(doc.objects.filter((o) => o.parent === 'skeleton').map((o) => o.id), ['a', 'medio', 'c', 'b1', 'b3']);
  assert.equal(findObject(doc, 'b1').x, 10);
  assert.equal(svgDocument(doc, schema), svgDocument(old, schema).replace('<g data-id="a">', '<g data-id="skeleton"><g data-id="a">').replace('<g data-id="frente">', '</g><g data-id="frente">'));
});

test('reparentar un hueso no lo mueve en el montaje ni en las poses que lo fijan, y respeta su skeleton', () => {
  let doc = op(
    arm(),
    { op: 'create', type: 'bone', id: 'finger', parent: 'lower', props: { from: [190, 100], to: [190, 130] } },
    { op: 'set', target: 'up', props: { values: { upper: { rotation: -90 }, finger: { rotation: 45 } } } },
  );
  const before = evaluateSkeleton(doc, schema);
  const equal = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  // Now hangs from the shoulder: on screen it stays where it was.
  doc = op(doc, ...opsToReparent(doc, schema, 'finger', 'upper'));
  assert.equal(findObject(doc, 'finger').parent, 'upper');
  assert.ok(equal(evaluateSkeleton(doc, schema).rest.get('finger'), before.rest.get('finger')));
  // Its rotation in the pose was carried into the new frame (same turn relative to the setup).
  assert.equal(findObject(doc, 'up').values.finger.rotation, 45);
  // As root of the skeleton.
  doc = op(doc, ...opsToReparent(doc, schema, 'finger', 'rig'));
  assert.equal(findObject(doc, 'finger').parent, 'rig');
  assert.ok(equal(evaluateSkeleton(doc, schema).rest.get('finger'), before.rest.get('finger')));
  assert.deepEqual([findObject(doc, 'finger').x, findObject(doc, 'finger').y, findObject(doc, 'finger').rotation], [190, 100, 90]);
  assert.equal(findObject(doc, 'up').values.finger.rotation, 45);
  // With a rotated parent, the setup rotation and the pose rotation are compensated the same way.
  const rotated = op(doc, { op: 'create', type: 'bone', id: 'tilt', parent: 'rig', props: { x: 0, y: 0, rotation: 30 } });
  const ready = op(rotated, ...opsToReparent(rotated, schema, 'finger', 'tilt'));
  assert.ok(equal(evaluateSkeleton(ready, schema).rest.get('finger'), before.rest.get('finger')));
  assert.deepEqual([findObject(ready, 'finger').rotation, findObject(ready, 'up').values.finger.rotation], [60, 15]);
  // Clear errors: a descendant, another skeleton, something that is not a bone.
  assert.throws(() => opsToReparent(doc, schema, 'upper', 'lower'), /cuelga de "upper"/);
  const other = op(doc, { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'x_bone', parent: 'otro' });
  assert.throws(() => opsToReparent(other, schema, 'finger', 'x_bone'), /es de otro skeleton \(otro\)/);
  assert.throws(() => opsToReparent(doc, schema, 'hand', 'upper'), /no es un hueso/);
  assert.deepEqual(opsToReparent(doc, schema, 'finger', 'rig'), []);
});

test('los huesos dibujados encima siguen al skeleton cuando una pose lo mueve', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { x: 10, y: 10, length: 50 } },
    { op: 'create', type: 'pose', id: 'mv', props: { values: { rig: { x: 200 } } } },
  );
  const svg = svgDocument(doc, schema, { pose: 'mv', bones: true });
  assert.match(svg, /data-id="rig" transform="translate\(200 0\)"/);
  assert.match(svg, /<circle cx="210" cy="10"/);
});

test('reparentar varios huesos seguidos conservando las poses (Reparent Bone con varios elegidos)', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { from: [0, 0], to: [100, 0] } },
    { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { from: [100, 0], to: [200, 0] } },
    { op: 'create', type: 'bone', id: 'c', parent: 'a', props: { from: [100, 0], to: [100, 100] } },
    { op: 'create', type: 'bone', id: 'z', parent: 'rig', props: { from: [0, 200], to: [100, 200] } },
    { op: 'create', type: 'pose', id: 'up', props: { values: { a: { rotation: -90 } } } },
  );
  const world = (d, id) => evaluateInPose(d, schema, findObject(d, 'up')).posed.get(id).map((v) => Math.round(v * 100) / 100);
  const steps = [['b', 'z'], ['c', 'z']];
  // Without keeping: both move in "up" (they stop following "a"), and it warns only once.
  const notice = reparentSeveral(doc, schema, steps);
  assert.deepEqual(notice.moved, ['up']);
  const moved = op(doc, ...notice.ops);
  assert.notDeepEqual(world(moved, 'b'), world(doc, 'b'));
  // Keeping: both stay where they were in the pose, and hang from z.
  const still = reparentSeveral(doc, schema, steps, { keepInPoses: true });
  assert.deepEqual(still.moved, []);
  const after = op(doc, ...still.ops);
  assert.deepEqual([findObject(after, 'b').parent, findObject(after, 'c').parent], ['z', 'z']);
  for (const id of ['b', 'c']) assert.deepEqual(world(after, id), world(doc, id));
});

test('planes compartidos: reparentar varios, enlazar por cercanía, soltar al mover y por qué no se enlaza', async () => {
  const { reasonNotToBind, opsToReleaseOnMove, planProximityBinding, planReparentBones } = await import('../src/core/skeleton.js');
  const doc = op(arm(), { op: 'create', type: 'bone', id: 'finger', parent: 'rig', props: { x: 190, y: 100, length: 10 } }, { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'tail_bone', parent: 'otro' });
  // Hang finger from lower (the main one): a batch that applies without errors and leaves it as a child.
  const plan = planReparentBones(doc, schema, ['finger', 'lower'], 'lower');
  assert.equal(plan.parent.id, 'lower');
  assert.deepEqual(plan.children.map((h) => h.id), ['finger']);
  assert.equal(plan.problem, null);
  assert.equal(findObject(op(doc, ...plan.ops), 'finger').parent, 'lower');
  assert.ok(Array.isArray(plan.ops.moved));
  // lower hangs from upper: it can be released to the root of the skeleton.
  assert.deepEqual(plan.loose.map((h) => h.id), ['lower']);
  assert.equal(findObject(op(doc, ...plan.releaseOps), 'lower').parent, 'rig');
  // Problems: another skeleton, or the parent hangs from the child.
  assert.match(planReparentBones(doc, schema, ['tail_bone', 'lower'], 'lower').problem, /another skeleton/);
  assert.match(planReparentBones(doc, schema, ['upper', 'lower'], 'lower').problem, /lower hangs from upper/);
  // Bind by proximity: finger and hand are already covered or get bound; the batch is of set bone.
  const bind = planProximityBinding(op(doc, { op: 'create', type: 'rect', id: 'chip', parent: 'rig', props: { x: 120, y: 100, width: 4, height: 4 } }), schema, 'rig');
  assert.deepEqual(bind.ops, bind.bindings.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })));
  assert.ok(bind.bindings.some((e) => e.id === 'chip' && e.bone === 'upper'));
  // Taking the hand out of the skeleton releases its bone; why something from outside cannot be bound.
  assert.deepEqual(opsToReleaseOnMove(doc, schema, 'hand', null), [{ op: 'unset', target: 'hand', props: ['bone'] }]);
  assert.equal(reasonNotToBind(doc, 'hand', 'lower'), null);
  assert.match(reasonNotToBind(doc, 'hand', 'tail_bone'), /hand is in skeleton rig/);
});
