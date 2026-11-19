import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { childrenOf, findObject, newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { pointsError, resolveDoc, settleOps } from '../src/core/points.js';
import { drawDocument } from '../src/core/draw.js';
import { copyOps } from '../src/core/copy.js';
import { crossingsOf, fillOps, gapAt, insidePolygon, nodeKeys, partsToMove, shapeFromPointsOps, shapeOf, styleProps, weldCrossingOps } from '../src/core/fill.js';
import { ellipsePoints, outlineOf, round2, transformPart, translate } from '../src/core/geometry.js';

const schema = loadSchema();
const apply = (doc, ops) => applyOps(schema, doc, ops).document;
const loose = (doc, ops) => applyOps(schema, doc, ops, { checkPoints: false }).document;
/** @param {any} doc @param {string} id @returns {any} */
const find = (doc, id) => findObject(doc, id);
const STYLE = { fill: '#f0c040', stroke: null };

/** A layer "ink" with these parts. @param {Record<string, unknown>[]} parts */
const layer = (...parts) =>
  apply(newDocument(), [
    { op: 'create', type: 'vector', id: 'ink' },
    ...parts.map(({ id, ...props }) => ({ op: 'create', type: 'path', id, parent: 'ink', props })),
  ]);

const square = { id: 'box', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };

/** Fills at a place and returns the document after it, checked. */
function fill(doc, at, style = STYLE) {
  const result = fillOps(resolveDoc(doc), 'ink', at, styleProps(style));
  const after = apply(doc, result.ops);
  assert.equal(pointsError(after), null);
  return { after, ...result };
}

/** Whether the fill's drawn outline holds a place. */
const fillHolds = (doc, id, at) => {
  const part = find(resolveDoc(doc), id);
  return insidePolygon(outlineOf(part), at);
};

test('a click inside a shape fills it with a part that follows it, under it; its points get names', () => {
  const doc = layer(square);
  const { after, id, made } = fill(doc, { x: 50, y: 50 });
  assert.ok(made);
  assert.deepEqual(childrenOf(after, 'ink').map((o) => o.id), [id, 'box'], 'the fill goes under the line');
  const part = find(after, id);
  assert.equal(part.fill, '#f0c040');
  assert.equal(part.stroke, null);
  assert.ok(part.vertices.every((v) => v.ref && v.follow === 'box' && v.x === undefined));
  assert.ok(find(after, 'box').vertices.some((v) => v.name), 'the square got named points to share');
  assert.ok(fillHolds(after, id, { x: 50, y: 50 }) && fillHolds(after, id, { x: 95, y: 5 }), 'it covers the whole square');
  // Bending the square bends the fill.
  const bent = apply(after, [{ op: 'set', target: 'box', props: { vertices: find(after, 'box').vertices.map((v, i) => (i === 2 ? { ...v, x: 200, y: 200 } : v)) } }]);
  assert.ok(fillHolds(bent, id, { x: 150, y: 150 }));
});

test('outside every gap, or with lines that only cross, there is nothing to fill', () => {
  const doc = layer(square, { id: 'cut', closed: false, fill: null, vertices: [{ x: -20, y: 50 }, { x: 120, y: 50 }] });
  assert.match(String(/** @type {any} */ (gapAt(resolveDoc(doc), 'ink', { x: 300, y: 300 })).error), /no lines of ink close a gap/);
  // The line crosses the square without being welded: the gap is still the whole square.
  const gap = gapAt(resolveDoc(doc), 'ink', { x: 50, y: 25 });
  assert.ok(!('error' in gap));
  assert.ok(Math.abs(gap.area - 10000) < 1);
  assert.throws(() => fillOps(resolveDoc(doc), 'nope', { x: 1, y: 1 }, STYLE), /no vector layer "nope"/);
});

test('a line welded across a shape splits it into two gaps; each fill follows both lines', () => {
  const head = { id: 'head', vertices: ellipsePoints({ x: 0, y: 0, width: 200, height: 200 }, 8).map((v, i) => ({ ...v, name: `p${i}` })) };
  // From the left point of the head to the right one, curving down.
  const left = head.vertices.reduce((a, b) => (b.x < a.x ? b : a));
  const right = head.vertices.reduce((a, b) => (b.x > a.x ? b : a));
  const mouth = { id: 'mouth', closed: false, fill: null, vertices: [{ ref: `head.${left.name}`, out: { x: 50, y: 60 } }, { ref: `head.${right.name}`, in: { x: -50, y: 60 } }] };
  const doc = layer(head, mouth);
  const below = fill(doc, { x: 100, y: 180 });
  const above = fill(doc, { x: 100, y: 40 });
  for (const { after, id } of [below, above]) {
    const follows = new Set(find(after, id).vertices.map((v) => v.follow));
    assert.deepEqual([...follows].sort(), ['head', 'mouth']);
  }
  assert.ok(fillHolds(below.after, below.id, { x: 100, y: 180 }) && !fillHolds(below.after, below.id, { x: 100, y: 40 }));
  assert.ok(fillHolds(above.after, above.id, { x: 100, y: 40 }) && !fillHolds(above.after, above.id, { x: 100, y: 180 }));
  // The fill lies under the lowest line it follows.
  assert.equal(childrenOf(below.after, 'ink')[0].id, below.id);
});

test('an open end inside a gap does not cut it, and filling a filled gap recolors that fill', () => {
  const doc = layer(
    { ...square, vertices: square.vertices.map((v, i) => (i === 0 ? { ...v, name: 'tl' } : v)) },
    { id: 'hair', closed: false, fill: null, vertices: [{ ref: 'box.tl' }, { x: 50, y: 50 }] },
  );
  const first = fill(doc, { x: 80, y: 20 });
  assert.ok(fillHolds(first.after, first.id, { x: 20, y: 80 }), 'the whole square, around the open line');
  assert.ok(find(first.after, first.id).vertices.every((v) => v.follow === 'box'));
  const again = fill(first.after, { x: 20, y: 80 }, { fill: '#3366cc', stroke: '#000000', strokeWidth: 3 });
  assert.equal(again.made, false);
  assert.equal(again.id, first.id);
  assert.deepEqual(again.ops, [{ op: 'set', target: first.id, props: { fill: '#3366cc', stroke: '#000000', strokeWidth: 3 } }]);
  assert.equal(childrenOf(again.after, 'ink').length, 3, 'no new part');
});

test('a shape inside a gap is a hole of its fill; a shape inside that one is not', () => {
  const circle = (id, size) => ({ id, vertices: ellipsePoints({ x: 100 - size / 2, y: 100 - size / 2, width: size, height: size }, 4) });
  const doc = layer(circle('outer', 200), circle('inner', 100), circle('dot', 20));
  const ring = fill(doc, { x: 100, y: 20 });
  const part = find(ring.after, ring.id);
  assert.equal(part.holes.length, 1, 'the inner circle is a hole; the dot inside it is not');
  assert.ok(part.holes[0].every((v) => v.follow === 'inner'));
  assert.ok(part.vertices.every((v) => v.follow === 'outer'));
  const drawn = drawDocument(ring.after).nodes[0].children.find((n) => n.attrs['data-id'] === ring.id);
  assert.equal(drawn.attrs['fill-rule'], 'evenodd');
  assert.equal((String(drawn.attrs.d).match(/M/g) ?? []).length, 2, 'the outline and the hole');
  // Inside the hole is another gap: the inner circle around the dot.
  const middle = fill(ring.after, { x: 100, y: 70 });
  assert.equal(middle.made, true);
  assert.equal(find(middle.after, middle.id).holes.length, 1, 'the dot');
  // The ring is filled: clicking it again finds that fill.
  assert.equal(fill(middle.after, { x: 100, y: 15 }).made, false);
  // Bending the inner circle bends the hole.
  const bent = apply(ring.after, [{ op: 'set', target: 'inner', props: { vertices: find(ring.after, 'inner').vertices.map((v, i) => (i === 0 ? { ...v, y: v.y - 30 } : v)) } }]);
  assert.match(String(drawDocument(bent).nodes[0].children.find((n) => n.attrs['data-id'] === ring.id).attrs.d), /20 /);
  // Deleting the inner circle (as the store settles it) takes the hole away and keeps the fill.
  const settled = applyOps(schema, ring.after, settleOps(ring.after, [{ op: 'delete', target: 'inner' }], loose)).document;
  assert.equal(find(settled, ring.id).holes, undefined);
});

test('holes are checked like outlines, renamed with their lines, and copied as plain points', () => {
  const doc = layer(square, { id: 'cut', vertices: [{ x: 20, y: 20, name: 'a' }, { x: 40, y: 20 }, { x: 30, y: 40 }] });
  assert.throws(() => apply(doc, [{ op: 'create', type: 'path', id: 'f', parent: 'ink', props: { vertices: square.vertices, holes: [[{ ref: 'cut.zz' }, { x: 1, y: 1 }, { x: 2, y: 2 }]] } }]), /hole 0 of f shares "cut.zz", but there is no such point/);
  assert.throws(() => apply(doc, [{ op: 'create', type: 'path', id: 'f', parent: 'ink', props: { vertices: square.vertices, holes: [[{ x: 0, y: 0, name: 'n' }, { x: 1, y: 1 }, { x: 2, y: 2 }]] } }]), /take no names/);
  const withHole = apply(doc, [{ op: 'create', type: 'path', id: 'f', parent: 'ink', props: { vertices: square.vertices, holes: [[{ ref: 'cut.a' }, { x: 40, y: 20 }, { x: 30, y: 40 }]] } }]);
  const renamed = apply(withHole, [{ op: 'rename', target: 'cut', id: 'slit' }]);
  assert.deepEqual(find(renamed, 'f').holes[0][0], { ref: 'slit.a' });
  const { ops } = copyOps(resolveDoc(withHole), [find(resolveDoc(withHole), 'f')], translate(10, 0));
  assert.deepEqual(ops[0].props.holes[0][0], { x: 30, y: 20 });
});

test('moving a fill moves the lines it follows, whole', () => {
  const circle = (id, size) => ({ id, vertices: ellipsePoints({ x: 100 - size / 2, y: 100 - size / 2, width: size, height: size }, 8) });
  const { after, id } = fill(layer(circle('outer', 200), circle('inner', 100)), { x: 100, y: 20 });
  const resolved = resolveDoc(after);
  const moving = partsToMove(resolved, [find(resolved, id)]);
  assert.deepEqual(moving.map((p) => p.id).sort(), ['inner', 'outer'], 'its lines, not the fill (it has no points of its own)');
  const ops = moving.map((part) => ({ op: 'set', target: part.id, props: transformPart(part, translate(30, 0)) }));
  const moved = applyOps(schema, after, settleOps(after, ops, loose)).document;
  assert.equal(pointsError(moved), null);
  for (const line of ['outer', 'inner']) {
    find(moved, line).vertices.forEach((v, i) => assert.equal(v.x, round2(find(after, line).vertices[i].x + 30), `${line}.${i} moved`));
  }
});

test('shapes inside a gap that cross each other or its lines without a weld leave no gap to fill', () => {
  const circle = (id, x, y, size) => ({ id, vertices: ellipsePoints({ x, y, width: size, height: size }, 4) });
  const doc = layer(circle('big', 0, 0, 300), circle('a', 60, 100, 100), circle('b', 120, 100, 100));
  assert.match(String(/** @type {any} */ (gapAt(resolveDoc(doc), 'ink', { x: 150, y: 20 })).error), /cross without a weld.*weld them where they cross/);
  const apart = layer(circle('big', 0, 0, 300), circle('a', 40, 100, 80), circle('b', 180, 100, 80));
  assert.equal(/** @type {any} */ (gapAt(resolveDoc(apart), 'ink', { x: 150, y: 20 })).holes.length, 2);
});

test('picked points make a shape as in Moho: all around it, with the holes picked too; dead ends are left out', () => {
  const circle = (id, size) => ({ id, vertices: ellipsePoints({ x: 100 - size / 2, y: 100 - size / 2, width: size, height: size }, 4) });
  const doc = resolveDoc(layer(circle('outer', 200), circle('inner', 100), { id: 'hair', closed: false, fill: null, vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }));
  const keys = nodeKeys(doc, 'ink');
  const nodesOf = (...parts) => [...keys].filter(([k]) => parts.includes(k.split(':')[0])).map(([, v]) => v.node);
  const ring = shapeOf(doc, 'ink', nodesOf('outer', 'inner', 'hair'));
  assert.ok(!('error' in ring) && ring.holes.length === 1, 'the outer circle with the inner one as a hole; the open line is left out');
  const disc = shapeOf(doc, 'ink', nodesOf('outer'));
  assert.ok(!('error' in disc) && disc.holes.length === 0);
  const some = shapeOf(doc, 'ink', nodesOf('outer').slice(0, 3));
  assert.ok('error' in some && /do not close a shape/.test(some.error));
  assert.equal(/** @type {any} */ (some).shown.length, 2, 'the picked stretches, to show them');
  const { ops } = shapeFromPointsOps(doc, 'ink', nodesOf('outer', 'inner'), { fill: '#ff0000' });
  const after = apply(layer(circle('outer', 200), circle('inner', 100), { id: 'hair', closed: false, fill: null, vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }), ops);
  assert.equal(pointsError(after), null);
  assert.equal(find(after, 'outer_fill').holes.length, 1);
  // Clicking in a gap gives its points.
  const gap = gapAt(doc, 'ink', { x: 100, y: 20 });
  assert.ok(!('error' in gap));
  assert.deepEqual(new Set(gap.nodes), new Set(nodesOf('outer', 'inner')));
});

test('lines that cross without a point are found, and welding a crossing opens the gaps on both sides', () => {
  const circle = (id, x) => ({ id, vertices: ellipsePoints({ x, y: 0, width: 100, height: 100 }, 4) });
  let doc = layer(circle('a', 0), circle('b', 60));
  const crossings = crossingsOf(resolveDoc(doc), 'ink');
  assert.equal(crossings.length, 2);
  for (const c of crossings) assert.ok(Math.abs(c.x - 80) < 1, `a crossing near x 80: ${c.x}`);
  assert.match(String(/** @type {any} */ (gapAt(resolveDoc(doc), 'ink', { x: 80, y: 50 })).error ?? ''), /^$|cross/);
  for (let i = 0; i < 2; i++) {
    const [first] = crossingsOf(resolveDoc(doc), 'ink');
    doc = applyOps(schema, doc, settleOps(doc, weldCrossingOps(resolveDoc(doc), first).ops, loose)).document;
    assert.equal(pointsError(doc), null);
  }
  assert.equal(crossingsOf(resolveDoc(doc), 'ink').length, 0, 'both welded');
  const lens = fill(doc, { x: 80, y: 50 });
  assert.ok(fillHolds(lens.after, lens.id, { x: 80, y: 50 }) && !fillHolds(lens.after, lens.id, { x: 20, y: 50 }) && !fillHolds(lens.after, lens.id, { x: 140, y: 50 }));
  const moon = fill(lens.after, { x: 20, y: 50 });
  assert.ok(fillHolds(moon.after, moon.id, { x: 20, y: 50 }) && !fillHolds(moon.after, moon.id, { x: 80, y: 50 }));
});

test('a fill is named after the line it follows most, and renaming the line renames its fills', () => {
  const first = fill(layer(square), { x: 50, y: 50 });
  assert.equal(first.id, 'box_fill');
  const second = fill(first.after, { x: 50, y: 50 });
  assert.equal(second.made, false, 'aia fill on a filled gap recolors it');
  const two = apply(first.after, shapeFromPointsOps(resolveDoc(first.after), 'ink', /** @type {any} */ (gapAt(resolveDoc(first.after), 'ink', { x: 50, y: 50 })).nodes, { fill: '#00ff00' }).ops);
  assert.ok(find(two, 'box_fill_2'), 'Create Shape on the same points adds another, as in Moho');
  const three = apply(two, shapeFromPointsOps(resolveDoc(two), 'ink', /** @type {any} */ (gapAt(resolveDoc(two), 'ink', { x: 50, y: 50 })).nodes, { fill: '#0000ff' }).ops);
  const mine = apply(three, [{ op: 'rename', target: 'box_fill_2', id: 'shine' }]);
  const { document, inverse } = applyOps(schema, mine, [{ op: 'rename', target: 'box', id: 'frame' }]);
  assert.deepEqual(childrenOf(document, 'ink').map((o) => o.id).sort(), ['frame', 'frame_fill', 'frame_fill_3', 'shine']);
  assert.ok(find(document, 'frame_fill').vertices.every((v) => v.follow === 'frame' && v.ref.startsWith('frame.')));
  assert.equal(pointsError(document), null);
  assert.deepEqual(applyOps(schema, document, inverse).document, mine, 'undo renames them back');
});
