// The guide for the AI, split in short topics (`aia guide <topic>`): a few written by hand, and one per type of the
// schema, generated from it, so the help never drifts from what the validator accepts.

/**
 * @typedef {import('./schema.js').Schema} Schema
 * @typedef {import('./schema.js').PropertySpec} PropertySpec
 */

/** @type {Record<string, { title: string, text: string }>} */
const TOPICS = {
  start: {
    title: 'How aia-studio documents work, and how to work on them',
    text: `A document is a flat list of objects, each with a stable id that is also its name ("head", "left_eye") and the
id of its parent (null at the root). The list is in tree order; siblings draw in order, the last one on top.

Layers (at the root or inside a group):
  group    holds other layers
  vector   holds parts: the drawing
Parts (inside a vector layer):
  path     an outline of vertices with fill and stroke. Every shape is a path: a rectangle is 4 corners, an ellipse
           4 vertices with curve handles. Coordinates are the layer's (the artboard's, for now).

Work like this:
  1. aia show <doc>                 read the document as it is saved
  2. aia history <doc>              steps with origin "user" are the person's own touch-ups: keep them
  3. aia ops <doc> '<batch>'        change it (see: aia guide ops)
  4. aia render <doc>               look at the result, then fix what is wrong (aia undo <doc> takes back your step)

The person sees your changes live in the editor and can change anything by hand.
Topics: aia guide ops · aia guide paths · aia guide points · aia guide types · aia guide <type>`,
  },
  ops: {
    title: 'Operations: the only way to change a document',
    text: `A batch is a JSON list of operations. It is atomic: if one fails, nothing changes, and the error says which
one and why. Each batch is one step in the history: aia undo takes back the whole batch, so keep one concern per
batch (fix the ears in one, recolor in another).

  { "op": "create", "type": "vector", "id": "head", "parent": "body", "index": 0, "props": { ... } }
      parent: omitted or null = the root; index: place among the siblings (0 = at the back; omitted = on top)
  { "op": "set", "target": "head", "props": { "visible": false } }
      target "meta" changes the document itself (name, width, height, background).
      A value equal to the default removes the property; only what differs from the defaults is stored.
  { "op": "delete", "target": "head" }               with everything inside it
  { "op": "move", "target": "head", "parent": null, "index": 0 }
  { "op": "rename", "target": "head", "id": "face" }  references to it follow

Example, a layer with a red square:
  aia ops face '[{"op":"create","type":"vector","id":"face"},
    {"op":"create","type":"path","id":"square","parent":"face","props":{"fill":"#e05555",
      "vertices":[{"x":100,"y":100},{"x":200,"y":100},{"x":200,"y":200},{"x":100,"y":200}]}}]'

The properties of each type: aia guide types, then aia guide <type>.`,
  },
  paths: {
    title: 'Paths: vertices, curves, open lines',
    text: `A path is { vertices, closed } plus the part's style (fill, stroke, strokeWidth, visible).
A vertex is { "x": 10, "y": 20 } (a corner). A curve vertex adds tangent handles relative to it:
  "in"  { x, y }  toward the previous vertex
  "out" { x, y }  toward the next one
A smooth curve has in and out pointing opposite ways. A circle of radius r centered at (cx, cy):
  k = r * 0.5523
  [{ "x": cx,     "y": cy - r, "in": { "x": -k, "y": 0 }, "out": { "x": k, "y": 0 } },
   { "x": cx + r, "y": cy,     "in": { "x": 0, "y": -k }, "out": { "x": 0, "y": k } },
   { "x": cx,     "y": cy + r, "in": { "x": k, "y": 0 },  "out": { "x": -k, "y": 0 } },
   { "x": cx - r, "y": cy,     "in": { "x": 0, "y": k },  "out": { "x": 0, "y": -k } }]
closed: true (the default) joins the last vertex to the first. An open line is "closed": false, usually with
"fill": null. fill or stroke null = none.`,
  },
  points: {
    title: 'Named points, shared points (welding) and point groups',
    text: `Named point: a vertex with a name, unique in its part: { "x": 50, "y": 80, "name": "chin" }.
Elsewhere it is called "<part>.<name>": "jaw.chin".

Shared point (a weld, as in Moho): a vertex of another part of the SAME vector layer can be the same point:
  { "ref": "jaw.chin" }                      or with its own curve handles: { "ref": "jaw.chin", "in": { ... } }
It has no x, y of its own: it is wherever jaw.chin is, so the two outlines stay joined when jaw.chin moves.
Rules (a batch that breaks them is refused):
  - the point it names exists and has a name; it is in another part of the same layer
  - it is not itself a shared vertex (share the original point instead)
  - a shared vertex has no name and no x, y
  - deleting a part or a point that others share is refused: unshare them first (give them x, y)
Renaming a part (rename) updates the references to its points.

Moving points by name, without sending the vertices again (the vertices that share them follow):
  aia move face head.chin --to 400,470          one point to a place
  aia move face head.ear_l_top head.3 --by -10,0  points by an offset (head.3: the vertex at index 3, from 0)
  aia move face face.upper_lid --by 0,-6        all the points of a point group

Point groups belong to the vector layer, a list of named points of its parts:
  { "op": "set", "target": "face", "props": { "groups": { "upper_lid": ["lid.top", "brow.mid"] } } }`,
  },
};

/** The topics written by hand, then one per type. @param {Schema} schema */
export function guideTopics(schema) {
  return [
    ...Object.entries(TOPICS).map(([name, t]) => ({ name, title: t.title })),
    { name: 'types', title: 'The types of objects and where each one can go' },
  ];
}

/** @param {PropertySpec} p */
function describeProperty(p) {
  const kind = p.nullable ? `${p.type} or null` : p.type;
  const range = [p.min !== undefined ? `min ${p.min}` : '', p.max !== undefined ? `max ${p.max}` : ''].filter(Boolean).join(', ');
  return `${kind}, default ${JSON.stringify(p.default)}${range ? `, ${range}` : ''}`;
}

/**
 * A topic of the guide, or null if there is no such topic.
 * @param {Schema} schema @param {string} [topic]
 * @returns {string | null}
 */
export function guide(schema, topic) {
  if (!topic) {
    const lines = guideTopics(schema).map((t) => `  ${t.name.padEnd(8)} ${t.title}`);
    return `aia guide <topic>\n\n${lines.join('\n')}\n  <type>   One type in detail (aia guide types lists them)\n\nStart with: aia guide start`;
  }
  const written = TOPICS[topic];
  if (written) return `${written.title}\n\n${written.text}`;
  if (topic === 'types') {
    const types = [...schema.values()].filter((t) => !t.abstract && t.name !== 'meta');
    /** @param {string} name */
    const placesOf = (name) => {
      const places = [...schema.values()].filter((t) => t.childTypes.includes(name)).map((t) => (t.name === 'meta' ? 'the root' : t.name));
      return places.join(', ') || 'nowhere';
    };
    return `Types (aia guide <type> for its properties):\n\n${types.map((t) => `  ${t.name.padEnd(8)} ${t.help} Goes in: ${placesOf(t.name)}.`).join('\n')}\n  meta     The document itself (target "meta" in set).`;
  }
  const type = schema.get(topic);
  if (!type || type.abstract) return null;
  const props = Object.entries(type.properties).map(([name, p]) => `  ${name}: ${describeProperty(p)}\n      ${p.description}`);
  const children = type.childTypes.length ? `\nCan hold: ${type.childTypes.join(', ')}` : '';
  return `${type.name}: ${type.description}${children}\n\nProperties:\n${props.join('\n') || '  none'}`;
}
