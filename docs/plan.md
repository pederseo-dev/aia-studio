# Plan de construcción

> Estado: **fase 5 en construcción: núcleo, MCP y editor básicos listos y probados con IA (8/8)** (2026-11-05). Se basa en [sintesis.md](sintesis.md) y en la investigación de
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

## Fase 1: esquema, documento y cáscara del editor ✅ (2026-11-02)

La prueba con IA salió 8/8 sin rechazos ([resultados](pruebas-ia/fase-1.md)). Ajustes hechos con lo que encontró:
- El editor junta los cambios seguidos sobre lo mismo (flechas, campos numéricos) en un solo lote: una entrada de
  historial y un paso de deshacer.
- Operación `duplicate` (objeto con sus hijos) y `create_document` con `copy_from` y `background`. En el editor:
  `Ctrl+D` y ☰ → «Make a copy…» del documento.
- `apply_ops`, `undo` y `redo` devuelven el árbol resultante y dicen qué lote tocaron; `get_history` es un resumen
  por defecto (qué propiedades tocó cada lote) y se puede filtrar por origen.
- La guía fija que izquierda y derecha son las del personaje (`_l`, `_r`).

Notas de lo construido:
- Las operaciones son `create`, `set`, `unset`, `delete`, `move` y `rename`, dirigidas por id (`target`) y no por
  rutas: a la IA le resulta más natural y los errores se explican mejor (con sugerencias de ids parecidos).
- Deshacer y rehacer van **por origen** y se calculan desde el historial: la IA deshace solo lo suyo y el usuario
  solo lo suyo. Si el documento cambió y la inversa ya no encaja, se avisa en vez de romper nada.
- Al reparentar desde el árbol, el editor conserva la posición en pantalla. Por MCP, `move` no toca `x`/`y`.
- Pendiente para más adelante: copiar/pegar entre documentos.

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

## Fase 2: dibujo ✅ (2026-11-03)

La prueba con IA salió 7/7 sin rechazos; las tareas 8 a 10 no se corrieron ([resultados](pruebas-ia/fase-2.md)).
Lo que pidió la IA (herencia entre estilos, degradados atados al color, duplicar en espejo, vista previa con zoom)
queda anotado allí para más adelante.

Después de la prueba (pedido del usuario):
- **Selección múltiple:** Ctrl o Shift + clic en el lienzo; recuadro arrastrando en un lugar vacío (toca formas, no
  grupos); en la jerarquía, Ctrl + clic agrega o quita y Shift + clic toma el tramo. Mover, flechas, rotar y escalar
  (desde el centro del conjunto, proporcional), duplicar, borrar y arrastrar en la jerarquía actúan sobre todos.
  `Ctrl+G` agrupa la selección y `Ctrl+A` selecciona todo. El inspector muestra lo que tienen en común y marca los
  valores distintos.
- Assets va en la parte de abajo del panel izquierdo, separado de Layers.

Notas de lo construido:
- `path` con vértices en polares (straight con `radius`, mirrored, asymmetric, detached). La IA puede pasar `d` de
  SVG (todos los comandos, arcos incluidos) y se convierte a vértices.
- Recursos `style`, `linear_gradient` y `radial_gradient`: van en la raíz, no se dibujan y las formas los usan por
  id (`style`, `fillGradient`). Valor propio → estilo → valor por defecto.
- Editor: manijas para rotar, escalar desde el pivote y mover el pivote (grupos y paths, compensando el contenido),
  pluma, edición de puntos (arrastrar anclas y tangentes, Alt separa, doble clic recto/curvo, clic en el contorno
  agrega, Supr borra) e importar SVG (formas con transformaciones y colores; se descartan scripts y eventos).
- Interfaz más cercana a Rive y Moho (pedido del usuario): menú ☰, pestañas de documentos que se pueden cerrar,
  herramientas agrupadas (Transformar: Mover, Rotar, Escalar; Crear: Pluma, Rectángulo, Elipse), herramientas de
  rotar y escalar arrastrando en cualquier parte (como en Moho), jerarquía plegable, inspector con pares en una
  fila (X/Y, ancho/alto, escala) y menú de zoom.
- **Cambios respecto del plan:** los rellenos y contornos apilables quedan para más adelante (por ahora se logra
  con formas duplicadas). Un path tiene un solo contorno: los agujeros (anillos) todavía no se pueden hacer, y al
  importar, cada subtrazado se vuelve un path aparte.

- Paths con vértices editables. Un solo tipo de vértice con `mode`: `straight` (con `radius`), `mirrored`,
  `asymmetric`, `detached`, y tangentes en **polares** (ángulo + distancia) *(de Rive)*.
- Rellenos y contornos apilables, gradientes, y **estilos compartidos por referencia** *(de Moho)*.
- Editor: herramientas de transformar (mover, rotar, escalar con pivote), pluma y edición de vértices, importar SVG
  (convertido a nuestros paths).
- MCP: sin herramientas nuevas, salvo ayudas si la IA tiene problemas creando paths.

**Prueba con IA:** dibujar un personaje original a partir de una descripción; corregir proporciones; cambiar la
paleta usando los estilos compartidos.

## Fase 3: huesos ✅ (2026-11-03)

La prueba con IA salió 9/9 con un rechazo ([resultados](pruebas-ia/fase-3.md)). Lo más importante que mostró: una
forma no se dobla con varios huesos (la IA partió la cola en segmentos), y crear huesos con coordenadas relativas
cuesta. Quedan como candidatos: deformación por pesos, huesos con `from`/`to` en coordenadas del documento, valores
finales en `get_history` y avisos de `set_pose` al recortar ángulos.

Ajustes hechos con lo que encontró:
- **Enlace por punto** (el manual de Moho): cada vértice de un path acepta `bone` y, en una pose, se mueve con sus
  tangentes según ese hueso. Un solo path se dobla con una cadena de huesos, sin partir el dibujo. En el editor, al
  editar puntos, la barra de opciones elige el hueso del punto o «Distribute among bones» (el más cercano); por MCP,
  `bind_points`. En una pose, arrastrar ese path gira el hueso más cercano al clic. Los pesos entre varios huesos
  por punto siguen para más adelante.
- Huesos con `from`/`to` en coordenadas del documento (se convierten a `x`, `y`, `rotation` y `length`).
- `get_history` muestra el valor final de lo que fijó cada lote; `set_pose` avisa cuando un límite recorta un
  ángulo; `undo` dice qué deshizo; un id repetido al crear un hueso sugiere el sufijo `_bone`, que también propone la
  guía.

**Cambio al modelo de capa de huesos de Moho (2026-11-04).** Al usarlo a mano, tener los huesos como filas sueltas
de la jerarquía, mezcladas con el dibujo, y el enlace escondido en una propiedad que podía apuntar a cualquier hueso
del documento resultó confuso. Se pasó al modelo de Moho:
- Tipo `skeleton` (la *bone layer*): un contenedor transformable, como un `group`, que tiene adentro el dibujo que
  mueve y sus huesos. Los `bone` solo pueden estar dentro de un skeleton (los raíz) o de otro hueso
  (`requiresParent` en el esquema); el marco de los huesos raíz es el del skeleton, así que moverlo, girarlo o
  escalarlo lleva dibujo y esqueleto juntos. Un skeleton puede ir dentro de otro y seguir a un hueso de aquel.
- El `bone` de un objeto o de un vértice solo puede apuntar a huesos del skeleton que lo contiene (`refScope:
  "skeleton"`), con mensajes que dicen qué huesos sirven. Siguen el enlace por capa, el enlace por punto y que enlazar
  no mueve nada.
- Sin enlace automático: el dibujo de un skeleton queda quieto hasta enlazarlo. «Bind all by proximity» (barra de
  opciones y `bind_by_proximity` en el MCP) enlaza cada pieza sin hueso al más cercano al centro de su caja, con las
  piezas más grandes posibles: un grupo sin nada enlazado adentro va entero; si ya tiene algo enlazado, se baja a sus
  hijos. Elegimos la caja (y no el pivote) porque el pivote de los grupos suele estar en la articulación, que cae
  justo entre dos huesos.
- En Layers solo hay capas, como en Moho: los huesos no son filas (probamos un subnodo «Bones (N)» y se quitó; en
  Moho la jerarquía de huesos se ve en el lienzo). Dos herramientas, como en Moho: **Add Bone** (B) solo crea (en el
  skeleton seleccionado o el de la selección; si no hay ninguno, crea uno y avisa) y **Manipulate Bones** (M) solo
  ajusta (girar, mover el origen, dirección y largo). Antes una sola herramienta hacía todo y resultaba tosca.
- Enlazar y emparentar también son herramientas, como en Moho: **Reparent Bone** (como en Blender: se eligen los hijos y al
  final el padre, y un botón de la barra hace el cambio; «Clear parent» los deja como raíz; nada pasa solo con un
  clic, que en la primera versión resultó demasiado automático. Cambia el padre sin mover el hueso; `opsParaReparentar` recalcula sus valores en el marco nuevo, también los de las poses), **Bind Layer** (L,
  reemplaza al modo «Bind drawing…») y **Bind Points** (clic o recuadro sobre los puntos, sin entrar a editar el
  path). De Rive tomamos los colores por hueso, que también pintan los puntos enlazados, para ver qué sigue a qué.
  Los pesos por punto de Rive (un punto con varios huesos) quedan para más adelante. Sacar un dibujo del skeleton de su hueso suelta el enlace y avisa.
- Migración determinista (`npm run migrar`, `src/core/migracion.js`): si todo el dibujo enlazado está en un grupo
  de la raíz (`cat` en los gatos), ese grupo pasa a ser el skeleton y los huesos se llevan a su marco (también en
  las poses); si no, se crea un skeleton nuevo con el tramo de la raíz que tiene el dibujo enlazado. Deja una entrada
  "migracion" en el historial que corta deshacer, porque las inversas de antes hablan del marco viejo.
  `gato_rig`, `gato_expresiones` y `test_4` se migraron y se ven igual en el montaje, las poses y las mezclas de
  params (comparado píxel a píxel; las únicas diferencias son de antialiasing, por el redondeo del SVG viejo).

Notas de lo construido (antes del cambio a la capa de huesos):
- `bone` con `x`, `y`, `rotation`, escala, `length`, `independentAngle` y límites `minAngle`/`maxAngle`. Los huesos
  **solo tienen huesos como hijos** (`parentTypes`/`childTypes` en el esquema): el esqueleto va aparte del dibujo y
  el orden de dibujo queda libre.
- **Layer binding** con la propiedad `bone` de cualquier objeto transformable. Un objeto sin `bone` sigue al hueso de
  su padre. Como en Moho, enlazar no mueve nada: el objeto sigue el *delta* del hueso (de dónde está en el montaje a
  dónde está en la pose).
- **Poses con nombre** como recurso `pose` (`bones: { hueso: { rotation, x, y, scaleX, scaleY } }`, valores
  absolutos). Es el puente hacia las acciones de la fase 4: una pose es una acción de un solo cuadro.
- Borrar un hueso suelta lo enlazado y lo quita de las poses (deshacer lo devuelve); renombrarlo actualiza todo.
- Editor: herramienta Hueso (B) para crear arrastrando (hijo del seleccionado; desde su punta, encadenado), girar,
  mover el origen y ajustar la punta (Alt, o con Mover). `Ctrl+B` y soltar en Layers enlazan. Selector
  «View: Setup / Pose» en la barra; en una pose el lienzo se enmarca en verde, arrastrar un hueso (o el dibujo
  enlazado) lo gira en la pose y el inspector muestra los valores de la pose arriba de los del montaje.
- Ajustes tras probarlo a mano: una **barra de opciones** sobre el lienzo explica qué se puede hacer según la
  herramienta y la selección, con botones (con un hueso: «Bind Layer» por clics, ver lo enlazado, hueso hijo,
  probar en una pose). Rectángulos y elipses tienen pivote movible (`originX`/`originY`, como en Rive).
- MCP: `set_pose` (suma a la pose y devuelve la imagen), `render_preview` con `pose`, `region` (recorte, que pidió la
  IA en la fase 2) y `bones` (el esqueleto encima, con nombres). `get_document` muestra dónde queda cada hueso en el
  documento, para no tener que sumar ángulos relativos.
- **Cambios respecto del plan:** el runtime incremental (dirty flags, límite de pasadas) queda para la fase 5, cuando
  haya cuadros que recalcular; por ahora el esqueleto se evalúa entero en cada dibujo, que alcanza de sobra.

- Huesos con `length`, cinemática directa, `independentAngle` y límites de ángulo *(de Moho)*.
- **Layer binding**: un objeto pegado a un hueso, sin deformar.
- Runtime incremental: dirty flags y orden topológico, con límite de pasadas por frame *(de Rive)*.
- Editor: herramienta de huesos (crear arrastrando, rotar, mover el pivote), superposición, enlazar objetos a huesos
  y modo pose frente a modo montaje.
- MCP: `set_pose` para probar poses sin modificar el montaje.

**Prueba con IA:** riggear el personaje de la fase 2; posarlo ("saludando", "mirando hacia arriba").

## Fase 4: switch, params, drivers y acciones ✅ (2026-11-05)

Notas de lo construido:
- **Las poses son las acciones.** En vez de un tipo nuevo, la `pose` de la fase 3 se generalizó: `values` fija
  cualquier propiedad animable de cualquier objeto (huesos, vértices de una boca, colores, opacidad, el hijo de un
  switch). Con la misma cantidad de vértices que el montaje, una forma se interpola (morph). Las animaciones cortas
  con tiempo quedan para la fase 5. Los documentos con `bones` en las poses se migraron a `values`.
- **`switch`**: un grupo que muestra un solo hijo (`active`, una referencia limitada a sus hijos con `refScope`).
- **`param`** (`number`, `boolean`, `enum`) y **`driver`** (param → pose, tramo `inMin…inMax` → peso
  `outMin…outMax`, o `equals` para un enum). Las poses activas se suman sobre el montaje: los números por
  diferencias, colores y vértices interpolados, y lo discreto con peso ≥ 0.5. El trigger queda para la fase 6.
- Editor: «View» suma «Parameters (blend)» (lienzo en naranja). El panel de abajo tiene un control por param, los
  drivers con su peso en vivo y «＋ Pose…» para conectar. En una pose, el inspector muestra arriba todo lo animable
  del objeto (lo cambiado va a la pose) y la edición de puntos guarda el morph en la pose.
- MCP: `set_pose` con `values` (acepta `d`), `render_preview` con `params` (dice qué poses quedaron activas y con
  qué peso) y el árbol muestra params, drivers y switches.
- Primera auditoría (agente `auditor`): el enlace por punto es del montaje (una pose no guarda `bone` en sus vértices
  y, al aplicarla o mezclarla, cada vértice toma el del montaje con el mismo índice; lo viejo se ignora al leer y se
  limpia al guardar la pose); la mezcla parte del valor que se ve (con el estilo); deshacer y rehacer se niegan si
  un lote posterior del otro origen tocó las mismas propiedades; `reparent_bone` avisa en qué poses el hueso cambia
  de lugar y con `keep_in_poses` las compensa (en el editor, «Keep poses»); los huesos dibujados encima siguen a una
  pose que mueve el skeleton; `meta` es un id reservado; se validan `initial`/`equals` contra `options` y
  `min ≤ max`. Herramientas nuevas para la IA: `move` con `keepPosition`, `create_switch_control` (quitada después,
  junto con «Create control» del editor: el switch quedó simple, como en Moho, y la variante se elige con `active`) y
  `delete_document`. La lógica de las herramientas del MCP
  vive en `mcp/herramientas.js`, con pruebas.
- Pendiente: **importar SVG desde el MCP.** El importador del editor (`src/editor/importar.js`) monta el SVG en la
  página para que el navegador resuelva transformaciones, viewBox, estilos CSS y unidades: lee la matriz de cada
  forma con `getScreenCTM` y los colores con `getComputedStyle`. En Node no hay DOM: habría que sumar un parser (por
  ejemplo `linkedom`) y reimplementar a mano la cascada de estilos y la composición de transform y viewBox. Mientras tanto, la IA puede pasar cada forma como `d` en un `path`.
- Pendiente: traducir al inglés los mensajes de error viejos del núcleo y del servidor (ver `CLAUDE.md`).
- Prueba con IA: 8/8 (`docs/pruebas-ia/fase-4.md`). Lo que pidió para más adelante: un aviso cuando dos poses
  activas muestran cosas que se tapan, mostrar u ocultar sin opacidad intermedia, desplazar un hueso en coordenadas
  del documento dentro de una pose, una cuadrícula de params en `render_preview` y máscaras.


- **Switch** (Moho switch layer ≈ Rive Solo): un hijo visible, elegido por un valor de texto.
- **Acciones**: poses o animaciones cortas con nombre *(de Moho)*.
- **Params** tipados (number, bool, enum, trigger) como interfaz principal *(view model de Rive)*.
- **Drivers** explícitos `param → acción` con tramo de entrada y salida *(smart bones de Moho, sin convenciones de
  nombre)*.
- Editor: panel de params con sliders, "entrar" a editar una acción (la línea de tiempo cambia de color, como en
  Moho) y editor de drivers.

**Prueba con IA:** crear expresiones (feliz, triste, sorpresa) y el giro de cabeza como params; preparar visemas para
lip-sync.

## Fase 5: animación (Design · Animate · Puppet)

Diseño acordado en [decision-animacion.md](decision-animacion.md): tres modos con un solo motor de clips.

- **Núcleo:** recurso `animation` (`usage` animate/puppet, `duration`, `loop` once/loop/pingpong, `description`,
  `tracks` con la forma de `values` de una pose). Keyframes `{ t, value, ease }` con la curva por keyframe: `linear`,
  `step`, `ease-in`, `ease-out`, `ease-in-out` y `cubic-bezier` `[x1, y1, x2, y2]`. Los params también tienen pista.
  Evaluación: montaje → clip en t → params → drivers suman sus poses encima. Rename y delete actualizan las pistas.
- **MCP (a la par del núcleo):** `set_keys` (por momentos, con `values`, `params` o una `pose` entera),
  `delete_keys`, `render_preview` con `animation` + `time` y tira de cuadros con `times`, y el árbol que resume cada
  clip.
- **Editor:** pestañas de modo **Design / Animate / Puppet**. Las poses, params y drivers salen de Design y pasan a
  Puppet. Timeline con playhead, play/loop, keyframes por propiedad, autokey (en un clip, lo que se cambia va a un
  keyframe en el tiempo del playhead) y curva por keyframe. En Puppet, la biblioteca de clips como botones a la
  derecha; en Animate, una timeline larga.
- **Después dentro de la fase:** clips de Puppet insertados por referencia en Animate, editor de curvas, dope sheet
  con mover/escalar tiempos, runtime incremental (dirty flags, anotado en la fase 3).

Construido (2026-11-05):
- Núcleo: `animation`, curvas (`src/core/curvas.js`), evaluador (`src/core/animacion.js`: `poseDeClip`,
  `ponerClave`, `quitarClave`) y render con `animation` + `time`; tira de cuadros `svgTira`.
- MCP: `set_keys`, `delete_keys`, `render_preview` con `animation`/`time`/`times`; el árbol resume cada clip.
- Editor (`src/editor/timeline.js`): pestañas **Design / Animate / Puppet**. Design ya no muestra «View» ni la
  timeline, y en Assets solo estilos y degradados. Un clip abierto se edita como una pose (`estado.pose` = id del
  clip): girar huesos, el inspector, los puntos y los sliders de params guardan keyframes en el playhead (autokey).
  Timeline con regla, play/pausa (respeta `loop`), duración, loop, «◆ Key», keyframes que se eligen, se arrastran
  (con imán a los cuadros), cambian de curva y se borran con <kbd>Del</kbd>. Puppet: biblioteca de clips a la
  derecha (clic = editar, ▶ = reproducir) y pestañas Timeline / Parameters abajo, con la descripción del clip.
  Animate: selector de escenas y «＋ Scene».
- Prueba con IA: 8/8 sin rechazos ([resultados](pruebas-ia/fase-5.md)). Con lo que encontró: `setup: true` y
  momentos con solo `ease` en `set_keys`, y `undo`/`redo` por pista en los clips (como por clave en las poses).
- Falta en la fase: clips de Puppet insertados en Animate (lo pidió la IA en la prueba), editor de curvas, mover y
  escalar varios keyframes, un resumen de un clip con sus valores para la IA, avisar cuando un param animado mueve
  algo que el clip también anima, y runtime incremental.

**Prueba con IA:** animar un ciclo de reposo, un saludo y un parpadeo (clips de Puppet) y una escena corta en
Animate; retocar timing a mano y pedirle a la IA que siga sin pisarlo.

## Fase 6: comportamiento (Puppet en vivo)

- **Live** en Puppet: los botones disparan clips, con fundidos entre ellos y params moviéndose a la vez.
- State machine por capas: estados (clip, blend 1D, any, entry, exit) y transiciones con condiciones sobre params,
  duración de mezcla y exit time. Límite de cambios por frame *(de Rive)*. Clips por región del cuerpo (máscaras) y
  clips aditivos.
- Editor: vista de la state machine y previsualización en vivo moviendo params.

**Prueba con IA:** comportamiento de asistente (reposo, escuchando, pensando, hablando, reacción).

## Fase 7: exportación y uso

- **Prioridad: `.aia` + runtime JS** (`src/core` + `src/render`, sin dependencias) con manifiesto para la IA de la
  app: params, clips de Puppet con su ficha y estados → herramientas para el LLM. Ver
  [decision-animacion.md §5](decision-animacion.md).
- **Video** (mp4/webm/gif, PNG por cuadro) muestreando el mismo evaluador con resvg y ffmpeg.
- **Lottie y SVG/CSS**: pistas simples directas; huesos y mezclas horneados cuadro a cuadro.
- Demo: un avatar en una página, controlado por un LLM, con lip-sync desde el audio.

## Ideas anotadas

Grabar una actuación de Puppet como pistas de Animate (Rec), atajos de teclado por botón, escenas con varios
personajes (instancias de otros documentos), lo procedural (parpadeo, mirada) como dato del personaje y curvas
elastic/bounce/«a dos». Detalle en [decision-animacion.md §7](decision-animacion.md).

## Después

Deformación por pesos (máximo 4 huesos por vértice), IK de dos huesos, constraints de copiar transformación con
factor y retardo, dinámica secundaria, morph entre formas con igual número de vértices, imágenes rígidas por hueso y
mallas de imagen en una capa canvas.
