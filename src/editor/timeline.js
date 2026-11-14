// Editor modes (Design · Animate · Puppet), the bottom timeline and the Puppet clip library. See
// docs/decision-animacion.md.
//
// An open clip is edited like a pose (state.pose = clip id): what is changed on the canvas or in the inspector
// becomes a keyframe at the playhead time (autokey, see poseOps in editing.js).

import { askText } from './ask.js';
import { ICONS, TYPE_ICON, CHANNEL_ICON } from './icons.js';
import { clipWarnings, scaleTime, isScene, moveKey, putKey, removeKey, roundTime, localTime, keyTimes, valueToSave, setupValues } from '../core/animation.js';
import { CURVE_NAMES, applyCurve, curveError, sameTime } from '../core/curves.js';
import { findObject, subtree } from '../core/document.js';
import { read, readMeta } from '../core/schema.js';
import { effectiveValue } from '../core/styles.js';
import { notify, execute, schema, state, setState, preview, select, selectSeveral, subscribe } from './state.js';
import { openedClip, activePose } from './editing.js';
import { toggleLive, triggerClip, showManifest, stopAll } from './live.js';

const MODES = {
  design: 'Design: draw and rig the character (the setup).',
  animate: 'Animate: a scene timeline, to export as video, Lottie or SVG.',
  puppet: 'Puppet: the controls an app or its AI uses live (parameters, poses and clips).',
};

const n = (t) => +t.toFixed(3);
const fromId = (text, prefix) => {
  const base = text?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return base ? (/^[a-z]/.test(base) ? base : `${prefix}_${base}`) : null;
};

/** Creates a new clip (asks for the name) and opens it. */
async function newClip(usage) {
  if (!state.doc) return;
  const id = fromId(await askText(usage === 'puppet' ? 'Clip name (e.g. wave, blink, idle):' : 'Scene name (e.g. intro, scene_1):', ''), 'clip');
  if (!id) return;
  if (findObject(state.doc, id)) return notify(`"${id}" already exists`, true);
  execute([{ op: 'create', type: 'animation', id, props: { usage, duration: usage === 'puppet' ? 1 : 5 } }], `create ${usage === 'puppet' ? 'clip' : 'scene'} ${id}`);
  openClip(id);
}

function openClip(id) {
  stop();
  setState({ pose: id, time: 0, editing: null, vertex: null });
}

// ---------- Playback ----------

let frame = null;
function startPlayback() {
  const clip = openedClip();
  if (!clip) return;
  const duration = read(schema, clip, 'duration');
  const from = state.time >= duration - 1e-6 && read(schema, clip, 'loop') === 'once' ? 0 : state.time;
  const start = performance.now();
  setState({ playing: true });
  const step = (now) => {
    const c = openedClip();
    if (!c || !state.playing) return stop();
    const t = from + (now - start) / 1000;
    if (read(schema, c, 'loop') === 'once' && t >= read(schema, c, 'duration')) {
      setState({ time: read(schema, c, 'duration') });
      return stop();
    }
    setState({ time: localTime(schema, c, t) });
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
function stop() {
  cancelAnimationFrame(frame);
  if (state.playing) setState({ playing: false });
}

/** Space (a tap, without panning): play or pause the open scene or clip. */
export function togglePlayback() {
  // With Live on, the puppet plays by itself (and there is no play button).
  if (state.mode === 'design' || state.live || !openedClip()) return;
  if (state.playing) stop();
  else startPlayback();
}

// ---------- Modes ----------

export function mountModes(buttons) {
  for (const b of buttons.querySelectorAll('[data-mode]')) {
    b.title = MODES[b.dataset.mode];
    b.addEventListener('click', () => changeMode(b.dataset.mode, { createScene: true }));
  }
  subscribe((c) => {
    if (!('mode' in c) && !('id' in c)) return;
    document.body.dataset.mode = state.mode;
    for (const b of buttons.querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === state.mode));
  });
  document.body.dataset.mode = state.mode;
}

/**
 * `createScene`: only when the user clicks Animate. Opening or switching documents while in Animate must not write
 * into them (a Puppet-only avatar, a document the AI is building).
 */
export function changeMode(mode, { createScene = false } = {}) {
  stop();
  const doc = state.doc;
  if (mode === 'design') return setState({ mode, pose: null, params: null, editing: null, vertex: null });
  if (mode === 'animate') {
    // The first scene is opened. Like Rive's "Timeline 1", clicking Animate in a document without scenes creates one,
    // so you can animate straight away; more scenes are made with + on the timeline.
    let id = doc?.objects.find((o) => o.type === 'animation' && read(schema, o, 'usage') === 'animate')?.id ?? null;
    if (createScene && doc && !id && !state.live) {
      let n = 1;
      while (findObject(doc, `scene_${n}`)) n++;
      const created = `scene_${n}`;
      execute([{ op: 'create', type: 'animation', id: created, props: { usage: 'animate', duration: 5 } }], `create scene ${created}`);
      if (findObject(state.doc, created)) id = created;
    }
    return setState({ mode, pose: id, params: null, time: 0, editing: null, vertex: null });
  }
  // Puppet: the blend of the params is seen; clips are opened from the library on the right.
  setState({ mode, pose: null, params: state.params ?? {}, time: 0, editing: null, vertex: null });
}

// ---------- Clip library (Puppet) ----------

/** How a clip plays live, in a few words: «base», «gesture», «auto: every 2–6 s», «auto: always». */
function liveRole(clip) {
  const auto = read(schema, clip, 'auto');
  if (auto === 'repeat') return `auto · every ${n(read(schema, clip, 'repeat_min'))}–${n(read(schema, clip, 'repeat_max'))} s`;
  if (auto === 'always') return 'auto · always';
  return read(schema, clip, 'loop') === 'once' ? 'gesture' : 'base';
}

export function mountClips(root, list, newButton, liveButton, manifestButton, deleteButton) {
  // 🗑 deletes the selected Puppet clip (in Assets) or, otherwise, the open one.
  const chosen = () => {
    const doc = state.doc;
    if (!doc) return null;
    const isClip = (id) => findObject(doc, id)?.type === 'animation' && read(schema, findObject(doc, id), 'usage') === 'puppet';
    if (isClip(state.selection)) return state.selection;
    return isClip(state.pose) ? state.pose : null;
  };
  deleteButton.addEventListener('click', () => {
    const id = chosen();
    if (!id) return;
    if (state.pose === id) {
      stop();
      setState({ pose: null, params: state.params ?? {}, editing: null, vertex: null });
    }
    execute([{ op: 'delete', target: id }], `delete clip ${id}`);
  });
  subscribe((c) => {
    if ('doc' in c || 'selection' in c || 'pose' in c || 'live' in c) deleteButton.disabled = !chosen() || state.live;
  });
  newButton.addEventListener('click', () => newClip('puppet'));
  manifestButton.addEventListener('click', showManifest);
  liveButton.addEventListener('click', () => {
    stop();
    toggleLive();
  });
  subscribe((c) => {
    if ('doc' in c || 'pose' in c || 'mode' in c || 'id' in c || 'playing' in c || 'live' in c) draw();
    else if ('liveState' in c) updateLive();
  });

  function draw() {
    const doc = state.doc;
    root.hidden = state.mode !== 'puppet' || !doc;
    root.classList.toggle('in-live', state.live);
    liveButton.textContent = state.live ? '■ Live' : '▶ Live';
    liveButton.setAttribute('aria-pressed', String(state.live));
    liveButton.title = state.live
      ? 'Stop Live and go back to editing'
      : 'Live: play the puppet as the app will. Clip buttons trigger clips (with fades), Parameters are the app’s values, and nothing is saved.';
    newButton.disabled = state.live;
    if (root.hidden) return;
    const clips = doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet');
    if (!clips.length) {
      list.innerHTML = '<p class="help">No clips yet. A clip is a short animation the app or its AI triggers (wave, blink, idle). Create one with + above.</p>';
      return;
    }
    list.replaceChildren(...clips.map((clip) => (state.live ? liveRow(clip) : rowToEdit(clip))));
    if (state.live) updateLive();
  }

  function rowToEdit(clip) {
    const open = state.pose === clip.id;
    const row = document.createElement('div');
    row.className = `clip${open ? ' open' : ''}`;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'name' });
    const description = read(schema, clip, 'description');
    button.innerHTML = `<b></b><small></small>`;
    button.querySelector('b').textContent = clip.id;
    button.querySelector('small').textContent = `${n(read(schema, clip, 'duration'))} s · ${read(schema, clip, 'loop')}`;
    button.title = `${description ? `${description}\n` : ''}${liveRole(clip)}. Click to edit it in the timeline`;
    button.addEventListener('click', () => (open ? setState({ pose: null, params: state.params ?? {} }) : openClip(clip.id)));
    const play = Object.assign(document.createElement('button'), { type: 'button', className: 'play', textContent: open && state.playing ? '■' : '▶' });
    play.title = open && state.playing ? 'Stop' : 'Play the clip';
    play.addEventListener('click', () => {
      if (open && state.playing) return stop();
      if (!open) openClip(clip.id);
      startPlayback();
    });
    row.append(button, play);
    return row;
  }

  /** With Live: the button triggers the clip (auto ones play on their own); ■ takes it out. The lower bar is its weight. */
  function liveRow(clip) {
    const auto = read(schema, clip, 'auto') !== 'off';
    const row = document.createElement('div');
    row.className = `clip live${auto ? ' auto' : ''}`;
    row.dataset.clip = clip.id;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'name', disabled: auto });
    const description = read(schema, clip, 'description');
    button.innerHTML = `<b></b><small></small><span class="weight"></span>`;
    button.querySelector('b').textContent = clip.id;
    button.querySelector('small').textContent = liveRole(clip);
    button.title = `${description ? `${description}\n` : ''}${auto ? 'Plays by itself (auto)' : read(schema, clip, 'loop') === 'once' ? 'Click: play this gesture on top of the base' : 'Click: make this the base (crossfade)'}`;
    button.addEventListener('click', () => triggerClip(clip.id));
    const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'play', textContent: '■', title: 'Fade this clip out', disabled: true });
    stop.addEventListener('click', () => triggerClip(clip.id, { stop: true }));
    if (auto) stop.hidden = true;
    row.append(button, stop);
    return row;
  }

  /** Every frame: the weight of each playing clip, without rebuilding the buttons (so a click is not lost midway). */
  function updateLive() {
    const playing = state.liveState?.playing ?? [];
    for (const row of list.querySelectorAll('.clip.live')) {
      const s = playing.filter((x) => x.clip === row.dataset.clip);
      const weight = Math.max(0, ...s.map((x) => x.weight));
      row.style.setProperty('--weight', `${Math.round(weight * 100)}%`);
      row.classList.toggle('playing', weight > 0);
      const stop = row.querySelector('.play');
      stop.disabled = !s.some((x) => !x.leaving && x.layer !== 'auto');
    }
  }
}

// ---------- Timeline ----------

export function mountTimeline(root) {
  // Picked keyframe: { id, prop, t } (editor only).
  let chosen = null;
  // Timeline groups opened or closed by hand (id → true/false); if untouched, only the main one is open.
  const folded = new Map();
  // «Scale keys» when changing Length: remembered while the editor is open.
  let scaleKeys = false;
  root.tabIndex = -1;

  subscribe((c) => {
    if ('live' in c) return draw();
    // With Live, each frame only rebuilds the rows (the «Stop all» button is not rebuilt, so a click is not lost midway).
    if (state.live) return 'liveState' in c || 'doc' in c ? liveRows() : undefined;
    if ('doc' in c || 'previewDoc' in c || 'pose' in c || 'mode' in c || 'id' in c || 'selection' in c || 'playing' in c) draw();
    else if ('time' in c) movePlayhead();
  });

  const clipVisible = () => openedClip(state.previewDoc ?? state.doc);
  const fps = () => readMeta(schema, state.doc, 'fps');
  const adjustToFrame = (t) => roundTime(Math.round(t * fps()) / fps());

  function draw() {
    const doc = state.doc;
    if (!doc) return root.replaceChildren();
    if (state.live) return root.replaceChildren(live(doc));
    const clip = clipVisible();
    if (chosen && !keysIn(clip, chosen.id, chosen.props, chosen.t).length) chosen = null;
    root.replaceChildren(bar(doc, clip), clip ? tracks(clip) : empty());
    movePlayhead();
  }

  /**
   * With Live on, the timeline shows what is playing: one row per clip (base, gestures, auto) with its weight (the bar)
   * and where it is at (the mark). It is rebuilt on every frame; it has nothing that can be touched.
   */
  function live(doc) {
    const box = document.createElement('div');
    box.className = 'live-time';
    const title = document.createElement('p');
    title.className = 'help';
    title.textContent = 'Live: what the app sees. Click clips on the right to play them, move Parameters, ■ Live to edit again.';
    const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'stop-all', textContent: '■ Stop all', title: 'Fade out everything the app played (auto clips keep playing), like stop() in the app' });
    stop.addEventListener('click', stopAll);
    const head = document.createElement('div');
    head.className = 'live-head';
    head.append(title, stop);
    const rows = document.createElement('div');
    rows.className = 'live-rows';
    box.append(head, rows);
    queueMicrotask(liveRows);
    return box;
  }

  /** The rows of what is playing (Live), in their place; and whether there is something to stop. */
  function liveRows() {
    const doc = state.doc;
    const box = root.querySelector('.live-rows');
    if (!box || !doc) return;
    box.replaceChildren();
    const playing = state.liveState?.playing ?? [];
    const stop = root.querySelector('.stop-all');
    if (stop) stop.disabled = !playing.some((s) => s.layer !== 'auto' && !s.leaving);
    const names = { base: 'base', gesture: 'gesture', auto: 'auto' };
    for (const s of playing) {
      const clip = findObject(doc, s.clip);
      if (!clip) continue;
      const d = read(schema, clip, 'duration');
      const progress = Math.min(1, localTime(schema, clip, s.t) / d);
      const row = document.createElement('div');
      row.className = `live-row layer${s.layer}${s.leaving ? ' leaving' : ''}`;
      row.innerHTML = '<span class="name"></span><span class="layer"></span><span class="bar"><span class="filled"></span><span class="progress"></span></span><span class="value"></span>';
      row.querySelector('.name').textContent = s.clip;
      row.querySelector('.layer').textContent = `${names[s.layer]}${s.leaving ? ' · out' : ''}`;
      (/** @type {HTMLElement} */ (row.querySelector('.filled'))).style.width = `${Math.round(s.weight * 100)}%`;
      (/** @type {HTMLElement} */ (row.querySelector('.progress'))).style.left = `${progress * 100}%`;
      row.querySelector('.value').textContent = `${Math.round(s.weight * 100)}%`;
      row.title = `${s.clip}: weight ${Math.round(s.weight * 100)}%, at ${n(localTime(schema, clip, s.t))} of ${n(d)} s`;
      box.append(row);
    }
    if (!playing.length) {
      const p = document.createElement('p');
      p.className = 'help';
      p.textContent = 'Nothing is playing: the setup with the parameters. Click a base clip (loop) to start.';
      box.append(p);
    }
  }

  function empty() {
    const p = document.createElement('p');
    p.className = 'help';
    p.innerHTML =
      state.mode === 'animate'
        ? 'No scene yet. Create one with + (above): then move the playhead and change things on the canvas or in the inspector — each change is keyed at the playhead.'
        : 'Pick a clip on the right (or create one with + above) to edit its keyframes here.';
    return p;
  }

  /**
   * At the top, tabs like the documents' ones: in Animate, one per scene (× deletes it, it can be undone); in
   * Puppet, the open clip (× closes it). The + creates a scene or a clip.
   */
  function tabs(doc, clip) {
    const row = document.createElement('div');
    row.className = 'time-tabs';
    row.setAttribute('role', 'tablist');
    const animate = state.mode === 'animate';
    const list = animate ? doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'animate') : clip ? [clip] : [];
    for (const c of list) {
      const active = c.id === clip?.id;
      const p = document.createElement('div');
      p.className = `tab${active ? ' active' : ''}`;
      p.setAttribute('role', 'tab');
      p.setAttribute('aria-selected', String(active));
      p.title = read(schema, c, 'description') || c.id;
      const closeTitle = animate ? 'Delete this scene (undo brings it back)' : 'Close the clip';
      p.innerHTML = `<span class="title"></span><button type="button" class="close" title="${closeTitle}">×</button>`;
      p.querySelector('.title').textContent = c.id;
      p.addEventListener('click', (e) => {
        if (!(/** @type {Element} */ (e.target)).closest('.close')) return active || openClip(c.id);
        if (!animate) return closeClip();
        if (!confirm(`Delete scene "${c.id}" and all its keyframes?`)) return;
        stop();
        const other = list.find((o) => o.id !== c.id);
        execute([{ op: 'delete', target: c.id }], `delete scene ${c.id}`);
        if (active) setState({ pose: other?.id ?? null, time: 0 });
      });
      row.append(p);
    }
    const created = Object.assign(document.createElement('button'), { type: 'button', className: 'tab-new', title: animate ? 'New scene' : 'New clip', innerHTML: ICONS.add });
    created.setAttribute('aria-label', created.title);
    created.addEventListener('click', () => newClip(animate ? 'animate' : 'puppet'));
    row.append(created);
    return row;
  }

  function closeClip() {
    stop();
    setState({ pose: null, params: state.params ?? {} });
  }

  /** « and »: the previous or next keyframe of the clip (or the start and the end, if there are no more). */
  function skip(clip, direction) {
    stop();
    const times = keyTimes(clip).filter((t) => !sameTime(t, state.time) && (direction < 0 ? t < state.time : t > state.time));
    const t = direction < 0 ? (times.at(-1) ?? 0) : (times[0] ?? read(schema, clip, 'duration'));
    setState({ time: t });
  }

  function bar(doc, clip) {
    const container = document.createElement('div');
    container.className = 'time-head';
    container.append(tabs(doc, clip));
    if (!clip) return container;
    const row = document.createElement('div');
    row.className = 'time-bar';
    const left = document.createElement('div');
    left.className = 'zone left';
    const center = document.createElement('div');
    center.className = 'zone center';
    const div = document.createElement('div');
    div.className = 'zone right';
    row.append(left, center, div);
    container.append(row);

    const duration = read(schema, clip, 'duration');
    center.append(
      button('«', 'Previous keyframe (or the start)', () => skip(clip, -1)),
      button(state.playing ? '⏸' : '▶', state.playing ? 'Pause' : 'Play', () => (state.playing ? stop() : startPlayback()), 'play'),
      button('»', 'Next keyframe (or the end)', () => skip(clip, 1)),
    );
    left.append(Object.assign(document.createElement('span'), { className: 'clock' }));

    const durationField = Object.assign(document.createElement('input'), { type: 'number', min: 0.05, step: 0.1, value: n(duration), title: 'Duration in seconds' });
    durationField.addEventListener('change', () => {
      const v = Number(durationField.value);
      if (!(v > 0)) return draw();
      // With «Scale keys», keyframes are stretched or compressed proportionally (the same as the MCP's scale_time).
      if (scaleKeys && keyTimes(clip).length) {
        let scaled;
        try {
          scaled = scaleTime(clip.tracks, duration, { length: v });
        } catch (error) {
          notify(error.message, true);
          return draw();
        }
        execute([{ op: 'set', target: clip.id, props: { tracks: scaled.tracks, duration: scaled.duration } }], `scale time of ${clip.id}: ${n(duration)} → ${n(v)} s`);
        setState({ time: roundTime(Math.min(v, (state.time * v) / duration)) });
        return;
      }
      const last = Math.max(0, ...Object.values(clip.tracks ?? {}).flatMap((c) => Object.values(c).flatMap((k) => k.map((x) => x.t))));
      if (v < last) {
        notify(`There are keyframes up to ${n(last)} s: tick Scale keys to squeeze them into ${n(v)} s, or move or delete them first`, true);
        return draw();
      }
      execute([{ op: 'set', target: clip.id, props: { duration: v } }], `${clip.id} duration ${v} s`);
      if (state.time > v) setState({ time: v });
    });
    const durationLabel = Object.assign(document.createElement('label'), { className: 'short-field', textContent: 'Length' });
    durationLabel.append(durationField, document.createTextNode('s'));
    const scale = Object.assign(document.createElement('input'), { type: 'checkbox', checked: scaleKeys });
    scale.addEventListener('change', () => (scaleKeys = scale.checked));
    const scaleLabel = Object.assign(document.createElement('label'), { className: 'short-field', title: 'When on, changing Length stretches or squeezes every keyframe in proportion (one undo step)' });
    scaleLabel.append(scale, document.createTextNode('Scale keys'));

    const loop = document.createElement('select');
    loop.title = 'once: plays once and holds the end · loop: starts over · pingpong: back and forth';
    for (const v of ['once', 'loop', 'pingpong']) loop.append(new Option(v, v, false, v === read(schema, clip, 'loop')));
    loop.addEventListener('change', () => execute([{ op: 'set', target: clip.id, props: { loop: loop.value } }], `${clip.id} loop ${loop.value}`));

    left.append(durationLabel, scaleLabel, loop);
    div.append(button('◆ Key', 'Key the selected object at the playhead: its animated properties (or, if it has none, its rotation and position)', () => pinSelection(clip)));

    // A whole pose as keyframes at the playhead, and back to the setup (the same as pose and setup in set_keys).
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (poses.length) {
      const withPose = document.createElement('select');
      withPose.title = 'Key the values of a pose at the playhead: all of it, or only what is selected (like pose with only in set_keys)';
      withPose.append(new Option('◆ Pose…', ''), ...poses.map((p) => new Option(p.id, p.id)));
      // The selection and what hangs from it (a group or a skeleton counts for its parts).
      const chosen = new Set(state.selected.flatMap((id) => subtree(state.doc, id)));
      const partial = poses.filter((p) => Object.keys(p.values ?? {}).some((id) => chosen.has(id)));
      if (partial.length) {
        const group = Object.assign(document.createElement('optgroup'), { label: 'Only the selection' });
        group.append(...partial.map((p) => new Option(`${p.id} (selection)`, `sel:${p.id}`)));
        withPose.append(group);
      }
      withPose.addEventListener('change', () => {
        if (!withPose.value) return;
        const selectionOnly = withPose.value.startsWith('sel:');
        const id = withPose.value.replace(/^sel:/, '');
        const values = structuredClone(findObject(state.doc, id).values ?? {});
        if (selectionOnly) for (const object of Object.keys(values)) if (!chosen.has(object)) delete values[object];
        pinValues(clip, values, selectionOnly ? `pose ${id} (only ${Object.keys(values).join(', ')})` : `pose ${id}`, false);
      });
      div.append(withPose);
    }
    const setupHelp = isScene(schema, clip)
      ? 'Key the setup values (the rest pose) of everything this scene animates at the playhead'
      : 'Key the setup values (the rest pose) of everything this clip animates at the playhead, and its parameters at their initial value';
    div.append(button('◆ Setup', setupHelp, () => {
      const values = setupValues(state.doc, schema, clip.tracks);
      if (!Object.keys(values).length) return notify('This clip animates nothing yet: key something first', true);
      pinValues(clip, values, 'setup', false);
    }));

    // Drivers that add on top of the clip's tracks (the same that set_keys and render_preview warn the AI about).
    const warnings = clipWarnings(doc, schema, clip, state.params ?? {});
    if (warnings.length) div.append(Object.assign(document.createElement('span'), { className: 'notice-drivers', textContent: `⚠ ${warnings.length} driver${warnings.length > 1 ? 's' : ''} add on top`, title: warnings.join('\n') }));

    // Curve and delete of the picked keyframe (in every property of its channel that has a keyframe there).
    if (chosen) {
      const keys = keysIn(clip, chosen.id, chosen.props, chosen.t);
      const curves = [...new Set(keys.map(([, c]) => JSON.stringify(c.ease ?? 'linear')))];
      const first = keys[0][1].ease;
      const curve = document.createElement('select');
      curve.title = 'Ease of the segment that leaves this keyframe';
      const current = curves.length > 1 ? 'mixed' : Array.isArray(first) ? 'custom' : (first ?? 'linear');
      if (current === 'mixed') curve.append(new Option('(mixed)', 'mixed', false, true));
      for (const v of CURVE_NAMES) curve.append(new Option(v, v, false, v === current));
      if (current === 'custom') curve.append(new Option(`cubic-bezier(${first.join(', ')})`, 'custom', false, true));
      curve.append(new Option('cubic-bezier…', 'edit'));
      curve.addEventListener('change', async () => {
        /** @type {any} */
        let ease = curve.value;
        if (ease === 'custom' || ease === 'mixed') return;
        if (ease === 'edit') {
          // As in CSS: x1, y1, x2, y2 (x between 0 and 1; y can overshoot for a bounce).
          const previewDoc = Array.isArray(first) ? first.join(', ') : '0.3, 1.6, 0.6, 1';
          const text = await askText('cubic-bezier x1, y1, x2, y2 (as in CSS; y outside 0…1 overshoots):', previewDoc);
          if (text == null) return draw();
          ease = text.split(/[\s,]+/).filter(Boolean).map(Number);
          const error = curveError(ease);
          if (error) {
            notify(error, true);
            return draw();
          }
        }
        let tracks = clip.tracks;
        for (const [prop, c] of keys) tracks = putKey(tracks, chosen.id, prop, c.t, c.value, ease);
        execute([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: ease ${Array.isArray(ease) ? `cubic-bezier(${ease.join(', ')})` : ease} at ${n(chosen.t)} s`);
      });
      const label = Object.assign(document.createElement('label'), { className: 'short-field', textContent: `${chosen.id} ${chosen.channel} @ ${n(chosen.t)} s` });
      label.append(curve);
      if (current !== 'mixed') label.append(curveShape(first ?? 'linear'));
      div.append(label, button('Delete key', 'Delete this keyframe (Del)', () => deleteChosen(clip)));
    }
    if (state.mode === 'puppet') {
      const description = Object.assign(document.createElement('input'), { type: 'text', className: 'description', value: read(schema, clip, 'description'), placeholder: 'What it does (for the app’s AI)' });
      description.addEventListener('change', () => execute([{ op: 'set', target: clip.id, props: { description: description.value } }], `${clip.id} description`));
      left.append(description);
    }
    return container;
  }

  function button(text, title, action, className = '') {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title: title, className: className });
    b.addEventListener('click', action);
    return b;
  }

  /** ◆ Key: the selected objects at the playhead time, each with what has a track or, if none, rotation and position. */
  function pinSelection(clip) {
    const objs = chosenObjects().filter((o) => o.type !== 'param');
    if (!objs.length) return notify('Select objects or bones to key them', true);
    const pose = activePose();
    const values = {};
    for (const obj of objs) {
      const props = schema.types.get(obj.type).properties;
      let keys = Object.keys(clip.tracks?.[obj.id] ?? {});
      if (!keys.length) keys = (obj.type === 'bone' ? ['rotation'] : ['x', 'y', 'rotation']).filter((k) => props[k]?.animatable);
      if (keys.length) values[obj.id] = Object.fromEntries(keys.map((k) => [k, pose?.values?.[obj.id]?.[k] ?? effectiveValue(schema, state.doc, obj, k)]));
    }
    const ids = Object.keys(values);
    if (!ids.length) return notify(`${objs.map((o) => o.id).join(', ')}: nothing to key here; change a value in the inspector to key it`, true);
    pinValues(clip, values, ids.length === 1 ? ids[0] : `${ids.length} objects`);
  }

  /** The selection that has channels (objects, bones and params; not assets), in the order it was picked. */
  function chosenObjects() {
    // Params belong to Puppet: in a scene they have no channel (they may have stayed selected when coming from Puppet).
    const params = !isScene(schema, clipVisible());
    return state.selected.map((id) => findObject(state.doc, id)).filter((o) => o && (o.type === 'param' ? params : !schema.types.get(o.type)?.resource));
  }

  /** Open or closed: what the user chose or, if untouched, only the main one (or the only one) open. */
  function openGroup(id, howMany) {
    return folded.has(id) ? folded.get(id) : howMany === 1 || id === state.selection;
  }

  /**
   * Keyframes at the playhead with these values ({ object: { property: value } }; a param, { value }). With `seen`,
   * they are what is seen and what the drivers add is subtracted; those of a pose or of the setup are saved as is.
   */
  function pinValues(clip, values, what, seen = true) {
    const params = state.params ?? {};
    let tracks = clip.tracks ?? {};
    for (const [id, fields] of Object.entries(values)) {
      for (const [k, v] of Object.entries(fields)) tracks = putKey(tracks, id, k, state.time, seen ? valueToSave(state.doc, schema, clip, state.time, params, id, k, v) : v);
    }
    execute([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: key ${what} at ${n(state.time)} s`);
  }

  /** Deletes a whole channel (all the keyframes of its properties). */
  function deleteChannel(clip, id, channel) {
    const tracks = structuredClone(clip.tracks ?? {});
    for (const prop of channel.props) delete tracks[id]?.[prop];
    if (tracks[id] && !Object.keys(tracks[id]).length) delete tracks[id];
    execute([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete ${id} ${channel.name} track`);
  }

  function deleteChosen(clip) {
    if (!chosen) return;
    let tracks = clip.tracks;
    for (const prop of chosen.props) tracks = removeKey(tracks, chosen.id, prop, chosen.t);
    execute([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete key ${chosen.id} ${chosen.channel} at ${n(chosen.t)} s`);
    chosen = null;
  }

  // Del deletes the picked keyframe while focus is on the timeline (without reaching the delete-objects shortcut).
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select')) return;
    const clip = openedClip();
    if ((e.key === 'Delete' || e.key === 'Backspace') && chosen && clip) {
      e.stopPropagation();
      deleteChosen(clip);
    }
  });

  /**
   * The ruler, a row with all the clip's keyframes and, as in Moho, the channels of the selection: the basic ones
   * (also without keyframes yet: ◇ keys them at the playhead) and any other that has keyframes.
   */
  function tracks(clip) {
    const duration = read(schema, clip, 'duration');
    const body = document.createElement('div');
    body.className = 'tracks';
    const left = (t) => `${(t / duration) * 100}%`;

    const rule = document.createElement('div');
    rule.className = 'track-row ruler';
    const lane = document.createElement('div');
    lane.className = 'lane';
    const markStep = duration > 20 ? 5 : duration > 8 ? 2 : duration > 3 ? 1 : duration > 1 ? 0.5 : 0.25;
    for (let t = 0; t <= duration + 1e-9; t += markStep) {
      const mark = Object.assign(document.createElement('span'), { className: 'mark', textContent: `${n(t)}s` });
      mark.style.left = left(t);
      lane.append(mark);
    }
    rule.append(Object.assign(document.createElement('span'), { className: 'label' }), lane);
    body.append(rule);

    // All the clip's keyframes, in gray: to see the rhythm and where there is something (click = move the playhead there).
    const all = row('All keys', 'All keys: every keyframe of the clip, of any object. Click one to move the playhead there.', CHANNEL_ICON.allKeys);
    all.classList.add('summary');
    for (const t of keyTimes(clip)) {
      const diamond = Object.assign(document.createElement('span'), { className: 'key summary', title: `Keyframes at ${n(t)} s. Click to go there; drag to move the whole moment (every keyframe at ${n(t)} s).` });
      diamond.style.left = left(t);
      diamond.addEventListener('pointerdown', (e) => dragMoment(e, clip, null, t, all.lane));
      all.lane.append(diamond);
    }
    body.append(all);

    // As in Rive: one group per selected item (in Layers or on the canvas), collapsible; open, its channels as in Moho.
    const objs = chosenObjects().filter((o) => channelsOf(o).length);
    if (!objs.length) {
      // No selection: which objects the clip has animated, to go to them.
      const help = document.createElement('div');
      help.className = 'channels-help';
      const animated = Object.keys(clip.tracks ?? {}).filter((id) => findObject(state.doc, id));
      help.append(document.createTextNode(state.selection ? `${state.selection} has no animatable channels. ` : 'Select objects or bones (Ctrl + click in Layers adds more) to see their channels. '));
      if (animated.length) {
        help.append(document.createTextNode('Animated: '));
        for (const id of animated) help.append(button(id, `Select ${id}`, () => select(id), 'chip'));
      }
      body.append(help);
    }
    for (const obj of objs) {
      // The basic channels always; the rest only once they have keys (changing them in Animate keys them).
      const channels = channelsOf(obj).filter((c) => BASIC_CHANNELS.has(c.name) || c.props.some((p) => clip.tracks?.[obj.id]?.[p]?.length));
      const open = openGroup(obj.id, objs.length);
      // The object's row: ▸/▾ collapses, the name makes it the main one, and on the lane all its keyframes together.
      const head = row(obj.id, `${obj.id} (${obj.type}). Click to make it the main one.`, TYPE_ICON[obj.type]);
      head.classList.add('group');
      if (obj.id === state.selection) head.classList.add('main');
      const arrow = button(open ? '▾' : '▸', open ? `Collapse ${obj.id}` : `Expand ${obj.id} to see its channels`, () => {
        folded.set(obj.id, !open);
        draw();
      }, 'fold');
      head.label.prepend(arrow);
      const name = /** @type {HTMLElement} */ (head.label.querySelector('.track-name'));
      name.style.cursor = 'pointer';
      name.addEventListener('click', () => selectSeveral(state.selected, obj.id));
      const props = channels.flatMap((c) => c.props);
      for (const t of channelTimes(clip, obj.id, props)) {
        const diamond = Object.assign(document.createElement('span'), { className: 'key summary', title: `${obj.id}: keyframes at ${n(t)} s. Click to go there; drag to move all of ${obj.id}'s keyframes at ${n(t)} s.` });
        diamond.style.left = left(t);
        diamond.addEventListener('pointerdown', (e) => dragMoment(e, clip, obj.id, t, head.lane));
        head.lane.append(diamond);
      }
      body.append(head);
      if (open) for (const channel of channels) body.append(channelRow(clip, obj, channel, left));
    }

    closeTracks(body, duration);
    return body;
  }

  /** A channel row (Position, Rotation…) of an object: ◇/◆ to key it, × to delete it and its keyframes. */
  function channelRow(clip, obj, channel, left) {
    const withTrack = channel.props.some((p) => clip.tracks?.[obj.id]?.[p]?.length);
    let title = `${obj.id} · ${channel.name} (${channel.props.join(', ')})`;
    // A param moves all the poses of its drivers (also those not seen in the timeline): its tooltip says which.
    if (obj.type === 'param') {
      const poses = state.doc.objects.filter((o) => o.type === 'driver' && o.param === obj.id && findObject(state.doc, o.pose)?.type === 'pose');
      const detail = poses.map((d) => `${d.pose} (driver ${d.id}): ${Object.keys(findObject(state.doc, d.pose).values ?? {}).join(', ') || 'empty'}`).join('\n');
      title += poses.length ? `\nAnimating ${obj.id} moves these poses (they all add up):\n${detail}` : `\n${obj.id} has no driver: animating it moves nothing`;
    }
    const f = row(channel.name, title, CHANNEL_ICON[channel.name]);
    f.classList.add('channel');
    if (!withTrack) f.classList.add('empty');
    const pin = button(withTrack ? '◆' : '◇', `Key ${obj.id} ${channel.name} at the playhead`, () => pinChannel(clip, obj, channel), 'pin-channel');
    const remove = button('×', `Delete the whole ${channel.name} track of ${obj.id} (all its keyframes)`, () => deleteChannel(clip, obj.id, channel), 'remove-track');
    if (!withTrack) remove.hidden = true;
    f.label.append(pin, remove);
    for (const t of channelTimes(clip, obj.id, channel.props)) {
      const keys = keysIn(clip, obj.id, channel.props, t);
      const diamond = document.createElement('span');
      const isChosen = chosen && chosen.id === obj.id && chosen.channel === channel.name && sameTime(chosen.t, t);
      diamond.className = `key ${curveClass(keys)}${isChosen ? ' chosen' : ''}`;
      diamond.style.left = left(t);
      diamond.title = `${obj.id} ${channel.name} at ${n(t)} s: ${keys.map(([p, c]) => `${p} = ${summarize(c.value)}`).join(', ')} (${curveName(keys)}). Drag to move it in time.`;
      diamond.addEventListener('pointerdown', (e) => dragKey(e, clip, obj.id, channel, t, f.lane));
      f.lane.append(diamond);
    }
    return f;
  }

  /** The playhead and the click or drag on the ruler or on an empty lane to move it. */
  function closeTracks(body, duration) {
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    body.append(playhead);
    // Click or drag on the ruler or on an empty lane: move the playhead (snapping to frames).
    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.key, .label, .channels-help')) return;
      const zone = body.querySelector('.lane').getBoundingClientRect();
      const move = (ev) => setState({ time: Math.max(0, Math.min(duration, adjustToFrame(((ev.clientX - zone.left) / zone.width) * duration))) });
      stop();
      root.focus();
      move(e);
      body.setPointerCapture(e.pointerId);
      body.onpointermove = move;
      body.onpointerup = () => (body.onpointermove = body.onpointerup = null);
    });
    return body;
  }

  /** A timeline row: label on the left (an icon, as in Moho, with the name in the tooltip) and lane on the right. */
  function row(text, title, icon) {
    const div = document.createElement('div');
    div.className = 'track-row';
    const label = document.createElement('span');
    label.className = 'label';
    const name = Object.assign(document.createElement('span'), { className: 'track-name', title });
    if (icon) {
      name.innerHTML = icon;
      name.setAttribute('aria-label', text);
    } else name.textContent = text;
    label.append(name);
    const lane = document.createElement('div');
    lane.className = 'lane';
    div.append(label, lane);
    return Object.assign(div, { label, lane });
  }

  /** ◇/◆ of a channel: keys its properties at the playhead with what is seen (without the drivers' contribution). */
  function pinChannel(clip, obj, channel) {
    const pose = activePose();
    const values = Object.fromEntries(channel.props.map((k) => [k, obj.type === 'param' ? pose?.params?.[obj.id] : (pose?.values?.[obj.id]?.[k] ?? effectiveValue(schema, state.doc, obj, k))]));
    pinValues(clip, { [obj.id]: values }, `${obj.id} ${channel.name}`);
  }

  /** Click on a keyframe picks it (and moves the playhead there); dragging moves it in time, with its whole channel. */
  function dragKey(e, clip, id, channel, t0, lane) {
    if (e.button !== 0) return;
    e.stopPropagation();
    stop();
    root.focus();
    // Measured before picking: picking redraws the timeline and this lane is no longer in the page.
    const zone = lane.getBoundingClientRect();
    const props = keysIn(clip, id, channel.props, t0).map(([p]) => p);
    chosen = { id, props, t: t0, channel: channel.name };
    // The bar changes (curve and delete of the picked keyframe): it is redrawn right away, not only the playhead.
    draw();
    setState({ time: t0 });
    const duration = read(schema, clip, 'duration');
    const x0 = e.clientX;
    let created = t0;
    // moveKey fails if the target already has another keyframe of the track (dropping it on top would delete it).
    const ops = (t) => {
      let tracks = clip.tracks;
      for (const p of props) tracks = moveKey(tracks, id, p, t0, t);
      return [{ op: 'set', target: clip.id, props: { tracks } }];
    };
    // Picking the keyframe redraws the timeline (the diamond is replaced): the drag is followed on window.
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) < 3 && created === t0) return;
      created = Math.max(0, Math.min(duration, adjustToFrame(t0 + ((ev.clientX - x0) / zone.width) * duration)));
      try {
        preview(ops(created));
      } catch {
        preview(null);
      }
      setState({ time: created });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      if (sameTime(created, t0)) return preview(null);
      let batch;
      try {
        batch = ops(created);
      } catch (error) {
        preview(null);
        return notify(error.message, true);
      }
      chosen = { id, props, t: roundTime(created), channel: channel.name };
      execute(batch, `${clip.id}: move key ${id} ${channel.name} ${n(t0)} → ${n(created)} s`);
    }, { once: true });
  }

  /**
   * A ◆ of «All keys» (id null) or of an object's row: click takes the playhead there; dragging moves the whole
   * moment (all the keyframes at that time, of the clip or of the object), like the AI's move_keys.
   */
  function dragMoment(e, clip, idOnly, t0, lane) {
    if (e.button !== 0) return;
    e.stopPropagation();
    stop();
    root.focus();
    const zone = lane.getBoundingClientRect();
    const duration = read(schema, clip, 'duration');
    const x0 = e.clientX;
    let created = t0;
    setState({ time: t0 });
    const ops = (t) => {
      let tracks = clip.tracks;
      for (const [id, fields] of Object.entries(clip.tracks ?? {})) {
        if (idOnly && id !== idOnly) continue;
        for (const p of Object.keys(fields)) tracks = moveKey(tracks, id, p, t0, t) ?? tracks;
      }
      return [{ op: 'set', target: clip.id, props: { tracks } }];
    };
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) < 3 && created === t0) return;
      created = Math.max(0, Math.min(duration, adjustToFrame(t0 + ((ev.clientX - x0) / zone.width) * duration)));
      try {
        preview(ops(created));
      } catch {
        preview(null);
      }
      setState({ time: created });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      if (sameTime(created, t0)) return preview(null);
      let batch;
      try {
        batch = ops(created);
      } catch (error) {
        preview(null);
        return notify(error.message, true);
      }
      chosen = null;
      execute(batch, `${clip.id}: move ${idOnly ? `${idOnly} keys` : 'keys'} ${n(t0)} → ${n(created)} s`);
    }, { once: true });
  }

  function movePlayhead() {
    const clip = clipVisible();
    if (!clip) return;
    const duration = read(schema, clip, 'duration');
    const playhead = root.querySelector('.playhead');
    const lane = root.querySelector('.lane');
    if (playhead && lane) {
      const base = lane.offsetLeft;
      playhead.style.left = `${base + (Math.min(state.time, duration) / duration) * lane.offsetWidth}px`;
    }
    const clock = root.querySelector('.clock');
    if (clock) clock.textContent = `${state.time.toFixed(2)} s · frame ${Math.round(state.time * fps())}`;
  }
  new ResizeObserver(movePlayhead).observe(root);
}

// Channels as in Moho: position (x, y) and scale (scaleX, scaleY) go together in one row; a param, its value.
/** @type {[string, string[]][]} */
const JOINED = [['Position', ['x', 'y']], ['Rotation', ['rotation']], ['Scale', ['scaleX', 'scaleY']]];
// Channels shown even without keys; the others appear in the timeline once they have a key.
const BASIC_CHANNELS = new Set(['Position', 'Rotation', 'Scale', 'Points', 'Switch', 'Value']);
const CHANNEL_LABELS = { opacity: 'Opacity', visible: 'Visible', fill: 'Fill', stroke: 'Stroke', strokeWidth: 'Stroke width', vertices: 'Points', active: 'Switch', width: 'Width', height: 'Height', length: 'Length', cornerRadius: 'Corner radius' };

function channelsOf(obj) {
  if (obj.type === 'param') return [{ name: 'Value', props: ['value'] }];
  const kind = schema.types.get(obj.type);
  if (!kind || kind.resource) return [];
  const animatable = Object.keys(kind.properties).filter((k) => kind.properties[k].animatable);
  const channels = [];
  const used = new Set();
  for (const [name, props] of JOINED) {
    const any = props.filter((k) => animatable.includes(k));
    if (!any.length) continue;
    channels.push({ name, props: any });
    any.forEach((k) => used.add(k));
  }
  for (const k of animatable) if (!used.has(k)) channels.push({ name: CHANNEL_LABELS[k] ?? k, props: [k] });
  return channels;
}

/** Times with a keyframe in any of the properties of a channel. */
function channelTimes(clip, id, props) {
  const times = [];
  for (const p of props) for (const c of clip.tracks?.[id]?.[p] ?? []) if (!times.some((t) => sameTime(t, c.t))) times.push(c.t);
  return times.sort((a, b) => a - b);
}

/** The keyframes [property, keyframe] of a channel at time t. */
function keysIn(clip, id, props, t) {
  return (props ?? []).flatMap((p) => {
    const c = clip?.tracks?.[id]?.[p]?.find((k) => sameTime(k.t, t));
    return c ? [[p, c]] : [];
  });
}

/** The color of the ◆ tells the curve of the span leaving it (like the keyframe shape in Moho). */
function curveClass(keys) {
  const curves = new Set(keys.map(([, c]) => (Array.isArray(c.ease) ? 'bezier' : (c.ease ?? 'linear'))));
  if (curves.size > 1) return 'curve-mixed';
  const [curve] = curves;
  return `curve${curve.startsWith('ease-') ? 'ease' : curve}`;
}

/** A small drawing of a span's curve (time → progress), to see the shape without guessing the numbers. */
function curveShape(ease) {
  const [width, height, margin] = [36, 20, 4];
  const y = (v) => margin + (1 - v) * (height - 2 * margin);
  const points = Array.from({ length: 25 }, (_, i) => {
    const f = i / 24;
    return `${(f * width).toFixed(1)},${y(ease === 'step' ? (f < 1 ? 0 : 1) : applyCurve(ease, f)).toFixed(1)}`;
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'curve-shape');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<line x1="0" y1="${y(0)}" x2="${width}" y2="${y(0)}"/><line x1="0" y1="${y(1)}" x2="${width}" y2="${y(1)}"/><polyline points="${points.join(' ')}"/>`;
  return svg;
}
function curveName(keys) {
  const names = [...new Set(keys.map(([, c]) => (Array.isArray(c.ease) ? `cubic-bezier(${c.ease.join(', ')})` : (c.ease ?? 'linear'))))];
  return names.join(' / ');
}

function summarize(v) {
  if (Array.isArray(v)) return `(${v.length} points)`;
  return typeof v === 'number' ? n(v) : JSON.stringify(v);
}
