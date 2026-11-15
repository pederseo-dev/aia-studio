// Puppet: the list of poses (on the right, below Parameters) and the banner above the canvas that says what is being
// edited. Poses are still snapshots of the puppet that the params blend; before they were picked in a «View» dropdown
// at the top, which looked like a view mode. See docs/decision-animacion.md §10.

import { askText } from './ask.js';
import { findObject } from '../core/document.js';
import { notify, execute, state, setState, subscribe } from './state.js';
import { toggleLive } from './live.js';

/** The params that move a pose (through their drivers). */
const poseParams = (doc, pose) => [...new Set(doc.objects.filter((d) => d.type === 'driver' && d.pose === pose && d.param).map((d) => d.param))];

/** Opens a pose to edit it (or closes it if it is already open): what is changed goes to the pose, not the setup. */
export function openPose(id) {
  if (state.live) return notify('Live is on: turn it off (■ Live) to edit a pose.', true);
  if (state.pose === id) return setState({ pose: null, params: state.params ?? {}, editing: null, vertex: null });
  setState({ pose: id, editing: null, vertex: null, playing: false });
}

export function mountPoses(root, list, newButton, deleteButton) {
  // 🗑 deletes the selected pose (in Assets) or else the open one. Its drivers are left without a pose (they move nothing).
  const chosen = () => {
    const doc = state.doc;
    if (!doc) return null;
    if (findObject(doc, state.selection)?.type === 'pose') return state.selection;
    return findObject(doc, state.pose)?.type === 'pose' ? state.pose : null;
  };
  deleteButton.addEventListener('click', () => {
    const id = chosen();
    if (!id) return;
    if (state.pose === id) setState({ pose: null, params: state.params ?? {}, editing: null, vertex: null });
    execute([{ op: 'delete', target: id }], `delete pose ${id}`);
  });
  subscribe((c) => {
    if ('doc' in c || 'selection' in c || 'pose' in c || 'live' in c) deleteButton.disabled = !chosen() || state.live;
  });
  newButton.addEventListener('click', async () => {
    if (!state.doc) return;
    const base = (await askText('Pose name (e.g. happy, eyes_closed, mouth_o):', ''))?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const id = /^[a-z]/.test(base) ? base : `pose_${base}`;
    if (findObject(state.doc, id)) return notify(`"${id}" already exists`, true);
    execute([{ op: 'create', type: 'pose', id }], `create pose ${id}`);
    openPose(id);
  });
  subscribe((c) => {
    if ('doc' in c || 'pose' in c || 'mode' in c || 'id' in c || 'live' in c) draw();
  });

  function draw() {
    const doc = state.doc;
    root.hidden = state.mode !== 'puppet' || !doc;
    newButton.disabled = state.live;
    if (root.hidden) return;
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (!poses.length) {
      list.innerHTML = '<p class="help">No poses yet. A pose is a still shape of the puppet (happy, eyes closed, mouth O…). Create one with + above, change it on the canvas, then blend it with a parameter.</p>';
      return;
    }
    list.replaceChildren(
      ...poses.map((pose) => {
        const open = state.pose === pose.id;
        const row = Object.assign(document.createElement('button'), { type: 'button', className: `pose-row${open ? ' open' : ''}`, disabled: state.live });
        const params = poseParams(doc, pose.id);
        row.innerHTML = '<b></b><small></small>';
        row.querySelector('b').textContent = pose.id;
        row.querySelector('small').textContent = params.length ? `← ${params.join(', ')}` : 'no parameter';
        const objects = Object.keys(pose.values ?? {});
        row.title = `${open ? 'Click to stop editing this pose' : 'Click to edit this pose'}. It sets: ${objects.join(', ') || 'nothing yet'}.${params.length ? ` Blended by: ${params.join(', ')}.` : ' No parameter blends it yet: connect one with + under a parameter.'}`;
        row.addEventListener('click', () => openPose(pose.id));
        return row;
      }),
    );
  }
}

/**
 * Banner above the canvas (Puppet only): what is being edited or viewed, in the frame color, with the button to
 * leave. It replaces the «View» dropdown.
 */
export function mountBanner(el) {
  subscribe((c) => {
    if ('doc' in c || 'pose' in c || 'params' in c || 'mode' in c || 'id' in c || 'live' in c || ('time' in c && !state.playing) || 'playing' in c) draw();
  });

  function draw() {
    const doc = state.doc;
    el.hidden = state.mode !== 'puppet' || !doc;
    if (el.hidden) return;
    const open = state.pose && findObject(doc, state.pose);
    let className;
    let text;
    /** @type {[string, string, () => void] | null} */
    let button;
    if (state.live) {
      [className, text] = ['live', '<b>● Live</b>: the puppet as the app sees it. Nothing is saved.'];
      button = ['■ Stop Live', 'Turn Live off and go back to editing', toggleLive];
    } else if (open?.type === 'animation') {
      [className, text] = ['clip', `Editing clip <b></b> at ${+state.time.toFixed(2)} s: every change is a keyframe at the playhead.`];
      button = ['Close clip', 'Back to the parameter preview', () => setState({ pose: null, params: state.params ?? {}, editing: null, vertex: null, playing: false })];
    } else if (open?.type === 'pose') {
      [className, text] = ['pose', 'Editing pose <b></b>: what you change goes into the pose, not the setup.'];
      button = ['Done', 'Stop editing the pose and go back to the parameter preview', () => openPose(open.id)];
    } else {
      [className, text] = ['params', 'Previewing <b>parameters</b>: the canvas shows the poses they blend. To change a pose, open it under Poses.'];
      button = null; // Reset is in the Puppet bar, above Clips
    }
    el.className = `banner-${className}`;
    el.innerHTML = `<span>${text}</span>`;
    if (className === 'clip' || className === 'pose') el.querySelector('span b').textContent = open.id;
    if (!button) return;
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: button[0], title: button[1] });
    b.addEventListener('click', button[2]);
    el.append(b);
  }
}
