#!/usr/bin/env node
// aia-studio MCP server: lets the AI the user already uses (Claude Desktop, Claude Code, Cursor...)
// handle the documents. Runs locally over stdio, without API keys. Works on the same files as the editor,
// so changes show live in the browser.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findObject } from '../src/core/document.js';
import { opsToSetPose } from '../src/core/blend.js';
import { guideForAI } from '../src/core/guide.js';
import { summarizeOperations } from '../src/core/operations.js';
import { createStore } from '../server/store.js';
import { loadSchema } from '../server/schema.js';
import { NO_PREVIEW, svgToPng } from '../server/png.js';
import { CURVE_NAMES } from '../src/core/curves.js';
import { rotationWarnings, planDeleteKeys, planMoveKeys, planScaleTime, planSetKeys, clipSummary } from './animation.js';
import { manifest, manifestText } from '../src/core/manifest.js';
import { usedAssets, assetMime, planAddImage } from '../src/core/images.js';
import { imageBytes, checkDeleted, treeOutline as tree,planBindByProximity, planBindPoints, planReparentBone, planPreview, poseClamps, historySummary, documentText } from './tools.js';

const schema = loadSchema();
const store = createStore({ schema });
const ORIGIN = 'ai';

const server = new McpServer(
  { name: 'aia-studio', version: '0.1.0' },
  {
    instructions:
      'aia-studio es un editor de animación 2D vectorial (personajes, objetos, íconos, escenas). Antes de crear o modificar un documento, lee get_guide. ' +
      'Antes de editar uno existente, mira get_history: las entradas con origen "user" son retoques a mano del usuario ' +
      'y no hay que pisarlos. Después de cambios visibles, revisa el resultado con render_preview.',
  },
);

const treeOutline = (doc, options) => tree(doc, schema, options);
// After a change, the tree goes without the clips' tracks (with many clips it was thousands of lines in each
// response): get_document gives them whole or for the requested clips.
const shortTree = (doc) => `${treeOutline(doc, { tracks: false })}\n(Clips resumidos: sus pistas, con get_document y clips.)`;

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

// Errors come back as a result and not as an exception, so the AI reads them and fixes the batch.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

const id = z.string().describe('id del documento, por ejemplo "robot"');
const target = z.string().describe('id del objeto, o "meta" para las propiedades del documento');
const props = z.record(z.string(), z.any()).describe('{ propiedad: valor }; ver get_guide');
const operation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    type: z.string().describe('tipo de objeto: ' + [...schema.types.keys()].join(', ')),
    id: z.string().describe('id nuevo: minúsculas, números y _'),
    parent: z.string().nullable().optional().describe('id del contenedor padre (group, switch o skeleton); un bone va dentro de un skeleton o de otro bone; omitido o null = raíz'),
    index: z.number().int().optional().describe('posición entre hermanos: 0 = al fondo; omitido = al frente'),
    props: props.optional(),
  }),
  z.object({ op: z.literal('set'), target: target, props }),
  z.object({ op: z.literal('unset'), target: target, props: z.array(z.string()).describe('propiedades que vuelven a su valor por defecto') }),
  z.object({ op: z.literal('delete'), target: z.string().describe('id del objeto; borra también sus hijos') }),
  z.object({
    op: z.literal('move'),
    target: z.string(),
    parent: z.string().nullable().optional().describe('nuevo padre; omitido = el mismo; null = raíz'),
    index: z.number().int().optional().describe('posición entre hermanos: 0 = al fondo; omitido = al frente'),
    keepPosition: z.boolean().optional().describe('true = recalcula x/y para que quede en el mismo lugar de la pantalla con el padre nuevo (no sirve para huesos: usa reparent_bone)'),
  }),
  z.object({ op: z.literal('rename'), target: z.string(), id: z.string().describe('id nuevo') }),
  z.object({
    op: z.literal('duplicate'),
    target: z.string().describe('objeto a copiar, con todos sus hijos'),
    id: z.string().optional().describe('id de la copia; por defecto <target>_<suffix>'),
    suffix: z.string().optional().describe('sufijo para los ids de los hijos copiados (por defecto "copy")'),
    parent: z.string().nullable().optional().describe('padre de la copia; omitido = el mismo que el original'),
    index: z.number().int().optional().describe('posición entre hermanos; omitido = justo delante del original'),
    props: props.optional().describe('propiedades a cambiar en la copia, por ejemplo { "x": 40 }'),
  }),
]);

server.registerTool(
  'get_guide',
  { description: 'Guía del formato: convenciones, tipos de objeto con todas sus propiedades y operaciones. Léela antes de editar.' },
  safe(async () => text(guideForAI(schema))),
);

server.registerTool(
  'list_documents',
  { description: 'Lista los documentos disponibles.' },
  safe(async () => text(await store.list())),
);

server.registerTool(
  'get_document',
  {
    description:
      'Devuelve un documento: primero su árbol de objetos (cada clip con sus pistas y keyframes) y después el JSON ' +
      'completo. En un documento grande, pide json: false y, con clips, solo las pistas de los clips que te interesan.',
    inputSchema: {
      id,
      json: z.boolean().optional().describe('false = solo el árbol. Por defecto va, salvo que la respuesta pase de 60 000 caracteres'),
      clips: z.array(z.string()).optional().describe('ids de clips cuyas pistas se listan en el árbol (por defecto, todos; [] = ninguno)'),
    },
  },
  safe(async ({ id, json, clips }) => text(documentText(await store.read(id), schema, { json, clips }))),
);

server.registerTool(
  'create_document',
  {
    description: 'Crea un documento vacío o, con copy_from, una copia de otro documento (sin su historial).',
    inputSchema: {
      id,
      name: z.string().optional().describe('nombre visible'),
      width: z.number().optional().describe('ancho del lienzo en px (por defecto 800)'),
      height: z.number().optional().describe('alto del lienzo en px (por defecto 800)'),
      background: z.string().nullable().optional().describe('color de fondo "#rrggbb"; null = transparente'),
      copy_from: z.string().optional().describe('id de un documento existente para copiar sus objetos'),
    },
  },
  safe(async ({ id, name, width, height, background, copy_from }) => {
    const meta = Object.fromEntries(Object.entries({ name, width, height, background }).filter(([, v]) => v !== undefined));
    const doc = await store.create(id, meta, { origin: ORIGIN, copyFrom: copy_from });
    return text(`Documento "${id}" creado${copy_from ? ` como copia de "${copy_from}"` : ''}.\n\nÁrbol:\n${shortTree(doc)}`);
  }),
);

server.registerTool(
  'apply_ops',
  {
    description:
      'Aplica un lote atómico de operaciones (create, set, unset, delete, move, rename, duplicate). Si algo falla ' +
      'no se aplica nada y se devuelven los errores. Cada lote es un paso de deshacer.',
    inputSchema: {
      id,
      ops: z.array(operation).min(1),
      note: z.string().describe('qué hace el lote, en pocas palabras (queda en el historial que ve el usuario)'),
    },
  },
  safe(async ({ id, ops, note }) => {
    const { doc, warnings } = await store.applyOps(id, ops, { origin: ORIGIN, note: note });
    const parts = [`Aplicadas ${ops.length} operaciones.`];
    if (warnings.length) parts.push(`Avisos:\n${warnings.map((a) => `- ${a}`).join('\n')}`);
    parts.push(`Árbol resultante (del fondo al frente):\n${shortTree(doc)}`);
    return text(parts.join('\n\n'));
  }),
);

const revert = (kind) =>
  safe(async ({ id }) => {
    const { doc, in: entry } = await store[kind](id, ORIGIN);
    const verb = kind === 'undo' ? 'Deshecho' : 'Rehecho';
    const touched = summarizeOperations(entry.lote).slice(0, 12).join(', ');
    const follows = kind === 'undo' ? ' Lo de los lotes anteriores sigue en pie.' : '';
    return text(`${verb} el lote #${entry.n} "${entry.note}" (${entry.ops} operaciones: ${touched}).${follows}\n\nÁrbol resultante:\n${shortTree(doc)}`);
  });

server.registerTool(
  'undo',
  {
    description:
      'Deshace tu último lote (solo los de la IA; nunca los retoques del usuario) y dice cuál deshizo. Si el usuario ' +
      'cambió después alguna de las mismas propiedades, se niega y dice cuáles y en qué lote: deshacer pisaría su retoque.',
    inputSchema: { id },
  },
  revert('undo'),
);

server.registerTool(
  'redo',
  { description: 'Rehace el último lote tuyo que deshiciste y dice cuál rehizo. Como undo, se niega si el usuario cambió después lo mismo.', inputSchema: { id } },
  revert('redo'),
);

server.registerTool(
  'get_history',
  {
    description:
      'Últimos cambios del documento, del más viejo al más nuevo. Por defecto es un resumen: origen ("ai" o ' +
      '"user"), nota y qué propiedades u objetos tocó cada lote. Los de origen "user" son retoques a mano: respétalos.',
    inputSchema: {
      id,
      limit: z.number().int().min(1).max(200).optional().describe('cuántos lotes (por defecto 20)'),
      origin: z.enum(['ai', 'user']).optional().describe('solo los lotes de ese origen'),
      detail: z.boolean().optional().describe('true = incluir las operaciones completas de cada lote'),
    },
  },
  safe(async ({ id, limit, origin, detail }) => {
    const { entries } = await store.history(id, 1000);
    return text(historySummary(entries, { limit, origin, detail }));
  }),
);

const region = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .describe('recorte del documento, en sus coordenadas (para ver un detalle de cerca)');

/** PNG of the document (posed, animated, live or cropped) as a tool result: the SVG and the text come from the plan. */
async function preview(id, doc, options, header) {
  const { svg, width, text: summary } = planPreview(doc, schema, options);
  // Image layers are drawn with the files from assets/; those that lack it are not shown and a warning is given.
  const images = await store.imagesOf(id, doc);
  const missing = usedAssets(doc).filter((src) => !images.has(src));
  const png = svgToPng(svg, options.width ?? width, images);
  const withoutView = [...images.keys()].filter((src) => NO_PREVIEW.has(assetMime(src)));
  let note = missing.length ? `\nFaltan en assets/ (esas capas image no se ven): ${missing.join(', ')}. Agrégalas con add_image.` : '';
  if (withoutView.length) note += `\n${withoutView.join(', ')}: WebP, que esta vista previa no sabe dibujar; sale como un recuadro gris con una cruz en su lugar y tamaño (el usuario la ve bien en el editor).`;
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
      'Agrega una imagen (PNG, JPG, WebP o SVG) como capa: copia el archivo a la carpeta assets/ del documento y crea ' +
      'un objeto image que lo usa, y devuelve cómo se ve. Por defecto va centrada en el lienzo, de su tamaño natural ' +
      '(achicada si no entra). Un SVG entra como imagen entera (sus formas no se editan). Para usar otra vez un ' +
      'archivo que ya está en assets/, crea el image con apply_ops y su src.',
    inputSchema: {
      id,
      path: z.string().optional().describe('ruta absoluta de un archivo local que indicó el usuario'),
      url: z.string().optional().describe('o una URL http(s) de la imagen'),
      layer: z.string().optional().describe('id de la capa nueva (por defecto, sale del nombre del archivo)'),
      parent: z.string().nullable().optional().describe('contenedor padre (group, switch o skeleton); omitido = raíz'),
      index: z.number().int().optional().describe('posición entre hermanos: 0 = al fondo; omitido = al frente'),
      x: z.number().optional().describe('x del centro (del pivote), relativa al padre; por defecto, el centro del lienzo'),
      y: z.number().optional().describe('y del centro, relativa al padre'),
      width: z.number().positive().optional().describe('ancho en px; solo width = alto en proporción'),
      height: z.number().positive().optional().describe('alto en px; solo height = ancho en proporción'),
      props: props.optional().describe('otras propiedades de la capa, por ejemplo { "opacity": 0.5, "originY": 1 }'),
      note: z.string().optional().describe('qué es, para el historial'),
    },
  },
  safe(async ({ id, path, url, layer, parent, index, x, y, width, height, props: extra, note }) => {
    const { bytes, name } = await imageBytes({ path, url });
    const { src, naturalWidth, naturalHeight, format, reused } = await store.saveAsset(id, name, bytes);
    const { id: layerId, ops } = planAddImage(await store.read(id), schema, { src, naturalWidth, naturalHeight, id: layer, parent: parent ?? null, index, x, y, width, height });
    if (extra) Object.assign(ops[0].props, extra);
    const { doc, warnings } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `add image ${layerId}` });
    const o = findObject(doc, layerId);
    const file = `${src} (${format.toUpperCase()}, ${naturalWidth}×${naturalHeight} px${reused ? ', ya estaba en assets/' : ''})`;
    return preview(id, doc, {}, `Capa image "${layerId}" con ${file}: x ${o.x}, y ${o.y}, ${o.width}×${o.height}.${warnings.length ? `\nAvisos: ${warnings.join('; ')}` : ''}`);
  }),
);

server.registerTool(
  'render_preview',
  {
    description:
      'Devuelve una imagen PNG del documento tal como lo ve el usuario. Úsala para revisar tus cambios. Con pose, ' +
      'muestra esa pose sola; con params, la mezcla de poses que dan los drivers con esos valores; con region, un ' +
      'recorte para ver un detalle; con bones, el esqueleto encima. Con animation, un clip: time = un cuadro; times (o ' +
      'nada) = una tira de cuadros en una sola imagen, para ver el movimiento (por defecto, en los tiempos de sus keyframes). ' +
      'Con live, un guion en vivo como lo correría la app (play, stop, set sobre los clips de Puppet, con fundidos, ' +
      'gestos encima de la base y las capas auto): times = los cuadros de la tira; params = los valores iniciales de la app.',
    inputSchema: {
      id,
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la imagen en px (por defecto 600)'),
      pose: z.string().optional().describe('id de una pose del documento; omitida = el montaje'),
      params: z
        .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
        .optional()
        .describe('{ id_de_param: valor } para ver la mezcla (los que falten van con su valor inicial; {} = todos iniciales)'),
      region: region.optional(),
      bones: z.boolean().optional().describe('true = dibujar los huesos encima, con su id (en el editor siempre se ven)'),
      animation: z.string().optional().describe('id de un clip (animation): muestra el clip en time, o una tira de cuadros en times; en un clip de puppet, params se suman encima (una escena se ve sin params ni drivers y los rechaza)'),
      time: z.number().min(0).optional().describe('con animation: un solo cuadro, en segundos'),
      times: z.array(z.number().min(0)).max(24).optional().describe('con animation: tiempos de la tira de cuadros, en segundos (por defecto, los de sus keyframes); con live, los cuadros del guion (por defecto cada 0.25 s)'),
      live: z
        .array(
          z.object({
            t: z.number().min(0).describe('segundos desde el inicio'),
            play: z.string().optional().describe('id de un clip de Puppet: uno en loop pasa a ser la base; uno once es un gesto encima'),
            stop: z.union([z.string(), z.literal(true)]).optional().describe('id de un clip que sale con su fundido, o true para todos'),
            set: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('{ id_de_param: valor } que pone la app'),
          }),
        )
        .optional()
        .describe('guion en vivo: eventos con t y uno de play, stop o set; por ejemplo [{ "t": 0, "play": "idle" }, { "t": 0.5, "play": "wave" }, { "t": 1, "set": { "happiness": 1 } }]. No va con animation ni pose. El azar de los auto repeat usa una semilla fija: el mismo guion da la misma tira'),
      until: z.number().positive().optional().describe('con live: hasta qué segundo dibujar la tira (por defecto, hasta que termina el último gesto disparado); como mucho 24 cuadros, repartidos'),
      auto: z.boolean().optional().describe('con live: false apaga las capas auto (parpadeo, respiración) para comparar'),
    },
  },
  safe(async ({ id, ...options }) => preview(id, await store.read(id), options)),
);

server.registerTool(
  'bind_points',
  {
    description:
      'Enlace por punto: cada vértice del path pasa a seguir al hueso más cercano (en el montaje) de la lista dada, ' +
      'o de todos los del skeleton que contiene al path. Así un solo path se dobla con una cadena de huesos (cola, ' +
      'brazo, cuello). Cada vértice queda con "bone"; se puede retocar después con set.',
    inputSchema: {
      id,
      path: z.string().describe('id del path'),
      bones: z.array(z.string()).optional().describe('huesos de su skeleton entre los que repartir (por defecto, todos los de su skeleton)'),
      note: z.string().optional().describe('qué hace, para el historial'),
    },
  },
  safe(async ({ id, path, bones, note }) => {
    const { ops, distribution } = planBindPoints(await store.read(id), schema, path, bones);
    await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `distribute ${path} among bones` });
    return text(`Vértices de ${path} por hueso: ${distribution}. Míralo con render_preview y una pose.`);
  }),
);

server.registerTool(
  'bind_by_proximity',
  {
    description:
      'Bind all by proximity: enlaza (por capa) al hueso más cercano todo el dibujo del skeleton que todavía no sigue ' +
      'a ningún hueso. Elige por el centro de la caja de cada pieza, en el montaje. Enlaza piezas enteras: un grupo ' +
      'sin nada enlazado adentro va completo; si adentro ya hay algo enlazado, enlaza solo lo que falta. No toca lo ya ' +
      'enlazado (ni los paths enlazados por punto). No mueve nada: se nota recién en las poses. Conviene revisar el ' +
      'reparto que devuelve y corregir con set lo que haya caído en un hueso equivocado.',
    inputSchema: {
      id,
      skeleton: z.string().describe('id del skeleton'),
      note: z.string().optional().describe('qué hace, para el historial'),
    },
  },
  safe(async ({ id, skeleton, note }) => {
    const { ops, bindings, distribution } = planBindByProximity(await store.read(id), schema, skeleton);
    if (!ops.length) return text(`Todo el dibujo de ${skeleton} ya sigue a un hueso; no hubo nada que enlazar.`);
    await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `bind all by proximity in ${skeleton}` });
    return text(`Enlazados ${bindings.length}: ${distribution}. Míralo con render_preview y una pose (bones: true).`);
  }),
);

server.registerTool(
  'reparent_bone',
  {
    description:
      'Cambia el padre de un hueso sin moverlo en el montaje: sus x, y, rotation (y escala y límites) se recalculan ' +
      'en el marco del padre nuevo, y también los valores que las poses le fijan. El padre puede ser otro hueso del ' +
      'mismo skeleton o el propio skeleton (para dejarlo como hueso raíz). Sus hijos lo siguen como siempre. Usa esto ' +
      'en vez de move, que conserva los valores relativos y por eso corre el hueso de lugar. Ojo: en una pose que ' +
      'mueve al padre viejo (o a un ancestro que el nuevo no comparte) o al padre nuevo, el hueso sí cambia de lugar, ' +
      'porque ahora sigue a otro; la respuesta lista esas poses. Con keep_in_poses: true, también se ajustan esas ' +
      'poses para que quede donde estaba.',
    inputSchema: {
      id,
      bone: z.string().describe('id del hueso que cambia de padre'),
      parent: z.string().describe('id del hueso padre nuevo, o del skeleton para dejarlo como raíz'),
      keep_in_poses: z.boolean().optional().describe('true = fija en las poses afectadas los valores que lo dejan donde estaba (por defecto, solo avisa)'),
      note: z.string().optional().describe('qué hace, para el historial'),
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
      'Crea o actualiza una pose con nombre (recurso pose) sin tocar el montaje, y devuelve cómo se ve. Una pose fija ' +
      'propiedades animables de cualquier objeto: huesos, vértices de una boca (también con "d"), colores, opacidad, ' +
      'el hijo activo de un switch... Por defecto se suma a lo que la pose ya tenía; un objeto con {} sale de la pose ' +
      'entero; remove saca solo algunas propiedades (["mouth.active"]) sin tocar el resto de ese objeto.',
    inputSchema: {
      id,
      pose: z.string().describe('id de la pose, por ejemplo "happy", "look_up" o "viseme_o"'),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .optional()
        .describe('{ id_de_objeto: { propiedad: valor } }, por ejemplo { "head_bone": { "rotation": -10 }, "mouth": { "active": "mouth_o" } }'),
      replace: z.boolean().optional().describe('true = la pose queda solo con estos valores'),
      remove: z
        .array(z.string())
        .optional()
        .describe('propiedades que salen de la pose, como "objeto.propiedad" (por ejemplo "mouth.active"); un id solo saca el objeto entero. Se aplica antes que values'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
      show_bones: z.boolean().optional().describe('true = la vista previa muestra el esqueleto'),
    },
  },
  safe(async ({ id, pose, values, replace, remove, note, width, show_bones }) => {
    const ops = opsToSetPose(await store.read(id), pose, values ?? {}, replace, remove ?? []);
    const { doc, warnings } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `pose ${pose}` });
    const saved = findObject(doc, pose).values;
    const list = Object.entries(saved).map(([h, c]) => `${h} ${JSON.stringify(c, (k, v) => (k === 'vertices' ? `(${v.length} vértices)` : v))}`).join(', ') || 'vacía';
    const notes = [...warnings, ...poseClamps(doc, schema, saved)];
    return preview(id, doc, { width, pose, bones: show_bones }, `Pose "${pose}": ${list}.${notes.length ? `\nAvisos: ${notes.join('; ')}` : ''}`);
  }),
);

const moment = z.object({
  t: z.number().min(0).describe('tiempo en segundos'),
  values: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional()
    .describe('{ id_de_objeto: { propiedad: valor } } absolutos, como en set_pose (un path acepta "d"); por ejemplo { "arm_r_bone": { "rotation": -60 }, "tail": { "opacity": 0.5 } }. Un número puede ser relativo al montaje con un texto "+=n" o "-=n": { "head_bone": { "rotation": "+=14" } } = 14° más que en el montaje. En un clip de puppet, si un param elige una variante (visemas), anima el param en params y no el active del switch; en una escena (animate), keya el active'),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('solo en un clip de puppet: { id_de_param: valor } en ese momento, por ejemplo { "happiness": 1, "viseme": "o" }; sus drivers suman las poses. Una escena (animate) no anima params ni tiene drivers: copia la pose con pose o keya los valores'),
  pose: z.string().optional().describe('id de una pose: copia sus valores como keyframes en ese momento (values los pisa); con only o except, solo una parte'),
  only: z.array(z.string()).optional().describe('con pose: copiar solo esto de la pose ("objeto.propiedad" o un id), por ejemplo ["eye_l", "eye_r", "mouth.active"]'),
  except: z.array(z.string()).optional().describe('con pose: copiar todo menos esto ("objeto.propiedad" o un id), por ejemplo ["tail_bone"]'),
  setup: z.boolean().optional().describe('true = en ese momento, todo lo que el clip anima (y lo que fija pose, si la pasas) vuelve al valor del montaje, y en puppet sus params al inicial; values los pisa. Sirve para empezar y terminar en reposo'),
  targets: z.array(z.string()).optional().describe('con un momento que solo trae ease: a qué pistas cambiarle la curva ("objeto.propiedad" o un id); por defecto, a todas las que tienen keyframe en ese t'),
  ease: z
    .union([z.enum(CURVE_NAMES), z.array(z.number()).length(4)])
    .optional()
    .describe('curva del tramo que SALE de estos keyframes hacia los siguientes: linear (por defecto), step, ease-in, ease-out, ease-in-out, las fuertes (ease-in-quad, -cubic, -expo, -back y sus -out y -in-out; la guía dice qué hace cada una) o [x1, y1, x2, y2] (cubic-bezier de CSS). Un momento con solo t y ease cambia la curva de los keyframes que ya hay en ese t, sin tocar sus valores'),
});

server.registerTool(
  'set_keys',
  {
    description:
      'Crea o actualiza un clip de animación (recurso animation) pensando en momentos: en cada t, cómo está el ' +
      'personaje (values, como en set_pose), qué pose toma (pose) o, solo en un clip de puppet, qué valor tienen los ' +
      'params (params). Una escena (animate) se ve sin params ni drivers: montaje + keyframes; ahí una expresión se ' +
      'copia con pose y una variante se elige keyando el active del switch. Cada ' +
      'propiedad queda como keyframe en ese tiempo; uno que ya existía en el mismo t se reemplaza. Crea el clip si no ' +
      'existe y alarga duration si un keyframe la pasa. Solo cambia las pistas que nombras: las demás (también los ' +
      'retoques del usuario) quedan como estaban, y undo va por pista. Para alargar un clip basta con duration. ' +
      'Devuelve una tira de cuadros del clip. usage: "puppet" para ' +
      'clips del muñeco (saludo, parpadeo, reposo; escribe description), "animate" para una timeline de escena. ' +
      'En puppet, fade, next, blend y auto dicen cómo suena en vivo (ver get_guide y render_preview con live).',
    inputSchema: {
      id,
      animation: z.string().describe('id del clip, por ejemplo "wave", "blink" o "idle"'),
      keys: z.array(moment).optional().describe('los momentos, en cualquier orden'),
      usage: z.enum(['animate', 'puppet']).optional().describe('al crear, por defecto "animate"'),
      duration: z.number().positive().optional().describe('duración en segundos'),
      loop: z.enum(['once', 'loop', 'pingpong']).optional(),
      description: z.string().optional().describe('qué hace el clip (para la IA de la app que lo dispara)'),
      fade: z.number().min(0).optional().describe('solo puppet: segundos del fundido al entrar y salir en vivo (por defecto 0.2; 0 = de golpe, como un parpadeo)'),
      next: z.string().nullable().optional().describe('solo puppet, clip once: el clip que se dispara cuando este empieza a salir (surprised → idle); null lo quita'),
      blend: z.enum(['override', 'additive']).optional().describe('solo puppet: override (por defecto) pisa lo de abajo; additive suma su diferencia con el montaje (respiración)'),
      auto: z.enum(['off', 'repeat', 'always']).optional().describe('solo puppet: off (lo dispara la app), repeat (solo, cada repeat_min…repeat_max s: parpadeo) o always (siempre en loop: respiración)'),
      repeat_min: z.number().min(0).optional().describe('con auto repeat: espera mínima en segundos (por defecto 2)'),
      repeat_max: z.number().min(0).optional().describe('con auto repeat: espera máxima en segundos (por defecto 6)'),
      remove: z.array(z.string()).optional().describe('pistas que salen del clip antes de agregar: "objeto.propiedad" o un id (todas las de ese objeto)'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
      show_bones: z.boolean().optional().describe('true = la vista previa muestra el esqueleto'),
    },
  },
  safe(async ({ id, animation, keys, usage, duration, loop, description, remove, note, width, show_bones, ...live }) => {
    const plan = planSetKeys(await store.read(id), schema, animation, { keys, usage, duration, loop, description, remove, ...live });
    const { doc, warnings } = await store.applyOps(id, plan.ops, { origin: ORIGIN, note: note ?? `animation ${animation}` });
    const notes = [...warnings];
    if (plan.extendedFrom != null) notes.push(`duration pasó de ${plan.extendedFrom} a ${plan.duration} s para que entren los keyframes`);
    notes.push(...rotationWarnings(doc, schema, findObject(doc, animation)));
    // The clip view already lists which poses each animated param moves (planClipView).
    return preview(id, doc, { width, animation, bones: show_bones }, notes.length ? `Avisos: ${notes.join('; ')}` : '');
  }),
);

server.registerTool(
  'delete_keys',
  {
    description:
      'Quita keyframes de un clip: los de ciertos tiempos (times), los de ciertas pistas (targets: "objeto.propiedad" o ' +
      'un id) o los dos a la vez (esas pistas en esos tiempos). Sin times, las pistas elegidas salen enteras.',
    inputSchema: {
      id,
      animation: z.string().describe('id del clip'),
      times: z.array(z.number().min(0)).optional().describe('tiempos en segundos (tolerancia de 1 ms)'),
      targets: z.array(z.string()).optional().describe('pistas: "objeto.propiedad" o un id de objeto'),
      note: z.string().optional().describe('qué hace, para el historial'),
    },
  },
  safe(async ({ id, animation, times, targets, note }) => {
    const { ops, removed } = planDeleteKeys(await store.read(id), animation, { times, targets });
    if (!ops.length) return text(`No había keyframes que quitar en "${animation}" con esos tiempos y pistas.`);
    const { doc } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `delete keys in ${animation}` });
    return text(`Quitados ${removed} keyframes. ${animation}: ${clipSummary(schema, findObject(doc, animation))}.`);
  }),
);

server.registerTool(
  'move_keys',
  {
    description:
      'Mueve en el tiempo los keyframes de un momento de un clip (from → to), con su valor y su curva: en todas las ' +
      'pistas que tienen keyframe en from, o solo en targets. Falla si en to ya hay un keyframe en alguna de esas ' +
      'pistas (lo borraría) o si to pasa la duración (alárgala antes con set_keys y duration).',
    inputSchema: {
      id,
      animation: z.string().describe('id del clip'),
      from: z.number().min(0).describe('tiempo actual de los keyframes, en segundos (tolerancia de 1 ms)'),
      to: z.number().min(0).describe('tiempo nuevo, en segundos'),
      targets: z.array(z.string()).optional().describe('pistas: "objeto.propiedad" o un id de objeto (por defecto, todas las que tienen keyframe en from)'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
    },
  },
  safe(async ({ id, animation, from, to, targets, note, width }) => {
    const { ops, moved } = planMoveKeys(await store.read(id), schema, animation, { from, to, targets });
    const { doc } = await store.applyOps(id, ops, { origin: ORIGIN, note: note ?? `move keys in ${animation} ${from} → ${to} s` });
    return preview(id, doc, { width, animation }, `Movidos de ${from} a ${to} s: ${moved.join(', ')}.`);
  }),
);

server.registerTool(
  'scale_time',
  {
    description:
      'Estira o comprime el tiempo de un clip en proporción, en un solo paso de deshacer: todos los keyframes (con su ' +
      'valor y su curva) y la duración. Con from y to, solo ese tramo: sus keyframes se reparten en el largo nuevo y ' +
      'los de después se corren. Para acortar un saludo de 1.8 a 1 s: duration 1. Para que vaya el doble de rápido: factor 0.5.',
    inputSchema: {
      id,
      animation: z.string().describe('id del clip'),
      duration: z.number().positive().optional().describe('largo nuevo en segundos, del clip entero o del tramo from…to'),
      factor: z.number().positive().optional().describe('en vez de duration: cuántas veces el largo actual (0.5 = el doble de rápido, 2 = la mitad de rápido)'),
      from: z.number().min(0).optional().describe('inicio del tramo, en segundos (por defecto 0)'),
      to: z.number().min(0).optional().describe('fin del tramo, en segundos (por defecto, la duración del clip)'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
    },
  },
  safe(async ({ id, animation, duration, factor, from, to, note, width }) => {
    const plan = planScaleTime(await store.read(id), schema, animation, { duration, factor, from, to });
    const span = from == null && to == null ? '' : ` (tramo ${plan.from}…${plan.to} s → ${plan.length} s)`;
    const { doc } = await store.applyOps(id, plan.ops, { origin: ORIGIN, note: note ?? `scale time of ${animation}: ${plan.before} → ${plan.duration} s` });
    return preview(id, doc, { width, animation }, `${animation}: ${plan.before} → ${plan.duration} s${span}.`);
  }),
);

server.registerTool(
  'get_manifest',
  {
    description:
      'El manifiesto del muñeco: lo que verá la IA de la app para manejarlo en vivo con play(clip), set(param, valor) ' +
      'y stop(clip). Params (rango, valor inicial, descripción y qué poses mueve cada uno), clips que se disparan (base ' +
      'o gesto, con su descripción) y capas automáticas. Revísalo al terminar un Puppet: lo que falte o confunda aquí ' +
      '(una descripción vacía, un param que no mueve nada) es lo que confundirá a la app.',
    inputSchema: { id, format: z.enum(['text', 'json']).optional().describe('text (por defecto) para leerlo; json, el objeto que recibe la app') },
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
      'Borra un documento y su historial. NO se puede deshacer. Úsalo solo si el usuario lo pidió (por ejemplo, para ' +
      'limpiar documentos de prueba); repite el id en confirm.',
    inputSchema: {
      id,
      confirm: z.string().describe('el mismo id del documento, para confirmar'),
    },
  },
  safe(async ({ id, confirm }) => {
    checkDeleted(id, confirm);
    await store.delete(id);
    return text(`Documento "${id}" borrado (con su historial).`);
  }),
);

await server.connect(new StdioServerTransport());
