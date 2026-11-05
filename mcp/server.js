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
import { svgDocumento, svgTira } from '../src/render/svg.js';
import { evaluarClip } from '../src/core/animacion.js';
import { crearAlmacen } from '../servidor/almacen.js';
import { cargarEsquema } from '../servidor/esquema.js';
import { svgAPng } from '../servidor/png.js';
import { planDeleteKeys, planSetKeys, resumenDeClip, tiemposParaTira } from './animacion.js';
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

const esquemaDelArbol = (doc) => arbol(doc, esquema);

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
  { description: 'Devuelve un documento: primero su árbol de objetos y después el JSON completo.', inputSchema: { id } },
  seguro(async ({ id }) => {
    const doc = await almacen.leer(id);
    return texto(`Árbol (del fondo al frente):\n${esquemaDelArbol(doc)}\n\nJSON:\n${JSON.stringify(doc, null, 2)}`);
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
    return texto(`Documento "${id}" creado${copy_from ? ` como copia de "${copy_from}"` : ''}.\n\nÁrbol:\n${esquemaDelArbol(doc)}`);
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
    partes.push(`Árbol resultante (del fondo al frente):\n${esquemaDelArbol(doc)}`);
    return texto(partes.join('\n\n'));
  }),
);

const revertir = (tipo) =>
  seguro(async ({ id }) => {
    const { doc, entrada } = await almacen[tipo](id, ORIGEN);
    const verbo = tipo === 'deshacer' ? 'Deshecho' : 'Rehecho';
    const tocaba = resumirOperaciones(entrada.lote).slice(0, 12).join(', ');
    const sigue = tipo === 'deshacer' ? ' Lo de los lotes anteriores sigue en pie.' : '';
    return texto(`${verbo} el lote #${entrada.n} "${entrada.nota}" (${entrada.ops} operaciones: ${tocaba}).${sigue}\n\nÁrbol resultante:\n${esquemaDelArbol(doc)}`);
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
function vistaPrevia(doc, { width, pose, region, bones, params, animation, time, times }, encabezado) {
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

/** Vista previa de un clip: un cuadro (time) o una tira de cuadros (times, o los tiempos de sus keyframes). */
function vistaDeClip(doc, { width, region, bones, params, animation, time, times }, encabezado) {
  const clip = buscar(doc, animation);
  if (clip?.type !== 'animation') {
    const clips = doc.objects.filter((o) => o.type === 'animation').map((o) => o.id);
    throw new Error(`there is no animation "${animation}".${sugerir(animation, clips)} Animations: ${clips.join(', ') || 'none'}`);
  }
  const tiempos = time != null ? [time] : times?.length ? times : tiemposParaTira(clip);
  const opciones = { animation, params: params ?? {}, region, huesos: bones };
  const svg = tiempos.length === 1 ? svgDocumento(doc, esquema, { ...opciones, time: tiempos[0] }) : svgTira(doc, esquema, { ...opciones, times: tiempos });
  const png = svgAPng(svg, width ?? (tiempos.length === 1 ? 600 : 1000));
  const animados = Object.keys(evaluarClip(doc, esquema, clip, 0).params);
  const cuadros = tiempos.length === 1 ? `cuadro en t = ${tiempos[0]} s` : `${tiempos.length} cuadros en t = ${tiempos.join(', ')} s`;
  const resumen = `Clip "${animation}" (${resumenDeClip(esquema, clip)}): ${cuadros}${animados.length ? `; el clip anima los params ${animados.join(', ')}` : ''}.`;
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
      'nada) = una tira de cuadros en una sola imagen, para ver el movimiento (por defecto, en los tiempos de sus keyframes).',
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
      animation: z.string().optional().describe('id de un clip (animation): muestra el clip en time, o una tira de cuadros en times; params se suman encima'),
      time: z.number().min(0).optional().describe('con animation: un solo cuadro, en segundos'),
      times: z.array(z.number().min(0)).max(24).optional().describe('con animation: tiempos de la tira de cuadros, en segundos (por defecto, los de sus keyframes)'),
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
    .describe('{ id_de_objeto: { propiedad: valor } } absolutos, como en set_pose (un path acepta "d"); por ejemplo { "arm_r_bone": { "rotation": -60 }, "mouth": { "active": "mouth_o" } }'),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('{ id_de_param: valor } en ese momento; sus drivers suman las poses'),
  pose: z.string().optional().describe('id de una pose: copia todos sus valores como keyframes en ese momento (values los pisa)'),
  setup: z.boolean().optional().describe('true = en ese momento, todo lo que el clip anima (y lo que fija pose, si la pasas) vuelve al valor del montaje, y sus params al inicial; values los pisa. Sirve para empezar y terminar en reposo'),
  targets: z.array(z.string()).optional().describe('con un momento que solo trae ease: a qué pistas cambiarle la curva ("objeto.propiedad" o un id); por defecto, a todas las que tienen keyframe en ese t'),
  ease: z
    .union([z.enum(['linear', 'step', 'ease-in', 'ease-out', 'ease-in-out']), z.array(z.number()).length(4)])
    .optional()
    .describe('curva del tramo que SALE de estos keyframes hacia los siguientes: linear (por defecto), step, ease-in, ease-out, ease-in-out o [x1, y1, x2, y2] (cubic-bezier de CSS). Un momento con solo t y ease cambia la curva de los keyframes que ya hay en ese t, sin tocar sus valores'),
});

servidor.registerTool(
  'set_keys',
  {
    description:
      'Crea o actualiza un clip de animación (recurso animation) pensando en momentos: en cada t, cómo está el ' +
      'personaje (values, como en set_pose), qué pose toma (pose) o qué valor tienen los params (params). Cada ' +
      'propiedad queda como keyframe en ese tiempo; uno que ya existía en el mismo t se reemplaza. Crea el clip si no ' +
      'existe y alarga duration si un keyframe la pasa. Solo cambia las pistas que nombras: las demás (también los ' +
      'retoques del usuario) quedan como estaban, y undo va por pista. Para alargar un clip basta con duration. ' +
      'Devuelve una tira de cuadros del clip. usage: "puppet" para ' +
      'clips del muñeco (saludo, parpadeo, reposo; escribe description), "animate" para una timeline de escena.',
    inputSchema: {
      id,
      animation: z.string().describe('id del clip, por ejemplo "wave", "blink" o "idle"'),
      keys: z.array(momento).optional().describe('los momentos, en cualquier orden'),
      usage: z.enum(['animate', 'puppet']).optional().describe('al crear, por defecto "animate"'),
      duration: z.number().positive().optional().describe('duración en segundos'),
      loop: z.enum(['once', 'loop', 'pingpong']).optional(),
      description: z.string().optional().describe('qué hace el clip (para la IA de la app que lo dispara)'),
      remove: z.array(z.string()).optional().describe('pistas que salen del clip antes de agregar: "objeto.propiedad" o un id (todas las de ese objeto)'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
      show_bones: z.boolean().optional().describe('true = la vista previa muestra el esqueleto'),
    },
  },
  seguro(async ({ id, animation, keys, usage, duration, loop, description, remove, note, width, show_bones }) => {
    const plan = planSetKeys(await almacen.leer(id), esquema, animation, { keys, usage, duration, loop, description, remove });
    const { doc, avisos } = await almacen.operar(id, plan.ops, { origen: ORIGEN, nota: note ?? `animation ${animation}` });
    const notas = [...avisos];
    if (plan.alargadaDesde != null) notas.push(`duration pasó de ${plan.alargadaDesde} a ${plan.duracion} s para que entren los keyframes`);
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
