// Panel de parámetros (a la derecha, solo en Puppet: los params son del muñeco): un control por param (deslizador,
// casilla o lista) y las poses que mezcla con su peso. Mover un control
// pasa a la vista Parámetros: el lienzo muestra la mezcla de poses que dan los drivers. Los valores de los controles
// son del editor (no se guardan); lo que se guarda son los params, los drivers y las poses.

import { esEscena } from '../core/animacion.js';
import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { pesoDeDriver, valoresDeParams } from '../core/mezcla.js';
import { avisar, ejecutar, esquema, estado, fijar, idLibre, seleccionar, suscribir } from './estado.js';
import { clipAbierto, opsDePose, poseActiva } from './edicion.js';
import { ponerParamVivo } from './vivo.js';

export function montarParametros(raiz, botonNuevo, botonBorrar) {
  // 🗑 borra el param seleccionado (en Parameters o en Assets) con sus drivers: sin param, un driver no mueve nada.
  const elegido = () => (estado.doc && buscar(estado.doc, estado.seleccion)?.type === 'param' ? estado.seleccion : null);
  botonBorrar.addEventListener('click', () => {
    const id = elegido();
    if (!id) return;
    const drivers = estado.doc.objects.filter((o) => o.type === 'driver' && o.param === id).map((o) => ({ op: 'delete', target: o.id }));
    ejecutar([...drivers, { op: 'delete', target: id }], `delete param ${id}`);
    seleccionar(null);
  });
  suscribir((c) => {
    if ('doc' in c || 'seleccion' in c || 'vivo' in c) botonBorrar.disabled = !elegido() || estado.vivo;
  });
  // Un deslizador agarrado: hasta soltarlo, el panel no se rehace (solo pesos y valores), aunque cambie el documento
  // (el autokey de un clip abierto) o la vista.
  let arrastrando = false;
  window.addEventListener('pointerup', () => {
    if (!arrastrando) return;
    arrastrando = false;
    dibujar();
  });
  suscribir((c) => {
    if (arrastrando && ('doc' in c || 'params' in c || 'pose' in c || 'tiempo' in c)) return actualizarPesos();
    if ('doc' in c || 'seleccion' in c || 'id' in c || 'pose' in c || 'modo' in c || 'vivo' in c) return dibujar();
    if ('tiempo' in c && clipAbierto()) return raiz.contains(document.activeElement) ? actualizarPesos() : dibujar();
    // Mientras se arrastra un control, no se rehace el panel (se cortaría el arrastre): solo se actualizan los pesos.
    if ('params' in c) raiz.contains(document.activeElement) ? actualizarPesos() : dibujar();
  });

  function actualizarPesos() {
    const doc = estado.doc;
    const valores = valoresVistos(doc);
    for (const f of raiz.querySelectorAll('.param[data-param]')) pesos(doc, f, valores[f.dataset.param]);
  }

  botonNuevo.addEventListener('click', () => {
    if (!estado.doc) return;
    const base = prompt('Parameter name (e.g. happiness, head_turn, mouth):', '')?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const id = /^[a-z]/.test(base) ? base : `param_${base}`;
    if (buscar(estado.doc, id)) return avisar(`"${id}" already exists`, true);
    ejecutar([{ op: 'create', type: 'param', id }], `create param ${id}`);
    seleccionar(id);
  });

  function dibujar() {
    const doc = estado.doc;
    botonNuevo.disabled = !doc || estado.vivo;
    // Solo Puppet tiene params (en una escena no hay valores de params que mostrar).
    if (!doc || estado.modo !== 'puppet') return raiz.replaceChildren();
    const params = doc.objects.filter((o) => o.type === 'param');
    if (!params.length) {
      raiz.innerHTML = '<p class="ayuda">No parameters. A parameter (happiness, head turn, mouth…) drives one or more poses through drivers: create one with + above and connect it to a pose with its own +.</p>';
      return;
    }
    const valores = valoresVistos(doc);
    raiz.replaceChildren(...params.map((p) => fila(doc, p, valores[p.id])));
  }

  /**
   * Cambiar un control: pasa a la vista Parámetros con el valor nuevo. Con un clip abierto, en cambio, el valor queda
   * como keyframe del param en el tiempo del playhead (autokey).
   */
  const mover = (id, v) => {
    // Con Live encendido, el control es el valor de la app: va al runtime y no se guarda.
    if (estado.vivo) return ponerParamVivo(id, v);
    const clip = clipAbierto();
    // Solo se nombra `pose` si hay que cerrar una: si no, el cambio es solo de params y el panel no se rehace.
    if (!clip) return fijar({ ...(estado.pose ? { pose: null } : {}), params: { ...(estado.params ?? {}), [id]: v } });
    ejecutar(opsDePose(estado.doc, clip.id, id, { value: v }), `${clip.id}: ${id} at ${+estado.tiempo.toFixed(3)} s`, { agrupar: `clip:${clip.id}.${id}.${estado.tiempo}` });
  };
  /** Valores que muestran los controles: los del clip abierto en el playhead o los de la vista Parámetros. */
  const valoresVistos = (doc) => (clipAbierto(doc) && !esEscena(esquema, clipAbierto(doc)) ? poseActiva(doc).params : valoresDeParams(doc, esquema, estado.params ?? {}));

  /**
   * Una fila por param, en tres líneas: el nombre y el valor; el control a todo el ancho (deslizador o lista); y las
   * poses que mezcla con su peso ahora, con «＋» para conectar otra.
   */
  function fila(doc, param, valor) {
    const tipo = leer(esquema, param, 'kind');
    const div = document.createElement('div');
    div.className = `param${param.id === estado.seleccion ? ' seleccionado' : ''}`;
    div.dataset.param = param.id;
    const cabeza = document.createElement('div');
    cabeza.className = 'cabeza-param';
    const nombre = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre', textContent: param.id });
    const descripcion = leer(esquema, param, 'description');
    nombre.title = `${descripcion ? `${descripcion}\n` : ''}Select the parameter (kind, range, options and description in the inspector)`;
    nombre.addEventListener('click', () => seleccionar(param.id));
    cabeza.append(nombre);
    if (tipo === 'boolean') {
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: valor >= 0.5, title: 'On / off' });
      check.addEventListener('change', () => mover(param.id, check.checked ? 1 : 0));
      cabeza.append(check);
    } else if (tipo === 'number') cabeza.append(Object.assign(document.createElement('span'), { className: 'valor', textContent: +valor.toFixed(2) }));
    div.append(cabeza);
    if (tipo !== 'boolean') div.append(control(param, valor, tipo));

    // Las poses que mezcla (por sus drivers) y con qué peso ahora; «＋» conecta otra.
    const drivers = doc.objects.filter((o) => o.type === 'driver' && o.param === param.id);
    const lista = document.createElement('div');
    lista.className = 'drivers';
    for (const d of drivers) {
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: `driver${d.id === estado.seleccion ? ' seleccionado' : ''}` });
      chip.dataset.driver = d.id;
      chip.title = `Driver ${d.id}: ${tramo(d)}. Click to edit it in the inspector.`;
      chip.addEventListener('click', () => seleccionar(d.id));
      lista.append(chip);
    }
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const conectar = document.createElement('select');
    conectar.className = 'conectar';
    conectar.title = poses.length ? 'Blend one more pose with this parameter (creates a driver)' : 'There are no poses yet: create one under Poses';
    conectar.append(new Option('＋', ''), ...poses.map((p) => new Option(p.id, p.id)));
    conectar.disabled = !poses.length || estado.vivo;
    conectar.addEventListener('change', () => {
      if (!conectar.value) return;
      const id = idLibre(`${param.id}_to_${conectar.value}`.slice(0, 40));
      // Con un enum, la pose va con la opción que está elegida ahora.
      const props = { param: param.id, pose: conectar.value, ...(tipo === 'enum' ? { equals: valor } : {}) };
      ejecutar([{ op: 'create', type: 'driver', id, props }], `connect ${param.id} → ${conectar.value}`);
      seleccionar(id);
    });
    if (!drivers.length) lista.append(Object.assign(document.createElement('span'), { className: 'sin-poses', textContent: 'blends no pose yet' }));
    lista.append(conectar);
    div.append(lista);
    pesos(doc, div, valor);
    return div;
  }

  /** El texto y la barra de peso de cada pose de una fila, y el número del valor. */
  function pesos(doc, fila, valor) {
    for (const chip of fila.querySelectorAll('[data-driver]')) {
      const d = buscar(doc, chip.dataset.driver);
      const peso = d?.pose && buscar(doc, d.pose) ? pesoDeDriver(doc, esquema, d, valor) : 0;
      chip.textContent = `${d?.pose ?? '(no pose)'}${d?.equals != null ? ` = ${d.equals}` : ''} ${Math.round(peso * 100)}%`;
      chip.style.setProperty('--peso', `${Math.round(peso * 100)}%`);
      chip.classList.toggle('activo', peso > 0);
    }
    const numero = fila.querySelector('.valor');
    if (numero && typeof valor === 'number') numero.textContent = +valor.toFixed(2);
  }

  function control(param, valor, tipo) {
    if (tipo === 'enum') {
      const select = document.createElement('select');
      select.className = 'opciones-param';
      for (const o of leer(esquema, param, 'options')) select.append(new Option(o, o, false, o === valor));
      if (!select.options.length) select.append(new Option('(no options)', ''));
      select.addEventListener('change', () => mover(param.id, select.value));
      return select;
    }
    const [min, max] = [leer(esquema, param, 'min'), leer(esquema, param, 'max')];
    const rango = Object.assign(document.createElement('input'), { type: 'range', className: 'deslizador', min, max, step: (max - min) / 100 || 0.01, value: valor });
    rango.title = `${min} … ${max} (double-click: back to ${leer(esquema, param, 'default')})`;
    // Mientras se arrastra, el panel no se rehace (se cortaría el arrastre): solo se actualizan los pesos.
    rango.addEventListener('pointerdown', () => (arrastrando = true));
    rango.addEventListener('input', () => mover(param.id, Number(rango.value)));
    // Doble clic: vuelve al valor inicial.
    rango.addEventListener('dblclick', () => mover(param.id, leer(esquema, param, 'default')));
    return rango;
  }

  function tramo(d) {
    if (d.equals != null) return `full pose when "${d.equals}"`;
    const v = (k) => leer(esquema, d, k);
    return `${v('inMin')}…${v('inMax')} → weight ${v('outMin')}…${v('outMax')}`;
  }
}
