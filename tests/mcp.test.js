import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { findObject, createDocument, validate } from '../src/core/document.js';
import { evaluateInPose, tipOf } from '../src/core/skeleton.js';
import { guideForAI } from '../src/core/guide.js';
import { applyOperations } from '../src/core/operations.js';
import { mergePose, opsToSetPose as setPoseOps } from '../src/core/blend.js';
import { checkDeleted, treeOutline, planBindByProximity, planBindPoints, planReparentBone, poseClamps } from '../mcp/tools.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;

test('cada bloque JSON de la guía se aplica sin errores', () => {
  const blocks = [...guideForAI(schema).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 4);
  // What the examples assume already exists in the character.
  const base = op(
    createDocument({}),
    { op: 'create', type: 'group', id: 'body' },
    { op: 'create', type: 'group', id: 'head' },
    { op: 'create', type: 'group', id: 'arm_l' },
    { op: 'create', type: 'path', id: 'mouth_line', props: { d: 'M-20 0 L20 0', closed: false } },
    { op: 'create', type: 'rect', id: 'brow_l' },
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
  );
  for (const [i, block] of blocks.entries()) {
    if (block.format) {
      // The full document example.
      assert.deepEqual(validate(block, schema).errors, [], `bloque ${i}`);
      continue;
    }
    const ops = Array.isArray(block) ? block : [block];
    assert.doesNotThrow(() => op(base, ...ops), `bloque ${i}`);
  }
});

test('set_pose suma a lo que había, saca objetos con {} y un d reemplaza los vértices', () => {
  const previous = { head_bone: { rotation: 10 }, mouth: { active: 'a' }, smile: { vertices: [{ x: 0, y: 0 }], opacity: 0.5 } };
  assert.deepEqual(mergePose(previous, { head_bone: { x: 5 }, mouth: {}, smile: { d: 'M0 0 L1 1' } }), {
    head_bone: { rotation: 10, x: 5 },
    smile: { opacity: 0.5, d: 'M0 0 L1 1' },
  });
  assert.deepEqual(mergePose(previous, { head_bone: { x: 5 } }, true), { head_bone: { x: 5 } });
  // The batch: create if it does not exist, set if it does; and it does not overwrite an object that is not a pose.
  const doc = op(createDocument({}), { op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'path', id: 'smile', props: { d: 'M0 0 L10 0' } });
  assert.equal(setPoseOps(doc, 'happy', { r: { x: 1 } })[0].op, 'create');
  assert.throws(() => setPoseOps(doc, 'r', {}), /already exists and is a rect/);
  const withPose = op(doc, ...setPoseOps(doc, 'happy', { smile: { d: 'M0 5 L10 5' } }));
  assert.deepEqual(findObject(withPose, 'happy').values.smile.vertices.map((v) => v.y), [5, 5]);
});

test('set_pose avisa lo que recortan minAngle y maxAngle', () => {
  const doc = op(createDocument({}), { op: 'create', type: 'skeleton', id: 'rig' }, { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { minAngle: -20, maxAngle: 20 } });
  assert.deepEqual(poseClamps(doc, schema, { b: { rotation: 45 } }), ['b.rotation 45 queda en 20 por minAngle/maxAngle']);
  assert.deepEqual(poseClamps(doc, schema, { b: { rotation: 10 } }), []);
});

function rig() {
  return op(
    createDocument({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { from: [0, 0], to: [100, 0] } },
    { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { from: [100, 0], to: [200, 0] } },
    { op: 'create', type: 'rect', id: 'near_a', parent: 'rig', props: { x: 40, y: 5, width: 10, height: 10 } },
    { op: 'create', type: 'rect', id: 'near_b', parent: 'rig', props: { x: 160, y: 5, width: 10, height: 10 } },
    { op: 'create', type: 'path', id: 'tail', parent: 'rig', props: { d: 'M0 0 L90 0 L190 0', closed: false } },
  );
}

test('bind_points y bind_by_proximity reparten por cercanía', () => {
  const doc = rig();
  const points = planBindPoints(doc, schema, 'tail');
  assert.equal(points.distribution, 'a [0, 1]; b [2]');
  assert.throws(() => planBindPoints(doc, schema, 'near_a'), /no es un path/);
  assert.equal(planBindByProximity(doc, schema, 'rig').distribution, 'a ← near_a, tail; b ← near_b');
  // A path bound per point is not touched; after binding, nothing is left.
  const byPoint = op(doc, ...points.ops);
  const near = planBindByProximity(byPoint, schema, 'rig');
  assert.equal(near.distribution, 'a ← near_a; b ← near_b');
  const bound = op(byPoint, ...near.ops);
  assert.equal(planBindByProximity(bound, schema, 'rig').ops.length, 0);
});

test('reparent_bone avisa en qué poses el hueso cambia de lugar y, si se pide, las compensa', () => {
  const doc = op(rig(), { op: 'create', type: 'pose', id: 'up', props: { values: { a: { rotation: -90 } } } }, { op: 'create', type: 'pose', id: 'bend', props: { values: { b: { rotation: 30 } } } });
  const tip = (d, pose) => tipOf(schema, findObject(d, 'b'), evaluateInPose(d, schema, findObject(d, pose)).posed.get('b')).map(Math.round);
  assert.deepEqual(tip(doc, 'up'), [0, -200]);
  // Without compensating: in "up" (which turns the old parent) the bone ends up elsewhere, and the response says so.
  const notice = planReparentBone(doc, schema, 'b', 'rig');
  assert.deepEqual(notice.moved, ['up']);
  assert.match(notice.text, /en las poses up ahora queda en otro lugar/);
  assert.deepEqual(tip(op(doc, ...notice.ops), 'bend'), tip(doc, 'bend'));
  // Compensating: it stays where it was in all poses.
  const still = planReparentBone(doc, schema, 'b', 'rig', true);
  assert.deepEqual(still.moved, []);
  const after = op(doc, ...still.ops);
  assert.deepEqual(tip(after, 'up'), [0, -200]);
  assert.deepEqual(tip(after, 'bend'), tip(doc, 'bend'));
  assert.equal(planReparentBone(doc, schema, 'b', 'a').ops.length, 0);
});


test('el switch se maneja igual en el editor y en el MCP: set active, sin herramienta aparte', () => {
  const guide = guideForAI(schema);
  assert.doesNotMatch(guide, /create_switch_control|Create control/);
  assert.match(guide, /`set` con `\{ "active": "<hijo>" \}`/);
  // What the editor's picker does (chooseVariant) is this same set.
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'set', target: 'mouth', props: { active: 'mouth_o' } },
  );
  assert.equal(findObject(doc, 'mouth').active, 'mouth_o');
});

test('set_pose con remove saca una sola propiedad, y así la variante puede salir del switch', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'create', type: 'pose', id: 'turn', props: { values: { mouth: { x: 12, active: 'mouth_o' } } } },
  );
  assert.throws(() => op(doc, { op: 'move', target: 'mouth_o', parent: null }), /remove: \["mouth\.active"\]/);
  // {} would also remove x; remove removes only active.
  assert.deepEqual(mergePose(findObject(doc, 'turn').values, { mouth: {} }), {});
  const withoutActive = op(doc, ...setPoseOps(doc, 'turn', {}, false, ['mouth.active']));
  assert.deepEqual(findObject(withoutActive, 'turn').values, { mouth: { x: 12 } });
  assert.doesNotThrow(() => op(withoutActive, { op: 'move', target: 'mouth_o', parent: null }));
  // An id alone removes the whole object; a malformed name warns.
  assert.deepEqual(mergePose({ a: { x: 1 }, b: { y: 2 } }, {}, false, ['a']), { b: { y: 2 } });
  assert.throws(() => mergePose({}, {}, false, ['a.b.c']), /should be "object\.property"/);
});

test('delete_document pide repetir el id en confirm', () => {
  assert.doesNotThrow(() => checkDeleted('prueba_x', 'prueba_x'));
  assert.throws(() => checkDeleted('prueba_x', 'otro'), /confirm has to be "prueba_x"/);
  assert.throws(() => checkDeleted('prueba_x', undefined), /can't be undone/);
});

test('el árbol dice qué params eligen la variante de un switch', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'create', type: 'param', id: 'viseme', props: { kind: 'enum', options: ['a', 'o'] } },
    { op: 'create', type: 'pose', id: 'viseme_o', props: { values: { mouth: { active: 'mouth_o' } } } },
    { op: 'create', type: 'driver', id: 'viseme_o_driver', props: { param: 'viseme', pose: 'viseme_o', equals: 'o' } },
    { op: 'create', type: 'switch', id: 'eyes' },
  );
  const tree = treeOutline(doc, schema);
  assert.match(tree, /- mouth \(switch\) \(muestra el primero; lo elige el param viseme\)/);
  assert.match(tree, /- eyes \(switch\) \(muestra el primero\)/);
});

test('lecturas del MCP sin el servidor: get_document, get_history y render_preview', async () => {
  const { planPreview, historySummary, documentText } = await import('../mcp/tools.js');
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'rect', id: 'r', props: { x: 1 } },
    { op: 'create', type: 'pose', id: 'up', props: { values: { r: { y: 5 } } } },
    { op: 'create', type: 'param', id: 'p' },
    { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'up' } },
  );
  // get_document: tree and JSON; without JSON if requested.
  assert.match(documentText(doc, schema), /^Árbol \(del fondo al frente\):[\s\S]*JSON:\n\{/);
  assert.doesNotMatch(documentText(doc, schema, { json: false }), /JSON:/);
  // get_history: filters by origin, truncates and summarizes what each batch touched.
  const entries = [
    { n: 1, origin: 'ai', note: 'a', ops: [{ op: 'set', target: 'r', props: { x: 2, vertices: [1, 2, 3] } }], inverses: [] },
    { n: 2, origin: 'user', note: 'b', ops: [{ op: 'set', target: 'r', props: { y: 3 } }], inverses: [] },
  ];
  const summary = historySummary(entries, { origin: 'ai' });
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].values, { 'r.x': 2, 'r.vertices': '(3 elementos)' });
  assert.equal(summary[0].inverses, undefined);
  assert.deepEqual(historySummary(entries, { limit: 1, detail: true })[0].ops, entries[1].ops);
  // render_preview: the setup, a pose, params with their weights, and clear errors.
  assert.match(planPreview(doc, schema).text, /en el montaje/);
  assert.match(planPreview(doc, schema, { pose: 'up' }).text, /en la pose "up"/);
  assert.match(planPreview(doc, schema, { params: { p: 1 } }).text, /poses: up 100%/);
  assert.equal(planPreview(doc, schema).width, 600);
  assert.throws(() => planPreview(doc, schema, { pose: 'nada' }), /no existe la pose "nada"/);
  assert.throws(() => planPreview(doc, schema, { params: { q: 1 } }), /no existe el param "q"/);
});
