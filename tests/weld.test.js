import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { resolveDoc, settleOps } from '../src/core/points.js';
import { WeldError, followOps, groupOps, namePoint, shareTargets, unweld, weld } from '../src/core/weld.js';

const schema = loadSchema();
const loose = (doc, ops) => applyOps(schema, doc, ops, { checkPoints: false }).document;
/** Applies a batch as the store does: settled, then checked. */
const save = (doc, ops) => applyOps(schema, doc, settleOps(doc, ops, loose)).document;

/** A layer with a jaw (3 points, the middle one named chin), a mouth line and a brow line. */
function face() {
  return applyOps(schema, newDocument(), [
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { vertices: [{ x: 0, y: 0 }, { x: 50, y: 80, name: 'chin' }, { x: 100, y: 0 }] } },
    { op: 'create', type: 'path', id: 'mouth', parent: 'head', props: { closed: false, fill: null, vertices: [{ x: 20, y: 40 }, { x: 45, y: 75, name: 'corner' }] } },
    { op: 'create', type: 'path', id: 'brow', parent: 'head', props: { closed: false, fill: null, vertices: [{ x: 10, y: -20 }, { x: 90, y: -20 }] } },
  ]).document;
}
const vertices = (doc, id) => doc.objects.find((o) => o.id === id).vertices;
/** Runs a weld function on the resolved document and saves what it returns. */
const run = (doc, make) => {
  const result = make(resolveDoc(doc));
  return save(doc, Array.isArray(result) ? result : result.ops);
};

test('weld shares a point, names an unnamed target, and moves whoever shared the welded point', () => {
  // brow.0 shares mouth.corner, then mouth.corner itself is welded to jaw.0: brow follows to jaw's point.
  let doc = run(face(), (d) => weld(d, { part: 'brow', index: 0 }, { part: 'mouth', index: 1 }));
  assert.deepEqual(vertices(doc, 'brow')[0], { ref: 'mouth.corner' });
  doc = run(doc, (d) => weld(d, { part: 'mouth', index: 1 }, { part: 'jaw', index: 0 }));
  assert.deepEqual(vertices(doc, 'jaw')[0], { name: 'jaw_1', x: 0, y: 0 });
  assert.deepEqual(vertices(doc, 'mouth')[1], { ref: 'jaw.jaw_1' });
  assert.deepEqual(vertices(doc, 'brow')[0], { ref: 'jaw.jaw_1' });
});

test('weld onto a line adds a point there; the ends of one line close it; --join makes two lines one', () => {
  let doc = run(face(), (d) => weld(d, { part: 'brow', index: 1 }, { part: 'jaw', segment: 1, t: 0.5 }));
  assert.equal(vertices(doc, 'jaw').length, 4);
  assert.deepEqual(vertices(doc, 'brow')[1], { ref: 'jaw.jaw_1' });
  assert.deepEqual(vertices(doc, 'jaw')[2], { name: 'jaw_1', x: 75, y: 40 });
  const closed = run(face(), (d) => weld(d, { part: 'mouth', index: 0 }, { part: 'mouth', index: 1 }));
  assert.equal(closed.objects.find((o) => o.id === 'mouth').closed, undefined);
  const joined = run(face(), (d) => weld(d, { part: 'brow', index: 1 }, { part: 'mouth', index: 0 }, { merge: true }));
  assert.equal(joined.objects.find((o) => o.id === 'brow'), undefined);
  assert.equal(vertices(joined, 'mouth').length, 3);
  assert.throws(() => weld(resolveDoc(face()), { part: 'jaw', index: 0 }, { part: 'jaw', index: 1 }), WeldError);
});

test('unweld, naming a point and groups keep every reference coherent', () => {
  let doc = run(face(), (d) => weld(d, { part: 'mouth', index: 1 }, { part: 'jaw', index: 1 }));
  doc = run(doc, (d) => groupOps(d, 'head', 'set', 'lower', [{ part: 'jaw', index: 1 }, { part: 'mouth', index: 0 }]).ops);
  assert.deepEqual(doc.objects[0].groups, { lower: ['jaw.chin', 'mouth.mouth_1'] });
  doc = run(doc, (d) => namePoint(d, { part: 'jaw', index: 1 }, 'Chin Tip').ops);
  assert.deepEqual(vertices(doc, 'mouth')[1], { ref: 'jaw.chin_tip' });
  assert.deepEqual(doc.objects[0].groups, { lower: ['jaw.chin_tip', 'mouth.mouth_1'] });
  assert.throws(() => namePoint(resolveDoc(doc), { part: 'jaw', index: 1 }, ''), /keeps a name/);
  doc = run(doc, (d) => unweld(d, [{ part: 'jaw', index: 1 }]));
  assert.deepEqual(vertices(doc, 'mouth')[1], { x: 50, y: 80 });
  assert.throws(() => unweld(resolveDoc(doc), [{ part: 'jaw', index: 1 }]), /none of these points is welded/);
});

test('follow needs two neighbor points that share points of one other part', () => {
  let doc = save(face(), [{ op: 'create', type: 'path', id: 'skin', parent: 'head', props: { vertices: [{ ref: 'jaw.chin' }, { x: 0, y: 0 }, { x: 0, y: 100 }] } }]);
  assert.throws(() => followOps(resolveDoc(doc), { part: 'skin', index: 0 }, { part: 'skin', index: 1 }, 'short'), /weld them first/);
  doc = run(doc, (d) => weld(d, { part: 'skin', index: 1 }, { part: 'jaw', index: 0 }));
  doc = run(doc, (d) => followOps(d, { part: 'skin', index: 1 }, { part: 'skin', index: 0 }, 'short').ops);
  // The stretch goes from skin.0 to skin.1, whichever was named first.
  assert.deepEqual(vertices(doc, 'skin')[0], { ref: 'jaw.chin', follow: 'jaw' });
  assert.deepEqual(vertices(doc, 'skin')[1], { ref: 'jaw.jaw_1' });
});

test('shareTargets welds several new vertices at once, on points and on lines of the same part', () => {
  const doc = resolveDoc(face());
  const { ops, refs } = shareTargets(doc, [{ part: 'jaw', segment: 0, t: 0.5 }, null, { part: 'jaw', index: 2 }]);
  assert.deepEqual(refs, ['jaw.jaw_1', null, 'jaw.jaw_2']);
  const after = save(face(), ops);
  assert.deepEqual(vertices(after, 'jaw').map((v) => v.name ?? null), [null, 'jaw_1', 'chin', 'jaw_2']);
});
