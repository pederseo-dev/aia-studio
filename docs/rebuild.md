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

### 6. Drawing: named parts, as in Moho but readable (2026-11-16)

v1 kept drifting toward Moho's mesh and it kept getting harder for the AI: anonymous points (`p1`…`p47`), curves
through them, shapes that paint curves and `loops` for regions, so every change meant rebuilding the topology in its
head. SVG was never the limit; the unnamed indirection was. What the user wants from Moho is the way of working:
many shapes, fills and strokes inside one layer, and painting between lines.

- A **vector layer** holds **parts** (each an outline of vertices with its fill and stroke; see decision 8),
  **named points** (`chin`, `mouth_corner_l`) and **point groups** (`upper_lid`), like Moho's point groups.
- **Welding is explicit:** a vertex can reference a point of another part (`jaw.chin`), and a stretch of an outline
  can follow another part's curve between two points (what v1's `loops` did, inside a named part).
- Filling between lines is a tool, as Moho's **Create Shape** (and `aia shape` / `aia fill`): it creates parts whose
  outline follows the lines around a region; not a type of its own (decision 10).
- Each part draws as one SVG path, so the runtime resolves references and draws.

It was tried out in the editor in the Design mode steps below; the model that came out of them is decision 10.

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

### 10. The drawing model (2026-11-18)

Settles the drawing part of open topic 2, after trying decisions 6 and 8 in the Design mode steps (1–17). Bones and
binding, pose vs clip, and params and drivers stay open.

- **One kind of shape, the `path`:** vertices `{ x, y }` with optional curve handles `in` and `out`, relative to the
  vertex. A point is smooth or broken by its handles (both there and opposite = smooth); nothing else is stored.
  Rectangle, Ellipse and the Pen are tools that draw paths.
- **Points have names, and one owner.** A vertex may have a `name`, unique in its part (`jaw.chin`). Another part of
  the same layer shares it with `{ ref: "jaw.chin", in?, out? }`: same place, its own handles. A `ref` names the
  owner's point, never another `ref`.
- **A part passes through a point** when it owns it or shares it. This is what lets the model do what Moho's mesh
  does (every curve through a point meets there) while points keep their names for the AI.
- **Followed stretches:** a stretch of an outline can follow another part between two points that part passes
  through: `{ ref, follow: "jaw", way? }` to the next vertex. The JSON keeps only the ends; the core expands it. The
  followed part must not have followed stretches itself (a fill follows lines, not other fills). `way` is `"short"`
  by default on a closed part; Create Shape writes `"long"` where its stretch goes the long way.
- **Point groups** belong to the vector layer (`groups: { upper_lid: ["lid.top", …] }`).
- **Layers:** vector (holds parts), group, image; any of them with a transform (x, y, rotation, scale, origin).
- **Holes** (2026-11-19): a `path` may have `holes`, closed outlines cut out of its fill (drawn even-odd), each a list
  of vertices like its own but without names; they share points and follow lines as the outline does. A hole whose
  shared point is deleted goes away with it.
- **No mesh and no region type.** What fills a region is a **shape**, made by Create Shape (the editor's tool, `aia
  shape`, `aia fill`): two `path` parts whose outlines follow the lines around it, `<line>_fill` (only the fill) and
  `<line>_stroke` (only the stroke), placed under those lines, each with its own place in the order. Moving or bending
  a line moves the shapes that follow it, because they are drawn from it. A part drawn with its own points (Pen,
  Rectangle, Ellipse) is an **element** and keeps its own fill and stroke: the two ways live side by side.
- **One rule in the core for each change**, used by the editor and by `aia` alike (welding, naming, deleting points,
  following), and settled by the store for every origin.

## Open topics

1. **Purpose and priority:** the live character in apps as the design driver (the runtime as the contract), with
   Animate scenes for video as a secondary use? Or both at the same level?
2. **Document model:** bones and binding, pose vs clip (one asset?), params and drivers. (Drawing: decided, decision
   10.)
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
| 4 | **Drawing**: one drawing model (paths with named, shared and followed points: decisions 6 and 8, no mesh), Create Shape for regions (shapes with holes), the stroke of stretches | the idea of v1's `regions` (painting between lines); written new on `core/points`, `core/weld`; editor drawing tools | topic 2 (its drawing part) |
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
  that first. Also: no curve crossings or region search yet, `server/aia.js` (≈950 lines) should be split by topic when `aia fill` comes, and the editor still does a
  few things with no command (flip points, move one handle).

**Performance on big layers (2026-11-18).** Measured in the core with a layer of circles and a fill following each
(as the Fill tool will make): resolving shared points and drawing grow in proportion (1000 shapes, 5500 points: about
8 ms and 13 ms), but `pointsError`, which checks every batch, resolved the whole document once per followed stretch,
so it grew with the square: 0.5 s at 400 shapes, 9 s at 1000. It now resolves once (21 ms at 1000), with a test that
keeps it quick. Still to keep in mind: the editor redraws the whole SVG on each change and while dragging (fine for
hundreds of shapes; with thousands, redraw only what changed), the runtime will need to update only what an animation
changes instead of redrawing each frame (parts 6 and 7), and lookups by id walk the list of objects.

## Next: Fill & Stroke (part 4)

**Where it stands (2026-11-19, read this first):** the tool is **Create Shape** (F, the bean), as Moho's: it picks
**points** of a layer's lines (a click, Shift to add or take out, a box, or a click inside a gap for all the points
around it); a checkerboard shows when they close a shape, and Create shape (Enter) makes it. Where lines cross without
a point a ring shows, and a click welds them there. A **shape** is two parts that follow the lines, `<line>_fill` and
`<line>_stroke`, under them, each with its own order; shapes add up (Moho) and are renamed with their line. Shapes
inside a gap that do not touch it are **holes**. The Inspector shows, for one part, its **Element** (own order, fill
and stroke: square swatches) and its **Shape** section (a dropdown, delete, each shape's fill and stroke as beans with
their own order). `aia shape`, `aia fill`, `aia crossings` and `aia order` do the same for the AI. The structure
items of the closing review are done. **Step 3, Hide Edge, caps and joins, is done** (2026-11-20, see "Step 3:
Hide Edge, caps and joins" just below, with its closing review): `hiddenEdges`, `strokeCap` / `strokeJoin`, `aia
edge` and the Hide Edge tool (H). The older plan after it and the step notes are history: where they disagree
with this paragraph, this paragraph is right.

### Step 3: Hide Edge, caps and joins (agreed 2026-11-20)

In Moho (manual: Fill tools, Style window) the Hide Edge tool hides stretches of one shape's outline by clicking them,
"without affecting the fill"; Line Width sets a width per point (click a point and drag); fill and outline are
separate shapes; the manual says nothing of caps or joins. Here:
- **Model:** a part may have `hiddenEdges`: the stretches of its stroke that are not drawn, each a pair of points
  `["head.p2", "head.p3"]` (the two ends of one drawn stretch). The same for an element's own line and a shape's
  `_stroke` part (whose followed stretch may pass several points of the line: the pair names exactly the drawn piece).
  Unnamed points get a name when a stretch is hidden (as Create Shape does). The fill is unchanged; a part with hidden
  edges draws its fill and its stroke apart (the stroke in runs, open where an edge is hidden). Renaming a part or a
  point renames the pairs; a pair whose point is gone, or that is no longer a drawn stretch of the part, is dropped.
  So drawing knows the ends of each drawn stretch, the followed outline (part[OUTLINE]) keeps each vertex's point.
- **Caps and joins:** `strokeCap` (round, square, butt) and `strokeJoin` (round, miter, bevel) on a part, both
  **round by default** (how strokes look today). They show by themselves in the Inspector's Element section (it comes
  from the schema); in the Shape section they go with its Stroke row.
- **Editor:** a **Hide Edge** tool of its own (key **H**), added to the tool selector (in the Create Shape group). The
  stroke stretch under the pointer lights up (of the topmost element or `_stroke` part there); a click hides it, a
  click on a hidden one shows it again; hidden stretches show as a faint dashed line so they can be found.
- **AI:** `aia edge <doc> <part> <point> <point> --hide | --show`; `--stroke-cap` and `--stroke-join` in `rect`,
  `ellipse`, `shape` and `fill`; the guide's points or paths topic explains `hiddenEdges`.
- **Left out:** Line Width (a width per point). SVG has no variable-width stroke, so the core and the runtime would
  build each stroke's outline; probably not added if it stays that costly.
- Steps: (a) the model in the core (schema, resolve keeps point ids on drawn vertices, checks, rename, settle drops
  stale pairs, draw in runs) with tests; (b) caps and joins (schema, draw, Inspector, `aia` flags); (c) `aia edge` and
  the guide; (d) the Hide Edge tool; (e) closing: `auditor`, `architecture` and `ai-tester`.

**Step 3a, the model (2026-11-20):** `hiddenEdges` on `path` (schema type `edges`: pairs of two different named
points, no pair twice). `resolveDoc` keeps, next to the followed outline, what each drawn vertex is (its point id and
the vertex it comes from: the part's own, or the followed line's); `strokedOutlines(part)` in `points.js` gives a
part's outline and holes with those, `stretchEnds` the pair at each drawn stretch, `hiddenFlags` which ones are hidden.
`pointsError` refuses a pair that is not a drawn stretch of its part (a pair is the same either way round; the
closing side counts). Renaming a part renames the pairs (`renamePointRefs`); renaming a point or welding it into
another renames them too (`redirect` in `weld.js`, through `redirectEdges`), and `aia name --none` keeps the name of
a point a hidden edge uses. `settleOps` drops the pairs a batch made stale (a point gone, or a point added between the
two ends) and leaves a pair that never named a drawn stretch, so it is refused with the reason. Drawing: a part that
hides something is a `<g data-id>` with its fill whole (no stroke) and its stroke as runs of shown stretches
(`strokeData` in `draw.js`; a closed outline starts after a hidden stretch so no run goes over its end); the stroke
path carries the `data-id` too, so it is picked by its stroke like a line. A copy keeps its hidden stretches on its
own points (named if they had no name; holes' are not copied, as their points take no names). `src/core/edges.js`
has the ops for the editor and `aia`: `edgeOps` hides or shows a drawn stretch naming its unnamed ends (in the line a
shape follows, when the end is one of its points), `stretchBetweenPoints` finds one by two points, `stretchNear` by
the pointer. Tests: `tests/edges.test.js`.

**Step 3b, caps and joins (2026-11-20):** `strokeCap` (round, square, butt) and `strokeJoin` (round, miter, bevel) on
`part`, round by default (a new schema property type, `choice`, with its `values`; `aia guide <type>` shows them as
"one of …"). Drawn as `stroke-linecap` / `stroke-linejoin` (the cap also shows where a hidden edge opens the stroke).
In the Inspector they show by themselves in the Element section as dropdowns (Stroke cap, Stroke join), and the Shape
section has a Cap / join row under the shape's Stroke row, for its stroke part. `--stroke-cap` and `--stroke-join` in
`aia rect`, `ellipse`, `shape` and `fill` (checked against the schema's values; for a shape, only its stroke part
takes them).

**Step 3c, `aia edge` (2026-11-20):** `aia edge <doc> <part> <point> <point> --hide | --show` (in
`server/aia/points.js`): the two points are part.point or part.index, next to each other along the part's stroke (a
shared vertex stands for the point it shares, so a shape's stretch is named by its line's points); unnamed ones get a
name and the answer says which. Says why when the two points draw no stretch of that part, or it is hidden or shown
already. The guide's paths topic explains `hiddenEdges`, `strokeCap` and `strokeJoin`; the points topic has `aia
edge` for elements and shapes.

**Step 3d, the Hide Edge tool (2026-11-20):** `src/editor/hideEdgeTool.js`, key **H**, in the Create Shape group of the
tool selector (icon: a square with one side dashed). The stretch of a stroke under the pointer lights up, of the
topmost part there with a stroke (elements and `_stroke` parts, in shown and unlocked layers; the reach is a few
screen pixels plus half the stroke width); a click hides it (`edgeOps`, one undo step), a click on a hidden one shows
it again. While the tool is on, every hidden stretch shows as a faint dashed line, and the lit one is dashed when a
click would show it. A shape's stroke lies under its line, so the line wins there: **Alt** takes the stroke under the
topmost one (added after trying it). The shortcuts dialog has its row.

**Step 3e, closing review (2026-11-20):** the `auditor`, `architecture` and `ai-tester` agents (report:
`docs/ai-tests/2026-11-20-hide-edge.md`). Fixed:
- Renaming a point that a hole shares dropped the hole (older than step 3): `redirect` in `weld.js` renames the
  refs of holes too, and `isShared` counts holes, so `aia name --none` keeps such a name.
- A batch that wrote a pair its own changes made stale was applied and the pair (and an older one) silently dropped:
  `settleOps` now drops only pairs that were there before the batch; the batch's own go to `pointsError`.
- Joining two lines (`--join`, Alt in the editor) lost the absorbed line's hidden edges, and closing a line lost the
  pairs at the end that goes away: `edgesAfterMerge` carries them (renamed to the kept part and the merged point).
- Ctrl+C / Ctrl+V of a shape pasted a 2-point sliver without its hidden edges (older than step 3): `structuredClone`
  dropped the drawn outline `resolveDoc` sets under symbols; the clipboard keeps a shallow copy.
- A line without fill whose stretches are all hidden drew nothing and could not be picked: it shows as a ghost.
- `aia edge`: the "no stroke" note came out the wrong way round; a third point is refused (one stretch per command);
  hiding a shape's stretch says when its line still draws its own stroke over it, with the command to hide that too
  (the ai-tester needed 4 commands to leave only the fill at the chin); the help and the guide say so.
- Structure (architecture): `hiddenFlags`, `hidesEdges`, `withEdge` moved to `edges.js` and `redirectEdges` to
  `weld.js`, so `points.js` keeps only what checks and settling need; `settleOps` resolves for hidden edges only when
  a part has some; draw's `DEFAULTS` holds the cap and join defaults (also used by the tool's reach); the tool's
  highlight uses `pathData`; `edgeKey` is shared with the schema check; unused exports removed. Tests for welding an
  end of a hidden edge, holes, joining and closing.
Found and left for later: a shape around two lines welded only at their two ends (a lens, 2 drawn vertices) is drawn
with one side only, and its two sides are one pair (older than step 3: `pathData` does not draw the closing side of
a 2-vertex outline); unwelding an end of a hidden edge shows the stretch again (the vertex loses its name); the
editor has no list of hidden stretches besides the dashed lines, and `aia show` is the AI's.

### Step 4: Select Shape (agreed 2026-11-20)

Asked by the user after step 3: with Select, a line, its `_fill` and its `_stroke` lie on top of each other, so it is
hard to know which one a click took. As Moho's Select Shape, a tool of its own:
- **Select Shape (Q)**, in the Create Shape group. Over the canvas, what a click would take is marked lightly, with
  a small label (`head · element`, `head_fill · fill`, `head_stroke · stroke`): a fill tinted, a stroke as a band
  along it. Near a stroke a click takes the topmost stroke there (a line or a `_stroke`); inside, the fill. An
  **element** is taken whole (its own fill and stroke are one part); a shape's fill and stroke are taken apart.
- **Alt+click** goes down through everything at that place (line → `_stroke` → `_fill` → …), from the one selected.
- The selection stays lightly marked the same way, and the Inspector shows it (the element, with the shape picked).
- **↑ / ↓** raise or lower the selected part one place in its layer, **Shift** to the top or bottom (the arrows do
  not move anything in this tool). No ordering across layers and no list of the order (decided: not needed).
- Nothing new for the AI: `aia order` orders already.

**Built (2026-11-20):** `partsAt(doc, at, reach, include)` and `kindOf(part)` in `src/core/shapes.js` (no DOM, tested
in `tests/fill.test.js`) give the parts drawn at a place of the artboard, topmost first, each as element, fill or
stroke: near a stroke it draws (not a hidden stretch; reach plus half its width, in its layer's units) or inside its
fill (its holes left out, curves sampled). `src/editor/selectShapeTool.js` (Q, in the Create Shape group: Create
Shape, Select Shape, Hide Edge) marks the hovered part (a fill tinted, a stroke as a band, an element both, and a
label `id · kind` by the pointer) and the selected ones more faintly; a click selects the topmost, Alt+click the one
under the selected one (round to the top after the last); ↑ / ↓ in `main.js` call `orderSelected` (Shift: top or
bottom), ← / → do nothing in this tool. The shortcuts dialog has its row.

**Touches asked by the user (2026-11-20):** Stroke cap and Stroke join in the Inspector (Element section and the
Shape section's Cap / join row) are rows of icon buttons, the one set lit, instead of dropdowns (`choiceControl` in
`inspector.js`: a choice whose values all have icons, `CHOICE_ICONS`; any other choice stays a dropdown). Hide Edge
works as Moho's: press and drag over the lines and every stretch passed over is hidden, or shown when the first one
was hidden, in one step on release (the places between two pointer moves are looked at too, so a quick drag skips
nothing; the swept stretches show lit while dragging). `edgesOps` in `core/edges.js` hides or shows several
stretches at once, naming their unnamed points together (`edgeOps` is it for one, with its checks).

Agreed on 2026-11-19, on decision 10 (replaces the paint bucket plan of 2026-11-18). Not a paint bucket: a **Fill &
Stroke tool (F)** that works as a selector of its own. Over a closed gap between lines it shows the gap hatched, over a
stretch of a line (between two points) it shows it thicker; a click marks or unmarks it (Shift: several), and the marks
stay (editor only, not in the document) until an action of the tool's bar is applied or Esc. On marked gaps, **Fill**
makes one part per gap whose outline follows the lines around it, just under the lowest of them, with the tool's fill
and stroke (each with None, kept apart from the Pen's auto style); on a gap already filled, it recolors that fill. On
marked stretches, **Stroke on / off** shows or hides the stroke of those stretches. Picking points stays in the points
editing mode. Fill and stroke of one part go together (its stroke over its own fill); to order them apart, they are two
parts, which is what lines plus fills already are. The steps, in order; each one with its tests, closed as usual:

1. **Raise and lower parts** (Moho's Raise / Lower shape): Page Up / Page Down move the picked parts one place up or
   down in their layer, Shift+Page Up / Page Down to the top or bottom; several keep their order among themselves.
   Buttons in the editor, and `aia order` for the AI. Dragging in Layers already does it by hand.
2. **Follow from shared points** (the model change of decision 10). `followStretch` (`src/core/points.js`) and
   `stretchBetween` (`src/core/weld.js`) find, in the followed part, the vertex that owns *or shares* each end, so a
   stretch can go on along another line from a junction the Pen welded (today it is refused: the point belongs to
   the first line). Refuse following a part that has followed stretches. `aia follow` and the editor's Follow get it
   for free.
3. **Stretches without stroke, caps and joins** (replaced on 2026-11-20 by "Step 3: Hide Edge, caps and joins"
   above: hidden stretches are pairs of points in `hiddenEdges`, not a vertex flag).
4. **The gap around a point**, in the core, without the DOM: the resolved outlines of a layer cut at the points they
   pass through (only shared points count: lines that cross without a weld do not close a gap) make a graph; the
   smallest closed loop around the place is the gap, as a list of (point, part followed, way). Then
   `fillOps(doc, layer, at, style)`: one batch that creates the fill part (`ref` + `follow` + an explicit `way` for
   each stretch), or recolors the fill already there. A place that is not closed gives an error that says so.
   `aia fill <doc> <layer> --at x,y` (style as `aia rect`) and its guide topic; `server/aia.js` (≈950 lines) is split
   by topic first (documents, points, shapes, output).
5. **The Fill & Stroke tool in the editor** (F): the hatched gap or thick stretch under the pointer, the marks, and the
   bar with the swatches and the actions. A gap that does not close shows nothing (or says to weld the crossing).
6. **Closing part 4**: the `ai-tester` (an AI fills and strokes a drawing with only the CLI), the `auditor` and the
   `architecture` reviews.

**Step 1, raise and lower (2026-11-19):** `orderOps(doc, ids, how)` in `src/core/order.js` gives the `move` ops that
raise or lower objects among their siblings (`up`, `down`, `top`, `bottom`); several move together and keep their
order, a run of them moves as one, ones already at the end stay, and objects of different parents move each among
their own. In the editor, Page Up / Page Down (Shift: to the top or bottom) and an Order row in the Inspector (Bottom,
Lower, Raise, Top, next to Flip) work on the selected parts or layers; locked ones are refused. `aia order <doc>
<id>... --up | --down | --top | --bottom` answers with the new order, and `aia guide start` names it.

**Step 2, follow from shared points (2026-11-19):** a followed stretch's ends are points the followed part *passes
through*: `pointIdOf` and `passIndex` (`src/core/points.js`) say which point a vertex is (the one it shares, or its own
named one) and where a part owns or shares it, and `followStretch` walks the followed part between those indices. So
a fill goes on along a second line from the junction where the Pen welded it to the first (the second line only
shares that point). Following a part that follows others is refused. `stretchBetween` (`src/core/weld.js`) picks the
line to follow among the parts through both points that do not follow others: the one followed now, then the owner
of the first point, then any other, and says why when there is none. `aia follow` and the editor's Follow got it with
no change of their own (their help says so); the guide's points topic explains it.

**Steps 4 and 5, a first Fill & Stroke tool (2026-11-19):** brought ahead of step 3 so the person can try it.
`src/core/fill.js`: the lines of a layer (its shown parts that do not follow others) make a graph with a node at each
vertex (one node where lines share a point) and an edge along each stretch (sampled curves); its faces, without the
spurs of open ends, are the gaps, and `gapAt` gives the smallest one that holds the place. `fillOps` cuts the gap into
stretches (one per run along a line, at least two, never from a point back to itself), names the unnamed points they
start at, and creates `fill_N` with `{ ref, follow, way? }` vertices just under the lowest line it follows; on a gap
already filled (a fill holding the place with about its area) it sets the style instead. `aia fill <doc> <layer> --at
x,y` (style flags as `aia rect`; no stroke unless told) and a line in the guide's points topic. In the editor, the
Fill & Stroke tool (F, the bean icon, its own group): the gap under the pointer hatched, a click marks it (again:
unmarks; Shift: several), Fill in the bar or Enter fills the marked gaps in one step, Esc clears them. Its fill and
stroke (default: no stroke) are kept apart from the drawing tools' auto style. Not yet: stroke on / off of stretches
and caps / joins (step 3), marking stretches with the tool, and the split of `server/aia.js` (now ≈1050 lines).

**Create Shape and holes (2026-11-19):** the tool became Create Shape (see the note at the top of this section). The
model: `holes` on `path` (schema type `holes`: lists of vertices without names, at least 3, or 2 that follow lines);
`resolveDoc` places their shared points and sets `part[HOLES]` for the followed ones (`holeAsPart` checks a hole as a
part of its own), `pointsError` checks them, renaming a part renames them, `settleOps` drops a hole whose shared point
is gone, `transformPart` and copies carry them (copies as plain points), and `partData` draws them after the outline
with `fill-rule: evenodd`. A `set` to an empty list now removes a property whose default is an empty list. The gap
search: lines joined by shared points are one group; the outside (biggest face) of every other group that lies inside
the gap, and not inside another such group, is a hole, and `fillOps` writes one hole per group, following it. In the
editor a click on an empty gap marks it, on a filled one selects its fill (Shift: adds), the hover shows a filled gap
only outlined, Create shape (Enter) makes the marked ones and selects them, and the Inspector shows a part's holes.

Left for later: a stroke width per point (Moho's Line Width: SVG has no variable-width stroke, so the core and the
runtime would have to build its outline), crossings that stay apart instead of welded (a shape would follow a
computed crossing; decided against for now: they are welded, as in Moho), a freehand lasso for picking points, a
closed line of only 2 points (it is not drawn closed either, so it closes no gap).

**Fixes after trying Create Shape (2026-11-19):** moving, turning, scaling or flipping a fill (Select and its tools,
`aia transform`) pulled only the shared points of its lines, so the other points of those lines stayed where they
were; now `partsToMove` (`src/core/fill.js`) moves the lines a fill follows, whole (and the fill itself only if it
has points of its own). Clicking inside a line picks the fill under it (a line is picked by its stroke), so this was
also why lines seemed not to be pickable. Shapes inside a gap that cross each other or its lines without a weld made
holes that cancelled out (even-odd); the gap search now says to weld them where they cross instead of filling.
`aia fill` names the lines of the holes too.

**Create Shape as in Moho (2026-11-19):** after reading Moho's manual (Create Shape picks the points around a shape;
a checkerboard shows when they close it; Space makes it; holes by picking their points too; a shape turns from one
line onto another only at a point), the tool picks **points**: a click on a point (Shift: adds or takes it out), a
box (Shift: adds), or a click inside a gap (the points around it and its holes). `shapeOf(doc, layer, nodes)` in
`src/core/fill.js` takes the stretches between picked points (dead ends left out); the outside of the biggest group is
the outline and the outsides of the others inside it are holes; when nothing closes, it gives the picked stretches
to show. The checkerboard shows the shape, Create shape (Enter; Space pans the view) makes it. Lines that cross
without a point: `crossingsOf` finds the places (on the sampled curves) and the tool shows a green ring at each; a
click on it welds the two lines there (`weldCrossingOps`: a point added on each, or the one already there, the
second sharing the first's), so they stay welded from then on, as in Moho. `aia shape <doc> <layer> <point>...` and
`aia crossings <doc> <layer> [--weld n | all]` do the same for the AI. With Select, lines without fill get an
invisible band of 10 px around them to be picked by (`addLineHits` in the canvas). Code: `graphOf` now uses
`facesOf` (shared with `shapeOf`), `gapOf` builds a gap with its holes and its `nodes`, `shapeOps` writes the part.

**Shapes accumulate, named after their line (2026-11-19):** as in Moho, Create Shape on the same points adds another
shape each time (useful for animation); `aia fill` on a filled gap did recolor it then (now it adds a shape too). Kept as they are: the two ways to
paint (a part's own fill and stroke, or shapes that follow lines) live side by side, the designer's choice. A new shape
is named after the line it goes along most (`head_fill`, `head_fill_2`). References already go by id and follow a
rename (like SQL's ON UPDATE CASCADE); now the `rename` op also renames the shapes still named after the line that
follow it (`head_fill_2` → `face_fill_2`), and leaves a shape named otherwise alone; undoing renames them back. The
Inspector shows, for a line, a Shapes row with the shapes that follow it (a click selects one), and for a shape, a
Follows row with its lines. In Create Shape, Shift on a point toggles it and dragging on toggles the points passed
over the same way; Shift+box toggles each point in it; Shift+click again in a picked gap unpicks it.

**Inspector touch-ups (2026-11-19):** Flip and Order are icon buttons (Order: Raise and Lower; Shift+click goes to the
top or bottom); a part's Vertices, Holes, Closed and Origin are no longer shown (they are edited on the canvas); the
Shapes row became a **Shape** dropdown just above Fill and Stroke, with the line and the shapes that follow it,
picking one selects it. `select` takes the controls' dark style.
The Shape row also has Raise and Lower (Shift+click: top or bottom) and Delete for the part picked in it, so with
one part selected the Order row is not shown (it stays for a layer or several parts); the row shows for a lone line
too, with its dropdown disabled.

**Element and Shape in the Inspector (2026-11-19):** a part drawn with its own points (Pen, Rectangle, Ellipse) is an
**element**: its fill and stroke are its own. What Create Shape makes are **shapes**, apart, on top of the element's
lines: a shape with fill and stroke is now two parts, `head_fill` and `head_stroke` (the stroke over the fill, both
under the line; numbered as a pair, `head_fill_2` with `head_stroke_2`; only one when the other is None), so each has
its own place in the order; renaming the line renames both. With one part selected the Inspector shows two
sections: **Element: head** (Flip, Order ▲▼, Visible, Fill and Stroke with square swatches) and **Shape** (a dropdown
of the shapes on that element, Delete for the one picked, and its Fill and Stroke as beans, each with its own ▲▼). A
click on a shape on the canvas shows the element it belongs to (the line it is named after, else the first it
follows) with that shape picked. The drawing tools' bar and «New shapes» use square swatches; Create Shape's bar
keeps the beans.

**Closing review of part 4, fixes (2026-11-19):** the `auditor`, `architecture` and `ai-tester` reviews (report:
`docs/ai-tests/2026-11-19-drawing.md`) found, and this fixed:
- Unwelding or deleting a junction a shape follows was refused ("broken point"): `settleOps` now turns into plain
  stretches those that followed fine before the batch and do not after it (the followed line no longer passes
  through the point), in holes too.
- Copying a shape (Ctrl+C / Ctrl+D, `aia copy`) failed or made a 2-point sliver: a copy of a part that follows lines
  is its drawn outline and holes, as points of its own (`copyOps`).
- Welding a crossing put the point far from it: on a straight stretch the sampled fraction is not the curve's
  parameter (a straight stretch is a cubic with its controls at its ends: 3t² − 2t³), now converted (`curveT`); and
  "at a point already there" is a distance (0.5 units), not a fraction of the stretch. A crossing through a vertex of
  the other line is found now (touching counts, found once).
- Undoing a rename renamed back shapes it had not renamed: `rename` returns the exact renames it did as its inverse,
  each with `alone: true` (no cascade).
- `aia fill` still recolored a filled gap with the one-part model: it now makes a shape like a click inside the gap
  in the editor (`<line>_fill` + `<line>_stroke`, shapes add up); colors change with a `set` op. `aia fill` and `aia
  shape` take `--id name`; a shape that does not close says where the picked stretches stop; `aia crossings --weld`
  with none says there is nothing to weld.
- Create Shape drops its picks when their layer is locked or hidden.
- One rule for "follows others" and "the lines it follows" (`followsOthers`, `followedLines` in `points.js`), used by
  `followStretch`, `stretchBetween`, the gap search, `partsToMove`, the rename cascade and the Inspector.
- Texts of earlier designs (decision 10, the plan's note, the build plan row, «Left for later», the `holes` help, the
  guide, the shortcuts table, dead Inspector branches and a dead line in `weld.js`).
Structure, after the push (2026-11-19):
- `server/aia.js` is split by topic: `server/aia.js` (≈80 lines) puts the commands together and runs one;
  `server/aia/common.js` has the errors, reading a command line, the answers and the helpers on the store
  (`createContext`); `documents.js`, `points.js`, `shapes.js` and `output.js` have the commands of each topic.
- `src/core/crossings.js` has `crossingsOf` and `weldCrossingOps` (out of `fill.js`, which gives it `lineStretches`);
  `fill.js` samples stretches with `geometry.js`'s `pointOnStretch` (the same cubic as `insertVertex`).
- `src/core/shapes.js` is the one place for elements and shapes: how a shape's parts are named (`shapePartName`,
  `shapePartOf`, `freeShapeSuffix`), which element a shape belongs to (`elementOf`), the shapes on an element
  (`shapesOf`, tested now) and what moves with a shape (`partsToMove`); `fill.js`, the `rename` cascade, the Inspector
  and `aia` use it.
- The Inspector's Element section lists the element's properties from the schema (so caps and joins will show by
  themselves); the Layers panel and the Inspector share one order helper (`orderObjects`).
- The tool's internal names follow its name: `'shape'`, `src/editor/shapeTool.js`, `shapeStyle` (kept under
  `aia.shapeStyle`, read from the old `aia.fillStyle` once).
