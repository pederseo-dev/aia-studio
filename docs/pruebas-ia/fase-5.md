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
