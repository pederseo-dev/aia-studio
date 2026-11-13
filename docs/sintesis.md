# Synthesis: what we take from Moho and from Rive

> Status: **initial proposal** (2026-10-29). Decisions marked as *proposal* must be
> confirmed before writing code. Details and sources are in
> [investigacion/moho-lua.md](investigacion/moho-lua.md) and
> [investigacion/rive-runtime.md](investigacion/rive-runtime.md).

## 1. What we learned in one sentence

- **Moho** is a good model **for the animator**: bones with simple binding, smart bones
  (a control that plays an action), switch layers and typed channels in which each
  keyframe carries its own interpolation. It has two weak points: integer IDs depend
  on order, and part of the meaning depends on names.
- **Rive** is a good model **for the runtime**: types defined in declarative *defs* that
  serve as a single source of truth, incremental update with dirty flags and dependency
  order, a layered state machine, and data binding with typed view models. It is binary
  and uses numeric keys, so it is opaque to an AI.

Neither was designed for an LLM to edit. That is our gap.

## 2. Base decisions (proposal)

### 2.1 A declarative schema as single source of truth *(from Rive)*

Each type (`bone`, `shape`, `slot`, `param`...) is described only once in a schema
file, with its properties, types, initial value, whether it is animatable and a description. From that
schema come:

- the JSON validation,
- the documentation given to the AI (what it can touch and with what ranges),
- the editor's property panels,
- the runtime's get/set.

So a type is added once and shows up in all four places.

### 2.2 The document is readable JSON with stable text IDs *(the opposite of both)*

- Text IDs that do not change (`"head"`, `"mouth_smile"`), never indices.
- Hierarchy with `parent: "<id>"` in a flat list. It is easy to edit with patches and does not
  depend on position.
- Property paths are readable: `bones.head.rotation`.
- Editor state (selection, view, panels) goes **outside** the document.

### 2.3 Separate `rig` and `animation` *(from Moho: frame 0 = setup pose)*

```jsonc
{
  "format": "aia/0.1",
  "rig": {
    "bones":  [{ "id": "neck", "parent": null, "x": 0, "y": -40, "rotation": 0, "length": 30 }],
    "parts":  [{ "id": "head", "bone": "neck", "svg": "<path d='...'/>" }],
    "slots":  [{ "id": "mouth", "bone": "neck", "options": ["closed", "open", "smile", "O"], "active": "closed" }],
    "params": [{ "id": "happiness", "range": [0, 1], "default": 0 }]
  },
  "drivers":  [{ "param": "happiness", "in": [0, 1], "action": "smile", "out": [0, 1] }],
  "actions":  [{ "id": "smile", "tracks": [] }],
  "animations": [{ "id": "idle", "loop": "loop", "tracks": [] }],
  "stateMachine": { "layers": [] }
}
```

### 2.4 Explicit parameters and drivers instead of magic smart bones *(Moho + Rive)*

In Moho, a smart bone is recognized because its action has the same name. We
make it explicit: a **param** (`happiness`, `head_turn`, `mouth_open`) has a range, and
the **drivers** say which action it plays and over which range. Params are the AI's main
interface, like Rive's view models. They replace the state machine inputs,
which Rive has already marked as deprecated.

### 2.5 Typed channels with per-keyframe interpolation *(from Moho)*

Channel types: `number`, `vec2`, `color`, `bool` and `string` (the last one for slots).
Each keyframe carries its `interp`. We start with `linear`, `step`, `ease-in-out` and `bezier`, and
leave `elastic` and `bounce` for later.

### 2.6 Switch / slot *(Moho switch layer ≈ Rive Solo)*

A group with a single visible child, chosen by a `string` channel. Used for mouths,
visemes, hands and eyes. We copy it as is.

### 2.7 Binding: start simple

- **v1**: *layer binding*. Each SVG part is attached to a bone with `<g transform>` and does not
  deform. It is a cutout style, works perfectly in SVG and goes a very long way.
- **v2**: per-vertex weights (at most 4 bones, like Rive's skin). The `d` attribute is
  recomputed in JS.
- **Later**: image meshes in a canvas layer.

### 2.8 Runtime: the model rules and the SVG is a projection *(from Rive)*

- Setters only mark as dirty; one `update()` per frame recomputes in dependency
  order.
- The SVG DOM is touched only where something changed.
- An **abstract Renderer** (SVG first) leaves the door open to canvas or WebGL if
  performance requires it.

### 2.9 A single operations API for the AI and the editor *(from MohoMCP, but native)*

Every modification is a serializable **operation**:

```js
{ "op": "set",    "path": "rig.params.happiness.default", "value": 0.8 }
{ "op": "add",    "type": "bone", "data": { "id": "arm_l", "parent": "torso" } }
{ "op": "key",    "anim": "wave", "path": "bones.arm_l.rotation", "t": 0.5, "value": 40 }
```

- The visual editor emits the same operations as the AI.
- Operations are applied **in atomic batches**, with undo/redo and validation against the
  schema before being applied.
- Each batch stores who made it (`ai` or `user`). That way the AI sees what the user fixed and does not
  overwrite it.

## 3. What we avoid

| Problem in Moho / Rive | What we do |
| --- | --- |
| Integer IDs that depend on position | Stable text IDs |
| Meaning hidden in naming conventions | Explicit relations (`drivers`, `bone`) |
| UI state mixed with the data | Clean document, editor state kept apart |
| Binary format or no published schema | JSON with a versioned schema (`format: "aia/0.1"`) |
| Scripts with side effects on every redraw | Only declarative operations in v1 |
| Unvalidated dependency cycles | Cycle detection when applying operations |

## 4. Suggested build order

1. **Schema + validator**: the `bone`, `part`, `slot`, `param` and `driver` types.
2. **Minimal SVG runtime**: load a document, resolve bones and draw the parts.
3. **Operations engine**: `set`, `add`, `remove` and `key`, with batches, undo and origin.
4. **Test character**: about 10 bones, 4 params and mouth and eye slots.
5. **Animation + minimal state machine**: `idle`, `talking` and `reacting`.
6. **Editor**: tree, property panel generated from the schema and direct manipulation on the
   canvas.
7. **AI bridge**: the schema is exported as a tool description for the LLM.

## 5. Confirmed decisions (2026-11-02)

- **We start by building and adjust by trial and error**, in phases ([plan.md](plan.md)). A first prototype
  tested the idea and was kept in the git tag `prototipo-0`; the base is rebuilt clean.
- **Conventions**: coordinates as in SVG (Y down), angles in degrees with positive clockwise, and
  time in **seconds** (fps only serve to show frames and for snapping).
- **MCP from the start.** The user's AI (the one they already pay for: Claude Desktop, Claude Code, Cursor...) handles the
  characters through a local MCP server, without API keys. MCP and editor write the same files using the same operations
  engine, and each batch stays in the history with its origin.
- **Static web editor with Vite** as the development server, plain JS with no framework. Vite provides the local API to
  save and the live notice when a character changes on disk.
- **Fine manual controls for everything**: whatever the AI can touch, the user can also touch up in the editor.
- **The character defines how it moves; the app decides when.** Params, drivers and (later) the state machine are
  character data. Behaviors such as automatic blinking or lip-sync are code of the app that uses the
  character.
- **What the prototype left us**: additive numeric drivers with piecewise interpolation and slot drivers with
  thresholds worked well for a simple face. They are a special case of `param → action` (section 2.4), which is what
  is built in phase 4.

## 6. Export format (to be defined)

The editing document (`documents/<id>/document.json`) is designed for creating and editing. To **use** the character in an
AI app, a separate format is better. Initial proposal, to be validated with the first real case:

- **A single self-contained file** (`*.aia.json`) with the setup, the drivers and the animations, without history or
  editor data, and optionally minified.
- **A manifest for the AI at runtime**: the params with their description and range, named expressions
  (`feliz`, `pensando` = combinations of params) and states. From it, the runtime generates the tool
  description for the app's LLM (for example, `set_expression`, `look_at`), without the app having to write it.
- **The lightweight runtime** (`src/runtime/` + `src/core/`) as a JS package with no dependencies.
- Pending: how audio comes in (lip-sync by volume or by visemes) and whether to also export to Lottie or video.

## 7. Open questions

- Weight deformation (v2) in the short term, or is the cutout style enough at first?
- Characters generated by the AI from pieces of a library, or drawn by the user
  and animated by the AI?
- Do we need to import existing `.moho` or `.riv` files? Not for now; it is expensive and not the base.
- A real `.moho` must be unzipped to verify the keyframe schema, which is not
  publicly documented.
