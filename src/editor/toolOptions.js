// Barra de opciones sobre el lienzo (como la de Moho): dice qué se puede hacer con la herramienta y lo seleccionado,
// y ofrece como botones las acciones que tienen atajo. Así no hace falta saberse los atajos para descubrir qué sigue.

import { findObject, skeletonOf, bonesOf } from '../core/document.js';
import { read, readMeta } from '../core/schema.js';
import { bindingsByProximity, boneOf, distributeBetweenBones } from '../core/skeleton.js';
import { switchParams } from '../core/blend.js';
import { artboardOps } from '../core/artboard.js';
import { notify, execute, schema, state, setState, select, selectSeveral, subscribe } from './state.js';
import { boneColor, activeSkeleton, reparentPlan } from './bones.js';
import { chooseVariant, poseOps, variantOf, variantsToShow } from './editing.js';

/**
 * `acciones`: lo que vive en main.js y la barra también ofrece (agrupar, enlazar la selección, enlazar todo por
 * cercanía...).
 */
// Tamaños comunes del lienzo: [nombre, ancho, alto].
const SIZES = [
  ['Square', 512, 512],
  ['Square', 800, 800],
  ['Square', 1024, 1024],
  ['HD', 1280, 720],
  ['Full HD', 1920, 1080],
  ['Vertical', 1080, 1920],
];

export function mountOptions(root, actions) {
  subscribe((c) => {
    if (['doc', 'seleccion', 'herramienta', 'pose', 'params', 'edicion', 'vertice', 'id', 'modo'].some((k) => k in c) || ('time' in c && !state.playing)) draw();
  });

  const button = (text, title, onClick, className = '') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title: title, className: className });
    b.addEventListener('click', onClick);
    return b;
  };
  const text = (html) => Object.assign(document.createElement('span'), { className: 'texto', innerHTML: html });
  const code = (id) => `<b>${id}</b>`;

  function draw() {
    const doc = state.doc;
    root.hidden = !doc;
    if (!doc) return;
    root.replaceChildren(...content(doc));
    // En la barra el texto entra en una línea; entero, al pasar el mouse.
    for (const t of root.querySelectorAll('.texto')) t.title = t.textContent;
    root.classList.toggle('en-pose', !!state.pose);
    root.classList.toggle('enlazando', ['enlazarCapa', 'enlazarPuntos'].includes(state.tool) && !state.pose);
  }

  function content(doc) {
    const sel = state.selection && findObject(doc, state.selection);
    const several = state.selected.length > 1;
    const bones = doc.objects.filter((o) => o.type === 'bone');

    // Reparent Bone, Bind Layer y Bind Points trabajan sobre el hueso elegido: dicen qué hacer con él.
    if (!state.pose && !state.params && ['reparentar', 'enlazarCapa', 'enlazarPuntos'].includes(state.tool)) return bindingOptions(doc, sel?.type === 'bone' ? sel : null);

    if (state.pose && findObject(doc, state.pose)?.type === 'animation') {
      const t = +state.time.toFixed(3);
      const parts = [
        text(
          state.editing
            ? `Clip ${code(state.pose)} at ${t} s: points you move are keyed at the playhead (with the same point count, they morph between keyframes).`
            : `Clip ${code(state.pose)} at ${t} s: drag a bone or its bound drawing to rotate it; a free shape gets the move, rotate and scale handles; mouth, colors, switch… in the inspector. Every change is keyed at the playhead (autokey). <kbd>Enter</kbd> edits a path's points.`,
        ),
      ];
      if (state.editing) parts.push(button('Finish points', 'Exit point editing (Enter)', () => setState({ editing: null, vertex: null })));
      return parts;
    }

    if (state.pose) {
      const pose = findObject(doc, state.pose);
      const parts = [
        text(
          state.editing
            ? `Pose ${code(state.pose)}: points you move are stored in the pose (with the same point count, params interpolate it). Setup is unchanged.`
            : `Pose ${code(state.pose)}: drag a bone or its bound drawing to rotate it; a free shape gets the move, rotate and scale handles. Everything else (mouth, colors, switch...) is set in the inspector, which shows the pose values at the top; <kbd>Enter</kbd> edits a path's points in the pose.`,
        ),
      ];
      if (sel && pose?.values?.[sel.id]) {
        parts.push(button(`Remove ${sel.id} from pose`, 'Revert to its Setup state, in this pose only', () => execute(poseOps(doc, pose.id, sel.id, Object.fromEntries(Object.keys(pose.values[sel.id]).map((k) => [k, undefined]))), `pose ${pose.id}: ${sel.id} back to setup`)));
      }
      if (state.editing) parts.push(button('Finish points', 'Exit point editing (Enter)', () => setState({ editing: null, vertex: null })));
      return parts;
    }

    if (state.params) {
      // En Puppet, el cartel del lienzo ya dice que se ven los params (y cómo abrir una pose).
      return state.mode === 'puppet' ? [] : [text('Parameters: the canvas shows the pose blend set by the controls on the right.')];
    }

    if (state.editing) {
      const parts = [text('Points: drag anchors and tangents (Alt breaks them), double-click an anchor = straight or curved, click the outline to add, <kbd>Del</kbd> deletes.')];
      parts.push(...pointBones(doc));
      parts.push(button('Done', 'Exit point editing (Enter)', () => setState({ editing: null, vertex: null }), 'principal'));
      return parts;
    }

    if (sel?.type === 'bone' && !several) return boneOptions(doc, sel);

    switch (state.tool) {
      case 'artboard':
        return artboardOptions(doc);
      case 'hueso': {
        const skeleton = activeSkeleton(doc);
        if (!skeleton) return [text('Add Bone: bones live in a skeleton (a bone layer). Pick one in Layers, or just drag on the canvas and a new skeleton is created for the bone.')];
        return [
          text(
            bonesOf(doc, skeleton).length
              ? `Add Bone, in skeleton ${code(skeleton)}: drag on empty space to create a root bone, or click a bone and drag from its tip to chain a child.`
              : `Add Bone, in skeleton ${code(skeleton)}: drag on the canvas to create its first bone (from the joint toward the tip).`,
          ),
        ];
      }
      case 'manipular':
        return [
          text(bones.length ? 'Manipulate Bones: drag a bone to rotate it; drag on empty space to select several (Ctrl or Shift adds); select one to move its origin or change its direction and length with the handles.' : 'Manipulate Bones: there are no bones yet. Create them with Add Bone (B).'),
          ...(bones.length ? [] : [button('Add Bone', 'Create bones (B)', () => setState({ tool: 'hueso' }), 'principal')]),
        ];
      case 'path':
        return [text('Pen: click = straight point, click and drag = curved, click the first point = close, <kbd>Enter</kbd> = finish open.')];
      case 'rect':
      case 'ellipse':
        return [text(`Drag to draw ${state.tool === 'rect' ? 'a rectangle' : 'an ellipse'}; <kbd>Shift</kbd> = ${state.tool === 'rect' ? 'square' : 'circle'}.`)];
      case 'rotar':
      case 'escalar':
        return [text(`${state.tool === 'rotar' ? 'Rotate' : 'Scale'}: drag anywhere; the selection ${state.tool === 'rotar' ? 'rotates' : 'scales'} around its pivot.`)];
    }

    if (several) {
      const ids = state.selected;
      const parts = [
        text(`${ids.length} objects: drag to move them; the handles rotate and scale them together.`),
        button('Group', 'Put them in a new group (Ctrl+G)', actions.group),
        button('Switch', 'Put them in a switch: each one is a variant, shown one at a time (Shift+G)', actions.switch),
      ];
      const bone = ids.map((id) => findObject(doc, id)).filter((o) => o?.type === 'bone');
      if (bone.length === 1) parts.push(button(`Bind to ${bone[0].id}`, 'Bind the selected drawing to this bone (Ctrl+B)', actions.bind));
      return parts;
    }

    if (sel?.type === 'switch') return switchOptions(doc, sel);
    if (sel?.type === 'skeleton') return skeletonOptions(doc, sel);

    if (sel && !schema.types.get(sel.type).resource) {
      const parent = sel.parent && findObject(doc, sel.parent);
      if (parent?.type === 'switch') {
        // Una variante de un switch: avisar si se ve solo porque está seleccionada, y dejar elegir la que se ve.
        const fromView = variantsToShow(doc)[parent.id] === sel.id;
        return [
          text(`${code(sel.id)} is a variant of switch ${code(parent.id)}.${fromView ? ' It shows while selected so you can edit it, but the switch displays another one.' : ''}`),
          variantSelector(doc, parent),
          button('Go to switch', `Select ${parent.id}`, () => select(parent.id)),
        ];
      }
      const parts = [text('Drag to move. Handles: top circle = rotate, corners = scale, dot = pivot (moving it doesn’t move the drawing).')];
      const bone = boneOf(doc, sel.id);
      if (sel.bone) {
        parts.push(text(`Follows bone ${code(sel.bone)}.`));
        parts.push(button('Unbind', 'Stop following the bone', () => execute([{ op: 'unset', target: sel.id, props: ['bone'] }], `unbind ${sel.id}`)));
        parts.push(button('Go to bone', `Select ${sel.bone}`, () => select(sel.bone)));
      } else if (bone) {
        parts.push(text(`Follows ${code(bone)} through its group.`));
      } else if (sel.vertices?.some((v) => v.bone)) {
        // Enlace por punto: cuántos puntos sigue cada hueso, con su color.
        const count = {};
        for (const v of sel.vertices) if (v.bone) count[v.bone] = (count[v.bone] ?? 0) + 1;
        const list = Object.entries(count).map(([h, n]) => `<b style="color:${boneColor(doc, h)}">${h}</b> ${n}`).join(', ');
        parts.push(text(`Its points follow bones: ${list}.`));
        parts.push(button('Bind Points', 'Bind Points tool: pick a bone, then click or box the points', () => setState({ tool: 'enlazarPuntos' })));
        parts.push(button('Unbind points', 'Points go back to following the shape', () => execute([{ op: 'set', target: sel.id, props: { vertices: sel.vertices.map(({ bone, ...v }) => v) } }], `unbind points of ${sel.id}`)));
      } else {
        const skeleton = skeletonOf(doc, sel.id);
        if (skeleton && bonesOf(doc, skeleton).length) {
          parts.push(text(`Doesn’t follow any bone of ${code(skeleton)}: it stays still in poses. Bind it with Bind Layer (L), or its points with Bind Points.`));
          parts.push(button('Bind Layer', 'Bind Layer tool: click a bone, then this drawing (L)', () => setState({ tool: 'enlazarCapa' })));
          parts.push(button('Bind all by proximity', `Bind every unbound drawing of ${skeleton} to its nearest bone`, () => actions.bindAll(skeleton)));
        } else if (skeleton) {
          parts.push(text(`In skeleton ${code(skeleton)}, which has no bones yet: draw them with Add Bone (B).`));
        } else if (bones.length) {
          parts.push(text('Not in a skeleton, so it can’t follow bones: drag it into one in Layers.'));
        }
      }
      return parts;
    }

    return [text(bones.length ? 'Click to select; drag on empty space for a marquee. Bones are picked on the canvas with Add Bone (B) or Manipulate Bones (M).' : 'Click to select; drag on empty space to marquee-select.')];
  }

  /**
   * Artboard: arrastrar las manijas cambia el tamaño con el dibujo centrado (como Moho). Además, tamaños comunes,
   * ajustar al contenido y el diálogo de Project Settings.
   */
  function artboardOptions(doc) {
    const w = readMeta(schema, doc, 'width');
    const h = readMeta(schema, doc, 'height');
    const select = document.createElement('select');
    select.title = 'Common sizes; the drawing stays centered';
    select.append(new Option(`${w} × ${h}`, ''), ...SIZES.map(([name, a, b]) => new Option(`${name} · ${a} × ${b}`, `${a}x${b}`)));
    select.addEventListener('change', () => {
      if (!select.value) return;
      const [a, b] = select.value.split('x').map(Number);
      execute(artboardOps(state.doc, schema, a, b), `artboard ${a} × ${b}`);
    });
    return [
      text(`Artboard ${code(`${w} × ${h}`)}: drag the handles to resize; the drawing stays centered (<kbd>Shift</kbd> keeps proportions). Name, background and fps are in the inspector.`),
      select,
      button('Fit to content', 'Resize the artboard around the drawing, with a 20 px margin, and center it', () => fitToContent()),
      button('Project Settings…', 'All the document settings in a dialog', actions.projectSettings),
    ];
  }

  /** Caja del dibujo (lo que se ve, en coordenadas del documento) más un margen; centra el contenido en el lienzo nuevo. */
  function fitToContent(margin = 20) {
    const frame = document.querySelector('#documento > .marco-documento')?.getBoundingClientRect();
    if (!frame?.width) return;
    const scale = frame.width / readMeta(schema, state.doc, 'width');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of document.querySelectorAll('#documento > [data-id]')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (x0 === Infinity) return notify('Nothing to fit: the artboard is empty');
    const box = { x: (x0 - frame.left) / scale, y: (y0 - frame.top) / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale };
    const width = Math.max(1, Math.ceil(box.w + 2 * margin));
    const height = Math.max(1, Math.ceil(box.h + 2 * margin));
    // Corre el dibujo para que su caja quede en el medio del lienzo nuevo.
    const offset = [Math.round(width / 2 - (box.x + box.w / 2)), Math.round(height / 2 - (box.y + box.h / 2))];
    execute(artboardOps(state.doc, schema, width, height, offset), `artboard fit to content (${width} × ${height})`);
  }

  /**
   * Enlace por punto: el hueso que sigue el vértice elegido, y repartir todos entre los huesos cercanos. Así un solo
   * path se dobla con una cadena de huesos.
   */
  function pointBones(doc) {
    const path = findObject(doc, state.editing);
    // Solo los huesos del skeleton del path.
    const skeleton = skeletonOf(doc, path.id);
    const bones = skeleton ? bonesOf(doc, skeleton) : [];
    if (!bones.length) return [];
    const vertices = read(schema, path, 'vertices');
    const save = (created, nota) => execute([{ op: 'set', target: path.id, props: { vertices: created } }], `${nota} in ${path.id}`);
    const parts = [];
    if (state.vertex != null && vertices[state.vertex]) {
      const i = state.vertex;
      const label = Object.assign(document.createElement('label'), { className: 'texto', textContent: `Point ${i} follows ` });
      const select = document.createElement('select');
      select.append(new Option(`(the shape’s${boneOf(doc, path.id) ? `: ${boneOf(doc, path.id)}` : ''})`, ''), ...bones.map((h) => new Option(h.id, h.id)));
      select.value = vertices[i].bone ?? '';
      select.addEventListener('change', () => {
        const { bone, ...rest } = vertices[i];
        save(vertices.map((v, j) => (j === i ? (select.value ? { ...rest, bone: select.value } : rest) : v)), `point ${i} ${select.value ? `to ${select.value}` : 'unbound'}`);
      });
      label.append(select);
      parts.push(label);
    }
    parts.push(
      button('Distribute among bones', `Each point follows the nearest bone of ${skeleton}: the path bends with the chain in poses`, () => {
        try {
          save(distributeBetweenBones(doc, schema, path.id), 'distribute points among bones');
        } catch (e) {
          notify(e.message, true);
        }
      }),
    );
    if (vertices.some((v) => v.bone)) parts.push(button('Remove bones', 'Points go back to following the shape’s bone', () => save(vertices.map(({ bone, ...v }) => v), 'unbind points')));
    return parts;
  }

  /** Switch: qué variante se ve (en el montaje) y cómo agregarle más. */
  function switchOptions(doc, sw) {
    const variants = doc.objects.filter((o) => o.parent === sw.id);
    if (!variants.length) {
      return [text(`Switch ${code(sw.id)} is empty: drag drawings into it in Layers, or draw with it selected. Each child is a variant, shown one at a time.`)];
    }
    const parts = [variantSelector(doc, sw), text(`${variants.length} variant${variants.length === 1 ? '' : 's'}: to add more, drag drawings into it or draw with the switch selected.`)];
    // Solo información: qué params eligen la variante (por drivers hacia poses que fijan active).
    const params = switchParams(doc, sw.id);
    if (params.length) parts.push(text(`Chosen by parameter${params.length === 1 ? '' : 's'} ${params.map(code).join(', ')} (in Parameters, below).`));
    return parts;
  }

  /** «X muestra [lista]»: en una pose cambia la pose; si no, el montaje. */
  function variantSelector(doc, sw) {
    const variants = doc.objects.filter((o) => o.parent === sw.id);
    const label = Object.assign(document.createElement('label'), { className: 'texto', textContent: `${state.pose ? `In pose ${state.pose}, ` : ''}${sw.id} shows ` });
    const select = document.createElement('select');
    select.append(...variants.map((o) => new Option(o.id, o.id, false, o.id === variantOf(doc, sw))));
    select.title = 'Which variant is shown';
    select.addEventListener('change', () => chooseVariant(sw.id, select.value));
    label.append(select);
    return label;
  }

  /** Skeleton: cuántos huesos tiene, qué parte del dibujo todavía no sigue a ninguno, y enlazarlo todo de una vez. */
  function skeletonOptions(doc, skeleton) {
    const bones = bonesOf(doc, skeleton.id);
    if (!bones.length) {
      return [
        text(`Skeleton ${code(skeleton.id)} has no bones yet: draw them with Add Bone, from the joint toward the tip. The drawing inside it stays still until it’s bound.`),
        button('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => setState({ tool: 'hueso' }), 'principal'),
      ];
    }
    const pending = bindingsByProximity(doc, schema, skeleton.id);
    const parts = [
      text(
        `Skeleton ${code(skeleton.id)}: ${bones.length} bone${bones.length === 1 ? '' : 's'}. ` +
          (pending.length ? pending.length === 1 ? '1 piece of its drawing doesn’t follow any bone yet (it stays still in poses).' : `${pending.length} pieces of its drawing don’t follow any bone yet (they stay still in poses).` : 'All its drawing follows a bone.'),
      ),
    ];
    if (pending.length) parts.push(button('Bind all by proximity', `Each unbound piece goes to its nearest bone: ${pending.map((e) => `${e.id} → ${e.bone}`).join(', ')}`, () => actions.bindAll(skeleton.id), 'principal'));
    parts.push(button('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => setState({ tool: 'hueso' })));
    parts.push(button('Manipulate', 'Manipulate Bones: rotate, move and resize its bones (M)', () => setState({ tool: 'manipular' })));
    return parts;
  }

  /** «Parent: x · Children: a, b»: nombres que se tocan para ir a ese hueso (o al skeleton). */
  function kinship(doc, bone) {
    const box = Object.assign(document.createElement('span'), { className: 'texto parentesco' });
    const go = (id) => {
      const b = button(id, `Select ${id}`, () => select(id), 'enlace-hueso');
      if (findObject(doc, id)?.type === 'bone') b.style.color = boneColor(doc, id);
      return b;
    };
    const parent = findObject(doc, bone.parent);
    box.append(parent?.type === 'bone' ? 'Parent: ' : 'Root bone of ', go(bone.parent));
    const children = doc.objects.filter((o) => o.type === 'bone' && o.parent === bone.id);
    if (children.length) {
      box.append(' · Children: ');
      children.forEach((h, i) => box.append(...(i ? [', '] : []), go(h.id)));
    }
    return box;
  }

  /**
   * Reparent Bone, como en Blender: se eligen los hijos y al final el padre (Shift + clic), y un botón hace el cambio.
   * Nada cambia con solo hacer clic.
   */
  function reparentOptions(doc, bone) {
    const plan = reparentPlan(doc);
    const names = (list) => list.map((x) => code(x.id)).join(', ');
    if (!bone) return [text('Reparent Bone: click the bone(s) to move, then Shift + click the new parent last. Then use the buttons here. Click empty space to deselect. The lines show each bone’s parent.')];
    const parts = [];
    if (!plan.children.length) {
      parts.push(text(`${code(bone.id)} selected. Shift + click the bone it should hang from (the last one you pick is the parent), or clear its parent to make it a root bone.`));
      parts.push(kinship(doc, bone));
    } else if (plan.problem) {
      parts.push(text(`Parent: ${code(plan.parent.id)} (picked last). Can’t do it: ${plan.problem}.`));
    } else {
      parts.push(text(`${names(plan.children)} will hang from ${code(plan.parent.id)} (picked last, dashed). Nothing moves in the setup.`));
    }
    const inPoses = (list) => `In pose${list.length === 1 ? '' : 's'} ${list.join(', ')} the bones move: they follow a different parent now.`;
    if (plan.children.length && !plan.problem) {
      const alreadyThere = !plan.ops.length;
      const which = plan.children.map((x) => x.id).join(', ');
      if (plan.ops.moved?.length) parts.push(text(`${inPoses(plan.ops.moved)} “Keep poses” adds values to those poses so the bones stay where they were.`));
      const b = button(`Parent to ${plan.parent.id}`, alreadyThere ? 'They already hang from it' : `Make ${plan.parent.id} the parent of ${which}`, () => execute(plan.ops, `parent ${which} to ${plan.parent.id}`), 'principal');
      b.disabled = alreadyThere;
      parts.push(b);
      if (plan.ops.moved?.length) parts.push(button('Keep poses', `Make ${plan.parent.id} the parent and fix ${plan.ops.moved.join(', ')} so the bones don’t move in them`, () => execute(plan.keepingOps(), `parent ${which} to ${plan.parent.id}, keeping poses`)));
    }
    if (plan.loose.length) {
      if (plan.releaseOps.moved?.length) parts.push(text(`Clear parent: ${inPoses(plan.releaseOps.moved)}`));
      const which = plan.loose.map((x) => x.id).join(', ');
      parts.push(button('Clear parent', `Make ${which} root bone${plan.loose.length === 1 ? '' : 's'} of the skeleton, without moving them in the setup`, () => execute(plan.releaseOps, `clear parent of ${which}`)));
      if (plan.releaseOps.moved?.length) parts.push(button('Clear parent, keep poses', `Also fix ${plan.releaseOps.moved.join(', ')} so the bones don’t move in them`, () => execute(plan.releaseKeepingOps(), `clear parent of ${which}, keeping poses`)));
    }
    parts.push(button('Deselect', 'Clear the selection (or click empty space)', () => select(null)));
    return parts;
  }

  /** Reparent Bone, Bind Layer y Bind Points: qué hacer según haya o no un hueso elegido. */
  function bindingOptions(doc, bone) {
    const h = bone && code(bone.id);
    const skeleton = bone && skeletonOf(doc, bone.id);
    if (state.tool === 'reparentar') return reparentOptions(doc, bone);
    if (state.tool === 'enlazarCapa') {
      if (!bone) return [text('Bind Layer: click a bone, then click the drawing that should follow it whole (or its row in Layers). Click again to unbind; Alt + click picks its group.')];
      const n = doc.objects.filter((o) => o.bone === bone.id).length;
      const parts = [text(`Bind Layer → ${h}: click drawing of ${code(skeleton)} (or its row in Layers) to bind or unbind it; Alt + click picks its group. ${n} bound.`)];
      if (bindingsByProximity(doc, schema, skeleton).length) parts.push(button('Bind all by proximity', `Bind every unbound drawing of ${skeleton} to its nearest bone`, () => actions.bindAll(skeleton)));
      return parts;
    }
    if (!bone) return [text('Bind Points: click a bone, then click points of its skeleton’s paths, or drag a box around them. They take the bone’s color. Alt unbinds.')];
    const n = doc.objects.reduce((t, o) => t + (o.type === 'path' ? (o.vertices ?? []).filter((v) => v.bone === bone.id).length : 0), 0);
    return [text(`Bind Points → <b style="color:${boneColor(doc, bone.id)}">${bone.id}</b>: click a point to bind or unbind it, or drag a box to bind all inside (Alt + box: unbind). ${n} point${n === 1 ? '' : 's'} follow it; white points follow their shape.`)];
  }

  function boneOptions(doc, bone) {
    const bound = doc.objects.filter((o) => o.bone === bone.id);
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const points = doc.objects.reduce((t, o) => t + (o.type === 'path' ? (o.vertices ?? []).filter((v) => v.bone === bone.id).length : 0), 0);
    const moved = [bound.length && `${bound.length} object${bound.length === 1 ? '' : 's'}`, points && `${points} point${points === 1 ? '' : 's'}`].filter(Boolean);
    const binding = moved.length ? `It moves ${moved.join(' and ')}, only in poses.` : 'Nothing is bound to it yet.';
    const summary =
      state.tool === 'hueso'
        ? `Add Bone: drag from the tip of ${code(bone.id)} to chain a child, or on empty space for another one. ${binding}`
        : state.tool === 'manipular'
          ? `Manipulate, Setup: drag ${code(bone.id)} to rotate it; its origin dot moves it, its tip changes direction and length. ${binding}`
          : `Setup, bone ${code(bone.id)}. ${binding}`;
    const parts = [
      text(summary),
      kinship(doc, bone),
      button('Bind Layer', 'Bind Layer tool: click drawing to make it follow this bone (L)', () => setState({ tool: 'enlazarCapa' }), bound.length ? '' : 'principal'),
      button('Bind Points', 'Bind Points tool: click or box points of a path to make them follow this bone', () => setState({ tool: 'enlazarPuntos' })),
    ];
    const skeleton = skeletonOf(doc, bone.id);
    if (skeleton && bindingsByProximity(doc, schema, skeleton).length) {
      parts.push(button('Bind all by proximity', `Bind every unbound drawing of ${skeleton} to its nearest bone`, () => actions.bindAll(skeleton)));
    }
    parts.push(
      button(
        poses.length ? `Try in pose ${poses[0].id}` : 'Try in a pose',
        'See how the drawing moves when the bone rotates, without touching Setup',
        () => {
          if (poses.length) return setState({ pose: poses[0].id });
          let id = 'pose_1';
          for (let n = 2; findObject(doc, id); n++) id = `pose_${n}`;
          execute([{ op: 'create', type: 'pose', id }], `create pose ${id}`);
          setState({ pose: id });
        },
        bound.length ? 'principal' : '',
      ),
    );
    return parts;
  }
}
