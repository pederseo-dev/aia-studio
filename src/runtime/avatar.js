// Runtime de navegador: monta un personaje en un contenedor y lo actualiza a partir de sus params.
// Los setters solo marcan como sucio; un único update por frame toca el DOM, y solo lo que cambió.

import { evaluar, matricesDelMundo, valoresIniciales } from '../core/pose.js';
import { matrizSvg, opacidad, svgComoTexto } from '../core/svg.js';

export class Avatar {
  /** @param {HTMLElement} contenedor */
  constructor(contenedor, doc, { alActualizar } = {}) {
    this.contenedor = contenedor;
    this.alActualizar = alActualizar;
    this.valores = {};
    this.pendiente = false;
    this.cargar(doc);
  }

  /** Carga (o recarga) un documento conservando los valores de los params que sigan existiendo. */
  cargar(doc) {
    this.doc = doc;
    const previos = this.valores;
    this.valores = valoresIniciales(doc);
    for (const id in this.valores) if (id in previos) this.valores[id] = previos[id];

    this.pose = evaluar(doc, this.valores);
    this.mundo = matricesDelMundo(doc, this.pose);
    this.contenedor.innerHTML = svgComoTexto(doc, this.pose, this.mundo);
    this.svg = this.contenedor.querySelector('svg');
    this.svg.removeAttribute('width');
    this.svg.removeAttribute('height');

    this.nodos = new Map();
    for (const el of this.svg.querySelectorAll('[data-part], [data-slot]')) {
      this.nodos.set(el, { transform: el.getAttribute('transform'), opacity: el.getAttribute('opacity') });
    }
    this.alActualizar?.(this);
  }

  get(param) {
    return this.valores[param];
  }

  set(param, valor) {
    if (!(param in this.valores)) return;
    this.valores[param] = valor;
    if (this.pendiente) return;
    this.pendiente = true;
    requestAnimationFrame(() => {
      this.pendiente = false;
      this.actualizar();
    });
  }

  actualizar() {
    this.pose = evaluar(this.doc, this.valores);
    this.mundo = matricesDelMundo(this.doc, this.pose);
    const huesoDe = new Map([...this.doc.rig.parts, ...this.doc.rig.slots].map((d) => [d.id, d.bone]));

    for (const [el, cache] of this.nodos) {
      const id = el.dataset.part ?? el.dataset.slot;
      const transform = matrizSvg(this.mundo[huesoDe.get(id)]);
      if (transform !== cache.transform) el.setAttribute('transform', (cache.transform = transform));
      if (el.dataset.part) {
        const op = String(opacidad(this.pose.parts[id].opacity));
        if (op !== cache.opacity) el.setAttribute('opacity', (cache.opacity = op));
      } else {
        const activa = this.pose.slots[id].active;
        if (activa !== cache.activa) {
          cache.activa = activa;
          for (const opcion of el.children) {
            if (opcion.dataset.option === activa) opcion.removeAttribute('display');
            else opcion.setAttribute('display', 'none');
          }
        }
      }
    }
    this.alActualizar?.(this);
  }
}
