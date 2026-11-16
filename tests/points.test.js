import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { drawDocument } from '../src/core/draw.js';
import { movePointsOps, pointsNamed, resolveDoc, settleOps, syncShared } from '../src/core/points.js';

const schema = loadSchema();
const apply = (doc, ops) => applyOps(schema, doc, ops).document;
const loose = (doc, ops) => applyOps(schema, doc, ops, { checkPoints: false }).document;

/** A layer with a jaw (its chin named) and a mouth line whose end shares the chin. */
function face() {
  return apply(newDocument(), [
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { vertices: [{ x: 0, y: 0 }, { x: 50, y: 80, name: 'chin' }, { x: 100, y: 0 }] } },
    { op: 'create', type: 'path', id: 'mouth', parent: 'head', props: { closed: false, fill: null, vertices: [{ x: 20, y: 40 }, { ref: 'jaw.chin', in: { x: -5, y: 0 } }] } },
  ]);
}
const vertex = (doc, id, i) => doc.objects.find((o) => o.id === id).vertices[i];

test('a shared vertex sits where the point it shares is', () => {
  const doc = face();
  assert.deepEqual(vertex(doc, 'mouth', 1), { ref: 'jaw.chin', in: { x: -5, y: 0 } });
  assert.deepEqual(vertex(resolveDoc(doc), 'mouth', 1), { ref: 'jaw.chin', in: { x: -5, y: 0 }, x: 50, y: 80 });
  const mouth = drawDocument(doc).nodes[0].children[1];
  assert.match(String(mouth.attrs.d), /50 80$/);
});

test('broken points are refused with a message that says why', () => {
  const doc = face();
  const refuses = (ops, pattern) => assert.throws(() => apply(doc, ops), pattern);
  refuses([{ op: 'set', target: 'mouth', props: { vertices: [{ x: 0, y: 0 }, { ref: 'jaw.nose' }] } }], /no such point/);
  refuses([{ op: 'set', target: 'mouth', props: { vertices: [{ x: 0, y: 0 }, { ref: 'jaw.chin', x: 1, y: 2 }] } }], /no x, y of its own/);
  refuses([{ op: 'set', target: 'jaw', props: { vertices: [{ x: 0, y: 0, name: 'a' }, { x: 1, y: 1, name: 'a' }] } }], /two points named "a"/);
  refuses([{ op: 'delete', target: 'jaw' }], /no such point/);
  refuses([{ op: 'set', target: 'head', props: { groups: { lid: ['jaw.nose'] } } }], /no such point/);
  refuses([{ op: 'set', target: 'head', props: { groups: { Lid: ['jaw.chin'] } } }], /group name/);
});

test('renaming a part renames the points that name it', () => {
  let doc = apply(face(), [{ op: 'set', target: 'head', props: { groups: { lower: ['jaw.chin'] } } }]);
  doc = apply(doc, [{ op: 'rename', target: 'jaw', id: 'chin_part' }]);
  assert.equal(vertex(doc, 'mouth', 1).ref, 'chin_part.chin');
  assert.deepEqual(doc.objects.find((o) => o.id === 'head').groups, { lower: ['chin_part.chin'] });
});

test('moving a shared vertex in the editor moves the point it shares', () => {
  const doc = face();
  const resolved = resolveDoc(doc);
  const moved = /** @type {any[]} */ (resolved.objects.find((o) => o.id === 'mouth')?.vertices).map((v) => (v.ref ? { ...v, x: 60, y: 90 } : v));
  // While dragging, the jaw follows.
  const preview = syncShared({ ...resolved, objects: resolved.objects.map((o) => (o.id === 'mouth' ? { ...o, vertices: moved } : o)) }, resolved);
  assert.deepEqual([vertex(preview, 'jaw', 1).x, vertex(preview, 'jaw', 1).y], [60, 90]);
  // Saved: the shared vertex keeps no x, y; the chin moves.
  const after = apply(doc, settleOps(doc, [{ op: 'set', target: 'mouth', props: { vertices: moved } }], loose));
  assert.deepEqual(vertex(after, 'mouth', 1), { ref: 'jaw.chin', in: { x: -5, y: 0 } });
  assert.deepEqual(vertex(after, 'jaw', 1), { x: 60, y: 90, name: 'chin' });
});

test('deleting a shared point leaves its sharers where they were, and groups without it', () => {
  const doc = apply(face(), [{ op: 'set', target: 'head', props: { groups: { lower: ['jaw.chin'] } } }]);
  const after = apply(doc, settleOps(doc, [{ op: 'delete', target: 'jaw' }], loose));
  assert.deepEqual(vertex(after, 'mouth', 1), { x: 50, y: 80, in: { x: -5, y: 0 } });
  assert.deepEqual(after.objects.find((o) => o.id === 'head').groups, { lower: [] });
});

test('points are moved by name, by index or by group, and what shares them follows', () => {
  let doc = apply(face(), [{ op: 'set', target: 'head', props: { groups: { lower: ['jaw.chin'] } } }]);
  // A named point to a place: the mouth's end shares it.
  doc = apply(doc, movePointsOps(doc, pointsNamed(doc, ['jaw.chin']), { to: { x: 55, y: 90 } }));
  assert.deepEqual(vertex(resolveDoc(doc), 'mouth', 1), { ref: 'jaw.chin', in: { x: -5, y: 0 }, x: 55, y: 90 });
  // A shared vertex named by index moves the point it shares; a group and an index together move each point once.
  const points = pointsNamed(doc, ['mouth.1', 'head.lower', 'jaw.0']);
  assert.deepEqual(points, [{ part: 'jaw', index: 1 }, { part: 'jaw', index: 0 }]);
  doc = apply(doc, movePointsOps(doc, points, { by: { x: 10, y: -10 } }));
  assert.deepEqual(vertex(doc, 'jaw', 1), { x: 65, y: 80, name: 'chin' });
  assert.deepEqual(vertex(doc, 'jaw', 0), { x: 10, y: -10 });
  // Names that do not exist say what does.
  assert.throws(() => pointsNamed(doc, ['jaw.nose']), /named points: chin/);
  assert.throws(() => pointsNamed(doc, ['jaw.9']), /3 vertices \(0 to 2\)/);
  assert.throws(() => pointsNamed(doc, ['head.upper']), /groups: lower/);
  assert.throws(() => movePointsOps(doc, points, { to: { x: 0, y: 0 } }), /--by/);
});

/** A layer with a closed jaw of 4 points and a skin whose top stretch follows jaw from ear_l to ear_r through chin. */
function followed(way) {
  return apply(newDocument(), [
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { vertices: [
      { x: 0, y: 0, name: 'ear_l' }, { x: 50, y: 80, name: 'chin', in: { x: -20, y: 0 }, out: { x: 20, y: 0 } }, { x: 100, y: 0, name: 'ear_r' }, { x: 50, y: -60, name: 'top' },
    ] } },
    { op: 'create', type: 'path', id: 'skin', parent: 'head', props: { vertices: [
      { ref: 'jaw.ear_l', follow: 'jaw', ...(way ? { way } : {}) }, { ref: 'jaw.ear_r' }, { x: 50, y: 200 },
    ] } },
  ]);
}

test('a followed stretch draws along the other part, and changes with it', () => {
  const doc = followed();
  const skin = drawDocument(doc).nodes[0].children[1];
  // ear_l → chin (with its curve) → ear_r, then the skin's own point.
  assert.equal(skin.attrs.d, 'M0 0C0 0 30 80 50 80C70 80 100 0 100 0L50 200Z');
  // The long way goes over the top instead.
  assert.match(String(drawDocument(followed('long')).nodes[0].children[1].attrs.d), /^M0 0L50 -60L100 0/);
  // Curving the chin of jaw curves the skin too.
  const curved = apply(doc, [{ op: 'set', target: 'jaw', props: { vertices: [
    { x: 0, y: 0, name: 'ear_l' }, { x: 50, y: 90, name: 'chin', in: { x: -40, y: 0 }, out: { x: 40, y: 0 } }, { x: 100, y: 0, name: 'ear_r' }, { x: 50, y: -60, name: 'top' },
  ] } }]);
  assert.match(String(drawDocument(curved).nodes[0].children[1].attrs.d), /C0 0 10 90 50 90C90 90/);
});

test('a followed stretch needs both ends on the part it follows, and renaming keeps it', () => {
  const doc = followed();
  assert.throws(() => apply(doc, [{ op: 'set', target: 'skin', props: { vertices: [{ ref: 'jaw.ear_l', follow: 'jaw' }, { x: 9, y: 9 }, { x: 50, y: 200 }] } }]), /must both share points of jaw/);
  assert.throws(() => apply(doc, [{ op: 'set', target: 'skin', props: { vertices: [{ ref: 'jaw.ear_l', follow: 'nose' }, { ref: 'jaw.ear_r' }] } }]), /no such part/);
  assert.throws(() => apply(doc, [{ op: 'set', target: 'skin', props: { vertices: [{ x: 0, y: 0, way: 'long' }, { x: 1, y: 1 }] } }]), /"way" can only be "long", next to "follow"/);
  const renamed = apply(doc, [{ op: 'rename', target: 'jaw', id: 'mandible' }]);
  assert.deepEqual(vertex(renamed, 'skin', 0), { ref: 'mandible.ear_l', follow: 'mandible' });
});

test('deleting the followed part in the editor leaves a plain outline where it was', () => {
  const doc = followed();
  const after = apply(doc, settleOps(doc, [{ op: 'delete', target: 'jaw' }], loose));
  assert.deepEqual(vertex(after, 'skin', 0), { x: 0, y: 0 });
  assert.deepEqual(vertex(after, 'skin', 1), { x: 100, y: 0 });
});
