// Panel de parámetros (abajo): un control por param (deslizador, casilla o lista) y sus drivers. Mover un control
// pasa a la vista Parámetros: el lienzo muestra la mezcla de poses que dan los drivers. Los valores de los controles
// son del editor (no se guardan); lo que se guarda son los params, los drivers y las poses.

import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { pesoDeDriver, valoresDeParams } from '../core/mezcla.js';
import { avisar, ejecutar, esquema, estado, fijar, idLibre, seleccionar, suscribir } from './estado.js';

export function montarParametros(raiz, botonNuevo) {
  suscribir((c) => {
    if ('doc' in c || 'seleccion' in c || 'id' in c) return dibujar();
    // Mientras se arrastra un control, no se rehace el panel (se cortaría el arrastre): solo se actualizan los pesos.
    if ('params' in c) raiz.contains(document.activeElement) ? actualizarPesos() : dibujar();
  });

  function actualizarPesos() {
    const doc = estado.doc;
    const valores = valoresDeParams(doc, esquema, estado.params ?? {});
    for (const chip of raiz.querySelectorAll('[data-driver]')) {
      const d = buscar(doc, chip.dataset.driver);
      const peso = d?.pose && buscar(doc, d.pose) ? pesoDeDriver(doc, esquema, d, valores[d.param]) : 0;
      chip.textContent = `→ ${d?.pose ?? '(sin pose)'} ${Math.round(peso * 100)}%`;
      chip.style.setProperty('--peso', `${Math.round(peso * 100)}%`);
    }
  }

  botonNuevo.addEventListener('click', () => {
    if (!estado.doc) return;
    const base = prompt('Nombre del parámetro (por ejemplo happiness, head_turn, mouth):', '')?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const id = /^[a-z]/.test(base) ? base : `param_${base}`;
    if (buscar(estado.doc, id)) return avisar(`Ya existe "${id}"`, true);
    ejecutar([{ op: 'create', type: 'param', id }], `crear param ${id}`);
    seleccionar(id);
  });

  function dibujar() {
    const doc = estado.doc;
    botonNuevo.disabled = !doc;
    if (!doc) return raiz.replaceChildren();
    const params = doc.objects.filter((o) => o.type === 'param');
    if (!params.length) {
      raiz.innerHTML = '<p class="ayuda">Sin parámetros. Un parámetro (feliz, giro de cabeza, boca…) mueve una o varias poses a través de drivers: créalo con «＋ Parámetro» y conéctalo a una pose.</p>';
      return;
    }
    const valores = valoresDeParams(doc, esquema, estado.params ?? {});
    raiz.replaceChildren(...params.map((p) => fila(doc, p, valores[p.id])));
  }

  /** Cambiar un control: pasa a la vista Parámetros con el valor nuevo. */
  const mover = (id, v) => fijar({ pose: null, params: { ...(estado.params ?? {}), [id]: v } });

  function fila(doc, param, valor) {
    const div = document.createElement('div');
    div.className = `param${param.id === estado.seleccion ? ' seleccionado' : ''}`;
    const nombre = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre', textContent: param.id, title: 'Elegir el param (en el inspector: tipo, rango, opciones)' });
    nombre.addEventListener('click', () => seleccionar(param.id));
    div.append(nombre, control(param, valor));

    // Drivers: a qué poses mueve y con qué peso ahora.
    const drivers = doc.objects.filter((o) => o.type === 'driver' && o.param === param.id);
    const lista = document.createElement('div');
    lista.className = 'drivers';
    for (const d of drivers) {
      const peso = d.pose && buscar(doc, d.pose) ? pesoDeDriver(doc, esquema, d, valor) : 0;
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: `driver${d.id === estado.seleccion ? ' seleccionado' : ''}` });
      chip.dataset.driver = d.id;
      chip.textContent = `→ ${d.pose ?? '(sin pose)'} ${Math.round(peso * 100)}%`;
      chip.title = `Driver ${d.id}: ${tramo(d)}. Clic para editarlo en el inspector.`;
      chip.style.setProperty('--peso', `${Math.round(peso * 100)}%`);
      chip.addEventListener('click', () => seleccionar(d.id));
      lista.append(chip);
    }
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const conectar = document.createElement('select');
    conectar.title = 'Conectar este param a una pose (crea un driver)';
    conectar.append(new Option(poses.length ? '＋ pose…' : '(no hay poses)', ''), ...poses.map((p) => new Option(p.id, p.id)));
    conectar.disabled = !poses.length;
    conectar.addEventListener('change', () => {
      if (!conectar.value) return;
      const id = idLibre(`${param.id}_to_${conectar.value}`.slice(0, 40));
      // Con un enum, la pose va con la opción que está elegida ahora.
      const props = { param: param.id, pose: conectar.value, ...(leer(esquema, param, 'kind') === 'enum' ? { equals: valor } : {}) };
      ejecutar([{ op: 'create', type: 'driver', id, props }], `conectar ${param.id} → ${conectar.value}`);
      seleccionar(id);
    });
    lista.append(conectar);
    div.append(lista);
    return div;
  }

  function control(param, valor) {
    const tipo = leer(esquema, param, 'kind');
    if (tipo === 'enum') {
      const select = document.createElement('select');
      for (const o of leer(esquema, param, 'options')) select.append(new Option(o, o, false, o === valor));
      if (!select.options.length) select.append(new Option('(sin opciones)', ''));
      select.addEventListener('change', () => mover(param.id, select.value));
      return select;
    }
    if (tipo === 'boolean') {
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: valor >= 0.5 });
      check.addEventListener('change', () => mover(param.id, check.checked ? 1 : 0));
      return check;
    }
    const caja = document.createElement('span');
    caja.className = 'deslizador';
    const [min, max] = [leer(esquema, param, 'min'), leer(esquema, param, 'max')];
    const rango = Object.assign(document.createElement('input'), { type: 'range', min, max, step: (max - min) / 100 || 0.01, value: valor });
    const numero = Object.assign(document.createElement('span'), { className: 'valor', textContent: +valor.toFixed(2) });
    rango.addEventListener('input', () => {
      numero.textContent = +Number(rango.value).toFixed(2);
      mover(param.id, Number(rango.value));
    });
    // Doble clic: vuelve al valor inicial.
    rango.addEventListener('dblclick', () => mover(param.id, leer(esquema, param, 'default')));
    caja.append(rango, numero);
    return caja;
  }

  function tramo(d) {
    if (d.equals != null) return `pose completa con "${d.equals}"`;
    const v = (k) => leer(esquema, d, k);
    return `${v('inMin')}…${v('inMax')} → peso ${v('outMin')}…${v('outMax')}`;
  }
}
