# Fase 6: Puppet en vivo (base, gestos, capas auto y manifiesto)

Qué se mide: si la IA arma el comportamiento de un asistente sin state machine y con lo que hay: clips de base en
loop, gestos `once` encima, `next` para volver solo, capas `auto` (parpadeo y respiración aditiva) y descripciones
para la IA de la app. También si revisa el resultado con `render_preview` y `live` y si lee el manifiesto
(`get_manifest`). Ver [decision-animacion.md §9](../decision-animacion.md).

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` recién arrancado
(con `get_manifest` y `live` en `render_preview`). Se trabaja sobre `kiko_vivo`, una copia de `kiko`: 19 huesos,
params `happiness`, `blink`, `look`, `head_nod` y `viseme` (enum), y clips de Puppet `idle` (con un parpadeo
adentro), `wave`, `jump`, `nod_yes`, `laugh`, `talk_hello`, `shrug` y `quick_blink`. Pasar las tareas **una por una,
tal cual**, sin pistas extra.

## Tareas

1. En «Kiko vivo» quiero usar a Kiko como asistente en una app. Que parpadee solo cada tanto y que respire siempre,
   sin que la app tenga que pedirlo.
2. Arma los estados del asistente: reposo, escuchando, pensando y hablando. La app va a pasar de uno a otro según la
   conversación.
3. Cuando el usuario dice algo gracioso, que se ría un momento y después vuelva solo al reposo.
4. Muéstrame cómo lo vería la app: está en reposo, empieza a escuchar, piensa, habla y, mientras habla, saluda.
5. Que el saludo entre y salga más suave, y que no le tape la boca mientras habla.
6. ¿Qué va a saber la IA de la app sobre Kiko? Arregla lo que le falte para usarlo bien.
7. Deshaz lo último que hiciste.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | `quick_blink` (o uno nuevo) con `auto: "repeat"`, `fade` 0 y una espera razonable; una respiración `auto: "always"` en loop, mejor `blend: "additive"`. Saca el parpadeo de adentro de `idle` (si no, parpadea dos veces). |
| 2 | Cuatro clips de Puppet en `loop` (base) con `description`: reposo (`idle`), escuchando, pensando y hablando (con la boca: `viseme` animado). Empiezan y terminan igual. |
| 3 | `laugh` (o uno nuevo) es un gesto `once` con `next: "idle"` (o vuelve a la base porque es un gesto). |
| 4 | `render_preview` con `live`: un guion con `play` de las bases y un `wave` encima de «hablando», y lee el texto de qué suena. |
| 5 | Sube el `fade` de `wave`. Revisa que `wave` no keye la boca (`viseme`) ni lo que mueve la boca; si lo hace, lo saca. |
| 6 | Llama a `get_manifest`; completa la `description` de los params y de los clips que no la tienen. |
| 7 | `undo` deshace solo su último lote. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-11 | Claude Code (sesión aparte, solo MCP) con Opus 5.5 | 7/7 | 0 del validador; 1 de herramienta (`live` + `times`) | Ninguna | Ver abajo |

**Cómo lo hizo:** `breathe` nuevo (`always`, `additive`, escala del pecho), `quick_blink` pasó a `auto: repeat` con
`fade` 0 y sacó el parpadeo de adentro de `idle`. Creó `listening`, `thinking` y `talking` (con `viseme` alternando)
como bases con `description`. Puso `next: "idle"` a `laugh`. Revisó cada paso con `render_preview` y `live`. Al saludo
le subió el `fade` y le sacó la pista `happiness` (movía `mouth_rest` por la pose `happy`). Leyó `get_manifest` y
completó las descripciones de los params. En la tarea 7 deshizo los dos lotes de la tarea 6.

**Lo que encontró:**

1. **Bug:** `render_preview` con `live` y `times` fallaba con «time and times need animation».
2. La tira en vivo se cortaba sin avisar a los 24 cuadros (0.25 s × 24) y terminaba 0.5 s después del último evento:
   un saludo quedaba a medias. Un parpadeo de 0.25 s casi nunca caía en un cuadro.
3. **Ángulos que dan la vuelta:** un brazo en 140 con el montaje en -178.1 gira casi una vuelta en el fundido. Lo vio
   pensando, no por un aviso.
4. Una base que anima un param se lo quita a la app casi siempre; `next` en un gesto reemplaza la base (una risa a
   mitad de «hablando» deja a Kiko en reposo).
5. Manifiesto: el texto no decía qué pisa cada clip; un clip auto salía sin `animatesParams`; no mostraba `fade` ni
   avisaba de un param manejado por un auto ni de los params sin descripción.
6. `get_document` (162 k caracteres) no entraba en la respuesta y `apply_ops`/`undo` devolvían ~20 k con las pistas
   de todos los clips.
7. `set_keys` sin momentos (solo `fade` o `auto`) anotaba `tracks` en el historial.
8. Sin ayuda para apuntar un hueso a un punto (la mano al mentón se hizo con trigonometría) ni `undo` de varios lotes.

**Arreglado** (commit a6e0c01, con pruebas en `tests/vivo.test.js`):

1. `render_preview` con `live` acepta `times`; `until` dice hasta cuándo (por defecto, hasta que termina el último
   gesto disparado); con más de 24 cuadros los reparte y lo dice; lista cuándo sonó cada auto `repeat`; `auto: false`
   apaga las capas auto. La semilla fija va en la descripción.
2. `set_keys` avisa cuando una rotación de un clip de Puppet queda a más de 180° del montaje y propone el ángulo
   equivalente (`avisosDeGiro`).
3. Manifiesto: el texto lista lo que pisa cada clip (`overrides: params …; huesos…`) y su `fade`; los auto traen sus
   params; un param que maneja un auto dice «driven by auto …: don't set it»; `problems` resume params y clips sin
   descripción y params que no mueven nada.
4. `get_document` acepta `json: false` y `clips: [...]`, y deja el JSON afuera solo si la respuesta pasa de 60 000
   caracteres. `apply_ops`, `undo` y `create_document` muestran los clips resumidos (en `kiko_vivo`, de 30 k a 8 k).
5. `set_keys` sin momentos ni `remove` ya no toca `tracks`. La tira de un clip dice cuándo muestra solo parte de sus
   tiempos.
6. Guía: el costo de animar un param en una base, ángulos cerca del montaje, que `next` reemplaza la base, qué hacer
   con un parpadeo que ya estaba en `idle`, cuándo suena la primera vez un `repeat` y que `fade` se come el final.

**Pendiente:** apuntar un hueso a un punto (`aim` o IK de dos huesos, ya en «Después» del plan), `undo` de varios lotes
(o agrupados por pedido), «volver a la base de antes» después de un gesto con `next`, y ver dos guiones lado a lado.
