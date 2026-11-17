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
           4 vertices with curve handles. A part's vertices are in its layer's own coordinates: the same as the
           artboard's until the layer (or a group it is in) is moved, turned or scaled with its transform.

Work like this:
  1. aia show <doc>                 read the document as it is saved
  2. aia history <doc>              steps with origin "user" are the person's own touch-ups: keep them
  3. aia ops <doc> '<batch>'        change it (see: aia guide ops)
  4. aia render <doc>               look at the result, then fix what is wrong (aia undo <doc> takes back your step)

The person sees your changes live in the editor and can change anything by hand.
Layers have a transform of their own (x, y, rotation, scaleX, scaleY around their origin) that moves the whole
layer without changing its vertices: aia transform <doc> <layer> --rotate 20. Transforming a part rewrites its
vertices: aia transform <doc> <part> --move 10,0. A transformed layer always keeps an origin (it is set where it
turns the first time), and changing the origin moves its x, y too, so the layer stays where it is.
Coordinates: every command that takes a place (move --to, add-point --at, --move) works in the coordinates of the
layer the points belong to, like their vertices; in a turned layer they differ from the artboard's. render shows
the artboard.

Undo: aia undo takes back your own steps only. It is refused when it would take away or overwrite what the person
did after that step (it says what); aia undo --skip then leaves that step as it is and goes on with older ones.

Drawing by name, without writing vertices (the layer is made if it is not there):
  aia rect face mouth_box --box 100,80,200,60 --radius 8 --fill #e05555
  aia ellipse face head --box 200,100,400,400 --points 8 --names top,tr,right,br,bottom,bl,left,tl
  aia copy face ear_l --move 300,0 · aia transform face eye_l eye_r --scale 1.2 (together, around their center)

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
  - a shared vertex has no name of its own
What batches do with shared points, the same for you and for the person in the editor:
  - giving a shared vertex an x, y moves the point it shares (it is the same point)
  - deleting a part or a point that others share leaves those vertices where they were, as points of their own
  - renaming a part (rename) updates the references to its points

The commands do this by name, without writing vertices (points are part.point or part.index, from 0):
  aia weld face mouth.0 jaw.chin      mouth.0 shares jaw.chin from now on (a target without a name gets one)
  aia weld face mouth.2 --on jaw      onto jaw's line, where it is nearest (a point is added there)
  aia weld face line.0 line.5         the two ends of one line close it; --join makes two lines one
  aia unweld face mouth.0             it keeps its place, as a point of its own
  aia name face head.3 chin           names a point (shares and groups follow a new name)
  aia add-point face head --at 120,40 a point on the line, where it is nearest, without changing its shape
  aia show face --resolved            each shared vertex with the x, y of the point it shares
  aia delete-point face head.3        (whoever shared it keeps its place)
  aia curve face head.3 · aia corner face head.3    smooth curve or corner, as in point editing
  aia render face --labels            the picture with named points labeled and shared points ringed

Following a curve: a stretch of an outline can go along another part's outline instead of having its own curve,
so a fill and a line drawn over the same points stay together when the line is curved:
  "vertices": [{ "ref": "jaw.ear_l", "follow": "jaw" }, { "ref": "jaw.ear_r" }, { "x": 50, "y": 200 }]
From ear_l to ear_r this outline goes along jaw (its points and curves in between). Both ends of the stretch share
points of jaw. On a closed jaw it takes the short way; "way": "long" takes the other.
  aia follow face skin.0 skin.1       (--long: the other way; --off: stop following)

Moving points by name, without sending the vertices again (the vertices that share them follow):
  aia move face head.chin --to 400,470          one point to a place
  aia move face head.ear_l_top head.3 --by -10,0  points by an offset (head.3: the vertex at index 3, from 0)
  aia move face face.upper_lid --by 0,-6        all the points of a point group

Point groups belong to the vector layer, a list of named points of its parts:
  { "op": "set", "target": "face", "props": { "groups": { "upper_lid": ["lid.top", "brow.mid"] } } }
  aia group face face.upper_lid lid.0 lid.1 brow.mid    (--add, --remove, --delete)`,
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
