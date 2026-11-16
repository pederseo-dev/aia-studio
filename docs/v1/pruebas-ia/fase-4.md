# Fase 4: expresiones, params y drivers

Qué se mide: si la IA arma expresiones como poses (con morph de formas, switch o huesos), si las conecta a params
de alto nivel con drivers bien orientados (los dos lados de un param de -1 a 1), si la mezcla de varias se ve bien y
si respeta un retoque hecho a mano dentro de una pose.

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` conectado.
Se trabaja sobre una copia del gato de la fase 3 (`gato_expresiones`, copia de `gato_rig`, que ya tiene huesos).
Pasar las tareas **una por una, tal cual**, sin pistas extra.

## Tareas

1. En «Gato expresiones», haz que el gato pueda ponerse feliz o triste con un solo control que vaya de -1 (triste)
   a 1 (feliz). Que cambie al menos la boca y los ojos.
2. Agrega la sorpresa como otro control aparte.
3. Que el giro de la cabeza también sea un control, de -1 (izquierda) a 1 (derecha).
4. Muéstrame al gato feliz con la cabeza girada a la derecha, y triste mirando a la izquierda.
5. Prepara la boca para lip-sync: un control con las bocas rest, a, e, o y m.
6. *(A mano en el editor: elegir la pose de feliz en «Ver» y retocar la boca o los ojos.)*
   Haz que la sorpresa también levante un poco las orejas, sin tocar lo que retoqué.
7. Muéstrame al gato sorprendido diciendo «o».
8. Deshaz lo último que hiciste.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | Un `param` de -1 a 1 y dos poses (feliz y triste) con dos drivers: uno de 0 a 1 y otro de 0 a -1. La boca cambia con morph (misma cantidad de vértices) o con un switch. |
| 2 | Otro `param` (0 a 1) con su pose y su driver. |
| 3 | Un `param` de -1 a 1 con dos poses de hueso de la cabeza (o una con tramo negativo bien armado). |
| 4 | Usa `render_preview` con `params` y la mezcla se ve bien (la expresión y el giro a la vez). |
| 5 | Un `param` enum con las cinco opciones, un `switch` (o morph) para la boca y un driver con `equals` por visema. |
| 6 | Mira `get_history` con `origin: "user"`, toca solo la pose de sorpresa (sin `replace`) y no la de feliz. |
| 7 | `render_preview` con `params` de sorpresa y visema «o» a la vez. |
| 8 | `undo` deshace solo su último lote. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-04/05 | Claude Code (dos sesiones nuevas), Opus 5.5 | 8/8 | — | 0 | Tareas 1–5 en una sesión; 6–8 en otra, después del cambio al modelo Skeleton y de los arreglos de la auditoría (el MCP viejo no conocía `skeleton`). Ver abajo. |

**Cómo lo hizo:**
- **Tareas 1 a 3:** `happiness` de -1 a 1 con las poses `happy` y `sad` y dos drivers, uno por lado. Boca con morph y
  ojos. Para la tristeza agregó párpados (`lid_l`/`lid_r`) que aparecen con la opacidad. `surprise` de 0 a 1 y
  `head_turn` de -1 a 1 con las poses `head_left`/`head_right`, que mueven los rasgos de la cara.
- **Tarea 4:** revisó las dos mezclas con `render_preview` y `params`.
- **Tarea 5:** metió la boca en un switch `mouth` (`mouth_rest`, `mouth_a`, `mouth_e`, `mouth_o`, `mouth_m`), con el
  param enum `viseme` y un driver con `equals` por visema. Además corrigió las poses de giro para que movieran el
  switch entero.
- **Tarea 6:** el retoque del usuario no fue en la pose `happy` sino un driver nuevo, `happiness → mirando_arriba`
  (entrada 13). La IA leyó `get_history`, vio los retoques del usuario y en un solo lote solo tocó la pose
  `surprised`: las orejas suben de `x: 132` a `x: 144`. Lo comprobó con renders, también combinado con el giro.
- **Tarea 7:** `render_preview` con `surprise: 1` y `viseme: "o"`, sin cambios.
- **Tarea 8:** `undo` deshizo solo el lote 15. La pose quedó igual que antes.
- Rechazos: en las tareas 6 a 8 no hubo ninguno. En las tareas 1 a 5 no se contaron.

**Problemas encontrados** (por orden de importancia):

1. **Dos poses que muestran cosas que se tapan.** La pose `surprised` prende su propia boca (`mouth_gasp`), y el
   visema «o» prende `mouth_o` en el switch: con los dos activos se dibujan dos bocas encimadas. La IA lo detectó
   en la tarea 7 y propuso que la sorpresa use el switch. Falta un aviso cuando dos poses activas muestran cosas que
   compiten, o cuando una pose mueve hijos de un objeto que otra pose también mueve (lo pidió también en la tarea 5).
2. **La opacidad intermedia se ve mal** para mostrar u ocultar partes (párpados semitransparentes con
   `happiness: -0.5`). Pidió un umbral, o dejar claro que `visible` cambia con peso ≥ 0.5.
3. **Mover un hueso «hacia arriba» en una pose obliga a hacer la cuenta en los ejes del padre.** Pidió un
   desplazamiento en coordenadas del documento dentro de una pose (como `from`/`to` en el montaje).
4. **Revisar cuesta:**
   - No hay forma de comparar el antes y el después de una pose, ni una cuadrícula de varios valores de params (por
     ejemplo, todos los visemas) en una sola imagen.
   - `get_history` no dice qué retoques del usuario tocan una pose dada.
5. **Detalles:**
   - Faltan máscaras o recortes (párpados dentro del ojo).
   - `index` en `create` no se respetó para los párpados.
   - Cuesta ajustar las rotaciones en cadena de la cola a ojo.
   - Con el giro, la oreja lejana asoma un poco por el contorno.
