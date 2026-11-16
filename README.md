<p align="center"><img src="public/logo.svg" alt="aia-studio" width="96" height="96" /></p>

# aia-studio

**A 2D drawing, animation and character tool made for AI first.** An AI can draw, rig, pose and animate anything
(characters, objects, icons, scenes) with full control over every part, and check its own work with rendered
previews.

**The human comes second, but has the last word.** Everything the AI makes opens in a visual editor where a person
sees it live and can change all of it by hand.

> **Status: rebuild in progress.** This branch rebuilds aia-studio from scratch, in parts. Only the base is here so
> far: the desktop app shell, the local server and an empty editor. The decisions and open topics are in
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
on the same documents folder as the editor, so what the AI does shows up live. Not built yet: see
[docs/rebuild.md](docs/rebuild.md).

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
| `server/` | The local server on `127.0.0.1` (and the same API inside Vite in development), the documents folder. |
| `src/editor/` | The visual editor (plain JS, built with Vite). Empty for now. |
| `tests/` | Tests (`node --test`). |
| `docs/` | [rebuild.md](docs/rebuild.md) and, in [docs/v1/](docs/v1/), the records and design docs of the previous version. |

Planned, once their design is decided: `src/core/` (document model and operations, no DOM), the `aia` command
language with its CLI and MCP, the renderer and the runtime.

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
