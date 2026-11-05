// Lógica de las herramientas del MCP, sin el transporte: funciones puras sobre un documento (más el almacén cuando
// guardan), para poder probarlas sin levantar el servidor. Los textos que devuelven los lee la IA.

import { buscar, hijos, huesosDe } from '../src/core/documento.js';
import { enlacesPorCercania, evaluarEsqueleto, huesoDe, limitarAngulo, puntaDe, reparentarHueso, repartirEntreHuesos } from '../src/core/esqueleto.js';
import { aplicar } from '../src/core/geometria.js';
import { leer } from '../src/core/esquema.js';
import { paramsDeSwitch } from '../src/core/mezcla.js';
import { resumenDeClip } from './animacion.js';

/** Árbol legible del documento: una línea por objeto, indentado por jerarquía, del fondo al frente. */
export function esquemaDelArbol(doc, esquema) {
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
      recorrer(o.id, nivel + 1);
    }
  };
  recorrer(null, 0);
  return lineas.length ? lineas.join('\n') : '(vacío)';
}

/**
 * set_pose: los valores nuevos de la pose. Por defecto se suman a los que ya tenía (por objeto, propiedad a
 * propiedad); un objeto con {} sale de la pose entero; con `replace`, la pose queda solo con estos. Un "d" nuevo
 * reemplaza los vértices que la pose ya tenía para ese path. `quitar` (["mouth.active", "brow_l"]) saca de la pose
 * una sola propiedad de un objeto, o el objeto entero; se aplica antes que `values`.
 */
export function fusionarPose(existentes, values = {}, replace = false, quitar = []) {
  const valores = replace ? {} : structuredClone(existentes ?? {});
  for (const nombre of quitar) {
    const [objeto, prop, ...sobra] = String(nombre).split('.');
    if (!objeto || sobra.length || prop === '') throw new Error(`remove: "${nombre}" should be "object.property" (for example "mouth.active") or an object id`);
    if (prop === undefined) delete valores[objeto];
    else if (valores[objeto]) {
      delete valores[objeto][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(valores[objeto]).length) delete valores[objeto];
    }
  }
  for (const [objeto, campos] of Object.entries(values)) {
    const previos = campos.d !== undefined ? (({ vertices, ...resto }) => resto)(valores[objeto] ?? {}) : valores[objeto];
    if (Object.keys(campos).length) valores[objeto] = { ...previos, ...campos };
    else delete valores[objeto];
  }
  return valores;
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

/** set_pose: el lote que crea o actualiza la pose. */
export function opsDeSetPose(doc, pose, values, replace = false, quitar = []) {
  const existente = buscar(doc, pose);
  if (existente && existente.type !== 'pose') throw new Error(`"${pose}" ya existe y es un ${existente.type}; elige otro id para la pose`);
  const valores = fusionarPose(existente?.values, values, replace, quitar);
  return existente ? [{ op: 'set', target: pose, props: { values: valores } }] : [{ op: 'create', type: 'pose', id: pose, props: { values: valores } }];
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
  const enlaces = enlacesPorCercania(doc, esquema, skeleton);
  const porHueso = {};
  for (const e of enlaces) (porHueso[e.bone] ??= []).push(e.id);
  const reparto = Object.entries(porHueso).map(([h, ids]) => `${h} ← ${ids.join(', ')}`).join('; ');
  return { ops: enlaces.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })), enlaces, reparto };
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
