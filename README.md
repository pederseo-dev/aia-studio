# aia-studio

Editor y runtime de personajes 2D animables, construido con HTML, CSS, JS y SVG.
Toma ideas de **Moho** (huesos, smart bones, switch layers) y de **Rive** (state machines,
runtime declarativo) y está pensado desde el comienzo para que **una IA manipule los
personajes** y **el usuario pueda corregir a mano** cuando haga falta.

## Principios

1. **El personaje es texto.** Todo personaje es un documento JSON legible y con nombres
   significativos (`head`, `mouth`, `happiness`), no un binario opaco.
2. **Una sola API para la IA y para el editor.** Cada acción del editor visual (mover un
   hueso, cambiar una boca, crear un keyframe) es una operación de la misma API que usa la IA.
   Lo que hace una, lo puede deshacer o corregir la otra.
3. **Parámetros de alto nivel.** La IA trabaja con controles semánticos
   (`happiness: 0.8`, `head_turn: -0.3`) que mueven muchas cosas a la vez, al estilo de los
   smart bones de Moho, en lugar de mover vértices sueltos.
4. **Construir la base de a poco.** Primero el formato y el runtime; después el editor
   encima, siempre sobre la misma base.

## Cómo usarlo

```bash
npm install
npm run dev     # editor en http://localhost:5173
npm test        # pruebas del núcleo
```

### Conectar tu IA (MCP, sin API key)

La IA que ya usas maneja los personajes a través de un servidor MCP local (`mcp/server.js`). Trabaja sobre los
mismos archivos de `personajes/` que el editor, así que lo que hace la IA aparece en vivo en el navegador y lo que
retocas a mano queda en el historial para que la IA lo respete.

- **Claude Code**: ya está configurado en [.mcp.json](.mcp.json); al abrir la carpeta te pide aprobarlo.
- **Claude Desktop**: agrega esto en *Settings → Developer → Edit Config* (`claude_desktop_config.json`) y reinicia:

  ```json
  {
    "mcpServers": {
      "aia-studio": {
        "command": "node",
        "args": ["C:\\Users\\olafp\\Desktop\\aia-studio\\mcp\\server.js"]
      }
    }
  }
  ```

- **Otros clientes MCP** (Cursor, etc.): el mismo comando, `node <ruta>/mcp/server.js`, por stdio.

Herramientas: `format_guide`, `list_characters`, `get_character`, `create_character`, `apply_ops`, `render_svg` y
`get_history`. El formato está en [docs/formato.md](docs/formato.md).

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `src/core/` | Formato, validación, operaciones y pose. Sin dependencias; corre en el navegador y en Node. |
| `src/runtime/` | `Avatar`: monta un personaje en la página y lo mueve con sus params. |
| `src/editor/` | El editor web. |
| `servidor/` | Lectura y escritura de personajes en disco, y la API local que usa el editor. |
| `mcp/` | Servidor MCP para la IA. |
| `personajes/` | Los personajes (`.json`) y su historial de cambios (`.historial.jsonl`). |
| `referencias/` | Código de terceros para estudiar (ignorado por git). |

## Documentación

- [docs/investigacion/moho-lua.md](docs/investigacion/moho-lua.md): cómo está construido
  Moho por detrás, a partir de su API Lua y su formato de archivo.
- [docs/investigacion/rive-runtime.md](docs/investigacion/rive-runtime.md): cómo está
  construido Rive a partir de su runtime de código abierto.
- [docs/sintesis.md](docs/sintesis.md): qué tomamos de cada uno y las decisiones de base
  para aia-studio.
- [docs/plan.md](docs/plan.md): plan de construcción por fases, con pruebas en el editor y con IA.
