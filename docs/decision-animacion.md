# Decisión: animación (fase 5), puppet (fases 5–6) y exportación (fase 7)

> Estado: **acordado con el usuario** (2026-11-05). Reemplaza lo que [plan.md](plan.md) decía de las fases 5 a 7 y
> completa la §6 de [sintesis.md](sintesis.md).

## 1. Tres modos de trabajo

El editor se divide en tres modos, por **para qué** es lo que se hace:

| | **Design** | **Animate** | **Puppet** |
|---|---|---|---|
| Para qué | Dibujar y riggear (montaje, frame 0) | Contar algo de principio a fin: animación tradicional de personajes, objetos o entornos | Dejar el personaje listo para que otro lo maneje en vivo: la IA de una app, un juego, código |
| Timeline | No hay | **Una timeline larga** (la escena) | **Muchas timelines cortas**: una por clip |
| Panel derecho | Inspector | Inspector | **Biblioteca de clips como botones** (triggers) + inspector |
| Exporta a | — | Video, Lottie, SVG/CSS (horneado) | `.aia` + runtime (vivo) |

- **Design ya no tiene poses.** Las poses, los params y los drivers son los controles del muñeco: pasan a **Puppet**.
  Design queda para dibujo y rig puros (lo que era «View: Setup»).
- **Puppet** tiene los controles: expresiones (params → poses), clips (gestos, loops, reacciones) y, en la fase 6, el
  comportamiento (state machine). Cada clip es un **botón** del panel derecho:
  - clic → la timeline de abajo pasa a ese clip (como «entrar» a una acción en Moho; el marco cambia de color);
  - con **▶ Live** encendido, el botón *dispara* el clip y los params se mueven con sliders: se ve como lo verá la IA
    de la app, con fundidos entre clips.
- Referencias: Rive (Design / Animate y la lista de animaciones que mezcla la state machine), Moho (acciones que se
  editan aparte y se insertan por referencia), Adobe Character Animator (*puppets* con un panel de *triggers*).

## 2. Un solo motor de animación

Animate y Puppet usan **el mismo tipo de clip, las mismas pistas y la misma timeline**. Lo único que cambia es el
uso (`usage`): en Animate, una timeline larga; en Puppet, muchos clips con su ficha para la IA. Así:

- **Un clip de Puppet se puede insertar en Animate** (por referencia, como las acciones de Moho): «wave» se anima una
  vez y se usa en muchas escenas. Retocar el clip actualiza todas. *(Primero va la timeline simple; la inserción
  por referencia viene después dentro de la fase 5.)*
- Video, Lottie y el runtime salen del **mismo evaluador**: `(documento, clip, t, params) → valores`. En vivo, el
  runtime lo llama en cada cuadro; para hornear, se muestrea a los fps del documento. Regla: **lo que el modelo
  expresa es lo que el runtime evalúa**; lo que un destino no soporta se hornea al exportar a ese destino.

## 3. Modelo de datos

Un recurso nuevo, `animation` (el clip):

```jsonc
{
  "id": "wave", "type": "animation",
  "usage": "puppet",            // "animate" (timeline de la escena) o "puppet" (clip del muñeco)
  "duration": 1.2,              // segundos
  "loop": "once",               // "once", "loop" o "pingpong" (de Rive)
  "description": "Waves with the right hand", // para la IA de la app (manifiesto) y el botón
  "tracks": {
    "arm_r_bone": { "rotation": [ { "t": 0, "value": 0 }, { "t": 0.3, "value": -60, "ease": "ease-out" } ] },
    "mouth":      { "active":   [ { "t": 0, "value": "mouth_open" } ] },
    "happiness":  { "value":    [ { "t": 0, "value": 0 }, { "t": 0.6, "value": 1 } ] }
  }
}
```

- **Pistas por objeto y propiedad**, con la misma forma que `values` de una pose (`{ id: { propiedad: … } }`): la IA
  ya la conoce. Cualquier propiedad animable sirve: huesos, vértices (morph con igual cantidad de puntos), colores,
  opacidad, el hijo de un switch.
- **Un param también es una pista** (`{ id_de_param: { value: […] } }`): un clip puede llevar `happiness` de 0 a 1 y
  así reutiliza las expresiones (como animar el control de un smart bone de Moho) en vez de repetir keyframes.
- **Keyframe** = `{ t, value, ease }`. Tiempo en segundos, entre 0 y `duration`. Valores absolutos, como en el
  montaje y las poses.
- **La curva va en el keyframe** y vale para el tramo que sale de él (Moho y Rive): `linear` (por defecto), `step`
  (mantiene hasta el siguiente: el *hold* de Moho), `ease-in`, `ease-out`, `ease-in-out` o `[x1, y1, x2, y2]`
  (`cubic-bezier` como en CSS). Se eligió `cubic-bezier` porque pasa sin pérdida a CSS, Lottie y Rive. Elastic,
  bounce, noisy y el «a dos» de Moho quedan para más adelante; al exportar a un destino que no los tenga, se hornean.
- Lo que no se interpola (el `active` de un switch, booleanos, textos) cambia de golpe en cada keyframe. Los números
  se interpolan con la curva; los colores, por canal; los vértices, como el morph de las poses (si la cantidad no
  coincide, cambian de golpe).
- Antes del primer keyframe vale el primero; después del último, el último (Rive). Una propiedad sin pista vale lo
  del montaje.

## 4. Orden de evaluación

```
montaje → clip en t (valores absolutos) → params (los del clip pisan a los de afuera) → drivers suman sus poses encima
```

1. El clip fija los valores de sus pistas en el tiempo `t` (con `loop`: `once` se queda en el final, `loop` vuelve
   a empezar, `pingpong` va y vuelve).
2. Las pistas de params dan el valor de esos params; los demás params vienen de afuera (la app, los sliders) o de su
   valor inicial.
3. Los drivers suman sus poses **encima de lo animado**: un saludo animado más la cara feliz que da un param. En los
   números, la diferencia de cada pose se sigue midiendo contra el montaje (como en la mezcla de la fase 4) y se suma
   a lo animado; colores y vértices se interpolan desde lo animado hacia la pose.
4. **Lo que no se suma lo decide la pista del clip** *(cambio del 2026-11-05, por la auditoría de la fase 5)*: si el
   clip tiene pista en un color, unos vértices, el hijo de un switch o un booleano, los drivers no lo cambian. Los
   drivers siguen decidiendo donde el clip no tiene pista. Motivo: un param enum siempre tiene una opción activa (y
   un param numérico puede arrancar distinto de 0), así que su driver pesaba 1 en todo clip y tapaba el keyframe de
   `mouth.active`. Cuando un param elige la variante (visemas), lo natural es animar el param, no `active`.
   Los números se siguen sumando: `avisosDeClip` (en `set_keys`, `render_preview` y la timeline) avisa cuando un
   driver activo le suma su pose a una pista del clip, y el autokey del editor guarda el valor sin ese aporte.

5. **Una escena de Animate se evalúa sin drivers** *(2026-11-06, sigue a «los params son solo de Puppet», §8)*:
   montaje + keyframes, nada más (Design + lo animado). Todo lo de arriba sobre params y drivers vale para los clips
   de Puppet. Motivo: con params solo de Puppet, en una escena los drivers sumaban con los params en su valor inicial,
   sin control ni aviso (un param con `default` 1 giraba una caja que en Design se ve derecha). En una escena, una
   expresión se copia como keyframes («◆ Pose…» o `set_keys` con `pose`) y una variante se elige keyando el `active`
   del switch. Vale igual en el editor, en `render_preview` (con una escena, rechaza `params`), en `avisosDeClip`
   (una escena no tiene avisos) y en la exportación, porque todos usan `poseDeClip`.

El resultado es una pose más, que se dibuja con el mismo render de siempre (`src/render/svg.js`).

## 5. Exportación (fase 7)

| Destino | Qué sale | Qué se pierde |
|---|---|---|
| **`.aia` + runtime JS** (prioridad) | El documento sin historial ni datos del editor, con un manifiesto para la IA de la app: params con descripción y rango, clips de Puppet con su ficha y estados. El runtime es `src/core` + `src/render`. | Nada: todo sigue vivo. Solo corre donde llegue el runtime (web, Electron). |
| **Video** (mp4/webm/gif, PNG por cuadro) | Un clip de Animate (o de Puppet con params fijos) muestreado a los fps del documento, con resvg y ffmpeg. | La interacción. |
| **Lottie / SVG-CSS** | Las pistas simples (transformaciones con curvas `cubic-bezier`) pasan directo; huesos, enlace por punto y poses mezcladas se hornean cuadro a cuadro. | Params y state machine (dotLottie tiene state machines, pero sin nuestra mezcla de poses). |

## 6. La IA

- **Edición (MCP):** `set_keys` crea o actualiza un clip pensando en **momentos**: «en t = 0.3, el brazo así y la
  boca así» (`values` como en `set_pose`), o «en t = 0.3, la pose `happy`» (copia sus valores como keyframes, como en
  Moho). `delete_keys` quita keyframes por tiempo o por propiedad. `render_preview` acepta `animation` + `time`, y
  `times` para una **tira de cuadros** en una sola imagen, para ver el movimiento sin pedir diez imágenes. El árbol de
  `get_document` resume cada clip (uso, duración, loop, qué anima y en qué tiempos).
- **Después de la segunda prueba (2026-11-06):** `scale_time` reescala el tiempo de un clip o de un tramo en un solo
  paso de deshacer (el editor lo hace con «Scale keys» al cambiar Length); `pose` acepta `only`/`except` para copiar
  una parte; un número de `values` puede ser **relativo al montaje** (`"+=14"`), que se resuelve al guardar: la pista
  sigue guardando valores absolutos, así que el formato no cambia. Las curvas fuertes con nombre (`-quad`, `-cubic`,
  `-expo`, `-back`) son cubic-bezier fijas, así que pasan sin pérdida a CSS, Lottie y Rive. `set_keys` y
  `render_preview` listan qué poses mueve cada param animado (un driver del usuario puede mover más de lo esperado).
- **Uso en vivo (fase 7):** el manifiesto convierte los clips de Puppet en herramientas para el LLM de la app
  (`play("wave")`, `set_param("happiness", 0.8)`), con la descripción de cada clip.

## 7. Ideas anotadas para después

- **Grabar una actuación (Puppet → Animate):** con Live encendido, ● Rec graba los botones y los sliders como pistas
  en una timeline de Animate (como las *takes* de Character Animator). Sirve para hacer un video sin animar cuadro a
  cuadro, y para que la IA «actúe» un guion y deje algo que se puede retocar.
- **Clips por región del cuerpo (máscaras):** que un clip declare qué toca (brazos, cara, boca) para sumar «wave» +
  «talk» + «happy» sin que se pisen (capas de la state machine de Rive, avatar masks de Unity). Va con la fase 6.
- **Clips aditivos** (respiración, balanceo) que se suman a cualquier otro.
- **Atajo de teclado por botón** en Puppet.
- **Escenas con varios personajes** en Animate: cada uno, una instancia de otro documento con su Puppet (los
  *nested artboards* de Rive, las capas referenciadas de Moho). No cerrarle la puerta al diseño.
- **Lo procedural como dato del personaje:** qué clip es el parpadeo y qué params son la mirada y la boca, para que el
  runtime los active con una línea (el *cuándo* sigue siendo de la app).
- Curvas `elastic`, `bounce`, `noisy` y animación «a dos» (`interval` de Moho / `quantize` de Rive).

## 8. Cómo se ve la timeline (2026-11-06)

Se debatió entre Rive (la jerarquía de todo lo animado, solo las propiedades con keys) y Moho (los canales de lo
seleccionado, con o sin keys). Para no saturar la interfaz, **se empieza como Moho**:

- Arriba, una fila **«All keys»** con todos los keyframes del clip en gris, para ver el ritmo (clic = llevar el
  playhead ahí).
- Abajo, **los canales del objeto o hueso seleccionado, siempre todos** sus animables, también los que no tienen
  keyframes (apagados, con ◇ para keyar ese canal en el playhead). Sin selección, se listan los objetos animados para
  ir a ellos.
- Canales como en Moho: **Position** (x e y juntas) y **Scale** (scaleX y scaleY juntas) son una sola fila; elegir,
  mover, cambiar la curva o borrar un keyframe actúa sobre las dos. En los datos siguen siendo pistas separadas (lo
  que ve la IA no cambia).
- Todos los keyframes son **◆**, como en Moho; el **color dice la curva** del tramo que sale de él: verde linear,
  violeta ease, ámbar step, celeste cubic-bezier, blanco si las propiedades del canal tienen curvas distintas.
- **Varios a la vez, como en Rive** (pedido del usuario el mismo día): cada cosa seleccionada (en Layers con Ctrl +
  clic o Shift + clic, o con Ctrl + clic sobre los huesos del lienzo, también en Manipulate, poses y clips) es un
  **grupo plegable** en la timeline. La fila del grupo resume sus keyframes; ▸/▾ la abre y muestra sus canales como
  arriba. Para no saturar, solo el principal (el último elegido) arranca abierto; lo que el usuario abre o cierra se
  recuerda mientras dura la sesión. «◆ Key» keya todos los seleccionados en un solo paso de deshacer.
- **Los params son solo de Puppet** (2026-11-06, decisión del usuario): el panel Parameters está solo en Puppet y
  una escena de Animate no anima params (la validación lo rechaza, también por el MCP). Una escena keya los valores
  mismos o copia una pose con «◆ Pose…» / `set_keys` con `pose`. Además, **una escena se ve sin drivers** (§4,
  punto 5). Un documento viejo con una escena que anima params se migra al abrirlo: el clip pasa a Puppet (no se
  pierde ningún keyframe) y el historial lo anota (`migrarEscenasConParams` en `src/core/migracion.js`).
- **El panel de abajo es solo la timeline** (2026-11-06): Parameters pasó al panel derecho, solo en Puppet. Arriba de la timeline, pestañas como las de los documentos: en Animate una por escena (+ crea una,
  × la borra con confirmación), en Puppet el clip abierto (× lo cierra). La barra tiene la reproducción al medio:
  « (keyframe anterior), ▶ y » (keyframe siguiente); a la izquierda el reloj, la duración y el loop; a la derecha
  los botones de keyar y la curva.
- Sigue abierta la otra mitad de Rive: ver todo lo animado sin seleccionarlo (hoy, sin selección, la timeline lista
  los objetos animados para elegirlos).

## 9. Puppet en vivo (fase 6, 2026-11-11)

Se debatió hacer una state machine como la de Rive (estados, transiciones con condiciones sobre params, exit time,
blend 1D). **Decisión del usuario: queda en pausa.** En una app con un LLM, el LLM ya decide el estado («estoy
hablando» → `play("talking")`) y lo que pasa cuadro a cuadro (boca con el audio, parpadeo, respiración) no necesita
estados. La state machine sirve más a juegos o apps sin IA; se retoma si aparece ese caso. Lo de abajo equivale a una
state machine de Rive con transiciones desde *Any State*, así que no cierra la puerta ni pierde nada al exportar.

### El runtime (`src/core/vivo.js`)

Es «el muñeco en marcha» y el mismo que exporta la fase 7. No depende del DOM y avanza con `avanzar(dt)` (pruebas y
guiones con tiempos fijos). La app le habla con tres verbos:

- **`play(clip)`**:
  - un clip en `loop` o `pingpong` pasa a ser **la base** (reposo, escuchando, hablando) y reemplaza a la anterior
    con un fundido cruzado;
  - un clip `once` es un **gesto**: entra con un fundido **encima** de la base, pisa solo las pistas que tiene (el
    saludo mueve el brazo y deja la boca de «talking») y sale solo con otro fundido al final. Volver a dispararlo lo
    reinicia. Varios gestos se apilan en el orden en que se dispararon.
- **`set(param, valor)`**: el valor de la app (los que falten, su valor inicial).
- **`stop(clip)`** (o `stop()` todo): el clip sale con su fundido.

Datos nuevos del clip (`animation`, solo en Puppet):

| Propiedad | Qué hace |
|---|---|
| `fade` | Segundos del fundido al entrar y al salir (por defecto 0.2; 0 = de golpe, para el parpadeo). La curva del fundido es suave (ease-in-out). |
| `next` | Clip que se dispara cuando este `once` empieza a salir: `start_talking` → `talking`, `surprised` → `idle`. |
| `blend` | `override` (por defecto) pisa lo que hay debajo con su peso; `additive` **suma** la diferencia con el montaje (respiración: `scaleY` 1.02 suma 0.02 a lo que haya). Lo que no es número no se suma. |
| `auto` | Capas procedurales, dato del personaje: `off` (por defecto, lo dispara la app), `repeat` (el runtime lo dispara solo cada `repeat_min`…`repeat_max` segundos al azar: el parpadeo) o `always` (suena siempre en loop: la respiración, normalmente aditiva). La app no los dispara. |

### Cómo se mezcla (cada cuadro)

```
montaje → bases (fundido cruzado) → gestos en orden → capas auto → aditivos suman → drivers con los params mezclados
```

- Cada capa pisa lo de abajo **con su peso**: números en línea, colores por canal, vértices como el morph, lo
  discreto (el hijo de un switch, booleanos) cambia cuando el peso pasa de 0.5.
- **Params de la app contra un clip que los anima:** se mezclan igual, con el peso del clip. Mientras suena a peso 1
  gana el clip; al salir, el param vuelve **suave** al valor de la app (si la app lo cambió mientras tanto, aparece
  el nuevo). Los drivers se calculan **una vez**, con los params ya mezclados: no se mezclan poses dos veces.
- Las capas `auto` van encima de los gestos: el parpadeo se ve también durante un saludo.

### En el editor: «▶ Live» (Puppet)

Un interruptor arriba de la biblioteca de clips. Con Live encendido el documento no se edita: los botones de los
clips **disparan** (los `auto` se muestran pero suenan solos), los sliders de Parameters son los valores de la app
(no se guardan ni van al historial), la timeline muestra qué suena con su peso («■ Stop all» = `stop()`) y el canvas
es lo que verá la app. Al apagarlo se vuelve a lo que estaba abierto, con los valores de Parameters de antes. «Live
no se edita» vale para la persona: los cambios de la IA por MCP y deshacer sí cambian el documento, y el muñeco sigue
con el nuevo. «AI view» (también fuera de Live) muestra el manifiesto, como `get_manifest`.

**Ajustes de la auditoría (2026-11-11):** las bases se promedian entre sí durante el fundido cruzado y esa mezcla pisa
el montaje con el peso total (antes, dos bases iguales dejaban asomar el montaje a mitad del fundido); el fundido de un
clip `once` no pasa de la mitad de su duración; un `auto: "always"` suena en loop aunque el clip diga `once`; volver a
pedir una base que está saliendo la retoma; `stop` de un id que no existe o de un auto da error; `next` en un clip
`auto` es un error de validación.

### Para la IA

- **Edición (MCP):** `set_keys` acepta `fade`, `next`, `blend`, `auto`, `repeat_min` y `repeat_max` (o `apply_ops`).
  `render_preview` con **`live`** (un guion: `[{ t, play | stop | set }]`) y `times` devuelve la tira de cuadros de
  lo que vería la app, con el estado de cada cuadro (qué suena y con qué peso). El azar del parpadeo usa una semilla
  fija, así que el mismo guion da la misma tira.
- **Manifiesto** (`get_manifest`, `manifiesto()` en `src/core/manifiesto.js`): lo que lee la IA de la app. Los params
  (tipo, rango u opciones, valor inicial, descripción y **qué poses mueve cada uno**), los clips que se pueden
  disparar (base o gesto, descripción, duración, `next`, qué params anima) y las capas automáticas (solo informativas).
  El param gana `description` para esto. La fase 7 lo convierte en herramientas para el LLM (`play`, `set`, `stop`).

### Queda para después

State machine (en pausa), máscaras por región explícitas (hoy un clip ya pisa solo sus pistas), grabar una actuación
(● Rec), atajos de teclado por botón y el lip-sync desde el audio (fase 7: es un param que la app mueve).

## 10. La UI de Puppet: tres piezas en un solo panel (2026-11-12)

El usuario confundía el desplegable «View» de arriba (Setup / Parameters (blend) / Pose: …) con un atajo de los
clips: las tres piezas de Puppet estaban en tres lugares y con metáforas distintas, y no se veía que **los params
mezclan poses**. Se acordó (como las listas de animaciones e inputs de Rive y las acciones de Moho como recursos):

- **Un panel derecho con las tres piezas, apiladas y plegables:** Clips (lo que hace el muñeco; arriba, porque es lo que
  más se usa y lo que se dispara en Live), Parameters (perillas que mezclan poses) y **Poses** (fotos fijas). Las poses
  son una lista como la de clips: clic abre la pose para editarla (amarillo) y cada fila dice qué param la mueve
  (← happiness). Se descartaron las pestañas: ocupan menos, pero esconden la relación.
- **Sin el desplegable «View».** Un **cartel arriba del lienzo** dice qué se edita o se ve, en el color del marco, con
  el botón para salir: «Editing pose happy · Done», «Editing clip wave at 0.5 s · Close clip», «Previewing
  parameters · Reset» o «● Live · ■ Stop Live» (como el aviso de Moho al editar una acción).
- Lo que se pliega se recuerda por sección. El MCP no cambia: es solo la interfaz.
- **El inspector también se pliega**, en todos los modos (flecha del título «Inspector»; se recuerda). Se probó poner
  Clips, Parameters y Poses en una columna propia al lado del inspector y el usuario prefirió volver atrás: con el
  inspector plegable, cada uno decide cuánto lugar le da a cada cosa.
- **Orden y aspecto** (también pedido del usuario): Clips → Poses → Parameters → Inspector; cada cabecera de Puppet con + y 🗑
  como Layers y un fondo más oscuro para que se vea dónde empieza cada sección (el inspector no: es el mismo en todos los
  modos). Cada param en tres líneas: nombre y
  valor; el deslizador a todo el ancho; las poses que mezcla con su peso y un + para conectar otra.
