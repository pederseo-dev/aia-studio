# Fase 5: animación (clips de Puppet y escenas de Animate)

Qué se mide: si la IA arma clips con keyframes pensando en momentos (`set_keys`), si reutiliza las expresiones
animando params en vez de repetir valores, si elige `usage`, `loop` y curvas con sentido, si revisa el movimiento
con la tira de cuadros y si respeta un retoque hecho a mano en la timeline.

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` conectado (con
`set_keys` y `delete_keys`). Se trabaja sobre `gato_animado`, una copia de `gato_expresiones` (huesos, expresiones,
giro de cabeza y visemas de la fase 4). Pasar las tareas **una por una, tal cual**, sin pistas extra.

## Tareas

1. En «Gato animado», crea un parpadeo que la app pueda disparar cuando quiera.
2. Crea un reposo que se repita sin parar: que respire y mueva un poco la cola.
3. Crea un saludo alegre de algo más de un segundo: ladea la cabeza, se pone feliz, dice «a» y vuelve.
4. Muéstrame el saludo de principio a fin.
5. Haz que el saludo arranque suave y que la cabeza vuelva con un pequeño rebote.
6. *(A mano en el editor: en Puppet, abrir el saludo y mover o cambiar un keyframe.)*
   Alarga el saludo medio segundo al final, con la cola quieta, sin pisar lo que retoqué.
7. Arma una escena de unos 4 segundos en Animate: el gato en reposo, parpadea, después saluda y vuelve a quedarse
   quieto.
8. Deshaz lo último que hiciste.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | Un `animation` con `usage: "puppet"`, corto (≈0.15–0.4 s), con `description`, que cierra y abre los ojos (párpados, escala de ojos o switch) y vuelve al estado inicial. |
| 2 | `usage: "puppet"`, `loop: "loop"` (o `pingpong`), el primer y el último keyframe iguales (no salta al repetir), movimiento sutil del cuerpo y la cola. |
| 3 | `usage: "puppet"`, anima params (`happiness`, `viseme`, `head_turn` o el hueso de la cabeza) en vez de copiar valores de las poses a mano; termina como empieza. |
| 4 | `render_preview` con `animation` (tira de cuadros). |
| 5 | `ease` en los keyframes (`ease-in`/`ease-out` o un `cubic-bezier` que se pase). |
| 6 | Mira `get_history` con `origin: "user"`, conserva el keyframe retocado, alarga `duration` y agrega keyframes al final sin `remove` de lo del usuario. |
| 7 | Un `animation` con `usage: "animate"` de ≈4 s que arma la secuencia con keyframes (hoy no se insertan clips por referencia). |
| 8 | `undo` deshace solo su último lote. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-05 | Claude Code (subagente nuevo, solo con el MCP), Opus 5.5 | 8/8 | 0 | 0 | Tareas 1–5 de corrido; el retoque a mano de la tarea 6 se hizo por la API del editor (origen `user`); 6–8 en la misma conversación. Ver abajo. |
| 2026-11-06 | Claude Code (sesión nueva, solo MCP), Opus 5.5 | 9/9 | 0 | 0 | Segunda ronda, después de la timeline nueva y de «params solo en Puppet». Ver «Segunda ronda». |

**Cómo lo hizo:**
- **Tarea 1:** `blink` (puppet, 0.2 s, once, con descripción). Aplasta `eye_*`/`pupil_*` (`height`) y apaga los
  brillos; cerrado de 0.08 a 0.11 con `ease-in`/`ease-out`. No usó los párpados `lid_*` porque son de la pose `sad`.
- **Tarea 2:** `idle` (puppet, 3 s, loop). Respira con `body_bone.scaleX/scaleY` y mece `tail_1…3`, todo
  `ease-in-out`, con el último keyframe igual al primero.
- **Tarea 3:** `greet` (puppet, 1.3 s). El primer intento animó el param `happiness`, y la tira mostró la cabeza
  girada ~45° y despegada: en este rig `happiness` también mueve el driver `happiness_to_mirando_arriba_1` (un
  retoque viejo del usuario), que se sumaba a su giro. Lo corrigió con `pose: "happy"` como keyframes, el hueso de la
  cabeza a 12° y `viseme` «a»; escribió a mano los valores del montaje (≈20 propiedades, con los vértices de la boca)
  para entrar y salir de la pose.
- **Tarea 4:** `render_preview` con `animation` y `times` cada 0.1 s.
- **Tarea 5:** `ease-in-out` al arrancar y `[0.3, 1.6, 0.6, 1]` en la vuelta de la cabeza (se pasa y vuelve).
  Para cambiar solo la curva tuvo que reenviar los valores de t = 0.
- **Tarea 6:** vio el retoque con `get_history` (`origin: "user"`, `detail`): cabeza a 18° en 0.3 s y la «a» movida
  a 0.5 s. Solo cambió `duration` a 1.8 con `apply_ops` (todo se mantiene en el último valor desde 1.3). No usó
  `set_keys` por miedo a que reescribir `tracks` chocara con el retoque al deshacer.
- **Tarea 7:** `scene` (animate, 4 s): copió a mano los keyframes de `idle`, `blink` y `greet`, corridos en el tiempo
  (respetando el retoque del usuario).
- **Tarea 8:** `undo` deshizo solo la escena.

**Problemas encontrados y qué se hizo:**

1. **Volver al montaje obligaba a copiar valores a mano** (tareas 3 y 7). → `set_keys` acepta `setup: true` en un
   momento: pone el montaje en todo lo que el clip anima (y los params en su valor inicial).
2. **Cambiar solo una curva obligaba a reenviar valores** (tarea 5). → Un momento con solo `t` y `ease` (y
   `targets` opcional) cambia la curva de los keyframes que ya hay en ese tiempo.
3. **Duda sobre pisar al usuario con `set_keys`** (tarea 6). Era fundada: deshacer contaba `tracks` como una sola
   propiedad. → `undo`/`redo` comparan y restauran **por pista** (`tracks.objeto.propiedad`), como los `values` de
   las poses; la guía y la descripción de `set_keys` lo dicen.
4. **El acople oculto de un param** (tarea 3): animar un param mueve todas las poses de sus drivers. → La guía lo
   advierte. Pendiente: un aviso de `set_keys`/`render_preview` cuando un clip anima un hueso que un param animado
   también mueve.
5. **Pendientes:**
   - Clips de Puppet dentro de una escena de Animate (por referencia); ya estaba en el plan.
   - Leer un clip sin pedir el historial detallado (un resumen de keys por pista con valores).
   - Respirar escalando el cuerpo agranda la cabeza: falta que un hueso no herede la escala (o un consejo en la guía).
   - Una vista previa después de `undo`.

## Segunda ronda (2026-11-06): timeline, escenas y clips de Puppet

Después de rehacer la timeline y de decidir que los params son solo de Puppet (una escena se evalúa sin drivers), se
repitió la prueba sobre «Gato expresiones» para que la IA usara todas las herramientas de animación. Las tareas se
pasaron de a una, sin pistas:

1. Una escena corta de 3 s: el gato se inclina hacia un lado y al final vuelve a quedar como estaba.
2. En esa escena, que diga «a-o-a» entre el segundo 1 y el 2.
3. Que a los 1.5 s ponga cara feliz.
4. Que el cuerpo vuelva a su lugar de golpe, sin cambiar los tiempos.
5. Correr la «o» una décima más tarde, sin mover nada más.
6. Tres gestos para usar en vivo: parpadeo, un saludo que lo ponga contento y un reposo que se repita.
7. Que el saludo dure 1 segundo.
8. Sacar la cara feliz de la escena, sin tocar lo demás.
9. Deshacer lo último.

**Cómo lo hizo:**
- **1:** `lean_side` (Animate, 3 s) en un solo `set_keys`. Cuerpo, cabeza, cola y orejas con `ease-in-out`, y la vuelta
  exacta al montaje. Revisó con tiras de cuadros.
- **2:** keyó `mouth.active` (rest, a, o, a, rest). No intentó usar params en la escena.
- **3:** copió de la pose `happy` solo los ojos y la boca (sin la cola), de 1.2 a 1.5 s, sostenida hasta 2.4 s. Detalle:
  la sonrisa está en `mouth_rest`, así que recién se ve después de 2 s, cuando termina el «a-o-a».
- **4:** cambió solo la curva del tramo con un `cubic-bezier` propio, `[0.9, 0, 1, 0.1]`.
- **5:** `move_keys` sobre la pista `mouth.active`: la «o» pasó de 1.33 a 1.43 s.
- **6:** `blink` (0.25 s), `greet` (1.8 s, la pata saluda y `happiness` sube a 1) e `idle` (3 s, en loop), todos de
  Puppet y con `description`. En `greet` corrigió la pata dos veces, porque el gato no tiene brazo.
- **7:** acortó `greet` a 1 s con los momentos en proporción. Le llevó **7 lotes**, uno por momento con `move_keys` y
  después `duration`, así que deshacerlo lleva 7 pasos.
- **8:** `delete_keys` de las 14 pistas de la cara.
- **9:** `undo` devolvió las 14 pistas, y nada más cambió.

**Problemas encontrados** (por orden de importancia):

1. **No hay forma de reescalar el tiempo de un clip.** Para acortar el saludo movió los momentos de a uno, y quedaron
   7 entradas de deshacer. Pidió un `scale_time` (o `duration` con `scale: true`), y el editor necesita lo mismo.
2. **Faltan avisos de lo que mueve un param.** En Puppet, `happiness` también mueve la pose `mirando_arriba`, por un
   driver que hizo el usuario, y ninguna herramienta lo avisó: lo vio recién en la vista previa. `set_keys` y
   `render_preview` podrían listar las poses que mueve cada param animado.
3. **Copiar solo una parte de una pose:** pidió `pose` con un filtro de objetos en `set_keys`.
4. **Valores relativos al montaje** («+14°») en `set_keys`.
5. **Curvas:** no hay curvas fuertes con nombre ni forma de ver la curva de un tramo; para la vuelta de golpe adivinó
   los números del cubic-bezier.
6. **Antes del primer keyframe el clip usa el valor de ese keyframe:** tuvo que poner a mano la boca normal en 0 s.
   Es lo esperado, pero conviene decirlo en la guía.
7. **Rig:** sin brazo ni IK o pin, la pata del saludo flota. Esto es del personaje, no de la herramienta.


**Arreglado después de la segunda ronda** (en `fase-4/params`, con paridad en el editor y pruebas):

1. **Reescalar el tiempo:** herramienta nueva `scale_time` (`duration` o `factor`; con `from`/`to`, solo un tramo, y lo
   de después se corre). Es un solo `set`, así que se deshace en un paso. En el editor, «Scale keys» junto a Length:
   cambiar el largo estira o comprime todos los keyframes. Acortar `greet` ahora es una llamada.
2. **Qué mueve un param:** `set_keys` y `render_preview` listan, por cada param animado de un clip de Puppet, las poses
   de sus drivers y los objetos que toca cada una (`happiness → happy (…), sad (…), mirando_arriba (head_bone, …)`). En
   la timeline, el canal del param dice `→ happy, sad, mirando_arriba` y el detalle va en el tooltip.
3. **Una parte de una pose:** `pose` con `only` o `except` ("objeto.propiedad" o un id); si se nombra algo que la pose
   no fija, el error dice qué fija. En el editor, «◆ Pose…» tiene un grupo «Only the selection» (lo seleccionado y lo que
   cuelga de ello).
4. **Relativos al montaje:** un número de `values` puede ser `"+=14"` o `"-=0.3"`. Se resuelve al guardar y la pista
   sigue siendo absoluta, así que el esquema no cambia. Solo en propiedades numéricas.
5. **Curvas:** 12 curvas fuertes con nombre (`ease-in/out/in-out` con `-quad`, `-cubic`, `-expo` y `-back`), todas
   cubic-bezier fijas. La guía describe cada una (sale de `DESCRIPCION_DE_CURVAS`, y una prueba exige que estén todas)
   y recomienda `ease-in-expo` para «vuelve de golpe». La timeline dibuja la forma de la curva del ◆ elegido.
6. **Guía:** keyar el estado inicial en `t = 0`, porque antes del primer keyframe se ve el valor de ese keyframe.
