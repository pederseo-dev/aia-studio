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
npm run mcp     # servidor MCP por stdio (normalmente lo arranca el cliente de IA)
```

> Estado: **fase 3** del [plan](docs/plan.md) (huesos y poses): dibujo con paths, estilos y degradados, sobre el editor y el MCP de
> la fase 1. El prototipo que probó la idea quedó en la etiqueta de git `prototipo-0`.

### Editor

Arriba: el menú **☰** (nuevo, abrir, copia, importar SVG, cerrar, eliminar, atajos), las **pestañas** de los
documentos abiertos (la × cierra la pestaña, el archivo queda en disco) y la barra con dos **grupos de
herramientas**: Transformar (Mover, Rotar, Escalar) y Crear (Pluma, Rectángulo, Elipse). La flecha ▾ de cada grupo
muestra las demás herramientas.

| Acción | Cómo |
| --- | --- |
| Seleccionar y mover | Herramienta `V`; arrastrar en el lienzo (Shift = un solo eje) o flechas (Shift = 10 px). |
| Seleccionar varios | Ctrl o Shift + clic; arrastrar en un lugar vacío hace un recuadro; en la jerarquía, Ctrl + clic suma y Shift + clic toma el tramo. `Ctrl+A` = todo, `Ctrl+G` = agrupar. Rotan y escalan desde el centro del conjunto; el inspector cambia lo que tienen en común. |
| Rotar y escalar | `T` y `S`: arrastrar en cualquier parte del lienzo gira o escala la selección desde su pivote. |
| Crear formas | `R` rectángulo, `E` elipse: arrastrar en el lienzo (Shift = cuadrado o círculo). |
| Pluma | `P`: clic = vértice recto, clic y arrastrar = curvo, clic en el primero = cerrar, Enter o Esc = terminar abierto. |
| Editar puntos | Doble clic en un path o Enter: arrastrar anclas y tangentes (Alt = separar), doble clic en un ancla = recto/curvo, clic en el contorno = agregar, Supr = borrar. Enter o Esc para salir. |
| Rotar, escalar, pivote | Manijas de la selección: círculo de arriba = rotar (Shift = de a 15°), esquinas = escalar desde el pivote (Shift = proporcional), punto del pivote = moverlo sin mover el dibujo (grupos y paths). |
| Estilos y degradados | «+ Estilo» y «+ Degradado» en Recursos; las formas los usan con `style` y `fillGradient` en el inspector. Lo que viene del estilo se ve en naranja. |
| Importar SVG | ☰ → «Importar SVG…»: las formas llegan como paths editables dentro de un grupo. |
| Huesos | `B`: arrastrar en vacío crea un hueso (hijo del seleccionado), desde su punta encadena otro, arrastrar un hueso lo gira, el círculo del origen lo mueve y Alt + la punta cambia dirección y largo. |
| Enlazar al esqueleto | Seleccionar el dibujo y un hueso (Ctrl + clic) y `Ctrl+B`, soltar el dibujo sobre el hueso en la jerarquía, o elegir `bone` en el inspector. Enlazar no mueve nada. |
| Poses | «Ver» en la barra: Montaje o una pose (o «＋ Nueva pose…»). En una pose, arrastrar un hueso o el dibujo enlazado lo gira sin tocar el montaje. |
| Grupos | `G` crea un grupo; arrastrar filas en la jerarquía para reordenar o meter dentro de un grupo; ▾/▸ pliega. |
| Duplicar | `Ctrl+D` duplica la selección con sus hijos; ☰ → «Hacer una copia…» copia el documento. |
| Pestañas | `+` crea un personaje, × o `Alt+W` cierra la pestaña, ☰ → «Abrir…» abre otro. Lo que crea la IA se abre en una pestaña nueva. |
| Renombrar | Doble clic en el árbol o el campo de id del inspector. |
| Ajustar valores | Escribir en el inspector o arrastrar sobre el nombre de la propiedad (Shift = fino, Alt = grueso). `↺` vuelve al valor por defecto. |
| Vista | Rueda = desplazar, Ctrl + rueda = zoom, Espacio + arrastrar o botón del medio = mover, `F` = ajustar, `1` = 100%; el botón de zoom tiene más opciones. |
| Deshacer | `Ctrl+Z` / `Ctrl+Shift+Z`. Solo deshace tus cambios; los de la IA los deshace la IA. |

### Conectar tu IA (MCP, sin API key)

La IA que ya usas maneja los personajes a través de un servidor MCP local (`mcp/server.js`). Trabaja sobre los
mismos archivos que el editor, así que lo que hace la IA aparece en vivo en el navegador y lo que retocas a mano
queda en el historial para que la IA lo respete.

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

Herramientas: `get_guide` (la guía del formato, generada desde el esquema), `list_documents`, `get_document`,
`create_document`, `apply_ops`, `undo`, `redo`, `get_history`, `set_pose` (crea o ajusta una pose con nombre) y
`render_preview` (devuelve un PNG para que la IA vea lo que hizo; con `pose`, `region` o `bones`).

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `schema/` | Definición de cada tipo (fuente única de verdad: validación, inspector y guía para la IA). |
| `src/core/` | Documento, validación, operaciones y evaluación. Sin DOM; corre en el navegador y en Node. |
| `src/render/` | Renderer SVG. |
| `src/editor/` | El editor web. |
| `servidor/` | Lectura y escritura en disco, y la API local que usa el editor (plugin de Vite). |
| `mcp/` | Servidor MCP para la IA. |
| `personajes/` | Los documentos de personajes. |
| `tests/` | Pruebas del núcleo (`node --test`). |
| `docs/pruebas-ia/` | Tareas y resultados de las pruebas con IA de cada fase. |
| `referencias/` | Código de terceros para estudiar (ignorado por git). |

## Documentación

- [docs/investigacion/moho-lua.md](docs/investigacion/moho-lua.md): cómo está construido
  Moho por detrás, a partir de su API Lua y su formato de archivo.
- [docs/investigacion/rive-runtime.md](docs/investigacion/rive-runtime.md): cómo está
  construido Rive a partir de su runtime de código abierto.
- [docs/sintesis.md](docs/sintesis.md): qué tomamos de cada uno y las decisiones de base
  para aia-studio.
- [docs/plan.md](docs/plan.md): plan de construcción por fases, con pruebas en el editor y con IA.
