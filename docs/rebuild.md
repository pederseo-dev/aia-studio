# Rebuild

> Status: **in progress** (started 2026-11-16). The decisions below are agreed with the user and built on the
> `rebuild` branch; the open topics are listed below. `main` keeps the v1 app until `rebuild` replaces it.

## Why

The current code works (173 tests, AI tests of 8/8 to 10/10 per phase), but it grew by accretion: the drawing model
changed three times (loose shapes → skeleton model → vector layers with a mesh and `loops`), many rules came from
audit patches instead of a design, and the AI surface reached 20 MCP tools and a 46 KB guide. Now that the idea is
more mature, we rebuild it from scratch inside this repo, in parts, to replace the current code at the end.

## Diagnosis

**Keep (it proved right):**
- One operations engine for the AI and the editor: atomic batches, origin (`ai` / `user`), undo by origin.
- The schema as the single source of truth (validation, inspector, guide).
- Stable text ids and a flat list with `parent`.
- Rendered previews (frame strips) so the AI checks its own work.
- One evaluator (setup → clip → params → drivers) and a live runtime without the DOM.
- The method: short phases, each closed with tests, an AI test and an audit.

**Grew by accretion (to rethink):**
- Three drawing models living together (`painted` loose shapes, `vector` + `shape` with a mesh, `loops`/regions).
- Behavior hidden inside `set` as sugars (`d`, `pivot`, `transformPoints`, `at`, `"+="`).
- 20 MCP tools that overlap (`set_pose`, `set_keys`, `delete_keys`, `move_keys`, `scale_time` edit two almost
  identical assets; `bind_points`, `bind_by_proximity`, `reparent_bone` live outside the operations).
- Pose and clip are nearly the same thing (a pose is a one-frame clip) with different tools and rules.
- Rules born from audit fixes (params only in Puppet, scenes without drivers, per-track undo, what the clip track
  decides) that are hard to explain together.
- The export (phase 7), the point of the product, was never built, so the model was never tested against «can a
  small runtime play this?».
- Large editor files with a global state.

## Decisions

### 1. AI surface: one command language, a CLI and a thin MCP (2026-11-16)

- **One command language, `aia`**, defined once in the core (for example `aia ops`, `aia render`, `aia keys`,
  `aia undo`, `aia guide <topic>`, `aia open`). Discoverable step by step (`aia help`, `aia help keys`) instead of a
  long list of tools and a whole guide loaded up front.
- **CLI first:** agents with a terminal (Claude Code, Cursor, Codex) run `aia …` directly. It works on the documents
  folder, so the app does not need to be open; the editor updates live when it is.
- **Thin MCP** for clients without a terminal (the Claude Desktop chat): a few tools generated from the same
  commands, about `aia(command)` (runs any command through the same interpreter, in process, no shell: only `aia`
  commands exist) and `render` (returns the image). `open` opens the editor from either side.
- **Transport independent:** the interpreter does not know whether it is called by the CLI, MCP over stdio or MCP over
  HTTP.
- **Later, optional:** an MCP over HTTP behind a tunnel with a token, so web chats (claude.ai, ChatGPT connectors)
  can reach a local aia. It reopens the 2026-11-13 decision «local-first, no remote MCP», so it is not built first.
- **Idea:** a console panel in the editor that shows each command the AI runs with its result, where the person can
  type the same commands.

| Client | How it uses aia |
| --- | --- |
| Claude Code / Cursor / Codex | The CLI (`aia …`) |
| Claude Desktop (chat) | Thin MCP: `aia(command)` + `render` |
| ChatGPT / claude.ai web | Not reachable (would need the optional tunnel) |

### 2. Build in parts, starting with a clean base (2026-11-16)

The first part is the base, as clean as possible: the Electron app shell, the documents folder, license, README and
project setup. The rest of the parts come after the open topics are decided.

### 3. Where the new code lives (2026-11-16)

- A **new branch `rebuild` that starts empty** (an orphan branch, without the old code). `main` keeps the current app
  working meanwhile.
- The historical records come along as they are (`docs/auditorias.md`, `docs/pruebas-ia/`, `docs/investigacion/`,
  and the old design docs as references), all under `docs/v1/`.
- **At the end** `rebuild` replaces `main`, and the old code stays reachable in a tag (for example `v1-final`).
- The old code is brought over piece by piece from `main` (`git show main:<file>`) when a part needs it: kept when it
  proved right, rewritten clean otherwise, never copied wholesale.
- This file, on the `rebuild` branch, is the official record of the rebuild: decisions and the plan are written here.

### 4. Vertical slices (2026-11-16)

After the base, the first part is a **thin slice that works end to end** (document, operations, render, runtime, the
`aia` CLI and the MCP, with simple shapes only). Each later part adds **one whole capability**: its model, its `aia`
commands, its guide topic, its editor tools, tests, an AI test and an audit. No part leaves a layer for later.

### 5. The runtime early, as the contract (2026-11-16)

A minimal runtime (plays a document without the DOM) exists from the first slice, and every later part must play in
it. The export was the last phase of v1 and was never built, so the model was never checked against it; here it is
checked from the start.

### 6. Drawing: named parts, as in Moho but readable (2026-11-16, being tried out)

v1 kept drifting toward Moho's mesh and it kept getting harder for the AI: anonymous points (`p1`…`p47`), curves
through them, shapes that paint curves and `loops` for regions, so every change meant rebuilding the topology in its
head. SVG was never the limit; the unnamed indirection was. What the user wants from Moho is the way of working:
many shapes, fills and strokes inside one layer, and painting between lines.

- A **vector layer** holds **parts** (each an outline of vertices with its fill and stroke; see decision 8),
  **named points** (`chin`, `mouth_corner_l`) and **point groups** (`upper_lid`), like Moho's point groups.
- **Welding is explicit:** a vertex can reference a point of another part (`jaw.chin`), and a stretch of an outline
  can follow another part's curve between two points (what v1's `loops` did, inside a named part).
- Moho's **paint bucket is a tool** (and an `aia` command) that creates a part whose outline follows the lines
  around a region; not a type of its own.
- Each part draws as one SVG path, so the runtime resolves references and draws.

It is being tried out in the editor first (see «Trying Design mode» below) before parts are built.

### 7. Try Design mode in the editor first (2026-11-16)

The user tries the model by hand in Design mode, one piece at a time, with a **Document JSON** panel that shows the
document exactly as it is saved and marks what each step changed. The editor works on the real operations and store
from the start, so what is tried is what the AI will use.

### 8. Every shape is a path, as in Moho (2026-11-16)

After trying `rect` and `ellipse` as parametric parts, the user chose Moho's way: there is one kind of part, the
`path` (vertices with optional curve handles). Rectangle and Ellipse are tools that draw a path, not types.

- **Gained:** one kind of shape, so named points, point groups, welding, binding to bones and animating vertices work
  the same everywhere, with no «convert it first». Every shape can be edited point by point. The runtime and the
  export only draw paths. Every transform is exact (no `rotation` property, no approximations when scaling a turned
  rect).
- **Lost:** the parameters (`width: 200`, `cornerRadius: 8`); an ellipse is 4 vertices with handles in the JSON.
- **How the AI keeps the convenience:** high-level `aia` commands that build and transform paths with the same
  geometry as the editor (`src/core/geometry.js`), for example a command that draws a rect or an ellipse into a
  layer and commands that move, scale and rotate a part by name. The AI works with names and numbers; the core
  computes the vertices.

### 9. The `aia` command language, first cut (2026-11-16)

Topic 3, started small so an AI can try the model of Design mode now (after step 8) instead of after more drawing
features. Only what is needed to work on documents with the plain operations; high-level commands (draw a rect,
transform a part by name, weld by name) come after the first AI test shows what the AI misses.

| Command | What it does |
| --- | --- |
| `aia list` · `aia new <name>` · `aia delete <doc> --yes` | The documents of the folder |
| `aia show <doc> [id]` | The JSON as it is saved: the whole document or one object |
| `aia ops <doc> [--note "…"] <batch>` (or `--file <path>`) | Applies a batch with the editor's engine, origin `ai`; errors carry the engine's message |
| `aia move <doc> <point>... --by dx,dy \| --to x,y` | Moves points by name: `head.chin`, `head.3` (by index) or a point group `face.upper_lid`; what shares them follows (added after the first AI test) |
| `aia transform <doc> <id>... --move dx,dy --rotate deg --scale s [--around x,y]` · `--apply` | A layer's own transform, or parts' vertices (several together); Apply transform |
| `aia rect` · `aia ellipse <doc> <layer> <id> --box x,y,w,h` (`--points n`, `--names …`, style) | Shapes by name, as the Rectangle and Ellipse tools (step 13); style is `--fill`, `--stroke`, `--stroke-width`, `--fill-opacity`, `--stroke-opacity` |
| `aia delete-point` · `aia curve` · `aia corner <doc> <point>...` · `aia copy <doc> <part>...` | Point editing and copies (step 13); `delete-point` deletes a part left with fewer than 2 points, as Del in the editor (step 16) |
| `aia weld <doc> <point> <target>` (`--join`, `--on <part>`) · `aia unweld <doc> <point>...` | Welding by name, as in point editing |
| `aia name <doc> <point> <name>` · `aia add-point <doc> <part> --at x,y` | Name a point; add one on a line without changing its shape |
| `aia follow <doc> <point> <point>` (`--long`, `--off`) · `aia group <doc> <layer>.<group> <point>...` | Followed stretches; point groups |
| `aia undo <doc>` · `aia redo <doc>` | Only the AI's own steps (undo per origin) |
| `aia history <doc>` | The steps, the user's marked, so the AI does not overwrite them |
| `aia image <doc> <file>` (`--id`, `--in`, `--at`, `--width`, `--opacity`, `--replace <layer>`) | An image layer from a picture file, copied into the document's assets (step 14) |
| `aia render <doc> [--out file.png] [--width N]` | A PNG drawn by the same `drawDocument` |
| `aia export <doc> --format svg\|html [--out file]` | A still SVG, or one web page that plays the document with the runtime (step 12) |
| `aia help [command]` · `aia guide [topic]` | Help step by step; the type topics come from the schema |

- The document is always an explicit argument: there is no hidden «current document».
- The interpreter (`server/aia.js`) is transport independent: the CLI (`bin/aia.js`) passes it its arguments, the
  thin MCP (`mcp/server.js`) has two tools, `aia(command)` (the same commands as one string, in process, no shell)
  and `render` (returns the image).
- The editor follows changes on disk live (the server watches the documents folder and tells the editor over
  Server-Sent Events), so what the AI does shows up while it works.

First AI test (2026-11-16, [docs/ai-tests/2026-11-16-design-cli.md](ai-tests/2026-11-16-design-cli.md)): with only
the CLI, an AI drew a face with ears welded to the head, a mouth sharing the points of another part and a point
group, in about 23 commands with one refused. What cost it most: there is no way to move one point (the whole
`vertices` array goes again), circles with more than 4 vertices by hand, and not seeing where a shared vertex
sits. These are the candidates for the first high-level commands.
The first one built: `aia move` (points by name, index or group, by an offset or to a place, in one step;
`pointsNamed` and `movePointsOps` in `src/core/points.js`, so the editor can use them too).

**Editor ↔ AI parity (2026-11-16):** everything point editing does with names and welds is now in the core
(`src/core/weld.js`: `weld`, `unweld`, `namePoint`, `groupOps`, `followOps`, `shareTargets`), used by the editor and by
the commands above, so a weld is the same whoever makes it. The store settles every batch for every origin
(`settleOps`): giving a shared vertex a place moves the point it shares, and deleting a shared point (or its part)
leaves the vertices that shared it where they were. Before, the editor did this and the AI's same batch was refused.
`aia show --resolved` gives shared vertices their x, y. (Turning points into corners or curves got its commands in
step 13: `aia curve`, `aia corner`.)

**Trying Design mode, step 11 (2026-11-16): the layer transform**, as Moho's Transform Layer (agreed with the user).
A layer, vector or group, has `x`, `y`, `rotation`, `scaleX`, `scaleY` that move, turn and scale everything in it
around its origin without changing any vertex; a group's transform applies to the layers in it. They draw as a
`<g transform>` (`src/core/transform.js`: the layer matrix, `worldOf`, and turning a matrix back into the five
values). The origin stays where it is: the first time a layer is transformed, its origin (null = the center of its
content) is fixed there, and moving the origin of a transformed layer makes up with its `x`, `y`, so nothing jumps.
Parts are still only geometry: transforming them rewrites their vertices, in their layer's coordinates.
- **Editor:** with a layer selected, Move, Scale and Rotate (and the arrow keys) change its transform; its frame turns
  with it and its handles scale along its own axes. Dragging on its content moves the layer; a click picks the part.
  Point editing, the Pen, Rectangle and Ellipse work inside a moved, turned or scaled layer (the pointer is turned into
  the layer's coordinates; points and handles keep their size on the screen).
- **Apply transform** (in the Inspector of a vector layer, and `aia transform <doc> <layer> --apply`) puts the layer's
  transform into its parts' vertices and leaves it without one.
- **AI:** `aia transform <doc> <id> --move dx,dy --rotate deg --scale s` changes a layer's transform or rewrites a
  part's vertices, around its origin (the high-level transform by name that decision 8 promised).

**Step 12 (2026-11-16): the runtime as the contract (decision 5)**, before the final format is decided (topics 1 and
6 stay open). `src/runtime/player.js` plays a document in any web page with no dependencies:
`createPlayer(svgElement, doc)` and `player.update(doc)`; it draws with the same `drawDocument` as the editor and the
AI's previews (shared points, followed stretches, layer transforms), and will later play clips and take parameters.
`aia export <doc> --format html` writes one page with the document and the runtime inside, which plays from a double
click (`server/bundle.js` turns the runtime's modules into one classic script, each module in its own scope);
`--format svg` writes the still drawing. A contract test (`tests/runtime.test.js`) plays a document with each feature
so far, as the module and as the bundled script, and checks that nothing breaks and both draw the same; every new
feature adds its fixture there.

**First audit (2026-11-17)**, of steps 1 to 12: [docs/audits/2026-11-17-design-mode.md](audits/2026-11-17-design-mode.md).
What the store does to every batch is now one place, `settleBatch` (`src/core/settle.js`): the point rules mend only
what the batch itself took away and refuse typos; a transformed layer always has an origin, and moving it makes up
with x, y. An undo that would take away or overwrite the other side's later work is refused with the reason, and can
be skipped (`aia undo --skip`, or undoing again in the editor).

**Step 13 (2026-11-17): the parity gaps the audit found.** The AI now does by name what the editor does by hand:
`aia rect` and `aia ellipse` (into a vector layer, made if missing; an ellipse can have more points, evenly round, and
names for them: `ellipsePoints` in `src/core/geometry.js`), `aia delete-point`, `aia curve` and `aia corner` (the same
`shapePoint` as point editing, now in the core), `aia copy` (the same `copyOps` as the editor, now `src/core/copy.js`),
`aia transform` with several parts of one layer around one point, and `aia render --labels`, which marks the named
and shared points where they are on the artboard.

**Step 14 (2026-11-17): image layers**, to try the drawing tools over a reference (asked by the user). As in v1 and
Moho, an `image` layer sits in Layers next to vector and group layers (at the root or in a group; it holds no parts):
`{ "type": "image", "src": "face_ref.png", "width": 600, "height": 400, "opacity": 0.5 }`. The picture (PNG, JPEG,
WebP or SVG) is a file in the document's own `assets/` folder (`<documents>/<id>/assets/`), named after the original
file; the same bytes are saved once, and an asset is never deleted while the document lives, so undo can always bring
a layer back. The picture draws from (0, 0) to (width, height) in the layer's coordinates, so it is placed, turned and
scaled with the layer transform of step 11, like any layer; `opacity` (0–1) is its own, to draw over it.
- **Core:** `src/core/images.js` reads a picture's format and size from its header, names assets and builds the
  operations (`addImageOps`: fitted to 90 % of the artboard and centered, or on a given point; `replaceImageOps`).
  `drawDocument(doc, { assetUrl })` draws it as an `<image>`; where the file is found depends on who draws: the editor
  asks the server (`GET /api/documents/<id>/assets/<name>`), `aia render` and `aia export` put it inside as a data
  URL, and the runtime takes `createPlayer(svg, doc, { assets })` (the exported page carries them) or `assets/<name>`
  next to the page.
- **Editor:** Image… in the Layers menu (the system's file picker) or dropping picture files on the canvas; a click on
  the picture picks the layer and drags it, and the Transform tools turn and scale it. Lock it so clicks pass through
  while drawing over it.
- **AI:** `aia image <doc> <file>` copies the file and adds the layer (`--opacity 0.5` for a reference); `aia guide
  image` comes from the schema.
Not yet: layer opacity for other layers, pasting a picture from the clipboard, deleting assets no layer uses.

## Open topics

1. **Purpose and priority:** the live character in apps as the design driver (the runtime as the contract), with
   Animate scenes for video as a secondary use? Or both at the same level?
2. **Document model:** drawing (mesh or not, regions), bones and binding, pose vs clip (one asset?), params and
   drivers.
3. **The command language itself:** which commands, their syntax, what replaces the sugars inside `set`. A first cut
   is decision 9; the high-level commands are still open.
4. **Guide and craft recipes:** guide split by topic (`aia guide <topic>`), and the craft recipes (drawing from a
   reference, rig order, 3/4 view, clip recipes, walk cycle without sliding, how to review, AIs without vision).
5. **Editor structure.**
6. **Runtime and export as a contract** (`.aia` + JS runtime, video, Lottie).

## Build plan

Agreed on 2026-11-16 (decisions 4 and 5). Each part is closed with `npm test` + `npm run typecheck`, an AI test
(an AI with only the CLI or the MCP does the part's tasks; results in `docs/ai-tests/`) and an audit. A part does
not start while the open topics it depends on are undecided. «From v1» names the files on `main` the part draws on:
*keep* = brought nearly as is, *rewrite* = the idea kept, the code written clean.

| Part | What | From v1 | Depends on |
| --- | --- | --- | --- |
| 1 ✅ | **Base** | `electron/main.js`, `server/folder.js`, `server/app.js` (rewrite) | — |
| 2 ✅ | **Thin slice, end to end**, with simple shapes (rect, ellipse, path, group, styles): document, schema, operations, store with history and undo by origin, live notices, SVG/PNG render, a minimal runtime, the `aia` CLI with `help` and `guide <topic>`, the thin MCP (`aia(command)` + `render`) | keep: `geometry`, `curves`, `paths`, `render/svg`, `server/png`, `server/events`; rewrite: `document`, `schema`, `operations` (no sugars inside `set`), `server/store`, `guide` | topics 2 (the basics) and 3 |
| 3 (mostly) | **Editor base**: canvas, Layers, an inspector generated from the schema, selection and transform, a console with the `aia` commands (built in the Design mode steps; the console is still missing) | rewrite: `editor/state`, `canvas`, `layers`, `inspector`, `transform` (small files, no global state) | topic 5 |
| 4 | **Drawing**: one drawing model (paths with named, shared and followed points: decisions 6 and 8, no mesh), the Fill tool for regions, Fill / Stroke | the idea of v1's `regions` (painting between lines); written new on `core/points`, `core/weld`; editor drawing tools | topic 2 (its drawing part) |
| 5 | **Skeleton and binding** | rewrite: `core/skeleton`, `bindPoints`; `editor/bones` | topic 2 |
| 6 | **Animation**: poses and clips, params and drivers, the timeline | rewrite: `core/animation`, `blend`, `poseValues`; `editor/timeline`, `poses`, `parameters` | topic 2 |
| 7 | **Runtime and export**: `.aia` + the JS runtime for apps, the manifest, video and Lottie | rewrite: `core/live`, `manifest` | topics 1 and 6 |
| 8 | **Connect your AI and release**: Claude Desktop setup, installer, signing | keep: `server/aiClients`, `mcpStatus`, `aiRoutes`; `editor/connectAi` | — |
| End | `rebuild` replaces `main`; the old code stays in the tag `v1-final` | — | — |

Not brought over: the `painted` type and the coexisting drawing models, the 46 KB guide (replaced by
`aia guide <topic>`), the 20 MCP tools (replaced by `aia(command)` + `render`), the `.claude/agents/` written for
them (rewritten for the `aia` commands: `architecture`, `auditor`, `ai-tester`).

The craft recipes (topic 4; draft in `docs/v1/plan.md`, «Pendiente: guía de oficio») go into the guide topic of the
part they belong to: drawing from a reference in 4, rig order in 5, clips and the walk cycle in 6.

**Part 1, the base (2026-11-16):** the Electron shell (single instance, a window, external links open outside, a
stable local port), the documents folder (`--documents`, `AIA_DOCUMENTS`, the repo's `documents/` from source,
`%APPDATA%\aia-studio\documents` installed), a local server on `127.0.0.1` that refuses foreign `Host` and `Origin`
(shared with the Vite dev server), an empty editor page, tests, typecheck and the Windows installer config. No
document model, operations, `aia` commands, CLI or MCP yet.

**Trying Design mode, step 1 (2026-11-16):** the top bar (☰ menu: New, Open, Project Settings, Close tab, Delete;
the logo; the document tabs; undo and redo; the Design mode), the Layers panel (vector and group layers: add above
the selection or inside a group, rename with F2 or a double click, hide, lock, delete, drag to reorder or into a
group), the artboard on the canvas and the Document JSON panel. Under it, the start of part 2: the schema
(`schema/*.json`: `meta`, `layer`, `vector`, `group`), the document (a flat list in tree order, only non-default
values stored), the operations (`create`, `set`, `delete`, `move`, `rename`; atomic batches with their inverse) and
the store (`document.json` + `history.jsonl`, undo and redo per origin).

**Trying Design mode, step 2 (2026-11-16):** parts inside a vector layer (`rect`, `ellipse` and `path`, from the
abstract `part`: fill, stroke, strokeWidth, visible; coordinates are the layer's), shown inside their layer in
Layers. Tools: Select (V: pick a part, drag to move; empty space goes back to its layer), Rectangle (R) and Ellipse
(E) (drag; Shift for a square or circle), Pen (P: corners and curves; the first point closes, Enter ends a line).
New parts go into the active vector layer, or a new one. `src/core/draw.js` draws a document as SVG without the DOM
(the canvas uses it; previews and the runtime will).

**Trying Design mode, step 3 (2026-11-16):** the tools sit in groups with a menu, as in v1 (Transform: Select; Draw:
Rectangle, Ellipse, Pen), and an options bar shows what is selected with its name, editable, as in Moho. Select now
does what was missing: scale with handles (Shift keeps proportions, Alt from the center), rotate with a knob (Shift:
15° steps; `rect` and `ellipse` gained `rotation`, a path turns its vertices), several parts at once (Shift+click,
also in Layers, or a marquee), and copies (Ctrl+D, Ctrl+C / Ctrl+V into the active layer, Alt+drag), plus nudging with
the arrow keys. `src/core/geometry.js` holds the math (matrices, outlines, bounds, `transformPart`) so the `aia`
commands can transform parts exactly as the editor does.

**Trying Design mode, step 4 (2026-11-16):** every shape is a path (decision 8): `rect` and `ellipse` left the
schema and the Rectangle and Ellipse tools draw paths. The Draw group starts with the Pen. The Transform group adds
Move (M), Scale (S) and Rotate (T), which do one thing by dragging anywhere, besides Select (V), which does it all.
A second click on the picked part edits the points of every part of its layer, as in Moho (drag points of
several parts at once, bend curves with their knobs, Alt+click for corner ↔
curve, Del, a marquee over points, Esc). Layers lists only layers: a part is named in the options bar and its layer is
highlighted. After drawing, a small box asks for the new part's name (optional), and a new layer opens its name for
editing.

**Trying Design mode, step 5 (2026-11-16):** the bar follows the columns of the panels (the tools over Layers, the
selection from where the canvas starts, undo, redo and the mode over the right panel). The options bar shows buttons
instead of instructions: Edit points, and while editing, Curve / Corner, Delete and Done. The Inspector is on: the
properties of the selection built from the schema (each with its `help` as a tooltip), the document's own when
nothing is selected, and what several parts share (mixed values show empty; a change applies to all, in one batch).

**Trying Design mode, step 6 (2026-11-16):**
- **Origin:** layers and parts have `originX` / `originY` (null = the center of the box), the point they rotate and
  scale around. It shows as a crosshair that can be dragged (double-click: back to the center) and in the Inspector.
  It moves along with its part. With a vector layer selected, the Transform tools transform all its content around
  the layer's origin. (A layer still has no transform of its own: its content's vertices change. A non-destructive
  layer transform, as Moho's Transform Layer, came in step 11.)
- **Colors:** fill and stroke are swatches; a click opens a popover (palette, the system picker, a hex field, None).
  The stroke's width sits on the same row, and colors and numbers show live on the canvas while they change.
- **Auto fill and auto stroke:** with the Pen, Rectangle or Ellipse, the bar and the Inspector («New shapes») set the
  fill and stroke new shapes get (None turns it off; an open line never gets a fill). Kept per person in the browser.
- **Weld:** in point editing, the Weld button joins two picked open ends (the ends of one line close it; the ends of
  two lines make one, the other part is deleted), and Auto weld does it when an open end is dropped on another.
  `closeOutline` and `joinOutlines` in `src/core/geometry.js`.

**Trying Design mode, step 7 (2026-11-16):** ghost outlines. A part that draws nothing (hidden, or with neither
fill nor stroke) shows on the canvas as a thin dashed outline in its place, fainter when hidden, so it can be found,
picked (inside it, or near the line of an open one), transformed and edited point by point. Only with the Transform
tools and in point editing, never with the drawing tools, and never in `drawDocument`'s output (previews, the
runtime and the export draw only what is visible). A hidden layer hides its parts completely. Tab / Shift+Tab pick
the next or previous part of the active layer, hidden ones included.

**Trying Design mode, step 8 (2026-11-16):** named points, shared points (welding) and point groups, as decision 6
foresaw. Agreed with the user:
- **Named points:** a vertex may have a `name`, unique in its part (`{ x, y, name: "chin" }`), called `jaw.chin`
  elsewhere. A picked point is named in the options bar. Points that need a name to be referred to (welded or
  grouped) get one at once, the part's id and a number (`jaw_1`), and can be renamed; shared points and groups
  follow the new name.
- **Shared points:** a vertex may share a named point of another part of the same layer instead of having x, y:
  `{ ref: "jaw.chin", in?, out? }` sits where `jaw.chin` is (its handles are its own). The core resolves it
  (`resolveDoc` in `src/core/points.js`) for drawing, the runtime and the editor. Renaming a part renames the
  references; a batch that leaves a reference or a group member without its point is refused, with a message.
- **In the editor**, a moved shared vertex moves the point it shares (the same point), and deleting a shared point or
  its part leaves the vertices that shared it where they were, as points of their own (`settleOps`: the editor's
  batches are settled before they are saved, so the AI's operations stay plain).
- **Weld:** dropping a point on a point of another part (Auto weld, or the Weld button with two picked points) makes
  it share that point; dropping it on a line of another part adds a point there and shares it. The two ends of one
  line still close it. **Alt** joins two open ends of two lines into one line (the weld of step 6). Shared points
  show round; **Unweld** makes the picked ones separate points again.
- **Add points:** in point editing, a click on the line of an outline adds a point there without changing its shape
  (Moho's Add Point; drag to move it at once). `nearestOnOutline` and `insertVertex` in `src/core/geometry.js`.
- **Point groups** belong to the vector layer: `groups: { "upper_lid": ["lid.top", "brow.mid"] }`. While editing
  points, the Groups menu picks a group's points, makes a group of the picked points, adds or takes them out, and
  deletes a group (its points stay).

**Trying Design mode, step 9 (2026-11-16):** drawing connected to what is already there, as in Moho. With the Pen,
the points of the active layer show as small dots, and with Auto weld on (its switch is in the Pen's bar too), a
click on one of them, or on a line of the layer, welds the new vertex there: it shares that point (named at once if
it had no name; on a line, a point is added first). There is no need to finish the drawing and weld in point editing
afterwards. A green ring shows where a weld will happen, both while drawing with the Pen and while dragging a point
in point editing.

The Pen then became Moho's Add Point (the user's choice): press and drag, and the new point follows the pointer
until it is released (before, a click put a point and a drag pulled curve handles, as in Illustrator). Pressing on
an open end of a line of the layer continues that line (an accent ring shows it); anywhere else starts a new line of
two points. Points come out smooth, an automatic curve through their neighbors; the Sharp corners switch, or Alt,
makes corners. Released on the other end of the same line, it closes into a shape with the auto fill. Each stretch is
saved when released (one undo step), so there is no Enter to finish and no outline left half done.

**Trying Design mode, step 10 (2026-11-16): shared curves.** Shared points kept two parts together at their
points, but each part had its own curve between them, so a fill under a line did not follow it when the line was
curved. Now a stretch of an outline can follow another part's outline (decision 6, «what v1's `loops` did»):
`{ "ref": "jaw.ear_l", "follow": "jaw" }, { "ref": "jaw.ear_r" }` draws from `ear_l` to `ear_r` along `jaw`, through
its points and curves in between. Both ends share points of the part followed; on a closed part it goes the short
way, and `"way": "long"` the other. The JSON stays short (jaw's points are not copied): the core expands it when
drawing (`resolveDoc` and `followStretch` in `src/core/points.js`), and bounds and the editor's outlines use the
expanded outline. Renaming the followed part follows; a batch that breaks a stretch is refused; in the editor,
deleting the followed part leaves a plain stretch. In point editing, the **Follow** button makes the stretch between
two picked neighbor points follow the part they share points with (Alt+click: the long way), and **Unfollow** undoes
it. The Fill tool will make these by itself.

**Step 15 (2026-11-17): editor touches asked by the user.** The Pen was tried asking for a new line's name, and it got in the
way after every stretch, so it does not ask: a line keeps its given name (`line_1`…) until it is renamed (F2).
Ctrl+X cuts the picked parts (copy and delete in one step), so Ctrl+V moves them into the active layer, or another one
picked before pasting. The undo and redo buttons left the bar (Ctrl+Z, Ctrl+Shift+Z). The Inspector has a Flip row
(horizontal, vertical) for the selected parts, across the middle of their box, or for a selected layer, through its
own transform; while editing points it flips the picked points instead. Colors: the popover's first chip is None (a
crossed-out square) and an Opacity slider sets the part's new `fillOpacity` / `strokeOpacity` (0 to 1; also
`--fill-opacity`, `--stroke-opacity` in `aia rect` and `aia ellipse`); any 0-to-1 number, such as an image
layer's opacity, is a slider.

**Step 16 (2026-11-18): curve handles, as in Moho (agreed with the user).** A point remembers whether it is smooth or
broken, read from its handles (`isSmooth` in `src/core/geometry.js`: both handles there, pointing opposite ways; no
new property, so the AI keeps writing `in` / `out`). Dragging a handle of a smooth point turns the other with it
(`alignHandle`); on a broken point each handle moves alone, so a corner made by hand is no longer lost on the next
drag. **Shift** while dragging, the user's choice from Moho, does the opposite while it is held: it breaks a smooth
point, or lines up a broken one (it was Alt before, and the break was forgotten). At a welded point every line that
meets there has its own vertex with its own handles, but only the picked vertex showed them: now picking a welded
point shows the handles of every line on it (the other lines' ones hollow, with a dashed stem), and hovering a handle
lights up the line it bends (and the handle grows a little, in screen pixels, so it keeps its size at any zoom).
The desktop window lost Electron's native menu bar (File, Edit, View, Window) on Windows and Linux: pressing Alt, the
editor's own modifier, showed and hid it. The editor has its own ☰ menu; F12 opens the developer tools when run
from source, and macOS keeps its default menu.
The point editing bar got lighter (asked by the user): the Weld button left, as Auto weld does the same by dropping a
point (and Alt joins two open ends); Auto weld sits next to Unweld; the name fields are narrower. Switches carry an icon (Sharp corners the corner, Auto
weld the weld) and light up in the accent color while on. The fill and stroke swatches, in the bar and the
Inspector, are v1's bean instead of a square: filled with the color, or outlined with it (a faint halo keeps a dark
color visible; None is a dashed bean with a red slash); a click opens the color popover as before.
Point editing without its Delete button (Del does it), and with clicks that pick, asked by the user: a click on a
line or inside a shape of the edited layer picks all its points (Shift adds them or takes them out; a drag moves
them). Adding a point on a line, which a click did before, is now the **Add point** switch in the bar (as Moho's
Add Point, off when the editor starts): while it is on, a click on a line adds a point there and the mark shows where.
Del deletes every picked point in one step; a part left with fewer than 2 goes with them (before, it was refused),
and point editing goes on with a part that stays.

**Step 17 (2026-11-18): moving around the canvas** (asked by the user; before, the artboard was always fitted to the
canvas, with no zoom). As in Moho and every drawing app: the wheel zooms around the pointer (Ctrl+wheel and a
trackpad pinch too), Shift+wheel or a sideways scroll moves the view sideways, and Space+drag or a middle-button drag
moves it with any tool. Ctrl + / Ctrl − step through the zoom levels around the middle, Ctrl+0 fits the artboard,
Ctrl+1 is 100 %, Shift+2 zooms to the selection (to the picked points while editing them). The zoom shows in the
canvas's corner with a menu of the same. The view is not part of the document (the AI never needs it): each
document's is kept in the browser as its scale and the point at the middle of the screen, and a document seen for the
first time, or after Ctrl+0, fits the artboard and follows the window. The math is `src/editor/viewMath.js` (no DOM,
with tests), the events `src/editor/navigate.js`. The Electron window has no native menu (step 16), so these keys
are the editor's, not the window's zoom. The keyboard shortcuts dialog got a View section and up-to-date Points and
Pen rows.

**Review of steps 16 and 17 (2026-11-18)**, by the `auditor` and `architecture` agents, and what was fixed:
- Deleting points is one rule in the core, `deletePointsOps` in `src/core/weld.js`, for Del in the editor and
  `aia delete-point` alike (before, the AI's command refused what the editor did). A refused delete keeps the points
  picked.
- Shift+2 gives room in document units (a quarter of the artboard around a point), so pressing it again changes
  nothing (before, it zoomed in about 9× each time); on a selection that draws nothing it leaves the view alone. A
  deleted document's view is forgotten, and a new document starts fitted even when it takes an old id. The wheel does
  not zoom during a drag (a marquee would lose its frame).
- Handles of a stretch that follows another part are not shown (they do nothing there); only the handle under the
  pointer grows.
- Cleanup: `isLayer` comes from `core/transform.js` everywhere (settle.js left out image layers, so a moved image
  layer did not get its origin fixed), unused `targetPlace` / `pointAtRef` / undo and redo icons and Layers' branches
  for parts removed, the Pen's local `isSmooth` renamed `hasHandles`, `navigate.js` no longer imports `canvas.js`.
- Found for the next stage (not fixed yet): a stretch can follow a part only between points of that part, so a fill
  cannot go on along another line from a junction where the second line only shares the point; the Fill tool needs
  that first. Also: no curve crossings or region search yet, `pointsError` resolves the document once per followed
  stretch, `server/aia.js` (≈950 lines) should be split by topic when `aia fill` comes, and the editor still does a
  few things with no command (flip points, move one handle).
