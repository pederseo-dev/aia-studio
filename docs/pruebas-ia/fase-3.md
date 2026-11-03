# Fase 3: huesos

Qué se mide: si la IA arma un esqueleto que encaje con el dibujo (huesos en las articulaciones, cadenas con
ángulos relativos bien calculados), si enlaza las partes en el nivel correcto, si arma poses con nombre sin tocar el
montaje y si respeta un retoque de pose hecho a mano.

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` conectado.
Se trabaja sobre una copia del gato de la fase 2 (`gato_rig`, creada con «Hacer una copia…» o con
`create_document` + `copy_from`). Pasar las tareas **una por una, tal cual**, sin pistas extra.

## Tareas

1. Arma el esqueleto de «Gato rig» para poder posarlo: un hueso para el cuerpo, uno para la cabeza (que gire desde
   el cuello) y una cola de al menos tres huesos encadenados. Enlaza cada parte del dibujo al hueso que le toca.
2. Muéstrame dónde quedaron los huesos.
3. Crea una pose «mirando_arriba» en la que el gato levante la cabeza.
4. Crea una pose «cola_feliz» con la cola levantada y curvada hacia arriba.
5. Que la cabeza no pueda girar más de 30° hacia cada lado.
6. *(A mano en el editor: elegir la pose «cola_feliz» y girar el último hueso de la cola.)*
   En «cola_feliz», inclina también un poco la cabeza, sin tocar lo que retoqué.
7. Agrega un hueso por oreja para que se muevan aparte, y una pose «orejas_atentas».
8. Muéstrame las tres poses.
9. Deshaz lo último que hiciste.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | Huesos `bone` encadenados (la cola con `x` = `length` del padre). El grupo de la cabeza enlazado al hueso de la cabeza (no cada forma); la cola al suyo. El montaje no mueve nada del dibujo. |
| 2 | Usa `render_preview` con `bones: true` (o lee `get_document`) y los huesos caen sobre las partes. |
| 3 | Crea una `pose` (con `set_pose` o `apply_ops`) y no cambia los valores de los huesos del montaje. La cabeza sube, no se desarma. |
| 4 | Pose con la cola curvada: rotaciones encadenadas en el mismo sentido. |
| 5 | Pone `minAngle`/`maxAngle` en el hueso de la cabeza, alrededor de su rotación del montaje. |
| 6 | Mira `get_history` con `origin: "user"`, agrega solo el hueso de la cabeza a la pose (sin `replace`) y conserva el valor retocado de la cola. |
| 7 | Huesos de oreja hijos del de la cabeza; cada oreja (su grupo) enlazada a su hueso; las orejas siguen a la cabeza al posarla. |
| 8 | Usa `render_preview` con `pose` para cada una. |
| 9 | `undo` deshace solo su último lote. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-03 | Claude Code (sesión nueva), Opus 5.5 | 9/9 | 1 | 0 | Ver abajo. |

### Corrida del 2026-11-03

- **Lo que salió bien:** armó el esqueleto con los ángulos relativos bien calculados: `body_bone` de la base al
  cuello, `head_bone` desde el cuello y una cola de 4 huesos encadenados. Los huesos de las orejas quedaron del lado
  correcto (`ear_l` a la derecha del espectador). Enlazó en el nivel alto (`cat`, `head`, `ear_l`, `ear_r`) y no
  forma por forma. Revisó con `render_preview` y `bones: true`, hizo las poses con `set_pose` sumando (sin
  `replace`), puso `minAngle`/`maxAngle` alrededor del montaje y `undo` deshizo solo su último lote.
- **Tarea 6:** el usuario retocó la pose «mirando_arriba» y movió dos huesos en el montaje, no «cola_feliz» como
  decía la consigna. La IA lo encontró en `get_history`, sumó la cabeza a «cola_feliz» y no tocó nada de lo del
  usuario.
- **El rechazo:** su primer lote creaba un hueso `head` y ya existía el grupo `head`. Renombró los huesos a
  `head_bone` y `body_bone`.
- **Cola:** como un path sigue a un solo hueso, reemplazó la cola curva por 4 rectángulos redondeados (contorno
  detrás y relleno delante), cada uno con su `originX` en la articulación. Funciona, pero se ve más tosca que el
  dibujo original.

**Problemas encontrados** (por orden de importancia):

1. **Una forma no puede doblarse con varios huesos.** Para una cola o un brazo flexible hace falta deformar un path
   con varios huesos (pesos por vértice, la v2 del binding en la síntesis) o un tipo «tira» con ancho y extremos
   redondeados.
2. **Crear huesos en coordenadas relativas cuesta.** Pidió poder dar origen y punta en coordenadas del documento
   (`from`/`to`) y que se calcule `x`, `y`, `rotation` y `length`.
3. **`get_history` resume qué se tocó pero no el valor final**, así que tuvo que leer el documento para ver cómo
   quedó el retoque del usuario.
4. **Detalles:**
   - `set_pose` no avisa cuando un ángulo se recorta por `minAngle`/`maxAngle`.
   - No hay aviso de que un id de hueso choca con uno del dibujo (el error de "ya existe" alcanzó, pero una
     convención `_bone` en la guía lo evitaría).
   - `undo` podría decir qué queda en pie.
