#!/usr/bin/env node
// Servidor MCP de aia-studio: deja que la IA que el usuario ya usa (Claude Desktop, Claude Code, Cursor...)
// cree y modifique personajes. Corre en local por stdio, sin API keys.
// Trabaja sobre los mismos archivos que el editor, así que los cambios se ven en vivo en el navegador.

import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FORMATO } from '../src/core/documento.js';
import { evaluar, matricesDelMundo } from '../src/core/pose.js';
import { svgComoTexto } from '../src/core/svg.js';
import { crear, historial, leer, listar, modificar } from '../servidor/almacen.js';

const servidor = new McpServer(
  { name: 'aia-studio', version: '0.1.0' },
  {
    instructions:
      'aia-studio es un editor de personajes 2D animables (huesos + SVG + params). ' +
      'Antes de crear o modificar un personaje, lee format_guide. ' +
      'Antes de editar uno existente, mira get_history: las entradas con origen "user" son retoques a mano que no hay que pisar. ' +
      'Los cambios se ven en vivo en el editor (npm run dev).',
  },
);

const texto = (valor) => ({
  content: [{ type: 'text', text: typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2) }],
});

// Los errores vuelven como resultado (no como excepción) para que la IA los lea y corrija el lote.
const conErrores = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

const idPersonaje = z.string().describe('id del personaje (nombre del archivo sin .json), por ejemplo "prueba"');

const operacion = z.object({
  op: z.enum(['set', 'add', 'remove']),
  path: z.string().describe('Ruta legible, por ejemplo "rig.bones.head.rotation" o "rig.bones" para add'),
  value: z.any().optional().describe('Valor nuevo (set) o elemento a agregar (add)'),
  index: z.number().int().optional().describe('Posición en la lista (solo add; por defecto al final)'),
});

servidor.registerTool(
  'format_guide',
  { description: 'Devuelve la guía del formato de personaje y de las operaciones. Léela antes de editar.' },
  conErrores(async () => texto(await readFile(new URL('../docs/formato.md', import.meta.url), 'utf8'))),
);

servidor.registerTool(
  'list_characters',
  { description: 'Lista los ids de los personajes disponibles.' },
  conErrores(async () => texto(await listar())),
);

servidor.registerTool(
  'get_character',
  { description: 'Devuelve el documento JSON completo de un personaje.', inputSchema: { id: idPersonaje } },
  conErrores(async ({ id }) => texto(await leer(id))),
);

servidor.registerTool(
  'create_character',
  {
    description: 'Crea un personaje nuevo, vacío (solo un hueso raíz) o como copia de otro.',
    inputSchema: {
      id: idPersonaje,
      name: z.string().describe('Nombre visible'),
      copy_from: z.string().optional().describe('id de un personaje existente para usar como base'),
    },
  },
  conErrores(async ({ id, name, copy_from }) => {
    const base = copy_from
      ? await leer(copy_from)
      : {
          format: FORMATO,
          canvas: { width: 400, height: 400 },
          rig: { bones: [{ id: 'root', parent: null, x: 200, y: 395 }], parts: [], slots: [], params: [] },
          drivers: [],
        };
    await crear(id, { ...base, name }, { origen: 'ai', nota: copy_from ? `copia de ${copy_from}` : 'creado' });
    return texto(`Personaje "${id}" creado.`);
  }),
);

servidor.registerTool(
  'apply_ops',
  {
    description:
      'Aplica un lote atómico de operaciones (set, add, remove) a un personaje. ' +
      'Si el resultado no es válido no se aplica nada y se devuelven los errores.',
    inputSchema: {
      id: idPersonaje,
      ops: z.array(operacion).min(1),
      note: z.string().describe('Resumen corto del cambio, se guarda en el historial (por ejemplo "agrego sombrero")'),
    },
  },
  conErrores(async ({ id, ops, note }) => {
    await modificar(id, ops, { origen: 'ai', nota: note });
    return texto(`Aplicadas ${ops.length} operaciones a "${id}".`);
  }),
);

servidor.registerTool(
  'render_svg',
  {
    description:
      'Devuelve el SVG del personaje con los params indicados (los que falten usan su valor por defecto). ' +
      'Sirve para revisar el resultado de un cambio.',
    inputSchema: {
      id: idPersonaje,
      params: z.record(z.string(), z.number()).optional().describe('Por ejemplo { "happiness": 1, "mouth_open": 0.6 }'),
    },
  },
  conErrores(async ({ id, params }) => {
    const doc = await leer(id);
    const pose = evaluar(doc, params ?? {});
    return texto(svgComoTexto(doc, pose, matricesDelMundo(doc, pose)));
  }),
);

servidor.registerTool(
  'get_history',
  {
    description: 'Devuelve los últimos cambios de un personaje con su origen ("ai" o "user"), fecha, nota y operaciones.',
    inputSchema: { id: idPersonaje, limit: z.number().int().min(1).max(100).optional() },
  },
  conErrores(async ({ id, limit }) => texto(await historial(id, limit ?? 20))),
);

await servidor.connect(new StdioServerTransport());
