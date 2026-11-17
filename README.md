<p align="center"><img src="public/logo.svg" alt="aia-studio" width="96" height="96" /></p>

# aia-studio

**A 2D drawing, animation and character tool made for AI first.** An AI can draw, rig, pose and animate anything
(characters, objects, icons, scenes) with full control over every part, and check its own work with rendered
previews.

**The human comes second, but has the last word.** Everything the AI makes opens in a visual editor where a person
sees it live and can change all of it by hand.

> **Status: rebuild in progress.** This branch rebuilds aia-studio from scratch, in parts. Here so far: the desktop
> app shell and local server; Design mode (vector layers with paths, named and shared points, followed curves, point
> groups, layer transforms, the Pen, Rectangle and Ellipse, point editing, a live Document JSON panel); the `aia`
> command language with its CLI and a thin MCP; rendered previews; and a minimal runtime that exported pages carry.
> Animation, bones and the final export format are still to come. The decisions and open topics are in
> [docs/rebuild.md](docs/rebuild.md). The previous version stays on `main` until this one replaces it.

## Why HTML, CSS, JS and SVG

A character made here is not locked inside a video or a proprietary player: it is plain web technology.

- **Easy to integrate.** It drops into any web app (a UI, a mascot, an assistant's face) with no plugin or heavy
  runtime.
- **Easy to use.** Anyone who knows the web can style it, script it and debug it with the browser's own tools.
- **Full control for the AI.** SVG, CSS and JS are text the AI already reads and writes fluently, so it can drive the
  character down to the last detail, both while building it and live inside an app.

## How the AI will drive it

One command language, `aia`, defined once: agents with a terminal (Claude Code, Cursor, Codex) run `aia …` as a
CLI, and clients without one (the Claude Desktop chat) reach the same commands through a thin MCP server. Both work
on the same documents folder as the editor, so what the AI does shows up live. A first cut is here (decision 9 in
[docs/rebuild.md](docs/rebuild.md)):

```bash
npm run aia -- help                 # the commands (or `node bin/aia.js help`; `aia` once installed with npm link)
npm run aia -- guide start          # how documents work
npm run aia -- ops face '[{"op":"create","type":"vector","id":"head"}]'
npm run aia -- render face --out face.png
npm run aia -- export face --format html --out face.html   # a page that plays it, with the runtime inside
```

The MCP server for chats without a terminal is `node mcp/server.js` (stdio, two tools: `aia` and `render`); the
repo's `.mcp.json` registers it for Claude Code.

## From source

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev        # the editor at http://localhost:5173
npm test           # tests (node --test)
npm run typecheck  # type check (tsc over JS with JSDoc)
npm run app        # the desktop app from the repo (Electron)
npm run dist:win   # the Windows installer, into release/
```

Documents live in the repo's `documents/` folder (ignored by git) when run from source, and in
`%APPDATA%\aia-studio\documents` when installed. `--documents <folder>` or the `AIA_DOCUMENTS` environment variable
choose another one.

## Project layout

| Folder | Contents |
| --- | --- |
| `electron/` | The desktop app's main process: single instance, the window, the local server. |
| `schema/` | Each type and its properties: the single source for validation, the editor and the AI's help. |
| `src/core/` | Document and operations (no DOM; the same in the browser and in Node). |
| `src/runtime/` | The runtime: plays a document in any web page, with no dependencies (the export carries it). |
| `bin/`, `mcp/` | The `aia` CLI and the thin MCP server, both over the interpreter in `server/aia.js`. |
| `server/` | The local server on `127.0.0.1` (and the same API inside Vite in development), the documents on disk with their history, the documents folder. |
| `src/editor/` | The visual editor (plain JS, built with Vite): Design mode with Layers, the canvas tools, the Inspector and the Document JSON panel. |
| `tests/` | Tests (`node --test`). |
| `docs/` | [rebuild.md](docs/rebuild.md) and, in [docs/v1/](docs/v1/), the records and design docs of the previous version. |

Planned, once their design is decided: animation (poses, clips, parameters), bones and binding, the `.aia`
format and the other exports (video, Lottie), and `aia open` to open the editor from the AI's side.

## Credits

aia-studio is built by two, working together:

- **[pederseo-dev](https://github.com/pederseo-dev)**: the idea, the product vision and direction, design decisions
  and hands-on testing.
- **Claude** (Anthropic, through Claude Code): architecture, code, tests and audits, as a development partner.
  Commits it co-wrote carry `Co-Authored-By: Claude`.

The rigging, runtime and live puppet ideas come from studying Moho, Rive and Adobe Character Animator; aia-studio is
not affiliated with any of them.

## Security

aia-studio is a local tool: its server only listens on your own computer. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The code is free to use, change and build into your own apps, commercial ones included. What you
draw and animate with aia-studio is yours.
