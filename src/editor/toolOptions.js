// Option bar over the canvas (like Moho's): says what can be done with the tool and the selection, and offers as
// buttons the actions that have a shortcut, so knowing the shortcuts is not needed to discover what comes next.

import { findObject, skeletonOf, bonesOf, children } from '../core/document.js';
import { read, readMeta } from '../core/schema.js';
import { bindingsByProximity, boneOf } from '../core/skeleton.js';
import { planBindPoints } from '../core/bindPoints.js';
import { switchParams } from '../core/blend.js';
import { artboardOps } from '../core/artboard.js';
import { notify, execute, schema, state, setState, setAutoWeld, drawingLayer, select, subscribe } from './state.js';
import { boneColor, activeSkeleton, reparentPlan, bindablePoints, bindLayer, bindPicked } from './bones.js';
import { chooseVariant, poseOps, variantOf, variantsToShow } from './editing.js';

/**
 * `actions`: what lives in main.js and the bar also offers (group, bind the selection, bind everything by
 * proximity...).
 */
// Common canvas sizes: [name, width, height].
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
    if (['doc', 'selection', 'tool', 'pose', 'params', 'editing', 'vertex', 'id', 'mode', 'bindTarget', 'bindPicked'].some((k) => k in c) || ('time' in c && !state.playing)) draw();
  });

  const button = (text, title, onClick, className = '') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title: title, className: className });
    b.addEventListener('click', onClick);
    return b;
  };
  const text = (html) => Object.assign(document.createElement('span'), { className: 'text', innerHTML: html });
  const code = (id) => `<b>${id}</b>`;
  // Where the drawing tools put the next shape: the active vector layer, or a new one (as in Moho).
  const intoLayer = () => (drawingLayer() ? `It goes into layer ${code(drawingLayer())}.` : 'It goes into a new vector layer (select one to draw into it).');

  function draw() {
    const doc = state.doc;
    root.hidden = !doc;
    if (!doc) return;
    root.replaceChildren(...content(doc));
    // In the bar the text fits in one line; in full, on mouse hover.
    for (const t of root.querySelectorAll('.text')) t.title = t.textContent;
    root.classList.toggle('in-pose', !!state.pose);
    root.classList.toggle('binding', ['bindLayer', 'bindPoints'].includes(state.tool) && !state.pose);
  }

  function content(doc) {
    const sel = state.selection && findObject(doc, state.selection);
    const several = state.selected.length > 1;
    const bones = doc.objects.filter((o) => o.type === 'bone');

    // Reparent Bone, Bind Layer and Bind Points work on the picked bone: they say what to do with it.
    if (!state.pose && !state.params && ['reparent', 'bindLayer', 'bindPoints'].includes(state.tool)) return bindingOptions(doc, sel?.type === 'bone' ? sel : null);

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
      // In Puppet, the canvas banner already says that the params are seen (and how to open a pose).
      return state.mode === 'puppet' ? [] : [text('Parameters: the canvas shows the pose blend set by the controls on the right.')];
    }

    if (state.editing) {
      const parts = [text('Points: drag anchors and tangents (Alt breaks them), double-click an anchor = straight or curved, click the outline to add, <kbd>Del</kbd> deletes.')];
      // Auto-weld, a named checkbox as in Moho's tool options.
      const weld = Object.assign(document.createElement('label'), { className: 'option-check', title: 'Drop an end point of an open path on its other end to weld them and close the path' });
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.autoWeld });
      check.addEventListener('change', () => setAutoWeld(check.checked));
      weld.append(check, ' Auto-weld');
      parts.push(weld);
      parts.push(...pointBones(doc));
      parts.push(button('Done', 'Exit point editing (Enter)', () => setState({ editing: null, vertex: null }), 'main'));
      return parts;
    }

    if (sel?.type === 'bone' && !several) return boneOptions(doc, sel);

    switch (state.tool) {
      case 'artboard':
        return artboardOptions(doc);
      case 'bone': {
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
      case 'manipulate':
        return [
          text(bones.length ? 'Manipulate Bones: drag a bone to rotate it; drag on empty space to select several (Ctrl or Shift adds); select one to move its origin or change its direction and length with the handles.' : 'Manipulate Bones: there are no bones yet. Create them with Add Bone (B).'),
          ...(bones.length ? [] : [button('Add Bone', 'Create bones (B)', () => setState({ tool: 'bone' }), 'main')]),
        ];
      case 'path':
        return [text(`Pen: click = straight point, click and drag = curved, click the first point = close, <kbd>Enter</kbd> = finish open. ${intoLayer()}`)];
      case 'rect':
      case 'ellipse':
        return [text(`Drag to draw ${state.tool === 'rect' ? 'a rectangle' : 'an ellipse'}; <kbd>Shift</kbd> = ${state.tool === 'rect' ? 'square' : 'circle'}. ${intoLayer()}`)];
      case 'rotate':
      case 'scale':
        return [text(`${state.tool === 'rotate' ? 'Rotate' : 'Scale'}: drag anywhere; the selection ${state.tool === 'rotate' ? 'rotates' : 'scales'} around its pivot.`)];
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

    if (sel?.type === 'vector') {
      const shapes = children(doc, sel.id).filter((o) => o.type === 'shape').length;
      return [text(`Vector layer ${code(sel.id)}: ${shapes} shape${shapes === 1 ? '' : 's'}. Draw more with the Pen (P), Rectangle (R) or Ellipse (E); double-click a shape to pick it.`)];
    }
    if (sel?.type === 'shape') return [text(`Shape ${code(sel.id)} of ${code(sel.parent)}: drag it to move its points, the corners scale, the top handle rotates, the pivot can be dragged; drag a point to deform it. <kbd>Esc</kbd> goes back to the layer.`), button(`Go to ${sel.parent}`, `Select the vector layer ${sel.parent} (Esc)`, () => select(sel.parent))];
    if (sel?.type === 'switch') return switchOptions(doc, sel);
    if (sel?.type === 'skeleton') return skeletonOptions(doc, sel);

    if (sel && !schema.types.get(sel.type).resource) {
      const parent = sel.parent && findObject(doc, sel.parent);
      if (parent?.type === 'switch') {
        // A variant of a switch: warn if it is seen only because it is selected, and let the user choose the one seen.
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
      } else if (bindablePoints(sel).some(([, v]) => v.bone)) {
        // Point binding: how many points each bone follows, with its color.
        const count = {};
        for (const [, v] of bindablePoints(sel)) if (v.bone) count[v.bone] = (count[v.bone] ?? 0) + 1;
        const list = Object.entries(count).map(([h, n]) => `<b style="color:${boneColor(doc, h)}">${h}</b> ${n}`).join(', ');
        parts.push(text(`Its points follow bones: ${list}.`));
        parts.push(button('Bind Points', 'Bind Points tool: pick a bone, then click or box the points', () => setState({ tool: 'bindPoints' })));
        parts.push(button('Unbind points', 'Points go back to following the layer', () => execute(planBindPoints(doc, schema, sel.id, undefined, { release: true }).ops, `unbind points of ${sel.id}`)));
      } else {
        const skeleton = skeletonOf(doc, sel.id);
        if (skeleton && bonesOf(doc, skeleton).length) {
          parts.push(text(`Doesn’t follow any bone of ${code(skeleton)}: it stays still in poses. Bind it with Bind Layer (L), or its points with Bind Points.`));
          parts.push(button('Bind Layer', 'Bind Layer tool: click a bone, then this drawing (L)', () => setState({ tool: 'bindLayer' })));
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
   * Artboard: dragging the handles changes the size with the drawing centered (like Moho). Also, common sizes,
   * fit to content and the Project Settings dialog.
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

  /** Drawing box (what is seen, in document coordinates) plus a margin; centers the content in the new canvas. */
  function fitToContent(margin = 20) {
    const frame = document.querySelector('#document > .document-frame')?.getBoundingClientRect();
    if (!frame?.width) return;
    const scale = frame.width / readMeta(schema, state.doc, 'width');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of document.querySelectorAll('#document > [data-id]')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (x0 === Infinity) return notify('Nothing to fit: the artboard is empty');
    const box = { x: (x0 - frame.left) / scale, y: (y0 - frame.top) / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale };
    const width = Math.max(1, Math.ceil(box.w + 2 * margin));
    const height = Math.max(1, Math.ceil(box.h + 2 * margin));
    // Shifts the drawing so its box ends up in the middle of the new canvas.
    const offset = [Math.round(width / 2 - (box.x + box.w / 2)), Math.round(height / 2 - (box.y + box.h / 2))];
    execute(artboardOps(state.doc, schema, width, height, offset), `artboard fit to content (${width} × ${height})`);
  }

  /**
   * Point binding: the bone the picked vertex follows, and spreading all of them among the nearby bones. That way a
   * single path bends with a chain of bones.
   */
  function pointBones(doc) {
    const path = findObject(doc, state.editing);
    // Only the bones of the path's skeleton.
    const skeleton = skeletonOf(doc, path.id);
    const bones = skeleton ? bonesOf(doc, skeleton) : [];
    if (!bones.length) return [];
    const vertices = read(schema, path, 'vertices');
    // The same plan as the AI's bind_points.
    const save = (bones, options, note) => {
      try {
        execute(planBindPoints(doc, schema, path.id, bones, options).ops, `${note} in ${path.id}`);
      } catch (e) {
        notify(e.message, true);
      }
    };
    const parts = [];
    if (state.vertex != null && vertices[state.vertex]) {
      const i = state.vertex;
      const label = Object.assign(document.createElement('label'), { className: 'text', textContent: `Point ${i} follows ` });
      const select = document.createElement('select');
      select.append(new Option(`(the shape’s${boneOf(doc, path.id) ? `: ${boneOf(doc, path.id)}` : ''})`, ''), ...bones.map((h) => new Option(h.id, h.id)));
      select.value = vertices[i].bone ?? '';
      select.addEventListener('change', () => save(select.value ? [select.value] : undefined, { points: [String(i)], release: !select.value }, `point ${i} ${select.value ? `to ${select.value}` : 'unbound'}`));
      label.append(select);
      parts.push(label);
    }
    parts.push(
      button('Distribute among bones', `Each point follows the nearest bone of ${skeleton}: the path bends with the chain in poses`, () => save(undefined, {}, 'distribute points among bones')),
    );
    if (vertices.some((v) => v.bone)) parts.push(button('Remove bones', 'Points go back to following the shape’s bone', () => save(undefined, { release: true }, 'unbind points')));
    return parts;
  }

  /** Switch: which variant is seen (in the setup) and how to add more. */
  function switchOptions(doc, sw) {
    const variants = doc.objects.filter((o) => o.parent === sw.id);
    if (!variants.length) {
      return [text(`Switch ${code(sw.id)} is empty: drag drawings into it in Layers, or draw with it selected. Each child is a variant, shown one at a time.`)];
    }
    const parts = [variantSelector(doc, sw), text(`${variants.length} variant${variants.length === 1 ? '' : 's'}: to add more, drag drawings into it or draw with the switch selected.`)];
    // Information only: which params choose the variant (through drivers to poses that set active).
    const params = switchParams(doc, sw.id);
    if (params.length) parts.push(text(`Chosen by parameter${params.length === 1 ? '' : 's'} ${params.map(code).join(', ')} (in Parameters, below).`));
    return parts;
  }

  /** «X shows [list]»: in a pose it changes the pose; otherwise, the setup. */
  function variantSelector(doc, sw) {
    const variants = doc.objects.filter((o) => o.parent === sw.id);
    const label = Object.assign(document.createElement('label'), { className: 'text', textContent: `${state.pose ? `In pose ${state.pose}, ` : ''}${sw.id} shows ` });
    const select = document.createElement('select');
    select.append(...variants.map((o) => new Option(o.id, o.id, false, o.id === variantOf(doc, sw))));
    select.title = 'Which variant is shown';
    select.addEventListener('change', () => chooseVariant(sw.id, select.value));
    label.append(select);
    return label;
  }

  /** Skeleton: how many bones it has, which part of the drawing does not follow any yet, and binding it all at once. */
  function skeletonOptions(doc, skeleton) {
    const bones = bonesOf(doc, skeleton.id);
    if (!bones.length) {
      return [
        text(`Skeleton ${code(skeleton.id)} has no bones yet: draw them with Add Bone, from the joint toward the tip. The drawing inside it stays still until it’s bound.`),
        button('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => setState({ tool: 'bone' }), 'main'),
      ];
    }
    const pending = bindingsByProximity(doc, schema, skeleton.id);
    const parts = [
      text(
        `Skeleton ${code(skeleton.id)}: ${bones.length} bone${bones.length === 1 ? '' : 's'}. ` +
          (pending.length ? pending.length === 1 ? '1 piece of its drawing doesn’t follow any bone yet (it stays still in poses).' : `${pending.length} pieces of its drawing don’t follow any bone yet (they stay still in poses).` : 'All its drawing follows a bone.'),
      ),
    ];
    if (pending.length) parts.push(button('Bind all by proximity', `Each unbound piece goes to its nearest bone: ${pending.map((e) => `${e.id} → ${e.bone}`).join(', ')}`, () => actions.bindAll(skeleton.id), 'main'));
    parts.push(button('＋ Bone', 'Add Bone: drag on the canvas to create a root bone in this skeleton (B)', () => setState({ tool: 'bone' })));
    parts.push(button('Manipulate', 'Manipulate Bones: rotate, move and resize its bones (M)', () => setState({ tool: 'manipulate' })));
    return parts;
  }

  /** «Parent: x · Children: a, b»: names that are clicked to go to that bone (or to the skeleton). */
  function kinship(doc, bone) {
    const box = Object.assign(document.createElement('span'), { className: 'text kinship' });
    const go = (id) => {
      const b = button(id, `Select ${id}`, () => select(id), 'bone-binding');
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
   * Reparent Bone, as in Blender: the children are picked and finally the parent (Shift + click), and a button makes
   * the change. Nothing changes just by clicking.
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
      const b = button(`Parent to ${plan.parent.id}`, alreadyThere ? 'They already hang from it' : `Make ${plan.parent.id} the parent of ${which}`, () => execute(plan.ops, `parent ${which} to ${plan.parent.id}`), 'main');
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

  /** How many points (of vector layers and paths) follow a bone. */
  const pointsFollowing = (doc, bone) => doc.objects.reduce((t, o) => t + bindablePoints(o).filter(([, v]) => v.bone === bone).length, 0);

  /** Reparent Bone, Bind Layer and Bind Points: what to do depending on whether there is a picked bone. */
  function bindingOptions(doc, bone) {
    const h = bone && code(bone.id);
    const skeleton = bone && skeletonOf(doc, bone.id);
    if (state.tool === 'reparent') return reparentOptions(doc, bone);
    if (state.tool === 'bindLayer') {
      if (!bone) return [text('Bind Layer: click a bone, then click the drawing that should follow it whole (or its row in Layers). Click again to unbind; Alt + click picks its group.')];
      const n = doc.objects.filter((o) => o.bone === bone.id).length;
      const parts = [text(`Bind Layer → ${h}: click drawing of ${code(skeleton)} (or its row in Layers) to bind or unbind it; Alt + click picks its group. ${n} bound.`)];
      if (bindingsByProximity(doc, schema, skeleton).length) parts.push(button('Bind all by proximity', `Bind every unbound drawing of ${skeleton} to its nearest bone`, () => actions.bindAll(skeleton)));
      return parts;
    }
    return bindPointsOptions(doc, bone);
  }

  /** Bind Points: which layer, how many points are picked, and the buttons that bind or release them. */
  function bindPointsOptions(doc, bone) {
    const layer = bindLayer(doc);
    if (!layer) return [text('Bind Points: pick the vector layer whose points you bind (in Layers, or click its drawing).')];
    const picked = state.bindPicked.length;
    const to = bone ? ` → <b style="color:${boneColor(doc, bone.id)}">${bone.id}</b>` : '';
    const step = !picked ? 'click points (Shift adds), or drag a box (Shift adds, Alt removes).' : bone ? `${picked} picked: press Space or Bind.` : `${picked} picked: now click the bone they should follow, then Space.`;
    const parts = [text(`Bind Points in ${code(layer.id)}${to}: ${step} White points follow the layer.`)];
    if (picked && bone) parts.push(button(`Bind ${picked}`, `The ${picked} picked point${picked === 1 ? '' : 's'} follow ${bone.id} (Space)`, () => bindPicked(bone.id), 'main'));
    if (picked && state.bindPicked.some((k) => new Map(bindablePoints(layer)).get(k)?.bone)) parts.push(button('Unbind', 'The picked points go back to following the layer', () => bindPicked(null)));
    parts.push(button('All', `Pick every point of ${layer.id}`, () => setState({ bindPicked: bindablePoints(layer).map(([k]) => k) })));
    return parts;
  }

  function boneOptions(doc, bone) {
    const bound = doc.objects.filter((o) => o.bone === bone.id);
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const points = pointsFollowing(doc, bone.id);
    const moved = [bound.length && `${bound.length} object${bound.length === 1 ? '' : 's'}`, points && `${points} point${points === 1 ? '' : 's'}`].filter(Boolean);
    const binding = moved.length ? `It moves ${moved.join(' and ')}, only in poses.` : 'Nothing is bound to it yet.';
    const summary =
      state.tool === 'bone'
        ? `Add Bone: drag from the tip of ${code(bone.id)} to chain a child, or on empty space for another one. ${binding}`
        : state.tool === 'manipulate'
          ? `Manipulate, Setup: drag ${code(bone.id)} to rotate it; its origin dot moves it, its tip changes direction and length. ${binding}`
          : `Setup, bone ${code(bone.id)}. ${binding}`;
    const parts = [
      text(summary),
      kinship(doc, bone),
      button('Bind Layer', 'Bind Layer tool: click drawing to make it follow this bone (L)', () => setState({ tool: 'bindLayer' }), bound.length ? '' : 'main'),
      button('Bind Points', 'Bind Points tool: click or box points of a vector layer to make them follow this bone', () => setState({ tool: 'bindPoints' })),
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
        bound.length ? 'main' : '',
      ),
    );
    return parts;
  }
}
