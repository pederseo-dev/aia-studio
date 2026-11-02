#!/usr/bin/env node
// Servidor MCP de aia-studio: deja que la IA que el usuario ya usa (Claude Desktop, Claude Code, Cursor...)
// maneje los personajes. Corre en local por stdio, sin API keys. Trabaja sobre los mismos archivos que el editor,
// así que los cambios se ven en vivo en el navegador.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hijos } from '../src/core/documento.js';
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
  const recorrer = (padre, nivel) => {
    for (const o of hijos(doc, padre)) {
      lineas.push(`${'  '.repeat(nivel)}- ${o.id} (${o.type})`);
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
    parent: z.string().nullable().optional().describe('id del grupo padre; omitido o null = raíz'),
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

servidor.registerTool(
  'render_preview',
  {
    description: 'Devuelve una imagen PNG del documento tal como lo ve el usuario. Úsala para revisar tus cambios.',
    inputSchema: { id, width: z.number().int().min(64).max(2048).optional().describe('ancho de la imagen en px (por defecto 600)') },
  },
  seguro(async ({ id, width }) => {
    const doc = await almacen.leer(id);
    const png = svgAPng(svgDocumento(doc, esquema), width ?? 600);
    return {
      content: [
        { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${leerMeta(esquema, doc, 'width')}×${leerMeta(esquema, doc, 'height')} px, ${doc.objects.length} objetos.` },
      ],
    };
  }),
);

await servidor.connect(new StdioServerTransport());
