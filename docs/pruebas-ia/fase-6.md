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
