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
