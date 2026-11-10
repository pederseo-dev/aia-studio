// Herramienta Artboard: manijas en el borde del lienzo para cambiar su tamaño arrastrando. Como en Moho, el dibujo
// queda anclado al centro: el lienzo crece o se achica por igual a cada lado (ver core/tamano.js), así que el centro
// del marco no se mueve en pantalla (el lienzo corrige la cámara) y el tamaño sale del punto arrastrado.

import { leerMeta } from '../core/esquema.js';
import { opsDeTamano } from '../core/tamano.js';
import { docVisible, ejecutar, esquema, estado, previsualizar } from './estado.js';

// Manijas: dirección en x e y (-1 izquierda/arriba, 0 medio, 1 derecha/abajo).
const MANIJAS = { no: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], so: [-1, 1], o: [-1, 0] };
const CURSORES = { no: 'nwse', se: 'nwse', ne: 'nesw', so: 'nesw', n: 'ns', s: 'ns', e: 'ew', o: 'ew' };

export function crearArtboard(ctx) {
  let medida = null; // "W × H" junto al puntero mientras se arrastra

  /** El marco del documento en pantalla. */
  function marco() {
    const doc = docVisible();
    const [zoom, , , , cx, cy] = ctx.matrizCamara();
    const w = leerMeta(esquema, doc, 'width');
    const h = leerMeta(esquema, doc, 'height');
    return { x: cx, y: cy, w: w * zoom, h: h * zoom, ancho: w, alto: h, zoom };
  }

  function dibujar() {
    const m = marco();
    ctx.superposicion.append(ctx.crear('rect', { class: 'seleccion marco-artboard', x: m.x, y: m.y, width: m.w, height: m.h }));
    for (const [nombre, [dx, dy]] of Object.entries(MANIJAS)) {
      const x = m.x + ((dx + 1) / 2) * m.w;
      const y = m.y + ((dy + 1) / 2) * m.h;
      const manija = ctx.crear('rect', { class: 'manija', 'data-manija': `artboard-${nombre}`, x: x - 4, y: y - 4, width: 8, height: 8 }, 'Resize the artboard; the drawing stays centered (Shift: keep proportions)');
      manija.style.cursor = `${CURSORES[nombre]}-resize`;
      ctx.superposicion.append(manija);
    }
    if (medida) {
      const t = ctx.crear('text', { class: 'medida-artboard', x: medida.x + 14, y: medida.y - 10 });
      t.textContent = medida.texto;
      ctx.superposicion.append(t);
    }
  }

  function manija(e, nombre) {
    const [dx, dy] = MANIJAS[nombre.slice('artboard-'.length)];
    const m = marco();
    // El centro queda fijo en pantalla mientras dura el arrastre.
    const centro = [m.x + m.w / 2, m.y + m.h / 2];
    const proporcion = m.ancho / m.alto;
    let tamano = null;

    ctx.arrastrar(
      e,
      (ev) => {
        const [px, py] = ctx.puntoPantalla(ev);
        let ancho = dx ? Math.max(1, Math.round((2 * Math.abs(px - centro[0])) / m.zoom)) : m.ancho;
        let alto = dy ? Math.max(1, Math.round((2 * Math.abs(py - centro[1])) / m.zoom)) : m.alto;
        // Shift: mantiene la proporción (en una manija de lado, el otro lado acompaña).
        if (ev.shiftKey) {
          if (dx && (!dy || ancho / m.ancho >= alto / m.alto)) alto = Math.max(1, Math.round(ancho / proporcion));
          else ancho = Math.max(1, Math.round(alto * proporcion));
        }
        tamano = [ancho, alto];
        medida = { x: px, y: py, texto: `${ancho} × ${alto}` };
        previsualizar(opsDeTamano(estado.doc, esquema, ancho, alto));
      },
      () => {
        medida = null;
        if (!tamano || (tamano[0] === m.ancho && tamano[1] === m.alto)) {
          previsualizar(null);
          return ctx.redibujar();
        }
        ejecutar(opsDeTamano(estado.doc, esquema, ...tamano), `artboard ${tamano[0]} × ${tamano[1]}`);
      },
    );
  }

  return { dibujar, manija };
}
