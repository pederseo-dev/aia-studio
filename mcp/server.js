#!/usr/bin/env node
// Servidor MCP de aia-studio: deja que la IA que el usuario ya usa (Claude Desktop, Claude Code, Cursor...)
// maneje los personajes. Corre en local por stdio, sin API keys. Trabaja sobre los mismos archivos que el editor,
// así que los cambios se ven en vivo en el navegador.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buscar, hijos } from '../src/core/documento.js';
import { CAMPOS_DE_POSE, evaluarEsqueleto, puntaDe } from '../src/core/esqueleto.js';
import { aplicar } from '../src/core/geometria.js';
import { leerMeta } from '../src/core/esquema.js';
import { guiaParaIA } from '../src/core/guia.js';
import { resumirOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';
import { crearAlmacen } from '../servidor/almacen.js';
import { cargarEsquema } from '../servidor/esquema.js';
import { svgAPng } from '../servidor/png.js';

const esquema = cargarEsquema();
const almacen = crearAlmacen({ esquema });
const ORIGEN = 'ai';

const servidor = new McpServer(
  { name: 'aia-studio', version: '0.1.0' },
  {
    instructions:
      'aia-studio es un editor de personajes 2D. Antes de crear o modificar un documento, lee get_guide. ' +
      'Antes de editar uno existente, mira get_history: las entradas con origen "user" son retoques a mano del usuario ' +
      'y no hay que pisarlos. Después de cambios visibles, revisa el resultado con render_preview.',
  },
);

const texto = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

// Los errores vuelven como resultado y no como excepción, para que la IA los lea y corrija el lote.
const seguro = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

/** Árbol legible del documento: una línea por objeto, indentado por jerarquía, del fondo al frente. */
function esquemaDelArbol(doc) {
  const lineas = [];
  const { reposo } = evaluarEsqueleto(doc, esquema);
  const r = (v) => Math.round(v);
  const recorrer = (padre, nivel) => {
    for (const o of hijos(doc, padre)) {
      let detalle = '';
      if (o.bone) detalle = ` → hueso ${o.bone}`;
      if (o.type === 'pose') detalle = ` [${Object.keys(o.bones ?? {}).join(', ') || 'vacía'}]`;
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

const id = z.string().describe('id del documento, por ejemplo "robot"');
const objetivo = z.string().describe('id del objeto, o "meta" para las propiedades del documento');
const props = z.record(z.string(), z.any()).describe('{ propiedad: valor }; ver get_guide');
const operacion = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    type: z.string().describe('tipo de objeto: ' + [...esquema.tipos.keys()].join(', ')),
    id: z.string().describe('id nuevo: minúsculas, números y _'),
    parent: z.string().nullable().optional().describe('id del grupo padre (o del hueso padre, para un bone); omitido o null = raíz'),
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
  { description: 'Lista los documentos (personajes) disponibles.' },
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
      'Aplica un lote atómico de operaciones (create, set, unset, delete, move, rename). Si algo falla no se ' +
      'aplica nada y se devuelven los errores. Cada lote es un paso de deshacer.',
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
    return texto(`${verbo} el lote #${entrada.n} "${entrada.nota}" (${entrada.ops} operaciones).\n\nÁrbol resultante:\n${esquemaDelArbol(doc)}`);
  });

servidor.registerTool(
  'undo',
  { description: 'Deshace tu último lote (solo los de la IA; nunca los retoques del usuario) y dice cuál deshizo.', inputSchema: { id } },
  revertir('deshacer'),
);

servidor.registerTool(
  'redo',
  { description: 'Rehace el último lote tuyo que deshiciste y dice cuál rehizo.', inputSchema: { id } },
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
      elegidas.map(({ inversas, ops, ...e }) => ({ ...e, ...(detail ? { ops } : { toca: resumirOperaciones(ops) }) })),
    );
  }),
);

const region = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .describe('recorte del documento, en sus coordenadas (para ver un detalle de cerca)');

/** PNG del documento (opcionalmente posado y recortado) como resultado de herramienta. */
function vistaPrevia(doc, { width, pose, region, bones }, encabezado) {
  if (pose && buscar(doc, pose)?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`no existe la pose "${pose}". Poses: ${poses.join(', ') || 'ninguna'}`);
  }
  const png = svgAPng(svgDocumento(doc, esquema, { pose, region, huesos: bones }), width ?? 600);
  const tamaño = region ? `recorte de ${region.width}×${region.height} en (${region.x}, ${region.y})` : `${leerMeta(esquema, doc, 'width')}×${leerMeta(esquema, doc, 'height')} px`;
  const resumen = `${tamaño}, ${doc.objects.length} objetos, ${pose ? `en la pose "${pose}"` : 'en el montaje'}.`;
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
      'muestra al personaje en esa pose; con region, un recorte para ver un detalle; con bones, el esqueleto encima.',
    inputSchema: {
      id,
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la imagen en px (por defecto 600)'),
      pose: z.string().optional().describe('id de una pose del documento; omitida = el montaje'),
      region: region.optional(),
      bones: z.boolean().optional().describe('true = dibujar los huesos encima, con su id (en el editor siempre se ven)'),
    },
  },
  seguro(async ({ id, ...opciones }) => vistaPrevia(await almacen.leer(id), opciones)),
);

const camposDeHueso = z
  .object(Object.fromEntries(CAMPOS_DE_POSE.map((k) => [k, z.number().optional()])))
  .strict()
  .describe('valores absolutos del hueso en la pose, relativos a su hueso padre como en el montaje');

servidor.registerTool(
  'set_pose',
  {
    description:
      'Crea o actualiza una pose con nombre (recurso pose) sin tocar el montaje, y devuelve cómo se ve. Por defecto ' +
      'se suma a lo que la pose ya tenía; un hueso con {} vuelve al montaje dentro de la pose.',
    inputSchema: {
      id,
      pose: z.string().describe('id de la pose, por ejemplo "wave" o "look_up"'),
      bones: z.record(z.string(), camposDeHueso).describe('{ id_de_hueso: { rotation?, x?, y?, scaleX?, scaleY? } }'),
      replace: z.boolean().optional().describe('true = la pose queda solo con estos huesos'),
      note: z.string().optional().describe('qué hace, para el historial'),
      width: z.number().int().min(64).max(2048).optional().describe('ancho de la vista previa'),
      show_bones: z.boolean().optional().describe('true = la vista previa muestra el esqueleto'),
    },
  },
  seguro(async ({ id, pose, bones, replace, note, width, show_bones }) => {
    const existente = buscar(await almacen.leer(id), pose);
    if (existente && existente.type !== 'pose') throw new Error(`"${pose}" ya existe y es un ${existente.type}; elige otro id para la pose`);
    const valores = replace ? {} : structuredClone(existente?.bones ?? {});
    for (const [hueso, campos] of Object.entries(bones)) {
      if (Object.keys(campos).length) valores[hueso] = { ...valores[hueso], ...campos };
      else delete valores[hueso];
    }
    const ops = existente ? [{ op: 'set', target: pose, props: { bones: valores } }] : [{ op: 'create', type: 'pose', id: pose, props: { bones: valores } }];
    const { doc, avisos } = await almacen.operar(id, ops, { origen: ORIGEN, nota: note ?? `pose ${pose}` });
    const lista = Object.entries(valores).map(([h, c]) => `${h} ${JSON.stringify(c)}`).join(', ') || 'vacía';
    return vistaPrevia(doc, { width, pose, bones: show_bones }, `Pose "${pose}": ${lista}.${avisos.length ? `\nAvisos: ${avisos.join('; ')}` : ''}`);
  }),
);

await servidor.connect(new StdioServerTransport());
