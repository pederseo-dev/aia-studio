// The runtime is the contract (decision 5): every kind of document the editor and the AI can make must play in it.
// These tests play documents with each feature in a tiny stand-in for the DOM, as the module and as the bundled
// script that exported pages carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadSchema } from '../server/schema.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { ellipseVertices } from '../src/core/geometry.js';
import { createPlayer } from '../src/runtime/player.js';
import { bundleRuntime } from '../server/bundle.js';

const schema = loadSchema();

/** A tiny stand-in for the DOM: enough for the player (createElementNS, attributes, children). */
class FakeElement {
  /** @param {string} tag @param {FakePage} page */
  constructor(tag, page) {
    this.tag = tag;
    this.ownerDocument = page;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {FakeElement[]} */
    this.children = [];
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  /** @param {string} name */
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  /** @param {...FakeElement} nodes */
  append(...nodes) {
    this.children.push(...nodes);
  }
  /** @param {...FakeElement} nodes */
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  /** Every attribute value of this element and those inside it. @returns {string[]} */
  values() {
    return [...this.attributes.values(), ...this.children.flatMap((c) => c.values())];
  }
}
class FakePage {
  /** @param {string} _ns @param {string} tag */
  createElementNS(_ns, tag) {
    return new FakeElement(tag, this);
  }
}

/** Documents with every feature of Design mode so far. */
const FIXTURES = {
  empty: [],
  shapes: [
    { op: 'create', type: 'vector', id: 'face' },
    { op: 'create', type: 'path', id: 'head', parent: 'face', props: { vertices: ellipseVertices({ x: 100, y: 100, width: 200, height: 240 }) } },
    { op: 'create', type: 'path', id: 'line', parent: 'face', props: { closed: false, fill: null, vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } },
    { op: 'create', type: 'path', id: 'hidden', parent: 'face', props: { visible: false, vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] } },
  ],
  welded: [
    { op: 'create', type: 'vector', id: 'face', props: { groups: { lower: ['jaw.chin'] } } },
    { op: 'create', type: 'path', id: 'jaw', parent: 'face', props: { closed: false, fill: null, vertices: [{ x: 0, y: 0, name: 'ear_l' }, { x: 50, y: 80, name: 'chin', in: { x: -20, y: 0 }, out: { x: 20, y: 0 } }, { x: 100, y: 0, name: 'ear_r' }] } },
    { op: 'create', type: 'path', id: 'mouth', parent: 'face', props: { closed: false, fill: null, vertices: [{ x: 30, y: 40 }, { ref: 'jaw.chin' }] } },
    { op: 'create', type: 'path', id: 'skin', parent: 'face', props: { vertices: [{ ref: 'jaw.ear_l', follow: 'jaw' }, { ref: 'jaw.ear_r' }, { x: 50, y: -60 }] } },
  ],
  transformed: [
    { op: 'create', type: 'group', id: 'body', props: { x: 40, rotation: 15 } },
    { op: 'create', type: 'vector', id: 'arm', parent: 'body', props: { scaleX: -1, scaleY: 0.5, originX: 10, originY: 10 } },
    { op: 'create', type: 'path', id: 'hand', parent: 'arm', props: { vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] } },
    { op: 'set', target: 'meta', props: { background: null, width: 400, height: 300 } },
  ],
};

/** @param {string} name */
const fixture = (name) => applyOps(schema, newDocument({ name }), FIXTURES[/** @type {keyof typeof FIXTURES} */ (name)].length ? FIXTURES[/** @type {keyof typeof FIXTURES} */ (name)] : [{ op: 'set', target: 'meta', props: { name } }]).document;

for (const name of Object.keys(FIXTURES)) {
  test(`the runtime plays "${name}" without errors or broken numbers`, () => {
    const svg = new FakePage().createElementNS('', 'svg');
    const player = createPlayer(/** @type {any} */ (svg), fixture(name));
    assert.ok(svg.attributes.get('viewBox'));
    for (const value of svg.values()) assert.doesNotMatch(value, /NaN|undefined|Infinity/, `${name}: ${value}`);
    player.update(fixture(name));
  });
}

test('the runtime draws what the editor draws: shared points, followed stretches and layer transforms', () => {
  const svg = new FakePage().createElementNS('', 'svg');
  createPlayer(/** @type {any} */ (svg), fixture('welded'));
  const [, face] = svg.children; // the background, then the layer
  const d = Object.fromEntries(face.children.map((c) => [c.attributes.get('data-id'), c.attributes.get('d')]));
  assert.match(String(d.mouth), /L50 80$/);
  assert.match(String(d.skin), /^M0 0C0 0 30 80 50 80/);
  const moved = new FakePage().createElementNS('', 'svg');
  createPlayer(/** @type {any} */ (moved), fixture('transformed'));
  assert.match(String(moved.children[0].attributes.get('transform')), /^matrix\(/);
  assert.equal(moved.children.length, 1, 'no background rect when the background is none');
});

test('the bundled runtime of exported pages runs on its own and draws the same', () => {
  const context = vm.createContext({});
  vm.runInContext(bundleRuntime(), context);
  const svg = new FakePage().createElementNS('', 'svg');
  context.aiaRuntime.createPlayer(svg, fixture('welded'));
  const direct = new FakePage().createElementNS('', 'svg');
  createPlayer(/** @type {any} */ (direct), fixture('welded'));
  assert.deepEqual(svg.values(), direct.values());
});
