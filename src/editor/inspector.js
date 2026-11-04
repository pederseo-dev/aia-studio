// Inspector generado desde el esquema: cada propiedad del tipo seleccionado (o del documento, si no hay selección)
// tiene su campo según su tipo. Un tipo nuevo en schema/ aparece aquí sin tocar este archivo.
// Con varios objetos seleccionados muestra las propiedades que tienen todos; lo que se cambia se aplica a todos, y los
// campos donde los valores difieren se marcan como mixtos (muestran el valor del objeto principal).

import { buscar } from '../core/documento.js';
import { validarValor } from '../core/esquema.js';
import { valoresDeHueso } from '../core/esqueleto.js';
import { origenDelValor, valorEfectivo } from '../core/estilos.js';
import { opsDePose, poseActiva } from './huesos.js';
import { ejecutar, esquema, estado, fijar, previsualizar, seleccionar, suscribir } from './estado.js';

const ORDEN_DE_GRUPOS = ['General', 'Forma', 'Transformación', 'Apariencia', 'Degradado', 'Lienzo', 'Tiempo'];
// Nombres de grupo del esquema, como se muestran (el esquema sigue en español).
const NOMBRES_DE_GRUPO = { General: 'General', Forma: 'Shape', Transformación: 'Transform', Apariencia: 'Appearance', Degradado: 'Gradient', Lienzo: 'Canvas', Tiempo: 'Time', Driver: 'Driver', Esqueleto: 'Skeleton', Hueso: 'Bone', Límites: 'Limits', Parámetro: 'Parameter', Pose: 'Pose', Switch: 'Switch', Tramo: 'Range', Otros: 'Other' };
const PARES = { x: 'y', scaleX: 'scaleY', width: 'height', originX: 'originY', x1: 'y1', x2: 'y2', cx: 'cy' };
const ETIQUETAS = { x: 'X', y: 'Y', scaleX: 'SX', scaleY: 'SY', width: 'W', height: 'H', originX: 'PX', originY: 'PY', x1: 'X1', y1: 'Y1', x2: 'X2', y2: 'Y2', cx: 'CX', cy: 'CY' };

export function montarInspector(raiz) {
  suscribir((c) => {
    if ('doc' in c || 'seleccion' in c || 'edicion' in c || 'pose' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    if (!doc) return raiz.replaceChildren();
    const enFoco = raiz.contains(document.activeElement) ? document.activeElement.closest('[data-prop]')?.dataset.prop : null;

    const obj = estado.seleccion ? buscar(doc, estado.seleccion) : null;
    const tipo = obj ? esquema.tipos.get(obj.type) : esquema.meta;
    const objetivo = obj ? obj.id : 'meta';
    const datos = obj ?? doc.meta;
    const otros = obj ? estado.seleccionados.map((id) => buscar(doc, id)).filter((o) => o && o.id !== obj.id) : [];
    // Con varios: solo lo que tienen todos (y que se puede editar en bloque).
    const comun = ([prop, p]) => !otros.length || (!['vertices', 'stops'].includes(p.type) && otros.every((o) => esquema.tipos.get(o.type).properties[prop]?.type === p.type));
    const propiedades = Object.entries(tipo.properties).filter(comun);
    contexto = { otros };

    raiz.replaceChildren(otros.length ? tituloVarios(obj, otros) : obj ? titulo(obj, tipo) : Object.assign(document.createElement('h2'), { textContent: 'Document' }));
    if (otros.length && !propiedades.length) raiz.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: 'No properties in common.' }));
    const pose = poseActiva();
    if (pose && obj && !otros.length && !tipo.resource) seccionDePose(obj, tipo, pose);

    const grupos = Map.groupBy(propiedades, ([, p]) => p.group ?? 'Otros');
    const nombres = [...grupos.keys()].sort((a, b) => (ORDEN_DE_GRUPOS.indexOf(a) + 1 || 99) - (ORDEN_DE_GRUPOS.indexOf(b) + 1 || 99));
    for (const nombre of nombres) {
      raiz.append(Object.assign(document.createElement('h3'), { textContent: NOMBRES_DE_GRUPO[nombre] ?? nombre }));
      const props = grupos.get(nombre);
      const enPar = new Set();
      for (const [prop, p] of props) {
        if (enPar.has(prop)) continue;
        // Pares (x/y, ancho/alto, escala) en una sola fila, como en Rive.
        const pareja = PARES[prop] && props.find(([q]) => q === PARES[prop]);
        if (pareja) {
          enPar.add(pareja[0]);
          const fila = document.createElement('div');
          fila.className = 'par';
          fila.append(campo(objetivo, datos, prop, p, ETIQUETAS[prop]), campo(objetivo, datos, pareja[0], pareja[1], ETIQUETAS[pareja[0]]));
          raiz.append(fila);
        } else {
          raiz.append(campo(objetivo, datos, prop, p));
        }
      }
    }

    if (enFoco) raiz.querySelector(`[data-prop="${enFoco}"] input, [data-prop="${enFoco}"] select`)?.focus();
  }

  /**
   * Con una pose activa, lo animable del objeto en esa pose: lo que la pose fija se ve normal y lo demás (que sigue
   * como en el montaje), atenuado. Cambiar un campo lo agrega a la pose; ↺ lo quita.
   */
  function seccionDePose(obj, tipo, pose) {
    const animables = Object.entries(tipo.properties).filter(([, p]) => p.animatable);
    if (!animables.length) return;
    raiz.append(Object.assign(document.createElement('h3'), { className: 'en-pose', textContent: `Pose “${pose.id}”` }));
    const fijados = pose.values?.[obj.id] ?? {};
    const deHueso = obj.type === 'bone' ? valoresDeHueso(esquema, obj, pose) : null;
    const valor = (k) => (deHueso ? deHueso[k] : (fijados[k] ?? valorEfectivo(esquema, estado.doc, obj, k)));
    const enPar = new Set();
    for (const [k, p] of animables) {
      if (enPar.has(k)) continue;
      const pareja = PARES[k] && animables.find(([q]) => q === PARES[k]);
      if (pareja) {
        enPar.add(pareja[0]);
        const fila = document.createElement('div');
        fila.className = 'par';
        fila.append(campoDePose(obj, pose, k, p, valor(k), k in fijados), campoDePose(obj, pose, pareja[0], pareja[1], valor(pareja[0]), pareja[0] in fijados));
        raiz.append(fila);
      } else {
        raiz.append(campoDePose(obj, pose, k, p, valor(k), k in fijados));
      }
    }
    raiz.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: 'Below is the setup (the rest pose).' }));
  }

  function campoDePose(obj, pose, k, p, valor, fijado) {
    const div = document.createElement('div');
    div.className = `campo${fijado ? '' : ' por-defecto'}`;
    div.dataset.prop = `pose.${k}`;
    const label = Object.assign(document.createElement('label'), { textContent: ETIQUETAS[k] ?? k });
    label.title = `${k} in the pose${fijado ? '' : ' (not set by the pose: uses the setup value)'}`;
    const cambio = (v) => opsDePose(estado.doc, pose.id, obj.id, { [k]: v });
    const confirmar = (v) => {
      if (Object.is(v, valor) && fijado) return previsualizar(null);
      ejecutar(cambio(v), `pose ${pose.id}: ${obj.id}.${k}`, { agrupar: `pose:${pose.id}.${obj.id}.${k}` });
    };
    const control = CONTROLES[p.type]({ p, valor, previsualizar: (v) => previsualizar(cambio(v)), confirmar, div, label, objetivo: obj.id });
    const restablecer = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '↺', title: 'Remove from pose (back to setup)' });
    restablecer.addEventListener('click', () => ejecutar(opsDePose(estado.doc, pose.id, obj.id, { [k]: undefined }), `pose ${pose.id}: ${obj.id}.${k} from setup`));
    div.append(label, control, restablecer);
    return div;
  }

  // Lo que el campo necesita saber de una selección múltiple (se arma en cada dibujo).
  let contexto = { otros: [] };

  function tituloVarios(obj, otros) {
    const div = document.createElement('div');
    div.className = 'titulo-varios';
    const nombres = [obj, ...otros].map((o) => o.id);
    div.innerHTML = `<h2>${nombres.length} objects</h2><p class="ayuda"></p>`;
    div.querySelector('p').textContent = nombres.join(', ');
    div.title = `Primary: ${obj.id}. Changes apply to all.`;
    return div;
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
      await ejecutar([{ op: 'rename', target: anterior, id: nuevo }], `rename ${anterior} → ${nuevo}`);
      if (buscar(estado.doc, nuevo)) seleccionar(nuevo);
    });
    return div;
  }

  function campo(objetivo, datos, prop, p, etiqueta) {
    const esObjeto = objetivo !== 'meta';
    const origen = esObjeto ? origenDelValor(estado.doc, datos, prop) : datos[prop] !== undefined ? 'propio' : 'defecto';
    const valor = esObjeto ? valorEfectivo(esquema, estado.doc, datos, prop) : (datos[prop] ?? p.default);
    const { otros } = contexto;
    const objetivos = [objetivo, ...otros.map((o) => o.id)];
    const mixto = otros.some((o) => JSON.stringify(valorEfectivo(esquema, estado.doc, o, prop)) !== JSON.stringify(valor));
    const div = document.createElement('div');
    div.className = `campo${origen === 'defecto' ? ' por-defecto' : origen === 'estilo' ? ' por-defecto por-estilo' : ''}${mixto ? ' mixto' : ''}`;
    div.dataset.prop = prop;
    const label = document.createElement('label');
    label.textContent = etiqueta ?? prop;
    const deDonde = origen === 'estilo' ? `\nFrom style "${datos.style}".` : '';
    label.title = `${prop}: ${p.description ?? ''}${p.default !== undefined ? `\nDefault: ${JSON.stringify(p.default)}` : ''}${deDonde}${mixto ? `\nMixed values: showing ${objetivo}.` : ''}`;
    const restablecer = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '↺', title: 'Reset to default' });
    const nombre = otros.length ? `${objetivos.length} objects` : objetivo;
    restablecer.addEventListener('click', () => ejecutar(objetivos.map((t) => ({ op: 'unset', target: t, props: [prop] })), `${nombre}.${prop} reset`));

    const cambio = (v) => objetivos.map((t) => ({ op: 'set', target: t, props: { [prop]: v } }));
    // Varios cambios seguidos de la misma propiedad (flechitas del campo, escribir y corregir) son un solo paso.
    const confirmar = (v) => {
      if (Object.is(v, valor) && !mixto) return previsualizar(null);
      ejecutar(cambio(v), `${nombre}.${prop}`, { agrupar: `${objetivos.join()}.${prop}` });
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
    texto.placeholder = 'none';
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
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: valor == null, title: 'No color' });
      check.addEventListener('change', () => confirmar(check.checked ? null : (p.default ?? '#888888')));
      ninguno.append(check, ' none');
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

  string({ p, valor, confirmar }) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: valor ?? '', placeholder: p.nullable ? 'none' : '' });
    // Vacío en una propiedad que admite null = null (por ejemplo, la opción inicial de un param enum).
    input.addEventListener('change', () => confirmar(input.value === '' && p.nullable ? null : input.value));
    return input;
  },

  // Lista de textos (las opciones de un param enum): se escribe separada por comas.
  strings({ valor, confirmar }) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: valor.join(', '), placeholder: 'rest, a, e, o, m' });
    input.title = 'Comma-separated';
    input.addEventListener('change', () => confirmar(input.value.split(',').map((t) => t.trim()).filter(Boolean)));
    return input;
  },

  enum({ p, valor, confirmar }) {
    const select = document.createElement('select');
    for (const v of p.values) select.append(new Option(v, v, false, v === valor));
    select.addEventListener('change', () => confirmar(select.value));
    return select;
  },

  // Los vértices se editan en el lienzo; aquí solo se resume y se entra a editarlos.
  vertices({ valor, objetivo }) {
    const caja = document.createElement('div');
    caja.className = 'color';
    const boton = Object.assign(document.createElement('button'), { type: 'button', textContent: estado.edicion === objetivo ? 'Done' : 'Edit points' });
    boton.title = 'Or double-click the path, or press Enter';
    boton.addEventListener('click', () => fijar(estado.edicion === objetivo ? { edicion: null, vertice: null } : { edicion: objetivo, seleccion: objetivo, seleccionados: [objetivo], vertice: null, herramienta: 'seleccionar' }));
    const resumen = document.createElement('span');
    const curvos = valor.filter((v) => (v.mode ?? 'straight') !== 'straight').length;
    resumen.textContent = `${valor.length} points${curvos ? `, ${curvos} curved` : ''}`;
    caja.append(resumen, boton);
    return caja;
  },

  // Una pose se edita en el lienzo: aquí se resume y se activa.
  pose({ valor, objetivo }) {
    const caja = document.createElement('div');
    caja.className = 'resumen-pose';
    const lista = document.createElement('ul');
    for (const [hueso, campos] of Object.entries(valor)) {
      const li = document.createElement('li');
      li.textContent = `${hueso}: ${Object.entries(campos).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      lista.append(li);
    }
    if (!lista.children.length) lista.innerHTML = '<li>Doesn’t move any bones yet.</li>';
    const activa = estado.pose === objetivo;
    const boton = Object.assign(document.createElement('button'), { type: 'button', textContent: activa ? 'Back to setup' : 'View and edit on canvas' });
    boton.addEventListener('click', () => fijar({ pose: activa ? null : objetivo }));
    caja.append(lista, boton);
    return caja;
  },

  // Paradas de un degradado: color, offset y quitar; más un botón para agregar.
  stops({ valor, confirmar }) {
    const lista = document.createElement('div');
    lista.className = 'lista-paradas';
    const cambiar = (i, cambios) => confirmar(valor.map((s, j) => (j === i ? { ...s, ...cambios } : s)).sort((a, b) => a.offset - b.offset));
    valor.forEach((s, i) => {
      const fila = document.createElement('div');
      fila.className = 'parada';
      const color = Object.assign(document.createElement('input'), { type: 'color', value: s.color.length === 4 ? '#' + [...s.color.slice(1)].map((d) => d + d).join('') : s.color.slice(0, 7) });
      color.addEventListener('change', () => cambiar(i, { color: color.value }));
      const offset = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.05, value: s.offset, title: 'Position, 0 to 1' });
      offset.addEventListener('change', () => cambiar(i, { offset: Math.min(1, Math.max(0, Number(offset.value) || 0)) }));
      const opacidad = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.1, value: s.opacity ?? 1, title: 'Opacity' });
      opacidad.addEventListener('change', () => cambiar(i, { opacity: Math.min(1, Math.max(0, Number(opacidad.value))) }));
      const quitar = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '×', title: 'Remove stop' });
      quitar.style.visibility = valor.length > 1 ? 'visible' : 'hidden';
      quitar.addEventListener('click', () => confirmar(valor.filter((_, j) => j !== i)));
      fila.append(color, offset, opacidad, quitar);
      lista.append(fila);
    });
    const agregar = Object.assign(document.createElement('button'), { type: 'button', textContent: '+ Stop' });
    agregar.addEventListener('click', () => confirmar([...valor, { offset: 1, color: valor.at(-1)?.color ?? '#ffffff' }].sort((a, b) => a.offset - b.offset)));
    lista.append(agregar);
    return lista;
  },

  ref({ p, valor, confirmar, objetivo }) {
    const select = document.createElement('select');
    if (p.nullable) select.append(new Option('(none)', ''));
    for (const o of estado.doc.objects) {
      // refScope "children": solo los hijos (el hijo activo de un switch).
      const enAlcance = p.refScope === 'children' ? o.parent === objetivo : o.id !== objetivo;
      if (enAlcance && (!p.refTypes || p.refTypes.includes(o.type))) select.append(new Option(o.id, o.id, false, o.id === valor));
    }
    select.addEventListener('change', () => confirmar(select.value || null));
    return select;
  },
};
