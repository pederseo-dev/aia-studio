import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { childrenOf, findObject, newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { pointsError, resolveDoc } from '../src/core/points.js';
import { fillOps, gapAt, insidePolygon, styleProps } from '../src/core/fill.js';
import { ellipsePoints, outlineOf } from '../src/core/geometry.js';

const schema = loadSchema();
const apply = (doc, ops) => applyOps(schema, doc, ops).document;
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
