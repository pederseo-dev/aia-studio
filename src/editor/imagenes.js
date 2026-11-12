// Capas de imagen en el editor: subir el archivo a assets/ del documento (el servidor lo guarda y da su tamaño) y
// crear la capa con el mismo plan que usa el MCP (planAgregarImagen). Entran por la opción Image de Layers, al soltar
// archivos sobre el lienzo o al pegarlos (Ctrl+V).

import { buscar } from '../core/documento.js';
import { leerMeta } from '../core/esquema.js';
import { leerImagen, planAgregarImagen } from '../core/imagenes.js';
import { avisar, ejecutar, esquema, estado, padreParaNuevo, seleccionarVarios } from './estado.js';

const ES_IMAGEN = /^image\/(png|jpeg|webp|svg\+xml)$/;

/** URL con que el lienzo y el inspector piden el archivo de una capa image. */
export const urlDeAsset = (src, id = estado.id) => `/api/documentos/${encodeURIComponent(id)}/assets/${encodeURIComponent(src)}`;

/** Los archivos que son imágenes aceptadas (de un input, un drop o el portapapeles). */
export const soloImagenes = (archivos) => [...(archivos ?? [])].filter((a) => ES_IMAGEN.test(a.type) || /\.(png|jpe?g|webp|svg)$/i.test(a.name));

/** Sube un archivo a assets/ y devuelve { src, ancho, alto, formato, reusado }. */
async function subir(archivo) {
  const res = await fetch(`/api/documentos/${encodeURIComponent(estado.id)}/assets?name=${encodeURIComponent(archivo.name || 'pasted.png')}`, { method: 'POST', body: archivo });
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error);
  return datos;
}

/**
 * Agrega una capa image por archivo, en un solo paso de deshacer, y las selecciona. `punto`: dónde, en coordenadas
 * del documento (al soltar sobre el lienzo); sin él, al centro del lienzo.
 * @param {File[]} archivos @param {number[]} [punto]
 */
export async function agregarImagenes(archivos, punto) {
  if (!estado.doc || !archivos.length) return;
  if (estado.vivo) return avisar('Live is on: turn it off (■ Live) to edit the document.', true);
  try {
    const padre = padreParaNuevo();
    let doc = estado.doc;
    const ops = [];
    const ids = [];
    for (const [i, archivo] of archivos.entries()) {
      const { src, ancho, alto } = await subir(archivo);
      // Varias a la vez quedan corridas un poco, para que no se tapen del todo.
      const base = punto ?? [leerMeta(esquema, doc, 'width') / 2, leerMeta(esquema, doc, 'height') / 2];
      const desplazado = [base[0] + i * 20, base[1] + i * 20];
      const plan = planAgregarImagen(doc, esquema, { src, ancho, alto, parent: padre, punto: desplazado });
      // El siguiente id libre tiene que ver los de este lote.
      doc = { ...doc, objects: [...doc.objects, { id: plan.id, type: 'image' }] };
      ops.push(...plan.ops);
      ids.push(plan.id);
    }
    const nombre = ids.length === 1 ? `add image ${ids[0]}` : `add ${ids.length} images`;
    if (await ejecutar(ops, nombre)) seleccionarVarios(ids);
  } catch (err) {
    avisar(err.message, true);
  }
}

/** Cambia el archivo de una capa image: conserva el ancho y adapta el alto a la proporción del archivo nuevo. */
export async function reemplazarImagen(id, archivo) {
  try {
    const { src, ancho, alto } = await subir(archivo);
    const anterior = buscar(estado.doc, id);
    const anchoActual = anterior?.width ?? ancho;
    await ejecutar([{ op: 'set', target: id, props: { src, width: anchoActual, height: Math.round((anchoActual * alto * 100) / ancho) / 100 } }], `${id}: replace image with ${src}`);
  } catch (err) {
    avisar(err.message, true);
  }
}

/** Vuelve la capa al tamaño natural de su archivo. */
export async function tamanoNatural(id) {
  const obj = buscar(estado.doc, id);
  if (!obj) return;
  try {
    const res = await fetch(urlDeAsset(obj.src));
    if (!res.ok) throw new Error((await res.json()).error);
    const { ancho, alto } = leerImagen(new Uint8Array(await res.arrayBuffer()));
    await ejecutar([{ op: 'set', target: id, props: { width: ancho, height: alto } }], `${id}: original size`);
  } catch (err) {
    avisar(err.message, true);
  }
}
