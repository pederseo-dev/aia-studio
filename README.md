<p align="center"><img src="public/logo.svg" alt="aia-studio" width="96" height="96" /></p>

# aia-studio

Editor y runtime de animación 2D vectorial (personajes, objetos, íconos, escenas), construido con HTML, CSS, JS y SVG.
Toma ideas de **Moho** (huesos, smart bones, switch layers) y de **Rive** (state machines,
runtime declarativo) y está pensado desde el comienzo para que **una IA manipule los
documentos** y **el usuario pueda corregir a mano** cuando haga falta.

## Principios

1. **El documento es texto.** Todo documento es JSON legible y con nombres
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

> Estado: **fase 5** del [plan](docs/plan.md) (animación: modos Design, Animate y Puppet, clips con keyframes y
> timeline), sobre las expresiones de la fase 4 (poses, params, drivers y switch), los huesos de la fase 3 y el dibujo
> de la fase 2. El prototipo que probó la idea quedó en la etiqueta de git `prototipo-0`.

### Editor

Arriba: el menú **☰** (nuevo, abrir, copia, importar SVG, cerrar, eliminar, atajos), las **pestañas** de los
documentos abiertos (la × cierra la pestaña, el archivo queda en disco) y la barra con dos **grupos de
herramientas**: Transformar (Mover, Rotar, Escalar) y Crear (Pluma, Rectángulo, Elipse). La flecha ▾ de cada grupo
muestra las demás herramientas.

| Acción | Cómo |
| --- | --- |
| Modos | Arriba a la derecha: **Design** (dibujo y rig: el montaje), **Animate** (una timeline de escena, para exportar) y **Puppet** (los controles del muñeco: poses, params, drivers y clips cortos que la app o su IA disparan). Ver [docs/decision-animacion.md](docs/decision-animacion.md). |
| Seleccionar y mover | Herramienta `V`; arrastrar en el lienzo (Shift = un solo eje) o flechas (Shift = 10 px). |
| Seleccionar varios | Ctrl o Shift + clic; arrastrar en un lugar vacío hace un recuadro; en Layers, Ctrl + clic suma y Shift + clic toma el tramo. `Ctrl+A` = todo, `Ctrl+G` = agrupar. Rotan y escalan desde el centro del conjunto; el inspector cambia lo que tienen en común. |
| Rotar y escalar | `T` y `S`: arrastrar en cualquier parte del lienzo gira o escala la selección desde su pivote. |
| Crear formas | `R` rectángulo, `E` elipse: arrastrar en el lienzo (Shift = cuadrado o círculo). |
| Pluma | `P`: clic = vértice recto, clic y arrastrar = curvo, clic en el primero = cerrar, Enter o Esc = terminar abierto. |
| Editar puntos | Doble clic en un path o Enter: arrastrar anclas y tangentes (Alt = separar), doble clic en un ancla = recto/curvo, clic en el contorno = agregar, Supr = borrar. Enter o Esc para salir. |
| Rotar, escalar, pivote | Manijas de la selección: círculo de arriba = rotar (Shift = de a 15°), esquinas = escalar desde el pivote (Shift = proporcional), punto del pivote = moverlo sin mover el dibujo (grupos, paths, rectángulos y elipses). |
| Estilos y degradados | Los botones de estilo y de degradado en Assets («New shared style», «New linear gradient»); las formas los usan con `style` y `fillGradient` en el inspector. Lo que viene del estilo se ve en naranja. |
| Importar SVG | ☰ → «Import SVG…»: las formas llegan como paths editables dentro de un grupo. |
| Skeleton (capa de huesos) | Como la *bone layer* de Moho: contiene el dibujo y sus huesos. En Layers, ▾ junto al botón de grupo → «Skeleton» (o `K`): mete la selección en un skeleton nuevo. Como en Moho, en Layers solo se ven las capas: los huesos se ven y se eligen en el lienzo. El dibujo de adentro queda quieto hasta enlazarlo. |
| Huesos | Cinco herramientas en el menú de huesos, como en Moho. **Add Bone** (`B`): arrastrar en vacío crea un hueso en el skeleton seleccionado o en el de la selección (hijo del hueso elegido; si no hay skeleton, se crea uno); desde la punta del hueso elegido encadena otro; un clic en un hueso lo elige. **Manipulate Bones** (`M`): arrastrar un hueso lo gira, el círculo del origen lo mueve y el de la punta cambia dirección y largo. **Reparent Bone**: el clic solo elige (Shift + clic suma; clic en vacío suelta); se eligen los hijos y al final el padre, y la barra de opciones hace el cambio con «Parent to …» o «Clear parent» (raíz), sin moverlos en el montaje; si en alguna pose cambian de lugar (porque la pose mueve al padre viejo o al nuevo), lo avisa y ofrece «Keep poses» para compensarlas; dibuja la jerarquía. Cada hueso tiene un color; al elegir uno se resaltan su padre y sus hijos, y la barra de opciones los nombra para ir a ellos. En una pose, cualquier herramienta posa. |
| Enlazar al esqueleto | Solo se enlaza a huesos del mismo skeleton. **Bind Layer** (`L`): clic en un hueso y después en el dibujo (o su fila en Layers) para que lo siga entero; otro clic lo suelta, Alt elige su grupo. **Bind Points**: clic en un hueso y después en puntos de los paths de su skeleton, o un recuadro alrededor; los puntos toman el color del hueso (Alt suelta). También: `Ctrl+B` con dibujo y hueso seleccionados, `bone` en el inspector, y «Bind all by proximity» con el skeleton seleccionado. Enlazar no mueve nada: el dibujo sigue al hueso en las poses. |
| Barra de opciones | Arriba del lienzo: qué se puede hacer con la herramienta y lo seleccionado, con botones para las acciones (por ejemplo, con un hueso: enlazar, ver lo enlazado, hueso hijo, probar en una pose). |
| Doblar con varios huesos | Editando los puntos de un path: «Distribute among bones» (o el hueso de cada punto) en la barra de opciones. En las poses, el path se dobla siguiendo la cadena. |
| Expresiones (Puppet) | Una pose puede cambiar cualquier cosa animable: en la pose, el inspector muestra arriba lo de la pose y Enter edita los puntos de la boca (morph). Abajo, en Parameters, «＋ Parameter» crea un control y «＋ Pose…» lo conecta a una pose; mover el control muestra la mezcla («View» → «Parameters (blend)»). Un switch muestra un solo hijo (`active`). |
| Poses (Puppet) | «View» (solo en Puppet): «Setup» o una pose (o «＋ New pose…»). En una pose, arrastrar un hueso o el dibujo enlazado lo gira sin tocar el montaje. |
| Clips (Puppet) | A la derecha, la biblioteca de clips: «＋ Clip» crea uno, clic en un clip lo abre en la timeline y ▶ lo reproduce. Abajo, la descripción del clip (para la IA de la app). |
| Escenas (Animate) | Abajo, el selector de escenas y «＋ Scene». |
| Timeline (Animate y Puppet) | Con un clip o escena abierto, todo lo que cambias (girar un hueso, el inspector, los puntos, los sliders de Parameters) queda como keyframe en el playhead (autokey; lo que suman los drivers no se guarda dos veces). Clic o arrastre en la regla mueve el playhead; ▶ reproduce según `loop`. «◆ Key» keya lo seleccionado, «◆ Pose…» una pose entera y «◆ Setup» vuelve al montaje. Un keyframe se elige con clic, se arrastra en el tiempo (con imán a los cuadros; no se suelta encima de otro), cambia de curva (`linear`, `ease-*`, `step` o `cubic-bezier…`) y se borra con Supr; × en el nombre de una pista la borra entera. ⚠ avisa si un driver suma encima de una pista. |
| Switch | En Layers, ▾ junto al botón de grupo → «Switch» (o `Shift+G`): mete la selección en un switch (cada objeto es una variante y se ve una a la vez; las ocultas aparecen en cursiva). El botón de variante de su fila en Layers (o la barra de opciones) elige cuál se ve, en el montaje o, en una pose, dentro de la pose. Al seleccionar una variante oculta, el lienzo la muestra mientras está seleccionada para poder editarla. Para que la elija un param, se arma a mano: un param (lista), una pose por variante que fija cuál se ve y un driver por opción. |
| Grupos | `G` crea un grupo; arrastrar filas en Layers para reordenar (al cambiar de padre, el objeto queda en el mismo lugar) o meter dentro de un grupo; ▾/▸ pliega. |
| Duplicar | `Ctrl+D` duplica la selección con sus hijos; ☰ → «Make a copy…» copia el documento. |
| Pestañas | `+` crea un documento nuevo, × o `Alt+W` cierra la pestaña, ☰ → «Open…» abre otro. Lo que crea la IA se abre en una pestaña nueva. |
| Renombrar | Doble clic en Layers o el campo de id del inspector. |
| Ajustar valores | Escribir en el inspector o arrastrar sobre el nombre de la propiedad (Shift = fino, Alt = grueso). `↺` vuelve al valor por defecto. |
| Vista | Rueda = desplazar, Ctrl + rueda = zoom, Espacio + arrastrar o botón del medio = mover, `F` = ajustar, `1` = 100%; el botón de zoom tiene más opciones. |
| Deshacer | `Ctrl+Z` / `Ctrl+Shift+Z`. Solo deshace tus cambios; los de la IA los deshace la IA. Si la IA cambió después lo mismo, no deshace y el aviso dice qué propiedades y en qué lote (y al revés). |

### Conectar tu IA (MCP, sin API key)

La IA que ya usas maneja los documentos a través de un servidor MCP local (`mcp/server.js`). Trabaja sobre los
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
`create_document`, `delete_document` (borra un documento con su historial; pide repetir el id en `confirm`),
`apply_ops`, `undo`, `redo`, `get_history`, `set_pose` (crea o ajusta una pose con nombre; `remove` saca propiedades
sueltas), `bind_points` (reparte los puntos de un path entre los huesos de su skeleton), `reparent_bone` (cambia el
padre de un hueso sin moverlo en el montaje; con `keep_in_poses`, tampoco en las poses), `bind_by_proximity` (enlaza
al hueso más cercano todo el dibujo de un skeleton que todavía no sigue a ninguno) y
`set_keys` (crea o ajusta un clip por momentos: `values`, `pose`, `params`, `setup` para volver al montaje, `ease`),
`delete_keys` (quita keyframes por tiempo o pista), `move_keys` (mueve los keyframes de un momento a otro) y
`render_preview` (devuelve un PNG para que la IA vea lo que hizo; con `pose`, `params`, `region` o `bones`, y con
`animation` + `time` un cuadro de un clip, o `times` una tira de cuadros).

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `schema/` | Definición de cada tipo (fuente única de verdad: validación, inspector y guía para la IA). |
| `src/core/` | Documento, validación, operaciones y evaluación. Sin DOM; corre en el navegador y en Node. |
| `src/render/` | Renderer SVG. |
| `src/editor/` | El editor web. |
| `servidor/` | Lectura y escritura en disco, y la API local que usa el editor (plugin de Vite). |
| `mcp/` | Servidor MCP para la IA. |
| `scripts/` | `migrar-esqueletos.js` (`npm run migrar`): lleva documentos viejos, con huesos en la raíz, al modelo de skeleton. |
| `personajes/` | Los documentos (la carpeta conserva el nombre de cuando la app era solo de personajes). |
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
- [docs/decision-animacion.md](docs/decision-animacion.md): los modos Design, Animate y Puppet, el modelo de clips
  y los destinos de exportación (fases 5 a 7).
