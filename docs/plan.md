# Plan de construcción

> Estado: **fase 1 probada con IA; faltan los ajustes que salieron de la prueba** (2026-11-02). Se basa en [sintesis.md](sintesis.md) y en la investigación de
> [Moho](investigacion/moho-lua.md) y [Rive](investigacion/rive-runtime.md).

## Cómo trabajamos

Avanzamos por **fases cortas**. Cada fase deja algo usable y se cierra con tres pruebas:

1. **Pruebas automáticas** del núcleo (`npm test`).
2. **Prueba a mano en el editor**: lo que se agregó se puede hacer y corregir con el mouse.
3. **Prueba con IA por MCP**: le damos a una IA una lista fija de tareas en lenguaje natural y anotamos cómo le fue
   en [pruebas-ia/](pruebas-ia/). Eso nos dice qué partes del formato o de las herramientas confunden a la IA, y las
   corregimos antes de seguir.

Reglas que valen para todas las fases:

- **Todo cambio es una operación.** El editor y el MCP usan el mismo motor de operaciones, con validación, deshacer y
  registro de origen (`ai` / `user`). El DOM SVG es solo una vista.
- **El esquema manda** *(de Rive)*. Cada tipo se describe una vez en `schema/`; de ahí salen la validación, el
  inspector del editor y la guía que lee la IA. Agregar un tipo nuevo no debería tocar el editor ni el MCP a mano.
- **IDs de texto estables y lista plana con `parent`** *(lo contrario de los dos)*.
- **Rig separado de la animación** *(de Moho: frame 0 = pose de montaje)*.

### Medir a la IA

Cada fase tiene su archivo `pruebas-ia/fase-N.md` con las tareas y, por cada corrida, una fila con: cliente y modelo,
tareas logradas, lotes rechazados por el validador, correcciones que hizo falta hacer a mano y notas sobre qué la
confundió. Corremos al menos con el cliente que más se use (Claude Desktop o Claude Code).

---

## Fase 0: preparación ✅ (2026-11-02)

- Iniciar git. Guardar el prototipo actual en la etiqueta `prototipo-0` para poder consultarlo, y borrarlo del árbol
  de trabajo.
- Estructura nueva:

  ```
  schema/      defs de tipos (fuente única de verdad)
  src/core/    documento, validación, operaciones, evaluación (sin DOM, corre en Node y navegador)
  src/render/  renderer SVG
  src/editor/  interfaz
  mcp/         servidor MCP
  servidor/    disco + API local para el editor (plugin de Vite)
  personajes/  documentos
  docs/pruebas-ia/
  ```

- Decidir lo que falta de la síntesis: tiempo en **segundos** (con `fps` solo para mostrar y para snapping),
  coordenadas con **Y hacia abajo** y ángulos en grados.

**Listo cuando:** el repo arranca vacío pero con `npm run dev`, `npm test` y `npm run mcp` funcionando.

## Fase 1: esquema, documento y cáscara del editor 🔶 probada con IA, faltan ajustes

La prueba con IA salió 8/8 sin rechazos ([resultados](pruebas-ia/fase-1.md)). Antes de pasar a la fase 2 hay que
resolver lo que encontró: agrupar en el historial los cambios seguidos del editor, duplicar objetos y documentos, y
dar respuestas más informativas en `undo`, `apply_ops` y `get_history`.

Notas de lo construido:
- Las operaciones son `create`, `set`, `unset`, `delete`, `move` y `rename`, dirigidas por id (`target`) y no por
  rutas: a la IA le resulta más natural y los errores se explican mejor (con sugerencias de ids parecidos).
- Deshacer y rehacer van **por origen** y se calculan desde el historial: la IA deshace solo lo suyo y el usuario
  solo lo suyo. Si el documento cambió y la inversa ya no encaja, se avisa en vez de romper nada.
- Al reparentar desde el árbol, el editor conserva la posición en pantalla. Por MCP, `move` no toca `x`/`y`.
- Pendiente para más adelante: selección múltiple, copiar/pegar y duplicar.

**Núcleo**
- Formato de defs inspirado en Rive (`type`, `extends`, propiedades con `type`, `default`, `animatable`, `range`,
  `enum`, `description`) y su cargador.
- Documento: `format`, `meta` (tamaño, fps), lista plana `objects` con `type` y `parent`. Tipos iniciales: `group`
  (transformación + opacidad) y `shape` con primitivas `rect` y `ellipse`.
- Motor de operaciones: `set`, `add`, `remove`, `move` (reparentar y reordenar), lotes atómicos, deshacer/rehacer,
  historial con origen. Conserva propiedades desconocidas (*compatibilidad hacia adelante, de los dos*).
- Validación generada desde los defs, con mensajes pensados para que la IA pueda corregirse.

**Editor**
- Layout completo aunque varios paneles estén vacíos: barra de herramientas, árbol de objetos, lienzo con pan y
  zoom, inspector, línea de tiempo (vacía) e historial.
- Árbol con arrastrar para reordenar y reparentar. Inspector **generado desde los defs**.
- Selección en lienzo y árbol, deshacer/rehacer, guardado automático y aviso en vivo cuando la IA cambia algo.

**MCP**
- `get_guide` (generada desde los defs, no escrita a mano), `list_documents`, `get_document`, `create_document`,
  `apply_ops`, `undo`, `get_history`.
- `render_preview`: devuelve una **imagen PNG** para que la IA vea lo que hizo (por ejemplo con `resvg-js`).

**Prueba con IA:** armar la estructura de un personaje simple con grupos y primitivas; renombrar y reordenar;
corregir algo que el usuario cambió a mano sin pisarlo.

## Fase 2: dibujo

- Paths con vértices editables. Un solo tipo de vértice con `mode`: `straight` (con `radius`), `mirrored`,
  `asymmetric`, `detached`, y tangentes en **polares** (ángulo + distancia) *(de Rive)*.
- Rellenos y contornos apilables, gradientes, y **estilos compartidos por referencia** *(de Moho)*.
- Editor: herramientas de transformar (mover, rotar, escalar con pivote), pluma y edición de vértices, importar SVG
  (convertido a nuestros paths).
- MCP: sin herramientas nuevas, salvo ayudas si la IA tiene problemas creando paths.

**Prueba con IA:** dibujar un personaje original a partir de una descripción; corregir proporciones; cambiar la
paleta usando los estilos compartidos.

## Fase 3: huesos

- Huesos con `length`, cinemática directa, `independentAngle` y límites de ángulo *(de Moho)*.
- **Layer binding**: un objeto pegado a un hueso, sin deformar.
- Runtime incremental: dirty flags y orden topológico, con límite de pasadas por frame *(de Rive)*.
- Editor: herramienta de huesos (crear arrastrando, rotar, mover el pivote), superposición, enlazar objetos a huesos
  y modo pose frente a modo montaje.
- MCP: `set_pose` para probar poses sin modificar el montaje.

**Prueba con IA:** riggear el personaje de la fase 2; posarlo ("saludando", "mirando hacia arriba").

## Fase 4: switch, params, drivers y acciones

- **Switch** (Moho switch layer ≈ Rive Solo): un hijo visible, elegido por un valor de texto.
- **Acciones**: poses o animaciones cortas con nombre *(de Moho)*.
- **Params** tipados (number, bool, enum, trigger) como interfaz principal *(view model de Rive)*.
- **Drivers** explícitos `param → acción` con tramo de entrada y salida *(smart bones de Moho, sin convenciones de
  nombre)*.
- Editor: panel de params con sliders, "entrar" a editar una acción (la línea de tiempo cambia de color, como en
  Moho) y editor de drivers.

**Prueba con IA:** crear expresiones (feliz, triste, sorpresa) y el giro de cabeza como params; preparar visemas para
lip-sync.

## Fase 5: animación

- Pistas tipadas (`number`, `vec2`, `color`, `bool`, `string`) por ruta legible, keyframes con interpolación **por
  keyframe**: `linear`, `step`, `ease-in/out`, `bezier`, más `hold` e `interval` *(de Moho)*.
- Clips con loop `once`, `loop` y `pingpong`, y mezcla con `mix` *(de Rive)*. Acciones insertadas por referencia.
- Editor: línea de tiempo con playhead, dope sheet, autokey y editor de curvas básico.

**Prueba con IA:** animar un ciclo de reposo, un saludo y un parpadeo; retocar timing a mano y pedirle a la IA que
siga sin pisarlo.

## Fase 6: state machine

- Capas, estados (animación, blend 1D, any, entry, exit) y transiciones con condiciones sobre params, duración de
  mezcla y exit time. Límite de cambios por frame *(de Rive)*.
- Editor: vista de la state machine y previsualización en vivo moviendo params.

**Prueba con IA:** comportamiento de asistente (reposo, escuchando, pensando, hablando, reacción).

## Fase 7: exportación y uso

- Formato de uso `.aia` autocontenido, runtime liviano sin dependencias y manifiesto para la IA de la app
  (params, expresiones con nombre y estados → herramientas para el LLM). Ver [sintesis.md §6](sintesis.md).
- Demo: un avatar en una página, controlado por un LLM, con lip-sync desde el audio.

## Después

Deformación por pesos (máximo 4 huesos por vértice), IK de dos huesos, constraints de copiar transformación con
factor y retardo, dinámica secundaria, morph entre formas con igual número de vértices, imágenes rígidas por hueso y
mallas de imagen en una capa canvas.
