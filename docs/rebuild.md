# Rebuild

> Status: **under debate** (started 2026-11-16). The decisions below are agreed with the user; the rest of the
> topics are still open. Nothing of the current code is changed by this document.

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

## Open topics

1. **Purpose and priority:** the live character in apps as the design driver (the runtime as the contract), with
   Animate scenes for video as a secondary use? Or both at the same level?
2. **Document model:** drawing (mesh or not, regions), bones and binding, pose vs clip (one asset?), params and
   drivers.
3. **The command language itself:** which commands, their syntax, what replaces the sugars inside `set`.
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
| 2 | **Thin slice, end to end**, with simple shapes (rect, ellipse, path, group, styles): document, schema, operations, store with history and undo by origin, live notices, SVG/PNG render, a minimal runtime, the `aia` CLI with `help` and `guide <topic>`, the thin MCP (`aia(command)` + `render`) | keep: `geometry`, `curves`, `paths`, `render/svg`, `server/png`, `server/events`; rewrite: `document`, `schema`, `operations` (no sugars inside `set`), `server/store`, `guide` | topics 2 (the basics) and 3 |
| 3 | **Editor base**: canvas, Layers, an inspector generated from the schema, selection and transform, a console with the `aia` commands | rewrite: `editor/state`, `canvas`, `layers`, `inspector`, `transform` (small files, no global state) | topic 5 |
| 4 | **Drawing**: one drawing model, regions, Fill / Stroke | rewrite: `core/mesh`, `regions`, `meshTransform`; editor drawing tools | topic 2 |
| 5 | **Skeleton and binding** | rewrite: `core/skeleton`, `bindPoints`; `editor/bones` | topic 2 |
| 6 | **Animation**: poses and clips, params and drivers, the timeline | rewrite: `core/animation`, `blend`, `poseValues`; `editor/timeline`, `poses`, `parameters` | topic 2 |
| 7 | **Runtime and export**: `.aia` + the JS runtime for apps, the manifest, video and Lottie | rewrite: `core/live`, `manifest` | topics 1 and 6 |
| 8 | **Connect your AI and release**: Claude Desktop setup, installer, signing | keep: `server/aiClients`, `mcpStatus`, `aiRoutes`; `editor/connectAi` | — |
| End | `rebuild` replaces `main`; the old code stays in the tag `v1-final` | — | — |

Not brought over: the `painted` type and the coexisting drawing models, the 46 KB guide (replaced by
`aia guide <topic>`), the 20 MCP tools (replaced by `aia(command)` + `render`), the `.claude/agents/` written for
them (rewritten when the `aia` commands exist).

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
  layer transform, as Moho's Transform Layer, is still to be decided.)
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
