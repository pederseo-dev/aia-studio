import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { createDocument, validate } from '../src/core/document.js';
import { applyOperations, compact, summarizeOperations } from '../src/core/operations.js';
import { apply, worldMatrix } from '../src/core/geometry.js';
import { guideForAI } from '../src/core/guide.js';
import { DRAW, svgDocument } from '../src/render/svg.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema);

function robot() {
  return op(
    createDocument({ name: 'Robot' }),
    { op: 'create', type: 'group', id: 'body', props: { x: 300, y: 400 } },
    { op: 'create', type: 'rect', id: 'torso', parent: 'body', props: { width: 160, height: 200 } },
    { op: 'create', type: 'group', id: 'head', parent: 'body', props: { y: -100 } },
    { op: 'create', type: 'ellipse', id: 'eye_l', parent: 'head', props: { x: -30, y: -60, width: 20, height: 20 } },
    { op: 'create', type: 'ellipse', id: 'eye_r', parent: 'head', props: { x: 30, y: -60, width: 20, height: 20 } },
  ).doc;
}

test('the schema resolves inheritance and only exposes concrete types', () => {
  assert.deepEqual([...schema.types.keys()].sort(), ['animation', 'bone', 'driver', 'ellipse', 'group', 'image', 'linear_gradient', 'param', 'path', 'pose', 'radial_gradient', 'rect', 'skeleton', 'style', 'switch']);
  assert.equal(schema.types.get('style').resource, true);
  assert.equal(schema.types.get('path').resource, false);
  const rect = schema.types.get('rect');
  assert.ok(rect.properties.x && rect.properties.fill && rect.properties.width);
  assert.equal(schema.types.get('group').container, true);
  assert.equal(rect.container, false);
});

test('every concrete non-asset type knows how to draw itself', () => {
  for (const [name, kind] of schema.types) if (!kind.resource) assert.ok(name in DRAW, `missing DRAW.${name}`);
});

test('create builds the hierarchy and the draw order', () => {
  const doc = robot();
  assert.deepEqual(validate(doc, schema).errors, []);
  assert.deepEqual(doc.objects.map((o) => o.id), ['body', 'torso', 'head', 'eye_l', 'eye_r']);
  const background = op(doc, { op: 'create', type: 'rect', id: 'antenna', parent: 'head', index: 0 }).doc;
  assert.deepEqual(background.objects.filter((o) => o.parent === 'head').map((o) => o.id), ['antenna', 'eye_l', 'eye_r']);
});

test('every operation is undone exactly by its inverses', () => {
  const doc = robot();
  const lotes = [
    [{ op: 'set', target: 'torso', props: { width: 10, fill: '#ff0000' } }],
    [{ op: 'unset', target: 'eye_l', props: ['x', 'width'] }],
    [{ op: 'set', target: 'meta', props: { width: 600, background: null } }],
    [{ op: 'delete', target: 'head' }],
    [{ op: 'move', target: 'eye_r', parent: null, index: 0 }],
    [{ op: 'move', target: 'torso', index: 5 }],
    [{ op: 'rename', target: 'head', id: 'cabeza' }],
    [{ op: 'move', target: 'body', parent: null, index: 0 }, { op: 'delete', target: 'body' }],
  ];
  for (const ops of lotes) {
    const { doc: changed, inverses } = op(doc, ...ops);
    assert.notDeepEqual(changed, doc, JSON.stringify(ops));
    assert.deepEqual(op(changed, ...inverses).doc, doc, JSON.stringify(ops));
  }
});

test('duplicate copies the subtree with new ids and can be undone', () => {
  const doc = robot();
  const { doc: copy, inverses } = op(doc, { op: 'duplicate', target: 'head', id: 'head_b', suffix: 'b', props: { x: 50 } });
  const ids = copy.objects.map((o) => o.id);
  assert.deepEqual(ids.slice(0, 5), ['body', 'torso', 'head', 'eye_l', 'eye_r']);
  assert.deepEqual(copy.objects.filter((o) => o.parent === 'body').map((o) => o.id), ['torso', 'head', 'head_b']);
  assert.deepEqual(copy.objects.filter((o) => o.parent === 'head_b').map((o) => o.id), ['eye_l_b', 'eye_r_b']);
  assert.equal(copy.objects.find((o) => o.id === 'head_b').x, 50);
  assert.deepEqual(op(copy, ...inverses).doc, doc);
  assert.throws(() => op(copy, { op: 'duplicate', target: 'head', suffix: 'b' }), /an object "head_b" already exists/);
  assert.throws(() => op(copy, { op: 'duplicate', target: 'head', id: 'head_c', suffix: 'b' }), /an object "eye_l_b" already exists/);
  const root = op(doc, { op: 'duplicate', target: 'eye_l', parent: null, index: 0 }).doc;
  assert.equal(root.objects.filter((o) => (o.parent ?? null) === null)[0].id, 'eye_l_copy');
});

test('compact merges consecutive sets and the summary is readable', () => {
  const ops = [
    { op: 'set', target: 'head', props: { x: 1 } },
    { op: 'set', target: 'head', props: { x: 2, y: 5 } },
    { op: 'set', target: 'torso', props: { x: 3 } },
  ];
  assert.deepEqual(compact(ops), [{ op: 'set', target: 'head', props: { x: 2, y: 5 } }, ops[2]]);
  assert.deepEqual(summarizeOperations([...ops, { op: 'create', type: 'rect', id: 'a' }]), ['head.x', 'head.y', 'torso.x', 'create a']);
});

test('rename updates the children', () => {
  const doc = op(robot(), { op: 'rename', target: 'head', id: 'cabeza' }).doc;
  assert.equal(doc.objects.find((o) => o.id === 'eye_l').parent, 'cabeza');
});

test('errors are clear and the batch is never half-applied', () => {
  const doc = robot();
  assert.throws(() => op(doc, { op: 'set', target: 'hed', props: { x: 1 } }), /Operation 1 \(set\): object "hed" does not exist. Did you mean "head"\?/);
  assert.throws(() => op(doc, { op: 'create', type: 'rectangle', id: 'x' }), /Did you mean "rect"\?/);
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'r', parent: 'torso' }), /cannot have children/);
  assert.throws(() => op(doc, { op: 'move', target: 'body', parent: 'head' }), /inside itself/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { fill: 'red' } }), /torso.fill must be a color/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { opacity: 2 } }), /≤ 1/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { parent: 'head' } }), /use move/);
  assert.throws(
    () => op(doc, { op: 'set', target: 'torso', props: { x: 5 } }, { op: 'delete', target: 'nada' }),
    /Operation 2/,
  );
  assert.equal(doc.objects.find((o) => o.id === 'torso').x, undefined);
});

test('unknown properties are kept with a warning', () => {
  const { doc, warnings } = op(robot(), { op: 'set', target: 'torso', props: { widht: 5 } });
  assert.equal(doc.objects.find((o) => o.id === 'torso').widht, 5);
  assert.match(warnings[0], /unknown property "widht".*Did you mean "width"\?/);
});

test('the world matrix composes the hierarchy', () => {
  const doc = op(robot(), { op: 'set', target: 'head', props: { rotation: 90 } }).doc;
  const [x, y] = apply(worldMatrix(doc, schema, 'eye_l'), 0, 0);
  // body (300,400) → head (0,-100) turned 90° → eye_l (-30,-60) becomes (60,-30)
  assert.ok(Math.abs(x - 360) < 1e-9 && Math.abs(y - 270) < 1e-9, `${x},${y}`);
});

test('the SVG respects hierarchy, default values and order', () => {
  const svg = svgDocument(robot(), schema);
  assert.match(svg, /^<svg[^>]+viewBox="0 0 800 800"/);
  assert.match(svg, /<g data-id="head" transform="translate\(0 -100\)"><g data-id="eye_l"/);
  assert.match(svg, /<rect x="-80" y="-100" width="160" height="200" fill="#c8c2d4"\/>/);
});

test('the AI guide comes from the schema', () => {
  const guide = guideForAI(schema);
  for (const kind of schema.types.keys()) assert.ok(guide.includes(`### \`${kind}\``));
  assert.ok(guide.includes('`cornerRadius`'));
});

test('originX/originY shift the pivot inside rectangles and ellipses', () => {
  const { doc } = op(
    createDocument({ name: 'Origen' }),
    { op: 'create', type: 'rect', id: 'r', props: { width: 40, height: 20, originY: 1 } },
    { op: 'create', type: 'ellipse', id: 'e', props: { width: 40, height: 20, originX: 0 } },
  );
  const svg = svgDocument(doc, schema);
  assert.match(svg, /<rect x="-20" y="-20" width="40" height="20"/);
  assert.match(svg, /<ellipse cx="20" rx="20" ry="10"/);
});

test('meta is a reserved id: it cannot be created, renamed to or duplicated as', () => {
  const doc = op(createDocument({}), { op: 'create', type: 'rect', id: 'r' }).doc;
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'meta' }), /reserved id/);
  assert.throws(() => op(doc, { op: 'rename', target: 'r', id: 'meta' }), /reserved id/);
  assert.throws(() => op(doc, { op: 'duplicate', target: 'r', id: 'meta' }), /reserved id/);
  assert.match(validate({ ...doc, objects: [{ id: 'meta', type: 'rect' }] }, schema).errors.join(), /reserved id/);
});

test('params and drivers: initial and equals must be options, and min cannot exceed max', () => {
  const base = op(createDocument({}), { op: 'create', type: 'param', id: 'v', props: { kind: 'enum', options: ['a', 'b'] } }, { op: 'create', type: 'pose', id: 'pp' }).doc;
  assert.throws(() => op(base, { op: 'set', target: 'v', props: { initial: 'zz' } }), /v\.initial "zz" is not one of its options: "a", "b"/);
  assert.throws(() => op(base, { op: 'create', type: 'driver', id: 'dd', props: { param: 'v', pose: 'pp', equals: 'c' } }), /param v has options "a", "b", but driver dd\.equals "c" uses a value that is not among them/);
  assert.throws(() => op(base, { op: 'create', type: 'param', id: 'n', props: { min: 2, max: 1 } }), /min \(2\) is greater than max \(1\)/);
  assert.throws(() => op(base, { op: 'create', type: 'param', id: 'n', props: { max: -1 } }), /min \(0\) is greater than max \(-1\)/);
  // Removing the option a driver uses also warns.
  const withDriver = op(base, { op: 'create', type: 'driver', id: 'dd', props: { param: 'v', pose: 'pp', equals: 'b' } }).doc;
  const two = op(withDriver, { op: 'create', type: 'driver', id: 'dd2', props: { param: 'v', pose: 'pp', equals: 'b' } }).doc;
  assert.throws(() => op(two, { op: 'set', target: 'v', props: { options: ['a'] } }), /drivers dd\.equals "b", dd2\.equals "b" use values .*change those drivers’ equals in the same batch \(for example \{ "op": "set", "target": "dd", "props": \{ "equals": "a" \} \}\)/);
  // Changing the equals in the same batch, it passes.
  assert.doesNotThrow(() => op(two, { op: 'set', target: 'v', props: { options: ['a'] } }, { op: 'set', target: 'dd', props: { equals: 'a' } }, { op: 'delete', target: 'dd2' }));
});

test('taking a variant a pose uses out of a switch names both ways out', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'm_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'm_o', parent: 'mouth' },
    { op: 'create', type: 'pose', id: 'o', props: { values: { mouth: { active: 'm_o' } } } },
  ).doc;
  assert.throws(() => op(doc, { op: 'move', target: 'm_o', parent: null }), /Pose "o" makes switch mouth show "m_o".*remove only mouth's active from pose "o".*Puppet → View → Pose: o, select mouth and click ↺ next to active.*set_pose with remove: \["mouth\.active"\].*or keep "m_o" inside mouth/);
});

test('move with keepPosition leaves the object in the same place on screen, and can be undone', () => {
  const doc = op(createDocument({}), { op: 'create', type: 'group', id: 'g', props: { x: 100, y: 50, rotation: 90 } }, { op: 'create', type: 'rect', id: 'r', props: { x: 10, y: 20 } }).doc;
  const { doc: moved, inverses } = op(doc, { op: 'move', target: 'r', parent: 'g', keepPosition: true });
  assert.deepEqual(apply(worldMatrix(moved, schema, 'r'), 0, 0).map(Math.round), [10, 20]);
  assert.deepEqual(op(moved, ...inverses).doc, doc);
  // Without keepPosition it keeps x/y (and shifts).
  assert.deepEqual(apply(worldMatrix(op(doc, { op: 'move', target: 'r', parent: 'g' }).doc, schema, 'r'), 0, 0).map(Math.round), [80, 60]);
  assert.throws(() => op(op(moved, { op: 'create', type: 'skeleton', id: 's' }, { op: 'create', type: 'bone', id: 'b', parent: 's' }).doc, { op: 'move', target: 'b', parent: 'g', keepPosition: true }), /reparent_bone/);
});

test('every type and property has English help for the editor', () => {
  const withoutHelp = [];
  for (const t of [schema.meta, ...schema.types.values()]) {
    if (!t.help) withoutHelp.push(t.name);
    for (const [k, p] of Object.entries(t.properties)) if (!p.help) withoutHelp.push(`${t.name}.${k}`);
  }
  assert.deepEqual(withoutHelp, []);
});

test('artboardOps resizes the artboard with the drawing anchored to the center (root, poses and clips)', async () => {
  const { artboardOps } = await import('../src/core/artboard.js');
  const doc = op(
    createDocument({ width: 600, height: 400 }),
    { op: 'create', type: 'group', id: 'body', props: { x: 300, y: 200 } },
    { op: 'create', type: 'rect', id: 'torso', parent: 'body', props: { x: 5, width: 10, height: 10 } },
    { op: 'create', type: 'style', id: 'piel' },
    { op: 'create', type: 'pose', id: 'salto', props: { values: { body: { y: 150, rotation: 5 }, torso: { x: 9 } } } },
    { op: 'create', type: 'animation', id: 'paso', props: { duration: 1, tracks: { body: { x: [{ t: 0, value: 300 }, { t: 1, value: 320 }] } } } },
  ).doc;
  const r = applyOperations(doc, artboardOps(doc, schema, 800, 500), schema).doc;
  const get = (id) => r.objects.find((o) => o.id === id);
  assert.deepEqual([r.meta.width, r.meta.height], [800, 500]);
  assert.deepEqual([get('body').x, get('body').y], [400, 250]);
  assert.equal(get('torso').x, 5, 'nested objects move with their parent');
  assert.deepEqual(get('salto').values, { body: { y: 200, rotation: 5 }, torso: { x: 9 } });
  assert.deepEqual(get('paso').tracks.body.x.map((c) => c.value), [400, 420]);
  // Same size: only width/height.
  assert.equal(artboardOps(r, schema, 800, 500).length, 1);
});
