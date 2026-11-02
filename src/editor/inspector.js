// Inspector generado desde el esquema: cada propiedad del tipo seleccionado (o del documento, si no hay selección)
// tiene su campo según su tipo. Un tipo nuevo en schema/ aparece aquí sin tocar este archivo.

import { buscar } from '../core/documento.js';
import { validarValor } from '../core/esquema.js';
import { ejecutar, esquema, estado, previsualizar, seleccionar, suscribir } from './estado.js';

const ORDEN_DE_GRUPOS = ['General', 'Forma', 'Transformación', 'Apariencia', 'Lienzo', 'Tiempo'];

export function montarInspector(raiz) {
  suscribir((c) => {
    if ('doc' in c || 'seleccion' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    if (!doc) return raiz.replaceChildren();
    const enFoco = raiz.contains(document.activeElement) ? document.activeElement.closest('[data-prop]')?.dataset.prop : null;

    const obj = estado.seleccion ? buscar(doc, estado.seleccion) : null;
    const tipo = obj ? esquema.tipos.get(obj.type) : esquema.meta;
    const objetivo = obj ? obj.id : 'meta';
    const datos = obj ?? doc.meta;

    raiz.replaceChildren(obj ? titulo(obj, tipo) : Object.assign(document.createElement('h2'), { textContent: 'Documento' }));

    const grupos = Map.groupBy(Object.entries(tipo.properties), ([, p]) => p.group ?? 'Otros');
    const nombres = [...grupos.keys()].sort((a, b) => (ORDEN_DE_GRUPOS.indexOf(a) + 1 || 99) - (ORDEN_DE_GRUPOS.indexOf(b) + 1 || 99));
    for (const nombre of nombres) {
      raiz.append(Object.assign(document.createElement('h3'), { textContent: nombre }));
      for (const [prop, p] of grupos.get(nombre)) raiz.append(campo(objetivo, datos, prop, p));
    }

    if (enFoco) raiz.querySelector(`[data-prop="${enFoco}"] input, [data-prop="${enFoco}"] select`)?.focus();
  }

  function titulo(obj, tipo) {
    const div = document.createElement('div');
    div.className = 'campo';
    div.dataset.prop = '__id';
    div.innerHTML = `<label title="${tipo.description.replace(/"/g, '&quot;')}">${tipo.name}</label><input type="text" aria-label="Id"><span></span>`;
    const input = div.querySelector('input');
    input.value = obj.id;
    input.addEventListener('change', async () => {
      const nuevo = input.value.trim();
      if (!nuevo || nuevo === obj.id) return (input.value = obj.id);
      const anterior = obj.id;
      await ejecutar([{ op: 'rename', target: anterior, id: nuevo }], `renombrar ${anterior} → ${nuevo}`);
      if (buscar(estado.doc, nuevo)) seleccionar(nuevo);
    });
    return div;
  }

  function campo(objetivo, datos, prop, p) {
    const guardado = datos[prop];
    const valor = guardado !== undefined ? guardado : p.default;
    const div = document.createElement('div');
    div.className = `campo${guardado === undefined ? ' por-defecto' : ''}`;
    div.dataset.prop = prop;
    const label = document.createElement('label');
    label.textContent = prop;
    label.title = `${p.description ?? ''}${p.default !== undefined ? `\nPor defecto: ${JSON.stringify(p.default)}` : ''}`;
    const restablecer = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '↺', title: 'Volver al valor por defecto' });
    restablecer.addEventListener('click', () => ejecutar([{ op: 'unset', target: objetivo, props: [prop] }], `${objetivo}.${prop} por defecto`));

    const cambio = (v) => [{ op: 'set', target: objetivo, props: { [prop]: v } }];
    // Varios cambios seguidos de la misma propiedad (flechitas del campo, escribir y corregir) son un solo paso.
    const confirmar = (v) => {
      if (Object.is(v, valor)) return previsualizar(null);
      ejecutar(cambio(v), `${objetivo}.${prop}`, { agrupar: `${objetivo}.${prop}` });
    };
    const control = CONTROLES[p.type]({ p, valor, previsualizar: (v) => previsualizar(cambio(v)), confirmar, div, label, objetivo });
    div.append(label, control, restablecer);
    return div;
  }
}

const CONTROLES = {
  number({ p, valor, previsualizar: ver, confirmar, div, label }) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = p.step ?? 1;
    if (p.min != null) input.min = p.min;
    if (p.max != null) input.max = p.max;
    input.value = valor;
    const leerInput = () => {
      const v = input.value === '' ? NaN : Number(input.value);
      const error = validarValor(p, v);
      div.classList.toggle('invalido', !!error);
      input.title = error ?? '';
      return error ? null : v;
    };
    input.addEventListener('input', () => {
      const v = leerInput();
      if (v != null) ver(v);
    });
    input.addEventListener('change', () => {
      const v = leerInput();
      if (v == null) {
        input.value = valor;
        div.classList.remove('invalido');
        return previsualizar(null);
      }
      confirmar(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = valor;
        previsualizar(null);
        input.blur();
      }
    });

    // Arrastrar sobre el nombre cambia el valor: Shift = fino, Alt = grueso.
    label.classList.add('arrastrable');
    label.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const paso = p.step ?? 1;
      let actual = valor;
      const mover = (ev) => {
        const factor = ev.shiftKey ? 0.1 : ev.altKey ? 10 : 1;
        let v = valor + Math.round((ev.clientX - x0) * factor) * paso;
        if (p.min != null) v = Math.max(p.min, v);
        if (p.max != null) v = Math.min(p.max, v);
        if (p.integer) v = Math.round(v);
        actual = +v.toFixed(4);
        input.value = actual;
        ver(actual);
      };
      const soltar = () => {
        label.removeEventListener('pointermove', mover);
        label.removeEventListener('pointerup', soltar);
        confirmar(actual);
      };
      label.addEventListener('pointermove', mover);
      label.addEventListener('pointerup', soltar);
    });
    return input;
  },

  color({ p, valor, previsualizar: ver, confirmar }) {
    const caja = document.createElement('div');
    caja.className = 'color';
    const selector = Object.assign(document.createElement('input'), { type: 'color' });
    const texto = Object.assign(document.createElement('input'), { type: 'text', spellcheck: false });
    const aSeisDigitos = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((d) => d + d).join('') : c.slice(0, 7));
    selector.value = valor ? aSeisDigitos(valor) : '#000000';
    selector.disabled = valor == null;
    texto.value = valor ?? '';
    texto.placeholder = 'ninguno';
    selector.addEventListener('input', () => ver(selector.value));
    selector.addEventListener('change', () => confirmar(selector.value));
    texto.addEventListener('change', () => {
      const v = texto.value.trim() === '' && p.nullable ? null : texto.value.trim();
      if (validarValor(p, v)) {
        texto.value = valor ?? '';
        return;
      }
      confirmar(v);
    });
    caja.append(selector, texto);
    if (p.nullable) {
      const ninguno = document.createElement('label');
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: valor == null, title: 'Sin color' });
      check.addEventListener('change', () => confirmar(check.checked ? null : (p.default ?? '#888888')));
      ninguno.append(check, ' no');
      caja.append(ninguno);
    }
    return caja;
  },

  boolean({ valor, confirmar }) {
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: valor });
    check.addEventListener('change', () => confirmar(check.checked));
    const envoltura = document.createElement('div');
    envoltura.append(check);
    return envoltura;
  },

  string({ valor, confirmar }) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: valor ?? '' });
    input.addEventListener('change', () => confirmar(input.value));
    return input;
  },

  enum({ p, valor, confirmar }) {
    const select = document.createElement('select');
    for (const v of p.values) select.append(new Option(v, v, false, v === valor));
    select.addEventListener('change', () => confirmar(select.value));
    return select;
  },

  ref({ p, valor, confirmar, objetivo }) {
    const select = document.createElement('select');
    if (p.nullable) select.append(new Option('(ninguno)', ''));
    for (const o of estado.doc.objects) {
      if (o.id !== objetivo && (!p.refTypes || p.refTypes.includes(o.type))) select.append(new Option(o.id, o.id, false, o.id === valor));
    }
    select.addEventListener('change', () => confirmar(select.value || null));
    return select;
  },
};
