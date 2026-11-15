# Build plan

> Status: **phase 5 under construction: core, MCP and basic editor ready and AI-tested (8/8)** (2026-11-05). Based on [sintesis.md](sintesis.md) and on the research into
> [Moho](investigacion/moho-lua.md) and [Rive](investigacion/rive-runtime.md).

## How we work

We move in **short phases**. Each phase leaves something usable and closes with three tests:

1. **Automated tests** of the core (`npm test`).
2. **Manual test in the editor**: what was added can be done and corrected with the mouse.
3. **AI test over MCP**: we give an AI a fixed list of tasks in natural language and record how it did
   in [pruebas-ia/](pruebas-ia/). That tells us which parts of the format or the tools confuse the AI, and we
   fix them before moving on.

Rules that apply to every phase:

- **Every change is an operation.** The editor and the MCP use the same operations engine, with validation, undo and
  origin tracking (`ai` / `user`). The SVG DOM is just a view.
- **The schema rules** *(from Rive)*. Each type is described once in `schema/`; validation, the editor's
  inspector and the guide the AI reads all come from it. Adding a new type shouldn't require touching the editor or the MCP by hand.
- **Stable text IDs and a flat list with `parent`** *(the opposite of both)*.
- **Rig separate from animation** *(from Moho: frame 0 = setup pose)*.

### Measuring the AI

Each phase has its `pruebas-ia/fase-N.md` file with the tasks and, for each run, a row with: client and model,
tasks achieved, batches rejected by the validator, corrections that had to be made by hand and notes on what
confused it. We run at least with the most used client (Claude Desktop or Claude Code).

---

## Phase 0: preparation ✅ (2026-11-02)

- Initialize git. Save the current prototype under the tag `prototipo-0` for reference, and remove it from the working
  tree.
- New structure:

  ```
  schema/      type defs (single source of truth)
  src/core/    document, validation, operations, evaluation (no DOM, runs in Node and the browser)
  src/render/  SVG renderer
  src/editor/  interface
  mcp/         MCP server
  server/      disk + local API for the editor (Vite plugin)
  documents/   documents
  docs/pruebas-ia/
  ```

- Settle what the synthesis left open: time in **seconds** (with `fps` only for display and snapping),
  coordinates with **Y down** and angles in degrees.

**Done when:** the repo starts empty but with `npm run dev`, `npm test` and `npm run mcp` working.

## Phase 1: schema, document and editor shell ✅ (2026-11-02)

The AI test came out 8/8 with no rejections ([results](pruebas-ia/fase-1.md)). Adjustments made from what it found:
- The editor merges consecutive changes to the same thing (arrows, numeric fields) into a single batch: one history
  entry and one undo step.
- `duplicate` operation (object with its children) and `create_document` with `copy_from` and `background`. In the editor:
  `Ctrl+D` and ☰ → «Make a copy…» of the document.
- `apply_ops`, `undo` and `redo` return the resulting tree and say which batch they touched; `get_history` is a summary
  by default (which properties each batch touched) and can be filtered by origin.
- The guide states that left and right are the character's (`_l`, `_r`).

Notes on what was built:
- The operations are `create`, `set`, `unset`, `delete`, `move` and `rename`, addressed by id (`target`) and not by
  paths: it feels more natural to the AI and errors are easier to explain (with suggestions of similar ids).
- Undo and redo go **by origin** and are computed from the history: the AI undoes only its own changes and the user
  only theirs. If the document changed and the inverse no longer fits, it warns instead of breaking anything.
- When reparenting from the tree, the editor keeps the on-screen position. Over MCP, `move` doesn't touch `x`/`y`.
- Pending for later: copy/paste between documents.

**Core**
- Def format inspired by Rive (`type`, `extends`, properties with `type`, `default`, `animatable`, `range`,
  `enum`, `description`) and its loader.
- Document: `format`, `meta` (size, fps), flat list `objects` with `type` and `parent`. Initial types: `group`
  (transform + opacity) and `shape` with `rect` and `ellipse` primitives.
- Operations engine: `set`, `add`, `remove`, `move` (reparent and reorder), atomic batches, undo/redo,
  history with origin. Keeps unknown properties (*forward compatibility, from both*).
- Validation generated from the defs, with messages designed so the AI can correct itself.

**Editor**
- Full layout even though several panels are empty: toolbar, object tree, canvas with pan and
  zoom, inspector, timeline (empty) and history.
- Tree with drag to reorder and reparent. Inspector **generated from the defs**.
- Selection on canvas and tree, undo/redo, autosave and a live notice when the AI changes something.

**MCP**
- `get_guide` (generated from the defs, not handwritten), `list_documents`, `get_document`, `create_document`,
  `apply_ops`, `undo`, `get_history`.
- `render_preview`: returns a **PNG image** so the AI sees what it did (e.g. with `resvg-js`).

**AI test:** build the structure of a simple character with groups and primitives; rename and reorder;
fix something the user changed by hand without overwriting it.

## Phase 2: drawing ✅ (2026-11-03)

The AI test came out 7/7 with no rejections; tasks 8 to 10 were not run ([results](pruebas-ia/fase-2.md)).
What the AI asked for (inheritance between styles, gradients tied to the color, mirrored duplicate, zoomed preview)
is noted there for later.

After the test (user request):
- **Multiple selection:** Ctrl or Shift + click on the canvas; marquee by dragging in an empty spot (hits shapes, not
  groups); in the hierarchy, Ctrl + click adds or removes and Shift + click takes the range. Move, arrows, rotate and scale
  (from the center of the set, proportional), duplicate, delete and dragging in the hierarchy act on all of them.
  `Ctrl+G` groups the selection and `Ctrl+A` selects all. The inspector shows what they have in common and flags
  differing values.
- Assets goes at the bottom of the left panel, separate from Layers.

Notes on what was built:
- `path` with vertices in polar form (straight with `radius`, mirrored, asymmetric, detached). The AI can pass SVG `d`
  (all commands, arcs included) and it is converted to vertices.
- `style`, `linear_gradient` and `radial_gradient` assets: they live at the root, aren't drawn, and shapes use them by
  id (`style`, `fillGradient`). Own value → style → default value.
- Editor: handles to rotate, scale from the pivot and move the pivot (groups and paths, compensating the content),
  pen, point editing (drag anchors and tangents, Alt splits, double click straight/curved, click on the outline
  adds, Del deletes) and SVG import (shapes with transforms and colors; scripts and events are discarded).
- Interface closer to Rive and Moho (user request): ☰ menu, closable document tabs,
  grouped tools (Transform: Move, Rotate, Scale; Create: Pen, Rectangle, Ellipse), rotate and scale tools that
  work by dragging anywhere (as in Moho), collapsible hierarchy, inspector with pairs on one
  row (X/Y, width/height, scale) and zoom menu.
- **Changes from the plan:** stackable fills and strokes are left for later (for now done
  with duplicated shapes). A path has a single outline: holes (rings) can't be made yet, and on
  import each subpath becomes a separate path.

- Paths with editable vertices. A single vertex type with `mode`: `straight` (with `radius`), `mirrored`,
  `asymmetric`, `detached`, and tangents in **polar form** (angle + distance) *(from Rive)*.
- Stackable fills and strokes, gradients, and **styles shared by reference** *(from Moho)*.
- Editor: transform tools (move, rotate, scale with pivot), pen and vertex editing, SVG import
  (converted to our paths).
- MCP: no new tools, except helpers if the AI has trouble creating paths.

**AI test:** draw an original character from a description; fix proportions; change the
palette using the shared styles.

## Phase 3: bones ✅ (2026-11-03)

The AI test came out 9/9 with one rejection ([results](pruebas-ia/fase-3.md)). The most important thing it showed: a
shape doesn't bend with several bones (the AI split the tail into segments), and creating bones with relative coordinates
is hard. Candidates left: weight-based deformation, bones with `from`/`to` in document coordinates, final
values in `get_history` and `set_pose` warnings when clamping angles.

Adjustments made from what it found:
- **Point binding** (from the Moho manual): each vertex of a path accepts `bone` and, in a pose, moves with its
  tangents according to that bone. A single path bends with a chain of bones, without splitting the drawing. In the editor, when
  editing points, the options bar picks the point's bone or «Distribute among bones» (the nearest); over MCP,
  `bind_points`. In a pose, dragging that path rotates the bone nearest to the click. Weights across several bones
  per point remain for later.
- Bones with `from`/`to` in document coordinates (converted to `x`, `y`, `rotation` and `length`).
- `get_history` shows the final value of what each batch set; `set_pose` warns when a limit clamps an
  angle; `undo` says what it undid; a repeated id when creating a bone suggests the `_bone` suffix, which the
  guide also proposes.

**Switch to Moho's bone layer model (2026-11-04).** Using it by hand, having bones as loose rows
in the hierarchy, mixed with the drawing, and the binding hidden in a property that could point to any bone
in the document turned out confusing. We moved to Moho's model:
- `skeleton` type (the *bone layer*): a transformable container, like a `group`, that holds the drawing it
  moves and its bones. `bone`s can only be inside a skeleton (root bones) or another bone
  (`requiresParent` in the schema); the frame of root bones is the skeleton's, so moving, rotating or
  scaling it carries drawing and skeleton together. A skeleton can go inside another and follow one of its bones.
- The `bone` of an object or a vertex can only point to bones of the skeleton that contains it (`refScope:
  "skeleton"`), with messages saying which bones are valid. Layer binding, point binding and the rule that binding
  doesn't move anything all remain.
- No automatic binding: a skeleton's drawing stays still until bound. «Bind all by proximity» (options
  bar and `bind_by_proximity` in the MCP) binds each unbound piece to the bone nearest the center of its box, with the
  largest pieces possible: a group with nothing bound inside goes whole; if something inside is already bound, it goes down to its
  children. We chose the box (and not the pivot) because group pivots tend to sit at the joint, which falls
  right between two bones.
- Layers only has layers, as in Moho: bones aren't rows (we tried a «Bones (N)» subnode and removed it; in
  Moho the bone hierarchy is seen on the canvas). Two tools, as in Moho: **Add Bone** (B) only creates (in the
  selected skeleton or the selection's; if there is none, it creates one and says so) and **Manipulate Bones** (M) only
  adjusts (rotate, move the origin, direction and length). Before, a single tool did everything and felt clumsy.
- Binding and parenting are tools too, as in Moho: **Reparent Bone** (as in Blender: pick the children and the
  parent last, and a bar button makes the change; «Clear parent» leaves them as roots; nothing happens with a single
  click, which in the first version proved too automatic. It changes the parent without moving the bone; `opsToReparent` recomputes its values in the new frame, poses included), **Bind Layer** (L,
  replaces the «Bind drawing…» mode) and **Bind Points** (click or marquee over points, without entering path
  editing). From Rive we took per-bone colors, which also paint the bound points, to see what follows what.
  Rive's per-point weights (one point with several bones) are left for later. Taking a drawing out of the skeleton of its bone releases the binding and warns.
- Deterministic migration (`npm run migrate`, `src/core/migration.js`): if all the bound drawing is in a root
  group (`cat` in the cats), that group becomes the skeleton and the bones are moved into its frame (also in
  the poses); otherwise, a new skeleton is created with the stretch of the root that has the bound drawing. It leaves a
  "migration" entry in the history that stops undo, because earlier inverses refer to the old frame.
  `gato_rig`, `gato_expresiones` and `test_4` were migrated and look the same in the setup, the poses and the param
  blends (compared pixel by pixel; the only differences are antialiasing, due to the old SVG's rounding).
  Removed on 2026-11-14 with the other migrations (old on-disk format, scenes with params, Spanish localStorage
  keys): while the project is in development, old documents are not kept.

Notes on what was built (before the switch to the bone layer):
- `bone` with `x`, `y`, `rotation`, scale, `length`, `independentAngle` and limits `minAngle`/`maxAngle`. Bones
  **only have bones as children** (`parentTypes`/`childTypes` in the schema): the skeleton is separate from the drawing and
  drawing order stays free.
- **Layer binding** with the `bone` property of any transformable object. An object without `bone` follows its
  parent's bone. As in Moho, binding doesn't move anything: the object follows the bone's *delta* (from where it is in the setup to
  where it is in the pose).
- **Named poses** as a `pose` asset (`bones: { bone: { rotation, x, y, scaleX, scaleY } }`, absolute
  values). It's the bridge to phase 4 actions: a pose is a one-frame action.
- Deleting a bone releases what's bound and removes it from the poses (undo brings it back); renaming it updates everything.
- Editor: Bone tool (B) to create by dragging (child of the selected one; from its tip, chained), rotate,
  move the origin and adjust the tip (Alt, or with Move). `Ctrl+B` and dropping onto Layers bind. A
  «View: Setup / Pose» selector on the bar; in a pose the canvas gets a green frame, dragging a bone (or the bound
  drawing) rotates it in the pose and the inspector shows the pose values above the setup ones.
- Adjustments after trying it by hand: an **options bar** over the canvas explains what can be done depending on the
  tool and the selection, with buttons (with a bone: «Bind Layer» by clicks, show what's bound, child bone,
  try in a pose). Rectangles and ellipses have a movable pivot (`originX`/`originY`, as in Rive).
- MCP: `set_pose` (adds to the pose and returns the image), `render_preview` with `pose`, `region` (crop, which the
  AI asked for in phase 2) and `bones` (the skeleton on top, with names). `get_document` shows where each bone sits in the
  document, so relative angles don't need to be summed.
- **Changes from the plan:** the incremental runtime (dirty flags, pass limit) is left for phase 5, when
  there are frames to recompute; for now the skeleton is evaluated whole on each draw, which is more than enough.

- Bones with `length`, forward kinematics, `independentAngle` and angle limits *(from Moho)*.
- **Layer binding**: an object attached to a bone, without deforming.
- Incremental runtime: dirty flags and topological order, with a pass limit per frame *(from Rive)*.
- Editor: bone tool (create by dragging, rotate, move the pivot), overlay, bind objects to bones
  and pose mode vs. setup mode.
- MCP: `set_pose` to try poses without modifying the setup.

**AI test:** rig the character from phase 2; pose it ("waving", "looking up").

## Phase 4: switch, params, drivers and actions ✅ (2026-11-05)

Notes on what was built:
- **Poses are the actions.** Instead of a new type, the phase 3 `pose` was generalized: `values` sets
  any animatable property of any object (bones, vertices of a mouth, colors, opacity, a
  switch's child). With the same number of vertices as the setup, a shape interpolates (morph). Short animations
  with time are left for phase 5. Documents with `bones` in their poses were migrated to `values`.
- **`switch`**: a group that shows a single child (`active`, a reference limited to its children with `refScope`).
- **`param`** (`number`, `boolean`, `enum`) and **`driver`** (param → pose, range `inMin…inMax` → weight
  `outMin…outMax`, or `equals` for an enum). Active poses are added on top of the setup: numbers by
  differences, colors and vertices interpolated, and discrete values with weight ≥ 0.5. The trigger is left for phase 6.
- Editor: «View» adds «Parameters (blend)» (canvas in orange). The bottom panel has one control per param, the
  drivers with their live weight and «＋ Pose…» to connect. In a pose, the inspector shows at the top everything animatable
  on the object (what's changed goes to the pose) and point editing saves the morph in the pose.
- MCP: `set_pose` with `values` (accepts `d`), `render_preview` with `params` (says which poses ended up active and with
  what weight) and the tree shows params, drivers and switches.
- First audit (`auditor` agent): point binding belongs to the setup (a pose doesn't store `bone` in its vertices
  and, when applying or blending it, each vertex takes the setup's at the same index; old data is ignored on read and
  cleaned on saving the pose); blending starts from the visible value (with the style); undo and redo refuse if
  a later batch from the other origin touched the same properties; `reparent_bone` warns in which poses the bone changes
  place and with `keep_in_poses` compensates them (in the editor, «Keep poses»); bones drawn on top follow a
  pose that moves the skeleton; `meta` is a reserved id; `initial`/`equals` are validated against `options` and
  `min ≤ max`. New tools for the AI: `move` with `keepPosition`, `create_switch_control` (removed later,
  along with the editor's «Create control»: the switch stayed simple, as in Moho, and the variant is chosen with `active`) and
  `delete_document`. The logic of the MCP tools
  lives in `mcp/tools.js`, with tests.
- Pending: **import SVG from the MCP.** The editor's importer (`src/editor/importSvg.js`) mounts the SVG in the
  page so the browser resolves transforms, viewBox, CSS styles and units: it reads each
  shape's matrix with `getScreenCTM` and the colors with `getComputedStyle`. Node has no DOM: we'd need to add a parser (for
  example `linkedom`) and reimplement by hand the style cascade and the composition of transform and viewBox. Meanwhile, the AI can pass each shape as `d` in a `path`.
- Pending: translate the old error messages of the core and the server into English (see `CLAUDE.md`).
- AI test: 8/8 (`docs/pruebas-ia/fase-4.md`). What it asked for later: a warning when two active
  poses show things that overlap, show or hide without intermediate opacity, move a bone in document
  coordinates inside a pose, a params grid in `render_preview`, and masks.


- **Switch** (Moho switch layer ≈ Rive Solo): one visible child, chosen by a text value.
- **Actions**: named poses or short animations *(from Moho)*.
- Typed **params** (number, bool, enum, trigger) as the main interface *(Rive's view model)*.
- Explicit **drivers** `param → action` with input and output range *(Moho's smart bones, without naming
  conventions)*.
- Editor: params panel with sliders, "entering" an action to edit it (the timeline changes color, as in
  Moho) and driver editor.

**AI test:** create expressions (happy, sad, surprise) and the head turn as params; prepare visemes for
lip-sync.

## Phase 5: animation (Design · Animate · Puppet)

Design agreed in [decision-animacion.md](decision-animacion.md): three modes with a single clip engine.

- **Core:** `animation` asset (`usage` animate/puppet, `duration`, `loop` once/loop/pingpong, `description`,
  `tracks` shaped like a pose's `values`). Keyframes `{ t, value, ease }` with the curve per keyframe: `linear`,
  `step`, `ease-in`, `ease-out`, `ease-in-out` and `cubic-bezier` `[x1, y1, x2, y2]`. Params also have a track.
  Evaluation: setup → clip at t → params → drivers add their poses on top. Rename and delete update the tracks.
- **MCP (alongside the core):** `set_keys` (by moments, with `values`, `params` or a whole `pose`),
  `delete_keys`, `render_preview` with `animation` + `time` and a frame strip with `times`, and the tree summarizing each
  clip.
- **Editor:** mode tabs **Design / Animate / Puppet**. Poses, params and drivers leave Design and move to
  Puppet. Timeline with playhead, play/loop, keyframes per property, autokey (in a clip, what's changed goes to a
  keyframe at the playhead time) and curve per keyframe. In Puppet, the clip library as buttons on the
  right; in Animate, a long timeline.
- **Later within the phase:** Puppet clips inserted by reference in Animate, curve editor, dope sheet
  with move/scale times, incremental runtime (dirty flags, noted in phase 3).

Built (2026-11-05):
- Core: `animation`, curves (`src/core/curves.js`), evaluator (`src/core/animation.js`: `clipPose`,
  `putKey`, `removeKey`) and render with `animation` + `time`; frame strip `svgStrip`.
- MCP: `set_keys`, `delete_keys`, `render_preview` with `animation`/`time`/`times`; the tree summarizes each clip.
- Editor (`src/editor/timeline.js`): **Design / Animate / Puppet** tabs. Design no longer shows «View» or the
  timeline, and Assets only has styles and gradients. An open clip is edited like a pose (`state.pose` = clip
  id): rotating bones, the inspector, points and param sliders save keyframes at the playhead (autokey).
  Timeline with ruler, play/pause (respects `loop`), duration, loop, «◆ Key», keyframes that can be selected, dragged
  (snapping to frames), change curve and are deleted with <kbd>Del</kbd>. Puppet: clip library on the
  right (click = edit, ▶ = play), Parameters also on the right and the timeline alone at the bottom, with the
  clip description. Animate: one tab per scene (+ creates, × deletes), like the document tabs.
  Playback goes in the middle of the bar: «, ▶ and » (previous and next keyframe).
- AI test: 8/8 with no rejections ([results](pruebas-ia/fase-5.md)). From what it found: `setup: true` and
  moments with only `ease` in `set_keys`, and `undo`/`redo` per track in clips (like per key in poses).
- Third audit (phase 5): in a loop, `t = duration` is the end; what isn't additive (switch, colors,
  vertices) is decided by the clip's track and not by an active driver ([decision §4](decision-animacion.md)); autokey
  saves the value without the drivers' contribution; a single "same time" tolerance (1 ms). Parity: the AI has
  `move_keys`, warnings about drivers adding on top and the tracks with their keyframes in `get_document`; the editor has
  «◆ Pose…», «◆ Setup», hand-typed `cubic-bezier` and deleting a whole track. Params are Puppet-only: a scene
  doesn't animate them and is shown without drivers (see [decision-animacion.md](decision-animacion.md) §4).
- Second AI test: 9/9 ([results](pruebas-ia/fase-5.md#segunda-ronda-2026-11-06-timeline-escenas-y-clips-de-puppet)).
  From what it asked for: `scale_time` (and «Scale keys» in Length), `pose` with `only`/`except` (and «Only the selection» in
  «◆ Pose…»), values relative to the setup (`"+=14"`), strong named curves (with their shape drawn in the
  timeline), and the list of poses each animated param moves in `set_keys`, `render_preview` and the param's channel.
- Still missing in the phase: Puppet clips inserted in Animate (the AI asked for it in the test), curve editor
  (dragging the handles), selecting and scaling several loose keyframes at once (the editor already moves a whole moment
  by dragging the ◆ of «All keys» or of an object's row, like `move_keys`), a bone not inheriting scale (breathing without enlarging the head), a preview after
  `undo` and the incremental runtime.

**AI test:** animate an idle cycle, a wave and a blink (Puppet clips) and a short scene in
Animate; tweak timing by hand and ask the AI to continue without overwriting it.

## Phase 6: behavior (live Puppet)

Decision in [decision-animacion.md §9](decision-animacion.md): **no state machine for now** (on hold: in an
app with an LLM, the LLM decides the state).

- ✅ Live runtime `src/core/live.js` (the one phase 7 exports): `play(clip)`, `set(param, value)` and
  `stop(clip)`. A looping clip is the **base** (crossfade); a `once` one is a **gesture** on top that overrides only its
  tracks and exits on its own. The app's params blend with the weight of the clip that animates them.
- ✅ Puppet clip data: `fade`, `next` (chaining), `blend` (`additive`) and `auto` (`repeat` every
  `repeat_min`…`repeat_max` s, like blinking; `always`, like breathing). The param gains `description`.
- ✅ Editor: **▶ Live** in Puppet (buttons trigger clips, Parameters are the app's values, the timeline shows
  what's playing with its weight; the document isn't edited) and the inspector's Live group.
- ✅ MCP: `set_keys` with the Live fields, `render_preview` with a `live` script and `get_manifest` (the manifest the
  app's AI receives: `src/core/manifest.js`). Guide up to date.
- On hold: state machine (states, transitions with conditions, 1D blend, exit time), explicit masks.

**AI test:** assistant behavior (idle, listening, thinking, speaking, reaction).

## Images as a layer ✅ (2026-11-12)

- ✅ `image` type (`schema/image.json`): `src` (new `asset` property type: the name of a file in the document's
  `assets/` folder), animatable `width`/`height`, `originX`/`originY` pivot like `rect`, and `pixelated`. It inherits
  position, rotation, scale, opacity, `visible` and `bone`: it goes in groups, switches and skeletons, attaches to bones and is animated
  in poses and clips. To change image, a `switch` with one per variant.
- ✅ Files in `documents/<doc>/assets/` (not embedded: the JSON and the history stay light). PNG, JPG, WebP and SVG
  (whole, without editing its shapes; for editable shapes there's still Import SVG). Size read from the header in
  `src/core/images.js`; the same bytes are reused and a taken name gets `_2`. Undo removes the layer, not the
  file. Copying a document copies its assets. The server serves them at `/api/documents/<id>/assets/<file>`
  (SVGs with CSP) and receives them by POST.
- ✅ A single plan to create the layer (`planAddImage`): centered, at natural size or shrunk to fit.
- ✅ Editor: **Image…** in the layers menu (next to Group, Switch and Skeleton, as in Moho), dropping files on the
  canvas or pasting them with Ctrl+V; in the inspector, thumbnail, **Replace…** and **Original size**.
- ✅ MCP: `add_image` (local path or URL) and `render_preview` with images. resvg doesn't read WebP: in the AI's
  preview a WebP comes out as a gray box with a cross and the text says so. Guide up to date.

## Vector layers as in Moho (started 2026-11-14)

Decided with the user on 2026-11-14 (documents in progress are not kept: we start from zero). Drawing lives in a
`vector` layer with a mesh of points (by id, so the AI names them without indices) and curves; its `shape` children
fill and stroke curves, without a transform of their own. A point used by two curves welds them. Loose
`path`/`rect`/`ellipse` stay for now and leave in step 6.

1. ✅ Core and AI: `vector` and `shape` types (`points` and `curves` property types), render with fill rule (holes),
   `d` on a shape adds its subpaths to the layer (welding on coinciding points; `set` replaces its curves and drops
   the unused ones), poses and keyframes that list only the points or curves they move, per-point bones on the mesh
   (`bind_points` with a layer, delete/rename/duplicate/release), guide and tree for the AI. The abstract `shape` of
   the loose shapes is now `painted`.
2. ✅ Editor basics (2026-11-14): «Vector» in the new-layer menu; Layers shows the vector layer (its shapes are not
   rows); the pen, rectangle and ellipse draw a shape into the active layer, or create one (`layer_N`) with its pivot
   at the shape's center, writing the same `create shape` with `d` as the AI; a click picks the layer, a double click
   the shape (only its outline, its fill and stroke in the inspector); moving the layer's pivot is the `pivot` sugar
   the AI also has (points shift in the setup, poses and clips); deleting a shape takes its unused curves and
   points along. Checked by the new `ai-parity` agent and the auditor.
3. Points tool on the mesh: multi-selection across shapes, transform points, weld, delete, curvature.
   ✅ First part (2026-11-14): a double click picks a shape and the selection tool works on its points, as Moho's
   Transform Points: a box with a margin, drag inside to move, corners to scale (Shift: proportional), top handle to
   rotate (Shift: 15°), a movable pivot (editor state), each point draggable alone, arrows nudge, Esc back to the
   layer. Everything is the `transformPoints` sugar the AI also has. The vector layer and its shape have their own
   icons. Still to do: selecting points across shapes, tangents/curvature, weld, delete a point.
4. Shapes over curves: Create Shape from selected points/curves, holes, order, Auto-fill/Auto-stroke.
5. Bones and timeline: per-point binding from the editor, point channels.
   ✅ Bind Points on vector layers (2026-11-14), as in Moho: it shows only the picked layer's points, they are picked
   (click, Shift, box) and Space or «Bind» binds them to the picked bone.
   ✅ Transform Points in poses and keyframes (2026-11-14): `transformPoints` and `"+="` in the values of `set_pose`
   and `set_keys`, relative to the setup; in the editor, a picked shape's box works in an open pose or clip too
   (only the moved points go into the pose, or a keyframe at the playhead). `bind_points` takes `shape` or `points`
   (and `release`), to bind only some points as the editor's Bind Points does.
   ✅ What a new AI found building a whole character over the MCP (the `character-test` agent, 10/10 tasks, 1
   rejection): poses and keyframes merge points id by id (a second `set_pose` no longer drops the first one's
   points; `remove` takes one point); poses that move the same points add up like numbers; the tree lists each
   shape's points with coordinates and welds, and a bone's stored rotation; guide recipes for poses on the same
   points (blink with pupils), the editor's default scene and an ease on the last keyframe (`set_keys` warns);
   redo names the batch it brings back; the manifest and the live view say more about auto clips.
6. SVG import into vector layers, and removal of loose `path`/`rect`/`ellipse`.

## Phase 7: export and use

- **Priority: `.aia` + JS runtime** (`src/core` + `src/render`, no dependencies) with a manifest for the app's
  AI: params, Puppet clips with their card and states → tools for the LLM. See
  [decision-animacion.md §5](decision-animacion.md). The `.aia` also carries the `assets/` files and the runtime
  receives how to resolve each image's `src` (the `assets` option of `svgContent`).
- **Video** (mp4/webm/gif, PNG per frame) sampling the same evaluator with resvg and ffmpeg.
- **Lottie and SVG/CSS**: simple tracks directly; bones and blends baked frame by frame.
- Demo: an avatar on a page, controlled by an LLM, with lip-sync from the audio.

## Noted ideas

Recording a Puppet performance as Animate tracks (Rec), keyboard shortcuts per button, scenes with several
characters (instances of other documents), procedural behavior (blinking, gaze) as character data, and
elastic/bounce/«two-way» curves. Details in [decision-animacion.md §7](decision-animacion.md).

## Later

Weight-based deformation (at most 4 bones per vertex), two-bone IK, copy-transform constraints with
factor and delay, secondary dynamics, morph between shapes with the same number of vertices, and image meshes (an image that
deforms with several bones) in a canvas layer.

**Vector layer with a shared mesh, as in Moho** (decided on 2026-11-12, for later): started on 2026-11-14, see
«Vector layers as in Moho».
- ✅ MCP parity (2026-11-13 audit): `add_image` with `replace` (shared `planReplaceImage`, as the editor's
  Replace…); `get_document` lists the files in `assets/` with their natural size and which layers use them (to reuse
  them or go back to the original size); a layer that fails does not leave its file in `assets/`.

## Lock in Layers ✅ (2026-11-12)

- ✅ `locked` (in `transformable`): the padlock in Layers. The layer and its children can't be picked or changed
  on the canvas (clicks go through to what is below): drawing, bones, Bind Points points, marquees and the arrow
  keys. It stays editable from Layers and the inspector, is saved in the document and can be undone.
- ✅ The AI sees it: `get_document` marks "(locked by the user)" (and "(hidden)") and the guide tells it not to change
  a locked layer unless asked.

## Electron packaging (2026-11-13)

Decided with the user: stay in JS, local-first (no hosted web app, no remote MCP), and ship a desktop app so people
can use aia-studio without Node, the repo or a terminal. The MCP stays stdio, launched by the AI client, but it runs
the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so it is always the same version as the editor. The app
guides the connection with a button; the user never has to ask the AI chat to set itself up.

- ✅ **Server without `vite dev`**: `server/api.js` (the `/api/documents` routes as a plain Node handler) is mounted
  by the Vite plugin in dev and by `server/app.js` in production, which serves the `vite build` output on
  `127.0.0.1`. Cross-site `Origin` and foreign `Host` headers are refused.
- ✅ **Live notices without Vite's websocket**: our own `fs.watch` on the documents folder (`server/events.js`) and
  Server-Sent Events on `/api/events` (`document`, `history`, `deleted`, `ai`), in dev and in the app alike. The
  editor listens with `EventSource` (`src/editor/serverEvents.js`) instead of `import.meta.hot`.
- ✅ **Configurable documents folder** (`server/folder.js`): `--documents`, `AIA_DOCUMENTS`, or the repo's
  `documents/`. The installed app uses `%APPDATA%\aia-studio\documents` and writes it into the AI client entry.
- ✅ **Electron shell** (`electron/main.js`): starts the server on a stable port (kept in `settings.json`, so
  localStorage survives), opens the window, single instance, external links open outside.
- ✅ **Connect your AI**: welcome on first launch, ☰ → Connect your AI…, header chip. Claude Desktop's config is
  found in its three Windows locations (classic `%APPDATA%\Claude`, MSIX `Packages\Claude_*\LocalCache`, and
  `%LOCALAPPDATA%\Claude-Data\<package>`) and on macOS; connect/disconnect touch only our entry, with a backup; each
  launch repairs an entry that points at an old location. Each MCP server leaves `<documents>/.aia/mcp/<pid>.json`
  with its client while it runs, so the editor shows "Claude Desktop connected". Claude Code command, Cursor and VS
  Code install links; ChatGPT / claude.ai web shown as not available.
- ✅ **Build**: `npm run dist:win` (electron-builder, NSIS per-user installer, unsigned; `@resvg/resvg-js` unpacked
  from the asar).
- Later: macOS build, code signing (SmartScreen / Gatekeeper), auto-update, a "Reveal documents folder" action.
