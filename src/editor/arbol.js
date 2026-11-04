// Árbol de objetos: muestra la jerarquía con lo que está al frente arriba (como en Moho o Figma).
// Como en Moho, aquí solo hay capas: los huesos de un skeleton no son filas, se ven y se eligen en el lienzo.
// Arrastrar una fila cambia el orden o el padre; doble clic renombra; el ojo muestra u oculta.
// Ctrl + clic agrega o quita de la selección; Shift + clic selecciona el tramo de filas desde la anterior.

import { ICONO_DE_TIPO, ICONOS } from './iconos.js';
import { buscar, hijos, subarbol } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { aplicarOperaciones } from '../core/operaciones.js';
import { alternarEnlace, avisarSueltos, elegirVariante, soltarAlMover, varianteDe, variantesAMostrar } from './huesos.js';
import { alternarSeleccion, ejecutar, esquema, estado, mantenerPosicion, seleccionRaices, seleccionar, seleccionarVarios, suscribir } from './estado.js';

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
    else raiz.innerHTML = '<li class="vacio">Empty. Draw with the tools or ask the AI.</li>';
    const recursos = doc.objects.filter(esRecurso).map((o) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="fila${claseSeleccion(o.id)}" data-id="${o.id}" style="padding-left:8px"><span class="tipo" title="${o.type}">${ICONO_DE_TIPO[o.type] ?? '•'}</span><span class="nombre"></span></div>`;
      li.querySelector('.nombre').textContent = o.id;
      return li;
    });
    if (recursos.length) raizRecursos.replaceChildren(...recursos);
    else raizRecursos.innerHTML = '<li class="vacio">No styles or gradients.</li>';
    raiz.querySelector('.principal')?.scrollIntoView({ block: 'nearest' });
  }

  const claseSeleccion = (id) => (id === estado.seleccion ? ' seleccionada principal' : estado.seleccionados.includes(id) ? ' seleccionada' : '');

  /** Filas de las capas hijas de `padre`, con lo del frente arriba. Los huesos no son capas: no salen. */
  const capas = (doc, padre) => hijos(doc, padre).filter((o) => !esRecurso(o) && o.type !== 'bone');

  function rama(doc, padre, nivel) {
    return capas(doc, padre)
      .reverse()
      .map((o) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'treeitem');
        const conOjo = 'visible' in esquema.tipos.get(o.type).properties;
        const visible = !conOjo || leer(esquema, o, 'visible');
        const fila = document.createElement('div');
        // En un switch, las variantes que no se ven quedan atenuadas (la seleccionada se muestra igual, para editarla).
        const padre = o.parent && buscar(doc, o.parent);
        const activa = padre?.type === 'switch' ? varianteDe(doc, padre) : null;
        const apagada = activa != null && o.id !== activa;
        const deVista = apagada && variantesAMostrar(doc)[padre.id] === o.id;
        fila.className = `fila${claseSeleccion(o.id)}${visible ? '' : ' oculta'}${apagada ? ' apagada' : ''}`;
        if (apagada) fila.title = deVista ? `Visible while selected; switch ${padre.id} shows ${activa}` : `Hidden: switch ${padre.id} shows ${activa}`;
        fila.dataset.id = o.id;
        fila.draggable = true;
        fila.style.paddingLeft = `${4 + nivel * 14}px`;
        const tieneHijos = capas(doc, o.id).length > 0;
        const plegado = plegadosDe().has(o.id);
        fila.innerHTML = `<button type="button" class="plegar${tieneHijos ? '' : ' vacio'}" title="${plegado ? 'Expand' : 'Collapse'}" tabindex="-1">${plegado ? '▸' : '▾'}</button>
          <span class="tipo" title="${o.type}">${ICONO_DE_TIPO[o.type] ?? '•'}</span><span class="nombre"></span>${o.bone ? `<span class="enlace">${ICONOS.hueso}</span>` : ''}
          ${o.type === 'switch' ? '<span class="desplegable variante-switch"><button type="button" class="variante" title="Variant shown (in a pose, saved to the pose)"></button><div class="menu" role="menu" hidden></div></span>' : ''}
          ${conOjo ? `<button type="button" class="ojo${visible ? '' : ' oculto'}" title="${visible ? 'Hide' : 'Show'}">${visible ? '◉' : '○'}</button>` : ''}`;
        fila.querySelector('.nombre').textContent = o.id;
        if (o.bone) fila.querySelector('.enlace').title = `Follows bone ${o.bone}`;
        if (o.type === 'switch') fila.querySelector('.variante').textContent = `▾ ${varianteDe(doc, o) ?? 'empty'}`;
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
    // Botón de variante de un switch: abre la lista de sus hijos (como el menú de un switch layer de Moho).
    const item = e.target.closest('[data-variante]');
    if (item) {
      item.closest('.menu').hidden = true;
      return elegirVariante(id, item.dataset.variante);
    }
    if (e.target.closest('.variante')) return abrirVariantes(fila, id);
    if (e.target.closest('.ojo')) {
      const visible = leer(esquema, buscar(estado.doc, id), 'visible');
      ejecutar([visible ? { op: 'set', target: id, props: { visible: false } } : { op: 'unset', target: id, props: ['visible'] }], `${visible ? 'hide' : 'show'} ${id}`);
      return;
    }
    // «Enlazar dibujo…»: la fila se pega al hueso (o se suelta) en vez de seleccionarse.
    if (estado.enlazando) return alternarEnlace(id, estado.enlazando);
    if (e.ctrlKey || e.metaKey) return alternarSeleccion(id);
    if (e.shiftKey && estado.seleccion) return seleccionarTramo(fila);
    seleccionar(id);
  }

  // Shift + clic: todas las filas visibles entre la del objeto principal y la clicada, en la misma lista.
  function seleccionarTramo(fila) {
    const lista = fila.closest('#arbol, #recursos') ?? raiz;
    const filas = [...lista.querySelectorAll('.fila')].map((f) => f.dataset.id);
    const a = filas.indexOf(estado.seleccion);
    const b = filas.indexOf(fila.dataset.id);
    if (a < 0) return seleccionar(fila.dataset.id);
    const tramo = filas.slice(Math.min(a, b), Math.max(a, b) + 1);
    seleccionarVarios([...estado.seleccionados, ...tramo], fila.dataset.id);
  }

  function abrirVariantes(fila, id) {
    const boton = fila.querySelector('.variante');
    const menu = fila.querySelector('.variante-switch .menu');
    const activa = varianteDe(estado.doc, buscar(estado.doc, id));
    const variantes = hijos(estado.doc, id);
    menu.replaceChildren(
      ...(variantes.length
        ? variantes.map((h) => {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: h.id === activa ? 'marcado' : '', textContent: h.id });
            b.setAttribute('role', 'menuitemradio');
            b.dataset.variante = h.id;
            return b;
          })
        : [Object.assign(document.createElement('span'), { className: 'ayuda', textContent: 'Empty: drag drawings into it.' })]),
    );
    // Fijo en la pantalla: la lista de la jerarquía tiene su propio desplazamiento y lo cortaría.
    const r = boton.getBoundingClientRect();
    Object.assign(menu.style, { position: 'fixed', top: `${r.bottom + 4}px`, left: `${r.left}px`, minWidth: '160px' });
    menu.hidden = !menu.hidden;
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
        ejecutar([{ op: 'rename', target: anterior, id: nuevo }], `rename ${anterior} → ${nuevo}`);
        if (estado.seleccion === anterior && buscar(estado.doc, nuevo)) seleccionarVarios(estado.seleccionados.map((s) => (s === anterior ? nuevo : s)), nuevo);
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

  // Lo que se arrastra: la selección entera si la fila es parte de ella, si no solo esa fila (los huesos elegidos en el
  // lienzo no se mueven por aquí: viven en su skeleton).
  const arrastrados = () => (estado.seleccionados.includes(arrastrado) ? seleccionRaices().filter((id) => buscar(estado.doc, id)?.type !== 'bone') : [arrastrado]);
  const contieneA = (ids, destino) => ids.some((id) => subarbol(estado.doc, id).includes(destino));

  raiz.addEventListener('dragstart', (e) => {
    const fila = e.target.closest('.fila');
    arrastrado = fila?.dataset.id ?? null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', arrastrado ?? '');
  });

  raiz.addEventListener('dragover', (e) => {
    const fila = e.target.closest('.fila');
    if (!arrastrado || !fila || contieneA(arrastrados(), fila.dataset.id)) return;
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
    if (!fila || !arrastrado) return (arrastrado = null);
    const ids = arrastrados();
    const donde = zona(e, fila);
    arrastrado = null;
    if (!ids.length || contieneA(ids, fila.dataset.id)) return;
    const destino = buscar(estado.doc, fila.dataset.id);
    const nombre = ids.length === 1 ? ids[0] : `${ids.length} objects`;
    // Se arma el lote paso a paso sobre una copia: cada índice depende de cómo quedó el anterior.
    let doc = estado.doc;
    const ops = [];
    const sueltos = [];
    const paso = (lote) => {
      doc = aplicarOperaciones(doc, lote, esquema).doc;
      ops.push(...lote);
    };
    // Un move suelta antes los enlaces que dejarían de valer (dibujo que sale del skeleton de su hueso).
    const mover = (id, padre, index) => {
      const soltar = soltarAlMover(doc, id, padre);
      sueltos.push(...soltar);
      paso([...soltar, { op: 'move', target: id, parent: padre, ...(index !== undefined ? { index } : {}) }, ...mantenerPosicion(doc, id, padre)]);
    };
    const terminar = (nota) => {
      if (!ops.length) return;
      ejecutar(ops, nota).then((ok) => ok && avisarSueltos(sueltos));
    };
    if (donde === 'dentro') {
      for (const id of ids) mover(id, destino.id);
      return terminar(`move ${nombre} into ${destino.id}`);
    }
    // En el panel, "arriba" es "delante": antes de la fila = un lugar más al frente que el destino.
    // Se insertan de a uno junto al destino, en el orden que conserva cómo estaban entre ellos.
    const padre = destino.parent ?? null;
    for (const id of donde === 'antes' ? [...ids].reverse() : ids) {
      const hermanos = hijos(doc, padre).filter((o) => o.id !== id);
      const pos = hermanos.findIndex((o) => o.id === destino.id);
      mover(id, padre, donde === 'antes' ? pos + 1 : pos);
    }
    terminar(`reorder ${nombre}`);
  });

  raiz.addEventListener('dragend', () => {
    arrastrado = null;
    limpiarMarcas();
  });
}
