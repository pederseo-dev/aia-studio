// Image layers in the editor: the picture is uploaded to the document's assets folder (the server names it and reads
// its size) and the layer is made with the same operations `aia image` uses (addImageOps in core/images.js). They
// come in from Image… in the Layers menu or by dropping picture files on the canvas.

import { addImageOps } from '../core/images.js';
import { newLayerPlace } from './layers.js';
import { notify, run, state } from './state.js';
import { area, toDoc } from './view.js';

/**
 * @typedef {import('../core/operations.js').Operation} Operation
 * @typedef {{ x: number, y: number }} Point
 */

const PICTURE = /\.(png|jpe?g|webp|svg)$/i;
const PICTURE_TYPE = /^image\/(png|jpeg|webp|svg\+xml)$/;

/** Where the canvas asks for an asset file of the active document. @param {string} src */
export const assetUrl = (src) => (state.active ? `/api/documents/${encodeURIComponent(state.active)}/assets/${encodeURIComponent(src)}` : null);

/** The files that are pictures. @param {Iterable<File>} files */
const picturesOf = (files) => [...files].filter((f) => PICTURE_TYPE.test(f.type) || PICTURE.test(f.name));

/**
 * Uploads a picture to the active document's assets folder.
 * @param {File} file
 * @returns {Promise<{ src: string, naturalWidth: number, naturalHeight: number }>}
 */
async function upload(file) {
  const id = encodeURIComponent(/** @type {string} */ (state.active));
  const response = await fetch(`/api/documents/${id}/assets?name=${encodeURIComponent(file.name || 'image.png')}`, { method: 'POST', body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  return data;
}

/**
 * Adds one image layer per picture, in one undo step, where a new layer goes (see newLayerPlace), and selects the
 * last. Several are offset a little so they do not cover each other.
 * @param {File[]} files @param {Point} [at] the artboard point they are centered on (where they were dropped)
 */
export async function addImages(files, at) {
  const pictures = picturesOf(files);
  if (!state.document || !state.active) return;
  if (!pictures.length) return notify('Only PNG, JPEG, WebP and SVG pictures make an image layer.');
  try {
    const { parent, index } = newLayerPlace();
    const width = Number(state.document.meta.width ?? 800);
    const height = Number(state.document.meta.height ?? 600);
    const center = at ?? { x: width / 2, y: height / 2 };
    let doc = state.document;
    /** @type {Operation[]} */
    const ops = [];
    /** @type {string[]} */
    const ids = [];
    for (const [i, file] of pictures.entries()) {
      const asset = await upload(file);
      const plan = addImageOps(doc, {
        ...asset,
        parent,
        index: index === undefined ? undefined : index + i,
        at: { x: center.x + i * 20, y: center.y + i * 20 },
      });
      // The next free id has to see the layers of this batch.
      doc = { ...doc, objects: [...doc.objects, { id: plan.id, type: 'image', parent }] };
      ops.push(...plan.ops);
      ids.push(plan.id);
    }
    await run(ops, { select: ids.at(-1), note: ids.length === 1 ? `Image layer ${ids[0]}` : `${ids.length} image layers` });
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e));
  }
}

/** Opens the system's file picker for pictures (Image… in the Layers menu). */
export function chooseImages() {
  if (!state.document) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg';
  input.multiple = true;
  input.addEventListener('change', () => addImages([...(input.files ?? [])]));
  input.click();
}

/** Picture files dropped on the canvas become image layers, centered where they fall. */
export function setupImageDrop() {
  const hasFiles = (/** @type {DragEvent} */ event) => !!event.dataTransfer?.types.includes('Files');
  area.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || !state.document) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  area.addEventListener('drop', (event) => {
    if (!hasFiles(event) || !state.document) return;
    event.preventDefault();
    addImages([...(event.dataTransfer?.files ?? [])], toDoc(event));
  });
}
