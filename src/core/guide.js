// Format guide for the AI, generated from the schema: if a type or a property is added, the guide updates itself.

import { CURVE_DESCRIPTIONS } from './curves.js';
import { FORMAT } from './format.js';

function range(p) {
  if (p.type === 'enum') return p.values.join(' \\| ');
  if (p.type === 'ref' && p.refTypes) return `id of ${p.refTypes.join(' or ')}`;
  if (p.type === 'asset') return 'file in assets/';
  if (p.min == null && p.max == null) return '';
  return `${p.min ?? '−∞'} … ${p.max ?? '∞'}`;
}

function table(properties) {
  const rows = Object.entries(properties).map(([name, p]) => {
    const kind = p.type + (p.nullable ? ' or null' : '') + (p.integer ? ' (integer)' : '');
    return `| \`${name}\` | ${kind} | \`${JSON.stringify(p.default)}\` | ${range(p)} | ${p.description ?? ''} |`;
  });
  return ['| Property | Type | Default | Range | Description |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function guideForAI(schema) {
  const types = [...schema.types.values()]
    .map((t) => {
      const allowedChildren = (t.childTypes ? ` (can only have children ${t.childTypes.join(', ')})` : t.container ? ' (can have children)' : '') + (t.requiresParent ? ` (goes inside ${t.parentTypes.join(' or ')}, never at the root)` : '');
      return `### \`${t.name}\`${allowedChildren}${t.resource ? ' (asset)' : ''}\n\n${t.description}\n\n${table(t.properties)}`;
    })
    .join('\n\n');

  return `# aia-studio guide (format ${FORMAT})

aia-studio is a 2D vector animation editor: characters, objects, icons, scenes or whatever needs animating. A document is JSON; you modify it with batches of operations
(\`apply_ops\`) and the user sees it live in the editor, where they can also tweak it by hand.

## Conventions

- Coordinates as in SVG: origin at the top left, **Y grows downward**. Units in px.
- Angles in **degrees**; positive = clockwise.
- Each object is drawn in its parent's coordinate system: \`x\`/\`y\` are relative to the parent.
- Loose shapes (\`rect\`, \`ellipse\`) and images are **centered** on their \`x\`/\`y\`, unless \`originX\`/\`originY\`
  (fractions from 0 to 1) put the pivot elsewhere: \`originY: 1\` = pivot on the bottom edge.
- Drawing order: among siblings, the last ones in the list end up **on top**.

## Document

\`\`\`json
{
  "format": "${FORMAT}",
  "meta": { "name": "Robot", "width": 600, "height": 600 },
  "objects": [
    { "id": "head", "type": "group", "parent": null, "x": 300, "y": 220 },
    { "id": "face", "type": "rect", "parent": "head", "y": -60, "width": 140, "height": 120, "cornerRadius": 20, "fill": "#9fb4c7" }
  ]
}
\`\`\`

- \`objects\` is a **flat list**: the hierarchy is built with \`parent\` (null = root).
- \`id\`: lowercase letters, digits and \`_\`, starting with a letter. Unique in the document. Use names that say what it is
  (\`eye_l\`, \`arm_r\`, \`head\`). \`meta\` is reserved (it is the \`target\` for the document's properties).
- **Left and right are the character's**, as in any rig: on a character facing front, \`arm_l\` is the
  arm the viewer sees on their right. Use the suffixes \`_l\` and \`_r\`.
- Properties that don't appear use their default value. Only what changes is stored.

## Operations

They are sent in batches. A batch is **atomic**: if anything fails, nothing is applied and you get the list of errors to
fix and retry.

| Operation | Shape | What it does |
| --- | --- | --- |
| \`create\` | \`{ "op": "create", "type": "rect", "id": "eye_l", "parent": "face", "props": { ... }, "index": 0 }\` | Creates an object. \`parent\` and \`index\` are optional. |
| \`set\` | \`{ "op": "set", "target": "eye_l", "props": { "x": 10, "fill": "#ffffff" } }\` | Changes properties. \`target: "meta"\` changes the document. |
| \`unset\` | \`{ "op": "unset", "target": "eye_l", "props": ["x"] }\` | Resets properties to their default value. |
| \`delete\` | \`{ "op": "delete", "target": "head" }\` | Deletes the object **and all its children**. |
| \`move\` | \`{ "op": "move", "target": "eye_l", "parent": "face", "index": 0, "keepPosition": true }\` | Changes parent and/or order. Without \`parent\` keeps the current one; \`null\` = root. With \`keepPosition\`, recomputes \`x\`/\`y\` so it stays at the same place on screen. |
| \`rename\` | \`{ "op": "rename", "target": "eye_l", "id": "left_eye" }\` | Changes the id and updates the references. |
| \`duplicate\` | \`{ "op": "duplicate", "target": "arm_l", "id": "arm_r", "suffix": "r", "props": { "x": 110, "scaleX": -1 } }\` | Copies the object with all its children. Copied children are named \`<id>_<suffix>\`. The copy goes right in front of the original. |

\`index\` is the position among siblings in drawing order: \`0\` = at the back; no \`index\` = at the front.
Without \`keepPosition\`, \`move\` doesn't change \`x\`/\`y\` (the values are relative to the parent, so the object shifts if
the new parent is somewhere else). With \`keepPosition: true\` it stays where it was seen, like dragging it in Layers in
the editor (the position is kept, not the rotation or the scale). For bones use \`reparent_bone\`.
To copy a whole document, use \`create_document\` with \`copy_from\`.

## Vector layers (\`vector\` + \`shape\`)

The usual way to draw, as in Moho: a \`vector\` layer holds a **mesh** of points and curves, and any number of
\`shape\` children fill and stroke curves of that mesh. One layer per part that moves on its own (head, arm, tail);
inside it, as many shapes as the part needs (skin, eye, outline…). Shapes have no transform: they move with their
points, and with the layer (its \`x\`/\`y\`, rotation, scale, \`bone\`).

The easiest way is to create each shape with \`d\` (an SVG path in the layer's coordinates, any number of subpaths):
its points and curves are added to the layer and the shape fills them.

\`\`\`json
[
  { "op": "create", "type": "vector", "id": "face", "parent": "body", "props": { "x": 0, "y": -120 } },
  { "op": "create", "type": "shape", "id": "skin", "parent": "face", "props": { "d": "M-60 0 C-60 -80 60 -80 60 0 C60 60 -60 60 -60 0 Z", "fill": "#f2c7a5", "stroke": "#3a2a4d", "strokeWidth": 3 } },
  { "op": "create", "type": "shape", "id": "eye_l", "parent": "face", "props": { "d": "M14 -20 A8 8 0 1 1 30 -20 A8 8 0 1 1 14 -20 Z", "fill": "#3a2a4d" } }
]
\`\`\`

The tree of \`get_document\` (and the answer of \`apply_ops\`) lists, for each shape, its points with where they are
and which are welded with other shapes: \`- eye_l (shape) [points p5 (14, -20), p6 (30, -20); curves c2; fill #3a2a4d]\`.
Those ids are what poses, keyframes and \`transformPoints\` name. What is stored is the mesh of the layer and the
curves each shape uses (the JSON of \`get_document\` has it whole, tangents included):

\`\`\`js
{ "id": "face", "type": "vector", "points": { "p1": { "x": -60, "y": 0 }, "p2": { "x": 60, "y": 0 } },
  "curves": { "c1": { "closed": true, "points": [{ "p": "p1", "mode": "asymmetric", "angle": -90, "inDist": 60, "outDist": 80 },
                                                 { "p": "p2", "mode": "asymmetric", "angle": 90, "inDist": 80, "outDist": 60 }] } } }
{ "id": "skin", "type": "shape", "parent": "face", "curves": ["c1"], "fill": "#f2c7a5" }
\`\`\`

- **Pivot:** the layer's \`x\`/\`y\` is its pivot (it rotates and scales around it) and the points are relative to it.
  Put the pivot at the joint (the neck for a head) and draw around (0, 0). To move the pivot later without moving
  the drawing, \`set\` the layer with \`"pivot": [x, y]\` (in its parent's coordinates, like \`x\`/\`y\`): its points
  shift the other way, also in the poses and keyframes that move them. A rectangle is
  \`"d": "M-40 -20 H40 V20 H-40 Z"\`.
- **Points** (\`points\`): \`{ point_id: { x, y } }\`, in the layer's coordinates. \`d\` names them \`p1\`, \`p2\`…; you can
  write the mesh yourself with \`set\` and give them names (\`chin\`, \`ear_tip\`), which makes poses easier to read.
  In the setup, \`set\` of \`points\` or \`curves\` **replaces the whole map**: to move one point, read the map, change it
  and send it whole (only poses and keyframes list just what they move).
- **Curves** (\`curves\`): \`{ curve_id: { closed, points: [entries] } }\`. An entry is a point id (a corner) or
  \`{ "p": "chin", "mode": "mirrored", "angle": 0, "dist": 20 }\` with the tangents of that point on this curve (the
  same fields as a path vertex, see «Vertices», without \`x\`/\`y\`).
- **Transform points** (as Moho's Transform Points): to move, rotate or scale a shape (or some points) without
  rewriting the map, \`set\` the layer with
  \`"transformPoints": { "shape": "eye_l", "translate": [10, 0], "rotate": 15, "scale": [1.2, 1.2], "origin": [20, -20] }\`
  (or \`"points": ["p1", "p2"]\` instead of \`shape\`). Scale and rotation (degrees) go around \`origin\` (by default,
  the center of the points' box), then the translation; all in the layer's coordinates. Tangents turn and scale with
  the points. Welded points move the other shapes too. To deform, move a single point the same way. In a \`set\` it
  changes the setup; in the values of \`set_pose\` and \`set_keys\` it writes a pose or a keyframe, **relative to the
  setup** (writing it twice gives the same): \`{ "face": { "transformPoints": { "shape": "lid_l", "scale": [1, 0.1] } } }\`
  closes an eyelid without listing its points.
- **Welded points:** a point used by two curves joins them: moving it moves both shapes (an arm and its sleeve, the
  outline and the fill). \`d\` reuses an existing point when a new one falls exactly on it.
- **Shapes** (\`shape\`): \`curves\` lists the curves it fills and strokes. With several, the inner ones cut holes
  (\`fillRule: "evenodd"\`, the default). \`fill: null\` and a \`stroke\` give a line (an open curve works too). The order
  of the shapes in the layer is the drawing order. \`set\` with \`d\` replaces the curves of a shape, and deleting a
  shape takes its curves along: the curves no other shape uses leave the layer, with their points, and the poses
  and keyframes that moved them let them go. A shape cannot change layer: duplicate it into the other one (\`{ op: "duplicate", target, parent: "other_layer" }\`, it gets its own points and keeps its place on screen) and delete the original. Duplicating a shape in its own layer also gives the copy its own points (not welded to the original).
- **Curves first, shapes later** (the editor's Fill, Stroke and Both, as Moho's Create Shape): a curve no shape uses
  is valid. It is not exported; \`render_preview\` with \`"curves": true\` draws, as thin gray lines under the shapes,
  every curve no shape fills whole (also the ones loops follow only a part of), and the tree lists on its layer's
  line the curves no shape uses at all ("curves without a shape", with its points). Add curves with \`set\` on the layer and a
  \`d\` (any number of subpaths, welded to existing points like a shape's \`d\`; the curves are named \`c1\`, \`c2\`…), or
  write \`points\` and \`curves\` yourself; then create shapes over them with \`"curves": [...]\` instead of \`d\`:
  \`{ "op": "create", "type": "shape", "id": "iris", "parent": "eye", "props": { "curves": ["eye_outer", "eye_inner"],
  "fill": "#3a2a4d" } }\` fills the ring between
  two closed curves (the inner one cuts the hole), and another shape with \`"fill": null, "stroke": "#2b2135"\` over
  the same curves outlines it. That way one layer holds a face's eyes and mouth as rings, only with fills.
  Easier, as the editor's paint bucket: \`"at": [x, y]\` (in the layer's coordinates) instead of \`curves\` fills the
  region at that point, the smallest area the curves close around it, with the closed curves inside it as holes:
  \`{ "op": "create", "type": "shape", "id": "iris", "parent": "eye", "props": { "at": [0, 25], "fill": "#3a2a4d" } }\`.
- **Regions between welded curves** (\`loops\`): curves welded at their points also close areas, as in Moho: two arcs
  that share both ends make a lens; an open line welded to two points of a closed eye splits it into the lid and the
  rest. \`at\` finds those too and writes them as \`loops\`: each loop lists the point ids around the area, and between
  two consecutive points (and from the last back to the first) it follows the curve that joins them, with its
  tangents. The lens of arcs \`top\` and \`bottom\` from \`a\` to \`b\` is \`"loops": [["a", "b"]]\` (along one arc and back
  along the other); when several curves join the same two points and the loop must take a given one, write the entry
  as \`{ "p": "b", "via": "bottom" }\` (the curve from the previous point). A shape can have \`curves\` (whole ones,
  holes included) and \`loops\` together. Loops follow their curves in poses, keyframes and bones; the tree shows them
  on the shape's line (\`loops [a → b]\`). Draw the curves so they meet exactly on shared points: a \`d\` that passes
  through an existing point welds to it; curves that only cross do not close an area.
  A shape has a fill and a stroke: to outline curves a shape already fills, \`set\` its \`stroke\` instead of creating
  another shape (\`at\` refuses a region a shape already covers and names it).
  Give a fill only to closed curves (an open one would be closed with a straight line); open curves take a stroke.
  An open curve does not cut a hole in the shape around it: put the shape it bounds (a mouth) above that one.
  To close an eyelid that is a line welded to the eye's outline (a region in \`loops\`), bend the line in the pose
  without moving its ends: \`{ "face": { "curves": { "lid": { "closed": false, "points": [{ "p": "l", "mode": "mirrored",
  "angle": 30, "dist": 40 }, { "p": "r", "mode": "mirrored", "angle": -30, "dist": 40 }] } } } }\` (the same points as in
  the setup, other tangents); the lid region follows the line, and the eye's outline stays.
  To take a shape off and keep its curves (the editor's Clear), \`{ "op": "delete", "target": "iris", "keepCurves": true }\`;
  to remove only its fill or its stroke, \`set\` it to \`null\`.
- **Poses and keyframes** move points: they list **only the points they move**, and the rest stay as in the setup:
  \`{ "face": { "points": { "chin": { "x": 0, "y": 70 } } } }\` (or with \`transformPoints\`, above). A second
  \`set_pose\` (or a second moment of \`set_keys\` at the same time) **adds** its points to the ones already there, point
  by point; \`remove: ["face.points.chin"]\` takes one out. They can also bend curves (\`curves\` with the same points as
  in the setup, changing only the tangents). In a clip, put the same points in every key of the track.
- **Poses that move the same points add up**, like numbers: each moves its points by (its place − the setup's) ×
  its weight. So eyes that close (a pose that flattens the eyelid and the pupil to the eye's middle line) and pupils
  that look aside (a pose that shifts the pupil) combine: closed and looking gives a flat pupil shifted aside, on the
  closed lid. Recipe for a blink with pupils: in \`eyes_closed\`, scale both the lid and the pupil to the eye's middle
  line (\`transformPoints\` with \`scale: [1, 0.05]\` and \`origin\` on that line); do not hide the pupil with
  \`visible\` (a boolean switches at once at weight 0.5).
- **Bones per point:** each point accepts \`"bone"\` (of its skeleton). \`bind_points\` with the layer's id distributes
  its points among the nearest bones; with \`shape\` or \`points\` it binds only those (and with a single bone in
  \`bones\`, all of them to it): \`{ "path": "face", "shape": "jaw", "bones": ["jaw_bone"] }\`. \`release: true\` unbinds
  them. See «Bones and poses».

## Free-form shapes (\`path\`)

A loose \`path\` (with its own transform) still works, but for drawings prefer vector layers.

The easiest is to pass an SVG path in \`d\` (a single subpath, any command: M L H V C S Q T A Z) and it is
converted to vertices:

\`\`\`json
{ "op": "create", "type": "path", "id": "ear_l", "parent": "head", "props": { "d": "M-60 -150 C-80 -220 -20 -200 -30 -150 Z", "fill": "#3a2a4d" } }
\`\`\`

The coordinates of \`d\` and of the vertices are **relative to the path**: its \`x\`/\`y\` is the pivot. For the path to rotate
around a specific point, put that point in \`x\`/\`y\` and draw around (0, 0).

### Vertices

What is stored is \`vertices\` (and \`closed\`). Each vertex has \`x\`, \`y\` and, if curved, its tangents in
polar form (angle in degrees with Y downward: 0 = right, 90 = down; distance in px):

| Vertex | Shape |
| --- | --- |
| Corner | \`{ "x": 0, "y": 0 }\`, with \`"radius": 8\` to round the corner |
| Symmetric smooth curve | \`{ "x": 0, "y": 0, "mode": "mirrored", "angle": 0, "dist": 20 }\` |
| Smooth curve with different lengths | \`{ "x": 0, "y": 0, "mode": "asymmetric", "angle": 0, "inDist": 10, "outDist": 30 }\` |
| Cusp (independent tangents) | \`{ "x": 0, "y": 0, "mode": "detached", "inAngle": 200, "inDist": 15, "outAngle": -20, "outDist": 15 }\` |

\`angle\`/\`outAngle\` is the direction of the tangent going out toward the next vertex; the incoming one points toward
the previous one (in mirrored and asymmetric it is \`angle + 180\`). To tweak a single vertex you can read \`vertices\`,
change that element and resend the whole list with \`set\`.

## Images (\`image\`)

An \`image\` layer draws a PNG, JPG, WebP or SVG file (the whole SVG, without being able to edit its shapes; for editable
shapes, the user has Import SVG in the editor). The file lives in the document's \`assets/\` folder and \`src\`
is its name.

- **Add:** \`add_image\` with \`path\` (absolute path of a file the user pointed you to) or \`url\`. It copies the
  file to \`assets/\` and creates the layer centered on the canvas, at its natural size (shrunk if it doesn't fit), or where and at the
  size you say (\`x\`, \`y\`, \`width\` or \`height\`; with only one, the other follows in proportion). Returns the preview.
- **Reuse a file** already in \`assets/\` (for example, the same image twice): \`create\` with \`apply_ops\` and
  its \`src\`. \`get_document\` lists the files in \`assets/\` with their natural size and the layers that use them.
  A \`src\` that isn't in \`assets/\` is accepted but not drawn, and apply_ops warns.
- **Change the file** of a layer: \`add_image\` with \`replace\` (the layer id). It keeps the width and the height
  follows the new file's proportion, as the editor's Replace… does.
- **Original size:** set \`width\` and \`height\` to the natural size that \`get_document\` lists for its file.
- It behaves like any layer: it is centered on \`x\`/\`y\` (\`originX\`/\`originY\` move the pivot), goes inside
  groups, switches and skeletons, sticks to a bone with \`bone\`, and in poses and clips its position, rotation, scale,
  \`opacity\`, \`visible\`, \`width\` and \`height\` are animated. \`width\`/\`height\` stretch it: to avoid distorting it, change them in
  proportion or use \`scaleX\`/\`scaleY\`.
- To change images in an animation (mouths, drawn eyes), put one \`image\` per variant inside a
  \`switch\`.
- Undo removes the layer, but the file stays in \`assets/\`.
- In \`render_preview\` a WebP image shows as a gray box with a cross (at its place and size): that view
  can't draw WebP. The user sees it fine. PNG, JPG and SVG show as they are.

\`\`\`json
[
  { "op": "create", "type": "image", "id": "sun_copy", "props": { "src": "sun.png", "x": 600, "y": 120, "width": 80, "height": 80, "opacity": 0.6 } }
]
\`\`\`

## Styles and gradients (assets)

\`style\`, \`linear_gradient\` and \`radial_gradient\` are **assets**: they go at the root, are not drawn, and shapes
use them by id.

- **Shared style:** create a \`style\` (for example \`skin\` with \`fill\` and \`stroke\`) and put \`"style": "skin"\` on
  the shapes. Properties the shape doesn't set itself come from the style; changing the style changes all of them at
  once. Use it for the character's palette: skin, hair, clothes, outline.
- **Gradient:** create a \`linear_gradient\` or \`radial_gradient\` with its \`stops\` and put its id in \`fillGradient\` of
  the shape (or of the style). Its coordinates go from 0 to 1 over the shape's box.

\`\`\`json
[
  { "op": "create", "type": "linear_gradient", "id": "fur_shade", "props": { "stops": [{ "offset": 0, "color": "#f5a142" }, { "offset": 1, "color": "#c86b1e" }] } },
  { "op": "create", "type": "style", "id": "fur", "props": { "fillGradient": "fur_shade", "stroke": "#4a2a10", "strokeWidth": 3 } },
  { "op": "set", "target": "body", "props": { "style": "fur" } }
]
\`\`\`

## Bones and poses

As in Moho, the skeleton lives in a **bone layer**: a \`skeleton\`. It is a container like \`group\` that holds
inside, in drawing order, **the drawing the skeleton moves** and, separately, **its bones**. \`bone\`s can only
be inside a \`skeleton\` (root bones) or inside another \`bone\` of the same skeleton: never at the root nor in a
\`group\`. The drawing doesn't go inside the bones: it is **bound** with the \`bone\` property (of any layer or
group), so the drawing order stays free (an arm can go behind the torso even though its bone is a child of the torso).

- **Skeleton first.** Create a \`skeleton\` (for example \`rig\`) and draw inside it, or move the existing drawing in
  with \`move\`. If the skeleton is at \`x: 0, y: 0\` with no rotation, moving something inside doesn't change where it shows; if
  it has a transform, recompute \`x\`/\`y\` when moving it (as with any group).
- **Binding limited to its skeleton:** an object can only bind to bones of the skeleton that contains it (the
  nearest). What is outside every skeleton isn't bound. A skeleton can go inside another and be bound as a whole
  to a bone of the outer one (a hand with its own bones, following the forearm).
- **Without a binding it doesn't move:** drawing in a skeleton that has no \`bone\` (nor inherits it from a group) stays still
  in poses. \`get_document\` marks it as "no bone". To bind everything at once, \`bind_by_proximity\` puts
  each unbound piece on the nearest bone (by the center of its box); then check the distribution and fix with
  \`set\` whatever landed wrong.
- Ids are unique across the whole document (drawing, bones and assets): name bones with the suffix \`_bone\`
  (\`head_bone\`, \`tail_1_bone\`) so they don't clash with the drawing's groups.
- **The easiest way to create bones is with \`from\` and \`to\`**: origin (the joint) and tip, as \`[x, y]\` in
  **document** coordinates (even if the skeleton is moved or rotated). They are converted automatically to \`x\`, \`y\`,
  \`rotation\` and \`length\` relative to the parent. They also work in \`set\` (only \`to\` keeps the origin).
- What is stored: a bone starts at its \`x\`/\`y\` (relative to its parent bone; a root bone, relative to its
  skeleton) and points according to \`rotation\` (0 = right, 90 = down, -90 = up) with length \`length\`. \`rotation\` and
  \`x\`/\`y\` are **relative to the parent**: the on-screen angle is the sum along the chain (plus the skeleton's rotation). Poses
  use these relative values. \`get_document\` shows where each bone ends up in the document.
- **Changing a bone's parent:** use \`reparent_bone\`, not \`move\` (which keeps the relative values and shifts the
  bone): it recomputes its values so it stays where it was in the setup, and the ones the poses set for it. With
  the skeleton as parent, it becomes a root bone. Watch out for poses that move the old parent (or an ancestor the
  new one doesn't share) or the new parent: there the bone does change place, because it now follows another one. The response
  lists those poses; with \`keep_in_poses: true\` they are also adjusted so it stays where it was.
- **Setup:** the values stored in the bones are the rest pose. Place the bones over the drawing as it
  is. **Binding moves nothing**: an object with \`"bone": "forearm_l_bone"\` (and all its children) follows that bone
  only when a pose moves it. Moving, rotating or scaling the skeleton moves the drawing and the bones together.
- Bind at the highest level that makes sense: the group \`head\` to the bone \`head_bone\`, and the group's children follow it
  without binding them one by one. A child with its own \`bone\` follows its own.
- **Parts that bend** (tail, flexible arm, long neck): there's no need to split the drawing. A vector layer (or a
  \`path\`) can follow several bones **per point**: each point of its mesh (or vertex of the path) accepts
  \`"bone": "tail_2_bone"\` (of its skeleton) and, in a pose, moves with its tangents according to that bone.
  \`bind_points\` distributes the points among the nearest bones of its skeleton (or of a list). Points without
  \`bone\` follow the layer's bone (or its group's). Put points near each joint so the curve bends well.
- **Per-point binding belongs to the setup**, as in Moho: a pose that changes a loose path's shape (\`vertices\` or
  \`d\`) doesn't store \`bone\` in its vertices; when applied, vertex i follows the bone of vertex i in the setup. So
  the pose should have the same vertices, in the same order. To change which bone a point follows,
  change the setup.
- **Poses:** a \`pose\` is a named asset that sets values (absolute, as in the setup) without changing the
  setup: in \`values\`, \`{ object_id: { property: value } }\`. It is created with \`set_pose\` (or with \`apply_ops\`) and
  viewed with \`render_preview\` passing \`pose\`. A bone's \`minAngle\`/\`maxAngle\` limit its rotation in
  poses. A pose isn't limited to bones: see the next section.
- **A bone's \`rotation\` is relative to its parent bone** (what poses and keyframes write); the tree of
  \`get_document\` gives both, \`rotation -170.8 (99° on screen)\`. Write angles close to the stored one, or relative
  to the setup with \`"+=n"\` in \`set_pose\` and \`set_keys\`: \`{ "upper_arm_l_bone": { "rotation": "-=110" } }\`. An
  angle that ends up far from the setup's (189 instead of -171) looks the same alone but turns almost a full circle
  when blended or tweened.
- Bones don't show in the character's image: to check where they ended up, use \`render_preview\` with
  \`bones: true\` (and \`pose\`, to see them posed).

\`\`\`json
[
  { "op": "create", "type": "skeleton", "id": "rig", "index": 0 },
  { "op": "move", "target": "body", "parent": "rig" },
  { "op": "move", "target": "head", "parent": "rig" },
  { "op": "move", "target": "arm_l", "parent": "rig" },
  { "op": "create", "type": "bone", "id": "spine_bone", "parent": "rig", "props": { "from": [300, 420], "to": [300, 300] } },
  { "op": "create", "type": "bone", "id": "neck_bone", "parent": "spine_bone", "props": { "from": [300, 300], "to": [300, 260] } },
  { "op": "create", "type": "bone", "id": "upper_arm_l_bone", "parent": "spine_bone", "props": { "from": [350, 320], "to": [350, 390] } },
  { "op": "set", "target": "body", "props": { "bone": "spine_bone" } },
  { "op": "set", "target": "head", "props": { "bone": "neck_bone" } },
  { "op": "set", "target": "arm_l", "props": { "bone": "upper_arm_l_bone" } },
  { "op": "create", "type": "pose", "id": "wave", "props": { "values": { "upper_arm_l_bone": { "rotation": 45 } } } }
]
\`\`\`

The three \`move\`s put the drawing into \`rig\` (which is at the origin, so nothing changes place). With \`from\`/\`to\`,
\`spine_bone\` ends up at \`x: 300, y: 420, rotation: -90, length: 120\` (pointing up), and \`upper_arm_l_bone\` at
\`x: 100, y: 50, rotation: 180\`: relative to \`spine_bone\`, which is already rotated -90°, so on screen it hangs
down (-90 + 180 = 90°). In the pose \`wave\` it is at -90 + 45 = -45°: raised up and outward. Instead of the
three \`set\`s of \`bone\` you could use \`bind_by_proximity\` with \`skeleton: "rig"\` and check what it chose.

## Expressions: poses, params, drivers and switch

This is how the character is controlled from outside (the app, another AI): with high-level **params** (\`happiness\`,
\`head_turn\`, \`viseme\`) instead of moving individual pieces. Like Moho's smart bones, but explicit:

1. **Pose**: what changes in an expression. It can set **any animatable property** of any object:
   bone rotation, the \`vertices\` of a mouth or an eyebrow (it also accepts \`d\`), \`fill\`, \`opacity\`, \`visible\`, a
   switch's \`active\`... For a shape to **interpolate** (morph) between the setup and the pose, the pose must
   have **the same number of vertices** as the setup: redraw the same line by moving the points.
2. **Param**: the control. \`kind\` \`number\` (between \`min\` and \`max\`), \`boolean\` or \`enum\` (\`options\`). Its value isn't
   stored: whoever uses the character sets it.
3. **Driver**: connects a param to a pose. The param span \`inMin\`…\`inMax\` becomes weight \`outMin\`…\`outMax\`
   (0 = nothing, 1 = the full pose). With an enum, \`equals\` says which option the pose goes with.
4. Several active poses **add up** over the setup: numbers add their differences (head turned + happy),
   colors and vertices interpolate, and what doesn't interpolate (a switch's \`active\`) is taken from the pose with weight
   ≥ 0.5.

**Switch**: a group that shows a single child, the one in \`active\` (or the first, if null), like Moho's switch layer.
It is created with \`create\` and \`type: "switch"\`, and each variant is a child of it (\`parent\`). To choose which one shows,
\`set\` with \`{ "active": "<child>" }\`: it's the same thing the user does with the switch's ▾ menu in Layers or with the
picker in the options bar. In a pose: \`set_pose\` with \`{ "<switch>": { "active": "<child>" } }\`. If a param
has to choose the variant (mouths, visemes), build the pieces yourself: an enum param, one pose per option that sets
\`active\`, and a driver with \`equals\` for each one, as in the example below. If you take out of the switch a variant that a pose chooses, the batch fails: first remove
from the pose only the switch's \`active\` with \`set_pose\` and \`remove: ["mouth.active"]\` (not with \`{ "mouth": {} }\`, which
would remove from the pose everything about \`mouth\`, for example its \`x\`), or leave the variant inside the switch. \`remove\` works
to remove any single property from a pose.

The \`initial\` of an enum param and the \`equals\` of its drivers must be options in \`options\`; in a numeric
param, \`min\` can't be greater than \`max\`. To remove or rename an option a driver uses, change its
\`equals\` (or delete the driver) **in the same batch** as the \`set\` of \`options\`. \`get_document\` says for each switch
which params choose its variant (those with drivers to poses that set its \`active\`).

\`\`\`json
[
  { "op": "create", "type": "param", "id": "happiness", "props": { "min": -1, "max": 1 } },
  { "op": "create", "type": "pose", "id": "happy", "props": { "values": { "mouth_line": { "d": "M-20 0 Q0 14 20 0" }, "brow_l": { "rotation": -8 } } } },
  { "op": "create", "type": "pose", "id": "sad", "props": { "values": { "mouth_line": { "d": "M-20 6 Q0 -8 20 6" }, "brow_l": { "rotation": 12 } } } },
  { "op": "create", "type": "driver", "id": "happiness_happy", "props": { "param": "happiness", "pose": "happy", "inMin": 0, "inMax": 1 } },
  { "op": "create", "type": "driver", "id": "happiness_sad", "props": { "param": "happiness", "pose": "sad", "inMin": 0, "inMax": -1 } },
  { "op": "create", "type": "param", "id": "viseme", "props": { "kind": "enum", "options": ["rest", "a", "o", "m"] } },
  { "op": "create", "type": "pose", "id": "viseme_o", "props": { "values": { "mouth": { "active": "mouth_o" } } } },
  { "op": "create", "type": "driver", "id": "viseme_o_driver", "props": { "param": "viseme", "pose": "viseme_o", "equals": "o" } }
]
\`\`\`

Here \`happiness\` goes from -1 (sad) to 1 (happy): from 0 to 1 \`happy\` comes in and from 0 to -1 \`sad\` comes in. \`mouth_line\`
has in the setup the same 2 vertices as in the poses, so the mouth curves gradually. Check the blend with
\`render_preview\` and \`params\` (for example \`{ "happiness": 0.5, "viseme": "o" }\`); the text says which poses ended up
active and with what weight.

## Animation: clips with keyframes

The editor has three modes: **Design** (drawing and rig), **Animate** (a scene timeline to export to video,
Lottie or SVG) and **Puppet** (the puppet ready for an app or its AI to drive live: params, poses and short
clips that get triggered, one per button). The last two use the same asset, \`animation\` (a clip), with
\`usage\` \`animate\` or \`puppet\`. When the user opens Animate on a document without scenes, the editor creates an
empty 5 s scene (\`scene_1\`, origin "user" in the history): it is the user's working scene, so use it for their scene
(or leave it) rather than treating it as a finished touch-up.

- **Tracks** (\`tracks\`): \`{ object_id: { property: [ { "t": 0, "value": 0 }, { "t": 0.4, "value": -60, "ease": "ease-out" } ] } }\`,
  with the same shape as a pose's \`values\`: **absolute** values, as in the setup. Any animatable
  property works: bones, \`fill\`, \`opacity\`, a switch's \`active\`, \`vertices\` (or \`d\`) with the same number
  of points for a morph. **Only in a Puppet clip**, a **param** also has a track: \`{ "happiness": { "value": [...] } }\`,
  and its drivers add the pose (a «laugh» clip can take \`happiness\` to 1 instead of repeating the happy face).
- **An Animate scene has no params or drivers:** you see the setup with its keyframes, nothing else (as it's exported).
  Poses and params belong to the puppet; in a scene, an expression is copied as keyframes (\`set_keys\` with
  \`pose\`) and a variant is chosen by keying the switch's \`active\` (\`values: { "mouth": { "active": "mouth_o" } }\`).
- \`t\` in seconds, from 0 to \`duration\`. Before the first keyframe it holds the first; after the last, the last; a
  property without a track holds the setup value. So **key the initial state at \`t = 0\`** (for example the normal mouth):
  if the mouth's first keyframe is at 1 s with «a», the clip shows «a» from 0. \`loop\`: \`once\`, \`loop\` (starts over: put at \`t = duration\` the
  same values as at 0 so it doesn't jump) or \`pingpong\`.
- To **start and end at rest**, a moment with \`setup: true\` sets the setup on everything the clip animates (and,
  in Puppet, the params to their initial value), without copying values by hand.
- **Careful with params (Puppet):** animating a param moves **all** the poses of its drivers, including those the
  user made (\`happiness\` can move \`happy\` and also \`look_up\`). \`set_keys\` and \`render_preview\` list, for
  each animated param, which poses it moves and which objects each one touches: read it before calling the clip done. If one of
  them also moves something the clip animates (a bone), the two add up; check it with the frame strip.
- \`set_keys\` only changes the tracks you name: the others, including the user's tweaks, stay as they were, and
  \`undo\` works per track. A moment with only \`t\` and \`ease\` changes the curve of the keyframes already at that time.
  To lengthen a clip, \`duration\` is enough.
- \`ease\` goes on the keyframe and applies to the span that **leaves** it. Named curves:
${CURVE_DESCRIPTIONS.map(([name, meaning]) => `  - \`${name}\`: ${meaning}.`).join('\n')}
  Or \`[x1, y1, x2, y2]\` (CSS cubic-bezier) if none fits. Prefer a named one over guessing numbers: for
  «snaps back at the end of the span», \`ease-in-expo\`; for «arrives and bounces a little», \`ease-out-back\`. A switch's
  \`active\`, booleans and strings change abruptly.
- Order in a **Puppet** clip: setup → clip at that time → drivers add their poses on top (the clip's params
  override the outside ones). In an Animate scene there are no drivers: only setup → clip.
  **Numbers and the points of vector layers add up** (a bone keyed at 10 with an active driver that adds 30 shows at
  40; for numbers, \`set_keys\` and \`render_preview\` warn about it; for points, check with \`render_preview\`). What **doesn't add up** (a switch's \`active\`, colors, the
  vertices of a loose path, booleans) is decided by the clip's track if it has one; otherwise, by the drivers.
- **If a param chooses the variant** (visemes, mouths, eyes): in a **Puppet** clip, animate the **param**
  (\`params: { "viseme": "o" }\`) and not the switch's \`active\`; that way the clip uses the same pieces as the app and combines
  with its drivers (an enum param always has an active option: its drivers are always in play). In a
  **scene**, key the \`active\` (\`values: { "mouth": { "active": "mouth_o" } }\`) or copy the pose with \`pose\`.
- **How to build it:** \`set_keys\` thinks in **moments**: «at t = 0.3, the arm like this and the mouth like this» (\`values\`, as in
  \`set_pose\`), «at t = 0.6, the pose \`happy\`» (\`pose\`, copies its values; with \`only: ["eye_l", "eye_r", "mouth"]\` only
  that part, with \`except: ["tail_bone"]\` everything but that) or, only in a Puppet clip, params (\`params\`): params belong
  to the puppet and an Animate scene doesn't animate them (key the values, or copy the pose with \`pose\`). It creates the clip if it doesn't
  exist. If a scene has param tracks (a clip that went from Puppet to Animate), remove them with \`set_keys\` and
  \`remove\` or with \`delete_keys\` and \`targets\`. \`delete_keys\` removes keyframes and \`move_keys\` moves them in time (with their value and curve).
  A number in \`values\` can be **relative to the setup**: \`{ "head_bone": { "rotation": "+=14" } }\` is 14° more than in
  the setup (\`"-=0.3"\` subtracts); the absolute value is stored (the same in \`set_pose\`). A vector layer takes
  \`transformPoints\` (see «Vector layers»). The \`ease\` of a moment shapes the stretch that **leaves** it, toward
  the next keyframe: on the last moment it does nothing. Check the
  motion with \`render_preview\` and \`animation\` + \`times\` (a frame strip in a single image) or \`time\` (one
  frame). \`get_document\` lists each track of a clip with its keyframes (\`t = value curve\`), to read it without the JSON.
  In a document with many clips, \`get_document\` with \`json: false\` and \`clips: ["wave"]\` gives the tree with the tracks
  of only those clips (if the response is very large, the JSON is left out automatically). The responses of \`apply_ops\` and
  \`undo\` show clips summarized, without their tracks.
- **Changing the timing:** \`scale_time\` stretches or compresses all keyframes and the duration proportionally, in a single undo
  step (\`duration: 1\` leaves the clip at 1 s; \`factor: 0.5\`, twice as fast; with \`from\` and \`to\`, only that
  span, and what comes after shifts). Don't move the moments one by one with \`move_keys\` for that.
- \`duration\` in \`set_keys\` can't end up shorter than the keyframes: to shorten the clip with everything in it, use
  \`scale_time\`; to cut the end, delete the last keyframes first.
- For Puppet, write \`description\` (what the clip does, in a few words): the app's AI reads it to choose when to
  trigger it. Puppet clips are usually short (blink 0.2 s, wave 1–1.5 s, idle loop 2–4 s).

## Live puppet

An app (or its AI) drives the puppet with three verbs: \`play(clip)\`, \`set(param, value)\` and \`stop(clip)\`. There is no state
machine: the app decides what plays. How each Puppet clip plays is said by the clip:

- **Base or gesture** comes from \`loop\`: a clip in \`loop\`/\`pingpong\` (idle, listening, thinking, talking) is **the
  base**: \`play\` switches it with a crossfade and it keeps playing. A \`once\` clip (wave, nod, surprise) is
  a **gesture**: it comes in **on top of** the base, overrides **only the tracks it has** and leaves by itself at the end. So a gesture
  shouldn't key what isn't its business (a wave that keys the mouth covers the mouth of «talking»).
- \`fade\`: seconds of the fade in and out (0.2 by default; 0 for the blink). A gesture starts leaving
  \`fade\` seconds before its end.
- \`next\` (\`once\` clip): what gets triggered when it starts leaving. Chains: \`start_talking\` → \`talking\`,
  \`surprised\` → \`idle\`. If \`next\` is a looping clip, it becomes the base.
- \`auto\`: what the puppet does on its own, without the app asking: \`repeat\` (every \`repeat_min\`…\`repeat_max\` s at random:
  the blink) or \`always\` (always looping: breathing). They go on top of gestures. The app doesn't trigger them.
- \`blend: "additive"\`: the clip **adds** its difference from the setup instead of overriding (breathing with \`scaleY\`
  1.02 adds 0.02 to whatever is there). Only numbers add up.
- **Params:** the value is set by the app with \`set\`. If a clip animates that param, the clip wins while it plays and, on leaving,
  it smoothly returns to the app's value. Write the \`description\` of each param (what it controls and what its extremes do,
  for example «-1 looks at the viewer, 1 looks away»): the app reads it.
- **A base that animates a param takes it away from the app** while it plays, which is almost always. In a base, animate only
  what is part of that state (\`viseme\` in «talking»); leave expressions like \`happiness\` to the app or to gestures.
- **Angles blend as numbers.** The fade between bases (or when a gesture comes in) interpolates \`rotation\`: an
  arm at 140 when the setup has it at -178 makes almost a full turn, even if on screen it looks similar.
  Write angles close to the setup's (-220 instead of 140; \`"+=n"\` helps). \`set_keys\` warns when a
  rotation in a Puppet clip ends up more than 180° from the setup.
- **\`next\` replaces the base** if it's a looping clip: a gesture with \`next: "idle"\` triggered during «talking»
  leaves the character at idle. Use it for reactions that change state; a gesture without \`next\` returns by itself to the base that
  was there.
- **Automatic blink:** if there was already a blink keyed inside a base (\`idle\`), take it out when creating the auto
  \`repeat\` (otherwise it blinks twice). An \`auto\` clip is no longer triggered by the app: if the app also needs an
  on-demand blink, keep another \`once\` clip. The first time it plays at random between \`repeat_min\` and \`repeat_max\`
  seconds after start.
- \`fade\` eats the end of a gesture: the gesture starts leaving \`fade\` seconds before finishing. With a long fade,
  lengthen the clip or keep the end still. In a \`once\` clip the fade is never more than half its duration (otherwise the
  gesture would never be seen whole). An \`auto: "always"\` clip always plays looping even if its \`loop\` says \`once\`.
- \`stop\` with a clip that isn't playing does nothing; with an id that doesn't exist or an \`auto\` clip, it errors. With Live
  on in the editor, the person doesn't edit by hand, but your MCP changes (and undo) are applied and the puppet
  continues with the new document.

All of this is set with \`set_keys\` (\`fade\`, \`next\`, \`blend\`, \`auto\`, \`repeat_min\`, \`repeat_max\`) or with \`apply_ops\`.
To see how the app will see it, \`render_preview\` with \`live\`: a script \`[{ "t": 0, "play": "idle" }, { "t": 1, "play":
"wave" }, { "t": 1.2, "set": { "happiness": 1 } }]\`. By default the strip runs until the last triggered gesture
ends (every 0.25 s, at most 24 frames); \`until\` says until when and \`times\` picks the frames. The text says
what plays in each frame and with what weight, and when each auto \`repeat\` played (a blink usually falls between frames). The
randomness uses a fixed seed (the same script gives the same strip) and \`auto: false\` turns off the auto layers to compare. When finishing a Puppet, read **\`get_manifest\`**: it's what the app's AI receives (params with which poses they
move, clips with their description, the automatic ones). An empty description or a param that moves nothing there is a
problem for the app.

## Types

### \`meta\` (document properties, changed with \`target: "meta"\`)

${table(schema.meta.properties)}

${types}

## How to work well

1. **Check the history** (\`get_history\`, with \`origin: "user"\` to see only the user's) before editing an existing
   document. Each entry has \`origin\` (\`"ai"\` or \`"user"\`), \`kind\` (\`"create"\`, \`"change"\`, \`"undo"\` or
   \`"redo"\`) and \`note\`. The user's entries are hand tweaks: respect them and don't overwrite them.
   In the \`get_document\` tree, a layer marked "(locked by the user)" is one the user protected (\`locked\`): don't
   change it or its children unless the user asks for it, and don't unlock it.
2. **Use groups as joints.** A group's \`x\`/\`y\` is its pivot: for a head to rotate from the
   neck, put the group \`head\` at the neck and draw the face with negative \`y\` inside the group.
3. **Look at the result** with \`render_preview\` after each important change.
4. **Prefer few large batches** with a clear note (\`note\`): each batch is one undo step for the user.
5. If you make a mistake, \`undo\` undoes your last batch (only yours, never the user's). If the user changed
   any of the same properties afterward, \`undo\` refuses and says which: fix them with a new batch, without
   overwriting their tweak. The same happens to them with yours. In a pose the unit is each object and property
   (\`values.mouth.active\`), not the whole pose: if the user tweaked another object in the same pose, your \`undo\` undoes
   only yours and leaves theirs.
6. To check a small detail, \`render_preview\` accepts \`region\` (a crop of the document) besides \`pose\`.
7. \`delete_document\` deletes a whole document (from the \`documents/\` folder) and can't be undone: use it only if the user asks.
8. There's no SVG importer for the AI: pass each shape as the \`d\` of a \`shape\` inside a vector layer (holes
   included: a \`d\` with several subpaths is one shape).
`;
}
