# Fase 1: esquema, documento y cáscara del editor

Qué se mide: si la IA entiende el formato (lista plana con `parent`, formas centradas, grupos como pivote, orden de
dibujo), si usa bien las operaciones y si respeta los retoques a mano.

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` conectado.
Pasar las tareas **una por una, tal cual**, sin pistas extra.

## Tareas

1. Crea un personaje nuevo llamado "Robot" de 600×600 con un fondo celeste claro.
2. Dibuja un robot simple usando solo rectángulos y elipses: cuerpo, cabeza, dos ojos, una boca, una antena y dos
   brazos. Organízalo en grupos para que después se pueda mover la cabeza y cada brazo por separado.
3. Muéstrame cómo quedó.
4. Pon los brazos detrás del cuerpo.
5. Renombra los objetos para que todos los nombres estén en inglés y sean claros.
6. *(A mano en el editor: mover la cabeza unos 30 px a la derecha y cambiar el color de la cara.)*
   Haz los ojos un poco más grandes. No toques lo que cambié yo.
7. Inclina la cabeza 15 grados hacia la derecha, girando desde el cuello.
8. Levanta el brazo izquierdo como si saludara, girando desde el hombro.
9. Deshaz lo último que hiciste.
10. Agrega un segundo personaje, "Robot pequeño", que sea una copia del robot a la mitad de tamaño.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | `meta` con 600×600 y `background` celeste. |
| 2 | Todas las piezas existen; hay grupos al menos para cabeza y brazos; nada queda fuera del lienzo. |
| 3 | Usa `render_preview` y describe lo que ve. |
| 4 | Los brazos quedan antes que el cuerpo en el orden de dibujo (con `move` + `index`). |
| 5 | Usa `rename`; la jerarquía no se rompe. |
| 6 | Mira `get_history`, agranda los ojos y no revierte la posición ni el color que cambió el usuario. |
| 7 | La cabeza gira alrededor del cuello: el grupo de la cabeza tiene su pivote abajo (si no, lo corrige). |
| 8 | El brazo gira desde el hombro (pivote del grupo del brazo arriba). |
| 9 | Usa `undo` y se deshace solo su último lote. |
| 10 | No existe "copiar": tiene que leer el documento y recrearlo con escala o tamaños a la mitad. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-02 | Claude Code (sesión nueva), Opus 5.5 | 8/8 (7 y 8 las hizo el usuario a mano) | 0 | 0 | Ver abajo. |

### Corrida del 2026-11-02

- **Lo que salió bien:** entendió el formato solo con `get_guide`. Puso los pivotes donde correspondía sin que se lo
  pidieran: la cabeza en el cuello y los brazos en los hombros. Ordenó las capas con `move` + `index`, renombró con
  `rename` sin romper la jerarquía, respetó todos los retoques del usuario y usó `undo` y `render_preview` como se
  esperaba. Fuera de la lista, el usuario le pidió un pingüino: 53 formas en grupos, también sin rechazos.
- **Tarea 6:** el usuario había agrandado solo el ojo izquierdo. La IA igualó el derecho a ese tamaño en vez de
  agrandar los dos, para no pisar el retoque. Fue razonable y lo explicó.
- **Tarea 10:** como no hay forma de copiar, recreó los 18 objetos en un documento nuevo, con el grupo raíz a
  escala 0.5.

**Problemas encontrados** (por orden de importancia):

1. **El historial del editor se llena de ruido.** Cada flecha, clic en el campo numérico o paso de arrastre del
   usuario es una entrada: unas 95 por un retoque normal. La IA no pudo reconstruir qué cambió el usuario desde el
   historial y tuvo que comparar documentos. Además, `Ctrl+Z` deshace de a 1 px.
2. **No hay forma de duplicar**, ni objetos ni documentos.
3. **Faltan respuestas útiles:** `undo` no dice qué deshizo, `apply_ops` no devuelve el árbol resultante y
   `get_history` no tiene una vista resumida.
4. **Detalles:** `create_document` no acepta `background`, y la guía no dice si izquierda/derecha son las del
   espectador o las del personaje (la IA usó las del espectador).
