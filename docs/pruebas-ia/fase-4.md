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
