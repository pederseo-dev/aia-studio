#!/usr/bin/env node
// aia-studio MCP server: lets the AI the user already uses (Claude Desktop, Claude Code, Cursor...)
// handle the documents. Runs locally over stdio, without API keys. Works on the same files as the editor,
// so changes show live in the editor (the desktop app or `npm run dev`).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { findObject } from '../src/core/document.js';
import { opsToSetPose } from '../src/core/blend.js';
import { resolveValues } from '../src/core/poseValues.js';
import { guideForAI } from '../src/core/guide.js';
import { summarizeOperations } from '../src/core/operations.js';
import { DOCUMENTS_FOLDER, createStore } from '../server/store.js';
import { markRunning } from '../server/mcpStatus.js';
import { loadSchema } from '../server/schema.js';
import { NO_PREVIEW, svgToPng } from '../server/png.js';
import { CURVE_NAMES } from '../src/core/curves.js';
import { rotationWarnings, planDeleteKeys, planMoveKeys, planScaleTime, planSetKeys, clipSummary } from './animation.js';
import { manifest, manifestText } from '../src/core/manifest.js';
import { usedAssets, assetMime } from '../src/core/images.js';
import { imageBytes, addImage, checkDeleted, treeOutline as tree,planBindByProximity, planBindPoints, planReparentBone, planPreview, poseClamps, historySummary, documentText } from './tools.js';

// The same version as the editor: in the desktop app both come from the same package.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const schema = loadSchema();
const store = createStore({ schema });
const ORIGIN = 'ai';

const server = new McpServer(
  { name: 'aia-studio', version: VERSION },
  {
    instructions:
      'aia-studio is a 2D vector animation editor (characters, objects, icons, scenes). Before creating or modifying a document, read get_guide. ' +
      'Before editing an existing one, look at get_history: entries with origin "user" are the user\'s manual touch-ups ' +
      'and must not be overwritten. After visible changes, check the result with render_preview.',
  },
);

const treeOutline = (doc, options) => tree(doc, schema, options);
// After a change, the tree goes without the clips' tracks (with many clips it was thousands of lines in each
// response): get_document gives them whole or for the requested clips.
const shortTree = (doc) => `${treeOutline(doc, { tracks: false })}\n(Clips summarized: their tracks, with get_document and clips.)`;

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

// Errors come back as a result and not as an exception, so the AI reads them and fixes the batch.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

const id = z.string().describe('document id, for example "robot"');
const target = z.string().describe('object id, or "meta" for the document properties');
const props = z.record(z.string(), z.any()).describe('{ property: value }; see get_guide');
const operation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    type: z.string().describe('object type: ' + [...schema.types.keys()].join(', ')),
    id: z.string().describe('new id: lowercase, digits and _'),
    parent: z.string().nullable().optional().describe('id of the parent container (group, switch or skeleton); a bone goes inside a skeleton or another bone; omitted or null = root'),
    index: z.number().int().optional().describe('position among siblings: 0 = at the back; omitted = at the front'),
    props: props.optional(),
  }),
  z.object({ op: z.literal('set'), target: target, props }),
  z.object({ op: z.literal('unset'), target: target, props: z.array(z.string()).describe('properties that go back to their default value') }),
  z.object({ op: z.literal('delete'), target: z.string().describe('object id; also deletes its children'), keepCurves: z.boolean().optional().describe('a shape: true leaves its curves in the layer (to fill again), instead of taking along the ones no other shape uses') }),
  z.object({
    op: z.literal('move'),
    target: z.string(),
    parent: z.string().nullable().optional().describe('new parent; omitted = the same; null = root'),
    index: z.number().int().optional().describe('position among siblings: 0 = at the back; omitted = at the front'),
    keepPosition: z.boolean().optional().describe('true = recomputes x/y so it stays in the same place on screen with the new parent (not for bones: use reparent_bone)'),
  }),
  z.object({ op: z.literal('rename'), target: z.string(), id: z.string().describe('new id') }),
  z.object({
    op: z.literal('duplicate'),
    target: z.string().describe('object to copy, with all its children'),
    id: z.string().optional().describe('id of the copy; by default <target>_<suffix>'),
    suffix: z.string().optional().describe('suffix for the ids of the copied children (by default "copy")'),
    parent: z.string().nullable().optional().describe('parent of the copy; omitted = the same as the original'),
    index: z.number().int().optional().describe('position among siblings; omitted = right in front of the original'),
    props: props.optional().describe('properties to change in the copy, for example { "x": 40 }'),
  }),
]);

server.registerTool(
  'get_guide',
  { description: 'Format guide: conventions, object types with all their properties, and operations. Read it before editing.' },
  safe(async () => text(guideForAI(schema))),
);

server.registerTool(
  'list_documents',
  { description: 'Lists the available documents.' },
  safe(async () => text(await store.list())),
);

server.registerTool(
  'get_document',
  {
    description:
      'Returns a document: first its object tree (each clip with its tracks and keyframes), then the full ' +
      'JSON. For a large document, ask for json: false and, with clips, only the tracks of the clips you care about.',
    inputSchema: {
      id,
      json: z.boolean().optional().describe('false = only the tree. Included by default, unless the response exceeds 60 000 characters'),
      clips: z.array(z.string()).optional().describe('ids of clips whose tracks are listed in the tree (by default, all; [] = none)'),
    },
  },
  safe(async ({ id, json, clips }) => {
    const doc = await store.read(id);
    return text(documentText(doc, schema, { json, clips, assets: await store.assetsInfo(id, doc) }));
  }),
);

server.registerTool(
  'create_document',
  {
    description: 'Creates an empty document or, with copy_from, a copy of another document (without its history).',
    inputSchema: {
      id,
      name: z.string().optional().describe('visible name'),
      width: z.number().optional().describe('canvas width in px (default 800)'),
      height: z.number().optional().describe('canvas height in px (default 800)'),
      background: z.string().nullable().optional().describe('background color "#rrggbb"; null = transparent'),
      copy_from: z.string().optional().describe('id of an existing document to copy its objects from'),
    },
  },
  safe(async ({ id, name, width, height, background, copy_from }) => {
    const meta = Object.fromEntries(Object.entries({ name, width, height, background }).filter(([, v]) => v !== undefined));
    const doc = await store.create(id, meta, { origin: ORIGIN, copyFrom: copy_from });
    return text(`Document "${id}" created${copy_from ? ` as a copy of "${copy_from}"` : ''}.\n\nTree:\n${shortTree(doc)}`);
  }),
);

server.registerTool(
  'apply_ops',
  {
    description:
      'Applies an atomic batch of operations (create, set, unset, delete, move, rename, duplicate). If anything fails, ' +
      'nothing is applied and the errors are returned. Each batch is one undo step.',
    inputSchema: {
      id,
      ops: z.array(operation).min(1),
      note: z.string().describe('what the batch does, in a few words (stays in the history the user sees)'),
    },
  },
  safe(async ({ id, ops, note }) => {
    const { doc, warnings } = await store.applyOps(id, ops, { origin: ORIGIN, note: note });
    const parts = [`Applied ${ops.length} operations.`];
    if (warnings.length) parts.push(`Warnings:\n${warnings.map((a) => `- ${a}`).join('\n')}`);
    parts.push(`Resulting tree (back to front):\n${shortTree(doc)}`);
    return text(parts.join('\n\n'));
  }),
);

const revert = (kind) =>
  safe(async ({ id }) => {
    const { doc, in: entry } = await store[kind](id, ORIGIN);
    const verb = kind === 'undo' ? 'Undid' : 'Redid';
    const touched = summarizeOperations(entry.batch).slice(0, 12).join(', ');
    const follows = kind === 'undo' ? ' The earlier batches still stand.' : '';
    return text(`${verb} batch #${entry.n} "${entry.note}" (${entry.ops} operations: ${touched}).${follows}\n\nResulting tree:\n${shortTree(doc)}`);
  });

server.registerTool(
  'undo',
  {
    description:
      'Undoes your last batch (only the AI\'s; never the user\'s touch-ups) and says which one it undid. If the user ' +
      'later changed any of the same properties, it refuses and says which ones and in which batch: undoing would overwrite their touch-up.',
    inputSchema: { id },
  },
  revert('undo'),
);

server.registerTool(
  'redo',
  { description: 'Redoes your last undone batch and says which one it redid. Like undo, it refuses if the user later changed the same thing.', inputSchema: { id } },
  revert('redo'),
);

server.registerTool(
  'get_history',
  {
    description:
      'Latest changes to the document, from oldest to newest. By default a summary: origin ("ai" or ' +
      '"user"), note and which properties or objects each batch touched. Those with origin "user" are manual touch-ups: respect them.',
    inputSchema: {
      id,
      limit: z.number().int().min(1).max(200).optional().describe('how many batches (default 20)'),
      origin: z.enum(['ai', 'user']).optional().describe('only the batches with that origin'),
      detail: z.boolean().optional().describe('true = include the full operations of each batch'),
    },
  },
  safe(async ({ id, limit, origin, detail }) => {
    const { entries } = await store.history(id, 1000);
    return text(historySummary(entries, { limit, origin, detail }));
  }),
);

const region = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .describe('crop of the document, in its coordinates (to see a detail up close)');

/** PNG of the document (posed, animated, live or cropped) as a tool result: the SVG and the text come from the plan. */
async function preview(id, doc, options, header) {
  const { svg, width, text: summary } = planPreview(doc, schema, options);
  // Image layers are drawn with the files from assets/; those that lack it are not shown and a warning is given.
  const images = await store.imagesOf(id, doc);
  const missing = usedAssets(doc).filter((src) => !images.has(src));
  const png = svgToPng(svg, options.width ?? width, images);
  const withoutView = [...images.keys()].filter((src) => NO_PREVIEW.has(assetMime(src)));
  let note = missing.length ? `\nMissing in assets/ (those image layers don't show): ${missing.join(', ')}. Add them with add_image.` : '';
  if (withoutView.length) note += `\n${withoutView.join(', ')}: WebP, which this preview can't draw; it shows as a gray box with a cross at its place and size (the user sees it fine in the editor).`;
  return {
    content: [
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: (header ? `${header}\n${summary}` : summary) + note },
    ],
  };
}

server.registerTool(
  'add_image',
  {
    description:
      'Adds an image (PNG, JPG, WebP or SVG) as a layer: copies the file to the document\'s assets/ folder, creates ' +
      'an image object that uses it, and returns how it looks. By default it is centered on the canvas, at its natural size ' +
      '(shrunk if it doesn\'t fit). An SVG comes in as a whole image (its shapes are not editable). With replace, ' +
      'changes the file of an existing image layer instead (keeps its width, the height follows the new proportion). ' +
      'To reuse a file already in assets/ (get_document lists them with their size), use apply_ops with its src.',
    inputSchema: {
      id,
      path: z.string().optional().describe('absolute path of a local file the user gave'),
      url: z.string().optional().describe('or an http(s) URL of the image'),
      layer: z.string().optional().describe('id of the new layer (by default, taken from the file name)'),
      replace: z.string().optional().describe('id of an existing image layer whose file is changed (no new layer is created; layer, parent, index, x, y, width and height are ignored)'),
      parent: z.string().nullable().optional().describe('parent container (group, switch or skeleton); omitted = root'),
      index: z.number().int().optional().describe('position among siblings: 0 = at the back; omitted = at the front'),
      x: z.number().optional().describe('x of the center (of the pivot), relative to the parent; by default, the center of the canvas'),
      y: z.number().optional().describe('y of the center, relative to the parent'),
      width: z.number().positive().optional().describe('width in px; width alone = height in proportion'),
      height: z.number().positive().optional().describe('height in px; height alone = width in proportion'),
      props: props.optional().describe('other properties of the layer, for example { "opacity": 0.5, "originY": 1 }'),
      note: z.string().optional().describe('what it is, for the history'),
    },
  },
  safe(async ({ id, path, url, layer, replace, parent, index, x, y, width, height, props: extra, note }) => {
    const { bytes, name } = await imageBytes({ path, url });
    const { layerId, doc, warnings, src, naturalWidth, naturalHeight, format, reused } = await addImage(store, schema, id, { bytes, name, layer, replace, parent, index, x, y, width, height, props: extra }, { origin: ORIGIN, note });
    const o = findObject(doc, layerId);
    const file = `${src} (${format.toUpperCase()}, ${naturalWidth}×${naturalHeight} px${reused ? ', already in assets/' : ''})`;
    return preview(id, doc, {}, `Image layer "${layerId}" with ${file}: x ${o.x}, y ${o.y}, ${o.width}×${o.height}.${warnings.length ? `\nWarnings: ${warnings.join('; ')}` : ''}`);
  }),
);

server.registerTool(
  'render_preview',
  {
    description:
      'Returns a PNG image of the document as the user sees it. Use it to check your changes. With pose, ' +
      'shows that pose alone; with params, the blend of poses the drivers give with those values; with region, a ' +
      'crop to see a detail; with bones, the skeleton on top. With animation, a clip: time = one frame; times (or ' +
      'nothing) = a strip of frames in a single image, to see the motion (by default, at the times of its keyframes). ' +
      'With live, a live script as the app would run it (play, stop, set on the Puppet clips, with fades, ' +
      'gestures on top of the base, and the auto layers): times = the frames of the strip; params = the app\'s initial values.',
    inputSchema: {
      id,
      width: z.number().int().min(64).max(2048).optional().describe('image width in px (default 600)'),
      pose: z.string().optional().describe('id of a pose of the document; omitted = the setup'),
      params: z
        .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
        .optional()
        .describe('{ param_id: value } to see the blend (missing ones use their initial value; {} = all initial)'),
      region: region.optional(),
      bones: z.boolean().optional().describe('true = draw the bones on top, with their id (in the editor they are always visible)'),
      curves: z.boolean().optional().describe('true = also draw the curves no shape uses yet, as thin gray lines (as the editor shows them; exports leave them out)'),
      animation: z.string().optional().describe('id of a clip (animation): shows the clip at time, or a strip of frames at times; in a puppet clip, params are added on top (a scene is shown without params or drivers and rejects them)'),
      time: z.number().min(0).optional().describe('with animation: a single frame, in seconds'),
      times: z.array(z.number().min(0)).max(24).optional().describe('with animation: times of the frame strip, in seconds (by default, those of its keyframes); with live, the frames of the script (by default every 0.25 s)'),
      live: z
        .array(
          z.object({
            t: z.number().min(0).describe('seconds from the start'),
            play: z.string().optional().describe('id of a Puppet clip: a loop one becomes the base; a once one is a gesture on top'),
            stop: z.union([z.string(), z.literal(true)]).optional().describe('id of a clip that leaves with its fade, or true for all'),
            set: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('{ param_id: value } the app sets'),
          }),
        )
        .optional()
        .describe('live script: events with t and one of play, stop or set; for example [{ "t": 0, "play": "idle" }, { "t": 0.5, "play": "wave" }, { "t": 1, "set": { "happiness": 1 } }]. Doesn\'t go with animation or pose. The randomness of auto repeat uses a fixed seed: the same script gives the same strip'),
      until: z.number().positive().optional().describe('with live: up to which second to draw the strip (by default, until the last triggered gesture ends); at most 24 frames, spread out'),
      auto: z.boolean().optional().describe('with live: false turns off the auto layers (blinking, breathing) to compare'),
    },
  },
  safe(async ({ id, ...options }) => preview(id, await store.read(id), options)),
);

server.registerTool(
  'bind_points',
  {
    description:
      'Bind by point: each point of a vector layer (or vertex of a path) follows the closest bone (in the setup) from the ' +
      'given list, or from all those of the skeleton containing it. That way a single drawing bends with a chain of bones ' +
      '(tail, arm, neck). Each point gets a "bone". To bind only some points of a vector layer (as the editor\'s Bind ' +
      'Points), pass points or shape; with a single bone in bones they all follow it: { "path": "face", "shape": "jaw", ' +
      '"bones": ["jaw_bone"] }. release: true takes the bone off those points instead.',
    inputSchema: {
      id,
      path: z.string().describe('id of the vector layer (or path)'),
      bones: z.array(z.string()).optional().describe('bones of its skeleton to distribute among (by default, all of its skeleton); one bone = all the points follow it'),
      points: z.array(z.string()).optional().describe('only these points of the vector layer (ids, as the tree lists them)'),
      shape: z.string().optional().describe('only the points of this shape of the vector layer'),
      release: z.boolean().optional().describe('true = those points stop following bones (they follow the layer)'),
      note: z.string().optional().describe('what it does, for the history'),
    },
  },
  safe(async ({ id, path, bones, points, shape, release, note }) => {
    const { ops, distribution } = planBindPoints(await store.read(id), schema, path, bones, { points, shape, release });
    await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `distribute ${path} among bones` });
    return text(`Points of ${path} per bone: ${distribution}. Check it with render_preview and a pose.`);
  }),
);

server.registerTool(
  'bind_by_proximity',
  {
    description:
      'Bind all by proximity: binds (per layer) to the closest bone all the skeleton\'s drawing that doesn\'t follow ' +
      'any bone yet. It chooses by the center of each piece\'s bounding box, in the setup. It binds whole pieces: a group ' +
      'with nothing bound inside goes whole; if something inside is already bound, it binds only what is missing. It doesn\'t touch what is already ' +
      'bound (nor paths bound by point). It moves nothing: it only shows in the poses. Review the ' +
      'distribution it returns and fix with set whatever landed on the wrong bone.',
    inputSchema: {
      id,
      skeleton: z.string().describe('id of the skeleton'),
      note: z.string().optional().describe('what it does, for the history'),
    },
  },
  safe(async ({ id, skeleton, note }) => {
    const { ops, bindings, distribution } = planBindByProximity(await store.read(id), schema, skeleton);
    if (!ops.length) return text(`All the drawing of ${skeleton} already follows a bone; there was nothing to bind.`);
    await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `bind all by proximity in ${skeleton}` });
    return text(`Bound ${bindings.length}: ${distribution}. Check it with render_preview and a pose (bones: true).`);
  }),
);

server.registerTool(
  'reparent_bone',
  {
    description:
      'Changes the parent of a bone without moving it in the setup: its x, y, rotation (and scale and limits) are recomputed ' +
      'in the frame of the new parent, and so are the values the poses set on it. The parent can be another bone of the ' +
      'same skeleton or the skeleton itself (to make it a root bone). Its children follow it as always. Use this ' +
      'instead of move, which keeps the relative values and so shifts the bone. Careful: in a pose that ' +
      'moves the old parent (or an ancestor the new one doesn\'t share) or the new parent, the bone does change place, ' +
      'because it now follows another one; the response lists those poses. With keep_in_poses: true, those ' +
      'poses are also adjusted so it stays where it was.',
    inputSchema: {
      id,
      bone: z.string().describe('id of the bone that changes parent'),
      parent: z.string().describe('id of the new parent bone, or of the skeleton to make it a root'),
      keep_in_poses: z.boolean().optional().describe('true = sets in the affected poses the values that keep it where it was (by default, only warns)'),
      note: z.string().optional().describe('what it does, for the history'),
    },
  },
  safe(async ({ id, bone, parent, keep_in_poses, note }) => {
    const plan = planReparentBone(await store.read(id), schema, bone, parent, keep_in_poses);
    if (!plan.ops.length) return text(plan.text);
    const { doc } = await store.applyOps(id, plan.ops, { origin: ORIGIN, note: note ?? `reparent ${bone} to ${parent}` });
    const h = findObject(doc, bone);
    return text(`${plan.text} (x ${h.x}, y ${h.y}, rotation ${h.rotation})`);
  }),
);

server.registerTool(
  'set_pose',
  {
    description:
      'Creates or updates a named pose (pose asset) without touching the setup, and returns how it looks. A pose sets ' +
      'animatable properties of any object: bones, vertices of a mouth (also with "d"), colors, opacity, ' +
      'the active child of a switch, points of a vector layer... By default it adds to what the pose already had (a vector ' +
      'layer\'s points and curves, point by point); an object with {} leaves the pose entirely; remove takes out only some ' +
      'properties (["mouth.active"], or one point: "face.points.p3") without touching the rest of that object. A number ' +
      'can be relative to the setup ("+=14", "-=0.3"), and a vector layer takes transformPoints (relative to the setup).',
    inputSchema: {
      id,
      pose: z.string().describe('id of the pose, for example "happy", "look_up" or "viseme_o"'),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .optional()
        .describe('{ object_id: { property: value } }, for example { "head_bone": { "rotation": "-=10" }, "mouth": { "active": "mouth_o" }, "face": { "transformPoints": { "shape": "lid_l", "scale": [1, 0.1] } } }'),
      replace: z.boolean().optional().describe('true = the pose keeps only these values'),
      remove: z
        .array(z.string())
        .optional()
        .describe('properties that leave the pose, as "object.property" (for example "mouth.active") or one point or curve of a vector layer ("face.points.p3"); an id alone takes out the whole object. Applied before values'),
      note: z.string().optional().describe('what it does, for the history'),
      width: z.number().int().min(64).max(2048).optional().describe('width of the preview'),
      show_bones: z.boolean().optional().describe('true = the preview shows the skeleton'),
    },
  },
  safe(async ({ id, pose, values, replace, remove, note, width, show_bones }) => {
    const current = await store.read(id);
    const ops = opsToSetPose(current, pose, resolveValues(current, schema, values ?? {}, `values`), replace, remove ?? []);
    const { doc, warnings } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `pose ${pose}` });
    const saved = findObject(doc, pose).values;
    const list = Object.entries(saved).map(([h, c]) => `${h} ${JSON.stringify(c, (k, v) => (k === 'vertices' ? `(${v.length} vertices)` : v))}`).join(', ') || 'empty';
    const notes = [...warnings, ...poseClamps(doc, schema, saved)];
    return preview(id, doc, { width, pose, bones: show_bones }, `Pose "${pose}": ${list}.${notes.length ? `\nWarnings: ${notes.join('; ')}` : ''}`);
  }),
);

const moment = z.object({
  t: z.number().min(0).describe('time in seconds'),
  values: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional()
    .describe('{ object_id: { property: value } } absolute, as in set_pose (a path accepts "d"); for example { "arm_r_bone": { "rotation": -60 }, "tail": { "opacity": 0.5 } }. A number can be relative to the setup with a text "+=n" or "-=n": { "head_bone": { "rotation": "+=14" } } = 14° more than in the setup. A vector layer takes transformPoints, relative to the setup: { "face": { "transformPoints": { "shape": "mouth", "scale": [1, 1.4] } } }. In a puppet clip, if a param chooses a variant (visemes), animate the param in params and not the switch\'s active; in a scene (animate), key the active'),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('only in a puppet clip: { param_id: value } at that moment, for example { "happiness": 1, "viseme": "o" }; its drivers add the poses. A scene (animate) doesn\'t animate params nor has drivers: copy the pose with pose or key the values'),
  pose: z.string().optional().describe('id of a pose: copies its values as keyframes at that moment (values overrides them); with only or except, just a part'),
  only: z.array(z.string()).optional().describe('with pose: copy only this from the pose ("object.property" or an id), for example ["eye_l", "eye_r", "mouth.active"]'),
  except: z.array(z.string()).optional().describe('with pose: copy everything but this ("object.property" or an id), for example ["tail_bone"]'),
  setup: z.boolean().optional().describe('true = at that moment, everything the clip animates (and what pose sets, if you pass it) goes back to the setup value, and in puppet its params to the initial one; values overrides them. Useful to start and end at rest'),
  targets: z.array(z.string()).optional().describe('with a moment that only brings ease: which tracks to change the curve of ("object.property" or an id); by default, all those with a keyframe at that t'),
  ease: z
    .union([z.enum(CURVE_NAMES), z.array(z.number()).length(4)])
    .optional()
    .describe('curve of the span that LEAVES these keyframes toward the next ones: linear (default), step, ease-in, ease-out, ease-in-out, the strong ones (ease-in-quad, -cubic, -expo, -back and their -out and -in-out; the guide says what each does) or [x1, y1, x2, y2] (CSS cubic-bezier). A moment with only t and ease changes the curve of the keyframes already at that t, without touching their values'),
});

server.registerTool(
  'set_keys',
  {
    description:
      'Creates or updates an animation clip (animation asset) thinking in moments: at each t, how the ' +
      'character is (values, as in set_pose), which pose it takes (pose) or, only in a puppet clip, what value the ' +
      'params have (params). A scene (animate) is shown without params or drivers: setup + keyframes; there an expression is ' +
      'copied with pose and a variant is chosen by keying the switch\'s active. Each ' +
      'property becomes a keyframe at that time; one that already existed at the same t is replaced. Creates the clip if it doesn\'t ' +
      'exist and extends duration if a keyframe goes past it. Only changes the tracks you name: the others (also the ' +
      'user\'s touch-ups) stay as they were, and undo goes per track. To lengthen a clip, duration is enough. ' +
      'Returns a frame strip of the clip. usage: "puppet" for ' +
      'the puppet\'s clips (wave, blink, idle; write description), "animate" for a scene timeline. ' +
      'In puppet, fade, next, blend and auto say how it plays live (see get_guide and render_preview with live).',
    inputSchema: {
      id,
      animation: z.string().describe('id of the clip, for example "wave", "blink" or "idle"'),
      keys: z.array(moment).optional().describe('the moments, in any order'),
      usage: z.enum(['animate', 'puppet']).optional().describe('when creating, "animate" by default'),
      duration: z.number().positive().optional().describe('duration in seconds'),
      loop: z.enum(['once', 'loop', 'pingpong']).optional(),
      description: z.string().optional().describe('what the clip does (for the app\'s AI that triggers it)'),
      fade: z.number().min(0).optional().describe('puppet only: seconds of the fade when entering and leaving live (default 0.2; 0 = instant, like a blink)'),
      next: z.string().nullable().optional().describe('puppet only, once clip: the clip triggered when this one starts leaving (surprised → idle); null removes it'),
      blend: z.enum(['override', 'additive']).optional().describe('puppet only: override (default) overrides what is below; additive adds its difference from the setup (breathing)'),
      auto: z.enum(['off', 'repeat', 'always']).optional().describe('puppet only: off (the app triggers it), repeat (by itself, every repeat_min…repeat_max s: blinking) or always (always looping: breathing)'),
      repeat_min: z.number().min(0).optional().describe('with auto repeat: minimum wait in seconds (default 2)'),
      repeat_max: z.number().min(0).optional().describe('with auto repeat: maximum wait in seconds (default 6)'),
      remove: z.array(z.string()).optional().describe('tracks that leave the clip before adding: "object.property" or an id (all those of that object)'),
      note: z.string().optional().describe('what it does, for the history'),
      width: z.number().int().min(64).max(2048).optional().describe('width of the preview'),
      show_bones: z.boolean().optional().describe('true = the preview shows the skeleton'),
    },
  },
  safe(async ({ id, animation, keys, usage, duration, loop, description, remove, note, width, show_bones, ...live }) => {
    const plan = planSetKeys(await store.read(id), schema, animation, { keys, usage, duration, loop, description, remove, ...live });
    const { doc, warnings } = await store.applyOps(id, plan.ops, { origin: ORIGIN, note: note ?? `animation ${animation}` });
    const notes = [...warnings];
    notes.push(...plan.warnings);
    if (plan.extendedFrom != null) notes.push(`duration went from ${plan.extendedFrom} to ${plan.duration} s so the keyframes fit`);
    notes.push(...rotationWarnings(doc, schema, findObject(doc, animation)));
    // The clip view already lists which poses each animated param moves (planClipView).
    return preview(id, doc, { width, animation, bones: show_bones }, notes.length ? `Warnings: ${notes.join('; ')}` : '');
  }),
);

server.registerTool(
  'delete_keys',
  {
    description:
      'Removes keyframes from a clip: those at certain times (times), those of certain tracks (targets: "object.property" or ' +
      'an id) or both at once (those tracks at those times). Without times, the chosen tracks are removed whole.',
    inputSchema: {
      id,
      animation: z.string().describe('id of the clip'),
      times: z.array(z.number().min(0)).optional().describe('times in seconds (1 ms tolerance)'),
      targets: z.array(z.string()).optional().describe('tracks: "object.property" or an object id'),
      note: z.string().optional().describe('what it does, for the history'),
    },
  },
  safe(async ({ id, animation, times, targets, note }) => {
    const { ops, removed } = planDeleteKeys(await store.read(id), animation, { times, targets });
    if (!ops.length) return text(`There were no keyframes to remove in "${animation}" with those times and tracks.`);
    const { doc } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `delete keys in ${animation}` });
    return text(`Removed ${removed} keyframes. ${animation}: ${clipSummary(schema, findObject(doc, animation))}.`);
  }),
);

server.registerTool(
  'move_keys',
  {
    description:
      'Moves in time the keyframes of one moment of a clip (from → to), with their value and curve: on all the ' +
      'tracks that have a keyframe at from, or only on targets. Fails if to already has a keyframe on any of those ' +
      'tracks (it would delete it) or if to goes past the duration (lengthen it first with set_keys and duration).',
    inputSchema: {
      id,
      animation: z.string().describe('id of the clip'),
      from: z.number().min(0).describe('current time of the keyframes, in seconds (1 ms tolerance)'),
      to: z.number().min(0).describe('new time, in seconds'),
      targets: z.array(z.string()).optional().describe('tracks: "object.property" or an object id (by default, all those with a keyframe at from)'),
      note: z.string().optional().describe('what it does, for the history'),
      width: z.number().int().min(64).max(2048).optional().describe('width of the preview'),
    },
  },
  safe(async ({ id, animation, from, to, targets, note, width }) => {
    const { ops, moved } = planMoveKeys(await store.read(id), schema, animation, { from, to, targets });
    const { doc } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `move keys in ${animation} ${from} → ${to} s` });
    return preview(id, doc, { width, animation }, `Moved from ${from} to ${to} s: ${moved.join(', ')}.`);
  }),
);

server.registerTool(
  'scale_time',
  {
    description:
      'Stretches or compresses the time of a clip proportionally, in a single undo step: all the keyframes (with their ' +
      'value and curve) and the duration. With from and to, only that span: its keyframes are spread over the new length and ' +
      'the later ones shift. To shorten a wave from 1.8 to 1 s: duration 1. To make it twice as fast: factor 0.5.',
    inputSchema: {
      id,
      animation: z.string().describe('id of the clip'),
      duration: z.number().positive().optional().describe('new length in seconds, of the whole clip or of the span from…to'),
      factor: z.number().positive().optional().describe('instead of duration: how many times the current length (0.5 = twice as fast, 2 = half as fast)'),
      from: z.number().min(0).optional().describe('start of the span, in seconds (default 0)'),
      to: z.number().min(0).optional().describe('end of the span, in seconds (by default, the clip\'s duration)'),
      note: z.string().optional().describe('what it does, for the history'),
      width: z.number().int().min(64).max(2048).optional().describe('width of the preview'),
    },
  },
  safe(async ({ id, animation, duration, factor, from, to, note, width }) => {
    const plan = planScaleTime(await store.read(id), schema, animation, { duration, factor, from, to });
    const span = from == null && to == null ? '' : ` (span ${plan.from}…${plan.to} s → ${plan.length} s)`;
    const { doc } = await store.applyOps(id, plan.ops, { origin: ORIGIN, note: note ?? `scale time of ${animation}: ${plan.before} → ${plan.duration} s` });
    return preview(id, doc, { width, animation }, `${animation}: ${plan.before} → ${plan.duration} s${span}.`);
  }),
);

server.registerTool(
  'get_manifest',
  {
    description:
      'The puppet\'s manifest: what the app\'s AI will see to drive it live with play(clip), set(param, value) ' +
      'and stop(clip). Params (range, initial value, description and which poses each one moves), triggerable clips (base ' +
      'or gesture, with their description) and automatic layers. Review it when finishing a Puppet: whatever is missing or confusing here ' +
      '(an empty description, a param that moves nothing) is what will confuse the app.',
    inputSchema: { id, format: z.enum(['text', 'json']).optional().describe('text (default) to read it; json, the object the app receives') },
  },
  safe(async ({ id, format }) => {
    const m = manifest(await store.read(id), schema);
    return text(format === 'json' ? m : manifestText(m));
  }),
);

server.registerTool(
  'delete_document',
  {
    description:
      'Deletes a document and its history. It CANNOT be undone. Use it only if the user asked for it (for example, to ' +
      'clean up test documents); repeat the id in confirm.',
    inputSchema: {
      id,
      confirm: z.string().describe('the same document id, to confirm'),
    },
  },
  safe(async ({ id, confirm }) => {
    checkDeleted(id, confirm);
    await store.delete(id);
    return text(`Document "${id}" deleted (with its history).`);
  }),
);

// The editor shows "Claude connected" while this process runs (see server/mcpStatus.js).
const running = markRunning(DOCUMENTS_FOLDER, { version: VERSION });
server.server.oninitialized = () => running.setClient(server.server.getClientVersion());

await server.connect(new StdioServerTransport());
