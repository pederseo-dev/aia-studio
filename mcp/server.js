#!/usr/bin/env node
// Servidor MCP de aia-studio: deja que la IA que el usuario ya usa (Claude Desktop, Claude Code, Cursor...)
// maneje los documentos. Corre en local por stdio, sin API keys. Trabaja sobre los mismos archivos que el editor,
// así que los cambios se ven en vivo en el navegador.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buscar } from '../src/core/documento.js';
import { leerMeta, sugerir } from '../src/core/esquema.js';
import { pesoDeDriver, valoresDeParams } from '../src/core/mezcla.js';
import { guiaParaIA } from '../src/core/guia.js';
import { resumirOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';
import { crearAlmacen } from '../servidor/almacen.js';
import { cargarEsquema } from '../servidor/esquema.js';
import { svgAPng } from '../servidor/png.js';
import { NOMBRES_DE_CURVA } from '../src/core/curvas.js';
import { avisosDeGiro, errorDeVistaPrevia, planDeleteKeys, planMoveKeys, planScaleTime, planSetKeys, planVistaDeClip, planVistaEnVivo, resumenDeClip } from './animacion.js';
import { manifiesto, textoDeManifiesto } from '../src/core/manifiesto.js';
import { comprobarBorrado, esquemaDelArbol as arbol, opsDeSetPose, planBindByProximity, planBindPoints, planReparentBone, recortesDePose } from './herramientas.js';

const esquema = cargarEsquema();
const almacen = crearAlmacen({ esquema });
const ORIGEN = 'ai';

const servidor = new McpServer(
  { name: 'aia-studio', version: '0.1.0' },
  {
    instructions:
      'aia-studio es un editor de animación 2D vectorial (personajes, objetos, íconos, escenas). Antes de crear o modificar un documento, lee get_guide. ' +
      'Antes de editar uno existente, mira get_history: las entradas con origen "user" son retoques a mano del usuario ' +
      'y no hay que pisarlos. Después de cambios visibles, revisa el resultado con render_preview.',
  },
);

const esquemaDelArbol = (doc, opciones) => arbol(doc, esquema, opciones);
// Después de un cambio, el árbol va sin las pistas de los clips (con muchos clips eran miles de líneas en cada
// respuesta): get_document las da enteras o de los clips que se pidan.
const arbolCorto = (doc) => `${esquemaDelArbol(doc, { pistas: false })}\n(Clips resumidos: sus pistas, con get_document y clips.)`;
// Más que esto no entra cómodo en la respuesta: get_document deja el JSON afuera si no se pidió.
const MAXIMO_DE_RESPUESTA = 60000;

const texto = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

// Los errores vuelven como resultado y no como excepción, para que la IA los lea y corrija el lote.
const seguro = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

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

const id = z.string().describe('id del documento, por ejemplo "robot"');
const objetivo = z.string().describe('id del objeto, o "meta" para las propiedades del documento');
const props = z.record(z.string(), z.any()).describe('{ propiedad: valor }; ver get_guide');
const operacion = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    type: z.string().describe('tipo de objeto: ' + [...esquema.tipos.keys()].join(', ')),
    id: z.string().describe('id nuevo: minúsculas, números y _'),
    parent: z.string().nullable().optional().describe('id del contenedor padre (group, switch o skeleton); un bone va dentro de un skeleton o de otro bone; omitido o null = raíz'),
    index: z.number().int().optional().describe('posición entre hermanos: 0 = al fondo; omitido = al frente'),
    props: props.optional(),
  }),
  z.object({ op: z.literal('set'), target: objetivo, props }),
  z.object({ op: z.literal('unset'), target: objetivo, props: z.array(z.string()).describe('propiedades que vuelven a su valor por defecto') }),
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

servidor.registerTool(
  'get_guide',
  { description: 'Guía del formato: convenciones, tipos de objeto con todas sus propiedades y operaciones. Léela antes de editar.' },
  seguro(async () => texto(guiaParaIA(esquema))),
);

servidor.registerTool(
  'list_documents',
  { description: 'Lista los documentos disponibles.' },
  seguro(async () => texto(await almacen.listar())),
);

servidor.registerTool(
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
  seguro(async ({ id, json, clips }) => {
    const doc = await almacen.leer(id);
    const arbolTexto = `Árbol (del fondo al frente):\n${esquemaDelArbol(doc, { pistas: clips ?? true })}`;
    if (json === false) return texto(arbolTexto);
    const completo = JSON.stringify(doc, null, 2);
    if (json === undefined && arbolTexto.length + completo.length > MAXIMO_DE_RESPUESTA) {
      return texto(`${arbolTexto}\n\n(JSON omitido: el documento pesa ${completo.length} caracteres. Pide json: true si de verdad lo necesitas; para leer clips, usa clips.)`);
    }
    return texto(`${arbolTexto}\n\nJSON:\n${completo}`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, name, width, height, background, copy_from }) => {
    const meta = Object.fromEntries(Object.entries({ name, width, height, background }).filter(([, v]) => v !== undefined));
    const doc = await almacen.crear(id, meta, { origen: ORIGEN, copiarDe: copy_from });
    return texto(`Documento "${id}" creado${copy_from ? ` como copia de "${copy_from}"` : ''}.\n\nÁrbol:\n${arbolCorto(doc)}`);
  }),
);

servidor.registerTool(
  'apply_ops',
  {
    description:
      'Aplica un lote atómico de operaciones (create, set, unset, delete, move, rename, duplicate). Si algo falla ' +
      'no se aplica nada y se devuelven los errores. Cada lote es un paso de deshacer.',
    inputSchema: {
      id,
      ops: z.array(operacion).min(1),
      note: z.string().describe('qué hace el lote, en pocas palabras (queda en el historial que ve el usuario)'),
    },
  },
  seguro(async ({ id, ops, note }) => {
    const { doc, avisos } = await almacen.operar(id, ops, { origen: ORIGEN, nota: note });
    const partes = [`Aplicadas ${ops.length} operaciones.`];
    if (avisos.length) partes.push(`Avisos:\n${avisos.map((a) => `- ${a}`).join('\n')}`);
    partes.push(`Árbol resultante (del fondo al frente):\n${arbolCorto(doc)}`);
    return texto(partes.join('\n\n'));
  }),
);

const revertir = (tipo) =>
  seguro(async ({ id }) => {
    const { doc, entrada } = await almacen[tipo](id, ORIGEN);
    const verbo = tipo === 'deshacer' ? 'Deshecho' : 'Rehecho';
    const tocaba = resumirOperaciones(entrada.lote).slice(0, 12).join(', ');
    const sigue = tipo === 'deshacer' ? ' Lo de los lotes anteriores sigue en pie.' : '';
    return texto(`${verbo} el lote #${entrada.n} "${entrada.nota}" (${entrada.ops} operaciones: ${tocaba}).${sigue}\n\nÁrbol resultante:\n${arbolCorto(doc)}`);
  });

servidor.registerTool(
  'undo',
  {
    description:
      'Deshace tu último lote (solo los de la IA; nunca los retoques del usuario) y dice cuál deshizo. Si el usuario ' +
      'cambió después alguna de las mismas propiedades, se niega y dice cuáles y en qué lote: deshacer pisaría su retoque.',
    inputSchema: { id },
  },
  revertir('deshacer'),
);

servidor.registerTool(
  'redo',
  { description: 'Rehace el último lote tuyo que deshiciste y dice cuál rehizo. Como undo, se niega si el usuario cambió después lo mismo.', inputSchema: { id } },
  revertir('rehacer'),
);

servidor.registerTool(
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
  seguro(async ({ id, limit, origin, detail }) => {
    const { entradas } = await almacen.historial(id, 1000);
    const elegidas = entradas.filter((e) => !origin || e.origen === origin).slice(-(limit ?? 20));
    return texto(
      elegidas.map(({ inversas, ops, ...e }) => ({ ...e, ...(detail ? { ops } : { toca: resumirOperaciones(ops), valores: valoresFinales(ops) }) })),
    );
  }),
);

const region = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .describe('recorte del documento, en sus coordenadas (para ver un detalle de cerca)');

/** PNG del documento (opcionalmente posado, animado y recortado) como resultado de herramienta. */
function vistaPrevia(doc, { width, pose, region, bones, params, animation, time, times, live, until, auto }, encabezado) {
  const error = errorDeVistaPrevia({ pose, animation, time, times, live });
  if (error) throw new Error(error);
  if (live) return vistaDeClip(doc, { width, region, bones, params, live, times, until, auto }, encabezado, planVistaEnVivo);
  if (animation) return vistaDeClip(doc, { width, region, bones, params, animation, time, times }, encabezado);
  if (pose && buscar(doc, pose)?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`no existe la pose "${pose}". Poses: ${poses.join(', ') || 'ninguna'}`);
  }
  if (params) {
    const ids = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
    const raros = Object.keys(params).filter((k) => !ids.includes(k));
    if (raros.length) throw new Error(`no existe el param "${raros[0]}".${sugerir(raros[0], ids)} Params: ${ids.join(', ') || 'ninguno'}`);
  }
  const png = svgAPng(svgDocumento(doc, esquema, { pose, params, region, huesos: bones }), width ?? 600);
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
  const resumen = `${tamaño}, ${doc.objects.length} objetos, ${vista}.`;
  return {
    content: [
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: encabezado ? `${encabezado}\n${resumen}` : resumen },
    ],
  };
}

/** Vista previa de un clip (o de un guion en vivo) como resultado de herramienta: el SVG y el texto salen del plan. */
function vistaDeClip(doc, opciones, encabezado, plan = planVistaDeClip) {
  const { svg, ancho, texto: resumen } = plan(doc, esquema, opciones);
  const png = svgAPng(svg, opciones.width ?? ancho);
  return {
    content: [
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: encabezado ? `${encabezado}\n${resumen}` : resumen },
    ],
  };
}

servidor.registerTool(
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
  seguro(async ({ id, ...opciones }) => vistaPrevia(await almacen.leer(id), opciones)),
);

servidor.registerTool(
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
  seguro(async ({ id, path, bones, note }) => {
    const { ops, reparto } = planBindPoints(await almacen.leer(id), esquema, path, bones);
    await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `distribute ${path} among bones` });
    return texto(`Vértices de ${path} por hueso: ${reparto}. Míralo con render_preview y una pose.`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, skeleton, note }) => {
    const { ops, enlaces, reparto } = planBindByProximity(await almacen.leer(id), esquema, skeleton);
    if (!ops.length) return texto(`Todo el dibujo de ${skeleton} ya sigue a un hueso; no hubo nada que enlazar.`);
    await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `bind all by proximity in ${skeleton}` });
    return texto(`Enlazados ${enlaces.length}: ${reparto}. Míralo con render_preview y una pose (bones: true).`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, bone, parent, keep_in_poses, note }) => {
    const plan = planReparentBone(await almacen.leer(id), esquema, bone, parent, keep_in_poses);
    if (!plan.ops.length) return texto(plan.texto);
    const { doc } = await almacen.operar(id, plan.ops, { origen: ORIGEN, nota: note ?? `reparent ${bone} to ${parent}` });
    const h = buscar(doc, bone);
    return texto(`${plan.texto} (x ${h.x}, y ${h.y}, rotation ${h.rotation})`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, pose, values, replace, remove, note, width, show_bones }) => {
    const ops = opsDeSetPose(await almacen.leer(id), pose, values ?? {}, replace, remove ?? []);
    const { doc, avisos } = await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `pose ${pose}` });
    const guardada = buscar(doc, pose).values;
    const lista = Object.entries(guardada).map(([h, c]) => `${h} ${JSON.stringify(c, (k, v) => (k === 'vertices' ? `(${v.length} vértices)` : v))}`).join(', ') || 'vacía';
    const notas = [...avisos, ...recortesDePose(doc, esquema, guardada)];
    return vistaPrevia(doc, { width, pose, bones: show_bones }, `Pose "${pose}": ${lista}.${notas.length ? `\nAvisos: ${notas.join('; ')}` : ''}`);
  }),
);

const momento = z.object({
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
    .union([z.enum(NOMBRES_DE_CURVA), z.array(z.number()).length(4)])
    .optional()
    .describe('curva del tramo que SALE de estos keyframes hacia los siguientes: linear (por defecto), step, ease-in, ease-out, ease-in-out, las fuertes (ease-in-quad, -cubic, -expo, -back y sus -out y -in-out; la guía dice qué hace cada una) o [x1, y1, x2, y2] (cubic-bezier de CSS). Un momento con solo t y ease cambia la curva de los keyframes que ya hay en ese t, sin tocar sus valores'),
});

servidor.registerTool(
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
      keys: z.array(momento).optional().describe('los momentos, en cualquier orden'),
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
  seguro(async ({ id, animation, keys, usage, duration, loop, description, remove, note, width, show_bones, ...vivo }) => {
    const plan = planSetKeys(await almacen.leer(id), esquema, animation, { keys, usage, duration, loop, description, remove, ...vivo });
    const { doc, avisos } = await almacen.operar(id, plan.ops, { origen: ORIGEN, nota: note ?? `animation ${animation}` });
    const notas = [...avisos];
    if (plan.alargadaDesde != null) notas.push(`duration pasó de ${plan.alargadaDesde} a ${plan.duracion} s para que entren los keyframes`);
    notas.push(...avisosDeGiro(doc, esquema, buscar(doc, animation)));
    // La vista del clip ya lista qué poses mueve cada param animado (planVistaDeClip).
    return vistaPrevia(doc, { width, animation, bones: show_bones }, notas.length ? `Avisos: ${notas.join('; ')}` : '');
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, animation, times, targets, note }) => {
    const { ops, quitadas } = planDeleteKeys(await almacen.leer(id), animation, { times, targets });
    if (!ops.length) return texto(`No había keyframes que quitar en "${animation}" con esos tiempos y pistas.`);
    const { doc } = await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `delete keys in ${animation}` });
    return texto(`Quitados ${quitadas} keyframes. ${animation}: ${resumenDeClip(esquema, buscar(doc, animation))}.`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, animation, from, to, targets, note, width }) => {
    const { ops, movidas } = planMoveKeys(await almacen.leer(id), esquema, animation, { from, to, targets });
    const { doc } = await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `move keys in ${animation} ${from} → ${to} s` });
    return vistaPrevia(doc, { width, animation }, `Movidos de ${from} a ${to} s: ${movidas.join(', ')}.`);
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, animation, duration, factor, from, to, note, width }) => {
    const plan = planScaleTime(await almacen.leer(id), esquema, animation, { duration, factor, from, to });
    const tramo = from == null && to == null ? '' : ` (tramo ${plan.desde}…${plan.hasta} s → ${plan.largo} s)`;
    const { doc } = await almacen.operar(id, plan.ops, { origen: ORIGEN, nota: note ?? `scale time of ${animation}: ${plan.antes} → ${plan.duracion} s` });
    return vistaPrevia(doc, { width, animation }, `${animation}: ${plan.antes} → ${plan.duracion} s${tramo}.`);
  }),
);

servidor.registerTool(
  'get_manifest',
  {
    description:
      'El manifiesto del muñeco: lo que verá la IA de la app para manejarlo en vivo con play(clip), set(param, valor) ' +
      'y stop(clip). Params (rango, valor inicial, descripción y qué poses mueve cada uno), clips que se disparan (base ' +
      'o gesto, con su descripción) y capas automáticas. Revísalo al terminar un Puppet: lo que falte o confunda aquí ' +
      '(una descripción vacía, un param que no mueve nada) es lo que confundirá a la app.',
    inputSchema: { id, format: z.enum(['text', 'json']).optional().describe('text (por defecto) para leerlo; json, el objeto que recibe la app') },
  },
  seguro(async ({ id, format }) => {
    const m = manifiesto(await almacen.leer(id), esquema);
    return texto(format === 'json' ? m : textoDeManifiesto(m));
  }),
);

servidor.registerTool(
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
  seguro(async ({ id, confirm }) => {
    comprobarBorrado(id, confirm);
    await almacen.eliminar(id);
    return texto(`Documento "${id}" borrado (con su historial).`);
  }),
);

await servidor.connect(new StdioServerTransport());
