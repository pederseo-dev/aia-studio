import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { findObject, newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { pointsError, resolveDoc, settleOps } from '../src/core/points.js';
import { drawDocument } from '../src/core/draw.js';
import { copyOps } from '../src/core/copy.js';
import { deletePointsOps, namePoint } from '../src/core/weld.js';
import { gapAt, shapeFromPointsOps } from '../src/core/fill.js';
import { edgeOps, hiddenStretches, stretchBetweenPoints, stretchNear } from '../src/core/edges.js';
import { insertVertex, translate } from '../src/core/geometry.js';

const schema = loadSchema();
const apply = (doc, ops) => applyOps(schema, doc, ops).document;
const loose = (doc, ops) => applyOps(schema, doc, ops, { checkPoints: false }).document;
/** Applies a batch as the store does (settled), and checks the points. */
const settled = (doc, ops) => {
  const after = apply(doc, settleOps(doc, ops, loose));
  assert.equal(pointsError(after), null);
  return after;
};
/** @param {any} doc @param {string} id @returns {any} */
const find = (doc, id) => findObject(doc, id);

/** A layer "ink" with these parts. @param {Record<string, unknown>[]} parts */
const layer = (...parts) =>
  apply(newDocument(), [
    { op: 'create', type: 'vector', id: 'ink' },
    ...parts.map(({ id, ...props }) => ({ op: 'create', type: 'path', id, parent: 'ink', props })),
  ]);
const square = { id: 'box', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };

/** The drawn node of a part. */
const nodeOf = (doc, id) => drawDocument(doc).nodes[0].children.find((n) => n.attrs['data-id'] === id);

/** Hides (or shows) a stretch and returns the document after it. */
const hide = (doc, stretch, on = true) => settled(doc, edgeOps(resolveDoc(doc), stretch, on).ops);

test('hiding a stretch of an element names its ends and draws the fill whole and the stroke open there', () => {
  const doc = layer(square);
  assert.equal(nodeOf(doc, 'box').tag, 'path', 'one path while nothing is hidden');
  const after = hide(doc, { part: 'box', hole: -1, index: 1 });
  const box = find(after, 'box');
  assert.deepEqual(box.hiddenEdges, [['box.box_1', 'box.box_2']]);
  assert.deepEqual([box.vertices[1].name, box.vertices[2].name], ['box_1', 'box_2']);
  const node = nodeOf(after, 'box');
  assert.equal(node.tag, 'g');
  const [fill, stroke] = node.children;
  assert.match(String(fill.attrs.d), /Z$/, 'the fill is whole');
  assert.equal(fill.attrs.stroke, undefined);
  assert.equal(stroke.attrs.fill, 'none');
  assert.equal(stroke.attrs.d, 'M100 100L0 100L0 0L100 0', 'one run, from after the hidden stretch round to its start');
  assert.equal(stroke.attrs['data-id'], 'box', 'picked by its stroke');
  assert.deepEqual(hiddenStretches(find(resolveDoc(after), 'box')), [{ part: 'box', hole: -1, index: 1 }]);
  // Shown again: one path, as before (the names stay).
  const shown = hide(after, { part: 'box', hole: -1, index: 1 }, false);
  assert.equal(find(shown, 'box').hiddenEdges, undefined);
  assert.equal(nodeOf(shown, 'box').tag, 'path');
  assert.throws(() => edgeOps(resolveDoc(shown), { part: 'box', hole: -1, index: 1 }, false), /shown already/);
});

test('an open line with a hidden middle stretch draws two runs', () => {
  const line = { id: 'line', closed: false, fill: null, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }] };
  const after = hide(layer(line), { part: 'line', hole: -1, index: 1 });
  const stroke = nodeOf(after, 'line').children;
  assert.equal(stroke.length, 1, 'no fill path for a line without fill');
  assert.equal(stroke[0].attrs.d, 'M0 0L10 0M20 0L30 0');
});

test('a shape’s stroke hides a piece of the line it follows, between two of the line’s points', () => {
  const doc = layer(square);
  const nodes = /** @type {any} */ (gapAt(resolveDoc(doc), 'ink', { x: 50, y: 50 })).nodes;
  const shaped = apply(doc, shapeFromPointsOps(resolveDoc(doc), 'ink', nodes, { fill: '#ff0000', stroke: '#000000' }).ops);
  const resolved = resolveDoc(shaped);
  // The stretch between the square's points 2 and 3, by their names (part.index works too).
  const stretch = stretchBetweenPoints(resolved, 'box_stroke', { part: 'box', index: 2 }, { part: 'box', index: 3 });
  const after = hide(shaped, stretch);
  const edge = find(after, 'box_stroke').hiddenEdges[0];
  const named = find(after, 'box').vertices;
  assert.deepEqual([...edge].sort(), [`box.${named[2].name}`, `box.${named[3].name}`].sort(), 'the line’s point 3 got a name');
  assert.equal(find(after, 'box_fill').hiddenEdges, undefined, 'the fill part is not changed');
  assert.equal(nodeOf(after, 'box_stroke').tag, 'g');
  assert.equal(nodeOf(after, 'box').tag, 'path', 'the line itself is not changed');
  assert.throws(() => stretchBetweenPoints(resolved, 'box_stroke', { part: 'box', index: 0 }, { part: 'box', index: 2 }), /no stretch between/);
  // Found by the pointer, too: the bottom side.
  assert.deepEqual(stretchNear(find(resolveDoc(after), 'box_stroke'), { x: 50, y: 102 }, 5)?.index, stretch.index);
});

test('renaming a part or a point renames the pairs; a pair the batch makes stale is dropped', () => {
  let doc = hide(layer(square), { part: 'box', hole: -1, index: 1 });
  doc = apply(doc, [{ op: 'rename', target: 'box', id: 'frame' }]);
  assert.deepEqual(find(doc, 'frame').hiddenEdges, [['frame.box_1', 'frame.box_2']]);
  doc = settled(doc, namePoint(resolveDoc(doc), { part: 'frame', index: 1 }, 'top_right').ops);
  assert.deepEqual(find(doc, 'frame').hiddenEdges, [['frame.top_right', 'frame.box_2']]);
  assert.throws(() => namePoint(resolveDoc(doc), { part: 'frame', index: 1 }, ''), /hidden edge/);
  // A point added between the two ends: they are no longer next to each other.
  const added = insertVertex(find(doc, 'frame'), 1, 0.5).vertices;
  assert.equal(find(settled(doc, [{ op: 'set', target: 'frame', props: { vertices: added } }]), 'frame').hiddenEdges, undefined);
  // An end deleted.
  const { ops } = deletePointsOps(resolveDoc(doc), [{ part: 'frame', index: 2 }]);
  assert.equal(find(settled(doc, ops), 'frame').hiddenEdges, undefined);
});

test('pairs are checked: two different named points, next to each other along the stroke', () => {
  const doc = layer({ ...square, vertices: square.vertices.map((v, i) => ({ ...v, name: `p${i}` })) });
  const refuses = (edges, pattern) => assert.throws(() => apply(doc, [{ op: 'set', target: 'box', props: { hiddenEdges: edges } }]), pattern);
  refuses([['box.p0', 'box.p2']], /draws no stretch between/);
  refuses([['box.p0', 'box.p0']], /same point twice/);
  refuses([['box.p0', 'box.p1'], ['box.p1', 'box.p0']], /there twice/);
  refuses([['box.p0']], /pairs of points/);
  refuses([['box.p0', 'box.nope']], /draws no stretch/);
  assert.equal(apply(doc, [{ op: 'set', target: 'box', props: { hiddenEdges: [['box.p3', 'box.p0']] } }]).objects.length, 2, 'the closing side counts');
  // A batch that writes a wrong pair itself is refused, not cleaned.
  assert.throws(() => apply(doc, settleOps(doc, [{ op: 'set', target: 'box', props: { hiddenEdges: [['box.p0', 'box.p2']] } }], loose)), /draws no stretch/);
});

test('a copy keeps its hidden stretches, on its own points', () => {
  const doc = hide(layer(square), { part: 'box', hole: -1, index: 2 });
  const resolved = resolveDoc(doc);
  const { ops } = copyOps(resolved, [find(resolved, 'box')], translate(200, 0));
  const copied = apply(doc, ops);
  const copy = find(copied, ops[0].id);
  assert.equal(copy.hiddenEdges.length, 1);
  assert.ok(copy.hiddenEdges[0].every((p) => p.startsWith(`${copy.id}.`)));
  assert.equal(nodeOf(copied, copy.id).tag, 'g');
});

test('welding an end of a hidden edge into another point renames the pair; a pair left with one point twice is dropped', async () => {
  const { weld } = await import('../src/core/weld.js');
  const named = { ...square, vertices: square.vertices.map((v, i) => ({ ...v, name: `p${i}` })) };
  const doc = apply(layer(named, { id: 'dot', closed: false, fill: null, vertices: [{ x: 100, y: 0, name: 'q' }, { x: 150, y: 0 }] }), [{ op: 'set', target: 'box', props: { hiddenEdges: [['box.p1', 'box.p2']] } }]);
  // box.p1 shares dot.q from now on: the pair names dot.q.
  const welded = settled(doc, weld(resolveDoc(doc), { part: 'box', index: 1 }, { part: 'dot', index: 0 }).ops);
  assert.deepEqual(find(welded, 'box').hiddenEdges, [['dot.q', 'box.p2']]);
  assert.equal(nodeOf(welded, 'box').tag, 'g', 'still hidden');
});

test('a stretch of a hole between its own points cannot be hidden (they take no names)', () => {
  const doc = layer({ ...square, holes: [[{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }]] });
  assert.throws(() => edgeOps(resolveDoc(doc), { part: 'box', hole: 0, index: 0 }, true), /take no names/);
});

test('renaming a point a hole shares renames the hole’s ref, and keeps the name while a hole shares it', () => {
  const inner = { id: 'inn', vertices: [{ x: 30, y: 30, name: 'e' }, { x: 70, y: 30, name: 'f' }, { x: 70, y: 70, name: 'g' }] };
  const doc = apply(layer(square, inner), [{ op: 'create', type: 'path', id: 'ring', parent: 'ink', props: { vertices: square.vertices, holes: [[{ ref: 'inn.e' }, { ref: 'inn.f' }, { ref: 'inn.g' }]] } }]);
  const renamed = settled(doc, namePoint(resolveDoc(doc), { part: 'inn', index: 0 }, 'lefty').ops);
  assert.equal(find(renamed, 'ring').holes[0][0].ref, 'inn.lefty', 'the hole is kept');
  assert.throws(() => namePoint(resolveDoc(renamed), { part: 'inn', index: 0 }, ''), /keeps a name/);
});

test('a batch that writes a pair its own changes make stale is refused, not emptied', () => {
  const doc = hide(layer({ ...square, vertices: square.vertices.map((v, i) => ({ ...v, name: `p${i}` })) }), { part: 'box', hole: -1, index: 0 });
  const added = insertVertex(find(doc, 'box'), 1, 0.5).vertices;
  const ops = [{ op: 'set', target: 'box', props: { vertices: added, hiddenEdges: [['box.p0', 'box.p1'], ['box.p1', 'box.p2']] } }];
  assert.throws(() => apply(doc, settleOps(doc, ops, loose)), /draws no stretch/);
});

test('joining two lines or closing one keeps their hidden edges', async () => {
  const { weld } = await import('../src/core/weld.js');
  const line = (id, x) => ({ id, closed: false, fill: null, vertices: [0, 1, 2].map((i) => ({ x: x + i * 10, y: i * 5, name: `${id}${i}` })) });
  let doc = apply(layer(line('a', 0), line('b', 40)), [
    { op: 'set', target: 'a', props: { hiddenEdges: [['a.a0', 'a.a1']] } },
    { op: 'set', target: 'b', props: { hiddenEdges: [['b.b1', 'b.b2']] } },
  ]);
  doc = settled(doc, weld(resolveDoc(doc), { part: 'a', index: 2 }, { part: 'b', index: 0 }, { merge: true }).ops);
  assert.deepEqual(find(doc, 'b').hiddenEdges, [['b.b1', 'b.b2'], ['b.a0', 'b.a1']]);
  // Closing: the end that goes away hands its pairs to the one that stays.
  const ends = find(doc, 'b').vertices.length - 1;
  doc = settled(doc, weld(resolveDoc(doc), { part: 'b', index: ends }, { part: 'b', index: 0 }).ops);
  assert.equal(find(doc, 'b').closed, undefined);
  assert.equal(find(doc, 'b').hiddenEdges.length, 2);
});
