// Árbol de objetos: muestra la jerarquía con lo que está al frente arriba (como en Moho o Figma).
// Arrastrar una fila cambia el orden o el padre; doble clic renombra; el ojo muestra u oculta.

import { buscar, hijos, subarbol } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { aplicar, invertir, matrizMundo } from '../core/geometria.js';
import { ejecutar, esquema, estado, seleccionar, suscribir } from './estado.js';

const ICONOS = { group: '▣', rect: '▭', ellipse: '◯', path: '✒', style: '◆', linear_gradient: '▤', radial_gradient: '◍' };
const esRecurso = (o) => esquema.tipos.get(o.type)?.resource;

/** Árbol de objetos en `raiz` y lista de recursos (estilos, degradados) en `raizRecursos`. */
export function montarArbol(raiz, raizRecursos) {
  let arrastrado = null;
  // Grupos plegados, por documento (estado del editor: no va en el documento).
  const plegados = new Map();
  const plegadosDe = () => plegados.get(estado.id) ?? plegados.set(estado.id, new Set()).get(estado.id);

  suscribir((c) => {
    if ('doc' in c || 'seleccion' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    if (!doc) return raiz.replaceChildren(), raizRecursos.replaceChildren();
    const objetos = rama(doc, null, 0);
    if (objetos.length) raiz.replaceChildren(...objetos);
    else raiz.innerHTML = '<li class="vacio">Vacío. Dibuja con las herramientas o pídeselo a la IA.</li>';
    const recursos = doc.objects.filter(esRecurso).map((o) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="fila${o.id === estado.seleccion ? ' seleccionada' : ''}" data-id="${o.id}" style="padding-left:8px"><span class="tipo" title="${o.type}">${ICONOS[o.type] ?? '•'}</span><span class="nombre"></span></div>`;
      li.querySelector('.nombre').textContent = o.id;
      return li;
    });
    if (recursos.length) raizRecursos.replaceChildren(...recursos);
    else raizRecursos.innerHTML = '<li class="vacio">Sin estilos ni degradados.</li>';
    raiz.querySelector('.seleccionada')?.scrollIntoView({ block: 'nearest' });
  }

  function rama(doc, padre, nivel) {
    return hijos(doc, padre)
      .filter((o) => !esRecurso(o))
      .reverse()
      .map((o) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'treeitem');
        const visible = leer(esquema, o, 'visible');
        const fila = document.createElement('div');
        fila.className = `fila${o.id === estado.seleccion ? ' seleccionada' : ''}${visible ? '' : ' oculta'}`;
        fila.dataset.id = o.id;
        fila.draggable = true;
        fila.style.paddingLeft = `${4 + nivel * 14}px`;
        const tieneHijos = hijos(doc, o.id).length > 0;
        const plegado = plegadosDe().has(o.id);
        fila.innerHTML = `<button type="button" class="plegar${tieneHijos ? '' : ' vacio'}" title="${plegado ? 'Desplegar' : 'Plegar'}" tabindex="-1">${plegado ? '▸' : '▾'}</button>
          <span class="tipo" title="${o.type}">${ICONOS[o.type] ?? '•'}</span><span class="nombre"></span>
          <button type="button" class="ojo${visible ? '' : ' oculto'}" title="${visible ? 'Ocultar' : 'Mostrar'}">${visible ? '◉' : '○'}</button>`;
        fila.querySelector('.nombre').textContent = o.id;
        li.append(fila);
        const subrama = plegado ? [] : rama(doc, o.id, nivel + 1);
        if (subrama.length) {
          const ul = document.createElement('ul');
          ul.setAttribute('role', 'group');
          ul.append(...subrama);
          li.append(ul);
        }
        return li;
      });
  }

  for (const lista of [raiz, raizRecursos]) {
    lista.addEventListener('click', alHacerClic);
    lista.addEventListener('dblclick', renombrar);
  }

  function alHacerClic(e) {
    const fila = e.target.closest('.fila');
    if (!fila) return;
    const id = fila.dataset.id;
    if (e.target.closest('.plegar')) {
      const conjunto = plegadosDe();
      conjunto.has(id) ? conjunto.delete(id) : conjunto.add(id);
      return dibujar();
    }
    if (e.target.closest('.ojo')) {
      const visible = leer(esquema, buscar(estado.doc, id), 'visible');
      ejecutar([visible ? { op: 'set', target: id, props: { visible: false } } : { op: 'unset', target: id, props: ['visible'] }], `${visible ? 'ocultar' : 'mostrar'} ${id}`);
      return;
    }
    seleccionar(id);
  }

  // Renombrar con doble clic.
  function renombrar(e) {
    const nombre = e.target.closest('.nombre');
    if (!nombre) return;
    const anterior = nombre.closest('.fila').dataset.id;
    const input = document.createElement('input');
    input.value = anterior;
    nombre.replaceChildren(input);
    input.select();
    let terminado = false;
    const terminar = (guardar) => {
      if (terminado) return;
      terminado = true;
      const nuevo = input.value.trim();
      if (guardar && nuevo && nuevo !== anterior) {
        ejecutar([{ op: 'rename', target: anterior, id: nuevo }], `renombrar ${anterior} → ${nuevo}`);
        if (estado.seleccion === anterior) seleccionar(buscar(estado.doc, nuevo) ? nuevo : anterior);
      } else {
        nombre.textContent = anterior;
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') terminar(true);
      if (ev.key === 'Escape') terminar(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => terminar(true));
  }

  // ---------- Arrastrar para reordenar o reparentar ----------

  function zona(e, fila) {
    const r = fila.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const destino = buscar(estado.doc, fila.dataset.id);
    if (esquema.tipos.get(destino.type).container && y > 0.25 && y < 0.75) return 'dentro';
    return y < 0.5 ? 'antes' : 'despues';
  }

  function limpiarMarcas() {
    raiz.querySelectorAll('.soltar-antes, .soltar-despues, .soltar-dentro').forEach((f) => f.classList.remove('soltar-antes', 'soltar-despues', 'soltar-dentro'));
  }

  raiz.addEventListener('dragstart', (e) => {
    const fila = e.target.closest('.fila');
    arrastrado = fila?.dataset.id ?? null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', arrastrado ?? '');
  });

  raiz.addEventListener('dragover', (e) => {
    const fila = e.target.closest('.fila');
    if (!arrastrado || !fila || subarbol(estado.doc, arrastrado).includes(fila.dataset.id)) return;
    e.preventDefault();
    limpiarMarcas();
    fila.classList.add(`soltar-${zona(e, fila)}`);
  });

  raiz.addEventListener('dragleave', (e) => {
    if (!raiz.contains(e.relatedTarget)) limpiarMarcas();
  });

  raiz.addEventListener('drop', (e) => {
    e.preventDefault();
    limpiarMarcas();
    const fila = e.target.closest('.fila');
    const id = arrastrado;
    arrastrado = null;
    if (!fila || !id || subarbol(estado.doc, id).includes(fila.dataset.id)) return;
    const destino = buscar(estado.doc, fila.dataset.id);
    const donde = zona(e, fila);
    if (donde === 'dentro') {
      ejecutar([{ op: 'move', target: id, parent: destino.id }, ...mantenerPosicion(id, destino.id)], `mover ${id} dentro de ${destino.id}`);
      return;
    }
    // En el panel, "arriba" es "delante": antes de la fila = un lugar más al frente que el destino.
    const padre = destino.parent ?? null;
    const hermanos = hijos(estado.doc, padre).filter((o) => o.id !== id);
    const pos = hermanos.indexOf(destino);
    ejecutar([{ op: 'move', target: id, parent: padre, index: donde === 'antes' ? pos + 1 : pos }, ...mantenerPosicion(id, padre)], `reordenar ${id}`);
  });

  // Al cambiar de padre, recalcula x/y para que el objeto no salte de lugar en pantalla.
  function mantenerPosicion(id, padreNuevo) {
    const obj = buscar(estado.doc, id);
    if ((obj.parent ?? null) === padreNuevo) return [];
    const mundo = aplicar(matrizMundo(estado.doc, esquema, obj.parent ?? null), leer(esquema, obj, 'x'), leer(esquema, obj, 'y'));
    const [x, y] = aplicar(invertir(matrizMundo(estado.doc, esquema, padreNuevo)), ...mundo);
    return [{ op: 'set', target: id, props: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 } }];
  }

  raiz.addEventListener('dragend', () => {
    arrastrado = null;
    limpiarMarcas();
  });
}
