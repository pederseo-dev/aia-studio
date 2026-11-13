// Capas de imagen en el editor: subir el archivo a assets/ del documento (el servidor lo guarda y da su tamaño) y
// crear la capa con el mismo plan que usa el MCP (planAgregarImagen). Entran por la opción Image de Layers, al soltar
// archivos sobre el lienzo o al pegarlos (Ctrl+V).

import { findObject } from '../core/document.js';
import { readMeta } from '../core/schema.js';
import { readImage, planAddImage } from '../core/images.js';
import { notify, execute, schema, state, parentForNew, selectSeveral } from './state.js';

const IS_IMAGE = /^image\/(png|jpeg|webp|svg\+xml)$/;

/** URL con que el lienzo y el inspector piden el archivo de una capa image. */
export const assetUrl = (src, id = state.id) => `/api/documents/${encodeURIComponent(id)}/assets/${encodeURIComponent(src)}`;

/** Los archivos que son imágenes aceptadas (de un input, un drop o el portapapeles). */
export const imagesOnly = (files) => [...(files ?? [])].filter((a) => IS_IMAGE.test(a.type) || /\.(png|jpe?g|webp|svg)$/i.test(a.name));

/** Sube un archivo a assets/ y devuelve { src, ancho, alto, formato, reusado }. */
async function upload(file) {
  const res = await fetch(`/api/documents/${encodeURIComponent(state.id)}/assets?name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', body: file });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/**
 * Agrega una capa image por archivo, en un solo paso de deshacer, y las selecciona. `punto`: dónde, en coordenadas
 * del documento (al soltar sobre el lienzo); sin él, al centro del lienzo.
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
      // Varias a la vez quedan corridas un poco, para que no se tapen del todo.
      const base = point ?? [readMeta(schema, doc, 'width') / 2, readMeta(schema, doc, 'height') / 2];
      const offset = [base[0] + i * 20, base[1] + i * 20];
      const plan = planAddImage(doc, schema, { src, naturalWidth, naturalHeight, parent: parent, point: offset });
      // El siguiente id libre tiene que ver los de este lote.
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

/** Cambia el archivo de una capa image: conserva el ancho y adapta el alto a la proporción del archivo nuevo. */
export async function replaceImage(id, file) {
  try {
    const { src, naturalWidth, naturalHeight } = await upload(file);
    const previous = findObject(state.doc, id);
    const currentWidth = previous?.width ?? naturalWidth;
    await execute([{ op: 'set', target: id, props: { src, width: currentWidth, height: Math.round((currentWidth * naturalHeight * 100) / naturalWidth) / 100 } }], `${id}: replace image with ${src}`);
  } catch (err) {
    notify(err.message, true);
  }
}

/** Vuelve la capa al tamaño natural de su archivo. */
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
