# Fase 2: dibujo

Qué se mide: si la IA dibuja bien con paths curvos (con `d` o con vértices), si usa estilos compartidos y
degradados para la paleta, si sabe retocar vértices sueltos y si respeta un retoque de curva hecho a mano.

Preparación: `npm run dev` abierto en el navegador y una conversación nueva con el MCP `aia-studio` conectado.
Pasar las tareas **una por una, tal cual**, sin pistas extra.

## Tareas

1. Crea un personaje nuevo, "Gato", de 600×600.
2. Define la paleta del gato como estilos compartidos: pelaje, panza, nariz y un contorno oscuro.
3. Dibuja un gato original sentado y de frente usando formas curvas (no solo elipses): cabeza con orejas
   puntiagudas, cuerpo, una cola curva, ojos, nariz y bigotes. Usa los estilos de la paleta. Arma grupos para que
   la cabeza gire desde el cuello y la cola desde su base.
4. Muéstramelo.
5. Dale volumen al pelaje con un degradado.
6. Cambia el pelaje a gris. Todo de una vez.
7. Haz la cola más curva.
8. *(A mano en el editor: entrar a editar los puntos de una oreja y cambiarle la forma.)*
   Haz que la otra oreja quede igual a la que retoqué, en espejo.
9. Si el pivote de la cabeza no está en el cuello, muévelo ahí sin que la cabeza cambie de lugar.
10. Deshaz lo último que hiciste.

### Qué mirar en cada tarea

| Tarea | Se considera lograda si... |
| --- | --- |
| 1 | Documento de 600×600. |
| 2 | Hay recursos `style` con nombres claros y colores coherentes. |
| 3 | Usa `path` con curvas (vértices mirrored, asymmetric o detached, o `d` con C/Q/A). Las formas usan `style`. Los bigotes son paths abiertos. Los pivotes de la cabeza y de la cola están donde corresponde. |
| 4 | Usa `render_preview` y describe lo que ve. |
| 5 | Crea un degradado y lo pone en `fillGradient` del estilo de pelaje (no forma por forma). |
| 6 | Cambia solo el estilo (o su degradado): un lote corto, no uno por forma. |
| 7 | Modifica los vértices de la cola y la forma sigue siendo continua. |
| 8 | Mira `get_history` con `origin: "user"`, lee los vértices de la oreja retocada y los espeja en la otra (vértices espejados o `scaleX: -1`). No toca la oreja retocada. |
| 9 | Ajusta `x`/`y` del grupo y compensa los hijos (el dibujo no se mueve). |
| 10 | `undo` deshace solo su último lote. |

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
| 2026-11-03 | Claude Code (sesión nueva), Opus 5.5 | 7/7 (8 a 10 sin correr) | 0 | 0 | Ver abajo. |

### Corrida del 2026-11-03

- **Lo que salió bien:** dibujó un gato con 17 paths curvos (8 abiertos: bigotes y boca), usó los cuatro estilos de
  la paleta en 22 objetos y puso el degradado radial `fur_shade` en el estilo `fur` y no forma por forma. Los
  pivotes quedaron donde correspondía: la cabeza en el cuello y la cola en su base. No tuvo ningún lote rechazado.
- **Tareas 8 a 10 sin correr:** dependían de un retoque a mano de una oreja, y la pestaña con el dibujo se cerró
  antes de hacerlo. Se saltearon para seguir con la implementación. El espejado de un retoque del usuario y el
  pivote con compensación quedan para probarlos en la fase 3, que vuelve a necesitarlos.

**Lo que pidió la IA** (para más adelante, por orden de importancia):

1. **Herencia entre estilos** (un estilo base): el color del contorno se repite en varios estilos.
2. **Degradados atados al color del estilo:** para pasar el pelaje a gris tuvo que cambiar el estilo y también las
   paradas del degradado.
3. **Duplicar en espejo** cambiando `_l` por `_r` en los ids de los hijos.
4. **`render_preview` con zoom o recorte** para revisar detalles chicos (ojos, bigotes).
