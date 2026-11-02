#!/usr/bin/env node
// Servidor MCP de aia-studio: deja que la IA que el usuario ya usa (Claude Desktop, Claude Code, Cursor...)
// maneje los personajes. Corre en local por stdio, sin API keys. Las herramientas llegan a partir de la fase 1.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FORMATO, CONVENCIONES } from '../src/core/formato.js';

const servidor = new McpServer(
  { name: 'aia-studio', version: '0.1.0' },
  { instructions: 'aia-studio es un editor de personajes 2D animables. Por ahora solo expone get_status.' },
);

servidor.registerTool(
  'get_status',
  { description: 'Devuelve la versión del formato y las convenciones de aia-studio.' },
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ formato: FORMATO, convenciones: CONVENCIONES }, null, 2) }] }),
);

await servidor.connect(new StdioServerTransport());
