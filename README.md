<p align="center"><img src="public/logo.svg" alt="aia-studio" width="96" height="96" /></p>

# aia-studio

**A drawing, animation and character-building tool made for AI first.** An AI connected over MCP can draw, rig,
pose and animate anything (characters, objects, icons, scenes) with full control: every object, property, bone, pose
and keyframe is within its reach, and it checks its own work with rendered previews.

**The human comes second, but has the last word.** Everything the AI makes opens in a visual editor where a person
can see it live and change absolutely all of it by hand. A person can also start from scratch, but the tool was
designed the other way around: so the AI has complete control, and the human can always take over.

It takes the rigging ideas of **Moho** (bone layers, smart bones, switch layers), the runtime ideas of **Rive**
(clips, a declarative runtime) and the live puppet ideas of **Adobe Character Animator** (triggers, gestures over a
base, automatic blinking and breathing).

## Why HTML, CSS, JS and SVG

That choice is the point. A character made here is not locked inside a video or a proprietary player: it is plain
web technology.

- **Easy to integrate.** It drops into any web app or component (a UI, a mascot, an assistant's face) with no plugin
  or heavy runtime.
- **Easy to use.** Anyone who knows the web can style it, script it and debug it with the browser's own tools.
- **Full control for the AI.** SVG, CSS and JS are text the AI already reads and writes fluently, so it can drive the
  character down to the last detail, both while building it and live inside the app.

## How it works

- **The document is text.** Readable JSON with meaningful names (`head`, `mouth`, `happiness`), described by a schema
  that drives validation, the editor's inspector and the AI's guide.
- **One set of operations for both.** Every action in the editor is an operation of the same API the AI uses, in
  atomic batches that can be undone. Each side undoes its own changes, and the AI reads the history to respect the
  user's hand touch-ups.
- **High-level controls.** Poses, params and drivers move many things at once, so the AI works with `happiness: 0.8`
  instead of individual vertices.
- **Three modes.** **Design** (drawing and rig), **Animate** (scene timelines for export) and **Puppet** (poses,
  params and short clips that an app or its AI triggers live).

## What you can do today

- **Draw:** paths with the pen and point editing, rectangles, ellipses, groups, shared styles, linear and radial
  gradients, image layers (PNG, JPG, WebP, SVG) and SVG import.
- **Rig:** skeletons with bones (add, manipulate, reparent), drawing bound by layer or by point, and paths that bend
  along a chain of bones.
- **Expressions:** poses, params with drivers that blend them, and switch layers for variants such as mouths.
- **Animate:** scenes with a timeline, keyframes, named easing curves and loops.
- **Puppet live:** clips that play as a base or as gestures with fades, automatic layers such as blinking and
  breathing, and a manifest that tells an app's AI which controls the character has.
- **Work alongside the AI:** both edit the same files live, with per-side undo and a shared history; layers can be
  locked so neither touches them by accident.

Not yet: exporting the character for use inside other apps (a JS runtime, video and other formats) is the next step.

## Getting started

```bash
npm install
npm run dev        # editor at http://localhost:5173
npm test           # tests
npm run typecheck  # type check (tsc over JS with JSDoc)
```

Documents live in `documents/<id>/` (ignored by git).

## Connect your AI

The AI you already use drives the documents through a local MCP server, `mcp/server.js`, over stdio (no API key). It
works on the same files as the editor, so what the AI does shows up live in the browser.

- **Claude Code:** already configured in [.mcp.json](.mcp.json); approve it when you open the folder.
- **Claude Desktop and other MCP clients:** add a server with the command `node <path-to>/aia-studio/mcp/server.js`.

The AI starts with the `get_guide` tool, which explains the format and every tool.

## Project layout

| Folder | Contents |
| --- | --- |
| `schema/` | Definition of each type: the single source for validation, inspector and AI guide. |
| `src/core/` | Document, operations, skeleton, animation and live runtime (no DOM; browser and Node). |
| `src/render/` | SVG renderer. |
| `src/editor/` | The visual editor. |
| `server/` | Disk storage, history and the local API (Vite plugin). |
| `mcp/` | MCP server for the AI. |
| `tests/` | Tests (`node --test`). |

## Documentation

- [docs/decision-animacion.md](docs/decision-animacion.md): the Design, Animate and Puppet modes and the clip model.
- [docs/sintesis.md](docs/sintesis.md): what aia-studio takes from Moho and Rive (research in `docs/investigacion/`).

## Credits

aia-studio is built by two, working together:

- **[pederseo-dev](https://github.com/pederseo-dev)**: the idea, the product vision and direction, design decisions
  and hands-on testing in the editor.
- **Claude** (Anthropic, through Claude Code): architecture, code, tests, audits and the AI tests of each phase,
  as a development partner. Commits it co-wrote carry `Co-Authored-By: Claude`.

The rigging, runtime and live puppet ideas come from studying Moho, Rive and Adobe Character Animator; aia-studio is
not affiliated with any of them.
