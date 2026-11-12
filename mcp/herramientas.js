// Lógica de las herramientas del MCP, sin el transporte: funciones puras sobre un documento (más el almacén cuando
// guardan), para poder probarlas sin levantar el servidor. Los textos que devuelven los lee la IA.

import fs from 'node:fs/promises';
import path from 'node:path';
import { buscar, hijos, huesosDe } from '../src/core/documento.js';
import { MAXIMO_DE_IMAGEN } from '../src/core/imagenes.js';
import { evaluarEsqueleto, planEnlazarPorCercania, huesoDe, limitarAngulo, puntaDe, reparentarHueso, repartirEntreHuesos } from '../src/core/esqueleto.js';
import { aplicar } from '../src/core/geometria.js';
import { leer, leerMeta, sugerir } from '../src/core/esquema.js';
import { paramsDeSwitch, pesoDeDriver, valoresDeParams } from '../src/core/mezcla.js';
import { resumirOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';
import { errorDeVistaPrevia, lineasDePistas, planVistaDeClip, planVistaEnVivo, resumenDeClip } from './animacion.js';

/**
 * Árbol legible del documento: una línea por objeto, indentado por jerarquía, del fondo al frente. `pistas`: true
 * lista las pistas de todos los clips, false ninguna, o los ids de los clips a listar.
 * @param {any} doc @param {any} esquema @param {{ pistas?: boolean | string[] }} [opciones]
 */
export function esquemaDelArbol(doc, esquema, { pistas = true } = {}) {
  const lineas = [];
  const { reposo } = evaluarEsqueleto(doc, esquema);
  const r = (v) => Math.round(v);
  const recorrer = (padre, nivel) => {
    for (const o of hijos(doc, padre)) {
      let detalle = '';
      if (o.bone) detalle = ` → hueso ${o.bone}`;
      // Dibujo de un skeleton que no sigue a ningún hueso: en las poses queda quieto.
      else if (buscar(doc, o.parent)?.type === 'skeleton' && o.type !== 'bone' && !huesoDe(doc, o.id) && !o.vertices?.some((v) => v.bone)) detalle = ' (sin hueso: queda quieto en las poses)';
      if (o.type === 'skeleton') detalle += ` [${huesosDe(doc, o.id).length} huesos]`;
      if (o.type === 'image') detalle += ` [${leer(esquema, o, 'src')}, ${r(leer(esquema, o, 'width'))}×${r(leer(esquema, o, 'height'))}]`;
      if (o.type === 'pose') detalle = ` [${Object.keys(o.values ?? {}).join(', ') || 'vacía'}]`;
      if (o.type === 'animation') detalle = ` ${resumenDeClip(esquema, o)}`;
      if (o.type === 'switch') {
        const params = paramsDeSwitch(doc, o.id);
        detalle = ` (muestra ${o.active ?? 'el primero'}${params.length ? `; lo elige${params.length > 1 ? 'n los params' : ' el param'} ${params.join(', ')}` : ''})`;
      }
      if (o.type === 'param') {
        const tipo = leer(esquema, o, 'kind');
        detalle = tipo === 'enum' ? ` enum [${leer(esquema, o, 'options').join(', ')}]` : tipo === 'boolean' ? ' boolean' : ` ${leer(esquema, o, 'min')}…${leer(esquema, o, 'max')}`;
      }
      if (o.type === 'driver') detalle = ` ${o.param ?? '?'} → ${o.pose ?? '?'}${o.equals != null ? ` cuando = "${o.equals}"` : ` (${leer(esquema, o, 'inMin')}…${leer(esquema, o, 'inMax')})`}`;
      if (o.type === 'bone') {
        // Dónde queda en el documento: con ángulos relativos encadenados, esto ahorra cuentas.
        const m = reposo.get(o.id);
        const [ox, oy] = aplicar(m, 0, 0);
        const [px, py] = puntaDe(esquema, o, m);
        detalle = ` de (${r(ox)}, ${r(oy)}) a (${r(px)}, ${r(py)}), ${r((Math.atan2(m[1], m[0]) * 180) / Math.PI)}° en pantalla`;
      }
      lineas.push(`${'  '.repeat(nivel)}- ${o.id} (${o.type})${detalle}`);
      // Las pistas de un clip, con sus keyframes: para leerlo sin el JSON entero.
      // `pistas`: true = todas; false = ninguna (solo el resumen); una lista = solo las de esos clips.
      const conPistas = pistas === true || (Array.isArray(pistas) && pistas.includes(o.id));
      if (o.type === 'animation' && conPistas) for (const l of lineasDePistas(o)) lineas.push(`${'  '.repeat(nivel + 2)}${l}`);
      recorrer(o.id, nivel + 1);
    }
  };
  recorrer(null, 0);
  return lineas.length ? lineas.join('\n') : '(vacío)';
}

/** delete_document: el confirm tiene que repetir el id (borrar no se puede deshacer). */
export function comprobarBorrado(id, confirm) {
  if (confirm !== id) throw new Error(`To delete the document, confirm has to be "${id}" (the same id). Deleting can't be undone.`);
}

/** set_pose: lo que recortan los límites de los huesos (la pose guarda el valor pedido, pero se ve el recortado). */
export function recortesDePose(doc, esquema, valores) {
  return Object.entries(valores).flatMap(([h, c]) => {
    const hueso = buscar(doc, h);
    if (hueso?.type !== 'bone' || c.rotation === undefined) return [];
    const visto = limitarAngulo(esquema, hueso, c.rotation);
    return visto !== c.rotation ? [`${h}.rotation ${c.rotation} queda en ${visto} por minAngle/maxAngle`] : [];
  });
}

/** bind_points: el lote y el reparto "hueso [índices]". */
export function planBindPoints(doc, esquema, path, bones) {
  if (buscar(doc, path)?.type !== 'path') throw new Error(`"${path}" no es un path`);
  const vertices = repartirEntreHuesos(doc, esquema, path, bones);
  const cuenta = {};
  vertices.forEach((v, i) => (cuenta[v.bone] ??= []).push(i));
  const reparto = Object.entries(cuenta).map(([h, indices]) => `${h} [${indices.join(', ')}]`).join('; ');
  return { ops: [{ op: 'set', target: path, props: { vertices } }], reparto };
}

/** bind_by_proximity: el lote (vacío si no hay nada que enlazar) y el reparto "hueso ← piezas". */
export function planBindByProximity(doc, esquema, skeleton) {
  const { ops, enlaces } = planEnlazarPorCercania(doc, esquema, skeleton);
  const porHueso = {};
  for (const e of enlaces) (porHueso[e.bone] ??= []).push(e.id);
  const reparto = Object.entries(porHueso).map(([h, ids]) => `${h} ← ${ids.join(', ')}`).join('; ');
  return { ops, enlaces, reparto };
}

/** reparent_bone: el lote y el texto que explica qué pasa en las poses. */
export function planReparentBone(doc, esquema, bone, parent, keepInPoses = false) {
  const { ops, movidas } = reparentarHueso(doc, esquema, bone, parent, { conservarEnPoses: keepInPoses });
  if (!ops.length) return { ops, movidas, texto: `${bone} ya cuelga de ${parent}; no hubo cambios.` };
  const compensadas = ops.filter((o) => o.op === 'set' && buscar(doc, o.target)?.type === 'pose' && o.props.values?.[bone]).map((o) => o.target);
  let poses = '';
  if (movidas.length) {
    poses = keepInPoses
      ? ` En ${movidas.join(', ')} no se pudo dejar donde estaba (minAngle/maxAngle o un marco que deforma): revísalas con render_preview.`
      : ` Ojo: en las poses ${movidas.join(', ')} ahora queda en otro lugar, porque esas poses mueven al padre viejo o al nuevo y el hueso sigue al nuevo. Si tiene que quedar donde estaba también ahí, repite con keep_in_poses: true (o ajusta esas poses).`;
  } else if (keepInPoses && compensadas.length) poses = ` En las poses quedó donde estaba (valores ajustados en ${[...new Set(compensadas)].join(', ')}).`;
  else poses = ' En las poses tampoco cambia de lugar.';
  return { ops, movidas, texto: `${bone} ahora cuelga de ${parent}; en el montaje quedó donde estaba.${poses}` };
}

// ---------- Lecturas: get_document, get_history y render_preview ----------

// Más que esto no entra cómodo en la respuesta: get_document deja el JSON afuera si no se pidió.
const MAXIMO_DE_RESPUESTA = 60000;

/** get_document: el árbol (con las pistas de `clips`, o de todos) y el JSON, salvo que no se pida o pese demasiado. */
/** @param {any} doc @param {any} esquema @param {{ json?: boolean, clips?: string[] }} [opciones] */
export function textoDeDocumento(doc, esquema, { json, clips } = {}) {
  const arbolTexto = `Árbol (del fondo al frente):
${esquemaDelArbol(doc, esquema, { pistas: clips ?? true })}`;
  if (json === false) return arbolTexto;
  const completo = JSON.stringify(doc, null, 2);
  if (json === undefined && arbolTexto.length + completo.length > MAXIMO_DE_RESPUESTA) {
    return `${arbolTexto}

(JSON omitido: el documento pesa ${completo.length} caracteres. Pide json: true si de verdad lo necesitas; para leer clips, usa clips.)`;
  }
  return `${arbolTexto}

JSON:
${completo}`;
}

/** Valor con el que quedó cada propiedad que un lote fijó con set (los largos, resumidos). */
function valoresFinales(ops) {
  const valores = {};
  for (const op of ops) {
    if (op.op !== 'set') continue;
    for (const [k, v] of Object.entries(op.props)) {
      const json = JSON.stringify(v);
      valores[`${op.target}.${k}`] = Array.isArray(v) ? `(${v.length} elementos)` : json.length > 160 ? `${json.slice(0, 157)}...` : v;
    }
  }
  return valores;
}

/** get_history: los últimos `limit` lotes (de `origin`, si se pide), resumidos o con sus operaciones (`detail`). */
/** @param {any[]} entradas @param {{ limit?: number, origin?: string, detail?: boolean }} [opciones] */
export function resumenDeHistorial(entradas, { limit, origin, detail } = {}) {
  const elegidas = entradas.filter((e) => !origin || e.origen === origin).slice(-(limit ?? 20));
  return elegidas.map(({ inversas, ops, ...e }) => ({ ...e, ...(detail ? { ops } : { toca: resumirOperaciones(ops), valores: valoresFinales(ops) }) }));
}

/**
 * render_preview (y la vista de set_pose, set_keys…): el SVG, el ancho por defecto del PNG y el texto que lo resume.
 * Un clip o un guion en vivo van a sus planes (mcp/animacion.js); lo demás es el documento en el montaje, en una pose
 * o con params.
 * @param {any} doc @param {any} esquema @param {Record<string, any>} [opciones]
 */
export function planVistaPrevia(doc, esquema, { pose, region, bones, params, animation, time, times, live, until, auto } = {}) {
  const error = errorDeVistaPrevia({ pose, animation, time, times, live });
  if (error) throw new Error(error);
  if (live) return planVistaEnVivo(doc, esquema, { region, bones, params, live, times, until, auto });
  if (animation) return planVistaDeClip(doc, esquema, { region, bones, params, animation, time, times });
  if (pose && buscar(doc, pose)?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`no existe la pose "${pose}". Poses: ${poses.join(', ') || 'ninguna'}`);
  }
  if (params) {
    const ids = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
    const raros = Object.keys(params).filter((k) => !ids.includes(k));
    if (raros.length) throw new Error(`no existe el param "${raros[0]}".${sugerir(raros[0], ids)} Params: ${ids.join(', ') || 'ninguno'}`);
  }
  const svg = svgDocumento(doc, esquema, { pose, params, region, huesos: bones });
  const tamaño = region ? `recorte de ${region.width}×${region.height} en (${region.x}, ${region.y})` : `${leerMeta(esquema, doc, 'width')}×${leerMeta(esquema, doc, 'height')} px`;
  let vista = 'en el montaje';
  if (pose) vista = `en la pose "${pose}"`;
  else if (params) {
    // Qué quedó activo: ayuda a ver si los drivers hacen lo que se esperaba.
    const valores = valoresDeParams(doc, esquema, params);
    const pesos = doc.objects
      .filter((o) => o.type === 'driver' && o.pose && o.param in valores)
      .map((o) => [o.pose, pesoDeDriver(doc, esquema, o, valores[o.param])])
      .filter(([, w]) => w > 0)
      .map(([p, w]) => `${p} ${Math.round(w * 100)}%`);
    vista = `con params ${JSON.stringify(valores)} (poses: ${pesos.join(', ') || 'ninguna'})`;
  }
  return { svg, ancho: 600, texto: `${tamaño}, ${doc.objects.length} objetos, ${vista}.` };
}

// ---------- add_image ----------

/**
 * Bytes y nombre de un archivo de imagen para add_image: una ruta local (absoluta) o una URL http(s). Lanza si no se
 * puede leer o pasa del máximo; si es una imagen válida lo decide después el almacén (leerImagen).
 * @param {{ path?: string, url?: string }} origen
 * @returns {Promise<{ bytes: Uint8Array, nombre: string }>}
 */
export async function bytesDeImagen({ path: ruta, url }) {
  if (!!ruta === !!url) throw new Error('Give exactly one of path (a local file) or url');
  if (ruta) {
    if (!path.isAbsolute(ruta)) throw new Error(`path must be absolute (received "${ruta}")`);
    const info = await fs.stat(ruta).catch(() => null);
    if (!info?.isFile()) throw new Error(`No file at "${ruta}"`);
    if (info.size > MAXIMO_DE_IMAGEN) throw new Error(`The image is too big (${Math.round(info.size / 1048576)} MB; at most ${MAXIMO_DE_IMAGEN / 1048576} MB)`);
    return { bytes: new Uint8Array(await fs.readFile(ruta)), nombre: path.basename(ruta) };
  }
  let direccion;
  try {
    direccion = new URL(url);
  } catch {
    throw new Error(`Invalid url "${url}"`);
  }
  if (!['http:', 'https:'].includes(direccion.protocol)) throw new Error('url must be http or https');
  const respuesta = await fetch(direccion, { signal: AbortSignal.timeout(30000) });
  if (!respuesta.ok) throw new Error(`Couldn't download ${url}: HTTP ${respuesta.status}`);
  if (Number(respuesta.headers.get('content-length')) > MAXIMO_DE_IMAGEN) throw new Error(`The image is too big (at most ${MAXIMO_DE_IMAGEN / 1048576} MB)`);
  const bytes = new Uint8Array(await respuesta.arrayBuffer());
  return { bytes, nombre: decodeURIComponent(direccion.pathname.split('/').pop() || 'image') };
}
