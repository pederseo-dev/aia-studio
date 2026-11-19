import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { childrenOf, newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { ORDER_MOVES, orderOps } from '../src/core/order.js';

const schema = loadSchema();
const LINE = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };

/** A document with one layer of parts named by the letters, bottom first, and a second layer with two parts. */
function layerOf(names) {
  return applyOps(schema, newDocument({ name: 'Test' }), [
    { op: 'create', type: 'vector', id: 'ink' },
    ...names.map((id) => ({ op: 'create', type: 'path', id, parent: 'ink', props: LINE })),
    { op: 'create', type: 'vector', id: 'other' },
    { op: 'create', type: 'path', id: 'p', parent: 'other', props: LINE },
    { op: 'create', type: 'path', id: 'q', parent: 'other', props: LINE },
  ]).document;
}

/** Orders, applies, checks the undo, and returns the new order of a layer. */
function order(doc, ids, how, layer = 'ink') {
  const ops = orderOps(doc, ids, how);
  if (!ops.length) return childrenOf(doc, layer).map((o) => o.id).join('');
  const { document, inverse } = applyOps(schema, doc, ops);
  assert.deepEqual(applyOps(schema, document, inverse).document, doc, 'undo puts everything back');
  return childrenOf(document, layer).map((o) => o.id).join('');
}

test('raise and lower one part, one place or all the way', () => {
  const doc = layerOf(['a', 'b', 'c', 'd']);
  assert.equal(order(doc, ['b'], 'up'), 'acbd');
  assert.equal(order(doc, ['b'], 'down'), 'bacd');
  assert.equal(order(doc, ['b'], 'top'), 'acdb');
  assert.equal(order(doc, ['b'], 'bottom'), 'bacd');
  assert.equal(order(doc, ['d'], 'up'), 'abcd', 'already on top');
  assert.deepEqual(orderOps(doc, ['d'], 'top'), [], 'nothing to change, no ops');
  assert.deepEqual(orderOps(doc, ['a'], 'down'), []);
});

test('several parts move together and keep their order among themselves', () => {
  const doc = layerOf(['a', 'b', 'c', 'd', 'e']);
  assert.equal(order(doc, ['a', 'c'], 'up'), 'badce');
  assert.equal(order(doc, ['c', 'a'], 'top'), 'bdeac');
  assert.equal(order(doc, ['b', 'd'], 'bottom'), 'bdace');
  assert.equal(order(doc, ['b', 'c'], 'up'), 'adbce', 'a run moves as one');
  assert.equal(order(doc, ['b', 'e'], 'up'), 'acbde', 'the one on top stays, the other goes up');
  assert.equal(order(doc, ['d', 'e'], 'up'), 'abcde');
  assert.equal(order(doc, ['a', 'b', 'd'], 'down'), 'abdce');
});

test('every move of every pick gives the expected order', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const doc = layerOf(names);
  for (let mask = 1; mask < 1 << names.length; mask++) {
    const picked = names.filter((_, i) => mask & (1 << i));
    for (const how of ORDER_MOVES) {
      const others = names.filter((n) => !picked.includes(n));
      let expected;
      if (how === 'top') expected = [...others, ...picked];
      else if (how === 'bottom') expected = [...picked, ...others];
      else {
        // One place: each picked part's rank goes up (or down) by one, unless blocked by the end or a stuck picked one.
        const list = [...names];
        const step = how === 'up' ? 1 : -1;
        const indexes = list.map((_, i) => i);
        if (how === 'up') indexes.reverse();
        for (const i of indexes) {
          const j = i + step;
          if (picked.includes(list[i]) && list[j] !== undefined && !picked.includes(list[j])) [list[i], list[j]] = [list[j], list[i]];
        }
        expected = list;
      }
      assert.equal(order(doc, picked, how), expected.join(''), `${picked.join(',')} ${how}`);
      assert.equal(expected.filter((n) => picked.includes(n)).join(''), picked.join(''), 'picked keep their order');
    }
  }
});

test('parts of different layers move each in its own layer; layers move too', () => {
  const doc = layerOf(['a', 'b']);
  const ops = orderOps(doc, ['a', 'p'], 'top');
  const { document } = applyOps(schema, doc, ops);
  assert.equal(childrenOf(document, 'ink').map((o) => o.id).join(''), 'ba');
  assert.equal(childrenOf(document, 'other').map((o) => o.id).join(''), 'qp');
  assert.equal(order(doc, ['other'], 'bottom', null), 'otherink');
  assert.throws(() => orderOps(doc, ['zz'], 'up'), /no object "zz"/);
  assert.throws(() => orderOps(doc, ['a'], /** @type {any} */ ('sideways')), /not an order move/);
});
