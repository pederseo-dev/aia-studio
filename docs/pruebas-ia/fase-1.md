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
