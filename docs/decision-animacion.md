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
  Design queda para dibujo y rig puros (lo que hoy es «View: Setup»).
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
3. Los drivers suman sus poses **encima de lo animado**, igual que hoy suman sobre el montaje: un saludo animado más
   la cara feliz que da un param.

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
