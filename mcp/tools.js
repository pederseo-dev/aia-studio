// Logic of the MCP tools, without the transport: pure functions over a document (plus the store when they
// save), so they can be tested without starting the server. The texts they return are read by the AI.

import fs from 'node:fs/promises';
import path from 'node:path';
import { findObject, children, bonesOf } from '../src/core/document.js';
import { IMAGE_MAX } from '../src/core/images.js';
import { evaluateSkeleton, planProximityBinding, boneOf, limitAngle, tipOf, reparentBone, distributeBetweenBones } from '../src/core/skeleton.js';
import { apply } from '../src/core/geometry.js';
import { read, readMeta, suggest } from '../src/core/schema.js';
import { switchParams, driverWeight, paramValues } from '../src/core/blend.js';
import { summarizeOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';
import { previewError, trackLines, planClipView, planLiveView, clipSummary } from './animation.js';

/**
 * Readable tree of the document: one line per object, indented by hierarchy, from back to front. `tracks`: true
 * lists the tracks of all clips, false none, or the ids of the clips to list.
 * @param {any} doc @param {any} schema @param {{ tracks?: boolean | string[] }} [options]
 */
export function treeOutline(doc, schema, { tracks = true } = {}) {
  const lines = [];
  const { rest } = evaluateSkeleton(doc, schema);
  const r = (v) => Math.round(v);
  const walk = (parent, level) => {
    for (const o of children(doc, parent)) {
      let detail = '';
      if (o.bone) detail = ` → bone ${o.bone}`;
      // Drawing of a skeleton that follows no bone: in poses it stays still.
      else if (findObject(doc, o.parent)?.type === 'skeleton' && o.type !== 'bone' && !boneOf(doc, o.id) && !o.vertices?.some((v) => v.bone)) detail = ' (no bone: stays still in the poses)';
      if (o.type === 'skeleton') detail += ` [${bonesOf(doc, o.id).length} bones]`;
      if (o.type === 'image') detail += ` [${read(schema, o, 'src')}, ${r(read(schema, o, 'width'))}×${r(read(schema, o, 'height'))}]`;
      if (o.type === 'pose') detail = ` [${Object.keys(o.values ?? {}).join(', ') || 'empty'}]`;
      if (o.type === 'animation') detail = ` ${clipSummary(schema, o)}`;
      if (o.type === 'switch') {
        const params = switchParams(doc, o.id);
        detail = ` (shows ${o.active ?? 'the first'}${params.length ? `; chosen by the param${params.length > 1 ? 's' : ''} ${params.join(', ')}` : ''})`;
      }
      if (o.type === 'param') {
        const kind = read(schema, o, 'kind');
        detail = kind === 'enum' ? ` enum [${read(schema, o, 'options').join(', ')}]` : kind === 'boolean' ? ' boolean' : ` ${read(schema, o, 'min')}…${read(schema, o, 'max')}`;
      }
      if (o.type === 'driver') detail = ` ${o.param ?? '?'} → ${o.pose ?? '?'}${o.equals != null ? ` when = "${o.equals}"` : ` (${read(schema, o, 'inMin')}…${read(schema, o, 'inMax')})`}`;
      if (o.type === 'bone') {
        // Where it ends up in the document: with chained relative angles, this saves calculations.
        const m = rest.get(o.id);
        const [ox, oy] = apply(m, 0, 0);
        const [px, py] = tipOf(schema, o, m);
        detail = ` from (${r(ox)}, ${r(oy)}) to (${r(px)}, ${r(py)}), ${r((Math.atan2(m[1], m[0]) * 180) / Math.PI)}° on screen`;
      }
      lines.push(`${'  '.repeat(level)}- ${o.id} (${o.type})${detail}`);
      // The tracks of a clip, with their keyframes: to read it without the whole JSON.
      // `tracks`: true = all; false = none (only the summary); a list = only those of these clips.
      const withTracks = tracks === true || (Array.isArray(tracks) && tracks.includes(o.id));
      if (o.type === 'animation' && withTracks) for (const l of trackLines(o)) lines.push(`${'  '.repeat(level + 2)}${l}`);
      walk(o.id, level + 1);
    }
  };
  walk(null, 0);
  return lines.length ? lines.join('\n') : '(empty)';
}

/** delete_document: confirm has to repeat the id (deleting cannot be undone). */
export function checkDeleted(id, confirm) {
  if (confirm !== id) throw new Error(`To delete the document, confirm has to be "${id}" (the same id). Deleting can't be undone.`);
}

/** set_pose: what the bone limits clamp (the pose keeps the requested value, but the clamped one is shown). */
export function poseClamps(doc, schema, values) {
  return Object.entries(values).flatMap(([h, c]) => {
    const bone = findObject(doc, h);
    if (bone?.type !== 'bone' || c.rotation === undefined) return [];
    const seen = limitAngle(schema, bone, c.rotation);
    return seen !== c.rotation ? [`${h}.rotation ${c.rotation} ends up at ${seen} due to minAngle/maxAngle`] : [];
  });
}

/** bind_points: the batch and the split "bone [indices]". */
export function planBindPoints(doc, schema, path, bones) {
  if (findObject(doc, path)?.type !== 'path') throw new Error(`"${path}" is not a path`);
  const vertices = distributeBetweenBones(doc, schema, path, bones);
  const count = {};
  vertices.forEach((v, i) => (count[v.bone] ??= []).push(i));
  const distribution = Object.entries(count).map(([h, indices]) => `${h} [${indices.join(', ')}]`).join('; ');
  return { ops: [{ op: 'set', target: path, props: { vertices } }], distribution };
}

/** bind_by_proximity: the batch (empty if there is nothing to bind) and the split "bone ← pieces". */
export function planBindByProximity(doc, schema, skeleton) {
  const { ops, bindings } = planProximityBinding(doc, schema, skeleton);
  const byBone = {};
  for (const e of bindings) (byBone[e.bone] ??= []).push(e.id);
  const distribution = Object.entries(byBone).map(([h, ids]) => `${h} ← ${ids.join(', ')}`).join('; ');
  return { ops, bindings, distribution };
}

/** reparent_bone: the batch and the text explaining what happens in the poses. */
export function planReparentBone(doc, schema, bone, parent, keepInPoses = false) {
  const { ops, moved } = reparentBone(doc, schema, bone, parent, { keepInPoses: keepInPoses });
  if (!ops.length) return { ops, moved, text: `${bone} already hangs from ${parent}; nothing changed.` };
  const compensated = ops.filter((o) => o.op === 'set' && findObject(doc, o.target)?.type === 'pose' && o.props.values?.[bone]).map((o) => o.target);
  let poses = '';
  if (moved.length) {
    poses = keepInPoses
      ? ` In ${moved.join(', ')} it couldn't be kept where it was (minAngle/maxAngle or a deforming frame): check them with render_preview.`
      : ` Careful: in the poses ${moved.join(', ')} it now ends up elsewhere, because those poses move the old parent or the new one and the bone follows the new one. If it must stay where it was there too, repeat with keep_in_poses: true (or adjust those poses).`;
  } else if (keepInPoses && compensated.length) poses = ` In the poses it stayed where it was (values adjusted in ${[...new Set(compensated)].join(', ')}).`;
  else poses = ' In the poses it doesn\'t change place either.';
  return { ops, moved, text: `${bone} now hangs from ${parent}; in the setup it stayed where it was.${poses}` };
}

// ---------- Reads: get_document, get_history and render_preview ----------

// More than this does not fit comfortably in the response: get_document leaves the JSON out if it was not requested.
const RESPONSE_MAX = 60000;

/** get_document: the tree (with the tracks of `clips`, or of all) and the JSON, unless not requested or too heavy. */
/** @param {any} doc @param {any} schema @param {{ json?: boolean, clips?: string[] }} [options] */
export function documentText(doc, schema, { json, clips } = {}) {
  const textTree = `Tree (back to front):
${treeOutline(doc, schema, { tracks: clips ?? true })}`;
  if (json === false) return textTree;
  const complete = JSON.stringify(doc, null, 2);
  if (json === undefined && textTree.length + complete.length > RESPONSE_MAX) {
    return `${textTree}

(JSON omitted: the document is ${complete.length} characters. Ask for json: true if you really need it; to read clips, use clips.)`;
  }
  return `${textTree}

JSON:
${complete}`;
}

/** Value each property a batch set with set ended up with (long ones, summarized). */
function finalValues(ops) {
  const values = {};
  for (const op of ops) {
    if (op.op !== 'set') continue;
    for (const [k, v] of Object.entries(op.props)) {
      const json = JSON.stringify(v);
      values[`${op.target}.${k}`] = Array.isArray(v) ? `(${v.length} items)` : json.length > 160 ? `${json.slice(0, 157)}...` : v;
    }
  }
  return values;
}

/** get_history: the last `limit` batches (of `origin`, if given), summarized or with their operations (`detail`). */
/** @param {any[]} entries @param {{ limit?: number, origin?: string, detail?: boolean }} [options] */
export function historySummary(entries, { limit, origin, detail } = {}) {
  const chosen = entries.filter((e) => !origin || e.origin === origin).slice(-(limit ?? 20));
  return chosen.map(({ inverses, ops, ...e }) => ({ ...e, ...(detail ? { ops } : { touches: summarizeOperations(ops), values: finalValues(ops) }) }));
}

/**
 * render_preview (and the view of set_pose, set_keys…): the SVG, the default PNG width and the text summarizing it.
 * A clip or a live script go to their plans (mcp/animation.js); the rest is the document in the setup, in a pose
 * or with params.
 * @param {any} doc @param {any} schema @param {Record<string, any>} [options]
 */
export function planPreview(doc, schema, { pose, region, bones, params, animation, time, times, live, until, auto } = {}) {
  const error = previewError({ pose, animation, time, times, live });
  if (error) throw new Error(error);
  if (live) return planLiveView(doc, schema, { region, bones, params, live, times, until, auto });
  if (animation) return planClipView(doc, schema, { region, bones, params, animation, time, times });
  if (pose && findObject(doc, pose)?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`there is no pose "${pose}". Poses: ${poses.join(', ') || 'none'}`);
  }
  if (params) {
    const ids = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
    const unknown = Object.keys(params).filter((k) => !ids.includes(k));
    if (unknown.length) throw new Error(`there is no param "${unknown[0]}".${suggest(unknown[0], ids)} Params: ${ids.join(', ') || 'none'}`);
  }
  const svg = svgDocument(doc, schema, { pose, params, region, bones: bones });
  const size = region ? `crop of ${region.width}×${region.height} at (${region.x}, ${region.y})` : `${readMeta(schema, doc, 'width')}×${readMeta(schema, doc, 'height')} px`;
  let view = 'in the setup';
  if (pose) view = `in the pose "${pose}"`;
  else if (params) {
    // What ended up active: helps see whether the drivers do what was expected.
    const values = paramValues(doc, schema, params);
    const weights = doc.objects
      .filter((o) => o.type === 'driver' && o.pose && o.param in values)
      .map((o) => [o.pose, driverWeight(doc, schema, o, values[o.param])])
      .filter(([, w]) => w > 0)
      .map(([p, w]) => `${p} ${Math.round(w * 100)}%`);
    view = `with params ${JSON.stringify(values)} (poses: ${weights.join(', ') || 'none'})`;
  }
  return { svg, width: 600, text: `${size}, ${doc.objects.length} objects, ${view}.` };
}

// ---------- add_image ----------

/**
 * Bytes and name of an image file for add_image: a local (absolute) path or an http(s) URL. Throws if it cannot be
 * read or exceeds the maximum; whether it is a valid image is decided later by the store (readImage).
 * @param {{ path?: string, url?: string }} origin
 * @returns {Promise<{ bytes: Uint8Array, name: string }>}
 */
export async function imageBytes({ path: filePath, url }) {
  if (!!filePath === !!url) throw new Error('Give exactly one of path (a local file) or url');
  if (filePath) {
    if (!path.isAbsolute(filePath)) throw new Error(`path must be absolute (received "${filePath}")`);
    const info = await fs.stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`No file at "${filePath}"`);
    if (info.size > IMAGE_MAX) throw new Error(`The image is too big (${Math.round(info.size / 1048576)} MB; at most ${IMAGE_MAX / 1048576} MB)`);
    return { bytes: new Uint8Array(await fs.readFile(filePath)), name: path.basename(filePath) };
  }
  let direction;
  try {
    direction = new URL(url);
  } catch {
    throw new Error(`Invalid url "${url}"`);
  }
  if (!['http:', 'https:'].includes(direction.protocol)) throw new Error('url must be http or https');
  const response = await fetch(direction, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Couldn't download ${url}: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > IMAGE_MAX) throw new Error(`The image is too big (at most ${IMAGE_MAX / 1048576} MB)`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, name: decodeURIComponent(direction.pathname.split('/').pop() || 'image') };
}
