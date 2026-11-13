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
      if (o.bone) detail = ` → hueso ${o.bone}`;
      // Drawing of a skeleton that follows no bone: in poses it stays still.
      else if (findObject(doc, o.parent)?.type === 'skeleton' && o.type !== 'bone' && !boneOf(doc, o.id) && !o.vertices?.some((v) => v.bone)) detail = ' (sin hueso: queda quieto en las poses)';
      if (o.type === 'skeleton') detail += ` [${bonesOf(doc, o.id).length} huesos]`;
      if (o.type === 'image') detail += ` [${read(schema, o, 'src')}, ${r(read(schema, o, 'width'))}×${r(read(schema, o, 'height'))}]`;
      if (o.type === 'pose') detail = ` [${Object.keys(o.values ?? {}).join(', ') || 'vacía'}]`;
      if (o.type === 'animation') detail = ` ${clipSummary(schema, o)}`;
      if (o.type === 'switch') {
        const params = switchParams(doc, o.id);
        detail = ` (muestra ${o.active ?? 'el primero'}${params.length ? `; lo elige${params.length > 1 ? 'n los params' : ' el param'} ${params.join(', ')}` : ''})`;
      }
      if (o.type === 'param') {
        const kind = read(schema, o, 'kind');
        detail = kind === 'enum' ? ` enum [${read(schema, o, 'options').join(', ')}]` : kind === 'boolean' ? ' boolean' : ` ${read(schema, o, 'min')}…${read(schema, o, 'max')}`;
      }
      if (o.type === 'driver') detail = ` ${o.param ?? '?'} → ${o.pose ?? '?'}${o.equals != null ? ` cuando = "${o.equals}"` : ` (${read(schema, o, 'inMin')}…${read(schema, o, 'inMax')})`}`;
      if (o.type === 'bone') {
        // Where it ends up in the document: with chained relative angles, this saves calculations.
        const m = rest.get(o.id);
        const [ox, oy] = apply(m, 0, 0);
        const [px, py] = tipOf(schema, o, m);
        detail = ` de (${r(ox)}, ${r(oy)}) a (${r(px)}, ${r(py)}), ${r((Math.atan2(m[1], m[0]) * 180) / Math.PI)}° en pantalla`;
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
  return lines.length ? lines.join('\n') : '(vacío)';
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
    return seen !== c.rotation ? [`${h}.rotation ${c.rotation} queda en ${seen} por minAngle/maxAngle`] : [];
  });
}

/** bind_points: the batch and the split "bone [indices]". */
export function planBindPoints(doc, schema, path, bones) {
  if (findObject(doc, path)?.type !== 'path') throw new Error(`"${path}" no es un path`);
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
  if (!ops.length) return { ops, moved, text: `${bone} ya cuelga de ${parent}; no hubo cambios.` };
  const compensated = ops.filter((o) => o.op === 'set' && findObject(doc, o.target)?.type === 'pose' && o.props.values?.[bone]).map((o) => o.target);
  let poses = '';
  if (moved.length) {
    poses = keepInPoses
      ? ` En ${moved.join(', ')} no se pudo dejar donde estaba (minAngle/maxAngle o un marco que deforma): revísalas con render_preview.`
      : ` Ojo: en las poses ${moved.join(', ')} ahora queda en otro lugar, porque esas poses mueven al padre viejo o al nuevo y el hueso sigue al nuevo. Si tiene que quedar donde estaba también ahí, repite con keep_in_poses: true (o ajusta esas poses).`;
  } else if (keepInPoses && compensated.length) poses = ` En las poses quedó donde estaba (valores ajustados en ${[...new Set(compensated)].join(', ')}).`;
  else poses = ' En las poses tampoco cambia de lugar.';
  return { ops, moved, text: `${bone} ahora cuelga de ${parent}; en el montaje quedó donde estaba.${poses}` };
}

// ---------- Reads: get_document, get_history and render_preview ----------

// More than this does not fit comfortably in the response: get_document leaves the JSON out if it was not requested.
const RESPONSE_MAX = 60000;

/** get_document: the tree (with the tracks of `clips`, or of all) and the JSON, unless not requested or too heavy. */
/** @param {any} doc @param {any} schema @param {{ json?: boolean, clips?: string[] }} [options] */
export function documentText(doc, schema, { json, clips } = {}) {
  const textTree = `Árbol (del fondo al frente):
${treeOutline(doc, schema, { tracks: clips ?? true })}`;
  if (json === false) return textTree;
  const complete = JSON.stringify(doc, null, 2);
  if (json === undefined && textTree.length + complete.length > RESPONSE_MAX) {
    return `${textTree}

(JSON omitido: el documento pesa ${complete.length} caracteres. Pide json: true si de verdad lo necesitas; para leer clips, usa clips.)`;
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
      values[`${op.target}.${k}`] = Array.isArray(v) ? `(${v.length} elementos)` : json.length > 160 ? `${json.slice(0, 157)}...` : v;
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
    throw new Error(`no existe la pose "${pose}". Poses: ${poses.join(', ') || 'ninguna'}`);
  }
  if (params) {
    const ids = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
    const unknown = Object.keys(params).filter((k) => !ids.includes(k));
    if (unknown.length) throw new Error(`no existe el param "${unknown[0]}".${suggest(unknown[0], ids)} Params: ${ids.join(', ') || 'ninguno'}`);
  }
  const svg = svgDocument(doc, schema, { pose, params, region, bones: bones });
  const size = region ? `recorte de ${region.width}×${region.height} en (${region.x}, ${region.y})` : `${readMeta(schema, doc, 'width')}×${readMeta(schema, doc, 'height')} px`;
  let view = 'en el montaje';
  if (pose) view = `en la pose "${pose}"`;
  else if (params) {
    // What ended up active: helps see whether the drivers do what was expected.
    const values = paramValues(doc, schema, params);
    const weights = doc.objects
      .filter((o) => o.type === 'driver' && o.pose && o.param in values)
      .map((o) => [o.pose, driverWeight(doc, schema, o, values[o.param])])
      .filter(([, w]) => w > 0)
      .map(([p, w]) => `${p} ${Math.round(w * 100)}%`);
    view = `con params ${JSON.stringify(values)} (poses: ${weights.join(', ') || 'ninguna'})`;
  }
  return { svg, width: 600, text: `${size}, ${doc.objects.length} objetos, ${view}.` };
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
