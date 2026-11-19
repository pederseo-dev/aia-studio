// Operations: the only way to change a document, the same for the AI and for the editor. A batch is atomic: either
// every operation applies or none does, and it returns the inverse batch that undoes it.
//
//   { op: 'create', type: 'vector', id: 'head', parent?: 'body', index?: 0, props?: { visible: false } }
//   { op: 'set',    target: 'head' | 'meta', props: { locked: true } }   ← the default value removes the property
//   { op: 'delete', target: 'head' }                                     ← with everything inside it
//   { op: 'move',   target: 'head', parent: 'body' | null, index?: 0 }   ← index among the new siblings; none = on top
//   { op: 'rename', target: 'head', id: 'face' }

import { ID, childrenOf, findObject, subtree, treeOrder } from './document.js';
import { valueError } from './schema.js';
import { pointsError, renamePointRefs } from './points.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./schema.js').Schema} Schema
 * @typedef {{ op: string, [field: string]: any }} Operation
 */

export class OperationError extends Error {
  /** @param {string} message @param {number} index which operation of the batch failed */
  constructor(message, index) {
    super(message);
    this.name = 'OperationError';
    this.index = index;
  }
}

/**
 * @param {Schema} schema
 * @param {Doc} doc not changed
 * @param {Operation[]} ops
 * @param {{ checkPoints?: boolean }} [options] checkPoints: false leaves shared points and point groups unchecked
 *   (the editor looks at a batch's result before fixing it; see settleOps in points.js)
 * @returns {{ document: Doc, inverse: Operation[] }}
 */
export function applyOps(schema, doc, ops, { checkPoints = true } = {}) {
  if (!Array.isArray(ops) || ops.length === 0) throw new OperationError('A batch needs at least one operation', 0);
  const document = structuredClone(doc);
  /** @type {Operation[]} */
  const inverse = [];
  ops.forEach((operation, index) => {
    try {
      const handler = HANDLERS[operation?.op];
      if (!handler) throw new Error(`unknown op "${operation?.op}" (ops: ${Object.keys(HANDLERS).join(', ')})`);
      inverse.unshift(...handler(schema, document, operation));
      document.objects = treeOrder(document);
    } catch (e) {
      const label = typeof operation?.op === 'string' ? `${operation.op} ` : '';
      throw new OperationError(`Operation ${index + 1} (${label}${describeTarget(operation)}): ${e.message}`, index);
    }
  });
  const pointProblem = checkPoints && pointsError(document);
  if (pointProblem) throw new OperationError(`The batch would leave a broken point: ${pointProblem}`, ops.length - 1);
  return { document, inverse };
}

/** @param {Operation} operation */
const describeTarget = (operation) => (operation?.op === 'create' ? `"${operation.id}"` : `"${operation?.target}"`);

/** @type {Record<string, (schema: Schema, doc: Doc, operation: Operation) => Operation[]>} */
const HANDLERS = {
  create(schema, doc, { type, id, parent = null, index, props = {} }) {
    const spec = schema.get(type);
    if (!spec || spec.abstract || type === 'meta') throw new Error(`unknown type "${type}"`);
    checkNewId(doc, id);
    checkParent(schema, doc, type, parent);
    /** @type {DocObject} */
    const object = { id, type, parent };
    writeProps(spec, object, props);
    insert(doc, object, parent, index);
    return [{ op: 'delete', target: id }];
  },

  set(schema, doc, { target, props }) {
    const [holder, spec] = holderOf(schema, doc, target);
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('props must be an object');
    /** @type {Record<string, unknown>} */
    const before = {};
    for (const key of Object.keys(props)) before[key] = key in holder ? holder[key] : spec.properties[key]?.default;
    writeProps(spec, holder, props);
    return [{ op: 'set', target, props: before }];
  },

  delete(schema, doc, { target }) {
    const object = needObject(doc, target);
    const removed = subtree(doc, target);
    const index = childrenOf(doc, object.parent).indexOf(object);
    doc.objects = doc.objects.filter((o) => !removed.includes(o));
    // Recreated in tree order: the parent first, then its children, each on top of the ones before it.
    return removed.map((o, i) => {
      const { id, type, parent, ...props } = o;
      return { op: 'create', type, id, parent, ...(i === 0 ? { index } : {}), props };
    });
  },

  move(schema, doc, { target, parent = null, index }) {
    const object = needObject(doc, target);
    if (parent !== null && subtree(doc, target).some((o) => o.id === parent)) {
      throw new Error(`cannot go inside itself or one of its children ("${parent}")`);
    }
    checkParent(schema, doc, object.type, parent);
    const before = { op: 'move', target, parent: object.parent, index: childrenOf(doc, object.parent).indexOf(object) };
    doc.objects = doc.objects.filter((o) => o !== object);
    object.parent = parent;
    insert(doc, object, parent, index);
    return [before];
  },

  rename(schema, doc, { target, id }) {
    const object = needObject(doc, target);
    if (id === target) return [];
    checkNewId(doc, id);
    object.id = id;
    for (const o of doc.objects) if (o.parent === target) o.parent = id;
    renamePointRefs(doc, target, id);
    return [{ op: 'rename', target: id, id: target }];
  },
};

/** @param {Doc} doc @param {unknown} target */
function needObject(doc, target) {
  const object = typeof target === 'string' ? findObject(doc, target) : undefined;
  if (!object) throw new Error(`there is no object "${target}"`);
  return object;
}

/**
 * The thing a `set` changes: the document's meta or an object, with its type.
 * @param {Schema} schema @param {Doc} doc @param {unknown} target
 * @returns {[Record<string, unknown>, import('./schema.js').ResolvedType]}
 */
function holderOf(schema, doc, target) {
  if (target === 'meta') return [doc.meta, schema.get('meta')];
  const object = needObject(doc, target);
  return [object, schema.get(object.type)];
}

/** @param {Doc} doc @param {unknown} id */
function checkNewId(doc, id) {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new Error(`"${id}" is not a valid id (lowercase letters, digits and _, starting with a letter)`);
  }
  if (id === 'meta') throw new Error('"meta" is reserved for the document itself');
  if (findObject(doc, id)) throw new Error(`the id "${id}" is already taken`);
}

/** @param {Schema} schema @param {Doc} doc @param {string} type @param {string | null} parent */
function checkParent(schema, doc, type, parent) {
  const parentType = parent === null ? 'meta' : needObject(doc, parent).type;
  const allowed = schema.get(parentType).childTypes;
  if (!allowed.includes(type)) {
    const where = parent === null ? 'at the root' : `inside "${parent}" (${parentType})`;
    throw new Error(`a ${type} cannot go ${where}; allowed there: ${allowed.join(', ') || 'nothing'}`);
  }
}

/**
 * Writes validated props; a value equal to the default removes the property.
 * @param {import('./schema.js').ResolvedType} spec @param {Record<string, unknown>} holder @param {Record<string, unknown>} props
 */
function writeProps(spec, holder, props) {
  for (const [key, value] of Object.entries(props)) {
    const property = spec.properties[key];
    if (!property) {
      const known = Object.keys(spec.properties);
      throw new Error(`a ${spec.name} has no property "${key}" (properties: ${known.join(', ') || 'none'})`);
    }
    const error = valueError(property, value);
    if (error) throw new Error(`${key} ${error}`);
  }
  for (const [key, value] of Object.entries(props)) {
    const fallback = spec.properties[key].default;
    const empty = Array.isArray(fallback) && fallback.length === 0 && Array.isArray(value) && value.length === 0;
    if (value === fallback || empty) delete holder[key];
    else holder[key] = value;
  }
}

/**
 * Puts the object among the children of `parent` at `index` (none = on top, the end).
 * @param {Doc} doc @param {DocObject} object @param {string | null} parent @param {unknown} index
 */
function insert(doc, object, parent, index) {
  const siblings = childrenOf(doc, parent);
  if (index !== undefined && (!Number.isInteger(index) || Number(index) < 0 || Number(index) > siblings.length)) {
    throw new Error(`index must be a whole number from 0 to ${siblings.length}`);
  }
  const at = index === undefined ? siblings.length : Number(index);
  const before = siblings[at];
  if (before) doc.objects.splice(doc.objects.indexOf(before), 0, object);
  else doc.objects.push(object);
}
