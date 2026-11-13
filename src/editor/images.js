// Image layers in the editor: upload the file to the document's assets/ (the server stores it and gives its size) and
// create the layer with the same plan the MCP uses (planAddImage). They come in through the Image option in Layers, by
// dropping files on the canvas or by pasting them (Ctrl+V).

import { findObject } from '../core/document.js';
import { readMeta } from '../core/schema.js';
import { readImage, planAddImage, planReplaceImage } from '../core/images.js';
import { notify, execute, schema, state, parentForNew, selectSeveral } from './state.js';

const IS_IMAGE = /^image\/(png|jpeg|webp|svg\+xml)$/;

/** URL with which the canvas and the inspector request the file of an image layer. */
export const assetUrl = (src, id = state.id) => `/api/documents/${encodeURIComponent(id)}/assets/${encodeURIComponent(src)}`;

/** The files that are accepted images (from an input, a drop or the clipboard). */
export const imagesOnly = (files) => [...(files ?? [])].filter((a) => IS_IMAGE.test(a.type) || /\.(png|jpe?g|webp|svg)$/i.test(a.name));

/** Uploads a file to assets/ and returns { src, naturalWidth, naturalHeight, format, reused }. */
async function upload(file) {
  const res = await fetch(`/api/documents/${encodeURIComponent(state.id)}/assets?name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', body: file });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/**
 * Adds one image layer per file, in a single undo step, and selects them. `point`: where, in document
 * coordinates (when dropping on the canvas); without it, at the center of the canvas.
 * @param {File[]} files @param {number[]} [point]
 */
export async function addImages(files, point) {
  if (!state.doc || !files.length) return;
  if (state.live) return notify('Live is on: turn it off (■ Live) to edit the document.', true);
  try {
    const parent = parentForNew();
    let doc = state.doc;
    const ops = [];
    const ids = [];
    for (const [i, file] of files.entries()) {
      const { src, naturalWidth, naturalHeight } = await upload(file);
      // Several at once are offset a little, so they do not cover each other completely.
      const base = point ?? [readMeta(schema, doc, 'width') / 2, readMeta(schema, doc, 'height') / 2];
      const offset = [base[0] + i * 20, base[1] + i * 20];
      const plan = planAddImage(doc, schema, { src, naturalWidth, naturalHeight, parent: parent, point: offset });
      // The next free id has to see the ones in this batch.
      doc = { ...doc, objects: [...doc.objects, { id: plan.id, type: 'image' }] };
      ops.push(...plan.ops);
      ids.push(plan.id);
    }
    const name = ids.length === 1 ? `add image ${ids[0]}` : `add ${ids.length} images`;
    if (await execute(ops, name)) selectSeveral(ids);
  } catch (err) {
    notify(err.message, true);
  }
}

/** Changes the file of an image layer: keeps the width and adapts the height to the new file's proportion. */
export async function replaceImage(id, file) {
  try {
    const { src, naturalWidth, naturalHeight } = await upload(file);
    await execute(planReplaceImage(state.doc, id, { src, naturalWidth, naturalHeight }), `${id}: replace image with ${src}`);
  } catch (err) {
    notify(err.message, true);
  }
}

/** Returns the layer to its file's natural size. */
export async function naturalSize(id) {
  const obj = findObject(state.doc, id);
  if (!obj) return;
  try {
    const res = await fetch(assetUrl(obj.src));
    if (!res.ok) throw new Error((await res.json()).error);
    const { naturalWidth, naturalHeight } = readImage(new Uint8Array(await res.arrayBuffer()));
    await execute([{ op: 'set', target: id, props: { width: naturalWidth, height: naturalHeight } }], `${id}: original size`);
  } catch (err) {
    notify(err.message, true);
  }
}
