// Barra de opciones sobre el lienzo (como la de Moho): dice qué se puede hacer con la herramienta y lo seleccionado,
// y ofrece como botones las acciones que tienen atajo. Así no hace falta saberse los atajos para descubrir qué sigue.

import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { huesoDe, repartirEntreHuesos } from '../core/esqueleto.js';
import { avisar, ejecutar, esquema, estado, fijar, seleccionar, seleccionarVarios, suscribir } from './estado.js';
import { elegirVariante, opsDePose, varianteDe, variantesAMostrar } from './huesos.js';

/**
 * `acciones`: lo que vive en main.js y la barra también ofrece (agrupar, enlazar la selección, borrar...).
 */
export function montarOpciones(raiz, acciones) {
  suscribir((c) => {
    if (['doc', 'seleccion', 'herramienta', 'pose', 'params', 'edicion', 'vertice', 'enlazando', 'id'].some((k) => k in c)) dibujar();
  });

  const boton = (texto, titulo, alHacerClic, clase = '') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: texto, title: titulo, className: clase });
    b.addEventListener('click', alHacerClic);
    return b;
  };
  const texto = (html) => Object.assign(document.createElement('span'), { className: 'texto', innerHTML: html });
  const codigo = (id) => `<b>${id}</b>`;

  function dibujar() {
    const doc = estado.doc;
    raiz.hidden = !doc;
    if (!doc) return;
    raiz.replaceChildren(...contenido(doc));
    raiz.classList.toggle('en-pose', !!estado.pose);
    raiz.classList.toggle('enlazando', !!estado.enlazando);
  }

  function contenido(doc) {
    const sel = estado.seleccion && buscar(doc, estado.seleccion);
    const varios = estado.seleccionados.length > 1;
    const huesos = doc.objects.filter((o) => o.type === 'bone');

    // Enlazar con clic: el modo más específico, va primero.
    if (estado.enlazando) {
      const n = doc.objects.filter((o) => o.bone === estado.enlazando).length;
      return [
        texto(`Click a drawing (or its Hierarchy row) to bind it to ${codigo(estado.enlazando)}; click again to unbind. Alt + click picks its parent group. ${n} bound.`),
        boton('Done', 'Finish binding (Esc)', () => fijar({ enlazando: null }), 'principal'),
      ];
    }

    if (estado.pose) {
      const pose = buscar(doc, estado.pose);
      const partes = [
        texto(
          estado.edicion
            ? `Pose ${codigo(estado.pose)}: points you move are stored in the pose (with the same point count, params interpolate it). Setup is unchanged.`
            : `Pose ${codigo(estado.pose)}: drag a bone or its bound drawing to rotate it. Everything else (mouth, colors, switch...) is set in the inspector, which shows the pose values at the top; <kbd>Enter</kbd> edits a path's points in the pose.`,
        ),
      ];
      if (sel && pose?.values?.[sel.id]) {
        partes.push(boton(`Remove ${sel.id} from pose`, 'Revert to its Setup state, in this pose only', () => ejecutar(opsDePose(doc, pose.id, sel.id, Object.fromEntries(Object.keys(pose.values[sel.id]).map((k) => [k, undefined]))), `pose ${pose.id}: ${sel.id} back to setup`)));
      }
      if (estado.edicion) partes.push(boton('Finish points', 'Exit point editing (Enter)', () => fijar({ edicion: null, vertice: null })));
      partes.push(boton('Back to Setup', 'Edit the drawing and the skeleton at rest', () => fijar({ pose: null, edicion: null, vertice: null }), 'principal'));
      return partes;
    }

    if (estado.params) {
      return [
        texto('Parameters: the character shows the pose blend set by the controls below. Nothing is edited here; to change a pose, pick it under “View”.'),
        boton('Back to Setup', 'Stop previewing the blend', () => fijar({ params: null }), 'principal'),
      ];
    }

    if (estado.edicion) {
      const partes = [texto('Points: drag anchors and tangents (Alt breaks them), double-click an anchor = straight or curved, click the outline to add, <kbd>Del</kbd> deletes.')];
      if (huesos.length) partes.push(...huesosDePuntos(doc, huesos));
      partes.push(boton('Done', 'Exit point editing (Enter)', () => fijar({ edicion: null, vertice: null }), 'principal'));
      return partes;
    }

    if (sel?.type === 'bone' && !varios) return opcionesDeHueso(doc, sel);

    switch (estado.herramienta) {
      case 'hueso':
        return [texto(huesos.length ? 'Bone: drag on empty space to create a loose bone, or pick a bone and drag from its tip to chain one. Drag a bone to rotate it.' : 'Bone: drag on the canvas to create the first one (from the joint toward the tip).')];
      case 'path':
        return [texto('Pen: click = straight point, click and drag = curved, click the first point = close, <kbd>Enter</kbd> = finish open.')];
      case 'rect':
      case 'ellipse':
        return [texto(`Drag to draw ${estado.herramienta === 'rect' ? 'a rectangle' : 'an ellipse'}; <kbd>Shift</kbd> = ${estado.herramienta === 'rect' ? 'square' : 'circle'}.`)];
      case 'rotar':
      case 'escalar':
        return [texto(`${estado.herramienta === 'rotar' ? 'Rotate' : 'Scale'}: drag anywhere; the selection ${estado.herramienta === 'rotar' ? 'rotates' : 'scales'} around its pivot.`)];
    }

    if (varios) {
      const ids = estado.seleccionados;
      const partes = [
        texto(`${ids.length} objects: drag to move them; the handles rotate and scale them together.`),
        boton('Group', 'Put them in a new group (Ctrl+G)', acciones.agrupar),
        boton('Switch', 'Put them in a switch: each one is a variant, shown one at a time (Shift+G)', acciones.switch),
      ];
      const hueso = ids.map((id) => buscar(doc, id)).filter((o) => o?.type === 'bone');
      if (hueso.length === 1) partes.push(boton(`Bind to ${hueso[0].id}`, 'Bind the selected drawing to this bone (Ctrl+B)', acciones.enlazar));
      return partes;
    }

    if (sel?.type === 'switch') return opcionesDeSwitch(doc, sel);

    if (sel && !esquema.tipos.get(sel.type).resource) {
      const padre = sel.parent && buscar(doc, sel.parent);
      if (padre?.type === 'switch') {
        // Una variante de un switch: avisar si se ve solo porque está seleccionada, y dejar elegir la que se ve.
        const deVista = variantesAMostrar(doc)[padre.id] === sel.id;
        return [
          texto(`${codigo(sel.id)} is a variant of switch ${codigo(padre.id)}.${deVista ? ' It shows while selected so you can edit it, but the switch displays another one.' : ''}`),
          selectorDeVariante(doc, padre),
          boton('Go to switch', `Select ${padre.id}`, () => seleccionar(padre.id)),
        ];
      }
      const partes = [texto('Drag to move. Handles: top circle = rotate, corners = scale, dot = pivot (moving it doesn’t move the drawing).')];
      const hueso = huesoDe(doc, sel.id);
      if (sel.bone) {
        partes.push(texto(`Follows bone ${codigo(sel.bone)}.`));
        partes.push(boton('Unbind', 'Stop following the bone', () => ejecutar([{ op: 'unset', target: sel.id, props: ['bone'] }], `unbind ${sel.id}`)));
        partes.push(boton('Go to bone', `Select ${sel.bone}`, () => seleccionar(sel.bone)));
      } else if (hueso) {
        partes.push(texto(`Follows ${codigo(hueso)} through its group.`));
      } else if (huesos.length) {
        partes.push(texto('To bind it to a bone: select the bone and use “Bind drawing…”.'));
      }
      return partes;
    }

    return [texto(huesos.length ? 'Click to select; drag on empty space for a marquee. Pick bones with the Bone tool (B) or in the Hierarchy.' : 'Click to select; drag on empty space to marquee-select.')];
  }

  /**
   * Enlace por punto: el hueso que sigue el vértice elegido, y repartir todos entre los huesos cercanos. Así un solo
   * path se dobla con una cadena de huesos.
   */
  function huesosDePuntos(doc, huesos) {
    const path = buscar(doc, estado.edicion);
    const vertices = leer(esquema, path, 'vertices');
    const guardar = (nuevos, nota) => ejecutar([{ op: 'set', target: path.id, props: { vertices: nuevos } }], `${nota} in ${path.id}`);
    const partes = [];
    if (estado.vertice != null && vertices[estado.vertice]) {
      const i = estado.vertice;
      const etiqueta = Object.assign(document.createElement('label'), { className: 'texto', textContent: `Point ${i} follows ` });
      const select = document.createElement('select');
      select.append(new Option(`(the shape’s${huesoDe(doc, path.id) ? `: ${huesoDe(doc, path.id)}` : ''})`, ''), ...huesos.map((h) => new Option(h.id, h.id)));
      select.value = vertices[i].bone ?? '';
      select.addEventListener('change', () => {
        const { bone, ...resto } = vertices[i];
        guardar(vertices.map((v, j) => (j === i ? (select.value ? { ...resto, bone: select.value } : resto) : v)), `point ${i} ${select.value ? `to ${select.value}` : 'unbound'}`);
      });
      etiqueta.append(select);
      partes.push(etiqueta);
    }
    partes.push(
      boton('Distribute among bones', 'Each point follows the nearest bone: the path bends with the chain in poses', () => {
        try {
          guardar(repartirEntreHuesos(doc, esquema, path.id), 'distribute points among bones');
        } catch (e) {
          avisar(e.message, true);
        }
      }),
    );
    if (vertices.some((v) => v.bone)) partes.push(boton('Remove bones', 'Points go back to following the shape’s bone', () => guardar(vertices.map(({ bone, ...v }) => v), 'unbind points')));
    return partes;
  }

  /** Switch: qué variante se ve (en el montaje) y cómo agregarle más. */
  function opcionesDeSwitch(doc, sw) {
    const variantes = doc.objects.filter((o) => o.parent === sw.id);
    if (!variantes.length) {
      return [texto(`Switch ${codigo(sw.id)} is empty: drag drawings into it in the Hierarchy, or draw with it selected. Each child is a variant, shown one at a time.`)];
    }
    // ¿Ya lo elige algún param? (un driver cuya pose cambia el active de este switch)
    const controles = [
      ...new Set(
        doc.objects
          .filter((o) => o.type === 'driver' && buscar(doc, o.pose)?.values?.[sw.id]?.active !== undefined)
          .map((o) => o.param)
          .filter(Boolean),
      ),
    ];
    const partes = [selectorDeVariante(doc, sw), texto(`${variantes.length} variant${variantes.length === 1 ? '' : 's'}: to add more, drag drawings into it or draw with the switch selected.`)];
    if (controles.length) partes.push(texto(`Chosen by control ${controles.map(codigo).join(', ')} (below, in Parameters).`));
    else partes.push(boton('Create control', 'A parameter with one option per variant (listed below, in Parameters): creates one pose per variant plus its drivers', () => crearControl(doc, sw, variantes), 'principal'));
    return partes;
  }

  /**
   * Arma lo que se necesita para elegir la variante desde un control: un param enum con una opción por hijo, una pose
   * por opción (que pone ese hijo en active) y un driver con equals para cada una.
   */
  function crearControl(doc, sw, variantes) {
    const base = prompt('Control name (e.g. viseme, mouth_shape):', `${sw.id}_choice`)?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const param = /^[a-z]/.test(base) ? base : `param_${base}`;
    // Opciones cortas: sin el prefijo del switch si todas lo tienen (mouth_a → a).
    const prefijo = `${sw.id}_`;
    const corto = variantes.every((v) => v.id.startsWith(prefijo) && v.id.length > prefijo.length);
    const opciones = variantes.map((v) => (corto ? v.id.slice(prefijo.length) : v.id));
    const ops = [{ op: 'create', type: 'param', id: param, props: { kind: 'enum', options: opciones, initial: opciones[variantes.findIndex((v) => v.id === varianteDe(doc, sw))] ?? opciones[0] } }];
    variantes.forEach((v, i) => {
      const pose = `${param}_${opciones[i]}`;
      ops.push({ op: 'create', type: 'pose', id: pose, props: { values: { [sw.id]: { active: v.id } } } });
      ops.push({ op: 'create', type: 'driver', id: `${pose}_driver`, props: { param, pose, equals: opciones[i] } });
    });
    const repetido = ops.find((o) => buscar(doc, o.id));
    if (repetido) return avisar(`"${repetido.id}" already exists; choose another name for the control`, true);
    ejecutar(ops, `control ${param} for ${sw.id} (${opciones.length} options)`);
    avisar(`Done: control ${param} is below, in Parameters`);
  }

  /** «X muestra [lista]»: en una pose cambia la pose; si no, el montaje. */
  function selectorDeVariante(doc, sw) {
    const variantes = doc.objects.filter((o) => o.parent === sw.id);
    const etiqueta = Object.assign(document.createElement('label'), { className: 'texto', textContent: `${estado.pose ? `In pose ${estado.pose}, ` : ''}${sw.id} shows ` });
    const select = document.createElement('select');
    select.append(...variantes.map((o) => new Option(o.id, o.id, false, o.id === varianteDe(doc, sw))));
    select.title = 'Which variant is shown. To have a control choose it: one pose per variant (active) and drivers with equals.';
    select.addEventListener('change', () => elegirVariante(sw.id, select.value));
    etiqueta.append(select);
    return etiqueta;
  }

  function opcionesDeHueso(doc, hueso) {
    const enlazados = doc.objects.filter((o) => o.bone === hueso.id);
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const resumen = enlazados.length
      ? `Setup: ${codigo(hueso.id)} moves ${enlazados.length} object${enlazados.length === 1 ? '' : 's'}, but only in poses; here you position it over the drawing.`
      : `Setup: position ${codigo(hueso.id)} over the drawing and bind the parts it should move.`;
    const partes = [
      texto(resumen),
      boton('Bind drawing…', 'Click to choose which parts follow this bone', () => fijar({ enlazando: hueso.id }), enlazados.length ? '' : 'principal'),
    ];
    if (enlazados.length) partes.push(boton(`Show bound (${enlazados.length})`, 'Select the parts bound to this bone', () => seleccionarVarios(enlazados.map((o) => o.id))));
    partes.push(boton('＋ Child bone', 'Bone tool: drag from this bone’s tip to chain another (B)', () => fijar({ herramienta: 'hueso' })));
    partes.push(
      boton(
        poses.length ? `Try in pose ${poses[0].id}` : 'Try in a pose',
        'See how the drawing moves when the bone rotates, without touching Setup',
        () => {
          if (poses.length) return fijar({ pose: poses[0].id });
          let id = 'pose_1';
          for (let n = 2; buscar(doc, id); n++) id = `pose_${n}`;
          ejecutar([{ op: 'create', type: 'pose', id }], `create pose ${id}`);
          fijar({ pose: id });
        },
        enlazados.length ? 'principal' : '',
      ),
    );
    return partes;
  }
}
