import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, readDefinitions } from '../server/schema.js';
import { idFromName, newDocument } from '../src/core/document.js';
import { OperationError, applyOps } from '../src/core/operations.js';

const schema = loadSchema();

/** Applies batches in order and returns the document. */
function build(...batches) {
  let doc = newDocument({ name: 'Test' });
  for (const ops of batches) doc = applyOps(schema, doc, ops).document;
  return doc;
}

const ids = (doc) => doc.objects.map((o) => `${o.id}<${o.parent ?? 'root'}`);

test('every type and property of the schema has a description and a help', () => {
  for (const definition of readDefinitions()) {
    assert.ok(definition.description, `${definition.name}: description`);
    assert.ok(definition.help, `${definition.name}: help`);
    for (const [name, property] of Object.entries(definition.properties ?? {})) {
      assert.ok(property.description, `${definition.name}.${name}: description`);
      assert.ok(property.help, `${definition.name}.${name}: help`);
    }
  }
});

test('create keeps the list in tree order, the last sibling on top', () => {
  const doc = build(
    [{ op: 'create', type: 'group', id: 'body' }],
    [{ op: 'create', type: 'vector', id: 'background', index: 0 }],
    [{ op: 'create', type: 'vector', id: 'arm', parent: 'body' }],
    [{ op: 'create', type: 'vector', id: 'torso', parent: 'body', index: 0 }],
  );
  assert.deepEqual(ids(doc), ['background<root', 'body<root', 'torso<body', 'arm<body']);
});

test('only values that differ from the default are stored', () => {
  const doc = build([{ op: 'create', type: 'vector', id: 'eye', props: { visible: true, locked: true } }]);
  assert.deepEqual(doc.objects[0], { id: 'eye', type: 'vector', parent: null, locked: true });
  const back = applyOps(schema, doc, [{ op: 'set', target: 'eye', props: { locked: false } }]).document;
  assert.deepEqual(back.objects[0], { id: 'eye', type: 'vector', parent: null });
});

test('a batch is atomic and says which operation failed', () => {
  const doc = build([{ op: 'create', type: 'vector', id: 'eye' }]);
  assert.throws(
    () => applyOps(schema, doc, [{ op: 'set', target: 'eye', props: { visible: false } }, { op: 'create', type: 'vector', id: 'eye' }]),
    (e) => e instanceof OperationError && e.index === 1 && /already taken/.test(e.message),
  );
  assert.equal(doc.objects[0].visible, undefined);
});

test('invalid operations are refused with a message that says why', () => {
  const doc = build([{ op: 'create', type: 'vector', id: 'eye' }]);
  const refuses = (op, pattern) => assert.throws(() => applyOps(schema, doc, [op]), pattern);
  refuses({ op: 'create', type: 'vector', id: 'Eye 2' }, /not a valid id/);
  refuses({ op: 'create', type: 'layer', id: 'x' }, /unknown type/);
  refuses({ op: 'create', type: 'vector', id: 'x', parent: 'eye' }, /cannot go inside "eye"/);
  refuses({ op: 'set', target: 'eye', props: { color: '#fff' } }, /no property "color"/);
  refuses({ op: 'set', target: 'eye', props: { visible: 'yes' } }, /visible must be true or false/);
  refuses({ op: 'set', target: 'meta', props: { width: 0 } }, /width must be at least 1/);
  refuses({ op: 'set', target: 'meta', props: { background: 'red' } }, /must be a color/);
  refuses({ op: 'delete', target: 'nose' }, /there is no object "nose"/);
  refuses({ op: 'paint', target: 'eye' }, /unknown op "paint"/);
});

test('a group cannot move inside itself or its children', () => {
  const doc = build([{ op: 'create', type: 'group', id: 'a' }], [{ op: 'create', type: 'group', id: 'b', parent: 'a' }]);
  assert.throws(() => applyOps(schema, doc, [{ op: 'move', target: 'a', parent: 'b' }]), /inside itself/);
});

test('rename carries the children along', () => {
  const doc = build([{ op: 'create', type: 'group', id: 'head' }], [{ op: 'create', type: 'vector', id: 'eye', parent: 'head' }]);
  const renamed = applyOps(schema, doc, [{ op: 'rename', target: 'head', id: 'face' }]).document;
  assert.deepEqual(ids(renamed), ['face<root', 'eye<face']);
});

test('every operation is undone exactly by its inverse', () => {
  const start = build(
    [{ op: 'create', type: 'vector', id: 'background' }],
    [{ op: 'create', type: 'group', id: 'head', props: { locked: true } }],
    [{ op: 'create', type: 'vector', id: 'eye', parent: 'head', props: { visible: false } }],
    [{ op: 'create', type: 'vector', id: 'mouth', parent: 'head' }],
    [{ op: 'create', type: 'vector', id: 'hat' }],
  );
  const batches = [
    [{ op: 'delete', target: 'head' }],
    [{ op: 'move', target: 'hat', parent: 'head', index: 1 }],
    [{ op: 'move', target: 'background', parent: null }],
    [{ op: 'rename', target: 'head', id: 'face' }],
    [{ op: 'set', target: 'meta', props: { width: 1024, background: null } }],
    [{ op: 'set', target: 'eye', props: { visible: true } }, { op: 'delete', target: 'mouth' }],
  ];
  for (const ops of batches) {
    const { document, inverse } = applyOps(schema, start, ops);
    assert.notDeepEqual(document, start, JSON.stringify(ops));
    assert.deepEqual(applyOps(schema, document, inverse).document, start, JSON.stringify(ops));
  }
});

test('idFromName turns what a person types into a free id', () => {
  const taken = new Set(['eye', 'layer_1']);
  const has = (id) => taken.has(id);
  assert.equal(idFromName('Ojo Izquierdo', has), 'ojo_izquierdo');
  assert.equal(idFromName('Eye', has), 'eye_2');
  assert.equal(idFromName('layer_1', has), 'layer_2');
  assert.equal(idFromName('2nd arm', has), 'l_2nd_arm');
  assert.equal(idFromName('¡¿?!', has), 'layer');
});
