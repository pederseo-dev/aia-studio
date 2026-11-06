// Barra de opciones sobre el lienzo (como la de Moho): dice qué se puede hacer con la herramienta y lo seleccionado,
// y ofrece como botones las acciones que tienen atajo. Así no hace falta saberse los atajos para descubrir qué sigue.

import { buscar, esqueletoDe, huesosDe } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { enlacesPorCercania, huesoDe, repartirEntreHuesos } from '../core/esqueleto.js';
import { paramsDeSwitch } from '../core/mezcla.js';
import { avisar, ejecutar, esquema, estado, fijar, seleccionar, seleccionarVarios, suscribir } from './estado.js';
import { colorDeHueso, elegirVariante, esqueletoActivo, opsDePose, planDeReparentar, varianteDe, variantesAMostrar } from './huesos.js';

/**
 * `acciones`: lo que vive en main.js y la barra también ofrece (agrupar, enlazar la selección, enlazar todo por
 * cercanía...).
 */
export function montarOpciones(raiz, acciones) {
  suscribir((c) => {
    if (['doc', 'seleccion', 'herramienta', 'pose', 'params', 'edicion', 'vertice', 'id', 'modo'].some((k) => k in c) || ('tiempo' in c && !estado.reproduciendo)) dibujar();
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
    raiz.classList.toggle('enlazando', ['enlazarCapa', 'enlazarPuntos'].includes(estado.herramienta) && !estado.pose);
  }

  function contenido(doc) {
    const sel = estado.seleccion && buscar(doc, estado.seleccion);
    const varios = estado.seleccionados.length > 1;
    const huesos = doc.objects.filter((o) => o.type === 'bone');

    // Reparent Bone, Bind Layer y Bind Points trabajan sobre el hueso elegido: dicen qué hacer con él.
    if (!estado.pose && !estado.params && ['reparentar', 'enlazarCapa', 'enlazarPuntos'].includes(estado.herramienta)) return opcionesDeEnlace(doc, sel?.type === 'bone' ? sel : null);

    if (estado.pose && buscar(doc, estado.pose)?.type === 'animation') {
      const t = +estado.tiempo.toFixed(3);
      const partes = [
        texto(
          estado.edicion
            ? `Clip ${codigo(estado.pose)} at ${t} s: points you move are keyed at the playhead (with the same point count, they morph between keyframes).`
            : `Clip ${codigo(estado.pose)} at ${t} s: drag a bone or its bound drawing to rotate it; mouth, colors, switch… in the inspector. Every change is keyed at the playhead (autokey). <kbd>Enter</kbd> edits a path's points.`,
        ),
      ];
      if (estado.edicion) partes.push(boton('Finish points', 'Exit point editing (Enter)', () => fijar({ edicion: null, vertice: null })));
      if (estado.modo === 'puppet') partes.push(boton('Close clip', 'Back to the parameter blend', () => fijar({ pose: null, params: estado.params ?? {}, edicion: null, vertice: null, reproduciendo: false }), 'principal'));
      return partes;
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
        texto('Parameters: the canvas shows the pose blend set by the controls below. Nothing is edited here; to change a pose, pick it under “View”.'),
        boton('Back to Setup', 'Stop previewing the blend', () => fijar({ params: null }), 'principal'),
      ];
    }

    if (estado.edicion) {
      const partes = [texto('Points: drag anchors and tangents (Alt breaks them), double-click an anchor = straight or curved, click the outline to add, <kbd>Del</kbd> deletes.')];
      partes.push(...huesosDePuntos(doc));
      partes.push(boton('Done', 'Exit point editing (Enter)', () => fijar({ edicion: null, vertice: null }), 'principal'));
      return partes;
    }

    if (sel?.type === 'bone' && !varios) return opcionesDeHueso(doc, sel);

    switch (estado.herramienta) {
      case 'hueso': {
        const esqueleto = esqueletoActivo(doc);
        if (!esqueleto) return [texto('Add Bone: bones live in a skeleton (a bone layer). Pick one in Layers, or just drag on the canvas and a new skeleton is created for the bone.')];
        return [
          texto(
            huesosDe(doc, esqueleto).length
              ? `Add Bone, in skeleton ${codigo(esqueleto)}: drag on empty space to create a root bone, or click a bone and drag from its tip to chain a child.`
              : `Add Bone, in skeleton ${codigo(esqueleto)}: drag on the canvas to create its first bone (from the joint toward the tip).`,
          ),
        ];
      }
      case 'manipular':
        return [
          texto(huesos.length ? 'Manipulate Bones: drag a bone to rotate it; drag on empty space to select several (Ctrl or Shift adds); select one to move its origin or change its direction and length with the handles.' : 'Manipulate Bones: there are no bones yet. Create them with Add Bone (B).'),
          ...(huesos.length ? [] : [boton('Add Bone', 'Create bones (B)', () => fijar({ herramienta: 'hueso' }), 'principal')]),
        ];
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
    if (sel?.type === 'skeleton') return opcionesDeEsqueleto(doc, sel);

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
      } else if (sel.vertices?.some((v) => v.bone)) {
        // Enlace por punto: cuántos puntos sigue cada hueso, con su color.
        const cuenta = {};
        for (const v of sel.vertices) if (v.bone) cuenta[v.bone] = (cuenta[v.bone] ?? 0) + 1;
        const lista = Object.entries(cuenta).map(([h, n]) => `<b style="color:${colorDeHueso(doc, h)}">${h}</b> ${n}`).join(', ');
        partes.push(texto(`Its points follow bones: ${lista}.`));
        partes.push(boton('Bind Points', 'Bind Points tool: pick a bone, then click or box the points', () => fijar({ herramienta: 'enlazarPuntos' })));
        partes.push(boton('Unbind points', 'Points go back to following the shape', () => ejecutar([{ op: 'set', target: sel.id, props: { vertices: sel.vertices.map(({ bone, ...v }) => v) } }], `unbind points of ${sel.id}`)));
      } else {
        const esqueleto = esqueletoDe(doc, sel.id);
        if (esqueleto && huesosDe(doc, esqueleto).length) {
          partes.push(texto(`Doesn’t follow any bone of ${codigo(esqueleto)}: it stays still in poses. Bind it with Bind Layer (L), or its points with Bind Points.`));
          partes.push(boton('Bind Layer', 'Bind Layer tool: click a bone, then this drawing (L)', () => fijar({ herramienta: 'enlazarCapa' })));
          partes.push(boton('Bind all by proximity', `Bind every unbound drawing of ${esqueleto} to its nearest bone`, () => acciones.enlazarTodo(esqueleto)));
        } else if (esqueleto) {
          partes.push(texto(`In skeleton ${codigo(esqueleto)}, which has no bones yet: draw them with Add Bone (B).`));
        } else if (huesos.length) {
          partes.push(texto('Not in a skeleton, so it can’t follow bones: drag it into one in Layers.'));
        }
      }
      return partes;
    }

    return [texto(huesos.length ? 'Click to select; drag on empty space for a marquee. Bones are picked on the canvas with Add Bone (B) or Manipulate Bones (M).' : 'Click to select; drag on empty space to marquee-select.')];
  }

  /**
   * Enlace por punto: el hueso que sigue el vértice elegido, y repartir todos entre los huesos cercanos. Así un solo
   * path se dobla con una cadena de huesos.
   */
  function huesosDePuntos(doc) {
    const path = buscar(doc, estado.edicion);
    // Solo los huesos del skeleton del path.
    const esqueleto = esqueletoDe(doc, path.id);
    const huesos = esqueleto ? huesosDe(doc, esqueleto) : [];
    if (!huesos.length) return [];
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
      boton('Distribute among bones', `Each point follows the nearest bone of ${esqueleto}: the path bends with the chain in poses`, () => {
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
      return [texto(`Switch ${codigo(sw.id)} is empty: drag drawings into it in Layers, or draw with it selected. Each child is a variant, shown one at a time.`)];
    }
    const partes = [selectorDeVariante(doc, sw), texto(`${variantes.length} variant${variantes.length === 1 ? '' : 's'}: to add more, drag drawings into it or draw with the switch selected.`)];
    // Solo información: qué params eligen la variante (por drivers hacia poses que fijan active).
    const params = paramsDeSwitch(doc, sw.id);
    if (params.length) partes.push(texto(`Chosen by parameter${params.length === 1 ? '' : 's'} ${params.map(codigo).join(', ')} (in Parameters, below).`));
    return partes;
  }

  /** «X muestra [lista]»: en una pose cambia la pose; si no, el montaje. */
  function selectorDeVariante(doc, sw) {
    const variantes = doc.objects.filter((o) => o.parent === sw.id);
    const etiqueta = Object.assign(document.createElement('label'), { className: 'texto', textContent: `${estado.pose ? `In pose ${estado.pose}, ` : ''}${sw.id} shows ` });
    const select = document.createElement('select');
    select.append(...variantes.map((o) => new Option(o.id, o.id, false, o.id === varianteDe(doc, sw))));
    select.title = 'Which variant is shown';
    select.addEventListener('change', () => elegirVariante(sw.id, select.value));
    etiqueta.append(select);
    return etiqueta;
  }

  /** Skeleton: cuántos huesos tiene, qué parte del dibujo todavía no sigue a ninguno, y enlazarlo todo de una vez. */
  function opcionesDeEsqueleto(doc, esqueleto) {
    const huesos = huesosDe(doc, esqueleto.id);
    if (!huesos.length) {
      return [
        texto(`Skeleton ${codigo(esqueleto.id)} has no bones yet: draw them with Add Bone, from the joint toward the tip. The drawing inside it stays still until it’s bound.`),
        boton('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => fijar({ herramienta: 'hueso' }), 'principal'),
      ];
    }
    const pendientes = enlacesPorCercania(doc, esquema, esqueleto.id);
    const partes = [
      texto(
        `Skeleton ${codigo(esqueleto.id)}: ${huesos.length} bone${huesos.length === 1 ? '' : 's'}. ` +
          (pendientes.length ? pendientes.length === 1 ? '1 piece of its drawing doesn’t follow any bone yet (it stays still in poses).' : `${pendientes.length} pieces of its drawing don’t follow any bone yet (they stay still in poses).` : 'All its drawing follows a bone.'),
      ),
    ];
    if (pendientes.length) partes.push(boton('Bind all by proximity', `Each unbound piece goes to its nearest bone: ${pendientes.map((e) => `${e.id} → ${e.bone}`).join(', ')}`, () => acciones.enlazarTodo(esqueleto.id), 'principal'));
    partes.push(boton('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => fijar({ herramienta: 'hueso' })));
    partes.push(boton('Manipulate', 'Manipulate Bones: rotate, move and resize its bones (M)', () => fijar({ herramienta: 'manipular' })));
    return partes;
  }

  /** «Parent: x · Children: a, b»: nombres que se tocan para ir a ese hueso (o al skeleton). */
  function parentesco(doc, hueso) {
    const caja = Object.assign(document.createElement('span'), { className: 'texto parentesco' });
    const ir = (id) => {
      const b = boton(id, `Select ${id}`, () => seleccionar(id), 'enlace-hueso');
      if (buscar(doc, id)?.type === 'bone') b.style.color = colorDeHueso(doc, id);
      return b;
    };
    const padre = buscar(doc, hueso.parent);
    caja.append(padre?.type === 'bone' ? 'Parent: ' : 'Root bone of ', ir(hueso.parent));
    const hijos = doc.objects.filter((o) => o.type === 'bone' && o.parent === hueso.id);
    if (hijos.length) {
      caja.append(' · Children: ');
      hijos.forEach((h, i) => caja.append(...(i ? [', '] : []), ir(h.id)));
    }
    return caja;
  }

  /**
   * Reparent Bone, como en Blender: se eligen los hijos y al final el padre (Shift + clic), y un botón hace el cambio.
   * Nada cambia con solo hacer clic.
   */
  function opcionesDeReparentar(doc, hueso) {
    const plan = planDeReparentar(doc);
    const nombres = (lista) => lista.map((x) => codigo(x.id)).join(', ');
    if (!hueso) return [texto('Reparent Bone: click the bone(s) to move, then Shift + click the new parent last. Then use the buttons here. Click empty space to deselect. The lines show each bone’s parent.')];
    const partes = [];
    if (!plan.hijos.length) {
      partes.push(texto(`${codigo(hueso.id)} selected. Shift + click the bone it should hang from (the last one you pick is the parent), or clear its parent to make it a root bone.`));
      partes.push(parentesco(doc, hueso));
    } else if (plan.problema) {
      partes.push(texto(`Parent: ${codigo(plan.padre.id)} (picked last). Can’t do it: ${plan.problema}.`));
    } else {
      partes.push(texto(`${nombres(plan.hijos)} will hang from ${codigo(plan.padre.id)} (picked last, dashed). Nothing moves in the setup.`));
    }
    const enPoses = (lista) => `In pose${lista.length === 1 ? '' : 's'} ${lista.join(', ')} the bones move: they follow a different parent now.`;
    if (plan.hijos.length && !plan.problema) {
      const yaEstan = !plan.ops.length;
      const cuales = plan.hijos.map((x) => x.id).join(', ');
      if (plan.ops.movidas?.length) partes.push(texto(`${enPoses(plan.ops.movidas)} “Keep poses” adds values to those poses so the bones stay where they were.`));
      const b = boton(`Parent to ${plan.padre.id}`, yaEstan ? 'They already hang from it' : `Make ${plan.padre.id} the parent of ${cuales}`, () => ejecutar(plan.ops, `parent ${cuales} to ${plan.padre.id}`), 'principal');
      b.disabled = yaEstan;
      partes.push(b);
      if (plan.ops.movidas?.length) partes.push(boton('Keep poses', `Make ${plan.padre.id} the parent and fix ${plan.ops.movidas.join(', ')} so the bones don’t move in them`, () => ejecutar(plan.opsConservando(), `parent ${cuales} to ${plan.padre.id}, keeping poses`)));
    }
    if (plan.sueltos.length) {
      if (plan.opsSoltar.movidas?.length) partes.push(texto(`Clear parent: ${enPoses(plan.opsSoltar.movidas)}`));
      const cuales = plan.sueltos.map((x) => x.id).join(', ');
      partes.push(boton('Clear parent', `Make ${cuales} root bone${plan.sueltos.length === 1 ? '' : 's'} of the skeleton, without moving them in the setup`, () => ejecutar(plan.opsSoltar, `clear parent of ${cuales}`)));
      if (plan.opsSoltar.movidas?.length) partes.push(boton('Clear parent, keep poses', `Also fix ${plan.opsSoltar.movidas.join(', ')} so the bones don’t move in them`, () => ejecutar(plan.opsSoltarConservando(), `clear parent of ${cuales}, keeping poses`)));
    }
    partes.push(boton('Deselect', 'Clear the selection (or click empty space)', () => seleccionar(null)));
    return partes;
  }

  /** Reparent Bone, Bind Layer y Bind Points: qué hacer según haya o no un hueso elegido. */
  function opcionesDeEnlace(doc, hueso) {
    const h = hueso && codigo(hueso.id);
    const esqueleto = hueso && esqueletoDe(doc, hueso.id);
    if (estado.herramienta === 'reparentar') return opcionesDeReparentar(doc, hueso);
    if (estado.herramienta === 'enlazarCapa') {
      if (!hueso) return [texto('Bind Layer: click a bone, then click the drawing that should follow it whole (or its row in Layers). Click again to unbind; Alt + click picks its group.')];
      const n = doc.objects.filter((o) => o.bone === hueso.id).length;
      const partes = [texto(`Bind Layer → ${h}: click drawing of ${codigo(esqueleto)} (or its row in Layers) to bind or unbind it; Alt + click picks its group. ${n} bound.`)];
      if (enlacesPorCercania(doc, esquema, esqueleto).length) partes.push(boton('Bind all by proximity', `Bind every unbound drawing of ${esqueleto} to its nearest bone`, () => acciones.enlazarTodo(esqueleto)));
      return partes;
    }
    if (!hueso) return [texto('Bind Points: click a bone, then click points of its skeleton’s paths, or drag a box around them. They take the bone’s color. Alt unbinds.')];
    const n = doc.objects.reduce((t, o) => t + (o.type === 'path' ? (o.vertices ?? []).filter((v) => v.bone === hueso.id).length : 0), 0);
    return [texto(`Bind Points → <b style="color:${colorDeHueso(doc, hueso.id)}">${hueso.id}</b>: click a point to bind or unbind it, or drag a box to bind all inside (Alt + box: unbind). ${n} point${n === 1 ? '' : 's'} follow it; white points follow their shape.`)];
  }

  function opcionesDeHueso(doc, hueso) {
    const enlazados = doc.objects.filter((o) => o.bone === hueso.id);
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const puntos = doc.objects.reduce((t, o) => t + (o.type === 'path' ? (o.vertices ?? []).filter((v) => v.bone === hueso.id).length : 0), 0);
    const movidos = [enlazados.length && `${enlazados.length} object${enlazados.length === 1 ? '' : 's'}`, puntos && `${puntos} point${puntos === 1 ? '' : 's'}`].filter(Boolean);
    const enlace = movidos.length ? `It moves ${movidos.join(' and ')}, only in poses.` : 'Nothing is bound to it yet.';
    const resumen =
      estado.herramienta === 'hueso'
        ? `Add Bone: drag from the tip of ${codigo(hueso.id)} to chain a child, or on empty space for another one. ${enlace}`
        : estado.herramienta === 'manipular'
          ? `Manipulate, Setup: drag ${codigo(hueso.id)} to rotate it; its origin dot moves it, its tip changes direction and length. ${enlace}`
          : `Setup, bone ${codigo(hueso.id)}. ${enlace}`;
    const partes = [
      texto(resumen),
      parentesco(doc, hueso),
      boton('Bind Layer', 'Bind Layer tool: click drawing to make it follow this bone (L)', () => fijar({ herramienta: 'enlazarCapa' }), enlazados.length ? '' : 'principal'),
      boton('Bind Points', 'Bind Points tool: click or box points of a path to make them follow this bone', () => fijar({ herramienta: 'enlazarPuntos' })),
    ];
    const esqueleto = esqueletoDe(doc, hueso.id);
    if (esqueleto && enlacesPorCercania(doc, esquema, esqueleto).length) {
      partes.push(boton('Bind all by proximity', `Bind every unbound drawing of ${esqueleto} to its nearest bone`, () => acciones.enlazarTodo(esqueleto)));
    }
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
