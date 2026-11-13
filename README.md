<p align="center"><img src="public/logo.svg" alt="aia-studio" width="96" height="96" /></p>

# aia-studio

A 2D vector animation editor and runtime (characters, objects, icons, scenes), built with HTML, CSS, JS and SVG.
It takes ideas from **Moho** (bones, smart bones, switch layers) and from **Rive** (state machines, declarative
runtime), and is designed from the start so that **an AI can manipulate the documents** and **the user can fix
things by hand** when needed.

## Principles

1. **The document is text.** Every document is readable JSON with meaningful names
   (`head`, `mouth`, `happiness`), not an opaque binary.
2. **One API for the AI and the editor.** Every action in the visual editor (moving a
   bone, changing a mouth, creating a keyframe) is an operation of the same API the AI uses.
   What one does, the other can undo or fix.
3. **High-level parameters.** The AI works with semantic controls
   (`happiness: 0.8`, `head_turn: -0.3`) that move many things at once, in the style of Moho's
   smart bones, instead of moving individual vertices.
4. **Build the base little by little.** First the format and the runtime; then the editor
   on top, always on the same base.

## How to use it

```bash
npm install
npm run dev     # editor at http://localhost:5173
npm test        # core tests
npm run mcp     # MCP server over stdio (usually started by the AI client)
```

> Status: **phase 6** of the [plan](docs/plan.md) (live Puppet: ▶ Live, base clips and gestures with fades, automatic
> layers such as blinking and breathing, and the manifest for the app's AI), on top of the animation from
> phase 5 (Design, Animate and Puppet modes, clips with keyframes and timeline), the expressions from phase 4 (poses, params,
> drivers and switch), the bones from phase 3 and the drawing from phase 2. The prototype that tested the idea is kept in the git tag `prototipo-0`.

### Editor

At the top: the **☰** menu (new, open, copy, import SVG, close, delete, shortcuts), the **tabs** of the
open documents (the × closes the tab, the file stays on disk) and the bar with two **tool
groups**: Transform (Move, Rotate, Scale) and Create (Pen, Rectangle, Ellipse). The ▾ arrow of each group
shows the other tools.

| Action | How |
| --- | --- |
| Modes | Top right: **Design** (drawing and rig: the setup), **Animate** (one scene timeline, for export) and **Puppet** (the puppet's controls: poses, params, drivers and short clips that the app or its AI triggers). See [docs/decision-animacion.md](docs/decision-animacion.md). |
| Select and move | Tool `V`; drag on the canvas (Shift = one axis only) or arrow keys (Shift = 10 px). |
| Select several | Ctrl or Shift + click; dragging on an empty spot makes a marquee; in Layers, Ctrl + click adds and Shift + click takes the range. `Ctrl+A` = all, `Ctrl+G` = group. They rotate and scale from the center of the set; the inspector changes what they have in common. |
| Rotate and scale | `T` and `S`: dragging anywhere on the canvas rotates or scales the selection from its pivot. |
| Create shapes | `R` rectangle, `E` ellipse: drag on the canvas (Shift = square or circle). |
| Pen | `P`: click = sharp vertex, click and drag = curved, click on the first = close, Enter or Esc = finish open. |
| Edit points | Double click on a path or Enter: drag anchors and tangents (Alt = break), double click on an anchor = sharp/curved, click on the outline = add, Delete = remove. Enter or Esc to exit. |
| Rotate, scale, pivot | Selection handles: top circle = rotate (Shift = in 15° steps), corners = scale from the pivot (Shift = proportional), pivot point = move it without moving the drawing (groups, paths, rectangles and ellipses). |
| Styles and gradients | The style and gradient buttons in Assets («New shared style», «New linear gradient»); shapes use them with `style` and `fillGradient` in the inspector. What comes from the style shows in orange. |
| Import SVG | ☰ → «Import SVG…»: the shapes arrive as editable paths inside a group. |
| Skeleton (bone layer) | Like Moho's *bone layer*: it contains the drawing and its bones. In Layers, ▾ next to the group button → «Skeleton» (or `K`): puts the selection into a new skeleton. As in Moho, Layers shows only the layers: bones are seen and picked on the canvas. The drawing inside stays still until it is bound. |
| Bones | Five tools in the bones menu, as in Moho. **Add Bone** (`B`): dragging on empty space creates a bone in the selected skeleton or in the selection's skeleton (child of the chosen bone; if there is no skeleton, one is created); from the tip of the chosen bone it chains another; a click on a bone picks it. **Manipulate Bones** (`M`): dragging a bone rotates it, the origin circle moves it and the tip circle changes direction and length. **Reparent Bone**: a click only picks (Shift + click adds; click on empty space releases); pick the children and finally the parent, and the options bar makes the change with «Parent to …» or «Clear parent» (root), without moving them in the setup; if they move in any pose (because the pose moves the old or the new parent), it warns and offers «Keep poses» to compensate them; it draws the hierarchy. Each bone has a color; picking one highlights its parent and children, and the options bar names them so you can jump to them. In a pose, any tool poses. |
| Bind to the skeleton | You only bind to bones of the same skeleton. **Bind Layer** (`L`): click on a bone and then on the drawing (or its row in Layers) so it follows it whole; another click releases it, Alt picks its group. **Bind Points**: click on a bone and then on points of the paths of its skeleton, or a marquee around them; the points take the bone's color (Alt releases). Also: `Ctrl+B` with drawing and bone selected, `bone` in the inspector, and «Bind all by proximity» with the skeleton selected. Binding moves nothing: the drawing follows the bone in the poses. |
| Options bar | Above the canvas: what can be done with the tool and the selection, with buttons for the actions (for example, with a bone: bind, show what is bound, child bone, try in a pose). |
| Bend with several bones | While editing the points of a path: «Distribute among bones» (or each point's bone) in the options bar. In poses, the path bends following the chain. |
| Expressions (Puppet) | A pose can change anything animatable: in the pose, the inspector shows the pose's values at the top and Enter edits the mouth's points (morph). On the right, in Parameters, + creates a control and the + in its row connects it to a pose; each param shows its name and value, the full-width slider and the poses it blends with their weight. Moving the control shows the blend. A switch shows a single child (`active`). |
| Poses (Puppet) | On the right, between Clips and Parameters, the list of poses (still shots that params blend): each one says which param moves it (← happiness); click opens it for editing. Clips, Poses and Parameters have + and 🗑 in the header, like Layers (🗑 deletes what is selected or open; a param goes with its drivers). In a pose, dragging a bone or the bound drawing rotates it without touching the setup. Above the canvas, a banner says what is being edited (pose, clip, the params view or Live), in the frame's color, with its button to exit (Done, Close clip, ■ Stop Live). Above Clips, a small bar with what is done with the whole puppet: Reset (params to their initial value), ▶ Live and AI view. Clips, Parameters, Poses and the Inspector (this one in every mode) collapse with the arrow in the title, and this is remembered. |
| Clips (Puppet) | On the right, the clip library: + creates one, click on a clip opens it in the timeline and ▶ plays it. At the bottom, the open clip is a tab (× closes it, + creates another) and next to it goes its description (for the app's AI). In the clip's inspector, the Live group: `fade`, `next`, `blend` and `auto` (with the `repeat` wait). |
| ▶ Live (Puppet) | The puppet as the app will see it: a looping clip is the base (crossfade), a `once` clip is a gesture on top that leaves by itself, and the `auto` ones (blinking, breathing) play by themselves. The clip buttons trigger them (■ removes one), Parameters are the app's values (not saved), the timeline shows what is playing with its weight and «■ Stop all» removes everything. The document is not edited by hand. «AI view» shows the manifest the app's AI receives, with its problems. See [docs/decision-animacion.md §9](docs/decision-animacion.md). |
| Scenes (Animate) | At the bottom, one tab per scene, like the document tabs: click opens it, + creates another and × deletes it (asks for confirmation; can be undone). A scene is shown without params or drivers (setup + keyframes, as it is exported): an expression is copied with «◆ Pose…» and a variant is chosen by keying the switch. |
| Timeline (Animate and Puppet) | With a clip or scene open, everything you change (rotating a bone, the inspector, the points and, in Puppet, the Parameters sliders) becomes a keyframe at the playhead (autokey; in Puppet, what the drivers add is not stored twice). The timeline shows «All keys» (all the clip's keyframes) and a collapsible group for each selected thing (Ctrl + click in Layers or on the canvas bones adds more; ▸/▾ opens or closes; only the main one starts open): the group's row summarizes its keyframes and, when open, shows its channels as in Moho, empty ones too: ◇ keys a channel at the playhead; Position (x, y) and Scale go in one row. Click or drag on the ruler moves the playhead; in the middle, « and » jump to the previous or next keyframe and ▶ plays according to `loop`. «◆ Key» keys everything selected, «◆ Pose…» a whole pose (or, with «Only the selection», only what is selected) and «◆ Setup» goes back to the setup. With «Scale keys», changing Length stretches or compresses all keyframes proportionally. A ◆ is picked with a click, dragged in time (snapping to frames; it is not dropped on top of another), changes curve (`linear`, `ease-*` with the strong `-quad`, `-cubic`, `-expo` and `-back`, `step` or `cubic-bezier…`; the ◆'s color shows it and its shape is drawn next to it) and is deleted with Delete; × on a channel deletes it whole. Dragging a gray ◆ in «All keys» (or in an object's row) moves that whole moment: all its keyframes in the clip (or the object). ⚠ warns if a driver adds on top of a track, and in Puppet a param's channel says which poses it moves (→ happy, …). |
| Switch | In Layers, ▾ next to the group button → «Switch» (or `Shift+G`): puts the selection into a switch (each object is a variant and one is shown at a time; hidden ones appear in italics). The variant button in its Layers row (or the options bar) picks which one shows, in the setup or, in a pose, inside the pose. When a hidden variant is selected, the canvas shows it while it is selected so it can be edited. For a param to pick it, you build it by hand: a param (list), one pose per variant that sets which one shows, and one driver per option. |
| Groups | `G` creates a group; drag rows in Layers to reorder (when the parent changes, the object stays in the same place) or to put inside a group; ▾/▸ collapses. |
| Duplicate | `Ctrl+D` duplicates the selection with its children; ☰ → «Make a copy…» copies the document. |
| Tabs | `+` creates a new document, × or `Alt+W` closes the tab, ☰ → «Open…» opens another. What the AI creates opens in a new tab. |
| Rename | Double click in Layers or the inspector's id field. |
| Adjust values | Type in the inspector or drag over the property name (Shift = fine, Alt = coarse). `↺` goes back to the default value. |
| View | Wheel = scroll, Ctrl + wheel = zoom, Space + drag or middle button = pan, `F` = fit, `1` = 100%; the zoom button has more options. |
| Undo | `Ctrl+Z` / `Ctrl+Shift+Z`. It only undoes your changes; the AI's changes are undone by the AI. If the AI later changed the same thing, it does not undo and the warning says which properties and in which batch (and vice versa). |

### Connect your AI (MCP, no API key)

The AI you already use handles the documents through a local MCP server (`mcp/server.js`). It works on the
same files as the editor, so what the AI does shows up live in the browser and what you touch up by hand
stays in the history for the AI to respect.

- **Claude Code**: already configured in [.mcp.json](.mcp.json); when you open the folder it asks you to approve it.
- **Claude Desktop**: add this in *Settings → Developer → Edit Config* (`claude_desktop_config.json`) and restart:

  ```json
  {
    "mcpServers": {
      "aia-studio": {
        "command": "node",
        "args": ["C:\\Users\\olafp\\Desktop\\aia-studio\\mcp\\server.js"]
      }
    }
  }
  ```

- **Other MCP clients** (Cursor, etc.): the same command, `node <path>/mcp/server.js`, over stdio.

Tools: `get_guide` (the format guide, generated from the schema), `list_documents`, `get_document` (with
`json: false` and `clips` to read a large document in parts),
`create_document`, `delete_document` (deletes a document with its history; asks to repeat the id in `confirm`),
`apply_ops`, `undo`, `redo`, `get_history`, `set_pose` (creates or adjusts a named pose; `remove` takes out individual
properties), `bind_points` (distributes a path's points among the bones of its skeleton), `reparent_bone` (changes a
bone's parent without moving it in the setup; with `keep_in_poses`, not in the poses either), `bind_by_proximity` (binds
to the nearest bone all the drawing of a skeleton that does not follow any bone yet) and
`set_keys` (creates or adjusts a clip by moments; in Puppet, also `fade`, `next`, `blend` and `auto` for Live: `values` (also relative to the setup, `"+=14"`), `pose` (whole or a part, with `only`/`except`), `params` (only in Puppet clips), `setup` to go back to the setup, `ease` with strong named curves),
`delete_keys` (removes keyframes by time or track), `move_keys` (moves the keyframes from one moment to another), `scale_time` (stretches or compresses the time of the clip or of a range, in one undo step) and
`render_preview` (returns a PNG so the AI can see what it did; with `pose`, `params`, `region` or `bones`, and with
`animation` + `time` a frame of a clip, or `times` a strip of frames; with `live`, a `play`/`stop`/`set` script as
the app would run it, with `until` and `auto: false`) and `get_manifest` (what the app's AI will see: params, clips, what
each one overrides and the problems).

## Structure

| Folder | Contents |
| --- | --- |
| `schema/` | Definition of each type (single source of truth: validation, inspector and guide for the AI). |
| `src/core/` | Document, validation, operations and evaluation. No DOM; runs in the browser and in Node. |
| `src/render/` | SVG renderer. |
| `src/editor/` | The web editor. |
| `server/` | Reading and writing to disk, and the local API the editor uses (Vite plugin). |
| `mcp/` | MCP server for the AI. |
| `scripts/` | `migrate-skeletons.js` (`npm run migrate`): brings old documents, with bones at the root, to the skeleton model. |
| `documents/` | The documents (`documents/<id>/document.json` and `history.jsonl`). |
| `tests/` | Core tests (`node --test`). |
| `docs/pruebas-ia/` | Tasks and results of the AI tests for each phase. |
| `referencias/` | Third-party code to study (ignored by git). |

## Documentation

- [docs/investigacion/moho-lua.md](docs/investigacion/moho-lua.md): how Moho is built
  under the hood, from its Lua API and its file format.
- [docs/investigacion/rive-runtime.md](docs/investigacion/rive-runtime.md): how
  Rive is built, from its open-source runtime.
- [docs/sintesis.md](docs/sintesis.md): what we take from each one and the base decisions
  for aia-studio.
- [docs/plan.md](docs/plan.md): phase-by-phase build plan, with tests in the editor and with AI.
- [docs/decision-animacion.md](docs/decision-animacion.md): the Design, Animate and Puppet modes, the clip model
  and the export targets (phases 5 to 7).
